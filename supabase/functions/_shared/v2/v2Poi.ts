// §3.1–3.7 — legs and POIs on 1H, determined once at qualification (§2.0d).
import type { Series } from "./barStore.ts";
import { atrSum } from "./atr.ts";
import type { Pair } from "./spec.ts";
import { BASELINE_BARS, LEG_MIN_SPAN, WINDOW_1H } from "./spec.ts";
import type { Dir } from "./v2Direction.ts";
import { type StructureIndex, type Swing, unbrokenAt, view, visibleSwings } from "./v2Structure.ts";

export interface Leg {
  id: string;
  pair: Pair;
  dir: Dir;
  o: number;           // origin slot (1H)
  j: number;           // reference swing slot
  b: number;           // break slot
  originLevel: number; // low[o] (LONG) / high[o] (SHORT), for §3.9
  legHigh: number;
  legLow: number;
  qualifies: boolean;
  displacementCount: number;
  firstDisplacement: number; // slot d, -1 if none
}

export type PoiType = "OB" | "FVG";
export interface Poi {
  id: string;          // §3.7 identity
  pair: Pair;
  dir: Dir;
  type: PoiType;
  low: number;
  high: number;
  formationTime: number;
  legId: string;
  o: number; b: number;
  originTime: number;  // origin bar open time
  bTime: number;       // break bar open time
  bClose: number;      // qualification time (close of b)
}

const bull = (o: number, c: number) => c > o;   // §0.7
const bear = (o: number, c: number) => c < o;

/** §3.3 displacement candle test against the 20-bar baseline sums (integer, cross-multiplied). */
export function isDisplacement(dir: Dir, bar: { o: number; h: number; l: number; c: number }, sumBody: number, sumRange: number): boolean {
  const body = Math.abs(bar.c - bar.o), range = bar.h - bar.l;
  const coloured = dir === "LONG" ? bull(bar.o, bar.c) : bear(bar.o, bar.c);
  // body/avgBody ≥ 2.0 ⇔ 10·body ≥ sumBody; body/range ≥ 0.7 ⇔ 10·body ≥ 7·range; range/avgRange ≥ 1.5 ⇔ 40·range ≥ 3·sumRange
  return coloured && 10 * body >= sumBody && 10 * body >= 7 * range && 40 * range >= 3 * sumRange;
}

/**
 * Legs qualifying at 1H slot B (the close of B is the qualification time): one per origin o whose reference
 * swing j breaks at B (§3.1, O1, §2.0d window/segment at B).
 */
export function legsAt(pair: Pair, s: Series, ix: StructureIndex, B: number): Leg[] {
  const v = view(s, B, WINDOW_1H);
  if (v.seg < 0) return [];
  const vis = visibleSwings(ix, v);
  const out: Leg[] = [];
  for (const j of vis) {
    if (j.breakIdx !== B) continue;
    const dir: Dir = j.kind === "H" ? "LONG" : "SHORT";
    const originKind = j.kind === "H" ? "L" : "H";
    for (const o of vis) {
      if (o.kind !== originKind || o.i <= j.i || o.i >= B) continue;
      // j must be the reference: the latest swing of j's kind with index < o
      const ref = latestBefore(vis, j.kind, o.i);
      if (!ref || ref.i !== j.i) continue;
      if (!unbrokenAt(j, o.i)) continue;                 // reference unbroken at o (always true: j breaks at B > o)
      if (B - o.i < LEG_MIN_SPAN) continue;              // b − o ≥ 3
      if (!unbrokenAt(o, B)) continue;                   // O1: origin unbroken through b
      const from = Math.min(j.i - 2, o.i - BASELINE_BARS);
      if (from < 0 || s.segStart[B] > from) continue;    // one segment from min(j−2, o−20) to b
      out.push(buildLeg(pair, s, dir, o, j, B));
    }
  }
  return out;
}

function latestBefore(vis: Swing[], kind: "H" | "L", before: number): Swing | null {
  let best: Swing | null = null;
  for (const sw of vis) if (sw.kind === kind && sw.i < before && (!best || sw.i > best.i)) best = sw;
  return best;
}

function buildLeg(pair: Pair, s: Series, dir: Dir, o: Swing, j: Swing, B: number): Leg {
  let legHigh = -Infinity, legLow = Infinity;
  for (let k = o.i; k <= B; k++) { legHigh = Math.max(legHigh, s.bars[k]!.h); legLow = Math.min(legLow, s.bars[k]!.l); }
  let sumBody = 0, sumRange = 0;
  for (let k = o.i - BASELINE_BARS; k < o.i; k++) {
    const b = s.bars[k]!;
    sumBody += Math.abs(b.c - b.o);
    sumRange += b.h - b.l;
  }
  let count = 0, first = -1, maxRange = 0;
  for (let k = o.i; k <= B; k++) {
    const b = s.bars[k]!;
    maxRange = Math.max(maxRange, b.h - b.l);
    if (isDisplacement(dir, b, sumBody, sumRange)) { count++; if (first === -1) first = k; }
  }
  const n = B - o.i + 1;
  // count ≥ ceil(0.10·n)  OR  max range / avgRange ≥ 2.0 ⇔ 10·maxRange ≥ sumRange
  const qualifies = count >= Math.ceil(n / 10) || 10 * maxRange >= sumRange;
  return {
    id: `${pair}|${dir}|${s.grid[o.i]}|${s.grid[B]}`,
    pair, dir, o: o.i, j: j.i, b: B,
    originLevel: dir === "LONG" ? s.bars[o.i]!.l : s.bars[o.i]!.h,
    legHigh, legLow, qualifies, displacementCount: count, firstDisplacement: first,
  };
}

/** §3.4–3.7 POIs of a qualifying leg (FVGs and the OB), filtered by fib depth ≥ 0.50. */
export function poisOf(leg: Leg, s: Series): Poi[] {
  if (!leg.qualifies) return [];
  const out: Poi[] = [];
  const base = {
    pair: leg.pair, dir: leg.dir, legId: leg.id, o: leg.o, b: leg.b,
    originTime: s.grid[leg.o], bTime: s.grid[leg.b], bClose: s.grid[leg.b] + s.step,
  };
  for (let c3 = leg.o + 2; c3 <= leg.b; c3++) {
    const c1 = s.bars[c3 - 2]!, k3 = s.bars[c3]!;
    let low: number, high: number;
    if (leg.dir === "LONG") { if (!(k3.l > c1.h)) continue; low = c1.h; high = k3.l; }
    else { if (!(k3.h < c1.l)) continue; low = k3.h; high = c1.l; }
    const sum = atrSum(s, c3);
    if (sum === null) continue;                          // not computable → no FVG (§1.3)
    if (!(140 * (high - low) >= sum)) continue;          // width ≥ 0.10 × ATR14 ⇔ 140·width ≥ sumTR
    out.push(withId({ ...base, type: "FVG", low, high, formationTime: s.grid[c3] + s.step }));
  }
  if (leg.firstDisplacement !== -1) {
    for (let k = leg.firstDisplacement - 1; k >= leg.o; k--) {
      const b = s.bars[k]!;
      if (leg.dir === "LONG" ? bear(b.o, b.c) : bull(b.o, b.c)) {
        out.push(withId({ ...base, type: "OB", low: b.l, high: b.h, formationTime: s.grid[k] + s.step }));
        break;
      }
    }
  }
  const range = leg.legHigh - leg.legLow;
  return out.filter((p) =>
    leg.dir === "LONG" ? 2 * (leg.legHigh - p.high) >= range : 2 * (p.low - leg.legLow) >= range
  );
}

function withId(p: Omit<Poi, "id">): Poi {
  return { ...p, id: `${p.pair}|${p.dir}|${p.originTime}|${p.bTime}|${p.type}|${p.formationTime}|${p.low}|${p.high}` };
}
