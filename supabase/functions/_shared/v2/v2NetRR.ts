// §0.10 — R, net R and R:R under the midpoint model; cost(pair) charged exactly once.
import { COST_PTS, type Pair } from "./spec.ts";
import type { Dir } from "./v2Direction.ts";

/** §0.10 R:R ≥ 1.50 ⇔ 2·(|TP − entry| − cost) ≥ 3·|entry − SL| (exact on integer points). */
export function rrAtLeastMin(pair: Pair, entry: number, sl: number, tp: number): boolean {
  return 2 * (Math.abs(tp - entry) - COST_PTS[pair]) >= 3 * Math.abs(entry - sl);
}

export function rr(pair: Pair, entry: number, sl: number, tp: number): number {
  return (Math.abs(tp - entry) - COST_PTS[pair]) / Math.abs(entry - sl);
}

export function grossR(dir: Dir, entry: number, sl: number, exit: number): number {
  return dir === "LONG" ? (exit - entry) / (entry - sl) : (entry - exit) / (sl - entry);
}

export function netR(pair: Pair, dir: Dir, entry: number, sl: number, exit: number): number {
  return grossR(dir, entry, sl, exit) - COST_PTS[pair] / Math.abs(entry - sl);
}
