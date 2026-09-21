/**
 * IPO observation snapshot. Phase C. READ-ONLY.
 *
 * Turns the incremental engine's runtime state into something the UI can render.
 * It decides nothing, places nothing, and writes nothing — a test asserts it
 * references no trading-state table and no broker path.
 *
 * EXECUTION ELIGIBILITY IS INFORMATIONAL. `executionEligible` says whether the
 * frozen rules would admit this setup right now. It is a label for a human, not
 * an instruction to anything. Phase C places no orders of any kind.
 *
 * WHAT THE FROZEN LIFECYCLE ACTUALLY TRACKS, and what it does not. The trader's
 * vocabulary has ten states; `ipoLifecycle` implements the subset that changes
 * a decision: suppression by an active contraction, promotion by opposite-side
 * clearance, touch, and invalidation. MOVE_AWAY, EXPANSION_TO_IPO and
 * TREND_FROM_IPO exist in `ipoStateMachine` as research and are NOT part of the
 * frozen population rules, so they are reported as NOT_TRACKED rather than
 * inferred. Showing a fabricated state would be worse than showing none.
 */

import type { Candle } from "./smcAnalysis.ts";
import type { VolBucket } from "./ipoRegimeDescriptors.ts";
import { IncrementalEngine, type Tracked } from "./ipoIncrementalEngine.ts";
import type { EngineConfig } from "./ipoLiveEngine.ts";

/** Lifecycle state, derived only from what the frozen rules compute. */
export type ObservedState =
  | "PENDING_CANDIDATE"
  | "SUPPRESSED_IN_CONTRACTION"
  | "PENDING_DEAD"
  | "VALID_LIVE"
  | "VALID_TOUCHED"
  | "INVALIDATED";

export type TriState = "YES" | "NO" | "NOT_TRACKED";

export type ReasonCode =
  | "NO_PRIOR_CONTRACTION"
  | "INSIDE_ACTIVE_CONTRACTION"
  | "AWAITING_OPPOSITE_SIDE_CLEARANCE"
  | "DIED_BEFORE_CLEARANCE"
  | "NO_ALIGNED_FVG"
  | "FVG_WINDOW_OPEN"
  | "VOLATILITY_NOT_ELIGIBLE"
  | "POSITION_ALREADY_OPEN"
  | "PRICE_NOT_AT_ENTRY"
  | "INVALIDATED_BY_CLOSE"
  | "ELIGIBLE_NOW";

export interface IpoObservationRow {
  instrument: string;
  timeframe: string;
  direction: "long" | "short";

  ipoCandleTime: string;
  ipoIndex: number;
  zoneHigh: number;
  zoneLow: number;
  /** The frozen E2 entry: midpoint of the IPO candle's full range. NOT a Fib level. */
  midpoint: number;

  state: ObservedState;
  /** True when the frozen rules consider this a usable IPO right now. */
  signalValid: boolean;
  validationStatus: string;
  observationStatus: "WATCHING" | "TOUCHED_THIS_BAR" | "CLOSED";

  fvgPresent: boolean;
  fvgStatus: "CONFIRMED" | "NONE_YET" | "WINDOW_OPEN";

  /** Frozen-lifecycle concepts. */
  contraction: TriState;
  touch: TriState;
  oppositeSideCleared: TriState;
  /** Research-only states the frozen population rules do not compute. */
  moveAway: TriState;
  expansion: TriState;
  trend: TriState;

  volatilityBucket: VolBucket;
  volatilityEligible: boolean;

  intendedEntry: number;
  target2R: number;
  s2Invalidation: number;
  riskPrice: number;

  sequencingState: "FREE" | "BLOCKED_POSITION_OPEN";
  /** INFORMATIONAL ONLY. Phase C never acts on this. */
  executionEligible: boolean;
  reasonCodes: ReasonCode[];
}

export interface IpoObservationSnapshot {
  instrument: string;
  timeframe: string;
  /** Timestamp of the newest CLOSED bar the engine has processed. */
  asOf: string | null;
  barsProcessed: number;
  volatilityBucket: VolBucket;
  sequencingState: "FREE" | "BLOCKED_POSITION_OPEN";
  openPosition: { ipoIndex: number; entryIndex: number; entry: number } | null;
  rows: IpoObservationRow[];
  /** Closed observations, so the UI can show what happened without a ledger. */
  completedTrades: number;
}

function describe(t: Tracked, engine: IncrementalEngine, cfg: EngineConfig): IpoObservationRow {
  const K = engine.currentIndex;
  const long = t.direction === "demand";
  const entry = long ? t.zoneLow : t.zoneHigh;
  const risk = Math.abs(entry - t.invalidationLevel);
  const volEligible = !cfg.highVolOnly || engine.currentVol === "HIGH_VOL";
  const blocked = engine.sequencingBlocked;

  const state: ObservedState =
    t.invalidatedAt !== null ? "INVALIDATED"
    : t.suppressed ? "SUPPRESSED_IN_CONTRACTION"
    : t.validAt !== null ? (t.touchedThisBar ? "VALID_TOUCHED" : "VALID_LIVE")
    : t.promotionDead ? "PENDING_DEAD"
    : "PENDING_CANDIDATE";

  const fvgStatus: IpoObservationRow["fvgStatus"] =
    t.hasFvg ? "CONFIRMED" : t.fvgSettled ? "NONE_YET" : "WINDOW_OPEN";

  const reasons: ReasonCode[] = [];
  if (t.invalidatedAt !== null) reasons.push("INVALIDATED_BY_CLOSE");
  if (t.suppressed) reasons.push("INSIDE_ACTIVE_CONTRACTION");
  if (t.validAt === null && t.priorHigh === null && t.priorLow === null) reasons.push("NO_PRIOR_CONTRACTION");
  else if (t.validAt === null && t.promotionDead) reasons.push("DIED_BEFORE_CLEARANCE");
  else if (t.validAt === null) reasons.push("AWAITING_OPPOSITE_SIDE_CLEARANCE");
  if (!t.hasFvg) reasons.push(t.fvgSettled ? "NO_ALIGNED_FVG" : "FVG_WINDOW_OPEN");
  if (!volEligible) reasons.push("VOLATILITY_NOT_ELIGIBLE");
  if (blocked) reasons.push("POSITION_ALREADY_OPEN");

  const signalValid = t.validAt !== null && t.hasFvg &&
    !t.suppressed && t.invalidatedAt === null;

  // The frozen admission set, evaluated for display only.
  const bar = engine.barAt(K);
  const atEntry = bar ? (long ? bar.low <= entry : bar.high >= entry) : false;
  if (signalValid && t.touchedThisBar && volEligible && !blocked && !atEntry) {
    reasons.push("PRICE_NOT_AT_ENTRY");
  }
  const executionEligible = signalValid && t.touchedThisBar && volEligible && !blocked && atEntry && risk > 0;
  if (executionEligible) reasons.push("ELIGIBLE_NOW");

  return {
    instrument: cfg.instrument,
    timeframe: cfg.timeframe,
    direction: long ? "long" : "short",
    ipoCandleTime: engine.barAt(t.k)?.datetime ?? "",
    ipoIndex: t.k,
    zoneHigh: t.zoneHigh,
    zoneLow: t.zoneLow,
    midpoint: long ? t.zoneLow : t.zoneHigh,
    state,
    signalValid,
    validationStatus: t.validAt !== null ? `VALIDATED@${t.validAt}` : "NOT_VALIDATED",
    observationStatus: t.invalidatedAt !== null ? "CLOSED"
      : t.touchedThisBar ? "TOUCHED_THIS_BAR" : "WATCHING",
    fvgPresent: t.hasFvg,
    fvgStatus,
    contraction: t.suppressed ? "YES" : "NO",
    touch: t.lastTouch !== null ? "YES" : "NO",
    oppositeSideCleared: t.validAt !== null ? "YES" : "NO",
    // Research-only states; see the module header.
    moveAway: "NOT_TRACKED",
    expansion: "NOT_TRACKED",
    trend: "NOT_TRACKED",
    volatilityBucket: engine.currentVol,
    volatilityEligible: volEligible,
    intendedEntry: entry,
    target2R: long ? entry + 2 * risk : entry - 2 * risk,
    s2Invalidation: t.invalidationLevel,
    riskPrice: risk,
    sequencingState: blocked ? "BLOCKED_POSITION_OPEN" : "FREE",
    executionEligible,
    reasonCodes: reasons,
  };
}

/**
 * Builds a snapshot from closed bars.
 *
 * CLOSED BARS ONLY. The caller must not pass a forming bar: an unfinished close
 * would move both the volatility bucket and the S2 test, so the observation
 * would describe a state that never existed.
 */
export function observe(closedBars: Candle[], cfg: EngineConfig): IpoObservationSnapshot {
  const engine = new IncrementalEngine(cfg);
  for (const b of closedBars) engine.feed(b);
  return snapshotOf(engine, cfg);
}

/** Snapshot of an already-advanced engine, so a live runner need not rebuild. */
export function snapshotOf(engine: IncrementalEngine, cfg: EngineConfig): IpoObservationSnapshot {
  const K = engine.currentIndex;
  const rows = engine.inspect()
    .map((t) => describe(t, engine, cfg))
    // Newest first, and drop long-dead candidates so the scanner stays readable.
    .filter((r) => r.state !== "PENDING_DEAD" || r.ipoIndex > K - 200)
    .sort((a, b) => b.ipoIndex - a.ipoIndex);

  const op = engine.openTrade;
  return {
    instrument: cfg.instrument,
    timeframe: cfg.timeframe,
    asOf: engine.barAt(K)?.datetime ?? null,
    barsProcessed: engine.barCount,
    volatilityBucket: engine.currentVol,
    sequencingState: engine.sequencingBlocked ? "BLOCKED_POSITION_OPEN" : "FREE",
    openPosition: op ? { ipoIndex: op.ipoIndex, entryIndex: op.entryIndex, entry: op.entry } : null,
    rows,
    completedTrades: engine.trades.length,
  };
}

/** Drops any bar at or after `nowMs`, so only completed bars are observed. */
export function closedBarsOnly(bars: Candle[], nowMs: number, barMs: number): Candle[] {
  return bars.filter((b) => new Date(b.datetime).getTime() + barMs <= nowMs);
}
