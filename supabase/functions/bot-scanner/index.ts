import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { finalizePaperPositionClose } from "../_shared/finalizePaperPositionClose.ts";
import {
  applyPairOverrides,
} from "../_shared/configMapper.ts";
import {
  buildFrozenRuntimeConfigSnapshot,
  loadEffectiveRuntimeConfig,
} from "../_shared/runtimeConfigStore.ts";
import { buildResolvedStylePolicy } from "../_shared/stylePolicy.ts";
import { resolveZoneStopPolicyMode } from "../_shared/stopPolicyMode.ts";
import {
  observePreArmReachability,
  resolveFrozenNestedPoiMarketRoute,
  resolveNestedPoiMarketActivation,
  shouldCreatePendingZoneOrder,
  shouldSupersedePendingOrder,
} from "../_shared/botConfigBehavior.ts";
import {
  resolveImpulseLifecycleEnforcement,
} from "../_shared/impulseLifecycleEnforcement.ts";
import { evaluateGamePlanGate } from "../_shared/gamePlanGate.ts";
import {
  evaluateFinalTradeAuthorization,
} from "../_shared/finalTradeAuthorization.ts";
import {
  attachDecisionContext,
  buildTradeDecisionContext,
  evaluateDecisionHierarchy,
  TRADE_DECISION_CONTRACT_VERSION,
  type DirectionVerdictDecision,
  type EntryConfirmationDecision,
} from "../_shared/decisionContract.ts";
import {
  directionVerdictMatchesGamePlan,
  loadActiveDirectionVerdicts,
  persistActiveDirectionVerdict,
} from "../_shared/directionVerdictStore.ts";
import {
  buildFinalRuntimeGateStates,
} from "../_shared/finalRuntimeGates.ts";
import {
  averageRoundTripCommission,
  resolveRoundTripCommission,
} from "../_shared/tradingCosts.ts";
import {
  evaluateGamePlanShadowAudit,
  finalizeShadowCurrentDecision,
} from "../_shared/gamePlanShadowAudit.ts";
import {
  buildGoldenReplaySnapshot,
  finalizeGoldenReplaySnapshot,
  type GoldenReplayFinalization,
} from "../_shared/goldenReplay.ts";
import {
  buildGoldenReplayRuntimeInputFingerprint,
} from "../_shared/goldenReplayReport.ts";
import {
  buildStreamlinedTradeDecisionObservation,
} from "../_shared/streamlinedTradeDecisionObservation.ts";
import { lifecycleProjection } from "../_shared/streamlinedDecisionLifecycle.ts";
import {
  evaluateSingleOwnershipDecision,
  operationalSafetyChecks,
} from "../_shared/singleOwnershipDecision.ts";
import { evaluateSingleOwnershipEnforcement } from "../_shared/singleOwnershipEnforcement.ts";
import { projectCanonicalScannerState } from "../_shared/canonicalScannerState.ts";
import { evaluateCanonicalScannerEnforcement } from "../_shared/canonicalScannerEnforcement.ts";
import { buildTradeDecisionPresentation } from "../_shared/tradeDecisionPresentation.ts";
import { buildCanonicalStructureAuthority } from "../_shared/canonicalStructureAuthority.ts";
import { buildCanonicalLiquiditySequences } from "../_shared/canonicalLiquiditySequence.ts";
import { buildLiquidityConfirmationId, observeLiquidityConfirmation } from "../_shared/liquidityConfirmationContract.ts";
import { evaluateCanonicalStructureDecision, evaluateCanonicalStructureEnforcement } from "../_shared/canonicalStructureDecision.ts";
import { resolveDirectionAvailability } from "../_shared/directionAvailabilityPolicy.ts";
import { resolveSingleOwnershipScanOutcome } from "../_shared/singleOwnershipScanOutcome.ts";
import { applyAuthorityOwnershipToGateResults, evaluateAuthorityGateDisposition } from "../_shared/authorityGateOwnership.ts";
import { fetchCandlesWithFallback, fetchLivePrice, beginScanSourceTally, endScanSourceTally, resetThrottleStats, type BrokerConn } from "../_shared/candleSource.ts";
import {
  computeFOTSI, getCurrencyAlignment, checkOverboughtOversoldVeto,
  parsePairCurrencies, getFOTSIPairNames,
  type FOTSIResult, type Currency,
} from "../_shared/fotsi.ts";
import { getFOTSIWithCache, setCachedFOTSI } from "../_shared/fotsiCache.ts";
import { batchGetCachedCandles, batchSetCachedCandles } from "../_shared/candleCache.ts";
import {
  classifyRotationOutcome,
  loadRotatingImpulseState,
  measureLifecycleZoneProximity,
  saveRotatingImpulseState,
  selectRotatingImpulseUniverse,
  updateRotatingImpulseState,
  SESSION_AWARE_ROTATION_OBSERVATION_CONTRACT,
  type RotationSelection,
  type SessionRotationObservation,
} from "../_shared/rotatingImpulseUniverse.ts";
import {
  classifyInstrumentRegime,
  // Types
  type Candle, type SwingPoint, type OrderBlock,
  type LiquidityPool, type BreakerBlock, type UnicornSetup,
  type StopPolicyShadowInput,
  type SMTResult, type AMDResult, type SilverBulletResult, type MacroWindowResult,
  type ReasoningFactor, type GateResult,
  // Constants
  SPECS, SUPPORTED_SYMBOLS, SMT_PAIRS, ASSET_PROFILES, getAssetProfile,
  FALLBACK_RATES, MIN_SL_PIPS, ATR_SL_FLOOR_MULTIPLIER,
  // Analysis functions
  calculateATR, calculateAnchoredVWAP,
  detectSwingPoints, analyzeMarketStructure,
  detectSMTDivergence, calculatePremiumDiscount,
  detectOrderBlocks, detectFVGs, detectLiquidityPools,
  detectDisplacement, tagDisplacementQuality,
  detectBreakerBlocks, detectUnicornSetups,
  detectJudasSwing, detectReversalCandle,
  calculatePDLevels,
  computeOpeningRange, calculateSLTP,
  // Position sizing & rate conversion
  calculatePositionSize, calcPnl, getQuoteToUSDRate,
  // Confluence stacking, sweep reclaim, pullback decay
  computeConfluenceStacking, detectSweepReclaim, measurePullbackDecay,
  type ConfluenceStack, type SweepReclaim, type PullbackDecay,
  type FairValueGap,
  // ZigZag pivot detection & Fibonacci levels
  detectZigZagPivots, computeFibLevels,
  type ZigZagPivot, type FibLevel, type FibLevels,
  // Optimal style detection
  detectOptimalStyle,
  // Symbol normalization
  normalizeSymKey,
} from "../_shared/smcAnalysis.ts";
import {
  getCurrentSession,
  type SessionGamePlan, type InstrumentGamePlan,
} from "../_shared/gamePlan.ts";
import {
  gamePlanSymbolsMatchScope,
  resolveGamePlanMarketScope,
} from "../_shared/gamePlanMarketScope.ts";
import {
  evaluateGamePlanReuse,
  loadActiveGamePlan,
} from "../_shared/gamePlanStore.ts";
import {
  classifySetupType, manageOpenPositions,
  type SetupClassification, type ManagementAction,
} from "../_shared/scannerManagement.ts";
import { resolveSymbol } from "../_shared/brokerSymbols.ts";
import { metaFetch, metaBaseUrl, META_REGIONS, regionCache } from "../_shared/metaApiClient.ts";
import {
  reconcileBrokerState, reconcileFullBrokerClose, reconcilePartialClose,
  type ReconcilePosition, type BrokerConnection,
} from "../_shared/reconcileBrokerState.ts";
import {
  executeBrokerOrderWithLedger,
} from "../_shared/brokerExecutionLedger.ts";
import {
  buildFrozenSetupStrategyContext,
  buildSetupLifecycleEvidence,
  readFrozenCrossTimeframeAuthority,
  readFrozenSetupStrategyContext,
  resolvePendingConfirmationMethod,
  resolvePendingDealingRangeMode,
  resolvePendingIndicatorMinimum,
  resolvePendingNestedPoiEntryPlanState,
  resolvePendingStylePolicy,
  THESIS_VALIDATION_VERSION,
  transitionStagedSetup,
  validateFrozenSetupIdentity,
  type FrozenNestedPoiEntryPlan,
  type SetupLifecycleEvidence,
  resolveLifecycleCandidateId,
} from "../_shared/setupLifecycle.ts";
import {
  deriveWatchlistInvalidation,
  isWatchlistInvalidated,
  type WatchlistDirection, invalidationForLifecycle, invalidationBreached, freezeStructuralInvalidation } from "../_shared/watchlistInvalidation.ts";
import {
  closedCandleTouchesNestedPoiOuterZone,
  cursorAfterLatestTouchCandle,
  findEarliestPendingZoneTouch,
} from "../_shared/pendingZoneTouch.ts";
import {
  buildPendingOrderPlan,
  buildPreArmedPositionPlan,
  resolvePreArmedPositionStop,
  type PendingEntryZone,
} from "../_shared/pendingOrderPlan.ts";
import {
  buildWatchlistLifecycleEvidence,
  deriveWatchlistLifecyclePhase,
} from "../_shared/watchlistLifecycleEvidence.ts";
import {
  persistStopPolicyEvidence,
  type StopPolicyPlanObservation,
} from "../_shared/stopPolicyEvidence.ts";
import {
  buildFrozenCrossTimeframeContext,
  loadCurrentEvidenceCertificateReferences,
  validateImpulseLifecycleExecutableZone,
  type EvidenceCertificateReference,
} from "../_shared/frozenCrossTimeframeContext.ts";
import {
  beginScannerOperation,
  claimScannerLock,
  completeScannerOperation,
  failScannerOperation,
  heartbeatScannerLock,
  markScannerOperation,
  publishCandleSourceAlerts,
  recordScannerAuthorizationFailure,
  releaseScannerLock,
  resolveScannerAlert,
  skipScannerOperation,
  upsertScannerAlert,
  type ScannerTriggerSource,
} from "../_shared/scannerRuntime.ts";
import {
  classifyUnifiedWatch,
  isPreZoneObservation,
  requiresFreshCandidateHandoff,
} from "../_shared/preZoneObservation.ts";
import {
  checkNewsAlignment,
} from "../_shared/newsImpact.ts";
import {
  runConfluenceAnalysis,
  DEFAULT_FACTOR_WEIGHTS,
  resolveWeightScale,
  applyWeightScale,
} from "../_shared/confluenceScoring.ts";
import {
  runPropFirmGate, propFirmEmergencyClose,
  type PropFirmGateResult,
} from "../_shared/propFirmGate.ts";
import {
  buildNestedPoiEntryPlan,
  type HTFConfluenceData,
  type TFSlotLabels,
} from "../_shared/impulseZoneEngine.ts";
import { findUnifiedZone, type UnifiedZoneResult } from "../_shared/unifiedZoneEngine.ts";
import { evaluateStandaloneSweepGate } from "../_shared/standaloneSweepGate.ts";
import { persistZoneShadowObservations } from "../_shared/zoneShadowObservationStore.ts";
import { persistICTEntryZoneObservation } from "../_shared/ictEntryZoneObservationStore.ts";
import { evaluateBreakerFillLifecycle } from "../_shared/breakerSemantics.ts";
import { normalizeBreakerCandidate } from "../_shared/breakerCandidateAuthority.ts";
import { resolveManualImpulse, type ManualImpulseSpec } from "../_shared/manualImpulse.ts";
import { evaluateExit, priceAsBar } from "../_shared/exitEvaluation.ts";
import {
  annotateEvidenceLifecycle,
  buildScanEvidenceRow,
  persistZoneTimeframeEvidence,
  type EvidenceRow,
} from "../_shared/zoneTimeframeEvidence.ts";
import {
  compareDealingRangeDecisions,
  evaluateCanonicalDealingRange,
  normalizeDealingRangeMode,
  resolveCanonicalDealingRange,
} from "../_shared/canonicalDealingRange.ts";
import { loadZoneLocalActivation } from "../_shared/zoneLocalActivationStore.ts";
import {
  evaluateZoneLocalEnforcement,
} from "../_shared/zoneLocalEnforcement.ts";
import {
  loadCrossTimeframeActivation,
} from "../_shared/crossTimeframeActivationStore.ts";
import {
  resolveCrossTimeframeAuthority,
} from "../_shared/crossTimeframeAuthority.ts";
import {
  evaluateCrossTimeframeEntryAuthority,
} from "../_shared/crossTimeframeEntryAuthority.ts";
import {
  evaluateCrossTimeframeShadowCandidate,
} from "../_shared/crossTimeframeShadowValidation.ts";
import { findCascadeZone, type CascadeResult } from "../_shared/cascadeZoneEngine.ts";
import { detectZoneConfirmation, isPriceInZone, isImpulseBroken, formatConfirmationSummary, DEFAULT_ZONE_CONFIRMATION_CONFIG, type ConfirmationSignal } from "../_shared/zoneConfirmation.ts";
import { buildRoutedConfirmationObservation } from "../_shared/confirmationAuthority.ts";
import { type DirectionResult } from "../_shared/directionEngine.ts";
import {
  bindTimeframeCandles,
  buildTimeframeCandleMap,
  resolveTimeframeAuthority,
  timeframeFetchRange,
  zoneTimeframeLabels,
} from "../_shared/timeframeAuthority.ts";
import {
  buildStyleDecisionEvidence,
  type StyleDecisionEvidence,
} from "../_shared/styleDecisionEvidence.ts";
import { computeDirectionVerdict, type DirectionVerdictResult } from "../_shared/directionVerdict.ts";
import {
  confirmationEvidenceLines,
  confirmationMethodLabel,
  crossTimeframeAuthorityLine,
  diagnosticScoreLine,
  directionVerdictLines,
  durationLabel,
  parseSignalReason,
  rMultiple,
  styleLadderLines,
  tgLine,
  tradeAuthorityLines,
  watchlistOriginLines,
  zoneEvidenceLines,
} from "../_shared/telegramDetail.ts";
import {
  buildDirectionVerdictThesisOptions,
  validatePendingOrderThesis,
  type ThesisValidationResult,
} from "../_shared/thesisValidator.ts";
import { logRejectedSetup, normalizeRejectedGate, shouldLogBelowThreshold, type RejectedSetupParams } from "../_shared/rejectedSetupLogger.ts";
import { runICTHTFAnalysis, type ICTHTFResult, type ICTHTFConfig, DEFAULT_ICT_HTF_CONFIG } from "../_shared/ictHTFIntegration.ts";
import { validateRecentMSS, type MSSValidationResult, type DisplacementMSSConfig, DEFAULT_DISPLACEMENT_MSS_CONFIG } from "../_shared/ictDisplacementMSS.ts";
import { detectJudasSwing as detectICTJudasSwing, type JudasSwingResult, type JudasSwingConfig, DEFAULT_JUDAS_SWING_CONFIG } from "../_shared/ictJudasSwing.ts";
import { validateFVGBatch, type BatchFVGValidationResult, type FVGInvalidationConfig, DEFAULT_FVG_INVALIDATION_CONFIG } from "../_shared/ictFVGInvalidation.ts";
import { evaluateICTKillZone, type ICTKillZoneResult, type ICTKillZoneConfig, DEFAULT_ICT_KILLZONE_CONFIG } from "../_shared/ictKillZones.ts";
import { updateConviction, buildConvictionKey, saveConvictionState, loadConvictionState, type ConvictionInput, type ThesisConvictionState, type ConvictionResult, type ConvictionConfig, DEFAULT_CONVICTION_CONFIG } from "../_shared/thesisConviction.ts";
import { assessRisk, type ICTRiskAssessment, type ICTRiskConfig, DEFAULT_ICT_RISK_CONFIG } from "../_shared/ictRiskManagement.ts";
import {
  applyFinalCandidateSizeAdjustments,
  computePositionSize,
  calculatePositionRisk,
  normalizeBrokerVolumeDown,
  resolveCorrelationSizeMultiplier,
  resolveSizingVolatilityContext,
  type PropFirmContext,
} from "../_shared/unifiedPositionSizing.ts";
import { isConnectionAvailable, updateHealth, createInitialHealth, type BrokerHealth, type ExecutionResult, DEFAULT_FAILOVER_CONFIG } from "../_shared/multiBrokerFailover.ts";
import { checkPortfolioConflict } from "../_shared/portfolioCorrelation.ts";
import { checkCorrelationExposure } from "../_shared/gateCorrelation.ts";
import { adjustTPForRegime } from "../_shared/exitEngine.ts";
import { checkIndicatorConfirmation } from "../_shared/indicatorConfirmation.ts";
import { createScanCache } from "../_shared/dataCache.ts";
import { checkMaxPositions } from "../_shared/gateMaxPositions.ts";
import { checkMaxPerSymbol } from "../_shared/gateMaxPerSymbol.ts";
import { checkDuplicateDirection } from "../_shared/gateDuplicateDirection.ts";
import { checkMaxDrawdown } from "../_shared/gateMaxDrawdown.ts";
import { checkDailyLossLimit } from "../_shared/gateDailyLossLimit.ts";
import { checkConsecutiveLosses } from "../_shared/gateConsecutiveLosses.ts";
import { checkCooldown } from "../_shared/gateCooldown.ts";
import { checkATRVolatility } from "../_shared/gateATRVolatility.ts";
import { checkTier1Minimum } from "../_shared/gateTier1Minimum.ts";
import { analyzeWeeklyBiasAndDOL } from "../_shared/weeklyBiasDOL.ts";
import { runSMCEnhancements, type SMCEnhancementsResult } from "../_shared/smcEnhancements.ts";
import { verifyCronOrUserCaller } from "../_shared/cronAuth.ts";
import {
  detectSession as sharedDetectSession,
  detectSilverBullet as sharedDetectSilverBullet,
  detectMacroWindow as sharedDetectMacroWindow,
  toNYTime as sharedToNYTime,
  isSessionEnabled,
  type SessionResult,
} from "../_shared/sessions.ts";

import { setCreditCallerContext } from "../_shared/apiCreditBudget.ts";

setCreditCallerContext("bot-scanner");

declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

// ─── Bot Identity ────────────────────────────────────────────────────
const BOT_ID = "smc";

function canonicalEvidenceSnapshot(detail: Record<string, any>) {
  return {
    canonicalScannerState: detail.canonicalScannerState || null,
    canonicalStructureAuthority: detail.canonicalStructureAuthority || null,
    canonicalLiquiditySequence: detail.canonicalLiquiditySequence || null,
    canonicalStructureDecision: detail.canonicalStructureDecision || null,
    canonicalStructureEnforcement: detail.canonicalStructureEnforcement || null,
  };
}
// resolveSymbol is now imported from ../_shared/brokerSymbols.ts (single source of truth)
// metaFetch, metaBaseUrl, META_REGIONS, regionCache are now imported from ../_shared/metaApiClient.ts

// ─── Unified Broker Spread Check ────────────────────────────────────
// Single function for both OANDA and MetaApi spread checks.
// Returns { bid, ask, spreadPips, passed, effectiveMax } or null on error.
interface SpreadCheckResult {
  bid: number;
  ask: number;
  spreadPips: number;
  passed: boolean;
  effectiveMax: number;
  halfSpreadPrice: number;
}
async function fetchBrokerSpread(
  conn: any,
  pair: string,
  config: { spreadFilterEnabled: boolean; maxSpreadPips: number },
  metaAccountId?: string,
  authToken?: string,
): Promise<SpreadCheckResult | null> {
  const pairSpec = SPECS[pair] || SPECS["EUR/USD"];
  const effectiveMax = config.maxSpreadPips > 0 ? config.maxSpreadPips : pairSpec.maxSpread;
  try {
    let bid = 0, ask = 0;
    if (conn.broker_type === "oanda") {
      const oandaBase = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
      const oandaSym = resolveSymbol(pair, conn).replace(/([A-Z]{3})([A-Z]{3})/, "$1_$2");
      const priceRes = await fetch(
        `${oandaBase}/v3/accounts/${conn.account_id}/pricing?instruments=${encodeURIComponent(oandaSym)}`,
        { headers: { Authorization: `Bearer ${conn.api_key}` } },
      );
      if (!priceRes.ok) {
        console.warn(`OANDA pricing fetch failed [${conn.display_name}]: ${priceRes.status}`);
        return null;
      }
      const priceData: any = await priceRes.json();
      const pricing = priceData.prices?.[0];
      if (!pricing) return null;
      bid = parseFloat(pricing.bids?.[0]?.price ?? "0");
      ask = parseFloat(pricing.asks?.[0]?.price ?? "0");
    } else if (conn.broker_type === "metaapi" && metaAccountId && authToken) {
      const brokerSymbol = resolveSymbol(pair, conn);
      const { res: priceRes, body: priceBody } = await metaFetch(
        metaAccountId, authToken,
        (base) => `${base}/symbols/${encodeURIComponent(brokerSymbol)}/current-price`,
      );
      if (!priceRes.ok) {
        console.warn(`MetaApi price fetch [${conn.display_name}] ${brokerSymbol}: HTTP ${priceRes.status}`);
        return null;
      }
      const priceData: any = JSON.parse(priceBody);
      bid = priceData.bid ?? 0;
      ask = priceData.ask ?? 0;
    } else {
      return null;
    }
    if (bid <= 0 || ask <= 0) return null;
    const spreadPips = (ask - bid) / pairSpec.pipSize;
    const halfSpreadPrice = (spreadPips * pairSpec.pipSize) / 2;
    const passed = !config.spreadFilterEnabled || spreadPips <= effectiveMax;
    const source = config.maxSpreadPips > 0 ? "user" : "per-instrument";
    console.log(`Spread check [${conn.display_name}] ${pair}: bid=${bid} ask=${ask} spread=${spreadPips.toFixed(2)}p (max=${effectiveMax} [${source}]) → ${passed ? "OK" : "BLOCKED"}`);
    return { bid, ask, spreadPips, passed, effectiveMax, halfSpreadPrice };
  } catch (err: any) {
    console.warn(`Spread check error [${conn.display_name}] ${pair}: ${err?.message}`);
    return null;
  }
}

// Adjust SL/TP for broker spread. Returns adjusted { sl, tp }.
function adjustSLTPForSpread(
  sl: number, tp: number, direction: string, halfSpreadPrice: number,
): { brokerSL: number; brokerTP: number } {
  if (direction === "long") {
    return { brokerSL: sl - halfSpreadPrice, brokerTP: tp + halfSpreadPrice };
  } else {
    return { brokerSL: sl + halfSpreadPrice, brokerTP: tp - halfSpreadPrice };
  }
}

// Format a price for display using the instrument's pip size (avoids
// noisy floats like 217.90583499999997 in Telegram messages).
function fmtPx(v: number | string | null | undefined, sym: string): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!isFinite(n)) return String(v);
  const ps = SPECS[sym]?.pipSize ?? 0.0001;
  const decimals = Math.max(2, Math.round(-Math.log10(ps)) + 1);
  return n.toFixed(decimals);
}

function buildConfiguredPreArmedPlan(input: {
  direction: "long" | "short";
  zone: PendingEntryZone;
  structuralInvalidation: number;
  preferredPositionStop?: number | null;
  symbol: string;
  atrValue?: number | null;
  config: any;
  analysis: any;
  stopPolicy?: StopPolicyShadowInput;
  lifecycleDecision?: { valid: boolean; reason: string };
}) {
  if (input.lifecycleDecision && !input.lifecycleDecision.valid) {
    return { valid: false as const, reason: input.lifecycleDecision.reason };
  }
  const spec = SPECS[input.symbol] || SPECS["EUR/USD"];
  const stop = resolvePreArmedPositionStop({
    direction: input.direction,
    zone: input.zone,
    structuralInvalidation: input.structuralInvalidation,
    preferredPositionStop: input.preferredPositionStop,
    pipSize: spec.pipSize,
    minimumStopPips: MIN_SL_PIPS[input.symbol] ?? 15,
    atrValue: input.atrValue,
    atrFloorMultiplier: ATR_SL_FLOOR_MULTIPLIER,
  });
  if (!stop.valid) return stop;

  const gamePlanContext = input.config?._gamePlanContext;
  const dolTargets = input.config?.dolTPExtensionEnabled !== false && gamePlanContext?.dol
    ? (Array.isArray(gamePlanContext.dol) ? gamePlanContext.dol : [gamePlanContext.dol])
    : undefined;
  const target = calculateSLTP({
    direction: input.direction,
    lastPrice: input.zone.price,
    pipSize: spec.pipSize,
    config: input.config,
    swings: input.analysis.structure?.swingPoints || [],
    orderBlocks: input.analysis.orderBlocks || [],
    liquidityPools: input.analysis.liquidityPools || [],
    pdLevels: input.analysis.pdLevels || null,
    atrValue: Number(input.atrValue) || 0,
    fvgs: input.analysis.fvgs || [],
    fibExtensions: input.analysis.fibLevels?.extensions,
    dolTargets,
    resolvedStopLoss: stop.stopLoss,
    stopPolicyShadow: input.stopPolicy,
  });
  if (!Number.isFinite(Number(target.takeProfit))) {
    return {
      valid: false as const,
      reason: "No viable take-profit target: " +
        (target.takeProfitFallbackReason || "configured TP method returned no target"),
    };
  }
  if (
    input.stopPolicy &&
    (!target.stopPolicyShadow?.valid || !Number.isFinite(Number(target.stopLoss)))
  ) {
    return {
      valid: false as const,
      reason: `Style-aware stop policy unavailable: ${target.stopPolicyShadow?.reason || "stop_unavailable"}`,
    };
  }

  const selectedStop = input.stopPolicy ? Number(target.stopLoss) : stop.stopLoss;


  const plan = buildPreArmedPositionPlan({
    direction: input.direction,
    zone: input.zone,
    structuralInvalidation: input.structuralInvalidation,
    preferredPositionStop: selectedStop,
    finalPositionStop: input.stopPolicy ? selectedStop : undefined,
    pipSize: spec.pipSize,
    minimumStopPips: input.stopPolicy ? 0 : MIN_SL_PIPS[input.symbol] ?? 15,
    atrValue: input.stopPolicy ? null : input.atrValue,
    atrFloorMultiplier: ATR_SL_FLOOR_MULTIPLIER,
    frozenTakeProfit: Number(target.takeProfit),
  });
  return plan.valid
    ? {
      ...plan,
      takeProfitSource: target.takeProfitSource,
      takeProfitFallbackReason: target.takeProfitFallbackReason,
      stopPolicy: target.stopPolicyShadow,
    }
    : plan;
}

function rejectedPreArmDecision(reason: string, candidateId: string | null | undefined) {
  return {
    outcome: "not_armed",
    reasonCode: reason.startsWith("No viable take-profit target")
      ? "no_viable_take_profit"
      : "invalid_pre_arm_geometry",
    reason,
    candidateId: candidateId ?? null,
  };
}

function getEntryInterval(entryTf: string): string {
  const map: Record<string, string> = {
    "1m": "1m", "5m": "5m", "15m": "15m", "15min": "15m",
    "30m": "30m", "1h": "1h", "4h": "1h", "1d": "1d", "1day": "1d",
  };
  return map[entryTf] || "15m";
}
function getEntryRange(entryTf: string): string {
  const map: Record<string, string> = {
    "1m": "1d", "5m": "5d", "15m": "5d", "15min": "5d",
    "30m": "5d", "1h": "1mo", "4h": "1mo",
  };
  return map[entryTf] || "5d";
}



// ─── Session & Time Helpers (delegated to _shared/sessions.ts) ──────
// All imported from _shared/sessions.ts — SINGLE SOURCE OF TRUTH.
// Local aliases for backward compatibility with existing call sites.
function toNYTime(utc: Date) { return sharedToNYTime(utc); }
function detectSession(_config?: any): SessionResult { return sharedDetectSession(); }

// Local aliases — delegate to _shared/sessions.ts (single source of truth)
function detectSilverBullet(): SilverBulletResult { return sharedDetectSilverBullet(); }
function detectMacroWindow(): MacroWindowResult { return sharedDetectMacroWindow(); }
// ─── Fetch candles via shared multi-source helper ────────────────────
// Tries: MetaAPI (broker feed) → Twelve Data → Polygon.io
// Module-scoped reference set per-scan so the loop below can stay terse.
let _scanBrokerConn: BrokerConn | null = null;
const _scanCandleSources = new Map<string, string>();
async function fetchCandles(symbol: string, interval = "15m", _range = "5d"): Promise<Candle[]> {
  const result = await fetchCandlesWithFallback({
    symbol,
    interval,
    limit: 300,
    brokerConn: _scanBrokerConn,
    skipBroker: true,
  });
  _scanCandleSources.set(`|`, result.source);
  return result.candles;
}

// FALLBACK_RATES, getQuoteToUSDRate, MIN_SL_PIPS, ATR_SL_FLOOR_MULTIPLIER, calculatePositionSize
// are now imported from ../_shared/smcAnalysis.ts (single source of truth)

// ─── Load user config ───────────────────────────────────────────────
async function loadConfig(supabase: any, userId: string, connectionId?: string) {
  return await loadEffectiveRuntimeConfig(supabase, {
    userId,
    connectionId,
  });
}

// ─── Safety Gates ───────────────────────────────────────────────────

async function runSafetyGates(
  supabase: any, userId: string, symbol: string, direction: "long" | "short",
  analysis: any, config: any, account: any, openPositions: any[],
  dailyCandles: Candle[] | null,
  rateMap?: Record<string, number>,
  convictionCandles?: Candle[] | null,
  convictionTimeframeLabel = "entry",
  directionVerdict?: DirectionVerdictResult | null,
  propFirmActive?: boolean,
  /**
   * The score and threshold the eligibility check at the call site used —
   * effectiveScore and conflictAdjustedMinConfluence. Gate 9 must compare the
   * same two numbers, or it re-decides the threshold on stale operands.
   */
  effectiveScore?: number,
  effectiveMinConfluence?: number,
): Promise<GateResult[]> {
  const gates: GateResult[] = [];

  // Gate 1: Direction Verdict (consolidated HTF Bias + Regime + Weekly + GP)
  // When directionVerdict is available, it replaces the legacy HTF bias check, regime gate,
  // falling knife guard, and game plan filter with a single confidence-based decision.
  // Legacy fallback preserved for when verdict computation fails.
  if (directionVerdict) {
    if (directionVerdict.shouldBlock) {
      gates.push({ passed: false, reason: `Direction BLOCKED: ${directionVerdict.blockReason} (conf: ${directionVerdict.confidence}%, agreement: ${(directionVerdict.agreement * 100).toFixed(0)}%)` });
    } else {
      gates.push({ passed: true, reason: `Direction OK: ${directionVerdict.verdict.toUpperCase()} (conf: ${directionVerdict.confidence}%, adj: ${directionVerdict.scoreAdjustment >= 0 ? "+" : ""}${directionVerdict.scoreAdjustment.toFixed(2)}, agreement: ${(directionVerdict.agreement * 100).toFixed(0)}%)` });
    }
  } else if (config.htfBiasRequired && (analysis.cachedDailyStructure || (dailyCandles && dailyCandles.length >= 10))) {
    // Legacy fallback: original Gate 1 logic when verdict unavailable
    const htfStructure = analysis.cachedDailyStructure || analyzeMarketStructure(dailyCandles!);
    const htfTrend = htfStructure.trend;
    const entryBias = direction === "long" ? "bullish" : "bearish";
    const hardVeto = config.htfBiasHardVeto;
    if (hardVeto) {
      if (htfTrend !== entryBias) {
        gates.push({ passed: false, reason: `[legacy] HTF HARD VETO: Daily is ${htfTrend}, ${entryBias} entry blocked` });
      } else {
        gates.push({ passed: true, reason: `[legacy] HTF bias aligned (hard veto): Daily ${htfTrend}` });
      }
    } else {
      if (htfTrend !== "ranging" && htfTrend !== entryBias) {
        gates.push({ passed: false, reason: `[legacy] HTF bias mismatch: Daily is ${htfTrend}, entry is ${entryBias}` });
      } else if (htfTrend === "ranging" && analysis.regimeInfo) {
        const regBias = analysis.regimeInfo.bias;
        const regConf = analysis.regimeInfo.confidence ?? 0;
        const entryOpposesRegime =
          (regBias === "bullish" && direction === "short") ||
          (regBias === "bearish" && direction === "long");
        if (entryOpposesRegime && regConf >= 0.60) {
          gates.push({ passed: false, reason: `[legacy] HTF regime veto: Daily ranging but regime is ${regBias} (${(regConf * 100).toFixed(0)}% conf) — ${direction} entry blocked` });
        } else {
          gates.push({ passed: true, reason: `[legacy] HTF bias aligned: Daily ${htfTrend} (regime: ${regBias} ${(regConf * 100).toFixed(0)}%)` });
        }
      } else {
        gates.push({ passed: true, reason: `[legacy] HTF bias aligned: Daily ${htfTrend}` });
      }
    }
  } else {
    gates.push({ passed: true, reason: "HTF check skipped" });
  }

  // Gate 2: Premium/Discount — the frozen canonical impulse range is the
  // sole location authority. Rolling entry-timeframe swings are diagnostic.
  {
    const canonical = analysis._canonicalDealingRangeEvaluation;
    if (!canonical || canonical.available !== true) {
      gates.push({ passed: true, reason: "P/D check unavailable: no frozen canonical impulse range" });
    } else {
      gates.push({ passed: canonical.allowed, reason: canonical.explanation });
    }
  }

  // Gate 3: Structural Conviction — uses CONVICTION timeframe (one TF above entry) for fractal analysis.
  // Style-aware: scalper → 15m, day_trader → 1H, swing_trader → 4H.
  // This prevents the bot from taking trades where the CONVICTION timeframe shows zero structural support.
  // Previously used entry-TF which was too noisy and over-filtered valid trades on forex.
  if (!config.structuralConvictionEnabled) {
    gates.push({ passed: true, reason: `Structural Conviction: DISABLED by config` });
  } else {
    // Use conviction-TF candles if provided, otherwise fall back to entry-TF analysis
    let s2f: { overallRate: number; bullishRate: number; bearishRate: number } | undefined;
    let convictionTFLabel = convictionTimeframeLabel;
    if (convictionCandles && convictionCandles.length >= 20) {
      const convictionStructure = analyzeMarketStructure(convictionCandles);
      s2f = convictionStructure.structureToFractal;
    } else {
      // Fallback: use entry-TF structure (original behavior)
      s2f = analysis.structure?.structureToFractal;
    }
    const s2fOverall = s2f?.overallRate ?? 1; // default to 1 (pass) if unavailable
    const bullRate = s2f?.bullishRate ?? 0.5; // default to 0.5 (neutral) if unavailable
    const bearRate = s2f?.bearishRate ?? 0.5;
    const directionRate = direction === "long" ? bullRate : bearRate;
    const oppositeRate = direction === "long" ? bearRate : bullRate;
    // Block condition: 0% fractals in entry direction AND S2F < threshold (chaotic) AND opposite has activity.
    // Thresholds are configurable per direction in bot config (Structural Conviction Gate).
    const s2fBlockThreshold = direction === "short" ? config.structuralConvictionS2FShort : config.structuralConvictionS2FLong;
    const oppositeBlockThreshold = direction === "short" ? config.structuralConvictionOppositeShort : config.structuralConvictionOppositeLong;
    if (directionRate === 0 && s2fOverall < s2fBlockThreshold && oppositeRate > 0) {
      gates.push({ passed: false, reason: `Structural Conviction BLOCKED [${convictionTFLabel}]: ${direction === "long" ? "Bull" : "Bear"} fractals 0%, S2F ${(s2fOverall * 100).toFixed(0)}%, opposite ${(oppositeRate * 100).toFixed(0)}% — no structural support for ${direction}` });
    } else if (directionRate === 0 && oppositeRate > oppositeBlockThreshold) {
      // Softer block: 0% in direction + strong opposite (configurable per direction).
      gates.push({ passed: false, reason: `Structural Conviction BLOCKED [${convictionTFLabel}]: ${direction === "long" ? "Bull" : "Bear"} fractals 0% vs opposite ${(oppositeRate * 100).toFixed(0)}% — structure opposes ${direction}` });
    } else if (directionRate > 0 && oppositeRate > 0 && oppositeRate / directionRate >= 2.5) {
      // Bidirectional enhancement: block when opposing fractals are 2.5× or more than supporting.
      gates.push({ passed: false, reason: `Structural Conviction BLOCKED [${convictionTFLabel}]: opposing ${(oppositeRate * 100).toFixed(0)}% is ${(oppositeRate / directionRate).toFixed(1)}× supporting ${(directionRate * 100).toFixed(0)}% — structure overwhelmingly opposes ${direction}` });
    } else {
      gates.push({ passed: true, reason: `Structural Conviction [${convictionTFLabel}]: ${direction === "long" ? "Bull" : "Bear"} ${(directionRate * 100).toFixed(0)}% / ${direction === "long" ? "Bear" : "Bull"} ${(oppositeRate * 100).toFixed(0)}% (S2F ${(s2fOverall * 100).toFixed(0)}%)` });
    }
  }

  // Gate 3b: Reaction Confirmation in Ranging Markets
  // When entry-TF is ranging, require at least one "reaction" factor to be present.
  // Reaction factors prove that price RESPONDED at the level, not just arrived there.
  // Without reaction, the trade is based on position alone (coin flip in ranging markets).
  {
    const entryTrend = analysis.structure?.trend;
    if (entryTrend === "ranging") {
      const factors = analysis.factors || [];
      const reactionFactors = [
        "Displacement",         // Impulsive candle showing institutional aggression
        "Reversal Candle",     // Pin bar / engulfing showing rejection
        "Liquidity Sweep",     // Sweep + rejection = smart money entry
        "AMD Phase",           // Full Accumulation-Manipulation-Distribution sequence
      ];
      const hasReaction = factors.some((f: any) =>
        f.present && reactionFactors.some(rf => f.name?.includes(rf))
      );
      if (!hasReaction) {
        gates.push({ passed: false, reason: `Reaction Confirmation BLOCKED: Ranging market with no reaction factor (need Displacement, Reversal, Sweep, or AMD)` });
      } else {
        const presentReactions = factors
          .filter((f: any) => f.present && reactionFactors.some(rf => f.name?.includes(rf)))
          .map((f: any) => f.name);
        gates.push({ passed: true, reason: `Reaction confirmed in ranging market: ${presentReactions.join(", ")}` });
      }
    } else {
      gates.push({ passed: true, reason: `Reaction gate skipped: trend is ${entryTrend} (not ranging)` });
    }
  }

  // Gate 4: Instrument enabled
  if (!config.instruments.includes(symbol)) {
    gates.push({ passed: false, reason: `${symbol} not in enabled instruments` });
  } else {
    gates.push({ passed: true, reason: `${symbol} enabled` });
  }

  // Gate 4: Max open positions
  gates.push(checkMaxPositions({ openPositionCount: openPositions.length, maxOpenPositions: config.maxOpenPositions }));

  // Gate 5: Same-direction duplicate + max per symbol
  const symbolPositions = openPositions.filter(p => p.symbol === symbol).length;
  const sameDirectionExists = openPositions.some(p => p.symbol === symbol && p.direction === direction);
  const dupResult = checkDuplicateDirection({ sameDirectionExists, allowSameDirectionStacking: config.allowSameDirectionStacking, direction, symbol });
  if (!dupResult.passed) {
    gates.push(dupResult);
  } else {
    const perSymResult = checkMaxPerSymbol({ symbolPositionCount: symbolPositions, maxPerSymbol: config.maxPerSymbol, symbol });
    // Append stacking note to pass reason when stacking is active
    if (perSymResult.passed && sameDirectionExists) {
      gates.push({ passed: true, reason: `${perSymResult.reason} (stacking allowed)` });
    } else {
      gates.push(perSymResult);
    }
  }

  // Gate 6: Portfolio heat (actual risk per position)
  const balance = parseFloat(account.balance || "10000");
  let totalRiskDollars = 0;
  for (const p of openPositions) {
    const pEntry = parseFloat(p.entry_price || "0");
    const pSL = parseFloat(p.stop_loss || "0");
    const pSize = parseFloat(p.size || "0");
    const spec = SPECS[p.symbol] || SPECS["EUR/USD"];
    if (pSL > 0 && pEntry > 0) {
      // Actual risk in USD = |entry - SL| * lotUnits * size * quoteToUSD
      const quoteToUSD = getQuoteToUSDRate(p.symbol, rateMap);
      const riskPerUnit = Math.abs(pEntry - pSL) * spec.lotUnits * pSize * quoteToUSD;
      totalRiskDollars += riskPerUnit;
    } else {
      // Fallback: assume configured risk% if SL is missing
      totalRiskDollars += balance * (config.riskPerTrade / 100);
    }
  }
  const totalRiskPercent = balance > 0 ? (totalRiskDollars / balance) * 100 : 0;
  if (totalRiskPercent >= config.portfolioHeat) {
    gates.push({ passed: false, reason: `Portfolio heat ${totalRiskPercent.toFixed(1)}% >= ${config.portfolioHeat}% limit` });
  } else {
    gates.push({ passed: true, reason: `Portfolio heat ${totalRiskPercent.toFixed(1)}%` });
  }

  // Gate 7: Daily loss limit
  // Consolidation: When prop firm gate is active, it already enforces stricter daily loss
  // thresholds with graduated severity. Skip redundant check.
  if (propFirmActive) {
    gates.push({ passed: true, reason: `Daily loss delegated to prop firm gate (stricter thresholds)` });
  } else {
    const todayStr = new Date().toISOString().slice(0, 10);
    const dailyPnlBase = parseFloat(account.daily_pnl_base || account.balance || "10000");
    const actualBase = account.daily_pnl_base_date === todayStr ? dailyPnlBase : balance;
    const dailyLoss = actualBase - balance;
    const dailyLossPercent = actualBase > 0 ? (dailyLoss / actualBase) * 100 : 0;
    gates.push(checkDailyLossLimit({ dailyLossPercent, maxDailyLoss: config.maxDailyLoss }));
  }

  // Gate 8: Max drawdown
  // Consolidation: When prop firm gate is active, it already enforces stricter drawdown
  // thresholds (trailing or fixed). Skip redundant check.
  if (propFirmActive) {
    gates.push({ passed: true, reason: `Drawdown delegated to prop firm gate (stricter thresholds)` });
  } else {
    const peakBalance = parseFloat(account.peak_balance || account.balance || "10000");
    gates.push(checkMaxDrawdown({ balance, peakBalance, maxDrawdown: config.maxDrawdown }));
  }

  // Gate 9: Min confluence.
  //
  // Must compare the SAME two numbers the eligibility check used —
  // effectiveScore vs conflictAdjustedMinConfluence. It previously tested the
  // raw `analysis.score` against the base `config.minConfluence`, both of which
  // are the wrong operands:
  //
  //   effectiveScore = analysis.score + fotsiPenalty + impulseZonePenaltyVal
  //                  + zoneLocalScoreAdj + crossTimeframeScoreAdj
  //                  + ictTotalAdj + verdictScoreAdj
  //
  // Several of those adjustments are positive, so a setup could clear
  // eligibility on its credited score and then be rejected here on the
  // uncredited one. Measured against live data on 2026-08-10: 10 of 10 sampled
  // Gate 9 rejections had already cleared the threshold, with credits of +1.79
  // to +2.20 (avg +1.97). backtest-engine has no equivalent gate, so this also
  // broke live/backtest parity — the strategy was tuned without it.
  //
  // Falls back to the legacy operands only when the caller does not supply the
  // effective pair (no live caller omits them).
  {
    const scoreForGate = typeof effectiveScore === "number" ? effectiveScore : analysis.score;
    const thresholdForGate = typeof effectiveMinConfluence === "number"
      ? effectiveMinConfluence
      : config.minConfluence;
    if (scoreForGate < thresholdForGate) {
      gates.push({ passed: false, reason: `Score ${scoreForGate.toFixed(1)} < ${thresholdForGate} threshold` });
    } else {
      gates.push({ passed: true, reason: `Score ${scoreForGate.toFixed(1)} meets threshold ${thresholdForGate}` });
    }
  }

  // Gate 9b: SMT Opposite Veto — block trades where SMT divergence opposes signal direction
  if (config.smtOppositeVeto !== false) {
    const smtFactor = analysis.factors?.find((f: any) => f.name === "SMT Divergence");
    if (smtFactor && smtFactor.detail && smtFactor.detail.includes("opposite to signal direction")) {
      gates.push({ passed: false, reason: `SMT divergence opposite — vetoed` });
    } else {
      gates.push({ passed: true, reason: `SMT veto: no opposition detected` });
    }
  }

  // Gate 10: R:R is route-specific. The executable entry, stop and target do
  // not exist until the market or pending-order geometry is frozen below.
  gates.push({
    passed: true,
    reason: "Risk/reward deferred until executable geometry is frozen",
  });

  // Gate 11: Opening Range — wait for completion (Fix #12: use interval-aware candle time)
  if (config.openingRange?.enabled && config.openingRange?.waitForCompletion) {
    const nyNow = toNYTime(new Date());
    const hoursSinceMidnight = nyNow.t; // NY local hours since midnight
    const candleCount = config.openingRange.candleCount || 24;
    // Convert candle count to hours based on entry timeframe
    const tfHours: Record<string, number> = { "1m": 1/60, "5m": 5/60, "15m": 0.25, "15min": 0.25, "30m": 0.5, "1h": 1, "4h": 4, "1d": 24 };
    const hoursPerCandle = tfHours[config.entryTimeframe] || 1;
    const requiredHours = candleCount * hoursPerCandle;
    if (hoursSinceMidnight < requiredHours) {
      gates.push({ passed: false, reason: `OR not complete: ${hoursSinceMidnight.toFixed(1)}/${requiredHours.toFixed(1)}h elapsed` });
    } else {
      gates.push({ passed: true, reason: `OR complete: ${requiredHours}h elapsed` });
    }
  }

  // Gate 12: Kill Zone Only
  if (config.killZoneOnly) {
    // Consolidation: ICT Kill Zone subsumes this gate when active (it has more granular windows).
    // Only apply legacy kill zone check when ICT KZ is disabled.
    const ictKZActive = config.ictKillZoneEnabled && config.ictKillZoneGateMode !== "off";
    if (ictKZActive) {
      gates.push({ passed: true, reason: `Kill zone delegated to ICT KZ (mode=${config.ictKillZoneGateMode})` });
    } else {
      const assetProfile = getAssetProfile(symbol);
      if (!assetProfile.skipSessionGate) {
        const sess = analysis.cachedSession || detectSession(config);
        if (!sess.isKillZone) {
          gates.push({ passed: false, reason: `Kill Zone Only: ${sess.name} session not in kill zone` });
        } else {
          gates.push({ passed: true, reason: `In ${sess.name} kill zone` });
        }
      } else {
        gates.push({ passed: true, reason: `Kill zone gate skipped for ${symbol} (crypto)` });
      }
    }
  }

  // Gate 13: Cooldown
  if (config.cooldownMinutes > 0) {
    const { data: recentTrades } = await supabase.from("paper_trade_history").select("closed_at")
      .eq("user_id", userId).eq("symbol", symbol).order("closed_at", { ascending: false }).limit(1);
    const elapsedMinutes = (recentTrades && recentTrades.length > 0)
      ? (Date.now() - new Date(recentTrades[0].closed_at).getTime()) / 60000
      : null;
    gates.push(checkCooldown({
      elapsedMinutes,
      cooldownMinutes: config.cooldownMinutes,
      symbol,
    }));
  }

  // Gate 14: Max Consecutive Losses (with 4-hour auto-reset cooldown)
  if (config.maxConsecutiveLosses > 0) {
    const { data: recentHistory } = await supabase.from("paper_trade_history").select("pnl, closed_at")
      .eq("user_id", userId).order("closed_at", { ascending: false }).limit(config.maxConsecutiveLosses + 1);
    if (recentHistory && recentHistory.length > 0) {
      let consecutiveLosses = 0;
      for (const t of recentHistory) {
        if (parseFloat(t.pnl) < 0) consecutiveLosses++;
        else break;
      }
      const lastLossTime = new Date(recentHistory[0].closed_at).getTime();
      const hoursSinceLastLoss = (Date.now() - lastLossTime) / (1000 * 60 * 60);
      gates.push(checkConsecutiveLosses({
        consecutiveLosses,
        maxConsecutiveLosses: config.maxConsecutiveLosses,
        hoursSinceLastLoss,
        autoResetHours: 4,
      }));
    } else {
      gates.push({ passed: true, reason: "No trade history for consecutive loss check" });
    }
  }

  // Gate 15: Dollar-based daily loss (net P&L)
  if (config.protectionMaxDailyLossDollar > 0) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const { data: todayTrades } = await supabase.from("paper_trade_history").select("pnl")
      .eq("user_id", userId).gte("closed_at", todayStr);
    const trades = todayTrades || [];
    const netPnl = trades.reduce((sum: number, t: any) => sum + parseFloat(t.pnl || "0"), 0);
    const grossLoss = trades.reduce((sum: number, t: any) => sum + Math.min(0, parseFloat(t.pnl || "0")), 0);
    const netLoss = Math.min(0, netPnl); // only trigger if net negative
    if (Math.abs(netLoss) >= config.protectionMaxDailyLossDollar) {
      gates.push({ passed: false, reason: `Daily net P&L -$${Math.abs(netLoss).toFixed(2)} >= $${config.protectionMaxDailyLossDollar} limit (gross loss: $${Math.abs(grossLoss).toFixed(2)})` });
    } else {
      gates.push({ passed: true, reason: `Daily net P&L $${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)} (gross loss: $${Math.abs(grossLoss).toFixed(2)})` });
    }
  }

  // Gate 16: News Event Filter — block trades near high-impact economic events
  if (config.newsFilterEnabled) {
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (supabaseUrl && serviceKey) {
        const newsRes = await fetch(`${supabaseUrl}/functions/v1/fundamentals`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            action: "high_impact_check",
            pair: symbol,
            withinMinutes: config.newsFilterPauseMinutes || 30,
          }),
        });
        if (newsRes.ok) {
          const newsData: any = await newsRes.json();
          if (newsData.hasHighImpact) {
            const nearestEvent = [...(newsData.events || [])].sort((a: any, b: any) =>
              Math.abs(new Date(a.scheduledTime).getTime() - Date.now()) -
              Math.abs(new Date(b.scheduledTime).getTime() - Date.now())
            )[0];
            const eventName = nearestEvent?.name || nearestEvent?.title || "event";
            const scheduledTime = nearestEvent?.scheduledTime
              ? new Date(nearestEvent.scheduledTime).toISOString()
              : null;
            const scheduleDetail = scheduledTime
              ? ` (scheduled ${scheduledTime})`
              : "";
            gates.push({
              passed: false,
              reason:
                `News filter: high-impact event within ${config.newsFilterPauseMinutes}min` +
                `${scheduleDetail} — ${eventName}`,
            });
          } else {
            gates.push({ passed: true, reason: `No high-impact news within ${config.newsFilterPauseMinutes}min for ${symbol}` });
          }
        } else {
          // Don't block trades if the news API is temporarily unavailable
          gates.push({ passed: true, reason: "News filter: API unavailable — skipped" });
        }
      } else {
        gates.push({ passed: true, reason: "News filter: env not configured — skipped" });
      }
    } catch (e: any) {
      console.warn(`News filter error for ${symbol}: ${e?.message}`);
      gates.push({ passed: true, reason: `News filter error: ${e?.message} — skipped` });
    }
  }

  // Gate 17: FOTSI Overbought/Oversold — softened from hard veto to heavy score penalty.
  // Rationale: A structurally perfect setup (BOS + OB + FVG + sweep) should be able to override
  // a lagging TSI reading. But a marginal setup won't pass the min confluence threshold after penalty.
  // BUY penalized if base TSI > +50 (buying overbought currency)
  // SELL penalized if base TSI < -50 (selling oversold currency)
  {
    const fotsi = (config as any)._fotsiResult as FOTSIResult | null;
    if (fotsi && config.useFOTSI !== false) {
      const currencies = parsePairCurrencies(symbol);
      if (currencies) {
        const [base, quote] = currencies;
        const dir = direction === "long" ? "BUY" : "SELL";
        const veto = checkOverboughtOversoldVeto(
          base, quote, dir as "BUY" | "SELL",
          fotsi.strengths, fotsi.series,
        );
        if (veto.vetoed) {
          // Softened: gate passes but -2.0 penalty is applied downstream to effectiveScore (line ~3756)
          gates.push({ passed: true, reason: `FOTSI WARNING (-2.0 penalty applied to effectiveScore): ${veto.reason}` });
        } else {
          gates.push({ passed: true, reason: veto.reason });
        }
      } else {
        gates.push({ passed: true, reason: "FOTSI Gate: non-forex pair — skipped" });
      }
    } else {
      gates.push({ passed: true, reason: "FOTSI Gate: data unavailable — skipped" });
    }
  }

  // Gate 18: ATR Volatility Filter (H2)
  // Blocks trades when ATR is outside the configured min/max range.
  if (config.atrFilterEnabled) {
    const spec = SPECS[symbol] || SPECS["EUR/USD"];
    const atrValue = analysis.atrValue ?? calculateATR(analysis._candles || [], 14);
    const atrPips = atrValue / spec.pipSize;
    const minPips = typeof config.atrFilterMin === "number" ? config.atrFilterMin : 0;
    const maxPips = typeof config.atrFilterMax === "number" ? config.atrFilterMax : 0;
    gates.push(checkATRVolatility({ atrPips, minPips, maxPips }));
  }

  // Gate 22: Correlation Filter — block self-cancelling hedges; cap same-direction stacking
  // Uses the numeric correlation matrix (STATIC_CORRELATIONS in portfolioCorrelation.ts).
  // A position counts as "correlated" when |raw correlation| >= maxCorrelation threshold,
  // regardless of direction:
  //   - Effective correlation > +threshold  → doubling (same bet twice) — allowed, but
  //     counted toward maxCorrelatedPositions to cap concentration.
  //   - Effective correlation < −threshold  → hedge (bets cancel; wastes spread/margin)
  //     — always blocked, regardless of the cap.
  // Currency decomposition + SMT_PAIRS retained as belt-and-suspenders for pairs
  // that are absent from the matrix.
  // Config: correlationFilterEnabled, maxCorrelation (0-1 threshold), maxCorrelatedPositions
  gates.push(checkCorrelationExposure({
    enabled: !!(config as any).correlationFilterEnabled,
    symbol,
    direction: direction as "long" | "short",
    openPositions,
    maxCorrelation: Number((config as any).maxCorrelation) || 0.8,
    maxCorrelatedPositions:
      Number((config as any).maxCorrelatedPositions) || 1,
  }));

  // Gate 19: Tier 1 Minimum (must have at least 2 core factors)
  if (analysis.tieredScoring) {
    const ts = analysis.tieredScoring;
    gates.push(checkTier1Minimum({
      tier1GateEnabled: config.tier1GateEnabled !== false,
      tier1GatePassed: !!ts.tier1GatePassed,
      tier1GateReason: ts.tier1GateReason,
      tier1Count: ts.tier1Count ?? 0,
    }));
  }

  // Gate 20: Regime Alignment — subsumed by Direction Verdict (Gate 1) when active.
  // When verdict is available, regime check is already incorporated into the verdict's
  // confidence calculation and veto logic. Gate always passes to avoid double-blocking.
  if (directionVerdict) {
    gates.push({ passed: true, reason: `Regime gate: subsumed by Direction Verdict (regime context: ${directionVerdict.sources.find(s => s.name === "regime")?.detail || "N/A"})` });
  } else if (analysis.tieredScoring) {
    const ts = analysis.tieredScoring;
    if (!ts.regimeGatePassed) {
      gates.push({ passed: false, reason: ts.regimeGateReason });
    } else {
      gates.push({ passed: true, reason: ts.regimeGateReason || "Regime gate: OK" });
    }
  }

  // Gate 21: Spread Quality (INFO-ONLY — never rejects, uses indicative market data)
  // Real spread check happens at execution time via broker API.
  if (analysis.tieredScoring) {
    const ts = analysis.tieredScoring;
    gates.push({ passed: true, reason: `[Info] ${ts.spreadGateReason || "Spread data unavailable"}` });
  }

  return applyAuthorityOwnershipToGateResults({
    gates,
    requestedMode: config.singleOwnershipMode,
    runtimeTarget: account.execution_mode === "live" ? "live" : "paper",
    canonicalRangeAvailable: analysis._canonicalDealingRangeAvailable === true,
    normalizeCode: normalizeRejectedGate,
  });
}

// ─── Main Handler ───────────────────────────────────────────────────────────
async function hydratePendingLifecycleRows(client: any, rows: any[]): Promise<any[]> {
  const ids = rows
    .map((row) => row.impulse_entry_lifecycle_id)
    .filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return rows;
  const { data, error } = await client.from("impulse_entry_lifecycles")
    .select("id,lifecycle").in("id", ids);
  if (error) {
    console.warn(`[pending] lifecycle hydration failed: ${error.message}`);
    return rows;
  }
  const current = new Map((data || []).map((row: any) => [row.id, row.lifecycle]));
  return rows.map((row) => ({
    ...row,
    impulse_entry_lifecycle: current.get(row.impulse_entry_lifecycle_id) ||
      row.impulse_entry_lifecycle || null,
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // ─── Caller verification: reject requests without valid cron secret OR user JWT ───
  const authError = await verifyCronOrUserCaller(req);
  if (authError) {
    const authHeader = req.headers.get("authorization") || "";
    const likelySchedulerRequest = req.headers.has("x-cron-secret") ||
      authHeader === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""}`;
    if (likelySchedulerRequest) {
      try {
        const failureClient = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
        const failureBody = await authError.clone().json().catch(() => ({}));
        await recordScannerAuthorizationFailure(
          failureClient,
          "bot-scanner",
          failureBody?.reason || "Rejected scheduler request",
          {
            has_cron_header: req.headers.has("x-cron-secret"),
            has_authorization: authHeader.startsWith("Bearer "),
          },
        );
      } catch (recordError: any) {
        console.warn(
          `[bot-scanner] Could not record auth failure: ${recordError?.message}`,
        );
      }
    }
    return authError;
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    let userId: string | null = null;

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.replace("Bearer ", "");
      // Skip if it's just the anon key (no user session)
      if (token !== Deno.env.get("SUPABASE_ANON_KEY")) {
        const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
          global: { headers: { Authorization: authHeader } },
        });
        const { data, error } = await userClient.auth.getClaims(token);
        if (!error && data?.claims?.sub) {
          userId = data.claims.sub as string;
        }
      }
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || "scan";
    const adminClient = createClient(supabaseUrl, supabaseKey);

    if (action === "scan_logs") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const { data } = await adminClient.from("scan_logs").select("*")
        .eq("user_id", userId).order("scanned_at", { ascending: false }).limit(20);
      return respond(data || []);
    }

    if (action === "manual_scan") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const scanCycleId = crypto.randomUUID();
      const operation = await beginScannerOperation(adminClient, {
        userId,
        botId: BOT_ID,
        functionName: "bot-scanner",
        operation: "scan",
        triggerSource: "manual",
        scanCycleId,
      });
      EdgeRuntime.waitUntil(
        runScanForUser(adminClient, userId, {
          isManualScan: true,
          operationRunId: operation.persisted ? operation.runId : undefined,
          scanCycleId,
        }).catch(async (e: any) => {
          console.error("[manual_scan] background error", e);
          await failScannerOperation(
            adminClient,
            operation.persisted ? operation.runId : undefined,
            e,
          );
        })
      );
      return respond({
        started: true,
        run_id: operation.persisted ? operation.runId : null,
        message: "Scan started",
      });
    }

    // ── Setup Staging: Fetch active staged setups for the UI ──
    if (action === "staged_setups") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const { data } = await adminClient.from("staged_setups").select("*")
        .eq("user_id", userId).eq("bot_id", BOT_ID)
        .order("staged_at", { ascending: false }).limit(50);
      return respond(data || []);
    }

    // ── Setup Staging: Dismiss (manually invalidate) a staged setup ──
    if (action === "dismiss_staged") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const setupId = body.setupId;
      if (!setupId) return respond({ error: "Missing setupId" }, 400);
      const dismissedAt = new Date().toISOString();
      const { error: updateErr } = await adminClient.from("staged_setups").update({
        status: "invalidated",
        invalidation_reason: "Manually dismissed by user",
        lifecycle_reason: "Manually dismissed by user",
        lifecycle_reason_code: "manual_dismissal",
        lifecycle_evidence: buildWatchlistLifecycleEvidence({
          reasonCode: "manual_dismissal",
          observedAt: dismissedAt,
          detail: { actor: "user" },
        }),
        resolved_at: dismissedAt,
      }).eq("id", setupId).eq("user_id", userId);
      if (updateErr) return respond({ error: updateErr.message }, 500);
      return respond({ success: true });
    }

    // ── Pending Orders: Get all pending orders (active + resolved) ──
    if (action === "pending_orders") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const statusFilter = body.status || "all";

      if (statusFilter === "snapshot") {
        const activeStatuses = [
          "pending",
          "awaiting_confirmation",
          "reconciliation_required",
        ];
        const terminalStatuses = [
          "filled",
          "broker_rejected",
          "invalidated",
          "expired",
          "cancelled",
        ];
        // Read active rows first, then terminal rows. If a row resolves between
        // the queries it can briefly appear in both sections, but it cannot vanish
        // from both sections during the state transition.
        const activeResult = await adminClient.from("pending_orders").select("*")
          .eq("user_id", userId).eq("bot_id", BOT_ID)
          .in("status", activeStatuses)
          .order("placed_at", { ascending: false });
        if (activeResult.error) {
          return respond({ error: activeResult.error.message }, 500);
        }
        const historyResult = await adminClient.from("pending_orders").select("*")
          .eq("user_id", userId).eq("bot_id", BOT_ID)
          .in("status", terminalStatuses)
          .order("resolved_at", { ascending: false, nullsFirst: false })
          .limit(100);
        if (historyResult.error) {
          return respond({ error: historyResult.error.message }, 500);
        }
        const [active, history] = await Promise.all([
          hydratePendingLifecycleRows(adminClient, activeResult.data || []),
          hydratePendingLifecycleRows(adminClient, historyResult.data || []),
        ]);
        return respond({ active, history, fetchedAt: new Date().toISOString() });
      }

      let query = adminClient.from("pending_orders").select("*")
        .eq("user_id", userId).eq("bot_id", BOT_ID);
      if (statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }
      const { data, error } = await query.order("placed_at", { ascending: false }).limit(100);
      if (error) return respond({ error: error.message }, 500);
      return respond(await hydratePendingLifecycleRows(adminClient, data || []));
    }

    // ── Pending Orders: Get only active pending orders ──
    if (action === "active_pending") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const { data, error } = await adminClient.from("pending_orders").select("*")
        .eq("user_id", userId).eq("bot_id", BOT_ID)
        .in("status", ["pending", "awaiting_confirmation", "reconciliation_required"])
        .order("placed_at", { ascending: false });
      if (error) return respond({ error: error.message }, 500);
      return respond(await hydratePendingLifecycleRows(adminClient, data || []));
    }

    // ── Pending Orders: Cancel a pending order ──
    if (action === "cancel_pending") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const orderId = body.orderId;
      if (!orderId) return respond({ error: "Missing orderId" }, 400);
      const { error: updateErr } = await adminClient.from("pending_orders").update({
        status: "cancelled",
        cancel_reason: "Manually cancelled by user",
        resolved_at: new Date().toISOString(),
      }).eq("order_id", orderId).eq("user_id", userId)
        .in("status", ["pending", "awaiting_confirmation", "reconciliation_required"]);
      if (updateErr) return respond({ error: updateErr.message }, 500);
      return respond({ success: true });
    }

    // ── Setup Staging: Get only active (watching) staged setups ──
    if (action === "active_staged") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const { data } = await adminClient.from("staged_setups").select("*")
        .eq("user_id", userId).eq("bot_id", BOT_ID)
        .in("status", ["watching", "qualified"])
        .order("current_score", { ascending: false });
      return respond(data || []);
    }

    // ── Management-Only Cron (1-minute cycle with internal sub-minute loop) ──
    // Refreshes prices, runs trailing/BE/partial TP, checks pending order fills/expiry.
    // Does NOT run the full scan or place new trades. Designed for pg_cron every 1 min.
    //
    // INTERNAL LOOP: Runs management repeatedly every ~8 seconds for ~50 seconds of
    // the execution window, then exits cleanly before the next cron invocation.
    // This gives sub-minute SL ratcheting without needing sub-minute cron (not supported by pg_cron).
    // Single decision authority, single broker-writer — same code path invoked multiple times.
    if (action === "manage") {
      const { data: allAccounts } = await adminClient.from("paper_accounts").select("*")
        .eq("is_running", true).eq("kill_switch_active", false);
      const accounts = (allAccounts || []).filter((a: any) => !a.bot_id || a.bot_id === BOT_ID);
      if (!accounts || accounts.length === 0) return respond({ message: "No active accounts", managed: 0 });
      const triggerSource: ScannerTriggerSource = body.trigger_source === "manual"
        ? "manual"
        : "cron";
      const operationRuns = new Map<string, string>();
      for (const account of accounts) {
        const operation = await beginScannerOperation(adminClient, {
          userId: account.user_id,
          botId: BOT_ID,
          functionName: "bot-scanner",
          operation: "manage",
          triggerSource,
        });
        if (operation.persisted) operationRuns.set(account.user_id, operation.runId);
      }

      // Return HTTP response immediately, run the loop in the background via waitUntil
      // to avoid pg_cron's request timeout (~150s) killing us mid-loop.
      EdgeRuntime.waitUntil((async () => {
        const LOOP_BUDGET_MS = 50_000; // 50 seconds — exit before next cron at 60s
        // 20s, not 8s. Each iteration is a full runScanForUser in
        // management-only mode, and management-only does not return early until
        // well past the price refresh and the SL/TP breach check — both of which
        // fetch candles per open symbol through a cache that is rebuilt every
        // iteration. At 8s that is ~6 passes a minute; with three open positions
        // roughly 27 TwelveData credits a minute, against a 55/min plan shared
        // with the scanner and every other function.
        //
        // Measured 2026-08-11: 75 credits/min average, 371 peak, 100% of quota,
        // requests 429ing. Downstream that reads as "Insufficient candles
        // (0, need 20)" and the pair is skipped — 44% of scans.
        //
        // Caching candles ACROSS iterations was the other option, but the loop
        // exists to notice price moving. Serving every iteration the same bars
        // would make passes 2-6 re-evaluate identical data, so fewer real passes
        // beats more fake ones.
        //
        // Trailing stops and break-even now react within ~20s instead of ~8s.
        // Acceptable: in live mode the broker holds the real SL/TP, and since
        // #282 bot-scanner re-checks every position against closed bars and is
        // the authoritative closer.
        const LOOP_INTERVAL_MS = 20_000;
        const loopStart = Date.now();
        let iteration = 0;
        const failedUsers = new Set<string>();

        await Promise.all(accounts.map((account: any) =>
          markScannerOperation(
            adminClient,
            operationRuns.get(account.user_id),
            "position_management_started",
            { status: "running" },
          )
        ));

        while (Date.now() - loopStart < LOOP_BUDGET_MS) {
          iteration++;
          const iterStart = Date.now();
          console.log(`[manage-loop] iteration ${iteration} starting (elapsed ${Math.round((iterStart - loopStart) / 1000)}s)`);

          for (const account of accounts) {
            try {
              await runScanForUser(adminClient, account.user_id, { isManagementOnly: true });
            } catch (e: any) {
              failedUsers.add(account.user_id);
              console.error(`[manage-loop] error for ${account.user_id} iter ${iteration}:`, e?.message || e);
            }
            await markScannerOperation(
              adminClient,
              operationRuns.get(account.user_id),
              "position_management_running",
              { status: "running", metadata: { iteration } },
            );
          }

          // Check if we have budget for another iteration
          const elapsed = Date.now() - loopStart;
          const remaining = LOOP_BUDGET_MS - elapsed;
          if (remaining < LOOP_INTERVAL_MS) {
            console.log(`[manage-loop] exiting after ${iteration} iterations (${Math.round(elapsed / 1000)}s elapsed, ${Math.round(remaining / 1000)}s remaining < ${LOOP_INTERVAL_MS / 1000}s interval)`);
            break;
          }

          // Sleep until next iteration
          const iterDuration = Date.now() - iterStart;
          const sleepMs = Math.max(0, LOOP_INTERVAL_MS - iterDuration);
          if (sleepMs > 0) {
            await new Promise(r => setTimeout(r, sleepMs));
          }
        }
        console.log(`[manage-loop] complete: ${iteration} iterations in ${Math.round((Date.now() - loopStart) / 1000)}s`);
        await Promise.all(accounts.map(async (account: any) => {
          const runId = operationRuns.get(account.user_id);
          if (failedUsers.has(account.user_id)) {
            await failScannerOperation(
              adminClient,
              runId,
              "One or more management iterations failed",
              "management_iteration_failed",
            );
            return;
          }
          await completeScannerOperation(adminClient, runId, "manage", {
            iterations: iteration,
            elapsed_ms: Date.now() - loopStart,
          });
        }));
      })());

      return respond({
        started: true,
        accounts: accounts.length,
        observable_runs: operationRuns.size,
        message: "Management loop started in background (~50s, ~8s intervals)",
      });
    }

     if (action === "scan" || action === "cron") {
      const { data: allAccounts } = await adminClient.from("paper_accounts").select("*")
        .eq("is_running", true).eq("kill_switch_active", false);
      // Filter to SMC bot accounts only (or legacy accounts without bot_id)
      const accounts = (allAccounts || []).filter((a: any) => !a.bot_id || a.bot_id === BOT_ID);
      if (!accounts || accounts.length === 0) return respond({ message: "No active accounts", scanned: 0 });
      const operationRuns = new Map<string, { runId: string; scanCycleId: string }>();
      for (const account of accounts) {
        const scanCycleId = crypto.randomUUID();
        const operation = await beginScannerOperation(adminClient, {
          userId: account.user_id,
          botId: BOT_ID,
          functionName: "bot-scanner",
          operation: "scan",
          triggerSource: "cron",
          scanCycleId,
        });
        if (operation.persisted) {
          operationRuns.set(account.user_id, {
            runId: operation.runId,
            scanCycleId,
          });
        }
      }
      // Run scans in the background via waitUntil so the HTTP request can return
      // immediately. Without this, the cron caller's request timeout (~150s) was
      // killing the function mid-scan, leaving no scan_logs row written.
      EdgeRuntime.waitUntil((async () => {
        for (const account of accounts) {
          const operation = operationRuns.get(account.user_id);
          try {
            await runScanForUser(adminClient, account.user_id, {
              operationRunId: operation?.runId,
              scanCycleId: operation?.scanCycleId,
            });
          } catch (e: any) {
            console.error(`[scan] background error for ${account.user_id}:`, e?.message || e);
            await failScannerOperation(adminClient, operation?.runId, e);
          }
        }
      })());
      return respond({
        started: true,
        accounts: accounts.length,
        observable_runs: operationRuns.size,
        message: "Scan started in background",
      });
    }

    console.warn("[bot-scanner] Unknown action received:", JSON.stringify(body));
    return respond({ error: "Unknown action", received: action, bodyKeys: Object.keys(body || {}) }, 400);
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function runScanForUser(
  supabase: any,
  userId: string,
  opts?: {
    isManualScan?: boolean;
    isManagementOnly?: boolean;
    operationRunId?: string;
    scanCycleId?: string;
  },
) {
  const specCache: Record<string, { minVolume: number; maxVolume: number; volumeStep: number }> = {};
  const balanceCache: Record<string, number> = {};
  const brokerHealthMap: Record<string, BrokerHealth> = {}; // Circuit breaker state per connection (in-memory, resets each invocation)
  const MAX_BROKER_RISK_PERCENT = 5; // hard safety cap per broker per trade
  const scanCycleId = opts?.scanCycleId ?? crypto.randomUUID();
  const scanStartedAt = new Date().toISOString();
  _scanCandleSources.clear();

  // ── Data Cache: fetch candles once per (symbol, interval), reuse across game plan + scan loop ──
  const scanCache = createScanCache(fetchCandles);
  const cachedFetch = (sym: string, interval: string, range: string) => scanCache.get(sym, interval, range);

  // ── Scan overlap lock (scoped lease) ──
  // Prevents two cron invocations from racing — second cycle would otherwise see the first's
  // in-flight trades as orphans or double-process the same signals.
  // Management-only runs skip the lock entirely — they're lightweight and shouldn't block scans.
  //
  // Manual scans use the same atomic claim as cron scans. They never clear a valid
  // lease owned by another run. Expired leases can be reclaimed automatically.
  let scanLockToken: string | null = null;
  if (!opts?.isManagementOnly) {
    const lock = await claimScannerLock(supabase, {
      userId,
      botId: BOT_ID,
      runId: opts?.operationRunId ?? scanCycleId,
    });
    if (!lock.acquired) {
      console.log(`[scan-lock] skipped — overlap detected for user ${userId}, bot ${BOT_ID}`);
      await skipScannerOperation(supabase, opts?.operationRunId, "overlap");
      return { pairsScanned: 0, signalsFound: 0, tradesPlaced: 0, skippedReason: "overlap", scanCycleId };
    }
    scanLockToken = lock.token;
    await markScannerOperation(supabase, opts?.operationRunId, "scan_started", {
      status: "running",
      scan_started_at: new Date().toISOString(),
    });
  } // end scan-lock block (skipped for management-only)

  let account: any = null;
  try {
  const styleResolution = await loadConfig(supabase, userId);
  const config = styleResolution.config;
  const gamePlanEnabled = (config as any).gamePlanEnabled !== false;
  const gpEnforcementMode = ((config as any).gpEnforcementMode ?? "hard") as
    | "off"
    | "soft"
    | "hard";
  const gamePlanAffectsExecution =
    gamePlanEnabled && gpEnforcementMode !== "off";
  const impulseLifecycleEnforcement = resolveImpulseLifecycleEnforcement(
    (config as any).impulseEntryLifecycleMode,
    null,
  );
  const resolvedStyle = styleResolution.style;
  const runtimeConfigProvenance = styleResolution.provenance;

  // ── Scan Interval Gate ──
  // Skip this scan if not enough time has elapsed since the last scan.
  // Manual scans and management-only runs always bypass this gate.
  const intervalMinutes = config.scanIntervalMinutes || 15;
  if (!opts?.isManualScan && !opts?.isManagementOnly) {
    const { data: lastScan } = await supabase
      .from("scan_logs")
      .select("created_at")
      .eq("user_id", userId)
      .eq("bot_id", BOT_ID)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastScan?.created_at) {
      const elapsedMs = Date.now() - new Date(lastScan.created_at).getTime();
      const elapsedMin = elapsedMs / 60_000;
      if (elapsedMin < intervalMinutes) {
        console.log(`[scan-interval] Skipping — only ${elapsedMin.toFixed(1)}min since last scan (interval: ${intervalMinutes}min)`);
        await skipScannerOperation(supabase, opts?.operationRunId, "scan_interval");
        return { pairsScanned: 0, signalsFound: 0, tradesPlaced: 0, skippedReason: `interval (${Math.ceil(intervalMinutes - elapsedMin)}min remaining)`, scanCycleId };
      }
    }
  }

  // ── Report the canonical Trading Style resolution ──
  if (styleResolution.applied.length > 0) {
    console.log(`[config] Style "${resolvedStyle}" applied: ${styleResolution.applied.join(", ")}`);
  }
  if (styleResolution.preserved.length > 0) {
    console.log(`[config] User-protected overrides kept: ${styleResolution.preserved.join(", ")}`);
  }
  const scanStylePolicy = await buildResolvedStylePolicy({
    resolution: styleResolution,
    config,
  });
  const timeframeAuthority = resolveTimeframeAuthority(scanStylePolicy);

  // Day-of-week check — skip for crypto-only instrument lists.
  // FX special case: market reopens Sunday 17:00 ET (Sydney open). Treat that window as Monday for gating.
  const now = new Date();
  const nyNow = toNYTime(now);
  const nyHour = nyNow.t;
  const nyDay = nyNow.nyDay; // 0=Sun … 6=Sat — NY local day, NOT UTC day
  const isFxOpenSundayEvening = nyDay === 0 && nyHour >= 17;
  const isFxClosedFridayEvening = nyDay === 5 && nyHour >= 17;
  const effectiveDay = isFxOpenSundayEvening ? 1 : nyDay; // pretend Sunday-evening is Monday
  const hasCrypto = config.instruments.some((s: string) => SPECS[s]?.type === "crypto");
  const hasNonCrypto = config.instruments.some((s: string) => SPECS[s]?.type !== "crypto");
  if (!config.enabledDays.includes(effectiveDay) && !hasCrypto && !opts?.isManagementOnly) {
    await skipScannerOperation(supabase, opts?.operationRunId, "day_not_enabled");
    return { pairsScanned: 0, signalsFound: 0, tradesPlaced: 0, skippedReason: "Day not enabled", activeStyle: resolvedStyle };
  }

  // S3 Fix: Capture session ONCE per scan cycle. detectSession() is time-based,
  // so calling it multiple times during a long scan could return different results
  // if the scan crosses a session boundary. Cache it here and reuse everywhere.
  const session = detectSession(config);
  const normalizedSession = session.filterKey;
  // Freeze the session snapshot for this entire scan cycle
  const cachedSession = { ...session };
  // Preserve the existing 24/5 compatibility rule once per scan cycle. This
  // same frozen state is used by both the live gate and rotation observation.
  const coreSessionsEnabled = ["asian", "london", "newyork"].every((key) =>
    config.enabledSessions.includes(key)
  );
  const offHoursImplicitlyAllowed = normalizedSession === "offhours" &&
    coreSessionsEnabled;
  const restrictedAssetSessionGateOpen = isSessionEnabled(
    cachedSession,
    config.enabledSessions,
  ) || offHoursImplicitlyAllowed;
  // Session gate is now checked per-instrument inside the loop, not globally
  // Try to load bot-specific account first; fall back to legacy single-row if bot_id column doesn't exist yet
  {
    const { data: botAccount } = await supabase.from("paper_accounts").select("*").eq("user_id", userId).eq("bot_id", BOT_ID).maybeSingle();
    if (botAccount) {
      account = botAccount;
    } else {
      const { data: legacyAccount } = await supabase.from("paper_accounts").select("*").eq("user_id", userId).maybeSingle();
      account = legacyAccount;
    }
  }
  if (!account) {
    await skipScannerOperation(supabase, opts?.operationRunId, "paper_account_missing");
    return { error: "No paper account" };
  }
  const zoneLocalActivation = await loadZoneLocalActivation(supabase, {
    userId,
    botId: BOT_ID,
  });
  const crossTimeframeActivation = await loadCrossTimeframeActivation(
    supabase,
    {
      userId,
      botId: BOT_ID,
    },
  );
  const crossTimeframeAuthority = resolveCrossTimeframeAuthority({
    rawConfig: config as unknown as Record<string, unknown>,
    runtimeTarget: account.execution_mode === "live" ? "live" : "paper",
    activation: crossTimeframeActivation,
  });
  console.log(
    `[scan ${scanCycleId}] Zone-local requested=${config.zoneLocalEnforcementMode}`
      + ` activation=${zoneLocalActivation?.authorityStage || "missing"}`
      + ` runtimeEnforced=${zoneLocalActivation?.runtimeEnforced === true}`,
  );
  console.log(
    `[scan ${scanCycleId}] Cross-TF authority`
      + ` requested=${crossTimeframeAuthority.requestedMode}`
      + ` certified=${crossTimeframeAuthority.certifiedMaximum}`
      + ` effective=${crossTimeframeAuthority.effectiveMode}`
      + ` reason=${crossTimeframeAuthority.reason}`,
  );

  // Fetch Telegram chat IDs for notifications (supports both new array + legacy single)
  const { data: userSettings } = await supabase.from("user_settings").select("preferences_json").eq("user_id", userId).maybeSingle();
  const prefs = (userSettings?.preferences_json as any) || {};
  const telegramChatIds: string[] = (() => {
    const list = Array.isArray(prefs.telegramChatIds) ? prefs.telegramChatIds : [];
    const ids = list.map((c: any) => typeof c === "string" ? c : String(c?.id ?? "")).filter(Boolean);
    if (ids.length > 0) return ids;
    return prefs.telegramChatId ? [String(prefs.telegramChatId)] : [];
  })();

  // Notification category toggles — read from preferences_json.telegramNotifyCategories
  // Default: all enabled (undefined/missing = true)
  const notifyCategories: Record<string, boolean> = prefs.telegramNotifyCategories || {};
  const shouldNotify = (category: string): boolean => notifyCategories[category] !== false;

  const balance = parseFloat(account.balance || "10000");
  const isPaused = account.is_paused;

  // ── Compute average commission per lot across active broker connections ──
  // Used in R:R gating and lot sizing. Reads commission_per_lot (user-set) or detected_commission_per_lot (auto-learned).
  let avgCommissionPerLot = 0;
  if (account.execution_mode === "live") {
    const { data: commConns } = await supabase.from("broker_connections")
      .select("commission_mode, commission_per_lot, detected_commission_per_lot")
      .eq("user_id", userId).eq("is_active", true);
    if (commConns && commConns.length > 0) {
      avgCommissionPerLot = averageRoundTripCommission(commConns);
      const costedConnections = commConns.filter((connection: any) =>
        resolveRoundTripCommission(connection).roundTripPerLot > 0
      ).length;
      if (avgCommissionPerLot > 0) console.log(`[scan ${scanCycleId}] Avg commission: $${avgCommissionPerLot.toFixed(2)}/lot round-trip (from ${costedConnections} broker(s))`);
    }
  }
  (config as any)._avgCommissionPerLot = avgCommissionPerLot;

  // Load the user's active MetaAPI connection (used as primary candle source).
  // Prefer rows where account_id is a clean UUID (correctly formed; avoids broken duplicates).
  const { data: brokerConns } = await supabase.from("broker_connections")
    .select("id, api_key, account_id, symbol_suffix, symbol_overrides, created_at")
    .eq("user_id", userId).eq("broker_type", "metaapi").eq("is_active", true)
    .order("created_at", { ascending: false });
  if (brokerConns && brokerConns.length > 0) {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const picked = (brokerConns.find((r: any) => uuidRe.test(r.account_id)) || brokerConns[0]) as any;
    _scanBrokerConn = { ...picked, user_id: userId } as BrokerConn;
  } else {
    _scanBrokerConn = null;
  }
  console.log(`[scan ${scanCycleId}] Candle source: ${_scanBrokerConn ? "MetaAPI→TwelveData→Polygon" : "TwelveData→Polygon"}`);
  // Start tallying which feed actually serves each pair this cycle.
  beginScanSourceTally();
  resetThrottleStats(); // Reset rate-limit throttle counter for clean per-scan stats

  const { data: openPositions } = await supabase.from("paper_positions").select("*")
    .eq("user_id", userId).eq("position_status", "open");
  // Filter to only this bot's positions (bot_id column or legacy without it)
  let openPosArr = (openPositions || []).filter((p: any) => !p.bot_id || p.bot_id === BOT_ID);

  // ── Refresh current_price for all open positions before management ──
  // Without this, management reads stale entry-time prices and can't fire trailing/BE/TP logic.
  // Uses the same fetchCandles chain (MetaAPI→TwelveData→Polygon) as the rest of the scanner.
  if (openPosArr.length > 0) {
    const posSymbols: string[] = Array.from(new Set(openPosArr.map((p: any) => p.symbol as string)));
    const livePriceMap: Record<string, number> = {};
    // Trade management uses live quotes. Closed candles remain exclusive to detection.
    await Promise.all(posSymbols.map(async (sym: string) => {
      const price = await fetchLivePrice(sym);
      if (price !== null) livePriceMap[sym] = price;
    }));
    let priceUpdates = 0;
    for (const pos of openPosArr) {
      const livePrice = livePriceMap[pos.symbol];
      if (livePrice !== undefined && livePrice.toString() !== pos.current_price) {
        await supabase.from("paper_positions").update({ current_price: livePrice.toString() }).eq("id", pos.id);
        pos.current_price = livePrice.toString(); // Also update in-memory so management sees fresh price
        priceUpdates++;
      }
    }
    if (priceUpdates > 0) {
      console.log(`[scan ${scanCycleId}] Refreshed current_price for ${priceUpdates}/${openPosArr.length} open positions (${posSymbols.length} symbols)`);
    }
  }

  // ── Active Trade Management: manage existing positions before scanning for new ones ──
  // Weekend guard: skip management for non-crypto positions when FX market is closed
  // FX closed: Saturday all day, Sunday before 17:00 ET, Friday after 17:00 ET
  const fxMarketClosed = (nyDay === 6) || (nyDay === 0 && nyHour < 17) || (nyDay === 5 && nyHour >= 17);
  const fxPositions = openPosArr.filter((p: any) => SPECS[p.symbol]?.type !== "crypto");
  const cryptoPositions = openPosArr.filter((p: any) => SPECS[p.symbol]?.type === "crypto");
  // Only manage crypto positions during FX closed hours; manage all when FX is open
  const positionsToManage = fxMarketClosed ? cryptoPositions : openPosArr;
  if (fxMarketClosed && fxPositions.length > 0) {
    console.log(`[scan ${scanCycleId}] FX market closed — skipping management for ${fxPositions.length} FX position(s): ${fxPositions.map((p: any) => p.symbol).join(", ")}`);
  }
  let managementActions: ManagementAction[] = [];
  if (positionsToManage.length > 0) {
    try {
      managementActions = await manageOpenPositions(supabase, positionsToManage, config, scanCycleId, cachedFetch, detectSession);
      const activeActions = managementActions.filter(a => a.action !== "no_change");
      // ── BROKER RECONCILIATION: runs UNCONDITIONALLY every manage cycle ──
      // Must check all live, broker-mirrored positions regardless of whether
      // a management action fired this cycle — that unconditional check is the
      // entire point of the reconciliation design.
      if (account.execution_mode === "live") {
        const { data: liveConns } = await supabase.from("broker_connections")
          .select("*").eq("user_id", userId).in("broker_type", ["metaapi", "oanda"]).eq("is_active", true);
        if (liveConns && liveConns.length > 0) {
          // Build reconcile positions from open positions that have mirrored connections
          const reconcilePositions: ReconcilePosition[] = openPosArr
            .filter((p: any) => Array.isArray(p.mirrored_connection_ids) && p.mirrored_connection_ids.length > 0)
            .map((p: any) => ({
              id: p.id,
              position_id: p.position_id,
              symbol: p.symbol,
              direction: p.direction as "long" | "short",
              stop_loss: p.stop_loss != null ? parseFloat(String(p.stop_loss)) : null,
              take_profit: p.take_profit != null ? parseFloat(String(p.take_profit)) : null,
              mirrored_connection_ids: p.mirrored_connection_ids,
            }));
          // Run SL reconciliation
          if (reconcilePositions.length > 0) {
            await reconcileBrokerState({
              supabase,
              userId,
              positions: reconcilePositions,
              connections: liveConns as BrokerConnection[],
              telegramChatIds,
              shouldNotify,
              scanCycleId,
            });
          }
          // Run partial close for any partial_tp_executed actions (depends on activeActions)
          if (activeActions.length > 0) {
            const partialActions = activeActions.filter((a) => a.action === "partial_tp_executed");
            if (partialActions.length > 0) {
              const partialCloseActions = partialActions.map(a => {
                const partialPercent = a.attribution?.detail?.match(/(\d+)%/)?.[1];
                const closeFraction = partialPercent ? parseInt(partialPercent) / 100 : 0.5;
                const pos = openPosArr.find((p: any) => p.position_id === a.positionId);
                return {
                  positionId: a.positionId,
                  symbol: a.symbol,
                  closeFraction,
                  direction: (pos?.direction || "long") as "long" | "short",
                };
              });
              const partialResults = await reconcilePartialClose({
                supabase,
                positions: reconcilePositions,
                connections: liveConns as BrokerConnection[],
                partialActions: partialCloseActions,
              });
              const partialFailures = partialResults.filter((result) => !result.ok);
              if (partialFailures.length > 0) {
                const failureDetail = partialFailures.map((result) =>
                  `${result.positionId}/${result.connectionId}: ${result.error || "unknown error"}`
                ).join("; ");
                console.error(
                  `[scan ${scanCycleId}] BROKER PARTIAL CLOSE RECONCILIATION REQUIRED: ${failureDetail}`,
                );
                if (telegramChatIds.length > 0) {
                  const message = `⚠️ <b>Broker Reconciliation Required</b>\n\n` +
                    tgLine("Action", "Partial take profit") +
                    tgLine("Status", "App reduced the position, but one or more broker closes failed") +
                    tgLine("Detail", failureDetail);
                  await Promise.all(telegramChatIds.map((chatId) =>
                    fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-notify`, {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                      },
                      body: JSON.stringify({ chat_id: chatId, message }),
                    }).catch(() => undefined)
                  ));
                }
              }
            }
          }
        }
      }
      // ── Management action logging + Telegram alerts (only when actions fired) ──
      if (activeActions.length > 0) {
        console.log(`[scan ${scanCycleId}] Trade management: ${activeActions.length} actions taken on ${openPosArr.length} positions`);
        for (const a of activeActions) {
          console.log(`  [mgmt] ${a.symbol}: ${a.action} — ${a.reason}`);
        }
        // Send Telegram alerts for significant management actions
        if (telegramChatIds.length > 0 && shouldNotify("trade_management")) {
          for (const a of activeActions) {
            const emoji = a.action === "sl_tightened" ? "🛡️"
              : a.action === "be_enabled" ? "🔒"
              : a.action === "trailing_enabled" ? "📏"
              : a.action === "partial_enabled" ? "💰"
              : "⚙️";
            const actionLabel = a.action === "sl_tightened" ? "SL TIGHTENED"
              : a.action === "be_enabled" ? "BREAK-EVEN ACTIVATED"
              : a.action === "trailing_enabled" ? "TRAILING ENABLED"
              : a.action === "partial_enabled" ? "PARTIAL TP ENABLED"
              : a.action.toUpperCase().replace("_", " ");
            const mgmtPos: any = positionsToManage.find((p: any) => p.position_id === a.positionId);
            const mgmtEntry = mgmtPos ? parseFloat(mgmtPos.entry_price) : NaN;
            const mgmtPrice = mgmtPos ? parseFloat(mgmtPos.current_price ?? mgmtPos.entry_price) : NaN;
            const mgmtSR = parseSignalReason(mgmtPos?.signal_reason);
            const mgmtR = mgmtPos
              ? rMultiple(mgmtEntry, mgmtSR.originalSL ?? mgmtPos.stop_loss, mgmtPrice, mgmtPos.direction)
              : null;
            const msg = `${emoji} <b>Trade Management</b>\n\n` +
              tgLine("Symbol", `${a.symbol}${mgmtPos ? ` (${String(mgmtPos.direction).toUpperCase()})` : ""}`) +
              tgLine("Action", actionLabel) +
              (mgmtPos ? tgLine("Entry", fmtPx(mgmtEntry, a.symbol)) : "") +
              (Number.isFinite(mgmtPrice) ? tgLine("Current", fmtPx(mgmtPrice, a.symbol)) : "") +
              (a.newSL ? tgLine("New SL", fmtPx(a.newSL, a.symbol)) : "") +
              (a.newTP ? tgLine("New TP", fmtPx(a.newTP, a.symbol)) : "") +
              (mgmtR !== null ? tgLine("Open R", `${mgmtR >= 0 ? "+" : ""}${mgmtR.toFixed(2)}R`) : "") +
              (mgmtPos ? tgLine("Open For", durationLabel(mgmtPos.open_time)) : "") +
              zoneEvidenceLines(mgmtSR) +
              tgLine("Reason", a.reason) +
              (a.attribution
                ? tgLine("Trigger", `${String(a.attribution.trigger).replace(/_/g, " ")}${a.attribution.marketContext?.session ? ` · ${a.attribution.marketContext.session}` : ""}`)
                : "");
            await Promise.all(telegramChatIds.map(async (chatId) => {
              try {
                await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-notify`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                  body: JSON.stringify({
                    chat_id: chatId,
                    message: msg,
                    dedupe_key: `trade-management:${a.positionId}:${a.action}`,
                    cooldown_seconds: a.action === "sl_tightened" ? 900 : 3600,
                    drop_if_rate_limited: true,
                  }),
                });
              } catch (e: any) {
                console.warn(`Telegram mgmt notify failed [${chatId}]:`, e?.message);
              }
            }));
          }
        }
      }
    } catch (e: any) {
      console.warn(`[scan ${scanCycleId}] Trade management error: ${e?.message}`);
    }
  }

  // Update daily PnL base if new day
  const todayStr = now.toISOString().slice(0, 10);
  if (account.daily_pnl_base_date !== todayStr) {
    const pnlUpdate = supabase.from("paper_accounts").update({
      daily_pnl_base_date: todayStr,
      daily_pnl_base: account.balance,
    }).eq("user_id", userId);
    // If account has bot_id, scope the update to this bot only
    if (account.bot_id) pnlUpdate.eq("bot_id", BOT_ID);
    await pnlUpdate;
  }

  const scanDetails: any[] = [];
  let signalsFound = 0;
  let tradesPlaced = 0;
  let rejectedCount = 0;

  // ── Setup Staging: Fetch active staged setups for this user/bot ──
  let activeStagedSetups: any[] = [];
  const stagingEnabled = config.stagingEnabled !== false;
  const watchThreshold = config.watchThreshold ?? 25;
  const stagingTTLMinutes = config.stagingTTLMinutes ?? 240;
  const minStagingCycles = config.minStagingCycles ?? 1;
  let stagedPromoted = 0;
  let stagedExpired = 0;
  let stagedInvalidated = 0;
  let stagedNew = 0;
  if (stagingEnabled) {
    try {
      const { data: staged } = await supabase
        .from("staged_setups")
        .select("*")
        .eq("user_id", userId)
        .eq("bot_id", BOT_ID)
        .eq("status", "watching");
      activeStagedSetups = staged || [];

      // Expire stale setups (TTL exceeded)
      const nowMs = Date.now();
      for (const s of activeStagedSetups) {
        const stagedAtMs = new Date(s.staged_at).getTime();
        const ttl = (s.ttl_minutes || stagingTTLMinutes) * 60_000;
        if (nowMs - stagedAtMs > ttl) {
          const expiredAt = new Date().toISOString();
          const ttlMinutes = s.ttl_minutes || stagingTTLMinutes;
          await supabase.from("staged_setups").update({
            status: "expired",
            invalidation_reason: `Watchlist time window expired (${ttlMinutes}min)`,
            lifecycle_reason: `Watchlist time window expired (${ttlMinutes}min)`,
            lifecycle_reason_code: "ttl_expired",
            lifecycle_evidence: buildWatchlistLifecycleEvidence({
              reasonCode: "ttl_expired",
              observedAt: expiredAt,
              frozenDirection: s.direction,
              detail: {
                stagedAt: s.staged_at,
                ttlMinutes,
                elapsedMinutes: (nowMs - stagedAtMs) / 60_000,
              },
            }),
            resolved_at: expiredAt,
          }).eq("id", s.id);
          stagedExpired++;
          console.log(`[staging] Expired ${s.symbol} ${s.direction} — TTL ${s.ttl_minutes || stagingTTLMinutes}min exceeded`);
        }
      }
      // Remove expired from active list
      activeStagedSetups = activeStagedSetups.filter(s => {
        const stagedAtMs = new Date(s.staged_at).getTime();
        const ttl = (s.ttl_minutes || stagingTTLMinutes) * 60_000;
        return nowMs - stagedAtMs <= ttl;
      });
    } catch (e: any) {
      console.warn(`[staging] Failed to fetch staged setups: ${e?.message}`);
    }
  }
  // Map for quick lookup: "SYMBOL:DIRECTION" → staged setup row
  const stagedMap = new Map<string, any>();
  const stagedByPair = new Map<string, any[]>();
  for (const s of activeStagedSetups) {
    stagedMap.set(`${s.symbol}:${s.direction}`, s);
    const pairRows = stagedByPair.get(s.symbol) || [];
    pairRows.push(s);
    stagedByPair.set(s.symbol, pairRows);
  }

  // Watchlist is a lifecycle lane, not discovery. Frozen executable zones get
  // a bounded price/invalidation refresh; only near-zone setups re-enter the
  // deeper confirmation pipeline for this cycle.
  const lifecycleDeepScanSymbols = new Set<string>();
  const WATCHLIST_MONITOR_LIMIT = 6;
  const executableWatchlist = activeStagedSetups
    .filter((setup: any) => setup.execution_eligible !== false && setup.originating_zone)
    .sort((left: any, right: any) => String(left.last_eval_at || "").localeCompare(String(right.last_eval_at || "")))
    .slice(0, WATCHLIST_MONITOR_LIMIT);
  for (const setup of executableWatchlist) {
    try {
      const zone = setup.originating_zone || {};
      const low = Number(zone.low);
      const high = Number(zone.high);
      if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
      const candles = await cachedFetch(
        setup.symbol,
        getEntryInterval(config.entryTimeframe),
        getEntryRange(config.entryTimeframe),
      );
      if (candles.length === 0) continue;
      const currentPrice = candles[candles.length - 1].close;
      const invalidation = deriveWatchlistInvalidation({
        direction: setup.direction as WatchlistDirection,
        proposedLevel: setup.sl_level,
      });
      if (isWatchlistInvalidated(setup.direction as WatchlistDirection, currentPrice, invalidation.level)) {
        const observedAt = new Date().toISOString();
        await supabase.from("staged_setups").update({
          status: "invalidated",
          invalidation_reason: `Price ${currentPrice} breached frozen Watchlist boundary ${invalidation.level}`,
          lifecycle_reason: "Frozen Watchlist boundary breached during lifecycle monitoring",
          lifecycle_reason_code: "structural_boundary_breached",
          lifecycle_phase: setup.lifecycle_phase || "zone_discovered",
          lifecycle_evidence: buildWatchlistLifecycleEvidence({
            reasonCode: "structural_boundary_breached",
            phase: setup.lifecycle_phase || "zone_discovered",
            observedAt,
            observedPrice: currentPrice,
            frozenDirection: setup.direction,
            invalidation,
          }),
          last_eval_at: observedAt,
          resolved_at: observedAt,
        }).eq("id", setup.id).eq("user_id", userId);
        stagedInvalidated++;
        continue;
      }
      const pipSize = (SPECS[setup.symbol] || SPECS["EUR/USD"]).pipSize;
      const proximity = measureLifecycleZoneProximity({
        currentPrice,
        zoneLow: low,
        zoneHigh: high,
        pipSize,
      });
      if (!proximity) continue;
      const { distance, nearBuffer, nearZone } = proximity;
      const phase = distance === 0 ? "at_zone" : nearZone ? "approaching_zone" : "zone_discovered";
      const observedAt = new Date().toISOString();
      await supabase.from("staged_setups").update({
        lifecycle_phase: phase,
        lifecycle_evidence: buildWatchlistLifecycleEvidence({
          reasonCode: nearZone ? "waiting_for_zone_confirmation" : "qualified",
          phase,
          observedAt,
          observedPrice: currentPrice,
          frozenDirection: setup.direction,
          invalidation,
          detail: { distance, nearBuffer, monitorLane: "lightweight" },
        }),
        last_eval_at: observedAt,
        scan_cycles: nearZone ? (setup.scan_cycles || 0) : (setup.scan_cycles || 0) + 1,
      }).eq("id", setup.id).eq("user_id", userId);
      if (nearZone) lifecycleDeepScanSymbols.add(setup.symbol);
    } catch (error: any) {
      console.warn(`[watchlist-monitor] ${setup.symbol}: ${error?.message}`);
    }
  }
  // ── Thesis Conviction Tracker: in-memory state per pair+direction ──
  // Persisted to kv_cache at end of scan cycle. Loaded from kv_cache at start.
  const convictionStates = new Map<string, ThesisConvictionState>();
  if ((config as any).thesisConvictionEnabled) {
    try {
      const { data: kvRows } = await supabase
        .from("kv_cache")
        .select("key, value, expires_at")
        .like("key", `thesis_conviction:${userId}:${BOT_ID}:%`);
      if (kvRows) {
        const now = Date.now();
        for (const row of kvRows) {
          try {
            // Skip expired entries
            if (row.expires_at && new Date(row.expires_at).getTime() < now) continue;
            convictionStates.set(row.key, JSON.parse(row.value));
          } catch { /* skip corrupt entries */ }
        }
      }
      if (convictionStates.size > 0) {
        console.log(`[conviction] Loaded ${convictionStates.size} thesis conviction states from kv_cache`);
      }
    } catch (e: any) {
      console.warn(`[conviction] Failed to load conviction states: ${e?.message}`);
    }
  }

  // ── Build rateMap for cross-pair lot sizing & PnL conversion ──
  // Fetch last close prices for the 7 major pairs needed by getQuoteToUSDRate.
  const RATE_PAIRS = ["USD/JPY", "GBP/USD", "AUD/USD", "NZD/USD", "USD/CAD", "USD/CHF"];
  const rateMap: Record<string, number> = {};
  try {
    // Pre-warm from the persistent kv_cache before touching the API.
    //
    // These are DAILY candles for six fixed majors — they change once a day.
    // The in-memory candle cache would cover that (5 min TTL), except
    // manage-positions-1min gets a fresh isolate every minute, so the cache is
    // empty on arrival and all six are re-fetched. Measured at 6 credits/min
    // against a 50/min budget, purely to re-read yesterday's closes.
    //
    // The scan path already solves this at the batchGetCachedCandles call
    // further down, but that sits AFTER the management-only return, so the
    // manage loop — the thing that runs every minute — never reached it.
    try {
      const warm = await batchGetCachedCandles(
        supabase,
        RATE_PAIRS.map((p) => ({ symbol: p, interval: "1d" })),
      );
      for (const [mapKey, candles] of warm.entries()) {
        const [sym, interval] = mapKey.split(":");
        if (sym && interval && candles.length >= 30) scanCache.seed(sym, interval, candles, "kv_cache");
      }
    } catch { /* pre-warm is an optimisation — fall through to fetching */ }

    const rateFetches = await Promise.all(
      RATE_PAIRS.map(p => cachedFetch(p, "1d", "5d"))
    );

    // Persist whatever had to be fetched, so the next invocation starts warm.
    try {
      await batchSetCachedCandles(
        supabase,
        RATE_PAIRS.map((p, i) => ({ symbol: p, interval: "1d", candles: rateFetches[i] })),
      );
    } catch { /* fire and forget */ }
    for (let i = 0; i < RATE_PAIRS.length; i++) {
      const candles = rateFetches[i];
      if (candles.length > 0) {
        rateMap[RATE_PAIRS[i]] = candles[candles.length - 1].close;
      }
    }
    console.log(`[scan ${scanCycleId}] rateMap built: ${JSON.stringify(Object.fromEntries(Object.entries(rateMap).map(([k, v]) => [k, (v as number).toFixed(4)])))}`); 
  } catch (e: any) {
    console.warn(`[scan ${scanCycleId}] rateMap build failed: ${e?.message} — falling back to legacy sizing`);
  }

  // ── SL/TP Breach Check: close paper positions where price has crossed SL or TP ──
  // The management engine updates SL/TP in the DB but never closes positions.
  // For paper trading (no real broker SL enforcement), we must detect and close here.
  // Runs AFTER price refresh (current_price is fresh) and AFTER rateMap build (PnL conversion available).
  try {
    const breachCandidates = openPosArr.filter((p: any) =>
      (p.stop_loss || p.take_profit) && p.current_price
    );
    const breachedIds: string[] = []; // track IDs to splice from openPosArr after loop
    for (const pos of breachCandidates) {
      const spec = SPECS[pos.symbol] || SPECS["EUR/USD"];
      const currentPrice = parseFloat(pos.current_price);
      const sl = parseFloat(pos.stop_loss || "0");
      const tp = parseFloat(pos.take_profit || "0");
      const isLong = pos.direction === "long";
      if (!currentPrice || isNaN(currentPrice)) continue;

      // ── Build a real bar covering the position's life, not just a point ──
      // paper-trading polls a last price every 5s and cannot see a wick that
      // spikes through SL and recovers between polls. This path runs every ~5 min
      // and CAN, because it reads closed candles. Aggregating every bar since
      // open_time makes the check idempotent and catches anything the poll missed:
      // if price ever traded through the stop, the trade is over — that is exactly
      // what a broker-side SL would have done in live.
      //
      // Candles come from the per-scan cache, so the pair loop below reuses them
      // and this costs ~nothing.
      let exitBar = priceAsBar(currentPrice);
      try {
        const posCandles: Candle[] = await cachedFetch(
          pos.symbol,
          getEntryInterval(config.entryTimeframe),
          getEntryRange(config.entryTimeframe),
        );
        const openedAt = pos.open_time ? new Date(pos.open_time).getTime() : NaN;
        const sinceOpen = Number.isFinite(openedAt)
          ? posCandles.filter((c) => new Date(c.datetime).getTime() >= openedAt)
          : [];
        if (sinceOpen.length > 0) {
          exitBar = {
            open: sinceOpen[0].open,
            high: Math.max(currentPrice, ...sinceOpen.map((c) => c.high)),
            low: Math.min(currentPrice, ...sinceOpen.map((c) => c.low)),
            close: currentPrice,
          };
        }
      } catch (barErr: any) {
        // Fall back to the point check rather than leaving the position unmanaged.
        console.warn(`[breach-check] ${pos.symbol}: bar fetch failed (${barErr?.message}) — using last price only`);
      }

      const breachDecision = evaluateExit(exitBar, {
        direction: isLong ? "long" : "short",
        stopLoss: sl > 0 ? sl : null,
        takeProfit: tp > 0 ? tp : null,
        pipSize: spec.pipSize,
        slState: (pos.close_reason || "").toString(),
      });
      const hitPrice = breachDecision.exitPrice;
      const closeReason = breachDecision.reason;
      if (breachDecision.hit && breachDecision.ambiguousBar) {
        console.log(`[breach-check] ${pos.symbol}: bar touched both SL and TP — resolved to ${closeReason}`);
      }

      if (hitPrice && closeReason) {
        const entry = parseFloat(pos.entry_price);
        const size = parseFloat(pos.size);
        const pnlResult = calcPnl(
          pos.direction,
          entry,
          hitPrice,
          size,
          pos.symbol,
          rateMap,
        );
        if (!pnlResult.valid) {
          console.error(
            `[breach-check] ${pos.symbol}: refusing to settle invalid P&L (${pnlResult.reason})`,
          );
          continue;
        }
        const { pnl, pnlPips } = pnlResult;
        const nowClose = new Date().toISOString();

        const brokerClose = await reconcileFullBrokerClose({
          supabase,
          userId,
          botId: pos.bot_id || BOT_ID,
          position: pos,
          route: "scanner_breach",
          closeReason,
        });
        if (!brokerClose.readyToFinalize) {
          console.warn(
            `[breach-check] ${pos.position_id}: broker close deferred (${brokerClose.reason || brokerClose.state}); internal position remains open`,
          );
          continue;
        }
        const finalization = await finalizePaperPositionClose(supabase, {
          positionRowId: pos.id,
          userId,
          botId: pos.bot_id || BOT_ID,
          exitPrice: hitPrice,
          pnl,
          pnlPips,
          closeReason,
          closedAt: nowClose,
        });
        if (!finalization.closed) {
          console.log(`[breach-check] ${pos.position_id}: close skipped (${finalization.code})`);
          continue;
        }
        if (finalization.balance !== undefined) account.balance = finalization.balance.toString();
        if (finalization.peak_balance !== undefined) account.peak_balance = finalization.peak_balance.toString();

        // 4. Audit log
        const mirroredIds: string[] = Array.isArray(pos.mirrored_connection_ids) ? pos.mirrored_connection_ids : [];
        console.log("[close]", JSON.stringify({
          position_id: pos.position_id, symbol: pos.symbol, direction: pos.direction,
          broker_connection_ids: mirroredIds, pnl: pnl.toFixed(2), exit_price: hitPrice,
          close_reason: closeReason, close_source: "scanner_breach_check", scan_cycle_id: scanCycleId,
        }));
        try {
          const auditRows = (mirroredIds.length > 0 ? mirroredIds : [null]).map((cid: string | null) => ({
            user_id: userId, position_id: pos.position_id, symbol: pos.symbol,
            broker_connection_id: cid, close_reason: closeReason, close_source: "scanner_breach_check",
            pnl: pnl.toFixed(2), exit_price: hitPrice!.toString(),
            scan_cycle_id: scanCycleId,
            detail_json: { trigger: "price_breach", sl, tp, currentPrice, hitPrice },
          }));
          await supabase.from("close_audit_log").insert(auditRows);
        } catch (auditErr: any) {
          console.warn(`[close] audit insert failed for ${closeReason} ${pos.position_id}: ${auditErr?.message}`);
        }

        // 6. Telegram notification
        if (telegramChatIds.length > 0 && shouldNotify("trade_closed")) {
          const emoji = closeReason === "tp_hit" ? "🎯" : "🛑";
          const label = closeReason === "tp_hit" ? "TAKE PROFIT HIT" : "STOP LOSS HIT";
          const pnlEmoji = pnl >= 0 ? "✅" : "❌";
          const closeSR = parseSignalReason(pos.signal_reason);
          const closeOrigSL = closeSR.originalSL ?? pos.stop_loss;
          const closeR = rMultiple(pos.entry_price, closeOrigSL, hitPrice, pos.direction);
          const msg = `${emoji} <b>${label}</b>\n\n` +
            tgLine("Symbol", `${pos.symbol} (${String(pos.direction).toUpperCase()})`) +
            tgLine("Entry", fmtPx(pos.entry_price, pos.symbol)) +
            tgLine("Exit", fmtPx(hitPrice, pos.symbol)) +
            tgLine("SL at close", fmtPx(pos.stop_loss, pos.symbol)) +
            (String(closeOrigSL) !== String(pos.stop_loss) ? tgLine("Original SL", fmtPx(closeOrigSL, pos.symbol)) : "") +
            tgLine("TP", fmtPx(pos.take_profit, pos.symbol)) +
            tgLine("P&L", `${pnlEmoji} $${pnl.toFixed(2)} (${pnlPips.toFixed(1)} pips)`) +
            (closeR !== null ? tgLine("R Multiple", `${closeR >= 0 ? "+" : ""}${closeR.toFixed(2)}R`) : "") +
            tgLine("Size", `${pos.size} lots`) +
            tgLine("Held", durationLabel(pos.open_time)) +
            "\n" +
            zoneEvidenceLines(closeSR) +
            directionVerdictLines(closeSR.directionVerdict) +
            styleLadderLines(closeSR) +
            watchlistOriginLines(closeSR) +
            tgLine("Setup", closeSR.setupType ? String(closeSR.setupType).toUpperCase() : null);
          await Promise.all(telegramChatIds.map(async (chatId: string) => {
            try {
              await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-notify`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                body: JSON.stringify({ chat_id: chatId, message: msg }),
              });
            } catch (tgErr: any) {
              console.warn(`Telegram ${closeReason} notify failed [${chatId}]:`, tgErr?.message);
            }
          }));
        }

        // Mark for removal from openPosArr
        breachedIds.push(pos.position_id);
        console.log(`[scan ${scanCycleId}] SL/TP BREACH: ${pos.symbol} ${pos.direction} closed at ${hitPrice} (${closeReason}), PnL: $${pnl.toFixed(2)} (${pnlPips.toFixed(1)} pips)`);
      }
    }
    // Remove closed positions from openPosArr so they aren't processed further this cycle
    if (breachedIds.length > 0) {
      for (let i = openPosArr.length - 1; i >= 0; i--) {
        if (breachedIds.includes(openPosArr[i].position_id)) {
          openPosArr.splice(i, 1);
        }
      }
      console.log(`[scan ${scanCycleId}] SL/TP breach check: closed ${breachedIds.length} position(s), ${openPosArr.length} remaining`);
    }
  } catch (breachErr: any) {
    console.warn(`[scan ${scanCycleId}] SL/TP breach check error: ${breachErr?.message}`);
  }

  // ── FOTSI: Fetch 28 pairs and compute currency strengths (with 4h cache) ──
  let _fotsiResult: FOTSIResult | null = null;
  if (config.useFOTSI === false) {
    console.log(`[scan ${scanCycleId}] FOTSI disabled by config — skipping 28-pair fetch (saves ~28 API calls)`);
  } else try {
    // Try cache first — avoids 28 API calls if result is fresh
    const { result: cachedFotsi, fromCache } = await getFOTSIWithCache(supabase);
    if (cachedFotsi && fromCache) {
      _fotsiResult = cachedFotsi;
      console.log(`[scan ${scanCycleId}] FOTSI loaded from cache (saves ~28 API calls)`);
    } else {
      // Cache miss or expired — compute fresh
      const fotsiPairs = getFOTSIPairNames();
      const fotsiCandleMap: Record<string, any[]> = {};
      // Batch fetch daily candles for all 28 FOTSI pairs in groups of 5 with 1.2s
      // inter-batch delay. At 50 req/min limit, 5 parallel requests per batch with
      // ~1.2s spacing keeps us well under budget (~50 req in first minute).
      const FOTSI_BATCH_SIZE = 5;
      const FOTSI_BATCH_DELAY_MS = 1200;
      for (let i = 0; i < fotsiPairs.length; i += FOTSI_BATCH_SIZE) {
        const batch = fotsiPairs.slice(i, i + FOTSI_BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(p => cachedFetch(p, "1d", "6mo"))
        );
        for (let j = 0; j < batch.length; j++) {
          if (batchResults[j] && batchResults[j].length >= 30) {
            fotsiCandleMap[batch[j]] = batchResults[j];
          }
        }
        // Delay between batches to stay within TwelveData rate limits
        if (i + FOTSI_BATCH_SIZE < fotsiPairs.length) await new Promise(r => setTimeout(r, FOTSI_BATCH_DELAY_MS));
      }
      const fetchedCount = Object.keys(fotsiCandleMap).length;
      if (fetchedCount >= 20) { // Need at least 20 of 28 pairs for meaningful FOTSI
        _fotsiResult = computeFOTSI(fotsiCandleMap);
        console.log(`[scan ${scanCycleId}] FOTSI computed fresh: ${fetchedCount}/28 pairs, missing: [${_fotsiResult.missingPairs.join(", ")}]`);
        console.log(`[scan ${scanCycleId}] FOTSI strengths: ${JSON.stringify(Object.fromEntries(Object.entries(_fotsiResult.strengths).map(([k, v]) => [k, (v as number).toFixed(1)])))}`); 
        // Store in cache for subsequent scan cycles
        await setCachedFOTSI(supabase, _fotsiResult);
        console.log(`[scan ${scanCycleId}] FOTSI result cached (TTL: 4h)`);
      } else {
        console.warn(`[scan ${scanCycleId}] FOTSI skipped: only ${fetchedCount}/28 pairs fetched (need ≥20)`);
      }
    }
  } catch (e: any) {
    console.warn(`[scan ${scanCycleId}] FOTSI computation error: ${e?.message}`);
  }

  // ── Limit Orders: Helper to compute optimal entry price from OB/FVG zones ──
  function computeLimitEntryPrice(
    analysis: any, pair: string, direction: string
  ): {
    price: number;
    zoneType: string;
    lifecycleCandidateType: string;
    zoneLow: number;
    zoneHigh: number;
  } | null {
    if (!config.limitOrderEnabled) return null;
    const lastPrice = analysis.lastPrice;
    const spec = SPECS[pair] || SPECS["EUR/USD"];
    const maxDistancePips = config.limitOrderMaxDistancePips || 30;
    const maxDistance = maxDistancePips * spec.pipSize;

    const candidates: { price: number; zoneType: string; low: number; high: number; distance: number }[] = [];

    // Order Blocks: use consequent encroachment (midpoint) of unmitigated OBs
    if (analysis.orderBlocks) {
      for (const ob of analysis.orderBlocks) {
        if (ob.mitigated) continue;
        if (direction === "long" && ob.type === "bullish") {
          const entryLevel = (ob.high + ob.low) / 2;
          if (entryLevel < lastPrice) {
            const dist = lastPrice - entryLevel;
            if (dist <= maxDistance) {
              candidates.push({ price: entryLevel, zoneType: "OB", low: ob.low, high: ob.high, distance: dist });
            }
          }
        } else if (direction === "short" && ob.type === "bearish") {
          const entryLevel = (ob.high + ob.low) / 2;
          if (entryLevel > lastPrice) {
            const dist = entryLevel - lastPrice;
            if (dist <= maxDistance) {
              candidates.push({ price: entryLevel, zoneType: "OB", low: ob.low, high: ob.high, distance: dist });
            }
          }
        }
      }
    }

    // FVGs: use consequent encroachment (midpoint) of unfilled FVGs
    if (analysis.fvgs) {
      for (const fvg of analysis.fvgs) {
        if (fvg.mitigated) continue;
        const ce = (fvg.high + fvg.low) / 2;
        if (direction === "long" && fvg.type === "bullish" && ce < lastPrice) {
          const dist = lastPrice - ce;
          if (dist <= maxDistance) {
            candidates.push({ price: ce, zoneType: "FVG", low: fvg.low, high: fvg.high, distance: dist });
          }
        } else if (direction === "short" && fvg.type === "bearish" && ce > lastPrice) {
          const dist = ce - lastPrice;
          if (dist <= maxDistance) {
            candidates.push({ price: ce, zoneType: "FVG", low: fvg.low, high: fvg.high, distance: dist });
          }
        }
      }
    }

    if (candidates.length === 0) return null;

    // Pick the closest candidate to current price (best fill probability)
    candidates.sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    return {
      price: best.price,
      zoneType: best.zoneType,
      lifecycleCandidateType: best.zoneType,
      zoneLow: best.low,
      zoneHigh: best.high,
    };
  }

  // ── Thesis Validation: Load the dedicated active Gameplan version ──
  // Every later consumer reuses this exact dedicated version. The trading
  // scanner never generates or persists Game Plans.
  let _lastGamePlanForValidation: SessionGamePlan | null = null;
  let _activeDirectionVerdicts = new Map<
    string,
    DirectionVerdictDecision
  >();
  let _evidenceCertificateReferences: EvidenceCertificateReference[] = [];
  if (gamePlanEnabled) {
    try {
      _lastGamePlanForValidation = await loadActiveGamePlan(
        supabase,
        userId,
        BOT_ID,
      );
    } catch (gpErr: any) {
      // Final authorization fails closed in hard Game Plan mode if this remains unavailable.
      console.warn(`[scan ${scanCycleId}] Thesis validation: failed to load game plan: ${gpErr?.message}`);
    }
  }
  try {
    _activeDirectionVerdicts = await loadActiveDirectionVerdicts(
      supabase,
      userId,
      BOT_ID,
    );
  } catch (directionLoadErr: any) {
    console.warn(
      `[scan ${scanCycleId}] Fill authorization: failed to load active Direction Verdicts: ${directionLoadErr?.message}`,
    );
  }
  try {
    _evidenceCertificateReferences = await loadCurrentEvidenceCertificateReferences(
      supabase,
      userId,
      BOT_ID,
    );
  } catch (certificateLoadErr: any) {
    console.warn(
      `[scan ${scanCycleId}] Frozen context: current evidence certificates unavailable: ${certificateLoadErr?.message}`,
    );
  }

  // ── Limit Orders: Monitor active pending orders for fills/expiry ──
  let pendingFilled = 0;
  let pendingExpired = 0;
  let pendingCancelled = 0;
  let pendingPlaced = 0;
  const { data: activePendingOrders } = await supabase.from("pending_orders").select("*")
    .eq("user_id", userId).eq("bot_id", BOT_ID).in("status", ["pending", "awaiting_confirmation"])
    .order("placed_at", { ascending: true });
  let pendingConfirmationHunting = 0;  // orders currently in confirmation hunt mode

  if (activePendingOrders && activePendingOrders.length > 0) {
    console.log(`[scan ${scanCycleId}] Monitoring ${activePendingOrders.length} pending orders`);
    for (const pending of activePendingOrders) {
      try {
        // The one-minute zone-confirmation-scanner exclusively owns every
        // post-touch state, including CHoCH and frozen retracement waits.
        // Keeping the row in this collection still protects discovery and
        // rotation from duplicating it, but the five-minute scanner must not
        // reset or fill the same lifecycle using its original entry zone.
        if (pending.status !== "pending") {
          pendingConfirmationHunting++;
          lifecycleDeepScanSymbols.add(pending.symbol);
          continue;
        }
        const pendingPolicyResolution = resolvePendingStylePolicy(
          pending,
          scanStylePolicy,
        );
        const parsedPendingEvidence = parseSignalReason(pending.signal_reason);
        const pendingTimeframeAuthority = resolveTimeframeAuthority(
          pendingPolicyResolution.policy,
        );
        const pendingDealingRangeMode = resolvePendingDealingRangeMode(
          pending,
          (config as any).dealingRangeMode,
        );
        const frozenIdentity = validateFrozenSetupIdentity(
          pending,
          pendingPolicyResolution.frozenContext,
        );
        if (!frozenIdentity.valid) {
          await supabase.from("pending_orders").update({
            status: "invalidated",
            cancel_reason: frozenIdentity.reason,
            resolved_at: new Date().toISOString(),
          }).eq("id", pending.id).eq("user_id", userId);
          pendingCancelled++;
          console.warn(
            `[pending] ${pending.symbol} invalidated: ${frozenIdentity.reason}`,
          );
          continue;
        }
        const pendingConfirmationMethod = resolvePendingConfirmationMethod(
          pending,
          config,
        );
        const pendingConfirmationLabel = confirmationMethodLabel(
          pendingConfirmationMethod,
          (pending as any).indicator_min_count || (config as any).indicatorMinCount || 3,
        );

        // Check expiry first
        if (pending.expires_at && new Date(pending.expires_at) <= new Date()) {
          await supabase.from("pending_orders").update({
            status: "expired",
            cancel_reason: "TTL expired",
            resolved_at: new Date().toISOString(),
          }).eq("order_id", pending.order_id).eq("user_id", userId);
          pendingExpired++;
          console.log(`[pending] Expired ${pending.symbol} ${pending.direction} limit @ ${pending.entry_price}`);
          continue;
        }

        // Fetch current price to check if limit order should fill
        const pendingCandles = await cachedFetch(
          pending.symbol,
          pendingTimeframeAuthority.runtimeEntry,
          timeframeFetchRange(pendingTimeframeAuthority.runtimeEntry),
        );
        if (pendingCandles.length === 0) continue;
        const currentPrice = pendingCandles[pendingCandles.length - 1].close;

        // Update current price on the pending order
        await supabase.from("pending_orders").update({ current_price: currentPrice }).eq("order_id", pending.order_id).eq("user_id", userId);

        const entryPrice = parseFloat(pending.entry_price);
        const slLevel = parseFloat(pending.stop_loss);

        // Which boundary applies is a LIFECYCLE question, not a field-choice.
        //
        // Nothing in pending_orders has entered. Through both 'pending' and
        // 'awaiting_confirmation' there is no position, so the position stop —
        // sized as entry minus risk, floored by MIN_SL_PIPS and spread — has
        // nothing to govern. The pre-entry question is whether the ZONE or
        // IMPULSE that produced the setup has broken.
        //
        // Direction of the change, which is easy to get backwards: on the
        // observed GBP/CHF setup structural sits ~2 pips below the zone floor
        // and the position stop ~23 pips lower. Structural is TIGHTER, so this
        // invalidates EARLIER than before. That is intended — a setup whose zone
        // has broken is dead regardless of how much room a position would have had.
        const invalidation = invalidationForLifecycle({
          direction: pending.direction as "long" | "short",
          status: pending.status,
          structuralInvalidation: pending.structural_invalidation != null
            ? Number(pending.structural_invalidation)
            : null,
          stopLoss: slLevel,
        });
        if (invalidationBreached(pending.direction as "long" | "short", currentPrice, invalidation.level)) {
          await supabase.from("pending_orders").update({
            status: "invalidated",
            cancel_reason: `Price ${currentPrice} breached ${invalidation.source} ${invalidation.level} (${invalidation.lifecycle})`,
            resolved_at: new Date().toISOString(),
          }).eq("order_id", pending.order_id).eq("user_id", userId);
          pendingCancelled++;
          console.log(`[pending] Cancelled ${pending.symbol} ${pending.direction} — ${invalidation.reason} (price ${currentPrice} vs ${invalidation.level})`);
          continue;
        }

        // ═══════════════════════════════════════════════════════════════════
        // ── THESIS VALIDATION: Re-check structural conditions ──
        // Runs on every cycle (including management-only). Cancels pending
        // orders whose original trade thesis has been invalidated.
        // Errors do not cancel while the order is merely waiting, but the
        // final fill authority fails closed unless a fresh result exists.
        // ═══════════════════════════════════════════════════════════════════
        let pendingThesisResult: ThesisValidationResult | null = null;
        {
          try {
            let currentPendingDirectionVerdict =
              _activeDirectionVerdicts.get(pending.symbol) || null;
            const frozenPendingConfig =
              pendingPolicyResolution.frozenContext?.runtimeConfig
                ?.effectiveConfig || null;
            const pendingGamePlanExpected = frozenPendingConfig
              ? frozenPendingConfig.gamePlanEnabled !== false &&
                frozenPendingConfig.gpEnforcementMode !== "off"
              : gamePlanAffectsExecution;
            if (
              currentPendingDirectionVerdict && pendingGamePlanExpected &&
              !directionVerdictMatchesGamePlan(
                currentPendingDirectionVerdict,
                _lastGamePlanForValidation,
                pending.symbol,
              )
            ) {
              currentPendingDirectionVerdict = null;
            }
            const directionVerdictThesisOptions =
              buildDirectionVerdictThesisOptions({
                frozenDirectionVerdict:
                  pendingPolicyResolution.frozenContext?.directionVerdict ||
                  null,
                currentDirectionVerdict: currentPendingDirectionVerdict,
                expectedDecisionEvidence: {
                  style: pendingTimeframeAuthority.style,
                  roles: pendingTimeframeAuthority.roles,
                },
                frozenEffectiveConfig: frozenPendingConfig,
              });
            const thesisResult: ThesisValidationResult = validatePendingOrderThesis(
              {
                order_id: pending.order_id,
                symbol: pending.symbol,
                direction: pending.direction as "long" | "short",
                entry_price: pending.entry_price,
                signal_reason: pending.signal_reason,
              },
              {
                fotsiResult: _fotsiResult,
                lastGamePlan: _lastGamePlanForValidation,
                dailyCandles: null,
                h4Candles: null,
                h1Candles: null,
                decisionEvidence:
                  currentPendingDirectionVerdict?.decisionEvidence || null,
                ...directionVerdictThesisOptions,
              },
            );
            pendingThesisResult = thesisResult;
            if (!thesisResult.valid) {
              await supabase.from("pending_orders").update({
                status: "invalidated",
                cancel_reason: thesisResult.reason,
                thesis_cancel_reason: thesisResult.cancelReason,
                resolved_at: new Date().toISOString(),
              }).eq("order_id", pending.order_id).eq("user_id", userId);
              pendingCancelled++;
              console.log(`[pending] THESIS INVALID: ${pending.symbol} ${pending.direction} — ${thesisResult.checkType}: ${thesisResult.reason}`);
              // Telegram notification for thesis cancellation
              if (telegramChatIds.length > 0 && shouldNotify("thesis_invalidated")) {
                const invalidSR = parseSignalReason(pending.signal_reason);
                const msg = `⚠️ <b>Thesis Invalidated — Order Cancelled</b>\n\n` +
                  tgLine("Symbol", pending.symbol) +
                  tgLine("Direction", String(pending.direction).toUpperCase()) +
                  tgLine("Check", thesisResult.checkType) +
                  tgLine("Reason", thesisResult.reason) +
                  tgLine("Cancel Code", thesisResult.cancelReason) +
                  tgLine("Zone Trigger", fmtPx(pending.entry_price, pending.symbol)) +
                  tgLine("Waited", durationLabel(pending.created_at)) +
                  "\n" +
                  zoneEvidenceLines(invalidSR) +
                  directionVerdictLines(invalidSR.directionVerdict) +
                  watchlistOriginLines(invalidSR);
                await Promise.all(telegramChatIds.map(async (chatId: string) => {
                  try {
                    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-notify`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                      body: JSON.stringify({ chat_id: chatId, message: msg }),
                    });
                  } catch (e: any) { console.warn(`Telegram notify failed [${chatId}]:`, e?.message); }
                }));
              }
              continue;
            }
          } catch (tvErr: any) {
            // Fail-open: thesis validation error — keep order alive
            console.warn(`[pending] Thesis validation error for ${pending.symbol}: ${tvErr?.message}`);
          }
        }

        const pendingProximity = measureLifecycleZoneProximity({
          currentPrice,
          zoneLow: Number(pending.entry_zone_low),
          zoneHigh: Number(pending.entry_zone_high),
          pipSize: (SPECS[pending.symbol] || SPECS["EUR/USD"]).pipSize,
        });
        if (pendingProximity?.nearZone) {
          lifecycleDeepScanSymbols.add(pending.symbol);
        }

        // ═══════════════════════════════════════════════════════════════════
        // ── ZONE CONFIRMATION ENTRY STATE MACHINE ──
        // States: "pending" → "awaiting_confirmation" →
        // "filled"/"invalidated"/"expired"/"cancelled"
        // When price touches the zone, instead of immediately filling, we
        // transition to "awaiting_confirmation" and wait for a 5m CHoCH
        // applying the setup's frozen confirmation contract before entry.
        // ═══════════════════════════════════════════════════════════════════

        // Parse impulse data from signal_reason for invalidation check
        let impulseData: { high: number; low: number } | null = null;
        try {
          const signalReasonParsed = typeof pending.signal_reason === "string" ? JSON.parse(pending.signal_reason) : pending.signal_reason;
          if (signalReasonParsed?.impulseZone?.impulse) {
            impulseData = signalReasonParsed.impulseZone.impulse;
          }
        } catch { /* ignore parse errors */ }

        // ── Branch A: Order is in "pending" status — check if price touched zone ──
        if (pending.status === "pending") {
          const pendingNestedPlanState =
            resolvePendingNestedPoiEntryPlanState(pending);
          if (!pendingNestedPlanState.valid) {
            const reason = pendingNestedPlanState.reason;
            const { data: invalidatedPending } = await supabase
              .from("pending_orders")
              .update({
                status: "invalidated",
                cancel_reason: reason,
                resolved_at: new Date().toISOString(),
              })
              .eq("id", pending.id)
              .eq("user_id", userId)
              .eq("status", "pending")
              .select("id")
              .maybeSingle();
            if (!invalidatedPending) continue;
            pendingCancelled++;
            console.warn(
              "[pending] " + pending.symbol + " invalidated: " + reason,
            );
            continue;
          }
          const pendingNestedPoiEntry = pendingNestedPlanState.plan;
          const pendingNestedActivation = pendingNestedPoiEntry
            ? resolveFrozenNestedPoiMarketRoute({
              mode: pendingNestedPoiEntry.mode,
              route: pendingNestedPoiEntry.route,
              runtimeTarget: account.execution_mode === "live"
                ? "live"
                : "paper",
            })
            : null;
          if (pendingNestedActivation?.runtimeTargetMismatch === true) {
            const reason =
              "nested_poi_runtime_target_mismatch: paper-only setup cannot execute live";
            const { data: cancelledPending } = await supabase
              .from("pending_orders")
              .update({
                status: "cancelled",
                cancel_reason: reason,
                resolved_at: new Date().toISOString(),
              })
              .eq("id", pending.id)
              .eq("user_id", userId)
              .eq("status", "pending")
              .select("id")
              .maybeSingle();
            if (!cancelledPending) continue;
            pendingCancelled++;
            console.warn(
              "[pending] " + pending.symbol + " cancelled: " + reason,
            );
            continue;
          }
          const nestedPoiEnforced =
            pendingNestedActivation?.enforced === true;
          const touch = findEarliestPendingZoneTouch({
            candles: pendingCandles,
            direction: pending.direction as "long" | "short",
            entryPrice,
            zoneLow: nestedPoiEnforced
              ? pendingNestedPoiEntry!.outerZone.low
              : undefined,
            zoneHigh: nestedPoiEnforced
              ? pendingNestedPoiEntry!.outerZone.high
              : undefined,
            observedAfter: pending.last_touch_checked_at || pending.placed_at || pending.created_at,
            interval: pendingTimeframeAuthority.runtimeEntry,
          });

          if (touch.touchTime) {
            // Preserve the first matching candle; this timestamp anchors CHoCH.
            const { data: transitionedTouch } = await supabase.from("pending_orders").update({
              status: "awaiting_confirmation",
              zone_touch_time: touch.touchTime,
              last_touch_checked_at: touch.checkedAt,
              confirmation_attempts: 0,
            }).eq("order_id", pending.order_id).eq("user_id", userId).eq(
              "status",
              "pending",
            ).select("id").maybeSingle();
            if (!transitionedTouch) continue;
            pendingConfirmationHunting++;
            lifecycleDeepScanSymbols.add(pending.symbol);
            console.log(
              "[pending] " + pending.symbol + " " + pending.direction +
                " — OUTER ZONE TOUCHED on " + touch.touchTime +
                (nestedPoiEnforced
                  ? "; waiting for frozen nested " +
                    pendingNestedPoiEntry!.selected!.type + " trigger"
                  : ", entering confirmation hunt mode (" +
                    pendingConfirmationLabel + ")"),
            );
            // Send Telegram notification: zone touched, hunting confirmation
            if (telegramChatIds.length > 0 && shouldNotify("zone_touched")) {
              const emoji = pending.direction === "long" ? "🟡" : "🟡";
              const touchSR = parseSignalReason(pending.signal_reason);
              const msg = `${emoji} <b>Zone Touched — Hunting Confirmation</b>\n\n` +
                tgLine("Symbol", pending.symbol) +
                tgLine("Direction", String(pending.direction).toUpperCase()) +
                tgLine("Zone Range", `${pending.entry_zone_type} [${fmtPx(pending.entry_zone_low || "0", pending.symbol)} – ${fmtPx(pending.entry_zone_high || "0", pending.symbol)}]`) +
                tgLine("Entry Level", fmtPx(entryPrice, pending.symbol)) +
                tgLine("Planned SL", fmtPx(pending.stop_loss, pending.symbol)) +
                tgLine("Planned TP", fmtPx(pending.take_profit, pending.symbol)) +
                tgLine("Size", pending.size ? `${pending.size} lots` : null) +
                tgLine(
                  "Waiting for",
                  nestedPoiEnforced
                    ? "Frozen nested " +
                      pendingNestedPoiEntry!.selected!.type.toUpperCase() +
                      " touch"
                    : (pending.direction === "short" ? "Bearish " : "Bullish ") +
                      pendingConfirmationLabel,
                ) +
                tgLine("Waited in Zone Setup", durationLabel(pending.created_at)) +
                "\n" +
                tradeAuthorityLines(touchSR) +
                zoneEvidenceLines(touchSR) +
                directionVerdictLines(touchSR.directionVerdict) +
                styleLadderLines(touchSR) +
                watchlistOriginLines(touchSR) +
                diagnosticScoreLine(pending.signal_score);
              await Promise.all(telegramChatIds.map(async (chatId: string) => {
                try {
                  await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-notify`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                    body: JSON.stringify({ chat_id: chatId, message: msg }),
                  });
                } catch (e: any) { console.warn(`Telegram notify failed [${chatId}]:`, e?.message); }
              }));
            }
            continue;
          }
          // Advance the durable cursor only after every overlapping candle was checked.
          await supabase.from("pending_orders").update({
            last_touch_checked_at: touch.checkedAt,
          }).eq("order_id", pending.order_id).eq("user_id", userId).eq(
            "status",
            "pending",
          );
          continue;
        }

      } catch (e: any) {
        console.warn(`[pending] Error monitoring ${pending.symbol}: ${e?.message}`);
      }
    }
    console.log(`[scan ${scanCycleId}] Pending orders: ${pendingFilled} filled, ${pendingExpired} expired, ${pendingCancelled} cancelled, ${pendingConfirmationHunting} awaiting confirmation`);
  }

  // ── Management-Only Early Return ──
  // When called with isManagementOnly, we've already done: config load, style resolve,
  // price refresh, management (trailing/BE/partial/structure), broker sync, telegram,
  // and pending order monitoring. Skip the full pair analysis loop.
  if (opts?.isManagementOnly) {
    const activeActions = managementActions.filter(a => a.action !== "no_change");
    console.log(`[manage ${scanCycleId}] Management-only complete: ${activeActions.length} actions, ${pendingFilled} fills, ${pendingExpired} expired`);
    return {
      pairsScanned: 0,
      signalsFound: 0,
      tradesPlaced: pendingFilled,
      mode: "management_only",
      managementActions: activeActions,
      pendingOrders: { filled: pendingFilled, expired: pendingExpired, cancelled: pendingCancelled, awaitingConfirmation: pendingConfirmationHunting },
      scanCycleId,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── PROP FIRM COMPLIANCE GATE (Gate 0) ──
  // Runs ONCE per scan cycle before any per-pair analysis.
  // Checks: daily loss limit, max drawdown, profit target.
  // If blocked: skips entire scan loop (saves API credits).
  // If shouldCloseAll: emergency-closes all open positions.
  // If size reduction: stores multiplier for lot sizing later.
  // ═══════════════════════════════════════════════════════════════════════════
  let propFirmGateResult: PropFirmGateResult | null = null;
  let propFirmSizeMultiplier = 1.0;
  try {
    // In live mode, use MetaAPI equity for prop-firm compliance. In paper mode,
    // keep the compliance calculation tied to the paper account taking trades.
    let brokerEquity: number | undefined;
    const isLiveMode = account.execution_mode === "live";
    // Only fetch broker equity in LIVE mode. In paper mode the prop firm gate
    // should track the paper balance — the MT5 account isn't the one taking trades.
    if (_scanBrokerConn && isLiveMode) {
      try {
        const metaAccountId = _scanBrokerConn.account_id;
        const authToken = _scanBrokerConn.api_key;
        // Use region-failover metaFetch — the legacy non-regional URL
        // (mt-client-api-v1.agiliumtrade.agiliumtrade.ai) has an expired TLS cert
        // and fails, which blocks all scans via the fail-closed prop firm gate.
        const { res: eqRes, body: eqBody } = await metaFetch(
          metaAccountId,
          authToken,
          (base) => `${base}/account-information`,
        );
        if (eqRes.ok) {
          const eqData = JSON.parse(eqBody);
          brokerEquity = parseFloat(eqData.equity ?? eqData.balance ?? "0");
          console.log(`[prop-firm-gate] Broker equity fetched: $${brokerEquity.toFixed(2)}`);
          await Promise.all([
            resolveScannerAlert(supabase, {
              userId,
              botId: BOT_ID,
              alertType: "metaapi_certificate_failure",
              dedupeKey: "metaapi",
            }),
            resolveScannerAlert(supabase, {
              userId,
              botId: BOT_ID,
              alertType: "metaapi_connection_failure",
              dedupeKey: "metaapi",
            }),
          ]);
        } else {
          console.warn(`[prop-firm-gate] Broker equity fetch returned ${eqRes.status}`);
          await upsertScannerAlert(supabase, {
            userId,
            botId: BOT_ID,
            alertType: "metaapi_connection_failure",
            dedupeKey: "metaapi",
            severity: "warning",
            title: "MetaAPI connection failure",
            message: `MetaAPI returned HTTP ${eqRes.status} while checking broker equity.`,
            runId: opts?.operationRunId,
            evidence: {
              source: "prop_firm_equity",
              http_status: eqRes.status,
            },
          });
        }
      } catch (e: any) {
        const brokerError = String(e?.message ?? e);
        const certificateFailure =
          /certificate|x509|expired|invalid peer/i.test(brokerError);
        console.warn(`[prop-firm-gate] Broker equity fetch failed (falling back to paper): ${brokerError}`);
        await upsertScannerAlert(supabase, {
          userId,
          botId: BOT_ID,
          alertType: certificateFailure
            ? "metaapi_certificate_failure"
            : "metaapi_connection_failure",
          dedupeKey: "metaapi",
          severity: certificateFailure ? "critical" : "warning",
          title: certificateFailure
            ? "MetaAPI certificate failure"
            : "MetaAPI connection failure",
          message: certificateFailure
            ? "MetaAPI certificate validation failed while checking broker equity."
            : "MetaAPI could not provide broker equity; the prop-firm gate used its safe fallback.",
          runId: opts?.operationRunId,
          evidence: {
            source: "prop_firm_equity",
            error: brokerError.slice(0, 500),
          },
        });
      }
    }
    propFirmGateResult = await runPropFirmGate(
      supabase, userId, BOT_ID, balance, openPosArr, scanCycleId,
      { brokerEquity, isLiveAccount: isLiveMode, hasBrokerConnection: isLiveMode && !!_scanBrokerConn, fxMarketClosed, rateMap },
    );

    if (propFirmGateResult.enabled) {
      propFirmSizeMultiplier = propFirmGateResult.maxPositionSizeMultiplier;

      // Emergency close-all
      if (propFirmGateResult.shouldCloseAll && openPosArr.length > 0) {
        console.log(`[prop-firm-gate] 🚨 EMERGENCY CLOSE-ALL triggered: ${propFirmGateResult.reason}`);
        const emergencyClose = await propFirmEmergencyClose(
          supabase, userId, BOT_ID, openPosArr, propFirmGateResult.reason, scanCycleId,
          { fxMarketClosed, rateMap },
        );
        // Notify via Telegram
        if (telegramChatIds.length > 0 && shouldNotify("prop_firm_alert")) {
          const pf: any = propFirmGateResult;
          const msg = `🚨 <b>PROP FIRM EMERGENCY</b>\n\n` +
            tgLine("Reason", pf.reason) +
            tgLine("Positions Closed", `${emergencyClose.closedCount}/${emergencyClose.attemptedCount}`) +
            tgLine("Account Mode", isLiveMode ? "LIVE" : "PAPER") +
            tgLine("Equity Used", brokerEquity != null ? `$${Number(brokerEquity).toFixed(2)} (broker)` : `$${Number(balance).toFixed(2)} (paper)`) +
            tgLine("Daily P&L", pf.dailyPnl != null ? `$${Number(pf.dailyPnl).toFixed(2)}` : null) +
            tgLine("Daily Loss Limit", pf.dailyLossLimit != null ? `$${Number(pf.dailyLossLimit).toFixed(2)}` : null) +
            tgLine("Total Drawdown", pf.totalDrawdown != null ? `$${Number(pf.totalDrawdown).toFixed(2)}` : null) +
            tgLine("Max Drawdown", pf.maxDrawdownLimit != null ? `$${Number(pf.maxDrawdownLimit).toFixed(2)}` : null) +
            tgLine("Size Multiplier", pf.maxPositionSizeMultiplier) +
            (emergencyClose.complete
              ? `\nAll managed exposure was confirmed closed.`
              : `\n${emergencyClose.unresolved.length} position(s) remain open pending exact broker-close proof.`);
          await Promise.all(telegramChatIds.map(async (chatId: string) => {
            try {
              await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-notify`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                body: JSON.stringify({ chat_id: chatId, message: msg }),
              });
            } catch {} // Non-fatal
          }));
        }
        // Return early — no new entries after emergency close
        const summaryPayload: any = {
          scan_cycle_id: scanCycleId,
          scanned_at: new Date().toISOString(),
          mode: "prop_firm_emergency",
          reason: propFirmGateResult.reason,
          positions_closed: emergencyClose.closedCount,
          positions_unresolved: emergencyClose.unresolved,
          complete: emergencyClose.complete,
        };
        await supabase.from("scan_history").insert({ user_id: userId, bot_id: BOT_ID, payload: summaryPayload });
        return new Response(JSON.stringify({
          ok: emergencyClose.complete,
          mode: "prop_firm_emergency",
          reason: propFirmGateResult.reason,
          positions_closed: emergencyClose.closedCount,
          positions_unresolved: emergencyClose.unresolved,
        }), {
          status: emergencyClose.complete ? 200 : 409,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Block new entries (soft lock / profit target reached)
      if (!propFirmGateResult.allowed) {
        console.log(`[prop-firm-gate] ⛔ New entries BLOCKED: ${propFirmGateResult.reason}`);
        const summaryPayload: any = {
          scan_cycle_id: scanCycleId,
          scanned_at: new Date().toISOString(),
          mode: "prop_firm_locked",
          reason: propFirmGateResult.reason,
          open_positions: openPosArr.length,
        };
        await supabase.from("scan_history").insert({ user_id: userId, bot_id: BOT_ID, payload: summaryPayload });
        return new Response(JSON.stringify({ ok: true, mode: "prop_firm_locked", reason: propFirmGateResult.reason }), { headers: { "Content-Type": "application/json" } });
      }

      // Size reduction warning
      if (propFirmSizeMultiplier < 1.0) {
        console.log(`[prop-firm-gate] ⚠️ Position size reduced to ${(propFirmSizeMultiplier * 100).toFixed(0)}%: ${propFirmGateResult.reason}`);
      }
    }
  } catch (e: any) {
    // Prop firm gate failure is NON-BLOCKING — we don't want a bug here to stop all trading
    console.warn(`[prop-firm-gate] Error (non-blocking): ${e?.message}`);
  }

  // ── Dynamic Scan Skip: management-only mode when max positions reached ──
  // Reads maxOpenPositions from live config each cycle — fully dynamic.
  // If positions close or config.maxOpenPositions increases, scanning resumes next cycle.
  // Note: openPosArr was already filtered to position_status="open" by the Supabase query (line 3607),
  // so .length IS the true open count. The redundant filter was removed to prevent edge-case miscount.
  const currentOpenCount = openPosArr.length;
  const maxOpen = parseInt(String(config.maxOpenPositions), 10) || 3;
  console.log(`[scan ${scanCycleId}] SCAN-STOP CHECK: ${currentOpenCount} open positions, maxOpen=${maxOpen}, config.maxOpenPositions=${config.maxOpenPositions} (type: ${typeof config.maxOpenPositions})`);
  if (currentOpenCount >= maxOpen) {
    console.log(`[scan ${scanCycleId}] MAX POSITIONS REACHED (${currentOpenCount}/${maxOpen}) — management only, skipping new entry scan. Saves API credits & compute.`);
    // Still ran: price refresh + management (trailing SL, break-even, partial TP, close-on-reverse, structure invalidation)
    // Skipped: per-pair candle fetch, SMC analysis, scoring, gate checks, new entry placement
    const summaryPayload: any = {
      scan_cycle_id: scanCycleId,
      scanned_at: new Date().toISOString(),
      mode: "management_only",
      reason: `Max positions reached (${currentOpenCount}/${maxOpen})`,
      open_positions: currentOpenCount,
      max_open_positions: maxOpen,
      management_actions: managementActions?.filter((a: any) => a.action !== "none").length || 0,
      scan_details: [],
    };
    await supabase.from("scan_history").insert({ user_id: userId, bot_id: BOT_ID, payload: summaryPayload });
    return new Response(JSON.stringify({ ok: true, mode: "management_only", reason: summaryPayload.reason, management_actions: summaryPayload.management_actions }), { headers: { "Content-Type": "application/json" } });
  }
  console.log(`[scan ${scanCycleId}] Positions: ${currentOpenCount}/${maxOpen} — room for ${maxOpen - currentOpenCount} new entries, proceeding with full scan`);

  // ═══════════════════════════════════════════════════════════════════════════
  // ── Conflict counter thresholds (configurable via bot config) ──
  // Declared here (function scope) so they're accessible in both game plan and scoring sections.
  const conflictThresholdRaise = Number((config as any).conflictThresholdRaise) || 4; // raise threshold when N+ factors oppose
  const conflictBlockAt = Number((config as any).conflictBlockAt) || 6; // hard block when N+ factors oppose

  // Select eight discovery pairs before Gameplan and candle fetching.
  // Lifecycle-owned pairs are monitored separately and do not consume slots.
  const fullInstrumentUniverse = [...config.instruments];
  const rotatingImpulseSlotCount = Math.max(1, Math.min(12, Number((config as any).rotatingImpulseSlotCount) || 8));
  const rotatingImpulseScanEnabled = (config as any).rotatingImpulseScanEnabled !== false && fullInstrumentUniverse.length > rotatingImpulseSlotCount;
  let rotationSelection: RotationSelection | null = null;
  let sessionRotationObservation: SessionRotationObservation | null = null;
  let discoveryScanUniverse = fullInstrumentUniverse;
  let scanUniverse = fullInstrumentUniverse;
  const lifecycleOwnedSymbols = new Set<string>([
    ...activeStagedSetups
      .filter((setup: any) => setup.execution_eligible !== false && setup.originating_zone)
      .map((setup: any) => setup.symbol),
    ...(activePendingOrders || []).map((order: any) => order.symbol),
    ...openPosArr.map((position: any) => position.symbol),
  ]);
  if (rotatingImpulseScanEnabled) {
    const rotationState = await loadRotatingImpulseState(supabase, userId, BOT_ID);
    rotationSelection = selectRotatingImpulseUniverse(
      fullInstrumentUniverse,
      rotatingImpulseSlotCount,
      rotationState,
      new Date().toISOString(),
      lifecycleOwnedSymbols,
    );
    discoveryScanUniverse = rotationSelection.selected;
    scanUniverse = Array.from(new Set([
      ...discoveryScanUniverse,
      ...Array.from(lifecycleDeepScanSymbols),
    ])).filter((symbol) => fullInstrumentUniverse.includes(symbol));
    console.log(
      `[scan ${scanCycleId}] Two-lane Impulse scan: discovery=${discoveryScanUniverse.length}/${fullInstrumentUniverse.length}, lifecycle=${scanUniverse.length - discoveryScanUniverse.length}; discovery=[${discoveryScanUniverse.join(", ")}], near-zone=[${Array.from(lifecycleDeepScanSymbols).join(", ")}]`,
    );
  }

  // ── GAME PLAN: consume the dedicated active version ──
  // game-plan-refresh is the only live generator and persistence owner. A
  // missing, stale, or wrong-scope plan must never delay the trading scan.
  let activeGamePlan: SessionGamePlan | null = null;
  if (gamePlanEnabled) {
    try {
      const currentSessionName = getCurrentSession();
      const gamePlanMarketScope = resolveGamePlanMarketScope(
        fullInstrumentUniverse,
        now,
      );
      const lastGP = _lastGamePlanForValidation;
      const reuseDecision = evaluateGamePlanReuse(lastGP, {
        session: currentSessionName,
        style: scanStylePolicy.style,
      });
      const lastPlanMatchesMarketScope = lastGP
        ? gamePlanSymbolsMatchScope(
          lastGP.plans.map((plan) => plan.symbol),
          gamePlanMarketScope,
        )
        : false;

      if (reuseDecision.reusable && lastGP && lastPlanMatchesMarketScope) {
        activeGamePlan = lastGP;
        console.log(
          `[scan ${scanCycleId}] Game Plan: consuming active version ${lastGP.planVersion}`,
        );
      } else {
        const unavailableReason = !lastGP
          ? "missing_active_plan"
          : !lastPlanMatchesMarketScope
          ? "market_scope_changed"
          : reuseDecision.reason;
        console.warn(
          `[scan ${scanCycleId}] Game Plan unavailable for consumption (${unavailableReason}); pair scanning continues and game-plan-refresh remains the sole live generator`,
        );
      }
    } catch (error: any) {
      activeGamePlan = null;
      console.warn(
        `[scan ${scanCycleId}] Game Plan consumer validation failed (${error?.message}); pair scanning continues`,
      );
    }
  }

  // ── Session-aware discovery priority observation ──
  // Compare the existing least-recently-scanned universe with a proposal that
  // reuses the canonical session, session-affinity, style, Gameplan, and
  // lifecycle ownership. It is deliberately calculated after Gameplan loads,
  // but it cannot replace discoveryScanUniverse/scanUniverse/scanOrder and it
  // performs no candle or live-price fetches.
  if (rotationSelection) {
    const observationBase = {
      contract: SESSION_AWARE_ROTATION_OBSERVATION_CONTRACT,
      mode: "observe" as const,
      affectsExecution: false as const,
      additionalMarketDataCalls: 0 as const,
      capturedAt: now.toISOString(),
      style: scanStylePolicy.style,
      session: cachedSession,
      enabledSessionKeys: [...config.enabledSessions],
      restrictedAssetSessionGateOpen,
      offHoursImplicitlyAllowed,
      actual: [...discoveryScanUniverse],
      lifecycleExcludedSymbols: Array.from(lifecycleOwnedSymbols),
    };
    try {
      const gamePlanFocusSymbols = gamePlanAffectsExecution
        ? activeGamePlan?.focusPairs || []
        : [];
      const proposedRotationSelection = selectRotatingImpulseUniverse(
        fullInstrumentUniverse,
        rotatingImpulseSlotCount,
        rotationSelection.state,
        now.toISOString(),
        lifecycleOwnedSymbols,
        {
          style: scanStylePolicy.style,
          session: cachedSession,
          atMs: now.getTime(),
          focusSymbols: gamePlanFocusSymbols,
        },
      );
      const actualSet = new Set(discoveryScanUniverse);
      const proposedSet = new Set(proposedRotationSelection.selected);
      const overlap = discoveryScanUniverse.filter((symbol) => proposedSet.has(symbol));
      sessionRotationObservation = {
        ...observationBase,
        status: "ready",
        gamePlanFocusApplied: gamePlanAffectsExecution,
        gamePlanFocusSymbols,
        proposed: [...proposedRotationSelection.selected],
        overlap,
        overlapCount: overlap.length,
        overlapPercent: discoveryScanUniverse.length > 0
          ? Math.round((overlap.length / discoveryScanUniverse.length) * 1000) / 10
          : 100,
        wouldPromote: proposedRotationSelection.selected.filter((symbol) =>
          !actualSet.has(symbol)
        ),
        wouldDefer: discoveryScanUniverse.filter((symbol) => !proposedSet.has(symbol)),
        preferredCapacity: proposedRotationSelection.priority?.preferredCapacity || 0,
        preferredSelected: proposedRotationSelection.priority?.preferredSelected || 0,
        fairnessSelected: proposedRotationSelection.priority?.fairnessSelected || 0,
        selection: proposedRotationSelection.priority?.selected || [],
      };
      console.log(
        `[scan ${scanCycleId}] Session-aware rotation observation: ${overlap.length}/${discoveryScanUniverse.length} actual slots matched; proposed=[${proposedRotationSelection.selected.join(", ")}], actual=[${discoveryScanUniverse.join(", ")}]`,
      );
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      sessionRotationObservation = {
        ...observationBase,
        status: "unavailable",
        unavailableReason: reason,
      };
      console.warn(
        `[scan ${scanCycleId}] Session-aware rotation observation unavailable (non-fatal): ${reason}`,
      );
    }
  }

  // ── Phase 6: Focus Pair Priority ──
  // Reorder instruments so game-plan focus pairs are scanned first.
  // When max positions are limited, this gives focus pairs first shot at available slots.
  // Non-focus pairs are still scanned if capacity remains.
  let scanOrder = [...scanUniverse];
  if (gamePlanAffectsExecution && activeGamePlan?.focusPairs?.length) {
    const focusSet = new Set(activeGamePlan.focusPairs);
    const focusPairs = scanOrder.filter(p => focusSet.has(p));
    const nonFocusPairs = scanOrder.filter(p => !focusSet.has(p));
    scanOrder = [...focusPairs, ...nonFocusPairs];
    console.log(`[scan ${scanCycleId}] Focus pair priority: ${focusPairs.length} focus pairs scanned first: [${focusPairs.join(", ")}]`);
  }

  // ── Persistent Candle Cache: pre-warm daily/weekly from kv_cache ──
  // Daily candles change once/day, weekly once/week. Loading from DB saves
  // ~34 TwelveData API calls per cycle, keeping us within the 50/min limit.
  const cacheableRequests: Array<{ symbol: string; interval: string }> = [];
  // Observation-only Phase 1 per-timeframe evidence for this scan cycle.
  // Collected per pair, written in bounded awaited chunks after the loop.
  const zoneEvidenceRows: EvidenceRow[] = [];
  const candleSnapshotRows: any[] = [];
  for (const pair of scanOrder) {
    if (!SUPPORTED_SYMBOLS[pair]) continue;
    cacheableRequests.push({ symbol: pair, interval: "1d" });
    if ((config as any).ictHTFEnabled !== false) cacheableRequests.push({ symbol: pair, interval: "1w" });
  }
  const persistentCache = await batchGetCachedCandles(supabase, cacheableRequests);
  // Inject cached candles into the scan-cycle dataCache so cachedFetch() finds them
  let persistentCacheHits = 0;
  for (const [mapKey, candles] of persistentCache.entries()) {
    const [sym, interval] = mapKey.split(":");
    if (sym && interval && candles.length >= 30) {
      // Directly seed the scanCache so cachedFetch won't re-fetch from API
      scanCache.seed(sym, interval, candles, "kv_cache");
      persistentCacheHits++;
    }
  }
  if (persistentCacheHits > 0) {
    console.log(`[scan ${scanCycleId}] Persistent candle cache: ${persistentCacheHits}/${cacheableRequests.length} pre-warmed from DB`);
  }

  // Track which daily/weekly candles were freshly fetched (to persist after scan)
  const freshlyFetchedCandles: Array<{ symbol: string; interval: string; candles: Candle[] }> = [];

  // ── Hand-marked impulses ──
  // An active marking OVERRIDES automatic impulse detection for its symbol. It
  // bypasses nothing else: every gate still runs, and the Direction Verdict may
  // still veto. Loaded once per cycle rather than per pair.
  const manualImpulseBySymbol = new Map<string, any>();
  const manualImpulseRetirements: Promise<void>[] = [];
  try {
    const { data: markings } = await supabase.from("manual_impulses")
      .select("id,symbol,direction,high,low,timeframe,expires_at,high_time,low_time")
      .eq("user_id", userId).eq("bot_id", BOT_ID).eq("status", "active")
      .gt("expires_at", new Date().toISOString());
    for (const row of markings || []) manualImpulseBySymbol.set(row.symbol, row);
    if (manualImpulseBySymbol.size > 0) {
      console.log(`[scan ${scanCycleId}] manual impulses active: ${[...manualImpulseBySymbol.keys()].join(", ")}`);
    }
  } catch (e: any) {
    console.warn(`[scan ${scanCycleId}] manual impulse load failed (non-fatal): ${e?.message}`);
  }

  /** Retire a marking the market has moved past, so the UI can say why. */
  const retireManualImpulse = async (id: string, reason: string, detail: string): Promise<void> => {
    try {
      await supabase.from("manual_impulses").update({
        status: reason === "origin_already_broken" ? "invalidated" : "cancelled",
        resolution_reason: reason,
        last_resolution_detail: detail,
        last_resolved_at: new Date().toISOString(),
      }).eq("id", id);
    } catch (e: any) {
      console.warn(`[scan ${scanCycleId}] could not retire manual impulse ${id}: ${e?.message}`);
    }
  };

  await markScannerOperation(
    supabase,
    opts?.operationRunId,
    "pair_processing_started",
    {
      status: "running",
      expected_pairs: scanOrder.length,
      processed_pairs: 0,
    },
  );

  for (let pairIndex = 0; pairIndex < scanOrder.length; pairIndex++) {
    const pair = scanOrder[pairIndex];
    await markScannerOperation(
      supabase,
      opts?.operationRunId,
      "pair_processing",
      {
        status: "running",
        expected_pairs: scanOrder.length,
        processed_pairs: pairIndex,
        metadata: { current_pair: pair },
      },
    );
    if (scanLockToken) {
      await heartbeatScannerLock(supabase, {
        userId,
        botId: BOT_ID,
        token: scanLockToken,
      });
    }
    if (!SUPPORTED_SYMBOLS[pair]) {
      scanDetails.push({ pair, status: "skipped", reason: "No data source" });
      continue;
    }

    // Per-instrument session gate check (Fix #7)
    // Fix: When current time falls in "Off-Hours" gap (e.g. 16:00-17:00 NY between NY close
    // and Sydney open), allow scanning if user has all 3 core sessions enabled — their intent
    // is clearly 24/5 scanning and the gap is an artefact of non-overlapping session windows.
    const pairAssetProfile = getAssetProfile(pair);
    // Session gate: empty enabledSessions = NOTHING enabled (bot pauses).
    // Off-hours is implicitly allowed when all 3 core sessions are enabled (user wants 24/5).
    if (!pairAssetProfile.skipSessionGate && !restrictedAssetSessionGateOpen) {
      scanDetails.push({ pair, status: "skipped", reason: `${session.name} session not enabled for ${pair}` });
      continue;
    }

    // Skip non-crypto instruments on weekends (Fri 17:00 ET → Sun 17:00 ET).
    // BUG FIX: use nyDay (NY local day) instead of utcDay to avoid UTC/NY day mismatch
    // e.g. Thursday 9PM NY = Friday 01:00 UTC → utcDay was 5 (Fri), triggering false weekend close
    const fxIsClosed = (nyDay === 6) || (nyDay === 0 && nyHour < 17) || (nyDay === 5 && nyHour >= 17);
    if (fxIsClosed && SPECS[pair]?.type !== "crypto") {
      scanDetails.push({ pair, status: "skipped", reason: "FX market closed (weekend)" });
      continue;
    }

    // Delay between instruments to stay within TwelveData rate limits.
    // Each instrument fetches 3-5 candle sets in parallel, so spacing
    // instruments 1.5s apart keeps us at ~2-3 req/s = well under 50/min.
    // (Increased from 1s after persistent cache reduced daily/weekly fetches.)
    if (scanDetails.length > 0) await new Promise(r => setTimeout(r, 1500));

    // Clone config per-instrument to prevent style mutation (Fix #6)
    let pairConfig = { ...config };
    // Apply per-pair gate overrides (if configured for this symbol)
    applyPairOverrides(pairConfig, pair);
    const singleOwnershipEnforcementRequested =
      ["enforce", "enforce_live"].includes((pairConfig as any).singleOwnershipMode);
    const pairRuntimeConfigSnapshot = await buildFrozenRuntimeConfigSnapshot(
      styleResolution,
      pairConfig,
    );

    // Determine entry TF based on style
    const entryInterval = getEntryInterval(pairConfig.entryTimeframe);
    const entryRange = getEntryRange(pairConfig.entryTimeframe);

    // Fetch the exact policy-authoritative structural timeframes plus the
    // legacy datasets still consumed by non-style-aware modules.
    const smtPair = pairConfig.useSMT !== false ? SMT_PAIRS[pair] : undefined;
    const smtFlag = smtPair && SUPPORTED_SYMBOLS[smtPair] ? 1 : 0;
    const multiTFRegimeEnabled = (pairConfig as any).multiTFRegimeEnabled !== false; // ON by default
    const needsWeekly = timeframeAuthority.requiredStructuralTimeframes.includes("1w") ||
      pairConfig.ictHTFEnabled !== false;
    const needsMonthly = !!config.smcEnhancements?.enableMonthlyContainment;
    const requiredIntervals = new Map<string, string>();
    const requireInterval = (interval: string, range: string) => {
      if (!requiredIntervals.has(interval)) requiredIntervals.set(interval, range);
    };
    requireInterval(entryInterval, entryRange);
    requireInterval(
      timeframeAuthority.roles.confirmation,
      timeframeFetchRange(timeframeAuthority.roles.confirmation),
    );
    requireInterval(
      timeframeAuthority.roles.refinement,
      timeframeFetchRange(timeframeAuthority.roles.refinement),
    );
    requireInterval("1d", "1y");
    requireInterval("1h", "5d");
    if (
      multiTFRegimeEnabled ||
      timeframeAuthority.requiredStructuralTimeframes.includes("4h")
    ) {
      requireInterval("4h", "1mo");
    }
    for (const timeframe of timeframeAuthority.requiredStructuralTimeframes) {
      requireInterval(timeframe, timeframeFetchRange(timeframe));
    }
    if (needsWeekly) requireInterval("1w", "1y");
    if (needsMonthly) requireInterval("1M", "5y");

    const requestEntries = Array.from(requiredIntervals.entries());
    const smtPromise = smtFlag
      ? cachedFetch(smtPair!, entryInterval, entryRange)
      : Promise.resolve([] as Candle[]);
    const fetched = await Promise.all([
      ...requestEntries.map(([interval, range]) =>
        cachedFetch(pair, interval, range)
      ),
      smtPromise,
    ]);
    const fetchedByInterval = new Map<string, Candle[]>();
    requestEntries.forEach(([interval], index) => {
      fetchedByInterval.set(interval, fetched[index] || []);
    });

    for (const [timeframe, timeframeCandles] of fetchedByInterval.entries()) {
      const bounded = timeframeCandles.slice(-500);
      if (bounded.length === 0) continue;
      candleSnapshotRows.push({
        user_id: userId, bot_id: BOT_ID, scan_cycle_id: scanCycleId, symbol: pair, timeframe,
        provider: _scanCandleSources.get(`|`) || (persistentCache.has(`:`) ? "kv_cache" : "scan_cache"),
        observed_at: scanStartedAt,
        completed_candle_cutoff: bounded[bounded.length - 1]?.datetime || null,
        candle_count: bounded.length,
        candles: bounded.map((c: Candle) => ({ datetime: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? null })),
      });
    }

    const candles = fetchedByInterval.get(entryInterval) || [];
    const dailyCandles = fetchedByInterval.get("1d") || [];
    const h4Candles = fetchedByInterval.get("4h") || [];
    const hourlyCandles = fetchedByInterval.get("1h") || [];
    const m15Candles = fetchedByInterval.get("15m") || [];
    const smtCandles = smtFlag ? fetched[requestEntries.length] : null;
    const weeklyCandles = needsWeekly
      ? fetchedByInterval.get("1w") || null
      : null;
    const monthlyCandles = needsMonthly
      ? fetchedByInterval.get("1M") || null
      : null;
    // Legacy alias for ICT HTF active check (used downstream)
    const ictHTFActive = pairConfig.ictHTFEnabled !== false;

    if (candles.length < 30) {
      scanDetails.push({ pair, status: "skipped", reason: "Insufficient data" });
      continue;
    }

    // Track freshly-fetched daily/weekly candles for persistent cache write-back
    if (dailyCandles.length >= 30 && !persistentCache.has(`${pair}:1d`)) {
      freshlyFetchedCandles.push({ symbol: pair, interval: "1d", candles: dailyCandles });
    }
    if (weeklyCandles && weeklyCandles.length >= 30 && !persistentCache.has(`${pair}:1w`)) {
      freshlyFetchedCandles.push({ symbol: pair, interval: "1w", candles: weeklyCandles });
    }

    // Apply asset-class profile adjustments
    const pairAssetProfileInner = getAssetProfile(pair);
    // Per-instrument SL buffer override: if set, use it directly (no multiplier).
    // Otherwise fall back to global slBufferPips × asset-class multiplier.
    const symbolBufferOverride = pairConfig.instrumentBuffers?.[pair]?.slBufferPips;
    const adjustedSlBuffer = symbolBufferOverride != null
      ? symbolBufferOverride
      : pairConfig.slBufferPips * pairAssetProfileInner.slBufferMultiplier;
    const adjustedMinConfluence = Math.max(1, pairConfig.minConfluence + pairAssetProfileInner.minConfluenceAdj);
    const pairStylePolicy = await buildResolvedStylePolicy({
      resolution: styleResolution,
      config: {
        ...pairConfig,
        slBufferPips: adjustedSlBuffer,
      },
      baseConfig: config,
      symbol: pair,
      effectiveMinConfluence: adjustedMinConfluence,
    });
    const roleCandles = bindTimeframeCandles(
      timeframeAuthority,
      buildTimeframeCandleMap<Candle>([
        ...requestEntries.map(([timeframe]) => ({
          timeframe,
          candles: fetchedByInterval.get(timeframe) || [],
        })),
        { timeframe: entryInterval, candles },
        { timeframe: "15m", candles: m15Candles },
        { timeframe: "1h", candles: hourlyCandles },
        { timeframe: "4h", candles: h4Candles },
        { timeframe: "1d", candles: dailyCandles },
        { timeframe: "1w", candles: weeklyCandles },
      ]),
    );
    const pairDecisionEvidence: StyleDecisionEvidence =
      buildStyleDecisionEvidence(timeframeAuthority, roleCandles, {
        h4ChochLookback: pairConfig.simpleDirectionH4ChochLookback,
        h1BosLookback: pairConfig.simpleDirectionH1BosLookback,
        confirmedTrendFibFactor: pairConfig.confirmedTrendFibFactor,
        confirmedTrendSwingLookback:
          pairConfig.confirmedTrendSwingLookback,
        useConfirmedTrend: pairConfig.useConfirmedTrend,
      });
    const canonicalStructureAuthority = buildCanonicalStructureAuthority(
      roleCandles.structure,
      { symbol: pair, timeframe: timeframeAuthority.roles.structure },
    );
    const canonicalConfirmationStructure = buildCanonicalStructureAuthority(
      roleCandles.confirmation,
      { symbol: pair, timeframe: timeframeAuthority.roles.confirmation },
    );
    const canonicalLiquiditySequence = buildCanonicalLiquiditySequences(
      canonicalConfirmationStructure,
    );

    // Pass current symbol so SL calc uses correct pip size (Fix #3)
    pairConfig._currentSymbol = pair;
    // Compute SMT divergence vs correlated pair (if available) and inject into config
    pairConfig._smtResult = smtCandles ? detectSMTDivergence(pair, candles, smtCandles) : null;
    // Inject FOTSI result for Factor 18 (Currency Strength)
    (pairConfig as any)._fotsiResult = _fotsiResult;
    // Inject 4H candles for multi-TF regime classification
    (pairConfig as any)._h4Candles = h4Candles.length >= 20 ? h4Candles : null;

    // ── HTF POI Detection (Phase 1: FVGs, OBs, Breakers on 4H + 1H) ──
    // Run structure detection on HTF candles and inject results for scoring boost.
    console.log(`[scan ${scanCycleId}] ${pair} HTF candles: 4H=${h4Candles.length}, 1H=${hourlyCandles.length}`);
    const htfPOIs: { timeframe: string; type: "fvg" | "ob" | "breaker"; high: number; low: number; direction: "bullish" | "bearish" }[] = [];
    let h4FVGs: any[] = [];
    let h4OBs: any[] = [];
    let h4Breakers: any[] = [];
    if (h4Candles.length >= 20) {
      const h4Structure = analyzeMarketStructure(h4Candles);
      const h4StructureBreaks = [...h4Structure.bos, ...h4Structure.choch];
      h4FVGs = detectFVGs(h4Candles, h4StructureBreaks);
      h4OBs = detectOrderBlocks(h4Candles, h4StructureBreaks);
      h4Breakers = detectBreakerBlocks(h4OBs, h4Candles, h4StructureBreaks);
      for (const fvg of h4FVGs) {
        if (fvg.state !== "filled" && (fvg.quality ?? 0) >= 3) {
          htfPOIs.push({ timeframe: "4H", type: "fvg", high: fvg.high, low: fvg.low, direction: fvg.type });
        }
      }
      for (const ob of h4OBs) {
        if (ob.state !== "broken" && ob.state !== "mitigated") {
          htfPOIs.push({ timeframe: "4H", type: "ob", high: ob.high, low: ob.low, direction: ob.type });
        }
      }
      for (const bb of h4Breakers) {
        if (bb.isActive && bb.state !== "broken") {
          htfPOIs.push({ timeframe: "4H", type: "breaker", high: bb.high, low: bb.low, direction: bb.type === "bullish_breaker" ? "bullish" : "bearish" });
        }
      }
    }
    if (hourlyCandles.length >= 20) {
      const h1Structure = analyzeMarketStructure(hourlyCandles);
      const h1StructureBreaks = [...h1Structure.bos, ...h1Structure.choch];
      const h1FVGs = detectFVGs(hourlyCandles, h1StructureBreaks);
      const h1OBs = detectOrderBlocks(hourlyCandles, h1StructureBreaks);
      const h1Breakers = detectBreakerBlocks(h1OBs, hourlyCandles, h1StructureBreaks);
      for (const fvg of h1FVGs) {
        if (fvg.state !== "filled" && (fvg.quality ?? 0) >= 3) {
          htfPOIs.push({ timeframe: "1H", type: "fvg", high: fvg.high, low: fvg.low, direction: fvg.type });
        }
      }
      for (const ob of h1OBs) {
        if (ob.state !== "broken" && ob.state !== "mitigated") {
          htfPOIs.push({ timeframe: "1H", type: "ob", high: ob.high, low: ob.low, direction: ob.type });
        }
      }
      for (const bb of h1Breakers) {
        if (bb.isActive && bb.state !== "broken") {
          htfPOIs.push({ timeframe: "1H", type: "breaker", high: bb.high, low: bb.low, direction: bb.type === "bullish_breaker" ? "bullish" : "bearish" });
        }
      }
    }
    // ── Daily POI Detection ──
    // Daily candles have fewer structure breaks, so quality threshold is lower (>= 2 vs >= 3 for intraday).
    // The BOOST_MAP already assigns highest weights to "D" timeframe (fvg: 1.0, ob: 0.8, breaker: 0.6).
    let dFVGs: any[] = [];
    let dOBs: any[] = [];
    let dBreakers: any[] = [];
    if (dailyCandles.length >= 10) {
      const dStructure = analyzeMarketStructure(dailyCandles);
      const dStructureBreaks = [...dStructure.bos, ...dStructure.choch];
      dFVGs = detectFVGs(dailyCandles, dStructureBreaks);
      dOBs = detectOrderBlocks(dailyCandles, dStructureBreaks);
      dBreakers = detectBreakerBlocks(dOBs, dailyCandles, dStructureBreaks);
      for (const fvg of dFVGs) {
        if (fvg.state !== "filled" && (fvg.quality ?? 0) >= 2) {
          htfPOIs.push({ timeframe: "D", type: "fvg", high: fvg.high, low: fvg.low, direction: fvg.type });
        }
      }
      for (const ob of dOBs) {
        if (ob.state !== "broken" && ob.state !== "mitigated") {
          htfPOIs.push({ timeframe: "D", type: "ob", high: ob.high, low: ob.low, direction: ob.type });
        }
      }
      for (const bb of dBreakers) {
        if (bb.isActive && bb.state !== "broken") {
          htfPOIs.push({ timeframe: "D", type: "breaker", high: bb.high, low: bb.low, direction: bb.type === "bullish_breaker" ? "bullish" : "bearish" });
        }
      }
    }
    // Inject HTF POIs for confluence scoring boost
    console.log(`[scan ${scanCycleId}] ${pair} HTF POIs found: ${htfPOIs.length} (D: ${htfPOIs.filter(p => p.timeframe === "D").length}, 4H: ${htfPOIs.filter(p => p.timeframe === "4H").length}, 1H: ${htfPOIs.filter(p => p.timeframe === "1H").length})`);
    (pairConfig as any)._htfPOIs = htfPOIs.length > 0 ? htfPOIs : null;

    // ── HTF Phase 2: Fibonacci, Premium/Discount, Liquidity Pools on D + 4H + 1H ──
    // Run Fib, PD, and Liquidity detection on HTF candles for multi-TF scoring.
    let htfFibLevelsD: any = null;
    let htfFibLevels4H: any = null;
    let htfFibLevels1H: any = null;
    let htfPDD: any = null;
    let htfPD4H: any = null;
    let htfPD1H: any = null;
    let htfLiquidityPoolsD: LiquidityPool[] = [];
    let htfLiquidityPools4H: LiquidityPool[] = [];
    let htfLiquidityPools1H: LiquidityPool[] = [];

    // Liquidity-pool sensitivity (hoisted so all three TF blocks below can use them)
    const liqSens = pairConfig.equalHighsLowsSensitivity ?? 3;
    const liqTolBase = [0.10, 0.15, 0.20, 0.25, 0.30][Math.min(Math.max(liqSens, 1), 5) - 1];
    const liqMinTouches = pairConfig.liquidityPoolMinTouches ?? 2;

    if (dailyCandles.length >= 10) {
      // Daily Fibonacci: ZigZag pivots → Fib levels
      const dZigzag = detectZigZagPivots(dailyCandles, 5, 20);
      if (dZigzag.lastTwo) {
        htfFibLevelsD = computeFibLevels(dZigzag.lastTwo[0], dZigzag.lastTwo[1]);
      }
      // Daily Premium/Discount zone
      htfPDD = calculatePremiumDiscount(dailyCandles);
      // Daily Liquidity Pools — sensitivity-driven tolerance + TF bump for daily
      htfLiquidityPoolsD = detectLiquidityPools(dailyCandles, Math.min(liqTolBase + 0.10, 0.40), liqMinTouches);
    }

    if (h4Candles.length >= 20) {
      // 4H Fibonacci: ZigZag pivots → Fib levels
      const h4Zigzag = detectZigZagPivots(h4Candles, 3, 10);
      if (h4Zigzag.lastTwo) {
        htfFibLevels4H = computeFibLevels(h4Zigzag.lastTwo[0], h4Zigzag.lastTwo[1]);
      }
      // 4H Premium/Discount zone
      htfPD4H = calculatePremiumDiscount(h4Candles);
      // 4H Liquidity Pools — sensitivity base + 0.05 bump for 4H
      htfLiquidityPools4H = detectLiquidityPools(h4Candles, Math.min(liqTolBase + 0.05, 0.35), liqMinTouches);
    }

    if (hourlyCandles.length >= 20) {
      // 1H Fibonacci: ZigZag pivots → Fib levels
      const h1Zigzag = detectZigZagPivots(hourlyCandles, 3, 10);
      if (h1Zigzag.lastTwo) {
        htfFibLevels1H = computeFibLevels(h1Zigzag.lastTwo[0], h1Zigzag.lastTwo[1]);
      }
      // 1H Premium/Discount zone
      htfPD1H = calculatePremiumDiscount(hourlyCandles);
      // 1H Liquidity Pools — sensitivity base (no bump for 1H)
      htfLiquidityPools1H = detectLiquidityPools(hourlyCandles, liqTolBase, liqMinTouches);
    }

    // Inject HTF Phase 2 data for confluence scoring
    console.log(`[scan ${scanCycleId}] ${pair} HTF Phase 2: FibD=${htfFibLevelsD ? "yes" : "no"}, Fib4H=${htfFibLevels4H ? "yes" : "no"}, Fib1H=${htfFibLevels1H ? "yes" : "no"}, PDD=${htfPDD?.currentZone ?? "none"}, PD4H=${htfPD4H?.currentZone ?? "none"}, PD1H=${htfPD1H?.currentZone ?? "none"}, LiqD=${htfLiquidityPoolsD.length}, Liq4H=${htfLiquidityPools4H.length}, Liq1H=${htfLiquidityPools1H.length}`);
    (pairConfig as any)._htfFibLevels = { d: htfFibLevelsD, h4: htfFibLevels4H, h1: htfFibLevels1H };
    (pairConfig as any)._htfPD = { d: htfPDD, h4: htfPD4H, h1: htfPD1H };
    (pairConfig as any)._htfLiquidityPools = { d: htfLiquidityPoolsD, h4: htfLiquidityPools4H, h1: htfLiquidityPools1H };

    // ── Simple Direction Engine (opt-in via useSimpleDirection toggle) ──
    // Uses the same immutable evidence snapshot as GP, DV and thesis.
    let simpleDirectionResult: DirectionResult | null = null;
    if (pairConfig.useSimpleDirection) {
      try {
        const evidenceDirection = pairDecisionEvidence.simpleDirection;
        simpleDirectionResult = evidenceDirection;

        console.log(`[scan ${scanCycleId}] ${pair} SimpleDirection(${resolvedStyle}): ${evidenceDirection.direction ?? "null"} | bias=${evidenceDirection.bias}(${evidenceDirection.biasSource}) | struct-retrace=${evidenceDirection.h4Retrace} | struct-choch-against=${evidenceDirection.h4ChochAgainst} | confirm-bos=${evidenceDirection.h1Confirmed} | ${evidenceDirection.reason}`);
        // Pass override direction to confluenceScoring
        if (evidenceDirection.direction !== null) {
          (pairConfig as any)._overrideDirection = evidenceDirection.direction;
        } else {
          // No direction = skip this pair (direction engine says no trade)
          (pairConfig as any)._overrideDirection = null; // explicit null = force no-direction
        }
      } catch (err) {
        console.warn(`[scan ${scanCycleId}] ${pair} SimpleDirection error (falling back to old logic):`, err);
        // On error, don't set override — old logic runs as fallback
      }
    }

    // ── Game Plan Context Injection ──
    // Pass the per-instrument game plan data into the confluence engine so it can
    // use bias, DOL, key levels, and focus-pair status for scoring and TP placement.
    // The game plan is generated once per session (Layer 2) and consumed here (Layer 3).
    if (activeGamePlan && gamePlanAffectsExecution) {
      const pairPlan = activeGamePlan.plans.find((p: InstrumentGamePlan) => p.symbol === pair) || null;
      (pairConfig as any)._gamePlanContext = pairPlan ? {
        bias: pairPlan.bias,
        biasConfidence: pairPlan.biasConfidence,
        dol: pairPlan.dol,
        keyLevels: pairPlan.keyLevels,
        regime: pairPlan.regime,
        htfTrend: pairPlan.htfTrend,
        h4Trend: pairPlan.h4Trend,
        tradeable: pairPlan.tradeable,
        atr: pairPlan.atr,
        isFocusPair: activeGamePlan.focusPairs.includes(pair),
      } : null;
     } else {
      (pairConfig as any)._gamePlanContext = null;
     }
    // Pass DOL TP extension toggle into pairConfig for confluenceScoring to read
    (pairConfig as any).dolTPExtensionEnabled = (config as any).dolTPExtensionEnabled !== false;
    const analysis: ReturnType<typeof runConfluenceAnalysis> & {
      _canonicalDealingRangeAvailable?: boolean;
      _canonicalDealingRangeEvaluation?: ReturnType<
        typeof evaluateCanonicalDealingRange
      >;
    } = runConfluenceAnalysis(candles, dailyCandles.length >= 10 ? dailyCandles : null, pairConfig, hourlyCandles.length > 0 ? hourlyCandles : undefined);
    // S3 Fix: Attach the scan-cycle cached session to analysis for downstream use
    (analysis as any).cachedSession = cachedSession;

    // ── Setup Classifier: determine scalp/day/swing from the actual setup structure (informational only) ──
    const setupClassification = classifySetupType(analysis);

    const detail: any = {
      pair,
      canonicalStructureAuthority,
      canonicalConfirmationStructure,
      canonicalLiquiditySequence,
      crossTimeframeAuthority,
      score: analysis.score,
      direction: analysis.direction,
      trend: analysis.structure.trend,
      zone: analysis.pd.currentZone,
      zonePercent: analysis.pd.zonePercent,
      session: analysis.session.name,
      killZone: analysis.session.isKillZone,
      bias: analysis.bias,
      summary: analysis.summary,
      factorCount: analysis.factors.filter(f => f.present).length,
      strongFactorCount: analysis.strongFactorCount || 0,
      enabledMax: analysis.enabledMax || 0,
      factors: analysis.factors,
      // ── analysis_snapshot: per-factor + new-factor breakdown for dashboard ──
      tieredScoring: analysis.tieredScoring || null,
      analysis_snapshot: {
        factorScores: analysis.factors.map((f: any) => ({ name: f.name, weight: f.weight, present: f.present, detail: f.detail, tier: (f as any).tier })),
        displacement: analysis.displacement ? { isDisplacement: analysis.displacement.isDisplacement, lastDirection: analysis.displacement.lastDirection } : null,
        breakerBlocks: (analysis.breakerBlocks || []).length,
        unicornSetups: (analysis.unicornSetups || []).length,
        silverBullet: analysis.silverBullet || null,
        macroWindow: analysis.macroWindow || null,
        smt: analysis.smt || null,
        vwap: analysis.vwap ? { value: analysis.vwap.value, distancePips: analysis.vwap.distancePips, rejection: analysis.vwap.rejection } : null,
        amd: analysis.amd || null,
        fotsi: analysis.fotsiAlignment || null,
        // ── Entity Lifecycle Summaries ──
        entityLifecycles: {
          orderBlocks: (() => {
            const obs = analysis.orderBlocks || [];
            return {
              total: obs.length,
              byState: { active: obs.filter((o: any) => o.state === "active").length, tested: obs.filter((o: any) => o.state === "tested").length, mitigating: obs.filter((o: any) => o.state === "mitigating").length, broken: obs.filter((o: any) => o.state === "broken").length },
            };
          })(),
          fvgs: (() => {
            const fs = analysis.fvgs || [];
            return {
              total: fs.length,
              byState: { open: fs.filter((f: any) => f.state === "open").length, respected: fs.filter((f: any) => f.state === "respected").length, partially_filled: fs.filter((f: any) => f.state === "partially_filled").length, filled: fs.filter((f: any) => f.state === "filled").length },
              avgFillPercent: fs.length > 0 ? (fs.reduce((s: number, f: any) => s + (f.fillPercent || 0), 0) / fs.length) : 0,
            };
          })(),
          swingPoints: (() => {
            const sps = analysis.structure?.swingPoints || [];
            return {
              total: sps.length,
              byState: { active: sps.filter((s: any) => s.state === "active").length, tested: sps.filter((s: any) => s.state === "tested").length, swept: sps.filter((s: any) => s.state === "swept").length, broken: sps.filter((s: any) => s.state === "broken").length },
            };
          })(),
          liquidityPools: (() => {
            const lps = analysis.liquidityPools || [];
            return {
              total: lps.length,
              byState: { active: lps.filter((l: any) => l.state === "active").length, swept_rejected: lps.filter((l: any) => l.state === "swept_rejected").length, swept_absorbed: lps.filter((l: any) => l.state === "swept_absorbed").length, retested: lps.filter((l: any) => l.state === "retested").length },
            };
          })(),
          breakerBlocks: (() => {
            const bbs = analysis.breakerBlocks || [];
            return {
              total: bbs.length,
              byState: { active: bbs.filter((b: any) => b.state === "active").length, tested: bbs.filter((b: any) => b.state === "tested").length, respected: bbs.filter((b: any) => b.state === "respected").length, broken: bbs.filter((b: any) => b.state === "broken").length },
            };
          })(),
          unicornSetups: (() => {
            const us = analysis.unicornSetups || [];
            return {
              total: us.length,
              byState: { active: us.filter((u: any) => u.state === "active").length, invalidated: us.filter((u: any) => u.state === "invalidated").length },
              invalidationReasons: us.filter((u: any) => u.state === "invalidated").map((u: any) => u.invalidationReason).filter(Boolean),
            };
          })(),
        },
      },
      status: "analyzed",
      tradingStyle: resolvedStyle,
      stylePolicy: pairStylePolicy,
      // FIX #10: detectOptimalStyle — suggests the best style based on current market conditions
      suggestedStyle: (() => {
        try {
          return detectOptimalStyle(candles, dailyCandles);
        } catch { return null; }
      })(),
      styleMismatch: (() => {
        try {
          const suggested = detectOptimalStyle(candles, dailyCandles);
          return suggested !== resolvedStyle ? `Using ${resolvedStyle} but market suggests ${suggested}` : null;
        } catch { return null; }
      })(),
      setupClassification: {
        setupType: setupClassification.setupType,
        confidence: setupClassification.confidence,
        rationale: setupClassification.rationale,
        executionProfile: setupClassification.executionProfile,
      },
      // ── Regime Detection Data (for frontend display) ──
      regimeData: analysis.regimeInfo ? {
        daily: {
          regime: analysis.regimeInfo.regime,
          confidence: analysis.regimeInfo.confidence,
          atrTrend: analysis.regimeInfo.atrTrend,
          bias: analysis.regimeInfo.bias,
          transition: analysis.regimeInfo.transition || null,
        },
        h4: analysis.regime4HInfo ? {
          regime: analysis.regime4HInfo.regime,
          confidence: analysis.regime4HInfo.confidence,
          atrTrend: analysis.regime4HInfo.atrTrend,
          bias: analysis.regime4HInfo.bias,
          transition: analysis.regime4HInfo.transition || null,
        } : null,
        multiTFAlignment: analysis.regimeInfo && analysis.regime4HInfo
          ? ((analysis.regimeInfo.regime.includes("trend") && analysis.regime4HInfo.regime.includes("trend"))
            || (analysis.regimeInfo.regime.includes("range") && analysis.regime4HInfo.regime.includes("range")))
            ? "agree" : (analysis.regimeInfo.regime === "transitional" || analysis.regime4HInfo.regime === "transitional")
            ? "mixed" : "disagree"
          : null,
      } : null,
      // ── Confluence Stacking Data (for frontend display) ──
      confluenceStacking: analysis.confluenceStacks && analysis.confluenceStacks.length > 0 ? {
        stacks: analysis.confluenceStacks.slice(0, 5).map((s: any) => ({
          layerCount: s.layerCount,
          label: s.label,
          overlapZone: s.overlapZone,
          fibLevels: s.fibLevels,
          directionalAlignment: s.directionalAlignment,
        })),
        bestStack: analysis.confluenceStacks[0] ? {
          label: analysis.confluenceStacks[0].label,
          layerCount: analysis.confluenceStacks[0].layerCount,
          overlapZone: analysis.confluenceStacks[0].overlapZone,
          fibLevels: analysis.confluenceStacks[0].fibLevels,
          alignment: analysis.confluenceStacks[0].directionalAlignment,
        } : null,
        totalStacks: analysis.confluenceStacks.length,
      } : null,
      // ── Sweep Reclaim Data (for frontend display) ──
      sweepReclaim: analysis.sweepReclaims && analysis.sweepReclaims.length > 0 ? {
        sweeps: analysis.sweepReclaims.slice(0, 5).map((sr: any) => ({
          type: sr.type,
          sweptLevel: sr.sweptLevel,
          reclaimed: sr.reclaimed,
          reclaimStrength: sr.reclaimStrength,
          createdFVG: sr.createdFVG,
          createdDisplacement: sr.createdDisplacement,
          datetime: sr.datetime,
        })),
        bestReclaim: analysis.sweepReclaims.find((sr: any) => sr.reclaimed) || null,
        totalSweeps: analysis.sweepReclaims.length,
        reclaimedCount: analysis.sweepReclaims.filter((sr: any) => sr.reclaimed).length,
      } : null,
      // ── Pullback Decay Data (for frontend display) ──
      pullbackHealth: analysis.pullbackDecay ? {
        trend: analysis.pullbackDecay.trend,
        decayRate: analysis.pullbackDecay.decayRate,
        detail: analysis.pullbackDecay.detail,
        measurements: analysis.pullbackDecay.measurements.map((m: any) => ({
          depthPercent: m.depthPercent,
          nearestFibLevel: m.nearestFibLevel,
        })),
      } : null,
      // ── Structure Intelligence Data (for frontend display) ──
      structureIntel: {
        // Internal vs External BOS/CHoCH counts
        counts: analysis.structure.structureCounts || { internalBOS: 0, externalBOS: 0, internalCHoCH: 0, externalCHoCH: 0 },
        // Structure-to-Fractal conversion rate
        s2f: analysis.structure.structureToFractal || null,
        // BOS-derived S/R levels with lifecycle status
        derivedSR: analysis.structure.derivedSR ? {
          active: analysis.structure.derivedSR.active.map((sr: any) => ({ price: sr.price, type: sr.type })),
          broken: analysis.structure.derivedSR.broken.map((sr: any) => ({ price: sr.price, type: sr.type })),
        } : null,
      },
      // ── ZigZag-based Fibonacci Levels (retracements + extensions) ──
      fibLevels: analysis.fibLevels ? {
        swingHigh: analysis.fibLevels.swingHigh,
        swingLow: analysis.fibLevels.swingLow,
        direction: analysis.fibLevels.direction,
        retracements: analysis.fibLevels.retracements,
        extensions: analysis.fibLevels.extensions,
      } : null,
      // ── Chart Overlays: Full entity data with price levels for UI chart plotting ──
      // Provides raw price-level data so the frontend can render OBs, FVGs, Breakers,
      // Swing Points, Liquidity Pools, and Fib Levels as chart overlays.
      chartOverlays: {
        orderBlocks: (analysis.orderBlocks || []).slice(0, 30).map((ob: any) => ({
          high: ob.high, low: ob.low, datetime: ob.datetime || ob.time,
          state: ob.state, direction: ob.type, timeframe: "entry",
        })),
        fvgs: (analysis.fvgs || []).slice(0, 30).map((f: any) => ({
          high: f.high, low: f.low, datetime: f.datetime || f.time,
          state: f.state, direction: f.type, fillPercent: f.fillPercent ?? 0, timeframe: "entry",
        })),
        breakerBlocks: (analysis.breakerBlocks || []).slice(0, 20).map((bb: any) => ({
          high: bb.high, low: bb.low, datetime: bb.datetime || bb.time,
          state: bb.state, direction: bb.type, timeframe: "entry",
        })),
        swingPoints: (analysis.structure?.swingPoints || []).slice(0, 40).map((sp: any) => ({
          price: sp.price, datetime: sp.datetime || sp.time,
          type: sp.type, state: sp.state, timeframe: "entry",
        })),
        liquidityPools: (analysis.liquidityPools || []).slice(0, 20).map((lp: any) => ({
          price: lp.price ?? ((lp.high ?? 0) + (lp.low ?? 0)) / 2,
          high: lp.high, low: lp.low, datetime: lp.datetime || lp.time,
          strength: lp.strength ?? lp.touches ?? 0, state: lp.state,
          direction: lp.direction ?? lp.type, timeframe: "entry",
        })),
        fibLevels: analysis.fibLevels ? {
          swingHigh: analysis.fibLevels.swingHigh,
          swingLow: analysis.fibLevels.swingLow,
          direction: analysis.fibLevels.direction,
          retracements: analysis.fibLevels.retracements,
          extensions: analysis.fibLevels.extensions,
          timeframe: "entry",
        } : null,
        // HTF overlays: Daily, 4H, 1H POIs with price levels for multi-TF chart plotting
        htfPOIs: htfPOIs.map(p => ({ ...p })),
        // Daily entities (full data for D1 chart overlay)
        dailyEntities: dailyCandles.length >= 10 ? {
          orderBlocks: dOBs.slice(0, 15).map((ob: any) => ({
            high: ob.high, low: ob.low, datetime: ob.datetime || ob.time,
            state: ob.state, direction: ob.type,
          })),
          fvgs: dFVGs.slice(0, 15).map((f: any) => ({
            high: f.high, low: f.low, datetime: f.datetime || f.time,
            state: f.state, direction: f.type, fillPercent: f.fillPercent ?? 0,
          })),
          breakerBlocks: dBreakers.slice(0, 10).map((bb: any) => ({
            high: bb.high, low: bb.low, datetime: bb.datetime || bb.time,
            state: bb.state, direction: bb.type,
          })),
          fibLevels: htfFibLevelsD,
          premiumDiscount: htfPDD,
          liquidityPools: htfLiquidityPoolsD.slice(0, 10).map((lp: any) => ({
            price: lp.price ?? ((lp.high ?? 0) + (lp.low ?? 0)) / 2,
            high: lp.high, low: lp.low, datetime: lp.datetime || lp.time,
            strength: lp.strength ?? lp.touches ?? 0, state: lp.state,
            direction: lp.direction ?? lp.type,
          })),
        } : null,
      },
    };

    const legacyGateDiagnostics: any[] = [];
    const legacyGateBlocks = (code: string, passed: boolean, reason: string) => {
      const disposition = evaluateAuthorityGateDisposition({
        code, passed, requestedMode: (pairConfig as any).singleOwnershipMode,
        runtimeTarget: account.execution_mode === "live" ? "live" : "paper",
      });
      legacyGateDiagnostics.push({ ...disposition, reason });
      detail.legacyGateDiagnostics = legacyGateDiagnostics;
      return disposition.blocksAuthorization;
    };

    // ── DIRECTION VERDICT (single source of truth for direction) ──
    // Moved BEFORE zone engine so the impulse search direction aligns with HTF consensus.
    // Consolidates confirmedTrend, simpleDirection, regime, weeklyBias, and gamePlan
    // into one verdict. ACTIVE: replaces Gate 1 (HTF Bias), Gate 20 (Regime), and ICT HTF score adj.
    let directionVerdict: DirectionVerdictResult | null = null;
    let activeDirectionVerdict: DirectionVerdictDecision | null = null;
    let earlyWeeklyBias: { bias: string; confidence: number } | null = null;
    try {
      const gpCtx = (pairConfig as any)._gamePlanContext;
      const ctResult = (pairConfig as any).useConfirmedTrend !== false
        ? pairDecisionEvidence.confirmedTrend
        : null;
      // Weekly context belongs to the decision only when Weekly is the
      // active style's bias role (Swing). Scalper/Day Trader no longer receive
      // an unrelated weekly vote.
      const _earlyWeeklyBiasResult =
        timeframeAuthority.roles.bias === "1w" &&
          weeklyCandles && weeklyCandles.length >= 12
        ? analyzeWeeklyBiasAndDOL(weeklyCandles, analysis.lastPrice)
        : null;
      if (_earlyWeeklyBiasResult) {
        earlyWeeklyBias = { bias: _earlyWeeklyBiasResult.bias, confidence: _earlyWeeklyBiasResult.confidence };
      }
      directionVerdict = computeDirectionVerdict({
        decisionEvidence: pairDecisionEvidence,
        confirmedTrend: ctResult,
        simpleDirection: simpleDirectionResult ? {
          direction: simpleDirectionResult.direction,
          bias: simpleDirectionResult.bias,
          biasSource: simpleDirectionResult.biasSource,
          h4Retrace: simpleDirectionResult.h4Retrace,
          h4ChochAgainst: simpleDirectionResult.h4ChochAgainst,
          h1Confirmed: simpleDirectionResult.h1Confirmed,
          reason: simpleDirectionResult.reason,
        } : null,
        regime: pairDecisionEvidence.biasRegime ? {
          regime: pairDecisionEvidence.biasRegime.regime,
          confidence: pairDecisionEvidence.biasRegime.confidence,
          directionalBias:
            pairDecisionEvidence.biasRegime.directionalBias,
        } : null,
        weeklyBias: earlyWeeklyBias ? {
          bias: earlyWeeklyBias.bias as "bullish" | "bearish" | "neutral",
          confidence: earlyWeeklyBias.confidence,
        } : null,
        gamePlanBias: pairConfig.gpEnforcementMode !== "off" && gpCtx ? {
          bias: gpCtx.bias,
          confidence: gpCtx.biasConfidence ?? 50,
        } : null,
      });
      activeDirectionVerdict = await persistActiveDirectionVerdict(
        supabase,
        {
          userId,
          botId: BOT_ID,
          symbol: pair,
          verdict: directionVerdict,
          gamePlan: activeGamePlan,
          sourceCandleTimestamp:
            candles[candles.length - 1]?.datetime || null,
          scanCycleId,
          stylePolicy: pairStylePolicy,
        },
      );
      _activeDirectionVerdicts.set(pair, activeDirectionVerdict);
      (detail as any).directionVerdict = {
        id: activeDirectionVerdict.id,
        verdictVersion: activeDirectionVerdict.verdictVersion,
        gamePlanId: activeDirectionVerdict.gamePlanId,
        gamePlanVersion: activeDirectionVerdict.gamePlanVersion,
        verdict: directionVerdict.verdict,
        confidence: directionVerdict.confidence,
        agreement: directionVerdict.agreement,
        shouldBlock: directionVerdict.shouldBlock,
        blockReason: directionVerdict.blockReason,
        scoreAdjustment: directionVerdict.scoreAdjustment,
        summary: directionVerdict.summary,
        evaluatedAt: activeDirectionVerdict.evaluatedAt,
        expiresAt: activeDirectionVerdict.expiresAt,
        sourceCandleTimestamp:
          activeDirectionVerdict.sourceCandleTimestamp,
      };
      console.log(`[scan ${scanCycleId}] ${pair} DirectionVerdict (pre-zone): ${directionVerdict.summary}`);
    } catch (dvErr: any) {
      activeDirectionVerdict = null;
      console.warn(`[scan ${scanCycleId}] ${pair} DirectionVerdict authority unavailable: ${dvErr?.message}`);
      (detail as any).directionVerdict = { error: dvErr?.message };
    }

    // ── Effective direction for zone engine ──
    // ── DIRECTION AUTHORITY: Verdict is the single source of truth ──
    // If verdict blocks or is neutral → no trade (no 15m fallback).
    // If verdict has a direction → that IS the direction, period.
    // If verdict contradicts 15m scoring → flag conflict but use verdict.
    let effectiveDirection: "long" | "short" | null = null;
    let directionSource: "verdict" | "15m_fallback" | "blocked" = "blocked";
    let directionConflict = false;

    if (directionVerdict && directionVerdict.shouldBlock) {
      // Verdict explicitly blocks — no trade
      effectiveDirection = null;
      directionSource = "blocked";
      console.log(`[scan ${scanCycleId}] ${pair} Direction BLOCKED: ${directionVerdict.blockReason}`);
    } else if (directionVerdict && directionVerdict.verdict !== "neutral") {
      // Verdict has a clear direction — use it unconditionally
      effectiveDirection = directionVerdict.verdict as "long" | "short";
      directionSource = "verdict";
      // Check for conflict with 15m scoring (informational, does not change direction)
      if (analysis.direction && analysis.direction !== effectiveDirection) {
        directionConflict = true;
        console.log(`[scan ${scanCycleId}] ${pair} Direction CONFLICT: verdict=${effectiveDirection}, 15m=${analysis.direction} — using verdict`);
      }
    } else if (directionVerdict && directionVerdict.verdict === "neutral") {
      // Verdict is neutral (below confidence or agreement threshold) — block
      effectiveDirection = null;
      directionSource = "blocked";
      console.log(`[scan ${scanCycleId}] ${pair} Direction NEUTRAL (blocked): ${directionVerdict.summary}`);
    } else {
      // Preserve the current fallback while recording the fail-closed comparison.
      const directionAvailability = resolveDirectionAvailability({
        mode: (pairConfig as any).canonicalScannerMode === "enforce"
          ? "fail_closed" : (pairConfig as any).directionUnavailableMode,
        verdictDirection: null,
        legacyDirection: analysis.direction,
      });
      (detail as any).directionAvailabilityPolicy = directionAvailability;
      effectiveDirection = directionAvailability.selectedDirection;
      directionSource = effectiveDirection ? "15m_fallback" : "blocked";
      console.log(`[scan ${scanCycleId}] ${pair} Direction authority unavailable: current=${effectiveDirection || "wait"}, fail-closed wouldWait=${directionAvailability.wouldWait}`);
    }
    if (directionVerdict?.verdict === "long" || directionVerdict?.verdict === "short") {
      (detail as any).directionAvailabilityPolicy = resolveDirectionAvailability({
        mode: (pairConfig as any).directionUnavailableMode,
        verdictDirection: directionVerdict.verdict,
        legacyDirection: analysis.direction,
      });
    }

    // ── DIRECTION SYNC: overwrite analysis.direction with verdict direction ──
    // This ensures ALL downstream code (SL/TP, pending orders, trade execution, broker)
    // uses the authoritative verdict direction, not the 15m confluenceScoring direction.
    if (effectiveDirection && effectiveDirection !== analysis.direction) {
      console.log(`[scan ${scanCycleId}] ${pair} Direction SYNC: analysis.direction ${analysis.direction} → ${effectiveDirection} (source: ${directionSource})`);
      analysis.direction = effectiveDirection;
    }
    // `detail` is created before Direction Verdict runs. Keep the persisted
    // scan row aligned with the direction that downstream zone, risk, and
    // execution logic actually uses instead of leaving the pre-verdict value.
    detail.direction = effectiveDirection ?? "neutral";
    detail.directionSource = directionSource;

    // ── SL/TP Recalculation: when verdict provides direction but original SL/TP are null ──
    // Root cause: calculateSLTP() inside runConfluenceAnalysis() returns null when direction is null.
    // If the Direction Verdict later assigns a valid direction, we must recalculate SL/TP
    // so the R:R gate (Gate 10) can evaluate the trade instead of auto-failing.
    if (effectiveDirection && (!analysis.stopLoss || !analysis.takeProfit)) {
      const _spec = SPECS[pair] || SPECS["EUR/USD"];
      const _atrVal = (analysis as any).atrValue ?? calculateATR(candles, pairConfig.slATRPeriod || 14);
      const _gpCtx = (pairConfig as any)._gamePlanContext;
      const _dolEnabled = (pairConfig as any).dolTPExtensionEnabled !== false;
      const _dolTargets = _dolEnabled && _gpCtx?.dol
        ? (Array.isArray(_gpCtx.dol) ? _gpCtx.dol : [_gpCtx.dol])
        : undefined;
      const { stopLoss: recalcSL, takeProfit: recalcTP } = calculateSLTP({
        direction: effectiveDirection,
        lastPrice: analysis.lastPrice,
        pipSize: _spec.pipSize,
        config: pairConfig,
        swings: analysis.structure?.swingPoints || [],
        orderBlocks: analysis.orderBlocks || [],
        liquidityPools: analysis.liquidityPools || [],
        pdLevels: analysis.pdLevels || null,
        atrValue: _atrVal,
        fvgs: analysis.fvgs || [],
        fibExtensions: analysis.fibLevels?.extensions,
        dolTargets: _dolTargets,
      });
      if (recalcSL && recalcTP) {
        analysis.stopLoss = recalcSL;
        analysis.takeProfit = recalcTP;
        console.log(`[scan ${scanCycleId}] ${pair} SL/TP RECALC (verdict direction=${effectiveDirection}): SL=${recalcSL.toFixed(_spec.pipSize < 0.01 ? 3 : 5)} TP=${recalcTP.toFixed(_spec.pipSize < 0.01 ? 3 : 5)}`);
      } else {
        console.log(`[scan ${scanCycleId}] ${pair} SL/TP RECALC failed — calculateSLTP returned null even with direction=${effectiveDirection}`);
      }
    }

    // Attach source and conflict info to detail so frontend can show which system drove zone selection
    (detail as any).directionSource = directionSource;
    (detail as any).directionConflict = directionConflict;
    if ((detail as any).directionVerdict && typeof (detail as any).directionVerdict === "object") {
      (detail as any).directionVerdict.directionSource = directionSource;
      (detail as any).directionVerdict.effectiveDirection = effectiveDirection;
      (detail as any).directionVerdict.directionConflict = directionConflict;
    }
    // Build HTF confluence data from already-computed 4H analysis (used by impulse zone engine)
    const htfConfluenceData: HTFConfluenceData | null = effectiveDirection ? {
      h4OBs: h4OBs ?? [],
      h4FVGs: h4FVGs ?? [],
      h4Breakers: h4Breakers ?? [],
      htfFibLevels: htfFibLevels4H ?? null,
      dailyFibLevels: htfFibLevelsD ?? null,
      htfPD: htfPD4H ?? null,
      direction: (effectiveDirection === "long" ? "bullish" : "bearish") as "bullish" | "bearish",
    } : null;

    // ── Consolidated Zone Engine (story-driven waterfall with liquidity + confirmation) ──
    // Style-aware candle mapping for findUnifiedZone:
    //   findUnifiedZone(h1Candles, h4Candles, entryCandles, ..., dailyCandles?, confirmCandles?, ltfConfirmCandles?)
    //   Scalper:     h1=5m(entry), h4=15m, entry=5m, daily=1H, confirm=15m, ltfConfirm=5m
    //   Day Trader:  h1=1H, h4=4H, entry=15m, daily=Daily, confirm=4H/1H, ltfConfirm=1H/15m
    //   Swing:       h1=4H, h4=Daily, entry=1H, daily=Weekly, confirm=Daily, ltfConfirm=4H
    // The slot names (h1, h4, daily) are just positional — the engine is TF-agnostic.
    const hasMinZoneCandles = roleCandles.setup.length >= 20;
    const nestedPoiActivation = resolveNestedPoiMarketActivation({
      marketFillAtZone: pairConfig.marketFillAtZone === true,
      mode: (pairConfig as any).nestedPoiMarketMode,
      runtimeTarget: account.execution_mode === "live" ? "live" : "paper",
    });

    if (effectiveDirection && hasMinZoneCandles) {
      try {
        const unifiedDir = effectiveDirection === "long" ? "bullish" : "bearish";
        // Combine liquidity pools from the relevant timeframes
        const combinedLiqPools = [
          ...htfLiquidityPoolsD,
          ...htfLiquidityPools4H,
          ...htfLiquidityPools1H,
        ];

        // The engine's legacy slot names are positional. Bind them from the
        // policy ladder instead of reconstructing a style switch:
        //   daily=top/bias, h4=mid/structure, h1=low/setup.
        const zoneH1Candles = roleCandles.setup;
        const zoneH4Candles = roleCandles.structure;
        const zoneEntryCandles = candles;
        const topMinCandles = timeframeAuthority.zone.top === "1d" ? 30 : 20;
        const zoneDailyCandles = roleCandles.bias.length >= topMinCandles
          ? roleCandles.bias
          : undefined;
        const zoneConfirmCandles = roleCandles.structure.length >= 15
          ? roleCandles.structure
          : roleCandles.setup;
        const zoneLtfConfirmCandles = roleCandles.setup;
        const zoneTFLabels: TFSlotLabels = zoneTimeframeLabels(
          timeframeAuthority,
        );

        // Resolve any hand-marked impulse for this pair against candles from the
        // timeframe it was marked on. A marking must either drive the scan or
        // explain why it cannot — never fail silently.
        const manualMarking = manualImpulseBySymbol.get(pair);
        let manualImpulseLeg = null as ReturnType<typeof resolveManualImpulse>["leg"];
        if (manualMarking) {
          const byTf: Record<string, Candle[]> = {
            D: dailyCandles, "4H": h4Candles, "1H": hourlyCandles,
          };
          const spec: ManualImpulseSpec = {
            symbol: pair,
            direction: manualMarking.direction,
            high: Number(manualMarking.high),
            low: Number(manualMarking.low),
            timeframe: manualMarking.timeframe,
            highTime: manualMarking.high_time ?? null,
            lowTime: manualMarking.low_time ?? null,
          };
          const resolvedManual = resolveManualImpulse(
            byTf[manualMarking.timeframe] || hourlyCandles,
            spec,
          );
          manualImpulseLeg = resolvedManual.leg;
          (detail as any).manualImpulse = {
            id: manualMarking.id,
            direction: manualMarking.direction,
            high: Number(manualMarking.high),
            low: Number(manualMarking.low),
            timeframe: manualMarking.timeframe,
            accepted: resolvedManual.leg != null,
            rejection: resolvedManual.rejection,
            detail: resolvedManual.detail,
            matchErrorPips: resolvedManual.matchErrorPips ?? null,
          };
          if (resolvedManual.leg) {
            console.log(`[scan ${scanCycleId}] ${pair}: MANUAL IMPULSE override — ${resolvedManual.detail}`);
          } else {
            console.log(`[scan ${scanCycleId}] ${pair}: manual impulse rejected — ${resolvedManual.detail}`);
            // Retire only a permanently dead marking. A transient miss (candles
            // not loaded yet) must not discard the user's work.
            if (
              resolvedManual.rejection === "origin_already_broken" ||
              resolvedManual.rejection === "direction_mismatch" ||
              resolvedManual.rejection === "invalid_bounds" ||
              resolvedManual.rejection === "too_small_for_stop"
            ) {
              manualImpulseRetirements.push(
                retireManualImpulse(manualMarking.id, resolvedManual.rejection, resolvedManual.detail),
              );
              manualImpulseBySymbol.delete(pair);
            }
          }
        }
        const unifiedResult: UnifiedZoneResult = findUnifiedZone(
          zoneH1Candles,
          zoneH4Candles,
          zoneEntryCandles,
          unifiedDir as "bullish" | "bearish",
          analysis.lastPrice,
          combinedLiqPools,
          htfConfluenceData ?? undefined,
          {
            manualImpulse: manualImpulseLeg,
            collectEvidence: true,
            collectNestedPoiEvidence: nestedPoiActivation.enabled,
            structureAuthorityMode: pairConfig.canonicalStructureMode === "enforce" &&
                pairConfig.singleOwnershipMode === "enforce"
              ? "enforce"
              : "observe",
            strictATRMult: pairConfig.marketFillStrictATRMult,
            minQualityScore: pairConfig.zoneQualityThreshold,
            maxAgeBars: pairConfig.zoneMaxAgeBars,
            minBodyRatio: pairConfig.zoneMinBodyRatio,
            minDisplacementATR: pairConfig.zoneMinDisplacementATR,
            pipSize: (SPECS[pair] || SPECS["EUR/USD"]).pipSize,
            fibMaxRetracement: pairConfig.fibMaxRetracement,
            originOBRetest: pairConfig.originOBRetest,
            evidenceContext: {
              symbol: pair,
              timeframe: zoneTFLabels.low,
              observedAt: candles[candles.length - 1]?.datetime,
            },
            entryTimeframe: timeframeAuthority.runtimeEntry,
          },
          zoneDailyCandles,
          zoneConfirmCandles,
          zoneLtfConfirmCandles,
          {
            requireLiquiditySweep: pairConfig.requireLiquiditySweep,
            sweptAbsorbedPenalty: pairConfig.sweptAbsorbedPenalty ?? 2.0,
            // Same floor the scanner applies to its own SL below: the larger of
            // the per-instrument static minimum and the ATR floor. Without it the
            // unified entry stop is half the zone height, which on a narrow zone
            // is smaller than the spread and inflates R:R past every gate.
            minStopPips: Math.max(
              MIN_SL_PIPS[pair] ?? 15,
              ((analysis as any).atrValue ?? 0) > 0
                ? ((analysis as any).atrValue * ATR_SL_FLOOR_MULTIPLIER) /
                  (SPECS[pair] || SPECS["EUR/USD"]).pipSize
                : 0,
            ),
          },
          zoneTFLabels,
        );

        // Store the full unified story for the frontend narrative panel
        (detail as any).unifiedZone = {
          hasZone: unifiedResult.hasZone,
          state: unifiedResult.state,
          selectedTF: unifiedResult.selectedTF,
          unifiedScore: unifiedResult.unifiedScore,
          scoreBreakdown: unifiedResult.scoreBreakdown,
          candidateAuthorityObservation:
            unifiedResult.candidateAuthorityObservation ?? null,
          impulse: unifiedResult.impulse,
          zone: unifiedResult.zone,
          price: unifiedResult.price,
          liquidity: unifiedResult.liquidity ? {
            liquidityScore: unifiedResult.liquidity.liquidityScore,
            summary: unifiedResult.liquidity.summary,
            nearbyPools: unifiedResult.liquidity.nearbyPools.length,
            entryTriggerState: unifiedResult.liquidity.entryTriggerState,
            hasUnsweptEntryTrigger:
              unifiedResult.liquidity.hasUnsweptEntryTrigger,
            entryTrigger: unifiedResult.liquidity.entryTrigger,
            gateReason: unifiedResult.liquidity.gateReason,
            sweepEvent: unifiedResult.liquidity.sweepEvent ? {
              level: unifiedResult.liquidity.sweepEvent.level,
              type: unifiedResult.liquidity.sweepEvent.type,
              rejected: unifiedResult.liquidity.sweepEvent.rejected,
            } : null,
          } : null,
          confirmation: unifiedResult.confirmation ? {
            type: unifiedResult.confirmation.type,
            score: unifiedResult.confirmation.score,
            entryReady: unifiedResult.confirmation.entryReady,
            direction: unifiedResult.confirmation.direction,
            detail: unifiedResult.confirmation.detail,
          } : null,
          entry: unifiedResult.entry,
          storySummary: unifiedResult.storySummary,
          reason: unifiedResult.reason,
          entryTriggerState: unifiedResult.liquidity?.entryTriggerState || null,
          hasUnsweptEntryTrigger:
            unifiedResult.liquidity?.hasUnsweptEntryTrigger === true,
          gatePolicy: {
            requireLiquiditySweep:
              pairConfig.requireLiquiditySweep === true,
          },
        };

        // Derive izData (detail.impulseZone) from the unified result's multiTFResult
        // for backward compatibility with the 58 downstream references to izData.*
        const multiTF = unifiedResult.multiTFResult;
        const nestedPoiEntry =
          nestedPoiActivation.enabled && multiTF.bestZone
            ? buildNestedPoiEntryPlan(multiTF.bestZone.zone)
            : null;
        (detail as any).impulseZone = {
          hasZone: !!multiTF.bestZone,
          selectedTF: multiTF.selectedTF,
          impulseQualification: unifiedResult.impulse?.qualification ?? null,
          reason: multiTF.reason,
          impulse: multiTF.bestZone?.impulse ? {
            high: multiTF.bestZone.impulse.high,
            low: multiTF.bestZone.impulse.low,
            direction: multiTF.bestZone.impulse.direction,
            endDate: multiTF.bestZone.impulse.endDate || null,
            spanBars: multiTF.bestZone.impulse.spanBars ?? null,
          } : null,
          bestZone: multiTF.bestZone ? {
            type: multiTF.bestZone.zone.poi.type,
            high: multiTF.bestZone.zone.poi.high,
            low: multiTF.bestZone.zone.poi.low,
            fibLevel: multiTF.bestZone.zone.fibLevel,
            fibPrice: multiTF.bestZone.zone.fibPrice ?? null,
            fibDepth: multiTF.bestZone.zone.fibDepth,
            totalScore: multiTF.bestZone.zone.totalScore,
            srConfirmed: multiTF.bestZone.zone.srConfirmed,
            ltfRefined: multiTF.bestZone.zone.ltfRefined,
            ltfType: multiTF.bestZone.zone.ltfType || null,
            refinedEntry: multiTF.bestZone.zone.refinedEntry || null,
            refinedSL: multiTF.bestZone.zone.refinedSL || null,
            htfConfluenceScore: multiTF.bestZone.zone.htfConfluenceScore,
            htfLayers: multiTF.bestZone.zone.htfLayers,
            evidence: multiTF.bestZone.zone.poi.evidence ?? null,
            localConfluence:
              multiTF.bestZone.zone.localConfluence ?? null,
            shadowRanking:
              multiTF.bestZone.zone.shadowRanking ?? null,
            candidateLifecycle:
              multiTF.bestZone.zone.candidateLifecycle ?? null,
            candidateModel:
              multiTF.bestZone.zone.candidateModel ?? null,
            timeframeLineage:
              multiTF.bestZone.zone.timeframeLineage ?? null,
            canonicalImpulseMetrics:
              multiTF.bestZone.zone.canonicalImpulseMetrics ?? null,
            priceAtZone: multiTF.bestZone.priceAtZone,
            priceInsideZone: multiTF.bestZone.priceInsideZone,
            priceAtZoneStrict: multiTF.bestZone.priceAtZoneStrict,
            sideOk: multiTF.bestZone.sideOk,
            distanceToZone: multiTF.bestZone.distanceToZone,
            distancePips: multiTF.bestZone.distancePips,
          } : null,
          allZonesCount: multiTF.allZones.length,
          zoneCandidates: multiTF.allZones.map((candidate: any) => ({
            type: candidate.poi.type,
            high: candidate.poi.high,
            low: candidate.poi.low,
            fibLevel: candidate.fibLevel,
            fibPrice: candidate.fibPrice ?? null,
            fibDepth: candidate.fibDepth,
            totalScore: candidate.totalScore,
            evidence: candidate.poi.evidence ?? null,
            localConfluence: candidate.localConfluence ?? null,
            shadowRanking: candidate.shadowRanking ?? null,
            candidateLifecycle: candidate.candidateLifecycle ?? null,
            candidateModel: candidate.candidateModel ?? null,
            timeframeLineage: candidate.timeframeLineage ?? null,
            canonicalImpulseMetrics:
              candidate.canonicalImpulseMetrics ?? null,
          })),
          h1HasZone: !!multiTF.h1Result.bestZone,
          h4HasZone: !!multiTF.h4Result?.bestZone,
          dailyHasZone: !!multiTF.dailyResult?.bestZone,
          candidateAuthorityObservation:
            unifiedResult.candidateAuthorityObservation ?? null,
          nestedPoiEntry,
          scoringEnabled: pairConfig.impulseZoneEnabled !== false,
        };

        try {
          const persisted = await persistZoneShadowObservations(supabase, {
            userId,
            botId: BOT_ID,
            scanCycleId,
            symbol: pair,
            tradingStyle: resolvedStyle,
            stylePolicyVersion: pairStylePolicy.contractVersion,
            styleBasePolicyHash: pairStylePolicy.basePolicyHash,
            stylePolicyHash: pairStylePolicy.policyHash,
            observedAt: candles[candles.length - 1]?.datetime ||
              new Date().toISOString(),
            candidates: multiTF.allZones,
            crossTimeframePolicy: crossTimeframeAuthority.policy,
          });
          if (persisted > 0) {
            console.log(
              `[scan ${scanCycleId}] ${pair} stored ${persisted}`
              + ` observe-only zone candidate model rows`,
            );
          }
          await persistICTEntryZoneObservation(supabase, {
            userId,
            botId: BOT_ID,
            scanCycleId,
            symbol: pair,
            tradingStyle: resolvedStyle,
            observedAt: candles[candles.length - 1]?.datetime ||
              new Date().toISOString(),
            legacyBestZone: multiTF.bestZone,
            authority: unifiedResult.candidateAuthorityObservation!,
          });
        } catch (shadowStoreErr: any) {
          console.warn(
            `[scan ${scanCycleId}] ${pair} zone shadow evidence unavailable`
            + ` (non-fatal): ${shadowStoreErr?.message}`,
          );
        }

        // ── Phase 1: per-timeframe evidence (observation only) ──
        // Records what the engine saw on every slot. Never feeds scoring,
        // ranking, gating, configuration or execution.
        try {
          const timeframeEvidenceRow = buildScanEvidenceRow(
            multiTF,
            {
              top: { timeframe: zoneTFLabels.top, candles: zoneDailyCandles ?? [] },
              mid: { timeframe: zoneTFLabels.mid, candles: zoneH4Candles ?? [] },
              low: { timeframe: zoneTFLabels.low, candles: zoneH1Candles ?? [] },
            },
            {
              userId,
              botId: BOT_ID,
              scanCycleId,
              symbol: pair,
              direction: unifiedDir as "bullish" | "bearish",
              observedAt: candles[candles.length - 1]?.datetime ||
                new Date().toISOString(),
              evaluatedAt: new Date().toISOString(),
              tradingStyle: resolvedStyle,
              stylePolicyVersion: pairStylePolicy.contractVersion,
              styleBasePolicyHash: pairStylePolicy.basePolicyHash,
              stylePolicyHash: pairStylePolicy.policyHash,
              stylePolicySnapshot: {
                style: pairStylePolicy.style,
                timeframes: pairStylePolicy.timeframes,
              },
              evidenceSource: "live_scan",
            },
            {
              strictATRMult: pairConfig.marketFillStrictATRMult,
              minQualityScore: pairConfig.zoneQualityThreshold,
              maxAgeBars: pairConfig.zoneMaxAgeBars,
              minBodyRatio: pairConfig.zoneMinBodyRatio,
              minDisplacementATR: pairConfig.zoneMinDisplacementATR,
              pipSize: (SPECS[pair] || SPECS["EUR/USD"]).pipSize,
              fibMaxRetracement: pairConfig.fibMaxRetracement,
              originOBRetest: pairConfig.originOBRetest,
              evidenceContext: {
                symbol: pair,
                timeframe: zoneTFLabels.low,
                observedAt: candles[candles.length - 1]?.datetime,
              },
            },
          );
          zoneEvidenceRows.push(timeframeEvidenceRow);
          // Freeze the exact evidence identity into every downstream setup,
          // order and history record. Historical UI must never fall back to
          // "latest evidence for this symbol", which can describe a different
          // market state.
          (detail as any).timeframeEvidenceId = timeframeEvidenceRow.id;
          (detail as any).timeframeEvidenceScanCycleId = scanCycleId;

          const canonicalRangeSelection = resolveCanonicalDealingRange({
            slots: timeframeEvidenceRow.slots,
            parentTimeframe:
              multiTF.bestZone?.zone.timeframeLineage?.parentTimeframe || null,
            childTimeframe: multiTF.selectedTF || "",
            frozenAt: timeframeEvidenceRow.observed_at,
          });
          const canonicalMode = normalizeDealingRangeMode(
            (pairConfig as any).dealingRangeMode,
            {
              onlyBuyInDiscount: pairConfig.onlyBuyInDiscount,
              onlySellInPremium: pairConfig.onlySellInPremium,
            },
          );
          const canonicalEvaluation = evaluateCanonicalDealingRange({
            range: canonicalRangeSelection.range,
            direction: analysis.direction as "long" | "short",
            price: analysis.lastPrice,
            mode: canonicalMode,
          });
          analysis._canonicalDealingRangeAvailable = canonicalRangeSelection.available;
          analysis._canonicalDealingRangeEvaluation = canonicalEvaluation;
          const rollingBlocked =
            (pairConfig.onlyBuyInDiscount &&
              analysis.direction === "long" &&
              analysis.pd.currentZone === "premium") ||
            (pairConfig.onlySellInPremium &&
              analysis.direction === "short" &&
              analysis.pd.currentZone === "discount");
          (detail as any).canonicalDealingRangeObservation = {
            selectionReason: canonicalRangeSelection.reason,
            ...compareDealingRangeDecisions({
              canonical: canonicalEvaluation,
              rollingAllowed: !rollingBlocked,
              rollingPercent: analysis.pd.zonePercent,
            }),
          };
        } catch (tfEvidenceErr: any) {
          console.warn(
            `[scan ${scanCycleId}] ${pair} timeframe evidence build failed`
            + ` (non-fatal): ${tfEvidenceErr?.message}`,
          );
        }

        console.log(`[scan ${scanCycleId}] ${pair} Zone Story [${unifiedResult.state}|${multiTF.selectedTF || "none"}]: score ${unifiedResult.unifiedScore}/14, zone ${multiTF.bestZone?.zone.totalScore.toFixed(1) ?? "—"}/9 — ${unifiedResult.reason.slice(0, 120)}`);
      } catch (zoneErr: any) {
        console.warn(`[scan ${scanCycleId}] ${pair} Zone Engine error (non-fatal): ${zoneErr?.message}`);
        (detail as any).unifiedZone = { hasZone: false, state: "error", reason: `Error: ${zoneErr?.message}` };
        (detail as any).impulseZone = { hasZone: false, selectedTF: null, reason: `Error: ${zoneErr?.message}`, impulse: null, bestZone: null, allZonesCount: 0, h1HasZone: false, h4HasZone: false };
      }
    } else {
      const dirReason = !effectiveDirection && simpleDirectionResult?.reason
        ? `No direction: ${simpleDirectionResult.reason}`
        : effectiveDirection ? "Insufficient candles for zone detection" : "No direction determined";
      (detail as any).unifiedZone = { hasZone: false, state: "no_impulse", reason: dirReason };
      (detail as any).impulseZone = { hasZone: false, selectedTF: null, reason: dirReason, impulse: null, bestZone: null, allZonesCount: 0, h1HasZone: false, h4HasZone: false,
        directionDetail: simpleDirectionResult ? {
          bias: simpleDirectionResult.bias,
          biasSource: simpleDirectionResult.biasSource,
          h4Retrace: simpleDirectionResult.h4Retrace,
          h4ChochAgainst: simpleDirectionResult.h4ChochAgainst,
          h1Confirmed: simpleDirectionResult.h1Confirmed,
        } : null,
      };
    }

    // ── Cascade Zone Engine (swing_trader only) ──
    // For swing_trader, the cascade engine (Daily→ 4H→1H) provides superior zone detection
    // compared to the unified zone engine. Backtest validated: 75% WR, PF 8.88, Sharpe 12.78.
    // When cascade reaches "triggered" state, it overrides the unified zone gate.
    let cascadeResult: CascadeResult | null = null;
    if (resolvedStyle === "swing_trader" && effectiveDirection && dailyCandles.length >= 30 && h4Candles.length >= 20) {
      try {
        const cascadeDir = effectiveDirection === "long" ? "bullish" : "bearish";
        cascadeResult = findCascadeZone(
          dailyCandles,
          h4Candles,
          hourlyCandles,
          candles, // 1H entry candles
          cascadeDir as "bullish" | "bearish",
          analysis.lastPrice,
          {
            htfData: htfConfluenceData ?? undefined,
            zoneEngineOpts: {
              strictATRMult: pairConfig.marketFillStrictATRMult,
              pipSize: (SPECS[pair] || SPECS["EUR/USD"]).pipSize,
              fibMaxRetracement: pairConfig.fibMaxRetracement,
              originOBRetest: pairConfig.originOBRetest,
            },
          },
        );
        (detail as any).cascadeZone = {
          state: cascadeResult.state,
          reason: cascadeResult.reason,
          hasDailyZone: !!cascadeResult.dailyZone,
          hasConfirmation: !!cascadeResult.confirmation,
          hasEntryZone: !!cascadeResult.entryZone,
          priceAtEntry: cascadeResult.priceAtEntry,
          distancePips: cascadeResult.distancePips,
          entry: cascadeResult.entry,
          sl: cascadeResult.sl,
        };
        console.log(`[scan ${scanCycleId}] ${pair} Cascade Zone [${cascadeResult.state}]: ${cascadeResult.reason.slice(0, 120)}`);
      } catch (cascadeErr: any) {
        console.warn(`[scan ${scanCycleId}] ${pair} Cascade Zone error (non-fatal): ${cascadeErr?.message}`);
        (detail as any).cascadeZone = { state: "error", reason: cascadeErr?.message };
      }
    }


    // ── Attach Simple Direction data to detail for dashboard ──
    if (simpleDirectionResult) {
      (detail as any).simpleDirection = {
        direction: simpleDirectionResult.direction,
        bias: simpleDirectionResult.bias,
        biasSource: simpleDirectionResult.biasSource,
        h4Retrace: simpleDirectionResult.h4Retrace,
        h4ChochAgainst: simpleDirectionResult.h4ChochAgainst,
        h1Confirmed: simpleDirectionResult.h1Confirmed,
        reason: simpleDirectionResult.reason,
      };
    }

    // ── ICT HTF Framework: Weekly Bias + Daily Impulse + Containment (log-only in "off" mode) ──
    let ictHTFResult: ICTHTFResult | null = null;
    const shouldRunICTHTF = resolvedStyle === "swing_trader" || ictHTFActive;
    if (shouldRunICTHTF && effectiveDirection) {
      try {
        // Build LTF zone from impulse zone engine result (if available)
        const izData = (detail as any).impulseZone;
        const ltfZone: { high: number; low: number } | null = izData?.bestZone
          ? { high: izData.bestZone.high, low: izData.bestZone.low }
          : null;
        ictHTFResult = runICTHTFAnalysis(
          weeklyCandles,
          dailyCandles,
          analysis.lastPrice,
          effectiveDirection as "long" | "short",
          ltfZone,
          {
            ictHTFEnabled: pairConfig.ictHTFEnabled,
            ictHTFGateMode: pairConfig.ictHTFGateMode,
            ictHTFAlignedBonus: pairConfig.ictHTFAlignedBonus,
            ictHTFMisalignedPenalty: pairConfig.ictHTFMisalignedPenalty,
            ictHTFMinContainment: pairConfig.ictHTFMinContainment,
            ictWeeklyBiasRequired: pairConfig.ictWeeklyBiasRequired,
            ictDailyContainmentRequired: pairConfig.ictDailyContainmentRequired,
          },
        );

        // Attach to scan detail for dashboard visibility
        (detail as any).ictHTF = {
          gateMode: pairConfig.ictHTFGateMode,
          passed: ictHTFResult.passed,
          weeklyBias: ictHTFResult.weeklyBias ? {
            bias: ictHTFResult.weeklyBias.bias,
            confidence: ictHTFResult.weeklyBias.confidence,
            primaryDOL: ictHTFResult.weeklyBias.primaryDOL?.label ?? null,
          } : null,
          dailyOB: ictHTFResult.dailyOB ? {
            high: ictHTFResult.dailyOB.high,
            low: ictHTFResult.dailyOB.low,
            direction: ictHTFResult.dailyOB.direction,
            isValid: ictHTFResult.dailyOB.isValid,
            priceInZone: ictHTFResult.dailyOB.priceInZone,
          } : null,
          containment: ictHTFResult.containment ? {
            overlapPercent: ictHTFResult.containment.overlapPercent,
            isContained: ictHTFResult.containment.isContained,
          } : null,
          weeklyAligned: ictHTFResult.weeklyAligned,
          zoneContained: ictHTFResult.zoneContained,
          scoreAdjustment: ictHTFResult.scoreAdjustment,
          reason: ictHTFResult.reason,
          details: ictHTFResult.details,
        };

        // Log ICT HTF result
        const modeTag = pairConfig.ictHTFGateMode.toUpperCase();
        console.log(`[scan ${scanCycleId}] ${pair} ICT HTF [${modeTag}]: ${ictHTFResult.reason}`);
        if (ictHTFResult.details.length > 0) {
          console.log(`[scan ${scanCycleId}] ${pair} ICT HTF details: ${ictHTFResult.details.join(" | ")}`);
        }
      } catch (ictErr: any) {
        console.warn(`[scan ${scanCycleId}] ${pair} ICT HTF error (non-fatal): ${ictErr?.message}`);
        (detail as any).ictHTF = { gateMode: pairConfig.ictHTFGateMode, passed: true, error: ictErr?.message };
      }
    }

    // ── ICT Displacement MSS Validation (log-only in "off" mode) ──
    let ictMSSResult: MSSValidationResult | null = null;
    if (pairConfig.ictDisplacementMSSEnabled) {
      try {
        const mssConfig: DisplacementMSSConfig = {
          ...DEFAULT_DISPLACEMENT_MSS_CONFIG,
          minBodyRatio: pairConfig.ictDisplacementMSSMinBodyRatio,
          minRangeATRMult: pairConfig.ictDisplacementMSSMinRangeATR,
          lookbackCandles: pairConfig.ictDisplacementMSSLookback,
        };
        // Build structure breaks from analysis for MSS validation
        const mssBreaks = [...(analysis.structure?.bos || []), ...(analysis.structure?.choch || [])]
          .map((b: any) => ({ index: b.index as number, type: b.type as "bullish" | "bearish" }));
        const mssDirection = analysis.direction === "long" ? "bullish" : "bearish";
        ictMSSResult = validateRecentMSS(candles, mssBreaks, mssDirection, mssConfig);
        const modeTag = pairConfig.ictDisplacementMSSGateMode.toUpperCase();
        const statusTag = ictMSSResult.isValid ? "VALID" : "INVALID";
        console.log(`[scan ${scanCycleId}] ${pair} ICT MSS [${modeTag}]: ${statusTag} — ${ictMSSResult.reason}`);
        (detail as any).ictMSS = {
          gateMode: pairConfig.ictDisplacementMSSGateMode,
          valid: ictMSSResult.isValid,
          reason: ictMSSResult.reason,
          displacementStrength: ictMSSResult.displacementStrength,
        };
      } catch (e: any) {
        console.warn(`[scan ${scanCycleId}] ${pair} ICT MSS error (non-fatal): ${e?.message}`);
        (detail as any).ictMSS = { gateMode: pairConfig.ictDisplacementMSSGateMode, valid: true, error: e?.message };
      }
    }

    // ── ICT Judas Swing Detection (log-only in "off" mode) ──
    let ictJudasResult: JudasSwingResult | null = null;
    if (pairConfig.ictJudasSwingEnabled) {
      try {
        const judasConfig: JudasSwingConfig = {
          ...DEFAULT_JUDAS_SWING_CONFIG,
          sweepLookback: pairConfig.ictJudasSwingLookback,
          minSweepDepthATR: pairConfig.ictJudasSwingMinDepthATR,
          requireCloseBack: pairConfig.ictJudasSwingRequireCloseBack,
        };
        const judasDirection = analysis.direction === "long" ? "bullish" : "bearish";
        // Find the most recent structure break index for Judas sweep lookback
        const allBreaks = [...(analysis.structure?.bos || []), ...(analysis.structure?.choch || [])];
        const alignedBreaks = allBreaks.filter((b: any) => b.type === judasDirection);
        const mssIndex = alignedBreaks.length > 0
          ? Math.max(...alignedBreaks.map((b: any) => b.index as number))
          : candles.length - 1;
        ictJudasResult = detectICTJudasSwing(candles, mssIndex, judasDirection, judasConfig);
        const modeTag = pairConfig.ictJudasSwingGateMode.toUpperCase();
        const statusTag = ictJudasResult.found ? "DETECTED" : "NOT_FOUND";
        console.log(`[scan ${scanCycleId}] ${pair} ICT Judas [${modeTag}]: ${statusTag} — ${ictJudasResult.reason}`);
        (detail as any).ictJudas = {
          gateMode: pairConfig.ictJudasSwingGateMode,
          detected: ictJudasResult.found,
          reason: ictJudasResult.reason,
          sweepLevel: ictJudasResult.sweep?.sweptLevel ?? null,
          sweepDepthATR: ictJudasResult.sweep?.wickDepthATR ?? null,
        };
      } catch (e: any) {
        console.warn(`[scan ${scanCycleId}] ${pair} ICT Judas error (non-fatal): ${e?.message}`);
        (detail as any).ictJudas = { gateMode: pairConfig.ictJudasSwingGateMode, detected: false, error: e?.message };
      }
    }

    // ── ICT FVG Invalidation (log-only in "off" mode) ──
    let ictFVGResult: (BatchFVGValidationResult & { validCount: number; invalidatedCount: number; exhaustedCount: number; totalCount: number }) | null = null;
    if (pairConfig.ictFVGInvalidationEnabled && analysis.fvgs && analysis.fvgs.length > 0) {
      try {
        const fvgConfig: FVGInvalidationConfig = {
          ...DEFAULT_FVG_INVALIDATION_CONFIG,
          bodyCloseOnly: pairConfig.ictFVGBodyCloseOnly,
          ruleOfTwo: pairConfig.ictFVGRuleOfTwo,
        };
        const fvgDirection = analysis.direction === "long" ? "bullish" : "bearish";
        const fvgsForValidation = analysis.fvgs.map((f: any) => ({
          index: f.index, high: f.high, low: f.low, type: f.type,
          midpoint: (f.high + f.low) / 2,
        }));
        const rawFVGResult = validateFVGBatch(fvgsForValidation, candles, fvgDirection, fvgConfig);
        // Derive count fields from results array (not on interface but needed downstream)
        const totalCount = rawFVGResult.results.length;
        const validCount = rawFVGResult.results.filter((r: any) => r.status === "fresh" || r.status === "first_touch").length;
        const invalidatedCount = rawFVGResult.results.filter((r: any) => r.status === "invalidated").length;
        const exhaustedCount = rawFVGResult.results.filter((r: any) => r.status === "exhausted").length;
        ictFVGResult = { ...rawFVGResult, validCount, invalidatedCount, exhaustedCount, totalCount };
        const modeTag = pairConfig.ictFVGInvalidationGateMode.toUpperCase();
        console.log(`[scan ${scanCycleId}] ${pair} ICT FVG [${modeTag}]: ${ictFVGResult.validCount}/${ictFVGResult.totalCount} valid, ${ictFVGResult.invalidatedCount} invalidated, ${ictFVGResult.exhaustedCount} exhausted`);
        (detail as any).ictFVG = {
          gateMode: pairConfig.ictFVGInvalidationGateMode,
          validCount: ictFVGResult.validCount,
          invalidatedCount: ictFVGResult.invalidatedCount,
          exhaustedCount: ictFVGResult.exhaustedCount,
          totalCount: ictFVGResult.totalCount,
        };
      } catch (e: any) {
        console.warn(`[scan ${scanCycleId}] ${pair} ICT FVG error (non-fatal): ${e?.message}`);
        (detail as any).ictFVG = { gateMode: pairConfig.ictFVGInvalidationGateMode, error: e?.message };
      }
    }

    // ── ICT Kill Zone Time Filter (log-only in "off" mode) ──
    let ictKZResult: ICTKillZoneResult | null = null;
    if (pairConfig.ictKillZoneEnabled) {
      try {
        const kzConfig: ICTKillZoneConfig = {
          ...DEFAULT_ICT_KILLZONE_CONFIG,
          enableSilverBullet: pairConfig.ictKillZoneSilverBullet,
          enablePMSession: pairConfig.ictKillZonePMSession,
        };
        ictKZResult = evaluateICTKillZone(new Date(), kzConfig);
        const modeTag = pairConfig.ictKillZoneGateMode.toUpperCase();
        const statusTag = ictKZResult.isKillZone ? `IN (${ictKZResult.windowLabel})` : `OUT (${ictKZResult.reason})`;
        console.log(`[scan ${scanCycleId}] ${pair} ICT KZ [${modeTag}]: ${statusTag}`);
        (detail as any).ictKillZone = {
          gateMode: pairConfig.ictKillZoneGateMode,
          inKillZone: ictKZResult.isKillZone,
          activeZone: ictKZResult.windowLabel,
          isPrime: ictKZResult.isPrime,
          reason: ictKZResult.reason,
        };
      } catch (e: any) {
        console.warn(`[scan ${scanCycleId}] ${pair} ICT KZ error (non-fatal): ${e?.message}`);
        (detail as any).ictKillZone = { gateMode: pairConfig.ictKillZoneGateMode, inKillZone: true, error: e?.message };
      }
    }

    // ── ICT Risk Assessment (log-only in "off" mode) ──
    let ictRiskResult: ICTRiskAssessment | null = null;
    if (pairConfig.ictRiskEnabled) {
      try {
        const riskConfig: ICTRiskConfig = {
          ...DEFAULT_ICT_RISK_CONFIG,
          baseRiskPercent: pairConfig.ictRiskBasePercent,
          drawdownHalving: pairConfig.ictRiskDrawdownHalving,
          maxConsecutiveLossesBeforeStop: pairConfig.ictRiskMaxConsecLosses,
          dailyLossLimit: pairConfig.ictRiskDailyLimit,
          weeklyLossLimit: pairConfig.ictRiskWeeklyLimit,
          maxTradesPerDay: pairConfig.ictRiskMaxTradesPerDay,
        };
        // Fetch recent trade history for risk assessment
        const { data: recentTrades } = await supabase
          .from("trade_history")
          .select("pnl_percent, closed_at")
          .eq("user_id", userId)
          .order("closed_at", { ascending: false })
          .limit(20);
        const tradePnLs = (recentTrades || []).map((t: any) => t.pnl_percent || 0);
        // Count consecutive losses from most recent trades
        let consecutiveLosses = 0;
        for (const pnl of tradePnLs) {
          if (pnl < 0) consecutiveLosses++;
          else break;
        }
        // Count trades today and compute daily/weekly PnL
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        weekStart.setHours(0, 0, 0, 0);
        const todayTrades = (recentTrades || []).filter((t: any) => new Date(t.closed_at) >= todayStart);
        const weekTrades = (recentTrades || []).filter((t: any) => new Date(t.closed_at) >= weekStart);
        const dailyPnLPercent = todayTrades.reduce((sum: number, t: any) => sum + (t.pnl_percent || 0), 0);
        const weeklyPnLPercent = weekTrades.reduce((sum: number, t: any) => sum + (t.pnl_percent || 0), 0);
        ictRiskResult = assessRisk({
          consecutiveLosses,
          tradesToday: todayTrades.length,
          dailyPnLPercent,
          weeklyPnLPercent,
          config: riskConfig,
        });
        const modeTag = "OFF"; // Risk is always informational for now
        console.log(`[scan ${scanCycleId}] ${pair} ICT Risk [${modeTag}]: canTrade=${ictRiskResult.canTrade}, riskPct=${(ictRiskResult.effectiveRiskPercent * 100).toFixed(2)}%, reasons=${ictRiskResult.reasons.join("; ")}`);
        (detail as any).ictRisk = {
          canTrade: ictRiskResult.canTrade,
          effectiveRiskPercent: ictRiskResult.effectiveRiskPercent,
          reasons: ictRiskResult.reasons,
          riskMultiplier: ictRiskResult.riskMultiplier,
        };
      } catch (e: any) {
        console.warn(`[scan ${scanCycleId}] ${pair} ICT Risk error (non-fatal): ${e?.message}`);
        (detail as any).ictRisk = { canTrade: true, error: e?.message };
      }
    }

    // ── Setup Staging: Check if this pair has a staged setup and handle promotion/invalidation ──
    const selectedZoneConceptEvidence = () => {
      const bestZone = (detail as any).impulseZone?.bestZone;
      const evidence = [
        bestZone?.evidence,
        ...(bestZone?.localConfluence?.items || []).map(
          (item: any) => item?.evidence,
        ),
      ].filter(Boolean);
      return Array.from(
        new Map(evidence.map((item: any) => [item.evidenceId, item])).values(),
      );
    };
    const entryZoneCandidateIdFor = (zone: any): string | null =>
      zone?.candidateModel?.candidateId ||
      zone?.localConfluence?.candidateId ||
      zone?.evidence?.entityId ||
      zone?.poi?.evidence?.entityId ||
      null;
    const entryZoneEvidenceIdsFor = (zone: any): string[] =>
      Array.from(new Set([
        zone?.evidence?.evidenceId,
        zone?.poi?.evidence?.evidenceId,
        ...(zone?.localConfluence?.items || []).map(
          (item: any) => item?.evidence?.evidenceId,
        ),
      ].filter((value): value is string =>
        typeof value === "string" && value.length > 0
      ))).sort();
    const entryZoneTimeframeFor = (zone: any): string | null =>
      zone?.timeframeLineage?.candidateTimeframe ||
      zone?.evidence?.timeframe ||
      zone?.poi?.evidence?.timeframe ||
      null;
    const entryZoneLifecycleFor = (zone: any): string | null =>
      zone?.candidateLifecycle?.state || null;
    const selectedZoneLocalConfluence = () =>
      (detail as any).impulseZone?.bestZone?.localConfluence ?? null;
    const selectedZoneShadowRanking = () =>
      (detail as any).impulseZone?.bestZone?.shadowRanking ?? null;
    const selectedZoneLocalEnforcement = () =>
      (detail as any).zoneLocalEnforcement ?? null;
    const nestedPoiSelection =
      (detail as any).impulseZone?.nestedPoiEntry || null;
    const frozenNestedPoiEntry: FrozenNestedPoiEntryPlan | null =
      nestedPoiActivation.enabled && nestedPoiSelection?.selected
        ? {
          ...nestedPoiSelection,
          mode: nestedPoiActivation.mode,
          route: nestedPoiActivation.enforced
            ? "nested_poi_market"
            : "observe",
          monitoringTimeframe: timeframeAuthority.runtimeEntry,
          direction: analysis.direction as "long" | "short",
          frozenAt: new Date().toISOString(),
        }
        : null;
    const nestedPoiExecutableZone = frozenNestedPoiEntry?.selected
      ? {
        candidateId: frozenNestedPoiEntry.selected.id,
        type: frozenNestedPoiEntry.selected.type,
        displayType:
          "NESTED-" + frozenNestedPoiEntry.selected.type.toUpperCase(),
        low: frozenNestedPoiEntry.selected.low,
        high: frozenNestedPoiEntry.selected.high,
        entry: frozenNestedPoiEntry.selected.entryPrice,
        timeframe: frozenNestedPoiEntry.selected.timeframe,
        triggerKind: frozenNestedPoiEntry.selected.geometry,
        parentZone: frozenNestedPoiEntry.outerZone,
      }
      : null;
    const nestedPoiLifecycleEnforced =
      nestedPoiActivation.enforced && nestedPoiExecutableZone !== null;
    (detail as any).nestedPoiMarket = {
      ...nestedPoiActivation,
      plan: frozenNestedPoiEntry,
      reason: nestedPoiSelection?.reason || "zone_unavailable",
    };
    const watchlistInvalidationFor = (
      direction: WatchlistDirection,
      originatingZone: unknown,
      proposedLevel: unknown,
      impulse?: unknown,
    ) =>
      deriveWatchlistInvalidation({
        direction,
        zone: originatingZone,
        impulse,
        proposedLevel,
        bufferPrice: adjustedSlBuffer *
          (SPECS[pair] || SPECS["EUR/USD"]).pipSize,
      });
    const selectedCrossTimeframeContext = (
      executableZone?: Record<string, unknown> | null,
      impulseEntryMode: "confirmation" | "nested_poi_market" = "confirmation",
    ) =>
      buildFrozenCrossTimeframeContext({
        timeframeEvidenceId: (detail as any).timeframeEvidenceId || null,
        symbol: pair,
        gamePlan: activeGamePlan,
        directionVerdict: activeDirectionVerdict,
        stylePolicy: pairStylePolicy,
        zoneStory: (detail as any).impulseZone || null,
        executableZone,
        evidenceCertificates: _evidenceCertificateReferences,
        crossTimeframeAuthority,
        timeframeEvidence: zoneEvidenceRows.find((row) =>
          row.id === (detail as any).timeframeEvidenceId
        ) || null,
        impulseEntryLifecycleMode: nestedPoiLifecycleEnforced
          ? "enforce"
          : impulseLifecycleEnforcement.effectiveMode,
        impulseEntryMode,
        nestedPoiMonitoringTimeframe: impulseEntryMode === "nested_poi_market"
          ? timeframeAuthority.runtimeEntry
          : pairStylePolicy.timeframes.roles.confirmation,
        confirmationMethod: pairConfig.confirmationMethod || "choch",
      });
    const validatePendingLifecycle = (
      frozenStrategyContext: any,
      executableZone: unknown,
      nestedEntryEnforced = nestedPoiLifecycleEnforced,
    ) => {
      const frozenContext = frozenStrategyContext?.crossTimeframeContext || null;
      const frozenLifecycleMode = frozenContext?.impulseEntryLifecycle?.mode ||
        frozenContext?.impulseEntryLifecycleAvailability?.mode ||
        "observe";
      return validateImpulseLifecycleExecutableZone({
        mode: nestedEntryEnforced ? "enforce" : frozenLifecycleMode,
        context: frozenContext,
        executableZone,
      });
    };
    const currentWatchlistLifecycle = (executionEligible: boolean) => {
      const lifecycleZoneData = (detail as any).unifiedZone;
      const lifecycleReasonCode =
        !executionEligible
          ? "monitoring_pre_zone"
          : lifecycleZoneData?.state === "waiting_for_sweep"
          ? "waiting_for_local_sweep"
          : lifecycleZoneData?.state === "waiting_for_reconfirmation"
          ? "waiting_for_reconfirmation"
          : "waiting_for_zone_confirmation";
      const phase = deriveWatchlistLifecyclePhase({
        executionEligible,
        hasZone: lifecycleZoneData?.hasZone === true ||
          !!(detail as any).impulseZone?.bestZone,
        unifiedState: lifecycleZoneData?.state || null,
        priceAtZone: lifecycleZoneData?.price?.atZone === true ||
          (detail as any).impulseZone?.bestZone?.priceAtZone === true,
        entryTriggerState:
          lifecycleZoneData?.liquidity?.entryTriggerState || null,
        confirmationReady:
          lifecycleZoneData?.confirmation?.entryReady === true,
      });
      const lifecycleEvidence = buildWatchlistLifecycleEvidence({
        reasonCode: lifecycleReasonCode,
        phase: phase.phase,
        milestones: phase.milestones,
        observedPrice: analysis.lastPrice,
        frozenDirection: analysis.direction as WatchlistDirection,
        sweep: (detail as any).unifiedZone?.liquidity || null,
        detail: {
          unifiedState: lifecycleZoneData?.state || null,
          selectedTimeframe: lifecycleZoneData?.selectedTF || null,
        },
      });
      return {
        lifecycleReasonCode,
        lifecycleEvidence,
        lifecyclePhase: phase.phase,
      };
    };
    const stagedDecisionFields = (
      originatingZone: Record<string, unknown> | null,
      executionEligible = true,
      frozenEntryZone: Record<string, unknown> | null = originatingZone,
    ) => {
      const setupId = crypto.randomUUID();
      const candidateId = crypto.randomUUID();
      const pairPlan = activeGamePlan?.plans?.find(
        (plan: InstrumentGamePlan) => plan.symbol === pair,
      );
      const frozenStrategyContext = buildFrozenSetupStrategyContext({
        identity: { setupId, candidateId },
        timeframeEvidenceId: (detail as any).timeframeEvidenceId || null,
        symbol: pair,
        direction: analysis.direction as "long" | "short",
        stylePolicy: pairStylePolicy,
        runtimeConfig: pairRuntimeConfigSnapshot,
        decisionContext: (detail as any).decisionContext || null,
        gamePlan: activeGamePlan,
        directionVerdict: activeDirectionVerdict,
        conceptEvidence: selectedZoneConceptEvidence(),
        zoneLocalConfluence: selectedZoneLocalConfluence(),
        zoneCandidateShadowRanking: selectedZoneShadowRanking(),
        zoneLocalEnforcement: selectedZoneLocalEnforcement(),
        crossTimeframeContext: selectedCrossTimeframeContext(
          nestedPoiActivation.enforced && nestedPoiExecutableZone
            ? nestedPoiExecutableZone
            : originatingZone,
          nestedPoiLifecycleEnforced
            ? "nested_poi_market"
            : "confirmation",
        ),
        nestedPoiEntry: frozenNestedPoiEntry,
        entryZone: frozenEntryZone,
        confirmationMethod: pairConfig.confirmationMethod || "choch",
        indicatorMinCount: pairConfig.indicatorMinCount || 3,
        liquiditySweepRole: pairConfig.requireLiquiditySweep ? "required" : "supporting",
        displacementRole: pairConfig.ictDisplacementMSSGateMode === "hard" ? "required" : "supporting",
        reversalPatternRole: "supporting",
        afterChochEntryMode: pairConfig.afterChochMode,
      });
      const frozenLiquidityState = (detail as any).unifiedZone?.liquidity?.entryTriggerState || "none";
      const watchCanonicalState = projectCanonicalScannerState({
        evaluatedAt: new Date().toISOString(),
        identity: { candidateId, symbol: pair, direction: analysis.direction as "long" | "short" },
        direction: {
          available: !!activeDirectionVerdict?.verdict,
          allowed: activeDirectionVerdict?.shouldBlock == null ? null :
            !activeDirectionVerdict.shouldBlock && activeDirectionVerdict.verdict === analysis.direction,
          evidenceId: activeDirectionVerdict?.id || null,
        },
        zone: {
          available: (detail as any).unifiedZone?.hasZone === true || (detail as any).impulseZone?.hasZone === true,
          valid: true,
          atPoi: (detail as any).unifiedZone?.price?.atZone === true || (detail as any).impulseZone?.bestZone?.priceAtZone === true,
          evidenceId: candidateId,
        },
        location: {
          required: (pairConfig.dealingRangeMode || "avoid_wrong_side") !== "off",
          available: (detail as any).canonicalDealingRangeObservation?.canonical?.available === true,
          allowed: (detail as any).canonicalDealingRangeObservation?.canonical?.allowed ?? null,
          evidenceId: (detail as any).canonicalDealingRangeObservation?.canonical?.range?.impulseId || null,
        },
        liquidity: {
          policy: frozenStrategyContext.liquidityActivation.role,
          state: ["unswept", "swept_rejected", "swept_absorbed"].includes(frozenLiquidityState) ? frozenLiquidityState : "none",
        },
        confirmation: { required: true, passed: (detail as any).unifiedZone?.confirmation?.entryReady === true },
        thesis: { required: false, valid: true },
        safety: { complete: false, passed: null },
        execution: { authorized: false },
      });
      const {
        lifecycleReasonCode,
        lifecycleEvidence,
        lifecyclePhase,
      } = currentWatchlistLifecycle(executionEligible);
      (detail as any).linkedSetupId = setupId;
      return {
        id: setupId,
        candidate_id: candidateId,
        game_plan_id: pairPlan?.gamePlanId ||
          activeDirectionVerdict?.gamePlanId ||
          null,
        game_plan_version: pairPlan?.planVersion ||
          activeDirectionVerdict?.gamePlanVersion ||
          activeGamePlan?.planVersion ||
          null,
        direction_verdict_id: activeDirectionVerdict?.id || null,
        direction_verdict: (detail as any).directionVerdict || null,
        thesis_version: THESIS_VALIDATION_VERSION,
        originating_zone: originatingZone,
        confirmation_method: pairConfig.confirmationMethod || "choch",
        confirmation_config: {
          indicatorMinCount: pairConfig.indicatorMinCount || 3,
          afterChochMode: pairConfig.afterChochMode || "confirmation_close",
          afterChochExpiryMinutes: pairConfig.afterChochExpiryMinutes || 30,
          maxConfirmationAttempts:
            pairStylePolicy.lifecycle.maxConfirmationAttempts,
        },
        frozen_strategy_context: frozenStrategyContext,
        authorization_result: {
          contractVersion: TRADE_DECISION_CONTRACT_VERSION,
          stage: "watching",
          authorized: false,
          reason: "Setup is observational until qualification",
          stylePolicy: pairStylePolicy,
          frozenStrategyContext,
          canonicalScannerState: watchCanonicalState,
          tradeDecisionPresentation: buildTradeDecisionPresentation({ state: watchCanonicalState }),
        },
        style_policy_version: pairStylePolicy.contractVersion,
        style_base_policy_hash: pairStylePolicy.basePolicyHash,
        style_policy_hash: pairStylePolicy.policyHash,
        style_policy: pairStylePolicy,
        lifecycle_phase: lifecyclePhase,
        lifecycle_reason_code: lifecycleReasonCode,
        lifecycle_reason: lifecycleReasonCode === "monitoring_pre_zone"
          ? "Monitoring directional candidate; no executable zone is frozen"
          : lifecycleEvidence.sweep
          ? String(
            (lifecycleEvidence.sweep as Record<string, unknown>).gateReason ||
              "Frozen zone retained; waiting for price and confirmation",
          )
          : "Frozen zone retained; waiting for price and confirmation",
        lifecycle_evidence: lifecycleEvidence,
      };
    };
    const currentPendingCandidate = (activePendingOrders || []).find((pending: any) =>
      pending.symbol === pair && pending.direction === analysis.direction &&
      ["pending", "awaiting_confirmation"].includes(pending.status)
    );
    const currentNestedPendingCandidate = (activePendingOrders || []).find(
      (pending: any) =>
        pending.symbol === pair &&
        ["pending", "awaiting_confirmation"].includes(pending.status) &&
        resolvePendingNestedPoiEntryPlanState(pending).declared,
    );
    const currentPendingNestedPoiPlanState = currentNestedPendingCandidate
      ? resolvePendingNestedPoiEntryPlanState(currentNestedPendingCandidate)
      : null;
    const currentPendingOwnsNestedPoiRoute =
      currentPendingNestedPoiPlanState?.declared === true;
    const stagedKey = analysis.direction ? `${pair}:${analysis.direction}` : null;
    const existingStaged = stagedKey ? stagedMap.get(stagedKey) : null;
    if (currentPendingCandidate || existingStaged) {
      // Presentation linkage only: expose the already-persisted identities so
      // scan, staged, pending, and lifecycle views can join the same setup.
      // This does not participate in qualification or authorization.
      detail.setupIdentity = {
        orderId: currentPendingCandidate?.order_id || null,
        stagedSetupId:
          currentPendingCandidate?.staged_setup_id || existingStaged?.id || null,
        candidateId:
          currentPendingCandidate?.candidate_id ||
          existingStaged?.candidate_id ||
          null,
        impulseEntryLifecycleId:
          currentPendingCandidate?.impulse_entry_lifecycle_id ||
          existingStaged?.impulse_entry_lifecycle_id ||
          null,
      };
    }
    const stagedNestedPoiPlanState = existingStaged
      ? resolvePendingNestedPoiEntryPlanState(existingStaged)
      : null;
    const stagedFrozenNestedPoiEntry = stagedNestedPoiPlanState?.valid
      ? stagedNestedPoiPlanState.plan
      : null;
    const stagedNestedPoiActivation = stagedFrozenNestedPoiEntry
      ? resolveFrozenNestedPoiMarketRoute({
        mode: stagedFrozenNestedPoiEntry.mode,
        route: stagedFrozenNestedPoiEntry.route,
        runtimeTarget: account.execution_mode === "live" ? "live" : "paper",
      })
      : resolveFrozenNestedPoiMarketRoute({
        mode: "off",
        route: null,
        runtimeTarget: account.execution_mode === "live" ? "live" : "paper",
      });
    // Existing setup identity owns its rollout mode. Runtime settings only
    // select the mode for a setup created by this scan.
    const effectiveNestedPoiActivation = existingStaged
      ? stagedNestedPoiActivation
      : nestedPoiActivation;
    const effectiveFrozenNestedPoiEntry = existingStaged
      ? stagedFrozenNestedPoiEntry
      : frozenNestedPoiEntry;
    const effectiveNestedPoiExecutableZone =
      effectiveFrozenNestedPoiEntry?.selected
        ? {
          candidateId: effectiveFrozenNestedPoiEntry.selected.id,
          type: effectiveFrozenNestedPoiEntry.selected.type,
          displayType: "NESTED-" +
            effectiveFrozenNestedPoiEntry.selected.type.toUpperCase(),
          low: effectiveFrozenNestedPoiEntry.selected.low,
          high: effectiveFrozenNestedPoiEntry.selected.high,
          entry: effectiveFrozenNestedPoiEntry.selected.entryPrice,
          timeframe: effectiveFrozenNestedPoiEntry.selected.timeframe,
          triggerKind: effectiveFrozenNestedPoiEntry.selected.geometry,
          parentZone: effectiveFrozenNestedPoiEntry.outerZone,
        }
        : null;
    const effectiveNestedPoiLifecycleEnforced =
      effectiveNestedPoiActivation.enforced &&
      effectiveNestedPoiExecutableZone !== null;
    const stagedNestedPoiRuntimeMismatch = existingStaged &&
      stagedNestedPoiActivation?.runtimeTargetMismatch === true;
    if (stagedNestedPoiPlanState && !stagedNestedPoiPlanState.valid) {
      detail.status = "skipped_nested_poi_frozen_plan_unavailable";
      detail.skipReason = stagedNestedPoiPlanState.reason;
      scanDetails.push(detail);
      continue;
    }
    if (stagedNestedPoiRuntimeMismatch) {
      detail.status = "skipped_nested_poi_runtime_target_mismatch";
      detail.skipReason =
        "Frozen nested POI setup is paper-only and cannot be converted to live execution";
      scanDetails.push(detail);
      continue;
    }
    const stagedCandidatesForPair = stagedByPair.get(pair) || [];

    // A fresh direction disagreement is evidence for the next scan, not proof
    // that a frozen Watchlist thesis has failed. Preserve the candidate until
    // its own structural boundary, TTL, or an explicit lifecycle rule resolves
    // it. This is especially important during an expected lower-TF retracement.
    if (analysis.direction && stagingEnabled) {
      const oppositeDir = analysis.direction === "long" ? "short" : "long";
      const oppositeStaged = stagedMap.get(`${pair}:${oppositeDir}`);
      if (oppositeStaged) {
        const continuityEvidence = buildWatchlistLifecycleEvidence({
          reasonCode: "fresh_direction_disagreement_retained",
          observedPrice: analysis.lastPrice,
          frozenDirection: oppositeDir,
          freshDirection: analysis.direction,
          detail: {
            candidateId:
              oppositeStaged.candidate_id || oppositeStaged.id,
            action: "retained",
          },
        });
        (detail as any).frozenCandidateContinuity = {
          candidateId: oppositeStaged.candidate_id || oppositeStaged.id,
          frozenDirection: oppositeDir,
          freshDirection: analysis.direction,
          action: "retained",
          reason:
            "Fresh direction disagreement does not invalidate frozen zone structure",
        };
        try {
          await supabase.from("staged_setups").update({
            lifecycle_reason:
              `Frozen ${oppositeDir} candidate retained during fresh ${analysis.direction} scan`,
            lifecycle_reason_code:
              "fresh_direction_disagreement_retained",
            lifecycle_evidence: continuityEvidence,
            last_eval_at: continuityEvidence.observedAt,
          }).eq("id", oppositeStaged.id).eq("user_id", userId);
        } catch (e: any) {
          console.warn(
            `[staging] Failed to record direction-disagreement continuity for ${pair}: ${e?.message}`,
          );
        }
        console.log(
          `[staging] Retained frozen ${pair} ${oppositeDir} candidate during fresh ${analysis.direction} scan — awaiting structural resolution`,
        );
      }
    }

    // Evaluate every frozen candidate for the pair, even when the fresh scan is
    // neutral or points the other way. Candidate lookup must not depend on a
    // newly computed direction.
    let matchingCandidateInvalidated = false;
    for (const stagedCandidate of stagedCandidatesForPair) {
      if (
        stagedCandidate.execution_eligible === false ||
        !stagedCandidate.sl_level ||
        !stagingEnabled
      ) continue;
      const storedLevel = parseFloat(stagedCandidate.sl_level);
      const frozenImpulse =
        stagedCandidate.analysis_snapshot?.impulseZone?.impulse ||
        stagedCandidate.analysis_snapshot?.impulse ||
        null;
      const invalidation = watchlistInvalidationFor(
        stagedCandidate.direction as WatchlistDirection,
        stagedCandidate.originating_zone,
        storedLevel,
        frozenImpulse,
      );
      const boundaryLevel = invalidation.level;
      const boundaryChanged = boundaryLevel !== null &&
        Number.isFinite(storedLevel) &&
        Math.abs(boundaryLevel - storedLevel) > Number.EPSILON;
      const boundaryBreached = boundaryLevel !== null &&
        isWatchlistInvalidated(
          stagedCandidate.direction as WatchlistDirection,
          analysis.lastPrice,
          boundaryLevel,
        );
      if (boundaryBreached) {
        try {
          const invalidatedAt = new Date().toISOString();
          const lifecycleEvidence = buildWatchlistLifecycleEvidence({
            reasonCode: "structural_boundary_breached",
            observedAt: invalidatedAt,
            observedPrice: analysis.lastPrice,
            frozenDirection:
              stagedCandidate.direction as WatchlistDirection,
            freshDirection:
              analysis.direction as WatchlistDirection | null,
            invalidation,
            detail: {
              candidateId:
                stagedCandidate.candidate_id || stagedCandidate.id,
            },
          });
          const lifecycleReason =
            `Structural invalidation breached before entry (price ${analysis.lastPrice.toFixed(5)} vs boundary ${boundaryLevel.toFixed(5)}; source ${invalidation.source})`;
          await supabase.from("staged_setups").update({
            status: "invalidated",
            sl_level: boundaryLevel,
            invalidation_reason: lifecycleReason,
            lifecycle_reason: lifecycleReason,
            lifecycle_reason_code: "structural_boundary_breached",
            lifecycle_evidence: lifecycleEvidence,
            resolved_at: invalidatedAt,
          }).eq("id", stagedCandidate.id).eq("user_id", userId);
          stagedInvalidated++;
          stagedMap.delete(`${pair}:${stagedCandidate.direction}`);
          if (stagedCandidate.id === existingStaged?.id) {
            matchingCandidateInvalidated = true;
          }
          console.log(
            `[staging] Invalidated ${pair} ${stagedCandidate.direction} — structural boundary breached (${analysis.lastPrice.toFixed(5)} vs ${boundaryLevel.toFixed(5)}, ${invalidation.source})`,
          );
        } catch (e: any) {
          console.warn(
            `[staging] Failed to invalidate structurally breached ${pair}: ${e?.message}`,
          );
        }
        if (stagedCandidate.id === existingStaged?.id) {
          detail.status = "staged_invalidated";
          detail.reason =
            `Staged setup invalidated — structural boundary breached before entry`;
          detail.staging = {
            action: "invalidated",
            reason: "structural_invalidation_breached",
            boundary: boundaryLevel,
            source: invalidation.source,
          };
        }
      } else if (boundaryChanged) {
        try {
          const repairedAt = new Date().toISOString();
          await supabase.from("staged_setups").update({
            sl_level: boundaryLevel,
            lifecycle_reason:
              `Legacy Watchlist boundary repaired to frozen structural boundary ${boundaryLevel.toFixed(5)}`,
            lifecycle_reason_code: "structural_boundary_repaired",
            lifecycle_evidence: buildWatchlistLifecycleEvidence({
              reasonCode: "structural_boundary_repaired",
              observedAt: repairedAt,
              observedPrice: analysis.lastPrice,
              frozenDirection:
                stagedCandidate.direction as WatchlistDirection,
              freshDirection:
                analysis.direction as WatchlistDirection | null,
              invalidation,
              detail: {
                previousBoundary: storedLevel,
                repairedBoundary: boundaryLevel,
              },
            }),
            last_eval_at: repairedAt,
          }).eq("id", stagedCandidate.id).eq("user_id", userId);
          stagedCandidate.sl_level = boundaryLevel;
          console.log(
            `[staging] Repaired ${pair} ${stagedCandidate.direction} Watchlist boundary ${storedLevel.toFixed(5)} → ${boundaryLevel.toFixed(5)} (${invalidation.source})`,
          );
        } catch (e: any) {
          console.warn(
            `[staging] Failed to repair ${pair} Watchlist boundary: ${e?.message}`,
          );
        }
      }
    }
    if (matchingCandidateInvalidated) {
      scanDetails.push(detail);
      continue;
    }

    // Apply FOTSI penalty (softened from hard veto to score reduction)
    // Compute before threshold/staging checks so penalty actually affects trade qualification.
    let fotsiPenalty = 0;
    if (_fotsiResult && pairConfig.useFOTSI !== false && analysis.direction) {
      const _fotsiCurrencies = parsePairCurrencies(pair);
      if (_fotsiCurrencies) {
        const [_fBase, _fQuote] = _fotsiCurrencies;
        const _fDir = analysis.direction === "long" ? "BUY" : "SELL";
        const _fVeto = checkOverboughtOversoldVeto(
          _fBase, _fQuote, _fDir as "BUY" | "SELL",
          _fotsiResult.strengths, _fotsiResult.series,
        );
        if (_fVeto.vetoed) {
          fotsiPenalty = -2.0; // Heavy penalty but not a hard block
        }
      }
    }
    // (Direction Verdict moved earlier — before zone engine — see line ~4336)
    // ── UNIFIED ZONE GATE (primary signal source) ──
    // The unified engine composes impulse zone + liquidity + confirmation into one story.
    // When its state is 'triggered' or 'confirmed' AND entryReady=true, it becomes the
    // primary signal source. Otherwise, fall through to impulse zone gate.
    let unifiedGatePassed = false;
    const unifiedZoneData = (detail as any).unifiedZone;

    // Swing trader: cascade zone engine takes priority over unified zone engine.
    // The cascade engine (Daily→4H→1H) is more selective and produces higher-quality entries.
    // Backtest validated: 8 trades, 75% WR, PF 8.88, +28.3% over 9 months.
    if (resolvedStyle === "swing_trader" && cascadeResult?.state === "triggered" && cascadeResult.priceAtEntry) {
      unifiedGatePassed = true;
      (detail as any).signalSource = "cascade";
      console.log(`[scan ${scanCycleId}] \u2705 ${pair}: CASCADE GATE PASSED [triggered] \u2014 Daily\u21924H\u21921H cascade complete, entry=${cascadeResult.entry?.toFixed(5)}, SL=${cascadeResult.sl?.toFixed(5)}`);
    } else if (unifiedZoneData?.hasZone &&
        (unifiedZoneData.state === "triggered" || unifiedZoneData.state === "confirmed") &&
        unifiedZoneData.confirmation?.entryReady === true) {
      unifiedGatePassed = true;
      (detail as any).signalSource = "unified";
      console.log(`[scan ${scanCycleId}] \u2705 ${pair}: UNIFIED GATE PASSED [${unifiedZoneData.state}] \u2014 score ${unifiedZoneData.unifiedScore}/14, confirmation: ${unifiedZoneData.confirmation.type}`);
    } else {
      (detail as any).signalSource = "standalone";
    }

    // ── Impulse Zone Gate (configurable: hard / soft / off) ──
    // "hard" mode: no valid zone OR price not at zone → skip pair entirely (sniper approach)
    // "soft" mode: penalty/bonus scoring adjustment (legacy behavior)
    // "off" mode: impulse zone is purely informational
    let impulseZonePenaltyVal = 0;
    const izGateMode = pairConfig.impulseZoneGateMode ?? "hard";
    const izData = (detail as any).impulseZone;
    const zoneLocalDecision = evaluateZoneLocalEnforcement({
      requestedMode: pairConfig.zoneLocalEnforcementMode,
      runtimeTarget: account.execution_mode === "live" ? "live" : "paper",
      activation: zoneLocalActivation,
      ranking: izData?.bestZone?.shadowRanking ?? null,
      softPenalty: pairConfig.zoneLocalSoftPenalty,
      minimumLocalScore: pairConfig.zoneLocalMinimumScore,
    });
    const crossTimeframeEntryDecision =
      evaluateCrossTimeframeEntryAuthority({
        authorityResolution: crossTimeframeAuthority,
        evaluation: izData?.bestZone
          ? evaluateCrossTimeframeShadowCandidate(
            izData.bestZone,
            crossTimeframeAuthority.policy,
          )
          : null,
        candidateId:
          izData?.bestZone?.candidateModel?.candidateId ||
          izData?.bestZone?.localConfluence?.candidateId ||
          null,
      });
    (detail as any).crossTimeframeEntryAuthority =
      crossTimeframeEntryDecision;
    (detail as any).zoneLocalEnforcement = zoneLocalDecision;
    // ── Gameplan hierarchy shadow audit ─────────────────────────────────────
    // Observability only: this result is persisted for later outcome analysis,
    // but it is never read by scoring, gates, sizing, or execution.
    const shadowPairPlan = activeGamePlan?.plans?.find(
      (plan: InstrumentGamePlan) => plan.symbol === pair,
    ) || null;
    (detail as any).gamePlanShadowAudit = evaluateGamePlanShadowAudit({
      plan: shadowPairPlan ? {
        bias: shadowPairPlan.bias,
        legacyConfidence: shadowPairPlan.biasConfidence,
        state: shadowPairPlan.state,
        stateReason: shadowPairPlan.stateReason,
        tradeable: shadowPairPlan.tradeable,
        conviction: shadowPairPlan.conviction,
      } : null,
      direction: analysis.direction === "long" || analysis.direction === "short"
        ? analysis.direction
        : null,
      directionVerdict: directionVerdict ? {
        verdict: directionVerdict.verdict,
        confidence: directionVerdict.confidence,
        shouldBlock: directionVerdict.shouldBlock,
      } : null,
      impulseZone: {
        hasZone: !!izData?.hasZone,
        entryReady: unifiedGatePassed
          || izData?.bestZone?.priceAtZoneStrict === true,
        score: unifiedZoneData?.unifiedScore ?? izData?.bestZone?.totalScore ?? null,
        fibDepth: izData?.bestZone?.fibDepth ?? null,
        selectedTimeframe: unifiedZoneData?.selectedTF ?? izData?.selectedTF ?? null,
        // The current Impulse Zone engine does not expose a computed freshness
        // verdict. Preserve its source timing so freshness can be calibrated
        // from real outcomes instead of inventing a boolean.
        isFresh: null,
        impulseEndDate: izData?.impulse?.endDate ?? null,
        impulseSpanBars: izData?.impulse?.spanBars ?? null,
      },
    });

    const zoneStopPolicyResolution = resolveZoneStopPolicyMode(
      (pairConfig as any).zoneSetupStopPolicyMode,
      account.execution_mode === "live" ? "live" : "paper",
    );
    const zoneStopPolicySpec = SPECS[pair] || SPECS["EUR/USD"];
    const zoneStopPolicyConfirmationAtr = calculateATR(
      roleCandles.confirmation,
      pairConfig.slATRPeriod || 14,
    );
    const enforcedZoneStopPolicyFor = (
      structuralInvalidation: number,
    ): StopPolicyShadowInput | undefined => zoneStopPolicyResolution.enforced
      ? {
        observationOnly: false,
        structuralInvalidation,
        confirmationAtr: zoneStopPolicyConfirmationAtr,
        atrMultiplier: 1.5,
        executionFloorQuoteDistance:
          Number(zoneStopPolicySpec.typicalSpread || 0) * zoneStopPolicySpec.pipSize * 1.5,
        executionFloorSource: "spread_proxy",
        riskCapAtrMultiplier: resolvedStyle === "swing_trader" ? 6 : 4,
      }
      : undefined;

    // Observation only: capture the first evaluation of each deterministic
    // zone candidate before any watch/reject branch can remove it.
    if (analysis.direction && izData?.bestZone) {
      try {
        const candidateId = izData.bestZone.candidateModel?.candidateId ||
          izData.bestZone.localConfluence?.candidateId || null;
        if (candidateId) {
          const spec = SPECS[pair] || SPECS["EUR/USD"];
          const zone = {
            price: Number(izData.bestZone.refinedEntry ??
              ((izData.bestZone.high + izData.bestZone.low) / 2)),
            zoneType: String(izData.bestZone.type || "impulse_zone"),
            zoneLow: Number(izData.bestZone.low),
            zoneHigh: Number(izData.bestZone.high),
          };
          const structural = watchlistInvalidationFor(
            analysis.direction as WatchlistDirection,
            { type: zone.zoneType, low: zone.zoneLow, high: zone.zoneHigh, entry: zone.price },
            analysis.direction === "long" ? izData.impulse?.low : izData.impulse?.high,
            izData.impulse,
          );
          const structuralLevel = Number(structural.level);
          if (!Number.isFinite(structuralLevel) || structuralLevel <= 0) {
            throw new Error("structural invalidation unavailable");
          }
          const currentPlanResult = buildConfiguredPreArmedPlan({
            direction: analysis.direction as "long" | "short",
            zone,
            structuralInvalidation: structuralLevel,
            preferredPositionStop: analysis.stopLoss,
            symbol: pair,
            atrValue: (analysis as any).atrValue,
            config: pairConfig,
            analysis,
          });
          const confirmationAtr = calculateATR(
            roleCandles.confirmation,
            pairConfig.slATRPeriod || 14,
          );
          const spreadPips = Number(spec.typicalSpread || 0);
          const spreadSafetyMultiplier = 1.5;
          const executionFloorQuoteDistance = spreadPips * spec.pipSize * spreadSafetyMultiplier;
          const riskCapAtrMultiplier = resolvedStyle === "swing_trader" ? 6 : 4;
          const gamePlanContext = (pairConfig as any)._gamePlanContext;
          const dolTargets = (pairConfig as any).dolTPExtensionEnabled !== false && gamePlanContext?.dol
            ? (Array.isArray(gamePlanContext.dol) ? gamePlanContext.dol : [gamePlanContext.dol])
            : undefined;
          const shadowResult = calculateSLTP({
            direction: analysis.direction as "long" | "short",
            lastPrice: zone.price,
            pipSize: spec.pipSize,
            config: pairConfig,
            swings: analysis.structure?.swingPoints || [],
            orderBlocks: analysis.orderBlocks || [],
            liquidityPools: analysis.liquidityPools || [],
            pdLevels: analysis.pdLevels || null,
            atrValue: confirmationAtr,
            fvgs: analysis.fvgs || [],
            fibExtensions: analysis.fibLevels?.extensions,
            dolTargets,
            stopPolicyShadow: {
              structuralInvalidation: structuralLevel,
              confirmationAtr,
              atrMultiplier: 1.5,
              executionFloorQuoteDistance,
              executionFloorSource: "spread_proxy",
              riskCapAtrMultiplier,
            },
          });

          const toPlanObservation = (
            result: any,
            shadowValid?: boolean,
            shadowReason?: string | null,
          ): StopPolicyPlanObservation => {
            if (!result?.valid || shadowValid === false) {
              return {
                valid: false,
                stopLoss: Number.isFinite(Number(result?.plan?.stopLoss))
                  ? Number(result.plan.stopLoss) : null,
                takeProfit: Number.isFinite(Number(result?.plan?.takeProfit))
                  ? Number(result.plan.takeProfit) : null,
                riskReward: Number.isFinite(Number(result?.plan?.riskReward))
                  ? Number(result.plan.riskReward) : null,
                takeProfitSource: result?.takeProfitSource || null,
                takeProfitFallbackReason: result?.takeProfitFallbackReason || null,
                reason: shadowReason || result?.reason || "plan_unavailable",
              };
            }
            return {
              valid: true,
              stopLoss: Number(result.plan.stopLoss),
              takeProfit: Number(result.plan.takeProfit),
              riskReward: Number(result.plan.riskReward),
              takeProfitSource: result.takeProfitSource || null,
              takeProfitFallbackReason: result.takeProfitFallbackReason || null,
              reason: null,
            };
          };
          const shadowStop = Number(shadowResult.stopLoss);
          const shadowTarget = Number(shadowResult.takeProfit);
          const shadowRisk = Math.abs(zone.price - shadowStop);
          const shadowPlanResult = {
            valid: Number.isFinite(shadowStop) && Number.isFinite(shadowTarget) && shadowRisk > 0,
            plan: {
              stopLoss: shadowStop,
              takeProfit: shadowTarget,
              riskReward: shadowRisk > 0
                ? Math.abs(shadowTarget - zone.price) / shadowRisk
                : Number.NaN,
            },
            takeProfitSource: shadowResult.takeProfitSource,
            takeProfitFallbackReason: shadowResult.takeProfitFallbackReason,
          };
          const shadow = shadowResult.stopPolicyShadow;
          if (shadow) {
            await persistStopPolicyEvidence(supabase, {
              userId,
              botId: BOT_ID,
              scanCycleId,
              candidateId,
              symbol: pair,
              direction: analysis.direction as "long" | "short",
              tradingStyle: resolvedStyle,
              setupSource: String((detail as any).signalSource || "standalone"),
              confirmationTimeframe: timeframeAuthority.roles.confirmation,
              observedAt: new Date().toISOString(),
              entryPrice: zone.price,
              structuralInvalidation: structuralLevel,
              confirmationAtr,
              pipSize: spec.pipSize,
              spreadPips,
              spreadSource: "spec_proxy",
              spreadSafetyMultiplier,
              executionFloorQuoteDistance,
              executionFloorSource: "spread_proxy",
              currentPlan: toPlanObservation(currentPlanResult),
              shadowPlan: toPlanObservation(shadowPlanResult, shadow.valid, shadow.reason),
              shadow,
            });
          }
        }
      } catch (stopPolicyEvidenceError: any) {
        console.warn(`[stop-policy-evidence] ${pair}: ${stopPolicyEvidenceError?.message}`);
      }
    }

    // An armed nested route owns its frozen candidate until its lifecycle
    // reaches a terminal state. Current settings or a newly ranked zone may
    // refresh diagnostics, but must not stage, claim, or supersede that order.
    if (currentPendingOwnsNestedPoiRoute) {
      detail.status = currentNestedPendingCandidate?.status ===
          "awaiting_confirmation"
        ? "hunting_confirmation"
        : "watching_zone";
      detail.skipReason = currentPendingNestedPoiPlanState?.valid
        ? "Existing frozen Nested POI pending order retained; current settings and geometry cannot replace it"
        : "Existing Nested POI route failed closed earlier this scan; legacy entry fallback is disabled";
      scanDetails.push(detail);
      continue;
    }

    const stageUnifiedWatch = async (
      executionEligible: boolean,
    ): Promise<"created" | "updated" | "handoff" | "failed"> => {
      if (!stagingEnabled || isPaused || !analysis.direction) return "failed";
      const isCascade = (detail as any).signalSource === "cascade";
      const unifiedZone = unifiedZoneData?.zone;
      const cascadeZone = cascadeResult?.entryZone?.poi;
      const selectedEntryZoneEvidence = isCascade
        ? cascadeResult?.entryZone
        : izData?.bestZone;
      const unifiedEntry = unifiedZoneData?.entry;
      const entryPrice = isCascade
        ? cascadeResult?.entry ?? analysis.lastPrice
        : unifiedEntry?.entryPrice ??
          (unifiedZone
            ? (unifiedZone.high + unifiedZone.low) / 2
            : analysis.lastPrice);
      const stopLoss = isCascade
        ? cascadeResult?.sl ?? analysis.stopLoss
        : unifiedEntry?.slPrice ??
          (unifiedZoneData?.impulse
            ? analysis.direction === "long"
              ? unifiedZoneData.impulse.low
              : unifiedZoneData.impulse.high
            : analysis.stopLoss);
      const takeProfit = isCascade
        ? analysis.takeProfit
        : unifiedEntry?.tpPrice ?? analysis.takeProfit;
      const originatingZone = executionEligible
        ? {
          setupFamily: isCascade ? "cascade" : "impulse",
          candidateId: entryZoneCandidateIdFor(selectedEntryZoneEvidence),
          sourceEvidenceIds: entryZoneEvidenceIdsFor(
            selectedEntryZoneEvidence,
          ),
          sourceImpulseId:
            (detail as any).canonicalDealingRangeObservation?.canonical?.range
              ?.impulseId || null,
          type: isCascade
            ? cascadeZone?.type || "cascade_zone"
            : unifiedZone?.type || "unified_zone",
          low: isCascade ? cascadeZone?.low ?? null : unifiedZone?.low ?? null,
          high: isCascade
            ? cascadeZone?.high ?? null
            : unifiedZone?.high ?? null,
          entry: entryPrice,
          stopLoss,
          takeProfit,
          timeframe: entryZoneTimeframeFor(selectedEntryZoneEvidence) ||
            (isCascade ? null : unifiedZoneData?.selectedTF || null),
          lifecycle: entryZoneLifecycleFor(selectedEntryZoneEvidence),
          selectedTimeframe: isCascade
            ? "cascade"
            : unifiedZoneData?.selectedTF || null,
          unifiedState: isCascade
            ? cascadeResult?.state || null
            : unifiedZoneData?.state || null,
          signalSource: isCascade ? "cascade" : "unified",
          executionEligible: true,
        }
        : {
          type: "pre_zone_observation",
          low: null,
          high: null,
          entry: analysis.lastPrice,
          unifiedState: unifiedZoneData?.state || "no_zone",
          reason: unifiedZoneData?.reason || "No valid unified zone",
          selectedTimeframe: unifiedZoneData?.selectedTF || null,
          unifiedScore: unifiedZoneData?.unifiedScore ?? 0,
          signalSource: "unified",
          executionEligible: false,
        };
      const setupType = executionEligible
        ? unifiedZoneData?.state === "waiting_for_sweep" ||
            unifiedZoneData?.state === "waiting_for_reconfirmation"
          ? "sweep_watch"
          : isCascade
          ? "cascade_zone_watch"
          : "unified_zone_watch"
        : "waiting_for_unified_zone";
      const observationReason = executionEligible
        ? null
        : "Directional candidate is visible for observation only; no valid unified zone exists";
      const watchlistInvalidation = executionEligible
        ? watchlistInvalidationFor(
          analysis.direction as WatchlistDirection,
          originatingZone,
          stopLoss,
          isCascade ? null : unifiedZoneData?.impulse,
        )
        : null;
      const frozenEntryZone = executionEligible
        ? {
          ...originatingZone,
          structuralInvalidation: watchlistInvalidation?.level ?? null,
        }
        : null;
      const needsHandoff = requiresFreshCandidateHandoff(
        existingStaged,
        executionEligible,
      );
      const handoffParentId = needsHandoff ? existingStaged?.id || null : null;

      if (needsHandoff && existingStaged) {
        try {
          await transitionStagedSetup(supabase, {
            setupId: existingStaged.id,
            userId,
            status: "invalidated",
            reason:
              "Pre-zone observation resolved; complete zone requires a fresh execution candidate",
            reasonCode: "pre_zone_handoff",
            lifecycleEvidence: buildWatchlistLifecycleEvidence({
              reasonCode: "pre_zone_handoff",
              observedPrice: analysis.lastPrice,
              frozenDirection:
                existingStaged.direction as WatchlistDirection,
              freshDirection:
                analysis.direction as WatchlistDirection | null,
              detail: {
                fromExecutionEligible:
                  !isPreZoneObservation(existingStaged),
                toExecutionEligible: executionEligible,
              },
            }),
            evidence: {
              lifecycleVersion: "phase4.v1",
              setupId: existingStaged.id,
              candidateId:
                existingStaged.candidate_id || existingStaged.id,
              handoff: {
                fromExecutionEligible:
                  !isPreZoneObservation(existingStaged),
                toExecutionEligible: executionEligible,
              },
            },
          });
          stagedInvalidated++;
          stagedMap.delete(stagedKey!);
        } catch (error: any) {
          console.warn(
            `[staging] Failed to resolve ${pair} observation handoff: ${error?.message}`,
          );
          return "failed";
        }
      } else if (existingStaged) {
        try {
          const lifecycle = currentWatchlistLifecycle(executionEligible);
          const { error: updateError } = await supabase.from(
            "staged_setups",
          ).update({
            current_score: analysis.score,
            current_factors: analysis.factors
              .filter((factor: any) => factor.present)
              .map((factor: any) => ({
                name: factor.name,
                weight: factor.weight,
                tier: factor.tier,
              })),
            missing_factors: analysis.factors
              .filter((factor: any) => !factor.present && factor.weight > 0)
              .map((factor: any) => ({
                name: factor.name,
                weight: factor.weight,
                tier: factor.tier,
              })),
            scan_cycles: existingStaged.scan_cycles + 1,
            last_eval_at: new Date().toISOString(),
            lifecycle_phase: lifecycle.lifecyclePhase,
            lifecycle_reason_code: lifecycle.lifecycleReasonCode,
            lifecycle_reason: !executionEligible
              ? "Monitoring directional candidate; no executable zone is frozen"
              : lifecycle.lifecycleEvidence.sweep
              ? String(
                (lifecycle.lifecycleEvidence.sweep as Record<string, unknown>)
                  .gateReason ||
                  "Frozen zone retained; waiting for price and confirmation",
              )
              : "Frozen zone retained; waiting for price and confirmation",
            lifecycle_evidence: lifecycle.lifecycleEvidence,
            analysis_snapshot: {
              ...(existingStaged.analysis_snapshot || {}),
              latestObservation: {
                score: analysis.score,
                unifiedState: unifiedZoneData?.state || null,
                unifiedScore: unifiedZoneData?.unifiedScore ?? 0,
                reason: unifiedZoneData?.reason || null,
                observedAt: new Date().toISOString(),
              },
            },
          }).eq("id", existingStaged.id).eq("user_id", userId);
          if (updateError) throw new Error(updateError.message);
          detail.staging = {
            action: executionEligible
              ? "execution_watch"
              : "pre_zone_observation",
            executionEligible,
            cycles: existingStaged.scan_cycles + 1,
          };
          return "updated";
        } catch (error: any) {
          console.warn(
            `[staging] Failed to update ${pair} unified watch: ${error?.message}`,
          );
          detail.error = error?.message || "Watchlist update failed";
          detail.skipReason = "Watchlist persistence failed: " + detail.error;
          return "failed";
        }
      }

      const presentFactors = analysis.factors
        .filter((factor: any) => factor.present)
        .map((factor: any) => ({
          name: factor.name,
          weight: factor.weight,
          tier: factor.tier,
        }));
      const missingFactors = analysis.factors
        .filter((factor: any) => !factor.present && factor.weight > 0)
        .map((factor: any) => ({
          name: factor.name,
          weight: factor.weight,
          tier: factor.tier,
        }));
      const tiered = analysis.tieredScoring;
      const styleTTL = stagingTTLMinutes;
      const decisionFields = stagedDecisionFields(
        originatingZone,
        executionEligible,
        frozenEntryZone,
      );
      const { error } = await supabase.from("staged_setups").insert({
        user_id: userId,
        bot_id: BOT_ID,
        symbol: pair,
        direction: analysis.direction,
        initial_score: analysis.score,
        current_score: analysis.score,
        watch_threshold: watchThreshold,
        initial_factors: presentFactors,
        current_factors: presentFactors,
        missing_factors: missingFactors,
        entry_price: entryPrice,
        // A pre-zone row has no executable price structure yet. Keep projected
        // protection levels empty so the ordinary SL-breach lifecycle cannot
        // treat an observation as though it were an armed setup.
        sl_level: executionEligible ? watchlistInvalidation?.level : null,
        tp_level: executionEligible ? takeProfit : null,
        ...decisionFields,
        authorization_result: {
          ...decisionFields.authorization_result,
          executionEligible,
          observationParentId: handoffParentId,
          observationReason,
        },
        scan_cycles: 1,
        min_cycles: executionEligible ? 1 : minStagingCycles,
        ttl_minutes: styleTTL,
        setup_type: setupType,
        execution_eligible: executionEligible,
        observation_parent_id: handoffParentId,
        observation_reason: observationReason,
        tier1_count: tiered?.tier1Count ?? 0,
        tier2_count: tiered?.tier2Count ?? 0,
        tier3_count: tiered?.tier3Count ?? 0,
        analysis_snapshot: {
          score: analysis.score,
          direction: analysis.direction,
          executionEligible,
          observationOnly: !executionEligible,
          unifiedZone: {
            state: unifiedZoneData?.state || null,
            score: unifiedZoneData?.unifiedScore ?? 0,
            selectedTF: unifiedZoneData?.selectedTF || null,
            reason: unifiedZoneData?.reason || null,
          },
          originatingZone,
          observationParentId: handoffParentId,
        },
      });
      if (error) {
        console.warn(
          `[staging] Failed to create ${setupType} for ${pair}: ${error.message}`,
        );
        detail.error = error.message;
        detail.skipReason = "Watchlist persistence failed: " + error.message;
        return "failed";
      }
      stagedNew++;
      detail.staging = {
        action: executionEligible
          ? "execution_watch"
          : "pre_zone_observation",
        executionEligible,
        setupId: decisionFields.id,
        candidateId: decisionFields.candidate_id,
        observationParentId: handoffParentId,
      };
      console.log(
        `[staging] NEW ${executionEligible ? "EXECUTION" : "PRE-ZONE"} WATCH ${pair} ${analysis.direction} — ${unifiedZoneData?.state || "no_zone"}, score ${analysis.score.toFixed(1)}%`,
      );
      return needsHandoff ? "handoff" : "created";
    };

    let preparedZoneWatch: any = existingStaged || null;

    const unifiedWatchDisposition = classifyUnifiedWatch({
      requireUnifiedZone: !!pairConfig.requireUnifiedZone,
      unifiedGatePassed,
      unifiedState: unifiedZoneData?.state,
      hasZone: unifiedZoneData?.hasZone === true,
      stagingEnabled,
      hasDirection: !!analysis.direction,
      isPaused,
      score: analysis.score,
      watchThreshold,
      tier1Count: analysis.tieredScoring?.tier1Count ?? 0,
      singleOwnershipEnforced: singleOwnershipEnforcementRequested,
    });

    if (unifiedGatePassed) {
      // Unified story is complete — use its entry/SL instead of impulse zone
      impulseZonePenaltyVal = +(pairConfig.impulseZoneBonus ?? 1.0);
      console.log(`[scan ${scanCycleId}] \u2705 ${pair}: Unified gate passed \u2014 bypassing impulse zone gate.`);
      if (
        stagingEnabled &&
        !isPaused &&
        isPreZoneObservation(existingStaged)
      ) {
        const handoff = await stageUnifiedWatch(true);
        detail.status = handoff === "failed"
          ? "pre_zone_handoff_failed"
          : "unified_zone_candidate_created";
        detail.skipReason = handoff === "failed"
          ? "Complete zone appeared, but the safe candidate handoff failed"
          : "Complete zone appeared; created a fresh frozen execution candidate for the next scan";
        scanDetails.push(detail);
        continue;
      }
    } else if (unifiedWatchDisposition === "execution_watch") {
      const watchResult = await stageUnifiedWatch(true);
      detail.status = unifiedZoneData?.state === "waiting_for_sweep"
        ? "waiting_for_sweep"
        : unifiedZoneData?.state === "waiting_for_reconfirmation"
        ? "waiting_for_reconfirmation"
        : "waiting_for_unified_confirmation";
      detail.skipReason = unifiedZoneData?.state === "waiting_for_sweep"
        ? "Unified zone is complete but its qualified local/internal liquidity trigger remains unswept"
        : unifiedZoneData?.state === "waiting_for_reconfirmation"
        ? "Unified zone remains valid, but the local sweep did not reject; a fresh trigger and confirmation are required"
        : "Unified zone is complete but its entry trigger is not ready";
      if (watchResult === "failed") {
        detail.status = "unified_watch_persist_failed";
        detail.skipReason = detail.skipReason || "Watchlist persistence failed";
      }
      scanDetails.push(detail);
      continue;
    } else if (pairConfig.requireUnifiedZone) {
      const watchResult = unifiedWatchDisposition === "pre_zone_observation"
        ? await stageUnifiedWatch(false)
        : null;
      if (
        !watchResult &&
        existingStaged &&
        isPreZoneObservation(existingStaged) &&
        (
          unifiedZoneData?.state === "no_zone" ||
          unifiedZoneData?.state === "no_impulse"
        )
      ) {
        try {
          await transitionStagedSetup(supabase, {
            setupId: existingStaged.id,
            userId,
            status: "invalidated",
            reason:
              "Candidate no longer meets the pre-zone Watchlist quality floor",
            reasonCode: "pre_zone_quality_lost",
            lifecycleEvidence: buildWatchlistLifecycleEvidence({
              reasonCode: "pre_zone_quality_lost",
              observedPrice: analysis.lastPrice,
              frozenDirection:
                existingStaged.direction as WatchlistDirection,
              freshDirection:
                analysis.direction as WatchlistDirection | null,
              score: analysis.score,
              threshold: watchThreshold,
              detail: {
                unifiedState: unifiedZoneData?.state,
                tier1Count:
                  analysis.tieredScoring?.tier1Count ?? 0,
              },
            }),
            evidence: {
              lifecycleVersion: "phase4.v1",
              setupId: existingStaged.id,
              candidateId:
                existingStaged.candidate_id || existingStaged.id,
              executionEligible:
                existingStaged.execution_eligible !== false,
              unifiedState: unifiedZoneData?.state,
              score: analysis.score,
              watchThreshold,
              tier1Count: analysis.tieredScoring?.tier1Count ?? 0,
            },
          });
          stagedInvalidated++;
          stagedMap.delete(stagedKey!);
        } catch (error: any) {
          console.warn(
            `[staging] Failed to invalidate stale ${pair} unified watch: ${error?.message}`,
          );
        }
      }
      detail.status = watchResult === "failed"
        ? "pre_zone_observation_failed"
        : watchResult
        ? "waiting_for_unified_zone"
        : "skipped_require_unified";
      detail.skipReason = watchResult
        ? "Observe only: directional candidate is waiting for a valid unified zone and cannot execute"
        : "Require Unified Zone: unified zone engine did not reach triggered/confirmed state — no standalone fallback allowed";
      console.log(
        `[scan ${scanCycleId}] ${watchResult ? "👁️" : "⛔"} ${pair}: REQUIRE UNIFIED ZONE — ${
          watchResult
            ? "candidate recorded as observe-only"
            : "candidate below observation floor"
        }.`,
      );
      scanDetails.push(detail);
      continue;
    } else if (pairConfig.impulseZoneEnabled !== false && izGateMode === "hard") {
      // HARD GATE: impulse zone is the primary entry framework
      if (!izData || !izData.hasZone) {
        // No valid impulse zone found — skip this pair entirely
        detail.status = "skipped_no_impulse_zone";
        detail.skipReason = "Impulse Zone Gate (hard): no valid entry zone found — no trade";
        console.log(`[scan ${scanCycleId}] ⛔ ${pair}: IMPULSE ZONE HARD GATE — no zone found. Skipping.`);
        scanDetails.push(detail);
        continue;
      }
      if (effectiveNestedPoiActivation.enforced &&
        !effectiveFrozenNestedPoiEntry?.selected) {
        detail.status = "skipped_nested_poi_unavailable";
        detail.skipReason =
          "Nested POI Market Trigger: no strictly-contained OB, FVG, active breaker, S/R, or Fib trigger is available; midpoint fallback is disabled";
        scanDetails.push(detail);
        continue;
      }
      const preparePreArmLifecycle = pairConfig.preArmZoneSetups === true &&
        ((config.limitOrderEnabled && !config.marketFillAtZone) ||
          effectiveNestedPoiActivation.enforced);
      if (!izData.bestZone?.priceAtZone || preparePreArmLifecycle) {
        // Zone exists but price is NOT at the zone — watchlist this pair (ready when price arrives)
        let zoneWatchPersisted = false;
        let zoneWatchPersistenceError: string | null = null;
        let preArmPlanRejectionReason: string | null = null;
        // Set when this scan successfully armed a pending order for the setup.
        let preArmedThisScan = false;
        let frozenZoneWatch: any = existingStaged || null;
        console.log(`[scan ${scanCycleId}] ⏳ ${pair}: IMPULSE ZONE HARD GATE — zone exists, price not there yet. Distance: ${izData.bestZone?.distanceToZone?.toFixed(5)}. Adding to watchlist.`);
        // Stage this pair so it's ready when price arrives at the zone
        if (stagingEnabled && analysis.direction && !isPaused) {
          try {
            const existingStagedForZone = existingStaged;
            if (!existingStagedForZone) {
              const presentFactors = analysis.factors.filter((f: any) => f.present).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
              const missingFactors = analysis.factors.filter((f: any) => !f.present && f.weight > 0).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
              const ts = analysis.tieredScoring;
              const styleTTL = stagingTTLMinutes;
              const outerZoneWatchOrigin = {
                type: izData.bestZone.type || "impulse_zone",
                low: izData.bestZone.low,
                high: izData.bestZone.high,
                entry: izData.bestZone.refinedEntry ??
                  ((izData.bestZone.high + izData.bestZone.low) / 2),
                fibDepth: izData.bestZone.fibDepth || null,
                selectedTimeframe: izData.selectedTF || null,
              };
              const zoneWatchOrigin = effectiveNestedPoiActivation.enforced &&
                  effectiveNestedPoiExecutableZone
                ? {
                  ...effectiveNestedPoiExecutableZone,
                  fibDepth: izData.bestZone.fibDepth || null,
                  selectedTimeframe: izData.selectedTF || null,
                }
                : outerZoneWatchOrigin;
              const zoneWatchInvalidation = watchlistInvalidationFor(
                analysis.direction as WatchlistDirection,
                outerZoneWatchOrigin,
                analysis.direction === "long"
                  ? izData.impulse.low
                  : izData.impulse.high,
                izData.impulse,
              );
              const zoneWatchDecision = stagedDecisionFields(zoneWatchOrigin);
              const zoneWatchRow = {
                user_id: userId,
                bot_id: BOT_ID,
                symbol: pair,
                direction: analysis.direction,
                initial_score: analysis.score,
                current_score: analysis.score,
                watch_threshold: watchThreshold,
                initial_factors: presentFactors,
                current_factors: presentFactors,
                missing_factors: missingFactors,
                entry_price: effectiveNestedPoiActivation.enforced &&
                    effectiveFrozenNestedPoiEntry?.selected
                  ? effectiveFrozenNestedPoiEntry.selected.entryPrice
                  : izData.bestZone.refinedEntry ??
                    ((izData.bestZone.high + izData.bestZone.low) / 2),
                sl_level: zoneWatchInvalidation.level,
                tp_level: analysis.takeProfit,
                ...zoneWatchDecision,
                scan_cycles: 1,
                min_cycles: 1,
                ttl_minutes: styleTTL,
                setup_type: "impulse_zone_watch",
                staged_at: new Date().toISOString(),
                tier1_count: ts?.tier1Count ?? 0,
                tier2_count: ts?.tier2Count ?? 0,
                tier3_count: ts?.tier3Count ?? 0,
                analysis_snapshot: {
                  score: analysis.score,
                  direction: analysis.direction,
                  impulseZone: { zoneHigh: izData.bestZone.high, zoneLow: izData.bestZone.low, fibDepth: izData.bestZone.fibDepth, zoneScore: izData.bestZone.totalScore, refinedEntry: izData.bestZone.refinedEntry, impulse: izData.impulse, nestedPoiEntry: effectiveFrozenNestedPoiEntry },
                },
              };
              frozenZoneWatch = zoneWatchRow;
              preparedZoneWatch = zoneWatchRow;
              if (!izData.bestZone?.priceAtZone) {
                const { error: zoneWatchInsertError } = await supabase.from("staged_setups").insert(zoneWatchRow);
                if (zoneWatchInsertError) throw zoneWatchInsertError;
                zoneWatchPersisted = true;
                stagedNew++;
              }
              console.log(`[staging] NEW ZONE WATCH ${pair} ${analysis.direction} — zone at ${izData.bestZone.low?.toFixed(5)}-${izData.bestZone.high?.toFixed(5)}, score ${analysis.score.toFixed(1)}%`);
            } else {
              // Update observation fields without rewriting frozen executable geometry.
              const existingNestedPoiEntry =
                readFrozenSetupStrategyContext(existingStagedForZone)?.nestedPoiEntry || null;
              const stagedEntryPrice = effectiveNestedPoiActivation.enforced
                ? existingNestedPoiEntry?.selected?.entryPrice ??
                  existingStagedForZone.entry_price
                : izData.bestZone.refinedEntry ??
                  ((izData.bestZone.high + izData.bestZone.low) / 2);
              const { error: zoneWatchUpdateError } = await supabase.from("staged_setups").update({
                current_score: analysis.score,
                scan_cycles: existingStagedForZone.scan_cycles + 1,
                last_eval_at: new Date().toISOString(),
                entry_price: stagedEntryPrice,
              }).eq("id", existingStagedForZone.id);
              if (zoneWatchUpdateError) throw zoneWatchUpdateError;
              frozenZoneWatch = { ...existingStagedForZone, entry_price: stagedEntryPrice };
              preparedZoneWatch = frozenZoneWatch;
              zoneWatchPersisted = true;
              console.log(`[staging] Updated ZONE WATCH ${pair} ${analysis.direction} — cycle ${existingStagedForZone.scan_cycles + 1}`);
            }
          } catch (e: any) {
            if (e?.message?.includes("unique") || e?.message?.includes("duplicate")) {
              zoneWatchPersisted = true;
              console.log(`[staging] ${pair} ${analysis.direction} already staged for zone watch`);
            } else {
              zoneWatchPersistenceError = e?.message || "Unknown database error";
              console.warn(`[staging] Failed to stage zone watch ${pair}: ${e?.message}`);
            }
          }
          detail.staging = { action: "zone_watch", zoneDistance: izData.bestZone?.distanceToZone };
        }
        if (
          !izData.bestZone?.priceAtZone && zoneWatchPersisted && frozenZoneWatch &&
          pairConfig.preArmZoneSetups === true &&
          ((config.limitOrderEnabled && !config.marketFillAtZone) ||
            effectiveNestedPoiActivation.enforced)
        ) {
          const frozenWatchContext =
            readFrozenSetupStrategyContext(frozenZoneWatch);
          const preArmNestedPlan = frozenWatchContext?.nestedPoiEntry || null;
          const routedPreArmNestedPlan = effectiveNestedPoiActivation.enforced
            ? preArmNestedPlan
            : null;
          if (effectiveNestedPoiActivation.enforced && !preArmNestedPlan?.selected) {
            preArmPlanRejectionReason =
              "nested_poi_unavailable: staged setup has no frozen nested trigger";
          } else {
          const zone = frozenZoneWatch.originating_zone;
          const entryPrice = Number(frozenZoneWatch.entry_price ?? zone?.entry);
          const structuralStop = Number(frozenZoneWatch.sl_level);
          const plan = buildConfiguredPreArmedPlan({
            direction: analysis.direction as "long" | "short",
            zone: {
              price: entryPrice,
              zoneType: String(zone?.type || "impulse_zone"),
              zoneLow: Number(zone?.low),
              zoneHigh: Number(zone?.high),
            },
            structuralInvalidation: structuralStop,
            preferredPositionStop: analysis.stopLoss,
            symbol: pair,
            atrValue: (analysis as any).atrValue,
            config: pairConfig,
            analysis,
            stopPolicy: enforcedZoneStopPolicyFor(structuralStop),
            lifecycleDecision: validatePendingLifecycle(
              readFrozenSetupStrategyContext(frozenZoneWatch),
              zone,
              effectiveNestedPoiLifecycleEnforced,
            ),
          });
          if (plan.valid) {
            const currentCanonicalLocation = (detail as any).canonicalDealingRangeObservation?.canonical || null;
            const frozenEntryLocation = evaluateCanonicalDealingRange({
              range: currentCanonicalLocation?.range || null,
              direction: analysis.direction as "long" | "short",
              price: plan.plan.entryPrice,
              mode: normalizeDealingRangeMode((pairConfig as any).dealingRangeMode, {
                onlyBuyInDiscount: pairConfig.onlyBuyInDiscount,
                onlySellInPremium: pairConfig.onlySellInPremium,
              }),
            });
            (detail as any).frozenExecutablePlan = {
              contractVersion: "frozen-executable-plan.v1",
              candidateId: frozenZoneWatch.candidate_id,
              entryPrice: plan.plan.entryPrice,
              stopLoss: plan.plan.stopLoss,
              takeProfit: plan.plan.takeProfit,
              takeProfitSource: plan.takeProfitSource,
              takeProfitFallbackReason: plan.takeProfitFallbackReason,
              zone: plan.plan.zone,
              location: frozenEntryLocation,
            };
            if ((detail as any).canonicalDealingRangeObservation) {
              (detail as any).canonicalDealingRangeObservation = {
                ...(detail as any).canonicalDealingRangeObservation,
                marketPriceObservation: currentCanonicalLocation,
                canonical: frozenEntryLocation,
                evaluatedPriceOwner: "frozen_executable_entry",
              };
            }
            const stagedAt = Date.parse(
              frozenZoneWatch.staged_at || frozenZoneWatch.created_at || new Date().toISOString(),
            );
            const ttlMinutes = Number(frozenZoneWatch.ttl_minutes || stagingTTLMinutes);
            const placedAt = new Date().toISOString();
            const preArmReachability = observePreArmReachability({
              currentPrice: Number(analysis.lastPrice),
              entryPrice: plan.plan.entryPrice,
              pipSize: (SPECS[pair] || SPECS["EUR/USD"]).pipSize,
              // `analysis` carries no atrValue — that field belongs to SLTPInput,
              // not the analysis result, and the `as any` cast hid it. Every
              // pre-armed row since the observation was added recorded
              // distanceAtr: null, so the only instrument-normalised distance
              // signal has never existed. Reuse the per-pair ATR the stop policy
              // already computed rather than adding a fifth calculateATR call.
              atrValue: zoneStopPolicyConfirmationAtr > 0
                ? zoneStopPolicyConfirmationAtr
                : null,
              ttlMinutes,
              referenceMaxDistancePips: Number(config.limitOrderMaxDistancePips ?? 30),
              armedAt: placedAt,
            });
            const absoluteExpiry = new Date(
              stagedAt + ttlMinutes * 60_000,
            ).toISOString();
            const { error: preArmError } = await supabase.from("pending_orders").insert({
              user_id: userId,
              bot_id: BOT_ID,
              order_id: crypto.randomUUID().slice(0, 8),
              symbol: pair,
              direction: analysis.direction,
              order_type: "limit",
              entry_price: plan.plan.entryPrice,
              current_price: analysis.lastPrice,
              stop_loss: plan.plan.stopLoss,
              take_profit: plan.plan.takeProfit,
              size: null,
              entry_zone_type: routedPreArmNestedPlan
                ? "PARENT-" + String(izData.bestZone.type || "ZONE").toUpperCase()
                : plan.plan.zone.zoneType,
              entry_zone_low: routedPreArmNestedPlan?.outerZone.low ??
                plan.plan.zone.zoneLow,
              entry_zone_high: routedPreArmNestedPlan?.outerZone.high ??
                plan.plan.zone.zoneHigh,
              status: "pending",
              expiry_minutes: ttlMinutes,
              expires_at: absoluteExpiry,
              signal_reason: {
                preArmed: true,
                candidateId: frozenZoneWatch.candidate_id,
                preArmReachability,
                takeProfitSource: plan.takeProfitSource,
                takeProfitFallbackReason: plan.takeProfitFallbackReason,
                zoneSetupStopPolicyMode: zoneStopPolicyResolution.requestedMode,
                zoneSetupStopPolicyAppliedAtArm: zoneStopPolicyResolution.enforced,
                zoneSetupStopPolicyBufferQuoteDistance:
                  adjustedSlBuffer * zoneStopPolicySpec.pipSize,
                zoneSetupStopPolicy: plan.stopPolicy || null,
                nestedPoiEntry: preArmNestedPlan,
              },
              signal_score: analysis.score,
              from_watchlist: true,
              staged_setup_id: frozenZoneWatch.id,
              candidate_id: frozenZoneWatch.candidate_id,
              structural_invalidation: structuralStop,
              structural_invalidation_source: "staged_inherited",
              originating_zone: zone,
              frozen_strategy_context: frozenZoneWatch.frozen_strategy_context,
              confirmation_method: frozenZoneWatch.confirmation_method || pairConfig.confirmationMethod || "choch",
              confirmation_config: {
                ...(frozenZoneWatch.confirmation_config || {}),
                entryMode: routedPreArmNestedPlan
                  ? "nested_poi_market"
                  : "confirmation",
              },
              placed_at: placedAt,
            });
            if (preArmError && !/duplicate key/i.test(preArmError.message)) {
              zoneWatchPersistenceError = `Pre-arm failed: ${preArmError.message}`;
            } else {
              // The setup is ARMED, not merely watched. Without this the scan
              // reports "watching_zone" while the staged row has already moved
              // to 'pending', so the Watchlist tab (which queries watching and
              // qualified) shows nothing and the card says WATCHING. Three
              // surfaces, three different truths.
              preArmedThisScan = true;
            }
          } else {
            preArmPlanRejectionReason = plan.reason;
          }
          }
        }
        if (!izData.bestZone?.priceAtZone) {
        if (zoneWatchPersisted) {
            detail.status = preArmedThisScan ? "zone_setup_active" : "watching_zone";
            detail.skipReason = preArmedThisScan
              ? `Impulse Zone Gate (hard): price not at zone yet (distance: ${izData.bestZone?.distanceToZone?.toFixed(5) ?? "?"}). Pre-armed — awaiting zone touch. Visible under Zone Setups, not Watchlist.`
              : preArmPlanRejectionReason
              ? `Impulse Zone Gate (hard): price not at zone yet (distance: ${izData.bestZone?.distanceToZone?.toFixed(5) ?? "?"}). Persisted to Watchlist; pre-arm plan not armed: ${preArmPlanRejectionReason}.`
              : `Impulse Zone Gate (hard): price not at zone yet (distance: ${izData.bestZone?.distanceToZone?.toFixed(5) ?? "?"}). Persisted to Watchlist.`;
            if (preArmPlanRejectionReason) {
              detail.preArmDecision = rejectedPreArmDecision(
                preArmPlanRejectionReason,
                frozenZoneWatch?.candidate_id,
              );
            }
          } else if (zoneWatchPersistenceError) {
            detail.status = "watchlist_persistence_failed";
            detail.skipReason = `Watchlist insert failed: ${zoneWatchPersistenceError}`;
            detail.staging = { action: "persistence_failed", error: zoneWatchPersistenceError, zoneDistance: izData.bestZone?.distanceToZone };
          } else {
            detail.status = "waiting_zone_untracked";
            detail.skipReason = "Price is not at the Impulse Zone, but Watchlist staging is disabled.";
          }
        scanDetails.push(detail);
        continue;
        }
      }
      // Price IS at zone — apply bonus and proceed
      impulseZonePenaltyVal = +(pairConfig.impulseZoneBonus ?? 1.0);
      console.log(`[scan ${scanCycleId}] ✅ ${pair}: Impulse Zone CONFIRMED — price at zone. Proceeding with entry evaluation.`);

      // ── Zone Score Gate: reject weak zones below minimum quality threshold ──
      const minZoneScore = pairConfig.minZoneScore ?? 4;
      const zoneScoreReason = "Zone Score Gate: zone score " + izData.bestZone.totalScore.toFixed(1) + "/9 < minimum " + minZoneScore;
      if (legacyGateBlocks("impulse_zone_score",
          izData.bestZone.totalScore >= minZoneScore, zoneScoreReason)) {
        detail.status = "skipped_weak_zone";
        detail.skipReason = `Zone Score Gate: zone score ${izData.bestZone.totalScore.toFixed(1)}/9 < minimum ${minZoneScore} — low-conviction zone rejected`;
        console.log(`[scan ${scanCycleId}] ⛔ ${pair}: ZONE SCORE GATE — score ${izData.bestZone.totalScore.toFixed(1)}/9 < ${minZoneScore}. Skipping.`);
        scanDetails.push(detail);
        continue;
      }

      // ── Standalone Sweep Gate: obey the canonical local sweep state ─────
      // When requireLiquiditySweep is ON and this is a standalone entry (unified
      // gate did NOT pass), check whether the unified zone engine detected nearby
      // qualified local/internal liquidity trigger is not ready. Broad nearby
      // pools are context only and cannot block an entry.
      if (pairConfig.requireLiquiditySweep && !unifiedGatePassed && unifiedZoneData?.liquidity) {
        const liq = unifiedZoneData.liquidity;
        const sweepGate = evaluateStandaloneSweepGate({
          requireLiquiditySweep: pairConfig.requireLiquiditySweep,
          unifiedGatePassed,
          liquidity: liq,
        });
        if (sweepGate.blocked) {
          detail.status = sweepGate.status;
          detail.skipReason = sweepGate.reason;
          console.log(`[scan ${scanCycleId}] ⏳ ${pair}: STANDALONE SWEEP GATE — ${sweepGate.reason}. Watchlisted.`);
          // Stage as sweep_watch until the local sweep authority permits entry.
          if (stagingEnabled && analysis.direction && !isPaused) {
            try {
              if (!existingStaged) {
                const presentFactors = analysis.factors.filter((f: any) => f.present).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
                const missingFactors = analysis.factors.filter((f: any) => !f.present && f.weight > 0).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
                const ts = analysis.tieredScoring;
                const styleTTL = stagingTTLMinutes;
                const sweepWatchOrigin = {
                  type: "standalone_sweep_watch",
                  low: izData.bestZone?.low ?? null,
                  high: izData.bestZone?.high ?? null,
                  entry: izData.bestZone?.entry ?? analysis.lastPrice,
                  nearbyPools: liq.nearbyPools,
                  liquiditySummary: liq.summary || null,
                  entryTriggerState: liq.entryTriggerState || null,
                  entryTrigger: liq.entryTrigger || null,
                };
                const sweepWatchInvalidation = watchlistInvalidationFor(
                  analysis.direction as WatchlistDirection,
                  sweepWatchOrigin,
                  izData.bestZone?.sl ?? analysis.stopLoss,
                  izData.impulse,
                );
                await supabase.from("staged_setups").insert({
                  user_id: userId,
                  bot_id: BOT_ID,
                  symbol: pair,
                  direction: analysis.direction,
                  initial_score: analysis.score,
                  current_score: analysis.score,
                  watch_threshold: watchThreshold,
                  initial_factors: presentFactors,
                  current_factors: presentFactors,
                  missing_factors: missingFactors,
                  entry_price: izData.bestZone?.entry ?? analysis.lastPrice,
                  sl_level: sweepWatchInvalidation.level,
                  tp_level: analysis.takeProfit,
                  ...stagedDecisionFields(sweepWatchOrigin),
                  scan_cycles: 1,
                  min_cycles: 1,
                  ttl_minutes: styleTTL,
                  setup_type: "sweep_watch",
                  tier1_count: ts?.tier1Count ?? 0,
                  tier2_count: ts?.tier2Count ?? 0,
                  tier3_count: ts?.tier3Count ?? 0,
                  analysis_snapshot: {
                    score: analysis.score,
                    direction: analysis.direction,
                    source: "standalone_local_sweep_gate",
                    unifiedZone: unifiedZoneData ? { state: unifiedZoneData.state, score: unifiedZoneData.unifiedScore, selectedTF: unifiedZoneData.selectedTF } : null,
                    liquidity: {
                      nearbyPools: liq.nearbyPools,
                      summary: liq.summary,
                      gateReason: liq.gateReason,
                      entryTriggerState: liq.entryTriggerState,
                      entryTrigger: liq.entryTrigger,
                      sweepEvent: liq.sweepEvent,
                    },
                  },
                });
                stagedNew++;
                console.log(`[staging] NEW STANDALONE SWEEP WATCH ${pair} ${analysis.direction} — unswept inducement, score ${analysis.score.toFixed(1)}%`);
              } else {
                await supabase.from("staged_setups").update({
                  current_score: analysis.score,
                  scan_cycles: existingStaged.scan_cycles + 1,
                  last_eval_at: new Date().toISOString(),
                }).eq("id", existingStaged.id);
                console.log(`[staging] Updated STANDALONE SWEEP WATCH ${pair} ${analysis.direction} — cycle ${existingStaged.scan_cycles + 1}`);
              }
            } catch (e: any) {
              if (e?.message?.includes("unique") || e?.message?.includes("duplicate")) {
                console.log(`[staging] ${pair} ${analysis.direction} already staged for standalone sweep watch`);
              } else {
                console.warn(`[staging] Failed to stage standalone sweep watch ${pair}: ${e?.message}`);
              }
            }
            detail.staging = { action: "sweep_watch", source: "standalone" };
          }
          scanDetails.push(detail);
          continue;
        }
      }

      // ── Impulse Zone → Tier 1 Credit ──────────────────────────────────
      // The impulse zone engine validates FVG/OB within the impulse leg at a Fib level,
      // but confluenceScoring checks FVG/OB independently with stricter criteria
      // (e.g., "is price literally inside the FVG right now?"). This causes 99% of
      // Tier 1 failures: the zone engine found the FVG/OB but confluence scoring
      // doesn't credit it. Since the impulse zone hard gate already passed (zone is
      // valid AND price is at zone), we credit the zone's POI type as a Tier 1 factor.
      if (analysis.tieredScoring && izData?.bestZone && !analysis.tieredScoring.tier1GatePassed) {
        const ts = analysis.tieredScoring;
        const zonePOIType = izData.bestZone.type; // "fvg" or "ob"
        const htfLayers = izData.bestZone.htfLayers || [];
        const izTier1Credits: string[] = [];

        // Credit the primary POI type from the zone AND mutate the factor object
        if (zonePOIType === "fvg") {
          const fvgFactor = analysis.factors?.find((f: any) => f.name === "Fair Value Gap");
          if (fvgFactor && (!fvgFactor.present || fvgFactor.weight <= 0 || (fvgFactor as any).tier !== 1)) {
            fvgFactor.present = true;
            fvgFactor.weight = 1.0;
            (fvgFactor as any).tier = 1;
            fvgFactor.detail += ` | IMPULSE-ZONE CREDIT: zone POI type is FVG — confirmed within impulse leg at Fib level`;
            izTier1Credits.push("FVG (impulse-zone-confirmed)");
          }
        } else if (zonePOIType === "ob") {
          const obFactor = analysis.factors?.find((f: any) => f.name === "Order Block");
          if (obFactor && (!obFactor.present || obFactor.weight <= 0 || (obFactor as any).tier !== 1)) {
            obFactor.present = true;
            obFactor.weight = 1.0;
            (obFactor as any).tier = 1;
            obFactor.detail += ` | IMPULSE-ZONE CREDIT: zone POI type is OB — confirmed within impulse leg at Fib level`;
            izTier1Credits.push("OB (impulse-zone-confirmed)");
          }
        }

        // Also check HTF layers for additional OB/FVG evidence
        if (htfLayers.some((l: string) => l.toLowerCase().includes("ob"))) {
          const obFactor = analysis.factors?.find((f: any) => f.name === "Order Block");
          if (obFactor && (!obFactor.present || obFactor.weight <= 0 || (obFactor as any).tier !== 1)) {
            obFactor.present = true;
            obFactor.weight = 1.0;
            (obFactor as any).tier = 1;
            obFactor.detail += ` | IMPULSE-ZONE CREDIT: HTF layer contains OB — zone overlaps HTF order block`;
            if (!izTier1Credits.includes("OB (impulse-zone-confirmed)")) {
              izTier1Credits.push("OB (HTF-zone-layer)");
            }
          }
        }
        if (htfLayers.some((l: string) => l.toLowerCase().includes("fvg"))) {
          const fvgFactor = analysis.factors?.find((f: any) => f.name === "Fair Value Gap");
          if (fvgFactor && (!fvgFactor.present || fvgFactor.weight <= 0 || (fvgFactor as any).tier !== 1)) {
            fvgFactor.present = true;
            fvgFactor.weight = 1.0;
            (fvgFactor as any).tier = 1;
            fvgFactor.detail += ` | IMPULSE-ZONE CREDIT: HTF layer contains FVG — zone overlaps HTF fair value gap`;
            if (!izTier1Credits.includes("FVG (impulse-zone-confirmed)")) {
              izTier1Credits.push("FVG (HTF-zone-layer)");
            }
          }
        }

        if (izTier1Credits.length > 0) {
          const _minT1 = pairConfig.minTier1Factors ?? 3;
          const newTier1Count = ts.tier1Count + izTier1Credits.length;
          const newPassed = newTier1Count >= _minT1;
          const existingFactors = ts.tier1GateReason.match(/core factors \(([^)]+)\)/)?.[1]?.split(", ") || [];
          const allPresent = [...existingFactors, ...izTier1Credits];
          const newReason = newPassed
            ? `Tier 1 gate passed (impulse-zone credit): ${newTier1Count} core factors (${allPresent.join(", ")})`
            : `Tier 1 gate FAILED: only ${newTier1Count} core factors — need at least ${_minT1}`;

          // Each Tier 1 credit adds ~1.0 pts to tieredScore (conservative default)
          const creditPts = izTier1Credits.length * 1.0;
          const newTieredScore = ts.tieredScore + creditPts;
          const newScore = ts.tieredMax > 0 ? Math.round((newTieredScore / ts.tieredMax) * 1000) / 10 : analysis.score;

          // Patch the tieredScoring in-place so Gate 19 sees the updated values
          analysis.tieredScoring = {
            ...ts,
            tier1Count: newTier1Count,
            tier1GatePassed: newPassed,
            tier1GateReason: newReason,
            tieredScore: newTieredScore,
          };
          analysis.score = newScore;
          console.log(`[scan ${scanCycleId}] 🔧 ${pair}: Impulse Zone Tier 1 credit: +${izTier1Credits.length} (${izTier1Credits.join(", ")}) → T1 count ${ts.tier1Count}→${newTier1Count}, gate ${newPassed ? "PASSED" : "still failed"}, score ${ts.tieredScore.toFixed(1)}→${newTieredScore.toFixed(1)} (${analysis.score.toFixed(1)}%)`);
        }
      }
      // ── Impulse Zone → P/D & Fib Credit (Tier 1) ────────────────────────
      // The P/D factor uses the entry-TF zigzag to measure retracement depth.
      // The impulse zone engine uses the 1H impulse leg's Fib overlay — a
      // different (often better) swing anchor. When the impulse zone validates
      // a POI at fibDepth >= 0.5 (i.e., in OTE or deeper), the P/D factor
      // should reflect that the entry IS at a premium/discount Fib level.
      // Only credit when: hard gate passed, P/D factor not already present at Tier 1.
      if (analysis.tieredScoring && izData?.bestZone) {
        const pdFactor = analysis.factors?.find((f: any) => f.name === "Premium/Discount & Fib");
        const fibDepth = izData.bestZone.fibDepth ?? 0;
        if (pdFactor && (!pdFactor.present || pdFactor.weight <= 0) && fibDepth >= 0.5) {
          // Credit the P/D factor based on the impulse zone's validated Fib depth
          const fibPct = (fibDepth * 100).toFixed(1);
          const izFibLabel = fibDepth >= 0.618 ? "OTE zone" : "discount/premium zone";
          pdFactor.present = true;
          pdFactor.weight = fibDepth >= 0.71 ? 2.0 : fibDepth >= 0.618 ? 1.5 : 1.0;
          (pdFactor as any).tier = 1;
          pdFactor.detail += ` | IMPULSE-ZONE CREDIT: zone POI at ${fibPct}% Fib depth (${izFibLabel}) — 1H impulse leg confirms P/D alignment`;
          // Update tieredScoring: increment tier1Count + add weight to tieredScore + recalc score
          const ts = analysis.tieredScoring;
          if (ts && (ts as any).tier1Count !== undefined) {
            const _minT1PD = pairConfig.minTier1Factors ?? 3;
            const newCount = ts.tier1Count + 1;
            const newPassed = newCount >= _minT1PD;
            const existingFactors = ts.tier1GateReason.match(/core factors \(([^)]+)\)/)?.[1]?.split(", ") || [];
            existingFactors.push(`P/D (impulse-zone-fib ${fibPct}%)`);
            const newTieredScore = ts.tieredScore + pdFactor.weight;
            const newScore = ts.tieredMax > 0 ? Math.round((newTieredScore / ts.tieredMax) * 1000) / 10 : analysis.score;
            analysis.tieredScoring = {
              ...ts,
              tier1Count: newCount,
              tier1GatePassed: newPassed,
              tier1GateReason: newPassed
                ? `Tier 1 gate passed (impulse-zone credit): ${newCount} core factors (${existingFactors.join(", ")})`
                : `Tier 1 gate FAILED: only ${newCount} core factors — need at least ${_minT1PD}`,
              tieredScore: newTieredScore,
            };
            analysis.score = newScore;
            console.log(`[scan ${scanCycleId}] 🔧 ${pair}: P/D Fib credit from impulse zone (${fibPct}% depth) → T1 count ${ts.tier1Count}→${newCount}, gate ${newPassed ? "PASSED" : "still failed"}, score +${pdFactor.weight.toFixed(1)} → ${analysis.score.toFixed(1)}%`);
          }
        }
      }
      // ── Impulse Zone → Confluence Stack Credit (Tier 2) ─────────────────
      // The Confluence Stack factor checks if entry-TF FVGs/OBs overlap with
      // S/R + Fib levels. The impulse zone engine independently validates:
      // srConfirmed (S/R overlaps zone) + htfLayers (HTF zones overlap).
      // When the zone has srConfirmed + at least 1 HTF layer, that IS a
      // confluence stack — just measured from the impulse leg's perspective.
      if (analysis.tieredScoring && izData?.bestZone) {
        const stackFactor = analysis.factors?.find((f: any) => f.name === "Confluence Stack");
        const srConfirmed = izData.bestZone.srConfirmed ?? false;
        const htfLayers = izData.bestZone.htfLayers || [];
        const stackLayers = (srConfirmed ? 1 : 0) + htfLayers.length;
        if (stackFactor && (!stackFactor.present || stackFactor.weight <= 0) && stackLayers >= 2) {
          // Credit confluence stacking from impulse zone data
          const layerLabels = [];
          if (srConfirmed) layerLabels.push("S/R");
          layerLabels.push(...htfLayers);
          stackFactor.present = true;
          stackFactor.weight = stackLayers >= 3 ? 1.5 : 1.0;
          stackFactor.detail += ` | IMPULSE-ZONE CREDIT: zone has ${stackLayers}-layer confluence (${layerLabels.join(" + ")}) — stacking confirmed from impulse leg`;
          // Update tier2Count + tieredScore + recalc analysis.score
          const ts = analysis.tieredScoring;
          if (ts && (ts as any).tier2Count !== undefined) {
            const newTieredScore = ts.tieredScore + stackFactor.weight;
            const newScore = ts.tieredMax > 0 ? Math.round((newTieredScore / ts.tieredMax) * 1000) / 10 : analysis.score;
            analysis.tieredScoring = {
              ...ts,
              tier2Count: ts.tier2Count + 1,
              tieredScore: newTieredScore,
            };
            analysis.score = newScore;
          }
          console.log(`[scan ${scanCycleId}] 🔧 ${pair}: Confluence Stack credit from impulse zone (${layerLabels.join("+")}) → T2 count +1, score +${stackFactor.weight.toFixed(1)} → ${analysis.score.toFixed(1)}%`);
        }
      }
      // ── Impulse Zone → HTF POI Alignment Credit (Tier 2) ────────────────
      // The HTF POI Alignment factor checks if current price is inside a
      // 4H/1H FVG/OB/Breaker. The impulse zone engine checks if the zone
      // overlaps with HTF POIs. When priceAtZone is true AND the zone has
      // HTF layers, price IS effectively inside those HTF POIs (transitive).
      if (analysis.tieredScoring && izData?.bestZone && izData.bestZone.priceAtZone) {
        const htfPoiFactor = analysis.factors?.find((f: any) => f.name === "HTF POI Alignment");
        const htfLayers = izData.bestZone.htfLayers || [];
        const hasHTFOBorFVG = htfLayers.some((l: string) => l.toLowerCase().includes("ob") || l.toLowerCase().includes("fvg"));
        if (htfPoiFactor && (!htfPoiFactor.present || htfPoiFactor.weight <= 0) && hasHTFOBorFVG) {
          // Credit HTF POI alignment from impulse zone's validated overlap
          const obLayers = htfLayers.filter((l: string) => l.toLowerCase().includes("ob"));
          const fvgLayers = htfLayers.filter((l: string) => l.toLowerCase().includes("fvg"));
          let boost = 0;
          if (fvgLayers.length > 0) boost += 0.8; // 4H FVG equivalent
          if (obLayers.length > 0) boost += 0.7;  // 4H OB equivalent
          boost = Math.min(2.0, boost);
          htfPoiFactor.present = true;
          htfPoiFactor.weight = boost;
          htfPoiFactor.detail += ` | IMPULSE-ZONE CREDIT: zone overlaps ${htfLayers.join(", ")} — price at zone confirms HTF POI alignment`;
          // Update tier2Count + tieredScore + recalc analysis.score
          const ts = analysis.tieredScoring;
          if (ts && (ts as any).tier2Count !== undefined) {
            const newTieredScore = ts.tieredScore + boost;
            const newScore = ts.tieredMax > 0 ? Math.round((newTieredScore / ts.tieredMax) * 1000) / 10 : analysis.score;
            analysis.tieredScoring = {
              ...ts,
              tier2Count: ts.tier2Count + 1,
              tieredScore: newTieredScore,
            };
            analysis.score = newScore;
          }
          console.log(`[scan ${scanCycleId}] 🔧 ${pair}: HTF POI Alignment credit from impulse zone (${htfLayers.join(", ")}) → boost ${boost.toFixed(1)}, T2 count +1, score → ${analysis.score.toFixed(1)}%`);
        }
      }
    } else if (pairConfig.impulseZoneEnabled !== false && izGateMode === "soft") {
      // SOFT MODE: legacy penalty/bonus behavior
      if (izData) {
        if (!izData.hasZone) {
          impulseZonePenaltyVal = -(pairConfig.impulseZonePenalty ?? 2.0);
        } else if (izData.bestZone?.priceAtZone) {
          impulseZonePenaltyVal = +(pairConfig.impulseZoneBonus ?? 1.0);
        }
      }
    }
    // "off" mode: no adjustment at all
    if (!zoneLocalDecision.allowed) {
      detail.status = "skipped_zone_local_confluence";
      detail.skipReason =
        `Zone-Local Confluence (${zoneLocalDecision.mode.effectiveMode}): `
        + zoneLocalDecision.reason;
      console.log(
        `[scan ${scanCycleId}] ⛔ ${pair}: ZONE-LOCAL HARD BLOCK — `
          + `${zoneLocalDecision.reason}, shadowRank=`
          + `${zoneLocalDecision.shadowRank ?? "missing"}, localScore=`
          + `${zoneLocalDecision.shadowLocalScore ?? "missing"}.`,
      );
      scanDetails.push(detail);
      continue;
    }
    if (!crossTimeframeEntryDecision.allowed) {
      detail.status = "skipped_cross_timeframe_authority";
      detail.skipReason =
        `Cross-Timeframe Authority (${crossTimeframeEntryDecision.effectiveMode}): `
        + crossTimeframeEntryDecision.reasonCodes.join(", ");
      console.log(
        `[scan ${scanCycleId}] ⛔ ${pair}: CROSS-TF HARD BLOCK — `
          + crossTimeframeEntryDecision.reasonCodes.join(", "),
      );
      scanDetails.push(detail);
      continue;
    }
    const zoneLocalScoreAdj = zoneLocalDecision.scoreAdjustment;
    const crossTimeframeScoreAdj =
      crossTimeframeEntryDecision.scoreAdjustment;
    // When directionVerdict is active, its scoreAdjustment replaces the ICT HTF score adjustment
    // (the verdict already incorporates weekly bias, regime, and GP bias into one number).
    const ictHTFScoreAdj = directionVerdict ? 0 : (ictHTFResult?.scoreAdjustment ?? 0);
    const verdictScoreAdj = directionVerdict?.scoreAdjustment ?? 0;
    // ICT module score adjustments (only apply in "soft" mode; "off" = 0, "hard" = gate block)
    const ictMSSAdj = (pairConfig.ictDisplacementMSSGateMode === "soft" && ictMSSResult && !ictMSSResult.isValid)
      ? -pairConfig.ictDisplacementMSSPenalty : 0;
    const ictJudasAdj = (pairConfig.ictJudasSwingGateMode === "soft" && ictJudasResult && !ictJudasResult.found)
      ? -pairConfig.ictJudasSwingPenalty : 0;
    const ictFVGAdj = (pairConfig.ictFVGInvalidationGateMode === "soft" && ictFVGResult)
      ? -(ictFVGResult.invalidatedCount * pairConfig.ictFVGInvalidatedPenalty + ictFVGResult.exhaustedCount * pairConfig.ictFVGExhaustedPenalty) / Math.max(ictFVGResult.totalCount, 1)
      : 0;
    const ictKZAdj = (pairConfig.ictKillZoneGateMode === "soft" && ictKZResult)
      ? (ictKZResult.isKillZone ? (ictKZResult.isPrime ? pairConfig.ictKillZonePrimeBonus : 0) : -pairConfig.ictKillZoneOutsidePenalty)
      : 0;
    const ictTotalAdj = ictHTFScoreAdj + ictMSSAdj + ictJudasAdj + ictFVGAdj + ictKZAdj;
    const effectiveScore = analysis.score + fotsiPenalty +
      impulseZonePenaltyVal + zoneLocalScoreAdj +
      crossTimeframeScoreAdj + ictTotalAdj +
      verdictScoreAdj;
    if (impulseZonePenaltyVal !== 0) {
      console.log(`[scan ${scanCycleId}] ${pair} Impulse Zone scoring: ${impulseZonePenaltyVal > 0 ? "+" : ""}${impulseZonePenaltyVal.toFixed(1)}% (raw ${analysis.score.toFixed(1)}% → effective ${effectiveScore.toFixed(1)}%)`);
    }
    if (ictHTFScoreAdj !== 0) {
      console.log(`[scan ${scanCycleId}] ${pair} ICT HTF scoring: ${ictHTFScoreAdj > 0 ? "+" : ""}${ictHTFScoreAdj.toFixed(1)}% (effective ${effectiveScore.toFixed(1)}%)`);
    }
    if (ictMSSAdj !== 0 || ictJudasAdj !== 0 || ictFVGAdj !== 0 || ictKZAdj !== 0) {
      console.log(`[scan ${scanCycleId}] ${pair} ICT modules scoring: MSS=${ictMSSAdj.toFixed(1)} Judas=${ictJudasAdj.toFixed(1)} FVG=${ictFVGAdj.toFixed(1)} KZ=${ictKZAdj.toFixed(1)} (total=${ictTotalAdj.toFixed(1)}%, effective=${effectiveScore.toFixed(1)}%)`);
    }
    if (verdictScoreAdj !== 0) {
      console.log(`[scan ${scanCycleId}] ${pair} Direction Verdict scoring: ${verdictScoreAdj > 0 ? "+" : ""}${verdictScoreAdj.toFixed(1)}% (effective ${effectiveScore.toFixed(1)}%)`);
    }
    if (zoneLocalScoreAdj !== 0) {
      console.log(
        `[scan ${scanCycleId}] ${pair} Zone-local soft adjustment: `
          + `${zoneLocalScoreAdj.toFixed(1)}% (${zoneLocalDecision.reason}, `
          + `effective ${effectiveScore.toFixed(1)}%)`,
      );
    }
    if (crossTimeframeScoreAdj !== 0) {
      console.log(
        `[scan ${scanCycleId}] ${pair} Cross-TF soft adjustment: `
          + `${crossTimeframeScoreAdj.toFixed(1)}% (`
          + `${crossTimeframeEntryDecision.reason}, effective `
          + `${effectiveScore.toFixed(1)}%)`,
      );
    }
    // ── Thesis Conviction Tracker (shadow mode: log only, no trade impact) ──
    const opposingFactorCount = analysis.tieredScoring?.opposingFactorCount ?? 0;
    let convictionResult: ConvictionResult | null = null;
    if ((config as any).thesisConvictionEnabled && analysis.direction) {
      try {
        const convKey = buildConvictionKey(userId, BOT_ID, pair, analysis.direction);
        const prevState = convictionStates.get(convKey) || null;
        const gpCtx = (pairConfig as any)._gamePlanContext;
        const convInput: ConvictionInput = {
          symbol: pair,
          direction: analysis.direction,
          directionVerdict: directionVerdict || null,
          regime4H: analysis.regime4HInfo ? {
            regime: analysis.regime4HInfo.regime,
            bias: analysis.regime4HInfo.bias,
            confidence: analysis.regime4HInfo.confidence,
          } : null,
          structureContext: pairDecisionEvidence.structureRegime
            ? {
              regime: pairDecisionEvidence.structureRegime.regime,
              bias:
                pairDecisionEvidence.structureRegime.directionalBias,
              confidence:
                pairDecisionEvidence.structureRegime.confidence,
              timeframeLabel:
                pairDecisionEvidence.structureRegime.label,
            }
            : null,
          fotsiAlignment: analysis.fotsiAlignment ? {
            label: analysis.fotsiAlignment.label,
            score: analysis.fotsiAlignment.score,
          } : null,
          opposingFactorCount: opposingFactorCount,
          gamePlanBias: pairConfig.gpEnforcementMode !== "off" && gpCtx ? {
            bias: gpCtx.bias,
            confidence: gpCtx.biasConfidence ?? 50,
          } : null,
        };
        const convictionUpdate = updateConviction(prevState, convInput, {
          ...DEFAULT_CONVICTION_CONFIG,
          decayPerOpposingSource: (config as any).thesisConvictionDecayPerCycle ?? DEFAULT_CONVICTION_CONFIG.decayPerOpposingSource,
          recoveryPerAlignedSource: (config as any).thesisConvictionRecoveryPerCycle ?? DEFAULT_CONVICTION_CONFIG.recoveryPerAlignedSource,
          revokeThreshold: (config as any).thesisConvictionRevokeThreshold ?? DEFAULT_CONVICTION_CONFIG.revokeThreshold,
        });
        convictionResult = convictionUpdate.result;
        // Update in-memory state for persistence at end of cycle
        convictionStates.set(convKey, convictionUpdate.state);
        // Shadow mode: log the conviction score and what it WOULD have done
        const creditDecision = convictionResult.impulseCreditDecision;
        if (convictionResult.conviction < 80 || creditDecision !== "granted") {
          console.log(`[conviction${(config as any).thesisConvictionMode === "shadow" ? ":shadow" : ""}] ${pair} ${analysis.direction}: conviction=${convictionResult.conviction.toFixed(0)}%, cycles=${convictionResult.cycleCount}, credit=${creditDecision}, scoreAdj=${convictionResult.scoreAdjustment.toFixed(1)}, summary=${convictionResult.summary}`);
        }
        // Attach to scan detail for logging/debugging
        (detail as any).thesisConviction = {
          conviction: convictionResult.conviction,
          cycleCount: convictionResult.cycleCount,
          creditDecision,
          scoreAdjustment: convictionResult.scoreAdjustment,
          summary: convictionResult.summary,
          thesisDegrading: convictionResult.thesisDegrading,
          mode: (config as any).thesisConvictionMode,
        };
      } catch (tcErr: any) {
        console.warn(`[conviction] ${pair} error (non-fatal): ${tcErr?.message}`);
      }
    }
    // Record the four-layer decision context for every directional candidate,
    // including candidates that are later rejected by operational gates.
    if (analysis.direction) {
      const candidateThesis = validatePendingOrderThesis(
        {
          order_id: `candidate:${scanCycleId}:${pair}`,
          symbol: pair,
          direction: analysis.direction as "long" | "short",
          entry_price: analysis.lastPrice,
          signal_reason: {
            directionVerdict: (detail as any).directionVerdict || null,
          },
        },
        {
          fotsiResult: _fotsiResult,
          lastGamePlan: gamePlanEnabled ? activeGamePlan : null,
          dailyCandles: dailyCandles.length >= 20 ? dailyCandles : null,
          h4Candles: h4Candles.length >= 20 ? h4Candles : null,
          h1Candles: hourlyCandles.length >= 20 ? hourlyCandles : null,
          decisionEvidence: pairDecisionEvidence,
        },
      );
      const candidateConfirmation: EntryConfirmationDecision = {
        required: false,
        passed: false,
        method: pairConfig.confirmationMethod || "choch",
        reason: "Candidate discovered; entry timing has not been authorized",
        evidence: null,
        evaluatedAt: new Date().toISOString(),
      };
      const candidateHierarchy = evaluateDecisionHierarchy({
        symbol: pair,
        direction: analysis.direction as "long" | "short",
        gamePlan: activeGamePlan,
        gamePlanEnabled,
        gamePlanMode: gpEnforcementMode,
        gamePlanMinimumConfidence:
          (pairConfig as any).gpHardBlockThreshold ?? 75,
        directionVerdict: activeDirectionVerdict,
        requireDirectionVerdict: true,
        thesisResult: candidateThesis,
        requireThesisValidation: true,
        entryConfirmation: candidateConfirmation,
      });
      (detail as any).decisionContext = buildTradeDecisionContext({
        stage: "candidate",
        symbol: pair,
        direction: analysis.direction as "long" | "short",
        gamePlan: activeGamePlan,
        directionVerdict: activeDirectionVerdict,
        thesisResult: candidateThesis,
        requireThesisValidation: true,
        thesisConviction: (detail as any).thesisConviction || null,
        entryConfirmation: candidateConfirmation,
        hierarchy: candidateHierarchy,
        stylePolicy: pairStylePolicy,
        evaluatedAt: candidateConfirmation.evaluatedAt,
      });
    }
    // ── Bidirectional Conflict Counter Gate (computed early so staging promotion gate can use it) ──
    // When many factors actively oppose the trade, raise the bar or block entirely.
    const opposingCount = opposingFactorCount;
    let conflictAdjustedMinConfluence = adjustedMinConfluence;
    let conflictHardBlock = false;
    if (opposingCount >= conflictBlockAt) {
      conflictHardBlock = true;
    } else if (opposingCount >= conflictThresholdRaise) {
      conflictAdjustedMinConfluence = adjustedMinConfluence + 10;
      console.log(`[conflict] ${pair}: ${opposingCount} opposing factors (>= ${conflictThresholdRaise}) — threshold raised from ${adjustedMinConfluence}% to ${conflictAdjustedMinConfluence}%`);
    }

    // Determine whether this staged setup has reached score/cycle eligibility.
    // The durable "qualified" transition happens only after the remaining
    // candidate gates have passed and exact decision evidence is available.
    let isPromotedFromStaging = false;
    if (
      existingStaged &&
      existingStaged.execution_eligible !== false &&
      (singleOwnershipEnforcementRequested ||
        effectiveScore >= conflictAdjustedMinConfluence) &&
      analysis.direction &&
      !isPaused &&
      stagingEnabled
    ) {
      const cyclesMet = singleOwnershipEnforcementRequested ||
        existingStaged.scan_cycles >= (existingStaged.min_cycles || minStagingCycles);
      if (cyclesMet) {
        isPromotedFromStaging = true;
        // Eligibility is not a lifecycle transition. Keep the Watchlist row
        // watching until the remaining candidate gates pass.
        try {
          const presentFactors = analysis.factors.filter((f: any) => f.present).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
          const missingFactors = analysis.factors.filter((f: any) => !f.present && f.weight > 0).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
          await supabase.from("staged_setups").update({
            current_score: analysis.score,
            current_factors: presentFactors,
            missing_factors: missingFactors,
            promotion_reason: singleOwnershipEnforcementRequested
            ? "Trade Decision authorized Watchlist promotion"
            : `Score reached ${analysis.score.toFixed(1)}% (gate: ${adjustedMinConfluence}%) after ${existingStaged.scan_cycles + 1} cycles`,
            last_eval_at: new Date().toISOString(),
            scan_cycles: existingStaged.scan_cycles + 1,
          }).eq("id", existingStaged.id);
          console.log(`[staging] ELIGIBLE ${pair} ${analysis.direction} — score ${analysis.score.toFixed(1)}%; evaluating remaining gates`);
        } catch (e: any) {
          console.warn(`[staging] Failed to update qualified ${pair}: ${e?.message}`);
        }
        detail.staging = { action: "eligible", cycles: existingStaged.scan_cycles + 1, initialScore: parseFloat(existingStaged.initial_score) };
      } else {
        // Score is above gate but hasn't been staged long enough — update and wait
        try {
          const presentFactors = analysis.factors.filter((f: any) => f.present).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
          const missingFactors = analysis.factors.filter((f: any) => !f.present && f.weight > 0).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
          await supabase.from("staged_setups").update({
            current_score: analysis.score,
            current_factors: presentFactors,
            missing_factors: missingFactors,
            scan_cycles: existingStaged.scan_cycles + 1,
            last_eval_at: new Date().toISOString(),
            entry_price: analysis.lastPrice,
            sl_level: watchlistInvalidationFor(
              analysis.direction as WatchlistDirection,
              existingStaged.originating_zone,
              existingStaged.sl_level ?? analysis.stopLoss,
              existingStaged.analysis_snapshot?.impulseZone?.impulse,
            ).level,
            tp_level: analysis.takeProfit,
          }).eq("id", existingStaged.id);
          console.log(`[staging] ${pair} ${analysis.direction} score ${analysis.score.toFixed(1)}% — above gate but needs ${(existingStaged.min_cycles || minStagingCycles) - existingStaged.scan_cycles} more cycle(s)`);
        } catch (e: any) {
          console.warn(`[staging] Failed to update staged ${pair}: ${e?.message}`);
        }
        detail.status = "staged_confirming";
        detail.reason = `Score ${analysis.score.toFixed(1)}% above gate — confirming (cycle ${existingStaged.scan_cycles + 1}/${existingStaged.min_cycles || minStagingCycles})`;
        detail.staging = { action: "confirming", cycles: existingStaged.scan_cycles + 1, minCycles: existingStaged.min_cycles || minStagingCycles };
        scanDetails.push(detail);
        continue;
      }
    }

    const buildPromotedLifecycleEvidence = (
      originatingZone: Record<string, unknown> | null,
      authorizationResult?: Record<string, unknown> | null,
    ): (SetupLifecycleEvidence & {
      directionVerdict: unknown;
      confirmationConfig: {
        indicatorMinCount: number;
        maxConfirmationAttempts: number;
      };
      authorizationResult: Record<string, unknown> | null;
    }) | null => {
      if (
        !isPromotedFromStaging ||
        !existingStaged?.id ||
        existingStaged.execution_eligible === false
      ) return null;
      const identity = {
        setupId: existingStaged.id,
        candidateId: existingStaged.candidate_id || existingStaged.id,
      };
      const savedPolicy = resolvePendingStylePolicy(
        existingStaged,
        pairStylePolicy,
      ).policy;
      const frozenStrategyContext =
        readFrozenSetupStrategyContext(existingStaged) ||
        buildFrozenSetupStrategyContext({
          identity,
          timeframeEvidenceId:
            readFrozenSetupStrategyContext(existingStaged)
              ?.timeframeEvidenceId ||
            (detail as any).timeframeEvidenceId ||
            null,
          symbol: pair,
          direction: analysis.direction as "long" | "short",
          stylePolicy: savedPolicy,
          runtimeConfig: pairRuntimeConfigSnapshot,
          decisionContext:
            existingStaged.authorization_result?.decisionContext ||
            null,
          gamePlan: activeGamePlan,
          directionVerdict: activeDirectionVerdict,
          conceptEvidence: selectedZoneConceptEvidence(),
          zoneLocalConfluence: selectedZoneLocalConfluence(),
          zoneCandidateShadowRanking: selectedZoneShadowRanking(),
          crossTimeframeContext: selectedCrossTimeframeContext(existingStaged.originating_zone || originatingZone),
          entryZone:
            existingStaged.originating_zone || originatingZone,
          confirmationMethod:
            existingStaged.confirmation_method ||
            pairConfig.confirmationMethod ||
            "choch",
          indicatorMinCount:
            existingStaged.confirmation_config?.indicatorMinCount ||
            pairConfig.indicatorMinCount ||
            3,
        });
      return {
        ...buildSetupLifecycleEvidence({
          identity,
          symbol: pair,
          gamePlan: activeGamePlan,
          directionVerdict: activeDirectionVerdict,
          confirmationMethod: frozenStrategyContext.confirmation.method,
          entryZone: frozenStrategyContext.entryZone,
          frozenStrategyContext,
        }),
        directionVerdict:
          frozenStrategyContext.directionVerdict ||
          (detail as any).directionVerdict ||
          null,
        confirmationConfig: {
          indicatorMinCount:
            frozenStrategyContext.confirmation.indicatorMinCount,
          maxConfirmationAttempts:
            frozenStrategyContext.confirmation.maxAttempts,
        },
        authorizationResult: {
          ...(authorizationResult || {}),
          frozenStrategyContext,
        },
      };
    };

    const qualifyPromotedSetup = async (
      evidence: ReturnType<typeof buildPromotedLifecycleEvidence>,
      reason: string,
    ) => {
      if (!evidence || !existingStaged) return;
      const phase = deriveWatchlistLifecyclePhase({
        executionEligible: true,
        hasZone: true,
        unifiedState: (detail as any).unifiedZone?.state || "confirmed",
        priceAtZone: true,
        entryTriggerState:
          (detail as any).unifiedZone?.liquidity?.entryTriggerState || null,
        confirmationReady: true,
      });
      await transitionStagedSetup(supabase, {
        setupId: existingStaged.id,
        userId,
        status: "qualified",
        reason,
        reasonCode: "qualified",
        lifecycleEvidence: buildWatchlistLifecycleEvidence({
          reasonCode: "qualified",
          phase: phase.phase,
          milestones: phase.milestones,
          observedPrice: analysis.lastPrice,
          frozenDirection:
            existingStaged.direction as WatchlistDirection,
          freshDirection:
            analysis.direction as WatchlistDirection | null,
          score: analysis.score,
          threshold: adjustedMinConfluence,
          detail: { reason },
        }),
        evidence,
      });
    };

    const blockQualifiedSetup = async (
      evidence: ReturnType<typeof buildPromotedLifecycleEvidence>,
      reason: string,
    ) => {
      if (!evidence || !existingStaged) return;
      try {
        const phase = deriveWatchlistLifecyclePhase({
          executionEligible: true,
          hasZone: true,
          unifiedState: (detail as any).unifiedZone?.state || "confirmed",
          priceAtZone: true,
          entryTriggerState:
            (detail as any).unifiedZone?.liquidity?.entryTriggerState || null,
          confirmationReady: true,
        });
        await transitionStagedSetup(supabase, {
          setupId: existingStaged.id,
          userId,
          status: "blocked_after_qualification",
          reason,
          reasonCode: "blocked_after_qualification",
          lifecycleEvidence: buildWatchlistLifecycleEvidence({
            reasonCode: "blocked_after_qualification",
            phase: phase.phase,
            milestones: phase.milestones,
            observedPrice: analysis.lastPrice,
            frozenDirection:
              existingStaged.direction as WatchlistDirection,
            freshDirection:
              analysis.direction as WatchlistDirection | null,
            score: analysis.score,
            threshold: adjustedMinConfluence,
            detail: { reason },
          }),
          evidence,
        });
        stagedMap.delete(stagedKey!);
      } catch (error: any) {
        console.warn(
          `[staging] Failed to record post-qualification block for ${pair}: ${error?.message}`,
        );
      }
    };

    // Apply the conflict hard-block decision computed above
    if (legacyGateBlocks("conflict_count", !conflictHardBlock,
        "Conflict counter: " + opposingCount + " opposing factors")) {
      // N+ opposing factors = hard block — too much disagreement to trade
      detail.status = "rejected";
      detail.rejectionReasons = [`Conflict counter BLOCKED: ${opposingCount} factors oppose ${analysis.direction} — too many conflicting signals (block at ${conflictBlockAt}+)`];
      detail.reason = `Conflict block: ${opposingCount} opposing factors`;
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }

    // ICT HTF hard gate: block trade if weekly bias or containment requirement fails (only in "hard" mode)
    if (ictHTFResult && legacyGateBlocks("htf_alignment",
        ictHTFResult.passed, "ICT HTF: " + ictHTFResult.reason)) {
      detail.status = "rejected";
      detail.rejectionReasons = [`ICT HTF BLOCKED: ${ictHTFResult.reason}`];
      detail.reason = ictHTFResult.reason;
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }
    // ICT Displacement MSS hard gate: block trade if MSS lacks displacement
    if (pairConfig.ictDisplacementMSSGateMode === "hard" && ictMSSResult &&
        legacyGateBlocks("ict_mss", ictMSSResult.isValid, "ICT MSS: " + ictMSSResult.reason)) {
      detail.status = "rejected";
      detail.rejectionReasons = [`ICT MSS BLOCKED: ${ictMSSResult.reason}`];
      detail.reason = ictMSSResult.reason;
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }
    // ICT Judas Swing hard gate: block trade if no liquidity sweep detected before MSS
    if (pairConfig.ictJudasSwingGateMode === "hard" && ictJudasResult &&
        legacyGateBlocks("ict_judas", ictJudasResult.found, "ICT Judas: " + ictJudasResult.reason)) {
      detail.status = "rejected";
      detail.rejectionReasons = [`ICT JUDAS BLOCKED: ${ictJudasResult.reason}`];
      detail.reason = ictJudasResult.reason;
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }
    // ICT FVG Invalidation hard gate: block trade if ALL FVGs are invalidated
    if (pairConfig.ictFVGInvalidationGateMode === "hard" && ictFVGResult && ictFVGResult.totalCount > 0 &&
        legacyGateBlocks("ict_fvg_invalidation", ictFVGResult.validCount > 0, "ICT FVG invalidation")) {
      detail.status = "rejected";
      detail.rejectionReasons = [`ICT FVG BLOCKED: All ${ictFVGResult.totalCount} FVGs invalidated/exhausted`];
      detail.reason = `All FVGs invalidated (${ictFVGResult.invalidatedCount} closed, ${ictFVGResult.exhaustedCount} exhausted)`;
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }
    // ICT Kill Zone hard gate: block trade if outside all kill zones
    if (pairConfig.ictKillZoneGateMode === "hard" && ictKZResult &&
        legacyGateBlocks("ict_kill_zone", ictKZResult.isKillZone, "ICT Kill Zone: " + ictKZResult.reason)) {
      detail.status = "rejected";
      detail.rejectionReasons = [`ICT KZ BLOCKED: ${ictKZResult.reason}`];
      detail.reason = ictKZResult.reason;
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }
    // ICT Risk hard gate: block trade if risk limits exceeded
    if (pairConfig.ictRiskEnabled && ictRiskResult &&
        legacyGateBlocks("ict_risk", ictRiskResult.canTrade,
          "ICT Risk: " + ictRiskResult.reasons.join("; "))) {
      detail.status = "rejected";
      detail.rejectionReasons = [`ICT RISK BLOCKED: ${ictRiskResult.reasons.join("; ")}`];
      detail.reason = ictRiskResult.reasons.join("; ");
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }

    // Paper enforcement can evaluate owned authorities without first passing the legacy score.
    const legacyScannerEligible = effectiveScore >= conflictAdjustedMinConfluence;
    if ((legacyScannerEligible || singleOwnershipEnforcementRequested) &&
        analysis.direction && !isPaused) {
      signalsFound++;

      // Run safety gates
      // Structural conviction uses the exact policy structure role:
      // Scalper=15m, Day Trader=4H, Swing=Daily.
      const convictionCandles = roleCandles.structure.length >= 20
        ? roleCandles.structure
        : null;
      const gates = await runSafetyGates(
        supabase, userId, pair, analysis.direction,
        analysis, pairConfig, account, openPosArr, dailyCandles.length >= 10 ? dailyCandles : null,
        rateMap, convictionCandles, pairDecisionEvidence.labels.structure,
        directionVerdict,
        propFirmGateResult?.enabled || false,
        effectiveScore,
        conflictAdjustedMinConfluence,
      );
      // ── Game Plan + Direction Verdict Alignment Gate ──
      // analysis.direction has already been synchronized to the authoritative
      // Direction Verdict above. Record the early Game Plan result for diagnostics;
      // the final hierarchy is the sole owner of Game Plan authorization.
      if (gamePlanEnabled) {
        const gpThreshold = (config as any).gpHardBlockThreshold ?? 75;
        const gpGate = evaluateGamePlanGate(activeGamePlan, pair, analysis.direction, gpEnforcementMode, gpThreshold);
        const ownedGpGate = {
          passed: true,
          reason: `[diagnostic:gameplan_alignment] ${gpGate.reason}; final decision hierarchy owns authorization`,
        };
        gates.push(ownedGpGate);
        console.log(
          `[scan ${scanCycleId}] ℹ️ ${pair}: GP gate deferred to final hierarchy`
          + ` — mode=${gpEnforcementMode}, biasConf=${gpGate.biasConfidence}%, threshold=${gpThreshold}%, direction=${analysis.direction}`,
        );
      }
      // ── News Impact Alignment Gate ──
      // If we have analyzed news impacts, check if the trade direction aligns with news bias.
      // This is an ADVISORY gate — only blocks when news strongly conflicts (strength >= 40).
      const newsImpacts = (activeGamePlan as any)?.newsImpacts;
      if (newsImpacts && newsImpacts.length > 0 && (config as any).newsFilterEnabled !== false) {
        try {
          const newsAlignment = checkNewsAlignment(pair, analysis.direction as "long" | "short", newsImpacts);
          const newsConflictEnforced =
            gamePlanAffectsExecution && newsAlignment.conflicting;
          if (newsAlignment.conflicting) {
            gates.push({
              passed: !newsConflictEnforced,
              reason: gamePlanAffectsExecution
                ? `News conflict: ${newsAlignment.advisory}`
                : `[diagnostic:gameplan_news] News conflict observed: ${newsAlignment.advisory}; Game Plan mode is off`,
            });
            console.log(
              `[scan ${scanCycleId}] ${newsConflictEnforced ? "❌" : "ℹ️"} ${pair}: News strongly opposes ${analysis.direction} (${newsAlignment.pairBias} bias, ${newsAlignment.strength}% strength)`,
            );
          } else if (!newsAlignment.aligned && newsAlignment.strength >= 25) {
            // Moderate conflict — log warning but allow
            gates.push({ passed: true, reason: `News caution: ${newsAlignment.advisory}` });
            console.log(`[scan ${scanCycleId}] ⚠️ ${pair}: News mildly opposes ${analysis.direction} (${newsAlignment.strength}% strength) — allowing`);
          } else if (newsAlignment.aligned && newsAlignment.strength >= 30) {
            // News supports the trade — log confirmation
            gates.push({ passed: true, reason: `News confirms: ${newsAlignment.advisory}` });
            console.log(`[scan ${scanCycleId}] ✅ ${pair}: News supports ${analysis.direction} (${newsAlignment.pairBias} bias, ${newsAlignment.strength}% strength)`);
          }
        } catch (naErr: any) {
          console.warn(`[scan ${scanCycleId}] News alignment check error (non-fatal): ${naErr?.message}`);
        }
      }
      // ── SMC Video Enhancements (opt-in) ──────────────────────────────────────
      // Runs additional analysis modules when config.smcEnhancements is non-null.
      // Results are APPENDED to existing gates/factors — never replacing.
      let smcEnhResult: SMCEnhancementsResult | null = null;
      if (config.smcEnhancements) {
        try {
          const zoneHigh = (analysis as any).impulseZone?.high ?? (analysis.pd as any)?.premiumStart ?? null;
          const zoneLow = (analysis as any).impulseZone?.low ?? (analysis.pd as any)?.discountEnd ?? null;
          smcEnhResult = runSMCEnhancements(
            candles,
            dailyCandles.length >= 10 ? dailyCandles : null,
            analysis.orderBlocks || [],
            analysis.direction as "long" | "short" | null,
            zoneHigh,
            zoneLow,
            analysis.lastPrice ?? null,
            config.smcEnhancements,
            monthlyCandles,
          );
          // Append supplementary gates
          if (smcEnhResult.additionalGates.length > 0) {
            gates.push(...smcEnhResult.additionalGates);
          }
          // Attach enhancement factors to analysis for dashboard visibility
          if (smcEnhResult.additionalFactors.length > 0) {
            (analysis as any).smcEnhancementFactors = smcEnhResult.additionalFactors;
          }
          // Attach full result for downstream use (TP override, breaker entries)
          (analysis as any).smcEnhancements = smcEnhResult;
        } catch (enhErr: any) {
          console.warn(`[scan ${scanCycleId}] SMC enhancements error (non-fatal): ${enhErr?.message}`);
        }
      }

      let allPassed = gates.every(g => g.passed);
      (detail as any).gamePlanShadowAudit = finalizeShadowCurrentDecision(
        (detail as any).gamePlanShadowAudit,
        allPassed && !!analysis.stopLoss && !!analysis.takeProfit ? "allow" : "block",
        allPassed
          ? (!analysis.stopLoss || !analysis.takeProfit ? "No valid SL/TP" : null)
          : gates.filter(g => !g.passed).map(g => g.reason).join("; "),
      );
      // ── Sync detail with post-credit state so dashboard display matches gate decisions ──
      // Impulse zone credits (lines ~3934-4120) reassign analysis.tieredScoring to a new object,
      // but detail.tieredScoring still references the pre-credit snapshot. Sync it here.
      detail.tieredScoring = analysis.tieredScoring;
      detail.score = analysis.score;
      detail.gates = gates;
      detail.gamePlan = shadowPairPlan ? {
        bias: shadowPairPlan.bias,
        biasConfidence: shadowPairPlan.biasConfidence,
        state: shadowPairPlan.state,
        stateReason: shadowPairPlan.stateReason,
      } : null;
      const streamlinedDecisionContext = (detail as any).decisionContext;
      const streamlinedDirectionVerdict =
        streamlinedDecisionContext?.directionVerdict ||
        activeDirectionVerdict ||
        null;
      const streamlinedConviction =
        streamlinedDecisionContext?.thesisConviction?.evidence;
      const marketLocationObservation =
        (detail as any).canonicalDealingRangeObservation?.canonical || null;
      const frozenEntryPrice = Number(currentPendingCandidate?.entry_price ??
        (pairConfig.preArmZoneSetups === true ? preparedZoneWatch?.entry_price : Number.NaN));
      const canonicalLocationObservation = Number.isFinite(frozenEntryPrice)
        ? evaluateCanonicalDealingRange({
          range: marketLocationObservation?.range || null,
          direction: analysis.direction as "long" | "short",
          price: frozenEntryPrice,
          mode: normalizeDealingRangeMode((pairConfig as any).dealingRangeMode, {
            onlyBuyInDiscount: pairConfig.onlyBuyInDiscount,
            onlySellInPremium: pairConfig.onlySellInPremium,
          }),
        })
        : marketLocationObservation;
      if (Number.isFinite(frozenEntryPrice)) {
        const frozenStop = Number(currentPendingCandidate?.stop_loss ?? preparedZoneWatch?.sl_level);
        const frozenTarget = Number(currentPendingCandidate?.take_profit ?? preparedZoneWatch?.tp_level);
        (detail as any).frozenExecutablePlan = {
          contractVersion: "frozen-executable-plan.v1",
          candidateId: currentPendingCandidate?.candidate_id || preparedZoneWatch?.candidate_id || null,
          entryPrice: frozenEntryPrice,
          stopLoss: Number.isFinite(frozenStop) ? frozenStop : null,
          takeProfit: Number.isFinite(frozenTarget) ? frozenTarget : null,
          location: canonicalLocationObservation,
        };
        (detail as any).canonicalDealingRangeObservation = {
          ...((detail as any).canonicalDealingRangeObservation || {}),
          marketPriceObservation: marketLocationObservation,
          canonical: canonicalLocationObservation,
          evaluatedPriceOwner: "frozen_executable_entry",
        };
      }
      const singleOwnershipCandidateId =
        izData?.bestZone?.candidateModel?.candidateId ||
        izData?.bestZone?.localConfluence?.candidateId ||
        (detail as any).crossTimeframeCandidateId ||
        "candidate:" + scanCycleId + ":" + pair;
      const candidateConfirmationMethod = pairConfig.confirmationMethod || "choch";
      const candidateSweep = (detail as any).sweepReclaim?.bestReclaim ||
        (detail as any).sweepReclaim?.sweeps?.[0] || null;
      const candidateSweepEvent = candidateSweep?.sweptLevel
        ? { level: candidateSweep.sweptLevel, type: candidateSweep.type || "buy-side" }
        : null;
      const candidateConfirmationSignal = candidateConfirmationMethod === "indicators"
        ? null
        : detectZoneConfirmation(
          roleCandles.confirmation,
          analysis.direction as "long" | "short",
          DEFAULT_ZONE_CONFIRMATION_CONFIG,
          undefined,
          pair,
          izData?.bestZone
            ? { zoneLow: izData.bestZone.low, zoneHigh: izData.bestZone.high }
            : undefined,
          roleCandles.refinement.length >= 15 ? roleCandles.refinement : undefined,
          candidateSweepEvent,
          (detail as any).signalSource === "cascade" ? "cascade"
            : (detail as any).signalSource === "unified" ? "unified" : "standalone",
        );
      const candidateIndicatorConfirmation = candidateConfirmationMethod === "choch"
        ? null
        : checkIndicatorConfirmation(
          roleCandles.confirmation,
          analysis.direction as "long" | "short",
          { minIndicators: pairConfig.indicatorMinCount || 3 },
        );
      const candidateEntryConfirmationPassed = candidateConfirmationMethod === "choch"
        ? !!candidateConfirmationSignal
        : candidateConfirmationMethod === "indicators"
        ? candidateIndicatorConfirmation?.confirmed === true
        : !!candidateConfirmationSignal && candidateIndicatorConfirmation?.confirmed === true;
      const canonicalStructureDecision = evaluateCanonicalStructureDecision({
        direction: analysis.direction as "long" | "short" | null,
        structure: canonicalStructureAuthority,
        liquidity: canonicalLiquiditySequence,
        requireLiquiditySweep: pairConfig.requireLiquiditySweep === true,
      });
      const sequenceDirection = analysis.direction === "long" ? "bullish" : "bearish";
      const observedLiquiditySequence = [...canonicalLiquiditySequence.sequences]
        .reverse()
        .find((sequence) => sequence.direction === sequenceDirection && sequence.sweep) || null;
      const confirmationTime = candidateConfirmationSignal?.authority?.candleTime || null;
      const confirmationId = candidateConfirmationSignal && confirmationTime
        ? buildLiquidityConfirmationId({
          symbol: pair,
          timeframe: timeframeAuthority.roles.confirmation,
          direction: analysis.direction as "long" | "short",
          candleTime: confirmationTime,
          price: candidateConfirmationSignal.price,
          type: candidateConfirmationSignal.type,
        })
        : null;
      const liquidityConfirmationObservation = observeLiquidityConfirmation({
        candidateId: currentPendingCandidate?.candidate_id ||
          existingStaged?.candidate_id || singleOwnershipCandidateId,
        stagedAt: existingStaged?.staged_at || null,
        zoneTouchTime: currentPendingCandidate?.zone_touch_time || null,
        sequence: observedLiquiditySequence,
        confirmationId,
        confirmationTime,
      });
      (detail as any).liquidityConfirmationObservation = liquidityConfirmationObservation;
      if (currentPendingCandidate?.order_id) {
        await supabase.from("pending_orders").update({
          liquidity_confirmation_observation: liquidityConfirmationObservation,
        }).eq("order_id", currentPendingCandidate.order_id).eq("user_id", userId)
          .in("status", ["pending", "awaiting_confirmation"]);
      }
      if (existingStaged?.id) {
        await supabase.from("staged_setups").update({
          liquidity_confirmation_observation: liquidityConfirmationObservation,
        }).eq("id", existingStaged.id).eq("user_id", userId);
      }
      (detail as any).canonicalStructureDecision = canonicalStructureDecision;
      (detail as any).entryConfirmationCandidate = {
        method: candidateConfirmationMethod,
        passed: candidateEntryConfirmationPassed,
        signal: candidateConfirmationSignal,
        indicators: candidateIndicatorConfirmation,
      };
      const entryZoneAvailable = cascadeResult?.state === "triggered" ||
        unifiedZoneData?.hasZone === true || izData?.hasZone === true;
      const entryZoneReady = cascadeResult?.state === "triggered"
        ? true
        : unifiedZoneData?.hasZone
        ? unifiedGatePassed
        : izData?.hasZone
        ? izData?.bestZone?.priceAtZoneStrict === true &&
          candidateEntryConfirmationPassed
        : null;
      (detail as any).singleOwnershipDecision =
        evaluateSingleOwnershipDecision({
          evaluatedAt: streamlinedDecisionContext?.evaluatedAt ||
            new Date().toISOString(),
          identity: {
            candidateId: singleOwnershipCandidateId, symbol: pair,
            direction: analysis.direction as "long" | "short" | null,
          },
          direction: {
            verdict: streamlinedDirectionVerdict?.verdict || null,
            shouldBlock: streamlinedDirectionVerdict?.shouldBlock ?? null,
            evidenceId: streamlinedDirectionVerdict?.id || null,
          },
          entryZone: {
            available: entryZoneAvailable, valid: entryZoneAvailable ? true : null,
            entryReady: entryZoneReady,
            source: (detail as any).signalSource || null,
            candidateId: singleOwnershipCandidateId,
            setupFamily: (detail as any).signalSource === "cascade"
              ? "cascade"
              : "impulse",
            sourceEvidenceIds: selectedZoneConceptEvidence().map((item: any) =>
              String(item.evidenceId)
            ),
            impulseId: canonicalLocationObservation?.range?.impulseId || null,
            poiType: izData?.bestZone?.type || null,
            reasonCodes: entryZoneAvailable
              ? ["entry_zone_available"]
              : ["entry_zone_unavailable"],
          },
          canonicalLocation: {
            required: ((pairConfig as any).dealingRangeMode || "avoid_wrong_side") !== "off",
            available: canonicalLocationObservation?.available === true,
            allowed: canonicalLocationObservation?.available === true
              ? canonicalLocationObservation.allowed === true
              : null,
            rangeId: canonicalLocationObservation?.range?.impulseId || null,
            reasonCode: canonicalLocationObservation?.code || null,
          },
          confirmation: {
            required: entryZoneAvailable, passed: entryZoneReady,
            authorityVersion: "confirmation-authority.v1",
            reasonCodes: entryZoneReady ? ["zone_confirmation_ready"] : ["zone_confirmation_waiting"],
          },
          thesis: {
            required: streamlinedDecisionContext?.thesisValidity?.required === true,
            valid: streamlinedDecisionContext?.thesisValidity?.valid ?? null,
            reasonCodes: [streamlinedDecisionContext?.thesisValidity?.checkType || "thesis_validation"],
          },
          safety: {
            complete: true,
            checks: operationalSafetyChecks(gates.map((gate) => ({
              code: normalizeRejectedGate(gate.reason), passed: gate.passed,
            }))),
          },
          legacyDiagnostics: {
            rawScore: analysis.score, effectiveScore,
            threshold: conflictAdjustedMinConfluence,
            tier1Count: analysis.tieredScoring?.tier1Count ?? null,
            tier2Count: analysis.tieredScoring?.tier2Count ?? null,
            tier3Count: analysis.tieredScoring?.tier3Count ?? null,
            tier1GatePassed: analysis.tieredScoring?.tier1GatePassed ?? null,
          },
        });
      const singleOwnershipEnforcement = evaluateSingleOwnershipEnforcement({
        requestedMode: (pairConfig as any).singleOwnershipMode,
        runtimeTarget: account.execution_mode === "live" ? "live" : "paper",
        decision: (detail as any).singleOwnershipDecision,
      });
      const canonicalStructureEnforcement = evaluateCanonicalStructureEnforcement({
        requestedMode: (pairConfig as any).canonicalStructureMode,
        singleOwnershipEffectiveMode: singleOwnershipEnforcement.effectiveMode,
        decision: canonicalStructureDecision,
      });
      (detail as any).canonicalStructureEnforcement = canonicalStructureEnforcement;
      (detail as any).singleOwnershipEnforcement = singleOwnershipEnforcement;
      const singleOwnershipScanOutcome = resolveSingleOwnershipScanOutcome({
        enforcement: singleOwnershipEnforcement,
        decision: (detail as any).singleOwnershipDecision,
      });
      if (singleOwnershipEnforcement.effectiveMode === "enforce") {
        // In ownership enforcement, named authorities replace all legacy market-quality
        // scores and gates. Operational safety is already owned by the decision.
        allPassed = singleOwnershipEnforcement.authorized;
      }
      if (canonicalStructureEnforcement.effectiveMode === "enforce") {
        allPassed = allPassed && canonicalStructureEnforcement.authorized;
      }

      const ownedDecision = (detail as any).singleOwnershipDecision;
      const scannerLiquidityState = unifiedZoneData?.liquidity?.entryTriggerState || "none";
      (detail as any).canonicalScannerState = projectCanonicalScannerState({
        evaluatedAt: ownedDecision.evaluatedAt,
        identity: ownedDecision.identity,
        direction: {
          available: !!ownedDecision.authorities.direction.verdict,
          allowed: ownedDecision.authorities.direction.shouldBlock === null
            ? null
            : !ownedDecision.authorities.direction.shouldBlock &&
              ownedDecision.authorities.direction.verdict === ownedDecision.identity.direction,
          evidenceId: ownedDecision.authorities.direction.evidenceId || null,
        },
        structure: {
          required: canonicalStructureEnforcement.effectiveMode === "enforce",
          decision: canonicalStructureDecision.decision,
          source: "canonical_structure_sequence",
          evidenceId: canonicalStructureDecision.sequenceId,
          reasonCode: canonicalStructureDecision.reasonCode,
        },
        zone: {
          available: ownedDecision.authorities.entryZone.available,
          valid: ownedDecision.authorities.entryZone.valid,
          atPoi: ownedDecision.authorities.entryZone.available &&
            (unifiedZoneData?.price?.atZone === true ||
              izData?.bestZone?.priceAtZone === true),
          evidenceId: ownedDecision.authorities.entryZone.candidateId || null,
          reasonCode: ownedDecision.authorities.entryZone.reasonCodes[0] || null,
        },
        location: ownedDecision.authorities.canonicalLocation,
        liquidity: {
          policy: pairConfig.requireLiquiditySweep === true
            ? "required" : scannerLiquidityState === "none"
            ? "not_required" : "supporting",
          state: ["unswept", "swept_rejected", "swept_absorbed"].includes(scannerLiquidityState)
            ? scannerLiquidityState : "none",
          source: "zone_liquidity",
        },
        confirmation: {
          required: ownedDecision.authorities.confirmation.required,
          passed: ownedDecision.authorities.confirmation.passed,
          awaitingRetracement:
            (detail as any).postChochRetracement?.status === "waiting",
          evidenceId: confirmationId,
          reasonCode: ownedDecision.authorities.confirmation.reasonCodes[0] || null,
        },
        thesis: ownedDecision.authorities.thesis,
        safety: {
          complete: ownedDecision.authorities.safety.complete,
          passed: ownedDecision.authorities.safety.checks.every((check: any) => check.passed),
          reasonCode: ownedDecision.authorities.safety.checks.find((check: any) => !check.passed)?.code || null,
        },
        execution: {
          authorized: singleOwnershipEnforcement.effectiveMode === "enforce"
            ? singleOwnershipEnforcement.authorized : allPassed,
          source: "final_trade_authorization",
        },
      });

      const canonicalScannerEnforcement = evaluateCanonicalScannerEnforcement({
        requestedMode: (pairConfig as any).canonicalScannerMode,
        singleOwnershipEffectiveMode: singleOwnershipEnforcement.effectiveMode,
        state: (detail as any).canonicalScannerState,
      });
      (detail as any).canonicalScannerEnforcement = canonicalScannerEnforcement;
      if (canonicalScannerEnforcement.effectiveMode === "enforce") {
        allPassed = canonicalScannerEnforcement.authorized;
      }

      (detail as any).tradeDecisionPresentation = buildTradeDecisionPresentation({
        state: (detail as any).canonicalScannerState,
        legacyDiagnostics: (detail as any).legacyGateDiagnostics || [],
      });

      (detail as any).streamlinedTradeDecision =
        buildStreamlinedTradeDecisionObservation({
          evaluatedAt: streamlinedDecisionContext?.evaluatedAt ||
            new Date().toISOString(),
          candidateId: "candidate:" + scanCycleId + ":" + pair,
          symbol: pair,
          direction: analysis.direction as "long" | "short" | null,
          authority: {
            stylePolicyVersion: pairStylePolicy.contractVersion,
            stylePolicyHash: pairStylePolicy.policyHash,
            styleBasePolicyHash: pairStylePolicy.basePolicyHash,
            timeframeEvidenceId:
              (detail as any).timeframeEvidenceId || null,
            gamePlanId:
              streamlinedDecisionContext?.gamePlan?.id || null,
            gamePlanVersion:
              streamlinedDecisionContext?.gamePlan?.version || null,
            directionVerdictVersion:
              streamlinedDirectionVerdict?.verdictVersion || null,
          },
          directionVerdict: streamlinedDirectionVerdict,
          directionReasonCode:
            streamlinedDecisionContext?.hierarchy?.code ||
            "direction_evidence_unavailable",
          legacyScoring: {
            rawScore: analysis.score,
            effectiveScore,
            threshold: conflictAdjustedMinConfluence,
          },
          thesis: {
            validationRequired:
              streamlinedDecisionContext?.thesisValidity?.required === true,
            valid:
              streamlinedDecisionContext?.thesisValidity?.valid ?? null,
            conviction:
              typeof streamlinedConviction?.conviction === "number"
                ? streamlinedConviction.conviction
                : null,
            degrading:
              typeof streamlinedConviction?.thesisDegrading === "boolean"
                ? streamlinedConviction.thesisDegrading
                : null,
            reasonCode:
              streamlinedDecisionContext?.thesisValidity?.checkType ||
              "thesis_validation",
            version: THESIS_VALIDATION_VERSION,
            evaluatedAt:
              streamlinedDecisionContext?.thesisValidity?.evaluatedAt || null,
          },
          confirmation: {
            required:
              streamlinedDecisionContext?.entryConfirmation?.required === true,
            passed:
              streamlinedDecisionContext?.entryConfirmation?.passed ?? null,
            reasonCode:
              streamlinedDecisionContext?.entryConfirmation?.method ||
              "confirmation_not_required",
            evaluatedAt:
              streamlinedDecisionContext?.entryConfirmation?.evaluatedAt ||
              null,
          },
          gates,
          safetyComplete: true,
          factors: analysis.factors,
          locationEvidence: {
            source: "zone_story_and_market_location",
            id: (detail as any).crossTimeframeCandidateId || null,
            observedAt: streamlinedDecisionContext?.evaluatedAt || null,
          },
        });
      const streamlinedLifecycle = lifecycleProjection(
        (detail as any).streamlinedTradeDecision,
        "candidate",
        analysis.lastPrice,
      );
      Object.assign(detail as any, streamlinedLifecycle);
      // Historical Streamlined Decision remains observable. It has no runtime
      // enforcement object because Single Ownership exclusively controls allPassed.
      const streamlinedStagedId = existingStaged?.id ||
        (detail as any).staging?.setupId || null;
      if (streamlinedStagedId) {
        const { error: streamlinedStageError } = await supabase
          .from("staged_setups")
          .update({
            streamlined_decision_origin:
              streamlinedLifecycle.streamlinedDecisionOrigin,
            streamlined_decision_latest:
              streamlinedLifecycle.streamlinedDecisionLatest,
          })
          .eq("id", streamlinedStagedId)
          .eq("user_id", userId)
          .is("streamlined_decision_origin", null);
        if (streamlinedStageError) {
          console.warn(
            "[streamlined] Watchlist persistence failed for " + pair + ": " +
              streamlinedStageError.message,
          );
        }
      }
      if (streamlinedStagedId) {
        await supabase.from("staged_setups").update({
          streamlined_decision_latest:
            streamlinedLifecycle.streamlinedDecisionLatest,
        }).eq("id", streamlinedStagedId).eq("user_id", userId);
      }
      const replayZone = unifiedZoneData?.hasZone
        ? {
          source: (detail as any).signalSource || "unified",
          state: unifiedZoneData.state || null,
          hasZone: true,
          entryReady: unifiedZoneData.confirmation?.entryReady === true,
          score: unifiedZoneData.unifiedScore ?? null,
          timeframe: unifiedZoneData.selectedTF ??
            unifiedZoneData.multiTFResult?.selectedTF ??
            null,
          low: unifiedZoneData.zone?.low ?? null,
          high: unifiedZoneData.zone?.high ?? null,
          entry: unifiedZoneData.entry?.entryPrice ?? null,
        }
        : {
          source: (detail as any).signalSource || "standalone",
          state: izData?.hasZone
            ? (izData.bestZone?.priceAtZone ? "triggered" : "waiting_for_price")
            : "no_zone",
          hasZone: izData?.hasZone === true,
          entryReady: izData?.bestZone?.priceAtZone === true,
          score: izData?.bestZone?.totalScore ?? null,
          timeframe: izData?.selectedTF ?? null,
          low: izData?.bestZone?.low ?? null,
          high: izData?.bestZone?.high ?? null,
          entry: izData?.bestZone?.refinedEntry ?? null,
        };
      const replayEvaluatedAt = candles[candles.length - 1]?.datetime || null;
      const replayInputFingerprint = replayEvaluatedAt
        ? await buildGoldenReplayRuntimeInputFingerprint({
          symbol: pair,
          evaluatedAt: replayEvaluatedAt,
          stylePolicy: pairStylePolicy,
          roleCandles,
          runtimeConfig: pairConfig,
        })
        : null;
      (detail as any).goldenReplaySnapshot = await buildGoldenReplaySnapshot({
        surface: "live",
        symbol: pair,
        evaluatedAt: replayEvaluatedAt || new Date().toISOString(),
        provenance: {
          inputFingerprint: replayInputFingerprint,
        },
        stylePolicy: pairStylePolicy,
        direction: analysis.direction,
        directionVerdict: {
          verdict: directionVerdict?.verdict || null,
          confidence: directionVerdict?.confidence ?? null,
          shouldBlock: directionVerdict?.shouldBlock ?? null,
          version: activeDirectionVerdict?.verdictVersion || null,
          gamePlanVersion:
            activeDirectionVerdict?.gamePlanVersion || null,
        },
        gamePlan: shadowPairPlan
          ? {
            id: shadowPairPlan.gamePlanId || null,
            version: shadowPairPlan.planVersion ||
              activeGamePlan?.planVersion ||
              null,
            state: shadowPairPlan.state || null,
            bias: shadowPairPlan.bias || null,
            confidence: shadowPairPlan.biasConfidence ?? null,
          }
          : null,
        zone: replayZone,
        scenario: {
          enforcement: "observe_only",
          selectedScenarioIndex: null,
          candidates: (shadowPairPlan?.scenarios || []).map(
            (scenario: any, index: number) => ({
              index,
              direction: scenario.direction || null,
              condition: scenario.condition || null,
              action: scenario.action || null,
              target: scenario.targetLevel ?? null,
              invalidation: scenario.invalidation || null,
            }),
          ),
        },
        scoring: {
          raw: analysis.score,
          effective: effectiveScore,
          threshold: conflictAdjustedMinConfluence,
          passed: effectiveScore >= conflictAdjustedMinConfluence,
        },
        gates,
        execution: {
          eligible: allPassed &&
            !!analysis.stopLoss &&
            !!analysis.takeProfit,
          entryPrice: analysis.lastPrice,
          stopLoss: analysis.stopLoss,
          takeProfit: analysis.takeProfit,
          riskReward: analysis.stopLoss && analysis.takeProfit
            ? Math.abs(analysis.takeProfit - analysis.lastPrice) /
              Math.abs(analysis.lastPrice - analysis.stopLoss)
            : null,
          positionSize: null,
          orderType: null,
        },
        managementContractVersion: "management-policy.v1",
      });
      const finalizeDetailGoldenReplay = async (
        finalization: GoldenReplayFinalization,
      ) => {
        (detail as any).goldenReplaySnapshot =
          await finalizeGoldenReplaySnapshot(
            (detail as any).goldenReplaySnapshot,
            finalization,
          );
        return (detail as any).goldenReplaySnapshot;
      };

      if (singleOwnershipScanOutcome.disposition === "wait") {
        detail.status = singleOwnershipScanOutcome.status;
        detail.reason = singleOwnershipScanOutcome.reasons.join("; ");
        detail.waitingReasons = singleOwnershipScanOutcome.reasons;
        scanDetails.push(detail);
        continue;
      }

      if (allPassed && analysis.stopLoss && analysis.takeProfit) {
        // Adjust SL buffer for JPY pairs
        const spec = SPECS[pair] || SPECS["EUR/USD"];
        let sl = analysis.stopLoss;
        let tp = analysis.takeProfit;
        // next_level delegates to calculateSLTP so every route shares target selection and fallback policy.
        const computeTP = (entry: number, newSl: number, direction: string): number => {
          const risk = Math.abs(entry - newSl);
          if (pairConfig.tpMethod === "next_level") {
            const gamePlanContext = (pairConfig as any)._gamePlanContext;
            const dolTargets = (pairConfig as any).dolTPExtensionEnabled !== false && gamePlanContext?.dol
              ? (Array.isArray(gamePlanContext.dol) ? gamePlanContext.dol : [gamePlanContext.dol])
              : undefined;
            const target = calculateSLTP({
              direction: direction as "long" | "short",
              lastPrice: entry,
              pipSize: spec.pipSize,
              config: pairConfig,
              swings: analysis.structure?.swingPoints || [],
              orderBlocks: analysis.orderBlocks || [],
              liquidityPools: analysis.liquidityPools || [],
              pdLevels: analysis.pdLevels || null,
              atrValue: Number((analysis as any).atrValue) || 0,
              fvgs: analysis.fvgs || [],
              fibExtensions: analysis.fibLevels?.extensions,
              dolTargets,
              resolvedStopLoss: newSl,
            });
            return target.takeProfit ?? Number.NaN;
          }
          // ── Fib 3-Point Extension TP (SMC Enhancement) ──
          // Measures extensions from the ENTRY point (Point C), not from the swing origin.
          // Uses the first extension level that satisfies minRiskReward.
          if ((pairConfig.tpMethod as string) === "fib_extension_3pt" && smcEnhResult?.fibExtension) {
            const ext = smcEnhResult.fibExtension;
            // Try each extension level (ordered from nearest to farthest)
            for (const level of ext.levels) {
              const tpCandidate = level.price;
              const tpOnCorrectSide = direction === "long"
                ? tpCandidate > entry
                : tpCandidate < entry;
              if (!tpOnCorrectSide) continue;
              const extensionRR = Math.abs(tpCandidate - entry) / risk;
              if (extensionRR >= (pairConfig.minRiskReward ?? 1.0)) {
                return tpCandidate;
              }
            }
            // Fallback: no extension level satisfies R:R, use default ratio
          }
          return direction === "long" ? entry + risk * pairConfig.tpRatio : entry - risk * pairConfig.tpRatio;
        };

        // calculateSLTP owns the configured SL method. Only recalculate from
        // structure when Direction Verdict actually flipped the direction,
        // because the original SL is then on the wrong side of the entry.
        const originalSlSide = analysis.stopLoss != null
          ? (analysis.stopLoss < analysis.lastPrice ? "long" : "short")
          : null;
        const directionFlipped = originalSlSide !== null && originalSlSide !== analysis.direction;
        if (directionFlipped && analysis.direction === "long") {
          const swingLows = analysis.structure.swingPoints.filter((s: SwingPoint) => s.type === "low" && s.price < analysis.lastPrice).slice(-3);
          if (swingLows.length > 0) {
            sl = Math.max(...swingLows.map((s: SwingPoint) => s.price)) - adjustedSlBuffer * spec.pipSize;
            tp = computeTP(analysis.lastPrice, sl, "long");
          } else {
            // No swings available AND direction was flipped — fall back to ATR/static floor
            // instead of leaving the inverted analysis.stopLoss in place.
            const fallbackPips = Math.max(MIN_SL_PIPS[pair] ?? 15, 20);
            sl = analysis.lastPrice - fallbackPips * spec.pipSize;
            tp = computeTP(analysis.lastPrice, sl, "long");
            console.log(`[${pair}] Direction flipped to LONG with no swing lows — using fallback SL ${fallbackPips}p`);
          }
        } else if (directionFlipped) {
          const swingHighs = analysis.structure.swingPoints.filter((s: SwingPoint) => s.type === "high" && s.price > analysis.lastPrice).slice(-3);
          if (swingHighs.length > 0) {
            sl = Math.min(...swingHighs.map((s: SwingPoint) => s.price)) + adjustedSlBuffer * spec.pipSize;
            tp = computeTP(analysis.lastPrice, sl, "short");
          } else {
            const fallbackPips = Math.max(MIN_SL_PIPS[pair] ?? 15, 20);
            sl = analysis.lastPrice + fallbackPips * spec.pipSize;
            tp = computeTP(analysis.lastPrice, sl, "short");
            console.log(`[${pair}] Direction flipped to SHORT with no swing highs — using fallback SL ${fallbackPips}p`);
          }
        }

        // ── Enforce minimum SL distance (two-layer floor) ──
        // Layer 1: Per-instrument static floor (MIN_SL_PIPS)
        const staticMinSlPips = MIN_SL_PIPS[pair] ?? 15;
        // Layer 2: Dynamic ATR-based floor (adapts to current volatility)
        const atrVal = (analysis as any).atrValue ?? 0;
        const atrFloorPips = atrVal > 0 ? (atrVal * ATR_SL_FLOOR_MULTIPLIER) / spec.pipSize : 0;
        // Use whichever floor is larger
        const effectiveMinSlPips = Math.max(staticMinSlPips, atrFloorPips);
        const minSlDistance = effectiveMinSlPips * spec.pipSize;
        const actualSlDistance = Math.abs(analysis.lastPrice - sl);
        if (actualSlDistance < minSlDistance) {
          const floorSource = atrFloorPips > staticMinSlPips ? `ATR(${atrFloorPips.toFixed(1)}p)` : `static(${staticMinSlPips}p)`;
          console.log(`[${pair}] SL too tight: ${(actualSlDistance / spec.pipSize).toFixed(1)} pips < min ${effectiveMinSlPips.toFixed(1)} pips [${floorSource}]. Widening SL.`);
          if (analysis.direction === "long") {
            sl = analysis.lastPrice - minSlDistance;
          } else {
            sl = analysis.lastPrice + minSlDistance;
          }
          // Recalculate TP based on widened SL
          tp = computeTP(analysis.lastPrice, sl, analysis.direction);
        }
        // ── Impulse Zone SL Override (hard gate mode) ──
        // When impulse zone gate is active and zone is confirmed, override SL to impulse origin.
        // This gives structural protection: SL is below where the impulse started (for longs)
        // or above where it started (for shorts). The impulse origin is the invalidation level.
        if (izGateMode === "hard" && izData?.hasZone && izData.bestZone?.priceAtZone) {
          const impulseData = izData.impulse;
          if (impulseData) {
            const impulseSL = analysis.direction === "long"
              ? impulseData.low - (adjustedSlBuffer * spec.pipSize)
              : impulseData.high + (adjustedSlBuffer * spec.pipSize);
            const impulseSlDistance = Math.abs(analysis.lastPrice - impulseSL);
            const currentSlDistance = Math.abs(analysis.lastPrice - sl);
            // Only override if impulse SL is wider than current SL (more protective)
            // and within reasonable bounds (not absurdly wide)
            const maxImpulseSlPips = (staticMinSlPips * (pairConfig.impulseSlCapMultiplier ?? 4)); // Configurable cap (default 4x)
            const impulseSlPips = impulseSlDistance / spec.pipSize;
            if (impulseSlDistance > currentSlDistance && impulseSlPips <= maxImpulseSlPips) {
              console.log(`[${pair}] Impulse Zone SL override: ${(Math.abs(analysis.lastPrice - sl) / spec.pipSize).toFixed(1)}p → ${impulseSlPips.toFixed(1)}p (impulse origin at ${impulseSL.toFixed(5)})`);
              sl = impulseSL;
              // Recalculate TP based on impulse SL for proper R:R
              tp = computeTP(analysis.lastPrice, sl, analysis.direction);
              detail.impulseZoneSLOverride = {
                originalSL: currentSlDistance / spec.pipSize,
                impulseSL: impulseSlPips,
                impulseOrigin: analysis.direction === "long" ? impulseData.low : impulseData.high,
              };
            } else if (impulseSlPips > maxImpulseSlPips) {
              console.log(`[${pair}] Impulse Zone SL too wide (${impulseSlPips.toFixed(1)}p > max ${maxImpulseSlPips}p). Keeping configured SL.`);
            } else if (impulseSlDistance <= currentSlDistance) {
              console.log(`[${pair}] ℹ️ Impulse Zone SL tighter than configured stop (${impulseSlPips.toFixed(1)}p < ${(currentSlDistance / spec.pipSize).toFixed(1)}p). Keeping configured SL.`);
            }
          }
        }

        // ── Unified Zone SL Override ──
        // When unified gate passed, use the unified engine's SL (based on impulse origin
        // from the best timeframe in the story).
        if (unifiedGatePassed && unifiedZoneData?.entry?.slPrice) {
          const unifiedSL = unifiedZoneData.entry.slPrice;
          const unifiedSlDistance = Math.abs(analysis.lastPrice - unifiedSL);
          const unifiedSlPips = unifiedSlDistance / spec.pipSize;
          const currentSlDistance = Math.abs(analysis.lastPrice - sl);
          const maxUnifiedSlPips = staticMinSlPips * (pairConfig.impulseSlCapMultiplier ?? 4);
          const unifiedOnCorrectSide = analysis.direction === "long"
            ? unifiedSL < analysis.lastPrice
            : unifiedSL > analysis.lastPrice;
          if (unifiedOnCorrectSide && unifiedSlDistance > currentSlDistance && unifiedSlPips <= maxUnifiedSlPips) {
            console.log(`[${pair}] Unified Zone SL override: ${(Math.abs(analysis.lastPrice - sl) / spec.pipSize).toFixed(1)}p \u2192 ${unifiedSlPips.toFixed(1)}p (unified story [${unifiedZoneData.selectedTF}])`);
            sl = unifiedSL;
            // Recalculate TP based on unified SL for proper R:R
            tp = computeTP(analysis.lastPrice, sl, analysis.direction);
            (detail as any).unifiedZoneSLOverride = {
              originalSLPips: currentSlDistance / spec.pipSize,
              unifiedSLPips: unifiedSlPips,
              source: `unified_${unifiedZoneData.selectedTF}_story`,
            };
          } else if (unifiedSlPips > maxUnifiedSlPips) {
            console.log(`[${pair}] Unified Zone SL too wide (${unifiedSlPips.toFixed(1)}p > max ${maxUnifiedSlPips}p). Keeping current SL.`);
          }
        }

        // ── Cascade Zone SL Override (swing_trader) ──
        // When cascade gate passed for swing, use the cascade engine's SL (below Daily zone origin).
        // This takes final priority for swing_trader as it's the most structurally sound SL.
        if (resolvedStyle === "swing_trader" && cascadeResult?.state === "triggered" && cascadeResult.sl) {
          const cascadeSL = cascadeResult.sl;
          const cascadeSlDistance = Math.abs(analysis.lastPrice - cascadeSL);
          const cascadeSlPips = cascadeSlDistance / spec.pipSize;
          const currentSlDistance = Math.abs(analysis.lastPrice - sl);
          const maxCascadeSlPips = staticMinSlPips * (pairConfig.impulseSlCapMultiplier ?? 6);
          const cascadeOnCorrectSide = analysis.direction === "long"
            ? cascadeSL < analysis.lastPrice
            : cascadeSL > analysis.lastPrice;
          if (cascadeOnCorrectSide && cascadeSlDistance > currentSlDistance && cascadeSlPips <= maxCascadeSlPips) {
            console.log(`[${pair}] Cascade Zone SL override: ${(Math.abs(analysis.lastPrice - sl) / spec.pipSize).toFixed(1)}p \u2192 ${cascadeSlPips.toFixed(1)}p (cascade Daily\u21924H\u21921H)`);
            sl = cascadeSL;
            // Recalculate TP based on cascade SL for proper R:R
            tp = computeTP(analysis.lastPrice, sl, analysis.direction);
            (detail as any).cascadeZoneSLOverride = {
              originalSLPips: currentSlDistance / spec.pipSize,
              cascadeSLPips: cascadeSlPips,
              source: "cascade_daily_h4_h1",
            };
          } else if (cascadeSlPips > maxCascadeSlPips) {
            console.log(`[${pair}] Cascade Zone SL too wide (${cascadeSlPips.toFixed(1)}p > max ${maxCascadeSlPips}p). Keeping current SL.`);
          }
        }

        // ── Regime-Adaptive TP Adjustment ──
        // When enabled, adjusts TP based on market regime (trending → extend, ranging → tighten).
        // Runs AFTER all SL/TP calculations but BEFORE the MIN_TP_PIPS gate.
        if (config.regimeAdaptiveTPEnabled && analysis.regimeInfo) {
          try {
            const tpAdjust = adjustTPForRegime({
              currentTP: tp,
              entryPrice: analysis.lastPrice,
              stopLoss: sl,
              direction: analysis.direction as "long" | "short",
              regimeInfo: analysis.regimeInfo,
              atrValue: (analysis as any).atrValue ?? 0,
              trendingRRMultiplier: config.trendingRRMultiplier ?? 1.5,
              rangingRRMultiplier: config.rangingRRMultiplier ?? 0.75,
            });
            if (tpAdjust.adjustedTP !== tp) {
              console.log(`[${pair}] Regime-adaptive TP: ${tpAdjust.reason}`);
              tp = tpAdjust.adjustedTP;
              detail.regimeTPAdjust = {
                originalTP: tpAdjust.originalTP,
                adjustedTP: tpAdjust.adjustedTP,
                originalRR: tpAdjust.originalRR,
                adjustedRR: tpAdjust.adjustedRR,
                regime: tpAdjust.regime,
                reason: tpAdjust.reason,
              };
            }
          } catch (e) {
            console.warn(`[${pair}] Regime TP adjust error:`, e);
          }
        }

        // ── Minimum TP distance gate ──
        // Reject trades where TP target is too small to be meaningful after spread.
        // A 3-pip TP on EUR/USD with 1.5 pip spread means 50% of profit is spread cost.
        const MIN_TP_PIPS: Record<string, number> = {
          "GBP/JPY": 30, "EUR/JPY": 25, "USD/JPY": 20,
          "GBP/USD": 20, "EUR/USD": 15, "AUD/USD": 15, "NZD/USD": 15,
          "USD/CAD": 15, "USD/CHF": 15, "EUR/GBP": 12,
          "XAU/USD": 40, "BTC/USD": 100,
        };
        const minTpPips = MIN_TP_PIPS[pair] ?? 12;
        const actualTpPips = Math.abs(tp - analysis.lastPrice) / spec.pipSize;
        if (actualTpPips < minTpPips) {
          console.log(`[${pair}] TP too small: ${actualTpPips.toFixed(1)} pips < min ${minTpPips} pips. Trade not worth the spread cost. SKIPPING.`);
          detail.status = "skipped_tp_too_small";
          detail.skipReason = `TP ${actualTpPips.toFixed(1)}p < min ${minTpPips}p`;
          await finalizeDetailGoldenReplay({
            execution: {
              eligible: false,
              entryPrice: analysis.lastPrice,
              stopLoss: sl,
              takeProfit: tp,
              riskReward: Math.abs(tp - analysis.lastPrice) /
                Math.abs(analysis.lastPrice - sl),
              positionSize: null,
              orderType: null,
            },
            lifecycle: {
              route: "candidate",
              stage: "protection",
              outcome: "blocked",
              reason: detail.skipReason,
            },
          });
          scanDetails.push(detail);
          continue;
        }

        // ── Portfolio Correlation Advisory (post-gate soft check) ──
        // Runs AFTER all 21 gates pass. Does NOT block trades — logs exposure and optionally reduces size.
        let correlationSizeMultiplier = 1.0;
        try {
          const portfolioCheck = checkPortfolioConflict(
            { symbol: pair, direction: analysis.direction as "long" | "short", size: 0.01 }, // size doesn't matter for correlation check
            openPosArr.filter((p: any) => p.position_status === "open").map((p: any) => ({
              symbol: p.symbol, direction: p.direction as "long" | "short",
              size: parseFloat(p.size), entryPrice: parseFloat(p.entry_price),
            })),
            { staticOnly: true }, // Use static correlations (fast, no candle fetch needed)
          );
          correlationSizeMultiplier = resolveCorrelationSizeMultiplier(
            portfolioCheck.concentrationScore,
          );
          if (correlationSizeMultiplier < 1.0) {
            console.log(`[${pair}] ⚠️ Portfolio correlation advisory: concentration=${(portfolioCheck.concentrationScore * 100).toFixed(0)}%, size multiplier=${correlationSizeMultiplier.toFixed(2)}. Conflicts: ${portfolioCheck.conflicts.map(c => c.detail).join("; ") || "none"}`);
            detail.correlationAdvisory = {
              concentrationScore: portfolioCheck.concentrationScore,
              sizeMultiplier: correlationSizeMultiplier,
              conflicts: portfolioCheck.conflicts.map(c => ({ type: c.type, pair: c.conflictsWith?.[0] ?? "unknown", correlation: c.severity, detail: c.detail })),
              currencyExposure: portfolioCheck.currencyExposure,
            };
          }
        } catch (corrErr: any) {
          console.warn(`[${pair}] Portfolio correlation check error (non-blocking): ${corrErr?.message}`);
        }

        // ── Unified Position Sizing (volatility scaling + prop firm compliance) ──
        // Portfolio heat and correlation checks are handled by Gates 6 & 22 above.
        const volCtx = resolveSizingVolatilityContext(analysis.regimeInfo);
        const propFirmCtx: PropFirmContext | undefined = (propFirmGateResult?.enabled) ? {
          enabled: true,
          sizeMultiplier: propFirmSizeMultiplier,
          dailyLossRemaining: undefined, // Already enforced by prop firm gate
          maxDrawdownRemaining: undefined,
        } : undefined;
        const sizingResult = computePositionSize(
          {
            balance,
            riskPercent: pairConfig.riskPerTrade,
            entryPrice: analysis.lastPrice,
            stopLoss: sl,
            symbol: pair,
            method: (pairConfig as any).positionSizingMethod || "percent_risk",
            fixedLotSize: (pairConfig as any).fixedLotSize,
            atrValue: (analysis as any).atrValue,
            atrVolatilityMultiplier: (pairConfig as any).atrVolatilityMultiplier,
            rateMap,
            commissionPerLot: avgCommissionPerLot,
          },
          undefined, // No portfolio context — Gates 6 & 22 handle this
          volCtx,
          propFirmCtx,
        );
        const finalSizing = applyFinalCandidateSizeAdjustments({
          sizingResult,
          correlationMultiplier: correlationSizeMultiplier,
          signalSource: (detail as any).signalSource,
          standaloneMultiplier: (pairConfig as any).standaloneMultiplier,
        });
        const size = finalSizing.lots;
        if (correlationSizeMultiplier < 1.0) {
          console.log(`[${pair}] Correlation advisory reduced size: ${sizingResult.lots} → ${finalSizing.afterCorrelationLots} (×${correlationSizeMultiplier.toFixed(2)})`);
        }
        if (sizingResult.adjustments.length > 0) {
          console.log(`[${pair}] Unified sizing: base=${sizingResult.baseLots} → final=${size} [${sizingResult.adjustments.map(a => `${a.type}:${a.multiplier.toFixed(2)}`).join(", ")}]`);
        }
        // ── Signal Source Size Multiplier ──
        // Unified signal = full conviction (1.0x). Standalone fallback = configurable (default 0.5x).
        // This reflects the higher confidence when the full story (impulse + liquidity +
        // confirmation) aligns vs just the impulse zone engine alone.
        if ((detail as any).signalSource !== "unified") {
          const standaloneMultiplier = Math.max(0.1, Math.min(1.0, (pairConfig as any).standaloneMultiplier ?? 0.5));
          console.log(`[${pair}] Signal source: standalone \u2014 size reduced ${finalSizing.afterCorrelationLots} \u2192 ${size} (\u00d7${standaloneMultiplier})`);
        } else {
          console.log(`[${pair}] Signal source: unified \u2014 full size ${size} (\u00d71.0)`);
        }

        const positionId = crypto.randomUUID().slice(0, 8);
        const orderId = crypto.randomUUID().slice(0, 8);
        const nowStr = new Date().toISOString();

        // Close-on-Reverse was previously fired here — MOVED to just before the market-order
        // insert (paper_positions.insert) below. Firing at this point was a bug: it closed
        // opposite live positions even when this new signal was ultimately queued as a
        // pending limit order that had not (and might never) fill. See CAD/JPY 2026-07-07.

        // Build exit flags metadata to store on the position
        // Intent fields (*Enabled) = user wants this feature
        // Activation fields (*Activated) = feature has actually triggered (starts false)
        const exitFlags = {
          // Trailing stop
          trailingStopEnabled: pairConfig.trailingStopEnabled,
          trailingStopPips: pairConfig.trailingStopPips,
          trailingStopActivation: pairConfig.trailingStopActivation,
          trailingStopActivated: false,
          trailingStopLevel: null as number | null,
          // Break-even
          breakEvenEnabled: pairConfig.breakEvenEnabled,
          breakEvenPips: pairConfig.breakEvenPips,
          breakEvenOffsetPips: (pairConfig as any).breakEvenOffsetPips ?? 0,
          breakEvenActivated: false,
          // Partial TP
          partialTPEnabled: pairConfig.partialTPEnabled,
          partialTPPercent: pairConfig.partialTPPercent,
          partialTPLevel: pairConfig.partialTPLevel,
          partialTPActivated: false,
          // Time + ratio
          maxHoldEnabled: pairConfig.maxHoldEnabled,
          maxHoldHours: pairConfig.maxHoldHours,
          tpRatio: pairConfig.tpRatio,
        };

        // ── Limit Order: Place pending order instead of market order if enabled and zone found ──
        // Consolidation: Skip legacy OB/FVG scan when a zone engine will override the entry.
        // Priority: unified > impulse > legacy. Only compute legacy if no zone engine fired.
        const zoneEngineWillOverride = (unifiedGatePassed && unifiedZoneData?.entry?.entryPrice)
          || (izGateMode === "hard" && izData?.bestZone);
        let limitEntry: any = zoneEngineWillOverride
          ? null
          : computeLimitEntryPrice(analysis, pair, analysis.direction);
        // ── Impulse Zone Entry Override ──
        // When hard gate is active and zone has a refined entry, use the zone's entry level
        // instead of the nearest OB/FVG from Tier 1. This ensures the limit order targets
        // the impulse zone's optimal entry (OTE level with S/R + LTF confirmation).
        if (izGateMode === "hard" && izData?.bestZone?.refinedEntry) {
          const zoneEntry = izData.bestZone.refinedEntry;
          const zoneLow = izData.bestZone.low;
          const zoneHigh = izData.bestZone.high;
          const zoneType = izData.bestZone.type?.toUpperCase() || "ZONE";
          limitEntry = {
            price: zoneEntry,
            zoneType: `IZ-${zoneType}`,
            lifecycleCandidateType: izData.bestZone.type,
            zoneLow,
            zoneHigh,
          };
          console.log(`[${pair}] Impulse Zone entry override: limit at ${zoneEntry.toFixed(5)} (${zoneType} zone)`);
        } else if (izGateMode === "hard" && izData?.bestZone && !limitEntry) {
          // Fallback: use zone midpoint if no refined entry available
          const zoneMid = (izData.bestZone.high + izData.bestZone.low) / 2;
          const zoneLow = izData.bestZone.low;
          const zoneHigh = izData.bestZone.high;
          const zoneType = izData.bestZone.type?.toUpperCase() || "ZONE";
          limitEntry = {
            price: zoneMid,
            zoneType: `IZ-${zoneType}`,
            lifecycleCandidateType: izData.bestZone.type,
            zoneLow,
            zoneHigh,
          };
          console.log(`[${pair}] Impulse Zone entry (midpoint): limit at ${zoneMid.toFixed(5)} (${zoneType} zone)`);
        }
        // ── Unified Zone Entry Override ──
        // When unified gate passed, the unified engine provides a precise entry from the
        // best timeframe story (Daily\u21924H\u21921H). This takes priority over impulse zone entry.
        if (unifiedGatePassed && unifiedZoneData?.entry?.entryPrice) {
          const unifiedEntry = unifiedZoneData.entry.entryPrice;
          const zonePOI = unifiedZoneData.zone;
          const zoneLow = zonePOI?.low ?? unifiedEntry;
          const zoneHigh = zonePOI?.high ?? unifiedEntry;
          const zoneType = `UNIFIED-${(unifiedZoneData.selectedTF || "1H").toUpperCase()}`;
          limitEntry = {
            price: unifiedEntry,
            zoneType,
            lifecycleCandidateType: zonePOI?.type ?? "",
            zoneLow,
            zoneHigh,
          };
          console.log(`[${pair}] Unified Zone entry override: limit at ${unifiedEntry.toFixed(5)} (${unifiedZoneData.selectedTF} story, score ${unifiedZoneData.unifiedScore}/14)`);
        }

        const observedNestedPoiEntry = effectiveFrozenNestedPoiEntry;
        const routedNestedPoiEntry = effectiveNestedPoiActivation.enforced
          ? observedNestedPoiEntry
          : null;
        if (effectiveNestedPoiActivation.enforced &&
          !routedNestedPoiEntry?.selected) {
          detail.status = "skipped_nested_poi_unavailable";
          detail.skipReason = existingStaged
            ? "Nested POI Market Trigger: existing setup has no frozen nested trigger; waiting for a new setup"
            : "Nested POI Market Trigger: no strictly-contained trigger is available; midpoint fallback is disabled";
          scanDetails.push(detail);
          continue;
        }
        if (effectiveNestedPoiActivation.enforced &&
          routedNestedPoiEntry?.selected) {
          const trigger = routedNestedPoiEntry.selected;
          limitEntry = {
            price: trigger.entryPrice,
            zoneType: "NESTED-" + trigger.type.toUpperCase(),
            lifecycleCandidateType: trigger.type,
            candidateId: trigger.id,
            zoneLow: trigger.low,
            zoneHigh: trigger.high,
            timeframe: trigger.timeframe,
            triggerKind: trigger.geometry,
          };
          console.log(
            "[nested-poi] " + pair + " armed " + trigger.type +
              " " + trigger.low + "-" + trigger.high +
              "; outer zone only arms",
          );
        }

        // ── Market Fill at Zone (Option C) ──────────────────────────────────
        // When izGateMode="hard" AND price IS at the zone (STRICT) AND marketFillAtZone
        // is enabled, skip the pending order path and fill at market price immediately.
        // Rationale: The hard gate validated (1) a valid impulse zone exists,
        // (2) price has arrived at the zone, (3) all 22 safety gates passed, (4) score
        // threshold met. The zone touch IS the confirmation — no CHoCH wait needed.
        // Pending orders (with CHoCH confirmation) are reserved for the "watching_zone"
        // path where price hasn't reached the zone yet.
        //
        // THREE layers of protection:
        //   Layer 1: priceAtZoneStrict (engine) — 0.3×ATR + correct side
        //   Layer 2: sideOk (engine) — directional awareness
        //   Layer 3: priceOnCorrectSide (below) — 2× zone width buffer fallback
        //
        // The strict flag from the engine is the PRIMARY gate. The old loose
        // priceAtZone (1.5×ATR) is kept for watchlist/awareness only.
        const strictZone = izData?.bestZone?.priceAtZoneStrict === true;
        const sideOk = izData?.bestZone?.sideOk === true;
        const priceIsAtValidatedZone = izGateMode === "hard" && strictZone && sideOk;
        // ── Directional Guard (Layer 3 — fallback safety net) ─────────────
        // Even if the engine's strict check passes, apply a hard buffer guard:
        //   LONG (demand zone): price must be ≤ zoneHigh + 2× zone width
        //   SHORT (supply zone): price must be ≥ zoneLow - 2× zone width
        // This catches edge cases where ATR is abnormally low.
        let priceOnCorrectSide = true;
        if (priceIsAtValidatedZone && izData?.bestZone) {
          const zoneHigh = izData.bestZone.high;
          const zoneLow = izData.bestZone.low;
          const zoneWidth = zoneHigh - zoneLow;
          const buffer = zoneWidth * 2;
          const currentPrice = analysis.lastPrice;
          if (analysis.direction === "long") {
            priceOnCorrectSide = currentPrice <= zoneHigh + buffer;
          } else {
            priceOnCorrectSide = currentPrice >= zoneLow - buffer;
          }
          if (!priceOnCorrectSide) {
            console.log(`[scan ${scanCycleId}] ⚠️ ${pair}: MARKET FILL BLOCKED (Layer 3) — price ${currentPrice.toFixed(5)} is beyond buffer of zone [${zoneLow.toFixed(5)}-${zoneHigh.toFixed(5)}] for ${analysis.direction}.`);
          }
        }
        // Log when loose flag is true but strict is false (would have been a bad fill before this fix)
        if (izGateMode === "hard" && izData?.bestZone?.priceAtZone && !strictZone) {
          console.log(`[scan ${scanCycleId}] ℹ️ ${pair}: priceAtZone(loose)=true but priceAtZoneStrict=false — routing to pending/CHoCH path. Distance: ${izData.bestZone.distancePips?.toFixed(1) ?? "?"}p, sideOk=${sideOk}`);
        }
        // Standalone trades MUST go through CHoCH confirmation — market fill only for unified/cascade
        const isStandaloneSignal = (detail as any).signalSource === "standalone";
        let useMarketFillAtZone = !effectiveNestedPoiActivation.enforced &&
          priceIsAtValidatedZone && config.marketFillAtZone &&
          priceOnCorrectSide && !isStandaloneSignal;
        // A user can enable Market Fill after a setup was pre-armed. Claim the
        // market route by conditionally cancelling that candidate's active
        // pending representation. If another scanner already moved it, market
        // entry is blocked instead of risking two entries for one candidate.
        if (useMarketFillAtZone && existingStaged?.candidate_id) {
          const { data: armedRows } = await supabase.from("pending_orders")
            .select("id,status")
            .eq("user_id", userId).eq("bot_id", BOT_ID)
            .eq("candidate_id", existingStaged.candidate_id)
            .in("status", ["pending", "awaiting_confirmation"]);
          if ((armedRows || []).length > 0) {
            const { data: claimedRows } = await supabase.from("pending_orders")
              .update({
                status: "cancelled",
                cancel_reason: "Candidate claimed by Market Fill route",
                resolved_at: new Date().toISOString(),
              })
              .eq("user_id", userId).eq("bot_id", BOT_ID)
              .eq("candidate_id", existingStaged.candidate_id)
              .in("status", ["pending", "awaiting_confirmation"])
              .select("id");
            if ((claimedRows || []).length !== armedRows!.length) {
              useMarketFillAtZone = false;
              detail.skipReason = "Market Fill blocked: linked pending setup changed during route claim";
            }
          }
        }
        if (isStandaloneSignal && priceIsAtValidatedZone && config.marketFillAtZone && priceOnCorrectSide) {
          console.log(`[scan ${scanCycleId}] ⏳ ${pair}: STANDALONE at zone — routing to CHoCH confirmation path (market fill reserved for unified/cascade).`);
        }

        // Pending Zone Orders is the sole authority for creating a limit order.
        // A hard impulse-zone gate must not silently override the visible Bot Config toggle.
        const effectiveLimitEnabled = shouldCreatePendingZoneOrder({
          pendingZoneOrdersEnabled:
            config.limitOrderEnabled || effectiveNestedPoiActivation.enforced,
          useMarketFillAtZone,
          hasLimitEntry: !!limitEntry,
        });
        if (effectiveLimitEnabled && limitEntry) {
          // ── Anti-Cycling Fix Part 2 (RELAXED): Log standalone signals but allow pending orders ──
          // Previously this blocked standalone signals with confirmation.type="none" from
          // placing pending orders. However, the ENTIRE PURPOSE of a pending order is to wait
          // for price to reach the zone and THEN hunt for confirmation (CHoCH/displacement/etc).
          // Blocking placement because no pre-existing confirmation exists defeats the purpose.
          // The confirmation requirement at FILL TIME (Branch B) is the real gate.
          const uzConfirmationType = unifiedZoneData?.confirmation?.type;
          if (isStandaloneSignal && uzConfirmationType === "none") {
            console.log(`[scan ${scanCycleId}] 📋 ${pair}: Standalone signal (confirmation.type=none) — placing pending order to await zone confirmation at fill time.`);
          }

          // ── Anti-Cycling Fix Part 1: Post-expiry cooldown ──
          // If the same symbol+direction had a pending order expire recently (within TTL),
          // don't re-place — the setup already failed once and conditions haven't changed enough.
          const cooldownMinutes = config.pendingOrderCooldownMinutes > 0
            ? config.pendingOrderCooldownMinutes
            : (config.limitOrderExpiryMinutes || 60);
          const cooldownCutoff = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();
          const { data: recentExpired } = await supabase.from("pending_orders")
            .select("order_id, resolved_at, entry_price")
            .eq("user_id", userId).eq("bot_id", BOT_ID)
            .eq("symbol", pair).eq("direction", analysis.direction)
            .eq("status", "expired")
            .gte("resolved_at", cooldownCutoff)
            .limit(1);
          if (recentExpired && recentExpired.length > 0) {
            detail.status = "skipped_expiry_cooldown";
            detail.skipReason = `Post-expiry cooldown: same setup expired at ${recentExpired[0].resolved_at} (within ${cooldownMinutes}min cooldown)`;
            console.log(`[scan ${scanCycleId}] ⏳ ${pair}: PENDING ORDER COOLDOWN — same ${analysis.direction} setup expired recently (${recentExpired[0].order_id} @ ${recentExpired[0].entry_price}). Waiting ${cooldownMinutes}min before re-placing.`);
            await finalizeDetailGoldenReplay({
              execution: {
                eligible: false,
                entryPrice: limitEntry.price,
                stopLoss: sl,
                takeProfit: computeTP(
                  limitEntry.price,
                  sl,
                  analysis.direction,
                ),
                positionSize: null,
                orderType: "limit",
              },
              lifecycle: {
                route: "limit",
                stage: "cooldown",
                outcome: "blocked",
                reason: detail.skipReason,
              },
            });
            scanDetails.push(detail);
            continue;
          }

          // Place a pending limit order instead of executing immediately
          const pendingOrderId = crypto.randomUUID().slice(0, 8);
          const expiryMinutes = config.limitOrderExpiryMinutes || 60;
          const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();

          const pendingPlanResult = buildPendingOrderPlan({
            direction: analysis.direction as "long" | "short",
            zone: limitEntry,
            stopLoss: sl,
            takeProfitFor: (entry, stop, direction) => computeTP(entry, stop, direction),
          });
          if (!pendingPlanResult.valid) {
            detail.status = "zone_setup_rejected_orientation";
            detail.skipReason = pendingPlanResult.reason;
            scanDetails.push(detail);
            continue;
          }
          const pendingPlan = pendingPlanResult.plan;
          const limitSL = pendingPlan.stopLoss;
          const limitTP = pendingPlan.takeProfit;
          const pendingOriginatingZone = {
            setupFamily: (detail as any).signalSource === "cascade"
              ? "cascade"
              : "impulse",
            candidateId: limitEntry.candidateId,
            sourceEvidenceIds: routedNestedPoiEntry?.selected
              ?.supportingEvidenceIds ||
              entryZoneEvidenceIdsFor(izData?.bestZone),
            sourceImpulseId:
              (detail as any).canonicalDealingRangeObservation?.canonical?.range
                ?.impulseId || null,
            type: limitEntry.lifecycleCandidateType,
            displayType: limitEntry.zoneType,
            low: limitEntry.zoneLow,
            high: limitEntry.zoneHigh,
            entry: limitEntry.price,
            timeframe: limitEntry.timeframe,
            lifecycle: routedNestedPoiEntry?.selected?.lifecycle ||
              entryZoneLifecycleFor(izData?.bestZone),
            triggerKind: limitEntry.triggerKind,
            stopLoss: limitSL,
            takeProfit: limitTP,
            refinedLow: izData?.bestZone?.ltfRefined
                ? Math.min(Number(izData.bestZone.refinedEntry), Number(izData.bestZone.refinedSL))
                : null,
            refinedHigh: izData?.bestZone?.ltfRefined
                ? Math.max(Number(izData.bestZone.refinedEntry), Number(izData.bestZone.refinedSL))
                : null,
            signalSource: (detail as any).signalSource || null,
          };
          const pendingFrozenCrossTimeframeContext =
            readFrozenSetupStrategyContext(existingStaged)?.crossTimeframeContext ||
            selectedCrossTimeframeContext(
              pendingOriginatingZone,
              effectiveNestedPoiActivation.enforced
                ? "nested_poi_market"
                : "confirmation",
            );
          const prospectiveLifecycleValidation =
            validateImpulseLifecycleExecutableZone({
              mode: effectiveNestedPoiActivation.enforced
                ? "enforce"
                : impulseLifecycleEnforcement.effectiveMode,
              context: pendingFrozenCrossTimeframeContext,
              executableZone: pendingOriginatingZone,
            });
          if (!prospectiveLifecycleValidation.valid) {
            detail.status = "zone_setup_rejected_lifecycle_identity";
            detail.skipReason = prospectiveLifecycleValidation.reason;
            scanDetails.push(detail);
            continue;
          }

          // Recalculate position size based on limit entry price (unified sizing)
          const limitSizingResult = computePositionSize(
            {
              balance,
              riskPercent: pairConfig.riskPerTrade,
              entryPrice: limitEntry.price,
              stopLoss: limitSL,
              symbol: pair,
              method: (pairConfig as any).positionSizingMethod || "percent_risk",
              fixedLotSize: (pairConfig as any).fixedLotSize,
              atrValue: (analysis as any).atrValue,
              atrVolatilityMultiplier: (pairConfig as any).atrVolatilityMultiplier,
              rateMap,
              commissionPerLot: avgCommissionPerLot,
            },
            undefined, // No portfolio context — Gates handle this
            volCtx,
            propFirmCtx,
          );
          const finalLimitSizing = applyFinalCandidateSizeAdjustments({
            sizingResult: limitSizingResult,
            signalSource: (detail as any).signalSource,
          });
          if (finalLimitSizing.rejected) {
            detail.status = "position_sizing_rejected";
            detail.skipReason = finalLimitSizing.rejectionReason ||
              "Pending-order sizing produced no executable size";
            console.warn(`[${pair}] ${detail.skipReason}`);
            scanDetails.push(detail);
            continue;
          }
          const limitSize = finalLimitSizing.lots;

          // Set when a material change replaces one lifecycle candidate with
          // another. An unchanged setup is not a handoff — #318 leaves it alone.
          let supersededCandidateId: string | null = null;
          let handoffReason: string | null = null;

          // ── Replace stale pending: expire any existing pending order for same symbol+direction ──
          // Market evolves — a new setup for the same symbol/direction is a different trade idea
          // with different entry zone, SL/TP, score. Expire the old one and insert fresh.
          const { data: stalePending } = await supabase.from("pending_orders")
            .select("order_id, entry_price, signal_score, stop_loss, take_profit, zone_touch_time, confirmation_attempts, candidate_id")
            .eq("user_id", userId).eq("bot_id", BOT_ID)
            .eq("symbol", pair).eq("direction", analysis.direction)
            .in("status", ["pending", "awaiting_confirmation"]);
          if (stalePending && stalePending.length > 0) {
            // Only replace when the setup actually moved. Re-detecting the same
            // setup each cycle used to cancel and reinsert it, which resets
            // zone_touch_time and confirmation_attempts — the state
            // zone-confirmation-scanner needs to anchor its CHoCH search. That
            // churn is why no pending order has filled since 2026-05-15.
            const existing = stalePending[0];
            const supersedeDecision = shouldSupersedePendingOrder({
              newEntry: Number(limitEntry.price),
              newStopLoss: Number(limitSL),
              newTakeProfit: Number(limitTP),
              newScore: analysis.score,
              existingEntry: Number(existing.entry_price),
              existingStopLoss: Number(existing.stop_loss),
              existingTakeProfit: Number(existing.take_profit),
              existingScore: existing.signal_score != null ? Number(existing.signal_score) : null,
              zoneWidth: Math.abs((limitEntry.zoneHigh ?? 0) - (limitEntry.zoneLow ?? 0)),
            });
            if (!supersedeDecision.supersede) {
              console.log(`[pending] ${pair} ${analysis.direction}: ${supersedeDecision.reason} (entry ${existing.entry_price}, touched=${existing.zone_touch_time ?? "no"}, attempts=${existing.confirmation_attempts ?? 0}) — leaving order in place.`);
              detail.status = "watching_zone";
              detail.skipReason = `Existing pending order retained — ${supersedeDecision.reason}. Cancelling it would reset zone-touch and confirmation progress.`;
              scanDetails.push(detail);
              continue;
            }
            // Material change: this is a NEW opportunity, not the old one edited.
            // Record the predecessor so the chain stays walkable — otherwise the
            // old candidate just vanishes and its successor looks unrelated.
            supersededCandidateId = existing.candidate_id ?? null;
            handoffReason = supersedeDecision.reason;
            const staleIds = stalePending.map((s: any) => s.order_id);
            await supabase.from("pending_orders").update({
              status: "cancelled",
              cancel_reason: `Superseded by new setup — ${supersedeDecision.reason} (score ${analysis.score.toFixed(1)} vs old ${existing.signal_score?.toFixed?.(1) ?? "?"}, entry ${limitEntry.price} vs old ${existing.entry_price})`,
            }).in("order_id", staleIds).eq("user_id", userId);
            console.log(`[pending] Expired ${stalePending.length} stale pending order(s) for ${pair} ${analysis.direction} — ${supersedeDecision.reason} (score ${analysis.score.toFixed(1)})`);
          }

          const pendingThesisAtCreation = validatePendingOrderThesis(
            {
              order_id: pendingOrderId,
              symbol: pair,
              direction: analysis.direction as "long" | "short",
              entry_price: limitEntry.price,
              signal_reason: {
                directionVerdict: (detail as any).directionVerdict || null,
              },
            },
            {
              fotsiResult: _fotsiResult,
              lastGamePlan: gamePlanEnabled ? activeGamePlan : null,
              dailyCandles: dailyCandles.length >= 20 ? dailyCandles : null,
              h4Candles: h4Candles.length >= 20 ? h4Candles : null,
              h1Candles: hourlyCandles.length >= 20
                ? hourlyCandles
                : null,
              decisionEvidence: pairDecisionEvidence,
            },
          );
          const pendingConfirmation: EntryConfirmationDecision = {
            required: false,
            passed: false,
            method: pairConfig.confirmationMethod || "choch",
            reason:
              "Zone setup is waiting; entry confirmation becomes mandatory at fill time",
            evidence: null,
            evaluatedAt: nowStr,
          };
          const pendingHierarchy = evaluateDecisionHierarchy({
            symbol: pair,
            direction: analysis.direction as "long" | "short",
            gamePlan: activeGamePlan,
            gamePlanEnabled,
            gamePlanMode: gpEnforcementMode,
            gamePlanMinimumConfidence:
              (pairConfig as any).gpHardBlockThreshold ?? 75,
            directionVerdict: activeDirectionVerdict,
            requireDirectionVerdict: true,
            thesisResult: pendingThesisAtCreation,
            requireThesisValidation: true,
            entryConfirmation: pendingConfirmation,
          });
          const pendingDecisionContext = buildTradeDecisionContext({
            stage: "pending",
            symbol: pair,
            direction: analysis.direction as "long" | "short",
            gamePlan: activeGamePlan,
            directionVerdict: activeDirectionVerdict,
            thesisResult: pendingThesisAtCreation,
            requireThesisValidation: true,
            thesisConviction: (detail as any).thesisConviction || null,
            entryConfirmation: pendingConfirmation,
            hierarchy: pendingHierarchy,
            stylePolicy: pairStylePolicy,
            evaluatedAt: nowStr,
          });
          const pendingLifecycleEvidence = buildPromotedLifecycleEvidence(
            pendingOriginatingZone,
            pendingHierarchy as unknown as Record<string, unknown>,
          );
          // A fresh UUID is the BIRTH of a lifecycle and is fine. Minting one
          // while a watchlist row exists forks the identity, and the halves can
          // never be reconciled — see docs/PENDING_ORDER_PREARMING_PLAN.md #3.
          //
          // A material change is the exception: inheriting there would give the
          // successor the SAME id as the candidate it replaced, making
          // superseded_candidate_id self-referential and the chain meaningless.
          // A changed setup is a new opportunity, so it gets a new identity.
          // Promotion COPIES the level the watchlist froze. Recomputing it from
          // this scan's bestZone would hand the same lifecycle candidate a
          // different boundary than it was staged under — the detected zone
          // drifts slightly between scans, so the numbers would quietly
          // disagree and the candidate would be judged against a level it was
          // never staged with. Direct creation derives it once, here, and that
          // value is persisted rather than recomputed later.
          const pendingStructuralInvalidation = freezeStructuralInvalidation(
            { stagedLevel: existingStaged?.sl_level != null ? Number(existingStaged.sl_level) : null },
            () =>
              watchlistInvalidationFor(
                analysis.direction as WatchlistDirection,
                (detail as any).impulseZone?.bestZone ?? existingStaged?.originating_zone,
                limitSL,
                existingStaged?.analysis_snapshot?.impulseZone?.impulse,
              ),
          );

          const pendingIdentity = supersededCandidateId
            ? { candidateId: crypto.randomUUID(), source: "handoff" as const, inherited: false }
            : resolveLifecycleCandidateId({
              inheritedCandidateId: pendingLifecycleEvidence?.candidateId,
              stagedCandidateId: existingStaged?.candidate_id,
              stagedRowId: existingStaged?.id,
            }, () => crypto.randomUUID());
          const pendingCandidateId = pendingIdentity.candidateId;
          if (supersededCandidateId) {
            // Carry the watchlist row onto the new identity. Leaving it on the
            // old one would fork staged from pending — the exact break #322
            // exists to prevent, reintroduced through the handoff path.
            if (existingStaged?.id) {
              try {
                await supabase.from("staged_setups")
                  .update({ candidate_id: pendingCandidateId })
                  .eq("id", existingStaged.id).eq("user_id", userId);
              } catch (e: any) {
                console.warn(`[handoff] ${pair}: could not move watchlist row to new candidate: ${e?.message}`);
              }
            }
            console.log(`[handoff] ${pair}: ${supersededCandidateId} → ${pendingCandidateId} (${handoffReason})`);
          }
          if (pendingIdentity.inherited) {
            console.log(`[pending] ${pair}: lifecycle identity inherited from ${pendingIdentity.source} (${pendingCandidateId})`);
          }
          const pendingFrozenStrategyContext =
            pendingLifecycleEvidence?.frozenStrategyContext ||
            buildFrozenSetupStrategyContext({
              identity: {
                setupId: pendingLifecycleEvidence?.setupId ||
                  crypto.randomUUID(),
                candidateId: pendingCandidateId,
              },
              timeframeEvidenceId:
                pendingLifecycleEvidence?.frozenStrategyContext
                  ?.timeframeEvidenceId ||
                (detail as any).timeframeEvidenceId ||
                null,
              symbol: pair,
              direction: analysis.direction as "long" | "short",
              stylePolicy: pairStylePolicy,
              runtimeConfig: pairRuntimeConfigSnapshot,
              decisionContext: pendingDecisionContext,
              gamePlan: activeGamePlan,
              directionVerdict: activeDirectionVerdict,
              conceptEvidence: selectedZoneConceptEvidence(),
              zoneLocalConfluence: selectedZoneLocalConfluence(),
              zoneCandidateShadowRanking: selectedZoneShadowRanking(),
              crossTimeframeContext: pendingFrozenCrossTimeframeContext,
              nestedPoiEntry: observedNestedPoiEntry,
              entryZone: {
                ...pendingOriginatingZone,
                structuralInvalidation:
                  pendingStructuralInvalidation?.level ?? null,
              },
              confirmationMethod:
                pairConfig.confirmationMethod || "choch",
              indicatorMinCount: pairConfig.indicatorMinCount || 3,
              liquiditySweepRole: pairConfig.requireLiquiditySweep ? "required" : "supporting",
              displacementRole: pairConfig.ictDisplacementMSSGateMode === "hard" ? "required" : "supporting",
              reversalPatternRole: "supporting",
              afterChochEntryMode: pairConfig.afterChochMode,
            });
          (detail as any).linkedSetupId =
            pendingFrozenStrategyContext.setupId;
          const pendingLifecycleValidation = validatePendingLifecycle(
            pendingFrozenStrategyContext,
            pendingOriginatingZone,
            effectiveNestedPoiLifecycleEnforced,
          );
          if (!pendingLifecycleValidation.valid) {
            detail.status = "zone_setup_rejected_lifecycle_identity";
            detail.skipReason = pendingLifecycleValidation.reason;
            await blockQualifiedSetup(
              pendingLifecycleEvidence,
              pendingLifecycleValidation.reason,
            );
            scanDetails.push(detail);
            continue;
          }
          if (pendingLifecycleEvidence) {
            try {
              await qualifyPromotedSetup(
                pendingLifecycleEvidence,
                `Qualified for ${pendingLifecycleEvidence.confirmationMethod} zone setup`,
              );
            } catch (lifecycleError: any) {
              detail.status = "zone_setup_lifecycle_claim_failed";
              detail.skipReason = lifecycleError?.message ||
                "Watchlist lifecycle qualification failed";
              scanDetails.push(detail);
              continue;
            }
          }
          if (!pendingHierarchy.passed) {
            detail.status = "zone_setup_blocked_decision_contract";
            detail.skipReason =
              `[decision-contract:${pendingHierarchy.code}] ${pendingHierarchy.reason}`;
            detail.decisionContext = pendingDecisionContext;
            await finalizeDetailGoldenReplay({
              execution: {
                eligible: false,
                entryPrice: limitEntry.price,
                stopLoss: limitSL,
                takeProfit: limitTP,
                positionSize: limitSize,
                orderType: "limit",
              },
              lifecycle: {
                route: "limit",
                stage: "authorization",
                outcome: "blocked",
                reason: detail.skipReason,
              },
              provenance: {
                candidateId: pendingCandidateId,
                orderId: pendingOrderId,
              },
            });
            await blockQualifiedSetup(
              pendingLifecycleEvidence,
              detail.skipReason,
            );
            scanDetails.push(detail);
            continue;
          }

          const pendingReplaySnapshot =
            await finalizeDetailGoldenReplay({
              execution: {
                eligible: true,
                entryPrice: limitEntry.price,
                stopLoss: limitSL,
                takeProfit: limitTP,
                riskReward: Math.abs(limitTP - limitEntry.price) /
                  Math.abs(limitEntry.price - limitSL),
                positionSize: limitSize,
                orderType: "limit",
              },
              lifecycle: {
                route: "limit",
                stage: "pending",
                outcome: "requested",
                reason: "Pending zone order passed creation checks",
              },
              provenance: {
                candidateId: pendingCandidateId,
                orderId: pendingOrderId,
              },
            });
          const placedAt = new Date().toISOString();
          const latestClosedEntryCandle =
            (fetchedByInterval.get(timeframeAuthority.runtimeEntry) || candles).at(-1) || null;
          const nestedOuterZoneTouchedAtCreation = !!(
            routedNestedPoiEntry &&
            latestClosedEntryCandle &&
            closedCandleTouchesNestedPoiOuterZone(
              latestClosedEntryCandle,
              routedNestedPoiEntry.outerZone,
            )
          );
          const nestedOuterZoneTouchTime = nestedOuterZoneTouchedAtCreation
            ? latestClosedEntryCandle!.datetime
            : null;
          // A staged setup froze its trigger before this candle existed, so the
          // touch bar is eligible for replay. A setup first discovered on this
          // bar must begin monitoring only after it was frozen.
          const nestedConfirmationCursor = existingStaged && nestedOuterZoneTouchTime
            ? nestedOuterZoneTouchTime
            : placedAt;
          const initialPendingStatus = nestedOuterZoneTouchedAtCreation
            ? "awaiting_confirmation"
            : "pending";
          const { error: pendingInsertErr } = await supabase.from("pending_orders").insert({
            user_id: userId,
            bot_id: BOT_ID,
            order_id: pendingOrderId,
            symbol: pair,
            direction: analysis.direction,
            order_type: "limit",
            entry_price: limitEntry.price,
            current_price: analysis.lastPrice,
            stop_loss: limitSL,
            take_profit: limitTP,
            size: limitSize,
            entry_zone_type: routedNestedPoiEntry
              ? "PARENT-" + String(izData?.bestZone?.type || "ZONE").toUpperCase()
              : limitEntry.zoneType,
            entry_zone_low: routedNestedPoiEntry?.outerZone.low ??
              limitEntry.zoneLow,
            entry_zone_high: routedNestedPoiEntry?.outerZone.high ??
              limitEntry.zoneHigh,
            refined_zone_low: routedNestedPoiEntry
              ? null
              : izData?.bestZone?.ltfRefined &&
                  izData.bestZone.refinedEntry != null &&
                  izData.bestZone.refinedSL != null
              ? Math.min(izData.bestZone.refinedEntry, izData.bestZone.refinedSL)
              : null,
            refined_zone_high: routedNestedPoiEntry
              ? null
              : izData?.bestZone?.ltfRefined &&
                  izData.bestZone.refinedEntry != null &&
                  izData.bestZone.refinedSL != null
              ? Math.max(izData.bestZone.refinedEntry, izData.bestZone.refinedSL)
              : null,
            status: initialPendingStatus,
            ...(nestedOuterZoneTouchedAtCreation
              ? {
                zone_touch_time: nestedOuterZoneTouchTime,
                last_touch_checked_at: placedAt,
                last_confirmation_checked_at: nestedConfirmationCursor,
                confirmation_attempts: 0,
              }
              : {}),
            expiry_minutes: expiryMinutes,
            expires_at: expiresAt,
              signal_reason: JSON.stringify({ bot: BOT_ID, candidateId: pendingCandidateId, summary: analysis.summary, setupType: setupClassification.setupType, setupConfidence: setupClassification.confidence, entryTimeframe: pairConfig.entryTimeframe, originalSL: limitSL, originalTP: limitTP, originatingZone: pendingOriginatingZone, exitFlags, factorScores: analysis.factors, tieredScoring: analysis.tieredScoring || null, regimeData: detail.regimeData || null, confluenceStacking: detail.confluenceStacking || null, sweepReclaim: detail.sweepReclaim || null, pullbackHealth: detail.pullbackHealth || null, structureIntel: detail.structureIntel || null, entityLifecycles: detail.analysis_snapshot?.entityLifecycles || null, gates: detail.gates || null, canonicalDealingRangeObservation: (detail as any).canonicalDealingRangeObservation || null, ...canonicalEvidenceSnapshot(detail), setupClassification: detail.setupClassification || null, fibLevels: detail.fibLevels || null, impulseZone: (detail as any).impulseZone || null, directionVerdict: (detail as any).directionVerdict || null, gamePlanSnapshot: activeGamePlan?.plans?.find((plan: any) => plan.symbol === pair) || null, gamePlanShadowAudit: (detail as any).gamePlanShadowAudit || null, streamlinedDecisionOrigin: (detail as any).streamlinedDecisionOrigin || null, streamlinedDecisionLatest: (detail as any).streamlinedDecisionLatest || null, singleOwnershipDecision: (detail as any).singleOwnershipDecision || null, singleOwnershipEnforcement: (detail as any).singleOwnershipEnforcement || null, legacyGateDiagnostics: (detail as any).legacyGateDiagnostics || [], signalSource: (detail as any).signalSource || null, unifiedZone: (detail as any).unifiedZone || null, thesisVersion: THESIS_VALIDATION_VERSION, confirmationMethod: pendingFrozenStrategyContext.confirmation.method, indicatorMinCount: pendingFrozenStrategyContext.confirmation.indicatorMinCount, nestedPoiEntry: observedNestedPoiEntry, tpMethod: pairConfig.tpMethod || "rr_ratio", decisionContext: pendingDecisionContext, frozenStrategyContext: pendingFrozenStrategyContext, goldenReplaySnapshot: pendingReplaySnapshot, ...(pendingLifecycleEvidence ? { watchlistLifecycle: pendingLifecycleEvidence } : {}), ...(isPromotedFromStaging && existingStaged ? { promotedFromWatchlist: true, watchlistOrigin: { initialScore: parseFloat(existingStaged.initial_score), cyclesWatched: existingStaged.scan_cycles + 1, stagedAt: existingStaged.staged_at } } : {}) }),
            signal_score: analysis.score,
            setup_type: setupClassification.setupType,
            setup_confidence: setupClassification.confidence,
            from_watchlist: isPromotedFromStaging || false,
            staged_setup_id: pendingLifecycleEvidence?.setupId || null,
            candidate_id: pendingCandidateId,
            // Pre-touch boundary: where the ZONE/IMPULSE breaks, not where a
            // position would stop out. Separate field on purpose — see
            // migration 20260812070000.
            structural_invalidation: pendingStructuralInvalidation?.level ?? null,
            structural_invalidation_source: pendingStructuralInvalidation?.source ?? null,
            superseded_candidate_id: supersededCandidateId,
            handoff_reason: handoffReason,
            originating_zone: pendingOriginatingZone,
            thesis_version: THESIS_VALIDATION_VERSION,
            confirmation_method: pendingLifecycleEvidence
              ?.confirmationMethod ||
              pairConfig.confirmationMethod ||
              "choch",
            confirmation_config: {
              indicatorMinCount:
                pendingFrozenStrategyContext.confirmation.indicatorMinCount,
              afterChochMode:
                pairConfig.afterChochMode || "confirmation_close",
              afterChochExpiryMinutes:
                pairConfig.afterChochExpiryMinutes || 30,
              maxConfirmationAttempts:
                pendingFrozenStrategyContext.confirmation.maxAttempts,
              entryMode: effectiveNestedPoiActivation.enforced
                ? "nested_poi_market"
                : "confirmation",
            },
            frozen_strategy_context: pendingFrozenStrategyContext,
            staged_cycles: isPromotedFromStaging && existingStaged ? existingStaged.scan_cycles + 1 : 0,
            staged_initial_score: isPromotedFromStaging && existingStaged ? parseFloat(existingStaged.initial_score) : null,
            exit_flags: exitFlags,
            placed_at: placedAt,
          });

          if (pendingInsertErr) {
            console.error(`[pending] INSERT failed for ${pair}: ${pendingInsertErr.message}`);
            detail.status = "zone_setup_insert_failed";
            detail.error = pendingInsertErr.message;
            detail.skipReason = /duplicate key/i.test(pendingInsertErr.message)
              ? "Zone setup already active (see Zone Setups panel)"
              : `Zone setup insert failed: ${pendingInsertErr.message}`;
            await finalizeDetailGoldenReplay({
              execution: pendingReplaySnapshot.decision.execution,
              lifecycle: {
                route: "limit",
                stage: "pending",
                outcome: "failed",
                reason: detail.skipReason,
              },
              provenance: {
                candidateId: pendingCandidateId,
                orderId: pendingOrderId,
              },
            });
            await blockQualifiedSetup(
              pendingLifecycleEvidence,
              detail.skipReason,
            );
            scanDetails.push(detail);
            continue;
          }

          pendingPlaced++;
          if (pendingLifecycleEvidence) {
            stagedPromoted++;
            stagedMap.delete(stagedKey!);
          }
          detail.status = isPromotedFromStaging ? "zone_setup_from_watchlist" : "zone_setup_active";
          detail.limitOrder = {
            orderId: pendingOrderId,
            entryPrice: limitEntry.price,
            zoneType: limitEntry.zoneType,
            zoneLow: limitEntry.zoneLow,
            zoneHigh: limitEntry.zoneHigh,
            expiresAt,
            currentPrice: analysis.lastPrice,
            distancePips: (Math.abs(analysis.lastPrice - limitEntry.price) / (SPECS[pair] || SPECS["EUR/USD"]).pipSize).toFixed(1),
          };
          detail.setupIdentity = {
            orderId: pendingOrderId,
            stagedSetupId: pendingLifecycleEvidence?.setupId || null,
            candidateId: pendingCandidateId,
            impulseEntryLifecycleId:
              existingStaged?.impulse_entry_lifecycle_id || null,
          };
          detail.decisionContext = pendingDecisionContext;
          if (isPromotedFromStaging && existingStaged) {
            detail.staging = {
              action: "pending_created",
              candidateId: pendingLifecycleEvidence?.candidateId,
              cycles: existingStaged.scan_cycles + 1,
              initialScore: parseFloat(existingStaged.initial_score),
            };
          }
          detail.size = limitSize;
          detail.entryPrice = limitEntry.price;
          detail.stopLoss = limitSL;
          detail.takeProfit = limitTP;
          await finalizeDetailGoldenReplay({
            execution: pendingReplaySnapshot.decision.execution,
            lifecycle: {
              route: "limit",
              stage: "pending",
              outcome: "created",
              reason: "Pending zone order was created",
            },
            provenance: {
              candidateId: pendingCandidateId,
              orderId: pendingOrderId,
            },
          });

          // Telegram notification for zone setup activation
          if (telegramChatIds.length > 0 && shouldNotify("zone_setup_active")) {
            const emoji = analysis.direction === "long" ? "🟢" : "🔴";
            const mode = account.execution_mode === "live" ? "LIVE" : "PAPER";
            // Confirmation method label for zone setup notification
            const zoneConfMethod = pairConfig.confirmationMethod || "choch";
            const zoneConfLabel = confirmationMethodLabel(zoneConfMethod, pairConfig.indicatorMinCount || 3);
            // TP method label
            const zoneTpMethod = pairConfig.tpMethod || "rr_ratio";
            const zoneTpLabel = zoneTpMethod === "rr_ratio" ? `R:R (${pairConfig.tpRatio || 2.0}:1)` : zoneTpMethod === "next_level" ? "Next Structure Level" : zoneTpMethod === "fixed_pips" ? "Fixed Pips" : `ATR \u00d7${pairConfig.tpATRMultiple || 2.0}`;
            const zoneSR = detail as any;
            const zoneRR = (() => {
              const risk = Math.abs(limitEntry.price - limitSL);
              return risk > 0 ? (Math.abs(limitTP - limitEntry.price) / risk).toFixed(2) : null;
            })();
            const msg = `${emoji} <b>${mode} Zone Setup ACTIVE</b>\n\n` +
              tgLine("Symbol", pair) +
              tgLine("Direction", analysis.direction.toUpperCase()) +
              tgLine("Zone Trigger", `${fmtPx(limitEntry.price, pair)} (${limitEntry.zoneType} zone)`) +
              tgLine("Zone Range", `${fmtPx(limitEntry.zoneLow, pair)} – ${fmtPx(limitEntry.zoneHigh, pair)}`) +
              tgLine("Current Price", fmtPx(analysis.lastPrice, pair)) +
              tgLine("Distance", `${(Math.abs(analysis.lastPrice - limitEntry.price) / (SPECS[pair] || SPECS["EUR/USD"]).pipSize).toFixed(1)} pips`) +
              tgLine("Size", `${limitSize} lots`) +
              tgLine("SL", fmtPx(limitSL, pair)) +
              tgLine("TP", `${fmtPx(limitTP, pair)} (${zoneTpLabel})`) +
              (zoneRR ? tgLine("Planned R:R", `${zoneRR}:1`) : "") +
              tgLine("Session", analysis.session?.name) +
              "\n" +
              tradeAuthorityLines(zoneSR) +
              zoneEvidenceLines(zoneSR) +
              directionVerdictLines((detail as any).directionVerdict) +
              styleLadderLines({}, timeframeAuthority?.roles) +
              crossTimeframeAuthorityLine(crossTimeframeAuthority) +
              "\n" +
              tgLine("Confirm Mode", zoneConfLabel) +
              tgLine("Confirmation", unifiedZoneData?.confirmation ? `${unifiedZoneData.confirmation.type.replace(/_/g, " ")}${unifiedZoneData.confirmation.entryReady ? " \u2713" : " (pending)"} — ${unifiedZoneData.confirmation.detail}` : "Waiting for confirmation at zone") +
              tgLine("Expires", expiryMinutes + "min") +
              diagnosticScoreLine(analysis.score) +
              (isPromotedFromStaging && existingStaged ? `

📋 <b>From Watchlist</b> (${existingStaged.scan_cycles + 1} cycles)` : "");
            await Promise.all(telegramChatIds.map(async (chatId: string) => {
              try {
                await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-notify`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                  body: JSON.stringify({ chat_id: chatId, message: msg }),
                });
              } catch (e: any) { console.warn(`Telegram notify failed [${chatId}]:`, e?.message); }
            }));
          }

          scanDetails.push(detail);
          continue; // Skip the market order path below
        }

        // Place position (market order)
        // Two scenarios reach here:
        if (finalSizing.rejected) {
          detail.status = "position_sizing_rejected";
          detail.skipReason = finalSizing.rejectionReason ||
            "Market-entry sizing produced no executable size";
          await finalizeDetailGoldenReplay({
            execution: {
              eligible: false,
              entryPrice: analysis.lastPrice,
              stopLoss: sl,
              takeProfit: tp,
              positionSize: 0,
              orderType: "market",
            },
            lifecycle: {
              route: "market",
              stage: "sizing",
              outcome: "blocked",
              reason: detail.skipReason,
            },
            provenance: { orderId, positionId },
          });
          console.warn(`[${pair}] ${detail.skipReason}`);
          scanDetails.push(detail);
          continue;
        }

        // 1. marketFillAtZone=true + price IS at validated impulse zone (primary path)
        // 2. Limit orders disabled and no zone entry found (legacy fallback)
        // Market orders ALWAYS fill at current price (analysis.lastPrice).
        const marketEntryPrice = analysis.lastPrice;
        if (useMarketFillAtZone) {
          console.log(`[scan ${scanCycleId}] 🎯 ${pair}: MARKET FILL AT ZONE — price ${marketEntryPrice.toFixed(5)} is at validated impulse zone [${izData?.bestZone?.low?.toFixed(5)}-${izData?.bestZone?.high?.toFixed(5)}]. No CHoCH wait.`);
        }
        // SL sanity guard: reject if current price is already past the SL
        // (e.g., for shorts: if price > SL, the trade is already a loser at entry)
        const slSanityFailed = analysis.direction === "long"
          ? marketEntryPrice <= sl  // For longs, entry below SL makes no sense
          : marketEntryPrice >= sl; // For shorts, entry above SL makes no sense
        if (slSanityFailed) {
          detail.status = "skipped_sl_sanity";
          detail.skipReason = `Market entry ${marketEntryPrice} already past SL ${sl} for ${analysis.direction} — trade would be instant loss`;
          console.log(`[scan ${scanCycleId}] ⛔ ${pair}: SL SANITY FAILED — entry ${marketEntryPrice} vs SL ${sl} (${analysis.direction}). Skipping.`);
          await finalizeDetailGoldenReplay({
            execution: {
              eligible: false,
              entryPrice: marketEntryPrice,
              stopLoss: sl,
              takeProfit: tp,
              positionSize: size,
              orderType: "market",
            },
            lifecycle: {
              route: "market",
              stage: "protection",
              outcome: "blocked",
              reason: detail.skipReason,
            },
            provenance: {
              orderId,
              positionId,
            },
          });
          scanDetails.push(detail);
          continue;
        }

        // Immediate market entries are execution events, not merely candidate
        // discovery. Rebuild every time-sensitive gate immediately before the
        // atomic database claim so this route cannot bypass the same authority
        // used by both confirmation scanners.
        const directAuthorizationPositions = pairConfig.closeOnReverse
          ? openPosArr.filter((position: any) =>
            !(
              position.symbol === pair &&
              position.direction !== analysis.direction
            )
          )
          : openPosArr;
        const directThesisResult = validatePendingOrderThesis(
          {
            order_id: `market:${scanCycleId}:${pair}`,
            symbol: pair,
            direction: analysis.direction as "long" | "short",
            entry_price: marketEntryPrice,
            signal_reason: {
              directionVerdict: (detail as any).directionVerdict || null,
            },
          },
          {
            fotsiResult: _fotsiResult,
            lastGamePlan: gamePlanEnabled ? activeGamePlan : null,
            dailyCandles: dailyCandles.length >= 20 ? dailyCandles : null,
            h4Candles: h4Candles.length >= 20 ? h4Candles : null,
            h1Candles: hourlyCandles.length >= 20 ? hourlyCandles : null,
            decisionEvidence: pairDecisionEvidence,
          },
        );
        const { data: directConnections } =
          account.execution_mode === "live"
            ? await supabase.from("broker_connections")
              .select("*")
              .eq("user_id", userId)
              .in("broker_type", ["metaapi", "oanda"])
              .eq("is_active", true)
            : { data: [] as any[] };
        const directSpreadResults: Array<{
          result: Awaited<ReturnType<typeof fetchBrokerSpread>>;
        }> = [];
        if (
          account.execution_mode === "live"
        ) {
          for (const connection of directConnections || []) {
            let metaAccountId: string | undefined;
            let authToken: string | undefined;
            if (connection.broker_type === "metaapi") {
              metaAccountId = connection.account_id;
              authToken = connection.api_key;
              if (
                metaAccountId?.startsWith("eyJ") &&
                authToken &&
                /^[0-9a-f-]{36}$/.test(authToken)
              ) {
                authToken = connection.account_id;
                metaAccountId = connection.api_key;
              }
            }
            directSpreadResults.push({
              result: await fetchBrokerSpread(
                connection,
                pair,
                pairConfig,
                metaAccountId,
                authToken,
              ),
            });
          }
        }
        const directAvailableSpreads = directSpreadResults.filter((item) =>
          !!item.result
        );
        const directPassingSpreads = directSpreadResults.filter((item) =>
          item.result?.passed
        );
        const directBestSpread = directAvailableSpreads
          .map((item) => item.result!)
          .sort((a, b) => a.spreadPips - b.spreadPips)[0];
        const directRuntimeGates = await buildFinalRuntimeGateStates({
          supabase,
          userId,
          accountExecutionMode: account.execution_mode,
          brokerExecutionConnectionCount: (directConnections || []).length,
          symbol: pair,
          direction: analysis.direction as "long" | "short",
          currentPrice: marketEntryPrice,
          candles,
          interval: entryInterval,
          openPositions: directAuthorizationPositions,
          accountBalance: account.balance,
          config: {
            portfolioHeat: pairConfig.portfolioHeat,
            riskPerTrade: pairConfig.riskPerTrade,
            correlationFilterEnabled: pairConfig.correlationFilterEnabled,
            maxCorrelation: pairConfig.maxCorrelation,
            maxCorrelatedPositions: pairConfig.maxCorrelatedPositions,
            cooldownMinutes: pairConfig.cooldownMinutes,
            newsFilterEnabled: pairConfig.newsFilterEnabled,
            newsFilterPauseMinutes: pairConfig.newsFilterPauseMinutes,
            enabledSessions: pairConfig.enabledSessions,
            enabledDays: pairConfig.enabledDays,
            killZoneOnly: pairConfig.killZoneOnly,
          },
          rateMap,
        });
        const directEntryConfirmation: EntryConfirmationDecision = {
          required: true,
          passed: candidateEntryConfirmationPassed || unifiedGatePassed,
          method: candidateConfirmationMethod,
          reason: candidateConfirmationSignal
            ? "Entry timing confirmed by " + candidateConfirmationSignal.type
            : unifiedGatePassed
            ? "Entry timing confirmed by the ICT Setup Model"
            : "Configured Entry Confirmation is not ready",
          evidence: {
            signalSource: (detail as any).signalSource || null,
            structural: candidateConfirmationSignal,
            indicators: candidateIndicatorConfirmation,
            unifiedConfirmation: unifiedZoneData?.confirmation || null,
            confirmationTimeframe: timeframeAuthority.roles.confirmation,
            sourceCandleTimestamp:
              roleCandles.confirmation[roleCandles.confirmation.length - 1]?.datetime || null,
          },
          evaluatedAt: nowStr,
        };
        const directCrossTimeframeContext =
          selectedCrossTimeframeContext();
        const directCanonicalDealingRange = evaluateCanonicalDealingRange({
          range: directCrossTimeframeContext.canonicalDealingRange.available
            ? directCrossTimeframeContext.canonicalDealingRange.range
            : null,
          direction: analysis.direction as "long" | "short",
          price: marketEntryPrice,
          mode: normalizeDealingRangeMode(
            (pairConfig as any).dealingRangeMode,
            {
              onlyBuyInDiscount: pairConfig.onlyBuyInDiscount,
              onlySellInPremium: pairConfig.onlySellInPremium,
            },
          ),
        });
        const rawDirectAuthorization = {
          ...evaluateFinalTradeAuthorization({
          account,
          candidate: {
            symbol: pair,
            direction: analysis.direction as "long" | "short",
            entryPrice: marketEntryPrice,
            stopLoss: Number(sl),
            takeProfit: Number(tp),
          },
          openPositions: directAuthorizationPositions,
          maxOpenPositions: pairConfig.maxOpenPositions,
          maxPerSymbol: pairConfig.maxPerSymbol,
          allowSameDirectionStacking:
            pairConfig.allowSameDirectionStacking,
          maxDailyLoss: pairConfig.maxDailyLoss,
          maxDrawdown: pairConfig.maxDrawdown,
          minimumRiskReward: pairConfig.minRiskReward,
          commissionPerLot: avgCommissionPerLot,
          rateMap,
          directionVerdict: activeDirectionVerdict,
          requireDirectionVerdict: true,
          gamePlan: activeGamePlan,
          gamePlanEnabled,
          gamePlanMode: gpEnforcementMode,
          gamePlanMinimumConfidence:
            (pairConfig as any).gpHardBlockThreshold ?? 75,
          thesisResult: directThesisResult,
          requireThesisValidation: true,
          entryConfirmation: directEntryConfirmation,
          propFirm: propFirmGateResult
            ? {
              enabled: propFirmGateResult.enabled,
              allowed: propFirmGateResult.allowed,
              reason: propFirmGateResult.reason,
            }
            : null,
          requirePropFirmResult: true,
          spread: {
            required:
              account.execution_mode === "live" &&
              pairConfig.spreadFilterEnabled,
            available:
              account.execution_mode !== "live" ||
              !pairConfig.spreadFilterEnabled ||
              directAvailableSpreads.length > 0,
            passed:
              account.execution_mode !== "live" ||
              !pairConfig.spreadFilterEnabled ||
              directPassingSpreads.length > 0,
            spreadPips: directBestSpread?.spreadPips,
            maximumPips: directBestSpread?.effectiveMax,
          },
          runtimeGates: directRuntimeGates,
          crossTimeframeAuthority: directCrossTimeframeContext.authority,
          requireCrossTimeframeAuthority: true,
        }),
          canonicalDealingRange: directCanonicalDealingRange,
        };
        const directHierarchy = rawDirectAuthorization.decisionHierarchy ||
          evaluateDecisionHierarchy({
            symbol: pair,
            direction: analysis.direction as "long" | "short",
            gamePlan: activeGamePlan,
            gamePlanEnabled,
            gamePlanMode: gpEnforcementMode,
            gamePlanMinimumConfidence:
              (pairConfig as any).gpHardBlockThreshold ?? 75,
            directionVerdict: activeDirectionVerdict,
            requireDirectionVerdict: true,
            thesisResult: directThesisResult,
            requireThesisValidation: true,
            entryConfirmation: directEntryConfirmation,
          });
        const directAuthorization = attachDecisionContext(
          rawDirectAuthorization,
          buildTradeDecisionContext({
            stage: "fill",
            symbol: pair,
            direction: analysis.direction as "long" | "short",
            gamePlan: activeGamePlan,
            directionVerdict: activeDirectionVerdict,
            thesisResult: directThesisResult,
            requireThesisValidation: true,
            thesisConviction: (detail as any).thesisConviction || null,
            entryConfirmation: directEntryConfirmation,
            hierarchy: directHierarchy,
            stylePolicy: pairStylePolicy,
            evaluatedAt: nowStr,
          }),
        );
        const directEntryZoneEvidence =
          (detail as any).signalSource === "cascade"
            ? cascadeResult?.entryZone
            : izData?.bestZone;
        const directOriginatingZone = {
          setupFamily: (detail as any).signalSource === "cascade"
            ? "cascade"
            : "impulse",
          candidateId: entryZoneCandidateIdFor(directEntryZoneEvidence),
          sourceEvidenceIds: entryZoneEvidenceIdsFor(
            directEntryZoneEvidence,
          ),
          sourceImpulseId:
            (detail as any).canonicalDealingRangeObservation?.canonical?.range
              ?.impulseId || null,
          type: izData?.bestZone?.type ||
            (detail as any).unifiedZone?.zoneType ||
            (detail as any).signalSource ||
            "market_signal",
          low: izData?.bestZone?.low ||
            (detail as any).unifiedZone?.zoneLow ||
            null,
          high: izData?.bestZone?.high ||
            (detail as any).unifiedZone?.zoneHigh ||
            null,
          entry: marketEntryPrice,
          timeframe: entryZoneTimeframeFor(directEntryZoneEvidence) ||
            (detail as any).unifiedZone?.selectedTF || null,
          lifecycle: entryZoneLifecycleFor(directEntryZoneEvidence),
          structuralInvalidation: null,
          stopLoss: sl,
          takeProfit: tp,
          signalSource: (detail as any).signalSource || null,
          marketFillAtZone: useMarketFillAtZone,
        };
        const directLifecycleEvidence = buildPromotedLifecycleEvidence(
          directOriginatingZone,
          directAuthorization as unknown as Record<string, unknown>,
        );
        const directCandidateId =
          directLifecycleEvidence?.candidateId || crypto.randomUUID();
        const directFrozenStrategyContext =
          directLifecycleEvidence?.frozenStrategyContext ||
          buildFrozenSetupStrategyContext({
            identity: {
              setupId: directLifecycleEvidence?.setupId ||
                crypto.randomUUID(),
              candidateId: directCandidateId,
            },
            timeframeEvidenceId:
              directLifecycleEvidence?.frozenStrategyContext
                ?.timeframeEvidenceId ||
              (detail as any).timeframeEvidenceId ||
              null,
            symbol: pair,
            direction: analysis.direction as "long" | "short",
            stylePolicy: pairStylePolicy,
            runtimeConfig: pairRuntimeConfigSnapshot,
            decisionContext: directAuthorization.decisionContext,
            gamePlan: activeGamePlan,
            directionVerdict: activeDirectionVerdict,
            conceptEvidence: selectedZoneConceptEvidence(),
            zoneLocalConfluence: selectedZoneLocalConfluence(),
            zoneCandidateShadowRanking: selectedZoneShadowRanking(),
            crossTimeframeContext: selectedCrossTimeframeContext(directOriginatingZone),
            entryZone: directOriginatingZone,
            confirmationMethod:
              pairConfig.confirmationMethod || "choch",
            indicatorMinCount: pairConfig.indicatorMinCount || 3,
          });
        (detail as any).linkedSetupId = directFrozenStrategyContext.setupId;
        if (directLifecycleEvidence) {
          try {
            await qualifyPromotedSetup(
              directLifecycleEvidence,
              "Qualified for immediate market-entry authorization",
            );
          } catch (lifecycleError: any) {
            detail.status = "market_entry_lifecycle_claim_failed";
            detail.skipReason = lifecycleError?.message ||
              "Watchlist lifecycle qualification failed";
            await finalizeDetailGoldenReplay({
              execution: {
                eligible: false,
                entryPrice: marketEntryPrice,
                stopLoss: sl,
                takeProfit: tp,
                positionSize: size,
                orderType: "market",
              },
              lifecycle: {
                route: "market",
                stage: "qualification",
                outcome: "failed",
                reason: detail.skipReason,
              },
              provenance: {
                candidateId: directCandidateId,
                orderId,
                positionId,
              },
            });
            scanDetails.push(detail);
            continue;
          }
        }
        if (!directAuthorization.authorized) {
          detail.status = "blocked_final_authorization";
          detail.skipReason =
            `[final-auth:${directAuthorization.code}] `
            + directAuthorization.reason;
          detail.finalAuthorization = directAuthorization;
          console.warn(
            `[market] ${pair} ${analysis.direction}: FINAL AUTH BLOCKED `
            + `${directAuthorization.code} — ${directAuthorization.reason}`,
          );
          await finalizeDetailGoldenReplay({
            execution: {
              eligible: false,
              entryPrice: marketEntryPrice,
              stopLoss: sl,
              takeProfit: tp,
              positionSize: size,
              orderType: "market",
            },
            lifecycle: {
              route: "market",
              stage: "authorization",
              outcome: "blocked",
              reason: detail.skipReason,
            },
            provenance: {
              candidateId: directCandidateId,
              orderId,
              positionId,
            },
          });
          await blockQualifiedSetup(
            directLifecycleEvidence,
            detail.skipReason,
          );
          scanDetails.push(detail);
          continue;
        }

        // Close on Reverse: close existing opposite-direction positions for this symbol.
        // MOVED here (from before the pending-order branch) so this only fires when the
        // new signal is actually about to open a live market position — never on signals
        // that get queued as pending limit orders which may never trigger.
        const closeOppositePositionsAfterEntry = async () => {
          if (!pairConfig.closeOnReverse) return;
          const oppositeDir = analysis.direction === "long" ? "short" : "long";
          const oppositePositions = openPosArr.filter((p: any) => p.symbol === pair && p.direction === oppositeDir && p.position_status === "open");
          const closedOppositeIds: string[] = [];
          for (const opp of oppositePositions) {
            const oppEntry = parseFloat(opp.entry_price);
            const oppSize = parseFloat(opp.size);
            const oppPnlResult = calcPnl(
              opp.direction,
              oppEntry,
              analysis.lastPrice,
              oppSize,
              opp.symbol,
              rateMap,
            );
            if (!oppPnlResult.valid) {
              console.error(
                `[close] ${opp.symbol}: refusing reverse settlement with invalid P&L (${oppPnlResult.reason})`,
              );
              continue;
            }
            const { pnl: oppPnl, pnlPips: oppPnlPips } = oppPnlResult;
            const oppMirroredIds: string[] = Array.isArray(opp.mirrored_connection_ids) ? opp.mirrored_connection_ids : [];

            const brokerClose = await reconcileFullBrokerClose({
              supabase,
              userId,
              botId: opp.bot_id || BOT_ID,
              position: opp,
              route: "reverse_signal",
              closeReason: "reverse_signal",
            });
            if (!brokerClose.readyToFinalize) {
              console.warn(
                `[close] reverse ${opp.position_id}: ${brokerClose.reason || brokerClose.state}; internal position remains open`,
              );
              continue;
            }

            const finalization = await finalizePaperPositionClose(supabase, {
              positionRowId: opp.id,
              userId,
              botId: opp.bot_id || BOT_ID,
              exitPrice: analysis.lastPrice,
              pnl: oppPnl,
              pnlPips: oppPnlPips,
              closeReason: "reverse_signal",
              closedAt: nowStr,
            });
            if (!finalization.closed) {
              console.log(`[close] reverse ${opp.position_id} skipped: ${finalization.code}`);
              continue;
            }
            closedOppositeIds.push(opp.position_id);
            if (finalization.balance !== undefined) account.balance = finalization.balance.toString();
            if (finalization.peak_balance !== undefined) account.peak_balance = finalization.peak_balance.toString();

            // Audit log entry for the reverse-signal close
            console.log("[close]", JSON.stringify({
              position_id: opp.position_id, symbol: pair, direction: opp.direction,
              broker_connection_ids: oppMirroredIds, pnl: oppPnl, exit_price: analysis.lastPrice,
              close_reason: "reverse_signal", close_source: "scanner", scan_cycle_id: scanCycleId,
            }));
            try {
              const auditRows = (oppMirroredIds.length > 0 ? oppMirroredIds : [null]).map((cid: string | null) => ({
                user_id: userId, position_id: opp.position_id, symbol: pair,
                broker_connection_id: cid, close_reason: "reverse_signal", close_source: "scanner",
                pnl: oppPnl.toFixed(2), exit_price: analysis.lastPrice.toString(),
                scan_cycle_id: scanCycleId,
                detail_json: { triggered_by_new_signal: positionId, new_direction: analysis.direction, opp_direction: opp.direction },
              }));
              await supabase.from("close_audit_log").insert(auditRows);
            } catch (e: any) {
              console.warn(`[close] audit insert failed for reverse ${opp.position_id}: ${e?.message}`);
            }

          }
          // Remove closed opposite positions from the in-memory array so subsequent
          // gate checks in this scan cycle don't over-count.
          const closedIds = new Set(closedOppositeIds);
          openPosArr = openPosArr.filter((p: any) => !closedIds.has(p.position_id));
        };
        // GUARD: reject trades whose SL/TP orientation doesn't match direction.
        // For long: SL must be below entry, TP above. For short: SL above, TP below.
        // This catches direction-vs-zone contradictions (e.g. LONG verdict with SHORT zone SL/TP)
        // before they get booked and later show up as "tp_hit" on a losing trade.
        {
          const entryRef = marketEntryPrice;
          const slNum = Number(sl);
          const tpNum = Number(tp);
          const orientationOk = analysis.direction === "long"
            ? (slNum < entryRef && tpNum > entryRef)
            : (slNum > entryRef && tpNum < entryRef);
          if (!orientationOk) {
            console.error(`[GUARD] ${pair} ${analysis.direction} REJECTED — SL/TP orientation mismatch. entry=${entryRef} sl=${slNum} tp=${tpNum}`);
            detail.status = "market_entry_rejected_orientation";
            detail.skipReason =
              `SL/TP orientation mismatch for ${analysis.direction} `
              + `(entry=${entryRef} sl=${slNum} tp=${tpNum})`;
            await finalizeDetailGoldenReplay({
              execution: {
                eligible: false,
                entryPrice: entryRef,
                stopLoss: slNum,
                takeProfit: tpNum,
                positionSize: size,
                orderType: "market",
              },
              lifecycle: {
                route: "market",
                stage: "protection",
                outcome: "blocked",
                reason: detail.skipReason,
              },
              provenance: {
                candidateId: directCandidateId,
                orderId,
                positionId,
              },
            });
            await blockQualifiedSetup(
              directLifecycleEvidence,
              detail.skipReason,
            );
            scanDetails.push(detail);
            continue;
          }
        }
        // Preserve the exact Game Plan that authorized this entry. This snapshot is
        // immutable trade evidence; closed-trade analysis must not use a later plan.
        const entryGamePlan = activeGamePlan?.plans?.find((plan: InstrumentGamePlan) => plan.symbol === pair) || null;
        const entryGamePlanGate = Array.isArray(detail.gates)
          ? detail.gates.find((gate: any) =>
            typeof gate?.reason === "string"
            && (gate.reason.startsWith("GP filter") || gate.reason.startsWith("GP alignment"))
          )
          : null;
        const gamePlanSnapshot = entryGamePlan ? {
          session: activeGamePlan?.session,
          generatedAt: activeGamePlan?.generatedAt,
          expiresAt: entryGamePlan.expiresAt || null,
          symbol: entryGamePlan.symbol,
          bias: entryGamePlan.bias,
          legacyConfidence: entryGamePlan.biasConfidence,
          state: entryGamePlan.state || (entryGamePlan.tradeable ? "tradeable" : "skip"),
          stateReason: entryGamePlan.stateReason || entryGamePlan.skipReason || null,
          conviction: entryGamePlan.conviction || null,
          evidence: entryGamePlan.evidence || [],
          supportingEvidence: entryGamePlan.supportingEvidence || [],
          conflictingEvidence: entryGamePlan.conflictingEvidence || [],
          dol: entryGamePlan.dol,
          zone: entryGamePlan.zone,
          regime: entryGamePlan.regime,
          htfTrend: entryGamePlan.htfTrend,
          h4Trend: entryGamePlan.h4Trend,
          scenarios: entryGamePlan.scenarios || [],
          candidateDirection: analysis.direction,
          enforcementMode: gpEnforcementMode,
          hardBlockThreshold: (config as any).gpHardBlockThreshold ?? 75,
          gateDecision: entryGamePlanGate || null,
          shadowAudit: (detail as any).gamePlanShadowAudit || null,
          capturedAt: nowStr,
        } : null;
        const authorizedMarketReplaySnapshot =
          await finalizeDetailGoldenReplay({
            execution: {
              eligible: true,
              entryPrice: marketEntryPrice,
              stopLoss: sl,
              takeProfit: tp,
              riskReward: Math.abs(tp - marketEntryPrice) /
                Math.abs(marketEntryPrice - sl),
              positionSize: size,
              orderType: "market",
            },
            lifecycle: {
              route: "market",
              stage: "authorization",
              outcome: "authorized",
              reason: "Final market-entry authorization passed",
            },
            provenance: {
              candidateId: directCandidateId,
              orderId,
              positionId,
            },
          });
        const directSignalReason = {
          bot: BOT_ID,
          candidateId: directCandidateId,
          summary: analysis.summary,
          setupType: setupClassification.setupType,
          setupConfidence: setupClassification.confidence,
          setupRationale: setupClassification.rationale,
          entryTimeframe: pairConfig.entryTimeframe,
          originalSL: sl,
          originalTP: tp,
          exitFlags,
          spreadFilter: {
            enabled: pairConfig.spreadFilterEnabled,
            maxPips: pairConfig.maxSpreadPips,
          },
          newsFilter: {
            enabled: pairConfig.newsFilterEnabled,
            pauseMinutes: pairConfig.newsFilterPauseMinutes,
          },
          fotsi: analysis.fotsiAlignment
            ? {
              base: analysis.fotsiAlignment.baseTSI,
              quote: analysis.fotsiAlignment.quoteTSI,
              spread: analysis.fotsiAlignment.spread,
              score: analysis.fotsiAlignment.score,
              label: analysis.fotsiAlignment.label,
            }
            : null,
          factorScores: analysis.factors,
          tieredScoring: analysis.tieredScoring || null,
          regimeData: detail.regimeData || null,
          confluenceStacking: detail.confluenceStacking || null,
          sweepReclaim: detail.sweepReclaim || null,
          pullbackHealth: detail.pullbackHealth || null,
          structureIntel: detail.structureIntel || null,
          entityLifecycles:
            detail.analysis_snapshot?.entityLifecycles || null,
          gates: detail.gates || null,
          setupClassification: detail.setupClassification || null,
          fibLevels: detail.fibLevels || null,
          impulseZone: (detail as any).impulseZone || null,
          directionVerdict: (detail as any).directionVerdict || null,
          gamePlanShadowAudit:
            (detail as any).gamePlanShadowAudit || null, streamlinedDecisionOrigin: (detail as any).streamlinedDecisionOrigin || null, streamlinedDecisionLatest: (detail as any).streamlinedDecisionLatest || null, singleOwnershipDecision: (detail as any).singleOwnershipDecision || null, singleOwnershipEnforcement: (detail as any).singleOwnershipEnforcement || null, legacyGateDiagnostics: (detail as any).legacyGateDiagnostics || [],
          signalSource: (detail as any).signalSource || null,
          timeframeEvidenceId: (detail as any).timeframeEvidenceId || null,
          unifiedZone: (detail as any).unifiedZone || null,
          originatingZone: directOriginatingZone,
          gamePlanSnapshot,
          finalAuthorization: directAuthorization,
          canonicalDealingRangeObservation:
            (detail as any).canonicalDealingRangeObservation || null,
              ...canonicalEvidenceSnapshot(detail),
          decisionContext: directAuthorization.decisionContext,
          frozenStrategyContext: directFrozenStrategyContext,
          goldenReplaySnapshot: authorizedMarketReplaySnapshot,
          confirmationMethod:
            directFrozenStrategyContext.confirmation.method,
          indicatorMinCount:
            directFrozenStrategyContext.confirmation.indicatorMinCount,
          thesisVersion: THESIS_VALIDATION_VERSION,
          ...(directLifecycleEvidence
            ? { watchlistLifecycle: directLifecycleEvidence }
            : {}),
          tpMethod: pairConfig.tpMethod || "rr_ratio",
          ...(isPromotedFromStaging && existingStaged
            ? {
              promotedFromWatchlist: true,
              watchlistOrigin: {
                initialScore: parseFloat(existingStaged.initial_score),
                cyclesWatched: existingStaged.scan_cycles + 1,
                stagedAt: existingStaged.staged_at,
                promotionReason: singleOwnershipEnforcementRequested
                  ? "Trade Decision authorized Watchlist promotion"
                  : `Score reached ${analysis.score.toFixed(1)}% `
                    + `(gate: ${adjustedMinConfluence}%) after `
                    + `${existingStaged.scan_cycles + 1} cycles`,
              },
            }
            : {}),
        };
        const sourceCandleTime =
          candles[candles.length - 1]?.datetime || nowStr;
        const directCandidateKey = [
          "direct",
          pair,
          analysis.direction,
          sourceCandleTime,
          (detail as any).signalSource || "unknown",
        ].join(":");
        const { data: directFill, error: directFillError } =
          await supabase.rpc("finalize_market_entry", {
            p_user_id: userId,
            p_bot_id: BOT_ID,
            p_source_candidate_key: directCandidateKey,
            p_position: {
              position_id: positionId,
              symbol: pair,
              direction: analysis.direction,
              size: size.toString(),
              entry_price: marketEntryPrice.toString(),
              current_price: analysis.lastPrice.toString(),
              stop_loss: sl.toString(),
              take_profit: tp.toString(),
              open_time: nowStr,
              signal_reason: directSignalReason,
              signal_score: analysis.score.toString(),
              order_id: orderId,
            },
            p_authorization: directAuthorization,
            p_max_open_positions: pairConfig.maxOpenPositions,
            p_max_per_symbol: pairConfig.maxPerSymbol,
            p_allow_same_direction:
              pairConfig.allowSameDirectionStacking,
            p_close_on_reverse: pairConfig.closeOnReverse,
          });
        if (directFillError || !directFill?.filled) {
          detail.status = "market_entry_claim_failed";
          detail.skipReason = directFillError?.message ||
            directFill?.reason ||
            "Atomic market entry was not claimed";
          console.warn(
            `[market] ${pair} ${analysis.direction}: atomic entry rejected — `
            + `${directFillError?.message || directFill?.code || "unknown"}`,
          );
          await finalizeDetailGoldenReplay({
            execution: authorizedMarketReplaySnapshot.decision.execution,
            lifecycle: {
              route: "market",
              stage: "position",
              outcome: "failed",
              reason: detail.skipReason,
            },
            provenance: {
              candidateId: directCandidateId,
              orderId,
              positionId,
            },
          });
          await blockQualifiedSetup(
            directLifecycleEvidence,
            detail.skipReason,
          );
          scanDetails.push(detail);
          continue;
        }

        await finalizeDetailGoldenReplay({
          execution: authorizedMarketReplaySnapshot.decision.execution,
          lifecycle: {
            route: "market",
            stage: "position",
            outcome: "opened",
            reason: "Atomic market-entry claim succeeded",
          },
          provenance: {
            candidateId: directCandidateId,
            orderId,
            positionId,
          },
        });
        if (directLifecycleEvidence) {
          stagedPromoted++;
          stagedMap.delete(stagedKey!);
        }

        // Only the scanner that won the atomic market-entry claim may replace
        // the opposite position, notify, or send an order to a broker.
        if (account.execution_mode !== "live") {
          await closeOppositePositionsAfterEntry();
        }

        // Store trade reasoning
        await supabase.from("trade_reasonings").insert({
          user_id: userId,
          position_id: positionId,
          symbol: pair,
          direction: analysis.direction,
          confluence_score: Math.round(analysis.score),
          summary: `${isPromotedFromStaging ? "[WATCHLIST] " : ""}[${setupClassification.setupType.toUpperCase()}] ${analysis.summary}`,
          bias: analysis.bias,
          session: analysis.session.name,
          timeframe: pairConfig.entryTimeframe,
          factors_json: analysis.factors,
        });

        tradesPlaced++;
        detail.status = isPromotedFromStaging ? "trade_placed_from_watchlist" : (useMarketFillAtZone ? "trade_placed_at_zone" : "trade_placed");
        if (useMarketFillAtZone) {
          detail.entryMethod = "market_fill_at_zone";
          detail.zoneConfirmation = "configured_entry_confirmation";
          detail.impulseZoneEntry = { zoneLow: izData?.bestZone?.low, zoneHigh: izData?.bestZone?.high, zoneType: izData?.bestZone?.type, refinedEntry: izData?.bestZone?.refinedEntry };
        }
        if (isPromotedFromStaging && existingStaged) {
          detail.staging = { action: "promoted_and_traded", cycles: existingStaged.scan_cycles + 1, initialScore: parseFloat(existingStaged.initial_score) };
        }
        detail.size = size;
        detail.entryPrice = marketEntryPrice;
        detail.stopLoss = sl;
        detail.takeProfit = tp;
        detail.positionId = positionId;
                detail.exitFlags = exitFlags;
        // Send Telegram notification to all configured chat IDs
        if (telegramChatIds.length > 0 && shouldNotify("trade_opened")) {
          const emoji = analysis.direction === "long" ? "🟢" : "🔴";
          const mode = account.execution_mode === "live" ? "LIVE ORDER SUBMITTED" : "PAPER";
          // TP method label for notification
          const openTpMethod = pairConfig.tpMethod || "rr_ratio";
          const openTpLabel = openTpMethod === "rr_ratio" ? `R:R (${pairConfig.tpRatio || 2.0}:1)` : openTpMethod === "next_level" ? "Next Structure Level" : openTpMethod === "fixed_pips" ? "Fixed Pips" : `ATR ×${pairConfig.tpATRMultiple || 2.0}`;
          const openRR = (() => {
            const risk = Math.abs(marketEntryPrice - sl);
            return risk > 0 ? (Math.abs(tp - marketEntryPrice) / risk).toFixed(2) : null;
          })();
          const openSR = detail as any;
          const msg = `${emoji} <b>${mode} Trade Opened</b>\n\n` +
            tgLine("Symbol", pair) +
            tgLine("Direction", analysis.direction.toUpperCase()) +
            tgLine("Size", `${size} lots`) +
            tgLine("Entry", fmtPx(marketEntryPrice, pair)) +
            tgLine("SL", fmtPx(sl, pair)) +
            tgLine("TP", `${fmtPx(tp, pair)} (${openTpLabel})`) +
            (openRR ? tgLine("Planned R:R", `${openRR}:1`) : "") +
            tgLine("Session", analysis.session.name) +
            tgLine("Setup", setupClassification.setupType.toUpperCase()) +
            "\n" +
            tradeAuthorityLines(openSR) +
            zoneEvidenceLines(openSR) +
            directionVerdictLines((detail as any).directionVerdict) +
            styleLadderLines({}, timeframeAuthority?.roles) +
            crossTimeframeAuthorityLine(crossTimeframeAuthority) +
            "\n" +
            tgLine("Summary", analysis.summary || "—") +
            diagnosticScoreLine(analysis.score) +
            (isPromotedFromStaging && existingStaged ? `\n\n📋 <b>Promoted from Watchlist</b>\nWatched ${existingStaged.scan_cycles + 1} cycles | Started at ${parseFloat(existingStaged.initial_score).toFixed(1)}%` : "") +
            (useMarketFillAtZone ? `\n\n🎯 <b>Market Fill at Zone</b>\n<b>Zone:</b> ${izData?.bestZone?.type || "IZ"} [${izData?.bestZone?.low?.toFixed(5)} \u2013 ${izData?.bestZone?.high?.toFixed(5)}]${izData?.bestZone?.priceInsideZone ? " (inside)" : ` (${izData?.bestZone?.distancePips?.toFixed(1) ?? "?"}p from edge)`}${izData?.bestZone?.refinedEntry ? `\n<b>Refined Entry:</b> ${izData.bestZone.refinedEntry.toFixed(5)}` : ""}` : "") +
            (unifiedZoneData?.confirmation
              ? "\n\n🎯 <b>Entry Confirmation</b>\n<b>Type:</b> " + unifiedZoneData.confirmation.type.replace(/_/g, " ") + (unifiedZoneData.confirmation.entryReady ? " ✓" : "") + "\n<b>Detail:</b> " + unifiedZoneData.confirmation.detail
              : "");
          await Promise.all(telegramChatIds.map(async (chatId) => {
            try {
              const notifyResp = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-notify`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                body: JSON.stringify({ chat_id: chatId, message: msg }),
              });
              const notifyBody = await notifyResp.text();
              if (!notifyResp.ok) console.warn(`Telegram notify HTTP error [${chatId}]:`, notifyResp.status, notifyBody);
              else console.log(`Telegram notify sent OK [${chatId}]`);
            } catch (e: any) {
              console.warn(`Telegram notify failed [${chatId}]:`, e?.message);
            }
          }));
        }

        // Mirror to brokers only when the account is explicitly in live mode
        console.log(`Mirror check for ${pair}: execution_mode=${account.execution_mode}, positionId=${positionId}`);
        try {
          if (account.execution_mode === "live") {
            const connections = directConnections || [];
            if (connections.length > 0) {
              const mirrorResults: string[] = [];
              const mirroredConnIds: string[] = []; // Track which connections actually opened the trade — used at close time
              let brokerFillPrice: number | null = null; // Actual fill price from first successful broker execution
              for (const conn of connections) {
                try {
                  // ── Circuit Breaker: skip connections that have failed repeatedly ──
                  const connHealth = brokerHealthMap[conn.id] || createInitialHealth(conn.id);
                  if (!isConnectionAvailable(connHealth)) {
                    mirrorResults.push(`${conn.display_name}: skipped (circuit-breaker open until ${connHealth.cooldownUntil})`);
                    continue;
                  }
                  if (conn.broker_type !== "metaapi") {
                    // ── Unified spread check for OANDA ──
                    const oandaSpread = await fetchBrokerSpread(conn, pair, pairConfig);
                    if (oandaSpread && !oandaSpread.passed) {
                      mirrorResults.push(`${conn.display_name}: skipped (spread ${oandaSpread.spreadPips.toFixed(1)} > ${oandaSpread.effectiveMax} max)`);
                      continue;
                    }
                    // Adjust SL/TP for spread (was missing for OANDA — broker-execute doesn't do it)
                    let oandaSL = sl;
                    let oandaTP = tp;
                    if (oandaSpread) {
                      const adj = adjustSLTPForSpread(sl, tp, analysis.direction, oandaSpread.halfSpreadPrice);
                      oandaSL = adj.brokerSL;
                      oandaTP = adj.brokerTP;
                      console.log(`OANDA SL/TP adjusted for spread [${conn.display_name}]: SL ${sl} → ${oandaSL}, TP ${tp} → ${oandaTP}`);
                    }
                    // Non-MetaAPI brokers (e.g. OANDA) are mirrored via the
                    // broker-execute function after a durable execution claim.
                    const ledgerExecution = await executeBrokerOrderWithLedger(
                      supabase,
                      {
                        userId,
                        botId: BOT_ID,
                        positionId,
                        brokerConnectionId: conn.id,
                        route: "direct_market",
                        requestPayload: {
                          symbol: pair,
                          direction: analysis.direction,
                          size,
                          stopLoss: oandaSL,
                          takeProfit: oandaTP,
                        },
                      },
                      async () => {
                        const exRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/broker-execute`, {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                          },
                          body: JSON.stringify({
                            action: "place_order",
                            connectionId: conn.id,
                            symbol: pair,
                            direction: analysis.direction,
                            size,
                            stopLoss: oandaSL,
                            takeProfit: oandaTP,
                            positionId,
                            userId,
                          }),
                        });
                        const rawBody = await exRes.text();
                        let parsedBody: any = null;
                        try { parsedBody = rawBody ? JSON.parse(rawBody) : null; } catch {}
                        return {
                          ok: exRes.ok,
                          httpStatus: exRes.status,
                          parsedBody,
                          rawBody,
                        };
                      },
                    );
                    const exBody = ledgerExecution.rawBody || "";
                    const parsedEx = ledgerExecution.parsedBody;
                    if (ledgerExecution.status === "succeeded") {
                      console.log(`Broker mirror [${conn.display_name}] (${conn.broker_type}): SUCCESS — ${exBody.slice(0, 300)}`);
                      mirrorResults.push(`${conn.display_name}: success`);
                      mirroredConnIds.push(conn.id);
                      // Circuit breaker: record success
                      brokerHealthMap[conn.id] = updateHealth(connHealth, { connectionId: conn.id, success: true, latencyMs: 0, isTransient: false });
                      // Auto-detect commission from OANDA fill response
                      try {
                        const fillTx = parsedEx?.orderFillTransaction || parsedEx?.data?.orderFillTransaction;
                        if (fillTx && fillTx.commission !== undefined) {
                          const fillComm = Math.abs(parseFloat(fillTx.commission || "0"));
                          const fillUnits = Math.abs(parseFloat(fillTx.units || fillTx.tradeOpened?.units || "0"));
                          if (fillUnits > 0 && fillComm > 0) {
                            const spec = SPECS[pair] || SPECS["EUR/USD"];
                            const commPerLot = fillComm / (fillUnits / spec.lotUnits); // per-side
                            console.log(`[commission auto-detect] OANDA [${conn.display_name}]: $${commPerLot.toFixed(3)}/lot/side from fill (comm=$${fillComm}, units=${fillUnits})`);
                            await supabase.from("broker_connections")
                              .update({ detected_commission_per_lot: commPerLot })
                              .eq("id", conn.id);
                          }
                        }
                        // Extract actual broker fill price from OANDA response
                        if (!brokerFillPrice && fillTx) {
                          const oandaFillPrice = parseFloat(fillTx.price || fillTx.tradeOpened?.price || "0");
                          if (oandaFillPrice > 0) {
                            brokerFillPrice = oandaFillPrice;
                            console.log(`[broker-fill-price] OANDA [${conn.display_name}]: fill price ${oandaFillPrice}`);
                          }
                        }
                      } catch (commErr: any) {
                        console.warn(`Commission auto-detect failed [${conn.display_name}]: ${commErr?.message}`);
                      }
                    } else {
                      const reason = ledgerExecution.error
                        || parsedEx?.error
                        || exBody.slice(0, 200)
                        || "reconciliation required";
                      console.warn(
                        `Broker mirror [${conn.display_name}] (${conn.broker_type})`
                        + ` ${ledgerExecution.status}: ${reason}`,
                      );
                      mirrorResults.push(`${conn.display_name}: ${ledgerExecution.status} — ${reason}`);
                      // Circuit breaker: record failure (transient if HTTP error, permanent if auth)
                      const isTransient = ledgerExecution.status === "uncertain";
                      brokerHealthMap[conn.id] = updateHealth(connHealth, { connectionId: conn.id, success: false, latencyMs: 0, error: reason, isTransient });
                    }
                    continue;
                  }
                  let authToken = conn.api_key;
                  let metaAccountId = conn.account_id;
                  if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
                    authToken = conn.account_id;
                    metaAccountId = conn.api_key;
                  }
                  // Use region-failover metaFetch instead of hardcoded London URL
                   const brokerSymbol = resolveSymbol(pair, conn);

                   // ── Fetch per-broker account balance and recalc lot size ──
                   let brokerVolume = size;
                     try {
                       if (balanceCache[conn.id] === undefined) {
                         const { res: balRes, body: balBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/account-information`);
                         if (balRes.ok) {
                           const balData: any = JSON.parse(balBody);
                           balanceCache[conn.id] = parseFloat(balData.balance ?? balData.equity ?? "0");
                         } else {
                           const notConnected = /not connected to broker|region/i.test(balBody);
                           const reason = notConnected
                             ? "MetaAPI account not deployed/connected to broker"
                             : `balance fetch ${balRes.status}`;
                           console.warn(`Broker balance fetch failed [${conn.display_name}] ${balRes.status} — ${reason}`);
                           mirrorResults.push(`${conn.display_name}: skipped — ${reason}`);
                           continue;
                         }
                       }
                     const brokerBalance = balanceCache[conn.id];
                     if (!brokerBalance || brokerBalance <= 0) {
                       console.warn(`Broker [${conn.display_name}] balance is 0 — skipping mirror`);
                       mirrorResults.push(`${conn.display_name}: skipped (zero balance)`);
                       continue;
                     }
                     const cappedRisk = Math.min(pairConfig.riskPerTrade, MAX_BROKER_RISK_PERCENT);
                     // Resolve the connection's explicit auto/manual/none commission mode.
                     const connCommRT = resolveRoundTripCommission(conn).roundTripPerLot;
                     // Unified sizing for broker mirror (volatility scaling applies)
                     const brokerSizingResult = computePositionSize(
                       {
                         balance: brokerBalance,
                         riskPercent: cappedRisk,
                         entryPrice: analysis.lastPrice,
                         stopLoss: sl,
                         symbol: pair,
                         method: (pairConfig as any).positionSizingMethod || "percent_risk",
                         fixedLotSize: (pairConfig as any).fixedLotSize,
                         atrValue: (analysis as any).atrValue,
                         atrVolatilityMultiplier: (pairConfig as any).atrVolatilityMultiplier,
                         rateMap,
                         commissionPerLot: connCommRT,
                       },
                       undefined, // No portfolio context for broker
                       volCtx,
                       undefined, // No prop firm context for broker (broker has own limits)
                     );
                     if (brokerSizingResult.rejected || brokerSizingResult.lots <= 0) {
                       const reason = brokerSizingResult.rejectionReason || "no executable broker size";
                       console.warn(`Broker sizing rejected [${conn.display_name}]: ${reason}`);
                       mirrorResults.push(
                         `${conn.display_name}: skipped (sizing rejected: ${reason})`,
                       );
                       continue;
                     }
                     brokerVolume = brokerSizingResult.lots;
                     console.log(`[${conn.display_name} $${brokerBalance.toFixed(2)}] risk=${cappedRisk}% → size=${brokerVolume} (paper size was ${size})${brokerSizingResult.adjustments.length > 0 ? ` [${brokerSizingResult.adjustments.map(a => a.type).join(",")}]` : ""}`);
                   } catch (balErr: any) {
                     console.warn(`Broker balance error [${conn.display_name}]: ${balErr?.message} — skipping mirror`);
                     mirrorResults.push(`${conn.display_name}: skipped (balance error)`);
                     continue;
                   }

                   // ── Fetch live symbol specs from broker to clamp lot size ──
                   const specCacheKey = `${conn.id}:${brokerSymbol}`;
                   if (!specCache[specCacheKey]) {
                     try {
                       const { res: specRes, body: specBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/symbols/${encodeURIComponent(brokerSymbol)}/specification`);
                       if (specRes.ok) {
                         const specData: any = JSON.parse(specBody);
                         specCache[specCacheKey] = {
                           minVolume: specData.minVolume ?? 0.01,
                           maxVolume: specData.maxVolume ?? 100,
                           volumeStep: specData.volumeStep ?? 0.01,
                         };
                       }
                     } catch (e: any) {
                       console.warn(`Spec fetch failed for ${brokerSymbol} on [${conn.display_name}]: ${e?.message}`);
                     }
                   }
                   const brokerSpec = specCache[specCacheKey];
                   if (!brokerSpec) {
                     const reason = "broker symbol specification unavailable";
                     console.warn(`Broker sizing rejected [${conn.display_name}]: ${reason}`);
                     mirrorResults.push(`${conn.display_name}: skipped (${reason})`);
                     continue;
                   }
                   const normalizedVolume = normalizeBrokerVolumeDown({
                     lots: brokerVolume,
                     minVolume: brokerSpec.minVolume,
                     maxVolume: brokerSpec.maxVolume,
                     volumeStep: brokerSpec.volumeStep,
                   });
                   if (!normalizedVolume.ok) {
                     console.warn(`Broker sizing rejected [${conn.display_name}]: ${normalizedVolume.error}`);
                     mirrorResults.push(
                       `${conn.display_name}: skipped (sizing rejected: ${normalizedVolume.error})`,
                     );
                     continue;
                   }
                   brokerVolume = normalizedVolume.volume;
                   console.log(`Broker specs [${conn.display_name}] ${brokerSymbol}: min=${brokerSpec.minVolume}, max=${brokerSpec.maxVolume}, step=${brokerSpec.volumeStep} → normalized down to ${brokerVolume}`);

                   // ── Unified spread check for MetaApi ──
                   const metaSpread = await fetchBrokerSpread(conn, pair, pairConfig, metaAccountId, authToken);
                   if (metaSpread && !metaSpread.passed) {
                     mirrorResults.push(`${conn.display_name}: skipped (spread ${metaSpread.spreadPips.toFixed(1)} > ${metaSpread.effectiveMax} max)`);
                     continue;
                   }

                   // Adjust SL/TP for broker spread using unified helper
                   let brokerSL = sl;
                   let brokerTP = tp;
                   if (metaSpread) {
                     const adj = adjustSLTPForSpread(sl, tp, analysis.direction, metaSpread.halfSpreadPrice);
                     brokerSL = adj.brokerSL;
                     brokerTP = adj.brokerTP;
                     console.log(`MetaApi SL/TP adjusted for spread [${conn.display_name}]: SL ${sl} → ${brokerSL}, TP ${tp} → ${brokerTP}`);
                   }

                   const mt5Body: any = {
                     actionType: analysis.direction === "long" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
                     symbol: brokerSymbol,
                     volume: brokerVolume,
                     comment: `paper:${positionId}`,
                   };
                   if (brokerSL) mt5Body.stopLoss = brokerSL;
                   if (brokerTP) mt5Body.takeProfit = brokerTP;
                   console.log(`Broker mirror [${conn.display_name}]: sending ${pair} → ${brokerSymbol} ${analysis.direction} ${brokerVolume} lots, SL=${brokerSL}, TP=${brokerTP}, spread=${metaSpread?.spreadPips?.toFixed(2) ?? "?"} pips`);
                   const ledgerExecution = await executeBrokerOrderWithLedger(
                     supabase,
                     {
                       userId,
                       botId: BOT_ID,
                       positionId,
                       brokerConnectionId: conn.id,
                       route: "direct_market",
                       requestPayload: {
                         symbol: pair,
                         brokerSymbol,
                         direction: analysis.direction,
                         volume: brokerVolume,
                         stopLoss: brokerSL,
                         takeProfit: brokerTP,
                       },
                     },
                     async () => {
                       const { res: mt5Res, body: rawBody } = await metaFetch(
                         metaAccountId,
                         authToken,
                         (base) => `${base}/trade`,
                         {
                           method: "POST",
                           headers: { "Content-Type": "application/json" },
                           body: JSON.stringify(mt5Body),
                         },
                         { allowFailover: false },
                       );
                       let parsedBody: any = null;
                       try { parsedBody = rawBody ? JSON.parse(rawBody) : null; } catch {}
                       return {
                         ok: mt5Res.ok,
                         httpStatus: mt5Res.status,
                         parsedBody,
                         rawBody,
                         confirmationMode: "metaapi_position_open",
                       };
                     },
                   );
                   const resBody = ledgerExecution.rawBody || "";
                   const parsed = ledgerExecution.parsedBody || {};
                   if (ledgerExecution.status === "succeeded") {
                     console.log(`Broker mirror [${conn.display_name}]: SUCCESS — ${resBody.slice(0, 500)}`);
                     mirrorResults.push(`${conn.display_name}: success`);
                     mirroredConnIds.push(conn.id);
                     brokerHealthMap[conn.id] = updateHealth(connHealth, {
                       connectionId: conn.id,
                       success: true,
                       latencyMs: 0,
                       isTransient: false,
                     });
                     // Auto-detect commission from MetaApi trade response
                     try {
                       const brokerOrderId = ledgerExecution.brokerOrderId
                         || parsed.orderId
                         || parsed.positionId;
                       if (brokerOrderId) {
                         // Fetch the deal associated with this order to get commission + fill price
                         const { res: dealRes, body: dealBody } = await metaFetch(
                           metaAccountId,
                           authToken,
                           (base) => `${base}/history-deals/position/${brokerOrderId}`,
                         );
                         if (dealRes.ok) {
                           const deals = JSON.parse(dealBody);
                           const dealArr = Array.isArray(deals) ? deals : [];
                           for (const deal of dealArr) {
                             if (!brokerFillPrice && deal.price != null) {
                               const metaFillPrice = parseFloat(deal.price);
                               if (metaFillPrice > 0) {
                                 brokerFillPrice = metaFillPrice;
                                 console.log(`[broker-fill-price] MetaApi [${conn.display_name}]: fill price ${metaFillPrice}`);
                               }
                             }
                             if (deal.commission !== undefined && deal.volume > 0) {
                               const dealComm = Math.abs(parseFloat(deal.commission || "0"));
                               const dealVol = parseFloat(deal.volume || "0");
                               if (dealComm > 0 && dealVol > 0) {
                                 const commPerLot = dealComm / dealVol;
                                 console.log(`[commission auto-detect] MetaApi [${conn.display_name}]: $${commPerLot.toFixed(3)}/lot/side from deal (comm=$${dealComm}, vol=${dealVol})`);
                                 await supabase.from("broker_connections")
                                   .update({ detected_commission_per_lot: commPerLot })
                                   .eq("id", conn.id);
                                 break;
                               }
                             }
                           }
                         }
                       }
                     } catch (commErr: any) {
                       console.warn(`Commission auto-detect failed [${conn.display_name}]: ${commErr?.message}`);
                     }
                   } else {
                     const reason = ledgerExecution.error || "reconciliation required";
                     console.warn(
                       `Broker mirror [${conn.display_name}] ${ledgerExecution.status}: ${reason}`,
                     );
                     mirrorResults.push(`${conn.display_name}: ${ledgerExecution.status} — ${reason}`);
                     brokerHealthMap[conn.id] = updateHealth(
                       brokerHealthMap[conn.id] || createInitialHealth(conn.id),
                       {
                         connectionId: conn.id,
                         success: false,
                         latencyMs: 0,
                         error: reason,
                         isTransient: ledgerExecution.status === "uncertain",
                       },
                     );
                   }
                 } catch (connErr: any) {
                  console.warn(`Broker mirror [${conn.display_name}] error: ${connErr?.message || connErr}`);
                  mirrorResults.push(`${conn.display_name}: error`);
                  // Circuit breaker: record transient failure
                  brokerHealthMap[conn.id] = updateHealth(brokerHealthMap[conn.id] || createInitialHealth(conn.id), {
                    connectionId: conn.id, success: false, latencyMs: 0,
                    error: connErr?.message || "unknown", isTransient: true,
                  });
                }
              }
              detail.mt5Mirror = mirrorResults.join("; ");
              detail.mirroredConnectionIds = mirroredConnIds;
              // Persist which broker connections this paper position was actually mirrored to.
              // Close paths use this list to fan out — never iterate ALL active connections.
              if (mirroredConnIds.length > 0) {
                // Also persist the actual broker fill price in signal_reason for accurate BE/trailing calculations.
                // Without this, management uses the paper entry price which may differ from broker execution price.
                const mirrorUpdate: any = { mirrored_connection_ids: mirroredConnIds };
                if (brokerFillPrice != null) {
                  // Read existing signal_reason, inject brokerEntryPrice, write back
                  const { data: posRow } = await supabase.from("paper_positions")
                    .select("signal_reason").eq("position_id", positionId).eq("user_id", userId).single();
                  let existingSignal: any = {};
                  try { existingSignal = JSON.parse(posRow?.signal_reason || "{}"); } catch {}
                  existingSignal.brokerEntryPrice = brokerFillPrice;
                  mirrorUpdate.signal_reason = JSON.stringify(existingSignal);
                  console.log(`[broker-fill-price] Stored brokerEntryPrice=${brokerFillPrice} for ${pair} (paper entry was ${marketEntryPrice})`);
                }
                await supabase.from("paper_positions")
                  .update(mirrorUpdate)
                  .eq("position_id", positionId).eq("user_id", userId);
              }
            } else {
              detail.mt5Mirror = "skipped_no_connection";
            }
          } else {
            detail.mt5Mirror = "skipped_paper_mode";
          }
        } catch (e: any) {
          console.warn(`MT5 mirror error: ${e?.message || e}`);
          detail.mt5Mirror = "error";
        }
        if (account.execution_mode === "live") {
          const { data: brokerLifecycle } = await supabase.rpc("finalize_live_broker_position", {
            p_user_id: userId, p_bot_id: BOT_ID, p_position_id: positionId,
          });
          detail.brokerExecutionState = brokerLifecycle?.state || "unknown";
          if (brokerLifecycle?.open === true) {
            await closeOppositePositionsAfterEntry();
          } else {
            detail.status = brokerLifecycle?.state === "reconciliation_required"
              ? "broker_reconciliation_required" : "broker_entry_rejected";
            detail.skipReason = brokerLifecycle?.reason || "No broker confirmed the live order";
            tradesPlaced = Math.max(0, tradesPlaced - 1);
          }
        }

        // Only paper positions or broker-confirmed live positions participate in later gates.
        if (account.execution_mode !== "live" || detail.brokerExecutionState === "confirmed") {
          openPosArr.push({ symbol: pair, size: size.toString(), entry_price: analysis.lastPrice.toString(), direction: analysis.direction, position_id: positionId, position_status: "open", order_id: orderId, open_time: nowStr, signal_score: analysis.score.toString() });
        }
      } else if (
        (detail as any).canonicalScannerEnforcement?.effectiveMode === "enforce" &&
        (detail as any).canonicalScannerEnforcement?.disposition === "wait"
      ) {
        let waitPersistenceError: string | null = null;
        let waitPlanRejectionReason: string | null = null;
        if (!currentPendingCandidate && preparedZoneWatch &&
            pairConfig.preArmZoneSetups === true && config.limitOrderEnabled &&
            !config.marketFillAtZone) {
          let stagedReady = !!existingStaged;
          if (!stagedReady) {
            const { error: stagedError } = await supabase.from("staged_setups").insert(preparedZoneWatch);
            if (stagedError) {
              waitPersistenceError = `Watchlist persistence failed: ${stagedError.message}`;
            } else {
              stagedReady = true;
              stagedNew++;
            }
          }
          if (stagedReady) {
          const frozenZone = preparedZoneWatch.originating_zone;
          const frozenEntry = Number(preparedZoneWatch.entry_price ?? frozenZone?.entry);
          const frozenStop = Number(preparedZoneWatch.sl_level);
          const waitPlan = buildConfiguredPreArmedPlan({
            direction: analysis.direction as "long" | "short",
            zone: {
              price: frozenEntry,
              zoneType: String(frozenZone?.type || "impulse_zone"),
              zoneLow: Number(frozenZone?.low),
              zoneHigh: Number(frozenZone?.high),
            },
            structuralInvalidation: frozenStop,
            preferredPositionStop: analysis.stopLoss,
            symbol: pair,
            atrValue: (analysis as any).atrValue,
            config: pairConfig,
            analysis,
            stopPolicy: enforcedZoneStopPolicyFor(frozenStop),
            lifecycleDecision: validatePendingLifecycle(
              readFrozenSetupStrategyContext(preparedZoneWatch),
              frozenZone,
            ),
          });
          if (waitPlan.valid) {
            const stagedAt = Date.parse(preparedZoneWatch.staged_at || preparedZoneWatch.created_at);
            const ttlMinutes = Number(preparedZoneWatch.ttl_minutes || stagingTTLMinutes);
            const placedAt = new Date().toISOString();
            const preArmReachability = observePreArmReachability({
              currentPrice: Number(analysis.lastPrice),
              entryPrice: waitPlan.plan.entryPrice,
              pipSize: (SPECS[pair] || SPECS["EUR/USD"]).pipSize,
              // Same fix as the frozen-zone route above: `analysis.atrValue`
              // does not exist, so this recorded null on every pre-armed row.
              atrValue: zoneStopPolicyConfirmationAtr > 0
                ? zoneStopPolicyConfirmationAtr
                : null,
              ttlMinutes,
              referenceMaxDistancePips: Number(config.limitOrderMaxDistancePips ?? 30),
              armedAt: placedAt,
            });
            const expiresAt = new Date(stagedAt + ttlMinutes * 60_000).toISOString();
            const { error } = await supabase.from("pending_orders").insert({
              user_id: userId, bot_id: BOT_ID, order_id: crypto.randomUUID().slice(0, 8),
              symbol: pair, direction: analysis.direction, order_type: "limit",
              entry_price: waitPlan.plan.entryPrice, current_price: analysis.lastPrice,
              stop_loss: waitPlan.plan.stopLoss, take_profit: waitPlan.plan.takeProfit, size: null,
              entry_zone_type: waitPlan.plan.zone.zoneType, entry_zone_low: waitPlan.plan.zone.zoneLow,
              entry_zone_high: waitPlan.plan.zone.zoneHigh, status: "pending",
              expiry_minutes: ttlMinutes, expires_at: expiresAt,
              signal_reason: {
                preArmed: true,
                candidateId: preparedZoneWatch.candidate_id,
                preArmReachability,
                takeProfitSource: waitPlan.takeProfitSource,
                takeProfitFallbackReason: waitPlan.takeProfitFallbackReason,
                zoneSetupStopPolicyMode: zoneStopPolicyResolution.requestedMode,
                zoneSetupStopPolicyAppliedAtArm: zoneStopPolicyResolution.enforced,
                zoneSetupStopPolicyBufferQuoteDistance:
                  adjustedSlBuffer * zoneStopPolicySpec.pipSize,
                zoneSetupStopPolicy: waitPlan.stopPolicy || null,
              },
              signal_score: analysis.score, from_watchlist: true, staged_setup_id: preparedZoneWatch.id,
              candidate_id: preparedZoneWatch.candidate_id, structural_invalidation: frozenStop,
              structural_invalidation_source: "staged_inherited", originating_zone: frozenZone,
              frozen_strategy_context: preparedZoneWatch.frozen_strategy_context,
              confirmation_method: preparedZoneWatch.confirmation_method || pairConfig.confirmationMethod || "choch",
              confirmation_config: preparedZoneWatch.confirmation_config, placed_at: placedAt,
              liquidity_confirmation_observation: (detail as any).liquidityConfirmationObservation || null,
            });
            if (error && !/duplicate key/i.test(error.message)) waitPersistenceError = error.message;
            (detail as any).frozenExecutablePlan = {
              ...((detail as any).frozenExecutablePlan || {}),
              entryPrice: waitPlan.plan.entryPrice, stopLoss: waitPlan.plan.stopLoss,
              takeProfit: waitPlan.plan.takeProfit,
              takeProfitSource: waitPlan.takeProfitSource,
              takeProfitFallbackReason: waitPlan.takeProfitFallbackReason,
              zone: waitPlan.plan.zone,
            };
          } else {
            waitPlanRejectionReason = waitPlan.reason;
          }
          }
        }
        const waitingStage = (detail as any).canonicalScannerState?.stage || "watching";
        detail.status = waitingStage === "awaiting_liquidity"
          ? "waiting_for_sweep"
          : waitingStage === "awaiting_confirmation"
          ? "waiting_for_reconfirmation"
          : waitingStage;
        detail.skipReason = (detail as any).canonicalScannerState?.explanation ||
          "Canonical setup remains active and is waiting for more evidence";
        if (waitPersistenceError) detail.skipReason += `; pending persistence failed: ${waitPersistenceError}`;
        if (waitPlanRejectionReason) {
          detail.skipReason += `; pre-arm plan not armed: ${waitPlanRejectionReason}`;
          detail.preArmDecision = rejectedPreArmDecision(
            waitPlanRejectionReason,
            preparedZoneWatch?.candidate_id,
          );
        }
        detail.rejectionReasons = [];
        scanDetails.push(detail);
        continue;
      } else {
        rejectedCount++;
        detail.status = "rejected";
        const failedGates = gates.filter(g => !g.passed);
        const enforcingOwnedAuthorities = singleOwnershipScanOutcome.disposition !== "legacy";
        const blockingGateReasons: string[] = [];
        for (const gate of failedGates) {
          const code = normalizeRejectedGate(gate.reason);
          const disposition = evaluateAuthorityGateDisposition({
            code, passed: false,
            requestedMode: (pairConfig as any).singleOwnershipMode,
            runtimeTarget: account.execution_mode === "live" ? "live" : "paper",
          });
          const duplicatedRollingLocationGate = enforcingOwnedAuthorities && code === "premium_discount";
          if ((!enforcingOwnedAuthorities || disposition.blocksAuthorization) && !duplicatedRollingLocationGate) {
            blockingGateReasons.push(gate.reason);
          } else {
            legacyGateDiagnostics.push({ ...disposition, reason: gate.reason });
          }
        }
        detail.legacyGateDiagnostics = legacyGateDiagnostics;
        const authorityReasons = singleOwnershipScanOutcome.disposition === "reject"
          ? [...singleOwnershipScanOutcome.reasons]
          : [];
        const canonicalRejection = (detail as any).canonicalDealingRangeObservation?.canonical;
        const hasDetailedRiskRewardReason = blockingGateReasons.some((reason) =>
          normalizeRejectedGate(reason) === "minimum_risk_reward"
        );
        const consolidatedAuthorityReasons = authorityReasons.filter((reason) =>
          !reason.startsWith("Premium/Discount rule blocked entry:") &&
          !(hasDetailedRiskRewardReason && reason.includes("expected reward is too small"))
        );
        if (canonicalRejection?.allowed === false && canonicalRejection?.explanation) {
          consolidatedAuthorityReasons.push(canonicalRejection.explanation);
        }
        if (!analysis.stopLoss || !analysis.takeProfit) {
          consolidatedAuthorityReasons.push("Valid stop loss and take profit are required");
        }
        detail.rejectionReasons = [...new Set([
          ...blockingGateReasons,
          ...consolidatedAuthorityReasons,
        ])];
        if (detail.rejectionReasons.length === 0) {
          detail.rejectionReasons = ["Trade entry was not authorized; no blocking reason was recorded"];
        }
        // ── Rejected Setup Logging: gate-blocked setup ──
        try {
          const _rsCurrencies = parsePairCurrencies(pair);
          const _rsPairPlan = activeGamePlan?.plans?.find((p: any) => p.symbol === pair);
          await logRejectedSetup({
            supabase,
            userId,
            symbol: pair,
            direction: analysis.direction as "long" | "short",
            rejectionType: "gate_blocked",
            failedGates: detail.rejectionReasons,
            confluenceScore: effectiveScore,
            tier1Count: analysis.tieredScoring?.tier1Count ?? 0,
            tier1Factors: analysis.factors?.filter((f: any) => f.present && f.tier === 1).map((f: any) => f.name) ?? [],
            entryPrice: analysis.lastPrice,
            stopLoss: analysis.stopLoss ?? undefined,
            takeProfit: analysis.takeProfit ?? undefined,
            rrRatio: analysis.stopLoss && analysis.takeProfit
              ? parseFloat((Math.abs(analysis.takeProfit - analysis.lastPrice) / Math.abs(analysis.lastPrice - analysis.stopLoss)).toFixed(2))
              : undefined,
            sessionName: analysis.session?.name,
            regime: (pairConfig as any)._gamePlanContext?.regime,
            gpBias: _rsPairPlan?.bias,
            gpBiasConfidence: _rsPairPlan?.biasConfidence,
            fotsiBaseTsi: _rsCurrencies && _fotsiResult ? _fotsiResult.strengths[_rsCurrencies[0]] : undefined,
            fotsiQuoteTsi: _rsCurrencies && _fotsiResult ? _fotsiResult.strengths[_rsCurrencies[1]] : undefined,
            priceAtRejection: analysis.lastPrice,
            rawDetail: {
              scanCycleId,
              singleOwnershipEnforcement:
                (detail as any).singleOwnershipEnforcement || null,
              gamePlanShadowAudit: (detail as any).gamePlanShadowAudit || null, streamlinedDecisionOrigin: (detail as any).streamlinedDecisionOrigin || null, streamlinedDecisionLatest: (detail as any).streamlinedDecisionLatest || null, singleOwnershipDecision: (detail as any).singleOwnershipDecision || null, legacyGateDiagnostics: (detail as any).legacyGateDiagnostics || [],
              thesisConviction: (detail as any).thesisConviction || null,
              directionVerdict: (detail as any).directionVerdict || null,
              impulseZone: (detail as any).impulseZone || null,
              decisionContext: (detail as any).decisionContext || null,
              stylePolicy: pairStylePolicy,
              canonicalDealingRangeObservation:
                (detail as any).canonicalDealingRangeObservation || null,
              ...canonicalEvidenceSnapshot(detail),
              shadowEvaluation: {
                baseScore: analysis.score,
                effectiveScore,
                threshold: conflictAdjustedMinConfluence,
              },
            },
          });
        } catch (rsErr: any) {
          // Non-fatal: logging failure must never block the scanner
          console.warn(`[rejected-setup] Logging error for ${pair}: ${rsErr?.message}`);
        }

        // ── Breaker Block Entry Signal (SMC Enhancement) ──
        // Breakers remain an independent setup model, but they are not an
        // independent execution authority. Direction, Game Plan, account,
        // exposure, drawdown and prop-firm checks must authorize the candidate.
        if (smcEnhResult?.breakerBlocks && smcEnhResult.breakerBlocks.length > 0 && config.smcEnhancements?.enableBreakerBlocks) {
          for (const breaker of smcEnhResult.breakerBlocks) {
            if (!breaker.retestComplete || !breaker.retestIsCurrent) continue;
            if (breaker.confidence < 0.5) continue; // Minimum confidence threshold

            const breakerDir = breaker.direction === "bullish" ? "long" : "short";
            const breakerCanonicalRange =
              (detail as any).canonicalDealingRangeObservation?.canonical?.range || null;
            const breakerCandidateObservation = normalizeBreakerCandidate({
              semantic: "sweep_displacement_retest_breaker_setup",
              symbol: pair,
              direction: breakerDir,
              low: breaker.entryZone.low,
              high: breaker.entryZone.high,
              timeframe: timeframeAuthority.roles.setup,
              structureBreakIndex: breaker.structureBreakIndex,
              retestComplete: breaker.retestComplete,
              impulse: breakerCanonicalRange ? {
                id: breakerCanonicalRange.impulseId,
                low: Number(breakerCanonicalRange.low),
                high: Number(breakerCanonicalRange.high),
                direction: breakerCanonicalRange.direction === "bullish" ? "long" : "short",
              } : null,
            });
            ((detail as any).breakerCandidateComparisons ||= []).push(
              breakerCandidateObservation,
            );
            if ((detail as any).canonicalScannerEnforcement?.effectiveMode === "enforce" &&
              !breakerCandidateObservation.eligibleForUnifiedQueue) {
              console.log(`[breaker] ${pair}: canonical scanner rejected supplemental route outside frozen impulse ownership`);
              continue;
            }
            const breakerSpec = SPECS[pair] || SPECS["EUR/USD"];
            // Entry at the 50% of the breaker zone (OTE within the zone)
            const breakerEntry = (breaker.entryZone.high + breaker.entryZone.low) / 2;
            // SL beyond the far boundary of the breaker zone
            const breakerSL = breakerDir === "long"
              ? breaker.entryZone.low - (adjustedSlBuffer * breakerSpec.pipSize)
              : breaker.entryZone.high + (adjustedSlBuffer * breakerSpec.pipSize);
            const breakerRisk = Math.abs(breakerEntry - breakerSL);
            const breakerTP = breakerDir === "long"
              ? breakerEntry + breakerRisk * config.tpRatio
              : breakerEntry - breakerRisk * config.tpRatio;

            // Orientation check
            const breakerOrientationOk = breakerDir === "long"
              ? (breakerSL < breakerEntry && breakerTP > breakerEntry)
              : (breakerSL > breakerEntry && breakerTP < breakerEntry);
            if (!breakerOrientationOk) continue;

            // Size calculation (default remains the historical half-risk behavior).
            const breakerSizeMultiplier = Math.max(
              0.1,
              Math.min(1, Number((pairConfig as any).smcEnhancements?.breakerSizeMultiplier ?? 0.5)),
            );
            const breakerSizing = computePositionSize(
              { balance, riskPercent: pairConfig.riskPerTrade * breakerSizeMultiplier, entryPrice: breakerEntry, stopLoss: breakerSL, symbol: pair, method: (pairConfig as any).positionSizingMethod || "percent_risk", fixedLotSize: (pairConfig as any).fixedLotSize, atrValue: (analysis as any).atrValue, atrVolatilityMultiplier: (pairConfig as any).atrVolatilityMultiplier, rateMap, commissionPerLot: avgCommissionPerLot },
              undefined, undefined, { enabled: true, sizeMultiplier: propFirmSizeMultiplier },
            );
            const finalBreakerSizing = applyFinalCandidateSizeAdjustments({
              sizingResult: breakerSizing,
              signalSource: "unified",
            });
            if (finalBreakerSizing.rejected) {
              detail.status = "position_sizing_rejected";
              detail.skipReason = finalBreakerSizing.rejectionReason ||
                "Breaker sizing produced no executable size";
              scanDetails.push(detail);
              continue;
            }
            const breakerSize = finalBreakerSizing.lots;

            const breakerThesisResult = validatePendingOrderThesis(
              {
                order_id: `breaker:${scanCycleId}:${pair}`,
                symbol: pair,
                direction: breakerDir,
                entry_price: breakerEntry,
                signal_reason: {
                  directionVerdict: (detail as any).directionVerdict || null,
                },
              },
              {
                fotsiResult: _fotsiResult,
                lastGamePlan: gamePlanEnabled ? activeGamePlan : null,
                dailyCandles: dailyCandles.length >= 20
                  ? dailyCandles
                  : null,
                h4Candles: h4Candles.length >= 20 ? h4Candles : null,
                h1Candles: hourlyCandles.length >= 20
                  ? hourlyCandles
                  : null,
                decisionEvidence: pairDecisionEvidence,
              },
            );
            const breakerRuntimeGates = await buildFinalRuntimeGateStates({
              supabase,
              userId,
              accountExecutionMode: account.execution_mode,
              brokerExecutionConnectionCount: null,
              symbol: pair,
              direction: breakerDir,
              currentPrice: analysis.lastPrice,
              candles,
              interval: entryInterval,
              openPositions: openPosArr,
              accountBalance: account.balance,
              config: {
                portfolioHeat: pairConfig.portfolioHeat,
                riskPerTrade: pairConfig.riskPerTrade,
                correlationFilterEnabled:
                  pairConfig.correlationFilterEnabled,
                maxCorrelation: pairConfig.maxCorrelation,
                maxCorrelatedPositions:
                  pairConfig.maxCorrelatedPositions,
                cooldownMinutes: pairConfig.cooldownMinutes,
                newsFilterEnabled: pairConfig.newsFilterEnabled,
                newsFilterPauseMinutes:
                  pairConfig.newsFilterPauseMinutes,
                enabledSessions: pairConfig.enabledSessions,
                enabledDays: pairConfig.enabledDays,
                killZoneOnly: pairConfig.killZoneOnly,
              },
              rateMap,
            });
            const breakerEvaluatedAt = new Date().toISOString();
            const breakerConfirmation: EntryConfirmationDecision = {
              required: false,
              passed: false,
              method: pairConfig.confirmationMethod || "choch",
              reason:
                "Breaker setup is waiting; entry confirmation becomes mandatory at fill time",
              evidence: {
                breakerConfidence: breaker.confidence,
                retestComplete: breaker.retestComplete,
              },
              evaluatedAt: breakerEvaluatedAt,
            };
            const rawBreakerAuthorization = evaluateFinalTradeAuthorization({
              account,
              candidate: {
                symbol: pair,
                direction: breakerDir,
                entryPrice: breakerEntry,
                stopLoss: breakerSL,
                takeProfit: breakerTP,
              },
              openPositions: openPosArr,
              maxOpenPositions: pairConfig.maxOpenPositions,
              maxPerSymbol: pairConfig.maxPerSymbol,
              allowSameDirectionStacking: pairConfig.allowSameDirectionStacking,
              maxDailyLoss: pairConfig.maxDailyLoss,
              maxDrawdown: pairConfig.maxDrawdown,
              minimumRiskReward: pairConfig.minRiskReward,
              commissionPerLot: avgCommissionPerLot,
              rateMap,
              directionVerdict: activeDirectionVerdict,
              requireDirectionVerdict: true,
              gamePlan: activeGamePlan,
              gamePlanEnabled,
              gamePlanMode: gpEnforcementMode,
              gamePlanMinimumConfidence: (config as any).gpHardBlockThreshold ?? 75,
              thesisResult: breakerThesisResult,
              requireThesisValidation: true,
              entryConfirmation: breakerConfirmation,
              propFirm: propFirmGateResult
                ? {
                  enabled: propFirmGateResult.enabled,
                  allowed: propFirmGateResult.allowed,
                  reason: propFirmGateResult.reason,
                }
                : null,
              requirePropFirmResult: true,
              // Spread and fresh thesis are rechecked when the pending order
              // reaches confirmation. Placement itself does not execute.
              spread: { required: false, available: true, passed: true },
              runtimeGates: breakerRuntimeGates,
              crossTimeframeAuthority:
                selectedCrossTimeframeContext().authority,
              requireCrossTimeframeAuthority: true,
            });
            const breakerHierarchy =
              rawBreakerAuthorization.decisionHierarchy ||
              evaluateDecisionHierarchy({
                symbol: pair,
                direction: breakerDir,
                gamePlan: activeGamePlan,
                gamePlanEnabled,
                gamePlanMode: gpEnforcementMode,
                gamePlanMinimumConfidence:
                  (config as any).gpHardBlockThreshold ?? 75,
                directionVerdict: activeDirectionVerdict,
                requireDirectionVerdict: true,
                thesisResult: breakerThesisResult,
                requireThesisValidation: true,
                entryConfirmation: breakerConfirmation,
              });
            const breakerAuthorization = attachDecisionContext(
              rawBreakerAuthorization,
              buildTradeDecisionContext({
                stage: "pending",
                symbol: pair,
                direction: breakerDir,
                gamePlan: activeGamePlan,
                directionVerdict: activeDirectionVerdict,
                thesisResult: breakerThesisResult,
                requireThesisValidation: true,
                thesisConviction: (detail as any).thesisConviction || null,
                entryConfirmation: breakerConfirmation,
                hierarchy: breakerHierarchy,
                stylePolicy: pairStylePolicy,
                evaluatedAt: breakerEvaluatedAt,
              }),
            );
            if (!breakerAuthorization.authorized) {
              console.warn(
                `[breaker] ${pair} ${breakerDir}: FINAL AUTH BLOCKED`
                + ` ${breakerAuthorization.code} — ${breakerAuthorization.reason}`,
              );
              continue;
            }

            const breakerOrderId = `brk-${crypto.randomUUID().slice(0, 6)}`;
            // Previously randomised unconditionally, even when a watchlist row
            // for this symbol/direction already owned the lifecycle.
            const breakerIdentity = resolveLifecycleCandidateId({
              stagedCandidateId: existingStaged?.candidate_id,
              stagedRowId: existingStaged?.id,
            }, () => crypto.randomUUID());
            const breakerCandidateId = breakerIdentity.candidateId;
            if (breakerIdentity.inherited) {
              console.log(`[breaker] ${pair}: lifecycle identity inherited from ${breakerIdentity.source} (${breakerCandidateId})`);
            }
            const breakerExpiry = config.limitOrderExpiryMinutes || 60;
            const breakerExpiresAt = new Date(Date.now() + breakerExpiry * 60 * 1000).toISOString();
            const breakerOriginatingZone = {
              setupFamily: "impulse",
              candidateId: breakerCandidateObservation.candidateId,
              sourceEvidenceIds: [],
              sourceImpulseId: breakerCandidateObservation.impulseId,
              type: "breaker_block",
              low: breaker.entryZone.low,
              high: breaker.entryZone.high,
              entry: breakerEntry,
              timeframe: breakerCandidateObservation.timeframe,
              lifecycle: breaker.retestComplete ? "retested" : "fresh",
              structuralInvalidation: breakerDir === "long"
                ? breaker.entryZone.low
                : breaker.entryZone.high,
              stopLoss: breakerSL,
              takeProfit: breakerTP,
            };
            const breakerFrozenStrategyContext =
              buildFrozenSetupStrategyContext({
                identity: {
                  setupId: crypto.randomUUID(),
                  candidateId: breakerCandidateId,
                },
                timeframeEvidenceId:
                  (detail as any).timeframeEvidenceId || null,
                symbol: pair,
                direction: breakerDir,
                stylePolicy: pairStylePolicy,
                runtimeConfig: pairRuntimeConfigSnapshot,
                decisionContext: breakerAuthorization.decisionContext,
                gamePlan: activeGamePlan,
                directionVerdict: activeDirectionVerdict,
                crossTimeframeContext: selectedCrossTimeframeContext(breakerOriginatingZone),
                entryZone: breakerOriginatingZone,
                confirmationMethod:
                  pairConfig.confirmationMethod || "choch",
                indicatorMinCount: pairConfig.indicatorMinCount || 3,
              });
            (detail as any).linkedSetupId =
              breakerFrozenStrategyContext.setupId;
            const breakerLifecycleValidation = validatePendingLifecycle(
              breakerFrozenStrategyContext,
              breakerOriginatingZone,
            );
            if (!breakerLifecycleValidation.valid) {
              detail.status = "breaker_rejected_lifecycle_identity";
              detail.skipReason = breakerLifecycleValidation.reason;
              scanDetails.push(detail);
              continue;
            }

            const { error: breakerInsertErr } = await supabase.from("pending_orders").insert({
              user_id: userId,
              bot_id: BOT_ID,
              candidate_id: breakerCandidateId,
              order_id: breakerOrderId,
              symbol: pair,
              direction: breakerDir,
              order_type: "limit",
              entry_price: breakerEntry,
              current_price: analysis.lastPrice,
              stop_loss: breakerSL,
              take_profit: breakerTP,
              size: breakerSize,
              entry_zone_type: "breaker_block",
              entry_zone_low: breaker.entryZone.low,
              entry_zone_high: breaker.entryZone.high,
              originating_zone: breakerOriginatingZone,
              thesis_version: THESIS_VALIDATION_VERSION,
              confirmation_method:
                pairConfig.confirmationMethod || "choch",
              confirmation_config: {
                indicatorMinCount: pairConfig.indicatorMinCount || 3,
                afterChochMode:
                  pairConfig.afterChochMode || "confirmation_close",
                afterChochExpiryMinutes:
                  pairConfig.afterChochExpiryMinutes || 30,
                maxConfirmationAttempts:
                  breakerFrozenStrategyContext.confirmation.maxAttempts,
              },
              frozen_strategy_context: breakerFrozenStrategyContext,
              status: "pending",
              expiry_minutes: breakerExpiry,
              expires_at: breakerExpiresAt,
              signal_reason: JSON.stringify({
                bot: BOT_ID,
                candidateId: breakerCandidateId,
                ...canonicalEvidenceSnapshot(detail),
                signalSource: "breaker",
                summary: breaker.detail,
                breakerData: { direction: breaker.direction, confidence: breaker.confidence, displacementStrength: breaker.displacementStrength, hadLiquiditySweep: breaker.hadLiquiditySweep, originalOB: breaker.originalOB, structureBreakIndex: breaker.structureBreakIndex, retestIndex: breaker.retestIndex, sizeMultiplier: breakerSizeMultiplier },
                entryTimeframe: pairConfig.entryTimeframe,
                originalSL: breakerSL,
                originalTP: breakerTP,
                confirmationMethod:
                  pairConfig.confirmationMethod || "choch",
                indicatorMinCount: pairConfig.indicatorMinCount || 3,
                thesisVersion: THESIS_VALIDATION_VERSION,
                tpMethod: config.tpMethod || "rr_ratio",
                timeframeEvidenceId:
                  (detail as any).timeframeEvidenceId || null,
                directionVerdict: (detail as any).directionVerdict || null,
                gamePlanSnapshot: activeGamePlan?.plans?.find((plan: any) => plan.symbol === pair) || null,
                candidateAuthorization: breakerAuthorization,
                decisionContext: breakerAuthorization.decisionContext,
                frozenStrategyContext: breakerFrozenStrategyContext,
              }),
              signal_score: breaker.confidence * 100,
              setup_type: "breaker_retest",
              setup_confidence: breaker.confidence,
              exit_flags: {
                trailingStopEnabled: pairConfig.trailingStopEnabled,
                trailingStopPips: pairConfig.trailingStopPips,
                trailingStopActivation: pairConfig.trailingStopActivation,
                trailingStopActivated: false,
                trailingStopLevel: null,
                breakEvenEnabled: pairConfig.breakEvenEnabled,
                breakEvenPips: pairConfig.breakEvenPips,
                breakEvenOffsetPips: (pairConfig as any).breakEvenOffsetPips ?? 0,
                breakEvenActivated: false,
                partialTPEnabled: pairConfig.partialTPEnabled,
                partialTPPercent: pairConfig.partialTPPercent,
                partialTPLevel: pairConfig.partialTPLevel,
                partialTPActivated: false,
                maxHoldEnabled: pairConfig.maxHoldEnabled,
                maxHoldHours: pairConfig.maxHoldHours,
                tpRatio: pairConfig.tpRatio,
              },
              placed_at: new Date().toISOString(),
            });

            if (!breakerInsertErr) {
              pendingPlaced++;
              console.log(`[breaker] ${pair} ${breakerDir}: Pending order placed at ${breakerEntry.toFixed(5)} (conf=${(breaker.confidence * 100).toFixed(0)}%, disp=${breaker.displacementStrength.toFixed(2)}x ATR)`);
              (detail as any).breakerEntry = { orderId: breakerOrderId, direction: breakerDir, entry: breakerEntry, sl: breakerSL, tp: breakerTP, confidence: breaker.confidence };
            } else {
              console.warn(`[breaker] ${pair}: Insert failed — ${breakerInsertErr.message}`);
            }
            break; // Only place one breaker order per pair per cycle
          }
        }
      }
    } else {
      if (analysis.score < adjustedMinConfluence) {
        (detail as any).gamePlanShadowAudit = finalizeShadowCurrentDecision(
          (detail as any).gamePlanShadowAudit,
          "block",
          `Confluence ${effectiveScore.toFixed(1)}% is below ${conflictAdjustedMinConfluence}%`,
        );
        // ── Rejected Setup Logging: below-threshold with strong T1 ──
        if (analysis.direction && shouldLogBelowThreshold(analysis.tieredScoring?.tier1Count ?? 0)) {
          try {
            const _rsCurrencies2 = parsePairCurrencies(pair);
            const _rsPairPlan2 = activeGamePlan?.plans?.find((p: any) => p.symbol === pair);
            await logRejectedSetup({
              supabase,
              userId,
              symbol: pair,
              direction: analysis.direction as "long" | "short",
              rejectionType: "below_threshold_strong_t1",
              failedGates: [],
              confluenceScore: effectiveScore,
              tier1Count: analysis.tieredScoring?.tier1Count ?? 0,
              tier1Factors: analysis.factors?.filter((f: any) => f.present && f.tier === 1).map((f: any) => f.name) ?? [],
              entryPrice: analysis.lastPrice,
              stopLoss: analysis.stopLoss ?? undefined,
              takeProfit: analysis.takeProfit ?? undefined,
              rrRatio: analysis.stopLoss && analysis.takeProfit
                ? parseFloat((Math.abs(analysis.takeProfit - analysis.lastPrice) / Math.abs(analysis.lastPrice - analysis.stopLoss)).toFixed(2))
                : undefined,
              sessionName: analysis.session?.name,
              regime: (pairConfig as any)._gamePlanContext?.regime,
              gpBias: _rsPairPlan2?.bias,
              gpBiasConfidence: _rsPairPlan2?.biasConfidence,
              fotsiBaseTsi: _rsCurrencies2 && _fotsiResult ? _fotsiResult.strengths[_rsCurrencies2[0]] : undefined,
              fotsiQuoteTsi: _rsCurrencies2 && _fotsiResult ? _fotsiResult.strengths[_rsCurrencies2[1]] : undefined,
              priceAtRejection: analysis.lastPrice,
              rawDetail: {
                scanCycleId,
                gamePlanShadowAudit: (detail as any).gamePlanShadowAudit || null, streamlinedDecisionOrigin: (detail as any).streamlinedDecisionOrigin || null, streamlinedDecisionLatest: (detail as any).streamlinedDecisionLatest || null, singleOwnershipDecision: (detail as any).singleOwnershipDecision || null, singleOwnershipEnforcement: (detail as any).singleOwnershipEnforcement || null, legacyGateDiagnostics: (detail as any).legacyGateDiagnostics || [],
                thesisConviction: (detail as any).thesisConviction || null,
                directionVerdict: (detail as any).directionVerdict || null,
                impulseZone: (detail as any).impulseZone || null,
                decisionContext: (detail as any).decisionContext || null,
                stylePolicy: pairStylePolicy,
                canonicalDealingRangeObservation:
                  (detail as any).canonicalDealingRangeObservation || null,
              ...canonicalEvidenceSnapshot(detail),
                shadowEvaluation: {
                  baseScore: analysis.score,
                  effectiveScore,
                  threshold: conflictAdjustedMinConfluence,
                },
              },
            });
          } catch (rsErr: any) {
            console.warn(`[rejected-setup] Below-threshold logging error for ${pair}: ${rsErr?.message}`);
          }
        }
        // ── Setup Staging: Stage below-threshold setups that have potential ──
        if (stagingEnabled && analysis.direction && !isPaused
            && analysis.score >= watchThreshold
            && analysis.tieredScoring?.tier1Count >= 1) {
          // Has direction, score is in the watch zone, and at least 1 Tier 1 factor
          if (existingStaged) {
            // Update existing staged setup with new score and factors
            try {
              const presentFactors = analysis.factors.filter((f: any) => f.present).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
              const missingFactors = analysis.factors.filter((f: any) => !f.present && f.weight > 0).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
              const ts = analysis.tieredScoring;
              await supabase.from("staged_setups").update({
                current_score: analysis.score,
                current_factors: presentFactors,
                missing_factors: missingFactors,
                scan_cycles: existingStaged.scan_cycles + 1,
                last_eval_at: new Date().toISOString(),
                entry_price: analysis.lastPrice,
                sl_level: watchlistInvalidationFor(
                  analysis.direction as WatchlistDirection,
                  existingStaged.originating_zone,
                  existingStaged.sl_level ?? analysis.stopLoss,
                  existingStaged.analysis_snapshot?.impulseZone?.impulse,
                ).level,
                tp_level: analysis.takeProfit,
                tier1_count: ts?.tier1Count ?? 0,
                tier2_count: ts?.tier2Count ?? 0,
                tier3_count: ts?.tier3Count ?? 0,
              }).eq("id", existingStaged.id);
              console.log(`[staging] Updated ${pair} ${analysis.direction} — score ${analysis.score.toFixed(1)}% (cycle ${existingStaged.scan_cycles + 1})`);
            } catch (e: any) {
              console.warn(`[staging] Failed to update staged ${pair}: ${e?.message}`);
            }
            detail.status = "staged_watching";
            detail.reason = `Watching: ${analysis.score.toFixed(1)}% (need ${adjustedMinConfluence}%) — cycle ${existingStaged.scan_cycles + 1}`;
            detail.staging = {
              action: "watching",
              cycles: existingStaged.scan_cycles + 1,
              initialScore: parseFloat(existingStaged.initial_score),
              stagedAt: existingStaged.staged_at,
              ttlMinutes: existingStaged.ttl_minutes || stagingTTLMinutes,
            };
          } else {
            // Create new staged setup
            try {
              const presentFactors = analysis.factors.filter((f: any) => f.present).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
              const missingFactors = analysis.factors.filter((f: any) => !f.present && f.weight > 0).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
              const ts = analysis.tieredScoring;
              // Style-aware TTL: scalpers get shorter TTL, swing traders get longer
              const styleTTL = stagingTTLMinutes;
              const confluenceWatchOrigin = {
                type: setupClassification.setupType ||
                  "confluence_watch",
                entry: analysis.lastPrice,
                stopLoss: analysis.stopLoss,
                takeProfit: analysis.takeProfit,
                signalSource: (detail as any).signalSource || null,
              };
              await supabase.from("staged_setups").insert({
                user_id: userId,
                bot_id: BOT_ID,
                symbol: pair,
                direction: analysis.direction,
                initial_score: analysis.score,
                current_score: analysis.score,
                watch_threshold: watchThreshold,
                initial_factors: presentFactors,
                current_factors: presentFactors,
                missing_factors: missingFactors,
                entry_price: analysis.lastPrice,
                sl_level: watchlistInvalidationFor(
                  analysis.direction as WatchlistDirection,
                  confluenceWatchOrigin,
                  analysis.stopLoss,
                ).level,
                tp_level: analysis.takeProfit,
                ...stagedDecisionFields(confluenceWatchOrigin),
                scan_cycles: 1,
                min_cycles: minStagingCycles,
                ttl_minutes: styleTTL,
                setup_type: setupClassification.setupType,
                tier1_count: ts?.tier1Count ?? 0,
                tier2_count: ts?.tier2Count ?? 0,
                tier3_count: ts?.tier3Count ?? 0,
                analysis_snapshot: {
                  score: analysis.score,
                  direction: analysis.direction,
                  trend: analysis.structure.trend,
                  zone: analysis.pd.currentZone,
                  zonePercent: analysis.pd.zonePercent,
                  session: analysis.session.name,
                  factors: presentFactors,
                  missingFactors,
                  tieredScoring: ts ? { tier1Count: ts.tier1Count, tier2Count: ts.tier2Count, tier3Count: ts.tier3Count } : null,
                },
              });
              stagedNew++;
              console.log(`[staging] NEW ${pair} ${analysis.direction} — score ${analysis.score.toFixed(1)}% (watch threshold: ${watchThreshold}%, gate: ${adjustedMinConfluence}%)`);
            } catch (e: any) {
              // Unique constraint violation = already watching this pair+direction
              if (e?.message?.includes("unique") || e?.message?.includes("duplicate")) {
                console.log(`[staging] ${pair} ${analysis.direction} already staged — skipping duplicate`);
              } else {
                console.warn(`[staging] Failed to stage ${pair}: ${e?.message}`);
              }
            }
            detail.status = "staged_new";
            detail.reason = `New watch: ${analysis.score.toFixed(1)}% (need ${adjustedMinConfluence}%)`;
            detail.staging = {
              action: "new",
              watchThreshold,
              ttlMinutes: stagingTTLMinutes,
            };
          }
        } else {
          detail.status = "below_threshold";
          const ts = analysis.tieredScoring;
          const tierInfo = ts ? ` (T1:${ts.tier1Count}/4, T2:${ts.tier2Count}/5)` : "";
          detail.reason = `Score ${analysis.score.toFixed(1)}% < ${adjustedMinConfluence}% threshold${tierInfo}`;
          // A score drop is fresh-scan evidence, not structural invalidation of
          // the frozen zone thesis. Keep the candidate watching until its
          // boundary or TTL resolves it.
          if (existingStaged && analysis.score < watchThreshold && stagingEnabled) {
            try {
              await supabase.from("staged_setups").update({
                current_score: analysis.score,
                current_factors: analysis.factors
                  .filter((factor: any) => factor.present)
                  .map((factor: any) => ({
                    name: factor.name,
                    weight: factor.weight,
                    tier: factor.tier,
                  })),
                scan_cycles: existingStaged.scan_cycles + 1,
                last_eval_at: new Date().toISOString(),
                lifecycle_reason:
                  `Frozen candidate retained: current scan ${analysis.score.toFixed(1)}% is below watch threshold ${watchThreshold}%`,
                lifecycle_reason_code:
                  "fresh_score_below_watch_threshold_retained",
                lifecycle_evidence: buildWatchlistLifecycleEvidence({
                  reasonCode:
                    "fresh_score_below_watch_threshold_retained",
                  observedPrice: analysis.lastPrice,
                  frozenDirection:
                    existingStaged.direction as WatchlistDirection,
                  freshDirection:
                    analysis.direction as WatchlistDirection | null,
                  score: analysis.score,
                  threshold: watchThreshold,
                  detail: {
                    candidateId:
                      existingStaged.candidate_id || existingStaged.id,
                  },
                }),
              }).eq("id", existingStaged.id).eq("user_id", userId);
              console.log(
                `[staging] Retained frozen ${pair} ${existingStaged.direction} candidate despite score drop to ${analysis.score.toFixed(1)}%`,
              );
            } catch (e: any) {
              console.warn(
                `[staging] Failed to record score drop for frozen ${pair}: ${e?.message}`,
              );
            }
            detail.staging = {
              action: "retained",
              reason: "fresh_score_below_watch_threshold",
              frozenCandidateId:
                existingStaged.candidate_id || existingStaged.id,
            };
          }
        }
      } else {
        detail.status = isPaused ? "paused" : "no_direction";
      }
    }
    // ── Final sync: ensure detail.tieredScoring/score reflect post-credit state for ALL paths ──
    // (The above-threshold path already syncs at line ~4271, but below-threshold/staged/no-direction
    //  paths skip that block. This catch-all ensures the dashboard always shows accurate data.)
    if (analysis.tieredScoring && detail.tieredScoring !== analysis.tieredScoring) {
      detail.tieredScoring = analysis.tieredScoring;
      detail.score = analysis.score;
    }

    scanDetails.push(detail);
  }

  if (rotationSelection) {
    const latestDetailByPair = new Map<string, any>();
    for (const detail of scanDetails) {
      if (detail?.pair && scanUniverse.includes(detail.pair)) latestDetailByPair.set(detail.pair, detail);
    }
    const rotationResults = discoveryScanUniverse.map((symbol) => ({
      symbol,
      outcome: classifyRotationOutcome(latestDetailByPair.get(symbol)),
    }));
    const updatedRotationState = updateRotatingImpulseState(
      rotationSelection.state,
      rotationResults,
    );
    try {
      await saveRotatingImpulseState(supabase, userId, BOT_ID, updatedRotationState);
    } catch (error: any) {
      console.warn(`[scan ${scanCycleId}] Impulse rotation state save failed (non-fatal): ${error?.message}`);
    }
  }

  await markScannerOperation(
    supabase,
    opts?.operationRunId,
    "pair_processing_completed",
    {
      status: "running",
      processed_pairs: scanOrder.length,
      pair_processing_completed_at: new Date().toISOString(),
      metadata: { processed_pairs: scanOrder.length },
    },
  );

  // Update counters — scope to this bot's account
  const counterUpdate = supabase.from("paper_accounts").update({
    scan_count: (account.scan_count || 0) + 1,
    signal_count: (account.signal_count || 0) + signalsFound,
    rejected_count: (account.rejected_count || 0) + rejectedCount,
  }).eq("user_id", userId);
  if (account.bot_id) counterUpdate.eq("bot_id", BOT_ID);
  await counterUpdate;

  // End source tally and prepend a __meta entry so the UI can display
  // which feed served this scan cycle.
  const sourceTally = endScanSourceTally();
  await publishCandleSourceAlerts(supabase, {
    userId,
    botId: BOT_ID,
    runId: opts?.operationRunId,
    issues: sourceTally.issues,
    metaapiAttempted: sourceTally.metaapiAttempted,
  });
  const throttleStats = resetThrottleStats();
  const cacheStats = scanCache.stats();
  console.log(`[scan ${scanCycleId}] Data cache: ${cacheStats.hits} hits, ${cacheStats.misses} fetches, ${cacheStats.errors} errors, ${cacheStats.seeded} seeded (${scanCache.size()} unique keys)`);

  // Persist freshly-fetched daily/weekly candles to kv_cache for next cycle
  if (freshlyFetchedCandles.length > 0) {
    await batchSetCachedCandles(supabase, freshlyFetchedCandles);
    console.log(`[scan ${scanCycleId}] Persistent candle cache: wrote ${freshlyFetchedCandles.length} entries to DB`);
  }

  scanCache.clear();
  _scanCandleSources.clear();
  // ── Phase 1: flush per-timeframe evidence in bounded, awaited chunks ──
  if (zoneEvidenceRows.length > 0) {
    // Retention annotations are derived only after the pair has completed. They
    // never feed the pair decision. Event-linked evidence (watchlist, pending
    // or filled trade) receives the longer raw-retention window.
    const detailsByEvidenceId = new Map(
      scanDetails
        .filter((item: any) => item?.timeframeEvidenceId)
        .map((item: any) => [item.timeframeEvidenceId, item]),
    );
    for (const evidenceRow of zoneEvidenceRows) {
      const linkedDetail: any = detailsByEvidenceId.get(evidenceRow.id);
      annotateEvidenceLifecycle(evidenceRow, linkedDetail);
    }
    const evidenceResult = await persistZoneTimeframeEvidence(
      supabase,
      zoneEvidenceRows,
      {
        onError: (err: any, chunkSize: number) =>
          console.warn(
            `[scan ${scanCycleId}] timeframe evidence chunk of ${chunkSize} failed`
            + ` (non-fatal): ${err?.message}`,
          ),
      },
    );
    console.log(
      `[scan ${scanCycleId}] timeframe evidence: wrote ${evidenceResult.written}`
      + ` rows, ${evidenceResult.failedChunks} failed chunks`,
    );
  }
  // ── Persist thesis conviction states to kv_cache ──
  if ((config as any).thesisConvictionEnabled && convictionStates.size > 0) {
    try {
      const savePromises: Promise<void>[] = [];
      for (const [_key, state] of convictionStates.entries()) {
        savePromises.push(saveConvictionState(supabase, userId, BOT_ID, state));
      }
      await Promise.allSettled(savePromises);
      console.log(`[conviction] Persisted ${convictionStates.size} conviction states to kv_cache`);
    } catch (e: any) {
      console.warn(`[conviction] Failed to persist conviction states: ${e?.message}`);
    }
  }
  // ── Rejection telemetry: classify each scanDetail so we can see why pairs died ──
  const rejectionSummary = (() => {
    const izSubReason = (r?: string): string => {
      if (!r) return "unknown";
      const s = r.toLowerCase();
      if (s.includes("no valid") && s.includes("impulse leg")) return "no_impulse_leg";
      if (s.includes("no pois") || s.includes("no fvgs/obs")) return "no_pois_in_impulse";
      if (s.includes("none align with key fib")) return "no_fib_alignment";
      if (s.includes("scored high enough") || s.includes("fibscore")) return "not_deep_enough";
      if (s.includes("no valid zone on any timeframe")) return "no_zone_either_tf";
      if (s.startsWith("no direction")) return "no_direction";
      if (s.startsWith("error")) return "engine_error";
      return "other";
    };
    const dirSubReason = (r?: string): string => {
      if (!r) return "unknown";
      const s = r.toLowerCase();
      if (s.includes("both") && s.includes("ranging")) return "daily_and_4h_ranging";
      if (s.includes("daily ranging") && s.includes("insufficient 4h")) return "daily_ranging_no_4h";
      if (s.includes("daily ranging") && s.includes("weak structure")) return "daily_ranging_4h_weak";
      if (s.includes("daily ranging")) return "daily_ranging";
      if (s.includes("4h choch against")) return "4h_choch_against";
      if (s.includes("1h choch against")) return "1h_choch_against";
      if (s.includes("insufficient daily")) return "insufficient_daily_candles";
      if (s.includes("1h not confirmed") || s.includes("no recent")) return "1h_unconfirmed";
      return "other";
    };
    const buckets: Record<string, number> = {};
    const izBreakdown: Record<string, number> = {};
    const dirBreakdown: Record<string, number> = {};
    const samples: Record<string, string[]> = {};
    const bump = (k: string, pair?: string) => {
      buckets[k] = (buckets[k] ?? 0) + 1;
      if (pair) {
        samples[k] = samples[k] ?? [];
        if (samples[k].length < 5) samples[k].push(pair);
      }
    };
    for (const d of scanDetails) {
      const status = (d as any)?.status as string | undefined;
      const pair = (d as any)?.pair as string | undefined;
      const iz = (d as any)?.impulseZone;
      const sd = (d as any)?.simpleDirection;
      if (!status) continue;
      bump(status, pair);
      if (status === "skipped_no_impulse_zone") {
        const sub = izSubReason(iz?.reason);
        izBreakdown[sub] = (izBreakdown[sub] ?? 0) + 1;
      } else if (status === "watching_zone") {
        izBreakdown["price_not_at_zone"] = (izBreakdown["price_not_at_zone"] ?? 0) + 1;
      } else if (status === "no_direction") {
        const sub = dirSubReason(sd?.reason);
        dirBreakdown[sub] = (dirBreakdown[sub] ?? 0) + 1;
      }
    }
    return {
      buckets,
      impulseZoneBreakdown: izBreakdown,
      directionBreakdown: dirBreakdown,
      samplePairs: samples,
      totalScanned: scanDetails.length,
    };
  })();
  console.log(`[scan ${scanCycleId}] rejection summary: ${JSON.stringify(rejectionSummary.buckets)} | IZ: ${JSON.stringify(rejectionSummary.impulseZoneBreakdown)} | Dir: ${JSON.stringify(rejectionSummary.directionBreakdown)}`);
  const detailsWithMeta = [
    {
      __meta: true,
      scanCycleId,
      candleSource: sourceTally.primary,
      sourceBreakdown: {
        metaapi: sourceTally.metaapi,
        oanda: sourceTally.oanda,
        twelvedata: sourceTally.twelvedata,
        polygon: sourceTally.polygon,
        none: sourceTally.none,
      },
      brokerConnected: !!_scanBrokerConn,
      managementActions: managementActions.filter(a => a.action !== "no_change"),
      rateLimitThrottles: throttleStats.throttleCount,
      // Non-zero unenforced means the shared credit budget failed open and we
      // are back to per-isolate limiting — the exact condition that produced
      // 371 credits/min while every isolate reported 0 throttles.
      creditBudget: {
        unenforced: throttleStats.unenforcedCount,
        rpcFailures: throttleStats.budgetRpcFailures,
        refused: throttleStats.budgetRefused,
      },
      fotsiStrengths: _fotsiResult?.strengths ?? null,  // Currency strength values for UI meter
      dataCache: { hits: cacheStats.hits, fetches: cacheStats.misses, errors: cacheStats.errors, seeded: cacheStats.seeded },
      impulseRotation: rotationSelection ? {
        enabled: true,
        slotCount: rotatingImpulseSlotCount,
        universeSize: fullInstrumentUniverse.length,
        selected: scanUniverse,
        discovery: discoveryScanUniverse,
        lifecycleDeepScan: Array.from(lifecycleDeepScanSymbols),
        lifecycleLightweightMonitored: executableWatchlist.length,
        sessionObservation: sessionRotationObservation,
      } : { enabled: false, universeSize: fullInstrumentUniverse.length },
      staging: stagingEnabled ? { enabled: true, watching: activeStagedSetups.length - stagedPromoted - stagedInvalidated, promoted: stagedPromoted, expired: stagedExpired, invalidated: stagedInvalidated, newlyStaged: stagedNew } : { enabled: false },
      pendingOrders: config.limitOrderEnabled ? { enabled: true, autoEnabled: false, active: (activePendingOrders?.length || 0) - pendingFilled - pendingExpired - pendingCancelled, filled: pendingFilled, expired: pendingExpired, cancelled: pendingCancelled, placed: pendingPlaced, awaitingConfirmation: pendingConfirmationHunting } : { enabled: false },
      rejectionSummary,
      activeStyle: resolvedStyle,  // Trading style used for this scan cycle
      stylePolicy: scanStylePolicy,
      runtimeConfigProvenance,
      criticalRuntimeSettings: runtimeConfigProvenance.criticalSettings,
    },
    ...scanDetails,
  ];
  console.log(`[scan ${scanCycleId}] Primary candle source: ${sourceTally.primary} (meta=${sourceTally.metaapi}, td=${sourceTally.twelvedata}, polygon=${sourceTally.polygon}, none=${sourceTally.none}, throttles=${throttleStats.throttleCount}, budgetRefused=${throttleStats.budgetRefused}, budgetUnenforced=${throttleStats.unenforcedCount})`);

  // Log the scan
  // Retirements are fire-and-forget during the loop so a DB write never stalls a
  // pair; settle them before the cycle ends so the UI never shows a marking the
  // scanner has already discarded.
  if (manualImpulseRetirements.length > 0) {
    await Promise.allSettled(manualImpulseRetirements);
  }

  await supabase.from("scan_logs").insert({
    user_id: userId,
    bot_id: BOT_ID,
    pairs_scanned: scanOrder.length,
    signals_found: signalsFound,
    trades_placed: tradesPlaced,
    details_json: detailsWithMeta,
  });

  // Publish exact candle inputs only after the completed scan log exists.
  if (candleSnapshotRows.length > 0) {
    for (let i = 0; i < candleSnapshotRows.length; i += 20) {
      const { error } = await supabase.from("scan_candle_snapshots").upsert(candleSnapshotRows.slice(i, i + 20), { onConflict: "user_id,bot_id,scan_cycle_id,symbol,timeframe", ignoreDuplicates: true });
      if (error) console.warn(`[scan ] candle snapshot chunk failed (non-fatal): `);
    }
  }

  await completeScannerOperation(supabase, opts?.operationRunId, "scan", {
    scan_cycle_id: scanCycleId,
    pairs_scanned: scanOrder.length,
    signals_found: signalsFound,
    trades_placed: tradesPlaced,
    rejected: rejectedCount,
    candle_source: sourceTally.primary,
  });

  return { pairsScanned: scanOrder.length, signalsFound, tradesPlaced, rejected: rejectedCount, details: scanDetails, activeStyle: resolvedStyle, resolvedMinConfluence: config.minConfluence, scanCycleId, managementActions: managementActions.filter(a => a.action !== "no_change"), staging: stagingEnabled ? { watching: activeStagedSetups.length - stagedPromoted - stagedInvalidated, promoted: stagedPromoted, expired: stagedExpired, invalidated: stagedInvalidated, newlyStaged: stagedNew } : null, pendingOrders: config.limitOrderEnabled ? { active: (activePendingOrders?.length || 0) - pendingFilled - pendingExpired - pendingCancelled, filled: pendingFilled, expired: pendingExpired, cancelled: pendingCancelled, placed: pendingPlaced, awaitingConfirmation: pendingConfirmationHunting } : null };
  } finally {
    // Always release the scan lock and clear the source tally, even on error.
    try { endScanSourceTally(); } catch { /* ignore */ }
    try { scanCache.clear(); } catch { /* ignore */ }
    // Release only the lease owned by this run. A stale/manual invocation cannot
    // clear another scan's healthy lock.
    if (scanLockToken) {
      await releaseScannerLock(supabase, {
        userId,
        botId: BOT_ID,
        token: scanLockToken,
      });
    }
  }
}

function respond(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
