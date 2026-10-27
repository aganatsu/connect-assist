/**
 * structure-mode — the OFF / SHADOW / ON switch shown in Bot Config → Strategy (Impulse-on-V3 step 3, owner decisions 2026-10-26).
 *
 * Signed-in owner only (their JWT; the row is keyed by their user id).
 *   {action: "status"}                         → mode, unlock state, V3 freshness, shadow summaries (A = external leg, B = internal leg)
 *   {action: "set", mode: "OFF"|"SHADOW"|"ON", arm?: "A"|"B"} → validated switch (ON needs the arm and its unlock), logged;
 *        entering / leaving ON also cancels the live orders on the V3 pairs that the other engine owned and marks / unmarks the
 *        config (onSwitch.ts): ON is its own cohort
 *   {action: "feedback", cohortId, orderId, verdict: "right"|"wrong", note?} → the owner's chart check of one shadow order
 * The value is stored in structure_mode, NOT in bot_configs.config_json, so SHADOW does not change config_version (cohort).
 * Writes structure_mode / structure_mode_log / iov3_shadow_feedback; at an ON flip, through onSwitch.ts only, the live orders on the
 * V3 pairs and config_json.structure. Open positions are never touched.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { checkTransition, evaluateUnlock, MODES, summarize, type Mode } from "../_shared/iov3/modeControl.ts";
import { enterOn, leaveOn } from "../_shared/iov3/onSwitch.ts";

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
    const { data: row } = await db.from("structure_mode").select("mode,set_at,arm,on_since,kill_reason").eq("user_id", userId).eq("bot_id", BOT_ID).maybeSingle();
    const mode: Mode = (row?.mode as Mode) ?? "OFF", setAt = row?.set_at ?? new Date(now).toISOString();

    const unlockNow = async (forArm?: "A" | "B") => {
      const [{ count: repaints }, { data: staleRows }, { data: cohorts }] = await Promise.all([
        db.from("structure_v3_audit").select("*", { count: "exact", head: true }).eq("kind", "repaint").gte("recorded_at", setAt),
        db.from("structure_v3_audit").select("symbol,known_at").eq("kind", "stale").gte("recorded_at", setAt).limit(2000),
        db.from("iov3_shadow_cohorts").select("id").eq("user_id", userId).eq("bot_id", BOT_ID).gte("started_at", setAt),
      ]);
      // "No missed hours": a stale hour counts only if its bar is STILL missing 3 hours later. A bar that arrived late (e.g. while
      // the scanner was full and its recorders paused) is not a missed hour.
      const MISSED_AFTER_MS = 3 * 3_600_000, stale = (staleRows ?? []).filter((r: { known_at: string }) => now - Date.parse(r.known_at) > MISSED_AFTER_MS);
      let missedHours = 0;
      for (const sym of new Set(stale.map((r: { symbol: string }) => r.symbol))) {
        const hours = stale.filter((r: { symbol: string }) => r.symbol === sym).map((r: { known_at: string }) => new Date(r.known_at).toISOString());
        const { data: have } = await db.from("structure_bars_1h").select("bar_time").eq("symbol", sym).in("bar_time", [...new Set(hours)]);
        const got = new Set((have ?? []).map((b: { bar_time: string }) => new Date(b.bar_time).toISOString()));
        missedHours += new Set(hours.filter((h) => !got.has(h))).size;
      }
      const v3Audit = (repaints ?? 0) + missedHours;
      const ids = (cohorts ?? []).map((c: { id: string }) => c.id);
      let shadowAudit = 0, right = 0, rightA = 0, rightB = 0;
      if (ids.length) {
        const { count } = await db.from("iov3_shadow_audit").select("*", { count: "exact", head: true }).in("cohort_id", ids).in("kind", ["mismatch", "error"]);
        shadowAudit = count ?? 0;
        const { data: fb } = await db.from("iov3_shadow_feedback").select("order_id,arm,verdict,at").eq("user_id", userId).in("cohort_id", ids).order("at");
        const latest = new Map<string, { arm: string; verdict: string }>();
        for (const f of fb ?? []) latest.set(f.order_id, { arm: f.arm, verdict: f.verdict });
        // step 4 chooses the arm ON trades; until then ON unlocks on the better-checked arm
        const perArm = { A: 0, B: 0 } as Record<string, number>;
        for (const v of latest.values()) if (v.verdict === "right") perArm[v.arm] = (perArm[v.arm] ?? 0) + 1;
        rightA = perArm.A; rightB = perArm.B;
        right = forArm ? perArm[forArm] : Math.max(perArm.A, perArm.B);
      }
      return { unlock: evaluateUnlock({ mode, setAtMs: Date.parse(setAt), nowMs: now, rightCount: right, v3AuditSince: v3Audit, shadowAuditSince: shadowAudit }), cohortIds: ids, rightA, rightB };
    };

    if (body.action === "status" || !body.action) {
      const { unlock, cohortIds, rightA, rightB } = await unlockNow();
      const { data: fresh } = await db.from("structure_v3_snapshots").select("symbol,known_at").eq("tf", "1H").order("known_at", { ascending: false }).limit(1);
      let summary = null, summaryB = null;
      if (cohortIds.length) {
        const { data: ev } = await db.from("iov3_shadow_events").select("order_id,arm,type,payload").in("cohort_id", cohortIds).limit(10000);
        summary = summarize((ev ?? []).filter((e: { arm: string }) => e.arm === "A"));
        summaryB = summarize((ev ?? []).filter((e: { arm: string }) => e.arm === "B"));
      }
      return respond({ mode, setAt, arm: row?.arm ?? null, onSince: row?.on_since ?? null, killReason: row?.kill_reason ?? null, rightA, rightB, unlock, v3LatestClose: fresh?.[0]?.known_at ?? null, summary, summaryB });
    }

    if (body.action === "set") {
      const to = String(body.mode ?? "").toUpperCase() as Mode;
      if (!MODES.includes(to)) return respond({ error: `unknown mode ${body.mode}` }, 400);
      const arm = body.arm === "A" || body.arm === "B" ? body.arm : null;
      if (to === "ON" && !arm) return respond({ error: "choose the leg ON trades: arm A (big leg) or B (scalp leg)" }, 400);
      const { unlock } = await unlockNow(to === "ON" ? arm! : undefined);
      const ok = checkTransition(mode, to, unlock);
      if (!ok.ok) return respond({ error: ok.reason, mode }, 409);
      const at = new Date(now).toISOString();
      if (to === "ON") {
        const r = await enterOn(db, userId, BOT_ID, mode, arm!, at);
        console.log(`[structure-mode] ${userId.slice(0, 8)} ${mode} → ON (arm ${arm}); ${r.cancelledOrders} Impulse order(s) cancelled`);
        return respond({ ok: true, mode: "ON", arm, setAt: at, cancelledOrders: r.cancelledOrders });
      }
      if (mode === "ON") {
        const r = await leaveOn(db, userId, BOT_ID, to as "OFF" | "SHADOW", at);
        console.log(`[structure-mode] ${userId.slice(0, 8)} ON → ${to}; ${r.cancelledOrders} V3 order(s) cancelled`);
        return respond({ ok: true, mode: to, setAt: at, cancelledOrders: r.cancelledOrders });
      }
      // OFF ↔ SHADOW: update in place when the row exists, insert otherwise (the service role may update mode / set_at only)
      const { error: e1 } = row
        ? await db.from("structure_mode").update({ mode: to, set_at: at }).eq("user_id", userId).eq("bot_id", BOT_ID)
        : await db.from("structure_mode").insert({ user_id: userId, bot_id: BOT_ID, mode: to, set_at: at });
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
      const arm = body.orderId.includes("|B|") ? "B" : "A";          // Shadow B order ids carry "|B|" (shadowEngine)
      const { error } = await db.from("iov3_shadow_feedback").insert({ cohort_id: body.cohortId, order_id: body.orderId, arm, user_id: userId, verdict, note: typeof body.note === "string" ? body.note.slice(0, 1000) : null });
      if (error) throw new Error(error.message);
      return respond({ ok: true });
    }

    return respond({ error: "Unknown action" }, 400);
  } catch (e: any) {
    console.error(`[structure-mode] failed: ${e?.message ?? e}`);
    return respond({ error: String(e?.message ?? e) }, 500);
  }
});
