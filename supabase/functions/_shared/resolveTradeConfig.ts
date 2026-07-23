/**
 * resolveTradeConfig.ts
 * 
 * Single source of truth for resolving per-position effective exit management config.
 * Merges global bot_config exit settings with per-trade overrides.
 * 
 * Used by:
 *   - scannerManagement.ts (to determine what settings apply during trade management)
 *   - paper-trading/index.ts (to return effective config to the frontend)
 * 
 * The resolved config is what the scanner WILL use on the next cycle.
 * The raw overrides tell the UI which fields the user has explicitly customized.
 */

export interface ResolvedTradeConfig {
  breakEvenEnabled: boolean;
  breakEvenPips: number;
  breakEvenOffsetPips: number;
  trailingStopEnabled: boolean;
  trailingStopPips: number;
  trailingStopActivation: string;
  partialTPEnabled: boolean;
  partialTPPercent: number;
  partialTPLevel: number;
  maxHoldEnabled: boolean;
  maxHoldHours: number;
}

export interface TradeOverrides {
  breakEvenEnabled?: boolean;
  breakEvenPips?: number;
  breakEvenOffsetPips?: number;
  trailingStopEnabled?: boolean;
  trailingStopPips?: number;
  trailingStopActivation?: string;
  partialTPEnabled?: boolean;
  partialTPPercent?: number;
  partialTPLevel?: number;
  maxHoldEnabled?: boolean;
  maxHoldHours?: number;
}

/**
 * Extract the global exit management defaults from a bot_config's config_json.
 * These are the values that apply when no per-trade override exists.
 */
export function extractGlobalExitConfig(configJson: any): ResolvedTradeConfig {
  const exit = configJson?.exit || {};
  return {
    breakEvenEnabled: exit.breakEvenEnabled ?? configJson?.breakEvenEnabled ?? true,
    breakEvenPips: exit.breakEvenPips ?? configJson?.breakEvenPips ?? 20,
    breakEvenOffsetPips: Math.max(0, Number(exit.breakEvenOffsetPips ?? configJson?.breakEvenOffsetPips ?? 3)),
    trailingStopEnabled: exit.trailingStopEnabled ?? configJson?.trailingStopEnabled ?? false,
    trailingStopPips: exit.trailingStopPips ?? configJson?.trailingStopPips ?? 15,
    trailingStopActivation: exit.trailingStopActivation ?? configJson?.trailingStopActivation ?? "after_1r",
    partialTPEnabled: exit.partialTPEnabled ?? configJson?.partialTPEnabled ?? false,
    partialTPPercent: exit.partialTPPercent ?? configJson?.partialTPPercent ?? 50,
    partialTPLevel: exit.partialTPLevel ?? configJson?.partialTPLevel ?? 1.0,
    maxHoldEnabled: exit.maxHoldEnabled ?? configJson?.maxHoldEnabled ?? false,
    maxHoldHours: exit.maxHoldHours ?? configJson?.maxHoldHours ?? 0,
  };
}

/**
 * Parse raw trade_overrides from a position row.
 * Returns null if no overrides exist.
 */
export function parseTradeOverrides(raw: any): TradeOverrides | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length === 0) return null;
    return parsed as TradeOverrides;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective config for a position by merging global defaults with per-trade overrides.
 * This is exactly what the scanner will use on the next cycle.
 */
export function resolveTradeConfig(
  globalConfig: ResolvedTradeConfig,
  overrides: TradeOverrides | null
): ResolvedTradeConfig {
  if (!overrides) return { ...globalConfig };

  return {
    breakEvenEnabled: overrides.breakEvenEnabled ?? globalConfig.breakEvenEnabled,
    breakEvenPips: overrides.breakEvenPips ?? globalConfig.breakEvenPips,
    breakEvenOffsetPips: overrides.breakEvenOffsetPips !== undefined
      ? Math.max(0, Number(overrides.breakEvenOffsetPips))
      : globalConfig.breakEvenOffsetPips,
    trailingStopEnabled: overrides.trailingStopEnabled ?? globalConfig.trailingStopEnabled,
    trailingStopPips: overrides.trailingStopPips ?? globalConfig.trailingStopPips,
    trailingStopActivation: overrides.trailingStopActivation ?? globalConfig.trailingStopActivation,
    partialTPEnabled: overrides.partialTPEnabled ?? globalConfig.partialTPEnabled,
    partialTPPercent: overrides.partialTPPercent ?? globalConfig.partialTPPercent,
    partialTPLevel: overrides.partialTPLevel ?? globalConfig.partialTPLevel,
    maxHoldEnabled: overrides.maxHoldEnabled ?? globalConfig.maxHoldEnabled,
    maxHoldHours: overrides.maxHoldHours ?? globalConfig.maxHoldHours,
  };
}
