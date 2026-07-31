import type {
  ZoneLocalConfluenceObservation,
  ZoneLocalEvidenceObservation,
  ZoneLocalEvidenceSource,
} from "./zoneLocalConfluence.ts";

export const ZONE_CANDIDATE_SHADOW_RANKING_VERSION =
  "zone-candidate-shadow-ranking.v1";

export type ZoneEvidenceFamily =
  | "fib"
  | "support_resistance"
  | "htf_order_block"
  | "htf_fvg"
  | "htf_breaker"
  | "ltf_refinement"
  | "liquidity_entry"
  | "liquidity_target"
  | "liquidity_context"
  | "premium_discount";

export interface ShadowEvidenceCredit {
  family: ZoneEvidenceFamily;
  source: ZoneLocalEvidenceSource;
  evidenceId: string | null;
  entityId: string | null;
  legacyCredit: number;
  shadowCredit: number;
  selectedForFamily: boolean;
  reason:
    | "full_local_credit"
    | "partial_local_credit"
    | "not_locally_qualified"
    | "context_only"
    | "duplicate_entity"
    | "lower_credit_same_family";
}

export interface ZoneCandidateShadowRanking {
  contractVersion: typeof ZONE_CANDIDATE_SHADOW_RANKING_VERSION;
  enforcement: "observe_only";
  candidateId: string;
  legacyZoneScore: number;
  legacyComparableScore: number;
  shadowLocalScore: number;
  legacyRank: number;
  shadowRank: number;
  rankDelta: number;
  selectedEvidence: ShadowEvidenceCredit[];
  excludedEvidence: ShadowEvidenceCredit[];
  summary: {
    observedItems: number;
    locallyQualifiedItems: number;
    contextOnlyItems: number;
    uniqueEntities: number;
    creditedFamilies: number;
  };
}

export interface ShadowRankableZone {
  candidateId: string;
  legacyZoneScore: number;
  fibDepth: number;
  localConfluence?: ZoneLocalConfluenceObservation;
}

function evidenceFamily(
  item: ZoneLocalEvidenceObservation,
): ZoneEvidenceFamily {
  switch (item.source) {
    case "impulse_fib":
    case "htf_fib":
      return "fib";
    case "historical_sr":
      return "support_resistance";
    case "htf_order_block":
      return "htf_order_block";
    case "htf_fvg":
      return "htf_fvg";
    case "htf_breaker":
      return "htf_breaker";
    case "ltf_refinement":
      return "ltf_refinement";
    case "premium_discount":
      return "premium_discount";
    case "liquidity_pool": {
      const relevance = String(item.attributes.relevance || "");
      if (relevance === "entry_trigger") return "liquidity_entry";
      if (relevance === "target") return "liquidity_target";
      return "liquidity_context";
    }
  }
}

function localCredit(item: ZoneLocalEvidenceObservation): {
  credit: number;
  reason: ShadowEvidenceCredit["reason"];
} {
  const legacyCredit = Math.max(0, item.legacyScoreContribution);
  if (!item.measurement || !item.qualification) {
    return { credit: 0, reason: "context_only" };
  }
  if (!item.qualification.qualified) {
    return { credit: 0, reason: "not_locally_qualified" };
  }
  if (item.measurement.fullCreditEligible) {
    return { credit: legacyCredit, reason: "full_local_credit" };
  }
  return {
    credit: legacyCredit * 0.5,
    reason: "partial_local_credit",
  };
}

function comparableLegacyScore(zone: ShadowRankableZone): number {
  const extraLiquidityCredit = (zone.localConfluence?.items || [])
    .filter((item) => item.source === "liquidity_pool")
    .reduce(
      (sum, item) => sum + Math.max(0, item.legacyScoreContribution),
      0,
    );
  return zone.legacyZoneScore + extraLiquidityCredit;
}

function evaluateCandidate(
  zone: ShadowRankableZone,
): ZoneCandidateShadowRanking {
  const items = zone.localConfluence?.items || [];
  const credits = items.map((item): ShadowEvidenceCredit => {
    const result = localCredit(item);
    return {
      family: evidenceFamily(item),
      source: item.source,
      evidenceId: item.evidence?.evidenceId || null,
      entityId: item.evidence?.entityId || null,
      legacyCredit: Math.max(0, item.legacyScoreContribution),
      shadowCredit: result.credit,
      selectedForFamily: false,
      reason: result.reason,
    };
  });

  // A detector may surface the same geometric entity more than once. Keep the
  // strongest local qualification for that entity before comparing families.
  const uniqueCredits: ShadowEvidenceCredit[] = [];
  const entityWinners = new Map<string, ShadowEvidenceCredit>();
  for (const credit of credits) {
    const identity = credit.entityId ||
      `${credit.source}:${credit.evidenceId || uniqueCredits.length}`;
    const existing = entityWinners.get(identity);
    if (!existing || credit.shadowCredit > existing.shadowCredit) {
      if (existing) existing.reason = "duplicate_entity";
      entityWinners.set(identity, credit);
    } else {
      credit.reason = "duplicate_entity";
    }
  }
  uniqueCredits.push(...entityWinners.values());

  // One credit per evidence family prevents several detectors from making one
  // idea look like several independent confirmations.
  const familyWinners = new Map<ZoneEvidenceFamily, ShadowEvidenceCredit>();
  for (const credit of uniqueCredits) {
    const existing = familyWinners.get(credit.family);
    if (!existing || credit.shadowCredit > existing.shadowCredit) {
      if (existing && existing.shadowCredit > 0) {
        existing.reason = "lower_credit_same_family";
      }
      familyWinners.set(credit.family, credit);
    } else if (credit.shadowCredit > 0) {
      credit.reason = "lower_credit_same_family";
    }
  }
  for (const credit of familyWinners.values()) {
    if (credit.shadowCredit > 0) credit.selectedForFamily = true;
  }

  const selectedEvidence = credits.filter((credit) => credit.selectedForFamily);
  const excludedEvidence = credits.filter((credit) =>
    !credit.selectedForFamily
  );
  const shadowLocalScore = selectedEvidence.reduce(
    (sum, credit) => sum + credit.shadowCredit,
    0,
  );
  return {
    contractVersion: ZONE_CANDIDATE_SHADOW_RANKING_VERSION,
    enforcement: "observe_only",
    candidateId: zone.candidateId,
    legacyZoneScore: zone.legacyZoneScore,
    legacyComparableScore: comparableLegacyScore(zone),
    shadowLocalScore,
    legacyRank: 0,
    shadowRank: 0,
    rankDelta: 0,
    selectedEvidence,
    excludedEvidence,
    summary: {
      observedItems: items.length,
      locallyQualifiedItems:
        items.filter((item) => item.qualification?.qualified === true).length,
      contextOnlyItems:
        items.filter((item) =>
          item.qualification?.proximityClass === "context_only" ||
          item.measurement == null
        ).length,
      uniqueEntities: entityWinners.size,
      creditedFamilies: selectedEvidence.length,
    },
  };
}

export function rankZoneCandidatesShadow(
  zones: readonly ShadowRankableZone[],
): Map<string, ZoneCandidateShadowRanking> {
  const evaluated = zones.map((zone) => ({
    zone,
    ranking: evaluateCandidate(zone),
  }));
  const legacyOrder = [...evaluated].sort((a, b) =>
    b.ranking.legacyComparableScore - a.ranking.legacyComparableScore ||
    b.zone.fibDepth - a.zone.fibDepth ||
    a.zone.candidateId.localeCompare(b.zone.candidateId)
  );
  const shadowOrder = [...evaluated].sort((a, b) =>
    b.ranking.shadowLocalScore - a.ranking.shadowLocalScore ||
    b.zone.fibDepth - a.zone.fibDepth ||
    a.zone.candidateId.localeCompare(b.zone.candidateId)
  );
  legacyOrder.forEach(({ ranking }, index) => ranking.legacyRank = index + 1);
  shadowOrder.forEach(({ ranking }, index) => ranking.shadowRank = index + 1);
  for (const { ranking } of evaluated) {
    ranking.rankDelta = ranking.legacyRank - ranking.shadowRank;
  }
  return new Map(
    evaluated.map(({ ranking }) => [ranking.candidateId, ranking]),
  );
}
