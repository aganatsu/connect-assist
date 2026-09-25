/**
 * SMC ZONE / IMPULSE — STAGE 2E: the AUD/USD outlier, and the harness omission
 * behind it.
 *
 * RESEARCH ONLY. No production change. Production functions called unmodified.
 *
 * WHAT STAGE 1 MISSED, AND DECLARED. The Stage 1 oracle passed `undefined` for
 * `htfConfluenceData` — the eighth argument to `findUnifiedZone`. Production
 * builds it from 4H order blocks, 4H fair-value gaps, 4H breakers, 4H and Daily
 * fib levels and the 4H premium/discount read (`bot-scanner` L5495). It feeds
 * `checkHTFConfluence`, which awards the `htfLayers` bonus inside the zone
 * score — and the zone score is what `rankAndSelectBestZone` uses to choose
 * between competing POIs inside the SAME impulse.
 *
 * THE EVIDENCE THAT THIS IS THE CAUSE, gathered before writing this file:
 *   - In AUD/USD's 240 mismatches the IMPULSE matched exactly in 230; only the
 *     winning POI differed, and `zone.type` flipped in 183 of them.
 *   - 93.1% of all mismatches across every pair had a production winning zone
 *     carrying htfLayers, against 69.9% of matches.
 *   - AUD/USD's mismatches are dominated by multi-layer zones —
 *     (4H_OB, 4H_FVG) 69, (4H_BREAKER, D1_FIB_61.8) 41, (4H_FVG, 4H_BREAKER) 34.
 *
 * SUPPLYING AN INPUT PRODUCTION SUPPLIES IS NOT TUNING. No threshold is moved
 * and no rule is changed; a missing argument is restored. The before/after is
 * reported for every pair, not only for AUD/USD, so the correction cannot be
 * mistaken for a fit to one symbol.
 */

import { findUnifiedZone } from "../supabase/functions/_shared/unifiedZoneEngine.ts";
import type { HTFConfluenceData } from "../supabase/functions/_shared/impulseZoneEngine.ts";
import {
  analyzeMarketStructure, detectOrderBlocks, detectFVGs, detectBreakerBlocks,
  detectZigZagPivots, computeFibLevels, calculatePremiumDiscount,
  detectLiquidityPools, SPECS, type Candle,
} from "../supabase/functions/_shared/smcAnalysis.ts";

const KEY = Deno.env.get("TWELVE_DATA_API_KEY");
if (!KEY) { console.error("TWELVE_DATA_API_KEY not set; refusing to run."); Deno.exit(1); }

const CANDLES = "/tmp/zone-stage1-candles.json";
const HTF = "/tmp/zone-stage2-htf-candles.json";
const ORACLE = "/tmp/zone-oracle.json";
const OUT = "/tmp/zone-stage2-htf-retest.json";

const cache: Record<string, Candle[]> = JSON.parse(await Deno.readTextFile(CANDLES));
let htfCache: Record<string, Candle[]> = {};
try { htfCache = JSON.parse(await Deno.readTextFile(HTF)); } catch { /* cold */ }

interface OracleRow { scanned_at: string; pair: string; uz: Record<string, any> }
const oracle: OracleRow[] = JSON.parse(await Deno.readTextFile(ORACLE));
const PAIRS = [...new Set(oracle.map((r) => r.pair))].sort();

const DEPTH = 300;
const BAR_MS = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1day": 86_400_000 } as const;

let requests = 0, apiErrors = 0, fetched = 0, reused = 0;

async function td(symbol: string, interval: string, from: string, to: string): Promise<Candle[]> {
  const u = new URL("https://api.twelvedata.com/time_series");
  u.searchParams.set("symbol", symbol); u.searchParams.set("interval", interval);
  u.searchParams.set("outputsize", "5000"); u.searchParams.set("order", "ASC");
  u.searchParams.set("timezone", "UTC");
  u.searchParams.set("start_date", `${from} 00:00:00`);
  u.searchParams.set("end_date", `${to} 00:00:00`);
  u.searchParams.set("apikey", KEY!);
  // deno-lint-ignore no-explicit-any
  let b: any = {};
  for (let a = 0; a < 8; a++) {
    requests++;
    const res = await fetch(u); b = await res.json();
    if (b?.status !== "error") break;
    if (String(b?.code) === "429") { await new Promise((s) => setTimeout(s, 65_000)); continue; }
    apiErrors++; throw new Error(`twelvedata ${b?.code}`);
  }
  if (b?.status === "error") { apiErrors++; throw new Error("gave up"); }
  return (b?.values ?? []).map((v: Record<string, string>) => ({
    datetime: `${v.datetime.replace(" ", "T")}Z`,
    open: Number(v.open), high: Number(v.high), low: Number(v.low),
    close: Number(v.close), volume: Number(v.volume ?? 0),
  }));
}

// 300 4H bars is ~70 calendar days; 300 daily is ~430. Warmup must reach full
// production depth BEFORE the oracle window opens or the comparison is invalid.
console.log("=".repeat(96));
console.log("STAGE 2E — fetching the 4H and Daily context the Stage 1 harness omitted");
console.log("=".repeat(96));
for (const pair of PAIRS) {
  for (const [interval, from] of [["4h", "2026-06-01"], ["1day", "2025-06-01"]] as const) {
    const k = `${pair}|${interval}`;
    if (htfCache[k]) { reused++; continue; }
    try {
      htfCache[k] = await td(pair, interval, from, "2026-09-25");
      fetched++;
      await Deno.writeTextFile(HTF, JSON.stringify(htfCache));
      console.log(`  ${k.padEnd(16)} ${String(htfCache[k].length).padStart(5)} bars`);
      await new Promise((s) => setTimeout(s, 9000));
    } catch (e) {
      console.log(`  ${k.padEnd(16)} FAILED ${(e as Error).message}`);
      htfCache[k] = [];
    }
  }
}
console.log(`fetch: ${fetched} new, ${reused} reused, ${requests} requests, ${apiErrors} errors`);

const ms = (t: string): number => {
  const iso = t.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const v = Date.parse(iso);
  if (!Number.isFinite(v)) throw new Error(`unparseable timestamp: ${t}`);
  return v;
};

function closedBy(series: Candle[], barMs: number, at: number, depth = DEPTH): Candle[] {
  const out: Candle[] = [];
  for (const c of series) { if (ms(c.datetime) + barMs <= at) out.push(c); else break; }
  return out.slice(-depth);
}

/**
 * Rebuilds `htfConfluenceData` exactly as bot-scanner L4840-4953 / L5495 does.
 * Every call below is the production function; nothing is reimplemented.
 */
function buildHtf(pair: string, at: number, dir: "bullish" | "bearish"): HTFConfluenceData | null {
  const h4 = closedBy(htfCache[`${pair}|4h`] ?? [], BAR_MS["4h"], at);
  const d1 = closedBy(htfCache[`${pair}|1day`] ?? [], BAR_MS["1day"], at);
  if (h4.length < 20) return null;

  const st = analyzeMarketStructure(h4);
  const breaks = [...st.bos, ...st.choch];
  const h4FVGs = detectFVGs(h4, breaks);
  const h4OBs = detectOrderBlocks(h4, breaks);
  const h4Breakers = detectBreakerBlocks(h4OBs, h4, breaks);

  const z4 = detectZigZagPivots(h4, 3, 10);
  const htfFibLevels = z4.lastTwo ? computeFibLevels(z4.lastTwo[0], z4.lastTwo[1]) : null;
  const zD = d1.length >= 20 ? detectZigZagPivots(d1, 3, 10) : { lastTwo: null };
  const dailyFibLevels = zD.lastTwo ? computeFibLevels(zD.lastTwo[0], zD.lastTwo[1]) : null;
  const htfPD = calculatePremiumDiscount(h4);

  return { h4OBs, h4FVGs, h4Breakers, htfFibLevels, dailyFibLevels, htfPD, direction: dir };
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-run the Stage 1 oracle, with and without the restored argument
// ─────────────────────────────────────────────────────────────────────────────

const near = (a: number | null | undefined, b: number | null | undefined, tol: number) =>
  a == null || b == null ? a == b : Math.abs(a - b) <= tol;

interface Tally { n: number; before: number; after: number }
const byPair: Record<string, Tally> = {};
let skipped = 0;

for (const r of oracle) {
  const at = ms(r.scanned_at);
  const spec = SPECS[r.pair] ?? SPECS["EUR/USD"];
  const tol = spec.pipSize * 0.5;

  const m5 = closedBy(cache[`${r.pair}|5m`] ?? [], BAR_MS["5m"], at);
  const m15 = closedBy(cache[`${r.pair}|15m`] ?? [], BAR_MS["15m"], at);
  const h1 = closedBy(cache[`${r.pair}|1h`] ?? [], BAR_MS["1h"], at);
  const dir = r.uz.impulse?.direction as "bullish" | "bearish" | undefined;
  if (!dir || m5.length < DEPTH || m15.length < DEPTH || h1.length < DEPTH) { skipped++; continue; }

  const pools = detectLiquidityPools(h1, 0.0005, 2);
  const htf = buildHtf(r.pair, at, dir);
  const t = byPair[r.pair] ??= { n: 0, before: 0, after: 0 };
  t.n++;

  const run = (withHtf: boolean) => findUnifiedZone(
    m5, m15, m5, dir, m5[m5.length - 1].close, pools,
    withHtf ? (htf ?? undefined) : undefined,
    { pipSize: spec.pipSize }, h1, m15.length >= 15 ? m15 : m5, m5, {},
    { top: "1H", mid: "15m", low: "5m" },
  );

  const pz = r.uz.zone, pi = r.uz.impulse;
  const matches = (res: ReturnType<typeof findUnifiedZone>) =>
    (r.uz.selectedTF ?? null) === (res.selectedTF ?? null) &&
    near(pi?.high, res.impulse?.high, tol) && near(pi?.low, res.impulse?.low, tol) &&
    near(pi?.bosPrice, res.impulse?.bosPrice, tol) &&
    near(pz?.high, res.zone?.high, tol) && near(pz?.low, res.zone?.low, tol) &&
    (pz?.type ?? null) === (res.zone?.type ?? null);

  if (matches(run(false))) t.before++;
  if (matches(run(true))) t.after++;
}

const pct = (a: number, b: number) => b ? `${(a / b * 100).toFixed(1)}%` : "—";
console.log(`\n${"=".repeat(96)}`);
console.log("BEFORE / AFTER restoring htfConfluenceData");
console.log("=".repeat(96));
console.log(`${"pair".padEnd(10)}${"n".padStart(6)}${"before".padStart(9)}${"after".padStart(9)}${"delta".padStart(9)}`);
let N = 0, B = 0, A = 0;
for (const [p, t] of Object.entries(byPair).sort((a, b) => b[1].n - a[1].n)) {
  N += t.n; B += t.before; A += t.after;
  console.log(`${p.padEnd(10)}${String(t.n).padStart(6)}${pct(t.before, t.n).padStart(9)}${pct(t.after, t.n).padStart(9)}` +
    `${((t.after - t.before) / t.n * 100 >= 0 ? "+" : "") + ((t.after - t.before) / t.n * 100).toFixed(1) + "pp"}`.padStart(9));
}
console.log(`${"TOTAL".padEnd(10)}${String(N).padStart(6)}${pct(B, N).padStart(9)}${pct(A, N).padStart(9)}` +
  `${((A - B) / N * 100 >= 0 ? "+" : "") + ((A - B) / N * 100).toFixed(1) + "pp"}`.padStart(9));
console.log(`skipped ${skipped}`);

await Deno.writeTextFile(OUT, JSON.stringify({
  byPair, total: { n: N, before: B, after: A }, skipped,
  api: { requests, fetched, reused, apiErrors },
}, null, 1));
console.log(`\nwrote ${OUT}`);
