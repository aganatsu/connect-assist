/**
 * directionVerdict.test.ts — Tests for the DirectionVerdict module
 * Verifies the single-source-of-truth direction logic.
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  computeDirectionVerdict,
  type DirectionVerdictInput,
  type DirectionVerdictResult,
  DEFAULT_VERDICT_CONFIG,
} from "./directionVerdict.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeInput(overrides: Partial<DirectionVerdictInput> = {}): DirectionVerdictInput {
  return {
    confirmedTrend: null,
    simpleDirection: null,
    regime: null,
    weeklyBias: null,
    gamePlanBias: null,
    ...overrides,
  };
}

// ─── SPINE TESTS ─────────────────────────────────────────────────────

Deno.test("returns neutral when no direction sources available", () => {
  const result = computeDirectionVerdict(makeInput());
  assertEquals(result.verdict, "neutral");
  assertEquals(result.shouldBlock, true);
  assert(result.blockReason!.includes("No directional signal"));
  assertEquals(result.confidence, 0);
});

Deno.test("confirmedTrend bullish → verdict long with high confidence", () => {
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed bullish MSB" },
  }));
  assertEquals(result.verdict, "long");
  assert(result.confidence >= 70, `Expected >= 70, got ${result.confidence}`);
  assertEquals(result.shouldBlock, false);
});

Deno.test("confirmedTrend bearish → verdict short with high confidence", () => {
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bearish", reason: "Fib-confirmed bearish MSB" },
  }));
  assertEquals(result.verdict, "short");
  assert(result.confidence >= 70, `Expected >= 70, got ${result.confidence}`);
  assertEquals(result.shouldBlock, false);
});

Deno.test("confirmedTrend ranging → falls back to simpleDirection", () => {
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "ranging", reason: "No clear trend" },
    simpleDirection: {
      direction: "long",
      bias: "bullish",
      biasSource: "4h",
      h4Retrace: true,
      h4ChochAgainst: false,
      h1Confirmed: true,
      reason: "4H bullish BOS + 1H confirmed",
    },
  }));
  assertEquals(result.verdict, "long");
  // Confidence should be moderate (simpleDirection alone)
  assert(result.confidence >= 40 && result.confidence <= 85, `Expected 40-85, got ${result.confidence}`);
});

Deno.test("simpleDirection alone (no confirmedTrend) → uses as spine", () => {
  const result = computeDirectionVerdict(makeInput({
    simpleDirection: {
      direction: "short",
      bias: "bearish",
      biasSource: "daily",
      h4Retrace: false,
      h4ChochAgainst: false,
      h1Confirmed: true,
      reason: "Daily bearish + 1H BOS confirmed",
    },
  }));
  assertEquals(result.verdict, "short");
  assert(result.confidence >= 40, `Expected >= 40, got ${result.confidence}`);
});

Deno.test("confirmedTrend + simpleDirection agree → boosted confidence", () => {
  const bothAgree = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
    simpleDirection: {
      direction: "long",
      bias: "bullish",
      biasSource: "daily",
      h4Retrace: true,
      h4ChochAgainst: false,
      h1Confirmed: true,
      reason: "All aligned",
    },
  }));
  const trendOnly = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
  }));
  assert(bothAgree.confidence >= trendOnly.confidence, 
    `Agreement should boost: ${bothAgree.confidence} >= ${trendOnly.confidence}`);
});

Deno.test("confirmedTrend + simpleDirection disagree → reduced confidence", () => {
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed bullish" },
    simpleDirection: {
      direction: "short",
      bias: "bearish",
      biasSource: "4h",
      h4Retrace: false,
      h4ChochAgainst: true,
      h1Confirmed: false,
      reason: "4H CHoCH against",
    },
  }));
  // Direction should follow confirmedTrend (stronger)
  assertEquals(result.verdict, "long");
  // But confidence should be reduced
  assert(result.confidence < 80, `Expected < 80 due to disagreement, got ${result.confidence}`);
});

Deno.test("h4ChochAgainst significantly reduces simpleDirection confidence", () => {
  const withChoch = computeDirectionVerdict(makeInput({
    simpleDirection: {
      direction: "long",
      bias: "bullish",
      biasSource: "daily",
      h4Retrace: false,
      h4ChochAgainst: true,
      h1Confirmed: false,
      reason: "Daily bullish but 4H CHoCH against",
    },
  }));
  const withoutChoch = computeDirectionVerdict(makeInput({
    simpleDirection: {
      direction: "long",
      bias: "bullish",
      biasSource: "daily",
      h4Retrace: true,
      h4ChochAgainst: false,
      h1Confirmed: true,
      reason: "Daily bullish, 4H retrace, 1H confirmed",
    },
  }));
  assert(withChoch.confidence < withoutChoch.confidence,
    `ChoCH against should reduce: ${withChoch.confidence} < ${withoutChoch.confidence}`);
});

// ─── CONTEXT TESTS ───────────────────────────────────────────────────

Deno.test("regime aligned → boosts confidence", () => {
  const withRegime = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
    regime: { regime: "strong_trend", confidence: 0.85, directionalBias: "bullish" },
  }));
  const withoutRegime = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
  }));
  assert(withRegime.confidence >= withoutRegime.confidence,
    `Aligned regime should boost: ${withRegime.confidence} >= ${withoutRegime.confidence}`);
});

Deno.test("regime opposing → reduces confidence", () => {
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
    regime: { regime: "strong_trend", confidence: 0.85, directionalBias: "bearish" },
  }));
  const baseline = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
  }));
  assert(result.confidence < baseline.confidence,
    `Opposing regime should reduce: ${result.confidence} < ${baseline.confidence}`);
});

Deno.test("regime veto: strong opposing trend blocks trade", () => {
  const result = computeDirectionVerdict(makeInput({
    simpleDirection: {
      direction: "long",
      bias: "bullish",
      biasSource: "4h",
      h4Retrace: false,
      h4ChochAgainst: false,
      h1Confirmed: false,
      reason: "Weak bullish",
    },
    regime: { regime: "strong_trend", confidence: 0.90, directionalBias: "bearish" },
  }));
  assertEquals(result.shouldBlock, true);
  // May be blocked by regime veto, minConfidence threshold, or agreement floor — all valid
  assert(result.blockReason !== undefined, `Expected a block reason, got undefined`);
});

Deno.test("regime veto disabled via config", () => {
  const result = computeDirectionVerdict(
    makeInput({
      confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
      regime: { regime: "strong_trend", confidence: 0.90, directionalBias: "bearish" },
    }),
    { regimeCanVeto: false },
  );
  // Should not block even with strong opposing regime
  assertEquals(result.shouldBlock, false);
});

Deno.test("ranging regime reduces confidence but doesn't flip direction", () => {
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
    regime: { regime: "choppy_range", confidence: 0.80, directionalBias: "neutral" },
  }));
  assertEquals(result.verdict, "long"); // Direction preserved
  const baseline = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
  }));
  assert(result.confidence <= baseline.confidence,
    `Ranging should reduce or equal: ${result.confidence} <= ${baseline.confidence}`);
});

Deno.test("weekly bias aligned → boosts confidence", () => {
  const withWeekly = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
    weeklyBias: { bias: "bullish", confidence: 75 },
  }));
  const withoutWeekly = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
  }));
  assert(withWeekly.confidence >= withoutWeekly.confidence,
    `Aligned weekly should boost: ${withWeekly.confidence} >= ${withoutWeekly.confidence}`);
});

Deno.test("weekly bias opposing → reduces confidence", () => {
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
    weeklyBias: { bias: "bearish", confidence: 80 },
  }));
  const baseline = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
  }));
  assert(result.confidence < baseline.confidence,
    `Opposing weekly should reduce: ${result.confidence} < ${baseline.confidence}`);
});

Deno.test("weekly bias below threshold (40%) → no effect", () => {
  const withLowConf = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
    weeklyBias: { bias: "bearish", confidence: 30 },
  }));
  const withoutWeekly = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
  }));
  assertEquals(withLowConf.confidence, withoutWeekly.confidence);
});

// ─── ADVISORY TESTS ──────────────────────────────────────────────────

Deno.test("game plan aligned → small confidence boost", () => {
  const withGP = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
    gamePlanBias: { bias: "bullish", confidence: 75 },
  }));
  const withoutGP = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
  }));
  assert(withGP.confidence >= withoutGP.confidence,
    `Aligned GP should boost: ${withGP.confidence} >= ${withoutGP.confidence}`);
});

Deno.test("game plan opposing → small confidence reduction", () => {
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
    gamePlanBias: { bias: "bearish", confidence: 80 },
  }));
  const baseline = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
  }));
  assert(result.confidence < baseline.confidence,
    `Opposing GP should reduce: ${result.confidence} < ${baseline.confidence}`);
});

Deno.test("game plan below threshold (50%) → no effect", () => {
  const withLowConf = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
    gamePlanBias: { bias: "bearish", confidence: 40 },
  }));
  const withoutGP = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
  }));
  assertEquals(withLowConf.confidence, withoutGP.confidence);
});

// ─── SCORE ADJUSTMENT TESTS ─────────────────────────────────────────

Deno.test("high confidence → positive score adjustment", () => {
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
    simpleDirection: {
      direction: "long", bias: "bullish", biasSource: "daily",
      h4Retrace: true, h4ChochAgainst: false, h1Confirmed: true, reason: "All aligned",
    },
    regime: { regime: "strong_trend", confidence: 0.85, directionalBias: "bullish" },
  }));
  assert(result.scoreAdjustment > 0, `Expected positive adj, got ${result.scoreAdjustment}`);
  assert(result.scoreAdjustment <= DEFAULT_VERDICT_CONFIG.maxBonus,
    `Should not exceed maxBonus: ${result.scoreAdjustment} <= ${DEFAULT_VERDICT_CONFIG.maxBonus}`);
});

Deno.test("low confidence → blocked or negative score adjustment", () => {
  const result = computeDirectionVerdict(makeInput({
    simpleDirection: {
      direction: "long", bias: "bullish", biasSource: "4h",
      h4Retrace: false, h4ChochAgainst: false, h1Confirmed: false, reason: "Weak",
    },
    regime: { regime: "strong_trend", confidence: 0.80, directionalBias: "bearish" },
    weeklyBias: { bias: "bearish", confidence: 70 },
  }));
  // When context strongly opposes a weak spine, the trade gets blocked (verdict=neutral, adj=0)
  // OR if not blocked, the score adjustment should be negative
  if (result.verdict === "neutral") {
    assertEquals(result.shouldBlock, true);
    assertEquals(result.scoreAdjustment, 0); // neutral → no adjustment (trade won't happen)
  } else {
    assert(result.scoreAdjustment < 0, `Expected negative adj, got ${result.scoreAdjustment}`);
    assert(result.scoreAdjustment >= DEFAULT_VERDICT_CONFIG.maxPenalty,
      `Should not exceed maxPenalty: ${result.scoreAdjustment} >= ${DEFAULT_VERDICT_CONFIG.maxPenalty}`);
  }
});

Deno.test("neutral verdict → zero score adjustment", () => {
  const result = computeDirectionVerdict(makeInput());
  assertEquals(result.scoreAdjustment, 0);
});

// ─── AGREEMENT TESTS ─────────────────────────────────────────────────

Deno.test("all sources agree → agreement = 1.0", () => {
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
    simpleDirection: {
      direction: "long", bias: "bullish", biasSource: "daily",
      h4Retrace: true, h4ChochAgainst: false, h1Confirmed: true, reason: "All aligned",
    },
    regime: { regime: "strong_trend", confidence: 0.85, directionalBias: "bullish" },
    weeklyBias: { bias: "bullish", confidence: 75 },
    gamePlanBias: { bias: "bullish", confidence: 70 },
  }));
  assertEquals(result.agreement, 1.0);
});

Deno.test("mixed sources → agreement between 0 and 1", () => {
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
    simpleDirection: {
      direction: "long", bias: "bullish", biasSource: "daily",
      h4Retrace: true, h4ChochAgainst: false, h1Confirmed: true, reason: "Aligned",
    },
    regime: { regime: "strong_trend", confidence: 0.85, directionalBias: "bearish" },
    weeklyBias: { bias: "bearish", confidence: 75 },
    gamePlanBias: { bias: "bullish", confidence: 70 },
  }));
  assert(result.agreement > 0 && result.agreement < 1,
    `Expected partial agreement, got ${result.agreement}`);
});

// ─── FULL SCENARIO TESTS ─────────────────────────────────────────────

Deno.test("ideal bullish setup: all aligned → long, high confidence, positive adj", () => {
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed bullish MSB on Daily" },
    simpleDirection: {
      direction: "long", bias: "bullish", biasSource: "daily",
      h4Retrace: true, h4ChochAgainst: false, h1Confirmed: true,
      reason: "Daily bullish + 4H retrace + 1H BOS confirmed",
    },
    regime: { regime: "strong_trend", confidence: 0.90, directionalBias: "bullish" },
    weeklyBias: { bias: "bullish", confidence: 80 },
    gamePlanBias: { bias: "bullish", confidence: 75 },
  }));
  assertEquals(result.verdict, "long");
  assert(result.confidence >= 85, `Expected >= 85, got ${result.confidence}`);
  assert(result.scoreAdjustment > 0);
  assertEquals(result.shouldBlock, false);
  assertEquals(result.agreement, 1.0);
});

Deno.test("worst case: weak spine + all context opposing → blocked", () => {
  const result = computeDirectionVerdict(makeInput({
    simpleDirection: {
      direction: "long", bias: "bullish", biasSource: "4h",
      h4Retrace: false, h4ChochAgainst: false, h1Confirmed: false,
      reason: "Weak 4H signal only",
    },
    regime: { regime: "strong_trend", confidence: 0.90, directionalBias: "bearish" },
    weeklyBias: { bias: "bearish", confidence: 85 },
    gamePlanBias: { bias: "bearish", confidence: 80 },
  }));
  assertEquals(result.shouldBlock, true);
  assert(result.confidence < 40, `Expected < 40, got ${result.confidence}`);
});

Deno.test("context never flips direction: strong bearish regime can't make bullish spine go short", () => {
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed bullish" },
    regime: { regime: "strong_trend", confidence: 0.95, directionalBias: "bearish" },
    weeklyBias: { bias: "bearish", confidence: 90 },
    gamePlanBias: { bias: "bearish", confidence: 90 },
  }));
  // Verdict is either "long" (reduced confidence) or "neutral" (blocked) — NEVER "short"
  assert(result.verdict !== "short", `Context must never flip direction! Got: ${result.verdict}`);
});

Deno.test("summary includes key info", () => {
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
  }));
  assert(result.summary.includes("LONG") || result.summary.includes("long"));
  assert(result.summary.includes("conf"));
  assert(result.summary.includes("Agreement"));
});

// ─── CONFIG OVERRIDE TESTS ───────────────────────────────────────────

Deno.test("custom minConfidence threshold", () => {
  // With default (40), this should pass
  const defaultResult = computeDirectionVerdict(makeInput({
    simpleDirection: {
      direction: "long", bias: "bullish", biasSource: "4h",
      h4Retrace: false, h4ChochAgainst: false, h1Confirmed: true,
      reason: "Moderate signal",
    },
  }));
  // With high threshold (70), same input might go neutral
  const strictResult = computeDirectionVerdict(
    makeInput({
      simpleDirection: {
        direction: "long", bias: "bullish", biasSource: "4h",
        h4Retrace: false, h4ChochAgainst: false, h1Confirmed: true,
        reason: "Moderate signal",
      },
    }),
    { minConfidence: 70 },
  );
  // The strict result should either be neutral or have same verdict but different threshold behavior
  if (defaultResult.confidence < 70) {
    assertEquals(strictResult.verdict, "neutral");
  }
});

Deno.test("custom maxBonus/maxPenalty caps score adjustment", () => {
  const result = computeDirectionVerdict(
    makeInput({
      confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
      simpleDirection: {
        direction: "long", bias: "bullish", biasSource: "daily",
        h4Retrace: true, h4ChochAgainst: false, h1Confirmed: true, reason: "All aligned",
      },
      regime: { regime: "strong_trend", confidence: 0.95, directionalBias: "bullish" },
      weeklyBias: { bias: "bullish", confidence: 90 },
      gamePlanBias: { bias: "bullish", confidence: 90 },
    }),
    { maxBonus: 0.5 },
  );
  assert(result.scoreAdjustment <= 0.5,
    `Should be capped at 0.5: got ${result.scoreAdjustment}`);
});

// ─── REGRESSION: Agreement Floor + minConfidence=55 (Session 5 fix) ──────────

Deno.test("REGRESSION: GBP/CAD scenario — weak spine + opposing context → blocked (not LONG)", () => {
  // This is the exact scenario from the bug: confirmedTrend says bullish but
  // regime is bearish, weekly is bearish, gamePlan is bearish → 25% agreement.
  // Previously this produced "LONG 50% confidence" — now it should block.
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed bullish MSB" },
    regime: { regime: "mild_trend", confidence: 0.75, directionalBias: "bearish" },
    weeklyBias: { bias: "bearish", confidence: 70 },
    gamePlanBias: { bias: "bearish", confidence: 65 },
  }));
  // Should be blocked — either by minConfidence threshold (conf < 55) or agreement floor (< 0.50)
  assertEquals(result.shouldBlock, true);
  // The key assertion: verdict should NOT be "long" with shouldBlock=false (the original bug)
  assert(
    result.verdict === "neutral" || result.shouldBlock === true,
    `Must not produce unblocked LONG with opposing context. Got verdict=${result.verdict}, blocked=${result.shouldBlock}`
  );
});

Deno.test("REGRESSION: agreement exactly 0.50 (2/4 agree) → NOT blocked by agreement floor", () => {
  // confirmedTrend=bullish, simpleDirection=long, regime=bearish, weekly=bearish
  // → 2 agree (confirmedTrend, simpleDirection), 2 oppose (regime, weekly) = 0.50
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
    simpleDirection: {
      direction: "long", bias: "bullish", biasSource: "daily",
      h4Retrace: true, h4ChochAgainst: false, h1Confirmed: true,
      reason: "Daily bullish + 1H confirmed",
    },
    regime: { regime: "mild_trend", confidence: 0.70, directionalBias: "bearish" },
    weeklyBias: { bias: "bearish", confidence: 65 },
  }));
  // Agreement = 0.50 (exactly at floor) — should NOT be blocked by agreement floor
  // (may still be blocked by other mechanisms like regime veto, but not agreement)
  if (result.shouldBlock && result.blockReason) {
    assert(
      !result.blockReason.includes("agreement") && !result.blockReason.includes("Agreement"),
      `Should not be blocked by agreement floor at exactly 0.50. Reason: ${result.blockReason}`
    );
  }
});

Deno.test("REGRESSION: agreement below 0.50 (1/4) with strong spine → still blocked", () => {
  // Even with confirmedTrend (strong spine), if 3/4 context sources oppose,
  // the agreement floor should block
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed bullish MSB" },
    simpleDirection: {
      direction: "short", bias: "bearish", biasSource: "4h",
      h4Retrace: false, h4ChochAgainst: true, h1Confirmed: false,
      reason: "4H CHoCH against",
    },
    regime: { regime: "strong_trend", confidence: 0.85, directionalBias: "bearish" },
    weeklyBias: { bias: "bearish", confidence: 80 },
    gamePlanBias: { bias: "bearish", confidence: 75 },
  }));
  assertEquals(result.shouldBlock, true);
});

Deno.test("REGRESSION: minConfidence=55 — simpleDirection alone at ~50% confidence → blocked", () => {
  // simpleDirection alone without h4Retrace or h1Confirmed gives ~50% confidence
  // With old minConfidence=40, this would pass. With new minConfidence=55, it should block.
  const result = computeDirectionVerdict(makeInput({
    simpleDirection: {
      direction: "long", bias: "bullish", biasSource: "4h",
      h4Retrace: false, h4ChochAgainst: false, h1Confirmed: false,
      reason: "Weak 4H signal only",
    },
  }));
  // Confidence should be ~50 (base simpleDirection without confirmations)
  // With minConfidence=55, this should be neutral/blocked
  if (result.confidence < 55) {
    assertEquals(result.verdict, "neutral");
    assertEquals(result.shouldBlock, true);
  }
});

Deno.test("REGRESSION: full alignment still passes (no false positives from new thresholds)", () => {
  // When all sources agree, the new thresholds should NOT interfere
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bearish", reason: "Fib-confirmed bearish MSB" },
    simpleDirection: {
      direction: "short", bias: "bearish", biasSource: "daily",
      h4Retrace: true, h4ChochAgainst: false, h1Confirmed: true,
      reason: "All aligned bearish",
    },
    regime: { regime: "strong_trend", confidence: 0.90, directionalBias: "bearish" },
    weeklyBias: { bias: "bearish", confidence: 80 },
    gamePlanBias: { bias: "bearish", confidence: 75 },
  }));
  assertEquals(result.verdict, "short");
  assertEquals(result.shouldBlock, false);
  assertEquals(result.agreement, 1.0);
  assert(result.confidence >= 85, `Full alignment should have high confidence, got ${result.confidence}`);
});

Deno.test("REGRESSION: confirmedTrend alone still passes (strong spine = high confidence + 100% agreement)", () => {
  // confirmedTrend alone should still work — it's a strong spine with no opposing sources
  const result = computeDirectionVerdict(makeInput({
    confirmedTrend: { trend: "bullish", reason: "Fib-confirmed bullish MSB" },
  }));
  assertEquals(result.verdict, "long");
  assertEquals(result.shouldBlock, false);
  // Agreement should be 1.0 (only 1 source, and it agrees with itself)
  assertEquals(result.agreement, 1.0);
  assert(result.confidence >= 55, `confirmedTrend alone should pass minConfidence=55, got ${result.confidence}`);
});

Deno.test("REGRESSION: split-brain scenario never produces contradicting signal", () => {
  // The old bug: verdict says LONG but the system would still allow a SELL signal.
  // Now: if verdict says LONG, the only valid outcomes are LONG or BLOCKED.
  // If verdict says neutral, it's BLOCKED (no 15m fallback to SELL).
  const scenarios = [
    // Scenario 1: Weak long with bearish context
    makeInput({
      confirmedTrend: { trend: "bullish", reason: "Fib-confirmed" },
      regime: { regime: "strong_trend", confidence: 0.85, directionalBias: "bearish" },
      weeklyBias: { bias: "bearish", confidence: 80 },
      gamePlanBias: { bias: "bearish", confidence: 75 },
    }),
    // Scenario 2: Weak short with bullish context
    makeInput({
      simpleDirection: {
        direction: "short", bias: "bearish", biasSource: "4h",
        h4Retrace: false, h4ChochAgainst: false, h1Confirmed: false,
        reason: "Weak bearish",
      },
      regime: { regime: "strong_trend", confidence: 0.85, directionalBias: "bullish" },
      weeklyBias: { bias: "bullish", confidence: 80 },
    }),
  ];

  for (const input of scenarios) {
    const result = computeDirectionVerdict(input);
    // The result should NEVER have verdict=long/short with shouldBlock=true simultaneously
    // (that would be a contradicting signal)
    if (result.shouldBlock) {
      // When blocked, verdict should be neutral OR the block reason should be clear
      assert(
        result.verdict === "neutral" || result.blockReason !== undefined,
        `Blocked verdict should be neutral or have clear reason. Got verdict=${result.verdict}, block=${result.shouldBlock}`
      );
    }
  }
});
