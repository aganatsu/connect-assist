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

import { SPECS } from "./smcAnalysis.ts";
import {
  computeManagementDecision,
  type DecisionAction,
} from "./computeManagementDecision.ts";
import {
  resolvePositionManagementPolicy,
} from "./managementPolicy.ts";
import {
  buildStructureInvalidationEvidence,
  computePartialCloseDecision,
  type StructureInvalidationEvidence,
} from "./exitParity.ts";

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
         | "trailing_enabled" | "partial_enabled" | "partial_tp_executed" | "be_enabled" | "no_action";
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
  action: "sl_tightened" | "tp_extended" | "early_exit" | "trailing_enabled" | "partial_enabled" | "partial_tp_executed" | "be_enabled" | "no_change";
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

  for (const pos of positions) {
    try {
      const symbol: string = pos.symbol;
      const spec = SPECS[symbol];
      if (!spec) continue;

      const paperEntryPrice = parseFloat(pos.entry_price);
      const currentPrice = parseFloat(pos.current_price);
      const sl = pos.stop_loss ? parseFloat(pos.stop_loss) : null;
      const tp = pos.take_profit ? parseFloat(pos.take_profit) : null;
      if (!sl || !tp) continue;

      // Parse existing signal_reason
      let signalData: any = {};
      try { signalData = JSON.parse(pos.signal_reason || "{}"); } catch {};
      const exitFlags = signalData.exitFlags || {};

      // Use broker fill price for BE/trailing/R calculations when available (live mode).
      // Falls back to paper entry price for paper-only trades or legacy positions.
      const entryPrice = (signalData.brokerEntryPrice != null && !isNaN(parseFloat(signalData.brokerEntryPrice)))
        ? parseFloat(signalData.brokerEntryPrice)
        : paperEntryPrice;

      // Resolve the immutable entry-time management policy. New positions use
      // the frozen setup/style snapshot; legacy positions use their saved
      // exitFlags intent before today's runtime config. Explicit per-trade
      // overrides remain the only way to alter an already-open position.
      const managementPolicy = resolvePositionManagementPolicy(pos, config);
      const managementConfig = managementPolicy.decision;
      const posPartialTPEnabled = managementConfig.partialTPEnabled;
      const posPartialTPPercent = managementPolicy.partialTPPercent;
      const posPartialTPLevel = managementPolicy.partialTPLevel;

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

      // ── Shared live/backtest management authority ──
      // The pure calculator is also used by backtest-engine. Live supplies the
      // current tick as both currentPrice and bestPrice; backtest supplies the
      // candle close plus its favorable high/low.
      let adaptiveTrailCandles:
        | Array<{ open: number; high: number; low: number; close: number }>
        | null = null;
      if (
        managementConfig.adaptiveTrailingEnabled &&
        exitFlags.trailingStopActivated === true &&
        rMultiple > 0
      ) {
        try {
          adaptiveTrailCandles = await fetchCandlesFn(
            symbol,
            signalData.entryTimeframe || "15min",
            "2d",
          ).then((candles) =>
            candles.slice(-10).map((candle) => ({
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
            }))
          ).catch(() => []);
        } catch {
          adaptiveTrailCandles = [];
        }
      }
      const managementSession = detectSessionFn(config);
      const normalizedManagementSession = managementSession.filterKey ||
        managementSession.name.toLowerCase().replace(/[\s-]/g, "");
      let structureEvidence: StructureInvalidationEvidence | null = null;
      if (
        managementConfig.structureInvalidationEnabled &&
        exitFlags.structureInvalidationFired !== true &&
        rMultiple < 0 &&
        rMultiple > -0.8
      ) {
        try {
          const invalidationTimeframe = signalData.entryTimeframe ||
            signalData.frozenStrategyContext?.stylePolicy?.timeframes?.runtimeEntry ||
            signalData.decisionContext?.stylePolicy?.timeframes?.runtimeEntry ||
            "15m";
          const [structureCandles, regimeCandles] = await Promise.all([
            fetchCandlesFn(symbol, invalidationTimeframe, "2d")
              .catch(() => [] as Candle[]),
            fetchCandlesFn(symbol, "1d", "1y")
              .catch(() => [] as Candle[]),
          ]);
          structureEvidence = buildStructureInvalidationEvidence({
            direction: pos.direction as "long" | "short",
            structureCandles,
            regimeCandles,
            evaluatedAt: Date.now(),
          });
          if (structureEvidence.regimeSuppressed) {
            console.log(
              `[mgmt ${scanCycleId}] Structure invalidation SUPPRESSED ${symbol} | ${structureEvidence.reason}`,
            );
          }
        } catch (error) {
          console.warn(
            `[mgmt ${scanCycleId}] Invalidation evidence failed for ${symbol}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      const sharedDecision = computeManagementDecision(
        {
          symbol,
          direction: pos.direction as "long" | "short",
          entryPrice,
          currentPrice,
          bestPrice: currentPrice,
          currentSL: sl,
          originalSL: originalSl,
          takeProfit: tp,
          holdHours,
          exitFlags,
          structureCheck: structureEvidence?.structureCheck || null,
          adaptiveTrailCandles,
          atrValue: signalData.atrValue ?? 0,
          regimeInfo: signalData.regimeInfo ?? null,
          currentSession: normalizedManagementSession,
        },
        managementConfig,
      );
      if (sharedDecision.action !== "no_change") {
        const actionMap: Record<
          Exclude<DecisionAction, "no_change" | "structure_invalidated">,
          {
            action: ManagementAction["action"];
            trigger: ExitAttribution["trigger"];
          }
        > = {
          be_activated: { action: "be_enabled", trigger: "be_enabled" },
          trailing_activated: {
            action: "trailing_enabled",
            trigger: "trailing_enabled",
          },
          trailing_tightened: {
            action: "sl_tightened",
            trigger: "trailing_stop",
          },
          max_hold_be: {
            action: "sl_tightened",
            trigger: "max_hold_exceeded",
          },
          session_close_be: {
            action: "sl_tightened",
            trigger: "session_close",
          },
        };
        const mapped = sharedDecision.action === "structure_invalidated"
          ? {
            action: "sl_tightened" as const,
            trigger: "structure_invalidated" as const,
          }
          : actionMap[sharedDecision.action];
        const attribution = makeAttribution(
          mapped.trigger,
          sharedDecision.detail,
          {
            session: normalizedManagementSession,
            trend: structureEvidence?.trend,
            chochCount: structureEvidence?.chochAgainstCount,
          },
        );
        const updatedSignal = {
          ...signalData,
          exitFlags: sharedDecision.updatedExitFlags,
          managementPolicy: {
            contractVersion: managementPolicy.contractVersion,
            source: managementPolicy.source,
            stylePolicyVersion: managementPolicy.stylePolicyVersion,
            stylePolicyHash: managementPolicy.stylePolicyHash,
            basePolicyHash: managementPolicy.basePolicyHash,
            tradingStyle: managementPolicy.tradingStyle,
          },
          exitAttribution: [
            ...(signalData.exitAttribution || []),
            attribution,
          ],
          ...(sharedDecision.action === "structure_invalidated"
            ? {
              invalidationHistory: [
                ...(signalData.invalidationHistory || []),
                {
                  at: new Date().toISOString(),
                  rMultiple: sharedDecision.rMultiple.toFixed(2),
                  reason: structureEvidence?.reason ||
                    "CHoCH against trade direction",
                  evidence: structureEvidence,
                },
              ],
            }
            : {}),
        };
        const update: Record<string, unknown> = {
          signal_reason: JSON.stringify(updatedSignal),
          exit_flags: sharedDecision.updatedExitFlags,
          ...(sharedDecision.action === "be_activated" ? { close_reason: "be" } : {}),
          ...((sharedDecision.action === "trailing_activated" ||
              sharedDecision.action === "trailing_tightened")
            ? { close_reason: "trail" }
            : {}),
        };
        if (sharedDecision.newSL !== null) {
          update.stop_loss = sharedDecision.newSL.toString();
        }
        await supabase.from("paper_positions").update(update).eq("id", pos.id);
        actions.push({
          positionId: pos.position_id,
          symbol,
          action: mapped.action,
          reason: sharedDecision.detail,
          newSL: sharedDecision.newSL ?? undefined,
          attribution,
        });
        console.log(
          `[mgmt ${scanCycleId}] SHARED ${symbol} `
            + `${sharedDecision.action} source=${managementPolicy.source} `
            + `policy=${managementPolicy.stylePolicyHash?.slice(0, 12) || "legacy"}`,
        );
        continue;
      }

      // ── Shared partial-close authority ──
      // Live uses the observed market price as both the favorable observation
      // and fill price. The adapter below owns only durable database writes.
      const partialDecision = computePartialCloseDecision({
        symbol,
        direction: pos.direction as "long" | "short",
        entryPrice,
        originalSL: originalSl,
        currentPrice,
        favorablePrice: currentPrice,
        positionSize: parseFloat(pos.size),
        enabled: posPartialTPEnabled,
        alreadyActivated:
          exitFlags.partialTPActivated === true ||
          pos.partial_tp_fired === true,
        partialTPPercent: posPartialTPPercent,
        partialTPLevel: posPartialTPLevel,
        executionPriceMode: "observed_market",
      });
      if (partialDecision.triggered) {
        const partialExecutionPrice =
          partialDecision.executionPrice ?? currentPrice;
        const attribution = makeAttribution(
          "partial_tp_executed",
          `${partialDecision.reason} for $${partialDecision.netPnl.toFixed(2)}`,
        );
        const partialEvidence = {
          contractVersion: partialDecision.contractVersion,
          triggerPrice: partialDecision.triggerPrice,
          executionPrice: partialDecision.executionPrice,
          closeSize: partialDecision.closeSize,
          remainingSize: partialDecision.remainingSize,
          grossPnl: partialDecision.grossPnl,
          commission: partialDecision.commission,
          spreadCost: partialDecision.spreadCost,
          totalTradingCost: partialDecision.totalTradingCost,
          netPnl: partialDecision.netPnl,
          pnlPips: partialDecision.pnlPips,
          rMultiple: partialDecision.rMultiple,
        };
        const updatedSignalData = {
          ...signalData,
          exitFlags: {
            ...exitFlags,
            partialTPActivated: true,
            partialTPPercent: posPartialTPPercent,
            partialTPLevel: posPartialTPLevel,
          },
          managementPolicy: {
            contractVersion: managementPolicy.contractVersion,
            source: managementPolicy.source,
            stylePolicyVersion: managementPolicy.stylePolicyVersion,
            stylePolicyHash: managementPolicy.stylePolicyHash,
            basePolicyHash: managementPolicy.basePolicyHash,
            tradingStyle: managementPolicy.tradingStyle,
          },
          partialCloseEvidence: [
            ...(signalData.partialCloseEvidence || []),
            { ...partialEvidence, at: new Date().toISOString() },
          ],
          exitAttribution: [
            ...(signalData.exitAttribution || []),
            attribution,
          ],
        };

        await supabase.from("paper_trade_history").insert({
          user_id: pos.user_id,
          position_id: `${pos.position_id}_partial`,
          symbol,
          direction: pos.direction,
          size: partialDecision.closeSize.toString(),
          entry_price: entryPrice.toString(),
          exit_price: partialExecutionPrice.toString(),
          pnl: partialDecision.netPnl.toFixed(2),
          pnl_pips: partialDecision.pnlPips.toFixed(1),
          open_time: pos.open_time,
          closed_at: new Date().toISOString(),
          close_reason: "partial_tp",
          signal_reason: JSON.stringify(updatedSignalData),
          signal_score: pos.signal_score,
          order_id: pos.order_id,
          source_pending_order_id: pos.source_pending_order_id || null,
          stop_loss: pos.stop_loss || null,
          take_profit: pos.take_profit || null,
        });

        await supabase.from("paper_positions").update({
          size: partialDecision.remainingSize.toString(),
          partial_tp_fired: true,
          signal_reason: JSON.stringify(updatedSignalData),
          exit_flags: updatedSignalData.exitFlags,
        }).eq("id", pos.id);

        const posBotId = pos.bot_id || "smc";
        const { data: account } = await supabase.from("paper_accounts")
          .select("balance, peak_balance")
          .eq("user_id", pos.user_id)
          .eq("bot_id", posBotId)
          .maybeSingle();
        if (account) {
          const currentBalance = parseFloat(account.balance || "10000");
          const newBalance = currentBalance + partialDecision.netPnl;
          const newPeak = Math.max(
            parseFloat(account.peak_balance || "10000"),
            newBalance,
          );
          await supabase.from("paper_accounts").update({
            balance: newBalance.toFixed(2),
            peak_balance: newPeak.toFixed(2),
          }).eq("user_id", pos.user_id).eq("bot_id", posBotId);
        }

        actions.push({
          positionId: pos.position_id,
          symbol,
          action: "partial_tp_executed",
          reason: attribution.detail,
          attribution,
        });
        console.log(
          `[mgmt ${scanCycleId}] SHARED PARTIAL ${symbol} | ${partialDecision.rMultiple.toFixed(2)}R | closed ${partialDecision.closeSize} lots ($${partialDecision.netPnl.toFixed(2)}) | remain ${partialDecision.remainingSize}`,
        );
        continue;
      }

      const noActionAttribution = makeAttribution(
        "no_action",
        `At ${rMultiple.toFixed(2)}R, ${holdHours.toFixed(1)}h held — no management action needed`,
      );
      actions.push({
        positionId: pos.position_id,
        symbol,
        action: "no_change",
        reason: noActionAttribution.detail,
        attribution: noActionAttribution,
      });
      continue;

    } catch (e: any) {
      console.warn(`[mgmt ${scanCycleId}] Error managing ${pos.symbol}: ${e?.message}`);
    }
  }

  return actions;
}
