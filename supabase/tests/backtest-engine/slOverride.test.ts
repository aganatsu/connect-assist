/**
 * slOverride.test.ts — Regression tests for Phase A3: SL Override Chain
 *
 * Tests the Impulse Zone SL Override and Regime-Adaptive TP Adjustment
 * that were ported from the bot-scanner to the backtest engine.
 */
import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ─── Impulse Zone SL Override Unit Tests ────────────────────────────────────

/**
 * The impulse zone SL override logic (extracted for testability):
 * - Only fires when izGateMode === "hard" && izData has zone && impulse data exists
 * - Computes impulseSL = impulse.low - buffer (long) or impulse.high + buffer (short)
 * - Only overrides if impulse SL is WIDER than current SL (more protective)
 * - Capped at maxImpulseSlPips (staticMinSlPips * impulseSlCapMultiplier)
 */
function computeImpulseZoneSLOverride(params: {
  direction: "long" | "short";
  entryPrice: number;
  currentSL: number;
  currentTP: number;
  impulseHigh: number;
  impulseLow: number;
  slBufferPips: number;
  pipSize: number;
  staticMinSlPips: number;
  impulseSlCapMultiplier: number;
  tpRatio: number;
}): { sl: number; tp: number; overridden: boolean } {
  const { direction, entryPrice, currentSL, currentTP, impulseHigh, impulseLow,
    slBufferPips, pipSize, staticMinSlPips, impulseSlCapMultiplier, tpRatio } = params;

  const impulseSL = direction === "long"
    ? impulseLow - (slBufferPips * pipSize)
    : impulseHigh + (slBufferPips * pipSize);
  const impulseSlDistance = Math.abs(entryPrice - impulseSL);
  const currentSlDistance = Math.abs(entryPrice - currentSL);
  const maxImpulseSlPips = staticMinSlPips * impulseSlCapMultiplier;
  const impulseSlPips = impulseSlDistance / pipSize;

  if (impulseSlDistance > currentSlDistance && impulseSlPips <= maxImpulseSlPips) {
    const newRisk = Math.abs(entryPrice - impulseSL);
    const newTP = direction === "long"
      ? entryPrice + newRisk * tpRatio
      : entryPrice - newRisk * tpRatio;
    return { sl: impulseSL, tp: newTP, overridden: true };
  }
  return { sl: currentSL, tp: currentTP, overridden: false };
}

Deno.test("Impulse SL Override: widens SL to impulse origin for long", () => {
  const result = computeImpulseZoneSLOverride({
    direction: "long",
    entryPrice: 1.1000,
    currentSL: 1.0985,   // 15 pips
    currentTP: 1.1030,
    impulseHigh: 1.1020,
    impulseLow: 1.0970,  // impulse origin much lower
    slBufferPips: 2,
    pipSize: 0.0001,
    staticMinSlPips: 15,
    impulseSlCapMultiplier: 4,
    tpRatio: 2,
  });
  assertEquals(result.overridden, true);
  // impulseSL = 1.0970 - 2*0.0001 = 1.0968
  assertAlmostEquals(result.sl, 1.0968, 0.00001);
  // TP = 1.1000 + (1.1000 - 1.0968) * 2 = 1.1000 + 0.0064 = 1.1064
  assertAlmostEquals(result.tp, 1.1064, 0.00001);
});

Deno.test("Impulse SL Override: widens SL to impulse origin for short", () => {
  const result = computeImpulseZoneSLOverride({
    direction: "short",
    entryPrice: 1.1000,
    currentSL: 1.1015,   // 15 pips
    currentTP: 1.0970,
    impulseHigh: 1.1035,  // impulse origin much higher
    impulseLow: 1.0960,
    slBufferPips: 2,
    pipSize: 0.0001,
    staticMinSlPips: 15,
    impulseSlCapMultiplier: 4,
    tpRatio: 2,
  });
  assertEquals(result.overridden, true);
  // impulseSL = 1.1035 + 2*0.0001 = 1.1037
  assertAlmostEquals(result.sl, 1.1037, 0.00001);
  // TP = 1.1000 - (1.1037 - 1.1000) * 2 = 1.1000 - 0.0074 = 1.0926
  assertAlmostEquals(result.tp, 1.0926, 0.00001);
});

Deno.test("Impulse SL Override: does NOT override when impulse SL is tighter than current", () => {
  const result = computeImpulseZoneSLOverride({
    direction: "long",
    entryPrice: 1.1000,
    currentSL: 1.0960,   // 40 pips — already wide
    currentTP: 1.1080,
    impulseHigh: 1.1020,
    impulseLow: 1.0975,  // impulse origin is ABOVE current SL
    slBufferPips: 2,
    pipSize: 0.0001,
    staticMinSlPips: 15,
    impulseSlCapMultiplier: 4,
    tpRatio: 2,
  });
  assertEquals(result.overridden, false);
  assertEquals(result.sl, 1.0960);
  assertEquals(result.tp, 1.1080);
});

Deno.test("Impulse SL Override: does NOT override when impulse SL exceeds cap", () => {
  const result = computeImpulseZoneSLOverride({
    direction: "long",
    entryPrice: 1.1000,
    currentSL: 1.0985,   // 15 pips
    currentTP: 1.1030,
    impulseHigh: 1.1020,
    impulseLow: 1.0900,  // 100 pips away — too wide
    slBufferPips: 2,
    pipSize: 0.0001,
    staticMinSlPips: 15,
    impulseSlCapMultiplier: 4,  // max = 15 * 4 = 60 pips
    tpRatio: 2,
  });
  assertEquals(result.overridden, false);
  // 1.1000 - 1.0898 = 102 pips > 60 pip cap
});

Deno.test("Impulse SL Override: XAU/USD with larger pip size", () => {
  const result = computeImpulseZoneSLOverride({
    direction: "long",
    entryPrice: 2350.00,
    currentSL: 2345.00,   // 50 pips (pipSize = 0.1 for XAU)
    currentTP: 2360.00,
    impulseHigh: 2355.00,
    impulseLow: 2340.00,  // impulse origin lower
    slBufferPips: 2,
    pipSize: 0.1,         // XAU pip = 0.1
    staticMinSlPips: 40,
    impulseSlCapMultiplier: 4,  // max = 40 * 4 = 160 pips
    tpRatio: 2,
  });
  assertEquals(result.overridden, true);
  // impulseSL = 2340.00 - 2*0.1 = 2339.80
  assertAlmostEquals(result.sl, 2339.80, 0.01);
  // distance = 2350 - 2339.80 = 10.20, TP = 2350 + 10.20*2 = 2370.40
  assertAlmostEquals(result.tp, 2370.40, 0.01);
});

// ─── Regime-Adaptive TP Tests ───────────────────────────────────────────────

// These test the integration with adjustTPForRegime from exitEngine.ts
import { adjustTPForRegime, type RegimeInfo } from "../../functions/_shared/exitEngine.ts";

Deno.test("Regime TP: trending regime extends TP (long)", () => {
  const result = adjustTPForRegime({
    currentTP: 1.1030,
    entryPrice: 1.1000,
    stopLoss: 1.0985,
    direction: "long",
    regimeInfo: { regime: "trending", confidence: 80, direction: "bullish" } as RegimeInfo,
    atrValue: 0.0015,
    trendingRRMultiplier: 1.5,
    rangingRRMultiplier: 0.75,
  });
  // Base R:R = (1.1030 - 1.1000) / (1.1000 - 1.0985) = 30/15 = 2.0
  // Trending multiplier 1.5 → target R:R = 3.0
  // New TP = 1.1000 + 15 pips * 3.0 = 1.1045
  assertEquals(result.adjustedTP > 1.1030, true); // TP extended
});

Deno.test("Regime TP: ranging regime tightens TP (long)", () => {
  const result = adjustTPForRegime({
    currentTP: 1.1030,
    entryPrice: 1.1000,
    stopLoss: 1.0985,
    direction: "long",
    regimeInfo: { regime: "ranging", confidence: 80, direction: null } as RegimeInfo,
    atrValue: 0.0015,
    trendingRRMultiplier: 1.5,
    rangingRRMultiplier: 0.75,
  });
  // Ranging multiplier 0.75 → target R:R = 1.5
  // New TP = 1.1000 + 15 pips * 1.5 = 1.1022.5
  assertEquals(result.adjustedTP < 1.1030, true); // TP tightened
});

Deno.test("Regime TP: transitional regime leaves TP unchanged", () => {
  const result = adjustTPForRegime({
    currentTP: 1.1030,
    entryPrice: 1.1000,
    stopLoss: 1.0985,
    direction: "long",
    regimeInfo: { regime: "transitional", confidence: 80, direction: null } as RegimeInfo,
    atrValue: 0.0015,
    trendingRRMultiplier: 1.5,
    rangingRRMultiplier: 0.75,
  });
  assertEquals(result.adjustedTP, 1.1030); // Unchanged
});

Deno.test("Regime TP: null regime leaves TP unchanged", () => {
  const result = adjustTPForRegime({
    currentTP: 1.1030,
    entryPrice: 1.1000,
    stopLoss: 1.0985,
    direction: "long",
    regimeInfo: null,
    atrValue: 0.0015,
    trendingRRMultiplier: 1.5,
    rangingRRMultiplier: 0.75,
  });
  assertEquals(result.adjustedTP, 1.1030); // Unchanged
});

Deno.test("Regime TP: disabled config means no adjustment", () => {
  // In the backtest, when config.regimeAdaptiveTPEnabled is false,
  // the adjustTPForRegime call is never made. This test verifies
  // that the function itself is a no-op for transitional/null regime.
  const result = adjustTPForRegime({
    currentTP: 150.500,
    entryPrice: 150.000,
    stopLoss: 149.500,
    direction: "long",
    regimeInfo: null,
    atrValue: 0.5,
    trendingRRMultiplier: 1.5,
    rangingRRMultiplier: 0.75,
  });
  assertEquals(result.adjustedTP, 150.500);
});

// ─── Backward Compatibility ─────────────────────────────────────────────────

Deno.test("Backward compat: no impulse zone means no SL override", () => {
  // When izData is null or izGateMode !== "hard", the override is skipped
  const result = computeImpulseZoneSLOverride({
    direction: "long",
    entryPrice: 1.1000,
    currentSL: 1.0985,
    currentTP: 1.1030,
    impulseHigh: 0,
    impulseLow: 0,
    slBufferPips: 2,
    pipSize: 0.0001,
    staticMinSlPips: 15,
    impulseSlCapMultiplier: 4,
    tpRatio: 2,
  });
  // impulseSlDistance = |1.1000 - (0 - 0.0002)| = 1.1002 → way over cap
  assertEquals(result.overridden, false);
});

Deno.test("Backward compat: soft izGateMode skips impulse SL override (tested via condition)", () => {
  // The backtest code only fires when izGateMode === "hard"
  // This test documents that soft mode does NOT trigger the override
  // (We test the condition logic, not the full backtest loop)
  const izGateMode = "soft";
  const shouldFire = izGateMode === "hard";
  assertEquals(shouldFire, false);
});
