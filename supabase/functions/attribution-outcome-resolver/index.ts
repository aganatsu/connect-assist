/**
 * attribution-outcome-resolver — STEP 15 PR 3.
 *
 * Resolves hypothetical (dry-run) fills forward on the stored 5m bars and
 * writes the hypothetical close into trade_attribution (section G) exactly
 * once. Called by pg_cron (supabase/cron/attribution_outcome_resolver_cron.sql),
 * service role only. Read-only everywhere else: no order, position, account,
 * ledger or trade-history write, and no market-data provider call.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { isServiceRole } from "../_shared/settlementMonitor.ts";
import { runOutcomeResolver } from "../_shared/outcomeResolverRun.ts";

const respond = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!isServiceRole(req.headers.get("Authorization"), serviceKey)) return respond({ error: "Unauthorized" }, 401);
  const supabase = createClient(url, serviceKey);
  try {
    const summary = await runOutcomeResolver(supabase, Date.now());
    console.log(`[outcome-resolver] candidates=${summary.candidates} resolved=${summary.resolved} deferred=${summary.deferred} pending=${summary.pending} invalid=${summary.invalid} errors=${summary.errors.length}`);
    return respond({ ok: summary.errors.length === 0, ...summary });
  } catch (e: any) {
    console.error(`[outcome-resolver] failed: ${e?.message ?? e}`);
    return respond({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
