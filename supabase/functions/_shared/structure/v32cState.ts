// V3.2c state service (PR3 of docs/V3_2C_PRODUCTION_INTEGRATION_DRAFT.md; owner approval 2026-10-26). PURE — no database, no clock.
// The runnable entrypoint is supabase/functions/v32c-state/index.ts; this module holds the rules so CI can test them.
//
//   - Input: one pair's canonical 1H bars (structure_bars_1h) from the epoch. Output: the frozen V3.2c state after EVERY completed
//     bar of 1H / NY-4H / NY-Daily (D28 snapshots), plus a checkpoint record at each completed Daily close (D22).
//   - Full replay from the epoch on every run (measured ≈ 0.3 s per pair). Nothing is carried between runs, so a run cannot drift;
//     comparing each recomputed snapshot with the stored one IS the repaint audit (replay == stored). Hashing a state costs more
//     than stepping it (all history: 1.1–2.0 s per pair), so a run MATERIALIZES only snapshots closing at or after `materializeFrom`:
//     the hourly function uses its audit window, the local backfill / full-audit tool uses the epoch.
//   - Aggregation and engine are the vendored frozen files (D13, D27): an incomplete D/4H bucket is skipped exactly as in research.
//   - Snapshots identify bars by TIME, never by engine index: indices shift whenever the bar set changes, times do not.
import { hashStructure } from "../smcScanSnapshot.ts";
import { initState, premiumDiscount, step, type Bar, type State } from "./v32c/engine.ts";
import { aggregate, type H1 } from "./v32c/timeframes.ts";
import { frozenV32cConfig, V32C_ENGINE_VERSION } from "./v32c/config.ts";

export const V3_TFS = ["1H", "4H", "D"] as const;
export type V3Tf = typeof V3_TFS[number];
export { V32C_ENGINE_VERSION };
export type { H1 };

export interface V3Snapshot {
  symbol: string; tf: V3Tf; known_at: string; bar_time: string; engine_version: string;
  trend: "bull" | "bear" | null;
  p_time: string | null; p_price: number | null;     // protected swing P
  f_time: string | null; f_price: number | null;     // continuation level F
  x_time: string | null; x_price: number | null;     // extreme of the external leg since P (the P→X leg)
  close_pct: number | null;                          // last close in the leg's premium/discount, 100 = P, 0 = X
  pending_kind: "BOS" | "FLIP" | null;
  state_hash: string;                                // digest of the full structural state, indices mapped to bar times
  // Outer INTERNAL leg (Impulse-on-V3 Shadow B, owner approval 2026-10-27): the second-oldest leg of the reference-leg stack — the
  // outermost leg inside the external one — or the only leg when the stack has one. Origin + its extreme since the origin.
  il_time: string | null; il_price: number | null; il_x_time: string | null; il_x_price: number | null;
}
export interface V3Checkpoint {
  symbol: string; known_at: string; engine_version: string; bars_1h: number; last_bar_time: string;
  h1_known_at: string | null; h1_state_hash: string | null; h4_known_at: string | null; h4_state_hash: string | null; d_state_hash: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
// every engine field that holds a bar index (engine.ts types Pt, Q, Pending, Leg)
const INDEX_KEYS = new Set(["index", "extIndex", "qualifiedAt", "from", "breakBar"]);
function withTimes(v: unknown, bars: readonly Bar[], key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => withTimes(x, bars));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = withTimes(x, bars, k);
    return o;
  }
  if (typeof v === "number" && (INDEX_KEYS.has(key) || (key === "conf"))) return bars[v]?.t ?? `#${v}`;
  return v;
}
/** The state minus its bar array, with every bar index replaced by that bar's open time. */
export function stateHash(s: State): string {
  const { bars, nextLeg: _n, ...rest } = s;
  return hashStructure(withTimes(rest, bars));
}

function snapshotOf(symbol: string, tf: V3Tf, s: State, bar: Bar, hash: string): V3Snapshot {
  const t = (i: number | undefined) => (i === undefined ? null : iso(s.bars[i].t));
  const pd = premiumDiscount(s);
  return {
    symbol, tf, known_at: iso(bar.closeTime), bar_time: iso(bar.t), engine_version: V32C_ENGINE_VERSION,
    trend: s.trend, p_time: t(s.P?.index), p_price: s.P?.price ?? null, f_time: t(s.F?.index), f_price: s.F?.price ?? null,
    x_time: pd ? t(pd.extIndex) : null, x_price: pd?.p0 ?? null, close_pct: pd && Number.isFinite(pd.closePct) ? pd.closePct : null,
    pending_kind: s.pending?.kind ?? null, state_hash: hash, ...internalLeg(s),
  };
}

/** The outer internal leg (see V3Snapshot.il_*). Its extreme runs in the trend's direction from the origin to the latest bar. */
export function internalLeg(s: State): Pick<V3Snapshot, "il_time" | "il_price" | "il_x_time" | "il_x_price"> {
  const leg = s.stack.length > 1 ? s.stack[1] : s.stack[0];
  if (!s.trend || !leg) return { il_time: null, il_price: null, il_x_time: null, il_x_price: null };
  const bull = s.trend === "bull";
  let k = leg.origin.index;
  for (let i = leg.origin.index + 1; i < s.bars.length; i++) if (bull ? s.bars[i].h > s.bars[k].h : s.bars[i].l < s.bars[k].l) k = i;
  return { il_time: iso(s.bars[leg.origin.index].t), il_price: leg.origin.price, il_x_time: iso(s.bars[k].t), il_x_price: bull ? s.bars[k].h : s.bars[k].l };
}

/** Replay one pair from its full canonical 1H history; returns every snapshot (per TF, in time order) and every Daily checkpoint. */
/** Checkpoints need the 1H / 4H snapshot as of each Daily close, so they start this long after `materializeFrom`. */
export const CHECKPOINT_LAG_MS = 2 * 86_400_000;

/**
 * Replay one pair from its full canonical 1H history. Returns the snapshots (per TF, in time order) closing at or after
 * `materializeFrom`, and the Daily checkpoints from `materializeFrom + CHECKPOINT_LAG_MS`. Every bar is stepped either way.
 */
export function computeV3State(symbol: string, hours: readonly H1[], materializeFrom = -Infinity): { snapshots: Record<V3Tf, V3Snapshot[]>; checkpoints: V3Checkpoint[]; skipped: Record<V3Tf, number> } {
  const sorted = [...hours].sort((a, b) => a.t - b.t);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].t === sorted[i - 1].t) throw new Error(`${symbol}: duplicate 1H bar ${iso(sorted[i].t)}`);
  const snapshots = {} as Record<V3Tf, V3Snapshot[]>, skipped = {} as Record<V3Tf, number>;
  for (const tf of V3_TFS) {
    const { bars, skipped: sk } = aggregate(tf, sorted);
    const cfg = frozenV32cConfig(tf);
    let s = initState();
    const out: V3Snapshot[] = [];
    for (const b of bars) { s = step(cfg, s, b).state; if (b.closeTime >= materializeFrom) out.push(snapshotOf(symbol, tf, s, b, stateHash(s))); }
    snapshots[tf] = out; skipped[tf] = sk.length;
  }
  const asOf = (xs: V3Snapshot[], t: string) => { let r: V3Snapshot | null = null; for (const x of xs) { if (x.known_at <= t) r = x; else break; } return r; };
  const checkpoints = snapshots.D.filter((d) => Date.parse(d.known_at) >= materializeFrom + CHECKPOINT_LAG_MS).map((d): V3Checkpoint => {
    const h1 = asOf(snapshots["1H"], d.known_at), h4 = asOf(snapshots["4H"], d.known_at);
    const close = Date.parse(d.known_at);
    let n = 0, last = 0;
    for (const b of sorted) { if (b.t + 3_600_000 > close) break; n++; last = b.t; }
    return { symbol, known_at: d.known_at, engine_version: V32C_ENGINE_VERSION, bars_1h: n, last_bar_time: iso(last),
      h1_known_at: h1?.known_at ?? null, h1_state_hash: h1?.state_hash ?? null, h4_known_at: h4?.known_at ?? null, h4_state_hash: h4?.state_hash ?? null, d_state_hash: d.state_hash };
  });
  return { snapshots, checkpoints, skipped };
}

export interface V3Plan {
  inserts: V3Snapshot[]; checkpointInserts: V3Checkpoint[];
  repaints: { tf: V3Tf; known_at: string; stored_hash: string; replay_hash: string }[];
  checkpointMismatches: { known_at: string; field: string; stored: string | null; replay: string | null }[];
  counts: Record<string, number>;
}
/**
 * Compare a replay with what is stored (rows closing at or after `materializeFrom`). New snapshot → insert. Stored and equal → nothing. Stored and different → REPAINT
 * (reported, never overwritten). A stored snapshot the replay no longer produces is also a repaint (replay_hash "missing").
 */
export function planV3Writes(computed: ReturnType<typeof computeV3State>, stored: Map<string, string>, storedCheckpoints: Map<string, V3Checkpoint>, materializeFrom = -Infinity): V3Plan {
  const plan: V3Plan = { inserts: [], checkpointInserts: [], repaints: [], checkpointMismatches: [], counts: {} };
  const bump = (k: string) => { plan.counts[k] = (plan.counts[k] ?? 0) + 1; };
  const produced = new Set<string>();
  for (const tf of V3_TFS) for (const s of computed.snapshots[tf]) {
    const key = `${tf}|${s.known_at}`; produced.add(key);
    const h = stored.get(key);
    if (h === undefined) { plan.inserts.push(s); bump(`insert:${tf}`); }
    else if (h === s.state_hash) bump(`verified:${tf}`);
    else { plan.repaints.push({ tf, known_at: s.known_at, stored_hash: h, replay_hash: s.state_hash }); bump(`repaint:${tf}`); }
  }
  for (const [key, h] of stored) if (!produced.has(key)) {
    const [tf, known_at] = key.split("|") as [V3Tf, string];
    if (Date.parse(known_at) < materializeFrom) continue; // outside this run's window: not judged
    plan.repaints.push({ tf, known_at, stored_hash: h, replay_hash: "missing" }); bump(`repaint:${tf}`);
  }
  const FIELDS = ["bars_1h", "last_bar_time", "h1_known_at", "h1_state_hash", "h4_known_at", "h4_state_hash", "d_state_hash"] as const;
  for (const c of computed.checkpoints) {
    const st = storedCheckpoints.get(c.known_at);
    if (!st) { plan.checkpointInserts.push(c); bump("checkpoint:insert"); continue; }
    let ok = true;
    for (const f of FIELDS) if (String(st[f]) !== String(c[f])) { ok = false; plan.checkpointMismatches.push({ known_at: c.known_at, field: f, stored: st[f] === null ? null : String(st[f]), replay: c[f] === null ? null : String(c[f]) }); }
    bump(ok ? "checkpoint:verified" : "checkpoint:mismatch");
  }
  return plan;
}

/**
 * Continuity check (D26): is the newest FX-open hour that should be settled by `nowMs` in the store? If not, the run is STALE: it is
 * recorded in the audit table, and consumers see no fresh snapshot (no structure = no trade). Snapshots for the bars that DO exist
 * are still written; a snapshot only ever reflects bars at or before its own close. `isOpen` is the frozen FX-hours rule.
 */
export function staleness(hours: readonly H1[], nowMs: number, isOpen: (t: number) => boolean, settleMs = 75 * 60_000): { stale: boolean; expected: string | null; latest: string | null } {
  const H = 3_600_000;
  let t = Math.floor((nowMs - settleMs) / H) * H;
  for (let k = 0; k < 24 * 4 && !isOpen(t); k++) t -= H;           // walk back over a closed market (weekend / Friday close)
  const latest = hours.length ? Math.max(...hours.map((b) => b.t)) : NaN;
  return { stale: !(latest >= t), expected: iso(t), latest: Number.isFinite(latest) ? iso(latest) : null };
}
