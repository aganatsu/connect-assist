/**
 * Shared gate: Duplicate Direction Check
 *
 * Checks whether a same-direction position already exists on the target
 * symbol. When `allowSameDirectionStacking` is false, blocks the trade.
 * When true, allows it (the max-per-symbol count check handles the limit).
 *
 * Used by:
 *   - bot-scanner (part of Gate 5 — duplicate direction short-circuit)
 *   - backtest-engine (Gate 3)
 *
 * DIVERGENCE NOTE (intentional, documented):
 *   Bot-scanner passes `config.allowSameDirectionStacking` (user-configurable).
 *   Backtest-engine passes `false` (always blocks — the optimizer does not
 *   currently tune this parameter, so the divergence cannot mislead scoring).
 *   If `allowSameDirectionStacking` is ever added to the optimizer's parameter
 *   space, backtest-engine should pass `config.allowSameDirectionStacking`
 *   instead of `false` — a one-line change.
 */

export interface DuplicateDirectionGateInput {
  /** Whether a same-direction position already exists on this symbol */
  sameDirectionExists: boolean;
  /** Whether stacking (multiple same-direction positions) is allowed */
  allowSameDirectionStacking: boolean;
  /** Trade direction (for reason string) */
  direction: "long" | "short";
  /** Symbol name (for reason string) */
  symbol: string;
}

export interface GateResult {
  passed: boolean;
  reason: string;
}

/**
 * Returns passed: true if no same-direction position exists, OR if stacking
 * is explicitly allowed. Returns passed: false if a duplicate exists and
 * stacking is disabled.
 */
export function checkDuplicateDirection(input: DuplicateDirectionGateInput): GateResult {
  const { sameDirectionExists, allowSameDirectionStacking, direction, symbol } = input;

  if (sameDirectionExists && !allowSameDirectionStacking) {
    return {
      passed: false,
      reason: `Already ${direction} on ${symbol}`,
    };
  }

  return {
    passed: true,
    reason: sameDirectionExists ? `${direction} on ${symbol} (stacking allowed)` : "No duplicate direction",
  };
}
