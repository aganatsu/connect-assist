/**
 * IPO-CET-v2 EXPERIMENT 2 — PASS 2: the SMC context series.
 *
 * RESEARCH ONLY. No production module is modified, no database is touched, no
 * deployment. This script only fetches and caches market data.
 *
 * WHAT IT FETCHES, AND WHY EXACTLY THIS. bot-scanner builds the SMC direction
 * verdict and the HTF structure read from four candle series, at depths fixed in
 * `bot-scanner/index.ts`:
 *
 *     CANDLE_LIMITS  = { "4h": 800 }        DEFAULT_CANDLE_LIMIT = 300
 *     LEGACY_H4_WINDOW = 300                 // every pre-existing 4H consumer
 *
 *   daily  `1d`  -> 300 bars     (bias TF for day_trader; regime; HTF structure)
 *   4H     `4h`  -> 800 fetched, sliced to the last 300 for directionEngine
 *   1H     `1h`  -> 300 bars     (confirmation TF)
 *   weekly `1w`  -> 300 bars     (weekly bias, an input to the verdict)
 *
 * Series LENGTH is not cosmetic: `analyzeMarketStructure` and `confirmedTrend`
 * both read the whole array, so feeding 1,000 daily bars where production feeds
 * 300 would produce a different trend and a different verdict. The reconstructed
 * context therefore slices to exactly these depths at every decision point.
 *
 * CACHE FIRST. The Stage 3 / Experiment 1 cache at /tmp/td-htf-windows.json
 * already holds every in-window 1h (EUR, BTC) and 30min (JPY) bar of the five
 * validation periods. Those are reused verbatim; only the pre-window warmup is
 * fetched. USD/JPY's cached 30min bars are aggregated locally to 1h on exact
 * hour boundaries rather than refetched — the same local-aggregation approach
 * Experiment 1 used for 5m, and it is validated here against a native 1h sample
 * before being trusted.
 */

import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";

const KEY = Deno.env.get("TWELVE_DATA_API_KEY");
if (!KEY) { console.error("TWELVE_DATA_API_KEY not set; refusing to run."); Deno.exit(1); }

const PERIODS: Array<[string, string]> = [
  ["2021-11-01", "2022-01-01"],
  ["2022-10-01", "2022-12-01"],
  ["2023-06-01", "2023-08-01"],
  ["2025-10-01", "2025-12-01"],
  ["2026-04-01", "2026-06-01"],
];

const HTF_CACHE = "/tmp/td-htf-windows.json";
const CTX_CACHE = "/tmp/v2-exp2-context-series.json";

const htf: Record<string, Candle[]> = JSON.parse(await Deno.readTextFile(HTF_CACHE));
let ctx: Record<string, Candle[]> = {};
try { ctx = JSON.parse(await Deno.readTextFile(CTX_CACHE)); } catch { /* cold */ }

let requests = 0, rateLimited = 0, retries = 0, hits = 0, misses = 0;
const fetchedKeys: string[] = [];
const reusedKeys: string[] = [];

const shiftDays = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

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

  // END-EXCLUSIVE, same convention as every earlier stage.
  return (b?.values ?? []).map((v: Record<string, string>) => ({
    datetime: `${v.datetime.replace(" ", "T")}Z`,
    open: Number(v.open), high: Number(v.high), low: Number(v.low),
    close: Number(v.close), volume: Number(v.volume ?? 0),
  })).filter((c: Candle) => c.datetime < `${to}T00:00:00Z`);
}

async function cached(key: string, fn: () => Promise<Candle[]>): Promise<Candle[]> {
  if (ctx[key]) { hits++; reusedKeys.push(key); return ctx[key]; }
  misses++;
  const out = await fn();
  ctx[key] = out;
  fetchedKeys.push(key);
  await Deno.writeTextFile(CTX_CACHE, JSON.stringify(ctx));
  await new Promise((s) => setTimeout(s, 20_000));
  return out;
}

/** Exact 30min -> 1h roll-up on hour boundaries. Same construction as Exp 1's 5m. */
function to1h(m30: Candle[]): Candle[] {
  const buckets = new Map<string, Candle[]>();
  for (const b of m30) {
    const k = `${b.datetime.slice(0, 13)}:00:00Z`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(b);
  }
  return [...buckets.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => ({
    datetime: k,
    open: v[0].open,
    high: Math.max(...v.map((x) => x.high)),
    low: Math.min(...v.map((x) => x.low)),
    close: v[v.length - 1].close,
    volume: v.reduce((a, x) => a + (x.volume ?? 0), 0),
  }));
}

const isDecimalShift = (b: Candle) => b.low < Math.min(b.open, b.close) / 100;

console.log("=".repeat(92));
console.log("EXPERIMENT 2 — PASS 2: SMC context series at production depths");
console.log("=".repeat(92));

// ── Long-horizon series: one request per instrument per timeframe ────────────
for (const inst of IPO_INSTRUMENTS) {
  const s = inst.instrument;
  // 300 daily bars before the earliest window (2021-11-01) needs ~430 calendar
  // days of FX history; 2020-06-01 leaves margin on both instrument types.
  const d = await cached(`${s}|1day`, () => td(s, "1day", "2020-06-01", "2026-06-01"));
  // 300 weekly bars is ~5.8 years before 2021-11; start in 2014 and take what
  // the provider has.
  const w = await cached(`${s}|1week`, () => td(s, "1week", "2014-01-01", "2026-06-01"));
  console.log(`  ${s.padEnd(8)} 1day ${String(d.length).padStart(5)} bars ${d[0]?.datetime.slice(0, 10)}..${d.at(-1)?.datetime.slice(0, 10)}   ` +
    `1week ${String(w.length).padStart(4)} bars ${w[0]?.datetime.slice(0, 10)}..${w.at(-1)?.datetime.slice(0, 10)}`);
}

// ── Per-window 4H (120-day warmup) and 1H warmup spliced onto the cache ──────
for (let pi = 0; pi < PERIODS.length; pi++) {
  const [from, to] = PERIODS[pi];
  for (const inst of IPO_INSTRUMENTS) {
    const s = inst.instrument;
    const id = `p${pi + 1}-${s.replace("/", "")}`;

    // 4H: 300 bars is ~70 calendar days of FX 4H. 120 days of warmup is ample.
    const h4 = await cached(`${s}|4h|${id}`, () => td(s, "4h", shiftDays(from, -120), to));

    // 1H: the in-window bars already exist in the Stage 3 cache. Fetch only the
    // pre-window warmup — 300 bars is ~18 calendar days of FX 1H; 30 is ample.
    const warm = await cached(`${s}|1h-warmup|${id}`, () => td(s, "1h", shiftDays(from, -30), from));

    const interval = inst.timeframe === "30min" ? "30min" : "1h";
    const inWindowRaw = htf[`${s}|${interval}|${from}|${to}`];
    if (!inWindowRaw) { console.error(`FATAL: ${s}|${interval}|${from}|${to} absent from the HTF cache.`); Deno.exit(1); }
    const inWindow = interval === "30min" ? to1h(inWindowRaw) : inWindowRaw;

    // Splice, de-duplicating on the datetime instant.
    const seen = new Set<string>();
    const h1: Candle[] = [];
    for (const b of [...warm, ...inWindow]) {
      if (seen.has(b.datetime)) continue;
      seen.add(b.datetime);
      h1.push(b);
    }
    h1.sort((a, b) => a.datetime < b.datetime ? -1 : 1);
    ctx[`${s}|1h|${id}`] = h1;

    console.log(`  ${id.padEnd(12)} 4h ${String(h4.length).padStart(4)}   1h ${String(h1.length).padStart(5)} ` +
      `(warmup ${warm.length} + in-window ${inWindow.length}${interval === "30min" ? " from cached 30min" : " cached"})`);
  }
}
await Deno.writeTextFile(CTX_CACHE, JSON.stringify(ctx));

// ── Validation: does the local 30min -> 1h roll-up match native 1h bars? ─────
// USD/JPY is the only instrument whose cached window bars are 30min. If the
// aggregation were wrong, every USD/JPY confirmation-timeframe read would be
// wrong, so it is checked against the provider rather than assumed.
{
  const probeKey = "USD/JPY|1h-probe";
  const probe = await cached(probeKey, () => td("USD/JPY", "1h", "2021-11-01", "2021-11-08"));
  const agg = to1h(htf["USD/JPY|30min|2021-11-01|2022-01-01"])
    .filter((b) => b.datetime < "2021-11-08T00:00:00Z");
  const byTime = new Map(agg.map((b) => [b.datetime, b]));
  let compared = 0, exact = 0, worst = 0;
  for (const p of probe) {
    const a = byTime.get(p.datetime);
    if (!a) continue;
    compared++;
    const d = Math.max(Math.abs(a.open - p.open), Math.abs(a.high - p.high),
      Math.abs(a.low - p.low), Math.abs(a.close - p.close));
    if (d === 0) exact++;
    if (d > worst) worst = d;
  }
  console.log(`\n  30min->1h roll-up check: ${compared} overlapping bars, ${exact} byte-identical, ` +
    `worst field delta ${worst.toExponential(2)}`);
  if (compared < 50) console.log("  WARNING: thin overlap — treat the roll-up as unverified.");
}

// ── BTC cleaning note ────────────────────────────────────────────────────────
// The IPO series drops decimal-shift bars. The SMC context series are separate
// fetches at different timeframes and get the same detector applied where the
// glitch can appear, so a corrupt bar cannot move a daily/4H/1H structure read.
for (const k of Object.keys(ctx)) {
  if (!k.startsWith("BTC/USD")) continue;
  const before = ctx[k].length;
  ctx[k] = ctx[k].filter((b) => !isDecimalShift(b));
  if (ctx[k].length !== before) {
    console.log(`  BTC cleaning: ${k} dropped ${before - ctx[k].length} decimal-shift bars`);
  }
}
await Deno.writeTextFile(CTX_CACHE, JSON.stringify(ctx));

console.log(`\nAPI: ${requests} requests, ${hits} cache hits, ${misses} misses, ${rateLimited} 429s, ${retries} retries`);
console.log(`fetched keys (${fetchedKeys.length}): ${fetchedKeys.join(", ") || "none"}`);
console.log(`reused keys  (${reusedKeys.length})`);
console.log(`wrote ${CTX_CACHE} (market data only, no credential)`);
