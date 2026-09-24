/**
 * IPO-CET-v2 EXPERIMENT 3 — unseen validation of the HTF-OPPOSED filter.
 *
 * RESEARCH ONLY. Reads local caches; writes local JSON/CSV. No database, no
 * schema, no cron, no deployment, no production code change, no SMC change, no
 * IPO rule change, no exit change.
 *
 * PRE-REGISTERED HYPOTHESIS (H3), fixed before this file saw any unseen result:
 *
 *   The IPO strategy has HIGHER expectancy when the IPO direction is OPPOSITE
 *   the Daily market structure.
 *
 *     LONG  IPO + Daily BEARISH  -> take
 *     SHORT IPO + Daily BULLISH  -> take
 *     LONG  IPO + Daily BULLISH  -> reject
 *     SHORT IPO + Daily BEARISH  -> reject
 *     Daily RANGING / UNKNOWN    -> reject, reported separately
 *
 * The sign is fixed. It is not flipped, softened or re-cut after the answer.
 *
 * ORIGIN. Experiment 2 found this post-hoc on already-studied data
 * (BOTH_OPPOSED +0.397R, PF 1.57, maxDD 15.8R). Those numbers are DISCOVERY and
 * carry no validation weight here; they appear only in the final comparison.
 *
 * ONE VARIABLE. Daily HTF structure opposition. The SMC direction verdict is
 * deliberately absent — Experiment 2 showed it flips at most twice per two-month
 * window, so its effective sample was ~14 observations, not 467 trades.
 *
 * EXITS ARE UNTOUCHED. S2 stays HTF close-confirmed. No 1m S2, no 5m S2, no hard
 * 1R stop. The 1-minute tape is used only to establish the true order of events
 * inside an HTF bar; where it cannot, the trade is TICK_REQUIRED and no guess is
 * made.
 */

import {
  analyzeMarketStructure,
  type Candle,
} from "../supabase/functions/_shared/smcAnalysis.ts";
import { isEligible } from "../supabase/functions/_shared/ipoLiveVolatility.ts";
import type { VolBucket } from "../supabase/functions/_shared/ipoRegimeDescriptors.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

interface BarRecord {
  vol: string;
  hit: {
    candidateIndex: number; direction: "demand" | "supply";
    zoneLow: number; zoneHigh: number; invalidationLevel: number;
  } | null;
}
interface WindowTable {
  window: string; instrument: string; interval: string; from: string; to: string;
  months: number; rawBars: number; droppedBars: number;
  bars: Candle[]; rows: BarRecord[];
  engineTrades: Array<{
    entryIndex: number; exitIndex: number; netR: number; vol: string; ipoIndex: number;
    direction: string; entry: number; stop: number; target: number; risk: number;
    costR: number; entryBarTime: string; exitBarTime: string;
  }>;
  completed: boolean;
}

const WIN = JSON.parse(await Deno.readTextFile("/tmp/v2-exp3-windows.json"));
const tables: Record<string, WindowTable> = JSON.parse(await Deno.readTextFile("/tmp/v2-exp3-candidates.json"));
const dailyAll: Record<string, Candle[]> = JSON.parse(await Deno.readTextFile("/tmp/v2-exp3-daily.json"));
const htfCache: Record<string, Candle[]> = JSON.parse(await Deno.readTextFile("/tmp/v2-exp3-htf.json"));
const minutes: Record<string, Candle[]> = JSON.parse(await Deno.readTextFile("/tmp/td-1m-corpus.json"));

const H = (s: string) => console.log(`\n${"=".repeat(112)}\n${s}\n${"=".repeat(112)}`);
const ms = (iso: string) => Date.parse(iso);
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isDecimalShift = (b: Candle) => b.low < Math.min(b.open, b.close) / 100;
/** Whole-bar shift: the undocumented 1m corruption found in BTC 2023-06..08. */
const isWholeBarShift = (b: Candle, ref: number) => b.high < ref / 100;

// ─────────────────────────────────────────────────────────────────────────────
// Daily HTF structure, strictly causal
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** bot-scanner's DEFAULT_CANDLE_LIMIT. Series depth changes the trend, so it is fixed. */
const DAILY_DEPTH = 300;
/** Below this the structure read is UNKNOWN rather than guessed. */
const MIN_DAILY = 20;

type Norm = "BULLISH" | "BEARISH" | "RANGING" | "UNKNOWN";
type Align = "OPPOSED" | "ALIGNED" | "RANGING" | "UNKNOWN";

const structMemo = new Map<string, { raw: string; norm: Norm; n: number; last: string }>();

/**
 * `analyzeMarketStructure(dailyCandles).trend` — the exact value bot-scanner
 * calls `htfTrend`, on exactly the daily candles that had FULLY CLOSED at or
 * before `t`. The bar in progress is never included, so nothing the entry bar
 * did can reach the structure read.
 */
function dailyStructureAt(instrument: string, t: number) {
  const series = dailyAll[`${instrument}|1day`] ?? [];
  const slice: Candle[] = [];
  for (const b of series) {
    if (ms(b.datetime) + DAY_MS <= t) slice.push(b); else break;
  }
  const d = slice.slice(-DAILY_DEPTH);
  // Identity is the suffix, so memoise on its last bar AND its length — length
  // alone saturates at the depth cap and would collide every later decision
  // point onto the first. That bug cost Experiment 2 a full rerun.
  const key = `${instrument}|${d.length}@${d.length ? d[d.length - 1].datetime : "-"}`;
  const hit = structMemo.get(key);
  if (hit) return hit;
  const out = d.length < MIN_DAILY
    ? { raw: "unavailable", norm: "UNKNOWN" as Norm, n: d.length, last: "-" }
    : (() => {
      const raw = analyzeMarketStructure(d).trend;
      return {
        raw,
        norm: (raw === "bullish" ? "BULLISH" : raw === "bearish" ? "BEARISH" : "RANGING") as Norm,
        n: d.length,
        last: d[d.length - 1].datetime,
      };
    })();
  structMemo.set(key, out);
  return out;
}

function alignmentOf(dir: "demand" | "supply", n: Norm): Align {
  if (n === "UNKNOWN") return "UNKNOWN";
  if (n === "RANGING") return "RANGING";
  const long = dir === "demand";
  // H3: opposition means the IPO trades AGAINST the daily structure.
  if (long) return n === "BEARISH" ? "OPPOSED" : "ALIGNED";
  return n === "BULLISH" ? "OPPOSED" : "ALIGNED";
}

// ─────────────────────────────────────────────────────────────────────────────
// Sequencer — a transcript of ipoLiveEngine.feed/manageOpen plus ONE gate
// ─────────────────────────────────────────────────────────────────────────────

interface Pos {
  long: boolean; entry: number; stop: number; target: number; risk: number; costR: number;
}
function manage(bars: Candle[], k: number, t: Pos) {
  const c = bars[k];
  const hitTarget = t.long ? c.high >= t.target : c.low <= t.target;
  const closedBeyond = t.long ? c.close < t.stop : c.close > t.stop;
  if (closedBeyond) {
    const gross = (t.long ? c.close - t.entry : t.entry - c.close) / t.risk;
    return { exitIndex: k, exitPrice: c.close, netR: gross - t.costR };
  }
  if (hitTarget) {
    const gross = Math.abs(t.target - t.entry) / t.risk;
    return { exitIndex: k, exitPrice: t.target, netR: gross - t.costR };
  }
  return null;
}

interface RTrade {
  window: string; instrument: string; entryIndex: number; exitIndex: number;
  ipoIndex: number; direction: "demand" | "supply"; entry: number; stop: number;
  target: number; risk: number; costR: number; vol: string;
  entryBarTime: string; exitBarTime: string; htfNetR: number;
  dailyRaw: string; dailyNorm: Norm; align: Align;
}
interface Rej { window: string; instrument: string; barTime: string; direction: string; align: Align }

function sequence(
  w: WindowTable, highVolOnly: boolean, costPerSide: (p: number) => number,
  gate: (a: Align) => boolean,
): { trades: RTrade[]; rejections: Rej[] } {
  const trades: RTrade[] = [];
  const rejections: Rej[] = [];
  let open: (RTrade & Pos) | null = null;
  let lastExit = -1;

  for (let k = 0; k < w.bars.length; k++) {
    const bar = w.bars[k];
    const bucket = w.rows[k].vol;

    if (open) {
      const done = manage(w.bars, k, open);
      if (done) {
        open.exitIndex = done.exitIndex; open.htfNetR = done.netR;
        open.exitBarTime = w.bars[done.exitIndex].datetime;
        trades.push(open); lastExit = k; open = null;
      }
    }
    if (open || k <= lastExit) continue;

    const hit = w.rows[k].hit;
    if (!hit) continue;
    if (!isEligible(bucket as VolBucket, highVolOnly)) continue;

    const long = hit.direction === "demand";
    const entry = long ? hit.zoneLow : hit.zoneHigh;
    const reached = long ? bar.low <= entry : bar.high >= entry;
    if (!reached) continue;
    const stop = hit.invalidationLevel;
    const risk = Math.abs(entry - stop);
    if (risk <= 0) continue;

    // ── the one added decision, evaluated at the entry bar's OPEN ──
    const st = dailyStructureAt(w.instrument, ms(bar.datetime));
    const align = alignmentOf(hit.direction, st.norm);
    if (!gate(align)) {
      rejections.push({ window: w.window, instrument: w.instrument, barTime: bar.datetime, direction: hit.direction, align });
      continue;
    }

    open = {
      window: w.window, instrument: w.instrument, entryIndex: k, exitIndex: -1,
      ipoIndex: hit.candidateIndex, direction: hit.direction, entry, stop,
      target: long ? entry + 2 * risk : entry - 2 * risk, risk,
      costR: (2 * costPerSide(bar.close)) / risk, vol: bucket,
      entryBarTime: bar.datetime, exitBarTime: "", htfNetR: 0,
      dailyRaw: st.raw, dailyNorm: st.norm, align, long,
    };
    const sameBar = manage(w.bars, k, open);
    if (sameBar) {
      open.exitIndex = sameBar.exitIndex; open.htfNetR = sameBar.netR;
      open.exitBarTime = w.bars[sameBar.exitIndex].datetime;
      trades.push(open); lastExit = k; open = null;
    }
  }
  return { trades, rejections };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1-minute resolution — the Experiment 1 control semantics, unchanged
// ─────────────────────────────────────────────────────────────────────────────

function tape(sym: string, fromMs: number, toMs: number, ref: number): Candle[] {
  const out: Candle[] = [];
  for (let d = new Date(fromMs).toISOString().slice(0, 10);
    Date.parse(`${d}T00:00:00Z`) <= toMs; d = addDays(d, 1)) {
    for (const m of minutes[`${sym}|${d}`] ?? []) {
      const t = ms(m.datetime);
      if (t >= fromMs && t <= toMs) out.push(m);
    }
  }
  return out.filter((m) => !isDecimalShift(m) && !isWholeBarShift(m, ref));
}

type Outcome = "TARGET" | "S2_CLOSE" | "STILL_OPEN" | "TICK_REQUIRED" | "NO_ENTRY_AT_1M" | "DATA_UNAVAILABLE";

const resolveMemo = new Map<string, { status: Outcome; netR: number | null; entryMinute: string | null }>();

function resolve(t: RTrade): { status: Outcome; netR: number | null; entryMinute: string | null } {
  const id = `${t.window}|${t.entryBarTime}`;
  const memo = resolveMemo.get(id);
  if (memo) return memo;

  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === t.instrument)!;
  const w = tables[t.window];
  const long = t.direction === "demand";
  const barStart = ms(t.entryBarTime);
  const windowEnd = ms(`${w.to}T00:00:00Z`);
  const tp = tape(t.instrument, barStart, windowEnd, t.entry);

  let out: { status: Outcome; netR: number | null; entryMinute: string | null };
  if (!tp.length) out = { status: "DATA_UNAVAILABLE", netR: null, entryMinute: null };
  else {
    const barEnd = barStart + inst.barMs;
    const eIdx = tp.findIndex((m) => {
      const x = ms(m.datetime);
      return x >= barStart && x < barEnd && (long ? m.low <= t.entry : m.high >= t.entry);
    });
    if (eIdx < 0) out = { status: "NO_ENTRY_AT_1M", netR: null, entryMinute: null };
    else {
      const em = tp[eIdx];
      // Entry and target inside the SAME minute: 1m cannot order them. No guess.
      if (long ? em.high >= t.target : em.low <= t.target) {
        out = { status: "TICK_REQUIRED", netR: null, entryMinute: em.datetime };
      } else {
        const htfBars = (htfCache[`${t.instrument}|${w.interval}|${w.from}|${w.to}`] ?? [])
          .filter((b) => !isDecimalShift(b));
        // S2 is confirmed ONLY at HTF bar closes. Unchanged from the frozen rule.
        const htfClose = new Map(htfBars.filter((b) => ms(b.datetime) >= barStart)
          .map((h) => [ms(h.datetime) + inst.barMs, h.close]));
        out = { status: "STILL_OPEN", netR: null, entryMinute: em.datetime };
        for (let i = eIdx; i < tp.length; i++) {
          const m = tp[i];
          if (long ? m.high >= t.target : m.low <= t.target) {
            out = { status: "TARGET", netR: Math.abs(t.target - t.entry) / t.risk - t.costR, entryMinute: em.datetime };
            break;
          }
          const close = htfClose.get(ms(m.datetime) + 60000);
          if (close !== undefined && (long ? close < t.stop : close > t.stop)) {
            const gross = (long ? close - t.entry : t.entry - close) / t.risk;
            out = { status: "S2_CLOSE", netR: gross - t.costR, entryMinute: em.datetime };
            break;
          }
        }
      }
    }
  }
  resolveMemo.set(id, out);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

interface Perf {
  n: number; wins: number; losses: number; win: number; avgW: number; avgL: number;
  expR: number; pf: number; totalR: number; maxDD: number; be: number; gap: number;
  winStreak: number; lossStreak: number;
}
function perf(rs: number[]): Perf | null {
  const n = rs.length;
  if (!n) return null;
  const w = rs.filter((x) => x > 0), l = rs.filter((x) => x < 0);
  const gp = w.reduce((a, x) => a + x, 0), gl = Math.abs(l.reduce((a, x) => a + x, 0));
  const tot = rs.reduce((a, x) => a + x, 0);
  let peak = 0, cum = 0, mdd = 0, ls = 0, bl = 0, ws = 0, bw = 0;
  for (const x of rs) {
    cum += x; if (cum > peak) peak = cum; if (peak - cum > mdd) mdd = peak - cum;
    if (x > 0) { ws++; ls = 0; if (ws > bw) bw = ws; } else if (x < 0) { ls++; ws = 0; if (ls > bl) bl = ls; }
  }
  const avgW = w.length ? gp / w.length : 0;
  const avgL = l.length ? -gl / l.length : 0;
  const be = (avgW + Math.abs(avgL)) > 0 ? (Math.abs(avgL) / (avgW + Math.abs(avgL))) * 100 : 0;
  const win = (w.length / n) * 100;
  return { n, wins: w.length, losses: l.length, win, avgW, avgL, expR: tot / n,
    pf: gl ? gp / gl : Infinity, totalR: tot, maxDD: mdd, be, gap: win - be, winStreak: bw, lossStreak: bl };
}

const PH = `${"cohort".padEnd(26)}${"n".padStart(6)}${"ret%".padStart(7)}${"W".padStart(6)}${"L".padStart(6)}${"win%".padStart(7)}${"BE%".padStart(7)}${"gap".padStart(7)}${"avgW".padStart(7)}${"avgL".padStart(7)}${"expR".padStart(9)}${"PF".padStart(7)}${"totR".padStart(9)}${"maxDD".padStart(8)}${"+S".padStart(4)}${"-S".padStart(4)}`;
function prow(label: string, p: Perf | null, base: number) {
  if (!p) { console.log(`${label.padEnd(26)}${"0".padStart(6)}   — no trades`); return; }
  console.log(`${label.padEnd(26)}${String(p.n).padStart(6)}${(base ? p.n / base * 100 : 0).toFixed(0).padStart(7)}` +
    `${String(p.wins).padStart(6)}${String(p.losses).padStart(6)}${p.win.toFixed(1).padStart(7)}${p.be.toFixed(1).padStart(7)}` +
    `${p.gap.toFixed(1).padStart(7)}${p.avgW.toFixed(2).padStart(7)}${p.avgL.toFixed(2).padStart(7)}` +
    `${p.expR.toFixed(3).padStart(9)}${(p.pf === Infinity ? 99.99 : p.pf).toFixed(2).padStart(7)}` +
    `${p.totalR.toFixed(1).padStart(9)}${p.maxDD.toFixed(1).padStart(8)}${String(p.winStreak).padStart(4)}${String(p.lossStreak).padStart(4)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — sequencer equivalence on the unseen data
// ─────────────────────────────────────────────────────────────────────────────

const OPEN_GATE = () => true;

H("PART 1 — sequencer equivalence with the unmodified ipoLiveEngine, on the unseen windows");
{
  let checked = 0, mismatches = 0;
  for (const w of Object.values(tables)) {
    if (!w.completed) continue;
    const inst = IPO_INSTRUMENTS.find((i) => i.instrument === w.instrument)!;
    const got = sequence(w, inst.highVolOnly, inst.costPerSide, OPEN_GATE).trades;
    const want = w.engineTrades;
    if (got.length !== want.length) {
      console.log(`  ${w.window}: ${got.length} vs engine ${want.length}  <-- MISMATCH`); mismatches++; continue;
    }
    let bad = 0;
    for (let i = 0; i < got.length; i++) {
      const a = got[i], b = want[i];
      const same = a.entryIndex === b.entryIndex && a.exitIndex === b.exitIndex &&
        a.ipoIndex === b.ipoIndex && a.direction === b.direction && a.vol === b.vol &&
        Math.abs(a.entry - b.entry) < 1e-12 && Math.abs(a.stop - b.stop) < 1e-12 &&
        Math.abs(a.target - b.target) < 1e-12 && Math.abs(a.risk - b.risk) < 1e-12 &&
        Math.abs(a.costR - b.costR) < 1e-12 && Math.abs(a.htfNetR - b.netR) < 1e-9;
      if (!same) bad++;
    }
    checked += got.length;
    if (bad) { console.log(`  ${w.window}: ${bad}/${got.length} differ  <-- MISMATCH`); mismatches++; }
  }
  if (mismatches) { console.error(`\nFATAL: sequencer not equivalent in ${mismatches} window(s).`); Deno.exit(1); }
  console.log(`  ${checked} trades across ${Object.keys(tables).length} unseen window-instruments reproduce ` +
    `ipoLiveEngine.replay() field-for-field. Sequencer validated on data it has not seen.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — the five replays
// ─────────────────────────────────────────────────────────────────────────────

const GATES: Array<[string, (a: Align) => boolean]> = [
  ["A_BASELINE", () => true],
  ["B_HTF_OPPOSED", (a) => a === "OPPOSED"],
  ["C_HTF_ALIGNED", (a) => a === "ALIGNED"],
  ["D_RANGING", (a) => a === "RANGING"],
  ["E_UNKNOWN", (a) => a === "UNKNOWN"],
];

interface Variant {
  label: string;
  trades: RTrade[];
  rejections: Rej[];
  resolved: Array<{ t: RTrade; netR: number }>;
  unresolved: Record<string, number>;
  newTrades: number;
  dropped: number;
}
const variants: Variant[] = [];
let baselineIds = new Set<string>();

for (const [label, gate] of GATES) {
  const trades: RTrade[] = [];
  const rejections: Rej[] = [];
  for (const w of Object.values(tables)) {
    if (!w.completed) continue;
    const inst = IPO_INSTRUMENTS.find((i) => i.instrument === w.instrument)!;
    const r = sequence(w, inst.highVolOnly, inst.costPerSide, gate);
    trades.push(...r.trades); rejections.push(...r.rejections);
  }
  const resolved: Array<{ t: RTrade; netR: number }> = [];
  const unresolved: Record<string, number> = {};
  for (const t of trades) {
    const o = resolve(t);
    if (o.netR !== null && (o.status === "TARGET" || o.status === "S2_CLOSE")) resolved.push({ t, netR: o.netR });
    else unresolved[o.status] = (unresolved[o.status] ?? 0) + 1;
  }
  const ids = new Set(trades.map((t) => `${t.window}|${t.entryBarTime}`));
  if (label === "A_BASELINE") baselineIds = ids;
  variants.push({
    label, trades, rejections, resolved, unresolved,
    newTrades: [...ids].filter((i) => !baselineIds.has(i)).length,
    dropped: [...baselineIds].filter((i) => !ids.has(i)).length,
  });
}

const V = (l: string) => variants.find((v) => v.label === l)!;
const base = V("A_BASELINE");
const opp = V("B_HTF_OPPOSED");
const ali = V("C_HTF_ALIGNED");

H("PART 2 — accounting invariants");
console.log(`${"variant".padEnd(18)}${"taken".padStart(8)}${"refused".padStart(9)}${"candidates".padStart(12)}` +
  `${"resolved".padStart(10)}${"new".padStart(6)}${"dropped".padStart(9)}  unresolved`);
for (const v of variants) {
  const cand = v.trades.length + v.rejections.length;
  const sum = v.resolved.length + Object.values(v.unresolved).reduce((a, b) => a + b, 0);
  if (sum !== v.trades.length) { console.error(`INVARIANT FAIL ${v.label}: ${sum} != ${v.trades.length}`); Deno.exit(1); }
  const ids = v.trades.map((t) => `${t.window}|${t.entryBarTime}`);
  if (new Set(ids).size !== ids.length) { console.error(`INVARIANT FAIL ${v.label}: duplicate trades`); Deno.exit(1); }
  console.log(`${v.label.padEnd(18)}${String(v.trades.length).padStart(8)}${String(v.rejections.length).padStart(9)}` +
    `${String(cand).padStart(12)}${String(v.resolved.length).padStart(10)}${String(v.newTrades).padStart(6)}` +
    `${String(v.dropped).padStart(9)}  ${JSON.stringify(v.unresolved)}`);
}
{
  // The four gates B..E partition the baseline candidate set exactly once each.
  const byAlign: Record<string, number> = {};
  for (const t of base.trades) byAlign[t.align] = (byAlign[t.align] ?? 0) + 1;
  console.log(`\n  baseline trades by daily alignment: ${JSON.stringify(byAlign)} ` +
    `sum ${Object.values(byAlign).reduce((a, b) => a + b, 0)} == ${base.trades.length}`);
  console.log(`  accepted + rejected = candidate population, asserted per variant above.`);
  console.log(`  one open position per instrument: structural in the sequencer (open || k <= lastExit).`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — headline
// ─────────────────────────────────────────────────────────────────────────────

const Rs = (v: Variant) => v.resolved.map((x) => x.netR);
const baseN = base.resolved.length;

H("PART 3 — TRUE FILTERED REPLAY, unseen data (primary result)");
console.log(PH);
for (const v of variants) prow(v.label, perf(Rs(v)), baseN);

H("PART 4 — FIXED POPULATION cohorts (diagnostic; baseline trades filtered by tag)");
{
  const rows = base.resolved;
  console.log(PH);
  prow("BASELINE", perf(rows.map((x) => x.netR)), rows.length);
  for (const a of ["OPPOSED", "ALIGNED", "RANGING", "UNKNOWN"] as Align[]) {
    prow(a, perf(rows.filter((x) => x.t.align === a).map((x) => x.netR)), rows.length);
  }
  const c: Record<string, number> = {};
  for (const x of rows) c[x.t.align] = (c[x.t.align] ?? 0) + 1;
  const sum = Object.values(c).reduce((a, b) => a + b, 0);
  if (sum !== rows.length) { console.error(`INVARIANT FAIL: cohort partition ${sum} != ${rows.length}`); Deno.exit(1); }
  console.log(`  partition ${JSON.stringify(c)} sum ${sum} == ${rows.length} OK`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 5 — per instrument, long/short, windows, concentration
// ─────────────────────────────────────────────────────────────────────────────

const INST = ["EUR/USD", "USD/JPY", "BTC/USD"];

H("PART 5 — per instrument (true filtered replay)");
for (const inst of INST) {
  console.log(`\n  ${inst}`);
  console.log("  " + PH);
  const bn = base.resolved.filter((x) => x.t.instrument === inst).length;
  for (const v of variants) prow("  " + v.label, perf(v.resolved.filter((x) => x.t.instrument === inst).map((x) => x.netR)), bn);
}

H("PART 6 — long vs short");
for (const v of [base, opp, ali]) {
  console.log(`\n  ${v.label}`);
  console.log("  " + PH);
  for (const [lab, dir] of [["LONG", "demand"], ["SHORT", "supply"]] as Array<[string, string]>) {
    const bn = base.resolved.filter((x) => x.t.direction === dir).length;
    prow("  " + lab, perf(v.resolved.filter((x) => x.t.direction === dir).map((x) => x.netR)), bn);
  }
}

const WIDS: string[] = WIN.windows.map((w: { id: string }) => w.id);

H("PART 7 — window consistency");
console.log(`${"window".padEnd(10)}${"span".padEnd(24)}${"base n".padStart(7)}${"base expR".padStart(10)}${"base PF".padStart(8)}` +
  `${"base totR".padStart(10)}${"opp n".padStart(7)}${"opp expR".padStart(9)}${"opp PF".padStart(8)}${"opp totR".padStart(9)}` +
  `${"ali n".padStart(7)}${"ali expR".padStart(9)}  >base  >ali`);
let oppPositive = 0, oppBeats = 0, oppCounted = 0, oppBeatsAli = 0;
for (const wid of WIDS) {
  const wmeta = WIN.windows.find((x: { id: string }) => x.id === wid);
  const b = perf(base.resolved.filter((x) => x.t.window.startsWith(wid + "-")).map((x) => x.netR));
  const o = perf(opp.resolved.filter((x) => x.t.window.startsWith(wid + "-")).map((x) => x.netR));
  const a = perf(ali.resolved.filter((x) => x.t.window.startsWith(wid + "-")).map((x) => x.netR));
  if (o) {
    oppCounted++;
    if (o.totalR > 0) oppPositive++;
    if (b && o.expR > b.expR) oppBeats++;
    if (a && o.expR > a.expR) oppBeatsAli++;
  }
  console.log(`${wid.padEnd(10)}${`${wmeta.from}..${wmeta.to}`.padEnd(24)}` +
    `${String(b?.n ?? 0).padStart(7)}${(b ? b.expR.toFixed(3) : "—").padStart(10)}${(b ? b.pf.toFixed(2) : "—").padStart(8)}` +
    `${(b ? b.totalR.toFixed(1) : "—").padStart(10)}${String(o?.n ?? 0).padStart(7)}${(o ? o.expR.toFixed(3) : "—").padStart(9)}` +
    `${(o ? o.pf.toFixed(2) : "—").padStart(8)}${(o ? o.totalR.toFixed(1) : "—").padStart(9)}` +
    `${String(a?.n ?? 0).padStart(7)}${(a ? a.expR.toFixed(3) : "—").padStart(9)}  ` +
    `${b && o ? (o.expR > b.expR ? " YES " : " no  ") : "  —  "}` +
    `${a && o ? (o.expR > a.expR ? " YES" : " no") : "  —"}`);
}
console.log(`\n  HTF_OPPOSED positive in ${oppPositive}/${oppCounted} windows; beats baseline expectancy in ` +
  `${oppBeats}/${oppCounted}; beats the ALIGNED cohort — the contrast H3 actually asserts — in ${oppBeatsAli}/${oppCounted}`);

console.log(`\n  opposed minus aligned, per instrument (the discovery contrast, +0.44R on studied data):`);
for (const inst of INST) {
  const o = perf(opp.resolved.filter((x) => x.t.instrument === inst).map((x) => x.netR));
  const a = perf(ali.resolved.filter((x) => x.t.instrument === inst).map((x) => x.netR));
  console.log(`    ${inst.padEnd(9)} opposed ${o ? `${o.expR >= 0 ? "+" : ""}${o.expR.toFixed(3)} (n=${o.n})`.padEnd(20) : "—".padEnd(20)}` +
    `aligned ${a ? `${a.expR >= 0 ? "+" : ""}${a.expR.toFixed(3)} (n=${a.n})`.padEnd(20) : "—".padEnd(20)}` +
    `delta ${o && a ? `${o.expR - a.expR >= 0 ? "+" : ""}${(o.expR - a.expR).toFixed(3)}` : "—"}` +
    `${o && a && o.expR > a.expR ? "   replicates discovery" : "   REVERSES"}`);
}

H("PART 8 — concentration of HTF_OPPOSED");
{
  const p = perf(Rs(opp));
  if (!p) console.log("  no resolved HTF_OPPOSED trades");
  else {
    console.log(`  total ${p.totalR.toFixed(1)}R over ${p.n} trades`);
    for (const [gname, key] of [
      ["instrument", (x: { t: RTrade }) => x.t.instrument],
      ["direction", (x: { t: RTrade }) => x.t.direction === "demand" ? "LONG" : "SHORT"],
      ["window", (x: { t: RTrade }) => x.t.window.split("-")[0]],
      ["instrument x direction", (x: { t: RTrade }) => `${x.t.instrument} ${x.t.direction === "demand" ? "LONG" : "SHORT"}`],
    ] as Array<[string, (x: { t: RTrade }) => string]>) {
      const by: Record<string, number[]> = {};
      for (const x of opp.resolved) (by[key(x)] ??= []).push(x.netR);
      const rows = Object.entries(by).map(([k, v]) => ({ k, n: v.length, r: v.reduce((a, y) => a + y, 0) }))
        .sort((a, b) => b.r - a.r);
      for (const r of rows) {
        const sN = r.n / p.n * 100, sR = p.totalR !== 0 ? r.r / p.totalR * 100 : 0;
        const flag = sN < 20 && sR > 50 ? "  <-- CONCENTRATION FLAG" : "";
        console.log(`    ${gname.padEnd(22)} ${r.k.padEnd(18)} ${String(r.n).padStart(4)} trades (${sN.toFixed(0)}% of n)  ` +
          `${r.r.toFixed(1).padStart(7)}R (${sR.toFixed(0)}% of total)${flag}`);
      }
    }
  }
}

H("PART 9 — daily structure state distribution and persistence");
{
  console.log(`${"window".padEnd(16)}${"n".padStart(5)}  states`);
  for (const w of Object.values(tables)) {
    const set = base.trades.filter((t) => t.window === w.window);
    const c: Record<string, number> = {};
    let flips = 0;
    for (let i = 0; i < set.length; i++) {
      c[set[i].dailyNorm] = (c[set[i].dailyNorm] ?? 0) + 1;
      if (i && set[i].dailyNorm !== set[i - 1].dailyNorm) flips++;
    }
    console.log(`${w.window.padEnd(16)}${String(set.length).padStart(5)}  ` +
      `${Object.entries(c).map(([k, v]) => `${k}:${v}`).join(" ").padEnd(40)} flips=${flips}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 10 — pre-registered success criteria
// ─────────────────────────────────────────────────────────────────────────────

H("PART 10 — pre-registered success criteria (fixed before the unseen run)");
{
  const p = perf(Rs(opp))!;
  const b = perf(Rs(base))!;
  const instPos = INST.filter((i) => {
    const q = perf(opp.resolved.filter((x) => x.t.instrument === i).map((x) => x.netR));
    return q && q.expR > 0;
  });
  // Concentration: any subgroup <20% of n contributing >50% of profit
  // The pre-registered concentration test names three groupings: instrument,
  // direction, window. It is evaluated on exactly those, because widening it
  // after seeing the answer would be moving the goalposts. The finer
  // instrument x direction grouping is evaluated too and reported SEPARATELY,
  // because it is what the concentration section of the report actually shows
  // and hiding it behind the narrower pre-registered scope would be misleading.
  const concentrated = (keys: Array<(x: { t: RTrade }) => string>) => {
    const hits: string[] = [];
    for (const key of keys) {
      const by: Record<string, number[]> = {};
      for (const x of opp.resolved) (by[key(x)] ??= []).push(x.netR);
      for (const [k, v] of Object.entries(by)) {
        const r = v.reduce((a, y) => a + y, 0);
        if (v.length / p.n < 0.20 && p.totalR > 0 && r / p.totalR > 0.50) {
          hits.push(`${k} ${(v.length / p.n * 100).toFixed(0)}% of n / ${(r / p.totalR * 100).toFixed(0)}% of profit`);
        }
      }
    }
    return hits;
  };
  const preRegHits = concentrated([
    (x) => x.t.instrument,
    (x) => x.t.direction === "demand" ? "LONG" : "SHORT",
    (x) => x.t.window.split("-")[0],
  ]);
  const finerHits = concentrated([
    (x) => `${x.t.instrument} ${x.t.direction === "demand" ? "LONG" : "SHORT"}`,
  ]);
  const flagged = preRegHits.length > 0;
  const crit: Array<[string, boolean, string]> = [
    ["1. expectancy > +0.15R after costs", p.expR > 0.15, `${p.expR.toFixed(3)}R`],
    ["2. PF >= 1.20", p.pf >= 1.20, p.pf.toFixed(2)],
    ["3. positive total R", p.totalR > 0, `${p.totalR.toFixed(1)}R`],
    ["4. positive in >= 60% of unseen windows", oppCounted > 0 && oppPositive / oppCounted >= 0.60, `${oppPositive}/${oppCounted}`],
    ["5. no catastrophic drawdown increase vs baseline", p.maxDD <= b.maxDD * 1.5, `${p.maxDD.toFixed(1)}R vs baseline ${b.maxDD.toFixed(1)}R`],
    ["6. no tiny subgroup explains majority of profit", !flagged,
      flagged ? `FLAGGED: ${preRegHits.join("; ")}` : "clean at the pre-registered scope (instrument / direction / window)"],
    ["7. retained trade count meaningful", p.n >= 100, `${p.n} trades (${(p.n / b.n * 100).toFixed(0)}% retained)`],
    ["8. at least 2 instruments positive", instPos.length >= 2, `${instPos.length} (${instPos.join(", ") || "none"})`],
  ];
  let passed = 0;
  for (const [c, ok, detail] of crit) { console.log(`  [${ok ? "PASS" : "FAIL"}] ${c.padEnd(52)} ${detail}`); if (ok) passed++; }
  console.log(`\n  ${passed}/8 pre-registered criteria met`);
  console.log(`  NOT pre-registered, reported anyway — finer instrument x direction grouping: ` +
    `${finerHits.length ? "FLAGGED: " + finerHits.join("; ") : "clean"}`);
  console.log(`  stronger-evidence bar: PF >= 1.30 ${p.pf >= 1.30 ? "MET" : "not met"} (${p.pf.toFixed(2)}); ` +
    `expR >= +0.20 ${p.expR >= 0.20 ? "MET" : "not met"} (${p.expR.toFixed(3)})`);

  H("PART 11 — discovery vs unseen");
  const D = { expR: 0.397, pf: 1.57, maxDD: 15.8 };
  console.log(`  discovery (Exp 2, already-studied data)  expR +${D.expR.toFixed(3)}  PF ${D.pf.toFixed(2)}  maxDD ${D.maxDD.toFixed(1)}R`);
  console.log(`  unseen validation                        expR ${p.expR >= 0 ? "+" : ""}${p.expR.toFixed(3)}  PF ${p.pf.toFixed(2)}  maxDD ${p.maxDD.toFixed(1)}R`);
  console.log(`  same-run baseline                        expR ${b.expR >= 0 ? "+" : ""}${b.expR.toFixed(3)}  PF ${b.pf.toFixed(2)}  maxDD ${b.maxDD.toFixed(1)}R`);
  const aP = perf(Rs(ali));
  console.log(`  aligned diagnostic                       expR ${aP ? (aP.expR >= 0 ? "+" : "") + aP.expR.toFixed(3) : "—"}  ` +
    `PF ${aP ? aP.pf.toFixed(2) : "—"}`);
  const lift = p.expR - b.expR;
  const vsAligned = aP ? p.expR - aP.expR : NaN;
  const retention = p.expR / D.expR;
  console.log(`\n  opposed minus baseline:  ${lift >= 0 ? "+" : ""}${lift.toFixed(3)}R`);
  console.log(`  opposed minus aligned:   ${vsAligned >= 0 ? "+" : ""}${vsAligned.toFixed(3)}R  (discovery had +0.44R on this contrast)`);
  console.log(`  fraction of discovery expectancy retained: ${(retention * 100).toFixed(0)}%`);
  const band = vsAligned < -0.05 ? "effect reversed"
    : p.expR > 0.15 && p.pf >= 1.20 && vsAligned > 0.05 ? "effect retained"
    : vsAligned > 0.05 ? "effect weakened"
    : "effect vanished";
  console.log(`  -> ${band}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 12 — machine-readable output
// ─────────────────────────────────────────────────────────────────────────────

const oppIds = new Set(opp.trades.map((t) => `${t.window}|${t.entryBarTime}`));
const flat = variants.flatMap((v) =>
  v.trades.map((t) => {
    const o = resolve(t);
    const id = `${t.window}|${t.entryBarTime}`;
    return {
      replay: v.label,
      trade_id: id,
      instrument: t.instrument,
      window: t.window,
      ipo_direction: t.direction === "demand" ? "LONG" : "SHORT",
      ipo_timestamp: tables[t.window].bars[t.ipoIndex]?.datetime ?? "",
      entry_bar_time: t.entryBarTime,
      entry_timestamp: o.entryMinute ?? t.entryBarTime,
      daily_structure_raw: t.dailyRaw,
      daily_structure_normalized: t.dailyNorm as string,
      alignment_state: t.align as string,
      entry_price: t.entry,
      s2: t.stop,
      target: t.target,
      exit_reason: o.status as string,
      net_r: o.netR as number | null,
      filter_result: "ACCEPTED",
      freed_slot: (v.label !== "A_BASELINE" && !baselineIds.has(id)) as boolean,
    };
  }).concat(
    v.rejections.map((r) => ({
      replay: v.label,
      trade_id: `${r.window}|${r.barTime}`,
      instrument: r.instrument,
      window: r.window,
      ipo_direction: r.direction === "demand" ? "LONG" : "SHORT",
      ipo_timestamp: "",
      entry_bar_time: r.barTime,
      entry_timestamp: "",
      daily_structure_raw: "",
      daily_structure_normalized: "",
      alignment_state: r.align as string,
      entry_price: NaN,
      s2: NaN,
      target: NaN,
      exit_reason: "REJECTED_BY_FILTER",
      net_r: null,
      filter_result: `REJECTED:${r.align}`,
      freed_slot: false as boolean,
    })),
  )
);
await Deno.writeTextFile("/tmp/v2-exp3-htf-opposed.json", JSON.stringify(flat, null, 1));
const cols = Object.keys(flat[0]);
await Deno.writeTextFile("/tmp/v2-exp3-htf-opposed.csv",
  [cols.join(",")].concat(flat.map((r) =>
    cols.map((c) => {
      const v = (r as Record<string, unknown>)[c];
      return v === null || v === undefined || (typeof v === "number" && Number.isNaN(v)) ? "" : String(v);
    }).join(","))).join("\n"));

console.log(`\nwrote ${flat.length} rows to /tmp/v2-exp3-htf-opposed.{json,csv}`);
console.log(`daily structure states computed: ${structMemo.size}; trades resolved from 1m: ${resolveMemo.size}`);
console.log(`HTF_OPPOSED freed-slot admissions: ${[...oppIds].filter((i) => !baselineIds.has(i)).length}`);
