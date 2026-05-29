/**
 * adaptiveWeights.ts — Adaptive Factor Weight Engine
 * ──────────────────────────────────────────────────────────────────────
 * Adjusts factor weights based on historical trade performance.
 * Factors that consistently appear in winning trades get boosted;
 * factors that appear in losers get penalized.
 *
 * The engine uses a Bayesian-inspired approach:
 *   1. Collect recent closed trades (configurable lookback window)
 *   2. For each factor, compute win-rate when factor was present
 *   3. Compare to baseline win-rate (factor absent)
 *   4. Compute edge = factor_win_rate - baseline_win_rate
 *   5. Scale the factor weight: weight * (1 + edge * sensitivity)
 *   6. Clamp to [MIN_SCALE, MAX_SCALE] to prevent runaway adjustments
 *
 * IMPORTANT: This module does NOT modify DEFAULT_FACTOR_WEIGHTS.
 * It produces an overlay map that can be merged into config.factorWeights
 * at runtime, preserving the original defaults as the "prior."
 */

import { DEFAULT_FACTOR_WEIGHTS } from "./confluenceScoring.ts";

// ─── Configuration ───────────────────────────────────────────────────

export interface AdaptiveWeightsConfig {
  /** Minimum trades required before adaptation kicks in (default: 30) */
  minTrades: number;
  /** Maximum lookback window in days (default: 90) */
  lookbackDays: number;
  /** Sensitivity multiplier for edge (default: 1.5) */
  sensitivity: number;
  /** Minimum scale factor (default: 0.3 = 30% of original weight) */
  minScale: number;
  /** Maximum scale factor (default: 2.0 = 200% of original weight) */
  maxScale: number;
  /** Minimum trades with factor present to consider it (default: 5) */
  minSampleSize: number;
  /** Whether to use regime-specific adaptation (default: true) */
  regimeAware: boolean;
  /** Decay factor for older trades (0-1, 1=no decay, default: 0.95) */
  decayPerWeek: number;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveWeightsConfig = {
  minTrades: 30,
  lookbackDays: 90,
  sensitivity: 1.5,
  minScale: 0.3,
  maxScale: 2.0,
  minSampleSize: 5,
  regimeAware: true,
  decayPerWeek: 0.95,
};

// ─── Trade Record (minimal shape needed from paper_trade_history) ────

export interface TradeRecord {
  /** Factors present at entry (from signal_reason.factorScores) */
  factors: Array<{ name: string; present: boolean; weight: number }>;
  /** P&L in pips (positive = win, negative = loss) */
  pnlPips: number;
  /** Close timestamp (ISO string or epoch ms) */
  closedAt: string | number;
  /** Market regime at entry (optional, for regime-aware mode) */
  regime?: string;
  /** Symbol traded */
  symbol?: string;
}

// ─── Factor Performance Stats ────────────────────────────────────────

export interface FactorStats {
  /** Factor key name */
  name: string;
  /** Number of trades where factor was present */
  presentCount: number;
  /** Number of winning trades where factor was present */
  presentWins: number;
  /** Win rate when factor present (0-1) */
  presentWinRate: number;
  /** Number of trades where factor was absent */
  absentCount: number;
  /** Number of winning trades where factor was absent */
  absentWins: number;
  /** Win rate when factor absent (0-1) */
  absentWinRate: number;
  /** Edge = presentWinRate - absentWinRate */
  edge: number;
  /** Computed scale factor */
  scale: number;
  /** Adapted weight (DEFAULT_FACTOR_WEIGHTS[name] * scale) */
  adaptedWeight: number;
  /** Confidence level (based on sample size) */
  confidence: "high" | "medium" | "low";
}

export interface AdaptiveWeightsResult {
  /** Adapted weight map (factor_key → new weight) */
  weights: Record<string, number>;
  /** Per-factor statistics */
  stats: FactorStats[];
  /** Overall baseline win rate */
  baselineWinRate: number;
  /** Total trades analyzed */
  totalTrades: number;
  /** Whether adaptation was applied (false if minTrades not met) */
  adapted: boolean;
  /** Regime filter applied (null if not regime-aware) */
  regime: string | null;
}

// ─── Core Engine ─────────────────────────────────────────────────────

/**
 * Compute adaptive factor weights from historical trade data.
 *
 * @param trades - Array of closed trade records with factor data
 * @param config - Adaptive weights configuration
 * @param regime - Optional: only consider trades in this regime
 * @returns AdaptiveWeightsResult with adapted weights and stats
 */
export function computeAdaptiveWeights(
  trades: TradeRecord[],
  config: Partial<AdaptiveWeightsConfig> = {},
  regime?: string,
): AdaptiveWeightsResult {
  const cfg = { ...DEFAULT_ADAPTIVE_CONFIG, ...config };
  const now = Date.now();
  const cutoffMs = now - cfg.lookbackDays * 24 * 60 * 60 * 1000;

  // Filter trades within lookback window
  let filtered = trades.filter((t) => {
    const ts = typeof t.closedAt === "number" ? t.closedAt : new Date(t.closedAt).getTime();
    return ts >= cutoffMs && Array.isArray(t.factors) && t.factors.length > 0;
  });

  // Regime filter
  const activeRegime = cfg.regimeAware && regime ? regime : null;
  if (activeRegime) {
    filtered = filtered.filter((t) => t.regime === activeRegime);
  }

  // Not enough data — return defaults unchanged
  if (filtered.length < cfg.minTrades) {
    return {
      weights: { ...DEFAULT_FACTOR_WEIGHTS },
      stats: [],
      baselineWinRate: 0,
      totalTrades: filtered.length,
      adapted: false,
      regime: activeRegime,
    };
  }

  // Apply time-decay weighting
  const weightedTrades = filtered.map((t) => {
    const ts = typeof t.closedAt === "number" ? t.closedAt : new Date(t.closedAt).getTime();
    const weeksAgo = (now - ts) / (7 * 24 * 60 * 60 * 1000);
    const decay = Math.pow(cfg.decayPerWeek, weeksAgo);
    return { ...t, decay };
  });

  // Baseline win rate (all trades)
  const totalDecayedWeight = weightedTrades.reduce((sum, t) => sum + t.decay, 0);
  const totalDecayedWins = weightedTrades
    .filter((t) => t.pnlPips > 0)
    .reduce((sum, t) => sum + t.decay, 0);
  const baselineWinRate = totalDecayedWeight > 0 ? totalDecayedWins / totalDecayedWeight : 0;

  // Per-factor analysis
  const factorKeys = Object.keys(DEFAULT_FACTOR_WEIGHTS);
  const stats: FactorStats[] = [];

  for (const factorKey of factorKeys) {
    // Split trades by factor presence
    const present = weightedTrades.filter((t) =>
      t.factors.some((f) => f.name === factorKey && f.present)
    );
    const absent = weightedTrades.filter((t) =>
      !t.factors.some((f) => f.name === factorKey && f.present)
    );

    const presentDecaySum = present.reduce((s, t) => s + t.decay, 0);
    const presentWinSum = present.filter((t) => t.pnlPips > 0).reduce((s, t) => s + t.decay, 0);
    const absentDecaySum = absent.reduce((s, t) => s + t.decay, 0);
    const absentWinSum = absent.filter((t) => t.pnlPips > 0).reduce((s, t) => s + t.decay, 0);

    const presentWinRate = presentDecaySum > 0 ? presentWinSum / presentDecaySum : 0;
    const absentWinRate = absentDecaySum > 0 ? absentWinSum / absentDecaySum : baselineWinRate;

    const edge = presentWinRate - absentWinRate;

    // Determine confidence based on sample size
    const confidence: "high" | "medium" | "low" =
      present.length >= cfg.minSampleSize * 4 ? "high" :
      present.length >= cfg.minSampleSize ? "medium" : "low";

    // Only adapt if we have enough samples
    let scale = 1.0;
    if (present.length >= cfg.minSampleSize) {
      // Scale = 1 + (edge * sensitivity), clamped
      scale = 1 + edge * cfg.sensitivity;
      scale = Math.max(cfg.minScale, Math.min(cfg.maxScale, scale));
      // Reduce adjustment for low-confidence factors
      if (confidence === "low") {
        scale = 1 + (scale - 1) * 0.25; // 25% of computed adjustment
      } else if (confidence === "medium") {
        scale = 1 + (scale - 1) * 0.6; // 60% of computed adjustment
      }
    }

    const defaultWeight = DEFAULT_FACTOR_WEIGHTS[factorKey] ?? 1.0;
    const adaptedWeight = Math.round(defaultWeight * scale * 1000) / 1000;

    stats.push({
      name: factorKey,
      presentCount: present.length,
      presentWins: present.filter((t) => t.pnlPips > 0).length,
      presentWinRate,
      absentCount: absent.length,
      absentWins: absent.filter((t) => t.pnlPips > 0).length,
      absentWinRate,
      edge,
      scale,
      adaptedWeight,
      confidence,
    });
  }

  // Build adapted weights map
  const weights: Record<string, number> = {};
  for (const s of stats) {
    weights[s.name] = s.adaptedWeight;
  }

  return {
    weights,
    stats,
    baselineWinRate,
    totalTrades: filtered.length,
    adapted: true,
    regime: activeRegime,
  };
}

/**
 * Parse factor data from a paper_trade_history signal_reason JSON.
 * Handles both the factorScores array format and the legacy format.
 */
export function parseTradeFactors(signalReason: string | Record<string, any>): Array<{ name: string; present: boolean; weight: number }> {
  try {
    const parsed = typeof signalReason === "string" ? JSON.parse(signalReason) : signalReason;
    if (Array.isArray(parsed?.factorScores)) {
      return parsed.factorScores.map((f: any) => ({
        name: f.name || "",
        present: f.present ?? false,
        weight: f.weight ?? 0,
      }));
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Convert raw paper_trade_history rows into TradeRecord format.
 */
export function toTradeRecords(rows: Array<{
  pnl_pips?: string | number;
  pnl?: string | number;
  closed_at?: string;
  signal_reason?: string;
  regime?: string;
  symbol?: string;
}>): TradeRecord[] {
  return rows
    .map((row) => {
      const factors = parseTradeFactors(row.signal_reason || "{}");
      if (factors.length === 0) return null;
      const pnlPips = typeof row.pnl_pips === "string" ? parseFloat(row.pnl_pips) : (row.pnl_pips ?? 0);
      return {
        factors,
        pnlPips: Number.isFinite(pnlPips) ? pnlPips : 0,
        closedAt: row.closed_at || new Date().toISOString(),
        regime: row.regime,
        symbol: row.symbol,
      } as TradeRecord;
    })
    .filter((r): r is TradeRecord => r !== null);
}

/**
 * Merge adaptive weights into a config object's factorWeights.
 * Returns a new factorWeights map that can be passed to the scoring engine.
 */
export function mergeAdaptiveWeights(
  existingWeights: Record<string, number> | undefined,
  adaptiveResult: AdaptiveWeightsResult,
): Record<string, number> {
  if (!adaptiveResult.adapted) {
    return existingWeights || { ...DEFAULT_FACTOR_WEIGHTS };
  }
  return { ...(existingWeights || DEFAULT_FACTOR_WEIGHTS), ...adaptiveResult.weights };
}
