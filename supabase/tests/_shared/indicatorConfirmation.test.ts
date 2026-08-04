/**
 * Tests for indicatorConfirmation.ts
 * Covers Gap 3: Indicator-based confirmation as alternative to CHoCH
 */
import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  checkIndicatorConfirmation,
  DEFAULT_INDICATOR_CONFIG,
  type Candle,
} from "./indicatorConfirmation.ts";

// ─── Helper: Generate synthetic candles ─────────────────────────────────────

function makeCandles(
  count: number,
  opts: {
    trend?: "up" | "down" | "flat";
    startPrice?: number;
    volume?: number;
    volatility?: number;
  } = {},
): Candle[] {
  const { trend = "flat", startPrice = 1.1000, volume = 1000, volatility = 0.001 } = opts;
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const drift = trend === "up" ? volatility * 0.5 : trend === "down" ? -volatility * 0.5 : 0;
    const open = price;
    const close = price + drift + (Math.random() - 0.5) * volatility;
    const high = Math.max(open, close) + Math.random() * volatility * 0.5;
    const low = Math.min(open, close) - Math.random() * volatility * 0.5;
    candles.push({
      open,
      high,
      low,
      close,
      volume: volume + Math.random() * volume * 0.5,
      datetime: new Date(Date.now() - (count - i) * 5 * 60 * 1000).toISOString(),
    });
    price = close;
  }
  return candles;
}

// ─── Helper: Create oversold candles for long confirmation ──────────────────

function makeOversoldCandles(count: number): Candle[] {
  // Start high, drop sharply to create oversold conditions
  const candles: Candle[] = [];
  let price = 1.1500;
  for (let i = 0; i < count; i++) {
    const drop = i < count * 0.8 ? -0.002 : -0.0005; // Sharp drop then stabilize
    const open = price;
    const close = price + drop;
    const high = Math.max(open, close) + 0.0003;
    const low = Math.min(open, close) - 0.0003;
    candles.push({
      open,
      high,
      low,
      close,
      volume: i > count * 0.7 ? 2500 : 1000, // Volume spike at bottom
      datetime: new Date(Date.now() - (count - i) * 5 * 60 * 1000).toISOString(),
    });
    price = close;
  }
  return candles;
}

// ─── Helper: Create overbought candles for short confirmation ───────────────

function makeOverboughtCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  let price = 1.1000;
  for (let i = 0; i < count; i++) {
    const rise = i < count * 0.8 ? 0.002 : 0.0005;
    const open = price;
    const close = price + rise;
    const high = Math.max(open, close) + 0.0003;
    const low = Math.min(open, close) - 0.0003;
    candles.push({
      open,
      high,
      low,
      close,
      volume: i > count * 0.7 ? 2500 : 1000,
      datetime: new Date(Date.now() - (count - i) * 5 * 60 * 1000).toISOString(),
    });
    price = close;
  }
  return candles;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("indicatorConfirmation — returns structured result with all 4 indicators", () => {
  const candles = makeCandles(40);
  const result = checkIndicatorConfirmation(candles, "long");
  
  assertExists(result);
  assertEquals(result.indicators.length, 4);
  assertEquals(result.requiredCount, 3); // default minIndicators
  assertEquals(typeof result.confirmed, "boolean");
  assertEquals(typeof result.passedCount, "number");
  assertEquals(typeof result.summary, "string");
  
  // Each indicator has required fields
  for (const ind of result.indicators) {
    assertExists(ind.name);
    assertEquals(typeof ind.confirmed, "boolean");
    assertEquals(typeof ind.value, "number");
    assertEquals(typeof ind.threshold, "number");
    assertEquals(typeof ind.detail, "string");
  }
});

Deno.test("indicatorConfirmation — oversold candles confirm long entry", () => {
  const candles = makeOversoldCandles(40);
  const result = checkIndicatorConfirmation(candles, "long", { minIndicators: 2 });
  
  // With strong oversold conditions, at least Stochastic and BB should confirm
  // (MACD might lag, volume should confirm due to spike)
  assertEquals(result.passedCount >= 2, true, `Expected ≥2 passed, got ${result.passedCount}: ${result.summary}`);
  assertEquals(result.confirmed, true);
});

Deno.test("indicatorConfirmation — overbought candles confirm short entry", () => {
  const candles = makeOverboughtCandles(40);
  const result = checkIndicatorConfirmation(candles, "short", { minIndicators: 2 });
  
  assertEquals(result.passedCount >= 2, true, `Expected ≥2 passed, got ${result.passedCount}: ${result.summary}`);
  assertEquals(result.confirmed, true);
});

Deno.test("indicatorConfirmation — flat market does NOT confirm (insufficient indicators)", () => {
  // Flat market: price stays in a tight range, no oversold/overbought
  const candles: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    const base = 1.1000;
    const noise = (Math.sin(i * 0.3) * 0.0002); // tiny oscillation
    candles.push({
      open: base + noise,
      high: base + noise + 0.0001,
      low: base + noise - 0.0001,
      close: base + noise + 0.00005,
      volume: 1000,
      datetime: new Date(Date.now() - (40 - i) * 5 * 60 * 1000).toISOString(),
    });
  }
  
  const result = checkIndicatorConfirmation(candles, "long", { minIndicators: 3 });
  
  // In a flat market, BB won't be at extremes, Stochastic won't be oversold
  // At most 1-2 indicators might pass (volume if equal, MACD if slightly positive)
  assertEquals(result.passedCount < 3, true, `Expected <3 in flat market, got ${result.passedCount}`);
  assertEquals(result.confirmed, false);
});

Deno.test("indicatorConfirmation — minIndicators config is respected", () => {
  const candles = makeCandles(40, { trend: "down" });
  
  // With minIndicators=1, even weak signals pass
  const lenient = checkIndicatorConfirmation(candles, "long", { minIndicators: 1 });
  // With minIndicators=4, all must agree
  const strict = checkIndicatorConfirmation(candles, "long", { minIndicators: 4 });
  
  assertEquals(lenient.requiredCount, 1);
  assertEquals(strict.requiredCount, 4);
  
  // Lenient should be more likely to confirm than strict
  if (lenient.passedCount >= 1) {
    assertEquals(lenient.confirmed, true);
  }
  if (strict.passedCount < 4) {
    assertEquals(strict.confirmed, false);
  }
});

Deno.test("indicatorConfirmation — handles no volume data gracefully", () => {
  const candles = makeCandles(40).map(c => ({ ...c, volume: 0 }));
  const result = checkIndicatorConfirmation(candles, "long");
  
  // Volume indicator should pass by default when no data available
  const volumeInd = result.indicators.find(i => i.name === "Volume");
  assertExists(volumeInd);
  assertEquals(volumeInd.confirmed, true);
  assertEquals(volumeInd.detail.includes("No volume data"), true);
});

Deno.test("indicatorConfirmation — insufficient candles returns safe result", () => {
  // Only 5 candles — not enough for MACD (needs 26+9)
  const candles = makeCandles(5);
  const result = checkIndicatorConfirmation(candles, "long");
  
  // Should not crash, should return a result
  assertExists(result);
  assertEquals(result.indicators.length, 4);
  
  // MACD should report insufficient data
  const macd = result.indicators.find(i => i.name === "MACD");
  assertExists(macd);
  assertEquals(macd.confirmed, false);
});

Deno.test("indicatorConfirmation — direction matters (same candles, different results)", () => {
  const candles = makeOversoldCandles(40);
  
  const longResult = checkIndicatorConfirmation(candles, "long", { minIndicators: 1 });
  const shortResult = checkIndicatorConfirmation(candles, "short", { minIndicators: 1 });
  
  // Oversold candles should favor long, not short
  // BB: price below lower band → long confirmed, not short
  // Stochastic: oversold → long confirmed, not short
  const bbLong = longResult.indicators.find(i => i.name === "Bollinger Bands");
  const bbShort = shortResult.indicators.find(i => i.name === "Bollinger Bands");
  
  // At minimum, BB should differ between long and short on oversold data
  if (bbLong?.confirmed) {
    assertEquals(bbShort?.confirmed, false, "BB should not confirm short on oversold data");
  }
});

Deno.test("indicatorConfirmation — DEFAULT_INDICATOR_CONFIG has expected values", () => {
  assertEquals(DEFAULT_INDICATOR_CONFIG.minIndicators, 3);
  assertEquals(DEFAULT_INDICATOR_CONFIG.bbPeriod, 20);
  assertEquals(DEFAULT_INDICATOR_CONFIG.bbStdDev, 2);
  assertEquals(DEFAULT_INDICATOR_CONFIG.stochPeriod, 14);
  assertEquals(DEFAULT_INDICATOR_CONFIG.stochSmooth, 3);
  assertEquals(DEFAULT_INDICATOR_CONFIG.stochOB, 80);
  assertEquals(DEFAULT_INDICATOR_CONFIG.stochOS, 20);
  assertEquals(DEFAULT_INDICATOR_CONFIG.macdFast, 12);
  assertEquals(DEFAULT_INDICATOR_CONFIG.macdSlow, 26);
  assertEquals(DEFAULT_INDICATOR_CONFIG.macdSignal, 9);
  assertEquals(DEFAULT_INDICATOR_CONFIG.volumeMultiplier, 1.2);
  assertEquals(DEFAULT_INDICATOR_CONFIG.volumeLookback, 20);
});
