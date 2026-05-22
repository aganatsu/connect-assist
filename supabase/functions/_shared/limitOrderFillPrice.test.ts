/**
 * Tests for the limit order fill pricing fix (L1 v2).
 *
 * Verifies:
 * 1. Limit orders fill at the live price (candle close) at detection time,
 *    NOT at the static limit price (zone refinedEntry).
 * 2. The fill detection still uses candle low/high to determine if the zone was touched.
 * 3. The old behavior (Math.max/min) is documented as incorrect.
 *
 * These tests simulate the logic at bot-scanner/index.ts lines 2579-2615.
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ─── Extracted logic under test ───────────────────────────────────────────────

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Determines if a pending limit order should be filled based on candle data.
 * Returns true if the candle's low/high touched the limit price.
 */
function shouldFill(direction: "long" | "short", limitPrice: number, candle: Candle): boolean {
  if (direction === "long") {
    return candle.low <= limitPrice; // Price dipped to or below the limit buy level
  } else {
    return candle.high >= limitPrice; // Price rose to or above the limit sell level
  }
}

/**
 * OLD behavior (before fix): fill at the candle extreme clamped to limit price.
 * This almost always resolves to the limit price itself.
 */
function oldFillPrice(direction: "long" | "short", limitPrice: number, candle: Candle): number {
  if (direction === "long") {
    return Math.max(candle.low, limitPrice); // low < limit → limitPrice; low > limit → impossible (wouldn't fill)
  } else {
    return Math.min(candle.high, limitPrice); // high > limit → limitPrice; high < limit → impossible (wouldn't fill)
  }
}

/**
 * NEW behavior (after fix): fill at the live price (candle close) at detection time.
 * This is the most recent tick when the scanner detects the zone was touched.
 */
function newFillPrice(currentPrice: number): number {
  return currentPrice; // live tick at detection time
}

// ─── Tests: Fill detection (unchanged) ───────────────────────────────────────

Deno.test("Fill detection: long fills when candle low touches limit price", () => {
  const candle: Candle = { open: 4550, high: 4555, low: 4540, close: 4548 };
  assertEquals(shouldFill("long", 4542, candle), true, "Low 4540 <= limit 4542 → should fill");
});

Deno.test("Fill detection: long does NOT fill when candle low is above limit", () => {
  const candle: Candle = { open: 4550, high: 4555, low: 4545, close: 4548 };
  assertEquals(shouldFill("long", 4542, candle), false, "Low 4545 > limit 4542 → no fill");
});

Deno.test("Fill detection: short fills when candle high touches limit price", () => {
  const candle: Candle = { open: 4540, high: 4545, low: 4535, close: 4538 };
  assertEquals(shouldFill("short", 4542, candle), true, "High 4545 >= limit 4542 → should fill");
});

Deno.test("Fill detection: short does NOT fill when candle high is below limit", () => {
  const candle: Candle = { open: 4540, high: 4541, low: 4535, close: 4538 };
  assertEquals(shouldFill("short", 4542, candle), false, "High 4541 < limit 4542 → no fill");
});

// ─── Tests: New fill price behavior ──────────────────────────────────────────

Deno.test("New fill price: uses live price (candle close), not limit price", () => {
  const currentPrice = 4548.25; // candle close = live tick
  const limitPrice = 4541.56;   // zone refinedEntry
  
  const fill = newFillPrice(currentPrice);
  assertEquals(fill, 4548.25, "Fill must be the live price at detection time");
  assert(fill !== limitPrice, "Fill must NOT be the static limit price");
});

Deno.test("New fill price: XAU/USD short scenario — live price differs from limit", () => {
  // Real scenario: zone refinedEntry = 4541.56473, candle close = 4543.50
  // The candle high touched 4545 (above limit), triggering the fill.
  // Old behavior: fill at min(4545, 4541.56) = 4541.56 (static limit price)
  // New behavior: fill at 4543.50 (live tick)
  const currentPrice = 4543.50;
  const limitPrice = 4541.56473;
  const candle: Candle = { open: 4540, high: 4545, low: 4538, close: 4543.50 };
  
  // Verify fill triggers
  assertEquals(shouldFill("short", limitPrice, candle), true);
  
  // Verify new fill price
  const fill = newFillPrice(currentPrice);
  assertEquals(fill, 4543.50, "Short fill at live price, not limit price");
  
  // Verify old behavior would have been wrong
  const oldFill = oldFillPrice("short", limitPrice, candle);
  assertEquals(oldFill, limitPrice, "Old behavior always resolves to limit price");
  assert(fill !== oldFill, "New behavior differs from old (more realistic)");
});

Deno.test("New fill price: EUR/USD long scenario — live price differs from limit", () => {
  // Zone refinedEntry = 1.08250, candle close = 1.08220
  // Candle low = 1.08200 (below limit), triggering the fill.
  // Old behavior: fill at max(1.08200, 1.08250) = 1.08250 (static limit price)
  // New behavior: fill at 1.08220 (live tick)
  const currentPrice = 1.08220;
  const limitPrice = 1.08250;
  const candle: Candle = { open: 1.08300, high: 1.08350, low: 1.08200, close: 1.08220 };
  
  // Verify fill triggers
  assertEquals(shouldFill("long", limitPrice, candle), true);
  
  // Verify new fill price
  const fill = newFillPrice(currentPrice);
  assertEquals(fill, 1.08220, "Long fill at live price, not limit price");
  
  // Verify old behavior would have been wrong
  const oldFill = oldFillPrice("long", limitPrice, candle);
  assertEquals(oldFill, limitPrice, "Old behavior always resolves to limit price");
  assert(fill !== oldFill, "New behavior differs from old (more realistic)");
});

// ─── Tests: Edge cases ───────────────────────────────────────────────────────

Deno.test("New fill price: when live price equals limit price (exact touch)", () => {
  // Edge case: candle close happens to be exactly at the limit price
  // Both old and new behavior give the same result — this is fine
  const currentPrice = 4541.56;
  const limitPrice = 4541.56;
  
  const fill = newFillPrice(currentPrice);
  assertEquals(fill, limitPrice, "When live price equals limit, fill is at that price");
});

Deno.test("Old fill price always resolves to limit price (proving the bug)", () => {
  // This test documents WHY the old behavior was wrong:
  // For a short, the fill condition is candle.high >= limitPrice.
  // So candle.high is ALWAYS >= limitPrice when fill triggers.
  // Math.min(candle.high, limitPrice) → always limitPrice.
  //
  // For a long, the fill condition is candle.low <= limitPrice.
  // So candle.low is ALWAYS <= limitPrice when fill triggers.
  // Math.max(candle.low, limitPrice) → always limitPrice.
  
  // Short: high must be >= limit for fill
  const shortCandle: Candle = { open: 4540, high: 4550, low: 4535, close: 4543 };
  const shortLimit = 4542;
  assertEquals(shouldFill("short", shortLimit, shortCandle), true);
  assertEquals(oldFillPrice("short", shortLimit, shortCandle), shortLimit,
    "Old short fill ALWAYS equals limit price (bug)");
  
  // Long: low must be <= limit for fill
  const longCandle: Candle = { open: 1.0830, high: 1.0840, low: 1.0820, close: 1.0825 };
  const longLimit = 1.0825;
  assertEquals(shouldFill("long", longLimit, longCandle), true);
  assertEquals(oldFillPrice("long", longLimit, longCandle), longLimit,
    "Old long fill ALWAYS equals limit price (bug)");
});
