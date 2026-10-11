// Independent V2 fidelity checker. Written from STRATEGY_SPEC_V2.0.1_FROZEN.md, NOT from the engine:
// imports nothing from ../v2/ or any other application module. It recomputes every structural fact from
// raw bars at every decision time (brute force, no precomputed indices), uses its own New York time
// (hand-written US DST rule, §0.11) and its own ATR, and runs its own state machine in the §15 order.

export type CPair = "EUR/USD" | "GBP/USD" | "USD/JPY" | "CHF/JPY" | "NZD/CAD" | "NZD/CHF";
const PAIRS: CPair[] = ["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF"];
const JPY = (p: CPair) => p.endsWith("JPY");
const PTS_PER_PIP = 1000;
const SPREAD: Record<CPair, number> = { "EUR/USD": 1.0, "GBP/USD": 1.5, "USD/JPY": 1.0, "CHF/JPY": 2.5, "NZD/CAD": 2.5, "NZD/CHF": 3.0 };
const COMM: Record<CPair, number> = { "EUR/USD": 0.5, "GBP/USD": 0.5, "USD/JPY": 0.79, "CHF/JPY": 0.79, "NZD/CAD": 0.71, "NZD/CHF": 0.42 };
const spreadPts = (p: CPair) => Math.round(SPREAD[p] * PTS_PER_PIP);
const costPts = (p: CPair) => Math.round((SPREAD[p] + COMM[p]) * PTS_PER_PIP);
const scale = (p: CPair) => (JPY(p) ? 100 : 10_000) * PTS_PER_PIP;
const Q2USD: Record<CPair, number> = {
  "EUR/USD": 1, "GBP/USD": 1, "USD/JPY": 1 / 158.31985, "CHF/JPY": 1 / 158.31985, "NZD/CAD": 1 / 1.42552, "NZD/CHF": 1 / 0.83022,
};
const MIN5 = 300_000, MIN15 = 900_000, HOUR = 3_600_000;

// ── New York time: US rule (since 2007) — DST from the 2nd Sunday of March 02:00 local to the 1st Sunday of November 02:00 local.
function sundayOfMonth(y: number, month0: number, nth: number): number {
  const dow1 = new Date(Date.UTC(y, month0, 1)).getUTCDay();
  return 1 + ((7 - dow1) % 7) + 7 * (nth - 1);
}
function nyOffsetHours(ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  const start = Date.UTC(y, 2, sundayOfMonth(y, 2, 2), 7);   // 02:00 EST = 07:00 UTC
  const end = Date.UTC(y, 10, sundayOfMonth(y, 10, 1), 6);   // 02:00 EDT = 06:00 UTC
  return ms >= start && ms < end ? -4 : -5;
}
export function ny(ms: number) {
  const d = new Date(ms + nyOffsetHours(ms) * HOUR);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
}
function nyToUtc(y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi) + 5 * HOUR;
  for (const g of [guess, guess - HOUR]) {
    const p = ny(g);
    if (p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi) return g;
  }
  throw new Error("nyToUtc");
}
const CLOSURES = [
  [nyToUtc(2026, 12, 24, 17, 0), nyToUtc(2026, 12, 27, 17, 0)],
  [nyToUtc(2026, 12, 31, 17, 0), nyToUtc(2027, 1, 3, 17, 0)],
];
export function expected(open: number): boolean {
  const p = ny(open);
  if (p.dow === 6 || (p.dow === 0 && p.h < 17) || (p.dow === 5 && p.h >= 17)) return false;
  return !CLOSURES.some(([a, b]) => open >= a && open < b);
}
const inWindow = (t: number) => { const p = ny(t); const m = p.h * 60 + p.mi; return p.dow >= 1 && p.dow <= 5 && m >= 120 && m < 720; };
function tday(ms: number): string {
  const p = ny(ms);
  return new Date(Date.UTC(p.y, p.mo - 1, p.d + (p.h >= 17 ? 1 : 0))).toISOString().slice(0, 10);
}
function tdayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return nyToUtc(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), 17, 0);
}
function weekOf(ms: number) {
  const p = ny(ms);
  const s = new Date(Date.UTC(p.y, p.mo - 1, p.d - p.dow)), e = new Date(Date.UTC(p.y, p.mo - 1, p.d - p.dow + 7));
  return { from: nyToUtc(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate(), 0, 0), to: nyToUtc(e.getUTCFullYear(), e.getUTCMonth() + 1, e.getUTCDate(), 0, 0) };
}

// ── Data
interface B { o: number; h: number; l: number; c: number }
export interface CDataset { start: number; end: number; bars: Record<string, Record<string, { t: number; o: number; h: number; l: number; c: number }[]>> }
type TFk = "5m" | "15m" | "1h";
const STEP: Record<TFk, number> = { "5m": MIN5, "15m": MIN15, "1h": HOUR };

class Ser {
  grid: number[] = [];
  at = new Map<number, B>();
  pos = new Map<number, number>();
  constructor(public pair: CPair, public tf: TFk, ds: CDataset) {
    const step = STEP[tf];
    for (let t = Math.ceil(ds.start / step) * step; t < ds.end; t += step) if (expected(t)) { this.pos.set(t, this.grid.length); this.grid.push(t); }
    for (const r of ds.bars[pair]?.[tf] ?? []) {
      if (r.t < ds.start || r.t >= ds.end || !this.pos.has(r.t)) continue;
      const cv = (x: number) => Math.round(x * scale(pair));
      this.at.set(r.t, { o: cv(r.o), h: cv(r.h), l: cv(r.l), c: cv(r.c) });
    }
  }
  bar(i: number): B | null { return i >= 0 && i < this.grid.length ? this.at.get(this.grid[i]) ?? null : null; }
  /** index of the last expected interval with close ≤ t */
  last(t: number): number { let i = -1; for (let lo = 0, hi = this.grid.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (this.grid[m] + STEP[this.tf] <= t) { i = m; lo = m + 1; } else hi = m - 1; } return i; }
  /** first index of the run of present bars ending at L (−1 if L missing) */
  runStart(L: number): number { if (!this.bar(L)) return -1; let i = L; while (i - 1 >= 0 && this.bar(i - 1)) i--; return i; }
  idxAtOrAfter(t: number): number { let lo = 0, hi = this.grid.length; while (lo < hi) { const m = (lo + hi) >> 1; if (this.grid[m] < t) lo = m + 1; else hi = m; } return lo; }
}

// ── Structure, recomputed from scratch inside [from, L]
interface Sw { i: number; hi: boolean; level: number; brk: number }
function swingsIn(s: Ser, from: number, L: number): Sw[] {
  const out: Sw[] = [];
  for (let i = from + 2; i + 2 <= L; i++) {
    const b = s.bar(i)!; const n = [s.bar(i - 2)!, s.bar(i - 1)!, s.bar(i + 1)!, s.bar(i + 2)!];
    if (n.every((x) => b.h > x.h)) out.push({ i, hi: true, level: b.h, brk: -1 });
    if (n.every((x) => b.l < x.l)) out.push({ i, hi: false, level: b.l, brk: -1 });
  }
  for (const w of out) {
    for (let j = w.i + 3; j <= L; j++) { const c = s.bar(j)!.c; if (w.hi ? c > w.level : c < w.level) { w.brk = j; break; } }
  }
  return out;
}
function windowFrom(s: Ser, L: number, W: number): number { const r = s.runStart(L); return r < 0 ? -1 : Math.max(r, L - W + 1); }

type D = "LONG" | "SHORT";
const up0 = (d: D) => d === "LONG";
function dirAt(S: Record<TFk, Ser>, t: number): { dir: D | "NONE"; status: string; bias: D | "NONE" } {
  const s1 = S["1h"], s15 = S["15m"];
  const L1 = s1.last(t), L15 = s15.last(t);
  const f1 = windowFrom(s1, L1, 200), f15 = windowFrom(s15, L15, 96);
  if (f1 < 0 || f15 < 0) return { dir: "NONE", status: "NOT_COMPUTABLE", bias: "NONE" };
  const r15 = s15.runStart(L15);
  if (r15 > L15 - 9) return { dir: "NONE", status: "NOT_COMPUTABLE", bias: "NONE" };
  const sw15 = swingsIn(s15, f15, L15).filter((w) => w.brk !== -1);
  if (r15 > L15 - 95 && sw15.length === 0) return { dir: "NONE", status: "NOT_COMPUTABLE", bias: "NONE" };
  const sw1 = swingsIn(s1, f1, L1).filter((w) => w.brk !== -1);
  if (sw1.length === 0) return { dir: "NONE", status: "BIAS_NONE", bias: "NONE" };
  const top = sw1.reduce((a, b) => (b.brk > a.brk ? b : a));
  const bias: D = top.hi ? "LONG" : "SHORT";
  const veto = sw15.some((w) => w.hi === (bias === "SHORT") && w.brk >= L15 - 9);
  return veto ? { dir: "NONE", status: "VETOED", bias } : { dir: bias, status: "OK", bias };
}

function atr14x14(s: Ser, i: number): number | null {
  if (i - 14 < 0) return null;
  for (let k = i - 14; k <= i; k++) if (!s.bar(k)) return null;
  let sum = 0;
  for (let k = i - 13; k <= i; k++) { const b = s.bar(k)!, pc = s.bar(k - 1)!.c; sum += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)); }
  return sum;
}

interface CPoi { id: string; pair: CPair; dir: D; type: "OB" | "FVG"; low: number; high: number; form: number; origT: number; bT: number; bClose: number; bIdx: number; legKey: string; alive: boolean; why?: string; endT?: number }
interface CLeg { key: string; dir: D; oLevel: number; bIdx: number; seen: boolean }

function legsAndPois(p: CPair, s: Ser, B: number): { legs: CLeg[]; pois: CPoi[] } {
  const legs: CLeg[] = [], pois: CPoi[] = [];
  const from = windowFrom(s, B, 200);
  if (from < 0) return { legs, pois };
  const sw = swingsIn(s, from, B);
  for (const j of sw.filter((w) => w.brk === B)) {
    const dir: D = j.hi ? "LONG" : "SHORT";
    for (const o of sw.filter((w) => w.hi !== j.hi && w.i > j.i && w.i < B)) {
      const ref = sw.filter((w) => w.hi === j.hi && w.i < o.i).reduce<Sw | null>((a, b) => (!a || b.i > a.i ? b : a), null);
      if (!ref || ref.i !== j.i) continue;
      if (B - o.i < 3) continue;
      let originBroken = false;
      for (let k = o.i + 1; k <= B; k++) { const c = s.bar(k)!.c; if (dir === "LONG" ? c < o.level : c > o.level) { originBroken = true; break; } }
      if (originBroken) continue;
      const first = Math.min(j.i - 2, o.i - 20);
      if (first < 0 || s.runStart(B) > first) continue;
      const key = `${p}|${dir}|${s.grid[o.i]}|${s.grid[B]}`;
      legs.push({ key, dir, oLevel: o.level, bIdx: B, seen: false });
      // displacement baseline
      let sb = 0, sr = 0;
      for (let k = o.i - 20; k < o.i; k++) { const b = s.bar(k)!; sb += Math.abs(b.c - b.o); sr += b.h - b.l; }
      let hiL = -Infinity, loL = Infinity, cnt = 0, d = -1, maxR = 0;
      for (let k = o.i; k <= B; k++) {
        const b = s.bar(k)!;
        hiL = Math.max(hiL, b.h); loL = Math.min(loL, b.l); maxR = Math.max(maxR, b.h - b.l);
        const body = Math.abs(b.c - b.o), rng = b.h - b.l;
        const col = dir === "LONG" ? b.c > b.o : b.c < b.o;
        // body/(sb/20) ≥ 2, body/rng ≥ 0.7, rng/(sr/20) ≥ 1.5
        if (col && body * 20 >= 2 * sb && body * 10 >= 7 * rng && rng * 20 * 2 >= 3 * sr) { cnt++; if (d < 0) d = k; }
      }
      const n = B - o.i + 1;
      if (!(cnt * 10 >= n || maxR * 20 >= 2 * sr)) continue;   // count ≥ ceil(n/10) ⇔ 10·count ≥ n
      const cand: Omit<CPoi, "id" | "alive">[] = [];
      for (let c3 = o.i + 2; c3 <= B; c3++) {
        const a = s.bar(c3 - 2)!, c = s.bar(c3)!;
        const gap = dir === "LONG" ? (c.l > a.h ? [a.h, c.l] : null) : (c.h < a.l ? [c.h, a.l] : null);
        if (!gap) continue;
        const atr = atr14x14(s, c3);
        if (atr === null || (gap[1] - gap[0]) * 140 < atr) continue;
        cand.push({ pair: p, dir, type: "FVG", low: gap[0], high: gap[1], form: s.grid[c3] + HOUR, origT: s.grid[o.i], bT: s.grid[B], bClose: s.grid[B] + HOUR, bIdx: B, legKey: key });
      }
      if (d >= 0) {
        for (let k = d - 1; k >= o.i; k--) {
          const b = s.bar(k)!;
          if (dir === "LONG" ? b.c < b.o : b.c > b.o) {
            cand.push({ pair: p, dir, type: "OB", low: b.l, high: b.h, form: s.grid[k] + HOUR, origT: s.grid[o.i], bT: s.grid[B], bClose: s.grid[B] + HOUR, bIdx: B, legKey: key });
            break;
          }
        }
      }
      for (const x of cand) {
        const ok = dir === "LONG" ? (hiL - x.high) * 2 >= hiL - loL : (x.low - loL) * 2 >= hiL - loL;
        if (ok) pois.push({ ...x, alive: true, id: `${p}|${dir}|${x.origT}|${x.bT}|${x.type}|${x.form}|${x.low}|${x.high}` });
      }
    }
  }
  return { legs, pois };
}

// ── News (§8) — own implementation
export interface CFetch { fetchTime: number; httpStatus: number; body: unknown }
function feed(fetches: CFetch[], t: number, run: number): { ok: boolean; ev: { c: string; d: number; imp: string }[] } {
  const f = fetches.filter((x) => x.fetchTime <= run).sort((a, b) => b.fetchTime - a.fetchTime)[0];
  if (!f || run - f.fetchTime > HOUR || f.httpStatus !== 200 || !Array.isArray(f.body)) return { ok: false, ev: [] };
  const w = weekOf(f.fetchTime);
  if (t < w.from || t >= w.to) return { ok: false, ev: [] };
  const ev: { c: string; d: number; imp: string }[] = [];
  for (const e of f.body as Record<string, unknown>[]) {
    if (!e || typeof e.title !== "string" || typeof e.country !== "string" || typeof e.impact !== "string" || typeof e.date !== "string") return { ok: false, ev: [] };
    if (!/(Z|[+-]\d\d:\d\d)$/.test(e.date) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(e.date)) return { ok: false, ev: [] };
    const d = Date.parse(e.date);
    if (!(d >= w.from && d < w.to)) return { ok: false, ev: [] };
    ev.push({ c: e.country, d, imp: e.impact });
  }
  return { ok: true, ev };
}
const blocked = (p: CPair, ev: { c: string; d: number; imp: string }[], t: number) => {
  const [b, q] = p.split("/");
  return ev.some((e) => e.imp === "High" && (e.c === b || e.c === q) && Math.abs(t - e.d) <= 30 * 60_000);
};

// ── Checker run
export interface CEvent { t: number; pair: string; entity: string; id: string; event: string; data?: Record<string, unknown> }
export interface CInput {
  dataset: CDataset;
  news: "REPLAY" | { fetches: CFetch[]; runClock(pair: string, t: number): number };
  schedule?: { tradable(pair: string, t: number): boolean; runTime(pair: string, t: number): number };
  /** §0.12 measured start: 5m bars opening before it are warm-up */
  measuredStart?: number;
}

export function runChecker(inp: CInput): CEvent[] {
  const ds = inp.dataset;
  const S = Object.fromEntries(PAIRS.map((p) => [p, { "5m": new Ser(p, "5m", ds), "15m": new Ser(p, "15m", ds), "1h": new Ser(p, "1h", ds) }])) as Record<CPair, Record<TFk, Ser>>;
  const out: CEvent[] = [];
  const pois = Object.fromEntries(PAIRS.map((p) => [p, [] as CPoi[]])) as Record<CPair, CPoi[]>;
  const legs = Object.fromEntries(PAIRS.map((p) => [p, [] as CLeg[]])) as Record<CPair, CLeg[]>;
  type Setup = { poi: CPoi; armIdx: number; react: number };
  type Trade = { id: string; dir: D; entry: number; sl: number; tp: number; lots: number; entryIdx: number; gap: boolean };
  const setup = {} as Record<CPair, Setup | null>, trade = {} as Record<CPair, Trade | null>, lastDir = {} as Record<CPair, string>;
  for (const p of PAIRS) { setup[p] = null; trade[p] = null; lastDir[p] = ""; }
  const tradable = (p: CPair, t: number) => inp.schedule ? inp.schedule.tradable(p, t) : true;
  const runOf = (p: CPair, t: number) => inp.schedule ? inp.schedule.runTime(p, t) : t;
  const feedOf = (p: CPair, t: number) => inp.news === "REPLAY" ? { ok: true, ev: [] } : feed(inp.news.fetches, t, inp.news.runClock(p, t));
  const g5 = S["EUR/USD"]["5m"].grid;
  const items: { run: number; t: number; p: CPair }[] = [];
  for (const o of g5) for (const p of PAIRS) items.push({ run: runOf(p, o + MIN5), t: o + MIN5, p });
  items.sort((a, b) => a.run - b.run || a.t - b.t || PAIRS.indexOf(a.p) - PAIRS.indexOf(b.p));
  const kill = (t: number, p: CPair, x: CPoi, why: string) => { x.alive = false; x.why = why; x.endT = t; out.push({ t, pair: p, entity: "POI", id: x.id, event: why }); };
  const endS = (t: number, p: CPair, why: string, data?: Record<string, unknown>) => { const s = setup[p]!; setup[p] = null; out.push({ t, pair: p, entity: "SETUP", id: s.poi.id, event: why, ...(data ? { data } : {}) }); };
  const allMissing = (tf: TFk, open: number) => PAIRS.every((q) => !S[q][tf].at.has(open));

  for (let a = 0; a < items.length;) {
    let b = a;
    while (b < items.length && items[b].run === items[a].run && items[b].t === items[a].t) b++;
    const t = items[a].t, group = items.slice(a, b).map((x) => x.p);
    a = b;
    const open5 = t - MIN5, open1 = t - HOUR;
    const h1closes = S["EUR/USD"]["1h"].pos.has(open1);
    const ctx = new Map<CPair, { tr: boolean; dir: D | "NONE"; f: { ok: boolean; ev: { c: string; d: number; imp: string }[] }; snap: CPoi[] }>();

    for (const p of group) {
      const s5 = S[p]["5m"], s1 = S[p]["1h"];
      const k = s5.pos.get(open5)!;
      const tr = tradable(p, t);
      const raw = dirAt(S[p], t);
      const key = `${raw.dir}:${raw.status}`;
      if (key !== lastDir[p]) { lastDir[p] = key; out.push({ t, pair: p, entity: "DIR", id: p, event: raw.dir, data: { status: raw.status, bias: raw.bias } }); }
      const f = feedOf(p, t);
      const bar = s5.bar(k);
      // step 1
      if (!bar) {
        const why = allMissing("5m", open5) ? "DATA_GAP_PROVIDER_WIDE" : "DATA_GAP_FRESHNESS_UNKNOWN";
        for (const x of pois[p]) if (x.alive && x.bClose <= open5) kill(t, p, x, why);
        if (setup[p]) endS(t, p, "DATA_GAP_ARMED");
        if (trade[p]) trade[p]!.gap = true;
      }
      if (h1closes && !s1.at.has(open1)) {
        const why = allMissing("1h", open1) ? "DATA_GAP_PROVIDER_WIDE" : "DATA_GAP_FRESHNESS_UNKNOWN";
        for (const x of pois[p]) if (x.alive && x.bClose <= open1) kill(t, p, x, why);
        if (setup[p] && setup[p]!.poi.bClose <= open1) endS(t, p, "DATA_GAP_ARMED");
      }
      // step 2
      if (h1closes) {
        const L = s1.pos.get(open1)!;
        const b1 = s1.bar(L);
        if (b1) {
          const r = legsAndPois(p, s1, L);
          for (const lg of r.legs) legs[p].push(lg);
          for (const x of r.pois) if (!pois[p].some((y) => y.id === x.id)) { pois[p].push(x); out.push({ t, pair: p, entity: "POI", id: x.id, event: "QUALIFIED" }); }
          for (const lg of legs[p]) {
            if (lg.seen || L <= lg.bIdx) continue;
            if (lg.dir === "LONG" ? b1.c < lg.oLevel : b1.c > lg.oLevel) {
              lg.seen = true;
              for (const x of pois[p]) if (x.alive && x.legKey === lg.key) kill(t, p, x, "LEG_INVALIDATED");
              if (setup[p] && setup[p]!.poi.legKey === lg.key) endS(t, p, "LEG_INVALIDATED");
            }
          }
        }
        for (const x of pois[p]) if (x.alive && L - x.bIdx >= 120) kill(t, p, x, "LOOKBACK_EXPIRED");
      }
      ctx.set(p, { tr, dir: tr ? raw.dir : "NONE", f, snap: pois[p].filter((x) => x.alive).map((x) => ({ ...x })) });
      if (!bar) continue;
      // step 3
      exitStep(p, k, t);
      // step 4
      if (setup[p]) setupStep(p, k, t);
    }
    // step 5
    let cands: { p: CPair; x: CPoi }[] = [];
    const warm = open5 < (inp.measuredStart ?? ds.start);
    for (const p of warm ? group : []) {
      const bar = S[p]["5m"].bar(S[p]["5m"].pos.get(open5)!);
      if (!bar) continue;
      for (const x of pois[p]) if (x.alive && x.bClose <= open5 && (x.dir === "LONG" ? bar.l <= x.high : bar.h >= x.low)) kill(t, p, x, "SPENT_WARMUP");
    }
    for (const p of warm ? [] : group) {
      const s5 = S[p]["5m"], k = s5.pos.get(open5)!, bar = s5.bar(k);
      if (!bar) continue;
      const c = ctx.get(p)!;
      for (const dir of ["LONG", "SHORT"] as D[]) {
        const touched = pois[p].filter((x) => x.alive && x.dir === dir && x.bClose <= open5 && (dir === "LONG" ? bar.l <= x.high : bar.h >= x.low));
        if (!touched.length) continue;
        const pick = touched.reduce((best, x) => {
          const better = dir === "LONG" ? x.high > best.high || (x.high === best.high && tie(x, best)) : x.low < best.low || (x.low === best.low && tie(x, best));
          return better ? x : best;
        });
        for (const x of touched) if (x !== pick) kill(t, p, x, "SPENT_SAME_BAR");
        let why: string | null = null;
        if (!inWindow(t)) why = "SPENT_OUTSIDE_WINDOW";
        else if (!c.tr) why = "SPENT_DATA_PENDING";
        else if (c.f.ok && blocked(p, c.f.ev, t)) why = "SPENT_NEWS_BLOCK";
        else if (!c.f.ok) why = "SPENT_FEED_UNAVAILABLE";
        else if (setup[p] || trade[p]) why = "SPENT_PAIR_BUSY";
        if (why) kill(t, p, pick, why); else cands.push({ p, x: pick });
      }
    }
    // CF1: a pair with an eligible LONG and an eligible SHORT on this bar arms neither
    const count = new Map<CPair, number>();
    for (const c of cands) count.set(c.p, (count.get(c.p) ?? 0) + 1);
    for (const c of cands) if (count.get(c.p)! > 1) kill(t, c.p, c.x, "SPENT_CONFLICT");
    cands = cands.filter((c) => count.get(c.p)! < 2);
    const live = PAIRS.filter((p) => setup[p] || trade[p]).length;
    const slots = 3 - live;
    let winners = cands;
    if (cands.length > slots) {
      const atrOf = (p: CPair) => { const s1 = S[p]["1h"]; return atr14x14(s1, s1.last(t)); };
      const ranked = cands.map((c) => ({ ...c, a: atrOf(c.p) })).sort((u, v) => {
        if (u.a === null && v.a !== null) return 1;
        if (v.a === null && u.a !== null) return -1;
        if (u.a !== null && v.a !== null) { const exact = spreadPts(u.p) * v.a - spreadPts(v.p) * u.a; if (exact !== 0) return exact; }
        return PAIRS.indexOf(u.p) - PAIRS.indexOf(v.p);
      });
      winners = ranked.slice(0, Math.max(0, slots));
      for (const c of ranked.slice(Math.max(0, slots))) kill(t, c.p, c.x, "SPENT_CAP");
    }
    for (const c of winners) {
      kill(t, c.p, c.x, "ARMED");
      setup[c.p] = { poi: c.x, armIdx: S[c.p]["5m"].pos.get(open5)!, react: c.x.dir === "LONG" ? Infinity : -Infinity };
      out.push({ t, pair: c.p, entity: "SETUP", id: c.x.id, event: "ARMED" });
    }
    for (const p of PAIRS) if (winners.some((w) => w.p === p)) setupStep(p, S[p]["5m"].pos.get(open5)!, t);

    function tie(x: CPoi, y: CPoi): boolean {
      if (x.form !== y.form) return x.form < y.form;
      if (x.type !== y.type) return x.type === "OB";
      return x.origT < y.origT;
    }

    function setupStep(p: CPair, k: number, t: number) {
      const s = setup[p]!, s5 = S[p]["5m"], bar = s5.bar(k)!, c = ctx.get(p)!;
      const dir = s.poi.dir;
      s.react = dir === "LONG" ? Math.min(s.react, bar.l) : Math.max(s.react, bar.h);
      // V2.1: the leg origin (step 2) is the only price-based setup end — no far-edge close, no direction flip
      if (!c.f.ok) return endS(t, p, "NEWS_FEED_UNAVAILABLE");
      // protected swing from 5m bars after the close of b, confirmed by k−1, unbroken at k−1
      const scope = s5.idxAtOrAfter(s.poi.bClose);
      let prot: { i: number; level: number } | null = null;
      for (let i = Math.max(scope, 2); i + 2 <= k - 1; i++) {
        const m = s5.bar(i)!, left = [s5.bar(i - 2), s5.bar(i - 1)];
        if (left.some((x) => !x)) continue;                       // left context may precede b but must be present
        const nb = [left[0]!, left[1]!, s5.bar(i + 1)!, s5.bar(i + 2)!];
        const isSw = dir === "LONG" ? nb.every((x) => m.h > x.h) : nb.every((x) => m.l < x.l);
        if (!isSw) continue;
        const lvl = dir === "LONG" ? m.h : m.l;
        let broken = false;
        for (let j = i + 3; j <= k - 1; j++) { const cl = s5.bar(j)!.c; if (dir === "LONG" ? cl > lvl : cl < lvl) { broken = true; break; } }
        if (!broken) prot = { i, level: lvl };
      }
      if (prot && (dir === "LONG" ? bar.c > prot.level : bar.c < prot.level)) {
        if (!c.tr) return endS(t, p, "DATA_PENDING_CONFIRMATION");
        if (blocked(p, c.f.ev, t)) return endS(t, p, "NEWS_BLOCKED_CONFIRMATION");
        out.push({ t, pair: p, entity: "SETUP", id: s.poi.id, event: "CONFIRMED" });
        return entry(p, k, t, prot.i);
      }
      if (inWindow(t) && !(expected(t) && inWindow(t + MIN5))) return endS(t, p, "EXPIRED");
    }

    function entry(p: CPair, k: number, t: number, protI: number) {
      const s = setup[p]!, s5 = S[p]["5m"], s1 = S[p]["1h"], dir = s.poi.dir, c = ctx.get(p)!;
      const e = s5.bar(k)!.c;
      // V2.1 SA1: stop = extreme of the move from the protected swing (exclusive) to the CHoCH bar (inclusive), 1-pip buffer
      let origin: number | null = up0(dir) ? Infinity : -Infinity;
      for (let i = protI + 1; i <= k; i++) { const bb = s5.bar(i); if (!bb) { origin = null; break; } origin = up0(dir) ? Math.min(origin!, bb.l) : Math.max(origin!, bb.h); }
      if (origin === null || k <= protI) return endS(t, p, "DATA_GAP_ENTRY", { entry: s5.bar(k)!.c });
      const sl = up0(dir) ? origin - PTS_PER_PIP : origin + PTS_PER_PIP;
      const dist = Math.abs(e - sl);
      const L1 = s1.last(t);
      const atr = atr14x14(s1, L1);
      const data = { entry: e, sl };
      if (atr === null) return endS(t, p, "DATA_GAP_ENTRY", data);
      if (dist * 14 * 2 > 3 * atr) return endS(t, p, "STOP_TOO_WIDE", data);
      if (dist < 3 * spreadPts(p)) return endS(t, p, "STOP_TOO_TIGHT", data);
      const opp = c.snap.filter((x) => x.dir !== dir);
      if (opp.some((x) => x.low <= e && e <= x.high)) return endS(t, p, "OPPOSING_POI_CONTAINS_ENTRY", data);
      const up = dir === "LONG";
      const beyond = (x: number) => (up ? x > e : x < e);
      // candidates
      type Cd = { price: number | null; st: "V" | "S" | "U" };
      const cs: Cd[] = [];
      // GT: any observed trade-through → swept (permanent); else unknown if the interval has a hole; else valid
      const sweepFrom = (from: number, price: number, uncertain = false): "V" | "S" | "U" => {
        let hole = uncertain;
        for (let x = from; x < (s5.grid[0] ?? Infinity); x += MIN5) if (expected(x)) { hole = true; break; }
        for (let i = s5.idxAtOrAfter(from); i <= k; i++) {
          const bb = s5.bar(i);
          if (!bb) { hole = true; continue; }
          if (up ? bb.h > price : bb.l < price) return "S";
        }
        return hole ? "U" : "V";
      };
      // (a) swings of the 1H record: any swing whose 5 bars are present and contiguous, confirmed by L1, swing bar among last 120
      const run = s1.runStart(L1);
      for (let i = Math.max(2, L1 - 119); i <= L1 - 2; i++) {
        const m = s1.bar(i); if (!m) continue;
        const nb = [s1.bar(i - 2), s1.bar(i - 1), s1.bar(i + 1), s1.bar(i + 2)];
        if (nb.some((x) => !x)) continue;
        const isSw = up ? nb.every((x) => m.h > x!.h) : nb.every((x) => m.l < x!.l);
        if (!isSw) continue;
        const lvl = up ? m.h : m.l;
        if (!beyond(lvl)) continue;
        const current = run >= 0 && i - 2 >= run;
        cs.push({ price: lvl, st: sweepFrom(s1.grid[i] + HOUR, lvl, !current) });
      }
      // (b) previous trading day
      const today = tday(open5);
      let prevTo = tdayStart(today), prevFrom = prevTo;
      for (let n = 0; n < 14; n++) {
        const pd = tday(prevTo - HOUR);
        prevFrom = tdayStart(pd);
        let any = false; for (let x = prevFrom; x < prevTo; x += MIN5) if (expected(x)) { any = true; break; }
        if (any) break;
        prevTo = prevFrom;
      }
      const ext = (from: number, to: number, keep: (x: number) => boolean) => {
        let v = up ? -Infinity : Infinity, n = 0, unknown = false;
        for (let x = from; x < to; x += MIN5) {
          if (!expected(x) || !keep(x)) continue;
          n++;
          const bb = s5.at.get(x);
          if (!bb || !s5.pos.has(x)) { unknown = true; continue; }
          v = up ? Math.max(v, bb.h) : Math.min(v, bb.l);
        }
        return { n, price: n > 0 && !unknown ? v : null };
      };
      const pdv = ext(prevFrom, prevTo, () => true);
      if (pdv.price === null) cs.push({ price: null, st: "U" });
      else if (beyond(pdv.price)) cs.push({ price: pdv.price, st: sweepFrom(prevTo, pdv.price) });
      // (c) Asian
      const [yy, mm, dd] = today.split("-").map(Number);
      const two = nyToUtc(yy, mm, dd, 2, 0);
      if (t >= two) {
        const as = ext(tdayStart(today), two, (x) => { const q = ny(x); return q.h >= 20 || q.h < 2; });
        if (as.n > 0) {
          if (as.price === null) cs.push({ price: null, st: "U" });
          else if (beyond(as.price)) cs.push({ price: as.price, st: sweepFrom(two, as.price) });
        }
      }
      const valid = cs.filter((x) => x.st === "V").map((x) => x.price!);
      let S0: number | null = valid.length ? (up ? Math.min(...valid) : Math.max(...valid)) : null;
      if (S0 !== null) {
        const edges = opp.map((x) => (up ? x.low : x.high)).filter((x) => (up ? e < x && x < S0! : S0! < x && x < e));
        if (edges.length) S0 = up ? Math.min(...edges) : Math.max(...edges);
      }
      const betw = (x: number) => (S0 === null ? beyond(x) : up ? e < x && x < S0 : S0 < x && x < e);
      const unknownOpp = pois[p].filter((x) => x.dir !== dir && !x.alive && (x.why === "DATA_GAP_FRESHNESS_UNKNOWN" || x.why === "DATA_GAP_PROVIDER_WIDE") &&
        x.endT! <= t && L1 - x.bIdx < 120 && !legs[p].find((lg) => lg.key === x.legKey)!.seen);
      const obsFail = cs.some((x) => x.st === "U" && x.price !== null && betw(x.price)) || cs.some((x) => x.price === null) ||
        unknownOpp.some((x) => (x.low <= e && e <= x.high) || betw(up ? x.low : x.high));
      if (obsFail) return endS(t, p, "DATA_GAP_ENTRY", data);
      if (S0 === null) return endS(t, p, "NO_TARGET", data);
      if ((Math.abs(S0 - e) - costPts(p)) * 2 < 3 * dist) return endS(t, p, "RR_BELOW_MIN", { ...data, tp: S0 });
      const loss = (dist + costPts(p)) / scale(p) * 100_000 * Q2USD[p];
      const lots = Math.min(20, Math.floor(500 / loss * 100 + 1e-9) / 100);
      if (lots < 0.01) return endS(t, p, "SIZING_FAILED", { ...data, tp: S0 });
      endS(t, p, "ENTERED", { ...data, tp: S0, lots });
      trade[p] = { id: `${s.poi.id}@${t}`, dir, entry: e, sl, tp: S0, lots, entryIdx: k, gap: false };
    }

    function exitStep(p: CPair, k: number, t: number) {
      const tr = trade[p];
      if (!tr || k <= tr.entryIdx) return;
      const s5 = S[p]["5m"], bar = s5.bar(k)!;
      const up = tr.dir === "LONG";
      const afterGap = !s5.bar(k - 1) || s5.grid[k - 1] + MIN5 !== s5.grid[k];
      let ex: string | null = null;
      if (afterGap) {
        if (up ? bar.o <= tr.sl : bar.o >= tr.sl) ex = "EXIT_SL";
        else if (up ? bar.o >= tr.tp : bar.o <= tr.tp) ex = "EXIT_TP";
      }
      if (!ex) {
        const hitSl = up ? bar.l <= tr.sl : bar.h >= tr.sl, hitTp = up ? bar.h >= tr.tp : bar.l <= tr.tp;
        ex = hitSl ? "EXIT_SL" : hitTp ? "EXIT_TP" : null;
      }
      if (!ex) return;
      out.push({ t, pair: p, entity: "TRADE", id: tr.id, event: ex, data: { exitPrice: ex === "EXIT_SL" ? tr.sl : tr.tp, gapDuring: tr.gap } });
      trade[p] = null;
    }
  }
  return out;
}
