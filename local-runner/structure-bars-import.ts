/**
 * Canonical 1H structure-bar import from the APPROVED local research history (V3.2c PR2, decision Q2 2026-10-15).
 * DRY-RUN BY DEFAULT: reads the dataset files, verifies their sha256, evaluates every 1H row and prints what WOULD be
 * written. Nothing is written without --execute. Requires the structure_bars migration to be applied first.
 *
 *   deno run --allow-read --allow-net --allow-env local-runner/structure-bars-import.ts \
 *     --dataset <dir with dataset.json + manifest.json> [--dataset <dir> ...] [--offline | --execute] [--compare-scan-bars]
 *   --offline: verify + evaluate only (no database access at all); cannot be combined with --execute.
 *   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from local-runner/.env.local, or the file named by LOCAL_RUNNER_ENV)
 *
 * Rules (supabase/functions/_shared/structure/researchImport.ts): approved datasets only; any 1H row at/after
 * 2026-10-09 21:00Z refuses the dataset; canonical span 2025-04-16 21:00Z → 2026-10-09 21:00Z; prices rounded to 5
 * decimal places (all six pairs); provenance research_import. Existing canonical rows are never modified (append-only, first wins);
 * a differing existing value is recorded as a revision. --compare-scan-bars only REPORTS how smc_scan_bars observations
 * in the same span differ (they are telemetry and never overwrite imported bars).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { planWrites, RESEARCH_IMPORT_END_MS, valueHash, type Evaluation } from "../supabase/functions/_shared/structure/canonicalBars.ts";
import { evaluateResearchDataset, type ResearchDataset } from "../supabase/functions/_shared/structure/researchImport.ts";

const args = Deno.args, EXECUTE = args.includes("--execute"), COMPARE = args.includes("--compare-scan-bars"), OFFLINE = args.includes("--offline");
if (OFFLINE && (EXECUTE || COMPARE)) { console.error("--offline cannot be combined with --execute or --compare-scan-bars"); Deno.exit(2); }
const dirs = args.flatMap((a, i) => (a === "--dataset" ? [args[i + 1]] : []));
if (!dirs.length) { console.error("usage: --dataset <dir> [--dataset <dir> ...] [--execute] [--compare-scan-bars]"); Deno.exit(2); }

const env: Record<string, string> = {};
if (!OFFLINE) {
  for (const l of Deno.readTextFileSync(Deno.env.get("LOCAL_RUNNER_ENV") ?? new URL("./.env.local", import.meta.url)).split("\n")) {
    const i = l.indexOf("=");
    if (i > 0 && !l.startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
const db = OFFLINE ? null : createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sha256 = async (b: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");

// 1. verify + evaluate every dataset BEFORE any database access
const evals: Evaluation[] = [];
for (const dir of dirs) {
  const bytes = Deno.readFileSync(`${dir}/dataset.json`);
  const manifest = JSON.parse(Deno.readTextFileSync(`${dir}/manifest.json`));
  const retrieved = (manifest.calls ?? []).map((c: { retrievedAt: string }) => Date.parse(c.retrievedAt)).filter(Number.isFinite);
  const meta = { sha256: await sha256(bytes), manifestSha256: String(manifest.datasetSha256 ?? ""), retrievedAtMs: retrieved.length ? Math.max(...retrieved) : NaN };
  const ds: ResearchDataset = JSON.parse(new TextDecoder().decode(bytes));
  const e = evaluateResearchDataset(ds, meta); // throws on an unapproved dataset or any row at/after the boundary
  console.log(`dataset ${dir}: sha256 ${meta.sha256} verified; ${e.length} 1H rows evaluated`);
  evals.push(...e);
}

// 2. existing canonical rows in the import span (read-only)
const bySym = new Map<string, Evaluation[]>();
for (const e of evals) { const s = e.kind === "candidate" ? e.row.symbol : e.obs.symbol; (bySym.get(s) ?? bySym.set(s, []).get(s)!).push(e); }
const totals: Record<string, number> = {};
for (const [sym, es] of bySym) {
  const existing = new Map<string, { hash: string; open: number; high: number; low: number; close: number }>();
  for (let from = 0; db; from += 1000) {
    const { data, error } = await db.from("structure_bars_1h").select("bar_time,open,high,low,close").eq("symbol", sym).lt("bar_time", new Date(RESEARCH_IMPORT_END_MS).toISOString()).order("bar_time").range(from, from + 999);
    if (error) throw new Error(`read existing ${sym}: ${error.message}`);
    for (const r of data ?? []) { const v = { open: +r.open, high: +r.high, low: +r.low, close: +r.close }; existing.set(new Date(r.bar_time).toISOString(), { ...v, hash: valueHash(sym, v.open, v.high, v.low, v.close) }); }
    if (!data || data.length < 1000) break;
  }
  const plan = planWrites(es, existing, "research_import");
  for (const [k, v] of Object.entries(plan.counts)) totals[k] = (totals[k] ?? 0) + v;
  console.log(`${sym}: ${JSON.stringify(plan.counts)}`);
  if (EXECUTE && db) {
    for (let i = 0; i < plan.inserts.length; i += 1000) {
      const { error } = await db.from("structure_bars_1h").upsert(plan.inserts.slice(i, i + 1000), { onConflict: "symbol,bar_time", ignoreDuplicates: true });
      if (error) throw new Error(`insert ${sym}: ${error.message}`);
    }
    if (plan.revisions.length) {
      const { error } = await db.from("structure_bar_revisions").upsert(plan.revisions, { onConflict: "symbol,bar_time,value_hash,source", ignoreDuplicates: true });
      if (error) throw new Error(`revisions ${sym}: ${error.message}`);
    }
    // import rejections are reported here, not written (outside-FX-hours provider rows are expected, not data-quality events)
  }
  if (COMPARE && db) {
    let n = 0, differ = 0;
    const canon = new Map(es.flatMap((e) => (e.kind === "candidate" ? [[e.row.bar_time, e.hash] as const] : [])));
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("smc_scan_bars").select("bar_time,open,high,low,close").eq("symbol", sym).eq("timeframe", "1h").lt("bar_time", new Date(RESEARCH_IMPORT_END_MS).toISOString()).order("bar_time").order("first_seen_at").range(from, from + 999);
      if (error) throw new Error(`compare ${sym}: ${error.message}`);
      for (const r of data ?? []) { const h = canon.get(new Date(r.bar_time).toISOString()); if (!h) continue; n++; if (h !== valueHash(sym, +r.open, +r.high, +r.low, +r.close)) differ++; }
      if (!data || data.length < 1000) break;
    }
    console.log(`  compare smc_scan_bars (telemetry only): ${n} observations in span, ${differ} differ from the import value`);
  }
}
console.log(`${EXECUTE ? "EXECUTED" : OFFLINE ? "OFFLINE DRY RUN (no database access)" : "DRY RUN (nothing written)"} totals: ${JSON.stringify(totals)}`);
