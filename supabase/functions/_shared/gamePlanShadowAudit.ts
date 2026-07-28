export type ShadowDecision = "eligible" | "wait" | "skip";
export type ShadowRiskBand = "none" | "reduced" | "normal" | "full";

export interface ShadowPlanInput {
  bias?: "bullish" | "bearish" | "neutral" | string | null;
  legacyConfidence?: number | null;
  state?: "tradeable" | "wait" | "skip" | string | null;
  stateReason?: string | null;
  tradeable?: boolean | null;
  conviction?: {
    confidence?: number | null;
    directionalStrength?: number | null;
    evidenceCoverage?: number | null;
    planQuality?: number | null;
  } | null;
}

export interface ShadowImpulseZoneInput {
  hasZone: boolean;
  entryReady: boolean;
  score?: number | null;
  fibDepth?: number | null;
  selectedTimeframe?: string | null;
  isFresh?: boolean | null;
  impulseEndDate?: string | null;
  impulseSpanBars?: number | null;
}

export interface GamePlanShadowAuditInput {
  plan: ShadowPlanInput | null;
  direction: "long" | "short" | null;
  directionVerdict?: {
    verdict?: "long" | "short" | "neutral" | string | null;
    confidence?: number | null;
    shouldBlock?: boolean | null;
  } | null;
  impulseZone?: ShadowImpulseZoneInput | null;
}

export interface GamePlanShadowAuditResult {
  version: "gameplan-shadow-v1";
  decision: ShadowDecision;
  riskBand: ShadowRiskBand;
  signalDirection: "long" | "short" | null;
  permittedDirection: "long" | "short" | null;
  aligned: boolean;
  reasons: string[];
  metrics: {
    biasSupport: number;
    actionableConviction: number;
    directionalEdge: number;
    inputCoverage: number;
    planCoherence: number;
  };
  planState: string;
  directionVerdict: {
    verdict: string | null;
    confidence: number;
    shouldBlock: boolean;
  } | null;
  impulseZone: ShadowImpulseZoneInput | null;
  currentSystem?: {
    decision: "allow" | "block" | "not_evaluated";
    reason: string | null;
  };
}

const pct = (value: number | null | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
};

/**
 * Evaluate the proposed Gameplan hierarchy in shadow mode.
 *
 * This function is observational only. The scanner persists its result for
 * later comparison but never uses it to permit, block, size, or place a trade.
 */
export function evaluateGamePlanShadowAudit(
  input: GamePlanShadowAuditInput,
): GamePlanShadowAuditResult {
  const plan = input.plan;
  const conviction = plan?.conviction;
  const actionableConviction = pct(conviction?.confidence);
  const metrics = {
    biasSupport: pct(plan?.legacyConfidence),
    actionableConviction,
    directionalEdge: pct(conviction?.directionalStrength),
    inputCoverage: pct(conviction?.evidenceCoverage),
    planCoherence: pct(conviction?.planQuality),
  };
  const planState = plan?.state
    || (plan?.tradeable === false ? "skip" : plan?.tradeable === true ? "tradeable" : "missing");
  const permittedDirection = plan?.bias === "bullish"
    ? "long"
    : plan?.bias === "bearish"
      ? "short"
      : null;
  const verdictDirection = input.directionVerdict?.verdict;
  const aligned = !!input.direction
    && !!permittedDirection
    && input.direction === permittedDirection
    && (!verdictDirection || verdictDirection === input.direction);
  const reasons: string[] = [];

  let decision: ShadowDecision = "eligible";
  if (!plan) {
    decision = "skip";
    reasons.push("No active per-pair Gameplan");
  } else if (!permittedDirection) {
    decision = "skip";
    reasons.push("Gameplan has no directional permission");
  } else if (planState === "skip" || plan.tradeable === false) {
    decision = "skip";
    reasons.push(plan.stateReason || "Gameplan marks the pair as skip");
  } else if (planState === "wait") {
    decision = "wait";
    reasons.push(plan.stateReason || "Gameplan requires more evidence");
  }

  if (decision !== "skip" && actionableConviction < 25) {
    decision = "skip";
    reasons.push(`Actionable conviction ${actionableConviction}% is below the 25% shadow floor`);
  } else if (decision === "eligible" && actionableConviction < 50) {
    decision = "wait";
    reasons.push(`Actionable conviction ${actionableConviction}% is below the 50% shadow eligibility level`);
  }

  if (decision !== "skip" && input.directionVerdict?.shouldBlock) {
    decision = "wait";
    reasons.push("Direction Verdict currently blocks or is neutral");
  } else if (decision !== "skip" && !aligned) {
    decision = "wait";
    reasons.push("Gameplan direction and Direction Verdict are not aligned");
  }

  if (decision === "eligible" && !input.impulseZone?.hasZone) {
    decision = "wait";
    reasons.push("No valid Impulse Zone is available");
  } else if (decision === "eligible" && !input.impulseZone?.entryReady) {
    decision = "wait";
    reasons.push("Impulse Zone exists but entry conditions are not ready");
  }

  const riskBand: ShadowRiskBand = decision !== "eligible"
    ? "none"
    : actionableConviction >= 80
      ? "full"
      : actionableConviction >= 65
        ? "normal"
        : "reduced";

  if (decision === "eligible" && reasons.length === 0) {
    reasons.push(`Aligned ${permittedDirection?.toUpperCase()} plan with a ready Impulse Zone`);
  }

  return {
    version: "gameplan-shadow-v1",
    decision,
    riskBand,
    signalDirection: input.direction,
    permittedDirection,
    aligned,
    reasons,
    metrics,
    planState,
    directionVerdict: input.directionVerdict ? {
      verdict: input.directionVerdict.verdict || null,
      confidence: pct(input.directionVerdict.confidence),
      shouldBlock: input.directionVerdict.shouldBlock === true,
    } : null,
    impulseZone: input.impulseZone || null,
    currentSystem: {
      decision: "not_evaluated",
      reason: null,
    },
  };
}

export function finalizeShadowCurrentDecision(
  audit: GamePlanShadowAuditResult | null | undefined,
  decision: "allow" | "block",
  reason?: string | null,
): GamePlanShadowAuditResult | null {
  if (!audit) return null;
  return {
    ...audit,
    currentSystem: {
      decision,
      reason: reason || null,
    },
  };
}
