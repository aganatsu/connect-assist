/**
 * Shared gate: Max Open Positions
 *
 * Checks whether opening a new position would exceed the configured
 * maximum concurrent open positions limit.
 *
 * Used by:
 *   - bot-scanner (Gate 4)
 *   - backtest-engine (Gate 1)
 */

export interface MaxPositionsGateInput {
  /** Current number of open positions */
  openPositionCount: number;
  /** Maximum allowed concurrent positions from config */
  maxOpenPositions: number;
}

export interface GateResult {
  passed: boolean;
  reason: string;
}

/**
 * Returns passed: true if the current open position count is strictly
 * below the configured maximum (i.e., there's room for one more).
 */
export function checkMaxPositions(input: MaxPositionsGateInput): GateResult {
  const { openPositionCount, maxOpenPositions } = input;

  if (openPositionCount >= maxOpenPositions) {
    return {
      passed: false,
      reason: `Max positions (${maxOpenPositions}) reached`,
    };
  }

  return {
    passed: true,
    reason: `${openPositionCount}/${maxOpenPositions} positions`,
  };
}
