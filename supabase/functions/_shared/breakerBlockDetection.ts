/**
 * breakerBlockDetection.ts — Break and Retest Entry Model
 * ──────────────────────────────────────────────────────────────────────────────
 * Detects Breaker Blocks: failed Order Blocks that flip role after:
 *   1. Liquidity sweep (price takes out stops beyond the OB)
 *   2. Displacement (strong move breaks through the OB)
 *   3. Retest (price returns to the broken OB from the other side)
 *
 * A bullish OB that gets broken becomes a BEARISH breaker (resistance → support flip).
 * A bearish OB that gets broken becomes a BULLISH breaker (support → resistance flip).
 *
 * This is a completely new entry model — disabled by default, opt-in per pair.
 * Does NOT modify smcAnalysis.ts.
 */

import type { Candle, OrderBlock } from "./smcAnalysis.ts";
import { calculateATR } from "./smcAnalysis.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BreakerBlockEntry {
  /** The original OB that failed and flipped */
  originalOB: { high: number; low: number; type: "bullish" | "bearish"; index: number };
  /** The new direction after flip (opposite of original) */
  direction: "bullish" | "bearish";
  /** Entry zone bounds (same as original OB bounds) */
  entryZone: { high: number; low: number };
  /** Index of the candle that broke through the OB (displacement) */
  breakIndex: number;
  /** Index of the candle that retested the zone */
  retestIndex: number | null;
  /** Whether liquidity was swept before the break */
  hadLiquiditySweep: boolean;
  /** Displacement strength (body size / ATR) */
  displacementStrength: number;
  /** Whether the retest has occurred (entry condition met) */
  retestComplete: boolean;
  /** Confidence score (0-1) */
  confidence: number;
  /** Human-readable explanation */
  detail: string;
}

export interface BreakerConfig {
  /** Minimum displacement candle body size as ATR multiple (default: 1.5) */
  minDisplacementATR: number;
  /** Maximum candles to wait for retest after break (default: 20) */
  maxRetestWait: number;
  /** Whether to require liquidity sweep before break (default: true) */
  requireSweep: boolean;
  /** Minimum number of candles between OB formation and break (default: 3) */
  minCandlesBetween: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  minDisplacementATR: 1.5,
  maxRetestWait: 20,
  requireSweep: true,
  minCandlesBetween: 3,
};

// ─── Core Detection ───────────────────────────────────────────────────────────

/**
 * Scan for Breaker Block setups in the candle data.
 *
 * Process:
 *   1. Find OBs that have been broken (close through far boundary)
 *   2. Check if there was a liquidity sweep before the break
 *   3. Verify the break candle has displacement (large body)
 *   4. Look for a retest of the broken zone from the other side
 *
 * @param orderBlocks - Previously detected OBs (from detectOrderBlocks)
 * @param candles - Full candle array
 * @param config - Breaker detection configuration
 */
export function detectBreakerBlocks(
  orderBlocks: OrderBlock[],
  candles: Candle[],
  config: Partial<BreakerConfig> = {},
): BreakerBlockEntry[] {
  const cfg = { ...DEFAULT_BREAKER_CONFIG, ...config };
  const atr = calculateATR(candles, 14);
  if (atr <= 0 || candles.length < 30) return [];

  const breakers: BreakerBlockEntry[] = [];

  for (const ob of orderBlocks) {
    // Only process OBs that have been broken
    if (ob.state !== "broken" && ob.state !== "mitigated") continue;
    if (!ob.brokenAt && !ob.mitigatedAt) continue;

    const breakIdx = ob.brokenAt ?? ob.mitigatedAt!;

    // Rule: minimum candles between OB formation and break
    if (breakIdx - ob.index < cfg.minCandlesBetween) continue;

    // Check displacement on the break candle
    const breakCandle = candles[breakIdx];
    if (!breakCandle) continue;

    const bodySize = Math.abs(breakCandle.close - breakCandle.open);
    const displacementStrength = bodySize / atr;

    if (displacementStrength < cfg.minDisplacementATR) continue;

    // Check for liquidity sweep before the break
    const hadSweep = _detectSweepBeforeBreak(ob, candles, breakIdx);
    if (cfg.requireSweep && !hadSweep) continue;

    // Determine the new direction (opposite of original OB)
    const newDirection: "bullish" | "bearish" = ob.type === "bullish" ? "bearish" : "bullish";

    // Look for retest after the break
    const retestResult = _findRetest(ob, candles, breakIdx, cfg.maxRetestWait, newDirection);

    const confidence = _calculateBreakerConfidence(displacementStrength, hadSweep, retestResult.found);

    breakers.push({
      originalOB: { high: ob.high, low: ob.low, type: ob.type, index: ob.index },
      direction: newDirection,
      entryZone: { high: ob.high, low: ob.low },
      breakIndex: breakIdx,
      retestIndex: retestResult.index,
      hadLiquiditySweep: hadSweep,
      displacementStrength,
      retestComplete: retestResult.found,
      confidence,
      detail: _buildDetail(ob, newDirection, displacementStrength, hadSweep, retestResult),
    });
  }

  return breakers;
}

/**
 * Check if a specific candle is at a breaker block retest level.
 * Used for real-time entry detection in the scanner.
 */
export function isAtBreakerRetest(
  currentCandle: Candle,
  breaker: BreakerBlockEntry,
): boolean {
  if (breaker.retestComplete) return false; // Already retested

  if (breaker.direction === "bullish") {
    // Bullish breaker: original bearish OB broken upward, now acts as support
    // Retest = price comes back DOWN to the zone
    return currentCandle.low <= breaker.entryZone.high && currentCandle.close >= breaker.entryZone.low;
  } else {
    // Bearish breaker: original bullish OB broken downward, now acts as resistance
    // Retest = price comes back UP to the zone
    return currentCandle.high >= breaker.entryZone.low && currentCandle.close <= breaker.entryZone.high;
  }
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Detect if there was a liquidity sweep before the OB was broken.
 * For a bullish OB: sweep = wick below the OB's low before the break
 * For a bearish OB: sweep = wick above the OB's high before the break
 */
function _detectSweepBeforeBreak(
  ob: OrderBlock,
  candles: Candle[],
  breakIdx: number,
): boolean {
  // Look at candles between OB formation and break
  const searchStart = Math.max(ob.index + 1, 0);
  const searchEnd = Math.min(breakIdx, candles.length);

  for (let i = searchStart; i < searchEnd; i++) {
    const c = candles[i];
    if (ob.type === "bullish") {
      // Sweep below bullish OB = wick below ob.low but close above
      if (c.low < ob.low && c.close >= ob.low) return true;
    } else {
      // Sweep above bearish OB = wick above ob.high but close below
      if (c.high > ob.high && c.close <= ob.high) return true;
    }
  }
  return false;
}

/**
 * Find a retest of the broken zone after the break.
 */
function _findRetest(
  ob: OrderBlock,
  candles: Candle[],
  breakIdx: number,
  maxWait: number,
  newDirection: "bullish" | "bearish",
): { found: boolean; index: number | null } {
  const searchEnd = Math.min(breakIdx + maxWait + 1, candles.length);

  for (let i = breakIdx + 1; i < searchEnd; i++) {
    const c = candles[i];

    if (newDirection === "bullish") {
      // Bullish breaker (was bearish OB broken up): retest = price comes back to zone from above
      if (c.low <= ob.high && c.close >= ob.low) {
        return { found: true, index: i };
      }
    } else {
      // Bearish breaker (was bullish OB broken down): retest = price comes back to zone from below
      if (c.high >= ob.low && c.close <= ob.high) {
        return { found: true, index: i };
      }
    }
  }
  return { found: false, index: null };
}

function _calculateBreakerConfidence(
  displacementStrength: number,
  hadSweep: boolean,
  retestComplete: boolean,
): number {
  let confidence = 0.4; // Base confidence for a breaker

  // Displacement strength bonus (capped at 0.2)
  confidence += Math.min(0.2, (displacementStrength - 1.5) * 0.1);

  // Sweep bonus
  if (hadSweep) confidence += 0.2;

  // Retest confirmation bonus
  if (retestComplete) confidence += 0.2;

  return Math.min(0.95, confidence);
}

function _buildDetail(
  ob: OrderBlock,
  newDirection: string,
  displacementStrength: number,
  hadSweep: boolean,
  retestResult: { found: boolean; index: number | null },
): string {
  const parts = [
    `${newDirection.toUpperCase()} breaker from ${ob.type} OB at index ${ob.index}`,
    `displacement ${displacementStrength.toFixed(2)}×ATR`,
    hadSweep ? "sweep confirmed" : "no sweep",
    retestResult.found ? `retest at index ${retestResult.index}` : "awaiting retest",
  ];
  return parts.join(" | ");
}
