/**
 * Shared gate: Max Drawdown (Circuit Breaker)
 *
 * Checks whether the current drawdown from peak balance exceeds the
 * configured maximum drawdown percentage. If so, blocks new trades.
 *
 * Used by:
 *   - bot-scanner (Gate 8) — with prop firm delegation bypass
 *   - backtest-engine (Gate 5)
 *
 * NOTE: Bot-scanner has an additional prop-firm delegation check that
 * skips this gate entirely when a prop firm gate is active (stricter
 * thresholds are enforced by the prop firm gate). That bypass logic
 * remains inline in bot-scanner — this shared function handles only
 * the core drawdown calculation.
 *
 * Comparison semantics:
 *   - Bot-scanner uses `>=` (at-or-above limit fails)
 *   - Backtest-engine uses `<` (strictly below limit passes)
 *   These are equivalent: `drawdown >= max` fails ↔ `drawdown < max` passes.
 *   The shared function uses `>=` for the fail condition.
 */

export interface MaxDrawdownGateInput {
  /** Current account balance */
  balance: number;
  /** Peak (high-water mark) balance */
  peakBalance: number;
  /** Maximum allowed drawdown percentage from config */
  maxDrawdown: number;
}

export interface GateResult {
  passed: boolean;
  reason: string;
}

/**
 * Returns passed: true if the current drawdown percentage is strictly
 * below the configured maximum. Returns passed: false if at or above.
 *
 * Edge cases:
 *   - peakBalance <= 0 or maxDrawdown <= 0: returns pass (no valid check possible)
 */
export function checkMaxDrawdown(input: MaxDrawdownGateInput): GateResult {
  const { balance, peakBalance, maxDrawdown } = input;

  // Guard: if no valid peak or drawdown limit, pass (can't compute)
  if (peakBalance <= 0 || maxDrawdown <= 0) {
    return { passed: true, reason: "Drawdown within limits" };
  }

  const drawdownPercent = ((peakBalance - balance) / peakBalance) * 100;

  if (drawdownPercent >= maxDrawdown) {
    return {
      passed: false,
      reason: `Drawdown: ${drawdownPercent.toFixed(1)}% >= ${maxDrawdown}% limit`,
    };
  }

  return {
    passed: true,
    reason: `Drawdown: ${drawdownPercent.toFixed(1)}%`,
  };
}
