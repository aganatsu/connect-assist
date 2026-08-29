import { toNYTime } from "./sessions.ts";
import { SPECS } from "./smcAnalysis.ts";

export type GamePlanMarketScopeReason =
  | "all_enabled_markets_open"
  | "configured_day_crypto_only"
  | "weekend_crypto_only";

export interface GamePlanMarketScope {
  eligibleSymbols: string[];
  excludedSymbols: string[];
  reason: GamePlanMarketScopeReason;
  nonCryptoMarketsClosed: boolean;
  nonCryptoTradingDayEnabled: boolean;
  effectiveTradingDay: number;
}

/**
 * Mirrors the scanner's weekend execution boundary:
 * non-crypto markets are treated as closed from Friday 17:00 New York time
 * through Sunday 17:00, while crypto remains available continuously.
 */
export function areNonCryptoMarketsClosed(now: Date): boolean {
  const ny = toNYTime(now);
  return ny.nyDay === 6 ||
    (ny.nyDay === 0 && ny.t < 17) ||
    (ny.nyDay === 5 && ny.t >= 17);
}

/**
 * Reports whether an instrument's market is available for live market-data
 * work. Crypto is continuous; every other supported asset follows the shared
 * Friday 17:00 through Sunday 17:00 New York boundary.
 *
 * Configured trading days are intentionally not part of this function. They
 * control new opportunity discovery, while open positions still need risk
 * management on an otherwise-open market day.
 */
export function isInstrumentMarketOpen(
  symbol: string,
  now = new Date(),
): boolean {
  return SPECS[symbol]?.type === "crypto" ||
    !areNonCryptoMarketsClosed(now);
}

/**
 * Selects only instruments that are expected to produce an authoritative
 * Gameplan in the current market window. Closed instruments are excluded from
 * completeness checks so they cannot block an open crypto market.
 */
export function resolveGamePlanMarketScope(
  enabledSymbols: string[],
  now = new Date(),
  enabledDays?: number[],
): GamePlanMarketScope {
  const ny = toNYTime(now);
  const nonCryptoMarketsClosed = areNonCryptoMarketsClosed(now);
  // The FX trading week opens Sunday at 17:00 New York time. Runtime day
  // gating has always treated that window as Monday; keep the market scope in
  // the same contract so discovery and Gameplan cannot disagree.
  const effectiveTradingDay = ny.nyDay === 0 && ny.t >= 17 ? 1 : ny.nyDay;
  const nonCryptoTradingDayEnabled = enabledDays === undefined ||
    enabledDays.includes(effectiveTradingDay);

  if (!nonCryptoMarketsClosed && nonCryptoTradingDayEnabled) {
    return {
      eligibleSymbols: [...enabledSymbols],
      excludedSymbols: [],
      reason: "all_enabled_markets_open",
      nonCryptoMarketsClosed: false,
      nonCryptoTradingDayEnabled: true,
      effectiveTradingDay,
    };
  }

  const eligibleSymbols = enabledSymbols.filter((symbol) =>
    SPECS[symbol]?.type === "crypto"
  );
  const eligibleSet = new Set(eligibleSymbols);
  return {
    eligibleSymbols,
    excludedSymbols: enabledSymbols.filter((symbol) =>
      !eligibleSet.has(symbol)
    ),
    reason: nonCryptoMarketsClosed
      ? "weekend_crypto_only"
      : "configured_day_crypto_only",
    nonCryptoMarketsClosed,
    nonCryptoTradingDayEnabled,
    effectiveTradingDay,
  };
}

export function gamePlanSymbolsMatchScope(
  planSymbols: string[],
  scope: GamePlanMarketScope,
): boolean {
  if (planSymbols.length !== scope.eligibleSymbols.length) return false;
  const actual = new Set(planSymbols);
  return scope.eligibleSymbols.every((symbol) => actual.has(symbol));
}
