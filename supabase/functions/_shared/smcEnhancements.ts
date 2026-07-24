/**
 * smcEnhancements.ts — Integration Layer for All New SMC Modules
 * ──────────────────────────────────────────────────────────────────────────────
 * This is the SINGLE entry point that the bot-scanner calls to access all new
 * SMC features. It orchestrates:
 *
 *   1. Price-Action Phase Detection (consolidation filter)
 *   2. Breaker Block Detection (new entry model)
 *   3. Zone Lifecycle v2 (multi-retest, close-based invalidation)
 *   4. 3-Point Fib Extension TP
 *   5. Trendline Liquidity (trap detection + broken trendline bonus)
 *   6. Monthly Timeframe Containment
 *
 * Design principles:
 *   - Does NOT modify smcAnalysis.ts, confluenceScoring.ts, or bot-scanner gates
 *   - All features are opt-in via config flags (disabled by default)
 *   - Returns supplementary factors and gate results that get APPENDED to existing ones
 *   - Pure function: no DB calls, no fetches, no side effects
 */

import type { Candle, OrderBlock, GateResult, ReasoningFactor } from "./smcAnalysis.ts";
import { calculateATR } from "./smcAnalysis.ts";

import {
  detectMarketPhase,
  wasOBFormedInConsolidation,
  filterOBsByPhaseContext,
  type PhaseResult,
  type PhaseConfig,
  DEFAULT_PHASE_CONFIG,
} from "./priceActionPhase.ts";

import {
  detectBreakerBlocks as detectBreakers,
  isAtBreakerRetest,
  type BreakerBlockEntry,
  type BreakerConfig,
  DEFAULT_BREAKER_CONFIG,
} from "./breakerBlockDetection.ts";

import {
  evaluateZoneLifecycle,
  compareLifecycleMethods,
  type ZoneLifecycleResult,
  type ZoneLifecycleConfig,
  DEFAULT_ZONE_LIFECYCLE_CONFIG,
} from "./zoneLifecycle.ts";

import {
  calculateFibExtension3Point,
  compareFibTPMethods,
  type FibExtensionInput,
  type FibExtension3PointResult,
  type FibExtensionConfig,
  DEFAULT_FIB_EXTENSION_CONFIG,
} from "./fibExtension3Point.ts";

import {
  detectTrendlines,
  isZoneNearTrendlineTrap,
  isZoneBelowBrokenTrendline,
  type TrendlineResult,
  type TrendlineConfig,
  DEFAULT_TRENDLINE_CONFIG,
} from "./trendlineLiquidity.ts";

import {
  synthesizeMonthlyCandles,
  analyzeMonthlyStructure,
  checkMonthlyContainment,
  type MonthlyAnalysis,
  type MonthlyContainmentResult,
} from "./monthlyTimeframe.ts";

// ─── Master Configuration ─────────────────────────────────────────────────────

export interface SMCEnhancementsConfig {
  /** Enable price-action phase detection and consolidation filter */
  enablePhaseDetection: boolean;
  /** Enable breaker block detection (new entry model) */
  enableBreakerBlocks: boolean;
  /** Enable zone lifecycle v2 (multi-retest, close-based invalidation) */
  enableZoneLifecycleV2: boolean;
  /** Enable 3-point fib extension TP */
  enableFibExtension3Point: boolean;
  /** Enable trendline liquidity detection */
  enableTrendlineLiquidity: boolean;
  /** Enable monthly timeframe containment */
  enableMonthlyContainment: boolean;

  /** Sub-configs (optional overrides) */
  phaseConfig?: Partial<PhaseConfig>;
  breakerConfig?: Partial<BreakerConfig>;
  zoneLifecycleConfig?: Partial<ZoneLifecycleConfig>;
  fibExtensionConfig?: Partial<FibExtensionConfig>;
  trendlineConfig?: Partial<TrendlineConfig>;
}

export const DEFAULT_SMC_ENHANCEMENTS_CONFIG: SMCEnhancementsConfig = {
  enablePhaseDetection: false,
  enableBreakerBlocks: false,
  enableZoneLifecycleV2: false,
  enableFibExtension3Point: false,
  enableTrendlineLiquidity: false,
  enableMonthlyContainment: false,
};

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface SMCEnhancementsResult {
  /** Additional factors to append to the confluence scoring factors array */
  additionalFactors: ReasoningFactor[];
  /** Additional gate results to append to the safety gates array */
  additionalGates: GateResult[];
  /** Phase detection result (if enabled) */
  phaseDetection: PhaseResult | null;
  /** Breaker blocks detected (if enabled) */
  breakerBlocks: BreakerBlockEntry[];
  /** Zone lifecycle evaluations (if enabled) */
  zoneLifecycles: Map<number, ZoneLifecycleResult>;
  /** 3-point fib extension result (if enabled) */
  fibExtension: FibExtension3PointResult | null;
  /** Trendline analysis (if enabled) */
  trendlineAnalysis: TrendlineResult | null;
  /** Monthly analysis (if enabled) */
  monthlyAnalysis: MonthlyAnalysis | null;
  /** Monthly containment result (if enabled) */
  monthlyContainment: MonthlyContainmentResult | null;
  /** Summary of what ran */
  summary: string;
}

// ─── Main Integration Function ────────────────────────────────────────────────

/**
 * Run all enabled SMC enhancements and return supplementary factors + gates.
 *
 * This function is designed to be called AFTER runConfluenceAnalysis() and
 * its results are APPENDED to the existing analysis — never replacing.
 *
 * @param candles - Entry timeframe candles (same as passed to runConfluenceAnalysis)
 * @param dailyCandles - Daily candles (same as passed to runConfluenceAnalysis)
 * @param orderBlocks - OBs detected by runConfluenceAnalysis
 * @param direction - Trade direction determined by confluenceScoring
 * @param zoneHigh - Current zone high (from impulse zone engine)
 * @param zoneLow - Current zone low (from impulse zone engine)
 * @param entryPrice - Planned entry price
 * @param config - Enhancement configuration
 */
export function runSMCEnhancements(
  candles: Candle[],
  dailyCandles: Candle[] | null,
  orderBlocks: OrderBlock[],
  direction: "bullish" | "bearish" | "long" | "short" | null,
  zoneHigh: number | null,
  zoneLow: number | null,
  entryPrice: number | null,
  config: Partial<SMCEnhancementsConfig> = {},
): SMCEnhancementsResult {
  const cfg = { ...DEFAULT_SMC_ENHANCEMENTS_CONFIG, ...config };
  const additionalFactors: ReasoningFactor[] = [];
  const additionalGates: GateResult[] = [];
  const enabledModules: string[] = [];

  // Normalize direction
  const normalizedDir: "bullish" | "bearish" | null =
    direction === "long" ? "bullish" :
    direction === "short" ? "bearish" :
    direction;

  // ── 1. Price-Action Phase Detection ──────────────────────────────────────
  let phaseDetection: PhaseResult | null = null;
  if (cfg.enablePhaseDetection && candles.length >= 30) {
    enabledModules.push("phase");
    phaseDetection = detectMarketPhase(candles, cfg.phaseConfig);

    // Gate: reject if zone formed during consolidation
    if (phaseDetection.phase === "consolidation") {
      additionalGates.push({
        passed: false,
        reason: `[Phase] Zone formed during ${phaseDetection.phase} (score: ${phaseDetection.regimeScore}, conf: ${(phaseDetection.confidence * 100).toFixed(0)}%) — ${phaseDetection.detail}`,
      });
    } else {
      additionalGates.push({
        passed: true,
        reason: `[Phase] Market in ${phaseDetection.phase} (score: ${phaseDetection.regimeScore}, conf: ${(phaseDetection.confidence * 100).toFixed(0)}%)`,
      });
    }

    // Factor: phase quality bonus/penalty
    const phaseScore = phaseDetection.phase === "trend" ? 0.5 :
                       phaseDetection.phase === "expansion" ? 0.3 : 0;
    additionalFactors.push({
      name: "Price-Action Phase",
      present: phaseScore > 0,
      weight: phaseScore,
      detail: `${phaseDetection.phase} (score: ${phaseDetection.regimeScore}, ATR: ${phaseDetection.regime.atrTrend})`,
    });
  }

  // ── 2. Breaker Block Detection ───────────────────────────────────────────
  let breakerBlocks: BreakerBlockEntry[] = [];
  if (cfg.enableBreakerBlocks && orderBlocks.length > 0 && candles.length >= 30) {
    enabledModules.push("breaker");
    breakerBlocks = detectBreakers(orderBlocks, candles, cfg.breakerConfig);

    if (breakerBlocks.length > 0) {
      const best = breakerBlocks.reduce((a, b) => a.confidence > b.confidence ? a : b);
      additionalFactors.push({
        name: "Breaker Block Setup",
        present: true,
        weight: best.confidence,
        detail: best.detail,
      });

      // Check if current price is at a breaker retest
      if (candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        const atRetest = breakerBlocks.some(b => isAtBreakerRetest(lastCandle, b));
        if (atRetest) {
          additionalFactors.push({
            name: "Breaker Retest Active",
            present: true,
            weight: 0.75,
            detail: "Price is currently retesting a breaker block — high-probability entry",
          });
        }
      }
    }
  }

  // ── 3. Zone Lifecycle v2 ─────────────────────────────────────────────────
  const zoneLifecycles = new Map<number, ZoneLifecycleResult>();
  if (cfg.enableZoneLifecycleV2 && zoneHigh !== null && zoneLow !== null && normalizedDir) {
    enabledModules.push("lifecycle");

    // Evaluate the current zone
    const candlesAfterZone = candles.slice(-20); // Last 20 candles for lifecycle check
    const lifecycle = evaluateZoneLifecycle(
      { high: zoneHigh, low: zoneLow, direction: normalizedDir },
      candlesAfterZone,
      cfg.zoneLifecycleConfig,
    );
    zoneLifecycles.set(0, lifecycle);

    // Gate: block if zone is exhausted
    if (!lifecycle.canStillTrade) {
      additionalGates.push({
        passed: false,
        reason: `[ZoneLifecycle] Zone ${lifecycle.state} — ${lifecycle.detail}`,
      });
    } else {
      // Factor: confidence multiplier based on retest count
      additionalFactors.push({
        name: "Zone Freshness",
        present: lifecycle.confidenceMultiplier > 0.3,
        weight: lifecycle.confidenceMultiplier,
        detail: lifecycle.detail,
      });
    }

    // Breaker candidate detection
    if (lifecycle.breakerCandidate) {
      additionalFactors.push({
        name: "Zone Breaker Candidate",
        present: true,
        weight: 0.5,
        detail: "Zone invalidated with prior sweep — potential breaker block flip",
      });
    }
  }

  // ── 4. 3-Point Fib Extension TP ─────────────────────────────────────────
  let fibExtension: FibExtension3PointResult | null = null;
  if (cfg.enableFibExtension3Point && entryPrice !== null && normalizedDir && candles.length >= 20) {
    enabledModules.push("fib3pt");

    // Find swing points for A and B
    const swingData = _findSwingAB(candles, normalizedDir);
    if (swingData) {
      fibExtension = calculateFibExtension3Point({
        swingOrigin: swingData.a,
        swingEnd: swingData.b,
        entryPrice,
        direction: normalizedDir,
      }, cfg.fibExtensionConfig);

      if (fibExtension.recommendedTP !== null) {
        additionalFactors.push({
          name: "Fib 3-Point TP",
          present: true,
          weight: 0.5,
          detail: fibExtension.detail,
        });
      }
    }
  }

  // ── 5. Trendline Liquidity ───────────────────────────────────────────────
  let trendlineAnalysis: TrendlineResult | null = null;
  if (cfg.enableTrendlineLiquidity && candles.length >= 30) {
    enabledModules.push("trendline");
    trendlineAnalysis = detectTrendlines(candles, cfg.trendlineConfig);

    // Check if zone is near a trendline trap (penalty)
    if (zoneHigh !== null && zoneLow !== null) {
      const atr = calculateATR(candles, 14);
      const trapCheck = isZoneNearTrendlineTrap(zoneHigh, zoneLow, trendlineAnalysis, 2.0, atr);

      if (trapCheck.nearTrap) {
        additionalFactors.push({
          name: "Trendline Trap Warning",
          present: true,
          weight: -0.5, // Penalty
          detail: trapCheck.detail,
        });
      }

      // Check if zone is below a broken trendline (bonus)
      if (normalizedDir) {
        const brokenCheck = isZoneBelowBrokenTrendline(zoneHigh, zoneLow, normalizedDir, trendlineAnalysis);
        if (brokenCheck.belowBroken) {
          additionalFactors.push({
            name: "Broken Trendline Bonus",
            present: true,
            weight: 0.5,
            detail: brokenCheck.detail,
          });
        }
      }
    }
  }

  // ── 6. Monthly Timeframe Containment ─────────────────────────────────────
  let monthlyAnalysis: MonthlyAnalysis | null = null;
  let monthlyContainment: MonthlyContainmentResult | null = null;
  if (cfg.enableMonthlyContainment && dailyCandles && dailyCandles.length >= 60 && normalizedDir) {
    enabledModules.push("monthly");
    monthlyAnalysis = analyzeMonthlyStructure(dailyCandles);

    if (zoneHigh !== null && zoneLow !== null) {
      monthlyContainment = checkMonthlyContainment(zoneHigh, zoneLow, normalizedDir, monthlyAnalysis);

      // Factor: monthly containment
      additionalFactors.push({
        name: "Monthly Containment",
        present: monthlyContainment.isContained,
        weight: monthlyContainment.isContained ? monthlyContainment.confidence * 0.75 : 0,
        detail: monthlyContainment.detail,
      });

      // Gate: monthly bias opposition (soft — only when confidence is high)
      if (!monthlyContainment.biasAligned && monthlyAnalysis.bias !== "neutral") {
        additionalGates.push({
          passed: true, // Soft gate — info only, doesn't block
          reason: `[Monthly] Bias opposition: monthly is ${monthlyAnalysis.bias}, trade is ${normalizedDir} — reduced confidence`,
        });
      }
    }
  }

  const summary = enabledModules.length > 0
    ? `SMC Enhancements active: [${enabledModules.join(", ")}] — ${additionalFactors.filter(f => f.present).length} factors, ${additionalGates.filter(g => !g.passed).length} gates blocked`
    : "SMC Enhancements: all disabled";

  return {
    additionalFactors,
    additionalGates,
    phaseDetection,
    breakerBlocks,
    zoneLifecycles,
    fibExtension,
    trendlineAnalysis,
    monthlyAnalysis,
    monthlyContainment,
    summary,
  };
}

// ─── Helper: Find Swing A and B for Fib Extension ─────────────────────────────

function _findSwingAB(
  candles: Candle[],
  direction: "bullish" | "bearish",
): { a: number; b: number } | null {
  if (candles.length < 10) return null;

  // Look at the last 50 candles for the most recent impulse swing
  const lookback = candles.slice(-50);

  if (direction === "bullish") {
    // Bullish: A = recent swing low, B = recent swing high (impulse up)
    let lowestIdx = 0;
    let highestIdx = 0;
    for (let i = 0; i < lookback.length; i++) {
      if (lookback[i].low < lookback[lowestIdx].low) lowestIdx = i;
      if (lookback[i].high > lookback[highestIdx].high) highestIdx = i;
    }
    // A must come before B (impulse goes low → high)
    if (lowestIdx < highestIdx) {
      return { a: lookback[lowestIdx].low, b: lookback[highestIdx].high };
    }
    // If highest is before lowest, look for the most recent up-swing
    let newLow = highestIdx;
    for (let i = highestIdx; i < lookback.length; i++) {
      if (lookback[i].low < lookback[newLow].low) newLow = i;
    }
    if (newLow < lookback.length - 1) {
      let newHigh = newLow;
      for (let i = newLow; i < lookback.length; i++) {
        if (lookback[i].high > lookback[newHigh].high) newHigh = i;
      }
      if (newHigh > newLow) {
        return { a: lookback[newLow].low, b: lookback[newHigh].high };
      }
    }
  } else {
    // Bearish: A = recent swing high, B = recent swing low (impulse down)
    let highestIdx = 0;
    let lowestIdx = 0;
    for (let i = 0; i < lookback.length; i++) {
      if (lookback[i].high > lookback[highestIdx].high) highestIdx = i;
      if (lookback[i].low < lookback[lowestIdx].low) lowestIdx = i;
    }
    // A must come before B (impulse goes high → low)
    if (highestIdx < lowestIdx) {
      return { a: lookback[highestIdx].high, b: lookback[lowestIdx].low };
    }
    let newHigh = lowestIdx;
    for (let i = lowestIdx; i < lookback.length; i++) {
      if (lookback[i].high > lookback[newHigh].high) newHigh = i;
    }
    if (newHigh < lookback.length - 1) {
      let newLow = newHigh;
      for (let i = newHigh; i < lookback.length; i++) {
        if (lookback[i].low < lookback[newLow].low) newLow = i;
      }
      if (newLow > newHigh) {
        return { a: lookback[newHigh].high, b: lookback[newLow].low };
      }
    }
  }

  return null;
}

// ─── Re-exports for convenience ──────────────────────────────────────────────

export type {
  PhaseResult,
  BreakerBlockEntry,
  ZoneLifecycleResult,
  FibExtension3PointResult,
  TrendlineResult,
  MonthlyAnalysis,
  MonthlyContainmentResult,
};
