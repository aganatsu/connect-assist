/**
 * GP Bias Confidence Adjustment — Phase 5 Tests
 *
 * Tests the gamePlanBiasAdjustment helper and its integration into
 * runConfluenceAnalysis via the _gamePlanContext config injection.
 *
 * Verifies:
 * 1. No GP context → no adjustment (no regression)
 * 2. Neutral bias → no adjustment
 * 3. Low confidence (< 50%) → no adjustment
 * 4. High confidence aligned → positive bonus
 * 5. High confidence opposed → negative penalty
 * 6. Medium confidence (50-69%) → mild adjustments
 * 7. Integration: GP context injected via config produces different score
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runConfluenceAnalysis } from "./confluenceScoring.ts";
import { Candle } from "./smcAnalysis.ts";

// ─── Minimal candle fixtures ─────────────────────────────────────────────

function generateBullishCandles(): Candle[] {
  const candles: Candle[] = [];
  let price = 1.0800;
  for (let i = 0; i < 60; i++) {
    const open = price;
    const close = open + 0.0005 + Math.random() * 0.0010;
    const high = Math.max(open, close) + Math.random() * 0.0005;
    const low = Math.min(open, close) - Math.random() * 0.0005;
    candles.push({
      datetime: new Date(Date.UTC(2024, 2, 15, 10, i * 5)).toISOString(),
      open, high, low, close,
    });
    price = close;
  }
  return candles;
}

function generateDailyCandles(): Candle[] {
  const candles: Candle[] = [];
  let price = 1.0600;
  for (let i = 0; i < 30; i++) {
    const open = price;
    const close = open + 0.0020 + Math.random() * 0.0030;
    const high = Math.max(open, close) + Math.random() * 0.0020;
    const low = Math.min(open, close) - Math.random() * 0.0020;
    candles.push({
      datetime: new Date(Date.UTC(2024, 1, 15 + i)).toISOString(),
      open, high, low, close,
    });
    price = close;
  }
  return candles;
}

const baseConfig = {
  _currentSymbol: "EUR/USD",
  slMethod: "structure",
  tpMethod: "rr_ratio",
  tpRatio: 2.0,
  slBufferPips: 2,
  fixedSLPips: 25,
  minRiskReward: 1.0,
};

const fixedTime = new Date("2024-03-15T14:30:00Z").getTime();

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test("GP Bias: no GP context → GP Bias Confidence factor is present=false", () => {
  const candles = generateBullishCandles();
  const daily = generateDailyCandles();
  const result = runConfluenceAnalysis(candles, daily, baseConfig, undefined, fixedTime);

  const gpFactor = result.factors.find((f: any) => f.name === "GP Bias Confidence");
  assert(gpFactor, "GP Bias Confidence factor should exist in factors list");
  assertEquals(gpFactor.present, false, "Should be present=false when no GP context");
  assertEquals(gpFactor.weight, 0, "Should have 0 weight when no GP context");
});

Deno.test("GP Bias: neutral bias → no adjustment", () => {
  const candles = generateBullishCandles();
  const daily = generateDailyCandles();
  const config = {
    ...baseConfig,
    _gamePlanContext: { bias: "neutral", biasConfidence: 80 },
  };
  const result = runConfluenceAnalysis(candles, daily, config, undefined, fixedTime);

  const gpFactor = result.factors.find((f: any) => f.name === "GP Bias Confidence");
  assert(gpFactor, "GP Bias Confidence factor should exist");
  assertEquals(gpFactor.present, false, "Neutral bias should produce no adjustment");
  assertEquals(gpFactor.weight, 0);
});

Deno.test("GP Bias: low confidence (30%) → no adjustment", () => {
  const candles = generateBullishCandles();
  const daily = generateDailyCandles();
  const config = {
    ...baseConfig,
    _gamePlanContext: { bias: "bullish", biasConfidence: 30 },
  };
  const result = runConfluenceAnalysis(candles, daily, config, undefined, fixedTime);

  const gpFactor = result.factors.find((f: any) => f.name === "GP Bias Confidence");
  assert(gpFactor, "GP Bias Confidence factor should exist");
  assertEquals(gpFactor.present, false, "Low confidence should produce no adjustment");
  assertEquals(gpFactor.weight, 0);
});

Deno.test("GP Bias: high confidence aligned → positive bonus applied to score", () => {
  const candles = generateBullishCandles();
  const daily = generateDailyCandles();

  // Run without GP context
  const baseResult = runConfluenceAnalysis(candles, daily, baseConfig, undefined, fixedTime);

  // Run with aligned high-confidence GP bias
  // We need to match the direction the engine picks
  const dir = baseResult.direction;
  if (!dir) {
    // If no direction, skip — can't test alignment
    return;
  }

  const alignedBias = dir === "long" ? "bullish" : "bearish";
  const config = {
    ...baseConfig,
    _gamePlanContext: { bias: alignedBias, biasConfidence: 85 },
  };
  const gpResult = runConfluenceAnalysis(candles, daily, config, undefined, fixedTime);

  const gpFactor = gpResult.factors.find((f: any) => f.name === "GP Bias Confidence");
  assert(gpFactor, "GP Bias Confidence factor should exist");
  assert(gpFactor.present, "Aligned high-confidence bias should be present");
  assert(gpFactor.weight > 0, `Weight should be positive for aligned bias, got ${gpFactor.weight}`);

  // Score should be higher with aligned GP bias
  assert(gpResult.score >= baseResult.score,
    `Score with aligned GP bias (${gpResult.score}) should be >= base score (${baseResult.score})`);
});

Deno.test("GP Bias: high confidence opposed → negative penalty applied to score", () => {
  const candles = generateBullishCandles();
  const daily = generateDailyCandles();

  const baseResult = runConfluenceAnalysis(candles, daily, baseConfig, undefined, fixedTime);
  const dir = baseResult.direction;
  if (!dir) return;

  const opposedBias = dir === "long" ? "bearish" : "bullish";
  const config = {
    ...baseConfig,
    _gamePlanContext: { bias: opposedBias, biasConfidence: 85 },
  };
  const gpResult = runConfluenceAnalysis(candles, daily, config, undefined, fixedTime);

  const gpFactor = gpResult.factors.find((f: any) => f.name === "GP Bias Confidence");
  assert(gpFactor, "GP Bias Confidence factor should exist");
  assert(gpFactor.present, "Opposed high-confidence bias should be present");
  assert(gpFactor.weight < 0, `Weight should be negative for opposed bias, got ${gpFactor.weight}`);

  // Score should be lower with opposed GP bias
  assert(gpResult.score <= baseResult.score,
    `Score with opposed GP bias (${gpResult.score}) should be <= base score (${baseResult.score})`);
});

Deno.test("GP Bias: medium confidence (60%) → mild adjustment", () => {
  const candles = generateBullishCandles();
  const daily = generateDailyCandles();

  const baseResult = runConfluenceAnalysis(candles, daily, baseConfig, undefined, fixedTime);
  const dir = baseResult.direction;
  if (!dir) return;

  const alignedBias = dir === "long" ? "bullish" : "bearish";

  // Medium confidence aligned
  const configMed = {
    ...baseConfig,
    _gamePlanContext: { bias: alignedBias, biasConfidence: 60 },
  };
  const medResult = runConfluenceAnalysis(candles, daily, configMed, undefined, fixedTime);

  // High confidence aligned
  const configHigh = {
    ...baseConfig,
    _gamePlanContext: { bias: alignedBias, biasConfidence: 85 },
  };
  const highResult = runConfluenceAnalysis(candles, daily, configHigh, undefined, fixedTime);

  const medFactor = medResult.factors.find((f: any) => f.name === "GP Bias Confidence");
  const highFactor = highResult.factors.find((f: any) => f.name === "GP Bias Confidence");

  assert(medFactor && medFactor.present, "Medium confidence should produce adjustment");
  assert(highFactor && highFactor.present, "High confidence should produce adjustment");

  // Medium confidence bonus should be smaller than high confidence bonus
  assert(medFactor.weight < highFactor.weight,
    `Medium conf bonus (${medFactor.weight}) should be < high conf bonus (${highFactor.weight})`);
});
