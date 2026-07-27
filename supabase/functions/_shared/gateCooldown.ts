/**
 * Shared gate: Cooldown
 *
 * Checks whether enough time has elapsed since the last trade on the same
 * symbol before allowing a new entry.
 *
 * Used by:
 *   - bot-scanner (Gate 13) — elapsed computed from wall-clock (Date.now() vs DB closed_at)
 *   - backtest-engine (Gate 8) — elapsed computed from candle time vs last exit time
 *
 * Both engines pre-compute `elapsedMinutes` from their own time source and
 * pass it to this function. The shared function only handles the comparison.
 *
 * Reason string format uses colon (`Cooldown: ...`) to preserve compatibility
 * with backtest-engine's `reason.split(":")[0]` diagnostics aggregation.
 *
 * gatePerformanceEngine.ts pattern: matches on "Cooldown" substring — all
 * reason strings from this function start with "Cooldown" so they match.
 */

export interface CooldownGateInput {
  /** Minutes elapsed since the last trade on this symbol closed */
  elapsedMinutes: number | null;
  /** Minimum cooldown minutes required from config (0 = disabled) */
  cooldownMinutes: number;
  /** Optional: symbol name for more descriptive reason strings */
  symbol?: string;
}

export interface GateResult {
  passed: boolean;
  reason: string;
}

export function checkCooldown(input: CooldownGateInput): GateResult {
  const { elapsedMinutes, cooldownMinutes, symbol } = input;

  // No previous trade on this symbol — cooldown doesn't apply
  if (elapsedMinutes === null) {
    return {
      passed: true,
      reason: "Cooldown: no recent trades — OK",
    };
  }

  // Cooldown elapsed
  if (elapsedMinutes >= cooldownMinutes) {
    return {
      passed: true,
      reason: `Cooldown: passed (${Math.floor(elapsedMinutes)}min since last)`,
    };
  }

  // Still in cooldown
  const remaining = Math.ceil(cooldownMinutes - elapsedMinutes);
  const symbolSuffix = symbol ? ` for ${symbol}` : "";
  return {
    passed: false,
    reason: `Cooldown: ${remaining}min remaining${symbolSuffix}`,
  };
}
