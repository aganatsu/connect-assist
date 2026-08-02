import type { RankedPOI } from "./impulseZoneEngine.ts";

export const CROSS_TF_SHADOW_POLICY_VERSION = "cross-tf-shadow-policy.v1";

export interface CrossTimeframeShadowPolicy {
  contractVersion: typeof CROSS_TF_SHADOW_POLICY_VERSION;
  enforcement: "observe_only";
  requireNestedImpulse: true;
  allowStandaloneLowerTimeframe: false;
  maximumZoneSeparationATR: number;
  minimumParentChildOverlapPercent: number;
  requireSweepOrigin: false;
  allowedRetestQuality: Array<"fresh" | "tapped_and_held">;
  maximumCandidatesPerTimeframe: number;
}

export const DEFAULT_CROSS_TF_SHADOW_POLICY: CrossTimeframeShadowPolicy = {
  contractVersion: CROSS_TF_SHADOW_POLICY_VERSION,
  enforcement: "observe_only",
  requireNestedImpulse: true,
  allowStandaloneLowerTimeframe: false,
  maximumZoneSeparationATR: 0.25,
  minimumParentChildOverlapPercent: 50,
  requireSweepOrigin: false,
  allowedRetestQuality: ["fresh", "tapped_and_held"],
  maximumCandidatesPerTimeframe: 3,
};

export type CrossTimeframeShadowDecision = "allow" | "block";

export interface CrossTimeframeShadowEvaluation {
  contractVersion: typeof CROSS_TF_SHADOW_POLICY_VERSION;
  enforcement: "observe_only";
  legacyDecision: CrossTimeframeShadowDecision;
  proposedDecision: CrossTimeframeShadowDecision;
  disagreed: boolean;
  reasonCodes: string[];
  explanation: string;
  policy: CrossTimeframeShadowPolicy;
}

export function evaluateCrossTimeframeShadowCandidate(
  candidate: RankedPOI,
  policy: CrossTimeframeShadowPolicy = DEFAULT_CROSS_TF_SHADOW_POLICY,
): CrossTimeframeShadowEvaluation {
  const legacyDecision: CrossTimeframeShadowDecision =
    candidate.shadowRanking?.legacyRank === 1 ? "allow" : "block";
  const reasons: string[] = [];
  const lineage = candidate.timeframeLineage;
  const lifecycle = candidate.candidateLifecycle?.state;
  const rank = candidate.candidateModel?.rank ??
    candidate.shadowRanking?.shadowRank ??
    Number.POSITIVE_INFINITY;

  if (rank > policy.maximumCandidatesPerTimeframe) {
    reasons.push("candidate_rank_above_maximum");
  }
  if (
    lifecycle &&
    !policy.allowedRetestQuality.includes(
      lifecycle as "fresh" | "tapped_and_held",
    )
  ) {
    reasons.push(`retest_quality_${lifecycle}`);
  }
  if (!lineage) {
    reasons.push("lineage_unavailable");
  } else {
    switch (lineage.relationship) {
      case "qualified_nested":
        if (
          lineage.overlapPercentOfChild <
            policy.minimumParentChildOverlapPercent
        ) {
          reasons.push("parent_child_overlap_below_minimum");
        }
        break;
      case "context_only":
        if (
          lineage.parentDistanceATR === null ||
          lineage.parentDistanceATR > policy.maximumZoneSeparationATR
        ) {
          reasons.push("parent_zone_too_far");
        }
        break;
      case "standalone_lower_tf":
        if (!policy.allowStandaloneLowerTimeframe) {
          reasons.push("standalone_lower_timeframe_not_allowed");
        }
        break;
      case "timeframe_conflict":
        reasons.push("parent_direction_conflict");
        break;
      case "no_parent_context":
        // The highest configured timeframe is itself the context authority.
        break;
    }
  }
  if (
    policy.requireSweepOrigin &&
    candidate.canonicalImpulseMetrics?.sweepOrigin !== true
  ) {
    reasons.push("sweep_origin_required");
  }

  const proposedDecision: CrossTimeframeShadowDecision = reasons.length > 0
    ? "block"
    : "allow";
  return {
    contractVersion: CROSS_TF_SHADOW_POLICY_VERSION,
    enforcement: "observe_only",
    legacyDecision,
    proposedDecision,
    disagreed: legacyDecision !== proposedDecision,
    reasonCodes: reasons,
    explanation: reasons.length > 0
      ? `Shadow policy would block: ${reasons.join(", ")}`
      : "Shadow policy would retain this candidate",
    policy,
  };
}

export interface CrossTimeframeOutcomeObservation {
  legacyWinner: boolean;
  proposedDecision: CrossTimeframeShadowDecision;
  outcomeStatus:
    | "pending"
    | "no_entry"
    | "inconclusive"
    | "would_have_won"
    | "would_have_lost";
  rewardRisk: number | null;
  mfePips: number | null;
  maePips: number | null;
}

export interface CrossTimeframeShadowOutcomeSummary {
  resolvedLegacyTrades: number;
  winnersRetained: number;
  losersAvoided: number;
  missedOpportunities: number;
  falsePositives: number;
  proposedExpectancyR: number | null;
  legacyExpectancyR: number | null;
  expectancyDeltaR: number | null;
  averageMfePips: number | null;
  averageMaePips: number | null;
}

function average(values: number[]): number | null {
  return values.length > 0
    ? Number(
      (values.reduce((sum, value) => sum + value, 0) / values.length)
        .toFixed(4),
    )
    : null;
}

export function summarizeCrossTimeframeShadowOutcomes(
  observations: CrossTimeframeOutcomeObservation[],
): CrossTimeframeShadowOutcomeSummary {
  const resolved = observations.filter((item) =>
    item.legacyWinner &&
    (item.outcomeStatus === "would_have_won" ||
      item.outcomeStatus === "would_have_lost")
  );
  const realizedR = (item: CrossTimeframeOutcomeObservation) =>
    item.outcomeStatus === "would_have_won"
      ? Math.max(0, item.rewardRisk ?? 0)
      : -1;
  const legacyReturns = resolved.map(realizedR);
  const proposedReturns = resolved.map((item) =>
    item.proposedDecision === "allow" ? realizedR(item) : 0
  );
  const legacyExpectancyR = average(legacyReturns);
  const proposedExpectancyR = average(proposedReturns);
  return {
    resolvedLegacyTrades: resolved.length,
    winnersRetained:
      resolved.filter((item) =>
        item.proposedDecision === "allow" &&
        item.outcomeStatus === "would_have_won"
      ).length,
    losersAvoided:
      resolved.filter((item) =>
        item.proposedDecision === "block" &&
        item.outcomeStatus === "would_have_lost"
      ).length,
    missedOpportunities:
      resolved.filter((item) =>
        item.proposedDecision === "block" &&
        item.outcomeStatus === "would_have_won"
      ).length,
    falsePositives:
      resolved.filter((item) =>
        item.proposedDecision === "allow" &&
        item.outcomeStatus === "would_have_lost"
      ).length,
    proposedExpectancyR,
    legacyExpectancyR,
    expectancyDeltaR: proposedExpectancyR !== null && legacyExpectancyR !== null
      ? Number((proposedExpectancyR - legacyExpectancyR).toFixed(4))
      : null,
    averageMfePips: average(
      resolved.flatMap((item) => item.mfePips === null ? [] : [item.mfePips]),
    ),
    averageMaePips: average(
      resolved.flatMap((item) => item.maePips === null ? [] : [item.maePips]),
    ),
  };
}
