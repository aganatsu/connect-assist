/**
 * STAGE 2G — DETERMINISM REPLAY. Takes a scan_cycle_id, rebuilds exactly what
 * the scanner fed the zone engine, re-runs the UNMODIFIED engine, and reports
 * whether the answer matches what production recorded.
 *
 * READ-ONLY. It writes nothing, deploys nothing, and changes no strategy code.
 *
 * WHY THIS EXISTS. Stage 1 could not determinism-test the zone engine at all:
 * the candles it scored were never persisted, so "replay" meant re-fetching from
 * the provider and hoping. Stage 2 measured that ceiling at 92.1% and proved it
 * could not be raised, because the remaining disagreement IS the provider
 * returning different bars. This utility only works on scans recorded AFTER the
 * observability patch is deployed — before that there is nothing to replay
 * against, and it says so rather than pretending.
 *
 * WHAT A MISMATCH MEANS. Not necessarily a bug. The engine reads wall-clock
 * nowhere that Stage 1 found, so a same-input mismatch would be genuinely
 * surprising — but a DIFFERENT-input mismatch is expected and is reported
 * separately. The three failure modes are kept apart on purpose:
 *
 *   BARS_UNRECOVERABLE   stored bars do not rebuild the manifest's digest.
 *                        Storage problem, not an engine problem.
 *   INPUTS_DIVERGED      bars rebuilt, but a re-derived HTF bundle or liquidity
 *                        set does not match its recorded digest. The detectors
 *                        changed under us; the engine was never reached.
 *   ENGINE_DIVERGED      identical inputs, different output. This is the only
 *                        one that indicts the engine.
 *
 * Usage:
 *   deno run --allow-net --allow-env local-runner/zone-stage2-replay.ts <scan_cycle_id>
 *   deno run --allow-net --allow-env local-runner/zone-stage2-replay.ts <scan_cycle_id> --symbol EUR/USD
 *   deno run --allow-net --allow-env local-runner/zone-stage2-replay.ts --latest 20
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment. The
 * key is read from env only — never a flag, never printed.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { findUnifiedZone, type UnifiedZoneResult } from "../supabase/functions/_shared/unifiedZoneEngine.ts";
import type { HTFConfluenceData, TFSlotLabels } from "../supabase/functions/_shared/impulseZoneEngine.ts";
import {
  analyzeMarketStructure, detectFVGs, detectOrderBlocks, detectBreakerBlocks,
  detectZigZagPivots, computeFibLevels, calculatePremiumDiscount, detectLiquidityPools,
  type Candle, type LiquidityPool,
} from "../supabase/functions/_shared/smcAnalysis.ts";
import {
  reconstruct, hashStructure, type ManifestRow,
} from "../supabase/functions/_shared/smcScanSnapshot.ts";

type Verdict =
  | "MATCH" | "ENGINE_DIVERGED" | "INPUTS_DIVERGED"
  | "BARS_UNRECOVERABLE" | "NO_SNAPSHOT" | "NO_RECORDED_RESULT";

interface Report {
  scan_cycle_id: string;
  symbol: string;
  verdict: Verdict;
  detail: string;
  recorded?: Comparable;
  replayed?: Comparable;
  diffs?: string[];
}

/**
 * The fields compared. Deliberately the ones that drive behaviour — state,
 * chosen timeframe, score, zone boundaries and the entry triple — rather than
 * the whole result object, which carries prose and display-only fields that
 * would produce noise diffs without ever changing a trade.
 */
interface Comparable {
  hasZone: boolean;
  state: string | null;
  selectedTF: string | null;
  unifiedScore: number | null;
  zoneHigh: number | null;
  zoneLow: number | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
}

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.");
  Deno.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const n = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function comparableOf(r: {
  hasZone?: boolean; state?: string; selectedTF?: string | null; unifiedScore?: number;
  zone?: { high?: number; low?: number } | null;
  entry?: { entry?: number; stop?: number; target?: number } | null;
}): Comparable {
  return {
    hasZone: !!r.hasZone,
    state: r.state ?? null,
    selectedTF: r.selectedTF ?? null,
    unifiedScore: n(r.unifiedScore),
    zoneHigh: n(r.zone?.high),
    zoneLow: n(r.zone?.low),
    entry: n(r.entry?.entry),
    stop: n(r.entry?.stop),
    target: n(r.entry?.target),
  };
}

/**
 * Prices are compared at 1e-9, not by identity.
 *
 * Both sides run the same float arithmetic on the same inputs, so exact
 * equality SHOULD hold — but a tolerance keeps the report about behaviour
 * rather than about the last bit of a double. Anything a tolerance hides here
 * is far below a pip.
 */
function diff(a: Comparable, b: Comparable): string[] {
  const out: string[] = [];
  const near = (x: number | null, y: number | null) =>
    x === null || y === null ? x === y : Math.abs(x - y) < 1e-9;
  for (const k of Object.keys(a) as (keyof Comparable)[]) {
    const av = a[k], bv = b[k];
    const same = typeof av === "number" || typeof bv === "number"
      ? near(av as number | null, bv as number | null)
      : av === bv;
    if (!same) out.push(`${k}: recorded=${av} replayed=${bv}`);
  }
  return out;
}

/** Bars for one (symbol, timeframe) window, oldest first. */
async function barsFor(symbol: string, timeframe: string, from: string, to: string): Promise<Candle[]> {
  const { data, error } = await db.from("smc_scan_bars")
    .select("bar_time, open, high, low, close, volume")
    .eq("symbol", symbol).eq("timeframe", timeframe)
    .gte("bar_time", from).lte("bar_time", to)
    .order("bar_time", { ascending: true }).limit(5000);
  if (error) throw new Error(`bars ${symbol} ${timeframe}: ${error.message}`);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    // Postgres renders timestamptz as "+00", which Date.parse rejects and which
    // silently emptied every window in the Stage 1 harness. Normalise to Z, and
    // keep the normalised string as the identity used for hashing.
    datetime: String(r.bar_time).replace(/([+-]\d{2})(:?\d{2})?$/, "Z").replace(/\s/, "T"),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
    volume: r.volume === null ? undefined : Number(r.volume),
  })) as Candle[];
}

/**
 * Re-derives the HTF confluence bundle from stored 4H/Daily arrays using the
 * SAME production detectors the scanner used, then verifies it against the
 * recorded digest. Returns null when it cannot be rebuilt — never a partial
 * bundle, because Stage 2E showed a partial one is worse than an absent one in
 * a way the totals hide.
 */
function rederiveHtf(h4: Candle[], daily: Candle[], direction: string | null): HTFConfluenceData | null {
  if (!direction || h4.length < 20) return null;
  const st = analyzeMarketStructure(h4);
  const breaks = [...st.bos, ...st.choch];
  const obs = detectOrderBlocks(h4, breaks);
  const z4 = detectZigZagPivots(h4, 3, 10);
  const zD = daily.length >= 20 ? detectZigZagPivots(daily, 3, 10) : null;
  return {
    h4OBs: obs,
    h4FVGs: detectFVGs(h4, breaks),
    h4Breakers: detectBreakerBlocks(obs, h4, breaks),
    htfFibLevels: z4.lastTwo ? computeFibLevels(z4.lastTwo[0], z4.lastTwo[1]) : null,
    dailyFibLevels: zD?.lastTwo ? computeFibLevels(zD.lastTwo[0], zD.lastTwo[1]) : null,
    htfPD: calculatePremiumDiscount(h4),
    direction: direction === "long" || direction === "bullish" ? "bullish" : "bearish",
  } as HTFConfluenceData;
}

function rederivePools(daily: Candle[], h4: Candle[], h1: Candle[]): LiquidityPool[] {
  const pools: LiquidityPool[] = [];
  for (const cs of [daily, h4, h1]) {
    if (cs.length >= 20) pools.push(...detectLiquidityPools(cs, 0.35, 2));
  }
  return pools;
}

async function replaySymbol(scanCycleId: string, symbol: string): Promise<Report> {
  const base = { scan_cycle_id: scanCycleId, symbol };

  const [{ data: ctxRows }, { data: manRows }] = await Promise.all([
    db.from("smc_scan_context").select("*").eq("scan_cycle_id", scanCycleId).eq("symbol", symbol).limit(1),
    db.from("smc_scan_manifest").select("*").eq("scan_cycle_id", scanCycleId).eq("symbol", symbol),
  ]);
  const ctx = ctxRows?.[0];
  const manifests = (manRows ?? []) as unknown as (ManifestRow & { slot: string })[];
  if (!ctx || manifests.length === 0) {
    return { ...base, verdict: "NO_SNAPSHOT",
      detail: "no snapshot for this scan — it predates the observability patch, or the write failed" };
  }

  // ── rebuild every slot, verifying each against its digest ──────────────────
  const slots: Record<string, Candle[]> = {};
  const contextTFs: Record<string, Candle[]> = {};
  for (const m of manifests) {
    const stored = await barsFor(symbol, m.timeframe, m.first_bar_time, m.last_bar_time);
    const built = reconstruct(m, stored);
    if (!built.ok) {
      return { ...base, verdict: "BARS_UNRECOVERABLE",
        detail: `slot ${m.slot} (${m.timeframe}): ${built.reason}` };
    }
    if (m.slot === "context") contextTFs[m.timeframe] = built.candles;
    else slots[m.slot] = built.candles;
  }

  // ── re-derive the non-candle bundles and verify them ───────────────────────
  const h4 = contextTFs["4h"] ?? [], daily = contextTFs["1d"] ?? [], h1 = contextTFs["1h"] ?? [];
  const htf = rederiveHtf(h4, daily, ctx.direction);
  const pools = rederivePools(daily, h4, h1);

  const htfHash = htf == null ? null : hashStructure(htf);
  const poolHash = hashStructure(pools);
  const inputDiffs: string[] = [];
  if (htfHash !== ctx.htf_confluence_hash) {
    inputDiffs.push(`htf_confluence: recorded=${ctx.htf_confluence_hash} rederived=${htfHash}`);
  }
  if (poolHash !== ctx.liquidity_pool_hash) {
    inputDiffs.push(`liquidity_pools: recorded=${ctx.liquidity_pool_hash} rederived=${poolHash}`);
  }
  if (inputDiffs.length) {
    // Stop here deliberately. Running the engine on inputs already known to
    // differ would produce an "engine mismatch" that is nothing of the sort —
    // exactly the confusion the Stage 1 AUD/USD outlier turned out to be.
    return { ...base, verdict: "INPUTS_DIVERGED",
      detail: "re-derived engine inputs do not match the recorded digests; engine not run",
      diffs: inputDiffs };
  }

  // ── what production recorded ───────────────────────────────────────────────
  const { data: hist } = await db.from("scan_history")
    .select("payload").eq("payload->>scan_cycle_id", scanCycleId).limit(1);
  const detail = (hist?.[0]?.payload?.scan_details ?? [])
    .find((d: Record<string, unknown>) => d.pair === symbol || d.symbol === symbol);
  const recordedZone = detail?.unifiedZone;
  if (!recordedZone) {
    return { ...base, verdict: "NO_RECORDED_RESULT",
      detail: "snapshot exists but scan_history has no unifiedZone for this symbol" };
  }

  // ── re-run the UNMODIFIED engine ───────────────────────────────────────────
  const ea = (ctx.engine_args ?? {}) as Record<string, number | boolean | undefined>;
  // POSITIONAL ORDER MATTERS AND IS COUNTER-INTUITIVE. The engine's first three
  // arguments are named h1/h4/entry but are TF-agnostic slots: the scanner
  // passes its LOWEST structural array first and its HIGHEST as the ninth
  // argument. Feeding `top` first would silently invert the waterfall and
  // produce a mismatch that looks like engine nondeterminism.
  const replayed: UnifiedZoneResult = findUnifiedZone(
    slots.low ?? [],            // arg1 "h1"    = lowest structural slot
    slots.mid ?? [],            // arg2 "h4"    = mid structural slot
    slots.entry ?? [],          // arg3 "entry"
    (ctx.direction === "long" || ctx.direction === "bullish" ? "bullish" : "bearish"),
    ctx.last_price,
    pools,
    htf ?? undefined,
    {
      strictATRMult: ea.strictATRMult as number,
      pipSize: ea.pipSize as number,
      fibMaxRetracement: ea.fibMaxRetracement as number,
      originOBRetest: ea.originOBRetest as boolean,
    },
    // arg9 "daily" = highest structural slot. Left undefined when production
    // withheld it for being too short — an empty array is not the same input.
    slots.top,
    slots.confirm ?? [],
    slots.ltf_confirm ?? [],
    {
      minSlPips: ea.minSlPips as number,
      maxSlPips: ea.maxSlPips as number,
      tpRatio: ea.tpRatio as number,
      entryDepth: ea.entryDepth as number,
    },
    (ctx.tf_labels?.display ?? ctx.tf_labels) as TFSlotLabels,
  );

  const a = comparableOf(recordedZone), b = comparableOf(replayed as never);
  const diffs = diff(a, b);
  return {
    ...base,
    verdict: diffs.length ? "ENGINE_DIVERGED" : "MATCH",
    detail: diffs.length ? `${diffs.length} field(s) differ on identical inputs` : "identical inputs, identical output",
    recorded: a, replayed: b, diffs: diffs.length ? diffs : undefined,
  };
}

/** Every symbol snapshotted under one scan. */
export async function replayScan(scanCycleId: string, only?: string): Promise<Report[]> {
  const { data, error } = await db.from("smc_scan_context")
    .select("symbol").eq("scan_cycle_id", scanCycleId);
  if (error) throw new Error(`context lookup: ${error.message}`);
  let symbols = [...new Set((data ?? []).map((r: { symbol: string }) => r.symbol))];
  if (only) symbols = symbols.filter((s) => s === only);
  if (!symbols.length) {
    return [{ scan_cycle_id: scanCycleId, symbol: only ?? "*", verdict: "NO_SNAPSHOT",
      detail: "no snapshot rows for this scan_cycle_id" }];
  }
  const out: Report[] = [];
  for (const s of symbols) out.push(await replaySymbol(scanCycleId, s));
  return out;
}

if (import.meta.main) {
  const argv = Deno.args;
  const symbolAt = argv.indexOf("--symbol");
  const only = symbolAt >= 0 ? argv[symbolAt + 1] : undefined;
  const latestAt = argv.indexOf("--latest");

  let scans: string[];
  if (latestAt >= 0) {
    const limit = Number(argv[latestAt + 1] ?? 10);
    const { data } = await db.from("smc_scan_context")
      .select("scan_cycle_id, scanned_at").order("scanned_at", { ascending: false }).limit(limit * 12);
    scans = [...new Set((data ?? []).map((r: { scan_cycle_id: string }) => r.scan_cycle_id))].slice(0, limit);
  } else {
    const id = argv.find((a) => !a.startsWith("--") && a !== only);
    if (!id) {
      console.error("usage: zone-stage2-replay.ts <scan_cycle_id> [--symbol SYM] | --latest N");
      Deno.exit(1);
    }
    scans = [id];
  }

  const all: Report[] = [];
  for (const s of scans) all.push(...await replayScan(s, only));

  const tally: Record<string, number> = {};
  for (const r of all) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;

  console.log(`\nSTAGE 2G DETERMINISM REPLAY — ${scans.length} scan(s), ${all.length} symbol-replays\n`);
  for (const [k, v] of Object.entries(tally).sort((x, y) => y[1] - x[1])) {
    console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)}  ${(100 * v / all.length).toFixed(1)}%`);
  }
  const bad = all.filter((r) => r.verdict === "ENGINE_DIVERGED" || r.verdict === "INPUTS_DIVERGED");
  if (bad.length) {
    console.log(`\n── divergences ──`);
    for (const r of bad.slice(0, 40)) {
      console.log(`\n  ${r.symbol}  ${r.scan_cycle_id}  ${r.verdict}`);
      for (const d of r.diffs ?? []) console.log(`      ${d}`);
    }
    if (bad.length > 40) console.log(`\n  … and ${bad.length - 40} more`);
  }
  // A run with nothing to replay must not read as a clean bill of health. This
  // is the Stage 1 failure where the harness printed DETERMINISM_MATCH on 0/0.
  const replayable = all.filter((r) => r.verdict === "MATCH" || r.verdict === "ENGINE_DIVERGED").length;
  console.log(`\n  replayable: ${replayable}/${all.length}` +
    (replayable === 0 ? "  — NOTHING WAS COMPARED. This is not a passing result." : ""));
  console.log();
}
