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
  /**
   * When each swing printed, ISO. Optional but strongly preferred: price alone
   * is ambiguous because price revisits levels, and the matcher then has to
   * guess which visit was meant. Given a time, the bar is chosen outright.
   *
   * Matched to the NEAREST bar rather than an exact timestamp, because chart
   * feeds disagree on bar boundaries — a TradingView daily "Aug 2" can be the
   * bot's "Aug 3". Bars are hours apart, so nearest-in-time is unambiguous in a
   * way nearest-in-price is not.
   */
  highTime?: string | null;
  lowTime?: string | null;
}

export type ManualImpulseRejection =
  | "invalid_bounds"
  | "direction_mismatch"
  | "not_found_in_candles"
  | "too_small_for_stop"
  | "origin_already_broken"
  | "time_price_mismatch";

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

/** Bar closest in time to an instant. Bars are hours apart, so this is exact. */
function indexNearestTime(
  candles: Candle[],
  isoTime: string,
): { index: number; driftMs: number } {
  const target = new Date(isoTime).getTime();
  if (!Number.isFinite(target)) return { index: -1, driftMs: Infinity };
  let index = -1;
  let driftMs = Infinity;
  for (let i = 0; i < candles.length; i++) {
    const t = new Date(candles[i].datetime).getTime();
    if (!Number.isFinite(t)) continue;
    const diff = Math.abs(t - target);
    if (diff < driftMs) {
      driftMs = diff;
      index = i;
    }
  }
  return { index, driftMs };
}

/**
 * Closest bar to a target, preferring the most recent on a tie.
 *
 * Scanning forwards and keeping strict improvements means the EARLIEST bar wins
 * a tie — and price revisits levels. A leg marked in August was anchored to an
 * equally-close high from May, producing a 45-bar leg where the drawn one was 8.
 * Scanning backwards keeps the same "closest wins" rule but resolves ties toward
 * the recent move, which is what someone marking a chart means.
 *
 * `before` bounds the search so the origin is always found ahead of the terminus.
 */
function closestIndexPreferRecent(
  candles: Candle[],
  pick: (c: Candle) => number,
  target: number,
  before = candles.length,
): { index: number; error: number } {
  let index = -1;
  let error = Infinity;
  for (let i = Math.min(before, candles.length) - 1; i >= 0; i--) {
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

  const tolerance = range * MATCH_TOLERANCE_FRACTION;
  const pipsOff = (v: number) => Math.round((v / pipSize) * 10) / 10;

  if (candles.length < 5) {
    return {
      leg: null,
      rejection: "not_found_in_candles",
      detail: "Not enough candle history to locate the marked impulse.",
    };
  }

  // When times are supplied the bars are chosen outright — no search, no
  // ambiguity from revisited levels. Price is then only a cross-check that the
  // time and the level describe the same swing.
  const haveTimes = !!spec.highTime && !!spec.lowTime;
  let highIdx: number;
  let lowIdx: number;
  let highErr: number;
  let lowErr: number;

  if (haveTimes) {
    const hi = indexNearestTime(candles, spec.highTime!);
    const lo = indexNearestTime(candles, spec.lowTime!);
    if (hi.index < 0 || lo.index < 0) {
      return {
        leg: null,
        rejection: "not_found_in_candles",
        detail: "Those timestamps are not readable, or no candles cover them.",
      };
    }
    highIdx = hi.index;
    lowIdx = lo.index;
    highErr = Math.abs(candles[highIdx].high - spec_high);
    lowErr = Math.abs(candles[lowIdx].low - spec_low);

    // A time and a price that disagree means one of them is wrong — usually the
    // wrong timeframe, or a date typed from a different chart. Better to say so
    // than to silently trade a bar the user did not mean.
    if (highErr > tolerance || lowErr > tolerance) {
      return {
        leg: null,
        rejection: "time_price_mismatch",
        detail:
          `The bars at those times do not carry those prices — high is off by ` +
          `${pipsOff(highErr)} pips, low by ${pipsOff(lowErr)}. Check the ` +
          `timeframe and that both times come from the same chart.`,
        matchErrorPips: { high: pipsOff(highErr), low: pipsOff(lowErr) },
      };
    }
  } else {
    // No times given: fall back to matching on price, anchoring on the terminus
    // — the extreme the move ended at — and searching for the origin only among
    // bars before it.
    const terminusIsHigh = spec.direction === "bullish";
    const terminus = closestIndexPreferRecent(
      candles,
      (c) => (terminusIsHigh ? c.high : c.low),
      terminusIsHigh ? spec_high : spec_low,
    );
    if (terminus.index < 0 || terminus.error > tolerance) {
      return {
        leg: null,
        rejection: "not_found_in_candles",
        detail:
          `Could not find a bar at the ${terminusIsHigh ? "high" : "low"} of the marked ` +
          `leg on the loaded ${spec.timeframe ?? "entry"} candles. Adding the swing ` +
          `times would make this exact.`,
        matchErrorPips: {
          high: terminusIsHigh ? pipsOff(terminus.error) : 0,
          low: terminusIsHigh ? 0 : pipsOff(terminus.error),
        },
      };
    }
    const origin = closestIndexPreferRecent(
      candles,
      (c) => (terminusIsHigh ? c.low : c.high),
      terminusIsHigh ? spec_low : spec_high,
      terminus.index,
    );
    if (origin.index < 0 || origin.error > tolerance) {
      return {
        leg: null,
        rejection: "direction_mismatch",
        detail:
          `Found the ${terminusIsHigh ? "high" : "low"} of the marked leg, but no ` +
          `${terminusIsHigh ? "low" : "high"} near ${
            terminusIsHigh ? spec_low : spec_high
          } before it. Check the direction — a ${spec.direction} leg must run ` +
          `${terminusIsHigh ? "low → high" : "high → low"}.`,
        matchErrorPips: {
          high: terminusIsHigh ? pipsOff(terminus.error) : pipsOff(origin.error),
          low: terminusIsHigh ? pipsOff(origin.error) : pipsOff(terminus.error),
        },
      };
    }
    highIdx = terminusIsHigh ? terminus.index : origin.index;
    lowIdx = terminusIsHigh ? origin.index : terminus.index;
    highErr = terminusIsHigh ? terminus.error : origin.error;
    lowErr = terminusIsHigh ? origin.error : terminus.error;
  }

  // A bullish leg runs low → high; a bearish leg runs high → low.
  const startIdx = spec.direction === "bullish" ? lowIdx : highIdx;
  const endIdx = spec.direction === "bullish" ? highIdx : lowIdx;
  if (startIdx >= endIdx) {
    return {
      leg: null,
      rejection: "direction_mismatch",
      detail:
        `Marked ${spec.direction}, but on the chart the ${
          spec.direction === "bullish" ? "high" : "low"
        } comes first. A ${spec.direction} leg must run ${
          spec.direction === "bullish" ? "low → high" : "high → low"
        }.`,
    };
  }

  const startIndex = startIdx;
  const endIndex = endIdx;

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

  const matchErrorPips = { high: pipsOff(highErr), low: pipsOff(lowErr) };

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
      // There is no detected structure break to confirm — a person drew this
      // leg. Leaving this false made every manual leg fail qualification's
      // "structure break was not confirmed by a candle close" check.
      closeBased: true,
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
