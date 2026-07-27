/**
 * gateATRVolatility.ts — Shared ATR Volatility Filter gate
 *
 * Blocks trades when the current ATR (in pips) falls outside the configured
 * min/max range. When min or max is 0, that bound is disabled.
 *
 * Used by:
 *   - bot-scanner (Gate 18): passes pre-computed atrPips from analysis
 *   - backtest-engine (Gate 9b): passes atrPips from calculateATR(dailyCandles, 14)
 *
 * Both engines compute atrPips externally and pass it in — the shared function
 * only handles the threshold comparison and reason-string formatting.
 *
 * Reason string format: "ATR filter: ..." — satisfies both:
 *   - gatePerformanceEngine.ts pattern: includes("ATR ") ✅
 *   - backtest diagnostics: split(":")[0] → "ATR filter" ✅
 */

export interface ATRVolatilityInput {
  /** Current ATR value in pips */
  atrPips: number;
  /** Minimum ATR threshold in pips (0 = disabled) */
  minPips: number;
  /** Maximum ATR threshold in pips (0 = disabled) */
  maxPips: number;
}

export interface GateResult {
  passed: boolean;
  reason: string;
}

export function checkATRVolatility(input: ATRVolatilityInput): GateResult {
  const { atrPips, minPips, maxPips } = input;
  const atrStr = atrPips.toFixed(1);

  // Check minimum bound (only when enabled)
  if (minPips > 0 && atrPips < minPips) {
    return {
      passed: false,
      reason: `ATR filter: ${atrStr} pips below minimum ${minPips}`,
    };
  }

  // Check maximum bound (only when enabled)
  if (maxPips > 0 && atrPips > maxPips) {
    return {
      passed: false,
      reason: `ATR filter: ${atrStr} pips above maximum ${maxPips}`,
    };
  }

  // Both bounds pass (or are disabled)
  return {
    passed: true,
    reason: `ATR filter: ${atrStr} pips within range`,
  };
}
