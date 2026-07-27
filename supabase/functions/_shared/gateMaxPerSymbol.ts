/**
 * Shared gate: Max Positions Per Symbol
 *
 * Checks whether opening a new position on a given symbol would exceed
 * the configured per-symbol position limit.
 *
 * Used by:
 *   - bot-scanner (part of Gate 5 — combined with duplicate direction check)
 *   - backtest-engine (Gate 2)
 *
 * NOTE: This gate handles ONLY the count check. The same-direction
 * duplicate check is a separate gate with divergent behavior between
 * engines (bot-scanner has allowSameDirectionStacking toggle; backtest
 * always blocks). That will be extracted separately.
 */

export interface MaxPerSymbolGateInput {
  /** Number of currently open positions on this specific symbol */
  symbolPositionCount: number;
  /** Maximum allowed concurrent positions per symbol from config */
  maxPerSymbol: number;
  /** Symbol name (for reason string only) */
  symbol: string;
}

export interface GateResult {
  passed: boolean;
  reason: string;
}

/**
 * Returns passed: true if the current symbol position count is strictly
 * below the configured per-symbol maximum (i.e., there's room for one more).
 */
export function checkMaxPerSymbol(input: MaxPerSymbolGateInput): GateResult {
  const { symbolPositionCount, maxPerSymbol, symbol } = input;

  if (symbolPositionCount >= maxPerSymbol) {
    return {
      passed: false,
      reason: `Max ${maxPerSymbol} positions for ${symbol} reached`,
    };
  }

  return {
    passed: true,
    reason: `${symbolPositionCount}/${maxPerSymbol} for ${symbol}`,
  };
}
