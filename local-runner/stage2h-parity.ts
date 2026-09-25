/**
 * STAGE 2H — pre-deploy parity proof for the extracted zone decision module.
 *
 * READ-ONLY. Writes nothing, deploys nothing.
 *
 * THE TEST. For every captured scan, rebuild the exact inputs production used
 * (Stage 2G corpus), run the NEW shared module, and compare its output field by
 * field against what production ACTUALLY RECORDED at the time in
 * `scan_logs.details_json[].unifiedZone` and `.impulseZone`.
 *
 * Production's own recorded output is the ground truth, so this compares the
 * extracted module against the real old inline path rather than against another
 * copy of itself. A refactor that changed behaviour cannot pass.
 *
 * Usage:
 *   deno run --allow-net --allow-env local-runner/stage2h-parity.ts
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decideZone, type ResolvedStyle } from "../supabase/functions/_shared/smcZoneDecision.ts";
import {
  decideDirection, buildDirectionConfig, type DirectionStyle,
} from "../supabase/functions/_shared/smcDirectionDecision.ts";
import type { HTFConfluenceData } from "../supabase/functions/_shared/impulseZoneEngine.ts";
import type { Candle, LiquidityPool } from "../supabase/functions/_shared/smcAnalysis.ts";
import { reconstruct, type ManifestRow } from "../supabase/functions/_shared/smcScanSnapshot.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) { console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required"); Deno.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });

/** Bars as known at scan time — provider revisions after t must not leak in. */
async function barsFor(symbol: string, tf: string, from: string, to: string, asOf: string): Promise<Candle[]> {
  const { data, error } = await db.from("smc_scan_bars")
    .select("bar_time, bar_time_raw, open, high, low, close, volume, first_seen_at")
    .eq("symbol", symbol).eq("timeframe", tf)
    .gte("bar_time", from).lte("bar_time", to).lte("first_seen_at", asOf)
    .order("bar_time", { ascending: true }).order("first_seen_at", { ascending: true })
    .limit(20000);
  if (error) throw new Error(`bars ${symbol} ${tf}: ${error.message}`);
  const latest = new Map<string, Candle>();
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const dt = (r.bar_time_raw as string) ||
      String(r.bar_time).replace(/([+-]\d{2})(:?\d{2})?$/, "Z").replace(/\s/, "T");
    latest.set(dt, {
      datetime: dt, open: Number(r.open), high: Number(r.high),
      low: Number(r.low), close: Number(r.close),
      volume: r.volume === null ? undefined : Number(r.volume),
    } as Candle);
  }
  return [...latest.values()].sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
}

/**
 * Compare two values structurally.
 *
 * Numbers use a 1e-9 tolerance: both sides run identical arithmetic, so exact
 * equality should hold, but a tolerance keeps the report about behaviour rather
 * than the last bit of a double. Anything it hides is far below a pip.
 * `undefined` and `null` are treated as equal because the recorded side went
 * through jsonb, which has no undefined.
 */
function diff(a: unknown, b: unknown, path = ""): string[] {
  const out: string[] = [];
  const nil = (v: unknown) => v === null || v === undefined;
  if (nil(a) && nil(b)) return out;
  if (typeof a === "number" && typeof b === "number") {
    if (!(Math.abs(a - b) < 1e-9) && !(Number.isNaN(a) && Number.isNaN(b))) {
      out.push(`${path}: recorded=${a} extracted=${b}`);
    }
    return out;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = (a ?? []) as unknown[], bb = (b ?? []) as unknown[];
    if (aa.length !== bb.length) { out.push(`${path}.length: recorded=${aa.length} extracted=${bb.length}`); return out; }
    for (let i = 0; i < aa.length; i++) out.push(...diff(aa[i], bb[i], `${path}[${i}]`));
    return out;
  }
  if (typeof a === "object" || typeof b === "object") {
    const ao = (a ?? {}) as Record<string, unknown>, bo = (b ?? {}) as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      out.push(...diff(ao[k], bo[k], path ? `${path}.${k}` : k));
    }
    return out;
  }
  if (a !== b) out.push(`${path}: recorded=${JSON.stringify(a)} extracted=${JSON.stringify(b)}`);
  return out;
}

interface Row { verdict: string; symbol: string; cycle: string; diffs: string[]; note?: string }

// The live pair config, loaded once. Frozen since 2026-09-21 (fingerprint
// fc0d441e), which is what makes rebuilding dirConfig from it legitimate.
const { data: cfgRows } = await db.from("bot_configs").select("config_json").limit(1);
const RAW_CFG = (cfgRows?.[0]?.config_json ?? {}) as Record<string, any>;
const FROZEN_PAIR_CONFIG: Record<string, unknown> = {
  ...(RAW_CFG.strategy ?? {}), ...(RAW_CFG.entry ?? {}), ...(RAW_CFG.exit ?? {}),
  ...(RAW_CFG.risk ?? {}),
};

async function run(): Promise<Row[]> {
  const { data: ctxs } = await db.from("smc_scan_context").select("*").order("scanned_at");
  const rows: Row[] = [];

  for (const ctx of (ctxs ?? []) as Record<string, any>[]) {
    const base = { symbol: ctx.symbol as string, cycle: ctx.scan_cycle_id as string };

    if (ctx.htf_confluence === undefined) {
      rows.push({ ...base, verdict: "NO_SNAPSHOT", diffs: [], note: "predates stored bundles" }); continue;
    }
    const { data: mans } = await db.from("smc_scan_manifest").select("*")
      .eq("scan_cycle_id", ctx.scan_cycle_id).eq("symbol", ctx.symbol);
    const manifests = (mans ?? []) as unknown as (ManifestRow & { slot: string; scanned_at: string })[];
    if (!manifests.length) { rows.push({ ...base, verdict: "NO_SNAPSHOT", diffs: [] }); continue; }

    // Rebuild each slot array, digest-verified.
    const byTf: Record<string, Candle[]> = {};
    let bad = "";
    for (const m of manifests) {
      const stored = await barsFor(ctx.symbol, m.timeframe, m.first_bar_time, m.last_bar_time, m.scanned_at);
      const built = reconstruct(m, stored);
      if (!built.ok) { bad = `slot ${m.slot} (${m.timeframe}): ${built.reason}`; break; }
      byTf[m.timeframe] = built.candles;
    }
    if (bad) { rows.push({ ...base, verdict: "BARS_UNRECOVERABLE", diffs: [], note: bad }); continue; }

    // The module takes raw series and derives slots itself — which is the point:
    // if its mapping drifted from production's, the outputs will not match.
    const series = {
      candles: byTf["5m"] ?? [],
      m15Candles: byTf["15m"] ?? [],
      hourlyCandles: byTf["1h"] ?? [],
      h4Candles: byTf["4h"] ?? [],
      dailyCandles: byTf["1d"] ?? [],
      weeklyCandles: null,   // scalper never reads it; swing is not in this corpus
    };
    const ea = (ctx.engine_args ?? {}) as Record<string, number | boolean | undefined>;
    const got = decideZone({
      symbol: ctx.symbol,
      style: ctx.style as ResolvedStyle,
      series,
      direction: ctx.direction === "bullish" || ctx.direction === "long" ? "long" : "short",
      lastPrice: Number(ctx.last_price),
      htfConfluence: (ctx.htf_confluence ?? null) as HTFConfluenceData | null,
      liquidityPools: (ctx.liquidity_pools ?? []) as LiquidityPool[],
      minSlPips: ea.minSlPips as number,
      maxSlPips: ea.maxSlPips as number,
      tpRatio: ea.tpRatio as number,
      entryDepth: ea.entryDepth as number,
      pipSize: ea.pipSize as number,
      strictATRMult: ea.strictATRMult as number,
      fibMaxRetracement: ea.fibMaxRetracement as number,
      originOBRetest: ea.originOBRetest as boolean,
      // Not captured in the corpus. Production's value is
      // `pairConfig.impulseZoneEnabled !== false`, and no pair sets it false —
      // verified against bot_configs before relying on it.
      impulseZoneEnabled: true,
    });

    // What production recorded at the time.
    const { data: logs } = await db.from("scan_logs")
      .select("scanned_at, details_json")
      .gte("scanned_at", new Date(Date.parse(ctx.scanned_at) - 150_000).toISOString())
      .lte("scanned_at", new Date(Date.parse(ctx.scanned_at) + 150_000).toISOString())
      .order("scanned_at");
    let rec: Record<string, unknown> | undefined;
    for (const row of logs ?? []) {
      const raw = (row as Record<string, unknown>).details_json;
      const details = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
      const meta = details.find((d) => d.__meta === true);
      if (meta && meta.scan_cycle_id && meta.scan_cycle_id !== ctx.scan_cycle_id) continue;
      const d = details.find((x) => x.pair === ctx.symbol || x.symbol === ctx.symbol);
      if (d) { rec = d; break; }
    }
    if (!rec?.unifiedZone) { rows.push({ ...base, verdict: "NO_RECORDED_OUTPUT", diffs: [] }); continue; }

    const d1 = diff(rec.unifiedZone, got.unifiedZone, "unifiedZone");
    const d2 = diff(rec.impulseZone, got.impulseZone, "impulseZone");

    // ── direction slice ──────────────────────────────────────────────────
    // Its inputs are the same 1h/15m/5m arrays already reconstructed above.
    // dirConfig was not captured before today's deploy, so it is rebuilt from
    // bot_configs — sound only because the config is frozen and fingerprinted
    // (fc0d441e, unchanged since 09-21). If that assumption is wrong the
    // comparison fails loudly rather than quietly passing.
    let d3: string[] = [];
    if (rec.simpleDirection) {
      const dir = decideDirection({
        style: ctx.style as DirectionStyle,
        series: {
          candles: series.candles, m15Candles: series.m15Candles,
          hourlyCandles: series.hourlyCandles, h4Candles: series.h4Candles,
          dailyCandles: series.dailyCandles, weeklyCandles: null,
        },
        dirConfig: buildDirectionConfig(FROZEN_PAIR_CONFIG),
        useSimpleDirection: true,
      });
      d3 = diff(rec.simpleDirection, dir.detailShape, "simpleDirection");
    }

    const diffs = [...d1, ...d2, ...d3];
    rows.push({ ...base, verdict: diffs.length ? "MISMATCH" : "EXACT", diffs });
  }
  return rows;
}

const rows = await run();
const tally: Record<string, number> = {};
for (const r of rows) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;

console.log(`\nSTAGE 2H PRE-DEPLOY PARITY — extracted module vs production's recorded output\n`);
console.log(`  compared: ${rows.length}`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(22)} ${String(v).padStart(4)}  ${(100 * v / rows.length).toFixed(1)}%`);
}
const bad = rows.filter((r) => r.verdict === "MISMATCH");
if (bad.length) {
  console.log(`\n── field-level diffs ──`);
  for (const r of bad.slice(0, 25)) {
    console.log(`\n  ${r.symbol}  ${r.cycle}`);
    for (const d of r.diffs.slice(0, 12)) console.log(`      ${d}`);
    if (r.diffs.length > 12) console.log(`      … ${r.diffs.length - 12} more fields`);
  }
}
const comparable = (tally["EXACT"] ?? 0) + (tally["MISMATCH"] ?? 0);
console.log(`\n  VERDICT: ${bad.length === 0 && comparable > 0 ? "FULL_PARITY" : comparable === 0 ? "NOTHING COMPARED — not a pass" : "PARITY_FAILED"}`);
console.log(`  comparable: ${comparable}/${rows.length}\n`);
