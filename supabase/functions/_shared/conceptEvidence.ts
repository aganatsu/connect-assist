/**
 * Canonical, behavior-neutral identity and provenance for market concepts.
 *
 * Detectors remain responsible for discovering an entity. Consumers attach
 * qualifications separately so "exists" never silently becomes "eligible".
 */

export const CONCEPT_EVIDENCE_CONTRACT_VERSION = "concept-evidence.v1";

export type MarketConcept =
  | "swing"
  | "structure_break"
  | "fvg"
  | "order_block"
  | "liquidity_pool"
  | "sweep"
  | "reclaim"
  | "displacement"
  | "breaker"
  | "impulse"
  | "fib_level"
  | "support_resistance"
  | "zone";

export type ConceptDirection =
  | "bullish"
  | "bearish"
  | "neutral";

export interface PriceBounds {
  low: number;
  high: number;
}

export interface ConceptDetectorRef {
  name: string;
  version: string;
}

export interface MarketConceptEvidence {
  contractVersion: typeof CONCEPT_EVIDENCE_CONTRACT_VERSION;
  /** Geometric/source identity shared across consumers and detector versions. */
  entityId: string;
  /** Detector-specific observation identity. */
  evidenceId: string;
  concept: MarketConcept;
  detector: ConceptDetectorRef;
  symbol: string;
  timeframe: string;
  observedAt: string;
  sourceCandleStart: string;
  sourceCandleEnd: string;
  direction: ConceptDirection;
  bounds: PriceBounds | null;
  level: number | null;
  lifecycle: string | null;
  attributes: Record<string, unknown>;
}

export type QualificationRole =
  | "gameplan_context"
  | "direction_evidence"
  | "tier_factor"
  | "impulse_poi"
  | "zone_layer"
  | "entry_trigger"
  | "confirmation";

export type ProximityClass =
  | "inside"
  | "overlapping"
  | "buffered"
  | "context_only"
  | "rejected";

export interface ConceptQualification {
  evidenceId: string;
  candidateId: string;
  role: QualificationRole;
  qualified: boolean;
  policyVersion: string;
  reasonCode: string;
  scoreContribution: number;
  proximityClass: ProximityClass | null;
  distanceToZone: number | null;
  distancePips: number | null;
  overlapAmount: number | null;
  overlapPercent: number | null;
}

export interface EvidenceIdentityInput {
  concept: MarketConcept;
  detector: ConceptDetectorRef;
  symbol: string;
  timeframe: string;
  sourceCandleStart: string;
  sourceCandleEnd?: string;
  direction: ConceptDirection;
  bounds?: PriceBounds | null;
  level?: number | null;
  discriminator?: string | number | null;
}

function normalizeNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return value.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeText(value: string): string {
  return value.trim().toUpperCase();
}

function entityIdentityPayload(input: EvidenceIdentityInput): string {
  const bounds = input.bounds
    ? {
      low: Math.min(input.bounds.low, input.bounds.high),
      high: Math.max(input.bounds.low, input.bounds.high),
    }
    : null;
  return [
    CONCEPT_EVIDENCE_CONTRACT_VERSION,
    input.concept,
    normalizeText(input.symbol),
    normalizeText(input.timeframe),
    input.sourceCandleStart,
    input.sourceCandleEnd || input.sourceCandleStart,
    input.direction,
    normalizeNumber(bounds?.low),
    normalizeNumber(bounds?.high),
    normalizeNumber(input.level),
    input.discriminator == null ? "" : String(input.discriminator),
  ].join("|");
}

function fnv1a64(value: string, seed: bigint): string {
  let hash = seed;
  const prime = 0x100000001b3n;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Stable entity ID independent of which detector observed the entity. */
export function buildEntityId(input: EvidenceIdentityInput): string {
  const payload = entityIdentityPayload(input);
  const left = fnv1a64(payload, 0xcbf29ce484222325n);
  const right = fnv1a64(`concept-evidence|${payload}`, 0x84222325cbf29cen);
  return `${input.concept}:entity1-${left}${right}`;
}

/** Detector-specific observation ID for audit and replay. */
export function buildEvidenceId(input: EvidenceIdentityInput): string {
  const entityId = buildEntityId(input);
  const payload = [
    entityId,
    input.detector.name.trim().toLowerCase(),
    input.detector.version.trim().toLowerCase(),
  ].join("|");
  const left = fnv1a64(payload, 0xcbf29ce484222325n);
  const right = fnv1a64(`detector-evidence|${payload}`, 0x84222325cbf29cen);
  return `${input.concept}:evidence1-${left}${right}`;
}

export function buildConceptEvidence(
  input: EvidenceIdentityInput & {
    observedAt: string;
    lifecycle?: string | null;
    attributes?: Record<string, unknown>;
  },
): MarketConceptEvidence {
  const bounds = input.bounds
    ? {
      low: Math.min(input.bounds.low, input.bounds.high),
      high: Math.max(input.bounds.low, input.bounds.high),
    }
    : null;
  return {
    contractVersion: CONCEPT_EVIDENCE_CONTRACT_VERSION,
    entityId: buildEntityId(input),
    evidenceId: buildEvidenceId(input),
    concept: input.concept,
    detector: input.detector,
    symbol: normalizeText(input.symbol),
    timeframe: input.timeframe,
    observedAt: input.observedAt,
    sourceCandleStart: input.sourceCandleStart,
    sourceCandleEnd: input.sourceCandleEnd || input.sourceCandleStart,
    direction: input.direction,
    bounds,
    level: input.level ?? null,
    lifecycle: input.lifecycle ?? null,
    attributes: input.attributes || {},
  };
}

export function overlapMetrics(
  zone: PriceBounds,
  evidence: PriceBounds,
): { amount: number; percent: number } {
  const zoneLow = Math.min(zone.low, zone.high);
  const zoneHigh = Math.max(zone.low, zone.high);
  const evidenceLow = Math.min(evidence.low, evidence.high);
  const evidenceHigh = Math.max(evidence.low, evidence.high);
  const amount = Math.max(
    0,
    Math.min(zoneHigh, evidenceHigh) - Math.max(zoneLow, evidenceLow),
  );
  const evidenceWidth = Math.max(0, evidenceHigh - evidenceLow);
  const percent = evidenceWidth > 0
    ? Math.min(100, (amount / evidenceWidth) * 100)
    : amount > 0
    ? 100
    : 0;
  return { amount, percent };
}

export function distanceToBounds(
  zone: PriceBounds,
  evidence: PriceBounds | { level: number },
): number {
  const zoneLow = Math.min(zone.low, zone.high);
  const zoneHigh = Math.max(zone.low, zone.high);
  const evidenceLow = "level" in evidence
    ? evidence.level
    : Math.min(evidence.low, evidence.high);
  const evidenceHigh = "level" in evidence
    ? evidence.level
    : Math.max(evidence.low, evidence.high);
  if (evidenceHigh < zoneLow) return zoneLow - evidenceHigh;
  if (evidenceLow > zoneHigh) return evidenceLow - zoneHigh;
  return 0;
}
