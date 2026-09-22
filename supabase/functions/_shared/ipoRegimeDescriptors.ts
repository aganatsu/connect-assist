/**
 * Market-state regime descriptors. RESEARCH ONLY, DESCRIPTIVE ONLY.
 *
 * PURPOSE. A1 failed its pre-registered validation because of BTC in one
 * strongly trending quarter. This labels market state so that result can be
 * read conditionally. It is NOT a filter and must not become one in this pass.
 *
 * NO FITTED CUTOFFS, AND NONE FROM THE FAILED PERIOD. Two facts are measured:
 *
 *   TREND STRENGTH — path efficiency |net move| / summed bar-to-bar travel,
 *   the SAME formula the frozen S2 contraction exit uses, measured over the
 *   current structural leg (from the most recent confirmed EXTERNAL swing).
 *   The leg boundary is structural, so no lookback length is chosen.
 *
 *   VOLATILITY — `calculateATR` at period 14 (`DEFAULTS.slATRPeriod`) divided
 *   by price, so it is comparable across instruments and price levels.
 *
 * Both are bucketed by DISTRIBUTIONAL THIRDS of the same instrument's own
 * observations. A third is not a tuned parameter: it is the same division for
 * every instrument and every regime, it encodes no view about where a boundary
 * should fall, and no outcome was consulted to place it. Nothing from the failed
 * 2023 BTC quarter enters any reference distribution.
 *
 * KNOWN LIMITATION, STATED NOT HIDDEN. Thirds are relative to the reference
 * distribution supplied. If that reference covers only trending data, its bottom
 * third is "least trending", not "ranging". Pass a reference spanning the
 * instrument's bull, bear and range periods, and read the absolute per-period
 * numbers alongside the labels.
 *
 * Nothing here is wired to production.
 */

import { calculateATR, type Candle } from "./smcAnalysis.ts";
import { confirmedSwings } from "./ipoZones.ts";

export type TrendBucket = "STRONG" | "WEAK" | "RANGING" | "UNCLASSIFIED";
export type VolBucket = "HIGH_VOL" | "MID_VOL" | "LOW_VOL" | "UNCLASSIFIED";
export type Direction = "BULL" | "BEAR" | null;

export type RegimeLabel =
  | "STRONG_BULL" | "STRONG_BEAR"
  | "WEAK_BULL" | "WEAK_BEAR"
  | "RANGING"
  | "UNCLASSIFIED";

export const REGIME_LABELS: RegimeLabel[] = [
  "STRONG_BULL", "STRONG_BEAR", "WEAK_BULL", "WEAK_BEAR", "RANGING", "UNCLASSIFIED",
];

export interface Regime {
  trend: TrendBucket;
  direction: Direction;
  vol: VolBucket;
  label: RegimeLabel;
  efficiency: number | null;
  atrPct: number | null;
  legStart: number | null;
}

/** ATR period is taken from the production default rather than chosen here. */
export const ATR_PERIOD = 14;

/**
 * Path efficiency over [a, b]. Identical in form to the measure the frozen S2
 * contraction exit uses; duplicated rather than imported because that one is
 * module-private, and a test pins the formula so the two cannot drift.
 */
export function efficiency(s: Candle[], a: number, b: number): number | null {
  if (b <= a) return null;
  let path = 0;
  for (let k = a + 1; k <= b; k++) path += Math.abs(s[k].close - s[k - 1].close);
  return path > 0 ? Math.abs(s[b].close - s[a].close) / path : null;
}

/**
 * Per-bar raw measurements for a whole series.
 *
 * `legStart` is the most recent EXTERNAL swing already CONFIRMED before the bar,
 * so the leg is knowable at the time. Bars before any confirmed external swing
 * have no leg and stay unmeasured.
 */
export function measureSeries(s: Candle[]): Array<{ efficiency: number | null; atrPct: number | null; legStart: number | null }> {
  const ext = confirmedSwings(s).external.slice().sort((a, b) => a.confirmedAt - b.confirmedAt);
  const out: Array<{ efficiency: number | null; atrPct: number | null; legStart: number | null }> = [];
  let ptr = 0, legStart: number | null = null;
  for (let k = 0; k < s.length; k++) {
    while (ptr < ext.length && ext[ptr].confirmedAt < k) { legStart = ext[ptr].index; ptr++; }
    const eff = legStart !== null ? efficiency(s, legStart, k) : null;
    const atr = k >= ATR_PERIOD ? calculateATR(s.slice(0, k + 1), ATR_PERIOD) : 0;
    out.push({
      efficiency: eff,
      atrPct: atr > 0 && s[k].close > 0 ? atr / s[k].close : null,
      legStart,
    });
  }
  return out;
}

/** Fraction of `sorted` strictly below `v`. Plain rank, no interpolation. */
export function percentileOf(sorted: number[], v: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
  return sorted.length ? lo / sorted.length : 0;
}

/** Reference distributions the thirds are taken against. */
export interface Reference { efficiency: number[]; atrPct: number[] }

export function buildReference(
  measures: Array<{ efficiency: number | null; atrPct: number | null }>,
): Reference {
  const num = (xs: Array<number | null>) =>
    xs.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  return {
    efficiency: num(measures.map((m) => m.efficiency)),
    atrPct: num(measures.map((m) => m.atrPct)),
  };
}

/** The only boundaries in this module: the two distributional thirds. */
const LOWER_THIRD = 1 / 3;
const UPPER_THIRD = 2 / 3;

/** Minimum reference observations before a bucket is claimed at all. */
export const MIN_REFERENCE = 200;

export function classify(
  s: Candle[],
  k: number,
  m: { efficiency: number | null; atrPct: number | null; legStart: number | null },
  ref: Reference,
): Regime {
  const base: Regime = {
    trend: "UNCLASSIFIED", direction: null, vol: "UNCLASSIFIED", label: "UNCLASSIFIED",
    efficiency: m.efficiency, atrPct: m.atrPct, legStart: m.legStart,
  };

  let vol: VolBucket = "UNCLASSIFIED";
  if (m.atrPct !== null && ref.atrPct.length >= MIN_REFERENCE) {
    const p = percentileOf(ref.atrPct, m.atrPct);
    vol = p >= UPPER_THIRD ? "HIGH_VOL" : p < LOWER_THIRD ? "LOW_VOL" : "MID_VOL";
  }

  if (m.efficiency === null || m.legStart === null || ref.efficiency.length < MIN_REFERENCE) {
    return { ...base, vol };
  }

  const p = percentileOf(ref.efficiency, m.efficiency);
  const trend: TrendBucket = p >= UPPER_THIRD ? "STRONG" : p < LOWER_THIRD ? "RANGING" : "WEAK";
  // Direction is only meaningful where there IS a direction. A low-efficiency
  // leg has a net sign but it is noise, so RANGING carries no direction.
  const net = s[k].close - s[m.legStart].close;
  const direction: Direction = trend === "RANGING" ? null : net >= 0 ? "BULL" : "BEAR";
  const label: RegimeLabel = trend === "RANGING"
    ? "RANGING"
    : `${trend}_${direction}` as RegimeLabel;

  return { ...base, trend, direction, vol, label };
}

/**
 * Labels a whole series against a supplied reference.
 *
 * The reference is a parameter, not derived here, so the caller decides whether
 * thirds are taken against this period alone, against the instrument's full set
 * of periods, or against an expanding causal window.
 */
export function labelSeries(s: Candle[], ref: Reference): Regime[] {
  return measureSeries(s).map((m, k) => classify(s, k, m, ref));
}

/**
 * Strictly causal variant: every bar is ranked only against bars that preceded
 * it. Used as a cross-check that a full-period reference is not doing the work.
 */
export function labelSeriesCausal(s: Candle[]): Regime[] {
  const ms = measureSeries(s);
  const effSeen: number[] = [], atrSeen: number[] = [];
  const insert = (arr: number[], v: number) => {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
    arr.splice(lo, 0, v);
  };
  return ms.map((m, k) => {
    const r = classify(s, k, m, { efficiency: effSeen, atrPct: atrSeen });
    if (m.efficiency !== null && Number.isFinite(m.efficiency)) insert(effSeen, m.efficiency);
    if (m.atrPct !== null && Number.isFinite(m.atrPct)) insert(atrSeen, m.atrPct);
    return r;
  });
}
