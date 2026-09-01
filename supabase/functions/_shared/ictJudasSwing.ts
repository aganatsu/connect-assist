/**
 * ictJudasSwing.ts — ICT Judas Swing / Liquidity Sweep Confirmation
 * ═══════════════════════════════════════════════════════════════════
 *
 * ICT Rule: Before a valid MSS, price should sweep liquidity on the opposite side.
 * The "Judas Swing" is a false move that takes out stops/liquidity BEFORE the real
 * move begins. The sequence is:
 *
 *   For a BULLISH setup:
 *     1. Price sweeps below a swing low (takes sell-side liquidity)
 *     2. Price reverses with displacement (MSS to the upside)
 *     3. FVG/OB forms → entry
 *
 *   For a BEARISH setup:
 *     1. Price sweeps above a swing high (takes buy-side liquidity)
 *     2. Price reverses with displacement (MSS to the downside)
 *     3. FVG/OB forms → entry
 *
 * This module checks whether a liquidity sweep occurred before the structure shift.
 *
 * Gate modes: "hard" | "soft" | "off"
 */

import type { Candle } from "./smcAnalysis.ts";

// ─── Configuration ────────────────────────────────────────────────────
export interface JudasSwingConfig {
  enabled: boolean;
  gateMode: "hard" | "soft" | "off";
  /** Max candles before the MSS to look for a sweep */
  sweepLookback: number;
  /** Minimum wick depth past the swing level to qualify as a sweep (ATR multiple) */
  minSweepDepthATR: number;
  /** The sweep candle must close back inside (wick through + close back = sweep, not BOS) */
  requireCloseBack: boolean;
  /** Score penalty when no Judas swing found (soft mode) */
  noSweepPenalty: number;
  /** Score bonus when a clean Judas swing is confirmed */
  sweepConfirmedBonus: number;
}

export const DEFAULT_JUDAS_SWING_CONFIG: JudasSwingConfig = {
  enabled: true,
  gateMode: "off",
  sweepLookback: 10,
  minSweepDepthATR: 0.1,
  requireCloseBack: true,
  noSweepPenalty: -1.5,
  sweepConfirmedBonus: 1.0,
};

// ─── Types ────────────────────────────────────────────────────────────
export interface SweepCandidate {
  index: number;
  sweptLevel: number;
  wickDepth: number;
  wickDepthATR: number;
  closedBack: boolean;
  direction: "bullish" | "bearish"; // bullish = swept lows (buy-side setup), bearish = swept highs
}

export interface JudasSwingResult {
  found: boolean;
  sweep: SweepCandidate | null;
  scoreAdjustment: number;
  passed: boolean;
  reason: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function calculateATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) {
    const ranges = candles.map(c => c.high - c.low).filter(r => r > 0);
    return ranges.length > 0 ? ranges.reduce((a, b) => a + b, 0) / ranges.length : 0;
  }
  let atrSum = 0;
  const start = candles.length - period;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    atrSum += tr;
  }
  return atrSum / period;
}

/**
 * Find swing highs and lows using a simple lookback method.
 * Returns the most recent N swing points before a given index.
 */
function findRecentSwings(
  candles: Candle[],
  beforeIndex: number,
  lookback: number,
  count: number,
): { highs: { index: number; price: number }[]; lows: { index: number; price: number }[] } {
  const highs: { index: number; price: number }[] = [];
  const lows: { index: number; price: number }[] = [];

  const start = Math.max(lookback, 0);
  const end = Math.min(beforeIndex, candles.length - 1);

  for (let i = start; i <= end - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    const c = candles[i];

    for (let j = 1; j <= lookback; j++) {
      if (i - j >= 0 && candles[i - j].high >= c.high) isHigh = false;
      if (i + j < candles.length && i + j <= end && candles[i + j].high >= c.high) isHigh = false;
      if (i - j >= 0 && candles[i - j].low <= c.low) isLow = false;
      if (i + j < candles.length && i + j <= end && candles[i + j].low <= c.low) isLow = false;
    }

    if (isHigh) highs.push({ index: i, price: c.high });
    if (isLow) lows.push({ index: i, price: c.low });
  }

  // Return most recent ones
  return {
    highs: highs.slice(-count),
    lows: lows.slice(-count),
  };
}

// ─── Main Detection Function ──────────────────────────────────────────

/**
 * Check if a Judas Swing (liquidity sweep) occurred before the MSS.
 *
 * @param candles - Full candle array
 * @param mssIndex - Index of the MSS candle (structure break)
 * @param tradeDirection - Direction of the intended trade
 *   "bullish" → look for sweep of lows (sell-side liquidity taken)
 *   "bearish" → look for sweep of highs (buy-side liquidity taken)
 * @param config - Configuration
 */
export function detectJudasSwing(
  candles: Candle[],
  mssIndex: number,
  tradeDirection: "bullish" | "bearish",
  config: JudasSwingConfig = DEFAULT_JUDAS_SWING_CONFIG,
): JudasSwingResult {
  const noSweep: JudasSwingResult = {
    found: false,
    sweep: null,
    scoreAdjustment: 0,
    passed: true,
    reason: "",
  };

  if (!config.enabled) {
    return { ...noSweep, reason: "Judas Swing detection disabled" };
  }

  if (mssIndex < 10 || mssIndex >= candles.length) {
    return { ...noSweep, reason: "Insufficient data for Judas Swing detection" };
  }

  // Calculate ATR from candles before the sweep window
  const atrEnd = Math.max(0, mssIndex - config.sweepLookback);
  const atrCandles = candles.slice(0, atrEnd > 14 ? atrEnd : mssIndex);
  const atr = calculateATR(atrCandles);
  if (atr <= 0) {
    return { ...noSweep, reason: "Cannot calculate ATR" };
  }

  // Find swing levels that could have been swept
  const swingSearchEnd = Math.max(0, mssIndex - 1);
  const swings = findRecentSwings(candles, swingSearchEnd, 3, 5);

  // For bullish trade: look for sweep of lows (price wicked below a swing low then closed back)
  // For bearish trade: look for sweep of highs (price wicked above a swing high then closed back)
  const sweepStart = Math.max(0, mssIndex - config.sweepLookback);
  const sweepEnd = mssIndex; // sweep must happen before or at the MSS

  let bestSweep: SweepCandidate | null = null;

  if (tradeDirection === "bullish") {
    // Look for sell-side liquidity sweep (price went below swing lows)
    for (const swingLow of swings.lows) {
      for (let i = sweepStart; i < sweepEnd; i++) {
        const c = candles[i];
        if (c.low < swingLow.price) {
          const wickDepth = swingLow.price - c.low;
          const wickDepthATR = wickDepth / atr;
          const closedBack = c.close > swingLow.price;

          if (wickDepthATR >= config.minSweepDepthATR) {
            if (!config.requireCloseBack || closedBack) {
              const candidate: SweepCandidate = {
                index: i,
                sweptLevel: swingLow.price,
                wickDepth,
                wickDepthATR,
                closedBack,
                direction: "bullish",
              };
              // Keep the most recent and deepest sweep
              if (!bestSweep || i > bestSweep.index || wickDepthATR > bestSweep.wickDepthATR) {
                bestSweep = candidate;
              }
            }
          }
        }
      }
    }
  } else {
    // Look for buy-side liquidity sweep (price went above swing highs)
    for (const swingHigh of swings.highs) {
      for (let i = sweepStart; i < sweepEnd; i++) {
        const c = candles[i];
        if (c.high > swingHigh.price) {
          const wickDepth = c.high - swingHigh.price;
          const wickDepthATR = wickDepth / atr;
          const closedBack = c.close < swingHigh.price;

          if (wickDepthATR >= config.minSweepDepthATR) {
            if (!config.requireCloseBack || closedBack) {
              const candidate: SweepCandidate = {
                index: i,
                sweptLevel: swingHigh.price,
                wickDepth,
                wickDepthATR,
                closedBack,
                direction: "bearish",
              };
              if (!bestSweep || i > bestSweep.index || wickDepthATR > bestSweep.wickDepthATR) {
                bestSweep = candidate;
              }
            }
          }
        }
      }
    }
  }

  // Gate decision
  const found = bestSweep !== null;
  let passed = true;
  let scoreAdjustment = 0;
  let reason = "";

  if (config.gateMode === "off") {
    passed = true;
    scoreAdjustment = 0;
    reason = found
      ? `[OFF] Judas Swing confirmed: swept ${bestSweep!.sweptLevel.toFixed(5)} by ${bestSweep!.wickDepthATR.toFixed(2)}x ATR`
      : `[OFF] No Judas Swing found before MSS — would have ${config.gateMode === "hard" ? "blocked" : "penalized"}`;
  } else if (!found) {
    if (config.gateMode === "hard") {
      passed = false;
      reason = `Judas Swing BLOCKED: no liquidity sweep found before ${tradeDirection} MSS`;
    } else {
      passed = true;
      scoreAdjustment = config.noSweepPenalty;
      reason = `No Judas Swing: ${config.noSweepPenalty} penalty applied`;
    }
  } else {
    passed = true;
    scoreAdjustment = config.sweepConfirmedBonus;
    reason = `Judas Swing confirmed: swept ${bestSweep!.sweptLevel.toFixed(5)} (${bestSweep!.wickDepthATR.toFixed(2)}x ATR depth, closed back: ${bestSweep!.closedBack})`;
  }

  return { found, sweep: bestSweep, scoreAdjustment, passed, reason };
}
