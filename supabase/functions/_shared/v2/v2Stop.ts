// §6.2, §6.3b–c — stop placement and stop-distance checks.
import { type Pair, SL_BUFFER_PTS, SPREAD_PTS } from "./spec.ts";
import type { Dir } from "./v2Direction.ts";

/** §6.2 LONG: min(POI.low, reaction low) − 1 pip; SHORT: max(POI.high, reaction high) + 1 pip. */
export function stopLoss(dir: Dir, poi: { low: number; high: number }, reactionExtreme: number): number {
  return dir === "LONG"
    ? Math.min(poi.low, reactionExtreme) - SL_BUFFER_PTS
    : Math.max(poi.high, reactionExtreme) + SL_BUFFER_PTS;
}

/** §6.3b |entry − SL| > 1.5 × ATR14 ⇔ 28·dist > 3·sumTR. */
export function stopTooWide(dist: number, atrSum: number): boolean {
  return 28 * dist > 3 * atrSum;
}

/** §6.3c |entry − SL| < 3 × spread(pair). */
export function stopTooTight(pair: Pair, dist: number): boolean {
  return dist < 3 * SPREAD_PTS[pair];
}
