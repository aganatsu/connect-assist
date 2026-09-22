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
  DEFAULT_SIZING, STRATEGY_ID, STRATEGY_VERSION,
  type AccountDecision, type PaperIntent, type PaperPosition,
  type PaperResult, type SizingConfig, type ZoneTelemetry,
} from "./ipoPaperContract.ts";
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
  | "GAP_SUSPENDED" | "GAP_RECOVERED" | "GAP_ABORTED";

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
}

const ms = (t: string) => new Date(t).getTime();

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
function manage(
  pos: PaperPosition, bars: Candle[], nowMs: number, barMs: number, policy: GapPolicy,
  acct: AccountDecision,
): { position: PaperPosition | null; result: PaperResult | null; events: PaperEvent[] } {
  const events: PaperEvent[] = [];
  const newest = bars[bars.length - 1];
  const covered = bars.some((b) => b.datetime === pos.lastManagedBarTime);
  const stale = ms(newest.datetime) + barMs + policy.staleAfterMs < nowMs;

  if (!covered || stale) {
    const reason = !covered ? "COVERAGE_LOST" : "FEED_STALE";
    if (pos.status !== "data_gap_suspended") {
      const suspended = suspendForGap(pos, pos.lastManagedBarTime, newest.datetime, reason);
      events.push(ev("GAP_SUSPENDED", pos.symbol, newest.datetime, "HOLD", acct, [reason], {
        gapFrom: pos.lastManagedBarTime, gapTo: newest.datetime,
      }, pos));
      return { position: suspended, result: null, events };
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
      return { position: null, result, events };
    }
    return { position: pos, result: null, events };
  }

  let live = pos;
  if (live.status === "data_gap_suspended") {
    live = resumeFromGap(live);
    events.push(ev("GAP_RECOVERED", live.symbol, newest.datetime, "HOLD", acct, ["GAP_RECOVERED"], {
      resumedFrom: pos.gapFromBarTime, resumedTo: pos.gapToBarTime,
    }, live));
  }

  const start = bars.findIndex((b) => b.datetime === live.lastManagedBarTime) + 1;
  let held = 0;
  for (let i = start; i < bars.length; i++) {
    held++;
    const out = stepPosition(live, bars[i], held);
    if (out.kind === "CLOSED") {
      events.push(ev("CLOSED", live.symbol, bars[i].datetime, "WOULD_EXIT", acct,
        [out.result.exitReason], {
          exitPrice: out.result.exitPrice, realizedR: out.result.realizedR,
          realizedPnlUsd: out.result.realizedPnlUsd,
          sameBarAmbiguous: out.result.sameBarAmbiguous,
        }, live));
      return { position: null, result: out.result, events };
    }
    live = out.position;
  }

  if (held > 0) {
    events.push(ev("MANAGED", live.symbol, live.lastManagedBarTime, "HOLD", acct, [], {
      barsAdvanced: held, maeR: live.maeR, mfeR: live.mfeR,
    }, live));
  }
  return { position: live, result: null, events };
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
  } = input;

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
    };
  }

  const newest = closedBars[closedBars.length - 1];
  const events: PaperEvent[] = [];
  const closed: PaperResult[] = [];

  // ── manage first, from bars only ──────────────────────────────────────────
  let live = openPosition;
  if (live) {
    const m = manage(live, closedBars, nowMs, barMs, gap, accountDecision);
    events.push(...m.events);
    if (m.result) closed.push(m.result);
    live = m.position;
  }

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
  });

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
    if (!et) {
      const engineClosed = engine.trades.find((t) =>
        identify(t, closedBars, cfg.timeframe).intentId === live!.intentId);
      if (engineClosed) {
        return advance(!input.warmEngine,
          `engine closed ${live.intentId} at bar ${engineClosed.exitIndex} but the paper ` +
          `position is still open — contract and engine disagree on the exit`);
      }
    } else if (id!.intentId !== live.intentId) {
      return advance(!input.warmEngine,
        `engine holds ${id!.intentId} but paper holds ${live.intentId}`);
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

    const pos = openPaperPosition(intent, sizing);
    events.push(ev("FILLED", intent.symbol, intent.barTime,
      intent.strategyDecision, intent.accountDecision, [], {
        entryPrice: pos.entryPrice, nominalRiskUsd: pos.nominalRiskUsd,
        referenceBalanceAtEntry: pos.referenceBalanceAtEntry,
      }, intent));

    // The ENTRY BAR ITSELF can close the trade — the frozen engine calls
    // `manageOpen` on the same bar it fills — so it is stepped explicitly here.
    // `manage()` resumes from the bar AFTER `lastManagedBarTime`, which would
    // otherwise skip it and turn a same-bar loss into a phantom open position.
    const entryIdx = closedBars.findIndex((b) => b.datetime === intent.barTime);
    const sameBar = stepPosition(pos, closedBars[entryIdx], 0);
    if (sameBar.kind === "CLOSED") {
      closed.push(sameBar.result);
      events.push(ev("CLOSED", intent.symbol, intent.barTime, "WOULD_EXIT", accountDecision,
        [sameBar.result.exitReason], {
          exitPrice: sameBar.result.exitPrice, realizedR: sameBar.result.realizedR,
          sameBarAmbiguous: sameBar.result.sameBarAmbiguous, onEntryBar: true,
        }, intent));
      continue;
    }

    const m = manage(sameBar.position, closedBars.slice(entryIdx), nowMs, barMs, gap, accountDecision);
    events.push(...m.events);
    if (m.result) closed.push(m.result);
    live = m.position;
  }

  return advance(!input.warmEngine, null);
}
