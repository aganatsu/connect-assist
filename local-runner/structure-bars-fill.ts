/**
 * Canonical 1H structure-bar fill from smc_scan_bars for 2026-10-09 21:00Z → the live writer's release time (D26).
 * DRY-RUN BY DEFAULT: reads the scan manifests and bars, verifies every manifest against its content_hash, plans the
 * canonical bars and prints what WOULD be written. Nothing is written without --execute. Zero provider calls.
 *
 *   deno run --allow-read --allow-net --allow-env local-runner/structure-bars-fill.ts --until <ISO hour> [--execute] [--json-out <file>]
 *   --until: exclusive end of the fill = STRUCTURE_BARS_RELEASE_AT (the live writer owns every bar from then on).
 *   --json-out: also write the planned rows to a file, for cross-checking against an independent dataset.
 *   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from local-runner/.env.local, or the file named by LOCAL_RUNNER_ENV)
 *
 * Rules (supabase/functions/_shared/structure/scanBarsFill.ts): observations come from verified 1H scan manifests, timed
 * conservatively; D9 picks the first observation ≥ 15 min after close; later differing values become revision rows.
 * Existing canonical rows are never modified (append-only, first wins), so a re-run only adds what is missing.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { STRUCTURE_PAIRS, valueHash } from "../supabase/functions/_shared/structure/canonicalBars.ts";
import { classifyGaps } from "../supabase/functions/_shared/structure/barGaps.ts";
import { FILL_START_MS, planFill, type FillManifest, type FillStoredBar } from "../supabase/functions/_shared/structure/scanBarsFill.ts";

const args = Deno.args, EXECUTE = args.includes("--execute");
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const UNTIL = Date.parse(arg("--until") ?? ""), JSON_OUT = arg("--json-out");
if (!Number.isFinite(UNTIL)) { console.error("usage: --until <ISO hour = STRUCTURE_BARS_RELEASE_AT> [--execute] [--json-out <file>]"); Deno.exit(2); }
if (UNTIL > Date.now()) { console.error("--until is in the future: those bars belong to the live writer"); Deno.exit(2); }

const env: Record<string, string> = {};
for (const l of Deno.readTextFileSync(Deno.env.get("LOCAL_RUNNER_ENV") ?? new URL("./.env.local", import.meta.url)).split("\n")) {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const iso = (ms: number) => new Date(ms).toISOString();

// deno-lint-ignore no-explicit-any
async function pages<T>(q: (from: number) => PromiseLike<{ data: any[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from);
    if (error) throw new Error(`${what}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

const totals: Record<string, number> = {}, dump: Record<string, unknown> = {};
for (const sym of STRUCTURE_PAIRS) {
  // every 1H scan that could hold a settled observation of a bar in the span
  const manifests = await pages<FillManifest>((f) => db.from("smc_scan_manifest")
    .select("scan_cycle_id,scanned_at,fetched_at,first_bar_time,last_bar_time,bar_count,content_hash,last_bar_closed,forming_bar")
    .eq("symbol", sym).eq("timeframe", "1h").gte("scanned_at", iso(FILL_START_MS)).order("scanned_at").order("id").range(f, f + 999), `manifests ${sym}`);
  const firstBar = Math.min(...manifests.map((m) => Date.parse(m.first_bar_time)));
  const bars = manifests.length ? await pages<FillStoredBar>((f) => db.from("smc_scan_bars")
    .select("bar_time,bar_time_raw,open,high,low,close,first_seen_at,provider")
    .eq("symbol", sym).eq("timeframe", "1h").gte("bar_time", iso(firstBar)).order("bar_time").order("first_seen_at").order("bar_hash").range(f, f + 999), `bars ${sym}`) : [];
  for (const b of bars) { b.open = Number(b.open); b.high = Number(b.high); b.low = Number(b.low); b.close = Number(b.close); }
  const existingRows = await pages<{ bar_time: string; open: number; high: number; low: number; close: number }>((f) => db.from("structure_bars_1h")
    .select("bar_time,open,high,low,close").eq("symbol", sym).gte("bar_time", iso(FILL_START_MS)).order("bar_time").range(f, f + 999), `existing ${sym}`);
  const existing = new Map(existingRows.map((r) => {
    const v = { open: +r.open, high: +r.high, low: +r.low, close: +r.close };
    return [iso(Date.parse(r.bar_time)), { ...v, hash: valueHash(sym, v.open, v.high, v.low, v.close) }] as const;
  }));

  const plan = planFill(sym, manifests, bars, UNTIL, existing);
  for (const [k, v] of Object.entries(plan.counts)) totals[k] = (totals[k] ?? 0) + v;
  const have = [...existing.keys(), ...plan.inserts.map((r) => r.bar_time)].map(Date.parse).filter((t) => t < UNTIL);
  const gaps = classifyGaps(have, FILL_START_MS, UNTIL);
  const byClass: Record<string, number> = {};
  for (const g of gaps) byClass[g.class] = (byClass[g.class] ?? 0) + 1;
  console.log(`${sym}: ${manifests.length} manifests, ${bars.length} bar rows → ${JSON.stringify(plan.counts)}; gaps ${JSON.stringify(byClass)}`);
  for (const g of gaps.filter((x) => x.class === "data_gap").slice(0, 10)) console.log(`  data_gap ${iso(g.t)}`);
  dump[sym] = { inserts: plan.inserts, revisions: plan.revisions, gaps: gaps.map((g) => ({ t: iso(g.t), class: g.class })) };

  if (EXECUTE) {
    for (let i = 0; i < plan.inserts.length; i += 1000) {
      const { error } = await db.from("structure_bars_1h").upsert(plan.inserts.slice(i, i + 1000), { onConflict: "symbol,bar_time", ignoreDuplicates: true });
      if (error) throw new Error(`insert ${sym}: ${error.message}`);
    }
    if (plan.revisions.length) {
      const { error } = await db.from("structure_bar_revisions").upsert(plan.revisions, { onConflict: "symbol,bar_time,value_hash,source", ignoreDuplicates: true });
      if (error) throw new Error(`revisions ${sym}: ${error.message}`);
    }
  }
}
if (JSON_OUT) Deno.writeTextFileSync(JSON_OUT, JSON.stringify({ until: iso(UNTIL), generatedAt: iso(Date.now()), pairs: dump }));
console.log(`${EXECUTE ? "EXECUTED" : "DRY RUN (nothing written)"} until ${iso(UNTIL)} totals: ${JSON.stringify(totals)}`);
