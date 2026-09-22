/**
 * Contraction-scoped IPO search. RESEARCH ONLY, MEASUREMENT ONLY.
 *
 * WHY THIS EXISTS. Every origin experiment so far has searched a swing-to-break
 * STRUCTURAL LEG. Ezzy does not describe that window anywhere. His transcript is
 * explicit about the order of operations:
 *
 *   "the first thing is to find a contraction zone ... whenever i identify the
 *    contraction phase i try to find something we call ipos"
 *
 * So the contraction is located FIRST and scopes the search. A swing-to-break leg
 * is our substitute for a window he defines differently, and that substitution —
 * not the origin rule — is the most likely source of the disagreements.
 *
 * THE SPLIT THAT KEEPS THIS HONEST. Detectors and descriptors are separate:
 *
 *   DEFINITIONS  locate candidate windows and are PARAMETER-FREE. Each is a
 *                different plain-language reading of "price went nowhere", kept
 *                apart so a wrong one can be discarded rather than blended.
 *   MEASUREMENTS describe a window that has already been located. They return
 *                NUMBERS, never verdicts.
 *
 * NO THRESHOLD IS CHOSEN ANYWHERE IN THIS FILE, and no measurement is combined
 * with another into a score. With two standalone Tier-1 examples, any cutoff
 * would be fitted to n=2 and would look like a discovery. The measurements are
 * reported so a threshold can be argued LATER, from more evidence than this.
 *
 * Nothing here is wired to the detector. Frozen modules are imported, not edited.
 */

import { ipoGeometry, type IPODirection } from "./ipoZones.ts";
import { calculateATR } from "./smcAnalysis.ts";
import type { Candle } from "./smcAnalysis.ts";

export interface ContractionWindow {
  definition: ContractionKey;
  start: number;
  end: number;
  startDatetime: string;
  endDatetime: string;
  bars: number;
  high: number;
  low: number;
}

export type ContractionKey =
  | "OVERLAP_CLUSTER"
  | "INSIDE_FIRST_BAR"
  | "CONTAINED_BY_OPENING_PAIR";

const overlaps = (a: Candle, b: Candle) => a.low <= b.high && a.high >= b.low;

function boundsOf(candles: Candle[], start: number, end: number) {
  let high = -Infinity, low = Infinity;
  for (let k = start; k <= end; k++) {
    if (!candles[k]) continue;
    if (candles[k].high > high) high = candles[k].high;
    if (candles[k].low < low) low = candles[k].low;
  }
  return { high, low };
}

function windowOf(
  candles: Candle[], definition: ContractionKey, start: number, end: number,
): ContractionWindow {
  const { high, low } = boundsOf(candles, start, end);
  return {
    definition, start, end,
    startDatetime: candles[start].datetime,
    endDatetime: candles[end].datetime,
    bars: end - start + 1,
    high, low,
  };
}

/**
 * "Price went nowhere" as consecutive bars that all overlap each other.
 *
 * The same construct finalBaseExit already uses, so a contraction found here is
 * comparable with the base that module reports. Parameter-free apart from the
 * two-bar minimum, which is the smallest thing that can be called a range.
 */
function overlapClusters(candles: Candle[], from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = from;
  for (let k = from; k < to; k++) {
    if (candles[k] && candles[k + 1] && overlaps(candles[k], candles[k + 1])) continue;
    if (k > start) out.push([start, k]);
    start = k + 1;
  }
  if (to > start) out.push([start, to]);
  return out;
}

/**
 * "Price went nowhere" as a run of bars trapped inside one earlier bar.
 *
 * The strictest reading: after the opening bar sets a range, nothing escapes it.
 * Parameter-free — the opening bar supplies the boundary, so no width is chosen.
 */
function insideFirstBarRuns(candles: Candle[], from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = from; i < to; i++) {
    const a = candles[i];
    if (!a) continue;
    let j = i;
    while (j + 1 <= to && candles[j + 1] &&
           candles[j + 1].high <= a.high && candles[j + 1].low >= a.low) j++;
    if (j > i) { out.push([i, j]); i = j; }
  }
  return out;
}

/**
 * "Price went nowhere" as a run whose CLOSES never leave the box set by its
 * first two bars.
 *
 * Between the other two in strictness: wicks may poke out — which is what a
 * boundary test looks like — but no bar may close away. Parameter-free: the
 * opening pair supplies the box.
 */
function containedByOpeningPairRuns(candles: Candle[], from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = from; i + 1 < to; i++) {
    if (!candles[i] || !candles[i + 1]) continue;
    const { high, low } = boundsOf(candles, i, i + 1);
    let j = i + 1;
    while (j + 1 <= to && candles[j + 1] &&
           candles[j + 1].close <= high && candles[j + 1].close >= low) j++;
    if (j - i + 1 >= 3) { out.push([i, j]); i = j; }
  }
  return out;
}

export const CONTRACTION_DEFINITIONS: Array<{
  key: ContractionKey;
  definition: string;
  find(candles: Candle[], from: number, to: number): Array<[number, number]>;
}> = [
  {
    key: "OVERLAP_CLUSTER",
    definition: "Consecutive bars whose ranges all overlap their neighbour. Parameter-free " +
      "apart from the two-bar minimum.",
    find: overlapClusters,
  },
  {
    key: "INSIDE_FIRST_BAR",
    definition: "A run of bars entirely contained inside the high/low of the bar that opens " +
      "the run. Parameter-free — the opening bar supplies the boundary.",
    find: insideFirstBarRuns,
  },
  {
    key: "CONTAINED_BY_OPENING_PAIR",
    definition: "A run of three or more bars whose CLOSES all stay inside the box formed by " +
      "the first two bars. Wicks may poke out; closes may not. Parameter-free.",
    find: containedByOpeningPairRuns,
  },
];

/** Locates every contraction candidate of every definition in a span. */
export function findContractions(
  candles: Candle[], from: number, to: number,
): ContractionWindow[] {
  const lo = Math.max(0, from), hi = Math.min(candles.length - 1, to);
  const out: ContractionWindow[] = [];
  for (const d of CONTRACTION_DEFINITIONS) {
    for (const [a, b] of d.find(candles, lo, hi)) out.push(windowOf(candles, d.key, a, b));
  }
  return out;
}

export interface ContractionMeasures {
  /** |net close travel| / total close travel. Low means price went nowhere. */
  directionalEfficiency: number | null;
  /** Window range divided by ATR as it stood when the window opened. */
  rangeInAtr: number | null;
  /** Mean body inside the window / mean body over the 14 bars before it. */
  bodyCompression: number | null;
  /** Bars whose high sits in the top tenth of the window's range. */
  upperBoundaryTests: number;
  /** Bars whose low sits in the bottom tenth. */
  lowerBoundaryTests: number;
  /**
   * RAW COUNTS — UNSUITABLE FOR CROSS-WINDOW COMPARISON. They scale with window
   * length: the same market behaviour scored 8 on a 10-bar box and 37 on a
   * 62-bar box. Retained only because a same-length neighbour comparison is
   * unaffected by the scaling. Use equalLevelDensity anywhere windows differ in
   * length.
   */
  equalHighs: number;
  equalLows: number;
  /**
   * (equalHighs + equalLows) / bars. THE COMPARABLE FORM, and the one the
   * level-repetition family is defined on. Measured 0.46–0.80 across the six
   * Ezzy-marked contractions.
   */
  equalLevelDensity: number | null;
  /** Fraction of bars overlapping the bar before them. */
  overlapFraction: number | null;
}

/**
 * Describes a window that has ALREADY been located. Returns numbers only.
 *
 * The tenth-of-range and tenth-of-ATR spans used by the boundary and equality
 * counts are reporting resolutions, not decision thresholds: nothing in this
 * file branches on them, and no verdict is derived from them here.
 */
export function measureContraction(
  candles: Candle[], start: number, end: number,
): ContractionMeasures {
  const n = end - start + 1;
  const { high, low } = boundsOf(candles, start, end);
  const range = high - low;

  let travel = 0;
  for (let k = start + 1; k <= end; k++) travel += Math.abs(candles[k].close - candles[k - 1].close);
  const net = Math.abs(candles[end].close - candles[start].close);

  const atr = calculateATR(candles.slice(0, start + 1), 14) || null;

  let bodySum = 0;
  for (let k = start; k <= end; k++) bodySum += Math.abs(candles[k].close - candles[k].open);
  let priorBody = 0, priorN = 0;
  for (let k = Math.max(0, start - 14); k < start; k++) {
    if (!candles[k]) continue;
    priorBody += Math.abs(candles[k].close - candles[k].open); priorN++;
  }

  const band = range * 0.1;
  let upper = 0, lower = 0;
  for (let k = start; k <= end; k++) {
    if (candles[k].high >= high - band) upper++;
    if (candles[k].low <= low + band) lower++;
  }

  const tol = atr ? atr * 0.1 : range * 0.02;
  const cluster = (vals: number[]) => {
    let best = 0;
    for (const v of vals) {
      const c = vals.filter((w) => Math.abs(w - v) <= tol).length;
      if (c > best) best = c;
    }
    return best;
  };
  const highs: number[] = [], lows: number[] = [];
  for (let k = start; k <= end; k++) { highs.push(candles[k].high); lows.push(candles[k].low); }

  let ov = 0;
  for (let k = start + 1; k <= end; k++) if (overlaps(candles[k - 1], candles[k])) ov++;

  return {
    directionalEfficiency: travel > 0 ? net / travel : null,
    equalLevelDensity: n > 0 ? (cluster(highs) + cluster(lows)) / n : null,
    rangeInAtr: atr ? range / atr : null,
    bodyCompression: priorN > 0 && priorBody > 0 ? (bodySum / n) / (priorBody / priorN) : null,
    upperBoundaryTests: upper,
    lowerBoundaryTests: lower,
    equalHighs: cluster(highs),
    equalLows: cluster(lows),
    overlapFraction: n > 1 ? ov / (n - 1) : null,
  };
}

/** Where a demonstrated IPO sits relative to a contraction window. */
export type IPOPosition =
  | "BEFORE_CONTRACTION"
  | "AT_START_BOUNDARY"
  | "INSIDE_CONTRACTION"
  | "AT_END_BOUNDARY"
  | "IMMEDIATELY_AFTER"
  | "AFTER_CONTRACTION";

export function positionOfIPO(ipo: number, w: ContractionWindow): IPOPosition {
  if (ipo < w.start) return "BEFORE_CONTRACTION";
  if (ipo === w.start) return "AT_START_BOUNDARY";
  if (ipo === w.end) return "AT_END_BOUNDARY";
  if (ipo < w.end) return "INSIDE_CONTRACTION";
  if (ipo === w.end + 1) return "IMMEDIATELY_AFTER";
  return "AFTER_CONTRACTION";
}

/**
 * Does price come back into the IPO's zone after the contraction ends?
 *
 * This is the measurable half of "the contraction expands to the ipo". It says
 * only whether the revisit happened and when — not whether it was the reason for
 * anything, which the chart cannot tell us.
 */
export function revisitOfIPO(
  candles: Candle[], ipo: number, direction: IPODirection, contractionEnd: number, until: number,
): { revisited: boolean; firstRevisitIndex: number | null; barsAfterContraction: number | null } {
  const g = ipoGeometry(candles[ipo], direction);
  for (let k = contractionEnd + 1; k <= Math.min(until, candles.length - 1); k++) {
    const c = candles[k];
    if (c && c.low <= g.zoneHigh && c.high >= g.zoneLow) {
      return { revisited: true, firstRevisitIndex: k, barsAfterContraction: k - contractionEnd };
    }
  }
  return { revisited: false, firstRevisitIndex: null, barsAfterContraction: null };
}

// ─── degeneracy of the adjacent-overlap base construct ───────────────────────

/**
 * Fraction of adjacent bar pairs whose ranges overlap.
 *
 * WHY THIS IS A PUBLISHED NUMBER. finalBaseExit, permanentBaseExit and
 * describeMove all locate "the last base" as a run of consecutive overlapping
 * bars. On BTC daily and 4H this measures 100%, so the "base" swallows the whole
 * leg and the first close outside it IS the break bar. Measured on the four
 * Tier-1 Ezzy legs, FINAL_BASE_EXIT and PERMANENT_BASE_EXIT returned the break
 * bar every time, and their stepped-back origin was identical to
 * LAST_OPPOSITE_BEFORE_BREAK on 4 of 4 — they are not independent definitions
 * on this data, and counting them separately double-counts one rule.
 */
export function adjacentOverlapFraction(
  candles: Candle[], from: number, to: number,
): number | null {
  let pairs = 0, ov = 0;
  for (let k = Math.max(1, from + 1); k <= to; k++) {
    if (!candles[k] || !candles[k - 1]) continue;
    pairs++;
    if (overlaps(candles[k - 1], candles[k])) ov++;
  }
  return pairs > 0 ? ov / pairs : null;
}

/**
 * True when the overlap construct cannot separate anything in this span.
 *
 * Deliberately a measurement of THIS series, not a blanket verdict: the
 * construct may be perfectly serviceable on a market whose bars gap.
 */
export function baseConstructIsDegenerate(
  candles: Candle[], from: number, to: number,
): { degenerate: boolean; adjacentOverlapFraction: number | null; note: string } {
  const f = adjacentOverlapFraction(candles, from, to);
  const degenerate = f !== null && f >= 1;
  return {
    degenerate,
    adjacentOverlapFraction: f,
    note: degenerate
      ? "DEGENERATE_FOR_RESEARCH — every adjacent bar pair overlaps, so the " +
        "overlap-cluster base spans the whole window and its exit is the break " +
        "bar. Any onset or origin derived from it duplicates " +
        "LAST_OPPOSITE_BEFORE_BREAK and must not be counted as separate evidence."
      : "Overlap construct separates at least one cluster boundary in this window.",
  };
}

/** Research definitions that rest on the construct above. */
export const DEGENERATE_BASE_DEPENDENTS = [
  "FINAL_BASE_EXIT",
  "PERMANENT_BASE_EXIT",
  "MoveAnatomy.base",
  "MoveAnatomy.firstBaseExitIndex",
  "MoveAnatomy.permanentExitFromReportedBase",
  "MoveAnatomy.permanentBaseExitAnyCluster",
] as const;


// ─── frozen candidate families ───────────────────────────────────────────────

/**
 * The three families that survived 12/12 sign consistency against same-length
 * neighbours across BTC/USD 1h, USD/JPY 1h and GBP/USD 30m.
 *
 * FROZEN. No family is added unless existing evidence forces it, and NO
 * THRESHOLD IS CHOSEN HERE. `naturalBoundary` records only where a
 * definition supplies its own dividing line — it is not a fitted cutoff and
 * nothing in this file compares against it.
 */
export const CONTRACTION_FAMILIES = [
  {
    key: "BODY_COMPRESSION",
    measure: "bodyCompression",
    direction: "LOWER_INSIDE_CONTRACTION",
    observedRange: [0.39, 0.88] as const,
    naturalBoundary:
      "1.0 means bodies the same size as the preceding 14 bars. Not fitted — it " +
      "falls out of the definition. All six marked boxes sit below it; 9 of 12 " +
      "neighbours sit above it.",
  },
  {
    key: "VOLATILITY_COMPRESSION",
    measure: "rangeInAtr",
    direction: "LOWER_INSIDE_CONTRACTION",
    observedRange: [1.88, 5.21] as const,
    naturalBoundary:
      "NONE. Neighbours span 3.57–26.49 and overlap the marked band at the low " +
      "end, so any cutoff would be fitted to this sample.",
  },
  {
    key: "LEVEL_REPETITION",
    measure: "equalLevelDensity",
    direction: "HIGHER_INSIDE_CONTRACTION",
    observedRange: [0.46, 0.80] as const,
    naturalBoundary: "NONE yet.",
  },
] as const;

/**
 * Measured and REJECTED as family candidates. Listed so they are not retried
 * as though untested.
 */
export const EXCLUDED_FROM_FAMILIES = [
  { measure: "overlapFraction", why: "saturated at 1.0 on every real series tested — degenerate at 1h, 4h, 30m and 1d" },
  { measure: "directionalEfficiency", why: "mixed 5 higher / 7 lower across 12 comparisons, despite being the intuitive favourite" },
  { measure: "boundaryTests", why: "mixed 4 higher / 6 lower / 2 equal" },
  { measure: "upperLowerSkew", why: "mixed 6 higher / 5 lower / 1 equal — added speculatively on the idea that a contraction leans on one boundary, and it does not" },
  { measure: "manipulationSweepCount", why: "DEGENERATE BY CONSTRUCTION — the bar that sets a boundary satisfies 'touches it and closes inside', so 2 is the floor, not a signal" },
] as const;
