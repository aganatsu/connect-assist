/**
 * Weekly Profile Detection — Phase 9 Tests
 *
 * Tests the ICT weekly profile pattern detection.
 *
 * Verifies:
 * 1. Classic Tuesday Low detection
 * 2. Classic Tuesday High detection
 * 3. Consolidation Monday detection
 * 4. Expansion Monday detection
 * 5. Wednesday Reversal detection
 * 6. Seek & Destroy detection
 * 7. Day tendency assignment
 * 8. Favorable entry determination
 * 9. Empty/insufficient data handling
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { detectWeeklyProfile } from "./weeklyProfile.ts";
import type { Candle } from "./smcAnalysis.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a candle for a specific day of the week.
 * Uses a known Monday (2026-01-05 is a Monday) as the base.
 */
function makeDayCandle(
  dayOffset: number, // 0=Monday, 1=Tuesday, ..., 4=Friday
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  // 2026-01-05 is a Monday (UTC)
  const baseDate = new Date("2026-01-05T12:00:00Z");
  baseDate.setUTCDate(baseDate.getUTCDate() + dayOffset);
  return {
    datetime: baseDate.toISOString(),
    open,
    high,
    low,
    close,
    volume: 1000,
  };
}

/**
 * Create a set of "history" candles for the 20-day average range calculation.
 * These go before the current week's candles.
 */
function makeHistoryCandles(count: number, basePrice: number, avgRange: number): Candle[] {
  const candles: Candle[] = [];
  // Start 5 weeks before the test week
  const baseDate = new Date("2025-12-01T12:00:00Z");
  for (let i = 0; i < count; i++) {
    const date = new Date(baseDate);
    date.setUTCDate(date.getUTCDate() + i);
    // Skip weekends
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) continue;

    candles.push({
      datetime: date.toISOString(),
      open: basePrice,
      high: basePrice + avgRange / 2,
      low: basePrice - avgRange / 2,
      close: basePrice,
      volume: 1000,
    });
  }
  return candles;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

Deno.test("Weekly Profile: detects Classic Tuesday Low", () => {
  // History candles with avg range of 100 pips
  const history = makeHistoryCandles(30, 1.1000, 0.0100);

  // Monday: normal range
  const monday = makeDayCandle(0, 1.1000, 1.1050, 1.0950, 1.1000);
  // Tuesday: makes the week's low, but closes above Monday's midpoint (1.1000)
  const tuesday = makeDayCandle(1, 1.0980, 1.1020, 1.0880, 1.1010);
  // Wednesday: continues higher (confirming the pattern)
  const wednesday = makeDayCandle(2, 1.1010, 1.1100, 1.1000, 1.1080);

  const candles = [...history, monday, tuesday, wednesday];
  const result = detectWeeklyProfile(candles, 0.0001);

  assertEquals(result.profile, "classic_tuesday_low");
  assert(result.confidence >= 55, `Confidence should be >= 55, got ${result.confidence}`);
  assertEquals(result.lowDay, "tuesday");
  assert(result.expectation.includes("bullish"), "Should mention bullish expectation");
});

Deno.test("Weekly Profile: detects Classic Tuesday High", () => {
  const history = makeHistoryCandles(30, 1.1000, 0.0100);

  // Monday: normal range
  const monday = makeDayCandle(0, 1.1000, 1.1050, 1.0950, 1.1000);
  // Tuesday: makes the week's high, closes below Monday's midpoint (1.1000)
  const tuesday = makeDayCandle(1, 1.1020, 1.1120, 1.0970, 1.0980);
  // Wednesday: continues lower (confirming the pattern)
  const wednesday = makeDayCandle(2, 1.0980, 1.1000, 1.0900, 1.0920);

  const candles = [...history, monday, tuesday, wednesday];
  const result = detectWeeklyProfile(candles, 0.0001);

  assertEquals(result.profile, "classic_tuesday_high");
  assert(result.confidence >= 55, `Confidence should be >= 55, got ${result.confidence}`);
  assertEquals(result.highDay, "tuesday");
  assert(result.expectation.includes("bearish"), "Should mention bearish expectation");
});

Deno.test("Weekly Profile: detects Consolidation Monday", () => {
  // History with avg range of 100 pips (0.0100)
  const history = makeHistoryCandles(30, 1.1000, 0.0100);

  // Monday: very tight range (< 60% of average = < 60 pips)
  const monday = makeDayCandle(0, 1.1000, 1.1020, 1.0990, 1.1005);
  // Range = 30 pips, which is < 60 pips threshold

  const candles = [...history, monday];
  const result = detectWeeklyProfile(candles, 0.0001);

  assertEquals(result.profile, "consolidation_monday");
  assert(result.confidence >= 40, `Confidence should be >= 40, got ${result.confidence}`);
  assert(result.expectation.includes("breakout"), "Should mention breakout expectation");
});

Deno.test("Weekly Profile: detects Expansion Monday", () => {
  // History with avg range of 100 pips (0.0100)
  const history = makeHistoryCandles(30, 1.1000, 0.0100);

  // Monday: very wide range (> 150% of average = > 150 pips)
  const monday = makeDayCandle(0, 1.1000, 1.1200, 1.0950, 1.1150);
  // Range = 250 pips, which is > 150 pips threshold

  const candles = [...history, monday];
  const result = detectWeeklyProfile(candles, 0.0001);

  assertEquals(result.profile, "expansion_monday");
  assert(result.confidence >= 35, `Confidence should be >= 35, got ${result.confidence}`);
  assert(result.expectation.includes("continuation"), "Should mention continuation expectation");
});

Deno.test("Weekly Profile: detects Seek & Destroy (Wednesday sweeps both sides)", () => {
  const history = makeHistoryCandles(30, 1.1000, 0.0100);

  const monday = makeDayCandle(0, 1.1000, 1.1050, 1.0950, 1.1000);
  // Tuesday: establishes a range
  const tuesday = makeDayCandle(1, 1.1000, 1.1060, 1.0940, 1.1010);
  // Wednesday: takes out BOTH Tuesday's high AND low (seek & destroy)
  const wednesday = makeDayCandle(2, 1.1010, 1.1080, 1.0920, 1.1000);

  const candles = [...history, monday, tuesday, wednesday];
  const result = detectWeeklyProfile(candles, 0.0001);

  assertEquals(result.profile, "seek_and_destroy");
  assert(result.confidence >= 60, `Confidence should be >= 60, got ${result.confidence}`);
  assert(result.expectation.includes("Thursday"), "Should mention Thursday expectation");
});

Deno.test("Weekly Profile: returns 'developing' with insufficient data", () => {
  const result = detectWeeklyProfile([], 0.0001);

  assertEquals(result.profile, "developing");
  assertEquals(result.confidence, 0);
});

Deno.test("Weekly Profile: day tendency is correct for each day", () => {
  const history = makeHistoryCandles(30, 1.1000, 0.0100);

  // Monday only
  const monday = makeDayCandle(0, 1.1000, 1.1050, 1.0950, 1.1000);
  const monResult = detectWeeklyProfile([...history, monday], 0.0001);
  assertEquals(monResult.dayTendency.day, "monday");
  assertEquals(monResult.dayTendency.tendency, "accumulation");

  // Add Tuesday
  const tuesday = makeDayCandle(1, 1.1000, 1.1060, 1.0940, 1.1010);
  const tueResult = detectWeeklyProfile([...history, monday, tuesday], 0.0001);
  assertEquals(tueResult.dayTendency.day, "tuesday");
  assertEquals(tueResult.dayTendency.tendency, "manipulation");

  // Add Wednesday
  const wednesday = makeDayCandle(2, 1.1010, 1.1100, 1.0980, 1.1080);
  const wedResult = detectWeeklyProfile([...history, monday, tuesday, wednesday], 0.0001);
  assertEquals(wedResult.dayTendency.day, "wednesday");
  assertEquals(wedResult.dayTendency.tendency, "distribution");
});

Deno.test("Weekly Profile: Friday is not favorable for entry", () => {
  const history = makeHistoryCandles(30, 1.1000, 0.0100);

  const monday = makeDayCandle(0, 1.1000, 1.1050, 1.0950, 1.1000);
  const tuesday = makeDayCandle(1, 1.1000, 1.1060, 1.0940, 1.1010);
  const wednesday = makeDayCandle(2, 1.1010, 1.1100, 1.0980, 1.1080);
  const thursday = makeDayCandle(3, 1.1080, 1.1120, 1.1050, 1.1100);
  const friday = makeDayCandle(4, 1.1100, 1.1130, 1.1070, 1.1090);

  const candles = [...history, monday, tuesday, wednesday, thursday, friday];
  const result = detectWeeklyProfile(candles, 0.0001);

  assertEquals(result.favorableForEntry, false, "Friday should not be favorable for entry");
  assertEquals(result.dayTendency.tendency, "profit_taking");
});

Deno.test("Weekly Profile: Wednesday is favorable for entry", () => {
  const history = makeHistoryCandles(30, 1.1000, 0.0100);

  const monday = makeDayCandle(0, 1.1000, 1.1050, 1.0950, 1.1000);
  const tuesday = makeDayCandle(1, 1.1000, 1.1060, 1.0940, 1.1010);
  const wednesday = makeDayCandle(2, 1.1010, 1.1100, 1.0980, 1.1080);

  const candles = [...history, monday, tuesday, wednesday];
  const result = detectWeeklyProfile(candles, 0.0001);

  assertEquals(result.favorableForEntry, true, "Wednesday should be favorable for entry");
  assertEquals(result.dayTendency.aggressiveness, "aggressive");
});

Deno.test("Weekly Profile: week high/low tracking is correct", () => {
  const history = makeHistoryCandles(30, 1.1000, 0.0100);

  const monday = makeDayCandle(0, 1.1000, 1.1050, 1.0950, 1.1000);
  const tuesday = makeDayCandle(1, 1.1000, 1.1060, 1.0880, 1.1010); // Lowest low
  const wednesday = makeDayCandle(2, 1.1010, 1.1150, 1.0980, 1.1080); // Highest high

  const candles = [...history, monday, tuesday, wednesday];
  const result = detectWeeklyProfile(candles, 0.0001);

  assertEquals(result.weekHigh, 1.1150, "Week high should be Wednesday's high");
  assertEquals(result.weekLow, 1.0880, "Week low should be Tuesday's low");
  assertEquals(result.highDay, "wednesday");
  assertEquals(result.lowDay, "tuesday");
});
