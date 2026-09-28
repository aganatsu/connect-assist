/**
 * HTF context assembly — the production orchestration, extracted. PURE.
 *
 * THIRD SLICE. Same method as zone and direction: lift the orchestration, leave
 * the detectors shared, prove against what production recorded.
 *
 * WHAT THIS OWNS. Everything between "we have candles" and "the scorer has its
 * context": the structure-series pick, POI detection on 4H/1H/Daily with their
 * per-timeframe quality thresholds and state filters, the Fib/PD/liquidity
 * derivation, and the liquidity tolerance ladder. These were the inputs Stage
 * 2E proved most dangerous to re-derive — an omitted HTF bundle moved AUD/USD
 * agreement from 84.9% to 37.3%, and a guessed liquidity tolerance is what
 * broke the first Stage 2G replay. Owning them here means a caller cannot
 * recreate them slightly differently.
 *
 * EXTRACTION ONLY. The asymmetries are deliberate and reproduced verbatim:
 *   * Daily needs only 10 bars; 4H and 1H need 20.
 *   * Daily POIs qualify at quality >= 2; intraday at >= 3, because daily has
 *     fewer structure breaks.
 *   * The liquidity tolerance gets +0.10 on Daily (capped 0.40), +0.05 on 4H
 *     (capped 0.35), and no bump on 1H.
 * None of that was tidied. Each asymmetry changes which POIs exist.
 *
 * MARKET-DRIVEN. Candles and frozen config only — no database, no network, no
 * wall clock — so it replays causally from historical bars at any time t.
 */

import {
  analyzeMarketStructure, detectFVGs, detectOrderBlocks, detectBreakerBlocks,
  detectZigZagPivots, computeFibLevels, detectSwingPoints, detectLiquidityPools,
  type Candle, type LiquidityPool,
} from "./smcAnalysis.ts";
import { STYLE_TF_LABELS } from "./directionEngine.ts";

export type HtfStyle = "scalper" | "day_trader" | "swing_trader";

/**
 * Premium/discount, as PRODUCTION computes it — deliberately not the shared one.
 *
 * ⚠️ THIS REPRODUCES A LIVE DISCREPANCY. `_shared/smcAnalysis.ts` exports a
 * `calculatePremiumDiscount` that was fixed on 2026-09-03 (48e37245, "premium/
 * discount reads past 100% and below 0%, and does so anti-trend"): it clamps
 * zonePercent to 0-100 and reports rawPercent / outOfRange / swingHigh /
 * swingLow. bot-scanner never used it. It carried its own local copy that
 * SHADOWS the import, so the fix has never been live in the scanner.
 *
 * Measured, not inferred: across all 152 captured scans, zero stored HTF
 * bundles contain `rawPercent`, and one USD/CAD row records
 * zonePercent = 166.67 — a value the fixed version cannot emit.
 *
 * This module copies the UNFIXED behaviour because Stage 2H is extraction only;
 * switching to the shared version here would change which zones read premium vs
 * discount and is a strategy change that needs its own decision and its own
 * evidence. Flagged in the report, not silently repaired.
 */
export function calculatePremiumDiscountAsProduction(
  candles: Candle[],
): { currentZone: string; zonePercent: number; oteZone: boolean } {
  const neutral = { currentZone: "equilibrium", zonePercent: 50, oteZone: false };
  if (candles.length < 10) return neutral;
  const swings = detectSwingPoints(candles);
  const recentHighs = swings.filter((s) => s.type === "high").slice(-5);
  const recentLows = swings.filter((s) => s.type === "low").slice(-5);
  if (recentHighs.length === 0 || recentLows.length === 0) return neutral;
  const swingHigh = Math.max(...recentHighs.map((s) => s.price));
  const swingLow = Math.min(...recentLows.map((s) => s.price));
  const range = swingHigh - swingLow;
  if (range === 0) return neutral;
  const lastPrice = candles[candles.length - 1].close;
  // NOT clamped — this is the behaviour production actually runs.
  const zonePercent = ((lastPrice - swingLow) / range) * 100;
  let currentZone = "equilibrium";
  if (zonePercent > 55) currentZone = "premium";
  else if (zonePercent < 45) currentZone = "discount";
  const oteZone = zonePercent >= 62 && zonePercent <= 79;
  return { currentZone, zonePercent, oteZone };
}

export interface HtfPOI {
  timeframe: string;
  type: "fvg" | "ob" | "breaker";
  high: number;
  low: number;
  direction: "bullish" | "bearish";
}

export interface HtfContextInput {
  style: HtfStyle;
  m15Candles: Candle[];
  hourlyCandles: Candle[];
  h4Candles: Candle[];
  dailyCandles: Candle[];
  /** `equalHighsLowsSensitivity`, 1-5. Drives the liquidity tolerance ladder. */
  equalHighsLowsSensitivity: number | undefined;
  liquidityPoolMinTouches: number | undefined;
}

export interface HtfContextResult {
  /** The series confluence scoring uses for structure, and its display label. */
  structureSeries: Candle[] | null;
  structureTfLabel: string | null;

  h4FVGs: unknown[];
  h4OBs: unknown[];
  h4Breakers: unknown[];
  dFVGs: unknown[];
  dOBs: unknown[];
  dBreakers: unknown[];

  /** Null when empty — production injects null, not an empty array. */
  htfPOIs: HtfPOI[] | null;

  htfFibLevelsD: unknown;
  htfFibLevels4H: unknown;
  htfFibLevels1H: unknown;
  htfPDD: unknown;
  htfPD4H: unknown;
  htfPD1H: unknown;
  htfLiquidityPoolsD: LiquidityPool[];
  htfLiquidityPools4H: LiquidityPool[];
  htfLiquidityPools1H: LiquidityPool[];

  /** Daily + 4H + 1H, in that order. Order reaches the zone engine. */
  combinedLiquidityPools: LiquidityPool[];
}

/**
 * Which series feeds confluence scoring's structure slot.
 *
 * Pinned to STYLE_TF_LABELS rather than STYLE_OVERRIDES.entryTimeframe: the two
 * disagree for day_trader ("15min" vs 1H) and swing_trader ("1h" vs 4H), and
 * scalper is the only style where they agree. Production declined to silently
 * pick a winner and so does this.
 */
export function resolveStructureSeries(style: HtfStyle, i: {
  m15Candles: Candle[]; h4Candles: Candle[]; dailyCandles: Candle[];
}): Candle[] | null {
  return style === "scalper"
    ? (i.m15Candles.length >= 20 ? i.m15Candles : null)
    : style === "swing_trader"
    ? (i.dailyCandles.length >= 20 ? i.dailyCandles : null)
    : (i.h4Candles.length >= 20 ? i.h4Candles : null);
}

/** The liquidity tolerance ladder, indexed by sensitivity 1-5. */
export function liquidityToleranceBase(sensitivity: number | undefined): number {
  const s = sensitivity ?? 3;
  return [0.10, 0.15, 0.20, 0.25, 0.30][Math.min(Math.max(s, 1), 5) - 1];
}

/** Collect POIs from one timeframe, applying production's state and quality filters. */
function collectPOIs(
  label: string, fvgs: any[], obs: any[], breakers: any[], minQuality: number,
): HtfPOI[] {
  const out: HtfPOI[] = [];
  for (const fvg of fvgs) {
    if (fvg.state !== "filled" && (fvg.quality ?? 0) >= minQuality) {
      out.push({ timeframe: label, type: "fvg", high: fvg.high, low: fvg.low, direction: fvg.type });
    }
  }
  for (const ob of obs) {
    if (ob.state !== "broken" && ob.state !== "mitigated") {
      out.push({ timeframe: label, type: "ob", high: ob.high, low: ob.low, direction: ob.type });
    }
  }
  for (const bb of breakers) {
    if (bb.isActive && bb.state !== "broken") {
      out.push({
        timeframe: label, type: "breaker", high: bb.high, low: bb.low,
        direction: bb.type === "bullish_breaker" ? "bullish" : "bearish",
      });
    }
  }
  return out;
}

/**
 * Build the HTF context exactly as bot-scanner does.
 *
 * POI push order is 4H, then 1H, then Daily — and within each, FVGs then OBs
 * then breakers. The array order is preserved because downstream consumers
 * index into it.
 */
export function buildHtfContext(input: HtfContextInput): HtfContextResult {
  const { m15Candles, hourlyCandles, h4Candles, dailyCandles } = input;
  const htfPOIs: HtfPOI[] = [];

  let h4FVGs: any[] = [], h4OBs: any[] = [], h4Breakers: any[] = [];
  if (h4Candles.length >= 20) {
    const st = analyzeMarketStructure(h4Candles);
    const breaks = [...st.bos, ...st.choch];
    h4FVGs = detectFVGs(h4Candles, breaks);
    h4OBs = detectOrderBlocks(h4Candles, breaks);
    h4Breakers = detectBreakerBlocks(h4OBs, h4Candles, breaks);
    htfPOIs.push(...collectPOIs("4H", h4FVGs, h4OBs, h4Breakers, 3));
  }

  if (hourlyCandles.length >= 20) {
    const st = analyzeMarketStructure(hourlyCandles);
    const breaks = [...st.bos, ...st.choch];
    const fvgs = detectFVGs(hourlyCandles, breaks);
    const obs = detectOrderBlocks(hourlyCandles, breaks);
    const brk = detectBreakerBlocks(obs, hourlyCandles, breaks);
    htfPOIs.push(...collectPOIs("1H", fvgs, obs, brk, 3));
  }

  // Daily runs on a LOWER bar minimum (10) and a LOWER quality threshold (2):
  // daily has fewer structure breaks, and BOOST_MAP already weights "D" highest.
  let dFVGs: any[] = [], dOBs: any[] = [], dBreakers: any[] = [];
  if (dailyCandles.length >= 10) {
    const st = analyzeMarketStructure(dailyCandles);
    const breaks = [...st.bos, ...st.choch];
    dFVGs = detectFVGs(dailyCandles, breaks);
    dOBs = detectOrderBlocks(dailyCandles, breaks);
    dBreakers = detectBreakerBlocks(dOBs, dailyCandles, breaks);
    htfPOIs.push(...collectPOIs("D", dFVGs, dOBs, dBreakers, 2));
  }

  const liqTolBase = liquidityToleranceBase(input.equalHighsLowsSensitivity);
  const liqMinTouches = input.liquidityPoolMinTouches ?? 2;

  let htfFibLevelsD: unknown = null, htfPDD: unknown = null;
  let htfLiquidityPoolsD: LiquidityPool[] = [];
  if (dailyCandles.length >= 10) {
    const z = detectZigZagPivots(dailyCandles, 5, 20);
    if (z.lastTwo) htfFibLevelsD = computeFibLevels(z.lastTwo[0], z.lastTwo[1]);
    htfPDD = calculatePremiumDiscountAsProduction(dailyCandles);
    htfLiquidityPoolsD = detectLiquidityPools(dailyCandles, Math.min(liqTolBase + 0.10, 0.40), liqMinTouches);
  }

  let htfFibLevels4H: unknown = null, htfPD4H: unknown = null;
  let htfLiquidityPools4H: LiquidityPool[] = [];
  if (h4Candles.length >= 20) {
    const z = detectZigZagPivots(h4Candles, 3, 10);
    if (z.lastTwo) htfFibLevels4H = computeFibLevels(z.lastTwo[0], z.lastTwo[1]);
    htfPD4H = calculatePremiumDiscountAsProduction(h4Candles);
    htfLiquidityPools4H = detectLiquidityPools(h4Candles, Math.min(liqTolBase + 0.05, 0.35), liqMinTouches);
  }

  let htfFibLevels1H: unknown = null, htfPD1H: unknown = null;
  let htfLiquidityPools1H: LiquidityPool[] = [];
  if (hourlyCandles.length >= 20) {
    const z = detectZigZagPivots(hourlyCandles, 3, 10);
    if (z.lastTwo) htfFibLevels1H = computeFibLevels(z.lastTwo[0], z.lastTwo[1]);
    htfPD1H = calculatePremiumDiscountAsProduction(hourlyCandles);
    // 1H takes the base tolerance with no bump.
    htfLiquidityPools1H = detectLiquidityPools(hourlyCandles, liqTolBase, liqMinTouches);
  }

  return {
    structureSeries: resolveStructureSeries(input.style, { m15Candles, h4Candles, dailyCandles }),
    structureTfLabel: STYLE_TF_LABELS[input.style]?.structureTFLabel ?? null,
    h4FVGs, h4OBs, h4Breakers, dFVGs, dOBs, dBreakers,
    // Production injects null when empty, and the scorer distinguishes the two.
    htfPOIs: htfPOIs.length > 0 ? htfPOIs : null,
    htfFibLevelsD, htfFibLevels4H, htfFibLevels1H,
    htfPDD, htfPD4H, htfPD1H,
    htfLiquidityPoolsD, htfLiquidityPools4H, htfLiquidityPools1H,
    combinedLiquidityPools: [
      ...htfLiquidityPoolsD, ...htfLiquidityPools4H, ...htfLiquidityPools1H,
    ],
  };
}
