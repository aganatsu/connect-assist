// §7.1–7.6 — target candidates, observability, sweep, selection, opposing-POI limiter and the no-jump check.
import { asianEnd, inAsianRange, isExpected, tradingDayOf, tradingDayStart } from "./calendar.ts";
import { firstOpenAtOrAfter, lastClosed, type Series } from "./barStore.ts";
import { POI_LOOKBACK_1H } from "./spec.ts";
import type { Dir } from "./v2Direction.ts";
import type { Poi } from "./v2Poi.ts";
import { type StructureIndex, swingRecord } from "./v2Structure.ts";

export type CandidateType = "SWING" | "PREV_DAY" | "ASIAN";
export type CandidateState = "VALID" | "SWEPT" | "UNKNOWN";
export interface Candidate { type: CandidateType; price: number | null; state: CandidateState; ref: string }

export interface TargetResult {
  candidates: Candidate[];       // candidates strictly beyond entry (and price-unknown ones)
  selected: number | null;       // S after 7.3–7.4
  limitedBy: string | null;      // opposing POI id that set S (7.4)
  observabilityFail: string | null; // 7.6 reason text, null if the check passes
}

export interface TargetInput {
  dir: Dir;
  entry: number;
  t: number;                     // decision time (close of k)
  k: number;                     // 5m slot of the confirmation bar
  s5: Series;
  s1h: Series;
  ix1h: StructureIndex;
  opposingAlive: Poi[];          // same pair, opposite direction, alive in the pre-touch state of k (7.4, AM1)
  opposingUnknown: Poi[];        // same pair, opposite direction, unknown-state per 7.6c (already filtered)
}

const beyond = (dir: Dir, price: number, entry: number) => (dir === "LONG" ? price > entry : price < entry);

/** Expected 5m intervals opening in [from, to) that lie before the dataset grid (not stored → not computable). */
function expectedBeforeGrid(s5: Series, from: number, to: number): boolean {
  const g0 = s5.grid.length ? s5.grid[0] : Infinity;
  for (let x = from; x < Math.min(to, g0); x += 300_000) if (isExpected(x)) return true;
  return false;
}

/**
 * §7.1a (GT) / §7.2 state over the sweep interval [fromTime, slot k]: SWEPT if any present bar traded through (a sweep is permanent,
 * even across gaps); otherwise UNKNOWN if any interval is MISSING or not stored, or `uncertain` (AM2 pre-1H-gap swing); otherwise VALID.
 */
function sweepState(s5: Series, dir: Dir, price: number, fromTime: number, k: number, uncertain = false): CandidateState {
  const from = firstOpenAtOrAfter(s5.grid, fromTime);
  let gap = uncertain || expectedBeforeGrid(s5, fromTime, Infinity);
  for (let i = from; i <= k; i++) {
    const b = s5.bars[i];
    if (!b) { gap = true; continue; }
    if (dir === "LONG" ? b.h > price : b.l < price) return "SWEPT";
  }
  return gap ? "UNKNOWN" : "VALID";
}

/** Max high (LONG) / min low (SHORT) of every expected 5m interval opening in [from, to) that passes `keep`; null if any is MISSING or not stored. */
function extremeOver(s5: Series, dir: Dir, from: number, to: number, keep: (open: number) => boolean): { price: number | null; count: number } {
  let count = 0, x = dir === "LONG" ? -Infinity : Infinity, known = true;
  for (let t = from; t < to; t += 300_000) {
    if (!isExpected(t) || !keep(t)) continue;
    count++;
    const i = s5.grid.length && t >= s5.grid[0] ? firstOpenAtOrAfter(s5.grid, t) : -1;
    const b = i >= 0 && s5.grid[i] === t ? s5.bars[i] : null;
    if (!b) { known = false; continue; }
    x = dir === "LONG" ? Math.max(x, b.h) : Math.min(x, b.l);
  }
  return { price: known && count > 0 ? x : null, count };
}

/** §0.9 the most recent earlier NY trading day containing at least one expected 5m interval. */
function previousTradingDay(today: string): { day: string; from: number; to: number } {
  let to = tradingDayStart(today);
  for (let back = 1; back <= 14; back++) {
    const from = to - 24 * 3_600_000;
    const day = tradingDayOf(from + 3_600_000);
    const start = tradingDayStart(day);
    for (let x = start; x < to; x += 300_000) if (isExpected(x)) return { day, from: start, to };
    to = start;
  }
  throw new Error(`no previous trading day within 14 days of ${today}`);
}

export function selectTarget(inp: TargetInput): TargetResult {
  const { dir, entry, t, k, s5, s1h, ix1h } = inp;
  const cands: Candidate[] = [];
  const priceUnknown: Candidate[] = [];

  // (a) 1H swings from the swing record (2.0e), swing bar among the 120 most recent closed 1H bars.
  const L1 = lastClosed(s1h.grid, s1h.step, t);
  const curSeg = L1 >= 0 && s1h.bars[L1] ? s1h.seg[L1] : -1;
  const kind = dir === "LONG" ? "H" : "L";
  for (const sw of swingRecord(ix1h, L1)) {
    if (sw.kind !== kind || sw.i < L1 - POI_LOOKBACK_1H + 1 || sw.i > L1) continue;
    if (!beyond(dir, sw.level, entry)) continue;
    // AM2 + GT: a swing from an earlier 1H segment keeps its price; SWEPT if a trade-through was observed, else UNKNOWN
    const state = sweepState(s5, dir, sw.level, s1h.grid[sw.i] + s1h.step, k, sw.seg !== curSeg);
    cands.push({ type: "SWING", price: sw.level, state, ref: `1h@${new Date(s1h.grid[sw.i]).toISOString()}` });
  }

  // (b) previous NY trading day's high/low (max high / min low of its 5m bars; every expected interval present).
  const today = tradingDayOf(s5.grid[k]);
  const prev = previousTradingDay(today);
  const pd = extremeOver(s5, dir, prev.from, prev.to, () => true);
  if (pd.price === null) priceUnknown.push({ type: "PREV_DAY", price: null, state: "UNKNOWN", ref: prev.day });
  else if (beyond(dir, pd.price, entry)) {
    cands.push({ type: "PREV_DAY", price: pd.price, state: sweepState(s5, dir, pd.price, prev.to, k), ref: prev.day });
  }

  // (c) current NY trading day's Asian range [20:00, 02:00), once 02:00 has passed (t ≥ 02:00 of the end date).
  const aEnd = asianEnd(today);
  if (t >= aEnd) {
    const as = extremeOver(s5, dir, tradingDayStart(today), aEnd, inAsianRange);
    if (as.count > 0) {
      if (as.price === null) priceUnknown.push({ type: "ASIAN", price: null, state: "UNKNOWN", ref: today });
      else if (beyond(dir, as.price, entry)) {
        cands.push({ type: "ASIAN", price: as.price, state: sweepState(s5, dir, as.price, aEnd, k), ref: today });
      }
    }
  }

  // 7.3 selection (identical prices form one level, valid iff one candidate at that price is valid)
  let S: number | null = null;
  for (const c of cands) {
    if (c.state !== "VALID") continue;
    if (S === null || (dir === "LONG" ? c.price! < S : c.price! > S)) S = c.price!;
  }
  // 7.4 opposing-POI limiter: the nearest opposing near edge strictly between entry and the selected level
  let limitedBy: string | null = null;
  if (S !== null) {
    const S0 = S;
    for (const p of inp.opposingAlive) {
      const edge = dir === "LONG" ? p.low : p.high;
      const inside = dir === "LONG" ? entry < edge && edge < S0 : S0 < edge && edge < entry;
      if (inside && (limitedBy === null || (dir === "LONG" ? edge < S! : edge > S!))) { S = edge; limitedBy = p.id; }
    }
  }

  // 7.6 no jumping over unknown levels
  const between = (x: number) => S === null ? beyond(dir, x, entry) : (dir === "LONG" ? entry < x && x < S : S < x && x < entry);
  let fail: string | null = null;
  for (const c of cands) if (c.state === "UNKNOWN" && between(c.price!)) { fail = `unknown ${c.type} ${c.ref} between entry and target`; break; }
  if (!fail && priceUnknown.length > 0) fail = `${priceUnknown[0].type} ${priceUnknown[0].ref} price unknown`;
  if (!fail) {
    for (const p of inp.opposingUnknown) {
      const edge = dir === "LONG" ? p.low : p.high;
      if ((p.low <= entry && entry <= p.high) || between(edge)) { fail = `unknown-state opposing POI ${p.id}`; break; }
    }
  }
  return { candidates: [...cands, ...priceUnknown], selected: S, limitedBy, observabilityFail: fail };
}
