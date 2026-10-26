// Impulse-on-V3: the OFF / SHADOW / ON switch and the shadow record, for Bot Config, the V3 Story panel and Pending Orders.
// The switch is served by the structure-mode edge function; the shadow rows are read directly (the owner's own rows, via RLS).
import { supabase } from "@/integrations/supabase/client";
import { invokeFunction } from "@/lib/api";
import { getPipSize } from "@/lib/pipDisplay";

export type StructureMode = "OFF" | "SHADOW" | "ON";
export interface StructureStatus {
  mode: StructureMode; setAt: string; v3LatestClose: string | null;
  unlock: { met: boolean; onAvailable: boolean; daysInShadow: number; right: number; plumbingClean: boolean; reason: string };
  summary: { placed: number; filled: number; wins: number; losses: number; open: number; voided: number; cancelled: number; netR: number } | null;
}
export const structureModeApi = {
  status: () => invokeFunction<StructureStatus>("structure-mode", { action: "status" }),
  set: (mode: StructureMode) => invokeFunction<{ ok?: boolean; error?: string; mode: StructureMode }>("structure-mode", { action: "set", mode }),
  feedback: (cohortId: string, orderId: string, verdict: "right" | "wrong", note?: string) =>
    invokeFunction<{ ok?: boolean; error?: string }>("structure-mode", { action: "feedback", cohortId, orderId, verdict, note }),
};

export interface ShadowDecision {
  cohort_id: string; pair: string; t: string; dir: "long" | "short" | null; reason: string; price: number | null;
  leg: { trend: "bull" | "bear" | null; swing_time: string | null; swing_price: number | null; extreme_time: string | null; extreme_price: number | null } | null;
  leg_bars: number | null;
  zone: { type: string; low: number; high: number; refinedEntry: number | null; fibLevel: number | null; fibDepth: number | null; score: number | null } | null;
  order_plan: { entry: number; sl: number; tp: number; riskPips: number; stopSource: string } | null;
  ctx4h: string | null;
}
export interface ShadowEventPayload {
  order?: { dir: "long" | "short"; entry: number; sl: number; tp: number; zoneType: string; zl: number; zh: number };
  position?: { fill: number; ctx4h: string | null };
  reason?: string; result?: "TP" | "SL"; net?: number;
}
export interface ShadowEvent { cohort_id: string; pair: string; order_id: string; type: string; t: string; payload: ShadowEventPayload }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any; // the shadow tables are not in the generated types
export async function latestDecision(pair: string): Promise<ShadowDecision | null> {
  const { data, error } = await db.from("iov3_shadow_decisions").select("*").eq("pair", pair).order("t", { ascending: false }).limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}
export async function recentEvents(sinceIso: string, pair?: string): Promise<ShadowEvent[]> {
  let q = db.from("iov3_shadow_events").select("cohort_id,pair,order_id,type,t,payload").gte("t", sinceIso).order("t").limit(2000);
  if (pair) q = q.eq("pair", pair);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}
export async function myFeedback(): Promise<Map<string, "right" | "wrong">> {
  const { data } = await db.from("iov3_shadow_feedback").select("order_id,verdict,at").order("at");
  const m = new Map<string, "right" | "wrong">();
  for (const f of data ?? []) m.set(f.order_id, f.verdict);
  return m;
}

export interface ShadowOrder {
  cohortId: string; orderId: string; pair: string; dir: "long" | "short"; placedAt: string;
  entry: number; sl: number; tp: number; zoneType: string; zoneLow: number; zoneHigh: number;
  status: "watching" | "in_zone" | "filled" | "closed" | "cancelled" | "voided";
  statusAt: string; fill?: number; result?: "TP" | "SL"; netR?: number; reason?: string; ctx4h?: string | null;
}
/** Fold the event stream into one record per shadow order (latest status wins). */
export function foldOrders(events: ShadowEvent[]): ShadowOrder[] {
  const m = new Map<string, ShadowOrder>();
  for (const e of events) {
    const key = `${e.cohort_id}|${e.order_id}`;
    if (e.type === "placed") {
      const o = e.payload.order;
      if (!o) continue;
      m.set(key, { cohortId: e.cohort_id, orderId: e.order_id, pair: e.pair, dir: o.dir, placedAt: e.t, entry: o.entry, sl: o.sl, tp: o.tp, zoneType: o.zoneType, zoneLow: o.zl, zoneHigh: o.zh, status: "watching", statusAt: e.t });
      continue;
    }
    const o = m.get(key);
    if (!o) continue;
    o.statusAt = e.t;
    if (e.type === "touched") o.status = "in_zone";
    else if (e.type === "filled") { o.status = "filled"; o.fill = e.payload.position?.fill; o.ctx4h = e.payload.position?.ctx4h ?? null; }
    else if (e.type === "closed") { o.status = "closed"; o.result = e.payload.result; o.netR = e.payload.net; }
    else if (e.type === "cancelled") { o.status = "cancelled"; o.reason = e.payload.reason; }
    else if (e.type === "voided") { o.status = "voided"; o.reason = e.payload.reason; }
  }
  return [...m.values()].sort((a, b) => b.placedAt.localeCompare(a.placedAt));
}

// ── plain words (owner-approved wording, 2026-10-26) ──
export const fmtUtc = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleString("en-GB", { month: "short", day: "numeric", timeZone: "UTC" })} ${d.toISOString().slice(11, 16)}`;
};
export const pipsBetween = (pair: string, a: number, b: number) => Math.abs(a - b) / getPipSize(pair);
export const priceFmt = (pair: string, v: number | null | undefined) => (v == null ? "—" : v.toFixed(getPipSize(pair) >= 0.01 ? 3 : 5));

const REASONS: Record<string, string> = {
  placed: "order placed",
  same_level_kept: "same zone as the open order — kept it",
  no_pois: "no OB / FVG inside the leg",
  no_fib_aligned: "no OB / FVG in the area of interest",
  no_daily_overlap: "no zone overlapping the daily range",
  no_zone_scored: "no zone scored high enough",
  price_beyond_zone: "price is already past the zone",
  too_far_from_zone: "price is too far from the zone (more than 1.5 × ATR)",
  position_open: "a shadow trade is open on this pair",
  no_v3_structure: "V3 has no trend on this pair yet",
  day_not_enabled: "outside your trading days",
  warmup: "not enough history yet",
};
export function reasonText(reason: string): string {
  if (REASONS[reason]) return REASONS[reason];
  if (reason.startsWith("session_not_enabled:")) return `outside your trading sessions (${reason.split(":")[1]})`;
  if (reason.startsWith("stop_geometry:")) return `stop rules rejected the order (${reason.split(":").slice(1).join(":")})`;
  return reason;
}
export function statusText(o: ShadowOrder, pair: string): string {
  switch (o.status) {
    case "watching": return "waiting for price to reach the zone";
    case "in_zone": return "price is in the zone — waiting for the confirmation candle";
    case "filled": return `filled at ${priceFmt(pair, o.fill)}`;
    case "closed": return `${o.result === "TP" ? "hit TP" : "hit SL"} · ${o.netR != null ? `${o.netR > 0 ? "+" : ""}${o.netR.toFixed(2)}R net` : ""}`;
    case "cancelled": return `cancelled — ${CANCEL[o.reason ?? ""] ?? o.reason}`;
    case "voided": return `void — ${o.reason}`;
  }
}
const CANCEL: Record<string, string> = {
  ttl_expiry: "expired after 8 hours", sl_invalidation: "price touched the stop before entry", leg_broken: "a candle closed beyond the swing (the leg broke)",
  direction_flip: "V3 trend flipped", superseded: "a new zone replaced it", fill_beyond_stop: "confirmation closed beyond the stop",
};
