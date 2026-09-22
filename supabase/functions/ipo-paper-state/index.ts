/**
 * IPO paper state. Phase D. READ-ONLY, and deliberately dumb.
 *
 * Returns persisted rows: the runtime cursor, open paper positions, recent
 * results, recent audit events, and a summary. It runs no engine, fetches no
 * candles, and writes nothing — the bootstrap lives in `ipo-paper-runner`, and
 * putting a 1,200-bar rebuild behind a browser poll is exactly the failure this
 * split exists to prevent.
 *
 * DATA-GAP ABORTS ARE EXCLUDED FROM THE SUMMARY AT SOURCE. `excluded_from_stats`
 * is a stored column, and the clean statistics filter on it rather than trusting
 * every future reader to remember. Aborted rows are still RETURNED, under their
 * own count, because a hidden failure is worse than a visible one.
 *
 * R IS THE HEADLINE. `realized_r` is the strategy result; the dollar figures are
 * a view of it under the nominal sizing recorded on each row, and are labelled
 * as such so nobody reads $200 as a maximum possible loss.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { parseHealth, isStale } from "../_shared/ipoRunnerHealth.ts";

/** Enough to render a panel without paging; not a research export. */
export const RECENT_TRADES = 100;

/**
 * The scheduled cadence, for staleness only.
 *
 * Mirrors the every-15-minutes cron in
 * supabase/cron/ipo_paper_runner_cron.sql. Display concern only: nothing here
 * schedules anything, and a wrong value would mis-colour a badge rather than
 * change behaviour. (The cron expression is not quoted here because a slash-star
 * sequence would end this comment.)
 */
export const CADENCE_MS = 15 * 60_000;
export const RECENT_EVENTS = 200;

export interface CleanSummary {
  trades: number;
  wins: number;
  winRate: number;
  totalR: number;
  expectancyR: number;
  totalPnlUsd: number;
  /** Counted, never averaged in: these have no strategy outcome. */
  abortedExcluded: number;
}

/**
 * Summarises closed results.
 *
 * Exported and pure so the exclusion rule is testable without a database.
 */
export function summarize(
  rows: Array<{ realized_r: number | null; realized_pnl_usd: number | null; excluded_from_stats: boolean }>,
): CleanSummary {
  const clean = rows.filter((r) => !r.excluded_from_stats && r.realized_r !== null);
  const totalR = clean.reduce((a, r) => a + (r.realized_r as number), 0);
  const wins = clean.filter((r) => (r.realized_r as number) > 0).length;
  return {
    trades: clean.length,
    wins,
    winRate: clean.length ? wins / clean.length : 0,
    totalR,
    expectancyR: clean.length ? totalR / clean.length : 0,
    totalPnlUsd: clean.reduce((a, r) => a + (r.realized_pnl_usd ?? 0), 0),
    abortedExcluded: rows.length - clean.length,
  };
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const url = new URL(req.url);
    const only = url.searchParams.get("instrument");

    let positions = db.from("ipo_paper_positions")
      .select("*").order("entry_time", { ascending: false });
    let history = db.from("ipo_paper_trade_history")
      .select("*").order("exit_time", { ascending: false }).limit(RECENT_TRADES);
    let events = db.from("ipo_execution_events")
      .select("*").order("bar_time", { ascending: false }).limit(RECENT_EVENTS);
    if (only) {
      positions = positions.eq("symbol", only);
      history = history.eq("symbol", only);
      events = events.eq("symbol", only);
    }

    const [p, h, e, s, hb] = await Promise.all([
      positions, history, events,
      db.from("kv_cache").select("key, value, updated_at").like("key", "ipo_paper_state:%"),
      // The heartbeat is a small dedicated row. The ENGINE state rows are ~330KB
      // each and are deliberately not fetched: a monitoring view has no business
      // pulling a megabyte of bar history, and the paper cursor below already
      // says where each instrument has got to.
      db.from("kv_cache").select("value, updated_at").like("key", "ipo_runner_health:%"),
    ]);

    const err = p.error ?? h.error ?? e.error ?? s.error;
    if (err) return respond({ ok: false, error: err.message }, 500);

    const runtime = (s.data ?? []).map((r: { key: string; value: string; updated_at: string }) => {
      try { return { ...JSON.parse(r.value), lastRunAt: r.updated_at }; }
      catch { return { key: r.key, unreadable: true, lastRunAt: r.updated_at }; }
    });

    const health = parseHealth((hb.data ?? [])[0]?.value ?? null);

    return respond({
      ok: true,
      mode: "PAPER_READ_ONLY",
      // Operational, not strategy. `stale` is the question a human actually
      // asks — "is this thing still running" — and it cannot be answered from
      // the strategy tables, because a healthy quiet run writes nothing to them.
      health,
      healthStale: isStale(health, Date.now(), CADENCE_MS),
      cadenceMs: CADENCE_MS,
      note: "Persisted rows only — no engine run, no candle fetch, no writes. " +
            "realized_r is canonical; USD figures are a view under the recorded " +
            "nominal sizing and are NOT a maximum loss.",
      runtime,
      openPositions: p.data ?? [],
      recentTrades: h.data ?? [],
      recentEvents: e.data ?? [],
      summary: summarize((h.data ?? []) as Parameters<typeof summarize>[0]),
    });
  } catch (e) {
    return respond({ ok: false, error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);
