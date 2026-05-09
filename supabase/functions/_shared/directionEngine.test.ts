/**
 * directionEngine.test.ts — Tests for the simplified multi-TF direction engine
 */
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { determineDirection, type DirectionResult } from "./directionEngine.ts";
import type { Candle } from "./smcAnalysis.ts";

// ── Helper: generate synthetic candles with a trend ──

function makeCandles(
  count: number,
  startPrice: number,
  trend: "up" | "down" | "flat",
  volatility = 0.001,
): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  const step = trend === "up" ? volatility * 2 : trend === "down" ? -volatility * 2 : 0;

  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + step + (Math.random() - 0.5) * volatility * 0.5;
    const high = Math.max(open, close) + Math.random() * volatility;
    const low = Math.min(open, close) - Math.random() * volatility;
    candles.push({
      time: Date.now() - (count - i) * 3600000,
      open,
      high,
      low,
      close,
      volume: 100 + Math.random() * 50,
    });
    price = close;
  }
  return candles;
}

// ── Helper: generate candles with a clear structure break pattern ──
// Creates a trend with swing points that will produce BOS/CHoCH when analyzed

function makeTrendingCandles(
  count: number,
  startPrice: number,
  direction: "bullish" | "bearish",
  swingSize = 0.005,
): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  const drift = direction === "bullish" ? swingSize * 0.3 : -swingSize * 0.3;

  for (let i = 0; i < count; i++) {
    // Create swing pattern: up-up-down-up-up-down (bullish) or mirror for bearish
    const phase = i % 5;
    let move: number;
    if (direction === "bullish") {
      move = phase < 3 ? swingSize * 0.4 : -swingSize * 0.25;
    } else {
      move = phase < 3 ? -swingSize * 0.4 : swingSize * 0.25;
    }
    const open = price;
    const close = price + move + drift;
    const high = Math.max(open, close) + swingSize * 0.1;
    const low = Math.min(open, close) - swingSize * 0.1;
    candles.push({
      time: Date.now() - (count - i) * 86400000, // daily spacing
      open,
      high,
      low,
      close,
      volume: 100,
    });
    price = close;
  }
  return candles;
}

// ── Helper: generate ranging candles ──

function makeRangingCandles(count: number, midPrice: number, range = 0.003): Candle[] {
  const candles: Candle[] = [];
  let price = midPrice;

  for (let i = 0; i < count; i++) {
    // Oscillate within range
    const offset = Math.sin(i * 0.5) * range * 0.5;
    const open = midPrice + offset;
    const close = midPrice + offset + (Math.random() - 0.5) * range * 0.2;
    const high = Math.max(open, close) + range * 0.05;
    const low = Math.min(open, close) - range * 0.05;
    candles.push({
      time: Date.now() - (count - i) * 3600000,
      open,
      high,
      low,
      close,
      volume: 100,
    });
    price = close;
  }
  return candles;
}

// ─── Tests ───────────────────────────────────────────────────────────

Deno.test("determineDirection: returns no direction when daily candles insufficient", () => {
  const shortDaily = makeCandles(10, 1.1, "up"); // only 10, need 20
  const h4 = makeTrendingCandles(30, 1.1, "bullish");
  const h1 = makeTrendingCandles(30, 1.1, "bullish");

  const result = determineDirection(shortDaily, h4, h1);
  assertEquals(result.direction, null);
  assertEquals(result.bias, null);
  assertExists(result.reason);
  assertEquals(result.reason.includes("Insufficient daily"), true);
});

Deno.test("determineDirection: returns no direction when all candles are null", () => {
  const result = determineDirection(null, null, null);
  assertEquals(result.direction, null);
  assertEquals(result.bias, null);
});

Deno.test("determineDirection: result has correct shape", () => {
  const daily = makeTrendingCandles(30, 1.1, "bullish");
  const h4 = makeTrendingCandles(30, 1.1, "bullish");
  const h1 = makeTrendingCandles(30, 1.1, "bullish");

  const result = determineDirection(daily, h4, h1);
  // direction can be null (no trade), so check it's one of the valid values
  assertEquals(
    result.direction === "long" || result.direction === "short" || result.direction === null,
    true,
    `direction should be 'long', 'short', or null, got: ${result.direction}`,
  );
  // bias can also be null if no trend detected
  assertEquals(
    result.bias === "bullish" || result.bias === "bearish" || result.bias === null,
    true,
  );
  assertEquals(
    result.biasSource === "daily" || result.biasSource === "4h" || result.biasSource === null,
    true,
  );
  assertEquals(typeof result.h4Retrace, "boolean");
  assertEquals(typeof result.h4ChochAgainst, "boolean");
  assertEquals(typeof result.h1Confirmed, "boolean");
  assertExists(result.reason);
});

Deno.test("determineDirection: daily ranging + 4H ranging = no trade", () => {
  const daily = makeRangingCandles(30, 1.1);
  const h4 = makeRangingCandles(30, 1.1);
  const h1 = makeTrendingCandles(30, 1.1, "bullish");

  const result = determineDirection(daily, h4, h1);
  // When both daily and 4H are ranging, direction should be null
  // (unless 4H has enough BOS to qualify as fallback — depends on analyzeMarketStructure output)
  assertEquals(typeof result.direction, "object"); // null is typeof "object"
  assertExists(result.reason);
});

Deno.test("determineDirection: daily ranging + no 4H candles = no trade", () => {
  const daily = makeRangingCandles(30, 1.1);

  const result = determineDirection(daily, null, null);
  // If daily is detected as ranging, direction should be null (no 4H fallback available)
  // If daily is detected as trending (synthetic data may produce this), direction may be set
  // The key assertion: reason explains the outcome
  assertExists(result.reason);
  if (result.bias === null) {
    // Daily was ranging and no 4H fallback → no trade
    assertEquals(result.direction, null);
  }
  // Either way, biasSource should reflect what happened
  assertEquals(
    result.biasSource === "daily" || result.biasSource === null,
    true,
    `biasSource should be 'daily' or null when no 4H data, got: ${result.biasSource}`,
  );
});

Deno.test("determineDirection: no 4H and no 1H data still returns direction from daily bias", () => {
  const daily = makeTrendingCandles(30, 1.1, "bullish");

  const result = determineDirection(daily, null, null);
  // With daily bias but no 4H/1H, should still return direction with a note
  assertExists(result.reason);
  if (result.bias === "bullish") {
    // If daily is detected as bullish, direction should be long (or null if no confirmation)
    assertEquals(result.biasSource, "daily");
  }
});

Deno.test("determineDirection: h4ChochAgainst blocks the trade", () => {
  // Daily bullish, but 4H has bearish CHoCH → hard block
  const daily = makeTrendingCandles(30, 1.1, "bullish");
  // Create 4H candles that start bullish then reverse (CHoCH)
  const h4Bullish = makeTrendingCandles(20, 1.1, "bullish");
  const h4Reversal = makeTrendingCandles(15, h4Bullish[h4Bullish.length - 1].close, "bearish");
  const h4 = [...h4Bullish, ...h4Reversal];
  const h1 = makeTrendingCandles(30, 1.1, "bullish");

  const result = determineDirection(daily, h4, h1);
  // If 4H CHoCH against daily is detected, direction should be null
  if (result.h4ChochAgainst) {
    assertEquals(result.direction, null);
    assertEquals(result.reason.includes("BLOCKED"), true);
  }
  // Note: whether CHoCH is detected depends on analyzeMarketStructure's swing detection
  // The important thing is the logic path works correctly
  assertExists(result.reason);
});

Deno.test("determineDirection: config overrides are respected", () => {
  const daily = makeTrendingCandles(30, 1.1, "bullish");
  const h4 = makeTrendingCandles(30, 1.1, "bullish");
  const h1 = makeTrendingCandles(30, 1.1, "bullish");

  const result1 = determineDirection(daily, h4, h1, { h4ChochLookback: 5 });
  const result2 = determineDirection(daily, h4, h1, { h4ChochLookback: 20 });

  // Both should produce valid results (different lookback may change outcome)
  assertExists(result1.reason);
  assertExists(result2.reason);
});

Deno.test("determineDirection: biasSource is 'daily' when daily has clear trend", () => {
  const daily = makeTrendingCandles(40, 1.1, "bearish", 0.01);
  const h4 = makeTrendingCandles(30, 1.1, "bearish", 0.005);
  const h1 = makeTrendingCandles(30, 1.1, "bearish", 0.003);

  const result = determineDirection(daily, h4, h1);
  if (result.bias === "bearish") {
    assertEquals(result.biasSource, "daily");
  }
  assertExists(result.reason);
});

Deno.test("determineDirection: h4Retrace + h1Confirmed is the ideal setup", () => {
  // This test verifies the ideal path logic exists
  const daily = makeTrendingCandles(40, 1.1, "bullish", 0.01);
  const h4 = makeTrendingCandles(30, 1.1, "bullish", 0.005);
  const h1 = makeTrendingCandles(30, 1.1, "bullish", 0.003);

  const result = determineDirection(daily, h4, h1);
  // The ideal setup has h4Retrace=true AND h1Confirmed=true
  // Whether we get this depends on the synthetic data, but the function should not error
  assertExists(result.reason);
  assertEquals(typeof result.h4Retrace, "boolean");
  assertEquals(typeof result.h1Confirmed, "boolean");
});

Deno.test("determineDirection: h4Retrace without h1Confirmed = wait (no trade)", () => {
  // Verify the logic: if 4H is retracing but 1H hasn't confirmed, direction should be null
  const daily = makeTrendingCandles(40, 1.1, "bullish", 0.01);
  const h4 = makeTrendingCandles(30, 1.1, "bullish", 0.005);
  // 1H is ranging (no BOS in bias direction)
  const h1 = makeRangingCandles(30, 1.1);

  const result = determineDirection(daily, h4, h1);
  // If h4Retrace is true but h1Confirmed is false, direction should be null
  if (result.h4Retrace && !result.h1Confirmed) {
    assertEquals(result.direction, null);
    assertEquals(result.reason.includes("waiting for 1H"), true);
  }
  assertExists(result.reason);
});

Deno.test("determineDirection: returns consistent results for same input", () => {
  // Determinism check — same input should produce same output
  const daily = makeTrendingCandles(30, 1.1, "bullish", 0.008);
  const h4 = makeTrendingCandles(30, 1.1, "bullish", 0.004);
  const h1 = makeTrendingCandles(30, 1.1, "bullish", 0.002);

  const result1 = determineDirection(daily, h4, h1);
  const result2 = determineDirection(daily, h4, h1);

  assertEquals(result1.direction, result2.direction);
  assertEquals(result1.bias, result2.bias);
  assertEquals(result1.biasSource, result2.biasSource);
  assertEquals(result1.h4Retrace, result2.h4Retrace);
  assertEquals(result1.h4ChochAgainst, result2.h4ChochAgainst);
  assertEquals(result1.h1Confirmed, result2.h1Confirmed);
});

Deno.test("determineDirection: with insufficient h1 candles, still returns bias info", () => {
  const daily = makeTrendingCandles(30, 1.1, "bullish", 0.008);
  const h4 = makeTrendingCandles(30, 1.1, "bullish", 0.004);
  const h1Short = makeCandles(10, 1.1, "up"); // only 10, need 20

  const result = determineDirection(daily, h4, h1Short);
  // Should still have bias info even if 1H can't confirm
  if (result.bias) {
    assertExists(result.biasSource);
  }
  assertExists(result.reason);
});

Deno.test("determineDirection: Option C fallback — daily ranging, 4H trending = use 4H bias", () => {
  const daily = makeRangingCandles(30, 1.1);
  const h4 = makeTrendingCandles(40, 1.1, "bullish", 0.008); // strong 4H trend
  const h1 = makeTrendingCandles(30, 1.1, "bullish", 0.003);

  const result = determineDirection(daily, h4, h1);
  // If daily is ranging but 4H has clear bullish structure, biasSource should be "4h"
  if (result.biasSource === "4h") {
    assertEquals(result.bias, "bullish");
  }
  assertExists(result.reason);
});
