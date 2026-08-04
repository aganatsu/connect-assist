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

function detectStarPattern(candles: Candle[]): ReturnType<typeof detectReversalCandle> | null {
  if (candles.length < 3) return null;
  const first = candles[candles.length - 3];
  const middle = candles[candles.length - 2];
  const last = candles[candles.length - 1];
  const firstRange = first.high - first.low;
  const firstBody = Math.abs(first.close - first.open);
  const middleBody = Math.abs(middle.close - middle.open);
  const lastBody = Math.abs(last.close - last.open);
  if (firstRange <= 0 || firstBody / firstRange <= 0.4 ||
    middleBody >= firstBody * 0.3 || lastBody <= firstBody * 0.5) return null;
  const midpoint = (first.open + first.close) / 2;
  if (first.close < first.open && last.close > last.open && last.close > midpoint) {
    return { detected: true, type: "bullish", pattern: "Morning Star" };
  }
  if (first.close > first.open && last.close < last.open && last.close < midpoint) {
    return { detected: true, type: "bearish", pattern: "Evening Star" };
  }
  return null;
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
  let detected = detectReversalCandle(window);
  const star = detectStarPattern(window);
  if (star) detected = star;
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
