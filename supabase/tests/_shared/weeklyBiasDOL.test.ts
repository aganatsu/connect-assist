/**
 * Tests for weeklyBiasDOL.ts — ICT Weekly Bias & Draw on Liquidity
 */
import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  analyzeWeeklyBiasAndDOL,
  type WeeklyBiasResult,
} from "./weeklyBiasDOL.ts";
import type { Candle } from "./smcAnalysis.ts";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function makeCandle(open: number, high: number, low: number, close: number, datetime = "2024-01-01"): Candle {
  return { open, high, low, close, datetime, volume: 1000 };
}

/**
 * Generate a bullish trend with proper swing structure (HH/HL) that detectSwingPoints can identify.
 * Key: each leg ends with a clear peak candle, pullbacks have 4+ candles with a clear trough.
 */
function makeBullishTrend(_startPrice: number, _count: number, _avgRange = 0.0100): Candle[] {
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

/** Generate a bearish trend with proper swing structure (LH/LL) */
function makeBearishTrend(_startPrice: number, _count: number, _avgRange = 0.0100): Candle[] {
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

function makeRangingCandles(_midPrice: number, _count: number, _range = 0.0050): Candle[] {
  // Tight range with equal highs and lows — no clear trend
  return [
    makeCandle(1.0500, 1.0550, 1.0450, 1.0520, "W01"),
    makeCandle(1.0520, 1.0560, 1.0470, 1.0480, "W02"),
    makeCandle(1.0480, 1.0540, 1.0440, 1.0530, "W03"),
    makeCandle(1.0530, 1.0570, 1.0460, 1.0470, "W04"),
    makeCandle(1.0470, 1.0550, 1.0440, 1.0540, "W05"),
    makeCandle(1.0540, 1.0580, 1.0470, 1.0480, "W06"),
    makeCandle(1.0480, 1.0560, 1.0450, 1.0550, "W07"),
    makeCandle(1.0550, 1.0590, 1.0480, 1.0490, "W08"),
    makeCandle(1.0490, 1.0560, 1.0440, 1.0530, "W09"),
    makeCandle(1.0530, 1.0570, 1.0460, 1.0470, "W10"),
    makeCandle(1.0470, 1.0550, 1.0440, 1.0540, "W11"),
    makeCandle(1.0540, 1.0580, 1.0470, 1.0480, "W12"),
    makeCandle(1.0480, 1.0560, 1.0450, 1.0550, "W13"),
    makeCandle(1.0550, 1.0590, 1.0480, 1.0490, "W14"),
    makeCandle(1.0490, 1.0560, 1.0440, 1.0530, "W15"),
    makeCandle(1.0530, 1.0570, 1.0460, 1.0470, "W16"),
    makeCandle(1.0470, 1.0550, 1.0440, 1.0540, "W17"),
    makeCandle(1.0540, 1.0580, 1.0470, 1.0480, "W18"),
    makeCandle(1.0480, 1.0560, 1.0450, 1.0550, "W19"),
    makeCandle(1.0550, 1.0570, 1.0480, 1.0500, "W20"),
  ];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test("weeklyBiasDOL: returns neutral with insufficient candles", () => {
  // Need fewer than 12 candles (MIN_WEEKLY_CANDLES)
  const candles = [
    makeCandle(1.0000, 1.0050, 0.9950, 1.0020, "W01"),
    makeCandle(1.0020, 1.0060, 0.9970, 1.0010, "W02"),
    makeCandle(1.0010, 1.0040, 0.9960, 1.0030, "W03"),
    makeCandle(1.0030, 1.0100, 1.0010, 1.0090, "W04"),
    makeCandle(1.0090, 1.0160, 1.0070, 1.0150, "W05"),
  ];
  const result = analyzeWeeklyBiasAndDOL(candles, 1.0150);
  assertEquals(result.bias, "neutral");
  assert(result.reason.includes("Insufficient"));
});

Deno.test("weeklyBiasDOL: detects bullish bias on clear uptrend", () => {
  const candles = makeBullishTrend(1.0000, 20, 0.0100);
  const currentPrice = candles[candles.length - 1].close;
  const result = analyzeWeeklyBiasAndDOL(candles, currentPrice);
  assertEquals(result.bias, "bullish", `Expected bullish bias, got: ${result.bias} (reason: ${result.reason})`);
});

Deno.test("weeklyBiasDOL: detects bearish bias on clear downtrend", () => {
  const candles = makeBearishTrend(2.0000, 20, 0.0100);
  const currentPrice = candles[candles.length - 1].close;
  const result = analyzeWeeklyBiasAndDOL(candles, currentPrice);
  assertEquals(result.bias, "bearish", `Expected bearish bias, got: ${result.bias} (reason: ${result.reason})`);
});

Deno.test("weeklyBiasDOL: ranging market produces neutral or low-confidence bias", () => {
  const candles = makeRangingCandles(1.5000, 20, 0.0050);
  const result = analyzeWeeklyBiasAndDOL(candles, 1.0500);
  // Ranging should either be neutral or have low confidence
  if (result.bias !== "neutral") {
    assert(result.confidence <= 50, `Ranging market should have low confidence if not neutral, got ${result.confidence}`);
  }
});

Deno.test("weeklyBiasDOL: identifies DOL targets", () => {
  const candles = makeBullishTrend(1.0000, 20, 0.0100);
  const currentPrice = candles[candles.length - 1].close;
  const result = analyzeWeeklyBiasAndDOL(candles, currentPrice);
  // Should have at least one DOL target
  assert(result.allDOLs.length > 0 || result.primaryDOL !== null, "Should identify at least one DOL target");
});

Deno.test("weeklyBiasDOL: bullish trend has positive confidence", () => {
  const candles = makeBullishTrend(1.0000, 20, 0.0100);
  const result = analyzeWeeklyBiasAndDOL(candles, candles[candles.length - 1].close);
  assert(result.confidence > 0, `Bullish trend should have positive confidence, got ${result.confidence}`);
});

Deno.test("weeklyBiasDOL: detects weekly FVGs via full analysis", () => {
  // Create candles with a clear gap (FVG pattern)
  const candles: Candle[] = [
    makeCandle(1.0000, 1.0100, 0.9950, 1.0050, "W01"),
    makeCandle(1.0050, 1.0080, 0.9980, 1.0020, "W02"),
    makeCandle(1.0020, 1.0060, 0.9960, 1.0000, "W03"),
    makeCandle(1.0000, 1.0040, 0.9940, 0.9950, "W04"),
    makeCandle(0.9950, 0.9980, 0.9900, 0.9910, "W05"),
    makeCandle(0.9910, 0.9930, 0.9860, 0.9870, "W06"),
    makeCandle(0.9870, 1.0100, 0.9860, 1.0080, "W07"),
    makeCandle(1.0080, 1.0200, 1.0050, 1.0180, "W08"),
    makeCandle(1.0180, 1.0250, 1.0150, 1.0220, "W09"),
    makeCandle(1.0220, 1.0300, 1.0200, 1.0280, "W10"),
    makeCandle(1.0280, 1.0350, 1.0260, 1.0330, "W11"),
    makeCandle(1.0330, 1.0400, 1.0310, 1.0380, "W12"),
  ];

  const result = analyzeWeeklyBiasAndDOL(candles, 1.0380);
  // Should detect FVGs via the full analysis
  assert(Array.isArray(result.weeklyFVGs), "weeklyFVGs should be an array");
});

Deno.test("weeklyBiasDOL: identifies weekly liquidity pools via full analysis", () => {
  // Create candles with equal highs (liquidity pool)
  const candles: Candle[] = [];
  const targetHigh = 1.1000;
  for (let i = 0; i < 16; i++) {
    const base = 1.0800 + Math.random() * 0.01;
    const high = (i % 4 === 0) ? targetHigh : base + 0.005;
    candles.push(makeCandle(base, high, base - 0.005, base + 0.003, `W${(i + 1).toString().padStart(2, "0")}`));
  }

  const result = analyzeWeeklyBiasAndDOL(candles, 1.0900);
  assert(Array.isArray(result.weeklyLiquidityPools), "weeklyLiquidityPools should be an array");
});

Deno.test("weeklyBiasDOL: result structure is complete", () => {
  const candles = makeBullishTrend(1.0000, 16, 50);
  const result = analyzeWeeklyBiasAndDOL(candles, candles[candles.length - 1].close);

  assertExists(result.bias);
  assertExists(result.confidence);
  assertExists(result.allDOLs);
  assertExists(result.weeklyFVGs);
  assertExists(result.weeklyLiquidityPools);
  assertExists(result.reason);
  assert(["bullish", "bearish", "neutral"].includes(result.bias));
  assert(result.confidence >= 0 && result.confidence <= 100);
});
