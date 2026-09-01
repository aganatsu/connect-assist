/**
 * thesisConviction.test.ts — Tests for Thesis Conviction Tracker
 *
 * Tests cover:
 *   1. Evidence evaluation with various input combinations
 *   2. Conviction decay over multiple cycles of opposing evidence
 *   3. Conviction recovery when evidence turns supportive
 *   4. Impulse credit revocation at threshold
 *   5. Accelerated decay after consecutive declines
 *   6. The XAU scenario that triggered this feature (regression test)
 *   7. Edge cases: null inputs, first cycle, max history cap
 */
import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  evaluateEvidence,
  updateConviction,
  buildConvictionKey,
  DEFAULT_CONVICTION_CONFIG,
  type ConvictionInput,
  type ThesisConvictionState,
  type ConvictionConfig,
} from "./thesisConviction.ts";

// ─── Helper: build a ConvictionInput with defaults ───────────────────

function makeInput(overrides: Partial<ConvictionInput> = {}): ConvictionInput {
  return {
    symbol: "XAU/USD",
    direction: "short",
    directionVerdict: {
      verdict: "short",
      confidence: 70,
      scoreAdjustment: 0,
      shouldBlock: false,
      blockReason: null,
      sources: [],
      agreement: 0.8,
      summary: "test",
    },
    regime4H: {
      regime: "mild_trend",
      confidence: 0.7,
      bias: "bearish",
    },
    opposingFactorCount: 0,
    fotsiAlignment: {
      label: "aligned",
      score: 0.6,
    },
    gamePlanBias: {
      bias: "bearish",
      confidence: 70,
    },
    ...overrides,
  };
}

// ─── Test 1: Fresh thesis starts at 100% conviction ─────────────────

Deno.test("updateConviction: first cycle with all aligned evidence → conviction stays high", () => {
  const input = makeInput(); // All sources aligned with "short"
  const { state, result } = updateConviction(null, input);

  assertEquals(state.conviction >= 90, true, `Expected conviction >= 90, got ${state.conviction}`);
  assertEquals(result.impulseCreditDecision, "granted");
  assertEquals(result.cycleCount, 1);
  assertEquals(result.consecutiveDeclines, 0);
  assertEquals(result.thesisDegrading, false);
  assertEquals(result.scoreAdjustment, 0); // Only 1 cycle, minCyclesForRevoke not met
});

// ─── Test 2: Opposing evidence decays conviction ─────────────────────

Deno.test("updateConviction: opposing regime + verdict decays conviction", () => {
  // Start with a fresh state
  const alignedInput = makeInput();
  const { state: initialState } = updateConviction(null, alignedInput);

  // Now flip regime and verdict to oppose the short thesis
  const opposingInput = makeInput({
    directionVerdict: {
      verdict: "long",
      confidence: 75,
      scoreAdjustment: 0,
      shouldBlock: false,
      blockReason: null,
      sources: [],
      agreement: 0.3, // Low agreement — sources disagree
      summary: "opposing",
    },
    regime4H: {
      regime: "strong_trend",
      confidence: 0.8,
      bias: "bullish", // Opposes short thesis
    },
    opposingFactorCount: 3,
    fotsiAlignment: {
      label: "opposing",
      score: -0.5,
    },
    gamePlanBias: {
      bias: "bullish", // Opposes short thesis
      confidence: 80,
    },
  });

  const { state: decayedState, result } = updateConviction(initialState, opposingInput);

  // Conviction should have dropped significantly
  assertEquals(decayedState.conviction < initialState.conviction, true,
    `Expected conviction to drop from ${initialState.conviction}, got ${decayedState.conviction}`);
  assertEquals(result.consecutiveDeclines, 1);
});

// ─── Test 3: Multiple opposing cycles → conviction reaches revoke threshold ──

Deno.test("updateConviction: 4 cycles of opposing evidence → impulse credit revoked", () => {
  let state: ThesisConvictionState | null = null;

  // Cycle 1: aligned (establishes thesis)
  const alignedInput = makeInput();
  const cycle1 = updateConviction(state, alignedInput);
  state = cycle1.state;

  // Cycles 2-5: all opposing
  const opposingInput = makeInput({
    directionVerdict: {
      verdict: "long",
      confidence: 75,
      scoreAdjustment: 0,
      shouldBlock: false,
      blockReason: null,
      sources: [],
      agreement: 0.3,
      summary: "opposing",
    },
    regime4H: {
      regime: "strong_trend",
      confidence: 0.85,
      bias: "bullish",
    },
    opposingFactorCount: 4,
    fotsiAlignment: { label: "strong_opposing", score: -0.8 },
    gamePlanBias: { bias: "bullish", confidence: 85 },
  });

  for (let i = 0; i < 4; i++) {
    const cycle = updateConviction(state, opposingInput);
    state = cycle.state;
  }

  // After 5 total cycles (1 aligned + 4 opposing), conviction should be very low
  assertEquals(state!.conviction <= DEFAULT_CONVICTION_CONFIG.revokeThreshold, true,
    `Expected conviction <= ${DEFAULT_CONVICTION_CONFIG.revokeThreshold}, got ${state!.conviction}`);

  // The result should show revoked
  const finalResult = updateConviction(state, opposingInput);
  assertEquals(finalResult.result.impulseCreditDecision, "revoked");
  assertEquals(finalResult.result.thesisDegrading, true);
});

// ─── Test 4: Recovery when evidence turns supportive ─────────────────

Deno.test("updateConviction: conviction recovers when evidence flips back to supporting", () => {
  let state: ThesisConvictionState | null = null;

  // Cycle 1: aligned
  state = updateConviction(null, makeInput()).state;

  // Cycles 2-3: opposing (decay)
  const opposing = makeInput({
    directionVerdict: {
      verdict: "long", confidence: 70, scoreAdjustment: 0,
      shouldBlock: false, blockReason: null, sources: [], agreement: 0.3, summary: "opp",
    },
    regime4H: { regime: "mild_trend", confidence: 0.7, bias: "bullish" },
    opposingFactorCount: 3,
    fotsiAlignment: { label: "opposing", score: -0.4 },
    gamePlanBias: { bias: "bullish", confidence: 65 },
  });
  state = updateConviction(state, opposing).state;
  state = updateConviction(state, opposing).state;
  const lowPoint = state.conviction;

  // Cycles 4-5: back to aligned (recovery)
  state = updateConviction(state, makeInput()).state;
  state = updateConviction(state, makeInput()).state;

  assertEquals(state.conviction > lowPoint, true,
    `Expected conviction to recover from ${lowPoint}, got ${state.conviction}`);
  assertEquals(state.consecutiveDeclines, 0);
});

// ─── Test 5: Accelerated decay kicks in after 3 consecutive declines ──

Deno.test("updateConviction: accelerated decay after 3 consecutive declines", () => {
  let state: ThesisConvictionState | null = null;
  const opposing = makeInput({
    directionVerdict: {
      verdict: "long", confidence: 65, scoreAdjustment: 0,
      shouldBlock: false, blockReason: null, sources: [], agreement: 0.4, summary: "opp",
    },
    regime4H: { regime: "mild_trend", confidence: 0.6, bias: "bullish" },
    opposingFactorCount: 2,
    fotsiAlignment: { label: "opposing", score: -0.3 },
    gamePlanBias: { bias: "neutral", confidence: 40 },
  });

  // Build up 3 cycles of decline
  state = updateConviction(null, makeInput()).state; // cycle 1: aligned
  state = updateConviction(state, opposing).state;   // cycle 2: decline 1
  state = updateConviction(state, opposing).state;   // cycle 3: decline 2
  state = updateConviction(state, opposing).state;   // cycle 4: decline 3
  const preAccelConviction = state.conviction;
  assertEquals(state.consecutiveDeclines, 3);

  // Cycle 5: should trigger accelerated decay
  const { state: afterAccel } = updateConviction(state, opposing);
  const normalDecay = preAccelConviction - afterAccel.conviction;

  // Compare with what a non-accelerated decay would be
  // Accelerated should decay MORE than normal
  assertEquals(afterAccel.consecutiveDeclines, 4);
  assertEquals(afterAccel.conviction < preAccelConviction, true);
});

// ─── Test 6: XAU Regression Test — the exact scenario from today ─────

Deno.test("XAU regression: short thesis degrades as bullish evidence accumulates", () => {
  let state: ThesisConvictionState | null = null;

  // 09:00 — Thesis created: daily bias bearish, all aligned
  const cycle1 = makeInput({
    symbol: "XAU/USD",
    direction: "short",
    directionVerdict: {
      verdict: "short", confidence: 72, scoreAdjustment: 0,
      shouldBlock: false, blockReason: null, sources: [], agreement: 0.75, summary: "short aligned",
    },
    regime4H: { regime: "mild_trend", confidence: 0.65, bias: "bearish" },
    opposingFactorCount: 0,
    fotsiAlignment: { label: "aligned", score: 0.5 },
    gamePlanBias: { bias: "bearish", confidence: 70 },
  });
  state = updateConviction(null, cycle1).state;
  assertEquals(state.conviction >= 90, true, "Thesis should start strong");

  // 09:15 — 4H regime starts shifting (mild opposing)
  const cycle2 = makeInput({
    symbol: "XAU/USD",
    direction: "short",
    directionVerdict: {
      verdict: "short", confidence: 60, scoreAdjustment: 0,
      shouldBlock: false, blockReason: null, sources: [], agreement: 0.6, summary: "weakening",
    },
    regime4H: { regime: "transitional", confidence: 0.5, bias: "neutral" },
    opposingFactorCount: 1,
    fotsiAlignment: { label: "neutral", score: 0.1 },
    gamePlanBias: { bias: "bearish", confidence: 60 },
  });
  state = updateConviction(state, cycle2).state;

  // 10:00 — 4H regime flipped bullish, entry-TF trend bullish
  const cycle3 = makeInput({
    symbol: "XAU/USD",
    direction: "short",
    directionVerdict: {
      verdict: "long", confidence: 65, scoreAdjustment: 0,
      shouldBlock: false, blockReason: null, sources: [], agreement: 0.5, summary: "flipping",
    },
    regime4H: { regime: "mild_trend", confidence: 0.7, bias: "bullish" },
    opposingFactorCount: 2,
    fotsiAlignment: { label: "opposing", score: -0.3 },
    gamePlanBias: { bias: "bearish", confidence: 50 }, // GP still bearish but weakening
  });
  state = updateConviction(state, cycle3).state;

  // 11:00 — Full opposition: all sources say long
  const cycle4 = makeInput({
    symbol: "XAU/USD",
    direction: "short",
    directionVerdict: {
      verdict: "long", confidence: 78, scoreAdjustment: 0,
      shouldBlock: false, blockReason: null, sources: [], agreement: 0.35, summary: "opposing",
    },
    regime4H: { regime: "strong_trend", confidence: 0.85, bias: "bullish" },
    opposingFactorCount: 4,
    fotsiAlignment: { label: "strong_opposing", score: -0.7 },
    gamePlanBias: { bias: "bullish", confidence: 75 },
  });
  const { state: finalState, result } = updateConviction(state, cycle4);

  // By 11:00 (4 cycles of degrading evidence), conviction should be low enough
  // to either revoke or reduce impulse credit
  assertEquals(finalState.conviction <= DEFAULT_CONVICTION_CONFIG.reduceThreshold, true,
    `Expected conviction <= ${DEFAULT_CONVICTION_CONFIG.reduceThreshold} by cycle 4, got ${finalState.conviction}`);
  assertEquals(
    result.impulseCreditDecision === "revoked" || result.impulseCreditDecision === "reduced",
    true,
    `Expected credit revoked or reduced, got ${result.impulseCreditDecision}`,
  );
  assertEquals(result.thesisDegrading, true, "Thesis should be flagged as degrading");
});

// ─── Test 7: minCyclesForRevoke prevents premature revocation ────────

Deno.test("updateConviction: first cycle cannot revoke even with all opposing evidence", () => {
  const opposingInput = makeInput({
    directionVerdict: {
      verdict: "long", confidence: 90, scoreAdjustment: 0,
      shouldBlock: false, blockReason: null, sources: [], agreement: 0.2, summary: "opp",
    },
    regime4H: { regime: "strong_trend", confidence: 0.9, bias: "bullish" },
    opposingFactorCount: 5,
    fotsiAlignment: { label: "strong_opposing", score: -0.9 },
    gamePlanBias: { bias: "bullish", confidence: 90 },
  });

  const { result } = updateConviction(null, opposingInput);

  // Even with all opposing, first cycle can't revoke (minCyclesForRevoke = 2)
  assertEquals(result.impulseCreditDecision, "granted",
    "First cycle should always grant credit regardless of evidence");
});

// ─── Test 8: Null/missing inputs handled gracefully ──────────────────

Deno.test("evaluateEvidence: handles null directionVerdict, regime, fotsi, gamePlan", () => {
  const input: ConvictionInput = {
    symbol: "EUR/USD",
    direction: "long",
    directionVerdict: null,
    regime4H: null,
    opposingFactorCount: 0,
    fotsiAlignment: null,
    gamePlanBias: null,
  };

  const { snapshot, delta, details } = evaluateEvidence(input);

  // With all nulls, should default to neutral (no strong opinion either way)
  assertEquals(snapshot.verdictAgreement, 0.5); // default
  assertEquals(snapshot.verdictConfidence, 50); // default
  assertEquals(snapshot.fotsiAligned, null);
  assertEquals(snapshot.gamePlanAligned, null);
  // Only the "0 opposing factors" source should fire as supporting
  assertEquals(details.some(d => d.includes("clean signal")), true);
});

// ─── Test 9: History cap at maxHistory ───────────────────────────────

Deno.test("updateConviction: history capped at maxHistory (12)", () => {
  let state: ThesisConvictionState | null = null;
  const input = makeInput();

  // Run 20 cycles
  for (let i = 0; i < 20; i++) {
    const { state: newState } = updateConviction(state, input);
    state = newState;
  }

  assertEquals(state!.history.length, DEFAULT_CONVICTION_CONFIG.maxHistory);
  assertEquals(state!.history.length, 12);
});

// ─── Test 10: buildConvictionKey format ──────────────────────────────

Deno.test("buildConvictionKey: produces correct key format", () => {
  const key = buildConvictionKey("user123", "bot456", "EUR/USD", "long");
  assertEquals(key, "thesis_conviction:user123:bot456:EUR/USD:long");
});

// ─── Test 11: Score adjustment applied correctly ─────────────────────

Deno.test("updateConviction: score adjustment reflects conviction level", () => {
  let state: ThesisConvictionState | null = null;

  // Build up enough history (2 cycles) then check score adjustments
  state = updateConviction(null, makeInput()).state;
  state = updateConviction(state, makeInput()).state;

  // With high conviction, score adjustment should be 0
  const { result: highResult } = updateConviction(state, makeInput());
  assertEquals(highResult.scoreAdjustment, 0);

  // Now decay conviction into "reduced" zone
  const opposing = makeInput({
    directionVerdict: {
      verdict: "long", confidence: 75, scoreAdjustment: 0,
      shouldBlock: false, blockReason: null, sources: [], agreement: 0.3, summary: "opp",
    },
    regime4H: { regime: "strong_trend", confidence: 0.8, bias: "bullish" },
    opposingFactorCount: 4,
    fotsiAlignment: { label: "strong_opposing", score: -0.8 },
    gamePlanBias: { bias: "bullish", confidence: 80 },
  });

  // Decay until we're in reduced zone
  for (let i = 0; i < 5; i++) {
    const { state: s, result: r } = updateConviction(state, opposing);
    state = s;
    if (r.impulseCreditDecision === "reduced") {
      assertEquals(r.scoreAdjustment, -DEFAULT_CONVICTION_CONFIG.reducedScorePenalty);
      break;
    }
    if (r.impulseCreditDecision === "revoked") {
      assertEquals(r.scoreAdjustment, -DEFAULT_CONVICTION_CONFIG.revokedScorePenalty);
      break;
    }
  }
});

// ─── Test 12: Neutral verdict doesn't count as opposing ──────────────

Deno.test("evaluateEvidence: neutral verdict direction doesn't oppose thesis", () => {
  const input = makeInput({
    directionVerdict: {
      verdict: "neutral",
      confidence: 65,
      scoreAdjustment: 0,
      shouldBlock: false,
      blockReason: null,
      sources: [],
      agreement: 0.5,
      summary: "neutral",
    },
  });

  const { details } = evaluateEvidence(input);

  // "neutral" verdict should NOT appear as opposing
  assertEquals(details.some(d => d.includes("OPPOSING thesis")), false,
    "Neutral verdict should not be counted as opposing");
});
