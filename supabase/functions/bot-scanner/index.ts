import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
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
  SPECS, YAHOO_SYMBOLS, SMT_PAIRS, ASSET_PROFILES, getAssetProfile,
  // Analysis functions
  calculateATR, calculateAnchoredVWAP,
  detectSwingPoints, analyzeMarketStructure,
  detectOrderBlocks, detectFVGs, detectLiquidityPools,
  detectDisplacement, tagDisplacementQuality,
  detectBreakerBlocks, detectUnicornSetups,
  detectJudasSwing, detectReversalCandle,
  calculatePDLevels, calculatePremiumDiscount,
  computeOpeningRange, calculateSLTP,
  // Confluence stacking, sweep reclaim, pullback decay
  computeConfluenceStacking, detectSweepReclaim, measurePullbackDecay,
  type ConfluenceStack, type SweepReclaim, type PullbackDecay,
  type FairValueGap,
  // Optimal style detection
  detectOptimalStyle,
} from "../_shared/smcAnalysis.ts";
import {
  classifySetupType, manageOpenPositions,
  type SetupClassification, type ManagementAction,
} from "../_shared/scannerManagement.ts";
import {
  detectSession as sharedDetectSession,
  toNYTime as sharedToNYTime,
  normalizeSessionFilter,
  isSessionEnabled,
  type SessionResult,
} from "../_shared/sessions.ts";

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
// ─── Default Factor Weights ─────────────────────────────────────────────────
const DEFAULT_FACTOR_WEIGHTS: Record<string, number> = {
  marketStructure: 2.5,  // Merged: BOS/CHoCH + Entry TF Trend Direction (was 1.5 + 1.5 separate)
  orderBlock: 2.0,
  fairValueGap: 2.0,
  premiumDiscountFib: 2.0,
  sessionQuality: 1.5,  // Collapsed from Kill Zone + Silver Bullet + Macro
  judasSwing: 0.75,  // NY midnight-anchored + liquidity sweep confirmation
  pdPwLevels: 1.0,
  reversalCandle: 1.5,  // Bumped: reversal candle is a primary ICT entry trigger
  liquiditySweep: 1.5,  // Recency filter + rejection confirmation
  displacement: 1.0,
  breakerBlock: 1.0,
  unicornModel: 1.5,
  smtDivergence: 1.0,
  volumeProfile: 0.75,  // Reduced: synthetic TPO data, not real volume
  amdPhase: 1.0,
  currencyStrength: 1.5,
  // trendDirection removed — merged into marketStructure
  dailyBias: 1.0,  // Reduced: HTF alignment is valuable but shouldn't dominate
};
/** Resolve a factor's weight multiplier from config overrides. */
function resolveWeightScale(factorKey: string, config: any): number {
  const fw = config.factorWeights;
  if (!fw || fw[factorKey] === undefined || fw[factorKey] === null) return 1.0;
  const defaultW = DEFAULT_FACTOR_WEIGHTS[factorKey];
  if (!defaultW || defaultW === 0) return 1.0;
  return Math.max(0, fw[factorKey]) / defaultW;
}
/** Apply weight scaling to a factor's pts and display weight. */
function applyWeightScale(pts: number, factorKey: string, displayWeight: number, config: any): { pts: number; displayWeight: number } {
  const scale = resolveWeightScale(factorKey, config);
  if (scale === 1.0) return { pts, displayWeight };
  return {
    pts: Math.round(pts * scale * 1000) / 1000,
    displayWeight: Math.round(displayWeight * scale * 1000) / 1000,
  };
}
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

function getYahooInterval(entryTf: string): string {
  const map: Record<string, string> = {
    "1m": "1m", "5m": "5m", "15m": "15m", "15min": "15m",
    "30m": "30m", "1h": "1h", "4h": "1h", "1d": "1d", "1day": "1d",
  };
  return map[entryTf] || "15m";
}

function getYahooRange(entryTf: string): string {
  const map: Record<string, string> = {
    "1m": "1d", "5m": "5d", "15m": "5d", "15min": "5d",
    "30m": "5d", "1h": "1mo", "4h": "1mo",
  };
  return map[entryTf] || "5d";
}

// ─── Volume Profile (Time-at-Price / TPO) ────────────────────────────
interface VolumeProfileResult {
  poc: number;
  vah: number;
  val: number;
  nodes: Array<{ price: number; count: number; type: "HVN" | "LVN" | "normal" }>;
  totalBins: number;
}
function computeVolumeProfile(candles: Candle[], numBins = 50): VolumeProfileResult | null {
  if (candles.length < 20) return null;
  let overallHigh = -Infinity, overallLow = Infinity;
  for (const c of candles) {
    if (c.high > overallHigh) overallHigh = c.high;
    if (c.low < overallLow) overallLow = c.low;
  }
  const range = overallHigh - overallLow;
  if (range <= 0) return null;
  const binSize = range / numBins;
  const bins: number[] = new Array(numBins).fill(0);
  for (const c of candles) {
    const lowBin = Math.max(0, Math.floor((c.low - overallLow) / binSize));
    const highBin = Math.min(numBins - 1, Math.floor((c.high - overallLow) / binSize));
    for (let b = lowBin; b <= highBin; b++) {
      bins[b]++;
    }
  }
  let pocBin = 0, maxCount = 0;
  for (let i = 0; i < numBins; i++) {
    if (bins[i] > maxCount) { maxCount = bins[i]; pocBin = i; }
  }
  const poc = overallLow + (pocBin + 0.5) * binSize;
  const totalCount = bins.reduce((a, b) => a + b, 0);
  const targetCount = totalCount * 0.70;
  let vaLowBin = pocBin, vaHighBin = pocBin;
  let vaCount = bins[pocBin];
  while (vaCount < targetCount && (vaLowBin > 0 || vaHighBin < numBins - 1)) {
    const expandLow = vaLowBin > 0 ? bins[vaLowBin - 1] : -1;
    const expandHigh = vaHighBin < numBins - 1 ? bins[vaHighBin + 1] : -1;
    if (expandLow >= expandHigh && expandLow >= 0) { vaLowBin--; vaCount += bins[vaLowBin]; }
    else if (expandHigh >= 0) { vaHighBin++; vaCount += bins[vaHighBin]; }
    else break;
  }
  const val = overallLow + vaLowBin * binSize;
  const vah = overallLow + (vaHighBin + 1) * binSize;
  const avgCount = totalCount / numBins;
  const nodes = bins.map((count, i) => ({
    price: overallLow + (i + 0.5) * binSize,
    count,
    type: count > avgCount * 1.5 ? "HVN" as const
         : count < avgCount * 0.5 ? "LVN" as const
         : "normal" as const,
  }));
  return { poc, vah, val, nodes, totalBins: numBins };
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

function runFullConfluenceAnalysis(candles: Candle[], dailyCandles: Candle[] | null, config: any, hourlyCandles?: Candle[]) {
  // P1: structure lookback — limit candles fed into structure analysis (config-driven, default 50)
  const structureLookback = (typeof config.structureLookback === "number" && config.structureLookback > 0)
    ? config.structureLookback
    : 50;
  const structureCandles = candles.length > structureLookback ? candles.slice(-structureLookback) : candles;
  const structure = analyzeMarketStructure(structureCandles);
  const structureBreaks = [...structure.bos, ...structure.choch];
  // P1: OB lookback — pass config-driven recency window
  let orderBlocks = detectOrderBlocks(candles, structureBreaks, config.obLookbackCandles);
  const fvgs = detectFVGs(candles, structureBreaks);

  // FVG adjacency bonus: tag OBs that have an FVG within 5 candles
  // This doesn't filter them out, but boosts quality for Factor 2 detail
  for (const ob of orderBlocks) {
    const hasFVGNearby = fvgs.some(f => Math.abs(f.index - ob.index) <= 5);
    (ob as any).hasFVGAdjacency = hasFVGNearby;
  }
  // P1: liquidity pool min touches — pass config-driven threshold
  const liquidityPools = detectLiquidityPools(candles, 0.001, config.liquidityPoolMinTouches);
  const judasSwing = detectJudasSwing(candles);
  const reversalCandle = detectReversalCandle(candles);
  const pd = calculatePremiumDiscount(candles);
  const session = detectSession(config);
  const pdLevels = dailyCandles ? calculatePDLevels(dailyCandles) : null;

  const lastPrice = candles[candles.length - 1].close;
  let score = 0;
  const factors: ReasoningFactor[] = [];

  // ── Factor 1: Market Structure (merged BOS/CHoCH + Trend Direction) (max 2.5) ──
  // Now integrates: internal vs external BOS significance, derived S/R, and structure-to-fractal rate.
  {
    let pts = 0;
    let detail = "";
    if (config.enableStructureBreak !== false) {
      // Count close-based (strong) vs wick-only breaks
      const closeBasedChoch = structure.choch.filter((c: any) => c.closeBased);
      const closeBasedBos = structure.bos.filter((b: any) => b.closeBased);
      const sweepCount = structure.sweeps?.length || 0;

      // Internal vs External BOS counts (new)
      const sCounts = structure.structureCounts || { internalBOS: 0, externalBOS: 0, internalCHoCH: 0, externalCHoCH: 0 };
      const hasExternalCHoCH = sCounts.externalCHoCH > 0;
      const hasExternalBOS = sCounts.externalBOS > 0;

      // Base structure score (0-1.5) — now weighted by significance
      let structurePts = 0;
      if (closeBasedChoch.length > 0) {
        structurePts = hasExternalCHoCH ? 1.5 : 1.2;  // external CHoCH = full, internal = slightly less
        detail = `${closeBasedChoch.length} CHoCH (close-based${hasExternalCHoCH ? ", EXTERNAL — major reversal" : ", internal"}) — strong trend reversal`;
      } else if (structure.choch.length > 0) {
        structurePts = 1.0;
        detail = `${structure.choch.length} CHoCH (wick-based, no close confirmation) — possible reversal`;
      } else if (closeBasedBos.length > 0) {
        structurePts = hasExternalBOS ? 1.2 : 0.9;  // external BOS = stronger continuation
        detail = `${closeBasedBos.length} BOS (close-based${hasExternalBOS ? ", EXTERNAL — major continuation" : ", internal"}) — trend continuation confirmed`;
      } else if (structure.bos.length > 0) {
        structurePts = 0.5;
        detail = `${structure.bos.length} BOS (wick-based only) — weak continuation`;
      } else {
        detail = "No BOS or CHoCH detected";
      }

      // Structure-to-Fractal conversion rate bonus (new)
      // High rate = swings keep breaking = strong trend. Low rate = swings hold = range.
      const s2f = structure.structureToFractal;
      if (s2f && s2f.totalFractals >= 4) {
        if (s2f.overallRate > 0.6) {
          structurePts += 0.15;
          detail += ` | S2F rate ${(s2f.overallRate * 100).toFixed(0)}% — high conversion, strong trend`;
        } else if (s2f.overallRate < 0.2) {
          structurePts -= 0.1;
          detail += ` | S2F rate ${(s2f.overallRate * 100).toFixed(0)}% — low conversion, swings holding`;
        }
      }

      // Derived S/R proximity bonus (new)
      // If price is near an active (unbroken) BOS-derived S/R level, that's a high-quality reaction zone
      const derivedSR = structure.derivedSR;
      if (derivedSR && derivedSR.active.length > 0 && typeof currentPrice === "number") {
        const atr = calculateATR(candles);
        const nearActiveSR = derivedSR.active.find((sr: any) => Math.abs(currentPrice - sr.price) < atr * 0.5);
        if (nearActiveSR) {
          structurePts += 0.2;
          detail += ` | Near active BOS-derived ${nearActiveSR.type} at ${nearActiveSR.price.toFixed(5)}`;
        }
      }

      if (sweepCount > 0) {
        detail += ` | ${sweepCount} liquidity sweep${sweepCount > 1 ? "s" : ""} detected`;
      }

      // Internal/External summary
      if (sCounts.externalBOS > 0 || sCounts.externalCHoCH > 0) {
        detail += ` | Structure: ${sCounts.externalBOS} ext BOS, ${sCounts.externalCHoCH} ext CHoCH, ${sCounts.internalBOS} int BOS, ${sCounts.internalCHoCH} int CHoCH`;
      }

      pts = structurePts;

      // Trend alignment bonus/penalty (adds up to +1.0 or -0.5)
      if (structure.trend !== "ranging" && structurePts > 0) {
        pts += 1.0;
        detail += ` | Entry TF trend ${structure.trend} — aligned`;
      } else if (structure.trend === "ranging" && structurePts > 0) {
        pts += 0.25;
        detail += " | Ranging market — partial trend credit";
      }
      // Cap at 2.5
      pts = Math.min(2.5, pts);
    } else {
      detail = "BOS/CHoCH disabled";
    }
    { const s = applyWeightScale(pts, "marketStructure", 2.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Market Structure", present: pts > 0, weight: s.displayWeight, detail, group: "Market Structure" }); }
  }

  // Displacement detection (used by OB/FVG bonus + new factor below)
  const displacement = detectDisplacement(candles);
  tagDisplacementQuality(orderBlocks, fvgs, displacement.displacementCandles);

  // Breaker Blocks + Unicorn Setups (computed early, scored after direction)
  const breakerBlocks = config.useBreakerBlocks !== false ? detectBreakerBlocks(orderBlocks, candles, structureBreaks) : [];
  const unicornSetups = config.useUnicornModel !== false ? detectUnicornSetups(breakerBlocks, fvgs) : [];

  // ── Factor 2: Order Block (max 2.0) ──
  // OBs are quality-gated: displacement required for full score, FVG adjacency bonus.
  // Without displacement, OB scores at most 0.75 (reduced from 2.0).
  // FIX #8: mitigatedPercent now scales the score — fresh OBs score higher than exhausted ones.
  // FIX #9: hasFVGAdjacency now provides a concrete score boost, not just a display tag.
  {
    let pts = 0;
    let detail = "";
    if (config.enableOB !== false) {
      // Lifecycle-aware filtering: exclude broken OBs entirely
      const activeOBs = orderBlocks.filter(ob => ob.state !== "broken" && !ob.mitigated);
      const insideOB = activeOBs.find(ob => lastPrice >= ob.low && lastPrice <= ob.high);
      if (insideOB) {
        const tags: string[] = [];
        if (insideOB.hasDisplacement) {
          pts = 2.0;
          tags.push("displacement \u2713");
        } else {
          pts = 0.75;
          tags.push("no displacement \u2014 reduced score");
        }

        // Lifecycle state scoring
        const obState = insideOB.state || "fresh";
        const mitPct = insideOB.mitigatedPercent || 0;
        const testCount = insideOB.testedCount || 0;

        if (obState === "fresh" && mitPct <= 20) {
          tags.push(`fresh (${mitPct.toFixed(0)}% mitigated)`);
        } else if (obState === "tested" && mitPct <= 50) {
          // Tested-and-held OBs are STRONGER: price tested the zone edge but it held
          // Bonus scales with test count: +0.15 per test, max +0.45 (3 tests)
          const testBonus = Math.min(0.45, testCount * 0.15);
          pts += testBonus;
          tags.push(`tested ${testCount}x & held (+${testBonus.toFixed(2)}, ${mitPct.toFixed(0)}% mitigated)`);
        } else if (obState === "mitigated" || mitPct > 50) {
          // Mitigated OBs: scale down based on how deeply penetrated
          if (mitPct <= 60) {
            pts *= 0.7;
            tags.push(`mitigated (${mitPct.toFixed(0)}%, score \u00d70.7)`);
          } else if (mitPct <= 90) {
            pts *= 0.4;
            tags.push(`deeply mitigated (${mitPct.toFixed(0)}%, score \u00d70.4)`);
          } else {
            pts *= 0.15;
            tags.push(`nearly broken (${mitPct.toFixed(0)}%, score \u00d70.15)`);
          }
        }

        // FVG adjacency bonus
        if (insideOB.hasFVGAdjacency) {
          pts = Math.min(2.5, pts + 0.25);
          tags.push("FVG adjacent (+0.25)");
        }
        if (insideOB.hasVolumePivot) tags.push("volume pivot \u2713");
        detail = `Price inside ${insideOB.type} OB at ${insideOB.low.toFixed(5)}-${insideOB.high.toFixed(5)} [${tags.join(", ")}]`;
      } else if (activeOBs.length > 0) {
        const withDisp = activeOBs.filter(ob => ob.hasDisplacement).length;
        const withVol = activeOBs.filter(ob => ob.hasVolumePivot).length;
        const freshOBs = activeOBs.filter(ob => ob.state === "fresh").length;
        const testedOBs = activeOBs.filter(ob => ob.state === "tested").length;
        const brokenCount = orderBlocks.filter(ob => ob.state === "broken").length;
        pts = 0;
        detail = `${activeOBs.length} OBs nearby (${freshOBs} fresh, ${testedOBs} tested, ${withDisp} displaced${withVol > 0 ? `, ${withVol} vol pivot` : ""}${brokenCount > 0 ? `, ${brokenCount} broken/excluded` : ""}) \u2014 not at level`;
      }
    } else {
      detail = "Order Blocks disabled";
    }
    { const s = applyWeightScale(pts, "orderBlock", 2.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Order Block", present: pts > 0, weight: s.displayWeight, detail: detail || "No active order blocks", group: "Order Flow Zones" }); }
  }

  // ── Direction Determination (moved before Factors 3-4 so they can use actual direction) ──
  // Depends only on structure.trend and pd.currentZone, both computed before scoring.
  let direction: "long" | "short" | null = null;
  const hasRecentBOS = structure.bos.length > 0;
  const hasRecentCHoCH = structure.choch.length > 0;
  const strongTrend = hasRecentBOS && !hasRecentCHoCH; // BOS without CHoCH = strong continuation

  if (structure.trend === "bullish") {
    if (pd.currentZone !== "premium") {
      direction = "long"; // Normal: bullish trend + discount/equilibrium
    } else if (strongTrend) {
      direction = "long"; // Strong trend override: allow premium longs in strong uptrend
    }
  } else if (structure.trend === "bearish") {
    if (pd.currentZone !== "discount") {
      direction = "short"; // Normal: bearish trend + premium/equilibrium
    } else if (strongTrend) {
      direction = "short"; // Strong trend override: allow discount shorts in strong downtrend
    }
  } else if (structure.trend === "ranging") {
    if (pd.currentZone === "discount") direction = "long";
    else if (pd.currentZone === "premium") direction = "short";
  }

  // ── Factor 3: Fair Value Gap (max 2.0) ──
  // Displacement is scored ONLY via Factor 10 to avoid double-counting.
  // ICT: Consequent Encroachment (CE) = 50% of FVG is a key entry level.
  {
    let pts = 0;
    let detail = "";
    if (config.enableFVG !== false) {
      // P1: pip-size lookup for FVG min-size filter (default 0.0001 if symbol unknown)
      const _sym = (config as any)._currentSymbol as string | undefined;
      const _spec = _sym ? SPECS[_sym] : undefined;
      const _pipSize = _spec?.pipSize ?? 0.0001;
      const _minPips = typeof config.fvgMinSizePips === "number" ? config.fvgMinSizePips : 0;
      const _onlyUnfilled = config.fvgOnlyUnfilled !== false;

      // P1: filter FVGs by config — lifecycle-aware: exclude filled FVGs entirely
      const activeFVGs = fvgs.filter(f => {
        if (f.state === "filled") return false; // Lifecycle: fully filled = dead
        if (_onlyUnfilled && f.mitigated) return false;
        if (_minPips > 0) {
          const sizePips = (f.high - f.low) / _pipSize;
          if (sizePips < _minPips) return false;
        }
        return true;
      });
      // Directional context: prefer FVGs aligned with trade direction (now available)
      // Bullish FVG (gap up) = support for longs; Bearish FVG (gap down) = resistance for shorts
      const trendHint = direction === "long" ? "bullish" : direction === "short" ? "bearish" : null;
      // Prefer directionally-aligned FVGs, but fall back to any FVG
      const alignedFVGs = trendHint ? activeFVGs.filter(f => f.type === trendHint) : activeFVGs;
      const fvgPool = alignedFVGs.length > 0 ? alignedFVGs : activeFVGs;
      const insideFVG = fvgPool.find(f => lastPrice >= f.low && lastPrice <= f.high);
      if (insideFVG) {
        const ce = (insideFVG.high + insideFVG.low) / 2; // Consequent Encroachment
        const fvgRange = insideFVG.high - insideFVG.low;
        const distFromCE = Math.abs(lastPrice - ce);
        const nearCE = fvgRange > 0 && (distFromCE / fvgRange) <= 0.15; // within 15% of CE
        const isAligned = trendHint ? insideFVG.type === trendHint : true;
        if (nearCE) {
          pts = isAligned ? 2.0 : 1.0; // Counter-directional FVG at CE gets half score
          detail = `Price at CE (${ce.toFixed(5)}) of ${insideFVG.type} FVG ${insideFVG.low.toFixed(5)}-${insideFVG.high.toFixed(5)}${isAligned ? " — optimal entry" : " — counter-directional, reduced"}`;
        } else {
          pts = isAligned ? 1.5 : 0.75;
          detail = `Price inside ${insideFVG.type} FVG at ${insideFVG.low.toFixed(5)}-${insideFVG.high.toFixed(5)} (CE: ${ce.toFixed(5)})${isAligned ? "" : " — counter-directional"}`;
        }
        // Quality scaling: scale base pts by FVG quality (0-8, max 8)
        const fvgQuality = insideFVG.quality ?? 4; // default 4 (mid-range) for backward compat
        const MAX_FVG_QUALITY = 8;
        const qualityMultiplier = 0.4 + 0.6 * (fvgQuality / MAX_FVG_QUALITY); // range: 0.4 – 1.0
        pts *= qualityMultiplier;
        detail += ` [Q:${fvgQuality.toFixed(1)}/${MAX_FVG_QUALITY}]`;

        // ── Lifecycle state scoring ──
        const fvgState = insideFVG.state || "open";
        const fillPct = insideFVG.fillPercent || 0;
        const respectCount = insideFVG.respectedCount || 0;

        if (fvgState === "open" && fillPct === 0) {
          detail += " [pristine gap]";
        } else if (fvgState === "respected") {
          // Respected FVGs get a bonus — they've proven themselves as S/R
          const respectBonus = Math.min(0.4, respectCount * 0.2);
          pts += respectBonus;
          detail += ` [respected ${respectCount}x, +${respectBonus.toFixed(2)}]`;
        } else if (fvgState === "partially_filled") {
          // Partially filled: scale down based on how much is filled
          if (fillPct <= 30) {
            detail += ` [${fillPct.toFixed(0)}% filled — still viable]`;
          } else if (fillPct <= 60) {
            pts *= 0.75;
            detail += ` [${fillPct.toFixed(0)}% filled, score \u00d70.75]`;
          } else if (fillPct <= 85) {
            pts *= 0.45;
            detail += ` [${fillPct.toFixed(0)}% filled, score \u00d70.45]`;
          } else {
            pts *= 0.2;
            detail += ` [${fillPct.toFixed(0)}% filled — nearly dead, score \u00d70.2]`;
          }
        }

        // Recency bonus: FVGs closer to current price action are more relevant
        const recencyIdx = insideFVG.index || 0;
        const isRecent = recencyIdx >= candles.length - 15;
        if (!isRecent && pts > 0.5) {
          pts *= 0.75; // Decay older FVGs
          detail += " [older FVG, reduced]";
        }
        if ((insideFVG as any).hasDisplacement) {
          detail += " [displacement-created, scored via Factor 10]";
        }
      } else if (activeFVGs.length > 0) {
        // FVGs exist but price not inside any — no score (ICT: entry requires price AT the level)
        const openFVGs = activeFVGs.filter(f => f.state === "open").length;
        const respectedFVGs = activeFVGs.filter(f => f.state === "respected").length;
        const partialFVGs = activeFVGs.filter(f => f.state === "partially_filled").length;
        const filledCount = fvgs.filter(f => f.state === "filled").length;
        pts = 0;
        detail = `${activeFVGs.length} qualifying FVGs (${openFVGs} open, ${respectedFVGs} respected, ${partialFVGs} partial${filledCount > 0 ? `, ${filledCount} filled/excluded` : ""}${_minPips > 0 ? `, \u2265${_minPips} pips` : ""}) \u2014 not at level`;
      }
    } else {
      detail = "FVGs disabled";
    }
    { const s = applyWeightScale(pts, "fairValueGap", 2.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Fair Value Gap", present: pts > 0, weight: s.displayWeight, detail: detail || "No active FVGs", group: "Order Flow Zones" }); }
  }

  // ── Factor 4: Premium/Discount & Fibonacci (max 2.5, group-capped) ──
  // Merged: P/D zone + Fibonacci retracement levels + PD/PW levels.
  // Uses the same swing high/low for both P/D and Fib calculations.
  {
    let pts = 0;
    const fibPercent = pd.zonePercent; // 0% = swing low, 100% = swing high
    let detail = `Price at ${fibPercent.toFixed(1)}% of swing range — ${pd.currentZone} zone`;

    // Fibonacci-aware scoring (direction-dependent):
    // For LONGS: want price in discount (low fib %). OTE sweet spot = 61.8-78.6% retracement from high = 21.4-38.2% of range.
    // For SHORTS: want price in premium (high fib %). OTE sweet spot = 61.8-78.6% retracement from low = 61.8-78.6% of range.
    // Note: zonePercent is measured from swing low, so:
    //   - For longs: OTE = price at 21.4-38.2% (deep discount, 61.8-78.6% retracement)
    //   - For shorts: OTE = price at 61.8-78.6% (deep premium, 61.8-78.6% retracement)

    // Use actual direction (now determined before Factor 3)
    const fibDirection = direction;

    if (fibDirection === "long") {
      // Retracement from swing high: retrace% = 100 - fibPercent
      const retrace = 100 - fibPercent;
      if (retrace >= 70 && retrace <= 72) {
        // 70.5% sweet spot (ICT optimal)
        pts = 2.0;
        detail += ` | Fib 70.5% sweet spot (retrace ${retrace.toFixed(1)}%) — OPTIMAL ENTRY`;
      } else if (retrace >= 61.8 && retrace <= 78.6) {
        // OTE zone
        pts = 1.5;
        detail += ` | Fib OTE zone (${retrace.toFixed(1)}% retracement)`;
      } else if (fibPercent < 45) {
        // In discount but not OTE
        pts = 1.0;
        detail += ` | Discount zone (${retrace.toFixed(1)}% retracement)`;
      } else if (retrace >= 38.2 && retrace < 61.8) {
        // Shallow retracement
        pts = 0.5;
        detail += ` | Shallow retracement (${retrace.toFixed(1)}%)`;
      } else if (fibPercent >= 50) {
        // Buying in premium — no points
        detail += ` | Buying in premium — unfavorable`;
      }
    } else if (fibDirection === "short") {
      // For shorts, fibPercent IS the retracement from swing low
      const retrace = fibPercent;
      if (retrace >= 70 && retrace <= 72) {
        pts = 2.0;
        detail += ` | Fib 70.5% sweet spot (retrace ${retrace.toFixed(1)}%) — OPTIMAL ENTRY`;
      } else if (retrace >= 61.8 && retrace <= 78.6) {
        pts = 1.5;
        detail += ` | Fib OTE zone (${retrace.toFixed(1)}% retracement)`;
      } else if (fibPercent > 55) {
        pts = 1.0;
        detail += ` | Premium zone (${retrace.toFixed(1)}% retracement)`;
      } else if (retrace >= 38.2 && retrace < 61.8) {
        pts = 0.5;
        detail += ` | Shallow retracement (${retrace.toFixed(1)}%)`;
      } else if (fibPercent <= 50) {
        detail += ` | Selling in discount — unfavorable`;
      }
    } else {
      // Ranging — no clear direction from structure, just report zone
      if (pd.oteZone) {
        pts = 0.5;
        detail += " | OTE zone active (ranging — no directional bias)";
      }
    }

    { const s = applyWeightScale(pts, "premiumDiscountFib", 2.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Premium/Discount & Fib", present: pts > 0, weight: s.displayWeight, detail, group: "Premium/Discount & Fib" }); }
  }

  // ── Factor 5: Session Quality (max 1.5) ──
  // Collapsed from Kill Zone + Silver Bullet + Macro into a single tiered factor.
  // Tier 1 (1.5): SB + KZ + Macro | Tier 2 (1.25): SB + KZ | Tier 3 (1.0): KZ + Macro
  // Tier 4 (0.75): KZ only | Tier 5 (0.5): Macro only | Tier 6 (0.25): active session | Tier 7 (0): nothing
  const silverBullet = detectSilverBullet();
  const macroWindow = detectMacroWindow();
  {
    const inKZ = session.isKillZone;
    const inSB = silverBullet.active && config.useSilverBullet !== false;
    const inMacro = macroWindow.active && config.useMacroWindows !== false;
    let pts = 0;
    let tier = "";
    let detail = "";
    if (inKZ && inSB && inMacro) {
      pts = 1.5; tier = "Tier 1 — Perfect";
      detail = `${session.name} Kill Zone + ${silverBullet.window} + ${macroWindow.window} — all timing windows aligned`;
    } else if (inKZ && inSB) {
      pts = 1.25; tier = "Tier 2 — Excellent";
      detail = `${session.name} Kill Zone + ${silverBullet.window} — strong timing confluence`;
    } else if (inKZ && inMacro) {
      pts = 1.0; tier = "Tier 3 — Good";
      detail = `${session.name} Kill Zone + ${macroWindow.window} — good timing overlap`;
    } else if (inKZ) {
      pts = 0.75; tier = "Tier 4 — Acceptable";
      detail = `${session.name} Kill Zone — standard high-probability window`;
    } else if (inMacro) {
      pts = 0.5; tier = "Tier 5 — Marginal";
      detail = `${macroWindow.window} active (${macroWindow.minutesRemaining}min left) — macro reprice window only`;
    } else if (session.name && session.name !== "Off-Hours") {
      pts = 0.25; tier = "Tier 6 — Low";
      detail = `${session.name} session active — no special timing window`;
    } else {
      pts = 0; tier = "Tier 7 — None";
      detail = "Outside active trading sessions — no timing edge";
    }
    { const s = applyWeightScale(pts, "sessionQuality", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Session Quality", present: pts > 0, weight: s.displayWeight, detail: `[${tier}] ${detail}`, group: "Timing" }); }
  }

  // ── Factor 6: Judas Swing (max 0.75) ──
  // ICT: Judas Swing is a manipulation move that sweeps liquidity before the real move.
  // Improved: Now anchored to actual NY midnight open. Requires liquidity sweep for full score.
  // FIX #4: Now uses judasSwing.type to check directional alignment with trade direction.
  {
    let pts = 0;
    let detail = judasSwing.description;
    if (judasSwing.detected && judasSwing.confirmed) {
      // Check if a liquidity sweep also fired — Judas + sweep = high-quality manipulation signal
      const hasSweep = liquidityPools.some(lp => lp.swept && lp.strength >= 2);
      if (session.isKillZone && hasSweep) {
        pts = 0.75;
        detail += " — kill zone + liquidity sweep (high-quality manipulation)";
      } else if (session.isKillZone) {
        pts = 0.5;
        detail += " — during kill zone (confirmed)";
      } else if (hasSweep) {
        pts = 0.4;
        detail += " — with liquidity sweep but outside kill zone";
      } else {
        pts = 0.25;
        detail += " — outside kill zone, no sweep (lower probability)";
      }
      // ── Direction alignment check (FIX #4) ──
      // A bullish Judas Swing = fake move DOWN then real move UP (supports long entries)
      // A bearish Judas Swing = fake move UP then real move DOWN (supports short entries)
      if (direction && judasSwing.type) {
        const jsAligned = (direction === "long" && judasSwing.type === "bullish")
          || (direction === "short" && judasSwing.type === "bearish");
        if (jsAligned) {
          pts = Math.min(0.75, pts + 0.15);
          detail += ` | ${judasSwing.type} JS aligned with ${direction} ✓`;
        } else {
          // Counter-directional Judas Swing — the manipulation is AGAINST our trade
          pts = Math.max(0, pts * 0.5);
          detail += ` | ${judasSwing.type} JS COUNTER to ${direction} (reduced)`;
        }
      }
    } else if (judasSwing.detected) {
      pts = 0.1;
      detail += " (unconfirmed)";
    }
    { const s = applyWeightScale(pts, "judasSwing", 0.75, config); pts = s.pts; score += pts;
    factors.push({ name: "Judas Swing", present: pts > 0, weight: s.displayWeight, detail, group: "Price Action" }); }
  }

  // ── Factor 7: PD/PW Levels + Opens (max 1.5) ──
  // ICT: PD/PW levels are primary draw-on-liquidity targets.
  // Now scores ALL 11 levels: PDH, PDL, PDO, PDC, PWH, PWL, PWO, PWC, DO, WO, MO.
  // Also computes bias alignment from current-period opens.
  {
    let pts = 0;
    let detail = "No PD/PW levels";
    let biasAlignmentDetail = "";
    if (pdLevels) {
      const threshold = lastPrice * 0.002;
      // All 11 key levels, tiered by significance
      const allLevels = [
        // Tier A: Weekly H/L and Monthly Open (highest significance)
        { name: "PWH", price: pdLevels.pwh, tier: "A" },
        { name: "PWL", price: pdLevels.pwl, tier: "A" },
        { name: "MO",  price: pdLevels.monthlyOpen, tier: "A" },
        // Tier B: Daily H/L, Weekly Open, Weekly Close
        { name: "PDH", price: pdLevels.pdh, tier: "B" },
        { name: "PDL", price: pdLevels.pdl, tier: "B" },
        { name: "WO",  price: pdLevels.weeklyOpen, tier: "B" },
        { name: "PWC", price: pdLevels.pwc, tier: "B" },
        // Tier C: Daily Open, Daily Close, Previous Week Open, Previous Day Open
        { name: "DO",  price: pdLevels.dailyOpen, tier: "C" },
        { name: "PDC", price: pdLevels.pdc, tier: "C" },
        { name: "PDO", price: pdLevels.pdo, tier: "C" },
        { name: "PWO", price: pdLevels.pwo, tier: "C" },
      ];
      const nearLevels = allLevels.filter(l => Math.abs(lastPrice - l.price) <= threshold);
      if (nearLevels.length > 0) {
        const hasA = nearLevels.some(l => l.tier === "A");
        const hasB = nearLevels.some(l => l.tier === "B");
        // Tier A = 1.0, Tier B = 0.75, Tier C = 0.5, multiple tiers = bonus
        if (hasA) pts = 1.0;
        else if (hasB) pts = 0.75;
        else pts = 0.5;
        // Multiple level confluence bonus (price near 2+ levels = stronger)
        if (nearLevels.length >= 3) pts = Math.min(1.5, pts + 0.5);
        else if (nearLevels.length >= 2) pts = Math.min(1.5, pts + 0.25);
        detail = `Price near ${nearLevels.map(l => l.name).join(", ")} (${nearLevels[0].price.toFixed(5)})${hasA ? " — high-significance level" : ""}`;
      } else {
        detail = `PDH=${pdLevels.pdh.toFixed(5)} PDL=${pdLevels.pdl.toFixed(5)} PWH=${pdLevels.pwh.toFixed(5)} PWL=${pdLevels.pwl.toFixed(5)} DO=${pdLevels.dailyOpen.toFixed(5)} WO=${pdLevels.weeklyOpen.toFixed(5)} MO=${pdLevels.monthlyOpen.toFixed(5)}`;
      }

      // ── Bias Alignment from Opens ──
      // Price above open = bullish bias for that timeframe, below = bearish.
      // When all 3 opens agree with trade direction, strong confirmation.
      if (direction) {
        const doBias = lastPrice > pdLevels.dailyOpen ? "bullish" : "bearish";
        const woBias = lastPrice > pdLevels.weeklyOpen ? "bullish" : "bearish";
        const moBias = lastPrice > pdLevels.monthlyOpen ? "bullish" : "bearish";
        const tradeBias = direction === "long" ? "bullish" : "bearish";
        const doAlign = doBias === tradeBias;
        const woAlign = woBias === tradeBias;
        const moAlign = moBias === tradeBias;
        const alignCount = [doAlign, woAlign, moAlign].filter(Boolean).length;
        if (alignCount === 3) {
          // All 3 opens agree with direction — strong bias confirmation
          pts = Math.min(1.5, pts + 0.5);
          biasAlignmentDetail = ` | Bias: DO/WO/MO all ${tradeBias} ✓✓✓ (strong)`;
        } else if (alignCount === 2) {
          pts = Math.min(1.5, pts + 0.25);
          biasAlignmentDetail = ` | Bias: ${doAlign ? "DO✓" : "DO✗"} ${woAlign ? "WO✓" : "WO✗"} ${moAlign ? "MO✓" : "MO✗"} (2/3 aligned)`;
        } else if (alignCount === 1) {
          // Only 1 open agrees — mild headwind
          biasAlignmentDetail = ` | Bias: ${doAlign ? "DO✓" : "DO✗"} ${woAlign ? "WO✓" : "WO✗"} ${moAlign ? "MO✓" : "MO✗"} (1/3 — headwind)`;
        } else {
          // All 3 opens disagree — significant headwind, reduce score
          pts = Math.max(0, pts - 0.25);
          biasAlignmentDetail = ` | Bias: DO/WO/MO all against ${tradeBias} ✗✗✗ (strong headwind, score reduced)`;
        }
      }
      detail += biasAlignmentDetail;
    }
    { const s = applyWeightScale(pts, "pdPwLevels", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "PD/PW Levels", present: pts > 0, weight: s.displayWeight, detail, group: "Premium/Discount & Fib" }); }
  }

  // ── Factor 8: Reversal Candle (max 1.5) ──
  // ICT: reversal candles are a PRIMARY entry trigger — the actual "pull the trigger" signal.
  // Bumped from 0.5 to 1.5 to match ICT importance.
  {
    let pts = 0;
    let detail = "No reversal pattern";
    if (reversalCandle.detected) {
      const lastC = candles[candles.length - 1];
      const lastMid = (lastC.high + lastC.low) / 2;
      // Check if reversal formed at an OB
      const atOB = orderBlocks.some(ob => !ob.mitigated && lastC.low <= ob.high && lastC.high >= ob.low);
      // Check if reversal formed at an FVG
      const atFVG = fvgs.some(f => !f.mitigated && lastC.low <= f.high && lastC.high >= f.low);
      // Check if reversal formed at a PD/PW level
      const atPDPW = pdLevels ? [
        pdLevels.pdh, pdLevels.pdl, pdLevels.pwh, pdLevels.pwl,
      ].some(lvl => Math.abs(lastMid - lvl) / lastMid <= 0.002) : false;

      const atKeyLevel = atOB || atFVG || atPDPW;
      // Check for displacement on the reversal candle
      const hasDisp = displacement.isDisplacement;
      if (atKeyLevel && hasDisp) {
        pts = 1.5;
        const levels: string[] = [];
        if (atOB) levels.push("OB");
        if (atFVG) levels.push("FVG");
        if (atPDPW) levels.push("PD/PW level");
        detail = `${reversalCandle.type} reversal + displacement at key level (${levels.join(", ")}) — high-conviction entry`;
      } else if (atKeyLevel) {
        pts = 1.0;
        const levels: string[] = [];
        if (atOB) levels.push("OB");
        if (atFVG) levels.push("FVG");
        if (atPDPW) levels.push("PD/PW level");
        detail = `${reversalCandle.type} reversal at key level (${levels.join(", ")}) — no displacement`;
      } else if (hasDisp) {
        pts = 0.5;
        detail = `${reversalCandle.type} reversal with displacement but not at a key level`;
      } else {
        pts = 0.25;
        detail = `${reversalCandle.type} reversal candle detected but not at a key level, no displacement`;
      }
    }
    { const s = applyWeightScale(pts, "reversalCandle", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Reversal Candle", present: pts > 0, weight: s.displayWeight, detail, group: "Price Action" }); }
  }

  // ── Factor 9: Liquidity Sweep (max 1.5) ──
  // ICT: Liquidity sweeps are a cornerstone entry trigger. Weight increased per audit.
  // Now uses rejection confirmation and recency for higher-quality signals.
  {
    let pts = 0;
    let detail = "";
    if (config.enableLiquiditySweep !== false) {
      // Prefer swept pools with rejection confirmation (wick through + close back)
      const sweptPools = liquidityPools.filter(lp => lp.swept && lp.strength >= 2);
      // Sort: rejection-confirmed first, then by strength, then by recency
      const sorted = sweptPools.sort((a, b) => {
        if (a.rejectionConfirmed !== b.rejectionConfirmed) return a.rejectionConfirmed ? -1 : 1;
        if (b.strength !== a.strength) return b.strength - a.strength;
        return (b.sweptAtIndex || 0) - (a.sweptAtIndex || 0); // more recent first
      });
      const best = sorted[0];
      if (best) {
        // Recency check: sweep should be within last 20 candles for full score
        const isRecent = best.sweptAtIndex != null && best.sweptAtIndex >= candles.length - 20;
        if (best.rejectionConfirmed) {
          // Sweep + rejection = high-quality signal
          pts = isRecent ? 1.5 : 1.0;
          detail = `${best.type} liquidity swept + rejected at ${best.price.toFixed(5)} (${best.strength} touches)${isRecent ? " — recent" : " — older sweep"}${best.strength >= 4 ? " — strong pool" : ""}`;
        } else {
          // Sweep without rejection = moderate signal (could be a real break, not a sweep)
          pts = isRecent ? 0.75 : 0.5;
          detail = `${best.type} liquidity swept at ${best.price.toFixed(5)} (${best.strength} touches) — no rejection candle${isRecent ? "" : " (older sweep)"}${best.strength >= 4 ? " — strong pool" : ""}`;
        }
      } else {
        detail = "No recent liquidity sweep";
      }
    } else {
      detail = "Liquidity Sweeps disabled";
    }
    { const s = applyWeightScale(pts, "liquiditySweep", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Liquidity Sweep", present: pts > 0, weight: s.displayWeight, detail, group: "Price Action" }); }
  }

  // ── Opening Range Enhancements ──
  const or = config.openingRange?.enabled && hourlyCandles
    ? computeOpeningRange(hourlyCandles, config.openingRange.candleCount || 24)
    : null;

  if (or && config.openingRange?.enabled) {
    // (a) OR Bias boost — modifies Factor 1
    if (config.openingRange.useBias && or.completed) {
      if (lastPrice > or.high) { score += 0.5; factors[0].detail += " | OR bias: bullish (above OR high)"; }
      else if (lastPrice < or.low) { score += 0.5; factors[0].detail += " | OR bias: bearish (below OR low)"; }
    }

    // (b) OR Judas Swing — enhances Factor 6
    if (config.openingRange.useJudasSwing && or.completed) {
      const recentCandles = candles.slice(-10);
      const sweptHigh = recentCandles.some(c => c.high > or.high);
      const sweptLow = recentCandles.some(c => c.low < or.low);
      if (sweptHigh && lastPrice < or.high) {
        score += 0.5;
        const f6 = factors.find(f => f.name === "Judas Swing");
        if (f6) { f6.present = true; f6.detail += " | OR high swept then reversed"; }
      }
      if (sweptLow && lastPrice > or.low) {
        score += 0.5;
        const f6 = factors.find(f => f.name === "Judas Swing");
        if (f6) { f6.present = true; f6.detail += " | OR low swept then reversed"; }
      }
    }

    // (c) OR Key Levels — enhances Factor 7
    if (config.openingRange.useKeyLevels && or.completed) {
      const threshold = lastPrice * 0.002;
      const orLevels = [
        { name: "OR High", price: or.high },
        { name: "OR Low", price: or.low },
        { name: "OR Mid", price: or.midpoint },
      ];
      const nearOR = orLevels.find(l => Math.abs(lastPrice - l.price) <= threshold);
      if (nearOR) {
        score += 0.5;
        const f7 = factors.find(f => f.name === "PD/PW Levels");
        if (f7) { f7.present = true; f7.detail += ` | Near ${nearOR.name} (${nearOR.price.toFixed(5)})`; }
      }
    }

    // (d) OR Premium/Discount override — modifies Factor 4
    if (config.openingRange.usePremiumDiscount && or.completed) {
      const orRange = or.high - or.low;
      if (orRange > 0) {
        const orZonePercent = ((lastPrice - or.low) / orRange) * 100;
        const orZone = orZonePercent > 55 ? "premium" : orZonePercent < 45 ? "discount" : "equilibrium";
        const f4 = factors.find(f => f.name === "Premium/Discount");
        if (f4) { f4.detail += ` | OR zone: ${orZone} (${orZonePercent.toFixed(1)}%)`; }
      }
    }
  }

  // Direction was already determined above (before Factor 3) so all factors can use it.

  // Factor 19 (Trend Direction) has been merged into Factor 1 (Market Structure).
  // The entry-TF trend alignment is now scored as part of the Market Structure factor.
  // Post-direction counter-trend penalty: if direction is now known and opposes structure.trend,
  // apply a penalty to the Market Structure factor.
  {
    const msFactor = factors.find(f => f.name === "Market Structure");
    if (msFactor && direction && structure.trend !== "ranging") {
      const trendAligned = (direction === "long" && structure.trend === "bullish")
        || (direction === "short" && structure.trend === "bearish");
      if (!trendAligned && msFactor.present) {
        // Counter-trend penalty: reduce Market Structure score
        const penalty = 0.5;
        score -= penalty;
        msFactor.weight = Math.max(0, msFactor.weight - penalty);
        msFactor.detail += ` | Counter-trend penalty: ${direction} against ${structure.trend} (-${penalty})`;
      }
    }
  }

  // ── Factor 10: Displacement (max 1.0) ──
  // ICT: True displacement should create an FVG (institutional footprint).
  {
    let pts = 0;
    let detail = "No displacement candle in last 5 bars";
    if (config.useDisplacement !== false) {
      if (displacement.isDisplacement && direction && displacement.lastDirection) {
        const aligned = (direction === "long" && displacement.lastDirection === "bullish")
          || (direction === "short" && displacement.lastDirection === "bearish");
        if (aligned) {
          const last = displacement.displacementCandles[displacement.displacementCandles.length - 1];
          // Check if displacement candle created an FVG (within 1 candle of displacement)
          const createdFVG = fvgs.some(f => Math.abs(f.index - last.index) <= 1);
          if (createdFVG) {
            pts = 1.0;
            detail = `Displacement + FVG created — strong institutional footprint (${last.rangeMultiple.toFixed(1)}× avg range, body ${(last.bodyRatio * 100).toFixed(0)}%)`;
          } else {
            pts = 0.5;
            detail = `Displacement aligned but no FVG created (${last.rangeMultiple.toFixed(1)}× avg range, body ${(last.bodyRatio * 100).toFixed(0)}%)`;
          }
        } else {
          detail = `Displacement detected but opposite to signal direction (${displacement.lastDirection})`;
        }
      } else if (displacement.isDisplacement) {
        detail = `Displacement detected (${displacement.lastDirection}) but no signal direction`;
      }
    } else {
      detail = "Displacement scoring disabled";
    }
    { const s = applyWeightScale(pts, "displacement", 1.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Displacement", present: pts > 0, weight: s.displayWeight, detail, group: "Price Action" }); }
  }

  // ── Factor 11: Breaker Block (max 1.0) ──
  // Improved: ATR-based proximity instead of fixed 1% distance.
  {
    let pts = 0;
    let detail = "No active breaker block aligned with signal";
    if (config.useBreakerBlocks !== false && direction && breakerBlocks.length > 0) {
      const wantType = direction === "long" ? "bullish_breaker" : "bearish_breaker";
      // Use ATR for proximity — 2× ATR is a reasonable "near" threshold
      const breakerATR = calculateATR(candles, 14);
      const atrThreshold = breakerATR * 2;
      // Find the closest aligned breaker
      // Lifecycle-aware: exclude broken breakers from scoring
      const alignedBreakers = breakerBlocks.filter(b => b.type === wantType && b.state !== "broken");
      const brokenCount = breakerBlocks.filter(b => b.type === wantType && b.state === "broken").length;
      let bestBreaker: typeof alignedBreakers[0] | null = null;
      let bestDist = Infinity;
      for (const b of alignedBreakers) {
        const mid = (b.high + b.low) / 2;
        const dist = Math.abs(lastPrice - mid);
        if (dist < bestDist) { bestDist = dist; bestBreaker = b; }
      }
      if (bestBreaker) {
        const isInside = lastPrice >= bestBreaker.low && lastPrice <= bestBreaker.high;
        const subtypeLabel = bestBreaker.subtype === "breaker" ? "BB" : "MB";
        const bState = bestBreaker.state || "active";
        const bTests = bestBreaker.testedCount || 0;
        if (isInside) {
          pts = 1.0;
          // Lifecycle bonus: respected breakers are stronger
          if (bState === "respected" && bTests > 0) {
            const respectBonus = Math.min(0.3, bTests * 0.15);
            pts += respectBonus;
            detail = `Price inside ${bestBreaker.type.replace("_", " ")} (${subtypeLabel}, respected ${bTests}x +${respectBonus.toFixed(2)}) at ${bestBreaker.low.toFixed(5)}-${bestBreaker.high.toFixed(5)}`;
          } else {
            detail = `Price inside ${bestBreaker.type.replace("_", " ")} (${subtypeLabel}, ${bState}) at ${bestBreaker.low.toFixed(5)}-${bestBreaker.high.toFixed(5)}`;
          }
        } else if (bestDist <= atrThreshold) {
          pts = 0.5;
          detail = `Price within ${(bestDist / breakerATR).toFixed(1)}\u00d7 ATR of ${bestBreaker.type.replace("_", " ")} (${subtypeLabel}, ${bState}) at ${bestBreaker.low.toFixed(5)}-${bestBreaker.high.toFixed(5)}`;
        } else {
          detail = `${bestBreaker.type.replace("_", " ")} (${subtypeLabel}, ${bState}) at ${bestBreaker.low.toFixed(5)}-${bestBreaker.high.toFixed(5)} but ${(bestDist / breakerATR).toFixed(1)}\u00d7 ATR away${brokenCount > 0 ? ` (${brokenCount} broken/excluded)` : ""}`;
        }
      }
    } else if (config.useBreakerBlocks === false) {
      detail = "Breaker Blocks disabled";
    }
    { const s = applyWeightScale(pts, "breakerBlock", 1.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Breaker Block", present: pts > 0, weight: s.displayWeight, detail, group: "Order Flow Zones" }); }
  }

  // ── Factor 12: Unicorn Model (max 1.5) ──
  {
    let pts = 0;
    let detail = "No unicorn (Breaker + FVG overlap) aligned with signal";
    if (config.useUnicornModel !== false && direction && unicornSetups.length > 0) {
      const wantType = direction === "long" ? "bullish_unicorn" : "bearish_unicorn";
      // Lifecycle-aware: only score active unicorns, invalidated ones get zero
      const activeUnicorns = unicornSetups.filter(u => u.state !== "invalidated");
      const invalidatedCount = unicornSetups.filter(u => u.state === "invalidated").length;
      const aligned = activeUnicorns.find(u => u.type === wantType
        && lastPrice >= u.overlapLow && lastPrice <= u.overlapHigh);
      if (aligned) {
        pts = 1.5;
        detail = `Unicorn: Breaker + FVG overlap at ${aligned.overlapLow.toFixed(5)}-${aligned.overlapHigh.toFixed(5)} [${aligned.state}]`;
      } else {
        const anyAligned = activeUnicorns.find(u => u.type === wantType);
        if (anyAligned) {
          detail = `Unicorn zone at ${anyAligned.overlapLow.toFixed(5)}-${anyAligned.overlapHigh.toFixed(5)} [${anyAligned.state}] but price outside${invalidatedCount > 0 ? ` (${invalidatedCount} invalidated/excluded)` : ""}`;
        } else if (invalidatedCount > 0) {
          detail = `${invalidatedCount} unicorn(s) found but all invalidated (${unicornSetups.filter(u => u.state === "invalidated").map(u => u.invalidationReason || "unknown").join(", ")})`;
        }
      }
    } else if (config.useUnicornModel === false) {
      detail = "Unicorn Model disabled";
    }
    { const s = applyWeightScale(pts, "unicornModel", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Unicorn Model", present: pts > 0, weight: s.displayWeight, detail, group: "Order Flow Zones" }); }
  }

  // ── Factors 13 & 14 (Silver Bullet + Macro) absorbed into Factor 5 Session Quality ──
  // silverBullet and macroWindow variables are declared at Factor 5 and remain available
  // for the return object and Power of 3 combo check.

  // ── Factor 15: SMT Divergence (max 1.0) ──
  // Reads precomputed SMT result injected by scan loop via config._smtResult.
  const smtResult: SMTResult | null = config._smtResult ?? null;
  {
    let pts = 0;
    let detail = smtResult ? smtResult.detail : "SMT not computed (no correlated pair fetched)";
    if (config.useSMT === false) {
      detail = "SMT Divergence disabled";
    } else if (smtResult && smtResult.detected && direction) {
      const aligned = (direction === "long" && smtResult.type === "bullish")
        || (direction === "short" && smtResult.type === "bearish");
      if (aligned) {
        pts = 1.0;
        detail = `SMT aligned: ${smtResult.detail}`;
      } else {
        detail = `SMT detected (${smtResult.type}) but opposite to signal direction`;
      }
    } else if (smtResult && smtResult.detected) {
      detail = `SMT (${smtResult.type}) detected but no signal direction yet`;
    }
    { const s = applyWeightScale(pts, "smtDivergence", 1.0, config); pts = s.pts; score += pts;
    factors.push({ name: "SMT Divergence", present: pts > 0, weight: s.displayWeight, detail, group: "Macro Confirmation" }); }
  }

  // ── Factor 16: Volume Profile (max 1.5) ──
  // Replaces VWAP. Uses Time-at-Price (TPO) histogram to identify POC, HVN, LVN.
  // Validates OBs and FVGs with price-time data.
  const volumeProfile = computeVolumeProfile(candles);
  if (config.useVolumeProfile !== false) {
    let pts = 0;
    let detail = "";
    if (!volumeProfile) {
      detail = "Volume Profile unavailable (insufficient candles)";
    } else {
      const { poc, vah, val, nodes } = volumeProfile;
      const pipSize = (SPECS[config._currentSymbol || "EUR/USD"] || SPECS["EUR/USD"]).pipSize;
      const distFromPOC = Math.abs(lastPrice - poc) / pipSize;
      const pocProximityPips = 20; // within 20 pips of POC

      // Find the node closest to current price
      let closestNode = nodes[0];
      let minDist = Infinity;
      for (const node of nodes) {
        const d = Math.abs(lastPrice - node.price);
        if (d < minDist) { minDist = d; closestNode = node; }
      }

      if (distFromPOC <= pocProximityPips && direction) {
        // Price at POC — institutional fair value level
        pts = 1.0;
        detail = `Price ${distFromPOC.toFixed(1)} pips from POC (${poc.toFixed(5)}) — institutional fair value`;
      } else if (closestNode.type === "HVN" && direction) {
        // Price at High Volume Node — institutional defense level
        pts = 0.75;
        detail = `Price at HVN (${closestNode.price.toFixed(5)}, ${closestNode.count} TPOs) — institutional defense level`;
      } else if (closestNode.type === "LVN" && direction) {
        // Price at Low Volume Node — fast-move zone (validates FVG)
        pts = 0.5;
        detail = `Price at LVN (${closestNode.price.toFixed(5)}) — thin liquidity zone (FVG validation)`;
      } else if (direction) {
        detail = `Price in normal volume zone (POC: ${poc.toFixed(5)}, VA: ${val.toFixed(5)}-${vah.toFixed(5)})`;
      } else {
        detail = `Volume Profile computed (POC: ${poc.toFixed(5)}) but no direction`;
      }

      // Cross-validation bonus: OB or FVG overlaps with HVN/LVN
      if (pts > 0) {
        const obAtHVN = closestNode.type === "HVN" && factors.some(f => f.name === "Order Block" && f.present);
        const fvgAtLVN = closestNode.type === "LVN" && factors.some(f => f.name === "Fair Value Gap" && f.present);
        if (obAtHVN) {
          pts += 0.5;
          detail += " + OB at HVN (cross-validated)";
        } else if (fvgAtLVN) {
          pts += 0.5;
          detail += " + FVG at LVN (cross-validated)";
        }
      }
      pts = Math.min(0.75, pts);
    }
    { const s = applyWeightScale(pts, "volumeProfile", 0.75, config); pts = s.pts; score += pts;
    factors.push({ name: "Volume Profile", present: pts > 0, weight: s.displayWeight, detail, group: "Volume Profile" }); }
  } else {
    factors.push({ name: "Volume Profile", present: false, weight: 0, detail: "Volume Profile disabled", group: "Volume Profile" });
  }

  // Retain VWAP calculation for backward compatibility (not scored)
  const _vwapSymbol = config._currentSymbol || "EUR/USD";
  const _vwapPipSize = (SPECS[_vwapSymbol] || SPECS["EUR/USD"]).pipSize;
  const vwap = calculateAnchoredVWAP(candles, _vwapPipSize);

  // ── Factor 17: AMD Phase (max 1.5; bias alignment + distribution + Asian range key levels) ──
  // FIX #7: Now uses asianHigh/asianLow as key levels — price near Asian range boundary = extra confluence.
  const amd = detectAMDPhase(candles);
  {
    let pts = 0;
    let detail = `AMD: ${amd.detail}`;
    if (config.useAMD === false) {
      detail = "AMD Phase disabled";
    } else if (direction && amd.bias) {
      const aligned = (direction === "long" && amd.bias === "bullish") || (direction === "short" && amd.bias === "bearish");
      if (aligned) {
        pts = 1.0;
        if (amd.phase === "distribution") {
          pts += 0.5;
          detail = `AMD distribution + ${amd.bias} bias aligned (Asian sweep ${amd.sweptSide})`;
        } else {
          detail = `AMD ${amd.phase} + ${amd.bias} bias aligned (Asian sweep ${amd.sweptSide})`;
        }
      } else {
        detail = `AMD ${amd.bias} bias opposite to signal direction (phase: ${amd.phase})`;
      }
    }
    // ── Asian range as key levels (FIX #7) ──
    // asianHigh and asianLow are primary liquidity targets during London/NY.
    // Price near these levels = potential manipulation zone.
    if (amd.asianHigh != null && amd.asianLow != null) {
      const asianRange = amd.asianHigh - amd.asianLow;
      const nearThreshold = asianRange * 0.15; // within 15% of the Asian range
      const nearAsianHigh = Math.abs(lastPrice - amd.asianHigh) <= nearThreshold;
      const nearAsianLow = Math.abs(lastPrice - amd.asianLow) <= nearThreshold;
      if (nearAsianHigh || nearAsianLow) {
        const whichLevel = nearAsianHigh ? `Asian High (${amd.asianHigh.toFixed(5)})` : `Asian Low (${amd.asianLow.toFixed(5)})`;
        detail += ` | Price near ${whichLevel} — key liquidity level`;
        // Boost if the Asian level aligns with trade direction
        // Near Asian High + short = selling at resistance (good)
        // Near Asian Low + long = buying at support (good)
        const asianAligned = (nearAsianHigh && direction === "short") || (nearAsianLow && direction === "long");
        if (asianAligned) {
          pts = Math.min(1.5, pts + 0.25);
          detail += " (directionally aligned)";
        }
      }
    }
    { const s = applyWeightScale(pts, "amdPhase", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "AMD Phase", present: pts > 0, weight: s.displayWeight, detail, group: "AMD / Power of 3" }); }
  }

  // ── Factor 18: Currency Strength / FOTSI (max 1.5, min -0.5) ──
  // Uses pre-computed FOTSI strengths from the scan cycle (module-scoped _fotsiResult).
  // Rewards trades aligned with macro currency flow; penalizes exhaustion trades.
  let _fotsiAlignment: any = null;
  {
    let pts = 0;
    let detail = "";
    const fotsi = config._fotsiResult as FOTSIResult | null;
    if (config.useFOTSI === false) {
      detail = "Currency Strength disabled";
    } else if (fotsi && direction) {
      const currencies = parsePairCurrencies(config._currentSymbol || "");
      if (currencies) {
        const [base, quote] = currencies;
        const dir = direction === "long" ? "BUY" : "SELL";
        const alignment = getCurrencyAlignment(base, quote, dir as "BUY" | "SELL", fotsi.strengths);
        _fotsiAlignment = alignment;
        pts = alignment.score;
        detail = `${alignment.label} (${base} ${alignment.baseTSI.toFixed(1)}, ${quote} ${alignment.quoteTSI.toFixed(1)}, spread ${alignment.spread.toFixed(1)})`;
      } else {
        detail = "Non-forex pair — currency strength N/A";
      }
    } else if (!fotsi) {
      detail = "FOTSI data unavailable this cycle";
    } else {
      detail = "No direction — currency strength check skipped";
    }
    { const s = applyWeightScale(pts, "currencyStrength", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Currency Strength", present: pts !== 0, weight: s.displayWeight, detail, group: "Macro Confirmation" }); }
  }

  // ── Factor 17: Daily Bias / HTF Trend (max 1.5) ──
  // Now fully activates htfStructure: trend, BOS/CHoCH recency, trend strength,
  // and daily swing points as key levels. Increased max from 1.0 to 1.5.
  if (config.useDailyBias !== false) {
    let pts = 0;
    let detail = "";
    if (dailyCandles && dailyCandles.length >= 20 && direction) {
      const dailyStructure = analyzeMarketStructure(dailyCandles);
      const dailyTrend = dailyStructure.trend;
      const dailyBOS = dailyStructure.bos;
      const dailyCHoCH = dailyStructure.choch;
      const dailySwings = dailyStructure.swingPoints;

      // ── Trend strength: BOS count without CHoCH = strong continuation ──
      const recentBOS = dailyBOS.filter(b => b.index >= dailyCandles.length - 20);
      const recentCHoCH = dailyCHoCH.filter(c => c.index >= dailyCandles.length - 20);
      const trendStrength = recentBOS.length - recentCHoCH.length; // positive = strong trend, negative = choppy

      // ── Last BOS/CHoCH recency ──
      const lastBOS = dailyBOS.length > 0 ? dailyBOS[dailyBOS.length - 1] : null;
      const lastCHoCH = dailyCHoCH.length > 0 ? dailyCHoCH[dailyCHoCH.length - 1] : null;
      const bosRecency = lastBOS ? dailyCandles.length - 1 - lastBOS.index : Infinity;
      const chochRecency = lastCHoCH ? dailyCandles.length - 1 - lastCHoCH.index : Infinity;

      if (dailyTrend !== "ranging") {
        const htfAligned = (direction === "long" && dailyTrend === "bullish")
          || (direction === "short" && dailyTrend === "bearish");
        if (htfAligned) {
          pts = 1.0;
          detail = `Daily ${dailyTrend} aligned with ${direction}`;
          // Trend strength bonus: strong trend (3+ BOS without CHoCH) = extra conviction
          if (trendStrength >= 3) {
            pts += 0.25;
            detail += ` — strong trend (${recentBOS.length} BOS, ${recentCHoCH.length} CHoCH)`;
          } else {
            detail += ` (${recentBOS.length} BOS, ${recentCHoCH.length} CHoCH)`;
          }
          // Recent BOS bonus: BOS within last 5 daily candles = fresh momentum
          if (bosRecency <= 5) {
            pts += 0.25;
            detail += ` + recent BOS (${bosRecency}d ago)`;
          }
        } else {
          pts = -0.5;
          detail = `Counter-HTF: ${direction} against daily ${dailyTrend} (penalty)`;
          // Recent CHoCH against us = extra danger
          if (chochRecency <= 5) {
            pts -= 0.25;
            detail += ` + recent CHoCH against direction (${chochRecency}d ago)`;
          }
        }
      } else {
        pts = 0.25;
        detail = `Daily ranging (${recentBOS.length} BOS, ${recentCHoCH.length} CHoCH)`;
        // If there's a very recent CHoCH, the range is fresh — could be a reversal
        if (chochRecency <= 3) {
          detail += ` — fresh CHoCH (${chochRecency}d ago, possible reversal)`;
        }
      }

      // ── Daily swing points as key levels ──
      // Check if current price is near a daily swing high/low (strong S/R)
      if (dailySwings.length >= 2) {
        const recentDailySwings = dailySwings.slice(-6);
        const pipSize = (SPECS[config._currentSymbol || "EUR/USD"] || SPECS["EUR/USD"]).pipSize;
        const threshold = pipSize * 30; // within 30 pips of a daily swing
        const nearDailySwing = recentDailySwings.find(s => Math.abs(lastPrice - s.price) <= threshold);
        if (nearDailySwing) {
          detail += ` | Near daily swing ${nearDailySwing.type} at ${nearDailySwing.price.toFixed(5)}`;
        }
      }

      pts = Math.min(1.5, Math.max(-0.75, pts)); // cap at 1.5, floor at -0.75
    } else if (!dailyCandles || dailyCandles.length < 20) {
      detail = "Daily candles unavailable — HTF bias skipped";
    } else {
      detail = "No direction determined — HTF bias skipped";
    }
    { const s = applyWeightScale(pts, "dailyBias", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Daily Bias", present: pts > 0, weight: s.displayWeight, detail, group: "Daily Bias" }); }
  } else {
    factors.push({ name: "Daily Bias", present: false, weight: 0, detail: "Daily Bias disabled", group: "Daily Bias" });
  }

  // ── Factor 19: Confluence Stacking (max 1.5) ──
  // Detects when FVG/OB boxes overlap with S/R levels AND Fib retracement levels.
  // Triple confluence (FVG/OB + S/R + Fib) = highest probability entry zone.
  let confluenceStacks: ConfluenceStack[] = [];
  {
    let pts = 0;
    let detail = "";
    confluenceStacks = computeConfluenceStacking(
      orderBlocks, fvgs, structure.swingPoints, candles, direction
    );
    if (confluenceStacks.length > 0) {
      const best = confluenceStacks[0]; // Already sorted by layerCount desc + alignment
      const priceInZone = lastPrice >= best.overlapZone[0] && lastPrice <= best.overlapZone[1];

      if (best.layerCount >= 3 && priceInZone) {
        // Triple+ confluence AND price is inside the zone — maximum score
        pts = 1.5;
        detail = `TRIPLE CONFLUENCE at price: ${best.label} [${best.overlapZone[0].toFixed(5)}-${best.overlapZone[1].toFixed(5)}]`;
        if (best.directionalAlignment === "aligned") detail += " — directionally aligned";
        else if (best.directionalAlignment === "counter") { pts *= 0.5; detail += " — counter-directional (reduced)"; }
      } else if (best.layerCount >= 3) {
        // Triple confluence but price not yet at the zone
        pts = 0.75;
        detail = `Triple confluence nearby: ${best.label} [${best.overlapZone[0].toFixed(5)}-${best.overlapZone[1].toFixed(5)}] — price not at level`;
      } else if (best.layerCount === 2 && priceInZone) {
        // Double confluence at price
        pts = 1.0;
        detail = `Double confluence at price: ${best.label} [${best.overlapZone[0].toFixed(5)}-${best.overlapZone[1].toFixed(5)}]`;
        if (best.directionalAlignment === "counter") { pts *= 0.5; detail += " — counter-directional (reduced)"; }
      } else if (best.layerCount === 2) {
        // Double confluence nearby
        pts = 0.5;
        detail = `Double confluence nearby: ${best.label} — price not at level`;
      }

      // Add summary of all stacks found
      if (confluenceStacks.length > 1) {
        detail += ` | ${confluenceStacks.length} total stacks found (best: ${best.layerCount} layers)`;
      }
    } else {
      detail = "No confluence stacking detected (FVG/OB zones don't overlap with S/R + Fib)";
    }
    { const s = applyWeightScale(pts, "confluenceStack", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Confluence Stack", present: pts > 0, weight: s.displayWeight, detail, group: "Order Flow Zones" }); }
  }

  // ── Factor 20: Sweep Reclaim Enhancement ──
  // Enhances existing sweep data with reclaim confirmation.
  // Sweep + reclaim = highest quality entry trigger (price grabs liquidity then reverses with conviction).
  let sweepReclaims: SweepReclaim[] = [];
  {
    // Build sweep data from structure.sweeps for detectSweepReclaim
    const structureSweeps = (structure.sweeps || []).map((s: any) => ({
      index: s.index,
      type: s.type as "bullish" | "bearish",
      price: s.price,
      datetime: s.datetime || "",
      sweptLevel: s.sweptLevel,
      wickDepth: s.wickDepth,
    }));
    sweepReclaims = detectSweepReclaim(candles, structureSweeps, fvgs);

    // Enhance Factor 9 (Liquidity Sweep) detail with reclaim info if available
    const sweepFactor = factors.find(f => f.name === "Liquidity Sweep");
    if (sweepFactor && sweepReclaims.length > 0) {
      const bestReclaim = sweepReclaims.find(sr => sr.reclaimed);
      if (bestReclaim) {
        const reclaimDetail = ` | SWEEP RECLAIM: ${bestReclaim.type} sweep at ${bestReclaim.sweptLevel.toFixed(5)} reclaimed (strength: ${(bestReclaim.reclaimStrength * 100).toFixed(0)}%)`;
        if (bestReclaim.createdFVG) sweepFactor.detail += reclaimDetail + " + FVG created";
        else if (bestReclaim.createdDisplacement) sweepFactor.detail += reclaimDetail + " + displacement";
        else sweepFactor.detail += reclaimDetail;

        // Boost sweep score if reclaim confirmed and sweep was already scored
        if (sweepFactor.present && sweepFactor.weight < 1.5) {
          const boost = bestReclaim.createdFVG ? 0.5 : bestReclaim.createdDisplacement ? 0.35 : 0.25;
          const newWeight = Math.min(1.5, sweepFactor.weight + boost);
          const diff = newWeight - sweepFactor.weight;
          score += diff;
          sweepFactor.weight = newWeight;
          sweepFactor.detail += ` [reclaim boost: +${diff.toFixed(2)}]`;
        }
      } else {
        // Sweeps detected but none reclaimed
        sweepFactor.detail += ` | ${sweepReclaims.length} sweep(s) detected, none reclaimed`;
      }
    }
  }

  // ── Factor 21: Pullback Health (max 0.5) ──
  // Measures pullback depth progression to assess trend health.
  // Shallower pullbacks = healthy trend. Deeper pullbacks = exhausting.
  let pullbackDecay: PullbackDecay | null = null;
  {
    let pts = 0;
    let detail = "";
    const trendForPullback = structure.trend === "bullish" ? "bullish"
      : structure.trend === "bearish" ? "bearish" : "ranging";
    pullbackDecay = measurePullbackDecay(structure.swingPoints, trendForPullback as "bullish" | "bearish" | "ranging");

    if (pullbackDecay.trend === "healthy") {
      pts = 0.5;
      detail = pullbackDecay.detail;
    } else if (pullbackDecay.trend === "exhausting") {
      pts = 0;
      detail = pullbackDecay.detail + " — WARNING: consider reducing position size";
    } else if (pullbackDecay.trend === "stable") {
      pts = 0.25;
      detail = pullbackDecay.detail;
    } else {
      detail = pullbackDecay.detail;
    }
    { const s = applyWeightScale(pts, "pullbackHealth", 0.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Pullback Health", present: pts > 0, weight: s.displayWeight, detail, group: "Price Action" }); }
  }

  // ─── Anti-Double-Count Adjustment Pass ──────────────────────────────────────
  // Corrects overlapping scores where sub-factors are subsets of parent factors.
  // Applied AFTER all individual scoring, BEFORE final clamp.
  {
    const findFactor = (name: string) => factors.find(f => f.name === name);
    const adjustFactor = (name: string, newWeight: number, reason: string) => {
      const f = findFactor(name);
      if (f && f.present) {
        const diff = f.weight - newWeight;
        if (diff > 0) {
          score -= diff;
          f.weight = newWeight;
          f.detail += ` [adjusted: ${reason}]`;
        }
      }
    };

    // Rule 1: Unicorn fires → Breaker = 0, FVG = 0
    // Unicorn IS Breaker + FVG overlap, so scoring all three is triple-counting.
    const unicorn = findFactor("Unicorn Model");
    if (unicorn && unicorn.present) {
      const breaker = findFactor("Breaker Block");
      const fvg = findFactor("Fair Value Gap");
      if (breaker && breaker.present) {
        score -= breaker.weight;
        breaker.weight = 0;
        breaker.detail += " [zeroed: absorbed by Unicorn Model]";
      }
      if (fvg && fvg.present) {
        score -= fvg.weight;
        fvg.weight = 0;
        fvg.detail += " [zeroed: absorbed by Unicorn Model]";
      }
    }

    // Rule 2: Displacement + FVG overlap
    // If displacement created the FVG, reduce displacement to 0.5 (already partially counted in FVG).
    const displacement = findFactor("Displacement");
    const fvgFactor = findFactor("Fair Value Gap");
    if (displacement && displacement.present && fvgFactor && fvgFactor.present
        && displacement.detail.includes("FVG")) {
      adjustFactor("Displacement", 0.5, "FVG already scored the displacement event");
    }

    // Rule 3: OB + FVG both inside same zone → cap combined at 3.0
    // Only applies when Unicorn did NOT fire (Rule 1 already handles that case).
    if (!(unicorn && unicorn.present)) {
      const ob = findFactor("Order Block");
      const fvg2 = findFactor("Fair Value Gap");
      if (ob && ob.present && fvg2 && fvg2.present) {
        const combinedZone = ob.weight + fvg2.weight;
        if (combinedZone > 3.0) {
          const excess = combinedZone - 3.0;
          score -= excess;
          fvg2.weight = Math.max(0, fvg2.weight - excess);
          fvg2.detail += ` [capped: OB+FVG combined limited to 3.0]`;
        }
      }
    }

    // Rule 4 & 6 removed: Kill Zone / Silver Bullet / Macro are now a single Session Quality factor.

    // Rule 5: AMD distribution + sweep → absorbs Judas
    const amdFactor = findFactor("AMD Phase");
    const judas = findFactor("Judas Swing");
    const sweep = findFactor("Liquidity Sweep");
    if (amdFactor && amdFactor.present && sweep && sweep.present && judas && judas.present) {
      score -= judas.weight;
      judas.weight = 0;
      judas.detail += " [zeroed: absorbed by AMD + Sweep sequence]";
    }

    // Rule 6 removed: Macro absorbed into Session Quality.
  }

  // ─── Power of 3 Combo Bonus (+1.0) ─────────────────────────────────────────
  // ICT Power of 3: Consolidation (accumulation) → Fakeout (manipulation/Judas) → Trend (distribution)
  // Awards +1.0 when AMD phase is distribution + sweep/Judas confirmed + trend direction aligned.
  {
    const findFactor = (name: string) => factors.find(f => f.name === name);
    const amdF = findFactor("AMD Phase");
    const sweepF = findFactor("Liquidity Sweep");
    const judasF = findFactor("Judas Swing");
    const msF = findFactor("Market Structure");

    const amdPresent = amdF && amdF.present;
    const sweepOrJudas = (sweepF && sweepF.present) || (judasF && judasF.present);
    const trendAligned = msF && msF.present;

    if (amdPresent && sweepOrJudas && trendAligned) {
      const po3Bonus = 1.0;
      score += po3Bonus;
      factors.push({
        name: "Power of 3 Combo",
        present: true,
        weight: po3Bonus,
        detail: `Full ICT sequence: Accumulation → Manipulation (${sweepF?.present ? "sweep" : "Judas"}) → Distribution — high-probability setup`,
        group: "AMD / Power of 3",
      });
    } else {
      factors.push({
        name: "Power of 3 Combo",
        present: false,
        weight: 0,
        detail: `Incomplete: AMD=${amdPresent ? "✓" : "✗"} Sweep/Judas=${sweepOrJudas ? "✓" : "✗"} Structure=${trendAligned ? "✓" : "✗"}`,
        group: "AMD / Power of 3",
      });
    }
  }

  // ─── Tiered Factor Classification ─────────────────────────────────────────────
  // No group caps. Factors are classified into tiers for scoring:
  // Tier 1 (Core Setup ×2): Must have at least 2 to consider a trade
  // Tier 2 (Confirmation ×1): Adds confidence to the setup
  // Tier 3 (Bonus ×0.5): Nice to have, never required
  const TIER_1_FACTORS = new Set(["Market Structure", "Order Block", "Fair Value Gap", "Premium/Discount"]);
  const TIER_2_FACTORS = new Set(["PD/PW Levels", "Liquidity Sweep", "Displacement", "Reversal Candle", "Session Quality"]);
  // Everything else is Tier 3: Currency Strength, SMT Divergence, Daily Bias, Breaker Block,
  // Unicorn Model, Volume Profile, AMD Phase, Judas Swing
  // (Regime Alignment and Spread Quality are separate gates, not scored)

  // Tag each factor with its tier for display
  for (const f of factors) {
    if (TIER_1_FACTORS.has(f.name)) {
      (f as any).tier = 1;
    } else if (TIER_2_FACTORS.has(f.name)) {
      (f as any).tier = 2;
    } else {
      (f as any).tier = 3;
    }
  }

  // ─── Regime Classification (info-only, separate gate — no score adjustment) ──────
  // Classifies the instrument's current regime for display and optional gate blocking.
  // Does NOT adjust the confluence score — regime is a separate pass/fail gate.
  // Now supports multi-timeframe regime: Daily (primary) + 4H (secondary).
  const regimeScoringEnabled = config.regimeScoringEnabled !== false;
  let regimeInfo: { regime: string; confidence: number; atrTrend: string; bias: string; indicators: string[];
    transition?: { state: string; confidence: number; momentum: number; priorScore: number; currentScore: number; detail: string };
  } | null = null;
  let regime4HInfo: { regime: string; confidence: number; atrTrend: string; bias: string; indicators: string[];
    transition?: { state: string; confidence: number; momentum: number; priorScore: number; currentScore: number; detail: string };
  } | null = null;
  let regimeGatePassed = true;
  let regimeGateReason = "";
  {
    const h4Candles: Candle[] | null = (config as any)._h4Candles || null;

    if (regimeScoringEnabled && dailyCandles && dailyCandles.length >= 20) {
      regimeInfo = classifyInstrumentRegimeLocal(dailyCandles);

      // ── Multi-TF Regime: classify 4H alongside daily ──
      if (h4Candles && h4Candles.length >= 20) {
        regime4HInfo = classifyInstrumentRegimeLocal(h4Candles);
      }

      // ── Multi-TF Alignment Adjustment ──
      // When both timeframes are available, adjust the effective regime based on agreement/disagreement.
      // Daily is the primary regime; 4H provides confirmation or caution.
      const { adjustment, detail } = regimeAlignmentAdjustment(
        regimeInfo.regime, regimeInfo.confidence, direction, factors
      );

      // Multi-TF modifier: if 4H disagrees with daily, reduce confidence in the alignment
      let multiTFModifier = 0;
      let multiTFDetail = "";
      if (regime4HInfo) {
        const dailyTrending = regimeInfo.regime === "strong_trend" || regimeInfo.regime === "mild_trend";
        const dailyRanging = regimeInfo.regime === "choppy_range" || regimeInfo.regime === "mild_range";
        const h4Trending = regime4HInfo.regime === "strong_trend" || regime4HInfo.regime === "mild_trend";
        const h4Ranging = regime4HInfo.regime === "choppy_range" || regime4HInfo.regime === "mild_range";

        if ((dailyTrending && h4Trending) || (dailyRanging && h4Ranging)) {
          // Both timeframes agree — strengthen the signal
          multiTFModifier = 0.15;
          multiTFDetail = `Multi-TF AGREE: Daily ${regimeInfo.regime.replace("_", " ")} + 4H ${regime4HInfo.regime.replace("_", " ")} → +0.15 confidence boost`;
        } else if ((dailyTrending && h4Ranging) || (dailyRanging && h4Trending)) {
          // Timeframes disagree — caution, reduce confidence
          multiTFModifier = -0.25;
          multiTFDetail = `Multi-TF DISAGREE: Daily ${regimeInfo.regime.replace("_", " ")} vs 4H ${regime4HInfo.regime.replace("_", " ")} → -0.25 confidence reduction`;
        } else {
          // One is transitional — mild uncertainty
          multiTFModifier = -0.1;
          multiTFDetail = `Multi-TF MIXED: Daily ${regimeInfo.regime.replace("_", " ")} + 4H ${regime4HInfo.regime.replace("_", " ")} → -0.1 mild uncertainty`;
        }
      }

      // Apply multi-TF modifier to the alignment adjustment
      const effectiveAdjustment = adjustment + multiTFModifier;

      // Regime is now info-only for the score — but we track it for the gate
      // If effective adjustment is heavily negative (< -1.0), regime gate fails
      if (effectiveAdjustment < -1.0) {
        regimeGatePassed = false;
        regimeGateReason = `Regime mismatch: ${regimeInfo.regime.replace("_", " ")} — ${detail}${multiTFDetail ? " | " + multiTFDetail : ""}`;
      } else {
        regimeGateReason = `Regime OK: ${regimeInfo.regime.replace("_", " ")} — ${detail}${multiTFDetail ? " | " + multiTFDetail : ""}`;
      }

      // Include the 7-check indicator breakdown in the factor detail
      const indicatorSummary = regimeInfo.indicators.length > 0
        ? " | Checks: " + regimeInfo.indicators.join(" | ")
        : "";
      // Transition info
      const transitionSummary = regimeInfo.transition
        ? ` | Transition: ${regimeInfo.transition.state} (${(regimeInfo.transition.confidence * 100).toFixed(0)}% conf, momentum ${regimeInfo.transition.momentum > 0 ? "+" : ""}${regimeInfo.transition.momentum.toFixed(3)}/candle)`
        : "";
      // 4H regime summary
      const h4Summary = regime4HInfo
        ? ` | 4H Regime: ${regime4HInfo.regime.replace("_", " ")} (${(regime4HInfo.confidence * 100).toFixed(0)}% conf, bias ${regime4HInfo.bias})`
        : "";

      factors.push({
        name: "Regime Alignment",
        present: true,
        weight: 0, // No score impact — info only
        detail: `${regimeInfo.regime.replace("_", " ")} (${(regimeInfo.confidence * 100).toFixed(0)}% conf, ATR ${regimeInfo.atrTrend}, bias ${regimeInfo.bias}) — ${detail} [info-only gate]${transitionSummary}${h4Summary}${multiTFDetail ? " | " + multiTFDetail : ""}${indicatorSummary}`,
        group: "Macro Confirmation",
      });
    } else {
      factors.push({
        name: "Regime Alignment",
        present: false,
        weight: 0,
        detail: regimeScoringEnabled ? "Insufficient daily candles for regime classification" : "Regime scoring disabled",
        group: "Macro Confirmation",
      });
    }
  }

  // ─── Spread Quality (INFO-ONLY — never rejects a trade) ─────────────────────
  // Compares the instrument's typical spread against its ATR.
  // This is informational only — the bot uses Yahoo Finance indicative spreads,
  // not the user's actual broker spread (which is typically near-zero on ECN accounts).
  // The live spread check at execution time (via broker API) remains as the real guard.
  let spreadGatePassed = true; // Always true — info-only, never blocks
  let spreadGateReason = "";
  {
    const spreadSymbol = config._currentSymbol || "EUR/USD";
    const spreadSpec = SPECS[spreadSymbol] || SPECS["EUR/USD"];
    const typicalSpreadPrice = (spreadSpec.typicalSpread ?? 1) * spreadSpec.pipSize;
    const spreadATR = calculateATR(candles, 14);
    let spreadDetail = "";
    if (spreadATR > 0) {
      const spreadToATR = typicalSpreadPrice / spreadATR;
      if (spreadToATR < 0.05) {
        spreadDetail = `Excellent: spread ${spreadSpec.typicalSpread}p = ${(spreadToATR * 100).toFixed(1)}% of ATR`;
      } else if (spreadToATR < 0.10) {
        spreadDetail = `Acceptable: spread ${spreadSpec.typicalSpread}p = ${(spreadToATR * 100).toFixed(1)}% of ATR`;
      } else if (spreadToATR < 0.20) {
        spreadDetail = `Mediocre: spread ${spreadSpec.typicalSpread}p = ${(spreadToATR * 100).toFixed(1)}% of ATR`;
      } else {
        spreadDetail = `Wide (indicative): spread ${spreadSpec.typicalSpread}p = ${(spreadToATR * 100).toFixed(1)}% of ATR — info only, not blocking`;
        // spreadGatePassed remains true — info-only, does not reject
        spreadGateReason = `Spread wide (indicative): ${(spreadToATR * 100).toFixed(1)}% of ATR — info only`;
      }
      if (!spreadGateReason) {
        spreadGateReason = `Spread OK: ${(spreadToATR * 100).toFixed(1)}% of ATR`;
      }
    } else {
      spreadDetail = "ATR unavailable — no spread quality assessment";
    }
    factors.push({
      name: "Spread Quality",
      present: false, // Always false — info-only, never contributes to score
      weight: 0, // No score impact — info only
      detail: `${spreadDetail} [info-only — broker spread used at execution]`,
      group: "Macro Confirmation",
    });
  }

  // ─── Tiered Scoring Model ─────────────────────────────────────────────────
  // Replaces the old percentage-of-weighted-max system with a clear tiered model:
  //   Tier 1 (Core Setup): Market Structure, Order Block, FVG, Premium/Discount
  //     → Each present Tier 1 factor scores 2 points
  //     → Must have at least 2 Tier 1 factors to consider a trade
  //   Tier 2 (Confirmation): PD/PW Levels, Liquidity Sweep, Displacement, Reversal Candle, Session Quality
  //     → Each present Tier 2 factor scores 1 point
  //   Tier 3 (Bonus): Everything else (Currency Strength, SMT, Daily Bias, Breaker, Unicorn, Volume, AMD, Judas)
  //     → Each present Tier 3 factor scores 0.5 points
  //   Regime and Spread are separate pass/fail gates — they do NOT affect the score.
  //
  // Max possible = (4 × 2) + (5 × 1) + (8 × 0.5) + Po3 bonus (1.0) + OR bonus (2.0) = 20
  // Score percentage = tiered points / max possible × 100

  const TIER_POINTS = { 1: 2, 2: 1, 3: 0.5 } as const;

  // Count tier 1 factors present (for the minimum gate)
  let tier1Count = 0;
  let tier1Max = 0;
  let tier2Count = 0;
  let tier2Max = 0;
  let tier3Count = 0;
  let tier3Max = 0;
  let tieredScore = 0;

  // Factor toggle map to check if factors are disabled
  const FACTOR_TOGGLE_MAP: Record<string, string> = {
    marketStructure: "enableStructureBreak",
    orderBlock: "enableOB",
    fairValueGap: "enableFVG",
    liquiditySweep: "enableLiquiditySweep",
    displacement: "useDisplacement",
    breakerBlock: "useBreakerBlocks",
    unicornModel: "useUnicornModel",
    smtDivergence: "useSMT",
    volumeProfile: "useVolumeProfile",
    amdPhase: "useAMD",
    currencyStrength: "useFOTSI",
    dailyBias: "useDailyBias",
  };

  const NAME_TO_KEY: Record<string, string> = {
    "Market Structure": "marketStructure",
    "Order Block": "orderBlock",
    "Fair Value Gap": "fairValueGap",
    "Premium/Discount": "premiumDiscountFib",
    "Session Quality": "sessionQuality",
    "Judas Swing": "judasSwing",
    "PD/PW Levels": "pdPwLevels",
    "Reversal Candle": "reversalCandle",
    "Liquidity Sweep": "liquiditySweep",
    "Displacement": "displacement",
    "Breaker Block": "breakerBlock",
    "Unicorn Model": "unicornModel",
    "SMT Divergence": "smtDivergence",
    "Volume Profile": "volumeProfile",
    "AMD Phase": "amdPhase",
    "Currency Strength": "currencyStrength",
    "Daily Bias": "dailyBias",
  };

  for (const f of factors) {
    const tier = (f as any).tier as number | undefined;
    if (!tier) continue; // Skip Regime, Spread, Po3, OR — they're not tiered

    // Check if factor is disabled via toggle
    const key = NAME_TO_KEY[f.name];
    if (key) {
      const toggleKey = FACTOR_TOGGLE_MAP[key];
      if (toggleKey && (config as any)[toggleKey] === false) continue;
    }

    const pts = TIER_POINTS[tier as keyof typeof TIER_POINTS] || 0.5;

    if (tier === 1) {
      tier1Max++;
      if (f.present && f.weight > 0) {
        tier1Count++;
        tieredScore += pts;
        f.detail += ` [Tier 1: +${pts}pts]`;
      }
    } else if (tier === 2) {
      tier2Max++;
      if (f.present && f.weight > 0) {
        tier2Count++;
        tieredScore += pts;
        f.detail += ` [Tier 2: +${pts}pt]`;
      }
    } else {
      tier3Max++;
      if (f.present && f.weight > 0) {
        tier3Count++;
        tieredScore += pts;
        f.detail += ` [Tier 3: +${pts}pts]`;
      }
    }
  }

  // Add Po3 combo bonus if present
  const po3Factor = factors.find(f => f.name === "Power of 3 Combo" && f.present);
  if (po3Factor) tieredScore += 1.0;

  // Add Opening Range bonus if present
  const orFactor = factors.find(f => f.name && f.name.includes("Opening Range") && f.present);
  if (orFactor) tieredScore += Math.min(2.0, orFactor.weight);

  // Calculate max possible from enabled tiers + bonuses
  let tieredMax = (tier1Max * 2) + (tier2Max * 1) + (tier3Max * 0.5);
  // Add Po3 potential if prerequisites are enabled
  const po3Possible = (config as any).enableStructureBreak !== false
    && (config as any).useAMD !== false
    && (config as any).enableLiquiditySweep !== false;
  if (po3Possible) tieredMax += 1.0;
  if (config.openingRange?.enabled) tieredMax += 2.0;

  // Convert to percentage
  const rawScore = Math.round(tieredScore * 100) / 100;
  const enabledMax = Math.round(tieredMax * 100) / 100;

  if (tieredMax > 0) {
    score = Math.round((tieredScore / tieredMax) * 1000) / 10; // e.g., 72.3%
  } else {
    score = 0;
  }

  // Tier 1 minimum gate: need at least 2 core factors
  const tier1GatePassed = tier1Count >= 2;
  const tier1GateReason = tier1GatePassed
    ? `Tier 1 gate passed: ${tier1Count}/4 core factors (${["Market Structure", "Order Block", "FVG", "Premium/Discount"].filter(n => factors.find(f => f.name === n && f.present && f.weight > 0)).join(", ")})`
    : `Tier 1 gate FAILED: only ${tier1Count}/4 core factors — need at least 2 of: Market Structure, Order Block, FVG, Premium/Discount`;

  // Strong factor count = Tier 1 + Tier 2 present (Tier 3 are bonuses, not "strong")
  const strongFactorCount = tier1Count + tier2Count;

  // Calculate SL/TP using configurable methods
  const symbolForSL = config._currentSymbol || "EUR/USD";
  const specSL = SPECS[symbolForSL] || SPECS["EUR/USD"];
  const pipSize = specSL.pipSize;
  const swings = structure.swingPoints;

  // Compute ATR for ATR-based methods (use entry candles)
  const atrValue = calculateATR(candles, config.slATRPeriod || 14);

  const { stopLoss, takeProfit } = calculateSLTP({
    direction, lastPrice, pipSize, config, swings, orderBlocks, liquidityPools, pdLevels, atrValue, fvgs,
  });

  const presentFactors = factors.filter(f => f.present);
  const enabledFactors = factors.filter(f => f.weight !== 0 || f.present);
  const bias = direction === "long" ? "bullish" : direction === "short" ? "bearish" : "neutral";

  // Build grouped summary
  const groupNames = [...new Set(factors.filter(f => f.group).map(f => f.group!))];
  const activeGroups = groupNames.filter(g => factors.some(f => f.group === g && f.present));
  const groupSummaryParts = activeGroups.map(g => {
    const gFactors = factors.filter(f => f.group === g && f.present);
    return `${g}: ${gFactors.map(f => f.name).join("+")}`;
  });

  const fotsiSummary = _fotsiAlignment ? ` | FOTSI: ${_fotsiAlignment.label}` : "";
  // Build gate summary for the scan output
  const gatesSummary = [
    tier1GatePassed ? null : "TIER1_GATE_FAIL",
    regimeGatePassed ? null : "REGIME_GATE_FAIL",
    // Spread gate is info-only — never blocks
  ].filter(Boolean);
  const gatesStr = gatesSummary.length > 0 ? ` | Gates: ${gatesSummary.join(", ")}` : "";

  const summary = direction
    ? `${direction === "long" ? "BUY" : "SELL"}: ${score}% confluence (T1:${tier1Count}/4, T2:${tier2Count}/5, T3:${tier3Count} bonus, ${strongFactorCount} strong). ${groupSummaryParts.join(" | ")}${fotsiSummary}${gatesStr}`
    : `No signal: ${score}% confluence (T1:${tier1Count}/4, T2:${tier2Count}/5, T3:${tier3Count} bonus)${fotsiSummary}${gatesStr}`;

  return {
    score, rawScore, normalizedScoring: true, enabledMax,
    strongFactorCount, direction, bias, summary, factors,
    structure, orderBlocks, fvgs, liquidityPools, judasSwing, reversalCandle,
    pd, session, pdLevels, lastPrice, stopLoss, takeProfit, displacement, breakerBlocks, unicornSetups, silverBullet, macroWindow, smt: smtResult, vwap, amd,
    fotsiAlignment: _fotsiAlignment, volumeProfile, regimeInfo, regime4HInfo,
    // Confluence stacking, sweep reclaim, pullback decay
    confluenceStacks, sweepReclaims, pullbackDecay,
    // New tiered scoring metadata
    tieredScoring: {
      tier1Count, tier1Max, tier2Count, tier2Max, tier3Count, tier3Max,
      tieredScore, tieredMax,
      tier1GatePassed, tier1GateReason,
      regimeGatePassed, regimeGateReason,
      spreadGatePassed, spreadGateReason,
    },
  };
}
// ─── Lightweight Regime Classification (for real-time scoring) ──────
// Uses dailyCandles already available in the scoring function.
// Returns a regime label + confidence so the scorer can apply a penalty/bonus.
// H7: classifyInstrumentRegime is now imported from _shared/smcAnalysis.ts
// Thin wrapper to preserve the scanner's existing return shape { regime, confidence, atrTrend, bias }
function classifyInstrumentRegimeLocal(dailyCandles: Candle[]): {
  regime: string; confidence: number; atrTrend: string; bias: string; indicators: string[];
  transition?: { state: string; confidence: number; momentum: number; priorScore: number; currentScore: number; detail: string };
} {
  const result = classifyInstrumentRegime(dailyCandles);
  return {
    regime: result.regime,
    confidence: result.confidence,
    atrTrend: result.atrTrend,
    bias: result.directionalBias,
    indicators: result.indicators || [],
    transition: result.transition ? {
      state: result.transition.state,
      confidence: result.transition.confidence,
      momentum: result.transition.momentum,
      priorScore: result.transition.priorScore,
      currentScore: result.transition.currentScore,
      detail: result.transition.detail,
    } : undefined,
  };
}

// Determine if the trade direction aligns with the instrument's regime
// Returns a score adjustment: positive = bonus, negative = penalty
function regimeAlignmentAdjustment(
  regime: string,
  confidence: number,
  direction: string | null,
  factors: Array<{ name: string; present: boolean; weight: number; detail: string; group?: string }>
): { adjustment: number; detail: string } {
  if (!direction || confidence < 0.5) {
    return { adjustment: 0, detail: "Regime unknown or low confidence — no adjustment" };
  }

  // Determine if this is a trend-following or mean-reversion setup
  const trendFactors = ["Market Structure", "Trend Direction", "Displacement"];
  const rangeFactors = ["Premium/Discount", "Order Block", "Fair Value Gap", "Breaker Block"];

  let trendScore = 0;
  let rangeScore = 0;
  for (const f of factors) {
    if (!f.present) continue;
    if (trendFactors.includes(f.name)) trendScore += f.weight;
    if (rangeFactors.includes(f.name)) rangeScore += f.weight;
  }

  const isTrendSetup = trendScore > rangeScore;
  const isRangeSetup = rangeScore > trendScore;

  // Scale penalty/bonus by confidence (higher confidence = stronger effect)
  const scaleFactor = Math.min(1.0, confidence);

  if (regime === "strong_trend" || regime === "mild_trend") {
    if (isTrendSetup) {
      // Trend setup in trending market = small bonus
      const bonus = regime === "strong_trend" ? 0.5 : 0.25;
      return {
        adjustment: +(bonus * scaleFactor).toFixed(2),
        detail: `Trend setup in ${regime.replace("_", " ")} market → +${(bonus * scaleFactor).toFixed(1)} bonus (conf: ${(confidence * 100).toFixed(0)}%)`
      };
    } else if (isRangeSetup) {
      // Range/reversal setup in trending market = penalty
      const penalty = regime === "strong_trend" ? -1.5 : -0.75;
      return {
        adjustment: +(penalty * scaleFactor).toFixed(2),
        detail: `Range setup in ${regime.replace("_", " ")} market → ${(penalty * scaleFactor).toFixed(1)} penalty (conf: ${(confidence * 100).toFixed(0)}%)`
      };
    }
  }

  if (regime === "choppy_range" || regime === "mild_range") {
    if (isRangeSetup) {
      // Range setup in ranging market = small bonus
      const bonus = regime === "choppy_range" ? 0.5 : 0.25;
      return {
        adjustment: +(bonus * scaleFactor).toFixed(2),
        detail: `Range setup in ${regime.replace("_", " ")} market → +${(bonus * scaleFactor).toFixed(1)} bonus (conf: ${(confidence * 100).toFixed(0)}%)`
      };
    } else if (isTrendSetup) {
      // Trend setup in choppy market = penalty
      const penalty = regime === "choppy_range" ? -1.5 : -0.75;
      return {
        adjustment: +(penalty * scaleFactor).toFixed(2),
        detail: `Trend setup in ${regime.replace("_", " ")} market → ${(penalty * scaleFactor).toFixed(1)} penalty (conf: ${(confidence * 100).toFixed(0)}%)`
      };
    }
  }

  return { adjustment: 0, detail: `Transitional regime — no adjustment` };
}

// ─── Fetch candles via shared multi-source helper ────────────────────
// Tries: MetaAPI (broker feed) → Twelve Data → Yahoo Finance
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
  if (config.htfBiasRequired && dailyCandles && dailyCandles.length >= 10) {
    const htfStructure = analyzeMarketStructure(dailyCandles);
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
      // Actual risk = |entry - SL| * lotUnits * size
      const riskPerUnit = Math.abs(pEntry - pSL) * spec.lotUnits * pSize;
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
  const actualBase = account.daily_pnl_date === todayStr ? dailyPnlBase : balance;
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
      const sess = detectSession(config);
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

  // Gate 21: Spread Quality (INFO-ONLY — never rejects, uses indicative Yahoo data)
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
      // Await the scan so we can return the full result to the frontend.
      // Manual scans are user-triggered one-offs — returning real results
      // is far better than fire-and-forget with silent failures.
      try {
        const result = await runScanForUser(adminClient, userId, { isManualScan: true });
        return respond({
          ...result,
          started: false, // signal to frontend: this is a completed result, not a background job
        });
      } catch (e: any) {
        console.error("[manual_scan] error", e);
        return respond({
          error: e?.message || "Scan failed unexpectedly",
          started: false,
          pairsScanned: 0,
          signalsFound: 0,
          tradesPlaced: 0,
        });
      }
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

async function runScanForUser(supabase: any, userId: string, opts?: { isManualScan?: boolean }) {
  const specCache: Record<string, { minVolume: number; maxVolume: number; volumeStep: number }> = {};
  const balanceCache: Record<string, number> = {};
  const MAX_BROKER_RISK_PERCENT = 5; // hard safety cap per broker per trade
  const scanCycleId = crypto.randomUUID();

  // ── Scan overlap lock (90s lease) ──
  // Prevents two cron invocations from racing — second cycle would otherwise see the first's
  // in-flight trades as orphans or double-process the same signals.
  //
  // For manual scans: force-clear any stale lock first. The user explicitly clicked
  // "Scan Now" — they should never be blocked by a lock left behind by a crashed cron scan.
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

  let account: any = null;
  try {
  const config = await loadConfig(supabase, userId);

  // ── Scan Interval Gate ──
  // Skip this scan if not enough time has elapsed since the last scan.
  // Manual scans (passed via context) always bypass this gate.
  const intervalMinutes = config.scanIntervalMinutes || 15;
  if (!opts?.isManualScan) {
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
      // Management fields the user can tune per-broker:
      "trailingStopEnabled", "trailingStopPips", "trailingStopActivation",
      "breakEvenEnabled", "breakEvenPips",
      "partialTPEnabled", "partialTPPercent", "partialTPLevel",
      "maxHoldHours",
    ]);
    for (const [key, val] of Object.entries(styleDefaults)) {
      if (userProtectedFields.has(key)) {
        // Only apply style default if user didn't explicitly set this field
        // (i.e., the value is still the global DEFAULTS fallback)
        if ((config as any)[key] === (DEFAULTS as any)[key]) {
          (config as any)[key] = val;
        }
        // else: user explicitly set a different value — keep it
      } else {
        // Non-protected fields (entryTimeframe, htfTimeframe, tpRatio, slBufferPips)
        // always come from the style
        (config as any)[key] = val;
      }
    }
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
  if (!config.enabledDays.includes(effectiveDay) && !hasCrypto) {
    return { pairsScanned: 0, signalsFound: 0, tradesPlaced: 0, skippedReason: "Day not enabled", activeStyle: resolvedStyle };
  }

  const session = detectSession(config);
  // Session filter: use filterKey directly from shared sessions module (no more manual normalization)
  const normalizedSession = session.filterKey;
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
  console.log(`[scan ${scanCycleId}] Candle source: ${_scanBrokerConn ? "MetaAPI→TwelveData→Yahoo" : "TwelveData→Yahoo"}`);
  // Start tallying which feed actually serves each pair this cycle.
  beginScanSourceTally();
  resetThrottleStats(); // Reset rate-limit throttle counter for clean per-scan stats

  const { data: openPositions } = await supabase.from("paper_positions").select("*")
    .eq("user_id", userId).eq("position_status", "open");
  // Filter to only this bot's positions (bot_id column or legacy without it)
  const openPosArr = (openPositions || []).filter((p: any) => !p.bot_id || p.bot_id === BOT_ID);

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
                const connsToModify = mirroredIds.length > 0
                  ? liveConns.filter((c: any) => mirroredIds.includes(c.id))
                  : liveConns; // fallback: try all active connections
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
                    if (!brokerPos) {
                      // Fallback: match by symbol + direction
                      const brokerSymbol = resolveSymbol(a.symbol, conn);
                      brokerPos = brokerPositions.find((p: any) =>
                        (p.symbol === brokerSymbol || p.symbol === a.symbol.replace("/", "") ||
                         p.symbol?.replace(/[._\-]/g, "").toUpperCase() === a.symbol.replace("/", "").toUpperCase()) &&
                        ((p.type === "POSITION_TYPE_BUY" && pos.direction === "long") ||
                         (p.type === "POSITION_TYPE_SELL" && pos.direction === "short"))
                      );
                    }
                    if (!brokerPos) { console.warn(`[mgmt-broker] ${conn.display_name}: position not found for ${a.symbol} SL modify`); continue; }
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
                const connsToClose = mirroredIds.length > 0
                  ? liveConnsP.filter((c: any) => mirroredIds.includes(c.id))
                  : liveConnsP;
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
  if (account.daily_pnl_date !== todayStr) {
    const pnlUpdate = supabase.from("paper_accounts").update({
      daily_pnl_date: todayStr,
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
          console.log(`[pending] FILLED ${pending.symbol} ${pending.direction} limit @ ${entryPrice} (current: ${currentPrice})`);

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
            entry_price: entryPrice.toString(),
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

  for (const pair of config.instruments) {
    if (!YAHOO_SYMBOLS[pair]) {
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
    const entryInterval = getYahooInterval(pairConfig.entryTimeframe);
    const entryRange = getYahooRange(pairConfig.entryTimeframe);

    // Fetch entry TF, daily, 4H (for multi-TF regime), optionally 1h, and SMT correlated pair candles in parallel
    const orFlag = pairConfig.openingRange?.enabled ? 1 : 0;
    const smtPair = pairConfig.useSMT !== false ? SMT_PAIRS[pair] : undefined;
    const smtFlag = smtPair && YAHOO_SYMBOLS[smtPair] ? 1 : 0;
    const multiTFRegimeEnabled = pairConfig.multiTFRegimeEnabled !== false; // ON by default
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
    const analysis = runFullConfluenceAnalysis(candles, dailyCandles.length >= 10 ? dailyCandles : null, pairConfig, hourlyCandles);

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
      const allPassed = gates.every(g => g.passed);
      detail.gates = gates;

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

          await supabase.from("pending_orders").insert({
            user_id: userId,
            bot_id: BOT_ID,
            order_id: pendingOrderId,
            symbol: pair,
            direction: analysis.direction,
            order_type: limitEntry.zoneType === "OB" ? "limit_ob" : "limit_fvg",
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
            signal_reason: JSON.stringify({ bot: BOT_ID, summary: analysis.summary, setupType: setupClassification.setupType, setupConfidence: setupClassification.confidence, exitFlags, ...(isPromotedFromStaging && existingStaged ? { promotedFromWatchlist: true, watchlistOrigin: { initialScore: parseFloat(existingStaged.initial_score), cyclesWatched: existingStaged.scan_cycles + 1, stagedAt: existingStaged.staged_at } } : {}) }),
            signal_score: analysis.score,
            setup_type: setupClassification.setupType,
            setup_confidence: setupClassification.confidence,
            from_watchlist: isPromotedFromStaging || false,
            staged_cycles: isPromotedFromStaging && existingStaged ? existingStaged.scan_cycles + 1 : 0,
            staged_initial_score: isPromotedFromStaging && existingStaged ? parseFloat(existingStaged.initial_score) : null,
            exit_flags: exitFlags,
            placed_at: new Date().toISOString(),
          });

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
          signal_reason: JSON.stringify({ bot: BOT_ID, summary: analysis.summary, setupType: setupClassification.setupType, setupConfidence: setupClassification.confidence, setupRationale: setupClassification.rationale, exitFlags, spreadFilter: { enabled: pairConfig.spreadFilterEnabled, maxPips: pairConfig.maxSpreadPips }, newsFilter: { enabled: pairConfig.newsFilterEnabled, pauseMinutes: pairConfig.newsFilterPauseMinutes }, fotsi: analysis.fotsiAlignment ? { base: analysis.fotsiAlignment.baseTSI, quote: analysis.fotsiAlignment.quoteTSI, spread: analysis.fotsiAlignment.spread, score: analysis.fotsiAlignment.score, label: analysis.fotsiAlignment.label } : null, ...(isPromotedFromStaging && existingStaged ? { promotedFromWatchlist: true, watchlistOrigin: { initialScore: parseFloat(existingStaged.initial_score), cyclesWatched: existingStaged.scan_cycles + 1, stagedAt: existingStaged.staged_at, promotionReason: `Score reached ${analysis.score.toFixed(1)}% (gate: ${adjustedMinConfluence}%) after ${existingStaged.scan_cycles + 1} cycles` } } : {}) }),
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
      candleSource: sourceTally.primary,         // "metaapi" | "twelvedata" | "yahoo" | "none"
      sourceBreakdown: {
        metaapi: sourceTally.metaapi,
        twelvedata: sourceTally.twelvedata,
        yahoo: sourceTally.yahoo,
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
  console.log(`[scan ${scanCycleId}] Primary candle source: ${sourceTally.primary} (meta=${sourceTally.metaapi}, td=${sourceTally.twelvedata}, yahoo=${sourceTally.yahoo}, none=${sourceTally.none}, throttles=${throttleStats.throttleCount})`);

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
    try {
      const lockRelease = supabase.from("paper_accounts").update({ scan_lock_until: null }).eq("user_id", userId);
      if (account?.bot_id) lockRelease.eq("bot_id", BOT_ID);
      await lockRelease;
    } catch (e: any) {
      console.warn(`[scan-lock] release failed for ${userId}: ${e?.message}`);
    }
  }
}

function respond(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
