/**
 * ictDisplacementMSS.ts — ICT Displacement-Validated Market Structure Shift
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ICT Rule: A Market Structure Shift (MSS) is ONLY valid if the break candle(s)
 * show displacement — large-bodied, aggressive candles that demonstrate institutional
 * commitment. A sluggish break (small bodies, lots of wicks) is NOT a valid MSS.
 *
 * This module validates structure breaks by checking if the breaking candle(s)
 * exhibit displacement characteristics:
 *   1. Body/range ratio >= threshold (default 0.6) — strong directional candle
 *   2. Range >= 1.2x ATR — above-average movement
 *   3. Consecutive displacement candles strengthen the signal
 *
 * Gate modes: "hard" | "soft" | "off"
 *   - hard: MSS without displacement is rejected (trade skipped)
 *   - soft: MSS without displacement gets a score penalty
 *   - off: logs only, no impact
 */

import type { Candle } from "./smcAnalysis.ts";

// ─── Configuration ────────────────────────────────────────────────────
export interface DisplacementMSSConfig {
  enabled: boolean;
  gateMode: "hard" | "soft" | "off";
  /** Minimum body/range ratio for a candle to qualify as displacement */
  minBodyRatio: number;
  /** Minimum range/ATR multiple for displacement */
  minRangeATRMult: number;
  /** How many candles before/after the break to check for displacement */
  lookbackCandles: number;
  /** Score penalty when MSS lacks displacement (soft mode) */
  noDisplacementPenalty: number;
  /** Score bonus when MSS has strong displacement */
  strongDisplacementBonus: number;
}

export const DEFAULT_DISPLACEMENT_MSS_CONFIG: DisplacementMSSConfig = {
  enabled: true,
  gateMode: "off",
  minBodyRatio: 0.6,
  minRangeATRMult: 1.2,
  lookbackCandles: 3,
  noDisplacementPenalty: -2.0,
  strongDisplacementBonus: 1.0,
};

// ─── Types ────────────────────────────────────────────────────────────
export interface DisplacementCandidate {
  index: number;
  bodyRatio: number;
  rangeATRMult: number;
  direction: "bullish" | "bearish";
  isStrong: boolean; // meets both criteria with margin
}

export interface MSSValidationResult {
  isValid: boolean;
  hasDisplacement: boolean;
  displacementStrength: "strong" | "moderate" | "weak" | "none";
  displacementCandles: DisplacementCandidate[];
  /** Number of consecutive displacement candles in the break direction */
  consecutiveCount: number;
  scoreAdjustment: number;
  passed: boolean; // gate decision
  reason: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function calculateATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) {
    // Fallback: use average range of available candles
    const ranges = candles.map(c => c.high - c.low).filter(r => r > 0);
    return ranges.length > 0 ? ranges.reduce((a, b) => a + b, 0) / ranges.length : 0;
  }
  let atrSum = 0;
  const start = candles.length - period;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    atrSum += tr;
  }
  return atrSum / period;
}

/**
 * Check if a single candle qualifies as a displacement candle
 */
function isDisplacementCandle(
  candle: Candle,
  atr: number,
  config: DisplacementMSSConfig,
): DisplacementCandidate | null {
  const range = candle.high - candle.low;
  if (range <= 0 || atr <= 0) return null;

  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = body / range;
  const rangeATRMult = range / atr;
  const direction: "bullish" | "bearish" = candle.close > candle.open ? "bullish" : "bearish";

  if (bodyRatio >= config.minBodyRatio && rangeATRMult >= config.minRangeATRMult) {
    const isStrong = bodyRatio >= 0.75 && rangeATRMult >= 1.5;
    return { index: -1, bodyRatio, rangeATRMult, direction, isStrong };
  }
  return null;
}

// ─── Main Validation Function ─────────────────────────────────────────

/**
 * Validate whether a Market Structure Shift has displacement.
 *
 * @param candles - Full candle array
 * @param breakIndex - Index of the candle that broke structure
 * @param breakDirection - Direction of the break ("bullish" = broke above, "bearish" = broke below)
 * @param config - Configuration
 * @returns Validation result with gate decision
 */
export function validateMSSDisplacement(
  candles: Candle[],
  breakIndex: number,
  breakDirection: "bullish" | "bearish",
  config: DisplacementMSSConfig = DEFAULT_DISPLACEMENT_MSS_CONFIG,
): MSSValidationResult {
  const noDisplacement: MSSValidationResult = {
    isValid: false,
    hasDisplacement: false,
    displacementStrength: "none",
    displacementCandles: [],
    consecutiveCount: 0,
    scoreAdjustment: 0,
    passed: true,
    reason: "",
  };

  if (!config.enabled) {
    return { ...noDisplacement, isValid: true, passed: true, reason: "Displacement MSS validation disabled" };
  }

  if (breakIndex < 0 || breakIndex >= candles.length) {
    return { ...noDisplacement, passed: true, reason: "Invalid break index" };
  }

  // Calculate ATR using candles before the break
  const atrWindow = candles.slice(0, breakIndex);
  const atr = calculateATR(atrWindow);
  if (atr <= 0) {
    return { ...noDisplacement, passed: true, reason: "Cannot calculate ATR" };
  }

  // Check candles around the break point for displacement
  const startIdx = Math.max(0, breakIndex - config.lookbackCandles);
  const endIdx = Math.min(candles.length - 1, breakIndex + 1); // include break candle + 1 after
  const displacementCandles: DisplacementCandidate[] = [];

  for (let i = startIdx; i <= endIdx; i++) {
    const candidate = isDisplacementCandle(candles[i], atr, config);
    if (candidate && candidate.direction === breakDirection) {
      displacementCandles.push({ ...candidate, index: i });
    }
  }

  // Count consecutive displacement candles in the break direction
  let consecutiveCount = 0;
  let maxConsecutive = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    const candidate = isDisplacementCandle(candles[i], atr, config);
    if (candidate && candidate.direction === breakDirection) {
      consecutiveCount++;
      maxConsecutive = Math.max(maxConsecutive, consecutiveCount);
    } else {
      consecutiveCount = 0;
    }
  }

  const hasDisplacement = displacementCandles.length > 0;
  const hasStrong = displacementCandles.some(d => d.isStrong);

  // Determine strength
  let displacementStrength: "strong" | "moderate" | "weak" | "none" = "none";
  if (hasStrong && maxConsecutive >= 2) {
    displacementStrength = "strong";
  } else if (hasDisplacement && (hasStrong || maxConsecutive >= 2)) {
    displacementStrength = "moderate";
  } else if (hasDisplacement) {
    displacementStrength = "weak";
  }

  // Gate decision
  let passed = true;
  let scoreAdjustment = 0;
  let reason = "";

  if (config.gateMode === "off") {
    // Log only — always pass, no score adjustment
    passed = true;
    scoreAdjustment = 0;
    reason = hasDisplacement
      ? `[OFF] MSS has ${displacementStrength} displacement (${displacementCandles.length} candles, ${maxConsecutive} consecutive)`
      : `[OFF] MSS lacks displacement — would have ${config.gateMode === "hard" ? "blocked" : "penalized"}`;
  } else if (!hasDisplacement) {
    // No displacement on the break
    if (config.gateMode === "hard") {
      passed = false;
      reason = `MSS BLOCKED: no displacement on ${breakDirection} break at index ${breakIndex}`;
    } else {
      // soft mode
      passed = true;
      scoreAdjustment = config.noDisplacementPenalty;
      reason = `MSS lacks displacement: ${config.noDisplacementPenalty} penalty applied`;
    }
  } else {
    // Has displacement
    passed = true;
    if (displacementStrength === "strong") {
      scoreAdjustment = config.strongDisplacementBonus;
      reason = `MSS confirmed with strong displacement (+${config.strongDisplacementBonus})`;
    } else {
      reason = `MSS confirmed with ${displacementStrength} displacement`;
    }
  }

  return {
    isValid: hasDisplacement,
    hasDisplacement,
    displacementStrength,
    displacementCandles,
    consecutiveCount: maxConsecutive,
    scoreAdjustment,
    passed,
    reason,
  };
}

// ─── Batch Validation ─────────────────────────────────────────────────

/**
 * Validate multiple structure breaks at once.
 * Returns the validation for the most recent break (most relevant for trade decision).
 */
export function validateRecentMSS(
  candles: Candle[],
  breaks: { index: number; type: "bullish" | "bearish" }[],
  tradeDirection: "bullish" | "bearish",
  config: DisplacementMSSConfig = DEFAULT_DISPLACEMENT_MSS_CONFIG,
): MSSValidationResult {
  if (!config.enabled || breaks.length === 0) {
    return {
      isValid: true,
      hasDisplacement: false,
      displacementStrength: "none",
      displacementCandles: [],
      consecutiveCount: 0,
      scoreAdjustment: 0,
      passed: true,
      reason: config.enabled ? "No structure breaks to validate" : "Disabled",
    };
  }

  // Filter breaks that align with trade direction
  const alignedBreaks = breaks.filter(b => b.type === tradeDirection);
  if (alignedBreaks.length === 0) {
    return {
      isValid: false,
      hasDisplacement: false,
      displacementStrength: "none",
      displacementCandles: [],
      consecutiveCount: 0,
      scoreAdjustment: config.gateMode === "hard" ? 0 : config.noDisplacementPenalty,
      passed: config.gateMode !== "hard",
      reason: `No ${tradeDirection} structure breaks found`,
    };
  }

  // Validate the most recent aligned break
  const mostRecent = alignedBreaks.reduce((latest, b) => b.index > latest.index ? b : latest);
  return validateMSSDisplacement(candles, mostRecent.index, mostRecent.type, config);
}
