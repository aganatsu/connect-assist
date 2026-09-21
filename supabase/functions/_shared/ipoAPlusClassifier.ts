/**
 * A+ IPO classifier. RESEARCH ONLY.
 *
 * A MEMBERSHIP TEST, NOT A MODEL. Each variant is a plain conjunction of
 * features that already survived independent measurement. There are no weights,
 * no score, no threshold and nothing fitted — a setup either satisfies the
 * conjunction or it does not. That is deliberate: with one Tier-1 feature and
 * one Tier-2 feature there is nothing to weight, and anything fitted here would
 * be fitted to the same three quarters the features were measured on.
 *
 * WHY THESE FEATURES AND NOT THE OTHERS. FVG is the only feature that separated
 * in the same direction on all three instruments and under both execution
 * models. SR_OVERLAP separated on BTC and USD/JPY but was flat on EUR/USD, so it
 * appears only as an optional additional condition, never as a requirement.
 * TREND_ALIGNED, FIB_50_100, HTF_PARENT alignment, INSTITUTIONAL_IPDA and touch
 * number are still ANNOTATED by `ipoConfluenceFeatures.ts` and are deliberately
 * absent from every variant here.
 *
 * NOT_PARENT_BOTH_SIDES IS EXPLORATORY. The contested-parent population is
 * n = 103 pooled, and two of its three per-instrument samples are n < 15. It is
 * carried as an exclusion in A3 and A4 so its effect can be read off, not
 * because it is established.
 *
 * THE RESULTS OF THIS MODULE ARE NOT A LICENCE TO EDIT IT. If a variant looks
 * good, the next step is an untouched date range, not a fifth variant.
 *
 * Nothing here is wired to production.
 */

import type { Annotation } from "./ipoConfluenceFeatures.ts";

export type ClassifierKey = "A1" | "A2" | "A3" | "A4";

export interface Classifier {
  key: ClassifierKey;
  label: string;
  /** Pure conjunction over an annotation. No arithmetic, by design. */
  admits: (a: Annotation) => boolean;
}

const fvg = (a: Annotation) => a.FVG === "PRESENT";
const sr = (a: Annotation) => a.SR_OVERLAP === "PRESENT";
const notBothSides = (a: Annotation) => a.HTF_PARENT !== "PARENT_BOTH_SIDES";

export const CLASSIFIERS: Classifier[] = [
  { key: "A1", label: "FVG", admits: fvg },
  { key: "A2", label: "FVG + SR", admits: (a) => fvg(a) && sr(a) },
  { key: "A3", label: "FVG + !bothSides", admits: (a) => fvg(a) && notBothSides(a) },
  { key: "A4", label: "FVG + SR + !bothSides", admits: (a) => fvg(a) && sr(a) && notBothSides(a) },
];

/** The minimum a trade must expose for this module to score it. */
export interface ScorableTrade {
  netR: number;
  mae: number;
  touchIndex: number;
  exitIndex: number;
}

export interface ClassifierStats {
  trades: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
  longestLosingStreak: number;
  totalR: number;
  tradesPerMonth: number | null;
  avgMAE: number;
  maxConcurrent: number;
}

/**
 * Concurrency is counted over the trades' own index span rather than the series
 * length, so a subset that clusters into one week is not flattered by being
 * averaged across a quarter.
 */
function concurrency(ts: ScorableTrade[]): number {
  if (!ts.length) return 0;
  const edges: Array<[number, number]> = [];
  for (const t of ts) { edges.push([t.touchIndex, 1]); edges.push([t.exitIndex + 1, -1]); }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, max = 0;
  for (const [, d] of edges) { cur += d; if (cur > max) max = cur; }
  return max;
}

export function classifierStats(ts: ScorableTrade[], months: number | null): ClassifierStats {
  if (!ts.length) {
    return {
      trades: 0, winRate: 0, expectancyR: 0, profitFactor: null, maxDrawdownR: 0,
      longestLosingStreak: 0, totalR: 0, tradesPerMonth: months ? 0 : null,
      avgMAE: 0, maxConcurrent: 0,
    };
  }
  // Chronological, so drawdown and streak describe the order they were lived in.
  const ordered = [...ts].sort((a, b) => a.touchIndex - b.touchIndex);
  let eq = 0, peak = 0, dd = 0, streak = 0, worst = 0, gw = 0, gl = 0, wins = 0;
  for (const t of ordered) {
    eq += t.netR;
    if (eq > peak) peak = eq;
    if (peak - eq > dd) dd = peak - eq;
    if (t.netR > 0) { wins++; gw += t.netR; streak = 0; }
    else { gl += Math.abs(t.netR); streak++; if (streak > worst) worst = streak; }
  }
  return {
    trades: ordered.length,
    winRate: (100 * wins) / ordered.length,
    expectancyR: eq / ordered.length,
    profitFactor: gl > 0 ? gw / gl : null,
    maxDrawdownR: dd,
    longestLosingStreak: worst,
    totalR: eq,
    tradesPerMonth: months ? ordered.length / months : null,
    avgMAE: ordered.reduce((a, t) => a + t.mae, 0) / ordered.length,
    maxConcurrent: concurrency(ordered),
  };
}

/**
 * First-come-first-served single-position filter.
 *
 * ORDER OF APPLICATION CHANGES THE QUESTION, so both are reported rather than
 * one being picked:
 *
 *   CLASSIFY -> SEQUENCE  ("trade only A+, one at a time"). What someone running
 *   the classifier would actually experience. This is the primary reading.
 *
 *   SEQUENCE -> CLASSIFY  ("hold one position over everything, then ask which
 *   were A+"). Conservative: the A+ trades get blocked by non-A+ trades the
 *   classifier would never have taken. Useful as a cross-check, because it
 *   cannot benefit from the subset being free to skip ahead.
 *
 * Reporting only the first would overstate; only the second would understate.
 */
export function sequential<T extends ScorableTrade>(ts: T[]): T[] {
  const out: T[] = [];
  let free = -1;
  for (const t of [...ts].sort((a, b) => a.touchIndex - b.touchIndex)) {
    if (t.touchIndex > free) { out.push(t); free = t.exitIndex; }
  }
  return out;
}
