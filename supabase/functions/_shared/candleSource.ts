// ─── Unified Candle Source with Failover ─────────────────────────────
// Order of preference:
//   1. MetaAPI (broker feed) — same prices as execution, zero drift
//   2. Twelve Data — real FX/indices/crypto, documented API
//   3. Polygon.io — paid fallback (real-time forex/indices/crypto, documented API)
//
// Each provider returns the same Candle[] shape so callers stay agnostic.
import { matchBrokerSymbol } from "./symbolMatcher.ts";
import { META_REGIONS, regionCache } from "./metaApiClient.ts";
import { toNYTimeAt } from "./sessions.ts";
import { acquireApiCredit, resetCreditBudgetStats } from "./apiCreditBudget.ts";

export interface Candle {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

const FX_CURRENCY_CODES = new Set(["AUD", "CAD", "CHF", "EUR", "GBP", "JPY", "NZD", "USD"]);

export function isForexSymbol(symbol: string): boolean {
  const [base, quote, extra] = symbol.toUpperCase().split("/");
  return !extra && FX_CURRENCY_CODES.has(base) && FX_CURRENCY_CODES.has(quote);
}

export function isForexMarketOpenAt(datetime: string): boolean {
  const timestamp = Date.parse(datetime);
  if (!Number.isFinite(timestamp)) return false;
  const { nyDay, h, m } = toNYTimeAt(timestamp);
  const minutes = h * 60 + m;
  if (nyDay === 6) return false;
  if (nyDay === 0) return minutes >= 17 * 60;
  if (nyDay === 5) return minutes < 17 * 60;
  return true;
}

export function filterClosedMarketCandles(symbol: string, candles: Candle[]): Candle[] {
  if (!isForexSymbol(symbol)) return candles;
  return candles.filter((candle) => isForexMarketOpenAt(candle.datetime));
}

// ─── H8: TwelveData Rate Limiter ────────────────────────────────────
// TwelveData Grow plan: 55 credits/minute. We use 50 as the effective
// limit to provide a safety margin (some endpoints cost 2+ credits,
// and the counter resets on the server side, not ours).
const _tdRequestTimestamps: number[] = [];
const TD_RATE_LIMIT = 50;   // 50 of 55 — 5 credit safety margin
const TD_RATE_WINDOW_MS = 60_000;
const TD_MAX_WAIT_MS = 25_000; // Wait up to 25s before falling back to Polygon
const TD_SHARED_POLL_MS = 2_000; // Re-ask the shared budget this often while waiting
let _tdThrottleCount = 0;      // Track how many times we throttled this invocation

async function waitForTwelveDataSlot(): Promise<boolean> {
  const now = Date.now();
  // Remove timestamps older than 1 minute
  while (_tdRequestTimestamps.length > 0 && _tdRequestTimestamps[0] < now - TD_RATE_WINDOW_MS) {
    _tdRequestTimestamps.shift();
  }
  if (_tdRequestTimestamps.length >= TD_RATE_LIMIT) {
    // Calculate wait time until oldest request expires
    const waitMs = _tdRequestTimestamps[0] + TD_RATE_WINDOW_MS - now + 200; // +200ms buffer
    if (waitMs > TD_MAX_WAIT_MS) {
      // If wait is too long, skip to Polygon fallback instead of blocking
      _tdThrottleCount++;
      console.warn(`[candleSource] TwelveData rate limit: would wait ${waitMs}ms (>${TD_MAX_WAIT_MS}ms), skipping to Polygon (throttle #${_tdThrottleCount})`);
      return false;
    }
    _tdThrottleCount++;
    console.log(`[candleSource] TwelveData rate limit: waiting ${waitMs}ms for slot (${_tdRequestTimestamps.length}/${TD_RATE_LIMIT} used, throttle #${_tdThrottleCount})`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  _tdRequestTimestamps.push(Date.now());

  // The check above only sees THIS isolate. bot-scanner, the manage loop,
  // zone-confirmation-scanner and paper-trading each run their own, so the
  // plan-wide spend is the sum of several separately-compliant limiters —
  // which is how we reached 371/min against a 55/min plan with the throttle
  // counter reading 0. The shared budget is the one that knows the real total.
  const granted = await acquireApiCredit("twelvedata", TD_RATE_LIMIT, {
    windowSeconds: TD_RATE_WINDOW_MS / 1000,
    maxWaitMs: TD_MAX_WAIT_MS,
    pollMs: TD_SHARED_POLL_MS,
    label: "candleSource",
  });
  if (!granted) {
    _tdThrottleCount++;
    return false;
  }
  return true;
}

/**
 * Reset throttle counters — call at start of each scan cycle for clean stats.
 *
 * `unenforcedCount` is the one to watch: it counts fetches that proceeded
 * because the shared budget failed open. A non-zero value means we are back to
 * per-isolate limiting and the plan-wide total is unguarded, which previously
 * went unnoticed for months because nothing counted it.
 */
export function resetThrottleStats(): {
  throttleCount: number;
  unenforcedCount: number;
  budgetRpcFailures: number;
  budgetRefused: number;
} {
  const budget = resetCreditBudgetStats();
  const stats = {
    throttleCount: _tdThrottleCount,
    unenforcedCount: budget.unenforced,
    budgetRpcFailures: budget.rpcFailures,
    budgetRefused: budget.refused,
  };
  _tdThrottleCount = 0;
  return stats;
}

// ─── M1: In-Memory Candle Cache ─────────────────────────────────────
// Per-invocation cache (Edge Functions are stateless, but within a single
// scan cycle the same symbol may be fetched multiple times for different analysis).
interface CacheEntry {
  candles: Candle[];
  source: string;
  timestamp: number;
}
const _candleCache = new Map<string, CacheEntry>();
const CACHE_TTL_INTRADAY_MS = 30_000;  // 30 seconds for intraday
const CACHE_TTL_DAILY_MS = 300_000;    // 5 minutes for daily

function getCacheKey(symbol: string, interval: string, scope = "public"): string {
  return `${scope}:${symbol}:${interval}`;
}

function getCachedCandles(symbol: string, interval: string, scope = "public"): CacheEntry | null {
  const key = getCacheKey(symbol, interval, scope);
  const entry = _candleCache.get(key);
  if (!entry) return null;
  const ttl = interval.includes("d") || interval.includes("w") || interval.includes("mo") ? CACHE_TTL_DAILY_MS : CACHE_TTL_INTRADAY_MS;
  if (Date.now() - entry.timestamp > ttl) {
    _candleCache.delete(key);
    return null;
  }
  return entry;
}

function setCachedCandles(symbol: string, interval: string, candles: Candle[], source: string, scope = "public"): void {
  const key = getCacheKey(symbol, interval, scope);
  _candleCache.set(key, { candles, source, timestamp: Date.now() });
}

export interface BrokerConn {
  api_key: string;
  account_id: string;
  broker_type?: "metaapi" | "oanda";
  is_live?: boolean;
  display_name?: string;
  symbol_suffix?: string;
  symbol_overrides?: Record<string, string>;
  /** Optional connection row id — enables lazy auto-mapping persistence. */
  id?: string;
  user_id?: string;
}

// ─── Symbol mapping per provider ─────────────────────────────────────
// Polygon.io uses C:EURUSD for forex, I:DJI for indices, X:BTCUSD for crypto,
// and standard tickers for commodities futures.
const POLYGON_SYMBOLS: Record<string, string> = {
  // Forex Majors
  "EUR/USD": "C:EURUSD", "GBP/USD": "C:GBPUSD", "USD/JPY": "C:USDJPY",
  "AUD/USD": "C:AUDUSD", "NZD/USD": "C:NZDUSD", "USD/CAD": "C:USDCAD",
  "USD/CHF": "C:USDCHF",
  // Forex Crosses
  "EUR/GBP": "C:EURGBP", "EUR/JPY": "C:EURJPY", "GBP/JPY": "C:GBPJPY",
  "EUR/AUD": "C:EURAUD", "EUR/CAD": "C:EURCAD", "EUR/CHF": "C:EURCHF",
  "EUR/NZD": "C:EURNZD", "GBP/AUD": "C:GBPAUD", "GBP/CAD": "C:GBPCAD",
  "GBP/CHF": "C:GBPCHF", "GBP/NZD": "C:GBPNZD", "AUD/CAD": "C:AUDCAD",
  "AUD/JPY": "C:AUDJPY", "CAD/JPY": "C:CADJPY",
  "AUD/CHF": "C:AUDCHF", "AUD/NZD": "C:AUDNZD", "CAD/CHF": "C:CADCHF",
  "CHF/JPY": "C:CHFJPY", "NZD/CAD": "C:NZDCAD", "NZD/CHF": "C:NZDCHF",
  "NZD/JPY": "C:NZDJPY",
  // Indices (Polygon uses I: prefix for indices)
  "US30": "I:DJI", "NAS100": "I:NDX", "SPX500": "I:SPX",
  // Commodities (Polygon uses standard futures tickers)
  "XAU/USD": "C:XAUUSD", "XAG/USD": "C:XAGUSD", "US Oil": "C:USOIL",
  // Crypto
  "BTC/USD": "X:BTCUSD", "ETH/USD": "X:ETHUSD",
};

// Twelve Data uses standard pair format with a slash (e.g. "EUR/USD") for FX,
// dash for crypto, and the index/commodity symbol directly.
export const TWELVE_DATA_SYMBOLS: Record<string, string> = {
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

const livePriceCache = new Map<string, { value: number; expiresAt: number }>();
const LIVE_PRICE_CACHE_TTL_MS = 10_000;

/** Live quote for trade management. Detection must continue using closed candles. */
export async function fetchLivePrice(symbol: string): Promise<number | null> {
  const cached = livePriceCache.get(symbol);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const apiKey = Deno.env.get("TWELVE_DATA_API_KEY");
  const tdSymbol = TWELVE_DATA_SYMBOLS[symbol];
  if (!apiKey || !tdSymbol) return cached?.value ?? null;
  const granted = await acquireApiCredit("twelvedata", TD_RATE_LIMIT, {
    maxWaitMs: 0,
    label: "candleSource/live-price",
  });
  if (!granted) return cached?.value ?? null;

  try {
    const url = "https://api.twelvedata.com/price?symbol=" + encodeURIComponent(tdSymbol) + "&apikey=" + apiKey;
    const response = await fetch(url);
    if (!response.ok) return cached?.value ?? null;
    const payload = await response.json();
    const price = Number(payload?.price);
    if (!Number.isFinite(price)) return cached?.value ?? null;
    livePriceCache.set(symbol, { value: price, expiresAt: Date.now() + LIVE_PRICE_CACHE_TTL_MS });
    return price;
  } catch {
    return cached?.value ?? null;
  }
}

// ─── Interval normalization ───────────────────────────────────────────
// Canonical intervals used internally: 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w
function canonicalInterval(input: string): string {
  const m: Record<string, string> = {
    "1m": "1m", "1min": "1m",
    "5m": "5m", "5min": "5m",
    "15m": "15m", "15min": "15m",
    "30m": "30m", "30min": "30m",
    "1h": "1h", "60m": "1h", "60min": "1h",
    "4h": "4h", "240m": "4h",
    "1d": "1d", "1day": "1d",
    "1w": "1w", "1week": "1w", "1wk": "1w",
    "1mo": "1mo", "1month": "1mo", "1M": "1mo",
  };
  return m[input] || input;
}

/** Duration of one bar, per canonical interval. */
const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

/**
 * Drop trailing bars whose period has not finished yet.
 *
 * Data providers generally return the in-progress bar as the most recent
 * element. Its high, low and close keep moving until the period closes, so any
 * detector reading it sees values that change within a single bar: FVGs and
 * order blocks appear and vanish intra-bar, and backtest (which only ever sees
 * closed bars) can never reproduce live behaviour.
 *
 * A bar starting at T on interval I is closed only once `now >= T + I`. This
 * makes the question "does provider X include the forming bar?" irrelevant — if
 * it does, it is removed; if it does not, this is a no-op.
 *
 * Bar timestamps are treated as the bar's START time, which is the convention
 * for every source wired here (MetaAPI, OANDA, TwelveData, Polygon).
 */
export function dropFormingBar(
  candles: Candle[],
  interval: string,
  nowMs: number = Date.now(),
): Candle[] {
  const barMs = INTERVAL_MS[canonicalInterval(interval)];
  if (!barMs || candles.length === 0) return candles;
  let end = candles.length;
  while (end > 0) {
    const startedAt = new Date(candles[end - 1].datetime).getTime();
    if (!Number.isFinite(startedAt)) break;
    if (startedAt + barMs <= nowMs) break; // closed — and so is everything before it
    end--;
  }
  return end === candles.length ? candles : candles.slice(0, end);
}

// Polygon.io uses {multiplier}/{timespan} format: e.g. 15/minute, 1/hour, 1/day
function polygonTimespan(canon: string): { multiplier: number; timespan: string } {
  const m: Record<string, { multiplier: number; timespan: string }> = {
    "1m": { multiplier: 1, timespan: "minute" },
    "5m": { multiplier: 5, timespan: "minute" },
    "15m": { multiplier: 15, timespan: "minute" },
    "30m": { multiplier: 30, timespan: "minute" },
    "1h": { multiplier: 1, timespan: "hour" },
    "4h": { multiplier: 4, timespan: "hour" },
    "1d": { multiplier: 1, timespan: "day" },
    "1w": { multiplier: 1, timespan: "week" },
    "1mo": { multiplier: 1, timespan: "month" },
  };
  return m[canon] || { multiplier: 15, timespan: "minute" };
}

// How far back to look for each canonical interval
function polygonLookbackDays(canon: string): number {
  const m: Record<string, number> = {
    "1m": 1, "5m": 5, "15m": 7, "30m": 14,
    "1h": 30, "4h": 60, "1d": 365, "1w": 730, "1mo": 1825,
  };
  return m[canon] || 7;
}

function twelveDataInterval(canon: string): string {
  const m: Record<string, string> = {
    "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min",
    "1h": "1h", "4h": "4h", "1d": "1day", "1w": "1week", "1mo": "1month",
  };
  return m[canon] || "15min";
}

function metaapiTimeframe(canon: string): string {
  // MetaAPI uses MT5-style timeframe codes
  const m: Record<string, string> = {
    "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w", "1mo": "1MN",
  };
  return m[canon] || "15m";
}
export function oandaGranularity(canon: string): string {
  const m: Record<string, string> = {
    "1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30",
    "1h": "H1", "4h": "H4", "1d": "D", "1w": "W", "1mo": "M",
  };
  return m[canon] || "M15";
}

export function resolveOandaCandleSymbol(symbol: string, conn: BrokerConn): string {
  const explicit = resolveBrokerSymbol(symbol, conn);
  const cleaned = explicit.trim().replace(/[\s\/.-]/g, "_").toUpperCase();
  if (cleaned.includes("_")) return cleaned;
  return cleaned.length === 6 ? `${cleaned.slice(0, 3)}_${cleaned.slice(3)}` : cleaned;
}

async function oandaFetchCandles(conn: BrokerConn, symbol: string, canon: string, limit: number): Promise<Candle[]> {
  const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  const instrument = resolveOandaCandleSymbol(symbol, conn);
  const count = Math.min(Math.max(limit, 30), 5000);
  const url = `${baseUrl}/v3/instruments/${encodeURIComponent(instrument)}/candles?price=M&granularity=${oandaGranularity(canon)}&count=${count}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${conn.api_key}` } }, 8000);
    const body = await res.text();
    if (!res.ok) {
      console.warn(`[candleSource] OANDA ${instrument} ${canon}: ${res.status} ${body.slice(0, 120)}`);
      return [];
    }
    const payload = JSON.parse(body);
    return (Array.isArray(payload?.candles) ? payload.candles : [])
      .filter((c: any) => c?.complete !== false && c?.mid)
      .map((c: any) => ({ datetime: c.time, open: Number(c.mid.o), high: Number(c.mid.h), low: Number(c.mid.l), close: Number(c.mid.c), volume: c.volume == null ? undefined : Number(c.volume) }))
      .filter((c: Candle) => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));
  } catch (e: any) {
    console.warn(`[candleSource] OANDA ${instrument} ${canon} fetch error: ${e?.message}`);
    return [];
  }
}

// META_REGIONS and regionCache are now imported from ./metaApiClient.ts (single source of truth)
// Cache of symbols we've already subscribed to per account (in-memory, per cold start)
// Key: `${accountId}:${symbol}` → true
const subscribedSymbols = new Set<string>();

// Region circuit-breaker: skip a region for the rest of this cold start once
// it has hit a hard infra failure (DNS error, repeated timeouts). Prevents
// the singapore endpoint (which currently DNS-fails) from adding 5-10s of
// latency to every single symbol/timeframe fetch and blowing the 150s budget.
const deadRegions = new Set<string>();
const REGION_FAIL_THRESHOLD = 2;
const regionFailCounts = new Map<string, number>();
export function classifyMetaApiOperationalIssue(
  message: string,
): "metaapi_certificate_failure" | "metaapi_connection_failure" {
  return /certificate|x509|cert[^a-z]*expired|invalid peer/i.test(message)
    ? "metaapi_certificate_failure"
    : "metaapi_connection_failure";
}

function noteRegionFailure(
  region: string,
  err: string,
  symbol?: string,
  interval?: string,
) {
  if (symbol && interval) {
    noteSourceIssue({
      code: classifyMetaApiOperationalIssue(err),
      provider: "metaapi",
      symbol,
      interval,
      message: `${region}: ${err}`.slice(0, 500),
    });
  }
  const isInfra = /dns error|failed to lookup|timeout|connect/i.test(err);
  if (!isInfra) return;
  const n = (regionFailCounts.get(region) ?? 0) + 1;
  regionFailCounts.set(region, n);
  if (n >= REGION_FAIL_THRESHOLD) {
    deadRegions.add(region);
    console.warn(`[candleSource] MetaAPI region ${region} marked DEAD after ${n} infra failures`);
  }
}
function activeRegions(order: string[]): string[] {
  return order.filter((r) => !deadRegions.has(r));
}

// Bounded fetch — abort instead of letting a stuck connection eat the budget.
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Probe + subscribe a symbol via current-candles?keepSubscription=true.
// This both validates that the broker recognizes the symbol AND triggers a
// long-term market data subscription, which is required on some brokers
// (e.g. HFMarkets) before historical-market-data will return data.
// Returns true if the symbol is valid and subscribed; false if 404/invalid.
async function metaSubscribeSymbol(
  authToken: string,
  metaAccountId: string,
  region: string,
  brokerSymbol: string,
  canon: string,
): Promise<boolean> {
  const cacheKey = `${metaAccountId}:${brokerSymbol}`;
  if (subscribedSymbols.has(cacheKey)) return true;

  const tf = metaapiTimeframe(canon);
  const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${metaAccountId}/symbols/${encodeURIComponent(brokerSymbol)}/current-candles/${tf}?keepSubscription=true`;
  try {
    const res = await fetchWithTimeout(url, { headers: { "auth-token": authToken } }, 6000);
    if (res.ok) {
      subscribedSymbols.add(cacheKey);
      console.log(`[candleSource] MetaAPI subscribed ${brokerSymbol} on ${region}`);
      return true;
    }
    if (res.status === 404) {
      const body = await res.text();
      console.warn(`[candleSource] MetaAPI subscribe 404 for ${brokerSymbol} on ${region}: ${body.slice(0, 120)}`);
      return false;
    }
    console.warn(`[candleSource] MetaAPI subscribe ${res.status} for ${brokerSymbol}`);
    return false;
  } catch (e: any) {
    console.warn(`[candleSource] MetaAPI subscribe error for ${brokerSymbol} on ${region}: ${e?.message}`);
    noteRegionFailure(region, e?.message ?? "", brokerSymbol, canon);
    return false;
  }
}

async function metaFetchCandles(
  conn: BrokerConn,
  brokerSymbol: string,
  canon: string,
  limit: number,
): Promise<Candle[]> {
  // Detect swapped api_key/account_id (some users paste them backwards)
  let authToken = conn.api_key;
  let metaAccountId = conn.account_id;
  if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
    authToken = conn.account_id;
    metaAccountId = conn.api_key;
  }

  const tf = metaapiTimeframe(canon);
  const cached = regionCache.get(metaAccountId);
  const baseOrder = cached ? [cached, ...META_REGIONS.filter((r) => r !== cached)] : META_REGIONS;
  const order = activeRegions(baseOrder);
  if (order.length === 0) {
    console.warn(`[candleSource] all MetaAPI regions marked dead — skipping broker fetch for ${brokerSymbol}`);
    noteSourceIssue({
      code: "metaapi_connection_failure",
      provider: "metaapi",
      symbol: brokerSymbol,
      interval: canon,
      message: "All MetaAPI regions are marked unavailable",
    });
    return [];
  }

  const fetchHistorical = async (region: string): Promise<{ ok: boolean; status: number; body: string; candles?: Candle[] }> => {
    const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${metaAccountId}/historical-market-data/symbols/${encodeURIComponent(brokerSymbol)}/timeframes/${tf}/candles?limit=${limit}`;
    const res = await fetchWithTimeout(url, { headers: { "auth-token": authToken } }, 8000);
    const body = await res.text();
    if (res.ok) {
      const arr = JSON.parse(body);
      if (!Array.isArray(arr)) return { ok: true, status: res.status, body, candles: [] };
      const candles = arr.map((c: any) => ({
        datetime: typeof c.time === "string" ? c.time : new Date(c.time).toISOString(),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: c.tickVolume != null ? Number(c.tickVolume) : undefined,
      })).filter((c: Candle) =>
        Number.isFinite(c.open) && Number.isFinite(c.high) &&
        Number.isFinite(c.low) && Number.isFinite(c.close)
      );
      return { ok: true, status: res.status, body, candles };
    }
    return { ok: false, status: res.status, body };
  };

  for (const region of order) {
    if (deadRegions.has(region)) continue;
    try {
      let result = await fetchHistorical(region);

      // CASE A: historical 404'd. The symbol may need a subscription (HFMarkets-style).
      // Probe + subscribe via current-candles?keepSubscription=true, then retry with backoff.
      const cacheKey = `${metaAccountId}:${brokerSymbol}`;
      if (!result.ok && result.status === 404 && /could not find path|notfounderror|symbol/i.test(result.body)) {
        if (!subscribedSymbols.has(cacheKey)) {
          const subscribed = await metaSubscribeSymbol(authToken, metaAccountId, region, brokerSymbol, canon);
          if (subscribed) {
            // Retry with growing backoff — HFMarkets can take 5-10s to backfill history
            for (const waitMs of [2000, 4000, 6000]) {
              await new Promise((r) => setTimeout(r, waitMs));
              result = await fetchHistorical(region);
              if (result.ok && (result.candles?.length ?? 0) > 0) break;
              if (!result.ok) break; // hard error, stop retrying
            }
          }
        }
      }

      // CASE B: historical returned 200 OK but empty array. Two sub-cases:
      //   B1: We've already subscribed → MetaAPI is backfilling, just wait.
      //   B2: We haven't subscribed yet → broker requires subscription before serving history
      //       (HFMarkets behavior). Subscribe now, then wait for backfill.
      if (result.ok && (result.candles?.length ?? 0) === 0) {
        if (!subscribedSymbols.has(cacheKey)) {
          const subscribed = await metaSubscribeSymbol(authToken, metaAccountId, region, brokerSymbol, canon);
          if (!subscribed) {
            // Symbol genuinely doesn't exist on this region — try next region
            console.warn(`[candleSource] MetaAPI ${brokerSymbol} 200-empty + subscribe failed on ${region}`);
            continue;
          }
        }
        for (const waitMs of [2000, 4000, 6000]) {
          await new Promise((r) => setTimeout(r, waitMs));
          result = await fetchHistorical(region);
          if (result.ok && (result.candles?.length ?? 0) > 0) break;
        }
      }

      if (result.ok) {
        regionCache.set(metaAccountId, region);
        if ((result.candles?.length ?? 0) === 0) {
          console.warn(`[candleSource] MetaAPI ${brokerSymbol} returned 200 but empty after ${subscribedSymbols.has(cacheKey) ? "subscribe + retries" : "first call"} on ${region}`);
        }
        return result.candles ?? [];
      }

      // 404 / NotFoundError → account isn't deployed in this region, try the next one.
      // Other status codes (auth, rate-limit, etc.) are not region-specific → stop probing.
      const isRegionMiss =
        result.status === 404 ||
        /region|not connected to broker|notfounderror|could not find path/i.test(result.body);
      if (!isRegionMiss) {
        console.warn(`[candleSource] MetaAPI ${region} non-region error ${result.status}: ${result.body.slice(0, 120)}`);
        return [];
      }
      if (region === order[order.length - 1]) {
        console.warn(`[candleSource] MetaAPI ${brokerSymbol} not found in any region (${order.join(", ")}) — last body: ${result.body.slice(0, 120)}`);
      }
    } catch (e: any) {
      console.warn(`[candleSource] MetaAPI ${region} fetch error: ${e?.message}`);
      noteRegionFailure(region, e?.message ?? "", brokerSymbol, canon);
    }
  }
  return [];
}

function resolveBrokerSymbol(symbol: string, conn: BrokerConn): string {
  const overrides = conn.symbol_overrides || {};
  const norm = symbol.toUpperCase().replace(/[\s/._-]/g, "");
  for (const [k, v] of Object.entries(overrides)) {
    if (k.toUpperCase().replace(/[\s/._-]/g, "") === norm && v) return String(v);
  }
  const base = symbol.trim().replace(/\s+/g, "").replace("/", "").toUpperCase();
  return base + (conn.symbol_suffix || "");
}

/** Whether `symbol` was resolved via an explicit override (vs. fallback suffix). */
function hasExplicitOverride(symbol: string, conn: BrokerConn): boolean {
  const overrides = conn.symbol_overrides || {};
  const norm = symbol.toUpperCase().replace(/[\s/._-]/g, "");
  return Object.keys(overrides).some((k) => k.toUpperCase().replace(/[\s/._-]/g, "") === norm);
}

const symbolListCache = new Map<string, string[]>(); // metaAccountId → symbols

async function loadBrokerSymbolList(authToken: string, metaAccountId: string): Promise<string[]> {
  const cached = symbolListCache.get(metaAccountId);
  if (cached) return cached;
  for (const region of META_REGIONS) {
    try {
      const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${metaAccountId}/symbols`;
      const res = await fetch(url, { headers: { "auth-token": authToken } });
      if (!res.ok) continue;
      const arr = await res.json();
      if (Array.isArray(arr)) {
        const list = arr.map(String);
        symbolListCache.set(metaAccountId, list);
        return list;
      }
    } catch (e: any) {
      console.warn(`[candleSource] symbol-list ${region} error: ${e?.message}`);
    }
  }
  return [];
}

async function persistSymbolOverride(conn: BrokerConn, canonical: string, brokerSymbol: string): Promise<void> {
  if (!conn.id) return;
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.103.2");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const overrides = { ...(conn.symbol_overrides || {}), [canonical]: brokerSymbol };
    await supabase.from("broker_connections")
      .update({ symbol_overrides: overrides })
      .eq("id", conn.id);
    conn.symbol_overrides = overrides; // mutate in-memory so subsequent calls in this scan use it
    console.log(`[candleSource] auto-mapped ${canonical} → ${brokerSymbol} (persisted)`);
  } catch (e: any) {
    console.warn(`[candleSource] failed to persist override: ${e?.message}`);
  }
}

// ─── Twelve Data ──────────────────────────────────────────────────────
async function twelveDataCandles(
  symbol: string,
  canon: string,
  limit: number,
): Promise<Candle[]> {
  const apiKey = Deno.env.get("TWELVE_DATA_API_KEY");
  if (!apiKey) return [];
  const tdSymbol = TWELVE_DATA_SYMBOLS[symbol];
  if (!tdSymbol) return [];

  // H8: Check rate limit before making request
  const hasSlot = await waitForTwelveDataSlot();
  if (!hasSlot) return []; // Skip to Polygon fallback

  const interval = twelveDataInterval(canon);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${interval}&outputsize=${limit}&apikey=${apiKey}&order=ASC&timezone=UTC`;
  try {
    const res = await fetch(url);
    // H8: Handle 429 with exponential backoff
    if (res.status === 429) {
      console.warn(`[candleSource] TwelveData 429 rate limited for ${symbol}, backing off`);
      await new Promise(r => setTimeout(r, 5000)); // 5s backoff
      const retryRes = await fetch(url);
      if (!retryRes.ok) return [];
      const retryData = await retryRes.json();
      if (retryData?.status === "error" || !Array.isArray(retryData?.values)) return [];
      return retryData.values.map((v: any) => ({
        datetime: typeof v.datetime === "string" && v.datetime.length === 10
          ? `${v.datetime}T00:00:00Z`
          : `${v.datetime.replace(" ", "T")}Z`,
        open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close),
        volume: v.volume != null ? Number(v.volume) : undefined,
      })).filter((c: Candle) =>
        Number.isFinite(c.open) && Number.isFinite(c.high) &&
        Number.isFinite(c.low) && Number.isFinite(c.close)
      );
    }
    if (!res.ok) return [];
    const data = await res.json();
    if (data?.status === "error" || !Array.isArray(data?.values)) {
      if (data?.message) console.warn(`[candleSource] Twelve Data: ${data.message}`);
      return [];
    }
    return data.values.map((v: any) => ({
      datetime: typeof v.datetime === "string" && v.datetime.length === 10
        ? `${v.datetime}T00:00:00Z`
        : `${v.datetime.replace(" ", "T")}Z`,
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: v.volume != null ? Number(v.volume) : undefined,
    })).filter((c: Candle) =>
      Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low) && Number.isFinite(c.close)
    );
  } catch (e: any) {
    console.warn(`[candleSource] Twelve Data fetch error: ${e?.message}`);
    return [];
  }
}

/// ─── Polygon.io ───────────────────────────────────────────────────
async function polygonCandles(
  symbol: string,
  canon: string,
  limit: number,
): Promise<Candle[]> {
  const apiKey = Deno.env.get("POLYGON_API_KEY");
  if (!apiKey) return [];
  const pgSym = POLYGON_SYMBOLS[symbol];
  if (!pgSym) return [];

  const { multiplier, timespan } = polygonTimespan(canon);
  const lookbackDays = polygonLookbackDays(canon);
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 86_400_000);
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);

  // Polygon Aggregates (Bars) endpoint
  // https://polygon.io/docs/forex/get_v2_aggs_ticker__forexticker__range__multiplier___timespan___from___to
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(pgSym)}/range/${multiplier}/${timespan}/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=${Math.min(limit, 50000)}&apiKey=${apiKey}`;

  try {
    const res = await fetch(url);
    if (res.status === 429) {
      console.warn(`[candleSource] Polygon 429 rate limited for ${symbol}, backing off 3s`);
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
      console.warn(`[candleSource] Polygon ${res.status} for ${symbol} ${canon}`);
      return [];
    }
    const data = await res.json();
    if (data?.status === "ERROR" || !Array.isArray(data?.results)) {
      if (data?.error) console.warn(`[candleSource] Polygon: ${data.error}`);
      return [];
    }
    return data.results.map((bar: any) => ({
      datetime: new Date(bar.t).toISOString(),
      open: Number(bar.o),
      high: Number(bar.h),
      low: Number(bar.l),
      close: Number(bar.c),
      volume: bar.v != null ? Number(bar.v) : undefined,
    })).filter((c: Candle) =>
      Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low) && Number.isFinite(c.close)
    );
  } catch (e: any) {
    console.warn(`[candleSource] Polygon fetch error: ${e?.message}`);
     return [];
  }
}

// Aggregate 1h candles into 4h buckets (UTC-aligned)
function aggregateTo4H(candles: Candle[]): Candle[] {
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

// ─── Public entrypoint ───────────────────────────────────────────────
export interface FetchOptions {
  symbol: string;
  interval: string;          // any common form: "15min", "15m", "1h", "4h", "1d", "1w"
  limit?: number;            // desired number of candles (default 200)
  brokerConn?: BrokerConn | null; // optional connected OANDA or MetaAPI account
  skipBroker?: boolean;      // true for request-budget-sensitive scans; use public data directly
  /**
   * Keep the in-progress bar. Display surfaces only — never detection, scoring
   * or backtest, which require closed bars for live/backtest parity.
   */
  keepFormingBar?: boolean;
}

export interface FetchResult {
  candles: Candle[];
  source: "metaapi" | "oanda" | "twelvedata" | "polygon" | "none";
}

// ─── Per-scan source tally (opt-in) ──────────────────────────────────
// Bot scanner can call beginScanSourceTally() at the start of a cycle and
// endScanSourceTally() at the end to learn which feeds served the candles.
export interface SourceTally {
  metaapi: number;
  oanda: number;
  twelvedata: number;
  polygon: number;
  none: number;
  metaapiAttempted: boolean;
  issues: CandleSourceIssue[];
  primary: "metaapi" | "oanda" | "twelvedata" | "polygon" | "none";
}

export interface CandleSourceIssue {
  code:
    | "metaapi_certificate_failure"
    | "metaapi_connection_failure"
    | "candle_source_exhaustion";
  provider: "metaapi" | "all";
  symbol: string;
  interval: string;
  message: string;
}

interface ActiveSourceTally {
  metaapi: number;
  oanda: number;
  twelvedata: number;
  polygon: number;
  none: number;
  metaapiAttempted: boolean;
  issues: CandleSourceIssue[];
}

let _activeTally: ActiveSourceTally | null = null;

function noteSourceIssue(issue: CandleSourceIssue): void {
  if (!_activeTally) return;
  const duplicate = _activeTally.issues.some((current) =>
    current.code === issue.code &&
    current.symbol === issue.symbol &&
    current.interval === issue.interval &&
    current.message === issue.message
  );
  if (!duplicate) _activeTally.issues.push(issue);
}

export function beginScanSourceTally(): void {
  _activeTally = {
    metaapi: 0,
    oanda: 0,
    twelvedata: 0,
    polygon: 0,
    none: 0,
    metaapiAttempted: false,
    issues: [],
  };
}

export function endScanSourceTally(): SourceTally {
  const t = _activeTally ?? {
    metaapi: 0,
    oanda: 0,
    twelvedata: 0,
    polygon: 0,
    none: 0,
    metaapiAttempted: false,
    issues: [],
  };
  _activeTally = null;
  // "primary" = the source that served the most candle requests this cycle
  const entries: ["metaapi" | "oanda" | "twelvedata" | "polygon" | "none", number][] = [
    ["metaapi", t.metaapi], ["oanda", t.oanda], ["twelvedata", t.twelvedata], ["polygon", t.polygon], ["none", t.none],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return { ...t, primary: entries[0][1] > 0 ? entries[0][0] : "none" };
}

/**
 * Public entry point. Wraps the raw multi-source fetch and removes the
 * in-progress bar so every detector downstream sees only closed candles.
 *
 * Set `keepFormingBar: true` only for display surfaces that genuinely want the
 * live bar (e.g. a chart). Never for detection, scoring or backtest.
 */
export async function fetchCandlesWithFallback(opts: FetchOptions): Promise<FetchResult> {
  const result = await fetchCandlesRaw(opts);
  if (opts.keepFormingBar) return result;
  const trimmed = dropFormingBar(result.candles, opts.interval);
  if (trimmed.length !== result.candles.length) {
    console.log(
      `[candles] ${opts.symbol} ${opts.interval}: dropped ${result.candles.length - trimmed.length}`
      + ` in-progress bar(s) from ${result.source}`,
    );
  }
  return { candles: trimmed, source: result.source };
}

async function fetchCandlesRaw(opts: FetchOptions): Promise<FetchResult> {
  const limit = opts.limit ?? 200;
  const canon = canonicalInterval(opts.interval);
  const cacheScope = opts.brokerConn?.api_key ? `${opts.brokerConn.broker_type ?? "metaapi"}:${opts.brokerConn.account_id}` : "public";

  // Global deadline so a single request can never eat the 150s edge runtime budget.
  // MetaAPI region probing + subscribe retries can each take 30-40s; cap the whole
  // fan-out at ~60s and bail to the next source instead of hanging the function.
  const deadline = Date.now() + 60_000;
  const timeLeft = () => deadline - Date.now();

  // M1: Check cache first
  const cached = getCachedCandles(opts.symbol, canon, cacheScope);
  if (cached && cached.candles.length >= 30) {
    if (_activeTally) (_activeTally as any)[cached.source]++;
    return { candles: filterClosedMarketCandles(opts.symbol, cached.candles).slice(-limit), source: cached.source as any };
  }

  // Try the connected broker first, unless the caller is a
  // request-budget-sensitive scan. Scanner invocations fetch many symbols and
  // timeframes; probing broker regions/subscriptions there can exceed hosted
  // runtime limits and surface as platform 503s.
  if (!opts.skipBroker && opts.brokerConn?.broker_type === "oanda" && opts.brokerConn.api_key && timeLeft() > 10_000) {
    const candles = filterClosedMarketCandles(opts.symbol, await oandaFetchCandles(opts.brokerConn, opts.symbol, canon, limit));
    if (candles.length >= 30) {
      if (_activeTally) _activeTally.oanda++;
      setCachedCandles(opts.symbol, canon, candles, "oanda", cacheScope);
      return { candles: candles.slice(-limit), source: "oanda" };
    }
  }

  if (!opts.skipBroker && opts.brokerConn?.broker_type !== "oanda" && opts.brokerConn?.api_key && opts.brokerConn?.account_id && timeLeft() > 15_000) {
    if (_activeTally) _activeTally.metaapiAttempted = true;
    let brokerSymbol = resolveBrokerSymbol(opts.symbol, opts.brokerConn);
    let candles = filterClosedMarketCandles(opts.symbol, await metaFetchCandles(opts.brokerConn, brokerSymbol, canon, limit));
    console.log(`[candleSource] MetaAPI ${opts.symbol}→${brokerSymbol} ${canon}: ${candles.length} candles`);

    // Lazy auto-mapping: if we got 0 candles AND there was no explicit override,
    // fetch the broker's symbol list and try a strict match.
    if (candles.length === 0 && !hasExplicitOverride(opts.symbol, opts.brokerConn) && timeLeft() > 15_000) {
      const swapped = opts.brokerConn.account_id.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(opts.brokerConn.api_key);
      const authToken = swapped ? opts.brokerConn.account_id : opts.brokerConn.api_key;
      const metaAccountId = swapped ? opts.brokerConn.api_key : opts.brokerConn.account_id;
      const symbolList = await loadBrokerSymbolList(authToken, metaAccountId);
      const match = matchBrokerSymbol(opts.symbol, symbolList);
      if (match && match.brokerSymbol !== brokerSymbol) {
        console.log(`[candleSource] auto-mapping ${opts.symbol} ${brokerSymbol} → ${match.brokerSymbol}`);
        brokerSymbol = match.brokerSymbol;
        candles = filterClosedMarketCandles(opts.symbol, await metaFetchCandles(opts.brokerConn, brokerSymbol, canon, limit));
        if (candles.length > 0) {
          await persistSymbolOverride(opts.brokerConn, opts.symbol, brokerSymbol);
        }
      }
    }

    if (candles.length >= 30) {
      if (_activeTally) _activeTally.metaapi++;
      setCachedCandles(opts.symbol, canon, candles, "metaapi", cacheScope);
      return { candles: candles.slice(-limit), source: "metaapi" };
    }
  }


  // Try Twelve Data
  const td = filterClosedMarketCandles(opts.symbol, timeLeft() > 5_000 ? await twelveDataCandles(opts.symbol, canon, limit) : []);
  if (td.length >= 30) {
    if (_activeTally) _activeTally.twelvedata++;
    setCachedCandles(opts.symbol, canon, td, "twelvedata");
    return { candles: td.slice(-limit), source: "twelvedata" };
  }

  // Polygon.io fallback
  const pg = filterClosedMarketCandles(opts.symbol, timeLeft() > 5_000 ? await polygonCandles(opts.symbol, canon, limit) : []);
  if (pg.length >= 30) {
    if (_activeTally) _activeTally.polygon++;
    setCachedCandles(opts.symbol, canon, pg, "polygon");
    return { candles: pg.slice(-limit), source: "polygon" };
  }

  // M3: One more pass only if we still have budget. The inner twelveData/polygon
  // helpers already do their own backoff-retry, so a second outer pass on top of
  // the MetaAPI region/subscribe retries can blow past the 150s runtime limit.
  if (timeLeft() > 8_000) {
    console.warn(`[candleSource] All sources failed for ${opts.symbol} ${canon}, retrying in 2s...`);
    await new Promise(r => setTimeout(r, 2000));

    const tdRetry = filterClosedMarketCandles(opts.symbol, timeLeft() > 5_000 ? await twelveDataCandles(opts.symbol, canon, limit) : []);
    if (tdRetry.length >= 30) {
      if (_activeTally) _activeTally.twelvedata++;
      setCachedCandles(opts.symbol, canon, tdRetry, "twelvedata");
      return { candles: tdRetry.slice(-limit), source: "twelvedata" };
    }

    const pgRetry = filterClosedMarketCandles(opts.symbol, timeLeft() > 5_000 ? await polygonCandles(opts.symbol, canon, limit) : []);
    if (pgRetry.length >= 30) {
      if (_activeTally) _activeTally.polygon++;
      setCachedCandles(opts.symbol, canon, pgRetry, "polygon");
      return { candles: pgRetry.slice(-limit), source: "polygon" };
    }
  }

  console.warn(`[candleSource] All sources failed for ${opts.symbol} ${canon} (deadline ${timeLeft()}ms left)`);
  if (_activeTally) _activeTally.none++;
  noteSourceIssue({
    code: "candle_source_exhaustion",
    provider: "all",
    symbol: opts.symbol,
    interval: canon,
    message: `All candle sources failed with ${Math.max(0, timeLeft())}ms budget remaining`,
  });
  return { candles: [], source: "none" };
}
