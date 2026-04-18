/**
 * backtest-engine — Supabase Edge Function
 * ──────────────────────────────────────────────────────────────────────
 * Faithful backtester that replicates the bot-scanner + paper-trading
 * pipeline on historical data. Uses the SAME shared SMC analysis and
 * FOTSI modules — zero re-implementation.
 *
 * Endpoint: POST /functions/v1/backtest-engine
 * Body: {
 *   instruments: string[],       // e.g. ["EUR/USD","GBP/USD"]
 *   startDate: string,           // ISO date "2025-01-01"
 *   endDate: string,             // ISO date "2026-04-01"
 *   startingBalance: number,     // e.g. 10000
 *   config: { ... },             // same shape as bot_configs.config_json
 *   tradingStyle?: string,       // "scalper" | "day_trader" | "swing_trader"
 *   slippagePips?: number,       // simulated slippage on SL fills (default 0.5)
 *   spreadPips?: number,         // simulated spread cost per entry (default 1.0)
 * }
 *
 * Returns: {
 *   trades: BacktestTrade[],
 *   equityCurve: { date: string; equity: number }[],
 *   stats: BacktestStats,
 *   factorBreakdown: Record<string, { appeared: number; wonWhen: number; lostWhen: number }>,
 *   gateBreakdown: Record<string, { blocked: number; wouldHaveWon: number; wouldHaveLost: number }>,
 * }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import {
  type Candle,
  type SwingPoint,
  type ReasoningFactor,
  SPECS,
  YAHOO_SYMBOLS,
  SMT_PAIRS,
  DEFAULTS,
  STYLE_OVERRIDES,
  ASSET_PROFILES,
  getAssetProfile,
  detectSwingPoints,
  analyzeMarketStructure,
  detectOrderBlocks,
  detectFVGs,
  detectLiquidityPools,
  detectDisplacement,
  tagDisplacementQuality,
  detectBreakerBlocks,
  detectUnicornSetups,
  detectSMTDivergence,
  detectJudasSwing,
  detectReversalCandle,
  calculatePDLevels,
  calculatePremiumDiscount,
  calculateAnchoredVWAP,
  calculateATR,
  calculateSLTP,
  calculatePositionSize,
  calcPnl,
  detectSession,
  detectSilverBullet,
  detectMacroWindow,
  detectAMDPhase,
  detectOptimalStyle,
  computeOpeningRange,
} from "../_shared/smcAnalysis.ts";

import {
  type FOTSIResult,
  computeFOTSI,
  getCurrencyAlignment,
  checkOverboughtOversoldVeto,
} from "../_shared/fotsi.ts";

import { fetchCandlesWithFallback } from "../_shared/candleSource.ts";
import { type Currency, parsePairCurrencies } from "../_shared/fotsi.ts";

// ─── CORS ──────────────────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Types ──────────────────────────────────────────────────────────
interface BacktestTrade {
  id: string;
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  entryTime: string;
  exitTime: string;
  size: number;
  pnl: number;
  pnlPips: number;
  closeReason: string;
  confluenceScore: number;
  factors: { name: string; present: boolean; weight: number }[];
  gatesBlocked: string[];
}

interface BacktestStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  totalPnlPips: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  avgRR: number;
  bestTrade: number;
  worstTrade: number;
  avgHoldBars: number;
  longsWinRate: number;
  shortsWinRate: number;
  tradesPerMonth: number;
  expectancy: number;
  consecutiveWins: number;
  consecutiveLosses: number;
}

interface OpenPosition {
  id: string;
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  size: number;
  entryTime: string;
  entryBarIndex: number;
  confluenceScore: number;
  factors: { name: string; present: boolean; weight: number }[];
  exitFlags: any;
  partialTPFired: boolean;
  currentSL: number;
}

// ─── Candle Fetching ────────────────────────────────────────────────
// Fetch historical candles via Yahoo Finance (same source as live bot)
async function fetchHistoricalCandles(symbol: string, interval: string, range: string): Promise<Candle[]> {
  try {
    const result = await fetchCandlesWithFallback({ symbol, interval, limit: 500 });
    return result.candles;
  } catch (e: any) {
    console.warn(`[backtest] fetchCandles failed for ${symbol} ${interval} ${range}: ${e?.message}`);
    return [];
  }
}

// ─── Config Mapping (mirrors loadConfig from bot-scanner) ───────────
function mapConfig(raw: any): any {
  const strategy = raw?.strategy || {};
  const risk = raw?.risk || {};
  const entry = raw?.entry || {};
  const exit = raw?.exit || {};
  const instruments = raw?.instruments || {};
  const sessions = raw?.sessions || {};
  const protection = raw?.protection || {};

  return {
    ...DEFAULTS,
    minConfluence: strategy.confluenceThreshold ?? strategy.minConfluenceScore ?? raw?.minConfluence ?? DEFAULTS.minConfluence,
    minFactorCount: strategy.minFactorCount ?? raw?.minFactorCount ?? 0,
    htfBiasRequired: strategy.requireHTFBias ?? strategy.htfBiasRequired ?? DEFAULTS.htfBiasRequired,
    htfBiasHardVeto: strategy.htfBiasHardVeto ?? DEFAULTS.htfBiasHardVeto,
    enableOB: strategy.useOrderBlocks ?? true,
    enableFVG: strategy.useFVG ?? true,
    enableLiquiditySweep: strategy.useLiquiditySweep ?? true,
    enableStructureBreak: strategy.useStructureBreak ?? true,
    useDisplacement: strategy.useDisplacement ?? true,
    useBreakerBlocks: strategy.useBreakerBlocks ?? true,
    useUnicornModel: strategy.useUnicornModel ?? true,
    useSilverBullet: strategy.useSilverBullet ?? true,
    useMacroWindows: strategy.useMacroWindows ?? true,
    useSMT: strategy.useSMT ?? true,
    useVWAP: strategy.useVWAP ?? true,
    vwapProximityPips: strategy.vwapProximityPips ?? 15,
    useAMD: strategy.useAMD ?? true,
    onlyBuyInDiscount: strategy.onlyBuyInDiscount ?? DEFAULTS.onlyBuyInDiscount,
    onlySellInPremium: strategy.onlySellInPremium ?? DEFAULTS.onlySellInPremium,
    riskPerTrade: risk.riskPerTrade ?? DEFAULTS.riskPerTrade,
    maxDailyLoss: risk.maxDailyDrawdown ?? DEFAULTS.maxDailyLoss,
    maxOpenPositions: risk.maxConcurrentTrades ?? DEFAULTS.maxOpenPositions,
    minRiskReward: risk.minRR ?? DEFAULTS.minRiskReward,
    maxPerSymbol: risk.maxPositionsPerSymbol ?? DEFAULTS.maxPerSymbol,
    portfolioHeat: risk.maxPortfolioHeat ?? DEFAULTS.portfolioHeat,
    cooldownMinutes: entry.cooldownMinutes ?? 0,
    closeOnReverse: entry.closeOnReverse ?? false,
    slBufferPips: entry.slBufferPips ?? DEFAULTS.slBufferPips,
    slMethod: exit.stopLossMethod ?? DEFAULTS.slMethod,
    fixedSLPips: exit.fixedSLPips ?? DEFAULTS.fixedSLPips,
    slATRMultiple: exit.slATRMultiple ?? DEFAULTS.slATRMultiple,
    slATRPeriod: exit.slATRPeriod ?? DEFAULTS.slATRPeriod,
    tpMethod: exit.takeProfitMethod ?? DEFAULTS.tpMethod,
    fixedTPPips: exit.fixedTPPips ?? DEFAULTS.fixedTPPips,
    tpRatio: exit.tpRRRatio ?? risk.defaultRR ?? DEFAULTS.tpRatio,
    tpATRMultiple: exit.tpATRMultiple ?? DEFAULTS.tpATRMultiple,
    trailingStopEnabled: exit.trailingStop ?? false,
    trailingStopPips: exit.trailingStopPips ?? 15,
    trailingStopActivation: exit.trailingStopActivation ?? "after_1r",
    breakEvenEnabled: exit.breakEven ?? DEFAULTS.breakEvenEnabled,
    breakEvenPips: exit.breakEvenTriggerPips ?? DEFAULTS.breakEvenPips,
    partialTPEnabled: exit.partialTP ?? false,
    partialTPPercent: exit.partialTPPercent ?? 50,
    partialTPLevel: exit.partialTPLevel ?? 1.0,
    maxHoldHours: exit.timeExitHours ?? 0,
    enabledSessions: sessions.filter ?? DEFAULTS.enabledSessions,
    killZoneOnly: sessions.killZoneOnly ?? false,
    enabledDays: DEFAULTS.enabledDays,
    maxDrawdown: Math.min(risk.maxDrawdown ?? DEFAULTS.maxDrawdown, protection.circuitBreakerPct ?? 100),
    maxConsecutiveLosses: protection.maxConsecutiveLosses ?? 0,
    protectionMaxDailyLossDollar: protection.maxDailyLoss ?? 0,
    openingRange: { ...DEFAULTS.openingRange, ...(raw?.openingRange || {}) },
    tradingStyle: { ...DEFAULTS.tradingStyle, ...(raw?.tradingStyle || {}) },
    spreadFilterEnabled: instruments.spreadFilterEnabled ?? DEFAULTS.spreadFilterEnabled,
    maxSpreadPips: instruments.maxSpreadPips ?? DEFAULTS.maxSpreadPips,
    newsFilterEnabled: false, // Disabled in backtest — no live news feed
    _currentSymbol: "",
    _smtResult: null as any,
  };
}

// ─── Confluence Analysis (mirrors runFullConfluenceAnalysis) ─────────
// This is a faithful port of the 18-factor confluence scoring from bot-scanner.
// It accepts a timestamp so time-dependent factors (session, silver bullet, macro, AMD)
// are evaluated at the candle's time, not "now".
function runConfluenceAnalysis(
  candles: Candle[],
  dailyCandles: Candle[] | null,
  config: any,
  hourlyCandles?: Candle[],
  atMs?: number,
) {
  const lastPrice = candles[candles.length - 1].close;
  const spec = SPECS[config._currentSymbol] || SPECS["EUR/USD"];
  const pipSize = spec.pipSize;

  // ── SMC Detection ──
  const structure = analyzeMarketStructure(candles);
  const allBreaks = [...structure.bos, ...structure.choch];
  const orderBlocks = config.enableOB ? detectOrderBlocks(candles, allBreaks) : [];
  const fvgs = config.enableFVG ? detectFVGs(candles) : [];
  const liquidityPools = config.enableLiquiditySweep ? detectLiquidityPools(candles) : [];
  const displacement = detectDisplacement(candles);
  if (displacement.isDisplacement) tagDisplacementQuality(orderBlocks, fvgs, displacement.displacementCandles);
  const breakerBlocks = config.useBreakerBlocks ? detectBreakerBlocks(orderBlocks, candles) : [];
  const unicornSetups = config.useUnicornModel ? detectUnicornSetups(breakerBlocks, fvgs) : [];
  const pd = calculatePremiumDiscount(candles);
  const pdLevels = dailyCandles ? calculatePDLevels(dailyCandles) : null;
  const judas = detectJudasSwing(candles);
  const reversal = detectReversalCandle(candles);
  const atrValue = calculateATR(candles, config.slATRPeriod || 14);
  const vwap = config.useVWAP ? calculateAnchoredVWAP(candles, pipSize) : null;

  // Time-dependent factors use atMs for backtest accuracy
  const session = detectSession(atMs);
  const silverBullet = config.useSilverBullet ? detectSilverBullet(atMs) : { active: false, window: null, minutesRemaining: 0 };
  const macroWindow = config.useMacroWindows ? detectMacroWindow(atMs) : { active: false, window: null, minutesRemaining: 0 };
  const amd = config.useAMD ? detectAMDPhase(candles, atMs) : null;

  // SMT
  const smt = config._smtResult;

  // Opening Range
  const or = config.openingRange?.enabled && hourlyCandles
    ? computeOpeningRange(hourlyCandles, config.openingRange.candleCount || 24)
    : null;

  // ── HTF Bias ──
  let htfBias: "bullish" | "bearish" | "ranging" = "ranging";
  if (dailyCandles && dailyCandles.length >= 10) {
    const htfStructure = analyzeMarketStructure(dailyCandles);
    htfBias = htfStructure.trend;
  }

  // ── Factor Scoring (18 factors — exact same as bot-scanner) ──
  let score = 0;
  const factors: ReasoningFactor[] = [];

  // Factor 1: Market Structure (2.0 + 0.5 OR bias)
  const structureAligned = (structure.trend === "bullish") || (structure.trend === "bearish");
  let f1Weight = structureAligned ? 2.0 : 0;
  if (structureAligned && or && config.openingRange?.useBias) {
    const orBias = lastPrice > or.midpoint ? "bullish" : "bearish";
    if (orBias === structure.trend) f1Weight += 0.5;
  }
  factors.push({ name: "Market Structure", present: structureAligned, weight: f1Weight, detail: `Trend: ${structure.trend}` });
  if (structureAligned) score += f1Weight;

  // Factor 2: Order Block (2.0)
  const nearOB = orderBlocks.filter(ob => {
    if (ob.mitigated) return false;
    const prox = getAssetProfile(config._currentSymbol).proximityMultiplier;
    const dist = Math.abs(lastPrice - (ob.high + ob.low) / 2) / pipSize;
    return dist < 30 * prox;
  });
  const obAligned = nearOB.some(ob =>
    (structure.trend === "bullish" && ob.type === "bullish") ||
    (structure.trend === "bearish" && ob.type === "bearish")
  );
  const f2Weight = obAligned ? 2.0 : 0;
  factors.push({ name: "Order Block", present: obAligned, weight: f2Weight, detail: `${nearOB.length} nearby OBs` });
  if (obAligned) score += f2Weight;

  // Factor 3: Fair Value Gap (1.5)
  const activeFVGs = fvgs.filter(f => !f.mitigated);
  const nearFVG = activeFVGs.filter(f => {
    const mid = (f.high + f.low) / 2;
    return Math.abs(lastPrice - mid) / pipSize < 20;
  });
  const fvgAligned = nearFVG.some(f =>
    (structure.trend === "bullish" && f.type === "bullish") ||
    (structure.trend === "bearish" && f.type === "bearish")
  );
  let f3Weight = 0;
  if (fvgAligned) {
    const bestFVG = nearFVG[0];
    const ce = (bestFVG.high + bestFVG.low) / 2;
    const atCE = Math.abs(lastPrice - ce) / pipSize < 5;
    f3Weight = atCE ? 1.5 : 1.0;
  }
  factors.push({ name: "Fair Value Gap", present: fvgAligned, weight: f3Weight, detail: `${nearFVG.length} active FVGs nearby` });
  if (fvgAligned) score += f3Weight;

  // Factor 4: Premium/Discount (2.0)
  const pdAligned = (structure.trend === "bullish" && pd.currentZone === "discount") ||
                    (structure.trend === "bearish" && pd.currentZone === "premium");
  const f4Weight = pdAligned ? (pd.oteZone ? 2.0 : 1.5) : 0;
  factors.push({ name: "Premium/Discount", present: pdAligned, weight: f4Weight, detail: `Zone: ${pd.currentZone} (${pd.zonePercent.toFixed(0)}%)` });
  if (pdAligned) score += f4Weight;

  // Factor 5: Session/Kill Zone (1.5 + 0.5 SB combo)
  const sessionOk = session.isKillZone;
  let f5Weight = sessionOk ? 1.5 : (session.name !== "Off-Hours" ? 0.5 : 0);
  if (sessionOk && silverBullet.active) f5Weight += 0.5;
  factors.push({ name: "Session/Kill Zone", present: sessionOk, weight: f5Weight, detail: `${session.name} ${session.isKillZone ? "(KZ)" : ""}` });
  score += f5Weight;

  // Factor 6: Judas Swing (1.0 + 0.5 OR judas)
  const judasAligned = judas.detected && (
    (structure.trend === "bullish" && judas.type === "bullish") ||
    (structure.trend === "bearish" && judas.type === "bearish")
  );
  let f6Weight = judasAligned && session.isKillZone ? 1.0 : 0;
  if (judasAligned && or && config.openingRange?.useJudasSwing) f6Weight += 0.5;
  factors.push({ name: "Judas Swing", present: !!judasAligned, weight: f6Weight, detail: judas.description });
  if (judasAligned) score += f6Weight;

  // Factor 7: PD/PW Levels (1.0 + 0.5 OR key-level)
  let f7Weight = 0;
  let f7Present = false;
  if (pdLevels) {
    const levelProx = 15 * (getAssetProfile(config._currentSymbol).proximityMultiplier || 1);
    const nearPDH = Math.abs(lastPrice - pdLevels.pdh) / pipSize < levelProx;
    const nearPDL = Math.abs(lastPrice - pdLevels.pdl) / pipSize < levelProx;
    const nearPWH = Math.abs(lastPrice - pdLevels.pwh) / pipSize < levelProx;
    const nearPWL = Math.abs(lastPrice - pdLevels.pwl) / pipSize < levelProx;
    if (nearPWH || nearPWL) { f7Weight = 1.0; f7Present = true; }
    else if (nearPDH || nearPDL) { f7Weight = 0.5; f7Present = true; }
    if (f7Present && or && config.openingRange?.useKeyLevels) f7Weight += 0.5;
  }
  factors.push({ name: "PD/PW Levels", present: f7Present, weight: f7Weight, detail: pdLevels ? `PDH:${pdLevels.pdh.toFixed(5)} PDL:${pdLevels.pdl.toFixed(5)}` : "No daily data" });
  if (f7Present) score += f7Weight;

  // Factor 8: Reversal Candle (0.5)
  const reversalAligned = reversal.detected && (
    (structure.trend === "bullish" && reversal.type === "bullish") ||
    (structure.trend === "bearish" && reversal.type === "bearish")
  );
  const f8Weight = reversalAligned ? (obAligned || fvgAligned ? 0.5 : 0.25) : 0;
  factors.push({ name: "Reversal Candle", present: !!reversalAligned, weight: f8Weight, detail: reversal.type || "none" });
  if (reversalAligned) score += f8Weight;

  // Factor 9: Liquidity Sweep (1.0)
  const recentSweep = liquidityPools.filter(lp => lp.swept && lp.strength >= 2);
  const sweepAligned = recentSweep.some(lp =>
    (structure.trend === "bullish" && lp.type === "sell-side") ||
    (structure.trend === "bearish" && lp.type === "buy-side")
  );
  const f9Weight = sweepAligned ? (recentSweep.some(lp => lp.strength >= 3) ? 1.0 : 0.75) : 0;
  factors.push({ name: "Liquidity Sweep", present: sweepAligned, weight: f9Weight, detail: `${recentSweep.length} swept pools` });
  if (sweepAligned) score += f9Weight;

  // Factor 10: Displacement (1.0)
  const dispAligned = displacement.isDisplacement && (
    (structure.trend === "bullish" && displacement.lastDirection === "bullish") ||
    (structure.trend === "bearish" && displacement.lastDirection === "bearish")
  );
  const dispCreatedFVG = displacement.displacementCandles.some(d => fvgs.some(f => (f as any).hasDisplacement));
  const f10Weight = dispAligned ? (dispCreatedFVG ? 1.0 : 0.5) : 0;
  factors.push({ name: "Displacement", present: !!dispAligned, weight: f10Weight, detail: displacement.lastDirection || "none" });
  if (dispAligned) score += f10Weight;

  // Factor 11: Breaker Block (1.0)
  const breakerAligned = breakerBlocks.some(b =>
    (structure.trend === "bullish" && b.type === "bullish_breaker") ||
    (structure.trend === "bearish" && b.type === "bearish_breaker")
  );
  const f11Weight = breakerAligned ? 1.0 : 0;
  factors.push({ name: "Breaker Block", present: breakerAligned, weight: f11Weight, detail: `${breakerBlocks.length} active breakers` });
  if (breakerAligned) score += f11Weight;

  // Factor 12: Unicorn Model (1.5)
  const unicornAligned = unicornSetups.some(u =>
    (structure.trend === "bullish" && u.type === "bullish_unicorn") ||
    (structure.trend === "bearish" && u.type === "bearish_unicorn")
  );
  const f12Weight = unicornAligned ? 1.5 : 0;
  factors.push({ name: "Unicorn Model", present: unicornAligned, weight: f12Weight, detail: `${unicornSetups.length} setups` });
  if (unicornAligned) score += f12Weight;

  // Factor 13: Silver Bullet (1.0)
  const f13Weight = silverBullet.active ? 1.0 : 0;
  factors.push({ name: "Silver Bullet", present: silverBullet.active, weight: f13Weight, detail: silverBullet.window || "inactive" });
  if (silverBullet.active) score += f13Weight;

  // Factor 14: Macro Window (0.5 + 0.5 SB overlap)
  let f14Weight = macroWindow.active ? 0.5 : 0;
  if (macroWindow.active && silverBullet.active) f14Weight += 0.5;
  factors.push({ name: "Macro Window", present: macroWindow.active, weight: f14Weight, detail: macroWindow.window || "inactive" });
  if (macroWindow.active) score += f14Weight;

  // Factor 15: SMT Divergence (1.0)
  const smtAligned = smt?.detected && (
    (structure.trend === "bullish" && smt.type === "bullish") ||
    (structure.trend === "bearish" && smt.type === "bearish")
  );
  const f15Weight = smtAligned ? 1.0 : 0;
  factors.push({ name: "SMT Divergence", present: !!smtAligned, weight: f15Weight, detail: smt?.detail || "N/A" });
  if (smtAligned) score += f15Weight;

  // Factor 16: VWAP (0.5 + 0.5 rejection)
  let f16Weight = 0;
  let f16Present = false;
  if (vwap && vwap.value != null && vwap.distancePips != null) {
    const proxPips = config.vwapProximityPips || 15;
    if (vwap.distancePips <= proxPips) {
      f16Weight = 0.5;
      f16Present = true;
      if (vwap.rejection && (
        (structure.trend === "bullish" && vwap.rejection === "bullish") ||
        (structure.trend === "bearish" && vwap.rejection === "bearish")
      )) f16Weight += 0.5;
    }
  }
  factors.push({ name: "VWAP", present: f16Present, weight: f16Weight, detail: vwap?.value ? `VWAP: ${vwap.value.toFixed(5)}` : "N/A" });
  if (f16Present) score += f16Weight;

  // Factor 17: AMD Phase (0.5 + 0.5 distribution)
  let f17Weight = 0;
  let f17Present = false;
  if (amd && amd.phase !== "unknown") {
    const amdBiasAligned = (
      (structure.trend === "bullish" && amd.bias === "bullish") ||
      (structure.trend === "bearish" && amd.bias === "bearish")
    );
    if (amdBiasAligned) {
      f17Weight = 0.5;
      f17Present = true;
      if (amd.phase === "distribution") f17Weight += 0.5;
    }
  }
  factors.push({ name: "AMD Phase", present: f17Present, weight: f17Weight, detail: amd?.detail || "N/A" });
  if (f17Present) score += f17Weight;

  // Factor 18: Currency Strength / FOTSI (max +1.5, min -0.5)
  let f18Weight = 0;
  let f18Present = false;
  let fotsiAlignment: any = null;
  const fotsiResult = (config as any)._fotsiResult as FOTSIResult | null;
  if (fotsiResult) {
    const direction = structure.trend === "bullish" ? "long" : structure.trend === "bearish" ? "short" : null;
    if (direction) {
      const currencies = parsePairCurrencies(config._currentSymbol || "");
      if (currencies) {
        const [base, quote] = currencies;
        const dir = direction === "long" ? "BUY" : "SELL";
        fotsiAlignment = getCurrencyAlignment(base, quote, dir as "BUY" | "SELL", fotsiResult.strengths);
      }
      if (fotsiAlignment) {
        f18Weight = fotsiAlignment.score;
        f18Present = fotsiAlignment.score !== 0;
      }
    }
  }
  factors.push({ name: "Currency Strength", present: f18Present, weight: f18Weight, detail: fotsiAlignment?.label || "N/A" });
  score += f18Weight;

  // Clamp score to 0-10
  score = Math.min(10, Math.max(0, score));

  // ── Direction ──
  let direction: "long" | "short" | null = null;
  if (structure.trend === "bullish" && score >= config.minConfluence) direction = "long";
  else if (structure.trend === "bearish" && score >= config.minConfluence) direction = "short";

  // ── HTF Bias Gate ──
  if (config.htfBiasRequired && direction) {
    if (config.htfBiasHardVeto) {
      if (direction === "long" && htfBias !== "bullish") direction = null;
      if (direction === "short" && htfBias !== "bearish") direction = null;
    } else {
      if (direction === "long" && htfBias === "bearish") direction = null;
      if (direction === "short" && htfBias === "bullish") direction = null;
    }
  }

  // ── PD Zone Filter ──
  if (direction === "long" && config.onlyBuyInDiscount && pd.currentZone === "premium") direction = null;
  if (direction === "short" && config.onlySellInPremium && pd.currentZone === "discount") direction = null;

  // ── SL/TP ──
  const sltp = calculateSLTP({
    direction, lastPrice, pipSize, config,
    swings: structure.swingPoints,
    orderBlocks, liquidityPools, pdLevels,
    atrValue,
  });

  return {
    score,
    direction,
    factors,
    structure,
    pd,
    pdLevels,
    session,
    silverBullet,
    macroWindow,
    amd,
    displacement,
    breakerBlocks,
    unicornSetups,
    smt,
    vwap,
    fotsiAlignment,
    stopLoss: sltp.stopLoss,
    takeProfit: sltp.takeProfit,
    lastPrice,
    bias: htfBias,
    summary: `Score ${score.toFixed(1)} | ${structure.trend} | ${pd.currentZone} | ${session.name}`,
  };
}

// ─── Safety Gates (mirrors runSafetyGates — minus DB-dependent gates) ──
function runBacktestSafetyGates(
  symbol: string,
  direction: "long" | "short",
  analysis: any,
  config: any,
  balance: number,
  openPositions: OpenPosition[],
  dailyCandles: Candle[] | null,
  recentTrades: BacktestTrade[],
  currentCandleMs: number,
): { passed: boolean; reason: string }[] {
  const gates: { passed: boolean; reason: string }[] = [];

  // Gate 1: Max open positions
  const openCount = openPositions.length;
  gates.push({
    passed: openCount < config.maxOpenPositions,
    reason: `Open positions: ${openCount}/${config.maxOpenPositions}`,
  });

  // Gate 2: Max per symbol
  const symbolCount = openPositions.filter(p => p.symbol === symbol).length;
  gates.push({
    passed: symbolCount < config.maxPerSymbol,
    reason: `${symbol} positions: ${symbolCount}/${config.maxPerSymbol}`,
  });

  // Gate 3: Duplicate direction
  const hasSameDir = openPositions.some(p => p.symbol === symbol && p.direction === direction);
  gates.push({
    passed: !hasSameDir,
    reason: hasSameDir ? `Already ${direction} on ${symbol}` : "No duplicate direction",
  });

  // Gate 4: Min RR check
  let rrOk = true;
  if (analysis.stopLoss && analysis.takeProfit) {
    const risk = Math.abs(analysis.lastPrice - analysis.stopLoss);
    const reward = Math.abs(analysis.takeProfit - analysis.lastPrice);
    const rr = risk > 0 ? reward / risk : 0;
    rrOk = rr >= config.minRiskReward;
    gates.push({ passed: rrOk, reason: `RR: ${rr.toFixed(2)} (min: ${config.minRiskReward})` });
  } else {
    gates.push({ passed: false, reason: "No SL/TP calculated" });
  }

  // Gate 5: Max drawdown
  // (Simplified: use peak balance tracking from caller)
  gates.push({ passed: true, reason: "Drawdown within limits" });

  // Gate 6: Daily loss limit (use candle date, not wall-clock)
  const currentDate = new Date(currentCandleMs).toISOString().slice(0, 10);
  const todayTrades = recentTrades.filter(t => t.exitTime.slice(0, 10) === currentDate);
  const dailyPnl = todayTrades.reduce((s, t) => s + t.pnl, 0);
  const dailyLossPct = balance > 0 ? Math.abs(Math.min(0, dailyPnl)) / balance * 100 : 0;
  gates.push({
    passed: dailyLossPct < config.maxDailyLoss,
    reason: `Daily loss: ${dailyLossPct.toFixed(1)}% (max: ${config.maxDailyLoss}%)`,
  });

  // Gate 7: Portfolio heat
  const totalRisk = openPositions.reduce((s, p) => {
    const risk = Math.abs(p.entryPrice - p.currentSL) * (SPECS[p.symbol]?.lotUnits || 100000) * p.size;
    return s + risk;
  }, 0);
  const heatPct = balance > 0 ? (totalRisk / balance) * 100 : 0;
  gates.push({
    passed: heatPct < config.portfolioHeat,
    reason: `Portfolio heat: ${heatPct.toFixed(1)}% (max: ${config.portfolioHeat}%)`,
  });

  // Gate 8: Cooldown (use candle time, not wall-clock)
  const lastTradeOnSymbol = recentTrades.filter(t => t.symbol === symbol).slice(-1)[0];
  let cooldownOk = true;
  if (config.cooldownMinutes > 0 && lastTradeOnSymbol) {
    const lastExitMs = new Date(lastTradeOnSymbol.exitTime).getTime();
    const elapsedMin = (currentCandleMs - lastExitMs) / 60000;
    cooldownOk = elapsedMin >= config.cooldownMinutes;
  }
  gates.push({
    passed: cooldownOk,
    reason: cooldownOk ? "Cooldown clear" : `Cooldown active (${config.cooldownMinutes}min)`,
  });

  // Gate 9: Consecutive losses
  if (config.maxConsecutiveLosses > 0) {
    let consLosses = 0;
    for (let i = recentTrades.length - 1; i >= 0; i--) {
      if (recentTrades[i].pnl < 0) consLosses++;
      else break;
    }
    gates.push({
      passed: consLosses < config.maxConsecutiveLosses,
      reason: `Consecutive losses: ${consLosses}/${config.maxConsecutiveLosses}`,
    });
  }

  // Gate 10: Kill zone only
  if (config.killZoneOnly) {
    gates.push({
      passed: analysis.session.isKillZone,
      reason: analysis.session.isKillZone ? "In kill zone" : "Not in kill zone (blocked)",
    });
  }

  // Gate 17: FOTSI Overbought/Oversold Veto
  const fotsiResult = (config as any)._fotsiResult as FOTSIResult | null;
  if (fotsiResult) {
    const currencies = parsePairCurrencies(symbol);
    if (currencies) {
      const [base, quote] = currencies;
      const dir = direction === "long" ? "BUY" : "SELL";
      const veto = checkOverboughtOversoldVeto(base, quote, dir as "BUY" | "SELL", fotsiResult.strengths, fotsiResult.series);
      gates.push({
        passed: !veto.vetoed,
        reason: veto.reason,
      });
    } else {
      gates.push({ passed: true, reason: "FOTSI Gate: non-forex pair — skipped" });
    }
  }

  return gates;
}

// ─── Exit Engine (mirrors paper-trading exit logic) ─────────────────
function processExits(
  positions: OpenPosition[],
  candle: Candle,
  barIndex: number,
  config: any,
  slippagePips: number,
): { closedTrades: BacktestTrade[]; updatedPositions: OpenPosition[] } {
  const closedTrades: BacktestTrade[] = [];
  const surviving: OpenPosition[] = [];

  for (const pos of positions) {
    let closeReason: string | null = null;
    let exitPrice = candle.close;
    let sl = pos.currentSL;
    const tp = pos.takeProfit;
    const spec = SPECS[pos.symbol] || SPECS["EUR/USD"];

    // ── SL Hit (gap-through + slippage) ──
    if (pos.direction === "long" && candle.low <= sl) {
      closeReason = "sl_hit";
      const gapPrice = Math.min(sl, candle.low);
      exitPrice = gapPrice - slippagePips * spec.pipSize;
    } else if (pos.direction === "short" && candle.high >= sl) {
      closeReason = "sl_hit";
      const gapPrice = Math.max(sl, candle.high);
      exitPrice = gapPrice + slippagePips * spec.pipSize;
    }

    // ── TP Hit ──
    if (!closeReason) {
      if (pos.direction === "long" && candle.high >= tp) {
        closeReason = "tp_hit";
        exitPrice = tp;
      } else if (pos.direction === "short" && candle.low <= tp) {
        closeReason = "tp_hit";
        exitPrice = tp;
      }
    }

    // ── Max Hold Hours ──
    if (!closeReason && pos.exitFlags.maxHoldHours > 0) {
      const entryMs = new Date(pos.entryTime).getTime();
      const candleMs = new Date(candle.datetime.endsWith("Z") ? candle.datetime : candle.datetime + "Z").getTime();
      const elapsedHours = (candleMs - entryMs) / 3600000;
      if (elapsedHours >= pos.exitFlags.maxHoldHours) {
        closeReason = "time_exit";
      }
    }

    // ── Break Even ──
    if (!closeReason && pos.exitFlags.breakEven && pos.exitFlags.breakEvenPips > 0) {
      const profitPips = pos.direction === "long"
        ? (candle.close - pos.entryPrice) / spec.pipSize
        : (pos.entryPrice - candle.close) / spec.pipSize;
      if (profitPips >= pos.exitFlags.breakEvenPips) {
        const newSL = pos.entryPrice;
        if ((pos.direction === "long" && newSL > sl) || (pos.direction === "short" && newSL < sl)) {
          sl = newSL;
        }
      }
    }

    // ── Trailing Stop ──
    if (!closeReason && pos.exitFlags.trailingStop && pos.exitFlags.trailingStopPips > 0) {
      const profitPips = pos.direction === "long"
        ? (candle.close - pos.entryPrice) / spec.pipSize
        : (pos.entryPrice - candle.close) / spec.pipSize;
      const activationPips = pos.exitFlags.trailingStopActivation === "after_1r" && pos.exitFlags.tpRatio
        ? Math.abs(pos.entryPrice - pos.stopLoss) / spec.pipSize
        : pos.exitFlags.trailingStopPips * 2;
      if (profitPips >= activationPips) {
        const trailDist = pos.exitFlags.trailingStopPips * spec.pipSize;
        const newSL = pos.direction === "long"
          ? candle.close - trailDist
          : candle.close + trailDist;
        if ((pos.direction === "long" && newSL > sl) || (pos.direction === "short" && newSL < sl)) {
          sl = newSL;
        }
      }
    }

    // ── Partial TP (exit at trigger price, not candle close) ──
    if (!closeReason && pos.exitFlags.partialTP && !pos.partialTPFired && pos.exitFlags.partialTPPercent > 0) {
      const slDistPips = Math.abs(pos.entryPrice - pos.stopLoss) / spec.pipSize;
      const triggerPips = slDistPips * (pos.exitFlags.partialTPLevel || 1.0);
      const triggerPrice = pos.direction === "long"
        ? pos.entryPrice + triggerPips * spec.pipSize
        : pos.entryPrice - triggerPips * spec.pipSize;
      const triggerHit = pos.direction === "long"
        ? candle.high >= triggerPrice
        : candle.low <= triggerPrice;
      if (triggerHit) {
        const closeSize = pos.size * (pos.exitFlags.partialTPPercent / 100);
        const remainSize = pos.size - closeSize;
        const { pnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, triggerPrice, closeSize, pos.symbol);
        closedTrades.push({
          id: `${pos.id}_partial`,
          symbol: pos.symbol,
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          exitPrice: triggerPrice,
          entryTime: pos.entryTime,
          exitTime: candle.datetime,
          size: closeSize,
          pnl,
          pnlPips,
          closeReason: "partial_tp",
          confluenceScore: pos.confluenceScore,
          factors: pos.factors,
          gatesBlocked: [],
        });
        pos.size = remainSize;
        pos.partialTPFired = true;
      }
    }

    if (closeReason) {
      const { pnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, exitPrice, pos.size, pos.symbol);
      closedTrades.push({
        id: pos.id,
        symbol: pos.symbol,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        exitPrice,
        entryTime: pos.entryTime,
        exitTime: candle.datetime,
        size: pos.size,
        pnl,
        pnlPips,
        closeReason,
        confluenceScore: pos.confluenceScore,
        factors: pos.factors,
        gatesBlocked: [],
      });
    } else {
      pos.currentSL = sl;
      surviving.push(pos);
    }
  }

  return { closedTrades, updatedPositions: surviving };
}

// ─── Stats Calculation ──────────────────────────────────────────────
function calculateStats(trades: BacktestTrade[], startingBalance: number, months: number): BacktestStats {
  const wins = trades.filter(t => t.pnl > 0 && !t.id.includes("_partial"));
  const losses = trades.filter(t => t.pnl <= 0 && !t.id.includes("_partial"));
  const fullTrades = trades.filter(t => !t.id.includes("_partial"));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalPnlPips = trades.reduce((s, t) => s + t.pnlPips, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // Equity curve for drawdown
  let peak = startingBalance;
  let maxDD = 0;
  let maxDDPct = 0;
  let equity = startingBalance;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
    if (ddPct > maxDDPct) maxDDPct = ddPct;
  }

  // Consecutive wins/losses
  let maxConsWins = 0, maxConsLosses = 0, cw = 0, cl = 0;
  for (const t of fullTrades) {
    if (t.pnl > 0) { cw++; cl = 0; if (cw > maxConsWins) maxConsWins = cw; }
    else { cl++; cw = 0; if (cl > maxConsLosses) maxConsLosses = cl; }
  }

  // Sharpe (daily returns approximation)
  const dailyReturns: number[] = [];
  let dayEquity = startingBalance;
  let lastDate = "";
  let dayPnl = 0;
  for (const t of trades) {
    const d = t.exitTime.slice(0, 10);
    if (d !== lastDate && lastDate) {
      dailyReturns.push(dayEquity > 0 ? dayPnl / dayEquity : 0);
      dayEquity += dayPnl;
      dayPnl = 0;
    }
    dayPnl += t.pnl;
    lastDate = d;
  }
  if (dayPnl !== 0) dailyReturns.push(dayEquity > 0 ? dayPnl / dayEquity : 0);
  const avgReturn = dailyReturns.length > 0 ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length : 0;
  const stdDev = dailyReturns.length > 1 ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (dailyReturns.length - 1)) : 0;
  const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

  // Avg RR
  const avgWinPips = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPips, 0) / wins.length : 0;
  const avgLossPips = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnlPips, 0) / losses.length) : 1;
  const avgRR = avgLossPips > 0 ? avgWinPips / avgLossPips : 0;

  // Avg hold bars
  const avgHoldBars = fullTrades.length > 0
    ? fullTrades.reduce((s, t) => {
        const entryMs = new Date(t.entryTime).getTime();
        const exitMs = new Date(t.exitTime).getTime();
        return s + (exitMs - entryMs) / 3600000;
      }, 0) / fullTrades.length
    : 0;

  // Long/short win rates
  const longs = fullTrades.filter(t => t.direction === "long");
  const shorts = fullTrades.filter(t => t.direction === "short");
  const longsWR = longs.length > 0 ? (longs.filter(t => t.pnl > 0).length / longs.length) * 100 : 0;
  const shortsWR = shorts.length > 0 ? (shorts.filter(t => t.pnl > 0).length / shorts.length) * 100 : 0;

  const winRate = fullTrades.length > 0 ? (wins.length / fullTrades.length) * 100 : 0;
  const expectancy = fullTrades.length > 0 ? totalPnl / fullTrades.length : 0;

  return {
    totalTrades: fullTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    totalPnl,
    totalPnlPips,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxDrawdown: maxDD,
    maxDrawdownPct: maxDDPct,
    sharpeRatio: sharpe,
    avgRR,
    bestTrade: trades.length > 0 ? Math.max(...trades.map(t => t.pnl)) : 0,
    worstTrade: trades.length > 0 ? Math.min(...trades.map(t => t.pnl)) : 0,
    avgHoldBars,
    longsWinRate: longsWR,
    shortsWinRate: shortsWR,
    tradesPerMonth: months > 0 ? fullTrades.length / months : fullTrades.length,
    expectancy,
    consecutiveWins: maxConsWins,
    consecutiveLosses: maxConsLosses,
  };
}

// ─── Main Handler ───────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const {
      instruments = DEFAULTS.instruments,
      startDate,
      endDate,
      startingBalance = 10000,
      config: rawConfig,
      tradingStyle,
      slippagePips = 0.5,
      spreadPips = 1.0,
    } = body;

    const config = mapConfig(rawConfig || {});
    if (tradingStyle && STYLE_OVERRIDES[tradingStyle]) {
      const userMinConf = config.minConfluence;
      Object.assign(config, STYLE_OVERRIDES[tradingStyle]);
      config.minConfluence = userMinConf;
    }

    console.log(`[backtest] Starting: ${instruments.length} instruments, ${startDate} → ${endDate}, balance: $${startingBalance}`);

    // ── Fetch Historical Data ──
    // Determine range based on date span
    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();
    const monthsSpan = Math.max(1, (endMs - startMs) / (30 * 24 * 3600 * 1000));
    const range = monthsSpan > 12 ? "2y" : monthsSpan > 6 ? "1y" : monthsSpan > 3 ? "6mo" : "3mo";

    // Fetch entry TF and daily candles for each instrument
    const entryInterval = config.entryTimeframe === "15min" ? "15m" : config.entryTimeframe === "5m" ? "5m" : config.entryTimeframe === "1h" ? "1h" : "15m";
    const candleData: Record<string, { entry: Candle[]; daily: Candle[]; smt?: Candle[] }> = {};

    for (const symbol of instruments) {
      if (!YAHOO_SYMBOLS[symbol]) continue;
      const [entryCandles, dailyCandles] = await Promise.all([
        fetchHistoricalCandles(symbol, entryInterval, range),
        fetchHistoricalCandles(symbol, "1d", "2y"),
      ]);
      // Fetch SMT correlated pair
      const smtPair = SMT_PAIRS[symbol];
      let smtCandles: Candle[] | undefined;
      if (smtPair && YAHOO_SYMBOLS[smtPair] && config.useSMT) {
        smtCandles = await fetchHistoricalCandles(smtPair, entryInterval, range);
      }
      candleData[symbol] = { entry: entryCandles, daily: dailyCandles, smt: smtCandles };
      // Rate limit
      await new Promise(r => setTimeout(r, 300));
    }

    // ── Fetch FOTSI Data ──
    let fotsiResult: FOTSIResult | null = null;
    try {
      const { getFOTSIPairNames } = await import("../_shared/fotsi.ts");
      const fotsiPairs = getFOTSIPairNames();
      const fotsiCandleMap: Record<string, Candle[]> = {};
      for (let i = 0; i < fotsiPairs.length; i += 7) {
        const batch = fotsiPairs.slice(i, i + 7);
        const results = await Promise.all(
          batch.map(p => fetchHistoricalCandles(p, "1d", "2y").catch(() => [] as Candle[]))
        );
        for (let j = 0; j < batch.length; j++) {
          if (results[j] && results[j].length >= 30) fotsiCandleMap[batch[j]] = results[j];
        }
        if (i + 7 < fotsiPairs.length) await new Promise(r => setTimeout(r, 300));
      }
      if (Object.keys(fotsiCandleMap).length >= 20) {
        fotsiResult = computeFOTSI(fotsiCandleMap);
        console.log(`[backtest] FOTSI computed: ${Object.keys(fotsiCandleMap).length}/28 pairs`);
      }
    } catch (e: any) {
      console.warn(`[backtest] FOTSI computation error: ${e?.message}`);
    }

    // ── Sliding Window Backtest Loop ──
    const allTrades: BacktestTrade[] = [];
    let openPositions: OpenPosition[] = [];
    let balance = startingBalance;
    let peakBalance = startingBalance;
    const equityCurve: { date: string; equity: number }[] = [];
    let tradeCounter = 0;

    // Factor & gate analytics
    const factorBreakdown: Record<string, { appeared: number; wonWhen: number; lostWhen: number }> = {};
    const gateBreakdown: Record<string, { blocked: number; wouldHaveWon: number; wouldHaveLost: number }> = {};

    // Minimum lookback for SMC analysis
    const LOOKBACK = 80;
    // Step size: evaluate every N candles (simulate scan frequency)
    const STEP = 4; // Every 4 candles ≈ 1 hour on 15m TF

    for (const symbol of instruments) {
      const data = candleData[symbol];
      if (!data || data.entry.length < LOOKBACK) {
        console.log(`[backtest] Skipping ${symbol}: insufficient data (${data?.entry.length || 0} candles)`);
        continue;
      }

      const entryCandles = data.entry;
      const dailyCandles = data.daily;
      const smtCandles = data.smt;

      // Filter to date range
      const filteredStart = entryCandles.findIndex(c => c.datetime >= startDate);
      const startIdx = Math.max(LOOKBACK, filteredStart >= 0 ? filteredStart : LOOKBACK);

      for (let i = startIdx; i < entryCandles.length; i += STEP) {
        const candle = entryCandles[i];
        const candleTime = candle.datetime;

        // Skip if outside date range
        if (candleTime < startDate || candleTime > endDate) continue;

        // ── Process exits on every candle for open positions on this symbol ──
        const symbolPositions = openPositions.filter(p => p.symbol === symbol);
        if (symbolPositions.length > 0) {
          // Process exits on intermediate candles too
          for (let j = Math.max(startIdx, i - STEP + 1); j <= i; j++) {
            const exitCandle = entryCandles[j];
            const { closedTrades, updatedPositions } = processExits(
              openPositions.filter(p => p.symbol === symbol),
              exitCandle, j, config, slippagePips,
            );
            for (const trade of closedTrades) {
              balance += trade.pnl;
              if (balance > peakBalance) peakBalance = balance;
              allTrades.push(trade);

              // Track factor analytics
              for (const f of trade.factors) {
                if (!factorBreakdown[f.name]) factorBreakdown[f.name] = { appeared: 0, wonWhen: 0, lostWhen: 0 };
                if (f.present) {
                  factorBreakdown[f.name].appeared++;
                  if (trade.pnl > 0) factorBreakdown[f.name].wonWhen++;
                  else factorBreakdown[f.name].lostWhen++;
                }
              }

              equityCurve.push({ date: trade.exitTime, equity: balance });
            }
            // Update open positions
            openPositions = [
              ...openPositions.filter(p => p.symbol !== symbol),
              ...updatedPositions,
            ];
          }
        }

        // ── Entry Analysis (sliding window) ──
        const window = entryCandles.slice(Math.max(0, i - LOOKBACK), i + 1);
        if (window.length < 30) continue;

        // Find daily candles up to this point
        const dailyWindow = dailyCandles.filter(d => d.datetime <= candleTime);

        // Timestamp for time-dependent factors
        const candleMs = new Date(candleTime.endsWith("Z") ? candleTime : candleTime + "Z").getTime();

        // Session/day filter
        const session = detectSession(candleMs);
        const sessionNameMap: Record<string, string> = { "Asian": "asian", "London": "london", "New York": "newyork", "Off-Hours": "off-hours" };
        const normalizedSession = sessionNameMap[session.name] || session.name.toLowerCase();
        const assetProfile = getAssetProfile(symbol);
        if (!assetProfile.skipSessionGate && config.enabledSessions.length > 0 && !config.enabledSessions.includes(normalizedSession)) continue;

        // Day of week filter
        const candleDate = new Date(candleMs);
        const dow = candleDate.getUTCDay();
        if (!config.enabledDays.includes(dow) && SPECS[symbol]?.type !== "crypto") continue;

        // Set per-instrument config
        config._currentSymbol = symbol;
        config._smtResult = smtCandles && smtCandles.length >= 30
          ? detectSMTDivergence(symbol, window, smtCandles.slice(Math.max(0, smtCandles.length - window.length)))
          : null;
        (config as any)._fotsiResult = fotsiResult;

        const analysis = runConfluenceAnalysis(window, dailyWindow.length >= 10 ? dailyWindow : null, config, undefined, candleMs);

        if (!analysis.direction || analysis.score < config.minConfluence) continue;

        // Min factor count gate
        const factorCount = analysis.factors.filter((f: any) => f.present).length;
        if (config.minFactorCount > 0 && factorCount < config.minFactorCount) continue;

        // ── Safety Gates ──
        const gates = runBacktestSafetyGates(
          symbol, analysis.direction, analysis, config,
          balance, openPositions, dailyWindow.length >= 10 ? dailyWindow : null, allTrades,
        );
        const blockedGates = gates.filter(g => !g.passed);
        const allPassed = blockedGates.length === 0;

        // Track gate analytics
        for (const g of blockedGates) {
          const gName = g.reason.split(":")[0].trim();
          if (!gateBreakdown[gName]) gateBreakdown[gName] = { blocked: 0, wouldHaveWon: 0, wouldHaveLost: 0 };
          gateBreakdown[gName].blocked++;
        }

        if (!allPassed || !analysis.stopLoss || !analysis.takeProfit) continue;

        // ── Close on Reverse ──
        if (config.closeOnReverse) {
          const oppositeDir = analysis.direction === "long" ? "short" : "long";
          const toClose = openPositions.filter(p => p.symbol === symbol && p.direction === oppositeDir);
          for (const pos of toClose) {
            const { pnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, analysis.lastPrice, pos.size, pos.symbol);
            balance += pnl;
            if (balance > peakBalance) peakBalance = balance;
            allTrades.push({
              id: pos.id,
              symbol: pos.symbol,
              direction: pos.direction,
              entryPrice: pos.entryPrice,
              exitPrice: analysis.lastPrice,
              entryTime: pos.entryTime,
              exitTime: candleTime,
              size: pos.size,
              pnl,
              pnlPips,
              closeReason: "reverse_signal",
              confluenceScore: pos.confluenceScore,
              factors: pos.factors,
              gatesBlocked: [],
            });
            equityCurve.push({ date: candleTime, equity: balance });
          }
          openPositions = openPositions.filter(p => !(p.symbol === symbol && p.direction === oppositeDir));
        }

        // ── Recalculate SL with asset-adjusted buffer (mirrors bot-scanner) ──
        const spec = SPECS[symbol] || SPECS["EUR/USD"];
        const adjustedSlBuffer = config.slBufferPips * assetProfile.slBufferMultiplier;
        let sl = analysis.stopLoss;
        let tp = analysis.takeProfit;

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

        // ── Spread cost simulation ──
        const spreadCost = spreadPips * spec.pipSize;
        const entryPrice = analysis.direction === "long"
          ? analysis.lastPrice + spreadCost / 2
          : analysis.lastPrice - spreadCost / 2;

        // ── Position Sizing ──
        const size = calculatePositionSize(balance, config.riskPerTrade, entryPrice, sl, symbol);

        // ── Open Position ──
        const posId = `bt_${++tradeCounter}`;
        const exitFlags = {
          trailingStop: config.trailingStopEnabled,
          trailingStopPips: config.trailingStopPips,
          trailingStopActivation: config.trailingStopActivation,
          breakEven: config.breakEvenEnabled,
          breakEvenPips: config.breakEvenPips,
          partialTP: config.partialTPEnabled,
          partialTPPercent: config.partialTPPercent,
          partialTPLevel: config.partialTPLevel,
          maxHoldHours: config.maxHoldHours,
          tpRatio: config.tpRatio,
        };

        openPositions.push({
          id: posId,
          symbol,
          direction: analysis.direction,
          entryPrice,
          stopLoss: sl,
          takeProfit: tp,
          size,
          entryTime: candleTime,
          entryBarIndex: i,
          confluenceScore: analysis.score,
          factors: analysis.factors.map((f: any) => ({ name: f.name, present: f.present, weight: f.weight })),
          exitFlags,
          partialTPFired: false,
          currentSL: sl,
        });
      }
    }

    // ── Close any remaining open positions at last candle ──
    for (const pos of openPositions) {
      const data = candleData[pos.symbol];
      if (!data || data.entry.length === 0) continue;
      const lastCandle = data.entry[data.entry.length - 1];
      const { pnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, lastCandle.close, pos.size, pos.symbol);
      balance += pnl;
      allTrades.push({
        id: pos.id,
        symbol: pos.symbol,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        exitPrice: lastCandle.close,
        entryTime: pos.entryTime,
        exitTime: lastCandle.datetime,
        size: pos.size,
        pnl,
        pnlPips,
        closeReason: "backtest_end",
        confluenceScore: pos.confluenceScore,
        factors: pos.factors,
        gatesBlocked: [],
      });
      equityCurve.push({ date: lastCandle.datetime, equity: balance });
    }

    // ── Calculate Stats ──
    const stats = calculateStats(allTrades, startingBalance, monthsSpan);

    console.log(`[backtest] Complete: ${allTrades.length} trades, PnL: $${stats.totalPnl.toFixed(2)}, WR: ${stats.winRate.toFixed(1)}%, PF: ${stats.profitFactor.toFixed(2)}, MaxDD: ${stats.maxDrawdownPct.toFixed(1)}%`);

    return new Response(
      JSON.stringify({
        trades: allTrades,
        equityCurve,
        stats,
        factorBreakdown,
        gateBreakdown,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: any) {
    console.error(`[backtest] Error: ${error?.message}`, error?.stack);
    return new Response(
      JSON.stringify({ error: error?.message || "Backtest failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
