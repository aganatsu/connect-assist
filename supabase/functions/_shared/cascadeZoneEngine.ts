/**
 * Cascade Zone Engine — Top-Down Sequential Zone Detection
 *
 * Implements the ICT top-down approach:
 *   Daily → 4H → 1H → 15m (each level narrows the range)
 *
 * The story:
 *   1. Daily impulse leg → identify Daily OB/FVG at premium Fib levels
 *   2. Price retraces into the Daily zone (the "area of interest")
 *   3. 4H shows displacement/engulfing OR 1H CHoCH inside the Daily zone (confirmation)
 *   4. 1H OB/FVG within the confirmed area → entry zone
 *   5. 15m refines entry/SL for precision
 *
 * This module REUSES functions from impulseZoneEngine.ts and smcAnalysis.ts.
 * It does NOT modify them — it orchestrates them in a sequential cascade.
 */

import type {
  Candle, OrderBlock, FairValueGap, StructureBreak, BreakerBlock, FibLevels,
} from "./smcAnalysis.ts";
import {
  analyzeMarketStructure, detectOrderBlocks, detectFVGs, detectBreakerBlocks,
  calculateATR, detectDisplacement, detectZigZagPivots, computeFibLevels,
} from "./smcAnalysis.ts";
import {
  findImpulseLeg, mapImpulsePOIs, overlayFibOnPOIs, checkHistoricalSR,
  refineLowerTF, rankAndSelectBestZone,
} from "./impulseZoneEngine.ts";
import type { ImpulseLeg, ImpulsePOI, RankedPOI, BestZone } from "./impulseZoneEngine.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** State of the cascade — tracks where we are in the top-down flow */
export type CascadeState =
  | "no_daily_impulse"       // No valid Daily impulse found
  | "no_daily_zone"          // Daily impulse exists but no POIs at Fib levels
  | "waiting_for_price"      // Daily zone exists, price not there yet
  | "at_daily_zone"          // Price is at/in the Daily zone
  | "no_confirmation"        // Price at Daily zone but no 4H displacement / 1H CHoCH
  | "confirmed"              // 4H displacement or 1H CHoCH detected inside Daily zone
  | "no_entry_zone"          // Confirmed but no 1H entry zone found within the area
  | "ready"                  // Entry zone found, price approaching
  | "triggered";             // Price at entry zone — execute

/** Daily zone: the area of interest from the Daily impulse */
export interface DailyZone {
  impulse: ImpulseLeg;
  poi: ImpulsePOI;           // The best Daily POI (OB or FVG)
  fibLevel: number;          // Fib level of this POI (e.g. 0.618, 0.786)
  fibScore: number;
  high: number;
  low: number;
  srConfirmed: boolean;
}

/** 4H confirmation signal */
export interface ConfirmationSignal {
  type: "displacement" | "choch_1h";
  direction: "bullish" | "bearish";
  index: number;             // Candle index where confirmation occurred
  insideDailyZone: boolean;  // Was the signal inside the Daily zone?
}

/** Full cascade result */
export interface CascadeResult {
  state: CascadeState;
  reason: string;

  // Daily level
  dailyZone: DailyZone | null;
  dailyZoneDistance: number;  // Pips from current price to Daily zone (0 if inside)

  // Confirmation level
  confirmation: ConfirmationSignal | null;

  // Entry level (1H zone within the confirmed area)
  entryZone: RankedPOI | null;
  entryZoneRefined: boolean;  // Whether 15m refinement was applied

  // Final entry details
  entry: number | null;       // Precise entry price
  sl: number | null;          // Stop loss price
  priceAtEntry: boolean;      // Is current price at the entry zone?
  distancePips: number;       // Distance to entry in pips
}

/** Options for the cascade engine */
export interface CascadeOptions {
  /** ATR multiplier for "price at Daily zone" proximity. Default: 2.0 */
  dailyZoneATRMult?: number;
  /** ATR multiplier for "price at entry zone" (strict). Default: 0.3 */
  entryStrictATRMult?: number;
  /** Minimum Fib depth for Daily zone (e.g. 0.5 = at least 50%). Default: 0.5 */
  minDailyFibDepth?: number;
  /** Whether to require S/R confirmation on Daily zone. Default: false */
  requireDailySR?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DAILY_ZONE_ATR_MULT_DEFAULT = 2.0;
const ENTRY_STRICT_ATR_MULT_DEFAULT = 0.3;
const MIN_DAILY_FIB_DEPTH_DEFAULT = 0.5;

// ─── 1. findDailyZone ─────────────────────────────────────────────────────────

/**
 * Find the Daily impulse leg and identify the best POI (OB/FVG) at a premium
 * Fib level. This becomes the "area of interest" for the trade.
 *
 * @param dailyCandles - Daily candles (need at least 30 for meaningful structure)
 * @param direction - Trade direction ("bullish" or "bearish")
 * @param options - Engine options
 * @returns DailyZone or null with reason
 */
export function findDailyZone(
  dailyCandles: Candle[],
  direction: "bullish" | "bearish",
  options?: CascadeOptions,
): { zone: DailyZone | null; reason: string } {
  if (dailyCandles.length < 30) {
    return { zone: null, reason: "Insufficient daily candles (need 30+)" };
  }

  // Step 1: Find Daily impulse leg
  const impulse = findImpulseLeg(dailyCandles, direction);
  if (!impulse) {
    return { zone: null, reason: `No valid ${direction} Daily impulse (no BOS or origin broken)` };
  }

  // Step 2: Map POIs within the Daily impulse
  const pois = mapImpulsePOIs(dailyCandles, impulse);
  if (pois.length === 0) {
    return { zone: null, reason: "Daily impulse found but no POIs (OBs/FVGs) within it" };
  }

  // Step 3: Overlay Fib and rank by depth
  const ranked = overlayFibOnPOIs(impulse, pois);
  if (ranked.length === 0) {
    return { zone: null, reason: "Daily POIs found but none at key Fib levels (50%-78.6%)" };
  }

  // Step 4: Check historical S/R on Daily
  const withSR = checkHistoricalSR(dailyCandles, ranked, impulse.startIndex);

  // Step 5: Filter by minimum Fib depth
  const minDepth = options?.minDailyFibDepth ?? MIN_DAILY_FIB_DEPTH_DEFAULT;
  const qualifying = withSR.filter(z => z.fibDepth >= minDepth);
  if (qualifying.length === 0) {
    return { zone: null, reason: `Daily zones found but none deep enough (need >= ${(minDepth * 100).toFixed(0)}% Fib)` };
  }

  // Step 6: If requireDailySR is set, filter further
  let candidates = qualifying;
  if (options?.requireDailySR) {
    candidates = qualifying.filter(z => z.srConfirmed);
    if (candidates.length === 0) {
      return { zone: null, reason: "Daily zones found at Fib but none have S/R confirmation" };
    }
  }

  // Select the best: deepest Fib with most confluence
  candidates.sort((a, b) => {
    // Prefer S/R confirmed
    if (a.srConfirmed !== b.srConfirmed) return a.srConfirmed ? -1 : 1;
    // Then by fibDepth (deeper = better)
    return b.fibDepth - a.fibDepth;
  });

  const best = candidates[0];
  return {
    zone: {
      impulse,
      poi: best.poi,
      fibLevel: best.fibLevel,
      fibScore: best.fibScore,
      high: best.poi.high,
      low: best.poi.low,
      srConfirmed: best.srConfirmed,
    },
    reason: `Daily ${best.poi.type.toUpperCase()} at Fib ${(best.fibLevel * 100).toFixed(1)}%${best.srConfirmed ? " (S/R confirmed)" : ""}`,
  };
}

// ─── 2. checkPriceAtDailyZone ─────────────────────────────────────────────────

/**
 * Check if current price is at or inside the Daily zone.
 * Uses a wider proximity than the entry zone (Daily zones are larger structures).
 *
 * @param currentPrice - Current market price
 * @param dailyZone - The identified Daily zone
 * @param atr - ATR from the timeframe used for proximity (typically 4H ATR)
 * @param options - Engine options
 * @returns Whether price is at the zone and distance info
 */
export function checkPriceAtDailyZone(
  currentPrice: number,
  dailyZone: DailyZone,
  atr: number,
  options?: CascadeOptions,
): { atZone: boolean; insideZone: boolean; distancePips: number } {
  const mult = options?.dailyZoneATRMult ?? DAILY_ZONE_ATR_MULT_DEFAULT;
  const threshold = atr * mult;

  const insideZone = currentPrice >= dailyZone.low && currentPrice <= dailyZone.high;

  let distance = 0;
  if (!insideZone) {
    if (currentPrice > dailyZone.high) {
      distance = currentPrice - dailyZone.high;
    } else {
      distance = dailyZone.low - currentPrice;
    }
  }

  const atZone = insideZone || distance <= threshold;
  const distancePips = distance * 10000; // Approximate for 5-digit pairs

  return { atZone, insideZone, distancePips };
}

// ─── 3. detect4HConfirmation ──────────────────────────────────────────────────

/**
 * Detect 4H confirmation (displacement/engulfing) inside the Daily zone.
 *
 * A displacement candle is one with:
 *   - Body >= 70% of range (strong directional candle)
 *   - Range >= 1.5× average range (bigger than normal)
 *   - Body >= 2× average body (significantly larger)
 *
 * The displacement must be:
 *   - In the trade direction (bullish for longs, bearish for shorts)
 *   - Occurring while price is inside or near the Daily zone
 *
 * @param h4Candles - 4H candles
 * @param dailyZone - The Daily zone (area of interest)
 * @param direction - Trade direction
 * @returns ConfirmationSignal or null
 */
export function detect4HConfirmation(
  h4Candles: Candle[],
  dailyZone: DailyZone,
  direction: "bullish" | "bearish",
): ConfirmationSignal | null {
  if (h4Candles.length < 25) return null;

  // Check for displacement in the last 5 candles
  const displacement = detectDisplacement(h4Candles);

  if (displacement.isDisplacement && displacement.lastDirection === direction) {
    // Verify the displacement candle is inside/near the Daily zone
    const lastDisp = displacement.displacementCandles[displacement.displacementCandles.length - 1];
    const dispCandle = h4Candles[lastDisp.index];

    // The displacement candle should overlap with the Daily zone
    const overlaps = dispCandle.high >= dailyZone.low && dispCandle.low <= dailyZone.high;
    // Or be very close (within one candle range of the zone)
    const atr = calculateATR(h4Candles);
    const nearZone = Math.abs(dispCandle.close - (direction === "bullish" ? dailyZone.low : dailyZone.high)) <= atr;

    if (overlaps || nearZone) {
      return {
        type: "displacement",
        direction,
        index: lastDisp.index,
        insideDailyZone: overlaps,
      };
    }
  }

  return null;
}

// ─── 4. detect1HConfirmation ──────────────────────────────────────────────────

/**
 * Detect 1H CHoCH (Change of Character) inside the Daily zone as an
 * alternative confirmation when 4H displacement hasn't fired.
 *
 * A CHoCH is a break of the most recent swing in the opposite direction,
 * signaling the correction is over and the trend is resuming.
 *
 * @param h1Candles - 1H candles
 * @param dailyZone - The Daily zone
 * @param direction - Trade direction
 * @returns ConfirmationSignal or null
 */
export function detect1HConfirmation(
  h1Candles: Candle[],
  dailyZone: DailyZone,
  direction: "bullish" | "bearish",
): ConfirmationSignal | null {
  if (h1Candles.length < 20) return null;

  const structure = analyzeMarketStructure(h1Candles);

  // Look for CHoCH in the trade direction in the recent candles
  const recentCHoCH = structure.choch
    .filter(c => c.type === direction && c.closeBased)
    .sort((a, b) => b.index - a.index); // Most recent first

  if (recentCHoCH.length === 0) return null;

  // The CHoCH must have occurred while price was in/near the Daily zone
  const choch = recentCHoCH[0];
  const chochCandle = h1Candles[choch.index];
  if (!chochCandle) return null;

  // Check if the CHoCH candle overlaps with the Daily zone
  const overlaps = chochCandle.high >= dailyZone.low && chochCandle.low <= dailyZone.high;
  // Or if the CHoCH price level is inside the Daily zone
  const priceInZone = choch.price >= dailyZone.low && choch.price <= dailyZone.high;

  // Also check recency — CHoCH should be in the last 20 candles (20 hours)
  const isRecent = choch.index >= h1Candles.length - 20;

  if ((overlaps || priceInZone) && isRecent) {
    return {
      type: "choch_1h",
      direction,
      index: choch.index,
      insideDailyZone: overlaps || priceInZone,
    };
  }

  return null;
}

// ─── 5. findEntryZoneWithinDailyZone ──────────────────────────────────────────

/**
 * Find the 1H entry zone that sits WITHIN the Daily zone.
 *
 * This is the key difference from the parallel engine: we don't search all of
 * 1H for zones — we only accept zones that overlap with the Daily area of interest.
 *
 * The 1H zone must:
 *   - Be an OB or FVG from a 1H impulse
 *   - Sit at a Fib level of the 1H impulse
 *   - Overlap with the Daily zone boundaries
 *
 * @param h1Candles - 1H candles
 * @param dailyZone - The Daily zone (area of interest)
 * @param direction - Trade direction
 * @returns Best 1H zone within the Daily zone, or null
 */
export function findEntryZoneWithinDailyZone(
  h1Candles: Candle[],
  dailyZone: DailyZone,
  direction: "bullish" | "bearish",
): { zone: RankedPOI | null; allZones: RankedPOI[]; reason: string } {
  if (h1Candles.length < 20) {
    return { zone: null, allZones: [], reason: "Insufficient 1H candles" };
  }

  // Step 1: Find 1H impulse leg
  const impulse = findImpulseLeg(h1Candles, direction);
  if (!impulse) {
    return { zone: null, allZones: [], reason: "No valid 1H impulse found" };
  }

  // Step 2: Map POIs within the 1H impulse
  const pois = mapImpulsePOIs(h1Candles, impulse);
  if (pois.length === 0) {
    return { zone: null, allZones: [], reason: "1H impulse found but no POIs within it" };
  }

  // Step 3: Overlay Fib
  let ranked = overlayFibOnPOIs(impulse, pois);
  if (ranked.length === 0) {
    return { zone: null, allZones: [], reason: "1H POIs found but none at key Fib levels" };
  }

  // Step 4: Check S/R
  ranked = checkHistoricalSR(h1Candles, ranked, impulse.startIndex);

  // Step 5: FILTER — only keep zones that overlap with the Daily zone
  const withinDaily = ranked.filter(z => {
    const zHigh = z.poi.high;
    const zLow = z.poi.low;
    // Overlap: max(zone.low, daily.low) <= min(zone.high, daily.high)
    return Math.max(zLow, dailyZone.low) <= Math.min(zHigh, dailyZone.high);
  });

  if (withinDaily.length === 0) {
    return {
      zone: null,
      allZones: ranked,
      reason: `${ranked.length} 1H zone(s) found but none overlap with Daily zone [${dailyZone.low.toFixed(5)}-${dailyZone.high.toFixed(5)}]`,
    };
  }

  // Step 6: Select the best zone within the Daily zone
  const best = rankAndSelectBestZone(withinDaily);
  if (!best) {
    return {
      zone: null,
      allZones: withinDaily,
      reason: "1H zones within Daily zone found but none scored high enough (need fibScore >= 1)",
    };
  }

  return {
    zone: best,
    allZones: withinDaily,
    reason: `1H ${best.poi.type.toUpperCase()} at Fib ${(best.fibLevel * 100).toFixed(1)}% within Daily zone`,
  };
}

// ─── 6. Main Entry Point: findCascadeZone ─────────────────────────────────────

/**
 * Full cascade pipeline: Daily → 4H confirmation → 1H entry → 15m refine.
 *
 * This is the function called by bot-scanner when cascade mode is enabled.
 * Each step narrows the range. If any step fails, the cascade reports its
 * current state so the scanner knows whether to wait or skip.
 *
 * @param dailyCandles - Daily candles (30+ required)
 * @param h4Candles - 4H candles (25+ for displacement detection)
 * @param h1Candles - 1H candles (20+ for structure)
 * @param entryCandles - 15m candles for LTF refinement
 * @param direction - Trade direction ("bullish" or "bearish")
 * @param currentPrice - Current market price
 * @param options - Engine options
 * @returns CascadeResult with state, zones, and entry details
 */
export function findCascadeZone(
  dailyCandles: Candle[],
  h4Candles: Candle[],
  h1Candles: Candle[],
  entryCandles: Candle[],
  direction: "bullish" | "bearish",
  currentPrice: number,
  options?: CascadeOptions,
): CascadeResult {
  const noResult = (state: CascadeState, reason: string): CascadeResult => ({
    state,
    reason,
    dailyZone: null,
    dailyZoneDistance: 0,
    confirmation: null,
    entryZone: null,
    entryZoneRefined: false,
    entry: null,
    sl: null,
    priceAtEntry: false,
    distancePips: 0,
  });

  // ── Step 1: Find Daily Zone ──
  const dailyResult = findDailyZone(dailyCandles, direction, options);
  if (!dailyResult.zone) {
    return noResult("no_daily_impulse", dailyResult.reason);
  }
  const dailyZone = dailyResult.zone;

  // ── Step 2: Check if price is at the Daily zone ──
  const h4ATR = h4Candles.length >= 14 ? calculateATR(h4Candles) : calculateATR(h1Candles);
  const proximity = checkPriceAtDailyZone(currentPrice, dailyZone, h4ATR, options);

  if (!proximity.atZone) {
    return {
      state: "waiting_for_price",
      reason: `Daily zone found (${dailyResult.reason}) but price is ${proximity.distancePips.toFixed(1)} pips away`,
      dailyZone,
      dailyZoneDistance: proximity.distancePips,
      confirmation: null,
      entryZone: null,
      entryZoneRefined: false,
      entry: null,
      sl: null,
      priceAtEntry: false,
      distancePips: proximity.distancePips,
    };
  }

  // ── Step 3: Look for confirmation (4H displacement OR 1H CHoCH) ──
  let confirmation: ConfirmationSignal | null = null;

  // Try 4H displacement first (stronger signal)
  confirmation = detect4HConfirmation(h4Candles, dailyZone, direction);

  // Fallback to 1H CHoCH if no 4H displacement
  if (!confirmation) {
    confirmation = detect1HConfirmation(h1Candles, dailyZone, direction);
  }

  if (!confirmation) {
    return {
      state: "no_confirmation",
      reason: `Price at Daily zone (${dailyResult.reason}) but no 4H displacement or 1H CHoCH detected`,
      dailyZone,
      dailyZoneDistance: 0,
      confirmation: null,
      entryZone: null,
      entryZoneRefined: false,
      entry: null,
      sl: null,
      priceAtEntry: false,
      distancePips: 0,
    };
  }

  // ── Step 4: Find 1H entry zone within the Daily zone ──
  const entryResult = findEntryZoneWithinDailyZone(h1Candles, dailyZone, direction);

  if (!entryResult.zone) {
    return {
      state: "no_entry_zone",
      reason: `Confirmed (${confirmation.type}) but ${entryResult.reason}`,
      dailyZone,
      dailyZoneDistance: 0,
      confirmation,
      entryZone: null,
      entryZoneRefined: false,
      entry: null,
      sl: null,
      priceAtEntry: false,
      distancePips: 0,
    };
  }

  // ── Step 5: Refine on 15m ──
  let entryZone = entryResult.zone;
  let refined = false;
  if (entryCandles.length >= 10) {
    entryZone = refineLowerTF(entryCandles, entryZone);
    refined = entryZone.ltfRefined;
  }

  // ── Step 6: Calculate entry and SL ──
  const entry = entryZone.refinedEntry ?? (direction === "bullish" ? entryZone.poi.high : entryZone.poi.low);
  const sl = entryZone.refinedSL ?? (direction === "bullish" ? dailyZone.low : dailyZone.high);

  // ── Step 7: Check if price is at the entry zone ──
  const entryATR = calculateATR(h1Candles);
  const strictMult = options?.entryStrictATRMult ?? ENTRY_STRICT_ATR_MULT_DEFAULT;
  const strictThreshold = entryATR * strictMult;

  const entryHigh = entryZone.poi.high;
  const entryLow = entryZone.poi.low;
  const insideEntry = currentPrice >= entryLow && currentPrice <= entryHigh;

  let entryDistance = 0;
  if (!insideEntry) {
    if (currentPrice > entryHigh) entryDistance = currentPrice - entryHigh;
    else entryDistance = entryLow - currentPrice;
  }

  const priceAtEntry = insideEntry || entryDistance <= strictThreshold;
  const entryDistancePips = entryDistance * 10000;

  // Determine final state
  const state: CascadeState = priceAtEntry ? "triggered" : "ready";

  return {
    state,
    reason: `Cascade complete: Daily ${dailyZone.poi.type.toUpperCase()} @ Fib ${(dailyZone.fibLevel * 100).toFixed(1)}% → ${confirmation.type} confirmed → 1H ${entryZone.poi.type.toUpperCase()} @ Fib ${(entryZone.fibLevel * 100).toFixed(1)}%${refined ? " (15m refined)" : ""} — ${priceAtEntry ? "TRIGGERED" : `${entryDistancePips.toFixed(1)} pips to entry`}`,
    dailyZone,
    dailyZoneDistance: 0,
    confirmation,
    entryZone,
    entryZoneRefined: refined,
    entry,
    sl,
    priceAtEntry,
    distancePips: entryDistancePips,
  };
}
