/**
 * iov3-shadow — Impulse-on-V3 shadow (step 3, owner decisions 2026-10-26). For ONE pair per call (body {"pair": "EUR/USD"}),
 * for every account whose switch is SHADOW (or ON): advances the shadow on settled stored bars and appends its decisions, order
 * events and resumable state. Called by pg_cron (supabase/cron/iov3_shadow_cron.sql), service role only.
 * DEFAULT OFF: does nothing unless IOV3_SHADOW_RUNNER=on. The shadow never touches pending_orders, positions, accounts or the
 * broker. Once per tick it also checks the ON automatic fallback (owner Q2), which leaves ON through onSwitch.ts.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { isServiceRole } from "../_shared/settlementMonitor.ts";
import { RUNNER_ENV, runShadowForPair } from "../_shared/iov3/shadowRun.ts";
import { IOV3_PAIRS } from "../_shared/iov3/shadowEngine.ts";
import { evaluateKill, loadOnTrades } from "../_shared/iov3/onMode.ts";
import { leaveOn } from "../_shared/iov3/onSwitch.ts";

/** Owner Q2 automatic fallback: ON → SHADOW at −8R cumulative, or when the first 20 ON trades average below −0.3R. */
async function checkOnFallback(db: any): Promise<unknown[]> {
  const { data: onRows } = await db.from("structure_mode").select("user_id,bot_id,on_since").eq("mode", "ON");
  const out: unknown[] = [];
  for (const r of onRows ?? []) {
    const trades = await loadOnTrades(db, r.user_id, r.bot_id, r.on_since ?? new Date(0).toISOString());
    const k = evaluateKill(trades);
    out.push({ user: String(r.user_id).slice(0, 8), n: k.n, netR: k.netR, kill: k.kill });
    if (!k.kill) continue;
    const res = await leaveOn(db, r.user_id, r.bot_id, "SHADOW", new Date().toISOString(), k.reason);
    console.warn(`[iov3-shadow] V3 ON automatic fallback for ${String(r.user_id).slice(0, 8)}: ${k.reason} (${res.cancelledOrders} V3 order(s) cancelled)`);
    try {
      const { data: us } = await db.from("user_settings").select("preferences_json").eq("user_id", r.user_id).maybeSingle();
      const chats: string[] = Array.isArray(us?.preferences_json?.telegramChatIds) ? us.preferences_json.telegramChatIds : [];
      const msg = `🛑 <b>V3 ON stopped automatically</b>\n\n${k.reason}\nThe switch is back on SHADOW; ${res.cancelledOrders} V3 pending order(s) cancelled, open positions keep running.`;
      await Promise.all(chats.map((chat_id) => fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-notify`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
        body: JSON.stringify({ chat_id, message: msg }),
      }).catch(() => undefined)));
    } catch { /* notification is best-effort; the switch already moved */ }
  }
  return out;
}

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
    // the fallback check runs once per cron tick (on the first pair's call), not six times
    const fallback = pair === IOV3_PAIRS[0] ? await checkOnFallback(db) : null;
    console.log(`[iov3-shadow] ${pair} ${JSON.stringify(r)}${fallback ? ` fallback ${JSON.stringify(fallback)}` : ""}`);
    return respond({ ok: true, pair, accounts: r, fallback });
  } catch (e: any) {
    console.error(`[iov3-shadow] ${pair} failed: ${e?.message ?? e}`);
    await db.from("iov3_shadow_audit").upsert({ cohort_id: "-", arm: "A", pair, kind: "error", ref: new Date().toISOString().slice(0, 13), detail: { error: String(e?.message ?? e) } },
      { onConflict: "cohort_id,arm,pair,kind,ref", ignoreDuplicates: true });
    return respond({ ok: false, pair, error: String(e?.message ?? e) }, 500);
  }
});
