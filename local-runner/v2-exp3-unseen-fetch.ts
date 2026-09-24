/**
 * IPO-CET-v2 EXPERIMENT 3 — PASS 1: unseen-window inventory and data fetch.
 *
 * RESEARCH ONLY. Fetches and caches market data; writes local JSON. No database,
 * no schema, no cron, no deployment, no production code change.
 *
 * THIS FILE FIXES THE WINDOW SELECTION IN CODE, BEFORE ANY REPLAY RUNS.
 *
 * Selection method, frozen here and not revisited after results:
 *
 *   1. CONSUMED = the union of every calendar month touched by prior IPO
 *      research. Sources: the inventory in IPO_CET_V1_POSTMORTEM §15, every
 *      period named in IPO_RESEARCH_FREEZE.md, and every window key present in
 *      the Stage 3 HTF cache. Each `A..B` period is expanded to its full span.
 *      Every ambiguity is resolved TOWARD CONSUMED.
 *   2. ELIGIBLE = months not in CONSUMED, with provider 1-minute coverage, and
 *      ending before the live forward test began (2026-09).
 *   3. Each maximal contiguous run of eligible months is partitioned into
 *      consecutive 2-month end-exclusive windows from the run's start; a
 *      residual single month becomes a 1-month window.
 *   4. ALL resulting windows are used. No ranking, no scoring, no substitution,
 *      no dropping — so there is no selection to bias.
 *
 * The 1-minute boundary was established by probe, not assumption: 2020-02-04
 * returns no data for either EUR/USD or BTC/USD; 2020-04-07 onward returns full
 * days. Everything before 2020-04 is therefore ineligible regardless of whether
 * prior research touched it, because the causal execution model needs minutes.
 *
 * ONLY DAILY context is fetched. The hypothesis is Daily HTF structure alone;
 * the SMC direction verdict is explicitly excluded from this experiment, so no
 * 4H, 1H or weekly context series is needed or retrieved.
 */

import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";

const KEY = Deno.env.get("TWELVE_DATA_API_KEY");
if (!KEY) { console.error("TWELVE_DATA_API_KEY not set; refusing to run."); Deno.exit(1); }

// ─────────────────────────────────────────────────────────────────────────────
// PART A — every month prior IPO research has consumed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each entry is [firstMonth, firstMonthNotIncluded] in the repo's own `A..B`
 * end-exclusive notation, with its source. Nothing here is inferred from data;
 * every row is a period named in a committed document or present as a cache key.
 */
const CONSUMED_PERIODS: Array<[string, string, string]> = [
  // IPO_RESEARCH_FREEZE.md — corpus, detector research and named studies
  ["2020-03", "2020-09", "postmortem §15 '2020-03 to 2020-08' (read inclusively); freeze corpus rows + detector files"],
  ["2021-01", "2021-03", "freeze — origin-anchor study"],
  ["2021-03", "2021-06", "freeze §231 — untouched-validation windows"],
  ["2021-05", "2021-08", "freeze §231 — untouched-validation windows"],
  ["2021-09", "2021-11", "freeze §803 — A1 untouched validation"],
  ["2022-02", "2022-04", "freeze §501 — A1 pre-registered pass"],
  ["2022-04", "2022-07", "HTF cache key + freeze §710 volatility validation"],
  ["2022-06", "2022-08", "freeze — volatility hypothesis"],
  ["2022-08", "2022-10", "freeze §711 — USD/JPY volatility validation"],
  ["2022-12", "2023-02", "freeze — anchor study"],
  ["2023-02", "2023-04", "freeze §803 — A1 untouched validation"],
  ["2023-04", "2023-06", "freeze — anchor study"],
  ["2023-08", "2023-09", "freeze §909 — spill-over month"],
  ["2023-09", "2023-12", "HTF cache keys 2023-09..12 / 2023-09..11"],
  ["2023-12", "2024-02", "postmortem §15 proposed VALIDATION A"],
  ["2024-01", "2024-04", "freeze §629-631 — OOS grid"],
  ["2024-03", "2024-06", "freeze §629-631 — OOS grid + postmortem VALIDATION A"],
  ["2024-06", "2024-09", "freeze §629-631 — OOS grid"],
  ["2024-09", "2025-01", "freeze §629-631 + §803 — OOS grid and A1"],
  ["2025-01", "2025-04", "HTF cache key 2025-01..04 + freeze §710"],
  ["2025-04", "2025-07", "HTF cache key 2025-04..07 + freeze §710"],
  ["2025-06", "2025-08", "freeze — volatility study"],
  ["2025-08", "2025-10", "freeze §710 — volatility validation"],
  ["2026-01", "2026-03", "freeze §803 — A1 untouched validation"],
  ["2026-06", "2026-08", "postmortem §15 inventory"],
  ["2026-08", "2026-10", "postmortem §15 inventory + live IPO paper forward test"],
  // The locked 15-window validation corpus (freeze §17) — Stage 3, Exp 1, Exp 2
  ["2021-11", "2022-02", "locked corpus window 1 (+ HTF cache 2021-11..2022-02)"],
  ["2022-10", "2022-12", "locked corpus window 2"],
  ["2023-06", "2023-08", "locked corpus window 3"],
  ["2025-10", "2025-12", "locked corpus window 4"],
  ["2025-12", "2026-01", "postmortem §15 inventory lists 2025-12"],
  ["2026-04", "2026-06", "locked corpus window 5"],
];

/** Provider 1-minute coverage begins between 2020-02-04 (none) and 2020-04-07 (full). */
const MIN_MINUTE_MONTH = "2020-04";
/** The live forward test starts here; its data can never be unseen. */
const FORWARD_TEST_MONTH = "2026-09";
/** Nothing later than the last complete month exists. */
const LAST_COMPLETE_MONTH = "2026-08";

const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const indexMonth = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const firstOf = (m: string) => `${m}-01`;

const consumed = new Set<number>();
for (const [a, b, _why] of CONSUMED_PERIODS) {
  for (let i = monthIndex(a); i < monthIndex(b); i++) consumed.add(i);
}

const LO = monthIndex(MIN_MINUTE_MONTH);
const HI = monthIndex(LAST_COMPLETE_MONTH);
const eligible: number[] = [];
for (let i = LO; i <= HI; i++) {
  if (consumed.has(i)) continue;
  if (i >= monthIndex(FORWARD_TEST_MONTH)) continue;
  eligible.push(i);
}

// Partition maximal contiguous runs into 2-month windows, residual single month
// becomes a 1-month window.
interface Win { id: string; from: string; to: string; months: number }
const WINDOWS: Win[] = [];
{
  const runs: number[][] = [];
  for (const i of eligible) {
    if (runs.length && runs[runs.length - 1][runs[runs.length - 1].length - 1] === i - 1) {
      runs[runs.length - 1].push(i);
    } else runs.push([i]);
  }
  let n = 0;
  for (const run of runs) {
    for (let k = 0; k < run.length; k += 2) {
      const span = Math.min(2, run.length - k);
      n++;
      WINDOWS.push({
        id: `u${n}`,
        from: firstOf(indexMonth(run[k])),
        to: firstOf(indexMonth(run[k] + span)),
        months: span,
      });
    }
  }
}

console.log("=".repeat(100));
console.log("EXPERIMENT 3 — PART A: periods already consumed by prior IPO research");
console.log("=".repeat(100));
for (const [a, b, why] of CONSUMED_PERIODS) console.log(`  ${a}..${b}   ${why}`);
console.log(`\n  consumed months: ${consumed.size} distinct`);
console.log(`  provider 1m coverage begins ${MIN_MINUTE_MONTH} (probed: 2020-02 none, 2020-04 full)`);

console.log(`\n${"=".repeat(100)}`);
console.log("PART B: eligible unseen months and the windows they mechanically produce");
console.log("=".repeat(100));
console.log(`  eligible months (${eligible.length}): ${eligible.map(indexMonth).join(", ")}`);
for (const w of WINDOWS) {
  console.log(`  ${w.id}  ${w.from} .. ${w.to}  end-exclusive  (${w.months} month${w.months > 1 ? "s" : ""})`);
}
if (WINDOWS.length === 0) { console.error("FATAL: no unseen windows."); Deno.exit(1); }

// ─────────────────────────────────────────────────────────────────────────────
// PART C — fetch
// ─────────────────────────────────────────────────────────────────────────────

const HTF_OUT = "/tmp/v2-exp3-htf.json";
const DAILY_OUT = "/tmp/v2-exp3-daily.json";
const MIN_CACHE = "/tmp/td-1m-corpus.json";

let htf: Record<string, Candle[]> = {};
try { htf = JSON.parse(await Deno.readTextFile(HTF_OUT)); } catch { /* cold */ }
let daily: Record<string, Candle[]> = {};
try { daily = JSON.parse(await Deno.readTextFile(DAILY_OUT)); } catch { /* cold */ }
const minutes: Record<string, Candle[]> = JSON.parse(await Deno.readTextFile(MIN_CACHE));

// Prior context series, reused where a range already covers what is needed.
let priorDaily: Record<string, Candle[]> = {};
try { priorDaily = JSON.parse(await Deno.readTextFile("/tmp/v2-exp2-context-series.json")); } catch { /* none */ }

let requests = 0, rateLimited = 0, retries = 0, apiErrors = 0;
let htfHits = 0, htfMiss = 0, dailyHits = 0, dailyMiss = 0, minHits = 0, minMiss = 0;
const fetchedDates: string[] = [];

const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function td(symbol: string, interval: string, from: string, to: string): Promise<Candle[]> {
  const u = new URL("https://api.twelvedata.com/time_series");
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("interval", interval);
  u.searchParams.set("outputsize", "5000");
  u.searchParams.set("order", "ASC");
  u.searchParams.set("timezone", "UTC");
  u.searchParams.set("start_date", `${from} 00:00:00`);
  u.searchParams.set("end_date", `${to} 00:00:00`);
  u.searchParams.set("apikey", KEY!);
  // deno-lint-ignore no-explicit-any
  let b: any = {};
  for (let a = 0; a < 8; a++) {
    requests++;
    if (a > 0) retries++;
    const res = await fetch(u);
    b = await res.json();
    if (b?.status !== "error") break;
    if (String(b?.code) === "429") { rateLimited++; await new Promise((s) => setTimeout(s, 65_000)); continue; }
    apiErrors++;
    throw new Error(`twelvedata ${b?.code}: ${String(b?.message).slice(0, 90)}`);
  }
  if (b?.status === "error") { apiErrors++; throw new Error("gave up"); }
  // END-EXCLUSIVE, the convention every prior stage used.
  return (b?.values ?? []).map((v: Record<string, string>) => ({
    datetime: `${v.datetime.replace(" ", "T")}Z`,
    open: Number(v.open), high: Number(v.high), low: Number(v.low),
    close: Number(v.close), volume: Number(v.volume ?? 0),
  })).filter((c: Candle) => c.datetime < `${to}T00:00:00Z`);
}

console.log(`\n${"=".repeat(100)}`);
console.log("PART C: setup-timeframe bars for the unseen windows");
console.log("=".repeat(100));
for (const w of WINDOWS) {
  for (const inst of IPO_INSTRUMENTS) {
    const interval = inst.timeframe === "30min" ? "30min" : "1h";
    const key = `${inst.instrument}|${interval}|${w.from}|${w.to}`;
    if (htf[key]) { htfHits++; console.log(`  ${w.id}-${inst.instrument.padEnd(8)} ${String(htf[key].length).padStart(5)} bars  CACHED`); continue; }
    htfMiss++;
    const bars = await td(inst.instrument, interval, w.from, w.to);
    htf[key] = bars;
    await Deno.writeTextFile(HTF_OUT, JSON.stringify(htf));
    console.log(`  ${w.id}-${inst.instrument.padEnd(8)} ${String(bars.length).padStart(5)} bars  ${bars[0]?.datetime ?? "—"} .. ${bars.at(-1)?.datetime ?? "—"}`);
    await new Promise((s) => setTimeout(s, 20_000));
  }
}

console.log(`\n${"=".repeat(100)}`);
console.log("PART D: daily context (300-bar depth needs ~430 calendar days of warmup)");
console.log("=".repeat(100));
for (const inst of IPO_INSTRUMENTS) {
  const key = `${inst.instrument}|1day`;
  if (daily[key]) { dailyHits++; console.log(`  ${inst.instrument.padEnd(8)} CACHED ${daily[key].length} bars`); continue; }
  // Reuse the Experiment 2 daily series where it already covers the range.
  const prior = priorDaily[`${inst.instrument}|1day`];
  const needFrom = "2019-01-01";
  if (prior && prior.length && prior[0].datetime <= `${needFrom}T00:00:00Z`) {
    daily[key] = prior; dailyHits++;
    console.log(`  ${inst.instrument.padEnd(8)} REUSED from Exp 2 context cache (${prior.length} bars)`);
    continue;
  }
  dailyMiss++;
  const bars = await td(inst.instrument, "1day", needFrom, "2026-09-01");
  daily[key] = bars;
  await Deno.writeTextFile(DAILY_OUT, JSON.stringify(daily));
  console.log(`  ${inst.instrument.padEnd(8)} ${bars.length} bars ${bars[0]?.datetime.slice(0, 10)} .. ${bars.at(-1)?.datetime.slice(0, 10)}` +
    `${prior ? `  (Exp 2 cache started ${prior[0]?.datetime.slice(0, 10)}, too late to reuse)` : ""}`);
  await new Promise((s) => setTimeout(s, 20_000));
}
await Deno.writeTextFile(DAILY_OUT, JSON.stringify(daily));

console.log(`\n${"=".repeat(100)}`);
console.log("PART E: 1-minute tape for every day of every unseen window");
console.log("=".repeat(100));
{
  const wanted = new Set<string>();
  for (const w of WINDOWS) {
    for (const inst of IPO_INSTRUMENTS) {
      for (let d = w.from; d < w.to; d = addDays(d, 1)) wanted.add(`${inst.instrument}|${d}`);
    }
  }
  const missing = [...wanted].filter((k) => !minutes[k]).sort();
  minHits = wanted.size - missing.length;
  minMiss = missing.length;
  console.log(`  coverage: ${minHits}/${wanted.size} instrument-days already cached, ${minMiss} to fetch`);

  const blocks = new Set<string>();
  for (const k of missing) {
    const [sym, day] = k.split("|");
    const ed = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000);
    blocks.add(`${sym}|${new Date((ed - (ed % 3)) * 86400000).toISOString().slice(0, 10)}`);
  }
  console.log(`  ${blocks.size} three-day blocks to request`);
  let done = 0;
  for (const b of [...blocks].sort()) {
    const [sym, start] = b.split("|");
    try {
      const rows = await td(sym, "1min", start, addDays(start, 3));
      for (let i = 0; i < 3; i++) {
        const d = addDays(start, i);
        minutes[`${sym}|${d}`] = rows.filter((r) => r.datetime.slice(0, 10) === d);
        fetchedDates.push(`${sym}|${d}`);
      }
      await Deno.writeTextFile(MIN_CACHE, JSON.stringify(minutes));
    } catch (e) {
      console.log(`    fetch fail ${b}: ${(e as Error).message}`);
    }
    await new Promise((s) => setTimeout(s, 9000));
    if (++done % 20 === 0) console.log(`    ${done}/${blocks.size} blocks`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PART F — data quality
// ─────────────────────────────────────────────────────────────────────────────

const isDecimalShift = (b: Candle) => b.low < Math.min(b.open, b.close) / 100;

console.log(`\n${"=".repeat(100)}`);
console.log("PART F: data quality");
console.log("=".repeat(100));
let qualityFail = false;
for (const [key, bars] of Object.entries(htf)) {
  const [sym, interval] = key.split("|");
  const step = interval === "30min" ? 1_800_000 : 3_600_000;
  const times = bars.map((b) => Date.parse(b.datetime));
  const dupes = times.length - new Set(times).size;
  const unsorted = times.some((t, i) => i > 0 && t <= times[i - 1]);
  const nonUtc = bars.filter((b) => !b.datetime.endsWith("Z")).length;
  const shift = bars.filter(isDecimalShift).length;
  const nonFinite = bars.filter((b) => ![b.open, b.high, b.low, b.close].every(Number.isFinite)).length;
  const badOhlc = bars.filter((b) => b.high < b.low || b.high < b.open || b.high < b.close ||
    b.low > b.open || b.low > b.close).length;
  // Largest gap, in bars of this timeframe. Weekends dominate for FX; report, do not gate.
  let maxGap = 0;
  for (let i = 1; i < times.length; i++) maxGap = Math.max(maxGap, (times[i] - times[i - 1]) / step);
  const flag = dupes || unsorted || nonUtc || nonFinite || badOhlc;
  if (flag) qualityFail = true;
  console.log(`  ${key.padEnd(34)} n=${String(bars.length).padStart(5)}  dupes=${dupes}  unsorted=${unsorted}  ` +
    `nonUTC=${nonUtc}  nonFinite=${nonFinite}  badOHLC=${badOhlc}  decimalShift=${shift}  maxGapBars=${maxGap.toFixed(0)}`);
}
for (const inst of IPO_INSTRUMENTS) {
  const d = daily[`${inst.instrument}|1day`] ?? [];
  const shift = d.filter(isDecimalShift).length;
  const times = d.map((b) => Date.parse(b.datetime));
  console.log(`  ${(inst.instrument + "|1day").padEnd(34)} n=${String(d.length).padStart(5)}  ` +
    `dupes=${times.length - new Set(times).size}  decimalShift=${shift}  ` +
    `${d[0]?.datetime.slice(0, 10)}..${d.at(-1)?.datetime.slice(0, 10)}`);
}
if (qualityFail) console.log("\n  !! at least one structural quality check failed — see above before trusting results");

// Aggregation cross-check: do the cached minutes roll up to the setup-timeframe bar?
console.log("\n  HTF aggregation cross-check (minutes vs provider setup bars, first 200 bars per window):");
for (const w of WINDOWS) {
  for (const inst of IPO_INSTRUMENTS) {
    const interval = inst.timeframe === "30min" ? "30min" : "1h";
    const bars = htf[`${inst.instrument}|${interval}|${w.from}|${w.to}`] ?? [];
    let checked = 0, ok = 0, worst = 0;
    for (const b of bars.slice(0, 200)) {
      const t0 = Date.parse(b.datetime), t1 = t0 + inst.barMs;
      const day = b.datetime.slice(0, 10), nextDay = addDays(day, 1);
      const ms = [...(minutes[`${inst.instrument}|${day}`] ?? []), ...(minutes[`${inst.instrument}|${nextDay}`] ?? [])]
        .filter((m) => { const t = Date.parse(m.datetime); return t >= t0 && t < t1; })
        .filter((m) => !isDecimalShift(m));
      if (ms.length < 5) continue;
      checked++;
      const hi = Math.max(...ms.map((m) => m.high)), lo = Math.min(...ms.map((m) => m.low));
      const rel = Math.max(Math.abs(hi - b.high), Math.abs(lo - b.low)) / Math.max(1e-12, b.high - b.low || b.close);
      if (rel < 0.05) ok++;
      if (rel > worst) worst = rel;
    }
    console.log(`    ${w.id}-${inst.instrument.padEnd(8)} ${ok}/${checked} bars agree within 5% of range, worst ${(worst * 100).toFixed(1)}%`);
  }
}

console.log(`\n${"=".repeat(100)}`);
console.log(`API: ${requests} requests, ${rateLimited} 429s, ${retries} retries, ${apiErrors} errors`);
console.log(`cache — HTF hits ${htfHits} / misses ${htfMiss}; daily hits ${dailyHits} / misses ${dailyMiss}; ` +
  `1m instrument-day hits ${minHits} / misses ${minMiss}`);
console.log(`new instrument-days fetched: ${fetchedDates.length}`);
await Deno.writeTextFile("/tmp/v2-exp3-windows.json", JSON.stringify({
  consumedPeriods: CONSUMED_PERIODS,
  consumedMonths: [...consumed].sort((a, b) => a - b).map(indexMonth),
  eligibleMonths: eligible.map(indexMonth),
  windows: WINDOWS,
  minuteCoverageFrom: MIN_MINUTE_MONTH,
}, null, 1));
console.log("wrote /tmp/v2-exp3-windows.json (no credential in any output file)");
