/**
 * directionEngine.ts — Simplified multi-timeframe direction determination
 *
 * ICT top-down flow:
 *   Daily sets bias → 4H confirms structure intact (retrace, no CHoCH) → 1H confirms turn (BOS in bias direction)
 *
 * Option C for ranging daily: fall back to 4H trend if it has clear structure (2+ BOS, no recent CHoCH).
 * Both ranging → null (no trade).
 *
 * This module is called from bot-scanner BEFORE runConfluenceAnalysis.
 * The result is passed as config._overrideDirection so confluenceScoring uses it.
 */

import { analyzeMarketStructure, detectSwingPoints, calculateATR, type Candle, type StructureBreak, type SwingPoint } from "./smcAnalysis.ts";

// ── Confirmed Trend (fib-extension-filtered MSBs for stable macro-trend) ──

export interface ConfirmedTrendResult {
  trend: "bullish" | "bearish" | "ranging";
  confirmedMSBs: { type: "bullish" | "bearish"; price: number; extension: number }[];
  lastFlipIndex: number;  // candle index of the last confirmed trend flip
  reason: string;
}

/**
 * confirmedTrend — Stable macro-trend determination using fib-extension-filtered MSBs.
 *
 * Unlike analyzeMarketStructure().trend (which flips on every new swing pair),
 * this function only flips the trend when a swing break exceeds the previous swing
 * by a configurable percentage of the swing range (like TradingView's MSB indicator).
 *
 * This provides:
 *   - Hysteresis: trend doesn't flip on noise
 *   - Stability: requires decisive breaks, not marginal ones
 *   - Coarser swings: uses lookback=5 + higher ATR filter for significant pivots only
 *
 * @param candles - Price candles (daily or 4H)
 * @param fibFactor - Minimum extension beyond previous swing as fraction of swing range (default: 0.25 = 25%)
 * @param swingLookback - Lookback for swing detection (default: 5, coarser than entry-level 3)
 */
export function confirmedTrend(
  candles: Candle[],
  fibFactor = 0.25,
  swingLookback = 5,
): ConfirmedTrendResult {
  const noTrend: ConfirmedTrendResult = {
    trend: "ranging",
    confirmedMSBs: [],
    lastFlipIndex: -1,
    reason: "insufficient data",
  };

  if (candles.length < swingLookback * 2 + 5) return noTrend;

  // Use coarser swing detection with higher ATR filter for significant pivots
  const atrFilter = 0.4; // 40% of ATR — only significant swings
  const swings = detectSwingPoints(candles, swingLookback, atrFilter);

  const highs = swings.filter(s => s.type === "high");
  const lows = swings.filter(s => s.type === "low");

  if (highs.length < 2 || lows.length < 2) {
    return { ...noTrend, reason: `insufficient swings (${highs.length} highs, ${lows.length} lows)` };
  }

  // Process swing breaks chronologically with fib extension filter
  type BreakEvent = {
    index: number;
    swingType: "high" | "low";
    prevLevel: number;
    currentLevel: number;
    swingRange: number; // range between the broken swing and the opposite extreme
    extension: number;  // how far past the previous swing (as fraction of swingRange)
  };

  const events: BreakEvent[] = [];

  // For each consecutive pair of swing highs, check if the later one broke the earlier
  for (let i = 1; i < highs.length; i++) {
    const prev = highs[i - 1];
    const curr = highs[i];
    if (curr.price > prev.price) {
      // Find the lowest low between these two highs for swing range calculation
      const lowestBetween = lows
        .filter(l => l.index > prev.index && l.index < curr.index)
        .reduce((min, l) => l.price < min ? l.price : min, prev.price);
      const swingRange = prev.price - lowestBetween;
      const extensionAbs = curr.price - prev.price;
      const extension = swingRange > 0 ? extensionAbs / swingRange : 0;
      events.push({
        index: curr.index,
        swingType: "high",
        prevLevel: prev.price,
        currentLevel: curr.price,
        swingRange,
        extension,
      });
    }
  }

  for (let i = 1; i < lows.length; i++) {
    const prev = lows[i - 1];
    const curr = lows[i];
    if (curr.price < prev.price) {
      // Find the highest high between these two lows for swing range calculation
      const highestBetween = highs
        .filter(h => h.index > prev.index && h.index < curr.index)
        .reduce((max, h) => h.price > max ? h.price : max, prev.price);
      const swingRange = highestBetween - prev.price;
      const extensionAbs = prev.price - curr.price;
      const extension = swingRange > 0 ? extensionAbs / swingRange : 0;
      events.push({
        index: curr.index,
        swingType: "low",
        prevLevel: prev.price,
        currentLevel: curr.price,
        swingRange,
        extension,
      });
    }
  }

  // Sort chronologically
  events.sort((a, b) => a.index - b.index);

  // Walk through events, only flip trend on confirmed MSBs (extension >= fibFactor)
  let currentTrend: "bullish" | "bearish" | "ranging" = "ranging";
  let lastFlipIndex = -1;
  const confirmedMSBs: { type: "bullish" | "bearish"; price: number; extension: number }[] = [];

  for (const evt of events) {
    if (evt.extension < fibFactor) continue; // Not a confirmed MSB — skip

    if (evt.swingType === "high") {
      // Higher high with sufficient extension = bullish MSB
      if (currentTrend !== "bullish") {
        currentTrend = "bullish";
        lastFlipIndex = evt.index;
      }
      confirmedMSBs.push({ type: "bullish", price: evt.currentLevel, extension: evt.extension });
    } else {
      // Lower low with sufficient extension = bearish MSB
      if (currentTrend !== "bearish") {
        currentTrend = "bearish";
        lastFlipIndex = evt.index;
      }
      confirmedMSBs.push({ type: "bearish", price: evt.currentLevel, extension: evt.extension });
    }
  }

  // Build reason string
  const bullishMSBs = confirmedMSBs.filter(m => m.type === "bullish");
  const bearishMSBs = confirmedMSBs.filter(m => m.type === "bearish");
  const lastMSB = confirmedMSBs.length > 0 ? confirmedMSBs[confirmedMSBs.length - 1] : null;
  const reason = currentTrend === "ranging"
    ? `No confirmed MSBs (${events.length} breaks found, none exceeded ${(fibFactor * 100).toFixed(0)}% extension threshold)`
    : `${currentTrend} (${bullishMSBs.length} bull MSBs, ${bearishMSBs.length} bear MSBs, last: ${lastMSB?.type} at ${lastMSB?.price.toFixed(5)} ext=${((lastMSB?.extension ?? 0) * 100).toFixed(0)}%)`;

  return {
    trend: currentTrend,
    confirmedMSBs,
    lastFlipIndex,
    reason,
  };
}

// ── Public types ──

export interface DirectionResult {
  direction: "long" | "short" | null;
  bias: "bullish" | "bearish" | null;       // the HTF bias that set the direction
  biasSource: "daily" | "4h" | null;        // which TF provided the bias
  h4Retrace: boolean;                       // true = 4H is pulling back without CHoCH
  h4ChochAgainst: boolean;                  // true = 4H CHoCH against bias → hard block
  h1Confirmed: boolean;                     // true = 1H BOS in bias direction
  reason: string;                           // human-readable explanation
}

// ── Configuration ──

interface DirectionConfig {
  /** Number of recent 4H candles to check for CHoCH (default: 10) */
  h4ChochLookback?: number;
  /** Number of recent 1H candles to check for BOS confirmation (default: 8) */
  h1BosLookback?: number;
  /** Minimum BOS count for 4H to be considered a "clear trend" in ranging daily fallback (default: 2) */
  h4MinBosForFallback?: number;
  /** Fib extension factor for confirmedTrend (default: 0.25 = 25% of swing range) */
  fibFactor?: number;
  /** Swing lookback for confirmedTrend (default: 5, coarser than entry-level) */
  trendSwingLookback?: number;
  /** Whether to use confirmedTrend for bias determination (default: true) */
  useConfirmedTrend?: boolean;
}

const DEFAULTS = {
  h4ChochLookback: 10,
  h1BosLookback: 8,
  h4MinBosForFallback: 2,
  fibFactor: 0.25,
  trendSwingLookback: 5,
  useConfirmedTrend: true,
};

// ── Helper: extract recent breaks from structure ──

function recentBreaks(
  breaks: StructureBreak[],
  totalCandles: number,
  lookback: number,
): StructureBreak[] {
  const cutoff = totalCandles - lookback;
  return breaks.filter(b => b.index >= cutoff);
}

// ── Helper: determine trend direction from structure ──

function trendToBias(trend: string): "bullish" | "bearish" | null {
  if (trend === "bullish") return "bullish";
  if (trend === "bearish") return "bearish";
  return null;
}

function biasToDirction(bias: "bullish" | "bearish"): "long" | "short" {
  return bias === "bullish" ? "long" : "short";
}

// ── Helper: format swing prices for reason strings ──

function formatSwingPrices(
  structure: ReturnType<typeof analyzeMarketStructure>,
): { highsStr: string; lowsStr: string } {
  const highs = structure.swingPoints.filter(s => s.type === "high").slice(-2);
  const lows = structure.swingPoints.filter(s => s.type === "low").slice(-2);
  const highsStr = highs.length >= 2
    ? `SH: ${highs[0].price.toFixed(5)}→${highs[1].price.toFixed(5)}`
    : highs.length === 1 ? `SH: ${highs[0].price.toFixed(5)}` : "SH: none";
  const lowsStr = lows.length >= 2
    ? `SL: ${lows[0].price.toFixed(5)}→${lows[1].price.toFixed(5)}`
    : lows.length === 1 ? `SL: ${lows[0].price.toFixed(5)}` : "SL: none";
  return { highsStr, lowsStr };
}

function rangingReason(tf: string, structure: ReturnType<typeof analyzeMarketStructure>): string {
  const { highsStr, lowsStr } = formatSwingPrices(structure);
  return `${tf} ranging (${highsStr}, ${lowsStr} — no consistent HH/HL or LH/LL)`;
}

// ── Helper: check if 4H is retracing (pulling back without CHoCH) ──

function is4HRetracing(
  h4Structure: ReturnType<typeof analyzeMarketStructure>,
  bias: "bullish" | "bearish",
  h4Candles: Candle[],
  chochLookback: number,
): { retracing: boolean; chochAgainst: boolean; reason: string } {
  const recentChoch = recentBreaks(h4Structure.choch, h4Candles.length, chochLookback);

  // Check for CHoCH against the bias direction
  // Bullish bias → bearish CHoCH = against. Bearish bias → bullish CHoCH = against.
  const oppositeType = bias === "bullish" ? "bearish" : "bullish";
  const chochAgainst = recentChoch.some(c => c.type === oppositeType);

  if (chochAgainst) {
    const chochPrices = recentChoch.filter(c => c.type === oppositeType).map(c => c.price.toFixed(5)).join(", ");
    return {
      retracing: false,
      chochAgainst: true,
      reason: `4H CHoCH against ${bias} bias (${recentChoch.filter(c => c.type === oppositeType).length} recent ${oppositeType} CHoCH at ${chochPrices})`,
    };
  }

  // No CHoCH against bias → check if price is pulling back
  const swings = h4Structure.swingPoints;
  const lastPrice = h4Candles[h4Candles.length - 1].close;

  if (bias === "bullish") {
    const recentHighs = swings.filter(s => s.type === "high").slice(-3);
    const recentLows = swings.filter(s => s.type === "low").slice(-3);
    const highestRecent = recentHighs.length > 0 ? Math.max(...recentHighs.map(s => s.price)) : null;
    const highPrices = recentHighs.map(s => s.price.toFixed(5)).join(", ");
    const lowPrices = recentLows.map(s => s.price.toFixed(5)).join(", ");
    if (highestRecent !== null && lastPrice < highestRecent) {
      return {
        retracing: true,
        chochAgainst: false,
        reason: `4H retracing in bullish structure (price ${lastPrice.toFixed(5)} below swing high ${highestRecent.toFixed(5)}, no CHoCH) [4H highs: ${highPrices}] [4H lows: ${lowPrices}]`,
      };
    }
    // Price at or above highs — not retracing, structure intact
    return {
      retracing: false,
      chochAgainst: false,
      reason: `4H bullish structure intact (price ${lastPrice.toFixed(5)} at/above highs) [4H highs: ${highPrices}] [4H lows: ${lowPrices}]`,
    };
  } else {
    const recentLows = swings.filter(s => s.type === "low").slice(-3);
    const recentHighs = swings.filter(s => s.type === "high").slice(-3);
    const lowestRecent = recentLows.length > 0 ? Math.min(...recentLows.map(s => s.price)) : null;
    const lowPrices = recentLows.map(s => s.price.toFixed(5)).join(", ");
    const highPrices = recentHighs.map(s => s.price.toFixed(5)).join(", ");
    if (lowestRecent !== null && lastPrice > lowestRecent) {
      return {
        retracing: true,
        chochAgainst: false,
        reason: `4H retracing in bearish structure (price ${lastPrice.toFixed(5)} above swing low ${lowestRecent.toFixed(5)}, no CHoCH) [4H highs: ${highPrices}] [4H lows: ${lowPrices}]`,
      };
    }
    return {
      retracing: false,
      chochAgainst: false,
      reason: `4H bearish structure intact (price ${lastPrice.toFixed(5)} at/below lows) [4H highs: ${highPrices}] [4H lows: ${lowPrices}]`,
    };
  }
}

// ── Helper: check if 1H confirms the turn ──

function is1HConfirmed(
  h1Structure: ReturnType<typeof analyzeMarketStructure>,
  bias: "bullish" | "bearish",
  h1Candles: Candle[],
  bosLookback: number,
): { confirmed: boolean; reason: string } {
  const recentBos = recentBreaks(h1Structure.bos, h1Candles.length, bosLookback);

  // Look for BOS in the bias direction
  const biasType = bias; // "bullish" or "bearish"
  const confirmingBos = recentBos.filter(b => b.type === biasType);

  if (confirmingBos.length > 0) {
    const latest = confirmingBos[confirmingBos.length - 1];
    const recency = h1Candles.length - 1 - latest.index;
    return {
      confirmed: true,
      reason: `1H ${biasType} BOS confirmed (${confirmingBos.length} recent, latest ${recency} candles ago at ${latest.price.toFixed(5)})`,
    };
  }

  // Also accept CHoCH in bias direction as confirmation (CHoCH = even stronger signal)
  const recentChoch = recentBreaks(h1Structure.choch, h1Candles.length, bosLookback);
  const confirmingChoch = recentChoch.filter(c => c.type === biasType);

  if (confirmingChoch.length > 0) {
    const latest = confirmingChoch[confirmingChoch.length - 1];
    const recency = h1Candles.length - 1 - latest.index;
    return {
      confirmed: true,
      reason: `1H ${biasType} CHoCH confirmed turn (${recency} candles ago at ${latest.price.toFixed(5)})`,
    };
  }

  return {
    confirmed: false,
    reason: `1H has no recent ${biasType} BOS or CHoCH (checked last ${bosLookback} candles)`,
  };
}

// ── Main: determineDirection ──

export function determineDirection(
  dailyCandles: Candle[] | null,
  h4Candles: Candle[] | null,
  h1Candles: Candle[] | null,
  config?: DirectionConfig,
): DirectionResult {
  const h4ChochLookback = config?.h4ChochLookback ?? DEFAULTS.h4ChochLookback;
  const h1BosLookback = config?.h1BosLookback ?? DEFAULTS.h1BosLookback;
  const h4MinBos = config?.h4MinBosForFallback ?? DEFAULTS.h4MinBosForFallback;

  const noDirection: DirectionResult = {
    direction: null, bias: null, biasSource: null,
    h4Retrace: false, h4ChochAgainst: false, h1Confirmed: false,
    reason: "",
  };

  const fibFactor = config?.fibFactor ?? DEFAULTS.fibFactor;
  const trendSwingLookback = config?.trendSwingLookback ?? DEFAULTS.trendSwingLookback;
  const useConfirmedTrend = config?.useConfirmedTrend ?? DEFAULTS.useConfirmedTrend;

  // ── Step 1: Determine bias from Daily ──
  let bias: "bullish" | "bearish" | null = null;
  let biasSource: "daily" | "4h" | null = null;

  if (dailyCandles && dailyCandles.length >= 20) {
    // Use confirmedTrend (fib-extension-filtered) for stable macro-trend determination
    let dailyTrend: "bullish" | "bearish" | "ranging";
    let dailyTrendReason: string;
    if (useConfirmedTrend) {
      const ct = confirmedTrend(dailyCandles, fibFactor, trendSwingLookback);
      dailyTrend = ct.trend;
      dailyTrendReason = `[confirmedTrend] ${ct.reason}`;
    } else {
      const dailyStructure = analyzeMarketStructure(dailyCandles);
      dailyTrend = dailyStructure.trend;
      dailyTrendReason = `[legacyTrend] last-2-swings`;
    }
    bias = trendToBias(dailyTrend);

    if (bias) {
      biasSource = "daily";
    } else {
      // Daily is ranging → Option C: fall back to 4H
      const dailyStructure = analyzeMarketStructure(dailyCandles);
      const dailyRanging = `Daily ranging (${dailyTrendReason})`;
      if (h4Candles && h4Candles.length >= 20) {
        // Use confirmedTrend for 4H fallback too
        let h4Trend: "bullish" | "bearish" | "ranging";
        let h4TrendReason: string;
        if (useConfirmedTrend) {
          const ct = confirmedTrend(h4Candles, fibFactor, trendSwingLookback);
          h4Trend = ct.trend;
          h4TrendReason = `[confirmedTrend] ${ct.reason}`;
        } else {
          const h4Struct = analyzeMarketStructure(h4Candles);
          h4Trend = h4Struct.trend;
          h4TrendReason = `[legacyTrend] last-2-swings`;
        }
        const h4Bias = trendToBias(h4Trend);

        if (h4Bias) {
          // Verify 4H has clear structure: enough BOS, no recent CHoCH against
          const h4Structure = analyzeMarketStructure(h4Candles);
          const recentH4Bos = h4Structure.bos.filter(b => b.type === h4Bias);
          const recentH4ChochAgainst = recentBreaks(
            h4Structure.choch, h4Candles.length, h4ChochLookback
          ).filter(c => c.type === (h4Bias === "bullish" ? "bearish" : "bullish"));

          if (recentH4Bos.length >= h4MinBos && recentH4ChochAgainst.length === 0) {
            bias = h4Bias;
            biasSource = "4h";
          } else {
            const { highsStr, lowsStr } = formatSwingPrices(h4Structure);
            return {
              ...noDirection,
              reason: `${dailyRanging} | 4H ${h4Bias} but weak structure (${recentH4Bos.length} BOS, ${recentH4ChochAgainst.length} opposing CHoCH) [${highsStr}, ${lowsStr}] → no trade`,
            };
          }
        } else {
          // Both daily and 4H ranging → no trade
          return {
            ...noDirection,
            reason: `${dailyRanging} | 4H also ranging (${h4TrendReason}) → no directional edge, no trade`,
          };
        }
      } else {
        return {
          ...noDirection,
          reason: `${dailyRanging} | insufficient 4H candles for fallback → no trade`,
        };
      }
    }
  } else if (!dailyCandles || dailyCandles.length < 20) {
    return {
      ...noDirection,
      reason: `Insufficient daily candles (${dailyCandles?.length ?? 0}, need 20) → cannot determine bias`,
    };
  }

  // At this point we have a bias and biasSource
  const direction = biasToDirction(bias!);

  // ── Step 2: Check 4H structure — retrace or CHoCH against? ──
  if (!h4Candles || h4Candles.length < 20) {
    // No 4H data — we have a bias but can't confirm 4H structure
    // Allow the trade but note the missing confirmation
    if (!h1Candles || h1Candles.length < 20) {
      return {
        direction, bias: bias!, biasSource: biasSource!,
        h4Retrace: false, h4ChochAgainst: false, h1Confirmed: false,
        reason: `${biasSource} ${bias} bias → ${direction}, but no 4H/1H data for confirmation`,
      };
    }
    // Have 1H but no 4H — check 1H confirmation only
    const h1Structure = analyzeMarketStructure(h1Candles);
    const h1Check = is1HConfirmed(h1Structure, bias!, h1Candles, h1BosLookback);

    return {
      direction: h1Check.confirmed ? direction : null,
      bias: bias!, biasSource: biasSource!,
      h4Retrace: false, h4ChochAgainst: false,
      h1Confirmed: h1Check.confirmed,
      reason: h1Check.confirmed
        ? `${biasSource} ${bias} → ${direction} | No 4H data | ${h1Check.reason}`
        : `${biasSource} ${bias} but 1H not confirmed: ${h1Check.reason} → no trade`,
    };
  }

  const h4Structure = analyzeMarketStructure(h4Candles);
  const h4Check = is4HRetracing(h4Structure, bias!, h4Candles, h4ChochLookback);

  // ── Hard block: 4H CHoCH against bias ──
  if (h4Check.chochAgainst) {
    return {
      direction: null, bias: bias!, biasSource: biasSource!,
      h4Retrace: false, h4ChochAgainst: true, h1Confirmed: false,
      reason: `${biasSource} ${bias} bias BUT ${h4Check.reason} → BLOCKED`,
    };
  }

  // ── Hard block: 4H trend opposes daily bias ──
  // Catches the case where the CHoCH that flipped 4H happened outside the lookback window
  // but 4H is still trending against the daily bias (recent BOS confirms the opposing trend).
  if (h4Structure.trend !== "ranging" && h4Structure.trend !== bias) {
    return {
      direction: null, bias: bias!, biasSource: biasSource!,
      h4Retrace: false, h4ChochAgainst: true, h1Confirmed: false,
      reason: `${biasSource} ${bias} bias BUT 4H trend is ${h4Structure.trend} (opposes bias) → BLOCKED`,
    };
  }

  // ── Step 3: Check 1H confirmation ──
  if (!h1Candles || h1Candles.length < 20) {
    return {
      direction: h4Check.retracing ? direction : direction,
      bias: bias!, biasSource: biasSource!,
      h4Retrace: h4Check.retracing, h4ChochAgainst: false, h1Confirmed: false,
      reason: `${biasSource} ${bias} → ${direction} | ${h4Check.reason} | No 1H data for confirmation`,
    };
  }

  const h1Structure = analyzeMarketStructure(h1Candles);
  const h1Check = is1HConfirmed(h1Structure, bias!, h1Candles, h1BosLookback);

  // ── Final decision ──
  if (h4Check.retracing && h1Check.confirmed) {
    // Ideal setup: 4H retracing + 1H confirms turn
    return {
      direction, bias: bias!, biasSource: biasSource!,
      h4Retrace: true, h4ChochAgainst: false, h1Confirmed: true,
      reason: `✓ ${biasSource} ${bias} → ${direction} | ${h4Check.reason} | ${h1Check.reason}`,
    };
  }

  if (!h4Check.retracing && h1Check.confirmed) {
    // 4H not retracing (at highs/lows) but 1H confirmed — still valid, just not the ideal pullback entry
    return {
      direction, bias: bias!, biasSource: biasSource!,
      h4Retrace: false, h4ChochAgainst: false, h1Confirmed: true,
      reason: `${biasSource} ${bias} → ${direction} | ${h4Check.reason} | ${h1Check.reason} (continuation, not pullback)`,
    };
  }

  // ── Hysteresis: check for 1H CHoCH AGAINST bias ──
  // If 1H hasn't confirmed (BOS rolled off window), we only nullify direction
  // when there's an active opposing signal (CHoCH against bias).
  // Absence of confirmation ≠ invalidation.
  const oppositeType = bias === "bullish" ? "bearish" : "bullish";
  const recentH1Choch = recentBreaks(h1Structure.choch, h1Candles.length, h1BosLookback);
  const h1ChochAgainst = recentH1Choch.filter(c => c.type === oppositeType);
  const hasOpposingSignal = h1ChochAgainst.length > 0;

  if (h4Check.retracing && !h1Check.confirmed) {
    if (hasOpposingSignal) {
      const chochPrices = h1ChochAgainst.map(c => c.price.toFixed(5)).join(", ");
      // 4H retracing + 1H CHoCH against bias → genuine reversal signal, nullify
      return {
        direction: null, bias: bias!, biasSource: biasSource!,
        h4Retrace: true, h4ChochAgainst: false, h1Confirmed: false,
        reason: `${biasSource} ${bias} | ${h4Check.reason} | 1H CHoCH against bias (${h1ChochAgainst.length} ${oppositeType} at ${chochPrices}) → direction nullified`,
      };
    }
    // No opposing CHoCH → direction holds (hysteresis: BOS rolled off but no reversal)
    return {
      direction, bias: bias!, biasSource: biasSource!,
      h4Retrace: true, h4ChochAgainst: false, h1Confirmed: false,
      reason: `${biasSource} ${bias} → ${direction} | ${h4Check.reason} | ${h1Check.reason} → direction maintained (no opposing 1H CHoCH)`,
    };
  }

  // 4H not retracing, 1H not confirmed
  if (hasOpposingSignal) {
    const chochPrices = h1ChochAgainst.map(c => c.price.toFixed(5)).join(", ");
    // 1H CHoCH against bias → genuine reversal signal, nullify
    return {
      direction: null, bias: bias!, biasSource: biasSource!,
      h4Retrace: false, h4ChochAgainst: false, h1Confirmed: false,
      reason: `${biasSource} ${bias} | ${h4Check.reason} | 1H CHoCH against bias (${h1ChochAgainst.length} ${oppositeType} at ${chochPrices}) → direction nullified`,
    };
  }
  // No opposing CHoCH → direction holds (hysteresis: structure intact, no reversal)
  return {
    direction, bias: bias!, biasSource: biasSource!,
    h4Retrace: false, h4ChochAgainst: false, h1Confirmed: false,
    reason: `${biasSource} ${bias} → ${direction} | ${h4Check.reason} | ${h1Check.reason} → direction maintained (no opposing 1H CHoCH)`,
  };
}
