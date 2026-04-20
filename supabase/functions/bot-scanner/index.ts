import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { fetchCandlesWithFallback, beginScanSourceTally, endScanSourceTally, type BrokerConn } from "../_shared/candleSource.ts";
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
  calculatePDLevels,
  computeOpeningRange, calculateSLTP,
} from "../_shared/smcAnalysis.ts";
import {
  classifySetupType, manageOpenPositions,
  type SetupClassification, type ManagementAction,
} from "../_shared/scannerManagement.ts";

// ─── Bot Identity ────────────────────────────────────────────────────
const BOT_ID = "smc";
// ─── Default Config (overridden by bot_configs) ─────────────────────
const DEFAULTS = {
  minConfluence: 5.5,
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
  cooldownMinutes: 0,
  closeOnReverse: false,
  // ── Exit toggles ──
  trailingStopEnabled: false,
  trailingStopPips: 15,
  trailingStopActivation: "after_1r",
  partialTPEnabled: false,
  partialTPPercent: 50,
  partialTPLevel: 1.0,
  maxHoldHours: 0,
  // ── Sessions ──
  killZoneOnly: false,
  // ── Protection ──
  maxConsecutiveLosses: 0,
  protectionMaxDailyLossDollar: 0,
  // ── Strategy gates ──
  minFactorCount: 0,
  useSMT: true,
  useFOTSI: true,
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
  marketStructure: 1.5,
  orderBlock: 2.0,
  fairValueGap: 2.0,
  premiumDiscountFib: 2.0,
  sessionKillZone: 1.0,
  judasSwing: 0.5,
  pdPwLevels: 1.0,
  reversalCandle: 0.5,
  liquiditySweep: 1.0,
  displacement: 1.0,
  breakerBlock: 1.0,
  unicornModel: 1.5,
  silverBullet: 1.0,
  macroWindow: 1.0,
  smtDivergence: 1.0,
  volumeProfile: 1.5,
  amdPhase: 1.0,
  currencyStrength: 1.5,
  trendDirection: 1.5,
  dailyBias: 1.5,
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

// ─── Trading Style Overrides ────────────────────────────────────────
const STYLE_OVERRIDES: Record<string, Partial<typeof DEFAULTS>> = {
  scalper: {
    entryTimeframe: "5m",
    htfTimeframe: "1h",
    tpRatio: 1.5,
    slBufferPips: 1,
    minConfluence: 5,
    // Management: tight trailing, fast BE, no partial, short hold
    trailingStopEnabled: true,
    trailingStopPips: 10,           // tight trail for scalps
    trailingStopActivation: "after_0.5r",
    breakEvenEnabled: true,
    breakEvenPips: 10,              // quick BE for scalps
    partialTPEnabled: false,
    maxHoldHours: 4,
  },
  day_trader: {
    entryTimeframe: "15min",
    htfTimeframe: "1day",
    tpRatio: 2.0,
    slBufferPips: 2,
    minConfluence: 5.5,
    // Management: partial TP at 1R, moderate BE, no trailing by default
    trailingStopEnabled: false,
    breakEvenEnabled: true,
    breakEvenPips: 20,              // moderate BE for day trades
    partialTPEnabled: true,
    partialTPPercent: 50,
    partialTPLevel: 1.0,            // partial at 1R
    maxHoldHours: 24,
  },
  swing_trader: {
    entryTimeframe: "1h",
    htfTimeframe: "1w",
    tpRatio: 3.0,
    slBufferPips: 5,
    minConfluence: 6.5,
    // Management: wide trailing, wide BE, partial at 1.5R, long hold
    trailingStopEnabled: true,
    trailingStopPips: 30,           // wide trail for swings
    trailingStopActivation: "after_1r",
    breakEvenEnabled: true,
    breakEvenPips: 50,              // wide BE — 50 pips so XAU noise doesn't trigger it
    partialTPEnabled: true,
    partialTPPercent: 40,
    partialTPLevel: 1.5,            // partial at 1.5R
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


// ─── DST-Aware New York Time Helper ─────────────────────────────────
function toNYTime(utc: Date): { h: number; m: number; t: number; tMin: number; isEDT: boolean } {
  const year = utc.getUTCFullYear();
  const mar1 = new Date(Date.UTC(year, 2, 1));
  const marSun2 = 14 - mar1.getUTCDay();
  const edtStart = Date.UTC(year, 2, marSun2, 7, 0, 0);
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const novSun1 = nov1.getUTCDay() === 0 ? 1 : 8 - nov1.getUTCDay();
  const edtEnd = Date.UTC(year, 10, novSun1, 6, 0, 0);
  const isEDT = utc.getTime() >= edtStart && utc.getTime() < edtEnd;
  const offsetH = isEDT ? 4 : 5;
  const nyMs = utc.getTime() - offsetH * 3600_000;
  const ny = new Date(nyMs);
  const h = ny.getUTCHours();
  const m = ny.getUTCMinutes();
  return { h, m, t: h + m / 60, tMin: h * 60 + m, isEDT };
}

// ─── Session Detection (DST-aware, config-driven) ─────────────────
const DEFAULT_SESSION_WINDOWS = {
  sydney:  { start: 17, end: 26 },
  asian:   { start: 20, end: 26 },
  london:  { start: 2,  end: 8.5 },
  newYork: { start: 8.5, end: 16 },
};

function parseHHMM(s: any, fallback: number): number {
  if (typeof s !== "string") return fallback;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  return Number(m[1]) + Number(m[2]) / 60;
}

function inWindow(t: number, start: number, end: number): boolean {
  if (end > 24) {
    return t >= start || t < (end - 24);
  }
  return t >= start && t < end;
}

function detectSession(_config?: any): { name: string; isKillZone: boolean } {
  const ny = toNYTime(new Date());
  const t = ny.t;
  const lonStart = DEFAULT_SESSION_WINDOWS.london.start;
  const lonEnd   = DEFAULT_SESSION_WINDOWS.london.end;
  const nyStart  = DEFAULT_SESSION_WINDOWS.newYork.start;
  const nyEnd    = DEFAULT_SESSION_WINDOWS.newYork.end;
  const asiaStart = DEFAULT_SESSION_WINDOWS.asian.start;
  const asiaEnd   = DEFAULT_SESSION_WINDOWS.asian.end;
  const sydStart  = DEFAULT_SESSION_WINDOWS.sydney.start;
  const sydEnd    = DEFAULT_SESSION_WINDOWS.sydney.end;
  const inLondonKZ = t >= 2 && t < 5;
  const inNYKZ = (t >= 8.5 && t < 11) || (t >= 11 && t < 12);
  if (inWindow(t, lonStart, lonEnd))   return { name: "London",   isKillZone: inLondonKZ };
  if (inWindow(t, nyStart,  nyEnd))    return { name: "New York", isKillZone: inNYKZ };
  if (inWindow(t, asiaStart, asiaEnd)) return { name: "Asian",    isKillZone: false };
  if (inWindow(t, sydStart, sydEnd))   return { name: "Sydney",   isKillZone: false };
  return { name: "Off-Hours", isKillZone: false };
}

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
  const fvgs = detectFVGs(candles);

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

  // ── Factor 1: Market Structure / BOS/CHoCH (max 1.5) ──
  // Scores structure breaks only. Trend direction is scored separately in Factor 19.
  {
    let pts = 0;
    let detail = "";
    if (config.enableStructureBreak !== false) {
      if (structure.choch.length > 0) {
        pts = 1.5;
        detail = `${structure.choch.length} CHoCH detected — trend reversal confirmed`;
      } else if (structure.bos.length > 0) {
        pts = 1.0;
        detail = `${structure.bos.length} BOS detected — trend continuation`;
      } else {
        detail = "No BOS or CHoCH detected";
      }
    } else {
      detail = "BOS/CHoCH disabled";
    }
    { const s = applyWeightScale(pts, "marketStructure", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Market Structure", present: pts > 0, weight: s.displayWeight, detail, group: "Market Structure" }); }
  }

  // Displacement detection (used by OB/FVG bonus + new factor below)
  const displacement = detectDisplacement(candles);
  tagDisplacementQuality(orderBlocks, fvgs, displacement.displacementCandles);

  // Breaker Blocks + Unicorn Setups (computed early, scored after direction)
  const breakerBlocks = config.useBreakerBlocks !== false ? detectBreakerBlocks(orderBlocks, candles) : [];
  const unicornSetups = config.useUnicornModel !== false ? detectUnicornSetups(breakerBlocks, fvgs) : [];

  // ── Factor 2: Order Block (max 2.0) ──
  // Displacement is scored ONLY via Factor 10 to avoid double-counting.
  // OBs are now quality-gated: body-based zones, structure-break required, recency-filtered, capped at 5.
  {
    let pts = 0;
    let detail = "";
    if (config.enableOB !== false) {
      const activeOBs = orderBlocks.filter(ob => !ob.mitigated);
      const insideOB = activeOBs.find(ob => lastPrice >= ob.low && lastPrice <= ob.high);
      if (insideOB) {
        pts = 2.0;
        const tags: string[] = [];
        if ((insideOB as any).hasDisplacement) tags.push("displacement");
        if ((insideOB as any).hasFVGAdjacency) tags.push("FVG adjacent");
        detail = `Price inside ${insideOB.type} OB (body) at ${insideOB.low.toFixed(5)}-${insideOB.high.toFixed(5)} (${insideOB.mitigatedPercent.toFixed(0)}% mitigated)`;
        if (tags.length > 0) detail += ` [${tags.join(", ")}]`;
      } else if (activeOBs.length > 0) {
        pts = 0.5;
        detail = `${activeOBs.length} quality-filtered OBs nearby (body zones, structure-break gated)`;
      }
    } else {
      detail = "Order Blocks disabled";
    }
    { const s = applyWeightScale(pts, "orderBlock", 2.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Order Block", present: pts > 0, weight: s.displayWeight, detail: detail || "No active order blocks", group: "Order Flow Zones" }); }
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

      // P1: filter FVGs by config — unfilled-only and minimum size
      const activeFVGs = fvgs.filter(f => {
        if (_onlyUnfilled && f.mitigated) return false;
        if (_minPips > 0) {
          const sizePips = (f.high - f.low) / _pipSize;
          if (sizePips < _minPips) return false;
        }
        return true;
      });
      const insideFVG = activeFVGs.find(f => lastPrice >= f.low && lastPrice <= f.high);
      if (insideFVG) {
        const ce = (insideFVG.high + insideFVG.low) / 2; // Consequent Encroachment
        const fvgRange = insideFVG.high - insideFVG.low;
        const distFromCE = Math.abs(lastPrice - ce);
        const nearCE = fvgRange > 0 && (distFromCE / fvgRange) <= 0.15; // within 15% of CE
        if (nearCE) {
          pts = 2.0;
          detail = `Price at CE (${ce.toFixed(5)}) of ${insideFVG.type} FVG ${insideFVG.low.toFixed(5)}-${insideFVG.high.toFixed(5)} — optimal entry`;
        } else {
          pts = 1.5;
          detail = `Price inside ${insideFVG.type} FVG at ${insideFVG.low.toFixed(5)}-${insideFVG.high.toFixed(5)} (CE: ${ce.toFixed(5)})`;
        }
        if ((insideFVG as any).hasDisplacement) {
          detail += " [displacement-created, scored via Factor 10]";
        }
      } else if (activeFVGs.length > 0) {
        pts = 0.5;
        detail = `${activeFVGs.length} qualifying FVGs in range${_minPips > 0 ? ` (≥${_minPips} pips)` : ""}`;
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

    // Use structure.trend as directional hint (direction variable isn't set yet)
    const fibDirection = structure.trend === "bullish" ? "long" : structure.trend === "bearish" ? "short" : null;

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

  // ── Factor 5: Kill Zone (max 1.0, +0.5 combo bonus if Silver Bullet overlap) ──
  // ICT: Kill zones are a timing filter — base 1.0 pts.
  const silverBullet = detectSilverBullet();
  {
    let pts = session.isKillZone ? 1.0 : 0;
    let detail = session.isKillZone ? `${session.name} Kill Zone — HIGH PROBABILITY window` : `${session.name} session — not in kill zone`;
    if (session.isKillZone && silverBullet.active && config.useSilverBullet !== false) {
      pts += 0.5;
      detail += ` + ${silverBullet.window} overlap (combo bonus)`;
    }
    { const s = applyWeightScale(pts, "sessionKillZone", 1.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Session/Kill Zone", present: pts > 0, weight: s.displayWeight, detail, group: "Timing" }); }
  }

  // ── Factor 6: Judas Swing (max 0.5) ──
  // ICT: Judas Swing is a confirmation signal, not a primary entry trigger.
  {
    let pts = 0;
    let detail = judasSwing.description;
    if (judasSwing.detected && judasSwing.confirmed) {
      if (session.isKillZone) {
        pts = 0.5;
        detail += " — during kill zone (confirmed)";
      } else {
        pts = 0.25;
        detail += " — outside kill zone (lower probability)";
      }
    } else if (judasSwing.detected) {
      pts = 0.1;
      detail += " (unconfirmed)";
    }
    { const s = applyWeightScale(pts, "judasSwing", 0.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Judas Swing", present: pts > 0, weight: s.displayWeight, detail, group: "Price Action" }); }
  }

  // ── Factor 7: PD/PW Levels (max 1.0) ──
  // ICT: PD/PW levels are primary draw-on-liquidity targets. Increased weight per audit.
  {
    let pts = 0;
    let detail = "No PD/PW levels";
    if (pdLevels) {
      const threshold = lastPrice * 0.002;
      const nearLevels = [
        { name: "PDH", price: pdLevels.pdh }, { name: "PDL", price: pdLevels.pdl },
        { name: "PWH", price: pdLevels.pwh }, { name: "PWL", price: pdLevels.pwl },
      ].filter(l => Math.abs(lastPrice - l.price) <= threshold);
      if (nearLevels.length > 0) {
        // Weekly levels are more significant than daily
        const nearWeekly = nearLevels.some(l => l.name.startsWith("PW"));
        pts = nearWeekly ? 1.0 : 0.75;
        detail = `Price near ${nearLevels.map(l => l.name).join(", ")} (${nearLevels[0].price.toFixed(5)})${nearWeekly ? " — weekly level (higher significance)" : ""}`;
      } else {
        detail = `PDH=${pdLevels.pdh.toFixed(5)}, PDL=${pdLevels.pdl.toFixed(5)}, PWH=${pdLevels.pwh.toFixed(5)}, PWL=${pdLevels.pwl.toFixed(5)}`;
      }
    }
    { const s = applyWeightScale(pts, "pdPwLevels", 1.0, config); pts = s.pts; score += pts;
    factors.push({ name: "PD/PW Levels", present: pts > 0, weight: s.displayWeight, detail, group: "Premium/Discount & Fib" }); }
  }

  // ── Factor 8: Reversal Candle (max 0.5) ──
  // ICT: reversal candles matter when they form at a key level (OB, FVG, PD/PW).
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
      if (atKeyLevel) {
        pts = 0.5;
        const levels: string[] = [];
        if (atOB) levels.push("OB");
        if (atFVG) levels.push("FVG");
        if (atPDPW) levels.push("PD/PW level");
        detail = `${reversalCandle.type} reversal at key level (${levels.join(", ")})`;
      } else {
        pts = 0.25;
        detail = `${reversalCandle.type} reversal candle detected but not at a key level`;
      }
    }
    { const s = applyWeightScale(pts, "reversalCandle", 0.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Reversal Candle", present: pts > 0, weight: s.displayWeight, detail, group: "Price Action" }); }
  }

  // ── Factor 9: Liquidity Sweep (max 1.0) ──
  // ICT: Liquidity sweeps are a cornerstone entry trigger. Increased weight per audit.
  {
    let pts = 0;
    let detail = "";
    if (config.enableLiquiditySweep !== false) {
      const sweptPool = liquidityPools.find(lp => lp.swept && lp.strength >= 2);
      if (sweptPool) {
        // Higher-strength pools (more touches) are more significant
        pts = sweptPool.strength >= 4 ? 1.0 : 0.75;
        detail = `${sweptPool.type} liquidity swept at ${sweptPool.price.toFixed(5)} (${sweptPool.strength} touches)${sweptPool.strength >= 4 ? " — strong pool" : ""}`;
      } else {
        detail = "No recent liquidity sweep";
      }
    } else {
      detail = "Liquidity Sweeps disabled";
    }
    { const s = applyWeightScale(pts, "liquiditySweep", 1.0, config); pts = s.pts; score += pts;
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

  // Determine direction
  let direction: "long" | "short" | null = null;
  if (structure.trend === "bullish" && pd.currentZone !== "premium") direction = "long";
  else if (structure.trend === "bearish" && pd.currentZone !== "discount") direction = "short";
  // Ranging market fallback: use premium/discount zone to pick direction
  else if (structure.trend === "ranging") {
    if (pd.currentZone === "discount") direction = "long";
    else if (pd.currentZone === "premium") direction = "short";
  }

  // ── Factor 19: Trend Direction — Entry TF (max 1.5) ──
  // Scores whether the entry timeframe trend aligns with the trade direction.
  // Penalizes counter-trend trades. Separate from BOS/CHoCH (Factor 1).
  if (config.useTrendDirection !== false) {
    let pts = 0;
    let detail = "";
    if (direction && structure.trend !== "ranging") {
      const trendAligned = (direction === "long" && structure.trend === "bullish")
        || (direction === "short" && structure.trend === "bearish");
      if (trendAligned) {
        pts = 1.5;
        detail = `Entry TF ${structure.trend} trend aligned with ${direction} direction`;
      } else {
        pts = -0.5;
        detail = `Counter-trend: ${direction} against ${structure.trend} trend (penalty)`;
      }
    } else if (direction && structure.trend === "ranging") {
      pts = 0.5;
      detail = `Ranging market — direction set via P/D zone fallback (${direction})`;
    } else {
      detail = "No direction determined — trend scoring skipped";
    }
    { const s = applyWeightScale(pts, "trendDirection", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Trend Direction", present: pts > 0, weight: s.displayWeight, detail, group: "Market Structure" }); }
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
  {
    let pts = 0;
    let detail = "No active breaker block aligned with signal";
    if (config.useBreakerBlocks !== false && direction && breakerBlocks.length > 0) {
      const wantType = direction === "long" ? "bullish_breaker" : "bearish_breaker";
      const aligned = breakerBlocks.find(b => b.type === wantType);
      if (aligned) {
        const mid = (aligned.high + aligned.low) / 2;
        const distPct = Math.abs(lastPrice - mid) / lastPrice;
        if (distPct <= 0.01) {
          pts = 1.0;
          detail = `Price near ${aligned.type.replace("_", " ")} at ${aligned.low.toFixed(5)}-${aligned.high.toFixed(5)}`;
        } else {
          detail = `${aligned.type.replace("_", " ")} exists at ${aligned.low.toFixed(5)}-${aligned.high.toFixed(5)} but price too far (${(distPct * 100).toFixed(2)}%)`;
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
      const aligned = unicornSetups.find(u => u.type === wantType
        && lastPrice >= u.overlapLow && lastPrice <= u.overlapHigh);
      if (aligned) {
        pts = 1.5;
        detail = `Unicorn: Breaker + FVG overlap at ${aligned.overlapLow.toFixed(5)}-${aligned.overlapHigh.toFixed(5)}`;
      } else {
        const anyAligned = unicornSetups.find(u => u.type === wantType);
        if (anyAligned) {
          detail = `Unicorn zone exists at ${anyAligned.overlapLow.toFixed(5)}-${anyAligned.overlapHigh.toFixed(5)} but price outside overlap`;
        }
      }
    } else if (config.useUnicornModel === false) {
      detail = "Unicorn Model disabled";
    }
    { const s = applyWeightScale(pts, "unicornModel", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Unicorn Model", present: pts > 0, weight: s.displayWeight, detail, group: "Order Flow Zones" }); }
  }

  // ── Factor 13: Silver Bullet Window (max 1.0) ──
  {
    let pts = 0;
    let detail = "Outside Silver Bullet macro window";
    if (config.useSilverBullet === false) {
      detail = "Silver Bullet disabled";
    } else if (silverBullet.active) {
      pts = 1.0;
      detail = `${silverBullet.window} active — ${silverBullet.minutesRemaining}min remaining (ICT macro window)`;
    }
    { const s = applyWeightScale(pts, "silverBullet", 1.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Silver Bullet", present: pts > 0, weight: s.displayWeight, detail, group: "Timing" }); }
  }

  // ── Factor 14: ICT Macro Window (max 1.0; 0.5 base + 0.5 combo with Silver Bullet) ──
  const macroWindow = detectMacroWindow();
  {
    let pts = 0;
    let detail = "Outside ICT macro reprice window";
    if (config.useMacroWindows === false) {
      detail = "Macro Windows disabled";
    } else if (macroWindow.active) {
      pts = 0.5;
      detail = `${macroWindow.window} active — ${macroWindow.minutesRemaining}min remaining`;
      if (silverBullet.active && config.useSilverBullet !== false) {
        pts += 0.5;
        detail += ` + ${silverBullet.window} overlap (combo bonus)`;
      }
    }
    { const s = applyWeightScale(pts, "macroWindow", 1.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Macro Window", present: pts > 0, weight: s.displayWeight, detail, group: "Timing" }); }
  }

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
      pts = Math.min(1.5, pts);
    }
    { const s = applyWeightScale(pts, "volumeProfile", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Volume Profile", present: pts > 0, weight: s.displayWeight, detail, group: "Volume Profile" }); }
  }

  // Retain VWAP calculation for backward compatibility (not scored)
  const _vwapSymbol = config._currentSymbol || "EUR/USD";
  const _vwapPipSize = (SPECS[_vwapSymbol] || SPECS["EUR/USD"]).pipSize;
  const vwap = calculateAnchoredVWAP(candles, _vwapPipSize);

  // ── Factor 17: AMD Phase (max 1.0; 0.5 if bias aligned, +0.5 if in distribution phase) ──
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
    { const s = applyWeightScale(pts, "amdPhase", 1.0, config); pts = s.pts; score += pts;
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
    if (fotsi && direction && config.useFOTSI !== false) {
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

  // ── Factor 20: Daily Bias / HTF Trend (max 1.5) ──
  // Scores whether the daily timeframe trend aligns with the trade direction.
  // Promoted from safety gate to scored factor — trend alignment is a core confluence.
  if (config.useDailyBias !== false) {
    let pts = 0;
    let detail = "";
    if (dailyCandles && dailyCandles.length >= 20 && direction) {
      const dailyStructure = analyzeMarketStructure(dailyCandles);
      const dailyTrend = dailyStructure.trend;
      if (dailyTrend !== "ranging") {
        const htfAligned = (direction === "long" && dailyTrend === "bullish")
          || (direction === "short" && dailyTrend === "bearish");
        if (htfAligned) {
          pts = 1.5;
          detail = `Daily ${dailyTrend} trend aligned with ${direction} — high conviction`;
        } else {
          pts = -0.5;
          detail = `Counter-HTF: ${direction} against daily ${dailyTrend} trend (penalty)`;
        }
      } else {
        pts = 0.5;
        detail = `Daily trend ranging — partial credit (no HTF directional bias)`;
      }
    } else if (!dailyCandles || dailyCandles.length < 20) {
      detail = "Daily candles unavailable — HTF bias skipped";
    } else {
      detail = "No direction determined — HTF bias skipped";
    }
    { const s = applyWeightScale(pts, "dailyBias", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Daily Bias", present: pts > 0, weight: s.displayWeight, detail, group: "Daily Bias" }); }
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

    // Rule 4: Silver Bullet fires → absorbs Kill Zone (not additive)
    const sb = findFactor("Silver Bullet");
    const kz = findFactor("Session/Kill Zone");
    if (sb && sb.present && kz && kz.present) {
      score -= kz.weight;
      kz.weight = 0;
      kz.detail += " [zeroed: absorbed by Silver Bullet]";
      // Boost SB to 1.5 to absorb the timing value
      const sbBoost = 0.5;
      sb.weight = Math.min(1.5, sb.weight + sbBoost);
      score += sbBoost;
      sb.detail += " [boosted: absorbed Kill Zone timing]";
    }

    // Rule 5: AMD distribution + sweep → absorbs Judas
    const amdFactor = findFactor("AMD Phase");
    const judas = findFactor("Judas Swing");
    const sweep = findFactor("Liquidity Sweep");
    if (amdFactor && amdFactor.present && sweep && sweep.present && judas && judas.present) {
      score -= judas.weight;
      judas.weight = 0;
      judas.detail += " [zeroed: absorbed by AMD + Sweep sequence]";
    }

    // Rule 6: Macro during Kill Zone → Macro reduced to 0.25
    const macro = findFactor("Macro Window");
    if (macro && macro.present && kz && kz.present && kz.weight > 0) {
      // Only reduce if Kill Zone wasn't already zeroed by SB
      adjustFactor("Macro Window", 0.25, "Kill Zone already scoring timing");
    }
  }

  // ─── Power of 3 Combo Bonus (+1.0) ─────────────────────────────────────────
  // ICT Power of 3: Consolidation (accumulation) → Fakeout (manipulation/Judas) → Trend (distribution)
  // Awards +1.0 when AMD phase is distribution + sweep/Judas confirmed + trend direction aligned.
  {
    const findFactor = (name: string) => factors.find(f => f.name === name);
    const amdF = findFactor("AMD Phase");
    const sweepF = findFactor("Liquidity Sweep");
    const judasF = findFactor("Judas Swing");
    const trendF = findFactor("Trend Direction");

    const amdPresent = amdF && amdF.present;
    const sweepOrJudas = (sweepF && sweepF.present) || (judasF && judasF.present);
    const trendAligned = trendF && trendF.present;

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
        detail: `Incomplete: AMD=${amdPresent ? "✓" : "✗"} Sweep/Judas=${sweepOrJudas ? "✓" : "✗"} Trend=${trendAligned ? "✓" : "✗"}`,
        group: "AMD / Power of 3",
      });
    }
  }

  // ─── Group Caps Enforcement ─────────────────────────────────────────────────
  // Each factor group has a hard cap to prevent any single group from dominating.
  {
    const GROUP_CAPS: Record<string, number> = {
      "Market Structure": 3.0,
      "Daily Bias": 1.5,
      "Order Flow Zones": 3.0,
      "Premium/Discount & Fib": 2.5,
      "Timing": 1.5,
      "Price Action": 2.0,
      "AMD / Power of 3": 1.5,
      "Macro Confirmation": 2.0,
      "Volume Profile": 1.5,
    };

    // Sum weights per group
    const groupTotals: Record<string, number> = {};
    for (const f of factors) {
      if (f.present && f.group) {
        groupTotals[f.group] = (groupTotals[f.group] || 0) + f.weight;
      }
    }

    // Apply caps — if a group exceeds its cap, proportionally reduce its factors
    for (const [group, cap] of Object.entries(GROUP_CAPS)) {
      const total = groupTotals[group] || 0;
      if (total > cap) {
        const excess = total - cap;
        score -= excess;
        // Proportionally reduce each factor in the group
        const groupFactors = factors.filter(f => f.group === group && f.present && f.weight > 0);
        const scaleFactor = cap / total;
        for (const f of groupFactors) {
          const newWeight = Math.round(f.weight * scaleFactor * 100) / 100;
          f.weight = newWeight;
          f.detail += ` [group-capped: ${group} limited to ${cap}]`;
        }
      }
    }
  }

  // ─── Regime-Aware Scoring (Factor 21: Market Regime Alignment) ──────
  // Uses dailyCandles to classify the instrument's current regime, then
  // applies a small penalty or bonus based on setup-regime alignment.
  // This runs AFTER group caps but BEFORE the final 0-10 clamp.
  // Controlled by config.regimeScoringEnabled (default true) and
  // config.regimeScoringStrength (multiplier, default 1.0).
  const regimeScoringEnabled = config.regimeScoringEnabled !== false;
  const regimeScoringStrength = typeof config.regimeScoringStrength === 'number' ? config.regimeScoringStrength : 1.0;
  let regimeInfo: { regime: string; confidence: number; atrTrend: string; bias: string } | null = null;
  {
    if (regimeScoringEnabled && dailyCandles && dailyCandles.length >= 20) {
      regimeInfo = classifyInstrumentRegimeLocal(dailyCandles);
      const { adjustment, detail } = regimeAlignmentAdjustment(
        regimeInfo.regime, regimeInfo.confidence, direction, factors
      );
      const scaledAdjustment = +(adjustment * regimeScoringStrength).toFixed(2);
      if (scaledAdjustment !== 0) {
        score += scaledAdjustment;
      }
      factors.push({
        name: "Regime Alignment",
        present: scaledAdjustment !== 0,
        weight: scaledAdjustment,
        detail: `${regimeInfo.regime.replace("_", " ")} (${(regimeInfo.confidence * 100).toFixed(0)}% conf, ATR ${regimeInfo.atrTrend}, bias ${regimeInfo.bias}) — ${detail}${regimeScoringStrength !== 1.0 ? ` [strength ${regimeScoringStrength}x]` : ''}`,
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

  score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));

  // Calculate SL/TP using configurable methods
  const symbolForSL = config._currentSymbol || "EUR/USD";
  const specSL = SPECS[symbolForSL] || SPECS["EUR/USD"];
  const pipSize = specSL.pipSize;
  const swings = structure.swingPoints;

  // Compute ATR for ATR-based methods (use entry candles)
  const atrValue = calculateATR(candles, config.slATRPeriod || 14);

  const { stopLoss, takeProfit } = calculateSLTP({
    direction, lastPrice, pipSize, config, swings, orderBlocks, liquidityPools, pdLevels, atrValue,
  });

  const presentFactors = factors.filter(f => f.present);
  const bias = direction === "long" ? "bullish" : direction === "short" ? "bearish" : "neutral";

  // Build grouped summary for the new 9-group structure
  const groupNames = [...new Set(factors.filter(f => f.group).map(f => f.group!))];
  const activeGroups = groupNames.filter(g => factors.some(f => f.group === g && f.present));
  const groupSummaryParts = activeGroups.map(g => {
    const gFactors = factors.filter(f => f.group === g && f.present);
    return `${g}: ${gFactors.map(f => f.name).join("+")}`;
  });

  const fotsiSummary = _fotsiAlignment ? ` | FOTSI: ${_fotsiAlignment.label}` : "";
  const summary = direction
    ? `${direction === "long" ? "BUY" : "SELL"}: ${presentFactors.length}/${factors.length} factors aligned across ${activeGroups.length}/9 groups (score: ${score}/10). ${groupSummaryParts.join(" | ")}${fotsiSummary}`
    : `No signal: ${presentFactors.length}/${factors.length} factors across ${activeGroups.length}/9 groups (score: ${score}/10)${fotsiSummary}`;

  return {
    score, direction, bias, summary, factors,
    structure, orderBlocks, fvgs, liquidityPools, judasSwing, reversalCandle,
    pd, session, pdLevels, lastPrice, stopLoss, takeProfit, displacement, breakerBlocks, unicornSetups, silverBullet, macroWindow, smt: smtResult, vwap, amd,
    fotsiAlignment: _fotsiAlignment, volumeProfile, regimeInfo,
  };
}
// ─── Lightweight Regime Classification (for real-time scoring) ──────
// Uses dailyCandles already available in the scoring function.
// Returns a regime label + confidence so the scorer can apply a penalty/bonus.
// H7: classifyInstrumentRegime is now imported from _shared/smcAnalysis.ts
// Thin wrapper to preserve the scanner's existing return shape { regime, confidence, atrTrend, bias }
function classifyInstrumentRegimeLocal(dailyCandles: Candle[]): { regime: string; confidence: number; atrTrend: string; bias: string } {
  const result = classifyInstrumentRegime(dailyCandles);
  return {
    regime: result.regime,
    confidence: result.confidence,
    atrTrend: result.atrTrend,
    bias: result.directionalBias,
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
  });
  return result.candles;
}

// ─── Quote-to-USD conversion (local copy matching shared/smcAnalysis.ts) ──
function getQuoteToUSDRate(symbol: string, rateMap?: Record<string, number>): number {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  if (spec.type !== "forex") return 1.0;
  const parts = symbol.split("/");
  if (parts.length !== 2) return 1.0;
  const quote = parts[1];
  if (quote === "USD") return 1.0;
  if (!rateMap) return 1.0;
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
  const rate = rateMap[conv.pair];
  if (!rate || rate <= 0) return 1.0;
  return conv.invert ? (1 / rate) : rate;
}

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
  const maxLot = fallbackMaxLot ?? (spec.type === "index" ? 50 : spec.type === "commodity" ? 10 : spec.type === "crypto" ? 100 : 5);
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
  if (!data?.config_json) return { ...DEFAULTS, enableOB: true, enableFVG: true, enableLiquiditySweep: true, enableStructureBreak: true, cooldownMinutes: 0, closeOnReverse: false, trailingStopEnabled: false, partialTPEnabled: false, maxHoldHours: 0, killZoneOnly: false, maxConsecutiveLosses: 0, protectionMaxDailyLossDollar: 0 };

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
    minConfluence: strategy.confluenceThreshold ?? strategy.minConfluenceScore ?? raw.minConfluence ?? DEFAULTS.minConfluence,
    // New: minimum count of present factors required (0 = off). Acts as an AND gate alongside score.
    minFactorCount: strategy.minFactorCount ?? raw.minFactorCount ?? 0,
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
    maxHoldHours: exit.timeExitHours ?? exit.maxHoldHours ?? 0,

    // ── Instruments ──
    // Priority: 1) instruments.enabled array (current UI, including explicit empty array), 2) allowedInstruments map (legacy), 3) defaults
    instruments: Array.isArray(instruments.enabled)
      ? instruments.enabled
      : enabledInstrumentList
        ? enabledInstrumentList
        : (Array.isArray(raw.instruments) ? raw.instruments : DEFAULTS.instruments),

    // ── Sessions ──
    enabledSessions: (Array.isArray(sessions.filter) && sessions.filter.length > 0
      ? sessions.filter.map((s: string) => s.toLowerCase().replace(/\s+/g, ""))
      : sessions.asianEnabled !== undefined
        ? [
            ...(sessions.asianEnabled ? ["asian"] : []),
            ...(sessions.londonEnabled ? ["london"] : []),
            ...(sessions.newYorkEnabled || sessions.newyorkEnabled ? ["newyork"] : []),
            ...(sessions.sydneyEnabled ? ["sydney"] : []),
          ]
        : (Array.isArray(raw.enabledSessions) ? raw.enabledSessions.map((s: string) => s.toLowerCase().replace(/\s+/g, "")) : DEFAULTS.enabledSessions)
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
  };

  return merged;
}

// ─── Safety Gates ───────────────────────────────────────────────────

async function runSafetyGates(
  supabase: any, userId: string, symbol: string, direction: string,
  analysis: any, config: typeof DEFAULTS, account: any, openPositions: any[],
  dailyCandles: Candle[] | null,
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
    const pairSpec = SPECS[pair] || SPECS["EUR/USD"];
    const spreadCostInPrice = (pairSpec.typicalSpread ?? 1) * pairSpec.pipSize;
    // Estimate commission cost in price terms: commissionPerLot / (lotUnits * quoteToUSD)
    // This converts the dollar commission into price-movement equivalent
    const quoteToUSD = getQuoteToUSDRate(pair, rateMap);
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
      const result = await runScanForUser(adminClient, userId);
      return respond(result);
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

    return respond({ error: "Unknown action" }, 400);
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function runScanForUser(supabase: any, userId: string) {
  const specCache: Record<string, { minVolume: number; maxVolume: number; volumeStep: number }> = {};
  const balanceCache: Record<string, number> = {};
  const MAX_BROKER_RISK_PERCENT = 5; // hard safety cap per broker per trade
  const scanCycleId = crypto.randomUUID();

  // ── Scan overlap lock (90s lease) ──
  // Prevents two cron invocations from racing — second cycle would otherwise see the first's
  // in-flight trades as orphans or double-process the same signals.
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
  const nyHour = toNYTime(now).t;
  const utcDay = now.getUTCDay(); // 0=Sun
  const isFxOpenSundayEvening = utcDay === 0 && nyHour >= 17;
  const isFxClosedFridayEvening = utcDay === 5 && nyHour >= 17;
  const effectiveDay = isFxOpenSundayEvening ? 1 : utcDay; // pretend Sunday-evening is Monday
  const hasCrypto = config.instruments.some((s: string) => SPECS[s]?.type === "crypto");
  const hasNonCrypto = config.instruments.some((s: string) => SPECS[s]?.type !== "crypto");
  if (!config.enabledDays.includes(effectiveDay) && !hasCrypto) {
    return { pairsScanned: 0, signalsFound: 0, tradesPlaced: 0, skippedReason: "Day not enabled", activeStyle: resolvedStyle };
  }

  const session = detectSession(config);
  // Session filter: normalize names for comparison
  const sessionNameMap: Record<string, string> = { "Asian": "asian", "London": "london", "New York": "newyork", "Sydney": "sydney", "Off-Hours": "off-hours" };
  const normalizedSession = sessionNameMap[session.name] || session.name.toLowerCase();
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

  const { data: openPositions } = await supabase.from("paper_positions").select("*")
    .eq("user_id", userId).eq("position_status", "open");
  // Filter to only this bot's positions (bot_id column or legacy without it)
  const openPosArr = (openPositions || []).filter((p: any) => !p.bot_id || p.bot_id === BOT_ID);

  // ── Active Trade Management: manage existing positions before scanning for new ones ──
  let managementActions: ManagementAction[] = [];
  if (openPosArr.length > 0) {
    try {
      managementActions = await manageOpenPositions(supabase, openPosArr, config, scanCycleId, fetchCandles, detectSession);
      const activeActions = managementActions.filter(a => a.action !== "no_change");
      if (activeActions.length > 0) {
        console.log(`[scan ${scanCycleId}] Trade management: ${activeActions.length} actions taken on ${openPosArr.length} positions`);
        for (const a of activeActions) {
          console.log(`  [mgmt] ${a.symbol}: ${a.action} — ${a.reason}`);
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
    // Batch fetch daily candles for all 28 FOTSI pairs in parallel (groups of 7 to avoid rate limits)
    for (let i = 0; i < fotsiPairs.length; i += 7) {
      const batch = fotsiPairs.slice(i, i + 7);
      const batchResults = await Promise.all(
        batch.map(p => fetchCandles(p, "1d", "6mo").catch(() => [] as any[]))
      );
      for (let j = 0; j < batch.length; j++) {
        if (batchResults[j] && batchResults[j].length >= 30) {
          fotsiCandleMap[batch[j]] = batchResults[j];
        }
      }
      // Small delay between batches to avoid rate limiting
      if (i + 7 < fotsiPairs.length) await new Promise(r => setTimeout(r, 300));
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
    const coreSessionsEnabled = ["asian", "london", "newyork"].every(s => config.enabledSessions.includes(s));
    const offHoursImplicitlyAllowed = normalizedSession === "off-hours" && coreSessionsEnabled;
    if (!pairAssetProfile.skipSessionGate && config.enabledSessions.length > 0 && !config.enabledSessions.includes(normalizedSession) && !offHoursImplicitlyAllowed) {
      scanDetails.push({ pair, status: "skipped", reason: `${session.name} session not enabled for ${pair}` });
      continue;
    }

    // Skip non-crypto instruments on weekends (Fri 17:00 ET → Sun 17:00 ET).
    const fxIsClosed = (utcDay === 6) || (utcDay === 0 && nyHour < 17) || (utcDay === 5 && nyHour >= 17);
    if (fxIsClosed && SPECS[pair]?.type !== "crypto") {
      scanDetails.push({ pair, status: "skipped", reason: "FX market closed (weekend)" });
      continue;
    }

    // Delay between instruments to avoid rate limiting
    if (scanDetails.length > 0) await new Promise(r => setTimeout(r, 500));

    // Clone config per-instrument to prevent style mutation (Fix #6)
    let pairConfig = { ...config };

    // Determine entry TF based on style
    const entryInterval = getYahooInterval(pairConfig.entryTimeframe);
    const entryRange = getYahooRange(pairConfig.entryTimeframe);

    // Fetch entry TF, daily, optionally 1h, and SMT correlated pair candles in parallel
    const orFlag = pairConfig.openingRange?.enabled ? 1 : 0;
    const smtPair = pairConfig.useSMT !== false ? SMT_PAIRS[pair] : undefined;
    const smtFlag = smtPair && YAHOO_SYMBOLS[smtPair] ? 1 : 0;
    const fetchPromises: Promise<Candle[]>[] = [
      fetchCandles(pair, entryInterval, entryRange),
      fetchCandles(pair, "1d", "1y"),
    ];
    if (orFlag) fetchPromises.push(fetchCandles(pair, "1h", "2d"));
    if (smtFlag) fetchPromises.push(fetchCandles(smtPair!, entryInterval, entryRange));
    const fetched = await Promise.all(fetchPromises);
    const candles = fetched[0];
    const dailyCandles = fetched[1];
    const hourlyCandles = orFlag ? fetched[2] : undefined;
    const smtCandles = smtFlag ? fetched[2 + orFlag] : null;

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
      factors: analysis.factors,
      // ── analysis_snapshot: per-factor + new-factor breakdown for dashboard ──
      analysis_snapshot: {
        factorScores: analysis.factors.map((f: any) => ({ name: f.name, weight: f.weight, present: f.present, detail: f.detail })),
        displacement: analysis.displacement ? { isDisplacement: analysis.displacement.isDisplacement, lastDirection: analysis.displacement.lastDirection } : null,
        breakerBlocks: (analysis.breakerBlocks || []).length,
        unicornSetups: (analysis.unicornSetups || []).length,
        silverBullet: analysis.silverBullet || null,
        macroWindow: analysis.macroWindow || null,
        smt: analysis.smt || null,
        vwap: analysis.vwap ? { value: analysis.vwap.value, distancePips: analysis.vwap.distancePips, rejection: analysis.vwap.rejection } : null,
        amd: analysis.amd || null,
        fotsi: analysis.fotsiAlignment || null,
      },
      status: "analyzed",
      tradingStyle: resolvedStyle,
      setupClassification: {
        setupType: setupClassification.setupType,
        confidence: setupClassification.confidence,
        rationale: setupClassification.rationale,
        executionProfile: setupClassification.executionProfile,
      },
    };

    const minFactorGate = (pairConfig.minFactorCount ?? 0) > 0;
    const factorCountOk = !minFactorGate || (detail.factorCount >= (pairConfig.minFactorCount ?? 0));

    if (analysis.score >= adjustedMinConfluence && factorCountOk && analysis.direction && !isPaused) {
      signalsFound++;

      // Run safety gates
      const gates = await runSafetyGates(
        supabase, userId, pair, analysis.direction,
        analysis, pairConfig, account, openPosArr, dailyCandles.length >= 10 ? dailyCandles : null,
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
          maxHoldHours: pairConfig.maxHoldHours,
          tpRatio: pairConfig.tpRatio,
        };

        // Place position
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
          signal_reason: JSON.stringify({ bot: BOT_ID, summary: analysis.summary, setupType: setupClassification.setupType, setupConfidence: setupClassification.confidence, setupRationale: setupClassification.rationale, exitFlags, spreadFilter: { enabled: pairConfig.spreadFilterEnabled, maxPips: pairConfig.maxSpreadPips }, newsFilter: { enabled: pairConfig.newsFilterEnabled, pauseMinutes: pairConfig.newsFilterPauseMinutes }, fotsi: analysis.fotsiAlignment ? { base: analysis.fotsiAlignment.baseTSI, quote: analysis.fotsiAlignment.quoteTSI, spread: analysis.fotsiAlignment.spread, score: analysis.fotsiAlignment.score, label: analysis.fotsiAlignment.label } : null }),
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
          summary: `[${setupClassification.setupType.toUpperCase()}] ${analysis.summary}`,
          bias: analysis.bias,
          session: analysis.session.name,
          timeframe: pairConfig.entryTimeframe,
          factors_json: analysis.factors,
        });

        tradesPlaced++;
        detail.status = "trade_placed";
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
            `<b>Summary:</b> ${analysis.summary || "—"}`;
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
      if (analysis.score < config.minConfluence) {
        detail.status = "below_threshold";
      } else if (minFactorGate && !factorCountOk) {
        detail.status = "below_threshold";
        detail.reason = `Only ${detail.factorCount}/${analysis.factors.length} factors (need ≥${pairConfig.minFactorCount})`;
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
    },
    ...scanDetails,
  ];
  console.log(`[scan ${scanCycleId}] Primary candle source: ${sourceTally.primary} (meta=${sourceTally.metaapi}, td=${sourceTally.twelvedata}, yahoo=${sourceTally.yahoo}, none=${sourceTally.none})`);

  // Log the scan
  await supabase.from("scan_logs").insert({
    user_id: userId,
    pairs_scanned: config.instruments.length,
    signals_found: signalsFound,
    trades_placed: tradesPlaced,
    details_json: detailsWithMeta,
  });

  return { pairsScanned: config.instruments.length, signalsFound, tradesPlaced, rejected: rejectedCount, details: scanDetails, activeStyle: resolvedStyle, scanCycleId, managementActions: managementActions.filter(a => a.action !== "no_change") };
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
