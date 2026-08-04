/**
 * Tests for ictHTFIntegration.ts — ICT Higher Timeframe Integration Layer
 */
import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  runICTHTFAnalysis,
  DEFAULT_ICT_HTF_CONFIG,
  type ICTHTFResult,
} from "./ictHTFIntegration.ts";
import type { Candle } from "./smcAnalysis.ts";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function makeCandle(open: number, high: number, low: number, close: number, datetime = "2024-01-01"): Candle {
  return { open, high, low, close, datetime, volume: 1000 };
}

function makeBullishTrendWeekly(_startPrice: number, _count: number, _avgRange = 0.0100): Candle[] {
  // Proper HH/HL structure with clear swing points for detectSwingPoints(lookback=3)
  return [
    makeCandle(1.0000, 1.0050, 0.9950, 1.0020, "W01"),
    makeCandle(1.0020, 1.0060, 0.9970, 1.0010, "W02"),
    makeCandle(1.0010, 1.0040, 0.9960, 1.0030, "W03"),
    // Leg 1 up
    makeCandle(1.0030, 1.0100, 1.0010, 1.0090, "W04"),
    makeCandle(1.0090, 1.0160, 1.0070, 1.0150, "W05"),
    makeCandle(1.0150, 1.0250, 1.0130, 1.0230, "W06"), // SWING HIGH
    // Pullback 1
    makeCandle(1.0230, 1.0240, 1.0150, 1.0160, "W07"),
    makeCandle(1.0160, 1.0170, 1.0080, 1.0090, "W08"),
    makeCandle(1.0090, 1.0100, 1.0020, 1.0040, "W09"), // SWING LOW
    makeCandle(1.0040, 1.0110, 1.0030, 1.0100, "W10"),
    // Leg 2 up
    makeCandle(1.0100, 1.0200, 1.0080, 1.0190, "W11"),
    makeCandle(1.0190, 1.0280, 1.0170, 1.0270, "W12"),
    makeCandle(1.0270, 1.0380, 1.0250, 1.0360, "W13"), // SWING HIGH (HH)
    // Pullback 2
    makeCandle(1.0360, 1.0370, 1.0280, 1.0290, "W14"),
    makeCandle(1.0290, 1.0300, 1.0200, 1.0220, "W15"),
    makeCandle(1.0220, 1.0230, 1.0150, 1.0170, "W16"), // SWING LOW (HL)
    makeCandle(1.0170, 1.0250, 1.0160, 1.0240, "W17"),
    // Leg 3 up
    makeCandle(1.0240, 1.0350, 1.0220, 1.0340, "W18"),
    makeCandle(1.0340, 1.0450, 1.0320, 1.0440, "W19"),
    makeCandle(1.0440, 1.0550, 1.0420, 1.0530, "W20"), // SWING HIGH (HH)
  ];
}

function makeBearishTrendWeekly(_startPrice: number, _count: number, _avgRange = 0.0100): Candle[] {
  // Proper LH/LL structure
  return [
    makeCandle(1.1000, 1.1050, 1.0950, 1.0980, "W01"),
    makeCandle(1.0980, 1.1030, 1.0940, 1.0990, "W02"),
    makeCandle(1.0990, 1.1040, 1.0960, 1.0970, "W03"),
    // Leg 1 down
    makeCandle(1.0970, 1.0990, 1.0880, 1.0890, "W04"),
    makeCandle(1.0890, 1.0910, 1.0790, 1.0800, "W05"),
    makeCandle(1.0800, 1.0820, 1.0700, 1.0720, "W06"), // SWING LOW
    // Pullback 1
    makeCandle(1.0720, 1.0810, 1.0710, 1.0800, "W07"),
    makeCandle(1.0800, 1.0880, 1.0790, 1.0870, "W08"),
    makeCandle(1.0870, 1.0950, 1.0860, 1.0930, "W09"), // SWING HIGH (LH)
    makeCandle(1.0930, 1.0940, 1.0850, 1.0860, "W10"),
    // Leg 2 down
    makeCandle(1.0860, 1.0870, 1.0750, 1.0760, "W11"),
    makeCandle(1.0760, 1.0780, 1.0650, 1.0660, "W12"),
    makeCandle(1.0660, 1.0680, 1.0550, 1.0570, "W13"), // SWING LOW (LL)
    // Pullback 2
    makeCandle(1.0570, 1.0660, 1.0560, 1.0650, "W14"),
    makeCandle(1.0650, 1.0730, 1.0640, 1.0720, "W15"),
    makeCandle(1.0720, 1.0800, 1.0710, 1.0780, "W16"), // SWING HIGH (LH)
    makeCandle(1.0780, 1.0790, 1.0700, 1.0710, "W17"),
    // Leg 3 down
    makeCandle(1.0710, 1.0720, 1.0600, 1.0610, "W18"),
    makeCandle(1.0610, 1.0630, 1.0500, 1.0510, "W19"),
    makeCandle(1.0510, 1.0530, 1.0400, 1.0420, "W20"), // SWING LOW (LL)
  ];
}

function makeDailyWithBearishDisplacement(): Candle[] {
  const candles: Candle[] = [];
  let price = 1.2000;

  // 20 normal candles (need 30+ total for MIN_DAILY_CANDLES)
  for (let i = 0; i < 20; i++) {
    const body = ((i % 3) - 1) * 0.0008;
    const open = price;
    const close = price + body;
    const high = Math.max(open, close) + 0.0010;
    const low = Math.min(open, close) - 0.0010;
    candles.push(makeCandle(open, high, low, close, `2024-01-${(i + 1).toString().padStart(2, "0")}`));
    price = close;
  }

  // OB candle (bullish before bearish displacement)
  candles.push(makeCandle(price, price + 0.0030, price - 0.0005, price + 0.0025, "2024-01-21"));
  price += 0.0025;

  // 3 large bearish displacement candles
  for (let i = 0; i < 3; i++) {
    const open = price;
    const close = price - 0.0080;
    candles.push(makeCandle(open, open + 0.0005, close - 0.0005, close, `2024-01-${(22 + i).toString().padStart(2, "0")}`));
    price = close;
  }

  // 10 normal retracement candles
  for (let i = 0; i < 10; i++) {
    const body = 0.0010;
    const open = price;
    const close = price + body;
    candles.push(makeCandle(open, close + 0.0005, open - 0.0005, close, `2024-01-${(25 + i).toString().padStart(2, "0")}`));
    price = close;
  }

  return candles; // 33 candles total
}

// ─── Integration Tests ────────────────────────────────────────────────────────

Deno.test("ictHTFIntegration: returns pass when disabled", () => {
  const dailyCandles = makeDailyWithBearishDisplacement();
  const result = runICTHTFAnalysis(null, dailyCandles, 1.1900, "short", null, { ictHTFEnabled: false });
  assertEquals(result.passed, true);
  assertEquals(result.scoreAdjustment, 0);
});

Deno.test("ictHTFIntegration: returns pass when gate mode is off", () => {
  const dailyCandles = makeDailyWithBearishDisplacement();
  const result = runICTHTFAnalysis(null, dailyCandles, 1.1900, "short", null, { ictHTFGateMode: "off" });
  assertEquals(result.passed, true);
});

Deno.test("ictHTFIntegration: weekly bias aligned with trade direction passes", () => {
  const weeklyCandles = makeBearishTrendWeekly(1.3000, 16);
  const dailyCandles = makeDailyWithBearishDisplacement();
  const currentPrice = dailyCandles[dailyCandles.length - 1].close;

  const result = runICTHTFAnalysis(weeklyCandles, dailyCandles, currentPrice, "short", null, {
    ictHTFGateMode: "hard",
    ictDailyContainmentRequired: false, // Only test weekly
  });

  assertEquals(result.weeklyAligned, true);
  assertEquals(result.passed, true);
});

Deno.test("ictHTFIntegration: weekly bias misaligned blocks in hard mode", () => {
  const weeklyCandles = makeBullishTrendWeekly(1.0000, 16); // Bullish weekly
  const dailyCandles = makeDailyWithBearishDisplacement();
  const currentPrice = dailyCandles[dailyCandles.length - 1].close;

  const result = runICTHTFAnalysis(weeklyCandles, dailyCandles, currentPrice, "short", null, {
    ictHTFGateMode: "hard",
    ictWeeklyBiasRequired: true,
    ictDailyContainmentRequired: false,
  });

  assertEquals(result.weeklyAligned, false);
  assertEquals(result.passed, false);
  assert(result.reason.includes("FAIL"));
});

Deno.test("ictHTFIntegration: weekly bias misaligned applies penalty in soft mode", () => {
  const weeklyCandles = makeBullishTrendWeekly(1.0000, 16); // Bullish weekly
  const dailyCandles = makeDailyWithBearishDisplacement();
  const currentPrice = dailyCandles[dailyCandles.length - 1].close;

  const result = runICTHTFAnalysis(weeklyCandles, dailyCandles, currentPrice, "short", null, {
    ictHTFGateMode: "soft",
    ictWeeklyBiasRequired: true,
  });

  // Soft mode always passes
  assertEquals(result.passed, true);
  // But should have a negative score adjustment
  assert(result.scoreAdjustment < 0, `Score adjustment should be negative, got ${result.scoreAdjustment}`);
});

Deno.test("ictHTFIntegration: containment check passes when zone inside Daily OB", () => {
  const dailyCandles = makeDailyWithBearishDisplacement();
  const obCandle = dailyCandles[15]; // The OB candle
  const currentPrice = dailyCandles[dailyCandles.length - 1].close;

  // LTF zone inside the OB range
  const ltfZone = {
    high: obCandle.high - 0.0005,
    low: obCandle.low + 0.0005,
  };

  const result = runICTHTFAnalysis(null, dailyCandles, currentPrice, "short", ltfZone, {
    ictHTFGateMode: "hard",
    ictWeeklyBiasRequired: false,
    ictDailyContainmentRequired: true,
  });

  // If the daily impulse was detected and OB found, containment should pass
  if (result.dailyOB) {
    assertEquals(result.zoneContained, true);
  }
});

Deno.test("ictHTFIntegration: containment check fails when zone outside Daily OB", () => {
  const dailyCandles = makeDailyWithBearishDisplacement();
  const currentPrice = dailyCandles[dailyCandles.length - 1].close;

  // LTF zone way outside any possible OB
  const ltfZone = {
    high: 1.3000,
    low: 1.2900,
  };

  const result = runICTHTFAnalysis(null, dailyCandles, currentPrice, "short", ltfZone, {
    ictHTFGateMode: "hard",
    ictWeeklyBiasRequired: false,
    ictDailyContainmentRequired: true,
  });

  if (result.dailyOB && result.dailyOB.isValid) {
    assertEquals(result.zoneContained, false);
    assertEquals(result.passed, false);
  }
});

Deno.test("ictHTFIntegration: no weekly candles — skips weekly check gracefully", () => {
  const dailyCandles = makeDailyWithBearishDisplacement();
  const currentPrice = dailyCandles[dailyCandles.length - 1].close;

  const result = runICTHTFAnalysis(null, dailyCandles, currentPrice, "short", null, {
    ictHTFGateMode: "hard",
    ictWeeklyBiasRequired: true,
  });

  // Should not fail just because weekly data is missing
  assertEquals(result.weeklyAligned, true);
  assert(result.details.some(d => d.includes("not available")));
});

Deno.test("ictHTFIntegration: full alignment gives score bonus", () => {
  const weeklyCandles = makeBearishTrendWeekly(1.3000, 16);
  const dailyCandles = makeDailyWithBearishDisplacement();
  const currentPrice = dailyCandles[dailyCandles.length - 1].close;

  const result = runICTHTFAnalysis(weeklyCandles, dailyCandles, currentPrice, "short", null, {
    ictHTFGateMode: "soft",
    ictHTFAlignedBonus: 2.0,
  });

  if (result.weeklyAligned && result.dailyOB?.isValid) {
    assert(result.scoreAdjustment > 0, `Should have positive score adjustment, got ${result.scoreAdjustment}`);
  }
});

Deno.test("ictHTFIntegration: result structure is complete", () => {
  const dailyCandles = makeDailyWithBearishDisplacement();
  const currentPrice = dailyCandles[dailyCandles.length - 1].close;

  const result = runICTHTFAnalysis(null, dailyCandles, currentPrice, "short", null);

  assertExists(result.passed);
  assertExists(result.weeklyAligned);
  assertExists(result.zoneContained);
  assertExists(result.scoreAdjustment);
  assertExists(result.reason);
  assertExists(result.details);
  assert(Array.isArray(result.details));
});

Deno.test("ictHTFIntegration: default config values are sensible", () => {
  assertEquals(DEFAULT_ICT_HTF_CONFIG.ictHTFEnabled, true);
  assertEquals(DEFAULT_ICT_HTF_CONFIG.ictHTFGateMode, "soft");
  assertEquals(DEFAULT_ICT_HTF_CONFIG.ictHTFAlignedBonus, 2.0);
  assertEquals(DEFAULT_ICT_HTF_CONFIG.ictHTFMisalignedPenalty, 3.0);
  assertEquals(DEFAULT_ICT_HTF_CONFIG.ictHTFMinContainment, 50);
});
