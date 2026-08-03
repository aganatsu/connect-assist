export const STREAMLINED_TRADE_DECISION_VERSION =
  "streamlined-trade-decision.v1";

export type StreamlinedDirection = "long" | "short" | "neutral";
export type ConfidenceBand = "high" | "medium" | "low" | "unavailable";
export type SetupQualityPillar =
  | "structure"
  | "location"
  | "confirmation"
  | "timing";
export type ThesisHealth = "healthy" | "weakening" | "invalid" | "unavailable";
export type SafetyState = "passed" | "blocked" | "unavailable";
export type ProposedTradeDecision = "allow" | "watch" | "block" | "unavailable";

export interface DecisionEvidenceReference {
  source: string;
  id?: string | null;
  version?: string | null;
  observedAt?: string | null;
}

export interface SetupQualityPillarInput {
  score: number | null;
  complete: boolean;
  evidence: DecisionEvidenceReference[];
  reasonCodes: string[];
}

export interface StreamlinedTradeDecisionInput {
  evaluatedAt: string;
  identity: {
    candidateId: string;
    symbol: string;
    direction: "long" | "short" | null;
    stage: "candidate" | "watchlist" | "pending" | "fill" | "position" | "closed";
  };
  authority: {
    stylePolicyVersion?: string | null;
    stylePolicyHash?: string | null;
    styleBasePolicyHash?: string | null;
    timeframeEvidenceId?: string | null;
    gamePlanId?: string | null;
    gamePlanVersion?: string | null;
    directionVerdictVersion?: string | null;
  };
  direction: {
    verdict: StreamlinedDirection | null;
    confidence: number | null;
    shouldBlock: boolean | null;
    reasonCodes: string[];
    evidence: DecisionEvidenceReference[];
  };
  setupQuality: {
    threshold: number | null;
    pillars: Record<SetupQualityPillar, SetupQualityPillarInput>;
    evidenceMapping: {
      version: string;
      complete: boolean;
      unmappedFactors: string[];
      excludedEvidence: DecisionEvidenceReference[];
    };
    legacyDiagnostics?: {
      rawScore?: number | null;
      effectiveScore?: number | null;
      threshold?: number | null;
    } | null;
  };
  thesis: {
    validationRequired: boolean;
    valid: boolean | null;
    conviction: number | null;
    degrading: boolean | null;
    reasonCodes: string[];
    evidence: DecisionEvidenceReference[];
  };
  confirmation: {
    required: boolean;
    passed: boolean | null;
    reasonCodes: string[];
    evidence: DecisionEvidenceReference[];
  };
  safety: {
    complete: boolean;
    evidence: DecisionEvidenceReference[];
    checks: Array<{
      code: string;
      passed: boolean;
      evidence?: DecisionEvidenceReference | null;
    }>;
  };
}

export interface SetupQualityPillarResult extends SetupQualityPillarInput {
  maximum: 25;
}

export interface TradeDecisionSummary {
  contractVersion: typeof STREAMLINED_TRADE_DECISION_VERSION;
  observationOnly: true;
  affectsAuthorization: false;
  evaluatedAt: string;
  identity: StreamlinedTradeDecisionInput["identity"];
  authority: StreamlinedTradeDecisionInput["authority"];
  direction: {
    verdict: StreamlinedDirection | null;
    confidence: number | null;
    confidenceBand: ConfidenceBand;
    blocked: boolean | null;
    reasonCodes: string[];
    evidence: DecisionEvidenceReference[];
  };
  setupQuality: {
    score: number | null;
    maximum: 100;
    threshold: number | null;
    passed: boolean | null;
    pillars: Record<SetupQualityPillar, SetupQualityPillarResult>;
    evidenceMapping: {
      version: string;
      complete: boolean;
      unmappedFactors: string[];
      excludedEvidence: DecisionEvidenceReference[];
    };
    legacyDiagnostics: {
      rawScore: number | null;
      effectiveScore: number | null;
      threshold: number | null;
    };
  };
  thesisHealth: {
    state: ThesisHealth;
    conviction: number | null;
    reasonCodes: string[];
    evidence: DecisionEvidenceReference[];
  };
  confirmation: {
    required: boolean;
    passed: boolean | null;
    reasonCodes: string[];
    evidence: DecisionEvidenceReference[];
  };
  safetyAuthorization: {
    state: SafetyState;
    evidence: DecisionEvidenceReference[];
    checks: Array<{
      code: string;
      passed: boolean;
      evidence?: DecisionEvidenceReference | null;
    }>;
  };
  proposedDecision: {
    decision: ProposedTradeDecision;
    reasonCodes: string[];
  };
  completeness: {
    complete: boolean;
    coveragePercent: number;
    unavailable: string[];
  };
}

const PILLARS: SetupQualityPillar[] = [
  "structure",
  "location",
  "confirmation",
  "timing",
];

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bounded(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = finiteOrNull(value);
  if (parsed === null) return null;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function confidenceBand(confidence: number | null): ConfidenceBand {
  if (confidence === null) return "unavailable";
  if (confidence >= 75) return "high";
  if (confidence >= 55) return "medium";
  return "low";
}

function normalizePillars(
  inputs: Record<SetupQualityPillar, SetupQualityPillarInput>,
): Record<SetupQualityPillar, SetupQualityPillarResult> {
  return Object.fromEntries(PILLARS.map((pillar) => {
    const input = inputs[pillar];
    return [pillar, {
      maximum: 25 as const,
      score: bounded(input?.score, 0, 25),
      complete: input?.complete === true &&
        bounded(input?.score, 0, 25) !== null,
      evidence: input?.evidence || [],
      reasonCodes: uniqueSorted(input?.reasonCodes || []),
    }];
  })) as Record<SetupQualityPillar, SetupQualityPillarResult>;
}

function resolveThesisHealth(
  input: StreamlinedTradeDecisionInput["thesis"],
): ThesisHealth {
  if (input.validationRequired && input.valid === false) return "invalid";
  if (input.validationRequired && input.valid === null) return "unavailable";
  if (input.degrading === true) return "weakening";
  const conviction = bounded(input.conviction, 0, 100);
  if (conviction !== null && conviction < 60) return "weakening";
  if (input.valid === true || !input.validationRequired) return "healthy";
  return "unavailable";
}

function resolveSafety(
  input: StreamlinedTradeDecisionInput["safety"],
): SafetyState {
  if (input.checks.some((check) => !check.passed)) return "blocked";
  if (!input.complete) return "unavailable";
  return "passed";
}

export function evaluateStreamlinedTradeDecision(
  input: StreamlinedTradeDecisionInput,
): TradeDecisionSummary {
  const unavailable: string[] = [];
  const directionConfidence = bounded(input.direction.confidence, 0, 100);
  const directionVerdict = input.direction.verdict;
  const directionBlocked = input.direction.shouldBlock === null
    ? null
    : input.direction.shouldBlock === true ||
      input.direction.verdict === "neutral";
  if (!directionVerdict || directionBlocked === null) {
    unavailable.push("direction");
  }

  const pillars = normalizePillars(input.setupQuality.pillars);
  if (!input.setupQuality.evidenceMapping.complete) {
    unavailable.push("setup_quality.mapping");
  }
  for (const pillar of PILLARS) {
    if (!pillars[pillar].complete) unavailable.push(`setup_quality.${pillar}`);
  }
  const setupThreshold = bounded(input.setupQuality.threshold, 0, 100);
  if (setupThreshold === null) unavailable.push("setup_quality.threshold");
  const setupComplete = input.setupQuality.evidenceMapping.complete &&
    PILLARS.every((pillar) => pillars[pillar].complete) &&
    setupThreshold !== null;
  const setupScore = setupComplete
    ? PILLARS.reduce((total, pillar) => total + (pillars[pillar].score || 0), 0)
    : null;
  const setupPassed = setupScore === null || setupThreshold === null
    ? null
    : setupScore >= setupThreshold;

  const thesisState = resolveThesisHealth(input.thesis);
  if (thesisState === "unavailable") unavailable.push("thesis_health");

  const confirmationPassed = input.confirmation.required
    ? input.confirmation.passed
    : true;
  if (input.confirmation.required && confirmationPassed === null) {
    unavailable.push("entry_confirmation");
  }

  const safetyState = resolveSafety(input.safety);
  if (safetyState === "unavailable") unavailable.push("safety_authorization");

  let decision: ProposedTradeDecision = "unavailable";
  let decisionReasons: string[] = [];
  if (directionBlocked === true) {
    decision = "block";
    decisionReasons = ["direction_blocked"];
  } else if (thesisState === "invalid") {
    decision = "block";
    decisionReasons = ["thesis_invalid"];
  } else if (safetyState === "blocked") {
    decision = "block";
    decisionReasons = input.safety.checks
      .filter((check) => !check.passed)
      .map((check) => `safety.${check.code}`);
  } else if (unavailable.length > 0) {
    decisionReasons = ["evidence_incomplete"];
  } else if (setupPassed === false) {
    decision = "watch";
    decisionReasons = ["setup_quality_below_threshold"];
  } else if (confirmationPassed === false) {
    decision = "watch";
    decisionReasons = ["entry_confirmation_pending"];
  } else if (thesisState === "weakening") {
    decision = "watch";
    decisionReasons = ["thesis_weakening"];
  } else {
    decision = "allow";
    decisionReasons = ["all_layers_passed"];
  }

  const unavailableFields = uniqueSorted(unavailable);
  const requiredSections = 8;
  const completeSections = [
    !!directionVerdict && directionBlocked !== null,
    pillars.structure.complete,
    pillars.location.complete,
    pillars.confirmation.complete,
    pillars.timing.complete,
    thesisState !== "unavailable",
    !input.confirmation.required || confirmationPassed !== null,
    safetyState !== "unavailable",
  ].filter(Boolean).length;

  return {
    contractVersion: STREAMLINED_TRADE_DECISION_VERSION,
    observationOnly: true,
    affectsAuthorization: false,
    evaluatedAt: input.evaluatedAt,
    identity: { ...input.identity },
    authority: { ...input.authority },
    direction: {
      verdict: directionVerdict,
      confidence: directionConfidence,
      confidenceBand: confidenceBand(directionConfidence),
      blocked: directionBlocked,
      reasonCodes: uniqueSorted(input.direction.reasonCodes),
      evidence: input.direction.evidence,
    },
    setupQuality: {
      score: setupScore,
      maximum: 100,
      threshold: setupThreshold,
      passed: setupPassed,
      pillars,
      evidenceMapping: {
        version: input.setupQuality.evidenceMapping.version,
        complete: input.setupQuality.evidenceMapping.complete,
        unmappedFactors: uniqueSorted(
          input.setupQuality.evidenceMapping.unmappedFactors,
        ),
        excludedEvidence: input.setupQuality.evidenceMapping.excludedEvidence,
      },
      legacyDiagnostics: {
        rawScore: finiteOrNull(input.setupQuality.legacyDiagnostics?.rawScore),
        effectiveScore: finiteOrNull(
          input.setupQuality.legacyDiagnostics?.effectiveScore,
        ),
        threshold: finiteOrNull(
          input.setupQuality.legacyDiagnostics?.threshold,
        ),
      },
    },
    thesisHealth: {
      state: thesisState,
      conviction: bounded(input.thesis.conviction, 0, 100),
      reasonCodes: uniqueSorted(input.thesis.reasonCodes),
      evidence: input.thesis.evidence,
    },
    confirmation: {
      required: input.confirmation.required,
      passed: confirmationPassed,
      reasonCodes: uniqueSorted(input.confirmation.reasonCodes),
      evidence: input.confirmation.evidence,
    },
    safetyAuthorization: {
      state: safetyState,
      evidence: input.safety.evidence,
      checks: [...input.safety.checks].sort((a, b) =>
        a.code.localeCompare(b.code)
      ),
    },
    proposedDecision: {
      decision,
      reasonCodes: uniqueSorted(decisionReasons),
    },
    completeness: {
      complete: unavailableFields.length === 0,
      coveragePercent: Math.round((completeSections / requiredSections) * 1000) /
        10,
      unavailable: unavailableFields,
    },
  };
}
