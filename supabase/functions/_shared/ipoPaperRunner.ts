/**
 * IPO paper runner. Phase D. PURE — no database, no network, no clock.
 *
 * Takes closed bars plus the persisted paper state and returns a PLAN: the
 * position that should exist afterwards, the results that closed, and the audit
 * events to append. The caller writes. Keeping the decision pure is what lets
 * every rule below be tested without a database.
 *
 * WHERE THE BOOTSTRAP LIVES. Rebuilding the engine over ~1,200 bars is the
 * expensive step, and it happens HERE, inside a worker invocation — never in a
 * UI or API request path, which reads persisted state only. The engine cannot be
 * resumed across stateless invocations without serialising `tracked`, `episodes`
 * and the volatility window, and a hand-written serialiser is exactly the kind of
 * restatement that drifts from the frozen rules. So the worker rebuilds, and the
 * paper layer is what advances incrementally: only bars after the persisted
 * cursor may produce writes, and an open position is managed bar-by-bar by
 * `ipoPaperContract` without consulting the engine at all.
 *
 * THAT SPLIT IS A HAZARD, SO IT IS MEASURED. The engine and the contract both
 * decide when a position ends. They must agree; if they ever do not, this module
 * refuses to write and reports `divergence`. A silent disagreement would mean the
 * paper record no longer describes the frozen strategy, which is the one thing
 * Phase D exists to establish.
 *
 * ACTIVATION RECORDS NOTHING HISTORICAL. The first run sets the cursor to the
 * newest closed bar and writes no trades. Backfilling 1,200 bars of engine
 * output would look like forward paper results while being pure hindsight. A
 * trade the engine already holds open at activation is likewise not adopted —
 * we never saw it fill — so the first forward entry waits for it to finish.
 */

import { IncrementalEngine } from "./ipoIncrementalEngine.ts";
import {
  buildIntent, openPosition as openPaperPosition, stepPosition,
  suspendForGap, resumeFromGap, abortForGap,
  eventId, setupId, intentId,
  DEFAULT_SIZING, STRATEGY_ID, STRATEGY_VERSION, NO_PROVENANCE,
  type AccountDecision, type CausalProvenance, type PaperIntent, type PaperPosition,
  type PaperResult, type SizingConfig, type ZoneTelemetry,
} from "./ipoPaperContract.ts";
import {
  resolveBar, htfWouldHaveClosed, CAUSAL_EXECUTION_VERSION,
  type BarOrdering,
} from "./ipoCausalOrdering.ts";
import type { Candle } from "./smcAnalysis.ts";
import type { EngineConfig, LiveTrade } from "./ipoLiveEngine.ts";

/**
 * Default history requirement: the volatility warmup.
 *
 * Below ~200 bars `LiveVolatility` reports UNCLASSIFIED, which a volatility-gated
 * instrument treats as ineligible. Overridable per run because the right warmup
 * is a property of the instrument, not of this module — but lowering it below
 * the warmup means the bucket is unclassified, not that it is LOW.
 */
export const MIN_HISTORY_BARS = 250;

/**
 * Data-gap policy.
 *
 * WHAT IS AND IS NOT DETECTABLE. A provider returns the bars it has; an interior
 * hole and a closed market look identical in the payload, and there is no
 * session calendar here to tell them apart. Two failures ARE crisply detectable
 * and are the ones that matter:
 *
 *   COVERAGE_LOST — the window no longer contains the bar we last managed, so we
 *   cannot prove we saw every bar in between.
 *   FEED_STALE — no closed bar for longer than a market pause could explain.
 *
 * `staleAfterMs` defaults to 3 days so a normal FX weekend never trips it.
 */
export interface GapPolicy {
  staleAfterMs: number;
  abortAfterMs: number;
}

export const DEFAULT_GAP_POLICY: GapPolicy = {
  staleAfterMs: 3 * 24 * 3_600_000,
  abortAfterMs: 14 * 24 * 3_600_000,
};

export interface RuntimeState {
  strategyId: string;
  strategyVersion: string;
  symbol: string;
  timeframe: string;
  /** Newest closed bar whose decisions have been committed. Null before activation. */
  cursorBarTime: string | null;
  /** Bar the runner was switched on at, so hindsight and forward are separable. */
  activatedAtBarTime: string | null;
  barsSeen: number;
  bootstrapCount: number;
}

export type PaperEventType =
  | "SETUP_VALID" | "INTENT_CREATED" | "FILLED" | "REFUSED" | "MANAGED" | "CLOSED"
  | "GAP_SUSPENDED" | "GAP_RECOVERED" | "GAP_ABORTED"
  /**
   * The minute tape refused an exit the frozen engine booked from whole-bar
   * OHLC. Emitted once, when it happens, so the forward record can never
   * contain a silent disagreement between the two.
   */
  | "CAUSAL_OVERRIDE";

export interface PaperEvent {
  eventId: string;
  eventType: PaperEventType;
  symbol: string;
  barTime: string;
  setupId: string | null;
  intentId: string | null;
  /** Never collapsed into one verdict: a block must not erase the strategy call. */
  strategyDecision: string;
  accountDecision: AccountDecision;
  reasonCodes: string[];
  payload: Record<string, unknown>;
}

export interface RunnerInput {
  cfg: EngineConfig;
  /** Milliseconds per bar, for the staleness test. */
  barMs: number;
  closedBars: Candle[];
  nowMs: number;
  state: RuntimeState | null;
  openPosition: PaperPosition | null;
  sizing?: SizingConfig;
  /** Phase D has no live account, so the default records the absence honestly. */
  accountDecision?: AccountDecision;
  gap?: GapPolicy;
  minHistoryBars?: number;
  /**
   * An engine already advanced through every bar in `closedBars`.
   *
   * THE WARM PATH. When present the ~1,200-bar rebuild is skipped entirely and
   * this engine is used as-is; `closedBars` must be exactly the bars it has
   * consumed, because the paper layer reads prices and times from that array.
   * When absent the engine is rebuilt here, which is the cold path and the only
   * place the bootstrap cost is paid. See `ipoEngineState`.
   */
  warmEngine?: IncrementalEngine;
  /**
   * Lower-timeframe bars available for ordering. The resolver slices them per
   * HTF bar, so the caller may pass any superset.
   */
  minuteBars?: readonly Candle[];
  /**
   * TRUE — the default — means "this is all the tape there will be", so a bar
   * that still cannot be ordered becomes ORDERING_UNRESOLVED. That is the safe
   * default for a pure function: a caller who supplies nothing gets a voided
   * observation, never a whole-bar guess.
   *
   * FALSE is an explicit statement that the caller intends to fetch and re-run.
   * The plan it receives is then PROVISIONAL, records nothing, and must not be
   * written.
   */
  minutesFinal?: boolean;
  /** Feeds that supplied the bars, recorded so provenance survives into the row. */
  htfSource?: string | null;
  minuteSource?: string | null;
  /**
   * Observational Daily-structure tag for the candidate ledger. NOT A GATE.
   * Nothing in this module branches on it; a test asserts it cannot reach the
   * execution verdict.
   */
  dailyContext?: (barTime: string, direction: "long" | "short") => {
    structure: string; alignment: string; asOf: string | null;
  } | null;
}

/** A span of lower-timeframe bars the plan could not proceed without. */
export interface MinuteRequest {
  symbol: string;
  barTime: string;
  fromMs: number;
  toMs: number;
  reason: string;
}

export interface RunnerPlan {
  /** True when this run paid for a full engine rebuild rather than taking one warm. */
  bootstrapped: boolean;
  state: RuntimeState;
  /** The position that should exist after this run, or null for flat. */
  openPosition: PaperPosition | null;
  closed: PaperResult[];
  events: PaperEvent[];
  /**
   * Set when the engine and the paper layer disagree. The caller MUST NOT write
   * when this is set — a divergent run is not a smaller truth, it is an unknown one.
   */
  divergence: string | null;
  skipped: "INSUFFICIENT_HISTORY" | null;
  /**
   * Spans whose ordering could not be settled from the data supplied. When this
   * is non-empty the plan is INCOMPLETE and the caller must fetch and re-run
   * rather than write it.
   */
  minutesNeeded: MinuteRequest[];
  /** True whenever `minutesNeeded` is non-empty. Writing a provisional plan is a bug. */
  provisional: boolean;
}

const ms = (t: string) => new Date(t).getTime();

/**
 * Do two timestamps name the same bar?
 *
 * COMPARE THE INSTANT, NOT THE STRING. A position round-trips through a
 * Postgres `timestamptz`, which renders as `2026-09-22T09:30:00+00:00`, while a
 * bar carries the provider's own `2026-09-22T09:30:00Z`. Same moment, different
 * text. A `===` here reported COVERAGE_LOST on a live position and suspended a
 * healthy trade — the second time this programme has been bitten by a
 * timestamp being re-rendered in transit.
 *
 * The distinction that matters: an IDENTITY (`setupId`, `intentId`) is
 * content-addressed over the provider's exact string and must stay byte-exact,
 * which is why schema 2 stores bar times verbatim. A COMPARISON against a value
 * that has been through the database must be by instant, because the database
 * chooses its own rendering and is entitled to.
 */
const sameBar = (a: string, b: string) => ms(a) === ms(b);

function ev(
  type: PaperEventType, symbol: string, barTime: string,
  strategyDecision: string, accountDecision: AccountDecision,
  reasonCodes: string[], payload: Record<string, unknown>,
  ids: { setupId?: string; intentId?: string } = {},
): PaperEvent {
  return {
    eventId: eventId(type, ids.intentId ?? ids.setupId ?? symbol, barTime),
    eventType: type, symbol, barTime,
    setupId: ids.setupId ?? null, intentId: ids.intentId ?? null,
    strategyDecision, accountDecision, reasonCodes, payload,
  };
}

/**
 * How many times this IPO candle has already been traded, and when it last
 * exited.
 *
 * Derived from the engine's own trade list rather than from the paper tables,
 * so it is a property of the strategy rather than of what happened to be
 * recorded. Trades are matched on `ipoIndex` — the candle — which is exactly
 * the zone identity `setupId` is built from.
 */
function zoneTelemetry(t: LiveTrade, engine: IncrementalEngine, bars: Candle[]): ZoneTelemetry {
  const prior = engine.trades
    .filter((x) => x.ipoIndex === t.ipoIndex && x.entryIndex < t.entryIndex)
    .sort((a, b) => a.entryIndex - b.entryIndex);
  const last = prior[prior.length - 1];
  return {
    zoneEntryOrdinal: prior.length + 1,
    zonePreviousExitTime: last?.exitIndex != null ? bars[last.exitIndex].datetime : null,
  };
}

/** The intent identity of an engine trade, so engine and paper rows can be matched. */
function identify(t: LiveTrade, bars: Candle[], timeframe: string) {
  const direction = t.direction === "demand" ? "long" : "short";
  const sid = setupId(t.instrument, timeframe, bars[t.ipoIndex].datetime, direction);
  return { setupId: sid, intentId: intentId(sid, bars[t.entryIndex].datetime) };
}

/**
 * Advances an open position over every closed bar after the one it last saw.
 *
 * Gap handling happens before any bar is applied: managing across an unproven
 * hole would produce an exit price for a path we never observed.
 */
/**
 * Asks the causal resolver about one bar, or records that it cannot be answered.
 *
 * Returns null to mean DEFER: the caller must stop, hand back the request and
 * be re-run with the tape. Deferring is not the same as holding — a deferred bar
 * has not been evaluated at all, and treating it as a hold would be exactly the
 * silent fall-back to HTF ambiguity this work removes.
 */
function order(
  pos: PaperPosition, bar: Candle, barMs: number, isEntryBar: boolean,
  minutes: readonly Candle[] | undefined, minutesFinal: boolean,
  needs: MinuteRequest[],
): BarOrdering | null {
  const o = resolveBar({
    direction: pos.direction, entryPrice: pos.entryPrice,
    targetPrice: pos.targetPrice, s2InvalidationLevel: pos.s2InvalidationLevel,
    bar, barMs, isEntryBar, minutes: minutes ?? null, ticks: null,
  });
  if (o.kind !== "NEED_MINUTES") return o;
  if (minutesFinal) {
    // The tape was asked for and did not arrive. Void the observation; do not
    // fall back to the whole-bar reading that caused the contamination.
    return { ...o, kind: "UNRESOLVED", method: "ORDERING_UNRESOLVED",
      detail: `${o.detail}; no lower-timeframe tape was available for this bar` };
  }
  const from = ms(bar.datetime);
  needs.push({ symbol: pos.symbol, barTime: bar.datetime, fromMs: from, toMs: from + barMs,
    reason: o.detail });
  return null;
}

function manage(
  pos: PaperPosition, bars: Candle[], nowMs: number, barMs: number, policy: GapPolicy,
  acct: AccountDecision,
  minutes: readonly Candle[] | undefined, minutesFinal: boolean, needs: MinuteRequest[],
): { position: PaperPosition | null; result: PaperResult | null; events: PaperEvent[]; deferred: boolean } {
  const events: PaperEvent[] = [];
  const newest = bars[bars.length - 1];
  const covered = bars.some((b) => sameBar(b.datetime, pos.lastManagedBarTime));
  const stale = ms(newest.datetime) + barMs + policy.staleAfterMs < nowMs;

  if (!covered || stale) {
    const reason = !covered ? "COVERAGE_LOST" : "FEED_STALE";
    if (pos.status !== "data_gap_suspended") {
      const suspended = suspendForGap(pos, pos.lastManagedBarTime, newest.datetime, reason);
      events.push(ev("GAP_SUSPENDED", pos.symbol, newest.datetime, "HOLD", acct, [reason], {
        gapFrom: pos.lastManagedBarTime, gapTo: newest.datetime,
      }, pos));
      return { position: suspended, result: null, events, deferred: false };
    }
    // Already suspended. A hole that never closes is permanent, not pending.
    const since = pos.gapFromBarTime ? ms(pos.gapFromBarTime) : ms(pos.lastManagedBarTime);
    if (nowMs - since > policy.abortAfterMs) {
      const result = abortForGap(
        pos, newest.datetime,
        `${reason}: no usable bars since ${pos.gapFromBarTime ?? pos.lastManagedBarTime}`,
      );
      events.push(ev("GAP_ABORTED", pos.symbol, newest.datetime, "HOLD", acct, [reason], {
        gapFrom: pos.gapFromBarTime, gapTo: newest.datetime,
        note: "no exit price and no realized R — this is a data failure, not a strategy outcome",
      }, pos));
      return { position: null, result, events, deferred: false };
    }
    return { position: pos, result: null, events, deferred: false };
  }

  let live = pos;
  if (live.status === "data_gap_suspended") {
    live = resumeFromGap(live);
    events.push(ev("GAP_RECOVERED", live.symbol, newest.datetime, "HOLD", acct, ["GAP_RECOVERED"], {
      resumedFrom: pos.gapFromBarTime, resumedTo: pos.gapToBarTime,
    }, live));
  }

  const start = bars.findIndex((b) => sameBar(b.datetime, live.lastManagedBarTime)) + 1;
  let held = 0;
  for (let i = start; i < bars.length; i++) {
    // Bars after the fill are wholly post-entry, so `isEntryBar` is false here
    // even for the bar the position entered on: that one is stepped explicitly
    // at fill time and `lastManagedBarTime` already points at it.
    const o = order(live, bars[i], barMs, false, minutes, minutesFinal, needs);
    if (!o) return { position: live, result: null, events, deferred: true };
    held++;
    const out = stepPosition(live, bars[i], held, o);
    if (out.kind === "CLOSED") {
      events.push(ev("CLOSED", live.symbol, bars[i].datetime, "WOULD_EXIT", acct,
        [out.result.exitReason, o.method], {
          exitPrice: out.result.exitPrice, realizedR: out.result.realizedR,
          realizedPnlUsd: out.result.realizedPnlUsd,
          sameBarAmbiguous: out.result.sameBarAmbiguous,
          resolutionMethod: o.method, orderingDetail: o.detail,
          targetMinute: o.targetMinute, s2CloseBarTime: o.s2CloseBarTime,
          entryMinute: live.entryMinuteTime,
          htfSource: live.htfSource, minuteSource: live.minuteSource,
        }, live));
      return { position: null, result: out.result, events, deferred: false };
    }
    live = out.position;
  }

  if (held > 0) {
    events.push(ev("MANAGED", live.symbol, live.lastManagedBarTime, "HOLD", acct, [], {
      barsAdvanced: held, maeR: live.maeR, mfeR: live.mfeR,
    }, live));
  }
  return { position: live, result: null, events, deferred: false };
}

/**
 * Plans one worker pass.
 *
 * Order is deliberate: an existing position is resolved from bars alone before
 * the engine is consulted, so gap handling never depends on a rebuild, and a
 * suspended instrument admits no new entries at all.
 */
export function runPaper(input: RunnerInput): RunnerPlan {
  const {
    cfg, barMs, closedBars, nowMs, state, openPosition,
    sizing = DEFAULT_SIZING, accountDecision = "UNAVAILABLE", gap = DEFAULT_GAP_POLICY,
    minHistoryBars = MIN_HISTORY_BARS,
    minuteBars, minutesFinal = true, htfSource = null, minuteSource = null,
    dailyContext,
  } = input;
  const needs: MinuteRequest[] = [];

  const base: RuntimeState = state ?? {
    strategyId: STRATEGY_ID, strategyVersion: STRATEGY_VERSION,
    symbol: cfg.instrument, timeframe: cfg.timeframe,
    cursorBarTime: null, activatedAtBarTime: null,
    barsSeen: 0, bootstrapCount: 0,
  };

  if (closedBars.length < minHistoryBars) {
    return {
      bootstrapped: false, state: base, openPosition, closed: [], events: [],
      divergence: null, skipped: "INSUFFICIENT_HISTORY",
      minutesNeeded: [], provisional: false,
    };
  }

  const newest = closedBars[closedBars.length - 1];
  const events: PaperEvent[] = [];
  const closed: PaperResult[] = [];

  // ── manage first, from bars only ──────────────────────────────────────────
  const advance = (bootstrapped: boolean, divergence: string | null): RunnerPlan => ({
    bootstrapped, divergence, closed, events,
    openPosition: live,
    state: {
      ...base,
      cursorBarTime: newest.datetime,
      activatedAtBarTime: base.activatedAtBarTime ?? newest.datetime,
      barsSeen: closedBars.length,
      bootstrapCount: base.bootstrapCount + (bootstrapped ? 1 : 0),
    },
    skipped: null,
    minutesNeeded: needs,
    provisional: needs.length > 0,
  });

  /**
   * The cursor MUST NOT move on a provisional plan. Returning `base` unchanged
   * means the next run — the one with the tape — sees exactly the same bars.
   */
  const defer = (bootstrapped: boolean): RunnerPlan => ({
    bootstrapped, divergence: null, closed: [], events: [],
    openPosition, state: base, skipped: null,
    minutesNeeded: needs, provisional: true,
  });

  let live = openPosition;
  if (live) {
    const m = manage(live, closedBars, nowMs, barMs, gap, accountDecision,
      minuteBars, minutesFinal, needs);
    if (m.deferred) return defer(false);
    events.push(...m.events);
    if (m.result) closed.push(m.result);
    live = m.position;
  }

  // A suspended instrument is not a tradable one. No rebuild, no entries.
  if (live && live.status === "data_gap_suspended") return advance(false, null);

  // A stale feed means the recent bars are UNKNOWN, not that nothing happened.
  // Filling against the last price the provider happened to have would be an
  // entry at a price that may be days old.
  if (!live && ms(newest.datetime) + barMs + gap.staleAfterMs < nowMs) {
    return advance(false, null);
  }

  // ── activation: set the cursor, record nothing historical ─────────────────
  if (base.cursorBarTime === null) return advance(!input.warmEngine, null);

  // ── take the engine warm, or pay for a rebuild, then look past the cursor ──
  let engine = input.warmEngine;
  if (!engine) {
    engine = new IncrementalEngine(cfg);
    for (const b of closedBars) engine.feed(b);
  }
  const cursor = ms(base.cursorBarTime);

  // Consistency: whatever we still hold open, the engine must hold too, at the
  // same prices. Anything else means the paper record has stopped describing
  // the frozen strategy.
  if (live) {
    const et = engine.openTrade;
    const id = et ? identify(et, closedBars, cfg.timeframe) : null;
    // A CAUSAL OVERRIDE IS AN EXPECTED DISAGREEMENT, AND ONLY THIS ONE IS.
    //
    // The frozen engine reads whole-bar OHLC, so on a fill bar it can book a
    // target whose excursion happened before the entry. When the tape refuses
    // that exit the paper position legitimately outlives the engine's trade, and
    // from then on the two sequences differ: the engine's slot freed early and
    // it may already hold a later trade. That is the correction working, not
    // drift. It is permitted ONLY while the position carries the flag, which is
    // set at the moment of the override and persisted with the row.
    const overridden = live.engineExitOverridden === true;
    if (!et) {
      const engineClosed = engine.trades.find((t) =>
        identify(t, closedBars, cfg.timeframe).intentId === live!.intentId);
      if (engineClosed && !overridden) {
        return advance(!input.warmEngine,
          `engine closed ${live.intentId} at bar ${engineClosed.exitIndex} but the paper ` +
          `position is still open — contract and engine disagree on the exit`);
      }
    } else if (id!.intentId !== live.intentId) {
      if (!overridden) {
        return advance(!input.warmEngine,
          `engine holds ${id!.intentId} but paper holds ${live.intentId}`);
      }
    } else if (Math.abs(et.entry - live.entryPrice) > 1e-9 ||
               Math.abs(et.stop - live.s2InvalidationLevel) > 1e-9 ||
               Math.abs(et.target - live.targetPrice) > 1e-9) {
      return advance(!input.warmEngine, `engine and paper disagree on the levels of ${live.intentId}`);
    }
    return advance(!input.warmEngine, null);
  }

  // A run can cover many bars, so it can contain a trade that opened AND closed
  // plus a later one still running. Recording only the open one would silently
  // drop completed forward observations, and the next run's cursor would have
  // moved past them for good.
  const fresh = [...engine.trades, ...(engine.openTrade ? [engine.openTrade] : [])]
    .filter((t) => ms(closedBars[t.entryIndex].datetime) > cursor)
    .sort((a, b) => a.entryIndex - b.entryIndex);

  for (const t of fresh) {
    if (live) break;                      // one position per instrument
    const intent: PaperIntent = buildIntent(t, closedBars, cfg.timeframe, accountDecision,
      zoneTelemetry(t, engine, closedBars));
    events.push(ev("INTENT_CREATED", intent.symbol, intent.barTime,
      intent.strategyDecision, intent.accountDecision, intent.reasonCodes, {
        entry: intent.entryPrice, target: intent.targetPrice,
        s2: intent.s2InvalidationLevel, costR: intent.costR,
        volatilityBucket: intent.volatilityBucket,
        zoneEntryOrdinal: intent.zoneEntryOrdinal,
        zonePreviousExitTime: intent.zonePreviousExitTime,
      }, intent));

    if (intent.execution === "BLOCKED") {
      // The signal stays VALID. Only execution refused, and the audit row says so.
      events.push(ev("REFUSED", intent.symbol, intent.barTime,
        intent.strategyDecision, intent.accountDecision,
        [intent.blockReason!, ...intent.reasonCodes], {
          blockReason: intent.blockReason, costR: intent.costR,
          note: "IPO signal valid; execution blocked",
        }, intent));
      continue;
    }

    // Observational only. Recorded on the row and in the ledger event; nothing
    // above or below reads it, and a test asserts it cannot reach the verdict.
    const daily = dailyContext?.(intent.barTime, intent.direction) ?? null;
    const provenance: CausalProvenance = {
      ...NO_PROVENANCE,
      causalExecutionVersion: CAUSAL_EXECUTION_VERSION,
      htfSource, minuteSource,
      dailyStructure: daily?.structure ?? null,
      dailyStructureAlignment: daily?.alignment ?? null,
      dailyStructureAsOf: daily?.asOf ?? null,
    };
    const pos = openPaperPosition(intent, sizing, provenance);

    // The ENTRY BAR ITSELF can close the trade — the frozen engine calls
    // `manageOpen` on the same bar it fills — so it is resolved explicitly here.
    // `manage()` resumes from the bar AFTER `lastManagedBarTime`, which would
    // otherwise skip it and turn a same-bar loss into a phantom open position.
    //
    // THIS IS THE BAR THE CONTAMINATION LIVED ON. Nothing before the entry
    // instant may resolve it, so it is the one bar resolved with isEntryBar.
    const entryIdx = closedBars.findIndex((b) => b.datetime === intent.barTime);
    const entryBar = closedBars[entryIdx];
    const o = order(pos, entryBar, barMs, true, minuteBars, minutesFinal, needs);
    if (!o) return defer(!input.warmEngine);

    events.push(ev("FILLED", intent.symbol, intent.barTime,
      intent.strategyDecision, intent.accountDecision, [o.method], {
        entryPrice: pos.entryPrice, nominalRiskUsd: pos.nominalRiskUsd,
        referenceBalanceAtEntry: pos.referenceBalanceAtEntry,
        entryMinute: o.entryMinute, resolutionMethod: o.method,
        orderingDetail: o.detail, htfSource, minuteSource,
        causalExecutionVersion: CAUSAL_EXECUTION_VERSION,
        dailyStructure: daily?.structure ?? null,
        dailyStructureAlignment: daily?.alignment ?? null,
      }, intent));

    const priced = { ...pos, entryResolutionMethod: o.method };
    const entryStep = stepPosition(priced, entryBar, 0, o);
    const htfWould = htfWouldHaveClosed({
      direction: pos.direction, entryPrice: pos.entryPrice, targetPrice: pos.targetPrice,
      s2InvalidationLevel: pos.s2InvalidationLevel, bar: entryBar, barMs,
      isEntryBar: true, minutes: null,
    });

    if (entryStep.kind === "CLOSED") {
      const r = entryStep.result;
      const differs = htfWould !== null &&
        ((htfWould === "TARGET" && r.exitReason !== "TARGET_2R") ||
         (htfWould === "S2_CLOSE" && r.exitReason !== "S2_CLOSE_INVALIDATION"));
      closed.push({ ...r, htfWouldHaveBooked: differs ? htfWould : null });
      events.push(ev("CLOSED", intent.symbol, intent.barTime, "WOULD_EXIT", accountDecision,
        [r.exitReason, o.method], {
          exitPrice: r.exitPrice, realizedR: r.realizedR,
          sameBarAmbiguous: r.sameBarAmbiguous, onEntryBar: true,
          resolutionMethod: o.method, orderingDetail: o.detail,
          entryMinute: o.entryMinute, targetMinute: o.targetMinute,
          htfWouldHaveBooked: differs ? htfWould : null,
        }, intent));
      if (differs) {
        events.push(ev("CAUSAL_OVERRIDE", intent.symbol, intent.barTime, "WOULD_EXIT",
          accountDecision, ["CAUSAL_OVERRIDE", o.method], {
            engineWouldHaveBooked: htfWould, causalOutcome: r.exitReason,
            detail: o.detail, entryMinute: o.entryMinute, targetMinute: o.targetMinute,
          }, intent));
      }
      continue;
    }

    // The tape says the trade is still running where whole-bar OHLC said it had
    // already ended. The paper record now outlives the engine's trade, so the
    // disagreement is flagged on the row and the agreement check is told about it.
    let open = entryStep.position;
    if (htfWould !== null) {
      open = { ...open, engineExitOverridden: true, engineExitBarTime: entryBar.datetime };
      events.push(ev("CAUSAL_OVERRIDE", intent.symbol, intent.barTime, "HOLD",
        accountDecision, ["CAUSAL_OVERRIDE", o.method], {
          engineWouldHaveBooked: htfWould, causalOutcome: "STILL_OPEN",
          detail: o.detail, entryMinute: o.entryMinute,
          note: "whole-bar OHLC would have closed this on the entry bar; the tape " +
                "shows the excursion happened before the fill",
        }, intent));
    }

    const m = manage(open, closedBars.slice(entryIdx), nowMs, barMs, gap, accountDecision,
      minuteBars, minutesFinal, needs);
    if (m.deferred) return defer(!input.warmEngine);
    events.push(...m.events);
    if (m.result) closed.push(m.result);
    live = m.position;
  }

  return advance(!input.warmEngine, null);
}
