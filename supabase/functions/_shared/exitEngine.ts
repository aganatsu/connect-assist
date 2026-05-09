/**
 * exitEngine.ts — Regime-adaptive TP and momentum-fade trailing stop
 *
 * Two independent functions:
 *   1. adjustTPForRegime()  — Adjusts TP at trade entry based on market regime
 *   2. computeAdaptiveTrail() — Computes trailing SL distance based on momentum fade
 *
 * Both are opt-in via config toggles (default: off).
 * When disabled, the existing TP and trailing logic runs unchanged.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface RegimeInfo {
  regime: string;       // "trending" | "strong_trend" | "ranging" | "choppy" | "transitional"
  confidence: number;   // 0-1
  atrTrend: string;     // "expanding" | "contracting" | "stable"
  bias: string;         // "bullish" | "bearish" | "neutral"
}

export interface TPAdjustInput {
  currentTP: number;
  entryPrice: number;
  stopLoss: number;
  direction: "long" | "short";
  regimeInfo: RegimeInfo | null;
  atrValue: number;
  /** Config overrides */
  trendingRRMultiplier?: number;   // default 1.5 — multiply base R:R by this in trending
  rangingRRMultiplier?: number;    // default 0.75 — multiply base R:R by this in ranging
  maxRR?: number;                  // default 4.0 — hard cap on R:R
  minRR?: number;                  // default 1.0 — floor on R:R
}

export interface TPAdjustResult {
  adjustedTP: number;
  originalTP: number;
  adjustedRR: number;
  originalRR: number;
  regime: string;
  reason: string;
}

export interface TrailInput {
  entryPrice: number;
  currentPrice: number;
  currentSL: number;
  direction: "long" | "short";
  rMultiple: number;
  regimeInfo: RegimeInfo | null;
  atrValue: number;
  pipSize: number;
  /** Recent candles for momentum detection (last 5-10 candles of entry TF) */
  recentCandles?: Array<{ open: number; high: number; low: number; close: number }>;
  /** Config overrides */
  baseTrailATRMultiple?: number;   // default 1.5 — base trail distance as ATR multiple
  momentumFadeThreshold?: number;  // default 0.4 — body/range ratio below this = fading
  tightenFactor?: number;          // default 0.6 — multiply trail distance by this when fading
  widenFactor?: number;            // default 1.3 — multiply trail distance by this when strong
}

export interface TrailResult {
  trailDistance: number;           // in price units (not pips)
  trailDistancePips: number;      // in pips
  newSL: number;
  shouldTighten: boolean;         // true if new SL is better than current SL
  momentumState: "strong" | "fading" | "neutral";
  reason: string;
}

// ─── 1. Regime-Adaptive TP ──────────────────────────────────────────

/**
 * Adjusts the take-profit level based on the current market regime.
 *
 * Trending/strong_trend → extend TP (higher R:R, let winners run)
 * Ranging/choppy → tighten TP (lower R:R, take profits quickly)
 * Transitional/unknown → no change
 *
 * The adjustment works by scaling the R:R ratio, not by moving TP to an
 * arbitrary level. This preserves the structural logic of the original TP
 * (next_level, fib extension, etc.) while adapting the distance.
 */
export function adjustTPForRegime(input: TPAdjustInput): TPAdjustResult {
  const {
    currentTP, entryPrice, stopLoss, direction, regimeInfo, atrValue,
    trendingRRMultiplier = 1.5,
    rangingRRMultiplier = 0.75,
    maxRR = 4.0,
    minRR = 1.0,
  } = input;

  const slDistance = Math.abs(entryPrice - stopLoss);
  if (slDistance === 0) {
    return {
      adjustedTP: currentTP, originalTP: currentTP,
      adjustedRR: 0, originalRR: 0,
      regime: regimeInfo?.regime ?? "unknown",
      reason: "SL distance is zero — cannot adjust TP",
    };
  }

  const tpDistance = Math.abs(currentTP - entryPrice);
  const originalRR = tpDistance / slDistance;

  // No regime info → no adjustment
  if (!regimeInfo || regimeInfo.confidence < 0.5) {
    return {
      adjustedTP: currentTP, originalTP: currentTP,
      adjustedRR: originalRR, originalRR,
      regime: regimeInfo?.regime ?? "unknown",
      reason: "Regime confidence too low or unavailable — TP unchanged",
    };
  }

  const regime = regimeInfo.regime;
  let multiplier = 1.0;
  let regimeLabel = regime;

  if (regime === "strong_trend" || regime === "trending") {
    multiplier = trendingRRMultiplier;
    regimeLabel = regime;
  } else if (regime === "ranging" || regime === "choppy") {
    multiplier = rangingRRMultiplier;
    regimeLabel = regime;
  } else {
    // transitional or unknown — no adjustment
    return {
      adjustedTP: currentTP, originalTP: currentTP,
      adjustedRR: originalRR, originalRR,
      regime: regimeLabel,
      reason: `Regime is ${regime} — TP unchanged (transitional/unknown)`,
    };
  }

  // Apply multiplier to R:R, then clamp
  let adjustedRR = originalRR * multiplier;
  adjustedRR = Math.max(minRR, Math.min(maxRR, adjustedRR));

  // Also clamp using ATR: TP should not exceed 4× ATR from entry (sanity check)
  const maxTPDistance = atrValue > 0 ? atrValue * 6 : Infinity;
  const adjustedTPDistance = Math.min(adjustedRR * slDistance, maxTPDistance);
  const finalRR = adjustedTPDistance / slDistance;

  const adjustedTP = direction === "long"
    ? entryPrice + adjustedTPDistance
    : entryPrice - adjustedTPDistance;

  const action = multiplier > 1.0 ? "extended" : multiplier < 1.0 ? "tightened" : "unchanged";

  return {
    adjustedTP,
    originalTP: currentTP,
    adjustedRR: Math.round(finalRR * 100) / 100,
    originalRR: Math.round(originalRR * 100) / 100,
    regime: regimeLabel,
    reason: `TP ${action}: ${regime} regime (conf ${(regimeInfo.confidence * 100).toFixed(0)}%) → R:R ${originalRR.toFixed(2)} → ${finalRR.toFixed(2)} (×${multiplier})`,
  };
}

// ─── 2. Momentum-Fade Trailing Stop ─────────────────────────────────

/**
 * Detects momentum state from recent candles.
 *
 * Strong momentum: large bodies relative to range, consecutive closes in direction
 * Fading momentum: small bodies (dojis/spinning tops), mixed closes, wicks > bodies
 */
function detectMomentumState(
  candles: Array<{ open: number; high: number; low: number; close: number }>,
  direction: "long" | "short",
  threshold: number,
): "strong" | "fading" | "neutral" {
  if (!candles || candles.length < 3) return "neutral";

  // Use last 5 candles (or fewer if not available)
  const recent = candles.slice(-5);

  // Metric 1: Average body-to-range ratio
  let totalBodyRatio = 0;
  let directionalCount = 0;

  for (const c of recent) {
    const range = c.high - c.low;
    if (range === 0) continue;
    const body = Math.abs(c.close - c.open);
    totalBodyRatio += body / range;

    // Count candles closing in the trade direction
    if (direction === "long" && c.close > c.open) directionalCount++;
    if (direction === "short" && c.close < c.open) directionalCount++;
  }

  const avgBodyRatio = totalBodyRatio / recent.length;
  const directionalPercent = directionalCount / recent.length;

  // Strong: big bodies + most candles in direction
  if (avgBodyRatio > 0.6 && directionalPercent >= 0.6) return "strong";

  // Fading: small bodies or mixed direction
  if (avgBodyRatio < threshold || directionalPercent < 0.4) return "fading";

  return "neutral";
}

/**
 * Computes an adaptive trailing stop distance based on:
 * 1. ATR (volatility-based baseline)
 * 2. Momentum state (strong → wider trail, fading → tighter trail)
 * 3. Regime (trending → wider, ranging → tighter)
 *
 * Returns the new SL level and whether it should replace the current SL.
 */
export function computeAdaptiveTrail(input: TrailInput): TrailResult {
  const {
    entryPrice, currentPrice, currentSL, direction, rMultiple,
    regimeInfo, atrValue, pipSize,
    recentCandles,
    baseTrailATRMultiple = 1.5,
    momentumFadeThreshold = 0.4,
    tightenFactor = 0.6,
    widenFactor = 1.3,
  } = input;

  // Fallback: if no ATR, use a fixed distance based on pipSize
  const baseDistance = atrValue > 0
    ? atrValue * baseTrailATRMultiple
    : pipSize * 20; // 20 pips fallback

  // Detect momentum
  const momentumState = detectMomentumState(
    recentCandles || [],
    direction,
    momentumFadeThreshold,
  );

  // Adjust trail distance based on momentum
  let adjustedDistance = baseDistance;
  let reason = "";

  if (momentumState === "strong") {
    adjustedDistance = baseDistance * widenFactor;
    reason = `Momentum strong → wider trail (${baseTrailATRMultiple}×ATR × ${widenFactor} = ${(baseTrailATRMultiple * widenFactor).toFixed(2)}×ATR)`;
  } else if (momentumState === "fading") {
    adjustedDistance = baseDistance * tightenFactor;
    reason = `Momentum fading → tighter trail (${baseTrailATRMultiple}×ATR × ${tightenFactor} = ${(baseTrailATRMultiple * tightenFactor).toFixed(2)}×ATR)`;
  } else {
    reason = `Momentum neutral → standard trail (${baseTrailATRMultiple}×ATR)`;
  }

  // Regime overlay: further adjust if regime is clear
  if (regimeInfo && regimeInfo.confidence >= 0.6) {
    if (regimeInfo.regime === "strong_trend" || regimeInfo.regime === "trending") {
      adjustedDistance *= 1.1; // 10% wider in trends (let it breathe)
      reason += ` | ${regimeInfo.regime} regime → +10% width`;
    } else if (regimeInfo.regime === "ranging" || regimeInfo.regime === "choppy") {
      adjustedDistance *= 0.85; // 15% tighter in ranges (take what you can)
      reason += ` | ${regimeInfo.regime} regime → -15% width`;
    }
  }

  // R-multiple scaling: as trade goes deeper into profit, tighten slightly
  // At 1R: no change. At 2R: 10% tighter. At 3R: 20% tighter.
  if (rMultiple > 1.0) {
    const rScale = Math.max(0.7, 1.0 - (rMultiple - 1.0) * 0.1);
    adjustedDistance *= rScale;
    reason += ` | ${rMultiple.toFixed(1)}R → scale ${(rScale * 100).toFixed(0)}%`;
  }

  // Floor: trail distance must be at least 0.5× ATR (prevent micro-trail)
  const minDistance = atrValue > 0 ? atrValue * 0.5 : pipSize * 5;
  adjustedDistance = Math.max(adjustedDistance, minDistance);

  // Compute new SL
  const newSL = direction === "long"
    ? currentPrice - adjustedDistance
    : currentPrice + adjustedDistance;

  // Should we tighten? Only if new SL is better (closer to price) than current SL
  const shouldTighten = direction === "long"
    ? newSL > currentSL
    : newSL < currentSL;

  const trailDistancePips = pipSize > 0 ? adjustedDistance / pipSize : 0;

  return {
    trailDistance: adjustedDistance,
    trailDistancePips: Math.round(trailDistancePips * 10) / 10,
    newSL,
    shouldTighten,
    momentumState,
    reason,
  };
}
