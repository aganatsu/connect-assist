/**
 * ictHTFIntegration.ts — ICT Higher Timeframe Integration Layer
 * ──────────────────────────────────────────────────────────────
 * Orchestrates the Weekly Bias + Daily Impulse + Containment logic
 * for use by bot-scanner. This module:
 *
 *   1. Runs weekly bias analysis (once per scan, shared across all pairs)
 *   2. Runs daily impulse/OB detection (per pair)
 *   3. Performs containment check (is the LTF zone inside the Daily OB?)
 *   4. Returns a unified result that the scanner can use as a gate
 *
 * Integration modes (configurable):
 *   - "hard": Weekly bias must align + LTF zone must be contained in Daily OB → skip if not
 *   - "off": informational logging only (a stored legacy "soft" behaves the same)
 */
import type { Candle } from "./smcAnalysis.ts";
import { analyzeWeeklyBiasAndDOL, type WeeklyBiasResult } from "./weeklyBiasDOL.ts";
import { analyzeDailyImpulse, checkContainment, type DailyImpulseResult, type DailyOB, type ContainmentResult } from "./dailyImpulseOB.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ICTHTFConfig {
  /** Enable/disable the ICT HTF framework. Default: true */
  ictHTFEnabled: boolean;
  /** Gate mode: "hard" = skip if not aligned, "off" = informational (a stored legacy "soft" behaves the same) */
  ictHTFGateMode: "hard" | "off";
  /** Minimum containment overlap percent. Default: 50 */
  ictHTFMinContainment: number;
  /** Whether weekly bias is required to match trade direction. Default: true */
  ictWeeklyBiasRequired: boolean;
  /** Whether daily OB containment is required. Default: true */
  ictDailyContainmentRequired: boolean;
}

export const DEFAULT_ICT_HTF_CONFIG: ICTHTFConfig = {
  ictHTFEnabled: true,
  ictHTFGateMode: "off",  // informational until switched to hard
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
 * @returns ICTHTFResult with pass/fail and detailed analysis
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
    reason: "ICT HTF analysis disabled or insufficient data",
    details: [],
  };

  if (!cfg.ictHTFEnabled) {
    return { ...noResult, reason: "ICT HTF analysis disabled" };
  }

  const details: string[] = [];
  let weeklyAligned = true;
  let zoneContained = true;

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

  // ── Step 4: Determine pass/fail ──
  // Hard mode blocks the trade if requirements fail; any other mode is informational.
  const weeklyFailed = cfg.ictWeeklyBiasRequired && !weeklyAligned;
  const containmentFailed = cfg.ictDailyContainmentRequired && !zoneContained;
  const passed = cfg.ictHTFGateMode === "hard" ? !weeklyFailed && !containmentFailed : true;

  if (weeklyAligned && zoneContained && dailyOB?.isValid) details.push("✓ Full ICT HTF alignment (weekly + daily + contained)");
  else if (weeklyAligned && dailyOB?.priceInZone) details.push("✓ Partial alignment (weekly + price in Daily OB)");
  else if (!weeklyAligned) details.push("✗ Weekly bias misaligned");
  else if (!zoneContained) details.push("✗ Zone not contained in Daily OB");

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
    reason: passed
      ? (reasons.length > 0 ? `ICT HTF PASS: ${reasons.join(", ")}` : "ICT HTF: no data to check")
      : `ICT HTF FAIL: ${reasons.join(", ")}`,
    details,
  };
}
