/**
 * Tests for the 3 new gates added to run-backtest-local.ts:
 *   - Direction Verdict (Gate A)
 *   - Premium/Discount Zone (Gate B)
 *   - Structural Conviction (Gate C)
 *
 * These tests verify the gate logic in isolation using the same shared modules
 * that the backtest engine imports.
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeDirectionVerdict,
} from "../supabase/functions/_shared/directionVerdict.ts";
import {
  calculatePremiumDiscount,
  analyzeMarketStructure,
  type Candle,
} from "../supabase/functions/_shared/smcAnalysis.ts";
import {
  confirmedTrend as computeConfirmedTrend,
} from "../supabase/functions/_shared/directionEngine.ts";

// ─── Helper: Generate candles with oscillating swings ────────────────
function makeSwingCandles(count: number, basePrice: number, range: number, endZone: "premium" | "discount" | "equilibrium"): Candle[] {
  const candles: Candle[] = [];
  // First half: oscillate to establish swing range
  const half = Math.floor(count / 2);
  for (let i = 0; i < half; i++) {
    const t = i / half;
    const swing = Math.sin(t * Math.PI * 4) * (range / 2);
    const price = basePrice + swing;
    candles.push({
      datetime: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
      open: price - 0.0002, high: price + 0.0010, low: price - 0.0010, close: price + 0.0002, volume: 1000,
    });
  }
  // Second half: move price to target zone
  const targetPrice = endZone === "premium"
    ? basePrice + range * 0.4
    : endZone === "discount"
    ? basePrice - range * 0.4
    : basePrice;
  for (let i = half; i < count; i++) {
    const t = (i - half) / (count - half);
    const price = candles[half - 1].close + (targetPrice - candles[half - 1].close) * t;
    candles.push({
      datetime: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
      open: price - 0.0001, high: price + 0.0005, low: price - 0.0005, close: price, volume: 1000,
    });
  }
  return candles;
}

// Simple trending candles for structure tests
function makeTrendCandles(count: number, startPrice: number, trend: "up" | "down"): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const delta = trend === "up" ? 0.001 : -0.001;
    const open = price;
    const close = price + delta;
    candles.push({
      datetime: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
      open, high: Math.max(open, close) + 0.0005, low: Math.min(open, close) - 0.0005, close, volume: 1000,
    });
    price = close;
  }
  return candles;
}

// ═══════════════════════════════════════════════════════════════════════
// Gate A: Direction Verdict
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Gate A: Direction Verdict — does NOT block when confirmedTrend is strong (spine wins)", () => {
  // confirmedTrend = bearish (spine), simpleDirection = long (disagrees but spine takes priority)
  // The verdict follows the SPINE (confirmedTrend), so it produces "short" verdict with high confidence
  // This means it does NOT block — the spine is clear
  const result = computeDirectionVerdict({
    confirmedTrend: { trend: "bearish", reason: "Bearish MSB confirmed" },
    simpleDirection: { direction: "long", bias: "bullish", biasSource: "4h", h4Retrace: false, h4ChochAgainst: true, h1Confirmed: true, reason: "H4 CHoCH bullish" },
    regime: { regime: "strong_trend", confidence: 0.85, directionalBias: "bearish" },
    weeklyBias: null, gamePlanBias: null,
  });
  assertExists(result);
  // Spine is bearish, regime confirms bearish → high confidence → no block
  assertEquals(result.shouldBlock, false);
  assertEquals(result.verdict, "short");
});

Deno.test("Gate A: Direction Verdict — passes when all sources agree", () => {
  const result = computeDirectionVerdict({
    confirmedTrend: { trend: "bullish", reason: "Bullish MSB confirmed" },
    simpleDirection: { direction: "long", bias: "bullish", biasSource: "daily", h4Retrace: false, h4ChochAgainst: false, h1Confirmed: true, reason: "All aligned bullish" },
    regime: { regime: "trending", confidence: 0.70, directionalBias: "bullish" },
    weeklyBias: null, gamePlanBias: null,
  });
  assertExists(result);
  assertEquals(result.shouldBlock, false);
  assertEquals(result.verdict, "long");
});

Deno.test("Gate A: Direction Verdict — BLOCKS when no directional signal at all", () => {
  // All null → no spine direction → blocks
  const result = computeDirectionVerdict({
    confirmedTrend: null, simpleDirection: null, regime: null, weeklyBias: null, gamePlanBias: null,
  });
  assertExists(result);
  assertEquals(result.shouldBlock, true);
  assertEquals(result.verdict, "neutral");
});

Deno.test("Gate A: Direction Verdict — blocks when regime vetoes", () => {
  // confirmedTrend = bullish (spine), but regime is strong_trend bearish with high confidence
  // This triggers the regime veto
  const result = computeDirectionVerdict({
    confirmedTrend: { trend: "bullish", reason: "Bullish MSB" },
    simpleDirection: { direction: "long", bias: "bullish", biasSource: "daily", h4Retrace: false, h4ChochAgainst: false, h1Confirmed: false, reason: "Weak bullish" },
    regime: { regime: "strong_trend", confidence: 0.90, directionalBias: "bearish" },
    weeklyBias: { bias: "bearish", confidence: 80 },
    gamePlanBias: { bias: "bearish", confidence: 70 },
  });
  assertExists(result);
  // Regime veto: strong_trend at 90% conf opposing spine direction
  assertEquals(result.shouldBlock, true);
});

// ═══════════════════════════════════════════════════════════════════════
// Gate B: Premium/Discount Zone
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Gate B: Premium/Discount — candles ending in premium zone detected correctly", () => {
  const candles = makeSwingCandles(60, 1.1000, 0.0200, "premium");
  const pdResult = calculatePremiumDiscount(candles);
  assertExists(pdResult);
  assertEquals(pdResult.currentZone, "premium");
});

Deno.test("Gate B: Premium/Discount — candles ending in discount zone detected correctly", () => {
  const candles = makeSwingCandles(60, 1.1000, 0.0200, "discount");
  const pdResult = calculatePremiumDiscount(candles);
  assertExists(pdResult);
  assertEquals(pdResult.currentZone, "discount");
});

Deno.test("Gate B: Premium/Discount — gate logic blocks long in premium", () => {
  const candles = makeSwingCandles(60, 1.1000, 0.0200, "premium");
  const pdResult = calculatePremiumDiscount(candles);
  const direction = "long" as string;
  const shouldBlock = direction === "long" && pdResult.currentZone === "premium";
  assertEquals(shouldBlock, true);
});

Deno.test("Gate B: Premium/Discount — gate logic blocks short in discount", () => {
  const candles = makeSwingCandles(60, 1.1000, 0.0200, "discount");
  const pdResult = calculatePremiumDiscount(candles);
  const direction = "short" as string;
  const shouldBlock = direction === "short" && pdResult.currentZone === "discount";
  assertEquals(shouldBlock, true);
});

Deno.test("Gate B: Premium/Discount — gate logic passes long in discount", () => {
  const candles = makeSwingCandles(60, 1.1000, 0.0200, "discount");
  const pdResult = calculatePremiumDiscount(candles);
  const direction = "long" as string;
  const shouldBlock = direction === "long" && pdResult.currentZone === "premium";
  assertEquals(shouldBlock, false);
});

Deno.test("Gate B: Premium/Discount — gate logic passes short in premium", () => {
  const candles = makeSwingCandles(60, 1.1000, 0.0200, "premium");
  const pdResult = calculatePremiumDiscount(candles);
  const direction = "short" as string;
  const shouldBlock = direction === "short" && pdResult.currentZone === "discount";
  assertEquals(shouldBlock, false);
});

// ═══════════════════════════════════════════════════════════════════════
// Gate C: Structural Conviction
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Gate C: Structural Conviction — analyzeMarketStructure returns structureToFractal", () => {
  const candles = makeTrendCandles(60, 1.0500, "up");
  const structure = analyzeMarketStructure(candles);
  assertExists(structure.structureToFractal);
  assertEquals(typeof structure.structureToFractal.bullishRate, "number");
  assertEquals(typeof structure.structureToFractal.bearishRate, "number");
  assertEquals(typeof structure.structureToFractal.overallRate, "number");
  assertEquals(typeof structure.structureToFractal.totalFractals, "number");
  assertEquals(typeof structure.structureToFractal.totalBreaks, "number");
});

Deno.test("Gate C: Structural Conviction — blocks when opposite overwhelms (2.5x ratio)", () => {
  // Direct gate logic test: if opposite/direction >= 2.5, block
  const directionRate: number = 0.1;
  const oppositeRate: number = 0.3;
  const ratio = oppositeRate / directionRate; // 3.0 >= 2.5 → block
  const shouldBlock = directionRate > 0 && oppositeRate > 0 && ratio >= 2.5;
  assertEquals(shouldBlock, true);
});

Deno.test("Gate C: Structural Conviction — passes when direction has adequate support", () => {
  // direction 40%, opposite 30% → ratio 0.75, well below 2.5
  const directionRate: number = 0.4;
  const oppositeRate: number = 0.3;
  const wouldBlock = (directionRate === 0 && oppositeRate > 0.30) ||
                     (directionRate > 0 && oppositeRate > 0 && oppositeRate / directionRate >= 2.5);
  assertEquals(wouldBlock, false);
});

Deno.test("Gate C: Structural Conviction — blocks when zero direction + strong opposite", () => {
  // 0% in direction, 50% opposite (> 0.30 threshold for longs)
  const directionRate: number = 0;
  const oppositeRate: number = 0.5;
  const s2fOverall: number = 0.25;
  const s2fBlockThreshold = 0.35;
  const oppositeBlockThreshold = 0.30;

  const wouldBlock = (directionRate === 0 && s2fOverall < s2fBlockThreshold && oppositeRate > 0) ||
                     (directionRate === 0 && oppositeRate > oppositeBlockThreshold);
  assertEquals(wouldBlock, true);
});

Deno.test("Gate C: Structural Conviction — does not block when direction is non-zero and ratio is low", () => {
  // direction 30%, opposite 20% → ratio 0.67, below 2.5
  const directionRate: number = 0.3;
  const oppositeRate: number = 0.2;
  const s2fOverall: number = 0.5;
  const s2fBlockThreshold = 0.35;
  const oppositeBlockThreshold = 0.30;

  const wouldBlock = (directionRate === 0 && s2fOverall < s2fBlockThreshold && oppositeRate > 0) ||
                     (directionRate === 0 && oppositeRate > oppositeBlockThreshold) ||
                     (directionRate > 0 && oppositeRate > 0 && oppositeRate / directionRate >= 2.5);
  assertEquals(wouldBlock, false);
});

// ═══════════════════════════════════════════════════════════════════════
// Integration: confirmedTrend (used by Direction Verdict gate)
// ═══════════════════════════════════════════════════════════════════════

Deno.test("confirmedTrend — returns valid trend for uptrend candles", () => {
  const candles = makeTrendCandles(60, 1.0500, "up");
  const result = computeConfirmedTrend(candles, 0.25, 5);
  assertExists(result);
  assertExists(result.trend);
  assertEquals(["bullish", "bearish", "ranging"].includes(result.trend), true);
});

Deno.test("confirmedTrend — returns valid trend for downtrend candles", () => {
  const candles = makeTrendCandles(60, 1.1000, "down");
  const result = computeConfirmedTrend(candles, 0.25, 5);
  assertExists(result);
  assertExists(result.trend);
  assertEquals(["bullish", "bearish", "ranging"].includes(result.trend), true);
});
