/**
 * manualImpulse.ts — turn a hand-marked impulse into an ImpulseLeg.
 *
 * You mark an impulse on TradingView; the bot does everything else. The whole
 * pipeline downstream of impulse selection — POI mapping, fib overlay, HTF
 * confluence, zone ranking, confluence scoring, gates, sizing, execution — takes
 * an `ImpulseLeg` and does not care where it came from. So a manual impulse
 * substitutes for `findStructuralLeg()` and nothing else changes.
 *
 * Deliberate policy (chosen 2026-08-11):
 *   - OVERRIDE: when an active manual impulse exists for a pair, auto-detection
 *     is not consulted. You marked it; you decided.
 *   - Gates still apply. Every one. A hand-picked impulse says nothing about
 *     portfolio heat, spread, news or R:R.
 *   - The Direction Verdict can still veto. It does not lose the setup, it
 *     holds it until the read agrees.
 *
 * The marked prices are used verbatim for the leg geometry — they are your
 * levels, and the fib grid should sit where you drew it. Candle indices are
 * resolved separately, only so POI detection knows which bars to slice.
 */

import type { Candle } from "./smcAnalysis.ts";
import { MIN_SL_PIPS, SPECS } from "./smcAnalysis.ts";
import type { ImpulseLeg } from "./impulseZoneEngine.ts";

export interface ManualImpulseSpec {
  symbol: string;
  direction: "bullish" | "bearish";
  /** Swing high of the marked leg (fib level 1 for bullish). */
  high: number;
  /** Swing low of the marked leg (fib level 0 for bullish). */
  low: number;
  /** Timeframe the leg was marked on. */
  timeframe?: "D" | "4H" | "1H";
}

export type ManualImpulseRejection =
  | "invalid_bounds"
  | "direction_mismatch"
  | "not_found_in_candles"
  | "too_small_for_stop"
  | "origin_already_broken";

export interface ManualImpulseResolution {
  leg: ImpulseLeg | null;
  rejection: ManualImpulseRejection | null;
  /** Human-readable explanation, safe to show in the UI. */
  detail: string;
  /** How far the matched bars sat from the marked prices, in pips. */
  matchErrorPips?: { high: number; low: number };
}

/** Largest acceptable gap between a marked price and the nearest bar extreme. */
const MATCH_TOLERANCE_FRACTION = 0.25;

function nearestIndexBy(
  candles: Candle[],
  pick: (c: Candle) => number,
  target: number,
): { index: number; error: number } {
  let index = -1;
  let error = Infinity;
  for (let i = 0; i < candles.length; i++) {
    const diff = Math.abs(pick(candles[i]) - target);
    if (diff < error) {
      error = diff;
      index = i;
    }
  }
  return { index, error };
}

/**
 * Resolve a marked impulse against a candle series.
 *
 * Returns a leg only when the marking is coherent, locatable, and large enough
 * to be tradeable. Every rejection carries a reason so the UI can say why
 * rather than silently never producing a signal.
 */
export function resolveManualImpulse(
  candles: Candle[],
  spec: ManualImpulseSpec,
  options?: { minRR?: number },
): ManualImpulseResolution {
  const spec_high = Number(spec.high);
  const spec_low = Number(spec.low);

  if (
    !Number.isFinite(spec_high) || !Number.isFinite(spec_low) ||
    spec_high <= spec_low
  ) {
    return {
      leg: null,
      rejection: "invalid_bounds",
      detail: "High must be a number greater than low.",
    };
  }

  const range = spec_high - spec_low;
  const pipSize = (SPECS[spec.symbol] || SPECS["EUR/USD"]).pipSize;
  const rangePips = range / pipSize;

  // Reject at marking time what execution would reject later. A leg that cannot
  // hold the instrument's minimum stop at minimum R:R can never produce a trade,
  // and silently never signalling is worse than saying so now.
  const minStopPips = MIN_SL_PIPS[spec.symbol] ?? 15;
  const minRR = options?.minRR ?? 1.5;
  const requiredPips = minStopPips * minRR;
  if (rangePips < requiredPips) {
    return {
      leg: null,
      rejection: "too_small_for_stop",
      detail:
        `Marked impulse is ${rangePips.toFixed(1)} pips. ${spec.symbol} needs at ` +
        `least ${Math.round(requiredPips)} (min stop ${minStopPips} × ${minRR} R:R) ` +
        `for any entry inside it to be tradeable.`,
    };
  }

  if (candles.length < 5) {
    return {
      leg: null,
      rejection: "not_found_in_candles",
      detail: "Not enough candle history to locate the marked impulse.",
    };
  }

  const highMatch = nearestIndexBy(candles, (c) => c.high, spec_high);
  const lowMatch = nearestIndexBy(candles, (c) => c.low, spec_low);
  const tolerance = range * MATCH_TOLERANCE_FRACTION;

  if (highMatch.error > tolerance || lowMatch.error > tolerance) {
    return {
      leg: null,
      rejection: "not_found_in_candles",
      detail:
        `Could not find bars matching those levels on the loaded ${
          spec.timeframe ?? "entry"
        } candles. Check the timeframe and prices.`,
      matchErrorPips: {
        high: Math.round((highMatch.error / pipSize) * 10) / 10,
        low: Math.round((lowMatch.error / pipSize) * 10) / 10,
      },
    };
  }

  // A bullish leg runs low → high; a bearish leg runs high → low. If the bars
  // are ordered the other way, the marking contradicts the stated direction.
  const startIndex = spec.direction === "bullish" ? lowMatch.index : highMatch.index;
  const endIndex = spec.direction === "bullish" ? highMatch.index : lowMatch.index;
  if (startIndex >= endIndex) {
    return {
      leg: null,
      rejection: "direction_mismatch",
      detail:
        `Marked ${spec.direction}, but on the chart the ${
          spec.direction === "bullish" ? "high" : "low"
        } comes first. Check the direction.`,
    };
  }

  // Same invalidation rule auto-detected legs use: the leg is dead once a candle
  // CLOSES past the origin that started the move.
  const originPrice = spec.direction === "bullish" ? spec_low : spec_high;
  for (let j = endIndex + 1; j < candles.length; j++) {
    const brokeOrigin = spec.direction === "bullish"
      ? candles[j].close < originPrice
      : candles[j].close > originPrice;
    if (brokeOrigin) {
      return {
        leg: null,
        rejection: "origin_already_broken",
        detail:
          `Price has already closed past the impulse origin at ${originPrice}. ` +
          `The leg is invalidated — mark the newer move instead.`,
      };
    }
  }

  const matchErrorPips = {
    high: Math.round((highMatch.error / pipSize) * 10) / 10,
    low: Math.round((lowMatch.error / pipSize) * 10) / 10,
  };

  return {
    leg: {
      high: spec_high,
      low: spec_low,
      direction: spec.direction,
      startIndex,
      endIndex,
      isValid: true,
      // For a hand-marked leg the structural break is its terminal extreme.
      bosPrice: spec.direction === "bullish" ? spec_high : spec_low,
      breakType: "bos",
      closeBased: false,
      structureSignificance: "external",
      timeframe: spec.timeframe,
      startDate: candles[startIndex]?.datetime,
      endDate: candles[endIndex]?.datetime,
      spanBars: endIndex - startIndex,
    },
    rejection: null,
    detail:
      `Manual ${spec.direction} impulse accepted: ${rangePips.toFixed(1)} pips ` +
      `over ${endIndex - startIndex} bars.`,
    matchErrorPips,
  };
}
