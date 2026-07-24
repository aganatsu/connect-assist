/**
 * monthlyTimeframe.ts — Monthly Timeframe Integration
 * ──────────────────────────────────────────────────────────────────────────────
 * Adds monthly candle support for the ultimate structural containment check.
 *
 * The full SMC cascade is: Monthly → Weekly → Daily → 4H → Entry TF
 * Currently the bot uses Weekly → Daily → 4H → Entry.
 * This module adds the Monthly layer on top.
 *
 * Key capabilities:
 *   1. Synthesize monthly candles from daily candles (no new data source needed)
 *   2. Detect monthly OBs and key levels (monthly highs/lows)
 *   3. Check if weekly/daily zones are contained within monthly structure
 *
 * Does NOT modify smcAnalysis.ts or candleSource.ts.
 */

import type { Candle, OrderBlock, SwingPoint } from "./smcAnalysis.ts";
import { detectOrderBlocks, detectSwingPoints, calculateATR } from "./smcAnalysis.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MonthlyLevel {
  /** Type of level */
  type: "monthly_high" | "monthly_low" | "monthly_ob_high" | "monthly_ob_low" | "monthly_open";
  /** Price level */
  price: number;
  /** Which month (YYYY-MM) */
  month: string;
  /** Whether this level has been swept/tested */
  tested: boolean;
}

export interface MonthlyContainmentResult {
  /** Whether the zone is contained within monthly structure */
  isContained: boolean;
  /** The monthly level(s) providing containment */
  containingLevels: MonthlyLevel[];
  /** Monthly directional bias */
  monthlyBias: "bullish" | "bearish" | "neutral";
  /** Whether the trade direction aligns with monthly bias */
  biasAligned: boolean;
  /** Confidence in the monthly analysis (0-1) */
  confidence: number;
  /** Human-readable explanation */
  detail: string;
}

export interface MonthlyAnalysis {
  /** Synthesized monthly candles */
  monthlyCandles: Candle[];
  /** Key monthly levels */
  levels: MonthlyLevel[];
  /** Monthly order blocks */
  orderBlocks: OrderBlock[];
  /** Monthly directional bias */
  bias: "bullish" | "bearish" | "neutral";
  /** Current month's range */
  currentMonthRange: { high: number; low: number; open: number } | null;
}

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Synthesize monthly candles from daily candles.
 * Groups daily candles by calendar month and creates OHLCV aggregates.
 * This avoids needing a new data source — daily candles are already fetched.
 */
export function synthesizeMonthlyCandles(dailyCandles: Candle[]): Candle[] {
  if (!dailyCandles || dailyCandles.length < 20) return [];

  // Group by month
  const monthGroups = new Map<string, Candle[]>();

  for (const candle of dailyCandles) {
    const date = new Date(candle.datetime);
    const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

    if (!monthGroups.has(monthKey)) {
      monthGroups.set(monthKey, []);
    }
    monthGroups.get(monthKey)!.push(candle);
  }

  // Convert to monthly candles
  const monthlyCandles: Candle[] = [];
  const sortedMonths = [...monthGroups.keys()].sort();

  for (const month of sortedMonths) {
    const dailies = monthGroups.get(month)!;
    if (dailies.length === 0) continue;

    const open = dailies[0].open;
    const close = dailies[dailies.length - 1].close;
    const high = Math.max(...dailies.map(d => d.high));
    const low = Math.min(...dailies.map(d => d.low));
    const volume = dailies.reduce((sum, d) => sum + (d.volume ?? 0), 0);

    monthlyCandles.push({
      datetime: dailies[0].datetime, // First day of the month
      open,
      high,
      low,
      close,
      volume,
    });
  }

  return monthlyCandles;
}

/**
 * Run full monthly analysis: synthesize candles, detect OBs, extract key levels.
 */
export function analyzeMonthlyStructure(dailyCandles: Candle[]): MonthlyAnalysis {
  const monthlyCandles = synthesizeMonthlyCandles(dailyCandles);

  if (monthlyCandles.length < 3) {
    return {
      monthlyCandles,
      levels: [],
      orderBlocks: [],
      bias: "neutral",
      currentMonthRange: null,
    };
  }

  // Detect monthly OBs
  const orderBlocks = detectOrderBlocks(monthlyCandles);

  // Extract key levels
  const levels: MonthlyLevel[] = [];

  for (let i = 0; i < monthlyCandles.length; i++) {
    const mc = monthlyCandles[i];
    const monthStr = new Date(mc.datetime).toISOString().slice(0, 7);

    // Monthly highs and lows
    levels.push({ type: "monthly_high", price: mc.high, month: monthStr, tested: false });
    levels.push({ type: "monthly_low", price: mc.low, month: monthStr, tested: false });
    levels.push({ type: "monthly_open", price: mc.open, month: monthStr, tested: false });
  }

  // Add OB levels
  for (const ob of orderBlocks) {
    if (ob.state === "fresh" || ob.state === "tested") {
      const monthStr = new Date(ob.datetime).toISOString().slice(0, 7);
      levels.push({ type: "monthly_ob_high", price: ob.high, month: monthStr, tested: ob.state === "tested" });
      levels.push({ type: "monthly_ob_low", price: ob.low, month: monthStr, tested: ob.state === "tested" });
    }
  }

  // Determine monthly bias from last 3 months
  const bias = _determineMonthlyBias(monthlyCandles);

  // Current month range
  const lastMonth = monthlyCandles[monthlyCandles.length - 1];
  const currentMonthRange = lastMonth
    ? { high: lastMonth.high, low: lastMonth.low, open: lastMonth.open }
    : null;

  return { monthlyCandles, levels, orderBlocks, bias, currentMonthRange };
}

/**
 * Check if a zone is contained within monthly structure.
 * A zone is "contained" if it sits between monthly levels that support the trade direction.
 */
export function checkMonthlyContainment(
  zoneHigh: number,
  zoneLow: number,
  zoneDirection: "bullish" | "bearish",
  monthlyAnalysis: MonthlyAnalysis,
): MonthlyContainmentResult {
  if (monthlyAnalysis.levels.length === 0) {
    return {
      isContained: false,
      containingLevels: [],
      monthlyBias: monthlyAnalysis.bias,
      biasAligned: false,
      confidence: 0,
      detail: "No monthly levels available for containment check",
    };
  }

  const biasAligned = monthlyAnalysis.bias === zoneDirection || monthlyAnalysis.bias === "neutral";
  const containingLevels: MonthlyLevel[] = [];

  // Find monthly levels that provide structural context
  const zoneMid = (zoneHigh + zoneLow) / 2;

  // For bullish zones: look for monthly support below and monthly resistance above (room to run)
  // For bearish zones: look for monthly resistance above and monthly support below (room to run)
  for (const level of monthlyAnalysis.levels) {
    if (zoneDirection === "bullish") {
      // Monthly OB or monthly low below the zone = support
      if ((level.type === "monthly_ob_low" || level.type === "monthly_low") && level.price < zoneLow) {
        containingLevels.push(level);
      }
    } else {
      // Monthly OB or monthly high above the zone = resistance
      if ((level.type === "monthly_ob_high" || level.type === "monthly_high") && level.price > zoneHigh) {
        containingLevels.push(level);
      }
    }
  }

  // Check if zone is inside a monthly OB (strongest containment)
  const insideMonthlyOB = monthlyAnalysis.orderBlocks.some(ob => {
    if (ob.state === "broken" || ob.state === "mitigated") return false;
    if (zoneDirection === "bullish" && ob.type === "bullish") {
      return zoneLow >= ob.low && zoneHigh <= ob.high;
    }
    if (zoneDirection === "bearish" && ob.type === "bearish") {
      return zoneLow >= ob.low && zoneHigh <= ob.high;
    }
    return false;
  });

  const isContained = insideMonthlyOB || containingLevels.length >= 1;
  const confidence = insideMonthlyOB ? 0.9 : containingLevels.length >= 2 ? 0.7 : containingLevels.length === 1 ? 0.5 : 0;

  const detail = insideMonthlyOB
    ? `Zone is inside a monthly OB — strongest containment`
    : containingLevels.length > 0
      ? `Zone has ${containingLevels.length} monthly level(s) providing structural support, bias ${biasAligned ? "aligned" : "opposed"}`
      : `No monthly containment found`;

  return {
    isContained,
    containingLevels,
    monthlyBias: monthlyAnalysis.bias,
    biasAligned,
    confidence,
    detail,
  };
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function _determineMonthlyBias(monthlyCandles: Candle[]): "bullish" | "bearish" | "neutral" {
  if (monthlyCandles.length < 3) return "neutral";

  const recent = monthlyCandles.slice(-3);
  let bullishCount = 0;
  let bearishCount = 0;

  for (const mc of recent) {
    if (mc.close > mc.open) bullishCount++;
    else if (mc.close < mc.open) bearishCount++;
  }

  // Also check if making higher highs/lows (bullish) or lower highs/lows (bearish)
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const higherHighs = highs[2] > highs[1] && highs[1] > highs[0];
  const lowerLows = lows[2] < lows[1] && lows[1] < lows[0];

  if (bullishCount >= 2 && higherHighs) return "bullish";
  if (bearishCount >= 2 && lowerLows) return "bearish";
  if (bullishCount >= 2) return "bullish";
  if (bearishCount >= 2) return "bearish";
  return "neutral";
}
