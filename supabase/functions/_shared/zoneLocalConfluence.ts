/**
 * Pure zone-local proximity measurements.
 *
 * This module is intentionally decision-neutral in its first release. It
 * reports whether evidence is inside, overlapping, buffered, or outside a
 * candidate zone. Callers may persist the observation, but must not use it to
 * alter scoring or authorization until the policy is explicitly activated.
 */

import {
  distanceToBounds,
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
