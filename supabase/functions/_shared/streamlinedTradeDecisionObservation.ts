import { normalizeRejectedGate } from "./rejectedSetupLogger.ts";
import {
  evaluateStreamlinedTradeDecision,
  type DecisionEvidenceReference,
  type SetupQualityPillar,
  type TradeDecisionSummary,
} from "./streamlinedTradeDecision.ts";
import {
  mapLegacyFactorsToPillars,
  STREAMLINED_EVIDENCE_REGISTRY_VERSION,
  type LegacyFactorObservation,
  type PillarEvidenceMappingResult,
} from "./streamlinedEvidenceRegistry.ts";

const SAFETY_GATE_CODES = new Set([
  "instrument_disabled",
  "max_positions",
  "max_per_symbol",
  "duplicate_position",
  "portfolio_heat",
  "daily_loss_limit",
  "drawdown_limit",
  "consecutive_loss_limit",
  "cooldown",
  "high_impact_news",
  "correlation",
  "minimum_risk_reward",
  "spread",
  "invalid_sl_tp",
]);

export interface Phase1StreamlinedObservationInput {
  evaluatedAt: string;
  candidateId: string;
  symbol: string;
  direction: "long" | "short" | null;
  authority: {
    stylePolicyVersion?: string | null;
    stylePolicyHash?: string | null;
    styleBasePolicyHash?: string | null;
    timeframeEvidenceId?: string | null;
    gamePlanId?: string | null;
    gamePlanVersion?: string | null;
    directionVerdictVersion?: string | null;
  };
  directionVerdict: {
    id?: string | null;
    verdict?: string | null;
    confidence?: number | null;
    shouldBlock?: boolean | null;
    verdictVersion?: string | null;
    evaluatedAt?: string | null;
  } | null;
  directionReasonCode: string;
  legacyScoring: {
    rawScore: number | null;
    effectiveScore: number | null;
    threshold: number | null;
  };
  thesis: {
    validationRequired: boolean;
    valid: boolean | null;
    conviction: number | null;
    degrading: boolean | null;
    reasonCode: string;
    version?: string | null;
    evaluatedAt?: string | null;
  };
  confirmation: {
    required: boolean;
    passed: boolean | null;
    reasonCode: string;
    evaluatedAt?: string | null;
  };
  gates: Array<{ passed: boolean; reason: string }>;
  factors?: LegacyFactorObservation[] | null;
  locationEvidence?: DecisionEvidenceReference | null;
}

function observedEvidence(
  input: Phase1StreamlinedObservationInput,
): PillarEvidenceMappingResult {
  if (input.factors) {
    return mapLegacyFactorsToPillars({
      factors: input.factors,
      evaluatedAt: input.evaluatedAt,
      locationEvidence: input.locationEvidence,
    });
  }
  const pillars = Object.fromEntries(
    ([
      "structure",
      "location",
      "confirmation",
      "timing",
    ] as SetupQualityPillar[]).map((pillar) => [pillar, {
      score: null,
      complete: false,
      evidence: pillar === "location" && input.locationEvidence
        ? [input.locationEvidence]
        : [{
          source: pillar === "location"
            ? "zone_story_and_market_location"
            : `legacy_${pillar}_evidence`,
          observedAt: input.evaluatedAt,
        }],
      reasonCodes: ["phase2_evidence_mapping_pending"],
    }]),
  ) as Parameters<
    typeof evaluateStreamlinedTradeDecision
  >[0]["setupQuality"]["pillars"];
  return {
    registryVersion: STREAMLINED_EVIDENCE_REGISTRY_VERSION,
    mappingComplete: false,
    pillars,
    directionEvidence: [],
    safetyEvidence: [],
    excludedEvidence: [],
    unmappedFactors: [],
  };
}

function observedSafetyChecks(
  gates: Phase1StreamlinedObservationInput["gates"],
  evaluatedAt: string,
) {
  const byCode = new Map<string, {
    code: string;
    passed: boolean;
    evidence: DecisionEvidenceReference;
  }>();
  for (const gate of gates) {
    const code = normalizeRejectedGate(gate.reason);
    if (!SAFETY_GATE_CODES.has(code)) continue;
    const existing = byCode.get(code);
    byCode.set(code, {
      code,
      passed: (existing?.passed ?? true) && gate.passed,
      evidence: {
        source: "scanner_safety_gate",
        observedAt: evaluatedAt,
      },
    });
  }
  return [...byCode.values()];
}

export function buildStreamlinedTradeDecisionObservation(
  input: Phase1StreamlinedObservationInput,
): TradeDecisionSummary {
  const verdict = input.directionVerdict?.verdict;
  const mappedEvidence = observedEvidence(input);
  return evaluateStreamlinedTradeDecision({
    evaluatedAt: input.evaluatedAt,
    identity: {
      candidateId: input.candidateId,
      symbol: input.symbol,
      direction: input.direction,
      stage: "candidate",
    },
    authority: input.authority,
    direction: {
      verdict: verdict === "long" || verdict === "short" ||
          verdict === "neutral"
        ? verdict
        : null,
      confidence: input.directionVerdict?.confidence ?? null,
      shouldBlock: input.directionVerdict?.shouldBlock ?? null,
      reasonCodes: [input.directionReasonCode],
      evidence: [
        {
          source: "direction_verdict",
          id: input.directionVerdict?.id || null,
          version: input.directionVerdict?.verdictVersion || null,
          observedAt: input.directionVerdict?.evaluatedAt || null,
        },
        ...mappedEvidence.directionEvidence,
      ],
    },
    setupQuality: {
      threshold: input.legacyScoring.threshold,
      pillars: mappedEvidence.pillars,
      evidenceMapping: {
        version: mappedEvidence.registryVersion,
        complete: mappedEvidence.mappingComplete,
        unmappedFactors: mappedEvidence.unmappedFactors,
        excludedEvidence: mappedEvidence.excludedEvidence,
      },
      legacyDiagnostics: input.legacyScoring,
    },
    thesis: {
      validationRequired: input.thesis.validationRequired,
      valid: input.thesis.valid,
      conviction: input.thesis.conviction,
      degrading: input.thesis.degrading,
      reasonCodes: [input.thesis.reasonCode],
      evidence: [{
        source: "thesis_validation",
        version: input.thesis.version || null,
        observedAt: input.thesis.evaluatedAt || null,
      }],
    },
    confirmation: {
      required: input.confirmation.required,
      passed: input.confirmation.passed,
      reasonCodes: [input.confirmation.reasonCode],
      evidence: [{
        source: "entry_confirmation",
        observedAt: input.confirmation.evaluatedAt || null,
      }],
    },
    safety: {
      // Candidate discovery predates final runtime authorization.
      complete: false,
      evidence: mappedEvidence.safetyEvidence,
      checks: observedSafetyChecks(input.gates, input.evaluatedAt),
    },
  });
}
