// Impulse-on-V3 shadow: one run for one pair across every account in SHADOW (or ON — the shadow keeps recording beside ON).
// Called by supabase/functions/iov3-shadow (cron) and local-runner/iov3-shadow-audit.ts. Reads stored data only:
// structure_mode, bot_configs (the account's global config row, exactly what bot-scanner loads), structure_bars_1h,
// structure_v3_snapshots, structure_bars_5m. Writes only iov3_shadow_*. No provider call, no trading table.
import { hashStructure } from "../smcScanSnapshot.ts";
import { fxOpenNY } from "../structure/canonicalBars.ts";
import { V32C_ENGINE_VERSION } from "../structure/v32cState.ts";
import { resolveShadowParams } from "./params.ts";
import { advance, IOV3_PAIRS, initShadowState, type Bar, type ShadowDecision, type ShadowEvent, type ShadowParams, type ShadowState, type V3Leg } from "./shadowEngine.ts";

export const SHADOW_ENGINE_VERSION = `iov3-shadow-v1.1+${V32C_ENGINE_VERSION}`;
export const RUNNER_ENV = "IOV3_SHADOW_RUNNER"; // "on" enables the cron function; anything else (default) = off
/** A 5m bar counts only if its canonical value was observed within this long after its close; otherwise it is a data gap. */
export const M5_MISSING_AFTER_MS = 60 * 60_000;
/** Extra wait before declaring a bar missing, so a scan that observed it in time but is still writing is not raced. */
export const M5_WRITE_GRACE_MS = 5 * 60_000;
const H = 3_600_000, M5 = 300_000;

// deno-lint-ignore no-explicit-any
type Client = { from: (table: string) => any };
const iso = (v: string | number) => new Date(typeof v === "number" ? v : Date.parse(v)).toISOString();

async function pages<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from);
    if (error) throw new Error(`${what}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

export interface Cohort { id: string; user_id: string; bot_id: string; started_at: string; first_decision_at: string; live_config_version: string | null; params: Record<string, ShadowParams | { reason: string }>; params_hash: string; engine_version: string }
interface ModeRow { user_id: string; bot_id: string; mode: string; set_at: string }

/** The cohort that should be current for an account in SHADOW/ON: reuse the latest if it started after the flip under the same live
 *  config version, otherwise a new one starting at the flip (or at the config change). Deterministic, so parallel runs agree. */
export async function ensureCohort(db: Client, m: ModeRow): Promise<Cohort> {
  const { data: cfg, error: ce } = await db.from("bot_configs").select("config_json,config_version,updated_at").eq("user_id", m.user_id).is("connection_id", null).maybeSingle();
  if (ce) throw new Error(`bot config: ${ce.message}`);
  const { data: last, error: le } = await db.from("iov3_shadow_cohorts").select("*").eq("user_id", m.user_id).eq("bot_id", m.bot_id).order("started_at", { ascending: false }).limit(1);
  if (le) throw new Error(`cohorts: ${le.message}`);
  const cur = last?.[0] as Cohort | undefined, version = cfg?.config_version ?? null;
  if (cur && Date.parse(cur.started_at) >= Date.parse(m.set_at) && cur.live_config_version === version) return cur;
  const configChanged = !!cur && Date.parse(cur.started_at) >= Date.parse(m.set_at) && cur.live_config_version !== version;
  const startMs = configChanged ? Math.max(Date.parse(m.set_at), Date.parse(cfg?.updated_at ?? m.set_at)) : Date.parse(m.set_at);
  const params: Cohort["params"] = {};
  for (const pair of IOV3_PAIRS) { const r = resolveShadowParams(cfg?.config_json ?? null, pair); params[pair] = r.ok ? r.params : { reason: r.reason }; }
  const row: Cohort = { id: `${m.user_id}|${m.bot_id}|${iso(startMs)}`, user_id: m.user_id, bot_id: m.bot_id, started_at: iso(startMs),
    first_decision_at: iso(Math.ceil(startMs / H) * H), live_config_version: version, params, params_hash: hashStructure(params), engine_version: SHADOW_ENGINE_VERSION };
  const { error } = await db.from("iov3_shadow_cohorts").upsert(row, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`cohort insert: ${error.message}`);
  return row;
}

/**
 * The shadow's 5m bars from the canonical 5m store (structure_bars_5m: first settled observation wins, values never change).
 * Deterministic: a bar is PRESENT iff its canonical value was observed within M5_MISSING_AFTER_MS of its close, so a later replay
 * (the audit) sees exactly what the hourly run saw. `processUntil` stops processing before the first FX-open slot (from `fromMs`)
 * that is not final yet: absent but still inside the window (+ write grace). Older absent slots are data gaps.
 */
export function canonical5m(rows: { bar_time: string; open: number; high: number; low: number; close: number; observed_at: string }[], nowMs: number, fromMs: number): { bars: Bar[]; processUntil: number } {
  const bars: Bar[] = [];
  for (const r of rows) {
    const t = Date.parse(r.bar_time);
    if (Date.parse(r.observed_at) > t + M5 + M5_MISSING_AFTER_MS) continue;
    bars.push({ t, o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close) });
  }
  bars.sort((a, b) => a.t - b.t);
  const have = new Set(bars.map((b) => b.t));
  let processUntil = nowMs - 60_000;
  for (let t = Math.floor(fromMs / M5) * M5; t + M5 <= processUntil; t += M5) {
    if (!fxOpenNY(Math.floor(t / H) * H) || have.has(t)) continue;
    if (nowMs < t + M5 + M5_MISSING_AFTER_MS + M5_WRITE_GRACE_MS) { processUntil = t + M5 - 1; break; } // may still arrive: wait
  }
  return { bars, processUntil };
}

export type Arm = "A" | "B";
export const ARMS: readonly Arm[] = ["A", "B"];
/** v3 = the external leg (Shadow A); v3b = the outer internal leg (Shadow B). */
export interface PairData { h1: Bar[]; m5: Bar[]; m5ProcessUntil: number; v3: Map<number, V3Leg>; v3b: Map<number, V3Leg>; ctx4h: { t: number; trend: string | null }[] }
/** Everything one pair needs from `fromMs` (state horizon) to `untilMs`: all canonical 1H bars, 5m from 2 days before. */
export async function loadPairData(db: Client, pair: string, fromMs: number, untilMs: number, nowMs = untilMs + M5_MISSING_AFTER_MS + M5_WRITE_GRACE_MS + M5): Promise<PairData> {
  type B1 = { bar_time: string; open: number; high: number; low: number; close: number };
  const h1 = (await pages<B1>((f) => db.from("structure_bars_1h").select("bar_time,open,high,low,close").eq("symbol", pair).order("bar_time").range(f, f + 999), `bars ${pair}`))
    .map((r) => ({ t: Date.parse(r.bar_time), o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close) }));
  type B5 = B1 & { observed_at: string };
  const m5From = iso(fromMs - 3 * 86_400_000); // ≥ 300 FX-open 5m bars back from the first decision / confirmation window, across a weekend
  const m5s = canonical5m(await pages<B5>((f) => db.from("structure_bars_5m").select("bar_time,open,high,low,close,observed_at").eq("symbol", pair)
    .gte("bar_time", m5From).lte("bar_time", iso(untilMs)).order("bar_time").range(f, f + 999), `5m ${pair}`), nowMs, fromMs);
  type S = { tf: string; known_at: string; trend: string | null; p_time: string | null; p_price: number | null; x_time: string | null; x_price: number | null;
    il_time: string | null; il_price: number | null; il_x_time: string | null; il_x_price: number | null };
  const snaps = await pages<S>((f) => db.from("structure_v3_snapshots").select("tf,known_at,trend,p_time,p_price,x_time,x_price,il_time,il_price,il_x_time,il_x_price").eq("symbol", pair).eq("engine_version", V32C_ENGINE_VERSION)
    .in("tf", ["1H", "4H"]).gte("known_at", iso(fromMs - 7 * 86_400_000)) /* ≥ 1 week: the 4H trend in force across a weekend / holiday */.lte("known_at", iso(untilMs)).order("tf").order("known_at").range(f, f + 999), `v3 ${pair}`);
  const v3 = new Map<number, V3Leg>(), v3b = new Map<number, V3Leg>(), ctx4h: PairData["ctx4h"] = [];
  const num = (v: number | null) => (v === null ? null : Number(v)), ms = (v: string | null) => (v ? Date.parse(v) : null);
  for (const s of snaps) {
    if (s.tf !== "1H") { ctx4h.push({ t: Date.parse(s.known_at), trend: s.trend }); continue; }
    const trend = (s.trend as V3Leg["trend"]) ?? null, T = Date.parse(s.known_at);
    v3.set(T, { trend, pTime: ms(s.p_time), pPrice: num(s.p_price), xTime: ms(s.x_time), xPrice: num(s.x_price) });
    // rows written before Shadow B existed carry no internal leg: "no structure" for B at that hour (deterministic, never waits)
    v3b.set(T, s.il_time ? { trend, pTime: ms(s.il_time), pPrice: num(s.il_price), xTime: ms(s.il_x_time), xPrice: num(s.il_x_price) } : { trend: null, pTime: null, pPrice: null, xTime: null, xPrice: null });
  }
  ctx4h.sort((a, b) => a.t - b.t);
  return { h1, m5: m5s.bars, m5ProcessUntil: m5s.processUntil, v3, v3b, ctx4h };
}

/** Pure: advance one (cohort, pair) from `state` to `untilMs` on loaded data. Shared by the cron run and the audit replay. */
export function step(params: ShadowParams, state: ShadowState, d: PairData, untilMs: number, arm: Arm = "A") {
  const ctx4hAt = (t: number) => { let r: string | null = null; for (const x of d.ctx4h) { if (x.t <= t) r = x.trend; else break; } return r; };
  const legs = arm === "B" ? d.v3b : d.v3;
  return advance(state, { h1: d.h1, m5: d.m5, v3At: (T) => legs.get(T), ctx4hAt, params: { ...params, arm }, until: untilMs });
}

export function decisionRow(c: Cohort, pair: string, x: ShadowDecision, ctx4h: string | null, arm: Arm = "A") {
  return { cohort_id: c.id, arm, pair, t: iso(x.t), user_id: c.user_id, dir: x.dir, reason: x.reason, price: x.price,
    leg: x.leg ? { trend: x.leg.trend, swing_time: x.leg.pTime === null ? null : iso(x.leg.pTime), swing_price: x.leg.pPrice, extreme_time: x.leg.xTime === null ? null : iso(x.leg.xTime), extreme_price: x.leg.xPrice } : null,
    leg_bars: x.legBars, zone: x.zone, order_plan: x.order, ctx4h };
}
export function eventRow(c: Cohort, pair: string, e: ShadowEvent, arm: Arm = "A") {
  const order_id = e.type === "placed" ? e.order.id : e.type === "filled" ? e.position.id : e.id;
  return { cohort_id: c.id, arm, pair, order_id, type: e.type, t: iso(e.t), user_id: c.user_id, payload: e };
}

export interface PairRunResult { cohort: string; arm: Arm; pair: string; skipped?: string; decisions: number; events: number; asOf?: string; open?: string | null }

export async function runShadowForPair(db: Client, pair: string, nowMs: number): Promise<PairRunResult[]> {
  const { data: modes, error } = await db.from("structure_mode").select("user_id,bot_id,mode,set_at").in("mode", ["SHADOW", "ON"]);
  if (error) throw new Error(`structure_mode: ${error.message}`);
  const out: PairRunResult[] = [];
  for (const m of (modes ?? []) as ModeRow[]) {
    const c = await ensureCohort(db, m);
    const params = c.params[pair];
    if (!params || "reason" in params) {
      const reason = params && "reason" in params ? params.reason : "no parameters";
      await db.from("iov3_shadow_audit").upsert({ cohort_id: c.id, arm: "A", pair, kind: "refused", ref: reason, detail: { reason } }, { onConflict: "cohort_id,arm,pair,kind,ref", ignoreDuplicates: true });
      for (const arm of ARMS) out.push({ cohort: c.id, arm, pair, skipped: reason, decisions: 0, events: 0 });
      continue;
    }
    const states = new Map<Arm, { seq: number; state: ShadowState }>();
    for (const arm of ARMS) {
      const { data: sRows, error: se } = await db.from("iov3_shadow_state").select("seq,state").eq("cohort_id", c.id).eq("arm", arm).eq("pair", pair).order("seq", { ascending: false }).limit(1);
      if (se) throw new Error(`state: ${se.message}`);
      states.set(arm, { seq: sRows?.[0]?.seq ?? 0, state: sRows?.[0]?.state ?? initShadowState(Date.parse(c.first_decision_at)) });
    }
    const fromMs = Math.min(...[...states.values()].flatMap((x) => [x.state.lastScanT, x.state.last5mT]));
    const data = await loadPairData(db, pair, fromMs, nowMs, nowMs);
    const until = Math.min(nowMs - 60_000, data.m5ProcessUntil);        // only final (settled or definitively missing) 5m bars
    const ctxAt = (t: number) => { let v: string | null = null; for (const x of data.ctx4h) { if (x.t <= t) v = x.trend; else break; } return v; };
    const put = async (table: string, rows: unknown[], onConflict: string) => {
      for (let i = 0; i < rows.length; i += 500) {
        const { error: e } = await db.from(table).upsert(rows.slice(i, i + 500), { onConflict, ignoreDuplicates: true });
        if (e) throw new Error(`${table} ${pair}: ${e.message}`);
      }
    };
    for (const arm of ARMS) {
      const { seq, state } = states.get(arm)!;
      if (until <= state.lastScanT && until <= state.last5mT + M5) { out.push({ cohort: c.id, arm, pair, decisions: 0, events: 0 }); continue; }
      const r = step(params, state, data, until, arm);
      await put("iov3_shadow_decisions", r.decisions.map((x) => decisionRow(c, pair, x, ctxAt(x.t), arm)), "cohort_id,arm,pair,t");
      await put("iov3_shadow_events", r.events.map((e) => eventRow(c, pair, e, arm)), "cohort_id,order_id,type,t");
      if (JSON.stringify(r.state) !== JSON.stringify(state)) {
        // a concurrent run that already wrote seq+1 wins; the rows above are deterministic, so its duplicates were ignored
        await put("iov3_shadow_state", [{ cohort_id: c.id, arm, pair, seq: seq + 1, user_id: c.user_id, as_of: iso(until), state: r.state }], "cohort_id,arm,pair,seq");
      }
      out.push({ cohort: c.id, arm, pair, decisions: r.decisions.length, events: r.events.length, asOf: iso(until), open: r.state.pos ? `position ${r.state.pos.id}` : r.state.pend ? `order ${r.state.pend.id}` : null });
    }
  }
  return out;
}
