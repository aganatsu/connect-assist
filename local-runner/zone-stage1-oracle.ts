/**
 * SMC ZONE / IMPULSE — STAGE 1 RESEARCH HARNESS AND RE-DERIVATION ORACLE.
 *
 * RESEARCH ONLY. No production module is modified, no database is written, no
 * deployment, no strategy rule is changed. Every rule below is executed by
 * calling the PRODUCTION functions unmodified — this file contains no copy of
 * any detection rule.
 *
 * WHAT THIS CAN AND CANNOT PROVE.
 *
 * The task asks for a determinism test: feed the harness the same candles
 * production saw and compare. That test CANNOT be run. `scan_candle_snapshots`
 * — the table built to persist a scan's input candles — contains ZERO rows, so
 * the inputs production actually saw were never recorded. What survives is the
 * OUTPUT: 3,850 `scan_logs` details carrying a full `unifiedZone` payload.
 *
 * So this runs the weaker test that the surviving evidence supports: re-fetch
 * the same provider's candles for the same instant, re-run the production zone
 * engine, and measure how often the impulse and zone GEOMETRY match what
 * production recorded. A mismatch is then ambiguous — harness fault or
 * different input bars — and the result is reported as a RE-DERIVATION rate,
 * never as determinism.
 *
 * Two facts make it worth running at all:
 *   - `sourceBreakdown` in every scan shows metaapi 0 / polygon 0 /
 *     twelvedata N, so the provider is the same feed this script fetches.
 *   - `activeStyle` is `scalper`, so the zone slots are 1H / 15m / 5m — NOT the
 *     Daily / 4H / 1H the brief assumed.
 */

import { findUnifiedZone } from "../supabase/functions/_shared/unifiedZoneEngine.ts";
import { detectLiquidityPools, SPECS, type Candle } from "../supabase/functions/_shared/smcAnalysis.ts";

const KEY = Deno.env.get("TWELVE_DATA_API_KEY");
if (!KEY) { console.error("TWELVE_DATA_API_KEY not set; refusing to run."); Deno.exit(1); }

const ORACLE = "/tmp/zone-oracle.json";
const CACHE = "/tmp/zone-stage1-candles.json";
const OUT = "/tmp/zone-stage1-oracle-result.json";

interface OracleRow { scanned_at: string; pair: string; uz: Record<string, any> }
const oracle: OracleRow[] = JSON.parse(await Deno.readTextFile(ORACLE));

/**
 * Production candle depth, from bot-scanner:
 *   CANDLE_LIMITS = { "4h": 800 }   DEFAULT_CANDLE_LIMIT = 300
 * Scalper uses 5m (entry), 15m (structure) and 1H (top slot), 300 bars each.
 */
const DEPTH = 300;
/**
 * WARMUP IS PER TIMEFRAME, AND IT MATTERS.
 *
 * Production holds 300 bars of each. The oracle window opens 2026-09-15, so a
 * fetch must reach 300 bars BEFORE that date or the very first scans replay
 * against a short series — and `analyzeMarketStructure` reads the whole array,
 * so a short series is a different impulse, not a smaller one.
 *
 *   5m   300 bars ~ 1 day of session     -> 4 days back
 *   15m  300 bars ~ 3.1 days             -> 8 days back
 *   1H   300 bars ~ 18 days (FX 24x5)    -> 32 days back
 *
 * A first run with a flat 2026-09-13 start gave 289 1H bars against production's
 * 300, on the slot that carries 3,184 of the 3,850 observations. That would have
 * produced a mismatch caused by the harness, not by the engine.
 */
const TFS = [
  { interval: "5min", key: "5m", barMs: 300_000, from: "2026-09-11" },
  { interval: "15min", key: "15m", barMs: 900_000, from: "2026-09-07" },
  { interval: "1h", key: "1h", barMs: 3_600_000, from: "2026-08-14" },
] as const;

const PAIRS = [...new Set(oracle.map((r) => r.pair))].sort();
const TO = "2026-09-25";

let cache: Record<string, Candle[]> = {};
try { cache = JSON.parse(await Deno.readTextFile(CACHE)); } catch { /* cold */ }
let requests = 0, rateLimited = 0, cacheHits = 0, cacheMisses = 0, apiErrors = 0;

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
    const res = await fetch(u);
    b = await res.json();
    if (b?.status !== "error") break;
    if (String(b?.code) === "429") { rateLimited++; await new Promise((s) => setTimeout(s, 65_000)); continue; }
    apiErrors++; throw new Error(`twelvedata ${b?.code}: ${String(b?.message).slice(0, 90)}`);
  }
  if (b?.status === "error") { apiErrors++; throw new Error("gave up"); }
  return (b?.values ?? []).map((v: Record<string, string>) => ({
    datetime: `${v.datetime.replace(" ", "T")}Z`,
    open: Number(v.open), high: Number(v.high), low: Number(v.low),
    close: Number(v.close), volume: Number(v.volume ?? 0),
  }));
}

console.log("=".repeat(96));
console.log("STAGE 1 — candle acquisition for the re-derivation oracle");
console.log("=".repeat(96));
for (const pair of PAIRS) {
  for (const tf of TFS) {
    const k = `${pair}|${tf.key}`;
    if (cache[k]) { cacheHits++; continue; }
    cacheMisses++;
    try {
      cache[k] = await td(pair, tf.interval, tf.from, TO);
      await Deno.writeTextFile(CACHE, JSON.stringify(cache));
      console.log(`  ${k.padEnd(16)} ${String(cache[k].length).padStart(5)} bars  ${cache[k][0]?.datetime.slice(0,16) ?? "—"} .. ${cache[k].at(-1)?.datetime.slice(0,16) ?? "—"}`);
      await new Promise((s) => setTimeout(s, 9000));
    } catch (e) {
      console.log(`  ${k.padEnd(16)} FETCH FAILED: ${(e as Error).message}`);
      cache[k] = [];
    }
  }
}
console.log(`cache: ${cacheHits} hits, ${cacheMisses} misses; API ${requests} requests, ${rateLimited} 429s, ${apiErrors} errors`);

// ─────────────────────────────────────────────────────────────────────────────
// The replay
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Postgres renders a timestamptz as `2026-09-15 02:06:25.910988+00`, and
 * `Date.parse` returns NaN for a bare `+00` offset. A first run silently
 * compared nothing at all: every scan time was NaN, every window came back
 * empty, and 3,850 observations were counted as "skipped" rather than as the
 * parse failure they were.
 */
const ms = (t: string): number => {
  const iso = t.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const v = Date.parse(iso);
  if (!Number.isFinite(v)) throw new Error(`unparseable timestamp: ${t}`);
  return v;
};

/**
 * The bars production would have held at `at`.
 *
 * ONLY FULLY CLOSED BARS. The scanner's own `closedBarsOnly` convention is used
 * rather than guessed at: a bar counts once its close instant has passed. This
 * is also the first place the causal question bites — see the audit doc.
 */
function windowAt(pair: string, tfKey: string, barMs: number, at: number): Candle[] {
  const all = cache[`${pair}|${tfKey}`] ?? [];
  const closed: Candle[] = [];
  for (const c of all) {
    if (ms(c.datetime) + barMs <= at) closed.push(c); else break;
  }
  return closed.slice(-DEPTH);
}

interface Cmp {
  scanned_at: string; pair: string;
  ok: boolean;
  reasons: string[];
  prodTF: string | null; harnTF: string | null;
  prodState: string; harnState: string;
  prodZone: { high: number; low: number; type: string } | null;
  harnZone: { high: number; low: number; type: string } | null;
  prodImpulse: { high: number; low: number; bosPrice: number | null } | null;
  harnImpulse: { high: number; low: number; bosPrice: number | null } | null;
  bars: Record<string, number>;
}

const near = (a: number | null | undefined, b: number | null | undefined, tol: number) =>
  a == null || b == null ? a == b : Math.abs(a - b) <= tol;

const results: Cmp[] = [];
let skippedNoBars = 0;

console.log(`\n${"=".repeat(96)}`);
console.log(`RE-DERIVATION over ${oracle.length} production zone observations`);
console.log("=".repeat(96));

for (const r of oracle) {
  const at = ms(r.scanned_at);
  const spec = SPECS[r.pair] ?? SPECS["EUR/USD"];

  const m5 = windowAt(r.pair, "5m", 300_000, at);
  const m15 = windowAt(r.pair, "15m", 900_000, at);
  const h1 = windowAt(r.pair, "1h", 3_600_000, at);
  // A window short of production depth is not comparable: the structure
  // functions read the whole array. Skipped and counted, never compared.
  if (m5.length < DEPTH || m15.length < DEPTH || h1.length < DEPTH) { skippedNoBars++; continue; }

  // Production scalper slot mapping, from bot-scanner:
  //   top = 1H, mid = 15m, low = 5m, entry = 5m
  const dir = r.uz.impulse?.direction as "bullish" | "bearish" | undefined;
  if (!dir) { skippedNoBars++; continue; }

  // Liquidity pools are computed at Step 5, AFTER the zone is selected, so they
  // move score and state but never zone geometry. The 1H pools are supplied;
  // the daily and 4H sets production also passes are not fetched, and the
  // consequence is stated in the report rather than hidden.
  const pools = detectLiquidityPools(h1, 0.0005, 2);

  const harn = findUnifiedZone(
    m5,            // zoneH1Candles  (5m, low slot)
    m15,           // zoneH4Candles  (15m, mid slot)
    m5,            // zoneEntryCandles
    dir,
    m5[m5.length - 1].close,
    pools,
    undefined,
    { pipSize: spec.pipSize },
    h1,            // zoneDailyCandles (1H, top slot)
    m15.length >= 15 ? m15 : m5,   // confirmation
    m5,            // ltf confirmation
    {},
    { top: "1H", mid: "15m", low: "5m" },
  );

  const pz = r.uz.zone, pi = r.uz.impulse;
  const hz = harn.zone, hi = harn.impulse;
  const tol = spec.pipSize * 0.5;   // half a pip

  const reasons: string[] = [];
  if ((r.uz.selectedTF ?? null) !== (harn.selectedTF ?? null)) reasons.push("selectedTF");
  if (!near(pi?.high, hi?.high, tol)) reasons.push("impulse.high");
  if (!near(pi?.low, hi?.low, tol)) reasons.push("impulse.low");
  if (!near(pi?.bosPrice, hi?.bosPrice, tol)) reasons.push("impulse.bosPrice");
  if (!near(pz?.high, hz?.high, tol)) reasons.push("zone.high");
  if (!near(pz?.low, hz?.low, tol)) reasons.push("zone.low");
  if ((pz?.type ?? null) !== (hz?.type ?? null)) reasons.push("zone.type");

  results.push({
    scanned_at: r.scanned_at, pair: r.pair,
    ok: reasons.length === 0, reasons,
    prodTF: r.uz.selectedTF ?? null, harnTF: harn.selectedTF ?? null,
    prodState: r.uz.state, harnState: harn.state,
    prodZone: pz ? { high: pz.high, low: pz.low, type: pz.type } : null,
    harnZone: hz ? { high: hz.high, low: hz.low, type: hz.type } : null,
    prodImpulse: pi ? { high: pi.high, low: pi.low, bosPrice: pi.bosPrice ?? null } : null,
    harnImpulse: hi ? { high: hi.high, low: hi.low, bosPrice: hi.bosPrice ?? null } : null,
    bars: { m5: m5.length, m15: m15.length, h1: h1.length },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

const n = results.length;
const exact = results.filter((x) => x.ok).length;
const pct = (a: number, b: number) => b ? `${(a / b * 100).toFixed(1)}%` : "—";

console.log(`\ncompared        ${n}`);
console.log(`skipped         ${skippedNoBars} (insufficient bars or no direction recorded)`);
console.log(`FULL MATCH      ${exact}  ${pct(exact, n)}`);

const tally: Record<string, number> = {};
for (const x of results) for (const why of x.reasons) tally[why] = (tally[why] ?? 0) + 1;
console.log(`\nmismatch by field:`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(18)} ${String(v).padStart(5)}  ${pct(v, n)}`);
}

console.log(`\nby selected timeframe (production):`);
const byTF: Record<string, { n: number; ok: number }> = {};
for (const x of results) {
  const k = x.prodTF ?? "none";
  (byTF[k] ??= { n: 0, ok: 0 }).n++;
  if (x.ok) byTF[k].ok++;
}
for (const [k, v] of Object.entries(byTF).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${k.padEnd(6)} ${String(v.n).padStart(5)} compared, ${String(v.ok).padStart(5)} match  ${pct(v.ok, v.n)}`);
}

console.log(`\nby pair:`);
const byPair: Record<string, { n: number; ok: number }> = {};
for (const x of results) {
  (byPair[x.pair] ??= { n: 0, ok: 0 }).n++;
  if (x.ok) byPair[x.pair].ok++;
}
for (const [k, v] of Object.entries(byPair).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${k.padEnd(9)} ${String(v.n).padStart(5)} compared, ${String(v.ok).padStart(5)} match  ${pct(v.ok, v.n)}`);
}

console.log(`\nstate agreement (independent of geometry):`);
const stateOk = results.filter((x) => x.prodState === x.harnState).length;
console.log(`  ${stateOk}/${n}  ${pct(stateOk, n)}`);

// An empty comparison is NOT a match. The first run reported DETERMINISM_MATCH
// on n=0, which is the most dangerous possible output of an oracle.
const verdict = n === 0 ? "NO_COMPARISON_POSSIBLE"
  : exact === n ? "FULL_REDERIVATION"
  : exact === 0 ? "DETERMINISM_MISMATCH"
  : "PARTIAL_REDERIVATION";
console.log(`\n${"=".repeat(96)}`);
console.log(`${verdict}  —  ${exact}/${n} (${pct(exact, n)}) of production zone observations re-derived exactly`);
console.log(`NOTE: this is a RE-DERIVATION rate, not determinism. scan_candle_snapshots is empty,`);
console.log(`      so the exact input bars production saw were never recorded and cannot be replayed.`);
console.log("=".repeat(96));

await Deno.writeTextFile(OUT, JSON.stringify({
  verdict, compared: n, exact, skipped: skippedNoBars,
  mismatchByField: tally, byTF, byPair, stateAgreement: stateOk,
  api: { requests, cacheHits, cacheMisses, rateLimited, apiErrors },
  rows: results,
}, null, 1));
console.log(`wrote ${OUT}`);
