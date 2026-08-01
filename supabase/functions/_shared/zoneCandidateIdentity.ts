/**
 * zoneCandidateIdentity.ts — canonical candidate identity for zone POIs.
 *
 * Phase 1 (observation only). A candidate ID is assigned the moment a POI is
 * first mapped inside an impulse leg — BEFORE qualification, scoring or
 * local-confluence processing — so that candidates rejected early carry the
 * exact same deterministic ID they would have received had they survived.
 *
 * When `poi.evidence.entityId` already exists it is reused verbatim: this
 * helper produces the identical value, so joins against
 * `zone_candidate_shadow_observations.candidate_id` stay exact.
 */

import { buildEntityId } from "./conceptEvidence.ts";
import type { ImpulsePOI } from "./impulseZoneEngine.ts";

export const ZONE_CANDIDATE_IDENTITY_VERSION = "zone-candidate-identity.v1";

export interface CandidateIdentityInput {
  symbol: string;
  timeframe: string;
  poi: Pick<ImpulsePOI, "type" | "high" | "low" | "direction">;
  /** Formation candle timestamp (the POI source candle datetime). */
  sourceCandleStart: string;
  sourceCandleEnd?: string;
  detectorName?: string;
}

/** Deterministic candidate ID from geometry + formation time. */
export function buildZoneCandidateId(input: CandidateIdentityInput): string {
  return buildEntityId({
    concept: input.poi.type === "fvg" ? "fvg" : "order_block",
    detector: {
      name: input.detectorName ??
        (input.poi.type === "fvg"
          ? "smcAnalysis.detectFVGs"
          : "smcAnalysis.detectOrderBlocks"),
      version: "1",
    },
    symbol: input.symbol,
    timeframe: input.timeframe,
    sourceCandleStart: input.sourceCandleStart,
    sourceCandleEnd: input.sourceCandleEnd ?? input.sourceCandleStart,
    direction: input.poi.direction,
    bounds: { high: input.poi.high, low: input.poi.low },
  });
}

/**
 * Canonical ID for a mapped POI. Reuses the evidence entity ID when the engine
 * produced one (identical value), otherwise derives it from the same inputs.
 */
export function canonicalCandidateId(
  poi: ImpulsePOI,
  fallback: { symbol: string; timeframe: string; sourceCandleStart?: string },
): string {
  if (poi.evidence?.entityId) return poi.evidence.entityId;
  return buildZoneCandidateId({
    symbol: fallback.symbol,
    timeframe: fallback.timeframe,
    poi,
    sourceCandleStart: fallback.sourceCandleStart ?? `idx:${poi.candleIndex}`,
  });
}
