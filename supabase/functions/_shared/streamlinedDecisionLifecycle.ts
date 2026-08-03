import type { TradeDecisionSummary } from "./streamlinedTradeDecision.ts";

export const STREAMLINED_DECISION_LIFECYCLE_VERSION =
  "streamlined-decision-lifecycle.v1";

export type StreamlinedLifecycleStage =
  | "candidate" | "watchlist" | "pending" | "fill" | "position" | "closed"
  | "rejected" | "backtest" | "replay";

export interface FrozenStreamlinedDecision {
  contractVersion: typeof STREAMLINED_DECISION_LIFECYCLE_VERSION;
  frozenAt: string;
  candidateId: string;
  originStage: StreamlinedLifecycleStage;
  summary: TradeDecisionSummary;
}

export interface StreamlinedDecisionRefresh {
  contractVersion: typeof STREAMLINED_DECISION_LIFECYCLE_VERSION;
  evaluatedAt: string;
  stage: StreamlinedLifecycleStage;
  currentPrice: number | null;
  thesisHealth: TradeDecisionSummary["thesisHealth"];
  safetyAuthorization: TradeDecisionSummary["safetyAuthorization"];
  proposedDecision: TradeDecisionSummary["proposedDecision"];
  completeness: TradeDecisionSummary["completeness"];
}

export function freezeStreamlinedDecision(
  summary: TradeDecisionSummary,
  stage: StreamlinedLifecycleStage = "candidate",
): FrozenStreamlinedDecision {
  if (!summary.observationOnly || summary.affectsAuthorization) {
    throw new Error("streamlined_origin_must_be_observation_only");
  }
  if (!summary.identity.candidateId) {
    throw new Error("streamlined_candidate_identity_required");
  }
  return {
    contractVersion: STREAMLINED_DECISION_LIFECYCLE_VERSION,
    frozenAt: summary.evaluatedAt,
    candidateId: summary.identity.candidateId,
    originStage: stage,
    summary,
  };
}

export function refreshStreamlinedDecision(
  summary: TradeDecisionSummary,
  stage: StreamlinedLifecycleStage,
  currentPrice: number | null = null,
): StreamlinedDecisionRefresh {
  return {
    contractVersion: STREAMLINED_DECISION_LIFECYCLE_VERSION,
    evaluatedAt: summary.evaluatedAt,
    stage,
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
    thesisHealth: summary.thesisHealth,
    safetyAuthorization: summary.safetyAuthorization,
    proposedDecision: summary.proposedDecision,
    completeness: summary.completeness,
  };
}

export function lifecycleProjection(
  summary: TradeDecisionSummary,
  stage: StreamlinedLifecycleStage,
  currentPrice: number | null = null,
) {
  return {
    streamlinedDecisionOrigin: freezeStreamlinedDecision(summary, stage),
    streamlinedDecisionLatest: refreshStreamlinedDecision(
      summary,
      stage,
      currentPrice,
    ),
  };
}
