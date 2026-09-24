/**
 * LOCKED-BASELINE DETERMINISM REPLAY.
 *
 * RESEARCH ONLY. Fetches history, replays the UNMODIFIED `ipoLiveEngine`, writes
 * local JSON checkpoints. No database, no strategy change, no deployment.
 *
 * THE QUESTION, and only this one: does the unmodified official engine, over the
 * 15 windows recovered in `docs/IPO_BASELINE_PROVENANCE_RECOVERY.md`, reproduce
 * EUR/USD 341, USD/JPY 558, BTC/USD HIGH_VOL 140, portfolio 1039?
 *
 * NOTHING IS TUNED TO MAKE IT MATCH. Window boundaries, timeframes, the BTC
 * cleaning rule and the engine are all fixed before the first count is seen. If
 * the answer is no, the answer is no.
 *
 * ON THE TWO FIXES. The locked figures came AFTER two bugs were fixed, and the
 * task brief states them inverted. Spec §11 is explicit: the superseded 1,109
 * figure came from "a version of the engine with two bugs since fixed — cost
 * priced off the exit bar RATHER THAN THE ENTRY BAR, and same-bar re-entry
 * permitted WHERE the frozen sequential() requires touchIndex >
 * previousExitIndex". So the post-fix state is cost at the ENTRY bar and
 * same-bar re-entry FORBIDDEN. Both are verified in the engine below before any
 * window runs; implementing the brief literally would reproduce 1,109, not 1,039.
 */

import { replay, type EngineConfig } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";

const KEY = Deno.env.get("TWELVE_DATA_API_KEY");
if (!KEY) { console.error("TWELVE_DATA_API_KEY not set; refusing to run."); Deno.exit(1); }

const LOCKED = {
  "EUR/USD": { n: 341, expR: 0.758, pf: 2.60 },
  "USD/JPY": { n: 558, expR: 0.550, pf: 1.88 },
  "BTC/USD": { n: 140, expR: 0.301, pf: 1.50 },
};
const LOCKED_PORTFOLIO = { n: 1039, win: 72.6, expR: 0.585, pf: 2.02, maxDD: 18.4 };

/** Freeze §17, end-exclusive two-month periods. Fixed before the run. */
const PERIODS: Array<[string, string]> = [
  ["2021-11-01", "2022-01-01"],
  ["2022-10-01", "2022-12-01"],
  ["2023-06-01", "2023-08-01"],
  ["2025-10-01", "2025-12-01"],
  ["2026-04-01", "2026-06-01"],
];

interface Win { id: string; instrument: string; timeframe: string; interval: string; from: string; to: string }
const WINDOWS: Win[] = PERIODS.flatMap(([from, to], pi) =>
  IPO_INSTRUMENTS.map((inst, ii) => ({
    id: `p${pi + 1}-${inst.instrument.replace("/", "")}`,
    instrument: inst.instrument, timeframe: inst.timeframe,
    interval: inst.timeframe === "30min" ? "30min" : "1h",
    from, to,
  })));

// ── Part A: validate the inputs BEFORE fetching anything ─────────────────────

console.log("=".repeat(96));
console.log("PART A — the 15 windows, validated before replay");
console.log("=".repeat(96));
for (const w of WINDOWS) {
  console.log(`  ${w.id.padEnd(12)} ${w.instrument.padEnd(8)} ${w.timeframe.padEnd(6)} ` +
    `${w.from}T00:00:00Z -> ${w.to}T00:00:00Z  end-exclusive=true  src=IPO_RESEARCH_FREEZE.md §17`);
}
if (WINDOWS.length !== 15) { console.error(`FATAL: ${WINDOWS.length} windows, expected 15`); Deno.exit(1); }
console.log(`  window count = ${WINDOWS.length}  OK\n`);

// ── verify the engine carries the post-fix semantics ─────────────────────────

const engineSrc = await Deno.readTextFile("supabase/functions/_shared/ipoLiveEngine.ts");
const costAtEntry = engineSrc.includes("costR: (2 * this.cfg.costPerSide(bar.close)) / risk");
const noSameBarReentry = engineSrc.includes("if (this.open || k <= this.lastExitIndex)");
console.log(`PART D — engine semantics: cost priced at ENTRY bar = ${costAtEntry}; ` +
            `same-bar re-entry FORBIDDEN = ${noSameBarReentry}`);
if (!costAtEntry || !noSameBarReentry) {
  console.error("FATAL: the engine does not carry the post-fix semantics the locked baseline used.");
  Deno.exit(1);
}
console.log();

// ── Part B: fetch, with cache, superset slicing and backoff ──────────────────

const CACHE = "/tmp/td-htf-windows.json";
let cache: Record<string, Candle[]> = {};
try { cache = JSON.parse(await Deno.readTextFile(CACHE)); } catch { /* cold */ }
let requests = 0, rateLimited = 0, retries = 0, cacheHits = 0, cacheMisses = 0;

/** A previously fetched wider range covering this one can be sliced — no new call. */
function fromSuperset(sym: string, interval: string, from: string, to: string): Candle[] | null {
  for (const [k, v] of Object.entries(cache)) {
    const [s, i, f, t] = k.split("|");
    if (s !== sym || i !== interval) continue;
    if (f <= from && t >= to) {
      return v.filter((b) => b.datetime >= `${from}T00:00:00Z` && b.datetime < `${to}T00:00:00Z`);
    }
  }
  return null;
}

async function fetchWindow(w: Win): Promise<Candle[]> {
  const key = `${w.instrument}|${w.interval}|${w.from}|${w.to}`;
  if (cache[key]) { cacheHits++; return cache[key]; }
  const sliced = fromSuperset(w.instrument, w.interval, w.from, w.to);
  if (sliced) { cacheHits++; cache[key] = sliced; return sliced; }
  cacheMisses++;

  const u = new URL("https://api.twelvedata.com/time_series");
  u.searchParams.set("symbol", w.instrument);
  u.searchParams.set("interval", w.interval);
  u.searchParams.set("outputsize", "5000");
  u.searchParams.set("order", "ASC");
  u.searchParams.set("timezone", "UTC");
  u.searchParams.set("start_date", `${w.from} 00:00:00`);
  u.searchParams.set("end_date", `${w.to} 00:00:00`);
  u.searchParams.set("apikey", KEY!);

  // deno-lint-ignore no-explicit-any
  let b: any = {};
  for (let attempt = 0; attempt < 8; attempt++) {
    requests++;
    if (attempt > 0) retries++;
    const res = await fetch(u);
    b = await res.json();
    if (b?.status !== "error") break;
    if (String(b?.code) === "429") { rateLimited++; await new Promise((s) => setTimeout(s, 65_000)); continue; }
    throw new Error(`twelvedata ${b?.code}: ${String(b?.message).slice(0, 110)}`);
  }
  if (b?.status === "error") throw new Error(`gave up: ${String(b?.message).slice(0, 110)}`);

  // END-EXCLUSIVE. Twelve Data's end_date is inclusive, so the boundary bar is
  // dropped here rather than by trusting the provider's convention.
  const out: Candle[] = (b?.values ?? []).map((v: Record<string, string>) => ({
    datetime: `${v.datetime.replace(" ", "T")}Z`,
    open: Number(v.open), high: Number(v.high), low: Number(v.low),
    close: Number(v.close), volume: Number(v.volume ?? 0),
  })).filter((c: Candle) => c.datetime < `${w.to}T00:00:00Z`);

  cache[key] = out;
  await Deno.writeTextFile(CACHE, JSON.stringify(cache));
  await new Promise((s) => setTimeout(s, 20_000));
  return out;
}

// ── Part C: the documented BTC cleaning rule ─────────────────────────────────

/**
 * Freeze §17: BTC 2023-06..08 held 64 bars (4.6%) where `low` = price / 10000.
 * PRIMARY treatment is to DROP them; repairing leaves corrupted zone geometry.
 * The detector is the glitch's own signature — a low four orders of magnitude
 * below the bar's own body — not a tuned threshold.
 */
const isDecimalShift = (b: Candle) => b.low < Math.min(b.open, b.close) / 100;

// ── Part I: checkpointing ────────────────────────────────────────────────────

const CKPT = "/tmp/baseline-determinism-checkpoint.json";
interface Ckpt {
  window: string; instrument: string; from: string; to: string;
  rawBars: number; droppedBars: number; bars: number;
  trades: number; totalR: number; elapsedMs: number; completed: boolean;
  trades_detail: Array<{
    entryIndex: number; exitIndex: number; netR: number; vol: string;
    ipoIndex: number; direction: string; entry: number; stop: number; target: number;
    risk: number; costR: number; entryBarTime: string; exitBarTime: string; ipoCandleTime: string;
  }>;
}
let ckpts: Record<string, Ckpt> = {};
try { ckpts = JSON.parse(await Deno.readTextFile(CKPT)); } catch { /* cold */ }

console.log("=".repeat(96));
console.log("PARTS B–E — fetch, clean, replay");
console.log("=".repeat(96));

const t0 = Date.now();
let btcRawTotal = 0, btcDropped = 0, volRefusals = 0;

for (const w of WINDOWS) {
  if (ckpts[w.id]?.completed) {
    console.log(`  ${w.id.padEnd(12)} ${w.instrument.padEnd(8)} RESUMED from checkpoint: ` +
      `${ckpts[w.id].bars} bars -> ${ckpts[w.id].trades} trades`);
    continue;
  }
  const started = Date.now();
  const raw = await fetchWindow(w);

  let bars = raw, dropped = 0;
  if (w.instrument === "BTC/USD") {
    btcRawTotal += raw.length;
    const clean = raw.filter((b) => !isDecimalShift(b));
    dropped = raw.length - clean.length;
    btcDropped += dropped;
    bars = clean;
  }

  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === w.instrument)!;
  const cfg: EngineConfig = {
    instrument: inst.instrument, timeframe: inst.timeframe,
    highVolOnly: inst.highVolOnly, costPerSide: inst.costPerSide,
  };
  const e = replay(bars, cfg);
  volRefusals += e.refusals.filter((r) => r.reason === "VOLATILITY_NOT_ELIGIBLE").length;

  const elapsed = Date.now() - started;
  ckpts[w.id] = {
    window: w.id, instrument: w.instrument, from: w.from, to: w.to,
    rawBars: raw.length, droppedBars: dropped, bars: bars.length,
    trades: e.trades.length, totalR: e.trades.reduce((a, t) => a + (t.netR ?? 0), 0),
    elapsedMs: elapsed, completed: true,
    trades_detail: e.trades.map((t) => ({
      entryIndex: t.entryIndex, exitIndex: t.exitIndex!, netR: t.netR!, vol: t.vol,
      ipoIndex: t.ipoIndex, direction: t.direction, entry: t.entry, stop: t.stop,
      target: t.target, risk: t.risk, costR: t.costR,
      entryBarTime: bars[t.entryIndex].datetime, exitBarTime: bars[t.exitIndex!].datetime,
      ipoCandleTime: bars[t.ipoIndex]?.datetime ?? "",
    })),
  };
  await Deno.writeTextFile(CKPT, JSON.stringify(ckpts));
  console.log(`  ${w.id.padEnd(12)} ${w.instrument.padEnd(8)} ${w.from}..${w.to}  ` +
    `${String(raw.length).padStart(5)} raw` +
    `${dropped ? ` -${dropped} corrupt` : "         "}` +
    ` -> ${String(bars.length).padStart(5)} bars -> ${String(e.trades.length).padStart(4)} trades  ` +
    `${(elapsed / 1000).toFixed(1)}s`);
}

// ── Parts E/F: metrics ───────────────────────────────────────────────────────

const all = Object.values(ckpts).filter((c) => c.completed);
const byInst = (i: string) => all.filter((c) => c.instrument === i).flatMap((c) => c.trades_detail);

function metrics(rs: Array<{ netR: number }>) {
  const n = rs.length;
  if (n === 0) return { n: 0, totalR: 0, expR: 0, win: 0, pf: 0, maxDD: 0 };
  const totalR = rs.reduce((a, r) => a + r.netR, 0);
  const wins = rs.filter((r) => r.netR > 0);
  const gp = wins.reduce((a, r) => a + r.netR, 0);
  const gl = Math.abs(rs.filter((r) => r.netR < 0).reduce((a, r) => a + r.netR, 0));
  let peak = 0, cum = 0, maxDD = 0;
  for (const r of rs) { cum += r.netR; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }
  return { n, totalR, expR: totalR / n, win: (wins.length / n) * 100, pf: gl === 0 ? Infinity : gp / gl, maxDD };
}

console.log(`\n${"=".repeat(96)}\nPART F — counts and metrics\n${"=".repeat(96)}`);
console.log(`${"instrument".padEnd(10)}${"n".padStart(6)}${"expected".padStart(10)}${"totalR".padStart(10)}${"expR".padStart(9)}${"locked".padStart(9)}${"PF".padStart(8)}${"locked".padStart(8)}`);
let countsMatch = true;
for (const [inst, L] of Object.entries(LOCKED)) {
  const m = metrics(byInst(inst));
  if (m.n !== L.n) countsMatch = false;
  console.log(`${inst.padEnd(10)}${String(m.n).padStart(6)}${String(L.n).padStart(10)}` +
    `${m.totalR.toFixed(1).padStart(10)}${m.expR.toFixed(3).padStart(9)}${L.expR.toFixed(3).padStart(9)}` +
    `${m.pf.toFixed(2).padStart(8)}${L.pf.toFixed(2).padStart(8)}`);
}
const port = metrics([...byInst("EUR/USD"), ...byInst("USD/JPY"), ...byInst("BTC/USD")]);
if (port.n !== LOCKED_PORTFOLIO.n) countsMatch = false;
console.log(`\nPORTFOLIO   n=${port.n} (locked ${LOCKED_PORTFOLIO.n})   win=${port.win.toFixed(1)}% (locked ${LOCKED_PORTFOLIO.win})`);
console.log(`            expR=${port.expR.toFixed(3)} (locked ${LOCKED_PORTFOLIO.expR})   PF=${port.pf.toFixed(2)} (locked ${LOCKED_PORTFOLIO.pf})   maxDD=${port.maxDD.toFixed(1)} (locked ${LOCKED_PORTFOLIO.maxDD})`);

console.log(`\nPART C — BTC cleaning: ${btcRawTotal} raw BTC bars, ${btcDropped} dropped as decimal-shift (documented: 64)`);
console.log(`PART E — BTC: engine refuses non-HIGH_VOL entries at source (highVolOnly=true), so`);
console.log(`         generated BTC trades ARE the HIGH_VOL set. VOLATILITY_NOT_ELIGIBLE refusals: ${volRefusals}`);

// ── Part G: hard verdict ─────────────────────────────────────────────────────

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const metricsConsistent =
  near(port.expR, LOCKED_PORTFOLIO.expR, 0.02) && near(port.win, LOCKED_PORTFOLIO.win, 1.0) &&
  near(port.pf, LOCKED_PORTFOLIO.pf, 0.1);

console.log(`\n${"=".repeat(96)}`);
console.log(countsMatch && metricsConsistent ? "DETERMINISM_MATCH" : "DETERMINISM_MISMATCH");
console.log("=".repeat(96));
if (!(countsMatch && metricsConsistent)) {
  console.log("actual vs expected:");
  for (const [inst, L] of Object.entries(LOCKED)) {
    const m = metrics(byInst(inst));
    console.log(`  ${inst.padEnd(9)} n ${m.n} vs ${L.n}${m.n === L.n ? "" : "  <-- DIFFERS"}` +
      `   expR ${m.expR.toFixed(3)} vs ${L.expR}   PF ${m.pf.toFixed(2)} vs ${L.pf}`);
  }
  console.log(`  PORTFOLIO n ${port.n} vs ${LOCKED_PORTFOLIO.n}${port.n === LOCKED_PORTFOLIO.n ? "" : "  <-- DIFFERS"}` +
    `   win ${port.win.toFixed(1)} vs ${LOCKED_PORTFOLIO.win}   expR ${port.expR.toFixed(3)} vs ${LOCKED_PORTFOLIO.expR}` +
    `   PF ${port.pf.toFixed(2)} vs ${LOCKED_PORTFOLIO.pf}   maxDD ${port.maxDD.toFixed(1)} vs ${LOCKED_PORTFOLIO.maxDD}`);
  console.log("\nNothing was adjusted to close any gap.");
}

console.log(`\nruntime ${((Date.now() - t0) / 1000).toFixed(0)}s   ` +
  `API: ${requests} requests, ${cacheHits} cache hits, ${cacheMisses} misses, ${rateLimited} 429s, ${retries} retries`);
await Deno.writeTextFile("/tmp/baseline-determinism-result.json",
  JSON.stringify({ windows: WINDOWS, checkpoints: ckpts, locked: LOCKED, lockedPortfolio: LOCKED_PORTFOLIO,
                   actual: { port, byInstrument: Object.fromEntries(Object.keys(LOCKED).map((i) => [i, metrics(byInst(i))])) },
                   verdict: countsMatch && metricsConsistent ? "DETERMINISM_MATCH" : "DETERMINISM_MISMATCH" }, null, 1));
console.log("wrote /tmp/baseline-determinism-result.json (no credential in file)");
