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
  Candle, SwingPoint, OrderBlock, FairValueGap, StructureBreak, BreakerBlock, FibLevel, FibLevels,
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
  isValid: boolean;     // Origin not broken (price hasn't retraced past the impulse start)
  bosPrice: number;     // Price level of the structure break
  timeframe?: "D" | "4H" | "1H";  // Which timeframe produced this impulse
  startDate?: string;   // ISO date of the impulse start candle (e.g. "2026-05-20")
  endDate?: string;     // ISO date of the BOS candle
  /** Full candle datetime, not truncated. A 1H leg spanning two dates cannot be
   *  located on a chart from a date alone. */
  startTime?: string;
  endTime?: string;
  spanBars?: number;    // Number of candles in the impulse leg
  displacement?: ImpulseDisplacement;  // How impulsive the leg actually was
  /** Retracement grid for the leg, ready to plot. */
  fibLevels?: ImpulseFibLevel[];
  /** How the two candles that define the leg actually closed. */
  candleQuality?: LegCandleQuality;
  /** What happened before this leg. */
  sequence?: LegSequence;
}

/**
 * What preceded this impulse.
 *
 * findImpulseLeg returns the most recent structurally valid leg and stops, so a
 * first impulse after a reversal and a fourth in an established trend produce
 * the same object, the same zone and the same score. It also filters breaks to
 * the trade's own direction before looking at anything, which removes the very
 * CHoCH that killed the previous leg from the input.
 *
 * The loop already computes most of this — it tries older breaks and rejects
 * them — then discards it to return one leg.
 *
 * OBSERVATIONAL. Nothing gates on it.
 */
export interface LegSequence {
  /** Same-direction legs tried and rejected before this one, because their
   *  origin had already been broken. */
  priorLegsRejected: number;
  /** An opposite-direction structure break sits between the previous
   *  same-direction break and this one — the prior leg was contradicted. */
  opposingBreakBetween: boolean;
  /** Where this leg sits in the sequence. */
  position: "first-after-opposing" | "continuation" | "only";
  /** Displacement strength of the previous valid same-direction leg. */
  priorStrength: "strong" | "moderate" | "weak" | null;
  /** Successive impulses weakening is textbook exhaustion. */
  displacementTrend: "strengthening" | "weakening" | "flat" | null;
}

/**
 * Where the origin and BOS candles closed within their own range.
 *
 * This is the higher timeframe's view of lower timeframe structure. A candle
 * that pushes to a high and closes near its low IS a distribution on the
 * timeframe below — the HTF cannot show you the CHoCH inside it, but it can
 * show you that the body finished nowhere near the extreme.
 *
 * It is a PROXY, not a real LTF read. findImpulseLeg only receives its own
 * timeframe's candles, so an actual lower timeframe analysis would mean
 * threading LTF series through every caller. This gets most of the signal for
 * none of that.
 *
 * Normalised by direction so 1 always means "closed hard in the direction the
 * leg travelled" and 0 means "fully rejected", without the reader having to
 * remember which way a bearish leg runs.
 *
 * OBSERVATIONAL. Nothing gates on it.
 */
export interface LegCandleQuality {
  /** Close strength of the candle the leg started from, 0-1. */
  originCloseStrength: number;
  /** Close strength of the BOS candle, 0-1. A low number is a break that got
   *  rejected within its own bar. */
  bosCloseStrength: number;
  /** Fraction of the BOS candle's range left as wick beyond the close, in the
   *  direction of travel. High means price went there and did not stay. */
  bosRejectionWick: number;
}

/** Close strength of one candle, normalised so 1 = closed with the direction. */
function closeStrength(c: Candle, direction: "bullish" | "bearish"): number {
  const range = c.high - c.low;
  if (!(range > 0)) return 0.5;          // doji/flat: neither strong nor rejected
  const pos = (c.close - c.low) / range;
  return direction === "bullish" ? pos : 1 - pos;
}

export function measureLegCandles(
  candles: Candle[],
  startIndex: number,
  endIndex: number,
  direction: "bullish" | "bearish",
): LegCandleQuality | undefined {
  const origin = candles[startIndex];
  const bos = candles[endIndex];
  if (!origin || !bos) return undefined;

  const bosRange = bos.high - bos.low;
  // Wick left beyond the close in the travel direction: for a bullish break
  // that is high - close, for a bearish break it is close - low.
  const beyond = direction === "bullish" ? bos.high - bos.close : bos.close - bos.low;
  const round = (n: number) => Math.round(n * 1000) / 1000;

  return {
    originCloseStrength: round(closeStrength(origin, direction)),
    bosCloseStrength: round(closeStrength(bos, direction)),
    bosRejectionWick: bosRange > 0 ? round(beyond / bosRange) : 0,
  };
}

export interface ImpulseFibLevel {
  /** 0.236, 0.382, 0.5, 0.618, 0.705, 0.79 */
  level: number;
  label: string;
  price: number;
}

/**
 * Standard retracement grid, measured from where the leg ENDED back toward
 * where it started — which is the direction price has to travel to return to
 * the zone.
 *
 * Bullish leg runs low -> high, so a retracement comes DOWN from the high.
 * Bearish leg runs high -> low, so a retracement goes UP from the low.
 * Computing both the same way would put every bearish level on the wrong side
 * of the leg.
 */
export function impulseFibLevels(
  high: number,
  low: number,
  direction: "bullish" | "bearish",
): ImpulseFibLevel[] {
  const range = high - low;
  if (!(range > 0)) return [];
  const levels = [0.236, 0.382, 0.5, 0.618, 0.705, 0.79];
  return levels.map((level) => ({
    level,
    label: `${(level * 100).toFixed(1)}%`,
    price: direction === "bullish" ? high - range * level : low + range * level,
  }));
}

/**
 * How forcefully the leg moved, as opposed to how far.
 *
 * An impulse here is defined structurally — swing origin to BOS — and nothing
 * checked whether price got there violently or ground there over weeks. Both
 * produce the same zone at the same Fib levels with the same gate score, which
 * is odd in a system that already penalises a non-displacement order block
 * 2.0 -> 0.75 and demotes a non-displacement FVG out of Tier 1.
 *
 * OBSERVATIONAL ONLY. Nothing gates on these numbers. They exist so the
 * question "do low-displacement legs underperform?" can be answered from
 * recorded data rather than assumed from theory.
 */
export interface ImpulseDisplacement {
  /** Mean body/range across the leg's candles. 1.0 = all body, no wick. */
  avgBodyRatio: number;
  /** Largest single candle range in the leg, as a multiple of the pre-leg average. */
  maxRangeMultiple: number;
  /** Candles in the leg clearing the same bar detectDisplacement() uses. */
  displacementCandles: number;
  /** displacementCandles / spanBars. */
  displacementRatio: number;
  /** Leg range in price units per bar — separates a fast leg from a slow one of equal size. */
  rangePerBar: number;
  /** Descriptive label. Provisional thresholds; not used for any decision. */
  strength: "strong" | "moderate" | "weak";
}

export interface ImpulsePOI {
  type: "fvg" | "ob";
  high: number;
  low: number;
  candleIndex: number;
  direction: "bullish" | "bearish";
  isOriginOB?: boolean;   // True if this OB was synthesized as the impulse-origin re-test candidate
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
  htfConfluenceScore: number; // Score from HTF confluence layers (4H OB/FVG/Breaker, HTF Fib, P/D)
  htfLayers: string[];        // Labels of HTF layers that overlap this zone
  totalScore: number;     // fibScore + srConfirmed(+1) + ltfRefined(+1) + htfConfluenceScore
}

export interface BestZone {
  zone: RankedPOI;
  impulse: ImpulseLeg;
  priceAtZone: boolean;       // Loose: within 1.5×ATR of zone (for watchlist/awareness)
  priceInsideZone: boolean;   // Strict: price is literally inside zone bounds [low, high]
  priceAtZoneStrict: boolean; // Strict: within 0.3×ATR AND on structurally correct side
  sideOk: boolean;            // Is price on the correct side for the direction?
  distanceToZone: number;     // Distance in price units (0 if inside zone)
  distancePips: number;       // Distance in pips (approximate, using 5th decimal)
}

export interface HTFConfluenceData {
  h4OBs: OrderBlock[];
  h4FVGs: FairValueGap[];
  h4Breakers: BreakerBlock[];
  htfFibLevels: FibLevels | null;
  dailyFibLevels?: FibLevels | null;
  htfPD: { currentZone: string; zonePercent: number; oteZone: boolean } | null;
  direction: "bullish" | "bearish";
}
export interface ZoneEngineResult {
  bestZone: BestZone | null;
  impulse: ImpulseLeg | null;
  allZones: RankedPOI[];
  reason: string;         // Human-readable explanation of outcome
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Fib levels to check (from deepest to shallowest) */
const FIB_LEVELS_BASE = [0.786, 0.71, 0.618, 0.5, 0.382] as const;

/** Score assigned to each Fib depth tier (flattened so other confluences carry more weight) */
const FIB_SCORES: Record<number, number> = {
  1.0: 2,
  0.886: 2,
  0.786: 2,
  0.71: 2,
  0.618: 1.5,
  0.5: 1,
  0.382: 0, // Too shallow — no score but still tracked
};

/** Tolerance for Fib level overlap (as fraction of impulse range) */
const FIB_TOLERANCE_FRACTION = 0.03; // 3% of impulse range

/** Minimum touches to qualify as historical S/R */
const SR_MIN_TOUCHES = 2;

/** Lookback for S/R detection (candles before the impulse) */
const SR_LOOKBACK = 100;

/** Proximity threshold for "price at zone" — LOOSE (watchlist/awareness) */
const PRICE_AT_ZONE_ATR_MULT = 1.5;

/** Proximity threshold for "price at zone" — STRICT (market fill decisions) */
const PRICE_AT_ZONE_STRICT_ATR_MULT = 0.3;

// ─── 1. findImpulseLeg ────────────────────────────────────────────────────────

/**
 * Find the most recent impulse leg that broke structure.
 * An impulse leg is the entire move from a swing origin to a BOS/CHoCH.
 * The impulse is valid as long as the origin has not been broken:
 *   - Bullish: valid while price hasn't closed below the swing low origin
 *   - Bearish: valid while price hasn't closed above the swing high origin
 * Internal pullbacks (wave 2/4 in impulsive wave structure) are expected
 * and do NOT invalidate the impulse.
 *
 *
 * @param candles - 1H, 4H, or Daily candles (must have structure analysis available)
 * @param direction - The bias direction we're looking for
 * @param timeframe - Optional: which timeframe these candles represent (for metadata)
 * @returns ImpulseLeg or null if no valid impulse found
 */
export function findImpulseLeg(
  candles: Candle[],
  direction: "bullish" | "bearish",
  timeframe?: "D" | "4H" | "1H",
): ImpulseLeg | null {
  if (candles.length < 20) return null;

  const structure = analyzeMarketStructure(candles);
  const everyBreak = [...structure.bos, ...structure.choch];
  // Opposite-direction breaks are excluded from SELECTION, as before — but kept
  // here, because a break against the trade is exactly what says the previous
  // leg was contradicted, and filtering it out first made that unknowable.
  const opposingBreaks = everyBreak.filter(b => b.type !== direction);
  const allBreaks = everyBreak
    .filter(b => b.type === direction)
    .sort((a, b) => b.index - a.index); // Most recent first

  if (allBreaks.length === 0) return null;

  // Try each BOS from most recent to oldest
  let rejectedBefore = 0;
  for (const [attempt, bos] of allBreaks.entries()) {
    const impulse = validateImpulseFromBOS(candles, bos, direction, structure.swingPoints);
    if (!impulse || !impulse.isValid) { rejectedBefore++; continue; }
    if (impulse && impulse.isValid) {
      // ── Sequence: what preceded this leg ──────────────────────────────
      // The next older same-direction break, validated the same way. Cheap:
      // one extra call, and the loop was going to reach it anyway if this one
      // had failed.
      const priorBos = allBreaks[attempt + 1];
      const priorLeg = priorBos
        ? validateImpulseFromBOS(candles, priorBos, direction, structure.swingPoints)
        : null;
      const priorDisp = priorLeg
        ? measureLegDisplacement(candles, priorLeg.startIndex, priorLeg.endIndex)
        : undefined;
      const thisDisp = measureLegDisplacement(candles, impulse.startIndex, impulse.endIndex);

      const opposingBetween = priorBos
        ? opposingBreaks.some(b => b.index > priorBos.index && b.index < bos.index)
        : false;

      const rank = (x?: string | null) =>
        x === "strong" ? 3 : x === "moderate" ? 2 : x === "weak" ? 1 : 0;
      const a = rank(priorDisp?.strength), b = rank(thisDisp?.strength);
      impulse.sequence = {
        priorLegsRejected: rejectedBefore,
        opposingBreakBetween: opposingBetween,
        position: !priorBos ? "only" : opposingBetween ? "first-after-opposing" : "continuation",
        priorStrength: priorDisp?.strength ?? null,
        displacementTrend: (a === 0 || b === 0)
          ? null
          : b > a ? "strengthening" : b < a ? "weakening" : "flat",
      };

      // Enrich with timeframe metadata if provided
      if (timeframe) {
        impulse.timeframe = timeframe;
      }
      // Extract dates from candle datetimes
      const startCandle = candles[impulse.startIndex];
      const endCandle = candles[impulse.endIndex];
      if (startCandle?.datetime) {
        impulse.startDate = startCandle.datetime.slice(0, 10);
        impulse.startTime = startCandle.datetime;   // keep the time; a 1H leg needs it
      }
      if (endCandle?.datetime) {
        impulse.endDate = endCandle.datetime.slice(0, 10);
        impulse.endTime = endCandle.datetime;
      }
      impulse.spanBars = impulse.endIndex - impulse.startIndex;
      impulse.fibLevels = impulseFibLevels(impulse.high, impulse.low, impulse.direction);
      impulse.candleQuality = measureLegCandles(
        candles, impulse.startIndex, impulse.endIndex, impulse.direction,
      );
      return impulse;
    }
  }

  return null;
}

/**
 * Every valid impulse leg in the window, not just the newest one.
 *
 * findImpulseLeg() returns the most recent valid leg per direction AND STOPS.
 * That is right for "what is the current setup", and wrong for anything that
 * needs the history: with one bullish and one bearish leg per timeframe, the
 * V2 order-block engine could produce at most
 *
 *   symbols x directions x timeframes  =  8 x 2 x 2  =  32
 *
 * blocks in total, and it measured 28 — the ceiling, not a finding. A reference
 * 4H chart carrying six stacked zones from six different historical impulses
 * was structurally unreproducible, no matter how deep the candle window went.
 *
 * This walks every BOS and CHoCH instead. Same validation, same leg shape, same
 * enrichment — the only difference is that older legs are kept rather than
 * discarded once a newer one is found.
 *
 * Deliberately NOT one leg per break. Several breaks commonly belong to the
 * same impulse (a leg that breaks structure three times on its way up), and
 * they all trace back to the same swing origin. Those collapse to one leg,
 * keeping the furthest-developed break, because they describe one base.
 */
export function enumerateImpulseLegs(
  candles: Candle[],
  timeframe?: "D" | "4H" | "1H",
  opts?: { maxPerDirection?: number },
): ImpulseLeg[] {
  if (candles.length < 20) return [];
  const maxPerDirection = opts?.maxPerDirection ?? 20;

  const structure = analyzeMarketStructure(candles);
  const everyBreak = [...structure.bos, ...structure.choch];
  const out: ImpulseLeg[] = [];

  for (const direction of ["bullish", "bearish"] as const) {
    const breaks = everyBreak
      .filter(b => b.type === direction)
      .sort((a, b) => b.index - a.index);   // newest first, so caps drop the oldest

    // Same origin = same base = the same order block. Keep the break that
    // developed furthest, which is the one that best describes the move.
    const byOrigin = new Map<number, ImpulseLeg>();
    for (const bos of breaks) {
      // Isolated PER BREAK, not per timeframe. The caller wraps this whole
      // function in one try/catch, so without this a single malformed
      // historical break would throw past every remaining leg and erase all
      // blocks for the symbol on that timeframe — turning one bad bar into a
      // chart with nothing on it.
      try {
        const leg = validateImpulseFromBOS(candles, bos, direction, structure.swingPoints);
        if (!leg || !leg.isValid) continue;
        const existing = byOrigin.get(leg.startIndex);
        if (!existing || leg.endIndex > existing.endIndex) byOrigin.set(leg.startIndex, leg);
      } catch (err) {
        console.warn(`[enumerateImpulseLegs] ${timeframe ?? "?"} ${direction}: ` +
          `break @${bos.index} failed validation, skipped — ${(err as Error)?.message}`);
        continue;
      }
    }

    const legs = [...byOrigin.values()].sort((a, b) => b.endIndex - a.endIndex);
    if (legs.length > maxPerDirection) {
      // Never cap silently: a truncated list reads as "this is all there was".
      console.log(`[enumerateImpulseLegs] ${timeframe ?? "?"} ${direction}: ` +
        `capped ${legs.length} legs to ${maxPerDirection}`);
    }
    out.push(...legs.slice(0, maxPerDirection));
  }

  // Same enrichment findImpulseLeg applies, minus `sequence` — that describes
  // what preceded the CURRENT setup and costs an extra validation per leg.
  for (const leg of out) {
    if (timeframe) leg.timeframe = timeframe;
    const startCandle = candles[leg.startIndex];
    const endCandle = candles[leg.endIndex];
    if (startCandle?.datetime) {
      leg.startDate = startCandle.datetime.slice(0, 10);
      leg.startTime = startCandle.datetime;
    }
    if (endCandle?.datetime) {
      leg.endDate = endCandle.datetime.slice(0, 10);
      leg.endTime = endCandle.datetime;
    }
    leg.spanBars = leg.endIndex - leg.startIndex;
    leg.fibLevels = impulseFibLevels(leg.high, leg.low, leg.direction);
    leg.candleQuality = measureLegCandles(candles, leg.startIndex, leg.endIndex, leg.direction);
  }

  // Chronological, oldest first — the order the zones were created in.
  return out.sort((a, b) => a.endIndex - b.endIndex);
}

/**
 * Given a BOS, trace back to find the swing origin and validate that the
 * origin has not been broken by subsequent price action (after the BOS).
 */
/**
 * Measure how impulsive a leg was, relative to what preceded it.
 *
 * The baseline is the 20 candles BEFORE the leg, never the leg itself. Using a
 * trailing window that includes the leg would let a long move dilute its own
 * baseline and report as unremarkable — the bigger the displacement, the more
 * it raises the average it is being compared against.
 *
 * Candle-level thresholds mirror detectDisplacement() in smcAnalysis.ts so the
 * two detectors agree on what "a displacement candle" means.
 */
export function measureLegDisplacement(
  candles: Candle[],
  startIndex: number,
  endIndex: number,
): ImpulseDisplacement | undefined {
  const legStart = Math.max(0, startIndex);
  const legEnd = Math.min(candles.length - 1, endIndex);
  const span = legEnd - legStart + 1;
  if (span < 1) return undefined;

  const baseFrom = Math.max(0, legStart - 20);
  const baseline = candles.slice(baseFrom, legStart);
  if (baseline.length < 5) return undefined;   // too little history to compare against

  let bSum = 0, rSum = 0;
  for (const c of baseline) {
    bSum += Math.abs(c.close - c.open);
    rSum += (c.high - c.low);
  }
  const avgBody = bSum / baseline.length;
  const avgRange = rSum / baseline.length;
  if (avgBody <= 0 || avgRange <= 0) return undefined;

  let ratioSum = 0, maxRangeMultiple = 0, dispCandles = 0, counted = 0;
  for (let i = legStart; i <= legEnd; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    if (range <= 0) continue;
    const body = Math.abs(c.close - c.open);
    const bodyRatio = body / range;
    const rangeMultiple = range / avgRange;
    ratioSum += bodyRatio;
    counted++;
    if (rangeMultiple > maxRangeMultiple) maxRangeMultiple = rangeMultiple;
    if (body / avgBody >= 2.0 && bodyRatio >= 0.7 && rangeMultiple >= 1.5) dispCandles++;
  }
  if (counted === 0) return undefined;

  const displacementRatio = dispCandles / counted;
  const legRange = Math.abs(candles[legEnd].close - candles[legStart].open);

  // Provisional, and deliberately generous at the low end: the point is to
  // separate legs for later analysis, not to declare a winner.
  const strength: "strong" | "moderate" | "weak" =
    (displacementRatio >= 0.25 || maxRangeMultiple >= 3.0) ? "strong"
      : (displacementRatio >= 0.10 || maxRangeMultiple >= 2.0) ? "moderate"
        : "weak";

  const round = (n: number, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;
  return {
    avgBodyRatio: round(ratioSum / counted),
    maxRangeMultiple: round(maxRangeMultiple, 2),
    displacementCandles: dispCandles,
    displacementRatio: round(displacementRatio),
    rangePerBar: round(legRange / span, 6),
    strength,
  };
}

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

    // Validate: origin not broken — check candles AFTER the BOS to see if
    // price has retraced past the impulse origin (invalidating the leg).
    // Internal pullbacks within the impulse are expected (wave structure).
    const originPrice = direction === "bullish" ? impulseLow : impulseHigh;
    let originBroken = false;
    for (let j = endIdx + 1; j < candles.length; j++) {
      if (direction === "bullish" && candles[j].close < originPrice) {
        originBroken = true;
        break;
      }
      if (direction === "bearish" && candles[j].close > originPrice) {
        originBroken = true;
        break;
      }
    }

    if (!originBroken) {
      return {
        high: impulseHigh,
        low: impulseLow,
        direction,
        startIndex: startIdx,
        endIndex: endIdx,
        isValid: true,
        bosPrice: bos.price,
        displacement: measureLegDisplacement(candles, startIdx, endIdx),
      };
    }
  }

  return null;
}

// NOTE: checkNoPullbackExceeds50 was removed.
// The 50% internal pullback rule incorrectly rejected valid impulsive waves
// that have normal wave 2/4 corrections. Replaced with origin-not-broken
// validation: an impulse is valid as long as price hasn't closed past the
// swing origin that started the move.
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
  options?: { originOBRetest?: boolean },
): ImpulsePOI[] {
  if (!impulse.isValid) return [];

  const start = Math.max(0, impulse.startIndex);
  const end = Math.min(candles.length, impulse.endIndex + 1);
  const impulseCandles = candles.slice(start, end);

  if (impulseCandles.length < 3) return [];

  // ── FVGs: detect on impulse slice (purely geometric, no lifecycle issue) ──
  const impulseStructure = analyzeMarketStructure(impulseCandles);
  const impulseBreaks = [...impulseStructure.bos, ...impulseStructure.choch];
  const fvgs = detectFVGs(impulseCandles, impulseBreaks);

  // ── OBs: detect on FULL candle set to avoid lifecycle false-negatives ──
  // The OB (last opposing candle) often sits just before the impulse starts.
  // Running detection on only the impulse slice causes OBs to be marked as
  // "broken" or "mitigated" by the impulse candles themselves.
  // We include a lookback window before the impulse so the engulfing pattern
  // and the institutional candle are both captured.
  const obLookback = 10; // bars before impulse to include for OB context
  const obStart = Math.max(0, start - obLookback);
  const obCandles = candles.slice(obStart, end);
  const obStructure = analyzeMarketStructure(obCandles);
  const obBreaks = [...obStructure.bos, ...obStructure.choch];
  const obs = detectOrderBlocks(obCandles, obBreaks);

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

  // Map OBs — filter to those within or just before the impulse range,
  // aligned with direction, and not broken/mitigated.
  // The OB index is relative to obCandles, so we convert back to full-candle index.
  for (const ob of obs) {
    const fullIndex = obStart + ob.index;
    // OB must be within the impulse range or in the lookback zone just before it
    if (fullIndex < obStart || fullIndex > impulse.endIndex) continue;
    // OB price must be within the impulse price range
    const impHigh = Math.max(impulse.high, impulse.low);
    const impLow = Math.min(impulse.high, impulse.low);
    if (ob.high < impLow || ob.low > impHigh) continue;

    if (ob.type === impulse.direction && ob.state !== "broken" && ob.state !== "mitigated") {
      pois.push({
        type: "ob",
        high: ob.high,
        low: ob.low,
        candleIndex: fullIndex,
        direction: ob.type,
      });
    }
  }

  // ── Origin OB re-test (optional) ──
  // Synthesize an "origin OB" POI: the last opposing candle at or near the
  // impulse origin swing. For bullish impulse, we want the last bearish
  // candle around startIndex (the swing low). For bearish, the last bullish
  // candle around startIndex (the swing high). This captures the demand/
  // supply block that CAUSED the impulse (not the ones inside it).
  if (options?.originOBRetest && candles.length > 0) {
    const window = 5; // bars around the origin to search
    const originIdx = impulse.startIndex;
    const searchLo = Math.max(0, originIdx - window);
    const searchHi = Math.min(candles.length - 1, originIdx + window);
    let originCandleIdx = -1;
    for (let i = originIdx; i >= searchLo; i--) {
      const c = candles[i];
      const isBearish = c.close < c.open;
      const isBullish = c.close > c.open;
      if (impulse.direction === "bullish" && isBearish) { originCandleIdx = i; break; }
      if (impulse.direction === "bearish" && isBullish) { originCandleIdx = i; break; }
    }
    // Fallback: scan forward if none behind
    if (originCandleIdx === -1) {
      for (let i = originIdx + 1; i <= searchHi; i++) {
        const c = candles[i];
        const isBearish = c.close < c.open;
        const isBullish = c.close > c.open;
        if (impulse.direction === "bullish" && isBearish) { originCandleIdx = i; break; }
        if (impulse.direction === "bearish" && isBullish) { originCandleIdx = i; break; }
      }
    }
    if (originCandleIdx >= 0) {
      const oc = candles[originCandleIdx];
      // Avoid duplicates: skip if we already have a POI overlapping this exact candle
      const duplicate = pois.some(p =>
        p.candleIndex === originCandleIdx && p.type === "ob"
      );
      if (!duplicate) {
        pois.push({
          type: "ob",
          high: oc.high,
          low: oc.low,
          candleIndex: originCandleIdx,
          direction: impulse.direction,
          isOriginOB: true,
        });
      }
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
  options?: { fibMaxRetracement?: number; originOBRetest?: boolean },
): RankedPOI[] {
  if (pois.length === 0) return [];

  const range = impulse.high - impulse.low;
  if (range <= 0) return [];

  // Dynamic fib window. Default matches legacy behavior (max 0.786 / OTE 0.85).
  const fibMax = Math.max(0.5, Math.min(1.0, options?.fibMaxRetracement ?? 0.786));
  // Extend the checked Fib ladder based on the max and origin-OB toggle
  const extraLevels: number[] = [];
  if (fibMax >= 0.886) extraLevels.push(0.886);
  if (fibMax >= 1.0 || options?.originOBRetest) extraLevels.push(1.0);
  const FIB_LEVELS = [...extraLevels, ...FIB_LEVELS_BASE] as const;
  // OTE upper bound scales with the max: allow a small tolerance above fibMax
  const oteUpper = Math.min(1.05, fibMax + 0.05);

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
    const inOTE = fibDepth >= 0.5 && fibDepth <= oteUpper;
    const nearFib = nearestDist <= tolerance;

    if (!nearFib && !inOTE) continue; // POI not at a meaningful Fib level

    // Assign score based on depth
    const fibScore = FIB_SCORES[nearestFib] ?? (
      fibDepth >= 0.886 ? 2 :
      fibDepth >= 0.71 ? 2 :
      fibDepth >= 0.618 ? 1.5 :
      fibDepth >= 0.5 ? 1 : 0
    );

    ranked.push({
      poi,
      fibLevel: nearestFib,
      fibDepth,
      fibScore,
      srConfirmed: false,
      ltfRefined: false,
      htfConfluenceScore: 0,
      htfLayers: [],
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
        zone.totalScore = zone.fibScore + zone.htfConfluenceScore + 1; // +1 for S/R confirmation
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

// ─── 5. checkHTFConfluence ───────────────────────────────────────────────────

/**
 * Score each zone by how many higher-timeframe confluence layers overlap it.
 *
 * Layers checked:
 *   - 4H Order Block overlaps zone:        +1
 *   - 4H FVG overlaps zone:                +1
 *   - 4H Breaker (active) overlaps zone:   +1
 *   - HTF Fib 61.8%/71%/78.6% inside zone: +1.5
 *   - HTF Fib 50% inside zone:             +0.5
 *   - P/D alignment (discount for longs,
 *     premium for shorts):                 +0.5
 *
 * Maximum HTF confluence score: 5.5
 *
 * @param zones - Ranked POIs (after S/R check)
 * @param htfData - Higher-timeframe analysis data from bot-scanner
 * @returns Same zones with htfConfluenceScore and htfLayers populated
 */
export function checkHTFConfluence(
  zones: RankedPOI[],
  htfData: HTFConfluenceData,
): RankedPOI[] {
  if (zones.length === 0) return zones;

  for (const zone of zones) {
    let score = 0;
    const layers: string[] = [];
    const zoneHigh = zone.poi.high;
    const zoneLow = zone.poi.low;

    // ── 4H Order Blocks ──
    for (const ob of htfData.h4OBs) {
      // Only consider OBs aligned with trade direction and not broken/mitigated
      if (ob.state === "broken" || ob.state === "mitigated") continue;
      if (
        (htfData.direction === "bullish" && ob.type !== "bullish") ||
        (htfData.direction === "bearish" && ob.type !== "bearish")
      ) continue;
      // Overlap check: max(zone.low, ob.low) <= min(zone.high, ob.high)
      if (Math.max(zoneLow, ob.low) <= Math.min(zoneHigh, ob.high)) {
        score += 1;
        layers.push("4H_OB");
        break; // Count at most once per layer type
      }
    }

    // ── 4H Fair Value Gaps ──
    for (const fvg of htfData.h4FVGs) {
      if (fvg.state === "filled") continue;
      if (
        (htfData.direction === "bullish" && fvg.type !== "bullish") ||
        (htfData.direction === "bearish" && fvg.type !== "bearish")
      ) continue;
      if (Math.max(zoneLow, fvg.low) <= Math.min(zoneHigh, fvg.high)) {
        score += 1;
        layers.push("4H_FVG");
        break;
      }
    }

    // ── 4H Breaker Blocks ──
    for (const bb of htfData.h4Breakers) {
      if (!bb.isActive || bb.state === "broken") continue;
      // Breaker alignment: bullish_breaker for bullish direction, bearish_breaker for bearish
      if (
        (htfData.direction === "bullish" && bb.type !== "bullish_breaker") ||
        (htfData.direction === "bearish" && bb.type !== "bearish_breaker")
      ) continue;
      if (Math.max(zoneLow, bb.low) <= Math.min(zoneHigh, bb.high)) {
        score += 1;
        layers.push("4H_BREAKER");
        break;
      }
    }

    // ── HTF Fib Levels ──
    // Check both 4H and daily Fib levels if available
    const fibSources: { levels: FibLevels; prefix: string }[] = [];
    if (htfData.htfFibLevels) fibSources.push({ levels: htfData.htfFibLevels, prefix: "HTF" });
    if (htfData.dailyFibLevels) fibSources.push({ levels: htfData.dailyFibLevels, prefix: "D1" });

    let bestFibScore = 0;
    let bestFibLabel = "";
    for (const { levels, prefix } of fibSources) {
      for (const fib of levels.retracements) {
        if (fib.price >= zoneLow && fib.price <= zoneHigh) {
          // Premium Fib levels (61.8%, 71%, 78.6%) get +1.5
          if (fib.ratio === 0.618 || fib.ratio === 0.71 || fib.ratio === 0.786) {
            if (1.5 > bestFibScore) {
              bestFibScore = 1.5;
              bestFibLabel = `${prefix}_FIB_${(fib.ratio * 100).toFixed(1)}`;
            }
          }
          // 50% Fib gets +0.5
          else if (fib.ratio === 0.5) {
            if (0.5 > bestFibScore) {
              bestFibScore = 0.5;
              bestFibLabel = `${prefix}_FIB_50.0`;
            }
          }
        }
      }
    }
    if (bestFibScore > 0) {
      score += bestFibScore;
      layers.push(bestFibLabel);
    }

    // ── Premium/Discount Alignment ──
    if (htfData.htfPD) {
      const pd = htfData.htfPD;
      if (
        (htfData.direction === "bullish" && pd.currentZone === "discount") ||
        (htfData.direction === "bearish" && pd.currentZone === "premium")
      ) {
        score += 0.5;
        layers.push("PD_ALIGNED");
      }
    }

    // Update the zone
    zone.htfConfluenceScore = score;
    zone.htfLayers = layers;
    // Recalculate totalScore to include HTF confluence
    zone.totalScore = zone.fibScore + zone.htfConfluenceScore + (zone.srConfirmed ? 1 : 0);
  }

  return zones;
}

// ─── 6. refineLowerTF ─────────────────────────────────────────────────────────

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

  // Run structure analysis on the inside candles (for FVGs)
  const ltfStructure = analyzeMarketStructure(insideCandles);
  const ltfBreaks = [...ltfStructure.bos, ...ltfStructure.choch];

  // FVGs: detect on inside candles (purely geometric, no lifecycle issue)
  const ltfFVGs = detectFVGs(insideCandles, ltfBreaks);

  // OBs: detect on FULL entryCandles to avoid lifecycle false-negatives.
  // The OB (last opposing candle) may sit just outside the zone boundary,
  // and running detection on only inside-zone candles causes OBs to be
  // falsely marked as "broken" by the zone candles themselves.
  const fullStructure = analyzeMarketStructure(entryCandles);
  const fullBreaks = [...fullStructure.bos, ...fullStructure.choch];
  const ltfOBs = detectOrderBlocks(entryCandles, fullBreaks);

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
  zone.totalScore = zone.fibScore + zone.htfConfluenceScore + (zone.srConfirmed ? 1 : 0) + 1; // +1 for LTF refinement

  return zone;
}

// ─── 6. rankAndSelectBestZone ─────────────────────────────────────────────────

/**
 * Rank all zones and select the best one.
 *
 * Scoring:
 *   - Fib depth: 78.6% = 2, 71% = 2, 61.8% = 1.5, 50% = 1
 *   - HTF confluence: up to +5 (4H OB +1, FVG +1, Breaker +1, HTF Fib +1.5, P/D +0.5)
 *   - S/R confirmed: +1
 *   - LTF refined: +1
 *   - Maximum possible score: 9
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
    zone.totalScore = zone.fibScore + zone.htfConfluenceScore + (zone.srConfirmed ? 1 : 0) + (zone.ltfRefined ? 1 : 0);
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
 * Full pipeline: find impulse → map POIs → Fib overlay → S/R check → HTF confluence → LTF refine → rank.
 *
 * This is the function called by bot-scanner as a prerequisite gate.
 *
 * @param htfCandles - 1H candles (primary impulse detection timeframe)
 * @param entryCandles - 15m candles (for LTF refinement)
 * @param direction - The bias direction from confluence analysis
 * @param currentPrice - Current price for "at zone" check
 * @param htfData - Optional HTF confluence data (4H OBs, FVGs, Breakers, Fib, P/D)
 * @returns ZoneEngineResult with best zone or null + reason
 */
export function findBestEntryZone(
  htfCandles: Candle[],
  entryCandles: Candle[],
  direction: "bullish" | "bearish",
  currentPrice: number,
  htfData?: HTFConfluenceData,
  options?: ZoneEngineOptions,
): ZoneEngineResult {
  // Step 1: Find impulse leg
  const impulse = findImpulseLeg(htfCandles, direction);
  if (!impulse) {
    return {
      bestZone: null,
      impulse: null,
      allZones: [],
      reason: `No valid ${direction} impulse leg found (no BOS or origin broken)`,
    };
  }

  // Step 2: Map POIs within the impulse
  const pois = mapImpulsePOIs(htfCandles, impulse, { originOBRetest: options?.originOBRetest });
  if (pois.length === 0) {
    return {
      bestZone: null,
      impulse,
      allZones: [],
      reason: `Impulse found but no POIs (FVGs/OBs) detected within it`,
    };
  }

  // Step 3: Overlay Fib and score by depth
  let rankedZones = overlayFibOnPOIs(impulse, pois, {
    fibMaxRetracement: options?.fibMaxRetracement,
    originOBRetest: options?.originOBRetest,
  });
  if (rankedZones.length === 0) {
    return {
      bestZone: null,
      impulse,
      allZones: [],
      reason: `POIs found but none align with key Fib levels (50%-${((options?.fibMaxRetracement ?? 0.786) * 100).toFixed(1)}%${options?.originOBRetest ? " incl. origin OB" : ""})`,
    };
  }

  // Step 3b: Filter by Daily zone bounds (if provided)
  if (options?.dailyZoneBounds) {
    const bounds = options.dailyZoneBounds;
    rankedZones = rankedZones.filter(z => {
      const zHigh = z.poi.high;
      const zLow = z.poi.low;
      // Overlap check: max(zone.low, daily.low) <= min(zone.high, daily.high)
      return Math.max(zLow, bounds.low) <= Math.min(zHigh, bounds.high);
    });
    if (rankedZones.length === 0) {
      return {
        bestZone: null,
        impulse,
        allZones: [],
        reason: `POIs found at Fib levels but none overlap with Daily zone [${bounds.low.toFixed(5)}-${bounds.high.toFixed(5)}]`,
      };
    }
  }

  // Step 4: Check historical S/R
  rankedZones = checkHistoricalSR(htfCandles, rankedZones, impulse.startIndex);

  // Step 5: HTF confluence scoring (if data available)
  if (htfData) {
    rankedZones = checkHTFConfluence(rankedZones, htfData);
  }

  // Step 6: LTF refinement on top zones (only refine top 3 to save compute)
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
  const looseThreshold = atr * PRICE_AT_ZONE_ATR_MULT;       // 1.5×ATR (watchlist)
  const effectiveStrictMult = options?.strictATRMult ?? PRICE_AT_ZONE_STRICT_ATR_MULT;
  const strictThreshold = atr * effectiveStrictMult; // configurable (default 0.3×ATR)
  const zoneHigh = bestZonePOI.poi.high;
  const zoneLow = bestZonePOI.poi.low;

  // ── Distance calculation ──
  let distanceToZone = 0;
  const priceInsideZone = currentPrice >= zoneLow && currentPrice <= zoneHigh;

  if (!priceInsideZone) {
    if (currentPrice > zoneHigh) {
      distanceToZone = currentPrice - zoneHigh;
    } else {
      distanceToZone = zoneLow - currentPrice;
    }
  }

  // Convert distance to pips using the instrument's pip size
  const pipSize = options?.pipSize ?? 0.0001;
  const distancePips = distanceToZone / pipSize;

  // ── Loose proximity (existing behavior — for watchlist/awareness) ──
  let priceAtZone = false;
  if (priceInsideZone) {
    priceAtZone = true;
  } else {
    priceAtZone = Math.abs(currentPrice - zoneHigh) <= looseThreshold
      || Math.abs(currentPrice - zoneLow) <= looseThreshold;
  }

  // ── Directional side check ──
  // For LONG (demand zone): price should be AT or BELOW the zone (approaching from above during retrace)
  //   - Price above zone is acceptable only if very close (within strict threshold)
  // For SHORT (supply zone): price should be AT or ABOVE the zone (approaching from below during retrace)
  //   - Price below zone is acceptable only if very close (within strict threshold)
  let sideOk = true;
  if (direction === "bullish") {
    // For longs: price above zone top is wrong side (already moved away from demand)
    // Allow only if within strict threshold above the zone
    if (currentPrice > zoneHigh) {
      sideOk = (currentPrice - zoneHigh) <= strictThreshold;
    }
    // Price at or below zone is always correct side for longs
  } else {
    // For shorts: price below zone bottom is wrong side (already moved away from supply)
    // Allow only if within strict threshold below the zone
    if (currentPrice < zoneLow) {
      sideOk = (zoneLow - currentPrice) <= strictThreshold;
    }
    // Price at or above zone is always correct side for shorts
  }

  // ── Strict proximity (for market fill decisions) ──
  // Must be within 0.3×ATR of the zone AND on the correct side
  let priceAtZoneStrict = false;
  if (priceInsideZone) {
    priceAtZoneStrict = true;
  } else {
    const nearZoneStrict = Math.abs(currentPrice - zoneHigh) <= strictThreshold
      || Math.abs(currentPrice - zoneLow) <= strictThreshold;
    priceAtZoneStrict = nearZoneStrict && sideOk;
  }

  // ── Build reason string ──
  let proximityLabel: string;
  if (priceInsideZone) {
    proximityLabel = "price INSIDE zone";
  } else if (priceAtZoneStrict) {
    proximityLabel = `price NEAR zone (${distancePips.toFixed(1)} pips, strict)`;
  } else if (priceAtZone) {
    proximityLabel = `price NEAR zone (${distancePips.toFixed(1)} pips, loose only${!sideOk ? ", wrong side" : ""})`;
  } else {
    proximityLabel = `price ${distancePips.toFixed(1)} pips away`;
  }

  return {
    bestZone: {
      zone: bestZonePOI,
      impulse,
      priceAtZone,
      priceInsideZone,
      priceAtZoneStrict,
      sideOk,
      distanceToZone,
      distancePips,
    },
    impulse,
    allZones: rankedZones,
    reason: `Valid ${direction} zone found: ${bestZonePOI.poi.type.toUpperCase()} at Fib ${(bestZonePOI.fibLevel * 100).toFixed(1)}% (score ${bestZonePOI.totalScore}/9${bestZonePOI.htfLayers.length > 0 ? `, HTF: ${bestZonePOI.htfLayers.join("+")}` : ""}) — ${proximityLabel}`,
  };
}


// ─── Options ─────────────────────────────────────────────────────────────────
/** Options to override engine constants at runtime (config-driven). */
export interface ZoneEngineOptions {
  /** ATR multiplier for strict proximity check (market fill). Default: 0.3 */
  strictATRMult?: number;
  /**
   * Daily zone bounds filter. When provided, only zones that overlap with these
   * bounds are kept. This integrates the cascade (Daily→4H→1H) approach:
   * the Daily zone defines WHERE to look, the impulse zone engine does the detailed work.
   */
  dailyZoneBounds?: { high: number; low: number };
  /** Pip size for the instrument (e.g. 0.0001 for EUR/USD, 1 for BTC/USD, 0.01 for XAU/USD). Default: 0.0001 */
  pipSize?: number;
  /**
   * Maximum Fib retracement to accept a POI (0.5–1.0). Default 0.786.
   * Set higher (e.g. 0.886 or 1.0) to allow deeper zones near the impulse origin.
   */
  fibMaxRetracement?: number;
  /**
   * When true, synthesize an "origin OB" POI at the impulse origin swing and allow
   * zones at fib 1.0 (re-tests of the block that caused the impulse). Default false.
   */
  originOBRetest?: boolean;
}

// ─── Multi-Timeframe Zone Engine ──────────────────────────────────────────────
/**
 * Result from the multi-TF zone engine.
 * Includes the best zone across timeframes and individual TF results for transparency.
 */
/** Maps the three engine slots to human-readable timeframe labels.
 * Default (day_trader): { top: "D", mid: "4H", low: "1H" }
 * Scalper:              { top: "1H", mid: "15m", low: "5m" }
 * Swing:               { top: "W", mid: "D", low: "4H" }
 */
export interface TFSlotLabels {
  top: string;   // Highest TF slot ("Daily" slot in engine)
  mid: string;   // Middle TF slot ("4H" slot in engine)
  low: string;   // Lowest TF slot ("1H" slot in engine)
}

export const DEFAULT_TF_LABELS: TFSlotLabels = { top: "D", mid: "4H", low: "1H" };

export interface MultiTFZoneResult {
  bestZone: BestZone | null;
  selectedTF: string | null;  // Which timeframe produced the winning zone (style-aware label)
  reason: string;
  h1Result: ZoneEngineResult;
  h4Result: ZoneEngineResult | null; // null when 4H candles not available
  dailyResult?: ZoneEngineResult | null; // null when Daily candles not available
  allZones: RankedPOI[];            // Combined zones from all TFs
}

/**
 * findBestEntryZoneMultiTF — Runs the zone engine on Daily, 4H, and 1H candles
 * using a waterfall approach: Daily first, then 4H, then 1H.
 *
 * Selection logic (waterfall — Daily always wins when available):
 *   1. If Daily candles provided and Daily impulse+zone found → use Daily (A+ setup)
 *   2. Otherwise, if 4H produces a valid zone → use 4H (B+ setup)
 *   3. Otherwise, if 1H produces a valid zone → use 1H (C+ setup)
 *   4. If neither produces a zone, return null with combined reasons.
 *
 * When multiple TFs produce zones and no Daily zone exists, pick the best
 * using score → fibDepth → HTF preference (same as before).
 *
 * @param h1Candles  - 1H candles (always available)
 * @param h4Candles  - 4H candles (may be empty if multiTFRegime disabled)
 * @param entryCandles - Entry TF candles (15m) for LTF refinement
 * @param direction  - Trade direction
 * @param currentPrice - Current market price for proximity check
 * @param htfData - Optional HTF confluence data (4H OBs, FVGs, Breakers, Fib, P/D)
 * @param options - Optional engine options
 * @param dailyCandles - Optional Daily candles for top-down analysis
 */
export function findBestEntryZoneMultiTF(
  h1Candles: Candle[],
  h4Candles: Candle[],
  entryCandles: Candle[],
  direction: "bullish" | "bearish",
  currentPrice: number,
  htfData?: HTFConfluenceData,
  options?: ZoneEngineOptions,
  dailyCandles?: Candle[],
  tfLabels?: TFSlotLabels,
): MultiTFZoneResult {
  const labels = tfLabels ?? DEFAULT_TF_LABELS;
  // ── WATERFALL: Try Daily first (A+ setup) ──
  let dailyResult: ZoneEngineResult | null = null;
  if (dailyCandles && dailyCandles.length >= 20) {
    dailyResult = findBestEntryZone(dailyCandles, entryCandles, direction, currentPrice, htfData, options);
    // If Daily produces a valid zone, it wins immediately (highest conviction)
    if (dailyResult.bestZone) {
      const allZones: RankedPOI[] = [...dailyResult.allZones];
      return {
        bestZone: dailyResult.bestZone,
        selectedTF: labels.top,
        reason: `${labels.top} zone selected (A+ setup): ${dailyResult.reason}`,
        h1Result: findBestEntryZone(h1Candles, entryCandles, direction, currentPrice, htfData, options),
        h4Result: h4Candles.length >= 20 ? findBestEntryZone(h4Candles, entryCandles, direction, currentPrice, htfData, options) : null,
        dailyResult,
        allZones,
      };
    }
  }

  // ── FALLBACK: Run 1H and 4H (existing logic) ──
  // Always run 1H
  const h1Result = findBestEntryZone(h1Candles, entryCandles, direction, currentPrice, htfData, options);

  // Run 4H only if sufficient candles
  let h4Result: ZoneEngineResult | null = null;
  if (h4Candles.length >= 20) {
    h4Result = findBestEntryZone(h4Candles, entryCandles, direction, currentPrice, htfData, options);
  }

  // Combine all zones from all TFs for transparency
  const allZones: RankedPOI[] = [...h1Result.allZones];
  if (h4Result) {
    allZones.push(...h4Result.allZones);
  }
  if (dailyResult) {
    allZones.push(...dailyResult.allZones);
  }

  // Selection logic
  const h1Zone = h1Result.bestZone;
  const h4Zone = h4Result?.bestZone ?? null;

  // Case: Neither TF has a zone
  if (!h1Zone && !h4Zone) {
    const reasons: string[] = [`${labels.low}: ${h1Result.reason}`];
    if (h4Result) reasons.push(`${labels.mid}: ${h4Result.reason}`);
    else reasons.push(`${labels.mid}: Not available (insufficient candles)`);
    if (dailyResult) reasons.push(`${labels.top}: ${dailyResult.reason}`);
    return {
      bestZone: null,
      selectedTF: null,
      reason: `No valid zone on any timeframe. ${reasons.join("; ")}`,
      h1Result,
      h4Result,
      dailyResult,
      allZones,
    };
  }

  // Case: Only low-TF has a zone
  if (h1Zone && !h4Zone) {
    return {
      bestZone: h1Zone,
      selectedTF: labels.low,
      reason: `${labels.low} zone selected (${labels.mid} ${h4Result ? "found no zone" : "not available"}): ${h1Result.reason}`,
      h1Result,
      h4Result,
      dailyResult,
      allZones,
    };
  }

  // Case: Only mid-TF has a zone
  if (!h1Zone && h4Zone) {
    return {
      bestZone: h4Zone,
      selectedTF: labels.mid,
      reason: `${labels.mid} zone selected (${labels.low} found no zone): ${h4Result!.reason}`,
      h1Result,
      h4Result,
      dailyResult,
      allZones,
    };
  }

  // Case: Both have zones — pick the best
  const h1Score = h1Zone!.zone.totalScore;
  const h4Score = h4Zone!.zone.totalScore;

  if (h4Score > h1Score) {
    return {
      bestZone: h4Zone!,
      selectedTF: labels.mid,
      reason: `${labels.mid} zone wins (score ${h4Score} > ${labels.low} score ${h1Score}): ${h4Result!.reason}`,
      h1Result,
      h4Result,
      dailyResult,
      allZones,
    };
  }

  if (h1Score > h4Score) {
    return {
      bestZone: h1Zone!,
      selectedTF: labels.low,
      reason: `${labels.low} zone wins (score ${h1Score} > ${labels.mid} score ${h4Score}): ${h1Result.reason}`,
      h1Result,
      h4Result,
      dailyResult,
      allZones,
    };
  }

  // Tie on totalScore — use fibDepth as tiebreaker
  const h1Depth = h1Zone!.zone.fibDepth;
  const h4Depth = h4Zone!.zone.fibDepth;

  if (h4Depth > h1Depth) {
    return {
      bestZone: h4Zone!,
      selectedTF: labels.mid,
      reason: `${labels.mid} zone wins on depth (${h4Depth.toFixed(3)} > ${h1Depth.toFixed(3)}, tied score ${h4Score}): ${h4Result!.reason}`,
      h1Result,
      h4Result,
      dailyResult,
      allZones,
    };
  }

  if (h1Depth > h4Depth) {
    return {
      bestZone: h1Zone!,
      selectedTF: labels.low,
      reason: `${labels.low} zone wins on depth (${h1Depth.toFixed(3)} > ${h4Depth.toFixed(3)}, tied score ${h1Score}): ${h1Result.reason}`,
      h1Result,
      h4Result,
      dailyResult,
      allZones,
    };
  }

  // Perfect tie — mid-TF wins (higher timeframe = more significant structure)
  return {
    bestZone: h4Zone!,
    selectedTF: labels.mid,
    reason: `${labels.mid} zone wins (tied score ${h4Score}, tied depth ${h4Depth.toFixed(3)} — HTF preferred): ${h4Result!.reason}`,
    h1Result,
    h4Result,
    dailyResult,
    allZones,
  };
}
