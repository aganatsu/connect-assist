import type {
  ZoneCandidateShadowRanking,
} from "./zoneCandidateShadowRanking.ts";

export const ZONE_LOCAL_ENFORCEMENT_VERSION = "zone-local-enforcement.v1";
export const ZONE_LOCAL_ACTIVATION_FEATURE = "zone_local_confluence";

export type ZoneLocalRequestedMode = "observe" | "soft" | "hard";
export type StrategyAuthorityStage =
  | "shadow"
  | "log_only"
  | "soft_adjustment"
  | "hard_block";
export type StrategyRuntimeScope =
  | "observation"
  | "paper"
  | "live_canary"
  | "live";
export type ZoneLocalRuntimeTarget = "paper" | "live";

export interface ZoneLocalActivationSnapshot {
  authorityStage: StrategyAuthorityStage;
  runtimeScope: StrategyRuntimeScope;
  runtimeEnforced: boolean;
  revision: number | null;
  evidenceHash: string | null;
  updatedAt: string | null;
}

export interface ZoneLocalModeResolution {
  requestedMode: ZoneLocalRequestedMode;
  effectiveMode: ZoneLocalRequestedMode;
  certifiedMaximum: ZoneLocalRequestedMode;
  runtimeTarget: ZoneLocalRuntimeTarget;
  activationTrusted: boolean;
  reason:
    | "requested_observe"
    | "activation_missing"
    | "runtime_not_enabled"
    | "runtime_scope_mismatch"
    | "capped_by_certified_authority"
    | "certified_mode_enabled";
  activation: ZoneLocalActivationSnapshot | null;
}

export interface ZoneLocalEnforcementDecision {
  contractVersion: typeof ZONE_LOCAL_ENFORCEMENT_VERSION;
  mode: ZoneLocalModeResolution;
  candidateId: string | null;
  allowed: boolean;
  scoreAdjustment: number;
  legacyRank: number | null;
  shadowRank: number | null;
  shadowLocalScore: number | null;
  minimumLocalScore: number;
  localWinnerAligned: boolean;
  reason:
    | "observe_only"
    | "locally_supported"
    | "soft_penalty_missing_evidence"
    | "soft_penalty_rank_disagreement"
    | "soft_penalty_insufficient_local_score"
    | "hard_block_missing_evidence"
    | "hard_block_rank_disagreement"
    | "hard_block_insufficient_local_score";
}

const MODE_RANK: Record<ZoneLocalRequestedMode, number> = {
  observe: 0,
  soft: 1,
  hard: 2,
};

function modeAtRank(rank: number): ZoneLocalRequestedMode {
  if (rank >= 2) return "hard";
  if (rank >= 1) return "soft";
  return "observe";
}

function certifiedMaximum(
  activation: ZoneLocalActivationSnapshot | null,
  runtimeTarget: ZoneLocalRuntimeTarget,
): {
  mode: ZoneLocalRequestedMode;
  trusted: boolean;
  reason: ZoneLocalModeResolution["reason"];
} {
  if (!activation) {
    return { mode: "observe", trusted: false, reason: "activation_missing" };
  }
  if (!activation.runtimeEnforced) {
    return {
      mode: "observe",
      trusted: false,
      reason: "runtime_not_enabled",
    };
  }
  const scopeMatches = runtimeTarget === "paper"
    ? activation.runtimeScope === "paper" ||
      activation.runtimeScope === "live_canary" ||
      activation.runtimeScope === "live"
    : activation.runtimeScope === "live_canary" ||
      activation.runtimeScope === "live";
  if (!scopeMatches) {
    return {
      mode: "observe",
      trusted: false,
      reason: "runtime_scope_mismatch",
    };
  }
  if (activation.authorityStage === "hard_block") {
    return { mode: "hard", trusted: true, reason: "certified_mode_enabled" };
  }
  if (activation.authorityStage === "soft_adjustment") {
    return { mode: "soft", trusted: true, reason: "certified_mode_enabled" };
  }
  return {
    mode: "observe",
    trusted: false,
    reason: "runtime_not_enabled",
  };
}

export function resolveZoneLocalMode(input: {
  requestedMode: unknown;
  runtimeTarget: ZoneLocalRuntimeTarget;
  activation: ZoneLocalActivationSnapshot | null;
}): ZoneLocalModeResolution {
  const requestedMode: ZoneLocalRequestedMode =
    input.requestedMode === "soft" || input.requestedMode === "hard"
      ? input.requestedMode
      : "observe";
  if (requestedMode === "observe") {
    return {
      requestedMode,
      effectiveMode: "observe",
      certifiedMaximum: "observe",
      runtimeTarget: input.runtimeTarget,
      activationTrusted: false,
      reason: "requested_observe",
      activation: input.activation,
    };
  }
  const certified = certifiedMaximum(input.activation, input.runtimeTarget);
  const effectiveRank = Math.min(
    MODE_RANK[requestedMode],
    MODE_RANK[certified.mode],
  );
  const effectiveMode = modeAtRank(effectiveRank);
  return {
    requestedMode,
    effectiveMode,
    certifiedMaximum: certified.mode,
    runtimeTarget: input.runtimeTarget,
    activationTrusted: certified.trusted,
    reason: effectiveMode !== requestedMode
      ? "capped_by_certified_authority"
      : certified.reason,
    activation: input.activation,
  };
}

function safeNonNegative(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function evaluateZoneLocalEnforcement(input: {
  requestedMode: unknown;
  runtimeTarget: ZoneLocalRuntimeTarget;
  activation: ZoneLocalActivationSnapshot | null;
  ranking: ZoneCandidateShadowRanking | null | undefined;
  softPenalty?: number;
  minimumLocalScore?: number;
}): ZoneLocalEnforcementDecision {
  const mode = resolveZoneLocalMode(input);
  const minimumLocalScore = safeNonNegative(input.minimumLocalScore, 1);
  const softPenalty = safeNonNegative(input.softPenalty, 10);
  const ranking = input.ranking || null;
  const localWinnerAligned = ranking?.shadowRank === 1;
  const enoughLocalScore =
    (ranking?.shadowLocalScore ?? -Infinity) >= minimumLocalScore;
  const supported = !!ranking && localWinnerAligned && enoughLocalScore;

  const base = {
    contractVersion: ZONE_LOCAL_ENFORCEMENT_VERSION,
    mode,
    candidateId: ranking?.candidateId || null,
    legacyRank: ranking?.legacyRank ?? null,
    shadowRank: ranking?.shadowRank ?? null,
    shadowLocalScore: ranking?.shadowLocalScore ?? null,
    minimumLocalScore,
    localWinnerAligned,
  } as const;

  if (mode.effectiveMode === "observe") {
    return {
      ...base,
      allowed: true,
      scoreAdjustment: 0,
      reason: "observe_only",
    };
  }
  if (supported) {
    return {
      ...base,
      allowed: true,
      scoreAdjustment: 0,
      reason: "locally_supported",
    };
  }
  if (mode.effectiveMode === "soft") {
    return {
      ...base,
      allowed: true,
      scoreAdjustment: -softPenalty,
      reason: !ranking
        ? "soft_penalty_missing_evidence"
        : !localWinnerAligned
        ? "soft_penalty_rank_disagreement"
        : "soft_penalty_insufficient_local_score",
    };
  }
  return {
    ...base,
    allowed: false,
    scoreAdjustment: 0,
    reason: !ranking
      ? "hard_block_missing_evidence"
      : !localWinnerAligned
      ? "hard_block_rank_disagreement"
      : "hard_block_insufficient_local_score",
  };
}
