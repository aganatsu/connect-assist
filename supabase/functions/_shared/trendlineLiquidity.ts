/**
 * trendlineLiquidity.ts — Trendline Detection & Liquidity Trap Analysis
 * ──────────────────────────────────────────────────────────────────────────────
 * Detects multi-touch trendlines and identifies liquidity traps:
 *
 *   - 3rd touch = valid trendline (tradeable)
 *   - 4th touch = liquidity trap (institutions hunt stops placed at trendline)
 *   - Broken trendline = potential entry zone (zones below broken trendline are high-quality)
 *
 * This provides a new confluence factor for the scoring engine.
 * Does NOT modify smcAnalysis.ts.
 */

import type { Candle, SwingPoint } from "./smcAnalysis.ts";
import { detectSwingPoints, calculateATR } from "./smcAnalysis.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Trendline {
  /** Starting swing point */
  startPoint: { price: number; index: number };
  /** Ending swing point (most recent touch used for slope calculation) */
  endPoint: { price: number; index: number };
  /** Direction: ascending (support) or descending (resistance) */
  direction: "ascending" | "descending";
  /** Number of valid touches */
  touchCount: number;
  /** Indices of all touch candles */
  touchIndices: number[];
  /** Slope per candle (price change per bar) */
  slope: number;
  /** Whether the trendline has been broken */
  broken: boolean;
  /** Index where the trendline was broken (if applicable) */
  brokenAtIndex: number | null;
  /** Current projected price at the latest candle */
  currentProjectedPrice: number;
  /** Whether this is a liquidity trap (4th+ touch) */
  isLiquidityTrap: boolean;
  /** Confidence in the trendline (based on touches, time, precision) */
  confidence: number;
}

export interface TrendlineResult {
  /** All detected trendlines */
  trendlines: Trendline[];
  /** Active (unbroken) trendlines */
  activeTrendlines: Trendline[];
  /** Trendlines that are liquidity traps (4th+ touch) */
  trapTrendlines: Trendline[];
  /** Recently broken trendlines (potential entry zones below/above) */
  brokenTrendlines: Trendline[];
}

export interface TrendlineConfig {
  /** Minimum touches to qualify as a trendline (default: 3) */
  minTouches: number;
  /** Touch tolerance as ATR multiple (default: 0.3) — how close price must be to the line */
  touchToleranceATR: number;
  /** Maximum candles to look back for trendline detection (default: 100) */
  maxLookback: number;
  /** Touches required to be considered a trap (default: 4) */
  trapTouchThreshold: number;
  /** Maximum candles since break to consider trendline "recently broken" (default: 10) */
  recentBreakWindow: number;
}

export const DEFAULT_TRENDLINE_CONFIG: TrendlineConfig = {
  minTouches: 3,
  touchToleranceATR: 0.3,
  maxLookback: 100,
  trapTouchThreshold: 4,
  recentBreakWindow: 10,
};

// ─── Core Detection ───────────────────────────────────────────────────────────

/**
 * Detect trendlines from swing points and evaluate their liquidity trap potential.
 *
 * Algorithm:
 *   1. Get swing highs and swing lows
 *   2. For each pair of same-type swings, project a line
 *   3. Count how many other swings touch the line (within tolerance)
 *   4. Lines with 3+ touches = valid trendline
 *   5. Lines with 4+ touches = liquidity trap
 *   6. Check if any trendline has been broken by recent price action
 */
export function detectTrendlines(
  candles: Candle[],
  config: Partial<TrendlineConfig> = {},
): TrendlineResult {
  const cfg = { ...DEFAULT_TRENDLINE_CONFIG, ...config };

  if (!candles || candles.length < 20) {
    return { trendlines: [], activeTrendlines: [], trapTrendlines: [], brokenTrendlines: [] };
  }

  const atr = calculateATR(candles, 14);
  if (atr <= 0) {
    return { trendlines: [], activeTrendlines: [], trapTrendlines: [], brokenTrendlines: [] };
  }

  const tolerance = atr * cfg.touchToleranceATR;
  const lookbackCandles = candles.slice(-cfg.maxLookback);
  const offset = candles.length - lookbackCandles.length;

  // Detect swing points
  const swings = detectSwingPoints(lookbackCandles, 3, 0);
  const swingHighs = swings.filter(s => s.type === "high");
  const swingLows = swings.filter(s => s.type === "low");

  const trendlines: Trendline[] = [];

  // Detect ascending trendlines (connecting swing lows)
  const ascendingLines = _findTrendlinesFromSwings(swingLows, lookbackCandles, tolerance, cfg, offset, "ascending");
  trendlines.push(...ascendingLines);

  // Detect descending trendlines (connecting swing highs)
  const descendingLines = _findTrendlinesFromSwings(swingHighs, lookbackCandles, tolerance, cfg, offset, "descending");
  trendlines.push(...descendingLines);

  // Check for breaks
  const lastIndex = candles.length - 1;
  for (const tl of trendlines) {
    _checkTrendlineBreak(tl, candles, lastIndex, tolerance);
  }

  // Classify
  const activeTrendlines = trendlines.filter(t => !t.broken);
  const trapTrendlines = trendlines.filter(t => t.isLiquidityTrap && !t.broken);
  const brokenTrendlines = trendlines.filter(t =>
    t.broken && t.brokenAtIndex !== null && (lastIndex - t.brokenAtIndex) <= cfg.recentBreakWindow
  );

  return { trendlines, activeTrendlines, trapTrendlines, brokenTrendlines };
}

/**
 * Check if a zone is near a trendline trap (4th touch area).
 * Used as a confluence factor — zones near trap trendlines should be penalized.
 */
export function isZoneNearTrendlineTrap(
  zoneHigh: number,
  zoneLow: number,
  trendlineResult: TrendlineResult,
  toleranceMultiplier = 2.0,
  atr = 0.001,
): { nearTrap: boolean; trapTrendline: Trendline | null; detail: string } {
  const tolerance = atr * toleranceMultiplier;

  for (const trap of trendlineResult.trapTrendlines) {
    const trendlinePrice = trap.currentProjectedPrice;
    // Check if zone overlaps with trendline projected price
    if (trendlinePrice >= zoneLow - tolerance && trendlinePrice <= zoneHigh + tolerance) {
      return {
        nearTrap: true,
        trapTrendline: trap,
        detail: `Zone overlaps with ${trap.direction} trendline trap (${trap.touchCount} touches, projected at ${trendlinePrice.toFixed(5)})`,
      };
    }
  }

  return { nearTrap: false, trapTrendline: null, detail: "No trendline trap near zone" };
}

/**
 * Check if a zone is below a recently broken descending trendline (bullish signal)
 * or above a recently broken ascending trendline (bearish signal).
 */
export function isZoneBelowBrokenTrendline(
  zoneHigh: number,
  zoneLow: number,
  zoneDirection: "bullish" | "bearish",
  trendlineResult: TrendlineResult,
): { belowBroken: boolean; brokenTrendline: Trendline | null; detail: string } {
  for (const broken of trendlineResult.brokenTrendlines) {
    if (zoneDirection === "bullish" && broken.direction === "descending") {
      // Bullish zone below a broken descending trendline = high quality
      if (zoneHigh < broken.currentProjectedPrice) {
        return {
          belowBroken: true,
          brokenTrendline: broken,
          detail: `Bullish zone below broken descending trendline (${broken.touchCount} touches) — high quality`,
        };
      }
    } else if (zoneDirection === "bearish" && broken.direction === "ascending") {
      // Bearish zone above a broken ascending trendline = high quality
      if (zoneLow > broken.currentProjectedPrice) {
        return {
          belowBroken: true,
          brokenTrendline: broken,
          detail: `Bearish zone above broken ascending trendline (${broken.touchCount} touches) — high quality`,
        };
      }
    }
  }

  return { belowBroken: false, brokenTrendline: null, detail: "No relevant broken trendline" };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function _findTrendlinesFromSwings(
  swings: SwingPoint[],
  candles: Candle[],
  tolerance: number,
  cfg: TrendlineConfig,
  indexOffset: number,
  direction: "ascending" | "descending",
): Trendline[] {
  const trendlines: Trendline[] = [];

  if (swings.length < 2) return trendlines;

  // Try all pairs of swings as potential trendline anchors
  for (let i = 0; i < swings.length - 1; i++) {
    for (let j = i + 1; j < swings.length; j++) {
      const s1 = swings[i];
      const s2 = swings[j];

      // Skip if too close together
      if (s2.index - s1.index < 5) continue;

      const slope = (s2.price - s1.price) / (s2.index - s1.index);

      // Validate slope direction
      if (direction === "ascending" && slope <= 0) continue;
      if (direction === "descending" && slope >= 0) continue;

      // Count touches
      const touchIndices: number[] = [s1.index + indexOffset, s2.index + indexOffset];

      for (let k = 0; k < swings.length; k++) {
        if (k === i || k === j) continue;
        const s = swings[k];
        const projectedPrice = s1.price + slope * (s.index - s1.index);
        if (Math.abs(s.price - projectedPrice) <= tolerance) {
          touchIndices.push(s.index + indexOffset);
        }
      }

      if (touchIndices.length >= cfg.minTouches) {
        // Project to current candle
        const lastCandleIdx = candles.length - 1;
        const currentProjectedPrice = s1.price + slope * (lastCandleIdx - s1.index);

        const isLiquidityTrap = touchIndices.length >= cfg.trapTouchThreshold;
        const confidence = Math.min(0.95, 0.4 + touchIndices.length * 0.1 + (s2.index - s1.index) * 0.002);

        trendlines.push({
          startPoint: { price: s1.price, index: s1.index + indexOffset },
          endPoint: { price: s2.price, index: s2.index + indexOffset },
          direction,
          touchCount: touchIndices.length,
          touchIndices: touchIndices.sort((a, b) => a - b),
          slope,
          broken: false,
          brokenAtIndex: null,
          currentProjectedPrice,
          isLiquidityTrap,
          confidence,
        });
      }
    }
  }

  // Deduplicate: keep the trendline with most touches for overlapping lines
  return _deduplicateTrendlines(trendlines);
}

function _checkTrendlineBreak(
  tl: Trendline,
  candles: Candle[],
  lastIndex: number,
  tolerance: number,
): void {
  // Check last few candles for a break
  const checkFrom = Math.max(0, lastIndex - 5);
  for (let i = checkFrom; i <= lastIndex; i++) {
    const c = candles[i];
    // Project trendline to this candle's index
    const barsFromStart = i - tl.startPoint.index;
    const projectedPrice = tl.startPoint.price + tl.slope * barsFromStart;

    if (tl.direction === "ascending") {
      // Ascending trendline broken when candle CLOSES below it
      if (c.close < projectedPrice - tolerance) {
        tl.broken = true;
        tl.brokenAtIndex = i;
        return;
      }
    } else {
      // Descending trendline broken when candle CLOSES above it
      if (c.close > projectedPrice + tolerance) {
        tl.broken = true;
        tl.brokenAtIndex = i;
        return;
      }
    }
  }
}

function _deduplicateTrendlines(trendlines: Trendline[]): Trendline[] {
  if (trendlines.length <= 1) return trendlines;

  // Sort by touch count descending
  const sorted = [...trendlines].sort((a, b) => b.touchCount - a.touchCount);
  const kept: Trendline[] = [];

  for (const tl of sorted) {
    // Check if this trendline is too similar to one already kept
    const isDuplicate = kept.some(existing => {
      const slopeDiff = Math.abs(existing.slope - tl.slope);
      const startDiff = Math.abs(existing.startPoint.price - tl.startPoint.price);
      return slopeDiff < 0.00001 && startDiff < 0.0005;
    });

    if (!isDuplicate) {
      kept.push(tl);
    }
  }

  return kept;
}
