import type { DirectionVerdictDecision } from "./decisionContract.ts";
import type { SessionGamePlan } from "./gamePlan.ts";
import type { ResolvedStylePolicy } from "./stylePolicy.ts";
import type {
  CrossTimeframeAuthorityResolution,
} from "./crossTimeframeAuthority.ts";
import {
  evaluateCrossTimeframeShadowCandidate,
} from "./crossTimeframeShadowValidation.ts";
import {
  evaluateCrossTimeframeEntryAuthority,
  type CrossTimeframeEntryAuthorityDecision,
} from "./crossTimeframeEntryAuthority.ts";
import type { RankedPOI } from "./impulseZoneEngine.ts";

export const FROZEN_CROSS_TF_CONTEXT_VERSION = "frozen-cross-tf-context.v1";

export interface EvidenceCertificateReference {
  featureKey: string;
  variantKey: string;
  certificateHash: string;
  status: string;
  generatedAt: string | null;
}

export interface FrozenImpulseReference {
  candidateId: string | null;
  timeframe: string | null;
  high: number | null;
  low: number | null;
  direction: string | null;
  canonicalMetrics: Record<string, unknown> | null;
}

export interface FrozenCrossTimeframeContext {
  contractVersion: typeof FROZEN_CROSS_TF_CONTEXT_VERSION;
  enforcement: "observe_only";
  timeframeEvidenceId: string | null;
  gamePlan: { id: string | null; version: string | null };
  directionVerdict: { id: string | null; version: string | null };
  stylePolicy: {
    version: string;
    basePolicyHash: string;
    policyHash: string;
  };
  selectedZone: {
    candidateId: string | null;
    type: string | null;
    timeframe: string | null;
    low: number | null;
    high: number | null;
    lifecycle: string | null;
    modelRank: number | null;
  } | null;
  relationship: {
    classification: string;
    parentCandidateId: string | null;
    parentTimeframe: string | null;
    overlapPercentOfChild: number | null;
    parentDistanceATR: number | null;
  } | null;
  parentImpulse: FrozenImpulseReference | null;
  childImpulse: FrozenImpulseReference | null;
  evidenceCertificates: EvidenceCertificateReference[];
  authority: CrossTimeframeEntryAuthorityDecision;
}

type UnknownRecord = Record<string, any>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function candidateId(value: UnknownRecord): string | null {
  const id = value.candidateModel?.candidateId ??
    value.localConfluence?.candidateId ??
    value.evidence?.entityId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function impulseReference(
  candidate: UnknownRecord,
  fallback?: UnknownRecord,
): FrozenImpulseReference {
  const impulse = record(fallback);
  const lineage = record(candidate.timeframeLineage);
  return {
    candidateId: candidateId(candidate),
    timeframe:
      (typeof lineage.candidateTimeframe === "string"
        ? lineage.candidateTimeframe
        : null) ??
        (typeof candidate.timeframe === "string" ? candidate.timeframe : null),
    high: finite(impulse.high),
    low: finite(impulse.low),
    direction: typeof impulse.direction === "string"
      ? impulse.direction
      : typeof candidate.direction === "string"
      ? candidate.direction
      : null,
    canonicalMetrics: Object.keys(record(candidate.canonicalImpulseMetrics))
        .length > 0
      ? record(candidate.canonicalImpulseMetrics)
      : null,
  };
}

export function buildFrozenCrossTimeframeContext(input: {
  timeframeEvidenceId?: string | null;
  symbol: string;
  gamePlan: SessionGamePlan | null;
  directionVerdict: DirectionVerdictDecision | null;
  stylePolicy: ResolvedStylePolicy;
  zoneStory?: unknown;
  evidenceCertificates?: EvidenceCertificateReference[];
  crossTimeframeAuthority: CrossTimeframeAuthorityResolution;
}): FrozenCrossTimeframeContext {
  const story = record(input.zoneStory);
  const best = record(story.bestZone);
  const lineage = record(best.timeframeLineage);
  const candidates = Array.isArray(story.zoneCandidates)
    ? story.zoneCandidates.map(record)
    : [];
  const selectedId = candidateId(best);
  const parentId = typeof lineage.parentCandidateId === "string"
    ? lineage.parentCandidateId
    : null;
  const parent = parentId
    ? candidates.find((item) => candidateId(item) === parentId) || null
    : null;
  const pairPlan = input.gamePlan?.plans?.find((plan) =>
    plan.symbol === input.symbol
  );
  const selectedZone = Object.keys(best).length > 0
    ? {
      candidateId: selectedId,
      type: typeof best.type === "string" ? best.type : null,
      timeframe: (typeof lineage.candidateTimeframe === "string"
        ? lineage.candidateTimeframe
        : null) ??
        (typeof story.selectedTF === "string" ? story.selectedTF : null),
      low: finite(best.low),
      high: finite(best.high),
      lifecycle: typeof best.candidateLifecycle?.state === "string"
        ? best.candidateLifecycle.state
        : null,
      modelRank: finite(best.candidateModel?.rank),
    }
    : null;
  const shadowEvaluation = selectedZone
    ? evaluateCrossTimeframeShadowCandidate(
      best as unknown as RankedPOI,
      input.crossTimeframeAuthority.policy,
    )
    : null;

  return {
    contractVersion: FROZEN_CROSS_TF_CONTEXT_VERSION,
    enforcement: "observe_only",
    timeframeEvidenceId: input.timeframeEvidenceId || null,
    gamePlan: {
      id: pairPlan?.gamePlanId ||
        input.directionVerdict?.gamePlanId ||
        null,
      version: pairPlan?.planVersion ||
        input.directionVerdict?.gamePlanVersion ||
        input.gamePlan?.planVersion ||
        null,
    },
    directionVerdict: {
      id: input.directionVerdict?.id || null,
      version: input.directionVerdict?.verdictVersion || null,
    },
    stylePolicy: {
      version: input.stylePolicy.contractVersion,
      basePolicyHash: input.stylePolicy.basePolicyHash,
      policyHash: input.stylePolicy.policyHash,
    },
    selectedZone,
    relationship: Object.keys(lineage).length > 0
      ? {
        classification: typeof lineage.relationship === "string"
          ? lineage.relationship
          : "no_parent_context",
        parentCandidateId: parentId,
        parentTimeframe: typeof lineage.parentTimeframe === "string"
          ? lineage.parentTimeframe
          : null,
        overlapPercentOfChild: finite(lineage.overlapPercentOfChild),
        parentDistanceATR: finite(lineage.parentDistanceATR),
      }
      : null,
    parentImpulse: parent ? impulseReference(parent) : null,
    childImpulse: selectedZone
      ? impulseReference(best, record(story.impulse))
      : null,
    evidenceCertificates: [...(input.evidenceCertificates || [])]
      .filter((item) => item.certificateHash.length > 0)
      .sort((a, b) =>
        a.featureKey.localeCompare(b.featureKey) ||
        a.variantKey.localeCompare(b.variantKey)
      ),
    authority: evaluateCrossTimeframeEntryAuthority({
      authorityResolution: input.crossTimeframeAuthority,
      evaluation: shadowEvaluation,
      candidateId: selectedZone?.candidateId || null,
    }),
  };
}

export async function loadCurrentEvidenceCertificateReferences(
  client: any,
  userId: string,
  botId: string,
): Promise<EvidenceCertificateReference[]> {
  const { data, error } = await client
    .from("strategy_evidence_certificates")
    .select(
      "feature_key,variant_key,certificate_hash,status,generated_at",
    )
    .eq("user_id", userId)
    .eq("bot_id", botId)
    .eq("is_current", true);
  if (error) {
    throw new Error(
      `Could not load current strategy evidence certificates: ${error.message}`,
    );
  }
  return (data || []).map((row: UnknownRecord) => ({
    featureKey: String(row.feature_key),
    variantKey: String(row.variant_key),
    certificateHash: String(row.certificate_hash),
    status: String(row.status),
    generatedAt: typeof row.generated_at === "string" ? row.generated_at : null,
  }));
}
