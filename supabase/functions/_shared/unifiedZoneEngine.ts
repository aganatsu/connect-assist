/**
 * unifiedZoneEngine.ts — Unified Impulse Zone Engine
 * ───────────────────────────────────────────────────
 * Single entry point that composes:
 *   - Impulse Zone Engine (zone detection across D/4H/1H)
 *   - Zone Liquidity (BSL/SSL near zone, sweep detection)
 *   - Confirmation Hierarchy (sweep+CHoCH, displacement, inducement)
 *
 * Returns a story-driven result that tells the full narrative:
 *   Daily Impulse → Zone → Price → Liquidity → Confirmation → Entry
 *
 * Key principles:
 *   - Entry direction = impulse direction (continuation, not reversal)
 *   - Daily always wins when available (highest conviction)
 *   - One zone, one story, one score
 *   - "Don't catch a falling knife" — never trade against the impulse
 */

import { type Candle, type LiquidityPool, calculateATR } from "./smcAnalysis.ts";
import {
  findBestEntryZoneMultiTF,
  type MultiTFZoneResult,
  type HTFConfluenceData,
  type ZoneEngineOptions,
  type ImpulseLeg,
  type RankedPOI,
  type BestZone,
  type TFSlotLabels,
  DEFAULT_TF_LABELS,
} from "./impulseZoneEngine.ts";
import { findZoneLiquidity, type ZoneLiquidityResult } from "./zoneLiquidity.ts";
import { evaluateConfirmation, type ConfirmationResult, type ConfirmationInput } from "./confirmationHierarchy.ts";
import { buildConceptEvidence } from "./conceptEvidence.ts";
import { observeZoneLocalPoint } from "./zoneLocalConfluence.ts";
import { rankZoneCandidatesShadow } from "./zoneCandidateShadowRanking.ts";
import {
  classifyZoneCandidateLifecycle,
  rankZoneCandidateModels,
} from "./zoneCandidateModel.ts";
import { buildCrossTimeframeZoneLineage } from "./crossTimeframeZoneLineage.ts";
import {
  selectICTEntryZone,
  type ICTEntryZoneComponent,
  type ICTEntryZoneSelection,
} from "./ictEntryZoneAuthority.ts";

// ─── Types ───────────────────────────────────────────────────────────

/** The full story-driven result from the unified engine */
export interface UnifiedZoneResult {
  /** Type-neutral OB/FVG/Breaker comparison; observation-only until certified. */
  candidateAuthorityObservation?: ICTEntryZoneSelection;
  /** Whether a valid zone was found */
  hasZone: boolean;

  /** Which timeframe produced the winning zone */
  selectedTF: string | null;

  /** The impulse leg that created the zone */
  impulse: ImpulseStory | null;

  /** The zone details */
  zone: ZoneStory | null;

  /** Price proximity to the zone */
  price: PriceStory;

  /** Liquidity context near the zone */
  liquidity: ZoneLiquidityResult | null;

  /** Confirmation status */
  confirmation: ConfirmationResult | null;

  /** Entry details (only when confirmation is ready) */
  entry: EntryStory | null;

  /** Unified score (out of 14) */
  unifiedScore: number;

  /** Score breakdown */
  scoreBreakdown: ScoreBreakdown;

  /** Human-readable story summary */
  storySummary: string;

  /** The underlying multi-TF result (for backward compatibility) */
  multiTFResult: MultiTFZoneResult;

  /** Overall state of the setup */
  state: UnifiedState;

  /** Reason string */
  reason: string;
}

export type UnifiedState =
  | "no_impulse"          // No valid impulse found on any TF
  | "no_zone"            // Impulse exists but no valid zone
  | "watching"           // Zone found, price not there yet (watchlist)
  | "at_zone"            // Price within the loose awareness radius, waiting for confirmation
  | "confirmed"          // Confirmation fired, entry ready
  | "triggered"          // Price at entry level — execute
  | "waiting_for_sweep"  // Qualified local/internal trigger exists but is unswept
  | "waiting_for_reconfirmation"; // Trigger was swept without rejection

export interface ImpulseStory {
  direction: "bullish" | "bearish";
  breakType: "bos" | "choch" | null;
  high: number;
  low: number;
  pips: number;
  timeframe: string;
  startDate: string | null;
  endDate: string | null;
  breakDate: string | null;
  extendedBeyondBreak: boolean;
  spanBars: number;
  bosPrice: number;
  qualification: import("./impulseZoneEngine.ts").ImpulseQualification | null;
}

export interface ZoneStory {
  type: "OB" | "FVG";
  high: number;
  low: number;
  fibLevel: number;
  fibLabel: string;
  srConfirmed: boolean;
  srLevel?: number;
  htfLayers: string[];
  ltfRefined: boolean;
  totalScore: number;
  zonesFound: number;
}

export interface PriceStory {
  currentPrice: number;
  atZone: boolean;
  atZoneStrict: boolean;
  insideZone: boolean;
  distancePips: number;
  sideOk: boolean;
}

export interface EntryStory {
  direction: "long" | "short";
  entryPrice: number;
  slPrice: number;
  tpPrice: number | null;
  riskPips: number;
  rewardPips: number | null;
  rrRatio: number | null;
}

export interface ScoreBreakdown {
  /** Base zone score from impulse zone engine (out of 9) */
  baseScore: number;
  /** Liquidity bonus (0 to 3.0) */
  liquidityBonus: number;
  /** Confirmation bonus (0 to 2.5) */
  confirmationBonus: number;
  /** Timeframe bonus: Daily +2.0, 4H +1.0, 1H +0 */
  tfBonus: number;
  /** Total unified score (out of ~14) */
  total: number;
}

// ─── Configuration ──────────────────────────────────────────────────

export interface UnifiedZoneConfig {
  /** Minimum R:R ratio for entry. Default: 2.0 */
  minRR: number;
  /** Whether to require confirmation for entry (vs watchlist). Default: true */
  requireConfirmation: boolean;
  /** Liquidity Sweep Gate: when true, block entry until entry-trigger pool is swept+rejected. Default: false */
  requireLiquiditySweep: boolean;
  /** Penalty for swept_absorbed entry-trigger pools. Default: 2.0 */
  sweptAbsorbedPenalty: number;
  /**
   * Minimum stop distance in pips. The entry stop is derived from zone width,
   * so a narrow zone would otherwise produce a stop smaller than the spread —
   * and, because R:R is reward/risk, a spuriously enormous R:R that sails
   * through the minimum-R:R gate. Callers pass max(MIN_SL_PIPS[symbol],
   * ATR × ATR_SL_FLOOR_MULTIPLIER). Default 0 keeps the legacy behaviour.
   */
  minStopPips: number;
}

export const DEFAULT_UNIFIED_CONFIG: UnifiedZoneConfig = {
  minRR: 2.0,
  requireConfirmation: true,
  requireLiquiditySweep: false,
  sweptAbsorbedPenalty: 2.0,
  minStopPips: 0,
};

// ─── Core Function ──────────────────────────────────────────────────

/**
 * findUnifiedZone — The single entry point for zone detection.
 *
 * Composes impulse zone engine + liquidity + confirmation into one story.
 * Entry direction is ALWAYS the impulse direction (continuation).
 *
 * @param h1Candles - 1H candles
 * @param h4Candles - 4H candles
 * @param entryCandles - Entry TF candles (15m) for LTF refinement
 * @param direction - Impulse direction (the direction we want to CONTINUE)
 * @param currentPrice - Current market price
 * @param liquidityPools - Pre-detected liquidity pools (from detectLiquidityPools on relevant TF)
 * @param htfData - Optional HTF confluence data
 * @param options - Optional zone engine options
 * @param dailyCandles - Optional Daily candles for top-down analysis
 * @param confirmationCandles - Candles for confirmation detection (typically one TF below zone TF)
 * @param ltfConfirmationCandles - Optional LTF candles for deeper confirmation
 * @param config - Optional unified engine config
 */
export function findUnifiedZone(
  h1Candles: Candle[],
  h4Candles: Candle[],
  entryCandles: Candle[],
  direction: "bullish" | "bearish",
  currentPrice: number,
  liquidityPools: LiquidityPool[],
  htfData?: HTFConfluenceData,
  options?: ZoneEngineOptions,
  dailyCandles?: Candle[],
  confirmationCandles?: Candle[],
  ltfConfirmationCandles?: Candle[],
  config?: Partial<UnifiedZoneConfig>,
  tfLabels?: TFSlotLabels,
): UnifiedZoneResult {
  const cfg = { ...DEFAULT_UNIFIED_CONFIG, ...config };
  const labels = tfLabels ?? DEFAULT_TF_LABELS;

  // ── Step 1: Find the best zone (waterfall: top → mid → low TF) ──
  const multiTFResult = findBestEntryZoneMultiTF(
    h1Candles, h4Candles, entryCandles, direction, currentPrice, htfData, options, dailyCandles, labels,
  );
  const annotateCandidateLifecycle = (
    result: typeof multiTFResult.h1Result | null | undefined,
    sourceCandles: Candle[],
  ) => {
    if (!result?.evidence) return;
    for (const candidate of result.allZones) {
      candidate.candidateLifecycle = classifyZoneCandidateLifecycle({
        zone: {
          low: candidate.poi.low,
          high: candidate.poi.high,
          direction: candidate.poi.direction,
        },
        candlesAfterFormation: sourceCandles.slice(
          candidate.poi.candleIndex + 1,
        ),
      });
      candidate.canonicalImpulseMetrics =
        result.evidence.canonicalImpulse?.metrics ?? null;
    }
  };
  annotateCandidateLifecycle(multiTFResult.h1Result, h1Candles);
  annotateCandidateLifecycle(multiTFResult.h4Result, h4Candles);
  annotateCandidateLifecycle(multiTFResult.dailyResult, dailyCandles ?? []);
  annotateZoneLiquidityObservations({
    multiTFResult,
    h1Candles,
    h4Candles,
    dailyCandles,
    labels,
    direction,
    liquidityPools,
    sweptAbsorbedPenalty: cfg.sweptAbsorbedPenalty,
  });
  const shadowRankings = rankZoneCandidatesShadow(
    multiTFResult.allZones.map((candidate) => ({
      candidateId: candidate.localConfluence?.candidateId ||
        candidate.poi.evidence?.entityId ||
        `${candidate.poi.type}:${candidate.poi.low}:${candidate.poi.high}`,
      legacyZoneScore: candidate.totalScore,
      fibDepth: candidate.fibDepth,
      localConfluence: candidate.localConfluence,
    })),
  );
  for (const candidate of multiTFResult.allZones) {
    const candidateId = candidate.localConfluence?.candidateId ||
      candidate.poi.evidence?.entityId ||
      `${candidate.poi.type}:${candidate.poi.low}:${candidate.poi.high}`;
    candidate.shadowRanking = shadowRankings.get(candidateId);
  }
  const candidateModels = rankZoneCandidateModels(
    multiTFResult.allZones
      .filter((candidate) => candidate.candidateLifecycle)
      .map((candidate) => {
        const candidateId = candidate.localConfluence?.candidateId ||
          candidate.poi.evidence?.entityId ||
          `${candidate.poi.type}:${candidate.poi.low}:${candidate.poi.high}`;
        const liquiditySweepQualified =
          candidate.localConfluence?.items.some((item) =>
            item.source === "liquidity_pool" &&
            item.qualification?.qualified === true &&
            item.attributes.relevance === "entry_trigger"
          ) === true;
        return {
          candidateId,
          zone: {
            low: candidate.poi.low,
            high: candidate.poi.high,
            direction: candidate.poi.direction,
          },
          currentPrice,
          atr: candidate.localConfluence?.atr ?? 0,
          localConfluenceScore:
            candidate.shadowRanking?.shadowLocalScore ?? 0,
          liquiditySweepQualified,
          impulseSweepOrigin:
            candidate.canonicalImpulseMetrics?.sweepOrigin === true,
          lifecycle: candidate.candidateLifecycle!,
          displacementPercentile:
            candidate.canonicalImpulseMetrics?.displacementPercentile ?? null,
          htfLayerCount: candidate.htfLayers.length,
          fibScore: candidate.fibScore,
          fibDepth: candidate.fibDepth,
        };
      }),
  );
  for (const candidate of multiTFResult.allZones) {
    const candidateId = candidate.localConfluence?.candidateId ||
      candidate.poi.evidence?.entityId ||
      `${candidate.poi.type}:${candidate.poi.low}:${candidate.poi.high}`;
    candidate.candidateModel = candidateModels.get(candidateId);
  }
  if (options?.collectEvidence) {
    const lineage = buildCrossTimeframeZoneLineage({
      hierarchy: labels,
      candidates: multiTFResult.allZones.map((candidate) => ({
        candidateId: candidate.localConfluence?.candidateId ||
          candidate.poi.evidence?.entityId ||
          `${candidate.poi.type}:${candidate.poi.low}:${candidate.poi.high}`,
        timeframe: candidate.poi.evidence?.timeframe ||
          candidate.localConfluence?.items[0]?.evidence?.timeframe ||
          "unknown",
        direction: candidate.poi.direction,
        low: candidate.poi.low,
        high: candidate.poi.high,
        atr: candidate.localConfluence?.atr ?? 0,
      })),
    });
    for (const candidate of multiTFResult.allZones) {
      const candidateId = candidate.localConfluence?.candidateId ||
        candidate.poi.evidence?.entityId ||
        `${candidate.poi.type}:${candidate.poi.low}:${candidate.poi.high}`;
      candidate.timeframeLineage = lineage.get(candidateId);
    }
  }

  const candidateAuthorityObservation = buildCandidateAuthorityObservation({
    multiTFResult, htfData, h4Candles, labels, direction,
  });

  // No zone found
  if (!multiTFResult.bestZone) {
    return {
      ...buildNoZoneResult(multiTFResult, direction, currentPrice, options?.pipSize ?? 0.0001, labels),
      candidateAuthorityObservation,
    };
  }

  const bestZone = multiTFResult.bestZone;
  const selectedTF = multiTFResult.selectedTF!;
  const impulse = bestZone.impulse;
  const zonePOI = bestZone.zone;
  const selectedZoneResult = selectedTF === labels.top
    ? multiTFResult.dailyResult
    : selectedTF === labels.mid ? multiTFResult.h4Result : multiTFResult.h1Result;

  // ── Step 2: Build impulse story ──
  const pipSize = options?.pipSize ?? 0.0001;
  const impulsePips = Math.abs(impulse.high - impulse.low) / pipSize;
  const impulseStory: ImpulseStory = {
    direction: impulse.direction,
    breakType: impulse.breakType ?? null,
    high: impulse.high,
    low: impulse.low,
    pips: Math.round(impulsePips * 10) / 10,
    timeframe: impulse.timeframe ?? selectedTF,
    startDate: impulse.startDate ?? null,
    endDate: impulse.endDate ?? null,
    breakDate: impulse.breakDate ?? null,
    extendedBeyondBreak: impulse.extendedBeyondBreak === true,
    spanBars: impulse.spanBars ?? 0,
    bosPrice: impulse.bosPrice,
    qualification: selectedZoneResult?.impulseQualification ?? null,
  };

  // ── Step 3: Build zone story ──
  const zoneStory: ZoneStory = {
    type: zonePOI.poi.type === "ob" ? "OB" : "FVG",
    high: zonePOI.poi.high,
    low: zonePOI.poi.low,
    fibLevel: zonePOI.fibLevel,
    fibLabel: `${(zonePOI.fibLevel * 100).toFixed(1)}%`,
    srConfirmed: zonePOI.srConfirmed,
    srLevel: zonePOI.srLevel,
    htfLayers: zonePOI.htfLayers,
    ltfRefined: zonePOI.ltfRefined,
    totalScore: zonePOI.totalScore,
    zonesFound: multiTFResult.allZones.length,
  };

  // ── Step 4: Build price story ──
  const priceStory: PriceStory = {
    currentPrice,
    atZone: bestZone.priceAtZone,
    atZoneStrict: bestZone.priceAtZoneStrict,
    insideZone: bestZone.priceInsideZone,
    distancePips: bestZone.distancePips,
    sideOk: bestZone.sideOk,
  };

  // ── Step 5: Liquidity detection ──
  let liquidity: ZoneLiquidityResult | null = null;
  if (liquidityPools.length > 0) {
    liquidity = findZoneLiquidity(
      // Use the candles from the zone's timeframe for ATR context
      selectedTF === labels.top ? (dailyCandles ?? h4Candles) : selectedTF === labels.mid ? h4Candles : h1Candles,
      zonePOI.poi.high,
      zonePOI.poi.low,
      direction,
      liquidityPools,
      { sweptAbsorbedPenalty: cfg.sweptAbsorbedPenalty },
    );
  }

  // ── Step 6: Confirmation detection ──
  let confirmation: ConfirmationResult | null = null;
  if (confirmationCandles && confirmationCandles.length >= 15) {
    const confInput: ConfirmationInput = {
      confirmationCandles,
      ltfCandles: ltfConfirmationCandles,
      zoneHigh: zonePOI.poi.high,
      zoneLow: zonePOI.poi.low,
      direction,
      sweepEvent: liquidity?.sweepEvent ?? null,
      inducement: liquidity?.inducement ?? null,
    };
    confirmation = evaluateConfirmation(confInput);
  }

  // ── Step 7: Calculate unified score ──
  const baseScore = zonePOI.totalScore; // Out of 9 (existing scoring)
  const liquidityBonus = liquidity?.liquidityScore ?? 0;
  const confirmationBonus = confirmation?.score ?? 0;
  // TF bonus based on slot position: top slot = 2.0, mid = 1.0, low = 0
  const tfBonus = selectedTF === labels.top ? 2.0 : selectedTF === labels.mid ? 1.0 : 0;
  const totalScore = baseScore + liquidityBonus + confirmationBonus + tfBonus;

  const scoreBreakdown: ScoreBreakdown = {
    baseScore,
    liquidityBonus,
    confirmationBonus,
    tfBonus,
    total: Math.round(totalScore * 10) / 10,
  };

  // ── Step 8: Determine state ──
  let state: UnifiedState;
  if (!bestZone.priceAtZone) {
    state = "watching";
  } else if (!confirmation || !confirmation.entryReady) {
    state = cfg.requireConfirmation ? "at_zone" : "confirmed";
  } else {
    state = bestZone.priceAtZoneStrict ? "triggered" : "confirmed";
  }

  // ── Step 8b: Liquidity Sweep Gate (optional) ──
  // When requireLiquiditySweep is ON, override state if entry-trigger pool is unswept or absorbed.
  // This gate only applies when the setup would otherwise proceed (at_zone/confirmed/triggered).
  if (cfg.requireLiquiditySweep && liquidity) {
    if (liquidity.entryTriggerState === "swept_absorbed") {
      // The sweep did not reject. Preserve the zone, but require a fresh
      // local trigger and directional confirmation before allowing entry.
      state = "waiting_for_reconfirmation";
    } else if (liquidity.hasUnsweptEntryTrigger &&
               (state === "at_zone" || state === "confirmed" || state === "triggered")) {
      // Entry-trigger pool exists but hasn't been swept yet — wait for sweep
      state = "waiting_for_sweep";
    }
  }

  // ── Step 9: Build entry story (only when confirmed) ──
  let entry: EntryStory | null = null;
  if (state === "confirmed" || state === "triggered") {
    entry = buildEntryStory(direction, zonePOI, impulse, currentPrice, 1 / pipSize, cfg.minRR, cfg.minStopPips);
  }

  // ── Step 10: Build story summary ──
  const storySummary = buildStorySummary(
    impulseStory, zoneStory, priceStory, liquidity, confirmation, entry, selectedTF, state,
  );

  return {
    hasZone: true,
    selectedTF,
    impulse: impulseStory,
    zone: zoneStory,
    price: priceStory,
    liquidity,
    confirmation,
    entry,
    unifiedScore: scoreBreakdown.total,
    scoreBreakdown,
    storySummary,
    multiTFResult,
    state,
    reason: multiTFResult.reason,
    candidateAuthorityObservation,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function buildCandidateAuthorityObservation(input: {
  multiTFResult: MultiTFZoneResult;
  htfData?: HTFConfluenceData;
  h4Candles: Candle[];
  labels: TFSlotLabels;
  direction: "bullish" | "bearish";
}): ICTEntryZoneSelection {
  const resultForTimeframe = (timeframe: string) =>
    timeframe === input.labels.top
      ? input.multiTFResult.dailyResult
      : timeframe === input.labels.mid
      ? input.multiTFResult.h4Result
      : input.multiTFResult.h1Result;
  const components: ICTEntryZoneComponent[] = input.multiTFResult.allZones
    .filter((candidate) => candidate.candidateLifecycle)
    .map((candidate) => {
      const timeframe = candidate.poi.evidence?.timeframe ||
        candidate.timeframeLineage?.candidateTimeframe || input.labels.low;
      const impulse = resultForTimeframe(timeframe)?.impulse;
      const id = candidate.localConfluence?.candidateId ||
        candidate.poi.evidence?.entityId ||
        `${candidate.poi.type}:${candidate.poi.low}:${candidate.poi.high}`;
      return {
        id,
        type: candidate.poi.type,
        direction: candidate.poi.direction,
        low: candidate.poi.low,
        high: candidate.poi.high,
        timeframe,
        impulseId: impulse
          ? `${timeframe}:${impulse.startIndex}:${impulse.endIndex}:${impulse.direction}`
          : `${timeframe}:unknown:${candidate.poi.direction}`,
        lifecycle: candidate.candidateLifecycle!,
        fibDepth: candidate.fibDepth,
        valueLocationScore: candidate.fibScore,
        displacementScore:
          candidate.candidateModel?.factors.displacementQuality ?? 0,
        liquidityScore: candidate.candidateModel?.factors.sweepQuality ?? 0,
        htfLineageScore:
          candidate.candidateModel?.factors.structuralImportance ?? 0,
        historicalSRScore: candidate.srConfirmed ? 1 : 0,
        proximityScore:
          candidate.candidateModel?.factors.proximityToCurrentPrice ?? 0,
        validationTrade: candidate.validationTrade
          ? {
            entryPrice: candidate.validationTrade.entryPrice,
            stopLoss: candidate.validationTrade.stopLoss,
            takeProfit: candidate.validationTrade.takeProfit,
          }
          : undefined,
      };
    });

  const h4Impulse = input.multiTFResult.h4Result?.impulse;
  for (const breaker of input.htfData?.h4Breakers || []) {
    const breakerDirection = breaker.type === "bullish_breaker"
      ? "bullish"
      : "bearish";
    if (
      breaker.subtype !== "breaker" || breakerDirection !== input.direction ||
      breaker.state === "broken" || !h4Impulse
    ) continue;
    components.push({
      id: `breaker:4H:${breaker.mitigatedAt}:${breaker.low}:${breaker.high}`,
      type: "breaker",
      direction: breakerDirection,
      low: breaker.low,
      high: breaker.high,
      timeframe: input.labels.mid,
      impulseId:
        `${input.labels.mid}:${h4Impulse.startIndex}:${h4Impulse.endIndex}:${h4Impulse.direction}`,
      lifecycle: classifyZoneCandidateLifecycle({
        zone: { low: breaker.low, high: breaker.high, direction: breakerDirection },
        candlesAfterFormation: input.h4Candles.slice(breaker.mitigatedAt + 1),
      }),
      fibDepth: 0,
      valueLocationScore: 0,
      displacementScore: 0,
      liquidityScore: 0,
      htfLineageScore: 1,
      historicalSRScore: 0,
      proximityScore: 0,
      validationTrade: {
        entryPrice: breakerDirection === "bullish" ? breaker.low : breaker.high,
        stopLoss: breakerDirection === "bullish"
          ? breaker.low - (breaker.high - breaker.low) * 0.5
          : breaker.high + (breaker.high - breaker.low) * 0.5,
        takeProfit: h4Impulse.bosPrice,
      },
    });
  }
  return selectICTEntryZone(components);
}

function annotateZoneLiquidityObservations(input: {
  multiTFResult: MultiTFZoneResult;
  h1Candles: Candle[];
  h4Candles: Candle[];
  dailyCandles?: Candle[];
  labels: TFSlotLabels;
  direction: "bullish" | "bearish";
  liquidityPools: LiquidityPool[];
  sweptAbsorbedPenalty: number;
}): void {
  if (input.liquidityPools.length === 0) return;

  for (const candidate of input.multiTFResult.allZones) {
    const local = candidate.localConfluence;
    const source = candidate.poi.evidence;
    if (!local || !source) continue;
    const timeframe = source.timeframe;
    const candles = timeframe === input.labels.top
      ? (input.dailyCandles ?? input.h4Candles)
      : timeframe === input.labels.mid
      ? input.h4Candles
      : input.h1Candles;
    if (candles.length === 0) continue;

    const result = findZoneLiquidity(
      candles,
      candidate.poi.high,
      candidate.poi.low,
      input.direction,
      input.liquidityPools,
      { sweptAbsorbedPenalty: input.sweptAbsorbedPenalty },
    );
    const creditedTrigger = result.nearbyPools.find((pool) =>
      pool.relevance === "entry_trigger"
    );
    for (const nearby of result.nearbyPools) {
      const pool = nearby.pool;
      const evidence = buildConceptEvidence({
        concept: "liquidity_pool",
        detector: { name: "smcAnalysis.detectLiquidityPools", version: "1" },
        symbol: source.symbol,
        timeframe: "mixed_htf",
        sourceCandleStart: pool.datetime,
        observedAt: source.observedAt,
        direction: "neutral",
        level: pool.price,
        lifecycle: pool.state,
        discriminator: `${pool.type}:${pool.strength}`,
        attributes: {
          type: pool.type,
          strength: pool.strength,
          swept: pool.swept,
          relevance: nearby.relevance,
          legacyNearbyAtrMultiple: 1.5,
          legacyZoneLiquidityScore: result.liquidityScore,
        },
      });
      local.items.push(observeZoneLocalPoint({
        source: "liquidity_pool",
        label: `${pool.type === "buy-side" ? "BSL" : "SSL"} ${
          nearby.relevance
        }`,
        evidence,
        candidate: local,
        level: pool.price,
        legacyScoreContribution: nearby === creditedTrigger ? 1 : 0,
        attributes: {
          relevance: nearby.relevance,
          legacyDistanceToZone: nearby.distanceToZone,
          legacyLiquidityScoreTotal: result.liquidityScore,
          entryTriggerState: result.entryTriggerState,
        },
      }));
    }
  }
}

function buildNoZoneResult(
  multiTFResult: MultiTFZoneResult,
  direction: "bullish" | "bearish",
  currentPrice: number,
  pipSize: number,
  labels: TFSlotLabels,
): UnifiedZoneResult {
  const developing = [
    { result: multiTFResult.dailyResult, timeframe: labels.top },
    { result: multiTFResult.h4Result, timeframe: labels.mid },
    { result: multiTFResult.h1Result, timeframe: labels.low },
  ].find((candidate) => candidate.result?.impulse && candidate.result.impulseQualification);
  const leg = developing?.result?.impulse ?? null;
  const qualification = developing?.result?.impulseQualification ?? null;
  const impulse: ImpulseStory | null = leg ? {
    direction: leg.direction, breakType: leg.breakType ?? null,
    high: leg.high, low: leg.low,
    pips: Math.round((Math.abs(leg.high - leg.low) / pipSize) * 10) / 10,
    timeframe: developing?.timeframe ?? leg.timeframe ?? "unknown",
    startDate: leg.startDate ?? null, endDate: leg.endDate ?? null,
    breakDate: leg.breakDate ?? null,
    extendedBeyondBreak: leg.extendedBeyondBreak === true,
    spanBars: leg.spanBars ?? 0, bosPrice: leg.bosPrice, qualification,
  } : null;
  return {
    hasZone: false,
    selectedTF: developing?.timeframe ?? null,
    impulse,
    zone: null,
    price: { currentPrice, atZone: false, atZoneStrict: false, insideZone: false, distancePips: 0, sideOk: false },
    liquidity: null,
    confirmation: null,
    entry: null,
    unifiedScore: 0,
    scoreBreakdown: { baseScore: 0, liquidityBonus: 0, confirmationBonus: 0, tfBonus: 0, total: 0 },
    storySummary: qualification
      ? `${qualification.state === "forming"
        ? "Structural leg is still forming"
        : qualification.state === "completed_unqualified"
        ? "Completed structural leg did not qualify"
        : qualification.state === "stale"
        ? "Structural leg is stale"
        : qualification.state === "invalidated"
        ? "Invalidated structural leg"
        : "Qualified structural leg has no executable entry zone"}: ${qualification.reasons.join("; ")}`
      : `No valid ${direction} structural leg found on any timeframe.`,
    multiTFResult,
    state: impulse ? "no_zone" : "no_impulse",
    reason: multiTFResult.reason,
  };
}

function buildEntryStory(
  direction: "bullish" | "bearish",
  zonePOI: RankedPOI,
  impulse: ImpulseLeg,
  currentPrice: number,
  pipMult: number,
  minRR: number,
  minStopPips = 0,
): EntryStory | null {
  const entryDirection: "long" | "short" = direction === "bullish" ? "long" : "short";

  // Entry: edge of zone closest to current price (continuation entry)
  // For bearish continuation: price retraces UP to zone, entry at zone HIGH (sell limit)
  // For bullish continuation: price retraces DOWN to zone, entry at zone LOW (buy limit)
  let entryPrice: number;
  let slPrice: number;

  if (direction === "bearish") {
    // Sell at zone high, SL above zone
    entryPrice = zonePOI.poi.high;
    slPrice = zonePOI.poi.high + (zonePOI.poi.high - zonePOI.poi.low) * 0.5;
  } else {
    // Buy at zone low, SL below zone
    entryPrice = zonePOI.poi.low;
    slPrice = zonePOI.poi.low - (zonePOI.poi.high - zonePOI.poi.low) * 0.5;
  }

  // ── Minimum stop distance ──
  // The stop above is half the zone's height, so a narrow zone yields a stop
  // smaller than the spread. Because R:R is reward/risk, that also inflates R:R
  // — the tighter (worse) the stop, the better the setup scores, and the more
  // easily it clears the minimum-R:R gate. Observed live: a 3.1-pip zone on
  // GBP/CHF produced a 1.55-pip stop and a "15.29:1" R:R on a pair whose spread
  // alone is 2-3 pips.
  const minStop = minStopPips > 0 ? minStopPips / pipMult : 0;
  if (minStop > 0 && Math.abs(entryPrice - slPrice) < minStop) {
    slPrice = direction === "bearish" ? entryPrice + minStop : entryPrice - minStop;
  }

  // ── Stop must still fit inside the impulse ──
  // The stop belongs at the impulse origin at the very furthest; beyond that the
  // premise is void. If the floored stop does not fit, the impulse is simply too
  // small to support a tradeable stop on this instrument, so there is no valid
  // entry — capping to the origin here would silently re-introduce the tiny stop.
  if (direction === "bearish") {
    if (slPrice > impulse.high) {
      if (minStop > 0 && Math.abs(entryPrice - impulse.high) < minStop) return null;
      slPrice = impulse.high;
    }
  } else {
    if (slPrice < impulse.low) {
      if (minStop > 0 && Math.abs(entryPrice - impulse.low) < minStop) return null;
      slPrice = impulse.low;
    }
  }

  const riskPips = Math.abs(entryPrice - slPrice) * pipMult;

  // TP: BOS level (the level where the impulse broke structure)
  // For bearish: target is the low of the impulse (BOS level)
  // For bullish: target is the high of the impulse (BOS level)
  const tpPrice = impulse.bosPrice;
  const rewardPips = tpPrice ? Math.abs(entryPrice - tpPrice) * pipMult : null;
  const rrRatio = (rewardPips && riskPips > 0) ? Math.round((rewardPips / riskPips) * 100) / 100 : null;

  // A zero-distance stop is not a trade. When riskPips is 0 the ratio above is
  // null, so the minimum-R:R check below never fires — the setup is waved
  // through because its R:R is *absent* rather than *low*. Observed live: five
  // placed trades had slPrice exactly equal to entryPrice (EUR/AUD, CAD/JPY,
  // GBP/CAD, USD/CAD ×2), all with rrRatio null.
  if (!(riskPips > 0)) {
    return null; // no stop distance — nothing to risk, nothing to size
  }

  // Check minimum R:R
  if (rrRatio !== null && rrRatio < minRR) {
    return null; // R:R too low
  }

  return {
    direction: entryDirection,
    entryPrice,
    slPrice,
    tpPrice,
    riskPips: Math.round(riskPips * 10) / 10,
    rewardPips: rewardPips ? Math.round(rewardPips * 10) / 10 : null,
    rrRatio,
  };
}

function buildStorySummary(
  impulse: ImpulseStory,
  zone: ZoneStory,
  price: PriceStory,
  liquidity: ZoneLiquidityResult | null,
  confirmation: ConfirmationResult | null,
  entry: EntryStory | null,
  selectedTF: string,
  state: UnifiedState,
): string {
  const lines: string[] = [];
  const dir = impulse.direction === "bearish" ? "↓ BEARISH" : "↑ BULLISH";
  const filled = "●";
  const empty = "○";

  // Line 1: Impulse
  const impulseStart = impulse.direction === "bearish" ? impulse.high : impulse.low;
  const impulseEnd = impulse.direction === "bearish" ? impulse.low : impulse.high;
  lines.push(`${filled} ${selectedTF} Impulse: ${dir} ${impulseStart.toFixed(5)} → ${impulseEnd.toFixed(5)} (${impulse.pips} pips)`);
  if (impulse.startDate && impulse.endDate) {
    const structureLabel = impulse.breakType === "choch" ? "CHoCH" : "BOS";
    lines.push(`    ${structureLabel}: ${impulse.bosPrice.toFixed(5)}  ${impulse.startDate} → ${impulse.endDate} (${impulse.spanBars} bars)`);
  }

  // Line 2: Zone
  const srTag = zone.srConfirmed ? "S/R ✓" : "S/R ✗";
  lines.push(`${filled} Zone: ${zone.type} @ Fib ${zone.fibLabel} (${srTag}) [${zone.low.toFixed(5)}–${zone.high.toFixed(5)}]`);

  // Line 3: Price
  if (price.atZone || price.insideZone) {
    lines.push(`${filled} Price: ${price.insideZone ? "Inside zone" : "Near zone"}`);
  } else {
    lines.push(`${empty} Price: ${price.distancePips.toFixed(1)} pips away`);
  }

  // Line 4: Liquidity
  if (liquidity?.entryTriggerState === "swept_rejected") {
    lines.push(`${filled} Liquidity: ${liquidity.gateReason}`);
  } else if (
    liquidity?.entryTriggerState === "unswept" ||
    liquidity?.entryTriggerState === "swept_absorbed"
  ) {
    lines.push(`◐ Liquidity: ${liquidity.gateReason}`);
  } else if (liquidity) {
    lines.push(`${empty} Liquidity: ${liquidity.gateReason}`);
  } else {
    lines.push(`${empty} Liquidity: No significant pools near zone`);
  }

  // Line 5: Confirmation
  if (confirmation && confirmation.entryReady) {
    lines.push(`${filled} Confirmation: ${confirmation.detail}`);
  } else if (confirmation && confirmation.score > 0) {
    lines.push(`◐ Confirmation: ${confirmation.detail} (partial)`);
  } else {
    lines.push(`${empty} Confirmation: Waiting for CHoCH/displacement in ${impulse.direction} direction`);
  }

  // Line 6: Entry
  if (entry) {
    lines.push(`${filled} Entry: ${entry.direction.toUpperCase()} @ ${entry.entryPrice.toFixed(5)}  SL: ${entry.slPrice.toFixed(5)}  R:R ${entry.rrRatio}:1`);
  } else if (state === "waiting_for_sweep") {
    lines.push(`${empty} Entry: Waiting for qualified local/internal liquidity sweep`);
  } else if (state === "waiting_for_reconfirmation") {
    lines.push(`${empty} Entry: Sweep did not reject — waiting for a fresh trigger and confirmation`);
  } else if (state === "confirmed" || state === "triggered") {
    lines.push(`${empty} Entry: R:R below minimum (${DEFAULT_UNIFIED_CONFIG.minRR}:1)`);
  } else {
    lines.push(`${empty} Entry: Not yet`);
  }

  return lines.join("\n");
}
