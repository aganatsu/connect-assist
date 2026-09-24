/**
 * STAGE 3, PART A — attempt to reconstruct the locked 1,039-trade population.
 *
 * RESEARCH ONLY. Fetches history, replays the UNMODIFIED live engine, writes
 * local JSON. No database, no strategy change, no deployment.
 *
 * THE PROBLEM. The locked baseline says it came from "replaying all 15 untouched
 * validation windows", but no file in the repo enumerates those 15 windows. The
 * research freeze records several DIFFERENT window sets for different
 * validations. So the population cannot simply be read off; it has to be
 * reconstructed and then PROVEN against the locked counts.
 *
 * THE TEST. Replay a candidate window set through `ipoLiveEngine` and compare
 * the trade counts with the locked 341 / 558 / 140. An exact match on all three
 * identifies the population; anything else does not, and no correction may be
 * published against a population that has not been identified.
 *
 * CANDIDATE SET, and why. Freeze §14 (untouched A1 validation) used three
 * windows; freeze §15 (volatility validation, which is where the BTC HIGH_VOL
 * framing in the locked table comes from) used twelve. 3 + 12 = 15, and the
 * locked table reports BTC as HIGH_VOL only. That is a hypothesis, tested here,
 * not an assumption.
 */

import { replay, type EngineConfig } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";

const KEY = Deno.env.get("TWELVE_DATA_API_KEY");
if (!KEY) { console.error("TWELVE_DATA_API_KEY not set; refusing to run."); Deno.exit(1); }

const LOCKED = { "EUR/USD": 341, "USD/JPY": 558, "BTC/USD": 140 };

interface Win { instrument: string; from: string; to: string; tag: string }

/**
 * THE RECOVERED WINDOWS — freeze §17, "Data — 15 windows, five separated
 * periods, five different years, all untouched".
 *
 * Verbatim: "2021-11..2022-01, 2022-10..12, 2023-06..08, 2025-10..12,
 * 2026-04..06 for each of the three instruments. 24,101 bars."
 *
 * Tied to the locked baseline by the documented chain:
 *   §17 batch      EUR 678 / JPY 1151 / BTC HIGH_VOL 287 / portfolio 2116
 *   §19 live       EUR 368 / JPY  595 / BTC 146         / portfolio 1109
 *   spec §11       EUR 341 / JPY  558 / BTC 140         / portfolio 1039
 * — the last after two fixes the spec names: cost priced at the entry bar
 * rather than the exit bar, and same-bar re-entry forbidden per `sequential()`.
 */
/**
 * The ".." in "2021-11..2022-01" is START..END-EXCLUSIVE, i.e. two months, not
 * three. Established from the document's own bar count rather than assumed:
 * freeze §17 records 24,101 bars over the 15 windows, and period 1 measures
 * 4,716 bars on the two-month reading (x5 = 23,580, 2.2% off) against 7,000 on
 * the three-month reading (x5 = 35,000, 45% off). §14 uses the same convention
 * explicitly, writing "2023-09-01 -> 2023-11-01" for a two-month window.
 *
 * This is interpretation of the recovered evidence, NOT fitting to trade counts.
 */
const PERIODS = [
  ["2021-11-01", "2022-01-01"],
  ["2022-10-01", "2022-12-01"],
  ["2023-06-01", "2023-08-01"],
  ["2025-10-01", "2025-12-01"],
  ["2026-04-01", "2026-06-01"],
];
const RECOVERED: Win[] = PERIODS.flatMap(([from, to]) =>
  ["EUR/USD", "USD/JPY", "BTC/USD"].map((instrument) => ({ instrument, from, to, tag: "freeze-s17" })));

const CANDIDATE = RECOVERED;

const CACHE = "/tmp/td-htf-windows.json";
let cache: Record<string, Candle[]> = {};
try { cache = JSON.parse(await Deno.readTextFile(CACHE)); } catch { /* cold */ }
let requests = 0, cacheHits = 0, errors = 0, rateLimited = 0;

async function htf(symbol: string, interval: string, from: string, to: string): Promise<Candle[]> {
  const k = `${symbol}|${interval}|${from}|${to}`;
  if (cache[k]) { cacheHits++; return cache[k]; }
  const u = new URL("https://api.twelvedata.com/time_series");
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("interval", interval);
  u.searchParams.set("outputsize", "5000");
  u.searchParams.set("order", "ASC");
  u.searchParams.set("timezone", "UTC");
  u.searchParams.set("start_date", `${from} 00:00:00`);
  u.searchParams.set("end_date", `${to} 00:00:00`);
  u.searchParams.set("apikey", KEY!);
  // A 5,000-bar request costs many credits, not one, so the per-minute budget
  // is exhausted long before the request count suggests. Backoff on 429 rather
  // than dropping the window — a dropped window silently changes the population.
  // deno-lint-ignore no-explicit-any
  let b: any = {};
  for (let attempt = 0; attempt < 6; attempt++) {
    requests++;
    const res = await fetch(u);
    b = await res.json();
    if (b?.status !== "error") break;
    if (String((b as { code?: unknown }).code) === "429") {
      rateLimited++;
      await new Promise((s) => setTimeout(s, 65_000));
      continue;
    }
    errors++;
    throw new Error(`twelvedata ${b?.code}: ${String(b?.message).slice(0, 110)}`);
  }
  if (b?.status === "error") {
    errors++;
    throw new Error(`twelvedata gave up after retries: ${String(b?.message).slice(0, 110)}`);
  }
  const out: Candle[] = (b?.values ?? []).map((v: Record<string, string>) => ({
    datetime: `${v.datetime.replace(" ", "T")}Z`,
    open: Number(v.open), high: Number(v.high), low: Number(v.low),
    close: Number(v.close), volume: Number(v.volume ?? 0),
  }));
  cache[k] = out;
  await Deno.writeTextFile(CACHE, JSON.stringify(cache));
  await new Promise((s) => setTimeout(s, 20_000));
  return out;
}

interface TradeRow {
  instrument: string; timeframe: string; window: string; windowTag: string;
  direction: string; ipoIndex: number; entryIndex: number; exitIndex: number;
  ipoCandleTime: string; entryBarTime: string; exitBarTime: string;
  entry: number; stop: number; target: number; risk: number;
  costR: number; netR: number; vol: string;
  sameBar: boolean;
}

const rows: TradeRow[] = [];
const perWindow: Array<{ w: string; bars: number; trades: number }> = [];

for (const w of CANDIDATE) {
  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === w.instrument)!;
  let bars: Candle[];
  try { bars = await htf(w.instrument, inst.timeframe === "30min" ? "30min" : "1h", w.from, w.to); }
  catch (e) { console.log(`${w.instrument} ${w.from}..${w.to}  ERROR ${(e as Error).message}`); continue; }

  const cfg: EngineConfig = {
    instrument: inst.instrument, timeframe: inst.timeframe,
    highVolOnly: inst.highVolOnly, costPerSide: inst.costPerSide,
  };
  // Freeze §17 data repair, PRIMARY treatment: BTC 2023-06..08 carried 64 bars
  // (4.6%) with a decimal-shift glitch, `low` = price / 10000. The document
  // DROPS them rather than repairing, because repairing leaves corrupted zone
  // geometry (avg MAE 35.1R against ~1.2R elsewhere). Reproduced here, and
  // reported, so the count is comparable to the recorded one.
  const clean = bars.filter((b) => b.low >= Math.min(b.open, b.close) / 100);
  const dropped = bars.length - clean.length;
  if (dropped > 0) console.log(`    dropped ${dropped} decimal-shift bars (freeze §17 primary treatment)`);
  bars = clean;

  const e = replay(bars, cfg);
  const label = `${w.instrument} ${w.from}..${w.to}`;
  perWindow.push({ w: `${label} [${w.tag}]`, bars: bars.length, trades: e.trades.length });
  console.log(`${label.padEnd(34)} [${w.tag}] ${String(bars.length).padStart(5)} bars -> ${String(e.trades.length).padStart(4)} trades`);

  for (const t of e.trades) {
    rows.push({
      instrument: w.instrument, timeframe: inst.timeframe, window: label, windowTag: w.tag,
      direction: t.direction, ipoIndex: t.ipoIndex, entryIndex: t.entryIndex, exitIndex: t.exitIndex!,
      ipoCandleTime: bars[t.ipoIndex]?.datetime ?? "", entryBarTime: bars[t.entryIndex].datetime,
      exitBarTime: bars[t.exitIndex!].datetime,
      entry: t.entry, stop: t.stop, target: t.target, risk: t.risk,
      costR: t.costR, netR: t.netR!, vol: t.vol,
      sameBar: t.exitIndex === t.entryIndex,
    });
  }
}

// ── determinism check against the locked counts ──────────────────────────────

console.log(`\n${"=".repeat(78)}\nDETERMINISM CHECK against the locked baseline\n${"=".repeat(78)}`);
let proven = true;
for (const [inst, locked] of Object.entries(LOCKED)) {
  const got = rows.filter((r) => r.instrument === inst).length;
  const ok = got === locked;
  if (!ok) proven = false;
  console.log(`  ${inst.padEnd(9)} locked ${String(locked).padStart(4)}   replayed ${String(got).padStart(4)}   ${ok ? "MATCH" : "MISMATCH"}`);
}
const total = rows.length;
console.log(`  ${"PORTFOLIO".padEnd(9)} locked 1039   replayed ${String(total).padStart(4)}   ${total === 1039 ? "MATCH" : "MISMATCH"}`);
console.log(`\nPOPULATION ${proven && total === 1039 ? "PROVEN" : "NOT PROVEN"}`);
if (!proven || total !== 1039) {
  console.log("The candidate window set does not reproduce the locked counts, so it is");
  console.log("NOT the baseline population. No causal correction may be published");
  console.log("against it. Reported as a blocker rather than substituted.");
}

console.log(`\nsame-bar (intrabar-sensitive) share: ${rows.filter((r) => r.sameBar).length}/${total}`);
console.log(`API: ${requests} requests, ${cacheHits} cache hits, ${errors} errors, ${rateLimited} rate-limited retries.`);
await Deno.writeTextFile("/tmp/stage3-population.json",
  JSON.stringify({ proven: proven && total === 1039, locked: LOCKED, perWindow, rows }, null, 1));
console.log(`wrote ${rows.length} replayed trades to /tmp/stage3-population.json (no credential in file)`);
