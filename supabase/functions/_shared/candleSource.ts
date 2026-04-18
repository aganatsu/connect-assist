// ─── Unified Candle Source with Failover ─────────────────────────────
// Order of preference:
//   1. MetaAPI (broker feed) — same prices as execution, zero drift
//   2. Twelve Data — real FX/indices/crypto, documented API
//   3. Yahoo Finance — last-resort fallback (15-min delayed, undocumented)
//
// Each provider returns the same Candle[] shape so callers stay agnostic.

export interface Candle {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface BrokerConn {
  api_key: string;
  account_id: string;
  symbol_suffix?: string;
  symbol_overrides?: Record<string, string>;
}

// ─── Symbol mapping per provider ─────────────────────────────────────
const YAHOO_SYMBOLS: Record<string, string> = {
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

function yahooInterval(canon: string): string {
  // Yahoo doesn't natively support 4h — caller aggregates from 1h
  const m: Record<string, string> = {
    "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "60m", "4h": "60m", "1d": "1d", "1w": "1wk",
  };
  return m[canon] || "15m";
}

function yahooRange(canon: string): string {
  const m: Record<string, string> = {
    "1m": "1d", "5m": "5d", "15m": "5d", "30m": "5d",
    "1h": "30d", "4h": "60d", "1d": "1y", "1w": "2y",
  };
  return m[canon] || "5d";
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
    const res = await fetch(url, { headers: { "auth-token": authToken } });
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
    console.warn(`[candleSource] MetaAPI subscribe error for ${brokerSymbol}: ${e?.message}`);
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
  const order = cached ? [cached, ...META_REGIONS.filter((r) => r !== cached)] : META_REGIONS;

  for (const region of order) {
    const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${metaAccountId}/historical-market-data/symbols/${encodeURIComponent(brokerSymbol)}/timeframes/${tf}/candles?limit=${limit}`;
    try {
      const res = await fetch(url, { headers: { "auth-token": authToken } });
      const body = await res.text();
      if (res.ok) {
        regionCache.set(metaAccountId, region);
        const arr = JSON.parse(body);
        if (!Array.isArray(arr)) return [];
        return arr.map((c: any) => ({
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
      }
      // 404 / NotFoundError → account isn't deployed in this region, try the next one.
      // Other status codes (auth, rate-limit, etc.) are not region-specific → stop probing.
      const isRegionMiss =
        res.status === 404 ||
        /region|not connected to broker|notfounderror|could not find path/i.test(body);
      if (!isRegionMiss) {
        console.warn(`[candleSource] MetaAPI ${region} non-region error ${res.status}: ${body.slice(0, 120)}`);
        return [];
      }
      // Quietly continue to next region on 404 (avoids log spam from the multi-region probe)
      if (region === order[order.length - 1]) {
        console.warn(`[candleSource] MetaAPI account ${metaAccountId.slice(0, 8)}… not found in any region (${order.join(", ")})`);
      }
    } catch (e: any) {
      console.warn(`[candleSource] MetaAPI ${region} fetch error: ${e?.message}`);
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

  const interval = twelveDataInterval(canon);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${interval}&outputsize=${limit}&apikey=${apiKey}&order=ASC`;
  try {
    const res = await fetch(url);
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

// ─── Yahoo Finance ────────────────────────────────────────────────────
async function yahooCandles(
  symbol: string,
  canon: string,
): Promise<Candle[]> {
  const ySym = YAHOO_SYMBOLS[symbol];
  if (!ySym) return [];
  const interval = yahooInterval(canon);
  const range = yahooRange(canon);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ySym}?interval=${interval}&range=${range}`;
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
    return candles;
  } catch (e: any) {
    console.warn(`[candleSource] Yahoo fetch error: ${e?.message}`);
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
}

export interface FetchResult {
  candles: Candle[];
  source: "metaapi" | "twelvedata" | "yahoo" | "none";
}

// ─── Per-scan source tally (opt-in) ──────────────────────────────────
// Bot scanner can call beginScanSourceTally() at the start of a cycle and
// endScanSourceTally() at the end to learn which feeds served the candles.
export interface SourceTally {
  metaapi: number;
  twelvedata: number;
  yahoo: number;
  none: number;
  primary: "metaapi" | "twelvedata" | "yahoo" | "none";
}
let _activeTally: { metaapi: number; twelvedata: number; yahoo: number; none: number } | null = null;

export function beginScanSourceTally(): void {
  _activeTally = { metaapi: 0, twelvedata: 0, yahoo: 0, none: 0 };
}

export function endScanSourceTally(): SourceTally {
  const t = _activeTally ?? { metaapi: 0, twelvedata: 0, yahoo: 0, none: 0 };
  _activeTally = null;
  // "primary" = the source that served the most candle requests this cycle
  const entries: ["metaapi" | "twelvedata" | "yahoo" | "none", number][] = [
    ["metaapi", t.metaapi], ["twelvedata", t.twelvedata], ["yahoo", t.yahoo], ["none", t.none],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return { ...t, primary: entries[0][1] > 0 ? entries[0][0] : "none" };
}

export async function fetchCandlesWithFallback(opts: FetchOptions): Promise<FetchResult> {
  const limit = opts.limit ?? 200;
  const canon = canonicalInterval(opts.interval);

  // Try MetaAPI first if we have a broker connection
  if (opts.brokerConn?.api_key && opts.brokerConn?.account_id) {
    const brokerSymbol = resolveBrokerSymbol(opts.symbol, opts.brokerConn);
    const candles = await metaFetchCandles(opts.brokerConn, brokerSymbol, canon, limit);
    if (candles.length >= 30) {
      if (_activeTally) _activeTally.metaapi++;
      return { candles: candles.slice(-limit), source: "metaapi" };
    }
  }

  // Try Twelve Data
  const td = await twelveDataCandles(opts.symbol, canon, limit);
  if (td.length >= 30) {
    if (_activeTally) _activeTally.twelvedata++;
    return { candles: td.slice(-limit), source: "twelvedata" };
  }

  // Yahoo fallback (with 4h aggregation if needed)
  let yc = await yahooCandles(opts.symbol, canon);
  if (canon === "4h" && yc.length > 0) yc = aggregateTo4H(yc);
  if (yc.length > 0) {
    if (_activeTally) _activeTally.yahoo++;
    return { candles: yc.slice(-limit), source: "yahoo" };
  }

  if (_activeTally) _activeTally.none++;
  return { candles: [], source: "none" };
}
