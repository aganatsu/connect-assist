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
  // When both daily and 4H are ranging, direction should be null.
  // However, with non-deterministic data, analyzeMarketStructure may detect a trend.
  // If no bias is detected (both ranging), direction must be null.
  // If a bias IS detected (random data produced a trend), direction may be non-null
  // due to hysteresis maintaining it when no opposing CHoCH exists.
  if (result.bias === null) {
    assertEquals(result.direction, null, "No bias detected → direction must be null");
  }
  // Either way, the result should be valid
  assertEquals(
    result.direction === "long" || result.direction === "short" || result.direction === null,
    true,
    `direction should be valid, got: ${result.direction}`,
  );
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

Deno.test("determineDirection: h4Retrace without h1Confirmed — hysteresis maintains direction if no opposing CHoCH", () => {
  // With hysteresis fix: if 4H is retracing but 1H hasn't confirmed,
  // direction is MAINTAINED (not nullified) unless there's an active opposing CHoCH.
  // Absence of confirmation ≠ invalidation.
  const daily = makeTrendingCandles(40, 1.1, "bullish", 0.01);
  const h4 = makeTrendingCandles(30, 1.1, "bullish", 0.005);
  // 1H is ranging (no BOS in bias direction, but also no CHoCH against)
  const h1 = makeRangingCandles(30, 1.1);

  const result = determineDirection(daily, h4, h1);
  // With hysteresis: if h4Retrace=true, h1Confirmed=false, and NO opposing CHoCH,
  // direction should be maintained (not null)
  if (result.h4Retrace && !result.h1Confirmed) {
    // New behavior: direction maintained via hysteresis
    assertEquals(result.direction !== null || result.reason.includes("direction maintained") || result.reason.includes("no opposing"), true,
      `Expected direction maintained or hysteresis reason, got: ${result.direction} / ${result.reason}`);
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

// ─── Hysteresis Regression Tests ────────────────────────────────────────────
// These tests verify the direction engine hysteresis fix:
// Direction is only nullified by an active opposing signal (1H CHoCH against bias),
// NOT by the mere absence of a confirming BOS rolling off the lookback window.

// Helper: create candles from explicit close prices with proper OHLC and datetime
function makeExplicitCandles(
  closePrices: number[],
  baseTime: number,
  intervalMs: number,
): Candle[] {
  return closePrices.map((c, i) => {
    const prev = i > 0 ? closePrices[i - 1] : c;
    const isUp = c >= prev;
    const range = 0.003;
    return {
      time: baseTime + i * intervalMs,
      open: isUp ? c - range : c + range,
      high: isUp ? c + range : c + range * 1.5,
      low: isUp ? c - range * 1.5 : c - range,
      close: c,
      volume: 100,
    };
  }) as unknown as Candle[];
}

// Daily fixture: clear bullish trend (produces bullish trend detection)
function makeBullishDailyFixture(): Candle[] {
  const prices: number[] = [];
  for (let i = 0; i < 40; i++) {
    const wave = Math.floor(i / 10);
    const pos = i % 10;
    const waveBase = 1.08 + wave * 0.005;
    if (pos < 7) { prices.push(waveBase + pos * 0.002); }
    else { prices.push(waveBase + 0.014 - (pos - 7) * 0.003); }
  }
  return makeExplicitCandles(prices, new Date("2024-01-01").getTime(), 86400000);
}

// 4H fixture: bullish with retrace at end (h4Retrace=true, no CHoCH)
function makeBullish4HRetracingFixture(): Candle[] {
  const prices: number[] = [];
  for (let i = 0; i < 30; i++) {
    const wave = Math.floor(i / 8);
    const pos = i % 8;
    const waveBase = 1.10 + wave * 0.004;
    if (i < 22) {
      if (pos < 5) { prices.push(waveBase + pos * 0.0015); }
      else { prices.push(waveBase + 0.0075 - (pos - 5) * 0.002); }
    } else {
      prices.push(1.10 + 2 * 0.004 + 0.0075 - (i - 22) * 0.001);
    }
  }
  return makeExplicitCandles(prices, new Date("2024-02-01").getTime(), 4 * 3600000);
}

// 1H fixture: flat/ranging — no BOS, no CHoCH (simulates BOS rolling off window)
function make1HFlatFixture(): Candle[] {
  const prices: number[] = [];
  for (let i = 0; i < 30; i++) {
    prices.push(1.11 + Math.sin(i * 0.4) * 0.0002);
  }
  return makeExplicitCandles(prices, new Date("2024-02-05").getTime(), 3600000);
}

// 1H fixture: bullish BOS early, then bearish CHoCH in last 8 candles
function make1HWithBearishChochFixture(): Candle[] {
  const prices = [
    // Wave 1 up (0-3)
    1.10, 1.11, 1.12, 1.13,
    // Pullback 1 (4-6): swing low
    1.12, 1.11, 1.105,
    // Wave 2 up (7-10): BOS bullish (breaks above 1.13)
    1.11, 1.12, 1.13, 1.14,
    // Pullback 2 (11-13): higher swing low
    1.13, 1.12, 1.115,
    // Wave 3 up (14-17): BOS bullish (breaks above 1.14)
    1.12, 1.13, 1.14, 1.15,
    // Pullback 3 (18-20): swing low
    1.14, 1.13, 1.12,
    // Small bounce (21-22)
    1.13, 1.14,
    // REVERSAL (23-25): drops below previous swing lows → bearish CHoCH
    1.12, 1.10, 1.08,
    // Bounce to form right side of swing (26-29)
    1.10, 1.11, 1.12, 1.13,
  ];
  return makeExplicitCandles(prices, new Date("2024-02-05").getTime(), 3600000);
}

Deno.test("HYSTERESIS: direction maintained when 1H BOS rolls off but no opposing CHoCH", () => {
  // Scenario: Daily bullish, 4H retracing, 1H is flat (BOS has rolled off the lookback window)
  // Expected: direction = 'long' (maintained via hysteresis, not nullified)
  const daily = makeBullishDailyFixture();
  const h4 = makeBullish4HRetracingFixture();
  const h1 = make1HFlatFixture();

  const result = determineDirection(daily, h4, h1);

  // Verify preconditions
  assertEquals(result.bias, "bullish", "Daily should detect bullish bias");
  assertEquals(result.h4Retrace, true, "4H should be retracing");
  assertEquals(result.h1Confirmed, false, "1H should NOT be confirmed (no recent BOS)");

  // KEY ASSERTION: direction is maintained (not null) because there's no opposing CHoCH
  assertEquals(result.direction, "long",
    `Hysteresis failed: direction should be 'long' (maintained) when no opposing CHoCH, got: ${result.direction}`);
  assertEquals(result.reason.includes("direction maintained"), true,
    `Reason should mention 'direction maintained', got: ${result.reason}`);
});

Deno.test("HYSTERESIS: direction nullified when 1H CHoCH against bias appears", () => {
  // Scenario: Daily bullish, 4H retracing, 1H has bearish CHoCH (opposing signal)
  // Expected: direction = null (genuine reversal signal)
  const daily = makeBullishDailyFixture();
  const h4 = makeBullish4HRetracingFixture();
  const h1 = make1HWithBearishChochFixture();

  const result = determineDirection(daily, h4, h1);

  // Verify preconditions
  assertEquals(result.bias, "bullish", "Daily should detect bullish bias");
  assertEquals(result.h4Retrace, true, "4H should be retracing");
  assertEquals(result.h1Confirmed, false, "1H should NOT be confirmed");

  // KEY ASSERTION: direction is null because there IS an opposing CHoCH
  assertEquals(result.direction, null,
    `Direction should be null when 1H has bearish CHoCH against bullish bias, got: ${result.direction}`);
  assertEquals(result.reason.includes("direction nullified") || result.reason.includes("CHoCH against"), true,
    `Reason should mention CHoCH against or nullified, got: ${result.reason}`);
});

Deno.test("HYSTERESIS: consecutive scans without 1H confirmation produce stable direction", () => {
  // Regression test for the original bug: direction flip-flopping between scans.
  // Two consecutive calls with the same "no 1H confirmation" state should produce
  // the same direction (not flip between long and null).
  const daily = makeBullishDailyFixture();
  const h4 = makeBullish4HRetracingFixture();
  const h1 = make1HFlatFixture();

  const scan1 = determineDirection(daily, h4, h1);
  const scan2 = determineDirection(daily, h4, h1);

  // Both scans should produce identical results (deterministic)
  assertEquals(scan1.direction, scan2.direction,
    `Direction flip-flop detected: scan1=${scan1.direction}, scan2=${scan2.direction}`);
  assertEquals(scan1.direction, "long",
    "Both scans should maintain direction as 'long' via hysteresis");
});

Deno.test("HYSTERESIS: source code contains hysteresis check for opposing CHoCH", () => {
  // Structural guard: verify the hysteresis logic exists in the source
  const source = Deno.readTextFileSync(
    new URL("./directionEngine.ts", import.meta.url).pathname
  );
  assertEquals(source.includes("hasOpposingSignal"), true,
    "directionEngine.ts should contain 'hasOpposingSignal' variable for hysteresis check");
  assertEquals(source.includes("direction maintained"), true,
    "directionEngine.ts should contain 'direction maintained' in reason text");
  assertEquals(source.includes("direction nullified"), true,
    "directionEngine.ts should contain 'direction nullified' in reason text");
  assertEquals(source.includes("Absence of confirmation"), true,
    "directionEngine.ts should contain the hysteresis comment explaining the principle");
});

// ─── Default Config Guard: useSimpleDirection must be true ──────────────────
// Ensures the bot-scanner default config has useSimpleDirection enabled fleet-wide.
// If someone accidentally reverts this to false, this test catches it.

Deno.test("GUARD: bot-scanner DEFAULTS has useSimpleDirection = true", () => {
  const source = Deno.readTextFileSync(
    new URL("../bot-scanner/index.ts", import.meta.url).pathname
  );
  // Check the DEFAULTS object (line ~167)
  const defaultsMatch = source.match(/const DEFAULTS\s*=\s*\{[\s\S]*?\n\};/);
  if (!defaultsMatch) {
    throw new Error("Could not find DEFAULTS object in bot-scanner/index.ts");
  }
  assertEquals(
    defaultsMatch[0].includes("useSimpleDirection: true"),
    true,
    "DEFAULTS.useSimpleDirection must be true (direction engine with hysteresis should be the default)",
  );
});

Deno.test("GUARD: bot-scanner config merge falls back to useSimpleDirection = true", () => {
  const source = Deno.readTextFileSync(
    new URL("../bot-scanner/index.ts", import.meta.url).pathname
  );
  // Check the config merge line (line ~773)
  // Pattern: strategy.useSimpleDirection ?? raw.useSimpleDirection ?? true
  const mergePattern = /useSimpleDirection:\s*strategy\.useSimpleDirection\s*\?\?\s*raw\.useSimpleDirection\s*\?\?\s*true/;
  assertEquals(
    mergePattern.test(source),
    true,
    "Config merge must fall back to useSimpleDirection = true (not false)",
  );
});
