import type {
  WatchlistDirection,
  WatchlistInvalidation,
} from "./watchlistInvalidation.ts";

export const WATCHLIST_LIFECYCLE_EVIDENCE_VERSION =
  "watchlist-lifecycle-evidence.v1";

export type WatchlistLifecycleReasonCode =
  | "structural_boundary_breached"
  | "structural_boundary_repaired"
  | "ttl_expired"
  | "manual_dismissal"
  | "pre_zone_handoff"
  | "pre_zone_quality_lost"
  | "qualified"
  | "blocked_after_qualification"
  | "fresh_direction_disagreement_retained"
  | "fresh_score_below_watch_threshold_retained"
  | "waiting_for_local_sweep"
  | "waiting_for_reconfirmation"
  | "waiting_for_zone_confirmation"
  | "monitoring_pre_zone"
  | "legacy_transition";

export interface WatchlistLifecycleEvidence {
  version: typeof WATCHLIST_LIFECYCLE_EVIDENCE_VERSION;
  reasonCode: WatchlistLifecycleReasonCode;
  observedAt: string;
  observedPrice?: number | null;
  frozenDirection?: WatchlistDirection | null;
  freshDirection?: WatchlistDirection | null;
  boundary?: {
    level: number | null;
    source: WatchlistInvalidation["source"];
    bufferPrice: number;
    zone: WatchlistInvalidation["zone"];
  } | null;
  score?: number | null;
  threshold?: number | null;
  sweep?: Record<string, unknown> | null;
  detail?: Record<string, unknown> | null;
}

export function buildWatchlistLifecycleEvidence(input: {
  reasonCode: WatchlistLifecycleReasonCode;
  observedAt?: string;
  observedPrice?: number | null;
  frozenDirection?: WatchlistDirection | null;
  freshDirection?: WatchlistDirection | null;
  invalidation?: WatchlistInvalidation | null;
  score?: number | null;
  threshold?: number | null;
  sweep?: Record<string, unknown> | null;
  detail?: Record<string, unknown> | null;
}): WatchlistLifecycleEvidence {
  return {
    version: WATCHLIST_LIFECYCLE_EVIDENCE_VERSION,
    reasonCode: input.reasonCode,
    observedAt: input.observedAt || new Date().toISOString(),
    observedPrice: input.observedPrice ?? null,
    frozenDirection: input.frozenDirection ?? null,
    freshDirection: input.freshDirection ?? null,
    boundary: input.invalidation
      ? {
        level: input.invalidation.level,
        source: input.invalidation.source,
        bufferPrice: input.invalidation.bufferPrice,
        zone: input.invalidation.zone,
      }
      : null,
    score: input.score ?? null,
    threshold: input.threshold ?? null,
    sweep: input.sweep ?? null,
    detail: input.detail ?? null,
  };
}
