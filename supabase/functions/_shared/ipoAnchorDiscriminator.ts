/**
 * Mode A vs Mode B discrimination. RESEARCH ONLY, MEASUREMENT ONLY.
 *
 * THE QUESTION. Two anchor semantics both explain part of the corpus:
 *
 *   A  the onset candle itself is the origin
 *   B  the last opposite-colour candle before onset is the origin
 *
 * We are not looking for another universal formula. We are looking for an
 * observable property that says WHICH of the two applies — computed without
 * ever consulting the demonstration, so it could actually be used.
 *
 * SCOPE. Only pairs where an onset exists AND both readings are structurally
 * available: the onset bar is already the IPO colour (so A is possible) and a
 * prior opposite-colour bar exists inside the leg (so B is possible). Where the
 * onset is departure-coloured, A cannot apply at all and the case cannot
 * discriminate — those are reported separately rather than counted as evidence
 * for B.
 *
 * NO THRESHOLDS, NO SCORE. Every feature below is a count, a position or a
 * boolean read off the bars. Nothing is weighted and nothing is fitted.
 *
 * Nothing here is wired to the detector.
 */

import {
  ONSET_DEFINITIONS,
  lastOppositeBefore,
  type OnsetKey,
  type OnsetContext,
} from "./ipoDisplacementOnset.ts";
import { fvgsNear, ipoGeometry, type IPODirection } from "./ipoZones.ts";
import type { Candle } from "./smcAnalysis.ts";

const isUp = (c: Candle) => c.close >= c.open;

export type RunPosition = "first" | "middle" | "last" | "only" | "outside";
export type FvgRole = "CANDLE_1_OF_3" | "CANDLE_2_OF_3" | "CANDLE_3_OF_3" | "BEFORE_AN_FVG" | "NONE";
export type DemonstratedMode = "A" | "B" | "NEITHER";

export interface AnchorDiscriminatorRow {
  onsetKey: OnsetKey;
  onsetIndex: number | null;
  onsetDatetime: string | null;
  onsetColour: "up" | "down" | null;
  stepBackIndex: number | null;
  stepBackDatetime: string | null;

  /** Both readings available => this pair can discriminate. */
  modeAAvailable: boolean;
  modeBAvailable: boolean;
  discriminating: boolean;
  /** Which reading the demonstration actually took. Never used as a feature. */
  demonstratedMode: DemonstratedMode;

  // 1 — onset membership in the minimal BOS-causal run
  causalRunStart: number | null;
  onsetInCausalRun: boolean;
  onsetPositionInCausalRun: RunPosition;
  causalRunLength: number | null;

  // 2 — distance
  barsOnsetToBreak: number | null;
  breakExactlyTwoBarsAfterOnset: boolean;

  // 3 — immediate follow-through after the onset
  nextContinuesDirection: boolean | null;
  nextRetracesIntoOnsetRange: boolean | null;
  nextClosesBeyondOnsetRange: boolean | null;

  // 4 — the onset's role in the imbalance
  onsetFvgRole: FvgRole;

  // 5 — is the onset load-bearing for the path to the break?
  onsetNecessaryForCausalPath: boolean | null;

  // 6 — which candle is the final opposing bar before sustained closes begin
  sustainedClosesStartIndex: number | null;
  finalOpposingBeforeSustained: number | null;
  finalOpposingIsOnset: boolean;
  finalOpposingIsStepBack: boolean;

  // 7 — retracement before the break
  revisitsOnsetRangeBeforeBreak: boolean;
  revisitsStepBackRangeBeforeBreak: boolean | null;

  // 8 — sweep timing
  sweepBeforeStepBack: boolean | null;
  sweepBeforeOnset: boolean;
  sweepOnOnset: boolean;
}

export interface AnchorDiscriminatorResult {
  demonstratedIndex: number;
  demonstratedDatetime: string;
  direction: IPODirection;
  swingIndex: number;
  breakIndex: number;
  rows: AnchorDiscriminatorRow[];
}

/** The minimal unbroken run of progress ending at the break. */
function causalRun(candles: Candle[], swingIdx: number, breakIdx: number, direction: IPODirection) {
  const demand = direction === "demand";
  let k = breakIdx;
  while (k - 1 >= swingIdx) {
    const cur = candles[k], prev = candles[k - 1];
    if (!cur || !prev) break;
    if (!(demand ? cur.high > prev.high : cur.low < prev.low)) break;
    k--;
  }
  return { start: k, end: breakIdx, length: breakIdx - k + 1 };
}

/** Did a sweep of the prior window's extreme happen at bar i, on the IPO side? */
function sweptAt(candles: Candle[], i: number, direction: IPODirection, w = 10): boolean {
  const demand = direction === "demand";
  let hi = -Infinity, lo = Infinity;
  for (let j = Math.max(0, i - w); j <= i - 1; j++) {
    if (!candles[j]) continue;
    if (candles[j].high > hi) hi = candles[j].high;
    if (candles[j].low < lo) lo = candles[j].low;
  }
  if (!Number.isFinite(hi)) return false;
  return demand ? candles[i].low < lo : candles[i].high > hi;
}

export function discriminateAnchorModes(
  candles: Candle[],
  demonstratedIdx: number,
  direction: IPODirection,
  swingIdx: number,
  breakIdx: number,
): AnchorDiscriminatorResult {
  const ctx: OnsetContext = { candles, swingIdx, breakIdx, direction };
  const demand = direction === "demand";
  const wantUp = direction === "supply";
  const run = causalRun(candles, swingIdx, breakIdx, direction);

  const rows: AnchorDiscriminatorRow[] = ONSET_DEFINITIONS.map((d) => {
    const onset = d.find(ctx);
    const base = {
      onsetKey: d.key, onsetIndex: onset,
      onsetDatetime: onset === null ? null : candles[onset].datetime,
      onsetColour: onset === null ? null : (isUp(candles[onset]) ? "up" as const : "down" as const),
    };
    if (onset === null) {
      return {
        ...base, stepBackIndex: null, stepBackDatetime: null,
        modeAAvailable: false, modeBAvailable: false, discriminating: false,
        demonstratedMode: "NEITHER" as DemonstratedMode,
        causalRunStart: run.start, onsetInCausalRun: false,
        onsetPositionInCausalRun: "outside" as RunPosition, causalRunLength: run.length,
        barsOnsetToBreak: null, breakExactlyTwoBarsAfterOnset: false,
        nextContinuesDirection: null, nextRetracesIntoOnsetRange: null,
        nextClosesBeyondOnsetRange: null, onsetFvgRole: "NONE" as FvgRole,
        onsetNecessaryForCausalPath: null,
        sustainedClosesStartIndex: null, finalOpposingBeforeSustained: null,
        finalOpposingIsOnset: false, finalOpposingIsStepBack: false,
        revisitsOnsetRangeBeforeBreak: false, revisitsStepBackRangeBeforeBreak: null,
        sweepBeforeStepBack: null, sweepBeforeOnset: false, sweepOnOnset: false,
      };
    }

    const stepBack = lastOppositeBefore(candles, onset, direction, swingIdx);
    const onsetIsIpo = isUp(candles[onset]) === wantUp;
    const modeAAvailable = onsetIsIpo;
    const modeBAvailable = stepBack !== null;
    const demonstratedMode: DemonstratedMode =
      demonstratedIdx === onset ? "A" : demonstratedIdx === stepBack ? "B" : "NEITHER";

    // 1 — position within the causal run
    const inRun = onset >= run.start && onset <= run.end;
    const pos: RunPosition = !inRun ? "outside"
      : run.length === 1 ? "only"
      : onset === run.start ? "first"
      : onset === run.end ? "last" : "middle";

    // 3 — the bar right after the onset
    const nxt = candles[onset + 1] ?? null;
    const oHi = candles[onset].high, oLo = candles[onset].low;
    const nextContinues = nxt ? isUp(nxt) === demand : null;
    const nextRetraces = nxt ? (nxt.low <= oHi && nxt.high >= oLo) : null;
    const nextClosesBeyond = nxt ? (demand ? nxt.close > oHi : nxt.close < oLo) : null;

    // 4 — role in the three-bar imbalance. detectFVGs indexes the MIDDLE bar.
    const aligned = fvgsNear(candles, onset)
      .filter((f) => f.type === (demand ? "bullish" : "bearish"))
      .filter((f) => f.absIndex >= swingIdx && f.absIndex <= breakIdx);
    let role: FvgRole = "NONE";
    for (const f of aligned) {
      if (f.absIndex - 1 === onset) { role = "CANDLE_1_OF_3"; break; }
      if (f.absIndex === onset) { role = "CANDLE_2_OF_3"; break; }
      if (f.absIndex + 1 === onset) { role = "CANDLE_3_OF_3"; break; }
    }
    if (role === "NONE" && aligned.some((f) => f.absIndex - 1 > onset)) role = "BEFORE_AN_FVG";

    // 5 — is the onset load-bearing? Skip it and ask whether the remaining path
    // from onset-1 to the break still progresses monotonically.
    let necessary: boolean | null = null;
    if (inRun) {
      let ok = true;
      let prevBar = candles[onset - 1] ?? null;
      if (!prevBar) necessary = null;
      else {
        for (let k = onset + 1; k <= breakIdx; k++) {
          const cur = candles[k];
          if (!cur) continue;
          if (!(demand ? cur.high > prevBar!.high : cur.low < prevBar!.low)) { ok = false; break; }
          prevBar = cur;
        }
        necessary = !ok;      // path breaks without it => the onset was needed
      }
    }

    // 6 — the final opposing bar before sustained directional closes begin
    let sustained: number | null = null;
    for (let k = swingIdx + 1; k < breakIdx; k++) {
      const a = candles[k], b = candles[k + 1], p = candles[k - 1];
      if (!a || !b || !p) continue;
      const up1 = demand ? a.close > p.close : a.close < p.close;
      const up2 = demand ? b.close > a.close : b.close < a.close;
      if (up1 && up2) { sustained = k; break; }
    }
    const finalOpposing = sustained === null ? null
      : lastOppositeBefore(candles, sustained, direction, swingIdx);

    // 7 — retracement into either candidate's zone before the break
    const zoneOf = (i: number) => ipoGeometry(candles[i], direction);
    const revisits = (i: number) => {
      const g = zoneOf(i);
      for (let k = i + 1; k < breakIdx; k++) {
        const b = candles[k];
        if (b && b.low <= g.zoneHigh && b.high >= g.zoneLow) return true;
      }
      return false;
    };

    return {
      ...base,
      stepBackIndex: stepBack,
      stepBackDatetime: stepBack === null ? null : candles[stepBack].datetime,
      modeAAvailable, modeBAvailable,
      discriminating: modeAAvailable && modeBAvailable && stepBack !== onset,
      demonstratedMode,
      causalRunStart: run.start,
      onsetInCausalRun: inRun,
      onsetPositionInCausalRun: pos,
      causalRunLength: run.length,
      barsOnsetToBreak: breakIdx - onset,
      breakExactlyTwoBarsAfterOnset: breakIdx - onset === 2,
      nextContinuesDirection: nextContinues,
      nextRetracesIntoOnsetRange: nextRetraces,
      nextClosesBeyondOnsetRange: nextClosesBeyond,
      onsetFvgRole: role,
      onsetNecessaryForCausalPath: necessary,
      sustainedClosesStartIndex: sustained,
      finalOpposingBeforeSustained: finalOpposing,
      finalOpposingIsOnset: finalOpposing === onset,
      finalOpposingIsStepBack: finalOpposing !== null && finalOpposing === stepBack,
      revisitsOnsetRangeBeforeBreak: revisits(onset),
      revisitsStepBackRangeBeforeBreak: stepBack === null ? null : revisits(stepBack),
      sweepBeforeStepBack: stepBack === null ? null
        : Array.from({ length: Math.max(0, stepBack - swingIdx) }, (_, n) => swingIdx + n)
            .some((i) => sweptAt(candles, i, direction)),
      sweepBeforeOnset: Array.from({ length: Math.max(0, onset - swingIdx) }, (_, n) => swingIdx + n)
        .some((i) => sweptAt(candles, i, direction)),
      sweepOnOnset: sweptAt(candles, onset, direction),
    };
  });

  return {
    demonstratedIndex: demonstratedIdx,
    demonstratedDatetime: candles[demonstratedIdx].datetime,
    direction, swingIndex: swingIdx, breakIndex: breakIdx,
    rows,
  };
}
