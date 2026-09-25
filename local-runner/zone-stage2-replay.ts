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
import type { Candle, LiquidityPool } from "../supabase/functions/_shared/smcAnalysis.ts";
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

/**
 * Bars for one (symbol, timeframe) window, AS KNOWN AT `asOf`.
 *
 * The store holds one row per distinct observed value, because a provider may
 * revise a bar that has already closed — measured directly: a 5m bar stored 14
 * seconds after its close was still provisional, and was settled differently by
 * the next scan. Reconstruction therefore picks, for each bar_time, the latest
 * observation that existed when the scan ran. Taking the newest value outright
 * would rebuild a version of history the scanner never saw.
 */
async function barsFor(
  symbol: string, timeframe: string, from: string, to: string, asOf: string,
): Promise<Candle[]> {
  const { data, error } = await db.from("smc_scan_bars")
    .select("bar_time, bar_time_raw, open, high, low, close, volume, first_seen_at")
    .eq("symbol", symbol).eq("timeframe", timeframe)
    .gte("bar_time", from).lte("bar_time", to)
    .lte("first_seen_at", asOf)
    .order("bar_time", { ascending: true })
    .order("first_seen_at", { ascending: true })
    .limit(20000);
  if (error) throw new Error(`bars ${symbol} ${timeframe}: ${error.message}`);

  // Ascending first_seen_at means the last write per bar_time wins — the most
  // recent observation available at scan time.
  const latest = new Map<string, Candle>();
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    // Postgres renders timestamptz as "+00", which Date.parse rejects and which
    // silently emptied every window in the Stage 1 harness.
    // The verbatim provider string, not the canonicalised timestamptz: the
    // digest is over the bytes the engine saw, and timestamptz drops ".000".
    const dt = (r.bar_time_raw as string) ||
      String(r.bar_time).replace(/([+-]\d{2})(:?\d{2})?$/, "Z").replace(/\s/, "T");
    latest.set(dt, {
      datetime: dt,
      open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
      volume: r.volume === null ? undefined : Number(r.volume),
    } as Candle);
  }
  return [...latest.values()].sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
}

async function replaySymbol(scanCycleId: string, symbol: string): Promise<Report> {
  const base = { scan_cycle_id: scanCycleId, symbol };

  const [{ data: ctxRows }, { data: manRows }] = await Promise.all([
    db.from("smc_scan_context").select("*").eq("scan_cycle_id", scanCycleId).eq("symbol", symbol).limit(1),
    db.from("smc_scan_manifest").select("*").eq("scan_cycle_id", scanCycleId).eq("symbol", symbol),
  ]);
  const ctx = ctxRows?.[0];
  const manifests = (manRows ?? []) as unknown as (ManifestRow & { slot: string; scanned_at: string })[];
  if (!ctx || manifests.length === 0) {
    return { ...base, verdict: "NO_SNAPSHOT",
      detail: "no snapshot for this scan — it predates the observability patch, or the write failed" };
  }

  // ── rebuild every slot, verifying each against its digest ──────────────────
  const slots: Record<string, Candle[]> = {};
  const contextTFs: Record<string, Candle[]> = {};
  for (const m of manifests) {
    const stored = await barsFor(symbol, m.timeframe, m.first_bar_time, m.last_bar_time, m.scanned_at);
    const built = reconstruct(m, stored);
    if (!built.ok) {
      return { ...base, verdict: "BARS_UNRECOVERABLE",
        detail: `slot ${m.slot} (${m.timeframe}): ${built.reason}` };
    }
    // Context slots are no longer an input to the replay now that the derived
    // bundles are stored, but they are still reconstructed and digest-checked:
    // they are the provenance of those bundles, and a silent failure to store
    // them would otherwise go unnoticed until someone needed them.
    if (m.slot === "context") contextTFs[m.timeframe] = built.candles;
    else slots[m.slot] = built.candles;
  }

  // ── the non-candle bundles, as stored ─────────────────────────────────────
  //
  // Read back rather than re-derived. They depend on detector parameters that
  // are config-driven, and an earlier version of this utility guessed them —
  // producing a mismatch that looked like divergence but was only a wrong
  // reconstruction. The digests still run, now as an integrity check on the
  // stored value rather than as a test of the reconstruction.
  const htf = (ctx.htf_confluence ?? null) as HTFConfluenceData | null;
  const pools = (ctx.liquidity_pools ?? []) as LiquidityPool[];

  const inputDiffs: string[] = [];
  const htfHash = htf == null ? null : hashStructure(htf);
  if (htfHash !== ctx.htf_confluence_hash) {
    inputDiffs.push(`htf_confluence: recorded=${ctx.htf_confluence_hash} stored=${htfHash}`);
  }
  if (ctx.liquidity_pools != null && hashStructure(pools) !== ctx.liquidity_pool_hash) {
    inputDiffs.push(`liquidity_pools: recorded=${ctx.liquidity_pool_hash} stored=${hashStructure(pools)}`);
  }
  if (ctx.htf_confluence === undefined) {
    // Rows written before the bundles were stored cannot be replayed, and must
    // not be silently treated as "no HTF confluence" — that is the Stage 2E
    // error exactly.
    return { ...base, verdict: "NO_SNAPSHOT",
      detail: "context row predates stored derived bundles; inputs unrecoverable" };
  }
  if (inputDiffs.length) {
    // Stop here deliberately. Running the engine on inputs already known to
    // differ would produce an "engine mismatch" that is nothing of the sort.
    return { ...base, verdict: "INPUTS_DIVERGED",
      detail: "stored engine inputs do not match their recorded digests; engine not run",
      diffs: inputDiffs };
  }

  // ── what production recorded ───────────────────────────────────────────────
  //
  // A full scan records its per-pair results in `scan_logs.details_json`, NOT
  // `scan_history` — the latter only gets written on early-return paths
  // (management_only, prop-firm lock). Reading the wrong one makes every scan
  // look unrecorded.
  //
  // The join key is `__meta.scan_cycle_id`. Rows written before that field
  // existed fall back to nearest-timestamp within one scan interval, which is
  // unambiguous at a 5-minute cadence but is a guess — so it is labelled.
  const { data: logs } = await db.from("scan_logs")
    .select("scanned_at, details_json")
    .gte("scanned_at", new Date(Date.parse(ctx.scanned_at) - 150_000).toISOString())
    .lte("scanned_at", new Date(Date.parse(ctx.scanned_at) + 150_000).toISOString())
    .order("scanned_at", { ascending: true });

  let matched: Record<string, unknown> | undefined;
  let joinedBy = "scan_cycle_id";
  for (const row of logs ?? []) {
    // scan_logs.details_json is usually an array of per-pair details with a
    // leading __meta element, but some rows store an object instead. Coercing
    // rather than assuming — a throw here would abort the whole audit run.
    const raw = row.details_json;
    const details = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
    const meta = details.find((d) => d.__meta === true);
    if (meta && meta.scan_cycle_id && meta.scan_cycle_id !== scanCycleId) continue;
    if (!meta?.scan_cycle_id) joinedBy = "timestamp_proximity";
    const d = details.find((x) => x.pair === symbol || x.symbol === symbol);
    if (d) { matched = d; break; }
  }
  const recordedZone = matched?.unifiedZone as Record<string, never> | undefined;
  if (!recordedZone) {
    return { ...base, verdict: "NO_RECORDED_RESULT",
      detail: "snapshot exists but no scan_logs entry carries a unifiedZone for this symbol" };
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
    detail: (diffs.length ? `${diffs.length} field(s) differ on identical inputs` :
      "identical inputs, identical output") + ` (joined by ${joinedBy})`,
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
  const bad = all.filter((r) => r.verdict !== "MATCH");
  if (bad.length) {
    console.log(`\n── divergences ──`);
    for (const r of bad.slice(0, 40)) {
      console.log(`\n  ${r.symbol}  ${r.scan_cycle_id}  ${r.verdict}`);
      console.log(`      ${r.detail}`);
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
