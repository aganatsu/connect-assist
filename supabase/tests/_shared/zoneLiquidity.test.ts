/**
 * Unit tests for zoneLiquidity.ts
 *
 * Tests cover:
 *   1. findZoneLiquidity — pool detection near zone edges
 *   2. findZoneLiquidity — sweep detection and scoring
 *   3. findZoneLiquidity — direction-based relevance classification
 *   4. findZoneLiquidity — inducement fallback when no sweep
 *   5. findZoneLiquidity — score calculation
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { Candle, LiquidityPool } from "../../functions/_shared/smcAnalysis.ts";
import { findZoneLiquidity, type ZoneLiquidityResult } from "../../functions/_shared/zoneLiquidity.ts";

// ─── Helpers ──────────────────────────────────────────────────────────

function makeCandle(o: number, h: number, l: number, c: number, idx: number): Candle {
  return {
    datetime: `2026-01-${String(idx + 1).padStart(2, "0")}T00:00:00Z`,
    open: o,
    high: h,
    low: l,
    close: c,
  };
}

/** Seeded PRNG (mulberry32) for deterministic candle generation */
function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate 50 candles ranging from 1.1000 to 1.1500 with ~50 pip ATR (deterministic) */
function generateBaseCandles(count = 50): Candle[] {
  const rand = seededRandom(42); // Fixed seed for reproducibility
  const candles: Candle[] = [];
  let price = 1.1000;
  for (let i = 0; i < count; i++) {
    const move = (rand() - 0.5) * 0.0050;
    const open = price;
    const close = price + move;
    const high = Math.max(open, close) + rand() * 0.0020;
    const low = Math.min(open, close) - rand() * 0.0020;
    candles.push(makeCandle(open, high, low, close, i));
    price = close;
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
  sweepDepth?: number,
): LiquidityPool {
  return {
    price,
    type,
    strength,
    datetime: "2026-01-01T00:00:00Z",
    swept,
    sweptAtIndex,
    rejectionConfirmed,
    state: swept ? (rejectionConfirmed ? "swept_rejected" : "swept_absorbed") : "active",
    sweepDepth,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

Deno.test("findZoneLiquidity — returns empty result when no pools provided", () => {
  const candles = generateBaseCandles(50);
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", []);
  assertEquals(result.nearbyPools.length, 0);
  assertEquals(result.swept, false);
  assertEquals(result.sweepEvent, null);
  assertEquals(result.inducement, null);
  assertEquals(result.liquidityScore, 0);
  assert(result.summary.includes("No significant liquidity"));
});

Deno.test("findZoneLiquidity — identifies BSL above zone for bearish direction", () => {
  const candles = generateBaseCandles(50);
  // Zone: 1.1150 - 1.1200
  // BSL above zone at 1.1220 (within ATR distance)
  const pools: LiquidityPool[] = [
    makePool(1.1220, "buy-side", 3),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  assertEquals(result.nearbyPools.length, 1);
  assertEquals(result.nearbyPools[0].relevance, "entry_trigger");
  assertEquals(result.nearbyPools[0].nearEdge, "above_high");
  assert(result.liquidityScore >= 1.0, `Expected score >= 1.0, got ${result.liquidityScore}`);
});

Deno.test("findZoneLiquidity — identifies SSL below zone for bullish direction", () => {
  const candles = generateBaseCandles(50);
  // Zone: 1.1150 - 1.1200
  // SSL below zone at 1.1130 (within ATR distance)
  const pools: LiquidityPool[] = [
    makePool(1.1130, "sell-side", 2),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bullish", pools);
  assertEquals(result.nearbyPools.length, 1);
  assertEquals(result.nearbyPools[0].relevance, "entry_trigger");
  assertEquals(result.nearbyPools[0].nearEdge, "below_low");
  assert(result.liquidityScore >= 1.0);
});

Deno.test("findZoneLiquidity — filters out pools too far from zone", () => {
  const candles = generateBaseCandles(50);
  // Zone: 1.1150 - 1.1200
  // Pool at 1.1500 (way too far)
  const pools: LiquidityPool[] = [
    makePool(1.1500, "buy-side", 3),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  assertEquals(result.nearbyPools.length, 0);
  assertEquals(result.liquidityScore, 0);
});

Deno.test("findZoneLiquidity — detects swept pool with rejection (score +3.0)", () => {
  const candles = generateBaseCandles(50);
  // Zone: 1.1150 - 1.1200
  // BSL above zone at 1.1220, swept 5 candles ago with rejection
  const pools: LiquidityPool[] = [
    makePool(1.1220, "buy-side", 3, true, 45, true, 0.0015),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  assertEquals(result.swept, true);
  assert(result.sweepEvent !== null);
  assertEquals(result.sweepEvent!.rejected, true);
  assertEquals(result.sweepEvent!.candlesSinceSweep, 4);
  // Score: 1.0 (pool identified) + 2.0 (swept + rejected) = 3.0
  assertEquals(result.liquidityScore, 3.0);
});

Deno.test("findZoneLiquidity — detects swept pool without rejection (score +2.5)", () => {
  const candles = generateBaseCandles(50);
  // BSL above zone at 1.1220, swept 3 candles ago, no rejection
  const pools: LiquidityPool[] = [
    makePool(1.1220, "buy-side", 3, true, 47, false, 0.0010),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  assertEquals(result.swept, true);
  assert(result.sweepEvent !== null);
  assertEquals(result.sweepEvent!.rejected, false);
  // Score: 1.0 (pool identified) + 1.5 (swept, no rejection) - 2.0 (absorbed penalty) = 0.5
  // NOTE: swept_absorbed penalty added by Liquidity Sweep Gate feature
  assertEquals(result.liquidityScore, 0.5);
});

Deno.test("findZoneLiquidity — old sweep beyond maxAge is ignored", () => {
  const candles = generateBaseCandles(50);
  // BSL above zone, swept 30 candles ago (beyond default maxAge of 15)
  const pools: LiquidityPool[] = [
    makePool(1.1220, "buy-side", 3, true, 20, true, 0.0015),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  assertEquals(result.swept, false);
  assertEquals(result.sweepEvent, null);
  // Still gets +1.0 for pool identified
  assertEquals(result.liquidityScore, 1.0);
});

Deno.test("findZoneLiquidity — BSL below zone for bearish = target (not trigger)", () => {
  const candles = generateBaseCandles(50);
  // SSL below zone for bearish direction = target
  const pools: LiquidityPool[] = [
    makePool(1.1130, "sell-side", 2),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  assertEquals(result.nearbyPools.length, 1);
  assertEquals(result.nearbyPools[0].relevance, "target");
  // Target pools don't contribute to entry_trigger scoring
  assertEquals(result.liquidityScore, 0);
});

Deno.test("findZoneLiquidity — pool inside zone is detected", () => {
  const candles = generateBaseCandles(50);
  // Pool inside zone bounds
  const pools: LiquidityPool[] = [
    makePool(1.1175, "buy-side", 2),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  assertEquals(result.nearbyPools.length, 1);
  assertEquals(result.nearbyPools[0].nearEdge, "inside");
  assertEquals(result.nearbyPools[0].distanceToZone, 0);
  assertEquals(result.nearbyPools[0].relevance, "entry_trigger");
  assertEquals(result.nearbyPools[0].gateEligible, true);
  assertEquals(result.entryTriggerState, "unswept");
  assert(result.gateReason.includes("inside zone"));
});

Deno.test("findZoneLiquidity — broad ATR-near pool stays contextual when it is not zone-local", () => {
  const candles = generateBaseCandles(50);
  // This BSL is within the old 1.5 ATR nearby envelope, but outside the
  // tighter max(half-zone-width, 0.25 ATR) entry-trigger envelope.
  const pools: LiquidityPool[] = [
    makePool(1.1240, "buy-side", 3),
  ];
  const result = findZoneLiquidity(
    candles,
    1.1200,
    1.1150,
    "bearish",
    pools,
  );

  assertEquals(result.nearbyPools.length, 1);
  assertEquals(result.nearbyPools[0].relevance, "neutral");
  assertEquals(result.nearbyPools[0].gateEligible, false);
  assertEquals(result.entryTriggerState, "none");
  assertEquals(result.hasUnsweptEntryTrigger, false);
  assertEquals(result.entryTrigger, null);
  assert(result.gateReason.includes("none local enough to gate entry"));
});

Deno.test("findZoneLiquidity — weak pool (strength < min) is filtered out", () => {
  const candles = generateBaseCandles(50);
  // Pool with only 1 touch (below default minPoolStrength of 2)
  const pools: LiquidityPool[] = [
    makePool(1.1220, "buy-side", 1),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  assertEquals(result.nearbyPools.length, 0);
});

Deno.test("findZoneLiquidity — multiple pools sorted by relevance then distance", () => {
  const candles = generateBaseCandles(50);
  const pools: LiquidityPool[] = [
    makePool(1.1230, "buy-side", 3),  // entry_trigger, farther
    makePool(1.1210, "buy-side", 2),  // entry_trigger, closer
    makePool(1.1130, "sell-side", 2), // target
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  // Entry triggers should come first, sorted by distance
  assert(result.nearbyPools.length >= 2);
  assertEquals(result.nearbyPools[0].relevance, "entry_trigger");
  assert(result.nearbyPools[0].distanceToZone <= result.nearbyPools[1].distanceToZone);
});
