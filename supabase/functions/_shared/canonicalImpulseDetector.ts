/**
 * Canonical impulse detector — Phase 2.
 *
 * This module is observation-only until Phase 8. It mirrors the current
 * impulse selection contract, then attaches pair/timeframe-relative
 * measurements that can be compared across scanner, replay and UI evidence.
 * No metric in this file authorizes, scores, sizes or executes a trade.
 */

import type { Candle, StructureBreak, SwingPoint } from "./smcAnalysis.ts";
import { calculateATR } from "./smcAnalysis.ts";
import { canonicalStructureForLegacyConsumers } from "./canonicalStructureAdapter.ts";

export const CANONICAL_IMPULSE_DETECTOR_VERSION = "canonical-impulse.v1";

export interface CanonicalImpulseLeg {
  high: number;
  low: number;
  direction: "bullish" | "bearish";
  startIndex: number;
  endIndex: number;
  isValid: boolean;
  bosPrice: number;
  breakType?: "bos" | "choch";
  timeframe?: string;
  startDate?: string;
  endDate?: string;
  spanBars?: number;
}

export interface CanonicalImpulseCandidate {
  leg: CanonicalImpulseLeg;
  selected: boolean;
  rejection: {
    code: "origin_broken_or_invalid";
    explanation: string;
  } | null;
}

export interface CanonicalImpulseMetrics {
  rangeAbsolute: number;
  atr: number;
  atrNormalizedSize: number | null;
  displacementPercentile: number | null;
  strongestDirectionalBodyRatio: number | null;
  bodyStrengthPercentile: number | null;
  bosOvershootAbsolute: number;
  bosSignificanceATR: number | null;
  recencyBars: number;
  sweepOrigin: boolean;
  sweptLevel: number | null;
  structureIntact: boolean;
}

export interface CanonicalImpulseDetection {
  detectorVersion: typeof CANONICAL_IMPULSE_DETECTOR_VERSION;
  timeframe: string | null;
  direction: "bullish" | "bearish";
  impulse: CanonicalImpulseLeg | null;
  candidates: CanonicalImpulseCandidate[];
  metrics: CanonicalImpulseMetrics | null;
  selectionKey: string | null;
}

function percentileRank(value: number, population: number[]): number | null {
  const valid = population.filter(Number.isFinite);
  if (!Number.isFinite(value) || valid.length === 0) return null;
  const atOrBelow = valid.filter((item) => item <= value).length;
  return Number(((atOrBelow / valid.length) * 100).toFixed(2));
}

function legKey(leg: CanonicalImpulseLeg | null): string | null {
  if (!leg) return null;
  return [
    leg.direction,
    leg.startIndex,
    leg.endIndex,
    leg.low.toFixed(10),
    leg.high.toFixed(10),
    leg.bosPrice.toFixed(10),
  ].join(":");
}

function validateCandidate(
  candles: Candle[],
  bos: StructureBreak & { breakType: "bos" | "choch" },
  direction: "bullish" | "bearish",
  swingPoints: SwingPoint[],
): {
  selected: CanonicalImpulseLeg | null;
  rejected: CanonicalImpulseCandidate[];
} {
  const originType = direction === "bullish" ? "low" : "high";
  const origins = swingPoints
    .filter((point) => point.type === originType && point.index < bos.index)
    .sort((a, b) => b.index - a.index);
  const rejected: CanonicalImpulseCandidate[] = [];

  for (const origin of origins.slice(0, 5)) {
    if (bos.index - origin.index < 3) continue;
    let high = -Infinity;
    let low = Infinity;
    for (let index = origin.index; index <= bos.index; index++) {
      high = Math.max(high, candles[index]?.high ?? -Infinity);
      low = Math.min(low, candles[index]?.low ?? Infinity);
    }
    if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) {
      continue;
    }

    const originPrice = direction === "bullish" ? low : high;
    const originBroken = candles.slice(bos.index + 1).some((candle) =>
      direction === "bullish"
        ? candle.close < originPrice
        : candle.close > originPrice
    );
    const leg: CanonicalImpulseLeg = {
      high,
      low,
      direction,
      startIndex: origin.index,
      endIndex: bos.index,
      isValid: !originBroken,
      bosPrice: bos.price,
      breakType: bos.breakType,
      startDate: candles[origin.index]?.datetime?.slice(0, 16),
      endDate: candles[bos.index]?.datetime?.slice(0, 16),
      spanBars: bos.index - origin.index,
    };
    if (!originBroken) return { selected: leg, rejected };
    rejected.push({
      leg,
      selected: false,
      rejection: {
        code: "origin_broken_or_invalid",
        explanation:
          "Impulse origin was broken by a later candle close before evaluation",
      },
    });
  }
  return { selected: null, rejected };
}

function relativeMetrics(
  candles: Candle[],
  impulse: CanonicalImpulseLeg,
): CanonicalImpulseMetrics {
  const atr = calculateATR(candles);
  const rangeAbsolute = impulse.high - impulse.low;
  const span = Math.max(
    3,
    impulse.spanBars ?? impulse.endIndex - impulse.startIndex,
  );
  const recent = candles.slice(-Math.min(candles.length, 160));
  const rollingRanges: number[] = [];
  for (let end = span - 1; end < recent.length; end++) {
    const window = recent.slice(end - span + 1, end + 1);
    rollingRanges.push(
      Math.max(...window.map((candle) => candle.high)) -
        Math.min(...window.map((candle) => candle.low)),
    );
  }

  const legCandles = candles.slice(impulse.startIndex, impulse.endIndex + 1);
  const directional = legCandles.filter((candle) =>
    impulse.direction === "bullish"
      ? candle.close > candle.open
      : candle.close < candle.open
  );
  const bodyRatios = recent.map((candle) => {
    const range = candle.high - candle.low;
    return range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
  });
  const strongestDirectionalBodyRatio = directional.length
    ? Math.max(...directional.map((candle) => {
      const range = candle.high - candle.low;
      return range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
    }))
    : null;
  const bosClose = candles[impulse.endIndex]?.close ?? impulse.bosPrice;
  const bosOvershootAbsolute = Math.abs(bosClose - impulse.bosPrice);

  const originLookback = candles.slice(
    Math.max(0, impulse.startIndex - 6),
    impulse.startIndex,
  );
  const originCandle = candles[impulse.startIndex];
  let sweepOrigin = false;
  let sweptLevel: number | null = null;
  if (originCandle && originLookback.length >= 2) {
    if (impulse.direction === "bullish") {
      sweptLevel = Math.min(...originLookback.map((candle) => candle.low));
      sweepOrigin = originCandle.low < sweptLevel &&
        originCandle.close > sweptLevel;
    } else {
      sweptLevel = Math.max(...originLookback.map((candle) => candle.high));
      sweepOrigin = originCandle.high > sweptLevel &&
        originCandle.close < sweptLevel;
    }
  }

  return {
    rangeAbsolute,
    atr,
    atrNormalizedSize: atr > 0
      ? Number((rangeAbsolute / atr).toFixed(6))
      : null,
    displacementPercentile: percentileRank(rangeAbsolute, rollingRanges),
    strongestDirectionalBodyRatio,
    bodyStrengthPercentile: strongestDirectionalBodyRatio === null
      ? null
      : percentileRank(strongestDirectionalBodyRatio, bodyRatios),
    bosOvershootAbsolute,
    bosSignificanceATR: atr > 0
      ? Number((bosOvershootAbsolute / atr).toFixed(6))
      : null,
    recencyBars: Math.max(0, candles.length - 1 - impulse.endIndex),
    sweepOrigin,
    sweptLevel,
    structureIntact: impulse.isValid,
  };
}

export function detectCanonicalImpulse(
  candles: Candle[],
  direction: "bullish" | "bearish",
  timeframe?: string,
): CanonicalImpulseDetection {
  const candidates: CanonicalImpulseCandidate[] = [];
  if (candles.length < 20) {
    return {
      detectorVersion: CANONICAL_IMPULSE_DETECTOR_VERSION,
      timeframe: timeframe ?? null,
      direction,
      impulse: null,
      candidates,
      metrics: null,
      selectionKey: null,
    };
  }

  const structure = canonicalStructureForLegacyConsumers(candles);
  const breaks = structure.breaks
    .filter((item) => item.type === direction)
    .sort((a, b) => b.index - a.index);

  for (const bos of breaks) {
    const result = validateCandidate(
      candles,
      bos,
      direction,
      structure.swings,
    );
    candidates.push(...result.rejected);
    if (result.selected) {
      result.selected.timeframe = timeframe;
      candidates.push({
        leg: result.selected,
        selected: true,
        rejection: null,
      });
      return {
        detectorVersion: CANONICAL_IMPULSE_DETECTOR_VERSION,
        timeframe: timeframe ?? null,
        direction,
        impulse: result.selected,
        candidates,
        metrics: relativeMetrics(candles, result.selected),
        selectionKey: legKey(result.selected),
      };
    }
    if (result.rejected.length === 0) {
      candidates.push({
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
          startDate: candles[bos.index]?.datetime?.slice(0, 16),
          endDate: candles[bos.index]?.datetime?.slice(0, 16),
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

  return {
    detectorVersion: CANONICAL_IMPULSE_DETECTOR_VERSION,
    timeframe: timeframe ?? null,
    direction,
    impulse: null,
    candidates,
    metrics: null,
    selectionKey: null,
  };
}

export function canonicalImpulseMatchesLegacy(
  canonical: CanonicalImpulseLeg | null,
  legacy: CanonicalImpulseLeg | null,
): boolean {
  return legKey(canonical) === legKey(legacy);
}
