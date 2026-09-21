/**
 * Displacement-onset hypothesis. RESEARCH ONLY, MEASUREMENT ONLY.
 *
 * THE HYPOTHESIS (USER_CONFIRMED). The origin is the last opposite-direction
 * candle immediately before the true impulsive displacement begins. The candle
 * itself need not be the sweep, the structural extreme, the largest range or
 * the highest-displacement bar. What identifies it is the sequence AFTER it:
 *
 *     origin candle -> immediate expansion -> structural consequence
 *
 * WHY THE ORDER OF OPERATIONS MATTERS. Every earlier definition scored
 * candidates by what followed each one and took the best — which is exactly how
 * the detector already fails, since in all five disagreeing legs the candle it
 * chose had the LARGER subsequent displacement. So onset is located FIRST,
 * using only forward-looking structure of the move itself, and the origin is
 * then read off by stepping backward. No candidate is ever ranked by its own
 * future move.
 *
 * Several onset definitions are tested separately and never combined. Two carry
 * an explicit numeric threshold; those are OPERATIONAL_INTERPRETATION and are
 * labelled as such, because a threshold tuned on twelve examples is a fitted
 * parameter wearing a hypothesis costume.
 *
 * Nothing here is wired to the detector.
 */

import { fvgsNear, type IPODirection } from "./ipoZones.ts";
import { calculateATR } from "./smcAnalysis.ts";
import type { Candle } from "./smcAnalysis.ts";

const isUp = (c: Candle) => c.close >= c.open;

export interface OnsetContext {
  candles: Candle[];
  swingIdx: number;
  breakIdx: number;
  direction: IPODirection;
}

export type OnsetKey =
  | "BODY_ATR_1_0"
  | "BODY_ATR_1_5"
  | "EXPANSION_RUN_2"
  | "FVG_SEQUENCE_START"
  | "BOS_CAUSAL_RUN";

export interface OnsetDefinition {
  key: OnsetKey;
  /** What counts as "the impulse started here". */
  definition: string;
  /** Null when the definition carries no tunable number. */
  parameter: string | null;
  find(ctx: OnsetContext): number | null;
}

/** Body size in ATR at a bar, computed causally. */
function bodyAtr(candles: Candle[], i: number): number {
  const a = calculateATR(candles.slice(0, i), 14) || 1;
  return Math.abs(candles[i].close - candles[i].open) / a;
}

/** First bar in the leg moving the departure way with a body over `t` ATR. */
function firstBigBody(ctx: OnsetContext, t: number): number | null {
  const demand = ctx.direction === "demand";
  for (let k = ctx.swingIdx; k <= ctx.breakIdx; k++) {
    const c = ctx.candles[k];
    if (!c) continue;
    if (isUp(c) !== demand) continue;          // must travel the departure way
    if (bodyAtr(ctx.candles, k) >= t) return k;
  }
  return null;
}

export const ONSET_DEFINITIONS: OnsetDefinition[] = [
  {
    key: "BODY_ATR_1_0",
    definition: "First departure-direction candle whose body is at least 1.0 ATR.",
    parameter: "1.0 ATR — OPERATIONAL_INTERPRETATION, not taught",
    find: (ctx) => firstBigBody(ctx, 1.0),
  },
  {
    key: "BODY_ATR_1_5",
    definition: "First departure-direction candle whose body is at least 1.5 ATR.",
    parameter: "1.5 ATR — OPERATIONAL_INTERPRETATION, not taught",
    find: (ctx) => firstBigBody(ctx, 1.5),
  },
  {
    key: "EXPANSION_RUN_2",
    definition:
      "First bar of the earliest run of two or more consecutive departure-direction " +
      "candles that each extend the move — higher high for demand, lower low for supply. " +
      "Parameter-free apart from the run length, which is the minimum that can be called a run.",
    parameter: "run length 2 — the smallest value that means anything",
    find: (ctx) => {
      const demand = ctx.direction === "demand";
      for (let k = ctx.swingIdx; k < ctx.breakIdx; k++) {
        const a = ctx.candles[k], b = ctx.candles[k + 1];
        if (!a || !b) continue;
        if (isUp(a) !== demand || isUp(b) !== demand) continue;
        const extend = demand ? b.high > a.high : b.low < a.low;
        if (extend) return k;
      }
      return null;
    },
  },
  {
    key: "FVG_SEQUENCE_START",
    definition:
      "First bar of the three-bar sequence that forms the earliest aligned fair value " +
      "gap in the leg. The imbalance is the displacement's own signature, so its first " +
      "bar is the onset. Parameter-free.",
    parameter: null,
    find: (ctx) => {
      const demand = ctx.direction === "demand";
      let best: number | null = null;
      for (let k = ctx.swingIdx; k <= ctx.breakIdx; k++) {
        const hits = fvgsNear(ctx.candles, k)
          .filter((f) => f.type === (demand ? "bullish" : "bearish"))
          .filter((f) => f.absIndex >= ctx.swingIdx && f.absIndex <= ctx.breakIdx);
        for (const f of hits) {
          // detectFVGs indexes the MIDDLE bar, so the sequence starts one earlier.
          const start = f.absIndex - 1;
          if (start >= ctx.swingIdx && (best === null || start < best)) best = start;
        }
        if (best !== null) break;
      }
      return best;
    },
  },
  {
    key: "BOS_CAUSAL_RUN",
    definition:
      "First bar of the unbroken run of progress that ends at the break bar. Walks back " +
      "from the break while each bar extends toward it, so the onset is the start of the " +
      "move that actually caused the structural consequence. Parameter-free.",
    parameter: null,
    find: (ctx) => {
      const demand = ctx.direction === "demand";
      let k = ctx.breakIdx;
      while (k - 1 >= ctx.swingIdx) {
        const cur = ctx.candles[k], prev = ctx.candles[k - 1];
        if (!cur || !prev) break;
        const progressing = demand ? cur.high > prev.high : cur.low < prev.low;
        if (!progressing) break;
        k--;
      }
      return k;
    },
  },
];

/**
 * The last opposite-direction candle strictly before `onset`.
 *
 * "Opposite" is relative to the departure: a demand IPO is the last BEARISH
 * candle before a bullish impulse, a supply IPO the last BULLISH candle before
 * a bearish one. Bounded at the swing so the step-back cannot wander out of the
 * leg it belongs to.
 */
export function lastOppositeBefore(
  candles: Candle[], onset: number, direction: IPODirection, swingIdx: number,
): number | null {
  const wantUp = direction === "supply";     // supply IPO is an up candle
  for (let k = onset - 1; k >= swingIdx; k--) {
    if (candles[k] && isUp(candles[k]) === wantUp) return k;
  }
  return null;
}

export interface OnsetTrial {
  onsetKey: OnsetKey;
  onsetIndex: number | null;
  onsetDatetime: string | null;
  onsetBodyAtr: number | null;
  steppedBackIndex: number | null;
  steppedBackDatetime: string | null;
  exactMatch: boolean;
  barsOriginToOnset: number | null;
  /** Set when the step-back found nothing IPO-coloured before the onset. */
  failure: string | null;
}

export interface OnsetExampleResult {
  demonstratedIndex: number;
  demonstratedDatetime: string;
  direction: IPODirection;
  swingIndex: number;
  breakIndex: number;
  breakDatetime: string;
  extremeIndex: number;
  extremeDatetime: string;
  /** Does a sweep or the leg extreme sit BEFORE the demonstrated origin? */
  sweepOrExtremeBeforeOrigin: {
    extremeBefore: boolean;
    sweepBefore: boolean;
    sweepIndexes: number[];
  };
  trials: OnsetTrial[];
}

function legExtreme(candles: Candle[], swingIdx: number, breakIdx: number, direction: IPODirection) {
  const demand = direction === "demand";
  let idx = swingIdx;
  for (let k = swingIdx; k <= breakIdx; k++) {
    if (!candles[k]) continue;
    if (demand ? candles[k].low <= candles[idx].low : candles[k].high >= candles[idx].high) idx = k;
  }
  return idx;
}

/** Runs every onset definition for one demonstrated origin. */
export function testOnsetHypothesis(
  candles: Candle[],
  demonstratedIdx: number,
  direction: IPODirection,
  swingIdx: number,
  breakIdx: number,
  sweepWindow = 10,
): OnsetExampleResult {
  const ctx: OnsetContext = { candles, swingIdx, breakIdx, direction };
  const demand = direction === "demand";
  const extremeIdx = legExtreme(candles, swingIdx, breakIdx, direction);

  // Sweeps strictly before the demonstrated origin, on the IPO's own side.
  const sweepIndexes: number[] = [];
  for (let k = swingIdx; k < demonstratedIdx; k++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = Math.max(0, k - sweepWindow); j <= k - 1; j++) {
      if (!candles[j]) continue;
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    if (!Number.isFinite(hi)) continue;
    if (demand ? candles[k].low < lo : candles[k].high > hi) sweepIndexes.push(k);
  }

  const trials: OnsetTrial[] = ONSET_DEFINITIONS.map((d) => {
    const onset = d.find(ctx);
    if (onset === null) {
      return {
        onsetKey: d.key, onsetIndex: null, onsetDatetime: null, onsetBodyAtr: null,
        steppedBackIndex: null, steppedBackDatetime: null, exactMatch: false,
        barsOriginToOnset: null, failure: "no displacement onset found in this leg",
      };
    }
    const back = lastOppositeBefore(candles, onset, direction, swingIdx);
    return {
      onsetKey: d.key,
      onsetIndex: onset,
      onsetDatetime: candles[onset].datetime,
      onsetBodyAtr: Math.round(bodyAtr(candles, onset) * 100) / 100,
      steppedBackIndex: back,
      steppedBackDatetime: back === null ? null : candles[back].datetime,
      exactMatch: back === demonstratedIdx,
      barsOriginToOnset: back === null ? null : onset - back,
      failure: back === null
        ? "no opposite-direction candle between the swing and the onset"
        : null,
    };
  });

  return {
    demonstratedIndex: demonstratedIdx,
    demonstratedDatetime: candles[demonstratedIdx].datetime,
    direction, swingIndex: swingIdx, breakIndex: breakIdx,
    breakDatetime: candles[breakIdx].datetime,
    extremeIndex: extremeIdx, extremeDatetime: candles[extremeIdx].datetime,
    sweepOrExtremeBeforeOrigin: {
      extremeBefore: extremeIdx < demonstratedIdx,
      sweepBefore: sweepIndexes.length > 0,
      sweepIndexes,
    },
    trials,
  };
}
