/**
 * TREND_PREREG_V1 — the pure engine. Rules are docs/TREND_PREREG_V1.md, verbatim:
 * 50-day close breakout → next-open entry, fixed 2×ATR(20) stop, 20-day channel exit
 * at next open. No I/O here, so the tests can drive it bar by bar.
 *
 * CAUSALITY. A decision at bar i reads bars ≤ i only, and acts at bar i+1's open.
 * The breakout and channel windows are the PREVIOUS N bars (i−N … i−1), never bar i.
 */

export interface Bar { t: string; o: number; h: number; l: number; c: number }

export interface Params { entryN: number; exitN: number; atrN: number; stopAtr: number }
export const PRIMARY: Params = { entryN: 50, exitN: 20, atrN: 20, stopAtr: 2 };

/** Round trip in price units, plus a % of entry price, plus annual financing on notional. */
export interface Cost { roundTrip: number; roundTripPct: number; finPerYear: number }

export type ExitReason = "STOP" | "STOP_GAP" | "CHANNEL" | "OPEN";

export interface Trade {
  dir: 1 | -1;
  signalT: string; entryT: string; exitT: string;
  entry: number; stop: number; risk: number; exit: number;
  reason: ExitReason;
  days: number;
  grossR: number; costR: number; netR: number;
}

const DAY_MS = 86_400_000;

/** Wilder ATR. NaN until n true ranges exist. */
export function atrWilder(bars: Bar[], n: number): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  let atr = NaN;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    if (i < n) continue;
    if (i === n) {
      let s = 0;
      for (let k = 1; k <= n; k++) {
        const x = bars[k], p = bars[k - 1].c;
        s += Math.max(x.h - x.l, Math.abs(x.h - p), Math.abs(x.l - p));
      }
      atr = s / n;
    } else {
      atr = (atr * (n - 1) + tr) / n;
    }
    out[i] = atr;
  }
  return out;
}

const hiPrev = (bars: Bar[], i: number, n: number) => { let m = -Infinity; for (let k = i - n; k < i; k++) m = Math.max(m, bars[k].h); return m; };
const loPrev = (bars: Bar[], i: number, n: number) => { let m = Infinity; for (let k = i - n; k < i; k++) m = Math.min(m, bars[k].l); return m; };

export function costR(cost: Cost, entry: number, risk: number, days: number): number {
  return (cost.roundTrip + cost.roundTripPct * entry) / risk + (cost.finPerYear * days / 365) * entry / risk;
}

/**
 * The entry decision is injectable so the placebo can reuse the exact exit and cost
 * path: given bar i (flat, after its close), return a direction or 0.
 */
export type EntryRule = (bars: Bar[], i: number) => 1 | -1 | 0;

export const breakoutEntry = (n: number): EntryRule => (bars, i) => {
  if (bars[i].c > hiPrev(bars, i, n)) return 1;
  if (bars[i].c < loPrev(bars, i, n)) return -1;
  return 0;
};

export function runTrend(bars: Bar[], p: Params, cost: Cost, entryRule: EntryRule = breakoutEntry(p.entryN)): Trade[] {
  const atr = atrWilder(bars, p.atrN);
  const start = Math.max(p.entryN, p.exitN, p.atrN + 1);
  const trades: Trade[] = [];
  let pos: { dir: 1 | -1; signalT: string; entryT: string; entry: number; stop: number; risk: number } | null = null;
  let pendingEntry: { dir: 1 | -1; sig: number } | null = null;
  let pendingExit = false;

  const close = (i: number, exit: number, reason: ExitReason) => {
    const q = pos!;
    const days = (Date.parse(bars[i].t) - Date.parse(q.entryT)) / DAY_MS;
    const grossR = q.dir * (exit - q.entry) / q.risk;
    const c = costR(cost, q.entry, q.risk, days);
    trades.push({ ...q, exitT: bars[i].t, exit, reason, days, grossR, costR: c, netR: grossR - c });
    pos = null;
  };

  for (let i = start; i < bars.length; i++) {
    const b = bars[i];

    // 1. Orders decided at the previous close execute at this open.
    if (pendingExit && pos) { close(i, b.o, "CHANNEL"); pendingExit = false; }
    if (pendingEntry && !pos) {
      const risk = p.stopAtr * atr[pendingEntry.sig];
      pos = { dir: pendingEntry.dir, signalT: bars[pendingEntry.sig].t, entryT: b.t, entry: b.o, stop: b.o - pendingEntry.dir * risk, risk };
    }
    pendingEntry = null;

    // 2. Intraday stop, from the entry bar on. A gap through the stop fills at the open.
    if (pos) {
      const q = pos;
      if (q.dir === 1 && b.o <= q.stop) close(i, b.o, "STOP_GAP");
      else if (q.dir === -1 && b.o >= q.stop) close(i, b.o, "STOP_GAP");
      else if (q.dir === 1 && b.l <= q.stop) close(i, q.stop, "STOP");
      else if (q.dir === -1 && b.h >= q.stop) close(i, q.stop, "STOP");
    }

    // 3. At the close: channel exit for an open trade, or a new signal when flat.
    if (pos) {
      if (pos.dir === 1 && b.c < loPrev(bars, i, p.exitN)) pendingExit = true;
      if (pos.dir === -1 && b.c > hiPrev(bars, i, p.exitN)) pendingExit = true;
    } else if (i + 1 < bars.length && Number.isFinite(atr[i]) && atr[i] > 0) {
      const d = entryRule(bars, i);
      if (d !== 0) pendingEntry = { dir: d, sig: i };
    }
  }

  if (pos) {
    const last = bars.length - 1;
    close(last, bars[last].c, "OPEN");
  }
  return trades;
}

// ---- statistics ---------------------------------------------------------------------------------

/** Seeded PRNG so every bootstrap and placebo is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Summary { n: number; wr: number; exp: number; pf: number; total: number; maxDD: number; ciLo: number; ciHi: number }

export function summarize(rs: number[], seed = 1, boot = 2000): Summary {
  const n = rs.length;
  if (n === 0) return { n: 0, wr: NaN, exp: NaN, pf: NaN, total: 0, maxDD: 0, ciLo: NaN, ciHi: NaN };
  let w = 0, sw = 0, sl = 0, eq = 0, peak = 0, dd = 0;
  for (const r of rs) {
    if (r > 0) { w++; sw += r; } else sl += r;
    eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
  }
  const rnd = mulberry32(seed);
  const means: number[] = [];
  for (let b = 0; b < boot; b++) { let s = 0; for (let k = 0; k < n; k++) s += rs[Math.floor(rnd() * n)]; means.push(s / n); }
  means.sort((a, b) => a - b);
  return {
    n, wr: w / n, exp: eq / n, pf: sl === 0 ? Infinity : sw / -sl, total: eq, maxDD: dd,
    ciLo: means[Math.floor(boot * 0.025)], ciHi: means[Math.floor(boot * 0.975) - 1],
  };
}
