/**
 * Breaker shadow (Zone Story → Breakers): a Unified zone price closed through, flipped to the other side, with the pretend trades the
 * bot records for it. Read-only; written by the breaker-shadow function. Never a real order.
 */
import { supabase } from "@/integrations/supabase/client";

export type BreakerArm = "C" | "L";
export const BREAKER_ARM_LABEL: Record<BreakerArm, string> = { C: "With confirmation", L: "Limit order" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface BreakerEventRow { zone_id: string; arm: string; type: string; t: string; payload: Record<string, any> }
export interface BreakerArmView {
  status: "waiting" | "in_zone" | "open" | "closed" | "cancelled" | "skipped";
  t: string | null; fill?: number; fillT?: string; result?: "TP" | "SL"; net?: number; reason?: string;
}
export interface BreakerZoneView {
  zoneId: string; dir: "long" | "short"; zoneType: string; zl: number; zh: number; seenAt: string;
  flip: { at: string; dir: "long" | "short"; E: number; S: number; T: number; tfMin: number } | null;
  arms: Record<BreakerArm, BreakerArmView>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any; // the breaker tables are not in the generated types
export async function breakerEvents(pair: string, sinceIso: string | null): Promise<BreakerEventRow[]> {
  let q = db.from("breaker_shadow_events").select("zone_id,arm,type,t,payload").eq("pair", pair).order("t").limit(4000);
  if (sinceIso) q = q.gte("t", sinceIso);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/** One record per zone that flipped, newest flip first (zones that were only seen are left out). */
export function foldBreakers(rows: BreakerEventRow[]): BreakerZoneView[] {
  const m = new Map<string, BreakerZoneView>();
  const blank = (): BreakerArmView => ({ status: "waiting", t: null });
  for (const r of rows) {
    const p = r.payload ?? {};
    let z = m.get(r.zone_id);
    if (r.type === "seen") {
      const s = p.zone ?? {};
      if (!z) m.set(r.zone_id, { zoneId: r.zone_id, dir: s.dir, zoneType: s.zoneType ?? "", zl: s.zl, zh: s.zh, seenAt: r.t, flip: null, arms: { C: blank(), L: blank() } });
      continue;
    }
    if (!z) {
      // the zone was seen before the query window: rebuild what the id carries
      const [, dir] = r.zone_id.split("|");
      z = { zoneId: r.zone_id, dir: dir as "long" | "short", zoneType: "", zl: NaN, zh: NaN, seenAt: r.t, flip: null, arms: { C: blank(), L: blank() } };
      m.set(r.zone_id, z);
    }
    if (r.type === "flipped") { z.flip = { at: r.t, dir: p.flipDir, E: p.E, S: p.S, T: p.T, tfMin: Number(p.tfMin ?? 5) }; continue; }
    if (r.arm !== "C" && r.arm !== "L") continue;
    const a = z.arms[r.arm as BreakerArm];
    a.t = r.t;
    if (r.type === "touched") a.status = "in_zone";
    else if (r.type === "filled") { a.status = "open"; a.fill = p.position?.fill; a.fillT = r.t; }
    else if (r.type === "closed") { a.status = "closed"; a.result = p.result; a.net = p.net; }
    else if (r.type === "skipped") { a.status = "skipped"; a.reason = p.reason; }
    else if (r.type === "cancelled") { a.status = "cancelled"; a.reason = p.reason; }
  }
  return [...m.values()].filter((z) => z.flip).sort((a, b) => b.flip!.at.localeCompare(a.flip!.at));
}

export const BREAKER_REASON: Record<string, string> = {
  expired: "48 hours passed without an entry",
  flip_failed: "price closed back through the zone (the flip failed)",
  stop_before_entry: "price reached the stop before a confirmation",
  fill_beyond_stop: "the confirmation candle closed beyond the stop",
  position_open: "a pretend trade was already open on this pair",
  paused: "the switch was off",
};

/** Closed pretend trades per entry type: count, targets hit, net R. */
export function breakerTotals(rows: BreakerEventRow[]): Record<BreakerArm, { n: number; tp: number; netR: number }> {
  const out = { C: { n: 0, tp: 0, netR: 0 }, L: { n: 0, tp: 0, netR: 0 } };
  for (const r of rows) {
    if (r.type !== "closed" || (r.arm !== "C" && r.arm !== "L")) continue;
    const o = out[r.arm as BreakerArm];
    o.n++; if (r.payload?.result === "TP") o.tp++; o.netR += Number(r.payload?.net ?? 0);
  }
  return out;
}
