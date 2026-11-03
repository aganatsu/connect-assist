// Breaker shadow: a Unified zone that price closes through flips to the other side (owner idea 2026-11-02; "Show + Shadow").
// Pretend trades only. Nothing here can place, change or block a real order.
//
// The rule is the one pre-registered and tested in ~/strategy-v2/flip-zones/PREREG.md (sha256 2371fbce…). It FAILED on the unseen
// year (confirmation arm: gross −0.007R, net −0.131R, n 58), so this records it live beside the bot instead of trading it.
//   Break: the first 5m bar, starting at or after the zone was first seen, that CLOSES beyond the zone's far side.
//   Flip:  E = the near edge price returns to; S = the other edge ∓ 1 pip, widened to the pair's minimum stop; T = E ∓ 1.5 × |E − S|.
//   Valid 48 h from the break bar's close. Cancelled before a fill on: expiry, a 5m close back beyond the other edge (flip failed),
//   and for arm C a bar reaching S after the touch (stop before entry) or a confirmation close beyond S.
//   Arm C: touch E, then production detectZoneConfirmation at each later 5m close; fill at that close.
//   Arm L: limit at E; fill at E, or at the bar's open when it opens beyond E.
//   Positions: stop first, then target, on 5m (arm L includes its fill bar). One open position per pair per arm; a flip that fills
//   while its arm already holds one is skipped. R from the fill; net subtracts the shadow cost table's pips.
import * as ZC from "../zoneConfirmation.ts";

export const BREAKER_ENGINE_VERSION = "breaker-shadow-v1 (flip-zones prereg 2371fbce)";
export const FLIP_VALID_MS = 48 * 3_600_000;
/** A zone that never breaks is forgotten after this long (keeps the state small; the tested rule had no limit). */
export const WATCH_LIMIT_MS = 30 * 86_400_000;
const M5 = 300_000;

export type Arm = "C" | "L";
export const ARMS: readonly Arm[] = ["C", "L"];
export interface Bar { t: number; o: number; h: number; l: number; c: number }
export interface BreakerParams { pair: string; pip: number; costPips: number; minSlPips: number; watchLimitMs?: number }
export interface SeenZone { id: string; dir: "long" | "short"; zoneType: string; zl: number; zh: number; seenT: number; tf?: string | null }
interface ArmState { status: "pending" | "touched" | "done"; touchT: number | null }
export interface Zone extends SeenZone {
  status: "watching" | "flipped" | "done";
  breakT: number | null; flipDir: "long" | "short" | null; E: number | null; S: number | null; T: number | null;
  arms: Record<Arm, ArmState>;
}
export interface Position { zoneId: string; dir: "long" | "short"; fill: number; fillT: number; sl: number; tp: number; zl: number; zh: number; conf: string | null }
/** A zone id is remembered until it has not been seen in a scan for this long, so a zone the scanner keeps showing after it finished
 *  is not tracked a second time (the tested rule counted each zone once). */
export const FORGET_AFTER_MS = 7 * 86_400_000;
/** last5mT: open time of the last 5m bar processed. known: every zone id ever registered → when a scan last showed it. */
export interface BreakerState { last5mT: number; zones: Zone[]; pos: Record<Arm, Position | null>; known: Record<string, number> }
export type BreakerEvent =
  | { type: "seen"; t: number; zoneId: string; zone: SeenZone }
  | { type: "flipped"; t: number; zoneId: string; flipDir: "long" | "short"; E: number; S: number; T: number; breakClose: number }
  | { type: "touched"; t: number; zoneId: string; arm: Arm }
  | { type: "filled"; t: number; zoneId: string; arm: Arm; position: Position }
  | { type: "skipped"; t: number; zoneId: string; arm: Arm; reason: "position_open" }
  | { type: "cancelled"; t: number; zoneId: string; arm: Arm | null; reason: string }
  | { type: "closed"; t: number; zoneId: string; arm: Arm; result: "TP" | "SL"; exit: number; gross: number; net: number };

export const initBreakerState = (startT: number): BreakerState => ({ last5mT: startT - M5, zones: [], pos: { C: null, L: null }, known: {} });
export const zoneId = (pair: string, dir: string, zl: number, zh: number, pip: number) =>
  `${pair}|${dir}|${(zl / pip).toFixed(1)}|${(zh / pip).toFixed(1)}`;

/** Register zones seen in scans. The first sighting wins; an id already registered (tracked, finished or forgotten-watch) only
 *  refreshes its last-seen time. Ids not seen for FORGET_AFTER_MS and no longer tracked are dropped. */
export function addZones(state0: BreakerState, seen: SeenZone[], nowT: number): { state: BreakerState; events: BreakerEvent[] } {
  const st: BreakerState = structuredClone(state0), events: BreakerEvent[] = [];
  for (const z of [...seen].sort((a, b) => a.seenT - b.seenT)) {
    if (z.id in st.known) { st.known[z.id] = Math.max(st.known[z.id], z.seenT); continue; }
    st.known[z.id] = z.seenT;
    st.zones.push({ ...z, status: "watching", breakT: null, flipDir: null, E: null, S: null, T: null, arms: { C: { status: "pending", touchT: null }, L: { status: "pending", touchT: null } } });
    events.push({ type: "seen", t: z.seenT, zoneId: z.id, zone: z });
  }
  const tracked = new Set(st.zones.map((z) => z.id));
  for (const [id, t] of Object.entries(st.known)) if (!tracked.has(id) && t < nowT - FORGET_AFTER_MS) delete st.known[id];
  return { state: st, events };
}

/** Process every 5m bar with t > last5mT whose close is at or before `until`. `m5` must reach 300 bars back for confirmation. */
export function advanceBars(state0: BreakerState, m5: readonly Bar[], p: BreakerParams, until: number): { state: BreakerState; events: BreakerEvent[] } {
  const st: BreakerState = structuredClone(state0), events: BreakerEvent[] = [];
  const pip = p.pip, cost = p.costPips * pip;
  const m5t = m5.map((b) => b.t);
  const m5C = m5.map((b) => ({ datetime: new Date(b.t).toISOString(), open: b.o, high: b.h, low: b.l, close: b.c }));
  let k = 0; { let lo = 0, hi = m5t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (m5t[m] <= st.last5mT) lo = m + 1; else hi = m; } k = lo; }
  const manage = (arm: Arm, b: Bar, close: number) => {
    const pos = st.pos[arm]; if (!pos) return;
    const long = pos.dir === "long", hitS = long ? b.l <= pos.sl : b.h >= pos.sl, hitT = long ? b.h >= pos.tp : b.l <= pos.tp;
    if (!hitS && !hitT) return;
    const exit = hitS ? pos.sl : pos.tp, risk = Math.abs(pos.fill - pos.sl), gross = (long ? exit - pos.fill : pos.fill - exit) / risk;
    events.push({ type: "closed", t: close, zoneId: pos.zoneId, arm, result: hitS ? "SL" : "TP", exit, gross: +gross.toFixed(4), net: +(gross - cost / risk).toFixed(4) });
    st.pos[arm] = null;
  };
  for (; k < m5.length && m5t[k] + M5 <= until; k++) {
    const b = m5[k], close = b.t + M5;
    st.last5mT = b.t;
    for (const arm of ARMS) manage(arm, b, close);                       // exits first: a fill on the same bar may take the slot
    for (const z of st.zones) {
      if (z.status === "done") continue;
      if (z.status === "watching") {
        if (b.t < z.seenT) continue;
        if (close > z.seenT + (p.watchLimitMs ?? WATCH_LIMIT_MS)) { z.status = "done"; continue; }
        if (z.dir === "long" ? b.c < z.zl : b.c > z.zh) {
          const flipDir = z.dir === "long" ? "short" : "long", E = flipDir === "short" ? z.zl : z.zh;
          let S = flipDir === "short" ? z.zh + pip : z.zl - pip;
          if (Math.abs(E - S) < p.minSlPips * pip) S = flipDir === "short" ? E + p.minSlPips * pip : E - p.minSlPips * pip;
          const T = flipDir === "short" ? E - 1.5 * Math.abs(E - S) : E + 1.5 * Math.abs(E - S);
          Object.assign(z, { status: "flipped", breakT: close, flipDir, E, S, T });
          events.push({ type: "flipped", t: close, zoneId: z.id, flipDir, E, S, T, breakClose: b.c });
        }
        continue;                                                         // the break bar itself is never an entry bar
      }
      const long = z.flipDir === "long", E = z.E!, S = z.S!;
      const cancel = (arm: Arm, reason: string) => { z.arms[arm].status = "done"; events.push({ type: "cancelled", t: close, zoneId: z.id, arm, reason }); };
      const fill = (arm: Arm, price: number, conf: string | null) => {
        z.arms[arm].status = "done";
        if (st.pos[arm]) { events.push({ type: "skipped", t: close, zoneId: z.id, arm, reason: "position_open" }); return; }
        const pos: Position = { zoneId: z.id, dir: z.flipDir!, fill: price, fillT: close, sl: S, tp: z.T!, zl: z.zl, zh: z.zh, conf };
        st.pos[arm] = pos;
        events.push({ type: "filled", t: close, zoneId: z.id, arm, position: structuredClone(pos) });
        if (arm === "L") manage("L", b, close);                           // a limit fill can stop out or hit target on its own bar
      };
      for (const arm of ARMS) {
        const a = z.arms[arm]; if (a.status === "done") continue;
        if (close > z.breakT! + FLIP_VALID_MS) { cancel(arm, "expired"); continue; }
        const reachesE = long ? b.l <= E : b.h >= E, failed = long ? b.c < z.zl : b.c > z.zh;
        if (arm === "L") {
          if (reachesE) { fill("L", long ? Math.min(b.o, E) : Math.max(b.o, E), null); continue; }
          if (failed) cancel("L", "flip_failed");
          continue;
        }
        if (a.status === "touched" && (long ? b.l <= S : b.h >= S)) { cancel("C", "stop_before_entry"); continue; }
        if (a.status === "pending") {
          if (!reachesE) { if (failed) cancel("C", "flip_failed"); continue; }
          a.status = "touched"; a.touchT = b.t; events.push({ type: "touched", t: close, zoneId: z.id, arm: "C" });
          if (long ? b.l <= S : b.h >= S) { cancel("C", "stop_before_entry"); continue; }
        }
        if (failed) { cancel("C", "flip_failed"); continue; }
        const w0 = Math.max(0, k - 299), touchK = m5t.indexOf(a.touchT!);
        const sig = ZC.detectZoneConfirmation(m5C.slice(w0, k + 1) as any, z.flipDir!, ZC.DEFAULT_ZONE_CONFIRMATION_CONFIG, touchK - w0, p.pair, { zoneHigh: z.zh, zoneLow: z.zl });
        if (!sig) continue;
        if (long ? b.c <= S : b.c >= S) { cancel("C", "fill_beyond_stop"); continue; }
        fill("C", b.c, (sig as any).type ?? null);
      }
      if (z.arms.C.status === "done" && z.arms.L.status === "done") z.status = "done";
    }
    st.zones = st.zones.filter((z) => z.status !== "done");
  }
  return { state: st, events };
}
