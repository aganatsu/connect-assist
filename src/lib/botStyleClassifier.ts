// UI metadata and readers for the canonical runtime style-policy snapshot.
// Executable profile values live only in the Edge Function shared resolver.

export const TRADING_STYLE_MODES = [
  "scalper",
  "day_trader",
  "swing_trader",
] as const;

export type TradingStyleMode = (typeof TRADING_STYLE_MODES)[number];

export const STYLE_META: Record<TradingStyleMode, { label: string; icon: string; color: string; description: string }> = {
  scalper: {
    label: "Scalper",
    icon: "⚡",
    color: "text-warning bg-warning/10 border-warning/30",
    description: "Short-horizon setups with frequent scanning and fast exits.",
  },
  day_trader: {
    label: "Day Trader",
    icon: "📊",
    color: "text-primary bg-primary/10 border-primary/30",
    description: "Intraday setups with balanced qualification and management.",
  },
  swing_trader: {
    label: "Swing Trader",
    icon: "📈",
    color: "text-success bg-success/10 border-success/30",
    description: "Multi-day setups with wider risk and larger targets.",
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

export function getActiveStyle(config: unknown): TradingStyleMode {
  const tradingStyle = asRecord(asRecord(config).tradingStyle);
  const mode = tradingStyle.mode || "day_trader";
  return isTradingStyleMode(mode) ? mode : "day_trader";
}

export function isTradingStyleMode(value: unknown): value is TradingStyleMode {
  return TRADING_STYLE_MODES.includes(value as TradingStyleMode);
}

/**
 * Selecting a style records intent only. It deliberately preserves every
 * explicit config override; the backend resolver owns executable profile
 * values and records the resulting effective policy on the next scan.
 */
export function selectTradingStyle(
  config: unknown,
  mode: TradingStyleMode,
): Record<string, unknown> {
  const current = asRecord(config);
  const tradingStyle = asRecord(current.tradingStyle);
  return {
    ...current,
    tradingStyle: {
      ...tradingStyle,
      mode,
    },
  };
}

export interface RuntimeStylePolicy {
  contractVersion: string;
  basePolicyHash: string;
  policyHash: string;
  enforcement: string;
  scope: "global" | "pair";
  style: TradingStyleMode;
  symbol: string | null;
  resolvedAt: string;
  timeframes: {
    roles: {
      bias: string;
      structure: string;
      setup: string;
      confirmation: string;
      refinement: string;
    };
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
    tpRatio: number;
  };
  management: {
    breakEvenEnabled: boolean;
    trailingStopEnabled: boolean;
    partialTPEnabled: boolean;
    maxHoldEnabled: boolean;
    maxHoldHours: number;
  };
  lifecycle: {
    gamePlanValidityMinutes: number;
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

export function readRuntimeStylePolicy(
  value: unknown,
): RuntimeStylePolicy | null {
  if (!value || typeof value !== "object") return null;
  const policy = value as Partial<RuntimeStylePolicy>;
  if (
    !isTradingStyleMode(policy.style) ||
    typeof policy.contractVersion !== "string" ||
    typeof policy.basePolicyHash !== "string" ||
    typeof policy.policyHash !== "string" ||
    !policy.timeframes ||
    !policy.cadence ||
    !policy.qualification ||
    !policy.risk ||
    !policy.management ||
    !policy.lifecycle ||
    !policy.provenance ||
    !Array.isArray(policy.provenance.userOverridesPreserved)
  ) {
    return null;
  }
  const legacyValidityMinutes = policy.style === "scalper"
    ? 120
    : policy.style === "swing_trader"
    ? 1440
    : 240;
  const parsedValidityMinutes = Number(
    (policy.lifecycle as Partial<RuntimeStylePolicy["lifecycle"]>)
      .gamePlanValidityMinutes,
  );
  return {
    ...(policy as RuntimeStylePolicy),
    lifecycle: {
      ...(policy.lifecycle as RuntimeStylePolicy["lifecycle"]),
      gamePlanValidityMinutes:
        Number.isFinite(parsedValidityMinutes) && parsedValidityMinutes > 0
          ? parsedValidityMinutes
          : legacyValidityMinutes,
    },
  };
}

export function getScanLogMeta(
  scanLog: unknown,
): Record<string, unknown> | null {
  let details = asRecord(scanLog).details_json;
  if (typeof details === "string") {
    try {
      details = JSON.parse(details);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(details)) return null;
  const meta = details.find((detail: unknown) => asRecord(detail).__meta);
  return meta && typeof meta === "object" ? meta : null;
}
