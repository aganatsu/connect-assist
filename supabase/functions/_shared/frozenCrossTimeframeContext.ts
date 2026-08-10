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
import {
  resolveCanonicalDealingRange,
  type CanonicalDealingRangeSelection,
} from "./canonicalDealingRange.ts";
import type { EvidenceRow } from "./zoneTimeframeEvidence.ts";
import {
  buildImpulseEntryLifecycle,
  type ImpulseEntryLifecycle,
  type ImpulseEntryLifecycleMode,
} from "./impulseEntryLifecycle.ts";

export const FROZEN_CROSS_TF_CONTEXT_VERSION = "frozen-cross-tf-context.v2";

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
  qualification: Record<string, unknown> | null;
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
  ictEntryZoneAuthority: Record<string, unknown> | null;
  relationship: {
    classification: string;
    parentCandidateId: string | null;
    parentTimeframe: string | null;
    overlapPercentOfChild: number | null;
    parentDistanceATR: number | null;
  } | null;
  parentImpulse: FrozenImpulseReference | null;
  childImpulse: FrozenImpulseReference | null;
  canonicalDealingRange: CanonicalDealingRangeSelection;
  impulseEntryLifecycle: ImpulseEntryLifecycle | null;
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
  qualification?: UnknownRecord,
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
    qualification: Object.keys(record(qualification)).length > 0 ? record(qualification) : null,
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
  timeframeEvidence?: Pick<
    EvidenceRow,
    "observed_at" | "selected_timeframe" | "slots"
  > | null;
  impulseEntryLifecycleMode?: ImpulseEntryLifecycleMode;
  confirmationMethod?: "choch" | "indicators" | "choch_and_indicators";
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
  const ictEntryZoneAuthority = Object.keys(
    record(story.candidateAuthorityObservation),
  ).length > 0
    ? record(story.candidateAuthorityObservation)
    : null;
  const shadowEvaluation = selectedZone
    ? evaluateCrossTimeframeShadowCandidate(
      best as unknown as RankedPOI,
      input.crossTimeframeAuthority.policy,
    )
    : null;
  const canonicalDealingRange = input.timeframeEvidence && selectedZone?.timeframe
    ? resolveCanonicalDealingRange({
      slots: input.timeframeEvidence.slots,
      parentTimeframe: typeof lineage.parentTimeframe === "string"
        ? lineage.parentTimeframe
        : null,
      childTimeframe: selectedZone.timeframe,
      frozenAt: input.timeframeEvidence.observed_at,
    })
    : {
      available: false as const,
      range: null,
      reason: "no_valid_impulse_range" as const,
    };

  const authorityCandidates = Array.isArray(ictEntryZoneAuthority?.ranked)
    ? ictEntryZoneAuthority.ranked.map(record)
    : [];
  const authoritySelected = record(ictEntryZoneAuthority?.selected);
  const canonicalRange = canonicalDealingRange.available ? canonicalDealingRange.range : null;
  const impulseQualification = record(story.impulseQualification);
  const lifecycleImpulseQualified = impulseQualification.qualified === true &&
    impulseQualification.state === "qualified" &&
    impulseQualification.contractVersion === "impulse-zone-qualification.v2";
  const lifecycleCandidates = canonicalRange
    ? authorityCandidates
      .filter((candidate) =>
        candidate.eligible === true &&
        candidate.direction === canonicalRange.direction &&
        finite(candidate.low) !== null && finite(candidate.high) !== null &&
        Number(candidate.low) >= canonicalRange.low &&
        Number(candidate.high) <= canonicalRange.high
      )
      .map((candidate) => ({
        id: String(candidate.id),
        type: candidate.type as "ob" | "fvg" | "breaker" | "ob_fvg" | "breaker_fvg",
        low: Number(candidate.low),
        high: Number(candidate.high),
        timeframe: String(candidate.timeframe || selectedZone?.timeframe || "unknown"),
        impulseId: canonicalRange.impulseId,
      }))
    : [];
  const lifecycleExpiry = canonicalRange
    ? new Date(
      Date.parse(canonicalRange.frozenAt) +
        (input.stylePolicy.lifecycle?.limitOrderExpiryMinutes ?? 60) * 60_000,
    ).toISOString()
    : null;
  const impulseEntryLifecycle = canonicalRange && lifecycleImpulseQualified && lifecycleCandidates.length > 0
    ? buildImpulseEntryLifecycle({
      mode: input.impulseEntryLifecycleMode || "observe",
      now: canonicalRange.frozenAt,
      impulse: {
        id: canonicalRange.impulseId,
        direction: canonicalRange.direction === "bullish" ? "long" : "short",
        timeframe: canonicalRange.timeframe,
        rangeLow: canonicalRange.low,
        rangeHigh: canonicalRange.high,
        protectedLevel: canonicalRange.direction === "bullish"
          ? canonicalRange.low
          : canonicalRange.high,
        expiresAt: lifecycleExpiry!,
      },
      candidates: lifecycleCandidates,
      initialCandidateId: typeof authoritySelected.id === "string"
        ? authoritySelected.id
        : selectedZone?.candidateId,
      confirmation: {
        method: input.confirmationMethod || "choch",
        timeframe: input.stylePolicy.timeframes?.roles?.confirmation || "5m",
        refinementTimeframe: input.stylePolicy.timeframes?.roles?.refinement || "1m",
        expiresAt: lifecycleExpiry!,
      },
    })
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
    ictEntryZoneAuthority,
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
      ? impulseReference(best, record(story.impulse), record(story.impulseQualification))
      : null,
    canonicalDealingRange,
    impulseEntryLifecycle,
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
