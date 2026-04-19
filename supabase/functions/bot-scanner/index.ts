import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { fetchCandlesWithFallback, beginScanSourceTally, endScanSourceTally, type BrokerConn } from "../_shared/candleSource.ts";
import {
  computeFOTSI, getCurrencyAlignment, checkOverboughtOversoldVeto,
  parsePairCurrencies, getFOTSIPairNames,
  type FOTSIResult, type Currency,
} from "../_shared/fotsi.ts";


// ─── Bot Identity ────────────────────────────────────────────────────
const BOT_ID = "smc";

// ─── Default Config (overridden by bot_configs) ─────────────────────
// Confluence is normalized to 0-10 (raw max ~23.0 across 20 factors, clamped).
// Recommended: 5.0-5.5 for balanced, 6.5+ for A+ only, <4.0 looser/scalp.
const DEFAULTS = {
  minConfluence: 5.5,
  htfBiasRequired: true,
  htfBiasHardVeto: false, // when true: ranging HTF blocks both sides; mismatch always blocks
  entryTimeframe: "15min",
  htfTimeframe: "1day",
  onlyBuyInDiscount: true,
  onlySellInPremium: true,
  riskPerTrade: 1,
  maxDailyLoss: 5,
  maxDrawdown: 15,
  maxOpenPositions: 5,
  maxPerSymbol: 2,
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
  enabledSessions: ["London", "New York"],
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
    mode: "day_trader" as "scalper" | "day_trader" | "swing_trader" | "auto",
    autoDetectEnabled: false,
  },
  // ── Spread Filter ──
  spreadFilterEnabled: true,
  maxSpreadPips: 3,
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
// Replicate the same failover logic from broker-execute: try London → New York → Singapore.
// Caches the successful region per account to avoid repeated probing.
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
    // If the error is NOT a region mismatch, stop trying other regions
    if (!/region|not connected to broker/i.test(body)) {
      return { res: new Response(body, { status: res.status }), body };
    }
    console.warn(`MetaAPI ${region} returned ${res.status} (region/connection mismatch), trying next...`);
  }
  return { res: new Response(lastBody, { status: lastStatus }), body: lastBody };
}

// ─── Trading Style Overrides ────────────────────────────────────────
const STYLE_OVERRIDES: Record<string, Partial<typeof DEFAULTS>> = {
  scalper: {
    entryTimeframe: "5m",
    htfTimeframe: "1h",
    tpRatio: 1.5,
    slBufferPips: 1,
    minConfluence: 5,
  },
  day_trader: {
    entryTimeframe: "15min",
    htfTimeframe: "1day",
    tpRatio: 2.0,
    slBufferPips: 2,
    minConfluence: 5.5,
  },
  swing_trader: {
    entryTimeframe: "1h",
    htfTimeframe: "1w",
    tpRatio: 3.0,
    slBufferPips: 5,
    minConfluence: 6.5,
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

// ─── Standalone ATR Calculation ─────────────────────────────────────
function calculateATR(candles: Candle[], period = 14): number {
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

// ─── Session-Anchored VWAP ─────────────────────────────────────────
// Anchors at the start of the current UTC day. Returns current VWAP, distance in pips,
// and whether the latest candle wicked through and rejected VWAP (for bonus).
interface VWAPResult { value: number | null; distancePips: number | null; rejection: "bullish" | "bearish" | null; barsAnchored: number; }
function calculateAnchoredVWAP(candles: Candle[], pipSize: number): VWAPResult {
  if (candles.length === 0 || pipSize <= 0) {
    return { value: null, distancePips: null, rejection: null, barsAnchored: 0 };
  }
  // Find anchor index = first candle whose UTC date matches the latest candle's UTC date
  const lastDate = candles[candles.length - 1].datetime.slice(0, 10);
  let anchorIdx = candles.length - 1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].datetime.slice(0, 10) === lastDate) anchorIdx = i; else break;
  }
  let pvSum = 0, vSum = 0;
  // Volume not available from Yahoo OHLC payload here; use range as proxy weight (high-low+epsilon).
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
  // Rejection wick: candle traded through VWAP but closed back on one side
  let rejection: "bullish" | "bearish" | null = null;
  if (last.low < value && last.close > value && (last.close - last.open) > 0) rejection = "bullish";
  else if (last.high > value && last.close < value && (last.open - last.close) > 0) rejection = "bearish";
  return { value, distancePips, rejection, barsAnchored: candles.length - anchorIdx };
}

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

function detectOptimalStyle(candles: Candle[], dailyCandles: Candle[]): string {
  if (candles.length < 20 || dailyCandles.length < 10) return "day_trader";

  // Calculate ATR from daily candles (14-period)
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

  // Trend strength: compare recent 5-day move vs ATR
  const recentClose = dailyCandles[dailyCandles.length - 1].close;
  const fiveDaysAgo = dailyCandles[Math.max(0, dailyCandles.length - 6)].close;
  const trendMove = Math.abs(recentClose - fiveDaysAgo);
  const trendStrength = atr > 0 ? trendMove / (atr * 5) : 0; // normalized

  // Low volatility + ranging → scalper
  if (atrPercent < 0.5 && trendStrength < 0.3) return "scalper";
  // High volatility + strong trend → swing
  if (atrPercent > 1.0 && trendStrength > 0.5) return "swing_trader";
  // Default
  return "day_trader";
}

// ─── DST-Aware New York Time Helper ─────────────────────────────────
// Converts UTC Date to New York local time components.
// US DST: 2nd Sunday of March 02:00 → 1st Sunday of November 02:00.
// During EST (Nov–Mar): NY = UTC − 5.  During EDT (Mar–Nov): NY = UTC − 4.
function toNYTime(utc: Date): { h: number; m: number; t: number; tMin: number; isEDT: boolean } {
  const year = utc.getUTCFullYear();
  // 2nd Sunday of March
  const mar1 = new Date(Date.UTC(year, 2, 1)); // March 1
  const marSun2 = 14 - mar1.getUTCDay(); // day-of-month of 2nd Sunday
  const edtStart = Date.UTC(year, 2, marSun2, 7, 0, 0); // 02:00 EST = 07:00 UTC
  // 1st Sunday of November
  const nov1 = new Date(Date.UTC(year, 10, 1)); // November 1
  const novSun1 = nov1.getUTCDay() === 0 ? 1 : 8 - nov1.getUTCDay();
  const edtEnd = Date.UTC(year, 10, novSun1, 6, 0, 0); // 02:00 EDT = 06:00 UTC
  const isEDT = utc.getTime() >= edtStart && utc.getTime() < edtEnd;
  const offsetH = isEDT ? 4 : 5;
  const nyMs = utc.getTime() - offsetH * 3600_000;
  const ny = new Date(nyMs);
  const h = ny.getUTCHours();
  const m = ny.getUTCMinutes();
  return { h, m, t: h + m / 60, tMin: h * 60 + m, isEDT };
}

// ─── Session Detection (DST-aware) ─────────────────────────────────
function detectSession(): { name: string; isKillZone: boolean } {
  const ny = toNYTime(new Date());
  const t = ny.t; // NY local decimal hours

  // All times below are in New York local time (auto-adjusts for EST/EDT).
  // Asian session: 20:00-00:00 NY (previous day evening in NY = Asian morning)
  if (t >= 20 || t < 0) {
    return { name: "Asian", isKillZone: false };
  }
  // Asian / Sydney overlap: 00:00-02:00 NY
  if (t >= 0 && t < 2) {
    return { name: "Asian", isKillZone: false };
  }
  // London session: 02:00-05:00 NY (London open = 7am GMT = 2am EST / 3am EDT)
  // London Kill Zone: 02:00-05:00 NY — this is the HIGH PROBABILITY window
  if (t >= 2 && t < 5) {
    return { name: "London", isKillZone: true };
  }
  // London continuation: 05:00-08:30 NY (London still open, but lower probability)
  if (t >= 5 && t < 8.5) {
    return { name: "London", isKillZone: false };
  }
  // New York Kill Zone: 08:30-11:00 NY (NY open, highest volume)
  if (t >= 8.5 && t < 11) {
    return { name: "New York", isKillZone: true };
  }
  // NY continuation / London close overlap: 11:00-12:00 NY
  // London Close Kill Zone: 10:00-12:00 NY (ICT London close)
  if (t >= 11 && t < 12) {
    return { name: "New York", isKillZone: true };
  }
  // NY afternoon: 12:00-16:00 NY (lower probability, PM session)
  if (t >= 12 && t < 16) {
    return { name: "New York", isKillZone: false };
  }
  // After hours: 16:00-20:00 NY
  return { name: "Off-Hours", isKillZone: false };
}

// ─── Silver Bullet Windows (DST-aware, NY local time) ────────────
// ICT Silver Bullet: 1-hour windows where FVG forms and fills.
//   London Open SB: 03:00-04:00 NY (London open manipulation)
//   AM SB:          10:00-11:00 NY (NY morning session)
//   PM SB:          14:00-15:00 NY (NY afternoon session)
interface SilverBulletResult { active: boolean; window: string | null; minutesRemaining: number; }
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
interface MacroWindowResult { active: boolean; window: string | null; minutesRemaining: number; }
function detectMacroWindow(): MacroWindowResult {
  const ny = toNYTime(new Date());
  const tMin = ny.tMin; // minutes since midnight NY local
  // All start/end in minutes since 00:00 NY local time
  const windows: { name: string; start: number; end: number }[] = [
    { name: "London Macro 1",    start:  2 * 60 + 33, end:  2 * 60 + 50 }, // 02:33-02:50 NY
    { name: "London Macro 2",    start:  4 * 60 +  3, end:  4 * 60 + 20 }, // 04:03-04:20 NY
    { name: "NY Pre-Open Macro", start:  8 * 60 + 50, end:  9 * 60 + 10 }, // 08:50-09:10 NY
    { name: "NY AM Macro",       start:  9 * 60 + 50, end: 10 * 60 + 10 }, // 09:50-10:10 NY
    { name: "London Close Macro",start: 10 * 60 + 50, end: 11 * 60 + 10 }, // 10:50-11:10 NY
    { name: "NY Lunch Macro",    start: 11 * 60 + 50, end: 12 * 60 + 10 }, // 11:50-12:10 NY
    { name: "Last Hour Macro",   start: 13 * 60 + 10, end: 13 * 60 + 40 }, // 13:10-13:40 NY
    { name: "PM Macro",          start: 15 * 60 + 15, end: 15 * 60 + 45 }, // 15:15-15:45 NY
  ];
  for (const w of windows) {
    if (tMin >= w.start && tMin < w.end) {
      return { active: true, window: w.name, minutesRemaining: w.end - tMin };
    }
  }
  return { active: false, window: null, minutesRemaining: 0 };
}

// ─── ICT AMD Phase Detection (DST-aware, NY local time) ───────────
// Splits candles into NY-local buckets:
//   Accumulation = Asian range (20:00-02:00 NY prev day evening into early morning)
//   Manipulation = London session (02:00-08:30 NY) sweeps Asian high or low
//   Distribution = NY session (08:30-16:00 NY) expands opposite the sweep
interface AMDResult {
  phase: "accumulation" | "manipulation" | "distribution" | "unknown";
  bias: "bullish" | "bearish" | null;
  asianHigh: number | null;
  asianLow: number | null;
  sweptSide: "high" | "low" | null;
  detail: string;
}
function detectAMDPhase(candles: Candle[]): AMDResult {
  if (candles.length < 5) return { phase: "unknown", bias: null, asianHigh: null, asianLow: null, sweptSide: null, detail: "Insufficient candles" };

  // Convert each candle's UTC datetime to NY local hour for bucketing
  const nyHourOf = (c: Candle): number => {
    const utc = new Date(c.datetime.endsWith("Z") ? c.datetime : c.datetime + "Z");
    return toNYTime(utc).h;
  };

  // Use recent candles for today's AMD analysis
  const recent = candles.slice(-200);
  // Asian accumulation: 20:00-02:00 NY (wraps midnight)
  const asian  = recent.filter(c => { const h = nyHourOf(c); return h >= 20 || h < 2; });
  // London manipulation: 02:00-09:00 NY
  const london = recent.filter(c => { const h = nyHourOf(c); return h >= 2 && h < 9; });
  // NY distribution: 09:00-16:00 NY
  const nyCandles = recent.filter(c => { const h = nyHourOf(c); return h >= 9 && h < 16; });

  const asianHigh = asian.length > 0 ? Math.max(...asian.map(c => c.high)) : null;
  const asianLow  = asian.length > 0 ? Math.min(...asian.map(c => c.low))  : null;

  // Determine sweep from London candles
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

  // Determine current phase from NY local clock + structure
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

// ─── SMT Divergence (Smart Money Tool) ─────────────────────────────
// Compares this pair's recent swing high/low against a positively-correlated pair.
// Bullish SMT: this pair makes a LOWER low while correlated pair does NOT (failure to confirm sell-side liquidity grab).
// Bearish SMT: this pair makes a HIGHER high while correlated pair does NOT (failure to confirm buy-side liquidity grab).
const SMT_PAIRS: Record<string, string> = {
  "EUR/USD": "GBP/USD", "GBP/USD": "EUR/USD",
  "USD/JPY": "USD/CHF", "USD/CHF": "USD/JPY",
  "AUD/USD": "NZD/USD", "NZD/USD": "AUD/USD",
  "XAU/USD": "XAG/USD", "XAG/USD": "XAU/USD",
  "BTC/USD": "ETH/USD", "ETH/USD": "BTC/USD",
};
interface SMTResult { detected: boolean; type: "bullish" | "bearish" | null; correlatedPair: string | null; detail: string; }
function detectSMTDivergence(symbol: string, candles: Candle[], correlatedCandles: Candle[]): SMTResult {
  const corrPair = SMT_PAIRS[symbol] || null;
  if (!corrPair) return { detected: false, type: null, correlatedPair: null, detail: "No SMT pair mapped" };
  if (candles.length < 30 || correlatedCandles.length < 30) {
    return { detected: false, type: null, correlatedPair: corrPair, detail: `Insufficient ${corrPair} data` };
  }

  // Use swing-point comparison (ICT methodology) instead of absolute extremes.
  // Find the last 2 swing lows and last 2 swing highs on each pair.
  const thisSwings = detectSwingPoints(candles, 3);
  const corrSwings = detectSwingPoints(correlatedCandles, 3);

  const thisHighs = thisSwings.filter(s => s.type === "high").slice(-3);
  const thisLows  = thisSwings.filter(s => s.type === "low").slice(-3);
  const corrHighs = corrSwings.filter(s => s.type === "high").slice(-3);
  const corrLows  = corrSwings.filter(s => s.type === "low").slice(-3);

  if (thisHighs.length < 2 || thisLows.length < 2 || corrHighs.length < 2 || corrLows.length < 2) {
    return { detected: false, type: null, correlatedPair: corrPair, detail: "Not enough swing points for SMT" };
  }

  // Bullish SMT: primary pair's latest swing low is LOWER than prior swing low,
  // but correlated pair's latest swing low is NOT lower (failed to confirm).
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

  // Bearish SMT: primary pair's latest swing high is HIGHER than prior swing high,
  // but correlated pair's latest swing high is NOT higher.
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

  // OTE (Optimal Trade Entry) zone: 62-79% retracement
  const oteZone = zonePercent >= 62 && zonePercent <= 79;

  return { currentZone, zonePercent, oteZone };
}

const YAHOO_SYMBOLS: Record<string, string> = {
  // Forex Majors
  "EUR/USD": "EURUSD=X", "GBP/USD": "GBPUSD=X", "USD/JPY": "USDJPY=X",
  "AUD/USD": "AUDUSD=X", "NZD/USD": "NZDUSD=X", "USD/CAD": "USDCAD=X",
  "USD/CHF": "USDCHF=X",
  // Forex Crosses
  "EUR/GBP": "EURGBP=X", "EUR/JPY": "EURJPY=X", "GBP/JPY": "GBPJPY=X",
  "EUR/AUD": "EURAUD=X", "EUR/CAD": "EURCAD=X", "EUR/CHF": "EURCHF=X",
  "EUR/NZD": "EURNZD=X", "GBP/AUD": "GBPAUD=X", "GBP/CAD": "GBPCAD=X",
  "GBP/CHF": "GBPCHF=X", "GBP/NZD": "GBPNZD=X", "AUD/CAD": "AUDCAD=X",
  "AUD/JPY": "AUDJPY=X", "CAD/JPY": "CADJPY=X",
  // FOTSI-only crosses (not in default instruments but needed for currency strength)
  "AUD/CHF": "AUDCHF=X", "AUD/NZD": "AUDNZD=X", "CAD/CHF": "CADCHF=X",
  "CHF/JPY": "CHFJPY=X", "NZD/CAD": "NZDCAD=X", "NZD/CHF": "NZDCHF=X",
  "NZD/JPY": "NZDJPY=X",
  // Indices
  "US30": "YM=F", "NAS100": "NQ=F", "SPX500": "ES=F",
  // Commodities
  "XAU/USD": "GC=F", "XAG/USD": "SI=F", "US Oil": "CL=F",
  // Crypto
  "BTC/USD": "BTC-USD", "ETH/USD": "ETH-USD",
};

// ─── Instrument Specifications ──────────────────────────────────────
const SPECS: Record<string, { pipSize: number; lotUnits: number; type: string }> = {
  // Forex Majors
  "EUR/USD": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "GBP/USD": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "USD/JPY": { pipSize: 0.01, lotUnits: 100000, type: "forex" },
  "AUD/USD": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "NZD/USD": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "USD/CAD": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "USD/CHF": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  // Forex Crosses
  "EUR/GBP": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "EUR/JPY": { pipSize: 0.01, lotUnits: 100000, type: "forex" },
  "GBP/JPY": { pipSize: 0.01, lotUnits: 100000, type: "forex" },
  "EUR/AUD": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "EUR/CAD": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "EUR/CHF": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "EUR/NZD": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "GBP/AUD": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "GBP/CAD": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "GBP/CHF": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "GBP/NZD": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "AUD/CAD": { pipSize: 0.0001, lotUnits: 100000, type: "forex" },
  "AUD/JPY": { pipSize: 0.01, lotUnits: 100000, type: "forex" },
  "CAD/JPY": { pipSize: 0.01, lotUnits: 100000, type: "forex" },
  // Indices
  "US30": { pipSize: 1.0, lotUnits: 1, type: "index" },
  "NAS100": { pipSize: 0.25, lotUnits: 1, type: "index" },
  "SPX500": { pipSize: 0.25, lotUnits: 1, type: "index" },
  // Commodities
  "XAU/USD": { pipSize: 0.01, lotUnits: 100, type: "commodity" },
  "XAG/USD": { pipSize: 0.001, lotUnits: 5000, type: "commodity" },
  "US Oil": { pipSize: 0.01, lotUnits: 1000, type: "commodity" },
  // Crypto
  "BTC/USD": { pipSize: 0.01, lotUnits: 1, type: "crypto" },
  "ETH/USD": { pipSize: 0.01, lotUnits: 1, type: "crypto" },
};

// ─── Asset-Class Trading Profiles ───────────────────────────────────
// Applied BEFORE style overrides — adjusts parameters based on asset behavior
const ASSET_PROFILES: Record<string, { slBufferMultiplier: number; proximityMultiplier: number; skipSessionGate: boolean; minConfluenceAdj: number }> = {
  forex:     { slBufferMultiplier: 1.0, proximityMultiplier: 1.0, skipSessionGate: false, minConfluenceAdj: 0 },
  index:     { slBufferMultiplier: 3.0, proximityMultiplier: 2.0, skipSessionGate: false, minConfluenceAdj: 0 },
  commodity: { slBufferMultiplier: 2.0, proximityMultiplier: 1.5, skipSessionGate: false, minConfluenceAdj: 0 },
  crypto:    { slBufferMultiplier: 2.0, proximityMultiplier: 1.5, skipSessionGate: true,  minConfluenceAdj: 0 },
};

function getAssetProfile(symbol: string) {
  const spec = SPECS[symbol];
  const type = spec?.type || "forex";
  return ASSET_PROFILES[type] || ASSET_PROFILES.forex;
}

// ─── Types ──────────────────────────────────────────────────────────
interface Candle { datetime: string; open: number; high: number; low: number; close: number; volume?: number; }
interface SwingPoint { index: number; price: number; type: "high" | "low"; datetime: string; }
interface OrderBlock { index: number; high: number; low: number; type: "bullish" | "bearish"; datetime: string; mitigated: boolean; mitigatedPercent: number; }
interface FairValueGap { index: number; high: number; low: number; type: "bullish" | "bearish"; datetime: string; mitigated: boolean; }
interface LiquidityPool { price: number; type: "buy-side" | "sell-side"; strength: number; datetime: string; swept: boolean; }
interface ReasoningFactor { name: string; present: boolean; weight: number; detail: string; group?: string; }
interface DisplacementCandle { index: number; bodyRatio: number; rangeMultiple: number; direction: "bullish" | "bearish"; }
interface DisplacementResult { isDisplacement: boolean; displacementCandles: DisplacementCandle[]; lastDirection: "bullish" | "bearish" | null; }

// ─── Displacement Detection ─────────────────────────────────────────
function detectDisplacement(candles: Candle[]): DisplacementResult {
  if (candles.length < 25) return { isDisplacement: false, displacementCandles: [], lastDirection: null };
  const window = candles.slice(-21, -1); // last 20 prior candles
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

function tagDisplacementQuality(
  orderBlocks: OrderBlock[],
  fvgs: FairValueGap[],
  displacementCandles: DisplacementCandle[],
) {
  for (const ob of orderBlocks) {
    const hasNearby = displacementCandles.some(d => d.index > ob.index && d.index <= ob.index + 3);
    (ob as any).hasDisplacement = hasNearby;
  }
  for (const fvg of fvgs) {
    // FVG middle candle is at fvg.index (we store index of middle/c2 candle)
    const createdByDisp = displacementCandles.some(d => d.index === fvg.index);
    (fvg as any).hasDisplacement = createdByDisp;
  }
}

// ─── SMC Analysis Functions ─────────────────────────────────────────

function detectSwingPoints(candles: Candle[], lookback = 3): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, price: candles[i].high, type: "high", datetime: candles[i].datetime });
    if (isLow) swings.push({ index: i, price: candles[i].low, type: "low", datetime: candles[i].datetime });
  }
  return swings;
}

function analyzeMarketStructure(candles: Candle[]) {
  const swings = detectSwingPoints(candles);
  const highs = swings.filter(s => s.type === "high"), lows = swings.filter(s => s.type === "low");
  let currentTrend = "ranging";
  const bos: any[] = [], choch: any[] = [];

  for (let i = 1; i < highs.length; i++) {
    if (highs[i].price > highs[i - 1].price) {
      if (currentTrend === "bearish") choch.push({ index: highs[i].index, type: "bullish", price: highs[i].price, datetime: highs[i].datetime });
      else bos.push({ index: highs[i].index, type: "bullish", price: highs[i].price, datetime: highs[i].datetime });
      currentTrend = "bullish";
    }
  }
  for (let i = 1; i < lows.length; i++) {
    if (lows[i].price < lows[i - 1].price) {
      if (currentTrend === "bullish") choch.push({ index: lows[i].index, type: "bearish", price: lows[i].price, datetime: lows[i].datetime });
      else bos.push({ index: lows[i].index, type: "bearish", price: lows[i].price, datetime: lows[i].datetime });
      currentTrend = "bearish";
    }
  }

  let trend: "bullish" | "bearish" | "ranging" = "ranging";
  if (highs.length >= 2 && lows.length >= 2) {
    const rH = highs.slice(-2), rL = lows.slice(-2);
    if (rH[1].price > rH[0].price && rL[1].price > rL[0].price) trend = "bullish";
    else if (rH[1].price < rH[0].price && rL[1].price < rL[0].price) trend = "bearish";
  }
  return { trend, swingPoints: swings, bos, choch };
}

function detectOrderBlocks(
  candles: Candle[],
  structureBreaks?: { index: number; type: string }[],
): OrderBlock[] {
  const OB_RECENCY = 50; // only keep OBs from the last N candles
  const OB_CAP = 5;      // max OBs to return
  const BREAK_LOOKAHEAD = 10; // structure break must occur within N candles after OB
  const recencyStart = Math.max(2, candles.length - OB_RECENCY);

  const candidates: (OrderBlock & { quality: number })[] = [];
  for (let i = recencyStart; i < candles.length; i++) {
    const prev = candles[i - 1], curr = candles[i];

    // Bullish OB: last bearish candle before a bullish engulf that closes above prior high
    if (prev.close < prev.open && curr.close > curr.open && curr.close > prev.high) {
      // Use candle body (open-to-close) for OB zone per ICT methodology
      const obHigh = Math.max(prev.open, prev.close); // = prev.open (bearish candle)
      const obLow = Math.min(prev.open, prev.close);   // = prev.close
      const ob: OrderBlock & { quality: number } = {
        index: i - 1, high: obHigh, low: obLow, type: "bullish",
        datetime: prev.datetime, mitigated: false, mitigatedPercent: 0, quality: 0,
      };

      // Check mitigation (price returns to 50% of OB body)
      for (let j = i + 1; j < candles.length; j++) {
        const mid = (ob.high + ob.low) / 2;
        if (candles[j].low <= mid) {
          ob.mitigatedPercent = Math.min(100, ((ob.high - candles[j].low) / (ob.high - ob.low)) * 100);
          if (ob.mitigatedPercent >= 50) ob.mitigated = true;
          break;
        }
      }

      // Quality scoring: structure break requirement
      if (structureBreaks && structureBreaks.length > 0) {
        const hasBreak = structureBreaks.some(b =>
          b.type === "bullish" && b.index > ob.index && b.index <= ob.index + BREAK_LOOKAHEAD
        );
        if (hasBreak) ob.quality += 2;
      } else {
        ob.quality += 1; // no structure data available — don't penalize
      }

      // Recency bonus (newer OBs score higher)
      ob.quality += (ob.index - recencyStart) / OB_RECENCY;

      candidates.push(ob);
    }

    // Bearish OB: last bullish candle before a bearish engulf that closes below prior low
    if (prev.close > prev.open && curr.close < curr.open && curr.close < prev.low) {
      const obHigh = Math.max(prev.open, prev.close); // = prev.close (bullish candle)
      const obLow = Math.min(prev.open, prev.close);   // = prev.open
      const ob: OrderBlock & { quality: number } = {
        index: i - 1, high: obHigh, low: obLow, type: "bearish",
        datetime: prev.datetime, mitigated: false, mitigatedPercent: 0, quality: 0,
      };

      // Check mitigation
      for (let j = i + 1; j < candles.length; j++) {
        const mid = (ob.high + ob.low) / 2;
        if (candles[j].high >= mid) {
          ob.mitigatedPercent = Math.min(100, ((candles[j].high - ob.low) / (ob.high - ob.low)) * 100);
          if (ob.mitigatedPercent >= 50) ob.mitigated = true;
          break;
        }
      }

      // Quality scoring: structure break requirement
      if (structureBreaks && structureBreaks.length > 0) {
        const hasBreak = structureBreaks.some(b =>
          b.type === "bearish" && b.index > ob.index && b.index <= ob.index + BREAK_LOOKAHEAD
        );
        if (hasBreak) ob.quality += 2;
      } else {
        ob.quality += 1;
      }

      ob.quality += (ob.index - recencyStart) / OB_RECENCY;

      candidates.push(ob);
    }
  }

  // Sort by quality descending, then by recency (index) descending
  candidates.sort((a, b) => b.quality - a.quality || b.index - a.index);

  // Cap at OB_CAP most relevant OBs
  return candidates.slice(0, OB_CAP).map(({ quality, ...ob }) => ob);
}

interface BreakerBlock {
  type: "bullish_breaker" | "bearish_breaker";
  high: number;
  low: number;
  mitigatedAt: number;
  originalOBType: "bullish" | "bearish";
  isActive: boolean;
}

interface UnicornSetup {
  type: "bullish_unicorn" | "bearish_unicorn";
  breakerHigh: number;
  breakerLow: number;
  fvgHigh: number;
  fvgLow: number;
  overlapHigh: number;
  overlapLow: number;
}

function detectBreakerBlocks(orderBlocks: OrderBlock[], candles: Candle[]): BreakerBlock[] {
  const breakers: BreakerBlock[] = [];
  for (const ob of orderBlocks) {
    if (!ob.mitigated) continue;
    // A bullish OB that broke = bearish breaker (former support is now resistance)
    // A bearish OB that broke = bullish breaker (former resistance is now support)
    const breakerType: "bullish_breaker" | "bearish_breaker" =
      ob.type === "bullish" ? "bearish_breaker" : "bullish_breaker";

    // Find first candle index after the OB where the OB was clearly broken
    // (close beyond OB body indicates mitigation/break)
    let mitigatedAt = ob.index;
    for (let j = ob.index + 1; j < candles.length; j++) {
      if (ob.type === "bullish" && candles[j].close < ob.low) { mitigatedAt = j; break; }
      if (ob.type === "bearish" && candles[j].close > ob.high) { mitigatedAt = j; break; }
    }

    // Check if the breaker zone has already been retested and rejected after mitigation
    let isActive = true;
    for (let j = mitigatedAt + 1; j < candles.length; j++) {
      const c = candles[j];
      const enteredZone = c.high >= ob.low && c.low <= ob.high;
      if (!enteredZone) continue;
      if (breakerType === "bearish_breaker") {
        // expected to reject down — if a later candle closed back below ob.low, it was used
        if (c.close < ob.low) { isActive = false; break; }
      } else {
        if (c.close > ob.high) { isActive = false; break; }
      }
    }

    breakers.push({
      type: breakerType,
      high: ob.high,
      low: ob.low,
      mitigatedAt,
      originalOBType: ob.type,
      isActive,
    });
  }
  return breakers.filter(b => b.isActive);
}

function detectUnicornSetups(breakerBlocks: BreakerBlock[], fvgs: FairValueGap[]): UnicornSetup[] {
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
          breakerHigh: breaker.high,
          breakerLow: breaker.low,
          fvgHigh: fvg.high,
          fvgLow: fvg.low,
          overlapHigh,
          overlapLow,
        });
      }
    }
  }
  return unicorns;
}

function detectFVGs(candles: Candle[]): FairValueGap[] {
  const fvgs: FairValueGap[] = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i];
    if (c3.low > c1.high && c2.close > c2.open) {
      const fvg: FairValueGap = { index: i - 1, high: c3.low, low: c1.high, type: "bullish", datetime: c2.datetime, mitigated: false };
      for (let j = i + 1; j < candles.length; j++) { if (candles[j].low <= fvg.low) { fvg.mitigated = true; break; } }
      fvgs.push(fvg);
    }
    if (c1.low > c3.high && c2.close < c2.open) {
      const fvg: FairValueGap = { index: i - 1, high: c1.low, low: c3.high, type: "bearish", datetime: c2.datetime, mitigated: false };
      for (let j = i + 1; j < candles.length; j++) { if (candles[j].high >= fvg.high) { fvg.mitigated = true; break; } }
      fvgs.push(fvg);
    }
  }
  return fvgs;
}

function detectLiquidityPools(candles: Candle[], tolerance = 0.001): LiquidityPool[] {
  const pools: LiquidityPool[] = [];
  const priceRange = Math.max(...candles.map(c => c.high)) - Math.min(...candles.map(c => c.low));
  const tol = priceRange * tolerance;
  const last = candles[candles.length - 1];
  const usedH = new Set<number>(), usedL = new Set<number>();

  for (let i = 0; i < candles.length; i++) {
    if (usedH.has(i)) continue;
    let count = 1;
    for (let j = i + 1; j < candles.length; j++) {
      if (usedH.has(j)) continue;
      if (Math.abs(candles[i].high - candles[j].high) <= tol) { count++; usedH.add(j); }
    }
    if (count >= 2) pools.push({ price: candles[i].high, type: "buy-side", strength: count, datetime: candles[i].datetime, swept: last.high > candles[i].high });
  }
  for (let i = 0; i < candles.length; i++) {
    if (usedL.has(i)) continue;
    let count = 1;
    for (let j = i + 1; j < candles.length; j++) {
      if (usedL.has(j)) continue;
      if (Math.abs(candles[i].low - candles[j].low) <= tol) { count++; usedL.add(j); }
    }
    if (count >= 2) pools.push({ price: candles[i].low, type: "sell-side", strength: count, datetime: candles[i].datetime, swept: last.low < candles[i].low });
  }
  return pools.sort((a, b) => b.strength - a.strength);
}

function detectJudasSwing(candles: Candle[]): { detected: boolean; type: "bullish" | "bearish" | null; confirmed: boolean; description: string } {
  const none = { detected: false, type: null as any, confirmed: false, description: "No Judas Swing" };
  if (candles.length < 20) return none;
  const recent = candles.slice(-20);
  const midnightOpen = recent[0].open;
  const range = Math.max(...recent.map(c => c.high)) - Math.min(...recent.map(c => c.low));
  const firstHalf = recent.slice(0, 10);
  const secondHalf = recent.slice(10);
  const currentClose = recent[recent.length - 1].close;

  // Check for bullish Judas: price drops below open then reverses above
  const firstHalfLow = Math.min(...firstHalf.map(c => c.low));
  const dropBelow = midnightOpen - firstHalfLow;
  if (dropBelow > range * 0.3 && currentClose > midnightOpen) {
    return { detected: true, type: "bullish", confirmed: true, description: `Bullish Judas: false break below ${midnightOpen.toFixed(5)}, reversed above` };
  }

  // Check for bearish Judas: price spikes above open then reverses below
  const firstHalfHigh = Math.max(...firstHalf.map(c => c.high));
  const spikeAbove = firstHalfHigh - midnightOpen;
  if (spikeAbove > range * 0.3 && currentClose < midnightOpen) {
    return { detected: true, type: "bearish", confirmed: true, description: `Bearish Judas: false break above ${midnightOpen.toFixed(5)}, reversed below` };
  }

  return none;
}

function detectReversalCandle(candles: Candle[]): { detected: boolean; type: "bullish" | "bearish" | null } {
  if (candles.length < 2) return { detected: false, type: null };
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const bodySize = Math.abs(last.close - last.open);
  const totalRange = last.high - last.low;
  if (totalRange === 0) return { detected: false, type: null };

  // Pin bar: body < 30% of range, wick > 60% of range
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  // Bullish pin bar
  if (bodySize / totalRange < 0.3 && lowerWick / totalRange > 0.6 && last.close > last.open) {
    return { detected: true, type: "bullish" };
  }
  // Bearish pin bar
  if (bodySize / totalRange < 0.3 && upperWick / totalRange > 0.6 && last.close < last.open) {
    return { detected: true, type: "bearish" };
  }

  // Bullish engulfing
  if (prev.close < prev.open && last.close > last.open && last.open <= prev.close && last.close >= prev.open) {
    return { detected: true, type: "bullish" };
  }
  // Bearish engulfing
  if (prev.close > prev.open && last.close < last.open && last.open >= prev.close && last.close <= prev.open) {
    return { detected: true, type: "bearish" };
  }

  return { detected: false, type: null };
}

function calculatePDLevels(dailyCandles: Candle[]) {
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

// ─── Opening Range ──────────────────────────────────────────────────
interface OpeningRangeResult { high: number; low: number; midpoint: number; completed: boolean; }

function computeOpeningRange(hourlyCandles: Candle[], candleCount: number): OpeningRangeResult | null {
  if (!hourlyCandles || hourlyCandles.length === 0) return null;
  // Get the start of the current UTC trading day
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const todayCandles = hourlyCandles.filter(c => c.datetime >= todayStart);
  if (todayCandles.length === 0) return null;
  const orCandles = todayCandles.slice(0, candleCount);
  const high = Math.max(...orCandles.map(c => c.high));
  const low = Math.min(...orCandles.map(c => c.low));
  return { high, low, midpoint: (high + low) / 2, completed: todayCandles.length >= candleCount };
}

// ─── Full SL/TP Calculation Dispatch ────────────────────────────────
interface SLTPInput {
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

function calculateSLTP(input: SLTPInput): { stopLoss: number | null; takeProfit: number | null } {
  const { direction, lastPrice, pipSize, config, swings, orderBlocks, liquidityPools, pdLevels, atrValue } = input;
  if (!direction) return { stopLoss: null, takeProfit: null };

  const buffer = (config.slBufferPips || 2) * pipSize;
  let sl: number | null = null;
  let tp: number | null = null;

  // ── Stop Loss ──
  const slMethod: string = config.slMethod || "structure";

  if (slMethod === "fixed_pips") {
    const dist = (config.fixedSLPips || 25) * pipSize;
    sl = direction === "long" ? lastPrice - dist : lastPrice + dist;
  } else if (slMethod === "atr_based") {
    if (atrValue > 0) {
      const dist = atrValue * (config.slATRMultiple || 1.5);
      sl = direction === "long" ? lastPrice - dist : lastPrice + dist;
    } else {
      // Fallback to fixed_pips
      const dist = (config.fixedSLPips || 25) * pipSize;
      sl = direction === "long" ? lastPrice - dist : lastPrice + dist;
    }
  } else if (slMethod === "below_ob") {
    if (direction === "long") {
      const bullishOBs = orderBlocks
        .filter(ob => !ob.mitigated && ob.type === "bullish" && ob.low < lastPrice)
        .sort((a, b) => b.low - a.low);
      if (bullishOBs.length > 0) {
        sl = bullishOBs[0].low - buffer;
      }
    } else {
      const bearishOBs = orderBlocks
        .filter(ob => !ob.mitigated && ob.type === "bearish" && ob.high > lastPrice)
        .sort((a, b) => a.high - b.high);
      if (bearishOBs.length > 0) {
        sl = bearishOBs[0].high + buffer;
      }
    }
    // Fallback to fixed_pips if no OB found
    if (sl === null) {
      const dist = (config.fixedSLPips || 25) * pipSize;
      sl = direction === "long" ? lastPrice - dist : lastPrice + dist;
    }
  } else {
    // Default: structure-based
    if (direction === "long") {
      const recentLows = swings.filter(s => s.type === "low" && s.price < lastPrice).slice(-3);
      if (recentLows.length > 0) {
        const nearestLow = Math.max(...recentLows.map(s => s.price));
        sl = nearestLow - buffer;
      }
    } else {
      const recentHighs = swings.filter(s => s.type === "high" && s.price > lastPrice).slice(-3);
      if (recentHighs.length > 0) {
        const nearestHigh = Math.min(...recentHighs.map(s => s.price));
        sl = nearestHigh + buffer;
      }
    }
    // Fallback to fixed_pips if no swing found
    if (sl === null) {
      const dist = (config.fixedSLPips || 25) * pipSize;
      sl = direction === "long" ? lastPrice - dist : lastPrice + dist;
    }
  }

  // ── Take Profit ──
  const tpMethod: string = config.tpMethod || "rr_ratio";
  const slDistance = Math.abs(lastPrice - sl);

  if (tpMethod === "fixed_pips") {
    const dist = (config.fixedTPPips || 50) * pipSize;
    tp = direction === "long" ? lastPrice + dist : lastPrice - dist;
  } else if (tpMethod === "next_level") {
    // Target nearest PD/PW level or liquidity pool
    const targets: number[] = [];
    if (direction === "long") {
      if (pdLevels) {
        if (pdLevels.pdh > lastPrice) targets.push(pdLevels.pdh);
        if (pdLevels.pwh > lastPrice) targets.push(pdLevels.pwh);
      }
      liquidityPools
        .filter(lp => lp.type === "buy-side" && lp.price > lastPrice && lp.strength >= 2)
        .forEach(lp => targets.push(lp.price));
      targets.sort((a, b) => a - b); // nearest first
    } else {
      if (pdLevels) {
        if (pdLevels.pdl < lastPrice) targets.push(pdLevels.pdl);
        if (pdLevels.pwl < lastPrice) targets.push(pdLevels.pwl);
      }
      liquidityPools
        .filter(lp => lp.type === "sell-side" && lp.price < lastPrice && lp.strength >= 2)
        .forEach(lp => targets.push(lp.price));
      targets.sort((a, b) => b - a); // nearest first (descending)
    }
    if (targets.length > 0) {
      tp = targets[0];
    } else {
      // Fallback to fixed_pips
      const dist = (config.fixedTPPips || 50) * pipSize;
      tp = direction === "long" ? lastPrice + dist : lastPrice - dist;
    }
  } else if (tpMethod === "atr_multiple") {
    if (atrValue > 0) {
      const dist = atrValue * (config.tpATRMultiple || 2.0);
      tp = direction === "long" ? lastPrice + dist : lastPrice - dist;
    } else {
      // Fallback to rr_ratio
      tp = direction === "long"
        ? lastPrice + slDistance * (config.tpRatio || 2.0)
        : lastPrice - slDistance * (config.tpRatio || 2.0);
    }
  } else {
    // Default: rr_ratio
    tp = direction === "long"
      ? lastPrice + slDistance * (config.tpRatio || 2.0)
      : lastPrice - slDistance * (config.tpRatio || 2.0);
  }

return { stopLoss: sl, takeProfit: tp };
}

/**
 * ─── CONFLUENCE FACTOR AUDIT (20 factors + OR enhancements) ──────────────
 * 9 Factor Groups with anti-double-count rules and group caps.
 * Final score is clamped to 0–10 via Math.min(10, score).
 *
 * GROUP 1: Market Structure (cap 3.0)
 *  1  | BOS/CHoCH              | 1.5  | Structure breaks only
 * 19  | Trend Direction        | 1.5  | Entry TF trend alignment (-0.5 counter)
 *
 * GROUP 2: Daily Bias (cap 1.5)
 * 20  | Daily Bias (HTF)       | 1.5  | Daily trend alignment (-0.5 counter)
 *
 * GROUP 3: Order Flow Zones (cap 3.0)
 *  2  | Order Block            | 2.0  | Quality-gated
 *  3  | Fair Value Gap         | 2.0  | CE level check (2.0 at CE, 1.5 inside)
 * 11  | Breaker Block          | 1.0  | Proximity-gated
 * 12  | Unicorn Model          | 1.5  | Absorbs Breaker + FVG when active
 *
 * GROUP 4: Premium/Discount & Fibonacci (cap 2.5)
 *  4  | P/D + Fibonacci        | 2.0  | OTE sweet spot (70.5%) = 2.0
 *  7  | PD/PW Levels           | 1.0  | Weekly/daily high-low proximity
 *
 * GROUP 5: Timing (cap 1.5)
 *  5  | Session/Kill Zone      | 1.0  | Absorbed by SB when active
 * 13  | Silver Bullet          | 1.0  | Absorbs Kill Zone (+0.5 boost)
 * 14  | Macro Window           | 0.5  | Reduced to 0.25 during Kill Zone
 *
 * GROUP 6: Price Action (cap 2.0)
 *  6  | Judas Swing            | 0.5  | Absorbed by AMD combo
 *  8  | Reversal Candle        | 0.5  | Context-aware
 *  9  | Liquidity Sweep        | 1.0  | Strength-tiered
 * 10  | Displacement           | 1.0  | Reduced to 0.5 when FVG scored
 *
 * GROUP 7: AMD / Power of 3 (cap 1.5)
 * 17  | AMD Phase              | 1.0  | +0.5 distribution bonus
 *  —  | Power of 3 Combo       | +1.0 | AMD + Sweep/Judas + Trend aligned
 *
 * GROUP 8: Macro Confirmation (cap 2.0)
 * 15  | SMT Divergence         | 1.0  | Swing-point-based
 * 18  | Currency Strength      | 1.5  | FOTSI alignment (-0.5 to +1.5)
 *
 * GROUP 9: Volume Profile (cap 1.5)
 * 16  | Volume Profile         | 1.5  | TPO-based POC/HVN/LVN + cross-validation
 *
 * Anti-double-count rules:
 *  - Unicorn fires → Breaker=0, FVG=0
 *  - Displacement+FVG overlap → Displacement reduced to 0.5
 *  - OB+FVG same zone → cap combined at 3.0
 *  - Silver Bullet fires → Kill Zone=0, SB boosted to 1.5
 *  - AMD+Sweep fires → Judas=0
 *  - Macro during Kill Zone → Macro reduced to 0.25
 *
 * TOTAL GROUP CAPS SUM = 18.5 (clamped to 10)
 *
 * Recommended thresholds on the 0-10 scale (post-clamp):
 *   5.5–6.5 = balanced default · 7.0+ = A+ only · <5.0 = looser scalp mode
 */
function runFullConfluenceAnalysis(candles: Candle[], dailyCandles: Candle[] | null, config: any, hourlyCandles?: Candle[]) {
  const structure = analyzeMarketStructure(candles);
  const structureBreaks = [...structure.bos, ...structure.choch];
  let orderBlocks = detectOrderBlocks(candles, structureBreaks);
  const fvgs = detectFVGs(candles);

  // FVG adjacency bonus: tag OBs that have an FVG within 5 candles
  // This doesn't filter them out, but boosts quality for Factor 2 detail
  for (const ob of orderBlocks) {
    const hasFVGNearby = fvgs.some(f => Math.abs(f.index - ob.index) <= 5);
    (ob as any).hasFVGAdjacency = hasFVGNearby;
  }
  const liquidityPools = detectLiquidityPools(candles);
  const judasSwing = detectJudasSwing(candles);
  const reversalCandle = detectReversalCandle(candles);
  const pd = calculatePremiumDiscount(candles);
  const session = detectSession();
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
    score += pts;
    factors.push({ name: "Market Structure", present: pts > 0, weight: 1.5, detail, group: "Market Structure" });
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
    score += pts;
    factors.push({ name: "Order Block", present: pts > 0, weight: 2.0, detail: detail || "No active order blocks", group: "Order Flow Zones" });
  }

  // ── Factor 3: Fair Value Gap (max 2.0) ──
  // Displacement is scored ONLY via Factor 10 to avoid double-counting.
  // ICT: Consequent Encroachment (CE) = 50% of FVG is a key entry level.
  {
    let pts = 0;
    let detail = "";
    if (config.enableFVG !== false) {
      const activeFVGs = fvgs.filter(f => !f.mitigated);
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
        detail = `${activeFVGs.length} unfilled FVGs in range`;
      }
    } else {
      detail = "FVGs disabled";
    }
    score += pts;
    factors.push({ name: "Fair Value Gap", present: pts > 0, weight: 2.0, detail: detail || "No active FVGs", group: "Order Flow Zones" });
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

    score += pts;
    factors.push({ name: "Premium/Discount & Fib", present: pts > 0, weight: 2.0, detail, group: "Premium/Discount & Fib" });
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
    score += pts;
    factors.push({ name: "Session/Kill Zone", present: pts > 0, weight: 1.0, detail, group: "Timing" });
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
    score += pts;
    factors.push({ name: "Judas Swing", present: pts > 0, weight: 0.5, detail, group: "Price Action" });
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
    score += pts;
    factors.push({ name: "PD/PW Levels", present: pts > 0, weight: 1.0, detail, group: "Premium/Discount & Fib" });
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
    score += pts;
    factors.push({ name: "Reversal Candle", present: pts > 0, weight: 0.5, detail, group: "Price Action" });
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
    score += pts;
    factors.push({ name: "Liquidity Sweep", present: pts > 0, weight: 1.0, detail, group: "Price Action" });
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
  {
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
    score += pts;
    factors.push({ name: "Trend Direction", present: pts > 0, weight: 1.5, detail, group: "Market Structure" });
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
    score += pts;
    factors.push({ name: "Displacement", present: pts > 0, weight: 1.0, detail, group: "Price Action" });
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
    score += pts;
    factors.push({ name: "Breaker Block", present: pts > 0, weight: 1.0, detail, group: "Order Flow Zones" });
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
    score += pts;
    factors.push({ name: "Unicorn Model", present: pts > 0, weight: 1.5, detail, group: "Order Flow Zones" });
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
    score += pts;
    factors.push({ name: "Silver Bullet", present: pts > 0, weight: 1.0, detail, group: "Timing" });
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
    score += pts;
    factors.push({ name: "Macro Window", present: pts > 0, weight: 1.0, detail, group: "Timing" });
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
    score += pts;
    factors.push({ name: "SMT Divergence", present: pts > 0, weight: 1.0, detail, group: "Macro Confirmation" });
  }

  // ── Factor 16: Volume Profile (max 1.5) ──
  // Replaces VWAP. Uses Time-at-Price (TPO) histogram to identify POC, HVN, LVN.
  // Validates OBs and FVGs with price-time data.
  const volumeProfile = computeVolumeProfile(candles);
  {
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
    score += pts;
    factors.push({ name: "Volume Profile", present: pts > 0, weight: 1.5, detail, group: "Volume Profile" });
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
    score += pts;
    factors.push({ name: "AMD Phase", present: pts > 0, weight: 1.0, detail, group: "AMD / Power of 3" });
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
    score += pts;
    factors.push({ name: "Currency Strength", present: pts !== 0, weight: 1.5, detail, group: "Macro Confirmation" });
  }

  // ── Factor 20: Daily Bias / HTF Trend (max 1.5) ──
  // Scores whether the daily timeframe trend aligns with the trade direction.
  // Promoted from safety gate to scored factor — trend alignment is a core confluence.
  {
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
    score += pts;
    factors.push({ name: "Daily Bias", present: pts > 0, weight: 1.5, detail, group: "Daily Bias" });
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
    fotsiAlignment: _fotsiAlignment, volumeProfile,
  };
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

// ─── Position sizing ────────────────────────────────────────────────
function calculatePositionSize(balance: number, riskPercent: number, entryPrice: number, stopLoss: number, symbol: string): number {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  const riskAmount = balance * (riskPercent / 100);
  const slDistance = Math.abs(entryPrice - stopLoss);
  if (slDistance === 0) return 0.01;
  const lots = riskAmount / (slDistance * spec.lotUnits);
  // Scale max lot by asset type
  const maxLot = spec.type === "index" ? 50 : spec.type === "commodity" ? 10 : spec.type === "crypto" ? 100 : 5;
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
    // Premium/Discount filters (legacy DB keys)
    onlyBuyInDiscount: strategy.onlyBuyInDiscount ?? DEFAULTS.onlyBuyInDiscount,
    onlySellInPremium: strategy.onlySellInPremium ?? DEFAULTS.onlySellInPremium,

    // ── Risk mappings ──
    riskPerTrade: risk.riskPerTrade ?? raw.riskPerTrade ?? DEFAULTS.riskPerTrade,
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
    enabledSessions: Array.isArray(sessions.filter) && sessions.filter.length > 0
      ? sessions.filter
      : sessions.asianEnabled !== undefined
        ? [
            ...(sessions.asianEnabled ? ["asian"] : []),
            ...(sessions.londonEnabled ? ["london"] : []),
            ...(sessions.newYorkEnabled || sessions.newyorkEnabled ? ["newyork"] : []),
            ...(sessions.sydneyEnabled ? ["sydney"] : []),
          ]
        : (Array.isArray(raw.enabledSessions) ? raw.enabledSessions : DEFAULTS.enabledSessions),
    killZoneOnly: sessions.killZoneOnly ?? false,

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

    // ── Spread Filter ──
    spreadFilterEnabled: instruments.spreadFilterEnabled ?? raw.spreadFilterEnabled ?? DEFAULTS.spreadFilterEnabled,
    maxSpreadPips: instruments.maxSpreadPips ?? raw.maxSpreadPips ?? DEFAULTS.maxSpreadPips,

    // ── News Event Filter ──
    newsFilterEnabled: sessions.newsFilterEnabled ?? raw.newsFilterEnabled ?? DEFAULTS.newsFilterEnabled,
    newsFilterPauseMinutes: sessions.newsFilterPauseMinutes ?? raw.newsFilterPauseMinutes ?? DEFAULTS.newsFilterPauseMinutes,
  };

  return merged;
}

// ─── Safety Gates ───────────────────────────────────────────────────
interface GateResult { passed: boolean; reason: string; }

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
  if (sameDirectionExists) {
    gates.push({ passed: false, reason: `Already ${direction} on ${symbol} — no duplicate` });
  } else if (symbolPositions >= config.maxPerSymbol) {
    gates.push({ passed: false, reason: `Max ${config.maxPerSymbol} positions for ${symbol} reached` });
  } else {
    gates.push({ passed: true, reason: `${symbolPositions}/${config.maxPerSymbol} for ${symbol}` });
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

  // Gate 10: Min R:R
  if (analysis.stopLoss && analysis.takeProfit) {
    const risk = Math.abs(analysis.lastPrice - analysis.stopLoss);
    const reward = Math.abs(analysis.takeProfit - analysis.lastPrice);
    const rr = risk > 0 ? reward / risk : 0;
    if (rr < config.minRiskReward) {
      gates.push({ passed: false, reason: `R:R ${rr.toFixed(2)} < ${config.minRiskReward} minimum` });
    } else {
      gates.push({ passed: true, reason: `R:R ${rr.toFixed(2)}` });
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
      const sess = detectSession();
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

  return gates;
}

// ─── Main Handler ───────────────────────────────────────────────────
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
  const styleMode = config.tradingStyle?.mode || "day_trader";
  let resolvedStyle = styleMode === "auto" ? "day_trader" : styleMode; // default, may be overridden per-instrument in auto mode
  const isAutoStyle = styleMode === "auto" || config.tradingStyle?.autoDetectEnabled;

  // Apply style overrides to config (non-auto mode applies globally)
  // Preserve user-set minConfluence — style overrides should not overwrite it
  if (!isAutoStyle && STYLE_OVERRIDES[resolvedStyle]) {
    const userMinConfluence = config.minConfluence;
    Object.assign(config, STYLE_OVERRIDES[resolvedStyle]);
    config.minConfluence = userMinConfluence;
  }

  // Day-of-week check — skip for crypto-only instrument lists
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun
  const hasCrypto = config.instruments.some((s: string) => SPECS[s]?.type === "crypto");
  const hasNonCrypto = config.instruments.some((s: string) => SPECS[s]?.type !== "crypto");
  // Only block weekends if there are non-crypto instruments (crypto trades 24/7)
  if (!config.enabledDays.includes(dayOfWeek) && !hasCrypto) {
    return { pairsScanned: 0, signalsFound: 0, tradesPlaced: 0, skippedReason: "Day not enabled", activeStyle: resolvedStyle };
  }
  const session = detectSession();
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
    const pairAssetProfile = getAssetProfile(pair);
    if (!pairAssetProfile.skipSessionGate && config.enabledSessions.length > 0 && !config.enabledSessions.includes(normalizedSession)) {
      scanDetails.push({ pair, status: "skipped", reason: `${session.name} session not enabled for ${pair}` });
      continue;
    }

    // Skip non-crypto instruments on weekends (Fix #2)
    if (!config.enabledDays.includes(dayOfWeek) && SPECS[pair]?.type !== "crypto") {
      scanDetails.push({ pair, status: "skipped", reason: "Weekend — non-crypto skipped" });
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

    // Auto-detect style per instrument if in auto mode (Fix #6 — clone, don't mutate)
    let pairStyle = resolvedStyle;
    if (isAutoStyle) {
      pairStyle = detectOptimalStyle(candles, dailyCandles);
      pairConfig = { ...pairConfig, ...STYLE_OVERRIDES[pairStyle] };
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
      tradingStyle: pairStyle,
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

        const size = calculatePositionSize(balance, pairConfig.riskPerTrade, analysis.lastPrice, sl, pair);
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
            const oppPnl = oppDiff * oppSpec.lotUnits * oppSize;
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
        const exitFlags = {
          trailingStop: pairConfig.trailingStopEnabled,
          trailingStopPips: pairConfig.trailingStopPips,
          trailingStopActivation: pairConfig.trailingStopActivation,
          breakEven: pairConfig.breakEvenEnabled,
          breakEvenPips: pairConfig.breakEvenPips,
          partialTP: pairConfig.partialTPEnabled,
          partialTPPercent: pairConfig.partialTPPercent,
          partialTPLevel: pairConfig.partialTPLevel,
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
          signal_reason: JSON.stringify({ bot: BOT_ID, summary: analysis.summary, exitFlags, spreadFilter: { enabled: pairConfig.spreadFilterEnabled, maxPips: pairConfig.maxSpreadPips }, newsFilter: { enabled: pairConfig.newsFilterEnabled, pauseMinutes: pairConfig.newsFilterPauseMinutes }, fotsi: analysis.fotsiAlignment ? { base: analysis.fotsiAlignment.baseTSI, quote: analysis.fotsiAlignment.quoteTSI, spread: analysis.fotsiAlignment.spread, score: analysis.fotsiAlignment.score, label: analysis.fotsiAlignment.label } : null }),
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
          summary: analysis.summary,
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
                    // ── OANDA spread check: fetch live pricing before placing order ──
                    if (conn.broker_type === "oanda" && config.spreadFilterEnabled) {
                      try {
                        const oandaBase = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
                        // Resolve OANDA symbol format (EUR/USD → EUR_USD)
                        const rawOverrides = conn.symbol_overrides || {};
                        let oandaSym = pair;
                        const normKey = pair.trim().replace(/[\s/._-]/g, "").toUpperCase();
                        for (const [k, v] of Object.entries(rawOverrides)) {
                          if (k.trim().replace(/[\s/._-]/g, "").toUpperCase() === normKey && v) { oandaSym = String(v); break; }
                        }
                        if (oandaSym === pair) {
                          const cleaned = pair.trim().replace(/\s+/g, "").toUpperCase();
                          if (cleaned.includes("/")) oandaSym = cleaned.replace("/", "_");
                          else if (cleaned.length === 6 && !cleaned.includes("_")) oandaSym = `${cleaned.slice(0, 3)}_${cleaned.slice(3)}`;
                          else oandaSym = cleaned;
                        }
                        const priceRes = await fetch(`${oandaBase}/v3/accounts/${conn.account_id}/pricing?instruments=${encodeURIComponent(oandaSym)}`, {
                          headers: { Authorization: `Bearer ${conn.api_key}` },
                        });
                        if (priceRes.ok) {
                          const priceData: any = await priceRes.json();
                          const pricing = priceData.prices?.[0];
                          if (pricing) {
                            const oBid = parseFloat(pricing.bids?.[0]?.price ?? "0");
                            const oAsk = parseFloat(pricing.asks?.[0]?.price ?? "0");
                            if (oBid > 0 && oAsk > 0) {
                              const pairSpec = SPECS[pair] || SPECS["EUR/USD"];
                              const oSpreadPips = (oAsk - oBid) / pairSpec.pipSize;
                              console.log(`OANDA spread [${conn.display_name}] ${oandaSym}: bid=${oBid} ask=${oAsk} spread=${oSpreadPips.toFixed(2)} pips (max=${config.maxSpreadPips})`);
                              if (oSpreadPips > config.maxSpreadPips) {
                                console.warn(`OANDA spread too wide [${conn.display_name}]: ${oSpreadPips.toFixed(2)} > ${config.maxSpreadPips} — skipping`);
                                mirrorResults.push(`${conn.display_name}: skipped (spread ${oSpreadPips.toFixed(1)} > ${config.maxSpreadPips})`);
                                continue;
                              }
                            }
                          }
                        } else {
                          console.warn(`OANDA pricing fetch failed [${conn.display_name}]: ${priceRes.status} — proceeding without spread check`);
                        }
                      } catch (spreadErr: any) {
                        console.warn(`OANDA spread check error [${conn.display_name}]: ${spreadErr?.message} — proceeding without spread check`);
                      }
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
                        stopLoss: sl,
                        takeProfit: tp,
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
                     brokerVolume = calculatePositionSize(brokerBalance, cappedRisk, analysis.lastPrice, sl, pair);
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

                   // ── Spread-aware execution: fetch live bid/ask and validate spread ──
                   let brokerBid: number | null = null;
                   let brokerAsk: number | null = null;
                   let brokerSpreadPips: number | null = null;
                   try {
                     const { res: priceRes, body: priceBody } = await metaFetch(metaAccountId, authToken, (base) => `${base}/symbols/${encodeURIComponent(brokerSymbol)}/current-price`);
                     if (priceRes.ok) {
                       const priceData: any = JSON.parse(priceBody);
                       brokerBid = priceData.bid ?? null;
                       brokerAsk = priceData.ask ?? null;
                       if (brokerBid != null && brokerAsk != null) {
                         const pairSpec = SPECS[pair] || SPECS["EUR/USD"];
                         brokerSpreadPips = (brokerAsk - brokerBid) / pairSpec.pipSize;
                         console.log(`Spread check [${conn.display_name}] ${brokerSymbol}: bid=${brokerBid}, ask=${brokerAsk}, spread=${brokerSpreadPips.toFixed(2)} pips`);
                       }
                     } else {
                       console.warn(`Price fetch [${conn.display_name}] ${brokerSymbol}: HTTP ${priceRes.status}`);
                     }
                   } catch (priceErr: any) {
                     console.warn(`Price fetch error [${conn.display_name}] ${brokerSymbol}: ${priceErr?.message}`);
                   }

                   // Gate: skip this broker if spread exceeds configured maximum
                   if (pairConfig.spreadFilterEnabled && brokerSpreadPips != null && brokerSpreadPips > pairConfig.maxSpreadPips) {
                     console.warn(`Spread filter [${conn.display_name}]: ${brokerSpreadPips.toFixed(2)} pips > ${pairConfig.maxSpreadPips} max — skipping`);
                     mirrorResults.push(`${conn.display_name}: skipped (spread ${brokerSpreadPips.toFixed(1)} > ${pairConfig.maxSpreadPips} max)`);
                     continue;
                   }

                   // Adjust SL/TP for broker spread (widen SL by half-spread, tighten TP by half-spread)
                   let brokerSL = sl;
                   let brokerTP = tp;
                   if (brokerSpreadPips != null && brokerSpreadPips > 0) {
                     const pairSpec = SPECS[pair] || SPECS["EUR/USD"];
                     const halfSpread = (brokerSpreadPips * pairSpec.pipSize) / 2;
                     if (analysis.direction === "long") {
                       // Long: entry is at ask, SL needs extra room below
                       brokerSL = sl - halfSpread;
                     } else {
                       // Short: entry is at bid, SL needs extra room above
                       brokerSL = sl + halfSpread;
                     }
                     console.log(`SL adjusted for spread [${conn.display_name}]: ${sl} → ${brokerSL} (half-spread=${halfSpread.toFixed(6)})`);
                   }

                   const mt5Body: any = {
                     actionType: analysis.direction === "long" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
                     symbol: brokerSymbol,
                     volume: brokerVolume,
                     comment: `paper:${positionId}`,
                   };
                   if (brokerSL) mt5Body.stopLoss = brokerSL;
                   if (brokerTP) mt5Body.takeProfit = brokerTP;
                   console.log(`Broker mirror [${conn.display_name}]: sending ${pair} → ${brokerSymbol} ${analysis.direction} ${brokerVolume} lots, SL=${brokerSL}, TP=${brokerTP}, spread=${brokerSpreadPips?.toFixed(2) ?? "?"} pips`);
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

  return { pairsScanned: config.instruments.length, signalsFound, tradesPlaced, rejected: rejectedCount, details: scanDetails, activeStyle: resolvedStyle, scanCycleId };
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
