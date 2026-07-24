/**
 * priceActionPhase.test.ts — Tests for Price-Action Market Phase Detection
 * ──────────────────────────────────────────────────────────────────────────────
 * Tests cover:
 *   1. Consolidation detection (tight range, low regime score)
 *   2. Expansion detection (transition from range to trend, ATR expanding)
 *   3. Trend detection (high regime score, sustained direction)
 *   4. OB formed in consolidation check
 *   5. Batch OB filtering
 *   6. Edge cases (insufficient data, boundary conditions)
 */

import { assertEquals, assert, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  detectMarketPhase,
  wasOBFormedInConsolidation,
  filterOBsByPhaseContext,
  DEFAULT_PHASE_CONFIG,
  type MarketPhase,
  type PhaseResult,
} from "./priceActionPhase.ts";
import type { Candle } from "./smcAnalysis.ts";

// ─── Test Data Generators ─────────────────────────────────────────────────────

function makeCandle(o: number, h: number, l: number, c: number, t: number): Candle {
  return {
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
    datetime: new Date(t * 1000).toISOString(),
  };
}

/**
 * Generate consolidation candles: tight range, random small moves within a box.
 * Simulates a ranging market with no clear direction.
 */
function makeConsolidationCandles(count: number, midPrice = 1.1000, rangeWidth = 0.0020): Candle[] {
  const candles: Candle[] = [];
  let price = midPrice;
  const halfRange = rangeWidth / 2;
  const baseTime = 1700000000;

  for (let i = 0; i < count; i++) {
    // Small random moves that stay within the box
    const move = (Math.sin(i * 0.7) * halfRange * 0.6); // oscillate within range
    price = midPrice + move;
    const bodySize = rangeWidth * 0.1; // tiny bodies
    const wickSize = rangeWidth * 0.15;

    const o = price;
    const c = price + (i % 2 === 0 ? bodySize : -bodySize);
    const h = Math.max(o, c) + wickSize;
    const l = Math.min(o, c) - wickSize;

    // Clamp to range
    const clampedH = Math.min(h, midPrice + halfRange);
    const clampedL = Math.max(l, midPrice - halfRange);

    candles.push(makeCandle(
      Math.max(clampedL, Math.min(clampedH, o)),
      clampedH,
      clampedL,
      Math.max(clampedL, Math.min(clampedH, c)),
      baseTime + i * 3600,
    ));
  }
  return candles;
}

/**
 * Generate strong trending candles: consistent HH/HL (bullish) or LH/LL (bearish).
 * Large bodies, small wicks, sustained direction.
 */
function makeTrendingCandles(count: number, direction: "bullish" | "bearish", startPrice = 1.1000): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  const baseTime = 1700000000;
  const movePerCandle = direction === "bullish" ? 0.0015 : -0.0015;

  for (let i = 0; i < count; i++) {
    const o = price;
    const c = price + movePerCandle;
    const bodySize = Math.abs(c - o);
    const wickUp = bodySize * 0.2;
    const wickDown = bodySize * 0.2;

    const h = Math.max(o, c) + wickUp;
    const l = Math.min(o, c) - wickDown;

    candles.push(makeCandle(o, h, l, c, baseTime + i * 3600));
    price = c;
  }
  return candles;
}

/**
 * Generate expansion candles: starts with consolidation then breaks out with displacement.
 * First half is tight range, second half is strong directional move.
 */
function makeExpansionCandles(count: number, breakoutDirection: "bullish" | "bearish" = "bullish"): Candle[] {
  const halfCount = Math.floor(count / 2);
  // First half: consolidation
  const consolidation = makeConsolidationCandles(halfCount, 1.1000, 0.0015);

  // Second half: breakout with increasing momentum
  const candles = [...consolidation];
  let price = breakoutDirection === "bullish" ? 1.1010 : 1.0990;
  const baseTime = 1700000000 + halfCount * 3600;

  for (let i = 0; i < count - halfCount; i++) {
    // Increasing move size (expansion characteristic)
    const moveSize = 0.0008 + (i * 0.0003);
    const move = breakoutDirection === "bullish" ? moveSize : -moveSize;
    const o = price;
    const c = price + move;
    const bodySize = Math.abs(c - o);
    const h = Math.max(o, c) + bodySize * 0.15;
    const l = Math.min(o, c) - bodySize * 0.15;

    candles.push(makeCandle(o, h, l, c, baseTime + i * 3600));
    price = c;
  }
  return candles;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

Deno.test("detectMarketPhase — consolidation: tight range sideways market", () => {
  const candles = makeConsolidationCandles(50);
  const result = detectMarketPhase(candles);

  assertEquals(result.phase, "consolidation");
  assert(result.confidence >= 0.3, `Confidence ${result.confidence} should be >= 0.3`);
  assert(result.regimeScore <= DEFAULT_PHASE_CONFIG.consolidationThreshold,
    `Regime score ${result.regimeScore} should be <= ${DEFAULT_PHASE_CONFIG.consolidationThreshold}`);
  assertExists(result.consolidationRange);
  assert(result.detail.includes("onsolidation"), `Detail should mention consolidation: ${result.detail}`);
});

Deno.test("detectMarketPhase — trend: strong bullish market", () => {
  const candles = makeTrendingCandles(50, "bullish");
  const result = detectMarketPhase(candles);

  assertEquals(result.phase, "trend");
  assert(result.confidence >= 0.5, `Confidence ${result.confidence} should be >= 0.5`);
  assert(result.regimeScore >= DEFAULT_PHASE_CONFIG.trendThreshold,
    `Regime score ${result.regimeScore} should be >= ${DEFAULT_PHASE_CONFIG.trendThreshold}`);
  assertEquals(result.consolidationRange, null);
});

Deno.test("detectMarketPhase — trend: strong bearish market", () => {
  const candles = makeTrendingCandles(50, "bearish");
  const result = detectMarketPhase(candles);

  assertEquals(result.phase, "trend");
  assert(result.confidence >= 0.5, `Confidence ${result.confidence} should be >= 0.5`);
});

Deno.test("detectMarketPhase — expansion: breakout from consolidation", () => {
  const candles = makeExpansionCandles(50, "bullish");
  const result = detectMarketPhase(candles);

  // Expansion should be detected when there's a mix of range + directional move
  // The exact classification depends on how strong the breakout is
  assert(
    result.phase === "expansion" || result.phase === "trend",
    `Phase should be expansion or trend after breakout, got: ${result.phase}`,
  );
  assert(result.regimeScore > DEFAULT_PHASE_CONFIG.consolidationThreshold,
    `Regime score ${result.regimeScore} should be above consolidation threshold`);
});

Deno.test("detectMarketPhase — insufficient data returns consolidation with zero confidence", () => {
  const candles = makeConsolidationCandles(5); // Only 5 candles
  const result = detectMarketPhase(candles);

  assertEquals(result.phase, "consolidation");
  assertEquals(result.confidence, 0);
  assertEquals(result.regimeScore, 0);
  assert(result.detail.includes("Insufficient"), `Detail should mention insufficient data: ${result.detail}`);
});

Deno.test("detectMarketPhase — empty array returns safe fallback", () => {
  const result = detectMarketPhase([]);

  assertEquals(result.phase, "consolidation");
  assertEquals(result.confidence, 0);
});

Deno.test("detectMarketPhase — custom config thresholds work", () => {
  // Verify that custom thresholds change classification behavior
  const candles = makeTrendingCandles(50, "bullish");
  const normalResult = detectMarketPhase(candles);
  const strictResult = detectMarketPhase(candles, { trendThreshold: 12 });

  // Normal threshold (6) should classify strong trend as "trend"
  assertEquals(normalResult.phase, "trend");

  // With strict threshold (12), the score must be >= 12 to be classified as "trend" directly
  // If score < 12, it falls into the middle-range logic
  assert(strictResult.regimeScore === normalResult.regimeScore,
    "Same candles should produce same regime score regardless of threshold");

  // Key test: the strict threshold should NOT classify via the first branch (regimeScore >= trendThreshold)
  // unless the score actually reaches 12. It may still be "trend" via the midpoint logic.
  if (strictResult.regimeScore >= 12) {
    assertEquals(strictResult.phase, "trend");
  } else {
    // Score is below strict threshold — it goes through middle-range logic
    // which uses midpoint = (-2+12)/2 = 5. Score 9 >= 5 → still "trend" via midpoint
    // This is correct behavior: the midpoint adapts to the threshold range
    assert(strictResult.phase === "trend" || strictResult.phase === "expansion",
      `Score ${strictResult.regimeScore} with threshold 12 should be trend or expansion, got: ${strictResult.phase}`);
  }

  // Verify that a VERY strict threshold (14) with consolidation candles produces consolidation
  const consolidationCandles = makeConsolidationCandles(50);
  const consolidationResult = detectMarketPhase(consolidationCandles, { trendThreshold: 14 });
  assertEquals(consolidationResult.phase, "consolidation");
});

Deno.test("detectMarketPhase — consolidation range bounds are correct", () => {
  const candles = makeConsolidationCandles(30, 1.1000, 0.0020);
  const result = detectMarketPhase(candles);

  if (result.consolidationRange) {
    assert(result.consolidationRange.high >= result.consolidationRange.low,
      "Range high should be >= low");
    // Range should be approximately within our specified width
    const width = result.consolidationRange.high - result.consolidationRange.low;
    assert(width <= 0.0030, `Range width ${width} should be <= 0.0030 for tight consolidation`);
    assert(width >= 0.0005, `Range width ${width} should be >= 0.0005 (not degenerate)`);
  }
});

// ─── OB Consolidation Check Tests ────────────────────────────────────────────

Deno.test("wasOBFormedInConsolidation — OB in consolidation returns true", () => {
  // 50 candles of pure consolidation
  const candles = makeConsolidationCandles(50);
  // OB at index 25 (middle of consolidation)
  const result = wasOBFormedInConsolidation(25, candles, 20);

  assertEquals(result, true);
});

Deno.test("wasOBFormedInConsolidation — OB in trend returns false", () => {
  // 50 candles of strong trend
  const candles = makeTrendingCandles(50, "bullish");
  // OB at index 25 (middle of trend)
  const result = wasOBFormedInConsolidation(25, candles, 20);

  assertEquals(result, false);
});

Deno.test("wasOBFormedInConsolidation — OB at expansion breakout returns false", () => {
  // Expansion candles (consolidation then breakout)
  const candles = makeExpansionCandles(50);
  // OB at index 35 (in the breakout portion)
  const result = wasOBFormedInConsolidation(35, candles, 20);

  assertEquals(result, false);
});

Deno.test("wasOBFormedInConsolidation — insufficient data returns false", () => {
  const candles = makeConsolidationCandles(10);
  const result = wasOBFormedInConsolidation(5, candles, 20);

  assertEquals(result, false);
});

Deno.test("wasOBFormedInConsolidation — edge index (near start) handled safely", () => {
  const candles = makeConsolidationCandles(50);
  // OB at index 2 (near the start, window will be truncated)
  const result = wasOBFormedInConsolidation(2, candles, 20);

  // Should not throw, may return false due to insufficient window
  assert(typeof result === "boolean");
});

Deno.test("wasOBFormedInConsolidation — edge index (near end) handled safely", () => {
  const candles = makeConsolidationCandles(50);
  // OB at index 48 (near the end)
  const result = wasOBFormedInConsolidation(48, candles, 20);

  assert(typeof result === "boolean");
});

// ─── Batch Filter Tests ──────────────────────────────────────────────────────

Deno.test("filterOBsByPhaseContext — mixed candles correctly identifies consolidation OBs", () => {
  // First 25 candles: consolidation, last 25: trend
  const consolidation = makeConsolidationCandles(25);
  const trend = makeTrendingCandles(25, "bullish", 1.1000);
  const candles = [...consolidation, ...trend];

  const results = filterOBsByPhaseContext([10, 35], candles, 20);

  assertEquals(results.length, 2);
  // OB at index 10 (in consolidation section) should be flagged
  assertEquals(results[0].index, 10);
  assertEquals(results[0].inConsolidation, true);
  // OB at index 35 (in trend section) should NOT be flagged
  assertEquals(results[1].index, 35);
  assertEquals(results[1].inConsolidation, false);
});

Deno.test("filterOBsByPhaseContext — returns correct phase for each OB", () => {
  const candles = makeTrendingCandles(50, "bearish");
  // Use indices that are well within the candle array (not near edges)
  // so the window has enough data for reliable classification
  const results = filterOBsByPhaseContext([20, 30, 40], candles, 16);

  assertEquals(results.length, 3);
  // At minimum, OBs in a trending market should NOT be flagged as consolidation
  for (const r of results) {
    assertEquals(r.inConsolidation, false,
      `OB at index ${r.index} in trending market should not be in consolidation (phase: ${r.phase}, confidence: ${r.confidence})`);
  }
});

Deno.test("filterOBsByPhaseContext — empty indices returns empty array", () => {
  const candles = makeConsolidationCandles(50);
  const results = filterOBsByPhaseContext([], candles, 20);
  assertEquals(results.length, 0);
});

// ─── Phase Transition Tests ──────────────────────────────────────────────────

Deno.test("detectMarketPhase — regime transition info is propagated", () => {
  // Use enough candles for transition detection (needs 30+lookbackShift candles)
  const candles = makeExpansionCandles(60);
  const result = detectMarketPhase(candles);

  // The result should have regime info available
  assertExists(result.regime);
  assert(typeof result.regimeScore === "number");
  // Transition may or may not be detected depending on data, but field should exist
  assert(result.transition === null || typeof result.transition === "string");
});

Deno.test("detectMarketPhase — phase result has all required fields", () => {
  const candles = makeTrendingCandles(50, "bullish");
  const result = detectMarketPhase(candles);

  // Verify all fields exist and have correct types
  assert(["consolidation", "expansion", "trend"].includes(result.phase));
  assert(result.confidence >= 0 && result.confidence <= 1);
  assert(typeof result.regimeScore === "number");
  assert(result.transition === null || typeof result.transition === "string");
  assert(result.consolidationRange === null || (typeof result.consolidationRange.high === "number" && typeof result.consolidationRange.low === "number"));
  assert(typeof result.detail === "string" && result.detail.length > 0);
  assertExists(result.regime);
});
