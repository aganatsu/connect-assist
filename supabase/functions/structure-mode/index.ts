/**
 * structure-mode — the OFF / SHADOW / ON switch shown in Bot Config → Strategy (Impulse-on-V3 step 3, owner decisions 2026-10-26).
 *
 * Signed-in owner only (their JWT; the row is keyed by their user id).
 *   {action: "status"}                         → mode, unlock state, V3 freshness, shadow summary for the current SHADOW period
 *   {action: "set", mode: "OFF"|"SHADOW"|"ON"}  → validated switch (ON only when unlocked and available), logged
 *   {action: "feedback", cohortId, orderId, verdict: "right"|"wrong", note?} → the owner's chart check of one shadow order
 * The value is stored in structure_mode, NOT in bot_configs.config_json, so SHADOW does not change config_version (cohort).
 * Writes only structure_mode / structure_mode_log / iov3_shadow_feedback. No order, position or config is touched.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { checkTransition, evaluateUnlock, MODES, summarize, type Mode } from "../_shared/iov3/modeControl.ts";

const BOT_ID = "smc";
const respond = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return respond({ error: "Unauthorized", code: "invalid_jwt" }, 401);
  const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: claims, error: authError } = await asUser.auth.getClaims(authHeader.replace("Bearer ", ""));
  if (authError || !claims?.claims?.sub) return respond({ error: "Unauthorized", code: "invalid_jwt" }, 401);
  const userId = claims.claims.sub as string;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const body = await req.json().catch(() => ({}));
    const now = Date.now();
    const { data: row } = await db.from("structure_mode").select("mode,set_at").eq("user_id", userId).eq("bot_id", BOT_ID).maybeSingle();
    const mode: Mode = (row?.mode as Mode) ?? "OFF", setAt = row?.set_at ?? new Date(now).toISOString();

    const unlockNow = async () => {
      const [{ count: v3Audit }, { data: cohorts }] = await Promise.all([
        db.from("structure_v3_audit").select("*", { count: "exact", head: true }).in("kind", ["repaint", "stale"]).gte("recorded_at", setAt),
        db.from("iov3_shadow_cohorts").select("id").eq("user_id", userId).eq("bot_id", BOT_ID).gte("started_at", setAt),
      ]);
      const ids = (cohorts ?? []).map((c: { id: string }) => c.id);
      let shadowAudit = 0, right = 0;
      if (ids.length) {
        const { count } = await db.from("iov3_shadow_audit").select("*", { count: "exact", head: true }).in("cohort_id", ids).in("kind", ["mismatch", "error"]);
        shadowAudit = count ?? 0;
        const { data: fb } = await db.from("iov3_shadow_feedback").select("order_id,verdict,at").eq("user_id", userId).in("cohort_id", ids).order("at");
        const latest = new Map<string, string>();
        for (const f of fb ?? []) latest.set(f.order_id, f.verdict);
        right = [...latest.values()].filter((v) => v === "right").length;
      }
      return { unlock: evaluateUnlock({ mode, setAtMs: Date.parse(setAt), nowMs: now, rightCount: right, v3AuditSince: v3Audit ?? 0, shadowAuditSince: shadowAudit }), cohortIds: ids };
    };

    if (body.action === "status" || !body.action) {
      const { unlock, cohortIds } = await unlockNow();
      const { data: fresh } = await db.from("structure_v3_snapshots").select("symbol,known_at").eq("tf", "1H").order("known_at", { ascending: false }).limit(1);
      let summary = null;
      if (cohortIds.length) {
        const { data: ev } = await db.from("iov3_shadow_events").select("order_id,type,payload").in("cohort_id", cohortIds).limit(5000);
        summary = summarize(ev ?? []);
      }
      return respond({ mode, setAt, unlock, v3LatestClose: fresh?.[0]?.known_at ?? null, summary });
    }

    if (body.action === "set") {
      const to = String(body.mode ?? "").toUpperCase() as Mode;
      if (!MODES.includes(to)) return respond({ error: `unknown mode ${body.mode}` }, 400);
      const { unlock } = await unlockNow();
      const ok = checkTransition(mode, to, unlock);
      if (!ok.ok) return respond({ error: ok.reason, mode }, 409);
      const at = new Date(now).toISOString();
      const { error: e1 } = await db.from("structure_mode").upsert({ user_id: userId, bot_id: BOT_ID, mode: to, set_at: at }, { onConflict: "user_id,bot_id" });
      if (e1) throw new Error(e1.message);
      const { error: e2 } = await db.from("structure_mode_log").insert({ user_id: userId, bot_id: BOT_ID, from_mode: mode, to_mode: to, note: typeof body.note === "string" ? body.note.slice(0, 500) : null });
      if (e2) throw new Error(e2.message);
      console.log(`[structure-mode] ${userId.slice(0, 8)} ${mode} → ${to}`);
      return respond({ ok: true, mode: to, setAt: at });
    }

    if (body.action === "feedback") {
      const verdict = body.verdict === "right" || body.verdict === "wrong" ? body.verdict : null;
      if (!verdict || typeof body.orderId !== "string" || typeof body.cohortId !== "string") return respond({ error: "feedback needs cohortId, orderId and verdict right|wrong" }, 400);
      const { count } = await db.from("iov3_shadow_events").select("*", { count: "exact", head: true }).eq("cohort_id", body.cohortId).eq("order_id", body.orderId).eq("user_id", userId).eq("type", "placed");
      if (!count) return respond({ error: "no such shadow order for this account" }, 404);
      const { error } = await db.from("iov3_shadow_feedback").insert({ cohort_id: body.cohortId, order_id: body.orderId, user_id: userId, verdict, note: typeof body.note === "string" ? body.note.slice(0, 1000) : null });
      if (error) throw new Error(error.message);
      return respond({ ok: true });
    }

    return respond({ error: "Unknown action" }, 400);
  } catch (e: any) {
    console.error(`[structure-mode] failed: ${e?.message ?? e}`);
    return respond({ error: String(e?.message ?? e) }, 500);
  }
});
