/**
 * IPO-CET-v2 EXPERIMENT 1 — S2 confirmation timeframe.
 *
 * RESEARCH ONLY. Reads local research JSON and Twelve Data 1m; writes local
 * JSON/CSV. No database, no strategy code, no production import, no deployment.
 *
 * ONE VARIABLE. Entry, target, S2 PRICE, costs, sequencing and the trade
 * population are frozen to the causally-corrected v1. The only thing that moves
 * is the timeframe on which a close beyond S2 confirms invalidation:
 *
 *   A  S2_HTF_CONTROL   the setup bar closes beyond S2   (1h / 30min / 1h)
 *   B  S2_5M_CLOSE      a completed 5m bar closes beyond S2
 *   C  S2_1M_CLOSE      a completed 1m bar closes beyond S2
 *
 * A WICK THROUGH S2 IS NEVER AN EXIT, at any resolution. That rule is the point
 * of S2 and the experiment does not weaken it — it only asks how long a close
 * should take to confirm.
 *
 * TARGET DETECTION IS HELD CONSTANT ACROSS ALL THREE at 1-minute resolution.
 * That is what makes this a one-variable test. It also means version A is a
 * RECONSTRUCTED control rather than a byte-copy of the v1 causal run, which
 * detected the target on the HTF bar high. Both are reported.
 *
 * THE POPULATION IS FROZEN. An earlier exit in B or C frees the
 * one-position-per-instrument slot sooner and would, in a live system, admit
 * trades v1 never took. Those are NOT added here: adding them would change the
 * population and break the one-variable isolation. The effect is that B and C
 * are measured conservatively — any benefit from faster slot recycling is
 * excluded, not counted.
 *
 * 5m CANDLES ARE BUILT FROM THE SAME 1m PROVIDER TAPE on UTC-aligned
 * boundaries, so no second feed is introduced.
 */

import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";

const KEY = Deno.env.get("TWELVE_DATA_API_KEY");
if (!KEY) { console.error("TWELVE_DATA_API_KEY not set; refusing to run."); Deno.exit(1); }

const M_CACHE = "/tmp/td-1m-corpus.json";
let minutes: Record<string, Candle[]> = JSON.parse(await Deno.readTextFile(M_CACHE));
let requests = 0, rateLimited = 0, apiErrors = 0;

const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function fetchBlock(symbol: string, start: string): Promise<void> {
  const u = new URL("https://api.twelvedata.com/time_series");
  u.searchParams.set("symbol", symbol); u.searchParams.set("interval", "1min");
  u.searchParams.set("outputsize", "5000"); u.searchParams.set("order", "ASC");
  u.searchParams.set("timezone", "UTC");
  u.searchParams.set("start_date", `${start} 00:00:00`);
  u.searchParams.set("end_date", `${addDays(start, 3)} 00:00:00`);
  u.searchParams.set("apikey", KEY!);
  // deno-lint-ignore no-explicit-any
  let b: any = {};
  for (let a = 0; a < 8; a++) {
    requests++;
    const res = await fetch(u); b = await res.json();
    if (b?.status !== "error") break;
    if (String(b?.code) === "429") { rateLimited++; await new Promise((s) => setTimeout(s, 65_000)); continue; }
    apiErrors++; throw new Error(`twelvedata ${b?.code}`);
  }
  if (b?.status === "error") { apiErrors++; throw new Error("gave up"); }
  const rows: Candle[] = (b?.values ?? []).map((v: Record<string, string>) => ({
    datetime: `${v.datetime.replace(" ", "T")}Z`,
    open: Number(v.open), high: Number(v.high), low: Number(v.low),
    close: Number(v.close), volume: Number(v.volume ?? 0),
  }));
  for (let i = 0; i < 3; i++) {
    const d = addDays(start, i);
    minutes[`${symbol}|${d}`] = rows.filter((r) => r.datetime.slice(0, 10) === d);
  }
  await Deno.writeTextFile(M_CACHE, JSON.stringify(minutes));
  await new Promise((s) => setTimeout(s, 9000));
}

// ── ensure full 1m coverage of every window ──────────────────────────────────

interface TD {
  entryIndex: number; exitIndex: number; netR: number; vol: string; ipoIndex: number;
  direction: string; entry: number; stop: number; target: number; risk: number;
  costR: number; entryBarTime: string; exitBarTime: string; ipoCandleTime: string;
}
interface Ckpt { window: string; instrument: string; from: string; to: string;
  completed: boolean; trades_detail: TD[] }
const ck: Record<string, Ckpt> = JSON.parse(
  await Deno.readTextFile("/tmp/baseline-determinism-checkpoint.json"));
const htfCache: Record<string, Candle[]> = JSON.parse(
  await Deno.readTextFile("/tmp/td-htf-windows.json"));

const wanted = new Set<string>();
for (const c of Object.values(ck)) {
  if (!c.completed) continue;
  for (let d = c.from; d < c.to; d = addDays(d, 1)) wanted.add(`${c.instrument}|${d}`);
}
const missing = [...wanted].filter((k) => !minutes[k]).sort();
console.log(`1m coverage: ${wanted.size - missing.length}/${wanted.size} days present, ${missing.length} to fetch`);
const blocks = new Set<string>();
for (const k of missing) {
  const [sym, day] = k.split("|");
  const ed = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000);
  blocks.add(`${sym}|${new Date((ed - (ed % 3)) * 86400000).toISOString().slice(0, 10)}`);
}
let done = 0;
for (const b of [...blocks].sort()) {
  const [sym, start] = b.split("|");
  try { await fetchBlock(sym, start); } catch (e) { console.log(`  fetch fail ${b}: ${(e as Error).message}`); }
  if (++done % 20 === 0) console.log(`  fetched ${done}/${blocks.size} blocks`);
}
console.log(`fetch complete: ${requests} requests, ${rateLimited} 429s, ${apiErrors} errors\n`);

// ── execution tape ───────────────────────────────────────────────────────────

const isDecimalShift = (b: Candle) => b.low < Math.min(b.open, b.close) / 100;
/** Whole-bar shift, the undocumented 1m corruption found in BTC 2023-06..08. */
const isWholeBarShift = (b: Candle, ref: number) => b.high < ref / 100;

function tape(sym: string, fromMs: number, toMs: number, ref: number): Candle[] {
  const out: Candle[] = [];
  for (let d = new Date(fromMs).toISOString().slice(0, 10);
       Date.parse(`${d}T00:00:00Z`) <= toMs; d = addDays(d, 1)) {
    for (const m of minutes[`${sym}|${d}`] ?? []) {
      const t = Date.parse(m.datetime);
      if (t >= fromMs && t <= toMs) out.push(m);
    }
  }
  return out.filter((m) => !isDecimalShift(m) && !isWholeBarShift(m, ref));
}

/** UTC-aligned 5m candles from the 1m tape. open=first, high=max, low=min, close=last. */
function to5m(ms: readonly Candle[]): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const m of ms) {
    const t = Date.parse(m.datetime);
    const b = t - (t % 300000);
    (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(m);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, g]) => ({
    datetime: new Date(b + 300000).toISOString().replace(".000Z", "Z"),  // close TIME
    open: g[0].open, high: Math.max(...g.map((x) => x.high)),
    low: Math.min(...g.map((x) => x.low)), close: g[g.length - 1].close, volume: 0,
  }));
}

// ── the three versions ───────────────────────────────────────────────────────

type Version = "A_HTF" | "B_5M" | "C_1M";
type Outcome = "TARGET" | "S2_CLOSE" | "STILL_OPEN" | "TICK_REQUIRED"
  | "NO_ENTRY_AT_1M" | "DATA_UNAVAILABLE";

interface Res {
  outcome: Outcome; exitTime: string | null; exitPrice: number | null;
  grossR: number | null; netR: number | null; mfeR: number; maeR: number;
  entryMinute: string | null;
}

/**
 * Walks the minute tape once per version.
 *
 * Target is tested on every minute in all three versions. S2 is tested only on
 * the boundaries the version confirms at: HTF bar closes, 5m closes, or every
 * minute. Whichever fires FIRST in time ends the trade; a target and an S2
 * close inside the same confirmation interval resolve to TARGET, because the
 * close is that interval's last event and the high cannot follow it.
 */
function runVersion(
  v: Version, long: boolean, entry: number, s2: number, target: number, risk: number,
  costR: number, ms: readonly Candle[], entryIdx: number, htf: readonly Candle[], barMs: number,
): Res {
  const em = ms[entryIdx];
  const base: Res = { outcome: "STILL_OPEN", exitTime: null, exitPrice: null,
    grossR: null, netR: null, mfeR: 0, maeR: 0, entryMinute: em.datetime };

  const five = v === "B_5M" ? to5m(ms.slice(entryIdx)) : [];
  const fiveClose = new Map(five.map((f) => [Date.parse(f.datetime), f.close]));
  // HTF close times and closes, for version A.
  const htfClose = new Map(htf.map((h) => [Date.parse(h.datetime) + barMs, h.close]));

  let mfe = 0, mae = 0;
  for (let i = entryIdx; i < ms.length; i++) {
    const m = ms[i];
    const favR = (long ? m.high - entry : entry - m.low) / risk;
    const advR = (long ? entry - m.low : m.high - entry) / risk;
    if (favR > mfe) mfe = favR;
    if (advR > mae) mae = advR;

    // Target: same test in every version.
    if (long ? m.high >= target : m.low <= target) {
      const gross = Math.abs(target - entry) / risk;
      return { ...base, outcome: "TARGET", exitTime: m.datetime, exitPrice: target,
               grossR: gross, netR: gross - costR, mfeR: mfe, maeR: mae };
    }

    // S2 confirmation, at this version's boundary only.
    const endOfMinute = Date.parse(m.datetime) + 60000;
    let close: number | undefined;
    if (v === "C_1M") close = m.close;
    else if (v === "B_5M") close = fiveClose.get(endOfMinute);
    else close = htfClose.get(endOfMinute);

    if (close !== undefined && (long ? close < s2 : close > s2)) {
      const gross = (long ? close - entry : entry - close) / risk;
      return { ...base, outcome: "S2_CLOSE", exitTime: m.datetime, exitPrice: close,
               grossR: gross, netR: gross - costR, mfeR: mfe, maeR: mae };
    }
  }
  return { ...base, mfeR: mfe, maeR: mae };
}

// ── run every trade through all three ────────────────────────────────────────

interface Row {
  window: string; instrument: string; direction: string; vol: string;
  entryBarTime: string; entry: number; s2: number; target: number; risk: number; costR: number;
  v1CausalNetR: number | null;
  entryMinute: string | null;
  A: Res | null; B: Res | null; C: Res | null;
  status: "OK" | "TICK_REQUIRED" | "NO_ENTRY_AT_1M" | "DATA_UNAVAILABLE";
}
const rows: Row[] = [];
const v1 = JSON.parse(await Deno.readTextFile("/tmp/stage3-causal-A.json"));
const v1R = new Map<string, number | null>(
  v1.map((r: Record<string, unknown>) => [`${r.window}|${r.entryBarTime}|${r.entry}`, r.causalNetR as number | null]));

for (const c of Object.values(ck)) {
  if (!c.completed) continue;
  if (c.window === "p3-BTCUSD") continue;   // corrupt 1m feed, excluded as in v1
  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === c.instrument)!;
  const hkey = `${c.instrument}|${inst.timeframe === "30min" ? "30min" : "1h"}|${c.from}|${c.to}`;
  const htfAll = (htfCache[hkey] ?? []).filter((b) => !isDecimalShift(b));
  const windowEnd = Date.parse(`${c.to}T00:00:00Z`);

  for (const t of c.trades_detail) {
    const long = t.direction === "demand";
    const key = `${c.window}|${t.entryBarTime}|${t.entry}`;
    const base: Row = {
      window: c.window, instrument: c.instrument, direction: t.direction, vol: t.vol,
      entryBarTime: t.entryBarTime, entry: t.entry, s2: t.stop, target: t.target,
      risk: t.risk, costR: t.costR, v1CausalNetR: v1R.get(key) ?? null,
      entryMinute: null, A: null, B: null, C: null, status: "DATA_UNAVAILABLE",
    };
    const barStart = Date.parse(t.entryBarTime);
    const ms = tape(c.instrument, barStart, windowEnd, t.entry);
    if (!ms.length) { rows.push(base); continue; }

    // Causal entry: first minute inside the ENTRY BAR that reaches E2.
    const barEnd = barStart + inst.barMs;
    const eIdx = ms.findIndex((m) => {
      const x = Date.parse(m.datetime);
      return x >= barStart && x < barEnd && (long ? m.low <= t.entry : m.high >= t.entry);
    });
    if (eIdx < 0) { rows.push({ ...base, status: "NO_ENTRY_AT_1M" }); continue; }

    // Same-minute entry AND target: 1m cannot order them.
    const em = ms[eIdx];
    if (long ? em.high >= t.target : em.low <= t.target) {
      rows.push({ ...base, status: "TICK_REQUIRED", entryMinute: em.datetime }); continue;
    }

    const htf = htfAll.filter((b) => Date.parse(b.datetime) >= barStart);
    rows.push({
      ...base, status: "OK", entryMinute: em.datetime,
      A: runVersion("A_HTF", long, t.entry, t.stop, t.target, t.risk, t.costR, ms, eIdx, htf, inst.barMs),
      B: runVersion("B_5M", long, t.entry, t.stop, t.target, t.risk, t.costR, ms, eIdx, htf, inst.barMs),
      C: runVersion("C_1M", long, t.entry, t.stop, t.target, t.risk, t.costR, ms, eIdx, htf, inst.barMs),
    });
  }
}

// ── metrics ──────────────────────────────────────────────────────────────────

const q = (a: number[], p: number) => { if (!a.length) return 0; const s=[...a].sort((x,y)=>x-y); return s[Math.min(s.length-1, Math.floor(p*s.length))]; };
const pick = (r: Row, v: Version) => v === "A_HTF" ? r.A : v === "B_5M" ? r.B : r.C;
const resolvedOf = (rs: Row[], v: Version) =>
  rs.filter((r) => r.status === "OK" && pick(r, v)?.netR !== null && pick(r, v)!.netR !== undefined);

function perf(rs: Row[], v: Version) {
  const set = resolvedOf(rs, v).map((r) => pick(r, v)!.netR!);
  const n = set.length; if (!n) return null;
  const w = set.filter((x) => x > 0), l = set.filter((x) => x < 0);
  const gp = w.reduce((a,x)=>a+x,0), gl = Math.abs(l.reduce((a,x)=>a+x,0));
  const tot = set.reduce((a,x)=>a+x,0);
  let peak=0,cum=0,mdd=0,ws=0,ls=0,bw=0,bl=0;
  for (const x of set){cum+=x;peak=Math.max(peak,cum);mdd=Math.max(mdd,peak-cum);
    if(x>0){ws++;ls=0;bw=Math.max(bw,ws);}else if(x<0){ls++;ws=0;bl=Math.max(bl,ls);}}
  const avgW = w.length?gp/w.length:0, avgL = l.length?-gl/l.length:0;
  const losses = l.map(Math.abs);
  return { n, wins:w.length, losses:l.length, win:w.length/n*100, totalR:tot, expR:tot/n,
    pf: gl?gp/gl:Infinity, maxDD:mdd, avgW, avgL, medW:q(w,.5), medL:-q(losses,.5),
    winStreak:bw, lossStreak:bl,
    be: (Math.abs(avgL)/(avgW+Math.abs(avgL)))*100,
    lossDist: { med:q(losses,.5), mean:losses.length?losses.reduce((a,x)=>a+x,0)/losses.length:0,
      p75:q(losses,.75), p90:q(losses,.9), p95:q(losses,.95), p99:q(losses,.99),
      max:losses.length?Math.max(...losses):0,
      over: Object.fromEntries([1,1.25,1.5,2,3,5].map((t)=>[t, losses.length?losses.filter((x)=>x>t).length/losses.length*100:0])) } };
}

const VERS: Array<[Version,string]> = [["A_HTF","S2_HTF_CONTROL"],["B_5M","S2_5M_CLOSE"],["C_1M","S2_1M_CLOSE"]];
const INST = ["EUR/USD","USD/JPY","BTC/USD"];
const H = (s:string) => console.log(`\n${"=".repeat(104)}\n${s}\n${"=".repeat(104)}`);

// invariants
H("ACCOUNTING INVARIANTS");
const byStatus: Record<string,number> = {};
for (const r of rows) byStatus[r.status] = (byStatus[r.status]??0)+1;
console.log("population", rows.length, JSON.stringify(byStatus));
for (const [v,label] of VERS) {
  const ok = rows.filter((r)=>r.status==="OK");
  const res = resolvedOf(rows,v).length;
  const stillOpen = ok.filter((r)=>pick(r,v)!.outcome==="STILL_OPEN").length;
  const sum = res + stillOpen + (rows.length - ok.length);
  if (sum !== rows.length) { console.error(`INVARIANT FAIL ${label}: ${sum} != ${rows.length}`); Deno.exit(1); }
  console.log(`  ${label.padEnd(16)} resolved ${res}  still-open ${stillOpen}  unresolved/unavailable ${rows.length-ok.length}  sum ${sum} OK`);
}

H("PORTFOLIO — three versions");
console.log(`${"version".padEnd(18)}${"n".padStart(5)}${"win%".padStart(7)}${"BE%".padStart(7)}${"gap".padStart(7)}${"expR".padStart(9)}${"PF".padStart(7)}${"totalR".padStart(9)}${"maxDD".padStart(8)}${"avgL".padStart(8)}${"medL".padStart(8)}${"p95L".padStart(8)}${"maxL".padStart(9)}`);
for (const [v,label] of VERS) {
  const p = perf(rows,v); if(!p) continue;
  console.log(`${label.padEnd(18)}${String(p.n).padStart(5)}${p.win.toFixed(1).padStart(7)}${p.be.toFixed(1).padStart(7)}${(p.win-p.be).toFixed(1).padStart(7)}${p.expR.toFixed(3).padStart(9)}${p.pf.toFixed(2).padStart(7)}${p.totalR.toFixed(1).padStart(9)}${p.maxDD.toFixed(1).padStart(8)}${p.avgL.toFixed(2).padStart(8)}${p.medL.toFixed(2).padStart(8)}${(-p.lossDist.p95).toFixed(2).padStart(8)}${(-p.lossDist.max).toFixed(2).padStart(9)}`);
}

for (const inst of INST) {
  H(`${inst}`);
  const set = rows.filter((r)=>r.instrument===inst);
  console.log(`${"version".padEnd(18)}${"n".padStart(5)}${"win%".padStart(7)}${"BE%".padStart(7)}${"gap".padStart(7)}${"expR".padStart(9)}${"PF".padStart(7)}${"totalR".padStart(9)}${"maxDD".padStart(8)}${"avgW".padStart(8)}${"avgL".padStart(8)}`);
  for (const [v,label] of VERS) {
    const p = perf(set,v); if(!p) continue;
    console.log(`${label.padEnd(18)}${String(p.n).padStart(5)}${p.win.toFixed(1).padStart(7)}${p.be.toFixed(1).padStart(7)}${(p.win-p.be).toFixed(1).padStart(7)}${p.expR.toFixed(3).padStart(9)}${p.pf.toFixed(2).padStart(7)}${p.totalR.toFixed(1).padStart(9)}${p.maxDD.toFixed(1).padStart(8)}${p.avgW.toFixed(2).padStart(8)}${p.avgL.toFixed(2).padStart(8)}`);
  }
}

H("LOSS TAIL");
console.log(`${"version".padEnd(18)}${"n".padStart(5)}${"med".padStart(7)}${"mean".padStart(7)}${"p75".padStart(7)}${"p90".padStart(7)}${"p95".padStart(7)}${"p99".padStart(7)}${"max".padStart(8)}  >1R  >1.25 >1.5R >2R   >3R   >5R`);
for (const [v,label] of VERS) {
  const p = perf(rows,v); if(!p) continue; const d=p.lossDist;
  const o=(t:number)=>`${d.over[t].toFixed(0)}%`.padStart(5);
  console.log(`${label.padEnd(18)}${String(p.losses).padStart(5)}${d.med.toFixed(2).padStart(7)}${d.mean.toFixed(2).padStart(7)}${d.p75.toFixed(2).padStart(7)}${d.p90.toFixed(2).padStart(7)}${d.p95.toFixed(2).padStart(7)}${d.p99.toFixed(2).padStart(7)}${d.max.toFixed(2).padStart(8)} ${o(1)}${o(1.25)}${o(1.5)}${o(2)}${o(3)}${o(5)}`);
}

H("COST OF REACTING EARLY — exits that the control later turned into a target");
for (const [v,label] of [["B_5M","S2_5M_CLOSE"],["C_1M","S2_1M_CLOSE"]] as Array<[Version,string]>) {
  const early = rows.filter((r)=>r.status==="OK" && pick(r,v)!.outcome==="S2_CLOSE" && r.A!.outcome==="TARGET");
  const rLost = early.reduce((a,r)=>a+(r.A!.netR! - pick(r,v)!.netR!),0);
  console.log(`  EARLY_EXIT_THEN_RECOVERED_TO_TARGET  ${label.padEnd(14)} n=${String(early.length).padStart(3)}   R forgone vs control ${rLost.toFixed(1)}`);
  for (const inst of INST) {
    const g = early.filter((r)=>r.instrument===inst);
    if (g.length) console.log(`      ${inst}: ${g.length}`);
  }
}

H("TAIL-RISK CONTAINMENT — control loses big, lower timeframe caps it");
for (const [v,label] of [["B_5M","S2_5M_CLOSE"],["C_1M","S2_1M_CLOSE"]] as Array<[Version,string]>) {
  for (const th of [2,3,5]) {
    const n = rows.filter((r)=>r.status==="OK" && r.A!.netR!==null && r.A!.netR! < -th
      && pick(r,v)!.netR!==null && pick(r,v)!.netR! > -th).length;
    console.log(`  control worse than -${th}R but ${label} kept it above -${th}R: ${n}`);
  }
}

// ── output ───────────────────────────────────────────────────────────────────

const flat = rows.map((r)=>({
  window:r.window, instrument:r.instrument, direction:r.direction, vol:r.vol,
  entryBarTime:r.entryBarTime, entryMinute:r.entryMinute, entry:r.entry, s2:r.s2,
  target:r.target, risk:r.risk, costR:r.costR, status:r.status, v1CausalNetR:r.v1CausalNetR,
  A_outcome:r.A?.outcome??null, A_exitTime:r.A?.exitTime??null, A_netR:r.A?.netR??null,
  B_outcome:r.B?.outcome??null, B_exitTime:r.B?.exitTime??null, B_netR:r.B?.netR??null,
  C_outcome:r.C?.outcome??null, C_exitTime:r.C?.exitTime??null, C_netR:r.C?.netR??null,
  recoveredAfterEarly5m: r.status==="OK" && r.B!.outcome==="S2_CLOSE" && r.A!.outcome==="TARGET",
  recoveredAfterEarly1m: r.status==="OK" && r.C!.outcome==="S2_CLOSE" && r.A!.outcome==="TARGET",
  mfeR:r.A?.mfeR??null, maeR:r.A?.maeR??null,
}));
await Deno.writeTextFile("/tmp/v2-exp1-s2.json", JSON.stringify(flat,null,1));
const cols = Object.keys(flat[0]);
await Deno.writeTextFile("/tmp/v2-exp1-s2.csv",
  [cols.join(",")].concat(flat.map((r)=>cols.map((c)=>{const v=(r as Record<string,unknown>)[c];return v===null||v===undefined?"":String(v);}).join(","))).join("\n"));
console.log(`\nwrote ${flat.length} rows to /tmp/v2-exp1-s2.{json,csv}`);
console.log(`API: ${requests} requests, ${rateLimited} 429s, ${apiErrors} errors`);
