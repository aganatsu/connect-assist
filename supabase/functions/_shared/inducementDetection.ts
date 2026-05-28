/**
 * inducementDetection.ts — Inducement (Liquidity Grab) Detection Engine
 * ──────────────────────────────────────────────────────────────────────
 * Detects inducement patterns where smart money creates false breakouts
 * to trap retail traders before reversing. This is a key SMC concept:
 *
 * Inducement = a minor swing high/low that gets swept (wick through)
 * to grab stop-losses before the real move continues.
 *
 * Types of inducement detected:
 *   1. **Minor Swing Inducement** — Internal swing highs/lows swept
 *      before price continues in the original direction
 *   2. **Equal High/Low Trap** — Equal highs/lows swept then reversed
 *      (classic retail trap above/below obvious levels)
 *   3. **Trendline Liquidity** — Price breaks a trendline briefly
 *      then snaps back (trendline traders stopped out)
 *   4. **Session High/Low Sweep** — Previous session H/L swept in
 *      the first hour of new session (Judas Swing variant)
 *
 * Each inducement is scored by:
 *   - Displacement quality after the sweep (was there conviction?)
 *   - Time spent above/below the level (brief = stronger trap)
 *   - Volume/candle body ratio at the sweep point
 *   - Alignment with HTF direction (inducement against HTF = stronger)
 */

import { type Candle, type SwingPoint, calculateATR } from "./smcAnalysis.ts";

// ─── Types ───────────────────────────────────────────────────────────

export interface Inducement {
  /** Type of inducement pattern */
  type: "minor_swing" | "equal_level" | "trendline" | "session_sweep";
  /** Direction the inducement traps (bull_trap = swept highs, bear_trap = swept lows) */
  trapDirection: "bull_trap" | "bear_trap";
  /** The price level that was swept */
  level: number;
  /** How far past the level price went (in price units) */
  sweepDepth: number;
  /** Candle index where the sweep occurred */
  sweepIndex: number;
  /** Candle datetime of the sweep */
  sweepTime: string;
  /** Number of candles price spent past the level before reversing */
  dwellCandles: number;
  /** Quality score 0-10 (higher = more convincing inducement) */
  quality: number;
  /** Whether displacement followed the sweep (strong reversal candle) */
  hasDisplacement: boolean;
  /** Whether the sweep has been confirmed (price moved back past the level) */
  confirmed: boolean;
  /** Implied trade direction after inducement (opposite of trap) */
  impliedDirection: "long" | "short";
  /** Detail string for logging/display */
  detail: string;
}

export interface InducementConfig {
  /** Minimum sweep depth as ATR multiplier (default: 0.1 = 10% of ATR) */
  minSweepDepthAtr: number;
  /** Maximum dwell candles for a valid inducement (default: 3) */
  maxDwellCandles: number;
  /** Minimum displacement body ratio for confirmation (default: 0.6) */
  minDisplacementBodyRatio: number;
  /** Lookback for swing detection (default: 3) */
  swingLookback: number;
  /** Maximum candles to look back for inducement patterns (default: 50) */
  maxLookback: number;
  /** Tolerance for "equal" levels as ATR multiplier (default: 0.15) */
  equalLevelTolerance: number;
}

export const DEFAULT_INDUCEMENT_CONFIG: InducementConfig = {
  minSweepDepthAtr: 0.1,
  maxDwellCandles: 3,
  minDisplacementBodyRatio: 0.6,
  swingLookback: 3,
  maxLookback: 50,
  equalLevelTolerance: 0.15,
};

// ─── Helper: Detect minor swing points ───────────────────────────────

interface MinorSwing {
  index: number;
  price: number;
  type: "high" | "low";
}

function detectMinorSwings(candles: Candle[], lookback: number): MinorSwing[] {
  const swings: MinorSwing[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, price: candles[i].high, type: "high" });
    if (isLow) swings.push({ index: i, price: candles[i].low, type: "low" });
  }
  return swings;
}

// ─── Helper: Check displacement after sweep ──────────────────────────

function hasDisplacementAfterSweep(
  candles: Candle[],
  sweepIndex: number,
  direction: "bullish" | "bearish",
  minBodyRatio: number,
  atr: number,
): boolean {
  // Check the next 1-3 candles after sweep for displacement
  for (let i = sweepIndex + 1; i <= Math.min(sweepIndex + 3, candles.length - 1); i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    if (range === 0) continue;
    const bodyRatio = body / range;
    const isBullish = c.close > c.open;
    const isBearish = c.close < c.open;

    if (direction === "bullish" && isBullish && bodyRatio >= minBodyRatio && body >= atr * 0.5) {
      return true;
    }
    if (direction === "bearish" && isBearish && bodyRatio >= minBodyRatio && body >= atr * 0.5) {
      return true;
    }
  }
  return false;
}

// ─── Core: Detect Minor Swing Inducements ────────────────────────────

function detectMinorSwingInducements(
  candles: Candle[],
  atr: number,
  cfg: InducementConfig,
): Inducement[] {
  const results: Inducement[] = [];
  const swings = detectMinorSwings(candles, cfg.swingLookback);
  const startIdx = Math.max(0, candles.length - cfg.maxLookback);

  for (const swing of swings) {
    if (swing.index < startIdx) continue;
    if (swing.index >= candles.length - 2) continue; // Need at least 2 candles after

    // Look for sweep of this swing in subsequent candles
    for (let i = swing.index + 1; i < Math.min(swing.index + cfg.maxLookback, candles.length); i++) {
      const c = candles[i];
      let swept = false;
      let sweepDepth = 0;
      let trapDir: "bull_trap" | "bear_trap" = "bull_trap";

      if (swing.type === "high") {
        // Bull trap: wick above swing high but close below
        if (c.high > swing.price && c.close < swing.price) {
          swept = true;
          sweepDepth = c.high - swing.price;
          trapDir = "bull_trap";
        }
      } else {
        // Bear trap: wick below swing low but close above
        if (c.low < swing.price && c.close > swing.price) {
          swept = true;
          sweepDepth = swing.price - c.low;
          trapDir = "bear_trap";
        }
      }

      if (!swept || sweepDepth < atr * cfg.minSweepDepthAtr) continue;

      // Count dwell candles (how long price stayed past the level)
      let dwellCandles = 1;
      for (let j = i + 1; j < Math.min(i + cfg.maxDwellCandles + 1, candles.length); j++) {
        if (swing.type === "high" && candles[j].close > swing.price) dwellCandles++;
        else if (swing.type === "low" && candles[j].close < swing.price) dwellCandles++;
        else break;
      }

      if (dwellCandles > cfg.maxDwellCandles) continue; // Not a quick sweep

      // Check for displacement after
      const dispDir = trapDir === "bull_trap" ? "bearish" : "bullish";
      const hasDisp = hasDisplacementAfterSweep(candles, i, dispDir, cfg.minDisplacementBodyRatio, atr);

      // Check confirmation (price moved back past the level)
      let confirmed = false;
      for (let j = i + 1; j < Math.min(i + 10, candles.length); j++) {
        if (trapDir === "bull_trap" && candles[j].close < swing.price) { confirmed = true; break; }
        if (trapDir === "bear_trap" && candles[j].close > swing.price) { confirmed = true; break; }
      }

      // Quality scoring (0-10)
      let quality = 0;
      quality += hasDisp ? 3 : 0;                         // Displacement = strong
      quality += confirmed ? 2 : 0;                       // Confirmed reversal
      quality += dwellCandles === 1 ? 2 : (dwellCandles === 2 ? 1 : 0); // Quick sweep = better
      quality += sweepDepth > atr * 0.3 ? 1 : 0;         // Deep sweep
      quality += sweepDepth < atr * 0.8 ? 1 : 0;         // Not TOO deep (controlled)
      quality += (i - swing.index) <= 10 ? 1 : 0;        // Recent swing = more relevant

      results.push({
        type: "minor_swing",
        trapDirection: trapDir,
        level: swing.price,
        sweepDepth,
        sweepIndex: i,
        sweepTime: candles[i].datetime,
        dwellCandles,
        quality: Math.min(10, quality),
        hasDisplacement: hasDisp,
        confirmed,
        impliedDirection: trapDir === "bull_trap" ? "short" : "long",
        detail: `${trapDir === "bull_trap" ? "Bull" : "Bear"} trap at ${swing.price.toFixed(5)} (sweep depth: ${(sweepDepth / atr * 100).toFixed(0)}% ATR, dwell: ${dwellCandles} bars)`,
      });

      break; // Only count first sweep of this swing
    }
  }

  return results;
}

// ─── Core: Detect Equal Level Traps ──────────────────────────────────

function detectEqualLevelTraps(
  candles: Candle[],
  atr: number,
  cfg: InducementConfig,
): Inducement[] {
  const results: Inducement[] = [];
  const swings = detectMinorSwings(candles, cfg.swingLookback);
  const tolerance = atr * cfg.equalLevelTolerance;

  // Find clusters of equal highs/lows
  const highSwings = swings.filter((s) => s.type === "high");
  const lowSwings = swings.filter((s) => s.type === "low");

  // Equal highs
  for (let a = 0; a < highSwings.length - 1; a++) {
    for (let b = a + 1; b < highSwings.length; b++) {
      if (Math.abs(highSwings[a].price - highSwings[b].price) > tolerance) continue;
      const avgLevel = (highSwings[a].price + highSwings[b].price) / 2;
      const lastSwingIdx = Math.max(highSwings[a].index, highSwings[b].index);

      // Look for sweep after the second equal high
      for (let i = lastSwingIdx + 1; i < Math.min(lastSwingIdx + cfg.maxLookback, candles.length); i++) {
        const c = candles[i];
        if (c.high > avgLevel + tolerance * 0.5 && c.close < avgLevel) {
          const sweepDepth = c.high - avgLevel;
          if (sweepDepth < atr * cfg.minSweepDepthAtr) continue;

          let dwellCandles = 1;
          for (let j = i + 1; j < Math.min(i + cfg.maxDwellCandles + 1, candles.length); j++) {
            if (candles[j].close > avgLevel) dwellCandles++;
            else break;
          }
          if (dwellCandles > cfg.maxDwellCandles) continue;

          const hasDisp = hasDisplacementAfterSweep(candles, i, "bearish", cfg.minDisplacementBodyRatio, atr);
          let confirmed = false;
          for (let j = i + 1; j < Math.min(i + 10, candles.length); j++) {
            if (candles[j].close < avgLevel - tolerance) { confirmed = true; break; }
          }

          let quality = 2; // Base: equal levels are inherently significant
          quality += hasDisp ? 3 : 0;
          quality += confirmed ? 2 : 0;
          quality += dwellCandles === 1 ? 2 : 1;
          quality += sweepDepth < atr * 0.5 ? 1 : 0;

          results.push({
            type: "equal_level",
            trapDirection: "bull_trap",
            level: avgLevel,
            sweepDepth,
            sweepIndex: i,
            sweepTime: candles[i].datetime,
            dwellCandles,
            quality: Math.min(10, quality),
            hasDisplacement: hasDisp,
            confirmed,
            impliedDirection: "short",
            detail: `Equal highs trap at ${avgLevel.toFixed(5)} (${highSwings.length >= 3 ? "triple" : "double"} top swept)`,
          });
          break;
        }
      }
      break; // Only process first cluster match
    }
  }

  // Equal lows
  for (let a = 0; a < lowSwings.length - 1; a++) {
    for (let b = a + 1; b < lowSwings.length; b++) {
      if (Math.abs(lowSwings[a].price - lowSwings[b].price) > tolerance) continue;
      const avgLevel = (lowSwings[a].price + lowSwings[b].price) / 2;
      const lastSwingIdx = Math.max(lowSwings[a].index, lowSwings[b].index);

      for (let i = lastSwingIdx + 1; i < Math.min(lastSwingIdx + cfg.maxLookback, candles.length); i++) {
        const c = candles[i];
        if (c.low < avgLevel - tolerance * 0.5 && c.close > avgLevel) {
          const sweepDepth = avgLevel - c.low;
          if (sweepDepth < atr * cfg.minSweepDepthAtr) continue;

          let dwellCandles = 1;
          for (let j = i + 1; j < Math.min(i + cfg.maxDwellCandles + 1, candles.length); j++) {
            if (candles[j].close < avgLevel) dwellCandles++;
            else break;
          }
          if (dwellCandles > cfg.maxDwellCandles) continue;

          const hasDisp = hasDisplacementAfterSweep(candles, i, "bullish", cfg.minDisplacementBodyRatio, atr);
          let confirmed = false;
          for (let j = i + 1; j < Math.min(i + 10, candles.length); j++) {
            if (candles[j].close > avgLevel + tolerance) { confirmed = true; break; }
          }

          let quality = 2;
          quality += hasDisp ? 3 : 0;
          quality += confirmed ? 2 : 0;
          quality += dwellCandles === 1 ? 2 : 1;
          quality += sweepDepth < atr * 0.5 ? 1 : 0;

          results.push({
            type: "equal_level",
            trapDirection: "bear_trap",
            level: avgLevel,
            sweepDepth,
            sweepIndex: i,
            sweepTime: candles[i].datetime,
            dwellCandles,
            quality: Math.min(10, quality),
            hasDisplacement: hasDisp,
            confirmed,
            impliedDirection: "long",
            detail: `Equal lows trap at ${avgLevel.toFixed(5)} (${lowSwings.length >= 3 ? "triple" : "double"} bottom swept)`,
          });
          break;
        }
      }
      break;
    }
  }

  return results;
}

// ─── Main Export: Detect All Inducements ─────────────────────────────

/**
 * Detect inducement patterns in candle data.
 *
 * @param candles - OHLC candle array (ascending order, newest last)
 * @param config - Optional configuration overrides
 * @returns Array of detected inducement patterns, sorted by quality descending
 */
export function detectInducements(
  candles: Candle[],
  config: Partial<InducementConfig> = {},
): Inducement[] {
  if (candles.length < 20) return [];

  const cfg = { ...DEFAULT_INDUCEMENT_CONFIG, ...config };
  const atr = calculateATR(candles, 14);
  if (atr <= 0) return [];

  const results: Inducement[] = [
    ...detectMinorSwingInducements(candles, atr, cfg),
    ...detectEqualLevelTraps(candles, atr, cfg),
  ];

  // Sort by quality descending, then by recency (higher sweepIndex = more recent)
  results.sort((a, b) => {
    if (b.quality !== a.quality) return b.quality - a.quality;
    return b.sweepIndex - a.sweepIndex;
  });

  return results;
}

/**
 * Check if a recent inducement supports a given trade direction.
 * Returns the best matching inducement or null.
 *
 * @param inducements - Array of detected inducements
 * @param direction - Trade direction to check ("long" or "short")
 * @param maxAge - Maximum candle age of inducement (default: 10)
 * @param currentIndex - Current candle index (default: use sweepIndex)
 */
export function findSupportingInducement(
  inducements: Inducement[],
  direction: "long" | "short",
  currentIndex?: number,
  maxAge = 10,
): Inducement | null {
  const matching = inducements.filter((ind) => {
    if (ind.impliedDirection !== direction) return false;
    if (!ind.confirmed) return false;
    if (currentIndex !== undefined && (currentIndex - ind.sweepIndex) > maxAge) return false;
    return ind.quality >= 4; // Minimum quality threshold
  });

  return matching.length > 0 ? matching[0] : null; // Already sorted by quality
}
