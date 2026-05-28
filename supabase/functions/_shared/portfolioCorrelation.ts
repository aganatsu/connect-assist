/**
 * portfolioCorrelation.ts — Portfolio Correlation Matrix Engine
 * ──────────────────────────────────────────────────────────────────────
 * Prevents correlated exposure by computing real-time correlation between
 * open positions and candidate trades. Key capabilities:
 *
 *   1. **Static Correlation Map** — Known structural correlations between
 *      currency pairs (e.g., EUR/USD ↔ GBP/USD positive, EUR/USD ↔ USD/CHF negative)
 *   2. **Dynamic Correlation** — Rolling Pearson correlation computed from
 *      recent price returns (adapts to changing market conditions)
 *   3. **Net Exposure Calculation** — Aggregates directional exposure per
 *      currency to detect hidden concentration risk
 *   4. **Position Conflict Detection** — Flags when a new trade would create
 *      contradictory or over-concentrated exposure
 *
 * Usage in the bot-scanner:
 *   Before opening a new position, call `checkPortfolioConflict()` with
 *   the candidate trade and current open positions. If it returns a conflict,
 *   the trade should be skipped or size-reduced.
 */

// ─── Static Correlation Matrix ───────────────────────────────────────

/**
 * Known structural correlations between major pairs.
 * Values: +1 = perfectly correlated, -1 = perfectly inverse, 0 = uncorrelated.
 * These are "typical" long-term correlations that serve as priors.
 */
export const STATIC_CORRELATIONS: Record<string, Record<string, number>> = {
  "EUR/USD": { "GBP/USD": 0.85, "AUD/USD": 0.70, "NZD/USD": 0.65, "USD/CHF": -0.90, "USD/JPY": -0.40, "USD/CAD": -0.60, "EUR/GBP": 0.30, "EUR/JPY": 0.50, "GBP/JPY": 0.40, "XAU/USD": 0.40 },
  "GBP/USD": { "EUR/USD": 0.85, "AUD/USD": 0.60, "NZD/USD": 0.55, "USD/CHF": -0.80, "USD/JPY": -0.35, "USD/CAD": -0.55, "EUR/GBP": -0.50, "GBP/JPY": 0.60, "EUR/JPY": 0.45, "XAU/USD": 0.35 },
  "USD/JPY": { "USD/CHF": 0.55, "USD/CAD": 0.50, "EUR/USD": -0.40, "GBP/USD": -0.35, "EUR/JPY": 0.60, "GBP/JPY": 0.65, "AUD/JPY": 0.70, "NZD/JPY": 0.65, "CHF/JPY": 0.40, "XAU/USD": -0.30 },
  "USD/CHF": { "EUR/USD": -0.90, "GBP/USD": -0.80, "USD/JPY": 0.55, "USD/CAD": 0.50, "AUD/USD": -0.65, "NZD/USD": -0.60, "XAU/USD": -0.45 },
  "AUD/USD": { "NZD/USD": 0.90, "EUR/USD": 0.70, "GBP/USD": 0.60, "USD/CHF": -0.65, "USD/CAD": -0.55, "AUD/JPY": 0.60, "AUD/NZD": 0.20, "XAU/USD": 0.50 },
  "NZD/USD": { "AUD/USD": 0.90, "EUR/USD": 0.65, "GBP/USD": 0.55, "USD/CHF": -0.60, "USD/CAD": -0.50, "NZD/JPY": 0.55, "AUD/NZD": -0.30, "XAU/USD": 0.45 },
  "USD/CAD": { "EUR/USD": -0.60, "GBP/USD": -0.55, "AUD/USD": -0.55, "NZD/USD": -0.50, "USD/JPY": 0.50, "USD/CHF": 0.50, "XAU/USD": -0.35 },
  "EUR/GBP": { "EUR/USD": 0.30, "GBP/USD": -0.50 },
  "EUR/JPY": { "USD/JPY": 0.60, "EUR/USD": 0.50, "GBP/JPY": 0.85 },
  "GBP/JPY": { "USD/JPY": 0.65, "GBP/USD": 0.60, "EUR/JPY": 0.85 },
  "AUD/JPY": { "USD/JPY": 0.70, "AUD/USD": 0.60, "NZD/JPY": 0.85 },
  "NZD/JPY": { "USD/JPY": 0.65, "NZD/USD": 0.55, "AUD/JPY": 0.85 },
  "XAU/USD": { "XAG/USD": 0.85, "EUR/USD": 0.40, "AUD/USD": 0.50, "USD/CHF": -0.45, "USD/JPY": -0.30, "USD/CAD": -0.35 },
  "XAG/USD": { "XAU/USD": 0.85, "EUR/USD": 0.35, "AUD/USD": 0.45 },
  "BTC/USD": { "ETH/USD": 0.90, "XAU/USD": 0.20 },
  "ETH/USD": { "BTC/USD": 0.90, "XAU/USD": 0.15 },
};

// ─── Types ───────────────────────────────────────────────────────────

export interface OpenPosition {
  symbol: string;
  direction: "long" | "short";
  /** Position size in lots */
  size: number;
  /** Entry price */
  entryPrice: number;
}

export interface CandidateTrade {
  symbol: string;
  direction: "long" | "short";
  /** Proposed size in lots */
  size: number;
}

export interface CurrencyExposure {
  currency: string;
  /** Net exposure: positive = long, negative = short */
  netExposure: number;
  /** Absolute exposure */
  grossExposure: number;
}

export interface CorrelationConflict {
  /** Type of conflict detected */
  type: "high_correlation" | "inverse_contradiction" | "currency_concentration" | "same_pair_same_direction";
  /** Severity: 0-1 (1 = most severe) */
  severity: number;
  /** Human-readable explanation */
  detail: string;
  /** The conflicting position(s) */
  conflictsWith: string[];
  /** Recommended action */
  recommendation: "skip" | "reduce_size" | "proceed_with_caution";
}

export interface PortfolioCheckResult {
  /** Whether the trade should proceed */
  approved: boolean;
  /** List of conflicts found (empty if approved) */
  conflicts: CorrelationConflict[];
  /** Net currency exposure after adding the candidate */
  currencyExposure: CurrencyExposure[];
  /** Effective portfolio correlation score (0-1, higher = more concentrated) */
  concentrationScore: number;
  /** Detail string for logging */
  detail: string;
}

export interface PortfolioConfig {
  /** Maximum allowed correlation between new trade and existing position (default: 0.75) */
  maxCorrelation: number;
  /** Maximum positions in highly correlated pairs (default: 1) */
  maxCorrelatedPositions: number;
  /** Maximum net exposure per currency as multiple of single position (default: 2.0) */
  maxCurrencyExposure: number;
  /** Whether to use static correlations only (default: false, uses dynamic when available) */
  staticOnly: boolean;
  /** Minimum severity to block a trade (default: 0.7) */
  blockThreshold: number;
}

export const DEFAULT_PORTFOLIO_CONFIG: PortfolioConfig = {
  maxCorrelation: 0.75,
  maxCorrelatedPositions: 1,
  maxCurrencyExposure: 2.0,
  staticOnly: false,
  blockThreshold: 0.7,
};

// ─── Dynamic Correlation (Pearson) ───────────────────────────────────

/**
 * Compute Pearson correlation between two price series (returns-based).
 * @param pricesA - Close prices for pair A (ascending order)
 * @param pricesB - Close prices for pair B (ascending order, same length)
 * @returns Correlation coefficient (-1 to +1), or null if insufficient data
 */
export function computePearsonCorrelation(pricesA: number[], pricesB: number[]): number | null {
  const n = Math.min(pricesA.length, pricesB.length);
  if (n < 10) return null; // Need at least 10 data points

  // Convert to log returns
  const returnsA: number[] = [];
  const returnsB: number[] = [];
  for (let i = 1; i < n; i++) {
    if (pricesA[i - 1] <= 0 || pricesB[i - 1] <= 0) continue;
    returnsA.push(Math.log(pricesA[i] / pricesA[i - 1]));
    returnsB.push(Math.log(pricesB[i] / pricesB[i - 1]));
  }

  if (returnsA.length < 9) return null;

  const meanA = returnsA.reduce((s, v) => s + v, 0) / returnsA.length;
  const meanB = returnsB.reduce((s, v) => s + v, 0) / returnsB.length;

  let sumAB = 0, sumA2 = 0, sumB2 = 0;
  for (let i = 0; i < returnsA.length; i++) {
    const dA = returnsA[i] - meanA;
    const dB = returnsB[i] - meanB;
    sumAB += dA * dB;
    sumA2 += dA * dA;
    sumB2 += dB * dB;
  }

  const denominator = Math.sqrt(sumA2 * sumB2);
  if (denominator === 0) return 0;

  return sumAB / denominator;
}

// ─── Currency Decomposition ──────────────────────────────────────────

/**
 * Decompose a forex pair into its component currencies with directional exposure.
 * E.g., long EUR/USD = +1 EUR, -1 USD
 */
export function decomposePair(symbol: string, direction: "long" | "short", size: number): Record<string, number> {
  const parts = symbol.split("/");
  if (parts.length !== 2) return {};

  const [base, quote] = parts;
  const sign = direction === "long" ? 1 : -1;

  return {
    [base]: sign * size,
    [quote]: -sign * size,
  };
}

/**
 * Compute net currency exposure across all positions.
 */
export function computeCurrencyExposure(positions: OpenPosition[]): CurrencyExposure[] {
  const exposure: Record<string, number> = {};

  for (const pos of positions) {
    const decomposed = decomposePair(pos.symbol, pos.direction, pos.size);
    for (const [currency, amount] of Object.entries(decomposed)) {
      exposure[currency] = (exposure[currency] || 0) + amount;
    }
  }

  return Object.entries(exposure)
    .map(([currency, netExposure]) => ({
      currency,
      netExposure,
      grossExposure: Math.abs(netExposure),
    }))
    .sort((a, b) => b.grossExposure - a.grossExposure);
}

// ─── Correlation Lookup ──────────────────────────────────────────────

/**
 * Get the correlation between two symbols.
 * Uses dynamic correlation if available, falls back to static.
 */
export function getCorrelation(
  symbolA: string,
  symbolB: string,
  dynamicCorrelations?: Record<string, Record<string, number>>,
): number {
  if (symbolA === symbolB) return 1.0;

  // Try dynamic first
  if (dynamicCorrelations) {
    const dyn = dynamicCorrelations[symbolA]?.[symbolB] ?? dynamicCorrelations[symbolB]?.[symbolA];
    if (dyn !== undefined) return dyn;
  }

  // Fall back to static
  const stat = STATIC_CORRELATIONS[symbolA]?.[symbolB] ?? STATIC_CORRELATIONS[symbolB]?.[symbolA];
  return stat ?? 0;
}

/**
 * Compute effective correlation considering trade direction.
 * Long EUR/USD vs Long GBP/USD = positive correlation (both long correlated pairs)
 * Long EUR/USD vs Short GBP/USD = negative correlation (opposing directions on correlated pairs)
 * Long EUR/USD vs Long USD/CHF = negative correlation (inversely correlated pairs, same direction)
 */
export function getDirectionalCorrelation(
  posA: { symbol: string; direction: "long" | "short" },
  posB: { symbol: string; direction: "long" | "short" },
  dynamicCorrelations?: Record<string, Record<string, number>>,
): number {
  const rawCorr = getCorrelation(posA.symbol, posB.symbol, dynamicCorrelations);
  const sameDirection = posA.direction === posB.direction;
  // Same direction on positively correlated pairs = high effective correlation
  // Opposite direction on positively correlated pairs = low effective correlation (hedging)
  // Same direction on negatively correlated pairs = low effective correlation (hedging)
  // Opposite direction on negatively correlated pairs = high effective correlation (doubling down)
  return sameDirection ? rawCorr : -rawCorr;
}

// ─── Main: Portfolio Conflict Check ──────────────────────────────────

/**
 * Check if a candidate trade conflicts with the current portfolio.
 *
 * @param candidate - The proposed new trade
 * @param openPositions - Currently open positions
 * @param config - Portfolio configuration
 * @param dynamicCorrelations - Optional dynamic correlation matrix
 * @returns PortfolioCheckResult with approval status and conflicts
 */
export function checkPortfolioConflict(
  candidate: CandidateTrade,
  openPositions: OpenPosition[],
  config: Partial<PortfolioConfig> = {},
  dynamicCorrelations?: Record<string, Record<string, number>>,
): PortfolioCheckResult {
  const cfg = { ...DEFAULT_PORTFOLIO_CONFIG, ...config };
  const conflicts: CorrelationConflict[] = [];

  if (openPositions.length === 0) {
    return {
      approved: true,
      conflicts: [],
      currencyExposure: computeCurrencyExposure([{ ...candidate, entryPrice: 0 }]),
      concentrationScore: 0,
      detail: "No open positions — no conflict possible",
    };
  }

  // 1. Check same-pair same-direction duplication
  const samePairSameDir = openPositions.filter(
    (p) => p.symbol === candidate.symbol && p.direction === candidate.direction
  );
  if (samePairSameDir.length > 0) {
    conflicts.push({
      type: "same_pair_same_direction",
      severity: 0.8,
      detail: `Already have ${samePairSameDir.length} ${candidate.direction} position(s) on ${candidate.symbol}`,
      conflictsWith: [candidate.symbol],
      recommendation: "skip",
    });
  }

  // 2. Check high correlation with existing positions
  let correlatedCount = 0;
  for (const pos of openPositions) {
    if (pos.symbol === candidate.symbol) continue;
    const effCorr = getDirectionalCorrelation(
      { symbol: candidate.symbol, direction: candidate.direction },
      { symbol: pos.symbol, direction: pos.direction },
      dynamicCorrelations,
    );

    if (effCorr > cfg.maxCorrelation) {
      correlatedCount++;
      conflicts.push({
        type: "high_correlation",
        severity: Math.min(1.0, effCorr),
        detail: `${candidate.symbol} ${candidate.direction} has ${(effCorr * 100).toFixed(0)}% effective correlation with ${pos.symbol} ${pos.direction}`,
        conflictsWith: [pos.symbol],
        recommendation: correlatedCount > cfg.maxCorrelatedPositions ? "skip" : "reduce_size",
      });
    }

    // Check for contradictory positions (inverse correlation > threshold)
    if (effCorr < -cfg.maxCorrelation) {
      conflicts.push({
        type: "inverse_contradiction",
        severity: Math.min(1.0, Math.abs(effCorr)),
        detail: `${candidate.symbol} ${candidate.direction} contradicts ${pos.symbol} ${pos.direction} (${(effCorr * 100).toFixed(0)}% inverse correlation)`,
        conflictsWith: [pos.symbol],
        recommendation: "proceed_with_caution",
      });
    }
  }

  // 3. Check currency concentration
  const hypotheticalPositions: OpenPosition[] = [
    ...openPositions,
    { ...candidate, entryPrice: 0 },
  ];
  const currencyExposure = computeCurrencyExposure(hypotheticalPositions);

  for (const exp of currencyExposure) {
    if (exp.grossExposure > cfg.maxCurrencyExposure) {
      conflicts.push({
        type: "currency_concentration",
        severity: Math.min(1.0, exp.grossExposure / (cfg.maxCurrencyExposure * 1.5)),
        detail: `${exp.currency} net exposure would be ${exp.netExposure > 0 ? "+" : ""}${exp.netExposure.toFixed(2)} lots (limit: ±${cfg.maxCurrencyExposure})`,
        conflictsWith: openPositions
          .filter((p) => p.symbol.includes(exp.currency))
          .map((p) => p.symbol),
        recommendation: exp.grossExposure > cfg.maxCurrencyExposure * 1.5 ? "skip" : "reduce_size",
      });
    }
  }

  // 4. Compute overall concentration score
  const allCorrelations = openPositions.map((pos) =>
    Math.abs(getDirectionalCorrelation(
      { symbol: candidate.symbol, direction: candidate.direction },
      { symbol: pos.symbol, direction: pos.direction },
      dynamicCorrelations,
    ))
  );
  const avgCorrelation = allCorrelations.length > 0
    ? allCorrelations.reduce((s, v) => s + v, 0) / allCorrelations.length
    : 0;
  const concentrationScore = Math.min(1.0, avgCorrelation);

  // 5. Determine approval
  const maxSeverity = conflicts.length > 0
    ? Math.max(...conflicts.map((c) => c.severity))
    : 0;
  const approved = maxSeverity < cfg.blockThreshold;

  const detail = approved
    ? `Approved: concentration score ${(concentrationScore * 100).toFixed(0)}%${conflicts.length > 0 ? ` (${conflicts.length} minor conflicts)` : ""}`
    : `Blocked: ${conflicts.filter((c) => c.severity >= cfg.blockThreshold).map((c) => c.detail).join("; ")}`;

  return {
    approved,
    conflicts,
    currencyExposure,
    concentrationScore,
    detail,
  };
}

/**
 * Compute the full correlation matrix for a set of symbols.
 * Useful for dashboard display and portfolio analytics.
 */
export function computeCorrelationMatrix(
  symbols: string[],
  dynamicCorrelations?: Record<string, Record<string, number>>,
): { symbols: string[]; matrix: number[][] } {
  const matrix: number[][] = [];
  for (let i = 0; i < symbols.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < symbols.length; j++) {
      if (i === j) {
        row.push(1.0);
      } else {
        row.push(getCorrelation(symbols[i], symbols[j], dynamicCorrelations));
      }
    }
    matrix.push(row);
  }
  return { symbols, matrix };
}
