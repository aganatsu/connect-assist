import { detectReversalCandle, type Candle } from "./smcAnalysis.ts";

export type CandlestickConfirmationProfile =
  | "unified"
  | "standalone"
  | "cascade";

export interface CandlestickConfirmationResult {
  detected: boolean;
  authorized: boolean;
  pattern: string | null;
  direction: "long" | "short" | null;
  strength: "strong" | "moderate" | "weak" | null;
  displacement: number;
  reasonCodes: string[];
}

function strengthFor(pattern: string | null) {
  if (!pattern) return null;
  if (/Engulfing|Morning Star|Evening Star/.test(pattern)) return "strong" as const;
  if (/Hammer|Shooting Star|Pin Bar/.test(pattern)) return "moderate" as const;
  if (/Doji/.test(pattern)) return "weak" as const;
  return "moderate" as const;
}

export function evaluateCandlestickConfirmation(input: {
  candles: Candle[];
  candleIndex: number;
  direction: "long" | "short";
  profile: CandlestickConfirmationProfile;
  minimumDisplacement: number;
  hasSweep: boolean;
}): CandlestickConfirmationResult {
  const window = input.candles.slice(0, input.candleIndex + 1);
  const candle = input.candles[input.candleIndex];
  const detected = detectReversalCandle(window);
  const expected = input.direction === "long" ? "bullish" : "bearish";
  const aligned = detected.detected && detected.type === expected;
  const range = candle ? candle.high - candle.low : 0;
  const displacement = candle && range > 0
    ? Math.abs(candle.close - candle.open) / range
    : 0;
  const strength = strengthFor(detected.pattern);
  const reasons: string[] = [];

  if (!detected.detected) reasons.push("candlestick_pattern_not_detected");
  else if (!aligned) reasons.push("candlestick_pattern_direction_mismatch");

  let authorized = false;
  if (aligned && strength) {
    const displaced = displacement >= input.minimumDisplacement;
    if (strength === "weak") {
      authorized = input.hasSweep && displaced;
      if (!input.hasSweep) reasons.push("weak_pattern_requires_sweep");
      if (!displaced) reasons.push("weak_pattern_requires_displacement");
    } else if (strength === "moderate") {
      authorized = input.hasSweep;
      if (!input.hasSweep) reasons.push("moderate_pattern_requires_sweep");
    } else if (input.profile === "standalone") {
      authorized = input.hasSweep && displaced;
      if (!input.hasSweep) reasons.push("standalone_pattern_requires_sweep");
      if (!displaced) reasons.push("standalone_pattern_requires_displacement");
    } else if (input.profile === "cascade") {
      authorized = displaced;
      if (!displaced) reasons.push("cascade_pattern_requires_displacement");
    } else if (strength === "strong") {
      authorized = displaced;
      if (!displaced) reasons.push("strong_pattern_requires_displacement");
    }
  }

  if (authorized) reasons.push("candlestick_pattern_authorized");
  return {
    detected: detected.detected,
    authorized,
    pattern: detected.pattern,
    direction: detected.type === "bullish" ? "long"
      : detected.type === "bearish" ? "short" : null,
    strength,
    displacement,
    reasonCodes: reasons,
  };
}
