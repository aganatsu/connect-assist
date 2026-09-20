/**
 * Two further major-move onset definitions. RESEARCH ONLY.
 *
 * SCOPE IS NARROWED BY EVIDENCE. On Ezzy's own demonstrations mode A fires 0 of
 * 4 and every exact match comes through the plain step-back, which is also what
 * the teaching literally says. So the anchor is FIXED here — last opposite
 * candle before the move — and the only remaining variable is where the move
 * begins. No anchor branching appears in this file.
 *
 * The two definitions below encode the readings of "major move" that the
 * existing ones do not:
 *
 *   PERMANENT_BASE_EXIT     leaves the base and never comes back to it
 *   RUN_NEVER_REVISITS      leaves the origin's zone and never returns to it
 *
 * Both are parameter-free. Both are deliberately about PERMANENCE rather than
 * magnitude: FINAL_BASE_EXIT already tests "left the base", and the thing it
 * cannot express is "left it for good". Magnitude is what production already
 * ranks on, and ranking on magnitude is what disagrees with the demonstrations.
 *
 * Nothing here is wired to the detector.
 */

import { lastOppositeBefore, type OnsetContext } from "./ipoDisplacementOnset.ts";
import { ipoGeometry } from "./ipoZones.ts";
import type { Candle } from "./smcAnalysis.ts";

const overlaps = (a: Candle, b: Candle) => a.low <= b.high && a.high >= b.low;

/**
 * First bar that closes out of the last base AND never re-enters it before the
 * break.
 *
 * FINAL_BASE_EXIT takes the first close outside the base, which a single probe
 * bar satisfies even when price falls straight back in. Requiring the exit to
 * hold distinguishes the move that actually left from the one that merely
 * poked out.
 */
export function permanentBaseExit(ctx: OnsetContext): number | null {
  const { candles, swingIdx, breakIdx, direction } = ctx;
  const demand = direction === "demand";

  for (let end = breakIdx - 1; end > swingIdx; end--) {
    let start = end;
    while (start - 1 >= swingIdx && candles[start - 1] &&
           overlaps(candles[start - 1], candles[start])) start--;
    if (end - start + 1 < 2) continue;
    let hi = -Infinity, lo = Infinity;
    for (let k = start; k <= end; k++) {
      if (candles[k].high > hi) hi = candles[k].high;
      if (candles[k].low < lo) lo = candles[k].low;
    }
    for (let k = end + 1; k <= breakIdx; k++) {
      const c = candles[k];
      if (!c) continue;
      if (!(demand ? c.close > hi : c.close < lo)) continue;
      // Exit found. It only counts if price never re-enters the base.
      let returned = false;
      for (let j = k + 1; j <= breakIdx; j++) {
        const b = candles[j];
        if (b && b.low <= hi && b.high >= lo) { returned = true; break; }
      }
      if (!returned) return k;
    }
  }
  return null;
}

/**
 * First bar after which price never trades back into the ORIGIN's zone.
 *
 * For each candidate bar the origin is read off with the fixed anchor — the
 * last opposite candle before it — and the bar qualifies only if that origin's
 * zone is never revisited before the break. This is "the move that left the
 * zone and did not come back", stated without reference to how far it went.
 */
export function runNeverRevisitsOrigin(ctx: OnsetContext): number | null {
  const { candles, swingIdx, breakIdx, direction } = ctx;
  for (let k = swingIdx + 1; k <= breakIdx; k++) {
    const origin = lastOppositeBefore(candles, k, direction, swingIdx);
    if (origin === null) continue;
    const g = ipoGeometry(candles[origin], direction);
    let revisited = false;
    for (let j = k; j <= breakIdx; j++) {
      const b = candles[j];
      if (b && b.low <= g.zoneHigh && b.high >= g.zoneLow) { revisited = true; break; }
    }
    if (!revisited) return k;
  }
  return null;
}

export interface MoveAnatomy {
  /** Bars of the last overlapping base before the break. */
  base: { start: number; end: number; startDatetime: string; endDatetime: string; high: number; low: number } | null;
  /** First bar closing beyond the base, whether or not it holds. */
  firstBaseExitIndex: number | null;
  /**
   * Permanent exit FROM THE REPORTED BASE. Null when that base is never left
   * for good, even if an earlier cluster does produce one.
   */
  permanentExitFromReportedBase: number | null;
  /**
   * What the PERMANENT_BASE_EXIT onset definition returns. It scans every
   * cluster, so it can come from a DIFFERENT base than the one reported above.
   * Kept separate: conflating them made the anatomy read as self-consistent
   * when it was describing two different clusters.
   */
  permanentBaseExitAnyCluster: number | null;
  /** First of two consecutive closes travelling the departure way. */
  firstSustainedCloseIndex: number | null;
  /** First bar after which the anchored origin's zone is never revisited. */
  neverRevisitsOriginIndex: number | null;
}

/** The structure of the move, described rather than scored. */
export function describeMove(ctx: OnsetContext): MoveAnatomy {
  const { candles, swingIdx, breakIdx, direction } = ctx;
  const demand = direction === "demand";

  let base: MoveAnatomy["base"] = null;
  let firstExit: number | null = null;
  for (let end = breakIdx - 1; end > swingIdx && !base; end--) {
    let start = end;
    while (start - 1 >= swingIdx && candles[start - 1] &&
           overlaps(candles[start - 1], candles[start])) start--;
    if (end - start + 1 < 2) continue;
    let hi = -Infinity, lo = Infinity;
    for (let k = start; k <= end; k++) {
      if (candles[k].high > hi) hi = candles[k].high;
      if (candles[k].low < lo) lo = candles[k].low;
    }
    base = {
      start, end, startDatetime: candles[start].datetime, endDatetime: candles[end].datetime,
      high: hi, low: lo,
    };
    for (let k = end + 1; k <= breakIdx; k++) {
      const c = candles[k];
      if (c && (demand ? c.close > hi : c.close < lo)) { firstExit = k; break; }
    }
  }

  let sustained: number | null = null;
  for (let k = swingIdx + 1; k < breakIdx; k++) {
    const p = candles[k - 1], a = candles[k], b = candles[k + 1];
    if (!p || !a || !b) continue;
    const one = demand ? a.close > p.close : a.close < p.close;
    const two = demand ? b.close > a.close : b.close < a.close;
    if (one && two) { sustained = k; break; }
  }

  // Permanent exit from the base actually reported, so the anatomy describes
  // one cluster rather than silently mixing two.
  let permFromReported: number | null = null;
  if (base && firstExit !== null) {
    for (let k = firstExit; k <= breakIdx; k++) {
      const c = candles[k];
      if (!c) continue;
      if (!(demand ? c.close > base.high : c.close < base.low)) continue;
      let returned = false;
      for (let j = k + 1; j <= breakIdx; j++) {
        const b = candles[j];
        if (b && b.low <= base.high && b.high >= base.low) { returned = true; break; }
      }
      if (!returned) { permFromReported = k; break; }
    }
  }

  return {
    base,
    firstBaseExitIndex: firstExit,
    permanentExitFromReportedBase: permFromReported,
    permanentBaseExitAnyCluster: permanentBaseExit(ctx),
    firstSustainedCloseIndex: sustained,
    neverRevisitsOriginIndex: runNeverRevisitsOrigin(ctx),
  };
}
