/**
 * _shared/computeManagementDecision.ts — Pure Exit-Math Engine
 * ──────────────────────────────────────────────────────────────────
 * Exports:
 *   computeManagementDecision()  — single-position SL decision (no I/O)
 *   Types: ManagementInput, ManagementDecisionConfig, StructureCheckResult, ManagementDecisionResult
 *
 * DESIGN NOTES:
 *   • This function is the SINGLE SOURCE OF TRUTH for all SL movement logic.
 *   • It is called by both manageOpenPositions() (live) and processExits() (backtest).
 *   • It is PURE: no DB, no fetch, no Date.now(). All external data is passed in.
 *   • Partial TP is EXCLUDED (Stage 2) — it has accounting side-effects that
 *     require a different extraction pattern.
 *   • The function returns a DECISION, not an action. The caller decides what to
 *     write to DB or how to apply it to a backtest position.
 */

import { SPECS } from "./smcAnalysis.ts";
import { computeAdaptiveTrail, type TrailInput, type TrailResult, type RegimeInfo } from "./exitEngine.ts";

// ─── Input Types ──────────────────────────────────────────────────────

export interface ManagementInput {
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;         // broker fill price (or paper entry if no broker fill)
  currentPrice: number;       // current market price (live: tick; backtest: candle.close)
  bestPrice: number;          // best price reached this evaluation (live: same as currentPrice; backtest: candle.high for long, candle.low for short)
  currentSL: number;          // current stop-loss level
  originalSL: number;         // SL at trade open (for R-multiple calculation)
  takeProfit: number;
  holdHours: number;          // hours since trade open
  exitFlags: Record<string, any>;  // accumulated management state

  // Pre-computed external data (caller fetches/computes these):
  structureCheck: StructureCheckResult | null;  // null = skip structure invalidation
  adaptiveTrailCandles: Array<{ open: number; high: number; low: number; close: number }> | null;  // null = use fixed trail
  atrValue: number;           // ATR value for adaptive trailing
  regimeInfo: RegimeInfo | null;  // for adaptive trailing regime adjustment
  currentSession: string;     // canonical session key: "asian" | "london" | "newyork" | "offhours"
}

export interface StructureCheckResult {
  trend: "bullish" | "bearish" | "ranging";
  chochAgainstCount: number;  // number of CHoCH events against trade direction
}

export interface ManagementDecisionConfig {
  // Break-even
  breakEvenEnabled: boolean;
  breakEvenPips: number;        // used to compute R-based activation threshold
  breakEvenOffsetPips: number;  // pips above/below entry for BE SL (default 3)

  // Trailing
  trailingStopEnabled: boolean;
  trailingStopPips: number;     // minimum trail distance (proportional overrides)
  trailingStopActivation: string;  // "immediate" | "after_0.5r" | "after_1r" | "after_1.5r" | "after_2r"

  // Partial TP (for trailing delay logic only — actual partial TP is Stage 2)
  partialTPEnabled: boolean;

  // Max hold
  maxHoldEnabled: boolean;
  maxHoldHours: number;

  // Structure invalidation
  structureInvalidationEnabled: boolean;

  // Adaptive trailing
  adaptiveTrailingEnabled: boolean;
  baseTrailATRMultiple?: number;
  momentumFadeThreshold?: number;
  trailTightenFactor?: number;
  trailWidenFactor?: number;

  // Session-based management
  tradingStyle: string;  // "scalper" | "day_trader" | "swing"
}

// ─── Output Type ──────────────────────────────────────────────────────

export type DecisionAction =
  | "be_activated"
  | "trailing_activated"
  | "trailing_tightened"
  | "structure_invalidated"
  | "max_hold_be"
  | "session_close_be"
  | "no_change";

export interface ManagementDecisionResult {
  action: DecisionAction;
  newSL: number | null;         // null = no SL change
  updatedExitFlags: Record<string, any>;  // updated flags to persist
  detail: string;               // human-readable explanation
  rMultiple: number;            // R-multiple at time of decision
}

// ─── Constants ────────────────────────────────────────────────────────

/** Per-instrument minimum SL distance for structure invalidation (60% of entry floor) */
const MGMT_SL_FLOOR_PIPS: Record<string, number> = {
  "GBP/JPY": 21, "EUR/JPY": 18, "USD/JPY": 15,
  "AUD/JPY": 15, "CAD/JPY": 15, "NZD/JPY": 15, "CHF/JPY": 15,
  "GBP/USD": 15, "GBP/AUD": 18, "GBP/CAD": 18, "GBP/NZD": 18, "GBP/CHF": 15,
  "EUR/USD": 12, "EUR/GBP": 9, "EUR/AUD": 15, "EUR/CAD": 15, "EUR/NZD": 15, "EUR/CHF": 11,
  "AUD/USD": 11, "NZD/USD": 11, "USD/CAD": 11, "USD/CHF": 11,
  "AUD/CAD": 12, "AUD/NZD": 12, "AUD/CHF": 12, "NZD/CAD": 12, "NZD/CHF": 12, "CAD/CHF": 11,
  "XAU/USD": 30, "BTC/USD": 90,
};

// ─── Helpers ──────────────────────────────────────────────────────────

/** Round price to instrument precision (avoids floating-point garbage) */
function roundPrice(price: number, pipSize: number): number {
  const decimals = Math.max(0, Math.round(-Math.log10(pipSize)) + 1);
  const factor = Math.pow(10, decimals);
  return Math.round(price * factor) / factor;
}

/** Map trailing activation string to R-multiple threshold */
function activationToR(activation: string): number {
  switch (activation) {
    case "immediate": return 0.0;
    case "after_0.5r": return 0.5;
    case "after_1r": return 1.0;
    case "after_1.5r": return 1.5;
    case "after_2r": return 2.0;
    default: return 1.0;
  }
}

// ─── Main Function ────────────────────────────────────────────────────

/**
 * Computes the management decision for a single position.
 * Returns what SL change (if any) should be made, plus updated exitFlags.
 *
 * Order of evaluation matches live manageOpenPositions():
 *   1. Max hold time → move to BE
 *   2. Break-even activation (R-based) + trailing co-activation
 *   3. Trailing stop (Phase A: first activation, Phase B: ratchet tighten)
 *   4. Structure invalidation (one-shot 50% tighten with floor)
 *   5. Session-close BE (scalpers only, off-hours)
 *
 * The first condition that fires wins (early return). This matches the
 * `continue` pattern in the live code.
 */
export function computeManagementDecision(
  input: ManagementInput,
  config: ManagementDecisionConfig,
): ManagementDecisionResult {
  const spec = SPECS[input.symbol] || SPECS["EUR/USD"];
  const { direction, entryPrice, currentPrice, bestPrice, currentSL, originalSL, holdHours } = input;
  const exitFlags = { ...input.exitFlags };

  // ── Compute R-multiple using ORIGINAL SL (not moved SL) ──
  const riskPips = Math.abs(entryPrice - originalSL) / spec.pipSize;
  const profitPips = direction === "long"
    ? (currentPrice - entryPrice) / spec.pipSize
    : (entryPrice - currentPrice) / spec.pipSize;
  const rMultiple = riskPips > 0 ? profitPips / riskPips : 0;

  // Best-price R-multiple (for activation checks using intra-bar high/low)
  const bestProfitPips = direction === "long"
    ? (bestPrice - entryPrice) / spec.pipSize
    : (entryPrice - bestPrice) / spec.pipSize;
  const bestRMultiple = riskPips > 0 ? bestProfitPips / riskPips : 0;

  let sl = currentSL;

  const noChange = (): ManagementDecisionResult => ({
    action: "no_change",
    newSL: null,
    updatedExitFlags: exitFlags,
    detail: `At ${rMultiple.toFixed(2)}R, ${holdHours.toFixed(1)}h held — no management action needed`,
    rMultiple,
  });

  // ── 1. MAX HOLD TIME CHECK ──
  if (config.maxHoldEnabled && config.maxHoldHours > 0 && holdHours >= config.maxHoldHours) {
    if (rMultiple > 0 && config.breakEvenEnabled) {
      const beSL = direction === "long"
        ? entryPrice + (spec.pipSize * config.breakEvenOffsetPips)
        : entryPrice - (spec.pipSize * config.breakEvenOffsetPips);
      const shouldMove = direction === "long" ? beSL > sl : beSL < sl;
      if (shouldMove) {
        exitFlags.maxHoldExceeded = true;
        return {
          action: "max_hold_be",
          newSL: roundPrice(beSL, spec.pipSize),
          updatedExitFlags: exitFlags,
          detail: `Position held ${holdHours.toFixed(1)}h, max allowed ${config.maxHoldHours}h — SL moved to breakeven at ${roundPrice(beSL, spec.pipSize).toFixed(5)}`,
          rMultiple,
        };
      }
    }
  }

  // ── 2. BREAK-EVEN ACTIVATION (R-based) ──
  // beActivationR: at least 1R, capped at 2R. Uses bestRMultiple for activation check.
  const beActivationR = config.breakEvenPips > 0 && riskPips > 0
    ? Math.min(2.0, Math.max(1.0, config.breakEvenPips / riskPips))
    : 1.0;

  if (config.breakEvenEnabled && !exitFlags.breakEvenActivated && bestRMultiple >= beActivationR) {
    const beSL = direction === "long"
      ? entryPrice + (spec.pipSize * config.breakEvenOffsetPips)
      : entryPrice - (spec.pipSize * config.breakEvenOffsetPips);
    const shouldMove = direction === "long" ? beSL > sl : beSL < sl;
    if (shouldMove) {
      exitFlags.breakEvenActivated = true;

      // Co-activate trailing stop (prevents +1 pip wins from stale BE)
      const proportionalTrailPips = Math.max(config.trailingStopPips, riskPips * 0.5);
      if (config.trailingStopEnabled && !exitFlags.trailingStopActivated) {
        exitFlags.trailingStopActivated = true;
        exitFlags.trailingStopLevel = beSL;
        exitFlags.trailingStopPips = Math.round(proportionalTrailPips * 10) / 10;
        exitFlags.trailingStopActivation = config.trailingStopActivation;
      }

      const trailMsg = (config.trailingStopEnabled && !input.exitFlags.trailingStopActivated)
        ? ` | trailing co-activated (trail: ${proportionalTrailPips.toFixed(1)} pips)`
        : "";

      return {
        action: "be_activated",
        newSL: roundPrice(beSL, spec.pipSize),
        updatedExitFlags: exitFlags,
        detail: `Break-even activated at ${bestRMultiple.toFixed(2)}R (trigger: ${beActivationR.toFixed(2)}R) — SL moved to ${roundPrice(beSL, spec.pipSize).toFixed(5)}${trailMsg}`,
        rMultiple,
      };
    }
  }

  // ── 3. TRAILING STOP ──
  const trailingAlreadyActivated = exitFlags.trailingStopActivated === true;
  const proportionalTrailPips = Math.max(config.trailingStopPips, riskPips * 0.5);
  // If partial TP is enabled, delay trailing until partial TP has fired
  const partialTPBlocksTrailing = config.partialTPEnabled && !exitFlags.partialTPActivated;

  if (config.trailingStopEnabled && !trailingAlreadyActivated && !partialTPBlocksTrailing) {
    // ── Phase A: First-time activation ──
    const activationR = activationToR(config.trailingStopActivation);

    if (bestRMultiple >= activationR) {
      const newTrailLevel = direction === "long"
        ? currentPrice - (proportionalTrailPips * spec.pipSize)
        : currentPrice + (proportionalTrailPips * spec.pipSize);

      exitFlags.trailingStopActivated = true;
      exitFlags.trailingStopLevel = newTrailLevel;
      exitFlags.trailingStopPips = Math.round(proportionalTrailPips * 10) / 10;
      exitFlags.trailingStopActivation = config.trailingStopActivation;

      const shouldMoveSL = direction === "long" ? newTrailLevel > sl : newTrailLevel < sl;
      if (shouldMoveSL) {
        return {
          action: "trailing_activated",
          newSL: roundPrice(newTrailLevel, spec.pipSize),
          updatedExitFlags: exitFlags,
          detail: `Trailing stop activated at ${bestRMultiple.toFixed(2)}R (trigger: ${config.trailingStopActivation}, distance: ${proportionalTrailPips.toFixed(1)} pips = 0.5× SL) — SL moved to ${roundPrice(newTrailLevel, spec.pipSize).toFixed(5)}`,
          rMultiple,
        };
      } else {
        // Trailing activated but SL already better — still record the activation
        return {
          action: "trailing_activated",
          newSL: null,
          updatedExitFlags: exitFlags,
          detail: `Trailing stop activated at ${bestRMultiple.toFixed(2)}R (trigger: ${config.trailingStopActivation}, distance: ${proportionalTrailPips.toFixed(1)} pips = 0.5× SL) — SL already better at ${sl.toFixed(5)}`,
          rMultiple,
        };
      }
    }
  } else if (config.trailingStopEnabled && trailingAlreadyActivated && rMultiple > 0) {
    // ── Phase B: Trailing tightening — ratchet SL forward ──
    const prevTrailLevel = exitFlags.trailingStopLevel ?? sl;
    const effectiveTrailPips = exitFlags.trailingStopPips ?? config.trailingStopPips;

    let newTrailLevel: number;
    let trailReason: string;

    if (config.adaptiveTrailingEnabled && input.adaptiveTrailCandles) {
      // Adaptive trailing (momentum-fade)
      const adaptiveResult = computeAdaptiveTrail({
        entryPrice,
        currentPrice,
        currentSL: sl,
        direction,
        rMultiple,
        regimeInfo: input.regimeInfo,
        atrValue: input.atrValue,
        pipSize: spec.pipSize,
        recentCandles: input.adaptiveTrailCandles.slice(-10),
        baseTrailATRMultiple: config.baseTrailATRMultiple ?? 1.5,
        momentumFadeThreshold: config.momentumFadeThreshold ?? 0.4,
        tightenFactor: config.trailTightenFactor ?? 0.6,
        widenFactor: config.trailWidenFactor ?? 1.3,
      });
      newTrailLevel = adaptiveResult.newSL;
      trailReason = `Adaptive trail (${adaptiveResult.momentumState}): ${adaptiveResult.reason} → ${adaptiveResult.trailDistancePips.toFixed(1)} pips`;
    } else {
      // Fixed-pip trailing
      newTrailLevel = direction === "long"
        ? currentPrice - (effectiveTrailPips * spec.pipSize)
        : currentPrice + (effectiveTrailPips * spec.pipSize);
      trailReason = `Fixed trail: ${effectiveTrailPips} pips behind price`;
    }

    // Only ratchet forward (tighten), never widen
    const shouldTighten = direction === "long"
      ? newTrailLevel > sl && newTrailLevel > prevTrailLevel
      : newTrailLevel < sl && newTrailLevel < prevTrailLevel;

    if (shouldTighten) {
      exitFlags.trailingStopLevel = newTrailLevel;
      return {
        action: "trailing_tightened",
        newSL: roundPrice(newTrailLevel, spec.pipSize),
        updatedExitFlags: exitFlags,
        detail: `Trailing SL tightened at ${rMultiple.toFixed(2)}R — SL moved from ${sl.toFixed(5)} to ${roundPrice(newTrailLevel, spec.pipSize).toFixed(5)} | ${trailReason}`,
        rMultiple,
      };
    }
  }

  // ── 4. STRUCTURE INVALIDATION (one-shot 50% tighten with floor) ──
  if (
    config.structureInvalidationEnabled &&
    !exitFlags.structureInvalidationFired &&
    rMultiple < 0 && rMultiple > -0.8 &&
    input.structureCheck &&
    input.structureCheck.chochAgainstCount > 0
  ) {
    const structureAgainst =
      (direction === "long" && input.structureCheck.trend === "bearish") ||
      (direction === "short" && input.structureCheck.trend === "bullish");

    if (structureAgainst) {
      const currentSLDistance = Math.abs(currentPrice - sl);
      const tightenedDistance = currentSLDistance * 0.5;
      let newSL = direction === "long"
        ? currentPrice - tightenedDistance
        : currentPrice + tightenedDistance;

      // SL Floor enforcement
      const mgmtFloorPips = MGMT_SL_FLOOR_PIPS[input.symbol] ?? 10;
      const mgmtFloorDistance = mgmtFloorPips * spec.pipSize;
      const newSLDistFromEntry = Math.abs(entryPrice - newSL);
      if (newSLDistFromEntry < mgmtFloorDistance) {
        newSL = direction === "long"
          ? entryPrice - mgmtFloorDistance
          : entryPrice + mgmtFloorDistance;
      }

      // Only tighten (never widen)
      const shouldTighten = direction === "long" ? newSL > sl : newSL < sl;
      if (shouldTighten) {
        exitFlags.structureInvalidationFired = true;
        return {
          action: "structure_invalidated",
          newSL: roundPrice(newSL, spec.pipSize),
          updatedExitFlags: exitFlags,
          detail: `CHoCH against ${direction} detected (${input.structureCheck.chochAgainstCount} events) — structure now ${input.structureCheck.trend} — SL tightened from ${sl.toFixed(5)} to ${roundPrice(newSL, spec.pipSize).toFixed(5)} (floor: ${mgmtFloorPips}p, one-shot)`,
          rMultiple,
        };
      }
    }
  }

  // ── 5. SESSION-CLOSE BE (scalpers only, off-hours) ──
  if (
    config.tradingStyle === "scalper" &&
    rMultiple > 0.3 &&
    config.breakEvenEnabled &&
    (input.currentSession === "offhours" || input.currentSession === "off-hours")
  ) {
    const beSL = direction === "long"
      ? entryPrice + (spec.pipSize * config.breakEvenOffsetPips)
      : entryPrice - (spec.pipSize * config.breakEvenOffsetPips);
    const shouldMove = direction === "long" ? beSL > sl : beSL < sl;
    if (shouldMove) {
      return {
        action: "session_close_be",
        newSL: roundPrice(beSL, spec.pipSize),
        updatedExitFlags: exitFlags,
        detail: `Session ended (now ${input.currentSession}) at ${rMultiple.toFixed(2)}R — SL moved to breakeven at ${roundPrice(beSL, spec.pipSize).toFixed(5)}`,
        rMultiple,
      };
    }
  }

  return noChange();
}
