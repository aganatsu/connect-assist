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
import {
  causalReport, legacySummary, isValidatedCausalForwardTrade,
  CAUSAL_EXECUTION_VERSION, FORWARD_CAUSAL_START,
  type CausalReport, type LegacySummary,
} from "../_shared/ipoCausalEvidence.ts";

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
 * The forward-evidence boundary.
 *
 * Rows recorded before the causal-ordering fix could book a same-bar target
 * whose excursion happened BEFORE the entry, so their outcomes are not
 * trustworthy. They are NOT deleted and NOT rewritten — they are separated, and
 * the default population is the causally ordered one. Pooling the two would
 * launder the contamination straight back into the headline number.
 */
export interface EvidenceSplit {
  /** The default population: rows produced by the corrected runner. */
  causal: CleanSummary;
  /** Pre-fix forward rows. Visible, labelled, and never averaged with the above. */
  legacy: CleanSummary;
  causalExecutionVersion: string;
  legacyTrades: number;
  /** Closed with no outcome because nothing could order the events. */
  unresolvedExcluded: number;
  forwardCausalStart: string;
  /**
   * Rows whose OUTCOME is known but whose EXISTENCE is conditional: an earlier
   * ambiguity on that instrument freed the slot at different bars on different
   * branches, so whether this trade happened at all depends on which was real.
   * Kept out of `causal` and reported separately rather than quietly averaged.
   */
  sequenceContaminated: CleanSummary;
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

/**
 * Splits closed results on the forward-evidence boundary.
 *
 * Pure and exported so the separation is testable without a database, and so no
 * future reader has to remember that a NULL version column means contaminated.
 */
export function splitEvidence(
  rows: Array<{
    realized_r: number | null; realized_pnl_usd: number | null;
    excluded_from_stats: boolean; exit_reason?: string | null;
    entry_time?: string | null;
    causal_execution_version?: string | null;
    sequence_contaminated?: boolean | null;
  }>,
): EvidenceSplit {
  // ONE admission rule, shared with every other statistic on the dashboard.
  const causal = rows.filter((r) => isValidatedCausalForwardTrade(r));
  const contaminated = rows.filter((r) =>
    r.causal_execution_version === CAUSAL_EXECUTION_VERSION && r.sequence_contaminated === true);
  const legacyRows = rows.filter((r) => r.causal_execution_version !== CAUSAL_EXECUTION_VERSION);
  return {
    causal: summarize(causal),
    legacy: summarize(legacyRows),
    causalExecutionVersion: CAUSAL_EXECUTION_VERSION,
    forwardCausalStart: FORWARD_CAUSAL_START,
    legacyTrades: legacyRows.length,
    unresolvedExcluded: rows.filter((r) => r.exit_reason === "ORDERING_UNRESOLVED").length,
    sequenceContaminated: summarize(contaminated),
  };
}

/** Lifetime counts by event type. Exported so the tally rule is testable. */
export function tallyEvents(rows: Array<{ event_type: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.event_type] = (out[r.event_type] ?? 0) + 1;
  return out;
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
    // THE CAUSAL POPULATION IS FETCHED SEPARATELY, AND UNCAPPED BY THE DISPLAY
    // LIMIT. `recentTrades` is a feed and is truncated at 100; a headline
    // computed off a truncated feed would silently stop being the whole
    // population the day the hundred-and-first trade closed.
    let causal = db.from("ipo_paper_trade_history")
      .select("*")
      .eq("causal_execution_version", CAUSAL_EXECUTION_VERSION)
      .order("exit_time", { ascending: true });
    // Lifetime event counts, not the recent window: the quality section is about
    // everything that has happened, not the last two hundred rows.
    let eventTally = db.from("ipo_execution_events")
      .select("event_type")
      .gte("bar_time", FORWARD_CAUSAL_START);
    if (only) {
      positions = positions.eq("symbol", only);
      history = history.eq("symbol", only);
      events = events.eq("symbol", only);
      causal = causal.eq("symbol", only);
      eventTally = eventTally.eq("symbol", only);
    }

    const [p, h, e, s, hb, cz, et] = await Promise.all([
      positions, history, events,
      db.from("kv_cache").select("key, value, updated_at").like("key", "ipo_paper_state:%"),
      // The heartbeat is a small dedicated row. The ENGINE state rows are ~330KB
      // each and are deliberately not fetched: a monitoring view has no business
      // pulling a megabyte of bar history, and the paper cursor below already
      // says where each instrument has got to.
      db.from("kv_cache").select("value, updated_at").like("key", "ipo_runner_health:%"),
      causal, eventTally,
    ]);

    const err = p.error ?? h.error ?? e.error ?? s.error ?? cz.error ?? et.error;
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
      // Unchanged in meaning: every clean row, legacy and causal together. Kept
      // so no existing reader silently changes what it is showing.
      summary: summarize((h.data ?? []) as Parameters<typeof summarize>[0]),
      // The boundary. `evidence.causal` is the population any forward
      // performance claim should be made from.
      evidence: splitEvidence((h.data ?? []) as Parameters<typeof splitEvidence>[0]),
      // THE DEFAULT DASHBOARD POPULATION, computed once, here, from the one
      // admission rule — so the headline, the profit factor, the drawdown and
      // every split reconcile by construction rather than by six frontend
      // filters happening to agree.
      causal: causalReport(
        (cz.data ?? []) as Parameters<typeof causalReport>[0],
        (p.data ?? []) as Parameters<typeof causalReport>[1],
        tallyEvents((et.data ?? []) as Array<{ event_type: string }>),
      ),
      // Kept visible, never merged. Pre-fix and not causally ordered.
      legacy: legacySummary((h.data ?? []) as Parameters<typeof legacySummary>[0]),
      // The full causal rows, for the audit list. Small by construction.
      causalTrades: cz.data ?? [],
    });
  } catch (e) {
    return respond({ ok: false, error: (e as Error).message }, 500);
  }
}

if (import.meta.main) Deno.serve(handler);
