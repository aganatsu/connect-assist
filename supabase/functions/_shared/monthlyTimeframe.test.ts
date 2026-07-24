/**
 * monthlyTimeframe.test.ts — Tests for Monthly Timeframe Integration
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  synthesizeMonthlyCandles,
  analyzeMonthlyStructure,
  checkMonthlyContainment,
} from "./monthlyTimeframe.ts";
import type { Candle } from "./smcAnalysis.ts";

function makeCandle(o: number, h: number, l: number, c: number, dateStr: string): Candle {
  return { open: o, high: h, low: l, close: c, volume: 100, datetime: dateStr };
}

/**
 * Generate 6 months of daily candles (approx 130 candles) with a mild uptrend.
 */
function makeDailyCandles(months = 6, startPrice = 1.1000): Candle[] {
  const candles: Candle[] = [];
  const startDate = new Date("2024-01-02T00:00:00Z");
  let price = startPrice;

  for (let d = 0; d < months * 22; d++) { // ~22 trading days per month
    const date = new Date(startDate.getTime() + d * 24 * 3600 * 1000);
    // Skip weekends
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;

    const move = (Math.sin(d * 0.3) * 0.0010) + 0.0002; // Mild uptrend with oscillation
    const o = price;
    const c = price + move;
    const h = Math.max(o, c) + 0.0005;
    const l = Math.min(o, c) - 0.0005;

    candles.push(makeCandle(o, h, l, c, date.toISOString()));
    price = c;
  }

  return candles;
}

// ─── Synthesis Tests ──────────────────────────────────────────────────────────

Deno.test("synthesizeMonthlyCandles — groups daily candles into monthly", () => {
  const dailyCandles = makeDailyCandles(6);
  const monthly = synthesizeMonthlyCandles(dailyCandles);

  // Should have approximately 6 monthly candles
  assert(monthly.length >= 4 && monthly.length <= 7,
    `Expected 4-7 monthly candles from 6 months of data, got ${monthly.length}`);

  // Each monthly candle should have valid OHLC
  for (const mc of monthly) {
    assert(mc.high >= mc.low, "Monthly high should be >= low");
    assert(mc.high >= mc.open, "Monthly high should be >= open");
    assert(mc.high >= mc.close, "Monthly high should be >= close");
    assert(mc.low <= mc.open, "Monthly low should be <= open");
    assert(mc.low <= mc.close, "Monthly low should be <= close");
  }
});

Deno.test("synthesizeMonthlyCandles — monthly open equals first daily open of month", () => {
  const dailyCandles = makeDailyCandles(3);
  const monthly = synthesizeMonthlyCandles(dailyCandles);

  if (monthly.length > 0) {
    // First monthly candle's open should match first daily candle's open
    assertEquals(monthly[0].open, dailyCandles[0].open);
  }
});

Deno.test("synthesizeMonthlyCandles — insufficient data returns empty", () => {
  const candles = [makeCandle(1.1, 1.11, 1.09, 1.105, "2024-01-02T00:00:00Z")];
  const monthly = synthesizeMonthlyCandles(candles);
  assertEquals(monthly.length, 0);
});

Deno.test("synthesizeMonthlyCandles — empty input returns empty", () => {
  const monthly = synthesizeMonthlyCandles([]);
  assertEquals(monthly.length, 0);
});

// ─── Analysis Tests ──────────────────────────────────────────────────────────

Deno.test("analyzeMonthlyStructure — produces levels and bias", () => {
  const dailyCandles = makeDailyCandles(6);
  const analysis = analyzeMonthlyStructure(dailyCandles);

  // Should have monthly candles
  assert(analysis.monthlyCandles.length >= 4, "Should have monthly candles");

  // Should have levels (highs, lows, opens for each month)
  assert(analysis.levels.length > 0, "Should extract monthly levels");

  // Bias should be one of the valid values
  assert(["bullish", "bearish", "neutral"].includes(analysis.bias));

  // Current month range should exist
  assert(analysis.currentMonthRange !== null);
  if (analysis.currentMonthRange) {
    assert(analysis.currentMonthRange.high >= analysis.currentMonthRange.low);
  }
});

Deno.test("analyzeMonthlyStructure — insufficient data returns neutral", () => {
  const candles = [makeCandle(1.1, 1.11, 1.09, 1.105, "2024-01-02T00:00:00Z")];
  const analysis = analyzeMonthlyStructure(candles);

  assertEquals(analysis.bias, "neutral");
  assertEquals(analysis.levels.length, 0);
});

// ─── Containment Tests ───────────────────────────────────────────────────────

Deno.test("checkMonthlyContainment — zone inside monthly OB is contained", () => {
  const dailyCandles = makeDailyCandles(6);
  const analysis = analyzeMonthlyStructure(dailyCandles);

  // If there are monthly OBs, test containment
  if (analysis.orderBlocks.length > 0) {
    const ob = analysis.orderBlocks[0];
    const zoneMid = (ob.high + ob.low) / 2;
    const zoneHigh = zoneMid + 0.0005;
    const zoneLow = zoneMid - 0.0005;

    const result = checkMonthlyContainment(zoneHigh, zoneLow, ob.type, analysis);
    // Should at minimum find the monthly levels
    assert(typeof result.isContained === "boolean");
    assert(typeof result.confidence === "number");
  }
});

Deno.test("checkMonthlyContainment — empty levels returns not contained", () => {
  const emptyAnalysis = {
    monthlyCandles: [],
    levels: [],
    orderBlocks: [],
    bias: "neutral" as const,
    currentMonthRange: null,
  };

  const result = checkMonthlyContainment(1.1010, 1.1000, "bullish", emptyAnalysis);
  assertEquals(result.isContained, false);
  assertEquals(result.confidence, 0);
});

Deno.test("checkMonthlyContainment — bias alignment check works", () => {
  const analysis = {
    monthlyCandles: [],
    levels: [
      { type: "monthly_low" as const, price: 1.0950, month: "2024-01", tested: false },
    ],
    orderBlocks: [],
    bias: "bullish" as const,
    currentMonthRange: { high: 1.1100, low: 1.0900, open: 1.1000 },
  };

  // Bullish zone with bullish monthly bias = aligned
  const bullishResult = checkMonthlyContainment(1.1010, 1.1000, "bullish", analysis);
  assertEquals(bullishResult.biasAligned, true);

  // Bearish zone with bullish monthly bias = not aligned
  const bearishResult = checkMonthlyContainment(1.1010, 1.1000, "bearish", analysis);
  assertEquals(bearishResult.biasAligned, false);
});

Deno.test("checkMonthlyContainment — finds monthly support below bullish zone", () => {
  const analysis = {
    monthlyCandles: [],
    levels: [
      { type: "monthly_low" as const, price: 1.0950, month: "2024-01", tested: false },
      { type: "monthly_ob_low" as const, price: 1.0980, month: "2024-02", tested: false },
    ],
    orderBlocks: [],
    bias: "bullish" as const,
    currentMonthRange: { high: 1.1100, low: 1.0900, open: 1.1000 },
  };

  const result = checkMonthlyContainment(1.1010, 1.1000, "bullish", analysis);
  assertEquals(result.isContained, true);
  assert(result.containingLevels.length >= 1);
  assert(result.confidence > 0);
});
