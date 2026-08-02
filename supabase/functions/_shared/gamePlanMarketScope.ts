import { toNYTime } from "./sessions.ts";
import { SPECS } from "./smcAnalysis.ts";

export type GamePlanMarketScopeReason =
  | "all_enabled_markets_open"
  | "weekend_crypto_only";

export interface GamePlanMarketScope {
  eligibleSymbols: string[];
  excludedSymbols: string[];
  reason: GamePlanMarketScopeReason;
  nonCryptoMarketsClosed: boolean;
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
 * Selects only instruments that are expected to produce an authoritative
 * Gameplan in the current market window. Closed instruments are excluded from
 * completeness checks so they cannot block an open crypto market.
 */
export function resolveGamePlanMarketScope(
  enabledSymbols: string[],
  now = new Date(),
): GamePlanMarketScope {
  const nonCryptoMarketsClosed = areNonCryptoMarketsClosed(now);
  if (!nonCryptoMarketsClosed) {
    return {
      eligibleSymbols: [...enabledSymbols],
      excludedSymbols: [],
      reason: "all_enabled_markets_open",
      nonCryptoMarketsClosed: false,
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
    reason: "weekend_crypto_only",
    nonCryptoMarketsClosed: true,
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
