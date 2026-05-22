/**
 * Zone Confirmation Entry Module
 * 
 * Implements the ICT 2022 confirmation entry model:
 * When price enters an impulse zone, instead of immediately filling,
 * the bot waits for a 5-minute CHoCH (Change of Character) confirming
 * that price is actually reversing at the zone before entering.
 * 
 * Flow: Zone touch → Confirmation hunt (5m CHoCH) → Entry at live price
 * 
 * References:
 * - ICT 2022 Mentorship Model (MSS on LTF as entry trigger)
 * - DailyPriceAction SMC Strategy (5min CHoCH at zone)
 * - FluxCharts CHoCH detection (close-based, displacement-filtered)
 */

import { analyzeMarketStructure, type Candle } from "./smcAnalysis.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type { Candle };

export interface ConfirmationSignal {
  type: "bearish_choch" | "bullish_choch" | "bearish_engulfing" | "bullish_engulfing" | "rejection_wick";
  price: number;              // price at confirmation (candle close)
  candleIndex: number;        // index in the candle array
  displacement: number;       // body/range ratio (0-1), higher = stronger
  significance: "internal" | "external" | undefined;
  closeBased: boolean;        // true = candle body closed through (strong)
  supportingSignals: string[]; // additional confirmation factors
}

export interface ZoneConfirmationConfig {
  enabled: boolean;                    // default: true (when izGateMode === "hard")
  confirmationTimeframe: string;       // default: "5m"
  minDisplacement: number;             // default: 0.5 (50% body ratio)
  requireCloseBased: boolean;          // default: true
  maxLookbackCandles: number;          // default: 6 (30 min on 5m = only recent CHoCH)
  resetOnZoneExit: boolean;            // default: true
}

export const DEFAULT_ZONE_CONFIRMATION_CONFIG: ZoneConfirmationConfig = {
  enabled: true,
  confirmationTimeframe: "5m",
  minDisplacement: 0.5,
  requireCloseBased: true,
  maxLookbackCandles: 6,
  resetOnZoneExit: true,
};

// ─── Main Detection Function ─────────────────────────────────────────────────

/**
 * Detect zone confirmation signal on 5-minute candles.
 * 
 * For a SELL setup: looks for bearish CHoCH (price was making HH/HL, then breaks below recent HL)
 * For a BUY setup: looks for bullish CHoCH (price was making LL/LH, then breaks above recent LH)
 * 
 * @param candles5m - 5-minute candles (at least 20-30 for structure detection)
 * @param direction - "long" or "short" (the trade direction we want to confirm)
 * @param config - confirmation configuration
 * @param zoneTouchIndex - optional: the candle index when price first touched the zone
 *                         (only CHoCHs AFTER this index are valid)
 * @returns ConfirmationSignal if found, null otherwise
 */
export function detectZoneConfirmation(
  candles5m: Candle[],
  direction: "long" | "short",
  config: ZoneConfirmationConfig = DEFAULT_ZONE_CONFIRMATION_CONFIG,
  zoneTouchIndex?: number,
): ConfirmationSignal | null {
  if (candles5m.length < 10) return null; // need enough candles for structure detection

  // Run market structure analysis on the 5m candles
  const structure = analyzeMarketStructure(candles5m);

  // Determine which CHoCH type we need based on trade direction
  const requiredChochType = direction === "short" ? "bearish" : "bullish";

  // StructureBreak fields from smcAnalysis.ts:
  //   index, type ("bullish"|"bearish"), price, datetime, closeBased, level, significance?
  // Filter CHoCHs by:
  // 1. Correct direction (bearish for short, bullish for long)
  // 2. Close-based (if required) — strong confirmation
  // 3. Recency (within maxLookbackCandles from the end)
  const minIndex = candles5m.length - 1 - config.maxLookbackCandles;
  const afterZoneTouch = zoneTouchIndex !== undefined ? zoneTouchIndex : 0;

  const validChochs = (structure.choch as Array<{
    index: number; type: "bullish" | "bearish"; price: number;
    closeBased: boolean; significance?: "internal" | "external";
  }>)
    .filter(c => c.type === requiredChochType)
    .filter(c => !config.requireCloseBased || c.closeBased)
    .filter(c => c.index >= minIndex)  // recent enough
    .filter(c => c.index >= afterZoneTouch)  // after zone touch
    .sort((a, b) => b.index - a.index); // most recent first

  if (validChochs.length === 0) return null;

  // Take the most recent valid CHoCH
  const choch = validChochs[0];
  const chochCandle = candles5m[choch.index];

  if (!chochCandle) return null;

  // Calculate displacement (body ratio)
  const candleRange = chochCandle.high - chochCandle.low;
  if (candleRange === 0) return null; // doji, skip
  const bodySize = Math.abs(chochCandle.close - chochCandle.open);
  const displacement = bodySize / candleRange;

  // Apply displacement filter
  if (displacement < config.minDisplacement) return null;

  // Check for supporting signals
  const supportingSignals: string[] = [];

  // Check for engulfing pattern (CHoCH candle engulfs previous candle)
  if (choch.index > 0) {
    const prevCandle = candles5m[choch.index - 1];
    if (prevCandle) {
      const engulfs = direction === "short"
        ? (chochCandle.open >= prevCandle.close && chochCandle.close <= prevCandle.open)
        : (chochCandle.open <= prevCandle.close && chochCandle.close >= prevCandle.open);
      if (engulfs) supportingSignals.push("engulfing");
    }
  }

  // Check for FVG creation (gap between candle before CHoCH and candle after)
  if (choch.index > 0 && choch.index < candles5m.length - 1) {
    const candleBefore = candles5m[choch.index - 1];
    const candleAfter = candles5m[choch.index + 1];
    if (candleBefore && candleAfter) {
      const hasFVG = direction === "short"
        ? candleBefore.low > candleAfter.high  // bearish FVG
        : candleBefore.high < candleAfter.low; // bullish FVG
      if (hasFVG) supportingSignals.push("fvg_created");
    }
  }

  // Check for rejection wick on the CHoCH candle
  if (direction === "short") {
    const upperWick = chochCandle.high - Math.max(chochCandle.open, chochCandle.close);
    if (upperWick / candleRange > 0.3) supportingSignals.push("rejection_wick");
  } else {
    const lowerWick = Math.min(chochCandle.open, chochCandle.close) - chochCandle.low;
    if (lowerWick / candleRange > 0.3) supportingSignals.push("rejection_wick");
  }

  // Check for volume spike (if volume data available)
  if (chochCandle.volume && choch.index >= 5) {
    const recentVolumes = candles5m.slice(choch.index - 5, choch.index).map(c => c.volume || 0);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    if (avgVolume > 0 && chochCandle.volume > avgVolume * 1.5) {
      supportingSignals.push("volume_spike");
    }
  }

  // Check significance (external CHoCH is stronger than internal)
  const chochSignificance = (choch as any).significance;
  if (chochSignificance === "external") {
    supportingSignals.push("external_significance");
  }

  return {
    type: requiredChochType === "bearish" ? "bearish_choch" : "bullish_choch",
    price: chochCandle.close,
    candleIndex: choch.index,
    displacement,
    significance: chochSignificance,
    closeBased: choch.closeBased,
    supportingSignals,
  };
}

// ─── Zone Boundary Check ─────────────────────────────────────────────────────

/**
 * Check if price is still within the zone boundaries.
 * Used to determine if confirmation hunting should continue or reset.
 * 
 * @param currentPrice - current live price
 * @param zoneLow - lower boundary of the entry zone
 * @param zoneHigh - upper boundary of the entry zone
 * @param direction - trade direction
 * @param atr - ATR value for proximity buffer (optional)
 * @returns true if price is still in/near the zone
 */
export function isPriceInZone(
  currentPrice: number,
  zoneLow: number,
  zoneHigh: number,
  direction: "long" | "short",
  atr?: number,
): boolean {
  // Add a small buffer (10% of zone width or ATR-based) to avoid premature resets
  // from minor wicks outside the zone
  const zoneWidth = zoneHigh - zoneLow;
  const buffer = atr ? atr * 0.2 : zoneWidth * 0.1;

  if (direction === "short") {
    // For shorts, price should be near/in the supply zone (above)
    // Price is "in zone" if it's between zoneLow - buffer and zoneHigh + buffer
    return currentPrice >= (zoneLow - buffer) && currentPrice <= (zoneHigh + buffer);
  } else {
    // For longs, price should be near/in the demand zone (below)
    return currentPrice >= (zoneLow - buffer) && currentPrice <= (zoneHigh + buffer);
  }
}

// ─── Impulse Invalidation Check ──────────────────────────────────────────────

/**
 * Check if the impulse leg has been broken (zone invalidation).
 * If the impulse origin is broken, the zone is dead and we should cancel.
 * 
 * @param currentPrice - current live price
 * @param impulseHigh - high of the impulse leg
 * @param impulseLow - low of the impulse leg
 * @param direction - trade direction
 * @returns true if impulse is broken (should cancel)
 */
export function isImpulseBroken(
  currentPrice: number,
  impulseHigh: number,
  impulseLow: number,
  direction: "long" | "short",
): boolean {
  if (direction === "short") {
    // For shorts, the impulse was bearish. Origin = impulse high.
    // If price goes ABOVE the impulse high, the impulse is broken.
    return currentPrice > impulseHigh;
  } else {
    // For longs, the impulse was bullish. Origin = impulse low.
    // If price goes BELOW the impulse low, the impulse is broken.
    return currentPrice < impulseLow;
  }
}

// ─── Confirmation Summary (for Telegram/logging) ─────────────────────────────

/**
 * Generate a human-readable summary of the confirmation signal.
 */
export function formatConfirmationSummary(signal: ConfirmationSignal): string {
  const typeLabel = signal.type === "bearish_choch" ? "Bearish CHoCH" : "Bullish CHoCH";
  const strengthLabel = signal.displacement >= 0.7 ? "strong" : signal.displacement >= 0.5 ? "moderate" : "weak";
  const extras = signal.supportingSignals.length > 0
    ? ` | Supporting: ${signal.supportingSignals.join(", ")}`
    : "";
  return `${typeLabel} @ ${signal.price.toFixed(5)} (${strengthLabel}, displacement: ${(signal.displacement * 100).toFixed(0)}%${signal.significance === "external" ? ", EXTERNAL" : ""}${extras})`;
}
