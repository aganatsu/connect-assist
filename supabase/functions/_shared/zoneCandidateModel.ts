/**
 * Phase 3 candidate lifecycle and ranking model.
 *
 * This contract is observation-only until controlled enforcement is explicitly
 * activated. It never selects the production zone or authorizes a trade.
 */

import type { Candle } from "./smcAnalysis.ts";

export const ZONE_CANDIDATE_MODEL_VERSION = "zone-candidate-model.v1";

export type CanonicalZoneLifecycleState =
  | "fresh"
  | "tapped_and_held"
  | "partially_mitigated"
  | "violated";

export interface CanonicalZoneLifecycleObservation {
  contractVersion: typeof ZONE_CANDIDATE_MODEL_VERSION;
  state: CanonicalZoneLifecycleState;
  retestCount: number;
  maxPenetrationPercent: number;
  lastTouchIndex: number | null;
  lastTouchClosedOutsideNearBoundary: boolean;
  violatedAtIndex: number | null;
  structureIntact: boolean;
  explanation: string;
}

export interface ZoneCandidateModelFactors {
  zoneLocalConfluence: number;
  proximityToCurrentPrice: number;
  sweepQuality: number;
  retestQuality: number;
  displacementQuality: number;
  structuralImportance: number;
}

export interface ZoneCandidateModelObservation {
  contractVersion: typeof ZONE_CANDIDATE_MODEL_VERSION;
  enforcement: "observe_only";
  candidateId: string;
  rank: number;
  topCandidate: boolean;
  eligible: boolean;
  totalScore: number;
  distanceToCurrentPrice: number;
  distanceATR: number | null;
  lifecycle: CanonicalZoneLifecycleObservation;
  factors: ZoneCandidateModelFactors;
}

export interface ZoneCandidateModelInput {
  candidateId: string;
  zone: {
    low: number;
    high: number;
    direction: "bullish" | "bearish";
  };
  currentPrice: number;
  atr: number;
  localConfluenceScore: number;
  liquiditySweepQualified: boolean;
  impulseSweepOrigin: boolean;
  lifecycle: CanonicalZoneLifecycleObservation;
  displacementPercentile: number | null;
  htfLayerCount: number;
  fibScore: number;
  fibDepth: number;
}

function boundsDistance(
  price: number,
  zone: { low: number; high: number },
): number {
  const low = Math.min(zone.low, zone.high);
  const high = Math.max(zone.low, zone.high);
  if (price < low) return low - price;
  if (price > high) return price - high;
  return 0;
}

export function classifyZoneCandidateLifecycle(input: {
  zone: {
    low: number;
    high: number;
    direction: "bullish" | "bearish";
  };
  candlesAfterFormation: Candle[];
}): CanonicalZoneLifecycleObservation {
  const low = Math.min(input.zone.low, input.zone.high);
  const high = Math.max(input.zone.low, input.zone.high);
  const width = high - low;
  let retestCount = 0;
  let maxPenetrationPercent = 0;
  let lastTouchIndex: number | null = null;
  let lastTouchClosedOutsideNearBoundary = false;
  let violatedAtIndex: number | null = null;
  let previouslyInside = false;

  if (!(width > 0)) {
    return {
      contractVersion: ZONE_CANDIDATE_MODEL_VERSION,
      state: "violated",
      retestCount: 0,
      maxPenetrationPercent: 0,
      lastTouchIndex: null,
      lastTouchClosedOutsideNearBoundary: false,
      violatedAtIndex: null,
      structureIntact: false,
      explanation: "Zone bounds are invalid",
    };
  }

  for (let index = 0; index < input.candlesAfterFormation.length; index++) {
    const candle = input.candlesAfterFormation[index];
    const touched = input.zone.direction === "bullish"
      ? candle.low <= high
      : candle.high >= low;
    const closedThrough = input.zone.direction === "bullish"
      ? candle.close < low
      : candle.close > high;
    if (closedThrough) {
      violatedAtIndex = index;
      lastTouchIndex = index;
      break;
    }
    if (touched) {
      if (!previouslyInside) retestCount++;
      lastTouchIndex = index;
      const penetration = input.zone.direction === "bullish"
        ? (high - Math.max(candle.low, low)) / width
        : (Math.min(candle.high, high) - low) / width;
      maxPenetrationPercent = Math.max(
        maxPenetrationPercent,
        Math.max(0, Math.min(100, penetration * 100)),
      );
      lastTouchClosedOutsideNearBoundary = input.zone.direction === "bullish"
        ? candle.close > high
        : candle.close < low;
    }
    previouslyInside = touched;
  }

  const state: CanonicalZoneLifecycleState = violatedAtIndex !== null
    ? "violated"
    : lastTouchIndex === null
    ? "fresh"
    : lastTouchClosedOutsideNearBoundary
    ? "tapped_and_held"
    : "partially_mitigated";

  const explanation = state === "fresh"
    ? "Price has not returned to the candidate zone"
    : state === "tapped_and_held"
    ? `Price retested ${retestCount} time(s) and the latest touch closed back outside the near boundary`
    : state === "partially_mitigated"
    ? `Price entered the zone ${retestCount} time(s); the latest touch did not close back outside the near boundary`
    : `Price closed through the far boundary at post-formation candle ${violatedAtIndex}`;

  return {
    contractVersion: ZONE_CANDIDATE_MODEL_VERSION,
    state,
    retestCount,
    maxPenetrationPercent: Number(maxPenetrationPercent.toFixed(2)),
    lastTouchIndex,
    lastTouchClosedOutsideNearBoundary,
    violatedAtIndex,
    structureIntact: violatedAtIndex === null,
    explanation,
  };
}

function lifecycleScore(state: CanonicalZoneLifecycleState): number {
  switch (state) {
    case "tapped_and_held":
      return 3;
    case "fresh":
      return 2;
    case "partially_mitigated":
      return 0.75;
    case "violated":
      return -100;
  }
}

function proximityScore(distanceATR: number | null): number {
  if (distanceATR === null) return 0;
  if (distanceATR === 0) return 3;
  if (distanceATR <= 0.25) return 2.5;
  if (distanceATR <= 0.5) return 2;
  if (distanceATR <= 1) return 1;
  return 0;
}

export function rankZoneCandidateModels(
  candidates: readonly ZoneCandidateModelInput[],
): Map<string, ZoneCandidateModelObservation> {
  const observations = candidates.map((candidate) => {
    const distanceToCurrentPrice = boundsDistance(
      candidate.currentPrice,
      candidate.zone,
    );
    const distanceATR = candidate.atr > 0
      ? distanceToCurrentPrice / candidate.atr
      : null;
    const factors: ZoneCandidateModelFactors = {
      zoneLocalConfluence: Math.min(
        5,
        Math.max(0, candidate.localConfluenceScore),
      ),
      proximityToCurrentPrice: proximityScore(distanceATR),
      sweepQuality: (candidate.impulseSweepOrigin ? 1.5 : 0) +
        (candidate.liquiditySweepQualified ? 1.5 : 0),
      retestQuality: lifecycleScore(candidate.lifecycle.state),
      displacementQuality: candidate.displacementPercentile === null
        ? 0
        : Math.max(0, Math.min(4, candidate.displacementPercentile / 25)),
      structuralImportance: Math.min(
        4,
        Math.max(0, candidate.htfLayerCount * 0.75) +
          Math.max(0, candidate.fibScore * 0.35) +
          Math.max(0, candidate.fibDepth),
      ),
    };
    const eligible = candidate.lifecycle.state !== "violated";
    const totalScore = eligible
      ? Object.values(factors).reduce((sum, value) => sum + value, 0)
      : -100;
    const observation: ZoneCandidateModelObservation = {
      contractVersion: ZONE_CANDIDATE_MODEL_VERSION,
      enforcement: "observe_only",
      candidateId: candidate.candidateId,
      rank: 0,
      topCandidate: false,
      eligible,
      totalScore: Number(totalScore.toFixed(4)),
      distanceToCurrentPrice,
      distanceATR: distanceATR === null ? null : Number(distanceATR.toFixed(6)),
      lifecycle: candidate.lifecycle,
      factors,
    };
    return {
      input: candidate,
      observation,
    };
  });

  observations.sort((a, b) =>
    Number(b.observation.eligible) - Number(a.observation.eligible) ||
    b.observation.totalScore - a.observation.totalScore ||
    b.input.fibDepth - a.input.fibDepth ||
    a.input.candidateId.localeCompare(b.input.candidateId)
  );
  observations.forEach(({ observation }, index) => {
    observation.rank = index + 1;
    observation.topCandidate = index < 3;
  });
  return new Map(
    observations.map(({ observation }) => [
      observation.candidateId,
      observation,
    ]),
  );
}
