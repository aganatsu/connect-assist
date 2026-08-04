/**
 * exitEngine.test.ts — Unit tests for regime-adaptive TP and momentum-fade trailing
 */
import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { adjustTPForRegime, computeAdaptiveTrail, type RegimeInfo } from "./exitEngine.ts";

// ─── Helpers ────────────────────────────────────────────────────────

function makeRegime(regime: string, confidence = 0.8): RegimeInfo {
  return {
    regime,
    confidence,
    atrTrend: "stable",
    bias: "bullish",
  };
}

/** Build candles with specified body/range characteristics */
function buildCandles(
  count: number,
  bodyRatio: number,
  direction: "up" | "down" | "mixed",
): Array<{ open: number; high: number; low: number; close: number }> {
  const candles = [];
  for (let i = 0; i < count; i++) {
    const base = 1.1 + i * 0.001;
    const range = 0.005;
    const body = range * bodyRatio;
    const isUp = direction === "mixed" ? i % 2 === 0 : direction === "up";
    candles.push({
      open: isUp ? base : base + body,
      high: base + range,
      low: base,
      close: isUp ? base + body : base,
    });
  }
  return candles;
}

// ═══════════════════════════════════════════════════════════════════
// adjustTPForRegime
// ═══════════════════════════════════════════════════════════════════

Deno.test("adjustTPForRegime — trending regime extends TP", () => {
  const result = adjustTPForRegime({
    currentTP: 1.12,
    entryPrice: 1.10,
    stopLoss: 1.09,
    direction: "long",
    regimeInfo: makeRegime("trending"),
    atrValue: 0.005,
    trendingRRMultiplier: 1.5,
  });
  // Original R:R = (1.12 - 1.10) / (1.10 - 1.09) = 2.0
  // Trending multiplier 1.5 → adjusted R:R = 3.0
  // New TP = 1.10 + 3.0 * 0.01 = 1.13
  assertEquals(result.originalRR, 2.0);
  assertEquals(result.adjustedRR, 3.0);
  assertAlmostEquals(result.adjustedTP, 1.13, 1e-10);
  assertEquals(result.regime, "trending");
  assertEquals(result.reason.includes("extended"), true);
});

Deno.test("adjustTPForRegime — ranging regime tightens TP", () => {
  const result = adjustTPForRegime({
    currentTP: 1.12,
    entryPrice: 1.10,
    stopLoss: 1.09,
    direction: "long",
    regimeInfo: makeRegime("ranging"),
    atrValue: 0.005,
    rangingRRMultiplier: 0.75,
  });
  // Original R:R = 2.0, ranging × 0.75 = 1.5
  assertEquals(result.adjustedRR, 1.5);
  assertAlmostEquals(result.adjustedTP, 1.115, 1e-10);
  assertEquals(result.reason.includes("tightened"), true);
});

Deno.test("adjustTPForRegime — strong_trend uses trending multiplier", () => {
  const result = adjustTPForRegime({
    currentTP: 1.12,
    entryPrice: 1.10,
    stopLoss: 1.09,
    direction: "long",
    regimeInfo: makeRegime("strong_trend"),
    atrValue: 0.005,
    trendingRRMultiplier: 1.5,
  });
  assertEquals(result.adjustedRR, 3.0);
  assertEquals(result.regime, "strong_trend");
});

Deno.test("adjustTPForRegime — choppy uses ranging multiplier", () => {
  const result = adjustTPForRegime({
    currentTP: 1.12,
    entryPrice: 1.10,
    stopLoss: 1.09,
    direction: "long",
    regimeInfo: makeRegime("choppy"),
    atrValue: 0.005,
    rangingRRMultiplier: 0.75,
  });
  assertEquals(result.adjustedRR, 1.5);
});

Deno.test("adjustTPForRegime — transitional regime leaves TP unchanged", () => {
  const result = adjustTPForRegime({
    currentTP: 1.12,
    entryPrice: 1.10,
    stopLoss: 1.09,
    direction: "long",
    regimeInfo: makeRegime("transitional"),
    atrValue: 0.005,
  });
  assertEquals(result.adjustedTP, 1.12);
  assertEquals(result.adjustedRR, 2.0);
  assertEquals(result.reason.includes("unchanged"), true);
});

Deno.test("adjustTPForRegime — low confidence leaves TP unchanged", () => {
  const result = adjustTPForRegime({
    currentTP: 1.12,
    entryPrice: 1.10,
    stopLoss: 1.09,
    direction: "long",
    regimeInfo: makeRegime("trending", 0.3),
    atrValue: 0.005,
  });
  assertEquals(result.adjustedTP, 1.12);
  assertEquals(result.reason.includes("too low"), true);
});

Deno.test("adjustTPForRegime — null regime leaves TP unchanged", () => {
  const result = adjustTPForRegime({
    currentTP: 1.12,
    entryPrice: 1.10,
    stopLoss: 1.09,
    direction: "long",
    regimeInfo: null,
    atrValue: 0.005,
  });
  assertEquals(result.adjustedTP, 1.12);
});

Deno.test("adjustTPForRegime — zero SL distance returns unchanged", () => {
  const result = adjustTPForRegime({
    currentTP: 1.12,
    entryPrice: 1.10,
    stopLoss: 1.10, // same as entry
    direction: "long",
    regimeInfo: makeRegime("trending"),
    atrValue: 0.005,
  });
  assertEquals(result.adjustedTP, 1.12);
  assertEquals(result.reason.includes("zero"), true);
});

Deno.test("adjustTPForRegime — R:R capped at maxRR and ATR sanity", () => {
  // Case 1: ATR cap kicks in before maxRR
  // Original R:R = 4.0, trending × 1.5 = 6.0
  // But ATR sanity cap = 6 × 0.005 = 0.03, SL distance = 0.01 → effective R:R = 3.0
  const result1 = adjustTPForRegime({
    currentTP: 1.14,  // R:R = 4.0
    entryPrice: 1.10,
    stopLoss: 1.09,
    direction: "long",
    regimeInfo: makeRegime("trending"),
    atrValue: 0.005,
    trendingRRMultiplier: 1.5,
    maxRR: 4.0,
  });
  assertEquals(result1.adjustedRR, 3.0); // ATR cap limits to 3.0
  assertEquals(result1.adjustedRR <= 4.0, true);

  // Case 2: maxRR cap kicks in (large ATR so ATR cap is not binding)
  const result2 = adjustTPForRegime({
    currentTP: 1.14,  // R:R = 4.0
    entryPrice: 1.10,
    stopLoss: 1.09,
    direction: "long",
    regimeInfo: makeRegime("trending"),
    atrValue: 0.1, // large ATR so ATR cap doesn't bind
    trendingRRMultiplier: 1.5, // 4.0 × 1.5 = 6.0 → capped at maxRR 4.0
    maxRR: 4.0,
  });
  assertEquals(result2.adjustedRR, 4.0); // maxRR cap
});

Deno.test("adjustTPForRegime — R:R floored at minRR", () => {
  const result = adjustTPForRegime({
    currentTP: 1.105,  // R:R = 0.5
    entryPrice: 1.10,
    stopLoss: 1.09,
    direction: "long",
    regimeInfo: makeRegime("ranging"),
    atrValue: 0.005,
    rangingRRMultiplier: 0.75, // 0.5 × 0.75 = 0.375 → floored at 1.0
    minRR: 1.0,
  });
  assertEquals(result.adjustedRR, 1.0);
});

Deno.test("adjustTPForRegime — short direction works correctly", () => {
  const result = adjustTPForRegime({
    currentTP: 1.08,
    entryPrice: 1.10,
    stopLoss: 1.11,
    direction: "short",
    regimeInfo: makeRegime("trending"),
    atrValue: 0.005,
    trendingRRMultiplier: 1.5,
  });
  // Original R:R = (1.10 - 1.08) / (1.11 - 1.10) = 2.0
  // Trending × 1.5 = 3.0 → TP = 1.10 - 3.0 * 0.01 = 1.07
  assertEquals(result.adjustedRR, 3.0);
  assertEquals(result.adjustedTP, 1.07);
});

// ═══════════════════════════════════════════════════════════════════
// computeAdaptiveTrail
// ═══════════════════════════════════════════════════════════════════

Deno.test("computeAdaptiveTrail — strong momentum widens trail", () => {
  const strongCandles = buildCandles(5, 0.8, "up"); // big bodies, all up
  const result = computeAdaptiveTrail({
    entryPrice: 1.10,
    currentPrice: 1.12,
    currentSL: 1.09,
    direction: "long",
    rMultiple: 2.0,
    regimeInfo: null,
    atrValue: 0.005,
    pipSize: 0.0001,
    recentCandles: strongCandles,
    baseTrailATRMultiple: 1.5,
    widenFactor: 1.3,
  });
  assertEquals(result.momentumState, "strong");
  // Base = 0.005 * 1.5 = 0.0075, × 1.3 = 0.00975
  // R-scale at 2R: max(0.7, 1.0 - 0.1) = 0.9 → 0.00975 * 0.9 = 0.008775
  // Floor check: 0.008775 > 0.0025 (0.5 × ATR) ✓
  assertEquals(result.trailDistance > 0.007, true);
  assertEquals(result.reason.includes("strong"), true);
});

Deno.test("computeAdaptiveTrail — fading momentum tightens trail", () => {
  const fadingCandles = buildCandles(5, 0.15, "mixed"); // tiny bodies, mixed
  const result = computeAdaptiveTrail({
    entryPrice: 1.10,
    currentPrice: 1.12,
    currentSL: 1.09,
    direction: "long",
    rMultiple: 1.5,
    regimeInfo: null,
    atrValue: 0.005,
    pipSize: 0.0001,
    recentCandles: fadingCandles,
    baseTrailATRMultiple: 1.5,
    tightenFactor: 0.6,
  });
  assertEquals(result.momentumState, "fading");
  // Base = 0.0075, × 0.6 = 0.0045
  assertEquals(result.trailDistance < 0.006, true);
  assertEquals(result.reason.includes("fading"), true);
});

Deno.test("computeAdaptiveTrail — neutral momentum uses base trail", () => {
  // 3 candles with moderate bodies
  const neutralCandles = buildCandles(5, 0.5, "up");
  const result = computeAdaptiveTrail({
    entryPrice: 1.10,
    currentPrice: 1.12,
    currentSL: 1.09,
    direction: "long",
    rMultiple: 1.0,
    regimeInfo: null,
    atrValue: 0.005,
    pipSize: 0.0001,
    recentCandles: neutralCandles,
    baseTrailATRMultiple: 1.5,
  });
  assertEquals(result.momentumState, "neutral");
  assertEquals(result.reason.includes("neutral"), true);
});

Deno.test("computeAdaptiveTrail — trending regime widens trail by 10%", () => {
  const result = computeAdaptiveTrail({
    entryPrice: 1.10,
    currentPrice: 1.12,
    currentSL: 1.09,
    direction: "long",
    rMultiple: 1.0,
    regimeInfo: makeRegime("trending"),
    atrValue: 0.005,
    pipSize: 0.0001,
    recentCandles: [], // neutral momentum
    baseTrailATRMultiple: 1.5,
  });
  assertEquals(result.reason.includes("+10%"), true);
});

Deno.test("computeAdaptiveTrail — ranging regime tightens trail by 15%", () => {
  const result = computeAdaptiveTrail({
    entryPrice: 1.10,
    currentPrice: 1.12,
    currentSL: 1.09,
    direction: "long",
    rMultiple: 1.0,
    regimeInfo: makeRegime("ranging"),
    atrValue: 0.005,
    pipSize: 0.0001,
    recentCandles: [],
    baseTrailATRMultiple: 1.5,
  });
  assertEquals(result.reason.includes("-15%"), true);
});

Deno.test("computeAdaptiveTrail — shouldTighten is true when new SL is better for long", () => {
  const result = computeAdaptiveTrail({
    entryPrice: 1.10,
    currentPrice: 1.12,
    currentSL: 1.095, // current SL is far from price
    direction: "long",
    rMultiple: 2.0,
    regimeInfo: null,
    atrValue: 0.005,
    pipSize: 0.0001,
    recentCandles: [],
    baseTrailATRMultiple: 1.5,
  });
  // New SL should be closer to 1.12 than 1.095
  assertEquals(result.shouldTighten, true);
  assertEquals(result.newSL > 1.095, true);
});

Deno.test("computeAdaptiveTrail — shouldTighten is false when current SL is already tight", () => {
  const result = computeAdaptiveTrail({
    entryPrice: 1.10,
    currentPrice: 1.12,
    currentSL: 1.119, // already very tight
    direction: "long",
    rMultiple: 2.0,
    regimeInfo: null,
    atrValue: 0.005,
    pipSize: 0.0001,
    recentCandles: [],
    baseTrailATRMultiple: 1.5,
  });
  assertEquals(result.shouldTighten, false);
});

Deno.test("computeAdaptiveTrail — short direction works correctly", () => {
  const result = computeAdaptiveTrail({
    entryPrice: 1.10,
    currentPrice: 1.08,
    currentSL: 1.105,
    direction: "short",
    rMultiple: 2.0,
    regimeInfo: null,
    atrValue: 0.005,
    pipSize: 0.0001,
    recentCandles: [],
    baseTrailATRMultiple: 1.5,
  });
  // New SL should be above 1.08 (trail above price for short)
  assertEquals(result.newSL > 1.08, true);
  // Should tighten if new SL is lower (better for short) than 1.105
  assertEquals(result.shouldTighten, true);
});

Deno.test("computeAdaptiveTrail — no ATR uses pipSize fallback", () => {
  const result = computeAdaptiveTrail({
    entryPrice: 1.10,
    currentPrice: 1.12,
    currentSL: 1.09,
    direction: "long",
    rMultiple: 1.0,
    regimeInfo: null,
    atrValue: 0, // no ATR
    pipSize: 0.0001,
    recentCandles: [],
    baseTrailATRMultiple: 1.5,
  });
  // Fallback: 20 pips = 0.002
  assertEquals(result.trailDistance > 0, true);
  assertEquals(result.trailDistancePips > 0, true);
});

Deno.test("computeAdaptiveTrail — R-multiple scaling tightens at high R", () => {
  const result1R = computeAdaptiveTrail({
    entryPrice: 1.10, currentPrice: 1.11, currentSL: 1.09,
    direction: "long", rMultiple: 1.0,
    regimeInfo: null, atrValue: 0.005, pipSize: 0.0001,
    recentCandles: [], baseTrailATRMultiple: 1.5,
  });
  const result3R = computeAdaptiveTrail({
    entryPrice: 1.10, currentPrice: 1.13, currentSL: 1.09,
    direction: "long", rMultiple: 3.0,
    regimeInfo: null, atrValue: 0.005, pipSize: 0.0001,
    recentCandles: [], baseTrailATRMultiple: 1.5,
  });
  // At 3R, trail should be tighter than at 1R
  assertEquals(result3R.trailDistance < result1R.trailDistance, true);
});

Deno.test("computeAdaptiveTrail — floor prevents micro-trail", () => {
  // Force very tight trail via extreme tighten factor
  const fadingCandles = buildCandles(5, 0.1, "mixed");
  const result = computeAdaptiveTrail({
    entryPrice: 1.10,
    currentPrice: 1.12,
    currentSL: 1.09,
    direction: "long",
    rMultiple: 4.0, // high R → more tightening
    regimeInfo: makeRegime("choppy"),
    atrValue: 0.005,
    pipSize: 0.0001,
    recentCandles: fadingCandles,
    baseTrailATRMultiple: 1.5,
    tightenFactor: 0.3, // extreme tighten
  });
  // Floor is 0.5 × ATR = 0.0025
  assertEquals(result.trailDistance >= 0.0025, true);
});
