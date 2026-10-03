/**
 * IPO_BASELINE_1H_4H_CAUSAL_V2 — the causal decision layer. RESEARCH ONLY.
 *
 * THE DEFECT. The production lifecycle (`IncrementalEngine.step`, mirroring
 * `runLifecycle`) evaluates a strategy bar only once it has CLOSED, and checks
 * invalidation (close beyond the IPO extreme) BEFORE it records a touch. A bar
 * that reaches the 50% entry and then closes beyond S2 is therefore never a
 * touch, and the trade that a resting order would already have filled is
 * erased. The same closed-bar evaluation lets four other checks read the touch
 * bar's own close or range: validation on that bar, an FVG it completes, a
 * contraction context it changes, and BTC's volatility bucket (ATR incl. bar K).
 *
 * THE FIX, WITHOUT TOUCHING A FROZEN RULE. Nothing in production is modified.
 * The production engine still computes every candidate's lifecycle. This layer
 * only changes WHEN a decision is taken:
 *
 *   ZONE VALID BEFORE BAR  — state after bar K-1 (`inspect()` before feeding K)
 *   -> price reaches entry — the strategy bar reaches the 50% level (as the
 *                            engine requires), timed by the first 1m bar
 *   -> TRADE EXISTS        — at that fill minute
 *   -> rest of the bar     — production `resolveBar`, from the fill on
 *   -> bar closes          — a close beyond S2 EXITS the active trade
 *
 * The bar's close is never consulted to decide whether the entry existed.
 *
 * Choice among several eligible zones on one bar: the earliest fill wins (that
 * is the order resting entries would fill in); same minute -> production's
 * candidate order (earliest IPO). Production instead takes the first TOUCHED
 * zone and refuses the bar if it misses 50% — a rule that reads the bar's later
 * path. The difference is counted, not hidden.
 */

import { IncrementalEngine } from "../supabase/functions/_shared/ipoIncrementalEngine.ts";
import {
  firstEntryMinute, resolveBar, type AltBranch,
} from "../supabase/functions/_shared/ipoCausalOrdering.ts";
import type { EngineConfig } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import type { VolBucket } from "../supabase/functions/_shared/ipoRegimeDescriptors.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";

export const BASELINE_LABEL = "IPO_BASELINE_1H_4H_CAUSAL_V2";
const M = 60_000;
const T = (s: string) => Date.parse(s);

/** The part of a production `Tracked` record a decision may read. */
export interface CandidateView {
  k: number; direction: "demand" | "supply";
  zoneLow: number; zoneHigh: number; invalidationLevel: number;
  validAt: number | null; suppressed: boolean; invalidatedAt: number | null;
  hasFvg: boolean; lastTouch: number | null;
  epContext?: string; touchedThisBar?: boolean;
}
export interface BarState { tracked: CandidateView[]; vol: VolBucket }

const overlaps = (c: Candle, lo: number, hi: number) => c.low <= hi && c.high >= lo;

/** Eligible on the state known at the bar's OPEN. Nothing here reads bar K except its range overlap. */
export function eligibleAtOpen(pre: CandidateView[], K: number, bar: Candle): CandidateView[] {
  return pre.filter((t) => t.validAt !== null && t.validAt <= K - 1 && !t.suppressed && t.invalidatedAt === null &&
    t.hasFvg && (t.lastTouch === null || K > t.lastTouch + 1) && overlaps(bar, t.zoneLow, t.zoneHigh));
}

export interface Levels { long: boolean; entry: number; stop: number; target: number; risk: number }
export const levels = (c: CandidateView): Levels => {
  const long = c.direction === "demand";
  const entry = long ? c.zoneLow : c.zoneHigh, stop = c.invalidationLevel, risk = Math.abs(entry - stop);
  return { long, entry, stop, target: long ? entry + 2 * risk : entry - 2 * risk, risk };
};

export interface PotentialEntry {
  tf: string; K: number; barTime: string; cand: CandidateView; lv: Levels;
  /** Fill instant used for ordering: the 1m fill minute, else the bar open. */
  fillMs: number; fillMinute: string | null;
  /** Why the fill minute is missing, when it is. */
  fillNote: "" | "NO_MINUTES_IN_BAR" | "MINUTES_DO_NOT_REACH_ENTRY";
  nEligible: number;
}

/**
 * How a bar with several eligible zones picks its zone.
 *
 *   TOUCH_ORDER (V2)   — the causal form of the frozen rule. At each minute the
 *                        bar's "hit" is the lowest-k eligible zone touched SO FAR;
 *                        the trade fills when price reaches THAT zone's 50% level.
 *   PRODUCTION_BAR     — the frozen rule as production applies it on the closed
 *                        bar: lowest-k zone touched anywhere in the bar; refuse the
 *                        bar if it never reaches 50%. A lower-k zone touched LATER
 *                        in the bar can cancel a fill that already happened.
 *   EARLIEST_FILL      — whichever zone's 50% fills first. Not the frozen rule;
 *                        kept for comparison only.
 *
 * With a single eligible zone the three are identical.
 */
export type Selection = "TOUCH_ORDER" | "PRODUCTION_BAR" | "EARLIEST_FILL";

const reaches = (lv: Levels, lo: number, hi: number) => (lv.long ? lo <= lv.entry : hi >= lv.entry);

/**
 * The entry taken on bar K, or null. `minutesOfBar` are the 1m bars inside K
 * (possibly empty). The bar's CLOSE is not read anywhere on this path — a test
 * pins that.
 */
export function potentialEntry(
  tf: string, K: number, bar: Candle, barMs: number, pre: BarState, highVolOnly: boolean, minutesOfBar: Candle[],
  selection: Selection = "TOUCH_ORDER",
): PotentialEntry | null {
  if (highVolOnly && pre.vol !== "HIGH_VOL") return null;           // bucket known before the bar
  const elig = eligibleAtOpen(pre.tracked, K, bar);
  if (!elig.length) return null;
  const mk = (c: CandidateView, fm: Candle | null, note: PotentialEntry["fillNote"]): PotentialEntry => ({
    tf, K, barTime: bar.datetime, cand: c, lv: levels(c), fillMs: fm ? T(fm.datetime) : T(bar.datetime),
    fillMinute: fm?.datetime ?? null, fillNote: note, nEligible: elig.length,
  });
  const fillOf = (c: CandidateView) => firstEntryMinute(minutesOfBar, bar, barMs, levels(c).long ? "long" : "short", levels(c).entry);
  // The engine's own bar-level reach test on the production hit; used as the
  // fallback when the tape is missing or disagrees with the strategy bar.
  const barLevel = (): PotentialEntry | null => {
    const hit = elig[0];
    if (!reaches(levels(hit), bar.low, bar.high)) return null;
    const fm = minutesOfBar.length ? fillOf(hit) : null;
    return mk(hit, fm, fm ? "" : minutesOfBar.length ? "MINUTES_DO_NOT_REACH_ENTRY" : "NO_MINUTES_IN_BAR");
  };
  if (!minutesOfBar.length || selection === "PRODUCTION_BAR") return barLevel();
  if (selection === "EARLIEST_FILL") {
    let best: PotentialEntry | null = null;
    for (const c of elig) {
      if (!reaches(levels(c), bar.low, bar.high)) continue;
      const fm = fillOf(c);
      const pe = mk(c, fm, fm ? "" : "MINUTES_DO_NOT_REACH_ENTRY");
      if (!best || pe.fillMs < best.fillMs) best = pe;
    }
    return best;
  }
  // TOUCH_ORDER
  const touched = new Set<CandidateView>();
  for (const m of minutesOfBar) {
    for (const c of elig) if (!touched.has(c) && overlaps(m, c.zoneLow, c.zoneHigh)) touched.add(c);
    const hit = elig.find((c) => touched.has(c));
    if (hit && reaches(levels(hit), m.low, m.high) && reaches(levels(hit), bar.low, bar.high)) return mk(hit, m, "");
  }
  // The tape never filled the zone in charge. If the strategy bar says the
  // production hit reached 50%, the feeds disagree: keep production's entry and
  // let the resolver carry it as AMBIGUOUS (NO_POSITION branch).
  const fb = barLevel();
  return fb && !fb.fillMinute ? fb : null;
}

// ── execution ──────────────────────────────────────────────────────────────
export interface TradeResolution {
  outcome: "TARGET" | "S2_CLOSE" | "AMBIGUOUS" | "VOID" | "OPEN_AT_DATA_END";
  /** For AMBIGUOUS: what the non-open branch claims, and how the open branch ended. */
  altBranch: AltBranch | null; openBranch: "TARGET" | "S2_CLOSE" | "VOID" | "OPEN_AT_DATA_END" | null;
  entryMinute: string | null; targetMinute: string | null; s2BarTime: string | null;
  exitIdx: number; exitPrice: number | null; grossR: number | null;
  /** The instant after which the slot is free. */
  exitMs: number; sameBarS2: boolean; method: string;
}

/**
 * Resolves one entered trade bar by bar with the production resolver.
 * `minutesFor(j)` returns the 1m bars inside strategy bar j (empty when none).
 */
export function resolveTrade(
  bars: Candle[], barMs: number, K: number, lv: Levels, minutesFor: (j: number) => Candle[],
): TradeResolution {
  const dir = lv.long ? "long" : "short";
  let amb: { alt: AltBranch } | null = null;
  let entryMinute: string | null = null;
  for (let j = K; j < bars.length; j++) {
    const mins = minutesFor(j);
    const o = resolveBar({ direction: dir, entryPrice: lv.entry, targetPrice: lv.target, s2InvalidationLevel: lv.stop,
      bar: bars[j], barMs, isEntryBar: j === K && !amb, minutes: mins.length ? mins : null, minutesFinal: true });
    if (j === K && o.entryMinute) entryMinute = o.entryMinute;
    const base = { altBranch: amb?.alt ?? null, entryMinute, sameBarS2: false, method: o.method };
    if (o.kind === "AMBIGUOUS_OPEN_OR_CLOSED") { amb = { alt: o.altBranch! }; continue; }   // open branch keeps the slot
    if (o.kind === "TARGET") {
      // The resolver settles an unambiguous HTF target without naming a minute;
      // the slot still needs the instant, so take it from the tape (chronology
      // only — the outcome is the resolver's). Bar close if no tape.
      const tm = o.targetMinute ??
        mins.find((m) => (lv.long ? m.high >= lv.target : m.low <= lv.target))?.datetime ?? null;
      const r: TradeResolution = { ...base, outcome: amb ? "AMBIGUOUS" : "TARGET", openBranch: amb ? "TARGET" : null,
        targetMinute: tm, s2BarTime: null, exitIdx: j, exitPrice: lv.target, grossR: Math.abs(lv.target - lv.entry) / lv.risk,
        exitMs: tm ? T(tm) + M : T(bars[j].datetime) + barMs };
      return r;
    }
    if (o.kind === "S2_CLOSE") {
      const c = bars[j].close;
      return { ...base, outcome: amb ? "AMBIGUOUS" : "S2_CLOSE", openBranch: amb ? "S2_CLOSE" : null, targetMinute: null,
        s2BarTime: bars[j].datetime, exitIdx: j, exitPrice: c, grossR: (lv.long ? c - lv.entry : lv.entry - c) / lv.risk,
        exitMs: T(bars[j].datetime) + barMs, sameBarS2: j === K };
    }
    if (o.kind === "UNRESOLVED_TERMINAL") {
      return { ...base, outcome: amb ? "AMBIGUOUS" : "VOID", openBranch: amb ? "VOID" : null, targetMinute: null,
        s2BarTime: null, exitIdx: j, exitPrice: null, grossR: null, exitMs: T(bars[j].datetime) + barMs };
    }
    // HOLD (and NEED_MINUTES, which minutesFinal rules out) -> next bar
  }
  return { outcome: amb ? "AMBIGUOUS" : "OPEN_AT_DATA_END", altBranch: amb?.alt ?? null, openBranch: amb ? "OPEN_AT_DATA_END" : null,
    entryMinute, targetMinute: null, s2BarTime: null, exitIdx: bars.length, exitPrice: null, grossR: null,
    exitMs: Infinity, sameBarS2: false, method: "DATA_END" };
}

// ── one slot, several timeframes ───────────────────────────────────────────
export interface Stream {
  tf: string; bars: Candle[]; barMs: number; pes: PotentialEntry[];
  minutesFor: (j: number) => Candle[];
}
export interface SimTrade { pe: PotentialEntry; res: TradeResolution; costR: number; netR: number | null }
export interface SimBlocked { pe: PotentialEntry; reason: "SLOT_HELD" | "SAME_TF_EXIT_BAR" }

/**
 * One position at a time across all streams, in fill order.
 *
 *   - occupied until the active trade's exit instant (an AMBIGUOUS trade holds
 *     the slot through its OPEN branch, as the live runner does);
 *   - same timeframe: the frozen `touchIndex > previousExitIndex` rule;
 *   - ties on the same fill minute: streams in the order given (1H before 4H,
 *     V1's tie-break), then bar index.
 */
export function simulateSlot(streams: Stream[], costPerSide: (p: number) => number, fromMs = -Infinity): { trades: SimTrade[]; blocked: SimBlocked[] } {
  const order = new Map(streams.map((s, i) => [s.tf, i]));
  const all = streams.flatMap((s) => s.pes.filter((p) => p.fillMs >= fromMs).map((p) => ({ p, s })))
    .sort((a, b) => a.p.fillMs - b.p.fillMs || order.get(a.s.tf)! - order.get(b.s.tf)! || a.p.K - b.p.K);
  const trades: SimTrade[] = [], blocked: SimBlocked[] = [];
  let freeAt = -Infinity, lastTf: string | null = null, lastExitIdx = -1;
  for (const { p, s } of all) {
    if (p.fillMs < freeAt) { blocked.push({ pe: p, reason: "SLOT_HELD" }); continue; }
    if (lastTf === s.tf && p.K <= lastExitIdx) { blocked.push({ pe: p, reason: "SAME_TF_EXIT_BAR" }); continue; }
    const res = resolveTrade(s.bars, s.barMs, p.K, p.lv, s.minutesFor);
    const costR = (2 * costPerSide(p.lv.entry)) / p.lv.risk;
    trades.push({ pe: p, res, costR, netR: res.grossR === null || res.outcome === "AMBIGUOUS" ? null : res.grossR - costR });
    freeAt = res.exitMs; lastTf = s.tf; lastExitIdx = res.exitIdx;
  }
  return { trades, blocked };
}

// ── the production lifecycle, read one bar ahead ───────────────────────────
/**
 * Wraps a production IncrementalEngine. `before()` returns the state after the
 * last fed bar — call it BEFORE feeding bar K to get the state at K's open.
 */
export class LifecycleFeed {
  readonly engine: IncrementalEngine;
  constructor(cfg: EngineConfig) { this.engine = new IncrementalEngine(cfg); }
  state(): BarState {
    return {
      tracked: this.engine.inspect().map((t) => ({
        k: t.k, direction: t.direction, zoneLow: t.zoneLow, zoneHigh: t.zoneHigh, invalidationLevel: t.invalidationLevel,
        validAt: t.validAt, suppressed: t.suppressed, invalidatedAt: t.invalidatedAt, hasFvg: t.hasFvg, lastTouch: t.lastTouch,
        epContext: t.epContext, touchedThisBar: t.touchedThisBar,
      })),
      vol: this.engine.currentVol,
    };
  }
  feed(bar: Candle) { return this.engine.feed(bar); }
}

/** What production's closed-bar layer did with V2's chosen candidate at K (attribution only). */
export function productionView(post: BarState, pe: PotentialEntry, highVolOnly: boolean): string[] {
  const t = post.tracked.find((x) => x.k === pe.cand.k && x.direction === pe.cand.direction);
  const why: string[] = [];
  if (!t) return ["NOT_TRACKED_AFTER_BAR"];
  if (t.invalidatedAt === pe.K) why.push("TOUCH_BAR_CLOSED_BEYOND_S2");
  if (pe.cand.epContext !== undefined && t.epContext !== pe.cand.epContext) why.push("CONTRACTION_CONTEXT_CHANGED_ON_BAR");
  if (highVolOnly && post.vol !== "HIGH_VOL") why.push("VOL_BUCKET_WITH_BAR_NOT_HIGH");
  const hit = post.tracked.find((x) => x.touchedThisBar && x.validAt !== null && x.hasFvg && (x.invalidatedAt === null || x.invalidatedAt > pe.K));
  if (hit && (hit.k !== pe.cand.k || hit.direction !== pe.cand.direction)) why.push("PRODUCTION_WOULD_PICK_ANOTHER_ZONE");
  return why;
}

/** Why a specific zone was or was not enterable at K's open, and what the closed bar changed. */
export interface Diagnosis {
  found: boolean; validBefore: boolean; validatedOnBar: boolean; suppressedPre: boolean; invalidatedPre: boolean;
  fvgPre: boolean; fvgOnlyWithBar: boolean; newTouchPre: boolean; contextChangedOnBar: boolean;
  volPre: VolBucket; volPost: VolBucket; flags: string[];
}
export function diagnose(pre: BarState, post: BarState, K: number, k: number, direction: string, highVolOnly: boolean): Diagnosis {
  const a = pre.tracked.find((t) => t.k === k && t.direction === direction);
  const b = post.tracked.find((t) => t.k === k && t.direction === direction);
  const d: Diagnosis = {
    found: !!a, validBefore: !!a && a.validAt !== null && a.validAt <= K - 1, validatedOnBar: b?.validAt === K,
    suppressedPre: a?.suppressed ?? true, invalidatedPre: a ? a.invalidatedAt !== null : true,
    fvgPre: a?.hasFvg ?? false, fvgOnlyWithBar: !(a?.hasFvg ?? false) && (b?.hasFvg ?? false),
    newTouchPre: !!a && (a.lastTouch === null || K > a.lastTouch + 1),
    contextChangedOnBar: !!a && !!b && a.epContext !== b.epContext,
    volPre: pre.vol, volPost: post.vol, flags: [],
  };
  if (!d.found) d.flags.push("NOT_TRACKED_BEFORE_BAR");
  if (!d.validBefore) d.flags.push(d.validatedOnBar ? "VALIDATED_BY_TOUCH_BAR_CLOSE" : "NOT_VALID_BEFORE_BAR");
  if (d.suppressedPre) d.flags.push("SUPPRESSED_BEFORE_BAR");
  if (d.invalidatedPre) d.flags.push("INVALIDATED_BEFORE_BAR");
  if (!d.fvgPre) d.flags.push(d.fvgOnlyWithBar ? "FVG_ONLY_WITH_TOUCH_BAR" : "NO_FVG");
  if (!d.newTouchPre) d.flags.push("NOT_A_NEW_TOUCH");
  if (d.contextChangedOnBar) d.flags.push("CONTRACTION_CONTEXT_CHANGED_ON_TOUCH_BAR");
  if (highVolOnly && pre.vol !== "HIGH_VOL") d.flags.push(post.vol === "HIGH_VOL" ? "VOL_HIGH_ONLY_WITH_TOUCH_BAR" : "VOL_NOT_HIGH");
  return d;
}

export type ScanPE = PotentialEntry & { productionView: string[] };
export interface ScanResult {
  /** Potential entries per selection rule, from ONE lifecycle pass. */
  pes: Record<Selection, ScanPE[]>;
  diagnoses: Map<string, Diagnosis>;   // key `${K}|${k}|${direction}`
}
/**
 * Feeds a whole strategy series through the production lifecycle and returns
 * every bar's potential entry under each selection rule. Each decision reads
 * the state BEFORE its bar is fed; the post-bar state is used for attribution only.
 */
export function scanSeries(
  tf: string, bars: Candle[], barMs: number, cfg: EngineConfig, minutesFor: (j: number) => Candle[],
  diagnoseAt: Array<{ K: number; k: number; direction: string }> = [],
  selections: Selection[] = ["TOUCH_ORDER", "PRODUCTION_BAR"],
): ScanResult {
  const feed = new LifecycleFeed(cfg);
  const want = new Map<number, Array<{ k: number; direction: string }>>();
  for (const d of diagnoseAt) want.set(d.K, [...(want.get(d.K) ?? []), d]);
  const pes = Object.fromEntries(selections.map((s) => [s, [] as ScanPE[]])) as Record<Selection, ScanPE[]>;
  const diagnoses = new Map<string, Diagnosis>();
  bars.forEach((bar, K) => {
    const pre = feed.state();
    const mins = minutesFor(K);
    const got = selections.map((s) => [s, potentialEntry(tf, K, bar, barMs, pre, cfg.highVolOnly, mins, s)] as const);
    feed.feed(bar);
    if (got.some(([, pe]) => pe) || want.has(K)) {
      const post = feed.state();
      for (const [s, pe] of got) if (pe) pes[s].push({ ...pe, productionView: productionView(post, pe, cfg.highVolOnly) });
      for (const d of want.get(K) ?? []) diagnoses.set(`${K}|${d.k}|${d.direction}`, diagnose(pre, post, K, d.k, d.direction, cfg.highVolOnly));
    }
  });
  return { pes, diagnoses };
}

/** 1m bars per strategy bar, by binary search over a sorted tape. */
export function minuteIndex(minutes: Candle[], bars: Candle[], barMs: number): (j: number) => Candle[] {
  const t = minutes.map((m) => T(m.datetime));
  const lb = (x: number) => { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };
  return (j: number) => { const s = T(bars[j].datetime); return minutes.slice(lb(s), lb(s + barMs)); };
}
