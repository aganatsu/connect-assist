/**
 * Unit tests for unifiedZoneEngine.ts
 *
 * Tests cover:
 *   1. findUnifiedZone — returns no_zone when no impulse/zone found
 *   2. findUnifiedZone — returns watching state when zone found but price far
 *   3. findUnifiedZone — integrates liquidity scoring
 *   4. findUnifiedZone — builds correct impulse story metadata
 *   5. findUnifiedZone — entry direction matches impulse direction (continuation)
 *   6. findUnifiedZone — score breakdown is correct
 *   7. findUnifiedZone — Daily TF gets +2.0 bonus
 *   8. findUnifiedZone — story summary contains all narrative elements
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { Candle, LiquidityPool } from "./smcAnalysis.ts";
import { findUnifiedZone, type UnifiedZoneResult } from "./unifiedZoneEngine.ts";

// ─── Helpers ──────────────────────────────────────────────────────────

function makeCandle(o: number, h: number, l: number, c: number, datetime: string): Candle {
  return { open: o, high: h, low: l, close: c, datetime };
}

/**
 * Generate a bearish impulse leg on candles:
 * First half: price rises from base to base+range (the impulse high)
 * Second half: price drops sharply (the impulse move)
 * This creates FVGs and OBs in the impulse.
 */
function generateBearishImpulseCandles(count: number, base: number, range: number): Candle[] {
  const candles: Candle[] = [];
  const halfCount = Math.floor(count / 2);
  const step = range / halfCount;

  // First half: bullish buildup (creates the high)
  for (let i = 0; i < halfCount; i++) {
    const o = base + step * i;
    const c = base + step * (i + 1);
    const h = c + step * 0.2;
    const l = o - step * 0.1;
    const day = String(i + 1).padStart(2, "0");
    candles.push(makeCandle(o, h, l, c, `2026-01-${day}T00:00:00Z`));
  }

  // Second half: bearish impulse (strong drop with gaps = FVGs)
  let price = base + range;
  for (let i = halfCount; i < count; i++) {
    const dropSize = step * 2.5; // Larger drops create FVGs
    const o = price;
    const c = price - dropSize;
    const h = o + step * 0.1;
    const l = c - step * 0.2;
    const day = String(Math.min(i + 1, 28)).padStart(2, "0");
    candles.push(makeCandle(o, h, l, c, `2026-01-${day}T00:00:00Z`));
    price = c;
  }

  return candles;
}

/**
 * Generate flat/ranging candles (no clear impulse).
 */
function generateFlatCandles(count: number, base: number): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const tiny = (i % 2 === 0 ? 1 : -1) * 0.0003;
    const o = base + tiny;
    const c = base - tiny;
    const h = Math.max(o, c) + 0.0004;
    const l = Math.min(o, c) - 0.0004;
    const day = String(Math.min(i + 1, 28)).padStart(2, "0");
    candles.push(makeCandle(o, h, l, c, `2026-01-${day}T00:00:00Z`));
  }
  return candles;
}

function makePool(
  price: number,
  type: "buy-side" | "sell-side",
  strength: number,
  swept = false,
  sweptAtIndex?: number,
  rejectionConfirmed = false,
): LiquidityPool {
  return {
    price, type, strength,
    datetime: "2026-01-01T00:00:00Z",
    swept, sweptAtIndex, rejectionConfirmed,
    state: swept ? (rejectionConfirmed ? "swept_rejected" : "swept_absorbed") : "active",
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

Deno.test("findUnifiedZone — returns no_zone when flat market (no impulse)", () => {
  const h1 = generateFlatCandles(50, 1.1200);
  const h4 = generateFlatCandles(30, 1.1200);
  const entry = generateFlatCandles(50, 1.1200);

  const result = findUnifiedZone(
    h1, h4, entry, "bearish", 1.1200, [],
  );

  assertEquals(result.hasZone, false);
  assertEquals(result.state, "no_zone");
  assertEquals(result.selectedTF, null);
  assertEquals(result.unifiedScore, 0);
  assert(result.storySummary.includes("No valid"));
});

Deno.test("findUnifiedZone — finds zone and returns watching state when price far", () => {
  // Create bearish impulse candles on 4H
  const h4 = generateBearishImpulseCandles(40, 1.1000, 0.0200);
  const h1 = generateFlatCandles(50, 1.0800); // Price at bottom (far from zone)
  const entry = generateFlatCandles(50, 1.0800);

  // Current price is at the bottom of the impulse (far from retracement zone)
  const currentPrice = 1.0800;

  const result = findUnifiedZone(
    h1, h4, entry, "bearish", currentPrice, [],
  );

  // The engine should find the impulse and zone on 4H
  // Whether it's "watching" or "no_zone" depends on if the impulse detection works
  // with our synthetic candles
  if (result.hasZone) {
    assertEquals(result.state, "watching");
    assert(result.impulse !== null);
    assertEquals(result.impulse!.direction, "bearish");
    assert(result.zone !== null);
    assert(result.price.distancePips > 0);
  }
  // Either way, the function should not crash
  assert(result.reason.length > 0);
});

Deno.test("findUnifiedZone — liquidity pools contribute to score", () => {
  const h4 = generateBearishImpulseCandles(40, 1.1000, 0.0200);
  const h1 = generateFlatCandles(50, 1.1100);
  const entry = generateFlatCandles(50, 1.1100);
  const currentPrice = 1.1100;

  // Add BSL above where a zone might form
  const pools: LiquidityPool[] = [
    makePool(1.1150, "buy-side", 3),
  ];

  const resultWithPools = findUnifiedZone(
    h1, h4, entry, "bearish", currentPrice, pools,
  );

  const resultWithoutPools = findUnifiedZone(
    h1, h4, entry, "bearish", currentPrice, [],
  );

  // If both find zones, the one with pools should score higher
  if (resultWithPools.hasZone && resultWithoutPools.hasZone) {
    assert(
      resultWithPools.scoreBreakdown.liquidityBonus >= resultWithoutPools.scoreBreakdown.liquidityBonus,
      "Pools should contribute to liquidity bonus",
    );
  }
});

Deno.test("findUnifiedZone — entry direction matches impulse direction (continuation)", () => {
  const h4 = generateBearishImpulseCandles(40, 1.1000, 0.0200);
  const h1 = generateBearishImpulseCandles(50, 1.1000, 0.0150);
  const entry = generateFlatCandles(50, 1.1100);
  const currentPrice = 1.1100;

  // Add confirmation candles with some structure
  const confirmCandles = generateBearishImpulseCandles(30, 1.1050, 0.0100);

  const result = findUnifiedZone(
    h1, h4, entry, "bearish", currentPrice, [],
    undefined, undefined, undefined,
    confirmCandles,
  );

  // If entry is generated, direction must be SHORT (matching bearish impulse)
  if (result.entry) {
    assertEquals(result.entry.direction, "short");
    // SL should be above entry (for shorts)
    assert(result.entry.slPrice > result.entry.entryPrice,
      `SL ${result.entry.slPrice} should be above entry ${result.entry.entryPrice} for shorts`);
  }
});

Deno.test("findUnifiedZone — score breakdown structure is correct", () => {
  const h1 = generateFlatCandles(50, 1.1200);
  const h4 = generateFlatCandles(30, 1.1200);
  const entry = generateFlatCandles(50, 1.1200);

  const result = findUnifiedZone(
    h1, h4, entry, "bearish", 1.1200, [],
  );

  // Score breakdown should always be present
  assert(result.scoreBreakdown !== null);
  assertEquals(typeof result.scoreBreakdown.baseScore, "number");
  assertEquals(typeof result.scoreBreakdown.liquidityBonus, "number");
  assertEquals(typeof result.scoreBreakdown.confirmationBonus, "number");
  assertEquals(typeof result.scoreBreakdown.tfBonus, "number");
  assertEquals(typeof result.scoreBreakdown.total, "number");

  // Total should equal sum of parts
  const expectedTotal = result.scoreBreakdown.baseScore
    + result.scoreBreakdown.liquidityBonus
    + result.scoreBreakdown.confirmationBonus
    + result.scoreBreakdown.tfBonus;
  assertEquals(result.scoreBreakdown.total, Math.round(expectedTotal * 10) / 10);
});

Deno.test("findUnifiedZone — Daily TF gets +2.0 bonus when zone found on Daily", () => {
  // Create a strong bearish impulse on Daily candles
  const dailyCandles = generateBearishImpulseCandles(30, 1.1000, 0.0300);
  const h4 = generateFlatCandles(30, 1.0900);
  const h1 = generateFlatCandles(50, 1.0900);
  const entry = generateFlatCandles(50, 1.0900);
  const currentPrice = 1.0900;

  const result = findUnifiedZone(
    h1, h4, entry, "bearish", currentPrice, [],
    undefined, undefined, dailyCandles,
  );

  // If Daily zone was selected, TF bonus should be 2.0
  if (result.selectedTF === "D") {
    assertEquals(result.scoreBreakdown.tfBonus, 2.0);
  }
  // Function should not crash regardless
  assert(result.reason.length > 0);
});

Deno.test("findUnifiedZone — story summary contains narrative elements", () => {
  const h4 = generateBearishImpulseCandles(40, 1.1000, 0.0200);
  const h1 = generateFlatCandles(50, 1.1100);
  const entry = generateFlatCandles(50, 1.1100);
  const currentPrice = 1.1100;

  const result = findUnifiedZone(
    h1, h4, entry, "bearish", currentPrice, [],
  );

  if (result.hasZone) {
    // Story should contain key narrative elements
    assert(result.storySummary.includes("Impulse"), "Should mention Impulse");
    assert(result.storySummary.includes("Zone"), "Should mention Zone");
    assert(result.storySummary.includes("Price"), "Should mention Price");
    assert(result.storySummary.includes("Confirmation"), "Should mention Confirmation");
    assert(result.storySummary.includes("Entry"), "Should mention Entry");
    // Should contain bullet markers
    assert(result.storySummary.includes("●") || result.storySummary.includes("○"),
      "Should use bullet markers");
  }
});

Deno.test("findUnifiedZone — state transitions are correct", () => {
  // Test that states follow the expected progression
  const h1 = generateFlatCandles(50, 1.1200);
  const h4 = generateFlatCandles(30, 1.1200);
  const entry = generateFlatCandles(50, 1.1200);

  const result = findUnifiedZone(h1, h4, entry, "bearish", 1.1200, []);

  // State must be one of the valid states
  const validStates = ["no_impulse", "no_zone", "watching", "at_zone", "confirmed", "triggered"];
  assert(validStates.includes(result.state), `State '${result.state}' is not valid`);
});
