import type {
  ResolvedStylePolicy,
  StyleTimeframeRoles,
} from "./stylePolicy.ts";
import type { TradingStyleMode } from "./tradingStyleConfig.ts";

export type AnalysisTimeframe =
  | "1m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "4h"
  | "1d"
  | "1w"
  | "1M";

export interface AuthoritativeTimeframeRoles {
  bias: AnalysisTimeframe;
  structure: AnalysisTimeframe;
  setup: AnalysisTimeframe;
  confirmation: AnalysisTimeframe;
  refinement: AnalysisTimeframe;
}

export interface TimeframeAuthority {
  style: TradingStyleMode;
  roles: AuthoritativeTimeframeRoles;
  runtimeEntry: AnalysisTimeframe;
  runtimeHTF: AnalysisTimeframe;
  direction: {
    bias: AnalysisTimeframe;
    structure: AnalysisTimeframe;
    confirmation: AnalysisTimeframe;
  };
  zone: {
    top: AnalysisTimeframe;
    mid: AnalysisTimeframe;
    low: AnalysisTimeframe;
  };
  requiredStructuralTimeframes: AnalysisTimeframe[];
}

export interface BoundTimeframeCandles<T> {
  bias: T[];
  structure: T[];
  setup: T[];
  confirmation: T[];
  refinement: T[];
  runtimeEntry: T[];
  runtimeHTF: T[];
}

const NORMALIZED_TIMEFRAMES: Record<string, AnalysisTimeframe> = {
  "1m": "1m",
  "1min": "1m",
  "5m": "5m",
  "5min": "5m",
  "15m": "15m",
  "15min": "15m",
  "30m": "30m",
  "30min": "30m",
  "1h": "1h",
  "60m": "1h",
  "60min": "1h",
  "4h": "4h",
  "240m": "4h",
  "1d": "1d",
  "1day": "1d",
  "daily": "1d",
  "d": "1d",
  "1w": "1w",
  "1week": "1w",
  "weekly": "1w",
  "w": "1w",
  "1mo": "1M",
  "1month": "1M",
  "monthly": "1M",
};

export function normalizeAnalysisTimeframe(
  value: unknown,
  fallback: AnalysisTimeframe = "15m",
): AnalysisTimeframe {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  // Preserve the provider's case-sensitive monthly interval. Lowercasing
  // "1M" would otherwise turn it into the one-minute "1m" interval.
  if (trimmed === "1M") return "1M";
  return NORMALIZED_TIMEFRAMES[trimmed.toLowerCase()] || fallback;
}

export function formatAnalysisTimeframe(
  timeframe: AnalysisTimeframe,
): string {
  const labels: Record<AnalysisTimeframe, string> = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1H",
    "4h": "4H",
    "1d": "Daily",
    "1w": "Weekly",
    "1M": "Monthly",
  };
  return labels[timeframe];
}

function normalizeRoles(
  roles: StyleTimeframeRoles,
): AuthoritativeTimeframeRoles {
  return {
    bias: normalizeAnalysisTimeframe(roles.bias, "1d"),
    structure: normalizeAnalysisTimeframe(roles.structure, "4h"),
    setup: normalizeAnalysisTimeframe(roles.setup, "1h"),
    confirmation: normalizeAnalysisTimeframe(roles.confirmation, "15m"),
    refinement: normalizeAnalysisTimeframe(roles.refinement, "5m"),
  };
}

/**
 * Converts an immutable style-policy snapshot into the single timeframe
 * authority consumed by analysis engines.
 *
 * Direction and zone structure use bias → structure → setup. The separate
 * confirmation/refinement roles remain available for entry validation and are
 * not silently substituted for structural analysis.
 */
export function resolveTimeframeAuthority(
  policy: Pick<ResolvedStylePolicy, "style" | "timeframes">,
): TimeframeAuthority {
  const roles = normalizeRoles(policy.timeframes.roles);
  const runtimeEntry = normalizeAnalysisTimeframe(
    policy.timeframes.runtimeEntry,
    roles.confirmation,
  );
  const runtimeHTF = normalizeAnalysisTimeframe(
    policy.timeframes.runtimeHTF,
    roles.bias,
  );
  const requiredStructuralTimeframes = Array.from(
    new Set<AnalysisTimeframe>([
      roles.bias,
      roles.structure,
      roles.setup,
      runtimeEntry,
    ]),
  );

  return {
    style: policy.style,
    roles,
    runtimeEntry,
    runtimeHTF,
    direction: {
      bias: roles.bias,
      structure: roles.structure,
      confirmation: roles.setup,
    },
    zone: {
      top: roles.bias,
      mid: roles.structure,
      low: roles.setup,
    },
    requiredStructuralTimeframes,
  };
}

export function buildTimeframeCandleMap<T>(
  sources: Array<{ timeframe: unknown; candles: T[] | null | undefined }>,
): Map<AnalysisTimeframe, T[]> {
  const result = new Map<AnalysisTimeframe, T[]>();
  for (const source of sources) {
    if (!Array.isArray(source.candles)) continue;
    const timeframe = normalizeAnalysisTimeframe(source.timeframe);
    const existing = result.get(timeframe);
    if (!existing || source.candles.length > existing.length) {
      result.set(timeframe, source.candles);
    }
  }
  return result;
}

export function bindTimeframeCandles<T>(
  authority: TimeframeAuthority,
  candlesByTimeframe: Map<AnalysisTimeframe, T[]>,
): BoundTimeframeCandles<T> {
  const get = (timeframe: AnalysisTimeframe): T[] =>
    candlesByTimeframe.get(timeframe) || [];
  return {
    bias: get(authority.roles.bias),
    structure: get(authority.roles.structure),
    setup: get(authority.roles.setup),
    confirmation: get(authority.roles.confirmation),
    refinement: get(authority.roles.refinement),
    runtimeEntry: get(authority.runtimeEntry),
    runtimeHTF: get(authority.runtimeHTF),
  };
}

export function directionTimeframeLabels(
  authority: TimeframeAuthority,
): {
  biasTFLabel: string;
  structureTFLabel: string;
  confirmTFLabel: string;
} {
  return {
    biasTFLabel: formatAnalysisTimeframe(authority.direction.bias),
    structureTFLabel: formatAnalysisTimeframe(authority.direction.structure),
    confirmTFLabel: formatAnalysisTimeframe(
      authority.direction.confirmation,
    ),
  };
}

export function zoneTimeframeLabels(
  authority: TimeframeAuthority,
): { top: string; mid: string; low: string } {
  const compact = (timeframe: AnalysisTimeframe): string => {
    if (timeframe === "1d") return "D";
    if (timeframe === "1w") return "W";
    if (timeframe === "1M") return "M";
    return formatAnalysisTimeframe(timeframe);
  };
  return {
    top: compact(authority.zone.top),
    mid: compact(authority.zone.mid),
    low: compact(authority.zone.low),
  };
}

export function timeframeFetchRange(
  timeframe: AnalysisTimeframe,
): string {
  const ranges: Record<AnalysisTimeframe, string> = {
    "1m": "1d",
    "5m": "5d",
    "15m": "5d",
    "30m": "5d",
    "1h": "1mo",
    "4h": "1mo",
    "1d": "1y",
    "1w": "2y",
    "1M": "5y",
  };
  return ranges[timeframe];
}
