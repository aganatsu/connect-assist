/**
 * Pure zone-local proximity measurements.
 *
 * This module is intentionally decision-neutral in its first release. It
 * reports whether evidence is inside, overlapping, buffered, or outside a
 * candidate zone. Callers may persist the observation, but must not use it to
 * alter scoring or authorization until the policy is explicitly activated.
 */

import {
  type ConceptQualification,
  distanceToBounds,
  type MarketConceptEvidence,
  overlapMetrics,
  type PriceBounds,
  type ProximityClass,
} from "./conceptEvidence.ts";

export const ZONE_LOCAL_CONFLUENCE_VERSION = "zone-local-confluence.v1";

export interface ZoneLocalProximityPolicy {
  /** Fraction of candidate-zone width permitted outside its edge. */
  bufferZoneWidthRatio: number;
  /** Absolute ceiling expressed using the instrument's pip size. */
  maxBufferPips: number;
  /** Volatility ceiling. The smallest ceiling wins. */
  maxBufferATR: number;
  /** Range evidence below this overlap is partial rather than full. */
  fullOverlapPercent: number;
}

export const DEFAULT_ZONE_LOCAL_PROXIMITY_POLICY: ZoneLocalProximityPolicy = {
  bufferZoneWidthRatio: 0.25,
  maxBufferPips: 3,
  maxBufferATR: 0.1,
  fullOverlapPercent: 50,
};

export interface ZoneLocalMeasurement {
  policyVersion: typeof ZONE_LOCAL_CONFLUENCE_VERSION;
  proximityClass: ProximityClass;
  qualifiedLocally: boolean;
  fullCreditEligible: boolean;
  zoneWidth: number;
  zoneWidthPips: number;
  permittedBuffer: number;
  permittedBufferPips: number;
  distanceToZone: number;
  distancePips: number;
  overlapAmount: number;
  overlapPercent: number;
  reasonCode:
    | "inside_zone"
    | "full_overlap"
    | "partial_overlap"
    | "within_local_buffer"
    | "outside_local_buffer";
}

export type ZoneLocalEvidenceSource =
  | "impulse_fib"
  | "historical_sr"
  | "htf_order_block"
  | "htf_fvg"
  | "htf_breaker"
  | "htf_fib"
  | "ltf_refinement"
  | "premium_discount"
  | "liquidity_pool";

export interface ZoneLocalEvidenceObservation {
  source: ZoneLocalEvidenceSource;
  label: string;
  evidence: MarketConceptEvidence | null;
  measurement: ZoneLocalMeasurement | null;
  qualification: ConceptQualification | null;
  /** Existing score attached by the legacy engine. Never changed in observe-only mode. */
  legacyScoreContribution: number;
  enforcement: "observe_only";
  attributes: Record<string, unknown>;
}

export interface ZoneLocalConfluenceObservation {
  policyVersion: typeof ZONE_LOCAL_CONFLUENCE_VERSION;
  enforcement: "observe_only";
  candidateId: string;
  zone: PriceBounds;
  pipSize: number;
  atr: number;
  items: ZoneLocalEvidenceObservation[];
}

export function createZoneLocalConfluenceObservation(input: {
  candidateId: string;
  zone: PriceBounds;
  pipSize: number;
  atr: number;
}): ZoneLocalConfluenceObservation {
  return {
    policyVersion: ZONE_LOCAL_CONFLUENCE_VERSION,
    enforcement: "observe_only",
    candidateId: input.candidateId,
    zone: {
      low: Math.min(input.zone.low, input.zone.high),
      high: Math.max(input.zone.low, input.zone.high),
    },
    pipSize: safePositive(input.pipSize, 0.0001),
    atr: Number.isFinite(input.atr) && input.atr > 0 ? input.atr : 0,
    items: [],
  };
}

export function qualificationFromMeasurement(input: {
  evidenceId: string;
  candidateId: string;
  measurement: ZoneLocalMeasurement;
}): ConceptQualification {
  return {
    evidenceId: input.evidenceId,
    candidateId: input.candidateId,
    role: "zone_layer",
    qualified: input.measurement.qualifiedLocally,
    policyVersion: input.measurement.policyVersion,
    reasonCode: input.measurement.reasonCode,
    // Observe-only means the new policy contributes no score yet.
    scoreContribution: 0,
    proximityClass: input.measurement.proximityClass,
    distanceToZone: input.measurement.distanceToZone,
    distancePips: input.measurement.distancePips,
    overlapAmount: input.measurement.overlapAmount,
    overlapPercent: input.measurement.overlapPercent,
  };
}

export function observeZoneLocalPoint(input: {
  source: ZoneLocalEvidenceSource;
  label: string;
  evidence: MarketConceptEvidence;
  candidate: ZoneLocalConfluenceObservation;
  level: number;
  legacyScoreContribution: number;
  policy?: Partial<ZoneLocalProximityPolicy>;
  attributes?: Record<string, unknown>;
}): ZoneLocalEvidenceObservation {
  const measurement = measurePointAgainstZone({
    zone: input.candidate.zone,
    level: input.level,
    pipSize: input.candidate.pipSize,
    atr: input.candidate.atr,
    policy: input.policy,
  });
  return {
    source: input.source,
    label: input.label,
    evidence: input.evidence,
    measurement,
    qualification: qualificationFromMeasurement({
      evidenceId: input.evidence.evidenceId,
      candidateId: input.candidate.candidateId,
      measurement,
    }),
    legacyScoreContribution: input.legacyScoreContribution,
    enforcement: "observe_only",
    attributes: input.attributes || {},
  };
}

export function observeZoneLocalRange(input: {
  source: ZoneLocalEvidenceSource;
  label: string;
  evidence: MarketConceptEvidence;
  candidate: ZoneLocalConfluenceObservation;
  bounds: PriceBounds;
  legacyScoreContribution: number;
  policy?: Partial<ZoneLocalProximityPolicy>;
  attributes?: Record<string, unknown>;
}): ZoneLocalEvidenceObservation {
  const measurement = measureRangeAgainstZone({
    zone: input.candidate.zone,
    evidence: input.bounds,
    pipSize: input.candidate.pipSize,
    atr: input.candidate.atr,
    policy: input.policy,
  });
  return {
    source: input.source,
    label: input.label,
    evidence: input.evidence,
    measurement,
    qualification: qualificationFromMeasurement({
      evidenceId: input.evidence.evidenceId,
      candidateId: input.candidate.candidateId,
      measurement,
    }),
    legacyScoreContribution: input.legacyScoreContribution,
    enforcement: "observe_only",
    attributes: input.attributes || {},
  };
}

export function observeContextOnly(input: {
  source: ZoneLocalEvidenceSource;
  label: string;
  evidence: MarketConceptEvidence | null;
  candidate: ZoneLocalConfluenceObservation;
  legacyScoreContribution: number;
  reasonCode: string;
  attributes?: Record<string, unknown>;
}): ZoneLocalEvidenceObservation {
  return {
    source: input.source,
    label: input.label,
    evidence: input.evidence,
    measurement: null,
    qualification: input.evidence
      ? {
        evidenceId: input.evidence.evidenceId,
        candidateId: input.candidate.candidateId,
        role: "gameplan_context",
        qualified: false,
        policyVersion: ZONE_LOCAL_CONFLUENCE_VERSION,
        reasonCode: input.reasonCode,
        scoreContribution: 0,
        proximityClass: "context_only",
        distanceToZone: null,
        distancePips: null,
        overlapAmount: null,
        overlapPercent: null,
      }
      : null,
    legacyScoreContribution: input.legacyScoreContribution,
    enforcement: "observe_only",
    attributes: input.attributes || {},
  };
}

function safePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function permittedZoneBuffer(input: {
  zone: PriceBounds;
  pipSize: number;
  atr: number;
  policy?: Partial<ZoneLocalProximityPolicy>;
}): number {
  const policy = {
    ...DEFAULT_ZONE_LOCAL_PROXIMITY_POLICY,
    ...(input.policy || {}),
  };
  const low = Math.min(input.zone.low, input.zone.high);
  const high = Math.max(input.zone.low, input.zone.high);
  const zoneWidth = Math.max(0, high - low);
  const pipSize = safePositive(input.pipSize, 0.0001);
  const candidates = [
    zoneWidth * Math.max(0, policy.bufferZoneWidthRatio),
    pipSize * Math.max(0, policy.maxBufferPips),
  ];
  if (Number.isFinite(input.atr) && input.atr > 0) {
    candidates.push(input.atr * Math.max(0, policy.maxBufferATR));
  }
  return Math.max(0, Math.min(...candidates));
}

export function measurePointAgainstZone(input: {
  zone: PriceBounds;
  level: number;
  pipSize: number;
  atr: number;
  policy?: Partial<ZoneLocalProximityPolicy>;
}): ZoneLocalMeasurement {
  const pipSize = safePositive(input.pipSize, 0.0001);
  const low = Math.min(input.zone.low, input.zone.high);
  const high = Math.max(input.zone.low, input.zone.high);
  const zoneWidth = Math.max(0, high - low);
  const buffer = permittedZoneBuffer(input);
  const distance = distanceToBounds(input.zone, { level: input.level });
  const inside = distance === 0;
  const buffered = !inside && distance <= buffer;
  return {
    policyVersion: ZONE_LOCAL_CONFLUENCE_VERSION,
    proximityClass: inside ? "inside" : buffered ? "buffered" : "context_only",
    qualifiedLocally: inside || buffered,
    fullCreditEligible: inside,
    zoneWidth,
    zoneWidthPips: zoneWidth / pipSize,
    permittedBuffer: buffer,
    permittedBufferPips: buffer / pipSize,
    distanceToZone: distance,
    distancePips: distance / pipSize,
    overlapAmount: 0,
    overlapPercent: 0,
    reasonCode: inside
      ? "inside_zone"
      : buffered
      ? "within_local_buffer"
      : "outside_local_buffer",
  };
}

export function measureRangeAgainstZone(input: {
  zone: PriceBounds;
  evidence: PriceBounds;
  pipSize: number;
  atr: number;
  policy?: Partial<ZoneLocalProximityPolicy>;
}): ZoneLocalMeasurement {
  const policy = {
    ...DEFAULT_ZONE_LOCAL_PROXIMITY_POLICY,
    ...(input.policy || {}),
  };
  const pipSize = safePositive(input.pipSize, 0.0001);
  const low = Math.min(input.zone.low, input.zone.high);
  const high = Math.max(input.zone.low, input.zone.high);
  const zoneWidth = Math.max(0, high - low);
  const overlap = overlapMetrics(input.zone, input.evidence);
  const distance = distanceToBounds(input.zone, input.evidence);
  const buffer = permittedZoneBuffer(input);
  const overlaps = overlap.amount > 0;
  const fullOverlap = overlaps &&
    overlap.percent >= Math.max(0, policy.fullOverlapPercent);
  const buffered = !overlaps && distance <= buffer;
  return {
    policyVersion: ZONE_LOCAL_CONFLUENCE_VERSION,
    proximityClass: fullOverlap
      ? "overlapping"
      : overlaps
      ? "overlapping"
      : buffered
      ? "buffered"
      : "context_only",
    qualifiedLocally: overlaps || buffered,
    fullCreditEligible: fullOverlap,
    zoneWidth,
    zoneWidthPips: zoneWidth / pipSize,
    permittedBuffer: buffer,
    permittedBufferPips: buffer / pipSize,
    distanceToZone: distance,
    distancePips: distance / pipSize,
    overlapAmount: overlap.amount,
    overlapPercent: overlap.percent,
    reasonCode: fullOverlap
      ? "full_overlap"
      : overlaps
      ? "partial_overlap"
      : buffered
      ? "within_local_buffer"
      : "outside_local_buffer",
  };
}
