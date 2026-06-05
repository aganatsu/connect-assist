/**
 * ictHTFIntegration.ts — ICT Higher Timeframe Integration Layer
 * ──────────────────────────────────────────────────────────────
 * Orchestrates the Weekly Bias + Daily Impulse + Containment logic
 * for use by bot-scanner. This module:
 *
 *   1. Runs weekly bias analysis (once per scan, shared across all pairs)
 *   2. Runs daily impulse/OB detection (per pair)
 *   3. Performs containment check (is the LTF zone inside the Daily OB?)
 *   4. Returns a unified result that the scanner can use as a gate or score modifier
 *
 * Integration modes (configurable):
 *   - "hard": Weekly bias must align + LTF zone must be contained in Daily OB → skip if not
 *   - "soft": Score bonus/penalty based on alignment and containment
 *   - "off": Disabled (pure informational logging)
 */
import type { Candle } from "./smcAnalysis.ts";
import { analyzeWeeklyBiasAndDOL, type WeeklyBiasResult } from "./weeklyBiasDOL.ts";
import { analyzeDailyImpulse, checkContainment, type DailyImpulseResult, type DailyOB, type ContainmentResult } from "./dailyImpulseOB.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ICTHTFConfig {
  /** Enable/disable the ICT HTF framework. Default: true */
  ictHTFEnabled: boolean;
  /** Gate mode: "hard" = skip if not aligned, "soft" = score adjustment, "off" = disabled */
  ictHTFGateMode: "hard" | "soft" | "off";
  /** Score bonus when fully aligned (weekly + daily + contained). Default: 2.0 */
  ictHTFAlignedBonus: number;
  /** Score penalty when misaligned. Default: 3.0 */
  ictHTFMisalignedPenalty: number;
  /** Minimum containment overlap percent. Default: 50 */
  ictHTFMinContainment: number;
  /** Whether weekly bias is required to match trade direction. Default: true */
  ictWeeklyBiasRequired: boolean;
  /** Whether daily OB containment is required. Default: true */
  ictDailyContainmentRequired: boolean;
}

export const DEFAULT_ICT_HTF_CONFIG: ICTHTFConfig = {
  ictHTFEnabled: true,
  ictHTFGateMode: "soft",  // Start soft — user can switch to hard once validated
  ictHTFAlignedBonus: 2.0,
  ictHTFMisalignedPenalty: 3.0,
  ictHTFMinContainment: 50,
  ictWeeklyBiasRequired: true,
  ictDailyContainmentRequired: true,
};

export interface ICTHTFResult {
  /** Did the ICT HTF check pass? */
  passed: boolean;
  /** Weekly bias analysis result */
  weeklyBias: WeeklyBiasResult | null;
  /** Daily impulse analysis result */
  dailyImpulse: DailyImpulseResult | null;
  /** Containment check result (if a zone was provided) */
  containment: ContainmentResult | null;
  /** The Daily OB being used (if any) */
  dailyOB: DailyOB | null;
  /** Is weekly bias aligned with trade direction? */
  weeklyAligned: boolean;
  /** Is the LTF zone contained within the Daily OB? */
  zoneContained: boolean;
  /** Score adjustment to apply (positive = bonus, negative = penalty) */
  scoreAdjustment: number;
  /** Human-readable gate reason */
  reason: string;
  /** Detailed reasons for logging */
  details: string[];
}

// ─── Main Integration Function ────────────────────────────────────────────────

/**
 * runICTHTFAnalysis — Full ICT higher-timeframe analysis for a single pair.
 *
 * @param weeklyCandles - Weekly candles for this pair (12+ required, null if not available)
 * @param dailyCandles - Daily candles for this pair (30+ required)
 * @param currentPrice - Current market price
 * @param tradeDirection - The direction the bot wants to trade ("long" | "short")
 * @param ltfZone - The LTF zone selected by the impulse zone engine (high/low), null if no zone
 * @param config - ICT HTF configuration
 * @returns ICTHTFResult with pass/fail, score adjustment, and detailed analysis
 */
export function runICTHTFAnalysis(
  weeklyCandles: Candle[] | null,
  dailyCandles: Candle[],
  currentPrice: number,
  tradeDirection: "long" | "short",
  ltfZone: { high: number; low: number } | null,
  config: Partial<ICTHTFConfig> = {},
): ICTHTFResult {
  const cfg: ICTHTFConfig = { ...DEFAULT_ICT_HTF_CONFIG, ...config };

  const noResult: ICTHTFResult = {
    passed: true,
    weeklyBias: null,
    dailyImpulse: null,
    containment: null,
    dailyOB: null,
    weeklyAligned: true,
    zoneContained: true,
    scoreAdjustment: 0,
    reason: "ICT HTF analysis disabled or insufficient data",
    details: [],
  };

  if (!cfg.ictHTFEnabled || cfg.ictHTFGateMode === "off") {
    return { ...noResult, reason: "ICT HTF gate mode: off" };
  }

  const details: string[] = [];
  let weeklyAligned = true;
  let zoneContained = true;
  let scoreAdjustment = 0;

  // ── Step 1: Weekly Bias ──
  let weeklyBias: WeeklyBiasResult | null = null;
  if (weeklyCandles && weeklyCandles.length >= 12) {
    weeklyBias = analyzeWeeklyBiasAndDOL(weeklyCandles, currentPrice);
    details.push(`Weekly bias: ${weeklyBias.bias} (${weeklyBias.confidence}% confidence)`);
    if (weeklyBias.primaryDOL) {
      details.push(`Weekly DOL: ${weeklyBias.primaryDOL.label}`);
    }

    // Check alignment
    const tradeBias: "bullish" | "bearish" = tradeDirection === "long" ? "bullish" : "bearish";
    if (weeklyBias.bias !== "neutral" && weeklyBias.bias !== tradeBias) {
      weeklyAligned = false;
      details.push(`⚠️ Weekly bias (${weeklyBias.bias}) CONFLICTS with trade direction (${tradeDirection})`);
    } else if (weeklyBias.bias === tradeBias) {
      details.push(`✓ Weekly bias aligned with trade direction`);
    } else {
      // Neutral — don't penalize but don't bonus either
      details.push(`Weekly bias neutral — no directional conviction`);
    }
  } else {
    details.push("Weekly candles not available — skipping weekly bias check");
    weeklyAligned = true; // Don't penalize if data not available
  }

  // ── Step 2: Daily Impulse + OB ──
  const biasForDaily: "bullish" | "bearish" = tradeDirection === "long" ? "bullish" : "bearish";
  const dailyImpulse = analyzeDailyImpulse(dailyCandles, currentPrice, biasForDaily);
  details.push(`Daily impulse: ${dailyImpulse.reason}`);

  let dailyOB: DailyOB | null = null;
  if (dailyImpulse.primaryOB) {
    dailyOB = dailyImpulse.primaryOB;
    details.push(`Daily OB: ${dailyOB.direction} @ ${dailyOB.low.toFixed(5)}-${dailyOB.high.toFixed(5)} [${dailyOB.isValid ? "VALID" : "INVALIDATED"}]`);
  } else {
    details.push("No valid Daily OB found");
  }

  // ── Step 3: Containment Check ──
  let containment: ContainmentResult | null = null;
  if (dailyOB && dailyOB.isValid && ltfZone) {
    containment = checkContainment(ltfZone.high, ltfZone.low, dailyOB, cfg.ictHTFMinContainment);
    zoneContained = containment.isContained;
    details.push(`Containment: ${containment.reason}`);
  } else if (!dailyOB || !dailyOB.isValid) {
    // No valid Daily OB — can't check containment
    zoneContained = true; // Don't penalize if no Daily OB exists
    details.push("Containment check skipped: no valid Daily OB");
  } else if (!ltfZone) {
    zoneContained = true; // No zone to check
    details.push("Containment check skipped: no LTF zone provided");
  }

  // ── Step 4: Determine pass/fail and score adjustment ──
  const weeklyFailed = cfg.ictWeeklyBiasRequired && !weeklyAligned;
  const containmentFailed = cfg.ictDailyContainmentRequired && !zoneContained;
  // Hard mode: block trade if requirements fail. Soft mode: always pass (penalty only).
  const passed = cfg.ictHTFGateMode === "hard"
    ? (!weeklyFailed && !containmentFailed)
    : true;

  // Score adjustment
  if (weeklyAligned && zoneContained && dailyOB?.isValid) {
    // Full alignment: weekly + daily + contained
    scoreAdjustment = cfg.ictHTFAlignedBonus;
    details.push(`✓ Full ICT HTF alignment — +${scoreAdjustment.toFixed(1)} score bonus`);
  } else if (weeklyAligned && dailyOB?.priceInZone) {
    // Weekly aligned + price in Daily OB (even without LTF containment check)
    scoreAdjustment = cfg.ictHTFAlignedBonus * 0.5;
    details.push(`✓ Partial alignment (weekly + price in Daily OB) — +${scoreAdjustment.toFixed(1)} score bonus`);
  } else if (!weeklyAligned) {
    scoreAdjustment = -cfg.ictHTFMisalignedPenalty;
    details.push(`✗ Weekly bias misaligned — ${scoreAdjustment.toFixed(1)} score penalty`);
  } else if (!zoneContained) {
    scoreAdjustment = -(cfg.ictHTFMisalignedPenalty * 0.5);
    details.push(`✗ Zone not contained in Daily OB — ${scoreAdjustment.toFixed(1)} score penalty`);
  }

  // Build reason string
  const reasons: string[] = [];
  if (!passed) {
    if (weeklyFailed) reasons.push(`Weekly bias (${weeklyBias?.bias}) opposes ${tradeDirection}`);
    if (containmentFailed) reasons.push(`LTF zone not contained in Daily OB (${containment?.overlapPercent.toFixed(0)}% overlap)`);
  } else {
    if (weeklyAligned && weeklyBias?.bias !== "neutral") reasons.push(`Weekly ${weeklyBias?.bias} aligned`);
    if (zoneContained && dailyOB?.isValid) reasons.push(`Zone contained in Daily OB`);
    if (dailyOB?.priceInZone) reasons.push(`Price in Daily OB`);
  }

  return {
    passed,
    weeklyBias,
    dailyImpulse,
    containment,
    dailyOB,
    weeklyAligned,
    zoneContained,
    scoreAdjustment,
    reason: passed
      ? (reasons.length > 0 ? `ICT HTF PASS: ${reasons.join(", ")}` : "ICT HTF: no data to check")
      : `ICT HTF FAIL: ${reasons.join(", ")}`,
    details,
  };
}
