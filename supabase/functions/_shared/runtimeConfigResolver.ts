/**
 * Canonical runtime-configuration resolution.
 *
 * Every execution surface must resolve configuration in the same order:
 *   stored/request config -> canonical field mapping -> trading-style profile
 *
 * Surface-specific execution constraints (for example disabling historical
 * news in a backtest) are applied only after this resolver returns.
 */
import { mapNestedToFlat, type RuntimeConfig } from "./configMapper.ts";
import {
  applyTradingStyleProfile,
  type TradingStyleMode,
  type TradingStyleResolution,
} from "./tradingStyleConfig.ts";

export interface EffectiveRuntimeConfigResolution
  extends TradingStyleResolution {
  mappedConfig: RuntimeConfig;
}

export function resolveEffectiveRuntimeConfig(
  rawConfig: unknown,
  requestedStyle?: unknown,
): EffectiveRuntimeConfigResolution {
  const mappedConfig = mapNestedToFlat(rawConfig);
  const resolution = applyTradingStyleProfile(mappedConfig, requestedStyle);

  return {
    ...resolution,
    mappedConfig,
  };
}

export function resolveEffectiveTradingStyle(
  rawConfig: unknown,
  requestedStyle?: unknown,
): TradingStyleMode {
  return resolveEffectiveRuntimeConfig(rawConfig, requestedStyle).style;
}
