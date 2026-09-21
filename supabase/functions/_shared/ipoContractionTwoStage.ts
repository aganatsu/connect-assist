/**
 * Two-stage contraction model. RESEARCH ONLY.
 *
 *   STRUCTURE_STALL -> SIDEWAYS_CONFIRMATION -> CONTRACTION_BOX -> EXPANSION_EXIT
 *
 * WHY TWO STAGES. The seed study showed a structural stall locates all 13 marked
 * starts but sits a median 15 bars EARLY, and the bias is systematic rather than
 * noisy. That is not an error to be corrected — it says the stall and the box
 * start are different events. Ezzy draws the box once sideways behaviour is
 * established; the stall is when it became possible.
 *
 * WHY EFFICIENCY, AS A TRANSITION. Directional efficiency was frozen out as a
 * whole-window discriminator (mixed 5/7 against neighbours) and is NOT
 * reinstated in that role. It enters here as a different question, which is the
 * one EG-2 forced: not "is this window less directional than its neighbour" but
 * "did directionality COLLAPSE after the stall". EG-2 measures 0.01 inside
 * against 0.38 before while failing body, range and repetition outright.
 *
 * NO FITTED CONSTANT. Every comparison is against the same series' own pre-stall
 * value. The only numbers are the inherited 14-bar horizon and the 2-bar
 * minimum, already declared in DETECTOR_INHERITED_CONSTANTS. Body compression is
 * reported and never required.
 */

import { measureContraction } from "./ipoContraction.ts";
import { DETECTOR_INHERITED_CONSTANTS, activeContextIndices } from "./ipoContractionDetector.ts";
import { structureStalls, volatilityFallingAt, bodyCompressionAt } from "./ipoContractionSeeds.ts";
import { confirmedSwings } from "./ipoZones.ts";
import type { Candle } from "./smcAnalysis.ts";

const CTX = DETECTOR_INHERITED_CONSTANTS.contextBars.value;
const MIN = DETECTOR_INHERITED_CONSTANTS.minWindowBars.value;

export type SeedFamily = "E1_STRUCTURE_STALL" | "E5_STALL_PLUS_VOLATILITY";
export type SidewaysKey = "W1_EFFICIENCY_COLLAPSE" | "W2_ALTERNATION_RISE" | "W3_PROGRESSION_CEASED_BOUNDED";
export type StartKey = "S_AFTER_STALL" | "S_CONFIRMED_SIDEWAYS" | "S_FIRST_REPEATED_LEVEL" | "S_CONTAINING_RANGE";
export type ExitKey = "X_CLOSE_OUTSIDE" | "X_RENEWED_STRUCTURE" | "X_BODY_EXPANSION";

export const SIDEWAYS_KEYS: SidewaysKey[] = [
  "W1_EFFICIENCY_COLLAPSE", "W2_ALTERNATION_RISE", "W3_PROGRESSION_CEASED_BOUNDED",
];
export const START_KEYS: StartKey[] = [
  "S_AFTER_STALL", "S_CONFIRMED_SIDEWAYS", "S_FIRST_REPEATED_LEVEL", "S_CONTAINING_RANGE",
];
export const EXIT_KEYS: ExitKey[] = ["X_CLOSE_OUTSIDE", "X_RENEWED_STRUCTURE", "X_BODY_EXPANSION"];

/** |net close travel| / total close travel over [a,b]. */
function efficiency(candles: Candle[], a: number, b: number): number | null {
  if (b <= a) return null;
  let travel = 0;
  for (let k = a + 1; k <= b; k++) travel += Math.abs(candles[k].close - candles[k - 1].close);
  if (travel === 0) return null;
  return Math.abs(candles[b].close - candles[a].close) / travel;
}

/** Fraction of bars that reverse the previous bar's close direction. */
function alternation(candles: Candle[], a: number, b: number): number | null {
  let flips = 0, n = 0;
  for (let k = a + 2; k <= b; k++) {
    const d1 = Math.sign(candles[k].close - candles[k - 1].close);
    const d0 = Math.sign(candles[k - 1].close - candles[k - 2].close);
    if (d1 !== 0 && d0 !== 0) { n++; if (d1 !== d0) flips++; }
  }
  return n ? flips / n : null;
}

function rangePerBar(candles: Candle[], a: number, b: number): number | null {
  if (b < a) return null;
  let hi = -Infinity, lo = Infinity;
  for (let k = a; k <= b; k++) { hi = Math.max(hi, candles[k].high); lo = Math.min(lo, candles[k].low); }
  return (hi - lo) / (b - a + 1);
}

/** The active bars immediately before the stall, used as every "before" value. */
function preStallSpan(candles: Candle[], seed: number): [number, number] | null {
  const idx = activeContextIndices(candles, seed);
  if (idx.length < MIN + 1) return null;
  return [idx[0], idx[idx.length - 1]];
}

export interface SidewaysConfirmation {
  confirmed: boolean;
  /** First bar at which the sideways state holds. */
  atIndex: number | null;
  beforeValue: number | null;
  afterValue: number | null;
}

/**
 * Does the sideways state establish itself within the inherited horizon after a
 * stall? Each definition compares the post-stall value to the SAME SERIES' own
 * pre-stall value — never to a constant and never to a neighbour window.
 */
export function confirmSideways(
  candles: Candle[], seed: number, key: SidewaysKey,
): SidewaysConfirmation {
  const pre = preStallSpan(candles, seed);
  const miss: SidewaysConfirmation = { confirmed: false, atIndex: null, beforeValue: null, afterValue: null };
  if (!pre) return miss;
  const [pa, pb] = pre;

  if (key === "W1_EFFICIENCY_COLLAPSE") {
    const before = efficiency(candles, pa, pb);
    if (before === null) return miss;
    for (let b = seed + MIN; b <= Math.min(seed + CTX, candles.length - 1); b++) {
      const after = efficiency(candles, seed, b);
      if (after !== null && after < before) {
        return { confirmed: true, atIndex: b, beforeValue: before, afterValue: after };
      }
    }
    return { ...miss, beforeValue: before };
  }

  if (key === "W2_ALTERNATION_RISE") {
    const before = alternation(candles, pa, pb);
    if (before === null) return miss;
    for (let b = seed + MIN + 1; b <= Math.min(seed + CTX, candles.length - 1); b++) {
      const after = alternation(candles, seed, b);
      if (after !== null && after > before) {
        return { confirmed: true, atIndex: b, beforeValue: before, afterValue: after };
      }
    }
    return { ...miss, beforeValue: before };
  }

  // W3: no swing since the stall extends the prior progression, AND the range
  // is growing more slowly than it did before the stall.
  const before = rangePerBar(candles, pa, pb);
  if (before === null) return miss;
  const sw = confirmedSwings(candles).internal.slice().sort((x, y) => x.index - y.index);
  for (let b = seed + MIN; b <= Math.min(seed + CTX, candles.length - 1); b++) {
    const after = rangePerBar(candles, seed, b);
    if (after === null || !(after < before)) continue;
    // Any confirmed swing in (seed, b] that pushes beyond the stall's extremes
    // means structure resumed, so the state is not sideways.
    let hi = -Infinity, lo = Infinity;
    for (let k = seed; k <= b; k++) { hi = Math.max(hi, candles[k].high); lo = Math.min(lo, candles[k].low); }
    const resumed = sw.some((s) => s.index > seed && s.index <= b &&
      (s.type === "high" ? s.price >= hi : s.price <= lo));
    if (!resumed) return { confirmed: true, atIndex: b, beforeValue: before, afterValue: after };
  }
  return { ...miss, beforeValue: before };
}

/** First bar after `seed` whose high or low repeats an earlier extreme. */
function firstRepeatedLevel(candles: Candle[], seed: number, limit: number): number | null {
  const m = measureContraction(candles, Math.max(0, seed - CTX), seed);
  const atr = m.rangeInAtr && m.rangeInAtr > 0
    ? (Math.max(...candles.slice(Math.max(0, seed - CTX), seed + 1).map((c) => c.high)) -
       Math.min(...candles.slice(Math.max(0, seed - CTX), seed + 1).map((c) => c.low))) / m.rangeInAtr
    : null;
  if (!atr) return null;
  const tol = atr * 0.1;      // the reporting resolution already used by measureContraction
  for (let b = seed + 1; b <= limit; b++) {
    for (let k = seed; k < b; k++) {
      if (Math.abs(candles[b].high - candles[k].high) <= tol) return b;
      if (Math.abs(candles[b].low - candles[k].low) <= tol) return b;
    }
  }
  return null;
}

export interface TwoStageWindow {
  seedIndex: number;
  sidewaysAtIndex: number;
  start: number;
  end: number;
  bars: number;
  startDatetime: string;
  endDatetime: string;
  exitBy: ExitKey | "SERIES_END";
  /** Reported, never required. */
  bodyCompression: number | null;
  efficiencyBefore: number | null;
  efficiencyInside: number | null;
}

export interface TwoStageOptions {
  seedFamily?: SeedFamily;
  sideways?: SidewaysKey;
  start?: StartKey;
  exit?: ExitKey;
}

/**
 * Grows the box by PRICE CONTAINMENT, not body size.
 *
 * The range is fixed by the confirmed sideways segment and is NOT widened as the
 * box extends, so the window cannot drift upward with price — the failure that
 * made the rolling continuation rules swallow whole charts. Wicks may pierce the
 * range (that is a boundary test); closes may not. No allowance for "one or two
 * breakout bars" exists, because that would be a free parameter.
 */
function growBox(
  candles: Candle[], start: number, confirmedAt: number, to: number, exit: ExitKey,
): { end: number; exitBy: ExitKey | "SERIES_END" } {
  let hi = -Infinity, lo = Infinity;
  for (let k = start; k <= confirmedAt; k++) { hi = Math.max(hi, candles[k].high); lo = Math.min(lo, candles[k].low); }
  let insideBodySum = 0, insideN = 0;
  for (let k = start; k <= confirmedAt; k++) { insideBodySum += Math.abs(candles[k].close - candles[k].open); insideN++; }
  const sw = confirmedSwings(candles).internal;

  for (let b = confirmedAt + 1; b <= to; b++) {
    const c = candles[b];
    if (!c) break;
    let out = false;
    if (exit === "X_CLOSE_OUTSIDE") {
      out = c.close > hi || c.close < lo;
    } else if (exit === "X_BODY_EXPANSION") {
      const meanInside = insideN ? insideBodySum / insideN : 0;
      out = (c.close > hi || c.close < lo) && Math.abs(c.close - c.open) > meanInside;
    } else {
      // Renewed directional structure: a confirmed swing at or beyond the range.
      out = sw.some((s) => s.index === b && (s.type === "high" ? s.price >= hi : s.price <= lo));
    }
    if (out) return { end: b - 1, exitBy: exit };
    insideBodySum += Math.abs(c.close - c.open); insideN++;
  }
  return { end: to, exitBy: "SERIES_END" };
}

export function twoStageContractions(
  candles: Candle[], opts: TwoStageOptions = {},
): TwoStageWindow[] {
  const seedFamily = opts.seedFamily ?? "E1_STRUCTURE_STALL";
  const sideways = opts.sideways ?? "W1_EFFICIENCY_COLLAPSE";
  const startKey = opts.start ?? "S_CONFIRMED_SIDEWAYS";
  const exit = opts.exit ?? "X_CLOSE_OUTSIDE";
  const last = candles.length - 1;

  const stalls = structureStalls(candles).filter((s) =>
    seedFamily === "E1_STRUCTURE_STALL" ? true : volatilityFallingAt(candles, s.index) === true);

  const out: TwoStageWindow[] = [];
  for (const s of stalls) {
    const conf = confirmSideways(candles, s.index, sideways);
    if (!conf.confirmed || conf.atIndex === null) continue;
    let start: number | null;
    switch (startKey) {
      case "S_AFTER_STALL": start = s.index + 1; break;
      case "S_CONFIRMED_SIDEWAYS": start = conf.atIndex; break;
      case "S_FIRST_REPEATED_LEVEL": start = firstRepeatedLevel(candles, s.index, conf.atIndex); break;
      case "S_CONTAINING_RANGE": {
        // Earliest bar after the stall that already sits inside the confirmed
        // segment's range — the first bar the eventual box would have contained.
        let hi = -Infinity, lo = Infinity;
        for (let k = s.index; k <= conf.atIndex; k++) { hi = Math.max(hi, candles[k].high); lo = Math.min(lo, candles[k].low); }
        start = null;
        for (let k = s.index + 1; k <= conf.atIndex; k++) {
          if (candles[k].high <= hi && candles[k].low >= lo) { start = k; break; }
        }
        break;
      }
    }
    if (start === null || start > conf.atIndex) start = conf.atIndex;
    const { end, exitBy } = growBox(candles, start, conf.atIndex, last, exit);
    if (end - start + 1 < MIN) continue;
    out.push({
      seedIndex: s.index, sidewaysAtIndex: conf.atIndex,
      start, end, bars: end - start + 1,
      startDatetime: candles[start].datetime, endDatetime: candles[end].datetime,
      exitBy,
      bodyCompression: bodyCompressionAt(candles, start),
      efficiencyBefore: conf.beforeValue, efficiencyInside: efficiency(candles, start, end),
    });
  }
  // Drop windows fully contained in another.
  return out.filter((w, i) => !out.some((v, j) => j !== i && w.start >= v.start && w.end <= v.end));
}
