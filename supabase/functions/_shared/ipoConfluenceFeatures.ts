/**
 * Independent confluence annotation for valid IPO touches. RESEARCH ONLY.
 *
 * MEASUREMENT, NOT SELECTION. Every feature here is recorded and reported on its
 * own. Nothing is weighted, combined, scored, thresholded, or dropped for
 * performing badly. A feature that separates nothing is a result.
 *
 * EVERY FEATURE IS COMPUTED FROM `s.slice(0, touchIndex + 1)` AND NOTHING ELSE.
 * The whole point of an annotation layer is that it could have been known at the
 * moment of the touch; a feature built from later bars would flatter itself.
 *
 * NO NEW PRIMITIVES WERE INVENTED. Each feature delegates to a definition that
 * already exists in the codebase — `directionalEvents` for structure,
 * `detectZigZagPivots` + `computeFibLevels` for retracement, `detectLiquidityPools`
 * for support/resistance, `calculateIPDARanges` for institutional levels, and the
 * frozen `runLifecycle` itself for the higher-timeframe parent. Where no such
 * definition exists the feature is returned as NOT_YET_MACHINE_DEFINED rather
 * than approximated.
 *
 * TRI-STATE ON PURPOSE. "No trend reference yet" is not the same as
 * "counter-trend", and "no HTF parent" is not the same as "conflicting parent".
 * Folding those together would manufacture a contrast that does not exist.
 *
 * Nothing here is wired to production.
 */

import {
  detectZigZagPivots, computeFibLevels, detectLiquidityPools, SPECS,
  type Candle,
} from "./smcAnalysis.ts";
import { calculateIPDARanges, ipdaRangesToKeyLevels } from "./ipdaRanges.ts";
import { directionalEvents } from "./ipoOriginExperiments.ts";
import { runLifecycle, type Episode, type LifecycleIPO } from "./ipoLifecycle.ts";
import type { Setup } from "./ipoRawBacktest.ts";

export type FeatureKey =
  | "FVG"
  | "TREND_ALIGNED"
  | "HTF_PARENT"
  | "FIB_50_100"
  | "SR_OVERLAP"
  | "INSTITUTIONAL_IPDA"
  | "INSTITUTIONAL_VOLUME_PROFILE";

export const FEATURE_KEYS: FeatureKey[] = [
  "FVG", "TREND_ALIGNED", "HTF_PARENT", "FIB_50_100", "SR_OVERLAP",
  "INSTITUTIONAL_IPDA", "INSTITUTIONAL_VOLUME_PROFILE",
];

/** Every feature resolves to exactly one of these. */
export type FeatureValue =
  | "PRESENT"
  | "ABSENT"
  | "NO_TREND_REFERENCE"
  | "NO_SWING_REFERENCE"
  | "NO_PARENT"
  | "CONFLICTING_PARENT"
  | "PARENT_BOTH_SIDES"
  | "NOT_YET_MACHINE_DEFINED";

export type Annotation = Record<FeatureKey, FeatureValue> & {
  touchBucket: "1st" | "2nd" | "3rd+";
};

/** Per-series work that must not be redone for every one of ~2,000 setups. */
export interface FeatureContext {
  series: Candle[];
  pipSize: number;
  /** HTF bars, and the index in `series` at which each HTF bar CLOSES. */
  htf: Candle[] | null;
  htfClosesAt: number[];
  htfIpos: LifecycleIPO[];
  /** Daily aggregation of `series`, with the closing index of each day. */
  daily: Candle[];
  dailyClosesAt: number[];
  /** True when the series carries real volume. FX from TwelveData does not. */
  hasVolume: boolean;
}

const agg = (bars: Candle[]): Candle => ({
  datetime: bars[0].datetime,
  open: bars[0].open,
  high: Math.max(...bars.map((b) => b.high)),
  low: Math.min(...bars.map((b) => b.low)),
  close: bars[bars.length - 1].close,
  volume: bars.reduce((a, b) => a + (b.volume ?? 0), 0),
} as Candle);

/**
 * Buckets bars by a key derived from their own timestamp, and records where each
 * bucket closes in the source series. The closing index is what makes the HTF
 * usable causally: an HTF bar may only be consulted once it has finished.
 *
 * TIMESTAMPS MUST CARRY A ZONE. `new Date(...)` reads an offset-less string as
 * LOCAL time, which silently shifts every bucket boundary. The OOS series are
 * `...Z`, so this is correct as used — but do NOT "helpfully" append a Z to
 * zone-less input: that is the exact defect that broke the CHoCH search windows
 * when TwelveData returned exchange-local times.
 */
function resample(s: Candle[], key: (d: Date) => string): { bars: Candle[]; closesAt: number[] } {
  const bars: Candle[] = [], closesAt: number[] = [];
  let cur: Candle[] = [], curKey: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const k = key(new Date(s[i].datetime));
    if (curKey !== null && k !== curKey) { bars.push(agg(cur)); closesAt.push(i - 1); cur = []; }
    curKey = k; cur.push(s[i]);
  }
  if (cur.length) { bars.push(agg(cur)); closesAt.push(s.length - 1); }
  return { bars, closesAt };
}

export const resampleTo4h = (s: Candle[]) => resample(s, (d) =>
  `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${Math.floor(d.getUTCHours() / 4)}`);

export const resampleToDaily = (s: Candle[]) => resample(s, (d) =>
  `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`);

/**
 * Builds the per-series context.
 *
 * `buildEpisodes` is passed in rather than imported so that the frozen
 * contraction stack is applied identically on the HTF series without this module
 * taking a view on how episodes are produced.
 */
export function buildContext(
  series: Candle[], symbol: string,
  buildEpisodes: (s: Candle[]) => Episode[],
): FeatureContext {
  const { bars: htf, closesAt: htfClosesAt } = resampleTo4h(series);
  const { bars: daily, closesAt: dailyClosesAt } = resampleToDaily(series);
  // The HTF parent is the SAME frozen lifecycle run on a coarser series — not a
  // second, differently-specified model.
  const htfIpos = htf.length > 30
    ? runLifecycle(htf, buildEpisodes(htf)).filter((x) => x.validAt !== null)
    : [];
  return {
    series, pipSize: SPECS[symbol]?.pipSize ?? 0.0001,
    htf: htf.length > 30 ? htf : null, htfClosesAt, htfIpos,
    daily, dailyClosesAt,
    hasVolume: series.some((c) => (c.volume ?? 0) > 0),
  };
}

/**
 * Most recent EXTERNAL structural break strictly before `at`.
 *
 * External rather than internal because internal breaks flip constantly inside a
 * range, which would make "trend" a coin flip rather than a direction. This is
 * the canonical engine's own significance flag, not a new classification.
 */
export function trendAt(events: any[], at: number): "bullish" | "bearish" | null {
  let dir: "bullish" | "bearish" | null = null;
  for (const e of events) {
    if (e.index >= at) break;
    if (e.significance === "external") dir = e.direction;
  }
  return dir;
}

/** Where `price` sits in the last completed zigzag swing, as a retracement %. */
export function retracementAt(prefix: Candle[], price: number): number | null {
  const z = detectZigZagPivots(prefix);
  if (!z.lastTwo) return null;
  const f = computeFibLevels(z.lastTwo[0], z.lastTwo[1]);
  if (!f) return null;
  const range = f.swingHigh - f.swingLow;
  if (range <= 0) return null;
  return f.direction === "up"
    ? ((f.swingHigh - price) / range) * 100
    : ((price - f.swingLow) / range) * 100;
}

const inZone = (p: number, lo: number, hi: number) => p >= lo && p <= hi;

export function annotate(setup: Setup, ctx: FeatureContext, events: any[]): Annotation {
  const at = setup.touchIndex;
  const prefix = ctx.series.slice(0, at + 1);
  const demand = setup.direction === "demand";
  const entry = demand ? setup.zoneLow : setup.zoneHigh;   // the E2 level

  // ── trend ────────────────────────────────────────────────────────────────
  const t = trendAt(events, at);
  const TREND_ALIGNED: FeatureValue = t === null
    ? "NO_TREND_REFERENCE"
    : (t === "bullish") === demand ? "PRESENT" : "ABSENT";

  // ── higher-timeframe parent ──────────────────────────────────────────────
  // An HTF IPO counts only if its own bar has CLOSED by `at`, it has validated,
  // and it has not been invalidated. Containment is tested on the entry price.
  let sameSide = false, oppSide = false;
  for (const p of ctx.htfIpos) {
    const validIdx = ctx.htfClosesAt[p.validAt!];
    if (validIdx === undefined || validIdx > at) continue;
    if (p.invalidatedAt !== null && ctx.htfClosesAt[p.invalidatedAt] <= at) continue;
    if (!inZone(entry, p.zoneLow, p.zoneHigh)) continue;
    if (p.direction === setup.direction) sameSide = true; else oppSide = true;
  }
  const HTF_PARENT: FeatureValue = ctx.htf === null
    ? "NOT_YET_MACHINE_DEFINED"
    : sameSide && oppSide ? "PARENT_BOTH_SIDES"
    : sameSide ? "PRESENT"
    : oppSide ? "CONFLICTING_PARENT"
    : "NO_PARENT";

  // ── fib 50–100% retracement area ─────────────────────────────────────────
  const rt = retracementAt(prefix, entry);
  const FIB_50_100: FeatureValue = rt === null
    ? "NO_SWING_REFERENCE"
    : rt >= 50 && rt <= 100 ? "PRESENT" : "ABSENT";

  // ── support / resistance overlap ─────────────────────────────────────────
  // The codebase's objective S/R is an equal-high/low liquidity cluster.
  const pools = detectLiquidityPools(prefix);
  const SR_OVERLAP: FeatureValue =
    pools.some((p: any) => inZone(p.price, setup.zoneLow, setup.zoneHigh)) ? "PRESENT" : "ABSENT";

  // ── institutional level overlap ──────────────────────────────────────────
  // IPDA 20/40/60-day range highs, lows and equilibria are the only
  // institutional-level definition in the codebase that FX data can support.
  let INSTITUTIONAL_IPDA: FeatureValue = "NOT_YET_MACHINE_DEFINED";
  const dayCount = ctx.dailyClosesAt.filter((i) => i <= at).length;
  if (dayCount >= 20) {
    const daily = ctx.daily.slice(0, dayCount);
    const levels = ipdaRangesToKeyLevels(calculateIPDARanges(daily, entry), entry, ctx.pipSize);
    INSTITUTIONAL_IPDA = levels.some((l: any) => inZone(l.price, setup.zoneLow, setup.zoneHigh))
      ? "PRESENT" : "ABSENT";
  }

  return {
    FVG: setup.hasFvg ? "PRESENT" : "ABSENT",
    TREND_ALIGNED,
    HTF_PARENT,
    FIB_50_100,
    SR_OVERLAP,
    INSTITUTIONAL_IPDA,
    // The codebase's other institutional definition is volume-profile POC/HVN.
    // It is NOT extractable: the logic lives inline inside `runConfluenceAnalysis`
    // rather than as a reusable primitive, and TwelveData returns volume = 0 for
    // FX, so it could not be computed on two of three instruments even if it
    // were. Returned unresolved on every row rather than approximated by
    // something else. `ctx.hasVolume` records which series could support it.
    INSTITUTIONAL_VOLUME_PROFILE: "NOT_YET_MACHINE_DEFINED",
    touchBucket: setup.touchNumber === 1 ? "1st" : setup.touchNumber === 2 ? "2nd" : "3rd+",
  };
}
