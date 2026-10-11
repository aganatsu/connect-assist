// Hand-built V2 scenario: one LONG trade on EUR/USD whose every number is worked out in the comments.
// Prices are given in pips relative to 1.16000. Other pairs are flat (no swings, no POIs).
//
// 1H (index 0 = Sun 2026-09-13 17:00 NY):
//   0–21 baseline o0 h2 l-2 c1 (equal highs/lows → no swings; avgBody 1, avgRange 4)
//   22 j  swing high 10   | 23, 24 down | 25 o swing low −10 | 26 bearish (OB [−8,−3]) | 27, 28 displacement
//   29 b  closes 14 > 10 → break of j; leg o=25, b=29 (b−o = 4); FVG [−3, 1] (c1=26, c3=28), FVG [3,6] fails depth
//   30, 31 (swing high 20), 32, then flat o10 h12 l8 c11
// 5m: flat o2 h2.5 l1.5 c2, a spike to 30 on Mon 16:30 NY (sweeps j=10, sets prev-day high 30),
//   Tue 02:30 swing high 4, 02:50 touch (low 0.5 ≤ FVG high 1) → arm, 02:55 reaction low −0.5,
//   03:00 close 4.5 > 4 → CHoCH → entry 4.5, SL min(−3, −0.5) − 1 = −4, TP = 1H swing 20, R:R (15.5−1.5)/8.5 = 1.65,
//   03:05 high 21 → EXIT_TP.
import { nyLocalToUtc } from "../../../functions/_shared/v2/calendar.ts";
import type { Dataset, RawBar } from "../../../functions/_shared/v2/barStore.ts";
import { PAIRS, type Pair, PIP, STEP_MS, type TF } from "../../../functions/_shared/v2/spec.ts";
import { isExpected } from "../../../functions/_shared/v2/calendar.ts";

export type OHLC = [number, number, number, number];
export const START = nyLocalToUtc(2026, 9, 13, 17, 0);           // Sun 17:00 NY = first expected interval
export const ny = (d: number, h: number, m = 0) => nyLocalToUtc(2026, 9, d, h, m);
export const BASE: Record<Pair, number> = { "EUR/USD": 1.16, "GBP/USD": 1.34, "USD/JPY": 151.2, "CHF/JPY": 189.4, "NZD/CAD": 0.805, "NZD/CHF": 0.462 };

export interface Scenario {
  pair: Pair;
  start: number;
  end: number;
  h1: OHLC[];                       // index i = the i-th EXPECTED 1H interval from `start`
  m15Flat: OHLC;
  m5Flat: OHLC;
  m5: Map<number, OHLC>;            // open time → bar (overrides the flat bar)
  m15: Map<number, OHLC>;
  missing: { tf: TF; t: number; pairs?: Pair[] }[];
  mirror: boolean;                   // reflect prices (LONG ↔ SHORT)
  otherPairsFlat: boolean;
  copies: { pair: Pair; shiftMs: number }[];   // replicate the main pair's bars on other pairs (5m/15m overrides shifted)
}

export function baseScenario(): Scenario {
  const h1: OHLC[] = [];
  for (let i = 0; i < 22; i++) h1.push([0, 2, -2, 1]);
  h1.push([1, 10, 0, 8]);            // 22 j
  h1.push([8, 9, -3, -2]);           // 23
  h1.push([-2, 0, -8, -7]);          // 24
  h1.push([-7, -5, -10, -6]);        // 25 o
  h1.push([-4, -3, -8, -6]);         // 26 bearish → OB
  h1.push([-6, 3, -7, 2]);           // 27 displacement (d)
  h1.push([2, 8, 1, 7]);             // 28
  h1.push([7, 15, 6, 14]);           // 29 b
  h1.push([14, 18, 13, 17]);         // 30
  h1.push([17, 20, 15, 16]);         // 31 swing high 20
  h1.push([16, 17, 8, 9]);           // 32
  const m5 = new Map<number, OHLC>();
  m5.set(ny(14, 16, 30), [2, 30, 1.5, 2]);     // spike: sweeps j (10), prev-day high 30
  m5.set(ny(15, 2, 30), [2, 4, 1.5, 2]);       // protected swing high 4
  m5.set(ny(15, 2, 50), [2, 2, 0.5, 1]);       // touch FVG [−3, 1] → arm
  m5.set(ny(15, 2, 55), [1, 2, -0.5, 1.5]);    // reaction low −0.5
  m5.set(ny(15, 3, 0), [1.5, 5, 1.2, 4.5]);    // CHoCH close 4.5 > 4 → entry
  m5.set(ny(15, 3, 5), [4.5, 21, 4, 20]);      // TP 20 hit
  return {
    pair: "EUR/USD", start: START, end: ny(15, 12, 0), h1, m15Flat: [2, 2.5, 1.5, 2], m5Flat: [2, 2.5, 1.5, 2], m5, m15: new Map(),
    missing: [], mirror: false, otherPairsFlat: true, copies: [],
  };
}

const r = (p: Pair, x: number) => +x.toFixed(PIP[p] === 0.01 ? 3 : 5);
function toRaw(p: Pair, t: number, b: OHLC, mirror: boolean): RawBar {
  const pip = PIP[p], base = BASE[p];
  const [o, h, l, c] = mirror ? [-b[0], -b[2], -b[1], -b[3]] : b;
  return { t, o: r(p, base + o * pip), h: r(p, base + h * pip), l: r(p, base + l * pip), c: r(p, base + c * pip) };
}

export const H1_FLAT_AFTER: OHLC = [10, 12, 8, 11];

export function build(s: Scenario): Dataset {
  const bars = {} as Dataset["bars"];
  const expectedOpens = (tf: TF) => { const o: number[] = []; for (let t = s.start; t < s.end; t += STEP_MS[tf]) if (isExpected(t)) o.push(t); return o; };
  const g1 = expectedOpens("1h");
  const series = (p: Pair, tf: TF, at: (t: number, i: number) => OHLC, mirror: boolean) =>
    expectedOpens(tf).filter((t) => !s.missing.some((m) => m.tf === tf && m.t === t && (m.pairs ? m.pairs.includes(p) : p === s.pair)))
      .map((t) => toRaw(p, t, at(t, g1.indexOf(t)), mirror));
  const mainLike = (p: Pair, shift: number) => {
    const b = {} as Record<TF, RawBar[]>;
    b["1h"] = series(p, "1h", (_t, i) => s.h1[i] ?? H1_FLAT_AFTER, s.mirror);
    b["15m"] = series(p, "15m", (t) => s.m15.get(t - shift) ?? s.m15Flat, s.mirror);
    b["5m"] = series(p, "5m", (t) => s.m5.get(t - shift) ?? s.m5Flat, s.mirror);
    return b;
  };
  const flat: OHLC = [0, 1, -1, 0];
  for (const p of PAIRS) {
    const copy = s.copies.find((c) => c.pair === p);
    if (p === s.pair) bars[p] = mainLike(p, 0);
    else if (copy) bars[p] = mainLike(p, copy.shiftMs);
    else if (s.otherPairsFlat) bars[p] = { "5m": series(p, "5m", () => flat, false), "15m": series(p, "15m", () => flat, false), "1h": series(p, "1h", () => flat, false) };
    else bars[p] = { "5m": [], "15m": [], "1h": [] };
  }
  return { start: s.start, end: s.end, bars };
}
