/**
 * The boundary between the market-driven chain and the stateful gates. TYPES ONLY.
 *
 * WHY A BOUNDARY AT ALL. Stage 2H-B classified every stage by what it actually
 * depends on. Most of the SMC decision turns out to be a pure function of
 * candles and frozen config, so it can be replayed causally from historical
 * bars at any time t. A minority depends on things no amount of price history
 * can reconstruct: which positions were open, what the last trade closed at,
 * how many losses came before, what the economic calendar said.
 *
 * Collapsing those two together is what makes a backtest lie. The market chain
 * therefore stops at MARKET_CANDIDATE and hands over — it never assumes a
 * stateful gate passed, because "not evaluated" and "evaluated and allowed" are
 * different facts and only one of them is true in a historical replay.
 *
 * NO DEFAULTS ARE PROVIDED ON PURPOSE. Every field is required and nullable,
 * and null means "unknown", not "fine". A default here would silently become a
 * fabricated historical value, which is precisely the failure this separation
 * exists to prevent.
 */

/** What the market-driven chain concludes, before any stateful gate runs. */
export interface MarketCandidate {
  symbol: string;
  /** Historical decision instant. Never Date.now() in a replay. */
  atMs: number;
  style: string;

  direction: "long" | "short" | null;
  directionReason: string | null;
  bias: string | null;
  biasSource: string | null;

  /** Zone slice output, already proven at 152/152. */
  hasZone: boolean;
  unifiedState: string | null;
  selectedTF: string | null;
  unifiedScore: number | null;
  zoneHigh: number | null;
  zoneLow: number | null;

  confluenceScore: number | null;
  ictAligned: boolean | null;
  /** Session and kill zone derived from `atMs`, not from the wall clock. */
  sessionName: string | null;
  inKillZone: boolean | null;

  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskPips: number | null;

  /**
   * Whether the MARKET side alone would produce a candidate. This is NOT a
   * trade decision — the stateful gates have not run.
   */
  marketEligible: boolean;
  marketBlockReason: string | null;
}

/**
 * Everything the stateful gates need that market data cannot supply.
 *
 * Each field names a real production dependency found by inspection, with the
 * gate that consumes it. Nothing here is derivable from candles.
 */
export interface StatefulInputs {
  /** Evaluation instant. Gates 13 and 14 compare against it directly. */
  evaluationInstantMs: number | null;

  /** Open positions, for max-positions, per-symbol and stacking rules. */
  openPositions: Array<{
    symbol: string; direction: "long" | "short";
    size: number; entryPrice: number;
  }> | null;
  openPositionCount: number | null;

  /** Portfolio-level exposure. checkPortfolioConflict + heat limits. */
  portfolioHeatPct: number | null;
  correlatedPositionCount: number | null;
  /** Concentration from checkPortfolioConflict; not reconstructable without positions. */
  concentrationScore: number | null;
  sameDirectionStackingAllowed: boolean | null;

  /** Gate 13, Cooldown: last close for THIS symbol. */
  lastCloseAtMsForSymbol: number | null;

  /**
   * Gate 14, Max Consecutive Losses: the most recent
   * `maxConsecutiveLosses + 1` closes ACROSS ALL SYMBOLS — the query is not
   * symbol-filtered, unlike Gate 13. Ordered newest first.
   */
  recentClosesPortfolioWide: Array<{ pnl: number; closedAtMs: number }> | null;
  consecutiveLosses: number | null;

  /**
   * Gate 15, Dollar Daily Loss: today's closes. The boundary is a UTC calendar
   * day derived from `new Date().toISOString().slice(0,10)` — deliberately NOT
   * the account's daily_pnl_base_date, which is a different notion of "today".
   */
  todayClosesPnl: number[] | null;
  utcDayBoundary: string | null;
  dailyPnLPercent: number | null;
  weeklyPnLPercent: number | null;
  tradesToday: number | null;

  /** Account state read at scan time. */
  accountBalance: number | null;
  accountPeakBalance: number | null;
  propFirmActive: boolean | null;

  /**
   * The game-plan context production had available at the decision.
   *
   * STATEFUL, not market-derived — decided 2026-09-25. A game plan is CACHED in
   * scan_logs and reused while `isSameSession && hoursSinceLastGP <
   * gamePlanRefreshHours`, so which plan was live at time t is a database read
   * plus a refresh clock, not a function of the candles at t. Regenerating one
   * from historical bars would produce a plan production never held, so a
   * replay must consume the recorded context or declare it unknown.
   *
   * Fields listed are exactly those the consumers read, verified by inspection:
   *   runConfluenceAnalysis  -> bias, biasConfidence, keyLevels, dol
   *   computeDirectionVerdict -> bias, biasConfidence
   * The remaining fields travel with the object in production and are carried
   * so a recorded context round-trips intact.
   */
  gamePlanContext: {
    bias: string | null;
    biasConfidence: number | null;
    keyLevels: unknown[] | null;
    dol: unknown;
    regime: string | null;
    tradeable: boolean | null;
    htfTrend: string | null;
    h4Trend: string | null;
    atr: number | null;
    isFocusPair: boolean | null;
  } | null;
  /** When that plan was generated, and whether it was a reuse. */
  gamePlanGeneratedAtMs: number | null;
  gamePlanWasCachedReuse: boolean | null;

  /**
   * Economic calendar. There is NO historical news store in this project, so
   * for any past timestamp this is unknowable rather than empty. An empty array
   * would assert "no news", which is a claim the data cannot support.
   */
  newsEvents: unknown[] | null;
  newsKnownAt: number | null;
}

/** Why a stateful gate could not be evaluated, kept distinct from "it passed". */
export type StatefulEvaluation =
  | { evaluated: true; allowed: boolean; blockReason: string | null }
  | { evaluated: false; missing: string[] };

/**
 * The result of a historical replay that stops at the boundary.
 *
 * `statefulGatesEvaluated: false` must never be rendered or counted as a
 * trade. The whole point of the split is that a market candidate is an upper
 * bound on what could have traded, not a claim that it did.
 */
export interface MarketChainResult {
  candidate: MarketCandidate;
  statefulGatesEvaluated: false;
  statefulInputsMissing: string[];
}

/** Which stateful inputs are absent, so a report can say so field by field. */
export function missingStatefulInputs(s: Partial<StatefulInputs>): string[] {
  const required: (keyof StatefulInputs)[] = [
    "evaluationInstantMs", "openPositions", "openPositionCount",
    "portfolioHeatPct", "correlatedPositionCount", "concentrationScore",
    "sameDirectionStackingAllowed", "lastCloseAtMsForSymbol",
    "recentClosesPortfolioWide", "consecutiveLosses", "todayClosesPnl",
    "utcDayBoundary", "dailyPnLPercent", "weeklyPnLPercent", "tradesToday",
    "accountBalance", "accountPeakBalance", "propFirmActive",
    "gamePlanContext", "gamePlanGeneratedAtMs", "gamePlanWasCachedReuse",
    "newsEvents", "newsKnownAt",
  ];
  return required.filter((k) => s[k] === undefined || s[k] === null);
}
