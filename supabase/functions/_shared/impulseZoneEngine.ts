/**
 * Impulse Zone Engine — prerequisite gate for trade entry.
 *
 * Replicates the user's actual ICT/SMC top-down trading process:
 *   1. Find the impulse leg that broke structure (no internal pullback >50%)
 *   2. Map POIs (FVGs + OBs) created WITHIN that impulse
 *   3. Overlay Fib from impulse high wick (1) to low wick (0)
 *   4. Check historical S/R (close-only) inside each zone
 *   5. Refine on LTF (15m) — find OB/FVG inside the best zone
 *   6. Rank zones by Fib depth + confluence layers
 *
 * This module does NOT modify smcAnalysis.ts — it CALLS its exported functions.
 */

import type {
  Candle, SwingPoint, OrderBlock, FairValueGap, StructureBreak,
} from "./smcAnalysis.ts";
import {
  analyzeMarketStructure, detectOrderBlocks, detectFVGs, calculateATR,
} from "./smcAnalysis.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImpulseLeg {
  high: number;         // Swing high wick (Fib level 1)
  low: number;          // Swing low wick (Fib level 0)
  direction: "bullish" | "bearish";
  startIndex: number;   // Index of the swing that started the move
  endIndex: number;     // Index of the BOS candle
  isValid: boolean;     // Passes the 50% pullback rule
  bosPrice: number;     // Price level of the structure break
}

export interface ImpulsePOI {
  type: "fvg" | "ob";
  high: number;
  low: number;
  candleIndex: number;
  direction: "bullish" | "bearish";
}

export interface RankedPOI {
  poi: ImpulsePOI;
  fibLevel: number;       // Nearest Fib ratio (e.g. 0.618, 0.786)
  fibDepth: number;       // How deep into the retracement (higher = better)
  fibScore: number;       // 1-4 score based on depth
  srConfirmed: boolean;   // Historical S/R overlaps this zone
  ltfRefined: boolean;    // LTF OB/FVG found inside
  refinedEntry?: number;  // Precise entry from LTF refinement
  refinedSL?: number;     // Precise SL from LTF refinement
  ltfType?: "ob" | "fvg";
  totalScore: number;     // fibScore + srConfirmed(+1) + ltfRefined(+1)
}

export interface BestZone {
  zone: RankedPOI;
  impulse: ImpulseLeg;
  priceAtZone: boolean;   // Is current price within or near the zone?
  distanceToZone: number; // Distance in price units (0 if at zone)
}

export interface ZoneEngineResult {
  bestZone: BestZone | null;
  impulse: ImpulseLeg | null;
  allZones: RankedPOI[];
  reason: string;         // Human-readable explanation of outcome
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Fib levels to check (from deepest to shallowest) */
const FIB_LEVELS = [0.786, 0.71, 0.618, 0.5, 0.382] as const;

/** Score assigned to each Fib depth tier */
const FIB_SCORES: Record<number, number> = {
  0.786: 4,
  0.71: 3,
  0.618: 2,
  0.5: 1,
  0.382: 0, // Too shallow — no score but still tracked
};

/** Tolerance for Fib level overlap (as fraction of impulse range) */
const FIB_TOLERANCE_FRACTION = 0.03; // 3% of impulse range

/** Minimum touches to qualify as historical S/R */
const SR_MIN_TOUCHES = 2;

/** Lookback for S/R detection (candles before the impulse) */
const SR_LOOKBACK = 100;

/** Proximity threshold for "price at zone" (as fraction of ATR) */
const PRICE_AT_ZONE_ATR_MULT = 1.5;

// ─── 1. findImpulseLeg ────────────────────────────────────────────────────────

/**
 * Find the most recent impulse leg that broke structure.
 *
 * An impulse leg is defined as the entire move from a swing point to a BOS,
 * where NO internal pullback exceeds 50% of the leg at that point.
 *
 * @param candles - 1H or 4H candles (must have structure analysis available)
 * @param direction - The bias direction we're looking for
 * @returns ImpulseLeg or null if no valid impulse found
 */
export function findImpulseLeg(
  candles: Candle[],
  direction: "bullish" | "bearish",
): ImpulseLeg | null {
  if (candles.length < 20) return null;

  const structure = analyzeMarketStructure(candles);
  const allBreaks = [...structure.bos, ...structure.choch]
    .filter(b => b.type === direction)
    .sort((a, b) => b.index - a.index); // Most recent first

  if (allBreaks.length === 0) return null;

  // Try each BOS from most recent to oldest
  for (const bos of allBreaks) {
    const impulse = validateImpulseFromBOS(candles, bos, direction, structure.swingPoints);
    if (impulse && impulse.isValid) return impulse;
  }

  return null;
}

/**
 * Given a BOS, trace back to find the swing origin and validate the 50% rule.
 */
function validateImpulseFromBOS(
  candles: Candle[],
  bos: StructureBreak,
  direction: "bullish" | "bearish",
  swingPoints: SwingPoint[],
): ImpulseLeg | null {
  const bosIdx = bos.index;

  // For bullish impulse: find the swing LOW that started the move up to this BOS
  // For bearish impulse: find the swing HIGH that started the move down to this BOS
  const originType = direction === "bullish" ? "low" : "high";

  // Look for the most recent swing of the correct type BEFORE the BOS
  const candidates = swingPoints
    .filter(sp => sp.type === originType && sp.index < bosIdx)
    .sort((a, b) => b.index - a.index); // Most recent first

  if (candidates.length === 0) return null;

  // Try each candidate swing as the impulse origin
  for (const origin of candidates.slice(0, 5)) { // Check up to 5 candidates
    const startIdx = origin.index;
    const endIdx = bosIdx;

    if (endIdx - startIdx < 3) continue; // Too short to be meaningful

    // Determine impulse high and low from wicks within the range
    let impulseHigh = -Infinity;
    let impulseLow = Infinity;

    for (let i = startIdx; i <= Math.min(endIdx, candles.length - 1); i++) {
      if (candles[i].high > impulseHigh) impulseHigh = candles[i].high;
      if (candles[i].low < impulseLow) impulseLow = candles[i].low;
    }

    const impulseRange = impulseHigh - impulseLow;
    if (impulseRange <= 0) continue;

    // Validate: no internal pullback exceeds 50% of the leg at that point
    const isValid = checkNoPullbackExceeds50(candles, startIdx, endIdx, direction);

    if (isValid) {
      return {
        high: impulseHigh,
        low: impulseLow,
        direction,
        startIndex: startIdx,
        endIndex: endIdx,
        isValid: true,
        bosPrice: bos.price,
      };
    }
  }

  return null;
}

/**
 * Check that no internal pullback within the impulse exceeds 50% of the leg
 * measured at that point in the move.
 */
function checkNoPullbackExceeds50(
  candles: Candle[],
  startIdx: number,
  endIdx: number,
  direction: "bullish" | "bearish",
): boolean {
  if (direction === "bullish") {
    // Bullish impulse: price moves up. Track running high.
    // A pullback is when price drops from the running high.
    // If pullback > 50% of (runningHigh - impulseStart.low), it fails.
    const startLow = candles[startIdx].low;
    let runningHigh = candles[startIdx].high;

    for (let i = startIdx + 1; i <= Math.min(endIdx, candles.length - 1); i++) {
      if (candles[i].high > runningHigh) {
        runningHigh = candles[i].high;
      }
      // Check pullback from running high
      const legAtThisPoint = runningHigh - startLow;
      if (legAtThisPoint <= 0) continue;

      const pullback = runningHigh - candles[i].low;
      const pullbackPercent = pullback / legAtThisPoint;

      if (pullbackPercent > 0.5) return false; // Exceeds 50%
    }
  } else {
    // Bearish impulse: price moves down. Track running low.
    const startHigh = candles[startIdx].high;
    let runningLow = candles[startIdx].low;

    for (let i = startIdx + 1; i <= Math.min(endIdx, candles.length - 1); i++) {
      if (candles[i].low < runningLow) {
        runningLow = candles[i].low;
      }
      // Check pullback from running low (price going up = pullback in bearish)
      const legAtThisPoint = startHigh - runningLow;
      if (legAtThisPoint <= 0) continue;

      const pullback = candles[i].high - runningLow;
      const pullbackPercent = pullback / legAtThisPoint;

      if (pullbackPercent > 0.5) return false; // Exceeds 50%
    }
  }

  return true;
}

// ─── 2. mapImpulsePOIs ────────────────────────────────────────────────────────

/**
 * Detect FVGs and OBs created WITHIN the impulse leg.
 * Only considers candles between startIndex and endIndex.
 *
 * @param candles - Same candles used for impulse detection
 * @param impulse - The validated impulse leg
 * @returns Array of POIs found within the impulse
 */
export function mapImpulsePOIs(
  candles: Candle[],
  impulse: ImpulseLeg,
): ImpulsePOI[] {
  if (!impulse.isValid) return [];

  // Extract the impulse sub-range of candles
  const start = Math.max(0, impulse.startIndex);
  const end = Math.min(candles.length, impulse.endIndex + 1);
  const impulseCandles = candles.slice(start, end);

  if (impulseCandles.length < 3) return [];

  // Detect FVGs within the impulse
  const structureBreaks = analyzeMarketStructure(impulseCandles);
  const breaks = [...structureBreaks.bos, ...structureBreaks.choch];
  const fvgs = detectFVGs(impulseCandles, breaks);
  const obs = detectOrderBlocks(impulseCandles, breaks);

  const pois: ImpulsePOI[] = [];

  // Map FVGs — only include those aligned with impulse direction
  for (const fvg of fvgs) {
    if (fvg.type === impulse.direction && fvg.state !== "filled") {
      pois.push({
        type: "fvg",
        high: fvg.high,
        low: fvg.low,
        candleIndex: start + fvg.index,
        direction: fvg.type,
      });
    }
  }

  // Map OBs — only include those aligned with impulse direction
  for (const ob of obs) {
    if (ob.type === impulse.direction && ob.state !== "broken" && ob.state !== "mitigated") {
      pois.push({
        type: "ob",
        high: ob.high,
        low: ob.low,
        candleIndex: start + ob.index,
        direction: ob.type,
      });
    }
  }

  return pois;
}

// ─── 3. overlayFibOnPOIs ──────────────────────────────────────────────────────

/**
 * Overlay Fibonacci levels on the impulse and score each POI by depth.
 *
 * Fib is anchored from:
 *   - Swing high wick = 1 (top of impulse)
 *   - Swing low wick = 0 (bottom of impulse)
 *
 * For bullish impulse: retracement goes DOWN from high, so deeper = lower price.
 * For bearish impulse: retracement goes UP from low, so deeper = higher price.
 *
 * @param impulse - The validated impulse leg
 * @param pois - POIs found within the impulse
 * @returns POIs ranked by Fib depth (deepest first)
 */
export function overlayFibOnPOIs(
  impulse: ImpulseLeg,
  pois: ImpulsePOI[],
): RankedPOI[] {
  if (pois.length === 0) return [];

  const range = impulse.high - impulse.low;
  if (range <= 0) return [];

  const tolerance = range * FIB_TOLERANCE_FRACTION;
  const ranked: RankedPOI[] = [];

  for (const poi of pois) {
    const poiMid = (poi.high + poi.low) / 2;

    // Calculate where this POI sits in the Fib retracement
    let fibDepth: number;
    if (impulse.direction === "bullish") {
      // Bullish: retracement from high. Fib 0.618 = high - 0.618 * range
      // fibDepth = how far down from the high (as fraction of range)
      fibDepth = (impulse.high - poiMid) / range;
    } else {
      // Bearish: retracement from low. Fib 0.618 = low + 0.618 * range
      // fibDepth = how far up from the low (as fraction of range)
      fibDepth = (poiMid - impulse.low) / range;
    }

    // Find the nearest Fib level
    let nearestFib = 0;
    let nearestDist = Infinity;
    for (const level of FIB_LEVELS) {
      const fibPrice = impulse.direction === "bullish"
        ? impulse.high - level * range
        : impulse.low + level * range;
      const dist = Math.abs(poiMid - fibPrice);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestFib = level;
      }
    }

    // Only include POIs that are within tolerance of a Fib level
    // OR that sit in the OTE zone (0.618 - 0.786)
    const inOTE = fibDepth >= 0.5 && fibDepth <= 0.85;
    const nearFib = nearestDist <= tolerance;

    if (!nearFib && !inOTE) continue; // POI not at a meaningful Fib level

    // Assign score based on depth
    const fibScore = FIB_SCORES[nearestFib] ?? (fibDepth >= 0.71 ? 3 : fibDepth >= 0.618 ? 2 : fibDepth >= 0.5 ? 1 : 0);

    ranked.push({
      poi,
      fibLevel: nearestFib,
      fibDepth,
      fibScore,
      srConfirmed: false,
      ltfRefined: false,
      totalScore: fibScore, // Will be updated by subsequent steps
    });
  }

  // Sort by fibDepth descending (deepest first = best)
  ranked.sort((a, b) => b.fibDepth - a.fibDepth);

  return ranked;
}

// ─── 4. checkHistoricalSR ─────────────────────────────────────────────────────

/**
 * Check if historical S/R levels (close-only, line chart equivalent) exist
 * inside each POI zone.
 *
 * Uses close prices only — this is the "line chart" approach the user described.
 * Looks BACK from before the impulse started to find pre-existing levels.
 *
 * @param candles - Full candle array (same TF as impulse detection)
 * @param zones - Ranked POIs from overlayFibOnPOIs
 * @param impulseStartIndex - Where the impulse started (look back from here)
 * @returns Same zones with srConfirmed updated
 */
export function checkHistoricalSR(
  candles: Candle[],
  zones: RankedPOI[],
  impulseStartIndex: number,
): RankedPOI[] {
  if (zones.length === 0) return zones;

  // Build close-price histogram from candles BEFORE the impulse
  const lookbackStart = Math.max(0, impulseStartIndex - SR_LOOKBACK);
  const lookbackEnd = impulseStartIndex;

  if (lookbackEnd - lookbackStart < 10) return zones; // Not enough history

  // Find close-price clusters (S/R levels)
  const closes: number[] = [];
  for (let i = lookbackStart; i < lookbackEnd; i++) {
    if (candles[i]) closes.push(candles[i].close);
  }

  if (closes.length < 10) return zones;

  // Calculate ATR for clustering tolerance
  const atr = calculateATR(candles.slice(lookbackStart, lookbackEnd));
  const clusterTolerance = atr * 0.3; // 30% of ATR as clustering tolerance

  // Find S/R levels: prices where closes cluster (multiple touches)
  const srLevels = findCloseClusters(closes, clusterTolerance, SR_MIN_TOUCHES);

  // Check each zone against S/R levels
  for (const zone of zones) {
    const zoneHigh = zone.poi.high;
    const zoneLow = zone.poi.low;

    for (const sr of srLevels) {
      if (sr >= zoneLow && sr <= zoneHigh) {
        zone.srConfirmed = true;
        zone.totalScore = zone.fibScore + 1; // +1 for S/R confirmation
        break;
      }
    }
  }

  return zones;
}

/**
 * Find price levels where closes cluster (line-chart S/R detection).
 * Groups close prices within tolerance and returns levels with >= minTouches.
 */
function findCloseClusters(
  closes: number[],
  tolerance: number,
  minTouches: number,
): number[] {
  if (closes.length === 0 || tolerance <= 0) return [];

  // Sort closes for efficient clustering
  const sorted = [...closes].sort((a, b) => a - b);
  const clusters: { level: number; count: number }[] = [];
  let clusterStart = 0;

  for (let i = 1; i <= sorted.length; i++) {
    // End of array or gap exceeds tolerance
    if (i === sorted.length || sorted[i] - sorted[i - 1] > tolerance) {
      const clusterSlice = sorted.slice(clusterStart, i);
      const count = clusterSlice.length;
      if (count >= minTouches) {
        // Use median as the S/R level
        const median = clusterSlice[Math.floor(clusterSlice.length / 2)];
        clusters.push({ level: median, count });
      }
      clusterStart = i;
    }
  }

  return clusters.map(c => c.level);
}

// ─── 5. refineLowerTF ─────────────────────────────────────────────────────────

/**
 * Drop to 15m (LTF) to find a precise OB or FVG inside the best zone.
 * This gives a tighter entry and SL than the HTF zone alone.
 *
 * @param entryCandles - 15m candles (the entry timeframe)
 * @param zone - The best-ranked zone from the HTF analysis
 * @returns Refined entry details or null if no LTF structure found
 */
export function refineLowerTF(
  entryCandles: Candle[],
  zone: RankedPOI,
): RankedPOI {
  if (entryCandles.length < 10) return zone;

  const zoneHigh = zone.poi.high;
  const zoneLow = zone.poi.low;

  // Find 15m candles that are INSIDE the zone
  const insideCandles: Candle[] = [];
  const insideIndices: number[] = [];
  for (let i = 0; i < entryCandles.length; i++) {
    const c = entryCandles[i];
    // Candle overlaps the zone
    if (c.high >= zoneLow && c.low <= zoneHigh) {
      insideCandles.push(c);
      insideIndices.push(i);
    }
  }

  if (insideCandles.length < 3) return zone; // Not enough LTF data inside zone

  // Run structure analysis on the inside candles
  const ltfStructure = analyzeMarketStructure(insideCandles);
  const ltfBreaks = [...ltfStructure.bos, ...ltfStructure.choch];

  // Detect LTF FVGs and OBs inside the zone
  const ltfFVGs = detectFVGs(insideCandles, ltfBreaks);
  const ltfOBs = detectOrderBlocks(insideCandles, ltfBreaks);

  // Find the best LTF POI aligned with the impulse direction
  let bestLTF: { type: "ob" | "fvg"; high: number; low: number } | null = null;

  // Prefer OBs over FVGs for precision
  for (const ob of ltfOBs) {
    if (ob.type === zone.poi.direction && ob.state !== "broken" && ob.state !== "mitigated") {
      // Ensure the OB is actually inside the zone boundaries
      if (ob.high <= zoneHigh && ob.low >= zoneLow) {
        bestLTF = { type: "ob", high: ob.high, low: ob.low };
        break;
      }
    }
  }

  // Fallback to FVG if no OB found
  if (!bestLTF) {
    for (const fvg of ltfFVGs) {
      if (fvg.type === zone.poi.direction && fvg.state !== "filled") {
        if (fvg.high <= zoneHigh && fvg.low >= zoneLow) {
          bestLTF = { type: "fvg", high: fvg.high, low: fvg.low };
          break;
        }
      }
    }
  }

  if (!bestLTF) return zone; // No LTF refinement found

  // Calculate refined entry and SL from the LTF POI
  const refinedEntry = zone.poi.direction === "bullish"
    ? bestLTF.high  // Enter at the top of the LTF OB/FVG for longs
    : bestLTF.low;  // Enter at the bottom for shorts

  const refinedSL = zone.poi.direction === "bullish"
    ? bestLTF.low   // SL below the LTF OB/FVG for longs
    : bestLTF.high; // SL above for shorts

  // Update the zone with LTF refinement
  zone.ltfRefined = true;
  zone.refinedEntry = refinedEntry;
  zone.refinedSL = refinedSL;
  zone.ltfType = bestLTF.type;
  zone.totalScore = zone.fibScore + (zone.srConfirmed ? 1 : 0) + 1; // +1 for LTF refinement

  return zone;
}

// ─── 6. rankAndSelectBestZone ─────────────────────────────────────────────────

/**
 * Rank all zones and select the best one.
 *
 * Scoring:
 *   - Fib depth: 78.6% = 4, 71% = 3, 61.8% = 2, 50% = 1
 *   - S/R confirmed: +1
 *   - LTF refined: +1
 *   - Maximum possible score: 6
 *
 * @param zones - All ranked POIs after S/R check and LTF refinement
 * @returns The highest-scoring zone, or null if none qualify
 */
export function rankAndSelectBestZone(
  zones: RankedPOI[],
): RankedPOI | null {
  if (zones.length === 0) return null;

  // Recalculate total scores
  for (const zone of zones) {
    zone.totalScore = zone.fibScore + (zone.srConfirmed ? 1 : 0) + (zone.ltfRefined ? 1 : 0);
  }

  // Sort by totalScore descending, then by fibDepth descending (tiebreaker)
  zones.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return b.fibDepth - a.fibDepth;
  });

  // Must have at least fibScore >= 1 (i.e., at 50% retracement or deeper)
  const best = zones.find(z => z.fibScore >= 1);
  return best || null;
}

// ─── 7. Main Entry Point: findBestEntryZone ───────────────────────────────────

/**
 * Full pipeline: find impulse → map POIs → Fib overlay → S/R check → LTF refine → rank.
 *
 * This is the function called by bot-scanner as a prerequisite gate.
 *
 * @param htfCandles - 1H candles (primary impulse detection timeframe)
 * @param entryCandles - 15m candles (for LTF refinement)
 * @param direction - The bias direction from confluence analysis
 * @param currentPrice - Current price for "at zone" check
 * @returns ZoneEngineResult with best zone or null + reason
 */
export function findBestEntryZone(
  htfCandles: Candle[],
  entryCandles: Candle[],
  direction: "bullish" | "bearish",
  currentPrice: number,
): ZoneEngineResult {
  // Step 1: Find impulse leg
  const impulse = findImpulseLeg(htfCandles, direction);
  if (!impulse) {
    return {
      bestZone: null,
      impulse: null,
      allZones: [],
      reason: `No valid ${direction} impulse leg found (no BOS or all pullbacks >50%)`,
    };
  }

  // Step 2: Map POIs within the impulse
  const pois = mapImpulsePOIs(htfCandles, impulse);
  if (pois.length === 0) {
    return {
      bestZone: null,
      impulse,
      allZones: [],
      reason: `Impulse found but no POIs (FVGs/OBs) detected within it`,
    };
  }

  // Step 3: Overlay Fib and score by depth
  let rankedZones = overlayFibOnPOIs(impulse, pois);
  if (rankedZones.length === 0) {
    return {
      bestZone: null,
      impulse,
      allZones: [],
      reason: `POIs found but none align with key Fib levels (50%-78.6%)`,
    };
  }

  // Step 4: Check historical S/R
  rankedZones = checkHistoricalSR(htfCandles, rankedZones, impulse.startIndex);

  // Step 5: LTF refinement on top zones (only refine top 3 to save compute)
  const topZones = rankedZones.slice(0, 3);
  for (let i = 0; i < topZones.length; i++) {
    topZones[i] = refineLowerTF(entryCandles, topZones[i]);
  }
  // Replace in full array
  for (let i = 0; i < topZones.length; i++) {
    rankedZones[i] = topZones[i];
  }

  // Step 6: Rank and select best
  const bestZonePOI = rankAndSelectBestZone(rankedZones);
  if (!bestZonePOI) {
    return {
      bestZone: null,
      impulse,
      allZones: rankedZones,
      reason: `Zones found but none scored high enough (need fibScore >= 1, i.e., at 50% or deeper)`,
    };
  }

  // Step 7: Check if current price is at the zone
  const atr = calculateATR(htfCandles);
  const proximityThreshold = atr * PRICE_AT_ZONE_ATR_MULT;
  const zoneHigh = bestZonePOI.poi.high;
  const zoneLow = bestZonePOI.poi.low;

  let priceAtZone = false;
  let distanceToZone = 0;

  if (currentPrice >= zoneLow && currentPrice <= zoneHigh) {
    priceAtZone = true;
    distanceToZone = 0;
  } else if (direction === "bullish") {
    // For longs, price should be approaching from above (retracing down to zone)
    distanceToZone = currentPrice - zoneHigh; // Positive = above zone, negative = below
    if (distanceToZone < 0) distanceToZone = zoneLow - currentPrice; // Below zone
    priceAtZone = Math.abs(currentPrice - zoneHigh) <= proximityThreshold
      || Math.abs(currentPrice - zoneLow) <= proximityThreshold;
  } else {
    // For shorts, price should be approaching from below (retracing up to zone)
    distanceToZone = zoneLow - currentPrice; // Positive = below zone, negative = above
    if (distanceToZone < 0) distanceToZone = currentPrice - zoneHigh; // Above zone
    priceAtZone = Math.abs(currentPrice - zoneHigh) <= proximityThreshold
      || Math.abs(currentPrice - zoneLow) <= proximityThreshold;
  }

  return {
    bestZone: {
      zone: bestZonePOI,
      impulse,
      priceAtZone,
      distanceToZone,
    },
    impulse,
    allZones: rankedZones,
    reason: priceAtZone
      ? `Valid ${direction} zone found: ${bestZonePOI.poi.type.toUpperCase()} at Fib ${(bestZonePOI.fibLevel * 100).toFixed(1)}% (score ${bestZonePOI.totalScore}/6) — price AT zone`
      : `Valid ${direction} zone found: ${bestZonePOI.poi.type.toUpperCase()} at Fib ${(bestZonePOI.fibLevel * 100).toFixed(1)}% (score ${bestZonePOI.totalScore}/6) — price ${distanceToZone.toFixed(5)} away`,
  };
}


// ─── Multi-Timeframe Zone Engine ──────────────────────────────────────────────
/**
 * Result from the multi-TF zone engine.
 * Includes the best zone across timeframes and individual TF results for transparency.
 */
export interface MultiTFZoneResult {
  bestZone: BestZone | null;
  selectedTF: "1H" | "4H" | null;  // Which timeframe produced the winning zone
  reason: string;
  h1Result: ZoneEngineResult;
  h4Result: ZoneEngineResult | null; // null when 4H candles not available
  allZones: RankedPOI[];            // Combined zones from both TFs
}

/**
 * findBestEntryZoneMultiTF — Runs the zone engine on both 1H and 4H candles,
 * then selects the best zone across both timeframes.
 *
 * Selection logic:
 *   1. If only one TF produces a valid zone, use that one.
 *   2. If both produce zones, prefer the one with:
 *      a. Higher totalScore
 *      b. On tie: deeper fibDepth (more premium zone)
 *      c. On tie: 4H wins (higher timeframe = more significant)
 *   3. If neither produces a zone, return null with combined reasons.
 *
 * @param h1Candles  - 1H candles (always available)
 * @param h4Candles  - 4H candles (may be empty if multiTFRegime disabled)
 * @param entryCandles - Entry TF candles (15m) for LTF refinement
 * @param direction  - Trade direction
 * @param currentPrice - Current market price for proximity check
 */
export function findBestEntryZoneMultiTF(
  h1Candles: Candle[],
  h4Candles: Candle[],
  entryCandles: Candle[],
  direction: "bullish" | "bearish",
  currentPrice: number,
): MultiTFZoneResult {
  // Always run 1H
  const h1Result = findBestEntryZone(h1Candles, entryCandles, direction, currentPrice);

  // Run 4H only if sufficient candles
  let h4Result: ZoneEngineResult | null = null;
  if (h4Candles.length >= 20) {
    h4Result = findBestEntryZone(h4Candles, entryCandles, direction, currentPrice);
  }

  // Combine all zones from both TFs for transparency
  const allZones: RankedPOI[] = [...h1Result.allZones];
  if (h4Result) {
    allZones.push(...h4Result.allZones);
  }

  // Selection logic
  const h1Zone = h1Result.bestZone;
  const h4Zone = h4Result?.bestZone ?? null;

  // Case: Neither TF has a zone
  if (!h1Zone && !h4Zone) {
    const reasons: string[] = [`1H: ${h1Result.reason}`];
    if (h4Result) reasons.push(`4H: ${h4Result.reason}`);
    else reasons.push("4H: Not available (insufficient candles)");
    return {
      bestZone: null,
      selectedTF: null,
      reason: `No valid zone on any timeframe. ${reasons.join("; ")}`,
      h1Result,
      h4Result,
      allZones,
    };
  }

  // Case: Only 1H has a zone
  if (h1Zone && !h4Zone) {
    return {
      bestZone: h1Zone,
      selectedTF: "1H",
      reason: `1H zone selected (4H ${h4Result ? "found no zone" : "not available"}): ${h1Result.reason}`,
      h1Result,
      h4Result,
      allZones,
    };
  }

  // Case: Only 4H has a zone
  if (!h1Zone && h4Zone) {
    return {
      bestZone: h4Zone,
      selectedTF: "4H",
      reason: `4H zone selected (1H found no zone): ${h4Result!.reason}`,
      h1Result,
      h4Result,
      allZones,
    };
  }

  // Case: Both have zones — pick the best
  const h1Score = h1Zone!.zone.totalScore;
  const h4Score = h4Zone!.zone.totalScore;

  if (h4Score > h1Score) {
    return {
      bestZone: h4Zone!,
      selectedTF: "4H",
      reason: `4H zone wins (score ${h4Score} > 1H score ${h1Score}): ${h4Result!.reason}`,
      h1Result,
      h4Result,
      allZones,
    };
  }

  if (h1Score > h4Score) {
    return {
      bestZone: h1Zone!,
      selectedTF: "1H",
      reason: `1H zone wins (score ${h1Score} > 4H score ${h4Score}): ${h1Result.reason}`,
      h1Result,
      h4Result,
      allZones,
    };
  }

  // Tie on totalScore — use fibDepth as tiebreaker
  const h1Depth = h1Zone!.zone.fibDepth;
  const h4Depth = h4Zone!.zone.fibDepth;

  if (h4Depth > h1Depth) {
    return {
      bestZone: h4Zone!,
      selectedTF: "4H",
      reason: `4H zone wins on depth (${h4Depth.toFixed(3)} > ${h1Depth.toFixed(3)}, tied score ${h4Score}): ${h4Result!.reason}`,
      h1Result,
      h4Result,
      allZones,
    };
  }

  if (h1Depth > h4Depth) {
    return {
      bestZone: h1Zone!,
      selectedTF: "1H",
      reason: `1H zone wins on depth (${h1Depth.toFixed(3)} > ${h4Depth.toFixed(3)}, tied score ${h1Score}): ${h1Result.reason}`,
      h1Result,
      h4Result,
      allZones,
    };
  }

  // Perfect tie — 4H wins (higher timeframe = more significant structure)
  return {
    bestZone: h4Zone!,
    selectedTF: "4H",
    reason: `4H zone wins (tied score ${h4Score}, tied depth ${h4Depth.toFixed(3)} — HTF preferred): ${h4Result!.reason}`,
    h1Result,
    h4Result,
    allZones,
  };
}
