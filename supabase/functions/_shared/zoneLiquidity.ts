/**
 * zoneLiquidity.ts — Zone-Specific Liquidity Detection
 * ─────────────────────────────────────────────────────
 * Given a zone (FVG/OB with high/low bounds), finds nearby liquidity pools
 * and detects if a sweep has occurred at/near the zone edges.
 *
 * This integrates with the unified impulse zone engine to add liquidity
 * context to zone scoring:
 *   - Liquidity pool identified near zone edge: +1.0 to score
 *   - Liquidity swept (price wicked past pool then closed back): +2.0 to score
 *   - Sweep + rejection confirmed: highest conviction entry signal
 *
 * Uses existing infrastructure:
 *   - detectLiquidityPools() from smcAnalysis.ts (equal highs/lows detection)
 *   - detectInducements() from inducementDetection.ts (sweep patterns)
 */

import { type Candle, type LiquidityPool, calculateATR } from "./smcAnalysis.ts";
import { type Inducement, detectInducements } from "./inducementDetection.ts";

// ─── Types ───────────────────────────────────────────────────────────

export interface ZoneLiquidityResult {
  /** Liquidity pools found near the zone edges */
  nearbyPools: NearbyPool[];
  /** Whether any pool near the zone has been swept */
  swept: boolean;
  /** The sweep event details (if swept) */
  sweepEvent: SweepEvent | null;
  /** Supporting inducement (if any) */
  inducement: Inducement | null;
  /** Score contribution from liquidity (0 to 3.0) */
  liquidityScore: number;
  /** Human-readable summary */
  summary: string;
}

export interface NearbyPool {
  pool: LiquidityPool;
  /** Distance from pool to nearest zone edge (in price units) */
  distanceToZone: number;
  /** Which zone edge the pool is near */
  nearEdge: "above_high" | "below_low" | "inside";
  /** Relevance for the trade direction */
  relevance: "target" | "entry_trigger" | "neutral";
}

export interface SweepEvent {
  /** Price level that was swept */
  level: number;
  /** Type of liquidity swept */
  type: "buy-side" | "sell-side";
  /** How deep past the level (in price units) */
  depth: number;
  /** Whether price rejected after sweep (closed back past level) */
  rejected: boolean;
  /** Candle index of the sweep */
  sweepIndex: number;
  /** Datetime of the sweep */
  sweepTime: string;
  /** Number of candles since sweep (recency) */
  candlesSinceSweep: number;
}

// ─── Configuration ──────────────────────────────────────────────────

export interface ZoneLiquidityConfig {
  /** Max distance from zone edge to consider a pool "nearby" (ATR multiplier). Default: 1.5 */
  nearbyAtrMult: number;
  /** Max candles since sweep for it to still be valid. Default: 15 */
  sweepMaxAge: number;
  /** Minimum pool strength (touches) to consider. Default: 2 */
  minPoolStrength: number;
}

export const DEFAULT_ZONE_LIQUIDITY_CONFIG: ZoneLiquidityConfig = {
  nearbyAtrMult: 1.5,
  sweepMaxAge: 15,
  minPoolStrength: 2,
};

// ─── Core Function ──────────────────────────────────────────────────

/**
 * Find liquidity context for a specific zone.
 *
 * @param candles - Candles for the timeframe being analyzed
 * @param zoneHigh - Upper bound of the zone
 * @param zoneLow - Lower bound of the zone
 * @param direction - Trade direction (continuation with impulse)
 * @param liquidityPools - Pre-detected liquidity pools (from detectLiquidityPools)
 * @param config - Optional configuration overrides
 * @returns ZoneLiquidityResult with scoring and details
 */
export function findZoneLiquidity(
  candles: Candle[],
  zoneHigh: number,
  zoneLow: number,
  direction: "bullish" | "bearish",
  liquidityPools: LiquidityPool[],
  config: Partial<ZoneLiquidityConfig> = {},
): ZoneLiquidityResult {
  const cfg = { ...DEFAULT_ZONE_LIQUIDITY_CONFIG, ...config };
  const atr = calculateATR(candles, 14);
  const nearbyThreshold = atr * cfg.nearbyAtrMult;
  const currentIndex = candles.length - 1;

  // ── 1. Find pools near the zone edges ──
  const nearbyPools: NearbyPool[] = [];

  for (const pool of liquidityPools) {
    if (pool.strength < cfg.minPoolStrength) continue;

    let distanceToZone: number;
    let nearEdge: NearbyPool["nearEdge"];

    if (pool.price > zoneHigh) {
      distanceToZone = pool.price - zoneHigh;
      nearEdge = "above_high";
    } else if (pool.price < zoneLow) {
      distanceToZone = zoneLow - pool.price;
      nearEdge = "below_low";
    } else {
      distanceToZone = 0;
      nearEdge = "inside";
    }

    if (distanceToZone > nearbyThreshold) continue;

    // Determine relevance based on trade direction:
    // For BEARISH continuation: BSL above zone = entry trigger (price sweeps up then drops)
    // For BULLISH continuation: SSL below zone = entry trigger (price sweeps down then rallies)
    let relevance: NearbyPool["relevance"] = "neutral";
    if (direction === "bearish" && pool.type === "buy-side" && nearEdge === "above_high") {
      relevance = "entry_trigger"; // BSL above zone — sweep this then short
    } else if (direction === "bullish" && pool.type === "sell-side" && nearEdge === "below_low") {
      relevance = "entry_trigger"; // SSL below zone — sweep this then long
    } else if (direction === "bearish" && pool.type === "sell-side" && nearEdge === "below_low") {
      relevance = "target"; // SSL below = target for shorts
    } else if (direction === "bullish" && pool.type === "buy-side" && nearEdge === "above_high") {
      relevance = "target"; // BSL above = target for longs
    }

    nearbyPools.push({ pool, distanceToZone, nearEdge, relevance });
  }

  // Sort by relevance (entry_trigger first) then by distance
  nearbyPools.sort((a, b) => {
    const relOrder = { entry_trigger: 0, target: 1, neutral: 2 };
    if (relOrder[a.relevance] !== relOrder[b.relevance]) {
      return relOrder[a.relevance] - relOrder[b.relevance];
    }
    return a.distanceToZone - b.distanceToZone;
  });

  // ── 2. Detect sweep events near the zone ──
  let sweepEvent: SweepEvent | null = null;
  let swept = false;

  // Check entry-trigger pools for sweeps
  const triggerPools = nearbyPools.filter(np => np.relevance === "entry_trigger");
  for (const np of triggerPools) {
    if (np.pool.swept && np.pool.sweptAtIndex !== undefined) {
      const candlesSinceSweep = currentIndex - np.pool.sweptAtIndex;
      if (candlesSinceSweep <= cfg.sweepMaxAge) {
        swept = true;
        sweepEvent = {
          level: np.pool.price,
          type: np.pool.type,
          depth: np.pool.sweepDepth ?? 0,
          rejected: np.pool.rejectionConfirmed ?? false,
          sweepIndex: np.pool.sweptAtIndex,
          sweepTime: candles[np.pool.sweptAtIndex]?.datetime ?? "",
          candlesSinceSweep,
        };
        break; // Use the most relevant sweep
      }
    }
  }

  // ── 3. Check for inducement patterns near the zone ──
  let inducement: Inducement | null = null;
  if (!swept) {
    // Only look for inducements if no clear pool sweep found
    const inducements = detectInducements(candles);
    const tradeDir = direction === "bullish" ? "long" : "short";
    // Find inducement near the zone (within zone bounds or nearby)
    const relevantInducements = inducements.filter(ind => {
      if (ind.impliedDirection !== tradeDir) return false;
      if (!ind.confirmed) return false;
      // Check if the inducement level is near the zone
      const distToZone = ind.level > zoneHigh
        ? ind.level - zoneHigh
        : ind.level < zoneLow
        ? zoneLow - ind.level
        : 0;
      if (distToZone > nearbyThreshold) return false;
      // Check recency
      const age = currentIndex - ind.sweepIndex;
      if (age > cfg.sweepMaxAge) return false;
      return ind.quality >= 4;
    });

    if (relevantInducements.length > 0) {
      inducement = relevantInducements[0]; // Best quality (already sorted)
    }
  }

  // ── 4. Calculate liquidity score ──
  let liquidityScore = 0;
  const summaryParts: string[] = [];

  // Pool identified near zone: +1.0
  if (nearbyPools.some(np => np.relevance === "entry_trigger")) {
    liquidityScore += 1.0;
    const triggerPool = nearbyPools.find(np => np.relevance === "entry_trigger")!;
    summaryParts.push(
      `${triggerPool.pool.type === "buy-side" ? "BSL" : "SSL"} @ ${triggerPool.pool.price.toFixed(5)} (${triggerPool.pool.strength} touches)`
    );
  }

  // Sweep detected: +1.5 (or +2.0 if rejected)
  if (swept && sweepEvent) {
    if (sweepEvent.rejected) {
      liquidityScore += 2.0;
      summaryParts.push(`Swept + rejected (${sweepEvent.candlesSinceSweep} bars ago)`);
    } else {
      liquidityScore += 1.5;
      summaryParts.push(`Swept (${sweepEvent.candlesSinceSweep} bars ago, no rejection yet)`);
    }
  } else if (inducement) {
    // Inducement as alternative: +1.0
    liquidityScore += 1.0;
    summaryParts.push(`Inducement: ${inducement.type} (quality ${inducement.quality}/10)`);
  }

  const summary = summaryParts.length > 0
    ? summaryParts.join(" | ")
    : "No significant liquidity near zone";

  return {
    nearbyPools,
    swept,
    sweepEvent,
    inducement,
    liquidityScore,
    summary,
  };
}
