/**
 * _shared/scannerManagement.ts — Setup Classifier + Autonomous Trade Management
 * ──────────────────────────────────────────────────────────────────────────
 * Extracted from bot-scanner to reduce bundle size for Lovable deployment.
 * No logic changes — purely structural refactoring.
 *
 * Exports:
 *   Types:       SetupClassification, ManagementAction
 *   Functions:   classifySetupType, manageOpenPositions
 *   Constants:   EXECUTION_PROFILES, PROMOTION_MAP, PROMOTION_THRESHOLDS
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

// ─── Execution Profiles per Setup Type ──────────────────────────────

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

// ─── Setup Classifier ──────────────────────────────────────────────────
// Reads the confluence factors that fired and classifies the trade setup
// as scalp, day_trade, or swing based on the STRUCTURE of the setup,
// not just volatility. Returns the classification + execution overrides.

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
  const scores = { scalp: scalpScore, day_trade: dayScore, swing: swingScore };
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

// ─── Active Trade Management Engine ────────────────────────────────────
// Runs at the start of each scan cycle BEFORE scanning for new trades.
// Re-evaluates open positions, promotes setups, adjusts SL/TP, and flags
// early exits when the setup invalidates.

export interface ManagementAction {
  positionId: string;
  symbol: string;
  action: "promoted" | "sl_tightened" | "tp_extended" | "early_exit" | "trailing_enabled" | "partial_enabled" | "no_change";
  from?: string;
  to?: string;
  reason: string;
  newSL?: number;
  newTP?: number;
}

export const PROMOTION_MAP: Record<string, string> = {
  scalp: "day_trade",
  day_trade: "swing",
};

// Minimum profit in R-multiples before promotion is considered
export const PROMOTION_THRESHOLDS: Record<string, number> = {
  scalp: 0.8,      // scalp must be at least 0.8R in profit to promote to day
  day_trade: 1.2,  // day trade must be at least 1.2R in profit to promote to swing
};

export async function manageOpenPositions(
  supabase: any,
  positions: any[],
  config: any,
  isAutoStyle: boolean,
  scanCycleId: string,
  // Injected dependencies to avoid circular imports:
  fetchCandlesFn: (symbol: string, interval: string, range: string) => Promise<Candle[]>,
  detectSessionFn: (config?: any) => { name: string; isKillZone: boolean },
): Promise<ManagementAction[]> {
  const actions: ManagementAction[] = [];
  if (!positions || positions.length === 0) return actions;

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

      // Parse existing signal_reason to get exitFlags and setupType
      let signalData: any = {};
      try { signalData = JSON.parse(pos.signal_reason || "{}"); } catch {}
      const exitFlags = signalData.exitFlags || {};
      const currentSetupType: string = signalData.setupType || "day_trade";

      // Calculate current R-multiple (how many risk units in profit)
      const riskPips = Math.abs(entryPrice - sl) / spec.pipSize;
      const profitPips = pos.direction === "long"
        ? (currentPrice - entryPrice) / spec.pipSize
        : (entryPrice - currentPrice) / spec.pipSize;
      const rMultiple = riskPips > 0 ? profitPips / riskPips : 0;

      // ── 1. SETUP PROMOTION (only in Auto style mode) ──
      // If the trade is in profit beyond the promotion threshold,
      // check if higher-timeframe structure confirms the move.
      const nextType = PROMOTION_MAP[currentSetupType];
      const promoThreshold = PROMOTION_THRESHOLDS[currentSetupType];

      if (isAutoStyle && nextType && promoThreshold && rMultiple >= promoThreshold) {
        // Fetch fresh candles to check if structure confirms
        let structureConfirms = false;
        let promoReason = "";
        try {
          // Use 1H candles for scalp→day promotion, daily for day→swing
          const tf = currentSetupType === "scalp" ? "1h" : "1d";
          const range = currentSetupType === "scalp" ? "5d" : "1mo";
          const freshCandles = await fetchCandlesFn(symbol, tf, range).catch(() => [] as Candle[]);

          if (freshCandles.length >= 20) {
            const structure = analyzeMarketStructure(freshCandles);

            // Check if structure trend matches trade direction
            const trendMatchesDirection =
              (pos.direction === "long" && structure.trend === "bullish") ||
              (pos.direction === "short" && structure.trend === "bearish");

            // Check for BOS in trade direction (strong confirmation)
            const recentBOS = structure.bos.filter((b: any) =>
              b.type === (pos.direction === "long" ? "bullish" : "bearish")
            );
            const hasFreshBOS = recentBOS.length > 0;

            // Check if there's a clear next liquidity target further out
            const swingPoints = structure.swingPoints || [];
            const relevantSwings = pos.direction === "long"
              ? swingPoints.filter((s: SwingPoint) => s.type === "high" && s.price > currentPrice)
              : swingPoints.filter((s: SwingPoint) => s.type === "low" && s.price < currentPrice);
            const hasNextTarget = relevantSwings.length > 0;

            if (trendMatchesDirection && hasFreshBOS && hasNextTarget) {
              structureConfirms = true;
              const nextTarget = pos.direction === "long"
                ? Math.min(...relevantSwings.map((s: SwingPoint) => s.price))
                : Math.max(...relevantSwings.map((s: SwingPoint) => s.price));
              promoReason = `HTF ${tf} trend=${structure.trend}, fresh BOS confirmed, next target at ${nextTarget.toFixed(spec.pipSize < 0.01 ? 2 : 5)}`;
            }
          }
        } catch (e: any) {
          console.warn(`[mgmt ${scanCycleId}] Structure check failed for ${symbol}: ${e?.message}`);
        }

        if (structureConfirms) {
          // PROMOTE: update exitFlags with new execution profile
          const newProfile = nextType === "day_trade"
            ? { tpRatio: 2.0, slBufferPips: 2, maxHoldHours: 8, trailingStop: true, trailingStopPips: 15, trailingStopActivation: "after_1r", partialTP: true, partialTPPercent: 50, partialTPLevel: 1.0 }
            : { tpRatio: 3.0, slBufferPips: 5, maxHoldHours: 72, trailingStop: true, trailingStopPips: 25, trailingStopActivation: "after_1r", partialTP: true, partialTPPercent: 40, partialTPLevel: 1.5 };

          // Calculate new TP based on promoted profile
          const slDistance = Math.abs(entryPrice - sl);
          const newTP = pos.direction === "long"
            ? entryPrice + (slDistance * newProfile.tpRatio)
            : entryPrice - (slDistance * newProfile.tpRatio);

          // Trail SL to lock in profit (move to at least breakeven + small buffer)
          const lockBuffer = spec.pipSize * 2; // lock 2 pips profit minimum
          const newSL = pos.direction === "long"
            ? Math.max(sl, entryPrice + lockBuffer)
            : Math.min(sl, entryPrice - lockBuffer);

          // Update the position's exitFlags and SL/TP
          const updatedExitFlags = {
            ...exitFlags,
            ...newProfile,
            breakEven: true,
            breakEvenPips: 0, // already at or past BE
          };
          const updatedSignalData = {
            ...signalData,
            setupType: nextType,
            exitFlags: updatedExitFlags,
            promotionHistory: [
              ...(signalData.promotionHistory || []),
              { from: currentSetupType, to: nextType, at: new Date().toISOString(), rMultiple: rMultiple.toFixed(2), reason: promoReason },
            ],
          };

          await supabase.from("paper_positions").update({
            signal_reason: JSON.stringify(updatedSignalData),
            stop_loss: newSL.toString(),
            take_profit: newTP.toString(),
          }).eq("id", pos.id);

          actions.push({
            positionId: pos.position_id,
            symbol,
            action: "promoted",
            from: currentSetupType,
            to: nextType,
            reason: promoReason,
            newSL,
            newTP,
          });
          console.log(`[mgmt ${scanCycleId}] PROMOTED ${symbol} ${currentSetupType}→${nextType} at ${rMultiple.toFixed(2)}R | SL→${newSL.toFixed(5)} TP→${newTP.toFixed(5)} | ${promoReason}`);
          continue; // Skip other checks for this position — promotion takes priority
        }
      }

      // ── 2. AUTO-ENABLE SMART EXITS based on setup type ──
      // If the position was opened without trailing/partial (old config or disabled),
      // enable them based on the setup classification.
      let exitFlagsUpdated = false;
      const updatedFlags = { ...exitFlags };

      if (currentSetupType === "scalp" && !exitFlags.trailingStop && rMultiple >= 0.5) {
        // Scalps: enable tight trailing after 0.5R to protect quick profits
        updatedFlags.trailingStop = true;
        updatedFlags.trailingStopPips = Math.max(5, Math.round(riskPips * 0.4)); // 40% of risk as trail
        updatedFlags.trailingStopActivation = "after_1r";
        exitFlagsUpdated = true;
        actions.push({ positionId: pos.position_id, symbol, action: "trailing_enabled", reason: `Scalp at ${rMultiple.toFixed(2)}R — tight trailing enabled (${updatedFlags.trailingStopPips} pips)` });
      } else if (currentSetupType === "day_trade" && !exitFlags.partialTP && rMultiple >= 0.8) {
        // Day trades: enable partial TP after 0.8R
        updatedFlags.partialTP = true;
        updatedFlags.partialTPPercent = 50;
        updatedFlags.partialTPLevel = 1.0;
        exitFlagsUpdated = true;
        actions.push({ positionId: pos.position_id, symbol, action: "partial_enabled", reason: `Day trade at ${rMultiple.toFixed(2)}R — partial TP enabled (50% at 1R)` });
      } else if (currentSetupType === "swing" && !exitFlags.trailingStop && rMultiple >= 1.0) {
        // Swings: enable wide trailing after 1R
        updatedFlags.trailingStop = true;
        updatedFlags.trailingStopPips = Math.max(15, Math.round(riskPips * 0.5)); // 50% of risk as trail
        updatedFlags.trailingStopActivation = "after_1r";
        updatedFlags.partialTP = true;
        updatedFlags.partialTPPercent = 40;
        updatedFlags.partialTPLevel = 1.5;
        exitFlagsUpdated = true;
        actions.push({ positionId: pos.position_id, symbol, action: "trailing_enabled", reason: `Swing at ${rMultiple.toFixed(2)}R — trailing + partial enabled` });
      }

      // ── 3. EARLY EXIT / SL TIGHTENING on invalidation ──
      // If the trade is losing and structure breaks against it, tighten SL
      if (rMultiple < 0 && rMultiple > -0.8) {
        // Trade is underwater but not yet at SL — check if structure invalidated
        try {
          const checkCandles = await fetchCandlesFn(symbol, "15m", "2d").catch(() => [] as Candle[]);
          if (checkCandles.length >= 20) {
            const currentStructure = analyzeMarketStructure(checkCandles);

            // If structure has broken against the trade direction, tighten SL
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
              const newSL = pos.direction === "long"
                ? currentPrice - tightenedDistance
                : currentPrice + tightenedDistance;

              // Only tighten (never widen)
              const shouldTighten = pos.direction === "long" ? newSL > sl : newSL < sl;
              if (shouldTighten) {
                const updatedSignalForSL = {
                  ...signalData,
                  exitFlags: updatedFlags,
                  invalidationHistory: [
                    ...(signalData.invalidationHistory || []),
                    { at: new Date().toISOString(), rMultiple: rMultiple.toFixed(2), reason: "CHoCH against trade direction" },
                  ],
                };
                await supabase.from("paper_positions").update({
                  stop_loss: newSL.toString(),
                  signal_reason: JSON.stringify(updatedSignalForSL),
                }).eq("id", pos.id);

                actions.push({
                  positionId: pos.position_id,
                  symbol,
                  action: "sl_tightened",
                  reason: `Structure CHoCH against ${pos.direction} — SL tightened from ${sl.toFixed(5)} to ${newSL.toFixed(5)}`,
                  newSL,
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

      // ── 4. SESSION-BASED MANAGEMENT for scalps ──
      // If a scalp is still open and its session has ended, tighten to breakeven or close
      if (currentSetupType === "scalp" && rMultiple > 0) {
        const currentSession = detectSessionFn(config);
        const sessionNameMap: Record<string, string> = { "Asian": "asian", "London": "london", "New York": "newyork", "Sydney": "sydney", "Off-Hours": "off-hours" };
        const normalizedCurrentSession = sessionNameMap[currentSession.name] || currentSession.name.toLowerCase();

        // If we're now in off-hours or a different session, the scalp's window has passed
        if (normalizedCurrentSession === "off-hours") {
          // Move SL to breakeven if in profit
          if (rMultiple > 0.3) {
            const beSL = pos.direction === "long"
              ? entryPrice + (spec.pipSize * 1) // 1 pip above entry
              : entryPrice - (spec.pipSize * 1);
            const shouldMove = pos.direction === "long" ? beSL > sl : beSL < sl;
            if (shouldMove) {
              const updatedSignalForSession = {
                ...signalData,
                exitFlags: { ...updatedFlags, maxHoldHours: 1 }, // Give it 1 more hour max
              };
              await supabase.from("paper_positions").update({
                stop_loss: beSL.toString(),
                signal_reason: JSON.stringify(updatedSignalForSession),
              }).eq("id", pos.id);

              actions.push({
                positionId: pos.position_id,
                symbol,
                action: "sl_tightened",
                reason: `Scalp session ended (now ${normalizedCurrentSession}) — SL moved to breakeven`,
                newSL: beSL,
              });
              console.log(`[mgmt ${scanCycleId}] SCALP SESSION END ${symbol} | SL→BE at ${beSL.toFixed(5)}`);
              continue;
            }
          }
        }
      }

      // Write any exitFlags updates that were accumulated
      if (exitFlagsUpdated) {
        const updatedSignalData = { ...signalData, exitFlags: updatedFlags };
        await supabase.from("paper_positions").update({
          signal_reason: JSON.stringify(updatedSignalData),
        }).eq("id", pos.id);
      }

      if (actions.filter(a => a.positionId === pos.position_id).length === 0) {
        actions.push({ positionId: pos.position_id, symbol, action: "no_change", reason: `${currentSetupType} at ${rMultiple.toFixed(2)}R — no management action needed` });
      }

    } catch (e: any) {
      console.warn(`[mgmt ${scanCycleId}] Error managing ${pos.symbol}: ${e?.message}`);
    }
  }

  return actions;
}
