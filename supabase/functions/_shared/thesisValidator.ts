/**
 * thesisValidator.ts — Pending Order Thesis Validation
 * ─────────────────────────────────────────────────────
 * Re-checks structural conditions for active pending orders each scan cycle.
 * Three checks:
 *   1. Direction Flip (HARD cancel) — D1/4H/1H structure reversed
 *   2. FOTSI Veto (HARD cancel) — currency exhaustion would block entry now
 *   3. Game Plan Bias Reversal (SOFT cancel) — session bias flipped with high confidence
 *
 * Design principle: FAIL-OPEN. If any check errors or data is missing,
 * the order stays alive. Only cancel on confirmed invalidation.
 *
 * Run: deno test --allow-all supabase/functions/_shared/thesisValidator.test.ts
 */

import { determineDirection, type DirectionResult } from "./directionEngine.ts";
import {
  checkOverboughtOversoldVeto,
  parsePairCurrencies,
  type FOTSIResult,
  type VetoResult,
} from "./fotsi.ts";
import type { Candle } from "./smcAnalysis.ts";
import type { SessionGamePlan, InstrumentGamePlan } from "./gamePlan.ts";

// ── Public types ──

export type ThesisCheckType = "direction_flip" | "fotsi_veto" | "gp_bias_reversal";

export interface ThesisValidationResult {
  /** Whether the pending order thesis is still valid */
  valid: boolean;
  /** Human-readable reason for invalidation (null if valid) */
  reason: string | null;
  /** Which check triggered the invalidation (null if valid) */
  checkType: ThesisCheckType | null;
  /** Structured cancel reason string for DB storage */
  cancelReason: string | null;
}

export interface PendingOrderForValidation {
  order_id: string;
  symbol: string;
  direction: "long" | "short";
  entry_price: number | string;
  signal_reason?: any;
}

export interface ThesisValidationOpts {
  fotsiResult: FOTSIResult | null;
  lastGamePlan: SessionGamePlan | null;
  dailyCandles: Candle[] | null;
  h4Candles: Candle[] | null;
  h1Candles: Candle[] | null;
  /** Minimum confidence for direction flip to trigger cancel (default: 0.6) */
  directionFlipMinConfidence?: number;
  /** Minimum GP bias confidence to trigger cancel (default: 60) */
  gpBiasMinConfidence?: number;
}

// ── Constants ──

const DEFAULT_DIRECTION_FLIP_MIN_CONFIDENCE = 0.6;
const DEFAULT_GP_BIAS_MIN_CONFIDENCE = 60;
const MIN_CANDLES_FOR_DIRECTION = 20;

// ── Helpers ──

/**
 * Determine a "confidence" score for the direction result.
 * The direction engine doesn't return a numeric confidence, so we derive one
 * from the structural signals:
 *   - h1Confirmed = +0.3
 *   - h4Retrace = +0.2 (structure intact, pulling back)
 *   - !h4ChochAgainst = +0.2 (no counter-CHoCH)
 *   - direction != null = +0.3 (base confidence)
 */
export function estimateDirectionConfidence(result: DirectionResult): number {
  if (!result.direction) return 0;
  let confidence = 0.3; // base: direction was determined
  if (result.h1Confirmed) confidence += 0.3;
  if (result.h4Retrace) confidence += 0.2;
  if (!result.h4ChochAgainst) confidence += 0.2;
  return confidence;
}

/**
 * Check if a game plan bias opposes the pending order direction.
 */
function biasOpposesDirection(
  bias: "bullish" | "bearish" | "neutral",
  direction: "long" | "short",
): boolean {
  if (bias === "neutral") return false;
  if (direction === "long" && bias === "bearish") return true;
  if (direction === "short" && bias === "bullish") return true;
  return false;
}

// ── Main validation function ──

/**
 * Validate whether a pending order's original thesis is still intact.
 *
 * Runs three checks in order (cheapest first):
 *   1. FOTSI veto (no extra API calls — uses pre-computed result)
 *   2. GP bias reversal (no extra API calls — uses pre-loaded game plan)
 *   3. Direction flip (requires candle data — may use cached candles)
 *
 * Returns { valid: true } if all checks pass or if data is unavailable (fail-open).
 */
export function validatePendingOrderThesis(
  pending: PendingOrderForValidation,
  opts: ThesisValidationOpts,
): ThesisValidationResult {
  const dirFlipMinConf = opts.directionFlipMinConfidence ?? DEFAULT_DIRECTION_FLIP_MIN_CONFIDENCE;
  const gpBiasMinConf = opts.gpBiasMinConfidence ?? DEFAULT_GP_BIAS_MIN_CONFIDENCE;

  const validResult: ThesisValidationResult = {
    valid: true,
    reason: null,
    checkType: null,
    cancelReason: null,
  };

  // ── Check 1: FOTSI Veto ──
  // Cheapest check — uses pre-computed FOTSI result, zero API cost
  if (opts.fotsiResult && opts.fotsiResult.strengths) {
    try {
      const currencies = parsePairCurrencies(pending.symbol);
      if (currencies) {
        const [base, quote] = currencies;
        const fotsiDirection = pending.direction === "long" ? "BUY" : "SELL";
        const vetoResult: VetoResult = checkOverboughtOversoldVeto(
          base,
          quote,
          fotsiDirection as "BUY" | "SELL",
          opts.fotsiResult.strengths,
          opts.fotsiResult.series,
        );
        if (vetoResult.vetoed) {
          const baseTSI = opts.fotsiResult.strengths[base] ?? 0;
          const exhaustionType = pending.direction === "long" ? "overbought" : "oversold";
          return {
            valid: false,
            reason: `FOTSI thesis invalidation: ${vetoResult.reason}`,
            checkType: "fotsi_veto",
            cancelReason: `thesis_invalid:fotsi_veto:${base}_${exhaustionType}_${baseTSI.toFixed(0)}`,
          };
        }
      }
    } catch (e) {
      // Fail-open: FOTSI check errored, keep order alive
      console.warn(`[thesis-validator] FOTSI check error for ${pending.symbol}: ${(e as Error)?.message}`);
    }
  }

  // ── Check 2: Game Plan Bias Reversal ──
  // Uses pre-loaded game plan — zero API cost
  if (opts.lastGamePlan && opts.lastGamePlan.plans) {
    try {
      const pairPlan: InstrumentGamePlan | undefined = opts.lastGamePlan.plans.find(
        (p) => p.symbol === pending.symbol,
      );
      if (pairPlan && pairPlan.biasConfidence >= gpBiasMinConf) {
        if (biasOpposesDirection(pairPlan.bias, pending.direction)) {
          return {
            valid: false,
            reason: `Game plan bias reversal: ${opts.lastGamePlan.session} session bias is ${pairPlan.bias} (confidence ${pairPlan.biasConfidence}%) — opposes ${pending.direction} order`,
            checkType: "gp_bias_reversal",
            cancelReason: `thesis_invalid:gp_bias_reversal:${opts.lastGamePlan.session}:${pairPlan.bias}:${pairPlan.biasConfidence}`,
          };
        }
      }
    } catch (e) {
      // Fail-open: GP check errored, keep order alive
      console.warn(`[thesis-validator] GP bias check error for ${pending.symbol}: ${(e as Error)?.message}`);
    }
  }

  // ── Check 3: Direction Flip ──
  // Most expensive check — requires candle data (but may be cached)
  const hasDaily = opts.dailyCandles && opts.dailyCandles.length >= MIN_CANDLES_FOR_DIRECTION;
  const hasH4 = opts.h4Candles && opts.h4Candles.length >= MIN_CANDLES_FOR_DIRECTION;
  const hasH1 = opts.h1Candles && opts.h1Candles.length >= MIN_CANDLES_FOR_DIRECTION;

  // Need at least daily or h4 candles to run direction check
  if (hasDaily || hasH4) {
    try {
      const dirResult = determineDirection(
        hasDaily ? opts.dailyCandles : null,
        hasH4 ? opts.h4Candles : null,
        hasH1 ? opts.h1Candles : null,
      );

      // Only invalidate if direction is determined AND it's opposite AND confidence is high enough
      if (dirResult.direction !== null && dirResult.direction !== pending.direction) {
        const confidence = estimateDirectionConfidence(dirResult);
        if (confidence >= dirFlipMinConf) {
          return {
            valid: false,
            reason: `Direction flip: structure now indicates ${dirResult.direction} (confidence ${(confidence * 100).toFixed(0)}%) — opposes ${pending.direction} order. ${dirResult.reason}`,
            checkType: "direction_flip",
            cancelReason: `thesis_invalid:direction_flip:${dirResult.direction}:${(confidence * 100).toFixed(0)}`,
          };
        }
      }
    } catch (e) {
      // Fail-open: direction check errored, keep order alive
      console.warn(`[thesis-validator] Direction check error for ${pending.symbol}: ${(e as Error)?.message}`);
    }
  }

  return validResult;
}
