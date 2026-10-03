/**
 * IPO_24_TRADE_CAUSAL_AUDIT_V1 — are the 24 forward-paper IPO trades causally valid?
 *
 * AUDIT ONLY. Nothing here is wired to production, writes to the database, or
 * changes a rule. Production code is imported and run unchanged.
 *
 * INPUTS (all snapshotted read-only into local-runner/.cache/ipo-24-audit/):
 *   rows.json / events.json   the 24 `ipo_paper_trade_history` rows with
 *                             causal_execution_version = '1m-ordering-v1', and
 *                             their execution events
 *   engine_<SYM>.json         the persisted engine state (`kv_cache`
 *                             ipo_engine_state:ipo_cet:<SYM>): the EXACT strategy
 *                             bars the live engine processed, and its trade list
 *   <SYM>_1min.json           TwelveData 1m for the period (ipo-24-audit-fetch.ts)
 *
 * METHOD.
 *   1. Replay each engine's bar series through the production IncrementalEngine
 *      from bar 0 and require it to reproduce the persisted trade list exactly.
 *   2. For every bar K, record the engine's state AFTER K-1 — everything a
 *      decision at an intrabar fill inside K could legitimately know.
 *   3. For each trade, ask whether the candidate was valid, unsuppressed, carried
 *      its FVG, was touch-eligible and (BTC) volatility-eligible on that pre-bar
 *      state, then order the intrabar events on 1m: first zone touch, entry-level
 *      touch (the fill), target touch, and the close-confirmed S2 bar.
 *   4. SUPPRESSED_TRADE_CHECK: re-walk the period with the same causal rule and
 *      list entries that should have existed but were never recorded.
 *
 *   deno run --allow-read --allow-write local-runner/ipo-24-trade-causal-audit.ts
 */

import { IncrementalEngine } from "../supabase/functions/_shared/ipoIncrementalEngine.ts";
import { engineConfig, IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";
import { ipoGeometry } from "../supabase/functions/_shared/ipoZones.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import type { LiveTrade } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import type { VolBucket } from "../supabase/functions/_shared/ipoRegimeDescriptors.ts";
import { AUDIT_CACHE, m1File } from "./ipo-24-audit-fetch.ts";

const read = <T>(name: string): T => JSON.parse(Deno.readTextFileSync(new URL(name, AUDIT_CACHE)));
const T = (s: string) => Date.parse(s);
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const M = 60_000;

// ── 1. replay equivalence + pre-bar state capture ──────────────────────────
interface TrackedView {
  k: number; direction: "demand" | "supply"; zoneLow: number; zoneHigh: number; invalidationLevel: number;
  suppressed: boolean; hasFvg: boolean; validAt: number | null; invalidatedAt: number | null; lastTouch: number | null;
  epContext: string;
}
export interface Series {
  symbol: string; tfMs: number; bars: Candle[]; highVolOnly: boolean; costPerSide: (p: number) => number;
  /** state after bar K-1, keyed by K (only for K >= periodStartIdx) */
  pre: Map<number, { tracked: TrackedView[]; vol: VolBucket; blocked: boolean }>;
  /** state after bar K, keyed by K */
  post: Map<number, { tracked: TrackedView[]; vol: VolBucket }>;
  replayTrades: LiveTrade[];
  equivalent: boolean; equivalenceNote: string;
}

const PERIOD_FROM = T("2026-09-24T00:00:00Z");

export function loadSeries(symbol: string): Series {
  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === symbol)!;
  const snap = read<{ bars: Candle[]; trades: LiveTrade[] }>(`engine_${symbol.replace("/", "")}.json`);
  const eng = new IncrementalEngine(engineConfig(inst));
  const pre = new Map<number, { tracked: TrackedView[]; vol: VolBucket; blocked: boolean }>();
  const post = new Map<number, { tracked: TrackedView[]; vol: VolBucket }>();
  const view = () => eng.inspect().map((t) => ({
    k: t.k, direction: t.direction, zoneLow: t.zoneLow, zoneHigh: t.zoneHigh, invalidationLevel: t.invalidationLevel,
    suppressed: t.suppressed, hasFvg: t.hasFvg, validAt: t.validAt, invalidatedAt: t.invalidatedAt, lastTouch: t.lastTouch,
    epContext: t.epContext,
  }));
  snap.bars.forEach((b, K) => {
    const inPeriod = T(b.datetime) >= PERIOD_FROM;
    if (inPeriod) pre.set(K, { tracked: view(), vol: eng.currentVol, blocked: eng.sequencingBlocked });
    eng.feed(b);
    if (inPeriod) post.set(K, { tracked: view(), vol: eng.currentVol });
  });
  const key = (t: LiveTrade) => `${t.ipoIndex}@${t.entryIndex}>${t.exitIndex}:${t.netR?.toFixed(9)}`;
  const a = snap.trades.map(key), b2 = eng.trades.map(key);
  const equivalent = a.length === b2.length && a.every((x, i) => x === b2[i]);
  return {
    symbol, tfMs: inst.barMs, bars: snap.bars, highVolOnly: inst.highVolOnly, costPerSide: inst.costPerSide,
    pre, post, replayTrades: eng.trades, equivalent,
    equivalenceNote: `${b2.length} replayed vs ${a.length} persisted trades${equivalent ? ", identical" : ", DIFFERENT"}`,
  };
}

// ── 1m tape ────────────────────────────────────────────────────────────────
interface Tape { bars: Candle[]; t: number[] }
const tapes = new Map<string, Tape>();
export function tape(symbol: string): Tape {
  if (!tapes.has(symbol)) {
    const bars = JSON.parse(Deno.readTextFileSync(m1File(symbol))) as Candle[];
    tapes.set(symbol, { bars, t: bars.map((b) => T(b.datetime)) });
  }
  return tapes.get(symbol)!;
}
const lb = (t: number[], x: number) => { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };
/** 1m bars with open time in [from, to). */
const minutes = (tp: Tape, from: number, to: number) => tp.bars.slice(lb(tp.t, from), lb(tp.t, to));

// ── causal resolution of one entry ─────────────────────────────────────────
export interface Resolution {
  fillMinute: string | null; firstZoneTouchMinute: string | null; touchBarMinutes: number;
  targetMinute: string | null; s2BarTime: string | null; s2CloseInstant: string | null;
  outcome: "TARGET" | "S2_CLOSE_INVALIDATION" | "OPEN" | "AMBIGUOUS" | "NOT_FILLED";
  ambiguity: string | null; exitBarTime: string | null; exitPrice: number | null; grossR: number | null;
  sameMinuteEntryTarget: boolean; sameMinuteEntryStopWick: boolean; touchBarClosedBeyondS2: boolean;
  m1VsBarMismatch: string | null;
}

/**
 * Orders the events of one entry on the 1m tape. Never uses a strategy bar's
 * close to decide whether an earlier intrabar event happened; the close is used
 * only for what it is — the S2 event, at the close instant.
 */
export function resolveEntry(ser: Series, K: number, long: boolean, zoneLow: number, zoneHigh: number,
  entry: number, stop: number, target: number, risk: number): Resolution {
  const tp = tape(ser.symbol), bar = ser.bars[K], open = T(bar.datetime);
  const inBar = minutes(tp, open, open + ser.tfMs);
  const r: Resolution = {
    fillMinute: null, firstZoneTouchMinute: null, touchBarMinutes: inBar.length, targetMinute: null,
    s2BarTime: null, s2CloseInstant: null, outcome: "NOT_FILLED", ambiguity: null, exitBarTime: null, exitPrice: null,
    grossR: null, sameMinuteEntryTarget: false, sameMinuteEntryStopWick: false,
    touchBarClosedBeyondS2: long ? bar.close < stop : bar.close > stop, m1VsBarMismatch: null,
  };
  if (inBar.length) {
    const hi = Math.max(...inBar.map((b) => b.high)), lo = Math.min(...inBar.map((b) => b.low));
    const tol = Math.abs(bar.close) * 2e-5;
    if (Math.abs(hi - bar.high) > tol || Math.abs(lo - bar.low) > tol) {
      r.m1VsBarMismatch = `bar H/L ${bar.high}/${bar.low} vs 1m ${hi}/${lo}`;
    }
  }
  const z = inBar.find((b) => b.low <= zoneHigh && b.high >= zoneLow);
  r.firstZoneTouchMinute = z ? z.datetime : null;
  const f = inBar.find((b) => (long ? b.low <= entry : b.high >= entry));
  if (!f) return r;
  r.fillMinute = f.datetime;
  const fillMs = T(f.datetime);
  r.sameMinuteEntryStopWick = long ? f.low <= stop : f.high >= stop;

  // S2: first strategy bar at/after K whose CLOSE is beyond the stop; the event is the close instant.
  let s2 = -1;
  for (let j = K; j < ser.bars.length; j++) if (long ? ser.bars[j].close < stop : ser.bars[j].close > stop) { s2 = j; break; }
  const s2Instant = s2 >= 0 ? T(ser.bars[s2].datetime) + ser.tfMs : Infinity;
  if (s2 >= 0) { r.s2BarTime = ser.bars[s2].datetime; r.s2CloseInstant = iso(s2Instant); }

  // TARGET: first minute from the fill minute on that reaches the target, before the S2 close.
  const after = tp.bars.slice(lb(tp.t, fillMs), lb(tp.t, s2Instant));
  const tm = after.find((b) => (long ? b.high >= target : b.low <= target));
  if (tm) {
    const tms = T(tm.datetime);
    r.targetMinute = tm.datetime;
    if (tms === fillMs) {
      r.sameMinuteEntryTarget = true;
      // Only provable if the minute OPENED at/through the entry (filled at the open,
      // so every later print, including the target, follows the fill).
      const openedThrough = long ? f.open <= entry : f.open >= entry;
      if (!openedThrough) { r.outcome = "AMBIGUOUS"; r.ambiguity = "ENTRY_AND_TARGET_IN_SAME_MINUTE"; return r; }
    }
    if (tms + M > s2Instant) { r.outcome = "AMBIGUOUS"; r.ambiguity = "TARGET_IN_S2_CLOSING_MINUTE"; return r; }
    r.outcome = "TARGET"; r.exitPrice = target; r.grossR = Math.abs(target - entry) / risk;
    const eb = ser.bars.findLast((b) => T(b.datetime) <= tms)!;
    r.exitBarTime = eb.datetime;
    return r;
  }
  if (s2 >= 0) {
    const c = ser.bars[s2].close;
    r.outcome = "S2_CLOSE_INVALIDATION"; r.exitPrice = c; r.grossR = (long ? c - entry : entry - c) / risk;
    r.exitBarTime = ser.bars[s2].datetime;
    return r;
  }
  r.outcome = "OPEN";
  return r;
}

// ── causal eligibility of a candidate at bar K ─────────────────────────────
export interface Eligibility {
  found: boolean; validAtPre: number | null; validAtPost: number | null; validBeforeBar: boolean;
  suppressedPre: boolean; invalidatedPre: boolean; fvgPre: boolean; fvgPost: boolean; touchEligiblePre: boolean;
  contextChangedOnBar: boolean; volPre: VolBucket; volPost: VolBucket; volEligiblePre: boolean; volEligiblePost: boolean;
  firstMatchPre: boolean; flags: string[];
}
const overlaps = (c: Candle, lo: number, hi: number) => c.low <= hi && c.high >= lo;
export function eligibility(ser: Series, K: number, ipoIdx: number, direction: string): Eligibility {
  const pre = ser.pre.get(K)!, post = ser.post.get(K)!;
  const a = pre.tracked.find((t) => t.k === ipoIdx && t.direction === direction);
  const b = post.tracked.find((t) => t.k === ipoIdx && t.direction === direction);
  const bar = ser.bars[K];
  const ok = (t: TrackedView) => t.validAt !== null && t.validAt <= K - 1 && !t.suppressed && t.invalidatedAt === null &&
    t.hasFvg && (t.lastTouch === null || K > t.lastTouch + 1) && overlaps(bar, t.zoneLow, t.zoneHigh);
  const first = pre.tracked.find(ok);
  const e: Eligibility = {
    found: !!a, validAtPre: a?.validAt ?? null, validAtPost: b?.validAt ?? null,
    validBeforeBar: !!a && a.validAt !== null && a.validAt <= K - 1,
    suppressedPre: a?.suppressed ?? true, invalidatedPre: a ? a.invalidatedAt !== null : true,
    fvgPre: a?.hasFvg ?? false, fvgPost: b?.hasFvg ?? false,
    touchEligiblePre: !!a && (a.lastTouch === null || K > a.lastTouch + 1),
    contextChangedOnBar: !!a && !!b && a.epContext !== b.epContext,
    volPre: pre.vol, volPost: post.vol,
    volEligiblePre: !ser.highVolOnly || pre.vol === "HIGH_VOL", volEligiblePost: !ser.highVolOnly || post.vol === "HIGH_VOL",
    firstMatchPre: !!first && first.k === ipoIdx && first.direction === direction, flags: [],
  };
  if (!e.found) e.flags.push("CANDIDATE_NOT_TRACKED_BEFORE_BAR");
  if (!e.validBeforeBar) e.flags.push(e.validAtPost === K ? "VALIDATED_BY_TOUCH_BAR_CLOSE" : "NOT_VALID_BEFORE_BAR");
  if (e.suppressedPre) e.flags.push("SUPPRESSED_BEFORE_BAR");
  if (e.invalidatedPre) e.flags.push("INVALIDATED_BEFORE_BAR");
  if (!e.fvgPre) e.flags.push(e.fvgPost ? "FVG_ONLY_WITH_TOUCH_BAR" : "NO_FVG");
  if (!e.touchEligiblePre) e.flags.push("NOT_A_NEW_TOUCH");
  if (e.contextChangedOnBar) e.flags.push("CONTRACTION_CONTEXT_CHANGED_ON_TOUCH_BAR");
  if (!e.volEligiblePre) e.flags.push(e.volEligiblePost ? "VOL_ELIGIBLE_ONLY_WITH_TOUCH_BAR" : "VOL_NOT_ELIGIBLE");
  if (e.found && e.validBeforeBar && !e.firstMatchPre) e.flags.push("ANOTHER_CANDIDATE_FIRST_ON_PRE_STATE");
  return e;
}

// ── 4. SUPPRESSED_TRADE_CHECK: the same causal rule, walked bar by bar ─────
export const SIM_FROM = T("2026-09-24T18:00:00Z");   // all three instruments flat; first 1m-ordering-v1 event 19:00:05
export const SIM_TO = T("2026-10-02T13:00:00Z");     // bar holding the last audited exit (13:15)
export interface SimEntry {
  symbol: string; K: number; barTime: string; ipoIdx: number; ipoTime: string; direction: string;
  entry: number; stop: number; target: number; risk: number; costR: number; costBlocked: boolean;
  res: Resolution; exitIdx: number; openBranchExit: string | null; productionExcludedBy: string;
}
export function simulate(ser: Series): SimEntry[] {
  const out: SimEntry[] = [];
  let lastExitIdx = -1;
  for (let K = 0; K < ser.bars.length; K++) {
    const t0 = T(ser.bars[K].datetime);
    if (t0 < SIM_FROM || t0 > SIM_TO) continue;
    if (K <= lastExitIdx) continue;                                  // frozen sequencing rule
    const pre = ser.pre.get(K)!, bar = ser.bars[K];
    const first = pre.tracked.find((t) => t.validAt !== null && t.validAt <= K - 1 && !t.suppressed &&
      t.invalidatedAt === null && t.hasFvg && (t.lastTouch === null || K > t.lastTouch + 1) &&
      overlaps(bar, t.zoneLow, t.zoneHigh));
    if (!first) continue;
    if (ser.highVolOnly && pre.vol !== "HIGH_VOL") continue;          // bucket known BEFORE the bar
    const long = first.direction === "demand";
    const entry = long ? first.zoneLow : first.zoneHigh, stop = first.invalidationLevel;
    if (!(long ? bar.low <= entry : bar.high >= entry)) continue;      // engine refuses the bar
    const risk = Math.abs(entry - stop);
    const target = long ? entry + 2 * risk : entry - 2 * risk;
    const res = resolveEntry(ser, K, long, first.zoneLow, first.zoneHigh, entry, stop, target, risk);
    // Exit bar for sequencing. An unresolved same-minute fill keeps the slot held
    // by its OPEN branch (the runner's own rule): the next target touch or S2.
    let exitIdx = -1, openBranchExit: string | null = null;
    if (res.exitBarTime) exitIdx = ser.bars.findIndex((b) => b.datetime === res.exitBarTime);
    else if (res.outcome === "AMBIGUOUS" && res.fillMinute) {
      const tp = tape(ser.symbol), fm = T(res.fillMinute);
      const s2Ms = res.s2CloseInstant ? T(res.s2CloseInstant) : Infinity;
      const nxt = tp.bars.slice(lb(tp.t, fm + M), lb(tp.t, s2Ms)).find((b) => (long ? b.high >= target : b.low <= target));
      const at = nxt ? T(nxt.datetime) : res.s2BarTime ? T(res.s2BarTime) : Infinity;
      exitIdx = ser.bars.findLastIndex((b) => T(b.datetime) <= at);
      openBranchExit = nxt ? `TARGET ${nxt.datetime}` : res.s2BarTime ? `S2 ${res.s2BarTime}` : "OPEN";
    } else exitIdx = ser.bars.length;                                 // still open at data end
    const postT = ser.post.get(K)!.tracked.find((t) => t.k === first.k && t.direction === first.direction);
    const productionExcludedBy = postT?.invalidatedAt === K ? "TOUCH_BAR_CLOSED_BEYOND_S2" : "";
    const costR = (2 * ser.costPerSide(entry)) / risk;
    out.push({ symbol: ser.symbol, K, barTime: bar.datetime, ipoIdx: first.k, ipoTime: ser.bars[first.k].datetime,
      direction: long ? "long" : "short", entry, stop, target, risk, costR, costBlocked: costR > 2, res, exitIdx,
      openBranchExit, productionExcludedBy });
    lastExitIdx = exitIdx;
  }
  return out;
}

// ── outputs ────────────────────────────────────────────────────────────────
const OUT = new URL("../docs/exports/", import.meta.url);
const esc = (v: unknown) => { const x = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
const r4 = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);

if (import.meta.main) {
  const series = new Map<string, Series>();
  for (const s of ["USD/JPY", "EUR/USD", "BTC/USD"]) {
    const ser = loadSeries(s);
    console.log(`${s}: ${ser.bars.length} engine bars, ${ser.equivalenceNote}`);
    series.set(s, ser);
  }
  const rows = read<Record<string, any>[]>("rows.json");
  const audit: Record<string, unknown>[] = [];
  for (const [i, r] of rows.entries()) {
    const ser = series.get(r.symbol)!;
    const bt = (x: string) => iso(T(x));
    const K = ser.bars.findIndex((b) => b.datetime === bt(r.strategy_bar_time));
    const ipoIdx = ser.bars.findIndex((b) => b.datetime === bt(r.ipo_candle_time));
    const long = r.direction === "long";
    const g = ipoGeometry(ser.bars[ipoIdx], long ? "demand" : "supply");
    const entry = long ? g.zoneLow : g.zoneHigh, stop = g.extent, risk = Math.abs(entry - stop);
    const target = long ? entry + 2 * risk : entry - 2 * risk;
    const geomOk = Math.abs(entry - r.entry_price) < 1e-9 && Math.abs(stop - r.s2_invalidation_level) < 1e-9 &&
      Math.abs(target - r.target_price) <= Math.abs(r.target_price) * 1e-12;
    const el = eligibility(ser, K, ipoIdx, long ? "demand" : "supply");
    const res = resolveEntry(ser, K, long, g.zoneLow, g.zoneHigh, entry, stop, target, risk);
    const recReason = r.exit_reason === "TARGET_2R" ? "TARGET" : r.exit_reason;
    const causalR = res.grossR === null ? null : res.grossR - r.cost_r;
    const recExitBar = bt(r.exit_time);
    const notes: string[] = [];
    if (r.entry_minute_time && bt(r.entry_minute_time) !== res.fillMinute) notes.push(`recorded fill minute ${bt(r.entry_minute_time)} != tape ${res.fillMinute}`);
    if (r.target_minute_time && bt(r.target_minute_time) !== res.targetMinute) notes.push(`recorded target minute ${bt(r.target_minute_time)} != tape ${res.targetMinute}`);
    const exitBarDiffers = res.exitBarTime !== null && res.exitBarTime !== recExitBar;
    if (exitBarDiffers) notes.push(`tape exit bar ${res.exitBarTime} vs recorded ${recExitBar} (strategy-bar high/low and 1m aggregate disagree; R unchanged)`);
    if (res.m1VsBarMismatch) notes.push(`touch bar: ${res.m1VsBarMismatch}`);
    let cls: string, reason: string, corrExit: string | null = null, corrR: number | null = null;
    if (!geomOk || !res.fillMinute) {
      cls = "INVALID_OTHER"; reason = !geomOk ? "recorded levels differ from production ipoGeometry" : "1m tape never reached the entry inside the touch bar";
    } else if (el.flags.length) {
      cls = "INVALID_LOOKAHEAD_AFFECTED"; reason = el.flags.join("; ");
    } else if (res.outcome === "AMBIGUOUS") {
      cls = "AMBIGUOUS"; reason = res.ambiguity!;
    } else if (res.outcome !== recReason || causalR === null || Math.abs(causalR - r.realized_r) > 1e-6) {
      cls = "VALID_OUTCOME_CORRECTION"; reason = `tape outcome ${res.outcome} ${r4(causalR)}R vs recorded ${recReason} ${r4(r.realized_r)}R`;
      corrExit = `${res.outcome} @ ${res.exitBarTime}`; corrR = causalR;
    } else {
      cls = "VALID";
      reason = `valid before the touch bar (validated at ${iso(T(ser.bars[el.validAtPre!].datetime) + ser.tfMs)}), fill ${res.fillMinute}, ` +
        (res.outcome === "TARGET" ? `target ${res.targetMinute} before any S2 close` : `S2 close ${res.s2CloseInstant} (no target touch after the fill)`);
    }
    const s2BarIdx = res.s2BarTime ? ser.bars.findIndex((b) => b.datetime === res.s2BarTime) : -1;
    audit.push({
      n: i + 1, pair: r.symbol, tf: r.timeframe, direction: r.direction, ipo_time: bt(r.ipo_candle_time),
      ipo_valid_at: el.validAtPre !== null ? iso(T(ser.bars[el.validAtPre].datetime) + ser.tfMs) : null,
      strategy_bar: bt(r.strategy_bar_time), first_zone_touch_minute: res.firstZoneTouchMinute,
      entry_level_touch_minute: res.fillMinute, recorded_entry_time: bt(r.entry_time), recorded_fill_minute: r.entry_minute_time ? bt(r.entry_minute_time) : null,
      zone_low: g.zoneLow, zone_high: g.zoneHigh, proximal: g.proximal, entry, target, s2: stop,
      recorded_result: recReason, recorded_r: r4(r.realized_r), recorded_exit_bar: recExitBar,
      tape_target_minute: res.targetMinute, tape_s2_bar: res.s2BarTime, tape_s2_close: res.s2CloseInstant,
      causal_outcome: res.outcome, causal_r: r4(causalR), classification: cls, reason,
      same_strategy_bar_entry_and_invalidation: res.touchBarClosedBeyondS2 || (s2BarIdx === K),
      same_1m_entry_and_target: res.sameMinuteEntryTarget,
      same_1m_entry_and_adverse_extreme: res.sameMinuteEntryStopWick,
      tick_resolution_used: false,
      corrected_exit_if_needed: corrExit, corrected_r_if_needed: r4(corrR),
      pre_bar_checks: `valid<=K-1 ${el.validBeforeBar}; suppressed ${el.suppressedPre}; fvg ${el.fvgPre}; new touch ${el.touchEligiblePre}; first ${el.firstMatchPre}; vol ${el.volPre}${ser.highVolOnly ? " (gated)" : ""}`,
      runner_resolution: r.exit_resolution_method, runner_same_bar_ambiguous: r.same_bar_ambiguous,
      notes: notes.join(" | "),
    });
  }
  const cols = Object.keys(audit[0]);
  await Deno.writeTextFile(new URL("ipo_24_trade_causal_audit_v1.csv", OUT), [cols.join(","), ...audit.map((a) => cols.map((c) => esc(a[c])).join(","))].join("\n") + "\n");

  // suppressed-trade check
  const recorded = new Set(rows.map((r) => `${r.symbol}|${iso(T(r.strategy_bar_time))}|${iso(T(r.ipo_candle_time))}`));
  recorded.add("USD/JPY|2026-10-01T15:30:00Z|2026-09-30T23:00:00Z");   // the open ORDERING_AMBIGUOUS position (not one of the 24)
  const sim: Array<SimEntry & { matched: boolean }> = [];
  for (const ser of series.values()) for (const e of simulate(ser)) sim.push({ ...e, matched: recorded.has(`${e.symbol}|${e.barTime}|${e.ipoTime}`) });
  const extra = sim.filter((e) => !e.matched);
  const scols = ["pair", "tf", "strategy_bar", "ipo_time", "direction", "entry", "target", "s2", "cost_r", "cost_blocked",
    "fill_minute", "touch_bar_closed_beyond_s2", "production_excluded_by", "tape_target_minute", "tape_s2_bar", "causal_outcome", "causal_r", "open_branch_exit"];
  const tf = (sym: string) => IPO_INSTRUMENTS.find((x) => x.instrument === sym)!.timeframe;
  await Deno.writeTextFile(new URL("ipo_24_trade_suppressed_candidates_v1.csv", OUT), [scols.join(","), ...extra.map((e) => [
    e.symbol, tf(e.symbol), e.barTime, e.ipoTime, e.direction, e.entry, e.target, e.stop, r4(e.costR), e.costBlocked,
    e.res.fillMinute, e.res.touchBarClosedBeyondS2, e.productionExcludedBy || "OTHER", e.res.targetMinute, e.res.s2BarTime,
    e.res.outcome, e.res.grossR === null ? null : r4(e.res.grossR - e.costR), e.openBranchExit,
  ].map(esc).join(","))].join("\n") + "\n");

  // console summary
  const count = (c: string) => audit.filter((a) => a.classification === c).length;
  console.log("\nclassification:", ["VALID", "VALID_OUTCOME_CORRECTION", "AMBIGUOUS", "INVALID_LOOKAHEAD_AFFECTED", "INVALID_OTHER"].map((c) => `${c} ${count(c)}`).join(" | "));
  for (const a of audit) console.log(`#${a.n} ${a.pair} ${a.classification} — ${a.reason}${a.notes ? " || " + a.notes : ""}`);
  console.log(`\nsim: ${sim.length} causal entries in the period, ${sim.filter((e) => e.matched).length} match recorded entries, ${extra.length} not recorded`);
  const recordedNotInSim = rows.filter((r) => !sim.some((e) => `${e.symbol}|${e.barTime}|${e.ipoTime}` === `${r.symbol}|${iso(T(r.strategy_bar_time))}|${iso(T(r.ipo_candle_time))}`));
  console.log(`recorded trades the causal walk does not produce: ${recordedNotInSim.length}`, recordedNotInSim.map((r) => `${r.symbol} ${r.strategy_bar_time}`).join("; "));
  for (const e of extra) console.log(`  EXTRA ${e.symbol} ${e.barTime} ipo ${e.ipoTime} ${e.direction} fill ${e.res.fillMinute} closeBeyond=${e.res.touchBarClosedBeyondS2} excludedBy=${e.productionExcludedBy || "OTHER"} -> ${e.res.outcome} ${e.res.grossR === null ? "" : (e.res.grossR - e.costR).toFixed(3)}R cost ${e.costR.toFixed(3)}${e.costBlocked ? " BLOCKED" : ""} ${e.openBranchExit ?? ""}`);
}
