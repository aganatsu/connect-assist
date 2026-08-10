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
import { evaluateZoneLifecycle, type ZoneLifecycleConfig, type ZoneLifecycleResult } from "./zoneLifecycle.ts";
import { buildConceptEvidence, type MarketConceptEvidence } from "./conceptEvidence.ts";
import {
  createZoneLocalConfluenceObservation,
  observeContextOnly,
  observeZoneLocalPoint,
  observeZoneLocalRange,
  type ZoneLocalConfluenceObservation,
} from "./zoneLocalConfluence.ts";
import type { ZoneCandidateShadowRanking } from "./zoneCandidateShadowRanking.ts";
import {
  canonicalImpulseMatchesLegacy,
  detectCanonicalImpulse,
  type CanonicalImpulseDetection,
  type CanonicalImpulseMetrics,
} from "./canonicalImpulseDetector.ts";
import {
  type CanonicalZoneLifecycleObservation,
  type ZoneCandidateModelObservation,
} from "./zoneCandidateModel.ts";
import type { CrossTimeframeZoneLineage } from "./crossTimeframeZoneLineage.ts";
import { canonicalStructureForLegacyConsumers } from "./canonicalStructureAdapter.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImpulseLeg {
  high: number;         // Swing high wick (Fib level 1)
  low: number;          // Swing low wick (Fib level 0)
  direction: "bullish" | "bearish";
  startIndex: number;   // Index of the swing that started the move
  endIndex: number;     // Index of the BOS candle
  isValid: boolean;     // Origin not broken (price hasn't retraced past the impulse start)
  bosPrice: number;     // Price level of the structure break
  breakType?: "bos" | "choch";
  timeframe?: "D" | "4H" | "1H";  // Which timeframe produced this impulse
  startDate?: string;   // ISO date of the impulse start candle (e.g. "2026-05-20")
  endDate?: string;     // ISO date of the BOS candle
  spanBars?: number;    // Number of candles in the impulse leg
}

export interface ImpulsePOI {
  type: "fvg" | "ob";
  high: number;
  low: number;
  candleIndex: number;
  direction: "bullish" | "bearish";
  isOriginOB?: boolean;   // True if this OB was synthesized as the impulse-origin re-test candidate
  /** Observe-only canonical identity; absent when no evidence context is supplied. */
  evidence?: MarketConceptEvidence;
}

export interface RankedPOI {
  poi: ImpulsePOI;
  fibLevel: number;       // Nearest Fib ratio (e.g. 0.618, 0.786)
  /** Actual price of the named Fib level. Kept separate from POI fibDepth. */
  fibPrice?: number;
  fibDepth: number;       // How deep into the retracement (higher = better)
  fibScore: number;       // 1-4 score based on depth
  srConfirmed: boolean;   // Historical S/R overlaps this zone
  srLevel?: number;       // The actual S/R price level that confirmed this zone
  ltfRefined: boolean;    // LTF OB/FVG found inside
  refinedEntry?: number;  // Precise entry from LTF refinement
  refinedSL?: number;     // Precise SL from LTF refinement
  ltfType?: "ob" | "fvg";
  htfConfluenceScore: number; // Score from HTF confluence layers (4H OB/FVG/Breaker, HTF Fib, P/D)
  htfLayers: string[];        // Labels of HTF layers that overlap this zone
  totalScore: number;     // fibScore + srConfirmed(+1) + ltfRefined(+1) + htfConfluenceScore
  /** Observe-only proximity evidence. It never participates in ranking or gates. */
  localConfluence?: ZoneLocalConfluenceObservation;
  /** Alternative candidate ordering for audit only. */
  shadowRanking?: ZoneCandidateShadowRanking;
  /** Counterfactual levels used only for outcome validation. */
  validationTrade?: ZoneValidationTrade;
  /** Observation-only Phase 3 lifecycle classification. */
  candidateLifecycle?: CanonicalZoneLifecycleObservation;
  /** Relative impulse metrics inherited from this candidate's timeframe. */
  canonicalImpulseMetrics?: CanonicalImpulseMetrics | null;
  /** Observation-only Phase 3 cross-factor candidate rank. */
  candidateModel?: ZoneCandidateModelObservation;
  /** Observation-only Phase 4 parent/child timeframe relationship. */
  timeframeLineage?: CrossTimeframeZoneLineage;
}

export interface ZoneValidationTrade {
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  source: "ltf_refinement" | "zone_bounds";
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
  /** Present only when the observation-only collector is explicitly enabled. */
  evidence?: ZoneEngineEvidenceSnapshot;
}

export interface ZoneEngineEvidenceSnapshot {
  timeframe: string | null;
  currentPrice: number;
  impulses: ImpulseLegCandidate[];
  mappedPOIs: ImpulsePOI[];
  qualificationMeasurements: POIQualificationMeasurement[];
  rankedZones: RankedPOI[];
  canonicalImpulse: CanonicalImpulseDetection | null;
  canonicalMatchesLegacy: boolean | null;
}

export interface ZoneQualificationResult {
  accepted: ImpulsePOI[];
  rejected: Record<"age" | "body_ratio" | "displacement", number>;
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
  collector?: (candidate: ImpulseLegCandidate) => void,
  structureAuthorityMode: "observe" | "enforce" = "observe",
): ImpulseLeg | null {
  if (candles.length < 20) return null;

  const canonicalStructure = canonicalStructureForLegacyConsumers(candles);
  const legacyStructure = analyzeMarketStructure(candles);
  const legacyBreaks = [
    ...legacyStructure.bos.map((item) => ({ ...item, breakType: "bos" as const })),
    ...legacyStructure.choch.map((item) => ({ ...item, breakType: "choch" as const })),
  ];
  const activeBreaks = structureAuthorityMode === "enforce"
    ? canonicalStructure.breaks
    : legacyBreaks;
  const activeSwings = structureAuthorityMode === "enforce"
    ? canonicalStructure.swings
    : legacyStructure.swingPoints;
  const allBreaks = activeBreaks
    .filter(b => b.type === direction)
    .sort((a, b) => b.index - a.index); // Most recent first

  if (allBreaks.length === 0) return null;

  // Try each BOS from most recent to oldest
  for (const bos of allBreaks) {
    let emittedCandidate = false;
    const impulse = validateImpulseFromBOS(
      candles,
      bos,
      direction,
      activeSwings,
      (candidate) => {
        emittedCandidate = true;
        collector?.(candidate);
      },
    );
    if (impulse && impulse.isValid) {
      // Enrich with timeframe metadata if provided
      if (timeframe) {
        impulse.timeframe = timeframe;
      }
      // Extract dates from candle datetimes
      const startCandle = candles[impulse.startIndex];
      const endCandle = candles[impulse.endIndex];
      if (startCandle?.datetime) {
        // Keep date + time (YYYY-MM-DD HH:MM) so the impulse leg is traceable
        // on the chart down to the exact bar, not just the day.
        impulse.startDate = startCandle.datetime;
      }
      if (endCandle?.datetime) {
        impulse.endDate = endCandle.datetime;
      }
      impulse.spanBars = impulse.endIndex - impulse.startIndex;
      collector?.({ leg: impulse, selected: true, rejection: null });
      return impulse;
    }
    if (!impulse && !emittedCandidate) {
      collector?.({
        leg: {
          high: bos.price,
          low: bos.price,
          direction,
          startIndex: bos.index,
          endIndex: bos.index,
          isValid: false,
          bosPrice: bos.price,
          breakType: bos.breakType,
          timeframe,
          startDate: candles[bos.index]?.datetime,
          endDate: candles[bos.index]?.datetime,
          spanBars: 0,
        },
        selected: false,
        rejection: {
          code: "origin_broken_or_invalid",
          explanation:
            `No valid swing origin for the ${direction} break at index ${bos.index}`,
        },
      });
    }
  }

  return null;
}

/**
 * Given a BOS, trace back to find the swing origin and validate that the
 * origin has not been broken by subsequent price action (after the BOS).
 */
function validateImpulseFromBOS(
  candles: Candle[],
  bos: StructureBreak & { breakType?: "bos" | "choch" },
  direction: "bullish" | "bearish",
  swingPoints: SwingPoint[],
  collector?: (candidate: ImpulseLegCandidate) => void,
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
        breakType: bos.breakType,
      };
    }
    collector?.({
      leg: {
        high: impulseHigh,
        low: impulseLow,
        direction,
        startIndex: startIdx,
        endIndex: endIdx,
        isValid: false,
        bosPrice: bos.price,
        breakType: bos.breakType,
        timeframe: undefined,
        startDate: candles[startIdx]?.datetime,
        endDate: candles[endIdx]?.datetime,
        spanBars: endIdx - startIdx,
      },
      selected: false,
      rejection: {
        code: "origin_broken_or_invalid",
        explanation:
          "Impulse origin was broken by a later candle close before evaluation",
      },
    });
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
  options?: {
    originOBRetest?: boolean;
    zoneLifecycleV2?: { enabled: boolean; config?: Partial<ZoneLifecycleConfig>; allCandles?: Candle[] };
    evidenceContext?: ZoneEvidenceContext;
  },
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
      const candleIndex = start + fvg.index;
      const sourceStart = candles[Math.max(0, candleIndex - 1)]?.datetime ?? fvg.datetime;
      const sourceEnd = candles[Math.min(candles.length - 1, candleIndex + 1)]?.datetime ?? fvg.datetime;
      pois.push({
        type: "fvg",
        high: fvg.high,
        low: fvg.low,
        candleIndex,
        direction: fvg.type,
        evidence: options?.evidenceContext ? buildConceptEvidence({
          concept: "fvg",
          detector: { name: "smcAnalysis.detectFVGs", version: "1" },
          symbol: options.evidenceContext.symbol,
          timeframe: options.evidenceContext.timeframe,
          sourceCandleStart: sourceStart,
          sourceCandleEnd: sourceEnd,
          observedAt: options.evidenceContext.observedAt ?? candles[candles.length - 1]?.datetime ?? sourceEnd,
          direction: fvg.type,
          bounds: { high: fvg.high, low: fvg.low },
          lifecycle: fvg.state,
          attributes: {
            sourceIndex: candleIndex,
            quality: fvg.quality ?? null,
            fillPercent: fvg.fillPercent,
          },
        }) : undefined,
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

    if (ob.type !== impulse.direction) continue;

    // Zone Lifecycle v2: use close-based invalidation instead of state check
    if (options?.zoneLifecycleV2?.enabled && options.zoneLifecycleV2.allCandles) {
      // Get candles AFTER this OB formed
      const candlesAfterOB = options.zoneLifecycleV2.allCandles.slice(fullIndex + 1);
      const lifecycleResult = evaluateZoneLifecycle(
        { high: ob.high, low: ob.low, direction: ob.type === "bullish" ? "bullish" : "bearish" },
        candlesAfterOB,
        options.zoneLifecycleV2.config,
      );
      if (lifecycleResult.canStillTrade) {
        pois.push({
          type: "ob",
          high: ob.high,
          low: ob.low,
          candleIndex: fullIndex,
          direction: ob.type,
          evidence: buildPOIEvidence("smcAnalysis.detectOrderBlocks", ob.datetime, fullIndex, ob.high, ob.low, ob.type, ob.state, options?.evidenceContext, candles),
        });
      }
    } else {
      // Default: original state-based filter
      if (ob.state !== "broken" && ob.state !== "mitigated") {
        pois.push({
          type: "ob",
          high: ob.high,
          low: ob.low,
          candleIndex: fullIndex,
          direction: ob.type,
          evidence: buildPOIEvidence("smcAnalysis.detectOrderBlocks", ob.datetime, fullIndex, ob.high, ob.low, ob.type, ob.state, options?.evidenceContext, candles),
        });
      }
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
          evidence: buildPOIEvidence("impulseZone.originOBRetest", oc.datetime, originCandleIdx, oc.high, oc.low, impulse.direction, "synthetic_origin_candidate", options?.evidenceContext, candles),
        });
      }
    }
  }

  return pois;
}

function buildPOIEvidence(
  detectorName: string,
  sourceDatetime: string,
  sourceIndex: number,
  high: number,
  low: number,
  direction: "bullish" | "bearish",
  lifecycle: string,
  context: ZoneEvidenceContext | undefined,
  candles: Candle[],
): MarketConceptEvidence | undefined {
  if (!context) return undefined;
  return buildConceptEvidence({
    concept: "order_block",
    detector: { name: detectorName, version: "1" },
    symbol: context.symbol,
    timeframe: context.timeframe,
    sourceCandleStart: sourceDatetime,
    observedAt: context.observedAt ?? candles[candles.length - 1]?.datetime ?? sourceDatetime,
    direction,
    bounds: { high, low },
    lifecycle,
    attributes: { sourceIndex },
  });
}

/**
 * Apply the Bot Config zone-quality controls before Fib scoring.
 *
 * - Age is measured from the POI candle to the newest structural candle.
 * - Body ratio applies to OB candles only; FVGs use their displacement candle.
 * - Displacement uses the FVG middle candle or the strongest directional candle
 *   immediately following an OB.
 */
export function qualifyImpulsePOIs(
  candles: Candle[],
  impulse: ImpulseLeg,
  pois: ImpulsePOI[],
  options?: Pick<ZoneEngineOptions, "maxAgeBars" | "minBodyRatio" | "minDisplacementATR">,
): ZoneQualificationResult {
  const rejected = { age: 0, body_ratio: 0, displacement: 0 };
  const maxAgeBars = Math.max(0, Number(options?.maxAgeBars ?? 0));
  const minBodyRatio = Math.max(0, Math.min(1, Number(options?.minBodyRatio ?? 0)));
  const minDisplacementATR = Math.max(0, Number(options?.minDisplacementATR ?? 0));
  const atr = minDisplacementATR > 0 ? calculateATR(candles) : 0;

  const accepted = pois.filter((poi) => {
    const ageBars = Math.max(0, candles.length - 1 - poi.candleIndex);
    if (maxAgeBars > 0 && ageBars > maxAgeBars) {
      rejected.age++;
      return false;
    }

    const source = candles[poi.candleIndex];
    if (poi.type === "ob" && minBodyRatio > 0 && source) {
      const range = Math.max(0, source.high - source.low);
      const bodyRatio = range > 0 ? Math.abs(source.close - source.open) / range : 0;
      if (bodyRatio < minBodyRatio) {
        rejected.body_ratio++;
        return false;
      }
    }

    if (minDisplacementATR > 0 && atr > 0) {
      let displacement = source;
      if (poi.type === "ob") {
        const start = Math.min(candles.length - 1, poi.candleIndex + 1);
        const end = Math.min(candles.length - 1, impulse.endIndex, poi.candleIndex + 3);
        const directional = candles.slice(start, end + 1).filter((candle) =>
          impulse.direction === "bullish"
            ? candle.close > candle.open
            : candle.close < candle.open
        );
        displacement = directional.sort(
          (a, b) => (b.high - b.low) - (a.high - a.low),
        )[0] ?? candles[start];
      }
      const displacementRange = displacement
        ? Math.max(0, displacement.high - displacement.low)
        : 0;
      if (displacementRange < atr * minDisplacementATR) {
        rejected.displacement++;
        return false;
      }
    }

    return true;
  });

  return { accepted, rejected };
}

export function zoneQualityPercent(zone: RankedPOI): number {
  return Math.max(0, Math.min(100, (zone.totalScore / 9) * 100));
}

// ─── Observation-only measurement (Phase 1 evidence) ─────────────────────────

export interface POIQualificationMeasurement {
  poi: ImpulsePOI;
  ageBars: number;
  bodyRatio: number | null;
  displacementRange: number | null;
  displacementATRMultiple: number | null;
  atr: number;
  accepted: boolean;
  rejection:
    | {
      code: "poi_age_above_max" | "ob_body_ratio_below_min" | "displacement_below_min_atr";
      measured: number;
      threshold: number;
      comparator: ">" | "<";
      explanation: string;
    }
    | null;
}

/**
 * Observation-only mirror of `qualifyImpulsePOIs` that reports the measured
 * value, the threshold and a structured rejection code per POI.
 *
 * Pure and side-effect free. It is never called on the trading path and never
 * feeds scoring, ranking or gating — it exists so evidence can explain exactly
 * why a candidate was dropped.
 */
export function measureImpulsePOIQualification(
  candles: Candle[],
  impulse: ImpulseLeg,
  pois: ImpulsePOI[],
  options?: Pick<ZoneEngineOptions, "maxAgeBars" | "minBodyRatio" | "minDisplacementATR">,
): POIQualificationMeasurement[] {
  const maxAgeBars = Math.max(0, Number(options?.maxAgeBars ?? 0));
  const minBodyRatio = Math.max(0, Math.min(1, Number(options?.minBodyRatio ?? 0)));
  const minDisplacementATR = Math.max(0, Number(options?.minDisplacementATR ?? 0));
  const atr = minDisplacementATR > 0 ? calculateATR(candles) : 0;

  return pois.map((poi) => {
    const ageBars = Math.max(0, candles.length - 1 - poi.candleIndex);
    const source = candles[poi.candleIndex];
    let bodyRatio: number | null = null;
    if (poi.type === "ob" && source) {
      const range = Math.max(0, source.high - source.low);
      bodyRatio = range > 0 ? Math.abs(source.close - source.open) / range : 0;
    }

    let displacementRange: number | null = null;
    if (atr > 0) {
      let displacement = source;
      if (poi.type === "ob") {
        const start = Math.min(candles.length - 1, poi.candleIndex + 1);
        const end = Math.min(candles.length - 1, impulse.endIndex, poi.candleIndex + 3);
        const directional = candles.slice(start, end + 1).filter((candle) =>
          impulse.direction === "bullish"
            ? candle.close > candle.open
            : candle.close < candle.open
        );
        displacement = directional.slice().sort(
          (a, b) => (b.high - b.low) - (a.high - a.low),
        )[0] ?? candles[start];
      }
      displacementRange = displacement
        ? Math.max(0, displacement.high - displacement.low)
        : 0;
    }

    let rejection: POIQualificationMeasurement["rejection"] = null;
    if (maxAgeBars > 0 && ageBars > maxAgeBars) {
      rejection = {
        code: "poi_age_above_max",
        measured: ageBars,
        threshold: maxAgeBars,
        comparator: ">",
        explanation: `POI age ${ageBars} bars exceeds maximum ${maxAgeBars}`,
      };
    } else if (
      poi.type === "ob" && minBodyRatio > 0 && bodyRatio !== null &&
      bodyRatio < minBodyRatio
    ) {
      rejection = {
        code: "ob_body_ratio_below_min",
        measured: Number(bodyRatio.toFixed(6)),
        threshold: minBodyRatio,
        comparator: "<",
        explanation: `OB body ratio ${bodyRatio.toFixed(3)} below required ${minBodyRatio}`,
      };
    } else if (
      minDisplacementATR > 0 && atr > 0 && displacementRange !== null &&
      displacementRange < atr * minDisplacementATR
    ) {
      rejection = {
        code: "displacement_below_min_atr",
        measured: Number((displacementRange / atr).toFixed(6)),
        threshold: minDisplacementATR,
        comparator: "<",
        explanation:
          `Displacement ${(displacementRange / atr).toFixed(2)}x ATR below required ${minDisplacementATR}x`,
      };
    }

    return {
      poi,
      ageBars,
      bodyRatio: bodyRatio === null ? null : Number(bodyRatio.toFixed(6)),
      displacementRange,
      displacementATRMultiple: displacementRange !== null && atr > 0
        ? Number((displacementRange / atr).toFixed(6))
        : null,
      atr,
      accepted: rejection === null,
      rejection,
    };
  });
}

export interface ImpulseLegCandidate {
  leg: ImpulseLeg;
  selected: boolean;
  rejection:
    | { code: "origin_broken_or_invalid"; explanation: string }
    | null;
}

/**
 * Observation-only enumeration of every impulse leg the engine considered for
 * a direction, in the same order `findImpulseLeg` evaluates them. Pure; never
 * used by the trading path.
 */
export function collectImpulseLegCandidates(
  candles: Candle[],
  direction: "bullish" | "bearish",
  timeframe?: string,
): ImpulseLegCandidate[] {
  const out: ImpulseLegCandidate[] = [];
  findImpulseLeg(
    candles,
    direction,
    timeframe as ImpulseLeg["timeframe"],
    (candidate) => out.push(candidate),
  );
  return out;
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
  options?: {
    fibMaxRetracement?: number;
    originOBRetest?: boolean;
    pipSize?: number;
    atr?: number;
    evidenceContext?: ZoneEvidenceContext;
  },
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
    let nearestFibPrice = 0;
    let nearestDist = Infinity;
    for (const level of FIB_LEVELS) {
      const fibPrice = impulse.direction === "bullish"
        ? impulse.high - level * range
        : impulse.low + level * range;
      const dist = Math.abs(poiMid - fibPrice);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestFib = level;
        nearestFibPrice = fibPrice;
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

    const rankedPOI: RankedPOI = {
      poi,
      fibLevel: nearestFib,
      fibPrice: nearestFibPrice,
      fibDepth,
      fibScore,
      srConfirmed: false,
      ltfRefined: false,
      htfConfluenceScore: 0,
      htfLayers: [],
      totalScore: fibScore, // Will be updated by subsequent steps
    };

    if (options?.evidenceContext && poi.evidence) {
      const observedAt = options.evidenceContext.observedAt ||
        impulse.endDate ||
        impulse.startDate ||
        "unknown";
      const fibEvidence = buildConceptEvidence({
        concept: "fib_level",
        detector: { name: "impulseZone.overlayFibOnPOIs", version: "1" },
        symbol: options.evidenceContext.symbol,
        timeframe: options.evidenceContext.timeframe,
        sourceCandleStart: impulse.startDate || observedAt,
        sourceCandleEnd: impulse.endDate || observedAt,
        observedAt,
        direction: impulse.direction,
        level: nearestFibPrice,
        discriminator: nearestFib,
        attributes: {
          ratio: nearestFib,
          rawFibDepth: fibDepth,
          nearestDistance: nearestDist,
          legacyTolerance: tolerance,
          admittedByOTEWindow: inOTE,
          admittedByNamedFibTolerance: nearFib,
        },
      });
      const localConfluence = createZoneLocalConfluenceObservation({
        candidateId: poi.evidence.entityId,
        zone: { low: poi.low, high: poi.high },
        pipSize: options.pipSize ?? 0.0001,
        atr: options.atr ?? 0,
      });
      localConfluence.items.push(observeZoneLocalPoint({
        source: "impulse_fib",
        label: `Impulse Fib ${(nearestFib * 100).toFixed(1)}%`,
        evidence: fibEvidence,
        candidate: localConfluence,
        level: nearestFibPrice,
        legacyScoreContribution: fibScore,
        attributes: {
          rawFibDepth: fibDepth,
          poiMid,
          nearestDistance: nearestDist,
        },
      }));
      rankedPOI.localConfluence = localConfluence;
    }

    ranked.push(rankedPOI);
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
  options?: {
    evidenceContext?: ZoneEvidenceContext;
  },
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
        zone.srLevel = sr;
        zone.totalScore = zone.fibScore + zone.htfConfluenceScore + 1; // +1 for S/R confirmation
        if (
          zone.localConfluence &&
          options?.evidenceContext
        ) {
          const observedAt = options.evidenceContext.observedAt ||
            candles[candles.length - 1]?.datetime ||
            "unknown";
          const srEvidence = buildConceptEvidence({
            concept: "support_resistance",
            detector: {
              name: "impulseZone.findCloseClusters",
              version: "1",
            },
            symbol: options.evidenceContext.symbol,
            timeframe: options.evidenceContext.timeframe,
            sourceCandleStart: candles[lookbackStart]?.datetime || observedAt,
            sourceCandleEnd: candles[Math.max(lookbackStart, lookbackEnd - 1)]
              ?.datetime || observedAt,
            observedAt,
            direction: "neutral",
            level: sr,
            discriminator: `${lookbackStart}:${lookbackEnd}`,
            attributes: {
              minimumTouches: SR_MIN_TOUCHES,
              clusterTolerance,
              lookbackStart,
              lookbackEnd,
            },
          });
          zone.localConfluence.items.push(observeZoneLocalPoint({
            source: "historical_sr",
            label: "Historical close S/R",
            evidence: srEvidence,
            candidate: zone.localConfluence,
            level: sr,
            legacyScoreContribution: 1,
          }));
        }
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
  options?: {
    evidenceContext?: ZoneEvidenceContext;
  },
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
        if (zone.localConfluence && options?.evidenceContext) {
          const evidence = buildConceptEvidence({
            concept: "order_block",
            detector: { name: "smcAnalysis.detectOrderBlocks", version: "1" },
            symbol: options.evidenceContext.symbol,
            timeframe: "4H",
            sourceCandleStart: ob.datetime,
            observedAt: options.evidenceContext.observedAt || ob.datetime,
            direction: ob.type,
            bounds: { low: ob.low, high: ob.high },
            lifecycle: ob.state,
            discriminator: ob.index,
            attributes: {
              testedCount: ob.testedCount,
              mitigatedPercent: ob.mitigatedPercent,
            },
          });
          zone.localConfluence.items.push(observeZoneLocalRange({
            source: "htf_order_block",
            label: "4H Order Block",
            evidence,
            candidate: zone.localConfluence,
            bounds: { low: ob.low, high: ob.high },
            legacyScoreContribution: 1,
          }));
        }
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
        if (zone.localConfluence && options?.evidenceContext) {
          const evidence = buildConceptEvidence({
            concept: "fvg",
            detector: { name: "smcAnalysis.detectFVGs", version: "1" },
            symbol: options.evidenceContext.symbol,
            timeframe: "4H",
            sourceCandleStart: fvg.datetime,
            observedAt: options.evidenceContext.observedAt || fvg.datetime,
            direction: fvg.type,
            bounds: { low: fvg.low, high: fvg.high },
            lifecycle: fvg.state,
            discriminator: fvg.index,
            attributes: {
              fillPercent: fvg.fillPercent,
              respectedCount: fvg.respectedCount,
            },
          });
          zone.localConfluence.items.push(observeZoneLocalRange({
            source: "htf_fvg",
            label: "4H Fair Value Gap",
            evidence,
            candidate: zone.localConfluence,
            bounds: { low: fvg.low, high: fvg.high },
            legacyScoreContribution: 1,
          }));
        }
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
        if (zone.localConfluence && options?.evidenceContext) {
          const observedAt = options.evidenceContext.observedAt || "unknown";
          const evidence = buildConceptEvidence({
            concept: "breaker",
            detector: {
              name: "smcAnalysis.detectBreakerBlocks",
              version: "1",
            },
            symbol: options.evidenceContext.symbol,
            timeframe: "4H",
            sourceCandleStart: observedAt,
            observedAt,
            direction: bb.type === "bullish_breaker"
              ? "bullish"
              : "bearish",
            bounds: { low: bb.low, high: bb.high },
            lifecycle: bb.state,
            discriminator: bb.mitigatedAt,
            attributes: {
              subtype: bb.subtype,
              testedCount: bb.testedCount,
              sourceIndex: bb.mitigatedAt,
            },
          });
          zone.localConfluence.items.push(observeZoneLocalRange({
            source: "htf_breaker",
            label: "4H Breaker",
            evidence,
            candidate: zone.localConfluence,
            bounds: { low: bb.low, high: bb.high },
            legacyScoreContribution: 1,
          }));
        }
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
    let bestFib: { fib: FibLevel; prefix: string } | null = null;
    for (const { levels, prefix } of fibSources) {
      for (const fib of levels.retracements) {
        if (fib.price >= zoneLow && fib.price <= zoneHigh) {
          // Premium Fib levels (61.8%, 71%, 78.6%) get +1.5
          if (fib.ratio === 0.618 || fib.ratio === 0.71 || fib.ratio === 0.786) {
            if (1.5 > bestFibScore) {
              bestFibScore = 1.5;
              bestFibLabel = `${prefix}_FIB_${(fib.ratio * 100).toFixed(1)}`;
              bestFib = { fib, prefix };
            }
          }
          // 50% Fib gets +0.5
          else if (fib.ratio === 0.5) {
            if (0.5 > bestFibScore) {
              bestFibScore = 0.5;
              bestFibLabel = `${prefix}_FIB_50.0`;
              bestFib = { fib, prefix };
            }
          }
        }
      }
    }
    if (bestFibScore > 0) {
      score += bestFibScore;
      layers.push(bestFibLabel);
      if (
        bestFib &&
        zone.localConfluence &&
        options?.evidenceContext
      ) {
        const levels = bestFib.prefix === "D1"
          ? htfData.dailyFibLevels
          : htfData.htfFibLevels;
        const observedAt = options.evidenceContext.observedAt || "unknown";
        const sourceStart = levels?.pivotLow?.datetime ||
          levels?.pivotHigh?.datetime ||
          observedAt;
        const sourceEnd = levels?.pivotHigh?.datetime ||
          levels?.pivotLow?.datetime ||
          observedAt;
        const evidence = buildConceptEvidence({
          concept: "fib_level",
          detector: { name: "smcAnalysis.calculateFibLevels", version: "1" },
          symbol: options.evidenceContext.symbol,
          timeframe: bestFib.prefix === "D1" ? "D1" : "4H",
          sourceCandleStart: sourceStart,
          sourceCandleEnd: sourceEnd,
          observedAt,
          direction: levels?.direction === "up" ? "bullish" : "bearish",
          level: bestFib.fib.price,
          discriminator: bestFib.fib.ratio,
          attributes: {
            ratio: bestFib.fib.ratio,
            prefix: bestFib.prefix,
          },
        });
        zone.localConfluence.items.push(observeZoneLocalPoint({
          source: "htf_fib",
          label: bestFibLabel,
          evidence,
          candidate: zone.localConfluence,
          level: bestFib.fib.price,
          legacyScoreContribution: bestFibScore,
        }));
      }
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
        if (zone.localConfluence) {
          zone.localConfluence.items.push(observeContextOnly({
            source: "premium_discount",
            label: "Premium/Discount alignment",
            evidence: null,
            candidate: zone.localConfluence,
            legacyScoreContribution: 0.5,
            reasonCode: "directional_context_not_price_local",
            attributes: {
              currentZone: pd.currentZone,
              zonePercent: pd.zonePercent,
              oteZone: pd.oteZone,
            },
          }));
        }
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
  options?: {
    evidenceContext?: ZoneEvidenceContext;
  },
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
  let bestLTF: {
    type: "ob" | "fvg";
    high: number;
    low: number;
    datetime: string;
    sourceIndex: number;
    lifecycle: string;
  } | null = null;

  // Prefer OBs over FVGs for precision
  for (const ob of ltfOBs) {
    if (ob.type === zone.poi.direction && ob.state !== "broken" && ob.state !== "mitigated") {
      // Ensure the OB is actually inside the zone boundaries
      if (ob.high <= zoneHigh && ob.low >= zoneLow) {
        bestLTF = {
          type: "ob",
          high: ob.high,
          low: ob.low,
          datetime: ob.datetime,
          sourceIndex: ob.index,
          lifecycle: ob.state,
        };
        break;
      }
    }
  }

  // Fallback to FVG if no OB found
  if (!bestLTF) {
    for (const fvg of ltfFVGs) {
      if (fvg.type === zone.poi.direction && fvg.state !== "filled") {
        if (fvg.high <= zoneHigh && fvg.low >= zoneLow) {
          bestLTF = {
            type: "fvg",
            high: fvg.high,
            low: fvg.low,
            datetime: fvg.datetime,
            sourceIndex: fvg.index,
            lifecycle: fvg.state,
          };
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
  if (zone.localConfluence && options?.evidenceContext) {
    const observedAt = options.evidenceContext.observedAt ||
      entryCandles[entryCandles.length - 1]?.datetime ||
      bestLTF.datetime;
    const evidence = buildConceptEvidence({
      concept: bestLTF.type === "ob" ? "order_block" : "fvg",
      detector: {
        name: bestLTF.type === "ob"
          ? "smcAnalysis.detectOrderBlocks"
          : "smcAnalysis.detectFVGs",
        version: "1",
      },
      symbol: options.evidenceContext.symbol,
      timeframe: "LTF",
      sourceCandleStart: bestLTF.datetime,
      observedAt,
      direction: zone.poi.direction,
      bounds: { low: bestLTF.low, high: bestLTF.high },
      lifecycle: bestLTF.lifecycle,
      discriminator: bestLTF.sourceIndex,
      attributes: {
        parentTimeframe: options.evidenceContext.timeframe,
        refinementType: bestLTF.type,
      },
    });
    zone.localConfluence.items.push(observeZoneLocalRange({
      source: "ltf_refinement",
      label: `LTF ${bestLTF.type.toUpperCase()} refinement`,
      evidence,
      candidate: zone.localConfluence,
      bounds: { low: bestLTF.low, high: bestLTF.high },
      legacyScoreContribution: 1,
    }));
  }

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

export function buildZoneValidationTrade(
  zone: RankedPOI,
  impulse: ImpulseLeg,
): ZoneValidationTrade {
  const width = Math.max(0, zone.poi.high - zone.poi.low);
  if (zone.poi.direction === "bullish") {
    const entryPrice = zone.refinedEntry ?? zone.poi.low;
    let stopLoss = zone.refinedSL ?? zone.poi.low - width * 0.5;
    if (stopLoss < impulse.low) stopLoss = impulse.low;
    return {
      direction: "long",
      entryPrice,
      stopLoss,
      takeProfit: impulse.bosPrice,
      source: zone.ltfRefined ? "ltf_refinement" : "zone_bounds",
    };
  }
  const entryPrice = zone.refinedEntry ?? zone.poi.high;
  let stopLoss = zone.refinedSL ?? zone.poi.high + width * 0.5;
  if (stopLoss > impulse.high) stopLoss = impulse.high;
  return {
    direction: "short",
    entryPrice,
    stopLoss,
    takeProfit: impulse.bosPrice,
    source: zone.ltfRefined ? "ltf_refinement" : "zone_bounds",
  };
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
  const collectedImpulses: ImpulseLegCandidate[] = [];
  let collectedPOIs: ImpulsePOI[] = [];
  let collectedMeasurements: POIQualificationMeasurement[] = [];
  let collectedRankedZones: RankedPOI[] = [];
  const canonicalImpulse = options?.collectEvidence
    ? detectCanonicalImpulse(
      htfCandles,
      direction,
      options.evidenceContext?.timeframe,
    )
    : null;
  const finish = (result: ZoneEngineResult): ZoneEngineResult => {
    if (!options?.collectEvidence) return result;
    return {
      ...result,
      evidence: {
        timeframe: options.evidenceContext?.timeframe ?? null,
        currentPrice,
        impulses: collectedImpulses,
        mappedPOIs: collectedPOIs,
        qualificationMeasurements: collectedMeasurements,
        rankedZones: collectedRankedZones,
        canonicalImpulse,
        canonicalMatchesLegacy: canonicalImpulseMatchesLegacy(
          canonicalImpulse?.impulse ?? null,
          result.impulse,
        ),
      },
    };
  };

  // Step 1: Find impulse leg
  const impulse = findImpulseLeg(
    htfCandles,
    direction,
    undefined,
    options?.collectEvidence
      ? (candidate) => collectedImpulses.push(candidate)
      : undefined,
    options?.structureAuthorityMode ?? "observe",
  );
  if (!impulse) {
    return finish({
      bestZone: null,
      impulse: null,
      allZones: [],
      reason: `No valid ${direction} impulse leg found (no BOS or origin broken)`,
    });
  }

  // Step 2: Map POIs within the impulse
  const mappedPOIs = mapImpulsePOIs(htfCandles, impulse, {
    originOBRetest: options?.originOBRetest,
    zoneLifecycleV2: options?.zoneLifecycleV2,
    evidenceContext: options?.evidenceContext,
  });
  collectedPOIs = mappedPOIs;
  const qualification = qualifyImpulsePOIs(htfCandles, impulse, mappedPOIs, options);
  if (options?.collectEvidence) {
    collectedMeasurements = measureImpulsePOIQualification(
      htfCandles,
      impulse,
      mappedPOIs,
      options,
    );
  }
  const pois = qualification.accepted;
  if (pois.length === 0) {
    const rejected = Object.entries(qualification.rejected)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    return finish({
      bestZone: null,
      impulse,
      allZones: [],
      reason: mappedPOIs.length === 0
        ? `Impulse found but no POIs (FVGs/OBs) detected within it`
        : `POIs found but Bot Config zone qualification rejected all (${rejected})`,
    });
  }

  // Step 3: Overlay Fib and score by depth
  const zoneATR = calculateATR(htfCandles);
  let rankedZones = overlayFibOnPOIs(impulse, pois, {
    fibMaxRetracement: options?.fibMaxRetracement,
    originOBRetest: options?.originOBRetest,
    pipSize: options?.pipSize,
    atr: zoneATR,
    evidenceContext: options?.evidenceContext,
  });
  collectedRankedZones = rankedZones;
  if (rankedZones.length === 0) {
    return finish({
      bestZone: null,
      impulse,
      allZones: [],
      reason: `POIs found but none align with key Fib levels (50%-${((options?.fibMaxRetracement ?? 0.786) * 100).toFixed(1)}%${options?.originOBRetest ? " incl. origin OB" : ""})`,
    });
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
    collectedRankedZones = rankedZones;
    if (rankedZones.length === 0) {
      return finish({
        bestZone: null,
        impulse,
        allZones: [],
        reason: `POIs found at Fib levels but none overlap with Daily zone [${bounds.low.toFixed(5)}-${bounds.high.toFixed(5)}]`,
      });
    }
  }

  // Step 4: Check historical S/R
  rankedZones = checkHistoricalSR(
    htfCandles,
    rankedZones,
    impulse.startIndex,
    { evidenceContext: options?.evidenceContext },
  );

  // Step 5: HTF confluence scoring (if data available)
  if (htfData) {
    rankedZones = checkHTFConfluence(rankedZones, htfData, {
      evidenceContext: options?.evidenceContext,
    });
  }

  // Step 6: LTF refinement on top zones (only refine top 3 to save compute)
  const topZones = rankedZones.slice(0, 3);
  for (let i = 0; i < topZones.length; i++) {
    topZones[i] = refineLowerTF(entryCandles, topZones[i], {
      evidenceContext: options?.evidenceContext,
    });
  }
  // Replace in full array
  for (let i = 0; i < topZones.length; i++) {
    rankedZones[i] = topZones[i];
  }
  for (const zone of rankedZones) {
    zone.validationTrade = buildZoneValidationTrade(zone, impulse);
  }
  collectedRankedZones = rankedZones;

  // Step 6: Rank and select best
  const bestZonePOI = rankAndSelectBestZone(rankedZones);
  if (!bestZonePOI) {
    return finish({
      bestZone: null,
      impulse,
      allZones: rankedZones,
      reason: `Zones found but none scored high enough (need fibScore >= 1, i.e., at 50% or deeper)`,
    });
  }
  const minQualityScore = Math.max(0, Math.min(100, Number(options?.minQualityScore ?? 0)));
  const qualityPercent = zoneQualityPercent(bestZonePOI);
  if (qualityPercent < minQualityScore) {
    return finish({
      bestZone: null,
      impulse,
      allZones: rankedZones,
      reason: `Best zone quality ${qualityPercent.toFixed(1)}% is below Bot Config minimum ${minQualityScore.toFixed(1)}%`,
    });
  }

  // Step 7: Check if current price is at the zone
  const atr = zoneATR;
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

  return finish({
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
  });
}


// ─── Options ─────────────────────────────────────────────────────────────────
/** Options to override engine constants at runtime (config-driven). */
export interface ZoneEngineOptions {
  /**
   * Attach an observation-only snapshot of the exact legs, POIs and ranked
   * candidates traversed by this invocation. Defaults off.
   */
  collectEvidence?: boolean;
  /** Canonical structure is compared in observe mode and owns impulse selection only in enforce mode. */
  structureAuthorityMode?: "observe" | "enforce";
  /** ATR multiplier for strict proximity check (market fill). Default: 0.3 */
  strictATRMult?: number;
  /** Minimum normalized zone score (0-100). 0 disables this filter. */
  minQualityScore?: number;
  /** Maximum POI age in structural-timeframe bars. 0 disables this filter. */
  maxAgeBars?: number;
  /** Minimum OB candle body/range ratio (0-1). 0 disables this filter. */
  minBodyRatio?: number;
  /** Minimum displacement candle range as an ATR multiple. 0 disables this filter. */
  minDisplacementATR?: number;
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
  /** Observe-only identity context. It never participates in scoring or gates. */
  evidenceContext?: ZoneEvidenceContext;
  /**
   * Zone Lifecycle v2: When enabled, replaces the default 50% penetration invalidation
   * with close-based invalidation. Zones survive wick penetration and can be traded
   * multiple times with decreasing confidence.
   * When null/undefined, uses the default state-based filter (broken/mitigated = skip).
   */
  zoneLifecycleV2?: {
    enabled: boolean;
    config?: Partial<ZoneLifecycleConfig>;
    /** All candles available AFTER zone formation for lifecycle evaluation */
    allCandles?: Candle[];
  };
}

export interface ZoneEvidenceContext {
  symbol: string;
  timeframe: string;
  observedAt?: string;
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
  const optionsFor = (timeframe: string): ZoneEngineOptions | undefined => {
    if (!options || !options.evidenceContext) return options;
    return {
      ...options,
      evidenceContext: { ...options.evidenceContext, timeframe },
    };
  };
  // ── WATERFALL: Try Daily first (A+ setup) ──
  let dailyResult: ZoneEngineResult | null = null;
  if (dailyCandles && dailyCandles.length >= 20) {
    dailyResult = findBestEntryZone(dailyCandles, entryCandles, direction, currentPrice, htfData, optionsFor(labels.top));
    // If Daily produces a valid zone, it wins immediately (highest conviction)
    if (dailyResult.bestZone) {
      const allZones: RankedPOI[] = [...dailyResult.allZones];
      return {
        bestZone: dailyResult.bestZone,
        selectedTF: labels.top,
        reason: `${labels.top} zone selected (A+ setup): ${dailyResult.reason}`,
        h1Result: findBestEntryZone(h1Candles, entryCandles, direction, currentPrice, htfData, optionsFor(labels.low)),
        h4Result: h4Candles.length >= 20 ? findBestEntryZone(h4Candles, entryCandles, direction, currentPrice, htfData, optionsFor(labels.mid)) : null,
        dailyResult,
        allZones,
      };
    }
  }

  // ── FALLBACK: Run 1H and 4H (existing logic) ──
  // Always run 1H
  const h1Result = findBestEntryZone(h1Candles, entryCandles, direction, currentPrice, htfData, optionsFor(labels.low));

  // Run 4H only if sufficient candles
  let h4Result: ZoneEngineResult | null = null;
  if (h4Candles.length >= 20) {
    h4Result = findBestEntryZone(h4Candles, entryCandles, direction, currentPrice, htfData, optionsFor(labels.mid));
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
