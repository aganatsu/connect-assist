/**
 * ipdaRanges.ts — IPDA (Interbank Price Delivery Algorithm) Data Ranges
 *
 * Calculates the 20, 40, and 60-day lookback ranges used in ICT methodology.
 * These ranges represent institutional reference levels where smart money
 * is likely targeting for liquidity.
 *
 * Each range produces:
 *   - High: the highest price in the lookback window
 *   - Low: the lowest price in the lookback window
 *   - Midpoint: (high + low) / 2 — equilibrium level
 *
 * Usage:
 *   - IPDA highs/lows serve as draw-on-liquidity targets
 *   - The midpoint acts as an equilibrium (fair value) reference
 *   - Price trading above the 60-day midpoint = bullish institutional bias
 *   - Price trading below the 60-day midpoint = bearish institutional bias
 *   - Nested ranges (20 inside 40 inside 60) show institutional time horizons
 */

import type { Candle } from "./smcAnalysis.ts";
import type { KeyLevel } from "./gamePlan.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IPDARange {
  /** Lookback period in trading days */
  period: 20 | 40 | 60;
  /** Highest price in the range */
  high: number;
  /** Lowest price in the range */
  low: number;
  /** Midpoint (equilibrium) */
  midpoint: number;
  /** Number of candles actually used (may be less than period if insufficient data) */
  candlesUsed: number;
}

export interface IPDARanges {
  /** 20-day range (short-term institutional) */
  range20: IPDARange | null;
  /** 40-day range (medium-term institutional) */
  range40: IPDARange | null;
  /** 60-day range (long-term institutional) */
  range60: IPDARange | null;
  /** Current price position relative to 60-day range (0 = at low, 100 = at high) */
  positionPercent60: number | null;
  /** Institutional bias based on price vs 60-day midpoint */
  institutionalBias: "bullish" | "bearish" | "neutral";
}

// ─── Core Calculation ───────────────────────────────────────────────────────

/**
 * Calculate a single IPDA range from the most recent N daily candles.
 * Uses the last `period` candles EXCLUDING the current (incomplete) day.
 */
function calculateSingleRange(
  dailyCandles: Candle[],
  period: 20 | 40 | 60,
): IPDARange | null {
  // Need at least `period` candles (we exclude the last one as it may be incomplete)
  // But allow partial ranges if we have at least 10 candles
  const usableCandles = dailyCandles.slice(0, -1); // exclude current day
  if (usableCandles.length < Math.min(period, 10)) return null;

  const lookback = usableCandles.slice(-period); // take the last N
  const high = Math.max(...lookback.map(c => c.high));
  const low = Math.min(...lookback.map(c => c.low));
  const midpoint = (high + low) / 2;

  return {
    period,
    high,
    low,
    midpoint,
    candlesUsed: lookback.length,
  };
}

/**
 * Calculate all three IPDA ranges (20, 40, 60 days).
 *
 * @param dailyCandles - Daily candle array, newest last
 * @param lastPrice - Current price for position calculation
 * @returns IPDARanges with all three ranges and institutional bias
 */
export function calculateIPDARanges(
  dailyCandles: Candle[],
  lastPrice: number,
): IPDARanges {
  const range20 = calculateSingleRange(dailyCandles, 20);
  const range40 = calculateSingleRange(dailyCandles, 40);
  const range60 = calculateSingleRange(dailyCandles, 60);

  // Position within the 60-day range (0% = at low, 100% = at high)
  let positionPercent60: number | null = null;
  let institutionalBias: "bullish" | "bearish" | "neutral" = "neutral";

  if (range60) {
    const rangeSize = range60.high - range60.low;
    if (rangeSize > 0) {
      const rawPercent = ((lastPrice - range60.low) / rangeSize) * 100;
      // Clamp to -10..110 (price can be slightly outside the range)
      positionPercent60 = Math.max(-10, Math.min(110, rawPercent));

      // Institutional bias: above midpoint = bullish, below = bearish
      // Use a 5% dead zone around midpoint for "neutral"
      if (rawPercent > 55) {
        institutionalBias = "bullish";
      } else if (rawPercent < 45) {
        institutionalBias = "bearish";
      } else {
        institutionalBias = "neutral";
      }
    }
  }

  return {
    range20,
    range40,
    range60,
    positionPercent60,
    institutionalBias,
  };
}

// ─── Key Level Conversion ───────────────────────────────────────────────────

/**
 * Convert IPDA ranges into KeyLevel objects for integration with the game plan.
 * Only includes levels within a reasonable distance from current price
 * (within 300 pips, matching the existing key level radius).
 *
 * @param ipdaRanges - Calculated IPDA ranges
 * @param lastPrice - Current price for distance filtering
 * @param pipSize - Pip size for the instrument
 * @returns Array of KeyLevel objects
 */
export function ipdaRangesToKeyLevels(
  ipdaRanges: IPDARanges,
  lastPrice: number,
  pipSize: number,
): KeyLevel[] {
  const levels: KeyLevel[] = [];
  const maxDistancePips = 300;

  const ranges = [
    { range: ipdaRanges.range20, label: "20d" },
    { range: ipdaRanges.range40, label: "40d" },
    { range: ipdaRanges.range60, label: "60d" },
  ];

  for (const { range, label } of ranges) {
    if (!range) continue;

    const candidates = [
      { price: range.high, desc: `IPDA ${label} High`, type: "resistance" as const },
      { price: range.low, desc: `IPDA ${label} Low`, type: "support" as const },
      { price: range.midpoint, desc: `IPDA ${label} EQ`, type: "pd_level" as const },
    ];

    for (const candidate of candidates) {
      const distPips = Math.abs(candidate.price - lastPrice) / pipSize;
      if (distPips <= maxDistancePips) {
        // Significance: 60d = high, 40d = high, 20d = medium
        const significance = range.period >= 40 ? "high" : "medium";
        levels.push({
          price: candidate.price,
          label: candidate.desc,
          type: candidate.type,
          significance: significance as "high" | "medium" | "low",
        });
      }
    }
  }

  return levels;
}
