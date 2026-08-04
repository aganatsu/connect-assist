import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  validateFVG,
  validateFVGBatch,
  toFVGForValidation,
  DEFAULT_FVG_INVALIDATION_CONFIG,
  type FVGInvalidationConfig,
  type FVGForValidation,
} from "./ictFVGInvalidation.ts";
import type { Candle } from "./smcAnalysis.ts";

// ─── Test Helpers ─────────────────────────────────────────────────────

function makeCandle(open: number, high: number, low: number, close: number, index = 0): Candle {
  return { open, high, low, close, volume: 1000, datetime: `2024-01-${String(index + 1).padStart(2, "0")}T00:00:00Z` };
}

function makeBullishFVG(index: number): FVGForValidation {
  return { index, high: 1.1020, low: 1.1000, type: "bullish", midpoint: 1.1010 };
}

function makeBearishFVG(index: number): FVGForValidation {
  return { index, high: 1.1050, low: 1.1030, type: "bearish", midpoint: 1.1040 };
}

/**
 * Generate candles that DON'T invalidate a bullish FVG (price stays above fvg.low).
 */
function makeCandlesNoInvalidation(fvgIndex: number, count: number): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < fvgIndex + 3 + count; i++) {
    // All candles stay above 1.1000 (the bullish FVG low)
    const base = 1.1030 + (Math.sin(i * 0.5) * 0.0010);
    candles.push(makeCandle(base, base + 0.0010, base - 0.0008, base + 0.0005, i));
  }
  return candles;
}

/**
 * Generate candles where body closes below bullish FVG (invalidation).
 */
function makeCandlesWithInvalidation(fvgIndex: number): Candle[] {
  const candles: Candle[] = [];
  // Normal candles before and at FVG
  for (let i = 0; i < fvgIndex + 3 + 5; i++) {
    const base = 1.1030;
    candles.push(makeCandle(base, base + 0.0010, base - 0.0008, base + 0.0005, i));
  }
  // Invalidation candle: body closes below 1.1000 (FVG low)
  const invIdx = fvgIndex + 3 + 5;
  candles.push(makeCandle(1.1010, 1.1015, 1.0980, 1.0990, invIdx)); // close=1.0990 < fvg.low=1.1000
  // A few more after
  for (let i = invIdx + 1; i < invIdx + 3; i++) {
    candles.push(makeCandle(1.0990, 1.1000, 1.0980, 1.0995, i));
  }
  return candles;
}

/**
 * Generate candles where only wick passes through (no body invalidation).
 */
function makeCandlesWickOnly(fvgIndex: number): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < fvgIndex + 3 + 8; i++) {
    const base = 1.1030;
    candles.push(makeCandle(base, base + 0.0010, base - 0.0008, base + 0.0005, i));
  }
  // Wick goes below FVG low but body stays above
  const wickIdx = fvgIndex + 3 + 8;
  candles.push(makeCandle(1.1015, 1.1020, 1.0985, 1.1010, wickIdx)); // low below, but close above
  return candles;
}

/**
 * Generate candles with 2 distinct touches of a bullish FVG.
 */
function makeCandlesTwoTouches(fvgIndex: number): Candle[] {
  const candles: Candle[] = [];
  // Before FVG
  for (let i = 0; i < fvgIndex + 3; i++) {
    candles.push(makeCandle(1.1040, 1.1050, 1.1035, 1.1045, i));
  }
  // After FVG: price above FVG
  for (let i = fvgIndex + 3; i < fvgIndex + 3 + 5; i++) {
    candles.push(makeCandle(1.1040, 1.1050, 1.1035, 1.1045, i));
  }
  // First touch: price dips into FVG zone (below 1.1020)
  candles.push(makeCandle(1.1025, 1.1030, 1.1010, 1.1015, fvgIndex + 8));
  // Bounce back above
  for (let i = fvgIndex + 9; i < fvgIndex + 14; i++) {
    candles.push(makeCandle(1.1040, 1.1050, 1.1035, 1.1045, i));
  }
  // Second touch: price dips into FVG again
  candles.push(makeCandle(1.1025, 1.1030, 1.1010, 1.1015, fvgIndex + 14));
  // After second touch
  for (let i = fvgIndex + 15; i < fvgIndex + 18; i++) {
    candles.push(makeCandle(1.1040, 1.1050, 1.1035, 1.1045, i));
  }
  return candles;
}

// ─── Tests ────────────────────────────────────────────────────────────

Deno.test("validateFVG: fresh FVG with no touches returns fresh status", () => {
  const fvg = makeBullishFVG(5);
  const candles = makeCandlesNoInvalidation(5, 10);
  const result = validateFVG(fvg, candles);

  assertEquals(result.status, "fresh");
  assertEquals(result.touchCount, 0);
  assertEquals(result.invalidatedAtIndex, null);
  assertEquals(result.passed, true);
});

Deno.test("validateFVG: body close through FVG invalidates it", () => {
  const fvg = makeBullishFVG(5);
  const candles = makeCandlesWithInvalidation(5);
  const config: FVGInvalidationConfig = { ...DEFAULT_FVG_INVALIDATION_CONFIG, gateMode: "hard" };
  const result = validateFVG(fvg, candles, config);

  assertEquals(result.status, "invalidated");
  assertEquals(result.invalidatedAtIndex !== null, true);
  assertEquals(result.passed, false);
});

Deno.test("validateFVG: wick through FVG does NOT invalidate (bodyCloseOnly=true)", () => {
  const fvg = makeBullishFVG(5);
  const candles = makeCandlesWickOnly(5);
  const config: FVGInvalidationConfig = { ...DEFAULT_FVG_INVALIDATION_CONFIG, bodyCloseOnly: true, gateMode: "hard" };
  const result = validateFVG(fvg, candles, config);

  assertEquals(result.status !== "invalidated", true);
  assertEquals(result.passed, true);
});

Deno.test("validateFVG: Rule of 2 — two touches marks FVG as exhausted", () => {
  const fvg = makeBullishFVG(5);
  const candles = makeCandlesTwoTouches(5);
  const config: FVGInvalidationConfig = { ...DEFAULT_FVG_INVALIDATION_CONFIG, ruleOfTwo: true, gateMode: "hard" };
  const result = validateFVG(fvg, candles, config);

  assertEquals(result.touchCount >= 2, true);
  assertEquals(result.status, "exhausted");
  assertEquals(result.passed, false);
});

Deno.test("validateFVG: Rule of 2 disabled — two touches still valid", () => {
  const fvg = makeBullishFVG(5);
  const candles = makeCandlesTwoTouches(5);
  const config: FVGInvalidationConfig = { ...DEFAULT_FVG_INVALIDATION_CONFIG, ruleOfTwo: false, gateMode: "hard" };
  const result = validateFVG(fvg, candles, config);

  assertEquals(result.status !== "exhausted", true);
  assertEquals(result.passed, true);
});

Deno.test("validateFVG: soft mode penalizes invalidated FVG", () => {
  const fvg = makeBullishFVG(5);
  const candles = makeCandlesWithInvalidation(5);
  const config: FVGInvalidationConfig = { ...DEFAULT_FVG_INVALIDATION_CONFIG, gateMode: "soft" };
  const result = validateFVG(fvg, candles, config);

  assertEquals(result.status, "invalidated");
  assertEquals(result.passed, true);
  assertEquals(result.scoreAdjustment, config.invalidatedPenalty);
});

Deno.test("validateFVG: off mode always passes with no score adjustment", () => {
  const fvg = makeBullishFVG(5);
  const candles = makeCandlesWithInvalidation(5);
  const config: FVGInvalidationConfig = { ...DEFAULT_FVG_INVALIDATION_CONFIG, gateMode: "off" };
  const result = validateFVG(fvg, candles, config);

  assertEquals(result.passed, true);
  assertEquals(result.scoreAdjustment, 0);
  assertEquals(result.reason.includes("[OFF]"), true);
});

Deno.test("validateFVG: disabled config always passes", () => {
  const fvg = makeBullishFVG(5);
  const candles = makeCandlesWithInvalidation(5);
  const config: FVGInvalidationConfig = { ...DEFAULT_FVG_INVALIDATION_CONFIG, enabled: false, gateMode: "hard" };
  const result = validateFVG(fvg, candles, config);

  assertEquals(result.passed, true);
});

Deno.test("validateFVGBatch: picks best FVG from multiple", () => {
  const fvgs = [makeBullishFVG(3), makeBullishFVG(8)];
  const candles = makeCandlesNoInvalidation(3, 20);
  const result = validateFVGBatch(fvgs, candles, "bullish");

  assertEquals(result.bestFVG !== null, true);
  assertEquals(result.passed, true);
  // Should prefer the more recent FVG
  if (result.bestFVG) {
    assertEquals(result.bestFVG.fvg.index, 8);
  }
});

Deno.test("validateFVGBatch: filters out invalidated FVGs", () => {
  const fvgs = [makeBullishFVG(5)];
  const candles = makeCandlesWithInvalidation(5);
  const config: FVGInvalidationConfig = { ...DEFAULT_FVG_INVALIDATION_CONFIG, gateMode: "hard" };
  const result = validateFVGBatch(fvgs, candles, "bullish", config);

  assertEquals(result.bestFVG, null);
  assertEquals(result.passed, false);
});

Deno.test("validateFVGBatch: empty FVG array passes", () => {
  const candles = makeCandlesNoInvalidation(5, 10);
  const result = validateFVGBatch([], candles, "bullish");

  assertEquals(result.passed, true);
  assertEquals(result.bestFVG, null);
});

Deno.test("toFVGForValidation: converts existing FVG format", () => {
  const fvg = toFVGForValidation({ index: 10, high: 1.1050, low: 1.1030, type: "bearish" });

  assertEquals(fvg.midpoint, 1.1040);
  assertEquals(fvg.type, "bearish");
  assertEquals(fvg.index, 10);
});
