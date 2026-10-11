// §6.4–6.5 — fill-time sizing under the research execution profile. Never feeds back into R.
import { COST_PTS, LOT_UNITS, MAX_LOTS, type Pair, PRICE_SCALE, QUOTE_TO_USD, RISK_BUDGET_USD } from "./spec.ts";

export interface Sizing { ok: boolean; lots: number; lossPerLotAtSL: number }

/** lossPerLotAtSL = (|entry − SL| + cost) × 100,000 × quoteToUSD; lots = min(20, floor(500 / loss × 100) / 100). */
export function size(pair: Pair, entry: number, sl: number): Sizing {
  const pricePerLot = (Math.abs(entry - sl) + COST_PTS[pair]) / PRICE_SCALE[pair];
  const lossPerLotAtSL = pricePerLot * LOT_UNITS * QUOTE_TO_USD[pair];
  // 1e-9 guards floor() against binary rounding of an exact hundredth; it never moves a value across a whole hundredth.
  const lots = Math.min(MAX_LOTS, Math.floor((RISK_BUDGET_USD / lossPerLotAtSL) * 100 + 1e-9) / 100);
  return { ok: lots >= 0.01, lots, lossPerLotAtSL };
}

/** Descriptive dollar P&L: lots × 100,000 × quoteToUSD × (signed exit move − cost). */
export function dollarPnl(pair: Pair, lots: number, signedMovePts: number): number {
  return lots * LOT_UNITS * QUOTE_TO_USD[pair] * (signedMovePts - COST_PTS[pair]) / PRICE_SCALE[pair];
}
