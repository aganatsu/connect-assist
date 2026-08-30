import {
  type CrossTimeframeShadowPolicy,
  DEFAULT_CROSS_TF_SHADOW_POLICY,
} from "./crossTimeframeShadowValidation.ts";
import type {
  StrategyAuthorityStage,
  StrategyRuntimeScope,
} from "./zoneLocalEnforcement.ts";

export const CROSS_TF_AUTHORITY_VERSION = "cross-tf-authority.v1";
export const CROSS_TF_ACTIVATION_FEATURE = "cross_timeframe_authority";

export type CrossTimeframeAuthorityMode = "observe" | "soft" | "hard";
export type CrossTimeframeRuntimeTarget = "paper" | "live";
export type CrossTimeframeRetestPolicy =
  | "fresh_only"
  | "fresh_or_held"
  | "any_non_violated";

export interface CrossTimeframeAuthorityConfig {
  mode: CrossTimeframeAuthorityMode;
  requireNestedImpulse: boolean;
  allowStandaloneLowerTimeframe: boolean;
  maximumZoneSeparationATR: number;
  minimumParentChildOverlapPercent: number;
  requireSweepOrigin: boolean;
  retestQuality: CrossTimeframeRetestPolicy;
  maximumCandidatesPerTimeframe: number;
}

export interface CrossTimeframeActivationSnapshot {
  authorityStage: StrategyAuthorityStage;
  runtimeScope: StrategyRuntimeScope;
  runtimeEnforced: boolean;
  revision: number | null;
  evidenceHash: string | null;
  updatedAt: string | null;
}

export interface CrossTimeframeAuthorityResolution {
  contractVersion: typeof CROSS_TF_AUTHORITY_VERSION;
  available: true;
  requestedMode: CrossTimeframeAuthorityMode;
  certifiedMaximum: CrossTimeframeAuthorityMode;
  effectiveMode: CrossTimeframeAuthorityMode;
  runtimeTarget: CrossTimeframeRuntimeTarget;
  activationTrusted: boolean;
  reason:
    | "requested_observe"
    | "activation_missing"
    | "runtime_not_enabled"
    | "runtime_scope_mismatch"
    | "capped_by_certified_authority"
    | "certified_mode_enabled";
  config: CrossTimeframeAuthorityConfig;
  policy: CrossTimeframeShadowPolicy;
  activation: CrossTimeframeActivationSnapshot | null;
}

const MODE_RANK: Record<CrossTimeframeAuthorityMode, number> = {
  observe: 0,
  soft: 1,
  hard: 2,
};

function modeAtRank(rank: number): CrossTimeframeAuthorityMode {
  if (rank >= MODE_RANK.hard) return "hard";
  if (rank >= MODE_RANK.soft) return "soft";
  return "observe";
}

function finiteWithin(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function normalizeCrossTimeframeAuthorityConfig(
  raw: Record<string, unknown> | null | undefined,
): CrossTimeframeAuthorityConfig {
  const mode: CrossTimeframeAuthorityMode =
    raw?.crossTfAuthorityMode === "soft" ||
      raw?.crossTfAuthorityMode === "hard"
      ? raw.crossTfAuthorityMode
      : "observe";
  const retestQuality: CrossTimeframeRetestPolicy =
    raw?.crossTfRetestQuality === "fresh_only" ||
      raw?.crossTfRetestQuality === "any_non_violated"
      ? raw.crossTfRetestQuality
      : "fresh_or_held";
  return {
    mode,
    requireNestedImpulse: raw?.crossTfRequireNestedImpulse !== false,
    allowStandaloneLowerTimeframe:
      raw?.crossTfAllowStandaloneLowerTimeframe === true,
    maximumZoneSeparationATR: finiteWithin(
      raw?.crossTfMaximumZoneSeparationATR,
      DEFAULT_CROSS_TF_SHADOW_POLICY.maximumZoneSeparationATR,
      0,
      3,
    ),
    minimumParentChildOverlapPercent: finiteWithin(
      raw?.crossTfMinimumParentChildOverlapPercent,
      DEFAULT_CROSS_TF_SHADOW_POLICY.minimumParentChildOverlapPercent,
      0,
      100,
    ),
    requireSweepOrigin: raw?.crossTfRequireSweepOrigin === true,
    retestQuality,
    maximumCandidatesPerTimeframe: Math.round(
      finiteWithin(
        raw?.crossTfMaximumCandidatesPerTimeframe,
        DEFAULT_CROSS_TF_SHADOW_POLICY.maximumCandidatesPerTimeframe,
        1,
        5,
      ),
    ),
  };
}

export function crossTimeframePolicyFromConfig(
  config: CrossTimeframeAuthorityConfig,
): CrossTimeframeShadowPolicy {
  const allowedRetestQuality = config.retestQuality === "fresh_only"
    ? ["fresh"] as const
    : config.retestQuality === "any_non_violated"
    ? ["fresh", "tapped_and_held", "partially_mitigated"] as const
    : ["fresh", "tapped_and_held"] as const;
  return {
    ...DEFAULT_CROSS_TF_SHADOW_POLICY,
    requireNestedImpulse: config.requireNestedImpulse,
    allowStandaloneLowerTimeframe: config.allowStandaloneLowerTimeframe,
    maximumZoneSeparationATR: config.maximumZoneSeparationATR,
    minimumParentChildOverlapPercent: config.minimumParentChildOverlapPercent,
    requireSweepOrigin: config.requireSweepOrigin,
    allowedRetestQuality: [...allowedRetestQuality],
    maximumCandidatesPerTimeframe: config.maximumCandidatesPerTimeframe,
  } as CrossTimeframeShadowPolicy;
}

function certifiedMaximum(
  activation: CrossTimeframeActivationSnapshot | null,
  runtimeTarget: CrossTimeframeRuntimeTarget,
): {
  mode: CrossTimeframeAuthorityMode;
  trusted: boolean;
  reason: CrossTimeframeAuthorityResolution["reason"];
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

export function resolveCrossTimeframeAuthority(input: {
  rawConfig: Record<string, unknown> | null | undefined;
  runtimeTarget: CrossTimeframeRuntimeTarget;
  activation: CrossTimeframeActivationSnapshot | null;
}): CrossTimeframeAuthorityResolution {
  const config = normalizeCrossTimeframeAuthorityConfig(input.rawConfig);
  if (config.mode === "observe") {
    return {
      contractVersion: CROSS_TF_AUTHORITY_VERSION,
      available: true,
      requestedMode: "observe",
      certifiedMaximum: "observe",
      effectiveMode: "observe",
      runtimeTarget: input.runtimeTarget,
      activationTrusted: false,
      reason: "requested_observe",
      config,
      policy: crossTimeframePolicyFromConfig(config),
      activation: input.activation,
    };
  }
  const certified = certifiedMaximum(input.activation, input.runtimeTarget);
  const effectiveMode = modeAtRank(
    Math.min(MODE_RANK[config.mode], MODE_RANK[certified.mode]),
  );
  return {
    contractVersion: CROSS_TF_AUTHORITY_VERSION,
    available: true,
    requestedMode: config.mode,
    certifiedMaximum: certified.mode,
    effectiveMode,
    runtimeTarget: input.runtimeTarget,
    activationTrusted: certified.trusted,
    reason: effectiveMode === config.mode
      ? certified.reason
      : certified.mode === "observe"
      ? certified.reason
      : "capped_by_certified_authority",
    config,
    policy: crossTimeframePolicyFromConfig(config),
    activation: input.activation,
  };
}
