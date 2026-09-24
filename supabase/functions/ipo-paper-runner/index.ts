/**
 * IPO paper-trading WORKER. Phase D.
 *
 * PAPER ONLY, AND IPO-OWNED ONLY. It writes exactly three tables —
 * `ipo_paper_positions`, `ipo_paper_trade_history`, `ipo_execution_events` —
 * plus a runtime-state row in the generic `kv_cache`. It places no broker order
 * and touches no SMC table. A test asserts the file cannot even name
 * paper_positions, pending_orders, paper_trade_history, paper_accounts or
 * broker-execute.
 *
 * THIS IS THE ONLY PLACE THE BOOTSTRAP RUNS, AND IT IS NOT THE NORMAL PATH.
 * A scheduled invocation restores the persisted engine, fetches a short page
 * that must OVERLAP the last processed bar, appends only what is new, and
 * persists again. Rebuilding the engine over 1,200 bars happens only when there
 * is no state, the strategy or rule version moved, the cost model changed, the
 * checksum failed, bar continuity could not be proven, the bar ceiling was
 * reached, or an administrator asked for it with `?rebuild=1`. Every one of
 * those is reported as a named `rebuildReason` — a rebuild is never silent,
 * because it re-anchors the bar window and can therefore change decisions.
 *
 * No browser request ever takes either path: `ipo-paper-state` reads persisted
 * rows and nothing else.
 *
 * A DIVERGENT RUN WRITES NOTHING. If `runPaper` reports that the engine and the
 * paper record disagree, this function records the disagreement in the response
 * and commits no rows for that instrument. Writing "most of" a run whose
 * correctness is unknown would quietly corrupt the forward record that Phase D
 * exists to produce.
 *
 * WRITE ORDER IS DELIBERATE. Results and the vacated position land before the
 * new position (the one-open-per-instrument index would otherwise reject it),
 * and the runtime cursor is written LAST — so a crash mid-run replays the same
 * window, which the content-addressed keys make a no-op.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { fetchCandlesWithFallback } from "../_shared/candleSource.ts";
import { setCreditCallerContext } from "../_shared/apiCreditBudget.ts";
import { closedBarsOnly } from "../_shared/ipoObservation.ts";
import {
  runPaper,
  type PaperEvent, type RunnerPlan, type RuntimeState,
} from "../_shared/ipoPaperRunner.ts";
import {
  DEFAULT_SIZING, STRATEGY_ID, STRATEGY_VERSION,
  type PaperPosition, type PaperResult, type SizingConfig,
} from "../_shared/ipoPaperContract.ts";
import { CAUSAL_EXECUTION_VERSION } from "../_shared/ipoCausalOrdering.ts";
import { analyzeMarketStructure } from "../_shared/smcAnalysis.ts";
import {
  exportState, serializeState, restoreState, continuityCheck,
  type ExportMeta, type RebuildReason,
} from "../_shared/ipoEngineState.ts";
import { IncrementalEngine } from "../_shared/ipoIncrementalEngine.ts";
import {
  buildHealth, parseHealth, runnerHealthKey,
  type RunSummary,
} from "../_shared/ipoRunnerHealth.ts";
import {
  IPO_INSTRUMENTS, INCREMENTAL_BARS, engineStateKey,
} from "../_shared/ipoInstruments.ts";

// Re-exported so existing importers keep their names. HISTORY_BARS is
// deliberately NOT among them: this function no longer has a path that could
// use it, and re-exporting it would leave the bootstrap looking available here.
export { IPO_INSTRUMENTS as PAPER_INSTRUMENTS, INCREMENTAL_BARS, engineStateKey };
import type { Candle } from "../_shared/smcAnalysis.ts";

/** The frozen spec §1. Nothing else trades. */




export const stateKey = (symbol: string) => `ipo_paper_state:${STRATEGY_ID}:${symbol}`;

/**
 * Paper sizing, read from the environment so the risk policy stays outside the
 * strategy engine and can be changed without touching frozen code.
 */
export function sizingFromEnv(env: (k: string) => string | undefined): SizingConfig {
  const bal = Number(env("IPO_PAPER_REFERENCE_BALANCE"));
  const pct = Number(env("IPO_PAPER_NOMINAL_RISK_PCT"));
  return {
    referenceBalance: Number.isFinite(bal) && bal > 0 ? bal : DEFAULT_SIZING.referenceBalance,
    nominalRiskPct: Number.isFinite(pct) && pct > 0 ? pct : DEFAULT_SIZING.nominalRiskPct,
  };
}

// ─── row mapping ─────────────────────────────────────────────────────────────

export const positionRow = (p: PaperPosition, userId: string) => ({
  strategy_id: p.strategyId, strategy_version: p.strategyVersion,
  setup_id: p.setupId, intent_id: p.intentId, user_id: userId,
  symbol: p.symbol, timeframe: p.timeframe, direction: p.direction,
  entry_time: p.entryTime, entry_price: p.entryPrice,
  target_price: p.targetPrice, s2_invalidation_level: p.s2InvalidationLevel,
  nominal_risk_distance: p.nominalRiskDistance, cost_r: p.costR,
  reference_balance_at_entry: p.referenceBalanceAtEntry,
  nominal_risk_pct: p.nominalRiskPct, nominal_risk_usd: p.nominalRiskUsd,
  ipo_candle_time: p.ipoCandleTime, volatility_bucket: p.volatilityBucket,
  zone_entry_ordinal: p.zoneEntryOrdinal,
  zone_previous_exit_time: p.zonePreviousExitTime,
  execution_mode: p.executionMode, status: p.status,
  mae_r: p.maeR, mfe_r: p.mfeR, last_managed_bar_time: p.lastManagedBarTime,
  gap_from_bar_time: p.gapFromBarTime, gap_to_bar_time: p.gapToBarTime,
  gap_reason: p.gapReason, updated_at: new Date().toISOString(),
  // Causal-ordering provenance. See 20260924120000_ipo_causal_execution_ordering.
  causal_execution_version: p.causalExecutionVersion,
  entry_minute_time: p.entryMinuteTime,
  entry_resolution_method: p.entryResolutionMethod,
  htf_source: p.htfSource, minute_source: p.minuteSource,
  engine_exit_overridden: p.engineExitOverridden,
  engine_exit_bar_time: p.engineExitBarTime,
  daily_structure: p.dailyStructure,
  daily_structure_alignment: p.dailyStructureAlignment,
  daily_structure_as_of: p.dailyStructureAsOf,
});

export const historyRow = (r: PaperResult, userId: string) => {
  const p = r.position;
  return {
    strategy_id: p.strategyId, strategy_version: p.strategyVersion,
    setup_id: p.setupId, intent_id: p.intentId, user_id: userId,
    symbol: p.symbol, timeframe: p.timeframe, direction: p.direction,
    entry_time: p.entryTime, entry_price: p.entryPrice,
    target_price: p.targetPrice, s2_invalidation_level: p.s2InvalidationLevel,
    nominal_risk_distance: p.nominalRiskDistance, cost_r: p.costR,
    reference_balance_at_entry: p.referenceBalanceAtEntry,
    nominal_risk_pct: p.nominalRiskPct, nominal_risk_usd: p.nominalRiskUsd,
    exit_time: r.exitTime, exit_price: r.exitPrice, exit_reason: r.exitReason,
    realized_r: r.realizedR, gross_r: r.grossR, realized_pnl_usd: r.realizedPnlUsd,
    mae_r: r.maeR, mfe_r: r.mfeR, bars_held: r.barsHeld,
    same_bar_ambiguous: r.sameBarAmbiguous,
    excluded_from_stats: r.excludedFromStats, exclusion_reason: r.exclusionReason,
    gap_from_bar_time: p.gapFromBarTime, gap_to_bar_time: p.gapToBarTime,
    // Carried over from the position: a closed row cannot otherwise be
    // attributed to its zone or its regime.
    ipo_candle_time: p.ipoCandleTime, volatility_bucket: p.volatilityBucket,
    zone_entry_ordinal: p.zoneEntryOrdinal,
    zone_previous_exit_time: p.zonePreviousExitTime,
    causal_execution_version: r.causalExecutionVersion,
    entry_minute_time: r.entryMinuteTime,
    target_minute_time: r.targetMinuteTime,
    s2_close_bar_time: r.s2CloseBarTime,
    exit_resolution_method: r.exitResolutionMethod,
    htf_would_have_booked: r.htfWouldHaveBooked,
    htf_source: p.htfSource, minute_source: p.minuteSource,
    daily_structure: p.dailyStructure,
    daily_structure_alignment: p.dailyStructureAlignment,
    daily_structure_as_of: p.dailyStructureAsOf,
  };
};

export const eventRow = (e: PaperEvent, userId: string) => ({
  event_id: e.eventId, strategy_id: STRATEGY_ID,
  strategy_version: STRATEGY_VERSION,
  setup_id: e.setupId, intent_id: e.intentId, user_id: userId,
  symbol: e.symbol, bar_time: e.barTime, event_type: e.eventType,
  strategy_decision: e.strategyDecision, account_decision: e.accountDecision,
  reason_codes: e.reasonCodes, payload: e.payload,
});

// ─── state <-> kv_cache ──────────────────────────────────────────────────────

/**
 * Whether a kv_cache row is worth rewriting.
 *
 * WHY THIS IS NOT MERELY TIDY. The runner used to upsert both state rows on
 * every invocation. On a poll with no new bars that rewrote ~1 MB for nothing
 * and, worse, moved `updated_at` — so the column could no longer distinguish
 * "the strategy advanced" from "someone called the endpoint". An audit trail
 * that ticks when nothing happened is not an audit trail.
 *
 * The comparison is on CONTENT, not on a bar count. A run that processed bars
 * but somehow produced identical state genuinely has nothing to write, and a
 * run that processed none but differs somehow must still be written.
 */
export function needsWrite(previous: string | null | undefined, next: string): boolean {
  return previous !== next;
}

export function parseState(value: string | null): RuntimeState | null {
  if (!value) return null;
  try {
    const s = JSON.parse(value) as RuntimeState;
    return typeof s?.symbol === "string" ? s : null;
  } catch {
    // An unreadable state row is treated as absent: the next run re-activates
    // rather than guessing a cursor, which would replay or skip bars silently.
    return null;
  }
}

export function rowToPosition(r: Record<string, unknown> | null): PaperPosition | null {
  if (!r) return null;
  return {
    strategyId: r.strategy_id as string, strategyVersion: r.strategy_version as string,
    setupId: r.setup_id as string, intentId: r.intent_id as string,
    symbol: r.symbol as string, timeframe: r.timeframe as string,
    direction: r.direction as "long" | "short",
    entryTime: r.entry_time as string, entryPrice: Number(r.entry_price),
    targetPrice: Number(r.target_price), s2InvalidationLevel: Number(r.s2_invalidation_level),
    nominalRiskDistance: Number(r.nominal_risk_distance), costR: Number(r.cost_r),
    referenceBalanceAtEntry: Number(r.reference_balance_at_entry),
    nominalRiskPct: Number(r.nominal_risk_pct), nominalRiskUsd: Number(r.nominal_risk_usd),
    ipoCandleTime: r.ipo_candle_time as string, volatilityBucket: r.volatility_bucket as string,
    zoneEntryOrdinal: Number(r.zone_entry_ordinal ?? 1),
    zonePreviousExitTime: (r.zone_previous_exit_time as string) ?? null,
    executionMode: "paper", status: r.status as PaperPosition["status"],
    maeR: Number(r.mae_r), mfeR: Number(r.mfe_r),
    lastManagedBarTime: r.last_managed_bar_time as string,
    gapFromBarTime: (r.gap_from_bar_time as string) ?? null,
    gapToBarTime: (r.gap_to_bar_time as string) ?? null,
    gapReason: (r.gap_reason as string) ?? null,
    causalExecutionVersion: (r.causal_execution_version as string) ?? null,
    entryMinuteTime: (r.entry_minute_time as string) ?? null,
    entryResolutionMethod: (r.entry_resolution_method as PaperPosition["entryResolutionMethod"]) ?? null,
    htfSource: (r.htf_source as string) ?? null,
    minuteSource: (r.minute_source as string) ?? null,
    engineExitOverridden: r.engine_exit_overridden === true,
    engineExitBarTime: (r.engine_exit_bar_time as string) ?? null,
    dailyStructure: (r.daily_structure as string) ?? null,
    dailyStructureAlignment: (r.daily_structure_alignment as string) ?? null,
    dailyStructureAsOf: (r.daily_structure_as_of as string) ?? null,
  };
}

// ─── causal ordering support ─────────────────────────────────────────────────

/**
 * How far back a single 1-minute page can reach. A fifteen-minute cron normally
 * needs the last hour or two; anything older than this cannot be ordered from
 * minutes and becomes ORDERING_UNRESOLVED rather than a guess.
 *
 * (Written out in words on purpose: a slash-star sequence in a JSDoc block ends
 * the comment, and a cron expression has bitten this repo before.)
 */
export const MINUTE_PAGE_LIMIT = 1500;

/**
 * Observational Daily-structure tag for the forward candidate ledger.
 *
 * NOT A GATE. Experiment 3 refuted the HTF-opposed hypothesis on unseen data, so
 * no context filter is promoted. This only records what the existing SMC
 * structure read said at the moment of the fill, using ONLY daily candles that
 * had fully closed before the entry bar opened, so the tag is causal too.
 */
export function dailyStructureTagger(daily: Candle[] | null) {
  if (!daily || daily.length < 20) return null;
  const DAY_MS = 86_400_000;
  return (barTime: string, direction: "long" | "short") => {
    const t = new Date(barTime).getTime();
    const closed = daily.filter((b) => new Date(b.datetime).getTime() + DAY_MS <= t).slice(-300);
    if (closed.length < 20) {
      return { structure: "UNKNOWN", alignment: "UNKNOWN", asOf: null };
    }
    const trend = analyzeMarketStructure(closed).trend;
    const structure = trend === "bullish" ? "BULLISH" : trend === "bearish" ? "BEARISH" : "RANGING";
    const alignment = structure === "RANGING"
      ? "RANGING"
      : (direction === "long") === (structure === "BULLISH") ? "ALIGNED" : "OPPOSED";
    return { structure, alignment, asOf: closed[closed.length - 1].datetime };
  };
}

// ─── handler ─────────────────────────────────────────────────────────────────

export interface InstrumentRun {
  instrument: string;
  /** Bars the engine now holds. */
  bars: number;
  /** Bars actually processed this invocation. The warm path aims for a handful. */
  barsProcessed: number;
  /** Bars the provider was asked for. The whole point of the warm path. */
  barsFetched: number;
  bootstrapped: boolean;
  /** Why a rebuild happened, when one did. Never silent. */
  rebuildReason?: RebuildReason;
  rebuildDetail?: string;
  filled: number;
  refused: number;
  closed: number;
  events: number;
  statePayloadBytes?: number;
  /** False when the run changed nothing and the row was left alone. */
  engineStateWritten?: boolean;
  paperStateWritten?: boolean;
  restoreMs?: number;
  processMs?: number;
  persistMs?: number;
  divergence?: string;
  skipped?: string;
  error?: string;
  // ── causal ordering observability ──
  /** Bars whose ordering the HTF data could not settle. */
  minutesRequested?: number;
  minuteBarsFetched?: number;
  minuteFetchMs?: number;
  minuteSource?: string;
  minuteSkipReason?: string;
  dailySource?: string;
  dailySkipReason?: string;
  /** Outcomes voided because nothing could order them. */
  unresolved?: number;
  /** Exits the frozen engine would have booked and the tape refused. */
  causalOverrides?: number;
  provisional?: boolean;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    setCreditCallerContext("ipo-paper-runner");

    // The owner is explicit configuration, not discovered from SMC's account
    // list — reading that list would couple IPO to the tables it must not touch.
    const userId = Deno.env.get("IPO_PAPER_USER_ID");
    if (!userId) {
      return respond({ ok: false, error: "IPO_PAPER_USER_ID is not configured" }, 400);
    }

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const sizing = sizingFromEnv((k) => Deno.env.get(k));
    const url = new URL(req.url);
    const only = url.searchParams.get("instrument");
    // An explicit administrative re-anchor. Recorded like any other rebuild.
    const forceRebuild = url.searchParams.get("rebuild") === "1";
    const now = Date.now();
    const results: InstrumentRun[] = [];

    // Operational only. Collected alongside the run and written at the end,
    // whatever the outcome; nothing in the loop reads it.
    const summary: RunSummary = {
      strategyId: STRATEGY_ID, strategyVersion: STRATEGY_VERSION,
      startedAtMs: now, endedAtMs: now,
      instrumentsChecked: 0, barsProcessed: 0, eventsEmitted: 0,
      bootstrapRequired: [], divergent: [], errors: [],
    };

    for (const cfg of IPO_INSTRUMENTS) {
      if (only && only !== cfg.instrument) continue;
      const out: InstrumentRun = {
        instrument: cfg.instrument, bars: 0, barsProcessed: 0, barsFetched: 0,
        bootstrapped: false, filled: 0, refused: 0, closed: 0, events: 0,
      };
      try {
        const engineCfg = {
          instrument: cfg.instrument, timeframe: cfg.timeframe,
          highVolOnly: cfg.highVolOnly, costPerSide: cfg.costPerSide,
        };
        const meta: ExportMeta = {
          strategyVersion: STRATEGY_VERSION, costModelId: cfg.costModelId,
        };

        const [{ data: stateRow }, { data: engineRow }, { data: posRow }] = await Promise.all([
          db.from("kv_cache").select("value").eq("key", stateKey(cfg.instrument)).maybeSingle(),
          db.from("kv_cache").select("value").eq("key", engineStateKey(cfg.instrument)).maybeSingle(),
          db.from("ipo_paper_positions").select("*")
            .eq("strategy_id", STRATEGY_ID).eq("symbol", cfg.instrument)
            .in("status", ["open", "data_gap_suspended"]).maybeSingle(),
        ]);
        const state = parseState(stateRow?.value ?? null);
        const openPosition = rowToPosition(posRow ?? null);

        // ── warm path: restore, fetch a short overlapping page, append ────────
        let engine: IncrementalEngine | null = null;
        let bars: Candle[] = [];
        let rebuild: { reason: RebuildReason; detail: string } | null = null;
        let htfSource: string | null = null;

        const t0 = Date.now();
        const restored = forceRebuild
          ? { ok: false as const, reason: "ADMIN_REQUESTED" as RebuildReason, detail: "requested via ?rebuild=1" }
          : restoreState(engineRow?.value ?? null, engineCfg, meta);
        out.restoreMs = Date.now() - t0;

        if (restored.ok) {
          const { candles, source: htfSrc } = await fetchCandlesWithFallback({
            symbol: cfg.instrument, interval: cfg.timeframe, limit: INCREMENTAL_BARS,
            // READ-ONLY. candleSource otherwise writes a newly discovered symbol
            // mapping back to broker_connections, an SMC-owned table. This
            // function inherited the fetch from ipo-observation when runtime
            // ownership moved, and the opt-out has to move with it.
            persistSymbolOverrides: false,
          } as Parameters<typeof fetchCandlesWithFallback>[0]);
          out.barsFetched = candles?.length ?? 0;
          htfSource = htfSrc ?? null;
          const page = closedBarsOnly((candles ?? []) as Candle[], now, cfg.barMs);
          const cont = continuityCheck(restored.state, page);
          if (cont.ok) {
            engine = restored.engine;
            const p0 = Date.now();
            for (const b of cont.append) engine.feed(b);
            out.processMs = Date.now() - p0;
            out.barsProcessed = cont.append.length;
            bars = engine.snapshot().bars;
          } else {
            rebuild = { reason: cont.reason, detail: cont.detail };
          }
        } else {
          rebuild = { reason: restored.reason, detail: restored.detail };
        }

        // ── no cold path. FAIL CLOSED. ───────────────────────────────────────
        // A 1,200-bar rebuild costs ~17s of CPU and an Edge Function has a few;
        // ipo-observation proved that empirically with WORKER_RESOURCE_LIMIT on
        // a single instrument. Falling back to a rebuild here would fail the
        // same way, intermittently, after spending provider credits. The
        // bootstrap belongs to local-runner/ipo-bootstrap.ts.
        if (!engine) {
          out.skipped = "BOOTSTRAP_REQUIRED";
          out.rebuildReason = rebuild!.reason;
          out.rebuildDetail = rebuild!.detail;
          results.push(out);
          continue;
        }

        out.bars = bars.length;

        // The tape lives here, not inside the branch: the Daily-tag re-plan below
        // must be given IDENTICAL inputs, and an earlier version of this code
        // dropped the minutes on that third pass — which would have re-decided
        // the very bars the second pass had just resolved.
        let minuteBars: Candle[] = [];
        let minuteSource: string | null = null;

        // ── PASS 1: plan without a tape ──────────────────────────────────────
        // Most runs resolve entirely from the HTF bars: a bar that reaches
        // neither the target nor an S2 close, or reaches exactly one of them
        // after the fill, is unambiguous and costs nothing extra.
        const baseInput = {
          cfg: engineCfg, barMs: cfg.barMs, closedBars: bars, nowMs: now,
          state, openPosition, sizing, warmEngine: engine, htfSource,
        };
        // minutesFinal FALSE: this pass is allowed to ask for a tape.
        let plan: RunnerPlan = runPaper({ ...baseInput, minutesFinal: false });

        // ── PASS 2: fetch the minutes the plan asked for, then decide ────────
        // A provisional plan is NEVER written. Either the tape arrives and the
        // run is re-planned against it, or the affected bar is recorded
        // ORDERING_UNRESOLVED — no silent fall back to whole-bar OHLC.
        if (plan.provisional) {
          out.minutesRequested = plan.minutesNeeded.length;
          try {
            const earliest = Math.min(...plan.minutesNeeded.map((m) => m.fromMs));
            const spanMinutes = Math.ceil((now - earliest) / 60_000) + 5;
            if (spanMinutes > 0 && spanMinutes <= MINUTE_PAGE_LIMIT) {
              const m0 = Date.now();
              const res = await fetchCandlesWithFallback({
                symbol: cfg.instrument, interval: "1min", limit: spanMinutes,
                persistSymbolOverrides: false,
              } as Parameters<typeof fetchCandlesWithFallback>[0]);
              minuteBars = (res.candles ?? []) as Candle[];
              minuteSource = res.source ?? null;
              out.minuteBarsFetched = minuteBars.length;
              out.minuteFetchMs = Date.now() - m0;
            } else {
              out.minuteSkipReason = `span ${spanMinutes} minutes exceeds the single-page reach`;
            }
          } catch (me) {
            out.minuteSkipReason = `1m fetch failed: ${(me as Error).message}`;
          }
          out.minuteSource = minuteSource ?? undefined;

          // Only bars the tape actually covers can be ordered from it. Anything
          // still ambiguous after this pass is voided, not assumed.
          plan = runPaper({ ...baseInput, minuteBars, minuteSource, minutesFinal: true });
        } else {
          // Nothing needed a tape, so the run is already final.
          plan = runPaper({ ...baseInput, minutesFinal: true });
        }

        // The candidate ledger's Daily tag. Fetched only when a fill happened,
        // so an idle poll costs nothing. Failure is non-fatal and leaves the tag
        // null — an observational column must never be able to stop a run.
        if (plan.events.some((e) => e.eventType === "FILLED")) {
          try {
            const d = await fetchCandlesWithFallback({
              symbol: cfg.instrument, interval: "1d", limit: 300,
              persistSymbolOverrides: false,
            } as Parameters<typeof fetchCandlesWithFallback>[0]);
            const tagger = dailyStructureTagger((d.candles ?? []) as Candle[]);
            if (tagger) {
              out.dailySource = d.source ?? undefined;
              // Same inputs as the pass that produced `plan`, plus the tag. The
              // only field that may differ in the result is the observational
              // Daily column.
              plan = runPaper({
                ...baseInput, minuteBars, minuteSource, minutesFinal: true,
                dailyContext: tagger,
              });
            }
          } catch (de) {
            out.dailySkipReason = `daily fetch failed: ${(de as Error).message}`;
          }
        }

        out.provisional = plan.provisional;
        out.unresolved = plan.closed.filter((r) => r.exitReason === "ORDERING_UNRESOLVED").length;
        out.causalOverrides = plan.events.filter((e) => e.eventType === "CAUSAL_OVERRIDE").length;
        out.filled = plan.events.filter((e) => e.eventType === "FILLED").length;
        out.refused = plan.events.filter((e) => e.eventType === "REFUSED").length;
        out.closed = plan.closed.length;
        out.events = plan.events.length;

        if (plan.provisional) {
          // Unreachable by construction — pass 2 always sets minutesFinal — but
          // writing a plan whose ordering is unsettled is the one outcome this
          // whole change exists to prevent, so it is refused explicitly.
          out.skipped = "ORDERING_INCOMPLETE";
          results.push(out);
          continue;
        }

        if (plan.divergence) {
          // Nothing is written — not the rows, and not the engine state either.
          // Persisting an engine whose conclusions we have just refused would
          // carry the disagreement forward instead of stopping at it.
          out.divergence = plan.divergence;
          results.push(out);
          continue;
        }

        const engineState = exportState(engine, engineCfg, meta);
        const serialized = serializeState(engineState);
        out.statePayloadBytes = serialized.length;

        const w0 = Date.now();
        const applied = await applyPlan(db, plan, openPosition, userId, cfg.instrument,
          serialized, { engine: engineRow?.value ?? null, cursor: stateRow?.value ?? null });
        out.persistMs = Date.now() - w0;
        out.engineStateWritten = applied.engineWritten;
        out.paperStateWritten = applied.cursorWritten;
        results.push(out);
      } catch (e) {
        out.error = (e as Error).message;
        summary.errors.push({ instrument: cfg.instrument, message: out.error });
        results.push(out);
      } finally {
        summary.instrumentsChecked++;
        summary.barsProcessed += out.barsProcessed ?? 0;
        summary.eventsEmitted += out.events ?? 0;
        if (out.skipped === "BOOTSTRAP_REQUIRED") summary.bootstrapRequired.push(cfg.instrument);
        if (out.divergence) summary.divergent.push(cfg.instrument);
      }
    }

    await writeHeartbeat(db, summary);

    return respond({
      ok: true,
      mode: "PAPER_ONLY",
      note: "No broker execution. IPO-owned tables only. realized_r is canonical; " +
            "realized_pnl_usd is a view of it under the configured nominal sizing.",
      sizing, results,
    });
  } catch (e) {
    // A crash here would otherwise be indistinguishable from a quiet no-op,
    // which is the ambiguity the heartbeat exists to remove. Best effort: if
    // even this fails there is nothing further to try.
    try {
      const db = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } },
      );
      const t0 = Date.now();
      await writeHeartbeat(db, {
        strategyId: STRATEGY_ID, strategyVersion: STRATEGY_VERSION,
        startedAtMs: t0, endedAtMs: t0,
        instrumentsChecked: 0, barsProcessed: 0, eventsEmitted: 0,
        bootstrapRequired: [], divergent: [], errors: [],
        fatal: { code: "RUNNER_FATAL", message: (e as Error).message },
      });
    } catch { /* the run already failed; do not mask it with a second error */ }
    return respond({ ok: false, error: (e as Error).message }, 500);
  }
}

/**
 * Writes the heartbeat. NEVER throws.
 *
 * A failure to record health is an observability problem, not a trading one:
 * the strategy work is already done and committed by this point. Letting it
 * propagate would turn a monitoring hiccup into a failed run — and then into a
 * retry that re-derives decisions for no reason.
 */
async function writeHeartbeat(
  // deno-lint-ignore no-explicit-any
  db: any, summary: RunSummary,
): Promise<void> {
  try {
    summary.endedAtMs = Date.now();
    const key = runnerHealthKey(summary.strategyId);
    const { data } = await db.from("kv_cache").select("value").eq("key", key).maybeSingle();
    const next = buildHealth(summary, parseHealth(data?.value));
    await db.from("kv_cache").upsert({
      key,
      value: JSON.stringify(next),
      // Far future on purpose: kv-cache-cleanup-hourly deletes expired rows,
      // and a swept heartbeat reads as "never ran" — the exact false alarm
      // this record exists to prevent.
      expires_at: new Date(Date.now() + 365 * 24 * 3_600_000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" });
  } catch (e) {
    console.warn(`[ipo-paper-runner] heartbeat write failed: ${(e as Error).message}`);
  }
}

/**
 * Commits one instrument's plan.
 *
 * Every write is idempotent on a content-addressed key, so a retry after a
 * partial failure converges instead of duplicating.
 */
interface PriorRows {
  /** The engine-state payload as it was read at the start of this run. */
  engine: string | null;
  /** The paper-cursor payload as it was read at the start of this run. */
  cursor: string | null;
}

interface ApplyResult {
  engineWritten: boolean;
  cursorWritten: boolean;
}

async function applyPlan(
  // deno-lint-ignore no-explicit-any
  db: any, plan: RunnerPlan, before: PaperPosition | null,
  userId: string, symbol: string, engineState: string, prior: PriorRows,
): Promise<ApplyResult> {
  for (const r of plan.closed) {
    const { error } = await db.from("ipo_paper_trade_history")
      .upsert(historyRow(r, userId), { onConflict: "intent_id" });
    if (error) throw new Error(`history insert failed: ${error.message}`);
    // The slot must be vacated before a new position can claim it.
    await db.from("ipo_paper_positions").delete().eq("intent_id", r.position.intentId);
  }

  if (plan.openPosition) {
    const { error } = await db.from("ipo_paper_positions")
      .upsert(positionRow(plan.openPosition, userId), { onConflict: "intent_id" });
    if (error) throw new Error(`position upsert failed: ${error.message}`);
  } else if (before && !plan.closed.length) {
    await db.from("ipo_paper_positions").delete().eq("intent_id", before.intentId);
  }

  if (plan.events.length) {
    const { error } = await db.from("ipo_execution_events")
      .upsert(plan.events.map((e) => eventRow(e, userId)), { onConflict: "event_id" });
    if (error) throw new Error(`event insert failed: ${error.message}`);
  }

  // ENGINE STATE, then the paper cursor, in that order.
  //
  // The engine payload is one row and one statement, so it is atomic at the row
  // level: a reader sees the old complete state or the new one. It also carries
  // its own checksum, so a torn or truncated value is rejected on restore and
  // becomes a rebuild rather than a wrong continuation.
  //
  // The two rows are NOT written in one transaction, and the order is chosen so
  // that the surviving failure is the benign one. Crash between them and the
  // next run has an engine ahead of the cursor: it re-derives decisions for bars
  // the cursor has not yet passed, and every write is keyed by content, so the
  // replay is a no-op. The reverse order would advance the cursor past bars the
  // engine had not recorded, and those setups would be lost silently.
  //
  // NEITHER IS WRITTEN IF IT DID NOT CHANGE. See `needsWrite`.
  const engineWritten = needsWrite(prior.engine, engineState);
  if (engineWritten) {
    const eng = await db.from("kv_cache").upsert({
      key: engineStateKey(symbol),
      value: engineState,
      expires_at: new Date(Date.now() + 365 * 24 * 3_600_000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" });
    if (eng.error) throw new Error(`engine state write failed: ${eng.error.message}`);
  }

  const cursorValue = JSON.stringify(plan.state);
  const cursorWritten = needsWrite(prior.cursor, cursorValue);
  if (cursorWritten) {
    const { error } = await db.from("kv_cache").upsert({
      key: stateKey(symbol),
      value: cursorValue,
      expires_at: new Date(Date.now() + 365 * 24 * 3_600_000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" });
    if (error) throw new Error(`cursor write failed: ${error.message}`);
  }

  return { engineWritten, cursorWritten };
}

if (import.meta.main) Deno.serve(handler);
