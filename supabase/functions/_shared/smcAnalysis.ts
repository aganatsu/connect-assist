/**
 * _shared/smcAnalysis.ts — Shared SMC (Smart Money Concepts) analysis module
 * ──────────────────────────────────────────────────────────────────────────
 * Extracted from bot-scanner so both the live scanner AND the backtester
 * use the exact same detection logic. No drift, no re-implementation.
 *
 * Exports:
 *   Types:       Candle, SwingPoint, OrderBlock, FairValueGap, LiquidityPool,
 *                BreakerBlock, UnicornSetup, DisplacementResult, SMTResult,
 *                VWAPResult, AMDResult, SilverBulletResult, MacroWindowResult,
 *                ReasoningFactor, GateResult, SLTPInput
 *   Detection:   detectSwingPoints, analyzeMarketStructure, detectOrderBlocks,
 *                detectFVGs, detectLiquidityPools, detectDisplacement,
 *                tagDisplacementQuality, detectBreakerBlocks, detectUnicornSetups,
 *                detectJudasSwing, detectReversalCandle, calculatePDLevels,
 *                calculatePremiumDiscount, computeOpeningRange,
 *                detectSMTDivergence, calculateAnchoredVWAP, calculateATR,
 *                detectAMDPhase, detectSilverBullet, detectMacroWindow,
 *                detectSession, detectOptimalStyle
 *   Helpers:     toNYTime, calculateSLTP, calculatePositionSize, getQuoteToUSDRate
 *   Constants:   SPECS, YAHOO_SYMBOLS, SMT_PAIRS, ASSET_PROFILES,
 *                STYLE_OVERRIDES, DEFAULTS
 */

// ─── Types ──────────────────────────────────────────────────────────
export interface Candle {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface SwingPoint {
  index: number;
  price: number;
  type: "high" | "low";
  datetime: string;
}

export interface OrderBlock {
  index: number;
  high: number;
  low: number;
  type: "bullish" | "bearish";
  datetime: string;
  mitigated: boolean;
  mitigatedPercent: number;
  hasDisplacement?: boolean;
  hasFVGAdjacency?: boolean;
}

export interface FairValueGap {
  index: number;
  high: number;
  low: number;
  type: "bullish" | "bearish";
  datetime: string;
  mitigated: boolean;
  hasDisplacement?: boolean;
}

export interface LiquidityPool {
  price: number;
  type: "buy-side" | "sell-side";
  strength: number;
  datetime: string;
  swept: boolean;
  sweptAtIndex?: number;
  rejectionConfirmed?: boolean;
}

export interface BreakerBlock {
  type: "bullish_breaker" | "bearish_breaker";
  high: number;
  low: number;
  mitigatedAt: number;
  originalOBType: "bullish" | "bearish";
  isActive: boolean;
}

export interface UnicornSetup {
  type: "bullish_unicorn" | "bearish_unicorn";
  breakerHigh: number;
  breakerLow: number;
  fvgHigh: number;
  fvgLow: number;
  overlapHigh: number;
  overlapLow: number;
}

export interface DisplacementCandle {
  index: number;
  bodyRatio: number;
  rangeMultiple: number;
  direction: "bullish" | "bearish";
}

export interface DisplacementResult {
  isDisplacement: boolean;
  displacementCandles: DisplacementCandle[];
  lastDirection: "bullish" | "bearish" | null;
}

export interface SMTResult {
  detected: boolean;
  type: "bullish" | "bearish" | null;
  correlatedPair: string | null;
  detail: string;
}

export interface VWAPResult {
  value: number | null;
  distancePips: number | null;
  rejection: "bullish" | "bearish" | null;
  barsAnchored: number;
}

export interface AMDResult {
  phase: "accumulation" | "manipulation" | "distribution" | "unknown";
  bias: "bullish" | "bearish" | null;
  asianHigh: number | null;
  asianLow: number | null;
  sweptSide: "high" | "low" | null;
  detail: string;
}

export interface SilverBulletResult {
  active: boolean;
  window: string | null;
  minutesRemaining: number;
}

export interface MacroWindowResult {
  active: boolean;
  window: string | null;
  minutesRemaining: number;
}

export interface ReasoningFactor {
  name: string;
  present: boolean;
  weight: number;
  detail: string;
  group?: string;
}

export interface GateResult {
  passed: boolean;
  reason: string;
}

export interface SLTPInput {
  direction: "long" | "short" | null;
  lastPrice: number;
  pipSize: number;
  config: any;
  swings: SwingPoint[];
  orderBlocks: OrderBlock[];
  liquidityPools: LiquidityPool[];
  pdLevels: any;
  atrValue: number;
}

export interface OpeningRangeResult {
  high: number;
  low: number;
  midpoint: number;
  completed: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────
// maxSpread: maximum acceptable spread in pips before skipping execution
// typicalSpread: average spread in pips used for R:R cost estimation at gate time
export const SPECS: Record<string, { pipSize: number; lotUnits: number; type: string; marginPerLot?: number; maxSpread: number; typicalSpread: number }> = {
  // Forex Majors — tight spreads
  "EUR/USD": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 1000, maxSpread: 2, typicalSpread: 1.0 },
  "GBP/USD": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 1000, maxSpread: 3, typicalSpread: 1.5 },
  "USD/JPY": { pipSize: 0.01, lotUnits: 100000, type: "forex", marginPerLot: 1000, maxSpread: 2, typicalSpread: 1.0 },
  "AUD/USD": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 800, maxSpread: 3, typicalSpread: 1.5 },
  "NZD/USD": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 700, maxSpread: 3, typicalSpread: 2.0 },
  "USD/CAD": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 1000, maxSpread: 3, typicalSpread: 1.5 },
  "USD/CHF": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 1000, maxSpread: 3, typicalSpread: 1.5 },
  // Forex Crosses — moderate spreads
  "EUR/GBP": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 1200, maxSpread: 4, typicalSpread: 2.0 },
  "EUR/JPY": { pipSize: 0.01, lotUnits: 100000, type: "forex", marginPerLot: 1200, maxSpread: 4, typicalSpread: 2.0 },
  "GBP/JPY": { pipSize: 0.01, lotUnits: 100000, type: "forex", marginPerLot: 1500, maxSpread: 5, typicalSpread: 3.0 },
  "EUR/AUD": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 1200, maxSpread: 4, typicalSpread: 2.5 },
  "EUR/CAD": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 1200, maxSpread: 4, typicalSpread: 2.5 },
  "EUR/CHF": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 1200, maxSpread: 4, typicalSpread: 2.0 },
  "EUR/NZD": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 1200, maxSpread: 5, typicalSpread: 3.0 },
  "GBP/AUD": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 1500, maxSpread: 5, typicalSpread: 3.5 },
  "GBP/CAD": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 1500, maxSpread: 5, typicalSpread: 3.0 },
  "GBP/CHF": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 1500, maxSpread: 5, typicalSpread: 3.0 },
  "GBP/NZD": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 1500, maxSpread: 6, typicalSpread: 4.0 },
  "AUD/CAD": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 800, maxSpread: 4, typicalSpread: 2.5 },
  "AUD/JPY": { pipSize: 0.01, lotUnits: 100000, type: "forex", marginPerLot: 800, maxSpread: 4, typicalSpread: 2.0 },
  "CAD/JPY": { pipSize: 0.01, lotUnits: 100000, type: "forex", marginPerLot: 1000, maxSpread: 4, typicalSpread: 2.5 },
  // Indices — point-based spreads
  "US30": { pipSize: 1.0, lotUnits: 1, type: "index", marginPerLot: 5000, maxSpread: 3, typicalSpread: 2.0 },
  "NAS100": { pipSize: 0.25, lotUnits: 1, type: "index", marginPerLot: 3000, maxSpread: 2, typicalSpread: 1.0 },
  "SPX500": { pipSize: 0.25, lotUnits: 1, type: "index", marginPerLot: 3000, maxSpread: 2, typicalSpread: 1.0 },
  // Commodities
  "XAU/USD": { pipSize: 0.01, lotUnits: 100, type: "commodity", marginPerLot: 2000, maxSpread: 5, typicalSpread: 3.0 },
  "XAG/USD": { pipSize: 0.001, lotUnits: 5000, type: "commodity", marginPerLot: 1500, maxSpread: 4, typicalSpread: 2.5 },
  "US Oil": { pipSize: 0.01, lotUnits: 1000, type: "commodity", marginPerLot: 2000, maxSpread: 5, typicalSpread: 3.0 },
  // Crypto — wider spreads
  "BTC/USD": { pipSize: 1, lotUnits: 1, type: "crypto", marginPerLot: 5000, maxSpread: 50, typicalSpread: 20.0 },
  "ETH/USD": { pipSize: 0.01, lotUnits: 1, type: "crypto", marginPerLot: 1000, maxSpread: 5, typicalSpread: 2.0 },
};

export const YAHOO_SYMBOLS: Record<string, string> = {
  "EUR/USD": "EURUSD=X", "GBP/USD": "GBPUSD=X", "USD/JPY": "USDJPY=X",
  "AUD/USD": "AUDUSD=X", "NZD/USD": "NZDUSD=X", "USD/CAD": "USDCAD=X",
  "USD/CHF": "USDCHF=X",
  "EUR/GBP": "EURGBP=X", "EUR/JPY": "EURJPY=X", "GBP/JPY": "GBPJPY=X",
  "EUR/AUD": "EURAUD=X", "EUR/CAD": "EURCAD=X", "EUR/CHF": "EURCHF=X",
  "EUR/NZD": "EURNZD=X", "GBP/AUD": "GBPAUD=X", "GBP/CAD": "GBPCAD=X",
  "GBP/CHF": "GBPCHF=X", "GBP/NZD": "GBPNZD=X", "AUD/CAD": "AUDCAD=X",
  "AUD/JPY": "AUDJPY=X", "CAD/JPY": "CADJPY=X",
  "AUD/CHF": "AUDCHF=X", "AUD/NZD": "AUDNZD=X", "CAD/CHF": "CADCHF=X",
  "CHF/JPY": "CHFJPY=X", "NZD/CAD": "NZDCAD=X", "NZD/CHF": "NZDCHF=X",
  "NZD/JPY": "NZDJPY=X",
  "US30": "YM=F", "NAS100": "NQ=F", "SPX500": "ES=F",
  "XAU/USD": "GC=F", "XAG/USD": "SI=F", "US Oil": "CL=F",
  "BTC/USD": "BTC-USD", "ETH/USD": "ETH-USD",
};

export const SMT_PAIRS: Record<string, string> = {
  "EUR/USD": "GBP/USD", "GBP/USD": "EUR/USD",
  "USD/JPY": "USD/CHF", "USD/CHF": "USD/JPY",
  "AUD/USD": "NZD/USD", "NZD/USD": "AUD/USD",
  "XAU/USD": "XAG/USD", "XAG/USD": "XAU/USD",
  "BTC/USD": "ETH/USD", "ETH/USD": "BTC/USD",
};

export const ASSET_PROFILES: Record<string, { slBufferMultiplier: number; proximityMultiplier: number; skipSessionGate: boolean; minConfluenceAdj: number }> = {
  forex:     { slBufferMultiplier: 1.0, proximityMultiplier: 1.0, skipSessionGate: false, minConfluenceAdj: 0 },
  index:     { slBufferMultiplier: 3.0, proximityMultiplier: 2.0, skipSessionGate: false, minConfluenceAdj: 0 },
  commodity: { slBufferMultiplier: 2.0, proximityMultiplier: 1.5, skipSessionGate: false, minConfluenceAdj: 0 },
  crypto:    { slBufferMultiplier: 2.0, proximityMultiplier: 1.5, skipSessionGate: true,  minConfluenceAdj: 0 },
};

export function getAssetProfile(symbol: string) {
  const spec = SPECS[symbol];
  const type = spec?.type || "forex";
  return ASSET_PROFILES[type] || ASSET_PROFILES.forex;
}

export const STYLE_OVERRIDES: Record<string, any> = {
  scalper: { entryTimeframe: "5m", htfTimeframe: "1h", tpRatio: 1.5, slBufferPips: 1, minConfluence: 45 },
  day_trader: { entryTimeframe: "15min", htfTimeframe: "1day", tpRatio: 2.0, slBufferPips: 2, minConfluence: 55 },
  swing_trader: { entryTimeframe: "1h", htfTimeframe: "1w", tpRatio: 3.0, slBufferPips: 5, minConfluence: 65 },
};

export const DEFAULTS = {
  entryTimeframe: "15min",
  htfTimeframe: "1day",
  htfBiasRequired: true,
  htfBiasHardVeto: false,
  minConfluence: 55,
  onlyBuyInDiscount: true,
  onlySellInPremium: true,
  riskPerTrade: 1,
  maxDailyLoss: 5,
  maxDrawdown: 15,
  maxOpenPositions: 5,
  maxPerSymbol: 2,
  portfolioHeat: 10,
  minRiskReward: 1.5,
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
  enabledSessions: ["London", "New York"],
  enabledDays: [1, 2, 3, 4, 5],
  instruments: [
    "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD",
    "GBP/JPY", "EUR/JPY", "NZD/USD", "USD/CHF", "EUR/GBP",
    "XAU/USD", "BTC/USD",
  ],
  openingRange: { enabled: false, candleCount: 24, useBias: true, useJudasSwing: true, useKeyLevels: true, usePremiumDiscount: false, waitForCompletion: true },
  tradingStyle: { mode: "day_trader" as "scalper" | "day_trader" | "swing_trader" },
  spreadFilterEnabled: true,
  maxSpreadPips: 3,
  newsFilterEnabled: true,
  newsFilterPauseMinutes: 30,
  cooldownMinutes: 0,
  closeOnReverse: false,
  trailingStopEnabled: false,
  trailingStopPips: 15,
  trailingStopActivation: "after_1r",
  partialTPEnabled: false,
  partialTPPercent: 50,
  partialTPLevel: 1.0,
  maxHoldHours: 0,
  killZoneOnly: false,
  maxConsecutiveLosses: 0,
  protectionMaxDailyLossDollar: 0,
  minFactorCount: 0,
  useSMT: true,
  useVolumeProfile: true,
  useTrendDirection: true,
  useDailyBias: true,
  useAMD: true,
  useFOTSI: true,
  regimeScoringEnabled: true,
  regimeScoringStrength: 1.0,
  obLookbackCandles: 50,
  fvgMinSizePips: 0,
  fvgOnlyUnfilled: true,
  structureLookback: 50,
  liquidityPoolMinTouches: 2,
  _currentSymbol: "" as string,
  _smtResult: null as any,
};

// ─── DST-Aware New York Time Helper ─────────────────────────────────
export function toNYTime(utc: Date): { h: number; m: number; t: number; tMin: number; isEDT: boolean } {
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

// ─── Backtest variant: accepts a timestamp instead of using Date.now() ──
export function toNYTimeAt(utcMs: number): { h: number; m: number; t: number; tMin: number; isEDT: boolean } {
  return toNYTime(new Date(utcMs));
}

// ─── Session Detection ──────────────────────────────────────────────
export function detectSession(atMs?: number): { name: string; isKillZone: boolean } {
  const ny = atMs != null ? toNYTimeAt(atMs) : toNYTime(new Date());
  const t = ny.t;
  if (t >= 20 || t < 0) return { name: "Asian", isKillZone: false };
  if (t >= 0 && t < 2) return { name: "Asian", isKillZone: false };
  if (t >= 2 && t < 5) return { name: "London", isKillZone: true };
  if (t >= 5 && t < 8.5) return { name: "London", isKillZone: false };
  if (t >= 8.5 && t < 11) return { name: "New York", isKillZone: true };
  if (t >= 11 && t < 12) return { name: "New York", isKillZone: true };
  if (t >= 12 && t < 16) return { name: "New York", isKillZone: false };
  return { name: "Off-Hours", isKillZone: false };
}

// ─── Silver Bullet Windows ──────────────────────────────────────────
export function detectSilverBullet(atMs?: number): SilverBulletResult {
  const ny = atMs != null ? toNYTimeAt(atMs) : toNYTime(new Date());
  const t = ny.t;
  const windows = [
    { name: "London Open SB", start: 3, end: 4 },
    { name: "AM SB", start: 10, end: 11 },
    { name: "PM SB", start: 14, end: 15 },
  ];
  for (const w of windows) {
    if (t >= w.start && t < w.end) {
      return { active: true, window: w.name, minutesRemaining: Math.max(0, Math.round((w.end - t) * 60)) };
    }
  }
  return { active: false, window: null, minutesRemaining: 0 };
}

// ─── ICT Macro Windows ──────────────────────────────────────────────
export function detectMacroWindow(atMs?: number): MacroWindowResult {
  const ny = atMs != null ? toNYTimeAt(atMs) : toNYTime(new Date());
  const tMin = ny.tMin;
  const windows = [
    { name: "London Macro 1",    start: 2*60+33, end: 2*60+50 },
    { name: "London Macro 2",    start: 4*60+3,  end: 4*60+20 },
    { name: "NY Pre-Open Macro", start: 8*60+50, end: 9*60+10 },
    { name: "NY AM Macro",       start: 9*60+50, end: 10*60+10 },
    { name: "London Close Macro",start: 10*60+50,end: 11*60+10 },
    { name: "NY Lunch Macro",    start: 11*60+50,end: 12*60+10 },
    { name: "Last Hour Macro",   start: 13*60+10,end: 13*60+40 },
    { name: "PM Macro",          start: 15*60+15,end: 15*60+45 },
  ];
  for (const w of windows) {
    if (tMin >= w.start && tMin < w.end) {
      return { active: true, window: w.name, minutesRemaining: w.end - tMin };
    }
  }
  return { active: false, window: null, minutesRemaining: 0 };
}

// ─── ICT AMD Phase Detection ────────────────────────────────────────
export function detectAMDPhase(candles: Candle[], atMs?: number): AMDResult {
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

  const nowNY = atMs != null ? toNYTimeAt(atMs) : toNYTime(new Date());
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

// ─── Standalone ATR Calculation ─────────────────────────────────────
export function calculateATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    atrSum += tr;
  }
  return atrSum / period;
}

// ─── Session-Anchored VWAP ──────────────────────────────────────────
export function calculateAnchoredVWAP(candles: Candle[], pipSize: number): VWAPResult {
  if (candles.length === 0 || pipSize <= 0) {
    return { value: null, distancePips: null, rejection: null, barsAnchored: 0 };
  }
  const lastDate = candles[candles.length - 1].datetime.slice(0, 10);
  let anchorIdx = candles.length - 1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].datetime.slice(0, 10) === lastDate) anchorIdx = i; else break;
  }
  let pvSum = 0, vSum = 0;
  for (let i = anchorIdx; i < candles.length; i++) {
    const c = candles[i];
    const typical = (c.high + c.low + c.close) / 3;
    const w = Math.max(1e-9, c.high - c.low);
    pvSum += typical * w;
    vSum += w;
  }
  const value = vSum > 0 ? pvSum / vSum : null;
  if (value == null) return { value: null, distancePips: null, rejection: null, barsAnchored: candles.length - anchorIdx };
  const last = candles[candles.length - 1];
  const distancePips = Math.abs(last.close - value) / pipSize;
  let rejection: "bullish" | "bearish" | null = null;
  if (last.low < value && last.close > value && (last.close - last.open) > 0) rejection = "bullish";
  else if (last.high > value && last.close < value && (last.open - last.close) > 0) rejection = "bearish";
  return { value, distancePips, rejection, barsAnchored: candles.length - anchorIdx };
}

// ─── Optimal Style Detection ────────────────────────────────────────
export function detectOptimalStyle(candles: Candle[], dailyCandles: Candle[]): string {
  if (candles.length < 20 || dailyCandles.length < 10) return "day_trader";
  const atrPeriod = Math.min(14, dailyCandles.length - 1);
  let atrSum = 0;
  for (let i = dailyCandles.length - atrPeriod; i < dailyCandles.length; i++) {
    const prev = dailyCandles[i - 1];
    const curr = dailyCandles[i];
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    atrSum += tr;
  }
  const atr = atrSum / atrPeriod;
  const avgPrice = dailyCandles[dailyCandles.length - 1].close;
  const atrPercent = avgPrice > 0 ? (atr / avgPrice) * 100 : 0;
  const recentClose = dailyCandles[dailyCandles.length - 1].close;
  const fiveDaysAgo = dailyCandles[Math.max(0, dailyCandles.length - 6)].close;
  const trendMove = Math.abs(recentClose - fiveDaysAgo);
  const trendStrength = atr > 0 ? trendMove / (atr * 5) : 0;
  if (atrPercent < 0.5 && trendStrength < 0.3) return "scalper";
  if (atrPercent > 1.0 && trendStrength > 0.5) return "swing_trader";
  return "day_trader";
}

// ─── SMC Detection Functions ────────────────────────────────────────

export function detectSwingPoints(candles: Candle[], lookback = 3, atrFilter = 0): SwingPoint[] {
  // atrFilter: minimum swing size as a fraction of ATR (e.g., 0.3 = 30% of ATR).
  // When > 0, filters out insignificant swings that are just noise.
  let atrValue = 0;
  if (atrFilter > 0 && candles.length >= 15) {
    atrValue = calculateATR(candles, 14);
  }
  const minSwingSize = atrValue * atrFilter;

  const swings: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    // ATR filter: only accept swings with sufficient magnitude
    if (isHigh && minSwingSize > 0) {
      // Swing high must be at least minSwingSize above the nearest lows in the window
      let minLow = Infinity;
      for (let j = -lookback; j <= lookback; j++) {
        if (j !== 0) minLow = Math.min(minLow, candles[i + j].low);
      }
      if (candles[i].high - minLow < minSwingSize) isHigh = false;
    }
    if (isLow && minSwingSize > 0) {
      let maxHigh = -Infinity;
      for (let j = -lookback; j <= lookback; j++) {
        if (j !== 0) maxHigh = Math.max(maxHigh, candles[i + j].high);
      }
      if (maxHigh - candles[i].low < minSwingSize) isLow = false;
    }
    if (isHigh) swings.push({ index: i, price: candles[i].high, type: "high", datetime: candles[i].datetime });
    if (isLow) swings.push({ index: i, price: candles[i].low, type: "low", datetime: candles[i].datetime });
  }
  return swings;
}

// ─── Enhanced Market Structure Analysis ──────────────────────────────
// Improvements over the original:
// 1. ATR-filtered swings — filters out noise in volatile sessions
// 2. Close-based BOS — requires candle body close through the level, not just wick
// 3. Liquidity sweep detection — wick through + close back = sweep, not BOS
//
// Return shape is BACKWARD COMPATIBLE: { trend, swingPoints, bos, choch }
// New optional fields: sweeps[], and closeBased flag on bos/choch entries

export interface StructureBreak {
  index: number;
  type: "bullish" | "bearish";
  price: number;
  datetime: string;
  closeBased: boolean;  // true = candle body closed through the level (strong)
  level: number;        // the swing level that was broken
}

export interface LiquiditySweep {
  index: number;
  type: "bullish" | "bearish"; // bullish sweep = swept lows then reversed up
  price: number;
  datetime: string;
  sweptLevel: number;   // the swing level that was swept
  wickDepth: number;    // how far past the level the wick went
}

export function analyzeMarketStructure(candles: Candle[], structureLookback?: number) {
  // Use ATR-filtered swings (0.25 = swing must be at least 25% of ATR to count)
  const atrFilterStrength = 0.25;
  const swings = detectSwingPoints(
    candles,
    structureLookback && structureLookback > 0 ? structureLookback : 3,
    candles.length >= 15 ? atrFilterStrength : 0
  );
  const highs = swings.filter(s => s.type === "high");
  const lows = swings.filter(s => s.type === "low");
  let currentTrend: "bullish" | "bearish" | "ranging" = "ranging";
  const bos: StructureBreak[] = [];
  const choch: StructureBreak[] = [];
  const sweeps: LiquiditySweep[] = [];

  // ── Process all swing breaks chronologically to properly track trend transitions ──
  // Merge highs and lows by their candle index so we process them in time order.
  // This ensures currentTrend correctly reflects the full sequence of structural events.
  type SwingEvent = { swingType: "high" | "low"; prevLevel: number; index: number };
  const events: SwingEvent[] = [];
  for (let i = 1; i < highs.length; i++) {
    events.push({ swingType: "high", prevLevel: highs[i - 1].price, index: highs[i].index });
  }
  for (let i = 1; i < lows.length; i++) {
    events.push({ swingType: "low", prevLevel: lows[i - 1].price, index: lows[i].index });
  }
  events.sort((a, b) => a.index - b.index);

  for (const evt of events) {
    const breakCandle = candles[evt.index];
    if (!breakCandle) continue;

    if (evt.swingType === "high" && breakCandle.high > evt.prevLevel) {
      const closedThrough = breakCandle.close > evt.prevLevel;
      if (closedThrough) {
        const entry: StructureBreak = {
          index: evt.index, type: "bullish", price: breakCandle.high,
          datetime: breakCandle.datetime, closeBased: true, level: evt.prevLevel,
        };
        if (currentTrend === "bearish") choch.push(entry);
        else bos.push(entry);
        currentTrend = "bullish";
      } else {
        sweeps.push({
          index: evt.index, type: "bearish",
          price: breakCandle.high, datetime: breakCandle.datetime,
          sweptLevel: evt.prevLevel, wickDepth: breakCandle.high - evt.prevLevel,
        });
      }
    } else if (evt.swingType === "low" && breakCandle.low < evt.prevLevel) {
      const closedThrough = breakCandle.close < evt.prevLevel;
      if (closedThrough) {
        const entry: StructureBreak = {
          index: evt.index, type: "bearish", price: breakCandle.low,
          datetime: breakCandle.datetime, closeBased: true, level: evt.prevLevel,
        };
        if (currentTrend === "bullish") choch.push(entry);
        else bos.push(entry);
        currentTrend = "bearish";
      } else {
        sweeps.push({
          index: evt.index, type: "bullish",
          price: breakCandle.low, datetime: breakCandle.datetime,
          sweptLevel: evt.prevLevel, wickDepth: evt.prevLevel - breakCandle.low,
        });
      }
    }
  }

  // ── Separate sweep scan: check ALL candles between consecutive swing levels ──
  // Sweeps can happen on non-swing candles (e.g., a candle wicks above a swing high
  // but isn't itself a swing high because a later candle goes even higher).
  // Scan between each pair of consecutive swing highs for bearish sweeps (buy-side)
  for (let i = 0; i < highs.length; i++) {
    const level = highs[i].price;
    const startIdx = highs[i].index + 1;
    const endIdx = (i + 1 < highs.length) ? highs[i + 1].index : candles.length;
    for (let ci = startIdx; ci < endIdx; ci++) {
      const c = candles[ci];
      if (!c) continue;
      // Wick went above the swing high but close stayed below
      if (c.high > level && c.close <= level) {
        // Avoid duplicating sweeps already found in the BOS/CHoCH pass
        const alreadyFound = sweeps.some(s => s.index === ci && s.type === "bearish");
        if (!alreadyFound) {
          sweeps.push({
            index: ci, type: "bearish",
            price: c.high, datetime: c.datetime,
            sweptLevel: level, wickDepth: c.high - level,
          });
        }
      }
    }
  }
  // Scan between each pair of consecutive swing lows for bullish sweeps (sell-side)
  for (let i = 0; i < lows.length; i++) {
    const level = lows[i].price;
    const startIdx = lows[i].index + 1;
    const endIdx = (i + 1 < lows.length) ? lows[i + 1].index : candles.length;
    for (let ci = startIdx; ci < endIdx; ci++) {
      const c = candles[ci];
      if (!c) continue;
      // Wick went below the swing low but close stayed above
      if (c.low < level && c.close >= level) {
        const alreadyFound = sweeps.some(s => s.index === ci && s.type === "bullish");
        if (!alreadyFound) {
          sweeps.push({
            index: ci, type: "bullish",
            price: c.low, datetime: c.datetime,
            sweptLevel: level, wickDepth: level - c.low,
          });
        }
      }
    }
  }

  // ── Determine overall trend from the last 2 swing highs + lows ──
  let trend: "bullish" | "bearish" | "ranging" = "ranging";
  if (highs.length >= 2 && lows.length >= 2) {
    const rH = highs.slice(-2), rL = lows.slice(-2);
    if (rH[1].price > rH[0].price && rL[1].price > rL[0].price) trend = "bullish";
    else if (rH[1].price < rH[0].price && rL[1].price < rL[0].price) trend = "bearish";
  }

  return { trend, swingPoints: swings, bos, choch, sweeps };
}

export function detectOrderBlocks(candles: Candle[], structureBreaks?: { index: number; type: string }[], obLookbackOverride?: number): OrderBlock[] {
  const OB_RECENCY = (typeof obLookbackOverride === "number" && obLookbackOverride > 0) ? obLookbackOverride : 50;
  const OB_CAP = 5;
  const BREAK_LOOKAHEAD = 10;
  const recencyStart = Math.max(2, candles.length - OB_RECENCY);
  const candidates: (OrderBlock & { quality: number })[] = [];

  // Pre-compute ATR for displacement detection within OB context
  const atrPeriod = Math.min(14, candles.length - 1);
  let avgRange = 0;
  if (candles.length > atrPeriod) {
    const atrSlice = candles.slice(candles.length - atrPeriod - 20, candles.length - 1);
    avgRange = atrSlice.reduce((s, c) => s + (c.high - c.low), 0) / atrSlice.length;
  }

  for (let i = recencyStart; i < candles.length; i++) {
    const prev = candles[i - 1], curr = candles[i];
    // Bullish OB: bearish candle followed by bullish candle that closes above prev high
    if (prev.close < prev.open && curr.close > curr.open && curr.close > prev.high) {
      const obHigh = Math.max(prev.open, prev.close);
      const obLow = Math.min(prev.open, prev.close);
      const ob: OrderBlock & { quality: number } = {
        index: i - 1, high: obHigh, low: obLow, type: "bullish",
        datetime: prev.datetime, mitigated: false, mitigatedPercent: 0,
        hasDisplacement: false, hasFVGAdjacency: false, quality: 0,
      };
      // Check for displacement: the engulfing candle (curr) or next 2 candles must be a large-body move
      // Displacement = body > 1.5x avg range AND body ratio > 60%
      for (let d = i; d < Math.min(i + 3, candles.length); d++) {
        const dc = candles[d];
        const dcBody = Math.abs(dc.close - dc.open);
        const dcRange = dc.high - dc.low;
        if (dcRange > 0 && avgRange > 0 && dcBody / dcRange >= 0.6 && dcRange >= avgRange * 1.5 && dc.close > dc.open) {
          ob.hasDisplacement = true;
          break;
        }
      }
      // Mitigation check
      for (let j = i + 1; j < candles.length; j++) {
        const mid = (ob.high + ob.low) / 2;
        if (candles[j].low <= mid) {
          ob.mitigatedPercent = Math.min(100, ((ob.high - candles[j].low) / (ob.high - ob.low)) * 100);
          if (ob.mitigatedPercent >= 50) ob.mitigated = true;
          break;
        }
      }
      // Quality scoring: structure break nearby = +2, displacement = +2, recency bonus
      if (structureBreaks && structureBreaks.length > 0) {
        const hasBreak = structureBreaks.some(b => b.type === "bullish" && b.index > ob.index && b.index <= ob.index + BREAK_LOOKAHEAD);
        if (hasBreak) ob.quality += 2;
      } else { ob.quality += 1; }
      if (ob.hasDisplacement) ob.quality += 2;
      ob.quality += (ob.index - recencyStart) / OB_RECENCY; // recency bonus
      candidates.push(ob);
    }
    // Bearish OB: bullish candle followed by bearish candle that closes below prev low
    if (prev.close > prev.open && curr.close < curr.open && curr.close < prev.low) {
      const obHigh = Math.max(prev.open, prev.close);
      const obLow = Math.min(prev.open, prev.close);
      const ob: OrderBlock & { quality: number } = {
        index: i - 1, high: obHigh, low: obLow, type: "bearish",
        datetime: prev.datetime, mitigated: false, mitigatedPercent: 0,
        hasDisplacement: false, hasFVGAdjacency: false, quality: 0,
      };
      // Check for displacement: bearish large-body move away from OB
      for (let d = i; d < Math.min(i + 3, candles.length); d++) {
        const dc = candles[d];
        const dcBody = Math.abs(dc.close - dc.open);
        const dcRange = dc.high - dc.low;
        if (dcRange > 0 && avgRange > 0 && dcBody / dcRange >= 0.6 && dcRange >= avgRange * 1.5 && dc.close < dc.open) {
          ob.hasDisplacement = true;
          break;
        }
      }
      // Mitigation check
      for (let j = i + 1; j < candles.length; j++) {
        const mid = (ob.high + ob.low) / 2;
        if (candles[j].high >= mid) {
          ob.mitigatedPercent = Math.min(100, ((candles[j].high - ob.low) / (ob.high - ob.low)) * 100);
          if (ob.mitigatedPercent >= 50) ob.mitigated = true;
          break;
        }
      }
      // Quality scoring
      if (structureBreaks && structureBreaks.length > 0) {
        const hasBreak = structureBreaks.some(b => b.type === "bearish" && b.index > ob.index && b.index <= ob.index + BREAK_LOOKAHEAD);
        if (hasBreak) ob.quality += 2;
      } else { ob.quality += 1; }
      if (ob.hasDisplacement) ob.quality += 2;
      ob.quality += (ob.index - recencyStart) / OB_RECENCY;
      candidates.push(ob);
    }
  }
  candidates.sort((a, b) => b.quality - a.quality || b.index - a.index);
  return candidates.slice(0, OB_CAP).map(({ quality, ...ob }) => ob);
}

export function detectFVGs(candles: Candle[]): FairValueGap[] {
  const fvgs: FairValueGap[] = [];
  // Only look at recent candles (last 50) to avoid stale FVGs from hours ago
  const FVG_RECENCY = 50;
  const startIdx = Math.max(2, candles.length - FVG_RECENCY);
  for (let i = startIdx; i < candles.length; i++) {
    const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i];
    // Bullish FVG: gap up — candle 3 low > candle 1 high, middle candle is bullish
    if (c3.low > c1.high && c2.close > c2.open) {
      const fvg: FairValueGap = { index: i - 1, high: c3.low, low: c1.high, type: "bullish", datetime: c2.datetime, mitigated: false };
      // Check if FVG has been filled (price returned into the gap)
      for (let j = i + 1; j < candles.length; j++) { if (candles[j].low <= fvg.low) { fvg.mitigated = true; break; } }
      fvgs.push(fvg);
    }
    // Bearish FVG: gap down — candle 1 low > candle 3 high, middle candle is bearish
    if (c1.low > c3.high && c2.close < c2.open) {
      const fvg: FairValueGap = { index: i - 1, high: c1.low, low: c3.high, type: "bearish", datetime: c2.datetime, mitigated: false };
      for (let j = i + 1; j < candles.length; j++) { if (candles[j].high >= fvg.high) { fvg.mitigated = true; break; } }
      fvgs.push(fvg);
    }
  }
  return fvgs;
}

export function detectLiquidityPools(candles: Candle[], tolerance = 0.001, minTouches = 2): LiquidityPool[] {
  const pools: LiquidityPool[] = [];
  const priceRange = Math.max(...candles.map(c => c.high)) - Math.min(...candles.map(c => c.low));
  const tol = priceRange * tolerance;
  const last = candles[candles.length - 1];
  const usedH = new Set<number>(), usedL = new Set<number>();

  // Buy-side liquidity (equal highs)
  for (let i = 0; i < candles.length; i++) {
    if (usedH.has(i)) continue;
    let count = 1;
    for (let j = i + 1; j < candles.length; j++) {
      if (usedH.has(j)) continue;
      if (Math.abs(candles[i].high - candles[j].high) <= tol) { count++; usedH.add(j); }
    }
    if (count >= minTouches) {
      const poolPrice = candles[i].high;
      let swept = false;
      let sweptAtIndex: number | undefined;
      let rejectionConfirmed = false;
      // Find the FIRST candle that swept above this pool level
      for (let k = i + 1; k < candles.length; k++) {
        if (candles[k].high > poolPrice) {
          swept = true;
          sweptAtIndex = k;
          // Rejection = wick above but close below the pool level
          if (candles[k].close < poolPrice) {
            rejectionConfirmed = true;
          }
          break;
        }
      }
      // Recency filter: only include pools from the last 80 candles
      if (i >= candles.length - 80 || swept) {
        pools.push({ price: poolPrice, type: "buy-side", strength: count, datetime: candles[i].datetime, swept, sweptAtIndex, rejectionConfirmed });
      }
    }
  }
  // Sell-side liquidity (equal lows)
  for (let i = 0; i < candles.length; i++) {
    if (usedL.has(i)) continue;
    let count = 1;
    for (let j = i + 1; j < candles.length; j++) {
      if (usedL.has(j)) continue;
      if (Math.abs(candles[i].low - candles[j].low) <= tol) { count++; usedL.add(j); }
    }
    if (count >= minTouches) {
      const poolPrice = candles[i].low;
      let swept = false;
      let sweptAtIndex: number | undefined;
      let rejectionConfirmed = false;
      for (let k = i + 1; k < candles.length; k++) {
        if (candles[k].low < poolPrice) {
          swept = true;
          sweptAtIndex = k;
          if (candles[k].close > poolPrice) {
            rejectionConfirmed = true;
          }
          break;
        }
      }
      if (i >= candles.length - 80 || swept) {
        pools.push({ price: poolPrice, type: "sell-side", strength: count, datetime: candles[i].datetime, swept, sweptAtIndex, rejectionConfirmed });
      }
    }
  }
  return pools.sort((a, b) => b.strength - a.strength);
}

export function detectDisplacement(candles: Candle[]): DisplacementResult {
  if (candles.length < 25) return { isDisplacement: false, displacementCandles: [], lastDirection: null };
  const window = candles.slice(-21, -1);
  let bodySum = 0, rangeSum = 0;
  for (const c of window) {
    bodySum += Math.abs(c.close - c.open);
    rangeSum += (c.high - c.low);
  }
  const avgBody = bodySum / window.length;
  const avgRange = rangeSum / window.length;
  if (avgBody <= 0 || avgRange <= 0) return { isDisplacement: false, displacementCandles: [], lastDirection: null };

  const checkStart = Math.max(0, candles.length - 5);
  const displacementCandles: DisplacementCandle[] = [];
  for (let i = checkStart; i < candles.length; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    if (range <= 0) continue;
    const bodyRatio = body / range;
    const rangeMultiple = range / avgRange;
    const bodyMultiple = body / avgBody;
    if (bodyMultiple >= 2.0 && bodyRatio >= 0.7 && rangeMultiple >= 1.5) {
      displacementCandles.push({
        index: i, bodyRatio, rangeMultiple,
        direction: c.close > c.open ? "bullish" : "bearish",
      });
    }
  }
  const lastDirection = displacementCandles.length > 0
    ? displacementCandles[displacementCandles.length - 1].direction
    : null;
  return { isDisplacement: displacementCandles.length > 0, displacementCandles, lastDirection };
}

export function tagDisplacementQuality(
  orderBlocks: OrderBlock[],
  fvgs: FairValueGap[],
  displacementCandles: DisplacementCandle[],
) {
  for (const ob of orderBlocks) {
    // Tag displacement from the displacement candle detector (supplements OB's own check)
    const hasNearby = displacementCandles.some(d => d.index > ob.index && d.index <= ob.index + 3);
    if (hasNearby) ob.hasDisplacement = true; // Don't overwrite if already true from OB detection
    // Tag FVG adjacency: an OB with a nearby FVG in the same direction is higher quality
    const hasFVG = fvgs.some(f => f.type === ob.type && Math.abs(f.index - ob.index) <= 3 && !f.mitigated);
    ob.hasFVGAdjacency = hasFVG;
  }
  for (const fvg of fvgs) {
    const createdByDisp = displacementCandles.some(d => d.index === fvg.index);
    (fvg as any).hasDisplacement = createdByDisp;
  }
}

export function detectBreakerBlocks(orderBlocks: OrderBlock[], candles: Candle[]): BreakerBlock[] {
  const breakers: BreakerBlock[] = [];
  for (const ob of orderBlocks) {
    if (!ob.mitigated) continue;
    const breakerType: "bullish_breaker" | "bearish_breaker" =
      ob.type === "bullish" ? "bearish_breaker" : "bullish_breaker";
    let mitigatedAt = ob.index;
    for (let j = ob.index + 1; j < candles.length; j++) {
      if (ob.type === "bullish" && candles[j].close < ob.low) { mitigatedAt = j; break; }
      if (ob.type === "bearish" && candles[j].close > ob.high) { mitigatedAt = j; break; }
    }
    let isActive = true;
    for (let j = mitigatedAt + 1; j < candles.length; j++) {
      const c = candles[j];
      const enteredZone = c.high >= ob.low && c.low <= ob.high;
      if (!enteredZone) continue;
      if (breakerType === "bearish_breaker") {
        if (c.close < ob.low) { isActive = false; break; }
      } else {
        if (c.close > ob.high) { isActive = false; break; }
      }
    }
    breakers.push({ type: breakerType, high: ob.high, low: ob.low, mitigatedAt, originalOBType: ob.type, isActive });
  }
  return breakers.filter(b => b.isActive);
}

export function detectUnicornSetups(breakerBlocks: BreakerBlock[], fvgs: FairValueGap[]): UnicornSetup[] {
  const unicorns: UnicornSetup[] = [];
  const activeFVGs = fvgs.filter(f => !f.mitigated);
  for (const breaker of breakerBlocks) {
    if (!breaker.isActive) continue;
    const wantFVGType = breaker.type === "bullish_breaker" ? "bullish" : "bearish";
    for (const fvg of activeFVGs) {
      if (fvg.type !== wantFVGType) continue;
      const overlapLow = Math.max(breaker.low, fvg.low);
      const overlapHigh = Math.min(breaker.high, fvg.high);
      if (overlapLow < overlapHigh) {
        unicorns.push({
          type: breaker.type === "bullish_breaker" ? "bullish_unicorn" : "bearish_unicorn",
          breakerHigh: breaker.high, breakerLow: breaker.low,
          fvgHigh: fvg.high, fvgLow: fvg.low, overlapHigh, overlapLow,
        });
      }
    }
  }
  return unicorns;
}

export function detectSMTDivergence(symbol: string, candles: Candle[], correlatedCandles: Candle[]): SMTResult {
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
      detail: `${symbol} swing low ${thisLatestLow.toFixed(5)} < prior ${thisPriorLow.toFixed(5)}, but ${corrPair} held — bullish SMT`,
    };
  }

  const thisLatestHigh = thisHighs[thisHighs.length - 1].price;
  const thisPriorHigh  = thisHighs[thisHighs.length - 2].price;
  const corrLatestHigh = corrHighs[corrHighs.length - 1].price;
  const corrPriorHigh  = corrHighs[corrHighs.length - 2].price;

  if (thisLatestHigh > thisPriorHigh && corrLatestHigh <= corrPriorHigh) {
    return {
      detected: true, type: "bearish", correlatedPair: corrPair,
      detail: `${symbol} swing high ${thisLatestHigh.toFixed(5)} > prior ${thisPriorHigh.toFixed(5)}, but ${corrPair} held — bearish SMT`,
    };
  }

  return { detected: false, type: null, correlatedPair: corrPair, detail: `No swing-point SMT divergence vs ${corrPair}` };
}

export function detectJudasSwing(candles: Candle[], atMs?: number): { detected: boolean; type: "bullish" | "bearish" | null; confirmed: boolean; description: string } {
  const none = { detected: false, type: null as any, confirmed: false, description: "No Judas Swing" };
  if (candles.length < 20) return none;

  // Find the actual NY midnight (00:00 ET) candle by scanning timestamps
  let midnightIdx = -1;
  let midnightOpen = 0;
  for (let i = candles.length - 1; i >= Math.max(0, candles.length - 100); i--) {
    const c = candles[i];
    const utc = new Date(c.datetime.endsWith("Z") ? c.datetime : c.datetime + "Z");
    const ny = toNYTime(utc);
    // NY midnight = hour 0, minute 0 (or the first candle of the 00:00 hour)
    if (ny.h === 0 && ny.m < 15) {
      midnightIdx = i;
      midnightOpen = c.open;
      break;
    }
  }

  // Fallback: if no midnight candle found, use the candle closest to Asian session start (20:00 NY)
  if (midnightIdx < 0) {
    for (let i = candles.length - 1; i >= Math.max(0, candles.length - 100); i--) {
      const c = candles[i];
      const utc = new Date(c.datetime.endsWith("Z") ? c.datetime : c.datetime + "Z");
      const ny = toNYTime(utc);
      if (ny.h === 20 && ny.m < 15) {
        midnightIdx = i;
        midnightOpen = c.open;
        break;
      }
    }
  }

  if (midnightIdx < 0) return none; // Can't find reference point

  // Get candles from midnight to now
  const postMidnight = candles.slice(midnightIdx);
  if (postMidnight.length < 5) return none;

  // Split into early session (first 40% = manipulation phase) and current
  const splitIdx = Math.max(3, Math.floor(postMidnight.length * 0.4));
  const earlyCandles = postMidnight.slice(0, splitIdx);
  const currentClose = postMidnight[postMidnight.length - 1].close;
  const totalRange = Math.max(...postMidnight.map(c => c.high)) - Math.min(...postMidnight.map(c => c.low));
  if (totalRange === 0) return none;

  const earlyLow = Math.min(...earlyCandles.map(c => c.low));
  const earlyHigh = Math.max(...earlyCandles.map(c => c.high));

  // Bullish Judas: early session drops below midnight open (liquidity sweep below), then reverses up
  const dropBelow = midnightOpen - earlyLow;
  if (dropBelow > totalRange * 0.25 && currentClose > midnightOpen) {
    // Confirm: check if the sweep candle had a rejection wick (close back above midnight)
    const sweepCandle = earlyCandles.find(c => c.low === earlyLow);
    const hasRejection = sweepCandle ? sweepCandle.close > midnightOpen : false;
    return {
      detected: true, type: "bullish", confirmed: hasRejection,
      description: `Bullish Judas: false break below midnight ${midnightOpen.toFixed(5)} (low ${earlyLow.toFixed(5)}), reversed to ${currentClose.toFixed(5)}${hasRejection ? " with rejection" : ""}`
    };
  }

  // Bearish Judas: early session spikes above midnight open (liquidity sweep above), then reverses down
  const spikeAbove = earlyHigh - midnightOpen;
  if (spikeAbove > totalRange * 0.25 && currentClose < midnightOpen) {
    const sweepCandle = earlyCandles.find(c => c.high === earlyHigh);
    const hasRejection = sweepCandle ? sweepCandle.close < midnightOpen : false;
    return {
      detected: true, type: "bearish", confirmed: hasRejection,
      description: `Bearish Judas: false break above midnight ${midnightOpen.toFixed(5)} (high ${earlyHigh.toFixed(5)}), reversed to ${currentClose.toFixed(5)}${hasRejection ? " with rejection" : ""}`
    };
  }

  return none;
}

export function detectReversalCandle(candles: Candle[]): { detected: boolean; type: "bullish" | "bearish" | null } {
  if (candles.length < 2) return { detected: false, type: null };
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const bodySize = Math.abs(last.close - last.open);
  const totalRange = last.high - last.low;
  if (totalRange === 0) return { detected: false, type: null };

  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  if (bodySize / totalRange < 0.3 && lowerWick / totalRange > 0.6 && last.close > last.open) return { detected: true, type: "bullish" };
  if (bodySize / totalRange < 0.3 && upperWick / totalRange > 0.6 && last.close < last.open) return { detected: true, type: "bearish" };
  if (prev.close < prev.open && last.close > last.open && last.open <= prev.close && last.close >= prev.open) return { detected: true, type: "bullish" };
  if (prev.close > prev.open && last.close < last.open && last.open >= prev.close && last.close <= prev.open) return { detected: true, type: "bearish" };

  return { detected: false, type: null };
}

export function calculatePDLevels(dailyCandles: Candle[]) {
  if (dailyCandles.length < 10) return null;
  const prev = dailyCandles[dailyCandles.length - 2];
  const weekCandles = dailyCandles.slice(-5);
  return {
    pdh: prev.high, pdl: prev.low, pdo: prev.open, pdc: prev.close,
    pwh: Math.max(...weekCandles.map(c => c.high)),
    pwl: Math.min(...weekCandles.map(c => c.low)),
    pwo: weekCandles[0].open,
    pwc: weekCandles[weekCandles.length - 1].close,
  };
}

export function calculatePremiumDiscount(candles: Candle[]): { currentZone: string; zonePercent: number; oteZone: boolean } {
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

export function computeOpeningRange(hourlyCandles: Candle[], candleCount: number): OpeningRangeResult | null {
  if (!hourlyCandles || hourlyCandles.length === 0) return null;
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const todayCandles = hourlyCandles.filter(c => c.datetime >= todayStart);
  if (todayCandles.length === 0) return null;
  const orCandles = todayCandles.slice(0, candleCount);
  const high = Math.max(...orCandles.map(c => c.high));
  const low = Math.min(...orCandles.map(c => c.low));
  return { high, low, midpoint: (high + low) / 2, completed: todayCandles.length >= candleCount };
}

// ─── SL/TP Calculation ──────────────────────────────────────────────
export function calculateSLTP(input: SLTPInput): { stopLoss: number | null; takeProfit: number | null } {
  const { direction, lastPrice, pipSize, config, swings, orderBlocks, liquidityPools, pdLevels, atrValue } = input;
  if (!direction) return { stopLoss: null, takeProfit: null };

  const buffer = (config.slBufferPips || 2) * pipSize;
  let sl: number | null = null;
  let tp: number | null = null;

  const slMethod: string = config.slMethod || "structure";
  if (slMethod === "fixed_pips") {
    const dist = (config.fixedSLPips || 25) * pipSize;
    sl = direction === "long" ? lastPrice - dist : lastPrice + dist;
  } else if (slMethod === "atr_based") {
    if (atrValue > 0) {
      const dist = atrValue * (config.slATRMultiple || 1.5);
      sl = direction === "long" ? lastPrice - dist : lastPrice + dist;
    } else {
      const dist = (config.fixedSLPips || 25) * pipSize;
      sl = direction === "long" ? lastPrice - dist : lastPrice + dist;
    }
  } else if (slMethod === "below_ob") {
    if (direction === "long") {
      const bullishOBs = orderBlocks.filter(ob => !ob.mitigated && ob.type === "bullish" && ob.low < lastPrice).sort((a, b) => b.low - a.low);
      if (bullishOBs.length > 0) sl = bullishOBs[0].low - buffer;
    } else {
      const bearishOBs = orderBlocks.filter(ob => !ob.mitigated && ob.type === "bearish" && ob.high > lastPrice).sort((a, b) => a.high - b.high);
      if (bearishOBs.length > 0) sl = bearishOBs[0].high + buffer;
    }
    if (sl === null) {
      const dist = (config.fixedSLPips || 25) * pipSize;
      sl = direction === "long" ? lastPrice - dist : lastPrice + dist;
    }
  } else {
    if (direction === "long") {
      const recentLows = swings.filter(s => s.type === "low" && s.price < lastPrice).slice(-3);
      if (recentLows.length > 0) sl = Math.max(...recentLows.map(s => s.price)) - buffer;
    } else {
      const recentHighs = swings.filter(s => s.type === "high" && s.price > lastPrice).slice(-3);
      if (recentHighs.length > 0) sl = Math.min(...recentHighs.map(s => s.price)) + buffer;
    }
    if (sl === null) {
      const dist = (config.fixedSLPips || 25) * pipSize;
      sl = direction === "long" ? lastPrice - dist : lastPrice + dist;
    }
  }

  // ── ATR-based SL floor: ensure SL is at least 1.5× ATR ──
  // This prevents micro-scalp SLs on structure-based method when swing points are very close.
  if (atrValue > 0 && sl !== null) {
    const atrFloorDistance = atrValue * 1.5; // 1.5× ATR
    const currentSlDistance = Math.abs(lastPrice - sl);
    if (currentSlDistance < atrFloorDistance) {
      sl = direction === "long" ? lastPrice - atrFloorDistance : lastPrice + atrFloorDistance;
    }
  }

  const tpMethod: string = config.tpMethod || "rr_ratio";
  const slDistance = Math.abs(lastPrice - sl);

  if (tpMethod === "fixed_pips") {
    const dist = (config.fixedTPPips || 50) * pipSize;
    tp = direction === "long" ? lastPrice + dist : lastPrice - dist;
  } else if (tpMethod === "next_level") {
    const targets: number[] = [];
    if (direction === "long") {
      if (pdLevels) {
        if (pdLevels.pdh > lastPrice) targets.push(pdLevels.pdh);
        if (pdLevels.pwh > lastPrice) targets.push(pdLevels.pwh);
      }
      liquidityPools.filter(lp => lp.type === "buy-side" && lp.price > lastPrice && lp.strength >= 2).forEach(lp => targets.push(lp.price));
      targets.sort((a, b) => a - b);
    } else {
      if (pdLevels) {
        if (pdLevels.pdl < lastPrice) targets.push(pdLevels.pdl);
        if (pdLevels.pwl < lastPrice) targets.push(pdLevels.pwl);
      }
      liquidityPools.filter(lp => lp.type === "sell-side" && lp.price < lastPrice && lp.strength >= 2).forEach(lp => targets.push(lp.price));
      targets.sort((a, b) => b - a);
    }
    if (targets.length > 0) tp = targets[0];
    else {
      const dist = (config.fixedTPPips || 50) * pipSize;
      tp = direction === "long" ? lastPrice + dist : lastPrice - dist;
    }
  } else if (tpMethod === "atr_multiple") {
    if (atrValue > 0) {
      const dist = atrValue * (config.tpATRMultiple || 2.0);
      tp = direction === "long" ? lastPrice + dist : lastPrice - dist;
    } else {
      tp = direction === "long" ? lastPrice + slDistance * (config.tpRatio || 2.0) : lastPrice - slDistance * (config.tpRatio || 2.0);
    }
  } else {
    tp = direction === "long" ? lastPrice + slDistance * (config.tpRatio || 2.0) : lastPrice - slDistance * (config.tpRatio || 2.0);
  }

  return { stopLoss: sl, takeProfit: tp };
}

// ─── Quote-to-USD Conversion ────────────────────────────────────────
// Returns the multiplier to convert 1 unit of the quote currency into USD.
// rateMap should contain last close prices for major pairs keyed by symbol
// (e.g. { "USD/JPY": 150.0, "GBP/USD": 1.27, "AUD/USD": 0.65, ... }).
// For non-forex instruments (indices, commodities, crypto) priced in USD,
// returns 1.0 since their PnL is already denominated in USD.
export function getQuoteToUSDRate(symbol: string, rateMap?: Record<string, number>): number {
  // Non-forex: already USD-denominated
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  if (spec.type !== "forex") return 1.0;

  const parts = symbol.split("/");
  if (parts.length !== 2) return 1.0;
  const quote = parts[1]; // e.g. "JPY" in EUR/JPY, "USD" in EUR/USD

  // Quote is already USD — no conversion needed
  if (quote === "USD") return 1.0;

  // If no rate map provided, fall back to 1.0 (legacy behavior)
  if (!rateMap) return 1.0;

  // Try to find a direct conversion rate
  // For JPY quote: need USD/JPY → quoteToUSD = 1 / USD_JPY
  // For GBP quote: need GBP/USD → quoteToUSD = GBP_USD
  // For AUD quote: need AUD/USD → quoteToUSD = AUD_USD
  // For NZD quote: need NZD/USD → quoteToUSD = NZD_USD
  // For CAD quote: need USD/CAD → quoteToUSD = 1 / USD_CAD
  // For CHF quote: need USD/CHF → quoteToUSD = 1 / USD_CHF

  const QUOTE_CONVERSION: Record<string, { pair: string; invert: boolean }> = {
    "JPY": { pair: "USD/JPY", invert: true },   // 1 JPY = 1/USDJPY USD
    "GBP": { pair: "GBP/USD", invert: false },   // 1 GBP = GBPUSD USD
    "AUD": { pair: "AUD/USD", invert: false },   // 1 AUD = AUDUSD USD
    "NZD": { pair: "NZD/USD", invert: false },   // 1 NZD = NZDUSD USD
    "CAD": { pair: "USD/CAD", invert: true },    // 1 CAD = 1/USDCAD USD
    "CHF": { pair: "USD/CHF", invert: true },    // 1 CHF = 1/USDCHF USD
  };

  const conv = QUOTE_CONVERSION[quote];
  if (!conv) return 1.0; // Unknown quote currency — safe fallback

  const rate = rateMap[conv.pair];
  if (!rate || rate <= 0) return 1.0; // Rate unavailable — safe fallback

  return conv.invert ? (1 / rate) : rate;
}

// ─── Position Sizing ────────────────────────────────────────────────
// rateMap: optional map of { "USD/JPY": 150, "GBP/USD": 1.27, ... }
// used to convert pip value to USD for cross-pair lot sizing.
// fallbackMaxLot: optional override for the hardcoded max lot cap.
export function calculatePositionSize(
  balance: number, riskPercent: number, entryPrice: number, stopLoss: number, symbol: string,
  config?: { positionSizingMethod?: string; fixedLotSize?: number; atrValue?: number; atrVolatilityMultiplier?: number },
  rateMap?: Record<string, number>,
  fallbackMaxLot?: number
): number {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  const maxLot = fallbackMaxLot ?? (spec.type === "index" ? 50 : spec.type === "commodity" ? 10 : spec.type === "crypto" ? 100 : 5);
  const method = config?.positionSizingMethod || "percent_risk";
  const quoteToUSD = getQuoteToUSDRate(symbol, rateMap);

  if (method === "fixed_lot") {
    const fixed = config?.fixedLotSize ?? 0.01;
    return Math.max(0.01, Math.min(maxLot, Math.round(fixed * 100) / 100));
  }

  if (method === "volatility_adjusted" && config?.atrValue && config.atrValue > 0) {
    // Volatility-adjusted: scale risk inversely with ATR
    const riskAmount = balance * (riskPercent / 100);
    const atrMultiplier = config.atrVolatilityMultiplier ?? 1.5;
    const atrDistance = config.atrValue * atrMultiplier; // Configurable ATR multiplier for volatility sizing
    if (atrDistance === 0) return 0.01;
    // pipValuePerLot in USD = atrDistance * lotUnits * quoteToUSD
    const lots = riskAmount / (atrDistance * spec.lotUnits * quoteToUSD);
    return Math.max(0.01, Math.min(maxLot, Math.round(lots * 100) / 100));
  }

  // Default: percent_risk (risk-based)
  const riskAmount = balance * (riskPercent / 100);
  const slDistance = Math.abs(entryPrice - stopLoss);
  if (slDistance === 0) return 0.01;
  // pipValuePerLot in USD = slDistance * lotUnits * quoteToUSD
  const lots = riskAmount / (slDistance * spec.lotUnits * quoteToUSD);
  return Math.max(0.01, Math.min(maxLot, Math.round(lots * 100) / 100));
}

// ─── PnL Calculation ────────────────────────────────────────────────
// rateMap: optional map for cross-pair PnL conversion to USD
export function calcPnl(dir: string, entry: number, current: number, size: number, symbol: string, rateMap?: Record<string, number>) {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  const diff = dir === "long" ? current - entry : entry - current;
  const quoteToUSD = getQuoteToUSDRate(symbol, rateMap);
  return { pnl: diff * spec.lotUnits * size * quoteToUSD, pnlPips: diff / spec.pipSize };
}

// ─── Instrument Regime Classification (H7: shared across scanner + weekly advisor) ──
export interface InstrumentRegime {
  symbol?: string;
  regime: string;       // "strong_trend" | "mild_trend" | "choppy_range" | "mild_range" | "transitional" | "unknown"
  confidence: number;   // 0-1
  indicators: string[];
  atr14: number;
  atrTrend: string;     // "expanding" | "contracting" | "stable"
  directionalBias: string; // "bullish" | "bearish" | "neutral"
  rangePercent: number;
}

export function classifyInstrumentRegime(
  candles: Array<{ open: number; high: number; low: number; close: number; datetime?: string }>,
): Omit<InstrumentRegime, "symbol"> {
  if (!candles || candles.length < 20) {
    return { regime: "unknown", confidence: 0, indicators: ["Insufficient candle data"], atr14: 0, atrTrend: "stable", directionalBias: "neutral", rangePercent: 0 };
  }

  // Sort oldest to newest if datetime is available
  const sorted = candles[0].datetime
    ? [...candles].sort((a, b) => new Date(a.datetime!).getTime() - new Date(b.datetime!).getTime())
    : candles;
  const indicators: string[] = [];
  let regimeScore = 0;

  // 1. ATR analysis — volatility and its trend
  const trueRanges: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const high = sorted[i].high;
    const low = sorted[i].low;
    const prevClose = sorted[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  const atr14 = trueRanges.slice(-14).reduce((s, v) => s + v, 0) / Math.min(14, trueRanges.length);
  const atr7Recent = trueRanges.slice(-7).reduce((s, v) => s + v, 0) / Math.min(7, trueRanges.length);
  const atr7Prior = trueRanges.slice(-14, -7).reduce((s, v) => s + v, 0) / Math.min(7, trueRanges.slice(-14, -7).length || 1);

  let atrTrend: string;
  if (atr7Recent > atr7Prior * 1.2) {
    atrTrend = "expanding";
    regimeScore += 1;
    indicators.push(`ATR expanding: recent ${atr7Recent.toFixed(5)} vs prior ${atr7Prior.toFixed(5)} (+${((atr7Recent / atr7Prior - 1) * 100).toFixed(0)}%)`);
  } else if (atr7Recent < atr7Prior * 0.8) {
    atrTrend = "contracting";
    regimeScore -= 1;
    indicators.push(`ATR contracting: recent ${atr7Recent.toFixed(5)} vs prior ${atr7Prior.toFixed(5)} (${((atr7Recent / atr7Prior - 1) * 100).toFixed(0)}%)`);
  } else {
    atrTrend = "stable";
  }

  // 2. Directional Movement — ADX-like analysis
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const upMove = sorted[i].high - sorted[i - 1].high;
    const downMove = sorted[i - 1].low - sorted[i].low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const period = Math.min(14, plusDMs.length);
  const avgPlusDM = plusDMs.slice(-period).reduce((s, v) => s + v, 0) / period;
  const avgMinusDM = minusDMs.slice(-period).reduce((s, v) => s + v, 0) / period;
  const avgTR = trueRanges.slice(-period).reduce((s, v) => s + v, 0) / period;

  const plusDI = avgTR > 0 ? (avgPlusDM / avgTR) * 100 : 0;
  const minusDI = avgTR > 0 ? (avgMinusDM / avgTR) * 100 : 0;
  const diSum = plusDI + minusDI;
  const dx = diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0;

  if (dx > 30) {
    regimeScore += 2;
    indicators.push(`Strong directional movement (DX: ${dx.toFixed(1)}) — ${plusDI > minusDI ? "bullish" : "bearish"} dominant`);
  } else if (dx < 15) {
    regimeScore -= 2;
    indicators.push(`Weak directional movement (DX: ${dx.toFixed(1)}) — no clear trend`);
  }

  // 3. Price position relative to SMA20
  const closes = sorted.map(c => c.close);
  const sma20 = closes.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, closes.length);
  const currentPrice = closes[closes.length - 1];
  const priceVsSma = ((currentPrice - sma20) / sma20) * 100;

  if (Math.abs(priceVsSma) > 2) {
    regimeScore += 1;
    indicators.push(`Price ${priceVsSma > 0 ? "above" : "below"} SMA20 by ${Math.abs(priceVsSma).toFixed(2)}% — trending`);
  } else {
    regimeScore -= 1;
    indicators.push(`Price near SMA20 (${priceVsSma.toFixed(2)}%) — ranging/consolidating`);
  }

  // 4. Higher highs / lower lows analysis (last 10 candles)
  const recent10 = sorted.slice(-10);
  let hhCount = 0, llCount = 0;
  for (let i = 1; i < recent10.length; i++) {
    if (recent10[i].high > recent10[i - 1].high) hhCount++;
    if (recent10[i].low < recent10[i - 1].low) llCount++;
  }
  const hhRatio = hhCount / (recent10.length - 1);
  const llRatio = llCount / (recent10.length - 1);

  if (hhRatio > 0.6 && llRatio < 0.3) {
    regimeScore += 2;
    indicators.push(`Consistent higher highs (${(hhRatio * 100).toFixed(0)}%) — uptrend structure`);
  } else if (llRatio > 0.6 && hhRatio < 0.3) {
    regimeScore += 2;
    indicators.push(`Consistent lower lows (${(llRatio * 100).toFixed(0)}%) — downtrend structure`);
  } else if (hhRatio > 0.4 && llRatio > 0.4) {
    regimeScore -= 2;
    indicators.push(`Mixed HH/LL (HH: ${(hhRatio * 100).toFixed(0)}%, LL: ${(llRatio * 100).toFixed(0)}%) — choppy/ranging`);
  }

  // 5. Range analysis — how wide is the price range relative to ATR?
  const highestHigh = Math.max(...sorted.slice(-20).map(c => c.high));
  const lowestLow = Math.min(...sorted.slice(-20).map(c => c.low));
  const rangePercent = ((highestHigh - lowestLow) / lowestLow) * 100;
  const expectedRange = (atr14 * 20 / lowestLow) * 100;

  if (rangePercent > expectedRange * 1.3) {
    regimeScore += 1;
    indicators.push(`Wide 20-day range (${rangePercent.toFixed(2)}% vs expected ${expectedRange.toFixed(2)}%) — breakout/trending`);
  } else if (rangePercent < expectedRange * 0.7) {
    regimeScore -= 1;
    indicators.push(`Tight 20-day range (${rangePercent.toFixed(2)}% vs expected ${expectedRange.toFixed(2)}%) — compressed/ranging`);
  }

  // Determine directional bias
  let directionalBias: string;
  if (plusDI > minusDI * 1.3) directionalBias = "bullish";
  else if (minusDI > plusDI * 1.3) directionalBias = "bearish";
  else directionalBias = "neutral";

  // Determine regime
  let regime: string;
  let confidence: number;
  if (regimeScore >= 4) {
    regime = "strong_trend";
    confidence = Math.min(regimeScore / 7, 0.95);
  } else if (regimeScore >= 2) {
    regime = "mild_trend";
    confidence = 0.5 + regimeScore * 0.08;
  } else if (regimeScore <= -4) {
    regime = "choppy_range";
    confidence = Math.min(Math.abs(regimeScore) / 7, 0.95);
  } else if (regimeScore <= -2) {
    regime = "mild_range";
    confidence = 0.5 + Math.abs(regimeScore) * 0.08;
  } else {
    regime = "transitional";
    confidence = 0.3;
  }

  return { regime, confidence, indicators, atr14, atrTrend, directionalBias, rangePercent };
}
