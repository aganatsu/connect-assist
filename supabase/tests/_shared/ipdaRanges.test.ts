/**
 * IPDA Ranges — Phase 8 Tests
 *
 * Tests the IPDA 20/40/60-day range calculation and key level conversion.
 *
 * Verifies:
 * 1. Correct high/low/midpoint calculation for each range period
 * 2. Institutional bias determination based on price vs 60-day midpoint
 * 3. Position percent calculation
 * 4. Graceful handling of insufficient data
 * 5. Key level conversion with distance filtering
 * 6. Current day exclusion (incomplete candle)
 */

import { assertEquals, assertNotEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { calculateIPDARanges, ipdaRangesToKeyLevels } from "./ipdaRanges.ts";
import type { Candle } from "./smcAnalysis.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCandle(open: number, high: number, low: number, close: number, dayOffset: number = 0): Candle {
  const ts = Date.now() - dayOffset * 86400000;
  return {
    datetime: new Date(ts).toISOString(),
    open,
    high,
    low,
    close,
    volume: 1000,
  };
}

/** Generate N daily candles with controlled high/low range */
function generateDailyCandles(
  count: number,
  basePrice: number,
  range: number, // half-range: price oscillates between basePrice-range and basePrice+range
  opts?: {
    /** Override specific candle highs/lows by index */
    overrides?: Record<number, { high?: number; low?: number }>;
  },
): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    // Oscillate price within range
    const phase = Math.sin((i / count) * Math.PI * 2);
    const mid = basePrice + phase * range * 0.5;
    let high = mid + range * 0.1;
    let low = mid - range * 0.1;

    // Apply overrides
    if (opts?.overrides?.[i]) {
      if (opts.overrides[i].high !== undefined) high = opts.overrides[i].high!;
      if (opts.overrides[i].low !== undefined) low = opts.overrides[i].low!;
    }

    candles.push(makeCandle(mid - 0.001, high, low, mid + 0.001, count - i));
  }
  return candles;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

Deno.test("IPDA: calculates 20-day range correctly", () => {
  // Generate 25 candles (20 usable after excluding current day + some buffer)
  const candles: Candle[] = [];
  for (let i = 0; i < 25; i++) {
    // Candle i=10 has the highest high (1.1200)
    // Candle i=5 has the lowest low (1.0800)
    let high = 1.1000 + (i === 10 ? 0.0200 : 0);
    let low = 1.0900 - (i === 5 ? 0.0100 : 0);
    candles.push(makeCandle(1.0950, high, low, 1.0950, 25 - i));
  }

  const result = calculateIPDARanges(candles, 1.1000);

  assert(result.range20 !== null, "Should have 20-day range");
  assertEquals(result.range20!.period, 20);
  // The 20-day range uses the last 20 candles (excluding current day = last candle)
  // So it uses candles[4..23] (indices 4 through 23)
  assert(result.range20!.high >= 1.1000, "High should be at least 1.1000");
  assert(result.range20!.low <= 1.0900, "Low should be at most 1.0900");
  assert(result.range20!.midpoint > result.range20!.low, "Midpoint should be between low and high");
  assert(result.range20!.midpoint < result.range20!.high, "Midpoint should be between low and high");
});

Deno.test("IPDA: calculates all three ranges with 65 candles", () => {
  const candles = generateDailyCandles(65, 1.1000, 0.0200);
  const result = calculateIPDARanges(candles, 1.1000);

  assert(result.range20 !== null, "Should have 20-day range");
  assert(result.range40 !== null, "Should have 40-day range");
  assert(result.range60 !== null, "Should have 60-day range");

  assertEquals(result.range20!.period, 20);
  assertEquals(result.range40!.period, 40);
  assertEquals(result.range60!.period, 60);

  // 60-day range should be >= 40-day range >= 20-day range (wider lookback = wider range)
  assert(result.range60!.high >= result.range40!.high || result.range60!.low <= result.range40!.low,
    "60-day range should be at least as wide as 40-day");
});

Deno.test("IPDA: excludes current (last) candle", () => {
  // Create 25 candles where the LAST candle has an extreme high
  const candles = generateDailyCandles(25, 1.1000, 0.0100);
  // Override the last candle with an extreme high
  candles[candles.length - 1] = makeCandle(1.1000, 1.5000, 1.0900, 1.1000, 0);

  const result = calculateIPDARanges(candles, 1.1000);

  assert(result.range20 !== null, "Should have 20-day range");
  // The extreme high (1.5000) should NOT be in the range since it's the current day
  assert(result.range20!.high < 1.5000, "Should exclude current day's extreme high");
});

Deno.test("IPDA: returns null ranges with insufficient data", () => {
  const candles = generateDailyCandles(5, 1.1000, 0.0100);
  const result = calculateIPDARanges(candles, 1.1000);

  assertEquals(result.range20, null, "Should not have 20-day range with only 5 candles");
  assertEquals(result.range40, null, "Should not have 40-day range with only 5 candles");
  assertEquals(result.range60, null, "Should not have 60-day range with only 5 candles");
  assertEquals(result.positionPercent60, null, "No position percent without 60-day range");
  assertEquals(result.institutionalBias, "neutral", "Default to neutral without data");
});

Deno.test("IPDA: institutional bias is bullish when price above 60d midpoint", () => {
  // Create candles with range 1.0800 - 1.1200 (midpoint = 1.1000)
  const candles: Candle[] = [];
  for (let i = 0; i < 65; i++) {
    candles.push(makeCandle(1.1000, 1.1200, 1.0800, 1.1000, 65 - i));
  }

  // Price at 1.1150 — well above midpoint (1.1000)
  const result = calculateIPDARanges(candles, 1.1150);

  assertEquals(result.institutionalBias, "bullish", "Should be bullish above midpoint");
  assert(result.positionPercent60! > 55, "Position should be above 55%");
});

Deno.test("IPDA: institutional bias is bearish when price below 60d midpoint", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 65; i++) {
    candles.push(makeCandle(1.1000, 1.1200, 1.0800, 1.1000, 65 - i));
  }

  // Price at 1.0850 — well below midpoint (1.1000)
  const result = calculateIPDARanges(candles, 1.0850);

  assertEquals(result.institutionalBias, "bearish", "Should be bearish below midpoint");
  assert(result.positionPercent60! < 45, "Position should be below 45%");
});

Deno.test("IPDA: institutional bias is neutral near midpoint", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 65; i++) {
    candles.push(makeCandle(1.1000, 1.1200, 1.0800, 1.1000, 65 - i));
  }

  // Price at 1.1000 — exactly at midpoint
  const result = calculateIPDARanges(candles, 1.1000);

  assertEquals(result.institutionalBias, "neutral", "Should be neutral at midpoint");
});

Deno.test("IPDA: key level conversion produces correct types", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 65; i++) {
    candles.push(makeCandle(1.1000, 1.1200, 1.0800, 1.1000, 65 - i));
  }

  const ranges = calculateIPDARanges(candles, 1.1000);
  const keyLevels = ipdaRangesToKeyLevels(ranges, 1.1000, 0.0001);

  assert(keyLevels.length > 0, "Should produce key levels");

  // Check that all levels have the correct structure
  for (const level of keyLevels) {
    assert(level.price > 0, "Price should be positive");
    assert(level.label.startsWith("IPDA"), "Label should start with IPDA");
    assert(["support", "resistance", "pd_level"].includes(level.type), "Type should be valid");
    assert(["high", "medium", "low"].includes(level.significance), "Significance should be valid");
  }

  // 60d and 40d levels should be "high" significance
  const highSigLevels = keyLevels.filter(l => l.significance === "high");
  assert(highSigLevels.length > 0, "Should have high significance levels from 40d/60d");

  // Should have highs, lows, and EQ levels
  const hasHigh = keyLevels.some(l => l.label.includes("High"));
  const hasLow = keyLevels.some(l => l.label.includes("Low"));
  const hasEQ = keyLevels.some(l => l.label.includes("EQ"));
  assert(hasHigh, "Should have High levels");
  assert(hasLow, "Should have Low levels");
  assert(hasEQ, "Should have EQ (equilibrium) levels");
});

Deno.test("IPDA: key level conversion filters by distance", () => {
  // Create candles with a very tight range near 1.1000
  const candles: Candle[] = [];
  for (let i = 0; i < 65; i++) {
    candles.push(makeCandle(1.1000, 1.1010, 1.0990, 1.1000, 65 - i));
  }

  const ranges = calculateIPDARanges(candles, 1.1000);
  const keyLevels = ipdaRangesToKeyLevels(ranges, 1.1000, 0.0001);

  // All levels should be within 300 pips
  for (const level of keyLevels) {
    const distPips = Math.abs(level.price - 1.1000) / 0.0001;
    assert(distPips <= 300, `Level ${level.label} at ${level.price} is ${distPips} pips away — exceeds 300 pip limit`);
  }
});

Deno.test("IPDA: midpoint calculation is correct", () => {
  // Create candles with known high/low
  const candles: Candle[] = [];
  for (let i = 0; i < 25; i++) {
    // All candles have the same range: high=1.1200, low=1.0800
    candles.push(makeCandle(1.1000, 1.1200, 1.0800, 1.1000, 25 - i));
  }

  const result = calculateIPDARanges(candles, 1.1000);

  assert(result.range20 !== null, "Should have 20-day range");
  assertEquals(result.range20!.high, 1.1200, "High should be 1.1200");
  assertEquals(result.range20!.low, 1.0800, "Low should be 0.0800");
  assertEquals(result.range20!.midpoint, 1.1000, "Midpoint should be 1.1000");
});
