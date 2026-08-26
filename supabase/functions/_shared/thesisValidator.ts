/**
 * thesisValidator.ts — Pending Order Thesis Validation
 * ─────────────────────────────────────────────────────
 * Re-checks structural conditions for active pending orders each scan cycle.
 * The complete Direction Verdict comparison is the sole post-placement direction authority.
 * FOTSI and Game Plan remain placement inputs and cannot independently cancel
 *
 * Design principle: FAIL-OPEN. If any check errors or data is missing,
 * the order stays alive. Only cancel on confirmed invalidation.
 *
 * Run: deno test --allow-all supabase/functions/_shared/thesisValidator.test.ts
 */

import { determineDirection, type DirectionResult } from "./directionEngine.ts";
import type { FOTSIResult } from "./fotsi.ts";
import type { Candle } from "./smcAnalysis.ts";
import type { InstrumentGamePlan, SessionGamePlan } from "./gamePlan.ts";
import type { StyleDecisionEvidence } from "./styleDecisionEvidence.ts";

// ── Public types ──

export type ThesisCheckType =
  // Retained so historical rows carrying these labels still parse. Neither is
  // produced any more: "gp_bias_reversal" was removed as a duplicate authority,
  // and "direction_flip" was replaced by the frozen-verdict comparison.
  | "direction_flip"
  | "gp_bias_reversal"
  | "fotsi_veto"
  | "direction_verdict_reversal";

export interface ThesisValidationResult {
  /** Whether the pending order thesis is still valid */
  valid: boolean;
  /** Human-readable reason for invalidation (null if valid) */
  reason: string | null;
  /** Which check triggered the invalidation (null if valid) */
  checkType: ThesisCheckType | null;
  /** Structured cancel reason string for DB storage */
  cancelReason: string | null;
  /** Shared structural evidence version used for this decision. */
  decisionEvidenceVersion?: string | null;
  /** Style-aware bias → structure → setup labels used for this decision. */
  timeframeLabels?: StyleDecisionEvidence["labels"] | null;
  /**
   * Why the directional check reached its conclusion, including the
   * order-kept outcomes. Persisted so the distribution is queryable rather
   * than log-only — baseline_missing quietly dominating would otherwise look
   * identical to a healthy verdict_unchanged.
   */
  verdictOutcome?: VerdictComparisonOutcome;
  verdictReason?: string;
}

export interface PendingOrderForValidation {
  order_id: string;
  symbol: string;
  direction: "long" | "short";
  entry_price: number | string;
  signal_reason?: any;
}

export interface ThesisValidationOpts {
  /**  Compatibility input only. FOTSI is placement-time scoring, not a pending-order veto. */
  fotsiResult: FOTSIResult | null;
  lastGamePlan: SessionGamePlan | null;
  dailyCandles: Candle[] | null;
  h4Candles: Candle[] | null;
  h1Candles: Candle[] | null;
  /** Preferred style-aware structural evidence. Legacy candles are fallback. */
  decisionEvidence?: StyleDecisionEvidence | null;
  /** Minimum confidence for direction flip to trigger cancel (default: 0.6) */
  directionFlipMinConfidence?: number;
  /** Minimum GP bias confidence to trigger cancel (default: 60) */
  gpBiasMinConfidence?: number;
  /** Verdict frozen with the order at placement (frozen_strategy_context.directionVerdict). */
  frozenDirectionVerdict?: { verdict: "long" | "short" | "neutral"; confidence: number } | null;
  /** Verdict recomputed now. Null when it could not be built. */
  currentDirectionVerdict?: { verdict: "long" | "short" | "neutral"; confidence: number } | null;
  /** True only when the current verdict used every source. Partial never cancels. */
  currentDirectionVerdictComplete?: boolean;
  /** Minimum confidence for a reversal to cancel. Defaults to the verdict's own minConfidence. */
  verdictReversalMinConfidence?: number;
}

// ── Constants ──

const DEFAULT_DIRECTION_FLIP_MIN_CONFIDENCE = 0.6;
// Reuses the Direction Verdict's own minConfidence rather than inventing a
// second threshold — one owner, one bar.
const DEFAULT_VERDICT_REVERSAL_MIN_CONFIDENCE = 55;
const MIN_CANDLES_FOR_DIRECTION = 20;

// ── Helpers ──

/**
 * Determine a "confidence" score for the direction result.
 * The direction engine doesn't return a numeric confidence, so we derive one
 * from the structural signals:
 *   - h1Confirmed = +0.3
 *   - h4Retrace = +0.2 (structure intact, pulling back)
 *   - !h4ChochAgainst = +0.2 (no counter-CHoCH)
 *   - direction != null = +0.3 (base confidence)
 */
export function estimateDirectionConfidence(result: DirectionResult): number {
  if (!result.direction) return 0;
  let confidence = 0.3; // base: direction was determined
  if (result.h1Confirmed) confidence += 0.3;
  if (result.h4Retrace) confidence += 0.2;
  if (!result.h4ChochAgainst) confidence += 0.2;
  return confidence;
}

/**
 * Check if a game plan bias opposes the pending order direction.
 */
function biasOpposesDirection(
  bias: "bullish" | "bearish" | "neutral",
  direction: "long" | "short",
): boolean {
  if (bias === "neutral") return false;
  if (direction === "long" && bias === "bearish") return true;
  if (direction === "short" && bias === "bullish") return true;
  return false;
}



export interface VerdictSourceExpectation {
  /** Weekly is a real source ONLY when it is the style's bias role (Swing). */
  weeklyExpected: boolean;
  /** Game Plan is a source only when enforcement is not "off". */
  gamePlanExpected: boolean;
}

export interface VerdictSourcePresence {
  confirmedTrend: boolean;
  simpleDirection: boolean;
  regime: boolean;
  weeklyBias: boolean;
  gamePlan: boolean;
}

export interface DirectionVerdictThesisOptions {
  frozenDirectionVerdict: { verdict: "long" | "short" | "neutral"; confidence: number } | null;
  currentDirectionVerdict: { verdict: "long" | "short" | "neutral"; confidence: number } | null;
  currentDirectionVerdictComplete: boolean;
}

/**
 * Is the recomputed verdict complete?
 *
 * Completeness is relative to what the STYLE consults, not to all five
 * sources. Day Trader and Scalper deliberately exclude Weekly — bot-scanner
 * only supplies it when roles.bias === "1w" — so requiring all five would mark
 * every Day Trader verdict partial and disable directional cancellation
 * permanently while looking like it worked.
 *
 * Both spine sources are required: they determine direction, and a verdict
 * missing one is not the verdict that was frozen.
 */
export function isVerdictComplete(
  present: VerdictSourcePresence,
  expected: VerdictSourceExpectation,
): boolean {
  if (!present.confirmedTrend || !present.simpleDirection) return false;
  if (!present.regime) return false;
  if (expected.weeklyExpected && !present.weeklyBias) return false;
  if (expected.gamePlanExpected && !present.gamePlan) return false;
  return true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeStoredVerdict(
  value: unknown,
  requireExecutable: boolean,
): DirectionVerdictThesisOptions["currentDirectionVerdict"] {
  const verdict = asRecord(value);
  if (verdict.verdict !== "long" && verdict.verdict !== "short" && verdict.verdict !== "neutral") return null;
  const confidence = Number(verdict.confidence);
  if (!Number.isFinite(confidence)) return null;
  if (requireExecutable && verdict.shouldBlock !== false) return null;
  return { verdict: verdict.verdict, confidence };
}

function evidenceMatchesExpectedStyle(
  verdict: unknown,
  expected: Pick<StyleDecisionEvidence, "style" | "roles">,
): boolean {
  const evidence = asRecord(asRecord(verdict).decisionEvidence);
  const roles = asRecord(evidence.roles);
  return evidence.style === expected.style &&
    roles.bias === expected.roles.bias &&
    roles.structure === expected.roles.structure &&
    roles.setup === expected.roles.setup;
}

function sourcePresence(verdict: unknown): VerdictSourcePresence {
  const sources = Array.isArray(asRecord(verdict).sources)
    ? asRecord(verdict).sources as unknown[]
    : [];
  const present = (name: string): boolean => {
    const source = sources.map(asRecord).find((item) => item.name === name);
    return !!source && source.direction !== null && source.direction !== undefined;
  };
  return {
    confirmedTrend: present("confirmedTrend"),
    simpleDirection: present("simpleDirection"),
    regime: present("regime"),
    weeklyBias: present("weeklyBias"),
    gamePlan: present("gamePlan"),
  };
}

/**
 * Adapts persisted verdict records into the existing thesis comparison.
 * This stays in the thesis owner so live and backtest cannot drift.
 */
export function buildDirectionVerdictThesisOptions(input: {
  frozenDirectionVerdict: unknown;
  currentDirectionVerdict: unknown;
  expectedDecisionEvidence: Pick<StyleDecisionEvidence, "style" | "roles">;
  frozenEffectiveConfig?: unknown;
}): DirectionVerdictThesisOptions {
  const frozenMatchesStyle = evidenceMatchesExpectedStyle(
    input.frozenDirectionVerdict,
    input.expectedDecisionEvidence,
  );
  const currentMatchesStyle = evidenceMatchesExpectedStyle(
    input.currentDirectionVerdict,
    input.expectedDecisionEvidence,
  );
  const frozenDirectionVerdict = frozenMatchesStyle
    ? normalizeStoredVerdict(input.frozenDirectionVerdict, false)
    : null;
  const currentDirectionVerdict = currentMatchesStyle
    ? normalizeStoredVerdict(input.currentDirectionVerdict, true)
    : null;
  const frozenConfig = asRecord(input.frozenEffectiveConfig);
  const gamePlanExpectationIsFrozen =
    "gamePlanEnabled" in frozenConfig || "gpEnforcementMode" in frozenConfig;
  const frozenSources = sourcePresence(input.frozenDirectionVerdict);
  const gamePlanExpected = gamePlanExpectationIsFrozen
    ? frozenConfig.gamePlanEnabled !== false && frozenConfig.gpEnforcementMode !== "off"
    : frozenSources.gamePlan;

  return {
    frozenDirectionVerdict,
    currentDirectionVerdict,
    currentDirectionVerdictComplete: currentDirectionVerdict !== null &&
      isVerdictComplete(sourcePresence(input.currentDirectionVerdict), {
        weeklyExpected: input.expectedDecisionEvidence.roles.bias === "1w",
        gamePlanExpected,
      }),
  };
}

// ── Direction Verdict comparison — the sole post-placement direction authority ──
//
// Thesis validation must answer "has the world changed since we committed?",
// not "would we place this trade now?". The old Check 3 compared the current
// direction against the order direction ABSOLUTELY, so an order placed against
// a disagreement failed on every evaluation — the same re-litigation that made
// the Game Plan check cancel 203 orders for a bias that never moved.
//
// Comparison is now frozen-verdict versus current verdict, and only a genuine
// confident reversal cancels.

export type VerdictComparisonOutcome =
  | "baseline_missing"
  | "current_verdict_partial"
  | "verdict_neutral"
  | "verdict_unchanged"
  | "confident_reversal";

export interface VerdictComparisonInput {
  /** The verdict frozen with the order at placement. */
  frozen: { verdict: "long" | "short" | "neutral"; confidence: number } | null;
  /** The verdict recomputed now, or null when it could not be built at all. */
  current: { verdict: "long" | "short" | "neutral"; confidence: number } | null;
  /**
   * Whether `current` was built from ALL verdict sources.
   *
   * A partial verdict must never cancel, even when its confidence clears the
   * bar. Agreement is an unweighted headcount — agreeing/directionalSources —
   * so dropping an OPPOSING source raises agreement and removes its confidence
   * penalty. A verdict missing Weekly and Game Plan can therefore be MORE
   * confident than the complete one it replaces. Partial evaluation is
   * diagnostic only.
   */
  complete: boolean;
  minConfidence: number;
}

export interface VerdictComparison {
  outcome: VerdictComparisonOutcome;
  shouldCancel: boolean;
  reason: string;
}

/**
 * Single comparison used by every caller.
 *
 * All six thesis-validation call sites, including the one-minute confirmation
 * scanner, route through this. A shortcut in any one of them would be a second
 * directional authority, which is the problem being removed.
 */
export function compareDirectionVerdicts(
  input: VerdictComparisonInput,
): VerdictComparison {
  if (!input.frozen || input.frozen.verdict === "neutral") {
    // Orders placed before the verdict was frozen have no baseline. Treating
    // "no baseline" as "changed" would cancel the entire open book on deploy.
    return {
      outcome: "baseline_missing",
      shouldCancel: false,
      reason: "no frozen verdict to compare against — order kept",
    };
  }
  if (!input.current) {
    return {
      outcome: "current_verdict_partial",
      shouldCancel: false,
      reason: "current verdict unavailable — order kept",
    };
  }
  if (!input.complete) {
    return {
      outcome: "current_verdict_partial",
      shouldCancel: false,
      reason:
        "current verdict built from incomplete sources — diagnostic only, order kept",
    };
  }
  if (input.current.verdict === "neutral") {
    // The panel cannot agree. That is not a reversal.
    return {
      outcome: "verdict_neutral",
      shouldCancel: false,
      reason: "current verdict is neutral — no reversal, order kept",
    };
  }
  if (input.current.verdict === input.frozen.verdict) {
    return {
      outcome: "verdict_unchanged",
      shouldCancel: false,
      reason: `verdict still ${input.current.verdict} — order kept`,
    };
  }
  if (input.current.confidence < input.minConfidence) {
    return {
      outcome: "verdict_neutral",
      shouldCancel: false,
      reason:
        `verdict opposes frozen but confidence ${input.current.confidence.toFixed(0)}% < ${input.minConfidence}% — order kept`,
    };
  }
  return {
    outcome: "confident_reversal",
    shouldCancel: true,
    reason:
      `Direction Verdict reversed: ${input.frozen.verdict} at placement → ${input.current.verdict} now (confidence ${input.current.confidence.toFixed(0)}%)`,
  };
}

// ── Main validation function ──

/**
 * Validate whether a pending order's original thesis is still intact.
 *
 * Runs three checks in order (cheapest first):
 *   1. FOTSI veto (no extra API calls — uses pre-computed result)
 *   2. GP bias reversal (no extra API calls — uses pre-loaded game plan)
 *   3. Direction flip (requires candle data — may use cached candles)
 *
 * Returns { valid: true } if all checks pass or if data is unavailable (fail-open).
 */
export function validatePendingOrderThesis(
  pending: PendingOrderForValidation,
  opts: ThesisValidationOpts,
): ThesisValidationResult {
  const dirFlipMinConf = opts.directionFlipMinConfidence ??
    DEFAULT_DIRECTION_FLIP_MIN_CONFIDENCE;
  const verdictMinConf = opts.verdictReversalMinConfidence ??
    DEFAULT_VERDICT_REVERSAL_MIN_CONFIDENCE;

  const validResult: ThesisValidationResult = {
    valid: true,
    reason: null,
    checkType: null,
    cancelReason: null,
    decisionEvidenceVersion: opts.decisionEvidence?.version || null,
    timeframeLabels: opts.decisionEvidence?.labels || null,
  };
  const invalidResult = (
    result: Omit<
      ThesisValidationResult,
      "decisionEvidenceVersion" | "timeframeLabels"
    >,
  ): ThesisValidationResult => ({
    ...result,
    decisionEvidenceVersion: opts.decisionEvidence?.version || null,
    timeframeLabels: opts.decisionEvidence?.labels || null,
  });

  // FOTSI HARD CANCEL REMOVED. Gate 17 deliberately treats exhaustion as a
  // score penalty. Re-applying it here as an unconditional veto gave it more
  // authority after placement than it had when the order was accepted. The
  // compatibility option remains temporarily, but is intentionally not read.

  // ── Check 2: REMOVED — Game Plan no longer cancels independently ──
  //
  // Game Plan used to hard-cancel any pending order whose direction opposed the
  // plan bias at >= 60% confidence. That killed 203 of 1,047 cancelled orders,
  // and the data showed the bias was not flipping — the same "bullish 64%" was
  // cancelling the same short across Asian, London and New York. The order was
  // placed against that bias and then repeatedly killed for it. Nothing changed;
  // the check simply re-decided the entry on every pass.
  //
  // Game Plan is already an input to the Direction Verdict at weight 0.08, the
  // lowest of five and explicitly labelled advisory. Cancelling on it separately
  // counted the same evidence twice and gave an advisory signal more authority
  // AFTER placement than it had at placement.
  //
  // Its evidence is unchanged and still contributes through the verdict. Only
  // the duplicate authority is gone. See Check 3.

  // ── Check 3: Direction Verdict reversal (sole directional authority) ──
  //
  // Compares the frozen verdict captured at placement against the verdict now.
  // Only a complete, confident, opposing verdict cancels. Every other outcome
  // keeps the order and is recorded so the distribution is queryable — the
  // 511/300/203 breakdown that found this bug came out of cancel_reason, not
  // logs.
  const verdictComparison = compareDirectionVerdicts({
    frozen: opts.frozenDirectionVerdict ?? null,
    current: opts.currentDirectionVerdict ?? null,
    complete: opts.currentDirectionVerdictComplete === true,
    minConfidence: verdictMinConf,
  });

  if (verdictComparison.shouldCancel) {
    return invalidResult({
      valid: false,
      reason: verdictComparison.reason,
      checkType: "direction_verdict_reversal",
      cancelReason: `thesis_invalid:direction_verdict_reversal:${
        opts.currentDirectionVerdict?.verdict
      }:${(opts.currentDirectionVerdict?.confidence ?? 0).toFixed(0)}`,
    });
  }

  validResult.verdictOutcome = verdictComparison.outcome;
  validResult.verdictReason = verdictComparison.reason;
  return validResult;
}
