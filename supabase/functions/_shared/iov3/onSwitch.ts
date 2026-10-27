// Impulse-on-V3: entering and leaving ON (owner decisions Q1 = a, Q2, flip defaults, 2026-10-26/27).
//
// The ONLY Impulse-on-V3 module allowed to write trading state (pinned by the architecture test):
//   - pending_orders: cancel live orders on the V3 pairs at a flip (entering ON: the Impulse orders; leaving ON: the V3 orders).
//     Open positions are never touched — they run to their own SL / TP.
//   - bot_configs.config_json.structure: { owner: "v3", arm } while ON, removed when leaving. config_version = md5(config_json), so
//     each flip starts a new cohort (owner decision Q1 = a: ON is its own cohort, SHADOW is not).
//   - structure_mode (+ structure_mode_log): the switch row and the flip record.
import { STRUCTURE_PAIRS } from "../structure/canonicalBars.ts";
import { isV3Order, type Arm } from "./onMode.ts";

// deno-lint-ignore no-explicit-any
type Client = { from: (table: string) => any };
type Mode = "OFF" | "SHADOW" | "ON";

async function liveOrdersOnV3Pairs(db: Client, userId: string, botId: string) {
  const { data, error } = await db.from("pending_orders").select("order_id,symbol,entry_zone_type,status")
    .eq("user_id", userId).eq("bot_id", botId).in("status", ["pending", "awaiting_confirmation"]).in("symbol", [...STRUCTURE_PAIRS]);
  if (error) throw new Error(`pending_orders: ${error.message}`);
  return (data ?? []) as { order_id: string; symbol: string; entry_zone_type: string | null }[];
}

async function cancelOrders(db: Client, userId: string, ids: string[], why: string) {
  if (!ids.length) return 0;
  const { error } = await db.from("pending_orders").update({
    status: "cancelled", terminal_reason: "CANCELLED_SUPERSEDED", reset_reason: "structure_switch", hard_invalidation: true,
    cancel_reason: why, resolved_at: new Date().toISOString(),
  }).eq("user_id", userId).in("order_id", ids).in("status", ["pending", "awaiting_confirmation"]);
  if (error) throw new Error(`cancel orders: ${error.message}`);
  return ids.length;
}

/** Write or remove config_json.structure on the account's global config row (the row bot-scanner loads). */
async function setStructureOwner(db: Client, userId: string, value: { owner: "v3"; arm: Arm } | null) {
  const { data: row, error } = await db.from("bot_configs").select("id,config_json").eq("user_id", userId).is("connection_id", null).maybeSingle();
  if (error || !row) throw new Error(`bot config: ${error?.message ?? "no global config row"}`);
  const cfg = { ...(row.config_json ?? {}) } as Record<string, unknown>;
  if (value) cfg.structure = value; else delete cfg.structure;
  const { error: e2 } = await db.from("bot_configs").update({ config_json: cfg }).eq("id", row.id);
  if (e2) throw new Error(`bot config update: ${e2.message}`);
}

export interface FlipResult { mode: Mode; cancelledOrders: number }

/** Enter ON with the chosen arm: cancel the Impulse orders on V3 pairs, mark the config, set the switch, log the flip. */
export async function enterOn(db: Client, userId: string, botId: string, from: Mode, arm: Arm, nowIso: string): Promise<FlipResult> {
  const legacy = (await liveOrdersOnV3Pairs(db, userId, botId)).filter((o) => !isV3Order(o)).map((o) => o.order_id);
  await setStructureOwner(db, userId, { owner: "v3", arm });
  const n = await cancelOrders(db, userId, legacy, "structure switched to V3 ON — Impulse order cancelled (open positions run)");
  const { error } = await db.from("structure_mode").update({ mode: "ON", arm, on_since: nowIso, kill_reason: null, set_at: nowIso }).eq("user_id", userId).eq("bot_id", botId);
  if (error) throw new Error(`structure_mode: ${error.message}`);
  await db.from("structure_mode_log").insert({ user_id: userId, bot_id: botId, from_mode: from, to_mode: "ON", note: `arm ${arm}; ${n} Impulse order(s) cancelled` });
  return { mode: "ON", cancelledOrders: n };
}

/** Leave ON (manually, or the automatic fallback): cancel the V3 orders, unmark the config, set the switch, log the flip. */
export async function leaveOn(db: Client, userId: string, botId: string, to: Exclude<Mode, "ON">, nowIso: string, killReason: string | null = null): Promise<FlipResult> {
  const v3 = (await liveOrdersOnV3Pairs(db, userId, botId)).filter((o) => isV3Order(o)).map((o) => o.order_id);
  await setStructureOwner(db, userId, null);
  const n = await cancelOrders(db, userId, v3, killReason ? `V3 ON stopped automatically: ${killReason}` : "left V3 ON — V3 order cancelled (open positions run)");
  const { error } = await db.from("structure_mode").update({ mode: to, kill_reason: killReason, set_at: nowIso }).eq("user_id", userId).eq("bot_id", botId);
  if (error) throw new Error(`structure_mode: ${error.message}`);
  await db.from("structure_mode_log").insert({ user_id: userId, bot_id: botId, from_mode: "ON", to_mode: to, note: killReason ? `automatic fallback: ${killReason}` : `${n} V3 order(s) cancelled` });
  return { mode: to, cancelledOrders: n };
}
