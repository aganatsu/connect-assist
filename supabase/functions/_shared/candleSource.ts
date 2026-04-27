// ─── Unified Candle Source with Failover ─────────────────────────────
// Order of preference:
//   1. MetaAPI (broker feed) — same prices as execution, zero drift
//   2. Twelve Data — real FX/indices/crypto, documented API
//   3. Polygon.io — paid fallback (real-time forex/indices/crypto, documented API)
//
// Each provider returns the same Candle[] shape so callers stay agnostic.
import { matchBrokerSymbol } from "./symbolMatcher.ts";

export interface Candle {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// ─── H8: TwelveData Rate Limiter ────────────────────────────────────
// TwelveData Grow plan: 55 credits/minute. We use 50 as the effective
// limit to provide a safety margin (some endpoints cost 2+ credits,
// and the counter resets on the server side, not ours).
const _tdRequestTimestamps: number[] = [];
const TD_RATE_LIMIT = 50;   // 50 of 55 — 5 credit safety margin
const TD_RATE_WINDOW_MS = 60_000;
const TD_MAX_WAIT_MS = 25_000; // Wait up to 25s before falling back to Polygon
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
  return true;
}

/** Reset throttle counter — call at start of each scan cycle for clean stats */
export function resetThrottleStats(): { throttleCount: number } {
  const stats = { throttleCount: _tdThrottleCount };
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

function getCacheKey(symbol: string, interval: string): string {
  return `${symbol}:${interval}`;
}

function getCachedCandles(symbol: string, interval: string): CacheEntry | null {
  const key = getCacheKey(symbol, interval);
  const entry = _candleCache.get(key);
  if (!entry) return null;
  const ttl = interval.includes("d") || interval.includes("w") ? CACHE_TTL_DAILY_MS : CACHE_TTL_INTRADAY_MS;
  if (Date.now() - entry.timestamp > ttl) {
    _candleCache.delete(key);
    return null;
  }
  return entry;
}

function setCachedCandles(symbol: string, interval: string, candles: Candle[], source: string): void {
  const key = getCacheKey(symbol, interval);
  _candleCache.set(key, { candles, source, timestamp: Date.now() });
}

export interface BrokerConn {
  api_key: string;
  account_id: string;
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
const TWELVE_DATA_SYMBOLS: Record<string, string> = {
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
  };
  return m[input] || input;
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
  };
  return m[canon] || { multiplier: 15, timespan: "minute" };
}

// How far back to look for each canonical interval
function polygonLookbackDays(canon: string): number {
  const m: Record<string, number> = {
    "1m": 1, "5m": 5, "15m": 7, "30m": 14,
    "1h": 30, "4h": 60, "1d": 365, "1w": 730,
  };
  return m[canon] || 7;
}

function twelveDataInterval(canon: string): string {
  const m: Record<string, string> = {
    "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min",
    "1h": "1h", "4h": "4h", "1d": "1day", "1w": "1week",
  };
  return m[canon] || "15min";
}

function metaapiTimeframe(canon: string): string {
  // MetaAPI uses MT5-style timeframe codes
  const m: Record<string, string> = {
    "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w",
  };
  return m[canon] || "15m";
}

// ─── MetaAPI region failover (mirrors broker-execute) ────────────────
const META_REGIONS = ["london", "new-york", "singapore"];
const regionCache = new Map<string, string>();
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
function noteRegionFailure(region: string, err: string) {
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
    noteRegionFailure(region, e?.message ?? "");
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
      noteRegionFailure(region, e?.message ?? "");
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
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${interval}&outputsize=${limit}&apikey=${apiKey}&order=ASC`;
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
  brokerConn?: BrokerConn | null; // optional MetaAPI connection
  skipBroker?: boolean;      // true for request-budget-sensitive scans; use public data directly
}

export interface FetchResult {
  candles: Candle[];
  source: "metaapi" | "twelvedata" | "polygon" | "none";
}

// ─── Per-scan source tally (opt-in) ──────────────────────────────────
// Bot scanner can call beginScanSourceTally() at the start of a cycle and
// endScanSourceTally() at the end to learn which feeds served the candles.
export interface SourceTally {
  metaapi: number;
  twelvedata: number;
  polygon: number;
  none: number;
  primary: "metaapi" | "twelvedata" | "polygon" | "none";
}
let _activeTally: { metaapi: number; twelvedata: number; polygon: number; none: number } | null = null;

export function beginScanSourceTally(): void {
  _activeTally = { metaapi: 0, twelvedata: 0, polygon: 0, none: 0 };
}

export function endScanSourceTally(): SourceTally {
  const t = _activeTally ?? { metaapi: 0, twelvedata: 0, polygon: 0, none: 0 };
  _activeTally = null;
  // "primary" = the source that served the most candle requests this cycle
  const entries: ["metaapi" | "twelvedata" | "polygon" | "none", number][] = [
    ["metaapi", t.metaapi], ["twelvedata", t.twelvedata], ["polygon", t.polygon], ["none", t.none],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return { ...t, primary: entries[0][1] > 0 ? entries[0][0] : "none" };
}

export async function fetchCandlesWithFallback(opts: FetchOptions): Promise<FetchResult> {
  const limit = opts.limit ?? 200;
  const canon = canonicalInterval(opts.interval);

  // M1: Check cache first
  const cached = getCachedCandles(opts.symbol, canon);
  if (cached && cached.candles.length >= 30) {
    if (_activeTally) (_activeTally as any)[cached.source]++;
    return { candles: cached.candles.slice(-limit), source: cached.source as any };
  }

  // Try MetaAPI first if we have a broker connection, unless the caller is a
  // request-budget-sensitive scan. Scanner invocations fetch many symbols and
  // timeframes; probing broker regions/subscriptions there can exceed hosted
  // runtime limits and surface as platform 503s.
  if (!opts.skipBroker && opts.brokerConn?.api_key && opts.brokerConn?.account_id) {
    let brokerSymbol = resolveBrokerSymbol(opts.symbol, opts.brokerConn);
    let candles = await metaFetchCandles(opts.brokerConn, brokerSymbol, canon, limit);
    console.log(`[candleSource] MetaAPI ${opts.symbol}→${brokerSymbol} ${canon}: ${candles.length} candles`);

    // Lazy auto-mapping: if we got 0 candles AND there was no explicit override,
    // fetch the broker's symbol list and try a strict match.
    if (candles.length === 0 && !hasExplicitOverride(opts.symbol, opts.brokerConn)) {
      const swapped = opts.brokerConn.account_id.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(opts.brokerConn.api_key);
      const authToken = swapped ? opts.brokerConn.account_id : opts.brokerConn.api_key;
      const metaAccountId = swapped ? opts.brokerConn.api_key : opts.brokerConn.account_id;
      const symbolList = await loadBrokerSymbolList(authToken, metaAccountId);
      const match = matchBrokerSymbol(opts.symbol, symbolList);
      if (match && match.brokerSymbol !== brokerSymbol) {
        console.log(`[candleSource] auto-mapping ${opts.symbol} ${brokerSymbol} → ${match.brokerSymbol}`);
        brokerSymbol = match.brokerSymbol;
        candles = await metaFetchCandles(opts.brokerConn, brokerSymbol, canon, limit);
        if (candles.length > 0) {
          await persistSymbolOverride(opts.brokerConn, opts.symbol, brokerSymbol);
        }
      }
    }

    if (candles.length >= 30) {
      if (_activeTally) _activeTally.metaapi++;
      setCachedCandles(opts.symbol, canon, candles, "metaapi");
      return { candles: candles.slice(-limit), source: "metaapi" };
    }
  }


  // Try Twelve Data
  const td = await twelveDataCandles(opts.symbol, canon, limit);
  if (td.length >= 30) {
    if (_activeTally) _activeTally.twelvedata++;
    setCachedCandles(opts.symbol, canon, td, "twelvedata");
    return { candles: td.slice(-limit), source: "twelvedata" };
  }

  // Polygon.io fallback
  const pg = await polygonCandles(opts.symbol, canon, limit);
  if (pg.length >= 30) {
    if (_activeTally) _activeTally.polygon++;
    setCachedCandles(opts.symbol, canon, pg, "polygon");
    return { candles: pg.slice(-limit), source: "polygon" };
  }

  // M3: Retry once after 2 seconds if all sources failed
  console.warn(`[candleSource] All sources failed for ${opts.symbol} ${canon}, retrying in 2s...`);
  await new Promise(r => setTimeout(r, 2000));

  // Retry TwelveData
  const tdRetry = await twelveDataCandles(opts.symbol, canon, limit);
  if (tdRetry.length >= 30) {
    if (_activeTally) _activeTally.twelvedata++;
    setCachedCandles(opts.symbol, canon, tdRetry, "twelvedata");
    return { candles: tdRetry.slice(-limit), source: "twelvedata" };
  }

  // Retry Polygon
  const pgRetry = await polygonCandles(opts.symbol, canon, limit);
  if (pgRetry.length >= 30) {
    if (_activeTally) _activeTally.polygon++;
    setCachedCandles(opts.symbol, canon, pgRetry, "polygon");
    return { candles: pgRetry.slice(-limit), source: "polygon" };
  }

  console.warn(`[candleSource] All sources failed for ${opts.symbol} ${canon} after retry`);
  if (_activeTally) _activeTally.none++;
  return { candles: [], source: "none" };
}
