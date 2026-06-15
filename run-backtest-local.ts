/**
 * Local Backtest Runner — FULL REPLICATION of live bot-scanner logic
 * ═══════════════════════════════════════════════════════════════════
 * Uses the EXACT same modules as the live bot:
 *   - runConfluenceAnalysis (22-factor scoring)
 *   - findUnifiedZone (story-driven: Impulse → Zone → Liquidity → Confirmation)
 *   - computeFOTSI (28-pair currency strength)
 *   - detectSMTDivergence (correlated pair divergence)
 *   - detectLiquidityPools (BSL/SSL detection on D/4H/1H)
 *   - determineDirection (H4 CHoCH + H1 BOS)
 *
 * Entry logic mirrors bot-scanner/index.ts lines 4540-5750:
 *   1. runConfluenceAnalysis → get score + direction
 *   2. findUnifiedZone → get story state (triggered/confirmed + entryReady)
 *   3. If unified gate passes → use unified entry SL/TP
 *   4. Else fall through to standalone impulse zone gate
 *   5. Safety gates (session, tier1, regime, minRR, SL floor)
 *   6. Position sizing + open trade
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env run-backtest-local.ts
 */

// ─── Imports from the shared modules (same as live bot) ──────────────
import {
  type Candle,
  type LiquidityPool,
  SPECS,
  MIN_SL_PIPS,
  ATR_SL_FLOOR_MULTIPLIER,
  SMT_PAIRS,
  getAssetProfile,
  analyzeMarketStructure,
  detectOrderBlocks,
  detectFVGs,
  detectBreakerBlocks,
  detectZigZagPivots,
  computeFibLevels,
  calculatePremiumDiscount,
  calculateATR,
  calcPnl,
  getQuoteToUSDRate,
  detectSwingPoints,
  detectSMTDivergence,
  detectLiquidityPools,
} from "./supabase/functions/_shared/smcAnalysis.ts";
import {
  runConfluenceAnalysis,
} from "./supabase/functions/_shared/confluenceScoring.ts";
import { mapNestedToFlat, RUNTIME_DEFAULTS } from "./supabase/functions/_shared/configMapper.ts";
import { determineDirection, determineDirectionStyleAware, STYLE_TF_LABELS, confirmedTrend as computeConfirmedTrend, type DirectionResult, type StyleDirectionResult } from "./supabase/functions/_shared/directionEngine.ts";
import {
  computeDirectionVerdict,
  type DirectionVerdictResult,
} from "./supabase/functions/_shared/directionVerdict.ts";
import {
  findBestEntryZoneMultiTF,
  type MultiTFZoneResult,
  type HTFConfluenceData,
} from "./supabase/functions/_shared/impulseZoneEngine.ts";
import {
  findUnifiedZone,
  type UnifiedZoneResult,
} from "./supabase/functions/_shared/unifiedZoneEngine.ts";
import {
  computeFOTSI,
  type FOTSIResult,
} from "./supabase/functions/_shared/fotsi.ts";
import {
  detectSession,
  isSessionEnabled,
} from "./supabase/functions/_shared/sessions.ts";
import {
  findCascadeZone,
  type CascadeResult,
} from "./supabase/functions/_shared/cascadeZoneEngine.ts";

// ─── Types ──────────────────────────────────────────────────────────
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
  currentSL: number;
  breakEvenFired: boolean;
  signalSource: "unified" | "standalone";
  unifiedScore: number;
}
interface ClosedTrade {
  id: string;
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  entryTime: string;
  exitTime: string;
  pnl: number;
  pnlPips: number;
  closeReason: string;
  confluenceScore: number;
  effectiveScore: number;
  size: number;
  signalSource: string;
  unifiedScore: number;
}

// ─── Load cached candle data ────────────────────────────────────────
function loadCandles(symbol: string, interval: string): Candle[] {
  const safeSymbol = symbol.replace("/", "_");
  const path = `./candle_cache/${safeSymbol}_${interval}.json`;
  try {
    const raw = Deno.readTextFileSync(path);
    return JSON.parse(raw) as Candle[];
  } catch {
    console.error(`Failed to load ${path}`);
    return [];
  }
}

// ─── Main Backtest ──────────────────────────────────────────────────
async function runBacktest() {
  // ── CLI args: --style=scalper|day_trader|swing_trader ──
  const styleArg = Deno.args.find(a => a.startsWith("--style="));
  const tradingStyle: "scalper" | "day_trader" | "swing_trader" = 
    (styleArg?.split("=")[1] as any) || "day_trader";

  const allInstruments = ["EUR/USD", "GBP/USD", "USD/JPY", "GBP/JPY", "AUD/USD", "USD/CAD", "XAU/USD"];
  // Scalper: only low-volatility majors (GBP/JPY/XAU too volatile for 5m zones)
  // 5m bars are very dense (~18k/month) — 3 months is the practical limit for local runs
  const scalpInstruments = ["EUR/USD", "GBP/USD"];
  const instruments = tradingStyle === "scalper" ? scalpInstruments : allInstruments;
  const startDate = tradingStyle === "scalper" ? "2026-01-01" : "2025-07-15";
  const endDate = "2026-04-01";
  const startingBalance = 10000;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  LOCAL BACKTEST: SMC Trading Bot (FULL LIVE REPLICATION)");
  console.log(`  Instruments: ${instruments.join(", ")}`);
  console.log(`  Period: ${startDate} → ${endDate}`);
  console.log(`  Starting Balance: $${startingBalance.toLocaleString()}`);
  console.log(`  Trading Style: ${tradingStyle}`);
  const entryTF = tradingStyle === "swing_trader" ? "1h" : tradingStyle === "scalper" ? "5min" : "15min";
  console.log(`  Entry TF: ${entryTF} | Unified Zone Engine + FOTSI + SMT`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Load config (default settings — matches live bot defaults)
  const config: any = mapNestedToFlat({});
  config.entryTimeframe = tradingStyle === "scalper" ? "5min" : tradingStyle === "swing_trader" ? "1h" : "15min";
  config.scanIntervalMinutes = 0;
  config.impulseZoneGateMode = "hard"; // Live bot default
  config.impulseZoneEnabled = true;
  config.useSimpleDirection = true;
  config.breakEvenEnabled = true;
  config.trailingStopEnabled = false; // No trailing — BE only
  config.maxOpenPositions = 5;
  config.maxPerSymbol = 2;
  config.marketFillAtZone = true;
  config.regimeScoringEnabled = true;
  config.useFOTSI = true;
  config.useDailyBias = true;

  // ── Style-specific parameter tuning ──
  if (tradingStyle === "scalper") {
    config.riskPerTrade = 0.5;           // Lower risk per trade (more frequent)
    config.minConfluence = 40;           // Higher threshold — only high-quality signals
    config.tpRatio = 2.0;               // 2:1 R:R (let winners run)
    config.breakEvenEnabled = false;    // No BE for scalper — let trades run to TP or SL
    config.fixedSlPips = 10;            // Fixed 10-pip SL (ATR floor may override to ~20)
    config.fixedTpPips = 20;            // Fixed 20-pip TP (or 2:1 from ATR-adjusted SL)
    config.impulseSlCapMultiplier = 1.5; // Backup SL cap if fixedSl not used
  } else if (tradingStyle === "swing_trader") {
    config.riskPerTrade = 1.5;           // Higher risk (fewer trades, higher conviction)
    config.minConfluence = 40;           // Lower threshold — weekly bias is restrictive enough
    config.tpRatio = 3.0;               // Wider R:R (hold for bigger moves)
    config.breakEvenEnabled = false;    // No BE for swing — let trades run to TP or SL
    config.impulseSlCapMultiplier = 6;  // Wider SL cap (larger impulses on 1H/4H)
  } else {
    // Day trader (default) — VALIDATED OPTIMAL
    config.riskPerTrade = 1;             // 1% risk per trade
    config.minConfluence = 50;
    config.tpRatio = 2.0;               // 2:1 R:R (validated)
    config.breakEvenEnabled = true;     // BE ON (validated — saves 60% of trades)
    config.breakEvenPips = 20;
    config.impulseSlCapMultiplier = 4;
  }
  console.log(`  Config: minConf=${config.minConfluence}, TP=${config.tpRatio}:1, BE=${config.breakEvenPips}pips, SLcap=${config.impulseSlCapMultiplier}x, risk=${config.riskPerTrade}%`);

  // Load all candle data
  console.log("📊 Loading cached candle data...\n");
  const candleData: Record<string, { m5: Candle[]; m15: Candle[]; h1: Candle[]; h4: Candle[]; daily: Candle[]; weekly: Candle[] }> = {};
  for (const symbol of instruments) {
    const m5 = tradingStyle === "scalper" ? loadCandles(symbol, "5min") : [];
    const m15 = loadCandles(symbol, "15min");
    const h1 = loadCandles(symbol, "1h");
    const h4 = loadCandles(symbol, "4h");
    const daily = loadCandles(symbol, "1day");
    const weekly = tradingStyle === "swing_trader" ? loadCandles(symbol, "1week") : [];
    candleData[symbol] = { m5, m15, h1, h4, daily, weekly };
    console.log(`  ${symbol}: ${m5.length} 5m, ${m15.length} 15m, ${h1.length} 1H, ${h4.length} 4H, ${daily.length} Daily, ${weekly.length} Weekly`);
  }

  // Load SMT correlated pair data (use entry TF for SMT)
  const smtTF = tradingStyle === "scalper" ? "5min" : tradingStyle === "swing_trader" ? "1h" : "15min";
  console.log(`\n📊 Loading SMT correlated pair data (${smtTF})...`);
  const smtData: Record<string, Candle[]> = {
    "GBP/USD": loadCandles("GBP/USD", smtTF),
    "XAG/USD": loadCandles("XAG/USD", smtTF),
  };
  console.log(`  GBP/USD (for EUR/USD SMT): ${smtData["GBP/USD"].length} candles`);
  console.log(`  XAG/USD (for XAU/USD SMT): ${smtData["XAG/USD"].length} candles`);

  // Load FOTSI pair data (all 28 pairs, 1H)
  console.log("\n📊 Loading FOTSI pair data (28 pairs, 1H)...");
  const FOTSI_PAIRS = [
    "EUR/USD", "EUR/GBP", "EUR/CHF", "EUR/JPY", "EUR/AUD", "EUR/CAD", "EUR/NZD",
    "GBP/USD", "GBP/CHF", "GBP/JPY", "GBP/AUD", "GBP/CAD", "GBP/NZD",
    "USD/CHF", "USD/JPY", "AUD/USD", "USD/CAD", "NZD/USD",
    "CHF/JPY", "AUD/CHF", "CAD/CHF", "NZD/CHF",
    "AUD/JPY", "CAD/JPY", "NZD/JPY",
    "AUD/CAD", "AUD/NZD", "NZD/CAD",
  ];
  const fotsiCandleMap: Record<string, Candle[]> = {};
  let fotsiLoadedCount = 0;
  for (const pair of FOTSI_PAIRS) {
    const candles = loadCandles(pair, "1h");
    if (candles.length >= 50) {
      fotsiCandleMap[pair] = candles;
      fotsiLoadedCount++;
    }
  }
  console.log(`  Loaded ${fotsiLoadedCount}/28 FOTSI pairs`);

  // ─── State ──────────────────────────────────────────────────────────
  let balance = startingBalance;
  let peakBalance = startingBalance;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let openPositions: OpenPosition[] = [];
  const allTrades: ClosedTrade[] = [];
  let tradeCounter = 0;

  // Diagnostics
  const diag = {
    totalBarsEvaluated: 0,
    signalsGenerated: 0,
    skippedNoDirection: 0,
    skippedNoZone: 0,
    skippedNotAtZone: 0,
    skippedBelowThreshold: 0,
    skippedGateBlocked: 0,
    skippedMaxPositions: 0,
    skippedSlSanity: 0,
    tradesOpened: 0,
    unifiedGatePasses: 0,
    standaloneGatePasses: 0,
    unifiedStates: {} as Record<string, number>,
    scoreDistribution: { below20: 0, below40: 0, below60: 0, below80: 0, above80: 0 },
    highestScoreSeen: 0,
    highestUnifiedScore: 0,
    gateBlockReasons: {} as Record<string, number>,
    smtDetected: 0,
  };

  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  const btRateMap: Record<string, number> = {
    "EUR/USD": 1.0, "GBP/USD": 1.27, "USD/JPY": 150, "GBP/JPY": 190,
    "AUD/USD": 0.65, "NZD/USD": 0.60, "USD/CAD": 1.36, "USD/CHF": 0.88,
    "XAU/USD": 1.0, "XAG/USD": 1.0, "BTC/USD": 1.0,
  };

  // Helper: binary search for relevant candles up to a timestamp (avoids O(n) filter per bar)
  function candleToMs(c: Candle): number {
    return new Date(c.datetime.endsWith("Z") ? c.datetime : c.datetime + "Z").getTime();
  }
  // Pre-compute timestamps for all candle arrays to avoid repeated parsing
  const tsCache = new WeakMap<Candle[], number[]>();
  function getCandleTimestamps(candles: Candle[]): number[] {
    let cached = tsCache.get(candles);
    if (!cached) {
      cached = candles.map(candleToMs);
      tsCache.set(candles, cached);
    }
    return cached;
  }
  function getRelevantCandles(candles: Candle[], upToMs: number, count: number): Candle[] {
    if (!candles || candles.length === 0) return [];
    const timestamps = getCandleTimestamps(candles);
    // Binary search for the last candle <= upToMs
    let lo = 0, hi = timestamps.length - 1;
    if (timestamps[0] > upToMs) return [];
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (timestamps[mid] <= upToMs) lo = mid;
      else hi = mid - 1;
    }
    // lo is now the index of the last candle <= upToMs
    const start = Math.max(0, lo - count + 1);
    return candles.slice(start, lo + 1);
  }

  // ─── Pre-compute FOTSI rolling snapshots (every 4H) ────────────────
  console.log("\n📊 Pre-computing FOTSI rolling snapshots...");
  const fotsiSnapshots: { timestamp: number; result: FOTSIResult }[] = [];
  const refPair = fotsiCandleMap["EUR/USD"];
  if (refPair && refPair.length > 50) {
    for (let i = 50; i < refPair.length; i += 4) {
      const windowEnd = i + 1;
      const windowStart = Math.max(0, windowEnd - 50);
      const windowMap: Record<string, Candle[]> = {};
      for (const [pair, candles] of Object.entries(fotsiCandleMap)) {
        if (candles.length >= windowEnd) {
          windowMap[pair] = candles.slice(windowStart, windowEnd);
        }
      }
      if (Object.keys(windowMap).length >= 20) {
        try {
          const result = computeFOTSI(windowMap);
          const ts = new Date(refPair[i].datetime.endsWith("Z") ? refPair[i].datetime : refPair[i].datetime + "Z").getTime();
          fotsiSnapshots.push({ timestamp: ts, result });
        } catch { /* skip bad window */ }
      }
    }
  }
  console.log(`  Computed ${fotsiSnapshots.length} FOTSI snapshots (every 4H)\n`);

  // Helper: get nearest FOTSI snapshot for a given timestamp
  function getNearestFOTSI(ts: number): FOTSIResult | null {
    if (fotsiSnapshots.length === 0) return null;
    let lo = 0, hi = fotsiSnapshots.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fotsiSnapshots[mid].timestamp <= ts) lo = mid;
      else hi = mid - 1;
    }
    if (fotsiSnapshots[lo].timestamp <= ts) return fotsiSnapshots[lo].result;
    return null;
  }

  // ─── Process each symbol ────────────────────────────────────────────
  for (const symbol of instruments) {
    // Style-aware entry candle selection
    const entryCandles = tradingStyle === "scalper"
      ? candleData[symbol].m5
      : tradingStyle === "swing_trader" 
        ? candleData[symbol].h1 
        : candleData[symbol].m15;
    const { m5, m15, h1, h4, daily, weekly } = candleData[symbol];
    const spec = SPECS[symbol] || SPECS["EUR/USD"];
    const profile = getAssetProfile(symbol);

    if (entryCandles.length < 200) {
      console.log(`  ⚠ ${symbol}: insufficient data (${entryCandles.length} bars), skipping`);
      continue;
    }

    // Find start index
    const startIdx = entryCandles.findIndex(c => {
      const cMs = new Date(c.datetime.endsWith("Z") ? c.datetime : c.datetime + "Z").getTime();
      return cMs >= startMs;
    });
    const effectiveStart = Math.max(startIdx, 200);
    const lookback = 100;

    console.log(`🔍 Processing ${symbol} (bars ${effectiveStart}→${entryCandles.length}, lookback=${lookback})...`);
    let symbolSignals = 0;
    let symbolTrades = 0;

    for (let i = effectiveStart; i < entryCandles.length; i++) {
      const candle = entryCandles[i];
      const candleMs = new Date(candle.datetime.endsWith("Z") ? candle.datetime : candle.datetime + "Z").getTime();
      if (candleMs > endMs) break;

      diag.totalBarsEvaluated++;

      // ── Position Management (SL/TP/BE check) ──
      for (let p = openPositions.length - 1; p >= 0; p--) {
        const pos = openPositions[p];
        if (pos.symbol !== symbol) continue;

        let closeReason = "";
        let exitPrice = 0;

        // Break-even check
        if (config.breakEvenEnabled && !pos.breakEvenFired) {
          const effectiveBePips = (pos.symbol === "XAU/USD" && config.breakEvenPipsXAU)
            ? config.breakEvenPipsXAU
            : config.breakEvenPips;
          const beDistance = effectiveBePips * spec.pipSize;
          if (pos.direction === "long" && candle.high >= pos.entryPrice + beDistance) {
            pos.currentSL = pos.entryPrice + 1 * spec.pipSize;
            pos.breakEvenFired = true;
          } else if (pos.direction === "short" && candle.low <= pos.entryPrice - beDistance) {
            pos.currentSL = pos.entryPrice - 1 * spec.pipSize;
            pos.breakEvenFired = true;
          }
        }

        // SL check
        if (pos.direction === "long" && candle.low <= pos.currentSL) {
          closeReason = pos.breakEvenFired ? "break_even" : "sl_hit";
          exitPrice = pos.currentSL;
        } else if (pos.direction === "short" && candle.high >= pos.currentSL) {
          closeReason = pos.breakEvenFired ? "break_even" : "sl_hit";
          exitPrice = pos.currentSL;
        }

        // TP check
        if (!closeReason) {
          if (pos.direction === "long" && candle.high >= pos.takeProfit) {
            closeReason = "tp_hit";
            exitPrice = pos.takeProfit;
          } else if (pos.direction === "short" && candle.low <= pos.takeProfit) {
            closeReason = "tp_hit";
            exitPrice = pos.takeProfit;
          }
        }

        if (closeReason) {
          const { pnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, exitPrice, pos.size, pos.symbol, btRateMap);
          balance += pnl;
          if (balance > peakBalance) peakBalance = balance;
          const dd = peakBalance - balance;
          const ddPct = peakBalance > 0 ? (dd / peakBalance) * 100 : 0;
          if (dd > maxDrawdown) maxDrawdown = dd;
          if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

          allTrades.push({
            id: pos.id, symbol: pos.symbol, direction: pos.direction,
            entryPrice: pos.entryPrice, exitPrice,
            entryTime: pos.entryTime, exitTime: candle.datetime,
            pnl, pnlPips, closeReason,
            confluenceScore: pos.confluenceScore,
            effectiveScore: pos.effectiveScore,
            size: pos.size,
            signalSource: pos.signalSource,
            unifiedScore: pos.unifiedScore,
          });
          openPositions.splice(p, 1);
          symbolTrades++;
        }
      }

      // ── Skip if already at max positions for this symbol ──
      const symbolPositions = openPositions.filter(p => p.symbol === symbol);
      if (symbolPositions.length >= config.maxPerSymbol) continue;
      if (openPositions.length >= config.maxOpenPositions) {
        diag.skippedMaxPositions++;
        continue;
      }

      // ── Build relevant candle windows ──
      const windowStart = Math.max(0, i - lookback);
      const analysisCandles = entryCandles.slice(windowStart, i + 1);
      if (analysisCandles.length < 50) continue;

      // Relevant HTF candles (up to current time) — using binary search for performance
      const relevantH4 = getRelevantCandles(h4, candleMs, 60);
      const relevantDaily = getRelevantCandles(daily, candleMs, 60);
      const relevantH1 = getRelevantCandles(h1, candleMs, 120);
      const relevantM15 = getRelevantCandles(m15, candleMs, 120);
      const relevantWeekly = getRelevantCandles(weekly, candleMs, 60);

      if (relevantH4.length < 20 || relevantDaily.length < 20) continue;

      // ── Direction Engine (style-aware) ──
      let directionResult: DirectionResult | null = null;
      if (config.useSimpleDirection) {
        try {
          if (tradingStyle === "day_trader") {
            // Day trader: Daily → 4H → 1H (original behavior)
            directionResult = determineDirection(
              relevantDaily.length >= 20 ? relevantDaily : null,
              relevantH4.length >= 20 ? relevantH4 : null,
              relevantH1.length >= 20 ? relevantH1 : null,
              {
                h4ChochLookback: config.simpleDirectionH4ChochLookback ?? 10,
                h1BosLookback: config.simpleDirectionH1BosLookback ?? 8,
              },
            );
          } else if (tradingStyle === "swing_trader") {
            // Swing: Weekly(bias) → Daily(structure) → 4H(confirm)
            const labels = STYLE_TF_LABELS["swing_trader"];
            const styleResult = determineDirectionStyleAware(
              relevantWeekly.length >= 20 ? relevantWeekly : null,  // bias (Weekly)
              relevantDaily.length >= 20 ? relevantDaily : null,    // structure (Daily)
              relevantH4.length >= 20 ? relevantH4 : null,          // confirm (4H)
              {
                h4ChochLookback: config.simpleDirectionH4ChochLookback ?? 10,
                h1BosLookback: config.simpleDirectionH1BosLookback ?? 8,
                biasTFLabel: labels.biasTFLabel,
                structureTFLabel: labels.structureTFLabel,
                confirmTFLabel: labels.confirmTFLabel,
              },
            );
            directionResult = styleResult as unknown as DirectionResult;
          } else {
            // Scalper: 1H(bias) → 15m(structure) → 5m(confirm)
            const labels = STYLE_TF_LABELS["scalper"];
            const styleResult = determineDirectionStyleAware(
              relevantH1.length >= 20 ? relevantH1 : null,           // bias (1H)
              relevantM15.length >= 20 ? relevantM15 : null,         // structure (15m)
              analysisCandles.length >= 20 ? analysisCandles : null,  // confirm (5m entry candles)
              {
                h4ChochLookback: config.simpleDirectionH4ChochLookback ?? 10,
                h1BosLookback: config.simpleDirectionH1BosLookback ?? 8,
                biasTFLabel: labels.biasTFLabel,
                structureTFLabel: labels.structureTFLabel,
                confirmTFLabel: labels.confirmTFLabel,
              },
            );
            directionResult = styleResult as unknown as DirectionResult;
          }
        } catch { directionResult = null; }
      }

      // ── HTF POI Detection (4H) ──
      let h4OBs: any[] = [];
      let h4FVGs: any[] = [];
      let h4Breakers: any[] = [];
      let htfFibLevels4H: any = null;
      let htfFibLevelsD: any = null;
      let htfPD4H: any = null;
      if (relevantH4.length >= 30) {
        try {
          const h4Structure = analyzeMarketStructure(relevantH4.slice(-60));
          const h4StructureBreaks = [...h4Structure.bos, ...h4Structure.choch].map((b: any) => ({ index: b.index, type: b.type }));
          h4OBs = detectOrderBlocks(relevantH4.slice(-60), h4StructureBreaks);
          h4FVGs = detectFVGs(relevantH4.slice(-60), h4StructureBreaks);
          h4Breakers = detectBreakerBlocks(h4OBs, relevantH4.slice(-60), h4StructureBreaks);
          const h4PivotResult = detectZigZagPivots(relevantH4.slice(-60), 3, 10);
          if (h4PivotResult.lastTwo) {
            htfFibLevels4H = computeFibLevels(h4PivotResult.lastTwo[0], h4PivotResult.lastTwo[1]);
          }
          htfPD4H = calculatePremiumDiscount(relevantH4.slice(-60));
        } catch { /* non-fatal */ }
      }
      // Daily Fibonacci
      if (relevantDaily.length >= 30) {
        try {
          const dPivotResult = detectZigZagPivots(relevantDaily.slice(-60), 5, 20);
          if (dPivotResult.lastTwo) {
            htfFibLevelsD = computeFibLevels(dPivotResult.lastTwo[0], dPivotResult.lastTwo[1]);
          }
        } catch { /* non-fatal */ }
      }

      // ── Liquidity Pool Detection (D/4H/1H) ──
      const liqTolBase = 0.20;
      const liqMinTouches = 2;
      let htfLiquidityPoolsD: LiquidityPool[] = [];
      let htfLiquidityPools4H: LiquidityPool[] = [];
      let htfLiquidityPools1H: LiquidityPool[] = [];
      try {
        if (relevantDaily.length >= 30) {
          htfLiquidityPoolsD = detectLiquidityPools(relevantDaily.slice(-60), Math.min(liqTolBase + 0.10, 0.40), liqMinTouches);
        }
        if (relevantH4.length >= 30) {
          htfLiquidityPools4H = detectLiquidityPools(relevantH4.slice(-60), Math.min(liqTolBase + 0.05, 0.35), liqMinTouches);
        }
        if (relevantH1.length >= 30) {
          htfLiquidityPools1H = detectLiquidityPools(relevantH1.slice(-60), liqTolBase, liqMinTouches);
        }
      } catch { /* non-fatal */ }

      // ── Get FOTSI for this timestamp ──
      const fotsiResult = getNearestFOTSI(candleMs);

      // ── Get SMT correlated candles ──
      const smtPair = SMT_PAIRS[symbol] || null;
      let smtCandles: Candle[] | null = null;
      if (smtPair && smtData[smtPair]) {
        smtCandles = smtData[smtPair].filter(c => {
          const cMs = new Date(c.datetime.endsWith("Z") ? c.datetime : c.datetime + "Z").getTime();
          return cMs <= candleMs;
        }).slice(-100);
        if (smtCandles.length < 30) smtCandles = null;
      }

      // ── Build config for confluenceScoring ──
      const pairConfig: any = { ...config, _currentSymbol: symbol };
      if (directionResult) {
        pairConfig._overrideDirection = directionResult.direction;
      }
      // Inject FOTSI
      pairConfig._fotsiResult = fotsiResult;
      // Inject SMT
      pairConfig._smtResult = smtCandles ? detectSMTDivergence(symbol, analysisCandles, smtCandles) : null;
      if (pairConfig._smtResult?.detected) diag.smtDetected++;

      // Inject HTF POIs
      const htfPOIs = [
        ...h4OBs.map((ob: any) => ({ timeframe: "4H", type: "ob" as const, high: ob.high, low: ob.low, direction: ob.type })),
        ...h4FVGs.map((fvg: any) => ({ timeframe: "4H", type: "fvg" as const, high: fvg.high, low: fvg.low, direction: fvg.type })),
        ...h4Breakers.map((b: any) => ({ timeframe: "4H", type: "breaker" as const, high: b.high, low: b.low, direction: String(b.type).startsWith("bullish") ? "bullish" : "bearish" })),
      ].filter(poi => Number.isFinite(poi.high) && Number.isFinite(poi.low));
      pairConfig._htfPOIs = htfPOIs.length > 0 ? htfPOIs : null;
      pairConfig._htfFibLevels = htfFibLevels4H;
      pairConfig._htfPD = htfPD4H;
      pairConfig._h4Candles = relevantH4.length >= 20 ? relevantH4.slice(-60) : null;

      // ── Run Confluence Analysis ──
      let analysis: any;
      try {
        analysis = runConfluenceAnalysis(analysisCandles, relevantDaily, pairConfig, relevantH1, candleMs);
      } catch {
        continue;
      }
      if (!analysis || !analysis.direction) {
        diag.skippedNoDirection++;
        continue;
      }

      // ══════════════════════════════════════════════════════════════════
      // ── ZONE ENGINE (style-aware) ──
      // Day Trader / Scalper: Unified Zone Engine (story-driven)
      // Swing Trader: Cascade Zone Engine (Daily → 4H confirm → 1H entry)
      // ══════════════════════════════════════════════════════════════════
      let unifiedResult: UnifiedZoneResult | null = null;
      let cascadeResult: CascadeResult | null = null;
      let unifiedGatePassed = false;
      let cascadeSL: number | null = null;

      if (tradingStyle === "swing_trader") {
        // ── SWING: Cascade Zone Engine ──
        // Daily impulse → price at zone → 4H displacement / 1H CHoCH → 1H entry zone
        if (analysis.direction && relevantDaily.length >= 30 && relevantH4.length >= 25 && relevantH1.length >= 20) {
          try {
            const cascadeDir = analysis.direction === "long" ? "bullish" : "bearish";
            const htfConfluenceData: HTFConfluenceData = {
              h4OBs: h4OBs ?? [],
              h4FVGs: h4FVGs ?? [],
              h4Breakers: h4Breakers ?? [],
              htfFibLevels: htfFibLevels4H ?? null,
              dailyFibLevels: htfFibLevelsD ?? null,
              htfPD: htfPD4H ?? null,
              direction: cascadeDir as "bullish" | "bearish",
            };
            cascadeResult = findCascadeZone(
              relevantDaily.slice(-60),
              relevantH4.slice(-60),
              relevantH1.slice(-120),
              analysisCandles,  // 1H entry candles for LTF refinement
              cascadeDir,
              analysis.lastPrice,
              {
                dailyZoneATRMult: 2.0,
                entryStrictATRMult: config.marketFillStrictATRMult ?? 0.3,
                minDailyFibDepth: 0.382,  // Lower threshold for swing (accept 38.2%+)
                requireDailySR: false,
                htfData: htfConfluenceData,
              },
            );

            // Track cascade states
            if (cascadeResult) {
              diag.unifiedStates[cascadeResult.state] = (diag.unifiedStates[cascadeResult.state] || 0) + 1;
            }

            // Cascade gate pass: state is "triggered" (price at entry zone)
            // Also accept "ready" state (price approaching entry zone within 1 ATR)
            if (cascadeResult?.state === "triggered" || 
                (cascadeResult?.state === "ready" && cascadeResult.distancePips <= 5)) {
              unifiedGatePassed = true;
              cascadeSL = cascadeResult.sl;
              diag.unifiedGatePasses++;
            }
          } catch { /* non-fatal */ }
        }
      } else {
        // ── DAY TRADER / SCALPER: Unified Zone Engine ──
        if (analysis.direction && relevantH1.length >= 20) {
          try {
            const unifiedDir = analysis.direction === "long" ? "bullish" : "bearish";
            const combinedLiqPools = [
              ...htfLiquidityPoolsD,
              ...htfLiquidityPools4H,
              ...htfLiquidityPools1H,
            ];
            const htfConfluenceData: HTFConfluenceData = {
              h4OBs: h4OBs ?? [],
              h4FVGs: h4FVGs ?? [],
              h4Breakers: h4Breakers ?? [],
              htfFibLevels: htfFibLevels4H ?? null,
              dailyFibLevels: htfFibLevelsD ?? null,
              htfPD: htfPD4H ?? null,
              direction: unifiedDir as "bullish" | "bearish",
            };
            // Style-aware candle mapping for unified zone engine
            let uzH1Slot: any[], uzH4Slot: any[], uzEntrySlot: any[];
            let uzDailySlot: any[] | undefined;
            let confirmCandles: any[], ltfConfirmCandles: any[];

            if (tradingStyle === "scalper") {
              // Scalper: 1H(high) → 15m(mid) → 5m(entry)
              uzH1Slot = relevantM15.slice(-120);
              uzH4Slot = relevantH1.slice(-60);
              uzEntrySlot = analysisCandles;
              uzDailySlot = undefined;
              confirmCandles = relevantH1.slice(-60);
              ltfConfirmCandles = relevantM15.slice(-60);
            } else {
              // Day trader (default): Daily → 4H → 1H → 15m entry
              uzH1Slot = relevantH1.slice(-120);
              uzH4Slot = relevantH4.slice(-60);
              uzEntrySlot = analysisCandles;
              uzDailySlot = relevantDaily.length >= 30 ? relevantDaily.slice(-60) : undefined;
              confirmCandles = relevantDaily.length >= 30 ? relevantH4 : relevantH1;
              ltfConfirmCandles = relevantDaily.length >= 30 ? relevantH1 : analysisCandles;
            }

            unifiedResult = findUnifiedZone(
              uzH1Slot,
              uzH4Slot,
              uzEntrySlot,
              unifiedDir as "bullish" | "bearish",
              analysis.lastPrice,
              combinedLiqPools,
              htfConfluenceData,
              { strictATRMult: config.marketFillStrictATRMult ?? 0.3, pipSize: spec.pipSize },
              uzDailySlot,
              confirmCandles,
              ltfConfirmCandles,
            );

            // Track unified states
            if (unifiedResult) {
              diag.unifiedStates[unifiedResult.state] = (diag.unifiedStates[unifiedResult.state] || 0) + 1;
              if (unifiedResult.unifiedScore > diag.highestUnifiedScore) {
                diag.highestUnifiedScore = unifiedResult.unifiedScore;
              }
            }

            // Unified gate pass condition (matches live bot line 4549)
            if (unifiedResult?.hasZone &&
                (unifiedResult.state === "triggered" || unifiedResult.state === "confirmed") &&
                unifiedResult.confirmation?.entryReady === true) {
              unifiedGatePassed = true;
              diag.unifiedGatePasses++;
            }
          } catch { /* non-fatal */ }
        }
      }

      // ── ZONE GATE: Skip if neither unified nor cascade gate passed ──
      let impulseZonePenaltyVal = 0;
      if (unifiedGatePassed) {
        // Zone story is complete — take the trade
        impulseZonePenaltyVal = +(config.impulseZoneBonus ?? 1.0);
      } else {
        // Zone gate did NOT pass — skip entirely
        diag.skippedNoZone++;
        continue;
      }

      // ── Effective Score ──
      const effectiveScore = analysis.score + impulseZonePenaltyVal;

      // Score distribution
      if (effectiveScore < 20) diag.scoreDistribution.below20++;
      else if (effectiveScore < 40) diag.scoreDistribution.below40++;
      else if (effectiveScore < 60) diag.scoreDistribution.below60++;
      else if (effectiveScore < 80) diag.scoreDistribution.below80++;
      else diag.scoreDistribution.above80++;
      if (effectiveScore > diag.highestScoreSeen) diag.highestScoreSeen = effectiveScore;

      // ── Threshold check ──
      // For swing_trader, the cascade engine IS the primary gate — skip confluence threshold
      if (tradingStyle !== "swing_trader" && effectiveScore < config.minConfluence) {
        diag.skippedBelowThreshold++;
        continue;
      }

      // ── Session Gate ── (only for day_trader — swing ignores sessions, scalper trades all sessions)
      if (tradingStyle === "day_trader") {
        const session = detectSession(candleMs);
        if (config.enabledSessions && config.enabledSessions.length > 0) {
          if (!isSessionEnabled(session, config.enabledSessions)) {
            diag.skippedGateBlocked++;
            diag.gateBlockReasons["Session"] = (diag.gateBlockReasons["Session"] || 0) + 1;
            continue;
          }
        }
      }

      // ── Tier 1 Gate ── (only for day_trader — calibrated for 15m entry factors)
      if (tradingStyle === "day_trader" && analysis.tieredScoring && !analysis.tieredScoring.tier1GatePassed) {
        diag.skippedGateBlocked++;
        diag.gateBlockReasons["Tier1Gate"] = (diag.gateBlockReasons["Tier1Gate"] || 0) + 1;
        continue;
      }

      // ── Regime Gate ──
      if (config.regimeScoringEnabled && analysis.tieredScoring && !analysis.tieredScoring.regimeGatePassed) {
        diag.skippedGateBlocked++;
        diag.gateBlockReasons["RegimeGate"] = (diag.gateBlockReasons["RegimeGate"] || 0) + 1;
        continue;
      }

      // ══════════════════════════════════════════════════════════════════
      // ── NEW GATES (ported from live bot-scanner) ──
      // Gate A: Direction Verdict (blocks counter-trend trades)
      // Gate B: Premium/Discount Zone (only buy in discount, sell in premium)
      // Gate C: Structural Conviction (fractal alignment on conviction TF)
      // ══════════════════════════════════════════════════════════════════

      // ── Gate A: Direction Verdict ──
      // Uses confirmedTrend + simpleDirection + regime to produce a single verdict.
      // Blocks trades when directional confidence is too low or regime strongly opposes.
      {
        let directionVerdict: DirectionVerdictResult | null = null;
        try {
          // Compute confirmedTrend from daily candles (same as live bot)
          const ctResult = relevantDaily.length >= 20
            ? computeConfirmedTrend(relevantDaily, 0.25, 5)
            : null;

          // Build simpleDirection input from the already-computed directionResult
          const simpleDirectionInput = directionResult ? {
            direction: directionResult.direction,
            bias: directionResult.bias,
            biasSource: directionResult.biasSource,
            h4Retrace: directionResult.h4Retrace,
            h4ChochAgainst: directionResult.h4ChochAgainst,
            h1Confirmed: directionResult.h1Confirmed,
            reason: directionResult.reason,
          } : null;

          // Build regime input from analysis.regimeInfo (returned by confluenceScoring)
          const regimeInput = analysis.regimeInfo ? {
            regime: analysis.regimeInfo.regime,
            confidence: analysis.regimeInfo.confidence,
            directionalBias: analysis.regimeInfo.bias,
          } : null;

          directionVerdict = computeDirectionVerdict({
            confirmedTrend: ctResult,
            simpleDirection: simpleDirectionInput,
            regime: regimeInput,
            weeklyBias: null,   // Not available in backtest (no weekly bias computation)
            gamePlanBias: null, // Not available in backtest (LLM-generated)
          });
        } catch { /* non-fatal — skip gate if computation fails */ }

        if (directionVerdict?.shouldBlock) {
          diag.skippedGateBlocked++;
          diag.gateBlockReasons["DirectionVerdict"] = (diag.gateBlockReasons["DirectionVerdict"] || 0) + 1;
          continue;
        }
      }

      // ── Gate B: Premium/Discount Zone ──
      // Only buy in discount (<45%), only sell in premium (>55%).
      // Uses entry-TF candles for P/D calculation (same as live bot Gate 2).
      {
        const pdResult = calculatePremiumDiscount(analysisCandles);
        const pdZone = pdResult.currentZone; // "premium" | "discount" | "equilibrium"
        const direction = analysis.direction as "long" | "short";

        // Block: buying in premium zone
        if (direction === "long" && pdZone === "premium") {
          diag.skippedGateBlocked++;
          diag.gateBlockReasons["PremiumDiscount"] = (diag.gateBlockReasons["PremiumDiscount"] || 0) + 1;
          continue;
        }
        // Block: selling in discount zone
        if (direction === "short" && pdZone === "discount") {
          diag.skippedGateBlocked++;
          diag.gateBlockReasons["PremiumDiscount"] = (diag.gateBlockReasons["PremiumDiscount"] || 0) + 1;
          continue;
        }
      }

      // ── Gate C: Structural Conviction ──
      // Uses conviction TF (one above entry): scalper→15m, day_trader→1H, swing→4H.
      // Blocks when fractal structure shows zero support for the trade direction
      // or when opposing fractals overwhelm supporting ones (2.5× ratio).
      {
        // Determine conviction candles based on style
        const convictionCandles = tradingStyle === "swing_trader"
          ? (relevantH4.length >= 20 ? relevantH4.slice(-60) : null)
          : tradingStyle === "scalper"
            ? (relevantM15.length >= 20 ? relevantM15.slice(-60) : null)
            : (relevantH1.length >= 20 ? relevantH1.slice(-60) : null);

        if (convictionCandles && convictionCandles.length >= 20) {
          const convictionStructure = analyzeMarketStructure(convictionCandles);
          const s2f = convictionStructure.structureToFractal;
          const s2fOverall = s2f?.overallRate ?? 1;
          const bullRate = s2f?.bullishRate ?? 0.5;
          const bearRate = s2f?.bearishRate ?? 0.5;
          const direction = analysis.direction as "long" | "short";
          const directionRate = direction === "long" ? bullRate : bearRate;
          const oppositeRate = direction === "long" ? bearRate : bullRate;

          // Thresholds (same as live bot defaults)
          const s2fBlockThreshold = direction === "short" ? 0.20 : 0.35;
          const oppositeBlockThreshold = direction === "short" ? 0.45 : 0.30;

          // Block condition 1: 0% in direction + low S2F + opposite has activity
          if (directionRate === 0 && s2fOverall < s2fBlockThreshold && oppositeRate > 0) {
            diag.skippedGateBlocked++;
            diag.gateBlockReasons["StructuralConviction"] = (diag.gateBlockReasons["StructuralConviction"] || 0) + 1;
            continue;
          }
          // Block condition 2: 0% in direction + strong opposite
          if (directionRate === 0 && oppositeRate > oppositeBlockThreshold) {
            diag.skippedGateBlocked++;
            diag.gateBlockReasons["StructuralConviction"] = (diag.gateBlockReasons["StructuralConviction"] || 0) + 1;
            continue;
          }
          // Block condition 3: opposing fractals are 2.5× or more than supporting
          if (directionRate > 0 && oppositeRate > 0 && oppositeRate / directionRate >= 2.5) {
            diag.skippedGateBlocked++;
            diag.gateBlockReasons["StructuralConviction"] = (diag.gateBlockReasons["StructuralConviction"] || 0) + 1;
            continue;
          }
        }
      }

      // ── Determine SL/TP ──
      let sl = analysis.stopLoss;
      let tp = analysis.takeProfit;

      // Fixed SL/TP for scalper (override zone-based SL which is too wide for 5m)
      if (tradingStyle === "scalper" && config.fixedSlPips && config.fixedTpPips) {
        const fixedSlDist = config.fixedSlPips * spec.pipSize;
        const fixedTpDist = config.fixedTpPips * spec.pipSize;
        if (analysis.direction === "long") {
          sl = candle.close - fixedSlDist;
          tp = candle.close + fixedTpDist;
        } else {
          sl = candle.close + fixedSlDist;
          tp = candle.close - fixedTpDist;
        }
      }
      // Zone SL/TP Override (use the zone engine's SL when available)
      else if (unifiedGatePassed && cascadeSL && tradingStyle === "swing_trader") {
        // Swing: Use cascade SL (below Daily zone origin)
        const cascadeSlDistance = Math.abs(analysis.lastPrice - cascadeSL);
        const cascadeSlPips = cascadeSlDistance / spec.pipSize;
        const staticMinSlPips = MIN_SL_PIPS[symbol] ?? MIN_SL_PIPS["EUR/USD"] ?? 10;
        const maxSlPips = staticMinSlPips * (config.impulseSlCapMultiplier ?? 6); // Wider for swing

        if (cascadeSlPips >= staticMinSlPips && cascadeSlPips <= maxSlPips) {
          sl = cascadeSL;
          // Recalculate TP based on cascade SL for proper R:R
          const cascadeRisk = Math.abs(analysis.lastPrice - sl);
          tp = analysis.direction === "long"
            ? analysis.lastPrice + cascadeRisk * config.tpRatio
            : analysis.lastPrice - cascadeRisk * config.tpRatio;
        }
      } else if (unifiedGatePassed && unifiedResult?.entry?.slPrice) {
        // Day Trader / Scalper: Use unified zone SL
        const unifiedSL = unifiedResult.entry.slPrice;
        const unifiedSlDistance = Math.abs(analysis.lastPrice - unifiedSL);
        const unifiedSlPips = unifiedSlDistance / spec.pipSize;
        const staticMinSlPips = MIN_SL_PIPS[symbol] ?? MIN_SL_PIPS["EUR/USD"] ?? 10;
        const maxUnifiedSlPips = staticMinSlPips * (config.impulseSlCapMultiplier ?? 4);

        if (unifiedSlPips >= staticMinSlPips && unifiedSlPips <= maxUnifiedSlPips) {
          sl = unifiedSL;
          // Recalculate TP based on unified SL for proper R:R
          const unifiedRisk = Math.abs(analysis.lastPrice - sl);
          tp = analysis.direction === "long"
            ? analysis.lastPrice + unifiedRisk * config.tpRatio
            : analysis.lastPrice - unifiedRisk * config.tpRatio;
        }
      }

      if (!sl || !tp) continue;

      // ── Min R:R Gate ──
      const slDist = Math.abs(candle.close - sl);
      const tpDist = Math.abs(candle.close - tp);
      const rr = slDist > 0 ? tpDist / slDist : 0;
      if (rr < (config.minRiskReward ?? 1.5)) {
        diag.skippedGateBlocked++;
        diag.gateBlockReasons["MinRR"] = (diag.gateBlockReasons["MinRR"] || 0) + 1;
        continue;
      }

      // ── SL Floor Enforcement ──
      {
        const slDistPips = Math.abs(candle.close - sl) / spec.pipSize;
        const staticMin = MIN_SL_PIPS[symbol] ?? MIN_SL_PIPS["EUR/USD"] ?? 10;
        const recentForATR = entryCandles.slice(Math.max(0, i - 20), i);
        const atrVal = recentForATR.length >= 14 ? calculateATR(recentForATR, 14) : 0;
        const atrFloorPips = atrVal > 0 ? (atrVal * ATR_SL_FLOOR_MULTIPLIER) / spec.pipSize : 0;
        const effectiveMinSl = Math.max(staticMin, atrFloorPips);
        if (slDistPips < effectiveMinSl) {
          const origRR = tpDist / slDist;
          const newSlDist = effectiveMinSl * spec.pipSize;
          if (analysis.direction === "long") {
            sl = candle.close - newSlDist;
            tp = candle.close + newSlDist * origRR;
          } else {
            sl = candle.close + newSlDist;
            tp = candle.close - newSlDist * origRR;
          }
        }
      }

      // ── SL Sanity Guard ──
      const slSanityFailed = analysis.direction === "long"
        ? candle.close <= sl
        : candle.close >= sl;
      if (slSanityFailed) {
        diag.skippedSlSanity++;
        continue;
      }

      // ── Signal generated! ──
      diag.signalsGenerated++;
      symbolSignals++;

      // ── Position Sizing ──
      const risk = Math.abs(candle.close - sl);
      const riskAmount = balance * (config.riskPerTrade / 100);
      const pipsRisk = risk / spec.pipSize;
      const quoteToUSD = getQuoteToUSDRate(symbol, btRateMap);
      const pipValue = spec.pipSize * spec.lotUnits * quoteToUSD;
      let posSize = pipsRisk > 0 && pipValue > 0 ? riskAmount / (pipsRisk * pipValue) : 0.01;
      posSize = Math.max(0.01, Math.min(posSize, 5));

      // ── Open Position ──
      tradeCounter++;
      const posId = `bt_full_${tradeCounter}`;
      openPositions.push({
        id: posId,
        symbol,
        direction: analysis.direction,
        entryPrice: candle.close,
        stopLoss: sl,
        takeProfit: tp,
        size: Math.round(posSize * 100) / 100,
        entryTime: candle.datetime,
        entryBarIndex: i,
        confluenceScore: analysis.score,
        effectiveScore,
        currentSL: sl,
        breakEvenFired: false,
        signalSource: unifiedGatePassed ? "unified" : "standalone",
        unifiedScore: unifiedResult?.unifiedScore ?? 0,
      });
      diag.tradesOpened++;
    }

    console.log(`  ✓ ${symbol}: ${symbolSignals} signals, ${symbolTrades} closed, ${openPositions.filter(p => p.symbol === symbol).length} still open`);
  }

  // ── Close remaining positions at last price ──
  for (const pos of [...openPositions]) {
    const lastCandle = candleData[pos.symbol]?.m15.slice(-1)[0];
    if (!lastCandle) continue;
    const { pnl, pnlPips } = calcPnl(pos.direction, pos.entryPrice, lastCandle.close, pos.size, pos.symbol, btRateMap);
    balance += pnl;
    if (balance > peakBalance) peakBalance = balance;
    const dd = peakBalance - balance;
    const ddPct = peakBalance > 0 ? (dd / peakBalance) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    allTrades.push({
      id: pos.id, symbol: pos.symbol, direction: pos.direction,
      entryPrice: pos.entryPrice, exitPrice: lastCandle.close,
      entryTime: pos.entryTime, exitTime: lastCandle.datetime,
      pnl, pnlPips, closeReason: "end_of_test",
      confluenceScore: pos.confluenceScore,
      effectiveScore: pos.effectiveScore,
      size: pos.size,
      signalSource: pos.signalSource,
      unifiedScore: pos.unifiedScore,
    });
  }

  // ─── RESULTS ──────────────────────────────────────────────────────
  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  BACKTEST RESULTS (FULL LIVE REPLICATION)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const avgWinPips = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPips, 0) / wins.length : 0;
  const avgLossPips = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.pnlPips), 0) / losses.length : 0;

  // Sharpe ratio
  const dailyReturns: number[] = [];
  let dayEquity = startingBalance;
  let lastDate = "";
  let dayPnl = 0;
  for (const t of allTrades.sort((a, b) => a.exitTime.localeCompare(b.exitTime))) {
    const d = t.exitTime.slice(0, 10);
    if (d !== lastDate && lastDate) {
      dailyReturns.push(dayEquity > 0 ? dayPnl / dayEquity : 0);
      dayEquity += dayPnl;
      dayPnl = 0;
    }
    dayPnl += t.pnl;
    lastDate = d;
  }
  if (dayPnl !== 0) { dailyReturns.push(dayEquity > 0 ? dayPnl / dayEquity : 0); }
  const avgReturn = dailyReturns.length > 0 ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length : 0;
  const stdDev = dailyReturns.length > 1 ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (dailyReturns.length - 1)) : 0;
  const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

  console.log(`  Total Trades:     ${allTrades.length}`);
  console.log(`  Win Rate:         ${allTrades.length > 0 ? ((wins.length / allTrades.length) * 100).toFixed(1) : 0}% (${wins.length}W / ${losses.length}L)`);
  console.log(`  Profit Factor:    ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}`);
  console.log(`  Sharpe Ratio:     ${sharpe.toFixed(2)}`);
  console.log(`  Total P&L:        $${totalPnl.toFixed(2)} (${((totalPnl / startingBalance) * 100).toFixed(1)}%)`);
  console.log(`  Final Balance:    $${balance.toFixed(2)}`);
  console.log(`  Max Drawdown:     $${maxDrawdown.toFixed(2)} (${maxDrawdownPct.toFixed(1)}%)`);
  console.log(`  Avg Win:          $${avgWin.toFixed(2)} (${avgWinPips.toFixed(1)} pips)`);
  console.log(`  Avg Loss:         $${avgLoss.toFixed(2)} (${avgLossPips.toFixed(1)} pips)`);
  console.log(`  Highest Score:    ${diag.highestScoreSeen.toFixed(1)}`);
  console.log(`  Highest Unified:  ${diag.highestUnifiedScore.toFixed(1)}/14`);

  // Per-symbol breakdown
  console.log("\n  ── Per-Symbol Breakdown ──");
  for (const sym of instruments) {
    const symTrades = allTrades.filter(t => t.symbol === sym);
    const symWins = symTrades.filter(t => t.pnl > 0);
    const symPnl = symTrades.reduce((s, t) => s + t.pnl, 0);
    const symUnified = symTrades.filter(t => t.signalSource === "unified");
    const symWR = symTrades.length > 0 ? ((symWins.length / symTrades.length) * 100).toFixed(0) : "0";
    console.log(`  ${sym}: ${symTrades.length} trades, ${symWR}% WR, $${symPnl.toFixed(2)} P&L, ${symUnified.length} unified / ${symTrades.length - symUnified.length} standalone`);
  }

  // Close reasons
  console.log("\n  ── Close Reasons ──");
  const reasons: Record<string, { count: number; pnl: number; wins: number }> = {};
  for (const t of allTrades) {
    if (!reasons[t.closeReason]) reasons[t.closeReason] = { count: 0, pnl: 0, wins: 0 };
    reasons[t.closeReason].count++;
    reasons[t.closeReason].pnl += t.pnl;
    if (t.pnl > 0) reasons[t.closeReason].wins++;
  }
  for (const [reason, data] of Object.entries(reasons)) {
    const wr = data.count > 0 ? (data.wins / data.count) * 100 : 0;
    console.log(`  ${reason.padEnd(15)} ${String(data.count).padStart(4)} trades  P&L: $${data.pnl.toFixed(0).padStart(8)}  WR: ${wr.toFixed(0)}%`);
  }

  // Signal source breakdown
  console.log("\n  ── Signal Source ──");
  const unifiedTrades = allTrades.filter(t => t.signalSource === "unified");
  const standaloneTrades = allTrades.filter(t => t.signalSource === "standalone");
  if (unifiedTrades.length > 0) {
    const uWins = unifiedTrades.filter(t => t.pnl > 0);
    const uPnl = unifiedTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`  Unified:    ${unifiedTrades.length} trades, ${((uWins.length / unifiedTrades.length) * 100).toFixed(0)}% WR, $${uPnl.toFixed(2)} P&L, avg unified score ${(unifiedTrades.reduce((s, t) => s + t.unifiedScore, 0) / unifiedTrades.length).toFixed(1)}/14`);
  } else {
    console.log(`  Unified:    0 trades (story never reached triggered/confirmed state)`);
  }
  if (standaloneTrades.length > 0) {
    const sWins = standaloneTrades.filter(t => t.pnl > 0);
    const sPnl = standaloneTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`  Standalone: ${standaloneTrades.length} trades, ${((sWins.length / standaloneTrades.length) * 100).toFixed(0)}% WR, $${sPnl.toFixed(2)} P&L`);
  } else {
    console.log(`  Standalone: 0 trades`);
  }

  // Monthly P&L
  console.log("\n  ── Monthly P&L ──");
  const monthlyPnl: Record<string, { pnl: number; trades: number; wins: number }> = {};
  for (const t of allTrades) {
    const month = t.exitTime.slice(0, 7);
    if (!monthlyPnl[month]) monthlyPnl[month] = { pnl: 0, trades: 0, wins: 0 };
    monthlyPnl[month].pnl += t.pnl;
    monthlyPnl[month].trades++;
    if (t.pnl > 0) monthlyPnl[month].wins++;
  }
  for (const [month, data] of Object.entries(monthlyPnl).sort(([a], [b]) => a.localeCompare(b))) {
    const wr = data.trades > 0 ? (data.wins / data.trades) * 100 : 0;
    const sign = data.pnl >= 0 ? "+" : "";
    console.log(`  ${month}: ${sign}$${data.pnl.toFixed(0)} (${data.trades} trades, ${wr.toFixed(0)}% WR)`);
  }

  // Diagnostics
  console.log("\n  ── Diagnostics ──");
  console.log(`  Bars evaluated:       ${diag.totalBarsEvaluated}`);
  console.log(`  Signals generated:    ${diag.signalsGenerated}`);
  console.log(`  Trades opened:        ${diag.tradesOpened}`);
  console.log(`  Skipped (no dir):     ${diag.skippedNoDirection}`);
  console.log(`  Skipped (no zone):    ${diag.skippedNoZone}`);
  console.log(`  Skipped (not at zone):${diag.skippedNotAtZone}`);
  console.log(`  Skipped (threshold):  ${diag.skippedBelowThreshold}`);
  console.log(`  Skipped (gates):      ${diag.skippedGateBlocked}`);
  console.log(`  Skipped (max pos):    ${diag.skippedMaxPositions}`);
  console.log(`  Skipped (SL sanity):  ${diag.skippedSlSanity}`);
  console.log(`  Unified gate passes:  ${diag.unifiedGatePasses}`);
  console.log(`  Standalone passes:    ${diag.standaloneGatePasses}`);
  console.log(`  SMT divergence found: ${diag.smtDetected} bars`);

  // Unified state distribution
  console.log("\n  ── Unified Zone States ──");
  for (const [state, count] of Object.entries(diag.unifiedStates).sort((a, b) => (b[1] as number) - (a[1] as number))) {
    console.log(`  ${state}: ${count}`);
  }

  // Gate block reasons
  if (Object.keys(diag.gateBlockReasons).length > 0) {
    console.log("\n  ── Gate Block Reasons ──");
    for (const [gate, count] of Object.entries(diag.gateBlockReasons).sort(([, a], [, b]) => (b as number) - (a as number))) {
      console.log(`  ${gate}: ${count}`);
    }
  }

  // Score distribution
  console.log("\n  ── Score Distribution ──");
  console.log(`  0-20:  ${diag.scoreDistribution.below20}`);
  console.log(`  20-40: ${diag.scoreDistribution.below40}`);
  console.log(`  40-60: ${diag.scoreDistribution.below60}`);
  console.log(`  60-80: ${diag.scoreDistribution.below80}`);
  console.log(`  80+:   ${diag.scoreDistribution.above80}`);

  // Save results
  const results = {
    config: {
      instruments,
      startDate,
      endDate,
      startingBalance,
      entryTimeframe: "15min",
      minConfluence: config.minConfluence,
      impulseZoneGateMode: config.impulseZoneGateMode,
      tpRatio: config.tpRatio,
      breakEvenPips: config.breakEvenPips,
      fotsiEnabled: true,
      smtEnabled: true,
      unifiedZoneEngine: true,
    },
    summary: {
      totalTrades: allTrades.length,
      winRate: allTrades.length > 0 ? (wins.length / allTrades.length) * 100 : 0,
      profitFactor: profitFactor === Infinity ? 999 : profitFactor,
      sharpe,
      totalPnl,
      finalBalance: balance,
      maxDrawdown,
      maxDrawdownPct,
      avgWin,
      avgLoss,
      avgWinPips,
      avgLossPips,
      highestScore: diag.highestScoreSeen,
      highestUnifiedScore: diag.highestUnifiedScore,
      unifiedTrades: unifiedTrades.length,
      standaloneTrades: standaloneTrades.length,
    },
    diagnostics: diag,
    monthlyPnl,
    trades: allTrades,
  };
  const outPath = `/home/ubuntu/backtest_results_${tradingStyle}.json`;
  Deno.writeTextFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n✅ Full results saved to ${outPath}`);
}

// ─── Run ────────────────────────────────────────────────────────────
runBacktest().catch(e => {
  console.error("FATAL:", e);
  Deno.exit(1);
});
