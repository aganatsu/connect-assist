/**
 * Indicator Confirmation Module
 * ═══════════════════════════════
 *
 * Provides an alternative confirmation method using 4 technical indicators:
 *   1. Bollinger Bands (BB) — price at/beyond band edge confirms reversal potential
 *   2. Stochastic Oscillator — overbought/oversold confirms reversal direction
 *   3. MACD — histogram divergence or zero-line cross confirms momentum shift
 *   4. Volume — above-average volume confirms institutional participation
 *
 * Confirmation passes when at least `minIndicators` (default 3) out of 4 agree
 * with the trade direction.
 *
 * This is designed as a LIGHTWEIGHT alternative to CHoCH confirmation.
 * CHoCH remains the gold standard; indicators are for traders who prefer
 * a faster, momentum-based confirmation over structure-based.
 *
 * Usage:
 *   import { checkIndicatorConfirmation } from "./indicatorConfirmation.ts";
 *   const result = checkIndicatorConfirmation(candles, "long", { minIndicators: 3 });
 *   if (result.confirmed) { ... }
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  datetime: string;
}

export interface IndicatorConfirmationConfig {
  minIndicators: number;       // How many of 4 must agree (default: 3)
  bbPeriod: number;            // Bollinger Band period (default: 20)
  bbStdDev: number;            // Bollinger Band std dev multiplier (default: 2)
  stochPeriod: number;         // Stochastic %K period (default: 14)
  stochSmooth: number;         // Stochastic %D smoothing (default: 3)
  stochOB: number;             // Overbought threshold (default: 80)
  stochOS: number;             // Oversold threshold (default: 20)
  macdFast: number;            // MACD fast EMA period (default: 12)
  macdSlow: number;            // MACD slow EMA period (default: 26)
  macdSignal: number;          // MACD signal line period (default: 9)
  volumeMultiplier: number;    // Volume must be this × average (default: 1.2)
  volumeLookback: number;      // Periods for volume average (default: 20)
}

export interface IndicatorResult {
  name: string;
  confirmed: boolean;
  value: number;
  threshold: number;
  detail: string;
}

export interface IndicatorConfirmationResult {
  confirmed: boolean;
  passedCount: number;
  requiredCount: number;
  indicators: IndicatorResult[];
  summary: string;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_INDICATOR_CONFIG: IndicatorConfirmationConfig = {
  minIndicators: 3,
  bbPeriod: 20,
  bbStdDev: 2,
  stochPeriod: 14,
  stochSmooth: 3,
  stochOB: 80,
  stochOS: 20,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  volumeMultiplier: 1.2,
  volumeLookback: 20,
};

// ─── Helper: Simple Moving Average ──────────────────────────────────────────

function sma(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] ?? 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ─── Helper: Exponential Moving Average ─────────────────────────────────────

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

// ─── Helper: Standard Deviation ─────────────────────────────────────────────

function stdDev(values: number[], period: number): number {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

// ─── Bollinger Bands Check ──────────────────────────────────────────────────

function checkBB(
  closes: number[],
  direction: "long" | "short",
  period: number,
  stdDevMult: number,
): IndicatorResult {
  const currentClose = closes[closes.length - 1];
  const middle = sma(closes, period);
  const sd = stdDev(closes, period);
  const upper = middle + sd * stdDevMult;
  const lower = middle - sd * stdDevMult;

  // For longs: price at or below lower band = reversal potential (oversold)
  // For shorts: price at or above upper band = reversal potential (overbought)
  let confirmed: boolean;
  let detail: string;
  if (direction === "long") {
    confirmed = currentClose <= lower;
    detail = `Close ${currentClose.toFixed(5)} ${confirmed ? "≤" : ">"} lower band ${lower.toFixed(5)}`;
  } else {
    confirmed = currentClose >= upper;
    detail = `Close ${currentClose.toFixed(5)} ${confirmed ? "≥" : "<"} upper band ${upper.toFixed(5)}`;
  }

  return {
    name: "Bollinger Bands",
    confirmed,
    value: currentClose,
    threshold: direction === "long" ? lower : upper,
    detail,
  };
}

// ─── Stochastic Oscillator Check ────────────────────────────────────────────

function checkStochastic(
  candles: Candle[],
  direction: "long" | "short",
  period: number,
  smooth: number,
  ob: number,
  os: number,
): IndicatorResult {
  // Calculate %K values
  const kValues: number[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const highest = Math.max(...slice.map(c => c.high));
    const lowest = Math.min(...slice.map(c => c.low));
    const range = highest - lowest;
    const k = range > 0 ? ((candles[i].close - lowest) / range) * 100 : 50;
    kValues.push(k);
  }

  // Smooth %K to get %D (simple SMA smoothing)
  if (kValues.length < smooth) {
    return { name: "Stochastic", confirmed: false, value: 50, threshold: direction === "long" ? os : ob, detail: "Insufficient data" };
  }
  const dValue = sma(kValues, smooth);
  const currentK = kValues[kValues.length - 1];

  // For longs: stochastic in oversold territory (below OS threshold)
  // For shorts: stochastic in overbought territory (above OB threshold)
  let confirmed: boolean;
  let detail: string;
  if (direction === "long") {
    confirmed = currentK <= os || dValue <= os;
    detail = `%K=${currentK.toFixed(1)}, %D=${dValue.toFixed(1)} ${confirmed ? "≤" : ">"} OS(${os})`;
  } else {
    confirmed = currentK >= ob || dValue >= ob;
    detail = `%K=${currentK.toFixed(1)}, %D=${dValue.toFixed(1)} ${confirmed ? "≥" : "<"} OB(${ob})`;
  }

  return {
    name: "Stochastic",
    confirmed,
    value: currentK,
    threshold: direction === "long" ? os : ob,
    detail,
  };
}

// ─── MACD Check ─────────────────────────────────────────────────────────────

function checkMACD(
  closes: number[],
  direction: "long" | "short",
  fast: number,
  slow: number,
  signal: number,
): IndicatorResult {
  if (closes.length < slow + signal) {
    return { name: "MACD", confirmed: false, value: 0, threshold: 0, detail: "Insufficient data" };
  }

  const fastEMA = ema(closes, fast);
  const slowEMA = ema(closes, slow);

  // MACD line = fast EMA - slow EMA
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(fastEMA[i] - slowEMA[i]);
  }

  // Signal line = EMA of MACD line
  const signalLine = ema(macdLine, signal);

  // Histogram = MACD - Signal
  const currentMACD = macdLine[macdLine.length - 1];
  const currentSignal = signalLine[signalLine.length - 1];
  const histogram = currentMACD - currentSignal;
  const prevHistogram = macdLine.length >= 2
    ? macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2]
    : 0;

  // For longs: MACD crossing above signal (histogram turning positive) or histogram increasing
  // For shorts: MACD crossing below signal (histogram turning negative) or histogram decreasing
  let confirmed: boolean;
  let detail: string;
  if (direction === "long") {
    confirmed = histogram > 0 || (histogram > prevHistogram && prevHistogram < 0);
    detail = `Histogram=${histogram.toFixed(6)} ${confirmed ? "(bullish)" : "(bearish)"}, prev=${prevHistogram.toFixed(6)}`;
  } else {
    confirmed = histogram < 0 || (histogram < prevHistogram && prevHistogram > 0);
    detail = `Histogram=${histogram.toFixed(6)} ${confirmed ? "(bearish)" : "(bullish)"}, prev=${prevHistogram.toFixed(6)}`;
  }

  return {
    name: "MACD",
    confirmed,
    value: histogram,
    threshold: 0,
    detail,
  };
}

// ─── Volume Check ───────────────────────────────────────────────────────────

function checkVolume(
  candles: Candle[],
  multiplier: number,
  lookback: number,
): IndicatorResult {
  const volumes = candles.map(c => c.volume ?? 0);
  const currentVolume = volumes[volumes.length - 1];

  // If no volume data available, pass by default (some feeds don't provide volume)
  if (currentVolume === 0 && volumes.every(v => v === 0)) {
    return {
      name: "Volume",
      confirmed: true,
      value: 0,
      threshold: 0,
      detail: "No volume data available — passing by default",
    };
  }

  const avgVolume = sma(volumes.slice(0, -1), lookback); // Average excluding current
  const threshold = avgVolume * multiplier;
  const confirmed = currentVolume >= threshold;

  return {
    name: "Volume",
    confirmed,
    value: currentVolume,
    threshold,
    detail: `Vol=${currentVolume.toFixed(0)} ${confirmed ? "≥" : "<"} ${threshold.toFixed(0)} (${multiplier}× avg)`,
  };
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Check indicator-based confirmation for a trade direction.
 * Returns whether enough indicators (default 3/4) confirm the trade.
 *
 * @param candles - Recent candles (at least 30 recommended for MACD)
 * @param direction - Trade direction ("long" or "short")
 * @param config - Optional configuration overrides
 */
export function checkIndicatorConfirmation(
  candles: Candle[],
  direction: "long" | "short",
  config: Partial<IndicatorConfirmationConfig> = {},
): IndicatorConfirmationResult {
  const cfg = { ...DEFAULT_INDICATOR_CONFIG, ...config };
  const closes = candles.map(c => c.close);

  // Run all 4 indicator checks
  const bb = checkBB(closes, direction, cfg.bbPeriod, cfg.bbStdDev);
  const stoch = checkStochastic(candles, direction, cfg.stochPeriod, cfg.stochSmooth, cfg.stochOB, cfg.stochOS);
  const macd = checkMACD(closes, direction, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
  const volume = checkVolume(candles, cfg.volumeMultiplier, cfg.volumeLookback);

  const indicators = [bb, stoch, macd, volume];
  const passedCount = indicators.filter(i => i.confirmed).length;
  const confirmed = passedCount >= cfg.minIndicators;

  const passedNames = indicators.filter(i => i.confirmed).map(i => i.name);
  const summary = confirmed
    ? `Indicator confirmation PASSED (${passedCount}/${cfg.minIndicators} required): ${passedNames.join(", ")}`
    : `Indicator confirmation FAILED (${passedCount}/${cfg.minIndicators} required)`;

  return {
    confirmed,
    passedCount,
    requiredCount: cfg.minIndicators,
    indicators,
    summary,
  };
}
