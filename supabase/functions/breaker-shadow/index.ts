/**
 * breaker-shadow — Unified breaker (flip zone) shadow, owner choice "Show + Shadow" (2026-11-02). For every account with Bot Config →
 * "Breaker Shadow" on: registers the Unified zones its scans showed and records pretend flip trades on settled 5m bars. Called by
 * pg_cron (supabase/cron/breaker_shadow_cron.sql), service role only. Accounts with the switch off are untouched. Never touches
 * pending_orders, positions, accounts or the broker.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { isServiceRole } from "../_shared/settlementMonitor.ts";
import { runBreakerShadow } from "../_shared/breaker/breakerRun.ts";

const respond = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!isServiceRole(req.headers.get("Authorization"), serviceKey)) return respond({ error: "Unauthorized" }, 401);
  const db = createClient(url, serviceKey);
  try {
    const r = await runBreakerShadow(db, Date.now());
    console.log(`[breaker-shadow] ${JSON.stringify(r)}`);
    return respond({ ok: true, results: r });
  } catch (e: any) {
    console.error(`[breaker-shadow] failed: ${e?.message ?? e}`);
    return respond({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});
