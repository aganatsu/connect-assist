// §0.3, §1.2, §1.3, §1.3a, §1.4 — V2 bar/data-gap interface.
// A Series is the grid of EXPECTED intervals of one pair and timeframe; a slot without a bar is MISSING.
import { isExpected } from "./calendar.ts";
import { type Pair, PAIRS, PRICE_SCALE, STEP_MS, type TF } from "./spec.ts";

/** Provider bar as stored (decimal prices, open time in UTC ms). */
export interface RawBar { t: number; o: number; h: number; l: number; c: number }
/** Bar in integer points (spec.ts POINTS_PER_PIP). */
export interface Bar { t: number; o: number; h: number; l: number; c: number }

export interface Series {
  pair: Pair;
  tf: TF;
  step: number;
  grid: number[];              // open times of expected intervals, ascending
  bars: (Bar | null)[];        // aligned with grid; null = MISSING (§1.3)
  seg: Int32Array;             // segment id per slot, -1 where MISSING (§1.3a)
  segStart: Int32Array;        // first slot of the slot's segment, -1 where MISSING
}

export interface Dataset {
  /** First open time covered by the dataset; every expected interval from here on is either a bar or MISSING. */
  start: number;
  /** Exclusive end: intervals opening at or after `end` are not part of the dataset. */
  end: number;
  bars: Record<Pair, Record<TF, RawBar[]>>;
}

export function toPoints(pair: Pair, price: number): number {
  const scaled = price * PRICE_SCALE[pair];
  const pts = Math.round(scaled);
  if (!Number.isFinite(price) || Math.abs(scaled - pts) > 1e-3) {
    throw new Error(`${pair} price ${price} has more decimals than the integer price scale allows`);
  }
  return pts;
}
export function fromPoints(pair: Pair, pts: number): number {
  return pts / PRICE_SCALE[pair];
}

export function buildGrid(tf: TF, start: number, end: number): number[] {
  const step = STEP_MS[tf];
  const out: number[] = [];
  for (let t = Math.ceil(start / step) * step; t < end; t += step) if (isExpected(t)) out.push(t);
  return out;
}

export function buildSeries(pair: Pair, tf: TF, raw: RawBar[], grid: number[]): Series {
  const step = STEP_MS[tf];
  const at = new Map<number, Bar>();
  for (const r of raw) {
    if (r.t % step !== 0) throw new Error(`${pair} ${tf} bar at ${new Date(r.t).toISOString()} is not on the ${tf} grid`);
    if (!isExpected(r.t)) continue; // §1.2: stamped in non-expected time → dropped
    const b: Bar = { t: r.t, o: toPoints(pair, r.o), h: toPoints(pair, r.h), l: toPoints(pair, r.l), c: toPoints(pair, r.c) };
    if (b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c) || b.h < b.l) {
      throw new Error(`${pair} ${tf} bar at ${new Date(r.t).toISOString()} is not a valid OHLC bar`);
    }
    at.set(r.t, b);
  }
  const bars = grid.map((t) => at.get(t) ?? null);
  const seg = new Int32Array(grid.length).fill(-1);
  const segStart = new Int32Array(grid.length).fill(-1);
  let id = -1, start = -1;
  for (let i = 0; i < grid.length; i++) {
    if (!bars[i]) { start = -1; continue; }
    if (start === -1) { id++; start = i; }
    seg[i] = id;
    segStart[i] = start;
  }
  return { pair, tf, step, grid, bars, seg, segStart };
}

export interface Store {
  dataset: Dataset;
  grids: Record<TF, number[]>;
  series: Record<Pair, Record<TF, Series>>;
  index: Record<TF, Map<number, number>>;
}

export function buildStore(ds: Dataset): Store {
  const tfs: TF[] = ["5m", "15m", "1h"];
  const grids = Object.fromEntries(tfs.map((tf) => [tf, buildGrid(tf, ds.start, ds.end)])) as Record<TF, number[]>;
  const index = Object.fromEntries(tfs.map((tf) => [tf, new Map(grids[tf].map((t, i) => [t, i]))])) as Record<TF, Map<number, number>>;
  const series = {} as Record<Pair, Record<TF, Series>>;
  for (const p of PAIRS) {
    series[p] = {} as Record<TF, Series>;
    for (const tf of tfs) {
      const raw = (ds.bars[p]?.[tf] ?? []).filter((b) => b.t >= ds.start && b.t < ds.end);
      series[p][tf] = buildSeries(p, tf, raw, grids[tf]);
    }
  }
  return { dataset: ds, grids, series, index };
}

/** Largest grid slot whose interval has closed at or before `t` (-1 if none). */
export function lastClosed(grid: number[], step: number, t: number): number {
  let lo = 0, hi = grid.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] + step <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** First grid slot whose interval opens at or after `t` (grid.length if none). */
export function firstOpenAtOrAfter(grid: number[], t: number): number {
  let lo = 0, hi = grid.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function isMissing(s: Series, i: number): boolean {
  return i >= 0 && i < s.grid.length && s.bars[i] === null;
}

/** §1.4 every pair is MISSING the same interval. */
export function isProviderWide(store: Store, tf: TF, i: number): boolean {
  return PAIRS.every((p) => store.series[p][tf].bars[i] === null);
}

/** Any MISSING slot in [from, to] (inclusive; empty range → false). */
export function anyMissing(s: Series, from: number, to: number): boolean {
  for (let i = Math.max(0, from); i <= to && i < s.grid.length; i++) if (s.bars[i] === null) return true;
  return from < 0 && to >= 0 ? true : false;
}

/** Slots [from, to] are all present and in one segment. */
export function contiguous(s: Series, from: number, to: number): boolean {
  if (from < 0 || to >= s.grid.length || from > to) return false;
  return s.bars[to] !== null && s.segStart[to] <= from;
}
