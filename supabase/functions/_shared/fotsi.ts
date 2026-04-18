// ─── FOTSI: Forex Overview True Strength Index ──────────────────────
// Based on Stefano Panetta's Pine Script (SPH Investment Fund).
// Popularized by Serghey Magala (4× World Champion Forex/Futures).
//
// Measures relative momentum of 8 major currencies across all 28 cross
// pairs, then normalizes via TSI double-EMA smoothing.
//
// Parameters (from original Pine Script):
//   Long EMA  = 25
//   Short EMA = 15   ← NOT 13 (user-confirmed from Pine source)
//   Overbought = +50, Oversold = -50, Neutral zone = ±25
//
// Usage:
//   const strengths = computeFOTSI(candleMap);
//   // strengths = { EUR: 42.1, USD: -31.5, GBP: 18.3, ... }

import type { Candle } from "./candleSource.ts";

// ─── Constants ──────────────────────────────────────────────────────

export const FOTSI_LONG_EMA = 25;
export const FOTSI_SHORT_EMA = 15;
export const FOTSI_OVERBOUGHT = 50;
export const FOTSI_OVERSOLD = -50;
export const FOTSI_NEUTRAL_UPPER = 25;
export const FOTSI_NEUTRAL_LOWER = -25;

export const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY", "AUD", "CAD", "NZD"] as const;
export type Currency = (typeof CURRENCIES)[number];

/**
 * All 28 major forex cross pairs.
 * Each pair is [base, quote] — a rising pair means base strengthens, quote weakens.
 */
export const FOTSI_PAIRS: readonly [string, Currency, Currency][] = [
  // EUR crosses
  ["EUR/USD", "EUR", "USD"],
  ["EUR/GBP", "EUR", "GBP"],
  ["EUR/CHF", "EUR", "CHF"],
  ["EUR/JPY", "EUR", "JPY"],
  ["EUR/AUD", "EUR", "AUD"],
  ["EUR/CAD", "EUR", "CAD"],
  ["EUR/NZD", "EUR", "NZD"],
  // GBP crosses (excluding EUR/GBP already listed)
  ["GBP/USD", "GBP", "USD"],
  ["GBP/CHF", "GBP", "CHF"],
  ["GBP/JPY", "GBP", "JPY"],
  ["GBP/AUD", "GBP", "AUD"],
  ["GBP/CAD", "GBP", "CAD"],
  ["GBP/NZD", "GBP", "NZD"],
  // USD crosses
  ["USD/CHF", "USD", "CHF"],
  ["USD/JPY", "USD", "JPY"],
  ["AUD/USD", "AUD", "USD"],
  ["USD/CAD", "USD", "CAD"],
  ["NZD/USD", "NZD", "USD"],
  // CHF crosses
  ["CHF/JPY", "CHF", "JPY"],
  ["AUD/CHF", "AUD", "CHF"],
  ["CAD/CHF", "CAD", "CHF"],
  ["NZD/CHF", "NZD", "CHF"],
  // JPY crosses
  ["AUD/JPY", "AUD", "JPY"],
  ["CAD/JPY", "CAD", "JPY"],
  ["NZD/JPY", "NZD", "JPY"],
  // AUD crosses
  ["AUD/CAD", "AUD", "CAD"],
  ["AUD/NZD", "AUD", "NZD"],
  // CAD/NZD
  ["NZD/CAD", "NZD", "CAD"],
] as const;

// ─── EMA helper ─────────────────────────────────────────────────────

/**
 * Compute Exponential Moving Average of a series.
 * Uses the standard multiplier: k = 2 / (period + 1).
 * Returns an array of the same length; the first (period - 1) values
 * are seeded with a simple moving average.
 */
function ema(series: number[], period: number): number[] {
  if (series.length === 0) return [];
  if (period <= 1) return [...series];

  const k = 2 / (period + 1);
  const out = new Array<number>(series.length);

  // Seed: SMA of first `period` values (or fewer if series is short)
  const seedLen = Math.min(period, series.length);
  let sum = 0;
  for (let i = 0; i < seedLen; i++) sum += series[i];
  out[0] = sum / seedLen;

  // If series is shorter than period, fill with SMA-seeded EMA
  for (let i = 1; i < series.length; i++) {
    if (i < seedLen) {
      // Re-seed: use running SMA up to this point
      let s = 0;
      for (let j = 0; j <= i; j++) s += series[j];
      out[i] = s / (i + 1);
    } else {
      out[i] = series[i] * k + out[i - 1] * (1 - k);
    }
  }

  // After seed period, apply standard EMA
  for (let i = seedLen; i < series.length; i++) {
    out[i] = series[i] * k + out[i - 1] * (1 - k);
  }

  return out;
}

// ─── TSI calculation ────────────────────────────────────────────────

/**
 * True Strength Index: 100 × EMA(EMA(mom, longP), shortP) / EMA(EMA(|mom|, longP), shortP)
 * Returns an array of TSI values (same length as input).
 */
function tsi(
  momentum: number[],
  longPeriod: number = FOTSI_LONG_EMA,
  shortPeriod: number = FOTSI_SHORT_EMA,
): number[] {
  const absMom = momentum.map(Math.abs);

  // Double smoothing of momentum
  const smoothedMom = ema(ema(momentum, longPeriod), shortPeriod);
  // Double smoothing of |momentum|
  const smoothedAbs = ema(ema(absMom, longPeriod), shortPeriod);

  return smoothedMom.map((num, i) => {
    const denom = smoothedAbs[i];
    if (denom === 0 || !Number.isFinite(denom)) return 0;
    const val = 100 * num / denom;
    // Clamp to [-100, +100] for safety
    return Math.max(-100, Math.min(100, val));
  });
}

// ─── Per-bar momentum extraction ────────────────────────────────────

/**
 * Extract per-bar momentum from candles: close - open.
 * JPY pairs are divided by 100 to normalize pip scale.
 */
function extractMomentum(candles: Candle[], pair: string): number[] {
  const isJPY = pair.includes("JPY");
  return candles.map(c => {
    const mom = c.close - c.open;
    return isJPY ? mom / 100 : mom;
  });
}

// ─── Currency aggregation ───────────────────────────────────────────

export interface FOTSIResult {
  /** TSI value per currency, e.g. { EUR: 42.1, USD: -31.5, ... } */
  strengths: Record<Currency, number>;
  /** Full TSI series per currency (for charting / curve detection) */
  series: Record<Currency, number[]>;
  /** Number of bars used in the calculation */
  barCount: number;
  /** Pairs that were missing from the candle map */
  missingPairs: string[];
  /** Timestamp of computation */
  computedAt: string;
}

/**
 * Compute FOTSI currency strengths from a map of pair → candles.
 *
 * @param candleMap  Record keyed by pair name (e.g. "EUR/USD") → Candle[]
 *                   All arrays should be the same length and time-aligned.
 *                   Minimum recommended: 50 bars (25 long EMA + 15 short EMA + buffer).
 * @returns          FOTSIResult with latest TSI value per currency
 */
export function computeFOTSI(candleMap: Record<string, Candle[]>): FOTSIResult {
  const missingPairs: string[] = [];

  // Step 1: Extract per-bar momentum for each of the 28 pairs
  const pairMomentum: Record<string, number[]> = {};
  let barCount = 0;

  for (const [pair] of FOTSI_PAIRS) {
    const candles = candleMap[pair];
    if (!candles || candles.length === 0) {
      missingPairs.push(pair);
      continue;
    }
    pairMomentum[pair] = extractMomentum(candles, pair);
    barCount = Math.max(barCount, candles.length);
  }

  // Step 2: Aggregate momentum per currency across its 7 pairs
  // Each currency appears in 7 pairs. When it's the base, add momentum.
  // When it's the quote, subtract momentum.
  const currencyMomentum: Record<Currency, number[]> = {} as any;
  for (const ccy of CURRENCIES) {
    currencyMomentum[ccy] = new Array(barCount).fill(0);
  }

  for (const [pair, base, quote] of FOTSI_PAIRS) {
    const mom = pairMomentum[pair];
    if (!mom) continue;

    for (let i = 0; i < mom.length; i++) {
      currencyMomentum[base][i] += mom[i];   // Base strengthens when pair rises
      currencyMomentum[quote][i] -= mom[i];   // Quote weakens when pair rises
    }
  }

  // Step 3: Apply TSI double smoothing to each currency's momentum series
  const series: Record<Currency, number[]> = {} as any;
  const strengths: Record<Currency, number> = {} as any;

  for (const ccy of CURRENCIES) {
    const tsiValues = tsi(currencyMomentum[ccy], FOTSI_LONG_EMA, FOTSI_SHORT_EMA);
    series[ccy] = tsiValues;
    // Latest value = last element
    strengths[ccy] = tsiValues.length > 0 ? tsiValues[tsiValues.length - 1] : 0;
  }

  return {
    strengths,
    series,
    barCount,
    missingPairs,
    computedAt: new Date().toISOString(),
  };
}

// ─── Threshold helpers ──────────────────────────────────────────────

/** Is the currency overbought (TSI > +50)? */
export function isCurrencyOverbought(
  currency: Currency,
  strengths: Record<Currency, number>,
): boolean {
  return (strengths[currency] ?? 0) > FOTSI_OVERBOUGHT;
}

/** Is the currency oversold (TSI < -50)? */
export function isCurrencyOversold(
  currency: Currency,
  strengths: Record<Currency, number>,
): boolean {
  return (strengths[currency] ?? 0) < FOTSI_OVERSOLD;
}

/** Is the currency in the neutral zone (between -25 and +25)? */
export function isCurrencyNeutral(
  currency: Currency,
  strengths: Record<Currency, number>,
): boolean {
  const val = strengths[currency] ?? 0;
  return val >= FOTSI_NEUTRAL_LOWER && val <= FOTSI_NEUTRAL_UPPER;
}

/**
 * Detect if a currency's TSI line is "curving" (decelerating).
 * This is the Magala entry trigger — the line stops accelerating
 * and starts to flatten or reverse.
 *
 * Checks last 3 bars: if the rate of change is decreasing, the line is curving.
 * Returns: "curving_down" | "curving_up" | "accelerating" | "flat" | "insufficient_data"
 */
export function detectCurve(
  currency: Currency,
  series: Record<Currency, number[]>,
): "curving_down" | "curving_up" | "accelerating" | "flat" | "insufficient_data" {
  const s = series[currency];
  if (!s || s.length < 4) return "insufficient_data";

  const n = s.length;
  const delta1 = s[n - 2] - s[n - 3]; // previous rate of change
  const delta2 = s[n - 1] - s[n - 2]; // current rate of change

  // If both deltas are near zero, it's flat
  if (Math.abs(delta1) < 0.5 && Math.abs(delta2) < 0.5) return "flat";

  // Curving down: was rising, now rising less or falling
  if (delta1 > 0.5 && delta2 < delta1 - 0.3) return "curving_down";

  // Curving up: was falling, now falling less or rising
  if (delta1 < -0.5 && delta2 > delta1 + 0.3) return "curving_up";

  return "accelerating";
}

// ─── Confluence scoring helper ──────────────────────────────────────

export interface CurrencyAlignmentResult {
  /** Score modifier to add to confluence: -0.5 to +1.5 */
  score: number;
  /** Human-readable label for signal reasoning */
  label: string;
  /** Base currency TSI value */
  baseTSI: number;
  /** Quote currency TSI value */
  quoteTSI: number;
  /** Spread between base and quote (positive = aligned with long) */
  spread: number;
}

/**
 * Calculate how well a trade direction aligns with currency strength.
 *
 * @param base       Base currency of the pair (e.g. "EUR" for EUR/USD)
 * @param quote      Quote currency of the pair (e.g. "USD" for EUR/USD)
 * @param direction  "BUY" or "SELL"
 * @param strengths  FOTSI strength values per currency
 * @returns          Score modifier and reasoning label
 */
export function getCurrencyAlignment(
  base: Currency,
  quote: Currency,
  direction: "BUY" | "SELL",
  strengths: Record<Currency, number>,
): CurrencyAlignmentResult {
  const baseTSI = strengths[base] ?? 0;
  const quoteTSI = strengths[quote] ?? 0;

  // For a BUY: we want base strong (positive) and quote weak (negative)
  // For a SELL: we want base weak (negative) and quote strong (positive)
  const effectiveBase = direction === "BUY" ? baseTSI : -baseTSI;
  const effectiveQuote = direction === "BUY" ? -quoteTSI : quoteTSI;
  const spread = effectiveBase + effectiveQuote; // positive = aligned

  let score = 0;
  let label = "";

  // ── Exhaustion penalties (highest priority) ──
  if (direction === "BUY" && baseTSI > 40) {
    score = -0.5;
    label = `Exhaustion penalty: buying overbought ${base} (TSI ${baseTSI.toFixed(1)})`;
  } else if (direction === "BUY" && quoteTSI < -40) {
    // Buying against oversold quote (quote about to bounce = pair drops)
    // Actually: oversold quote means quote is weak, which HELPS a long.
    // Only penalize if quote is curving up (about to strengthen).
    // For simplicity, no penalty here — oversold quote supports longs.
    // Fall through to alignment checks.
  } else if (direction === "SELL" && baseTSI < -40) {
    score = -0.5;
    label = `Exhaustion penalty: selling oversold ${base} (TSI ${baseTSI.toFixed(1)})`;
  } else if (direction === "SELL" && quoteTSI > 40) {
    // Selling against overbought quote — quote about to weaken = pair rises
    // No penalty — overbought quote supports shorts (pair rises means we're wrong).
    // Actually: overbought quote means quote is strong. Selling the pair means
    // we're selling base and buying quote. If quote is about to reverse down,
    // that hurts our short. But if quote is still strong, it helps.
    // For simplicity, no penalty here.
  }

  // ── Alignment bonuses (only if no exhaustion penalty) ──
  if (score === 0) {
    if (effectiveBase > 25 && effectiveQuote > 25) {
      // Strong alignment: both currencies support the direction
      score = 1.5;
      label = direction === "BUY"
        ? `Strong alignment: ${base} strong (${baseTSI.toFixed(1)}), ${quote} weak (${quoteTSI.toFixed(1)})`
        : `Strong alignment: ${base} weak (${baseTSI.toFixed(1)}), ${quote} strong (${quoteTSI.toFixed(1)})`;
    } else if (effectiveBase > 0 && effectiveQuote > 0) {
      // Moderate alignment
      score = 1.0;
      label = direction === "BUY"
        ? `Moderate alignment: ${base} (${baseTSI.toFixed(1)}) vs ${quote} (${quoteTSI.toFixed(1)})`
        : `Moderate alignment: ${base} (${baseTSI.toFixed(1)}) vs ${quote} (${quoteTSI.toFixed(1)})`;
    } else if (spread > 10) {
      // Mild alignment — at least the spread favors the direction
      score = 0.5;
      label = `Mild alignment: spread ${spread.toFixed(1)} favors ${direction}`;
    } else if (spread < -20) {
      // Against currency flow
      score = -0.5;
      label = direction === "BUY"
        ? `Against flow: ${base} weaker than ${quote} (spread ${spread.toFixed(1)})`
        : `Against flow: ${base} stronger than ${quote} (spread ${spread.toFixed(1)})`;
    } else {
      // Neutral
      score = 0;
      label = `Neutral: no significant currency strength signal (spread ${spread.toFixed(1)})`;
    }
  }

  return { score, label, baseTSI, quoteTSI, spread };
}

// ─── Gate 17: Overbought/Oversold Veto ──────────────────────────────

export interface VetoResult {
  /** Whether the trade is vetoed */
  vetoed: boolean;
  /** Human-readable reason for the veto (or "passed") */
  reason: string;
}

/**
 * Gate 17: Hard veto for trades buying overbought or selling oversold currencies.
 *
 * Rules:
 *   - BUY blocked if base TSI > +50 (buying exhausted currency)
 *   - SELL blocked if base TSI < -50 (selling exhausted currency)
 *   - BUY blocked if quote TSI < -50 AND curving up (quote about to bounce)
 *   - SELL blocked if quote TSI > +50 AND curving down (quote about to drop)
 *
 * The curve check on the quote is optional (requires series data).
 * Without series, only the base exhaustion check applies.
 */
export function checkOverboughtOversoldVeto(
  base: Currency,
  quote: Currency,
  direction: "BUY" | "SELL",
  strengths: Record<Currency, number>,
  series?: Record<Currency, number[]>,
): VetoResult {
  const baseTSI = strengths[base] ?? 0;
  const quoteTSI = strengths[quote] ?? 0;

  // Primary veto: buying overbought base
  if (direction === "BUY" && baseTSI > FOTSI_OVERBOUGHT) {
    return {
      vetoed: true,
      reason: `FOTSI VETO: ${base} overbought at ${baseTSI.toFixed(1)} (>${FOTSI_OVERBOUGHT}). Buying exhausted currency — reversal likely.`,
    };
  }

  // Primary veto: selling oversold base
  if (direction === "SELL" && baseTSI < FOTSI_OVERSOLD) {
    return {
      vetoed: true,
      reason: `FOTSI VETO: ${base} oversold at ${baseTSI.toFixed(1)} (<${FOTSI_OVERSOLD}). Selling exhausted currency — bounce likely.`,
    };
  }

  // Secondary veto: quote currency at extreme AND curving (about to reverse)
  if (series) {
    if (direction === "BUY" && quoteTSI < FOTSI_OVERSOLD) {
      const curve = detectCurve(quote, series);
      if (curve === "curving_up") {
        return {
          vetoed: true,
          reason: `FOTSI VETO: ${quote} oversold at ${quoteTSI.toFixed(1)} and curving up — ${quote} strengthening will push ${base}/${quote} down.`,
        };
      }
    }
    if (direction === "SELL" && quoteTSI > FOTSI_OVERBOUGHT) {
      const curve = detectCurve(quote, series);
      if (curve === "curving_down") {
        return {
          vetoed: true,
          reason: `FOTSI VETO: ${quote} overbought at ${quoteTSI.toFixed(1)} and curving down — ${quote} weakening will push ${base}/${quote} up.`,
        };
      }
    }
  }

  return {
    vetoed: false,
    reason: `FOTSI Gate passed: ${base} (${baseTSI.toFixed(1)}) / ${quote} (${quoteTSI.toFixed(1)}) — no exhaustion detected.`,
  };
}

// ─── Utility: Extract base/quote from pair string ───────────────────

/**
 * Parse a pair string like "EUR/USD" into [base, quote] currencies.
 * Returns null if the pair doesn't contain two recognized major currencies.
 */
export function parsePairCurrencies(pair: string): [Currency, Currency] | null {
  const parts = pair.split("/");
  if (parts.length !== 2) return null;
  const base = parts[0].toUpperCase() as Currency;
  const quote = parts[1].toUpperCase() as Currency;
  if (!CURRENCIES.includes(base) || !CURRENCIES.includes(quote)) return null;
  return [base, quote];
}

/**
 * Get all 28 FOTSI pair names as a flat string array.
 * Useful for batch-fetching candles.
 */
export function getFOTSIPairNames(): string[] {
  return FOTSI_PAIRS.map(([pair]) => pair);
}
