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
  significance?: "internal" | "external";  // internal = minor pullback swing, external = major structural swing
  // ── Lifecycle tracking ──
  state: "active" | "tested" | "swept" | "broken";
  testedCount: number;        // times price approached within tolerance but didn't break
  sweptAt?: number;           // candle index when wick went through but close held
  brokenAt?: number;          // candle index when price closed through (BOS/CHoCH)
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
  hasVolumePivot?: boolean;
  // ── Lifecycle tracking ──
  state: "fresh" | "tested" | "mitigated" | "broken";
  testedCount: number;        // times price entered zone edge but didn't close through 50%
  firstTestedAt?: number;     // candle index of first test
  mitigatedAt?: number;       // candle index when mitigatedPercent first crossed 50%
  brokenAt?: number;          // candle index when price closed fully through the zone
}

export interface FairValueGap {
  index: number;
  high: number;
  low: number;
  type: "bullish" | "bearish";
  datetime: string;
  mitigated: boolean;
  hasDisplacement?: boolean;
  /** Quality score 0-8: displacement(+3) + ATR-relative size(+0-2) + body ratio(+0-1) + structure break nearby(+2) */
  quality?: number;
  // ── Lifecycle tracking ──
  state: "open" | "partially_filled" | "respected" | "filled";
  fillPercent: number;        // 0-100%, how much of the gap has been filled by subsequent price action
  respectedCount: number;     // times price touched the FVG edge but bounced away
  firstTestedAt?: number;     // candle index of first price entry into gap
  filledAt?: number;          // candle index when fully filled (mitigated)
}

export interface LiquidityPool {
  price: number;
  type: "buy-side" | "sell-side";
  strength: number;
  datetime: string;
  swept: boolean;
  sweptAtIndex?: number;
  rejectionConfirmed?: boolean;
  // ── Lifecycle tracking ──
  state: "active" | "swept_rejected" | "swept_absorbed" | "retested";
  sweepDepth?: number;        // how far past the level price went (absolute distance)
  retestedAt?: number;        // candle index when price came back to test from the other side
  retestedHeld?: boolean;     // did the retest hold? (level acting as new S/R)
}

export interface BreakerBlock {
  type: "bullish_breaker" | "bearish_breaker";
  subtype: "breaker" | "mitigation_block"; // breaker = confirmed new HH/LL, mitigation_block = no new extreme
  high: number;
  low: number;
  mitigatedAt: number;
  originalOBType: "bullish" | "bearish";
  isActive: boolean;
  // ── Lifecycle tracking ──
  state: "active" | "tested" | "respected" | "broken";
  testedCount: number;
  respectedAt?: number;       // candle index when price bounced from the zone
  brokenAt?: number;          // candle index when price closed through (invalidated)
}

export interface UnicornSetup {
  type: "bullish_unicorn" | "bearish_unicorn";
  breakerHigh: number;
  breakerLow: number;
  fvgHigh: number;
  fvgLow: number;
  overlapHigh: number;
  overlapLow: number;
  // ── Lifecycle tracking ──
  state: "active" | "tested" | "triggered" | "invalidated";
  invalidationReason?: "breaker_broken" | "fvg_filled" | "price_through";
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

// ─── ZigZag Pivot & Fibonacci Types ────────────────────────────────
export interface ZigZagPivot {
  index: number;
  price: number;
  type: "high" | "low";
  datetime: string;
}

export interface FibLevel {
  ratio: number;
  price: number;
  label: string;   // e.g. "23.6%", "61.8%", "-27.2%" (extension)
  type: "retracement" | "extension";
}

export interface FibLevels {
  swingHigh: number;
  swingLow: number;
  /** Direction of the last completed swing: low→high = "up", high→low = "down" */
  direction: "up" | "down";
  retracements: FibLevel[];
  extensions: FibLevel[];
  pivotHigh: ZigZagPivot;
  pivotLow: ZigZagPivot;
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
  /** Optional: unfilled FVGs for FVG-aware SL/TP tightening */
  fvgs?: FairValueGap[];
  /** Optional: Fib extension levels for TP intelligence */
  fibExtensions?: FibLevel[];
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
  "AUD/NZD": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 800, maxSpread: 4, typicalSpread: 2.5 },
  "NZD/JPY": { pipSize: 0.01, lotUnits: 100000, type: "forex", marginPerLot: 700, maxSpread: 4, typicalSpread: 2.5 },
  "CHF/JPY": { pipSize: 0.01, lotUnits: 100000, type: "forex", marginPerLot: 1000, maxSpread: 4, typicalSpread: 2.5 },
  "NZD/CAD": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 700, maxSpread: 4, typicalSpread: 2.5 },
  "AUD/CHF": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 800, maxSpread: 4, typicalSpread: 2.5 },
  "NZD/CHF": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 700, maxSpread: 5, typicalSpread: 3.0 },
  "CAD/CHF": { pipSize: 0.0001, lotUnits: 100000, type: "forex", marginPerLot: 1000, maxSpread: 4, typicalSpread: 2.5 },
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
  enabledSessions: ["london", "newyork"],
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
  // Legacy minFactorCount removed — single percentage threshold (minConfluence) only
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
    if (isHigh) swings.push({ index: i, price: candles[i].high, type: "high", datetime: candles[i].datetime, state: "active", testedCount: 0 });
    if (isLow) swings.push({ index: i, price: candles[i].low, type: "low", datetime: candles[i].datetime, state: "active", testedCount: 0 });
  }
  return swings;
}

// ─── ZigZag Pivot Detection (TradingView-style) ────────────────────
// Deviation-based pivot detection for Fibonacci anchoring.
// Unlike detectSwingPoints (fast, lookback-based, used for structure),
// this produces clean, significant pivots for Fib calculations.
//
// Algorithm mirrors TradingView's Auto Fib Retracement:
//   1. Compute deviation threshold from ATR (adapts to volatility)
//   2. Track current leg direction (up/down)
//   3. Only confirm a pivot when price reverses by > devThreshold%
//   4. Enforce minimum `depth` bars between pivots
//   5. Return the last 2 confirmed pivots (one completed swing)
//
// Fallback: if < 2 pivots found, uses detectSwingPoints() envelope.
export function detectZigZagPivots(
  candles: Candle[],
  devMultiplier = 3,
  depth = 10,
): { pivots: ZigZagPivot[]; lastTwo: [ZigZagPivot, ZigZagPivot] | null } {
  if (candles.length < depth + 5) {
    return { pivots: [], lastTwo: null };
  }

  // ATR-based deviation threshold (same formula as TradingView)
  const atr10 = calculateATR(candles, 10);
  const lastClose = candles[candles.length - 1].close;
  if (lastClose === 0 || atr10 === 0) return { pivots: [], lastTwo: null };
  const devThreshold = (atr10 / lastClose) * 100 * devMultiplier;

  const pivots: ZigZagPivot[] = [];
  let dir: "up" | "down" | null = null;
  let extremeIdx = 0;
  let extremePrice = candles[0].close;
  let lastPivotIdx = -depth; // enforce depth spacing

  // Initialize: find initial direction from first `depth` candles
  let initHigh = -Infinity, initHighIdx = 0;
  let initLow = Infinity, initLowIdx = 0;
  for (let i = 0; i < Math.min(depth, candles.length); i++) {
    if (candles[i].high > initHigh) { initHigh = candles[i].high; initHighIdx = i; }
    if (candles[i].low < initLow) { initLow = candles[i].low; initLowIdx = i; }
  }
  const initRange = initHigh - initLow;
  if (initRange === 0) return { pivots: [], lastTwo: null };
  const initDevPct = (initRange / ((initHigh + initLow) / 2)) * 100;
  if (initDevPct < devThreshold * 0.5) {
    // Not enough initial movement — start scanning from scratch
    dir = null;
    extremeIdx = 0;
    extremePrice = candles[0].close;
  } else if (initHighIdx > initLowIdx) {
    // Low came first → initial direction is up
    dir = "up";
    extremeIdx = initHighIdx;
    extremePrice = initHigh;
    pivots.push({ index: initLowIdx, price: initLow, type: "low", datetime: candles[initLowIdx].datetime });
    lastPivotIdx = initLowIdx;
  } else {
    // High came first → initial direction is down
    dir = "down";
    extremeIdx = initLowIdx;
    extremePrice = initLow;
    pivots.push({ index: initHighIdx, price: initHigh, type: "high", datetime: candles[initHighIdx].datetime });
    lastPivotIdx = initHighIdx;
  }

  // Main scan loop
  const startIdx = Math.min(depth, candles.length);
  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];

    if (dir === null) {
      // Still looking for initial direction
      if (c.high > extremePrice) { extremePrice = c.high; extremeIdx = i; }
      if (c.low < extremePrice) { extremePrice = c.low; extremeIdx = i; }
      // Check if we have enough deviation from the start
      const highSoFar = Math.max(...candles.slice(0, i + 1).map(x => x.high));
      const lowSoFar = Math.min(...candles.slice(0, i + 1).map(x => x.low));
      const rangePct = ((highSoFar - lowSoFar) / ((highSoFar + lowSoFar) / 2)) * 100;
      if (rangePct >= devThreshold) {
        const hiIdx = candles.slice(0, i + 1).findIndex(x => x.high === highSoFar);
        const loIdx = candles.slice(0, i + 1).findIndex(x => x.low === lowSoFar);
        if (hiIdx > loIdx) {
          dir = "up";
          pivots.push({ index: loIdx, price: lowSoFar, type: "low", datetime: candles[loIdx].datetime });
          lastPivotIdx = loIdx;
          extremeIdx = hiIdx;
          extremePrice = highSoFar;
        } else {
          dir = "down";
          pivots.push({ index: hiIdx, price: highSoFar, type: "high", datetime: candles[hiIdx].datetime });
          lastPivotIdx = hiIdx;
          extremeIdx = loIdx;
          extremePrice = lowSoFar;
        }
      }
      continue;
    }

    if (dir === "up") {
      // Tracking upward leg — look for new highs
      if (c.high > extremePrice) {
        extremePrice = c.high;
        extremeIdx = i;
      }
      // Check for reversal: price dropped from extreme by > devThreshold%
      const retracement = ((extremePrice - c.low) / extremePrice) * 100;
      if (retracement >= devThreshold && (i - lastPivotIdx) >= depth) {
        // Confirm the extreme as a swing high pivot
        pivots.push({ index: extremeIdx, price: extremePrice, type: "high", datetime: candles[extremeIdx].datetime });
        lastPivotIdx = extremeIdx;
        // Start tracking downward leg from this candle
        dir = "down";
        extremeIdx = i;
        extremePrice = c.low;
      }
    } else {
      // Tracking downward leg — look for new lows
      if (c.low < extremePrice) {
        extremePrice = c.low;
        extremeIdx = i;
      }
      // Check for reversal: price rose from extreme by > devThreshold%
      const retracement = extremePrice > 0 ? ((c.high - extremePrice) / extremePrice) * 100 : 0;
      if (retracement >= devThreshold && (i - lastPivotIdx) >= depth) {
        // Confirm the extreme as a swing low pivot
        pivots.push({ index: extremeIdx, price: extremePrice, type: "low", datetime: candles[extremeIdx].datetime });
        lastPivotIdx = extremeIdx;
        // Start tracking upward leg from this candle
        dir = "up";
        extremeIdx = i;
        extremePrice = c.high;
      }
    }
  }

  // Return last 2 confirmed pivots
  if (pivots.length >= 2) {
    const last = pivots[pivots.length - 1];
    const prev = pivots[pivots.length - 2];
    return { pivots, lastTwo: [prev, last] };
  }

  return { pivots, lastTwo: null };
}

// ─── Compute Fibonacci Levels from 2 Pivots ────────────────────────
// Given two ZigZag pivots (one high, one low), computes:
//   - Retracement levels: 0.236, 0.382, 0.5, 0.618, 0.705, 0.786
//   - Extension levels: 1.272, 1.618
// Direction-aware: "up" swing (low→high) means retracements go downward,
// "down" swing (high→low) means retracements go upward.
export function computeFibLevels(
  pivotA: ZigZagPivot,
  pivotB: ZigZagPivot,
): FibLevels | null {
  if (!pivotA || !pivotB) return null;

  let pivotHigh: ZigZagPivot, pivotLow: ZigZagPivot;
  let direction: "up" | "down";

  // Determine swing direction based on chronological order
  if (pivotA.index < pivotB.index) {
    // A came first
    if (pivotA.type === "low" && pivotB.type === "high") {
      direction = "up";
      pivotLow = pivotA;
      pivotHigh = pivotB;
    } else if (pivotA.type === "high" && pivotB.type === "low") {
      direction = "down";
      pivotHigh = pivotA;
      pivotLow = pivotB;
    } else {
      // Same type — use price to determine
      if (pivotA.price < pivotB.price) {
        direction = "up";
        pivotLow = pivotA;
        pivotHigh = pivotB;
      } else {
        direction = "down";
        pivotHigh = pivotA;
        pivotLow = pivotB;
      }
    }
  } else {
    // B came first
    if (pivotB.type === "low" && pivotA.type === "high") {
      direction = "up";
      pivotLow = pivotB;
      pivotHigh = pivotA;
    } else if (pivotB.type === "high" && pivotA.type === "low") {
      direction = "down";
      pivotHigh = pivotB;
      pivotLow = pivotA;
    } else {
      if (pivotB.price < pivotA.price) {
        direction = "up";
        pivotLow = pivotB;
        pivotHigh = pivotA;
      } else {
        direction = "down";
        pivotHigh = pivotB;
        pivotLow = pivotA;
      }
    }
  }

  const swingHigh = pivotHigh.price;
  const swingLow = pivotLow.price;
  const range = swingHigh - swingLow;
  if (range <= 0) return null;

  // Retracement levels — measured from the END of the swing
  // For "up" swing: retracements go DOWN from swingHigh
  // For "down" swing: retracements go UP from swingLow
  const RETRACE_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.705, 0.786];
  const retracements: FibLevel[] = RETRACE_RATIOS.map(ratio => {
    const price = direction === "up"
      ? swingHigh - range * ratio   // retracing down from high
      : swingLow + range * ratio;   // retracing up from low
    return {
      ratio,
      price,
      label: `${(ratio * 100).toFixed(1)}%`,
      type: "retracement" as const,
    };
  });

  // Extension levels — measured BEYOND the swing end
  // For "up" swing: extensions go ABOVE swingHigh (bullish targets)
  // For "down" swing: extensions go BELOW swingLow (bearish targets)
  const EXT_RATIOS = [1.272, 1.618];
  const extensions: FibLevel[] = EXT_RATIOS.map(ratio => {
    const price = direction === "up"
      ? swingLow + range * ratio    // extending above the high
      : swingHigh - range * ratio;  // extending below the low
    return {
      ratio,
      price,
      label: `-${((ratio - 1) * 100).toFixed(1)}%`,  // -27.2%, -61.8%
      type: "extension" as const,
    };
  });

  return { swingHigh, swingLow, direction, retracements, extensions, pivotHigh, pivotLow };
}

// ─── Enhanced Market Structure Analysis ──────────────────────────────
// Improvements over the original::
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
  significance?: "internal" | "external";  // internal = broke a minor swing, external = broke a major structural swing
  derivedSR?: { price: number; type: "support" | "resistance"; broken: boolean };  // auto S/R from BOS (LuxAlgo-inspired)
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
  // ── Dual-Lookback Swing Detection (Internal vs External) ──
  // Internal swings: minor pullback pivots (lookback=3, lower ATR filter)
  // External swings: major structural pivots (lookback=7, higher ATR filter)
  const internalLookback = structureLookback && structureLookback > 0 ? structureLookback : 3;
  const externalLookback = Math.max(internalLookback + 4, 7); // at least 7, always larger than internal
  const hasEnoughForATR = candles.length >= 15;

  const internalSwings = detectSwingPoints(candles, internalLookback, hasEnoughForATR ? 0.2 : 0);
  const externalSwings = detectSwingPoints(candles, externalLookback, hasEnoughForATR ? 0.5 : 0);

  // Tag significance on each swing
  for (const s of internalSwings) s.significance = "internal";
  for (const s of externalSwings) s.significance = "external";

  // Build external swing index set for quick lookup
  const externalSet = new Set(externalSwings.map(s => `${s.type}_${s.index}`));

  // Merge: external swings override internal at the same index.
  // Internal swings that also appear as external get promoted to "external".
  const mergedMap = new Map<string, SwingPoint>();
  for (const s of internalSwings) {
    const key = `${s.type}_${s.index}`;
    if (externalSet.has(key)) {
      s.significance = "external"; // promote
    }
    mergedMap.set(key, s);
  }
  // Add any external swings not already in internal set (different lookback may find different pivots)
  for (const s of externalSwings) {
    const key = `${s.type}_${s.index}`;
    if (!mergedMap.has(key)) {
      mergedMap.set(key, s);
    }
  }
  const swings = Array.from(mergedMap.values()).sort((a, b) => a.index - b.index);

  const highs = swings.filter(s => s.type === "high");
  const lows = swings.filter(s => s.type === "low");
  let currentTrend: "bullish" | "bearish" | "ranging" = "ranging";
  const bos: StructureBreak[] = [];
  const choch: StructureBreak[] = [];
  const sweeps: LiquiditySweep[] = [];

  // ── Process all swing breaks chronologically to properly track trend transitions ──
  type SwingEvent = { swingType: "high" | "low"; prevLevel: number; index: number; prevSwingIdx: number; significance: "internal" | "external" };
  const events: SwingEvent[] = [];
  for (let i = 1; i < highs.length; i++) {
    // The significance of the BOS is determined by the swing that was BROKEN (the previous one)
    events.push({
      swingType: "high", prevLevel: highs[i - 1].price, index: highs[i].index,
      prevSwingIdx: highs[i - 1].index, significance: highs[i - 1].significance || "internal",
    });
  }
  for (let i = 1; i < lows.length; i++) {
    events.push({
      swingType: "low", prevLevel: lows[i - 1].price, index: lows[i].index,
      prevSwingIdx: lows[i - 1].index, significance: lows[i - 1].significance || "internal",
    });
  }
  events.sort((a, b) => a.index - b.index);

  for (const evt of events) {
    const breakCandle = candles[evt.index];
    if (!breakCandle) continue;

    if (evt.swingType === "high" && breakCandle.high > evt.prevLevel) {
      const closedThrough = breakCandle.close > evt.prevLevel;
      if (closedThrough) {
        // ── Auto S/R from BOS (LuxAlgo-inspired) ──
        // After bullish BOS: find the lowest low between the broken swing and the break candle → support
        let derivedSR: StructureBreak["derivedSR"] = undefined;
        const scanStart = evt.prevSwingIdx + 1;
        const scanEnd = evt.index;
        if (scanEnd > scanStart) {
          let minLow = Infinity;
          for (let k = scanStart; k < scanEnd; k++) {
            if (candles[k] && candles[k].low < minLow) minLow = candles[k].low;
          }
          if (minLow < Infinity) {
            // S/R lifecycle: check if any candle AFTER the break closed below this support
            let broken = false;
            for (let k = evt.index + 1; k < candles.length; k++) {
              if (candles[k] && candles[k].close < minLow) { broken = true; break; }
            }
            derivedSR = { price: minLow, type: "support", broken };
          }
        }

        const entry: StructureBreak = {
          index: evt.index, type: "bullish", price: breakCandle.high,
          datetime: breakCandle.datetime, closeBased: true, level: evt.prevLevel,
          significance: evt.significance, derivedSR,
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
        // ── Auto S/R from BOS: after bearish BOS, find highest high → resistance ──
        let derivedSR: StructureBreak["derivedSR"] = undefined;
        const scanStart = evt.prevSwingIdx + 1;
        const scanEnd = evt.index;
        if (scanEnd > scanStart) {
          let maxHigh = -Infinity;
          for (let k = scanStart; k < scanEnd; k++) {
            if (candles[k] && candles[k].high > maxHigh) maxHigh = candles[k].high;
          }
          if (maxHigh > -Infinity) {
            let broken = false;
            for (let k = evt.index + 1; k < candles.length; k++) {
              if (candles[k] && candles[k].close > maxHigh) { broken = true; break; }
            }
            derivedSR = { price: maxHigh, type: "resistance", broken };
          }
        }

        const entry: StructureBreak = {
          index: evt.index, type: "bearish", price: breakCandle.low,
          datetime: breakCandle.datetime, closeBased: true, level: evt.prevLevel,
          significance: evt.significance, derivedSR,
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
  for (let i = 0; i < highs.length; i++) {
    const level = highs[i].price;
    const startIdx = highs[i].index + 1;
    const endIdx = (i + 1 < highs.length) ? highs[i + 1].index : candles.length;
    for (let ci = startIdx; ci < endIdx; ci++) {
      const c = candles[ci];
      if (!c) continue;
      if (c.high > level && c.close <= level) {
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
  for (let i = 0; i < lows.length; i++) {
    const level = lows[i].price;
    const startIdx = lows[i].index + 1;
    const endIdx = (i + 1 < lows.length) ? lows[i + 1].index : candles.length;
    for (let ci = startIdx; ci < endIdx; ci++) {
      const c = candles[ci];
      if (!c) continue;
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

  // ── Structure-to-Fractal Conversion Rate ──
  // What % of detected swing highs led to a bullish BOS/CHoCH? (fractal → structure break)
  // What % of detected swing lows led to a bearish BOS/CHoCH?
  // High rate = strong trend (swings keep breaking). Low rate = range (swings hold as S/R).
  const totalHighFractals = Math.max(1, highs.length);
  const totalLowFractals = Math.max(1, lows.length);
  const bullishBreaks = bos.filter(b => b.type === "bullish").length + choch.filter(c => c.type === "bullish").length;
  const bearishBreaks = bos.filter(b => b.type === "bearish").length + choch.filter(c => c.type === "bearish").length;
  const structureToFractal = {
    bullishRate: bullishBreaks / totalHighFractals,  // % of swing highs that got broken
    bearishRate: bearishBreaks / totalLowFractals,   // % of swing lows that got broken
    totalFractals: highs.length + lows.length,
    totalBreaks: bullishBreaks + bearishBreaks,
    overallRate: (bullishBreaks + bearishBreaks) / Math.max(1, highs.length + lows.length),
  };

  // ── Count internal vs external breaks for downstream scoring ──
  const internalBOS = bos.filter(b => b.significance === "internal").length;
  const externalBOS = bos.filter(b => b.significance === "external").length;
  const internalCHoCH = choch.filter(c => c.significance === "internal").length;
  const externalCHoCH = choch.filter(c => c.significance === "external").length;

  // ── Collect active (unbroken) derived S/R levels ──
  const allBreaks = [...bos, ...choch];
  const activeDerivedSR = allBreaks
    .filter(b => b.derivedSR && !b.derivedSR.broken)
    .map(b => b.derivedSR!);
  const brokenDerivedSR = allBreaks
    .filter(b => b.derivedSR && b.derivedSR.broken)
    .map(b => b.derivedSR!);

  // ── Swing Point Lifecycle Write-Back ──
  // Now that BOS, CHoCH, and sweeps are computed, write the results back onto the swing points.
  // This lets downstream consumers see each swing's full history without re-deriving it.
  const swingMap = new Map<string, SwingPoint>();
  for (const s of swings) swingMap.set(`${s.type}_${s.index}`, s);

  // BOS/CHoCH = swing was broken (price closed through)
  for (const brk of [...bos, ...choch]) {
    // Find the swing that was broken: it's the previous swing at brk.level
    // We need to find the swing whose price matches brk.level
    const swingType = brk.type === "bullish" ? "high" : "low";
    const relevantSwings = swings.filter(s => s.type === swingType && Math.abs(s.price - brk.level) < 0.000001);
    for (const sw of relevantSwings) {
      if (sw.index < brk.index) {
        sw.state = "broken";
        sw.brokenAt = brk.index;
      }
    }
  }

  // Sweeps = swing was swept (wick through but close held)
  for (const sweep of sweeps) {
    const swingType = sweep.type === "bullish" ? "low" : "high";
    const relevantSwings = swings.filter(s => s.type === swingType && Math.abs(s.price - sweep.sweptLevel) < 0.000001);
    for (const sw of relevantSwings) {
      if (sw.index < sweep.index && sw.state !== "broken") {
        sw.state = "swept";
        sw.sweptAt = sweep.index;
      }
    }
  }

  // Test detection: for remaining active swings, scan subsequent candles for approaches
  const swingATR = candles.length >= 15 ? calculateATR(candles, 14) : 0;
  const testTolerance = swingATR > 0 ? swingATR * 0.15 : 0; // 15% of ATR = "approaching"
  for (const sw of swings) {
    if (sw.state !== "active") continue; // already broken or swept
    for (let k = sw.index + 1; k < candles.length; k++) {
      const c = candles[k];
      if (sw.type === "high") {
        // Test = price came within tolerance of the swing high but didn't break through
        if (c.high >= sw.price - testTolerance && c.high < sw.price) {
          sw.testedCount++;
          if (sw.state === "active") sw.state = "tested";
        }
      } else {
        // Test = price came within tolerance of the swing low but didn't break through
        if (c.low <= sw.price + testTolerance && c.low > sw.price) {
          sw.testedCount++;
          if (sw.state === "active") sw.state = "tested";
        }
      }
    }
  }

  return {
    trend, swingPoints: swings, bos, choch, sweeps,
    // New fields — all backward compatible (optional consumption)
    structureToFractal,
    structureCounts: { internalBOS, externalBOS, internalCHoCH, externalCHoCH },
    derivedSR: { active: activeDerivedSR, broken: brokenDerivedSR },
  };
}

export function detectOrderBlocks(candles: Candle[], structureBreaks?: { index: number; type: string }[], obLookbackOverride?: number): OrderBlock[] {
  // Volume pivot detection helper (LuxAlgo-inspired)
  // A volume pivot exists when a candle's volume is the highest within ±pivotLen bars
  const VOLUME_PIVOT_LEN = 5;
  const hasVolumeData = candles.some(c => c.volume != null && c.volume > 0);
  function isVolumePivot(idx: number): boolean {
    if (!hasVolumeData) return false;
    const vol = candles[idx]?.volume;
    if (vol == null || vol <= 0) return false;
    const start = Math.max(0, idx - VOLUME_PIVOT_LEN);
    const end = Math.min(candles.length - 1, idx + VOLUME_PIVOT_LEN);
    for (let k = start; k <= end; k++) {
      if (k === idx) continue;
      const kVol = candles[k]?.volume;
      if (kVol != null && kVol > vol) return false;
    }
    return true;
  }
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

  // ── Scan-back helper: find the last opposite-color candle within N bars before
  // the engulfing candle (PineScript-inspired). This catches OBs where small
  // consolidation candles sit between the institutional candle and the displacement.
  const OB_SCANBACK = 10;
  function findLastBearishCandle(fromIdx: number, minIdx: number): number {
    const start = Math.max(minIdx, fromIdx - OB_SCANBACK);
    for (let k = fromIdx; k >= start; k--) {
      if (candles[k] && candles[k].close < candles[k].open) return k;
    }
    return -1; // none found
  }
  function findLastBullishCandle(fromIdx: number, minIdx: number): number {
    const start = Math.max(minIdx, fromIdx - OB_SCANBACK);
    for (let k = fromIdx; k >= start; k--) {
      if (candles[k] && candles[k].close > candles[k].open) return k;
    }
    return -1; // none found
  }

  // ── Wick extension helper: body + 50% of wicks for more accurate institutional footprint ──
  function obZoneWithWicks(c: Candle): { high: number; low: number } {
    const bodyHigh = Math.max(c.open, c.close);
    const bodyLow = Math.min(c.open, c.close);
    const upperWick = c.high - bodyHigh;
    const lowerWick = bodyLow - c.low;
    return {
      high: bodyHigh + upperWick * 0.5,
      low: bodyLow - lowerWick * 0.5,
    };
  }

  for (let i = recencyStart; i < candles.length; i++) {
    const prev = candles[i - 1], curr = candles[i];
    // Bullish OB: bullish engulfing candle that closes above prev candle's high
    // Scan back up to OB_SCANBACK bars for the last bearish candle (institutional candle)
    if (curr.close > curr.open && curr.close > candles[i - 1].high) {
      const obIdx = findLastBearishCandle(i - 1, recencyStart);
      if (obIdx < 0) continue; // no bearish candle found in scan range
      const obCandle = candles[obIdx];
      const zone = obZoneWithWicks(obCandle);
      const ob: OrderBlock & { quality: number } = {
        index: obIdx, high: zone.high, low: zone.low, type: "bullish",
        datetime: obCandle.datetime, mitigated: false, mitigatedPercent: 0,
        hasDisplacement: false, hasFVGAdjacency: false, quality: 0,
        state: "fresh", testedCount: 0,
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
      // ── Lifecycle tracking: scan all candles after OB creation ──
      // Track tests (price enters zone edge), mitigation (50%+ penetration), and broken (close through)
      const obRange = ob.high - ob.low;
      for (let j = i + 1; j < candles.length; j++) {
        const c = candles[j];
        // "Broken" = candle closes fully below the OB low (for bullish OB)
        if (c.close < ob.low) {
          ob.state = "broken";
          ob.brokenAt = j;
          ob.mitigatedPercent = 100;
          ob.mitigated = true;
          if (!ob.mitigatedAt) ob.mitigatedAt = j;
          break;
        }
        // "Mitigated" = price penetrated 50%+ into the zone
        const mid = (ob.high + ob.low) / 2;
        if (c.low <= mid) {
          const penetration = Math.min(100, ((ob.high - c.low) / obRange) * 100);
          if (penetration > ob.mitigatedPercent) ob.mitigatedPercent = penetration;
          if (ob.mitigatedPercent >= 50 && !ob.mitigated) {
            ob.mitigated = true;
            ob.mitigatedAt = j;
            if (ob.state === "fresh" || ob.state === "tested") ob.state = "mitigated";
          }
          // Also counts as a test
          if (!ob.firstTestedAt) ob.firstTestedAt = j;
          ob.testedCount++;
        }
        // "Tested" = price entered the zone (touched ob.high from above) but didn't penetrate 50%
        else if (c.low <= ob.high && c.low > mid) {
          if (ob.state === "fresh") ob.state = "tested";
          if (!ob.firstTestedAt) ob.firstTestedAt = j;
          ob.testedCount++;
        }
      }
      // Quality scoring: structure break nearby = +2, displacement = +2, volume pivot = +2, recency bonus
      if (structureBreaks && structureBreaks.length > 0) {
        const hasBreak = structureBreaks.some(b => b.type === "bullish" && b.index > ob.index && b.index <= ob.index + BREAK_LOOKAHEAD);
        if (hasBreak) ob.quality += 2;
      } else { ob.quality += 1; }
      if (ob.hasDisplacement) ob.quality += 2;
      // Volume pivot bonus: OB candle or engulfing candle had highest volume in surrounding bars
      if (isVolumePivot(obIdx) || isVolumePivot(i)) {
        ob.hasVolumePivot = true;
        ob.quality += 2;
      }
      ob.quality += (ob.index - recencyStart) / OB_RECENCY; // recency bonus
      candidates.push(ob);
    }
    // Bearish OB: bearish engulfing candle that closes below prev candle's low
    // Scan back up to OB_SCANBACK bars for the last bullish candle (institutional candle)
    if (curr.close < curr.open && curr.close < candles[i - 1].low) {
      const obIdx = findLastBullishCandle(i - 1, recencyStart);
      if (obIdx < 0) continue; // no bullish candle found in scan range
      const obCandle = candles[obIdx];
      const zone = obZoneWithWicks(obCandle);
      const ob: OrderBlock & { quality: number } = {
        index: obIdx, high: zone.high, low: zone.low, type: "bearish",
        datetime: obCandle.datetime, mitigated: false, mitigatedPercent: 0,
        hasDisplacement: false, hasFVGAdjacency: false, quality: 0,
        state: "fresh", testedCount: 0,
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
      // ── Lifecycle tracking: scan all candles after OB creation ──
      const obRange = ob.high - ob.low;
      for (let j = i + 1; j < candles.length; j++) {
        const c = candles[j];
        // "Broken" = candle closes fully above the OB high (for bearish OB)
        if (c.close > ob.high) {
          ob.state = "broken";
          ob.brokenAt = j;
          ob.mitigatedPercent = 100;
          ob.mitigated = true;
          if (!ob.mitigatedAt) ob.mitigatedAt = j;
          break;
        }
        // "Mitigated" = price penetrated 50%+ into the zone
        const mid = (ob.high + ob.low) / 2;
        if (c.high >= mid) {
          const penetration = Math.min(100, ((c.high - ob.low) / obRange) * 100);
          if (penetration > ob.mitigatedPercent) ob.mitigatedPercent = penetration;
          if (ob.mitigatedPercent >= 50 && !ob.mitigated) {
            ob.mitigated = true;
            ob.mitigatedAt = j;
            if (ob.state === "fresh" || ob.state === "tested") ob.state = "mitigated";
          }
          if (!ob.firstTestedAt) ob.firstTestedAt = j;
          ob.testedCount++;
        }
        // "Tested" = price entered the zone (touched ob.low from below) but didn't penetrate 50%
        else if (c.high >= ob.low && c.high < mid) {
          if (ob.state === "fresh") ob.state = "tested";
          if (!ob.firstTestedAt) ob.firstTestedAt = j;
          ob.testedCount++;
        }
      }
      // Quality scoring
      if (structureBreaks && structureBreaks.length > 0) {
        const hasBreak = structureBreaks.some(b => b.type === "bearish" && b.index > ob.index && b.index <= ob.index + BREAK_LOOKAHEAD);
        if (hasBreak) ob.quality += 2;
      } else { ob.quality += 1; }
      if (ob.hasDisplacement) ob.quality += 2;
      // Volume pivot bonus: OB candle or engulfing candle had highest volume in surrounding bars
      if (isVolumePivot(obIdx) || isVolumePivot(i)) {
        ob.hasVolumePivot = true;
        ob.quality += 2;
      }
      ob.quality += (ob.index - recencyStart) / OB_RECENCY;
      candidates.push(ob);
    }
  }
  candidates.sort((a, b) => b.quality - a.quality || b.index - a.index);
  return candidates.slice(0, OB_CAP).map(({ quality, ...ob }) => ob);
}

export function detectFVGs(
  candles: Candle[],
  structureBreaks?: { index: number; type: string }[],
): FairValueGap[] {
  const fvgs: FairValueGap[] = [];
  // Only look at recent candles (last 50) to avoid stale FVGs from hours ago
  const FVG_RECENCY = 50;
  const startIdx = Math.max(2, candles.length - FVG_RECENCY);

  // Pre-compute ATR for quality scoring (size relative to ATR)
  const atr = calculateATR(candles, 14);

  for (let i = startIdx; i < candles.length; i++) {
    const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i];
    // Bullish FVG: gap up — candle 3 low > candle 1 high, middle candle is bullish
    if (c3.low > c1.high && c2.close > c2.open) {
      const fvg: FairValueGap = {
        index: i - 1, high: c3.low, low: c1.high, type: "bullish", datetime: c2.datetime,
        mitigated: false, state: "open", fillPercent: 0, respectedCount: 0,
      };
      // ── Lifecycle tracking: scan all candles after FVG creation ──
      const gapSize = fvg.high - fvg.low;
      for (let j = i + 1; j < candles.length; j++) {
        const c = candles[j];
        // Fully filled: price closed through the entire gap (low went below fvg.low for bullish)
        if (c.low <= fvg.low) {
          fvg.mitigated = true;
          fvg.state = "filled";
          fvg.fillPercent = 100;
          fvg.filledAt = j;
          if (!fvg.firstTestedAt) fvg.firstTestedAt = j;
          break;
        }
        // Partial fill: price entered the gap but didn't close through
        if (c.low < fvg.high) {
          const penetration = Math.min(100, ((fvg.high - c.low) / gapSize) * 100);
          if (penetration > fvg.fillPercent) fvg.fillPercent = penetration;
          if (!fvg.firstTestedAt) fvg.firstTestedAt = j;
          if (fvg.fillPercent > 0 && fvg.fillPercent < 100 && fvg.state === "open") {
            fvg.state = "partially_filled";
          }
        }
        // Respected: price approached the FVG top edge (within 20% of gap size) but bounced away
        // A "respect" = the candle's low came within the top 20% of the gap AND the candle closed above the gap top
        else if (c.low <= fvg.high + gapSize * 0.2 && c.close > fvg.high) {
          fvg.respectedCount++;
          if (fvg.state === "open" && fvg.respectedCount >= 1) fvg.state = "respected";
        }
      }
      fvg.quality = scoreFVGQuality(fvg, c2, atr, i - 1, "bullish", structureBreaks);
      fvgs.push(fvg);
    }
    // Bearish FVG: gap down — candle 1 low > candle 3 high, middle candle is bearish
    if (c1.low > c3.high && c2.close < c2.open) {
      const fvg: FairValueGap = {
        index: i - 1, high: c1.low, low: c3.high, type: "bearish", datetime: c2.datetime,
        mitigated: false, state: "open", fillPercent: 0, respectedCount: 0,
      };
      const gapSize = fvg.high - fvg.low;
      for (let j = i + 1; j < candles.length; j++) {
        const c = candles[j];
        // Fully filled: price closed through the entire gap (high went above fvg.high for bearish)
        if (c.high >= fvg.high) {
          fvg.mitigated = true;
          fvg.state = "filled";
          fvg.fillPercent = 100;
          fvg.filledAt = j;
          if (!fvg.firstTestedAt) fvg.firstTestedAt = j;
          break;
        }
        // Partial fill: price entered the gap from below
        if (c.high > fvg.low) {
          const penetration = Math.min(100, ((c.high - fvg.low) / gapSize) * 100);
          if (penetration > fvg.fillPercent) fvg.fillPercent = penetration;
          if (!fvg.firstTestedAt) fvg.firstTestedAt = j;
          if (fvg.fillPercent > 0 && fvg.fillPercent < 100 && fvg.state === "open") {
            fvg.state = "partially_filled";
          }
        }
        // Respected: price approached the FVG bottom edge but bounced away
        else if (c.high >= fvg.low - gapSize * 0.2 && c.close < fvg.low) {
          fvg.respectedCount++;
          if (fvg.state === "open" && fvg.respectedCount >= 1) fvg.state = "respected";
        }
      }
      fvg.quality = scoreFVGQuality(fvg, c2, atr, i - 1, "bearish", structureBreaks);
      fvgs.push(fvg);
    }
  }
  return fvgs;
}

/**
 * Score FVG quality 0-8 based on institutional significance:
 *   +3  displacement-created (middle candle body > 1.5× ATR)
 *   +0-2  gap size relative to ATR (capped at 2)
 *   +0-1  middle candle body ratio (body / total range)
 *   +2  structure break (BOS/CHoCH) within 5 bars of the FVG
 */
function scoreFVGQuality(
  fvg: FairValueGap,
  middleCandle: Candle,
  atr: number,
  fvgIndex: number,
  fvgType: "bullish" | "bearish",
  structureBreaks?: { index: number; type: string }[],
): number {
  let quality = 0;

  // 1. Displacement: middle candle body > 1.5× ATR → strong institutional move
  const body = Math.abs(middleCandle.close - middleCandle.open);
  if (atr > 0 && body > atr * 1.5) quality += 3;

  // 2. Gap size relative to ATR: larger gaps = more institutional significance
  const gapSize = fvg.high - fvg.low;
  if (atr > 0) {
    const sizeRatio = gapSize / atr;
    quality += Math.min(2, sizeRatio); // 0-2 continuous, capped at 2
  }

  // 3. Body ratio: high body-to-range = conviction candle (not indecisive)
  const range = middleCandle.high - middleCandle.low;
  if (range > 0) {
    quality += body / range; // 0-1 continuous
  }

  // 4. Structure break nearby: FVG formed right after BOS/CHoCH confirms structural shift
  if (structureBreaks && structureBreaks.length > 0) {
    const hasNearbyBreak = structureBreaks.some(
      b => b.type === fvgType && Math.abs(b.index - fvgIndex) <= 5
    );
    if (hasNearbyBreak) quality += 2;
  }

  return Math.round(quality * 10) / 10; // 1 decimal precision
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
      let state: LiquidityPool["state"] = "active";
      let sweepDepth: number | undefined;
      let retestedAt: number | undefined;
      let retestedHeld: boolean | undefined;

      // Find the FIRST candle that swept above this pool level
      for (let k = i + 1; k < candles.length; k++) {
        if (candles[k].high > poolPrice) {
          swept = true;
          sweptAtIndex = k;
          sweepDepth = candles[k].high - poolPrice;
          if (candles[k].close < poolPrice) {
            rejectionConfirmed = true;
            state = "swept_rejected";
          } else {
            // Price closed above = liquidity absorbed (continuation)
            state = "swept_absorbed";
          }
          // After sweep, check for retest from the other side
          // Buy-side swept = level may now act as support. Check if price comes back down to test it.
          for (let r = k + 1; r < candles.length; r++) {
            if (candles[r].low <= poolPrice + tol && candles[r].low >= poolPrice - tol) {
              retestedAt = r;
              retestedHeld = candles[r].close > poolPrice; // held as support?
              if (retestedHeld) state = "retested";
              break;
            }
          }
          break;
        }
      }
      if (i >= candles.length - 80 || swept) {
        pools.push({ price: poolPrice, type: "buy-side", strength: count, datetime: candles[i].datetime, swept, sweptAtIndex, rejectionConfirmed, state, sweepDepth, retestedAt, retestedHeld });
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
      let state: LiquidityPool["state"] = "active";
      let sweepDepth: number | undefined;
      let retestedAt: number | undefined;
      let retestedHeld: boolean | undefined;

      for (let k = i + 1; k < candles.length; k++) {
        if (candles[k].low < poolPrice) {
          swept = true;
          sweptAtIndex = k;
          sweepDepth = poolPrice - candles[k].low;
          if (candles[k].close > poolPrice) {
            rejectionConfirmed = true;
            state = "swept_rejected";
          } else {
            state = "swept_absorbed";
          }
          // After sweep, check for retest from the other side
          // Sell-side swept = level may now act as resistance. Check if price comes back up.
          for (let r = k + 1; r < candles.length; r++) {
            if (candles[r].high >= poolPrice - tol && candles[r].high <= poolPrice + tol) {
              retestedAt = r;
              retestedHeld = candles[r].close < poolPrice; // held as resistance?
              if (retestedHeld) state = "retested";
              break;
            }
          }
          break;
        }
      }
      if (i >= candles.length - 80 || swept) {
        pools.push({ price: poolPrice, type: "sell-side", strength: count, datetime: candles[i].datetime, swept, sweptAtIndex, rejectionConfirmed, state, sweepDepth, retestedAt, retestedHeld });
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

export function detectBreakerBlocks(orderBlocks: OrderBlock[], candles: Candle[], structureBreaks?: { index: number; type: string }[]): BreakerBlock[] {
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
    // BB vs MB distinction (PineScript-inspired):
    // "breaker" = the MSB that broke this OB also made a new HH (bearish breaker) or LL (bullish breaker)
    // "mitigation_block" = OB was broken but no new structural extreme was confirmed
    let subtype: "breaker" | "mitigation_block" = "mitigation_block";
    if (structureBreaks && structureBreaks.length > 0) {
      // A true breaker has a structure break (BOS/CHoCH) near the mitigation point
      // that confirms the structural shift (new extreme in the direction of the break)
      const wantBreakType = breakerType === "bullish_breaker" ? "bullish" : "bearish";
      const hasConfirmingBreak = structureBreaks.some(
        b => b.type === wantBreakType && b.index >= ob.index && b.index <= mitigatedAt + 10
      );
      if (hasConfirmingBreak) subtype = "breaker";
    } else {
      // Without structure break data, check price action for new extreme
      if (breakerType === "bearish_breaker") {
        // Bearish breaker from a failed bullish OB: check if price made new HH after mitigation
        let prevHigh = ob.high;
        for (let j = mitigatedAt; j < Math.min(mitigatedAt + 15, candles.length); j++) {
          if (candles[j].high > prevHigh) { subtype = "breaker"; break; }
        }
      } else {
        // Bullish breaker from a failed bearish OB: check if price made new LL after mitigation
        let prevLow = ob.low;
        for (let j = mitigatedAt; j < Math.min(mitigatedAt + 15, candles.length); j++) {
          if (candles[j].low < prevLow) { subtype = "breaker"; break; }
        }
      }
    }
    let isActive = true;
    let breakerState: BreakerBlock["state"] = "active";
    let testedCount = 0;
    let respectedAt: number | undefined;
    let brokenAt: number | undefined;

    for (let j = mitigatedAt + 1; j < candles.length; j++) {
      const c = candles[j];
      const enteredZone = c.high >= ob.low && c.low <= ob.high;
      if (!enteredZone) continue;

      // Check if price closed through the zone (broken)
      if (breakerType === "bearish_breaker") {
        if (c.close < ob.low) {
          isActive = false;
          breakerState = "broken";
          brokenAt = j;
          break;
        }
        // Respected = entered zone but bounced (closed above zone midpoint)
        const mid = (ob.high + ob.low) / 2;
        if (c.close > mid) {
          if (breakerState === "active" || breakerState === "tested") breakerState = "respected";
          if (!respectedAt) respectedAt = j;
        }
      } else {
        if (c.close > ob.high) {
          isActive = false;
          breakerState = "broken";
          brokenAt = j;
          break;
        }
        const mid = (ob.high + ob.low) / 2;
        if (c.close < mid) {
          if (breakerState === "active" || breakerState === "tested") breakerState = "respected";
          if (!respectedAt) respectedAt = j;
        }
      }
      testedCount++;
      if (breakerState === "active") breakerState = "tested";
    }
    breakers.push({ type: breakerType, subtype, high: ob.high, low: ob.low, mitigatedAt, originalOBType: ob.type, isActive, state: breakerState, testedCount, respectedAt, brokenAt });
  }
  // Return ALL breakers (including broken) for history — downstream can filter by state
  return breakers;
}

export function detectUnicornSetups(breakerBlocks: BreakerBlock[], fvgs: FairValueGap[]): UnicornSetup[] {
  const unicorns: UnicornSetup[] = [];
  // Lifecycle-aware: use FVGs that aren't fully filled
  const viableFVGs = fvgs.filter(f => f.state !== "filled");
  for (const breaker of breakerBlocks) {
    // Include all breakers for detection, but mark invalidated ones
    const wantFVGType = breaker.type === "bullish_breaker" ? "bullish" : "bearish";
    for (const fvg of viableFVGs) {
      if (fvg.type !== wantFVGType) continue;
      const overlapLow = Math.max(breaker.low, fvg.low);
      const overlapHigh = Math.min(breaker.high, fvg.high);
      if (overlapLow < overlapHigh) {
        // Determine unicorn lifecycle state
        let uniState: UnicornSetup["state"] = "active";
        let invalidationReason: UnicornSetup["invalidationReason"];

        if (breaker.state === "broken") {
          uniState = "invalidated";
          invalidationReason = "breaker_broken";
        } else if (fvg.state === "filled") {
          uniState = "invalidated";
          invalidationReason = "fvg_filled";
        } else if (!breaker.isActive) {
          uniState = "invalidated";
          invalidationReason = "price_through";
        }

        unicorns.push({
          type: breaker.type === "bullish_breaker" ? "bullish_unicorn" : "bearish_unicorn",
          breakerHigh: breaker.high, breakerLow: breaker.low,
          fvgHigh: fvg.high, fvgLow: fvg.low, overlapHigh, overlapLow,
          state: uniState, invalidationReason,
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
  const curr = dailyCandles[dailyCandles.length - 1];

  // ── Proper weekly aggregation ──
  // Walk backwards to find the boundary between the current week and the previous week.
  // Use UTC day-of-week (0=Sun). The most recent Monday starts the current week.
  const parseDow = (d: string) => new Date(d).getUTCDay();
  let currentWeekStart = -1;
  for (let i = dailyCandles.length - 1; i >= 0; i--) {
    if (parseDow(dailyCandles[i].datetime) === 1) { // Monday
      currentWeekStart = i;
      break;
    }
  }
  // Previous week = candles before currentWeekStart, back to the Monday before that
  let prevWeekCandles: Candle[] = [];
  if (currentWeekStart > 0) {
    let prevWeekEnd = currentWeekStart - 1;
    let prevWeekStartIdx = 0;
    for (let i = prevWeekEnd; i >= 0; i--) {
      if (parseDow(dailyCandles[i].datetime) === 1) {
        prevWeekStartIdx = i;
        break;
      }
    }
    prevWeekCandles = dailyCandles.slice(prevWeekStartIdx, prevWeekEnd + 1);
  }
  // Fallback: if we can't find proper week boundaries, use last 5 candles before current
  if (prevWeekCandles.length === 0) {
    const endIdx = currentWeekStart > 0 ? currentWeekStart : dailyCandles.length - 1;
    prevWeekCandles = dailyCandles.slice(Math.max(0, endIdx - 5), endIdx);
  }

  // ── Monthly open ──
  // Find the first candle of the current calendar month
  const currDate = new Date(curr.datetime);
  const currMonth = currDate.getUTCMonth();
  const currYear = currDate.getUTCFullYear();
  let monthOpen = curr.open; // fallback
  for (let i = 0; i < dailyCandles.length; i++) {
    const d = new Date(dailyCandles[i].datetime);
    if (d.getUTCFullYear() === currYear && d.getUTCMonth() === currMonth) {
      monthOpen = dailyCandles[i].open;
      break;
    }
  }

  // ── Current week open ──
  const weekOpen = currentWeekStart >= 0 ? dailyCandles[currentWeekStart].open : curr.open;

  return {
    // Previous day
    pdh: prev.high, pdl: prev.low, pdo: prev.open, pdc: prev.close,
    // Previous week (properly aggregated)
    pwh: Math.max(...prevWeekCandles.map(c => c.high)),
    pwl: Math.min(...prevWeekCandles.map(c => c.low)),
    pwo: prevWeekCandles[0].open,
    pwc: prevWeekCandles[prevWeekCandles.length - 1].close,
    // Current-period opens (new)
    dailyOpen: curr.open,   // DO — today's opening price
    weeklyOpen: weekOpen,   // WO — this week's opening price
    monthlyOpen: monthOpen, // MO — this month's opening price
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

  // ── FVG-aware SL tightening ──
  // If an unfilled, high-quality FVG sits between entry and SL, tighten SL to FVG boundary.
  // Rationale: an institutional FVG acts as support/resistance — SL just beyond it is safer.
  const activeFVGs = input.fvgs?.filter(f => !f.mitigated && (f.quality ?? 0) >= 4) || [];
  if (sl !== null && activeFVGs.length > 0) {
    if (direction === "long") {
      // Find bullish FVGs between SL and entry (support zones)
      const supportFVGs = activeFVGs
        .filter(f => f.type === "bullish" && f.low > sl! && f.low < lastPrice)
        .sort((a, b) => b.low - a.low); // closest to entry first
      if (supportFVGs.length > 0) {
        const tighterSL = supportFVGs[0].low - buffer;
        // Only tighten if it reduces SL distance by at least 20% (avoid micro-adjustments)
        if (tighterSL > sl && (lastPrice - tighterSL) < (lastPrice - sl) * 0.8) {
          sl = tighterSL;
        }
      }
    } else {
      // Find bearish FVGs between entry and SL (resistance zones)
      const resistFVGs = activeFVGs
        .filter(f => f.type === "bearish" && f.high < sl! && f.high > lastPrice)
        .sort((a, b) => a.high - b.high); // closest to entry first
      if (resistFVGs.length > 0) {
        const tighterSL = resistFVGs[0].high + buffer;
        if (tighterSL < sl && (tighterSL - lastPrice) < (sl - lastPrice) * 0.8) {
          sl = tighterSL;
        }
      }
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

  // ── FVG-aware TP extension ──
  // If an unfilled, high-quality FVG exists beyond the TP in the trade direction,
  // extend TP to the far edge of that FVG (price is likely to fill it).
  if (tp !== null && activeFVGs.length > 0) {
    if (direction === "long") {
      // Find bearish FVGs (targets for longs) just beyond current TP
      const targetFVGs = activeFVGs
        .filter(f => f.type === "bearish" && f.high > tp! && f.high < lastPrice + slDistance * 4) // cap at 4× SL distance
        .sort((a, b) => a.high - b.high); // nearest first
      if (targetFVGs.length > 0) {
        tp = targetFVGs[0].high; // extend TP to far edge of the FVG
      }
    } else {
      // Find bullish FVGs (targets for shorts) just beyond current TP
      const targetFVGs = activeFVGs
        .filter(f => f.type === "bullish" && f.low < tp! && f.low > lastPrice - slDistance * 4)
        .sort((a, b) => b.low - a.low); // nearest first
      if (targetFVGs.length > 0) {
        tp = targetFVGs[0].low; // extend TP to far edge of the FVG
      }
    }
  }

  // ── Fib Extension TP Intelligence ──
  // Uses pre-computed Fib extension levels (1.272, 1.618) as draw-on-liquidity targets.
  // Logic:
  //   1. If a Fib extension is between entry and TP (potential reversal zone):
  //      - If extension is within 80-120% of TP distance: snap TP to extension (natural target)
  //   2. If a Fib extension is just beyond TP (within 30% more distance):
  //      - Extend TP to the extension level (room to run)
  //   3. Never extend TP beyond 4× SL distance (risk cap)
  const fibExts = input.fibExtensions;
  if (tp !== null && fibExts && fibExts.length > 0 && slDistance > 0) {
    const maxTPDistance = slDistance * 4; // hard cap
    const currentTPDistance = Math.abs(tp - lastPrice);

    for (const ext of fibExts) {
      const extDistance = direction === "long"
        ? ext.price - lastPrice
        : lastPrice - ext.price;

      // Skip extensions in the wrong direction or beyond hard cap
      if (extDistance <= 0 || extDistance > maxTPDistance) continue;

      const ratioToTP = extDistance / currentTPDistance;

      if (ratioToTP >= 0.8 && ratioToTP <= 1.2) {
        // Extension is very close to current TP — snap to it (natural target)
        tp = ext.price;
        break; // Use the first (nearest) matching extension
      } else if (ratioToTP > 1.0 && ratioToTP <= 1.3) {
        // Extension is slightly beyond TP — extend TP to capture the move
        tp = ext.price;
        break;
      }
    }
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

// ─── Regime Transition Detection ──────────────────────────────────────────────
export interface RegimeTransition {
  state: string;        // "stable" | "trending_to_range" | "range_to_trending" | "accelerating" | "decelerating"
  confidence: number;   // 0.0-1.0 — how certain we are about the transition
  momentum: number;     // rate of regime score change (positive = becoming more trending, negative = becoming more ranging)
  priorScore: number;   // regime score from lookback window
  currentScore: number; // current regime score
  detail: string;       // human-readable explanation
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
  transition?: RegimeTransition; // Regime transition detection
}

// ─── Confluence Stacking Types ───────────────────────────────────────
export interface ConfluenceLayer {
  type: "fvg" | "ob" | "sr" | "fib";
  label: string;
  priceRange: [number, number]; // [low, high]
}

export interface ConfluenceStack {
  /** Number of independent layers overlapping in this zone (2 = double, 3 = triple) */
  layerCount: number;
  /** The overlapping price zone where all layers converge */
  overlapZone: [number, number]; // [low, high]
  /** Individual layers that form this stack */
  layers: ConfluenceLayer[];
  /** Human-readable label, e.g. "FVG + S/R + Fib 61.8" */
  label: string;
  /** Which Fib level(s) are involved, if any */
  fibLevels: number[];
  /** Whether the stack aligns with the trade direction */
  directionalAlignment: "aligned" | "counter" | "neutral";
}

// ─── Sweep Reclaim Types ────────────────────────────────────────────
export interface SweepReclaim {
  /** Index of the sweep candle */
  sweepIndex: number;
  /** The level that was swept */
  sweptLevel: number;
  /** Type: bullish = swept lows then reclaimed up, bearish = swept highs then reclaimed down */
  type: "bullish" | "bearish";
  /** How far past the level the wick went (in price) */
  wickDepth: number;
  /** Whether the next candle(s) closed back through the level with conviction */
  reclaimed: boolean;
  /** Strength of the reclaim: 0-1 (body ratio of reclaim candle, displacement check) */
  reclaimStrength: number;
  /** Whether the reclaim candle created an FVG (highest quality) */
  createdFVG: boolean;
  /** Whether the reclaim candle was a displacement candle */
  createdDisplacement: boolean;
  /** Datetime of the sweep */
  datetime: string;
}

// ─── Pullback Decay Types ───────────────────────────────────────────
export interface PullbackMeasurement {
  /** Depth of this pullback as percentage of the preceding impulse leg */
  depthPercent: number;
  /** Approximate Fib level this pullback reached (closest of 38.2, 50, 61.8, 78.6) */
  nearestFibLevel: number;
  /** Swing high price of the impulse */
  impulseHigh: number;
  /** Swing low price of the impulse */
  impulseLow: number;
  /** Pullback reversal price */
  pullbackPrice: number;
}

export interface PullbackDecay {
  /** Overall trend health assessment */
  trend: "healthy" | "exhausting" | "stable" | "insufficient_data";
  /** Array of consecutive pullback depths (most recent last) */
  measurements: PullbackMeasurement[];
  /** Rate of depth change: negative = getting shallower (healthy), positive = getting deeper (exhausting) */
  decayRate: number;
  /** Human-readable detail */
  detail: string;
}

// ─── Confluence Stacking Detection ──────────────────────────────────
// Detects when FVG/OB boxes overlap with S/R levels and Fib retracement levels.
// This is the core "triple confluence" check: FVG/OB + S/R + Fib = sniper entry.
export function computeConfluenceStacking(
  orderBlocks: OrderBlock[],
  fvgs: FairValueGap[],
  swingPoints: SwingPoint[],
  candles: Candle[],
  direction: "long" | "short" | null,
  precomputedFib?: FibLevels | null,
): ConfluenceStack[] {
  const stacks: ConfluenceStack[] = [];
  if (candles.length < 10) return stacks;

  // ── Use pre-computed ZigZag Fib levels if available, else fall back to 5-swing envelope ──
  let swingHigh: number, swingLow: number, range: number;
  if (precomputedFib) {
    swingHigh = precomputedFib.swingHigh;
    swingLow = precomputedFib.swingLow;
    range = swingHigh - swingLow;
  } else {
    const recentHighs = swingPoints.filter(s => s.type === "high").slice(-5);
    const recentLows = swingPoints.filter(s => s.type === "low").slice(-5);
    if (recentHighs.length === 0 || recentLows.length === 0) return stacks;
    swingHigh = Math.max(...recentHighs.map(s => s.price));
    swingLow = Math.min(...recentLows.map(s => s.price));
    range = swingHigh - swingLow;
  }
  if (range === 0) return stacks;

  // Fib retracement levels — now includes 0.236
  const FIB_RATIOS = [0.236, 0.382, 0.50, 0.618, 0.786];
  const fibLevels = FIB_RATIOS.map(ratio => ({
    ratio,
    priceLong: swingHigh - range * ratio,
    priceShort: swingLow + range * ratio,
  }));

  // ATR for tolerance (Fib level within 0.3× ATR of zone edge counts)
  const atr = calculateATR(candles, 14);
  const fibTolerance = atr * 0.3;

  // S/R levels from swing points
  const srLevels = swingPoints.slice(-20).map(s => s.price);

  // ── Check each active FVG and OB for overlap with S/R and Fib ──
  const zones: Array<{ type: "fvg" | "ob"; low: number; high: number; zoneType: string; label: string }> = [];

  for (const fvg of fvgs) {
    if (fvg.mitigated) continue;
    zones.push({
      type: "fvg",
      low: fvg.low,
      high: fvg.high,
      zoneType: fvg.type,
      label: `${fvg.type} FVG [${fvg.low.toFixed(5)}-${fvg.high.toFixed(5)}]`,
    });
  }

  for (const ob of orderBlocks) {
    if (ob.mitigated) continue;
    zones.push({
      type: "ob",
      low: ob.low,
      high: ob.high,
      zoneType: ob.type,
      label: `${ob.type} OB [${ob.low.toFixed(5)}-${ob.high.toFixed(5)}]`,
    });
  }

  for (const zone of zones) {
    const layers: ConfluenceLayer[] = [];
    const matchedFibs: number[] = [];

    // Layer 1: The zone itself
    layers.push({
      type: zone.type,
      label: zone.label,
      priceRange: [zone.low, zone.high],
    });

    // Layer 2: S/R inside the zone
    const srInZone = srLevels.filter(sr => sr >= zone.low && sr <= zone.high);
    if (srInZone.length > 0) {
      const zoneMid = (zone.low + zone.high) / 2;
      const bestSR = srInZone.reduce((best, sr) =>
        Math.abs(sr - zoneMid) < Math.abs(best - zoneMid) ? sr : best
      );
      layers.push({
        type: "sr",
        label: `S/R at ${bestSR.toFixed(5)}`,
        priceRange: [bestSR, bestSR],
      });
    }

    // Layer 3: Fib level inside (or very near) the zone
    for (const fib of fibLevels) {
      const fibPrices: number[] = [];
      if (direction === "long" || !direction) fibPrices.push(fib.priceLong);
      if (direction === "short" || !direction) fibPrices.push(fib.priceShort);

      for (const fibPrice of fibPrices) {
        if (fibPrice >= zone.low - fibTolerance && fibPrice <= zone.high + fibTolerance) {
          const fibPct = Math.round(fib.ratio * 1000) / 10;
          layers.push({
            type: "fib",
            label: `Fib ${fibPct}% at ${fibPrice.toFixed(5)}`,
            priceRange: [fibPrice, fibPrice],
          });
          matchedFibs.push(fibPct);
          break;
        }
      }
    }

    // Only create a stack if we have at least 2 layers
    if (layers.length >= 2) {
      let overlapLow = zone.low;
      let overlapHigh = zone.high;

      const layerLabels = layers.map(l => {
        if (l.type === "fvg") return "FVG";
        if (l.type === "ob") return "OB";
        if (l.type === "sr") return "S/R";
        if (l.type === "fib") return l.label.split(" at ")[0];
        return l.type;
      });
      const label = layerLabels.join(" + ");

      let alignment: "aligned" | "counter" | "neutral" = "neutral";
      if (direction) {
        const zoneIsBullish = zone.zoneType === "bullish";
        const zoneIsBearish = zone.zoneType === "bearish";
        if ((direction === "long" && zoneIsBullish) || (direction === "short" && zoneIsBearish)) {
          alignment = "aligned";
        } else if ((direction === "long" && zoneIsBearish) || (direction === "short" && zoneIsBullish)) {
          alignment = "counter";
        }
      }

      stacks.push({
        layerCount: layers.length,
        overlapZone: [overlapLow, overlapHigh],
        layers,
        label,
        fibLevels: matchedFibs,
        directionalAlignment: alignment,
      });
    }
  }

  // Sort by layer count (highest confluence first), then by alignment
  stacks.sort((a, b) => {
    if (b.layerCount !== a.layerCount) return b.layerCount - a.layerCount;
    const alignOrder = { aligned: 0, neutral: 1, counter: 2 };
    return alignOrder[a.directionalAlignment] - alignOrder[b.directionalAlignment];
  });

  return stacks;
}

// ─── Sweep Reclaim Detection ────────────────────────────────────────
// Enhances existing liquidity sweep data with reclaim confirmation.
// A "sweep + reclaim" is the highest-quality entry trigger.
export function detectSweepReclaim(
  candles: Candle[],
  sweeps: { index: number; type: "bullish" | "bearish"; price: number; datetime: string; sweptLevel: number; wickDepth: number }[],
  fvgs: FairValueGap[],
): SweepReclaim[] {
  const results: SweepReclaim[] = [];
  if (candles.length < 5 || sweeps.length === 0) return results;

  const atr = calculateATR(candles, 14);

  for (const sweep of sweeps) {
    if (sweep.index < candles.length - 30) continue;

    let reclaimed = false;
    let reclaimStrength = 0;
    let createdFVG = false;
    let createdDisplacement = false;

    const reclaimWindow = Math.min(3, candles.length - sweep.index - 1);
    for (let offset = 1; offset <= reclaimWindow; offset++) {
      const reclaimCandle = candles[sweep.index + offset];
      if (!reclaimCandle) continue;

      const bodySize = Math.abs(reclaimCandle.close - reclaimCandle.open);
      const totalRange = reclaimCandle.high - reclaimCandle.low;
      const bodyRatio = totalRange > 0 ? bodySize / totalRange : 0;

      if (sweep.type === "bullish") {
        if (reclaimCandle.close > sweep.sweptLevel) {
          reclaimed = true;
          const isDisplacement = bodySize > atr * 1.5;
          reclaimStrength = Math.min(1.0, bodyRatio * 0.6 + (isDisplacement ? 0.4 : 0));
          createdDisplacement = isDisplacement;

          if (sweep.index + offset + 1 < candles.length && sweep.index + offset >= 1) {
            const prevC = candles[sweep.index + offset - 1];
            const nextC = candles[sweep.index + offset + 1];
            if (nextC && nextC.low > prevC.high) {
              createdFVG = true;
            }
          }
          break;
        }
      } else {
        if (reclaimCandle.close < sweep.sweptLevel) {
          reclaimed = true;
          const isDisplacement = bodySize > atr * 1.5;
          reclaimStrength = Math.min(1.0, bodyRatio * 0.6 + (isDisplacement ? 0.4 : 0));
          createdDisplacement = isDisplacement;

          if (sweep.index + offset + 1 < candles.length && sweep.index + offset >= 1) {
            const prevC = candles[sweep.index + offset - 1];
            const nextC = candles[sweep.index + offset + 1];
            if (nextC && prevC.low > nextC.high) {
              createdFVG = true;
            }
          }
          break;
        }
      }
    }

    if (!createdFVG) {
      const nearbyFVG = fvgs.find(f =>
        !f.mitigated &&
        f.type === sweep.type &&
        Math.abs(f.index - sweep.index) <= 3
      );
      if (nearbyFVG) createdFVG = true;
    }

    results.push({
      sweepIndex: sweep.index,
      sweptLevel: sweep.sweptLevel,
      type: sweep.type,
      wickDepth: sweep.wickDepth,
      reclaimed,
      reclaimStrength,
      createdFVG,
      createdDisplacement,
      datetime: sweep.datetime,
    });
  }

  results.sort((a, b) => {
    if (a.reclaimed !== b.reclaimed) return a.reclaimed ? -1 : 1;
    if (b.reclaimStrength !== a.reclaimStrength) return b.reclaimStrength - a.reclaimStrength;
    return b.sweepIndex - a.sweepIndex;
  });

  return results;
}

// ─── Pullback Depth Decay Measurement ───────────────────────────────
// Measures the depth of consecutive pullbacks to assess trend health.
export function measurePullbackDecay(
  swingPoints: SwingPoint[],
  trend: "bullish" | "bearish" | "ranging",
): PullbackDecay {
  if (swingPoints.length < 6 || trend === "ranging") {
    return { trend: "insufficient_data", measurements: [], decayRate: 0, detail: "Not enough swing data or ranging market" };
  }

  const measurements: PullbackMeasurement[] = [];
  const FIB_LEVELS = [23.6, 38.2, 50.0, 61.8, 78.6];

  const highs = swingPoints.filter(s => s.type === "high");
  const lows = swingPoints.filter(s => s.type === "low");

  if (trend === "bullish") {
    const recentLows = lows.slice(-5);
    const recentHighs = highs.slice(-5);

    for (let i = 0; i < recentLows.length - 1 && i < recentHighs.length; i++) {
      const impulseLow = recentLows[i];
      const impulseHigh = recentHighs.find(h => h.index > impulseLow.index);
      if (!impulseHigh) continue;
      const pullbackLow = recentLows.find(l => l.index > impulseHigh.index);
      if (!pullbackLow) continue;

      const impulseRange = impulseHigh.price - impulseLow.price;
      if (impulseRange <= 0) continue;

      const pullbackDepth = impulseHigh.price - pullbackLow.price;
      const depthPercent = (pullbackDepth / impulseRange) * 100;

      const nearestFib = FIB_LEVELS.reduce((best, fib) =>
        Math.abs(depthPercent - fib) < Math.abs(depthPercent - best) ? fib : best
      );

      measurements.push({
        depthPercent: Math.round(depthPercent * 10) / 10,
        nearestFibLevel: nearestFib,
        impulseHigh: impulseHigh.price,
        impulseLow: impulseLow.price,
        pullbackPrice: pullbackLow.price,
      });
    }
  } else {
    const recentHighs = highs.slice(-5);
    const recentLows = lows.slice(-5);

    for (let i = 0; i < recentHighs.length - 1 && i < recentLows.length; i++) {
      const impulseHigh = recentHighs[i];
      const impulseLow = recentLows.find(l => l.index > impulseHigh.index);
      if (!impulseLow) continue;
      const pullbackHigh = recentHighs.find(h => h.index > impulseLow.index);
      if (!pullbackHigh) continue;

      const impulseRange = impulseHigh.price - impulseLow.price;
      if (impulseRange <= 0) continue;

      const pullbackDepth = pullbackHigh.price - impulseLow.price;
      const depthPercent = (pullbackDepth / impulseRange) * 100;

      const nearestFib = FIB_LEVELS.reduce((best, fib) =>
        Math.abs(depthPercent - fib) < Math.abs(depthPercent - best) ? fib : best
      );

      measurements.push({
        depthPercent: Math.round(depthPercent * 10) / 10,
        nearestFibLevel: nearestFib,
        impulseHigh: impulseHigh.price,
        impulseLow: impulseLow.price,
        pullbackPrice: pullbackHigh.price,
      });
    }
  }

  if (measurements.length < 2) {
    return { trend: "insufficient_data", measurements, decayRate: 0, detail: "Only " + measurements.length + " pullback(s) found — need at least 2" };
  }

  // Linear regression slope on depth percentages
  const n = measurements.length;
  const xMean = (n - 1) / 2;
  const yMean = measurements.reduce((s, m) => s + m.depthPercent, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (measurements[i].depthPercent - yMean);
    denominator += (i - xMean) ** 2;
  }
  const decayRate = denominator !== 0 ? Math.round((numerator / denominator) * 100) / 100 : 0;

  let trendHealth: "healthy" | "exhausting" | "stable";
  let detail: string;

  const depths = measurements.map(m => m.depthPercent);

  if (decayRate < -3) {
    trendHealth = "healthy";
    detail = `Pullbacks getting shallower: ${depths.map(d => d.toFixed(1) + "%").join(" → ")} (slope: ${decayRate.toFixed(1)}%/swing) — trend healthy, institutions adding on dips`;
  } else if (decayRate > 5) {
    trendHealth = "exhausting";
    detail = `Pullbacks getting deeper: ${depths.map(d => d.toFixed(1) + "%").join(" → ")} (slope: +${decayRate.toFixed(1)}%/swing) — trend may be exhausting`;
  } else {
    trendHealth = "stable";
    detail = `Pullback depth stable: ${depths.map(d => d.toFixed(1) + "%").join(" → ")} (slope: ${decayRate > 0 ? "+" : ""}${decayRate.toFixed(1)}%/swing)`;
  }

  const fibSummary = measurements.map(m => `~${m.nearestFibLevel}%`).join(" → ");
  detail += ` | Step-down: ${fibSummary}`;

  return { trend: trendHealth, measurements, decayRate, detail };
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

  // ─── Pre-compute shared data ──────────────────────────────────────────────
  const closes = sorted.map(c => c.close);

  // ATR calculation
  const trueRanges: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const h = sorted[i].high, l = sorted[i].low, pc = sorted[i - 1].close;
    trueRanges.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr14 = trueRanges.slice(-14).reduce((s, v) => s + v, 0) / Math.min(14, trueRanges.length);
  const atr7Recent = trueRanges.slice(-7).reduce((s, v) => s + v, 0) / Math.min(7, trueRanges.length);
  const atr7Prior = trueRanges.slice(-14, -7).reduce((s, v) => s + v, 0) / Math.min(7, trueRanges.slice(-14, -7).length || 1);

  let atrTrend: string;
  if (atr7Recent > atr7Prior * 1.2) atrTrend = "expanding";
  else if (atr7Recent < atr7Prior * 0.8) atrTrend = "contracting";
  else atrTrend = "stable";

  // ─── CHECK 1: Swing Structure (BOS vs CHoCH) ─────────────────────────────
  // Core SMC definition: BOS = trend continuation, CHoCH = reversal.
  // More BOS than CHoCH = trending. More CHoCH = choppy/ranging.
  {
    const swingLookback = 3;
    const swingHighs: { index: number; price: number }[] = [];
    const swingLows: { index: number; price: number }[] = [];
    const minSwingSize = atr14 * 0.25;

    for (let i = swingLookback; i < sorted.length - swingLookback; i++) {
      let isHigh = true, isLow = true;
      for (let j = 1; j <= swingLookback; j++) {
        if (sorted[i].high <= sorted[i - j].high || sorted[i].high <= sorted[i + j].high) isHigh = false;
        if (sorted[i].low >= sorted[i - j].low || sorted[i].low >= sorted[i + j].low) isLow = false;
      }
      if (isHigh && sorted[i].high - sorted[i].low >= minSwingSize) swingHighs.push({ index: i, price: sorted[i].high });
      if (isLow && sorted[i].high - sorted[i].low >= minSwingSize) swingLows.push({ index: i, price: sorted[i].low });
    }

    let bosCount = 0, chochCount = 0;
    let currentTrend: "bullish" | "bearish" | "none" = "none";

    for (let i = 1; i < swingHighs.length; i++) {
      if (swingHighs[i].price > swingHighs[i - 1].price) {
        if ((currentTrend as string) === "bearish") chochCount++;
        else bosCount++;
        currentTrend = "bullish";
      }
    }
    for (let i = 1; i < swingLows.length; i++) {
      if (swingLows[i].price < swingLows[i - 1].price) {
        if (currentTrend === "bullish") chochCount++;
        else bosCount++;
        currentTrend = "bearish";
      }
    }

    const totalBreaks = bosCount + chochCount;
    if (totalBreaks > 0) {
      const bosRatio = bosCount / totalBreaks;
      if (bosRatio >= 0.7) {
        regimeScore += 2;
        indicators.push(`Structure: ${bosCount} BOS vs ${chochCount} CHoCH (${(bosRatio * 100).toFixed(0)}% continuation) — strong trend structure`);
      } else if (bosRatio >= 0.5) {
        regimeScore += 1;
        indicators.push(`Structure: ${bosCount} BOS vs ${chochCount} CHoCH (${(bosRatio * 100).toFixed(0)}% continuation) — mild trend structure`);
      } else if (bosRatio < 0.3) {
        regimeScore -= 2;
        indicators.push(`Structure: ${bosCount} BOS vs ${chochCount} CHoCH (${(bosRatio * 100).toFixed(0)}% continuation) — choppy reversals`);
      } else {
        regimeScore -= 1;
        indicators.push(`Structure: ${bosCount} BOS vs ${chochCount} CHoCH (${(bosRatio * 100).toFixed(0)}% continuation) — mixed structure`);
      }
    } else {
      indicators.push("Structure: No significant swing breaks detected");
    }
  }

  // ─── CHECK 2: EMA 20/50 Alignment ────────────────────────────────────────
  // If 20 EMA is above 50 EMA and both slope the same direction = trending.
  // If they're intertwined or flat = ranging.
  {
    const ema20 = _regimeEMA(closes, 20);
    const ema50 = _regimeEMA(closes, Math.min(50, closes.length - 1));

    if (ema20.length >= 5 && ema50.length >= 5) {
      const recentEma20 = ema20[ema20.length - 1];
      const recentEma50 = ema50[ema50.length - 1];
      const priorEma20 = ema20[ema20.length - 5];
      const priorEma50 = ema50[ema50.length - 5];

      const ema20Slope = recentEma20 - priorEma20;
      const ema50Slope = recentEma50 - priorEma50;
      const separation = Math.abs(recentEma20 - recentEma50);
      const separationPct = (separation / recentEma50) * 100;
      const sameDirection = (ema20Slope > 0 && ema50Slope > 0) || (ema20Slope < 0 && ema50Slope < 0);

      if (sameDirection && separationPct > 0.3) {
        regimeScore += 2;
        indicators.push(`EMA 20/50: aligned ${ema20Slope > 0 ? "bullish" : "bearish"}, separated by ${separationPct.toFixed(2)}% — trending`);
      } else if (sameDirection) {
        regimeScore += 1;
        indicators.push(`EMA 20/50: aligned ${ema20Slope > 0 ? "bullish" : "bearish"}, tight separation ${separationPct.toFixed(2)}% — weak trend`);
      } else if (separationPct < 0.1) {
        regimeScore -= 2;
        indicators.push(`EMA 20/50: intertwined (${separationPct.toFixed(2)}% apart) — ranging`);
      } else {
        regimeScore -= 1;
        indicators.push(`EMA 20/50: diverging slopes, separation ${separationPct.toFixed(2)}% — transitional`);
      }
    }
  }

  // ─── CHECK 3: Impulse vs Correction Ratio ────────────────────────────────
  // Measures the largest directional swing vs the largest counter-swing.
  // A trending market has impulses >> corrections. Catches pullbacks correctly.
  {
    const recent = sorted.slice(-20);
    // Measure using swing-to-swing: largest move from any low to subsequent high (and vice versa)
    let maxSwingUp = 0, maxSwingDown = 0;
    let runningLow = recent[0].low, runningHigh = recent[0].high;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].high - runningLow > maxSwingUp) maxSwingUp = recent[i].high - runningLow;
      if (recent[i].low < runningLow) runningLow = recent[i].low;
      if (runningHigh - recent[i].low > maxSwingDown) maxSwingDown = runningHigh - recent[i].low;
      if (recent[i].high > runningHigh) runningHigh = recent[i].high;
    }

    const impulse = Math.max(maxSwingUp, maxSwingDown);
    const correction = Math.min(maxSwingUp, maxSwingDown);
    const ratio = correction > 0 ? impulse / correction : (impulse > 0 ? 5.0 : 1.0);

    if (ratio >= 3.0) {
      regimeScore += 2;
      indicators.push(`Impulse/Correction ratio: ${ratio.toFixed(1)}x — strong directional dominance`);
    } else if (ratio >= 1.8) {
      regimeScore += 1;
      indicators.push(`Impulse/Correction ratio: ${ratio.toFixed(1)}x — moderate directional bias`);
    } else if (ratio <= 1.2) {
      regimeScore -= 2;
      indicators.push(`Impulse/Correction ratio: ${ratio.toFixed(1)}x — balanced moves, ranging`);
    } else {
      indicators.push(`Impulse/Correction ratio: ${ratio.toFixed(1)}x — neutral`);
    }
  }

  // ─── CHECK 4: Consecutive Directional Candles ────────────────────────────
  // Trending markets produce runs of 4-6+ candles in one direction.
  // Ranging markets rarely exceed 2-3.
  {
    const recent = sorted.slice(-20);
    let maxRun = 1, currentRun = 1;
    for (let i = 1; i < recent.length; i++) {
      const prevDir = recent[i - 1].close >= recent[i - 1].open ? "bull" : "bear";
      const currDir = recent[i].close >= recent[i].open ? "bull" : "bear";
      if (currDir === prevDir) currentRun++;
      else { maxRun = Math.max(maxRun, currentRun); currentRun = 1; }
    }
    maxRun = Math.max(maxRun, currentRun);

    if (maxRun >= 5) {
      regimeScore += 2;
      indicators.push(`Max consecutive run: ${maxRun} candles — strong impulse present`);
    } else if (maxRun >= 4) {
      regimeScore += 1;
      indicators.push(`Max consecutive run: ${maxRun} candles — moderate impulse`);
    } else if (maxRun <= 2) {
      regimeScore -= 2;
      indicators.push(`Max consecutive run: ${maxRun} candles — choppy, no sustained moves`);
    } else {
      indicators.push(`Max consecutive run: ${maxRun} candles — neutral`);
    }
  }

  // ─── CHECK 5: ADX (Average Directional Index) ───────────────────────────
  // ADX > 25 = trending, ADX < 20 = ranging. Industry standard.
  {
    const adxPeriod = Math.min(14, trueRanges.length);
    const plusDMs: number[] = [];
    const minusDMs: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const upMove = sorted[i].high - sorted[i - 1].high;
      const downMove = sorted[i - 1].low - sorted[i].low;
      plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    // Wilder's smoothing for DI values
    const smoothLen = Math.min(adxPeriod, plusDMs.length);
    let smoothPlusDM = plusDMs.slice(0, smoothLen).reduce((s, v) => s + v, 0);
    let smoothMinusDM = minusDMs.slice(0, smoothLen).reduce((s, v) => s + v, 0);
    let smoothTR = trueRanges.slice(0, smoothLen).reduce((s, v) => s + v, 0);

    const dxValues: number[] = [];
    for (let i = smoothLen; i < plusDMs.length; i++) {
      smoothPlusDM = smoothPlusDM - (smoothPlusDM / smoothLen) + plusDMs[i];
      smoothMinusDM = smoothMinusDM - (smoothMinusDM / smoothLen) + minusDMs[i];
      smoothTR = smoothTR - (smoothTR / smoothLen) + trueRanges[i];

      const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
      const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
      const diSum = plusDI + minusDI;
      const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
      dxValues.push(dx);
    }

    const adxSmoothPeriod = Math.min(14, dxValues.length);
    const adx = adxSmoothPeriod > 0 ? dxValues.slice(-adxSmoothPeriod).reduce((s, v) => s + v, 0) / adxSmoothPeriod : 0;

    // Directional bias from latest DI
    const latestPlusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const latestMinusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;

    if (adx > 30) {
      regimeScore += 2;
      indicators.push(`ADX: ${adx.toFixed(1)} — strong trend (${latestPlusDI > latestMinusDI ? "bullish" : "bearish"} dominant)`);
    } else if (adx > 25) {
      regimeScore += 1;
      indicators.push(`ADX: ${adx.toFixed(1)} — trending (${latestPlusDI > latestMinusDI ? "bullish" : "bearish"} leaning)`);
    } else if (adx < 18) {
      regimeScore -= 2;
      indicators.push(`ADX: ${adx.toFixed(1)} — weak/no trend`);
    } else {
      indicators.push(`ADX: ${adx.toFixed(1)} — borderline`);
    }
  }

  // ─── CHECK 6: Higher Timeframe Bias Consistency ──────────────────────────
  // Compare 50-candle direction with 20-candle direction.
  // If they agree = sustained trend. If short-term disagrees but long-term is strong,
  // it's a pullback in a trend — NOT ranging.
  {
    const len = sorted.length;
    const price50ago = len >= 50 ? sorted[len - 50].close : sorted[0].close;
    const price20ago = sorted[len - 20].close;
    const priceNow = sorted[len - 1].close;

    const longTermDir = priceNow > price50ago ? "bullish" : priceNow < price50ago ? "bearish" : "flat";
    const shortTermDir = priceNow > price20ago ? "bullish" : priceNow < price20ago ? "bearish" : "flat";

    const longTermMove = Math.abs(priceNow - price50ago) / price50ago * 100;
    const shortTermMove = Math.abs(priceNow - price20ago) / price20ago * 100;

    if (longTermDir === shortTermDir && longTermDir !== "flat") {
      regimeScore += 2;
      indicators.push(`HTF bias: ${longTermDir} on both 50d (${longTermMove.toFixed(2)}%) and 20d (${shortTermMove.toFixed(2)}%) — sustained trend`);
    } else if (longTermDir !== "flat" && shortTermDir !== longTermDir && longTermMove > shortTermMove) {
      // Short-term pullback within a larger trend — NOT ranging
      regimeScore += 1;
      indicators.push(`HTF bias: ${longTermDir} 50d (${longTermMove.toFixed(2)}%) with ${shortTermDir || "flat"} 20d pullback (${shortTermMove.toFixed(2)}%) — trend with retracement`);
    } else if (longTermMove < 0.5 && shortTermMove < 0.5) {
      regimeScore -= 2;
      indicators.push(`HTF bias: flat on both timeframes (50d: ${longTermMove.toFixed(2)}%, 20d: ${shortTermMove.toFixed(2)}%) — ranging`);
    } else {
      indicators.push(`HTF bias: ${longTermDir} 50d vs ${shortTermDir} 20d — transitional`);
    }
  }

  // ─── CHECK 7: Range Compression (Bollinger Band Width proxy) ─────────────
  // Tight bands = consolidation/range. Wide bands = trending/volatile.
  {
    // Standard deviation of closes (BB width proxy)
    const recentCloses = closes.slice(-20);
    const mean = recentCloses.reduce((s, v) => s + v, 0) / recentCloses.length;
    const variance = recentCloses.reduce((s, v) => s + (v - mean) ** 2, 0) / recentCloses.length;
    const stdDev = Math.sqrt(variance);
    const bbWidthPct = (stdDev / mean) * 100 * 4; // Approximate BB width as 4 * stddev / mean

    const atrPriceRatio = (atr14 / closes[closes.length - 1]) * 100;

    if (bbWidthPct > 3.0 && atrPriceRatio > 0.8) {
      regimeScore += 2;
      indicators.push(`Volatility: BB width ${bbWidthPct.toFixed(2)}%, ATR/price ${atrPriceRatio.toFixed(2)}% — expanded, trending`);
    } else if (bbWidthPct > 2.0) {
      regimeScore += 1;
      indicators.push(`Volatility: BB width ${bbWidthPct.toFixed(2)}%, ATR/price ${atrPriceRatio.toFixed(2)}% — moderate`);
    } else if (bbWidthPct < 1.0) {
      regimeScore -= 2;
      indicators.push(`Volatility: BB width ${bbWidthPct.toFixed(2)}%, ATR/price ${atrPriceRatio.toFixed(2)}% — compressed, ranging`);
    } else {
      indicators.push(`Volatility: BB width ${bbWidthPct.toFixed(2)}%, ATR/price ${atrPriceRatio.toFixed(2)}% — neutral`);
    }
  }

  // ─── Determine directional bias ──────────────────────────────────────────
  let directionalBias: string;
  {
    const priceChange20 = closes[closes.length - 1] - closes[Math.max(0, closes.length - 20)];
    const ema20 = _regimeEMA(closes, 20);
    const emaSlope = ema20.length >= 3 ? ema20[ema20.length - 1] - ema20[ema20.length - 3] : 0;

    if (priceChange20 > 0 && emaSlope > 0) directionalBias = "bullish";
    else if (priceChange20 < 0 && emaSlope < 0) directionalBias = "bearish";
    else directionalBias = "neutral";
  }

  // ─── Range percent (kept for backward compatibility) ─────────────────────
  const highestHigh = Math.max(...sorted.slice(-20).map(c => c.high));
  const lowestLow = Math.min(...sorted.slice(-20).map(c => c.low));
  const rangePercent = ((highestHigh - lowestLow) / lowestLow) * 100;

  // ─── Final Regime Classification ─────────────────────────────────────────
  // Score range: -14 to +14 (7 checks x +/-2 each)
  let regime: string;
  let confidence: number;
  if (regimeScore >= 8) {
    regime = "strong_trend";
    confidence = Math.min(0.7 + (regimeScore - 8) * 0.05, 0.95);
  } else if (regimeScore >= 4) {
    regime = "mild_trend";
    confidence = 0.5 + (regimeScore - 4) * 0.05;
  } else if (regimeScore <= -8) {
    regime = "choppy_range";
    confidence = Math.min(0.7 + (Math.abs(regimeScore) - 8) * 0.05, 0.95);
  } else if (regimeScore <= -4) {
    regime = "mild_range";
    confidence = 0.5 + (Math.abs(regimeScore) - 4) * 0.05;
  } else {
    regime = "transitional";
    confidence = 0.3 + Math.abs(regimeScore) * 0.03;
  }

  indicators.push(`Total regime score: ${regimeScore}/14`);

  // ─── Regime Transition Detection ──────────────────────────────────────────
  // Compare current regime score against a lookback window (candles shifted back 10 periods)
  // to detect if the market is transitioning between regimes.
  let transition: RegimeTransition | undefined;
  {
    const lookbackShift = 10; // How many candles back to compute the "prior" regime
    if (sorted.length >= 30 + lookbackShift) {
      // Compute regime score on the older window (excluding the last N candles)
      const priorCandles = sorted.slice(0, sorted.length - lookbackShift);
      const priorResult = _computeRegimeScore(priorCandles);
      const priorScore = priorResult.score;
      const currentScore = regimeScore;
      const scoreDelta = currentScore - priorScore;
      const momentum = scoreDelta / lookbackShift; // Score change per candle

      // Classify the transition state
      let transState: string;
      let transConf: number;
      let transDetail: string;

      const absDelta = Math.abs(scoreDelta);

      if (absDelta <= 2) {
        // Score barely changed — regime is stable
        transState = "stable";
        transConf = Math.min(0.8, 0.5 + (2 - absDelta) * 0.15);
        transDetail = `Regime stable: score moved ${scoreDelta > 0 ? "+" : ""}${scoreDelta} (${priorScore} → ${currentScore}) over ${lookbackShift} candles`;
      } else if (scoreDelta > 2 && priorScore <= 0) {
        // Was ranging/transitional, now becoming trending
        transState = "range_to_trending";
        transConf = Math.min(0.95, 0.4 + absDelta * 0.08);
        transDetail = `Transitioning range→trend: score jumped ${scoreDelta > 0 ? "+" : ""}${scoreDelta} (${priorScore} → ${currentScore}) — market gaining directional momentum`;
      } else if (scoreDelta < -2 && priorScore >= 0) {
        // Was trending/transitional, now becoming ranging
        transState = "trending_to_range";
        transConf = Math.min(0.95, 0.4 + absDelta * 0.08);
        transDetail = `Transitioning trend→range: score dropped ${scoreDelta} (${priorScore} → ${currentScore}) — trend losing steam`;
      } else if (scoreDelta > 2 && priorScore > 0) {
        // Was already trending, now trending even harder
        transState = "accelerating";
        transConf = Math.min(0.9, 0.5 + absDelta * 0.06);
        transDetail = `Trend accelerating: score rose ${scoreDelta > 0 ? "+" : ""}${scoreDelta} (${priorScore} → ${currentScore}) — strengthening directional move`;
      } else if (scoreDelta < -2 && priorScore < 0) {
        // Was already ranging, now ranging even harder
        transState = "decelerating";
        transConf = Math.min(0.9, 0.5 + absDelta * 0.06);
        transDetail = `Range deepening: score dropped ${scoreDelta} (${priorScore} → ${currentScore}) — consolidation intensifying`;
      } else {
        transState = "stable";
        transConf = 0.3;
        transDetail = `Ambiguous transition: score moved ${scoreDelta > 0 ? "+" : ""}${scoreDelta} (${priorScore} → ${currentScore})`;
      }

      transition = {
        state: transState,
        confidence: Math.round(transConf * 100) / 100,
        momentum: Math.round(momentum * 1000) / 1000,
        priorScore,
        currentScore,
        detail: transDetail,
      };
      indicators.push(`Transition: ${transState} (${(transConf * 100).toFixed(0)}% conf, momentum ${momentum > 0 ? "+" : ""}${momentum.toFixed(3)}/candle)`);
    }
  }

  return { regime, confidence, indicators, atr14, atrTrend, directionalBias, rangePercent, transition };
}

// ─── Helper: Compute EMA for regime classifier ─────────────────────────────
function _regimeEMA(values: number[], period: number): number[] {
  if (values.length < period || period <= 1) return values.slice();
  const k = 2 / (period + 1);
  const ema: number[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  ema.push(sum / period);
  for (let i = period; i < values.length; i++) {
    ema.push(values[i] * k + ema[ema.length - 1] * (1 - k));
  }
  return ema;
}

// ─── Helper: Compute raw regime score for transition detection ────────────
// Runs the same 7 checks as classifyInstrumentRegime but returns only the
// numeric score (no indicators, no classification). Used to compare current
// vs lookback windows for transition detection.
function _computeRegimeScore(
  candles: Array<{ open: number; high: number; low: number; close: number; datetime?: string }>
): { score: number } {
  if (!candles || candles.length < 20) return { score: 0 };

  const sorted = candles[0].datetime
    ? [...candles].sort((a, b) => new Date(a.datetime!).getTime() - new Date(b.datetime!).getTime())
    : candles;
  const closes = sorted.map(c => c.close);
  let score = 0;

  // ATR
  const trueRanges: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const h = sorted[i].high, l = sorted[i].low, pc = sorted[i - 1].close;
    trueRanges.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr14 = trueRanges.slice(-14).reduce((s, v) => s + v, 0) / Math.min(14, trueRanges.length);

  // CHECK 1: Swing Structure (BOS vs CHoCH)
  {
    const swingLookback = 3;
    const swingHighs: { index: number; price: number }[] = [];
    const swingLows: { index: number; price: number }[] = [];
    const minSwingSize = atr14 * 0.25;
    for (let i = swingLookback; i < sorted.length - swingLookback; i++) {
      let isHigh = true, isLow = true;
      for (let j = 1; j <= swingLookback; j++) {
        if (sorted[i].high <= sorted[i - j].high || sorted[i].high <= sorted[i + j].high) isHigh = false;
        if (sorted[i].low >= sorted[i - j].low || sorted[i].low >= sorted[i + j].low) isLow = false;
      }
      if (isHigh && sorted[i].high - sorted[i].low >= minSwingSize) swingHighs.push({ index: i, price: sorted[i].high });
      if (isLow && sorted[i].high - sorted[i].low >= minSwingSize) swingLows.push({ index: i, price: sorted[i].low });
    }
    let bosCount = 0, chochCount = 0;
    let currentTrend: "bullish" | "bearish" | "none" = "none";
    for (let i = 1; i < swingHighs.length; i++) {
      if (swingHighs[i].price > swingHighs[i - 1].price) {
        if ((currentTrend as string) === "bearish") chochCount++; else bosCount++;
        currentTrend = "bullish";
      }
    }
    for (let i = 1; i < swingLows.length; i++) {
      if (swingLows[i].price < swingLows[i - 1].price) {
        if (currentTrend === "bullish") chochCount++; else bosCount++;
        currentTrend = "bearish";
      }
    }
    const totalBreaks = bosCount + chochCount;
    if (totalBreaks > 0) {
      const bosRatio = bosCount / totalBreaks;
      if (bosRatio >= 0.7) score += 2;
      else if (bosRatio >= 0.5) score += 1;
      else if (bosRatio < 0.3) score -= 2;
      else score -= 1;
    }
  }

  // CHECK 2: EMA 20/50 Alignment
  {
    const ema20 = _regimeEMA(closes, 20);
    const ema50 = _regimeEMA(closes, Math.min(50, closes.length - 1));
    if (ema20.length >= 5 && ema50.length >= 5) {
      const recentEma20 = ema20[ema20.length - 1];
      const recentEma50 = ema50[ema50.length - 1];
      const priorEma20 = ema20[ema20.length - 5];
      const priorEma50 = ema50[ema50.length - 5];
      const ema20Slope = recentEma20 - priorEma20;
      const ema50Slope = recentEma50 - priorEma50;
      const separation = Math.abs(recentEma20 - recentEma50);
      const separationPct = (separation / recentEma50) * 100;
      const sameDirection = (ema20Slope > 0 && ema50Slope > 0) || (ema20Slope < 0 && ema50Slope < 0);
      if (sameDirection && separationPct > 0.3) score += 2;
      else if (sameDirection) score += 1;
      else if (separationPct < 0.1) score -= 2;
      else score -= 1;
    }
  }

  // CHECK 3: Impulse vs Correction Ratio
  {
    const recent = sorted.slice(-20);
    let maxSwingUp = 0, maxSwingDown = 0;
    let runningLow = recent[0].low, runningHigh = recent[0].high;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].high - runningLow > maxSwingUp) maxSwingUp = recent[i].high - runningLow;
      if (recent[i].low < runningLow) runningLow = recent[i].low;
      if (runningHigh - recent[i].low > maxSwingDown) maxSwingDown = runningHigh - recent[i].low;
      if (recent[i].high > runningHigh) runningHigh = recent[i].high;
    }
    const impulse = Math.max(maxSwingUp, maxSwingDown);
    const correction = Math.min(maxSwingUp, maxSwingDown);
    const ratio = correction > 0 ? impulse / correction : (impulse > 0 ? 5.0 : 1.0);
    if (ratio >= 3.0) score += 2;
    else if (ratio >= 1.8) score += 1;
    else if (ratio <= 1.2) score -= 2;
  }

  // CHECK 4: Consecutive Directional Candles
  {
    const recent = sorted.slice(-20);
    let maxRun = 1, currentRun = 1;
    for (let i = 1; i < recent.length; i++) {
      const prevDir = recent[i - 1].close >= recent[i - 1].open ? "bull" : "bear";
      const currDir = recent[i].close >= recent[i].open ? "bull" : "bear";
      if (currDir === prevDir) currentRun++; else { maxRun = Math.max(maxRun, currentRun); currentRun = 1; }
    }
    maxRun = Math.max(maxRun, currentRun);
    if (maxRun >= 5) score += 2;
    else if (maxRun >= 4) score += 1;
    else if (maxRun <= 2) score -= 2;
  }

  // CHECK 5: ADX
  {
    const adxPeriod = Math.min(14, trueRanges.length);
    const plusDMs: number[] = [];
    const minusDMs: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const upMove = sorted[i].high - sorted[i - 1].high;
      const downMove = sorted[i - 1].low - sorted[i].low;
      plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }
    const smoothLen = Math.min(adxPeriod, plusDMs.length);
    let smoothPlusDM = plusDMs.slice(0, smoothLen).reduce((s, v) => s + v, 0);
    let smoothMinusDM = minusDMs.slice(0, smoothLen).reduce((s, v) => s + v, 0);
    let smoothTR = trueRanges.slice(0, smoothLen).reduce((s, v) => s + v, 0);
    const dxValues: number[] = [];
    for (let i = smoothLen; i < plusDMs.length; i++) {
      smoothPlusDM = smoothPlusDM - (smoothPlusDM / smoothLen) + plusDMs[i];
      smoothMinusDM = smoothMinusDM - (smoothMinusDM / smoothLen) + minusDMs[i];
      smoothTR = smoothTR - (smoothTR / smoothLen) + trueRanges[i];
      const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
      const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
      const diSum = plusDI + minusDI;
      const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
      dxValues.push(dx);
    }
    const adxSmoothPeriod = Math.min(14, dxValues.length);
    const adx = adxSmoothPeriod > 0 ? dxValues.slice(-adxSmoothPeriod).reduce((s, v) => s + v, 0) / adxSmoothPeriod : 0;
    if (adx > 30) score += 2;
    else if (adx > 25) score += 1;
    else if (adx < 18) score -= 2;
  }

  // CHECK 6: HTF Bias Consistency
  {
    const len = sorted.length;
    const price50ago = len >= 50 ? sorted[len - 50].close : sorted[0].close;
    const price20ago = sorted[len - 20].close;
    const priceNow = sorted[len - 1].close;
    const longTermDir = priceNow > price50ago ? "bullish" : priceNow < price50ago ? "bearish" : "flat";
    const shortTermDir = priceNow > price20ago ? "bullish" : priceNow < price20ago ? "bearish" : "flat";
    const longTermMove = Math.abs(priceNow - price50ago) / price50ago * 100;
    const shortTermMove = Math.abs(priceNow - price20ago) / price20ago * 100;
    if (longTermDir === shortTermDir && longTermDir !== "flat") score += 2;
    else if (longTermDir !== "flat" && shortTermDir !== longTermDir && longTermMove > shortTermMove) score += 1;
    else if (longTermMove < 0.5 && shortTermMove < 0.5) score -= 2;
  }

  // CHECK 7: Range Compression (BB Width proxy)
  {
    const recentCloses = closes.slice(-20);
    const mean = recentCloses.reduce((s, v) => s + v, 0) / recentCloses.length;
    const variance = recentCloses.reduce((s, v) => s + (v - mean) ** 2, 0) / recentCloses.length;
    const stdDev = Math.sqrt(variance);
    const bbWidthPct = (stdDev / mean) * 100 * 4;
    const atrPriceRatio = (atr14 / closes[closes.length - 1]) * 100;
    if (bbWidthPct > 3.0 && atrPriceRatio > 0.8) score += 2;
    else if (bbWidthPct > 2.0) score += 1;
    else if (bbWidthPct < 1.0) score -= 2;
  }

  return { score };
}
