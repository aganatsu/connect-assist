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
 *   commissionPerLot?: number,    // round-trip commission per standard lot (default 0)
 *   walkForwardFolds?: number,     // number of time folds for walk-forward validation (0=disabled, 2-20)
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
  type SessionResult,
} from "../_shared/sessions.ts";

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

// ─── Local ReasoningFactor with group support ──────────────────────
// Extends the shared ReasoningFactor with an optional group field for 9-group scoring.
interface BacktestReasoningFactor {
  name: string;
  present: boolean;
  weight: number;
  detail: string;
  group?: string;
}

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
  commission: number;
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
  factors: { name: string; present: boolean; weight: number }[];
  exitFlags: any;
  partialTPFired: boolean;
  currentSL: number;
  structureInvalidationFired: boolean;
}

// ─── Candle Fetching (Backtest-specific: date-range aware) ──────────
// Symbol mappings (duplicated from candleSource since they're not exported)
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

// Fetch candles from TwelveData using date-range params (up to 5000 per request)
async function fetchTwelveDataRange(
  symbol: string, interval: string, startDate: string, endDate: string,
): Promise<Candle[]> {
  const apiKey = Deno.env.get("TWELVE_DATA_API_KEY");
  if (!apiKey) return [];
  const tdSymbol = BT_TWELVE_DATA_SYMBOLS[symbol];
  if (!tdSymbol) return [];
  const tdInterval = BT_TD_INTERVAL[interval] || "15min";

  // TwelveData supports start_date/end_date with outputsize up to 5000
  const allCandles: Candle[] = [];
  let currentStart = startDate;
  const maxPerRequest = 5000;

  // Paginate: fetch chunks until we reach endDate
  for (let page = 0; page < 20; page++) { // safety limit: 20 pages = 100k candles max
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${tdInterval}&start_date=${encodeURIComponent(currentStart)}&end_date=${encodeURIComponent(endDate)}&outputsize=${maxPerRequest}&apikey=${apiKey}&order=ASC`;
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        console.warn(`[backtest] TwelveData 429, waiting 10s...`);
        await new Promise(r => setTimeout(r, 10000));
        continue; // retry same page
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
      if (chunk.length < maxPerRequest) break; // last page
      // Move start to after last candle
      const lastDt = chunk[chunk.length - 1].datetime;
      currentStart = lastDt; // TwelveData handles overlap dedup
      await new Promise(r => setTimeout(r, 1000)); // rate limit between pages
    } catch (e: any) {
      console.warn(`[backtest] TwelveData fetch error page ${page}: ${e?.message}`);
      break;
    }
  }
  return allCandles;
}

// Polygon.io fallback with date range
async function fetchPolygonRange(
  symbol: string, interval: string, startDate: string, endDate: string,
): Promise<Candle[]> {
  const apiKey = Deno.env.get("POLYGON_API_KEY");
  if (!apiKey) return [];
  const pgSym = SUPPORTED_SYMBOLS[symbol];
  if (!pgSym) return [];
  const timespanMap: Record<string, { multiplier: number; timespan: string }> = {
    "1m": { multiplier: 1, timespan: "minute" },
    "5m": { multiplier: 5, timespan: "minute" },
    "15m": { multiplier: 15, timespan: "minute" },
    "30m": { multiplier: 30, timespan: "minute" },
    "1h": { multiplier: 1, timespan: "hour" },
    "4h": { multiplier: 4, timespan: "hour" },
    "1d": { multiplier: 1, timespan: "day" },
    "1w": { multiplier: 1, timespan: "week" },
  };
  const ts = timespanMap[interval] || timespanMap["15m"];
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(pgSym)}/range/${ts.multiplier}/${ts.timespan}/${startDate}/${endDate}?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`;
  try {
    const res = await fetch(url);
    if (res.status === 429) {
      console.warn(`[backtest] Polygon 429 rate limited for ${symbol}, backing off 3s`);
      await new Promise(r => setTimeout(r, 3000));
      const retryRes = await fetch(url);
      if (!retryRes.ok) return [];
      const retryData = await retryRes.json();
      if (!Array.isArray(retryData?.results)) return [];
      return retryData.results.map((bar: any) => ({
        datetime: new Date(bar.t).toISOString(),
        open: Number(bar.o), high: Number(bar.h), low: Number(bar.l), close: Number(bar.c),
        volume: bar.v != null ? Number(bar.v) : undefined,
      })).filter((c: Candle) =>
        Number.isFinite(c.open) && Number.isFinite(c.high) &&
        Number.isFinite(c.low) && Number.isFinite(c.close)
      );
    }
    if (!res.ok) {
      console.warn(`[backtest] Polygon ${res.status} for ${symbol} ${interval}`);
      return [];
    }
    const data = await res.json();
    if (data?.status === "ERROR" || !Array.isArray(data?.results)) {
      if (data?.error) console.warn(`[backtest] Polygon: ${data.error}`);
      return [];
    }
    return data.results.map((bar: any) => ({
      datetime: new Date(bar.t).toISOString(),
      open: Number(bar.o), high: Number(bar.h), low: Number(bar.l), close: Number(bar.c),
      volume: bar.v != null ? Number(bar.v) : undefined,
    })).filter((c: Candle) =>
      Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low) && Number.isFinite(c.close)
    );
  } catch (e: any) {
    console.warn(`[backtest] Polygon fetch error: ${e?.message}`);
    return [];
  }
}

// Main backtest candle fetcher: tries TwelveData date-range first, Polygon.io fallback
async function fetchHistoricalCandles(
  symbol: string, interval: string, range: string,
  startDate?: string, endDate?: string,
): Promise<Candle[]> {
  // Compute lookback buffer for analysis window
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

    // Try TwelveData first
    const tdCandles = await fetchTwelveDataRange(symbol, interval, bufferedStart, endDate);
    if (tdCandles.length >= 30) {
      console.log(`[backtest] ${symbol} ${interval}: ${tdCandles.length} candles from TwelveData (${bufferedStart} → ${endDate})`);
      return tdCandles;
    }

    // Fallback: Polygon.io with date range
    const pgCandles = await fetchPolygonRange(symbol, interval, bufferedStart, endDate);
    if (pgCandles.length >= 30) {
      console.log(`[backtest] ${symbol} ${interval}: ${pgCandles.length} candles from Polygon (${bufferedStart} → ${endDate})`);
      return pgCandles;
    }
  } else {
    // No date range — compute from range string
    const rangeMs: Record<string, number> = {
      "3mo": 90 * 86400000, "6mo": 180 * 86400000, "1y": 365 * 86400000, "2y": 730 * 86400000,
    };
    const ms = rangeMs[range] || 90 * 86400000;
    const endD = new Date().toISOString().slice(0, 10);
    const startD = new Date(Date.now() - ms).toISOString().slice(0, 10);
    const bufferedStart = computeBufferedStart(startD);

    const pgCandles = await fetchPolygonRange(symbol, interval, bufferedStart, endD);
    if (pgCandles.length >= 30) {
      console.log(`[backtest] ${symbol} ${interval}: ${pgCandles.length} candles from Polygon (${bufferedStart} → ${endD})`);
      return pgCandles;
    }
  }

  // Last resort: use the shared fetcher with a large limit
  try {
    const result = await fetchCandlesWithFallback({ symbol, interval, limit: 5000 });
    console.log(`[backtest] ${symbol} ${interval}: ${result.candles.length} candles from shared fetcher (${result.source})`);
    return result.candles;
  } catch (e: any) {
    console.warn(`[backtest] All sources failed for ${symbol} ${interval}: ${e?.message}`);
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
    // Auto-scale legacy 0-10 values to percentage when normalizedScoring is true
    minConfluence: (() => {
      const raw_mc = strategy.confluenceThreshold ?? strategy.minConfluenceScore ?? raw?.minConfluence ?? DEFAULTS.minConfluence;
      if (raw_mc > 0 && raw_mc <= 10 && (strategy.normalizedScoring ?? raw?.normalizedScoring ?? true)) {
        return raw_mc * 10;
      }
      return raw_mc;
    })(),
    // Legacy minFactorCount and minStrongFactors removed — single percentage threshold only
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
    // Session filter: use shared normalizeSessionFilter for consistent parsing + migration.
    enabledSessions: (
      Array.isArray(sessions.filter)
        ? normalizeSessionFilter(sessions.filter)
        : Array.isArray(raw?.enabledSessions)
          ? normalizeSessionFilter(raw.enabledSessions)
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
    newsFilterEnabled: false, // Disabled in backtest — no live news feed
    // --- P0: Factor toggles (mirror scanner loadConfig) ---
    useVolumeProfile: strategy.useVolumeProfile ?? raw?.useVolumeProfile ?? DEFAULTS.useVolumeProfile,
    useTrendDirection: strategy.useTrendDirection ?? raw?.useTrendDirection ?? DEFAULTS.useTrendDirection,
    useDailyBias: strategy.useDailyBias ?? raw?.useDailyBias ?? DEFAULTS.useDailyBias,
    useAMD: strategy.useAMD ?? raw?.useAMD ?? DEFAULTS.useAMD,
    useFOTSI: strategy.useFOTSI ?? raw?.useFOTSI ?? DEFAULTS.useFOTSI,
    // --- P0: Regime scoring (mirror scanner loadConfig) ---
    regimeScoringEnabled: strategy.regimeScoringEnabled ?? raw?.regimeScoringEnabled ?? DEFAULTS.regimeScoringEnabled,
    regimeScoringStrength: strategy.regimeScoringStrength ?? raw?.regimeScoringStrength ?? DEFAULTS.regimeScoringStrength,
    // --- P1: Advanced tuning (mirror scanner loadConfig) ---
    obLookbackCandles: strategy.obLookbackCandles ?? raw?.obLookbackCandles ?? DEFAULTS.obLookbackCandles,
    fvgMinSizePips: strategy.fvgMinSizePips ?? raw?.fvgMinSizePips ?? DEFAULTS.fvgMinSizePips,
    fvgOnlyUnfilled: strategy.fvgOnlyUnfilled ?? raw?.fvgOnlyUnfilled ?? DEFAULTS.fvgOnlyUnfilled,
    structureLookback: strategy.structureLookback ?? raw?.structureLookback ?? DEFAULTS.structureLookback,
    liquidityPoolMinTouches: strategy.liquidityPoolMinTouches ?? raw?.liquidityPoolMinTouches ?? DEFAULTS.liquidityPoolMinTouches,
    _currentSymbol: "",
    _smtResult: null as any,
  };
}

// ─── Confluence Analysis (mirrors runFullConfluenceAnalysis from bot-scanner) ─────
// 20-factor, 9-group scoring engine with anti-double-count rules, Power of 3 combo,
// and group caps. Accepts a timestamp so time-dependent factors (session, silver bullet,
// macro, AMD) are evaluated at the candle's time, not "now".
//
// GROUP 1: Market Structure (cap 2.5)  — BOS/CHoCH + Trend (merged, 2.5)
// GROUP 2: Daily Bias (cap 1.0)        — Daily Bias/HTF (1.0)
// GROUP 3: Order Flow Zones (cap 3.0)  — OB (2.0) + FVG (2.0) + Breaker (1.0) + Unicorn (1.5)
// GROUP 4: P/D & Fib (cap 2.5)        — P/D+Fib (2.0) + PD/PW Levels (1.0)
// GROUP 5: Timing (cap 1.5)           — Kill Zone (1.0) + Silver Bullet (1.0) + Macro (0.5)
// GROUP 6: Price Action (cap 2.5)     — Judas (0.5) + Reversal (1.5) + Sweep (1.0) + Displacement (1.0)

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
  peakBalance?: number,
  spreadPips = 0,
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

  // Gate 4: Min RR check (spread-adjusted)
  let rrOk = true;
  if (analysis.stopLoss && analysis.takeProfit) {
    const risk = Math.abs(analysis.lastPrice - analysis.stopLoss);
    const rawReward = Math.abs(analysis.takeProfit - analysis.lastPrice);
    const pairSpec = SPECS[symbol] || SPECS["EUR/USD"];
    const effectiveSpread = spreadPips > 0 ? spreadPips : (pairSpec.typicalSpread ?? 1);
    const spreadCostInPrice = effectiveSpread * pairSpec.pipSize;
    const effectiveReward = Math.max(0, rawReward - spreadCostInPrice);
    const rawRR = risk > 0 ? rawReward / risk : 0;
    const effectiveRR = risk > 0 ? effectiveReward / risk : 0;
    rrOk = effectiveRR >= config.minRiskReward;
    gates.push({ passed: rrOk, reason: `RR: ${effectiveRR.toFixed(2)} effective (${rawRR.toFixed(2)} raw, spread ${pairSpec.typicalSpread}p) min: ${config.minRiskReward}` });
  } else {
    gates.push({ passed: false, reason: "No SL/TP calculated" });
  }

  // Gate 5: Max drawdown (circuit breaker)
  if (peakBalance && peakBalance > 0 && config.maxDrawdown > 0) {
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

  // Gate 17: HTF Bias Alignment (migrated from old inline confluence gate)
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
  if (config.onlyBuyInDiscount && direction === "long" && analysis.pd?.currentZone === "premium") {
    gates.push({ passed: false, reason: "Buying in premium zone rejected" });
  } else if (config.onlySellInPremium && direction === "short" && analysis.pd?.currentZone === "discount") {
    gates.push({ passed: false, reason: "Selling in discount zone rejected" });
  } else {
    gates.push({ passed: true, reason: "P/D zone OK" });
  }
  // Gate 19: FOTSI Overbought/Oversold Veto
  const fotsiResult = (config as any)._fotsiResult as FOTSIResult | null;
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
  commissionPerLot = 0,
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
    // This mirrors live behavior: BE fires intra-candle before SL check
    if (pos.exitFlags.breakEven && pos.exitFlags.breakEvenPips > 0) {
      // Use candle high/low to check if BE activation was reached at any point
      const bestPips = pos.direction === "long"
        ? (candle.high - pos.entryPrice) / spec.pipSize
        : (pos.entryPrice - candle.low) / spec.pipSize;
      if (bestPips >= pos.exitFlags.breakEvenPips) {
        const newSL = pos.direction === "long"
          ? pos.entryPrice + 1 * spec.pipSize  // entry + 1 pip
          : pos.entryPrice - 1 * spec.pipSize; // entry - 1 pip
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
        // Trail from the best price the candle reached
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
    // ONE-SHOT: if trade is underwater (rMultiple < 0 but > -0.8) and structure
    // has broken against the trade direction (CHoCH), tighten SL by 50%.
    if (config.structureInvalidationEnabled !== false && !pos.structureInvalidationFired && allCandles && barIndex >= 20) {
      const riskDist = Math.abs(pos.entryPrice - pos.stopLoss);
      const priceDiff = pos.direction === "long"
        ? candle.close - pos.entryPrice
        : pos.entryPrice - candle.close;
      const rMultiple = riskDist > 0 ? priceDiff / riskDist : 0;

      if (rMultiple < 0 && rMultiple > -0.8) {
        // Use last 50 candles (or available) for structure analysis
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
            // Tighten SL 50% closer to current price (one-shot)
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
      // Both SL and TP hit on same candle — disambiguate using proximity to open
      // Whichever level is closer to the open price was likely hit first
      const slDist = Math.abs(candle.open - sl);
      const tpDist = Math.abs(candle.open - tp);
      if (slDist <= tpDist) {
        // SL was closer to open → SL hit first
        closeReason = "sl_hit";
        const gapPrice = pos.direction === "long" ? Math.min(sl, candle.low) : Math.max(sl, candle.high);
        exitPrice = pos.direction === "long"
          ? gapPrice - slippagePips * spec.pipSize
          : gapPrice + slippagePips * spec.pipSize;
      } else {
        // TP was closer to open → TP hit first
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
        // Round-trip commission: lots × commissionPerLot × 2 (entry + exit)
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
          factors: pos.factors,
          gatesBlocked: [],
        });
        pos.size = remainSize;
        pos.partialTPFired = true;
      }
    }

    if (closeReason) {
      const { pnl: rawPnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, exitPrice, pos.size, pos.symbol, btRateMap);
      // Round-trip commission: lots × commissionPerLot × 2 (entry + exit)
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
  const totalCommission = trades.reduce((s, t) => s + (t.commission || 0), 0);
  const netPnl = totalPnl; // pnl already includes commission deduction

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
    netPnl,
  };
}

// ─── Supabase Admin Client (for persisting results) ─────────────────
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
async function runBacktestJob(runId: string, body: any) {
  const db = getAdminClient();
  const updateProgress = async (progress: number, message: string) => {
    await db.from("backtest_runs").update({
      progress,
      progress_message: message,
      status: "running",
    }).eq("id", runId).then(() => {});
  };

  try {
    await db.from("backtest_runs").update({
      status: "running",
      started_at: new Date().toISOString(),
      progress: 5,
      progress_message: "Parsing configuration...",
    }).eq("id", runId);

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
    } = body;

    const config = mapConfig(rawConfig || {});
    if (tradingStyle && STYLE_OVERRIDES[tradingStyle]) {
      const userMinConf = config.minConfluence;
      Object.assign(config, STYLE_OVERRIDES[tradingStyle]);
      config.minConfluence = userMinConf;
    }

    console.log(`[backtest:${runId}] Starting: ${instruments.length} instruments, ${startDate} → ${endDate}, balance: $${startingBalance}`);

    // ── Fetch Historical Data ──
    await updateProgress(10, `Fetching candles for ${instruments.length} instruments...`);
    // Determine range based on date span
    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();
    const monthsSpan = Math.max(1, (endMs - startMs) / (30 * 24 * 3600 * 1000));
    const range = monthsSpan > 12 ? "2y" : monthsSpan > 6 ? "1y" : monthsSpan > 3 ? "6mo" : "3mo";

    // Fetch entry TF and daily candles for each instrument
    // Map entryTimeframe to TwelveData/Polygon interval format
    // bot-config uses "15m", STYLE_OVERRIDES uses "15min", "5m", "1h"
    const tfMap: Record<string, string> = {
      "1m": "1m", "5m": "5m", "15m": "15m", "15min": "15m",
      "30m": "30m", "30min": "30m", "1h": "1h", "4h": "4h",
    };
    const entryInterval = tfMap[config.entryTimeframe] || "15m";
    const candleData: Record<string, { entry: Candle[]; daily: Candle[]; smt?: Candle[] }> = {};

    // Diagnostic counters (declared early because pre-loop also references them)
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
      // ── Actionable advice fields ──
      highestScoreSeen: 0,           // Best confluence score across ALL scored candles
      enabledFactorCount: 0,         // How many factors are enabled in config
      totalFactorCount: Object.keys(DEFAULT_FACTOR_WEIGHTS).length,
      scoreDistribution: { below20: 0, below40: 0, below60: 0, below80: 0, above80: 0 },
    };

    // Compute enabledFactorCount from config toggles
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

    for (const symbol of instruments) {
      if (!SUPPORTED_SYMBOLS[symbol]) { diagnostics.skippedUnsupportedSymbol++; continue; }
      const [entryCandles, dailyCandles] = await Promise.all([
        fetchHistoricalCandles(symbol, entryInterval, range, startDate, endDate),
        fetchHistoricalCandles(symbol, "1d", "2y", startDate, endDate),
      ]);
      console.log(`[backtest] ${symbol}: ${entryCandles.length} entry candles, ${dailyCandles.length} daily candles`);
      // Fetch SMT correlated pair
      const smtPair = SMT_PAIRS[symbol];
      let smtCandles: Candle[] | undefined;
      if (smtPair && SUPPORTED_SYMBOLS[smtPair] && config.useSMT) {
        smtCandles = await fetchHistoricalCandles(smtPair, entryInterval, range, startDate, endDate);
      }
      candleData[symbol] = { entry: entryCandles, daily: dailyCandles, smt: smtCandles };
      // Rate limit
      await new Promise(r => setTimeout(r, 300));
    }

    // ── Fetch FOTSI Daily Candles + build per-day snapshot timeline ──
    await updateProgress(30, "Building FOTSI currency strength timeline...");
    // Avoids lookahead bias: each historical bar uses FOTSI computed from
    // daily candles up to (and including) that date only.
    const fotsiTimeline = new Map<string, FOTSIResult>();
    let fotsiCandleMap: Record<string, Candle[]> = {};
    try {
      const { getFOTSIPairNames } = await import("../_shared/fotsi.ts");
      const fotsiPairs = getFOTSIPairNames();
      for (let i = 0; i < fotsiPairs.length; i += 7) {
        const batch = fotsiPairs.slice(i, i + 7);
        const results = await Promise.all(
          batch.map(p => fetchHistoricalCandles(p, "1d", "2y", startDate, endDate).catch(() => [] as Candle[]))
        );
        for (let j = 0; j < batch.length; j++) {
          if (results[j] && results[j].length >= 30) fotsiCandleMap[batch[j]] = results[j];
        }
        if (i + 7 < fotsiPairs.length) await new Promise(r => setTimeout(r, 300));
      }
      if (Object.keys(fotsiCandleMap).length >= 20) {
        // Collect every unique daily date across all pairs in backtest range
        const allDates = new Set<string>();
        for (const candles of Object.values(fotsiCandleMap)) {
          for (const c of candles) {
            const d = c.datetime.slice(0, 10);
            if (d >= startDate && d <= endDate) allDates.add(d);
          }
        }
        const sortedDates = [...allDates].sort();
        for (const date of sortedDates) {
          const snapshot: Record<string, Candle[]> = {};
          for (const [pair, candles] of Object.entries(fotsiCandleMap)) {
            const upTo = candles.filter(c => c.datetime.slice(0, 10) <= date);
            if (upTo.length >= 30) snapshot[pair] = upTo;
          }
          if (Object.keys(snapshot).length >= 20) {
            try { fotsiTimeline.set(date, computeFOTSI(snapshot)); } catch {}
          }
        }
        console.log(`[backtest] FOTSI timeline built: ${fotsiTimeline.size} daily snapshots from ${Object.keys(fotsiCandleMap).length}/28 pairs`);
      }
    } catch (e: any) {
      console.warn(`[backtest] FOTSI computation error: ${e?.message}`);
    }

    await updateProgress(50, "FOTSI timeline built. Building time-varying rate map...");
    // ── Build time-varying btRateTimeline for cross-pair lot sizing & PnL conversion ──
    // Instead of a single static snapshot, build a sorted array of daily rate snapshots
    // so that each trade uses the exchange rate at its entry/exit date.
    const RATE_PAIRS = ["USD/JPY", "GBP/USD", "AUD/USD", "NZD/USD", "USD/CAD", "USD/CHF"];

    // Collect daily candles for each rate pair
    const ratePairCandles: Record<string, Candle[]> = {};
    for (const rp of RATE_PAIRS) {
      const rpCandles = candleData[rp]?.daily || (fotsiCandleMap as any)?.[rp];
      if (rpCandles && rpCandles.length > 0) ratePairCandles[rp] = rpCandles;
    }
    // Fetch any missing rate pairs
    const missingRatePairs = RATE_PAIRS.filter(p => !ratePairCandles[p]);
    if (missingRatePairs.length > 0) {
      try {
        const fetched = await Promise.all(
          missingRatePairs.map(p => fetchHistoricalCandles(p, "1d", "2y", startDate, endDate).catch(() => [] as Candle[]))
        );
        for (let i = 0; i < missingRatePairs.length; i++) {
          if (fetched[i].length > 0) ratePairCandles[missingRatePairs[i]] = fetched[i];
        }
      } catch {}
    }

    // Build sorted timeline: array of { date, rates } sorted by date
    const rateDates = new Set<string>();
    for (const candles of Object.values(ratePairCandles)) {
      for (const c of candles) rateDates.add(c.datetime.slice(0, 10));
    }
    const sortedRateDates = [...rateDates].sort();

    // For each date, carry forward the last known rate for each pair
    const btRateTimeline: { date: string; rates: Record<string, number> }[] = [];
    const lastKnown: Record<string, number> = {};
    for (const date of sortedRateDates) {
      for (const [pair, candles] of Object.entries(ratePairCandles)) {
        // Find the latest candle on or before this date
        for (const c of candles) {
          if (c.datetime.slice(0, 10) <= date) lastKnown[pair] = c.close;
        }
      }
      btRateTimeline.push({ date, rates: { ...lastKnown } });
    }

    // Fallback static map (last snapshot) for positions that fall outside the timeline
    const btRateMap: Record<string, number> = btRateTimeline.length > 0
      ? { ...btRateTimeline[btRateTimeline.length - 1].rates }
      : {};

    // Lookup function: binary search for the closest date <= target
    function getRateMapForDate(dateStr: string): Record<string, number> {
      if (btRateTimeline.length === 0) return btRateMap;
      const target = dateStr.slice(0, 10);
      let lo = 0, hi = btRateTimeline.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (btRateTimeline[mid].date <= target) lo = mid;
        else hi = mid - 1;
      }
      return btRateTimeline[lo].date <= target ? btRateTimeline[lo].rates : btRateMap;
    }

    console.log(`[backtest] rateTimeline: ${btRateTimeline.length} daily snapshots, ${Object.keys(btRateMap).length} pairs, fallback: ${JSON.stringify(btRateMap)}`);
    // Legacy btRateMap is kept as the fallback for any code paths that don't pass a date

    await updateProgress(55, "Running backtest simulation...");
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
    // Dynamically set based on entry timeframe to match bot-scanner's scan interval
    const entryTF = config.entryTimeframe || "15m";
    const tfMinutes: Record<string, number> = { "1m": 1, "5m": 5, "15m": 15, "15min": 15, "30m": 30, "30min": 30, "1h": 60, "4h": 240, "1d": 1440 };
    const candleMinutes = tfMinutes[entryTF] || 15;
    const scanIntervalMinutes = config.scanIntervalMinutes || 15;
    const STEP = Math.max(1, Math.round(scanIntervalMinutes / candleMinutes));

    for (const symbol of instruments) {
      const data = candleData[symbol];
      if (!data || data.entry.length < LOOKBACK) {
        console.log(`[backtest] Skipping ${symbol}: insufficient data (${data?.entry.length || 0} candles)`);
        diagnostics.skippedInsufficientData++;
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
        diagnostics.totalCandlesFetched++;

        // ── Process exits on every candle for open positions on this symbol ──
        const symbolPositions = openPositions.filter(p => p.symbol === symbol);
        if (symbolPositions.length > 0) {
          // Process exits on intermediate candles too
          for (let j = Math.max(startIdx, i - STEP + 1); j <= i; j++) {
            const exitCandle = entryCandles[j];
            const { closedTrades, updatedPositions } = processExits(
              openPositions.filter(p => p.symbol === symbol),
              exitCandle, j, config, slippagePips, getRateMapForDate(exitCandle.datetime), commissionPerLot, entryCandles,
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

        // Weekend gap detection — skip FX/index weekend candles (matches bot-scanner behavior)
        const candleDate = new Date(candleMs);
        const dow = candleDate.getUTCDay();
        const isFX = SPECS[symbol]?.type !== "crypto";
        if (isFX && (dow === 0 || dow === 6)) { diagnostics.skippedWeekend++; continue; }

        // Session/day filter — uses shared sessions module
        const session = detectSession(candleMs);
        const assetProfile = getAssetProfile(symbol);
        if (!assetProfile.skipSessionGate && !isSessionEnabled(session, config.enabledSessions)) { diagnostics.skippedSession++; continue; }

        // Day of week filter (user-configured active days)
        if (!config.enabledDays.includes(dow) && isFX) { diagnostics.skippedDay++; continue; }
        diagnostics.totalCandlesEvaluated++;

        // Set per-instrument config
        config._currentSymbol = symbol;
        // SMT: align correlated-pair window to current candle time (no lookahead)
        let smtAligned: Candle[] | null = null;
        if (smtCandles && smtCandles.length >= 30) {
          const smtUpToNow = smtCandles.filter(c => c.datetime <= candleTime);
          if (smtUpToNow.length >= 30) {
            smtAligned = smtUpToNow.slice(Math.max(0, smtUpToNow.length - window.length));
          }
        }
        config._smtResult = smtAligned ? detectSMTDivergence(symbol, window, smtAligned) : null;
        // FOTSI: look up snapshot for this candle's date (no lookahead)
        const candleDateStr = candleTime.slice(0, 10);
        let fotsiForBar: FOTSIResult | null = fotsiTimeline.get(candleDateStr) ?? null;
        if (!fotsiForBar && fotsiTimeline.size > 0) {
          // Fall back to most recent prior snapshot (weekend / missing day)
          const priorDates = [...fotsiTimeline.keys()].filter(d => d <= candleDateStr).sort();
          if (priorDates.length > 0) fotsiForBar = fotsiTimeline.get(priorDates[priorDates.length - 1]) ?? null;
        }
        (config as any)._fotsiResult = fotsiForBar;

        const analysis = runConfluenceAnalysis(window, dailyWindow.length >= 10 ? dailyWindow : null, config, undefined, candleMs);

        // ── Track score diagnostics (even for rejected candles) ──
        if (analysis.direction) {
          if (analysis.score > diagnostics.highestScoreSeen) diagnostics.highestScoreSeen = analysis.score;
          if (analysis.score < 20) diagnostics.scoreDistribution.below20++;
          else if (analysis.score < 40) diagnostics.scoreDistribution.below40++;
          else if (analysis.score < 60) diagnostics.scoreDistribution.below60++;
          else if (analysis.score < 80) diagnostics.scoreDistribution.below80++;
          else diagnostics.scoreDistribution.above80++;
        }

        // Single percentage threshold gate (minFactorCount and minStrongFactors collapsed)
        if (!analysis.direction) { diagnostics.skippedNoDirection++; continue; }
        if (analysis.score < config.minConfluence) { diagnostics.skippedBelowThreshold++; continue; }
        diagnostics.signalsGenerated++;

        // ── Safety Gates ──
        const gates = runBacktestSafetyGates(
          symbol, analysis.direction, analysis, config,
          balance, openPositions, dailyWindow.length >= 10 ? dailyWindow : null, allTrades, candleMs,
          peakBalance, spreadPips,
        );
        const blockedGates = gates.filter(g => !g.passed);
        const allPassed = blockedGates.length === 0;

        // Track gate analytics
        for (const g of blockedGates) {
          const gName = g.reason.split(":")[0].trim();
          if (!gateBreakdown[gName]) gateBreakdown[gName] = { blocked: 0, wouldHaveWon: 0, wouldHaveLost: 0 };
          gateBreakdown[gName].blocked++;
        }

        if (!allPassed) { diagnostics.skippedGateBlocked++; continue; }
        if (!analysis.stopLoss || !analysis.takeProfit) { diagnostics.skippedNoSLTP++; continue; }
        diagnostics.tradesOpened++;

        // ── Close on Reverse (apply spread cost to exit, mirrors entry) ──
        if (config.closeOnReverse) {
          const oppositeDir = analysis.direction === "long" ? "short" : "long";
          const toClose = openPositions.filter(p => p.symbol === symbol && p.direction === oppositeDir);
          for (const pos of toClose) {
            const posSpec = SPECS[pos.symbol] || SPECS["EUR/USD"];
            const reverseEffectiveSpread = spreadPips > 0 ? spreadPips : (posSpec.typicalSpread ?? 1);
            const reverseSpread = reverseEffectiveSpread * posSpec.pipSize;
            // Closing a long pays the bid (lower); closing a short pays the ask (higher)
            const reverseExitPrice = pos.direction === "long"
              ? analysis.lastPrice - reverseSpread / 2
              : analysis.lastPrice + reverseSpread / 2;
            const { pnl: rawPnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, reverseExitPrice, pos.size, pos.symbol, getRateMapForDate(candleTime));
            const revComm = pos.size * commissionPerLot * 2;
            const pnl = rawPnl - revComm;
            balance += pnl;
            if (balance > peakBalance) peakBalance = balance;
            allTrades.push({
              id: pos.id,
              symbol: pos.symbol,
              direction: pos.direction,
              entryPrice: pos.entryPrice,
              exitPrice: reverseExitPrice,
              entryTime: pos.entryTime,
              exitTime: candleTime,
              size: pos.size,
              pnl,
              pnlPips,
              commission: revComm,
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

        // ── Spread cost simulation (per-instrument from SPECS, user override if > 0) ──
        const effectiveSpreadPips = spreadPips > 0 ? spreadPips : (spec.typicalSpread ?? 1);
        const spreadCost = effectiveSpreadPips * spec.pipSize;
        const entryPrice = analysis.direction === "long"
          ? analysis.lastPrice + spreadCost / 2
          : analysis.lastPrice - spreadCost / 2;

        // ── Position Sizing ── (H1: supports percent_risk, fixed_lot, volatility_adjusted)
        const size = calculatePositionSize(balance, config.riskPerTrade, entryPrice, sl, symbol, {
          positionSizingMethod: config.positionSizingMethod,
          fixedLotSize: config.fixedLotSize,
          atrValue: (analysis as any).atrValue ?? calculateATR(entryCandles.slice(Math.max(0, entryCandles.length - 100)), config.slATRPeriod || 14),
          atrVolatilityMultiplier: config.atrVolatilityMultiplier,
        }, getRateMapForDate(candleTime));

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
          structureInvalidationFired: false,
        });
      }
    }

    await updateProgress(85, `Closing remaining positions... (${allTrades.length} trades so far)`);
    // ── Close any remaining open positions at last candle ──
    for (const pos of openPositions) {
      const data = candleData[pos.symbol];
      if (!data || data.entry.length === 0) continue;
      const lastCandle = data.entry[data.entry.length - 1];
      const { pnl: rawPnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, lastCandle.close, pos.size, pos.symbol, getRateMapForDate(lastCandle.datetime));
      const endComm = pos.size * commissionPerLot * 2;
      const pnl = rawPnl - endComm;
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
        commission: endComm,
        closeReason: "backtest_end",
        confluenceScore: pos.confluenceScore,
        factors: pos.factors,
        gatesBlocked: [],
      });
      equityCurve.push({ date: lastCandle.datetime, equity: balance });
    }

    // ── Calculate Stats ──
    const stats = calculateStats(allTrades, startingBalance, monthsSpan);

    await updateProgress(90, "Calculating statistics...");

    console.log(`[backtest:${runId}] Complete: ${allTrades.length} trades, PnL: $${stats.totalPnl.toFixed(2)}, WR: ${stats.winRate.toFixed(1)}%, PF: ${stats.profitFactor.toFixed(2)}, MaxDD: ${stats.maxDrawdownPct.toFixed(1)}%`);
    console.log(`[backtest:${runId}] Diagnostics: ${JSON.stringify(diagnostics)}`);

    // Build data coverage metadata
    const dataCoverage: Record<string, { entryCandles: number; dailyCandles: number; dateRange: string }> = {};
    for (const symbol of instruments) {
      const data = candleData[symbol];
      if (data) {
        const firstDate = data.entry[0]?.datetime?.slice(0, 10) || "?";
        const lastDate = data.entry[data.entry.length - 1]?.datetime?.slice(0, 10) || "?";
        dataCoverage[symbol] = {
          entryCandles: data.entry.length,
          dailyCandles: data.daily.length,
          dateRange: `${firstDate} to ${lastDate}`,
        };
      }
    }

    // ── Walk-Forward Validation ──
    // Split trades into N equal-time folds and calculate per-fold stats
    // to validate strategy consistency across different time periods.
    let walkForward: any = null;
    const numFolds = Math.max(0, Math.min(20, Math.floor(walkForwardFolds)));
    if (numFolds >= 2 && allTrades.length >= numFolds * 2) {
      const foldDurationMs = (endMs - startMs) / numFolds;
      const folds: {
        fold: number; startDate: string; endDate: string;
        trades: number; wins: number; losses: number; winRate: number;
        totalPnl: number; profitFactor: number; maxDrawdownPct: number;
        sharpeRatio: number; avgRR: number;
      }[] = [];

      for (let f = 0; f < numFolds; f++) {
        const foldStart = new Date(startMs + f * foldDurationMs).toISOString().slice(0, 10);
        const foldEnd = new Date(startMs + (f + 1) * foldDurationMs).toISOString().slice(0, 10);
        const foldTrades = allTrades.filter(t => t.exitTime.slice(0, 10) >= foldStart && t.exitTime.slice(0, 10) < foldEnd);

        if (foldTrades.length === 0) {
          folds.push({
            fold: f + 1, startDate: foldStart, endDate: foldEnd,
            trades: 0, wins: 0, losses: 0, winRate: 0,
            totalPnl: 0, profitFactor: 0, maxDrawdownPct: 0,
            sharpeRatio: 0, avgRR: 0,
          });
          continue;
        }

        const foldMonths = Math.max(1, foldDurationMs / (30 * 24 * 3600 * 1000));
        const foldStats = calculateStats(foldTrades, startingBalance, foldMonths);
        folds.push({
          fold: f + 1, startDate: foldStart, endDate: foldEnd,
          trades: foldStats.totalTrades,
          wins: foldStats.wins,
          losses: foldStats.losses,
          winRate: foldStats.winRate,
          totalPnl: foldStats.totalPnl,
          profitFactor: foldStats.profitFactor,
          maxDrawdownPct: foldStats.maxDrawdownPct,
          sharpeRatio: foldStats.sharpeRatio,
          avgRR: foldStats.avgRR,
        });
      }

      // Aggregate walk-forward metrics
      const profitableFolds = folds.filter(f => f.totalPnl > 0).length;
      const consistencyScore = profitableFolds / Math.max(1, folds.filter(f => f.trades > 0).length);
      const activeFolds = folds.filter(f => f.trades > 0);
      const winRates = activeFolds.map(f => f.winRate);
      const winRateStdDev = winRates.length >= 2
        ? Math.sqrt(winRates.reduce((s, w) => s + Math.pow(w - (winRates.reduce((a, b) => a + b, 0) / winRates.length), 2), 0) / winRates.length)
        : 0;
      const bestFold = activeFolds.reduce((best, f) => f.totalPnl > best.totalPnl ? f : best, activeFolds[0]);
      const worstFold = activeFolds.reduce((worst, f) => f.totalPnl < worst.totalPnl ? f : worst, activeFolds[0]);

      walkForward = {
        folds,
        summary: {
          totalFolds: numFolds,
          activeFolds: activeFolds.length,
          profitableFolds,
          consistencyScore: Math.round(consistencyScore * 100),  // percentage
          winRateStdDev: Math.round(winRateStdDev * 10) / 10,
          bestFold: bestFold ? { fold: bestFold.fold, pnl: bestFold.totalPnl, winRate: bestFold.winRate } : null,
          worstFold: worstFold ? { fold: worstFold.fold, pnl: worstFold.totalPnl, winRate: worstFold.winRate } : null,
          verdict: consistencyScore >= 0.75 ? "robust" : consistencyScore >= 0.5 ? "moderate" : "fragile",
        },
      };
      console.log(`[backtest:${runId}] Walk-forward: ${numFolds} folds, consistency ${walkForward.summary.consistencyScore}%, verdict: ${walkForward.summary.verdict}`);
    }

    const resultPayload = {
      trades: allTrades,
      equityCurve,
      stats,
      factorBreakdown,
      gateBreakdown,
      dataCoverage,
      diagnostics,
      ...(walkForward ? { walkForward } : {}),
      config: {
        minConfluence: config.minConfluence,
        enabledSessions: config.enabledSessions,
        enabledDays: config.enabledDays,
        entryTimeframe: config.entryTimeframe,
        scanIntervalMinutes: config.scanIntervalMinutes,
      },
    };

    await db.from("backtest_runs").update({
      status: "completed",
      progress: 100,
      progress_message: `Done — ${allTrades.length} trades`,
      results: resultPayload,
      completed_at: new Date().toISOString(),
    }).eq("id", runId);

    console.log(`[backtest:${runId}] Results persisted to backtest_runs`);
  } catch (error: any) {
    console.error(`[backtest:${runId}] Error: ${error?.message}`, error?.stack);
    const db = getAdminClient();
    await db.from("backtest_runs").update({
      status: "failed",
      progress: 0,
      progress_message: "Failed",
      error_message: error?.message || "Backtest failed",
      completed_at: new Date().toISOString(),
    }).eq("id", runId).then(() => {});
  }
}

// ─── Main Handler (action-based routing) ────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "start";
    const db = getAdminClient();

    // ── Auth: extract user ID from JWT ──
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const authHeader = req.headers.get("Authorization");
    let userId: string | null = null;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.replace("Bearer ", "");
      if (token !== Deno.env.get("SUPABASE_ANON_KEY")) {
        const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
          global: { headers: { Authorization: authHeader } },
        });
        const { data, error } = await userClient.auth.getUser(token);
        if (!error && data?.user?.id) {
          userId = data.user.id;
        }
      }
    }

    // ── Action: start — kick off a new backtest in the background ──
    if (action === "start") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);

      // Insert a pending run
      const { data: run, error: insertErr } = await db.from("backtest_runs").insert({
        user_id: userId,
        status: "pending",
        progress: 0,
        progress_message: "Queued...",
        config: body,
      }).select("id").single();

      if (insertErr || !run) {
        console.error("[backtest] Failed to create run:", insertErr);
        return respond({ error: "Failed to create backtest run" }, 500);
      }

      const runId = run.id;
      console.log(`[backtest] Created run ${runId} for user ${userId}`);

      // Fire and forget — the heavy work runs in the background
      const jobPromise = runBacktestJob(runId, body).catch((e) => {
        console.error(`[backtest:${runId}] background error`, e);
      });
      // @ts-ignore - EdgeRuntime is available in Supabase edge runtime
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(jobPromise);
      }

      return respond({ runId, status: "pending", message: "Backtest started in background" });
    }

    // ── Action: status — poll a specific run ──
    if (action === "status") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const runId = body.runId;
      if (!runId) return respond({ error: "runId required" }, 400);

      const { data: run, error: fetchErr } = await db.from("backtest_runs")
        .select("id, status, progress, progress_message, results, error_message, created_at, started_at, completed_at")
        .eq("id", runId)
        .eq("user_id", userId)
        .single();

      if (fetchErr || !run) return respond({ error: "Run not found" }, 404);
      return respond(run);
    }

    // ── Action: list — recent runs for the user ──
    if (action === "list") {
      if (!userId) return respond({ error: "Unauthorized" }, 401);
      const limit = body.limit || 10;

      const { data: runs, error: listErr } = await db.from("backtest_runs")
        .select("id, status, progress, progress_message, error_message, created_at, started_at, completed_at, config")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (listErr) return respond({ error: "Failed to list runs" }, 500);
      return respond(runs || []);
    }

    return respond({ error: "Unknown action. Use: start, status, list" }, 400);
  } catch (error: any) {
    console.error(`[backtest] Handler error: ${error?.message}`, error?.stack);
    return respond({ error: error?.message || "Backtest failed" }, 500);
  }
});
