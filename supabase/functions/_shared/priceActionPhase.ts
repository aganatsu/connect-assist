/**
 * priceActionPhase.ts — Price-Action Market Phase Detection
 * ──────────────────────────────────────────────────────────────────────────────
 * Detects whether the market is in Consolidation, Expansion, or Trend phase
 * using PRICE ACTION (not time-based AMD).
 *
 * Key use cases:
 *   1. Filter out OBs formed during consolidation (low-quality zones)
 *   2. Identify expansion breakouts (high-quality entry conditions)
 *   3. Provide phase context for confluence scoring
 *
 * This module does NOT modify smcAnalysis.ts — it imports and wraps its functions.
 */

import {
  type Candle,
  type InstrumentRegime,
  type RegimeTransition,
  classifyInstrumentRegime,
  calculateATR,
  detectSwingPoints,
} from "./smcAnalysis.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MarketPhase = "consolidation" | "expansion" | "trend";

export interface PhaseResult {
  /** Current market phase */
  phase: MarketPhase;
  /** Confidence in the classification (0-1) */
  confidence: number;
  /** Raw regime score from classifyInstrumentRegime (-14 to +14) */
  regimeScore: number;
  /** Regime transition state if detected */
  transition: string | null;
  /** If in consolidation, the detected range bounds */
  consolidationRange: { high: number; low: number } | null;
  /** Human-readable explanation */
  detail: string;
  /** The full regime result for downstream consumers */
  regime: Omit<InstrumentRegime, "symbol">;
}

export interface PhaseConfig {
  /** Regime score threshold below which = consolidation (default: -2) */
  consolidationThreshold: number;
  /** Regime score threshold above which = trend (default: 6) */
  trendThreshold: number;
  /** Number of candles to look back for consolidation range detection (default: 20) */
  rangeLookback: number;
  /** ATR multiplier for consolidation range width cap (default: 3.0) — if 20-candle range < 3*ATR, it's consolidation */
  rangeWidthATRCap: number;
}

export const DEFAULT_PHASE_CONFIG: PhaseConfig = {
  consolidationThreshold: -2,
  trendThreshold: 6,
  rangeLookback: 20,
  rangeWidthATRCap: 3.0,
};

// ─── Core Phase Detection ─────────────────────────────────────────────────────

/**
 * Detect the current market phase from price action.
 *
 * Uses the existing classifyInstrumentRegime() as the backbone, then layers
 * additional checks for consolidation range detection and expansion identification.
 *
 * Phase mapping:
 *   - regimeScore ≤ consolidationThreshold AND range is tight → CONSOLIDATION
 *   - regimeScore ≥ trendThreshold → TREND
 *   - Everything else (including "range_to_trending" transitions) → EXPANSION
 */
export function detectMarketPhase(
  candles: Candle[],
  config: Partial<PhaseConfig> = {},
): PhaseResult {
  const cfg = { ...DEFAULT_PHASE_CONFIG, ...config };

  // Insufficient data fallback
  if (!candles || candles.length < 20) {
    return {
      phase: "consolidation",
      confidence: 0,
      regimeScore: 0,
      transition: null,
      consolidationRange: null,
      detail: "Insufficient candle data for phase detection",
      regime: { regime: "unknown", confidence: 0, indicators: [], atr14: 0, atrTrend: "stable", directionalBias: "neutral", rangePercent: 0 },
    };
  }

  // Run the existing regime classifier
  const regime = classifyInstrumentRegime(candles);
  const regimeScore = _extractRegimeScore(regime);
  const transition = regime.transition?.state ?? null;

  // Detect consolidation range
  const consolidationRange = _detectConsolidationRange(candles, cfg);
  const atr = calculateATR(candles, 14);
  const rangeWidth = consolidationRange ? consolidationRange.high - consolidationRange.low : Infinity;
  const isRangeTight = atr > 0 && rangeWidth < atr * cfg.rangeWidthATRCap;

  // Phase classification
  let phase: MarketPhase;
  let confidence: number;
  let detail: string;

  if (regimeScore >= cfg.trendThreshold) {
    // Strong directional movement sustained
    phase = "trend";
    confidence = Math.min(0.95, 0.6 + (regimeScore - cfg.trendThreshold) * 0.07);
    detail = `Trend phase: regime score ${regimeScore} (≥${cfg.trendThreshold}), ${regime.directionalBias} bias, ATR ${regime.atrTrend}`;
  } else if (regimeScore <= cfg.consolidationThreshold && isRangeTight) {
    // Low regime score AND price is contained in a tight range
    phase = "consolidation";
    confidence = Math.min(0.95, 0.5 + Math.abs(regimeScore - cfg.consolidationThreshold) * 0.06);
    detail = `Consolidation phase: regime score ${regimeScore} (≤${cfg.consolidationThreshold}), range width ${rangeWidth.toFixed(5)} < ${cfg.rangeWidthATRCap}×ATR (${(atr * cfg.rangeWidthATRCap).toFixed(5)})`;
  } else if (regimeScore <= cfg.consolidationThreshold && !isRangeTight) {
    // Low regime score but range is wide — choppy, not true consolidation
    // Still classify as consolidation but with lower confidence
    phase = "consolidation";
    confidence = Math.min(0.6, 0.3 + Math.abs(regimeScore) * 0.03);
    detail = `Choppy consolidation: regime score ${regimeScore}, range wide (${rangeWidth.toFixed(5)} ≥ ${cfg.rangeWidthATRCap}×ATR) — not a clean consolidation box`;
  } else if (transition === "range_to_trending") {
    // Transitioning from range to trend — this IS the expansion phase
    phase = "expansion";
    confidence = regime.transition?.confidence ?? 0.6;
    detail = `Expansion phase: regime transitioning range→trend (score ${regimeScore}, momentum ${regime.transition?.momentum?.toFixed(2) ?? "?"})`;
  } else if (regimeScore > cfg.consolidationThreshold && regimeScore < cfg.trendThreshold) {
    // Middle ground — could be expansion or early trend
    // Use ATR trend to differentiate: expanding ATR = expansion, stable/contracting = mild trend
    if (regime.atrTrend === "expanding") {
      phase = "expansion";
      confidence = 0.5 + (regimeScore / 14) * 0.3;
      detail = `Expansion phase: regime score ${regimeScore} (mid-range), ATR expanding — directional move building`;
    } else {
      // Mild trend or late expansion
      // Use a relative midpoint between consolidation and trend thresholds
      const midpoint = Math.floor((cfg.consolidationThreshold + cfg.trendThreshold) / 2);
      phase = regimeScore >= midpoint ? "trend" : "expansion";
      confidence = 0.4 + (regimeScore / 14) * 0.2;
      detail = `${phase === "trend" ? "Mild trend" : "Late expansion"}: regime score ${regimeScore}, ATR ${regime.atrTrend}`;
    }
  } else {
    // Fallback — shouldn't reach here but handle gracefully
    phase = "expansion";
    confidence = 0.3;
    detail = `Uncertain phase: regime score ${regimeScore}, classified as expansion by default`;
  }

  return {
    phase,
    confidence,
    regimeScore,
    transition,
    consolidationRange: phase === "consolidation" ? consolidationRange : null,
    detail,
    regime,
  };
}

// ─── OB Consolidation Check ──────────────────────────────────────────────────

/**
 * Determine if an Order Block was formed during a consolidation phase.
 *
 * Looks at the candles AROUND the OB formation (windowSize candles before and after)
 * and runs phase detection on that local window. If the local window is in consolidation,
 * the OB is considered low-quality.
 *
 * @param obIndex - The candle index where the OB was formed
 * @param candles - Full candle array (same array used for OB detection)
 * @param windowSize - Number of candles around the OB to analyze (default: 20)
 * @returns true if the OB was formed during consolidation
 */
export function wasOBFormedInConsolidation(
  obIndex: number,
  candles: Candle[],
  windowSize = 20,
): boolean {
  if (!candles || candles.length < 20) return false;

  // Extract a window of candles centered on the OB
  const halfWindow = Math.floor(windowSize / 2);
  const start = Math.max(0, obIndex - halfWindow);
  const end = Math.min(candles.length, obIndex + halfWindow);
  const window = candles.slice(start, end);

  if (window.length < 15) return false; // Need minimum data for reliable detection

  // Run phase detection on the local window
  const localPhase = detectMarketPhase(window, {
    // Use slightly stricter thresholds for local windows (less data = less certainty)
    consolidationThreshold: -1,
    rangeLookback: Math.min(15, window.length),
  });

  return localPhase.phase === "consolidation" && localPhase.confidence >= 0.4;
}

/**
 * Batch-check multiple OB indices for consolidation context.
 * More efficient than calling wasOBFormedInConsolidation() in a loop
 * because it pre-computes sliding windows.
 */
export function filterOBsByPhaseContext(
  obIndices: number[],
  candles: Candle[],
  windowSize = 20,
): { index: number; inConsolidation: boolean; phase: MarketPhase; confidence: number }[] {
  return obIndices.map(idx => {
    const halfWindow = Math.floor(windowSize / 2);
    const start = Math.max(0, idx - halfWindow);
    const end = Math.min(candles.length, idx + halfWindow);
    const window = candles.slice(start, end);

    if (window.length < 15) {
      return { index: idx, inConsolidation: false, phase: "expansion" as MarketPhase, confidence: 0 };
    }

    const result = detectMarketPhase(window, {
      consolidationThreshold: -1,
      rangeLookback: Math.min(15, window.length),
    });

    return {
      index: idx,
      inConsolidation: result.phase === "consolidation" && result.confidence >= 0.4,
      phase: result.phase,
      confidence: result.confidence,
    };
  });
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Extract the numeric regime score from the InstrumentRegime result.
 * The score is embedded in the indicators array as "Total regime score: X/14".
 */
function _extractRegimeScore(regime: Omit<InstrumentRegime, "symbol">): number {
  // The regime score is in the indicators array
  for (const indicator of regime.indicators) {
    const match = indicator.match(/Total regime score:\s*(-?\d+)/);
    if (match) return parseInt(match[1], 10);
  }
  // Fallback: infer from regime label
  switch (regime.regime) {
    case "strong_trend": return 10;
    case "mild_trend": return 5;
    case "transitional": return 0;
    case "mild_range": return -5;
    case "choppy_range": return -10;
    default: return 0;
  }
}

/**
 * Detect the consolidation range (highest high and lowest low of recent candles).
 * Used to determine if price is contained in a box.
 */
function _detectConsolidationRange(
  candles: Candle[],
  cfg: PhaseConfig,
): { high: number; low: number } | null {
  const lookback = Math.min(cfg.rangeLookback, candles.length);
  const recent = candles.slice(-lookback);

  if (recent.length < 5) return null;

  const high = Math.max(...recent.map(c => c.high));
  const low = Math.min(...recent.map(c => c.low));

  return { high, low };
}
