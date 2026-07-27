/**
 * Shared gate: Daily Loss Limit
 *
 * Checks whether the current day's loss percentage exceeds the configured
 * maximum daily loss threshold. If so, blocks new trades.
 *
 * Used by:
 *   - bot-scanner (Gate 7) — with prop firm delegation bypass
 *   - backtest-engine (Gate 6)
 *
 * IMPORTANT: The two engines compute dailyLossPercent differently:
 *   - Bot-scanner: balance decline from a stored start-of-day baseline
 *     (account.daily_pnl_base vs current balance)
 *   - Backtest-engine: sum of realized trade P&L for the current candle-day,
 *     expressed as a percentage of current balance
 *
 * This shared function accepts the pre-computed dailyLossPercent as input,
 * keeping the calculation method engine-specific while unifying the
 * comparison logic and reason-string format.
 *
 * Comparison semantics:
 *   - Bot-scanner uses `>=` (at-or-above limit fails)
 *   - Backtest-engine uses `<` (strictly below limit passes)
 *   These are equivalent: `loss >= max` fails ↔ `loss < max` passes.
 *   The shared function uses `>=` for the fail condition.
 *
 * NOTE: Bot-scanner has an additional prop-firm delegation check that
 * skips this gate entirely when a prop firm gate is active. That bypass
 * logic remains inline in bot-scanner.
 */

export interface DailyLossLimitGateInput {
  /** Pre-computed daily loss as a positive percentage (0 = no loss, 5 = 5% loss) */
  dailyLossPercent: number;
  /** Maximum allowed daily loss percentage from config */
  maxDailyLoss: number;
}

export interface GateResult {
  passed: boolean;
  reason: string;
}

/**
 * Returns passed: true if the current daily loss percentage is strictly
 * below the configured maximum. Returns passed: false if at or above.
 */
export function checkDailyLossLimit(input: DailyLossLimitGateInput): GateResult {
  const { dailyLossPercent, maxDailyLoss } = input;

  if (dailyLossPercent >= maxDailyLoss) {
    return {
      passed: false,
      reason: `Daily loss: ${dailyLossPercent.toFixed(1)}% >= ${maxDailyLoss}% limit`,
    };
  }

  return {
    passed: true,
    reason: `Daily loss: ${dailyLossPercent.toFixed(1)}%`,
  };
}
