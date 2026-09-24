/**
 * Derivations for the IPO paper dashboard. PURE — no fetch, no client, no clock
 * except what is passed in.
 *
 * WHY A SEPARATE MODULE. Everything here is arithmetic over rows the read
 * endpoint already returns, and arithmetic over money deserves real tests
 * rather than a grep over JSX. The component does layout; this decides what the
 * numbers mean.
 *
 * IT INVENTS NOTHING. Every field consumed exists on `ipo_paper_positions`,
 * `ipo_paper_trade_history` or `ipo_execution_events` today. Three things a
 * trader would reasonably expect are therefore ABSENT, and are absent on
 * purpose:
 *
 *   current price      no column stores it, and the read endpoint fetches no
 *                      candles — that split is what keeps a 1,200-bar rebuild
 *                      off the browser poll path
 *   unrealized R       follows from current price
 *   live distance to   likewise. The STATIC plan distances (entry→target,
 *   target / S2        entry→S2) are known at entry and are shown instead,
 *                      labelled as plan geometry rather than live distance
 *
 * What exists in their place is `mae_r` / `mfe_r`, updated on every managed
 * bar, which answers "how has this gone so far" without a price feed.
 */

/** Below this many closed trades, every derived statistic is labelled as a small sample. */
export const SMALL_SAMPLE_MAX = 20;

export const isSmallSample = (n: number): boolean => n < SMALL_SAMPLE_MAX;

/**
 * Pluralisation, kept here rather than inline in the component.
 *
 * Not fussiness: `IpoPaperMonitor.test.ts` asserts the monitor source never
 * contains the SMC journal's table name as a string literal, and the plural of
 * "trade" collides with it. Better a named helper than a test weakened to
 * accommodate a word.
 */
export const pluralTrades = (n: number): string => (n === 1 ? "trade" : "trades");

/** Structural shapes — deliberately minimal, so callers' richer row types fit. */
export interface ClosedTradeLike {
  symbol: string;
  direction: string;
  exit_time: string;
  exit_reason: string;
  realized_r: number | null;
  realized_pnl_usd: number | null;
  volatility_bucket: string;
  zone_entry_ordinal: number | null;
  excluded_from_stats: boolean;
}

export interface OpenPositionLike {
  symbol: string;
  direction: string;
  status: string;
  entry_price: number;
  target_price: number;
  s2_invalidation_level: number;
  nominal_risk_distance: number;
  gap_reason: string | null;
}

/**
 * Rows that carry a strategy outcome.
 *
 * A data-gap abort has no R — it is a run that was stopped, not a trade that
 * lost — so it is excluded from every average here, exactly as the endpoint's
 * own `summarize` does. The exclusion is repeated rather than assumed because
 * these two live in different processes.
 */
export const cleanTrades = <T extends ClosedTradeLike>(trades: readonly T[]): T[] =>
  trades.filter((t) => !t.excluded_from_stats && t.realized_r !== null);

// ── equity and drawdown ──────────────────────────────────────────────────────

export interface EquityPoint { at: string; cumR: number }

/** Cumulative realized R, oldest first. The endpoint returns newest first. */
export function equityCurveR(trades: readonly ClosedTradeLike[]): EquityPoint[] {
  const ordered = [...cleanTrades(trades)]
    .sort((a, b) => new Date(a.exit_time).getTime() - new Date(b.exit_time).getTime());
  let cum = 0;
  return ordered.map((t) => {
    cum += t.realized_r as number;
    return { at: t.exit_time, cumR: cum };
  });
}

export interface DrawdownR {
  /** Worst peak-to-trough on the cumulative R curve. Reported as a positive magnitude. */
  maxR: number;
  /** How far below the running peak the curve currently sits. */
  currentR: number;
  peakR: number;
  /** Closed trades the figure covers. The endpoint caps its history, so this is a window. */
  window: number;
}

/**
 * Drawdown over the realized-R curve.
 *
 * COMPUTED, NOT INVENTED: it is a fold over `realized_r`, which is stored. But
 * it only covers the trades the endpoint returned (capped at 100), so `window`
 * travels with it and the UI states it. A drawdown over "the last 100 trades"
 * is a different claim from a drawdown over the life of the strategy, and
 * presenting the first as the second would be the kind of quiet overstatement
 * this dashboard is meant to avoid.
 */
export function drawdownR(trades: readonly ClosedTradeLike[]): DrawdownR {
  const curve = equityCurveR(trades);
  let peak = 0, maxDd = 0;
  for (const p of curve) {
    if (p.cumR > peak) peak = p.cumR;
    const dd = peak - p.cumR;
    if (dd > maxDd) maxDd = dd;
  }
  const last = curve.length ? curve[curve.length - 1].cumR : 0;
  return { maxR: maxDd, currentR: Math.max(0, peak - last), peakR: peak, window: curve.length };
}

// ── headline metrics ─────────────────────────────────────────────────────────

export interface Headline {
  openPositions: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalR: number;
  avgR: number;
  totalPnlUsd: number;
  abortedExcluded: number;
  drawdown: DrawdownR;
  smallSample: boolean;
}

export function headline(
  openPositions: readonly OpenPositionLike[],
  trades: readonly ClosedTradeLike[],
): Headline {
  const clean = cleanTrades(trades);
  const wins = clean.filter((t) => (t.realized_r as number) > 0).length;
  const totalR = clean.reduce((a, t) => a + (t.realized_r as number), 0);
  return {
    openPositions: openPositions.length,
    closedTrades: clean.length,
    wins,
    // A scratch (exactly 0R) is neither. Counting it as a loss would understate
    // the win rate's denominator honesty.
    losses: clean.filter((t) => (t.realized_r as number) < 0).length,
    winRate: clean.length ? wins / clean.length : 0,
    totalR,
    avgR: clean.length ? totalR / clean.length : 0,
    totalPnlUsd: clean.reduce((a, t) => a + (t.realized_pnl_usd ?? 0), 0),
    abortedExcluded: trades.length - clean.length,
    drawdown: drawdownR(trades),
    smallSample: isSmallSample(clean.length),
  };
}

// ── readable status ──────────────────────────────────────────────────────────

export type Tone = "good" | "neutral" | "info" | "warn" | "bad";

export interface Explained {
  /** The raw code, preserved verbatim for debugging. Never discarded. */
  code: string;
  /** One short trader-readable line. */
  headline: string;
  /** Why it happened, in a sentence. */
  detail: string;
  tone: Tone;
}

/**
 * Raw status/reason code → something a trader can read.
 *
 * THE RAW CODE SURVIVES. It is returned on every result and the UI renders it
 * in a tooltip and a detail column. A prettier label that loses the code makes
 * the dashboard unusable for debugging the thing it is monitoring.
 *
 * An unknown code is passed through rather than guessed at — a new code
 * appearing should look unfamiliar, not be silently absorbed into the nearest
 * existing sentence.
 */
const EXPLANATIONS: Record<string, Omit<Explained, "code">> = {
  BLOCKED_POSITION_OPEN: {
    headline: "Waiting — already in a trade",
    detail: "One position per instrument. New setups are not taken until this one closes.",
    tone: "info",
  },
  POSITION_ALREADY_OPEN: {
    headline: "Not taken — position already open",
    detail: "The signal was valid; execution was declined because the instrument was occupied.",
    tone: "info",
  },
  SUPPRESSED_IN_CONTRACTION: {
    headline: "Suppressed — price is contracting",
    detail: "The zone sits inside a contraction episode, so the setup is held back rather than invalidated.",
    tone: "warn",
  },
  NOT_TRACKED: {
    headline: "Not tracked",
    detail: "The frozen rules do not compute this stage. It is neither a yes nor a no.",
    tone: "neutral",
  },
  FREE: {
    headline: "Free to trade",
    detail: "No open position on this instrument; the next valid setup can be taken.",
    tone: "good",
  },
  ECONOMICALLY_UNTRADEABLE_COST: {
    headline: "Not taken — costs too much of the edge",
    detail: "Spread and commission exceeded the cost ceiling in R terms, so execution was blocked. The signal itself stayed valid.",
    tone: "warn",
  },
  ACCOUNT_SAFETY: {
    headline: "Not taken — account safety",
    detail: "An account-level guard declined the execution. The strategy signal was unaffected.",
    tone: "warn",
  },
  COVERAGE_LOST: {
    headline: "Data gap — bars missing",
    detail: "The feed skipped bars the position needed, so management was suspended rather than guessed at.",
    tone: "bad",
  },
  GAP_SUSPENDED: {
    headline: "Suspended — data gap",
    detail: "Management is paused until the missing bars arrive. Nothing is fabricated while suspended.",
    tone: "bad",
  },
  GAP_RECOVERED: {
    headline: "Recovered — bars arrived",
    detail: "The missing bars were received and management resumed on real data.",
    tone: "good",
  },
  DATA_GAP_ABORTED: {
    headline: "Aborted — gap never closed",
    detail: "The position was abandoned without an outcome. It carries no R and is excluded from every statistic.",
    tone: "bad",
  },
  TARGET_2R: {
    headline: "Target hit",
    detail: "Closed at the 2R target.",
    tone: "good",
  },
  S2_CLOSE_INVALIDATION: {
    headline: "Stopped — S2 invalidation",
    detail: "A bar CLOSED beyond the invalidation level. A wick through it does not count, so the loss can exceed 1R.",
    tone: "bad",
  },
  WOULD_ENTER: {
    headline: "Strategy would enter",
    detail: "The IPO rules admitted the setup. Whether it executed is a separate verdict.",
    tone: "good",
  },
  WOULD_NOT_ENTER: {
    headline: "Strategy would not enter",
    detail: "The IPO rules did not admit the setup.",
    tone: "neutral",
  },
  HOLD: { headline: "Holding", detail: "No change this bar.", tone: "neutral" },
  WOULD_EXIT: { headline: "Strategy would exit", detail: "An exit condition was met.", tone: "info" },
  ALLOW: { headline: "Allowed", detail: "No account-level objection.", tone: "good" },
  UNAVAILABLE: {
    headline: "Account checks not applicable",
    detail: "Paper mode runs without an account gate; there is nothing to allow or block.",
    tone: "neutral",
  },
};

export function explainStatus(code: string | null | undefined): Explained {
  if (!code) return { code: "—", headline: "—", detail: "No status recorded.", tone: "neutral" };
  const known = EXPLANATIONS[code];
  return known
    ? { code, ...known }
    : { code, headline: code, detail: "Unrecognised code — shown raw rather than guessed at.", tone: "neutral" };
}

/** Every code this module can explain. Lets a test assert the required set is covered. */
export const explainableCodes = (): string[] => Object.keys(EXPLANATIONS).sort();

// ── lifecycle ────────────────────────────────────────────────────────────────

export type StageStatus = "done" | "active" | "pending" | "not_tracked";

export interface Stage {
  key: string;
  label: string;
  status: StageStatus;
  /** Count or short note. Never a fabricated number. */
  detail: string;
}

export interface LifecycleInput {
  validCandidates: number;
  /**
   * Null when the caller has no touch data.
   *
   * The paper-state feed records INTENT_CREATED but emits no TOUCH event, and
   * inferring one from the other would be a guess dressed as a count. The
   * Scanner tab observes touch directly; here the stage says so.
   */
  touched: number | null;
  openPositions: number;
  closedAtTarget: number;
  closedAtS2: number;
}

/**
 * The strategy progression, as five readable stages.
 *
 * TREND IS `not_tracked`, DELIBERATELY. The frozen population rules implement
 * suppression, clearance, touch and invalidation; TREND lives in the research
 * state machine and is not computed here. `IpoScanDetail` already renders it
 * that way, and showing a tick or a cross would be a fabrication in the one
 * place a trader is most likely to read it as fact.
 */
export function lifecycleStages(i: LifecycleInput): Stage[] {
  const closed = i.closedAtTarget + i.closedAtS2;
  return [
    {
      key: "VALID_IPO", label: "Valid IPO",
      status: i.validCandidates > 0 ? "done" : "pending",
      detail: `${i.validCandidates} live`,
    },
    {
      key: "TOUCH", label: "Touch",
      status: i.touched === null ? "not_tracked" : i.touched > 0 ? "done" : "pending",
      detail: i.touched === null ? "observed in the Scanner tab" : `${i.touched} touched`,
    },
    {
      key: "TREND", label: "Trend",
      status: "not_tracked",
      detail: "not computed by the frozen rules",
    },
    {
      key: "POSITION_OPEN", label: "Position open",
      status: i.openPositions > 0 ? "active" : "pending",
      detail: `${i.openPositions} open`,
    },
    {
      key: "RESOLVED", label: "Target / S2",
      status: closed > 0 ? "done" : "pending",
      detail: closed === 0 ? "none yet" : `${i.closedAtTarget} target · ${i.closedAtS2} S2`,
    },
  ];
}

// ── grouped performance ──────────────────────────────────────────────────────

export interface Group {
  key: string;
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  totalR: number;
  avgR: number;
  totalPnlUsd: number;
  /** True when this BUCKET is thin, independent of the overall sample. */
  smallSample: boolean;
}

export function groupTrades<T extends ClosedTradeLike>(
  trades: readonly T[],
  keyOf: (t: T) => string,
): Group[] {
  const buckets = new Map<string, T[]>();
  for (const t of cleanTrades(trades)) {
    const k = keyOf(t);
    const arr = buckets.get(k);
    if (arr) arr.push(t); else buckets.set(k, [t]);
  }
  return [...buckets.entries()]
    .map(([key, rows]) => {
      const totalR = rows.reduce((a, r) => a + (r.realized_r as number), 0);
      const wins = rows.filter((r) => (r.realized_r as number) > 0).length;
      return {
        key, n: rows.length, wins,
        losses: rows.filter((r) => (r.realized_r as number) < 0).length,
        winRate: wins / rows.length,
        totalR, avgR: totalR / rows.length,
        totalPnlUsd: rows.reduce((a, r) => a + (r.realized_pnl_usd ?? 0), 0),
        smallSample: isSmallSample(rows.length),
      };
    })
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

export const bySymbol = <T extends ClosedTradeLike>(t: readonly T[]) => groupTrades(t, (x) => x.symbol);
export const byBucket = <T extends ClosedTradeLike>(t: readonly T[]) => groupTrades(t, (x) => x.volatility_bucket);
export const byOrdinal = <T extends ClosedTradeLike>(t: readonly T[]) =>
  groupTrades(t, (x) => (x.zone_entry_ordinal == null ? "unknown" : `#${x.zone_entry_ordinal}`));

/**
 * Exit-reason split over ALL closed rows, including aborts.
 *
 * Aborts are excluded from performance averages but must appear here: a run
 * that keeps aborting is exactly what this panel should make visible.
 */
export function exitReasonSplit(trades: readonly ClosedTradeLike[]): Array<{ reason: string; n: number; share: number }> {
  const counts = new Map<string, number>();
  for (const t of trades) counts.set(t.exit_reason, (counts.get(t.exit_reason) ?? 0) + 1);
  const total = trades.length || 1;
  return [...counts.entries()]
    .map(([reason, n]) => ({ reason, n, share: n / total }))
    .sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason));
}

// ── client-side filters ──────────────────────────────────────────────────────

export interface TradeFilters {
  symbol: string;        // "all" | symbol
  bucket: string;        // "all" | bucket
  ordinal: string;       // "all" | "#1" | … | "unknown"
  exitReason: string;    // "all" | reason
  from: string;          // "" | yyyy-mm-dd
  to: string;            // "" | yyyy-mm-dd
}

export const NO_FILTERS: TradeFilters = {
  symbol: "all", bucket: "all", ordinal: "all", exitReason: "all", from: "", to: "",
};

const ordinalKey = (t: ClosedTradeLike) =>
  t.zone_entry_ordinal == null ? "unknown" : `#${t.zone_entry_ordinal}`;

/**
 * Applied in the browser over rows already fetched.
 *
 * No filter triggers a request: the state endpoint returns the whole recent
 * window in one call, and adding a round trip per dropdown would be a cost with
 * no new information behind it.
 */
export function filterTrades<T extends ClosedTradeLike>(trades: readonly T[], f: TradeFilters): T[] {
  // Date bounds are inclusive on both ends and compared on the calendar day, so
  // "from 2026-09-22 to 2026-09-22" returns that whole day rather than nothing.
  const fromMs = f.from ? new Date(`${f.from}T00:00:00.000Z`).getTime() : -Infinity;
  const toMs = f.to ? new Date(`${f.to}T23:59:59.999Z`).getTime() : Infinity;
  return trades.filter((t) => {
    if (f.symbol !== "all" && t.symbol !== f.symbol) return false;
    if (f.bucket !== "all" && t.volatility_bucket !== f.bucket) return false;
    if (f.ordinal !== "all" && ordinalKey(t) !== f.ordinal) return false;
    if (f.exitReason !== "all" && t.exit_reason !== f.exitReason) return false;
    const ms = new Date(t.exit_time).getTime();
    return ms >= fromMs && ms <= toMs;
  });
}

export const filterIsActive = (f: TradeFilters): boolean =>
  f.symbol !== "all" || f.bucket !== "all" || f.ordinal !== "all"
  || f.exitReason !== "all" || f.from !== "" || f.to !== "";

/** Distinct values present in the data, so a dropdown never offers an empty filter. */
export function filterOptions(trades: readonly ClosedTradeLike[]) {
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  return {
    symbols: uniq(trades.map((t) => t.symbol)),
    buckets: uniq(trades.map((t) => t.volatility_bucket)),
    ordinals: uniq(trades.map(ordinalKey)),
    exitReasons: uniq(trades.map((t) => t.exit_reason)),
  };
}

// ── open-position plan geometry ──────────────────────────────────────────────

export interface PlanGeometry {
  /** Price distance entry→target, and the same in R. Static, known at entry. */
  toTarget: number;
  toTargetR: number;
  /** Price distance entry→S2, and the same in R. */
  toS2: number;
  toS2R: number;
}

/**
 * Distances from ENTRY, not from current price.
 *
 * The live version of this — "how far is price from the target right now" —
 * needs a current price, which nothing in the IPO read path has. Rather than
 * leave the field blank, the plan geometry is shown and labelled as such.
 */
export function planGeometry(p: OpenPositionLike): PlanGeometry {
  const risk = Math.abs(p.nominal_risk_distance) || 1;
  return {
    toTarget: Math.abs(p.target_price - p.entry_price),
    toTargetR: Math.abs(p.target_price - p.entry_price) / risk,
    toS2: Math.abs(p.entry_price - p.s2_invalidation_level),
    toS2R: Math.abs(p.entry_price - p.s2_invalidation_level) / risk,
  };
}

/** The gap state of an open position, as a readable verdict. */
export function gapState(p: OpenPositionLike): Explained {
  if (p.status === "data_gap_suspended") return explainStatus(p.gap_reason ?? "GAP_SUSPENDED");
  return { code: "open", headline: "Live", detail: "Managed on every closed bar.", tone: "good" };
}

// ─── causal forward lens ─────────────────────────────────────────────────────
//
// The dashboard's default population is the validated causal forward test. Every
// number in it is computed by the BACKEND from one admission rule
// (`ipoCausalEvidence.isValidatedCausalForwardTrade`) — these are formatters
// only, so no card can quietly disagree with another about what counts.

export type EvidenceLens = "causal" | "legacy" | "all";

export interface PerfLike {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netR: number;
  pnlUsd: number;
  expectancyR: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  grossWinR: number;
  grossLossR: number;
  profitFactor: number | null;
  pfNote: "NO_TRADES" | "NO_LOSSES" | null;
  maxDrawdownR: number;
  longestWinStreak: number;
  longestLossStreak: number;
}

/** An em dash for "no data", never a misleading 0. */
export const DASH = "—";

export const fmtR = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v)
    ? DASH
    : `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;

export const fmtPct = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? DASH : `${(v * 100).toFixed(0)}%`;

/**
 * Profit factor, with the two cases that are NOT numbers stated as words.
 *
 * A population with wins and no losses has no finite profit factor. Printing a
 * huge number there, or 0, would both be lies; "∞" is the honest reading and
 * carries its own warning.
 */
export function fmtPF(p: Pick<PerfLike, "profitFactor" | "pfNote">): string {
  if (p.profitFactor !== null && Number.isFinite(p.profitFactor)) return p.profitFactor.toFixed(2);
  if (p.pfNote === "NO_LOSSES") return "∞";
  return DASH;
}

/** Long-form for a tooltip, because "∞" alone invites the wrong conclusion. */
export function pfTitle(p: Pick<PerfLike, "profitFactor" | "pfNote" | "grossWinR" | "grossLossR">): string {
  if (p.pfNote === "NO_TRADES") return "no closed trades yet";
  if (p.pfNote === "NO_LOSSES") return `no losses yet — ${p.grossWinR.toFixed(2)}R gross win, 0R gross loss`;
  return `${p.grossWinR.toFixed(2)}R gross win / ${p.grossLossR.toFixed(2)}R gross loss`;
}

export const EMPTY_PERF_VIEW: PerfLike = {
  trades: 0, wins: 0, losses: 0, winRate: null, netR: 0, pnlUsd: 0,
  expectancyR: null, avgWinR: null, avgLossR: null,
  grossWinR: 0, grossLossR: 0, profitFactor: null, pfNote: "NO_TRADES",
  maxDrawdownR: 0, longestWinStreak: 0, longestLossStreak: 0,
};

/** The heading for each lens. The third one carries its own health warning. */
export function lensTitle(lens: EvidenceLens): string {
  if (lens === "causal") return "IPO CAUSAL FORWARD TEST";
  if (lens === "legacy") return "LEGACY PRE-FIX — NOT CAUSALLY ORDERED";
  return "ALL HISTORY — NOT VALID FOR PERFORMANCE EVALUATION";
}

/**
 * Progress toward the next monitoring landmark.
 *
 * A LANDMARK IS NOT A THRESHOLD. Nothing about the strategy becomes true at 25
 * trades, so this returns a count and a target and deliberately no verdict.
 */
export function milestoneLabel(current: number, next: number | null): string {
  return next === null ? `${current} causal ${pluralTrades(current)}` : `${current} / ${next}`;
}

/** The short reason an excluded row is excluded, for the audit list. */
export function exclusionLabel(row: {
  exit_reason?: string | null;
  sequence_contaminated?: boolean | null;
  excluded_from_stats?: boolean | null;
  causal_execution_version?: string | null;
}, version: string): string | null {
  if (row.causal_execution_version !== version) return "LEGACY PRE-FIX";
  if (row.sequence_contaminated) return "SEQUENCE CONTAMINATED";
  if (row.exit_reason === "ORDERING_UNRESOLVED") return "ORDERING UNRESOLVED";
  if (row.exit_reason === "DATA_GAP_ABORTED") return "DATA GAP";
  if (row.excluded_from_stats) return "EXCLUDED";
  return null;
}

/** One sentence explaining each exclusion, so a reader need not know the schema. */
export const EXCLUSION_REASONS: Record<string, string> = {
  "LEGACY PRE-FIX":
    "Recorded before the causal-ordering fix. A same-bar target may have been booked from an excursion that happened before the entry.",
  "SEQUENCE CONTAMINATED":
    "Trade existence depends on an unresolved earlier ordering branch.",
  "ORDERING UNRESOLVED":
    "No data could establish the order of competing events, so no outcome is claimed.",
  "DATA GAP":
    "Bars were missing for long enough that the path was never observed.",
  "EXCLUDED": "Excluded at source.",
};

export const AMBIGUOUS_POSITION_NOTE =
  "At least one causal path remains open. Position slot remains occupied.";
