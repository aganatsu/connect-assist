/**
 * Relative impulse measurements for the single Impulse Zone Engine authority.
 * This module deliberately does not select an impulse leg.
 */
import type { Candle } from "./smcAnalysis.ts";
import { calculateATR } from "./smcAnalysis.ts";

export const CANONICAL_IMPULSE_DETECTOR_VERSION = "canonical-impulse.v1";

export interface MeasurableImpulseLeg {
  high: number;
  low: number;
  direction: "bullish" | "bearish";
  startIndex: number;
  endIndex: number;
  breakIndex?: number;
  isValid: boolean;
  bosPrice: number;
  spanBars?: number;
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
  directionalCandleRatio: number | null;
  directionalBodyDominance: number | null;
  pathEfficiency: number | null;
  averageCandleOverlap: number | null;
}

function percentileRank(value: number, population: number[]): number | null {
  const valid = population.filter(Number.isFinite);
  if (!Number.isFinite(value) || valid.length === 0) return null;
  const atOrBelow = valid.filter((item) => item <= value).length;
  return Number(((atOrBelow / valid.length) * 100).toFixed(2));
}

export function measureCanonicalImpulseMetrics(
  candles: Candle[],
  impulse: MeasurableImpulseLeg,
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
  const directionalCandleRatio = legCandles.length > 0
    ? directional.length / legCandles.length
    : null;
  const signedBodies = legCandles.map((candle) =>
    impulse.direction === "bullish"
      ? candle.close - candle.open
      : candle.open - candle.close
  );
  const absoluteBodyTotal = signedBodies.reduce(
    (total, body) => total + Math.abs(body), 0,
  );
  const directionalBodyDominance = absoluteBodyTotal > 0
    ? signedBodies.reduce((total, body) => total + body, 0) / absoluteBodyTotal
    : null;
  const pathLength = legCandles.reduce(
    (total, candle) => total + Math.max(0, candle.high - candle.low), 0,
  );
  const first = legCandles[0];
  const last = legCandles.at(-1);
  const netMove = first && last ? Math.abs(last.close - first.open) : 0;
  const pathEfficiency = pathLength > 0 ? netMove / pathLength : null;
  const overlaps: number[] = [];
  for (let index = 1; index < legCandles.length; index++) {
    const previous = legCandles[index - 1];
    const current = legCandles[index];
    const overlap = Math.max(
      0,
      Math.min(previous.high, current.high) - Math.max(previous.low, current.low),
    );
    const narrowerRange = Math.min(
      previous.high - previous.low, current.high - current.low,
    );
    overlaps.push(narrowerRange > 0 ? overlap / narrowerRange : 0);
  }
  const averageCandleOverlap = overlaps.length > 0
    ? overlaps.reduce((total, value) => total + value, 0) / overlaps.length
    : null;
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
  const bosClose = candles[impulse.breakIndex ?? impulse.endIndex]?.close ?? impulse.bosPrice;
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
    directionalCandleRatio: directionalCandleRatio === null ? null : Number(directionalCandleRatio.toFixed(6)),
    directionalBodyDominance: directionalBodyDominance === null ? null : Number(directionalBodyDominance.toFixed(6)),
    pathEfficiency: pathEfficiency === null ? null : Number(pathEfficiency.toFixed(6)),
    averageCandleOverlap: averageCandleOverlap === null ? null : Number(averageCandleOverlap.toFixed(6)),
  };
}
