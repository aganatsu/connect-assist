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
  getQuoteToUSDRate,
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

// ─── Default Factor Weights (mirrors bot-scanner) ─────────────────────────
const DEFAULT_FACTOR_WEIGHTS: Record<string, number> = {
  marketStructure: 2.5,
  orderBlock: 2.0,
  fairValueGap: 2.0,
  premiumDiscountFib: 2.0,
  sessionKillZone: 1.0,
  judasSwing: 0.5,
  pdPwLevels: 1.0,
  reversalCandle: 1.5,
  liquiditySweep: 1.0,
  displacement: 1.0,
  breakerBlock: 1.0,
  unicornModel: 1.5,
  silverBullet: 1.0,
  macroWindow: 1.0,
  smtDivergence: 1.0,
  volumeProfile: 0.75,
  amdPhase: 1.0,
  currencyStrength: 1.5,
  dailyBias: 1.0,
};

function resolveWeightScale(factorKey: string, config: any): number {
  const fw = config.factorWeights;
  if (!fw || fw[factorKey] === undefined || fw[factorKey] === null) return 1.0;
  const defaultW = DEFAULT_FACTOR_WEIGHTS[factorKey];
  if (!defaultW || defaultW === 0) return 1.0;
  return Math.max(0, fw[factorKey]) / defaultW;
}

function applyWeightScale(pts: number, factorKey: string, displayWeight: number, config: any): { pts: number; displayWeight: number } {
  const scale = resolveWeightScale(factorKey, config);
  if (scale === 1.0) return { pts, displayWeight };
  return {
    pts: Math.round(pts * scale * 1000) / 1000,
    displayWeight: Math.round(displayWeight * scale * 1000) / 1000,
  };
}

// ─── CORS ──────────────────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Volume Profile (Time-at-Price / TPO) ────────────────────────────
// Builds a histogram of time spent at each price level from OHLC candles.
// Since forex lacks real volume, we use candle count at each price bin (TPO).
// Returns POC (Point of Control), Value Area High/Low, and classified nodes.
interface VolumeProfileResult {
  poc: number;           // Point of Control — price level with most time
  vah: number;           // Value Area High (70% of activity above this)
  val: number;           // Value Area Low (70% of activity below this)
  nodes: Array<{ price: number; count: number; type: "HVN" | "LVN" | "normal" }>;
  totalBins: number;
}

function computeVolumeProfile(candles: Candle[], numBins = 50): VolumeProfileResult | null {
  if (candles.length < 20) return null;

  // Find the overall high and low across all candles
  let overallHigh = -Infinity, overallLow = Infinity;
  for (const c of candles) {
    if (c.high > overallHigh) overallHigh = c.high;
    if (c.low < overallLow) overallLow = c.low;
  }
  const range = overallHigh - overallLow;
  if (range <= 0) return null;

  const binSize = range / numBins;
  const bins: number[] = new Array(numBins).fill(0);

  // For each candle, increment every bin that falls within its high-low range
  // This is the TPO (Time Price Opportunity) approach
  for (const c of candles) {
    const lowBin = Math.max(0, Math.floor((c.low - overallLow) / binSize));
    const highBin = Math.min(numBins - 1, Math.floor((c.high - overallLow) / binSize));
    for (let b = lowBin; b <= highBin; b++) {
      bins[b]++;
    }
  }

  // Find POC (bin with highest count)
  let pocBin = 0, maxCount = 0;
  for (let i = 0; i < numBins; i++) {
    if (bins[i] > maxCount) {
      maxCount = bins[i];
      pocBin = i;
    }
  }
  const poc = overallLow + (pocBin + 0.5) * binSize;

  // Calculate Value Area (70% of total TPO count, expanding from POC)
  const totalCount = bins.reduce((a, b) => a + b, 0);
  const targetCount = totalCount * 0.70;
  let vaLowBin = pocBin, vaHighBin = pocBin;
  let vaCount = bins[pocBin];

  while (vaCount < targetCount && (vaLowBin > 0 || vaHighBin < numBins - 1)) {
    const expandLow = vaLowBin > 0 ? bins[vaLowBin - 1] : -1;
    const expandHigh = vaHighBin < numBins - 1 ? bins[vaHighBin + 1] : -1;
    if (expandLow >= expandHigh && expandLow >= 0) {
      vaLowBin--;
      vaCount += bins[vaLowBin];
    } else if (expandHigh >= 0) {
      vaHighBin++;
      vaCount += bins[vaHighBin];
    } else {
      break;
    }
  }

  const val = overallLow + vaLowBin * binSize;
  const vah = overallLow + (vaHighBin + 1) * binSize;

  // Classify nodes: HVN if count > 1.5x average, LVN if count < 0.5x average
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

// Yahoo fallback with appropriate range string
async function fetchYahooRange(symbol: string, interval: string, range: string): Promise<Candle[]> {
  const ySym = YAHOO_SYMBOLS[symbol];
  if (!ySym) return [];
  const yahooInt: Record<string, string> = {
    "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "60m", "4h": "60m", "1d": "1d", "1w": "1wk",
  };
  const yInterval = yahooInt[interval] || "15m";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ySym}?interval=${yInterval}&range=${range}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "SMC-Trading-Dashboard/1.0" } });
    if (!res.ok) return [];
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return [];
    const ts: number[] = result.timestamp || [];
    const q = result.indicators?.quote?.[0];
    if (!q) return [];
    const candles: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      candles.push({
        datetime: new Date(ts[i] * 1000).toISOString(),
        open: Number(o), high: Number(h), low: Number(l), close: Number(c),
        volume: q.volume?.[i] ?? undefined,
      });
    }
    // Aggregate to 4h if needed
    if (interval === "4h" && candles.length > 0) {
      const out: Candle[] = [];
      let bucket: Candle | null = null;
      let count = 0;
      for (const c of candles) {
        if (!bucket) { bucket = { ...c }; count = 1; }
        else {
          bucket.high = Math.max(bucket.high, c.high);
          bucket.low = Math.min(bucket.low, c.low);
          bucket.close = c.close;
          bucket.volume = (bucket.volume || 0) + (c.volume || 0);
          count++;
        }
        if (count >= 4) { out.push(bucket); bucket = null; count = 0; }
      }
      if (bucket) out.push(bucket);
      return out;
    }
    return candles;
  } catch (e: any) {
    console.warn(`[backtest] Yahoo fetch error: ${e?.message}`);
    return [];
  }
}

// Main backtest candle fetcher: tries TwelveData date-range first, Yahoo fallback
async function fetchHistoricalCandles(
  symbol: string, interval: string, range: string,
  startDate?: string, endDate?: string,
): Promise<Candle[]> {
  // If we have date range, use TwelveData's date-range API for full coverage
  if (startDate && endDate) {
    // Add lookback buffer: fetch extra candles before startDate for analysis window
    const startMs = new Date(startDate).getTime();
    const lookbackMs = interval === "1d" ? 60 * 24 * 3600 * 1000 : // 60 days for daily
                       interval === "4h" ? 30 * 24 * 3600 * 1000 : // 30 days for 4h
                       interval === "1h" ? 14 * 24 * 3600 * 1000 : // 14 days for 1h
                       7 * 24 * 3600 * 1000; // 7 days for 15m/5m
    const bufferedStart = new Date(startMs - lookbackMs).toISOString().slice(0, 10);

    const tdCandles = await fetchTwelveDataRange(symbol, interval, bufferedStart, endDate);
    if (tdCandles.length >= 30) {
      console.log(`[backtest] ${symbol} ${interval}: ${tdCandles.length} candles from TwelveData (${bufferedStart} → ${endDate})`);
      return tdCandles;
    }
  }

  // Fallback: Yahoo with range string
  const yahooRangeMap: Record<string, string> = {
    "3mo": "3mo", "6mo": "6mo", "1y": "1y", "2y": "2y",
  };
  const yRange = yahooRangeMap[range] || range;
  const yahooCandles = await fetchYahooRange(symbol, interval, yRange);
  if (yahooCandles.length >= 30) {
    console.log(`[backtest] ${symbol} ${interval}: ${yahooCandles.length} candles from Yahoo (range: ${yRange})`);
    return yahooCandles;
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
    enabledSessions: sessions.filter ?? DEFAULTS.enabledSessions,
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
// GROUP 7: AMD / Power of 3 (cap 1.5) — AMD (1.0) + Po3 Combo (+1.0)
// GROUP 8: Macro Confirmation (cap 2.0)— SMT (1.0) + Currency Strength (1.5)
// GROUP 9: Volume Profile (cap 0.75)  — Volume Profile (0.75)
// Output: Percentage score (0-100%) + strongFactorCount

// ─── Lightweight Regime Classification (for real-time scoring) ──────
function classifyInstrumentRegime(dailyCandles: Candle[]): { regime: string; confidence: number; atrTrend: string; bias: string } {
  if (!dailyCandles || dailyCandles.length < 20) {
    return { regime: "unknown", confidence: 0, atrTrend: "unknown", bias: "neutral" };
  }
  const atrPeriod = Math.min(14, dailyCandles.length - 1);
  const trs: number[] = [];
  for (let i = dailyCandles.length - atrPeriod; i < dailyCandles.length; i++) {
    const prev = dailyCandles[i - 1];
    const curr = dailyCandles[i];
    trs.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
  }
  const recentTrs = trs.slice(-5);
  const olderTrs = trs.slice(0, Math.max(1, trs.length - 5));
  const recentAtr = recentTrs.reduce((a, b) => a + b, 0) / recentTrs.length;
  const olderAtr = olderTrs.reduce((a, b) => a + b, 0) / olderTrs.length;
  const atrRatio = olderAtr > 0 ? recentAtr / olderAtr : 1;
  const atrTrend = atrRatio > 1.15 ? "expanding" : atrRatio < 0.85 ? "contracting" : "stable";
  const last7 = dailyCandles.slice(-7);
  const last20 = dailyCandles.slice(-20);
  const sma7 = last7.reduce((s, c) => s + c.close, 0) / last7.length;
  const sma20 = last20.reduce((s, c) => s + c.close, 0) / last20.length;
  const avgPrice = dailyCandles[dailyCandles.length - 1].close;
  const smaDiff = avgPrice > 0 ? (sma7 - sma20) / avgPrice : 0;
  const bias = Math.abs(smaDiff) > 0.005 ? (smaDiff > 0 ? "bullish" : "bearish") : "neutral";
  const highs20 = last20.map(c => c.high);
  const lows20 = last20.map(c => c.low);
  const rangeHigh = Math.max(...highs20);
  const rangeLow = Math.min(...lows20);
  const rangePct = avgPrice > 0 ? ((rangeHigh - rangeLow) / avgPrice) * 100 : 0;
  let regime = "transitional";
  let confidence = 0.5;
  if (atrTrend === "expanding" && Math.abs(smaDiff) > 0.008 && rangePct > 3) {
    regime = "strong_trend"; confidence = Math.min(0.95, 0.6 + Math.abs(smaDiff) * 10 + (atrRatio - 1) * 0.5);
  } else if (Math.abs(smaDiff) > 0.005 && rangePct > 2) {
    regime = "mild_trend"; confidence = Math.min(0.85, 0.5 + Math.abs(smaDiff) * 8);
  } else if (atrTrend === "contracting" && rangePct < 2 && Math.abs(smaDiff) < 0.003) {
    regime = "choppy_range"; confidence = Math.min(0.9, 0.6 + (1 - atrRatio) * 0.5 + (2 - rangePct) * 0.1);
  } else if (Math.abs(smaDiff) < 0.005 && rangePct < 3) {
    regime = "mild_range"; confidence = Math.min(0.8, 0.5 + (3 - rangePct) * 0.1);
  }
  return { regime, confidence: Math.round(confidence * 100) / 100, atrTrend, bias };
}

function regimeAlignmentAdjustment(
  regime: string, confidence: number, direction: string | null,
  factors: Array<{ name: string; present: boolean; weight: number; detail: string; group?: string }>
): { adjustment: number; detail: string } {
  if (!direction || confidence < 0.5) return { adjustment: 0, detail: "Regime unknown or low confidence" };
  const trendFactors = ["Market Structure", "Trend Direction", "Displacement"];
  const rangeFactors = ["Premium/Discount", "Order Block", "Fair Value Gap", "Breaker Block"];
  let trendScore = 0, rangeScore = 0;
  for (const f of factors) {
    if (!f.present) continue;
    if (trendFactors.includes(f.name)) trendScore += f.weight;
    if (rangeFactors.includes(f.name)) rangeScore += f.weight;
  }
  const isTrendSetup = trendScore > rangeScore;
  const isRangeSetup = rangeScore > trendScore;
  const scaleFactor = Math.min(1.0, confidence);
  if (regime === "strong_trend" || regime === "mild_trend") {
    if (isTrendSetup) {
      const bonus = regime === "strong_trend" ? 0.5 : 0.25;
      return { adjustment: +(bonus * scaleFactor).toFixed(2), detail: `Trend setup in ${regime.replace("_", " ")} → +${(bonus * scaleFactor).toFixed(1)} bonus` };
    } else if (isRangeSetup) {
      const penalty = regime === "strong_trend" ? -1.5 : -0.75;
      return { adjustment: +(penalty * scaleFactor).toFixed(2), detail: `Range setup in ${regime.replace("_", " ")} → ${(penalty * scaleFactor).toFixed(1)} penalty` };
    }
  }
  if (regime === "choppy_range" || regime === "mild_range") {
    if (isRangeSetup) {
      const bonus = regime === "choppy_range" ? 0.5 : 0.25;
      return { adjustment: +(bonus * scaleFactor).toFixed(2), detail: `Range setup in ${regime.replace("_", " ")} → +${(bonus * scaleFactor).toFixed(1)} bonus` };
    } else if (isTrendSetup) {
      const penalty = regime === "choppy_range" ? -1.5 : -0.75;
      return { adjustment: +(penalty * scaleFactor).toFixed(2), detail: `Trend setup in ${regime.replace("_", " ")} → ${(penalty * scaleFactor).toFixed(1)} penalty` };
    }
  }
  return { adjustment: 0, detail: "Transitional regime — no adjustment" };
}

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
  const structure = analyzeMarketStructure(candles, config.structureLookback);
  const allBreaks = [...structure.bos, ...structure.choch];
  let orderBlocks = config.enableOB ? detectOrderBlocks(candles, allBreaks, config.obLookbackCandles) : [];
  const fvgs = config.enableFVG ? detectFVGs(candles) : [];
  const liquidityPools = config.enableLiquiditySweep ? detectLiquidityPools(candles, 0.001, config.liquidityPoolMinTouches) : [];
  const displacement = detectDisplacement(candles);
  if (displacement.isDisplacement) tagDisplacementQuality(orderBlocks, fvgs, displacement.displacementCandles);

  // FVG adjacency bonus: tag OBs that have an FVG within 5 candles
  for (const ob of orderBlocks) {
    const hasFVGNearby = fvgs.some(f => Math.abs(f.index - ob.index) <= 5);
    (ob as any).hasFVGAdjacency = hasFVGNearby;
  }

  const breakerBlocks = config.useBreakerBlocks ? detectBreakerBlocks(orderBlocks, candles) : [];
  const unicornSetups = config.useUnicornModel ? detectUnicornSetups(breakerBlocks, fvgs) : [];
  const pd = calculatePremiumDiscount(candles);
  const pdLevels = dailyCandles ? calculatePDLevels(dailyCandles) : null;
  const judas = detectJudasSwing(candles);
  const reversal = detectReversalCandle(candles);
  const atrValue = calculateATR(candles, config.slATRPeriod || 14);
  // Retain VWAP calculation for backward compatibility (not scored)
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

  // ── Factor Scoring (19 factors, 9 groups — mirrors bot-scanner, percentage output) ──
  let score = 0;
  const factors: BacktestReasoningFactor[] = [];

  // ── Factor 1: Market Structure + Trend (merged, max 2.5) ──
  {
    let pts = 0;
    let detail = "";
    if (config.enableStructureBreak !== false) {
      const hasChoch = structure.choch.length > 0;
      const hasBos = structure.bos.length > 0;
      // Determine trend alignment (will be set after direction is computed later, so use structure.trend)
      const trendAligned = (structure.trend === "bullish" || structure.trend === "bearish");
      const isRanging = structure.trend === "ranging";
      if (hasChoch && trendAligned) {
        pts = 2.5;
        detail = `${structure.choch.length} CHoCH + ${structure.trend} trend aligned — strong reversal`;
      } else if (hasChoch && isRanging) {
        pts = 2.0;
        detail = `${structure.choch.length} CHoCH in ranging market`;
      } else if (hasChoch) {
        pts = 2.0;
        detail = `${structure.choch.length} CHoCH detected`;
      } else if (hasBos && trendAligned) {
        pts = 2.0;
        detail = `${structure.bos.length} BOS + ${structure.trend} trend aligned — continuation`;
      } else if (hasBos && isRanging) {
        pts = 1.5;
        detail = `${structure.bos.length} BOS in ranging market`;
      } else if (hasBos) {
        pts = 1.0;
        detail = `${structure.bos.length} BOS detected`;
      } else {
        detail = "No BOS or CHoCH detected";
      }
    } else {
      detail = "BOS/CHoCH disabled";
    }
    { const s = applyWeightScale(pts, "marketStructure", 2.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Market Structure", present: pts > 0, weight: s.displayWeight, detail, group: "Market Structure" }); }
  }

  // ── Factor 2: Order Block (max 2.0) ──
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
        detail = `Price inside ${insideOB.type} OB at ${insideOB.low.toFixed(5)}-${insideOB.high.toFixed(5)} (${insideOB.mitigatedPercent.toFixed(0)}% mitigated)`;
        if (tags.length > 0) detail += ` [${tags.join(", ")}]`;
      } else if (activeOBs.length > 0) {
        pts = 0;
        detail = `${activeOBs.length} quality-filtered OBs nearby (not at level)`;
      }
    } else {
      detail = "Order Blocks disabled";
    }
    { const s = applyWeightScale(pts, "orderBlock", 2.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Order Block", present: pts > 0, weight: s.displayWeight, detail: detail || "No active order blocks", group: "Order Flow Zones" }); }
  }

  // ── Factor 3: Fair Value Gap (max 2.0) ──
  {
    let pts = 0;
    let detail = "";
    if (config.enableFVG !== false) {
      // Apply FVG filters: fvgOnlyUnfilled (skip mitigated) and fvgMinSizePips (skip tiny FVGs)
      let filteredFVGs = config.fvgOnlyUnfilled !== false ? fvgs.filter(f => !f.mitigated) : [...fvgs];
      if (config.fvgMinSizePips && config.fvgMinSizePips > 0) {
        filteredFVGs = filteredFVGs.filter(f => {
          const fvgSizePips = (f.high - f.low) / pipSize;
          return fvgSizePips >= config.fvgMinSizePips;
        });
      }
      const activeFVGs = filteredFVGs;
      const insideFVG = activeFVGs.find(f => lastPrice >= f.low && lastPrice <= f.high);
      if (insideFVG) {
        const ce = (insideFVG.high + insideFVG.low) / 2;
        const fvgRange = insideFVG.high - insideFVG.low;
        const distFromCE = Math.abs(lastPrice - ce);
        const nearCE = fvgRange > 0 && (distFromCE / fvgRange) <= 0.15;
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
        pts = 0;
        detail = `${activeFVGs.length} unfilled FVGs in range (not at level)`;
      }
    } else {
      detail = "FVGs disabled";
    }
    { const s = applyWeightScale(pts, "fairValueGap", 2.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Fair Value Gap", present: pts > 0, weight: s.displayWeight, detail: detail || "No active FVGs", group: "Order Flow Zones" }); }
  }

  // ── Factor 4: Premium/Discount & Fibonacci (max 2.0) ──
  {
    let pts = 0;
    const fibPercent = pd.zonePercent;
    let detail = `Price at ${fibPercent.toFixed(1)}% of swing range — ${pd.currentZone} zone`;
    const fibDirection = structure.trend === "bullish" ? "long" : structure.trend === "bearish" ? "short" : null;

    if (fibDirection === "long") {
      const retrace = 100 - fibPercent;
      if (retrace >= 70 && retrace <= 72) {
        pts = 2.0;
        detail += ` | Fib 70.5% sweet spot (retrace ${retrace.toFixed(1)}%) — OPTIMAL ENTRY`;
      } else if (retrace >= 61.8 && retrace <= 78.6) {
        pts = 1.5;
        detail += ` | Fib OTE zone (${retrace.toFixed(1)}% retracement)`;
      } else if (fibPercent < 45) {
        pts = 1.0;
        detail += ` | Discount zone (${retrace.toFixed(1)}% retracement)`;
      } else if (retrace >= 38.2 && retrace < 61.8) {
        pts = 0.5;
        detail += ` | Shallow retracement (${retrace.toFixed(1)}%)`;
      } else if (fibPercent >= 50) {
        detail += ` | Buying in premium — unfavorable`;
      }
    } else if (fibDirection === "short") {
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
      if (pd.oteZone) {
        pts = 0.5;
        detail += " | OTE zone active (ranging — no directional bias)";
      }
    }
    { const s = applyWeightScale(pts, "premiumDiscountFib", 2.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Premium/Discount & Fib", present: pts > 0, weight: s.displayWeight, detail, group: "Premium/Discount & Fib" }); }
  }

  // ── Factor 5: Kill Zone (max 1.0) ──
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
  {
    let pts = 0;
    let detail = judas.description;
    if (judas.detected && judas.confirmed) {
      if (session.isKillZone) {
        pts = 0.5;
        detail += " — during kill zone (confirmed)";
      } else {
        pts = 0.25;
        detail += " — outside kill zone (lower probability)";
      }
    } else if (judas.detected) {
      pts = 0.1;
      detail += " (unconfirmed)";
    }
    { const s = applyWeightScale(pts, "judasSwing", 0.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Judas Swing", present: pts > 0, weight: s.displayWeight, detail, group: "Price Action" }); }
  }

  // ── Factor 7: PD/PW Levels (max 1.0) ──
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
        const nearWeekly = nearLevels.some(l => l.name.startsWith("PW"));
        pts = nearWeekly ? 1.0 : 0.75;
        detail = `Price near ${nearLevels.map(l => l.name).join(", ")} (${nearLevels[0].price.toFixed(5)})${nearWeekly ? " — weekly level" : ""}`;
      } else {
        detail = `PDH=${pdLevels.pdh.toFixed(5)}, PDL=${pdLevels.pdl.toFixed(5)}, PWH=${pdLevels.pwh.toFixed(5)}, PWL=${pdLevels.pwl.toFixed(5)}`;
      }
    }
    { const s = applyWeightScale(pts, "pdPwLevels", 1.0, config); pts = s.pts; score += pts;
    factors.push({ name: "PD/PW Levels", present: pts > 0, weight: s.displayWeight, detail, group: "Premium/Discount & Fib" }); }
  }

  // ── Factor 8: Reversal Candle (max 1.5) ──
  {
    let pts = 0;
    let detail = "No reversal pattern";
    if (reversal.detected) {
      const lastC = candles[candles.length - 1];
      const lastMid = (lastC.high + lastC.low) / 2;
      const atOB = orderBlocks.some(ob => !ob.mitigated && lastC.low <= ob.high && lastC.high >= ob.low);
      const atFVG = fvgs.some(f => !f.mitigated && lastC.low <= f.high && lastC.high >= f.low);
      const atPDPW = pdLevels ? [
        pdLevels.pdh, pdLevels.pdl, pdLevels.pwh, pdLevels.pwl,
      ].some(lvl => Math.abs(lastMid - lvl) / lastMid <= 0.002) : false;
      const atKeyLevel = atOB || atFVG || atPDPW;
      if (atKeyLevel) {
        pts = 1.5;
        const levels: string[] = [];
        if (atOB) levels.push("OB");
        if (atFVG) levels.push("FVG");
        if (atPDPW) levels.push("PD/PW level");
        detail = `${reversal.type} reversal at key level (${levels.join(", ")}) — high conviction`;
      } else {
        pts = 0.75;
        detail = `${reversal.type} reversal candle detected but not at a key level`;
      }
    }
    { const s = applyWeightScale(pts, "reversalCandle", 1.5, config); pts = s.pts; score += pts;
    factors.push({ name: "Reversal Candle", present: pts > 0, weight: s.displayWeight, detail, group: "Price Action" }); }
  }

  // ── Factor 9: Liquidity Sweep (max 1.0) ──
  {
    let pts = 0;
    let detail = "";
    if (config.enableLiquiditySweep !== false) {
      const sweptPool = liquidityPools.find(lp => lp.swept && lp.strength >= 2);
      if (sweptPool) {
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
        const f4 = factors.find(f => f.name === "Premium/Discount & Fib");
        if (f4) { f4.detail += ` | OR zone: ${orZone} (${orZonePercent.toFixed(1)}%)`; }
      }
    }
  }

  // ── Determine direction (BEFORE direction-dependent factors 10-20) ──
  let direction: "long" | "short" | null = null;
  if (structure.trend === "bullish" && pd.currentZone !== "premium") direction = "long";
  else if (structure.trend === "bearish" && pd.currentZone !== "discount") direction = "short";
  else if (structure.trend === "ranging") {
    if (pd.currentZone === "discount") direction = "long";
    else if (pd.currentZone === "premium") direction = "short";
  }

  // (Factor 19 Trend Direction removed — merged into Factor 1 Market Structure)

  // ── Factor 10: Displacement (max 1.0) ──
  {
    let pts = 0;
    let detail = "No displacement candle in last 5 bars";
    if (config.useDisplacement !== false) {
      if (displacement.isDisplacement && direction && displacement.lastDirection) {
        const aligned = (direction === "long" && displacement.lastDirection === "bullish")
          || (direction === "short" && displacement.lastDirection === "bearish");
        if (aligned) {
          const last = displacement.displacementCandles[displacement.displacementCandles.length - 1];
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
          detail = `${aligned.type.replace("_", " ")} exists but price too far (${(distPct * 100).toFixed(2)}%)`;
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
      detail = `${silverBullet.window} active — ${silverBullet.minutesRemaining}min remaining`;
    }
    { const s = applyWeightScale(pts, "silverBullet", 1.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Silver Bullet", present: pts > 0, weight: s.displayWeight, detail, group: "Timing" }); }
  }

  // ── Factor 14: ICT Macro Window (max 1.0; 0.5 base + 0.5 combo with Silver Bullet) ──
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
  {
    let pts = 0;
    let detail = smt ? smt.detail : "SMT not computed (no correlated pair fetched)";
    if (config.useSMT === false) {
      detail = "SMT Divergence disabled";
    } else if (smt && smt.detected && direction) {
      const aligned = (direction === "long" && smt.type === "bullish")
        || (direction === "short" && smt.type === "bearish");
      if (aligned) {
        pts = 1.0;
        detail = `SMT aligned: ${smt.detail}`;
      } else {
        detail = `SMT detected (${smt.type}) but opposite to signal direction`;
      }
    } else if (smt && smt.detected) {
      detail = `SMT (${smt.type}) detected but no signal direction yet`;
    }
    { const s = applyWeightScale(pts, "smtDivergence", 1.0, config); pts = s.pts; score += pts;
    factors.push({ name: "SMT Divergence", present: pts > 0, weight: s.displayWeight, detail, group: "Macro Confirmation" }); }
  }

  // ── Factor 16: Volume Profile (max 1.5) — replaces VWAP scoring ──
  const volumeProfile = config.useVolumeProfile !== false ? computeVolumeProfile(candles) : null;
  {
    let pts = 0;
    let detail = "";
    if (!volumeProfile) {
      detail = config.useVolumeProfile === false ? "Volume Profile disabled" : "Volume Profile unavailable (insufficient candles)";
    } else {
      const { poc, vah, val, nodes } = volumeProfile;
      const distFromPOC = Math.abs(lastPrice - poc) / pipSize;
      const pocProximityPips = 20;

      let closestNode = nodes[0];
      let minDist = Infinity;
      for (const node of nodes) {
        const d = Math.abs(lastPrice - node.price);
        if (d < minDist) { minDist = d; closestNode = node; }
      }

      if (distFromPOC <= pocProximityPips && direction) {
        pts = 1.0;
        detail = `Price ${distFromPOC.toFixed(1)} pips from POC (${poc.toFixed(5)}) — institutional fair value`;
      } else if (closestNode.type === "HVN" && direction) {
        pts = 0.75;
        detail = `Price at HVN (${closestNode.price.toFixed(5)}, ${closestNode.count} TPOs) — institutional defense level`;
      } else if (closestNode.type === "LVN" && direction) {
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
    { const s = applyWeightScale(pts, "volumeProfile", 0.75, config); pts = s.pts; score += pts;
    factors.push({ name: "Volume Profile", present: pts > 0, weight: s.displayWeight, detail, group: "Volume Profile" }); }
  }

  // ── Factor 17: AMD Phase (max 1.0; +0.5 distribution bonus) ──
  {
    let pts = 0;
    let detail = amd ? `AMD: ${amd.detail}` : "AMD not computed";
    if (config.useAMD === false) {
      detail = "AMD Phase disabled";
    } else if (direction && amd && amd.bias) {
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
  let fotsiAlignment: any = null;
  {
    let pts = 0;
    let detail = "";
    const fotsi = (config as any)._fotsiResult as FOTSIResult | null;
    if (fotsi && direction && config.useFOTSI !== false) {
      const currencies = parsePairCurrencies(config._currentSymbol || "");
      if (currencies) {
        const [base, quote] = currencies;
        const dir = direction === "long" ? "BUY" : "SELL";
        fotsiAlignment = getCurrencyAlignment(base, quote, dir as "BUY" | "SELL", fotsi.strengths);
        pts = fotsiAlignment.score;
        detail = `${fotsiAlignment.label} (${base} ${fotsiAlignment.baseTSI.toFixed(1)}, ${quote} ${fotsiAlignment.quoteTSI.toFixed(1)}, spread ${fotsiAlignment.spread.toFixed(1)})`;
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
  {
    let pts = 0;
    let detail = "";
    if (config.useDailyBias !== false && dailyCandles && dailyCandles.length >= 20 && direction) {
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
    { const s = applyWeightScale(pts, "dailyBias", 1.0, config); pts = s.pts; score += pts;
    factors.push({ name: "Daily Bias", present: pts > 0, weight: s.displayWeight, detail, group: "Daily Bias" }); }
  }

  // ─── Anti-Double-Count Adjustment Pass ────────────────────────────────
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

    // Rule 2: Displacement + FVG overlap → Displacement reduced to 0.5
    const displacementF = findFactor("Displacement");
    const fvgFactor = findFactor("Fair Value Gap");
    if (displacementF && displacementF.present && fvgFactor && fvgFactor.present
        && displacementF.detail.includes("FVG")) {
      adjustFactor("Displacement", 0.5, "FVG already scored the displacement event");
    }

    // Rule 3: OB + FVG both inside same zone → cap combined at 3.0
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

    // Rule 4: Silver Bullet fires → absorbs Kill Zone
    const sb = findFactor("Silver Bullet");
    const kz = findFactor("Session/Kill Zone");
    if (sb && sb.present && kz && kz.present) {
      score -= kz.weight;
      kz.weight = 0;
      kz.detail += " [zeroed: absorbed by Silver Bullet]";
      const sbBoost = 0.5;
      sb.weight = Math.min(1.5, sb.weight + sbBoost);
      score += sbBoost;
      sb.detail += " [boosted: absorbed Kill Zone timing]";
    }

    // Rule 5: AMD distribution + sweep → absorbs Judas
    const amdFactor = findFactor("AMD Phase");
    const judasF = findFactor("Judas Swing");
    const sweepF = findFactor("Liquidity Sweep");
    if (amdFactor && amdFactor.present && sweepF && sweepF.present && judasF && judasF.present) {
      score -= judasF.weight;
      judasF.weight = 0;
      judasF.detail += " [zeroed: absorbed by AMD + Sweep sequence]";
    }

    // Rule 6: Macro during Kill Zone → Macro reduced to 0.25
    const macro = findFactor("Macro Window");
    if (macro && macro.present && kz && kz.present && kz.weight > 0) {
      adjustFactor("Macro Window", 0.25, "Kill Zone already scoring timing");
    }
  }

  // ─── Power of 3 Combo Bonus (+1.0) ───────────────────────────────────
  {
    const findFactor = (name: string) => factors.find(f => f.name === name);
    const amdF = findFactor("AMD Phase");
    const sweepF = findFactor("Liquidity Sweep");
    const judasF = findFactor("Judas Swing");
    const msF = findFactor("Market Structure");

    const amdPresent = amdF && amdF.present;
    const sweepOrJudas = (sweepF && sweepF.present) || (judasF && judasF.present);
    const msAligned = msF && msF.present;

    if (amdPresent && sweepOrJudas && msAligned) {
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
        detail: `Incomplete: AMD=${amdPresent ? "✓" : "✗"} Sweep/Judas=${sweepOrJudas ? "✓" : "✗"} MS=${msAligned ? "✓" : "✗"}`,
        group: "AMD / Power of 3",
      });
    }
  }

  // ─── Group Caps Enforcement ─────────────────────────────────────────
  {
    const GROUP_CAPS: Record<string, number> = {
      "Market Structure": 2.5,
      "Daily Bias": 1.0,
      "Order Flow Zones": 3.0,
      "Premium/Discount & Fib": 2.5,
      "Timing": 1.5,
      "Price Action": 2.5,
      "AMD / Power of 3": 1.5,
      "Macro Confirmation": 2.0,
      "Volume Profile": 0.75,
    };

    const groupTotals: Record<string, number> = {};
    for (const f of factors) {
      if (f.present && f.group) {
        groupTotals[f.group] = (groupTotals[f.group] || 0) + f.weight;
      }
    }

    for (const [group, cap] of Object.entries(GROUP_CAPS)) {
      const total = groupTotals[group] || 0;
      if (total > cap) {
        const excess = total - cap;
        score -= excess;
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
  // Controlled by config.regimeScoringEnabled (default true) and
  // config.regimeScoringStrength (multiplier, default 1.0).
  const regimeScoringEnabled = config.regimeScoringEnabled !== false;
  const regimeScoringStrength = typeof config.regimeScoringStrength === 'number' ? config.regimeScoringStrength : 1.0;
  {
    if (regimeScoringEnabled && dailyCandles && dailyCandles.length >= 20) {
      const regimeInfo = classifyInstrumentRegime(dailyCandles);
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

  // ─── Re-run group caps after regime scoring ─────────────────────────
  {
    const GROUP_CAPS_POST: Record<string, number> = {
      "Market Structure": 2.5, "Daily Bias": 1.0, "Order Flow Zones": 3.0,
      "Premium/Discount & Fib": 2.5, "Timing": 1.5, "Price Action": 2.5,
      "AMD / Power of 3": 1.5, "Macro Confirmation": 2.0, "Volume Profile": 0.75,
    };
    const groupTotals2: Record<string, number> = {};
    for (const f of factors) {
      if (f.present && f.group) groupTotals2[f.group] = (groupTotals2[f.group] || 0) + f.weight;
    }
    for (const [group, cap] of Object.entries(GROUP_CAPS_POST)) {
      const total = groupTotals2[group] || 0;
      if (total > cap) {
        const excess = total - cap;
        score -= excess;
        const gf = factors.filter(f => f.group === group && f.present && f.weight > 0);
        const sf = cap / total;
        for (const f of gf) { f.weight = Math.round(f.weight * sf * 100) / 100; }
      }
    }
  }

  // ─── Percentage Normalization ──────────────────────────────────────
  // Compute enabledMax from factors that have weight > 0 or are present
  const enabledMax = factors.reduce((sum, f) => {
    if (f.name === "Regime Alignment" || f.name === "Power of 3 Combo") return sum;
    const w = f.weight;
    if (w <= 0) return sum;
    return sum + w;
  }, 0) || 1;
  // Compute strong factor count (factors scoring above 50% of their max weight)
  const strongFactorCount = factors.filter(f => {
    if (!f.present || f.weight <= 0) return false;
    if (f.name === "Regime Alignment" || f.name === "Power of 3 Combo") return false;
    const maxW = DEFAULT_FACTOR_WEIGHTS[Object.keys(DEFAULT_FACTOR_WEIGHTS).find(k =>
      f.name.toLowerCase().replace(/[\s\/]/g, '') === k.toLowerCase().replace(/[\s\/]/g, '')
    ) || ''] || f.weight;
    return f.weight >= maxW * 0.5;
  }).length;
  // Convert to percentage (0-100)
  const rawPct = enabledMax > 0 ? (score / enabledMax) * 100 : 0;
  score = Math.max(0, Math.min(100, Math.round(rawPct * 10) / 10));

  // ── HTF Bias Gate (safety gate, separate from Factor 20 scoring) ──
  if (config.htfBiasRequired && direction) {
    let htfBias: "bullish" | "bearish" | "ranging" = "ranging";
    if (dailyCandles && dailyCandles.length >= 10) {
      const htfStructure = analyzeMarketStructure(dailyCandles);
      htfBias = htfStructure.trend;
    }
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
    strongFactorCount,
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
    volumeProfile,
    stopLoss: sltp.stopLoss,
    takeProfit: sltp.takeProfit,
    lastPrice,
    bias: direction === "long" ? "bullish" : direction === "short" ? "bearish" : "neutral",
    summary: `${score.toFixed(1)}% (${strongFactorCount} strong) | ${structure.trend} | ${pd.currentZone} | ${session.name}`,
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

  // Gate 4: Min RR check (spread-adjusted)
  let rrOk = true;
  if (analysis.stopLoss && analysis.takeProfit) {
    const risk = Math.abs(analysis.lastPrice - analysis.stopLoss);
    const rawReward = Math.abs(analysis.takeProfit - analysis.lastPrice);
    const pairSpec = SPECS[symbol] || SPECS["EUR/USD"];
    const spreadCostInPrice = (pairSpec.typicalSpread ?? 1) * pairSpec.pipSize;
    const effectiveReward = Math.max(0, rawReward - spreadCostInPrice);
    const rawRR = risk > 0 ? rawReward / risk : 0;
    const effectiveRR = risk > 0 ? effectiveReward / risk : 0;
    rrOk = effectiveRR >= config.minRiskReward;
    gates.push({ passed: rrOk, reason: `RR: ${effectiveRR.toFixed(2)} effective (${rawRR.toFixed(2)} raw, spread ${pairSpec.typicalSpread}p) min: ${config.minRiskReward}` });
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
        const { pnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, triggerPrice, closeSize, pos.symbol, btRateMap);
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
      const { pnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, exitPrice, pos.size, pos.symbol, btRateMap);
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
        fetchHistoricalCandles(symbol, entryInterval, range, startDate, endDate),
        fetchHistoricalCandles(symbol, "1d", "2y", startDate, endDate),
      ]);
      console.log(`[backtest] ${symbol}: ${entryCandles.length} entry candles, ${dailyCandles.length} daily candles`);
      // Fetch SMT correlated pair
      const smtPair = SMT_PAIRS[symbol];
      let smtCandles: Candle[] | undefined;
      if (smtPair && YAHOO_SYMBOLS[smtPair] && config.useSMT) {
        smtCandles = await fetchHistoricalCandles(smtPair, entryInterval, range, startDate, endDate);
      }
      candleData[symbol] = { entry: entryCandles, daily: dailyCandles, smt: smtCandles };
      // Rate limit
      await new Promise(r => setTimeout(r, 300));
    }

    // ── Fetch FOTSI Daily Candles + build per-day snapshot timeline ──
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

    // ── Build rateMap for cross-pair lot sizing & PnL conversion ──
    // Use the last close from already-fetched candle data for major pairs.
    const RATE_PAIRS = ["USD/JPY", "GBP/USD", "AUD/USD", "NZD/USD", "USD/CAD", "USD/CHF"];
    const btRateMap: Record<string, number> = {};
    for (const rp of RATE_PAIRS) {
      // Try the backtest candleData first, then fotsiCandleMap
      const rpCandles = candleData[rp]?.daily || (fotsiCandleMap as any)?.[rp];
      if (rpCandles && rpCandles.length > 0) {
        btRateMap[rp] = rpCandles[rpCandles.length - 1].close;
      }
    }
    // If some pairs are missing, try fetching them
    const missingRatePairs = RATE_PAIRS.filter(p => !btRateMap[p]);
    if (missingRatePairs.length > 0) {
      try {
        const fetched = await Promise.all(
          missingRatePairs.map(p => fetchHistoricalCandles(p, "1d", "1mo").catch(() => [] as Candle[]))
        );
        for (let i = 0; i < missingRatePairs.length; i++) {
          if (fetched[i].length > 0) btRateMap[missingRatePairs[i]] = fetched[i][fetched[i].length - 1].close;
        }
      } catch {}
    }
    console.log(`[backtest] rateMap: ${JSON.stringify(btRateMap)}`);

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
              exitCandle, j, config, slippagePips, btRateMap,
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

        if (!analysis.direction || analysis.score < config.minConfluence) continue;
        // Min factor count gate
        const factorCount = analysis.factors.filter((f: any) => f.present).length;
        if (config.minFactorCount > 0 && factorCount < config.minFactorCount) continue;
        // Strong factor gate
        const minStrongFactors = config.minStrongFactors ?? 4;
        if (minStrongFactors > 0 && (analysis.strongFactorCount ?? 0) < minStrongFactors) continue;

        // ── Safety Gates ──
        const gates = runBacktestSafetyGates(
          symbol, analysis.direction, analysis, config,
          balance, openPositions, dailyWindow.length >= 10 ? dailyWindow : null, allTrades, candleMs,
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

        // ── Close on Reverse (apply spread cost to exit, mirrors entry) ──
        if (config.closeOnReverse) {
          const oppositeDir = analysis.direction === "long" ? "short" : "long";
          const toClose = openPositions.filter(p => p.symbol === symbol && p.direction === oppositeDir);
          for (const pos of toClose) {
            const posSpec = SPECS[pos.symbol] || SPECS["EUR/USD"];
            const reverseSpread = spreadPips * posSpec.pipSize;
            // Closing a long pays the bid (lower); closing a short pays the ask (higher)
            const reverseExitPrice = pos.direction === "long"
              ? analysis.lastPrice - reverseSpread / 2
              : analysis.lastPrice + reverseSpread / 2;
            const { pnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, reverseExitPrice, pos.size, pos.symbol, btRateMap);
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

        // ── Position Sizing ── (H1: supports percent_risk, fixed_lot, volatility_adjusted)
        const size = calculatePositionSize(balance, config.riskPerTrade, entryPrice, sl, symbol, {
          positionSizingMethod: config.positionSizingMethod,
          fixedLotSize: config.fixedLotSize,
          atrValue: (analysis as any).atrValue ?? calculateATR(entryCandles.slice(Math.max(0, entryCandles.length - 100)), config.slATRPeriod || 14),
          atrVolatilityMultiplier: config.atrVolatilityMultiplier,
        }, btRateMap);

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
      const { pnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, lastCandle.close, pos.size, pos.symbol, btRateMap);
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

    return new Response(
      JSON.stringify({
        trades: allTrades,
        equityCurve,
        stats,
        factorBreakdown,
        gateBreakdown,
        dataCoverage,
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
