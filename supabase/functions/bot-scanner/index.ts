import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { fetchCandlesWithFallback, beginScanSourceTally, endScanSourceTally, resetThrottleStats, type BrokerConn } from "../_shared/candleSource.ts";
import {
  computeFOTSI, getCurrencyAlignment, checkOverboughtOversoldVeto,
  parsePairCurrencies, getFOTSIPairNames,
  type FOTSIResult, type Currency,
} from "../_shared/fotsi.ts";
import {
  classifyInstrumentRegime,
  // Types
  type Candle, type SwingPoint, type OrderBlock,
  type LiquidityPool, type BreakerBlock, type UnicornSetup,
  type SMTResult, type AMDResult, type SilverBulletResult, type MacroWindowResult,
  type ReasoningFactor, type GateResult,
  // Constants
  SPECS, SUPPORTED_SYMBOLS, SMT_PAIRS, ASSET_PROFILES, getAssetProfile,
  // Analysis functions
  calculateATR, calculateAnchoredVWAP,
  detectSwingPoints, analyzeMarketStructure,
  detectOrderBlocks, detectFVGs, detectLiquidityPools,
  detectDisplacement, tagDisplacementQuality,
  detectBreakerBlocks, detectUnicornSetups,
  detectJudasSwing, detectReversalCandle,
  calculatePDLevels,
  computeOpeningRange, calculateSLTP,
  // Confluence stacking, sweep reclaim, pullback decay
  computeConfluenceStacking, detectSweepReclaim, measurePullbackDecay,
  type ConfluenceStack, type SweepReclaim, type PullbackDecay,
  type FairValueGap,
  // ZigZag pivot detection & Fibonacci levels
  detectZigZagPivots, computeFibLevels,
  type ZigZagPivot, type FibLevel, type FibLevels,
  // Optimal style detection
  detectOptimalStyle,
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
  tpMethod: "rr_ratio" as "fixed_pips" | "rr_ratio" | "next_level" | "atr_multiple",
  fixedTPPips: 50,
  tpRatio: 2.0,
  tpATRMultiple: 2.0,
  breakEvenEnabled: true,
  breakEvenPips: 20,
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
  partialTPEnabled: false,
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
  // ── Per-pair scratch (set during scan) ──
  _currentSymbol: "" as string,
  _smtResult: null as any,
  // ── Factor Weights (config-driven, AI-tunable) ──
  factorWeights: {} as Record<string, number>,
  // ── Entry/HTF timeframes (set by style) ──
  entryTimeframe: "15min",
  htfTimeframe: "1day",
};
// ─── Resolve symbol name with per-symbol overrides or default suffix ──
function normalizeSymKey(s: string): string {
  return (s || "").toString().trim().toUpperCase().replace(/[\s/._-]/g, "");
}
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
    entryTimeframe: "5m",
    htfTimeframe: "1h",
    tpRatio: 1.5,
    slBufferPips: 1,
    minConfluence: 40,  // Percentage — scalpers use lower threshold
    // Scalper management: fast BE at 0.75R, tight trailing, no partial, short hold
    // On 5m chart with ~10-15 pip SL, BE triggers at ~10 pips, trail at ~7 pips
    trailingStopEnabled: true,
    trailingStopPips: 8,            // minimum trail; proportional (0.5× SL) may be larger
    trailingStopActivation: "after_1r",  // Changed from 0.5R — let scalps reach 1R before trailing
    breakEvenEnabled: true,
    breakEvenPips: 8,               // fallback; R-based trigger (min 1R) takes precedence
    partialTPEnabled: false,
    maxHoldEnabled: true,
    maxHoldHours: 4,
  },
  day_trader: {
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
    entryTimeframe: "1h",
    htfTimeframe: "1w",
    tpRatio: 3.0,
    slBufferPips: 5,
    minConfluence: 65,  // Percentage — swing traders require higher confluence
    // Swing management: wide breathing room, partial at 1R + 2R, trailing after 2R
    // On 1h chart with ~40-60 pip SL, BE at ~40-60 pips, trail at ~20-30 pips
    trailingStopEnabled: true,
    trailingStopPips: 25,           // minimum trail; proportional (0.5× SL) may be larger
    trailingStopActivation: "after_2r", // Changed from 1R — let swings develop before trailing
    breakEvenEnabled: true,
    breakEvenPips: 40,              // fallback; R-based trigger (min 1R) takes precedence
    partialTPEnabled: true,
    partialTPPercent: 33,           // Changed: take 33% at 1R (keep more for the big move)
    partialTPLevel: 1.0,            // Changed from 1.5R: lock in profit earlier
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

// ─── Hardcoded fallback rates (approximate) — prevents catastrophic sizing errors when API fails ──
const FALLBACK_RATES: Record<string, number> = {
  "USD/JPY": 142.0,
  "GBP/USD": 1.27,
  "AUD/USD": 0.66,
  "NZD/USD": 0.61,
  "USD/CAD": 1.36,
  "USD/CHF": 0.88,
};

// ─── Quote-to-USD conversion (local copy matching shared/smcAnalysis.ts) ──
function getQuoteToUSDRate(symbol: string, rateMap?: Record<string, number>): number {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  if (spec.type !== "forex") return 1.0;
  const parts = symbol.split("/");
  if (parts.length !== 2) return 1.0;
  const quote = parts[1];
  if (quote === "USD") return 1.0;
  const QUOTE_CONVERSION: Record<string, { pair: string; invert: boolean }> = {
    "JPY": { pair: "USD/JPY", invert: true },
    "GBP": { pair: "GBP/USD", invert: false },
    "AUD": { pair: "AUD/USD", invert: false },
    "NZD": { pair: "NZD/USD", invert: false },
    "CAD": { pair: "USD/CAD", invert: true },
    "CHF": { pair: "USD/CHF", invert: true },
  };
  const conv = QUOTE_CONVERSION[quote];
  if (!conv) return 1.0;
  // Try live rate first, then fallback to approximate hardcoded rate
  const liveRate = rateMap?.[conv.pair];
  const rate = (liveRate && liveRate > 0) ? liveRate : FALLBACK_RATES[conv.pair];
  if (!rate || rate <= 0) return 1.0;
  return conv.invert ? (1 / rate) : rate;
}

// ─── Minimum SL distance per asset class (in pips) ────────────────────────────────────
// Prevents absurdly tight SLs that produce micro-scalp trades with 2-5 pip targets.
// These floors ensure trades have room to breathe and TP targets are meaningful after spread.
const MIN_SL_PIPS: Record<string, number> = {
  // JPY crosses — high volatility
  "GBP/JPY": 35, "EUR/JPY": 30, "USD/JPY": 25,
  "AUD/JPY": 25, "CAD/JPY": 25, "NZD/JPY": 25, "CHF/JPY": 25,
  // GBP crosses — above-average volatility
  "GBP/USD": 25, "GBP/AUD": 30, "GBP/CAD": 30, "GBP/NZD": 30, "GBP/CHF": 25,
  // EUR crosses — moderate volatility
  "EUR/USD": 20, "EUR/GBP": 15, "EUR/AUD": 25, "EUR/CAD": 25, "EUR/NZD": 25, "EUR/CHF": 18,
  // USD crosses — moderate volatility
  "AUD/USD": 18, "NZD/USD": 18, "USD/CAD": 18, "USD/CHF": 18,
  // Minor crosses
  "AUD/CAD": 20, "AUD/NZD": 20, "AUD/CHF": 20, "NZD/CAD": 20, "NZD/CHF": 20, "CAD/CHF": 18,
  // Commodities & crypto
  "XAU/USD": 50, "BTC/USD": 150,
};
// ATR-based dynamic SL floor: SL must be at least this multiple of ATR(14).
// This adapts to current volatility — wider during active sessions, tighter during quiet periods.
const ATR_SL_FLOOR_MULTIPLIER = 1.5;

// ─── Position sizing ────────────────────────────────────────────────
// rateMap: optional map of { "USD/JPY": 150, "GBP/USD": 1.27, ... }
// fallbackMaxLot: optional override for the hardcoded max lot cap.
function calculatePositionSize(
  balance: number, riskPercent: number, entryPrice: number, stopLoss: number, symbol: string,
  config?: { positionSizingMethod?: string; fixedLotSize?: number; atrValue?: number; atrVolatilityMultiplier?: number },
  rateMap?: Record<string, number>,
  fallbackMaxLot?: number,
  commissionPerLot?: number,
): number {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  const typeMaxLot = spec.type === "index" ? 50 : spec.type === "commodity" ? 10 : spec.type === "crypto" ? 100 : 5;
  // Account-relative cap: max 10x leverage (notional / balance)
  // e.g., $10k account → max $100k notional → ~0.47 lots on GBP/JPY at 214
  const priceInUSD = spec.type === "forex" ? entryPrice * getQuoteToUSDRate(symbol, rateMap) : entryPrice;
  const maxLeverage = 10;
  const accountMaxLot = balance > 0 ? (balance * maxLeverage) / (spec.lotUnits * priceInUSD) : 0.01;
  const maxLot = fallbackMaxLot ?? Math.min(typeMaxLot, Math.max(0.01, Math.round(accountMaxLot * 100) / 100));
  const method = config?.positionSizingMethod || "percent_risk";
  const quoteToUSD = getQuoteToUSDRate(symbol, rateMap);
  // Round-trip commission per lot in account currency (default 0)
  const commRT = commissionPerLot ?? 0;

  if (method === "fixed_lot") {
    const fixed = config?.fixedLotSize ?? 0.01;
    return Math.max(0.01, Math.min(maxLot, Math.round(fixed * 100) / 100));
  }

  if (method === "volatility_adjusted" && config?.atrValue && config.atrValue > 0) {
    const riskAmount = balance * (riskPercent / 100);
    const atrMultiplier = config.atrVolatilityMultiplier ?? 1.5;
    const atrDistance = config.atrValue * atrMultiplier;
    if (atrDistance === 0) return 0.01;
    // Iterative solve: lots = (riskAmount - lots*commission) / (distance*lotUnits*quoteToUSD)
    // First pass without commission, then adjust
    let lots = riskAmount / (atrDistance * spec.lotUnits * quoteToUSD);
    if (commRT > 0) {
      const adjustedRisk = riskAmount - (lots * commRT);
      if (adjustedRisk > 0) lots = adjustedRisk / (atrDistance * spec.lotUnits * quoteToUSD);
    }
    return Math.max(0.01, Math.min(maxLot, Math.round(lots * 100) / 100));
  }

  // Default: percent_risk (risk-based)
  const riskAmount = balance * (riskPercent / 100);
  const slDistance = Math.abs(entryPrice - stopLoss);
  if (slDistance === 0) return 0.01;
  // Iterative solve: lots = (riskAmount - lots*commission) / (slDistance*lotUnits*quoteToUSD)
  let lots = riskAmount / (slDistance * spec.lotUnits * quoteToUSD);
  if (commRT > 0) {
    const adjustedRisk = riskAmount - (lots * commRT);
    if (adjustedRisk > 0) lots = adjustedRisk / (slDistance * spec.lotUnits * quoteToUSD);
  }
  return Math.max(0.01, Math.min(maxLot, Math.round(lots * 100) / 100));
}

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
  if (!data?.config_json) return { ...DEFAULTS, enableOB: true, enableFVG: true, enableLiquiditySweep: true, enableStructureBreak: true, cooldownMinutes: 0, closeOnReverse: false, trailingStopEnabled: false, partialTPEnabled: false, maxHoldEnabled: false, maxHoldHours: 0, killZoneOnly: false, maxConsecutiveLosses: 0, protectionMaxDailyLossDollar: 0 };

  const raw = data.config_json as any;
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
    // Volume Profile / Trend Direction / Daily Bias toggles (UI writes, scanner now respects)
    useVolumeProfile: strategy.useVolumeProfile ?? true,
    useTrendDirection: strategy.useTrendDirection ?? true,
    useDailyBias: strategy.useDailyBias ?? true,
    // Regime scoring (UI writes under strategy.*; scanner reads at top level)
    regimeScoringEnabled: strategy.regimeScoringEnabled ?? raw.regimeScoringEnabled ?? true,
    regimeScoringStrength: strategy.regimeScoringStrength ?? raw.regimeScoringStrength ?? 1.0,
    // Normalized scoring (opt-in: percentage-based scoring that auto-adjusts when factors are toggled)
    normalizedScoring: strategy.normalizedScoring ?? raw.normalizedScoring ?? false,
    // ── P1 tuning fields (now wired to scanner) ──
    obLookbackCandles: strategy.obLookbackCandles ?? raw.obLookbackCandles ?? 50,
    fvgMinSizePips: strategy.fvgMinSizePips ?? raw.fvgMinSizePips ?? 0,
    fvgOnlyUnfilled: strategy.fvgOnlyUnfilled ?? raw.fvgOnlyUnfilled ?? true,
    structureLookback: strategy.structureLookback ?? raw.structureLookback ?? 50,
    liquidityPoolMinTouches: strategy.liquidityPoolMinTouches ?? raw.liquidityPoolMinTouches ?? 2,
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

    // ── Limit Orders ──
    limitOrderEnabled: entry.limitOrderEnabled ?? raw.limitOrderEnabled ?? DEFAULTS.limitOrderEnabled,
    limitOrderExpiryMinutes: entry.limitOrderExpiryMinutes ?? raw.limitOrderExpiryMinutes ?? DEFAULTS.limitOrderExpiryMinutes,
    limitOrderMaxDistancePips: entry.limitOrderMaxDistancePips ?? raw.limitOrderMaxDistancePips ?? DEFAULTS.limitOrderMaxDistancePips,
    limitOrderMinDistancePips: entry.limitOrderMinDistancePips ?? raw.limitOrderMinDistancePips ?? DEFAULTS.limitOrderMinDistancePips,
    limitOrderPreferZone: entry.limitOrderPreferZone ?? raw.limitOrderPreferZone ?? DEFAULTS.limitOrderPreferZone,
  };

  return merged;
}

// ─── Safety Gates ───────────────────────────────────────────────────

async function runSafetyGates(
  supabase: any, userId: string, symbol: string, direction: string,
  analysis: any, config: typeof DEFAULTS, account: any, openPositions: any[],
  dailyCandles: Candle[] | null,
  rateMap?: Record<string, number>,
): Promise<GateResult[]> {
  const gates: GateResult[] = [];

  // Gate 1: HTF Bias Alignment
  // Uses cachedDailyStructure from analysis to avoid redundant computation
  if (config.htfBiasRequired && (analysis.cachedDailyStructure || (dailyCandles && dailyCandles.length >= 10))) {
    const htfStructure = analysis.cachedDailyStructure || analyzeMarketStructure(dailyCandles!);
    const htfTrend = htfStructure.trend;
    const entryBias = direction === "long" ? "bullish" : "bearish";
    const hardVeto = config.htfBiasHardVeto;
    if (hardVeto) {
      // Hard veto: must match exactly. Ranging blocks everything. No exceptions.
      if (htfTrend !== entryBias) {
        gates.push({ passed: false, reason: `HTF HARD VETO: Daily is ${htfTrend}, ${entryBias} entry blocked` });
      } else {
        gates.push({ passed: true, reason: `HTF bias aligned (hard veto): Daily ${htfTrend}` });
      }
    } else {
      // Soft mode: ranging allowed, only mismatch blocks
      if (htfTrend !== "ranging" && htfTrend !== entryBias) {
        gates.push({ passed: false, reason: `HTF bias mismatch: Daily is ${htfTrend}, entry is ${entryBias}` });
      } else {
        gates.push({ passed: true, reason: `HTF bias aligned: Daily ${htfTrend}` });
      }
    }
  } else {
    gates.push({ passed: true, reason: "HTF check skipped" });
  }

  // Gate 2: Premium/Discount zone filter
  if (config.onlyBuyInDiscount && direction === "long" && analysis.pd.currentZone === "premium") {
    gates.push({ passed: false, reason: "Buying in premium zone rejected" });
  } else if (config.onlySellInPremium && direction === "short" && analysis.pd.currentZone === "discount") {
    gates.push({ passed: false, reason: "Selling in discount zone rejected" });
  } else {
    gates.push({ passed: true, reason: "P/D zone OK" });
  }

  // Gate 3: Instrument enabled
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

  // Gate 8: Max drawdown
  const peakBalance = parseFloat(account.peak_balance || account.balance || "10000");
  const drawdownPercent = peakBalance > 0 ? ((peakBalance - balance) / peakBalance) * 100 : 0;
  if (drawdownPercent >= config.maxDrawdown) {
    gates.push({ passed: false, reason: `Drawdown ${drawdownPercent.toFixed(1)}% >= ${config.maxDrawdown}% limit` });
  } else {
    gates.push({ passed: true, reason: `Drawdown ${drawdownPercent.toFixed(1)}%` });
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
    const assetProfile = getAssetProfile(symbol);
    if (!assetProfile.skipSessionGate) {
      // S3 Fix: Use cachedSession from analysis instead of calling detectSession again.
      // The analysis object carries the session snapshot from the scan-cycle level.
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

  // Gate 17: FOTSI Overbought/Oversold Veto — hard-block trades buying exhausted currencies
  // Uses pre-computed FOTSI strengths from the scan cycle.
  // BUY blocked if base TSI > +50 (buying overbought currency)
  // SELL blocked if base TSI < -50 (selling oversold currency)
  // Also checks quote currency curve for secondary veto.
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
        gates.push({ passed: !veto.vetoed, reason: veto.reason });
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
    if (!ts.tier1GatePassed) {
      gates.push({ passed: false, reason: ts.tier1GateReason });
    } else {
      gates.push({ passed: true, reason: ts.tier1GateReason });
    }
  }

  // Gate 20: Regime Alignment (separate gate, not a score penalty)
  if (analysis.tieredScoring) {
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
      const results = [];
      for (const account of accounts) {
        try {
          const result = await runScanForUser(adminClient, account.user_id);
          results.push({ userId: account.user_id, ...result });
        } catch (e: any) {
          results.push({ userId: account.user_id, error: e.message });
        }
      }
      return respond({ scanned: results.length, results });
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
  const MAX_BROKER_RISK_PERCENT = 5; // hard safety cap per broker per trade
  const scanCycleId = crypto.randomUUID();

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
      "breakEvenEnabled", "breakEvenPips",
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
        const candles = await fetchCandles(sym, "15m", "5d");
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
      managementActions = await manageOpenPositions(supabase, positionsToManage, config, scanCycleId, fetchCandles, detectSession);
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
        if (telegramChatIds.length > 0) {
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

  // ── Build rateMap for cross-pair lot sizing & PnL conversion ──
  // Fetch last close prices for the 7 major pairs needed by getQuoteToUSDRate.
  const RATE_PAIRS = ["USD/JPY", "GBP/USD", "AUD/USD", "NZD/USD", "USD/CAD", "USD/CHF"];
  const rateMap: Record<string, number> = {};
  try {
    const rateFetches = await Promise.all(
      RATE_PAIRS.map(p => fetchCandles(p, "1d", "5d").catch(() => [] as Candle[]))
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
        if (telegramChatIds.length > 0) {
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

  // ── FOTSI: Fetch 28 pairs and compute currency strengths once per scan cycle ──
  let _fotsiResult: FOTSIResult | null = null;
  try {
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
        batch.map(p => fetchCandles(p, "1d", "6mo").catch(() => [] as any[]))
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
      console.log(`[scan ${scanCycleId}] FOTSI computed: ${fetchedCount}/28 pairs, missing: [${_fotsiResult.missingPairs.join(", ")}]`);
      console.log(`[scan ${scanCycleId}] FOTSI strengths: ${JSON.stringify(Object.fromEntries(Object.entries(_fotsiResult.strengths).map(([k, v]) => [k, (v as number).toFixed(1)])))}`); 
    } else {
      console.warn(`[scan ${scanCycleId}] FOTSI skipped: only ${fetchedCount}/28 pairs fetched (need ≥20)`);
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

  // ── Limit Orders: Monitor active pending orders for fills/expiry ──
  let pendingFilled = 0;
  let pendingExpired = 0;
  let pendingCancelled = 0;
  let pendingPlaced = 0;
  const { data: activePendingOrders } = await supabase.from("pending_orders").select("*")
    .eq("user_id", userId).eq("bot_id", BOT_ID).eq("status", "pending")
    .order("placed_at", { ascending: true });

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
        const pendingCandles = await fetchCandles(pending.symbol, config.entryTimeframe || "15min", "5d").catch(() => [] as Candle[]);
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

        // Check fill: use candle low/high to detect if price touched the level
        const filled = pending.direction === "long"
          ? lastCandle.low <= entryPrice
          : lastCandle.high >= entryPrice;

        if (filled) {
          // L3 Fix: Check Gate 4/5 (max positions, max per symbol) at fill time.
          // Multiple limit orders can fill in the same cycle — enforce limits before creating position.
          const currentOpenCount = openPosArr.length;
          const currentSymbolCount = openPosArr.filter((p: any) => p.symbol === pending.symbol).length;
          if (currentOpenCount >= (parseInt(String(config.maxOpenPositions), 10) || 3)) {
            console.log(`[pending] SKIPPED fill ${pending.symbol} ${pending.direction} — max open positions reached (${currentOpenCount}/${config.maxOpenPositions})`);
            await supabase.from("pending_orders").update({
              status: "cancelled",
              cancel_reason: `Max open positions reached (${currentOpenCount}/${config.maxOpenPositions}) at fill time`,
              resolved_at: new Date().toISOString(),
            }).eq("order_id", pending.order_id).eq("user_id", userId);
            pendingCancelled++;
            continue;
          }
          if (currentSymbolCount >= (config.maxPerSymbol || 2)) {
            console.log(`[pending] SKIPPED fill ${pending.symbol} ${pending.direction} — max per symbol reached (${currentSymbolCount}/${config.maxPerSymbol})`);
            await supabase.from("pending_orders").update({
              status: "cancelled",
              cancel_reason: `Max per symbol reached (${currentSymbolCount}/${config.maxPerSymbol}) at fill time`,
              resolved_at: new Date().toISOString(),
            }).eq("order_id", pending.order_id).eq("user_id", userId);
            pendingCancelled++;
            continue;
          }

          // L1 Fix: Use the actual candle touch price for a more realistic fill.
          // For longs, the fill would occur at the candle low (or limit price if low < limit).
          // For shorts, the fill would occur at the candle high (or limit price if high > limit).
          const actualFillPrice = pending.direction === "long"
            ? Math.max(lastCandle.low, entryPrice)   // filled at low, but not below limit
            : Math.min(lastCandle.high, entryPrice);  // filled at high, but not above limit
          console.log(`[pending] FILLED ${pending.symbol} ${pending.direction} limit @ ${entryPrice} (actual fill: ${actualFillPrice}, current: ${currentPrice})`);

          const positionId = pending.order_id;
          const orderId = crypto.randomUUID().slice(0, 8);
          const nowStr = new Date().toISOString();
          const exitFlags = pending.exit_flags || {};

          // Build signal_reason with limit order provenance
          let parsedSignalReason: any = {};
          try { parsedSignalReason = typeof pending.signal_reason === "string" ? JSON.parse(pending.signal_reason) : (pending.signal_reason || {}); } catch {}
          const signalReason = {
            ...parsedSignalReason,
            filledFromLimitOrder: true,
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
            summary: `[LIMIT ORDER] ${pending.from_watchlist ? "[WATCHLIST] " : ""}Filled ${pending.direction.toUpperCase()} @ ${entryPrice} (${pending.entry_zone_type} zone)`,
            bias: pending.direction === "long" ? "bullish" : "bearish",
            session: "limit_fill",
            timeframe: config.entryTimeframe || "15min",
          });

          await supabase.from("pending_orders").update({
            status: "filled",
            fill_reason: `Price touched ${entryPrice} (candle low: ${lastCandle.low}, high: ${lastCandle.high})`,
            filled_at: nowStr,
            resolved_at: nowStr,
          }).eq("order_id", pending.order_id).eq("user_id", userId);

          pendingFilled++;
          tradesPlaced++;

          openPosArr.push({ symbol: pending.symbol, size: pending.size.toString(), entry_price: entryPrice.toString(), direction: pending.direction, position_id: positionId, position_status: "open", order_id: orderId, open_time: nowStr, signal_score: pending.signal_score?.toString() || "0" });

          // Send Telegram notification for limit order fill
          if (telegramChatIds.length > 0) {
            const emoji = pending.direction === "long" ? "🟢" : "🔴";
            const mode = account.execution_mode === "live" ? "LIVE" : "PAPER";
            const msg = `${emoji} <b>${mode} Limit Order FILLED</b>\n\n` +
              `<b>Symbol:</b> ${pending.symbol}\n` +
              `<b>Direction:</b> ${pending.direction.toUpperCase()}\n` +
              `<b>Size:</b> ${pending.size} lots\n` +
              `<b>Entry:</b> ${entryPrice} (limit)\n` +
              `<b>SL:</b> ${pending.stop_loss}\n` +
              `<b>TP:</b> ${pending.take_profit}\n` +
              `<b>Score:</b> ${pending.signal_score}\n` +
              `<b>Zone:</b> ${pending.entry_zone_type} [${parseFloat(pending.entry_zone_low || "0").toFixed(5)} - ${parseFloat(pending.entry_zone_high || "0").toFixed(5)}]` +
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
    console.log(`[scan ${scanCycleId}] Pending orders: ${pendingFilled} filled, ${pendingExpired} expired, ${pendingCancelled} cancelled`);
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
      pendingOrders: { filled: pendingFilled, expired: pendingExpired, cancelled: pendingCancelled },
      scanCycleId,
    };
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
              fetchCandles(sym, "1d", "1y").catch(() => [] as Candle[]),
              fetchCandles(sym, "4h", "1mo").catch(() => [] as Candle[]),
              fetchCandles(sym, getEntryInterval(config.entryTimeframe), getEntryRange(config.entryTimeframe)).catch(() => [] as Candle[]),
              fetchCandles(sym, "1h", "5d").catch(() => [] as Candle[]),
            ]);
            if (gpDaily.length < 10 || gpEntry.length < 10) return null;
            return generateInstrumentGamePlan(sym, gpDaily, gpH4, gpEntry, gpHourly, currentSessionName);
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
                  strength: pairBias.strength,
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
        if (gamePlanNotify && telegramChatIds.length > 0 && activeGamePlan.summary) {
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

  for (const pair of config.instruments) {
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
    // Each instrument fetches 2-4 candle sets in parallel, so spacing
    // instruments 1s apart keeps us at ~2-4 req/s = well under 50/min.
    if (scanDetails.length > 0) await new Promise(r => setTimeout(r, 1000));

    // Clone config per-instrument to prevent style mutation (Fix #6)
    let pairConfig = { ...config };

    // Determine entry TF based on style
    const entryInterval = getEntryInterval(pairConfig.entryTimeframe);
    const entryRange = getEntryRange(pairConfig.entryTimeframe);

    // Fetch entry TF, daily, 4H (for multi-TF regime), optionally 1h, and SMT correlated pair candles in parallel
    const orFlag = pairConfig.openingRange?.enabled ? 1 : 0;
    const smtPair = pairConfig.useSMT !== false ? SMT_PAIRS[pair] : undefined;
    const smtFlag = smtPair && SUPPORTED_SYMBOLS[smtPair] ? 1 : 0;
    const multiTFRegimeEnabled = (pairConfig as any).multiTFRegimeEnabled !== false; // ON by default
    const fetchPromises: Promise<Candle[]>[] = [
      fetchCandles(pair, entryInterval, entryRange),
      fetchCandles(pair, "1d", "1y"),
    ];
    // Always fetch 4H for multi-TF regime (reuses 1h data if OR is also enabled)
    if (multiTFRegimeEnabled) fetchPromises.push(fetchCandles(pair, "4h", "1mo").catch(() => [] as Candle[]));
    if (orFlag) fetchPromises.push(fetchCandles(pair, "1h", "2d"));
    if (smtFlag) fetchPromises.push(fetchCandles(smtPair!, entryInterval, entryRange));
    const fetched = await Promise.all(fetchPromises);
    const candles = fetched[0];
    const dailyCandles = fetched[1];
    const h4Candles: Candle[] = multiTFRegimeEnabled ? fetched[2] : [];
    const h4Offset = multiTFRegimeEnabled ? 1 : 0;
    const hourlyCandles = orFlag ? fetched[2 + h4Offset] : undefined;
    const smtCandles = smtFlag ? fetched[2 + h4Offset + orFlag] : null;

    if (candles.length < 30) {
      scanDetails.push({ pair, status: "skipped", reason: "Insufficient data" });
      continue;
    }

    // Apply asset-class profile adjustments
    const pairAssetProfileInner = getAssetProfile(pair);
    const adjustedSlBuffer = pairConfig.slBufferPips * pairAssetProfileInner.slBufferMultiplier;
    const adjustedMinConfluence = Math.max(1, pairConfig.minConfluence + pairAssetProfileInner.minConfluenceAdj);

    // Pass current symbol so SL calc uses correct pip size (Fix #3)
    pairConfig._currentSymbol = pair;
    // Compute SMT divergence vs correlated pair (if available) and inject into config
    pairConfig._smtResult = smtCandles ? detectSMTDivergence(pair, candles, smtCandles) : null;
    // Inject FOTSI result for Factor 18 (Currency Strength)
    (pairConfig as any)._fotsiResult = _fotsiResult;
    // Inject 4H candles for multi-TF regime classification
    (pairConfig as any)._h4Candles = h4Candles.length >= 20 ? h4Candles : null;
    const analysis = runConfluenceAnalysis(candles, dailyCandles.length >= 10 ? dailyCandles : null, pairConfig, hourlyCandles);
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
    };

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

    // Determine if this is a staged setup being promoted
    let isPromotedFromStaging = false;
    if (existingStaged && analysis.score >= adjustedMinConfluence && analysis.direction && !isPaused && stagingEnabled) {
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

    // Single percentage threshold gate (minFactorCount and minStrongFactors collapsed)
    if (analysis.score >= adjustedMinConfluence && analysis.direction && !isPaused) {
      signalsFound++;

      // Run safety gates
      const gates = await runSafetyGates(
        supabase, userId, pair, analysis.direction,
        analysis, pairConfig, account, openPosArr, dailyCandles.length >= 10 ? dailyCandles : null,
        rateMap,
      );
      // ── Game Plan Filter Gate ──
      // Check if the signal direction aligns with the session game plan bias.
      // Respects config: gamePlanFilterEnabled (bool), gamePlanMinConfidence (number).
      const gpFilterEnabled = (config as any).gamePlanFilterEnabled !== false; // ON by default
      const gpMinConfidence = Number((config as any).gamePlanMinConfidence) || 50;
      const gpFilter = filterTradeByGamePlan(activeGamePlan, pair, analysis.direction);
      if (gpFilterEnabled && !gpFilter.allowed) {
        // Check if the bias confidence exceeds the minimum threshold
        const pairPlan = activeGamePlan?.plans?.find((p: any) => p.symbol === pair);
        const biasConf = pairPlan?.biasConfidence ?? 0;
        if (biasConf >= gpMinConfidence) {
          gates.push({ passed: false, reason: gpFilter.reason });
          console.log(`[scan ${scanCycleId}] ❌ ${pair}: ${gpFilter.reason} (confidence ${biasConf}% >= ${gpMinConfidence}% threshold)`);
        } else {
          // Confidence too low to enforce the filter — allow the trade
          gates.push({ passed: true, reason: `Game plan: bias confidence ${biasConf}% below ${gpMinConfidence}% threshold — filter skipped` });
          console.log(`[scan ${scanCycleId}] ⚠️ ${pair}: Game plan bias confidence ${biasConf}% < ${gpMinConfidence}% threshold — allowing trade`);
        }
      } else if (!gpFilterEnabled && !gpFilter.allowed) {
        // Filter disabled — log but don't block
        gates.push({ passed: true, reason: `Game plan filter disabled — would have rejected: ${gpFilter.reason}` });
        console.log(`[scan ${scanCycleId}] ℹ️ ${pair}: Game plan filter OFF (would reject: ${gpFilter.reason})`);
      } else if (activeGamePlan) {
        gates.push({ passed: true, reason: gpFilter.reason });
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

        const size = calculatePositionSize(balance, pairConfig.riskPerTrade, analysis.lastPrice, sl, pair, {
          positionSizingMethod: (pairConfig as any).positionSizingMethod,
          fixedLotSize: (pairConfig as any).fixedLotSize,
          atrValue: (analysis as any).atrValue,
          atrVolatilityMultiplier: (pairConfig as any).atrVolatilityMultiplier,
        }, rateMap, undefined, avgCommissionPerLot);
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
        const limitEntry = computeLimitEntryPrice(analysis, pair, analysis.direction);
        if (config.limitOrderEnabled && limitEntry) {
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

          // Recalculate position size based on limit entry price
          const limitSize = calculatePositionSize(balance, pairConfig.riskPerTrade, limitEntry.price, limitSL, pair, {
            positionSizingMethod: (pairConfig as any).positionSizingMethod,
            fixedLotSize: (pairConfig as any).fixedLotSize,
            atrValue: (analysis as any).atrValue,
            atrVolatilityMultiplier: (pairConfig as any).atrVolatilityMultiplier,
          }, rateMap, undefined, avgCommissionPerLot);

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
            status: "pending",
            expiry_minutes: expiryMinutes,
            expires_at: expiresAt,
            signal_reason: JSON.stringify({ bot: BOT_ID, summary: analysis.summary, setupType: setupClassification.setupType, setupConfidence: setupClassification.confidence, entryTimeframe: pairConfig.entryTimeframe, originalSL: limitSL, originalTP: limitTP, exitFlags, factorScores: analysis.factors, tieredScoring: analysis.tieredScoring || null, regimeData: detail.regimeData || null, confluenceStacking: detail.confluenceStacking || null, sweepReclaim: detail.sweepReclaim || null, pullbackHealth: detail.pullbackHealth || null, structureIntel: detail.structureIntel || null, entityLifecycles: detail.analysis_snapshot?.entityLifecycles || null, gates: detail.gates || null, setupClassification: detail.setupClassification || null, fibLevels: detail.fibLevels || null, ...(isPromotedFromStaging && existingStaged ? { promotedFromWatchlist: true, watchlistOrigin: { initialScore: parseFloat(existingStaged.initial_score), cyclesWatched: existingStaged.scan_cycles + 1, stagedAt: existingStaged.staged_at } } : {}) }),
            signal_score: analysis.score,
            setup_type: setupClassification.setupType,
            setup_confidence: setupClassification.confidence === "high" ? 0.9 : setupClassification.confidence === "medium" ? 0.7 : 0.5,
            from_watchlist: isPromotedFromStaging || false,
            staged_cycles: isPromotedFromStaging && existingStaged ? existingStaged.scan_cycles + 1 : 0,
            staged_initial_score: isPromotedFromStaging && existingStaged ? parseFloat(existingStaged.initial_score) : null,
            exit_flags: exitFlags,
            placed_at: new Date().toISOString(),
          });

          if (pendingInsertErr) {
            console.error(`[pending] INSERT failed for ${pair}: ${pendingInsertErr.message}`);
            detail.status = "limit_order_insert_failed";
            detail.error = pendingInsertErr.message;
            continue;
          }

          pendingPlaced++;
          detail.status = isPromotedFromStaging ? "limit_order_from_watchlist" : "limit_order_placed";
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

          // Telegram notification for limit order placement
          if (telegramChatIds.length > 0) {
            const emoji = analysis.direction === "long" ? "🟢" : "🔴";
            const mode = account.execution_mode === "live" ? "LIVE" : "PAPER";
            const msg = `${emoji} <b>${mode} Limit Order PLACED</b>

` +
              `<b>Symbol:</b> ${pair}
` +
              `<b>Direction:</b> ${analysis.direction.toUpperCase()}
` +
              `<b>Limit Entry:</b> ${limitEntry.price.toFixed(5)} (${limitEntry.zoneType} zone)
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

        // Place position (market order — fallback when limit orders disabled or no zone found)
        await supabase.from("paper_positions").insert({
          user_id: userId,
          position_id: positionId,
          symbol: pair,
          direction: analysis.direction,
          size: size.toString(),
          entry_price: analysis.lastPrice.toString(),
          current_price: analysis.lastPrice.toString(),
          stop_loss: sl.toString(),
          take_profit: tp.toString(),
          open_time: nowStr,
          signal_reason: JSON.stringify({ bot: BOT_ID, summary: analysis.summary, setupType: setupClassification.setupType, setupConfidence: setupClassification.confidence, setupRationale: setupClassification.rationale, entryTimeframe: pairConfig.entryTimeframe, originalSL: sl, originalTP: tp, exitFlags, spreadFilter: { enabled: pairConfig.spreadFilterEnabled, maxPips: pairConfig.maxSpreadPips }, newsFilter: { enabled: pairConfig.newsFilterEnabled, pauseMinutes: pairConfig.newsFilterPauseMinutes }, fotsi: analysis.fotsiAlignment ? { base: analysis.fotsiAlignment.baseTSI, quote: analysis.fotsiAlignment.quoteTSI, spread: analysis.fotsiAlignment.spread, score: analysis.fotsiAlignment.score, label: analysis.fotsiAlignment.label } : null, factorScores: analysis.factors, tieredScoring: analysis.tieredScoring || null, regimeData: detail.regimeData || null, confluenceStacking: detail.confluenceStacking || null, sweepReclaim: detail.sweepReclaim || null, pullbackHealth: detail.pullbackHealth || null, structureIntel: detail.structureIntel || null, entityLifecycles: detail.analysis_snapshot?.entityLifecycles || null, gates: detail.gates || null, setupClassification: detail.setupClassification || null, fibLevels: detail.fibLevels || null, ...(isPromotedFromStaging && existingStaged ? { promotedFromWatchlist: true, watchlistOrigin: { initialScore: parseFloat(existingStaged.initial_score), cyclesWatched: existingStaged.scan_cycles + 1, stagedAt: existingStaged.staged_at, promotionReason: `Score reached ${analysis.score.toFixed(1)}% (gate: ${adjustedMinConfluence}%) after ${existingStaged.scan_cycles + 1} cycles` } } : {}) }),
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
        detail.status = isPromotedFromStaging ? "trade_placed_from_watchlist" : "trade_placed";
        if (isPromotedFromStaging && existingStaged) {
          detail.staging = { action: "promoted_and_traded", cycles: existingStaged.scan_cycles + 1, initialScore: parseFloat(existingStaged.initial_score) };
        }
        detail.size = size;
        detail.entryPrice = analysis.lastPrice;
        detail.stopLoss = sl;
        detail.takeProfit = tp;
        detail.positionId = positionId;
        detail.exitFlags = exitFlags;

        // Send Telegram notification to all configured chat IDs
        if (telegramChatIds.length > 0) {
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
            (isPromotedFromStaging && existingStaged ? `\n\n📋 <b>Promoted from Watchlist</b>\nWatched ${existingStaged.scan_cycles + 1} cycles | Started at ${parseFloat(existingStaged.initial_score).toFixed(1)}%` : "");
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
              for (const conn of connections) {
                try {
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
                      } catch (commErr: any) {
                        console.warn(`Commission auto-detect failed [${conn.display_name}]: ${commErr?.message}`);
                      }
                    } else {
                      const reason = parsedEx?.error || exBody.slice(0, 200);
                      console.warn(`Broker mirror [${conn.display_name}] (${conn.broker_type}) failed: ${reason}`);
                      mirrorResults.push(`${conn.display_name}: skipped — ${reason}`);
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
                     brokerVolume = calculatePositionSize(brokerBalance, cappedRisk, analysis.lastPrice, sl, pair, {
                       positionSizingMethod: (pairConfig as any).positionSizingMethod,
                       fixedLotSize: (pairConfig as any).fixedLotSize,
                       atrValue: (analysis as any).atrValue,
                       atrVolatilityMultiplier: (pairConfig as any).atrVolatilityMultiplier,
                     }, rateMap, undefined, connCommRT);
                     console.log(`[${conn.display_name} $${brokerBalance.toFixed(2)}] risk=${cappedRisk}% → size=${brokerVolume} (paper size was ${size})`);
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
                        } else {
                          mirrorResults.push(`${conn.display_name}: success`);
                          mirroredConnIds.push(conn.id);
                          // Auto-detect commission from MetaApi trade response
                          try {
                            const orderId = parsed.orderId || parsed.positionId;
                            if (orderId) {
                              // Fetch the deal associated with this order to get commission
                              const { res: dealRes, body: dealBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/history-deals/position/${orderId}`);
                              if (dealRes.ok) {
                                const deals = JSON.parse(dealBody);
                                const dealArr = Array.isArray(deals) ? deals : [];
                                for (const deal of dealArr) {
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
                   }
                 } catch (connErr: any) {
                  console.warn(`Broker mirror [${conn.display_name}] error: ${connErr?.message || connErr}`);
                  mirrorResults.push(`${conn.display_name}: error`);
                }
              }
              detail.mt5Mirror = mirrorResults.join("; ");
              detail.mirroredConnectionIds = mirroredConnIds;
              // Persist which broker connections this paper position was actually mirrored to.
              // Close paths use this list to fan out — never iterate ALL active connections.
              if (mirroredConnIds.length > 0) {
                await supabase.from("paper_positions")
                  .update({ mirrored_connection_ids: mirroredConnIds })
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
      }
    } else {
      if (analysis.score < adjustedMinConfluence) {
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
      staging: stagingEnabled ? { enabled: true, watching: activeStagedSetups.length - stagedPromoted - stagedInvalidated, promoted: stagedPromoted, expired: stagedExpired, invalidated: stagedInvalidated, newlyStaged: stagedNew } : { enabled: false },
      pendingOrders: config.limitOrderEnabled ? { enabled: true, active: (activePendingOrders?.length || 0) - pendingFilled - pendingExpired - pendingCancelled, filled: pendingFilled, expired: pendingExpired, cancelled: pendingCancelled, placed: pendingPlaced } : { enabled: false },
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

  return { pairsScanned: config.instruments.length, signalsFound, tradesPlaced, rejected: rejectedCount, details: scanDetails, activeStyle: resolvedStyle, resolvedMinConfluence: config.minConfluence, scanCycleId, managementActions: managementActions.filter(a => a.action !== "no_change"), staging: stagingEnabled ? { watching: activeStagedSetups.length - stagedPromoted - stagedInvalidated, promoted: stagedPromoted, expired: stagedExpired, invalidated: stagedInvalidated, newlyStaged: stagedNew } : null, pendingOrders: config.limitOrderEnabled ? { active: (activePendingOrders?.length || 0) - pendingFilled - pendingExpired - pendingCancelled, filled: pendingFilled, expired: pendingExpired, cancelled: pendingCancelled, placed: pendingPlaced } : null };
  } finally {
    // Always release the scan lock and clear the source tally, even on error.
    try { endScanSourceTally(); } catch { /* ignore */ }
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
