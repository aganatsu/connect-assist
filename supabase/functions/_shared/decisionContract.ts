import {
  evaluateGamePlanGate,
  type GamePlanEnforcementMode,
} from "./gamePlanGate.ts";
import type { SessionGamePlan } from "./gamePlan.ts";
import type { ThesisValidationResult } from "./thesisValidator.ts";
import type { ResolvedStylePolicy } from "./stylePolicy.ts";
import type { StyleDecisionEvidence } from "./styleDecisionEvidence.ts";

export const TRADE_DECISION_CONTRACT_VERSION = "phase3.v2";

export interface DirectionVerdictDecision {
  id?: string | null;
  verdictVersion?: string | null;
  gamePlanId?: string | null;
  gamePlanVersion?: string | null;
  verdict?: "long" | "short" | "neutral" | string | null;
  shouldBlock?: boolean | null;
  blockReason?: string | null;
  confidence?: number | null;
  agreement?: number | null;
  scoreAdjustment?: number | null;
  summary?: string | null;
  sources?: unknown[] | null;
  evaluatedAt?: string | null;
  expiresAt?: string | null;
  sourceCandleTimestamp?: string | null;
  stylePolicy?: ResolvedStylePolicy | null;
  decisionEvidence?: StyleDecisionEvidence | null;
}

export interface EntryConfirmationDecision {
  required: boolean;
  passed: boolean;
  method: string;
  reason: string;
  evidence?: Record<string, unknown> | null;
  evaluatedAt: string;
}

export type DecisionHierarchyCode =
  | "game_plan_blocked"
  | "direction_unavailable"
  | "direction_blocked"
  | "direction_conflict"
  | "thesis_unavailable"
  | "thesis_invalid"
  | "confirmation_unavailable"
  | "confirmation_blocked"
  | "decision_hierarchy_passed";

export interface DecisionHierarchyCheck {
  layer:
    | "game_plan"
    | "direction_verdict"
    | "thesis_validity"
    | "entry_confirmation";
  passed: boolean;
  reason: string;
}

export interface DecisionHierarchyResult {
  passed: boolean;
  code: DecisionHierarchyCode;
  reason: string;
  retryable: boolean;
  checks: DecisionHierarchyCheck[];
}

export interface DecisionHierarchyInput {
  symbol: string;
  direction: "long" | "short";
  gamePlan: SessionGamePlan | null;
  gamePlanEnabled: boolean;
  gamePlanMode: GamePlanEnforcementMode;
  gamePlanMinimumConfidence: number;
  directionVerdict: DirectionVerdictDecision | null;
  requireDirectionVerdict: boolean;
  thesisResult: ThesisValidationResult | null;
  requireThesisValidation: boolean;
  entryConfirmation?: EntryConfirmationDecision | null;
}

function blocked(
  code: DecisionHierarchyCode,
  reason: string,
  retryable: boolean,
  checks: DecisionHierarchyCheck[],
): DecisionHierarchyResult {
  return { passed: false, code, reason, retryable, checks };
}

/**
 * The single ordered contract for the four strategy-decision layers.
 *
 * Gameplan supplies context, Direction Verdict supplies direction, thesis
 * validity protects the original idea, and confirmation supplies timing.
 * No later layer can override a failure from an earlier layer.
 */
export function evaluateDecisionHierarchy(
  input: DecisionHierarchyInput,
): DecisionHierarchyResult {
  const checks: DecisionHierarchyCheck[] = [];

  if (input.gamePlanEnabled) {
    const decision = evaluateGamePlanGate(
      input.gamePlan,
      input.symbol,
      input.direction,
      input.gamePlanMode,
      input.gamePlanMinimumConfidence,
    );
    checks.push({
      layer: "game_plan",
      passed: decision.passed,
      reason: decision.reason,
    });
    if (!decision.passed) {
      return blocked(
        "game_plan_blocked",
        decision.reason,
        true,
        checks,
      );
    }
  } else {
    checks.push({
      layer: "game_plan",
      passed: true,
      reason: "Gameplan is disabled; it supplies no execution authority",
    });
  }

  if (input.requireDirectionVerdict) {
    const verdict = input.directionVerdict;
    if (!verdict || !verdict.verdict) {
      const reason = "Current Direction Verdict is unavailable";
      checks.push({ layer: "direction_verdict", passed: false, reason });
      return blocked("direction_unavailable", reason, true, checks);
    }
    if (verdict.shouldBlock === true || verdict.verdict === "neutral") {
      const reason = verdict.blockReason ||
        "Current Direction Verdict blocks execution";
      checks.push({ layer: "direction_verdict", passed: false, reason });
      return blocked("direction_blocked", reason, true, checks);
    }
    if (verdict.verdict !== input.direction) {
      const reason =
        `Current Direction Verdict is ${verdict.verdict}, but the candidate is ${input.direction}`;
      checks.push({ layer: "direction_verdict", passed: false, reason });
      return blocked("direction_conflict", reason, true, checks);
    }
    checks.push({
      layer: "direction_verdict",
      passed: true,
      reason: `Direction Verdict authorizes ${input.direction}${
        Number.isFinite(verdict.confidence)
          ? ` (${verdict.confidence}% confidence)`
          : ""
      }`,
    });
  } else {
    checks.push({
      layer: "direction_verdict",
      passed: true,
      reason: "Direction Verdict is not required for this observation",
    });
  }

  if (input.requireThesisValidation) {
    if (!input.thesisResult) {
      const reason = "Fresh thesis validation is unavailable";
      checks.push({ layer: "thesis_validity", passed: false, reason });
      return blocked("thesis_unavailable", reason, true, checks);
    }
    if (!input.thesisResult.valid) {
      const reason = input.thesisResult.reason ||
        "The trade thesis is no longer valid";
      checks.push({ layer: "thesis_validity", passed: false, reason });
      return blocked("thesis_invalid", reason, false, checks);
    }
    checks.push({
      layer: "thesis_validity",
      passed: true,
      reason: "Fresh thesis validation passed",
    });
  } else {
    checks.push({
      layer: "thesis_validity",
      passed: true,
      reason: "Thesis validity is not required for this observation",
    });
  }

  const confirmation = input.entryConfirmation;
  if (confirmation?.required) {
    if (!confirmation.method) {
      const reason = "Entry confirmation method is unavailable";
      checks.push({ layer: "entry_confirmation", passed: false, reason });
      return blocked("confirmation_unavailable", reason, true, checks);
    }
    if (!confirmation.passed) {
      checks.push({
        layer: "entry_confirmation",
        passed: false,
        reason: confirmation.reason,
      });
      return blocked(
        "confirmation_blocked",
        confirmation.reason,
        true,
        checks,
      );
    }
    checks.push({
      layer: "entry_confirmation",
      passed: true,
      reason: confirmation.reason,
    });
  } else {
    checks.push({
      layer: "entry_confirmation",
      passed: true,
      reason: confirmation?.reason ||
        "Entry confirmation is not required at this stage",
    });
  }

  return {
    passed: true,
    code: "decision_hierarchy_passed",
    reason:
      "Gameplan context, Direction Verdict, thesis validity and entry timing agree",
    retryable: false,
    checks,
  };
}

export interface TradeDecisionContext {
  contractVersion: typeof TRADE_DECISION_CONTRACT_VERSION;
  stage: "candidate" | "pending" | "fill";
  symbol: string;
  direction: "long" | "short";
  evaluatedAt: string;
  stylePolicy: ResolvedStylePolicy | null;
  decisionEvidence: StyleDecisionEvidence | null;
  gamePlan: {
    id: string | null;
    version: string | null;
    session: string | null;
    state: string | null;
    bias: string | null;
    confidence: number | null;
    generatedAt: string | null;
    expiresAt: string | null;
  };
  directionVerdict: DirectionVerdictDecision | null;
  thesisValidity: {
    required: boolean;
    valid: boolean | null;
    reason: string | null;
    checkType: string | null;
    cancelReason: string | null;
    evaluatedAt: string;
  };
  thesisConviction: {
    observational: true;
    affectsAuthorization: false;
    evidence: Record<string, unknown> | null;
  };
  entryConfirmation: EntryConfirmationDecision | null;
  hierarchy: DecisionHierarchyResult;
}

export function buildTradeDecisionContext(input: {
  stage: TradeDecisionContext["stage"];
  symbol: string;
  direction: "long" | "short";
  gamePlan: SessionGamePlan | null;
  directionVerdict: DirectionVerdictDecision | null;
  thesisResult: ThesisValidationResult | null;
  requireThesisValidation: boolean;
  thesisConviction?: Record<string, unknown> | null;
  entryConfirmation?: EntryConfirmationDecision | null;
  hierarchy: DecisionHierarchyResult;
  stylePolicy?: ResolvedStylePolicy | null;
  evaluatedAt?: string;
}): TradeDecisionContext {
  const evaluatedAt = input.evaluatedAt || new Date().toISOString();
  const pairPlan = input.gamePlan?.plans?.find((plan) =>
    plan.symbol === input.symbol
  );
  return {
    contractVersion: TRADE_DECISION_CONTRACT_VERSION,
    stage: input.stage,
    symbol: input.symbol,
    direction: input.direction,
    evaluatedAt,
    stylePolicy: input.stylePolicy || null,
    decisionEvidence: input.directionVerdict?.decisionEvidence ||
      pairPlan?.decisionEvidence ||
      null,
    gamePlan: {
      id: pairPlan?.gamePlanId || null,
      version: pairPlan?.planVersion || input.gamePlan?.planVersion || null,
      session: input.gamePlan?.session || null,
      state: pairPlan?.state ||
        (pairPlan?.tradeable ? "tradeable" : pairPlan ? "skip" : null),
      bias: pairPlan?.bias || null,
      confidence: Number.isFinite(pairPlan?.biasConfidence)
        ? Number(pairPlan?.biasConfidence)
        : null,
      generatedAt: pairPlan?.generatedAt ||
        input.gamePlan?.generatedAt ||
        null,
      expiresAt: pairPlan?.expiresAt || null,
    },
    directionVerdict: input.directionVerdict
      ? { ...input.directionVerdict }
      : null,
    thesisValidity: {
      required: input.requireThesisValidation,
      valid: input.thesisResult?.valid ?? null,
      reason: input.thesisResult?.reason ?? null,
      checkType: input.thesisResult?.checkType ?? null,
      cancelReason: input.thesisResult?.cancelReason ?? null,
      evaluatedAt,
    },
    thesisConviction: {
      observational: true,
      affectsAuthorization: false,
      evidence: input.thesisConviction || null,
    },
    entryConfirmation: input.entryConfirmation
      ? { ...input.entryConfirmation }
      : null,
    hierarchy: input.hierarchy,
  };
}

export function attachDecisionContext<
  T extends object,
>(
  decision: T,
  decisionContext: TradeDecisionContext,
): T & { decisionContext: TradeDecisionContext } {
  return { ...decision, decisionContext };
}
