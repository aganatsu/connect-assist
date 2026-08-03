import type {
  DecisionEvidenceReference,
  SetupQualityPillar,
  SetupQualityPillarInput,
} from "./streamlinedTradeDecision.ts";

export const STREAMLINED_EVIDENCE_REGISTRY_VERSION =
  "streamlined-evidence-registry.v1";

export type EvidenceDecisionRole =
  | "direction"
  | "setup_quality"
  | "thesis_health"
  | "safety"
  | "derived_diagnostic";

export interface FactorEvidenceOwnership {
  role: EvidenceDecisionRole;
  pillar?: SetupQualityPillar;
  maximumWeight?: number;
  contribution: "pillar_score" | "evidence_only" | "excluded_duplicate";
  rationale: string;
}

export const FACTOR_EVIDENCE_OWNERSHIP: Record<
  string,
  FactorEvidenceOwnership
> = {
  "Market Structure": {
    role: "setup_quality",
    pillar: "structure",
    maximumWeight: 2.5,
    contribution: "pillar_score",
    rationale: "Entry/setup-timeframe structural quality",
  },
  "Order Block": {
    role: "setup_quality",
    pillar: "location",
    maximumWeight: 2,
    contribution: "pillar_score",
    rationale: "Institutional entry location",
  },
  "Fair Value Gap": {
    role: "setup_quality",
    pillar: "location",
    maximumWeight: 2,
    contribution: "pillar_score",
    rationale: "Imbalance entry location",
  },
  "Premium/Discount & Fib": {
    role: "setup_quality",
    pillar: "location",
    maximumWeight: 2,
    contribution: "pillar_score",
    rationale: "Canonical value and retracement location",
  },
  "Session Quality": {
    role: "setup_quality",
    pillar: "timing",
    maximumWeight: 1.5,
    contribution: "pillar_score",
    rationale: "Tradable session timing",
  },
  "Judas Swing": {
    role: "setup_quality",
    pillar: "confirmation",
    maximumWeight: 0.75,
    contribution: "pillar_score",
    rationale: "Manipulation and reversal confirmation",
  },
  "PD/PW Levels": {
    role: "setup_quality",
    pillar: "location",
    maximumWeight: 1.5,
    contribution: "pillar_score",
    rationale: "Prior-day and prior-week location",
  },
  "Reversal Candle": {
    role: "setup_quality",
    pillar: "confirmation",
    maximumWeight: 1.5,
    contribution: "pillar_score",
    rationale: "Price-rejection confirmation",
  },
  "Liquidity Sweep": {
    role: "setup_quality",
    pillar: "confirmation",
    maximumWeight: 1.5,
    contribution: "pillar_score",
    rationale: "Liquidity event confirmation",
  },
  "Displacement": {
    role: "setup_quality",
    pillar: "structure",
    maximumWeight: 1,
    contribution: "pillar_score",
    rationale: "Impulse and structural quality",
  },
  "Breaker Block": {
    role: "setup_quality",
    pillar: "location",
    maximumWeight: 1,
    contribution: "pillar_score",
    rationale: "Qualified flipped order-flow location",
  },
  "Unicorn Model": {
    role: "setup_quality",
    pillar: "location",
    maximumWeight: 1.5,
    contribution: "pillar_score",
    rationale: "Breaker and FVG overlap location",
  },
  "SMT Divergence": {
    role: "direction",
    contribution: "evidence_only",
    rationale: "Directional intermarket evidence",
  },
  "Volume Profile": {
    role: "setup_quality",
    pillar: "location",
    maximumWeight: 0.75,
    contribution: "pillar_score",
    rationale: "Volume-derived market location",
  },
  "AMD Phase": {
    role: "setup_quality",
    pillar: "confirmation",
    maximumWeight: 1.5,
    contribution: "pillar_score",
    rationale: "Accumulation-manipulation-distribution confirmation",
  },
  "Currency Strength": {
    role: "direction",
    contribution: "evidence_only",
    rationale: "FOTSI directional context",
  },
  "Daily Bias": {
    role: "direction",
    contribution: "evidence_only",
    rationale: "Higher-timeframe directional context",
  },
  "Confluence Stack": {
    role: "setup_quality",
    pillar: "location",
    maximumWeight: 1.5,
    contribution: "pillar_score",
    rationale: "Overlapping location evidence after anti-double-count rules",
  },
  "Pullback Health": {
    role: "setup_quality",
    pillar: "confirmation",
    maximumWeight: 0.5,
    contribution: "pillar_score",
    rationale: "Pullback response quality",
  },
  "HTF POI Alignment": {
    role: "setup_quality",
    pillar: "location",
    maximumWeight: 2,
    contribution: "pillar_score",
    rationale: "Higher-timeframe containment of the entry location",
  },
  "HTF Fib + PD + Liquidity": {
    role: "setup_quality",
    pillar: "location",
    maximumWeight: 2.5,
    contribution: "pillar_score",
    rationale: "Higher-timeframe value and liquidity location",
  },
  "GP Key Level Alignment": {
    role: "setup_quality",
    pillar: "location",
    maximumWeight: 1,
    contribution: "pillar_score",
    rationale: "Game Plan key-level location, not Game Plan direction",
  },
  "Session Affinity": {
    role: "setup_quality",
    pillar: "timing",
    maximumWeight: 1.5,
    contribution: "pillar_score",
    rationale: "Pair-specific session timing",
  },
  "Power of 3 Combo": {
    role: "derived_diagnostic",
    contribution: "excluded_duplicate",
    rationale: "Derived from AMD, sweep/Judas, and structure already mapped",
  },
  "Regime Alignment": {
    role: "direction",
    contribution: "evidence_only",
    rationale: "Direction Verdict context",
  },
  "Spread Quality": {
    role: "safety",
    contribution: "evidence_only",
    rationale: "Indicative diagnostic; broker spread is checked at execution",
  },
  "GP Bias Confidence": {
    role: "direction",
    contribution: "evidence_only",
    rationale: "Game Plan directional context",
  },
};

export const ADJUSTMENT_EVIDENCE_OWNERSHIP = {
  fotsiPenalty: { role: "direction", contribution: "evidence_only" },
  impulseZoneAdjustment: {
    role: "setup_quality",
    pillar: "location",
    contribution: "evidence_only",
  },
  zoneLocalAdjustment: {
    role: "setup_quality",
    pillar: "confirmation",
    contribution: "evidence_only",
  },
  crossTimeframeAdjustment: {
    role: "setup_quality",
    pillar: "structure",
    contribution: "evidence_only",
  },
  ictHTFAdjustment: { role: "direction", contribution: "evidence_only" },
  ictMSSAdjustment: {
    role: "setup_quality",
    pillar: "confirmation",
    contribution: "evidence_only",
  },
  ictJudasAdjustment: {
    role: "setup_quality",
    pillar: "confirmation",
    contribution: "evidence_only",
  },
  ictFVGAdjustment: {
    role: "setup_quality",
    pillar: "location",
    contribution: "evidence_only",
  },
  ictKillZoneAdjustment: {
    role: "setup_quality",
    pillar: "timing",
    contribution: "evidence_only",
  },
  directionVerdictAdjustment: {
    role: "direction",
    contribution: "evidence_only",
  },
  thesisConvictionAdjustment: {
    role: "thesis_health",
    contribution: "evidence_only",
  },
  conflictCounter: {
    role: "derived_diagnostic",
    contribution: "excluded_duplicate",
  },
} as const;

export const PROMOTION_EVIDENCE_OWNERSHIP = {
  unicornTier1Promotion: {
    role: "setup_quality",
    pillar: "location",
    contribution: "existing_factor_only",
  },
  nestedHtfFvgPromotion: {
    role: "setup_quality",
    pillar: "location",
    contribution: "existing_factor_only",
  },
  nestedHtfObPromotion: {
    role: "setup_quality",
    pillar: "location",
    contribution: "existing_factor_only",
  },
  nestedHtfFibPromotion: {
    role: "setup_quality",
    pillar: "location",
    contribution: "existing_factor_only",
  },
  impulseZoneCompatibilityCredit: {
    role: "setup_quality",
    pillar: "location",
    contribution: "existing_factor_only",
  },
} as const;

export interface LegacyFactorObservation {
  name: string;
  present: boolean;
  weight: number;
  detail?: string | null;
  group?: string | null;
  tier?: number | null;
}

export interface PillarEvidenceMappingResult {
  registryVersion: typeof STREAMLINED_EVIDENCE_REGISTRY_VERSION;
  mappingComplete: boolean;
  pillars: Record<SetupQualityPillar, SetupQualityPillarInput>;
  directionEvidence: DecisionEvidenceReference[];
  safetyEvidence: DecisionEvidenceReference[];
  excludedEvidence: DecisionEvidenceReference[];
  unmappedFactors: string[];
}

function factorCode(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function ownershipFor(name: string): FactorEvidenceOwnership | null {
  if (FACTOR_EVIDENCE_OWNERSHIP[name]) {
    return FACTOR_EVIDENCE_OWNERSHIP[name];
  }
  if (name.startsWith("Opening Range")) {
    return {
      role: "setup_quality",
      pillar: "timing",
      maximumWeight: 2,
      contribution: "pillar_score",
      rationale: "Opening-range timing and location window",
    };
  }
  return null;
}

export function mapLegacyFactorsToPillars(input: {
  factors: LegacyFactorObservation[];
  evaluatedAt: string;
  locationEvidence?: DecisionEvidenceReference | null;
}): PillarEvidenceMappingResult {
  const contributions = new Map<SetupQualityPillar, {
    earned: number;
    maximum: number;
    evidence: DecisionEvidenceReference[];
    reasons: string[];
  }>();
  for (
    const pillar of [
      "structure",
      "location",
      "confirmation",
      "timing",
    ] as SetupQualityPillar[]
  ) {
    contributions.set(pillar, {
      earned: 0,
      maximum: 0,
      evidence: [],
      reasons: [],
    });
  }

  const directionEvidence: DecisionEvidenceReference[] = [];
  const safetyEvidence: DecisionEvidenceReference[] = [];
  const excludedEvidence: DecisionEvidenceReference[] = [];
  const unmappedFactors: string[] = [];

  for (const factor of input.factors) {
    const ownership = ownershipFor(factor.name);
    const reference: DecisionEvidenceReference = {
      source: `confluence_factor:${factorCode(factor.name)}`,
      version: STREAMLINED_EVIDENCE_REGISTRY_VERSION,
      observedAt: input.evaluatedAt,
    };
    if (!ownership) {
      unmappedFactors.push(factor.name);
      excludedEvidence.push(reference);
      continue;
    }
    if (
      ownership.role === "setup_quality" &&
      ownership.contribution === "pillar_score" &&
      ownership.pillar &&
      ownership.maximumWeight
    ) {
      const bucket = contributions.get(ownership.pillar)!;
      const observedWeight = Number.isFinite(Number(factor.weight))
        ? Number(factor.weight)
        : 0;
      const enabled = observedWeight !== 0 || factor.present;
      if (!enabled) continue;
      bucket.maximum += ownership.maximumWeight;
      if (factor.present) {
        bucket.earned += Math.max(
          -ownership.maximumWeight,
          Math.min(ownership.maximumWeight, observedWeight),
        );
      }
      bucket.evidence.push(reference);
      bucket.reasons.push(
        `factor.${factorCode(factor.name)}.${factor.present ? "present" : "absent"}`,
      );
    } else if (ownership.role === "direction") {
      directionEvidence.push(reference);
    } else if (ownership.role === "safety") {
      safetyEvidence.push(reference);
    } else {
      excludedEvidence.push(reference);
    }
  }

  if (input.locationEvidence) {
    contributions.get("location")!.evidence.push(input.locationEvidence);
  }

  const mappingComplete = unmappedFactors.length === 0;
  const pillars = Object.fromEntries(
    ([...contributions.entries()]).map(([pillar, bucket]) => {
      const complete = mappingComplete && bucket.maximum > 0;
      const score = complete
        ? Math.round(
          Math.max(0, Math.min(25, 25 * bucket.earned / bucket.maximum)) *
            10,
        ) / 10
        : null;
      const reasonCodes = mappingComplete
        ? bucket.reasons
        : [
          ...bucket.reasons,
          ...unmappedFactors.map((name) =>
            `unmapped_factor.${factorCode(name)}`
          ),
        ];
      return [pillar, {
        score,
        complete,
        evidence: bucket.evidence,
        reasonCodes,
      }];
    }),
  ) as Record<SetupQualityPillar, SetupQualityPillarInput>;

  return {
    registryVersion: STREAMLINED_EVIDENCE_REGISTRY_VERSION,
    mappingComplete,
    pillars,
    directionEvidence,
    safetyEvidence,
    excludedEvidence,
    unmappedFactors: [...new Set(unmappedFactors)].sort(),
  };
}
