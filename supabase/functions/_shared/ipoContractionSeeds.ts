/**
 * Contraction ENTRY (seed) detection. RESEARCH ONLY. No windows are built here.
 *
 * WHY ENTRY IS NOW THE SUBJECT. Four structurally different continuation rules
 * were benchmarked and all failed the same way — either fragment or swallow the
 * chart. The common cause is upstream: body compression fires on roughly 60% of
 * bars, so discovery starts from far too many seeds and continuation only ever
 * decides how to glue noise together. Body compression is therefore DEMOTED here
 * to a reported descriptor. It is not required by any seed family.
 *
 * WHAT REPLACES IT. Ezzy's taught sequence, in his own order:
 *
 *   "initially we was kind of doing the higher highs and higher lows, and then
 *    we stopped. The moment we stop, we enter in a contraction mode"   (07:15)
 *   "equal highs and equal lows inside of this contraction"            (07:15)
 *   "low volume ... more like a sideway move"                          (17:34)
 *
 * So the entry event is a STRUCTURAL STALL, with level repetition and volatility
 * compression as corroborating states. That is the opposite of what the detector
 * has been doing, which led with a candle-size statistic he never mentions.
 *
 * EVERY SEED IS AN EDGE, NOT A STATE. A condition that is merely true for long
 * stretches is what produced the 60% base rate. Each family fires only where the
 * condition BECOMES true having been false.
 *
 * NO FITTED THRESHOLD. E1 reuses confirmedSwings, whose lookbacks and ATR
 * filters are existing project constants. E2 and E3 are strictly relative:
 * trailing active window against the active window before it, no cutoff. Volume
 * is never gated on, because TwelveData returns zero for FX.
 */

import { confirmedSwings } from "./ipoZones.ts";
import { measureContraction } from "./ipoContraction.ts";
import { activeContextIndices, DETECTOR_INHERITED_CONSTANTS } from "./ipoContractionDetector.ts";
import type { Candle } from "./smcAnalysis.ts";

export type SeedKey =
  | "E1_STRUCTURE_STALL"
  | "E2_LEVEL_REPETITION_TRANSITION"
  | "E3_VOLATILITY_COMPRESSION_TRANSITION"
  | "E4_STALL_PLUS_REPETITION"
  | "E5_STALL_PLUS_VOLATILITY"
  | "E6_ALL_THREE";

export const SEED_KEYS: SeedKey[] = [
  "E1_STRUCTURE_STALL",
  "E2_LEVEL_REPETITION_TRANSITION",
  "E3_VOLATILITY_COMPRESSION_TRANSITION",
  "E4_STALL_PLUS_REPETITION",
  "E5_STALL_PLUS_VOLATILITY",
  "E6_ALL_THREE",
];

export interface Seed {
  family: SeedKey;
  /** Bar where the entry event sits. */
  index: number;
  datetime: string;
  /**
   * Bar at which the event could first have been KNOWN. For a structural stall
   * this lags by the swing lookback; reported so the causal cost is visible
   * rather than hidden by using the swing's own index.
   */
  knownAtIndex: number;
  /** Reported for every family. Required by none. */
  bodyCompression: number | null;
  repetitionRising: boolean | null;
  volatilityFalling: boolean | null;
  /** Which progression was running before the stall. */
  priorProgression: "UP" | "DOWN" | null;
}

/** Two consecutive active windows of the inherited length, ending before `a`. */
function activePair(candles: Candle[], a: number): { recent: number[]; prior: number[] } | null {
  const CTX = DETECTOR_INHERITED_CONSTANTS.contextBars.value;
  const recent = activeContextIndices(candles, a);
  if (recent.length < CTX) return null;
  const prior = activeContextIndices(candles, recent[0]);
  if (prior.length < CTX) return null;
  return { recent, prior };
}

function spanMeasure(candles: Candle[], idx: number[]) {
  return measureContraction(candles, idx[0], idx[idx.length - 1]);
}

/** Level repetition higher than the comparable window before it. Relative only. */
export function repetitionRisingAt(candles: Candle[], a: number): boolean | null {
  const p = activePair(candles, a);
  if (!p) return null;
  const r = spanMeasure(candles, p.recent).equalLevelDensity;
  const q = spanMeasure(candles, p.prior).equalLevelDensity;
  return r === null || q === null ? null : r > q;
}

/** Range/ATR lower than the comparable window before it. Relative only. */
export function volatilityFallingAt(candles: Candle[], a: number): boolean | null {
  const p = activePair(candles, a);
  if (!p) return null;
  const r = spanMeasure(candles, p.recent).rangeInAtr;
  const q = spanMeasure(candles, p.prior).rangeInAtr;
  return r === null || q === null ? null : r < q;
}

/** Body compression against the session-aware context. Descriptive only. */
export function bodyCompressionAt(candles: Candle[], a: number): number | null {
  const idx = activeContextIndices(candles, a);
  if (!idx.length) return null;
  let s = 0;
  for (const i of idx) s += Math.abs(candles[i].close - candles[i].open);
  const base = s / idx.length;
  return base > 0 ? Math.abs(candles[a].close - candles[a].open) / base : null;
}

/**
 * E1. The bar where an established directional progression stops extending.
 *
 * OPERATIONALISED ENTIRELY FROM EXISTING PRIMITIVES. `confirmedSwings` supplies
 * the alternating swing sequence; its lookback and ATR filter are project
 * constants that predate this work and nothing here adds to them.
 *
 *   1. Walk the confirmed swings in order.
 *   2. An UP progression is running once the sequence has produced both a higher
 *      high and a higher low relative to the previous same-type swing. DOWN is
 *      the mirror.
 *   3. The progression STOPS at the first swing that fails to extend it — a high
 *      that is not higher than the last high, or a low that is not lower than
 *      the last low. That swing's bar is the seed.
 *   4. The progression must then re-establish before another stall can fire, so
 *      one stall is reported per progression rather than one per swing.
 *
 * "Stops" therefore means "the next structural point did not continue the
 * sequence", which is the plainest reading of "and then we stopped".
 */
export function structureStalls(
  candles: Candle[], which: "internal" | "external" = "internal",
): Array<{ index: number; knownAtIndex: number; prior: "UP" | "DOWN" }> {
  const sw = confirmedSwings(candles)[which]
    .slice()
    .sort((a, b) => a.index - b.index);
  const out: Array<{ index: number; knownAtIndex: number; prior: "UP" | "DOWN" }> = [];
  let lastHigh: number | null = null, lastLow: number | null = null;
  let hh = false, hl = false, ll = false, lh = false;
  let running: "UP" | "DOWN" | null = null;

  for (const s of sw) {
    if (s.type === "high") {
      if (lastHigh !== null) {
        if (s.price > lastHigh) { hh = true; lh = false; }
        else { lh = true; hh = false; }
      }
    } else {
      if (lastLow !== null) {
        if (s.price < lastLow) { ll = true; hl = false; }
        else { hl = true; ll = false; }
      }
    }
    const wasRunning = running;
    if (hh && hl) running = "UP";
    else if (ll && lh) running = "DOWN";

    // A stall is the first swing that breaks a progression that WAS running.
    if (wasRunning === "UP" && !(hh && hl)) {
      out.push({ index: s.index, knownAtIndex: s.confirmedAt, prior: "UP" });
      running = null; hh = hl = ll = lh = false;
    } else if (wasRunning === "DOWN" && !(ll && lh)) {
      out.push({ index: s.index, knownAtIndex: s.confirmedAt, prior: "DOWN" });
      running = null; hh = hl = ll = lh = false;
    }
    if (s.type === "high") lastHigh = s.price; else lastLow = s.price;
  }
  return out;
}

/** Rising edges of a per-bar predicate: fires only where false -> true. */
function risingEdges(candles: Candle[], pred: (i: number) => boolean | null): number[] {
  const out: number[] = [];
  let prev: boolean | null = null;
  for (let i = 0; i < candles.length; i++) {
    const v = pred(i);
    if (v === true && prev === false) out.push(i);
    if (v !== null) prev = v;
  }
  return out;
}

/** All six families. Body compression is attached to every seed, gates none. */
export function findSeeds(
  candles: Candle[], which: "internal" | "external" = "internal",
): Seed[] {
  const stalls = structureStalls(candles, which);
  const repEdges = new Set(risingEdges(candles, (i) => repetitionRisingAt(candles, i)));
  const volEdges = new Set(risingEdges(candles, (i) => volatilityFallingAt(candles, i)));

  const mk = (family: SeedKey, index: number, knownAtIndex: number, prior: "UP" | "DOWN" | null): Seed => ({
    family, index, datetime: candles[index].datetime, knownAtIndex,
    bodyCompression: bodyCompressionAt(candles, index),
    repetitionRising: repetitionRisingAt(candles, index),
    volatilityFalling: volatilityFallingAt(candles, index),
    priorProgression: prior,
  });

  const out: Seed[] = [];
  for (const s of stalls) out.push(mk("E1_STRUCTURE_STALL", s.index, s.knownAtIndex, s.prior));
  for (const i of repEdges) out.push(mk("E2_LEVEL_REPETITION_TRANSITION", i, i, null));
  for (const i of volEdges) out.push(mk("E3_VOLATILITY_COMPRESSION_TRANSITION", i, i, null));
  // Combinations use the stall for LOCATION and the other states as corroboration
  // at that bar, so a combined seed is never more numerous than E1.
  for (const s of stalls) {
    const rep = repetitionRisingAt(candles, s.index) === true;
    const vol = volatilityFallingAt(candles, s.index) === true;
    if (rep) out.push(mk("E4_STALL_PLUS_REPETITION", s.index, s.knownAtIndex, s.prior));
    if (vol) out.push(mk("E5_STALL_PLUS_VOLATILITY", s.index, s.knownAtIndex, s.prior));
    if (rep && vol) out.push(mk("E6_ALL_THREE", s.index, s.knownAtIndex, s.prior));
  }
  return out.sort((a, b) => a.index - b.index);
}

export const seedsFor = (all: Seed[], k: SeedKey) => all.filter((s) => s.family === k);
