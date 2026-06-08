/**
 * backtest-engine — Supabase Edge Function (v2 — Full Bot-Scanner Parity + Research Mode)
 * ──────────────────────────────────────────────────────────────────────
 * Faithful backtester that replicates the bot-scanner + paper-trading
 * pipeline on historical data. Uses the SAME shared SMC analysis,
 * direction engine, impulse zone engine, and FOTSI modules.
 *
 * v2 additions:
 *   - All 22 gates (matching bot-scanner exactly)
 *   - Direction engine integration (Daily→4H→1H top-down)
 *   - Impulse zone engine with HTF confluence data + Tier 1/2 credits
 *   - effectiveScore = score + fotsiPenalty + impulseZonePenalty
 *   - Bidirectional conflict counter
 *   - H1/H4 candle fetching per instrument
 *   - HTF POI detection (FVGs, OBs, Breakers on D/4H/1H)
 *   - HTF Fib/PD/Liquidity on D/4H/1H
 *   - Research mode: counterfactual tracking for blocked trades
 *   - Rich analytics: gate effectiveness, factor edge, regime/session breakdown, threshold curves
 *
 * Endpoint: POST /functions/v1/backtest-engine
 * Body: {
 *   instruments: string[],
 *   startDate: string,           // ISO date "2025-01-01"
 *   endDate: string,             // ISO date "2026-04-01"
 *   startingBalance: number,
 *   config: { ... },             // same shape as bot_configs.config_json
 *   tradingStyle?: string,
 *   slippagePips?: number,
 *   spreadPips?: number,
 *   commissionPerLot?: number,
 *   walkForwardFolds?: number,
 *   researchMode?: boolean,      // enable counterfactual tracking + rich analytics
 *   maxTradesStored?: number,     // max trades in DB result (default 500)
 *   maxBlockedStored?: number,    // max blocked trades in research analytics (default 200)
 * }
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import {
  type Candle,
  type SwingPoint,
  type ReasoningFactor,
  SPECS,
  MIN_SL_PIPS,
  ATR_SL_FLOOR_MULTIPLIER,
  SUPPORTED_SYMBOLS,
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
  getQuoteToUSDRate,
  detectSilverBullet,
  detectMacroWindow,
  detectAMDPhase,
  detectOptimalStyle,
  computeOpeningRange,
  classifyInstrumentRegime as sharedClassifyRegime,
  detectZigZagPivots,
  computeFibLevels,
} from "../_shared/smcAnalysis.ts";
import {
  runConfluenceAnalysis,
  DEFAULT_FACTOR_WEIGHTS,
  resolveWeightScale,
  applyWeightScale,
} from "../_shared/confluenceScoring.ts";
import {
  detectSession,
  normalizeSessionFilter,
  isSessionEnabled,
  toNYTime,
  type SessionResult,
} from "../_shared/sessions.ts";
// @ts-ignore — Deno Deploy runtime global
declare const EdgeRuntime: { waitUntil(p: Promise<any>): void } | undefined;
import {
  type FOTSIResult,
  computeFOTSI,
  getCurrencyAlignment,
  checkOverboughtOversoldVeto,
} from "../_shared/fotsi.ts";
import { fetchCandlesWithFallback } from "../_shared/candleSource.ts";
import { type Currency, parsePairCurrencies } from "../_shared/fotsi.ts";
import { determineDirection, type DirectionResult } from "../_shared/directionEngine.ts";
import { findBestEntryZoneMultiTF, type MultiTFZoneResult, type HTFConfluenceData } from "../_shared/impulseZoneEngine.ts";

// ─── CORS ──────────────────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Types ─────────────────────────────────────────────────────────
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
  commission: number;
  closeReason: string;
  confluenceScore: number;
  effectiveScore: number;
  factors: { name: string; present: boolean; weight: number }[];
  gatesBlocked: string[];
  regime?: string;
  session?: string;
}

interface BlockedTrade {
  symbol: string;
  direction: "long" | "short";
  time: string;
  score: number;
  effectiveScore: number;
  blockedBy: string[];
  factors: { name: string; present: boolean; weight: number }[];
  wouldHaveWon: boolean | null;
  mfe: number;
  mae: number;
  hypotheticalPnlPips: number;
  regime?: string;
  session?: string;
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
  totalCommission: number;
  netPnl: number;
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
  effectiveScore: number;
  factors: { name: string; present: boolean; weight: number }[];
  exitFlags: any;
  partialTPFired: boolean;
  currentSL: number;
  structureInvalidationFired: boolean;
  regime?: string;
  session?: string;
}

// ─── Candle Fetching (Backtest-specific: date-range aware) ──────────
const BT_TWELVE_DATA_SYMBOLS: Record<string, string> = {
  "EUR/USD": "EUR/USD", "GBP/USD": "GBP/USD", "USD/JPY": "USD/JPY",
  "AUD/USD": "AUD/USD", "NZD/USD": "NZD/USD", "USD/CAD": "USD/CAD",
  "USD/CHF": "USD/CHF",
  "EUR/GBP": "EUR/GBP", "EUR/JPY": "EUR/JPY", "GBP/JPY": "GBP/JPY",
  "EUR/AUD": "EUR/AUD", "EUR/CAD": "EUR/CAD", "EUR/CHF": "EUR/CHF",
  "EUR/NZD": "EUR/NZD", "GBP/AUD": "GBP/AUD", "GBP/CAD": "GBP/CAD",
  "GBP/CHF": "GBP/CHF", "GBP/NZD": "GBP/NZD", "AUD/CAD": "AUD/CAD",
  "AUD/JPY": "AUD/JPY", "CAD/JPY": "CAD/JPY",
  "AUD/CHF": "AUD/CHF", "AUD/NZD": "AUD/NZD", "CAD/CHF": "CAD/CHF",
  "CHF/JPY": "CHF/JPY", "NZD/CAD": "NZD/CAD", "NZD/CHF": "NZD/CHF",
  "NZD/JPY": "NZD/JPY",
  "US30": "DJI", "NAS100": "IXIC", "SPX500": "SPX",
  "XAU/USD": "XAU/USD", "XAG/USD": "XAG/USD", "US Oil": "WTI/USD",
  "BTC/USD": "BTC/USD", "ETH/USD": "ETH/USD",
};
const BT_TD_INTERVAL: Record<string, string> = {
  "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min",
  "1h": "1h", "4h": "4h", "1d": "1day", "1w": "1week",
};

async function fetchTwelveDataRange(
  symbol: string, interval: string, startDate: string, endDate: string,
): Promise<Candle[]> {
  const apiKey = Deno.env.get("TWELVE_DATA_API_KEY");
  if (!apiKey) return [];
  const tdSymbol = BT_TWELVE_DATA_SYMBOLS[symbol];
  if (!tdSymbol) return [];
  const tdInterval = BT_TD_INTERVAL[interval] || "15min";
  const allCandles: Candle[] = [];
  let currentStart = startDate;
  const maxPerRequest = 5000;
  for (let page = 0; page < 20; page++) {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${tdInterval}&start_date=${encodeURIComponent(currentStart)}&end_date=${encodeURIComponent(endDate)}&outputsize=${maxPerRequest}&apikey=${apiKey}&order=ASC`;
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        console.warn(`[backtest] TwelveData 429, waiting 10s...`);
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      if (!res.ok) break;
      const data = await res.json();
      if (data?.status === "error" || !Array.isArray(data?.values)) {
        if (data?.message) console.warn(`[backtest] TwelveData: ${data.message}`);
        break;
      }
      const chunk = data.values.map((v: any) => ({
        datetime: typeof v.datetime === "string" && v.datetime.length === 10
          ? `${v.datetime}T00:00:00Z`
          : `${v.datetime.replace(" ", "T")}Z`,
        open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close),
        volume: v.volume != null ? Number(v.volume) : undefined,
      })).filter((c: Candle) =>
        Number.isFinite(c.open) && Number.isFinite(c.high) &&
        Number.isFinite(c.low) && Number.isFinite(c.close)
      );
      if (chunk.length === 0) break;
      allCandles.push(...chunk);
      console.log(`[backtest] TwelveData page ${page + 1}: ${chunk.length} candles for ${symbol} ${interval} (total: ${allCandles.length})`);
      if (chunk.length < maxPerRequest) break;
      const lastDt = chunk[chunk.length - 1].datetime;
      currentStart = lastDt;
      await new Promise(r => setTimeout(r, 1000));
    } catch (e: any) {
      console.warn(`[backtest] TwelveData fetch error page ${page}: ${e?.message}`);
      break;
    }
  }
  return allCandles;
}

async function fetchPolygonRange(
  symbol: string, interval: string, startDate: string, endDate: string,
): Promise<Candle[]> {
  const apiKey = Deno.env.get("POLYGON_API_KEY");
  if (!apiKey) return [];
  const pgSym = SUPPORTED_SYMBOLS[symbol];
  if (!pgSym) return [];
  const timespanMap: Record<string, { multiplier: number; timespan: string }> = {
    "1m": { multiplier: 1, timespan: "minute" }, "5m": { multiplier: 5, timespan: "minute" },
    "15m": { multiplier: 15, timespan: "minute" }, "30m": { multiplier: 30, timespan: "minute" },
    "1h": { multiplier: 1, timespan: "hour" }, "4h": { multiplier: 4, timespan: "hour" },
    "1d": { multiplier: 1, timespan: "day" }, "1w": { multiplier: 1, timespan: "week" },
  };
  const ts = timespanMap[interval] || timespanMap["15m"];
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(pgSym)}/range/${ts.multiplier}/${ts.timespan}/${startDate}/${endDate}?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`;
  try {
    const res = await fetch(url);
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 3000));
      const retryRes = await fetch(url);
      if (!retryRes.ok) return [];
      const retryData = await retryRes.json();
      if (!Array.isArray(retryData?.results)) return [];
      return retryData.results.map((bar: any) => ({
        datetime: new Date(bar.t).toISOString(),
        open: Number(bar.o), high: Number(bar.h), low: Number(bar.l), close: Number(bar.c),
        volume: bar.v != null ? Number(bar.v) : undefined,
      })).filter((c: Candle) => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));
    }
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data?.results)) return [];
    return data.results.map((bar: any) => ({
      datetime: new Date(bar.t).toISOString(),
      open: Number(bar.o), high: Number(bar.h), low: Number(bar.l), close: Number(bar.c),
      volume: bar.v != null ? Number(bar.v) : undefined,
    })).filter((c: Candle) => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));
  } catch (e: any) {
    console.warn(`[backtest] Polygon fetch error: ${e?.message}`);
    return [];
  }
}

async function fetchHistoricalCandles(
  symbol: string, interval: string, range: string, startDate?: string, endDate?: string,
): Promise<Candle[]> {
  const computeBufferedStart = (start: string) => {
    const startMs = new Date(start).getTime();
    const lookbackMs = interval === "1d" ? 60 * 24 * 3600 * 1000 :
                       interval === "4h" ? 30 * 24 * 3600 * 1000 :
                       interval === "1h" ? 14 * 24 * 3600 * 1000 :
                       7 * 24 * 3600 * 1000;
    return new Date(startMs - lookbackMs).toISOString().slice(0, 10);
  };
  if (startDate && endDate) {
    const bufferedStart = computeBufferedStart(startDate);
    const tdCandles = await fetchTwelveDataRange(symbol, interval, bufferedStart, endDate);
    if (tdCandles.length >= 30) return tdCandles;
    const pgCandles = await fetchPolygonRange(symbol, interval, bufferedStart, endDate);
    if (pgCandles.length >= 30) return pgCandles;
  } else {
    const rangeMs: Record<string, number> = { "3mo": 90 * 86400000, "6mo": 180 * 86400000, "1y": 365 * 86400000, "2y": 730 * 86400000 };
    const ms = rangeMs[range] || 90 * 86400000;
    const endD = new Date().toISOString().slice(0, 10);
    const startD = new Date(Date.now() - ms).toISOString().slice(0, 10);
    const bufferedStart = computeBufferedStart(startD);
    const pgCandles = await fetchPolygonRange(symbol, interval, bufferedStart, endD);
    if (pgCandles.length >= 30) return pgCandles;
  }
  try {
    const result = await fetchCandlesWithFallback({ symbol, interval, limit: 5000 });
    return result.candles;
  } catch { return []; }
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
    minConfluence: (() => {
      const raw_mc = strategy.confluenceThreshold ?? strategy.minConfluenceScore ?? raw?.minConfluence ?? DEFAULTS.minConfluence;
      if (raw_mc > 0 && raw_mc <= 10 && (strategy.normalizedScoring ?? raw?.normalizedScoring ?? true)) return raw_mc * 10;
      return raw_mc;
    })(),
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
    onlyBuyInDiscount: strategy.onlyBuyInDiscount ?? DEFAULTS.onlyBuyInDiscount,
    onlySellInPremium: strategy.onlySellInPremium ?? DEFAULTS.onlySellInPremium,
    riskPerTrade: risk.riskPerTrade ?? DEFAULTS.riskPerTrade,
    positionSizingMethod: risk.positionSizingMethod ?? raw?.positionSizingMethod ?? "percent_risk",
    fixedLotSize: risk.fixedLotSize ?? raw?.fixedLotSize ?? 0.1,
    atrVolatilityMultiplier: risk.atrVolatilityMultiplier ?? 1.5,
    maxDailyLoss: risk.maxDailyDrawdown ?? DEFAULTS.maxDailyLoss,
    maxOpenPositions: risk.maxConcurrentTrades ?? DEFAULTS.maxOpenPositions,
    minRiskReward: risk.minRR ?? DEFAULTS.minRiskReward,
    maxPerSymbol: risk.maxPositionsPerSymbol ?? DEFAULTS.maxPerSymbol,
    portfolioHeat: risk.maxPortfolioHeat ?? DEFAULTS.portfolioHeat,
    cooldownMinutes: entry.cooldownMinutes ?? 0,
    closeOnReverse: entry.closeOnReverse ?? false,
    slBufferPips: entry.slBufferPips ?? DEFAULTS.slBufferPips,
    instrumentBuffers: (raw?.instrumentBuffers || entry.instrumentBuffers || {}) as Record<string, { slBufferPips?: number }>,
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
    enabledSessions: (
      Array.isArray(sessions.filter) ? normalizeSessionFilter(sessions.filter)
        : Array.isArray(raw?.enabledSessions) ? normalizeSessionFilter(raw.enabledSessions)
        : [...DEFAULTS.enabledSessions]
    ),
    killZoneOnly: sessions.killZoneOnly ?? false,
    enabledDays: DEFAULTS.enabledDays,
    maxDrawdown: Math.min(risk.maxDrawdown ?? DEFAULTS.maxDrawdown, protection.circuitBreakerPct ?? 100),
    maxConsecutiveLosses: protection.maxConsecutiveLosses ?? 0,
    protectionMaxDailyLossDollar: protection.maxDailyLoss ?? 0,
    openingRange: { ...DEFAULTS.openingRange, ...(raw?.openingRange || {}) },
    tradingStyle: { ...DEFAULTS.tradingStyle, ...(raw?.tradingStyle || {}) },
    factorWeights: raw?.factorWeights || {},
    spreadFilterEnabled: instruments.spreadFilterEnabled ?? DEFAULTS.spreadFilterEnabled,
    maxSpreadPips: instruments.maxSpreadPips ?? DEFAULTS.maxSpreadPips,
    newsFilterEnabled: false, // Disabled in backtest
    // Factor toggles
    useVolumeProfile: strategy.useVolumeProfile ?? raw?.useVolumeProfile ?? DEFAULTS.useVolumeProfile,
    useTrendDirection: strategy.useTrendDirection ?? raw?.useTrendDirection ?? DEFAULTS.useTrendDirection,
    useDailyBias: strategy.useDailyBias ?? raw?.useDailyBias ?? DEFAULTS.useDailyBias,
    useAMD: strategy.useAMD ?? raw?.useAMD ?? DEFAULTS.useAMD,
    useFOTSI: strategy.useFOTSI ?? raw?.useFOTSI ?? DEFAULTS.useFOTSI,
    // Direction engine
    useSimpleDirection: strategy.useSimpleDirection ?? raw?.useSimpleDirection ?? true,
    simpleDirectionH4ChochLookback: strategy.simpleDirectionH4ChochLookback ?? raw?.simpleDirectionH4ChochLookback ?? 10,
    simpleDirectionH1BosLookback: strategy.simpleDirectionH1BosLookback ?? raw?.simpleDirectionH1BosLookback ?? 8,
    // Regime scoring
    regimeScoringEnabled: strategy.regimeScoringEnabled ?? raw?.regimeScoringEnabled ?? DEFAULTS.regimeScoringEnabled,
    regimeScoringStrength: strategy.regimeScoringStrength ?? raw?.regimeScoringStrength ?? DEFAULTS.regimeScoringStrength,
    // Advanced tuning
    obLookbackCandles: strategy.obLookbackCandles ?? raw?.obLookbackCandles ?? DEFAULTS.obLookbackCandles,
    fvgMinSizePips: strategy.fvgMinSizePips ?? raw?.fvgMinSizePips ?? DEFAULTS.fvgMinSizePips,
    fvgOnlyUnfilled: strategy.fvgOnlyUnfilled ?? raw?.fvgOnlyUnfilled ?? DEFAULTS.fvgOnlyUnfilled,
    structureLookback: strategy.structureLookback ?? raw?.structureLookback ?? DEFAULTS.structureLookback,
    liquidityPoolMinTouches: strategy.liquidityPoolMinTouches ?? raw?.liquidityPoolMinTouches ?? DEFAULTS.liquidityPoolMinTouches,
    equalHighsLowsSensitivity: strategy.equalHighsLowsSensitivity ?? raw?.equalHighsLowsSensitivity ?? 3,
    // Bidirectional conflict
    conflictThresholdRaise: strategy.conflictThresholdRaise ?? raw?.conflictThresholdRaise ?? 4,
    conflictBlockAt: strategy.conflictBlockAt ?? raw?.conflictBlockAt ?? 6,
    // ATR filter
    atrFilterEnabled: strategy.atrFilterEnabled ?? raw?.atrFilterEnabled ?? false,
    atrFilterMin: strategy.atrFilterMin ?? raw?.atrFilterMin ?? 0,
    atrFilterMax: strategy.atrFilterMax ?? raw?.atrFilterMax ?? 0,
    // Impulse zone
    impulseZoneEnabled: strategy.impulseZoneEnabled ?? raw?.impulseZoneEnabled ?? true,
    impulseZoneGateMode: strategy.impulseZoneGateMode ?? raw?.impulseZoneGateMode ?? "hard",
    impulseZoneBonus: strategy.impulseZoneBonus ?? raw?.impulseZoneBonus ?? 1.0,
    impulseZonePenalty: strategy.impulseZonePenalty ?? raw?.impulseZonePenalty ?? 2.0,
    // Correlation filter
    correlationFilterEnabled: strategy.correlationFilterEnabled ?? raw?.correlationFilterEnabled ?? true,
    maxCorrelatedPositions: strategy.maxCorrelatedPositions ?? raw?.maxCorrelatedPositions ?? 2,
    // SMT opposite veto
    smtOppositeVeto: strategy.smtOppositeVeto ?? raw?.smtOppositeVeto ?? true,
    // Internal state
    _currentSymbol: "",
    _smtResult: null as any,
  };
}


// ─── Correlation Groups (for Gate 20) ───────────────────────────────
const CORRELATION_GROUPS: Record<string, string[]> = {
  "USD_MAJORS": ["EUR/USD", "GBP/USD", "AUD/USD", "NZD/USD"],
  "JPY_CROSSES": ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "CAD/JPY", "CHF/JPY", "NZD/JPY"],
  "EUR_CROSSES": ["EUR/USD", "EUR/GBP", "EUR/JPY", "EUR/AUD", "EUR/CAD", "EUR/CHF", "EUR/NZD"],
  "GBP_CROSSES": ["GBP/USD", "GBP/JPY", "GBP/AUD", "GBP/CAD", "GBP/CHF", "GBP/NZD", "EUR/GBP"],
  "AUD_NZD": ["AUD/USD", "NZD/USD", "AUD/NZD", "AUD/CAD", "AUD/JPY", "AUD/CHF"],
  "CAD_CROSSES": ["USD/CAD", "EUR/CAD", "GBP/CAD", "AUD/CAD", "NZD/CAD", "CAD/JPY", "CAD/CHF"],
  "INDICES": ["US30", "NAS100", "SPX500"],
  "METALS": ["XAU/USD", "XAG/USD"],
  "CRYPTO": ["BTC/USD", "ETH/USD"],
};

function getCorrelationGroup(symbol: string): string | null {
  for (const [group, members] of Object.entries(CORRELATION_GROUPS)) {
    if (members.includes(symbol)) return group;
  }
  return null;
}

// ─── Safety Gates (all 22 gates — mirrors bot-scanner runSafetyGates exactly) ──
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
  peakBalance: number,
  spreadPips: number,
  fotsiResult: FOTSIResult | null,
  smtResult: any,
): { passed: boolean; reason: string }[] {
  const gates: { passed: boolean; reason: string }[] = [];
  const spec = SPECS[symbol] || SPECS["EUR/USD"];

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

  // Gate 3: Duplicate direction (no same-direction trade on same symbol)
  const hasSameDir = openPositions.some(p => p.symbol === symbol && p.direction === direction);
  gates.push({
    passed: !hasSameDir,
    reason: hasSameDir ? `Already ${direction} on ${symbol}` : "No duplicate direction",
  });

  // Gate 3b: Bidirectional lock (no opposite-direction trade on same symbol unless closeOnReverse)
  if (!config.closeOnReverse) {
    const hasOpposite = openPositions.some(p => p.symbol === symbol && p.direction !== direction);
    gates.push({
      passed: !hasOpposite,
      reason: hasOpposite ? `Already ${direction === "long" ? "short" : "long"} on ${symbol} (bidirectional lock)` : "No bidirectional conflict",
    });
  }

  // Gate 4: Min RR check (spread-adjusted)
  let rrOk = true;
  if (analysis.stopLoss && analysis.takeProfit) {
    const risk = Math.abs(analysis.lastPrice - analysis.stopLoss);
    const rawReward = Math.abs(analysis.takeProfit - analysis.lastPrice);
    const effectiveSpread = spreadPips > 0 ? spreadPips : (spec.typicalSpread ?? 1);
    const spreadCostInPrice = effectiveSpread * spec.pipSize;
    const effectiveReward = Math.max(0, rawReward - spreadCostInPrice);
    const rawRR = risk > 0 ? rawReward / risk : 0;
    const effectiveRR = risk > 0 ? effectiveReward / risk : 0;
    rrOk = effectiveRR >= config.minRiskReward;
    gates.push({ passed: rrOk, reason: `RR: ${effectiveRR.toFixed(2)} effective (${rawRR.toFixed(2)} raw, spread ${effectiveSpread.toFixed(1)}p) min: ${config.minRiskReward}` });
  } else {
    gates.push({ passed: false, reason: "No SL/TP calculated" });
  }

  // Gate 5: Max drawdown (circuit breaker)
  if (peakBalance > 0 && config.maxDrawdown > 0) {
    const currentDrawdownPct = ((peakBalance - balance) / peakBalance) * 100;
    gates.push({
      passed: currentDrawdownPct < config.maxDrawdown,
      reason: `Drawdown: ${currentDrawdownPct.toFixed(1)}% (max: ${config.maxDrawdown}%)`,
    });
  } else {
    gates.push({ passed: true, reason: "Drawdown within limits" });
  }

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
    const pSpec = SPECS[p.symbol] || SPECS["EUR/USD"];
    const risk = Math.abs(p.entryPrice - p.currentSL) * (pSpec.lotUnits || 100000) * p.size;
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

  // Gate 9b: ATR Volatility Filter
  if (config.atrFilterEnabled && dailyCandles && dailyCandles.length >= 14) {
    const atr14 = calculateATR(dailyCandles, 14);
    const atrPips = atr14 / spec.pipSize;
    const minOk = config.atrFilterMin <= 0 || atrPips >= config.atrFilterMin;
    const maxOk = config.atrFilterMax <= 0 || atrPips <= config.atrFilterMax;
    gates.push({
      passed: minOk && maxOk,
      reason: `ATR filter: ${atrPips.toFixed(1)} pips (min: ${config.atrFilterMin || "off"}, max: ${config.atrFilterMax || "off"})`,
    });
  }

  // Gate 10: Kill zone only
  if (config.killZoneOnly) {
    gates.push({
      passed: analysis.session?.isKillZone ?? false,
      reason: analysis.session?.isKillZone ? "In kill zone" : "Not in kill zone (blocked)",
    });
  }

  // Gate 11: Session filter
  if (config.enabledSessions && config.enabledSessions.length > 0) {
    const sessionName = analysis.session?.name || "";
    const sessionEnabled = isSessionEnabled(sessionName, config.enabledSessions);
    gates.push({
      passed: sessionEnabled,
      reason: sessionEnabled ? `Session OK: ${sessionName}` : `Session blocked: ${sessionName} not in [${config.enabledSessions.join(",")}]`,
    });
  }

  // Gate 14: Spread filter
  if (config.spreadFilterEnabled && spreadPips > 0 && config.maxSpreadPips > 0) {
    gates.push({
      passed: spreadPips <= config.maxSpreadPips,
      reason: `Spread: ${spreadPips.toFixed(1)} pips (max: ${config.maxSpreadPips})`,
    });
  }

  // Gate 15: Regime gate (from confluenceScoring)
  if (config.regimeScoringEnabled && analysis.tieredScoring) {
    const regimeGatePassed = analysis.tieredScoring.regimeGatePassed ?? true;
    gates.push({
      passed: regimeGatePassed,
      reason: analysis.tieredScoring.regimeGateReason || (regimeGatePassed ? "Regime gate passed" : "Regime gate failed"),
    });
  }

  // Gate 16: Tier 1 gate (from confluenceScoring)
  if (analysis.tieredScoring) {
    const tier1Passed = analysis.tieredScoring.tier1GatePassed ?? true;
    gates.push({
      passed: tier1Passed,
      reason: analysis.tieredScoring.tier1GateReason || (tier1Passed ? "Tier 1 gate passed" : "Tier 1 gate failed"),
    });
  }

  // Gate 17: HTF Bias Alignment
  if (config.htfBiasRequired && dailyCandles && dailyCandles.length >= 10) {
    const htfStructure = analyzeMarketStructure(dailyCandles);
    const htfTrend = htfStructure.trend;
    const entryBias = direction === "long" ? "bullish" : "bearish";
    if (config.htfBiasHardVeto) {
      gates.push({
        passed: htfTrend === entryBias,
        reason: htfTrend === entryBias
          ? `HTF bias aligned (hard veto): Daily ${htfTrend}`
          : `HTF HARD VETO: Daily is ${htfTrend}, ${entryBias} entry blocked`,
      });
    } else {
      const blocked = htfTrend !== "ranging" && htfTrend !== entryBias;
      gates.push({
        passed: !blocked,
        reason: blocked
          ? `HTF bias mismatch: Daily is ${htfTrend}, entry is ${entryBias}`
          : `HTF bias aligned: Daily ${htfTrend}`,
      });
    }
  } else {
    gates.push({ passed: true, reason: "HTF check skipped" });
  }

  // Gate 18: Premium/Discount zone filter
  {
    const pdZone = analysis.pd?.currentZone || "equilibrium";
    const pdPct = analysis.pd?.zonePercent ?? 50;
    const curPrice = analysis.lastPrice;
    const fmtP = (p: number) => p > 10 ? p.toFixed(3) : p.toFixed(5);
    if (config.onlyBuyInDiscount && direction === "long" && pdZone === "premium") {
      gates.push({ passed: false, reason: `Buying in premium zone rejected — price ${fmtP(curPrice)} at ${pdPct.toFixed(1)}% of range (premium > 55%, need discount < 45% to buy)` });
    } else if (config.onlySellInPremium && direction === "short" && pdZone === "discount") {
      gates.push({ passed: false, reason: `Selling in discount zone rejected — price ${fmtP(curPrice)} at ${pdPct.toFixed(1)}% of range (discount < 45%, need premium > 55% to sell)` });
    } else {
      gates.push({ passed: true, reason: `P/D zone OK (${pdZone}, ${pdPct.toFixed(1)}%)` });
    }
  }

  // Gate 19: FOTSI Overbought/Oversold Veto
  if (fotsiResult && config.useFOTSI) {
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

  // Gate 20: Correlation filter
  if (config.correlationFilterEnabled && config.maxCorrelatedPositions > 0) {
    const group = getCorrelationGroup(symbol);
    if (group) {
      const groupMembers = CORRELATION_GROUPS[group] || [];
      const correlatedOpen = openPositions.filter(p => groupMembers.includes(p.symbol) && p.direction === direction).length;
      gates.push({
        passed: correlatedOpen < config.maxCorrelatedPositions,
        reason: `Correlation (${group}): ${correlatedOpen}/${config.maxCorrelatedPositions} same-dir open`,
      });
    } else {
      gates.push({ passed: true, reason: "Correlation: no group" });
    }
  }

  // Gate 21: Daily dollar loss limit
  if (config.protectionMaxDailyLossDollar > 0) {
    const todayLoss = Math.abs(Math.min(0, dailyPnl));
    gates.push({
      passed: todayLoss < config.protectionMaxDailyLossDollar,
      reason: `Daily $ loss: $${todayLoss.toFixed(2)} (max: $${config.protectionMaxDailyLossDollar})`,
    });
  }

  // Gate 22: SMT Opposite Veto
  if (config.smtOppositeVeto && smtResult) {
    const smtDir = smtResult.direction;
    if (smtDir && smtDir !== direction) {
      gates.push({
        passed: false,
        reason: `SMT opposes: divergence is ${smtDir} but entry is ${direction}`,
      });
    } else {
      gates.push({ passed: true, reason: "SMT aligned or neutral" });
    }
  }

  return gates;
}


// ─── Exit Engine (improved: BE/trail before SL check, same-candle SL/TP disambiguation) ───
function processExits(
  positions: OpenPosition[],
  candle: Candle,
  barIndex: number,
  config: any,
  slippagePips: number,
  btRateMap: Record<string, number>,
  commissionPerLot: number,
  allCandles?: Candle[],
): { closedTrades: BacktestTrade[]; updatedPositions: OpenPosition[] } {
  const closedTrades: BacktestTrade[] = [];
  const surviving: OpenPosition[] = [];

  for (const pos of positions) {
    let closeReason: string | null = null;
    let exitPrice = candle.close;
    let sl = pos.currentSL;
    const tp = pos.takeProfit;
    const spec = SPECS[pos.symbol] || SPECS["EUR/USD"];

    // ── Step 1: Move SL up via Break Even (before checking SL hit) ──
    if (pos.exitFlags.breakEven && pos.exitFlags.breakEvenPips > 0) {
      const bestPips = pos.direction === "long"
        ? (candle.high - pos.entryPrice) / spec.pipSize
        : (pos.entryPrice - candle.low) / spec.pipSize;
      if (bestPips >= pos.exitFlags.breakEvenPips) {
        const newSL = pos.direction === "long"
          ? pos.entryPrice + 1 * spec.pipSize
          : pos.entryPrice - 1 * spec.pipSize;
        if ((pos.direction === "long" && newSL > sl) || (pos.direction === "short" && newSL < sl)) {
          sl = newSL;
        }
      }
    }

    // ── Step 2: Move SL up via Trailing Stop (before checking SL hit) ──
    if (pos.exitFlags.trailingStop && pos.exitFlags.trailingStopPips > 0) {
      const bestPips = pos.direction === "long"
        ? (candle.high - pos.entryPrice) / spec.pipSize
        : (pos.entryPrice - candle.low) / spec.pipSize;
      const activationPips = pos.exitFlags.trailingStopActivation === "after_1r" && pos.exitFlags.tpRatio
        ? Math.abs(pos.entryPrice - pos.stopLoss) / spec.pipSize
        : pos.exitFlags.trailingStopPips * 2;
      if (bestPips >= activationPips) {
        const trailDist = pos.exitFlags.trailingStopPips * spec.pipSize;
        const bestPrice = pos.direction === "long" ? candle.high : candle.low;
        const newSL = pos.direction === "long"
          ? bestPrice - trailDist
          : bestPrice + trailDist;
        if ((pos.direction === "long" && newSL > sl) || (pos.direction === "short" && newSL < sl)) {
          sl = newSL;
        }
      }
    }

    // ── Step 2b: Structure Invalidation (mirrors live scannerManagement) ──
    if (config.structureInvalidationEnabled !== false && !pos.structureInvalidationFired && allCandles && barIndex >= 20) {
      const riskDist = Math.abs(pos.entryPrice - pos.stopLoss);
      const priceDiff = pos.direction === "long"
        ? candle.close - pos.entryPrice
        : pos.entryPrice - candle.close;
      const rMultiple = riskDist > 0 ? priceDiff / riskDist : 0;

      if (rMultiple < 0 && rMultiple > -0.8) {
        const lookbackStart = Math.max(0, barIndex - 50);
        const recentCandles = allCandles.slice(lookbackStart, barIndex + 1);
        if (recentCandles.length >= 20) {
          const currentStructure = analyzeMarketStructure(recentCandles);
          const structureAgainst =
            (pos.direction === "long" && currentStructure.trend === "bearish") ||
            (pos.direction === "short" && currentStructure.trend === "bullish");
          const chochAgainst = currentStructure.choch.filter((c: any) =>
            (pos.direction === "long" && c.type === "bearish") ||
            (pos.direction === "short" && c.type === "bullish")
          );
          if (structureAgainst && chochAgainst.length > 0) {
            const currentSLDistance = Math.abs(candle.close - sl);
            const tightenedDistance = currentSLDistance * 0.5;
            const newSL = pos.direction === "long"
              ? candle.close - tightenedDistance
              : candle.close + tightenedDistance;
            const shouldTighten = pos.direction === "long" ? newSL > sl : newSL < sl;
            if (shouldTighten) {
              sl = newSL;
              pos.structureInvalidationFired = true;
            }
          }
        }
      }
    }

    // ── Step 3: Check SL and TP hits (with same-candle disambiguation) ──
    const slHit = pos.direction === "long" ? candle.low <= sl : candle.high >= sl;
    const tpHit = pos.direction === "long" ? candle.high >= tp : candle.low <= tp;

    if (slHit && tpHit) {
      const slDist = Math.abs(candle.open - sl);
      const tpDist = Math.abs(candle.open - tp);
      if (slDist <= tpDist) {
        closeReason = "sl_hit";
        const gapPrice = pos.direction === "long" ? Math.min(sl, candle.low) : Math.max(sl, candle.high);
        exitPrice = pos.direction === "long"
          ? gapPrice - slippagePips * spec.pipSize
          : gapPrice + slippagePips * spec.pipSize;
      } else {
        closeReason = "tp_hit";
        exitPrice = tp;
      }
    } else if (slHit) {
      closeReason = "sl_hit";
      const gapPrice = pos.direction === "long" ? Math.min(sl, candle.low) : Math.max(sl, candle.high);
      exitPrice = pos.direction === "long"
        ? gapPrice - slippagePips * spec.pipSize
        : gapPrice + slippagePips * spec.pipSize;
    } else if (tpHit) {
      closeReason = "tp_hit";
      exitPrice = tp;
    }

    // ── Step 4: Max Hold Hours ──
    if (!closeReason && pos.exitFlags.maxHoldHours > 0) {
      const entryMs = new Date(pos.entryTime).getTime();
      const candleMs = new Date(candle.datetime.endsWith("Z") ? candle.datetime : candle.datetime + "Z").getTime();
      const elapsedHours = (candleMs - entryMs) / 3600000;
      if (elapsedHours >= pos.exitFlags.maxHoldHours) {
        closeReason = "time_exit";
      }
    }

    // ── Step 5: Partial TP (exit at trigger price, not candle close) ──
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
        const { pnl: rawPnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, triggerPrice, closeSize, pos.symbol, btRateMap);
        const partialComm = closeSize * commissionPerLot * 2;
        const pnl = rawPnl - partialComm;
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
          commission: partialComm,
          closeReason: "partial_tp",
          confluenceScore: pos.confluenceScore,
          effectiveScore: pos.effectiveScore,
          factors: pos.factors,
          gatesBlocked: [],
          regime: pos.regime,
          session: pos.session,
        });
        pos.size = remainSize;
        pos.partialTPFired = true;
      }
    }

    if (closeReason) {
      const { pnl: rawPnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, exitPrice, pos.size, pos.symbol, btRateMap);
      const comm = pos.size * commissionPerLot * 2;
      const pnl = rawPnl - comm;
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
        commission: comm,
        closeReason,
        confluenceScore: pos.confluenceScore,
        effectiveScore: pos.effectiveScore,
        factors: pos.factors,
        gatesBlocked: [],
        regime: pos.regime,
        session: pos.session,
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

  // Avg hold hours
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
  const totalCommission = trades.reduce((s, t) => s + (t.commission || 0), 0);

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
    totalCommission,
    netPnl: totalPnl,
  };
}

// ─── Research Mode Analytics ────────────────────────────────────────
interface ResearchAnalytics {
  gateEffectiveness: Record<string, { blocked: number; wouldHaveWon: number; wouldHaveLost: number; edgePreserved: number }>;
  factorEdge: Record<string, { present: number; absent: number; winRateWhenPresent: number; winRateWhenAbsent: number; edge: number }>;
  regimeBreakdown: Record<string, { trades: number; winRate: number; avgPnl: number; profitFactor: number }>;
  sessionBreakdown: Record<string, { trades: number; winRate: number; avgPnl: number }>;
  thresholdCurve: { threshold: number; trades: number; winRate: number; profitFactor: number; expectancy: number }[];
  blockedTrades: BlockedTrade[];
  counterfactualStats: BacktestStats | null;
}

function computeResearchAnalytics(
  trades: BacktestTrade[],
  blockedTrades: BlockedTrade[],
  startingBalance: number,
  months: number,
): ResearchAnalytics {
  // Gate effectiveness
  const gateEffectiveness: Record<string, { blocked: number; wouldHaveWon: number; wouldHaveLost: number; edgePreserved: number }> = {};
  for (const bt of blockedTrades) {
    for (const gate of bt.blockedBy) {
      if (!gateEffectiveness[gate]) gateEffectiveness[gate] = { blocked: 0, wouldHaveWon: 0, wouldHaveLost: 0, edgePreserved: 0 };
      gateEffectiveness[gate].blocked++;
      if (bt.wouldHaveWon === true) gateEffectiveness[gate].wouldHaveWon++;
      else if (bt.wouldHaveWon === false) gateEffectiveness[gate].wouldHaveLost++;
    }
  }
  // edgePreserved = (wouldHaveLost - wouldHaveWon) / blocked
  for (const g of Object.values(gateEffectiveness)) {
    g.edgePreserved = g.blocked > 0 ? (g.wouldHaveLost - g.wouldHaveWon) / g.blocked : 0;
  }

  // Factor edge analysis
  const factorEdge: Record<string, { present: number; absent: number; winRateWhenPresent: number; winRateWhenAbsent: number; edge: number }> = {};
  const fullTrades = trades.filter(t => !t.id.includes("_partial"));
  for (const t of fullTrades) {
    for (const f of t.factors) {
      if (!factorEdge[f.name]) factorEdge[f.name] = { present: 0, absent: 0, winRateWhenPresent: 0, winRateWhenAbsent: 0, edge: 0 };
      if (f.present) {
        factorEdge[f.name].present++;
        if (t.pnl > 0) factorEdge[f.name].winRateWhenPresent++;
      } else {
        factorEdge[f.name].absent++;
        if (t.pnl > 0) factorEdge[f.name].winRateWhenAbsent++;
      }
    }
  }
  for (const fe of Object.values(factorEdge)) {
    const wrPresent = fe.present > 0 ? (fe.winRateWhenPresent / fe.present) * 100 : 0;
    const wrAbsent = fe.absent > 0 ? (fe.winRateWhenAbsent / fe.absent) * 100 : 0;
    fe.winRateWhenPresent = wrPresent;
    fe.winRateWhenAbsent = wrAbsent;
    fe.edge = wrPresent - wrAbsent;
  }

  // Regime breakdown
  const regimeBreakdown: Record<string, { trades: number; winRate: number; avgPnl: number; profitFactor: number }> = {};
  for (const t of fullTrades) {
    const regime = t.regime || "unknown";
    if (!regimeBreakdown[regime]) regimeBreakdown[regime] = { trades: 0, winRate: 0, avgPnl: 0, profitFactor: 0 };
    regimeBreakdown[regime].trades++;
  }
  for (const [regime, data] of Object.entries(regimeBreakdown)) {
    const regTrades = fullTrades.filter(t => (t.regime || "unknown") === regime);
    const regWins = regTrades.filter(t => t.pnl > 0);
    data.winRate = regTrades.length > 0 ? (regWins.length / regTrades.length) * 100 : 0;
    data.avgPnl = regTrades.length > 0 ? regTrades.reduce((s, t) => s + t.pnl, 0) / regTrades.length : 0;
    const gp = regWins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(regTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    data.profitFactor = gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
  }

  // Session breakdown
  const sessionBreakdown: Record<string, { trades: number; winRate: number; avgPnl: number }> = {};
  for (const t of fullTrades) {
    const session = t.session || "unknown";
    if (!sessionBreakdown[session]) sessionBreakdown[session] = { trades: 0, winRate: 0, avgPnl: 0 };
    sessionBreakdown[session].trades++;
  }
  for (const [session, data] of Object.entries(sessionBreakdown)) {
    const sesTrades = fullTrades.filter(t => (t.session || "unknown") === session);
    const sesWins = sesTrades.filter(t => t.pnl > 0);
    data.winRate = sesTrades.length > 0 ? (sesWins.length / sesTrades.length) * 100 : 0;
    data.avgPnl = sesTrades.length > 0 ? sesTrades.reduce((s, t) => s + t.pnl, 0) / sesTrades.length : 0;
  }

  // Threshold curve (what-if analysis at different confluence thresholds)
  const thresholdCurve: { threshold: number; trades: number; winRate: number; profitFactor: number; expectancy: number }[] = [];
  for (let thresh = 20; thresh <= 90; thresh += 5) {
    // Combine actual trades + blocked trades that would have passed at this threshold
    const qualifiedActual = fullTrades.filter(t => t.effectiveScore >= thresh);
    const qualifiedBlocked = blockedTrades.filter(bt => bt.effectiveScore >= thresh && bt.wouldHaveWon !== null);
    const totalAtThresh = qualifiedActual.length + qualifiedBlocked.length;
    const winsAtThresh = qualifiedActual.filter(t => t.pnl > 0).length + qualifiedBlocked.filter(bt => bt.wouldHaveWon).length;
    const wr = totalAtThresh > 0 ? (winsAtThresh / totalAtThresh) * 100 : 0;
    // Approximate PF from actual trades only
    const gp = qualifiedActual.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(qualifiedActual.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
    const exp = qualifiedActual.length > 0 ? qualifiedActual.reduce((s, t) => s + t.pnl, 0) / qualifiedActual.length : 0;
    thresholdCurve.push({ threshold: thresh, trades: totalAtThresh, winRate: wr, profitFactor: pf, expectancy: exp });
  }

  // Counterfactual stats (what if ALL blocked trades had been taken)
  let counterfactualStats: BacktestStats | null = null;
  const counterfactualTrades: BacktestTrade[] = [...trades];
  for (const bt of blockedTrades) {
    if (bt.wouldHaveWon !== null) {
      counterfactualTrades.push({
        id: `cf_${bt.time}_${bt.symbol}`,
        symbol: bt.symbol,
        direction: bt.direction,
        entryPrice: 0,
        exitPrice: 0,
        entryTime: bt.time,
        exitTime: bt.time,
        size: 0,
        pnl: bt.hypotheticalPnlPips > 0 ? bt.hypotheticalPnlPips : -bt.hypotheticalPnlPips,
        pnlPips: bt.hypotheticalPnlPips,
        commission: 0,
        closeReason: "counterfactual",
        confluenceScore: bt.score,
        effectiveScore: bt.effectiveScore,
        factors: bt.factors,
        gatesBlocked: bt.blockedBy,
        regime: bt.regime,
        session: bt.session,
      });
    }
  }
  if (counterfactualTrades.length > trades.length) {
    counterfactualStats = calculateStats(counterfactualTrades, startingBalance, months);
  }

  return {
    gateEffectiveness,
    factorEdge,
    regimeBreakdown,
    sessionBreakdown,
    thresholdCurve,
    blockedTrades,
    counterfactualStats,
  };
}

// ─── Counterfactual MFE/MAE Tracker ─────────────────────────────────
function computeCounterfactual(
  symbol: string,
  direction: "long" | "short",
  entryPrice: number,
  stopLoss: number,
  takeProfit: number,
  candles: Candle[],
  startIdx: number,
  maxBars: number,
): { wouldHaveWon: boolean | null; mfe: number; mae: number; hypotheticalPnlPips: number } {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  let mfe = 0; // Maximum Favorable Excursion (pips)
  let mae = 0; // Maximum Adverse Excursion (pips)
  const endIdx = Math.min(startIdx + maxBars, candles.length);

  for (let i = startIdx; i < endIdx; i++) {
    const c = candles[i];
    const favorablePrice = direction === "long" ? c.high : c.low;
    const adversePrice = direction === "long" ? c.low : c.high;
    const favPips = direction === "long"
      ? (favorablePrice - entryPrice) / spec.pipSize
      : (entryPrice - favorablePrice) / spec.pipSize;
    const advPips = direction === "long"
      ? (entryPrice - adversePrice) / spec.pipSize
      : (adversePrice - entryPrice) / spec.pipSize;
    if (favPips > mfe) mfe = favPips;
    if (advPips > mae) mae = advPips;

    // Check if SL or TP would have been hit
    const slHit = direction === "long" ? c.low <= stopLoss : c.high >= stopLoss;
    const tpHit = direction === "long" ? c.high >= takeProfit : c.low <= takeProfit;
    if (tpHit && !slHit) {
      const tpPips = Math.abs(takeProfit - entryPrice) / spec.pipSize;
      return { wouldHaveWon: true, mfe, mae, hypotheticalPnlPips: tpPips };
    }
    if (slHit && !tpHit) {
      const slPips = Math.abs(entryPrice - stopLoss) / spec.pipSize;
      return { wouldHaveWon: false, mfe, mae, hypotheticalPnlPips: -slPips };
    }
    if (slHit && tpHit) {
      // Same-candle disambiguation
      const slDist = Math.abs(c.open - stopLoss);
      const tpDist = Math.abs(c.open - takeProfit);
      if (slDist <= tpDist) {
        const slPips = Math.abs(entryPrice - stopLoss) / spec.pipSize;
        return { wouldHaveWon: false, mfe, mae, hypotheticalPnlPips: -slPips };
      } else {
        const tpPips = Math.abs(takeProfit - entryPrice) / spec.pipSize;
        return { wouldHaveWon: true, mfe, mae, hypotheticalPnlPips: tpPips };
      }
    }
  }
  // Neither hit within maxBars
  return { wouldHaveWon: null, mfe, mae, hypotheticalPnlPips: 0 };
}


// ─── Supabase Admin Client ─────────────────────────────────────────
function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

function respond(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Background Job Runner ──────────────────────────────────────────
const CHUNK_SIZE = 4; // instruments per chunk to stay under edge function CPU limit

async function selfInvokeNextChunk(runId: string, body: any, chunkIndex: number) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/backtest-engine`;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  try {
    // Fire-and-forget; the receiving invocation will continue work.
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
        "apikey": key,
      },
      body: JSON.stringify({ ...body, action: "chunk", runId, chunkIndex }),
    }).catch(e => console.error(`[backtest:${runId}] self-invoke fetch error:`, e));
  } catch (e) {
    console.error(`[backtest:${runId}] self-invoke failed:`, e);
  }
}

async function runBacktestJob(runId: string, body: any, chunkIndex: number = 0) {
  const db = getAdminClient();
  const updateProgress = async (progress: number, message: string) => {
    await db.from("backtest_runs").update({
      progress,
      progress_message: message,
      status: "running",
    }).eq("id", runId).then(() => {});
  };

  try {
    if (chunkIndex === 0) {
      await db.from("backtest_runs").update({
        status: "running",
        started_at: new Date().toISOString(),
        progress: 5,
        progress_message: "Parsing configuration...",
      }).eq("id", runId);
    }

    const {
      instruments = DEFAULTS.instruments,
      startDate,
      endDate,
      startingBalance = 10000,
      config: rawConfig,
      tradingStyle,
      slippagePips = 0.5,
      spreadPips = 0,
      commissionPerLot = 0,
      walkForwardFolds = 0,
      researchMode = false,
      maxTradesStored = 500,
      maxBlockedStored = 200,
    } = body;

    const config = mapConfig(rawConfig || {});
    if (tradingStyle && STYLE_OVERRIDES[tradingStyle]) {
      const userMinConf = config.minConfluence;
      Object.assign(config, STYLE_OVERRIDES[tradingStyle]);
      config.minConfluence = userMinConf;
    }

    console.log(`[backtest:${runId}] Starting: ${instruments.length} instruments, ${startDate} → ${endDate}, balance: $${startingBalance}, research: ${researchMode}`);

    // ── Fetch Historical Data ──
    await updateProgress(10, `Fetching candles for ${instruments.length} instruments...`);
    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();
    const monthsSpan = Math.max(1, (endMs - startMs) / (30 * 24 * 3600 * 1000));
    const range = monthsSpan > 12 ? "2y" : monthsSpan > 6 ? "1y" : monthsSpan > 3 ? "6mo" : "3mo";

    const tfMap: Record<string, string> = {
      "1m": "1m", "5m": "5m", "15m": "15m", "15min": "15m",
      "30m": "30m", "30min": "30m", "1h": "1h", "4h": "4h",
    };
    const entryInterval = tfMap[config.entryTimeframe] || "15m";
    const candleData: Record<string, { entry: Candle[]; daily: Candle[]; h4: Candle[]; h1: Candle[]; smt?: Candle[] }> = {};

    // Diagnostic counters
    const diagnostics = {
      totalCandlesFetched: 0,
      totalCandlesEvaluated: 0,
      skippedUnsupportedSymbol: 0,
      skippedInsufficientData: 0,
      skippedWeekend: 0,
      skippedSession: 0,
      skippedDay: 0,
      skippedNoDirection: 0,
      skippedBelowThreshold: 0,
      skippedGateBlocked: 0,
      skippedNoSLTP: 0,
      signalsGenerated: 0,
      tradesOpened: 0,
      highestScoreSeen: 0,
      enabledFactorCount: 0,
      totalFactorCount: Object.keys(DEFAULT_FACTOR_WEIGHTS).length,
      scoreDistribution: { below20: 0, below40: 0, below60: 0, below80: 0, above80: 0 },
    };

    // Compute enabledFactorCount
    const DIAG_TOGGLE_MAP: Record<string, string> = {
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
    let enabledCount = 0;
    for (const key of Object.keys(DEFAULT_FACTOR_WEIGHTS)) {
      const toggleKey = DIAG_TOGGLE_MAP[key];
      if (toggleKey && (config as any)[toggleKey] === false) continue;
      enabledCount++;
    }
    diagnostics.enabledFactorCount = enabledCount;

    // ── Determine this chunk's symbols ──
    const supportedInstruments = instruments.filter((s: string) => SUPPORTED_SYMBOLS[s]);
    const totalChunks = Math.max(1, Math.ceil(supportedInstruments.length / CHUNK_SIZE));
    const chunkSymbols = supportedInstruments.slice(chunkIndex * CHUNK_SIZE, (chunkIndex + 1) * CHUNK_SIZE);
    console.log(`[backtest:${runId}] Chunk ${chunkIndex + 1}/${totalChunks}: ${chunkSymbols.length} symbols [${chunkSymbols.join(", ")}]`);

    // Track unsupported only on first chunk to avoid double counting
    if (chunkIndex === 0) {
      for (const s of instruments) {
        if (!SUPPORTED_SYMBOLS[s]) diagnostics.skippedUnsupportedSymbol++;
      }
    }

    for (const symbol of chunkSymbols) {
      if (!SUPPORTED_SYMBOLS[symbol]) { diagnostics.skippedUnsupportedSymbol++; continue; }
      const [entryCandles, dailyCandles, h4Candles, h1Candles] = await Promise.all([
        fetchHistoricalCandles(symbol, entryInterval, range, startDate, endDate),
        fetchHistoricalCandles(symbol, "1d", "2y", startDate, endDate),
        fetchHistoricalCandles(symbol, "4h", range, startDate, endDate),
        fetchHistoricalCandles(symbol, "1h", range, startDate, endDate),
      ]);
      console.log(`[backtest] ${symbol}: ${entryCandles.length} entry, ${dailyCandles.length} daily, ${h4Candles.length} 4H, ${h1Candles.length} 1H`);
      // Fetch SMT correlated pair
      const smtPair = SMT_PAIRS[symbol];
      let smtCandles: Candle[] | undefined;
      if (smtPair && SUPPORTED_SYMBOLS[smtPair] && config.useSMT) {
        smtCandles = await fetchHistoricalCandles(smtPair, entryInterval, range, startDate, endDate);
      }
      candleData[symbol] = { entry: entryCandles, daily: dailyCandles, h4: h4Candles, h1: h1Candles, smt: smtCandles };
      diagnostics.totalCandlesFetched += entryCandles.length + dailyCandles.length + h4Candles.length + h1Candles.length;
      await new Promise(r => setTimeout(r, 300));
    }

    // ── Fetch FOTSI Daily Candles + build per-day snapshot timeline ──
    const baseProgress = 10 + Math.round((chunkIndex / totalChunks) * 80);
    await updateProgress(baseProgress, `Chunk ${chunkIndex + 1}/${totalChunks}: building FOTSI timeline...`);
    const fotsiTimeline = new Map<string, FOTSIResult>();
    let fotsiCandleMap: Record<string, Candle[]> = {};

    // Try to reuse cached FOTSI timeline from previous chunk
    let cachedFotsi: any = null;
    if (chunkIndex > 0) {
      const { data: runRow } = await db
        .from("backtest_runs")
        .select("results")
        .eq("id", runId)
        .maybeSingle();
      cachedFotsi = runRow?.results?.partial_state?.fotsiTimeline || null;
    }
    if (cachedFotsi && Array.isArray(cachedFotsi)) {
      for (const [date, snap] of cachedFotsi) fotsiTimeline.set(date, snap);
      console.log(`[backtest:${runId}] FOTSI timeline restored: ${fotsiTimeline.size} snapshots`);
    } else try {
      const { getFOTSIPairNames } = await import("../_shared/fotsi.ts");
      const fotsiPairs = getFOTSIPairNames();
      for (let i = 0; i < fotsiPairs.length; i += 7) {
        const batch = fotsiPairs.slice(i, i + 7);
        const results = await Promise.all(
          batch.map(p => fetchHistoricalCandles(p, "1d", "2y", startDate, endDate).catch(() => []))
        );
        for (let j = 0; j < batch.length; j++) {
          if (results[j].length > 0) fotsiCandleMap[batch[j]] = results[j];
        }
        await new Promise(r => setTimeout(r, 500));
      }
      // Build daily FOTSI snapshots
      const allDates = new Set<string>();
      for (const candles of Object.values(fotsiCandleMap)) {
        for (const c of candles) allDates.add(c.datetime.slice(0, 10));
      }
      const sortedDates = [...allDates].sort();
      for (const date of sortedDates) {
        // Build candle map up to this date (no lookahead)
        const dailyMap: Record<string, Candle[]> = {};
        for (const [pair, candles] of Object.entries(fotsiCandleMap)) {
          dailyMap[pair] = candles.filter(c => c.datetime.slice(0, 10) <= date);
        }
        try {
          const result = computeFOTSI(dailyMap);
          fotsiTimeline.set(date, result);
        } catch { /* skip dates with insufficient data */ }
      }
      console.log(`[backtest] FOTSI timeline: ${fotsiTimeline.size} daily snapshots`);
    } catch (e: any) {
      console.warn(`[backtest] FOTSI timeline build failed (non-fatal): ${e?.message}`);
    }

    // ── Build BT Rate Map ──
    const btRateMap: Record<string, number> = {};
    for (const symbol of instruments) {
      try {
        const rate = await getQuoteToUSDRate(symbol);
        btRateMap[symbol] = rate;
      } catch { btRateMap[symbol] = 1; }
    }

    // ── Main Scan Loop ──
    await updateProgress(40, "Running scan loop...");
    let balance = startingBalance;
    let peakBalance = startingBalance;
    const openPositions: OpenPosition[] = [];
    const allTrades: BacktestTrade[] = [];
    const blockedTrades: BlockedTrade[] = [];
    let tradeCounter = 0;

    const symbolList = instruments.filter((s: string) => candleData[s] && candleData[s].entry.length >= 100);
    const totalBars = symbolList.reduce((s: number, sym: string) => s + candleData[sym].entry.length, 0);
    let processedBars = 0;
    let lastProgressUpdate = Date.now();

    for (const symbol of symbolList) {
      const { entry: entryCandles, daily: dailyCandles, h4: h4Candles, h1: h1Candles, smt: smtCandles } = candleData[symbol];
      if (entryCandles.length < 100) { diagnostics.skippedInsufficientData++; continue; }

      const spec = SPECS[symbol] || SPECS["EUR/USD"];
      const lookback = config.structureLookback || 100;

      // Find the start index (first candle >= startDate)
      const startIdx = entryCandles.findIndex(c => {
        const cMs = new Date(c.datetime.endsWith("Z") ? c.datetime : c.datetime + "Z").getTime();
        return cMs >= startMs;
      });
      const effectiveStart = Math.max(startIdx, lookback);

      for (let i = effectiveStart; i < entryCandles.length; i++) {
        const candle = entryCandles[i];
        const candleMs = new Date(candle.datetime.endsWith("Z") ? candle.datetime : candle.datetime + "Z").getTime();
        if (candleMs > endMs) break;
        processedBars++;
        diagnostics.totalCandlesEvaluated++;

        // Progress update (throttled)
        if (Date.now() - lastProgressUpdate > 5000) {
          const pct = Math.min(90, 40 + Math.round((processedBars / totalBars) * 50));
          await updateProgress(pct, `Processing ${symbol} bar ${i}/${entryCandles.length}...`);
          lastProgressUpdate = Date.now();
        }

        // ── Process exits first ──
        const symbolPositions = openPositions.filter(p => p.symbol === symbol);
        if (symbolPositions.length > 0) {
          const { closedTrades, updatedPositions } = processExits(
            symbolPositions, candle, i, config, slippagePips, btRateMap, commissionPerLot, entryCandles,
          );
          // Remove old positions for this symbol, add updated
          const otherPositions = openPositions.filter(p => p.symbol !== symbol);
          openPositions.length = 0;
          openPositions.push(...otherPositions, ...updatedPositions);
          for (const ct of closedTrades) {
            allTrades.push(ct);
            balance += ct.pnl;
            if (balance > peakBalance) peakBalance = balance;
          }
        }

        // ── Skip weekends ──
        const candleDow = new Date(candleMs).getUTCDay();
        if (candleDow === 0 || candleDow === 6) { diagnostics.skippedWeekend++; continue; }

        // ── Session detection ──
        const session: SessionResult = detectSession(candleMs);
        if (config.enabledSessions && config.enabledSessions.length > 0) {
          if (!isSessionEnabled(session, config.enabledSessions)) { diagnostics.skippedSession++; continue; }
        }

        // ── Get relevant daily candles up to this date (no lookahead) ──
        const candleDateStr = new Date(candleMs).toISOString().slice(0, 10);
        const relevantDaily = dailyCandles.filter(c => c.datetime.slice(0, 10) < candleDateStr);
        if (relevantDaily.length < 10) continue;

        // ── Get relevant H4/H1 candles up to this candle time ──
        const relevantH4 = h4Candles.filter(c => {
          const cMs = new Date(c.datetime.endsWith("Z") ? c.datetime : c.datetime + "Z").getTime();
          return cMs < candleMs;
        });
        const relevantH1 = h1Candles.filter(c => {
          const cMs = new Date(c.datetime.endsWith("Z") ? c.datetime : c.datetime + "Z").getTime();
          return cMs < candleMs;
        });

        // ── Direction Engine (top-down: Daily → 4H → 1H) ──
        let directionResult: DirectionResult | null = null;
        if (config.useSimpleDirection) {
          try {
            directionResult = determineDirection(
              relevantDaily.length >= 20 ? relevantDaily : null,
              relevantH4.length >= 20 ? relevantH4 : null,
              relevantH1.length >= 20 ? relevantH1 : null,
              {
                h4ChochLookback: config.simpleDirectionH4ChochLookback ?? 10,
                h1BosLookback: config.simpleDirectionH1BosLookback ?? 8,
              },
            );
          } catch { directionResult = null; }
        }

        // ── Build analysis window ──
        const windowStart = Math.max(0, i - lookback);
        const analysisCandles = entryCandles.slice(windowStart, i + 1);
        if (analysisCandles.length < 50) continue;

        // ── HTF POI Detection (4H OBs, FVGs, Breakers) ──
        let h4OBs: any[] = [];
        let h4FVGs: any[] = [];
        let h4Breakers: any[] = [];
        let htfFibLevels4H: any = null;
        let htfPD4H: any = null;
        if (relevantH4.length >= 30) {
          try {
            const h4Structure = analyzeMarketStructure(relevantH4.slice(-60));
            const h4StructureBreaks = [...h4Structure.bos, ...h4Structure.choch].map(b => ({ index: b.index, type: b.type }));
            h4OBs = detectOrderBlocks(relevantH4.slice(-60), h4StructureBreaks);
            h4FVGs = detectFVGs(relevantH4.slice(-60), h4StructureBreaks);
            h4Breakers = detectBreakerBlocks(h4OBs, relevantH4.slice(-60), h4StructureBreaks);
            const h4PivotResult = detectZigZagPivots(relevantH4.slice(-60));
            if (h4PivotResult.lastTwo) {
              htfFibLevels4H = computeFibLevels(h4PivotResult.lastTwo[0], h4PivotResult.lastTwo[1]);
            }
            htfPD4H = calculatePremiumDiscount(relevantH4.slice(-60));
          } catch { /* non-fatal */ }
        }

        // ── Build config for confluenceScoring ──
        const pairConfig = { ...config };
        pairConfig._currentSymbol = symbol;
        // Inject direction override
        if (directionResult) {
          if (directionResult.direction !== null) {
            (pairConfig as any)._overrideDirection = directionResult.direction;
          } else {
            (pairConfig as any)._overrideDirection = null;
          }
        }
        // Inject HTF data
        (pairConfig as any)._htfPOIs = (h4OBs.length > 0 || h4FVGs.length > 0 || h4Breakers.length > 0)
          ? { h4OBs, h4FVGs, h4Breakers } : null;
        (pairConfig as any)._htfFibLevels = htfFibLevels4H;
        (pairConfig as any)._htfPD = htfPD4H;
        (pairConfig as any)._h4Candles = relevantH4.length >= 20 ? relevantH4.slice(-60) : null;

        // Inject FOTSI for this date
        const fotsiForDate = fotsiTimeline.get(candleDateStr) || null;
        (pairConfig as any)._fotsiResult = fotsiForDate;

        // SMT data
        let smtResult: any = null;
        if (smtCandles && config.useSMT) {
          const smtSlice = smtCandles.filter(c => {
            const cMs = new Date(c.datetime.endsWith("Z") ? c.datetime : c.datetime + "Z").getTime();
            return cMs <= candleMs;
          }).slice(-lookback);
          if (smtSlice.length >= 30) {
            try {
              smtResult = detectSMTDivergence(symbol, analysisCandles, smtSlice);
              pairConfig._smtResult = smtResult;
            } catch { /* non-fatal */ }
          }
        }

        // ── Run Confluence Analysis ──
        let analysis: any;
        try {
          analysis = runConfluenceAnalysis(analysisCandles, pairConfig, relevantDaily);
        } catch (e: any) {
          continue;
        }

        if (!analysis || !analysis.direction) {
          diagnostics.skippedNoDirection++;
          continue;
        }

        // ── Impulse Zone Engine ──
        let izData: any = null;
        if (analysis.direction && relevantH1.length >= 20) {
          try {
            const zoneDirection = analysis.direction === "long" ? "bullish" : "bearish";
            const htfConfluenceData: HTFConfluenceData = {
              h4OBs: h4OBs ?? [],
              h4FVGs: h4FVGs ?? [],
              h4Breakers: h4Breakers ?? [],
              htfFibLevels: htfFibLevels4H ?? null,
              htfPD: htfPD4H ?? null,
              direction: zoneDirection as "bullish" | "bearish",
            };
            const zoneResult: MultiTFZoneResult = findBestEntryZoneMultiTF(
              relevantH1.slice(-120), relevantH4.slice(-60), analysisCandles, zoneDirection as "bullish" | "bearish", analysis.lastPrice, htfConfluenceData,
            );
            izData = {
              hasZone: !!zoneResult.bestZone,
              selectedTF: zoneResult.selectedTF,
              reason: zoneResult.reason,
              impulse: zoneResult.bestZone?.impulse ? {
                high: zoneResult.bestZone.impulse.high,
                low: zoneResult.bestZone.impulse.low,
                direction: zoneResult.bestZone.impulse.direction,
              } : null,
              bestZone: zoneResult.bestZone ? {
                type: zoneResult.bestZone.zone.poi.type,
                high: zoneResult.bestZone.zone.poi.high,
                low: zoneResult.bestZone.zone.poi.low,
                fibLevel: zoneResult.bestZone.zone.fibLevel,
                fibDepth: zoneResult.bestZone.zone.fibDepth,
                totalScore: zoneResult.bestZone.zone.totalScore,
                srConfirmed: zoneResult.bestZone.zone.srConfirmed,
                ltfRefined: zoneResult.bestZone.zone.ltfRefined,
                htfConfluenceScore: zoneResult.bestZone.zone.htfConfluenceScore,
                htfLayers: zoneResult.bestZone.zone.htfLayers,
                priceAtZone: zoneResult.bestZone.priceAtZone,
                distanceToZone: zoneResult.bestZone.distanceToZone,
                refinedEntry: zoneResult.bestZone.zone.refinedEntry || null,
              } : null,
              allZonesCount: zoneResult.allZones.length,
            };
          } catch { /* non-fatal */ }
        }

        // ── Impulse Zone Gate + Credits (mirrors bot-scanner exactly) ──
        const izGateMode = config.impulseZoneGateMode || "hard";
        let impulseZonePenaltyVal = 0;

        if (config.impulseZoneEnabled !== false && izGateMode === "hard") {
          if (!izData || !izData.hasZone) {
            // No valid impulse zone — skip (hard gate)
            diagnostics.skippedNoDirection++;
            continue;
          }
          if (!izData.bestZone?.priceAtZone) {
            // Zone exists but price not there yet — skip
            continue;
          }
          // Price IS at zone — apply bonus
          impulseZonePenaltyVal = +(config.impulseZoneBonus ?? 1.0);

          // ── Impulse Zone → Tier 1 Credit ──
          if (analysis.tieredScoring && izData?.bestZone && !analysis.tieredScoring.tier1GatePassed) {
            const ts = analysis.tieredScoring;
            const zonePOIType = izData.bestZone.type;
            const htfLayers = izData.bestZone.htfLayers || [];
            const izTier1Credits: string[] = [];

            if (zonePOIType === "fvg") {
              const fvgFactor = analysis.factors?.find((f: any) => f.name === "Fair Value Gap");
              if (fvgFactor && (!fvgFactor.present || fvgFactor.weight <= 0 || (fvgFactor as any).tier !== 1)) {
                fvgFactor.present = true;
                fvgFactor.weight = 1.0;
                (fvgFactor as any).tier = 1;
                fvgFactor.detail += ` | IMPULSE-ZONE CREDIT: zone POI type is FVG`;
                izTier1Credits.push("FVG (impulse-zone-confirmed)");
              }
            } else if (zonePOIType === "ob") {
              const obFactor = analysis.factors?.find((f: any) => f.name === "Order Block");
              if (obFactor && (!obFactor.present || obFactor.weight <= 0 || (obFactor as any).tier !== 1)) {
                obFactor.present = true;
                obFactor.weight = 1.0;
                (obFactor as any).tier = 1;
                obFactor.detail += ` | IMPULSE-ZONE CREDIT: zone POI type is OB`;
                izTier1Credits.push("OB (impulse-zone-confirmed)");
              }
            }

            // HTF layer credits
            if (htfLayers.some((l: string) => l.toLowerCase().includes("ob"))) {
              const obFactor = analysis.factors?.find((f: any) => f.name === "Order Block");
              if (obFactor && (!obFactor.present || obFactor.weight <= 0 || (obFactor as any).tier !== 1)) {
                obFactor.present = true;
                obFactor.weight = 1.0;
                (obFactor as any).tier = 1;
                obFactor.detail += ` | IMPULSE-ZONE CREDIT: HTF layer contains OB`;
                if (!izTier1Credits.includes("OB (impulse-zone-confirmed)")) izTier1Credits.push("OB (HTF-zone-layer)");
              }
            }
            if (htfLayers.some((l: string) => l.toLowerCase().includes("fvg"))) {
              const fvgFactor = analysis.factors?.find((f: any) => f.name === "Fair Value Gap");
              if (fvgFactor && (!fvgFactor.present || fvgFactor.weight <= 0 || (fvgFactor as any).tier !== 1)) {
                fvgFactor.present = true;
                fvgFactor.weight = 1.0;
                (fvgFactor as any).tier = 1;
                fvgFactor.detail += ` | IMPULSE-ZONE CREDIT: HTF layer contains FVG`;
                if (!izTier1Credits.includes("FVG (impulse-zone-confirmed)")) izTier1Credits.push("FVG (HTF-zone-layer)");
              }
            }

            if (izTier1Credits.length > 0) {
              const newTier1Count = ts.tier1Count + izTier1Credits.length;
              const newPassed = newTier1Count >= 3;
              const creditPts = izTier1Credits.length * 1.0;
              const newTieredScore = ts.tieredScore + creditPts;
              const newScore = ts.tieredMax > 0 ? Math.round((newTieredScore / ts.tieredMax) * 1000) / 10 : analysis.score;
              analysis.tieredScoring = {
                ...ts,
                tier1Count: newTier1Count,
                tier1GatePassed: newPassed,
                tier1GateReason: newPassed
                  ? `Tier 1 gate passed (impulse-zone credit): ${newTier1Count} core factors`
                  : `Tier 1 gate FAILED: only ${newTier1Count} core factors — need at least 3`,
                tieredScore: newTieredScore,
              };
              analysis.score = newScore;
            }
          }

          // ── Impulse Zone → P/D & Fib Credit (Tier 1) ──
          if (analysis.tieredScoring && izData?.bestZone) {
            const pdFactor = analysis.factors?.find((f: any) => f.name === "Premium/Discount & Fib");
            const fibDepth = izData.bestZone.fibDepth ?? 0;
            if (pdFactor && (!pdFactor.present || pdFactor.weight <= 0) && fibDepth >= 0.5) {
              pdFactor.present = true;
              pdFactor.weight = fibDepth >= 0.71 ? 2.0 : fibDepth >= 0.618 ? 1.5 : 1.0;
              (pdFactor as any).tier = 1;
              pdFactor.detail += ` | IMPULSE-ZONE CREDIT: zone at ${(fibDepth * 100).toFixed(1)}% Fib depth`;
              const ts = analysis.tieredScoring;
              if (ts && ts.tier1Count !== undefined) {
                const newCount = ts.tier1Count + 1;
                const newPassed = newCount >= 3;
                const newTieredScore = ts.tieredScore + pdFactor.weight;
                const newScore = ts.tieredMax > 0 ? Math.round((newTieredScore / ts.tieredMax) * 1000) / 10 : analysis.score;
                analysis.tieredScoring = { ...ts, tier1Count: newCount, tier1GatePassed: newPassed,
                  tier1GateReason: newPassed ? `Tier 1 gate passed (impulse-zone credit): ${newCount} core factors` : `Tier 1 gate FAILED: only ${newCount} core factors — need at least 3`,
                  tieredScore: newTieredScore };
                analysis.score = newScore;
              }
            }
          }

          // ── Impulse Zone → Confluence Stack Credit (Tier 2) ──
          if (analysis.tieredScoring && izData?.bestZone) {
            const stackFactor = analysis.factors?.find((f: any) => f.name === "Confluence Stack");
            const srConfirmed = izData.bestZone.srConfirmed ?? false;
            const htfLayers = izData.bestZone.htfLayers || [];
            const stackLayers = (srConfirmed ? 1 : 0) + htfLayers.length;
            if (stackFactor && (!stackFactor.present || stackFactor.weight <= 0) && stackLayers >= 2) {
              stackFactor.present = true;
              stackFactor.weight = stackLayers >= 3 ? 1.5 : 1.0;
              stackFactor.detail += ` | IMPULSE-ZONE CREDIT: ${stackLayers}-layer confluence`;
              const ts = analysis.tieredScoring;
              if (ts && ts.tier2Count !== undefined) {
                const newTieredScore = ts.tieredScore + stackFactor.weight;
                const newScore = ts.tieredMax > 0 ? Math.round((newTieredScore / ts.tieredMax) * 1000) / 10 : analysis.score;
                analysis.tieredScoring = { ...ts, tier2Count: ts.tier2Count + 1, tieredScore: newTieredScore };
                analysis.score = newScore;
              }
            }
          }

          // ── Impulse Zone → HTF POI Alignment Credit (Tier 2) ──
          if (analysis.tieredScoring && izData?.bestZone && izData.bestZone.priceAtZone) {
            const htfPoiFactor = analysis.factors?.find((f: any) => f.name === "HTF POI Alignment");
            const htfLayers = izData.bestZone.htfLayers || [];
            const hasHTFOBorFVG = htfLayers.some((l: string) => l.toLowerCase().includes("ob") || l.toLowerCase().includes("fvg"));
            if (htfPoiFactor && (!htfPoiFactor.present || htfPoiFactor.weight <= 0) && hasHTFOBorFVG) {
              let boost = 0;
              if (htfLayers.some((l: string) => l.toLowerCase().includes("fvg"))) boost += 0.8;
              if (htfLayers.some((l: string) => l.toLowerCase().includes("ob"))) boost += 0.7;
              boost = Math.min(2.0, boost);
              htfPoiFactor.present = true;
              htfPoiFactor.weight = boost;
              htfPoiFactor.detail += ` | IMPULSE-ZONE CREDIT: zone overlaps ${htfLayers.join(", ")}`;
              const ts = analysis.tieredScoring;
              if (ts && ts.tier2Count !== undefined) {
                const newTieredScore = ts.tieredScore + boost;
                const newScore = ts.tieredMax > 0 ? Math.round((newTieredScore / ts.tieredMax) * 1000) / 10 : analysis.score;
                analysis.tieredScoring = { ...ts, tier2Count: ts.tier2Count + 1, tieredScore: newTieredScore };
                analysis.score = newScore;
              }
            }
          }
        } else if (config.impulseZoneEnabled !== false && izGateMode === "soft") {
          // SOFT MODE: penalty/bonus
          if (izData) {
            if (!izData.hasZone) {
              impulseZonePenaltyVal = -(config.impulseZonePenalty ?? 2.0);
            } else if (izData.bestZone?.priceAtZone) {
              impulseZonePenaltyVal = +(config.impulseZoneBonus ?? 1.0);
            }
          }
        }

        // ── FOTSI Penalty (soft — not a hard block, just score reduction) ──
        let fotsiPenalty = 0;
        if (fotsiForDate && config.useFOTSI !== false && analysis.direction) {
          const currencies = parsePairCurrencies(symbol);
          if (currencies) {
            const [base, quote] = currencies;
            const dir = analysis.direction === "long" ? "BUY" : "SELL";
            const veto = checkOverboughtOversoldVeto(base, quote, dir as "BUY" | "SELL", fotsiForDate.strengths, fotsiForDate.series);
            if (veto.vetoed) fotsiPenalty = -2.0;
          }
        }

        // ── Effective Score ──
        const effectiveScore = analysis.score + fotsiPenalty + impulseZonePenaltyVal;

        // ── Bidirectional Conflict Counter ──
        const opposingCount = analysis.tieredScoring?.opposingFactorCount ?? 0;
        let conflictAdjustedMinConfluence = config.minConfluence;
        let conflictHardBlock = false;
        if (opposingCount >= config.conflictBlockAt) {
          conflictHardBlock = true;
        } else if (opposingCount >= config.conflictThresholdRaise) {
          conflictAdjustedMinConfluence = config.minConfluence + 10;
        }

        // ── Score distribution tracking ──
        if (effectiveScore < 20) diagnostics.scoreDistribution.below20++;
        else if (effectiveScore < 40) diagnostics.scoreDistribution.below40++;
        else if (effectiveScore < 60) diagnostics.scoreDistribution.below60++;
        else if (effectiveScore < 80) diagnostics.scoreDistribution.below80++;
        else diagnostics.scoreDistribution.above80++;
        if (effectiveScore > diagnostics.highestScoreSeen) diagnostics.highestScoreSeen = effectiveScore;

        // ── Conflict hard block ──
        if (conflictHardBlock) {
          diagnostics.skippedGateBlocked++;
          if (researchMode && analysis.stopLoss && analysis.takeProfit) {
            const cf = computeCounterfactual(symbol, analysis.direction, candle.close, analysis.stopLoss, analysis.takeProfit, entryCandles, i + 1, 200);
            blockedTrades.push({
              symbol, direction: analysis.direction, time: candle.datetime,
              score: analysis.score, effectiveScore,
              blockedBy: [`Conflict block: ${opposingCount} opposing factors`],
              factors: analysis.factors.map((f: any) => ({ name: f.name, present: f.present, weight: f.weight })),
              ...cf,
              regime: analysis.regimeInfo?.regime || "unknown",
              session: session.name,
            });
          }
          continue;
        }

        // ── Threshold check ──
        if (effectiveScore < conflictAdjustedMinConfluence) {
          diagnostics.skippedBelowThreshold++;
          continue;
        }

        // ── SL/TP check ──
        if (!analysis.stopLoss || !analysis.takeProfit) {
          diagnostics.skippedNoSLTP++;
          continue;
        }

        diagnostics.signalsGenerated++;

        // ── Run Safety Gates ──
        const gates = runBacktestSafetyGates(
          symbol, analysis.direction, analysis, config, balance,
          openPositions, relevantDaily.length >= 10 ? relevantDaily : null,
          allTrades, candleMs, peakBalance, spreadPips, fotsiForDate, smtResult,
        );

        const failedGates = gates.filter(g => !g.passed);
        const allPassed = failedGates.length === 0;

        if (!allPassed) {
          diagnostics.skippedGateBlocked++;
          // Research mode: track what would have happened
          if (researchMode) {
            const cf = computeCounterfactual(symbol, analysis.direction, candle.close, analysis.stopLoss, analysis.takeProfit, entryCandles, i + 1, 200);
            blockedTrades.push({
              symbol, direction: analysis.direction, time: candle.datetime,
              score: analysis.score, effectiveScore,
              blockedBy: failedGates.map(g => g.reason),
              factors: analysis.factors.map((f: any) => ({ name: f.name, present: f.present, weight: f.weight })),
              ...cf,
              regime: analysis.regimeInfo?.regime || "unknown",
              session: session.name,
            });
          }
          continue;
        }

        // ── SL Floor Enforcement (matching bot-scanner/paper-trading) ──
        // Two-layer floor: max(staticMinSlPips, atrFloorPips)
        {
          const slDistPips = Math.abs(candle.close - analysis.stopLoss) / spec.pipSize;
          const staticMin = MIN_SL_PIPS[symbol] ?? MIN_SL_PIPS["EUR/USD"] ?? 10;
          // For backtest, ATR is already available from the candle data
          const recentCandles = entryCandles.slice(Math.max(0, i - 20), i);
          const atrVal = recentCandles.length >= 14 ? calculateATR(recentCandles, 14) : 0;
          const atrFloorPips = atrVal > 0 ? (atrVal * ATR_SL_FLOOR_MULTIPLIER) / spec.pipSize : 0;
          const effectiveMinSl = Math.max(staticMin, atrFloorPips);
          if (slDistPips < effectiveMinSl) {
            // Widen SL to minimum, preserve R:R
            const origRR = analysis.takeProfit && analysis.stopLoss
              ? Math.abs(candle.close - analysis.takeProfit) / Math.abs(candle.close - analysis.stopLoss)
              : 2;
            const newSlDist = effectiveMinSl * spec.pipSize;
            if (analysis.direction === "long") {
              analysis.stopLoss = candle.close - newSlDist;
              analysis.takeProfit = candle.close + newSlDist * origRR;
            } else {
              analysis.stopLoss = candle.close + newSlDist;
              analysis.takeProfit = candle.close - newSlDist * origRR;
            }
          }
        }

        // ── Position Sizing ──
        const risk = Math.abs(candle.close - analysis.stopLoss);
        let posSize: number;
        if (config.positionSizingMethod === "fixed_lot") {
          posSize = config.fixedLotSize;
        } else {
          const riskAmount = balance * (config.riskPerTrade / 100);
          const pipsRisk = risk / spec.pipSize;
          const pipValue = spec.pipSize * (spec.lotUnits || 100000) * (btRateMap[symbol] || 1);
          posSize = pipsRisk > 0 && pipValue > 0 ? riskAmount / (pipsRisk * pipValue) : 0.01;
          posSize = Math.max(0.01, Math.min(posSize, 10));
        }

        // ── Open Position ──
        tradeCounter++;
        const posId = `bt_${runId.slice(0, 8)}_${tradeCounter}`;
        const newPos: OpenPosition = {
          id: posId,
          symbol,
          direction: analysis.direction,
          entryPrice: candle.close,
          stopLoss: analysis.stopLoss,
          takeProfit: analysis.takeProfit,
          size: posSize,
          entryTime: candle.datetime,
          entryBarIndex: i,
          confluenceScore: analysis.score,
          effectiveScore,
          factors: analysis.factors.map((f: any) => ({ name: f.name, present: f.present, weight: f.weight })),
          exitFlags: {
            breakEven: config.breakEvenEnabled,
            breakEvenPips: config.breakEvenPips,
            trailingStop: config.trailingStopEnabled,
            trailingStopPips: config.trailingStopPips,
            trailingStopActivation: config.trailingStopActivation,
            tpRatio: config.tpRatio,
            partialTP: config.partialTPEnabled,
            partialTPPercent: config.partialTPPercent,
            partialTPLevel: config.partialTPLevel,
            maxHoldHours: config.maxHoldHours,
          },
          partialTPFired: false,
          currentSL: analysis.stopLoss,
          structureInvalidationFired: false,
          regime: analysis.regimeInfo?.regime || "unknown",
          session: session.name,
        };
        openPositions.push(newPos);
        diagnostics.tradesOpened++;
      }
    }

    // ── Close remaining open positions at last candle close ──
    for (const pos of [...openPositions]) {
      const lastCandle = candleData[pos.symbol]?.entry.slice(-1)[0];
      if (lastCandle) {
        const { pnl: rawPnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, lastCandle.close, pos.size, pos.symbol, btRateMap);
        const comm = pos.size * commissionPerLot * 2;
        allTrades.push({
          id: pos.id,
          symbol: pos.symbol,
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          exitPrice: lastCandle.close,
          entryTime: pos.entryTime,
          exitTime: lastCandle.datetime,
          size: pos.size,
          pnl: rawPnl - comm,
          pnlPips,
          commission: comm,
          closeReason: "end_of_test",
          confluenceScore: pos.confluenceScore,
          effectiveScore: pos.effectiveScore,
          factors: pos.factors,
          gatesBlocked: [],
          regime: pos.regime,
          session: pos.session,
        });
        balance += rawPnl - comm;
      }
    }
    openPositions.length = 0;

    // ── Calculate Stats ──
    await updateProgress(92, "Calculating statistics...");
    const stats = calculateStats(allTrades, startingBalance, monthsSpan);

    // ── Research Analytics ──
    let researchAnalytics: ResearchAnalytics | null = null;
    if (researchMode) {
      researchAnalytics = computeResearchAnalytics(allTrades, blockedTrades, startingBalance, monthsSpan);
    }

    // ── Build equity curve ──
    const equityCurve: { date: string; equity: number }[] = [];
    let eqBalance = startingBalance;
    let lastEqDate = "";
    for (const t of allTrades) {
      const d = t.exitTime.slice(0, 10);
      eqBalance += t.pnl;
      if (d !== lastEqDate) {
        equityCurve.push({ date: d, equity: eqBalance });
        lastEqDate = d;
      } else {
        equityCurve[equityCurve.length - 1].equity = eqBalance;
      }
    }

    // ── Persist Results ──
    await updateProgress(95, "Saving results...");
    const result = {
      stats,
      trades: allTrades.slice(0, maxTradesStored),
      equityCurve,
      diagnostics,
      config: { ...config, _fotsiResult: undefined, _smtResult: undefined, _htfPOIs: undefined, _htfFibLevels: undefined, _htfPD: undefined, _h4Candles: undefined },
      researchAnalytics: researchAnalytics ? {
        gateEffectiveness: researchAnalytics.gateEffectiveness,
        factorEdge: researchAnalytics.factorEdge,
        regimeBreakdown: researchAnalytics.regimeBreakdown,
        sessionBreakdown: researchAnalytics.sessionBreakdown,
        thresholdCurve: researchAnalytics.thresholdCurve,
        blockedTradeCount: blockedTrades.length,
        blockedTrades: researchAnalytics.blockedTrades.slice(0, maxBlockedStored),
        counterfactualStats: researchAnalytics.counterfactualStats,
      } : null,
    };

    await db.from("backtest_runs").update({
      status: "completed",
      completed_at: new Date().toISOString(),
      progress: 100,
      progress_message: `Done: ${stats.totalTrades} trades, ${stats.winRate.toFixed(1)}% WR, PF ${stats.profitFactor.toFixed(2)}`,
      results: result,
    }).eq("id", runId);

    console.log(`[backtest:${runId}] Completed: ${stats.totalTrades} trades, WR ${stats.winRate.toFixed(1)}%, PF ${stats.profitFactor.toFixed(2)}, DD ${stats.maxDrawdownPct.toFixed(1)}%`);

  } catch (err: any) {
    console.error(`[backtest:${runId}] FATAL:`, err);
    await db.from("backtest_runs").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      progress_message: `Error: ${err?.message || "Unknown error"}`,
      results: { error: err?.message, stack: err?.stack?.slice(0, 500) },
    }).eq("id", runId);
  }
}

// ─── HTTP Handler ───────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const action = body?.action || "start";
    const db = getAdminClient();

    // Resolve user from JWT for ownership on start/list
    async function getUserId(): Promise<string | null> {
      const auth = req.headers.get("Authorization");
      if (!auth?.startsWith("Bearer ")) return null;
      const token = auth.replace("Bearer ", "");
      const { data } = await db.auth.getUser(token);
      return data?.user?.id || null;
    }

    if (action === "status") {
      const { runId } = body;
      if (!runId) return respond({ error: "runId is required" }, 400);
      const { data, error } = await db
        .from("backtest_runs")
        .select("id,status,progress,progress_message,results,error_message,created_at,started_at,completed_at")
        .eq("id", runId)
        .maybeSingle();
      if (error) return respond({ error: error.message }, 500);
      if (!data) return respond({ error: "Run not found" }, 404);
      return respond({
        runId: data.id,
        status: data.status,
        progress: data.progress,
        message: data.progress_message,
        results: data.results,
        error: data.error_message,
        createdAt: data.created_at,
        startedAt: data.started_at,
        completedAt: data.completed_at,
      });
    }

    if (action === "list") {
      const userId = await getUserId();
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const limit = Math.min(Number(body.limit) || 20, 100);
      const { data, error } = await db
        .from("backtest_runs")
        .select("id,status,progress,created_at,started_at,completed_at,error_message")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return respond({ error: error.message }, 500);
      return respond({ runs: data || [] });
    }

    // action === "start" (default)
    const userId = await getUserId();
    if (!userId) return respond({ error: "Unauthorized" }, 401);

    const { data: inserted, error: insErr } = await db
      .from("backtest_runs")
      .insert({
        user_id: userId,
        status: "pending",
        progress: 0,
        progress_message: "Queued",
        config: {
          instruments: body.instruments,
          startDate: body.startDate,
          endDate: body.endDate,
          startingBalance: body.startingBalance,
          tradingStyle: body.tradingStyle,
          walkForwardFolds: body.walkForwardFolds ?? 0,
        },
      })
      .select("id")
      .single();
    if (insErr || !inserted) return respond({ error: insErr?.message || "Failed to create run" }, 500);

    const runId = inserted.id as string;

    if (typeof EdgeRuntime !== "undefined" && (EdgeRuntime as any)?.waitUntil) {
      (EdgeRuntime as any).waitUntil(runBacktestJob(runId, body));
    } else {
      runBacktestJob(runId, body).catch(e => console.error("[backtest] Background job error:", e));
    }

    return respond({ runId, status: "started", message: "Backtest queued" });
  } catch (err: any) {
    console.error("[backtest] Handler error:", err);
    return respond({ error: err?.message || "Internal error" }, 500);
  }
});
