// Seeded synthetic market for V2 tests: random walk with volatility bursts on 5m; 15m/1H aggregated from 5m
// (test data only — the spec's data definition is native provider bars). Optional MISSING-bar injection.
import { isExpected } from "../../../functions/_shared/v2/calendar.ts";
import type { Dataset, RawBar } from "../../../functions/_shared/v2/barStore.ts";
import { PAIRS, type Pair, PIP, STEP_MS, type TF } from "../../../functions/_shared/v2/spec.ts";

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE: Record<Pair, number> = {
  "EUR/USD": 1.16, "GBP/USD": 1.34, "USD/JPY": 151.2, "CHF/JPY": 189.4, "NZD/CAD": 0.805, "NZD/CHF": 0.462,
};

export interface GenOptions {
  seed: number;
  start: number;            // UTC ms, dataset start
  days: number;             // calendar days
  missing5m?: number;       // probability a 5m bar is dropped
  missing15m?: number;
  missing1h?: number;
  pairs?: readonly Pair[];
}

function round(p: Pair, x: number) {
  const dec = PIP[p] === 0.01 ? 3 : 5;
  return +x.toFixed(dec);
}

export function generate(o: GenOptions): Dataset {
  const r = rng(o.seed);
  const end = o.start + o.days * 86_400_000;
  const bars = {} as Dataset["bars"];
  for (const p of PAIRS) {
    bars[p] = { "5m": [], "15m": [], "1h": [] } as Record<TF, RawBar[]>;
    if (o.pairs && !o.pairs.includes(p)) continue;
    const pip = PIP[p];
    let px = BASE[p], burst = 0, drift = 0, trend = 0, trendLeft = 0;
    const m5: RawBar[] = [];
    for (let t = o.start; t < end; t += STEP_MS["5m"]) {
      if (!isExpected(t)) continue;
      if (trendLeft <= 0) { trendLeft = 150 + Math.floor(r() * 500); trend = (r() < 0.5 ? -1 : 1) * (0.2 + r() * 0.9) * pip; }
      trendLeft--;
      if (burst <= 0 && r() < 0.012) {
        burst = 4 + Math.floor(r() * 10);
        drift = (r() < 0.7 ? Math.sign(trend) : -Math.sign(trend)) * (3 + r() * 6) * pip;
      }
      const vol = (burst > 0 ? 4 : 1.4) * pip;
      const open = px;
      let hi = open, lo = open, cur = open;
      for (let s = 0; s < 5; s++) {
        cur += (r() - 0.5) * 2 * vol + (burst > 0 ? drift / 5 : 0) + trend / 5;
        hi = Math.max(hi, cur); lo = Math.min(lo, cur);
      }
      hi += r() * vol * 0.6; lo -= r() * vol * 0.6;
      burst--;
      px = cur;
      m5.push({ t, o: round(p, open), h: round(p, hi), l: round(p, lo), c: round(p, cur) });
    }
    // fix rounding so that h ≥ max(o,c) and l ≤ min(o,c)
    for (const b of m5) { b.h = Math.max(b.h, b.o, b.c); b.l = Math.min(b.l, b.o, b.c); }
    const agg = (tf: TF) => {
      const step = STEP_MS[tf], out: RawBar[] = [];
      const by = new Map<number, RawBar[]>();
      for (const b of m5) { const k = Math.floor(b.t / step) * step; (by.get(k) ?? by.set(k, []).get(k)!).push(b); }
      for (const [k, xs] of [...by.entries()].sort((a, b) => a[0] - b[0])) {
        out.push({ t: k, o: xs[0].o, h: Math.max(...xs.map((x) => x.h)), l: Math.min(...xs.map((x) => x.l)), c: xs[xs.length - 1].c });
      }
      return out;
    };
    const drop = (xs: RawBar[], pr = 0) => pr > 0 ? xs.filter(() => r() >= pr) : xs;
    bars[p]["15m"] = drop(agg("15m"), o.missing15m);
    bars[p]["1h"] = drop(agg("1h"), o.missing1h);
    bars[p]["5m"] = drop(m5, o.missing5m);
  }
  return { start: o.start, end, bars };
}
