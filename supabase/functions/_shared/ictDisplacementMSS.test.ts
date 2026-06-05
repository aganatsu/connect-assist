import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  validateMSSDisplacement,
  validateRecentMSS,
  DEFAULT_DISPLACEMENT_MSS_CONFIG,
  type DisplacementMSSConfig,
} from "./ictDisplacementMSS.ts";
import type { Candle } from "./smcAnalysis.ts";

// ─── Test Helpers ─────────────────────────────────────────────────────

function makeCandle(open: number, high: number, low: number, close: number, index = 0): Candle {
  return { open, high, low, close, volume: 1000, datetime: `2024-01-${String(index + 1).padStart(2, "0")}T00:00:00Z` };
}

/**
 * Generate candles with a displacement break at a specific index.
 * Creates normal candles, then large displacement candles at breakIndex.
 */
function makeCandlesWithDisplacement(breakIndex: number, direction: "bullish" | "bearish"): Candle[] {
  const candles: Candle[] = [];
  const basePrice = 1.1000;
  const normalRange = 0.0020; // 20 pips normal

  // Generate normal candles before the break
  for (let i = 0; i < breakIndex; i++) {
    const offset = (Math.sin(i * 0.5) * normalRange);
    const open = basePrice + offset;
    const close = open + (Math.random() - 0.5) * normalRange * 0.5;
    const high = Math.max(open, close) + normalRange * 0.2;
    const low = Math.min(open, close) - normalRange * 0.2;
    candles.push(makeCandle(open, high, low, close, i));
  }

  // Generate displacement candles at the break
  if (direction === "bullish") {
    // Large bullish candles
    for (let j = 0; j < 3; j++) {
      const i = breakIndex + j;
      const open = basePrice + j * 0.0050;
      const close = open + 0.0060; // 60 pip body
      const high = close + 0.0005;
      const low = open - 0.0005;
      candles.push(makeCandle(open, high, low, close, i));
    }
  } else {
    // Large bearish candles
    for (let j = 0; j < 3; j++) {
      const i = breakIndex + j;
      const open = basePrice - j * 0.0050;
      const close = open - 0.0060; // 60 pip body
      const high = open + 0.0005;
      const low = close - 0.0005;
      candles.push(makeCandle(open, high, low, close, i));
    }
  }

  // Add a few more normal candles after
  for (let j = 0; j < 5; j++) {
    const i = breakIndex + 3 + j;
    const lastClose = candles[candles.length - 1].close;
    const open = lastClose + (Math.random() - 0.5) * normalRange * 0.3;
    const close = open + (Math.random() - 0.5) * normalRange * 0.5;
    const high = Math.max(open, close) + normalRange * 0.2;
    const low = Math.min(open, close) - normalRange * 0.2;
    candles.push(makeCandle(open, high, low, close, i));
  }

  return candles;
}

/**
 * Generate candles with a sluggish (non-displacement) break.
 */
function makeCandlesWithSluggishBreak(breakIndex: number): Candle[] {
  const candles: Candle[] = [];
  const basePrice = 1.1000;
  const normalRange = 0.0020;

  for (let i = 0; i < breakIndex + 8; i++) {
    const offset = (Math.sin(i * 0.3) * normalRange * 0.5);
    const open = basePrice + offset;
    const close = open + (Math.random() - 0.5) * normalRange * 0.3; // Small bodies
    const high = Math.max(open, close) + normalRange * 0.4; // Large wicks
    const low = Math.min(open, close) - normalRange * 0.4;
    candles.push(makeCandle(open, high, low, close, i));
  }
  return candles;
}

// ─── Tests ────────────────────────────────────────────────────────────

Deno.test("validateMSSDisplacement: detects strong bullish displacement", () => {
  const candles = makeCandlesWithDisplacement(20, "bullish");
  const result = validateMSSDisplacement(candles, 20, "bullish");

  assertEquals(result.hasDisplacement, true);
  assertEquals(result.displacementStrength === "strong" || result.displacementStrength === "moderate", true);
  assertEquals(result.displacementCandles.length > 0, true);
  assertEquals(result.passed, true);
});

Deno.test("validateMSSDisplacement: detects strong bearish displacement", () => {
  const candles = makeCandlesWithDisplacement(20, "bearish");
  const result = validateMSSDisplacement(candles, 20, "bearish");

  assertEquals(result.hasDisplacement, true);
  assertEquals(result.displacementStrength === "strong" || result.displacementStrength === "moderate", true);
  assertEquals(result.displacementCandles.length > 0, true);
  assertEquals(result.passed, true);
});

Deno.test("validateMSSDisplacement: rejects sluggish break in hard mode", () => {
  const candles = makeCandlesWithSluggishBreak(20);
  const config: DisplacementMSSConfig = { ...DEFAULT_DISPLACEMENT_MSS_CONFIG, gateMode: "hard" };
  const result = validateMSSDisplacement(candles, 20, "bullish", config);

  assertEquals(result.hasDisplacement, false);
  assertEquals(result.displacementStrength, "none");
  assertEquals(result.passed, false);
  assertEquals(result.reason.includes("BLOCKED"), true);
});

Deno.test("validateMSSDisplacement: penalizes sluggish break in soft mode", () => {
  const candles = makeCandlesWithSluggishBreak(20);
  const config: DisplacementMSSConfig = { ...DEFAULT_DISPLACEMENT_MSS_CONFIG, gateMode: "soft" };
  const result = validateMSSDisplacement(candles, 20, "bullish", config);

  assertEquals(result.hasDisplacement, false);
  assertEquals(result.passed, true);
  assertEquals(result.scoreAdjustment, config.noDisplacementPenalty);
});

Deno.test("validateMSSDisplacement: off mode always passes with no score adjustment", () => {
  const candles = makeCandlesWithSluggishBreak(20);
  const config: DisplacementMSSConfig = { ...DEFAULT_DISPLACEMENT_MSS_CONFIG, gateMode: "off" };
  const result = validateMSSDisplacement(candles, 20, "bullish", config);

  assertEquals(result.passed, true);
  assertEquals(result.scoreAdjustment, 0);
  assertEquals(result.reason.includes("[OFF]"), true);
});

Deno.test("validateMSSDisplacement: strong displacement gives bonus", () => {
  const candles = makeCandlesWithDisplacement(20, "bullish");
  const config: DisplacementMSSConfig = { ...DEFAULT_DISPLACEMENT_MSS_CONFIG, gateMode: "soft" };
  const result = validateMSSDisplacement(candles, 20, "bullish", config);

  if (result.displacementStrength === "strong") {
    assertEquals(result.scoreAdjustment, config.strongDisplacementBonus);
  }
  assertEquals(result.passed, true);
});

Deno.test("validateMSSDisplacement: disabled config always passes", () => {
  const candles = makeCandlesWithSluggishBreak(20);
  const config: DisplacementMSSConfig = { ...DEFAULT_DISPLACEMENT_MSS_CONFIG, enabled: false, gateMode: "hard" };
  const result = validateMSSDisplacement(candles, 20, "bullish", config);

  assertEquals(result.passed, true);
  assertEquals(result.isValid, true);
});

Deno.test("validateMSSDisplacement: wrong direction displacement not counted", () => {
  const candles = makeCandlesWithDisplacement(20, "bearish");
  const config: DisplacementMSSConfig = { ...DEFAULT_DISPLACEMENT_MSS_CONFIG, gateMode: "hard" };
  // Looking for bullish displacement but candles are bearish
  const result = validateMSSDisplacement(candles, 20, "bullish", config);

  assertEquals(result.hasDisplacement, false);
  assertEquals(result.passed, false);
});

Deno.test("validateRecentMSS: validates most recent aligned break", () => {
  const candles = makeCandlesWithDisplacement(20, "bullish");
  const breaks = [
    { index: 15, type: "bearish" as const },
    { index: 20, type: "bullish" as const },
  ];
  const result = validateRecentMSS(candles, breaks, "bullish");

  assertEquals(result.hasDisplacement, true);
  assertEquals(result.passed, true);
});

Deno.test("validateRecentMSS: no aligned breaks returns appropriate result", () => {
  const candles = makeCandlesWithDisplacement(20, "bearish");
  const breaks = [{ index: 20, type: "bearish" as const }];
  const config: DisplacementMSSConfig = { ...DEFAULT_DISPLACEMENT_MSS_CONFIG, gateMode: "hard" };
  const result = validateRecentMSS(candles, breaks, "bullish", config);

  assertEquals(result.passed, false);
});
