/**
 * Shared gate: Max Consecutive Losses
 *
 * Checks whether the current streak of consecutive losing trades meets or
 * exceeds the configured maximum. Optionally supports an auto-reset cooldown
 * that allows trading to resume after a specified number of hours since the
 * last loss.
 *
 * Used by:
 *   - bot-scanner (Gate 14) — with 4-hour auto-reset cooldown
 *   - backtest-engine (Gate 9) — without auto-reset (simple threshold)
 *
 * DIVERGENCE (intentional, typed in interface):
 *   Bot-scanner uses a 4-hour auto-reset: once max consecutive losses are hit,
 *   trading is blocked until 4 hours have elapsed since the last losing trade.
 *   Backtest-engine does NOT implement auto-reset — once the streak hits the
 *   limit, the gate blocks until a winning trade breaks the streak.
 *
 *   This divergence is made explicit via the optional `autoResetHours` and
 *   `hoursSinceLastLoss` parameters. Backtest-engine omits both (no reset).
 *   Bot-scanner passes both when the streak is at/above the limit.
 *
 * NOTE: The consecutive loss count is pre-computed by each engine from its
 * own data source (bot-scanner queries Supabase; backtest iterates recentTrades).
 * This function only handles the comparison logic.
 *
 * REASON STRING FORMAT:
 *   Must contain lowercase "consecutive losses" for gatePerformanceEngine.ts
 *   pattern matching (uses `reason.includes("consecutive losses")`).
 *   Must also contain a colon for backtest-engine's `reason.split(":")[0]`
 *   diagnostics aggregation (yields label before colon).
 *   Format: "N consecutive losses: ..." satisfies both constraints.
 */

export interface ConsecutiveLossesGateInput {
  /** Number of consecutive losses counted from most recent trade backward */
  consecutiveLosses: number;
  /** Maximum allowed consecutive losses from config (0 = disabled) */
  maxConsecutiveLosses: number;
  /**
   * Optional: hours since the last losing trade (for auto-reset).
   * Only relevant when consecutiveLosses >= maxConsecutiveLosses.
   * Bot-scanner passes this; backtest-engine omits it.
   */
  hoursSinceLastLoss?: number;
  /**
   * Optional: number of hours after which the consecutive-loss block resets.
   * Bot-scanner passes 4; backtest-engine omits (no reset behavior).
   */
  autoResetHours?: number;
}

export interface GateResult {
  passed: boolean;
  reason: string;
}

export function checkConsecutiveLosses(input: ConsecutiveLossesGateInput): GateResult {
  const { consecutiveLosses, maxConsecutiveLosses, hoursSinceLastLoss, autoResetHours } = input;

  // If the streak hasn't reached the limit, pass
  if (consecutiveLosses < maxConsecutiveLosses) {
    return {
      passed: true,
      reason: `${consecutiveLosses} consecutive losses: ${consecutiveLosses}/${maxConsecutiveLosses}`,
    };
  }

  // Streak is at or above limit — check auto-reset if configured
  if (autoResetHours && autoResetHours > 0 && hoursSinceLastLoss !== undefined) {
    if (hoursSinceLastLoss >= autoResetHours) {
      return {
        passed: true,
        reason: `${consecutiveLosses} consecutive losses: auto-reset after ${autoResetHours}h cooldown (${Math.floor(hoursSinceLastLoss)}h elapsed)`,
      };
    }
    // Still within cooldown period
    const remainingMin = Math.ceil((autoResetHours - hoursSinceLastLoss) * 60);
    return {
      passed: false,
      reason: `${consecutiveLosses} consecutive losses: >= ${maxConsecutiveLosses} limit — auto-resets in ${remainingMin}min`,
    };
  }

  // No auto-reset: simple fail
  return {
    passed: false,
    reason: `${consecutiveLosses} consecutive losses: >= ${maxConsecutiveLosses} limit`,
  };
}
