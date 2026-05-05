/**
 * _shared/scannerManagement.ts — Setup Classifier + Autonomous Trade Management
 * ──────────────────────────────────────────────────────────────────────────
 * Exports:
 *   Types:       SetupClassification, ManagementAction, ExitAttribution
 *   Functions:   classifySetupType, manageOpenPositions
 *   Constants:   EXECUTION_PROFILES
 *
 * DESIGN NOTES (v2):
 *   • manageOpenPositions is now FULLY DECOUPLED from classifySetupType.
 *     It reads management parameters (trailing, partial TP, break-even,
 *     max hold) directly from the user's config — not from setupType.
 *   • classifySetupType still runs for analytics/logging but has ZERO
 *     influence on live trade management behavior.
 *   • Every management action now carries an ExitAttribution object that
 *     records exactly which condition fired, the market context at the
 *     time, and the R-multiple — enabling post-trade analysis.
 */

import type {
  Candle,
  SwingPoint,
  ReasoningFactor,
  SilverBulletResult,
  MacroWindowResult,
  AMDResult,
  DisplacementResult,
} from "./smcAnalysis.ts";

import {
  SPECS,
  analyzeMarketStructure,
  detectSwingPoints,
} from "./smcAnalysis.ts";

// ─── Setup Classification Types ──────────────────────────────────────

export interface SetupClassification {
  setupType: "scalp" | "day_trade" | "swing";
  confidence: number;       // 0–1
  rationale: string;        // human-readable explanation
  executionProfile: {
    tpRatio: number;
    slBufferPips: number;
    maxHoldHours: number;
    tpMethod: string;       // "nearest_liquidity" | "next_level" | "rr_ratio"
  };
}

// ─── Execution Profiles per Setup Type (informational only) ─────────

export const EXECUTION_PROFILES: Record<string, SetupClassification["executionProfile"]> = {
  scalp: {
    tpRatio: 1.5,
    slBufferPips: 1,
    maxHoldHours: 2,
    tpMethod: "nearest_liquidity",
  },
  day_trade: {
    tpRatio: 2.0,
    slBufferPips: 2,
    maxHoldHours: 8,
    tpMethod: "next_level",
  },
  swing: {
    tpRatio: 3.0,
    slBufferPips: 5,
    maxHoldHours: 72,
    tpMethod: "rr_ratio",
  },
};

// ─── Exit Attribution ──────────────────────────────────────────────────
// Every management action carries this so you can analyze WHY trades closed.

export interface ExitAttribution {
  trigger: "trailing_stop" | "break_even" | "partial_tp" | "structure_invalidated"
         | "session_close" | "max_hold_exceeded" | "tp_hit" | "sl_hit"
         | "trailing_enabled" | "partial_enabled" | "be_enabled" | "no_action";
  detail: string;           // human-readable explanation
  rMultiple: number;        // R-multiple at time of action
  timestamp: string;        // ISO-8601
  marketContext?: {
    trend?: string;         // current structure trend
    chochCount?: number;    // CHoCH events against trade
    session?: string;       // active session at time of action
  };
}

// ─── Setup Classifier ──────────────────────────────────────────────────
// Reads the confluence factors that fired and classifies the trade setup
// as scalp, day_trade, or swing based on the STRUCTURE of the setup.
// This is INFORMATIONAL ONLY — it does NOT influence management behavior.

export function classifySetupType(analysis: {
  factors: ReasoningFactor[];
  session: { name: string; isKillZone: boolean };
  silverBullet: SilverBulletResult;
  macroWindow: MacroWindowResult;
  amd: AMDResult;
  displacement: DisplacementResult;
  pd: { currentZone: string; zonePercent: number; oteZone: boolean };
  regimeInfo: { regime: string; confidence: number; atrTrend: string; bias: string } | null;
  structure: { trend: "bullish" | "bearish" | "ranging"; swingPoints: SwingPoint[]; bos: any[]; choch: any[] };
  direction: string | null;
  score: number;
}): SetupClassification {
  const f = (name: string) => analysis.factors.find(x => x.name === name);
  const fired = (name: string) => f(name)?.present === true;

  // ── Score each setup type based on which factors fired ──
  let scalpScore = 0;
  let dayScore = 0;
  let swingScore = 0;
  const reasons: { scalp: string[]; day: string[]; swing: string[] } = { scalp: [], day: [], swing: [] };

  // ── TIMING factors → heavily favor scalp ──
  if (analysis.session.isKillZone) {
    scalpScore += 2; reasons.scalp.push("Kill zone active");
    dayScore += 1;
  }
  if (analysis.silverBullet.active) {
    scalpScore += 2.5; reasons.scalp.push(`Silver Bullet ${analysis.silverBullet.window}`);
  }
  if (analysis.macroWindow.active) {
    scalpScore += 1.5; reasons.scalp.push(`Macro window ${analysis.macroWindow.window}`);
  }

  // ── AMD Phase → scalp if manipulation/distribution, day if accumulation ──
  if (analysis.amd.phase === "manipulation") {
    scalpScore += 2; reasons.scalp.push("AMD manipulation phase (fake-out)");
  } else if (analysis.amd.phase === "distribution") {
    scalpScore += 1.5; reasons.scalp.push("AMD distribution phase");
    dayScore += 1; reasons.day.push("AMD distribution");
  } else if (analysis.amd.phase === "accumulation") {
    dayScore += 1.5; reasons.day.push("AMD accumulation (building)");
  }

  // ── Liquidity Sweep → scalp (quick reversal play) ──
  if (fired("Liquidity Sweep")) {
    scalpScore += 2; reasons.scalp.push("Liquidity sweep detected");
  }

  // ── Judas Swing → scalp (fake-out reversal) ──
  if (fired("Judas Swing")) {
    scalpScore += 1.5; reasons.scalp.push("Judas swing (false move)");
  }

  // ── Reversal Candle → scalp (immediate entry signal) ──
  if (fired("Reversal Candle")) {
    scalpScore += 1; reasons.scalp.push("Reversal candle confirmation");
  }

  // ── FVG → day trade (gap fill play) ──
  if (fired("Fair Value Gap")) {
    dayScore += 1.5; reasons.day.push("FVG present");
    scalpScore += 0.5;
  }

  // ── Order Block → day trade (zone-based entry) ──
  if (fired("Order Block")) {
    dayScore += 2; reasons.day.push("Order block entry");
    scalpScore += 0.5;
  }

  // ── Market Structure (BOS/CHoCH) → day trade ──
  if (fired("Market Structure")) {
    dayScore += 2; reasons.day.push("Structure break (BOS/CHoCH)");
    swingScore += 0.5;
  }

  // ── Trend Direction → day trade ──
  if (fired("Trend Direction")) {
    dayScore += 1; reasons.day.push("Trend direction aligned");
    swingScore += 0.5;
  }

  // ── Daily Bias (HTF alignment) → swing ──
  if (fired("Daily Bias")) {
    swingScore += 2.5; reasons.swing.push("Daily bias aligned");
    dayScore += 1; reasons.day.push("Daily bias supports");
  }

  // ── Premium/Discount deep zone → swing ──
  const zp = analysis.pd.zonePercent;
  if (zp <= 25 || zp >= 75) {
    swingScore += 2; reasons.swing.push(`Deep ${zp <= 25 ? "discount" : "premium"} zone (${zp.toFixed(0)}%)`);
    dayScore += 0.5;
  } else if (analysis.pd.oteZone) {
    dayScore += 1; reasons.day.push("OTE zone");
  }

  // ── Displacement → swing (strong momentum) ──
  if (analysis.displacement.isDisplacement) {
    swingScore += 2; reasons.swing.push(`Displacement (${analysis.displacement.displacementCandles.length} candles)`);
    dayScore += 0.5;
  }

  // ── Volume Profile → swing (institutional footprint) ──
  if (fired("Volume Profile")) {
    swingScore += 1.5; reasons.swing.push("Volume profile alignment");
  }

  // ── Breaker Block → swing (HTF structure reclaim) ──
  if (fired("Breaker Block")) {
    swingScore += 1.5; reasons.swing.push("Breaker block (HTF reclaim)");
  }

  // ── Unicorn Model → day trade (complex setup) ──
  if (fired("Unicorn Model")) {
    dayScore += 1.5; reasons.day.push("Unicorn model");
  }

  // ── SMT Divergence → swing (macro confirmation) ──
  if (fired("SMT Divergence")) {
    swingScore += 1.5; reasons.swing.push("SMT divergence (macro)");
  }

  // ── Currency Strength → swing (macro flow) ──
  if (fired("Currency Strength")) {
    swingScore += 1; reasons.swing.push("Currency strength aligned");
  }

  // ── Regime → swing if trending with confidence ──
  if (analysis.regimeInfo && analysis.regimeInfo.confidence >= 0.7) {
    if (analysis.regimeInfo.regime === "trending" || analysis.regimeInfo.regime === "strong_trend") {
      swingScore += 2; reasons.swing.push(`Regime: ${analysis.regimeInfo.regime} (${(analysis.regimeInfo.confidence * 100).toFixed(0)}%)`);
    } else if (analysis.regimeInfo.regime === "ranging" || analysis.regimeInfo.regime === "choppy") {
      scalpScore += 1.5; reasons.scalp.push(`Regime: ${analysis.regimeInfo.regime} (range-bound)`);
    }
  }

  // ── PD/PW Levels → day trade (intraday targets) ──
  if (fired("PD/PW Levels")) {
    dayScore += 1; reasons.day.push("PD/PW levels active");
  }

  // ── Classify ──
  const maxScore = Math.max(scalpScore, dayScore, swingScore);
  const totalScore = scalpScore + dayScore + swingScore;

  let setupType: "scalp" | "day_trade" | "swing";
  let rationale: string;

  if (maxScore === 0) {
    setupType = "day_trade";
    rationale = "No strong setup signals — defaulting to day trade";
  } else if (scalpScore >= dayScore && scalpScore >= swingScore) {
    setupType = "scalp";
    rationale = reasons.scalp.join(", ");
  } else if (swingScore >= dayScore && swingScore >= scalpScore) {
    setupType = "swing";
    rationale = reasons.swing.join(", ");
  } else {
    setupType = "day_trade";
    rationale = reasons.day.join(", ");
  }

  // Confidence = how dominant the winning type is vs the others
  const confidence = totalScore > 0 ? Math.min(1, maxScore / totalScore + 0.2) : 0.5;

  return {
    setupType,
    confidence,
    rationale: `[${setupType.toUpperCase()}] ${rationale} (scores: scalp=${scalpScore.toFixed(1)}, day=${dayScore.toFixed(1)}, swing=${swingScore.toFixed(1)})`,
    executionProfile: EXECUTION_PROFILES[setupType],
  };
}

// ─── Management Action ────────────────────────────────────────────────

export interface ManagementAction {
  positionId: string;
  symbol: string;
  action: "sl_tightened" | "tp_extended" | "early_exit" | "trailing_enabled" | "partial_enabled" | "be_enabled" | "no_change";
  reason: string;
  newSL?: number;
  newTP?: number;
  attribution: ExitAttribution;
}

// ─── Active Trade Management Engine (v2 — config-driven) ──────────────
// Runs at the start of each scan cycle BEFORE scanning for new trades.
// Re-evaluates open positions, adjusts SL/TP, and flags early exits
// when the setup invalidates.
//
// ALL management decisions are driven by the user's config:
//   config.trailingStopEnabled / trailingStopPips / trailingStopActivation
//   config.partialTPEnabled / partialTPPercent / partialTPLevel
//   config.breakEvenEnabled / breakEvenPips
//   config.maxHoldHours
//
// classifySetupType output is NOT used here.

export async function manageOpenPositions(
  supabase: any,
  positions: any[],
  config: any,
  scanCycleId: string,
  // Injected dependencies to avoid circular imports:
  fetchCandlesFn: (symbol: string, interval: string, range: string) => Promise<Candle[]>,
  detectSessionFn: (config?: any) => { name: string; isKillZone: boolean; filterKey?: string },
): Promise<ManagementAction[]> {
  const actions: ManagementAction[] = [];
  if (!positions || positions.length === 0) return actions;

  // Read trading style for style-aware management decisions
  const tradingStyle: string = config.tradingStyle?.mode ?? "day_trader";

  // Read management params from user config (set via STYLE_OVERRIDES + user overrides)
  const trailingEnabled = config.trailingStopEnabled ?? false;
  const trailingPips = config.trailingStopPips ?? 15;
  const trailingActivation = config.trailingStopActivation ?? "after_1r";
  const trailingMode: "proportional" | "structure" = config.trailingStopMode ?? "proportional";
  const partialTPEnabled = config.partialTPEnabled ?? false;
  const partialTPPercent = config.partialTPPercent ?? 50;
  const partialTPLevel = config.partialTPLevel ?? 1.0;
  const breakEvenEnabled = config.breakEvenEnabled ?? true;
  const breakEvenPips = config.breakEvenPips ?? 20;
  const maxHoldEnabled = config.maxHoldEnabled ?? false;
  const maxHoldHours = config.maxHoldHours ?? 0; // 0 = no limit

  // Helper: round price to instrument precision to avoid floating point garbage
  // e.g. pipSize 0.01 → 2 decimals, pipSize 0.0001 → 4 decimals, pipSize 1 → 0 decimals
  const roundPrice = (price: number, pipSize: number): number => {
    const decimals = Math.max(0, Math.round(-Math.log10(pipSize)) + 1);
    const factor = Math.pow(10, decimals);
    return Math.round(price * factor) / factor;
  };

  for (const pos of positions) {
    try {
      const symbol: string = pos.symbol;
      const spec = SPECS[symbol];
      if (!spec) continue;

      const entryPrice = parseFloat(pos.entry_price);
      const currentPrice = parseFloat(pos.current_price);
      const sl = pos.stop_loss ? parseFloat(pos.stop_loss) : null;
      const tp = pos.take_profit ? parseFloat(pos.take_profit) : null;
      if (!sl || !tp) continue;

      // Parse existing signal_reason
      let signalData: any = {};
      try { signalData = JSON.parse(pos.signal_reason || "{}"); } catch {};
      const exitFlags = signalData.exitFlags || {};

      // ── Per-Trade Overrides: individual position settings override global config ──
      // If trade_overrides JSON exists on this position, those values take priority.
      // Missing fields fall back to the global config values read above.
      let posTrailingEnabled = trailingEnabled;
      let posTrailingPips = trailingPips;
      let posTrailingActivation = trailingActivation;
      let posTrailingMode = trailingMode;
      let posBreakEvenEnabled = breakEvenEnabled;
      let posBreakEvenPips = breakEvenPips;
      let posPartialTPEnabled = partialTPEnabled;
      let posPartialTPPercent = partialTPPercent;
      let posPartialTPLevel = partialTPLevel;
      let posMaxHoldEnabled = maxHoldEnabled;
      let posMaxHoldHours = maxHoldHours;
      if (pos.trade_overrides) {
        let overrides: any = {};
        try { overrides = typeof pos.trade_overrides === 'string' ? JSON.parse(pos.trade_overrides) : pos.trade_overrides; } catch {}
        if (overrides.trailingStopEnabled !== undefined) posTrailingEnabled = overrides.trailingStopEnabled;
        if (overrides.trailingStopPips !== undefined) posTrailingPips = overrides.trailingStopPips;
        if (overrides.trailingStopActivation !== undefined) posTrailingActivation = overrides.trailingStopActivation;
        if (overrides.trailingStopMode !== undefined) posTrailingMode = overrides.trailingStopMode;
        if (overrides.breakEvenEnabled !== undefined) posBreakEvenEnabled = overrides.breakEvenEnabled;
        if (overrides.breakEvenPips !== undefined) posBreakEvenPips = overrides.breakEvenPips;
        if (overrides.partialTPEnabled !== undefined) posPartialTPEnabled = overrides.partialTPEnabled;
        if (overrides.partialTPPercent !== undefined) posPartialTPPercent = overrides.partialTPPercent;
        if (overrides.partialTPLevel !== undefined) posPartialTPLevel = overrides.partialTPLevel;
        if (overrides.maxHoldEnabled !== undefined) posMaxHoldEnabled = overrides.maxHoldEnabled;
        if (overrides.maxHoldHours !== undefined) posMaxHoldHours = overrides.maxHoldHours;
        // Direct SL/TP override: if user manually set a new SL or TP price
        // These are applied immediately via the update-trade API, not here.
        // Management respects the current pos.stop_loss and pos.take_profit values.
      }

      // Calculate current R-multiple using ORIGINAL SL (not the moved SL after BE/trailing)
      // signalData.originalSL is stored at trade open time; fall back to current SL for legacy trades
      const originalSl = signalData.originalSL != null ? parseFloat(signalData.originalSL) : sl;
      const riskPips = Math.abs(entryPrice - originalSl) / spec.pipSize;
      const profitPips = pos.direction === "long"
        ? (currentPrice - entryPrice) / spec.pipSize
        : (entryPrice - currentPrice) / spec.pipSize;
      const rMultiple = riskPips > 0 ? profitPips / riskPips : 0;

      // Calculate hold time
      const openedAt = new Date(pos.created_at || pos.opened_at || Date.now());
      const holdHours = (Date.now() - openedAt.getTime()) / (1000 * 60 * 60);

      // Track whether exitFlags were modified this cycle
      let exitFlagsUpdated = false;
      const updatedFlags = { ...exitFlags };

      // Helper to build attribution
      const makeAttribution = (
        trigger: ExitAttribution["trigger"],
        detail: string,
        marketContext?: ExitAttribution["marketContext"],
      ): ExitAttribution => ({
        trigger,
        detail,
        rMultiple: parseFloat(rMultiple.toFixed(3)),
        timestamp: new Date().toISOString(),
        marketContext,
      });

      // ── 1. MAX HOLD TIME CHECK ──
      // If maxHoldEnabled and maxHoldHours is set and exceeded, flag for tightening
      if (posMaxHoldEnabled && posMaxHoldHours > 0 && holdHours >= posMaxHoldHours) {
        // Move SL to breakeven or close if in profit
        if (rMultiple > 0) {
          const beSL = pos.direction === "long"
            ? entryPrice + (spec.pipSize * 1)
            : entryPrice - (spec.pipSize * 1);
          const shouldMove = pos.direction === "long" ? beSL > sl : beSL < sl;
          if (shouldMove) {
            const attribution = makeAttribution(
              "max_hold_exceeded",
              `Position held ${holdHours.toFixed(1)}h, max allowed ${posMaxHoldHours}h — SL moved to breakeven`,
            );
            const updatedSignal = {
              ...signalData,
              exitFlags: { ...updatedFlags, maxHoldExceeded: true },
              exitAttribution: [...(signalData.exitAttribution || []), attribution],
            };
            await supabase.from("paper_positions").update({
              stop_loss: roundPrice(beSL, spec.pipSize).toString(),
              signal_reason: JSON.stringify(updatedSignal),
            }).eq("id", pos.id);

            actions.push({
              positionId: pos.position_id, symbol, action: "sl_tightened",
              reason: attribution.detail, newSL: roundPrice(beSL, spec.pipSize), attribution,
            });
            console.log(`[mgmt ${scanCycleId}] MAX HOLD ${symbol} | ${holdHours.toFixed(1)}h/${posMaxHoldHours}h | SL→BE at ${beSL.toFixed(5)}`);
            continue;
          }
        }
      }

      // ── 2. BREAK-EVEN ACTIVATION (R-based) ──
      // Triggers when trade reaches a certain R-multiple, not a fixed pip count.
      // This ensures BE activates proportionally to the trade's risk — a 40-pip SL trade
      // won't get stopped at BE on a normal pullback the way a 20-pip fixed trigger would.
      // breakEvenPips is now interpreted as a fallback; primary trigger is R-based.
      const beActivationR = posBreakEvenPips > 0 && riskPips > 0
        ? Math.min(2.0, Math.max(1.0, posBreakEvenPips / riskPips))  // At least 1R, capped at 2R max
        : 1.0;  // Default: activate BE at 1R
      if (posBreakEvenEnabled && !exitFlags.breakEvenActivated && rMultiple >= beActivationR) {
        const profitPipsAbs = Math.abs(profitPips);
        const beSL = pos.direction === "long"
          ? entryPrice + (spec.pipSize * 1) // 1 pip above entry
          : entryPrice - (spec.pipSize * 1);
        const shouldMove = pos.direction === "long" ? beSL > sl : beSL < sl;
        if (shouldMove) {
          const attribution = makeAttribution(
            "be_enabled",
            `Break-even activated at ${rMultiple.toFixed(2)}R / ${profitPipsAbs.toFixed(1)} pips profit (trigger: ${beActivationR.toFixed(2)}R) — SL moved to ${beSL.toFixed(5)}`,
          );
          updatedFlags.breakEvenActivated = true;
          exitFlagsUpdated = true;

          const updatedSignal = {
            ...signalData,
            exitFlags: updatedFlags,
            exitAttribution: [...(signalData.exitAttribution || []), attribution],
          };
          await supabase.from("paper_positions").update({
            stop_loss: roundPrice(beSL, spec.pipSize).toString(),
            signal_reason: JSON.stringify(updatedSignal),
          }).eq("id", pos.id);

          actions.push({
            positionId: pos.position_id, symbol, action: "be_enabled",
            reason: attribution.detail, newSL: roundPrice(beSL, spec.pipSize), attribution,
          });
          console.log(`[mgmt ${scanCycleId}] BREAK-EVEN ${symbol} ${pos.direction} | ${rMultiple.toFixed(2)}R / +${profitPipsAbs.toFixed(1)} pips (trigger: ${beActivationR.toFixed(2)}R) | SL→${beSL.toFixed(5)}`);
          continue;
        }
      }

      // ── 3. TRAILING STOP ACTIVATION + TIGHTENING (R-proportional) ──
      // Trail distance is now proportional to the SL distance (0.5× SL) instead of a fixed pip count.
      // This ensures a 40-pip SL trade trails at 20 pips, while a 15-pip SL trade trails at 7.5 pips.
      // If partial TP is enabled, trailing only activates AFTER partial TP has been triggered,
      // letting the trade run freely to its first target.
      const trailingAlreadyActivated = exitFlags.trailingStopActivated === true;
      // Proportional trail distance: use config trailingPips as a minimum, but prefer 50% of SL distance
      const proportionalTrailPips = Math.max(posTrailingPips, riskPips * 0.5);
      // If partial TP is enabled, delay trailing activation until partial TP has fired
      const partialTPBlocksTrailing = posPartialTPEnabled && !exitFlags.partialTPActivated;
      if (posTrailingEnabled && !trailingAlreadyActivated && !partialTPBlocksTrailing) {
        // ── Phase A: First-time activation ──
        const activationR = posTrailingActivation === "after_1r" ? 1.0
          : posTrailingActivation === "after_0.5r" ? 0.5
          : posTrailingActivation === "after_1.5r" ? 1.5
          : posTrailingActivation === "after_2r" ? 2.0
          : posTrailingActivation === "immediate" ? 0.0
          : 1.0;

        if (rMultiple >= activationR) {
          const newTrailLevel = pos.direction === "long"
            ? currentPrice - (proportionalTrailPips * spec.pipSize)
            : currentPrice + (proportionalTrailPips * spec.pipSize);
          updatedFlags.trailingStopActivated = true;
          updatedFlags.trailingStopLevel = newTrailLevel;
          updatedFlags.trailingStopPips = Math.round(proportionalTrailPips * 10) / 10; // Store the actual proportional distance
          updatedFlags.trailingStopActivation = posTrailingActivation;
          exitFlagsUpdated = true;

          // Also move the actual SL if the trail level is better than current SL
          const shouldMoveSL = pos.direction === "long" ? newTrailLevel > sl : newTrailLevel < sl;
          if (shouldMoveSL) {
            const attribution = makeAttribution(
              "trailing_enabled",
              `Trailing stop activated at ${rMultiple.toFixed(2)}R (trigger: ${posTrailingActivation}, distance: ${proportionalTrailPips.toFixed(1)} pips = 0.5× SL) — SL moved to ${newTrailLevel.toFixed(5)}`,
            );
            const updatedSignal = {
              ...signalData,
              exitFlags: updatedFlags,
              exitAttribution: [...(signalData.exitAttribution || []), attribution],
            };
            await supabase.from("paper_positions").update({
              stop_loss: roundPrice(newTrailLevel, spec.pipSize).toString(),
              signal_reason: JSON.stringify(updatedSignal),
            }).eq("id", pos.id);

            actions.push({
              positionId: pos.position_id, symbol, action: "trailing_enabled",
              reason: attribution.detail, newSL: roundPrice(newTrailLevel, spec.pipSize), attribution,
            });
            console.log(`[mgmt ${scanCycleId}] TRAILING ON ${symbol} | ${rMultiple.toFixed(2)}R | SL→${newTrailLevel.toFixed(5)} (${proportionalTrailPips.toFixed(1)} pips trail = 0.5× SL)`);
            continue;
          } else {
            const attribution = makeAttribution(
              "trailing_enabled",
              `Trailing stop activated at ${rMultiple.toFixed(2)}R (trigger: ${posTrailingActivation}, distance: ${proportionalTrailPips.toFixed(1)} pips = 0.5× SL) — SL already better, keeping ${sl.toFixed(5)}`,
            );
            actions.push({
              positionId: pos.position_id, symbol, action: "trailing_enabled",
              reason: attribution.detail, attribution,
            });
            console.log(`[mgmt ${scanCycleId}] TRAILING ON ${symbol} | ${rMultiple.toFixed(2)}R | SL already better at ${sl.toFixed(5)}`);
          }
        }
      } else if (posTrailingEnabled && trailingAlreadyActivated && rMultiple > 0) {
        // ── Phase B: Trailing tightening — ratchet SL forward ──
        const prevTrailLevel = exitFlags.trailingStopLevel ?? sl;
        const effectiveTrailPips = exitFlags.trailingStopPips ?? posTrailingPips;
        let newTrailLevel: number | null = null;
        let trailMethod = "proportional"; // track which method produced the trail for attribution

        // ── Structure-based trailing: trail to swing points ──
        if (posTrailingMode === "structure") {
          try {
            const trailTF = signalData.entryTimeframe || "15m";
            const trailCandles = await fetchCandlesFn(symbol, trailTF, "2d").catch(() => [] as Candle[]);
            if (trailCandles.length >= 20) {
              // Detect swing points with ATR filter to ignore noise
              const swings = detectSwingPoints(trailCandles, 3, 0.3);
              const bufferPips = config.slBufferPips ?? 2;
              const bufferPrice = bufferPips * spec.pipSize;

              if (pos.direction === "long") {
                // Find swing lows that are above current SL and below current price
                const validSwingLows = swings
                  .filter(s => s.type === "low" && s.price > sl && s.price < currentPrice)
                  .map(s => s.price);
                if (validSwingLows.length > 0) {
                  // Pick the highest swing low (most protective)
                  const bestSwing = Math.max(...validSwingLows);
                  const candidateSL = bestSwing - bufferPrice;
                  // Only use if it's actually better than current SL
                  if (candidateSL > sl) {
                    newTrailLevel = candidateSL;
                    trailMethod = "structure";
                  }
                }
              } else {
                // Short: find swing highs that are below current SL and above current price
                const validSwingHighs = swings
                  .filter(s => s.type === "high" && s.price < sl && s.price > currentPrice)
                  .map(s => s.price);
                if (validSwingHighs.length > 0) {
                  // Pick the lowest swing high (most protective)
                  const bestSwing = Math.min(...validSwingHighs);
                  const candidateSL = bestSwing + bufferPrice;
                  // Only use if it's actually better (lower) than current SL
                  if (candidateSL < sl) {
                    newTrailLevel = candidateSL;
                    trailMethod = "structure";
                  }
                }
              }
            }
          } catch (e) {
            // Structure trail failed — fall through to proportional
            console.warn(`[mgmt ${scanCycleId}] Structure trail fetch failed for ${symbol}: ${e}`);
          }
        }

        // ── Proportional fallback (or primary if mode is "proportional") ──
        if (newTrailLevel === null) {
          const proportionalLevel = pos.direction === "long"
            ? currentPrice - (effectiveTrailPips * spec.pipSize)
            : currentPrice + (effectiveTrailPips * spec.pipSize);
          // Only use proportional if it would tighten
          const proportionalTightens = pos.direction === "long"
            ? proportionalLevel > sl && proportionalLevel > prevTrailLevel
            : proportionalLevel < sl && proportionalLevel < prevTrailLevel;
          if (proportionalTightens) {
            newTrailLevel = proportionalLevel;
            trailMethod = "proportional";
          }
        }

        // ── Apply the trail if we found a valid new level ──
        if (newTrailLevel !== null) {
          // Final safety: only ratchet forward, never widen
          const shouldTighten = pos.direction === "long"
            ? newTrailLevel > sl && newTrailLevel > prevTrailLevel
            : newTrailLevel < sl && newTrailLevel < prevTrailLevel;

          if (shouldTighten) {
            updatedFlags.trailingStopLevel = newTrailLevel;
            exitFlagsUpdated = true;

            const trailDetail = trailMethod === "structure"
              ? `Structure trail: SL moved to swing point at ${newTrailLevel.toFixed(5)}`
              : `Proportional trail: SL moved ${effectiveTrailPips} pips behind price`;
            const attribution = makeAttribution(
              "trailing_stop",
              `Trailing SL tightened at ${rMultiple.toFixed(2)}R [${trailMethod}] — SL moved from ${sl.toFixed(5)} to ${newTrailLevel.toFixed(5)} (${trailDetail})`,
            );
            const updatedSignal = {
              ...signalData,
              exitFlags: updatedFlags,
              exitAttribution: [...(signalData.exitAttribution || []), attribution],
            };
            await supabase.from("paper_positions").update({
              stop_loss: roundPrice(newTrailLevel, spec.pipSize).toString(),
              signal_reason: JSON.stringify(updatedSignal),
            }).eq("id", pos.id);

            actions.push({
              positionId: pos.position_id, symbol, action: "sl_tightened",
              reason: attribution.detail, newSL: roundPrice(newTrailLevel, spec.pipSize), attribution,
            });
            console.log(`[mgmt ${scanCycleId}] TRAIL TIGHTEN [${trailMethod}] ${symbol} | ${rMultiple.toFixed(2)}R | SL ${sl.toFixed(5)}→${newTrailLevel.toFixed(5)}`);
            continue;
          }
        }
      }

      // ── 4. PARTIAL TP ACTIVATION ──
      // If partial TP is enabled in config and hasn't been activated yet
      // Use partialTPActivated (new format). Old positions stored partialTP
      // as config intent — check the dedicated Activated field.
      const partialAlreadyActivated = exitFlags.partialTPActivated === true;
      if (posPartialTPEnabled && !partialAlreadyActivated && rMultiple >= posPartialTPLevel) {
        updatedFlags.partialTPActivated = true;
        updatedFlags.partialTPPercent = posPartialTPPercent;
        updatedFlags.partialTPLevel = posPartialTPLevel;
        exitFlagsUpdated = true;

        const attribution = makeAttribution(
          "partial_enabled",
          `Partial TP enabled at ${rMultiple.toFixed(2)}R — ${posPartialTPPercent}% at ${posPartialTPLevel}R`,
        );
        actions.push({
          positionId: pos.position_id, symbol, action: "partial_enabled",
          reason: attribution.detail, attribution,
        });
        console.log(`[mgmt ${scanCycleId}] PARTIAL TP ${symbol} | ${rMultiple.toFixed(2)}R | ${posPartialTPPercent}% at ${posPartialTPLevel}R`);
      }

      // ── 5. STRUCTURE INVALIDATION CHECK ──
      // If the trade is underwater but not yet at SL, check if structure broke against it.
      // ONE-SHOT: only fires once per position to prevent progressive squeeze.
      // Without this guard, repeated CHoCH detections would halve the SL distance
      // every scan cycle, squeezing it to near-zero and guaranteeing a stop-out.
      const structureInvalidationEnabled = config.structureInvalidationEnabled ?? false;
      const structureInvalidationAlreadyFired = exitFlags.structureInvalidationFired === true;
      if (structureInvalidationEnabled && !structureInvalidationAlreadyFired && rMultiple < 0 && rMultiple > -0.8) {
        try {
          // C4 fix: Use the position's entry timeframe for structure invalidation
          // instead of hardcoded 15m. Scalpers (5m) need 5m structure checks,
          // swing traders (1h) need 1h structure checks. Falls back to 15m for
          // legacy positions that don't have entryTimeframe stored.
          const invalidationTF = signalData.entryTimeframe || "15m";
          const checkCandles = await fetchCandlesFn(symbol, invalidationTF, "2d").catch(() => [] as Candle[]);
          if (checkCandles.length >= 20) {
            const currentStructure = analyzeMarketStructure(checkCandles);

            // If structure has broken against the trade direction
            const structureAgainst =
              (pos.direction === "long" && currentStructure.trend === "bearish") ||
              (pos.direction === "short" && currentStructure.trend === "bullish");

            // Check for CHoCH against the trade (strongest invalidation signal)
            const chochAgainst = currentStructure.choch.filter((c: any) =>
              (pos.direction === "long" && c.type === "bearish") ||
              (pos.direction === "short" && c.type === "bullish")
            );
            const hasFreshCHoCH = chochAgainst.length > 0;

            if (structureAgainst && hasFreshCHoCH) {
              // Tighten SL to reduce loss — move SL 50% closer to current price
              const currentSLDistance = Math.abs(currentPrice - sl);
              const tightenedDistance = currentSLDistance * 0.5;
              let newSL = pos.direction === "long"
                ? currentPrice - tightenedDistance
                : currentPrice + tightenedDistance;

              // ── SL Floor Enforcement ──────────────────────────────────
              // Prevent structure invalidation from tightening SL below the
              // per-instrument minimum. Use 60% of the static floor as the
              // management floor — tighter than entry (acknowledging the
              // adverse CHoCH) but still wide enough to avoid noise stop-outs.
              const MGMT_SL_FLOOR_PIPS: Record<string, number> = {
                "GBP/JPY": 21, "EUR/JPY": 18, "USD/JPY": 15,
                "AUD/JPY": 15, "CAD/JPY": 15, "NZD/JPY": 15, "CHF/JPY": 15,
                "GBP/USD": 15, "GBP/AUD": 18, "GBP/CAD": 18, "GBP/NZD": 18, "GBP/CHF": 15,
                "EUR/USD": 12, "EUR/GBP": 9, "EUR/AUD": 15, "EUR/CAD": 15, "EUR/NZD": 15, "EUR/CHF": 11,
                "AUD/USD": 11, "NZD/USD": 11, "USD/CAD": 11, "USD/CHF": 11,
                "AUD/CAD": 12, "AUD/NZD": 12, "AUD/CHF": 12, "NZD/CAD": 12, "NZD/CHF": 12, "CAD/CHF": 11,
                "XAU/USD": 30, "BTC/USD": 90,
              };
              const mgmtFloorPips = MGMT_SL_FLOOR_PIPS[symbol] ?? 10;
              const mgmtFloorDistance = mgmtFloorPips * spec.pipSize;
              const newSLDistFromEntry = Math.abs(entryPrice - newSL);
              if (newSLDistFromEntry < mgmtFloorDistance) {
                newSL = pos.direction === "long"
                  ? entryPrice - mgmtFloorDistance
                  : entryPrice + mgmtFloorDistance;
                console.log(`[mgmt ${scanCycleId}] SL FLOOR enforced ${symbol} | tightened SL capped at ${mgmtFloorPips} pips from entry`);
              }

              // Only tighten (never widen)
              const shouldTighten = pos.direction === "long" ? newSL > sl : newSL < sl;
              if (shouldTighten) {
                // Mark as fired so this only happens once per position
                updatedFlags.structureInvalidationFired = true;
                exitFlagsUpdated = true;

                const attribution = makeAttribution(
                  "structure_invalidated",
                  `CHoCH against ${pos.direction} detected (${chochAgainst.length} events) — structure now ${currentStructure.trend} — SL tightened from ${sl.toFixed(5)} to ${newSL.toFixed(5)} (floor: ${mgmtFloorPips}p, one-shot)`,
                  {
                    trend: currentStructure.trend,
                    chochCount: chochAgainst.length,
                  },
                );
                const updatedSignalForSL = {
                  ...signalData,
                  exitFlags: updatedFlags,
                  invalidationHistory: [
                    ...(signalData.invalidationHistory || []),
                    { at: new Date().toISOString(), rMultiple: rMultiple.toFixed(2), reason: "CHoCH against trade direction (one-shot)" },
                  ],
                  exitAttribution: [...(signalData.exitAttribution || []), attribution],
                };
                await supabase.from("paper_positions").update({
                  stop_loss: roundPrice(newSL, spec.pipSize).toString(),
                  signal_reason: JSON.stringify(updatedSignalForSL),
                }).eq("id", pos.id);

                actions.push({
                  positionId: pos.position_id, symbol, action: "sl_tightened",
                  reason: attribution.detail, newSL: roundPrice(newSL, spec.pipSize), attribution,
                });
                console.log(`[mgmt ${scanCycleId}] SL TIGHTENED ${symbol} ${pos.direction} | CHoCH against | SL ${sl.toFixed(5)}→${newSL.toFixed(5)} at ${rMultiple.toFixed(2)}R`);
                continue; // Already handled
              }
            }
          }
        } catch (e: any) {
          console.warn(`[mgmt ${scanCycleId}] Invalidation check failed for ${symbol}: ${e?.message}`);
        }
      }

      // ── 6. SESSION-BASED MANAGEMENT ──
      // Only scalps get session-based tightening. Day trades and swings are
      // designed to be held across sessions — tightening them during off-hours
      // defeats their purpose.
      if (tradingStyle === "scalper" && rMultiple > 0.3) {
        const currentSession = detectSessionFn(config);
        // Use filterKey directly from session result (canonical: asian, london, newyork, offhours)
        const normalizedCurrentSession = currentSession.filterKey || currentSession.name.toLowerCase().replace(/[\s-]/g, "");

        if (normalizedCurrentSession === "offhours" || normalizedCurrentSession === "off-hours") {
          const beSL = pos.direction === "long"
            ? entryPrice + (spec.pipSize * 1)
            : entryPrice - (spec.pipSize * 1);
          const shouldMove = pos.direction === "long" ? beSL > sl : beSL < sl;
          if (shouldMove) {
            const attribution = makeAttribution(
              "session_close",
              `Session ended (now ${normalizedCurrentSession}) at ${rMultiple.toFixed(2)}R — SL moved to breakeven at ${beSL.toFixed(5)}`,
              { session: normalizedCurrentSession },
            );
            const updatedSignalForSession = {
              ...signalData,
              exitFlags: updatedFlags,
              exitAttribution: [...(signalData.exitAttribution || []), attribution],
            };
            await supabase.from("paper_positions").update({
              stop_loss: roundPrice(beSL, spec.pipSize).toString(),
              signal_reason: JSON.stringify(updatedSignalForSession),
            }).eq("id", pos.id);

            actions.push({
              positionId: pos.position_id, symbol, action: "sl_tightened",
              reason: attribution.detail, newSL: roundPrice(beSL, spec.pipSize), attribution,
            });
            console.log(`[mgmt ${scanCycleId}] SESSION END ${symbol} | SL→BE at ${beSL.toFixed(5)}`);
            continue;
          }
        }
      }

      // ── Write any exitFlags updates that were accumulated ──
      if (exitFlagsUpdated) {
        const updatedSignalData = { ...signalData, exitFlags: updatedFlags };
        await supabase.from("paper_positions").update({
          signal_reason: JSON.stringify(updatedSignalData),
        }).eq("id", pos.id);
      }

      // ── No action taken ──
      if (actions.filter(a => a.positionId === pos.position_id).length === 0) {
        const attribution = makeAttribution("no_action", `At ${rMultiple.toFixed(2)}R, ${holdHours.toFixed(1)}h held — no management action needed`);
        actions.push({
          positionId: pos.position_id, symbol, action: "no_change",
          reason: attribution.detail, attribution,
        });
      }

    } catch (e: any) {
      console.warn(`[mgmt ${scanCycleId}] Error managing ${pos.symbol}: ${e?.message}`);
    }
  }

  return actions;
}
