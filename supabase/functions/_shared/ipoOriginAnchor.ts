/**
 * Anchor semantics on top of the FROZEN onset detectors. RESEARCH ONLY.
 *
 * WHY A SEPARATE FILE. The onset definitions are frozen. Putting this rule
 * beside them would make "unchanged since the freeze" unverifiable by
 * inspection, so the anchor lives here and imports them. ipoDisplacementOnset.ts
 * is not touched by this work at all.
 *
 * THE HYPOTHESIS. A strict "always step back from onset" rule is too narrow.
 * AUD/USD 2023-10-31 showed why: BOS_CAUSAL_RUN put the onset ON the
 * demonstrated candle — the demonstrated bar was itself the first bar of the
 * run that caused the break — and the rule then stepped straight past it,
 * because it steps back unconditionally.
 *
 *   ONSET_OR_LAST_OPPOSITE_BEFORE
 *     demand : onset bearish -> the onset candle IS the origin
 *              otherwise     -> walk back to the nearest bearish candle
 *     supply : onset bullish -> the onset candle IS the origin
 *              otherwise     -> walk back to the nearest bullish candle
 *
 * NO THRESHOLD IS INTRODUCED. The rule is a branch on candle colour, which is
 * already how the IPO direction is defined everywhere else in this module.
 *
 * Nothing here is wired to the detector.
 */

import {
  ONSET_DEFINITIONS,
  lastOppositeBefore,
  type OnsetKey,
  type OnsetContext,
} from "./ipoDisplacementOnset.ts";
import { fvgsNear, type IPODirection } from "./ipoZones.ts";
import { calculateATR } from "./smcAnalysis.ts";
import type { Candle } from "./smcAnalysis.ts";

const isUp = (c: Candle) => c.close >= c.open;

/** Which branch of the anchor rule produced the origin. */
export type AnchorMode = "ONSET_IS_ORIGIN" | "STEP_BACK_TO_LAST_OPPOSITE" | "NONE";

export interface AnchorTrial {
  onsetKey: OnsetKey;
  onsetIndex: number | null;
  onsetDatetime: string | null;
  onsetColour: "up" | "down" | null;
  /** True when the onset bar is already the IPO colour for this direction. */
  onsetIsIpoColoured: boolean | null;
  anchorMode: AnchorMode;
  originIndex: number | null;
  originDatetime: string | null;
  exactMatch: boolean;
  barsOriginToOnset: number | null;
  barsOriginToBreak: number | null;
  failure: string | null;
}

export interface AnchorExampleResult {
  demonstratedIndex: number;
  demonstratedDatetime: string;
  direction: IPODirection;
  swingIndex: number;
  breakIndex: number;
  breakDatetime: string;
  extremeIndex: number;
  productionSelectedIndex: number | null;
  productionMatches: boolean;
  context: {
    extremeBeforeOrigin: boolean;
    sweepBeforeOrigin: boolean;
    sweepCount: number;
    demonstratedCreatesFvg: boolean;
    demonstratedInBosCausalRun: boolean;
    barsDemonstratedToBreak: number;
  };
  trials: AnchorTrial[];
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

/**
 * Applies the anchor rule to every frozen onset definition.
 *
 * The onset finders are called exactly as they are; only what happens AFTER the
 * onset differs from the previous experiment.
 */
export function testAnchorHypothesis(
  candles: Candle[],
  demonstratedIdx: number,
  direction: IPODirection,
  swingIdx: number,
  breakIdx: number,
  productionSelectedIdx: number | null,
  sweepWindow = 10,
): AnchorExampleResult {
  const ctx: OnsetContext = { candles, swingIdx, breakIdx, direction };
  const demand = direction === "demand";
  const wantUp = direction === "supply";        // the IPO's own colour
  const extremeIdx = legExtreme(candles, swingIdx, breakIdx, direction);

  let sweepCount = 0;
  for (let k = swingIdx; k < demonstratedIdx; k++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = Math.max(0, k - sweepWindow); j <= k - 1; j++) {
      if (!candles[j]) continue;
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    if (!Number.isFinite(hi)) continue;
    if (demand ? candles[k].low < lo : candles[k].high > hi) sweepCount++;
  }

  // Does an aligned gap form within three bars of the demonstrated candle?
  const createsFvg = fvgsNear(candles, demonstratedIdx)
    .filter((f) => f.type === (demand ? "bullish" : "bearish"))
    .some((f) => f.absIndex >= demonstratedIdx && f.absIndex <= demonstratedIdx + 3);

  // Is the demonstrated candle inside the unbroken run that reaches the break?
  const bosRunStart = ONSET_DEFINITIONS.find((d) => d.key === "BOS_CAUSAL_RUN")!.find(ctx);
  const inBosRun = bosRunStart !== null &&
    demonstratedIdx >= bosRunStart && demonstratedIdx <= breakIdx;

  const trials: AnchorTrial[] = ONSET_DEFINITIONS.map((d) => {
    const onset = d.find(ctx);
    if (onset === null) {
      return {
        onsetKey: d.key, onsetIndex: null, onsetDatetime: null, onsetColour: null,
        onsetIsIpoColoured: null, anchorMode: "NONE" as AnchorMode,
        originIndex: null, originDatetime: null, exactMatch: false,
        barsOriginToOnset: null, barsOriginToBreak: null,
        failure: "no displacement onset found in this leg",
      };
    }
    const onsetIsIpo = isUp(candles[onset]) === wantUp;
    // THE BRANCH. An onset bar that is already the IPO colour is the origin;
    // stepping past it would discard the very candle the impulse began from.
    const origin = onsetIsIpo ? onset : lastOppositeBefore(candles, onset, direction, swingIdx);
    return {
      onsetKey: d.key,
      onsetIndex: onset,
      onsetDatetime: candles[onset].datetime,
      onsetColour: isUp(candles[onset]) ? "up" : "down",
      onsetIsIpoColoured: onsetIsIpo,
      anchorMode: origin === null
        ? "NONE"
        : onsetIsIpo ? "ONSET_IS_ORIGIN" : "STEP_BACK_TO_LAST_OPPOSITE",
      originIndex: origin,
      originDatetime: origin === null ? null : candles[origin].datetime,
      exactMatch: origin === demonstratedIdx,
      barsOriginToOnset: origin === null ? null : onset - origin,
      barsOriginToBreak: origin === null ? null : breakIdx - origin,
      failure: origin === null
        ? "no opposite-direction candle between the swing and the onset"
        : null,
    };
  });

  return {
    demonstratedIndex: demonstratedIdx,
    demonstratedDatetime: candles[demonstratedIdx].datetime,
    direction, swingIndex: swingIdx, breakIndex: breakIdx,
    breakDatetime: candles[breakIdx].datetime,
    extremeIndex: extremeIdx,
    productionSelectedIndex: productionSelectedIdx,
    productionMatches: productionSelectedIdx === demonstratedIdx,
    context: {
      extremeBeforeOrigin: extremeIdx < demonstratedIdx,
      sweepBeforeOrigin: sweepCount > 0,
      sweepCount,
      demonstratedCreatesFvg: createsFvg,
      demonstratedInBosCausalRun: inBosRun,
      barsDemonstratedToBreak: breakIdx - demonstratedIdx,
    },
    trials,
  };
}
