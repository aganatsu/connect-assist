/**
 * v32c-state — V3.2c state service (PR3 of docs/V3_2C_PRODUCTION_INTEGRATION_DRAFT.md; owner approval 2026-10-26).
 *
 * For ONE pair per call (body {"pair": "EUR/USD"}): replays frozen V3.2c from the epoch on the canonical 1H store and appends the
 * 1H / NY-4H / NY-Daily snapshots closing in the last 8 days that are not yet stored, the Daily checkpoints, and an audit row
 * for every repaint, checkpoint mismatch or stale store. Called by pg_cron (supabase/cron/v32c_state_cron.sql), service role only.
 * DEFAULT OFF: does nothing unless V32C_STATE_RUNNER=on. No provider call; no gate, score, order or trading table is touched.
 * Full-history backfill / audit: local-runner/v32c-state-backfill.ts.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { isServiceRole } from "../_shared/settlementMonitor.ts";
import { AUDIT_WINDOW_MS, RUNNER_ENV, runV3StateForPair } from "../_shared/structure/v32cStateRun.ts";

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
  try {
    const now = Date.now();
    const { plan: _plan, ...r } = await runV3StateForPair(createClient(url, serviceKey), pair, { nowMs: now, materializeFrom: now - AUDIT_WINDOW_MS });
    console.log(`[v32c-state] ${pair} ${JSON.stringify(r)}`);
    return respond(r);
  } catch (e: any) {
    console.error(`[v32c-state] ${pair} failed: ${e?.message ?? e}`);
    return respond({ ok: false, pair, error: String(e?.message ?? e) }, 500);
  }
});
