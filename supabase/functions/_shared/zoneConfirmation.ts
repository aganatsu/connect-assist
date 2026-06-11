/**
 * Zone Confirmation Entry Module — Tiered Confirmation
 * ═══════════════════════════════════════════════════════
 * 
 * Implements a TIERED confirmation model for zone entries:
 * Instead of requiring a single binary CHoCH check, the system evaluates
 * multiple confirmation paths with different strength levels.
 * 
 * Confirmation Tiers (any ONE tier passing = confirmed fill):
 * 
 *   Tier 1 — CHoCH (Gold Standard):
 *     Close-based CHoCH in the correct direction → instant fill
 * 
 *   Tier 2 — CHoCH + Supporting (Relaxed CHoCH):
 *     Wick-based CHoCH (not close) + at least 1 supporting signal
 *     (engulfing, rejection wick, FVG, or volume spike)
 * 
 *   Tier 3 — Reversal Pattern (No CHoCH Required):
 *     Engulfing pattern + rejection wick + displacement above instrument threshold
 *     This IS a reversal — it just hasn't broken structure on 5m yet.
 * 
 * Instrument-Aware Thresholds:
 *   XAU/USD and metals have larger wicks relative to bodies due to volatility.
 *   Displacement thresholds are lowered for these instruments.
 * 
 * References:
 * - ICT 2022 Mentorship Model (MSS on LTF as entry trigger)
 * - DailyPriceAction SMC Strategy (5min CHoCH at zone)
 * - FluxCharts CHoCH detection (close-based, displacement-filtered)
 */

import { analyzeMarketStructure, type Candle } from "./smcAnalysis.ts";
import { evaluateConfirmation, type ConfirmationResult } from "./confirmationHierarchy.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type { Candle };

export type ConfirmationType =
  | "bearish_choch"
  | "bullish_choch"
  | "bearish_choch_relaxed"
  | "bullish_choch_relaxed"
  | "bearish_reversal_pattern"
  | "bullish_reversal_pattern";

export interface ConfirmationSignal {
  type: ConfirmationType;
  tier: 1 | 2 | 3;             // which confirmation tier triggered
  price: number;                // price at confirmation (candle close)
  candleIndex: number;          // index in the candle array
  displacement: number;         // body/range ratio (0-1), higher = stronger
  significance: "internal" | "external" | undefined;
  closeBased: boolean;          // true = candle body closed through (strong)
  supportingSignals: string[];  // additional confirmation factors
}

export interface ZoneConfirmationConfig {
  enabled: boolean;                    // default: true (when izGateMode === "hard")
  confirmationTimeframe: string;       // default: "5m"
  minDisplacement: number;             // default: 0.4 (40% body ratio — lowered from 0.5)
  requireCloseBased: boolean;          // default: true (for Tier 1 only now)
  maxLookbackCandles: number;          // default: 10 (50 min on 5m — expanded from 6)
  resetOnZoneExit: boolean;            // default: true
  // Tier control — allow disabling individual tiers
  tier1Enabled: boolean;               // default: true (CHoCH close-based)
  tier2Enabled: boolean;               // default: true (CHoCH wick + supporting)
  tier3Enabled: boolean;               // default: true (reversal pattern, no CHoCH)
  // Instrument-specific displacement override (optional)
  instrumentDisplacements?: Record<string, number>;
}

export const DEFAULT_ZONE_CONFIRMATION_CONFIG: ZoneConfirmationConfig = {
  enabled: true,
  confirmationTimeframe: "5m",
  minDisplacement: 0.4,
  requireCloseBased: true,
  maxLookbackCandles: 10,
  resetOnZoneExit: true,
  tier1Enabled: true,
  tier2Enabled: true,
  tier3Enabled: true,
};

/**
 * Instrument-specific displacement thresholds.
 * Metals and crypto have larger wicks relative to bodies, so we lower the bar.
 * Forex majors keep the standard threshold.
 */
const INSTRUMENT_DISPLACEMENT: Record<string, number> = {
  "XAU/USD": 0.30,   // Gold: huge wicks, 30% body is already meaningful
  "XAG/USD": 0.30,   // Silver: same as gold
  "US Oil":  0.35,   // Oil: moderate volatility
  "BTC/USD": 0.30,   // Bitcoin: extreme wicks
  "ETH/USD": 0.30,   // Ethereum: same as BTC
  // Forex majors/crosses: use default (0.4)
};

// ─── Helper: Get effective displacement threshold for an instrument ──────────

function getMinDisplacement(config: ZoneConfirmationConfig, symbol?: string): number {
  // User-configured per-instrument overrides take priority
  if (symbol && config.instrumentDisplacements?.[symbol] !== undefined) {
    return config.instrumentDisplacements[symbol];
  }
  // Built-in instrument-aware thresholds
  if (symbol && INSTRUMENT_DISPLACEMENT[symbol] !== undefined) {
    return INSTRUMENT_DISPLACEMENT[symbol];
  }
  return config.minDisplacement;
}

// ─── Supporting Signal Detection ─────────────────────────────────────────────

interface SupportingSignalResult {
  signals: string[];
  hasEngulfing: boolean;
  hasRejectionWick: boolean;
  hasFVG: boolean;
  hasVolumeSpike: boolean;
}

/**
 * Detect supporting signals around a specific candle.
 * Used by all tiers to annotate and qualify confirmation.
 */
function detectSupportingSignals(
  candles: Candle[],
  candleIndex: number,
  direction: "long" | "short",
): SupportingSignalResult {
  const signals: string[] = [];
  const candle = candles[candleIndex];
  if (!candle) return { signals, hasEngulfing: false, hasRejectionWick: false, hasFVG: false, hasVolumeSpike: false };

  const candleRange = candle.high - candle.low;
  if (candleRange === 0) return { signals, hasEngulfing: false, hasRejectionWick: false, hasFVG: false, hasVolumeSpike: false };

  let hasEngulfing = false;
  let hasRejectionWick = false;
  let hasFVG = false;
  let hasVolumeSpike = false;

  // 1. Engulfing pattern (candle engulfs previous candle body)
  if (candleIndex > 0) {
    const prev = candles[candleIndex - 1];
    if (prev) {
      const engulfs = direction === "short"
        ? (candle.open >= prev.close && candle.close <= prev.open)
        : (candle.open <= prev.close && candle.close >= prev.open);
      if (engulfs) { signals.push("engulfing"); hasEngulfing = true; }
    }
  }

  // 2. Rejection wick (>30% of range on the rejection side)
  if (direction === "short") {
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    if (upperWick / candleRange > 0.3) { signals.push("rejection_wick"); hasRejectionWick = true; }
  } else {
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    if (lowerWick / candleRange > 0.3) { signals.push("rejection_wick"); hasRejectionWick = true; }
  }

  // 3. FVG creation (gap between candle before and candle after)
  if (candleIndex > 0 && candleIndex < candles.length - 1) {
    const candleBefore = candles[candleIndex - 1];
    const candleAfter = candles[candleIndex + 1];
    if (candleBefore && candleAfter) {
      const gap = direction === "short"
        ? candleBefore.low > candleAfter.high  // bearish FVG
        : candleBefore.high < candleAfter.low; // bullish FVG
      if (gap) { signals.push("fvg_created"); hasFVG = true; }
    }
  }

  // 4. Volume spike (1.5× average of last 5 candles)
  if (candle.volume && candleIndex >= 5) {
    const recentVolumes = candles.slice(candleIndex - 5, candleIndex).map(c => c.volume || 0);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    if (avgVolume > 0 && candle.volume > avgVolume * 1.5) {
      signals.push("volume_spike"); hasVolumeSpike = true;
    }
  }

  return { signals, hasEngulfing, hasRejectionWick, hasFVG, hasVolumeSpike };
}

// ─── Hierarchy → Signal Adapter ─────────────────────────────────────────────

/**
 * Maps a ConfirmationResult from confirmationHierarchy to the ConfirmationSignal
 * format expected by callers. Returns null if the mapping isn't possible.
 */
function mapHierarchyToSignal(
  result: ConfirmationResult,
  candles: Candle[],
  direction: "long" | "short",
): ConfirmationSignal | null {
  const idx = result.confirmationIndex;
  if (idx === null || idx < 0 || idx >= candles.length) return null;

  const candle = candles[idx];
  if (!candle) return null;

  const range = candle.high - candle.low;
  const displacement = range > 0 ? Math.abs(candle.close - candle.open) / range : 0;

  // Map hierarchy types to zoneConfirmation types
  const typeMap: Record<string, { type: ConfirmationType; tier: 1 | 2 | 3; closeBased: boolean }> = {
    sweep_choch: {
      type: direction === "short" ? "bearish_choch" : "bullish_choch",
      tier: 1,
      closeBased: true,
    },
    ltf_choch: {
      type: direction === "short" ? "bearish_choch" : "bullish_choch",
      tier: 1,
      closeBased: true,
    },
    displacement: {
      type: direction === "short" ? "bearish_reversal_pattern" : "bullish_reversal_pattern",
      tier: 3,
      closeBased: false,
    },
  };

  const mapping = typeMap[result.type];
  if (!mapping) return null;

  return {
    type: mapping.type,
    tier: mapping.tier,
    price: candle.close,
    candleIndex: idx,
    displacement,
    significance: undefined,
    closeBased: mapping.closeBased,
    supportingSignals: [result.type, result.detail],
  };
}

// ─── Main Detection Function (Tiered) ───────────────────────────────────────

/**
 * Detect zone confirmation signal using tiered confirmation paths.
 * 
 * Returns the FIRST (strongest) confirmation found:
 *   Tier 1 → Tier 2 → Tier 3 (checked in order of strength)
 * 
 * @param candles5m - 5-minute candles (at least 20-30 for structure detection)
 * @param direction - "long" or "short" (the trade direction we want to confirm)
 * @param config - confirmation configuration
 * @param zoneTouchIndex - optional: the candle index when price first touched the zone
 * @param symbol - optional: instrument symbol for instrument-aware thresholds
 * @returns ConfirmationSignal if found, null otherwise
 */
export function detectZoneConfirmation(
  candles5m: Candle[],
  direction: "long" | "short",
  config: ZoneConfirmationConfig = DEFAULT_ZONE_CONFIRMATION_CONFIG,
  zoneTouchIndex?: number,
  symbol?: string,
  /** Optional zone bounds — when provided, delegates to confirmationHierarchy first */
  zoneBounds?: { zoneHigh: number; zoneLow: number },
): ConfirmationSignal | null {
  if (candles5m.length < 10) return null;

  // ── PRIMARY: Delegate to confirmationHierarchy when zone bounds available ──
  // This unifies CHoCH detection logic into one place.
  if (zoneBounds && candles5m.length >= 15) {
    const hierarchyDir = direction === "long" ? "bullish" : "bearish";
    const hierarchyResult = evaluateConfirmation({
      confirmationCandles: candles5m,
      zoneHigh: zoneBounds.zoneHigh,
      zoneLow: zoneBounds.zoneLow,
      direction: hierarchyDir,
      maxLookback: config.maxLookbackCandles,
    });
    // Map hierarchy result to ConfirmationSignal if entry-ready (CHoCH-level)
    if (hierarchyResult.entryReady && hierarchyResult.type !== "none") {
      const mapped = mapHierarchyToSignal(hierarchyResult, candles5m, direction);
      if (mapped) return mapped;
    }
  }

  // ── FALLBACK: Legacy tier detection (Tier 2 wick+support, Tier 3 reversal) ──
  // These patterns are not covered by confirmationHierarchy (which only does
  // close-based CHoCH and displacement). Keep them for broader coverage.
  const effectiveDisplacement = getMinDisplacement(config, symbol);
  const requiredChochType = direction === "short" ? "bearish" : "bullish";
  const minIndex = candles5m.length - 1 - config.maxLookbackCandles;
  const afterZoneTouch = zoneTouchIndex !== undefined ? zoneTouchIndex : 0;

  // Run market structure analysis on the 5m candles
  const structure = analyzeMarketStructure(candles5m);

  // Get all CHoCHs in the correct direction within the lookback window
  const allChochs = (structure.choch as Array<{
    index: number; type: "bullish" | "bearish"; price: number;
    closeBased: boolean; significance?: "internal" | "external";
  }>)
    .filter(c => c.type === requiredChochType)
    .filter(c => c.index >= minIndex)
    .filter(c => c.index >= afterZoneTouch)
    .sort((a, b) => b.index - a.index); // most recent first

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 1: Close-based CHoCH with sufficient displacement
  // The gold standard — candle body closes through structure level.
  // ═══════════════════════════════════════════════════════════════════════════
  if (config.tier1Enabled) {
    const closeBasedChochs = allChochs.filter(c => c.closeBased);
    for (const choch of closeBasedChochs) {
      const candle = candles5m[choch.index];
      if (!candle) continue;
      const range = candle.high - candle.low;
      if (range === 0) continue;
      const displacement = Math.abs(candle.close - candle.open) / range;
      if (displacement < effectiveDisplacement) continue;

      const supporting = detectSupportingSignals(candles5m, choch.index, direction);
      const significance = (choch as any).significance;
      if (significance === "external") supporting.signals.push("external_significance");

      return {
        type: requiredChochType === "bearish" ? "bearish_choch" : "bullish_choch",
        tier: 1,
        price: candle.close,
        candleIndex: choch.index,
        displacement,
        significance,
        closeBased: true,
        supportingSignals: supporting.signals,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 2: Wick-based CHoCH + at least 1 supporting signal
  // CHoCH happened (price broke structure) but only via wick, not body close.
  // Requires additional evidence that the reversal is real.
  // ═══════════════════════════════════════════════════════════════════════════
  if (config.tier2Enabled) {
    const wickChochs = allChochs.filter(c => !c.closeBased);
    for (const choch of wickChochs) {
      const candle = candles5m[choch.index];
      if (!candle) continue;
      const range = candle.high - candle.low;
      if (range === 0) continue;
      const displacement = Math.abs(candle.close - candle.open) / range;
      // Tier 2 uses a slightly lower displacement bar (80% of effective)
      if (displacement < effectiveDisplacement * 0.8) continue;

      const supporting = detectSupportingSignals(candles5m, choch.index, direction);
      const significance = (choch as any).significance;
      if (significance === "external") supporting.signals.push("external_significance");

      // Must have at least 1 supporting signal to qualify
      const supportCount = (supporting.hasEngulfing ? 1 : 0) +
        (supporting.hasRejectionWick ? 1 : 0) +
        (supporting.hasFVG ? 1 : 0) +
        (supporting.hasVolumeSpike ? 1 : 0);

      if (supportCount < 1) continue;

      return {
        type: requiredChochType === "bearish" ? "bearish_choch_relaxed" : "bullish_choch_relaxed",
        tier: 2,
        price: candle.close,
        candleIndex: choch.index,
        displacement,
        significance,
        closeBased: false,
        supportingSignals: supporting.signals,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 3: Reversal Pattern (no CHoCH required)
  // Strong reversal evidence without a structural break on 5m.
  // Requires: engulfing + rejection wick + displacement above threshold.
  // This IS a reversal — it just hasn't broken the 5m swing yet.
  // ═══════════════════════════════════════════════════════════════════════════
  if (config.tier3Enabled) {
    // Scan recent candles (within lookback window, after zone touch)
    const scanStart = Math.max(minIndex, afterZoneTouch);
    const scanEnd = candles5m.length;

    for (let i = scanEnd - 1; i >= scanStart; i--) {
      const candle = candles5m[i];
      if (!candle) continue;
      const range = candle.high - candle.low;
      if (range === 0) continue;
      const displacement = Math.abs(candle.close - candle.open) / range;

      // Tier 3 requires stronger displacement than Tier 1/2 to compensate
      // for the lack of structural break
      if (displacement < effectiveDisplacement) continue;

      // Must be a candle in the correct direction
      const isBearishCandle = candle.close < candle.open;
      const isBullishCandle = candle.close > candle.open;
      if (direction === "short" && !isBearishCandle) continue;
      if (direction === "long" && !isBullishCandle) continue;

      const supporting = detectSupportingSignals(candles5m, i, direction);

      // Tier 3 requires BOTH engulfing AND rejection wick
      if (!supporting.hasEngulfing || !supporting.hasRejectionWick) continue;

      return {
        type: direction === "short" ? "bearish_reversal_pattern" : "bullish_reversal_pattern",
        tier: 3,
        price: candle.close,
        candleIndex: i,
        displacement,
        significance: undefined,
        closeBased: false, // no structural break
        supportingSignals: supporting.signals,
      };
    }
  }

  // No confirmation found at any tier
  return null;
}

// ─── Zone Boundary Check ─────────────────────────────────────────────────────

/**
 * Check if price is still within the zone boundaries.
 * Used to determine if confirmation hunting should continue or reset.
 * 
 * @param currentPrice - current live price
 * @param zoneLow - lower boundary of the entry zone
 * @param zoneHigh - upper boundary of the entry zone
 * @param direction - trade direction
 * @param atr - ATR value for proximity buffer (optional)
 * @returns true if price is still in/near the zone
 */
export function isPriceInZone(
  currentPrice: number,
  zoneLow: number,
  zoneHigh: number,
  direction: "long" | "short",
  atr?: number,
): boolean {
  // Add a small buffer (10% of zone width or ATR-based) to avoid premature resets
  // from minor wicks outside the zone
  const zoneWidth = zoneHigh - zoneLow;
  const buffer = atr ? atr * 0.2 : zoneWidth * 0.1;

  if (direction === "short") {
    return currentPrice >= (zoneLow - buffer) && currentPrice <= (zoneHigh + buffer);
  } else {
    return currentPrice >= (zoneLow - buffer) && currentPrice <= (zoneHigh + buffer);
  }
}

// ─── Impulse Invalidation Check ──────────────────────────────────────────────

/**
 * Check if the impulse leg has been broken (zone invalidation).
 * If the impulse origin is broken, the zone is dead and we should cancel.
 * 
 * @param currentPrice - current live price
 * @param impulseHigh - high of the impulse leg
 * @param impulseLow - low of the impulse leg
 * @param direction - trade direction
 * @returns true if impulse is broken (should cancel)
 */
export function isImpulseBroken(
  currentPrice: number,
  impulseHigh: number,
  impulseLow: number,
  direction: "long" | "short",
): boolean {
  if (direction === "short") {
    return currentPrice > impulseHigh;
  } else {
    return currentPrice < impulseLow;
  }
}

// ─── Confirmation Summary (for Telegram/logging) ─────────────────────────────

/**
 * Generate a human-readable summary of the confirmation signal.
 */
export function formatConfirmationSummary(signal: ConfirmationSignal): string {
  const tierLabels: Record<number, string> = { 1: "T1:CHoCH", 2: "T2:CHoCH+", 3: "T3:Reversal" };
  const tierLabel = tierLabels[signal.tier] || "T?";

  const typeLabels: Record<string, string> = {
    "bearish_choch": "Bearish CHoCH",
    "bullish_choch": "Bullish CHoCH",
    "bearish_choch_relaxed": "Bearish CHoCH (wick)",
    "bullish_choch_relaxed": "Bullish CHoCH (wick)",
    "bearish_reversal_pattern": "Bearish Reversal",
    "bullish_reversal_pattern": "Bullish Reversal",
  };
  const typeLabel = typeLabels[signal.type] || signal.type;

  const strengthLabel = signal.displacement >= 0.7 ? "strong"
    : signal.displacement >= 0.5 ? "moderate"
    : signal.displacement >= 0.35 ? "adequate"
    : "minimal";

  const extras = signal.supportingSignals.length > 0
    ? ` | ${signal.supportingSignals.join(", ")}`
    : "";

  return `[${tierLabel}] ${typeLabel} @ ${signal.price.toFixed(5)} (${strengthLabel}, disp: ${(signal.displacement * 100).toFixed(0)}%${signal.significance === "external" ? ", EXTERNAL" : ""}${extras})`;
}
