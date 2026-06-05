/**
 * dailyImpulseOB.ts — ICT Daily Impulse & Order Block Containment Engine
 * ────────────────────────────────────────────────────────────────────────
 * Implements the ICT 2022 Mentorship daily-level framework:
 *
 *   1. Detect Daily Displacement (2-5 consecutive large-bodied candles)
 *   2. Identify the Daily OB (last opposing candle before displacement)
 *   3. Validate the Daily OB (origin not broken)
 *   4. Containment Check: verify that LTF zones (4H/1H) sit INSIDE the Daily OB
 *
 * ICT's process:
 *   - See daily displacement → identify Daily OB
 *   - Wait for price to retrace into Daily OB
 *   - Scale down: find 4H OB/FVG inside Daily OB
 *   - Scale down: find 1H OB/FVG inside 4H zone
 *   - Scale down: find 15m entry inside 1H zone
 *
 * This module does NOT modify smcAnalysis.ts — it CALLS its exported functions.
 */
import type { Candle, FairValueGap, OrderBlock } from "./smcAnalysis.ts";
import { calculateATR, detectFVGs, detectOrderBlocks, analyzeMarketStructure } from "./smcAnalysis.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DailyDisplacementLeg {
  /** Direction of the displacement */
  direction: "bullish" | "bearish";
  /** Start index of the displacement candles */
  startIndex: number;
  /** End index of the displacement candles */
  endIndex: number;
  /** Number of consecutive displacement candles */
  candleCount: number;
  /** Total range covered by the displacement (high to low of the entire leg) */
  totalRange: number;
  /** Average body-to-range ratio of displacement candles */
  avgBodyRatio: number;
  /** Average range multiple vs ATR */
  avgRangeMultiple: number;
  /** The high of the displacement leg */
  high: number;
  /** The low of the displacement leg */
  low: number;
}

export interface DailyOB {
  /** The high of the OB (last opposing candle before displacement) */
  high: number;
  /** The low of the OB */
  low: number;
  /** Direction of the OB (opposite of displacement direction) */
  direction: "bullish" | "bearish";
  /** Candle index of the OB */
  index: number;
  /** Datetime of the OB candle */
  datetime: string;
  /** Is the OB still valid? (origin not broken by close) */
  isValid: boolean;
  /** Has price retraced into this OB? */
  priceInZone: boolean;
  /** The displacement leg that created this OB */
  displacement: DailyDisplacementLeg;
  /** Invalidation price (if price closes past this, OB is dead) */
  invalidationPrice: number;
}

export interface ContainmentResult {
  /** Does the LTF zone sit inside the Daily OB? */
  isContained: boolean;
  /** Percentage of the LTF zone that overlaps with the Daily OB (0-100) */
  overlapPercent: number;
  /** The Daily OB being checked against */
  dailyOB: DailyOB;
  /** Human-readable explanation */
  reason: string;
}

export interface DailyImpulseResult {
  /** Were any daily displacements found? */
  hasDisplacement: boolean;
  /** All displacement legs found (most recent first) */
  displacements: DailyDisplacementLeg[];
  /** The most relevant Daily OB (most recent valid one in trade direction) */
  primaryOB: DailyOB | null;
  /** All Daily OBs found (most recent first) */
  allOBs: DailyOB[];
  /** Human-readable explanation */
  reason: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum daily candles required */
const MIN_DAILY_CANDLES = 30;

/** Minimum body-to-range ratio for a displacement candle (70%) */
const DISPLACEMENT_BODY_RATIO = 0.65;

/** Minimum range multiple vs ATR for displacement (1.3x ATR) */
const DISPLACEMENT_RANGE_MULT = 1.3;

/** Minimum body multiple vs average body for displacement (1.8x) */
const DISPLACEMENT_BODY_MULT = 1.8;

/** Minimum consecutive candles to form a displacement leg */
const MIN_DISPLACEMENT_CANDLES = 2;

/** Maximum lookback for finding the OB candle before displacement */
const OB_LOOKBACK = 3;

// ─── Main Functions ───────────────────────────────────────────────────────────

/**
 * detectDailyDisplacements — Find all displacement legs on the daily chart.
 *
 * A displacement leg is 2+ consecutive large-bodied candles in the same direction
 * that show clear institutional commitment (ICT's "displacement").
 *
 * Criteria per candle:
 *   - Body ≥ 65% of total range (strong directional candle)
 *   - Range ≥ 1.3× ATR (bigger than average)
 *   - Body ≥ 1.8× average body (significantly larger than normal)
 *
 * @param dailyCandles - Daily candles (at least 30)
 * @returns Array of displacement legs, most recent first
 */
export function detectDailyDisplacements(dailyCandles: Candle[]): DailyDisplacementLeg[] {
  if (dailyCandles.length < MIN_DAILY_CANDLES) return [];

  const atr = calculateATR(dailyCandles, 14);
  if (atr <= 0) return [];

  // Calculate average body size over last 20 candles for comparison
  const lookback = Math.min(20, dailyCandles.length - 5);
  const refCandles = dailyCandles.slice(-(lookback + 5), -5);
  let bodySum = 0;
  for (const c of refCandles) {
    bodySum += Math.abs(c.close - c.open);
  }
  const avgBody = bodySum / refCandles.length;
  if (avgBody <= 0) return [];

  // Scan for displacement candles
  const displacementFlags: { index: number; direction: "bullish" | "bearish"; bodyRatio: number; rangeMult: number }[] = [];

  for (let i = 5; i < dailyCandles.length; i++) {
    const c = dailyCandles[i];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    if (range <= 0) continue;

    const bodyRatio = body / range;
    const rangeMult = range / atr;
    const bodyMult = body / avgBody;

    if (bodyRatio >= DISPLACEMENT_BODY_RATIO && rangeMult >= DISPLACEMENT_RANGE_MULT && bodyMult >= DISPLACEMENT_BODY_MULT) {
      const direction: "bullish" | "bearish" = c.close > c.open ? "bullish" : "bearish";
      displacementFlags.push({ index: i, direction, bodyRatio, rangeMult });
    }
  }

  // Group consecutive same-direction displacement candles into legs
  const legs: DailyDisplacementLeg[] = [];
  let i = 0;
  while (i < displacementFlags.length) {
    const start = displacementFlags[i];
    let end = start;
    let j = i + 1;

    // Allow up to 1 gap candle between displacement candles (small pause in the move)
    while (j < displacementFlags.length) {
      const next = displacementFlags[j];
      if (next.direction === start.direction && next.index - end.index <= 2) {
        end = next;
        j++;
      } else {
        break;
      }
    }

    const candleCount = end.index - start.index + 1;
    const actualDisplacementCount = j - i; // Number of actual displacement candles (not gaps)

    if (actualDisplacementCount >= MIN_DISPLACEMENT_CANDLES) {
      // Calculate leg metrics
      const legCandles = dailyCandles.slice(start.index, end.index + 1);
      const high = Math.max(...legCandles.map(c => c.high));
      const low = Math.min(...legCandles.map(c => c.low));
      const totalRange = high - low;

      let bodyRatioSum = 0;
      let rangeMultSum = 0;
      for (let k = i; k < j; k++) {
        bodyRatioSum += displacementFlags[k].bodyRatio;
        rangeMultSum += displacementFlags[k].rangeMult;
      }

      legs.push({
        direction: start.direction,
        startIndex: start.index,
        endIndex: end.index,
        candleCount,
        totalRange,
        avgBodyRatio: bodyRatioSum / actualDisplacementCount,
        avgRangeMultiple: rangeMultSum / actualDisplacementCount,
        high,
        low,
      });
    }

    i = j;
  }

  // Return most recent first
  return legs.reverse();
}

/**
 * findDailyOB — For each displacement leg, find the Order Block
 * (last opposing candle before the displacement started).
 *
 * ICT's definition: The OB is the last candle that moved AGAINST the displacement
 * direction, immediately before the displacement began. This is where institutions
 * placed their orders.
 *
 * @param dailyCandles - Daily candles
 * @param displacement - The displacement leg to find the OB for
 * @param currentPrice - Current price for validity/proximity checks
 * @returns The Daily OB, or null if not found
 */
export function findDailyOB(
  dailyCandles: Candle[],
  displacement: DailyDisplacementLeg,
  currentPrice: number,
): DailyOB | null {
  // Look backwards from the displacement start to find the last opposing candle
  const searchStart = displacement.startIndex - 1;
  const searchEnd = Math.max(0, displacement.startIndex - OB_LOOKBACK - 1);

  for (let i = searchStart; i >= searchEnd; i--) {
    const c = dailyCandles[i];
    const isBullish = c.close > c.open;
    const isBearish = c.close < c.open;

    // For a bearish displacement, OB is the last BULLISH candle before
    // For a bullish displacement, OB is the last BEARISH candle before
    const isOpposing = (displacement.direction === "bearish" && isBullish) ||
                       (displacement.direction === "bullish" && isBearish);

    if (isOpposing) {
      // Found the OB candle
      const obDirection: "bullish" | "bearish" = displacement.direction === "bearish" ? "bearish" : "bullish";

      // Determine invalidation price:
      // For bearish OB (sell zone): invalidation is if price CLOSES above OB high
      // For bullish OB (buy zone): invalidation is if price CLOSES below OB low
      const invalidationPrice = obDirection === "bearish" ? c.high : c.low;

      // Check validity: has price closed past the invalidation level after the displacement?
      let isValid = true;
      for (let k = displacement.endIndex + 1; k < dailyCandles.length; k++) {
        if (obDirection === "bearish" && dailyCandles[k].close > c.high) {
          isValid = false;
          break;
        }
        if (obDirection === "bullish" && dailyCandles[k].close < c.low) {
          isValid = false;
          break;
        }
      }

      // Check if price is currently inside the OB zone
      const priceInZone = currentPrice >= c.low && currentPrice <= c.high;

      return {
        high: c.high,
        low: c.low,
        direction: obDirection,
        index: i,
        datetime: c.datetime,
        isValid,
        priceInZone,
        displacement,
        invalidationPrice,
      };
    }
  }

  // If no opposing candle found, use the candle immediately before displacement
  if (searchStart >= 0) {
    const c = dailyCandles[searchStart];
    const obDirection: "bullish" | "bearish" = displacement.direction === "bearish" ? "bearish" : "bullish";
    const invalidationPrice = obDirection === "bearish" ? c.high : c.low;

    let isValid = true;
    for (let k = displacement.endIndex + 1; k < dailyCandles.length; k++) {
      if (obDirection === "bearish" && dailyCandles[k].close > c.high) {
        isValid = false;
        break;
      }
      if (obDirection === "bullish" && dailyCandles[k].close < c.low) {
        isValid = false;
        break;
      }
    }

    const priceInZone = currentPrice >= c.low && currentPrice <= c.high;

    return {
      high: c.high,
      low: c.low,
      direction: obDirection,
      index: searchStart,
      datetime: c.datetime,
      isValid,
      priceInZone,
      displacement,
      invalidationPrice,
    };
  }

  return null;
}

/**
 * analyzeDailyImpulse — Full daily impulse analysis pipeline.
 *
 * Finds all displacement legs, identifies their OBs, and returns the most
 * relevant one for the given trade direction.
 *
 * @param dailyCandles - Daily candles (at least 30)
 * @param currentPrice - Current market price
 * @param tradeDirection - The direction we want to trade (from weekly bias or direction engine)
 * @returns DailyImpulseResult with all displacements and the primary OB
 */
export function analyzeDailyImpulse(
  dailyCandles: Candle[],
  currentPrice: number,
  tradeDirection?: "bullish" | "bearish",
): DailyImpulseResult {
  const noResult: DailyImpulseResult = {
    hasDisplacement: false,
    displacements: [],
    primaryOB: null,
    allOBs: [],
    reason: "Insufficient daily candles for displacement analysis",
  };

  if (dailyCandles.length < MIN_DAILY_CANDLES) return noResult;

  // Step 1: Find all displacement legs
  const displacements = detectDailyDisplacements(dailyCandles);

  if (displacements.length === 0) {
    return {
      ...noResult,
      reason: "No daily displacement legs detected (no consecutive large-bodied candles found)",
    };
  }

  // Step 2: Find OBs for each displacement
  const allOBs: DailyOB[] = [];
  for (const disp of displacements) {
    const ob = findDailyOB(dailyCandles, disp, currentPrice);
    if (ob) allOBs.push(ob);
  }

  if (allOBs.length === 0) {
    return {
      hasDisplacement: true,
      displacements,
      primaryOB: null,
      allOBs: [],
      reason: `Found ${displacements.length} displacement leg(s) but could not identify OB candles`,
    };
  }

  // Step 3: Select the primary OB
  // Priority: valid + direction-aligned + price approaching/in zone + most recent
  let primaryOB: DailyOB | null = null;

  // First pass: find valid OBs that match trade direction
  const directionAligned = tradeDirection
    ? allOBs.filter(ob => ob.isValid && ob.direction === tradeDirection)
    : allOBs.filter(ob => ob.isValid);

  if (directionAligned.length > 0) {
    // Prefer one where price is in zone, otherwise most recent
    const inZone = directionAligned.find(ob => ob.priceInZone);
    primaryOB = inZone ?? directionAligned[0]; // Already sorted most recent first
  } else {
    // Fallback: any valid OB
    const validOBs = allOBs.filter(ob => ob.isValid);
    if (validOBs.length > 0) {
      primaryOB = validOBs[0];
    } else {
      // All OBs invalidated
      primaryOB = allOBs[0]; // Return most recent even if invalid, for informational purposes
    }
  }

  const reasons: string[] = [];
  reasons.push(`Found ${displacements.length} daily displacement leg(s)`);
  reasons.push(`Identified ${allOBs.length} Daily OB(s) (${allOBs.filter(ob => ob.isValid).length} valid)`);
  if (primaryOB) {
    reasons.push(`Primary OB: ${primaryOB.direction} @ ${primaryOB.low.toFixed(5)}-${primaryOB.high.toFixed(5)} [${primaryOB.isValid ? "VALID" : "INVALIDATED"}]`);
    if (primaryOB.priceInZone) reasons.push("Price is currently INSIDE the Daily OB");
  }

  return {
    hasDisplacement: true,
    displacements,
    primaryOB,
    allOBs,
    reason: reasons.join(". "),
  };
}

/**
 * checkContainment — Verify that a lower-timeframe zone is contained within the Daily OB.
 *
 * ICT's refinement cascade requires each LTF zone to sit INSIDE the HTF zone.
 * This function checks overlap between a zone (defined by high/low) and the Daily OB.
 *
 * @param zoneHigh - High of the LTF zone to check
 * @param zoneLow - Low of the LTF zone to check
 * @param dailyOB - The Daily OB to check containment against
 * @param minOverlapPercent - Minimum overlap required (default 50% — at least half the zone must be inside)
 * @returns ContainmentResult
 */
export function checkContainment(
  zoneHigh: number,
  zoneLow: number,
  dailyOB: DailyOB,
  minOverlapPercent = 50,
): ContainmentResult {
  const zoneSize = zoneHigh - zoneLow;
  if (zoneSize <= 0) {
    return {
      isContained: false,
      overlapPercent: 0,
      dailyOB,
      reason: "Invalid zone (high <= low)",
    };
  }

  // Calculate overlap
  const overlapHigh = Math.min(zoneHigh, dailyOB.high);
  const overlapLow = Math.max(zoneLow, dailyOB.low);
  const overlap = Math.max(0, overlapHigh - overlapLow);
  const overlapPercent = (overlap / zoneSize) * 100;

  const isContained = overlapPercent >= minOverlapPercent;

  let reason: string;
  if (overlapPercent >= 100) {
    reason = `Zone fully contained within Daily OB (100% overlap)`;
  } else if (isContained) {
    reason = `Zone partially contained within Daily OB (${overlapPercent.toFixed(0)}% overlap ≥ ${minOverlapPercent}% threshold)`;
  } else if (overlapPercent > 0) {
    reason = `Zone has insufficient overlap with Daily OB (${overlapPercent.toFixed(0)}% < ${minOverlapPercent}% threshold)`;
  } else {
    reason = `Zone is completely outside the Daily OB (no overlap)`;
  }

  return {
    isContained,
    overlapPercent,
    dailyOB,
    reason,
  };
}

/**
 * checkCascadingContainment — Full ICT refinement cascade check.
 *
 * Verifies the nesting: Daily OB → 4H zone → 1H zone → Entry zone
 * Each level must be contained within the level above it.
 *
 * @param dailyOB - The Daily OB (top container)
 * @param h4Zone - 4H zone (high/low), or null if not applicable
 * @param h1Zone - 1H zone (high/low), or null if not applicable
 * @param entryZone - Entry zone (high/low), or null if not applicable
 * @param minOverlap - Minimum overlap percent for containment (default 50%)
 * @returns Object with containment results for each level
 */
export function checkCascadingContainment(
  dailyOB: DailyOB,
  h4Zone: { high: number; low: number } | null,
  h1Zone: { high: number; low: number } | null,
  entryZone: { high: number; low: number } | null,
  minOverlap = 50,
): {
  h4InDaily: ContainmentResult | null;
  h1InH4: ContainmentResult | null;
  h1InDaily: ContainmentResult | null;
  entryInH1: ContainmentResult | null;
  entryInDaily: ContainmentResult | null;
  allContained: boolean;
  reason: string;
} {
  let h4InDaily: ContainmentResult | null = null;
  let h1InH4: ContainmentResult | null = null;
  let h1InDaily: ContainmentResult | null = null;
  let entryInH1: ContainmentResult | null = null;
  let entryInDaily: ContainmentResult | null = null;

  // Check 4H inside Daily OB
  if (h4Zone) {
    h4InDaily = checkContainment(h4Zone.high, h4Zone.low, dailyOB, minOverlap);
  }

  // Check 1H inside 4H (if 4H exists) OR inside Daily OB directly
  if (h1Zone) {
    h1InDaily = checkContainment(h1Zone.high, h1Zone.low, dailyOB, minOverlap);
    if (h4Zone) {
      // Create a pseudo-DailyOB from the 4H zone for containment check
      const h4AsContainer: DailyOB = {
        ...dailyOB,
        high: h4Zone.high,
        low: h4Zone.low,
      };
      h1InH4 = checkContainment(h1Zone.high, h1Zone.low, h4AsContainer, minOverlap);
    }
  }

  // Check entry inside 1H (if 1H exists) OR inside Daily OB directly
  if (entryZone) {
    entryInDaily = checkContainment(entryZone.high, entryZone.low, dailyOB, minOverlap);
    if (h1Zone) {
      const h1AsContainer: DailyOB = {
        ...dailyOB,
        high: h1Zone.high,
        low: h1Zone.low,
      };
      entryInH1 = checkContainment(entryZone.high, entryZone.low, h1AsContainer, minOverlap);
    }
  }

  // Determine if the cascade is valid
  // Minimum requirement: the entry zone (or the best available LTF zone) must be inside the Daily OB
  const criticalCheck = entryInDaily ?? h1InDaily ?? h4InDaily;
  const allContained = criticalCheck?.isContained ?? false;

  const reasons: string[] = [];
  if (h4InDaily) reasons.push(`4H in Daily: ${h4InDaily.isContained ? "YES" : "NO"} (${h4InDaily.overlapPercent.toFixed(0)}%)`);
  if (h1InDaily) reasons.push(`1H in Daily: ${h1InDaily.isContained ? "YES" : "NO"} (${h1InDaily.overlapPercent.toFixed(0)}%)`);
  if (h1InH4) reasons.push(`1H in 4H: ${h1InH4.isContained ? "YES" : "NO"} (${h1InH4.overlapPercent.toFixed(0)}%)`);
  if (entryInDaily) reasons.push(`Entry in Daily: ${entryInDaily.isContained ? "YES" : "NO"} (${entryInDaily.overlapPercent.toFixed(0)}%)`);
  if (entryInH1) reasons.push(`Entry in 1H: ${entryInH1.isContained ? "YES" : "NO"} (${entryInH1.overlapPercent.toFixed(0)}%)`);

  return {
    h4InDaily,
    h1InH4,
    h1InDaily,
    entryInH1,
    entryInDaily,
    allContained,
    reason: reasons.join("; ") || "No zones provided for containment check",
  };
}
