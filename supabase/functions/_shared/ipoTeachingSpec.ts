/**
 * The origin rule AS TAUGHT, measured. RESEARCH ONLY.
 *
 * THE LITERAL SPECIFICATION, from "smart money part 1":
 *
 *   Rules:
 *     - Break Structure
 *     - Cannot be inside a consolidation
 *     - Last candle before major move
 *     - Candle that took people out
 *
 *   plus two chart annotations naming the same thing per direction:
 *     "Last Bullish before the big drop"   (supply)
 *     "last bearish candle before the big push up"  (demand)
 *
 * WHAT THIS CHANGES ABOUT THE PROBLEM. The taught rule has no notion of a swing
 * extreme, a largest candle or a strongest displacement. It is entirely
 * relative to the MAJOR MOVE: find the move, take the last opposite candle
 * before it. So the hard part is not ranking origin candidates — it is defining
 * where the move begins. Ranking is what production does, and ranking is what
 * disagrees with the demonstrations.
 *
 * WHAT CANNOT BE MEASURED. "Cannot be inside a consolidation" names a condition
 * this project retired as indefensible. Every zone reports UNRESOLVED, so that
 * clause is reported as unevaluated rather than silently treated as satisfied.
 *
 * Nothing here is wired to the detector. Frozen modules are imported, not edited.
 */

import {
  ONSET_DEFINITIONS,
  lastOppositeBefore,
  type OnsetKey,
  type OnsetContext,
} from "./ipoDisplacementOnset.ts";
import { assessConsolidation, type IPODirection } from "./ipoZones.ts";
import { baseConstructIsDegenerate } from "./ipoContraction.ts";
import type { Candle } from "./smcAnalysis.ts";

const isUp = (c: Candle) => c.close >= c.open;

/** Onset keys, plus the one the teaching implies that we had not tested. */
export type TeachingOnsetKey = OnsetKey | "FINAL_BASE_EXIT";

/**
 * "First candle after the final meaningful retracement/base."
 *
 * The base is the last run of two or more consecutive bars whose ranges overlap
 * each other — price going nowhere. The onset is the first bar after it that
 * CLOSES outside the base's range in the departure direction.
 *
 * Parameter-free apart from the two-bar minimum, which is the smallest thing
 * that can be called a base. Deliberately says nothing about size: a base is
 * defined by overlap, not by being small in ATR, because an ATR threshold is
 * exactly the kind of fitted number this exercise is trying to avoid.
 */
export function finalBaseExit(ctx: OnsetContext): number | null {
  const { candles, swingIdx, breakIdx, direction } = ctx;
  const demand = direction === "demand";
  const overlaps = (a: Candle, b: Candle) => a.low <= b.high && a.high >= b.low;

  // Walk back from the break to find the latest overlapping cluster.
  for (let end = breakIdx - 1; end > swingIdx; end--) {
    let start = end;
    while (start - 1 >= swingIdx && candles[start - 1] &&
           overlaps(candles[start - 1], candles[start])) start--;
    if (end - start + 1 < 2) continue;                 // not a base
    let hi = -Infinity, lo = Infinity;
    for (let k = start; k <= end; k++) {
      if (candles[k].high > hi) hi = candles[k].high;
      if (candles[k].low < lo) lo = candles[k].low;
    }
    for (let k = end + 1; k <= breakIdx; k++) {
      const c = candles[k];
      if (!c) continue;
      if (demand ? c.close > hi : c.close < lo) return k;   // left the base
    }
  }
  return null;
}

export interface TookPeopleOutReadings {
  /** Takes the extreme of the prior 10 bars on the IPO's own side. */
  sweepsPriorLocalExtreme: boolean;
  /** Takes it with the wick and closes back inside — the classic stop raid. */
  wicksThroughAndClosesBack: boolean;
  /** Range fully engulfs the previous candle. */
  engulfsPreviousCandle: boolean;
  /** Takes only the immediately preceding 1-3 bars' extreme. */
  removesShortTermExtreme: boolean;
  /** Does not sweep itself, but a later bar before the break does. */
  merelyPrecedesALaterSweep: boolean;
}

/** Every reading of "took people out", measured without choosing between them. */
export function tookPeopleOut(
  candles: Candle[], i: number, direction: IPODirection, breakIdx: number, w = 10,
): TookPeopleOutReadings {
  const demand = direction === "demand";
  const c = candles[i];
  const prev = candles[i - 1] ?? null;

  const ext = (from: number, to: number) => {
    let hi = -Infinity, lo = Infinity;
    for (let k = Math.max(0, from); k <= to; k++) {
      if (!candles[k]) continue;
      if (candles[k].high > hi) hi = candles[k].high;
      if (candles[k].low < lo) lo = candles[k].low;
    }
    return { hi, lo };
  };

  const wide = ext(i - w, i - 1);
  const swept = Number.isFinite(wide.hi) &&
    (demand ? c.low < wide.lo : c.high > wide.hi);
  const closedBack = !swept ? false
    : (demand ? c.close > wide.lo : c.close < wide.hi);

  const near = ext(i - 3, i - 1);
  const short = Number.isFinite(near.hi) &&
    (demand ? c.low < near.lo : c.high > near.hi);

  const engulfs = !!prev && c.high >= prev.high && c.low <= prev.low;

  let laterSweep = false;
  const lastK = Math.min(breakIdx, candles.length) - 1;
  for (let k = i + 1; k <= lastK; k++) {
    if (!candles[k]) continue;
    const e = ext(k - w, k - 1);
    if (!Number.isFinite(e.hi)) continue;
    if (demand ? candles[k].low < e.lo : candles[k].high > e.hi) { laterSweep = true; break; }
  }

  return {
    sweepsPriorLocalExtreme: swept,
    wicksThroughAndClosesBack: swept && closedBack,
    engulfsPreviousCandle: engulfs,
    removesShortTermExtreme: short,
    merelyPrecedesALaterSweep: !swept && laterSweep,
  };
}

export interface TeachingTrial {
  onsetKey: TeachingOnsetKey;
  parameterFree: boolean;
  /**
   * DEGENERATE_FOR_RESEARCH. Set when this trial rests on the adjacent-overlap
   * base construct AND that construct cannot separate anything in this leg.
   * A degenerate trial must not be counted as evidence for or against anything:
   * measured on all four Tier-1 Ezzy legs it returned the break bar, and its
   * origin was identical to LAST_OPPOSITE_BEFORE_BREAK on 4 of 4.
   */
  degenerateForResearch?: boolean;
  degeneracyNote?: string;
  onsetIndex: number | null;
  onsetDatetime: string | null;
  lastOppositeIndex: number | null;
  lastOppositeDatetime: string | null;
  exactMatch: boolean;
  barsOriginToOnset: number | null;
}

export interface TeachingSpecResult {
  demonstratedIndex: number;
  demonstratedDatetime: string;
  direction: IPODirection;
  swingIndex: number;
  breakIndex: number;
  breakDatetime: string;

  /** Clause 1: break structure. */
  structure: {
    breakExists: boolean;
    breakKind: string | null;
    barsOriginToBreak: number;
    originPrecedesBreak: boolean;
  };
  /** Clause 2: not inside a consolidation — UNEVALUABLE, and that is the point. */
  consolidation: {
    status: "UNRESOLVED";
    retiredPredicateFlag: boolean;
    note: string;
  };
  /** Clause 4: took people out, on the DEMONSTRATED candle. */
  tookPeopleOut: TookPeopleOutReadings;
  /** Clause 3: last opposite candle before the major move, per onset definition. */
  trials: TeachingTrial[];
}

export function testTeachingSpec(
  candles: Candle[],
  demonstratedIdx: number,
  direction: IPODirection,
  swingIdx: number,
  breakIdx: number,
  breakKind: string | null,
): TeachingSpecResult {
  const ctx: OnsetContext = { candles, swingIdx, breakIdx, direction };
  const con = assessConsolidation(candles, demonstratedIdx);

  const defs: Array<{ key: TeachingOnsetKey; free: boolean; find: (c: OnsetContext) => number | null }> = [
    ...ONSET_DEFINITIONS.map((d) => ({
      key: d.key as TeachingOnsetKey, free: d.parameter === null, find: d.find,
    })),
    { key: "FINAL_BASE_EXIT", free: true, find: finalBaseExit },
  ];

  const degen = baseConstructIsDegenerate(candles, swingIdx, breakIdx);
  const DEPENDS_ON_BASE = new Set<TeachingOnsetKey>(["FINAL_BASE_EXIT"]);

  const trials: TeachingTrial[] = defs.map(({ key, free, find }) => {
    const onset = find(ctx);
    const degenerate = DEPENDS_ON_BASE.has(key) && degen.degenerate;
    // The taught rule is unconditional: the LAST opposite candle before the
    // move. No branch on the onset's own colour — that was our invention and it
    // is not in the specification.
    const last = onset === null ? null : lastOppositeBefore(candles, onset, direction, swingIdx);
    return {
      onsetKey: key, parameterFree: free,
      ...(degenerate ? { degenerateForResearch: true, degeneracyNote: degen.note } : {}),
      onsetIndex: onset,
      onsetDatetime: onset === null ? null : candles[onset].datetime,
      lastOppositeIndex: last,
      lastOppositeDatetime: last === null ? null : candles[last].datetime,
      exactMatch: last === demonstratedIdx,
      barsOriginToOnset: last === null || onset === null ? null : onset - last,
    };
  });

  return {
    demonstratedIndex: demonstratedIdx,
    demonstratedDatetime: candles[demonstratedIdx].datetime,
    direction, swingIndex: swingIdx, breakIndex: breakIdx,
    breakDatetime: candles[breakIdx].datetime,
    structure: {
      breakExists: true,
      breakKind,
      barsOriginToBreak: breakIdx - demonstratedIdx,
      originPrecedesBreak: demonstratedIdx < breakIdx,
    },
    consolidation: {
      status: "UNRESOLVED",
      retiredPredicateFlag: con.insideConsolidation,
      note: "The teaching states 'cannot be inside a consolidation'. This project " +
        "retired its consolidation predicate as indefensible, so the clause is " +
        "UNEVALUATED — not satisfied, not violated. The flag shown is the retired " +
        "heuristic's raw output, kept only as a marker of an open question.",
    },
    tookPeopleOut: tookPeopleOut(candles, demonstratedIdx, direction, breakIdx),
    trials,
  };
}
