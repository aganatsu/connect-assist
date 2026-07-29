/**
 * Canonical trading-style execution profiles.
 *
 * Both the live scanner and backtest engine must pass their mapped runtime
 * config through this module so the selected style has identical semantics.
 */
import { RUNTIME_DEFAULTS, type RuntimeConfig } from "./configMapper.ts";

export type TradingStyleMode = "scalper" | "day_trader" | "swing_trader";

export const TRADING_STYLE_PROFILES: Record<
  TradingStyleMode,
  Partial<RuntimeConfig>
> = {
  scalper: {
    scanIntervalMinutes: 5,
    gamePlanValidityMinutes: 120,
    entryTimeframe: "5m",
    htfTimeframe: "1h",
    tpRatio: 2.0,
    slBufferPips: 1,
    minConfluence: 40,
    riskPerTrade: 0.5,
    impulseSlCapMultiplier: 1.5,
    trailingStopEnabled: false,
    trailingStopPips: 8,
    trailingStopActivation: "after_1r",
    breakEvenEnabled: false,
    breakEvenPips: 8,
    partialTPEnabled: false,
    maxHoldEnabled: true,
    maxHoldHours: 4,
  },
  day_trader: {
    scanIntervalMinutes: 15,
    gamePlanValidityMinutes: 240,
    entryTimeframe: "15min",
    htfTimeframe: "1day",
    tpRatio: 2.0,
    slBufferPips: 2,
    minConfluence: 55,
    trailingStopEnabled: true,
    trailingStopPips: 15,
    trailingStopActivation: "after_1.5r",
    breakEvenEnabled: true,
    breakEvenPips: 20,
    partialTPEnabled: true,
    partialTPPercent: 50,
    partialTPLevel: 1.0,
    maxHoldEnabled: true,
    maxHoldHours: 24,
  },
  swing_trader: {
    scanIntervalMinutes: 60,
    gamePlanValidityMinutes: 1440,
    entryTimeframe: "1h",
    htfTimeframe: "1w",
    tpRatio: 3.0,
    slBufferPips: 5,
    minConfluence: 40,
    riskPerTrade: 1.5,
    impulseSlCapMultiplier: 6,
    trailingStopEnabled: false,
    trailingStopPips: 25,
    trailingStopActivation: "after_2r",
    breakEvenEnabled: false,
    breakEvenPips: 40,
    partialTPEnabled: false,
    partialTPPercent: 33,
    partialTPLevel: 1.0,
    maxHoldEnabled: false,
    maxHoldHours: 0,
  },
};

// Preserve the scanner's historical inheritance semantics. In particular,
// partial TP was treated as user-protected unless its mapped value was true.
const STYLE_INHERITANCE_BASELINE: RuntimeConfig = {
  ...RUNTIME_DEFAULTS,
  partialTPEnabled: true,
};

const USER_PROTECTED_STYLE_FIELDS = new Set<keyof RuntimeConfig>([
  "minConfluence",
  "tpRatio",
  "trailingStopEnabled",
  "trailingStopPips",
  "trailingStopActivation",
  "breakEvenEnabled",
  "breakEvenPips",
  "breakEvenOffsetPips",
  "partialTPEnabled",
  "partialTPPercent",
  "partialTPLevel",
  "maxHoldHours",
]);

export interface TradingStyleResolution {
  config: RuntimeConfig;
  style: TradingStyleMode;
  applied: string[];
  preserved: string[];
}

function isTradingStyleMode(value: unknown): value is TradingStyleMode {
  return value === "scalper" ||
    value === "day_trader" ||
    value === "swing_trader";
}

export function resolveTradingStyle(
  requestedStyle: unknown,
  config?: Pick<RuntimeConfig, "tradingStyle">,
): TradingStyleMode {
  if (isTradingStyleMode(requestedStyle)) return requestedStyle;
  if (isTradingStyleMode(config?.tradingStyle?.mode)) {
    return config.tradingStyle.mode;
  }
  return "day_trader";
}

export function applyTradingStyleProfile(
  config: RuntimeConfig,
  requestedStyle?: unknown,
): TradingStyleResolution {
  const style = resolveTradingStyle(requestedStyle, config);
  const next: RuntimeConfig = {
    ...config,
    tradingStyle: {
      ...config.tradingStyle,
      mode: style,
    },
  };
  const applied: string[] = [];
  const preserved: string[] = [];

  for (const [rawKey, value] of Object.entries(TRADING_STYLE_PROFILES[style])) {
    const key = rawKey as keyof RuntimeConfig;
    if (
      USER_PROTECTED_STYLE_FIELDS.has(key) &&
      next[key] !== STYLE_INHERITANCE_BASELINE[key]
    ) {
      preserved.push(
        `${key}=${String(next[key])} (style wanted ${String(value)})`,
      );
      continue;
    }

    (next as Record<string, unknown>)[key] = value;
    applied.push(`${key}=${String(value)}`);
  }

  return { config: next, style, applied, preserved };
}
