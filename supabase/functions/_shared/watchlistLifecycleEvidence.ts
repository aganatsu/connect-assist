import type {
  WatchlistDirection,
  WatchlistInvalidation,
} from "./watchlistInvalidation.ts";

export const WATCHLIST_LIFECYCLE_EVIDENCE_VERSION =
  "watchlist-lifecycle-evidence.v2";

export type WatchlistLifecyclePhase =
  | "monitoring_pre_zone"
  | "zone_discovered"
  | "approaching_zone"
  | "at_zone"
  | "local_trigger_active"
  | "local_trigger_swept"
  | "sweep_rejected"
  | "confirmation_ready"
  | "entry_authorized"
  | "position_managing";

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
  | "entry_authorized"
  | "position_managing"
  | "legacy_transition";

export interface WatchlistLifecycleEvidence {
  version: typeof WATCHLIST_LIFECYCLE_EVIDENCE_VERSION;
  reasonCode: WatchlistLifecycleReasonCode;
  phase?: WatchlistLifecyclePhase;
  milestones?: WatchlistLifecyclePhase[];
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
  phase?: WatchlistLifecyclePhase;
  milestones?: WatchlistLifecyclePhase[];
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
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.milestones?.length
      ? { milestones: Array.from(new Set(input.milestones)) }
      : {}),
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

export function deriveWatchlistLifecyclePhase(input: {
  executionEligible: boolean;
  hasZone?: boolean;
  unifiedState?: string | null;
  priceAtZone?: boolean;
  entryTriggerState?: string | null;
  confirmationReady?: boolean;
  entryAuthorized?: boolean;
  positionManaging?: boolean;
}): {
  phase: WatchlistLifecyclePhase;
  milestones: WatchlistLifecyclePhase[];
} {
  if (!input.executionEligible) {
    return {
      phase: "monitoring_pre_zone",
      milestones: ["monitoring_pre_zone"],
    };
  }

  const milestones: WatchlistLifecyclePhase[] = [];
  if (input.hasZone) milestones.push("zone_discovered");

  if (input.unifiedState === "watching") {
    milestones.push("approaching_zone");
  }
  if (
    input.priceAtZone ||
    [
      "at_zone",
      "waiting_for_sweep",
      "waiting_for_reconfirmation",
      "confirmed",
      "triggered",
    ].includes(input.unifiedState || "")
  ) {
    milestones.push("at_zone");
  }

  const triggerState = input.entryTriggerState || "none";
  if (triggerState !== "none") milestones.push("local_trigger_active");
  if (triggerState === "swept_absorbed" || triggerState === "swept_rejected") {
    milestones.push("local_trigger_swept");
  }
  if (triggerState === "swept_rejected") {
    milestones.push("sweep_rejected");
  }
  if (
    input.confirmationReady ||
    input.unifiedState === "confirmed" ||
    input.unifiedState === "triggered"
  ) {
    milestones.push("confirmation_ready");
  }
  if (input.entryAuthorized) milestones.push("entry_authorized");
  if (input.positionManaging) milestones.push("position_managing");

  if (milestones.length === 0) milestones.push("monitoring_pre_zone");
  return {
    phase: milestones[milestones.length - 1],
    milestones,
  };
}
