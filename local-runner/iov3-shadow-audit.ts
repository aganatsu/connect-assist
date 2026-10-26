/**
 * Impulse-on-V3 shadow: FULL AUDIT (step 3). For every shadow cohort and pair, replays the shadow from the cohort's first decision
 * to its latest stored state in ONE pass (same code, same settled-bar rule) and compares every stored decision and event with the
 * replay. The hourly function advanced in many small steps; a difference is reported (and with --execute recorded as a 'mismatch'
 * audit row). DRY-RUN BY DEFAULT; never writes decisions, events or state. Zero provider calls.
 *
 *   deno run --allow-read --allow-net --allow-env local-runner/iov3-shadow-audit.ts [--cohort <id>] [--execute]
 *   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from local-runner/.env.local, or the file named by LOCAL_RUNNER_ENV)
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { hashStructure } from "../supabase/functions/_shared/smcScanSnapshot.ts";
import { decisionRow, eventRow, loadPairData, step, type Cohort } from "../supabase/functions/_shared/iov3/shadowRun.ts";
import { initShadowState, type ShadowParams } from "../supabase/functions/_shared/iov3/shadowEngine.ts";

const args = Deno.args, EXECUTE = args.includes("--execute");
const ci = args.indexOf("--cohort"), ONLY = ci >= 0 ? args[ci + 1] : null;
const env: Record<string, string> = {};
for (const l of Deno.readTextFileSync(Deno.env.get("LOCAL_RUNNER_ENV") ?? new URL("./.env.local", import.meta.url)).split("\n")) {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const iso = (v: string) => new Date(Date.parse(v)).toISOString();
// stored rows come back with +00:00 timestamps and jsonb key order: compare through one normalisation
// deno-lint-ignore no-explicit-any
const normD = (r: any) => hashStructure({ ...r, t: iso(r.t), created_at: undefined, user_id: undefined, cohort_id: undefined });
// deno-lint-ignore no-explicit-any
const normE = (r: any) => hashStructure({ ...r, t: iso(r.t), created_at: undefined, user_id: undefined, cohort_id: undefined });

let q = db.from("iov3_shadow_cohorts").select("*").order("started_at");
if (ONLY) q = q.eq("id", ONLY);
const { data: cohorts, error } = await q;
if (error) throw new Error(error.message);
let bad = 0;
for (const c of (cohorts ?? []) as Cohort[]) {
  for (const [pair, p] of Object.entries(c.params)) {
    if ("reason" in p) { console.log(`${c.id} ${pair}: refused (${p.reason})`); continue; }
    const { data: s } = await db.from("iov3_shadow_state").select("seq,as_of").eq("cohort_id", c.id).eq("pair", pair).order("seq", { ascending: false }).limit(1);
    if (!s?.length) { console.log(`${c.id} ${pair}: no state yet`); continue; }
    const asOf = Date.parse(s[0].as_of), start = initShadowState(Date.parse(c.first_decision_at));
    const data = await loadPairData(db, pair, start.lastScanT, asOf);
    const r = step(p as ShadowParams, start, data, asOf);
    const ctxAt = (t: number) => { let v: string | null = null; for (const x of data.ctx4h) { if (x.t <= t) v = x.trend; else break; } return v; };
    const wantD = new Map(r.decisions.map((x) => { const row = decisionRow(c, pair, x, ctxAt(x.t)); return [row.t, normD(row)]; }));
    const wantE = new Map(r.events.map((e) => { const row = eventRow(c, pair, e); return [`${row.order_id}|${row.type}|${row.t}`, normE(row)]; }));
    const { data: gotD } = await db.from("iov3_shadow_decisions").select("*").eq("cohort_id", c.id).eq("pair", pair).lte("t", new Date(asOf).toISOString()).limit(10000);
    const { data: gotE } = await db.from("iov3_shadow_events").select("*").eq("cohort_id", c.id).eq("pair", pair).lte("t", new Date(asOf).toISOString()).limit(10000);
    const diffs: { ref: string; detail: unknown }[] = [];
    const seenD = new Set<string>(), seenE = new Set<string>();
    for (const g of gotD ?? []) { const k = iso(g.t); seenD.add(k); if (wantD.get(k) !== normD(g)) diffs.push({ ref: `decision|${k}`, detail: { stored: g, replay: wantD.has(k) ? "differs" : "missing" } }); }
    for (const k of wantD.keys()) if (!seenD.has(k)) diffs.push({ ref: `decision|${k}`, detail: { stored: null, replay: "present" } });
    for (const g of gotE ?? []) { const k = `${g.order_id}|${g.type}|${iso(g.t)}`; seenE.add(k); if (wantE.get(k) !== normE(g)) diffs.push({ ref: `event|${k}`, detail: { stored: g, replay: wantE.has(k) ? "differs" : "missing" } }); }
    for (const k of wantE.keys()) if (!seenE.has(k)) diffs.push({ ref: `event|${k}`, detail: { stored: null, replay: "present" } });
    console.log(`${c.id} ${pair}: ${r.decisions.length} decisions, ${r.events.length} events replayed to ${new Date(asOf).toISOString()} — ${diffs.length ? `${diffs.length} MISMATCH` : "identical"}`);
    for (const d of diffs.slice(0, 5)) console.log(`  ${d.ref}`);
    if (diffs.length) bad++;
    if (EXECUTE && diffs.length) {
      const { error: e } = await db.from("iov3_shadow_audit").upsert(diffs.map((d) => ({ cohort_id: c.id, pair, kind: "mismatch", ref: d.ref, detail: d.detail })), { onConflict: "cohort_id,pair,kind,ref", ignoreDuplicates: true });
      if (e) throw new Error(e.message);
    }
  }
}
console.log(`${EXECUTE ? "EXECUTED" : "DRY RUN (nothing written)"}; cohort/pairs with mismatches: ${bad}`);
