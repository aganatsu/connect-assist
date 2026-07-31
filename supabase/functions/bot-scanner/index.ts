import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import {
  applyPairOverrides,
} from "../_shared/configMapper.ts";
import {
  buildFrozenRuntimeConfigSnapshot,
  loadEffectiveRuntimeConfig,
} from "../_shared/runtimeConfigStore.ts";
import { buildResolvedStylePolicy } from "../_shared/stylePolicy.ts";
import { shouldCreatePendingZoneOrder } from "../_shared/botConfigBehavior.ts";
import { evaluateGamePlanGate } from "../_shared/gamePlanGate.ts";
import {
  evaluateFinalTradeAuthorization,
  type DirectionVerdictForAuthorization,
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
import { fetchCandlesWithFallback, beginScanSourceTally, endScanSourceTally, resetThrottleStats, type BrokerConn } from "../_shared/candleSource.ts";
import {
  computeFOTSI, getCurrencyAlignment, checkOverboughtOversoldVeto,
  parsePairCurrencies, getFOTSIPairNames,
  type FOTSIResult, type Currency,
} from "../_shared/fotsi.ts";
import { getFOTSIWithCache, setCachedFOTSI } from "../_shared/fotsiCache.ts";
import { batchGetCachedCandles, batchSetCachedCandles } from "../_shared/candleCache.ts";
import {
  classifyInstrumentRegime,
  // Types
  type Candle, type SwingPoint, type OrderBlock,
  type LiquidityPool, type BreakerBlock, type UnicornSetup,
  type SMTResult, type AMDResult, type SilverBulletResult, type MacroWindowResult,
  type ReasoningFactor, type GateResult,
  // Constants
  SPECS, SUPPORTED_SYMBOLS, SMT_PAIRS, ASSET_PROFILES, getAssetProfile,
  FALLBACK_RATES, MIN_SL_PIPS, ATR_SL_FLOOR_MULTIPLIER,
  // Analysis functions
  calculateATR, calculateAnchoredVWAP,
  detectSwingPoints, analyzeMarketStructure,
  detectOrderBlocks, detectFVGs, detectLiquidityPools,
  detectDisplacement, tagDisplacementQuality,
  detectBreakerBlocks, detectUnicornSetups,
  detectJudasSwing, detectReversalCandle,
  calculatePDLevels,
  computeOpeningRange, calculateSLTP,
  // Position sizing & rate conversion
  calculatePositionSize, getQuoteToUSDRate,
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
  generateInstrumentGamePlan, buildSessionGamePlan,
  getCurrentSession, fetchNewsForGamePlan, enrichGamePlanWithNews,
  type SessionGamePlan, type InstrumentGamePlan, type SessionName,
} from "../_shared/gamePlan.ts";
import {
  applyGamePlanValidityWindow,
  buildGamePlanConfigSnapshot,
  enrichGamePlanWithDirectionalNews,
  evaluateGamePlanReuse,
  gamePlanToScanLogDetails,
  loadActiveGamePlan,
  persistActiveGamePlan,
} from "../_shared/gamePlanStore.ts";
import {
  classifySetupType, manageOpenPositions,
  type SetupClassification, type ManagementAction,
} from "../_shared/scannerManagement.ts";
import { resolveSymbol } from "../_shared/brokerSymbols.ts";
import { metaFetch, metaBaseUrl, META_REGIONS, regionCache } from "../_shared/metaApiClient.ts";
import {
  reconcileBrokerState, reconcilePartialClose,
  type ReconcilePosition, type BrokerConnection,
} from "../_shared/reconcileBrokerState.ts";
import {
  executeBrokerOrderWithLedger,
} from "../_shared/brokerExecutionLedger.ts";
import {
  buildFrozenSetupStrategyContext,
  buildSetupLifecycleEvidence,
  readFrozenSetupStrategyContext,
  resolvePendingConfirmationMethod,
  resolvePendingIndicatorMinimum,
  resolvePendingMaxConfirmationAttempts,
  resolvePendingStylePolicy,
  THESIS_VALIDATION_VERSION,
  transitionStagedSetup,
  validateFrozenSetupIdentity,
  type SetupLifecycleEvidence,
} from "../_shared/setupLifecycle.ts";
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
import { type HTFConfluenceData, type TFSlotLabels } from "../_shared/impulseZoneEngine.ts";
import { findUnifiedZone, type UnifiedZoneResult } from "../_shared/unifiedZoneEngine.ts";
import { persistZoneShadowObservations } from "../_shared/zoneShadowObservationStore.ts";
import { loadZoneLocalActivation } from "../_shared/zoneLocalActivationStore.ts";
import {
  evaluateZoneLocalEnforcement,
} from "../_shared/zoneLocalEnforcement.ts";
import { findCascadeZone, type CascadeResult } from "../_shared/cascadeZoneEngine.ts";
import { detectZoneConfirmation, isPriceInZone, isImpulseBroken, formatConfirmationSummary, DEFAULT_ZONE_CONFIRMATION_CONFIG, type ConfirmationSignal } from "../_shared/zoneConfirmation.ts";
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
import { validatePendingOrderThesis, type ThesisValidationResult } from "../_shared/thesisValidator.ts";
import { logRejectedSetup, shouldLogBelowThreshold, type RejectedSetupParams } from "../_shared/rejectedSetupLogger.ts";
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
import { checkMinRR } from "../_shared/gateMinRR.ts";
import { verifyCronOrUserCaller } from "../_shared/cronAuth.ts";
import {
  detectSession as sharedDetectSession,
  detectSilverBullet as sharedDetectSilverBullet,
  detectMacroWindow as sharedDetectMacroWindow,
  toNYTime as sharedToNYTime,
  isSessionEnabled,
  type SessionResult,
} from "../_shared/sessions.ts";

declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

// ─── Bot Identity ────────────────────────────────────────────────────
const BOT_ID = "smc";
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
// ─── ICT AMD Phase Detection (DST-aware, NY local time) ───────────
function detectAMDPhase(candles: Candle[]): AMDResult {
  if (candles.length < 5) return { phase: "unknown", bias: null, asianHigh: null, asianLow: null, sweptSide: null, detail: "Insufficient candles" };
  const nyHourOf = (c: Candle): number => {
    const utc = new Date(c.datetime.endsWith("Z") ? c.datetime : c.datetime + "Z");
    return toNYTime(utc).h;
  };
  const recent = candles.slice(-200);
  const asian  = recent.filter(c => { const h = nyHourOf(c); return h >= 20 || h < 2; });
  const london = recent.filter(c => { const h = nyHourOf(c); return h >= 2 && h < 9; });
  const nyCandles = recent.filter(c => { const h = nyHourOf(c); return h >= 9 && h < 16; });
  const asianHigh = asian.length > 0 ? Math.max(...asian.map(c => c.high)) : null;
  const asianLow  = asian.length > 0 ? Math.min(...asian.map(c => c.low))  : null;
  let sweptSide: "high" | "low" | null = null;
  let bias: "bullish" | "bearish" | null = null;
  if (asianHigh != null && asianLow != null && london.length > 0) {
    const lHigh = Math.max(...london.map(c => c.high));
    const lLow  = Math.min(...london.map(c => c.low));
    const lClose = london[london.length - 1].close;
    const tookHigh = lHigh > asianHigh;
    const tookLow  = lLow  < asianLow;
    if (tookHigh && !tookLow && lClose < asianHigh) { sweptSide = "high"; bias = "bearish"; }
    else if (tookLow && !tookHigh && lClose > asianLow) { sweptSide = "low"; bias = "bullish"; }
    else if (tookHigh && tookLow) {
      const tail = london.slice(-Math.max(1, Math.floor(london.length / 3)));
      const tailHigh = Math.max(...tail.map(c => c.high));
      const tailLow  = Math.min(...tail.map(c => c.low));
      if (tailHigh > asianHigh && tail[tail.length - 1].close < asianHigh) { sweptSide = "high"; bias = "bearish"; }
      else if (tailLow < asianLow && tail[tail.length - 1].close > asianLow) { sweptSide = "low"; bias = "bullish"; }
    }
  }
  const nowNY = toNYTime(new Date());
  const h = nowNY.h;
  let phase: AMDResult["phase"] = "unknown";
  if (h >= 20 || h < 2) phase = "accumulation";
  else if (h >= 2 && h < 9) phase = sweptSide ? "manipulation" : (asian.length > 0 ? "manipulation" : "accumulation");
  else if (h >= 9 && h < 16) {
    if (sweptSide && nyCandles.length > 0 && asianHigh != null && asianLow != null) {
      const nHigh = Math.max(...nyCandles.map(c => c.high));
      const nLow  = Math.min(...nyCandles.map(c => c.low));
      const expandedDown = sweptSide === "high" && nLow < asianLow;
      const expandedUp   = sweptSide === "low"  && nHigh > asianHigh;
      phase = (expandedDown || expandedUp) ? "distribution" : "manipulation";
    } else {
      phase = "distribution";
    }
  } else if (h >= 16 && h < 20) {
    phase = "distribution";
  }
  const detail = sweptSide
    ? `Asian range ${asianLow?.toFixed(5)}-${asianHigh?.toFixed(5)}, London swept ${sweptSide} → ${bias} bias, phase: ${phase}`
    : `Asian range ${asianLow?.toFixed(5)}-${asianHigh?.toFixed(5)}, no clear London sweep, phase: ${phase}`;
  return { phase, bias, asianHigh, asianLow, sweptSide, detail };
}

// ─── SMT Divergence (scanner-specific, uses local detectSwingPoints) ──
function detectSMTDivergence(symbol: string, candles: Candle[], correlatedCandles: Candle[]): SMTResult {
  const corrPair = SMT_PAIRS[symbol] || null;
  if (!corrPair) return { detected: false, type: null, correlatedPair: null, detail: "No SMT pair mapped" };
  if (candles.length < 30 || correlatedCandles.length < 30) {
    return { detected: false, type: null, correlatedPair: corrPair, detail: `Insufficient ${corrPair} data` };
  }
  const thisSwings = detectSwingPoints(candles, 3);
  const corrSwings = detectSwingPoints(correlatedCandles, 3);
  const thisHighs = thisSwings.filter(s => s.type === "high").slice(-3);
  const thisLows  = thisSwings.filter(s => s.type === "low").slice(-3);
  const corrHighs = corrSwings.filter(s => s.type === "high").slice(-3);
  const corrLows  = corrSwings.filter(s => s.type === "low").slice(-3);
  if (thisHighs.length < 2 || thisLows.length < 2 || corrHighs.length < 2 || corrLows.length < 2) {
    return { detected: false, type: null, correlatedPair: corrPair, detail: "Not enough swing points for SMT" };
  }
  const thisLatestLow = thisLows[thisLows.length - 1].price;
  const thisPriorLow  = thisLows[thisLows.length - 2].price;
  const corrLatestLow = corrLows[corrLows.length - 1].price;
  const corrPriorLow  = corrLows[corrLows.length - 2].price;
  if (thisLatestLow < thisPriorLow && corrLatestLow >= corrPriorLow) {
    return {
      detected: true, type: "bullish", correlatedPair: corrPair,
      detail: `${symbol} swing low ${thisLatestLow.toFixed(5)} < prior ${thisPriorLow.toFixed(5)}, but ${corrPair} held (${corrLatestLow.toFixed(5)} >= ${corrPriorLow.toFixed(5)}) — bullish SMT`,
    };
  }
  const thisLatestHigh = thisHighs[thisHighs.length - 1].price;
  const thisPriorHigh  = thisHighs[thisHighs.length - 2].price;
  const corrLatestHigh = corrHighs[corrHighs.length - 1].price;
  const corrPriorHigh  = corrHighs[corrHighs.length - 2].price;
  if (thisLatestHigh > thisPriorHigh && corrLatestHigh <= corrPriorHigh) {
    return {
      detected: true, type: "bearish", correlatedPair: corrPair,
      detail: `${symbol} swing high ${thisLatestHigh.toFixed(5)} > prior ${thisPriorHigh.toFixed(5)}, but ${corrPair} held (${corrLatestHigh.toFixed(5)} <= ${corrPriorHigh.toFixed(5)}) — bearish SMT`,
    };
  }
  return { detected: false, type: null, correlatedPair: corrPair, detail: `No swing-point SMT divergence vs ${corrPair}` };
}

// ─── Premium/Discount Zone Calculation ──────────────────────────────
function calculatePremiumDiscount(candles: Candle[]): { currentZone: string; zonePercent: number; oteZone: boolean } {
  if (candles.length < 10) return { currentZone: "equilibrium", zonePercent: 50, oteZone: false };
  const swings = detectSwingPoints(candles);
  const recentHighs = swings.filter(s => s.type === "high").slice(-5);
  const recentLows = swings.filter(s => s.type === "low").slice(-5);
  if (recentHighs.length === 0 || recentLows.length === 0) return { currentZone: "equilibrium", zonePercent: 50, oteZone: false };
  const swingHigh = Math.max(...recentHighs.map(s => s.price));
  const swingLow = Math.min(...recentLows.map(s => s.price));
  const range = swingHigh - swingLow;
  if (range === 0) return { currentZone: "equilibrium", zonePercent: 50, oteZone: false };
  const lastPrice = candles[candles.length - 1].close;
  const zonePercent = ((lastPrice - swingLow) / range) * 100;
  let currentZone = "equilibrium";
  if (zonePercent > 55) currentZone = "premium";
  else if (zonePercent < 45) currentZone = "discount";
  const oteZone = zonePercent >= 62 && zonePercent <= 79;
  return { currentZone, zonePercent, oteZone };
}

// ─── Fetch candles via shared multi-source helper ────────────────────
// Tries: MetaAPI (broker feed) → Twelve Data → Polygon.io
// Module-scoped reference set per-scan so the loop below can stay terse.
let _scanBrokerConn: BrokerConn | null = null;
async function fetchCandles(symbol: string, interval = "15m", _range = "5d"): Promise<Candle[]> {
  const result = await fetchCandlesWithFallback({
    symbol,
    interval,
    limit: 300,
    brokerConn: _scanBrokerConn,
    skipBroker: true,
  });
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
  supabase: any, userId: string, symbol: string, direction: string,
  analysis: any, config: any, account: any, openPositions: any[],
  dailyCandles: Candle[] | null,
  rateMap?: Record<string, number>,
  convictionCandles?: Candle[] | null,
  convictionTimeframeLabel = "entry",
  directionVerdict?: DirectionVerdictResult | null,
  propFirmActive?: boolean,
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

  // Gate 2: Premium/Discount zone filter
  {
    const pdZone = analysis.pd.currentZone;
    const pdPct = analysis.pd.zonePercent ?? 50;
    const curPrice = analysis.lastPrice;
    const fmtP = (p: number) => p > 10 ? p.toFixed(3) : p.toFixed(5);
    // Back-calculate swing high/low from zonePercent:
    // zonePercent = ((price - swingLow) / range) * 100
    // range = price / (pdPct/100) when pdPct > 0 (price - swingLow = range * pdPct/100 → range = (price - swingLow)/(pdPct/100))
    // swingLow = price - range*(pdPct/100), swingHigh = swingLow + range

    if (config.onlyBuyInDiscount && direction === "long" && pdZone === "premium") {
      gates.push({ passed: false, reason: `Buying in premium zone rejected — price ${fmtP(curPrice)} at ${pdPct.toFixed(1)}% of range (premium > 55%, need discount < 45% to buy)` });
    } else if (config.onlySellInPremium && direction === "short" && pdZone === "discount") {
      gates.push({ passed: false, reason: `Selling in discount zone rejected — price ${fmtP(curPrice)} at ${pdPct.toFixed(1)}% of range (discount < 45%, need premium > 55% to sell)` });
    } else {
      gates.push({ passed: true, reason: `P/D zone OK (${pdZone}, ${pdPct.toFixed(1)}%)` });
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

  // Gate 9: Min confluence (redundant but per spec)
  if (analysis.score < config.minConfluence) {
    gates.push({ passed: false, reason: `Score ${analysis.score} < ${config.minConfluence} threshold` });
  } else {
    gates.push({ passed: true, reason: `Score ${analysis.score} meets threshold` });
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

  // Gate 10: Min R:R (spread + commission adjusted) — shared implementation
  gates.push(checkMinRR({
    lastPrice: analysis.lastPrice,
    stopLoss: analysis.stopLoss,
    takeProfit: analysis.takeProfit,
    symbol,
    minRiskReward: config.minRiskReward,
    commissionPerLot: (config as any)._avgCommissionPerLot ?? 0,
    rateMap,
  }));

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
            const eventNames = (newsData.events || []).map((e: any) => e.name || e.title || "event").join(", ");
            gates.push({ passed: false, reason: `News filter: high-impact event within ${config.newsFilterPauseMinutes}min — ${eventNames}` });
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

  return gates;
}

// ─── Main Handler ───────────────────────────────────────────────────────────
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
      const { error: updateErr } = await adminClient.from("staged_setups").update({
        status: "invalidated",
        invalidation_reason: "Manually dismissed by user",
        resolved_at: new Date().toISOString(),
      }).eq("id", setupId).eq("user_id", userId);
      if (updateErr) return respond({ error: updateErr.message }, 500);
      return respond({ success: true });
    }

    // ── Pending Orders: Get all pending orders (active + resolved) ──
    if (action === "pending_orders") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const statusFilter = body.status || "all";
      let query = adminClient.from("pending_orders").select("*")
        .eq("user_id", userId).eq("bot_id", BOT_ID);
      if (statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }
      const { data } = await query.order("placed_at", { ascending: false }).limit(100);
      return respond(data || []);
    }

    // ── Pending Orders: Get only active pending orders ──
    if (action === "active_pending") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const { data } = await adminClient.from("pending_orders").select("*")
        .eq("user_id", userId).eq("bot_id", BOT_ID)
        .in("status", ["pending", "awaiting_confirmation"])
        .order("placed_at", { ascending: false });
      return respond(data || []);
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
        .in("status", ["pending", "awaiting_confirmation"]);
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
        const LOOP_INTERVAL_MS = 8_000; // 8 seconds between iterations
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
  const loadCurrentDecisionEvidence = async (
    symbol: string,
    authority = timeframeAuthority,
  ): Promise<StyleDecisionEvidence> => {
    const [bias, structure, setup] = await Promise.all([
      cachedFetch(
        symbol,
        authority.roles.bias,
        timeframeFetchRange(authority.roles.bias),
      ),
      cachedFetch(
        symbol,
        authority.roles.structure,
        timeframeFetchRange(authority.roles.structure),
      ),
      cachedFetch(
        symbol,
        authority.roles.setup,
        timeframeFetchRange(authority.roles.setup),
      ),
    ]);
    return buildStyleDecisionEvidence(
      authority,
      bindTimeframeCandles(
        authority,
        buildTimeframeCandleMap([
          { timeframe: authority.roles.bias, candles: bias },
          {
            timeframe: authority.roles.structure,
            candles: structure,
          },
          { timeframe: authority.roles.setup, candles: setup },
        ]),
      ),
      {
        h4ChochLookback: config.simpleDirectionH4ChochLookback,
        h1BosLookback: config.simpleDirectionH1BosLookback,
        confirmedTrendFibFactor: config.confirmedTrendFibFactor,
        confirmedTrendSwingLookback:
          config.confirmedTrendSwingLookback,
        useConfirmedTrend: config.useConfirmedTrend,
      },
    );
  };

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
  console.log(
    `[scan ${scanCycleId}] Zone-local requested=${config.zoneLocalEnforcementMode}`
      + ` activation=${zoneLocalActivation?.authorityStage || "missing"}`
      + ` runtimeEnforced=${zoneLocalActivation?.runtimeEnforced === true}`,
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
      .select("commission_per_lot, detected_commission_per_lot")
      .eq("user_id", userId).eq("is_active", true);
    if (commConns && commConns.length > 0) {
      let totalComm = 0;
      let count = 0;
      for (const c of commConns) {
        const userComm = parseFloat(c.commission_per_lot ?? "0");
        const detectedComm = parseFloat(c.detected_commission_per_lot ?? "0") * 2; // detected is per-side, double for round-trip
        const effective = userComm > 0 ? userComm : detectedComm;
        if (effective > 0) { totalComm += effective; count++; }
      }
      avgCommissionPerLot = count > 0 ? totalComm / count : 0;
      if (avgCommissionPerLot > 0) console.log(`[scan ${scanCycleId}] Avg commission: $${avgCommissionPerLot.toFixed(2)}/lot round-trip (from ${count} broker(s))`);
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
    // Fetch a minimal 1-day candle for each symbol — last close = current price
    await Promise.all(posSymbols.map(async (sym: string) => {
      try {
        const candles = await cachedFetch(sym, "15m", "5d");
        if (candles.length > 0) {
          livePriceMap[sym] = candles[candles.length - 1].close;
        }
      } catch {}
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
            const partialActions = activeActions.filter(a => a.action === "partial_tp_executed" || a.action === "partial_enabled");
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
              await reconcilePartialClose({
                supabase,
                positions: reconcilePositions,
                connections: liveConns as BrokerConnection[],
                partialActions: partialCloseActions,
              });
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
            const msg = `${emoji} <b>Trade Management</b>\n\n` +
              `<b>Symbol:</b> ${a.symbol}\n` +
              `<b>Action:</b> ${actionLabel}\n` +
              (a.newSL ? `<b>New SL:</b> ${fmtPx(a.newSL, a.symbol)}\n` : "") +
              (a.newTP ? `<b>New TP:</b> ${fmtPx(a.newTP, a.symbol)}\n` : "") +
              `<b>Reason:</b> ${a.reason}`;
            await Promise.all(telegramChatIds.map(async (chatId) => {
              try {
                await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-notify`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                  body: JSON.stringify({ chat_id: chatId, message: msg }),
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
          await supabase.from("staged_setups").update({
            status: "expired",
            invalidation_reason: `TTL expired (${s.ttl_minutes || stagingTTLMinutes}min)`,
            resolved_at: new Date().toISOString(),
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
  for (const s of activeStagedSetups) {
    stagedMap.set(`${s.symbol}:${s.direction}`, s);
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
    const rateFetches = await Promise.all(
      RATE_PAIRS.map(p => cachedFetch(p, "1d", "5d"))
    );
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

      let hitPrice: number | null = null;
      let closeReason: string | null = null;

      // SL breach: long price <= SL, short price >= SL
      if (sl > 0 && ((isLong && currentPrice <= sl) || (!isLong && currentPrice >= sl))) {
        hitPrice = sl;
        closeReason = "sl_hit";
      }
      // TP breach: long price >= TP, short price <= TP
      // SL takes priority if both are breached simultaneously (shouldn't happen, but defensive)
      if (!hitPrice && tp > 0 && ((isLong && currentPrice >= tp) || (!isLong && currentPrice <= tp))) {
        hitPrice = tp;
        closeReason = "tp_hit";
      }

      if (hitPrice && closeReason) {
        const entry = parseFloat(pos.entry_price);
        const size = parseFloat(pos.size);
        const diff = isLong ? hitPrice - entry : entry - hitPrice;
        const quoteToUSD = getQuoteToUSDRate(pos.symbol, rateMap);
        const pnl = diff * spec.lotUnits * size * quoteToUSD;
        const pnlPips = diff / spec.pipSize;
        const nowClose = new Date().toISOString();

        // 1. Delete from paper_positions
        await supabase.from("paper_positions").delete()
          .eq("position_id", pos.position_id).eq("user_id", userId);

        // 2. Insert into paper_trade_history (matches close-on-reverse field set)
        await supabase.from("paper_trade_history").insert({
          user_id: userId, position_id: pos.position_id, order_id: pos.order_id || "",
          symbol: pos.symbol, direction: pos.direction, size: pos.size,
          entry_price: pos.entry_price, exit_price: hitPrice.toString(),
          open_time: pos.open_time || nowClose, closed_at: nowClose,
          close_reason: closeReason,
          pnl: pnl.toFixed(2), pnl_pips: pnlPips.toFixed(1),
          signal_score: pos.signal_score || "0",
          signal_reason: pos.signal_reason || "",
          bot_id: BOT_ID,
          stop_loss: pos.stop_loss || null, take_profit: pos.take_profit || null,
        });

        // 3. Update paper_accounts balance + peak_balance (scoped to bot)
        const balQ = supabase.from("paper_accounts").select("balance, peak_balance").eq("user_id", userId);
        if (account.bot_id) balQ.eq("bot_id", BOT_ID);
        const curBal = parseFloat((await balQ.single()).data?.balance || "10000");
        const newBal = curBal + pnl;
        const newPeak = Math.max(newBal, parseFloat(account.peak_balance || "10000"));
        const balUpd = supabase.from("paper_accounts").update({
          balance: newBal.toFixed(2), peak_balance: newPeak.toFixed(2),
        }).eq("user_id", userId);
        if (account.bot_id) balUpd.eq("bot_id", BOT_ID);
        await balUpd;
        // Keep in-memory account in sync for subsequent position sizing
        account.balance = newBal.toFixed(2);
        account.peak_balance = newPeak.toFixed(2);

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

        // 5. Mirror close to broker if live mode + mirrored connections exist
        if (account.execution_mode === "live" && mirroredIds.length > 0) {
          const { data: closeConns } = await supabase.from("broker_connections")
            .select("*").eq("user_id", userId).in("broker_type", ["metaapi", "oanda"])
            .eq("is_active", true).in("id", mirroredIds);
          if (closeConns && closeConns.length > 0) {
            for (const conn of closeConns) {
              try {
                let authToken = conn.api_key;
                let metaAccountId = conn.account_id;
                if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
                  authToken = conn.account_id;
                  metaAccountId = conn.api_key;
                }
                const { res: posRes, body: posBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/positions`);
                if (!posRes.ok) { console.warn(`SL/TP close [${conn.display_name}]: positions fetch failed ${posRes.status}`); continue; }
                const brokerPositions: any[] = JSON.parse(posBody);
                const commentTag = `paper:${pos.position_id}`;
                const shortTag = commentTag.slice(0, 28);
                const brokerPos = brokerPositions.find((bp: any) =>
                  bp.comment && (bp.comment.includes(commentTag) || bp.comment.startsWith(shortTag))
                );
                if (!brokerPos) {
                  console.log(`SL/TP close [${conn.display_name}]: no matching comment-tagged position for paper:${pos.position_id} — skipping`);
                  continue;
                }
                const { res: closeRes } = await metaFetch(metaAccountId, authToken, (base) => `${base}/trade`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId: brokerPos.id }),
                });
                console.log(`SL/TP close [${conn.display_name}]: ${closeRes.ok ? "closed" : "failed " + closeRes.status} paper:${pos.position_id}`);
              } catch (brokerErr: any) {
                console.warn(`SL/TP close [${conn.display_name}] error: ${brokerErr?.message}`);
              }
            }
          }
        } else if (account.execution_mode === "live" && mirroredIds.length === 0) {
          console.log(`SL/TP close: paper:${pos.position_id} had no mirrored_connection_ids — skipping broker fan-out`);
        }

        // 6. Telegram notification
        if (telegramChatIds.length > 0 && shouldNotify("trade_closed")) {
          const emoji = closeReason === "tp_hit" ? "🎯" : "🛑";
          const label = closeReason === "tp_hit" ? "TAKE PROFIT HIT" : "STOP LOSS HIT";
          const pnlEmoji = pnl >= 0 ? "✅" : "❌";
          const msg = `${emoji} <b>${label}</b>\n\n` +
            `<b>Symbol:</b> ${pos.symbol} (${pos.direction.toUpperCase()})\n` +
            `<b>Entry:</b> ${pos.entry_price}\n` +
            `<b>Exit:</b> ${hitPrice}\n` +
            `<b>P&L:</b> ${pnlEmoji} $${pnl.toFixed(2)} (${pnlPips.toFixed(1)} pips)\n` +
            `<b>Size:</b> ${pos.size} lots`;
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
  ): { price: number; zoneType: string; zoneLow: number; zoneHigh: number } | null {
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
    return { price: best.price, zoneType: best.zoneType, zoneLow: best.low, zoneHigh: best.high };
  }

  // ── Thesis Validation: Load the dedicated active Gameplan version ──
  // This runs BEFORE the game plan generation section (which is after management-only return).
  // All later consumers reuse this exact version instead of searching scan_logs.
  let _lastGamePlanForValidation: SessionGamePlan | null = null;
  let _activeDirectionVerdicts = new Map<
    string,
    DirectionVerdictDecision
  >();
  if ((config as any).gamePlanEnabled !== false) {
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

  const latestDirectionVerdictFor = (symbol: string): DirectionVerdictForAuthorization | null => {
    const verdict = _activeDirectionVerdicts.get(symbol) || null;
    if (
      verdict &&
      (config as any).gamePlanEnabled !== false &&
      !directionVerdictMatchesGamePlan(
        verdict,
        _lastGamePlanForValidation,
        symbol,
      )
    ) {
      console.warn(
        `[scan ${scanCycleId}] ${symbol}: active Direction Verdict references a different Gameplan version`,
      );
      return null;
    }
    return verdict;
  };

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
        const pendingPolicyResolution = resolvePendingStylePolicy(
          pending,
          scanStylePolicy,
        );
        const pendingTimeframeAuthority = resolveTimeframeAuthority(
          pendingPolicyResolution.policy,
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
        const pendingConfirmationLabel =
          pendingConfirmationMethod === "indicators"
            ? "indicator consensus"
            : pendingConfirmationMethod === "choch_and_indicators"
            ? "CHoCH + indicator consensus"
            : "CHoCH/BOS";

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
        const lastCandle = pendingCandles[pendingCandles.length - 1];

        // Update current price on the pending order
        await supabase.from("pending_orders").update({ current_price: currentPrice }).eq("order_id", pending.order_id).eq("user_id", userId);

        const entryPrice = parseFloat(pending.entry_price);
        const slLevel = parseFloat(pending.stop_loss);

        // Check SL invalidation: if price has blown past the SL, cancel the order
        if (pending.direction === "long" && currentPrice < slLevel) {
          await supabase.from("pending_orders").update({
            status: "invalidated",
            cancel_reason: `Price ${currentPrice} breached SL ${slLevel}`,
            resolved_at: new Date().toISOString(),
          }).eq("order_id", pending.order_id).eq("user_id", userId);
          pendingCancelled++;
          console.log(`[pending] Cancelled ${pending.symbol} long — price ${currentPrice} below SL ${slLevel}`);
          continue;
        }
        if (pending.direction === "short" && currentPrice > slLevel) {
          await supabase.from("pending_orders").update({
            status: "invalidated",
            cancel_reason: `Price ${currentPrice} breached SL ${slLevel}`,
            resolved_at: new Date().toISOString(),
          }).eq("order_id", pending.order_id).eq("user_id", userId);
          pendingCancelled++;
          console.log(`[pending] Cancelled ${pending.symbol} short — price ${currentPrice} above SL ${slLevel}`);
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
            const pendingDecisionEvidence =
              await loadCurrentDecisionEvidence(
                pending.symbol,
                pendingTimeframeAuthority,
              );
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
                decisionEvidence: pendingDecisionEvidence,
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
                const msg = `⚠️ <b>Thesis Invalidated — Order Cancelled</b>\n\n` +
                  `<b>Symbol:</b> ${pending.symbol}\n` +
                  `<b>Direction:</b> ${pending.direction.toUpperCase()}\n` +
                  `<b>Check:</b> ${thesisResult.checkType}\n` +
                  `<b>Reason:</b> ${thesisResult.reason}`;
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
          const filled = pending.direction === "long"
            ? lastCandle.low <= entryPrice
            : lastCandle.high >= entryPrice;

          if (filled) {
            // Price touched the zone! Transition to confirmation hunting mode.
            const nowStr = new Date().toISOString();
            await supabase.from("pending_orders").update({
              status: "awaiting_confirmation",
              zone_touch_time: nowStr,
              confirmation_attempts: 0,
            }).eq("order_id", pending.order_id).eq("user_id", userId);
            pendingConfirmationHunting++;
            console.log(`[pending] ${pending.symbol} ${pending.direction} — ZONE TOUCHED @ ${entryPrice}, entering confirmation hunt mode (${pendingConfirmationLabel})`);

            // Send Telegram notification: zone touched, hunting confirmation
            if (telegramChatIds.length > 0 && shouldNotify("zone_touched")) {
              const emoji = pending.direction === "long" ? "🟡" : "🟡";
              const msg = `${emoji} <b>Zone Touched — Hunting Confirmation</b>\n\n` +
                `<b>Symbol:</b> ${pending.symbol}\n` +
                `<b>Direction:</b> ${pending.direction.toUpperCase()}\n` +
                `<b>Zone:</b> ${pending.entry_zone_type} [${parseFloat(pending.entry_zone_low || "0").toFixed(5)} - ${parseFloat(pending.entry_zone_high || "0").toFixed(5)}]\n` +
                `<b>Waiting for:</b> ${pending.direction === "short" ? "Bearish" : "Bullish"} ${pendingConfirmationLabel}\n` +
                `<b>Entry Level:</b> ${entryPrice}`;
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
          // Price hasn't touched zone yet — nothing to do, keep waiting
          continue;
        }

        // ── Branch B: Order is awaiting its frozen confirmation contract ──
        if (pending.status === "awaiting_confirmation") {
          pendingConfirmationHunting++;
          await supabase.from("pending_orders").update({
            last_confirmation_checked_at: new Date().toISOString(),
          }).eq("order_id", pending.order_id).eq("user_id", userId)
            .eq("status", "awaiting_confirmation");

          // Check if impulse is broken (zone invalidation)
          if (impulseData && isImpulseBroken(currentPrice, impulseData.high, impulseData.low, pending.direction as "long" | "short")) {
            await supabase.from("pending_orders").update({
              status: "invalidated",
              cancel_reason: `Impulse broken — price ${currentPrice} exceeded origin (high: ${impulseData.high}, low: ${impulseData.low})`,
              resolved_at: new Date().toISOString(),
            }).eq("order_id", pending.order_id).eq("user_id", userId);
            pendingCancelled++;
            console.log(`[pending] Cancelled ${pending.symbol} ${pending.direction} — impulse broken at ${currentPrice}`);
            continue;
          }

          // Check if price left the zone (use refined zone bounds when available)
          const rawRefLow = parseFloat(pending.refined_zone_low || "0");
          const rawRefHigh = parseFloat(pending.refined_zone_high || "0");
          const hasRefZone = rawRefLow > 0 && rawRefHigh > 0;
          const zoneLow = hasRefZone ? rawRefLow : parseFloat(pending.entry_zone_low || "0");
          const zoneHigh = hasRefZone ? rawRefHigh : parseFloat(pending.entry_zone_high || "0");
          if (zoneLow > 0 && zoneHigh > 0 && !isPriceInZone(currentPrice, zoneLow, zoneHigh, pending.direction as "long" | "short")) {
            // Price left zone without confirming — reset to pending, wait for next approach
            const attempts = (pending.confirmation_attempts || 0) + 1;
            const maxAttempts = resolvePendingMaxConfirmationAttempts(
              pending,
              config,
            );
            if (attempts >= maxAttempts) {
              // Cap reached — cancel the order instead of retrying indefinitely
              await supabase.from("pending_orders").update({
                status: "cancelled",
                cancel_reason: `Max confirmation attempts reached (${attempts}/${maxAttempts})`,
                resolved_at: new Date().toISOString(),
              }).eq("order_id", pending.order_id).eq("user_id", userId);
              pendingCancelled++;
              pendingConfirmationHunting--;
              console.log(`[pending] ${pending.symbol} ${pending.direction} — CANCELLED: max confirmation attempts reached (${attempts}/${maxAttempts})`);
              continue;
            }
            await supabase.from("pending_orders").update({
              status: "pending",
              zone_touch_time: null,
              confirmation_attempts: attempts,
            }).eq("order_id", pending.order_id).eq("user_id", userId);
            pendingConfirmationHunting--;
            console.log(`[pending] ${pending.symbol} ${pending.direction} — price left zone (${currentPrice}), reset to pending (attempt ${attempts}/${maxAttempts})`);
            continue;
          }

          // Use the exact confirmation timeframe frozen with this setup.
          const confirmationTimeframe =
            pendingTimeframeAuthority.roles.confirmation;
          const refinementTimeframe =
            pendingTimeframeAuthority.roles.refinement;
          const confirm5mCandles = await cachedFetch(
            pending.symbol,
            confirmationTimeframe,
            timeframeFetchRange(confirmationTimeframe),
          );
          if (confirm5mCandles.length < 10) {
            console.log(`[pending] ${pending.symbol} — insufficient ${confirmationTimeframe} candles for frozen confirmation (${confirm5mCandles.length})`);
            continue;
          }

          // Determine the candle index when zone was touched (approximate from zone_touch_time)
          let zoneTouchIdx: number | undefined;
          if (pending.zone_touch_time) {
            const touchTime = new Date(pending.zone_touch_time).getTime();
            for (let i = confirm5mCandles.length - 1; i >= 0; i--) {
              const candleTime = new Date(confirm5mCandles[i].datetime).getTime();
              if (candleTime <= touchTime) { zoneTouchIdx = i; break; }
            }
          }

                    // ── Confirmation Method Routing ──
          // Supports 3 modes: "choch" (default), "indicators", "choch_and_indicators"
          const confMethod = pendingConfirmationMethod;
          const confirmationIndicatorMinimum =
            resolvePendingIndicatorMinimum(pending, config);
          let confirmationSignal: ConfirmationSignal | null = null;
          let indicatorConfResult: { confirmed: boolean; summary: string; passedCount: number } | null = null;

          // Fetch the frozen refinement timeframe for lower-timeframe evidence.
          let confirm1mCandles: any[] = [];
          try {
            confirm1mCandles = await cachedFetch(
              pending.symbol,
              refinementTimeframe,
              timeframeFetchRange(refinementTimeframe),
            );
          } catch { /* non-critical: LTF path just won't fire */ }

          // Extract sweep data from signal_reason (stored at order placement time)
          let sweepEventForConfirmation: { level: number; type: string } | null = null;
          try {
            const sr = typeof pending.signal_reason === "string" ? JSON.parse(pending.signal_reason) : (pending.signal_reason || {});
            if (sr?.sweepReclaim?.bestReclaim?.sweptLevel) {
              sweepEventForConfirmation = {
                level: sr.sweepReclaim.bestReclaim.sweptLevel,
                type: sr.sweepReclaim.bestReclaim.type || "buy-side",
              };
            } else if (sr?.sweepReclaim?.sweeps?.[0]?.sweptLevel) {
              sweepEventForConfirmation = {
                level: sr.sweepReclaim.sweeps[0].sweptLevel,
                type: sr.sweepReclaim.sweeps[0].type || "buy-side",
              };
            }
          } catch { /* non-critical: sweep path just won't fire */ }

          // CHoCH path (default)
          if (confMethod === "choch" || confMethod === "choch_and_indicators") {
            confirmationSignal = detectZoneConfirmation(
              confirm5mCandles,
              pending.direction as "long" | "short",
              DEFAULT_ZONE_CONFIRMATION_CONFIG,
              zoneTouchIdx,
              pending.symbol,
              (zoneLow > 0 && zoneHigh > 0) ? { zoneHigh, zoneLow } : undefined,
              confirm1mCandles.length >= 15 ? confirm1mCandles : undefined,
              sweepEventForConfirmation,
            );
          }

          // Indicator path
          if (confMethod === "indicators" || confMethod === "choch_and_indicators") {
            indicatorConfResult = checkIndicatorConfirmation(
              confirm5mCandles,
              pending.direction as "long" | "short",
              { minIndicators: confirmationIndicatorMinimum },
            );
          }

          // Evaluate confirmation based on method
          let confirmationPassed = false;
          if (confMethod === "choch") {
            confirmationPassed = !!confirmationSignal;
          } else if (confMethod === "indicators") {
            confirmationPassed = !!indicatorConfResult?.confirmed;
          } else if (confMethod === "choch_and_indicators") {
            confirmationPassed = !!confirmationSignal && !!indicatorConfResult?.confirmed;
          }

          if (!confirmationPassed) {
            const chochStatus = confirmationSignal ? `CHoCH=T${confirmationSignal.tier}` : "CHoCH=none";
            const indStatus = indicatorConfResult ? `Indicators=${indicatorConfResult.passedCount}/4` : "";
            console.log(`[pending] ${pending.symbol} ${pending.direction} — awaiting confirmation [${confMethod}] (${chochStatus}${indStatus ? ", " + indStatus : ""})`);
            continue;
          }

          // For indicator-only mode, synthesize a confirmationSignal for downstream compatibility
          if (!confirmationSignal && indicatorConfResult?.confirmed) {
            confirmationSignal = {
              type: (pending.direction === "long" ? "bullish_choch" : "bearish_choch") as any,
              tier: 2,
              price: confirm5mCandles[confirm5mCandles.length - 1].close,
              candleIndex: confirm5mCandles.length - 1,
              displacement: 0.5,
              significance: undefined,
              closeBased: false,
              supportingSignals: ["indicator_confirmation", indicatorConfResult.summary],
            };
          }

          // ── Tier gate: require Tier 1 or 2 when no refined zone is available ──
          // Tier 1 (close-based CHoCH) and Tier 2 (wick CHoCH + supporting signal) are
          // both valid structural confirmations. Only block Tier 3 (reversal pattern without
          // any CHoCH) when there's no refined zone, as it lacks structural evidence.
          if (confMethod !== "indicators" && !hasRefZone && confirmationSignal && confirmationSignal.tier === 3) {
            console.log(`[pending] ${pending.symbol} ${pending.direction} — T${confirmationSignal.tier} signal rejected (no refined zone, Tier 1/2 required for non-CHoCH patterns)`);
            continue;
          }

          // ═══════════════════════════════════════════════════════════════
          // CONFIRMED! Enter the trade at live price.
          // ═══════════════════════════════════════════════════════════════
          // At this point confirmationSignal is guaranteed non-null (either from CHoCH or synthesized from indicators)
          const confirmedSignal = confirmationSignal!;
          console.log(`[pending] ${pending.symbol} ${pending.direction} — CONFIRMED! ${formatConfirmationSummary(confirmedSignal)}`);
          console.log(`[pending] Confirmation tier: ${confirmedSignal.tier}, type: ${confirmedSignal.type}`);

          // Confirmation is go/no-go — fill at current market price (already inside refined zone)
          const actualFillPrice = currentPrice;
          console.log(`[pending] CONFIRMED FILL ${pending.symbol} ${pending.direction} — confirmed @ refined zone, fill at ${actualFillPrice} (zone entry was ${entryPrice})`);


          const positionId = pending.order_id;
          const orderId = crypto.randomUUID().slice(0, 8);
          const nowStr = new Date().toISOString();
          const exitFlags = pending.exit_flags || {};

          let brokerEquity: number | undefined;
          if (account.execution_mode === "live" && _scanBrokerConn) {
            try {
              const { res, body } = await metaFetch(
                _scanBrokerConn.account_id,
                _scanBrokerConn.api_key,
                (base) => `${base}/account-information`,
              );
              if (res.ok) {
                const equityData = JSON.parse(body);
                const parsedEquity = Number(equityData.equity ?? equityData.balance);
                if (Number.isFinite(parsedEquity) && parsedEquity > 0) brokerEquity = parsedEquity;
              }
            } catch (e: any) {
              console.warn(`[pending] Broker equity unavailable for final authorization: ${e?.message}`);
            }
          }

          let pendingPropFirmResult: PropFirmGateResult | null = null;
          try {
            pendingPropFirmResult = await runPropFirmGate(
              supabase,
              userId,
              BOT_ID,
              balance,
              openPosArr,
              `${scanCycleId}-pending-${pending.id}`,
              {
                brokerEquity,
                isLiveAccount: account.execution_mode === "live",
                hasBrokerConnection: account.execution_mode === "live" && !!_scanBrokerConn,
                fxMarketClosed,
              },
            );
          } catch (e: any) {
            pendingPropFirmResult = {
              enabled: true,
              allowed: false,
              reason: `Prop-firm verification error: ${e?.message}`,
              maxPositionSizeMultiplier: 0,
              shouldCloseAll: false,
              compliance: null,
              configId: null,
            };
          }

          const { data: pendingConnections } = account.execution_mode === "live"
            ? await supabase.from("broker_connections")
              .select("*")
              .eq("user_id", userId)
              .in("broker_type", ["metaapi", "oanda"])
              .eq("is_active", true)
            : { data: [] as any[] };
          const spreadResults: Array<{ conn: any; result: Awaited<ReturnType<typeof fetchBrokerSpread>> }> = [];
          if (account.execution_mode === "live" && config.spreadFilterEnabled) {
            for (const conn of pendingConnections || []) {
              let metaAccountId: string | undefined;
              let authToken: string | undefined;
              if (conn.broker_type === "metaapi") {
                metaAccountId = conn.account_id;
                authToken = conn.api_key;
                if (metaAccountId?.startsWith("eyJ") && authToken && /^[0-9a-f-]{36}$/.test(authToken)) {
                  authToken = conn.account_id;
                  metaAccountId = conn.api_key;
                }
              }
              spreadResults.push({
                conn,
                result: await fetchBrokerSpread(conn, pending.symbol, config, metaAccountId, authToken),
              });
            }
          }
          const availableSpreads = spreadResults.filter((item) => !!item.result);
          const passingSpreads = spreadResults.filter((item) => item.result?.passed);
          const approvedPendingConnections = account.execution_mode === "live" && config.spreadFilterEnabled
            ? passingSpreads.map((item) => item.conn)
            : (pendingConnections || []);
          const bestSpread = availableSpreads
            .map((item) => item.result!)
            .sort((a, b) => a.spreadPips - b.spreadPips)[0];

          const pendingRuntimeGates = await buildFinalRuntimeGateStates({
            supabase,
            userId,
            accountExecutionMode: account.execution_mode,
            symbol: pending.symbol,
            direction: pending.direction as "long" | "short",
            currentPrice: actualFillPrice,
            candles: pendingCandles,
            interval: pendingTimeframeAuthority.runtimeEntry,
            openPositions: openPosArr,
            accountBalance: account.balance,
            config: {
              portfolioHeat: config.portfolioHeat,
              riskPerTrade: config.riskPerTrade,
              correlationFilterEnabled: config.correlationFilterEnabled,
              maxCorrelation: config.maxCorrelation,
              maxCorrelatedPositions: config.maxCorrelatedPositions,
              cooldownMinutes: config.cooldownMinutes,
              newsFilterEnabled: config.newsFilterEnabled,
              newsFilterPauseMinutes: config.newsFilterPauseMinutes,
              enabledSessions: config.enabledSessions,
              enabledDays: config.enabledDays,
              killZoneOnly: config.killZoneOnly,
            },
            rateMap,
          });
          const pendingDirectionVerdict = latestDirectionVerdictFor(
            pending.symbol,
          );
          const pendingEntryConfirmation: EntryConfirmationDecision = {
            required: true,
            passed: true,
            method: confMethod,
            reason:
              `Entry timing confirmed by ${confirmedSignal.type} (${confMethod})`,
            evidence: {
              type: confirmedSignal.type,
              tier: confirmedSignal.tier,
              price: confirmedSignal.price,
              displacement: confirmedSignal.displacement,
              supportingSignals: confirmedSignal.supportingSignals,
            },
            evaluatedAt: nowStr,
          };
          const rawFinalAuthorization = evaluateFinalTradeAuthorization({
            account,
            candidate: {
              symbol: pending.symbol,
              direction: pending.direction as "long" | "short",
              entryPrice: actualFillPrice,
              stopLoss: Number(pending.stop_loss),
              takeProfit: Number(pending.take_profit),
            },
            openPositions: openPosArr,
            maxOpenPositions: config.maxOpenPositions,
            maxPerSymbol: config.maxPerSymbol,
            allowSameDirectionStacking: config.allowSameDirectionStacking,
            maxDailyLoss: config.maxDailyLoss,
            maxDrawdown: config.maxDrawdown,
            minimumRiskReward: config.minRiskReward,
            directionVerdict: pendingDirectionVerdict,
            requireDirectionVerdict: true,
            gamePlan: _lastGamePlanForValidation,
            gamePlanEnabled: config.gamePlanEnabled,
            gamePlanMode: config.gpEnforcementMode,
            gamePlanMinimumConfidence: config.gpHardBlockThreshold,
            thesisResult: pendingThesisResult,
            requireThesisValidation: true,
            entryConfirmation: pendingEntryConfirmation,
            propFirm: pendingPropFirmResult
              ? {
                enabled: pendingPropFirmResult.enabled,
                allowed: pendingPropFirmResult.allowed,
                reason: pendingPropFirmResult.reason,
              }
              : null,
            requirePropFirmResult: true,
            spread: {
              required: account.execution_mode === "live" && config.spreadFilterEnabled,
              available: account.execution_mode !== "live" || !config.spreadFilterEnabled || availableSpreads.length > 0,
              passed: account.execution_mode !== "live" || !config.spreadFilterEnabled || passingSpreads.length > 0,
              spreadPips: bestSpread?.spreadPips,
              maximumPips: bestSpread?.effectiveMax,
            },
            runtimeGates: pendingRuntimeGates,
          });
          const pendingHierarchy = rawFinalAuthorization.decisionHierarchy ||
            evaluateDecisionHierarchy({
              symbol: pending.symbol,
              direction: pending.direction as "long" | "short",
              gamePlan: _lastGamePlanForValidation,
              gamePlanEnabled: config.gamePlanEnabled,
              gamePlanMode: config.gpEnforcementMode,
              gamePlanMinimumConfidence: config.gpHardBlockThreshold,
              directionVerdict: pendingDirectionVerdict,
              requireDirectionVerdict: true,
              thesisResult: pendingThesisResult,
              requireThesisValidation: true,
              entryConfirmation: pendingEntryConfirmation,
            });
          let parsedPendingEvidence: any = {};
          try {
            parsedPendingEvidence = typeof pending.signal_reason === "string"
              ? JSON.parse(pending.signal_reason)
              : (pending.signal_reason || {});
          } catch {
            parsedPendingEvidence = {};
          }
          const finalAuthorization = attachDecisionContext(
            rawFinalAuthorization,
            buildTradeDecisionContext({
              stage: "fill",
              symbol: pending.symbol,
              direction: pending.direction as "long" | "short",
              gamePlan: _lastGamePlanForValidation,
              directionVerdict: pendingDirectionVerdict,
              thesisResult: pendingThesisResult,
              requireThesisValidation: true,
              thesisConviction:
                parsedPendingEvidence?.decisionContext?.thesisConviction
                  ?.evidence ||
                parsedPendingEvidence?.thesisConviction ||
                null,
              entryConfirmation: pendingEntryConfirmation,
              hierarchy: pendingHierarchy,
              stylePolicy: pendingPolicyResolution.policy,
              evaluatedAt: nowStr,
            }),
          );
          if (!finalAuthorization.authorized) {
            const cancelPermanently = !finalAuthorization.retryable;
            await supabase.from("pending_orders").update({
              ...(cancelPermanently ? {
                status: "cancelled",
                cancel_reason: `[final-auth:${finalAuthorization.code}] ${finalAuthorization.reason}`,
                resolved_at: nowStr,
              } : {}),
              final_authorization: finalAuthorization,
            }).eq("id", pending.id).eq("user_id", userId);
            if (cancelPermanently) pendingCancelled++;
            console.warn(`[pending] FINAL AUTH BLOCKED ${pending.symbol}: ${finalAuthorization.code} — ${finalAuthorization.reason}`);
            continue;
          }

          // Build signal_reason with limit order provenance + confirmation data
          const parsedSignalReason = parsedPendingEvidence;
          const signalReason = {
            ...parsedSignalReason,
            filledFromLimitOrder: true,
            confirmationEntry: true,
            confirmationMethod: confMethod,
            indicatorMinCount: confirmationIndicatorMinimum,
            tpMethod: config.tpMethod || "rr_ratio",
            confirmation: {
              type: confirmedSignal.type,
              tier: confirmedSignal.tier,
              price: confirmedSignal.price,
              displacement: confirmedSignal.displacement,
              significance: confirmedSignal.significance,
              closeBased: confirmedSignal.closeBased,
              supportingSignals: confirmedSignal.supportingSignals,
              zoneTouchTime: pending.zone_touch_time,
              confirmationAttempts: pending.confirmation_attempts || 0,
              method: confMethod,
            },
            limitOrderOrigin: {
              orderType: pending.order_type,
              entryPrice,
              placedAt: pending.placed_at,
              filledAt: nowStr,
              zoneType: pending.entry_zone_type,
              zoneLow: parseFloat(pending.entry_zone_low || "0"),
              zoneHigh: parseFloat(pending.entry_zone_high || "0"),
              fromWatchlist: pending.from_watchlist,
              stagedCycles: pending.staged_cycles,
            },
            finalAuthorization,
            decisionContext: finalAuthorization.decisionContext,
          };

          const fillReason = `Confirmed ${confirmedSignal.type} @ ${actualFillPrice.toFixed(5)}`
            + ` (method: ${confMethod}, displacement: ${confirmedSignal.displacement.toFixed(2)},`
            + ` signals: ${confirmedSignal.supportingSignals.join(", ")})`;
          const { data: atomicFill, error: atomicFillError } = await supabase.rpc("finalize_pending_order_fill", {
            p_pending_id: pending.id,
            p_user_id: userId,
            p_bot_id: BOT_ID,
            p_fill_price: actualFillPrice,
            p_current_price: currentPrice,
            p_position_order_id: orderId,
            p_signal_reason: signalReason,
            p_fill_reason: fillReason,
            p_authorization: finalAuthorization,
            p_max_open_positions: config.maxOpenPositions,
            p_max_per_symbol: config.maxPerSymbol,
            p_allow_same_direction: config.allowSameDirectionStacking,
          });
          if (atomicFillError || !atomicFill?.filled) {
            console.warn(
              `[pending] Atomic fill declined ${pending.symbol}:`
              + ` ${atomicFillError?.message || atomicFill?.code || "unknown"}`,
            );
            continue;
          }

          await supabase.from("trade_reasonings").insert({
            user_id: userId,
            position_id: positionId,
            symbol: pending.symbol,
            direction: pending.direction,
            confluence_score: Math.round(parseFloat(pending.signal_score || "0")),
            summary: `[CONFIRMED ENTRY] ${pending.from_watchlist ? "[WATCHLIST] " : ""}${confirmedSignal.type} @ ${actualFillPrice.toFixed(5)} (zone: ${pending.entry_zone_type}, limit was ${entryPrice})`,
            bias: pending.direction === "long" ? "bullish" : "bearish",
            session: "confirmation_fill",
            timeframe: "5m",
          });

          pendingFilled++;
          tradesPlaced++;

          openPosArr.push({
            symbol: pending.symbol,
            size: pending.size.toString(),
            entry_price: actualFillPrice.toString(),
            stop_loss: pending.stop_loss.toString(),
            direction: pending.direction,
            position_id: positionId,
            position_status: "open",
            order_id: orderId,
            open_time: nowStr,
            signal_score: pending.signal_score?.toString() || "0",
          });

          // Send Telegram notification for confirmed entry
          if (telegramChatIds.length > 0 && shouldNotify("confirmed_entry")) {
            const emoji = pending.direction === "long" ? "🟢" : "🔴";
            const mode = account.execution_mode === "live" ? "LIVE" : "PAPER";
            const confTierLabel = confirmedSignal.tier ? ` T${confirmedSignal.tier}` : "";
            const confSupporting = Array.isArray(confirmedSignal.supportingSignals) && confirmedSignal.supportingSignals.length > 0
              ? `\n<b>Supporting:</b> ${confirmedSignal.supportingSignals.map((s: string) => s.replace(/_/g, " ")).join(", ")}`
              : "";
            const confAttempts = (pending.confirmation_attempts || 0) > 0
              ? ` | ${pending.confirmation_attempts} attempt${pending.confirmation_attempts > 1 ? "s" : ""}`
              : "";
            // Build specific confirmation method label
            const confMethodUsed = confMethod;
            const confMethodLabel = confMethodUsed === "choch" ? "CHoCH/BOS" : confMethodUsed === "indicators" ? "Indicator Consensus" : "CHoCH + Indicators";
            const confMethodDetail = confMethodUsed === "indicators"
              ? `\n<b>Mode:</b> ${confMethodLabel} (${confirmationIndicatorMinimum}/4 indicators required)`
              : confMethodUsed === "choch_and_indicators"
              ? `\n<b>Mode:</b> ${confMethodLabel} (CHoCH + ${confirmationIndicatorMinimum}/4 indicators)`
              : `\n<b>Mode:</b> ${confMethodLabel}`;
            // Build TP method label
            const tpMethodUsed = config.tpMethod || "rr_ratio";
            const tpMethodLabel = tpMethodUsed === "rr_ratio" ? `R:R (${config.tpRatio || 2.0}:1)` : tpMethodUsed === "next_level" ? "Next Structure Level" : tpMethodUsed === "fixed_pips" ? "Fixed Pips" : `ATR ×${config.tpATRMultiple || 2.0}`;
            const msg = `${emoji} <b>${mode} CONFIRMED Entry${confTierLabel}</b>\n\n` +
              `<b>Symbol:</b> ${pending.symbol}\n` +
              `<b>Direction:</b> ${pending.direction.toUpperCase()}\n` +
              `<b>Size:</b> ${pending.size} lots\n` +
              `<b>Entry:</b> ${fmtPx(actualFillPrice, pending.symbol)}\n` +
              `<b>SL:</b> ${fmtPx(pending.stop_loss, pending.symbol)}\n` +
              `<b>TP:</b> ${fmtPx(pending.take_profit, pending.symbol)} (${tpMethodLabel})\n` +
              `<b>Score:</b> ${pending.signal_score}\n\n` +
              `🎯 <b>Confirmation</b>` + confMethodDetail + `\n` +
              `<b>Signal:</b> ${confirmedSignal.type} (disp: ${confirmedSignal.displacement.toFixed(2)}×${confirmedSignal.significance ? ", " + confirmedSignal.significance : ""})${confAttempts}` +
              confSupporting + `\n` +
              `<b>Zone:</b> ${pending.entry_zone_type} [${fmtPx(pending.entry_zone_low || "0", pending.symbol)} – ${fmtPx(pending.entry_zone_high || "0", pending.symbol)}]` +
              (pending.from_watchlist ? `\n\n📋 <b>From Watchlist</b> (${pending.staged_cycles} cycles)` : "");
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

          // Mirror to brokers for limit order fills
          if (account.execution_mode === "live") {
            if (approvedPendingConnections.length > 0) {
              const mirroredConnIds: string[] = [];
              for (const conn of approvedPendingConnections) {
                try {
                  if (conn.broker_type !== "metaapi") {
                    const ledgerExecution = await executeBrokerOrderWithLedger(
                      supabase,
                      {
                        userId,
                        botId: BOT_ID,
                        positionId,
                        brokerConnectionId: conn.id,
                        route: "normal_pending",
                        requestPayload: {
                          symbol: pending.symbol,
                          direction: pending.direction,
                          size: parseFloat(pending.size),
                          stopLoss: parseFloat(pending.stop_loss),
                          takeProfit: parseFloat(pending.take_profit),
                        },
                      },
                      async () => {
                        const exRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/broker-execute`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                          body: JSON.stringify({ action: "place_order", connectionId: conn.id, symbol: pending.symbol, direction: pending.direction, size: parseFloat(pending.size), stopLoss: parseFloat(pending.stop_loss), takeProfit: parseFloat(pending.take_profit), positionId, userId }),
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
                    if (ledgerExecution.status === "succeeded") {
                      mirroredConnIds.push(conn.id);
                    } else {
                      console.warn(
                        `[pending] Broker execution ${ledgerExecution.status}`
                        + ` [${conn.display_name}]: ${ledgerExecution.error || "reconciliation required"}`,
                      );
                    }
                    continue;
                  }
                  let authToken = conn.api_key;
                  let metaAccountId = conn.account_id;
                  if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
                    authToken = conn.account_id;
                    metaAccountId = conn.api_key;
                  }
                  const brokerSymbol = resolveSymbol(pending.symbol, conn);
                  const mt5Body: any = {
                    actionType: pending.direction === "long" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
                    symbol: brokerSymbol,
                    volume: parseFloat(pending.size),
                    comment: `paper:${positionId}`,
                  };
                  if (pending.stop_loss) mt5Body.stopLoss = parseFloat(pending.stop_loss);
                  if (pending.take_profit) mt5Body.takeProfit = parseFloat(pending.take_profit);
                  const ledgerExecution = await executeBrokerOrderWithLedger(
                    supabase,
                    {
                      userId,
                      botId: BOT_ID,
                      positionId,
                      brokerConnectionId: conn.id,
                      route: "normal_pending",
                      requestPayload: {
                        symbol: pending.symbol,
                        brokerSymbol,
                        direction: pending.direction,
                        volume: parseFloat(pending.size),
                        stopLoss: pending.stop_loss ? parseFloat(pending.stop_loss) : null,
                        takeProfit: pending.take_profit ? parseFloat(pending.take_profit) : null,
                      },
                    },
                    async () => {
                      const { res: mt5Res, body: rawBody } = await metaFetch(
                        metaAccountId,
                        authToken,
                        (base: string) => `${base}/trade`,
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
                      };
                    },
                  );
                  if (ledgerExecution.status === "succeeded") {
                    mirroredConnIds.push(conn.id);
                  } else {
                    console.warn(
                      `[pending] Broker execution ${ledgerExecution.status}`
                      + ` [${conn.display_name}]: ${ledgerExecution.error || "reconciliation required"}`,
                    );
                  }
                } catch (e: any) { console.warn(`Limit fill broker mirror [${conn.display_name}] error: ${e?.message}`); }
              }
              if (mirroredConnIds.length > 0) {
                await supabase.from("paper_positions").update({ mirrored_connection_ids: mirroredConnIds }).eq("position_id", positionId).eq("user_id", userId);
              }
            }
          }
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
      { brokerEquity, isLiveAccount: isLiveMode, hasBrokerConnection: isLiveMode && !!_scanBrokerConn, fxMarketClosed },
    );

    if (propFirmGateResult.enabled) {
      propFirmSizeMultiplier = propFirmGateResult.maxPositionSizeMultiplier;

      // Emergency close-all
      if (propFirmGateResult.shouldCloseAll && openPosArr.length > 0) {
        console.log(`[prop-firm-gate] 🚨 EMERGENCY CLOSE-ALL triggered: ${propFirmGateResult.reason}`);
        const closedCount = await propFirmEmergencyClose(
          supabase, userId, BOT_ID, openPosArr, propFirmGateResult.reason, scanCycleId,
          { fxMarketClosed },
        );
        // Notify via Telegram
        if (telegramChatIds.length > 0 && shouldNotify("prop_firm_alert")) {
          const msg = `🚨 PROP FIRM EMERGENCY\n\n${propFirmGateResult.reason}\n\nClosed ${closedCount} position(s) to protect account.`;
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
          positions_closed: closedCount,
        };
        await supabase.from("scan_history").insert({ user_id: userId, bot_id: BOT_ID, payload: summaryPayload });
        return new Response(JSON.stringify({ ok: true, mode: "prop_firm_emergency", reason: propFirmGateResult.reason, positions_closed: closedCount }), { headers: { "Content-Type": "application/json" } });
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

  // ── PREMARKET GAME PLAN: Auto-generate session bias + DOL for each instrument ──
  // Runs ONCE per session (deduped). Uses HTF data (D1/4H).
  // Validity comes from the immutable resolved style policy.
  // ═══════════════════════════════════════════════════════════════════════════
  const gamePlanEnabled = (config as any).gamePlanEnabled !== false; // ON by default
  let activeGamePlan: SessionGamePlan | null = null;
  try {
    const currentSessionName = getCurrentSession();
    const gamePlanNotify = (config as any).gamePlanNotify !== false; // Telegram ON by default
    const gamePlanValidityMinutes = scanStylePolicy.lifecycle.gamePlanValidityMinutes;
    const ipdaRangesEnabled = (config as any).ipdaRangesEnabled !== false; // ON by default
    const dolTPExtensionEnabled = (config as any).dolTPExtensionEnabled !== false; // ON by default
    if (gamePlanEnabled) {
      const lastGP = _lastGamePlanForValidation;
      const lastGPTime = lastGP?.generatedAt
        ? new Date(lastGP.generatedAt).getTime()
        : 0;
      const hoursSinceLastGP = (Date.now() - lastGPTime) / (1000 * 60 * 60);
      const reuseDecision = evaluateGamePlanReuse(lastGP, {
        session: currentSessionName,
        style: scanStylePolicy.style,
      });

      console.log(`[scan ${scanCycleId}] Game Plan validity check: session=${currentSessionName}, style=${scanStylePolicy.style}, ageHours=${hoursSinceLastGP.toFixed(2)}, reusable=${reuseDecision.reusable}, validityMinutes=${gamePlanValidityMinutes}, expiresAt=${reuseDecision.expiresAt || "none"}, reason=${reuseDecision.reason}`);

      if (reuseDecision.reusable && lastGP) {
        // Reuse the immutable active version — don't regenerate or notify.
        activeGamePlan = lastGP;
        console.log(`[scan ${scanCycleId}] ✅ Game Plan: REUSING version ${lastGP.planVersion} for ${currentSessionName} (${hoursSinceLastGP.toFixed(1)}h old, expires ${reuseDecision.expiresAt}) — NO notification sent`);
      } else {
        console.log(`[scan ${scanCycleId}] Game Plan: will generate NEW plan — reason: ${reuseDecision.reason}`);
      }

      if (!activeGamePlan) {
      console.log(`[scan ${scanCycleId}] Game Plan: generating NEW plan for ${currentSessionName} session...`);
      const instrumentPlans: InstrumentGamePlan[] = [];
      // Fetch HTF data for each enabled instrument (batched to respect rate limits)
      const GP_BATCH_SIZE = 3;
      const GP_BATCH_DELAY = 1200;
      for (let i = 0; i < config.instruments.length; i += GP_BATCH_SIZE) {
        const batch = config.instruments.slice(i, i + GP_BATCH_SIZE);
        const batchPlans = await Promise.all(batch.map(async (sym: string) => {
          try {
            // Fetch legacy session/level datasets plus the exact structural
            // role candles required by the active style policy.
            const [
              gpDaily,
              gpH4,
              gpEntry,
              gpHourly,
              gpBias,
              gpStructure,
              gpSetup,
            ] = await Promise.all([
              cachedFetch(sym, "1d", "1y"),
              cachedFetch(sym, "4h", "1mo"),
              cachedFetch(sym, getEntryInterval(config.entryTimeframe), getEntryRange(config.entryTimeframe)),
              cachedFetch(sym, "1h", "5d"),
              cachedFetch(
                sym,
                timeframeAuthority.roles.bias,
                timeframeFetchRange(timeframeAuthority.roles.bias),
              ),
              cachedFetch(
                sym,
                timeframeAuthority.roles.structure,
                timeframeFetchRange(timeframeAuthority.roles.structure),
              ),
              cachedFetch(
                sym,
                timeframeAuthority.roles.setup,
                timeframeFetchRange(timeframeAuthority.roles.setup),
              ),
            ]);
            if (gpDaily.length < 10 || gpEntry.length < 10) return null;
            const decisionEvidence = buildStyleDecisionEvidence(
              timeframeAuthority,
              bindTimeframeCandles(
                timeframeAuthority,
                buildTimeframeCandleMap([
                  {
                    timeframe: timeframeAuthority.roles.bias,
                    candles: gpBias,
                  },
                  {
                    timeframe: timeframeAuthority.roles.structure,
                    candles: gpStructure,
                  },
                  {
                    timeframe: timeframeAuthority.roles.setup,
                    candles: gpSetup,
                  },
                  {
                    timeframe: getEntryInterval(config.entryTimeframe),
                    candles: gpEntry,
                  },
                ]),
              ),
              {
                h4ChochLookback: config.simpleDirectionH4ChochLookback,
                h1BosLookback: config.simpleDirectionH1BosLookback,
                confirmedTrendFibFactor: config.confirmedTrendFibFactor,
                confirmedTrendSwingLookback:
                  config.confirmedTrendSwingLookback,
                useConfirmedTrend: config.useConfirmedTrend,
              },
            );
            return generateInstrumentGamePlan(
              sym,
              gpDaily,
              gpH4,
              gpEntry,
              gpHourly,
              currentSessionName,
              {
                ipdaRangesEnabled,
                equalHighsLowsSensitivity:
                  config.equalHighsLowsSensitivity,
                liquidityPoolMinTouches: config.liquidityPoolMinTouches,
                decisionEvidence,
              },
            );
          } catch (e: any) {
            console.warn(`[game-plan] Error generating plan for ${sym}: ${e?.message}`);
            return null;
          }
        }));
        for (const plan of batchPlans) {
          if (plan) instrumentPlans.push(plan);
        }
        if (i + GP_BATCH_SIZE < config.instruments.length) await new Promise(r => setTimeout(r, GP_BATCH_DELAY));
      }
      const generatedGamePlanSymbols = new Set(
        instrumentPlans.map((plan) => plan.symbol),
      );
      const missingGamePlanSymbols = config.instruments.filter(
        (symbol: string) => !generatedGamePlanSymbols.has(symbol),
      );
      if (missingGamePlanSymbols.length === 0) {
        activeGamePlan = buildSessionGamePlan(currentSessionName, instrumentPlans);
        console.log(`[scan ${scanCycleId}] Game Plan: ${currentSessionName} — ${activeGamePlan.focusPairs.length} focus pairs: [${activeGamePlan.focusPairs.join(", ")}]`);
        for (const plan of instrumentPlans) {
          const emoji = plan.bias === "bullish" ? "🟢" : plan.bias === "bearish" ? "🔴" : "⚪";
          console.log(`[scan ${scanCycleId}] Game Plan ${emoji} ${plan.symbol}: ${plan.bias} (${plan.biasConfidence}%) | DOL: ${plan.dol?.description || "none"} | Regime: ${plan.regime} | Trade: ${plan.tradeable}`);
        }
        // Fetch economic calendar events and enrich game plan with news awareness
        try {
          const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
          const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
          const newsEvents = await fetchNewsForGamePlan(supabaseUrl, serviceRoleKey, config.instruments);
          if (newsEvents.length > 0) {
            activeGamePlan = enrichGamePlanWithNews(activeGamePlan, newsEvents);
            activeGamePlan = enrichGamePlanWithDirectionalNews(activeGamePlan);
            console.log(`[scan ${scanCycleId}] Game Plan: ${newsEvents.length} news events found (${newsEvents.filter(e => e.impact === "high").length} high-impact)`);
            console.log(`[scan ${scanCycleId}] News Impact: ${((activeGamePlan as any).newsImpacts || []).length} events analyzed`);
          } else {
            console.log(`[scan ${scanCycleId}] Game Plan: no relevant news events today`);
          }
        } catch (e: any) {
          console.warn(`[scan ${scanCycleId}] Game Plan: news fetch error (non-fatal): ${e?.message}`);
        }
        activeGamePlan = applyGamePlanValidityWindow(
          activeGamePlan,
          scanStylePolicy,
        );
        try {
          activeGamePlan = await persistActiveGamePlan(
            supabase,
            activeGamePlan,
            {
              userId,
              botId: BOT_ID,
              source: "automatic_scan",
              configSnapshot: buildGamePlanConfigSnapshot(
                config,
                scanStylePolicy,
                runtimeConfigProvenance,
              ),
              marketDataSnapshot: {
                hierarchy: ["Twelve Data", "Polygon"],
                scanCycleId,
              },
            },
          );
        } catch (storeError) {
          // Never let an unversioned in-memory plan become execution context.
          activeGamePlan = null;
          throw storeError;
        }
        _lastGamePlanForValidation = activeGamePlan;

        // Keep scan_logs as an observability event, never as active storage.
        await supabase.from("scan_logs").insert({
          user_id: userId,
          bot_id: BOT_ID,
          pairs_scanned: 0,
          signals_found: 0,
          trades_placed: 0,
          details_json: gamePlanToScanLogDetails(
            activeGamePlan,
            "automatic_scan",
          ),
        });
        // Send Telegram notification with game plan summary (only for NEW plans, respects gamePlanNotify toggle)
        if (gamePlanNotify && telegramChatIds.length > 0 && shouldNotify("game_plan") && activeGamePlan.summary) {
          await Promise.all(telegramChatIds.map(async (chatId: string) => {
            try {
              await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-notify`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                body: JSON.stringify({ chat_id: chatId, message: activeGamePlan!.summary }),
              });
            } catch (e: any) {
              console.warn(`[game-plan] Telegram send error [${chatId}]: ${e?.message}`);
            }
          }));
        } else if (!gamePlanNotify) {
          console.log(`[scan ${scanCycleId}] Game Plan: Telegram notifications disabled by config`);
        }
      } else {
        console.error(
          `[scan ${scanCycleId}] Game Plan: incomplete generation (${instrumentPlans.length}/${config.instruments.length}); missing [${missingGamePlanSymbols.join(", ")}]. Previous complete plan remains authoritative; partial plan was not activated.`,
        );
      }
      } // close if (!activeGamePlan) — new plan generation block
    }
  } catch (e: any) {
    console.warn(`[scan ${scanCycleId}] Game Plan generation error (non-fatal): ${e?.message}`);
  }

  // ── Phase 6: Focus Pair Priority ──
  // Reorder instruments so game-plan focus pairs are scanned first.
  // When max positions are limited, this gives focus pairs first shot at available slots.
  // Non-focus pairs are still scanned if capacity remains.
  let scanOrder = [...config.instruments];
  if (activeGamePlan && activeGamePlan.focusPairs && activeGamePlan.focusPairs.length > 0) {
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
    const coreSessionsEnabled = ["asian", "london", "newyork"].every(s => config.enabledSessions.includes(s));
    const offHoursImplicitlyAllowed = normalizedSession === "offhours" && coreSessionsEnabled;
    if (!pairAssetProfile.skipSessionGate && !isSessionEnabled(session, config.enabledSessions) && !offHoursImplicitlyAllowed) {
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
    const gpEnforcementMode = ((config as any).gpEnforcementMode ?? "hard") as "off" | "soft" | "hard";
    if (activeGamePlan && gpEnforcementMode !== "off") {
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
    const analysis = runConfluenceAnalysis(candles, dailyCandles.length >= 10 ? dailyCandles : null, pairConfig, hourlyCandles.length > 0 ? hourlyCandles : undefined);
    // S3 Fix: Attach the scan-cycle cached session to analysis for downstream use
    (analysis as any).cachedSession = cachedSession;

    // ── Setup Classifier: determine scalp/day/swing from the actual setup structure (informational only) ──
    const setupClassification = classifySetupType(analysis);

    const detail: any = {
      pair,
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
        gamePlanBias: gpCtx ? {
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
      // No verdict computed (error or missing data) — fall back to 15m as last resort
      effectiveDirection = analysis.direction;
      directionSource = "15m_fallback";
      console.log(`[scan ${scanCycleId}] ${pair} Direction: no verdict available, using 15m fallback=${effectiveDirection}`);
    }

    // ── DIRECTION SYNC: overwrite analysis.direction with verdict direction ──
    // This ensures ALL downstream code (SL/TP, pending orders, trade execution, broker)
    // uses the authoritative verdict direction, not the 15m confluenceScoring direction.
    if (effectiveDirection && effectiveDirection !== analysis.direction) {
      console.log(`[scan ${scanCycleId}] ${pair} Direction SYNC: analysis.direction ${analysis.direction} → ${effectiveDirection} (source: ${directionSource})`);
      analysis.direction = effectiveDirection;
    }

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

        const unifiedResult: UnifiedZoneResult = findUnifiedZone(
          zoneH1Candles,
          zoneH4Candles,
          zoneEntryCandles,
          unifiedDir as "bullish" | "bearish",
          analysis.lastPrice,
          combinedLiqPools,
          htfConfluenceData ?? undefined,
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
          zoneDailyCandles,
          zoneConfirmCandles,
          zoneLtfConfirmCandles,
          { requireLiquiditySweep: pairConfig.requireLiquiditySweep, sweptAbsorbedPenalty: pairConfig.sweptAbsorbedPenalty ?? 2.0 },
          zoneTFLabels,
        );

        // Store the full unified story for the frontend narrative panel
        (detail as any).unifiedZone = {
          hasZone: unifiedResult.hasZone,
          state: unifiedResult.state,
          selectedTF: unifiedResult.selectedTF,
          unifiedScore: unifiedResult.unifiedScore,
          scoreBreakdown: unifiedResult.scoreBreakdown,
          impulse: unifiedResult.impulse,
          zone: unifiedResult.zone,
          price: unifiedResult.price,
          liquidity: unifiedResult.liquidity ? {
            liquidityScore: unifiedResult.liquidity.liquidityScore,
            summary: unifiedResult.liquidity.summary,
            nearbyPools: unifiedResult.liquidity.nearbyPools.length,
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
            unifiedResult.liquidity?.entryTriggerState === "unswept",
          gatePolicy: {
            requireLiquiditySweep:
              pairConfig.requireLiquiditySweep === true,
          },
        };

        // Derive izData (detail.impulseZone) from the unified result's multiTFResult
        // for backward compatibility with the 58 downstream references to izData.*
        const multiTF = unifiedResult.multiTFResult;
        (detail as any).impulseZone = {
          hasZone: !!multiTF.bestZone,
          selectedTF: multiTF.selectedTF,
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
          })),
          h1HasZone: !!multiTF.h1Result.bestZone,
          h4HasZone: !!multiTF.h4Result?.bestZone,
          dailyHasZone: !!multiTF.dailyResult?.bestZone,
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
          });
          if (persisted > 0) {
            console.log(
              `[scan ${scanCycleId}] ${pair} stored ${persisted}`
              + ` observe-only zone-rank disagreement candidates`,
            );
          }
        } catch (shadowStoreErr: any) {
          console.warn(
            `[scan ${scanCycleId}] ${pair} zone shadow evidence unavailable`
            + ` (non-fatal): ${shadowStoreErr?.message}`,
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
    const selectedZoneLocalConfluence = () =>
      (detail as any).impulseZone?.bestZone?.localConfluence ?? null;
    const selectedZoneShadowRanking = () =>
      (detail as any).impulseZone?.bestZone?.shadowRanking ?? null;
    const selectedZoneLocalEnforcement = () =>
      (detail as any).zoneLocalEnforcement ?? null;
    const stagedDecisionFields = (
      originatingZone: Record<string, unknown> | null,
    ) => {
      const setupId = crypto.randomUUID();
      const candidateId = crypto.randomUUID();
      const pairPlan = activeGamePlan?.plans?.find(
        (plan: InstrumentGamePlan) => plan.symbol === pair,
      );
      const frozenStrategyContext = buildFrozenSetupStrategyContext({
        identity: { setupId, candidateId },
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
        originatingZone,
        confirmationMethod: pairConfig.confirmationMethod || "choch",
        indicatorMinCount: pairConfig.indicatorMinCount || 3,
      });
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
        },
        style_policy_version: pairStylePolicy.contractVersion,
        style_base_policy_hash: pairStylePolicy.basePolicyHash,
        style_policy_hash: pairStylePolicy.policyHash,
        style_policy: pairStylePolicy,
      };
    };
    const stagedKey = analysis.direction ? `${pair}:${analysis.direction}` : null;
    const existingStaged = stagedKey ? stagedMap.get(stagedKey) : null;
    // Also check for staged setups in the opposite direction that should be invalidated
    if (analysis.direction && stagingEnabled) {
      const oppositeDir = analysis.direction === "long" ? "short" : "long";
      const oppositeStaged = stagedMap.get(`${pair}:${oppositeDir}`);
      if (oppositeStaged) {
        // Direction flipped — invalidate the opposite staged setup
        try {
          await supabase.from("staged_setups").update({
            status: "invalidated",
            invalidation_reason: `Direction reversed to ${analysis.direction} (score ${analysis.score.toFixed(1)}%)`,
            resolved_at: new Date().toISOString(),
          }).eq("id", oppositeStaged.id);
          stagedInvalidated++;
          stagedMap.delete(`${pair}:${oppositeDir}`);
          console.log(`[staging] Invalidated ${pair} ${oppositeDir} — direction reversed to ${analysis.direction}`);
        } catch (e: any) {
          console.warn(`[staging] Failed to invalidate opposite staged ${pair} ${oppositeDir}: ${e?.message}`);
        }
      }
    }

    // SL invalidation check for existing staged setups
    if (existingStaged && existingStaged.sl_level && stagingEnabled) {
      const slLevel = parseFloat(existingStaged.sl_level);
      const slBreached = existingStaged.direction === "long"
        ? analysis.lastPrice < slLevel
        : analysis.lastPrice > slLevel;
      if (slBreached) {
        try {
          await supabase.from("staged_setups").update({
            status: "invalidated",
            invalidation_reason: `SL level breached (price ${analysis.lastPrice.toFixed(5)} vs SL ${slLevel.toFixed(5)})`,
            resolved_at: new Date().toISOString(),
          }).eq("id", existingStaged.id);
          stagedInvalidated++;
          stagedMap.delete(stagedKey!);
          console.log(`[staging] Invalidated ${pair} ${existingStaged.direction} — SL breached (${analysis.lastPrice.toFixed(5)} vs ${slLevel.toFixed(5)})`);
        } catch (e: any) {
          console.warn(`[staging] Failed to invalidate SL-breached ${pair}: ${e?.message}`);
        }
        detail.status = "staged_invalidated";
        detail.reason = `Staged setup invalidated — SL breached`;
        detail.staging = { action: "invalidated", reason: "sl_breached" };
        scanDetails.push(detail);
        continue;
      }
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

    const stageUnifiedWatch = async (
      executionEligible: boolean,
    ): Promise<"created" | "updated" | "handoff" | "failed"> => {
      if (!stagingEnabled || isPaused || !analysis.direction) return "failed";
      const isCascade = (detail as any).signalSource === "cascade";
      const unifiedZone = unifiedZoneData?.zone;
      const cascadeZone = cascadeResult?.entryZone?.poi;
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
        ? unifiedZoneData?.state === "waiting_for_sweep"
          ? "sweep_watch"
          : isCascade
          ? "cascade_zone_watch"
          : "unified_zone_watch"
        : "waiting_for_unified_zone";
      const observationReason = executionEligible
        ? null
        : "Directional candidate is visible for observation only; no valid unified zone exists";
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
            reason: executionEligible
              ? "Pre-zone observation resolved; complete zone requires a fresh execution candidate"
              : "Frozen execution zone is no longer valid; continuing as a new observe-only candidate",
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
      const styleTTL = resolvedStyle === "scalper"
        ? Math.min(stagingTTLMinutes, 120)
        : resolvedStyle === "swing_trader"
        ? Math.max(stagingTTLMinutes, 480)
        : stagingTTLMinutes;
      const decisionFields = stagedDecisionFields(originatingZone);
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
        sl_level: executionEligible ? stopLoss : null,
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
        : "waiting_for_unified_confirmation";
      detail.skipReason = unifiedZoneData?.state === "waiting_for_sweep"
        ? "Unified zone is complete but liquidity has not swept and rejected yet"
        : "Unified zone is complete but its entry trigger is not ready";
      if (watchResult === "failed") {
        detail.status = "unified_watch_insert_failed";
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
      if (!izData.bestZone?.priceAtZone) {
        // Zone exists but price is NOT at the zone — watchlist this pair (ready when price arrives)
        detail.status = "watching_zone";
        detail.skipReason = `Impulse Zone Gate (hard): price not at zone yet (distance: ${izData.bestZone?.distanceToZone?.toFixed(5) ?? "?"}). Watchlisted.`;
        console.log(`[scan ${scanCycleId}] ⏳ ${pair}: IMPULSE ZONE HARD GATE — zone exists, price not there yet. Distance: ${izData.bestZone?.distanceToZone?.toFixed(5)}. Adding to watchlist.`);
        // Stage this pair so it's ready when price arrives at the zone
        if (stagingEnabled && analysis.direction && !isPaused) {
          try {
            const existingStagedForZone = existingStaged;
            if (!existingStagedForZone) {
              const presentFactors = analysis.factors.filter((f: any) => f.present).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
              const missingFactors = analysis.factors.filter((f: any) => !f.present && f.weight > 0).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
              const ts = analysis.tieredScoring;
              const styleTTL = resolvedStyle === "scalper" ? Math.min(stagingTTLMinutes, 120)
                : resolvedStyle === "swing_trader" ? Math.max(stagingTTLMinutes, 480)
                : stagingTTLMinutes;
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
                entry_price: izData.bestZone.refinedEntry ?? ((izData.bestZone.high + izData.bestZone.low) / 2),
                sl_level: analysis.direction === "long" ? izData.impulse.low : izData.impulse.high,
                tp_level: analysis.takeProfit,
                ...stagedDecisionFields({
                  type: izData.bestZone.type || "impulse_zone",
                  low: izData.bestZone.low,
                  high: izData.bestZone.high,
                  entry: izData.bestZone.refinedEntry ??
                    ((izData.bestZone.high + izData.bestZone.low) / 2),
                  fibDepth: izData.bestZone.fibDepth || null,
                  selectedTimeframe: izData.selectedTF || null,
                }),
                scan_cycles: 1,
                min_cycles: 1,
                ttl_minutes: styleTTL,
                setup_type: "impulse_zone_watch",
                tier1_count: ts?.tier1Count ?? 0,
                tier2_count: ts?.tier2Count ?? 0,
                tier3_count: ts?.tier3Count ?? 0,
                analysis_snapshot: {
                  score: analysis.score,
                  direction: analysis.direction,
                  impulseZone: { zoneHigh: izData.bestZone.high, zoneLow: izData.bestZone.low, fibDepth: izData.bestZone.fibDepth, zoneScore: izData.bestZone.totalScore, refinedEntry: izData.bestZone.refinedEntry, impulse: izData.impulse },
                },
              });
              stagedNew++;
              console.log(`[staging] NEW ZONE WATCH ${pair} ${analysis.direction} — zone at ${izData.bestZone.low?.toFixed(5)}-${izData.bestZone.high?.toFixed(5)}, score ${analysis.score.toFixed(1)}%`);
            } else {
              // Update existing staged with latest zone data
              await supabase.from("staged_setups").update({
                current_score: analysis.score,
                scan_cycles: existingStagedForZone.scan_cycles + 1,
                last_eval_at: new Date().toISOString(),
                entry_price: izData.bestZone.refinedEntry ?? ((izData.bestZone.high + izData.bestZone.low) / 2),
                sl_level: analysis.direction === "long" ? izData.impulse.low : izData.impulse.high,
              }).eq("id", existingStagedForZone.id);
              console.log(`[staging] Updated ZONE WATCH ${pair} ${analysis.direction} — cycle ${existingStagedForZone.scan_cycles + 1}`);
            }
          } catch (e: any) {
            if (e?.message?.includes("unique") || e?.message?.includes("duplicate")) {
              console.log(`[staging] ${pair} ${analysis.direction} already staged for zone watch`);
            } else {
              console.warn(`[staging] Failed to stage zone watch ${pair}: ${e?.message}`);
            }
          }
          detail.staging = { action: "zone_watch", zoneDistance: izData.bestZone?.distanceToZone };
        }
        scanDetails.push(detail);
        continue;
      }
      // Price IS at zone — apply bonus and proceed
      impulseZonePenaltyVal = +(pairConfig.impulseZoneBonus ?? 1.0);
      console.log(`[scan ${scanCycleId}] ✅ ${pair}: Impulse Zone CONFIRMED — price at zone. Proceeding with entry evaluation.`);

      // ── Zone Score Gate: reject weak zones below minimum quality threshold ──
      const minZoneScore = pairConfig.minZoneScore ?? 4;
      if (izData.bestZone.totalScore < minZoneScore) {
        detail.status = "skipped_weak_zone";
        detail.skipReason = `Zone Score Gate: zone score ${izData.bestZone.totalScore.toFixed(1)}/9 < minimum ${minZoneScore} — low-conviction zone rejected`;
        console.log(`[scan ${scanCycleId}] ⛔ ${pair}: ZONE SCORE GATE — score ${izData.bestZone.totalScore.toFixed(1)}/9 < ${minZoneScore}. Skipping.`);
        scanDetails.push(detail);
        continue;
      }

      // ── Standalone Sweep Gate: block if unswept inducement detected ──────
      // When requireLiquiditySweep is ON and this is a standalone entry (unified
      // gate did NOT pass), check whether the unified zone engine detected nearby
      // liquidity pools that haven't been swept yet. If so, block the trade and
      // watchlist it — same behavior as the unified path's waiting_for_sweep state.
      if (pairConfig.requireLiquiditySweep && !unifiedGatePassed && unifiedZoneData?.liquidity) {
        const liq = unifiedZoneData.liquidity;
        const hasSweepEvent = liq.sweepEvent !== null;
        const sweepRejected = liq.sweepEvent?.rejected === true;
        // Block if: pools exist near zone AND (no sweep occurred OR sweep was absorbed)
        if (liq.nearbyPools > 0 && (!hasSweepEvent || !sweepRejected)) {
          detail.status = "waiting_for_sweep";
          detail.skipReason = `Standalone Sweep Gate: unswept inducement detected (${liq.summary || liq.nearbyPools + " pool(s)"}) — waiting for BSL/SSL sweep before entry`;
          console.log(`[scan ${scanCycleId}] ⏳ ${pair}: STANDALONE SWEEP GATE — ${liq.nearbyPools} unswept pool(s) near zone, blocking standalone entry. Watchlisted.`);
          // Stage as sweep_watch (same pattern as unified waiting_for_sweep)
          if (stagingEnabled && analysis.direction && !isPaused) {
            try {
              if (!existingStaged) {
                const presentFactors = analysis.factors.filter((f: any) => f.present).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
                const missingFactors = analysis.factors.filter((f: any) => !f.present && f.weight > 0).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
                const ts = analysis.tieredScoring;
                const styleTTL = resolvedStyle === "scalper" ? Math.min(stagingTTLMinutes, 120)
                  : resolvedStyle === "swing_trader" ? Math.max(stagingTTLMinutes, 480)
                  : stagingTTLMinutes;
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
                  sl_level: izData.bestZone?.sl ?? (analysis.direction === "long" ? analysis.lastPrice - 0.0050 : analysis.lastPrice + 0.0050),
                  tp_level: analysis.takeProfit,
                  ...stagedDecisionFields({
                    type: "standalone_sweep_watch",
                    low: izData.bestZone?.low || null,
                    high: izData.bestZone?.high || null,
                    entry: izData.bestZone?.entry ?? analysis.lastPrice,
                    nearbyPools: liq.nearbyPools,
                    liquiditySummary: liq.summary || null,
                  }),
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
                    source: "standalone_sweep_gate",
                    unifiedZone: unifiedZoneData ? { state: unifiedZoneData.state, score: unifiedZoneData.unifiedScore, selectedTF: unifiedZoneData.selectedTF } : null,
                    liquidity: { nearbyPools: liq.nearbyPools, summary: liq.summary, sweepEvent: liq.sweepEvent },
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
    const zoneLocalScoreAdj = zoneLocalDecision.scoreAdjustment;
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
      impulseZonePenaltyVal + zoneLocalScoreAdj + ictTotalAdj +
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
          gamePlanBias: gpCtx ? {
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
      effectiveScore >= conflictAdjustedMinConfluence &&
      analysis.direction &&
      !isPaused &&
      stagingEnabled
    ) {
      const cyclesMet = existingStaged.scan_cycles >= (existingStaged.min_cycles || minStagingCycles);
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
            promotion_reason: `Score reached ${analysis.score.toFixed(1)}% (gate: ${adjustedMinConfluence}%) after ${existingStaged.scan_cycles + 1} cycles`,
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
            sl_level: analysis.stopLoss,
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
          originatingZone:
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
          originatingZone,
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
      await transitionStagedSetup(supabase, {
        setupId: existingStaged.id,
        userId,
        status: "qualified",
        reason,
        evidence,
      });
    };

    const blockQualifiedSetup = async (
      evidence: ReturnType<typeof buildPromotedLifecycleEvidence>,
      reason: string,
    ) => {
      if (!evidence || !existingStaged) return;
      try {
        await transitionStagedSetup(supabase, {
          setupId: existingStaged.id,
          userId,
          status: "blocked_after_qualification",
          reason,
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
    if (conflictHardBlock) {
      // N+ opposing factors = hard block — too much disagreement to trade
      detail.status = "rejected";
      detail.rejectionReasons = [`Conflict counter BLOCKED: ${opposingCount} factors oppose ${analysis.direction} — too many conflicting signals (block at ${conflictBlockAt}+)`];
      detail.reason = `Conflict block: ${opposingCount} opposing factors`;
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }

    // ICT HTF hard gate: block trade if weekly bias or containment requirement fails (only in "hard" mode)
    if (ictHTFResult && !ictHTFResult.passed) {
      detail.status = "rejected";
      detail.rejectionReasons = [`ICT HTF BLOCKED: ${ictHTFResult.reason}`];
      detail.reason = ictHTFResult.reason;
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }
    // ICT Displacement MSS hard gate: block trade if MSS lacks displacement
    if (pairConfig.ictDisplacementMSSGateMode === "hard" && ictMSSResult && !ictMSSResult.isValid) {
      detail.status = "rejected";
      detail.rejectionReasons = [`ICT MSS BLOCKED: ${ictMSSResult.reason}`];
      detail.reason = ictMSSResult.reason;
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }
    // ICT Judas Swing hard gate: block trade if no liquidity sweep detected before MSS
    if (pairConfig.ictJudasSwingGateMode === "hard" && ictJudasResult && !ictJudasResult.found) {
      detail.status = "rejected";
      detail.rejectionReasons = [`ICT JUDAS BLOCKED: ${ictJudasResult.reason}`];
      detail.reason = ictJudasResult.reason;
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }
    // ICT FVG Invalidation hard gate: block trade if ALL FVGs are invalidated
    if (pairConfig.ictFVGInvalidationGateMode === "hard" && ictFVGResult && ictFVGResult.validCount === 0 && ictFVGResult.totalCount > 0) {
      detail.status = "rejected";
      detail.rejectionReasons = [`ICT FVG BLOCKED: All ${ictFVGResult.totalCount} FVGs invalidated/exhausted`];
      detail.reason = `All FVGs invalidated (${ictFVGResult.invalidatedCount} closed, ${ictFVGResult.exhaustedCount} exhausted)`;
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }
    // ICT Kill Zone hard gate: block trade if outside all kill zones
    if (pairConfig.ictKillZoneGateMode === "hard" && ictKZResult && !ictKZResult.isKillZone) {
      detail.status = "rejected";
      detail.rejectionReasons = [`ICT KZ BLOCKED: ${ictKZResult.reason}`];
      detail.reason = ictKZResult.reason;
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }
    // ICT Risk hard gate: block trade if risk limits exceeded
    if (pairConfig.ictRiskEnabled && ictRiskResult && !ictRiskResult.canTrade) {
      detail.status = "rejected";
      detail.rejectionReasons = [`ICT RISK BLOCKED: ${ictRiskResult.reasons.join("; ")}`];
      detail.reason = ictRiskResult.reasons.join("; ");
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }

    // Single percentage threshold gate (minFactorCount and minStrongFactors collapsed)
    if (effectiveScore >= conflictAdjustedMinConfluence && analysis.direction && !isPaused) {
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
      );
      // ── Game Plan + Direction Verdict Alignment Gate ──
      // analysis.direction has already been synchronized to the authoritative
      // Direction Verdict above. In hard mode, the active Game Plan authorizes
      // whether that final direction may proceed; missing, neutral, waiting,
      // low-confidence, and opposing plans all fail closed.
      if (gamePlanEnabled) {
        const gpThreshold = (config as any).gpHardBlockThreshold ?? 75;
        const gpGate = evaluateGamePlanGate(activeGamePlan, pair, analysis.direction, gpEnforcementMode, gpThreshold);
        gates.push({ passed: gpGate.passed, reason: gpGate.reason });
        console.log(
          `[scan ${scanCycleId}] ${gpGate.passed ? "ℹ️" : "❌"} ${pair}: GP gate ${gpGate.passed ? "passed" : "BLOCKED"}`
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
          if (newsAlignment.conflicting) {
            // Strong news conflict — block the trade
            gates.push({ passed: false, reason: `News conflict: ${newsAlignment.advisory}` });
            console.log(`[scan ${scanCycleId}] ❌ ${pair}: News strongly opposes ${analysis.direction} (${newsAlignment.pairBias} bias, ${newsAlignment.strength}% strength)`);
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

      const allPassed = gates.every(g => g.passed);
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

      if (allPassed && analysis.stopLoss && analysis.takeProfit) {
        // Adjust SL buffer for JPY pairs
        const spec = SPECS[pair] || SPECS["EUR/USD"];
        let sl = analysis.stopLoss;
        let tp = analysis.takeProfit;
        // ── computeTP: respects next_level TP from smcAnalysis when configured ──
        // When tpMethod="next_level", keeps the structure-based TP (PDH/PDL/PWH/PWL/liquidity)
        // unless the recalculated SL makes the R:R unacceptable (below minRiskReward).
        const computeTP = (entry: number, newSl: number, direction: string): number => {
          const risk = Math.abs(entry - newSl);
          if (config.tpMethod === "next_level" && analysis.takeProfit) {
            // Guard: TP from smcAnalysis was computed for the ORIGINAL direction.
            // If direction was flipped by directionVerdict, analysis.takeProfit may
            // sit on the wrong side of entry. Only reuse it if orientation matches.
            const tpOnCorrectSide = direction === "long"
              ? analysis.takeProfit > entry
              : analysis.takeProfit < entry;
            const structureRR = Math.abs(analysis.takeProfit - entry) / risk;
            if (tpOnCorrectSide && structureRR >= (config.minRiskReward ?? 1.0)) {
              return analysis.takeProfit;
            }
          }
          // ── Fib 3-Point Extension TP (SMC Enhancement) ──
          // Measures extensions from the ENTRY point (Point C), not from the swing origin.
          // Uses the first extension level that satisfies minRiskReward.
          if ((config.tpMethod as string) === "fib_extension_3pt" && smcEnhResult?.fibExtension) {
            const ext = smcEnhResult.fibExtension;
            // Try each extension level (ordered from nearest to farthest)
            for (const level of ext.levels) {
              const tpCandidate = level.price;
              const tpOnCorrectSide = direction === "long"
                ? tpCandidate > entry
                : tpCandidate < entry;
              if (!tpOnCorrectSide) continue;
              const extensionRR = Math.abs(tpCandidate - entry) / risk;
              if (extensionRR >= (config.minRiskReward ?? 1.0)) {
                return tpCandidate;
              }
            }
            // Fallback: no extension level satisfies R:R, use default ratio
          }
          return direction === "long" ? entry + risk * config.tpRatio : entry - risk * config.tpRatio;
        };

        // Recalculate SL with correct pip size for the (possibly flipped) direction.
        // If direction was flipped by directionVerdict, force a fresh SL/TP from
        // structure — analysis.stopLoss/takeProfit are for the ORIGINAL direction
        // and would produce an inverted trade if reused.
        const originalSlSide = analysis.stopLoss != null
          ? (analysis.stopLoss < analysis.lastPrice ? "long" : "short")
          : null;
        const directionFlipped = originalSlSide !== null && originalSlSide !== analysis.direction;
        if (analysis.direction === "long") {
          const swingLows = analysis.structure.swingPoints.filter((s: SwingPoint) => s.type === "low" && s.price < analysis.lastPrice).slice(-3);
          if (swingLows.length > 0) {
            sl = Math.max(...swingLows.map((s: SwingPoint) => s.price)) - adjustedSlBuffer * spec.pipSize;
            tp = computeTP(analysis.lastPrice, sl, "long");
          } else if (directionFlipped) {
            // No swings available AND direction was flipped — fall back to ATR/static floor
            // instead of leaving the inverted analysis.stopLoss in place.
            const fallbackPips = Math.max(MIN_SL_PIPS[pair] ?? 15, 20);
            sl = analysis.lastPrice - fallbackPips * spec.pipSize;
            tp = computeTP(analysis.lastPrice, sl, "long");
            console.log(`[${pair}] Direction flipped to LONG with no swing lows — using fallback SL ${fallbackPips}p`);
          }
        } else {
          const swingHighs = analysis.structure.swingPoints.filter((s: SwingPoint) => s.type === "high" && s.price > analysis.lastPrice).slice(-3);
          if (swingHighs.length > 0) {
            sl = Math.min(...swingHighs.map((s: SwingPoint) => s.price)) + adjustedSlBuffer * spec.pipSize;
            tp = computeTP(analysis.lastPrice, sl, "short");
          } else if (directionFlipped) {
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
            // Only override if impulse SL is wider than current SL (more protective)
            // and within reasonable bounds (not absurdly wide)
            const maxImpulseSlPips = (staticMinSlPips * (pairConfig.impulseSlCapMultiplier ?? 4)); // Configurable cap (default 4x)
            const impulseSlPips = impulseSlDistance / spec.pipSize;
            if (impulseSlDistance > actualSlDistance && impulseSlPips <= maxImpulseSlPips) {
              console.log(`[${pair}] Impulse Zone SL override: ${(Math.abs(analysis.lastPrice - sl) / spec.pipSize).toFixed(1)}p → ${impulseSlPips.toFixed(1)}p (impulse origin at ${impulseSL.toFixed(5)})`);
              sl = impulseSL;
              // Recalculate TP based on impulse SL for proper R:R
              tp = computeTP(analysis.lastPrice, sl, analysis.direction);
              detail.impulseZoneSLOverride = {
                originalSL: actualSlDistance / spec.pipSize,
                impulseSL: impulseSlPips,
                impulseOrigin: analysis.direction === "long" ? impulseData.low : impulseData.high,
              };
            } else if (impulseSlPips > maxImpulseSlPips) {
              console.log(`[${pair}] Impulse Zone SL too wide (${impulseSlPips.toFixed(1)}p > max ${maxImpulseSlPips}p). Keeping structure SL.`);
            } else if (impulseSlDistance <= actualSlDistance) {
              console.log(`[${pair}] ℹ️ Impulse Zone SL tighter than current (${impulseSlPips.toFixed(1)}p < ${(actualSlDistance / spec.pipSize).toFixed(1)}p). Keeping wider SL for safety.`);
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
          const maxUnifiedSlPips = staticMinSlPips * (pairConfig.impulseSlCapMultiplier ?? 4);
          if (unifiedSlPips >= effectiveMinSlPips && unifiedSlPips <= maxUnifiedSlPips) {
            console.log(`[${pair}] Unified Zone SL override: ${(Math.abs(analysis.lastPrice - sl) / spec.pipSize).toFixed(1)}p \u2192 ${unifiedSlPips.toFixed(1)}p (unified story [${unifiedZoneData.selectedTF}])`);
            sl = unifiedSL;
            // Recalculate TP based on unified SL for proper R:R
            tp = computeTP(analysis.lastPrice, sl, analysis.direction);
            (detail as any).unifiedZoneSLOverride = {
              originalSLPips: actualSlDistance / spec.pipSize,
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
          const maxCascadeSlPips = staticMinSlPips * (pairConfig.impulseSlCapMultiplier ?? 6);
          if (cascadeSlPips >= effectiveMinSlPips && cascadeSlPips <= maxCascadeSlPips) {
            console.log(`[${pair}] Cascade Zone SL override: ${(Math.abs(analysis.lastPrice - sl) / spec.pipSize).toFixed(1)}p \u2192 ${cascadeSlPips.toFixed(1)}p (cascade Daily\u21924H\u21921H)`);
            sl = cascadeSL;
            // Recalculate TP based on cascade SL for proper R:R
            tp = computeTP(analysis.lastPrice, sl, analysis.direction);
            (detail as any).cascadeZoneSLOverride = {
              originalSLPips: actualSlDistance / spec.pipSize,
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
          lots: sizingResult.lots,
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
        let limitEntry = zoneEngineWillOverride ? null : computeLimitEntryPrice(analysis, pair, analysis.direction);
        // ── Impulse Zone Entry Override ──
        // When hard gate is active and zone has a refined entry, use the zone's entry level
        // instead of the nearest OB/FVG from Tier 1. This ensures the limit order targets
        // the impulse zone's optimal entry (OTE level with S/R + LTF confirmation).
        if (izGateMode === "hard" && izData?.bestZone?.refinedEntry) {
          const zoneEntry = izData.bestZone.refinedEntry;
          const zoneLow = izData.bestZone.low;
          const zoneHigh = izData.bestZone.high;
          const zoneType = izData.bestZone.type?.toUpperCase() || "ZONE";
          limitEntry = { price: zoneEntry, zoneType: `IZ-${zoneType}`, zoneLow, zoneHigh };
          console.log(`[${pair}] Impulse Zone entry override: limit at ${zoneEntry.toFixed(5)} (${zoneType} zone)`);
        } else if (izGateMode === "hard" && izData?.bestZone && !limitEntry) {
          // Fallback: use zone midpoint if no refined entry available
          const zoneMid = (izData.bestZone.high + izData.bestZone.low) / 2;
          const zoneLow = izData.bestZone.low;
          const zoneHigh = izData.bestZone.high;
          const zoneType = izData.bestZone.type?.toUpperCase() || "ZONE";
          limitEntry = { price: zoneMid, zoneType: `IZ-${zoneType}`, zoneLow, zoneHigh };
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
          limitEntry = { price: unifiedEntry, zoneType, zoneLow, zoneHigh };
          console.log(`[${pair}] Unified Zone entry override: limit at ${unifiedEntry.toFixed(5)} (${unifiedZoneData.selectedTF} story, score ${unifiedZoneData.unifiedScore}/14)`);
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
        const useMarketFillAtZone = priceIsAtValidatedZone && config.marketFillAtZone && priceOnCorrectSide && !isStandaloneSignal;
        if (isStandaloneSignal && priceIsAtValidatedZone && config.marketFillAtZone && priceOnCorrectSide) {
          console.log(`[scan ${scanCycleId}] ⏳ ${pair}: STANDALONE at zone — routing to CHoCH confirmation path (market fill reserved for unified/cascade).`);
        }

        // Pending Zone Orders is the sole authority for creating a limit order.
        // A hard impulse-zone gate must not silently override the visible Bot Config toggle.
        const effectiveLimitEnabled = shouldCreatePendingZoneOrder({
          pendingZoneOrdersEnabled: config.limitOrderEnabled,
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

          // Recalculate SL/TP relative to the limit entry price for better R:R
          let limitSL = sl;
          let limitTP = computeTP(limitEntry.price, sl, analysis.direction);

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
          let limitSize = limitSizingResult.lots;
          // Apply signal source size multiplier to limit orders too
          if ((detail as any).signalSource !== "unified") {
            limitSize = Math.round(limitSize * 0.5 * 100) / 100;
            if (limitSize < 0.01) limitSize = 0.01;
          }

          // ── Replace stale pending: expire any existing pending order for same symbol+direction ──
          // Market evolves — a new setup for the same symbol/direction is a different trade idea
          // with different entry zone, SL/TP, score. Expire the old one and insert fresh.
          const { data: stalePending } = await supabase.from("pending_orders")
            .select("order_id, entry_price, signal_score")
            .eq("user_id", userId).eq("bot_id", BOT_ID)
            .eq("symbol", pair).eq("direction", analysis.direction)
            .eq("status", "pending");
          if (stalePending && stalePending.length > 0) {
            const staleIds = stalePending.map((s: any) => s.order_id);
            await supabase.from("pending_orders").update({
              status: "cancelled",
              cancel_reason: `Superseded by new setup (score ${analysis.score.toFixed(1)} vs old ${stalePending[0].signal_score?.toFixed?.(1) ?? "?"}, entry ${limitEntry.price} vs old ${stalePending[0].entry_price})`,
            }).in("order_id", staleIds).eq("user_id", userId);
            console.log(`[pending] Expired ${stalePending.length} stale pending order(s) for ${pair} ${analysis.direction} — superseded by new setup (score ${analysis.score.toFixed(1)})`);
          }

          // GUARD: reject pending orders whose SL/TP orientation doesn't match direction.
          // Long needs SL<entry<TP; short needs TP<entry<SL. Prevents inverted limit orders
          // (root cause: direction flipped after analysis.stopLoss/takeProfit computed).
          {
            const eNum = Number(limitEntry.price);
            const sNum = Number(limitSL);
            const tNum = Number(limitTP);
            const ok = analysis.direction === "long"
              ? (sNum < eNum && tNum > eNum)
              : (sNum > eNum && tNum < eNum);
            if (!ok) {
              console.error(`[GUARD] ${pair} ${analysis.direction} LIMIT REJECTED — SL/TP orientation mismatch. entry=${eNum} sl=${sNum} tp=${tNum}`);
              detail.status = "zone_setup_rejected_orientation";
              detail.skipReason = `SL/TP orientation mismatch for ${analysis.direction} (entry=${eNum} sl=${sNum} tp=${tNum})`;
              await finalizeDetailGoldenReplay({
                execution: {
                  eligible: false,
                  entryPrice: eNum,
                  stopLoss: sNum,
                  takeProfit: tNum,
                  positionSize: limitSize,
                  orderType: "limit",
                },
                lifecycle: {
                  route: "limit",
                  stage: "protection",
                  outcome: "blocked",
                  reason: detail.skipReason,
                },
              });
              scanDetails.push(detail);
              continue;
            }
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
          const pendingOriginatingZone = {
            type: limitEntry.zoneType,
            low: limitEntry.zoneLow,
            high: limitEntry.zoneHigh,
            entry: limitEntry.price,
            refinedLow: izData?.bestZone?.ltfRefined
                ? Math.min(
                  Number(izData.bestZone.refinedEntry),
                  Number(izData.bestZone.refinedSL),
                )
                : null,
            refinedHigh: izData?.bestZone?.ltfRefined
                ? Math.max(
                  Number(izData.bestZone.refinedEntry),
                  Number(izData.bestZone.refinedSL),
                )
                : null,
            signalSource: (detail as any).signalSource || null,
          };
          const pendingLifecycleEvidence = buildPromotedLifecycleEvidence(
            pendingOriginatingZone,
            pendingHierarchy as unknown as Record<string, unknown>,
          );
          const pendingCandidateId =
            pendingLifecycleEvidence?.candidateId || crypto.randomUUID();
          const pendingFrozenStrategyContext =
            pendingLifecycleEvidence?.frozenStrategyContext ||
            buildFrozenSetupStrategyContext({
              identity: {
                setupId: pendingLifecycleEvidence?.setupId ||
                  crypto.randomUUID(),
                candidateId: pendingCandidateId,
              },
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
              originatingZone: pendingOriginatingZone,
              confirmationMethod:
                pairConfig.confirmationMethod || "choch",
              indicatorMinCount: pairConfig.indicatorMinCount || 3,
            });
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
            entry_zone_type: limitEntry.zoneType,
            entry_zone_low: limitEntry.zoneLow,
            entry_zone_high: limitEntry.zoneHigh,
            refined_zone_low: izData?.bestZone?.ltfRefined && izData.bestZone.refinedEntry != null && izData.bestZone.refinedSL != null
              ? Math.min(izData.bestZone.refinedEntry, izData.bestZone.refinedSL) : null,
            refined_zone_high: izData?.bestZone?.ltfRefined && izData.bestZone.refinedEntry != null && izData.bestZone.refinedSL != null
              ? Math.max(izData.bestZone.refinedEntry, izData.bestZone.refinedSL) : null,
            status: "pending",
            expiry_minutes: expiryMinutes,
            expires_at: expiresAt,
              signal_reason: JSON.stringify({ bot: BOT_ID, candidateId: pendingCandidateId, summary: analysis.summary, setupType: setupClassification.setupType, setupConfidence: setupClassification.confidence, entryTimeframe: pairConfig.entryTimeframe, originalSL: limitSL, originalTP: limitTP, originatingZone: pendingOriginatingZone, exitFlags, factorScores: analysis.factors, tieredScoring: analysis.tieredScoring || null, regimeData: detail.regimeData || null, confluenceStacking: detail.confluenceStacking || null, sweepReclaim: detail.sweepReclaim || null, pullbackHealth: detail.pullbackHealth || null, structureIntel: detail.structureIntel || null, entityLifecycles: detail.analysis_snapshot?.entityLifecycles || null, gates: detail.gates || null, setupClassification: detail.setupClassification || null, fibLevels: detail.fibLevels || null, impulseZone: (detail as any).impulseZone || null, directionVerdict: (detail as any).directionVerdict || null, gamePlanSnapshot: activeGamePlan?.plans?.find((plan: any) => plan.symbol === pair) || null, gamePlanShadowAudit: (detail as any).gamePlanShadowAudit || null, signalSource: (detail as any).signalSource || null, unifiedZone: (detail as any).unifiedZone || null, thesisVersion: THESIS_VALIDATION_VERSION, confirmationMethod: pendingFrozenStrategyContext.confirmation.method, indicatorMinCount: pendingFrozenStrategyContext.confirmation.indicatorMinCount, tpMethod: pairConfig.tpMethod || "rr_ratio", decisionContext: pendingDecisionContext, frozenStrategyContext: pendingFrozenStrategyContext, goldenReplaySnapshot: pendingReplaySnapshot, ...(pendingLifecycleEvidence ? { watchlistLifecycle: pendingLifecycleEvidence } : {}), ...(isPromotedFromStaging && existingStaged ? { promotedFromWatchlist: true, watchlistOrigin: { initialScore: parseFloat(existingStaged.initial_score), cyclesWatched: existingStaged.scan_cycles + 1, stagedAt: existingStaged.staged_at } } : {}) }),
            signal_score: analysis.score,
            setup_type: setupClassification.setupType,
            setup_confidence: setupClassification.confidence,
            from_watchlist: isPromotedFromStaging || false,
            staged_setup_id: pendingLifecycleEvidence?.setupId || null,
            candidate_id: pendingCandidateId,
            originating_zone: pendingOriginatingZone,
            thesis_version: THESIS_VALIDATION_VERSION,
            confirmation_method: pendingLifecycleEvidence
              ?.confirmationMethod ||
              pairConfig.confirmationMethod ||
              "choch",
            confirmation_config: {
              indicatorMinCount:
                pendingFrozenStrategyContext.confirmation.indicatorMinCount,
              maxConfirmationAttempts:
                pendingFrozenStrategyContext.confirmation.maxAttempts,
            },
            frozen_strategy_context: pendingFrozenStrategyContext,
            staged_cycles: isPromotedFromStaging && existingStaged ? existingStaged.scan_cycles + 1 : 0,
            staged_initial_score: isPromotedFromStaging && existingStaged ? parseFloat(existingStaged.initial_score) : null,
            exit_flags: exitFlags,
            placed_at: new Date().toISOString(),
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
            const zoneConfLabel = zoneConfMethod === "choch" ? "CHoCH/BOS" : zoneConfMethod === "indicators" ? `Indicator Consensus (${pairConfig.indicatorMinCount || 3}/4)` : `CHoCH + Indicators (${pairConfig.indicatorMinCount || 3}/4)`;
            // TP method label
            const zoneTpMethod = pairConfig.tpMethod || "rr_ratio";
            const zoneTpLabel = zoneTpMethod === "rr_ratio" ? `R:R (${pairConfig.tpRatio || 2.0}:1)` : zoneTpMethod === "next_level" ? "Next Structure Level" : zoneTpMethod === "fixed_pips" ? "Fixed Pips" : `ATR \u00d7${pairConfig.tpATRMultiple || 2.0}`;
            const msg = `${emoji} <b>${mode} Zone Setup ACTIVE</b>

` +
              `<b>Symbol:</b> ${pair}
` +
              `<b>Direction:</b> ${analysis.direction.toUpperCase()}
` +
              `<b>Zone Trigger:</b> ${fmtPx(limitEntry.price, pair)} (${limitEntry.zoneType} zone)
` +
              `<b>Current Price:</b> ${fmtPx(analysis.lastPrice, pair)}
` +
              `<b>Size:</b> ${limitSize} lots
` +
              `<b>SL:</b> ${fmtPx(limitSL, pair)}
` +
              `<b>TP:</b> ${fmtPx(limitTP, pair)} (${zoneTpLabel})
` +
              `<b>Score:</b> ${analysis.score.toFixed(1)}
` +
              `<b>Confirm Mode:</b> ${zoneConfLabel}
` +
              `<b>Confirmation:</b> ${unifiedZoneData?.confirmation ? `${unifiedZoneData.confirmation.type.replace(/_/g, " ")}${unifiedZoneData.confirmation.entryReady ? " \u2713" : " (pending)"} — ${unifiedZoneData.confirmation.detail}` : "Waiting for confirmation at zone"}
` +
              `<b>Expires:</b> ${expiryMinutes}min` +
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
          account.execution_mode === "live" &&
          pairConfig.spreadFilterEnabled
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
          passed: true,
          method: useMarketFillAtZone
            ? "validated_zone_market"
            : "scanner_market_signal",
          reason: useMarketFillAtZone
            ? "Price is inside the validated impulse zone and the market-entry timing rule passed"
            : "The current scanner signal satisfied the configured immediate-entry timing rule",
          evidence: {
            signalSource: (detail as any).signalSource || null,
            impulseZone: (detail as any).impulseZone || null,
            unifiedZone: (detail as any).unifiedZone || null,
            sourceCandleTimestamp:
              candles[candles.length - 1]?.datetime || null,
          },
          evaluatedAt: nowStr,
        };
        const rawDirectAuthorization = evaluateFinalTradeAuthorization({
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
        });
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
        const directOriginatingZone = {
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
            originatingZone: directOriginatingZone,
            confirmationMethod:
              pairConfig.confirmationMethod || "choch",
            indicatorMinCount: pairConfig.indicatorMinCount || 3,
          });
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
          for (const opp of oppositePositions) {
            const oppEntry = parseFloat(opp.entry_price);
            const oppSize = parseFloat(opp.size);
            const oppSpec = SPECS[pair] || SPECS["EUR/USD"];
            const oppDiff = opp.direction === "long" ? analysis.lastPrice - oppEntry : oppEntry - analysis.lastPrice;
            const oppQuoteToUSD = getQuoteToUSDRate(pair, rateMap);
            const oppPnl = oppDiff * oppSpec.lotUnits * oppSize * oppQuoteToUSD;
            const oppPnlPips = oppDiff / oppSpec.pipSize;

            await supabase.from("paper_positions").delete().eq("position_id", opp.position_id).eq("user_id", userId);
            await supabase.from("paper_trade_history").insert({
              user_id: userId, position_id: opp.position_id, order_id: opp.order_id || orderId,
              symbol: pair, direction: opp.direction, size: opp.size,
              entry_price: opp.entry_price, exit_price: analysis.lastPrice.toString(),
              open_time: opp.open_time || nowStr, closed_at: nowStr,
              close_reason: "reverse_signal",
              pnl: oppPnl.toFixed(2), pnl_pips: oppPnlPips.toFixed(1),
              signal_score: opp.signal_score || "0",
              bot_id: BOT_ID,
            });
            // Update balance with actual PnL — scope to this bot's account
            const balQuery = supabase.from("paper_accounts").select("balance").eq("user_id", userId);
            if (account.bot_id) balQuery.eq("bot_id", BOT_ID);
            const curBal = parseFloat((await balQuery.single()).data?.balance || "10000");
            const newBal = curBal + oppPnl;
            const balUpdate = supabase.from("paper_accounts").update({ balance: newBal.toFixed(2), peak_balance: Math.max(newBal, parseFloat(account.peak_balance || "10000")).toFixed(2) }).eq("user_id", userId);
            if (account.bot_id) balUpdate.eq("bot_id", BOT_ID);
            await balUpdate;;

            // Audit log entry for the reverse-signal close
            const oppMirroredIds: string[] = Array.isArray(opp.mirrored_connection_ids) ? opp.mirrored_connection_ids : [];
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

            // Mirror close ONLY to the broker connections this position was actually mirrored to.
            if (account.execution_mode === "live" && oppMirroredIds.length > 0) {
              const { data: closeConns } = await supabase.from("broker_connections")
                .select("*").eq("user_id", userId).in("broker_type", ["metaapi", "oanda"])
                .eq("is_active", true).in("id", oppMirroredIds);
              if (closeConns && closeConns.length > 0) {
                for (const conn of closeConns) {
                  try {
                    let authToken = conn.api_key;
                    let metaAccountId = conn.account_id;
                    if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
                      authToken = conn.account_id;
                      metaAccountId = conn.api_key;
                    }
                    const { res: posRes, body: posBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/positions`);
                    if (!posRes.ok) { console.warn(`Reverse close [${conn.display_name}]: positions fetch failed ${posRes.status}`); continue; }
                    const brokerPositions: any[] = JSON.parse(posBody);
                    const commentTag = `paper:${opp.position_id}`;
                    const shortTag = commentTag.slice(0, 28);
                    const brokerPos = brokerPositions.find((p: any) =>
                      p.comment && (p.comment.includes(commentTag) || p.comment.startsWith(shortTag))
                    );
                    if (!brokerPos) {
                      console.log(`Reverse close [${conn.display_name}]: no matching comment-tagged position for paper:${opp.position_id} — skipping (no symbol fallback to avoid closing unrelated trades)`);
                      continue;
                    }
                    const { res: closeRes } = await metaFetch(metaAccountId, authToken, (base) => `${base}/trade`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId: brokerPos.id }) });
                    console.log(`Reverse close [${conn.display_name}]: ${closeRes.ok ? "closed" : "failed " + closeRes.status} paper:${opp.position_id}`);
                  } catch (e: any) {
                    console.warn(`Reverse close [${conn.display_name}] error: ${e?.message}`);
                  }
                }
              }
            } else if (account.execution_mode === "live") {
              console.log(`Reverse close: paper:${opp.position_id} had no mirrored_connection_ids — skipping broker fan-out`);
            }
          }
          // Remove closed opposite positions from the in-memory array so subsequent
          // gate checks in this scan cycle don't over-count.
          const closedIds = new Set(oppositePositions.map((p: any) => p.position_id));
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
            (detail as any).gamePlanShadowAudit || null,
          signalSource: (detail as any).signalSource || null,
          unifiedZone: (detail as any).unifiedZone || null,
          originatingZone: directOriginatingZone,
          gamePlanSnapshot,
          finalAuthorization: directAuthorization,
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
                promotionReason:
                  `Score reached ${analysis.score.toFixed(1)}% `
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
        await closeOppositePositionsAfterEntry();

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
          detail.zoneConfirmation = "zone_touch_is_confirmation";
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
          const mode = account.execution_mode === "live" ? "LIVE" : "PAPER";
          // TP method label for notification
          const openTpMethod = pairConfig.tpMethod || "rr_ratio";
          const openTpLabel = openTpMethod === "rr_ratio" ? `R:R (${pairConfig.tpRatio || 2.0}:1)` : openTpMethod === "next_level" ? "Next Structure Level" : openTpMethod === "fixed_pips" ? "Fixed Pips" : `ATR ×${pairConfig.tpATRMultiple || 2.0}`;
          const msg = `${emoji} <b>${mode} Trade Opened</b>\n\n` +
            `<b>Symbol:</b> ${pair}\n` +
            `<b>Direction:</b> ${analysis.direction.toUpperCase()}\n` +
            `<b>Size:</b> ${size} lots\n` +
            `<b>Entry:</b> ${fmtPx(analysis.lastPrice, pair)}\n` +
            `<b>SL:</b> ${fmtPx(sl, pair)}\n` +
            `<b>TP:</b> ${fmtPx(tp, pair)} (${openTpLabel})\n` +
            `<b>Score:</b> ${analysis.score.toFixed(1)}\n` +
            `<b>Session:</b> ${analysis.session.name}\n` +
            `<b>Setup:</b> ${setupClassification.setupType.toUpperCase()} (${(setupClassification.confidence * 100).toFixed(0)}% conf)\n` +
            `<b>Summary:</b> ${analysis.summary || "—"}` +
            (isPromotedFromStaging && existingStaged ? `\n\n📋 <b>Promoted from Watchlist</b>\nWatched ${existingStaged.scan_cycles + 1} cycles | Started at ${parseFloat(existingStaged.initial_score).toFixed(1)}%` : "") +
            (useMarketFillAtZone ? `\n\n🎯 <b>Market Fill at Zone</b>\n<b>Zone:</b> ${izData?.bestZone?.type || "IZ"} [${izData?.bestZone?.low?.toFixed(5)} \u2013 ${izData?.bestZone?.high?.toFixed(5)}]${izData?.bestZone?.priceInsideZone ? " (inside)" : ` (${izData?.bestZone?.distancePips?.toFixed(1) ?? "?"}p from edge)`}${izData?.bestZone?.refinedEntry ? `\n<b>Refined Entry:</b> ${izData.bestZone.refinedEntry.toFixed(5)}` : ""}` : "") +
            (unifiedZoneData?.confirmation ? `\n\n🎯 <b>Entry Confirmation</b>\n<b>Type:</b> ${unifiedZoneData.confirmation.type.replace(/_/g, " ")}${unifiedZoneData.confirmation.entryReady ? " ✓" : ""}\n<b>Detail:</b> ${unifiedZoneData.confirmation.detail}${unifiedZoneData.confirmation.score > 0 ? `\n<b>Score:</b> +${unifiedZoneData.confirmation.score.toFixed(1)}` : ""}` : "");
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
            const { data: connections } = await supabase.from("broker_connections")
              .select("*").eq("user_id", userId).in("broker_type", ["metaapi", "oanda"]).eq("is_active", true);
            if (connections && connections.length > 0) {
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
                     // Get per-connection commission: user-set takes priority, then auto-detected (per-side × 2 for round-trip)
                     const connUserComm = parseFloat(conn.commission_per_lot ?? "0");
                     const connDetectedComm = parseFloat(conn.detected_commission_per_lot ?? "0") * 2;
                     const connCommRT = connUserComm > 0 ? connUserComm : connDetectedComm;
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
                   if (brokerSpec) {
                     const preClamp = brokerVolume;
                     brokerVolume = Math.max(brokerSpec.minVolume, Math.min(brokerSpec.maxVolume, brokerVolume));
                     brokerVolume = Math.round(brokerVolume / brokerSpec.volumeStep) * brokerSpec.volumeStep;
                     brokerVolume = parseFloat(brokerVolume.toFixed(6)); // avoid floating-point artifacts
                     console.log(`Broker specs [${conn.display_name}] ${brokerSymbol}: min=${brokerSpec.minVolume}, max=${brokerSpec.maxVolume}, step=${brokerSpec.volumeStep} → clamped ${preClamp} → ${brokerVolume}`);
                   }

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

        // Add to virtual open positions for subsequent gates
        openPosArr.push({ symbol: pair, size: size.toString(), entry_price: analysis.lastPrice.toString(), direction: analysis.direction, position_id: positionId, position_status: "open", order_id: orderId, open_time: nowStr, signal_score: analysis.score.toString() });
      } else {
        rejectedCount++;
        detail.status = "rejected";
        const failedGates = gates.filter(g => !g.passed);
        detail.rejectionReasons = failedGates.map(g => g.reason);
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
            failedGates: failedGates.map(g => g.reason),
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
              gamePlanShadowAudit: (detail as any).gamePlanShadowAudit || null,
              thesisConviction: (detail as any).thesisConviction || null,
              directionVerdict: (detail as any).directionVerdict || null,
              impulseZone: (detail as any).impulseZone || null,
              decisionContext: (detail as any).decisionContext || null,
              stylePolicy: pairStylePolicy,
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
            if (!breaker.retestComplete) continue; // Only fire when retest is confirmed
            if (breaker.confidence < 0.5) continue; // Minimum confidence threshold

            const breakerDir = breaker.direction === "bullish" ? "long" : "short";
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

            // R:R check
            const breakerRR = Math.abs(breakerTP - breakerEntry) / breakerRisk;
            if (breakerRR < (config.minRiskReward ?? 1.0)) continue;

            // Size calculation (default remains the historical half-risk behavior).
            const breakerSizeMultiplier = Math.max(
              0.1,
              Math.min(1, Number((pairConfig as any).smcEnhancements?.breakerSizeMultiplier ?? 0.5)),
            );
            const breakerSizing = computePositionSize(
              { balance, riskPercent: pairConfig.riskPerTrade * breakerSizeMultiplier, entryPrice: breakerEntry, stopLoss: breakerSL, symbol: pair, method: (pairConfig as any).positionSizingMethod || "percent_risk", fixedLotSize: (pairConfig as any).fixedLotSize, atrValue: (analysis as any).atrValue, atrVolatilityMultiplier: (pairConfig as any).atrVolatilityMultiplier, rateMap, commissionPerLot: avgCommissionPerLot },
              undefined, undefined, undefined,
            );
            let breakerSize = Math.max(breakerSizing.lots * propFirmSizeMultiplier, 0.01);

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
              maxOpenPositions: config.maxOpenPositions,
              maxPerSymbol: config.maxPerSymbol,
              allowSameDirectionStacking: config.allowSameDirectionStacking,
              maxDailyLoss: config.maxDailyLoss,
              maxDrawdown: config.maxDrawdown,
              minimumRiskReward: config.minRiskReward,
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
            const breakerCandidateId = crypto.randomUUID();
            const breakerExpiry = config.limitOrderExpiryMinutes || 60;
            const breakerExpiresAt = new Date(Date.now() + breakerExpiry * 60 * 1000).toISOString();
            const breakerOriginatingZone = {
              type: "breaker_block",
              low: breaker.entryZone.low,
              high: breaker.entryZone.high,
              entry: breakerEntry,
            };
            const breakerFrozenStrategyContext =
              buildFrozenSetupStrategyContext({
                identity: {
                  setupId: crypto.randomUUID(),
                  candidateId: breakerCandidateId,
                },
                symbol: pair,
                direction: breakerDir,
                stylePolicy: pairStylePolicy,
                runtimeConfig: pairRuntimeConfigSnapshot,
                decisionContext: breakerAuthorization.decisionContext,
                gamePlan: activeGamePlan,
                directionVerdict: activeDirectionVerdict,
                originatingZone: breakerOriginatingZone,
                confirmationMethod:
                  pairConfig.confirmationMethod || "choch",
                indicatorMinCount: pairConfig.indicatorMinCount || 3,
              });

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
                signalSource: "breaker",
                summary: breaker.detail,
                breakerData: { direction: breaker.direction, confidence: breaker.confidence, displacementStrength: breaker.displacementStrength, hadLiquiditySweep: breaker.hadLiquiditySweep, originalOB: breaker.originalOB, sizeMultiplier: breakerSizeMultiplier },
                entryTimeframe: pairConfig.entryTimeframe,
                originalSL: breakerSL,
                originalTP: breakerTP,
                confirmationMethod:
                  pairConfig.confirmationMethod || "choch",
                indicatorMinCount: pairConfig.indicatorMinCount || 3,
                thesisVersion: THESIS_VALIDATION_VERSION,
                tpMethod: config.tpMethod || "rr_ratio",
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
                gamePlanShadowAudit: (detail as any).gamePlanShadowAudit || null,
                thesisConviction: (detail as any).thesisConviction || null,
                directionVerdict: (detail as any).directionVerdict || null,
                impulseZone: (detail as any).impulseZone || null,
                decisionContext: (detail as any).decisionContext || null,
                stylePolicy: pairStylePolicy,
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
                sl_level: analysis.stopLoss,
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
              const styleTTL = resolvedStyle === "scalper" ? Math.min(stagingTTLMinutes, 120)
                : resolvedStyle === "swing_trader" ? Math.max(stagingTTLMinutes, 480)
                : stagingTTLMinutes;
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
                sl_level: analysis.stopLoss,
                tp_level: analysis.takeProfit,
                ...stagedDecisionFields({
                  type: setupClassification.setupType ||
                    "confluence_watch",
                  entry: analysis.lastPrice,
                  stopLoss: analysis.stopLoss,
                  takeProfit: analysis.takeProfit,
                  signalSource: (detail as any).signalSource || null,
                }),
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
              ttlMinutes: resolvedStyle === "scalper" ? Math.min(stagingTTLMinutes, 120)
                : resolvedStyle === "swing_trader" ? Math.max(stagingTTLMinutes, 480)
                : stagingTTLMinutes,
            };
          }
        } else {
          detail.status = "below_threshold";
          const ts = analysis.tieredScoring;
          const tierInfo = ts ? ` (T1:${ts.tier1Count}/4, T2:${ts.tier2Count}/5)` : "";
          detail.reason = `Score ${analysis.score.toFixed(1)}% < ${adjustedMinConfluence}% threshold${tierInfo}`;
          // If score dropped below watch threshold, invalidate any existing staged setup
          if (existingStaged && analysis.score < watchThreshold && stagingEnabled) {
            try {
              await supabase.from("staged_setups").update({
                status: "invalidated",
                invalidation_reason: `Score dropped to ${analysis.score.toFixed(1)}% (below watch threshold ${watchThreshold}%)`,
                resolved_at: new Date().toISOString(),
              }).eq("id", existingStaged.id);
              stagedInvalidated++;
              stagedMap.delete(stagedKey!);
              console.log(`[staging] Invalidated ${pair} ${existingStaged.direction} — score dropped below watch threshold`);
            } catch (e: any) {
              console.warn(`[staging] Failed to invalidate ${pair}: ${e?.message}`);
            }
            detail.staging = { action: "invalidated", reason: "score_dropped" };
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
      candleSource: sourceTally.primary,         // "metaapi" | "twelvedata" | "polygon" | "none"
      sourceBreakdown: {
        metaapi: sourceTally.metaapi,
        twelvedata: sourceTally.twelvedata,
        polygon: sourceTally.polygon,
        none: sourceTally.none,
      },
      brokerConnected: !!_scanBrokerConn,
      managementActions: managementActions.filter(a => a.action !== "no_change"),
      rateLimitThrottles: throttleStats.throttleCount,
      fotsiStrengths: _fotsiResult?.strengths ?? null,  // Currency strength values for UI meter
      dataCache: { hits: cacheStats.hits, fetches: cacheStats.misses, errors: cacheStats.errors, seeded: cacheStats.seeded },
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
  console.log(`[scan ${scanCycleId}] Primary candle source: ${sourceTally.primary} (meta=${sourceTally.metaapi}, td=${sourceTally.twelvedata}, polygon=${sourceTally.polygon}, none=${sourceTally.none}, throttles=${throttleStats.throttleCount})`);

  // Log the scan
  await supabase.from("scan_logs").insert({
    user_id: userId,
    bot_id: BOT_ID,
    pairs_scanned: config.instruments.length,
    signals_found: signalsFound,
    trades_placed: tradesPlaced,
    details_json: detailsWithMeta,
  });

  await completeScannerOperation(supabase, opts?.operationRunId, "scan", {
    scan_cycle_id: scanCycleId,
    pairs_scanned: config.instruments.length,
    signals_found: signalsFound,
    trades_placed: tradesPlaced,
    rejected: rejectedCount,
    candle_source: sourceTally.primary,
  });

  return { pairsScanned: config.instruments.length, signalsFound, tradesPlaced, rejected: rejectedCount, details: scanDetails, activeStyle: resolvedStyle, resolvedMinConfluence: config.minConfluence, scanCycleId, managementActions: managementActions.filter(a => a.action !== "no_change"), staging: stagingEnabled ? { watching: activeStagedSetups.length - stagedPromoted - stagedInvalidated, promoted: stagedPromoted, expired: stagedExpired, invalidated: stagedInvalidated, newlyStaged: stagedNew } : null, pendingOrders: config.limitOrderEnabled ? { active: (activePendingOrders?.length || 0) - pendingFilled - pendingExpired - pendingCancelled, filled: pendingFilled, expired: pendingExpired, cancelled: pendingCancelled, placed: pendingPlaced, awaitingConfirmation: pendingConfirmationHunting } : null };
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
