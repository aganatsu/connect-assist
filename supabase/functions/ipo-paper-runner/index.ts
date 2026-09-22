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
import {
  exportState, serializeState, restoreState, continuityCheck,
  type ExportMeta, type RebuildReason,
} from "../_shared/ipoEngineState.ts";
import { IncrementalEngine } from "../_shared/ipoIncrementalEngine.ts";
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
  execution_mode: p.executionMode, status: p.status,
  mae_r: p.maeR, mfe_r: p.mfeR, last_managed_bar_time: p.lastManagedBarTime,
  gap_from_bar_time: p.gapFromBarTime, gap_to_bar_time: p.gapToBarTime,
  gap_reason: p.gapReason, updated_at: new Date().toISOString(),
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
    executionMode: "paper", status: r.status as PaperPosition["status"],
    maeR: Number(r.mae_r), mfeR: Number(r.mfe_r),
    lastManagedBarTime: r.last_managed_bar_time as string,
    gapFromBarTime: (r.gap_from_bar_time as string) ?? null,
    gapToBarTime: (r.gap_to_bar_time as string) ?? null,
    gapReason: (r.gap_reason as string) ?? null,
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
  restoreMs?: number;
  processMs?: number;
  persistMs?: number;
  divergence?: string;
  skipped?: string;
  error?: string;
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

        const t0 = Date.now();
        const restored = forceRebuild
          ? { ok: false as const, reason: "ADMIN_REQUESTED" as RebuildReason, detail: "requested via ?rebuild=1" }
          : restoreState(engineRow?.value ?? null, engineCfg, meta);
        out.restoreMs = Date.now() - t0;

        if (restored.ok) {
          const { candles } = await fetchCandlesWithFallback({
            symbol: cfg.instrument, interval: cfg.timeframe, limit: INCREMENTAL_BARS,
            // READ-ONLY. candleSource otherwise writes a newly discovered symbol
            // mapping back to broker_connections, an SMC-owned table. This
            // function inherited the fetch from ipo-observation when runtime
            // ownership moved, and the opt-out has to move with it.
            persistSymbolOverrides: false,
          } as Parameters<typeof fetchCandlesWithFallback>[0]);
          out.barsFetched = candles?.length ?? 0;
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

        const plan: RunnerPlan = runPaper({
          cfg: engineCfg, barMs: cfg.barMs, closedBars: bars, nowMs: now,
          state, openPosition, sizing, warmEngine: engine,
        });

        out.filled = plan.events.filter((e) => e.eventType === "FILLED").length;
        out.refused = plan.events.filter((e) => e.eventType === "REFUSED").length;
        out.closed = plan.closed.length;
        out.events = plan.events.length;

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
        await applyPlan(db, plan, openPosition, userId, cfg.instrument, serialized);
        out.persistMs = Date.now() - w0;
        results.push(out);
      } catch (e) {
        out.error = (e as Error).message;
        results.push(out);
      }
    }

    return respond({
      ok: true,
      mode: "PAPER_ONLY",
      note: "No broker execution. IPO-owned tables only. realized_r is canonical; " +
            "realized_pnl_usd is a view of it under the configured nominal sizing.",
      sizing, results,
    });
  } catch (e) {
    return respond({ ok: false, error: (e as Error).message }, 500);
  }
}

/**
 * Commits one instrument's plan.
 *
 * Every write is idempotent on a content-addressed key, so a retry after a
 * partial failure converges instead of duplicating.
 */
async function applyPlan(
  // deno-lint-ignore no-explicit-any
  db: any, plan: RunnerPlan, before: PaperPosition | null,
  userId: string, symbol: string, engineState: string,
): Promise<void> {
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
  const eng = await db.from("kv_cache").upsert({
    key: engineStateKey(symbol),
    value: engineState,
    expires_at: new Date(Date.now() + 365 * 24 * 3_600_000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" });
  if (eng.error) throw new Error(`engine state write failed: ${eng.error.message}`);

  const { error } = await db.from("kv_cache").upsert({
    key: stateKey(symbol),
    value: JSON.stringify(plan.state),
    expires_at: new Date(Date.now() + 365 * 24 * 3_600_000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" });
  if (error) throw new Error(`cursor write failed: ${error.message}`);
}

if (import.meta.main) Deno.serve(handler);
