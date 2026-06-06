/**
 * weeklyBiasDOL.ts — ICT Weekly Bias & Draw on Liquidity (DOL) Engine
 * ─────────────────────────────────────────────────────────────────────
 * Implements the ICT 2022 Mentorship top-level directional framework:
 *
 *   1. Determine Weekly DOL (where is the algorithm pulling price this week?)
 *   2. Determine Weekly Bias (bullish or bearish for the week)
 *   3. Identify Weekly liquidity pools (unswept equal highs/lows)
 *   4. Identify Weekly FVGs (major imbalances the algorithm must rebalance)
 *   5. Identify Weekly OBs (institutional zones for potential reversal)
 *
 * This module does NOT modify smcAnalysis.ts — it CALLS its exported functions.
 * Used as a top-level directional filter: if Weekly bias is bearish, the bot
 * should only look for sell setups all week (and vice versa).
 */
import type { Candle, FairValueGap, OrderBlock, LiquidityPool, SwingPoint } from "./smcAnalysis.ts";
import {
  analyzeMarketStructure,
  detectSwingPoints,
  detectFVGs,
  detectOrderBlocks,
  detectLiquidityPools,
  calculateATR,
} from "./smcAnalysis.ts";
import { confirmedTrend, type ConfirmedTrendResult } from "./directionEngine.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WeeklyDOL {
  /** The price level the algorithm is drawn to */
  price: number;
  /** What type of DOL this is */
  type: "liquidity_pool" | "fvg" | "swing_high" | "swing_low" | "previous_week_high" | "previous_week_low";
  /** Direction price must travel to reach this DOL */
  direction: "bullish" | "bearish";
  /** Distance from current price in absolute terms */
  distance: number;
  /** Human-readable label */
  label: string;
}

export interface WeeklyBiasResult {
  /** The determined weekly bias */
  bias: "bullish" | "bearish" | "neutral";
  /** Confidence 0-100 */
  confidence: number;
  /** The primary Draw on Liquidity for this week */
  primaryDOL: WeeklyDOL | null;
  /** All identified DOL targets (sorted by priority) */
  allDOLs: WeeklyDOL[];
  /** Weekly trend from confirmed MSB analysis */
  weeklyTrend: ConfirmedTrendResult;
  /** Weekly FVGs (unfilled, significant) */
  weeklyFVGs: FairValueGap[];
  /** Weekly OBs (unmitigated) */
  weeklyOBs: OrderBlock[];
  /** Weekly liquidity pools (unswept) */
  weeklyLiquidityPools: LiquidityPool[];
  /** Previous week's high */
  prevWeekHigh: number;
  /** Previous week's low */
  prevWeekLow: number;
  /** Current week's high so far */
  currentWeekHigh: number;
  /** Current week's low so far */
  currentWeekLow: number;
  /** Premium/Discount: is current price in premium or discount of weekly range? */
  weeklyPD: "premium" | "discount" | "equilibrium";
  /** Human-readable explanation */
  reason: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum weekly candles required for analysis */
const MIN_WEEKLY_CANDLES = 12;

/** FVG quality threshold for weekly (lower than intraday since weekly FVGs are rarer and more significant) */
const WEEKLY_FVG_QUALITY_THRESHOLD = 1;

// ─── Main Function ────────────────────────────────────────────────────────────

/**
 * analyzeWeeklyBiasAndDOL — Top-level ICT weekly analysis.
 *
 * @param weeklyCandles - Weekly candles (at least 12, ideally 26-52 for a year)
 * @param currentPrice - Current market price
 * @returns WeeklyBiasResult with bias, DOL, and all weekly POIs
 */
export function analyzeWeeklyBiasAndDOL(
  weeklyCandles: Candle[],
  currentPrice: number,
): WeeklyBiasResult {
  const noResult: WeeklyBiasResult = {
    bias: "neutral",
    confidence: 0,
    primaryDOL: null,
    allDOLs: [],
    weeklyTrend: { trend: "ranging", confirmedMSBs: [], lastFlipIndex: -1, reason: "insufficient data" },
    weeklyFVGs: [],
    weeklyOBs: [],
    weeklyLiquidityPools: [],
    prevWeekHigh: 0,
    prevWeekLow: 0,
    currentWeekHigh: 0,
    currentWeekLow: 0,
    weeklyPD: "equilibrium",
    reason: "Insufficient weekly candles for analysis",
  };

  if (weeklyCandles.length < MIN_WEEKLY_CANDLES) return noResult;

  // ── Step 1: Weekly Trend (confirmed MSB-based) ──
  const weeklyTrend = confirmedTrend(weeklyCandles, 0.20, 3); // Lower fib factor for weekly (20%)

  // ── Step 2: Weekly Structure Analysis ──
  const structure = analyzeMarketStructure(weeklyCandles);
  const structureBreaks = [...structure.bos, ...structure.choch];

  // ── Step 3: Weekly FVGs ──
  const allFVGs = detectFVGs(weeklyCandles, structureBreaks);
  const weeklyFVGs = allFVGs.filter(
    fvg => fvg.state !== "filled" && (fvg.quality ?? 0) >= WEEKLY_FVG_QUALITY_THRESHOLD
  );

  // ── Step 4: Weekly OBs ──
  const allOBs = detectOrderBlocks(weeklyCandles, structureBreaks);
  const weeklyOBs = allOBs.filter(ob => ob.state !== "broken" && ob.state !== "mitigated");

  // ── Step 5: Weekly Liquidity Pools ──
  // Use tighter tolerance for weekly (0.15 × ATR) since weekly swings are more significant
  const weeklyLiquidityPools = detectLiquidityPools(weeklyCandles, 0.15, 2)
    .filter(lp => !lp.swept);

  // ── Step 6: Previous Week & Current Week Levels ──
  const lastCandle = weeklyCandles[weeklyCandles.length - 1];
  const prevCandle = weeklyCandles.length >= 2 ? weeklyCandles[weeklyCandles.length - 2] : null;
  const prevWeekHigh = prevCandle?.high ?? 0;
  const prevWeekLow = prevCandle?.low ?? 0;
  const currentWeekHigh = lastCandle.high;
  const currentWeekLow = lastCandle.low;

  // ── Step 7: Weekly Premium/Discount ──
  // Define the dealing range as the last significant swing high to swing low
  const swings = detectSwingPoints(weeklyCandles, 3);
  const recentHighSwings = swings.filter(s => s.type === "high").slice(-3);
  const recentLowSwings = swings.filter(s => s.type === "low").slice(-3);
  const rangeHigh = recentHighSwings.length > 0 ? Math.max(...recentHighSwings.map(s => s.price)) : currentWeekHigh;
  const rangeLow = recentLowSwings.length > 0 ? Math.min(...recentLowSwings.map(s => s.price)) : currentWeekLow;
  const equilibrium = (rangeHigh + rangeLow) / 2;
  const rangeSize = rangeHigh - rangeLow;
  let weeklyPD: "premium" | "discount" | "equilibrium" = "equilibrium";
  if (rangeSize > 0) {
    const pricePosition = (currentPrice - rangeLow) / rangeSize;
    if (pricePosition > 0.55) weeklyPD = "premium";
    else if (pricePosition < 0.45) weeklyPD = "discount";
  }

  // ── Step 8: Identify all Draw on Liquidity targets ──
  const allDOLs: WeeklyDOL[] = [];

  // Unswept liquidity pools
  for (const lp of weeklyLiquidityPools) {
    const direction: "bullish" | "bearish" = lp.type === "buy-side" ? "bullish" : "bearish";
    allDOLs.push({
      price: lp.price,
      type: "liquidity_pool",
      direction,
      distance: Math.abs(currentPrice - lp.price),
      label: `Weekly ${lp.type} liquidity (${lp.strength} touches) @ ${lp.price.toFixed(5)}`,
    });
  }

  // Unfilled weekly FVGs
  for (const fvg of weeklyFVGs) {
    const midpoint = (fvg.high + fvg.low) / 2;
    const direction: "bullish" | "bearish" = midpoint < currentPrice ? "bearish" : "bullish";
    allDOLs.push({
      price: midpoint,
      type: "fvg",
      direction,
      distance: Math.abs(currentPrice - midpoint),
      label: `Weekly ${fvg.type} FVG @ ${fvg.low.toFixed(5)}-${fvg.high.toFixed(5)}`,
    });
  }

  // Previous week high/low (always a DOL target)
  if (prevWeekHigh > 0 && currentPrice < prevWeekHigh) {
    allDOLs.push({
      price: prevWeekHigh,
      type: "previous_week_high",
      direction: "bullish",
      distance: prevWeekHigh - currentPrice,
      label: `Previous Week High @ ${prevWeekHigh.toFixed(5)}`,
    });
  }
  if (prevWeekLow > 0 && currentPrice > prevWeekLow) {
    allDOLs.push({
      price: prevWeekLow,
      type: "previous_week_low",
      direction: "bearish",
      distance: currentPrice - prevWeekLow,
      label: `Previous Week Low @ ${prevWeekLow.toFixed(5)}`,
    });
  }

  // Recent swing highs/lows as DOL targets
  for (const swing of recentHighSwings) {
    if (swing.price > currentPrice && !allDOLs.some(d => Math.abs(d.price - swing.price) < rangeSize * 0.01)) {
      allDOLs.push({
        price: swing.price,
        type: "swing_high",
        direction: "bullish",
        distance: swing.price - currentPrice,
        label: `Weekly Swing High @ ${swing.price.toFixed(5)}`,
      });
    }
  }
  for (const swing of recentLowSwings) {
    if (swing.price < currentPrice && !allDOLs.some(d => Math.abs(d.price - swing.price) < rangeSize * 0.01)) {
      allDOLs.push({
        price: swing.price,
        type: "swing_low",
        direction: "bearish",
        distance: currentPrice - swing.price,
        label: `Weekly Swing Low @ ${swing.price.toFixed(5)}`,
      });
    }
  }

  // Sort DOLs by priority: liquidity pools first (strongest magnet), then by distance (closer = more immediate)
  allDOLs.sort((a, b) => {
    const typePriority: Record<string, number> = {
      liquidity_pool: 0,
      fvg: 1,
      previous_week_high: 2,
      previous_week_low: 2,
      swing_high: 3,
      swing_low: 3,
    };
    const pDiff = (typePriority[a.type] ?? 9) - (typePriority[b.type] ?? 9);
    if (pDiff !== 0) return pDiff;
    return a.distance - b.distance; // Closer DOL is higher priority within same type
  });

  // ── Step 9: Determine Weekly Bias ──
  // ICT's method: Weekly bias comes from the DOL direction + weekly trend alignment
  let bias: "bullish" | "bearish" | "neutral" = "neutral";
  let confidence = 0;
  const reasons: string[] = [];

  // Factor 1: Weekly confirmed trend (strongest signal)
  if (weeklyTrend.trend === "bullish") {
    bias = "bullish";
    confidence += 35;
    reasons.push(`Weekly confirmed trend: bullish`);
  } else if (weeklyTrend.trend === "bearish") {
    bias = "bearish";
    confidence += 35;
    reasons.push(`Weekly confirmed trend: bearish`);
  } else {
    reasons.push(`Weekly trend: ranging (no confirmed MSB)`);
  }

  // Factor 2: Primary DOL direction (where is the algorithm pulling price?)
  const primaryDOL = allDOLs.length > 0 ? allDOLs[0] : null;
  if (primaryDOL) {
    if (bias === "neutral") {
      bias = primaryDOL.direction;
      confidence += 25;
    } else if (bias === primaryDOL.direction) {
      confidence += 25; // DOL confirms trend
    } else {
      confidence -= 10; // DOL conflicts with trend — reduce confidence
      reasons.push(`Warning: DOL direction (${primaryDOL.direction}) conflicts with weekly trend`);
    }
    reasons.push(`Primary DOL: ${primaryDOL.label} (${primaryDOL.direction})`);
  }

  // Factor 3: Premium/Discount alignment
  // If in premium and bias is bearish → confirms (sell from premium)
  // If in discount and bias is bullish → confirms (buy from discount)
  if ((weeklyPD === "premium" && bias === "bearish") || (weeklyPD === "discount" && bias === "bullish")) {
    confidence += 15;
    reasons.push(`Price in weekly ${weeklyPD} — aligned with ${bias} bias`);
  } else if ((weeklyPD === "premium" && bias === "bullish") || (weeklyPD === "discount" && bias === "bearish")) {
    confidence -= 5;
    reasons.push(`Price in weekly ${weeklyPD} — caution: counter to ${bias} bias`);
  }

  // Factor 4: Structure break recency
  if (weeklyTrend.lastFlipIndex >= 0) {
    const candlesSinceFlip = weeklyCandles.length - 1 - weeklyTrend.lastFlipIndex;
    if (candlesSinceFlip <= 4) {
      confidence += 15; // Recent flip = strong directional conviction
      reasons.push(`Recent weekly MSB (${candlesSinceFlip} weeks ago) — strong conviction`);
    } else if (candlesSinceFlip <= 8) {
      confidence += 10;
      reasons.push(`Weekly MSB ${candlesSinceFlip} weeks ago — moderate conviction`);
    } else {
      confidence += 5;
      reasons.push(`Weekly MSB ${candlesSinceFlip} weeks ago — aging, watch for reversal`);
    }
  }

  // Factor 5: Unswept liquidity alignment
  const bullishDOLs = allDOLs.filter(d => d.direction === "bullish");
  const bearishDOLs = allDOLs.filter(d => d.direction === "bearish");
  if (bias === "bullish" && bullishDOLs.length > bearishDOLs.length) {
    confidence += 5;
  } else if (bias === "bearish" && bearishDOLs.length > bullishDOLs.length) {
    confidence += 5;
  }

  // Cap confidence
  confidence = Math.max(0, Math.min(100, confidence));

  // If confidence is too low, set bias to neutral
  if (confidence < 20) {
    bias = "neutral";
    reasons.push("Confidence too low — no clear weekly bias");
  }

  return {
    bias,
    confidence,
    primaryDOL,
    allDOLs,
    weeklyTrend,
    weeklyFVGs,
    weeklyOBs,
    weeklyLiquidityPools,
    prevWeekHigh,
    prevWeekLow,
    currentWeekHigh,
    currentWeekLow,
    weeklyPD,
    reason: reasons.join(". "),
  };
}
