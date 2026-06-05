/**
 * ictFVGInvalidation.ts — ICT FVG Invalidation Rules
 * ═══════════════════════════════════════════════════
 *
 * ICT Rule: A Fair Value Gap is invalidated when a candle BODY closes completely
 * through the FVG. Wicks passing through don't count — only body closes.
 *
 * Additional ICT FVG rules:
 *   1. "Consequent Encroachment" — price reaching the 50% midpoint of the FVG
 *      is a reaction point but doesn't invalidate
 *   2. "FVG Rule of 2" — after price touches an FVG twice without follow-through,
 *      the FVG is considered exhausted (lower probability)
 *   3. FVGs created by displacement candles are higher quality
 *   4. Only the FIRST return to an FVG is the highest probability entry
 *
 * Gate modes: "hard" | "soft" | "off"
 */

import type { Candle } from "./smcAnalysis.ts";

// ─── Configuration ────────────────────────────────────────────────────
export interface FVGInvalidationConfig {
  enabled: boolean;
  gateMode: "hard" | "soft" | "off";
  /** Use body close (ICT strict) vs any close for invalidation */
  bodyCloseOnly: boolean;
  /** Enable Rule of 2 (FVG touched twice = exhausted) */
  ruleOfTwo: boolean;
  /** Score penalty for using an exhausted FVG (Rule of 2) */
  exhaustedPenalty: number;
  /** Score penalty for using an invalidated FVG */
  invalidatedPenalty: number;
  /** Bonus for first-touch FVG (highest probability) */
  firstTouchBonus: number;
}

export const DEFAULT_FVG_INVALIDATION_CONFIG: FVGInvalidationConfig = {
  enabled: true,
  gateMode: "off",
  bodyCloseOnly: true,
  ruleOfTwo: true,
  exhaustedPenalty: -1.5,
  invalidatedPenalty: -3.0,
  firstTouchBonus: 0.5,
};

// ─── Types ────────────────────────────────────────────────────────────
export interface FVGForValidation {
  index: number;
  high: number;
  low: number;
  type: "bullish" | "bearish";
  midpoint: number; // consequent encroachment level
}

export type FVGStatus = "fresh" | "first_touch" | "exhausted" | "invalidated";

export interface FVGValidationResult {
  fvg: FVGForValidation;
  status: FVGStatus;
  touchCount: number;
  invalidatedAtIndex: number | null;
  consequentEncroachmentReached: boolean;
  scoreAdjustment: number;
  passed: boolean;
  reason: string;
}

export interface BatchFVGValidationResult {
  results: FVGValidationResult[];
  bestFVG: FVGValidationResult | null;
  totalScoreAdjustment: number;
  passed: boolean;
  reason: string;
}

// ─── Main Validation Function ─────────────────────────────────────────

/**
 * Validate a single FVG against subsequent candles using ICT rules.
 *
 * @param fvg - The FVG to validate
 * @param candles - Full candle array
 * @param config - Configuration
 */
export function validateFVG(
  fvg: FVGForValidation,
  candles: Candle[],
  config: FVGInvalidationConfig = DEFAULT_FVG_INVALIDATION_CONFIG,
): FVGValidationResult {
  const noResult: FVGValidationResult = {
    fvg,
    status: "fresh",
    touchCount: 0,
    invalidatedAtIndex: null,
    consequentEncroachmentReached: false,
    scoreAdjustment: 0,
    passed: true,
    reason: "",
  };

  if (!config.enabled) {
    return { ...noResult, reason: "FVG invalidation disabled" };
  }

  let touchCount = 0;
  let invalidatedAtIndex: number | null = null;
  let consequentEncroachmentReached = false;

  // Walk through candles after the FVG was created
  for (let i = fvg.index + 3; i < candles.length; i++) {
    const c = candles[i];
    const bodyHigh = Math.max(c.open, c.close);
    const bodyLow = Math.min(c.open, c.close);

    if (fvg.type === "bullish") {
      // Bullish FVG: gap is between fvg.low and fvg.high
      // Price coming DOWN into the FVG = testing it
      // Invalidation: candle body closes BELOW fvg.low (completely through)

      // Check if price entered the FVG zone
      if (c.low <= fvg.high) {
        // Price touched or entered the FVG
        if (touchCount === 0 || (i - fvg.index) > 3) {
          // Only count distinct touches (not consecutive candles in the same touch)
          const prevCandle = candles[i - 1];
          if (prevCandle.low > fvg.high) {
            touchCount++;
          }
        }
      }

      // Check consequent encroachment (50% midpoint)
      if (c.low <= fvg.midpoint) {
        consequentEncroachmentReached = true;
      }

      // Check invalidation: body close below the FVG low
      if (config.bodyCloseOnly) {
        if (bodyLow < fvg.low && c.close < fvg.low) {
          invalidatedAtIndex = i;
          break;
        }
      } else {
        if (c.close < fvg.low) {
          invalidatedAtIndex = i;
          break;
        }
      }
    } else {
      // Bearish FVG: gap is between fvg.low and fvg.high
      // Price coming UP into the FVG = testing it
      // Invalidation: candle body closes ABOVE fvg.high (completely through)

      if (c.high >= fvg.low) {
        if (touchCount === 0 || (i - fvg.index) > 3) {
          const prevCandle = candles[i - 1];
          if (prevCandle.high < fvg.low) {
            touchCount++;
          }
        }
      }

      if (c.high >= fvg.midpoint) {
        consequentEncroachmentReached = true;
      }

      if (config.bodyCloseOnly) {
        if (bodyHigh > fvg.high && c.close > fvg.high) {
          invalidatedAtIndex = i;
          break;
        }
      } else {
        if (c.close > fvg.high) {
          invalidatedAtIndex = i;
          break;
        }
      }
    }
  }

  // Determine status
  let status: FVGStatus = "fresh";
  if (invalidatedAtIndex !== null) {
    status = "invalidated";
  } else if (config.ruleOfTwo && touchCount >= 2) {
    status = "exhausted";
  } else if (touchCount === 1) {
    status = "first_touch";
  }

  // If first entry into FVG and no prior touch, it's still fresh
  if (touchCount === 0) {
    status = "fresh";
  }

  // Gate decision
  let passed = true;
  let scoreAdjustment = 0;
  let reason = "";

  if (config.gateMode === "off") {
    passed = true;
    scoreAdjustment = 0;
    reason = `[OFF] FVG status: ${status} (touches: ${touchCount}, CE: ${consequentEncroachmentReached})`;
  } else if (status === "invalidated") {
    if (config.gateMode === "hard") {
      passed = false;
      reason = `FVG INVALIDATED: body closed through at candle ${invalidatedAtIndex}`;
    } else {
      passed = true;
      scoreAdjustment = config.invalidatedPenalty;
      reason = `FVG invalidated: ${config.invalidatedPenalty} penalty`;
    }
  } else if (status === "exhausted") {
    if (config.gateMode === "hard") {
      passed = false;
      reason = `FVG EXHAUSTED: Rule of 2 — touched ${touchCount} times without follow-through`;
    } else {
      passed = true;
      scoreAdjustment = config.exhaustedPenalty;
      reason = `FVG exhausted (Rule of 2): ${config.exhaustedPenalty} penalty`;
    }
  } else if (status === "fresh") {
    passed = true;
    scoreAdjustment = config.firstTouchBonus;
    reason = `FVG fresh — first touch entry (+${config.firstTouchBonus})`;
  } else if (status === "first_touch") {
    passed = true;
    reason = `FVG first touch — valid entry`;
  }

  return {
    fvg,
    status,
    touchCount,
    invalidatedAtIndex,
    consequentEncroachmentReached,
    scoreAdjustment,
    passed,
    reason,
  };
}

// ─── Batch Validation ─────────────────────────────────────────────────

/**
 * Validate multiple FVGs and return the best one for entry.
 * Filters out invalidated/exhausted FVGs and ranks by quality.
 */
export function validateFVGBatch(
  fvgs: FVGForValidation[],
  candles: Candle[],
  tradeDirection: "bullish" | "bearish",
  config: FVGInvalidationConfig = DEFAULT_FVG_INVALIDATION_CONFIG,
): BatchFVGValidationResult {
  if (!config.enabled || fvgs.length === 0) {
    return {
      results: [],
      bestFVG: null,
      totalScoreAdjustment: 0,
      passed: true,
      reason: config.enabled ? "No FVGs to validate" : "FVG invalidation disabled",
    };
  }

  // Filter FVGs by trade direction
  const directionFVGs = fvgs.filter(f => f.type === tradeDirection);
  if (directionFVGs.length === 0) {
    return {
      results: [],
      bestFVG: null,
      totalScoreAdjustment: 0,
      passed: true,
      reason: `No ${tradeDirection} FVGs found`,
    };
  }

  const results = directionFVGs.map(fvg => validateFVG(fvg, candles, config));

  // Find the best valid FVG (fresh > first_touch, most recent)
  const validResults = results.filter(r => r.status === "fresh" || r.status === "first_touch");
  const bestFVG = validResults.length > 0
    ? validResults.reduce((best, r) => {
        // Prefer fresh over first_touch
        if (r.status === "fresh" && best.status !== "fresh") return r;
        if (best.status === "fresh" && r.status !== "fresh") return best;
        // Among same status, prefer most recent
        return r.fvg.index > best.fvg.index ? r : best;
      })
    : null;

  // If no valid FVGs remain, apply gate logic
  let passed = true;
  let totalScoreAdjustment = bestFVG ? bestFVG.scoreAdjustment : 0;
  let reason = "";

  if (!bestFVG && results.length > 0) {
    // All FVGs are invalidated or exhausted
    if (config.gateMode === "hard") {
      passed = false;
      reason = `All ${tradeDirection} FVGs invalidated/exhausted (${results.length} checked)`;
    } else if (config.gateMode === "soft") {
      passed = true;
      totalScoreAdjustment = config.invalidatedPenalty;
      reason = `All FVGs invalidated/exhausted: ${config.invalidatedPenalty} penalty`;
    } else {
      passed = true;
      reason = `[OFF] All FVGs invalidated/exhausted — would have penalized`;
    }
  } else if (bestFVG) {
    reason = bestFVG.reason;
  }

  return { results, bestFVG, totalScoreAdjustment, passed, reason };
}

// ─── Utility: Convert existing FVG data to validation format ──────────

/**
 * Convert the bot's existing FVG objects to the format needed for validation.
 */
export function toFVGForValidation(fvg: {
  index: number;
  high: number;
  low: number;
  type: "bullish" | "bearish";
}): FVGForValidation {
  return {
    index: fvg.index,
    high: fvg.high,
    low: fvg.low,
    type: fvg.type,
    midpoint: (fvg.high + fvg.low) / 2,
  };
}
