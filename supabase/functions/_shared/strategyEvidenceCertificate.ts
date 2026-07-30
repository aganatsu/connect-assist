export const STRATEGY_EVIDENCE_CONTRACT_VERSION = "strategy-evidence.v1";
export const STRATEGY_EVIDENCE_GENERATOR_VERSION =
  "strategy-evidence-generator.v1";

export type StrategyEvidenceFeature =
  | "gameplan_hierarchy"
  | "thesis_conviction";
export type StrategyEvidenceDecision = "allow" | "block";
export type StrategyEvidenceOutcome = "win" | "loss" | "inconclusive";
export type StrategyEvidenceStatus =
  | "collecting"
  | "eligible_log_only"
  | "keep_shadow";

export interface StrategyEvidenceObservation {
  feature: StrategyEvidenceFeature;
  sourceId: string;
  source: "rejected_setup" | "closed_trade";
  observedAt: string;
  symbol: string;
  style: string;
  currentDecision: StrategyEvidenceDecision;
  proposedDecision: StrategyEvidenceDecision;
  outcome: StrategyEvidenceOutcome;
  outcomeR: number | null;
}

export interface StrategyEvidenceSegment {
  resolved: number;
  changed: number;
  beneficial: number;
  harmful: number;
  beneficialRatePercent: number | null;
  currentExpectancyR: number;
  proposedExpectancyR: number;
  expectancyDeltaR: number;
}

export interface StrategyEvidenceCertificate {
  contractVersion: typeof STRATEGY_EVIDENCE_CONTRACT_VERSION;
  generatorVersion: typeof STRATEGY_EVIDENCE_GENERATOR_VERSION;
  generatedAt: string;
  featureKey: StrategyEvidenceFeature;
  variantKey: "default";
  activationScope: Record<string, never>;
  sourceWindow: {
    start: string | null;
    end: string | null;
  };
  sample: {
    totalCandidates: number;
    evidence: number;
    resolved: number;
    changed: number;
    coveragePercent: number;
    trainResolved: number;
    trainChanged: number;
    testResolved: number;
    testChanged: number;
    paperResolved: number;
    liveCanaryResolved: number;
  };
  effect: {
    beneficial: number;
    harmful: number;
    beneficialRatePercent: number | null;
    currentExpectancyR: number;
    proposedExpectancyR: number;
    expectancyDeltaR: number;
    currentMaxDrawdownR: number;
    proposedMaxDrawdownR: number;
    maxDrawdownDeltaPercent: number;
    goodTradeRetentionPercent: number;
  };
  validation: {
    chronologicalSplit: true;
    splitRatio: 0.7;
    outOfSample: boolean;
    walkForwardConsistent: boolean;
    paperForwardPassed: false;
    liveCanaryPassed: false;
    train: StrategyEvidenceSegment;
    test: StrategyEvidenceSegment;
  };
  eligibility: {
    status: StrategyEvidenceStatus;
    nextAuthorityStage: "log_only" | null;
    reasons: string[];
  };
  breakdown: {
    byStyle: StrategyEvidenceBreakdown[];
    byPair: StrategyEvidenceBreakdown[];
  };
}

export interface StrategyEvidenceBreakdown {
  key: string;
  resolved: number;
  changed: number;
  expectancyDeltaR: number;
}

export interface BuildStrategyEvidenceCertificateInput {
  feature: StrategyEvidenceFeature;
  observations: StrategyEvidenceObservation[];
  totalCandidates: number;
  generatedAt?: string;
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function observationReturn(
  observation: StrategyEvidenceObservation,
  decision: StrategyEvidenceDecision,
): number {
  if (
    observation.outcome === "inconclusive" ||
    observation.outcomeR === null ||
    !Number.isFinite(observation.outcomeR)
  ) {
    return 0;
  }
  return decision === "allow" ? observation.outcomeR : 0;
}

function isBeneficial(observation: StrategyEvidenceObservation): boolean {
  return observationReturn(observation, observation.proposedDecision) >
    observationReturn(observation, observation.currentDecision);
}

function maxDrawdown(returns: number[]): number {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of returns) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return round(drawdown);
}

function segmentMetrics(
  observations: StrategyEvidenceObservation[],
): StrategyEvidenceSegment {
  const resolved = observations.filter((item) =>
    item.outcome !== "inconclusive" && item.outcomeR !== null
  );
  const changed = resolved.filter((item) =>
    item.currentDecision !== item.proposedDecision
  );
  const beneficial = changed.filter(isBeneficial).length;
  const harmful = changed.length - beneficial;
  const currentReturns = resolved.map((item) =>
    observationReturn(item, item.currentDecision)
  );
  const proposedReturns = resolved.map((item) =>
    observationReturn(item, item.proposedDecision)
  );
  const currentExpectancy = resolved.length > 0
    ? currentReturns.reduce((sum, value) => sum + value, 0) / resolved.length
    : 0;
  const proposedExpectancy = resolved.length > 0
    ? proposedReturns.reduce((sum, value) => sum + value, 0) / resolved.length
    : 0;

  return {
    resolved: resolved.length,
    changed: changed.length,
    beneficial,
    harmful,
    beneficialRatePercent: changed.length > 0
      ? round(beneficial / changed.length * 100, 2)
      : null,
    currentExpectancyR: round(currentExpectancy),
    proposedExpectancyR: round(proposedExpectancy),
    expectancyDeltaR: round(proposedExpectancy - currentExpectancy),
  };
}

function drawdownDeltaPercent(current: number, proposed: number): number {
  if (current === 0) return proposed === 0 ? 0 : 100;
  return round((proposed - current) / current * 100, 2);
}

function breakdown(
  observations: StrategyEvidenceObservation[],
  keyOf: (observation: StrategyEvidenceObservation) => string,
): StrategyEvidenceBreakdown[] {
  const groups = new Map<string, StrategyEvidenceObservation[]>();
  for (const observation of observations) {
    const key = keyOf(observation);
    groups.set(key, [...(groups.get(key) || []), observation]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const metrics = segmentMetrics(group);
    return {
      key,
      resolved: metrics.resolved,
      changed: metrics.changed,
      expectancyDeltaR: metrics.expectancyDeltaR,
    };
  }).sort((a, b) =>
    b.changed - a.changed || b.resolved - a.resolved ||
    a.key.localeCompare(b.key)
  );
}

/**
 * Builds a reproducible, chronological strategy evidence certificate.
 *
 * The certificate is observation-only. It may recommend Log-only as the next
 * stage, but it cannot update activation state or affect a trade.
 */
export function buildStrategyEvidenceCertificate(
  input: BuildStrategyEvidenceCertificateInput,
): StrategyEvidenceCertificate {
  const featureObservations = input.observations
    .filter((item) => item.feature === input.feature)
    .sort((a, b) =>
      Date.parse(a.observedAt) - Date.parse(b.observedAt) ||
      a.sourceId.localeCompare(b.sourceId)
    );
  const resolved = featureObservations.filter((item) =>
    item.outcome !== "inconclusive" && item.outcomeR !== null
  );
  const splitIndex = resolved.length === 0
    ? 0
    : Math.max(1, Math.floor(resolved.length * 0.7));
  const trainObservations = resolved.slice(0, splitIndex);
  const testObservations = resolved.slice(splitIndex);
  const full = segmentMetrics(resolved);
  const train = segmentMetrics(trainObservations);
  const test = segmentMetrics(testObservations);
  const coveragePercent = input.totalCandidates > 0
    ? round(featureObservations.length / input.totalCandidates * 100, 2)
    : 0;

  const currentReturns = resolved.map((item) =>
    observationReturn(item, item.currentDecision)
  );
  const proposedReturns = resolved.map((item) =>
    observationReturn(item, item.proposedDecision)
  );
  const currentMaxDrawdownR = maxDrawdown(currentReturns);
  const proposedMaxDrawdownR = maxDrawdown(proposedReturns);
  const winningCurrentTrades = resolved.filter((item) =>
    item.currentDecision === "allow" && (item.outcomeR ?? 0) > 0
  );
  const retainedWinningTrades = winningCurrentTrades.filter((item) =>
    item.proposedDecision === "allow"
  );
  const goodTradeRetentionPercent = winningCurrentTrades.length > 0
    ? round(
      retainedWinningTrades.length / winningCurrentTrades.length * 100,
      2,
    )
    : 100;
  const maxDrawdownDeltaPercent = drawdownDeltaPercent(
    currentMaxDrawdownR,
    proposedMaxDrawdownR,
  );

  const outOfSample = test.resolved >= 3 && test.changed >= 1 &&
    test.expectancyDeltaR > 0 &&
    (test.beneficialRatePercent ?? 0) >= 50;
  const walkForwardConsistent = train.changed >= 1 && test.changed >= 1 &&
    train.expectancyDeltaR > 0 && test.expectancyDeltaR > 0;

  const reasons: string[] = [];
  if (full.resolved < 30) {
    reasons.push(`Need 30 resolved; have ${full.resolved}`);
  }
  if (full.changed < 10) {
    reasons.push(`Need 10 changed decisions; have ${full.changed}`);
  }
  if (coveragePercent < 50) {
    reasons.push(`Need 50% evidence coverage; have ${coveragePercent}%`);
  }
  if ((full.beneficialRatePercent ?? 0) < 60) {
    reasons.push(
      `Need 60% useful decision changes; have ${
        full.beneficialRatePercent ?? 0
      }%`,
    );
  }
  if (
    full.expectancyDeltaR <= 0 &&
    maxDrawdownDeltaPercent > -10
  ) {
    reasons.push(
      "Need positive expectancy or at least 10% lower maximum drawdown",
    );
  }
  if (goodTradeRetentionPercent < 70) {
    reasons.push(
      `Need 70% good-trade retention; have ${goodTradeRetentionPercent}%`,
    );
  }
  if (!outOfSample) reasons.push("Out-of-sample test has not passed");
  if (!walkForwardConsistent) {
    reasons.push(
      "Training and test windows do not show the same positive effect",
    );
  }

  const hasScreeningSample = full.resolved >= 30 && full.changed >= 10 &&
    coveragePercent >= 50;
  const eligible = reasons.length === 0;
  const status: StrategyEvidenceStatus = eligible
    ? "eligible_log_only"
    : hasScreeningSample
    ? "keep_shadow"
    : "collecting";

  return {
    contractVersion: STRATEGY_EVIDENCE_CONTRACT_VERSION,
    generatorVersion: STRATEGY_EVIDENCE_GENERATOR_VERSION,
    generatedAt: input.generatedAt || new Date().toISOString(),
    featureKey: input.feature,
    variantKey: "default",
    activationScope: {},
    sourceWindow: {
      start: featureObservations[0]?.observedAt || null,
      end: featureObservations.at(-1)?.observedAt || null,
    },
    sample: {
      totalCandidates: input.totalCandidates,
      evidence: featureObservations.length,
      resolved: full.resolved,
      changed: full.changed,
      coveragePercent,
      trainResolved: train.resolved,
      trainChanged: train.changed,
      testResolved: test.resolved,
      testChanged: test.changed,
      paperResolved: 0,
      liveCanaryResolved: 0,
    },
    effect: {
      beneficial: full.beneficial,
      harmful: full.harmful,
      beneficialRatePercent: full.beneficialRatePercent,
      currentExpectancyR: full.currentExpectancyR,
      proposedExpectancyR: full.proposedExpectancyR,
      expectancyDeltaR: full.expectancyDeltaR,
      currentMaxDrawdownR,
      proposedMaxDrawdownR,
      maxDrawdownDeltaPercent,
      goodTradeRetentionPercent,
    },
    validation: {
      chronologicalSplit: true,
      splitRatio: 0.7,
      outOfSample,
      walkForwardConsistent,
      paperForwardPassed: false,
      liveCanaryPassed: false,
      train,
      test,
    },
    eligibility: {
      status,
      nextAuthorityStage: eligible ? "log_only" : null,
      reasons,
    },
    breakdown: {
      byStyle: breakdown(featureObservations, (item) => item.style),
      byPair: breakdown(featureObservations, (item) => item.symbol),
    },
  };
}
