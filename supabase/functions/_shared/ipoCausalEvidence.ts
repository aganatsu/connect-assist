/**
 * The canonical IPO forward-evidence population, and every statistic drawn from
 * it. PURE — no database, no network, no clock, no imports beyond the ordering
 * module's version constant.
 *
 * WHY ONE MODULE. Before the causal-ordering fix the paper dashboard pooled
 * pre-fix and post-fix trades into a single headline: 11 closed, +12.91R, ~82%
 * win. Those pre-fix rows could book a same-bar target whose excursion happened
 * BEFORE the entry, so that headline was not a measurement of the strategy. The
 * cure is not to delete them — nothing here deletes, rewrites or relabels a
 * single stored row — it is to make one definition of "trustworthy" and use it
 * for every number on the screen.
 *
 * THE FAILURE THIS PREVENTS is subtler than a wrong total: a filter written
 * slightly differently in six cards. The instrument split excludes contaminated
 * rows, the drawdown card forgets to, and two figures that should reconcile
 * quietly do not. So `isValidatedCausalForwardTrade` is the ONLY admission rule,
 * and headline, profit factor, expectancy, drawdown, instrument, direction and
 * Daily-structure splits are all computed from the same filtered array.
 *
 * NOTHING HERE IS A STRATEGY DECISION. No trade is refused, no filter is
 * applied to execution, and the Daily-structure tag is reported without
 * preference — Experiment 3 refuted the HTF-opposed hypothesis on unseen data,
 * so neither side of it is "good".
 */

import { CAUSAL_EXECUTION_VERSION } from "./ipoCausalOrdering.ts";

export { CAUSAL_EXECUTION_VERSION };

/**
 * The instant the corrected runner went live, UTC.
 *
 * Migration 20260924120000 applied 17:30:47Z; `ipo-paper-runner` and
 * `ipo-paper-state` were both deployed by this moment, from commit a67b5099.
 * Recorded here as data rather than prose so the dashboard and the tests agree
 * on it by construction.
 */
export const FORWARD_CAUSAL_START = "2026-09-24T17:36:19Z";
export const DEPLOYED_STRATEGY_COMMIT = "a67b5099";

/** Monitoring landmarks. NOT thresholds: nothing is "validated" at any of them. */
export const SAMPLE_MILESTONES = [25, 50, 100, 200] as const;
/** Below this the sample is called out on screen rather than quietly averaged. */
export const SMALL_SAMPLE_BELOW = 25;

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes — structural, so a Postgres row passes without a mapping layer
// ─────────────────────────────────────────────────────────────────────────────

export interface HistoryRowLike {
  symbol?: string | null;
  direction?: string | null;
  entry_time?: string | null;
  exit_time?: string | null;
  exit_reason?: string | null;
  realized_r?: number | string | null;
  realized_pnl_usd?: number | string | null;
  excluded_from_stats?: boolean | null;
  causal_execution_version?: string | null;
  sequence_contaminated?: boolean | null;
  exit_resolution_method?: string | null;
  daily_structure_alignment?: string | null;
  ambiguity_kind?: string | null;
}

export interface PositionRowLike {
  symbol?: string | null;
  status?: string | null;
  entry_time?: string | null;
  causal_execution_version?: string | null;
  ambiguity_kind?: string | null;
  sequence_contaminated?: boolean | null;
}

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);
const ms = (t: string | null | undefined): number =>
  t ? Date.parse(t) : Number.NaN;

// ─────────────────────────────────────────────────────────────────────────────
// THE canonical admission rule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this closed trade part of the validated causal forward population?
 *
 * All four conditions, and no card may apply a different set:
 *
 *   1. produced by the corrected ordering model
 *   2. ENTERED at or after the boundary — a position that filled before the fix
 *      was resolved under the old model even if it exited after it, so its own
 *      fill bar is still untrustworthy
 *   3. not excluded at source (data-gap abort, unorderable outcome)
 *   4. not sequence-contaminated — its OUTCOME is known but its EXISTENCE is
 *      conditional on which branch of an earlier ambiguity was real
 *
 * Condition 1 very nearly implies condition 2, because only the corrected runner
 * stamps the version. Both are checked anyway: the boundary is the thing being
 * claimed, and it should not rest on an implication.
 */
export function isValidatedCausalForwardTrade(
  r: HistoryRowLike,
  boundary: string = FORWARD_CAUSAL_START,
  version: string = CAUSAL_EXECUTION_VERSION,
): boolean {
  if (r.causal_execution_version !== version) return false;
  const entered = ms(r.entry_time);
  if (!Number.isFinite(entered) || entered < ms(boundary)) return false;
  if (r.excluded_from_stats === true) return false;
  if (r.sequence_contaminated === true) return false;
  return num(r.realized_r) !== null;
}

/** Everything recorded before the boundary, or without the corrected version. */
export function isLegacyForwardTrade(
  r: HistoryRowLike,
  boundary: string = FORWARD_CAUSAL_START,
  version: string = CAUSAL_EXECUTION_VERSION,
): boolean {
  return r.causal_execution_version !== version || ms(r.entry_time) < ms(boundary);
}

// ─────────────────────────────────────────────────────────────────────────────
// Statistics
// ─────────────────────────────────────────────────────────────────────────────

export interface Perf {
  trades: number;
  wins: number;
  losses: number;
  /** Fraction 0..1, or null when there are no trades to take a rate over. */
  winRate: number | null;
  netR: number;
  pnlUsd: number;
  /** Net R per resolved trade, after the strategy's own stored costs. */
  expectancyR: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  grossWinR: number;
  grossLossR: number;
  /** Null when it cannot be computed; `pfNote` says which case. */
  profitFactor: number | null;
  pfNote: "NO_TRADES" | "NO_LOSSES" | null;
  maxDrawdownR: number;
  longestWinStreak: number;
  longestLossStreak: number;
}

export const EMPTY_PERF: Perf = {
  trades: 0, wins: 0, losses: 0, winRate: null, netR: 0, pnlUsd: 0,
  expectancyR: null, avgWinR: null, avgLossR: null,
  grossWinR: 0, grossLossR: 0, profitFactor: null, pfNote: "NO_TRADES",
  maxDrawdownR: 0, longestWinStreak: 0, longestLossStreak: 0,
};

/**
 * Summarises an already-admitted population.
 *
 * ORDER MATTERS AND IS THE CALLER'S JOB. Drawdown and streaks are path
 * statistics: they are computed over the array as given, so the caller must sort
 * by exit time first. `causalReport` does.
 */
export function perf(rows: readonly HistoryRowLike[]): Perf {
  const rs = rows.map((r) => num(r.realized_r)).filter((v): v is number => v !== null);
  if (rs.length === 0) return { ...EMPTY_PERF };

  const wins = rs.filter((x) => x > 0);
  const losses = rs.filter((x) => x < 0);
  const grossWinR = wins.reduce((a, x) => a + x, 0);
  const grossLossR = Math.abs(losses.reduce((a, x) => a + x, 0));
  const netR = rs.reduce((a, x) => a + x, 0);
  const pnlUsd = rows.reduce((a, r) => a + (num(r.realized_pnl_usd) ?? 0), 0);

  let peak = 0, cum = 0, maxDD = 0;
  let ws = 0, ls = 0, bw = 0, bl = 0;
  for (const x of rs) {
    cum += x;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
    if (x > 0) { ws++; ls = 0; if (ws > bw) bw = ws; }
    else if (x < 0) { ls++; ws = 0; if (ls > bl) bl = ls; }
  }

  return {
    trades: rs.length, wins: wins.length, losses: losses.length,
    winRate: wins.length / rs.length,
    netR, pnlUsd,
    expectancyR: netR / rs.length,
    avgWinR: wins.length ? grossWinR / wins.length : null,
    avgLossR: losses.length ? -grossLossR / losses.length : null,
    grossWinR, grossLossR,
    // NEVER divides by zero. A population with wins and no losses has no finite
    // profit factor, which is a fact about the sample, not a number.
    profitFactor: grossLossR > 0 ? grossWinR / grossLossR : null,
    pfNote: grossLossR > 0 ? null : "NO_LOSSES",
    maxDrawdownR: maxDD,
    longestWinStreak: bw, longestLossStreak: bl,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

export type DailyBucket = "ALIGNED" | "OPPOSED" | "RANGING" | "UNKNOWN";
export const DAILY_BUCKETS: readonly DailyBucket[] = ["ALIGNED", "OPPOSED", "RANGING", "UNKNOWN"];
export const INSTRUMENTS = ["EUR/USD", "USD/JPY", "BTC/USD"] as const;

export interface CausalReport {
  boundary: {
    forwardCausalStart: string;
    causalExecutionVersion: string;
    deployedStrategyCommit: string;
  };
  headline: Perf;
  /** Open right now, including positions held only because a branch is unresolved. */
  open: { total: number; ambiguous: number; legacy: number };
  byInstrument: Record<string, Perf>;
  byDirection: { long: Perf; short: Perf };
  /**
   * OBSERVATIONAL ONLY. Experiment 3 refuted the HTF-opposed hypothesis on
   * unseen data, so no bucket is preferred, none is a filter, and none should be
   * coloured as good or bad.
   */
  byDailyStructure: Record<DailyBucket, Perf>;
  quality: {
    /** How each included trade's exit was ordered. */
    resolutionMethods: Record<string, number>;
    /** Lifetime counts from the audit trail, not just the recent window. */
    events: Record<string, number>;
    validatedIncluded: number;
    excludedUnresolved: number;
    excludedSequenceContaminated: number;
    excludedOther: number;
    causalRowsTotal: number;
  };
  candidates: {
    intentsCreated: number;
    filled: number;
    refused: number;
    closed: number;
    /** fills / intents, or null when nothing has been offered yet. */
    fillConversion: number | null;
  };
  milestones: { current: number; targets: readonly number[]; next: number | null };
  /** Set when the sample is too small to read as performance. */
  smallSample: { below: number; n: number } | null;
}

export interface LegacySummary {
  trades: number;
  netR: number;
  pnlUsd: number;
  winRate: number | null;
  /** Always true. Present so a reader cannot use these numbers unlabelled. */
  notCausallyOrdered: true;
}

/**
 * Builds the whole dashboard population in one place.
 *
 * @param causalRows   every history row carrying the corrected version, any order
 * @param allRows      every history row the caller has, for the legacy split
 * @param positions    current open positions
 * @param eventCounts  lifetime counts by event type
 */
export function causalReport(
  causalRows: readonly HistoryRowLike[],
  positions: readonly PositionRowLike[],
  eventCounts: Record<string, number>,
  boundary: string = FORWARD_CAUSAL_START,
  version: string = CAUSAL_EXECUTION_VERSION,
): CausalReport {
  const included = causalRows
    .filter((r) => isValidatedCausalForwardTrade(r, boundary, version))
    // Path statistics need chronological order; the query order is not trusted.
    .sort((a, b) => ms(a.exit_time) - ms(b.exit_time));

  const excludedUnresolved = causalRows.filter((r) =>
    r.causal_execution_version === version &&
    (r.exit_reason === "ORDERING_UNRESOLVED" || r.exit_reason === "DATA_GAP_ABORTED")).length;
  const excludedSequenceContaminated = causalRows.filter((r) =>
    r.causal_execution_version === version && r.sequence_contaminated === true).length;
  const excludedOther = causalRows.filter((r) =>
    r.causal_execution_version === version &&
    !isValidatedCausalForwardTrade(r, boundary, version) &&
    r.sequence_contaminated !== true &&
    r.exit_reason !== "ORDERING_UNRESOLVED" && r.exit_reason !== "DATA_GAP_ABORTED").length;

  const resolutionMethods: Record<string, number> = {};
  for (const r of included) {
    const k = r.exit_resolution_method ?? "UNRECORDED";
    resolutionMethods[k] = (resolutionMethods[k] ?? 0) + 1;
  }

  const byInstrument: Record<string, Perf> = {};
  for (const sym of INSTRUMENTS) {
    byInstrument[sym] = perf(included.filter((r) => r.symbol === sym));
  }

  const byDailyStructure = {} as Record<DailyBucket, Perf>;
  for (const b of DAILY_BUCKETS) {
    byDailyStructure[b] = perf(included.filter((r) =>
      (r.daily_structure_alignment ?? "UNKNOWN") === b));
  }

  const intents = eventCounts.INTENT_CREATED ?? 0;
  const fills = eventCounts.FILLED ?? 0;

  const n = included.length;
  const next = SAMPLE_MILESTONES.find((m) => m > n) ?? null;

  return {
    boundary: {
      forwardCausalStart: boundary,
      causalExecutionVersion: version,
      deployedStrategyCommit: DEPLOYED_STRATEGY_COMMIT,
    },
    headline: perf(included),
    open: {
      total: positions.length,
      ambiguous: positions.filter((p) => p.status === "ordering_ambiguous").length,
      legacy: positions.filter((p) => p.causal_execution_version !== version).length,
    },
    byInstrument,
    byDirection: {
      long: perf(included.filter((r) => r.direction === "long")),
      short: perf(included.filter((r) => r.direction === "short")),
    },
    byDailyStructure,
    quality: {
      resolutionMethods,
      events: eventCounts,
      validatedIncluded: n,
      excludedUnresolved,
      excludedSequenceContaminated,
      excludedOther,
      causalRowsTotal: causalRows.filter((r) => r.causal_execution_version === version).length,
    },
    candidates: {
      intentsCreated: intents,
      filled: fills,
      refused: eventCounts.REFUSED ?? 0,
      closed: eventCounts.CLOSED ?? 0,
      fillConversion: intents > 0 ? fills / intents : null,
    },
    milestones: { current: n, targets: SAMPLE_MILESTONES, next },
    smallSample: n > 0 && n < SMALL_SAMPLE_BELOW ? { below: SMALL_SAMPLE_BELOW, n } : null,
  };
}

/** The pre-fix population, kept visible and never merged into the headline. */
export function legacySummary(
  allRows: readonly HistoryRowLike[],
  boundary: string = FORWARD_CAUSAL_START,
  version: string = CAUSAL_EXECUTION_VERSION,
): LegacySummary {
  const rows = allRows.filter((r) => isLegacyForwardTrade(r, boundary, version));
  const p = perf(rows);
  return {
    trades: p.trades, netR: p.netR, pnlUsd: p.pnlUsd, winRate: p.winRate,
    notCausallyOrdered: true,
  };
}
