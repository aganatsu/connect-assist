/**
 * STEP 17-B — the `MIN_TP_PIPS` gate (`skipped_tp_too_small`) is LOG-ONLY in
 * the locked dry-run experiment and unchanged everywhere else.
 *
 * The gate measures the distance from the current price to the LEGACY
 * market-entry target (computed before any Route 2 geometry), not the Route 2
 * order's own target, which from its entry is always ≥ 22 / 27.5 pips. It
 * refused 18 distinct setups in the first day after Step 14 (13 never placed).
 * Spread cost is already enforced by the order-geometry R:R gate, which is not
 * touched here. To measure what the gate costs:
 *   dry-run active (entries locked + simplification.dryRunWhenLocked) → LOG:
 *     not blocked; the setup continues through every later Route 2 gate and is
 *     tagged (would-block, the measured TP pips, the minimum, the basis);
 *   otherwise → HARD: blocks exactly as before.
 * The gate is not removed; the decision whether to keep it is made before
 * unlock from the tagged cohort's outcomes.
 */

export const TP_SMALL_GATE_ID = "tp_too_small";

export interface TpSmallRecord {
  gateId: typeof TP_SMALL_GATE_ID;
  wouldBlock: true;
  mode: "log";
  symbol: string;
  tpPips: number;
  minTpPips: number;
  basis: "legacy_market_target_from_last_price";
  reason: string;
}

export function evaluateTpSmallGate(i: { symbol: string; tpPips: number; minTpPips: number; dryRunActive: boolean }):
  { wouldBlock: boolean; mode: "hard" | "log"; block: boolean; record: TpSmallRecord | null } {
  const wouldBlock = i.tpPips < i.minTpPips;
  const mode = i.dryRunActive ? "log" : "hard";
  const reason = `TP ${i.tpPips.toFixed(1)}p < min ${i.minTpPips}p`;
  return {
    wouldBlock,
    mode,
    block: wouldBlock && mode === "hard",
    record: wouldBlock && mode === "log"
      ? { gateId: TP_SMALL_GATE_ID, wouldBlock: true, mode: "log", symbol: i.symbol, tpPips: i.tpPips, minTpPips: i.minTpPips,
          basis: "legacy_market_target_from_last_price", reason }
      : null,
  };
}
