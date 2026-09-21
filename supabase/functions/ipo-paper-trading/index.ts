/**
 * IPO forward/PAPER trading runner.
 *
 * PAPER ONLY. This function places no orders, touches no broker, and writes to
 * no position or trade table. Its entire output is rows in `ipo_paper_ledger`.
 * A test asserts it cannot reach broker-execute, paper_positions or any
 * execution helper — that guarantee is structural, not a promise in a comment.
 *
 * WHY A SEPARATE FUNCTION rather than an addition to `paper-trading`. The
 * existing paper path serves the live bot and is 1,800 lines of behaviour that
 * has nothing to do with this candidate. Adding a second strategy inside it
 * would put an unproven system on the same code path as a working one for no
 * benefit. This function is isolated and deletable.
 *
 * STATELESS AND IDEMPOTENT. Each run re-fetches recent history and replays it
 * from scratch through the frozen engine, then upserts on the natural key
 * (instrument, bar_time, ipo_candle_time). Engine state is never persisted:
 * persisted state drifts from the rules that produced it, and a replay that
 * cannot be reproduced from candles cannot be audited. The cost is recomputation
 * the machine does not notice.
 *
 * IT DECIDES NOTHING. Instruments, gates, entry, stop, target and costs all come
 * from the frozen spec below and from `ipoLiveEngine`. If a number here
 * disagrees with docs/IPO_FORWARD_TRADING_SPEC.md, this file is wrong.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { fetchCandlesWithFallback } from "../_shared/candleSource.ts";
import { setCreditCallerContext } from "../_shared/apiCreditBudget.ts";
import { LiveEngine, episodesFor } from "../_shared/ipoLiveEngine.ts";
import { runLifecycle } from "../_shared/ipoLifecycle.ts";
import { fvgsNear } from "../_shared/ipoZones.ts";
import { excursions, type LedgerRow } from "../_shared/ipoForwardLedger.ts";
import type { Candle } from "../_shared/smcAnalysis.ts";

/** The frozen spec, §1. Nothing else trades. */
export const PAPER_INSTRUMENTS = [
  { instrument: "EUR/USD", timeframe: "1h",    highVolOnly: false, costPerSide: (_p: number) => 0.00008 },
  { instrument: "USD/JPY", timeframe: "30min", highVolOnly: false, costPerSide: (_p: number) => 0.008 },
  { instrument: "BTC/USD", timeframe: "1h",    highVolOnly: true,  costPerSide: (p: number) => p * 0.0015 },
] as const;

/**
 * Bars of history per run.
 *
 * BTC needs >= MIN_REFERENCE (200) closed bars before the volatility bucket
 * resolves at all, and the lifecycle needs room before that for contractions to
 * form and clear. 1,200 is comfortably past both and still one provider page.
 */
export const HISTORY_BARS = 1200;

export interface PaperRunResult {
  instrument: string;
  bars: number;
  candidates: number;
  filled: number;
  refused: number;
  written: number;
  error?: string;
}

/**
 * Replays one instrument and produces ledger rows.
 *
 * Exported so the equivalence tests can drive it on fixture candles without a
 * network or a database.
 */
export function buildRows(
  s: Candle[],
  cfg: { instrument: string; timeframe: string; highVolOnly: boolean; costPerSide: (p: number) => number },
): LedgerRow[] {
  const engine = new LiveEngine(cfg);
  const rows: LedgerRow[] = [];
  const eps = episodesFor(s);

  for (let k = 0; k < s.length; k++) {
    const events = engine.feed(s[k]);
    for (const ev of events) {
      if (ev.kind === "NO_CANDIDATE") continue;

      // The originating IPO for this bar, re-read from the frozen lifecycle on
      // the prefix so the ledger records what the engine actually saw.
      const prefix = s.slice(0, k + 1);
      const life = runLifecycle(prefix, episodesFor(prefix))
        .filter((x) => x.validAt !== null && x.hasFvg);
      const src = ev.kind === "REFUSED"
        ? life.find((x) => x.touches.includes(k))
        : life.find((x) => x.candidateIndex === ev.trade.ipoIndex);
      if (!src) continue;

      const long = src.direction === "demand";
      let fvgTs: string | null = null;
      for (let j = src.candidateIndex; j <= Math.min(s.length - 1, src.candidateIndex + 10) && !fvgTs; j++) {
        for (const g of fvgsNear(prefix, j) as Array<{ type: string; absIndex: number }>) {
          if (g.type === (long ? "bullish" : "bearish") &&
              g.absIndex >= src.candidateIndex && g.absIndex <= src.candidateIndex + 10) {
            fvgTs = s[g.absIndex].datetime; break;
          }
        }
      }

      const base: LedgerRow = {
        timestamp: s[k].datetime,
        instrument: cfg.instrument,
        timeframe: cfg.timeframe,
        direction: long ? "long" : "short",
        ipoCandleTimestamp: s[src.candidateIndex].datetime,
        ipoZoneLow: src.zoneLow,
        ipoZoneHigh: src.zoneHigh,
        entryLevel: long ? src.zoneLow : src.zoneHigh,
        invalidationLevel: src.invalidationLevel,
        targetPrice: null,
        fvgPresent: true,
        fvgTimestamp: fvgTs,
        volatilityBucket: ev.kind === "REFUSED" ? ev.vol : "UNCLASSIFIED",
        contractionState: eps.some((e) => k >= e.start && k <= e.end)
          ? "INSIDE_CONTRACTION" : "OUTSIDE_CONTRACTION",
        lifecycleState: src.invalidatedAt !== null && k >= src.invalidatedAt
          ? "VALID_INVALIDATED" : "VALID_LIVE",
        filled: false, noFillReason: null, fillPrice: null,
        exitTimestamp: null, exitPrice: null, exitReason: "NOT_FILLED",
        realizedR: null, mae: null, mfe: null,
      };

      if (ev.kind === "REFUSED") { rows.push({ ...base, noFillReason: ev.reason }); continue; }
      if (ev.kind === "ENTERED") {
        const t = ev.trade;
        rows.push({
          ...base, volatilityBucket: t.vol, targetPrice: t.target,
          filled: true, fillPrice: t.entry, timestamp: s[t.entryIndex].datetime,
          // OPEN until an exit event completes this row. A position still open
          // at the end of history stays OPEN — it must never read as unfilled.
          exitReason: "OPEN",
        });
        continue;
      }
      // EXITED — complete the row opened at entry.
      const t = ev.trade;
      const ex = excursions(s, t.entryIndex, t.exitIndex ?? k, t.entry, t.risk, long);
      const open = rows.find((r) =>
        r.filled && r.timestamp === s[t.entryIndex].datetime &&
        r.ipoCandleTimestamp === s[t.ipoIndex].datetime);
      if (open) {
        open.exitTimestamp = s[t.exitIndex ?? k].datetime;
        open.exitPrice = t.exitPrice;
        open.exitReason = (t.netR ?? 0) > 0 ? "TARGET_2R" : "S2_CLOSE_INVALIDATION";
        open.realizedR = t.netR;
        open.mae = ex.mae; open.mfe = ex.mfe;
      }
    }
  }
  return rows;
}

const toDb = (r: LedgerRow) => ({
  instrument: r.instrument, timeframe: r.timeframe,
  bar_time: r.timestamp, ipo_candle_time: r.ipoCandleTimestamp,
  direction: r.direction, ipo_zone_low: r.ipoZoneLow, ipo_zone_high: r.ipoZoneHigh,
  entry_level: r.entryLevel, invalidation_level: r.invalidationLevel,
  target_price: r.targetPrice, fvg_present: r.fvgPresent, fvg_time: r.fvgTimestamp,
  volatility_bucket: r.volatilityBucket, contraction_state: r.contractionState,
  lifecycle_state: r.lifecycleState, filled: r.filled, no_fill_reason: r.noFillReason,
  fill_price: r.fillPrice, exit_time: r.exitTimestamp, exit_price: r.exitPrice,
  exit_reason: r.exitReason, realized_r: r.realizedR, mae: r.mae, mfe: r.mfe,
});

/**
 * The HTTP handler, exported so tests can exercise it without starting a server.
 * `Deno.serve` is called only when this file is the entry point — importing the
 * module must never bind a port.
 */
export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    setCreditCallerContext("ipo-paper-trading");
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const results: PaperRunResult[] = [];
    for (const cfg of PAPER_INSTRUMENTS) {
      try {
        const { candles } = await fetchCandlesWithFallback({
          symbol: cfg.instrument, interval: cfg.timeframe, limit: HISTORY_BARS,
        } as Parameters<typeof fetchCandlesWithFallback>[0]);

        if (!candles || candles.length < 250) {
          results.push({ instrument: cfg.instrument, bars: candles?.length ?? 0,
            candidates: 0, filled: 0, refused: 0, written: 0,
            error: "insufficient history for the volatility warmup" });
          continue;
        }

        const rows = buildRows(candles as Candle[], cfg);
        // Idempotent: a re-run of the same history rewrites the same rows.
        const { error } = rows.length
          ? await db.from("ipo_paper_ledger")
              .upsert(rows.map(toDb), { onConflict: "instrument,bar_time,ipo_candle_time" })
          : { error: null };

        results.push({
          instrument: cfg.instrument, bars: candles.length, candidates: rows.length,
          filled: rows.filter((r) => r.filled).length,
          refused: rows.filter((r) => !r.filled).length,
          written: error ? 0 : rows.length,
          error: error?.message,
        });
      } catch (e) {
        results.push({ instrument: cfg.instrument, bars: 0, candidates: 0, filled: 0,
          refused: 0, written: 0, error: (e as Error).message });
      }
    }

    return respond({
      ok: true,
      mode: "PAPER_ONLY",
      note: "No broker execution. Ledger rows only. See docs/IPO_FORWARD_TRADING_SPEC.md.",
      results,
    });
  } catch (e) {
    return respond({ ok: false, error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);
