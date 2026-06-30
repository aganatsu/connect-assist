import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { mapNestedToFlat, applyPairOverrides } from "../_shared/configMapper.ts";
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
  generateInstrumentGamePlan, buildSessionGamePlan, filterTradeByGamePlan,
  getCurrentSession, fetchNewsForGamePlan, enrichGamePlanWithNews,
  type SessionGamePlan, type InstrumentGamePlan, type SessionName,
} from "../_shared/gamePlan.ts";
import {
  classifySetupType, manageOpenPositions,
  type SetupClassification, type ManagementAction,
} from "../_shared/scannerManagement.ts";
import {
  analyzeNewsImpact, checkNewsAlignment, getNewsPairBias,
  type NewsEvent, type NewsImpactResult,
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
import { type HTFConfluenceData } from "../_shared/impulseZoneEngine.ts";
import { findUnifiedZone, type UnifiedZoneResult } from "../_shared/unifiedZoneEngine.ts";
import { findCascadeZone, type CascadeResult } from "../_shared/cascadeZoneEngine.ts";
import { detectZoneConfirmation, isPriceInZone, isImpulseBroken, formatConfirmationSummary, DEFAULT_ZONE_CONFIRMATION_CONFIG, type ConfirmationSignal } from "../_shared/zoneConfirmation.ts";
import { determineDirection, determineDirectionStyleAware, STYLE_TF_LABELS, confirmedTrend as computeConfirmedTrend, type DirectionResult, type StyleDirectionResult } from "../_shared/directionEngine.ts";
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
import { computePositionSize, calculatePositionRisk, type VolatilityContext, type PropFirmContext } from "../_shared/unifiedPositionSizing.ts";
import { isConnectionAvailable, updateHealth, createInitialHealth, type BrokerHealth, type ExecutionResult, DEFAULT_FAILOVER_CONFIG } from "../_shared/multiBrokerFailover.ts";
import { checkPortfolioConflict } from "../_shared/portfolioCorrelation.ts";
import { adjustTPForRegime } from "../_shared/exitEngine.ts";
import { createScanCache } from "../_shared/dataCache.ts";
import {
  detectSession as sharedDetectSession,
  toNYTime as sharedToNYTime,
  normalizeSessionFilter,
  isSessionEnabled,
  type SessionResult,
} from "../_shared/sessions.ts";

declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

// ─── Bot Identity ────────────────────────────────────────────────────
const BOT_ID = "smc";
// ─── Default Config (overridden by bot_configs) ─────────────────────
const DEFAULTS = {
  minConfluence: 55,  // Percentage (0-100) — must match normalizedScoring: true
  htfBiasRequired: true,
  htfBiasHardVeto: false,
  onlyBuyInDiscount: false,
  onlySellInPremium: false,
  maxDrawdown: 20,
  maxDailyLoss: 5,
  riskPerTrade: 1,
  maxOpenPositions: 3,
  maxPerSymbol: 2,
  allowSameDirectionStacking: false,
  portfolioHeat: 10,
  minRiskReward: 1.5,
  // ── SL/TP Method Defaults ──
  slMethod: "structure" as "fixed_pips" | "atr_based" | "structure" | "below_ob",
  fixedSLPips: 25,
  slATRMultiple: 1.5,
  slATRPeriod: 14,
  slBufferPips: 2,
  // Per-instrument SL buffer overrides (pips). When set, the override is final — no asset-class multiplier applied.
  instrumentBuffers: {} as Record<string, { slBufferPips?: number }>,
  tpMethod: "rr_ratio" as "fixed_pips" | "rr_ratio" | "next_level" | "atr_multiple",
  fixedTPPips: 50,
  tpRatio: 2.0,
  tpATRMultiple: 2.0,
  breakEvenEnabled: true,
  breakEvenPips: 20,
  // Offset above/below entry when SL is moved to breakeven (pips). Default 3
  // covers typical spread + commission so BE exits net ~flat instead of slightly
  // negative on live brokers.
  breakEvenOffsetPips: 3,
  enabledSessions: ["london", "newyork"],
  enabledDays: [1, 2, 3, 4, 5], // Mon-Fri
  instruments: [
    "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD",
    "GBP/JPY", "EUR/JPY", "NZD/USD", "USD/CHF", "EUR/GBP",
    "XAU/USD", "BTC/USD",
  ],
  openingRange: {
    enabled: false,
    candleCount: 24,
    useBias: true,
    useJudasSwing: true,
    useKeyLevels: true,
    usePremiumDiscount: false,
    waitForCompletion: true,
  },
  tradingStyle: {
    mode: "day_trader" as "scalper" | "day_trader" | "swing_trader",
  },
  // ── Spread Filter ──
  spreadFilterEnabled: true,
  maxSpreadPips: 0, // 0 = use per-instrument defaults from SPECS.maxSpread
  // ── ATR Volatility Filter (H2) ──
  atrFilterEnabled: false,
  atrFilterMin: 0,   // min ATR in pips (0 = no min)
  atrFilterMax: 0,   // max ATR in pips (0 = no max)
  // ── News Event Filter ──
  newsFilterEnabled: true,
  newsFilterPauseMinutes: 30,
  // ── Entry behaviour ──
  scanIntervalMinutes: 15, // how often to scan (cron runs every 5m, but skips if interval not elapsed)
  cooldownMinutes: 0,
  closeOnReverse: false,
  // ── Exit toggles ──
  structureInvalidationEnabled: false, // CHoCH-against SL tightening (disabled: fires too often on retracements)
  trailingStopEnabled: false,
  trailingStopPips: 15,
  trailingStopActivation: "after_1r",
  partialTPEnabled: true,
  partialTPPercent: 50,
  partialTPLevel: 1.0,
  maxHoldEnabled: false,
  maxHoldHours: 0,
  // ── Sessions ──
  killZoneOnly: false,
  // ── Protection ──
  maxConsecutiveLosses: 0,
  protectionMaxDailyLossDollar: 0,
  // ── Strategy gates ── (collapsed to single percentage threshold: minConfluence)
  // ── Normalized Scoring (opt-in) ──
  // When true, raw score is normalized to percentage of enabled factors' max possible score,
  // then scaled to 0-10. This means disabling factors auto-adjusts the scale so the
  // minConfluence threshold always means "X% of enabled factors aligned".
  normalizedScoring: true,  // Percentage-based scoring is now the default
  useSMT: true,
  smtOppositeVeto: true,  // When true, block trades where SMT divergence opposes signal direction
  useFOTSI: true,
  // ── Impulse Zone Scoring ──
  impulseZoneEnabled: true,       // When true, apply score penalty/bonus based on zone detection
  impulseZonePenalty: 2.0,        // Score reduction (percentage points) when no valid zone found
  impulseZoneBonus: 1.0,          // Score bonus (percentage points) when price IS at a valid zone
  impulseZoneGateMode: "hard" as "hard" | "soft" | "off", // "hard" = no zone/not at zone → skip pair; "soft" = penalty only; "off" = disabled
  minZoneScore: 4,              // Minimum zone totalScore (/9) to accept — rejects weak zones below this threshold
  impulseSlCapMultiplier: 4,    // Max SL distance as multiple of min SL (configurable per pair, e.g. 6 for Gold)
  // ── Simple Direction Engine ──
  useSimpleDirection: true,        // ICT top-down direction (Daily→4H→1H) with hysteresis — replaces old P/D logic
  simpleDirectionH4ChochLookback: 10,  // Recent 4H candles to check for CHoCH
  simpleDirectionH1BosLookback: 8,     // Recent 1H candles to check for BOS confirmation
  useConfirmedTrend: true,             // Use fib-extension-filtered MSBs for stable macro-trend (vs legacy swing-pair flip)
  confirmedTrendFibFactor: 0.25,       // Min extension as fraction of swing range to count as confirmed MSB (0.25 = 25%)
  confirmedTrendSwingLookback: 5,      // Swing detection lookback for confirmedTrend (coarser than entry-level lookback=3)
  // ── Structural Conviction Gate (Gate 3) ──
  // S2F (Structure-to-Fractal) thresholds: block trade when directionRate=0% AND S2F < threshold.
  // Asymmetric defaults: longs strict (35%), shorts loose (20%) per weekly advisor recommendation.
  structuralConvictionS2FLong: 0.35,
  structuralConvictionS2FShort: 0.20,
  // Opposite-fractal soft-block thresholds (used when directionRate=0% but S2F passes).
  structuralConvictionOppositeLong: 0.30,
  structuralConvictionOppositeShort: 0.45,
  // ── Regime-Adaptive Exit Engine ──
  regimeAdaptiveTPEnabled: false,  // When true, adjust TP based on market regime (trending → extend, ranging → tighten)
  trendingRRMultiplier: 1.5,      // R:R multiplier in trending regimes
  rangingRRMultiplier: 0.75,      // R:R multiplier in ranging regimes
  adaptiveTrailingEnabled: false, // When true, use momentum-fade trailing instead of fixed-pip trailing
  baseTrailATRMultiple: 1.5,      // Base trailing distance as ATR multiple
  momentumFadeThreshold: 0.4,     // Body/range ratio below this = fading momentum
  trailTightenFactor: 0.6,        // Multiply trail distance by this when momentum fading
  trailWidenFactor: 1.3,          // Multiply trail distance by this when momentum strong
  // ── Setup Staging / Watchlist ──
  stagingEnabled: true,
  watchThreshold: 25,          // Minimum score to enter the watchlist (percentage)
  stagingTTLMinutes: 240,      // Time-to-live for staged setups (4h default)
  minStagingCycles: 1,         // Minimum scan cycles before promotion allowed
  // ── Limit Orders ──
  limitOrderEnabled: false,     // When true, place limit orders at zone edges instead of market orders
  limitOrderExpiryMinutes: 60,  // How long a pending limit order stays active before expiring
  limitOrderMaxDistancePips: 30, // Max distance from current price to limit price (skip if too far)
  limitOrderMinDistancePips: 3,  // Min distance — if price is already at the zone, use market order instead
  limitOrderPreferZone: "ob" as "ob" | "fvg" | "nearest", // Which zone to use for limit price
  marketFillAtZone: true,        // When true + izGateMode="hard" + price IS at zone → market fill immediately (no CHoCH wait)
  marketFillStrictATRMult: 0.3,   // ATR multiplier for strict zone proximity (market fill). Range: 0.1-1.0
  // ── Per-pair scratch (set during scan) ──
  _currentSymbol: "" as string,
  _smtResult: null as any,
  // ── Factor Weights (config-driven, AI-tunable) ──
  factorWeights: {} as Record<string, number>,
  // ── ICT HTF Framework (Weekly Bias + Daily Impulse + Containment) ──
  ictHTFEnabled: true,             // Enable ICT HTF analysis (weekly bias + daily impulse + containment)
  ictHTFGateMode: "off" as "hard" | "soft" | "off",  // "off" = log only (no trade impact); "soft" = score adjust; "hard" = block
  ictHTFAlignedBonus: 2.0,         // Score bonus when weekly + daily + containment all align
  ictHTFMisalignedPenalty: 3.0,    // Score penalty when weekly bias opposes trade direction
  ictHTFMinContainment: 50,        // Min % overlap between LTF zone and Daily OB for containment pass
  ictWeeklyBiasRequired: true,     // Require weekly bias alignment (when gate != off)
  ictDailyContainmentRequired: true, // Require LTF zone to be inside Daily OB (when gate != off)
  // ── ICT Displacement MSS Validation ──
  ictDisplacementMSSEnabled: true,
  ictDisplacementMSSGateMode: "off" as "hard" | "soft" | "off",
  ictDisplacementMSSMinBodyRatio: 0.6,
  ictDisplacementMSSMinRangeATR: 1.2,
  ictDisplacementMSSLookback: 3,
  ictDisplacementMSSPenalty: 2.0,
  // ── ICT Judas Swing (Liquidity Sweep before MSS) ──
  ictJudasSwingEnabled: true,
  ictJudasSwingGateMode: "off" as "hard" | "soft" | "off",
  ictJudasSwingLookback: 10,
  ictJudasSwingMinDepthATR: 0.1,
  ictJudasSwingRequireCloseBack: true,
  ictJudasSwingPenalty: 1.5,
  // ── ICT FVG Invalidation ──
  ictFVGInvalidationEnabled: true,
  ictFVGInvalidationGateMode: "off" as "hard" | "soft" | "off",
  ictFVGBodyCloseOnly: true,
  ictFVGRuleOfTwo: true,
  ictFVGExhaustedPenalty: 1.5,
  ictFVGInvalidatedPenalty: 3.0,
  // ── ICT Kill Zone Time Filter ──
  ictKillZoneEnabled: true,
  ictKillZoneGateMode: "off" as "hard" | "soft" | "off",
  ictKillZoneSilverBullet: true,
  ictKillZonePMSession: true,
  ictKillZoneOutsidePenalty: 1.0,
  ictKillZonePrimeBonus: 1.5,
  // ── ICT Risk Management ──
  ictRiskEnabled: true,
  ictRiskBasePercent: 0.01,
  ictRiskDrawdownHalving: true,
  ictRiskMaxConsecLosses: 3,
  ictRiskDailyLimit: 0.01,
  ictRiskWeeklyLimit: 0.025,
  ictRiskMaxTradesPerDay: 3,
  ictRiskFVGRuleOfTwoExit: true,
  // ── Entry/HTF timeframes (set by style) ──
  entryTimeframe: "15min",
  htfTimeframe: "1day",
  // ── Thesis Conviction Tracker ──
  thesisConvictionEnabled: true,       // Enable thesis conviction tracking
  thesisConvictionMode: "shadow" as "shadow" | "active", // "shadow" = log only; "active" = modulate impulse credit
  thesisConvictionDecayPerCycle: 8,    // Points lost per cycle when evidence opposes thesis
  thesisConvictionRecoveryPerCycle: 5, // Points gained per cycle when evidence supports thesis
  thesisConvictionRevokeThreshold: 50, // Below this → impulse credit revoked (in active mode)
  thesisConvictionKillThreshold: 30,   // Below this → thesis killed entirely (in active mode)
};
// ─── Resolve symbol name with per-symbol overrides or default suffix ──
// normalizeSymKey is now imported from ../_shared/smcAnalysis.ts
function resolveSymbol(pair: string, conn: any): string {
  const overrides = conn.symbol_overrides || {};
  const norm = normalizeSymKey(pair);
  for (const [k, v] of Object.entries(overrides)) {
    if (normalizeSymKey(k) === norm && v) return String(v);
  }
  const base = pair.trim().replace(/\s+/g, "").replace("/", "").toUpperCase();
  return base + (conn.symbol_suffix || "");
}
// ─── MetaAPI Region Failover ────────────────────────────────────────
const META_REGIONS = ["london", "new-york", "singapore"];
const regionCache = new Map<string, string>();
function metaBaseUrl(region: string, accountId: string) {
  return `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}`;
}
async function metaFetch(
  accountId: string,
  authToken: string,
  pathBuilder: (base: string) => string,
  init?: RequestInit,
): Promise<{ res: Response; body: string }> {
  const cached = regionCache.get(accountId);
  const order = cached ? [cached, ...META_REGIONS.filter(r => r !== cached)] : META_REGIONS;
  let lastBody = ""; let lastStatus = 504;
  for (const region of order) {
    const url = pathBuilder(metaBaseUrl(region, accountId));
    const headers = { ...(init?.headers || {}), "auth-token": authToken } as Record<string, string>;
    const res = await fetch(url, { ...init, headers });
    const body = await res.text();
    if (res.ok) { regionCache.set(accountId, region); return { res, body }; }
    lastBody = body; lastStatus = res.status;
    if (!/region|not connected to broker/i.test(body)) {
      return { res: new Response(body, { status: res.status }), body };
    }
    console.warn(`MetaAPI ${region} returned ${res.status} (region/connection mismatch), trying next...`);
  }
  return { res: new Response(lastBody, { status: lastStatus }), body: lastBody };
}

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

// ─── Trading Style Execution Profiles ───────────────────────────────────────────────────────
// Each style has fundamentally different execution characteristics.
// Key principle: BE and trailing are now R-based (see scannerManagement.ts),
// so breakEvenPips here acts as a fallback — the actual trigger is max(1R, breakEvenPips/riskPips).
// trailingStopPips is a minimum — actual trail distance is max(configPips, 0.5× riskPips).
const STYLE_OVERRIDES: Record<string, Partial<typeof DEFAULTS>> = {
  scalper: {
    scanIntervalMinutes: 5,
    entryTimeframe: "5m",
    htfTimeframe: "1h",
    tpRatio: 2.0,                   // Validated: 2:1 R:R (ATR floor gives ~20p SL → 40p TP)
    slBufferPips: 1,
    minConfluence: 40,              // Percentage — scalpers use lower threshold
    riskPerTrade: 0.5,              // Lower risk per trade (high frequency)
    impulseSlCapMultiplier: 1.5,    // Tight SL cap for scalper (validated)
    // Scalper management: NO BE, NO trailing — let trades run to TP or SL.
    // Backtest validated: 44% WR × 2:1 R:R = profitable. BE/trailing hurt performance
    // by cutting winners short on 5m noise.
    trailingStopEnabled: false,
    trailingStopPips: 8,
    trailingStopActivation: "after_1r",
    breakEvenEnabled: false,        // Validated: disabling BE improves scalper P&L
    breakEvenPips: 8,
    partialTPEnabled: false,
    maxHoldEnabled: true,
    maxHoldHours: 4,
  },
  day_trader: {
    scanIntervalMinutes: 15,
    entryTimeframe: "15min",
    htfTimeframe: "1day",
    tpRatio: 2.0,
    slBufferPips: 2,
    minConfluence: 55,  // Percentage — day traders use moderate threshold
    // Day trader management: partial TP at 1R, then trailing kicks in, BE at 1R
    // On 15m chart with ~20-30 pip SL, BE at ~20-30 pips, trail at ~10-15 pips
    trailingStopEnabled: true,      // Changed: enable trailing AFTER partial TP
    trailingStopPips: 15,           // minimum trail; proportional (0.5× SL) may be larger
    trailingStopActivation: "after_1.5r", // Activates after partial TP at 1R + buffer
    breakEvenEnabled: true,
    breakEvenPips: 20,              // fallback; R-based trigger (min 1R) takes precedence
    partialTPEnabled: true,
    partialTPPercent: 50,
    partialTPLevel: 1.0,            // partial at 1R
    maxHoldEnabled: true,
    maxHoldHours: 24,
  },
  swing_trader: {
    scanIntervalMinutes: 60,
    entryTimeframe: "1h",
    htfTimeframe: "1w",
    tpRatio: 3.0,                   // Validated: 3:1 R:R (cascade SL gives proper structure-based risk)
    slBufferPips: 5,
    minConfluence: 40,              // Validated: lower threshold — cascade zone selectivity is the real filter
    riskPerTrade: 1.5,              // Higher risk per trade (fewer trades, higher conviction)
    impulseSlCapMultiplier: 6,      // Wider SL cap for swing (larger impulses on Daily/4H)
    // Swing management: NO BE, NO trailing, NO partial — let trades run to TP or SL.
    // Backtest validated: 75% WR × 3:1 R:R = PF 8.88. BE was cutting XAU/USD winners
    // at breakeven (10/10 trades hit BE instead of TP). Cascade zone quality is high
    // enough that we trust the setup to reach TP without protective management.
    trailingStopEnabled: false,
    trailingStopPips: 25,
    trailingStopActivation: "after_2r",
    breakEvenEnabled: false,        // Validated: disabling BE dramatically improves swing P&L
    breakEvenPips: 40,
    partialTPEnabled: false,        // Validated: no partial TP — let full position reach 3R
    partialTPPercent: 33,
    partialTPLevel: 1.0,
    maxHoldEnabled: false,
    maxHoldHours: 0,                // no time limit for swings
  },
};

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

// ─── Silver Bullet Windows (DST-aware, NY local time) ────────────
function detectSilverBullet(): SilverBulletResult {
  const ny = toNYTime(new Date());
  const t = ny.t;
  const windows: { name: string; start: number; end: number }[] = [
    { name: "London Open SB", start: 3,  end: 4  },
    { name: "AM SB",          start: 10, end: 11 },
    { name: "PM SB",          start: 14, end: 15 },
  ];
  for (const w of windows) {
    if (t >= w.start && t < w.end) {
      return { active: true, window: w.name, minutesRemaining: Math.max(0, Math.round((w.end - t) * 60)) };
    }
  }
  return { active: false, window: null, minutesRemaining: 0 };
}

// ─── ICT Macro Windows (DST-aware, NY local time, ~20min each) ────
function detectMacroWindow(): MacroWindowResult {
  const ny = toNYTime(new Date());
  const tMin = ny.tMin;
  const windows: { name: string; start: number; end: number }[] = [
    { name: "London Macro 1",    start:  2 * 60 + 33, end:  2 * 60 + 50 },
    { name: "London Macro 2",    start:  4 * 60 +  3, end:  4 * 60 + 20 },
    { name: "NY Pre-Open Macro", start:  8 * 60 + 50, end:  9 * 60 + 10 },
    { name: "NY AM Macro",       start:  9 * 60 + 50, end: 10 * 60 + 10 },
    { name: "London Close Macro",start: 10 * 60 + 50, end: 11 * 60 + 10 },
    { name: "NY Lunch Macro",    start: 11 * 60 + 50, end: 12 * 60 + 10 },
    { name: "Last Hour Macro",   start: 13 * 60 + 10, end: 13 * 60 + 40 },
    { name: "PM Macro",          start: 15 * 60 + 15, end: 15 * 60 + 45 },
  ];
  for (const w of windows) {
    if (tMin >= w.start && tMin < w.end) {
      return { active: true, window: w.name, minutesRemaining: w.end - tMin };
    }
  }
  return { active: false, window: null, minutesRemaining: 0 };
}

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
  let data: any = null;
  // Try connection-specific config first
  if (connectionId) {
    const res = await supabase.from("bot_configs").select("config_json").eq("user_id", userId).eq("connection_id", connectionId).maybeSingle();
    data = res.data;
  }
  // Fall back to global config
  if (!data) {
    const res = await supabase.from("bot_configs").select("config_json").eq("user_id", userId).is("connection_id", null).maybeSingle();
    data = res.data;
  }
  // Delegate to shared mapper (single source of truth for field resolution)
  return mapNestedToFlat(data?.config_json || null);
}

// ─── LEGACY loadConfig body preserved as reference (DO NOT USE) ──────
// The mapping logic below has been extracted to _shared/configMapper.ts.
// Keeping as dead code for one release cycle to aid debugging if needed.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _legacyLoadConfigMapping(_raw: any) {
  const raw = _raw;
  const strategy = raw.strategy || {};
  const risk = raw.risk || {};
  const entry = raw.entry || {};
  const exit = raw.exit || {};
  const instruments = raw.instruments || {};
  const sessions = raw.sessions || {};
  const protection = raw.protection || {};

  const enabledInstrumentMap = instruments.allowedInstruments && typeof instruments.allowedInstruments === "object"
    ? instruments.allowedInstruments
    : null;
  const enabledInstrumentList = enabledInstrumentMap
    ? Object.entries(enabledInstrumentMap)
        .filter(([, enabled]) => Boolean(enabled))
        .map(([symbol]) => symbol)
    : null;

  const merged = {
    ...DEFAULTS,
    // ── Strategy mappings ──
    // UI writes: confluenceThreshold; legacy DB: minConfluenceScore
    // Auto-scale legacy 0-10 values to percentage when normalizedScoring is true
    minConfluence: (() => {
      const raw_mc = strategy.confluenceThreshold ?? strategy.minConfluenceScore ?? raw.minConfluence ?? DEFAULTS.minConfluence;
      // If value is in legacy 0-10 range and normalizedScoring is on, scale to percentage
      if (raw_mc > 0 && raw_mc <= 10 && (strategy.normalizedScoring ?? raw.normalizedScoring ?? true)) {
        return raw_mc * 10;
      }
      return raw_mc;
    })(),
    // Legacy minFactorCount and minStrongFactors removed — single percentage threshold only
    // UI writes: requireHTFBias; legacy DB: htfBiasRequired
    htfBiasRequired: strategy.requireHTFBias ?? strategy.htfBiasRequired ?? raw.htfBiasRequired ?? DEFAULTS.htfBiasRequired,
    // UI writes: htfBiasHardVeto — when true, only allow longs in bullish HTF, shorts in bearish HTF (no ranging exception)
    htfBiasHardVeto: strategy.htfBiasHardVeto ?? raw.htfBiasHardVeto ?? DEFAULTS.htfBiasHardVeto,
    // UI writes: useOrderBlocks; legacy DB: enableOB
    enableOB: strategy.useOrderBlocks ?? strategy.enableOB ?? true,
    // UI writes: useFVG; legacy DB: enableFVG
    enableFVG: strategy.useFVG ?? strategy.enableFVG ?? true,
    // UI writes: useLiquiditySweep; legacy DB: enableLiquiditySweep
    enableLiquiditySweep: strategy.useLiquiditySweep ?? strategy.enableLiquiditySweep ?? true,
    // UI writes: useStructureBreak; legacy DB: enableBOS + enableCHoCH
    enableStructureBreak: strategy.useStructureBreak ?? (strategy.enableBOS !== undefined ? strategy.enableBOS : true),
    // Displacement scoring (defaults true)
    useDisplacement: strategy.useDisplacement ?? true,
    // Breaker Blocks + Unicorn Model (defaults true)
    useBreakerBlocks: strategy.useBreakerBlocks ?? true,
    useUnicornModel: strategy.useUnicornModel ?? true,
    // Silver Bullet macro windows (defaults true)
    useSilverBullet: strategy.useSilverBullet ?? true,
    // ICT Macro Windows (defaults true)
    useMacroWindows: strategy.useMacroWindows ?? true,
    // SMT Divergence (defaults true)
    useSMT: strategy.useSMT ?? true,
    // SMT Opposite Veto (defaults true — block trades where SMT opposes signal)
    smtOppositeVeto: strategy.smtOppositeVeto ?? raw.smtOppositeVeto ?? true,
    // VWAP confluence (defaults true)
    useVWAP: strategy.useVWAP ?? true,
    vwapProximityPips: strategy.vwapProximityPips ?? 15,
    // AMD Phase (defaults true)
    useAMD: strategy.useAMD ?? true,
    // FOTSI Currency Strength (defaults true)
    useFOTSI: strategy.useFOTSI ?? true,
    // Impulse Zone Scoring (defaults true)
    impulseZoneEnabled: strategy.impulseZoneEnabled ?? raw.impulseZoneEnabled ?? true,
    impulseZonePenalty: strategy.impulseZonePenalty ?? raw.impulseZonePenalty ?? 2.0,
    impulseZoneBonus: strategy.impulseZoneBonus ?? raw.impulseZoneBonus ?? 1.0,
    impulseZoneGateMode: (strategy.impulseZoneGateMode ?? raw.impulseZoneGateMode ?? "hard") as "hard" | "soft" | "off",
    minZoneScore: strategy.minZoneScore ?? raw.minZoneScore ?? DEFAULTS.minZoneScore,
    impulseSlCapMultiplier: strategy.impulseSlCapMultiplier ?? raw.impulseSlCapMultiplier ?? DEFAULTS.impulseSlCapMultiplier,
    // Simple Direction Engine
    useSimpleDirection: strategy.useSimpleDirection ?? raw.useSimpleDirection ?? true,
    simpleDirectionH4ChochLookback: strategy.simpleDirectionH4ChochLookback ?? raw.simpleDirectionH4ChochLookback ?? 10,
    simpleDirectionH1BosLookback: strategy.simpleDirectionH1BosLookback ?? raw.simpleDirectionH1BosLookback ?? 8,
    useConfirmedTrend: strategy.useConfirmedTrend ?? raw.useConfirmedTrend ?? true,
    confirmedTrendFibFactor: strategy.confirmedTrendFibFactor ?? raw.confirmedTrendFibFactor ?? 0.25,
    confirmedTrendSwingLookback: strategy.confirmedTrendSwingLookback ?? raw.confirmedTrendSwingLookback ?? 5,
    // Structural Conviction Gate (Gate 3) — configurable per-direction S2F + opposite thresholds
    structuralConvictionEnabled: strategy.structuralConvictionEnabled !== false,
    structuralConvictionS2FLong: strategy.structuralConvictionS2FLong ?? raw.structuralConvictionS2FLong ?? DEFAULTS.structuralConvictionS2FLong,
    structuralConvictionS2FShort: strategy.structuralConvictionS2FShort ?? raw.structuralConvictionS2FShort ?? DEFAULTS.structuralConvictionS2FShort,
    structuralConvictionOppositeLong: strategy.structuralConvictionOppositeLong ?? raw.structuralConvictionOppositeLong ?? DEFAULTS.structuralConvictionOppositeLong,
    structuralConvictionOppositeShort: strategy.structuralConvictionOppositeShort ?? raw.structuralConvictionOppositeShort ?? DEFAULTS.structuralConvictionOppositeShort,
    // ── Regime-Adaptive Exit Engine ──
    regimeAdaptiveTPEnabled: strategy.regimeAdaptiveTPEnabled ?? raw.regimeAdaptiveTPEnabled ?? false,
    trendingRRMultiplier: strategy.trendingRRMultiplier ?? raw.trendingRRMultiplier ?? 1.5,
    rangingRRMultiplier: strategy.rangingRRMultiplier ?? raw.rangingRRMultiplier ?? 0.75,
    adaptiveTrailingEnabled: strategy.adaptiveTrailingEnabled ?? raw.adaptiveTrailingEnabled ?? false,
    baseTrailATRMultiple: strategy.baseTrailATRMultiple ?? raw.baseTrailATRMultiple ?? 1.5,
    momentumFadeThreshold: strategy.momentumFadeThreshold ?? raw.momentumFadeThreshold ?? 0.4,
    trailTightenFactor: strategy.trailTightenFactor ?? raw.trailTightenFactor ?? 0.6,
    trailWidenFactor: strategy.trailWidenFactor ?? raw.trailWidenFactor ?? 1.3,
    // Volume Profile / Trend Direction / Daily Bias toggles (UI writes, scanner now respects)
    useVolumeProfile: strategy.useVolumeProfile ?? true,
    useTrendDirection: strategy.useTrendDirection ?? true,
    useDailyBias: strategy.useDailyBias ?? true,
    // Regime scoring (UI writes under strategy.*; scanner reads at top level)
    regimeScoringEnabled: strategy.regimeScoringEnabled ?? raw.regimeScoringEnabled ?? true,
    regimeScoringStrength: strategy.regimeScoringStrength ?? raw.regimeScoringStrength ?? 1.0,
    // Normalized scoring (percentage-based scoring that auto-adjusts when factors are toggled)
    // Default: true — aligns with DEFAULTS object, UI default, and confluenceScoring output (always percentage)
    normalizedScoring: strategy.normalizedScoring ?? raw.normalizedScoring ?? true,
    // ── P1 tuning fields (now wired to scanner) ──
    obLookbackCandles: strategy.obLookbackCandles ?? raw.obLookbackCandles ?? 50,
    fvgMinSizePips: strategy.fvgMinSizePips ?? raw.fvgMinSizePips ?? 0,
    fvgOnlyUnfilled: strategy.fvgOnlyUnfilled ?? raw.fvgOnlyUnfilled ?? true,
    structureLookback: strategy.structureLookback ?? raw.structureLookback ?? 50,
    liquidityPoolMinTouches: strategy.liquidityPoolMinTouches ?? raw.liquidityPoolMinTouches ?? 2,
    // Liquidity detection sensitivity (1-5 scale → ATR multiplier)
    // 1=tight (0.10×ATR), 2=moderate (0.15×ATR), 3=balanced (0.20×ATR), 4=loose (0.25×ATR), 5=wide (0.30×ATR)
    equalHighsLowsSensitivity: strategy.equalHighsLowsSensitivity ?? raw.equalHighsLowsSensitivity ?? 3,
    // Premium/Discount filters (legacy DB keys)
    onlyBuyInDiscount: strategy.onlyBuyInDiscount ?? DEFAULTS.onlyBuyInDiscount,
    onlySellInPremium: strategy.onlySellInPremium ?? DEFAULTS.onlySellInPremium,

    // ── Risk mappings ──
    riskPerTrade: risk.riskPerTrade ?? raw.riskPerTrade ?? DEFAULTS.riskPerTrade,
    positionSizingMethod: risk.positionSizingMethod ?? raw.positionSizingMethod ?? "percent_risk",
    fixedLotSize: risk.fixedLotSize ?? raw.fixedLotSize ?? 0.1,
    // UI writes: maxDailyDrawdown; legacy DB: maxDailyLoss
    maxDailyLoss: risk.maxDailyDrawdown ?? risk.maxDailyLoss ?? raw.maxDailyLoss ?? DEFAULTS.maxDailyLoss,
    // UI writes: maxConcurrentTrades; legacy DB: maxOpenPositions
    maxOpenPositions: risk.maxConcurrentTrades ?? risk.maxOpenPositions ?? raw.maxOpenPositions ?? DEFAULTS.maxOpenPositions,
    // UI writes: minRR; legacy DB: minRiskReward
    minRiskReward: risk.minRR ?? risk.minRiskReward ?? raw.minRiskReward ?? DEFAULTS.minRiskReward,
    // maxDrawdown is set later (combined with circuitBreakerPct)
    // tpRatio is set later (in SL/TP method block)
    // Legacy DB keys
    maxPerSymbol: risk.maxPositionsPerSymbol ?? DEFAULTS.maxPerSymbol,
    allowSameDirectionStacking: risk.allowSameDirectionStacking ?? DEFAULTS.allowSameDirectionStacking,
    portfolioHeat: risk.maxPortfolioHeat ?? DEFAULTS.portfolioHeat,
    // Conflict counter thresholds (bidirectional scoring)
    conflictThresholdRaise: risk.conflictThresholdRaise ?? raw.conflictThresholdRaise ?? 4,
    conflictBlockAt: risk.conflictBlockAt ?? raw.conflictBlockAt ?? 6,

    // ── Entry mappings ──
    scanIntervalMinutes: entry.scanIntervalMinutes ?? raw.scanIntervalMinutes ?? DEFAULTS.scanIntervalMinutes,
    cooldownMinutes: entry.cooldownMinutes ?? 0,
    closeOnReverse: entry.closeOnReverse ?? false,
    slBufferPips: entry.slBufferPips ?? raw.slBufferPips ?? DEFAULTS.slBufferPips,

    // ── SL/TP Method mappings ──
    slMethod: exit.stopLossMethod ?? exit.slMethod ?? raw.slMethod ?? DEFAULTS.slMethod,
    fixedSLPips: exit.fixedSLPips ?? raw.fixedSLPips ?? DEFAULTS.fixedSLPips,
    slATRMultiple: exit.slATRMultiple ?? raw.slATRMultiple ?? DEFAULTS.slATRMultiple,
    slATRPeriod: exit.slATRPeriod ?? raw.slATRPeriod ?? DEFAULTS.slATRPeriod,
    tpMethod: exit.takeProfitMethod ?? exit.tpMethod ?? raw.tpMethod ?? DEFAULTS.tpMethod,
    fixedTPPips: exit.fixedTPPips ?? raw.fixedTPPips ?? DEFAULTS.fixedTPPips,
    tpRatio: exit.tpRRRatio ?? risk.defaultRR ?? risk.minRiskReward ?? raw.tpRatio ?? DEFAULTS.tpRatio,
    tpATRMultiple: exit.tpATRMultiple ?? raw.tpATRMultiple ?? DEFAULTS.tpATRMultiple,

    // ── Exit mappings ──
    trailingStopEnabled: exit.trailingStop ?? exit.trailingStopEnabled ?? raw.trailingStopEnabled ?? false,
    trailingStopPips: exit.trailingStopPips ?? raw.trailingStopPips ?? 15,
    trailingStopActivation: exit.trailingStopActivation ?? raw.trailingStopActivation ?? "after_1r",
    breakEvenEnabled: exit.breakEven ?? exit.breakEvenEnabled ?? raw.breakEvenEnabled ?? DEFAULTS.breakEvenEnabled,
    breakEvenPips: exit.breakEvenTriggerPips ?? exit.breakEvenPips ?? raw.breakEvenPips ?? DEFAULTS.breakEvenPips,
    breakEvenOffsetPips: exit.breakEvenOffsetPips ?? raw.breakEvenOffsetPips ?? DEFAULTS.breakEvenOffsetPips,
    partialTPEnabled: exit.partialTP ?? exit.partialTPEnabled ?? false,
    partialTPPercent: exit.partialTPPercent ?? raw.partialTPPercent ?? 50,
    partialTPLevel: exit.partialTPLevel ?? raw.partialTPLevel ?? 1.0,
    maxHoldEnabled: exit.maxHoldEnabled ?? raw.maxHoldEnabled ?? DEFAULTS.maxHoldEnabled,
    maxHoldHours: exit.timeExitHours ?? exit.maxHoldHours ?? 0,

    // ── Instruments ──
    // Priority: 1) instruments.enabled array (current UI, including explicit empty array), 2) allowedInstruments map (legacy), 3) defaults
    instruments: Array.isArray(instruments.enabled)
      ? instruments.enabled
      : enabledInstrumentList
        ? enabledInstrumentList
        : (Array.isArray(raw.instruments) ? raw.instruments : DEFAULTS.instruments),

    // ── Sessions ──
    // Session filter: use shared normalizeSessionFilter for consistent parsing.
    // Handles filter arrays, legacy boolean configs, and "sydney" → "offhours" migration.
    enabledSessions: (
      Array.isArray(sessions.filter)
        ? normalizeSessionFilter(sessions.filter)
        : sessions.asianEnabled !== undefined
          ? normalizeSessionFilter([
              ...(sessions.asianEnabled ? ["asian"] : []),
              ...(sessions.londonEnabled ? ["london"] : []),
              ...(sessions.newYorkEnabled || sessions.newyorkEnabled ? ["newyork"] : []),
              ...(sessions.sydneyEnabled ? ["sydney"] : []),  // migrated to "offhours" by normalizeSessionFilter
            ])
          : (Array.isArray(raw.enabledSessions) ? normalizeSessionFilter(raw.enabledSessions) : DEFAULTS.enabledSessions)
    ),
    killZoneOnly: sessions.killZoneOnly ?? false,
    // Sessions block no longer passed through — detectSession() uses fixed DEFAULT_SESSION_WINDOWS.
    // The UI only toggles sessions on/off via the filter array.

    // ── Active Days (convert {mon:true,...} to day-of-week numbers) ──
    enabledDays: sessions.activeDays
      ? [
          ...(sessions.activeDays.sun ? [0] : []),
          ...(sessions.activeDays.mon ? [1] : []),
          ...(sessions.activeDays.tue ? [2] : []),
          ...(sessions.activeDays.wed ? [3] : []),
          ...(sessions.activeDays.thu ? [4] : []),
          ...(sessions.activeDays.fri ? [5] : []),
          ...(sessions.activeDays.sat ? [6] : []),
        ]
      : (Array.isArray(raw.enabledDays) ? raw.enabledDays : DEFAULTS.enabledDays),

    // ── Protection ──
    maxConsecutiveLosses: protection.maxConsecutiveLosses ?? 0,
    // UI writes: maxDailyLoss (dollar); legacy DB: dailyLossLimit
    protectionMaxDailyLossDollar: protection.maxDailyLoss ?? protection.dailyLossLimit ?? 0,
    // UI writes: circuitBreakerPct; legacy DB may not exist
    maxDrawdown: Math.min(
      risk.maxDrawdown ?? raw.maxDrawdown ?? DEFAULTS.maxDrawdown,
      protection.circuitBreakerPct ?? 100,
    ),

    // ── Opening Range & Trading Style (already nested, keep as-is) ──
    openingRange: { ...DEFAULTS.openingRange, ...(raw.openingRange || {}) },
    tradingStyle: { ...DEFAULTS.tradingStyle, ...(raw.tradingStyle || {}) },

    // ── Factor Weights (config-driven, AI-tunable) ──
    factorWeights: raw.factorWeights || {},
    // ── Per-Instrument SL Buffer Overrides ──
    instrumentBuffers: raw.instrumentBuffers || entry.instrumentBuffers || {},

    // ── Spread Filter ──
    spreadFilterEnabled: instruments.spreadFilterEnabled ?? raw.spreadFilterEnabled ?? DEFAULTS.spreadFilterEnabled,
    maxSpreadPips: instruments.maxSpreadPips ?? raw.maxSpreadPips ?? DEFAULTS.maxSpreadPips,

    // ── News Event Filter ──
    newsFilterEnabled: sessions.newsFilterEnabled ?? raw.newsFilterEnabled ?? DEFAULTS.newsFilterEnabled,
    newsFilterPauseMinutes: sessions.newsFilterPauseMinutes ?? raw.newsFilterPauseMinutes ?? DEFAULTS.newsFilterPauseMinutes,

    // ── ATR Volatility Filter (H2) ──
    atrFilterEnabled: instruments.volatilityFilterEnabled ?? raw.atrFilterEnabled ?? DEFAULTS.atrFilterEnabled,
    atrFilterMin: instruments.minATR ?? raw.atrFilterMin ?? DEFAULTS.atrFilterMin,
    atrFilterMax: instruments.maxATR ?? raw.atrFilterMax ?? DEFAULTS.atrFilterMax,

    // ── Setup Staging / Watchlist ──
    stagingEnabled: strategy.stagingEnabled ?? raw.stagingEnabled ?? DEFAULTS.stagingEnabled,
    watchThreshold: strategy.watchThreshold ?? raw.watchThreshold ?? DEFAULTS.watchThreshold,
    stagingTTLMinutes: strategy.stagingTTLMinutes ?? raw.stagingTTLMinutes ?? DEFAULTS.stagingTTLMinutes,
    minStagingCycles: strategy.minStagingCycles ?? raw.minStagingCycles ?? DEFAULTS.minStagingCycles,

    // ── ICT HTF Framework (Weekly Bias + Daily Impulse + Containment) ──
    ictHTFEnabled: strategy.ictHTFEnabled ?? raw.ictHTFEnabled ?? DEFAULTS.ictHTFEnabled,
    ictHTFGateMode: (strategy.ictHTFGateMode ?? raw.ictHTFGateMode ?? DEFAULTS.ictHTFGateMode) as "hard" | "soft" | "off",
    ictHTFAlignedBonus: strategy.ictHTFAlignedBonus ?? raw.ictHTFAlignedBonus ?? DEFAULTS.ictHTFAlignedBonus,
    ictHTFMisalignedPenalty: strategy.ictHTFMisalignedPenalty ?? raw.ictHTFMisalignedPenalty ?? DEFAULTS.ictHTFMisalignedPenalty,
    ictHTFMinContainment: strategy.ictHTFMinContainment ?? raw.ictHTFMinContainment ?? DEFAULTS.ictHTFMinContainment,
    ictWeeklyBiasRequired: strategy.ictWeeklyBiasRequired ?? raw.ictWeeklyBiasRequired ?? DEFAULTS.ictWeeklyBiasRequired,
        ictDailyContainmentRequired: strategy.ictDailyContainmentRequired ?? raw.ictDailyContainmentRequired ?? DEFAULTS.ictDailyContainmentRequired,
    // ── ICT Displacement MSS Validation ──
    ictDisplacementMSSEnabled: strategy.ictDisplacementMSSEnabled ?? raw.ictDisplacementMSSEnabled ?? DEFAULTS.ictDisplacementMSSEnabled,
    ictDisplacementMSSGateMode: (strategy.ictDisplacementMSSGateMode ?? raw.ictDisplacementMSSGateMode ?? DEFAULTS.ictDisplacementMSSGateMode) as "hard" | "soft" | "off",
    ictDisplacementMSSMinBodyRatio: strategy.ictDisplacementMSSMinBodyRatio ?? raw.ictDisplacementMSSMinBodyRatio ?? DEFAULTS.ictDisplacementMSSMinBodyRatio,
    ictDisplacementMSSMinRangeATR: strategy.ictDisplacementMSSMinRangeATR ?? raw.ictDisplacementMSSMinRangeATR ?? DEFAULTS.ictDisplacementMSSMinRangeATR,
    ictDisplacementMSSLookback: strategy.ictDisplacementMSSLookback ?? raw.ictDisplacementMSSLookback ?? DEFAULTS.ictDisplacementMSSLookback,
    ictDisplacementMSSPenalty: strategy.ictDisplacementMSSPenalty ?? raw.ictDisplacementMSSPenalty ?? DEFAULTS.ictDisplacementMSSPenalty,
    // ── ICT Judas Swing ──
    ictJudasSwingEnabled: strategy.ictJudasSwingEnabled ?? raw.ictJudasSwingEnabled ?? DEFAULTS.ictJudasSwingEnabled,
    ictJudasSwingGateMode: (strategy.ictJudasSwingGateMode ?? raw.ictJudasSwingGateMode ?? DEFAULTS.ictJudasSwingGateMode) as "hard" | "soft" | "off",
    ictJudasSwingLookback: strategy.ictJudasSwingLookback ?? raw.ictJudasSwingLookback ?? DEFAULTS.ictJudasSwingLookback,
    ictJudasSwingMinDepthATR: strategy.ictJudasSwingMinDepthATR ?? raw.ictJudasSwingMinDepthATR ?? DEFAULTS.ictJudasSwingMinDepthATR,
    ictJudasSwingRequireCloseBack: strategy.ictJudasSwingRequireCloseBack ?? raw.ictJudasSwingRequireCloseBack ?? DEFAULTS.ictJudasSwingRequireCloseBack,
    ictJudasSwingPenalty: strategy.ictJudasSwingPenalty ?? raw.ictJudasSwingPenalty ?? DEFAULTS.ictJudasSwingPenalty,
    // ── ICT FVG Invalidation ──
    ictFVGInvalidationEnabled: strategy.ictFVGInvalidationEnabled ?? raw.ictFVGInvalidationEnabled ?? DEFAULTS.ictFVGInvalidationEnabled,
    ictFVGInvalidationGateMode: (strategy.ictFVGInvalidationGateMode ?? raw.ictFVGInvalidationGateMode ?? DEFAULTS.ictFVGInvalidationGateMode) as "hard" | "soft" | "off",
    ictFVGBodyCloseOnly: strategy.ictFVGBodyCloseOnly ?? raw.ictFVGBodyCloseOnly ?? DEFAULTS.ictFVGBodyCloseOnly,
    ictFVGRuleOfTwo: strategy.ictFVGRuleOfTwo ?? raw.ictFVGRuleOfTwo ?? DEFAULTS.ictFVGRuleOfTwo,
    ictFVGExhaustedPenalty: strategy.ictFVGExhaustedPenalty ?? raw.ictFVGExhaustedPenalty ?? DEFAULTS.ictFVGExhaustedPenalty,
    ictFVGInvalidatedPenalty: strategy.ictFVGInvalidatedPenalty ?? raw.ictFVGInvalidatedPenalty ?? DEFAULTS.ictFVGInvalidatedPenalty,
    // ── ICT Kill Zone ──
    ictKillZoneEnabled: strategy.ictKillZoneEnabled ?? raw.ictKillZoneEnabled ?? DEFAULTS.ictKillZoneEnabled,
    ictKillZoneGateMode: (strategy.ictKillZoneGateMode ?? raw.ictKillZoneGateMode ?? DEFAULTS.ictKillZoneGateMode) as "hard" | "soft" | "off",
    ictKillZoneSilverBullet: strategy.ictKillZoneSilverBullet ?? raw.ictKillZoneSilverBullet ?? DEFAULTS.ictKillZoneSilverBullet,
    ictKillZonePMSession: strategy.ictKillZonePMSession ?? raw.ictKillZonePMSession ?? DEFAULTS.ictKillZonePMSession,
    ictKillZoneOutsidePenalty: strategy.ictKillZoneOutsidePenalty ?? raw.ictKillZoneOutsidePenalty ?? DEFAULTS.ictKillZoneOutsidePenalty,
    ictKillZonePrimeBonus: strategy.ictKillZonePrimeBonus ?? raw.ictKillZonePrimeBonus ?? DEFAULTS.ictKillZonePrimeBonus,
    // ── ICT Risk Management ──
    ictRiskEnabled: strategy.ictRiskEnabled ?? raw.ictRiskEnabled ?? DEFAULTS.ictRiskEnabled,
    ictRiskBasePercent: strategy.ictRiskBasePercent ?? raw.ictRiskBasePercent ?? DEFAULTS.ictRiskBasePercent,
    ictRiskDrawdownHalving: strategy.ictRiskDrawdownHalving ?? raw.ictRiskDrawdownHalving ?? DEFAULTS.ictRiskDrawdownHalving,
    ictRiskMaxConsecLosses: strategy.ictRiskMaxConsecLosses ?? raw.ictRiskMaxConsecLosses ?? DEFAULTS.ictRiskMaxConsecLosses,
    ictRiskDailyLimit: strategy.ictRiskDailyLimit ?? raw.ictRiskDailyLimit ?? DEFAULTS.ictRiskDailyLimit,
    ictRiskWeeklyLimit: strategy.ictRiskWeeklyLimit ?? raw.ictRiskWeeklyLimit ?? DEFAULTS.ictRiskWeeklyLimit,
    ictRiskMaxTradesPerDay: strategy.ictRiskMaxTradesPerDay ?? raw.ictRiskMaxTradesPerDay ?? DEFAULTS.ictRiskMaxTradesPerDay,
    ictRiskFVGRuleOfTwoExit: strategy.ictRiskFVGRuleOfTwoExit ?? raw.ictRiskFVGRuleOfTwoExit ?? DEFAULTS.ictRiskFVGRuleOfTwoExit,
    // ── Limit Orders ──
    limitOrderEnabled: entry.limitOrderEnabled ?? raw.limitOrderEnabled ?? DEFAULTS.limitOrderEnabled,
    limitOrderExpiryMinutes: entry.limitOrderExpiryMinutes ?? raw.limitOrderExpiryMinutes ?? DEFAULTS.limitOrderExpiryMinutes,
    limitOrderMaxDistancePips: entry.limitOrderMaxDistancePips ?? raw.limitOrderMaxDistancePips ?? DEFAULTS.limitOrderMaxDistancePips,
    limitOrderMinDistancePips: entry.limitOrderMinDistancePips ?? raw.limitOrderMinDistancePips ?? DEFAULTS.limitOrderMinDistancePips,
    limitOrderPreferZone: entry.limitOrderPreferZone ?? raw.limitOrderPreferZone ?? DEFAULTS.limitOrderPreferZone,
        marketFillAtZone: entry.marketFillAtZone ?? raw.marketFillAtZone ?? DEFAULTS.marketFillAtZone,
    marketFillStrictATRMult: entry.marketFillStrictATRMult ?? raw.marketFillStrictATRMult ?? DEFAULTS.marketFillStrictATRMult,
    // ── Thesis Conviction Tracker ──
    thesisConvictionEnabled: strategy.thesisConvictionEnabled ?? raw.thesisConvictionEnabled ?? DEFAULTS.thesisConvictionEnabled,
    thesisConvictionMode: (strategy.thesisConvictionMode ?? raw.thesisConvictionMode ?? DEFAULTS.thesisConvictionMode) as "shadow" | "active",
    thesisConvictionDecayPerCycle: strategy.thesisConvictionDecayPerCycle ?? raw.thesisConvictionDecayPerCycle ?? DEFAULTS.thesisConvictionDecayPerCycle,
    thesisConvictionRecoveryPerCycle: strategy.thesisConvictionRecoveryPerCycle ?? raw.thesisConvictionRecoveryPerCycle ?? DEFAULTS.thesisConvictionRecoveryPerCycle,
    thesisConvictionRevokeThreshold: strategy.thesisConvictionRevokeThreshold ?? raw.thesisConvictionRevokeThreshold ?? DEFAULTS.thesisConvictionRevokeThreshold,
    thesisConvictionKillThreshold: strategy.thesisConvictionKillThreshold ?? raw.thesisConvictionKillThreshold ?? DEFAULTS.thesisConvictionKillThreshold,
  };
  return merged;
}

// ─── Safety Gates ───────────────────────────────────────────────────

async function runSafetyGates(
  supabase: any, userId: string, symbol: string, direction: string,
  analysis: any, config: any, account: any, openPositions: any[],
  dailyCandles: Candle[] | null,
  rateMap?: Record<string, number>,
  convictionCandles?: Candle[] | null,
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
    let convictionTFLabel = "entry";
    if (convictionCandles && convictionCandles.length >= 20) {
      const convictionStructure = analyzeMarketStructure(convictionCandles);
      s2f = convictionStructure.structureToFractal;
      // Determine label based on style for logging
      const style = config.tradingStyle?.mode || "day_trader";
      convictionTFLabel = style === "scalper" ? "15m" : style === "swing_trader" ? "4H" : "1H";
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
  if (openPositions.length >= config.maxOpenPositions) {
    gates.push({ passed: false, reason: `Max positions (${config.maxOpenPositions}) reached` });
  } else {
    gates.push({ passed: true, reason: `${openPositions.length}/${config.maxOpenPositions} positions` });
  }

  // Gate 5: Max per symbol + same-direction duplicate check
  const symbolPositions = openPositions.filter(p => p.symbol === symbol).length;
  const sameDirectionExists = openPositions.some(p => p.symbol === symbol && p.direction === direction);
  if (sameDirectionExists && !config.allowSameDirectionStacking) {
    gates.push({ passed: false, reason: `Already ${direction} on ${symbol} — no duplicate (enable stacking to allow)` });
  } else if (symbolPositions >= config.maxPerSymbol) {
    gates.push({ passed: false, reason: `Max ${config.maxPerSymbol} positions for ${symbol} reached` });
  } else {
    gates.push({ passed: true, reason: `${symbolPositions}/${config.maxPerSymbol} for ${symbol}${sameDirectionExists ? " (stacking allowed)" : ""}` });
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
    if (dailyLossPercent >= config.maxDailyLoss) {
      gates.push({ passed: false, reason: `Daily loss ${dailyLossPercent.toFixed(1)}% >= ${config.maxDailyLoss}% limit` });
    } else {
      gates.push({ passed: true, reason: `Daily loss ${dailyLossPercent.toFixed(1)}%` });
    }
  }

  // Gate 8: Max drawdown
  // Consolidation: When prop firm gate is active, it already enforces stricter drawdown
  // thresholds (trailing or fixed). Skip redundant check.
  if (propFirmActive) {
    gates.push({ passed: true, reason: `Drawdown delegated to prop firm gate (stricter thresholds)` });
  } else {
    const peakBalance = parseFloat(account.peak_balance || account.balance || "10000");
    const drawdownPercent = peakBalance > 0 ? ((peakBalance - balance) / peakBalance) * 100 : 0;
    if (drawdownPercent >= config.maxDrawdown) {
      gates.push({ passed: false, reason: `Drawdown ${drawdownPercent.toFixed(1)}% >= ${config.maxDrawdown}% limit` });
    } else {
      gates.push({ passed: true, reason: `Drawdown ${drawdownPercent.toFixed(1)}%` });
    }
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

  // Gate 10: Min R:R (spread + commission adjusted)
  // Subtract typical spread cost AND estimated commission cost from reward to get effective R:R.
  if (analysis.stopLoss && analysis.takeProfit) {
    const risk = Math.abs(analysis.lastPrice - analysis.stopLoss);
    const rawReward = Math.abs(analysis.takeProfit - analysis.lastPrice);
    const pairSpec = SPECS[symbol] || SPECS["EUR/USD"];
    const spreadCostInPrice = (pairSpec.typicalSpread ?? 1) * pairSpec.pipSize;
    // Estimate commission cost in price terms: commissionPerLot / (lotUnits * quoteToUSD)
    // This converts the dollar commission into price-movement equivalent
    const quoteToUSD = getQuoteToUSDRate(symbol, rateMap);
    const avgCommPerLot = (config as any)._avgCommissionPerLot ?? 0;
    const commCostInPrice = avgCommPerLot > 0 ? avgCommPerLot / (pairSpec.lotUnits * quoteToUSD) : 0;
    const totalCostInPrice = spreadCostInPrice + commCostInPrice;
    const effectiveReward = Math.max(0, rawReward - totalCostInPrice);
    const rawRR = risk > 0 ? rawReward / risk : 0;
    const effectiveRR = risk > 0 ? effectiveReward / risk : 0;
    const costDetail = avgCommPerLot > 0 ? `spread ${pairSpec.typicalSpread}p + comm $${avgCommPerLot.toFixed(1)}/lot` : `spread ${pairSpec.typicalSpread}p`;
    if (effectiveRR < config.minRiskReward) {
      gates.push({ passed: false, reason: `R:R ${rawRR.toFixed(2)} raw, ${effectiveRR.toFixed(2)} effective (${costDetail}) < ${config.minRiskReward} min` });
    } else {
      gates.push({ passed: true, reason: `R:R ${effectiveRR.toFixed(2)} effective (${rawRR.toFixed(2)} raw, ${costDetail})` });
    }
  } else {
    gates.push({ passed: false, reason: "No valid SL/TP for R:R check" });
  }

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
    if (recentTrades && recentTrades.length > 0) {
      const lastClose = new Date(recentTrades[0].closed_at).getTime();
      const elapsed = (Date.now() - lastClose) / 60000;
      if (elapsed < config.cooldownMinutes) {
        gates.push({ passed: false, reason: `Cooldown: ${Math.ceil(config.cooldownMinutes - elapsed)}min remaining for ${symbol}` });
      } else {
        gates.push({ passed: true, reason: `Cooldown passed (${Math.floor(elapsed)}min since last)` });
      }
    } else {
      gates.push({ passed: true, reason: "No recent trades — cooldown OK" });
    }
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
      if (consecutiveLosses >= config.maxConsecutiveLosses) {
        // Check if enough time has passed since the last loss to auto-reset (4 hours)
        const lastLossTime = new Date(recentHistory[0].closed_at).getTime();
        const hoursSinceLast = (Date.now() - lastLossTime) / (1000 * 60 * 60);
        const resetHours = 4;
        if (hoursSinceLast >= resetHours) {
          gates.push({ passed: true, reason: `${consecutiveLosses} consecutive losses but auto-reset after ${resetHours}h cooldown (${Math.floor(hoursSinceLast)}h elapsed)` });
        } else {
          const remaining = Math.ceil((resetHours - hoursSinceLast) * 60);
          gates.push({ passed: false, reason: `${consecutiveLosses} consecutive losses >= ${config.maxConsecutiveLosses} limit — auto-resets in ${remaining}min` });
        }
      } else {
        gates.push({ passed: true, reason: `${consecutiveLosses} consecutive losses` });
      }
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
    if (minPips > 0 && atrPips < minPips) {
      gates.push({ passed: false, reason: `ATR ${atrPips.toFixed(1)} pips below minimum ${minPips}` });
    } else if (maxPips > 0 && atrPips > maxPips) {
      gates.push({ passed: false, reason: `ATR ${atrPips.toFixed(1)} pips above maximum ${maxPips}` });
    } else {
      gates.push({ passed: true, reason: `ATR ${atrPips.toFixed(1)} pips within range` });
    }
  }

  // Gate 22: Correlation Filter — prevent conflicting/doubling correlated positions
  // Uses currency decomposition + SMT_PAIRS to detect:
  //   1. Anti-correlated conflict: long EUR/USD + long USD/CHF (betting against yourself)
  //   2. Over-correlated doubling: long EUR/USD + long GBP/USD (doubling USD exposure)
  // Config: correlationFilterEnabled, maxCorrelation (threshold), maxCorrelatedPositions
  if ((config as any).correlationFilterEnabled) {
    const maxCorrelatedPos = Number((config as any).maxCorrelatedPositions) || 1;
    const newPairCurrencies = parsePairCurrencies(symbol);
    const smtPair = SMT_PAIRS[symbol];

    // Track conflicts and correlations found
    let antiCorrelationConflict: string | null = null;
    let correlatedSameDirection: string[] = [];

    for (const pos of openPositions) {
      if (pos.symbol === symbol) continue; // same-symbol handled by Gate 5
      const posDir = pos.direction; // "long" or "short"

      // Check 1: Direct SMT pair conflict (e.g., EUR/USD vs GBP/USD, USD/JPY vs USD/CHF)
      if (smtPair && pos.symbol === smtPair) {
        // SMT pairs are positively correlated. Same direction = doubling exposure.
        // Opposite direction = hedging (usually unintentional, wastes margin).
        if (posDir !== direction) {
          antiCorrelationConflict = `${pos.symbol} (${posDir}) — SMT pair hedge conflict`;
        } else {
          correlatedSameDirection.push(`${pos.symbol} (${posDir})`);
        }
        continue;
      }

      // Check 2: Currency decomposition — detect shared currency exposure
      if (newPairCurrencies) {
        const [newBase, newQuote] = newPairCurrencies;
        const posCurrencies = parsePairCurrencies(pos.symbol);
        if (posCurrencies) {
          const [posBase, posQuote] = posCurrencies;

          // Determine effective exposure: what currency are you buying/selling?
          // Long EUR/USD = buying EUR, selling USD
          // Short EUR/USD = selling EUR, buying USD
          const newBuying = direction === "long" ? newBase : newQuote;
          const newSelling = direction === "long" ? newQuote : newBase;
          const posBuying = posDir === "long" ? posBase : posQuote;
          const posSelling = posDir === "long" ? posQuote : posBase;

          // Anti-correlation: buying what another position is selling (or vice versa) of the SAME currency
          // e.g., Long EUR/USD (buying EUR) + Short EUR/GBP (selling EUR) = conflicting EUR exposure
          if (newBuying === posSelling && newSelling === posBuying) {
            // Perfect hedge — buying and selling the same currencies in opposite directions
            antiCorrelationConflict = `${pos.symbol} (${posDir}) — opposite exposure on ${newBuying}/${newSelling}`;
          }

          // Positive correlation: buying the same currency in multiple pairs
          // e.g., Long EUR/USD (buying EUR) + Long EUR/GBP (buying EUR) = doubling EUR long exposure
          if (newBuying === posBuying && newSelling === posSelling) {
            correlatedSameDirection.push(`${pos.symbol} (${posDir}) — same ${newBuying} long / ${newSelling} short exposure`);
          } else if (newBuying === posBuying) {
            correlatedSameDirection.push(`${pos.symbol} (${posDir}) — both buying ${newBuying}`);
          } else if (newSelling === posSelling) {
            correlatedSameDirection.push(`${pos.symbol} (${posDir}) — both selling ${newSelling}`);
          }
        }
      }
    }

    // Evaluate results
    if (antiCorrelationConflict) {
      gates.push({ passed: false, reason: `Correlation conflict: ${direction} ${symbol} vs open ${antiCorrelationConflict}` });
    } else if (correlatedSameDirection.length >= maxCorrelatedPos) {
      gates.push({ passed: false, reason: `Correlated exposure limit: ${correlatedSameDirection.length} correlated positions >= ${maxCorrelatedPos} max — ${correlatedSameDirection.join("; ")}` });
    } else if (correlatedSameDirection.length > 0) {
      gates.push({ passed: true, reason: `Correlated positions: ${correlatedSameDirection.length}/${maxCorrelatedPos} — ${correlatedSameDirection.join("; ")}` });
    } else {
      gates.push({ passed: true, reason: `No correlated positions for ${symbol}` });
    }
  }

  // Gate 19: Tier 1 Minimum (must have at least 2 core factors)
  if (analysis.tieredScoring) {
    const ts = analysis.tieredScoring;
    if (config.tier1GateEnabled === false) {
      gates.push({ passed: true, reason: `Tier 1 gate DISABLED by config (${ts.tier1Count} core factors present)` });
    } else if (!ts.tier1GatePassed) {
      gates.push({ passed: false, reason: ts.tier1GateReason });
    } else {
      gates.push({ passed: true, reason: ts.tier1GateReason });
    }
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
      EdgeRuntime.waitUntil(
        runScanForUser(adminClient, userId, { isManualScan: true })
          .catch((e: any) => console.error("[manual_scan] background error", e))
      );
      return respond({ started: true, message: "Scan started" });
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
        .eq("user_id", userId).eq("bot_id", BOT_ID).eq("status", "pending")
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
      }).eq("order_id", orderId).eq("user_id", userId).eq("status", "pending");
      if (updateErr) return respond({ error: updateErr.message }, 500);
      return respond({ success: true });
    }

    // ── Setup Staging: Get only active (watching) staged setups ──
    if (action === "active_staged") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const { data } = await adminClient.from("staged_setups").select("*")
        .eq("user_id", userId).eq("bot_id", BOT_ID).eq("status", "watching")
        .order("current_score", { ascending: false });
      return respond(data || []);
    }

    // ── Management-Only Cron (1-minute cycle) ──
    // Refreshes prices, runs trailing/BE/partial TP, checks pending order fills/expiry.
    // Does NOT run the full scan or place new trades. Designed for pg_cron every 1 min.
    if (action === "manage") {
      const { data: allAccounts } = await adminClient.from("paper_accounts").select("*")
        .eq("is_running", true).eq("kill_switch_active", false);
      const accounts = (allAccounts || []).filter((a: any) => !a.bot_id || a.bot_id === BOT_ID);
      if (!accounts || accounts.length === 0) return respond({ message: "No active accounts", managed: 0 });
      const results = [];
      for (const account of accounts) {
        try {
          const result = await runScanForUser(adminClient, account.user_id, { isManagementOnly: true });
          results.push({ userId: account.user_id, ...result });
        } catch (e: any) {
          results.push({ userId: account.user_id, error: e.message });
        }
      }
      return respond({ managed: results.length, results });
    }

     if (action === "scan" || action === "cron") {
      const { data: allAccounts } = await adminClient.from("paper_accounts").select("*")
        .eq("is_running", true).eq("kill_switch_active", false);
      // Filter to SMC bot accounts only (or legacy accounts without bot_id)
      const accounts = (allAccounts || []).filter((a: any) => !a.bot_id || a.bot_id === BOT_ID);
      if (!accounts || accounts.length === 0) return respond({ message: "No active accounts", scanned: 0 });
      // Run scans in the background via waitUntil so the HTTP request can return
      // immediately. Without this, the cron caller's request timeout (~150s) was
      // killing the function mid-scan, leaving no scan_logs row written.
      EdgeRuntime.waitUntil((async () => {
        for (const account of accounts) {
          try {
            await runScanForUser(adminClient, account.user_id);
          } catch (e: any) {
            console.error(`[scan] background error for ${account.user_id}:`, e?.message || e);
          }
        }
      })());
      return respond({ started: true, accounts: accounts.length, message: "Scan started in background" });
    }

    console.warn("[bot-scanner] Unknown action received:", JSON.stringify(body));
    return respond({ error: "Unknown action", received: action, bodyKeys: Object.keys(body || {}) }, 400);
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function runScanForUser(supabase: any, userId: string, opts?: { isManualScan?: boolean; isManagementOnly?: boolean }) {
  const specCache: Record<string, { minVolume: number; maxVolume: number; volumeStep: number }> = {};
  const balanceCache: Record<string, number> = {};
  const brokerHealthMap: Record<string, BrokerHealth> = {}; // Circuit breaker state per connection (in-memory, resets each invocation)
  const MAX_BROKER_RISK_PERCENT = 5; // hard safety cap per broker per trade
  const scanCycleId = crypto.randomUUID();

  // ── Data Cache: fetch candles once per (symbol, interval), reuse across game plan + scan loop ──
  const scanCache = createScanCache(fetchCandles);
  const cachedFetch = (sym: string, interval: string, range: string) => scanCache.get(sym, interval, range);

  // ── Scan overlap lock (90s lease) ──
  // Prevents two cron invocations from racing — second cycle would otherwise see the first's
  // in-flight trades as orphans or double-process the same signals.
  // Management-only runs skip the lock entirely — they're lightweight and shouldn't block scans.
  //
  // For manual scans: force-clear any stale lock first. The user explicitly clicked
  // "Scan Now" — they should never be blocked by a lock left behind by a crashed cron scan.
  if (!opts?.isManagementOnly) {
  if (opts?.isManualScan) {
    await supabase
      .from("paper_accounts")
      .update({ scan_lock_until: null })
      .eq("user_id", userId);
    console.log(`[scan-lock] manual scan — cleared any existing lock for ${userId}`);
  }

  const lockHorizon = new Date(Date.now() + 90_000).toISOString();
  const nowIso = new Date().toISOString();
  const { data: lockRows, error: lockErr } = await supabase
    .from("paper_accounts")
    .update({ scan_lock_until: lockHorizon })
    .eq("user_id", userId)
    .or(`scan_lock_until.is.null,scan_lock_until.lt.${nowIso}`)
    .select("user_id");
  if (lockErr) console.warn(`[scan-lock] update error for ${userId}: ${lockErr.message}`);
  if (!lockRows || lockRows.length === 0) {
    console.log(`[scan-lock] skipped — overlap detected for user ${userId}`);
    return { pairsScanned: 0, signalsFound: 0, tradesPlaced: 0, skippedReason: "overlap", scanCycleId };
  }
  } // end scan-lock block (skipped for management-only)

  let account: any = null;
  try {
  const config = await loadConfig(supabase, userId);

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
        // Release the scan lock before returning
        await supabase.from("paper_accounts").update({ scan_lock_until: null }).eq("user_id", userId);
        return { pairsScanned: 0, signalsFound: 0, tradesPlaced: 0, skippedReason: `interval (${Math.ceil(intervalMinutes - elapsedMin)}min remaining)`, scanCycleId };
      }
    }
  }

  // ── Resolve Trading Style ──
  const resolvedStyle = config.tradingStyle?.mode || "day_trader";

  // Apply style overrides as DEFAULTS — user-explicit values always win.
  // The management fields (trailing, BE, partial, maxHold) may have been
  // explicitly set by the user to accommodate broker-specific conditions.
  // We only fill in style defaults for fields the user hasn't touched.
  if (STYLE_OVERRIDES[resolvedStyle]) {
    const styleDefaults = STYLE_OVERRIDES[resolvedStyle];
    // These fields should NEVER be overwritten by style if the user set them:
    const userProtectedFields = new Set([
      "minConfluence",
      // I2 Fix: tpRatio is user-tunable — don't silently overwrite with style default
      "tpRatio",
      // Management fields the user can tune per-broker:
      "trailingStopEnabled", "trailingStopPips", "trailingStopActivation",
      "breakEvenEnabled", "breakEvenPips", "breakEvenOffsetPips",
      "partialTPEnabled", "partialTPPercent", "partialTPLevel",
      "maxHoldHours",
    ]);
    // I1 Fix: Track provenance of each config field for debugging and transparency.
    const styleApplied: string[] = [];
    const userKept: string[] = [];
    for (const [key, val] of Object.entries(styleDefaults)) {
      if (userProtectedFields.has(key)) {
        // Only apply style default if user didn't explicitly set this field
        // (i.e., the value is still the global DEFAULTS fallback)
        if ((config as any)[key] === (DEFAULTS as any)[key]) {
          (config as any)[key] = val;
          styleApplied.push(`${key}=${val}`);
        } else {
          // User explicitly set a different value — keep it
          userKept.push(`${key}=${(config as any)[key]} (style wanted ${val})`);
        }
      } else {
        // Non-protected fields (entryTimeframe, htfTimeframe, tpRatio, slBufferPips)
        // always come from the style
        (config as any)[key] = val;
        styleApplied.push(`${key}=${val}`);
      }
    }
    if (styleApplied.length > 0) console.log(`[config] Style "${resolvedStyle}" applied: ${styleApplied.join(", ")}`);
    if (userKept.length > 0) console.log(`[config] User-protected overrides kept: ${userKept.join(", ")}`);
  }

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
  if (!account) return { error: "No paper account" };

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
      if (activeActions.length > 0) {
        console.log(`[scan ${scanCycleId}] Trade management: ${activeActions.length} actions taken on ${openPosArr.length} positions`);
        for (const a of activeActions) {
          console.log(`  [mgmt] ${a.symbol}: ${a.action} — ${a.reason}`);
        }
        // ── BROKER SYNC: Mirror SL changes to MetaAPI immediately ──
        // Without this, the Telegram fires but the broker SL stays stale until paper-trading cron picks it up.
        if (account.execution_mode === "live") {
          const slActions = activeActions.filter(a => a.newSL != null);
          if (slActions.length > 0) {
            const { data: liveConns } = await supabase.from("broker_connections")
              .select("*").eq("user_id", userId).in("broker_type", ["metaapi", "oanda"]).eq("is_active", true);
            if (liveConns && liveConns.length > 0) {
              for (const a of slActions) {
                const pos = openPosArr.find((p: any) => p.position_id === a.positionId);
                if (!pos) continue;
                const mirroredIds: string[] = Array.isArray(pos.mirrored_connection_ids) ? pos.mirrored_connection_ids : [];
                // B2 Fix: Skip SL modify when no mirrored_connection_ids instead of trying all connections.
                // Legacy positions without mirrored IDs should be managed conservatively to avoid
                // modifying SL on broker positions that were not opened by this scanner.
                if (mirroredIds.length === 0) {
                  console.warn(`[mgmt-broker] ${a.symbol} (${a.positionId}): no mirrored_connection_ids — skipping SL modify (B2 safety)`);
                  continue;
                }
                const connsToModify = liveConns.filter((c: any) => mirroredIds.includes(c.id));
                const tp = parseFloat(pos.take_profit || "0") || undefined;
                // Apply safety buffer (1 pip) to avoid premature stops from spread
                const spec = SPECS[a.symbol] || SPECS["EUR/USD"];
                const safetyBuffer = spec.pipSize;
                const adjustedSL = pos.direction === "long" ? a.newSL! - safetyBuffer : a.newSL! + safetyBuffer;
                for (const conn of connsToModify) {
                  try {
                    // ── OANDA: route through broker-execute modify_trade ──
                    if (conn.broker_type === "oanda") {
                      // First fetch open trades to find the matching OANDA trade ID
                      const tradesRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/broker-execute`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                        body: JSON.stringify({ action: "open_trades", connectionId: conn.id }),
                      });
                      if (!tradesRes.ok) { console.warn(`[mgmt-broker] ${conn.display_name}: OANDA open_trades fetch failed ${tradesRes.status}`); continue; }
                      const oandaTrades: any[] = await tradesRes.json();
                      // Match by instrument (EUR_USD format) + direction
                      const oandaInstrument = a.symbol.replace("/", "_");
                      const oandaTrade = oandaTrades.find((t: any) => {
                        const instMatch = t.instrument === oandaInstrument ||
                          t.instrument?.replace("_", "").toUpperCase() === a.symbol.replace("/", "").toUpperCase();
                        const dirMatch = (parseFloat(t.currentUnits || t.initialUnits || "0") > 0 && pos.direction === "long") ||
                          (parseFloat(t.currentUnits || t.initialUnits || "0") < 0 && pos.direction === "short");
                        return instMatch && dirMatch;
                      });
                      if (!oandaTrade) { console.warn(`[mgmt-broker] ${conn.display_name}: OANDA trade not found for ${a.symbol} SL modify`); continue; }
                      // Route SL modification through broker-execute
                      const modRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/broker-execute`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                        body: JSON.stringify({
                          action: "modify_trade",
                          connectionId: conn.id,
                          tradeId: oandaTrade.id,
                          stopLoss: adjustedSL,
                          ...(tp && tp > 0 ? { takeProfit: tp } : {}),
                          symbol: a.symbol,
                        }),
                      });
                      const modBody = await modRes.text();
                      if (modRes.ok && !modBody.includes('"error"')) {
                        console.log(`[mgmt-broker] ${conn.display_name}: OANDA SL modified to ${adjustedSL} for ${a.symbol} (${a.action})`);
                      } else {
                        console.warn(`[mgmt-broker] ${conn.display_name}: OANDA SL modify failed: ${modBody.slice(0, 300)}`);
                      }
                      continue;
                    }
                    // ── MetaAPI: direct API call ──
                    let authToken = conn.api_key;
                    let metaAccountId = conn.account_id;
                    if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
                      authToken = conn.account_id;
                      metaAccountId = conn.api_key;
                    }
                    // Find broker position by comment tag
                    const { res: posRes, body: posBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/positions`);
                    if (!posRes.ok) { console.warn(`[mgmt-broker] ${conn.display_name}: positions fetch failed ${posRes.status}`); continue; }
                    const brokerPositions: any[] = JSON.parse(posBody);
                    const commentTag = `paper:${a.positionId}`;
                    const shortTag = commentTag.slice(0, 28);
                    let brokerPos = brokerPositions.find((p: any) =>
                      p.comment && (p.comment.includes(commentTag) || p.comment.startsWith(shortTag))
                    );
                    // B1 Fix: Removed symbol+direction fallback — it could match the wrong position
                    // when multiple positions exist for the same symbol+direction.
                    // Now only matches by comment tag. If comment was truncated by broker, skip.
                    if (!brokerPos) {
                      console.warn(`[mgmt-broker] ${conn.display_name}: No comment-tag match for paper:${a.positionId} on ${a.symbol} — skipping SL modify (B1 safety)`);
                      continue;
                    }
                    const modifyBody: any = {
                      actionType: "POSITION_MODIFY",
                      positionId: brokerPos.id,
                      stopLoss: adjustedSL,
                    };
                    if (tp && tp > 0) modifyBody.takeProfit = tp;
                    const { res, body: resBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/trade`, {
                      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(modifyBody),
                    });
                    if (res.ok) {
                      console.log(`[mgmt-broker] ${conn.display_name}: SL modified to ${adjustedSL} for ${a.symbol} (${a.action})`);
                    } else {
                      console.warn(`[mgmt-broker] ${conn.display_name}: SL modify failed [${res.status}]: ${resBody.slice(0, 300)}`);
                    }
                  } catch (e: any) {
                    console.warn(`[mgmt-broker] ${conn.display_name}: error modifying SL for ${a.symbol}: ${e?.message}`);
                  }
                }
              }
            }
          }
          // ── Partial TP broker sync ──
          const partialActions = activeActions.filter(a => a.action === "partial_enabled");
          if (partialActions.length > 0) {
            const { data: liveConnsP } = await supabase.from("broker_connections")
              .select("*").eq("user_id", userId).in("broker_type", ["metaapi", "oanda"]).eq("is_active", true);
            if (liveConnsP && liveConnsP.length > 0) {
              for (const a of partialActions) {
                const pos = openPosArr.find((p: any) => p.position_id === a.positionId);
                if (!pos) continue;
                const mirroredIds: string[] = Array.isArray(pos.mirrored_connection_ids) ? pos.mirrored_connection_ids : [];
                // B2 Fix: Skip partial TP when no mirrored_connection_ids (same safety as SL modify)
                if (mirroredIds.length === 0) {
                  console.warn(`[mgmt-broker] ${a.symbol} (${a.positionId}): no mirrored_connection_ids — skipping partial TP (B2 safety)`);
                  continue;
                }
                const connsToClose = liveConnsP.filter((c: any) => mirroredIds.includes(c.id));
                // Parse partial TP percent from the action's attribution
                const partialPercent = a.attribution?.detail?.match(/(\d+)%/)?.[1];
                const closeFraction = partialPercent ? parseInt(partialPercent) / 100 : 0.5;
                for (const conn of connsToClose) {
                  try {
                    // ── OANDA: route partial close through broker-execute ──
                    if (conn.broker_type === "oanda") {
                      // Fetch open trades to find the matching OANDA trade ID + current units
                      const tradesRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/broker-execute`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                        body: JSON.stringify({ action: "open_trades", connectionId: conn.id }),
                      });
                      if (!tradesRes.ok) { console.warn(`[mgmt-broker] ${conn.display_name}: OANDA open_trades fetch failed ${tradesRes.status}`); continue; }
                      const oandaTrades: any[] = await tradesRes.json();
                      const oandaInstrument = a.symbol.replace("/", "_");
                      const oandaTrade = oandaTrades.find((t: any) => {
                        const instMatch = t.instrument === oandaInstrument ||
                          t.instrument?.replace("_", "").toUpperCase() === a.symbol.replace("/", "").toUpperCase();
                        const dirMatch = (parseFloat(t.currentUnits || t.initialUnits || "0") > 0 && pos.direction === "long") ||
                          (parseFloat(t.currentUnits || t.initialUnits || "0") < 0 && pos.direction === "short");
                        return instMatch && dirMatch;
                      });
                      if (!oandaTrade) { console.warn(`[mgmt-broker] ${conn.display_name}: OANDA trade not found for ${a.symbol} partial close`); continue; }
                      // Calculate partial close units (OANDA uses units, not lots)
                      const currentUnits = Math.abs(parseFloat(oandaTrade.currentUnits || oandaTrade.initialUnits || "0"));
                      const closeUnits = Math.round(currentUnits * closeFraction);
                      if (closeUnits <= 0) { console.warn(`[mgmt-broker] ${conn.display_name}: OANDA closeUnits=0 for ${a.symbol}`); continue; }
                      // Route partial close through broker-execute close_trade with units param
                      const closeRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/broker-execute`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                        body: JSON.stringify({ action: "close_trade", connectionId: conn.id, tradeId: oandaTrade.id, units: closeUnits }),
                      });
                      const closeBody = await closeRes.text();
                      if (closeRes.ok && !closeBody.includes('"error"')) {
                        console.log(`[mgmt-broker] ${conn.display_name}: OANDA partial close ${closeUnits} units for ${a.symbol}`);
                      } else {
                        console.warn(`[mgmt-broker] ${conn.display_name}: OANDA partial close failed: ${closeBody.slice(0, 300)}`);
                      }
                      continue;
                    }
                    // ── MetaAPI: direct API call ──
                    let authToken = conn.api_key;
                    let metaAccountId = conn.account_id;
                    if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
                      authToken = conn.account_id;
                      metaAccountId = conn.api_key;
                    }
                    const { res: posRes, body: posBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/positions`);
                    if (!posRes.ok) continue;
                    const brokerPositions: any[] = JSON.parse(posBody);
                    const commentTag = `paper:${a.positionId}`;
                    const shortTag = commentTag.slice(0, 28);
                    let brokerPos = brokerPositions.find((p: any) =>
                      p.comment && (p.comment.includes(commentTag) || p.comment.startsWith(shortTag))
                    );
                    if (!brokerPos) {
                      const brokerSymbol = resolveSymbol(a.symbol, conn);
                      brokerPos = brokerPositions.find((p: any) =>
                        (p.symbol === brokerSymbol || p.symbol === a.symbol.replace("/", "") ||
                         p.symbol?.replace(/[._\-]/g, "").toUpperCase() === a.symbol.replace("/", "").toUpperCase()) &&
                        ((p.type === "POSITION_TYPE_BUY" && pos.direction === "long") ||
                         (p.type === "POSITION_TYPE_SELL" && pos.direction === "short"))
                      );
                    }
                    if (!brokerPos) { console.warn(`[mgmt-broker] ${conn.display_name}: position not found for ${a.symbol} partial close`); continue; }
                    const brokerVolume = brokerPos.volume || brokerPos.currentVolume || 0;
                    const closeVolume = Math.max(0.01, Math.round(brokerVolume * closeFraction * 100) / 100);
                    const { res, body: resBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/trade`, {
                      method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId: brokerPos.id, volume: closeVolume }),
                    });
                    if (res.ok) {
                      console.log(`[mgmt-broker] ${conn.display_name}: partial close ${closeVolume} lots for ${a.symbol}`);
                    } else {
                      console.warn(`[mgmt-broker] ${conn.display_name}: partial close failed [${res.status}]: ${resBody.slice(0, 300)}`);
                    }
                  } catch (e: any) {
                    console.warn(`[mgmt-broker] ${conn.display_name}: error partial closing ${a.symbol}: ${e?.message}`);
                  }
                }
              }
            }
          }
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
              (a.newSL ? `<b>New SL:</b> ${a.newSL}\n` : "") +
              (a.newTP ? `<b>New TP:</b> ${a.newTP}\n` : "") +
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
            .select("*").eq("user_id", userId).eq("broker_type", "metaapi")
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

  // ── Thesis Validation: Load last game plan for pending order checks ──
  // This runs BEFORE the game plan generation section (which is after management-only return).
  // One lightweight DB query to get the most recent game plan for thesis validation.
  let _lastGamePlanForValidation: SessionGamePlan | null = null;
  if ((config as any).thesisValidationEnabled !== false) {
    try {
      const { data: recentGPLogs } = await supabase
        .from("scan_logs")
        .select("details_json")
        .eq("user_id", userId)
        .eq("bot_id", BOT_ID)
        .order("created_at", { ascending: false })
        .limit(20);
      const gpLog = (recentGPLogs || []).find((log: any) => log.details_json?.type === "game_plan");
      if (gpLog?.details_json) {
        const cached = gpLog.details_json;
        _lastGamePlanForValidation = {
          session: cached.session,
          generatedAt: cached.generated_at,
          plans: cached.plans || [],
          focusPairs: cached.focus_pairs || [],
          newsEvents: cached.newsEvents || [],
          summary: cached.summary || "",
        } as SessionGamePlan;
      }
    } catch (gpErr: any) {
      // Fail-open: if game plan load fails, thesis validation still runs (just without GP check)
      console.warn(`[scan ${scanCycleId}] Thesis validation: failed to load game plan: ${gpErr?.message}`);
    }
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
        const pendingCandles = await cachedFetch(pending.symbol, config.entryTimeframe || "15min", "5d");
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
            status: "cancelled",
            cancel_reason: `Price ${currentPrice} breached SL ${slLevel}`,
            resolved_at: new Date().toISOString(),
          }).eq("order_id", pending.order_id).eq("user_id", userId);
          pendingCancelled++;
          console.log(`[pending] Cancelled ${pending.symbol} long — price ${currentPrice} below SL ${slLevel}`);
          continue;
        }
        if (pending.direction === "short" && currentPrice > slLevel) {
          await supabase.from("pending_orders").update({
            status: "cancelled",
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
        // Fail-open: errors/missing data never cause cancellation.
        // ═══════════════════════════════════════════════════════════════════
        if ((config as any).thesisValidationEnabled !== false) {
          try {
            // Fetch D1/4H/1H candles for direction check (cached if full scan)
            const [tvDaily, tvH4, tvH1] = await Promise.all([
              cachedFetch(pending.symbol, "1d", "1y"),
              cachedFetch(pending.symbol, "4h", "1mo"),
              cachedFetch(pending.symbol, "1h", "5d"),
            ]);
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
                dailyCandles: tvDaily.length >= 20 ? tvDaily : null,
                h4Candles: tvH4.length >= 20 ? tvH4 : null,
                h1Candles: tvH1.length >= 20 ? tvH1 : null,
              },
            );
            if (!thesisResult.valid) {
              await supabase.from("pending_orders").update({
                status: "cancelled",
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
        // States: "pending" → "awaiting_confirmation" → "filled"/"cancelled"
        // When price touches the zone, instead of immediately filling, we
        // transition to "awaiting_confirmation" and wait for a 5m CHoCH
        // confirming reversal before entering at live price.
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
            console.log(`[pending] ${pending.symbol} ${pending.direction} — ZONE TOUCHED @ ${entryPrice}, entering confirmation hunt mode (5m CHoCH)`);

            // Send Telegram notification: zone touched, hunting confirmation
            if (telegramChatIds.length > 0 && shouldNotify("zone_touched")) {
              const emoji = pending.direction === "long" ? "🟡" : "🟡";
              const msg = `${emoji} <b>Zone Touched — Hunting Confirmation</b>\n\n` +
                `<b>Symbol:</b> ${pending.symbol}\n` +
                `<b>Direction:</b> ${pending.direction.toUpperCase()}\n` +
                `<b>Zone:</b> ${pending.entry_zone_type} [${parseFloat(pending.entry_zone_low || "0").toFixed(5)} - ${parseFloat(pending.entry_zone_high || "0").toFixed(5)}]\n` +
                `<b>Waiting for:</b> ${pending.direction === "short" ? "Bearish" : "Bullish"} CHoCH on 5m\n` +
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

        // ── Branch B: Order is in "awaiting_confirmation" — check for CHoCH ──
        if (pending.status === "awaiting_confirmation") {
          pendingConfirmationHunting++;

          // Check if impulse is broken (zone invalidation)
          if (impulseData && isImpulseBroken(currentPrice, impulseData.high, impulseData.low, pending.direction as "long" | "short")) {
            await supabase.from("pending_orders").update({
              status: "cancelled",
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
            await supabase.from("pending_orders").update({
              status: "pending",
              zone_touch_time: null,
              confirmation_attempts: attempts,
            }).eq("order_id", pending.order_id).eq("user_id", userId);
            pendingConfirmationHunting--;
            console.log(`[pending] ${pending.symbol} ${pending.direction} — price left zone (${currentPrice}), reset to pending (attempt ${attempts})`);
            continue;
          }

          // Fetch 5m candles for CHoCH detection
          const confirm5mCandles = await cachedFetch(pending.symbol, "5m", "5d");
          if (confirm5mCandles.length < 10) {
            console.log(`[pending] ${pending.symbol} — insufficient 5m candles for confirmation (${confirm5mCandles.length})`);
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

          // Run zone confirmation detection (delegates to confirmationHierarchy first, falls back to legacy tiers)
          const confirmationSignal = detectZoneConfirmation(
            confirm5mCandles,
            pending.direction as "long" | "short",
            DEFAULT_ZONE_CONFIRMATION_CONFIG,
            zoneTouchIdx,
            pending.symbol,
            (zoneLow > 0 && zoneHigh > 0) ? { zoneHigh, zoneLow } : undefined,
          );

          if (!confirmationSignal) {
            // No confirmation yet — keep hunting (all 3 tiers checked)
            console.log(`[pending] ${pending.symbol} ${pending.direction} — awaiting confirmation (no tier passed)`);
            continue;
          }

          // ── Tier gate: require Tier 1 when no refined zone is available ──
          // Without a refined zone, we're watching a broad HTF zone (20-30 pips).
          // Tier 2 (wick-based CHoCH) and Tier 3 (reversal pattern) are too weak
          // for such an imprecise area. Only a close-based CHoCH (Tier 1) provides
          // enough evidence that the level is holding.
          if (!hasRefZone && confirmationSignal.tier !== 1) {
            console.log(`[pending] ${pending.symbol} ${pending.direction} — T${confirmationSignal.tier} signal rejected (no refined zone, Tier 1 required)`);
            continue;
          }

          // ═══════════════════════════════════════════════════════════════
          // CHoCH CONFIRMED! Enter the trade at live price.
          // ═══════════════════════════════════════════════════════════════
          console.log(`[pending] ${pending.symbol} ${pending.direction} — CONFIRMED! ${formatConfirmationSummary(confirmationSignal)}`);
          console.log(`[pending] Confirmation tier: ${confirmationSignal.tier}, type: ${confirmationSignal.type}`);

          // L3 Fix: Check Gate 4/5 (max positions, max per symbol) at fill time.
          const currentOpenCount = openPosArr.length;
          const currentSymbolCount = openPosArr.filter((p: any) => p.symbol === pending.symbol).length;
          if (currentOpenCount >= (parseInt(String(config.maxOpenPositions), 10) || 3)) {
            console.log(`[pending] SKIPPED confirmed fill ${pending.symbol} ${pending.direction} — max open positions reached (${currentOpenCount}/${config.maxOpenPositions})`);
            await supabase.from("pending_orders").update({
              status: "cancelled",
              cancel_reason: `Max open positions reached (${currentOpenCount}/${config.maxOpenPositions}) at confirmation time`,
              resolved_at: new Date().toISOString(),
            }).eq("order_id", pending.order_id).eq("user_id", userId);
            pendingCancelled++;
            continue;
          }
          if (currentSymbolCount >= (config.maxPerSymbol || 2)) {
            console.log(`[pending] SKIPPED confirmed fill ${pending.symbol} ${pending.direction} — max per symbol reached (${currentSymbolCount}/${config.maxPerSymbol})`);
            await supabase.from("pending_orders").update({
              status: "cancelled",
              cancel_reason: `Max per symbol reached (${currentSymbolCount}/${config.maxPerSymbol}) at confirmation time`,
              resolved_at: new Date().toISOString(),
            }).eq("order_id", pending.order_id).eq("user_id", userId);
            pendingCancelled++;
            continue;
          }

          // Confirmation is go/no-go — fill at current market price (already inside refined zone)
          const actualFillPrice = currentPrice;
          console.log(`[pending] CONFIRMED FILL ${pending.symbol} ${pending.direction} — confirmed @ refined zone, fill at ${actualFillPrice} (zone entry was ${entryPrice})`);


          const positionId = pending.order_id;
          const orderId = crypto.randomUUID().slice(0, 8);
          const nowStr = new Date().toISOString();
          const exitFlags = pending.exit_flags || {};

          // Build signal_reason with limit order provenance + confirmation data
          let parsedSignalReason: any = {};
          try { parsedSignalReason = typeof pending.signal_reason === "string" ? JSON.parse(pending.signal_reason) : (pending.signal_reason || {}); } catch {}
          const signalReason = {
            ...parsedSignalReason,
            filledFromLimitOrder: true,
            confirmationEntry: true,
            confirmation: {
              type: confirmationSignal.type,
              tier: confirmationSignal.tier,
              price: confirmationSignal.price,
              displacement: confirmationSignal.displacement,
              significance: confirmationSignal.significance,
              closeBased: confirmationSignal.closeBased,
              supportingSignals: confirmationSignal.supportingSignals,
              zoneTouchTime: pending.zone_touch_time,
              confirmationAttempts: pending.confirmation_attempts || 0,
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
          };

          await supabase.from("paper_positions").insert({
            user_id: userId,
            position_id: positionId,
            symbol: pending.symbol,
            direction: pending.direction,
            size: pending.size.toString(),
            entry_price: actualFillPrice.toString(),  // L1: use actual fill price, not limit price
            current_price: currentPrice.toString(),
            stop_loss: pending.stop_loss.toString(),
            take_profit: pending.take_profit.toString(),
            open_time: nowStr,
            signal_reason: JSON.stringify(signalReason),
            signal_score: pending.signal_score?.toString() || "0",
            order_id: orderId,
            position_status: "open",
            bot_id: BOT_ID,
            order_type: "limit",
            trigger_price: entryPrice.toString(),
          });

          await supabase.from("trade_reasonings").insert({
            user_id: userId,
            position_id: positionId,
            symbol: pending.symbol,
            direction: pending.direction,
            confluence_score: Math.round(parseFloat(pending.signal_score || "0")),
            summary: `[CONFIRMED ENTRY] ${pending.from_watchlist ? "[WATCHLIST] " : ""}${confirmationSignal.type} @ ${actualFillPrice.toFixed(5)} (zone: ${pending.entry_zone_type}, limit was ${entryPrice})`,
            bias: pending.direction === "long" ? "bullish" : "bearish",
            session: "confirmation_fill",
            timeframe: "5m",
          });

          await supabase.from("pending_orders").update({
            status: "filled",
            fill_reason: `Confirmed ${confirmationSignal.type} @ ${actualFillPrice.toFixed(5)} (displacement: ${confirmationSignal.displacement.toFixed(2)}, signals: ${confirmationSignal.supportingSignals.join(", ")})`,
            filled_at: nowStr,
            resolved_at: nowStr,
          }).eq("order_id", pending.order_id).eq("user_id", userId);

          pendingFilled++;
          tradesPlaced++;

          openPosArr.push({ symbol: pending.symbol, size: pending.size.toString(), entry_price: actualFillPrice.toString(), direction: pending.direction, position_id: positionId, position_status: "open", order_id: orderId, open_time: nowStr, signal_score: pending.signal_score?.toString() || "0" });

          // Send Telegram notification for confirmed entry
          if (telegramChatIds.length > 0 && shouldNotify("confirmed_entry")) {
            const emoji = pending.direction === "long" ? "🟢" : "🔴";
            const mode = account.execution_mode === "live" ? "LIVE" : "PAPER";
            const confTierLabel = confirmationSignal.tier ? ` T${confirmationSignal.tier}` : "";
            const confSupporting = Array.isArray(confirmationSignal.supportingSignals) && confirmationSignal.supportingSignals.length > 0
              ? `\n<b>Supporting:</b> ${confirmationSignal.supportingSignals.map((s: string) => s.replace(/_/g, " ")).join(", ")}`
              : "";
            const confAttempts = (pending.confirmation_attempts || 0) > 0
              ? ` | ${pending.confirmation_attempts} attempt${pending.confirmation_attempts > 1 ? "s" : ""}`
              : "";
            const msg = `${emoji} <b>${mode} CONFIRMED Entry${confTierLabel}</b>\n\n` +
              `<b>Symbol:</b> ${pending.symbol}\n` +
              `<b>Direction:</b> ${pending.direction.toUpperCase()}\n` +
              `<b>Size:</b> ${pending.size} lots\n` +
              `<b>Entry:</b> ${actualFillPrice.toFixed(5)}\n` +
              `<b>SL:</b> ${pending.stop_loss}\n` +
              `<b>TP:</b> ${pending.take_profit}\n` +
              `<b>Score:</b> ${pending.signal_score}\n\n` +
              `🎯 <b>Confirmation</b>\n` +
              `<b>Signal:</b> ${confirmationSignal.type} (disp: ${confirmationSignal.displacement.toFixed(2)}×${confirmationSignal.significance ? ", " + confirmationSignal.significance : ""})${confAttempts}` +
              confSupporting + `\n` +
              `<b>Zone:</b> ${pending.entry_zone_type} [${parseFloat(pending.entry_zone_low || "0").toFixed(5)} – ${parseFloat(pending.entry_zone_high || "0").toFixed(5)}]` +
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
            const { data: connections } = await supabase.from("broker_connections")
              .select("*").eq("user_id", userId).in("broker_type", ["metaapi", "oanda"]).eq("is_active", true);
            if (connections && connections.length > 0) {
              const mirroredConnIds: string[] = [];
              for (const conn of connections) {
                try {
                  // B4 Fix: Add spread check before mirroring limit fills to brokers.
                  // Market order path checks spread; limit fills should too.
                  let metaAccountIdForSpread: string | undefined;
                  let authTokenForSpread: string | undefined;
                  if (conn.broker_type === "metaapi") {
                    metaAccountIdForSpread = conn.account_id;
                    authTokenForSpread = conn.api_key;
                    if (metaAccountIdForSpread?.startsWith("eyJ") && authTokenForSpread && /^[0-9a-f-]{36}$/.test(authTokenForSpread)) {
                      authTokenForSpread = conn.account_id;
                      metaAccountIdForSpread = conn.api_key;
                    }
                  }
                  const spreadResult = await fetchBrokerSpread(conn, pending.symbol, config, metaAccountIdForSpread, authTokenForSpread);
                  if (spreadResult && !spreadResult.passed) {
                    console.warn(`[limit-fill-mirror] ${conn.display_name}: spread too wide (${spreadResult.spreadPips.toFixed(2)}p > ${spreadResult.effectiveMax}p) — skipping broker mirror for ${pending.symbol} (B4 safety)`);
                    continue;
                  }

                  if (conn.broker_type !== "metaapi") {
                    const exRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/broker-execute`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
                      body: JSON.stringify({ action: "place_order", connectionId: conn.id, symbol: pending.symbol, direction: pending.direction, size: parseFloat(pending.size), stopLoss: parseFloat(pending.stop_loss), takeProfit: parseFloat(pending.take_profit), userId }),
                    });
                    if (exRes.ok) { mirroredConnIds.push(conn.id); }
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
                  const { res: mt5Res } = await metaFetch(metaAccountId, authToken, (base: string) => `${base}/trade`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mt5Body) });
                  if (mt5Res.ok) { mirroredConnIds.push(conn.id); }
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
    // Determine broker equity — fetch from MetaAPI whenever a broker connection exists
    // (even in paper mode) so prop firm compliance tracks the real MT5 account
    let brokerEquity: number | undefined;
    if (_scanBrokerConn) {
      try {
        const metaAccountId = _scanBrokerConn.account_id;
        const authToken = _scanBrokerConn.api_key;
        const metaBase = `https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${metaAccountId}`;
        const eqRes = await fetch(`${metaBase}/account-information`, {
          headers: { "auth-token": authToken },
        });
        if (eqRes.ok) {
          const eqData = await eqRes.json();
          brokerEquity = parseFloat(eqData.equity ?? eqData.balance ?? "0");
          console.log(`[prop-firm-gate] Broker equity fetched: $${brokerEquity.toFixed(2)}`);
        } else {
          console.warn(`[prop-firm-gate] Broker equity fetch returned ${eqRes.status}`);
        }
      } catch (e: any) {
        console.warn(`[prop-firm-gate] Broker equity fetch failed (falling back to paper): ${e?.message}`);
      }
    }
    propFirmGateResult = await runPropFirmGate(
      supabase, userId, BOT_ID, balance, openPosArr, scanCycleId,
      { brokerEquity, isLiveAccount: account.execution_mode === "live", hasBrokerConnection: !!_scanBrokerConn, fxMarketClosed },
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
  // Config: gamePlanEnabled (bool), gamePlanNotify (bool), gamePlanRefreshHours (number)
  // ═══════════════════════════════════════════════════════════════════════════
  let activeGamePlan: SessionGamePlan | null = null;
  try {
    const currentSessionName = getCurrentSession();
    const gamePlanEnabled = (config as any).gamePlanEnabled !== false; // ON by default
    const gamePlanNotify = (config as any).gamePlanNotify !== false; // Telegram ON by default
    const gamePlanRefreshHours = Number((config as any).gamePlanRefreshHours) || 4; // regenerate after N hours
    const ipdaRangesEnabled = (config as any).ipdaRangesEnabled !== false; // ON by default
    const dolTPExtensionEnabled = (config as any).dolTPExtensionEnabled !== false; // ON by default
    if (gamePlanEnabled) {
      // ── Session dedup: check if a game plan already exists for this session ──
      // Primary approach: use contains filter on JSONB
      let lastGP: any = null;
      const { data: existingGP, error: gpQueryError } = await supabase
        .from("scan_logs")
        .select("id, created_at, details_json")
        .eq("user_id", userId)
        .eq("bot_id", BOT_ID)
        .contains("details_json", { type: "game_plan" })
        .order("created_at", { ascending: false })
        .limit(1);
      
      if (gpQueryError || !existingGP || existingGP.length === 0) {
        // Fallback: if contains filter fails or returns nothing, fetch recent scan_logs and filter in JS
        if (gpQueryError) {
          console.warn(`[scan ${scanCycleId}] Game Plan dedup: contains query failed (${gpQueryError.message}), using fallback`);
        }
        const { data: recentLogs } = await supabase
          .from("scan_logs")
          .select("id, created_at, details_json")
          .eq("user_id", userId)
          .eq("bot_id", BOT_ID)
          .order("created_at", { ascending: false })
          .limit(20);
        // Find the most recent game_plan entry by checking in JS
        lastGP = (recentLogs || []).find((log: any) => log.details_json?.type === "game_plan") || null;
        console.log(`[scan ${scanCycleId}] Game Plan dedup fallback: searched ${recentLogs?.length || 0} recent logs, found game_plan: ${!!lastGP}`);
      } else {
        lastGP = existingGP[0];
        console.log(`[scan ${scanCycleId}] Game Plan dedup: found existing plan from ${lastGP?.created_at}`);
      }

      const lastGPSession = lastGP?.details_json?.session;
      const lastGPType = lastGP?.details_json?.type;
      const lastGPTime = lastGP?.created_at ? new Date(lastGP.created_at).getTime() : 0;
      const hoursSinceLastGP = (Date.now() - lastGPTime) / (1000 * 60 * 60);
      const isSameSession = lastGPType === "game_plan" && lastGPSession === currentSessionName;
      const isStillFresh = hoursSinceLastGP < gamePlanRefreshHours;

      console.log(`[scan ${scanCycleId}] Game Plan dedup check: session=${currentSessionName}, lastSession=${lastGPSession}, sameSession=${isSameSession}, hoursSince=${hoursSinceLastGP.toFixed(2)}, fresh=${isStillFresh}, refreshHours=${gamePlanRefreshHours}`);

      if (isSameSession && isStillFresh) {
        // Reuse existing game plan for trade filtering — don't regenerate or notify
        try {
          const cached = lastGP.details_json;
          activeGamePlan = {
            session: cached.session,
            generatedAt: cached.generated_at,
            plans: cached.plans || [],
            focusPairs: cached.focus_pairs || [],
            newsEvents: cached.newsEvents || [],
            summary: cached.summary || "",
          } as SessionGamePlan;
          console.log(`[scan ${scanCycleId}] ✅ Game Plan: REUSING ${currentSessionName} plan (${hoursSinceLastGP.toFixed(1)}h old, refresh after ${gamePlanRefreshHours}h) — NO notification sent`);
        } catch (e: any) {
          console.warn(`[scan ${scanCycleId}] Game Plan: failed to parse cached plan, will regenerate: ${e?.message}`);
        }
      } else {
        console.log(`[scan ${scanCycleId}] Game Plan: will generate NEW plan — reason: ${!lastGP ? 'no existing plan found' : !isSameSession ? `session changed (${lastGPSession} → ${currentSessionName})` : `plan expired (${hoursSinceLastGP.toFixed(1)}h > ${gamePlanRefreshHours}h)`}`);
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
            // Fetch D1, 4H, entry TF, and 1H candles for game plan analysis
            const [gpDaily, gpH4, gpEntry, gpHourly] = await Promise.all([
              cachedFetch(sym, "1d", "1y"),
              cachedFetch(sym, "4h", "1mo"),
              cachedFetch(sym, getEntryInterval(config.entryTimeframe), getEntryRange(config.entryTimeframe)),
              cachedFetch(sym, "1h", "5d"),
            ]);
            if (gpDaily.length < 10 || gpEntry.length < 10) return null;
            return generateInstrumentGamePlan(sym, gpDaily, gpH4, gpEntry, gpHourly, currentSessionName, { ipdaRangesEnabled, equalHighsLowsSensitivity: config.equalHighsLowsSensitivity, liquidityPoolMinTouches: config.liquidityPoolMinTouches });
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
      if (instrumentPlans.length > 0) {
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
            console.log(`[scan ${scanCycleId}] Game Plan: ${newsEvents.length} news events found (${newsEvents.filter(e => e.impact === "high").length} high-impact)`);
            // ── News Impact Analysis: understand WHAT the news means ──
            try {
              const newsImpacts = analyzeNewsImpact(newsEvents as any);
              const impactSummaries: string[] = [];
              for (const impact of newsImpacts) {
                if (impact.directionalImpact !== "unknown" && impact.directionalImpact !== "neutral") {
                  impactSummaries.push(impact.reasoning);
                }
              }
              // Enrich each instrument plan with news directional bias
              for (const plan of activeGamePlan.plans) {
                const pairBias = getNewsPairBias(plan.symbol, newsImpacts);
                (plan as any).newsBias = {
                  pairBias: pairBias.pairBias,
                  strength: pairBias.netStrength,
                  summary: pairBias.summary,
                  baseBias: pairBias.baseBias.bias,
                  quoteBias: pairBias.quoteBias.bias,
                };
                // If news strongly supports or opposes the technical bias, note it
                if (pairBias.netStrength >= 40) {
                  const aligned = (plan.bias === "bullish" && pairBias.pairBias === "bullish") ||
                                  (plan.bias === "bearish" && pairBias.pairBias === "bearish");
                  if (aligned) {
                    (plan as any).newsConfirmation = `NEWS CONFIRMS: ${pairBias.summary}`;
                  } else if (plan.bias !== "neutral" && pairBias.pairBias !== "neutral") {
                    (plan as any).newsConflict = `⚠ NEWS CONFLICTS: ${pairBias.summary}`;
                  }
                }
              }
              if (impactSummaries.length > 0) {
                activeGamePlan.summary += `\n\n📊 News Impact Analysis:\n` + impactSummaries.join("\n");
              }
              // Store impacts for the trade filter to use
              (activeGamePlan as any).newsImpacts = newsImpacts.map(i => ({
                name: i.event.name, currency: i.event.currency, impact: i.event.impact,
                directionalImpact: i.directionalImpact, confidence: i.confidence,
                reasoning: i.reasoning, category: i.category,
                actual: i.event.actual, forecast: i.event.forecast, previous: i.event.previous,
              }));
              console.log(`[scan ${scanCycleId}] News Impact: ${newsImpacts.length} events analyzed, ${impactSummaries.length} with directional signal`);
            } catch (nie: any) {
              console.warn(`[scan ${scanCycleId}] News Impact analysis error (non-fatal): ${nie?.message}`);
            }
          } else {
            console.log(`[scan ${scanCycleId}] Game Plan: no relevant news events today`);
          }
        } catch (e: any) {
          console.warn(`[scan ${scanCycleId}] Game Plan: news fetch error (non-fatal): ${e?.message}`);
        }
        // Store game plan in scan_logs for dashboard retrieval
        await supabase.from("scan_logs").insert({
          user_id: userId,
          bot_id: BOT_ID,
          pairs_scanned: 0,
          signals_found: 0,
          trades_placed: 0,
          details_json: {
            type: "game_plan",
            session: currentSessionName,
            generated_at: activeGamePlan.generatedAt,
            focus_pairs: activeGamePlan.focusPairs,
            plans: activeGamePlan.plans.map(p => ({
              symbol: p.symbol, bias: p.bias, biasConfidence: p.biasConfidence,
              biasReasoning: p.biasReasoning, dol: p.dol, regime: p.regime,
              amdPhase: p.amdPhase, zone: p.zone, htfTrend: p.htfTrend,
              h4Trend: p.h4Trend, tradeable: p.tradeable, skipReason: p.skipReason,
              scenarios: p.scenarios, keyLevels: p.keyLevels.slice(0, 10),
              newsBias: (p as any).newsBias || null,
              newsConfirmation: (p as any).newsConfirmation || null,
              newsConflict: (p as any).newsConflict || null,
            })),
            newsEvents: activeGamePlan.newsEvents || [],
            newsImpacts: (activeGamePlan as any).newsImpacts || [],
            summary: activeGamePlan.summary,
          },
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
        console.warn(`[scan ${scanCycleId}] Game Plan: no valid plans generated (insufficient data)`);
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

  for (const pair of scanOrder) {
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

    // Determine entry TF based on style
    const entryInterval = getEntryInterval(pairConfig.entryTimeframe);
    const entryRange = getEntryRange(pairConfig.entryTimeframe);

    // Fetch entry TF, daily, 4H (for multi-TF regime), optionally 1h, and SMT correlated pair candles in parallel
    const orFlag = pairConfig.openingRange?.enabled ? 1 : 0;
    const smtPair = pairConfig.useSMT !== false ? SMT_PAIRS[pair] : undefined;
    const smtFlag = smtPair && SUPPORTED_SYMBOLS[smtPair] ? 1 : 0;
    const multiTFRegimeEnabled = (pairConfig as any).multiTFRegimeEnabled !== false; // ON by default
    // Style-aware: scalper needs 15m for structure TF, swing needs weekly for bias TF
    const needsM15 = resolvedStyle === "scalper" && entryInterval !== "15m";
    const needsWeekly = resolvedStyle === "swing_trader" || pairConfig.ictHTFEnabled !== false;
    const fetchPromises: Promise<Candle[]>[] = [
      cachedFetch(pair, entryInterval, entryRange),
      cachedFetch(pair, "1d", "1y"),
    ];
    // Always fetch 4H for multi-TF regime + HTF POI detection
    if (multiTFRegimeEnabled) fetchPromises.push(cachedFetch(pair, "4h", "1mo"));
    // Always fetch 1H for HTF POI detection (also used by Opening Range if enabled)
    fetchPromises.push(cachedFetch(pair, "1h", "5d"));
    // Scalper structure TF: fetch 15m candles (separate from 5m entry)
    if (needsM15) fetchPromises.push(cachedFetch(pair, "15m", "5d"));
    if (smtFlag) fetchPromises.push(cachedFetch(smtPair!, entryInterval, entryRange));
    // Fetch weekly candles for ICT HTF framework OR swing_trader bias (cached — same data reused across pairs)
    if (needsWeekly) fetchPromises.push(cachedFetch(pair, "1w", "1y"));
    const fetched = await Promise.all(fetchPromises);
    const candles = fetched[0];
    const dailyCandles = fetched[1];
    const h4Candles: Candle[] = multiTFRegimeEnabled ? fetched[2] : [];
    const h4Offset = multiTFRegimeEnabled ? 1 : 0;
    // 1H candles always fetched (index = 2 + h4Offset)
    const hourlyCandles: Candle[] = fetched[2 + h4Offset] || [];
    // 15m candles for scalper structure TF (only fetched when needsM15)
    const m15Offset = needsM15 ? 1 : 0;
    const m15Candles: Candle[] = needsM15 ? (fetched[3 + h4Offset] || []) : [];
    const smtCandles = smtFlag ? fetched[3 + h4Offset + m15Offset] : null;
    // Weekly candles (last in fetch array when needed)
    const weeklyCandles: Candle[] | null = needsWeekly ? (fetched[fetched.length - 1] || null) : null;
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
    // Style-aware: scalper uses 1H/15m/5m, swing uses Weekly/Daily/4H, day_trader uses Daily/4H/1H (original)
    let simpleDirectionResult: DirectionResult | null = null;
    let styleDirectionResult: StyleDirectionResult | null = null;
    if (pairConfig.useSimpleDirection) {
      try {
        const dirConfig = {
          h4ChochLookback: pairConfig.simpleDirectionH4ChochLookback ?? 10,
          h1BosLookback: pairConfig.simpleDirectionH1BosLookback ?? 8,
          useConfirmedTrend: pairConfig.useConfirmedTrend ?? true,
          fibFactor: pairConfig.confirmedTrendFibFactor ?? 0.25,
          trendSwingLookback: pairConfig.confirmedTrendSwingLookback ?? 5,
        };

        if (resolvedStyle === "scalper") {
          // Scalper: bias=1H, structure=15m, confirm=5m (entry candles)
          const tfLabels = STYLE_TF_LABELS.scalper;
          styleDirectionResult = determineDirectionStyleAware(
            hourlyCandles.length >= 20 ? hourlyCandles : null,
            m15Candles.length >= 20 ? m15Candles : null,
            candles.length >= 20 ? candles : null,
            { ...dirConfig, ...tfLabels },
          );
          // Map StyleDirectionResult to DirectionResult for downstream compatibility
          simpleDirectionResult = {
            direction: styleDirectionResult.direction,
            bias: styleDirectionResult.bias,
            biasSource: styleDirectionResult.biasSource as "daily" | "4h" | null,
            h4Retrace: styleDirectionResult.structureRetrace,
            h4ChochAgainst: styleDirectionResult.structureChochAgainst,
            h1Confirmed: styleDirectionResult.confirmBOS,
            reason: `[scalper] ${styleDirectionResult.reason}`,
          };
        } else if (resolvedStyle === "swing_trader") {
          // Swing: bias=Weekly, structure=Daily, confirm=4H
          const tfLabels = STYLE_TF_LABELS.swing_trader;
          styleDirectionResult = determineDirectionStyleAware(
            weeklyCandles && weeklyCandles.length >= 20 ? weeklyCandles : null,
            dailyCandles.length >= 20 ? dailyCandles : null,
            h4Candles.length >= 20 ? h4Candles : null,
            { ...dirConfig, ...tfLabels },
          );
          // Map StyleDirectionResult to DirectionResult for downstream compatibility
          simpleDirectionResult = {
            direction: styleDirectionResult.direction,
            bias: styleDirectionResult.bias,
            biasSource: styleDirectionResult.biasSource as "daily" | "4h" | null,
            h4Retrace: styleDirectionResult.structureRetrace,
            h4ChochAgainst: styleDirectionResult.structureChochAgainst,
            h1Confirmed: styleDirectionResult.confirmBOS,
            reason: `[swing] ${styleDirectionResult.reason}`,
          };
        } else {
          // Day trader (default): bias=Daily, structure=4H, confirm=1H — original function
          simpleDirectionResult = determineDirection(
            dailyCandles.length >= 20 ? dailyCandles : null,
            h4Candles.length >= 20 ? h4Candles : null,
            hourlyCandles.length >= 20 ? hourlyCandles : null,
            dirConfig,
          );
        }

        console.log(`[scan ${scanCycleId}] ${pair} SimpleDirection(${resolvedStyle}): ${simpleDirectionResult.direction ?? "null"} | bias=${simpleDirectionResult.bias}(${simpleDirectionResult.biasSource}) | struct-retrace=${simpleDirectionResult.h4Retrace} | struct-choch-against=${simpleDirectionResult.h4ChochAgainst} | confirm-bos=${simpleDirectionResult.h1Confirmed} | ${simpleDirectionResult.reason}`);
        // Pass override direction to confluenceScoring
        if (simpleDirectionResult.direction !== null) {
          (pairConfig as any)._overrideDirection = simpleDirectionResult.direction;
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
    if (activeGamePlan) {
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

    // Build HTF confluence data from already-computed 4H analysis (used by impulse zone engine)
    const htfConfluenceData: HTFConfluenceData | null = analysis.direction ? {
      h4OBs: h4OBs ?? [],
      h4FVGs: h4FVGs ?? [],
      h4Breakers: h4Breakers ?? [],
      htfFibLevels: htfFibLevels4H ?? null,
      dailyFibLevels: htfFibLevelsD ?? null,
      htfPD: htfPD4H ?? null,
      direction: (analysis.direction === "long" ? "bullish" : "bearish") as "bullish" | "bearish",
    } : null;

    // ── Consolidated Zone Engine (story-driven waterfall with liquidity + confirmation) ──
    // Style-aware candle mapping for findUnifiedZone:
    //   findUnifiedZone(h1Candles, h4Candles, entryCandles, ..., dailyCandles?, confirmCandles?, ltfConfirmCandles?)
    //   Scalper:     h1=5m(entry), h4=15m, entry=5m, daily=1H, confirm=15m, ltfConfirm=5m
    //   Day Trader:  h1=1H, h4=4H, entry=15m, daily=Daily, confirm=4H/1H, ltfConfirm=1H/15m
    //   Swing:       h1=4H, h4=Daily, entry=1H, daily=Weekly, confirm=Daily, ltfConfirm=4H
    // The slot names (h1, h4, daily) are just positional — the engine is TF-agnostic.
    const hasMinZoneCandles = resolvedStyle === "scalper"
      ? candles.length >= 20
      : resolvedStyle === "swing_trader"
        ? h4Candles.length >= 20
        : hourlyCandles.length >= 20;
    if (analysis.direction && hasMinZoneCandles) {
      try {
        const unifiedDir = analysis.direction === "long" ? "bullish" : "bearish";
        // Combine liquidity pools from the relevant timeframes
        const combinedLiqPools = [
          ...htfLiquidityPoolsD,
          ...htfLiquidityPools4H,
          ...htfLiquidityPools1H,
        ];

        // Style-aware candle slot mapping
        let zoneH1Candles: Candle[];
        let zoneH4Candles: Candle[];
        let zoneEntryCandles: Candle[];
        let zoneDailyCandles: Candle[] | undefined;
        let zoneConfirmCandles: Candle[];
        let zoneLtfConfirmCandles: Candle[];

        if (resolvedStyle === "scalper") {
          // Scalper waterfall: 1H → 15m → 5m (entry)
          zoneH1Candles = candles;              // 5m = lowest structural TF slot
          zoneH4Candles = m15Candles;           // 15m = mid structural TF slot
          zoneEntryCandles = candles;           // 5m entry
          zoneDailyCandles = hourlyCandles.length >= 20 ? hourlyCandles : undefined; // 1H = highest TF slot
          zoneConfirmCandles = m15Candles.length >= 15 ? m15Candles : candles;
          zoneLtfConfirmCandles = candles;
        } else if (resolvedStyle === "swing_trader") {
          // Swing waterfall: Weekly → Daily → 4H (entry=1H)
          zoneH1Candles = h4Candles;            // 4H = lowest structural TF slot
          zoneH4Candles = dailyCandles;         // Daily = mid structural TF slot
          zoneEntryCandles = candles;           // 1H entry
          zoneDailyCandles = weeklyCandles && weeklyCandles.length >= 20 ? weeklyCandles : undefined; // Weekly = highest TF slot
          zoneConfirmCandles = dailyCandles.length >= 15 ? dailyCandles : h4Candles;
          zoneLtfConfirmCandles = h4Candles;
        } else {
          // Day trader (default): Daily → 4H → 1H (entry=15m)
          zoneH1Candles = hourlyCandles;
          zoneH4Candles = h4Candles;
          zoneEntryCandles = candles;           // 15m entry
          zoneDailyCandles = dailyCandles.length >= 30 ? dailyCandles : undefined;
          zoneConfirmCandles = dailyCandles.length >= 30 ? h4Candles : hourlyCandles;
          zoneLtfConfirmCandles = dailyCandles.length >= 30 ? hourlyCandles : candles;
        }

        const unifiedResult: UnifiedZoneResult = findUnifiedZone(
          zoneH1Candles,
          zoneH4Candles,
          zoneEntryCandles,
          unifiedDir as "bullish" | "bearish",
          analysis.lastPrice,
          combinedLiqPools,
          htfConfluenceData ?? undefined,
          { strictATRMult: pairConfig.marketFillStrictATRMult, pipSize: (SPECS[pair] || SPECS["EUR/USD"]).pipSize },
          zoneDailyCandles,
          zoneConfirmCandles,
          zoneLtfConfirmCandles,
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
          } : null,
          bestZone: multiTF.bestZone ? {
            type: multiTF.bestZone.zone.poi.type,
            high: multiTF.bestZone.zone.poi.high,
            low: multiTF.bestZone.zone.poi.low,
            fibLevel: multiTF.bestZone.zone.fibLevel,
            fibDepth: multiTF.bestZone.zone.fibDepth,
            totalScore: multiTF.bestZone.zone.totalScore,
            srConfirmed: multiTF.bestZone.zone.srConfirmed,
            ltfRefined: multiTF.bestZone.zone.ltfRefined,
            ltfType: multiTF.bestZone.zone.ltfType || null,
            refinedEntry: multiTF.bestZone.zone.refinedEntry || null,
            refinedSL: multiTF.bestZone.zone.refinedSL || null,
            htfConfluenceScore: multiTF.bestZone.zone.htfConfluenceScore,
            htfLayers: multiTF.bestZone.zone.htfLayers,
            priceAtZone: multiTF.bestZone.priceAtZone,
            priceInsideZone: multiTF.bestZone.priceInsideZone,
            priceAtZoneStrict: multiTF.bestZone.priceAtZoneStrict,
            sideOk: multiTF.bestZone.sideOk,
            distanceToZone: multiTF.bestZone.distanceToZone,
            distancePips: multiTF.bestZone.distancePips,
          } : null,
          allZonesCount: multiTF.allZones.length,
          h1HasZone: !!multiTF.h1Result.bestZone,
          h4HasZone: !!multiTF.h4Result?.bestZone,
          dailyHasZone: !!multiTF.dailyResult?.bestZone,
          scoringEnabled: pairConfig.impulseZoneEnabled !== false,
        };

        console.log(`[scan ${scanCycleId}] ${pair} Zone Story [${unifiedResult.state}|${multiTF.selectedTF || "none"}]: score ${unifiedResult.unifiedScore}/14, zone ${multiTF.bestZone?.zone.totalScore.toFixed(1) ?? "—"}/9 — ${unifiedResult.reason.slice(0, 120)}`);
      } catch (zoneErr: any) {
        console.warn(`[scan ${scanCycleId}] ${pair} Zone Engine error (non-fatal): ${zoneErr?.message}`);
        (detail as any).unifiedZone = { hasZone: false, state: "error", reason: `Error: ${zoneErr?.message}` };
        (detail as any).impulseZone = { hasZone: false, selectedTF: null, reason: `Error: ${zoneErr?.message}`, impulse: null, bestZone: null, allZonesCount: 0, h1HasZone: false, h4HasZone: false };
      }
    } else {
      const dirReason = !analysis.direction && simpleDirectionResult?.reason
        ? `No direction: ${simpleDirectionResult.reason}`
        : analysis.direction ? "Insufficient 1H candles" : "No direction determined";
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
    if (resolvedStyle === "swing_trader" && analysis.direction && dailyCandles.length >= 30 && h4Candles.length >= 20) {
      try {
        const cascadeDir = analysis.direction === "long" ? "bullish" : "bearish";
        cascadeResult = findCascadeZone(
          dailyCandles,
          h4Candles,
          hourlyCandles,
          candles, // 1H entry candles
          cascadeDir as "bullish" | "bearish",
          analysis.lastPrice,
          {
            htfData: htfConfluenceData ?? undefined,
            zoneEngineOpts: { strictATRMult: pairConfig.marketFillStrictATRMult, pipSize: (SPECS[pair] || SPECS["EUR/USD"]).pipSize },
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
    if (shouldRunICTHTF && analysis.direction) {
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
          analysis.direction as "long" | "short",
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
          minRangeATR: pairConfig.ictDisplacementMSSMinRangeATR,
          lookback: pairConfig.ictDisplacementMSSLookback,
        };
        ictMSSResult = validateRecentMSS(candles, mssConfig);
        const modeTag = pairConfig.ictDisplacementMSSGateMode.toUpperCase();
        const statusTag = ictMSSResult.valid ? "VALID" : "INVALID";
        console.log(`[scan ${scanCycleId}] ${pair} ICT MSS [${modeTag}]: ${statusTag} — ${ictMSSResult.reason}`);
        (detail as any).ictMSS = {
          gateMode: pairConfig.ictDisplacementMSSGateMode,
          valid: ictMSSResult.valid,
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
          lookback: pairConfig.ictJudasSwingLookback,
          minDepthATR: pairConfig.ictJudasSwingMinDepthATR,
          requireCloseBack: pairConfig.ictJudasSwingRequireCloseBack,
        };
        const judasDirection = analysis.direction === "long" ? "bullish" : "bearish";
        ictJudasResult = detectICTJudasSwing(candles, judasDirection as "bullish" | "bearish", judasConfig);
        const modeTag = pairConfig.ictJudasSwingGateMode.toUpperCase();
        const statusTag = ictJudasResult.detected ? "DETECTED" : "NOT_FOUND";
        console.log(`[scan ${scanCycleId}] ${pair} ICT Judas [${modeTag}]: ${statusTag} — ${ictJudasResult.reason}`);
        (detail as any).ictJudas = {
          gateMode: pairConfig.ictJudasSwingGateMode,
          detected: ictJudasResult.detected,
          reason: ictJudasResult.reason,
          sweepLevel: ictJudasResult.sweepLevel,
          sweepDepthATR: ictJudasResult.sweepDepthATR,
        };
      } catch (e: any) {
        console.warn(`[scan ${scanCycleId}] ${pair} ICT Judas error (non-fatal): ${e?.message}`);
        (detail as any).ictJudas = { gateMode: pairConfig.ictJudasSwingGateMode, detected: false, error: e?.message };
      }
    }

    // ── ICT FVG Invalidation (log-only in "off" mode) ──
    let ictFVGResult: BatchFVGValidationResult | null = null;
    if (pairConfig.ictFVGInvalidationEnabled && analysis.fvgs && analysis.fvgs.length > 0) {
      try {
        const fvgConfig: FVGInvalidationConfig = {
          ...DEFAULT_FVG_INVALIDATION_CONFIG,
          bodyCloseOnly: pairConfig.ictFVGBodyCloseOnly,
          ruleOfTwo: pairConfig.ictFVGRuleOfTwo,
        };
        ictFVGResult = validateFVGBatch(analysis.fvgs, candles, fvgConfig);
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
          silverBullet: pairConfig.ictKillZoneSilverBullet,
          pmSession: pairConfig.ictKillZonePMSession,
        };
        ictKZResult = evaluateICTKillZone(new Date(), kzConfig);
        const modeTag = pairConfig.ictKillZoneGateMode.toUpperCase();
        const statusTag = ictKZResult.inKillZone ? `IN (${ictKZResult.activeZone})` : `OUT (${ictKZResult.reason})`;
        console.log(`[scan ${scanCycleId}] ${pair} ICT KZ [${modeTag}]: ${statusTag}`);
        (detail as any).ictKillZone = {
          gateMode: pairConfig.ictKillZoneGateMode,
          inKillZone: ictKZResult.inKillZone,
          activeZone: ictKZResult.activeZone,
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
          maxConsecutiveLosses: pairConfig.ictRiskMaxConsecLosses,
          dailyLossLimit: pairConfig.ictRiskDailyLimit,
          weeklyLossLimit: pairConfig.ictRiskWeeklyLimit,
          maxTradesPerDay: pairConfig.ictRiskMaxTradesPerDay,
        };
        // Fetch recent trade history for risk assessment
        const { data: recentTrades } = await supabase
          .from("trade_history")
          .select("pnl_percent, closed_at")
          .eq("bot_config_id", configId)
          .order("closed_at", { ascending: false })
          .limit(20);
        const accountEquity = 10000; // Placeholder — will be replaced by actual account equity fetch
        const tradePnLs = (recentTrades || []).map((t: any) => t.pnl_percent || 0);
        ictRiskResult = assessRisk(accountEquity, tradePnLs, riskConfig);
        const modeTag = "OFF"; // Risk is always informational for now
        console.log(`[scan ${scanCycleId}] ${pair} ICT Risk [${modeTag}]: canTrade=${ictRiskResult.canTrade}, riskPct=${(ictRiskResult.adjustedRiskPercent * 100).toFixed(2)}%, reason=${ictRiskResult.reason}`);
        (detail as any).ictRisk = {
          canTrade: ictRiskResult.canTrade,
          adjustedRiskPercent: ictRiskResult.adjustedRiskPercent,
          reason: ictRiskResult.reason,
          consecutiveLosses: ictRiskResult.consecutiveLosses,
          dailyLossPercent: ictRiskResult.dailyLossPercent,
          weeklyLossPercent: ictRiskResult.weeklyLossPercent,
        };
      } catch (e: any) {
        console.warn(`[scan ${scanCycleId}] ${pair} ICT Risk error (non-fatal): ${e?.message}`);
        (detail as any).ictRisk = { canTrade: true, error: e?.message };
      }
    }

    // ── Setup Staging: Check if this pair has a staged setup and handle promotion/invalidation ──
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
    // ── DIRECTION VERDICT (single source of truth for direction) ──
    // Consolidates confirmedTrend, simpleDirection, regime, weeklyBias, and gamePlan
    // into one verdict. ACTIVE: replaces Gate 1 (HTF Bias), Gate 20 (Regime), and ICT HTF score adj.
    let directionVerdict: DirectionVerdictResult | null = null;
    try {
      const gpCtx = (pairConfig as any)._gamePlanContext;
      const ctResult = dailyCandles.length >= 20 && (pairConfig as any).useConfirmedTrend !== false
        ? computeConfirmedTrend(dailyCandles, pairConfig.confirmedTrendFibFactor ?? 0.25, pairConfig.confirmedTrendSwingLookback ?? 5)
        : null;
      directionVerdict = computeDirectionVerdict({
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
        regime: analysis.regimeInfo ? {
          regime: analysis.regimeInfo.regime,
          confidence: analysis.regimeInfo.confidence,
          directionalBias: analysis.regimeInfo.bias,
        } : null,
        weeklyBias: ictHTFResult?.weeklyBias ? {
          bias: ictHTFResult.weeklyBias.bias,
          confidence: ictHTFResult.weeklyBias.confidence,
        } : null,
        gamePlanBias: gpCtx ? {
          bias: gpCtx.bias,
          confidence: gpCtx.biasConfidence ?? 50,
        } : null,
      });
      (detail as any).directionVerdict = {
        verdict: directionVerdict.verdict,
        confidence: directionVerdict.confidence,
        agreement: directionVerdict.agreement,
        shouldBlock: directionVerdict.shouldBlock,
        scoreAdjustment: directionVerdict.scoreAdjustment,
        summary: directionVerdict.summary,
      };
      console.log(`[scan ${scanCycleId}] ${pair} DirectionVerdict: ${directionVerdict.summary}`);
    } catch (dvErr: any) {
      console.warn(`[scan ${scanCycleId}] ${pair} DirectionVerdict error (non-fatal): ${dvErr?.message}`);
      (detail as any).directionVerdict = { error: dvErr?.message };
    }
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
    if (unifiedGatePassed) {
      // Unified story is complete — use its entry/SL instead of impulse zone
      impulseZonePenaltyVal = +(pairConfig.impulseZoneBonus ?? 1.0);
      console.log(`[scan ${scanCycleId}] \u2705 ${pair}: Unified gate passed \u2014 bypassing impulse zone gate.`);
    } else if (pairConfig.requireUnifiedZone) {
      // requireUnifiedZone is ON — skip pair entirely if unified zone engine did not confirm
      detail.status = "skipped_require_unified";
      detail.skipReason = "Require Unified Zone: unified zone engine did not reach triggered/confirmed state \u2014 no standalone fallback allowed";
      console.log(`[scan ${scanCycleId}] \u26d4 ${pair}: REQUIRE UNIFIED ZONE \u2014 unified gate not passed, standalone fallback disabled. Skipping.`);
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
    // When directionVerdict is active, its scoreAdjustment replaces the ICT HTF score adjustment
    // (the verdict already incorporates weekly bias, regime, and GP bias into one number).
    const ictHTFScoreAdj = directionVerdict ? 0 : (ictHTFResult?.scoreAdjustment ?? 0);
    const verdictScoreAdj = directionVerdict?.scoreAdjustment ?? 0;
    // ICT module score adjustments (only apply in "soft" mode; "off" = 0, "hard" = gate block)
    const ictMSSAdj = (pairConfig.ictDisplacementMSSGateMode === "soft" && ictMSSResult && !ictMSSResult.valid)
      ? -pairConfig.ictDisplacementMSSPenalty : 0;
    const ictJudasAdj = (pairConfig.ictJudasSwingGateMode === "soft" && ictJudasResult && !ictJudasResult.detected)
      ? -pairConfig.ictJudasSwingPenalty : 0;
    const ictFVGAdj = (pairConfig.ictFVGInvalidationGateMode === "soft" && ictFVGResult)
      ? -(ictFVGResult.invalidatedCount * pairConfig.ictFVGInvalidatedPenalty + ictFVGResult.exhaustedCount * pairConfig.ictFVGExhaustedPenalty) / Math.max(ictFVGResult.totalCount, 1)
      : 0;
    const ictKZAdj = (pairConfig.ictKillZoneGateMode === "soft" && ictKZResult)
      ? (ictKZResult.inKillZone ? (ictKZResult.isPrime ? pairConfig.ictKillZonePrimeBonus : 0) : -pairConfig.ictKillZoneOutsidePenalty)
      : 0;
    const ictTotalAdj = ictHTFScoreAdj + ictMSSAdj + ictJudasAdj + ictFVGAdj + ictKZAdj;
    const effectiveScore = analysis.score + fotsiPenalty + impulseZonePenaltyVal + ictTotalAdj + verdictScoreAdj;
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

    // Determine if this is a staged setup being promoted
    let isPromotedFromStaging = false;
    if (existingStaged && effectiveScore >= conflictAdjustedMinConfluence && analysis.direction && !isPaused && stagingEnabled) {
      const cyclesMet = existingStaged.scan_cycles >= (existingStaged.min_cycles || minStagingCycles);
      if (cyclesMet) {
        isPromotedFromStaging = true;
        // Update the staged setup to promoted
        try {
          const presentFactors = analysis.factors.filter((f: any) => f.present).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
          const missingFactors = analysis.factors.filter((f: any) => !f.present && f.weight > 0).map((f: any) => ({ name: f.name, weight: f.weight, tier: f.tier }));
          await supabase.from("staged_setups").update({
            status: "promoted",
            current_score: analysis.score,
            current_factors: presentFactors,
            missing_factors: missingFactors,
            promotion_reason: `Score reached ${analysis.score.toFixed(1)}% (gate: ${adjustedMinConfluence}%) after ${existingStaged.scan_cycles + 1} cycles`,
            resolved_at: new Date().toISOString(),
            last_eval_at: new Date().toISOString(),
            scan_cycles: existingStaged.scan_cycles + 1,
          }).eq("id", existingStaged.id);
          stagedPromoted++;
          stagedMap.delete(stagedKey!);
          console.log(`[staging] PROMOTED ${pair} ${analysis.direction} — score ${analysis.score.toFixed(1)}% after ${existingStaged.scan_cycles + 1} cycles`);
        } catch (e: any) {
          console.warn(`[staging] Failed to promote ${pair}: ${e?.message}`);
        }
        detail.staging = { action: "promoted", cycles: existingStaged.scan_cycles + 1, initialScore: parseFloat(existingStaged.initial_score) };
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
    if (pairConfig.ictDisplacementMSSGateMode === "hard" && ictMSSResult && !ictMSSResult.valid) {
      detail.status = "rejected";
      detail.rejectionReasons = [`ICT MSS BLOCKED: ${ictMSSResult.reason}`];
      detail.reason = ictMSSResult.reason;
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }
    // ICT Judas Swing hard gate: block trade if no liquidity sweep detected before MSS
    if (pairConfig.ictJudasSwingGateMode === "hard" && ictJudasResult && !ictJudasResult.detected) {
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
    if (pairConfig.ictKillZoneGateMode === "hard" && ictKZResult && !ictKZResult.inKillZone) {
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
      detail.rejectionReasons = [`ICT RISK BLOCKED: ${ictRiskResult.reason}`];
      detail.reason = ictRiskResult.reason;
      rejectedCount++;
      scanDetails.push(detail);
      continue;
    }

    // Single percentage threshold gate (minFactorCount and minStrongFactors collapsed)
    if (effectiveScore >= conflictAdjustedMinConfluence && analysis.direction && !isPaused) {
      signalsFound++;

      // Run safety gates
      // Conviction-TF candles: one timeframe above entry for structural conviction gate.
      // scalper (entry 5m) → conviction 15m (entry candles are 5m, but we use hourly as closest available above)
      // day_trader (entry 15m) → conviction 1H (hourlyCandles)
      // swing_trader (entry 1H) → conviction 4H (h4Candles)
      const convictionCandles = resolvedStyle === "swing_trader"
        ? (h4Candles.length >= 20 ? h4Candles : null)
        : (hourlyCandles.length >= 20 ? hourlyCandles : null);
      const gates = await runSafetyGates(
        supabase, userId, pair, analysis.direction,
        analysis, pairConfig, account, openPosArr, dailyCandles.length >= 10 ? dailyCandles : null,
        rateMap, convictionCandles, directionVerdict,
        propFirmGateResult?.enabled || false,
      );
      // ── Game Plan Filter Gate (SOFT — Phase 7 migration) ──
      // Previously a binary veto that blocked trades opposing the game plan bias.
      // Now converted to info-only: the scoring impact is handled by the GP Bias
      // Confidence factor (Phase 5) which applies a continuous penalty/bonus.
      // The gate always passes but logs what the legacy behavior would have done.
      const gpFilter = filterTradeByGamePlan(activeGamePlan, pair, analysis.direction);
      if (activeGamePlan) {
        if (!gpFilter.allowed) {
          const pairPlan = activeGamePlan?.plans?.find((p: any) => p.symbol === pair);
          const biasConf = pairPlan?.biasConfidence ?? 0;
          // Info-only: log what the old gate would have done
          gates.push({ passed: true, reason: `GP filter (soft): ${gpFilter.reason} — handled by GP Bias Confidence scoring (conf: ${biasConf}%)` });
          console.log(`[scan ${scanCycleId}] ℹ️ ${pair}: GP bias opposes direction — soft penalty applied via scoring (legacy gate would have blocked at ${biasConf}% conf)`);
        } else {
          gates.push({ passed: true, reason: gpFilter.reason });
        }
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
      const allPassed = gates.every(g => g.passed);
      // ── Sync detail with post-credit state so dashboard display matches gate decisions ──
      // Impulse zone credits (lines ~3934-4120) reassign analysis.tieredScoring to a new object,
      // but detail.tieredScoring still references the pre-credit snapshot. Sync it here.
      detail.tieredScoring = analysis.tieredScoring;
      detail.score = analysis.score;
      detail.gates = gates;
      detail.gamePlan = gpFilter; // attach game plan filter result to scan detail

      if (allPassed && analysis.stopLoss && analysis.takeProfit) {
        // Adjust SL buffer for JPY pairs
        const spec = SPECS[pair] || SPECS["EUR/USD"];
        let sl = analysis.stopLoss;
        let tp = analysis.takeProfit;

        // Recalculate SL with correct pip size
        if (analysis.direction === "long") {
          const swingLows = analysis.structure.swingPoints.filter((s: SwingPoint) => s.type === "low" && s.price < analysis.lastPrice).slice(-3);
          if (swingLows.length > 0) {
            sl = Math.max(...swingLows.map((s: SwingPoint) => s.price)) - adjustedSlBuffer * spec.pipSize;
            const risk = analysis.lastPrice - sl;
            tp = analysis.lastPrice + risk * config.tpRatio;
          }
        } else {
          const swingHighs = analysis.structure.swingPoints.filter((s: SwingPoint) => s.type === "high" && s.price > analysis.lastPrice).slice(-3);
          if (swingHighs.length > 0) {
            sl = Math.min(...swingHighs.map((s: SwingPoint) => s.price)) + adjustedSlBuffer * spec.pipSize;
            const risk = sl - analysis.lastPrice;
            tp = analysis.lastPrice - risk * config.tpRatio;
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
          const newRisk = Math.abs(analysis.lastPrice - sl);
          tp = analysis.direction === "long"
            ? analysis.lastPrice + newRisk * config.tpRatio
            : analysis.lastPrice - newRisk * config.tpRatio;
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
              const impulseRisk = Math.abs(analysis.lastPrice - sl);
              tp = analysis.direction === "long"
                ? analysis.lastPrice + impulseRisk * config.tpRatio
                : analysis.lastPrice - impulseRisk * config.tpRatio;
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
            const unifiedRisk = Math.abs(analysis.lastPrice - sl);
            tp = analysis.direction === "long"
              ? analysis.lastPrice + unifiedRisk * config.tpRatio
              : analysis.lastPrice - unifiedRisk * config.tpRatio;
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
            const cascadeRisk = Math.abs(analysis.lastPrice - sl);
            tp = analysis.direction === "long"
              ? analysis.lastPrice + cascadeRisk * config.tpRatio
              : analysis.lastPrice - cascadeRisk * config.tpRatio;
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
          if (portfolioCheck.concentrationScore > 0.5) {
            // High concentration: reduce size proportionally (50% concentration = no reduction, 100% = 50% reduction)
            correlationSizeMultiplier = Math.max(0.5, 1.0 - (portfolioCheck.concentrationScore - 0.5));
            console.log(`[${pair}] ⚠️ Portfolio correlation advisory: concentration=${(portfolioCheck.concentrationScore * 100).toFixed(0)}%, size multiplier=${correlationSizeMultiplier.toFixed(2)}. Conflicts: ${portfolioCheck.conflicts.map(c => c.detail).join("; ") || "none"}`);
            detail.correlationAdvisory = {
              concentrationScore: portfolioCheck.concentrationScore,
              sizeMultiplier: correlationSizeMultiplier,
              conflicts: portfolioCheck.conflicts.map(c => ({ type: c.type, pair: c.conflictingSymbol, correlation: c.correlation, detail: c.detail })),
              currencyExposure: portfolioCheck.currencyExposure,
            };
          }
        } catch (corrErr: any) {
          console.warn(`[${pair}] Portfolio correlation check error (non-blocking): ${corrErr?.message}`);
        }

        // ── Unified Position Sizing (volatility scaling + prop firm compliance) ──
        // Portfolio heat and correlation checks are handled by Gates 6 & 22 above.
        const volCtx: VolatilityContext | undefined = analysis.regimeInfo ? {
          regime: analysis.regimeInfo.atrTrend === "expanding" ? "high" :
                  analysis.regimeInfo.regime === "choppy_range" ? "high" :
                  analysis.regimeInfo.atrTrend === "contracting" ? "low" : "normal",
          atrPercentile: undefined,
        } : undefined;
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
        let size = sizingResult.lots;
        if (correlationSizeMultiplier < 1.0) {
          size = Math.round(size * correlationSizeMultiplier * 100) / 100;
          if (size < 0.01) size = 0.01; // Floor at minimum lot
          console.log(`[${pair}] Correlation advisory reduced size: ${sizingResult.lots} → ${size} (×${correlationSizeMultiplier.toFixed(2)})`);
        }
        if (sizingResult.adjustments.length > 0) {
          console.log(`[${pair}] Unified sizing: base=${sizingResult.baseLots} → final=${size} [${sizingResult.adjustments.map(a => `${a.type}:${a.multiplier.toFixed(2)}`).join(", ")}]`);
        }
        // ── Signal Source Size Multiplier ──
        // Unified signal = full conviction (1.0x). Standalone fallback = half size (0.5x).
        // This reflects the higher confidence when the full story (impulse + liquidity +
        // confirmation) aligns vs just the impulse zone engine alone.
        if ((detail as any).signalSource !== "unified") {
          const standaloneMultiplier = 0.5;
          const prevSize = size;
          size = Math.round(size * standaloneMultiplier * 100) / 100;
          if (size < 0.01) size = 0.01; // Floor at minimum lot
          console.log(`[${pair}] Signal source: standalone \u2014 size reduced ${prevSize} \u2192 ${size} (\u00d7${standaloneMultiplier})`);
        } else {
          console.log(`[${pair}] Signal source: unified \u2014 full size ${size} (\u00d71.0)`);
        }

        const positionId = crypto.randomUUID().slice(0, 8);
        const orderId = crypto.randomUUID().slice(0, 8);
        const nowStr = new Date().toISOString();

        // Close on Reverse: close existing opposite-direction positions for this symbol (Fix #8 — calc real PnL)
        if (pairConfig.closeOnReverse) {
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
            // Critical fix: never iterate ALL active broker_connections — that would close trades
            // on brokers that never received this paper position in the first place.
            if (account.execution_mode === "live" && oppMirroredIds.length > 0) {
              const { data: closeConns } = await supabase.from("broker_connections")
                .select("*").eq("user_id", userId).eq("broker_type", "metaapi")
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
                    // Use region-failover metaFetch instead of hardcoded London URL
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
          // C6 fix: Remove closed opposite positions from the in-memory array
          // so Gate 4 (max open positions) and Gate 5 (max per symbol) don't
          // over-count for remaining pairs in this scan cycle.
          const closedIds = new Set(oppositePositions.map((p: any) => p.position_id));
          openPosArr = openPosArr.filter((p: any) => !closedIds.has(p.position_id));
        }

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
          breakEvenOffsetPips: pairConfig.breakEvenOffsetPips,
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
        const useMarketFillAtZone = priceIsAtValidatedZone && config.marketFillAtZone && priceOnCorrectSide;

        // Auto-enable limit orders ONLY when price is NOT at zone (watching path)
        // or when marketFillAtZone is explicitly disabled.
        const effectiveLimitEnabled = !useMarketFillAtZone && (config.limitOrderEnabled || (izGateMode === "hard" && !!limitEntry));
        if (effectiveLimitEnabled && limitEntry) {
          // Place a pending limit order instead of executing immediately
          const pendingOrderId = crypto.randomUUID().slice(0, 8);
          const expiryMinutes = config.limitOrderExpiryMinutes || 60;
          const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();

          // Recalculate SL/TP relative to the limit entry price for better R:R
          let limitSL = sl;
          let limitTP = tp;
          const riskFromLimit = Math.abs(limitEntry.price - sl);
          if (analysis.direction === "long") {
            limitTP = limitEntry.price + riskFromLimit * config.tpRatio;
          } else {
            limitTP = limitEntry.price - riskFromLimit * config.tpRatio;
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
          let limitSize = limitSizingResult.lots;
          // Apply signal source size multiplier to limit orders too
          if ((detail as any).signalSource !== "unified") {
            limitSize = Math.round(limitSize * 0.5 * 100) / 100;
            if (limitSize < 0.01) limitSize = 0.01;
          }

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
            signal_reason: JSON.stringify({ bot: BOT_ID, summary: analysis.summary, setupType: setupClassification.setupType, setupConfidence: setupClassification.confidence, entryTimeframe: pairConfig.entryTimeframe, originalSL: limitSL, originalTP: limitTP, exitFlags, factorScores: analysis.factors, tieredScoring: analysis.tieredScoring || null, regimeData: detail.regimeData || null, confluenceStacking: detail.confluenceStacking || null, sweepReclaim: detail.sweepReclaim || null, pullbackHealth: detail.pullbackHealth || null, structureIntel: detail.structureIntel || null, entityLifecycles: detail.analysis_snapshot?.entityLifecycles || null, gates: detail.gates || null, setupClassification: detail.setupClassification || null, fibLevels: detail.fibLevels || null, impulseZone: (detail as any).impulseZone || null, directionVerdict: (detail as any).directionVerdict || null, ...(isPromotedFromStaging && existingStaged ? { promotedFromWatchlist: true, watchlistOrigin: { initialScore: parseFloat(existingStaged.initial_score), cyclesWatched: existingStaged.scan_cycles + 1, stagedAt: existingStaged.staged_at } } : {}) }),
            signal_score: analysis.score,
            setup_type: setupClassification.setupType,
            setup_confidence: setupClassification.confidence,
            from_watchlist: isPromotedFromStaging || false,
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
            scanDetails.push(detail);
            continue;
          }

          pendingPlaced++;
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
          if (isPromotedFromStaging && existingStaged) {
            detail.staging = { action: "promoted_to_limit", cycles: existingStaged.scan_cycles + 1, initialScore: parseFloat(existingStaged.initial_score) };
          }
          detail.size = limitSize;
          detail.entryPrice = limitEntry.price;
          detail.stopLoss = limitSL;
          detail.takeProfit = limitTP;

          // Telegram notification for zone setup activation
          if (telegramChatIds.length > 0 && shouldNotify("zone_setup_active")) {
            const emoji = analysis.direction === "long" ? "🟢" : "🔴";
            const mode = account.execution_mode === "live" ? "LIVE" : "PAPER";
            const msg = `${emoji} <b>${mode} Zone Setup ACTIVE</b>

` +
              `<b>Symbol:</b> ${pair}
` +
              `<b>Direction:</b> ${analysis.direction.toUpperCase()}
` +
              `<b>Zone Trigger:</b> ${limitEntry.price.toFixed(5)} (${limitEntry.zoneType} zone)
` +
              `<b>Current Price:</b> ${analysis.lastPrice}
` +
              `<b>Size:</b> ${limitSize} lots
` +
              `<b>SL:</b> ${limitSL}
` +
              `<b>TP:</b> ${limitTP}
` +
              `<b>Score:</b> ${analysis.score.toFixed(1)}
` +
              `<b>Confirmation:</b> ${unifiedZoneData?.confirmation ? `${unifiedZoneData.confirmation.type.replace(/_/g, " ")}${unifiedZoneData.confirmation.entryReady ? " \u2713" : " (pending)"} — ${unifiedZoneData.confirmation.detail}` : "Waiting for 5m CHoCH at zone"}
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
          scanDetails.push(detail);
          continue;
        }
        await supabase.from("paper_positions").insert({
          user_id: userId,
          position_id: positionId,
          symbol: pair,
          direction: analysis.direction,
          size: size.toString(),
          entry_price: marketEntryPrice.toString(),
          current_price: analysis.lastPrice.toString(),
          stop_loss: sl.toString(),
          take_profit: tp.toString(),
          open_time: nowStr,
          signal_reason: JSON.stringify({ bot: BOT_ID, summary: analysis.summary, setupType: setupClassification.setupType, setupConfidence: setupClassification.confidence, setupRationale: setupClassification.rationale, entryTimeframe: pairConfig.entryTimeframe, originalSL: sl, originalTP: tp, exitFlags, spreadFilter: { enabled: pairConfig.spreadFilterEnabled, maxPips: pairConfig.maxSpreadPips }, newsFilter: { enabled: pairConfig.newsFilterEnabled, pauseMinutes: pairConfig.newsFilterPauseMinutes }, fotsi: analysis.fotsiAlignment ? { base: analysis.fotsiAlignment.baseTSI, quote: analysis.fotsiAlignment.quoteTSI, spread: analysis.fotsiAlignment.spread, score: analysis.fotsiAlignment.score, label: analysis.fotsiAlignment.label } : null, factorScores: analysis.factors, tieredScoring: analysis.tieredScoring || null, regimeData: detail.regimeData || null, confluenceStacking: detail.confluenceStacking || null, sweepReclaim: detail.sweepReclaim || null, pullbackHealth: detail.pullbackHealth || null, structureIntel: detail.structureIntel || null, entityLifecycles: detail.analysis_snapshot?.entityLifecycles || null, gates: detail.gates || null, setupClassification: detail.setupClassification || null, fibLevels: detail.fibLevels || null, impulseZone: (detail as any).impulseZone || null, directionVerdict: (detail as any).directionVerdict || null, ...(isPromotedFromStaging && existingStaged ? { promotedFromWatchlist: true, watchlistOrigin: { initialScore: parseFloat(existingStaged.initial_score), cyclesWatched: existingStaged.scan_cycles + 1, stagedAt: existingStaged.staged_at, promotionReason: `Score reached ${analysis.score.toFixed(1)}% (gate: ${adjustedMinConfluence}%) after ${existingStaged.scan_cycles + 1} cycles` } } : {}) }),
          signal_score: analysis.score.toString(),
          order_id: orderId,
          position_status: "open",
          bot_id: BOT_ID,
        });

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
          const msg = `${emoji} <b>${mode} Trade Opened</b>\n\n` +
            `<b>Symbol:</b> ${pair}\n` +
            `<b>Direction:</b> ${analysis.direction.toUpperCase()}\n` +
            `<b>Size:</b> ${size} lots\n` +
            `<b>Entry:</b> ${analysis.lastPrice}\n` +
            `<b>SL:</b> ${sl}\n` +
            `<b>TP:</b> ${tp}\n` +
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
                    // Non-MetaAPI brokers (e.g. OANDA) are mirrored via the broker-execute function
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
                        userId,
                      }),
                    });
                    const exBody = await exRes.text();
                    let parsedEx: any = null;
                    try { parsedEx = JSON.parse(exBody); } catch {}
                    if (exRes.ok && !(parsedEx?.error)) {
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
                      const reason = parsedEx?.error || exBody.slice(0, 200);
                      console.warn(`Broker mirror [${conn.display_name}] (${conn.broker_type}) failed: ${reason}`);
                      mirrorResults.push(`${conn.display_name}: skipped — ${reason}`);
                      // Circuit breaker: record failure (transient if HTTP error, permanent if auth)
                      const isTransient = !reason.includes("auth") && !reason.includes("invalid");
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
                   const { res: mt5Res, body: resBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/trade`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mt5Body) });
                   if (mt5Res.ok) {
                     console.log(`Broker mirror [${conn.display_name}]: SUCCESS ${mt5Res.status} — ${resBody.slice(0, 500)}`);
                     try {
                       const parsed = JSON.parse(resBody);
                         if (parsed.stringCode && parsed.stringCode !== "TRADE_RETCODE_DONE" && parsed.stringCode !== "ERR_NO_ERROR") {
                           console.warn(`Broker mirror [${conn.display_name}]: trade rejected by broker — ${parsed.stringCode}: ${parsed.message || ""}`);
                           mirrorResults.push(`${conn.display_name}: rejected ${parsed.stringCode}`);
                           // Circuit breaker: broker rejection is NOT transient (won't open circuit)
                           brokerHealthMap[conn.id] = updateHealth(connHealth, { connectionId: conn.id, success: false, latencyMs: 0, error: parsed.stringCode, isTransient: false });
                        } else {
                          mirrorResults.push(`${conn.display_name}: success`);
                          mirroredConnIds.push(conn.id);
                          // Circuit breaker: record success
                          brokerHealthMap[conn.id] = updateHealth(connHealth, { connectionId: conn.id, success: true, latencyMs: 0, isTransient: false });
                          // Auto-detect commission from MetaApi trade response
                          try {
                            const orderId = parsed.orderId || parsed.positionId;
                            if (orderId) {
                              // Fetch the deal associated with this order to get commission + fill price
                              const { res: dealRes, body: dealBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/history-deals/position/${orderId}`);
                              if (dealRes.ok) {
                                const deals = JSON.parse(dealBody);
                                const dealArr = Array.isArray(deals) ? deals : [];
                                for (const deal of dealArr) {
                                  // Extract actual fill price from deal (first deal with price is the entry)
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
                                      const commPerLot = dealComm / dealVol; // per-side per lot
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
                        }
                      } catch { mirrorResults.push(`${conn.display_name}: success`); mirroredConnIds.push(conn.id); }
                   } else {
                     console.warn(`Broker mirror [${conn.display_name}] failed [${mt5Res.status}]: ${resBody.slice(0, 500)}`);
                     mirrorResults.push(`${conn.display_name}: failed ${mt5Res.status}`);
                     // Circuit breaker: record failure
                     const isTransient = mt5Res.status >= 500 || mt5Res.status === 429;
                     brokerHealthMap[conn.id] = updateHealth(connHealth, { connectionId: conn.id, success: false, latencyMs: 0, error: `HTTP ${mt5Res.status}`, isTransient });
                   }
                 } catch (connErr: any) {
                  console.warn(`Broker mirror [${conn.display_name}] error: ${connErr?.message || connErr}`);
                  mirrorResults.push(`${conn.display_name}: error`);
                  // Circuit breaker: record transient failure
                  brokerHealthMap[conn.id] = updateHealth(connHealth, {
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
            stopLoss: analysis.stopLoss,
            takeProfit: analysis.takeProfit,
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
          });
        } catch (rsErr: any) {
          // Non-fatal: logging failure must never block the scanner
          console.warn(`[rejected-setup] Logging error for ${pair}: ${rsErr?.message}`);
        }
      }
    } else {
      if (analysis.score < adjustedMinConfluence) {
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
              stopLoss: analysis.stopLoss,
              takeProfit: analysis.takeProfit,
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
      pendingOrders: (config.limitOrderEnabled || config.impulseZoneGateMode === "hard") ? { enabled: true, autoEnabled: !config.limitOrderEnabled && config.impulseZoneGateMode === "hard", active: (activePendingOrders?.length || 0) - pendingFilled - pendingExpired - pendingCancelled, filled: pendingFilled, expired: pendingExpired, cancelled: pendingCancelled, placed: pendingPlaced, awaitingConfirmation: pendingConfirmationHunting } : { enabled: false },
      rejectionSummary,
      activeStyle: resolvedStyle,  // Trading style used for this scan cycle
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

  return { pairsScanned: config.instruments.length, signalsFound, tradesPlaced, rejected: rejectedCount, details: scanDetails, activeStyle: resolvedStyle, resolvedMinConfluence: config.minConfluence, scanCycleId, managementActions: managementActions.filter(a => a.action !== "no_change"), staging: stagingEnabled ? { watching: activeStagedSetups.length - stagedPromoted - stagedInvalidated, promoted: stagedPromoted, expired: stagedExpired, invalidated: stagedInvalidated, newlyStaged: stagedNew } : null, pendingOrders: (config.limitOrderEnabled || config.impulseZoneGateMode === "hard") ? { active: (activePendingOrders?.length || 0) - pendingFilled - pendingExpired - pendingCancelled, filled: pendingFilled, expired: pendingExpired, cancelled: pendingCancelled, placed: pendingPlaced, awaitingConfirmation: pendingConfirmationHunting } : null };
  } finally {
    // Always release the scan lock and clear the source tally, even on error.
    try { endScanSourceTally(); } catch { /* ignore */ }
    try { scanCache.clear(); } catch { /* ignore */ }
    // Only release lock if we acquired one (management-only skips locking)
    if (!opts?.isManagementOnly) {
      try {
        const lockRelease = supabase.from("paper_accounts").update({ scan_lock_until: null }).eq("user_id", userId);
        if (account?.bot_id) lockRelease.eq("bot_id", BOT_ID);
        await lockRelease;
      } catch (e: any) {
        console.warn(`[scan-lock] release failed for ${userId}: ${e?.message}`);
      }
    }
  }
}

function respond(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
