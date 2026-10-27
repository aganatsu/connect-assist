/**
 * iov3-shadow — Impulse-on-V3 shadow (step 3, owner decisions 2026-10-26). For ONE pair per call (body {"pair": "EUR/USD"}),
 * for every account whose switch is SHADOW (or ON): advances the shadow on settled stored bars and appends its decisions, order
 * events and resumable state. Called by pg_cron (supabase/cron/iov3_shadow_cron.sql), service role only.
 * DEFAULT OFF: does nothing unless IOV3_SHADOW_RUNNER=on. Never touches pending_orders, positions, accounts or the broker.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { isServiceRole } from "../_shared/settlementMonitor.ts";
import { RUNNER_ENV, runShadowForPair } from "../_shared/iov3/shadowRun.ts";
import { IOV3_PAIRS } from "../_shared/iov3/shadowEngine.ts";

const respond = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!isServiceRole(req.headers.get("Authorization"), serviceKey)) return respond({ error: "Unauthorized" }, 401);
  if ((Deno.env.get(RUNNER_ENV) ?? "off") !== "on") return respond({ ok: true, skipped: `${RUNNER_ENV} off` });
  let pair = "";
  try { pair = String((await req.json())?.pair ?? ""); } catch { /* empty body */ }
  if (!IOV3_PAIRS.includes(pair as typeof IOV3_PAIRS[number])) return respond({ ok: false, error: `not a V3 pair: ${pair}` }, 400);
  const db = createClient(url, serviceKey);
  try {
    const r = await runShadowForPair(db, pair, Date.now());
    console.log(`[iov3-shadow] ${pair} ${JSON.stringify(r)}`);
    return respond({ ok: true, pair, accounts: r });
  } catch (e: any) {
    console.error(`[iov3-shadow] ${pair} failed: ${e?.message ?? e}`);
    await db.from("iov3_shadow_audit").upsert({ cohort_id: "-", arm: "A", pair, kind: "error", ref: new Date().toISOString().slice(0, 13), detail: { error: String(e?.message ?? e) } },
      { onConflict: "cohort_id,arm,pair,kind,ref", ignoreDuplicates: true });
    return respond({ ok: false, pair, error: String(e?.message ?? e) }, 500);
  }
});
