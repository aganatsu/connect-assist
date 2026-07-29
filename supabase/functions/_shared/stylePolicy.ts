import type { RuntimeConfig } from "./configMapper.ts";
import type {
  TradingStyleMode,
  TradingStyleResolution,
} from "./tradingStyleConfig.ts";

export const STYLE_POLICY_CONTRACT_VERSION = "style-policy.v1.1";

export type StylePolicyEnforcement = "observe_only";

export interface StyleTimeframeRoles {
  bias: string;
  structure: string;
  setup: string;
  confirmation: string;
  refinement: string;
}

export const STYLE_TIMEFRAME_ROLES: Record<
  TradingStyleMode,
  StyleTimeframeRoles
> = {
  scalper: {
    bias: "1h",
    structure: "15min",
    setup: "5min",
    confirmation: "5min",
    refinement: "1min",
  },
  day_trader: {
    bias: "1day",
    structure: "4h",
    setup: "1h",
    confirmation: "15min",
    refinement: "5min",
  },
  swing_trader: {
    bias: "1week",
    structure: "1day",
    setup: "4h",
    confirmation: "1h",
    refinement: "15min",
  },
};

export interface ResolvedStylePolicy {
  contractVersion: typeof STYLE_POLICY_CONTRACT_VERSION;
  basePolicyHash: string;
  policyHash: string;
  enforcement: StylePolicyEnforcement;
  scope: "global" | "pair";
  style: TradingStyleMode;
  symbol: string | null;
  resolvedAt: string;
  timeframes: {
    roles: StyleTimeframeRoles;
    runtimeEntry: string;
    runtimeHTF: string;
  };
  cadence: {
    scanIntervalMinutes: number;
  };
  qualification: {
    minConfluence: number;
    effectiveMinConfluence: number;
    minRiskReward: number;
    minTier1Factors: number;
    impulseZoneGateMode: string;
    minZoneScore: number;
  };
  risk: {
    riskPerTrade: number;
    positionSizingMethod: string;
    maxOpenPositions: number;
    maxPerSymbol: number;
    portfolioHeat: number;
    slMethod: string;
    slBufferPips: number;
    tpMethod: string;
    tpRatio: number;
  };
  management: {
    breakEvenEnabled: boolean;
    breakEvenPips: number;
    trailingStopEnabled: boolean;
    trailingStopPips: number;
    trailingStopActivation: string;
    partialTPEnabled: boolean;
    partialTPPercent: number;
    partialTPLevel: number;
    maxHoldEnabled: boolean;
    maxHoldHours: number;
    structureInvalidationEnabled: boolean;
  };
  lifecycle: {
    stagingTTLMinutes: number;
    limitOrderExpiryMinutes: number;
    maxConfirmationAttempts: number;
  };
  provenance: {
    profileAppliedToRuntime: boolean;
    styleApplied: string[];
    userOverridesPreserved: string[];
  };
}

export interface BuildResolvedStylePolicyInput {
  resolution: TradingStyleResolution;
  config?: RuntimeConfig;
  baseConfig?: RuntimeConfig;
  symbol?: string | null;
  effectiveMinConfluence?: number;
  profileAppliedToRuntime?: boolean;
  resolvedAt?: string;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")
  }}`;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableSerialize(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function buildPolicyContent(input: {
  config: RuntimeConfig;
  style: TradingStyleMode;
  symbol: string | null;
  effectiveMinConfluence: number;
  resolution: TradingStyleResolution;
  profileAppliedToRuntime: boolean;
}) {
  const { config, style } = input;
  return {
    contractVersion:
      STYLE_POLICY_CONTRACT_VERSION as typeof STYLE_POLICY_CONTRACT_VERSION,
    enforcement: "observe_only" as const,
    scope: input.symbol ? "pair" as const : "global" as const,
    style,
    symbol: input.symbol,
    timeframes: {
      roles: { ...STYLE_TIMEFRAME_ROLES[style] },
      runtimeEntry: config.entryTimeframe,
      runtimeHTF: config.htfTimeframe,
    },
    cadence: {
      scanIntervalMinutes: config.scanIntervalMinutes,
    },
    qualification: {
      minConfluence: config.minConfluence,
      effectiveMinConfluence: input.effectiveMinConfluence,
      minRiskReward: config.minRiskReward,
      minTier1Factors: config.minTier1Factors,
      impulseZoneGateMode: config.impulseZoneGateMode,
      minZoneScore: config.minZoneScore,
    },
    risk: {
      riskPerTrade: config.riskPerTrade,
      positionSizingMethod: config.positionSizingMethod,
      maxOpenPositions: config.maxOpenPositions,
      maxPerSymbol: config.maxPerSymbol,
      portfolioHeat: config.portfolioHeat,
      slMethod: config.slMethod,
      slBufferPips: config.slBufferPips,
      tpMethod: config.tpMethod,
      tpRatio: config.tpRatio,
    },
    management: {
      breakEvenEnabled: config.breakEvenEnabled,
      breakEvenPips: config.breakEvenPips,
      trailingStopEnabled: config.trailingStopEnabled,
      trailingStopPips: config.trailingStopPips,
      trailingStopActivation: config.trailingStopActivation,
      partialTPEnabled: config.partialTPEnabled,
      partialTPPercent: config.partialTPPercent,
      partialTPLevel: config.partialTPLevel,
      maxHoldEnabled: config.maxHoldEnabled,
      maxHoldHours: config.maxHoldHours,
      structureInvalidationEnabled: config.structureInvalidationEnabled,
    },
    lifecycle: {
      stagingTTLMinutes: config.stagingTTLMinutes,
      limitOrderExpiryMinutes: config.limitOrderExpiryMinutes,
      maxConfirmationAttempts: config.maxConfirmationAttempts,
    },
    provenance: {
      profileAppliedToRuntime: input.profileAppliedToRuntime,
      styleApplied: [...input.resolution.applied],
      userOverridesPreserved: [...input.resolution.preserved],
    },
  };
}

/**
 * Builds immutable evidence describing the style policy resolved for a scan,
 * setup or trade. Phase 2C starts in observe-only mode: callers persist this
 * snapshot, but authorization and management behavior remain unchanged.
 */
export async function buildResolvedStylePolicy(
  input: BuildResolvedStylePolicyInput,
): Promise<ResolvedStylePolicy> {
  const config = input.config || input.resolution.config;
  const baseConfig = input.baseConfig || config;
  const style = input.resolution.style;
  const profileAppliedToRuntime = input.profileAppliedToRuntime !== false;
  const content = buildPolicyContent({
    config,
    style,
    symbol: input.symbol || null,
    effectiveMinConfluence: input.effectiveMinConfluence ??
      config.minConfluence,
    resolution: input.resolution,
    profileAppliedToRuntime,
  });
  const baseContent = buildPolicyContent({
    config: baseConfig,
    style,
    symbol: null,
    effectiveMinConfluence: baseConfig.minConfluence,
    resolution: input.resolution,
    profileAppliedToRuntime,
  });

  return {
    ...content,
    basePolicyHash: await sha256(baseContent),
    policyHash: await sha256(content),
    resolvedAt: input.resolvedAt || new Date().toISOString(),
  };
}
