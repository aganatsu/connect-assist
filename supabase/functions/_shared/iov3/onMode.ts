// Impulse-on-V3 ON (step 4b; owner decisions D1 = a, S1 recorded, S2 settled, S3 measure, 2026-10-27).
//
// ON executes the SHADOW'S OWN hourly decision (iov3_shadow_decisions, current cohort, chosen arm) through the live Route 2 path:
// same zone, same entry, same stop beyond the V3 swing, same TP — sized, attributed, hunted, filled and mirrored like every Route 2
// order. ON and the shadow cannot disagree on WHAT to trade; they differ only in execution, which is what is measured.
// If the shadow has no fresh decision (job down, data gap), ON places nothing new: it fails safe.
//
// ON is active only when BOTH structure_mode.mode = 'ON' (the switch) AND config_json.structure.owner = 'v3' (written at the flip,
// so ON is its own cohort). Everything here is inert otherwise.
import { fxOpenNY } from "../structure/canonicalBars.ts";
import type { ShadowParams } from "./shadowEngine.ts";

const H = 3_600_000;
/** = structure/v32c/config.ts V32C_ENGINE_VERSION (pinned by test). Restated so bot-scanner never imports the V3.2c engine modules. */
export const V3_ENGINE_VERSION = "v3.2c-frozen-20261013";
export type Arm = "A" | "B";
export const V3_ZONE_PREFIX = "V3";
/** V3 orders are tagged by entry_zone_type ("V3A-FVG", "V3B-OB", …); no constraint on that column, none needed on pending_orders. */
export const v3ZoneType = (arm: Arm, poiType: string) => `${V3_ZONE_PREFIX}${arm}-${String(poiType || "ZONE").toUpperCase()}`;
export const isV3Order = (o: { entry_zone_type?: string | null }) => typeof o.entry_zone_type === "string" && o.entry_zone_type.startsWith(V3_ZONE_PREFIX);
/** A decision older than this is stale: no new order from it (orders already placed keep being managed). */
export const DECISION_MAX_AGE_MS = 2 * H;

// deno-lint-ignore no-explicit-any
type Client = { from: (table: string) => any };

export type OnContext =
  | { on: true; arm: Arm; cohortId: string; onSince: string; params: Record<string, ShadowParams | { reason: string }> }
  | { on: false; reason: string };

/** Pure part: is ON in force for this account, given the switch row, the raw config and the resolved style switches? */
export function onGate(row: { mode?: string; arm?: string | null } | null, raw: { structure?: { owner?: unknown } } | null, style: string, styleOverridesMode: string):
  { on: true; arm: Arm } | { on: false; reason: string } {
  if (!row || row.mode !== "ON") return { on: false, reason: "switch not ON" };
  if (raw?.structure?.owner !== "v3") return { on: false, reason: "config structure.owner is not v3" };
  if (row.arm !== "A" && row.arm !== "B") return { on: false, reason: "no arm chosen" };
  if (style !== "scalper") return { on: false, reason: `style ${style}: V3 ON is built for scalper only` };
  if (styleOverridesMode !== "off") return { on: false, reason: "styleOverridesMode is not off" };
  return { on: true, arm: row.arm };
}

export async function loadOnContext(db: Client, userId: string, botId: string, raw: Record<string, unknown> | null, style: string, styleOverridesMode: string): Promise<OnContext> {
  const { data: row } = await db.from("structure_mode").select("mode,arm,on_since").eq("user_id", userId).eq("bot_id", botId).maybeSingle();
  const g = onGate(row ?? null, raw as { structure?: { owner?: unknown } } | null, style, styleOverridesMode);
  if (!g.on) return g;
  const { data: c } = await db.from("iov3_shadow_cohorts").select("id,params").eq("user_id", userId).eq("bot_id", botId).order("started_at", { ascending: false }).limit(1);
  if (!c?.[0]) return { on: false, reason: "no shadow cohort yet" };
  return { on: true, arm: g.arm, cohortId: c[0].id, onSince: row?.on_since ?? new Date(0).toISOString(), params: c[0].params };
}

export interface ShadowDecisionRow {
  t: string; dir: "long" | "short" | null; reason: string; price: number | null;
  leg: { trend: string | null; swing_time: string | null; swing_price: number | null; extreme_time: string | null; extreme_price: number | null } | null;
  zone: { type: string; low: number; high: number; refinedEntry: number | null } | null;
  order_plan: { entry: number; sl: number; tp: number; riskPips: number; stopSource: string } | null;
}
export async function latestDecision(db: Client, cohortId: string, arm: Arm, pair: string): Promise<ShadowDecisionRow | null> {
  const { data } = await db.from("iov3_shadow_decisions").select("t,dir,reason,price,leg,zone,order_plan").eq("cohort_id", cohortId).eq("arm", arm).eq("pair", pair).order("t", { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

export type V3Plan =
  | { ok: true; dir: "long" | "short"; entry: number; planSL: number; planTP: number; zone: NonNullable<ShadowDecisionRow["zone"]>;
      leg: { origin: number; extreme: number; range: number }; impulseSL: number; impulseCapPips: number; minSlPips: number; decisionAt: string }
  | { ok: false; reason: string };
/**
 * Pure: the order ON should have live for this pair, from the shadow's latest decision. Stop inputs are rebuilt from the leg and the
 * cohort's frozen parameters exactly as the shadow engine builds them (impulse stop = swing ∓ max(slBuffer pips, leg × legBufferPct);
 * cap = max(floor × capMultiplier, legCapMultiple × leg); floor = the static per-pair floor) so the live geometry can be checked
 * against the shadow's planned stop.
 */
export function planFromDecision(d: ShadowDecisionRow | null, p: ShadowParams | { reason: string } | undefined, nowMs: number): V3Plan {
  if (!p || "reason" in p) return { ok: false, reason: p && "reason" in p ? `pair refused: ${p.reason}` : "no shadow parameters for pair" };
  if (!d) return { ok: false, reason: "no shadow decision yet" };
  const age = nowMs - Date.parse(d.t);
  if (age < 0 || age > DECISION_MAX_AGE_MS) return { ok: false, reason: `shadow decision stale (${Math.round(age / 60_000)} min old)` };
  if (!d.order_plan || !d.zone || !d.dir) return { ok: false, reason: `shadow: ${d.reason}` };
  const origin = d.leg?.swing_price, extreme = d.leg?.extreme_price;
  if (origin == null || extreme == null) return { ok: false, reason: "shadow decision has no leg" };
  const legRange = Math.abs(Number(extreme) - Number(origin)), buf = Math.max(p.slBufferPips * p.pip, legRange * p.legBufferPct);
  return {
    ok: true, dir: d.dir, entry: Number(d.order_plan.entry), planSL: Number(d.order_plan.sl), planTP: Number(d.order_plan.tp), zone: d.zone,
    leg: { origin: Number(origin), extreme: Number(extreme), range: legRange },
    impulseSL: d.dir === "long" ? Number(origin) - buf : Number(origin) + buf,
    impulseCapPips: Math.max(p.minSlPips * p.capMultiplier, (p.legCapMultiple * legRange) / p.pip),
    minSlPips: p.minSlPips, decisionAt: d.t,
  };
}

/** The V3 leg in the shape the hunt's existing impulse-broken check reads (signal_reason.impulseZone.impulse): broken = beyond the swing. */
export function legAsImpulse(dir: "long" | "short", origin: number, extreme: number) {
  return dir === "long" ? { high: extreme, low: origin } : { high: origin, low: extreme };
}

/** Latest V3 1H trend per symbol (for the V3 replacement of the thesis direction-flip check). Fail-open: null = unknown. */
export async function v3TrendNow(db: Client, symbol: string, engineVersion: string): Promise<"bull" | "bear" | null> {
  const { data } = await db.from("structure_v3_snapshots").select("trend,known_at").eq("symbol", symbol).eq("tf", "1H").eq("engine_version", engineVersion).order("known_at", { ascending: false }).limit(1);
  const t = data?.[0]?.trend;
  return t === "bull" || t === "bear" ? t : null;
}

// ── automatic fallback (owner Q2): −8R cumulative, or the first 20 ON trades averaging below −0.3R ──
export const KILL_CUM_R = -8, KILL_FIRST_N = 20, KILL_FIRST_N_AVG = -0.3;
export interface OnTrade { entry: number; exit: number; stopAtPlacement: number; direction: "long" | "short"; closedAt: string }
/** R from the stop recorded when the ORDER was placed (paper_positions.stop_loss is the stop at close: unusable for R). */
export const tradeR = (t: OnTrade) => {
  const risk = Math.abs(t.entry - t.stopAtPlacement);
  return risk > 0 ? (t.direction === "long" ? t.exit - t.entry : t.entry - t.exit) / risk : 0;
};
export function evaluateKill(trades: OnTrade[]): { kill: boolean; reason: string | null; n: number; netR: number } {
  const rs = [...trades].sort((a, b) => a.closedAt.localeCompare(b.closedAt)).map(tradeR);
  const netR = +rs.reduce((a, b) => a + b, 0).toFixed(3);
  if (netR <= KILL_CUM_R) return { kill: true, reason: `ON net ${netR.toFixed(2)}R ≤ ${KILL_CUM_R}R`, n: rs.length, netR };
  if (rs.length >= KILL_FIRST_N) {
    // rounded so floating-point noise cannot trip it: exactly −0.30R is not "worse than −0.3R"
    const avg = Math.round((rs.slice(0, KILL_FIRST_N).reduce((a, b) => a + b, 0) / KILL_FIRST_N) * 1e6) / 1e6;
    if (avg < KILL_FIRST_N_AVG) return { kill: true, reason: `first ${KILL_FIRST_N} ON trades average ${avg.toFixed(2)}R < ${KILL_FIRST_N_AVG}R`, n: rs.length, netR };
  }
  return { kill: false, reason: null, n: rs.length, netR };
}
/** Closed ON trades since the flip: final (non-partial) history rows whose source order is a V3 order placed after on_since. */
export async function loadOnTrades(db: Client, userId: string, botId: string, onSince: string): Promise<OnTrade[]> {
  const { data: orders } = await db.from("pending_orders").select("id,direction,stop_loss,entry_zone_type,placed_at").eq("user_id", userId).eq("bot_id", botId)
    .like("entry_zone_type", `${V3_ZONE_PREFIX}%`).gte("placed_at", onSince).limit(2000);
  const byId = new Map((orders ?? []).map((o: { id: string }) => [o.id, o]));
  if (!byId.size) return [];
  const { data: hist } = await db.from("paper_trade_history").select("source_pending_order_id,entry_price,exit_price,close_reason,closed_at").eq("user_id", userId).eq("bot_id", botId)
    .in("source_pending_order_id", [...byId.keys()]).neq("close_reason", "partial_tp").limit(2000);
  const out: OnTrade[] = [];
  for (const h of hist ?? []) {
    const o = byId.get(h.source_pending_order_id) as { direction: "long" | "short"; stop_loss: number } | undefined;
    if (!o || h.exit_price == null || h.entry_price == null) continue;
    out.push({ entry: Number(h.entry_price), exit: Number(h.exit_price), stopAtPlacement: Number(o.stop_loss), direction: o.direction, closedAt: String(h.closed_at ?? "") });
  }
  return out;
}

/** True when FX is open at t (frozen rule) — ON never places orders into a closed market. */
export const fxOpenAt = (t: number) => fxOpenNY(Math.floor(t / H) * H);
