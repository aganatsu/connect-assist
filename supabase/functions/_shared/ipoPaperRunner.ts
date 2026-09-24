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
  buildIntent, openPosition as openPaperPosition, openAmbiguous, altTargetNetR, stepPosition,
  suspendForGap, resumeFromGap, abortForGap,
  eventId, setupId, intentId,
  DEFAULT_SIZING, STRATEGY_ID, STRATEGY_VERSION, NO_PROVENANCE,
  type AccountDecision, type AmbiguityState, type CausalProvenance, type PaperIntent,
  type PaperPosition, type PaperResult, type SizingConfig, type ZoneTelemetry,
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
  /**
   * Bar from which this instrument's forward trade SEQUENCE became conditional
   * on an unresolvable branch. Null while the sequence is provable. Once set it
   * stays set: every later trade's existence depends on which branch was real.
   */
  sequenceContaminatedFrom?: string | null;
  /** How many ambiguities actually forked the sequence. Operational. */
  orderingForks?: number;
}

export type PaperEventType =
  | "SETUP_VALID" | "INTENT_CREATED" | "FILLED" | "REFUSED" | "MANAGED" | "CLOSED"
  | "GAP_SUSPENDED" | "GAP_RECOVERED" | "GAP_ABORTED"
  /**
   * A fill whose own ordering cannot be established, where one viable branch
   * leaves the position OPEN. The slot stays held; nothing is concluded.
   */
  | "ORDERING_AMBIGUOUS"
  /** An ambiguity ended — converged on one outcome, or diverged with no R. */
  | "AMBIGUITY_RESOLVED"
  /**
   * The branches freed the position slot on different bars and a candidate
   * existed in between, so this instrument's later trades are conditional on
   * which branch was real.
   */
  | "SEQUENCE_FORKED"
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
  // `minutesFinal` goes to the RESOLVER, not to a conversion here: whether an
  // unorderable bar becomes a terminal void or a still-open ambiguity depends on
  // whether a branch can leave the position running, and only the resolver knows
  // that. An earlier version decided it here and collapsed both into a close.
  const o = resolveBar({
    direction: pos.direction, entryPrice: pos.entryPrice,
    targetPrice: pos.targetPrice, s2InvalidationLevel: pos.s2InvalidationLevel,
    bar, barMs, isEntryBar, minutes: minutes ?? null, ticks: null, minutesFinal,
  });
  if (o.kind !== "NEED_MINUTES") return o;
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
    // An ambiguous position that went through a gap comes back ambiguous. A
    // plain resume would silently promote it to "open" and free the reasoning
    // that keeps the slot held.
    live = resumeFromGap(live);
    if (live.ambiguity) live = { ...live, status: "ordering_ambiguous" };
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
      if (live.ambiguity) {
        events.push(ev("AMBIGUITY_RESOLVED", live.symbol, bars[i].datetime, "WOULD_EXIT", acct,
          [out.result.ambiguityResolution ?? "UNKNOWN", live.ambiguity.kind], {
            branchOutcomes: out.result.branchOutcomes,
            openBranchExit: bars[i].datetime,
            altBranchFreedAt: live.ambiguity.altFreedAtBarTime,
            realizedR: out.result.realizedR,
            exitTimeAmbiguous: out.result.exitTimeAmbiguous,
            detail: live.ambiguity.detail,
          }, live));
      }
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
  /**
   * Ambiguities that ENDED this run, with the bar each branch freed the slot on.
   * A fork is decided from these once the engine is available.
   */
  const settled: Array<{ exitBarTime: string; altFreedAtBarTime: string; kind: string }> = [];

  const base: RuntimeState = state ?? {
    strategyId: STRATEGY_ID, strategyVersion: STRATEGY_VERSION,
    symbol: cfg.instrument, timeframe: cfg.timeframe,
    cursorBarTime: null, activatedAtBarTime: null,
    barsSeen: 0, bootstrapCount: 0,
    sequenceContaminatedFrom: null, orderingForks: 0,
  };
  let contaminatedFrom = base.sequenceContaminatedFrom ?? null;
  let forks = base.orderingForks ?? 0;

  /**
   * Did an ended ambiguity actually fork the future?
   *
   * The two branches free the slot on the bars recorded here. If that is the
   * SAME bar, both futures are flat at the same moment having seen the same
   * bars, so they re-converge and nothing downstream is conditional.
   *
   * If it is a different bar, the branches were free to trade at different
   * times. `engineTook` refines that: the frozen engine's own trajectory IS the
   * alternative branch — it books the whole-bar target and frees early — so if
   * it took no trade in the gap, both branches are again flat at the same bar
   * and the futures re-converge. Only when it did take one is the fork real.
   *
   * With no engine available the conservative answer is kept: a fork.
   */
  const forked = (
    e: { exitBarTime: string; altFreedAtBarTime: string },
    engineTook: ((fromExclusive: string, toInclusive: string) => boolean) | null,
  ): boolean => {
    if (ms(e.altFreedAtBarTime) === ms(e.exitBarTime)) return false;
    if (!engineTook) return true;
    return engineTook(e.altFreedAtBarTime, e.exitBarTime);
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
  /**
   * Set once the engine exists. Until then fork decisions stay conservative.
   */
  let engineTookRef: ((fromExclusive: string, toInclusive: string) => boolean) | null = null;

  /**
   * Settles every ambiguity that ended this run. Idempotent: drains `settled`,
   * so it can be called from the fork block AND again at plan time, which is
   * what covers an ambiguity that both opened and ended in the same run.
   */
  const settleForks = () => {
    while (settled.length) {
      const e = settled.shift()!;
      if (!forked(e, engineTookRef)) {
        events.push(ev("AMBIGUITY_RESOLVED", cfg.instrument, e.exitBarTime, "HOLD",
          accountDecision, ["SEQUENCE_CONVERGED", e.kind], {
            altBranchFreedAt: e.altFreedAtBarTime, openBranchExit: e.exitBarTime,
            note: "both branches are flat at the same bar having seen the same bars, " +
                  "so the futures re-converge and nothing downstream is conditional",
          }));
        continue;
      }
      forks++;
      contaminatedFrom ??= e.exitBarTime;
      events.push(ev("SEQUENCE_FORKED", cfg.instrument, e.exitBarTime, "HOLD",
        accountDecision, ["SEQUENCE_FORKED", e.kind], {
          altBranchFreedAt: e.altFreedAtBarTime, openBranchExit: e.exitBarTime,
          contaminatedFrom,
          note: "the branches freed the slot on different bars and a candidate existed " +
                "in between, so every later trade on this instrument is conditional on " +
                "which branch was real",
        }));
    }
  };

  const advance = (bootstrapped: boolean, divergence: string | null): RunnerPlan => {
    settleForks();
    return ({
    bootstrapped, divergence, closed, events,
    openPosition: live,
    state: {
      ...base,
      cursorBarTime: newest.datetime,
      activatedAtBarTime: base.activatedAtBarTime ?? newest.datetime,
      barsSeen: closedBars.length,
      bootstrapCount: base.bootstrapCount + (bootstrapped ? 1 : 0),
      sequenceContaminatedFrom: contaminatedFrom,
      orderingForks: forks,
    },
    skipped: null,
    minutesNeeded: needs,
    provisional: needs.length > 0,
  });
  };

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
    const wasAmbiguous = live.ambiguity;
    const m = manage(live, closedBars, nowMs, barMs, gap, accountDecision,
      minuteBars, minutesFinal, needs);
    if (m.deferred) return defer(false);
    events.push(...m.events);
    if (m.result) {
      closed.push(m.result);
      if (wasAmbiguous) {
        settled.push({ exitBarTime: m.result.exitTime,
          altFreedAtBarTime: wasAmbiguous.altFreedAtBarTime, kind: wasAmbiguous.kind });
      }
    }
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

  // The engine's own trajectory IS the alternative branch — it books the
  // whole-bar target and frees the slot early — so it is exactly what decides
  // whether a fork is real or the futures re-converge.
  engineTookRef = (fromExclusive: string, toInclusive: string): boolean =>
    [...engine!.trades, ...(engine!.openTrade ? [engine!.openTrade] : [])].some((t) => {
      const at = ms(closedBars[t.entryIndex]?.datetime ?? "");
      return at > ms(fromExclusive) && at <= ms(toInclusive);
    });
  settleForks();

  // Consistency: whatever we still hold open, the engine must hold too, at the
  // same prices. Anything else means the paper record has stopped describing
  // the frozen strategy.
  if (live) {
    const et = engine.openTrade;
    const openId = et ? identify(et, closedBars, cfg.timeframe) : null;
    // The engine's view of THIS trade, open or already closed.
    const known = (openId?.intentId === live.intentId ? et : null) ??
      engine.trades.find((t) => identify(t, closedBars, cfg.timeframe).intentId === live!.intentId) ??
      null;

    // LEVELS ARE CHECKED UNCONDITIONALLY. A causal override excuses a
    // disagreement about the EXIT; it never excuses a disagreement about the
    // price, the stop or the target. An earlier draft returned early on the
    // override and skipped this, which silently disarmed the guard.
    if (known && (Math.abs(known.entry - live.entryPrice) > 1e-9 ||
                  Math.abs(known.stop - live.s2InvalidationLevel) > 1e-9 ||
                  Math.abs(known.target - live.targetPrice) > 1e-9)) {
      return advance(!input.warmEngine, `engine and paper disagree on the levels of ${live.intentId}`);
    }

    // A CAUSAL OVERRIDE IS AN EXPECTED DISAGREEMENT, AND ONLY THIS ONE IS.
    //
    // The frozen engine reads whole-bar OHLC, so on a fill bar it can book a
    // target whose excursion happened before the entry. When the tape refuses
    // that exit — or cannot order it at all, leaving a branch open — the paper
    // position legitimately outlives the engine's trade, and from then on the
    // two sequences differ: the engine's slot freed early and it may already
    // hold a later trade. That is the correction working, not drift. It is
    // permitted ONLY while the position says so.
    const overridden = live.engineExitOverridden === true || live.ambiguity !== null;
    if (!overridden) {
      if (!et) {
        if (known) {
          return advance(!input.warmEngine,
            `engine closed ${live.intentId} at bar ${known.exitIndex} but the paper ` +
            `position is still open — contract and engine disagree on the exit`);
        }
      } else if (openId!.intentId !== live.intentId) {
        return advance(!input.warmEngine,
          `engine holds ${openId!.intentId} but paper holds ${live.intentId}`);
      }
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

  /**
   * The bar the paper layer last vacated the slot on.
   *
   * THE FROZEN SEQUENCING RULE IS `touchIndex > previousExitIndex`, and the
   * paper layer used to get it for free: its exits matched the engine's, so a
   * candidate the engine offered could never overlap a paper position. Causal
   * ordering breaks that — paper can hold a position the engine released — and a
   * multi-bar run would then open the engine's next candidate even though its
   * entry bar falls INSIDE the window paper was still holding. Enforced here
   * directly rather than inherited.
   */
  let lastExit = closed.reduce((a, r) => Math.max(a, ms(r.exitTime)), -Infinity);

  for (const t of fresh) {
    if (live) break;                      // one position per instrument
    if (ms(closedBars[t.entryIndex].datetime) <= lastExit) {
      // Its entry bar is not strictly after the bar this instrument last
      // exited on, so under the frozen rule it does not exist.
      continue;
    }
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
    const pos0 = openPaperPosition(intent, sizing, provenance);
    // Once an ambiguity has forked this instrument's sequence, every later
    // trade's EXISTENCE is conditional on which branch was real. Its own
    // outcome is still measured; it is kept out of the validated population.
    const pos = contaminatedFrom ? { ...pos0, sequenceContaminated: true } : pos0;

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

    // ── the fill itself could not be ordered, and a branch leaves it OPEN ────
    //
    // Both branches are carried. The open one becomes the live position — it is
    // simply an open position — and the other is frozen beside it. The slot is
    // NOT freed, because a branch in which the position is still running is a
    // branch in which no later IPO on this instrument exists.
    if (o.kind === "AMBIGUOUS_OPEN_OR_CLOSED") {
      const closedAtTarget = o.altBranch === "CLOSED_AT_TARGET";
      const ambiguity: AmbiguityState = {
        kind: o.altBranch === "NO_POSITION"
          ? "ENTRY_NOT_PROVEN_IN_TAPE"
          : o.entryMinute
            ? "ENTRY_VS_TARGET_SAME_MINUTE"
            : "ENTRY_BAR_TARGET_TOUCH_NO_TAPE",
        atTime: o.entryMinute ?? entryBar.datetime,
        altBranch: o.altBranch!,
        altExitTime: closedAtTarget ? entryBar.datetime : null,
        altExitPrice: closedAtTarget ? priced.targetPrice : null,
        altNetR: closedAtTarget ? altTargetNetR(priced) : null,
        // Both alternatives leave the slot free from the fill bar onward: the
        // target branch closed there, and the no-position branch never took it.
        altFreedAtBarTime: entryBar.datetime,
        detail: o.detail,
      };
      const ambiguous = openAmbiguous({ ...priced, entryMinuteTime: o.entryMinute ?? null }, ambiguity);
      events.push(ev("ORDERING_AMBIGUOUS", intent.symbol, intent.barTime, "HOLD",
        accountDecision, ["ORDERING_UNRESOLVED_OPEN_OR_CLOSED", ambiguity.kind], {
          altBranch: ambiguity.altBranch, altExitTime: ambiguity.altExitTime,
          altNetR: ambiguity.altNetR, entryMinute: o.entryMinute,
          detail: o.detail,
          note: "the position slot stays HELD — one branch still has this trade running",
        }, intent));
      const m0 = manage(ambiguous, closedBars.slice(entryIdx), nowMs, barMs, gap,
        accountDecision, minuteBars, minutesFinal, needs);
      if (m0.deferred) return defer(!input.warmEngine);
      events.push(...m0.events);
      if (m0.result) {
        closed.push(m0.result);
        lastExit = Math.max(lastExit, ms(m0.result.exitTime));
        settled.push({ exitBarTime: m0.result.exitTime,
          altFreedAtBarTime: ambiguity.altFreedAtBarTime, kind: ambiguity.kind });
      }
      live = m0.position;
      continue;
    }

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
      lastExit = Math.max(lastExit, ms(r.exitTime));
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
    if (m.result) {
      closed.push(m.result);
      lastExit = Math.max(lastExit, ms(m.result.exitTime));
    }
    live = m.position;
  }

  return advance(!input.warmEngine, null);
}
