// §5.3, §6.2, §6.3b–c — V2.1 (SA1) CHoCH-origin stop and stop-distance checks.
import { type Pair, SL_BUFFER_PTS, SPREAD_PTS } from "./spec.ts";
import type { Series } from "./barStore.ts";
import type { Dir } from "./v2Direction.ts";

/** §5.3 CHoCH origin: LONG lowest low / SHORT highest high of the 5m bars in (ps, k]; null if not computable (empty or a MISSING bar). */
export function chochOrigin(dir: Dir, s5: Series, ps: number, k: number): number | null {
  if (k <= ps) return null;
  let o = dir === "LONG" ? Infinity : -Infinity;
  for (let i = ps + 1; i <= k; i++) {
    const b = s5.bars[i];
    if (!b) return null;
    o = dir === "LONG" ? Math.min(o, b.l) : Math.max(o, b.h);
  }
  return o;
}

/** §6.2 LONG SL = CHoCH origin − 1 pip; SHORT SL = CHoCH origin + 1 pip (no fallback to the POI far edge). */
export function stopLoss(dir: Dir, origin: number): number {
  return dir === "LONG" ? origin - SL_BUFFER_PTS : origin + SL_BUFFER_PTS;
}

/** §6.3b |entry − SL| > 1.5 × ATR14 ⇔ 28·dist > 3·sumTR. */
export function stopTooWide(dist: number, atrSum: number): boolean {
  return 28 * dist > 3 * atrSum;
}

/** §6.3c |entry − SL| < 3 × spread(pair). */
export function stopTooTight(pair: Pair, dist: number): boolean {
  return dist < 3 * SPREAD_PTS[pair];
}
