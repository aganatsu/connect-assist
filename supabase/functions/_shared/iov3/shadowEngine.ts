// Impulse-on-V3 shadow engine (step 3; owner design + decisions 2026-10-26). PURE — no database, no clock.
//
// The research replay's arm B (~/strategy-v2/impulse-on-v3/replay.ts, IOV3_VERSION=v11) as a RESUMABLE state machine:
//   - every 1H close T: if no position, V3 direction + leg (P→X) → bestZoneWithLeg on the WHOLE leg → Route 2 limit order
//     (entry = refinedEntry ?? zone mid; route2StopFromLimit with the impulse stop beyond P; TP = tpRatio R; distance guard);
//   - every 5m bar (in order): pending order lifecycle (TTL, wick through the stop, close beyond P, touch → detectZoneConfirmation
//     → fill at that bar's close) and the open position (stop first, then TP), net of the per-pair cost table.
// Feeding the same bars in one call or in many calls gives the same events (tested), so the hourly function can resume from the
// stored state and a local audit can replay everything from the cohort start.
// Additions to the research loop, both OFF in research parity mode: the live session / trading-day gate at the decision hour
// (owner decision D2), and voiding an order / trade whose next 5m bar is missing (never guess through a data gap).
// deno-lint-ignore-file no-explicit-any
import * as SM from "../smcAnalysis.ts";
import * as ZC from "../zoneConfirmation.ts";
import { route2StopFromLimit } from "../route2StopGeometry.ts";
import { detectSession, isSessionEnabled } from "../sessions.ts";
import { fxOpenNY } from "../structure/canonicalBars.ts";
import { bestZoneWithLeg, mapImpulsePOIsFull } from "./zones.ts";

const H = 3_600_000, M5 = 300_000;

/** Research cost tables (connect-assist-v2 spec.ts @ eb565163, the V2 cost model the research used): pip, spread + commission in pips. */
export const IOV3_PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF"] as const;
export const PIP: Record<string, number> = { "EUR/USD": 0.0001, "GBP/USD": 0.0001, "USD/JPY": 0.01, "CHF/JPY": 0.01, "NZD/CAD": 0.0001, "NZD/CHF": 0.0001 };
export const COST_PIPS: Record<string, number> = { "EUR/USD": 1.5, "GBP/USD": 2.0, "USD/JPY": 1.79, "CHF/JPY": 3.29, "NZD/CAD": 3.21, "NZD/CHF": 3.42 };

export interface ShadowParams {
  pair: string; pip: number; costPips: number;
  minSlPips: number;          // per-pair stop floor (resolveStaticFloorPips)
  slBufferPips: number;       // pip floor of the impulse-stop buffer
  legBufferPct: number;       // impulse-stop buffer as a share of the leg (live default 0.02)
  legCapMultiple: number;     // impulse-stop cap as a multiple of the leg (live default 1.2)
  capMultiplier: number;      // impulse-stop cap as a multiple of the floor (impulseSlCapMultiplier, scalper 1.5)
  tpRatio: number;            // exit.tpRRRatio
  distanceAtrMult: number;    // Route 2 distance guard (× H1 ATR)
  ttlMs: number;              // Route 2 order lifetime
  fibMaxRetracement: number;
  enabledSessions: string[] | null; // null = no session gate (research)
  enabledDays: number[] | null;     // NY weekday numbers; null = no day gate (research)
  voidOnGap: boolean;
}
export interface Bar { t: number; o: number; h: number; l: number; c: number }
export interface V3Leg { trend: "bull" | "bear" | null; pTime: number | null; pPrice: number | null; xTime: number | null; xPrice: number | null }
export interface Pending { id: string; dir: "long" | "short"; entry: number; sl: number; tp: number; zl: number; zh: number; zoneType: string; origin: number; placed: number; touchT: number | null; legBars: number; stopSource: string }
export interface Position { id: string; dir: "long" | "short"; entry: number; fill: number; fillT: number; sl: number; tp: number; zl: number; zh: number; placed: number; conf: string; riskPips: number; legBars: number; ctx4h: string | null; ctx4hAgrees: boolean | null }
/** lastScanT: the last 1H close decided. last5mT: open time of the last 5m bar processed (initially a virtual bar closing at the start). */
export interface ShadowState { lastScanT: number; last5mT: number; pend: Pending | null; pos: Position | null }
export type ShadowEvent =
  | { type: "placed"; t: number; order: Pending }
  | { type: "cancelled"; t: number; id: string; reason: string }
  | { type: "touched"; t: number; id: string }
  | { type: "filled"; t: number; position: Position }
  | { type: "closed"; t: number; id: string; result: "TP" | "SL"; exit: number; gross: number; net: number }
  | { type: "voided"; t: number; id: string; stage: "order" | "position"; reason: string };
export interface ShadowDecision {
  t: number; dir: "long" | "short" | null; reason: string; price: number | null;   // last 1H close at the decision
  leg: V3Leg | null; legBars: number | null;
  zone: { type: string; low: number; high: number; refinedEntry: number | null; fibLevel: number | null; fibDepth: number | null; score: number | null } | null;
  order: { entry: number; sl: number; tp: number; riskPips: number; stopSource: string } | null;
}
export interface AdvanceInput {
  h1: readonly Bar[];                           // canonical 1H bars, ascending (from the epoch)
  m5: readonly Bar[];                           // settled 5m bars, ascending; must reach ≥ 300 bars back from the first decision
  v3At: (closeT: number) => V3Leg | undefined;  // V3 1H state after the bar closing at closeT; undefined = not available yet
  ctx4hAt: (t: number) => string | null;        // V3 4H trend as of t
  params: ShadowParams;
  until: number;                                // process everything closing at or before this time
}

/** The first decision is at the first 1H close ≥ startScanT; 5m bars closing at or before startScanT are never processed. */
export const initShadowState = (startScanT: number): ShadowState => ({ lastScanT: startScanT - 1, last5mT: startScanT - M5, pend: null, pos: null });
const toC = (b: Bar) => ({ datetime: new Date(b.t).toISOString(), open: b.o, high: b.h, low: b.l, close: b.c });
/** Last index with ts[i] + len ≤ tEnd (the bar has CLOSED by tEnd), or −1. */
const lastClosed = (ts: readonly number[], tEnd: number, len: number) => { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] + len <= tEnd) lo = m + 1; else hi = m; } return lo - 1; };
/** First index with ts[i] > t, or ts.length. */
const firstAfter = (ts: readonly number[], t: number) => { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m + 1; else hi = m; } return lo; };
/** The next FX-open 5m slot after t (weekend / Friday close skipped with the frozen FX-hours rule). */
function nextOpenSlot(t: number): number { let s = t + M5; for (let k = 0; k < 24 * 12 * 3 && !fxOpenNY(Math.floor(s / H) * H); k++) s += M5; return s; }
function nyWeekday(t: number): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(t));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

/**
 * Advance the shadow from `state` through every 5m bar and 1H decision closing at or before `until`. Stops early (returns the
 * state so far) at the first 1H close whose V3 state is not available yet, so a later call resumes exactly there.
 */
export function advance(state0: ShadowState, inp: AdvanceInput): { state: ShadowState; events: ShadowEvent[]; decisions: ShadowDecision[] } {
  const p = inp.params, pip = p.pip;
  const st: ShadowState = structuredClone(state0);
  const events: ShadowEvent[] = [], decisions: ShadowDecision[] = [];
  const h1t = inp.h1.map((b) => b.t), m5t = inp.m5.map((b) => b.t);
  const h1C = inp.h1.map(toC), m5C = inp.m5.map(toC);
  const h1Index = new Map(h1t.map((t, i) => [t, i]));
  const cancel = (t: number, reason: string) => { events.push({ type: "cancelled", t, id: st.pend!.id, reason }); st.pend = null; };

  // ── 5m bars with t > last5mT and close ≤ bound ──
  const advance5m = (bound: number): void => {
    let k = firstAfter(m5t, st.last5mT);
    for (; k < inp.m5.length && m5t[k] + M5 <= bound; k++) {
      const b = inp.m5[k], close = b.t + M5;
      if (p.voidOnGap && (st.pend || st.pos) && b.t > nextOpenSlot(st.last5mT)) {
        const missing = new Date(nextOpenSlot(st.last5mT)).toISOString();
        if (st.pos) { events.push({ type: "voided", t: close, id: st.pos.id, stage: "position", reason: `data gap: 5m bar ${missing} missing` }); st.pos = null; }
        if (st.pend) { events.push({ type: "voided", t: close, id: st.pend.id, stage: "order", reason: `data gap: 5m bar ${missing} missing` }); st.pend = null; }
      }
      st.last5mT = b.t;
      if (st.pos) {
        const pos = st.pos, long = pos.dir === "long", hitSL = long ? b.l <= pos.sl : b.h >= pos.sl, hitTP = long ? b.h >= pos.tp : b.l <= pos.tp;
        if (hitSL || hitTP) {
          const exit = hitSL ? pos.sl : pos.tp, risk = Math.abs(pos.fill - pos.sl), gross = (long ? exit - pos.fill : pos.fill - exit) / risk;
          events.push({ type: "closed", t: close, id: pos.id, result: hitSL ? "SL" : "TP", exit, gross: +gross.toFixed(3), net: +(gross - (p.costPips * pip) / risk).toFixed(3) });
          st.pos = null;
        }
        continue;
      }
      if (!st.pend) continue;
      const pd = st.pend, long = pd.dir === "long";
      if (close > pd.placed + p.ttlMs) { cancel(close, "ttl_expiry"); continue; }
      if (long ? b.l <= pd.sl : b.h >= pd.sl) { cancel(close, "sl_invalidation"); continue; }
      if (long ? b.c < pd.origin : b.c > pd.origin) { cancel(close, "leg_broken"); continue; }
      if (pd.touchT === null) { if (long ? b.l <= pd.entry : b.h >= pd.entry) { pd.touchT = b.t; events.push({ type: "touched", t: close, id: pd.id }); } continue; }
      const w0 = Math.max(0, k - 299), touchK = m5t.indexOf(pd.touchT);
      const sig = ZC.detectZoneConfirmation(m5C.slice(w0, k + 1) as any, pd.dir, ZC.DEFAULT_ZONE_CONFIRMATION_CONFIG, touchK - w0, p.pair, { zoneHigh: pd.zh, zoneLow: pd.zl });
      if (sig) {
        if (long ? b.c <= pd.sl : b.c >= pd.sl) { cancel(close, "fill_beyond_stop"); continue; }
        const ctx = inp.ctx4hAt(close);
        const pos: Position = { id: pd.id, dir: pd.dir, entry: pd.entry, fill: b.c, fillT: close, sl: pd.sl, tp: pd.tp, zl: pd.zl, zh: pd.zh, placed: pd.placed, conf: (sig as any).type,
          riskPips: +(Math.abs(b.c - pd.sl) / pip).toFixed(1), legBars: pd.legBars, ctx4h: ctx, ctx4hAgrees: ctx ? (ctx === "bull") === long : null };
        events.push({ type: "filled", t: close, position: structuredClone(pos) });   // events are immutable snapshots
        st.pos = pos; st.pend = null;
      }
    }
  };

  // ── 1H decisions in order ──
  let i = lastClosed(h1t, st.lastScanT, H) + 1;
  for (; i < inp.h1.length; i++) {
    const T = h1t[i] + H;
    if (T > inp.until) break;
    const v3 = inp.v3At(T);
    if (v3 === undefined) break;                                         // V3 state for this hour not written yet: resume later
    advance5m(T);
    st.lastScanT = T;
    if (st.pos) { decisions.push({ t: T, dir: null, reason: "position_open", price: inp.h1[i].c, leg: v3, legBars: null, zone: null, order: null }); continue; }
    const d: ShadowDecision = { t: T, dir: null, reason: "", price: inp.h1[i].c, leg: v3, legBars: null, zone: null, order: null };
    decisions.push(d);
    if (p.enabledDays && !p.enabledDays.includes(nyWeekday(T))) { d.reason = "day_not_enabled"; continue; }
    if (p.enabledSessions) {
      const s = detectSession(T);
      const core = ["asian", "london", "newyork"].every((x) => p.enabledSessions!.includes(x));
      if (!isSessionEnabled(s, p.enabledSessions) && !(s.filterKey === "offhours" && core)) { d.reason = `session_not_enabled:${s.filterKey}`; continue; }
    }
    if (i < 299) { d.reason = "warmup"; continue; }
    const htf = h1C.slice(i - 299, i + 1), price = htf[htf.length - 1].close, j5 = lastClosed(m5t, T, M5), ent = m5C.slice(Math.max(0, j5 - 299), j5 + 1);
    let dir: "long" | "short" | null = null, z: any = null, origin = 0;
    const pI = v3.pTime !== null ? h1Index.get(v3.pTime) : undefined, xI = v3.xTime !== null ? h1Index.get(v3.xTime) : undefined;
    if (v3.trend && pI !== undefined && xI !== undefined && v3.pPrice !== null && v3.xPrice !== null) {
      dir = v3.trend === "bull" ? "long" : "short";
      const w0 = Math.max(0, Math.min(i - 299, pI - 310)), cs = h1C.slice(w0, i + 1), bull = dir === "long";
      const leg = { direction: bull ? "bullish" : "bearish", startIndex: pI - w0, endIndex: xI - w0, high: bull ? v3.xPrice : v3.pPrice, low: bull ? v3.pPrice : v3.xPrice, isValid: true, bosPrice: v3.xPrice };
      d.legBars = xI - pI;
      const r = bestZoneWithLeg(cs, ent, leg, leg.direction as any, price, undefined, { fibMaxRetracement: p.fibMaxRetracement, pipSize: pip }, mapImpulsePOIsFull);
      z = r.bestZone; origin = v3.pPrice;
      if (!z) d.reason = r.why;
    } else d.reason = "no_v3_structure";
    d.dir = dir;
    if (st.pend && dir && st.pend.dir !== dir) cancel(T, "direction_flip");
    if (!dir || !z) continue;
    const zp = z.zone.poi;
    d.zone = { type: zp.type, low: zp.low, high: zp.high, refinedEntry: z.zone.refinedEntry ?? null, fibLevel: z.zone.fibLevel ?? null, fibDepth: z.zone.fibDepth ?? null, score: z.zone.totalScore ?? null };
    if (!z.sideOk) { d.reason = "price_beyond_zone"; continue; }
    const entry = z.zone.refinedEntry ?? (zp.high + zp.low) / 2, atr = SM.calculateATR(htf as any);
    if (Math.abs(price - entry) > p.distanceAtrMult * atr) { d.reason = "too_far_from_zone"; continue; }
    const legRange = Math.abs(z.impulse.high - z.impulse.low), buf = Math.max(p.slBufferPips * pip, legRange * p.legBufferPct);
    const geo = route2StopFromLimit({ direction: dir, limit: entry, swingSL: null, impulseSL: dir === "long" ? origin - buf : origin + buf,
      impulseCapPips: Math.max(p.minSlPips * p.capMultiplier, (p.legCapMultiple * legRange) / pip), minSlPips: p.minSlPips, pipSize: pip, tpRatio: p.tpRatio });
    if (!geo.ok) { d.reason = `stop_geometry:${geo.reason}`; continue; }
    d.order = { entry, sl: geo.sl, tp: geo.tp, riskPips: +geo.riskPips.toFixed(1), stopSource: geo.source };
    if (st.pend && Math.abs(st.pend.entry - entry) <= pip) { d.reason = "same_level_kept"; continue; }
    if (st.pend) cancel(T, "superseded");
    const order: Pending = { id: `${p.pair}|${new Date(T).toISOString()}`, dir, entry, sl: geo.sl, tp: geo.tp, zl: zp.low, zh: zp.high, zoneType: zp.type, origin, placed: T, touchT: null, legBars: d.legBars ?? 0, stopSource: geo.source };
    st.pend = order; d.reason = "placed";
    events.push({ type: "placed", t: T, order: structuredClone(order) });
  }
  // after the last decision: 5m bars up to `until`, but never past the next 1H close that has not been decided yet
  const nextT = i < inp.h1.length ? h1t[i] + H : Infinity;
  advance5m(Math.min(inp.until, nextT - 1));
  return { state: st, events, decisions };
}
