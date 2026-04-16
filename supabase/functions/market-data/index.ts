import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

// Yahoo Finance symbol mapping
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
  // Indices
  "US30": "YM=F", "NAS100": "NQ=F", "SPX500": "ES=F",
  // Commodities
  "XAU/USD": "GC=F", "XAG/USD": "SI=F", "US Oil": "CL=F",
  // Crypto
  "BTC/USD": "BTC-USD", "ETH/USD": "ETH-USD",
};

const YAHOO_INTERVALS: Record<string, string> = {
  "1week": "1wk", "1day": "1d", "4h": "60m", "1h": "60m", "15min": "15m", "5min": "5m",
};

const YAHOO_RANGES: Record<string, string> = {
  "1week": "2y", "1day": "1y", "4h": "60d", "1h": "30d", "15min": "5d", "5min": "5d",
};

function aggregateTo4H(candles: any[]): any[] {
  const aggregated: any[] = [];
  let bucket: any = null;
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
    if (count >= 4) { aggregated.push(bucket); bucket = null; count = 0; }
  }
  if (bucket) aggregated.push(bucket);
  return aggregated;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { action, symbol, interval, outputsize = 200 } = await req.json();

    const yahooSymbol = YAHOO_SYMBOLS[symbol];
    if (!yahooSymbol) {
      return new Response(JSON.stringify({ error: `Unknown symbol: ${symbol}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "quote") {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=5d`;
      const res = await fetch(url, { headers: { "User-Agent": "SMC-Trading-Dashboard/1.0" } });
      const data = await res.json();
      if (!data?.chart?.result?.[0]) throw new Error("No data from Yahoo Finance");

      const meta = data.chart.result[0].meta;
      const previousClose = meta.chartPreviousClose || meta.previousClose || 0;
      const currentPrice = meta.regularMarketPrice || 0;
      const change = currentPrice - previousClose;
      const percentChange = previousClose > 0 ? (change / previousClose) * 100 : 0;

      return new Response(JSON.stringify({
        price: currentPrice, change, percentChange,
        open: meta.regularMarketOpen || currentPrice,
        high: meta.regularMarketDayHigh || currentPrice,
        low: meta.regularMarketDayLow || currentPrice,
        previousClose,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Default: candles
    const yahooInterval = YAHOO_INTERVALS[interval] || "1d";
    const yahooRange = YAHOO_RANGES[interval] || "1y";
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${yahooInterval}&range=${yahooRange}&includeAdjustedClose=true`;
    const res = await fetch(url, { headers: { "User-Agent": "SMC-Trading-Dashboard/1.0" } });
    const data = await res.json();

    if (!data?.chart?.result?.[0]) throw new Error("No data from Yahoo Finance");

    const chartResult = data.chart.result[0];
    const timestamps: number[] = chartResult.timestamp || [];
    const quotes = chartResult.indicators?.quote?.[0];
    if (!quotes || timestamps.length === 0) throw new Error("No price data");

    let candles: any[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = quotes.open?.[i], h = quotes.high?.[i], l = quotes.low?.[i], c = quotes.close?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      const dt = new Date(timestamps[i] * 1000).toISOString().replace("T", " ").substring(0, 19);
      candles.push({ datetime: dt, open: Number(o), high: Number(h), low: Number(l), close: Number(c), volume: quotes.volume?.[i] ?? undefined });
    }

    if (interval === "4h") candles = aggregateTo4H(candles);
    if (candles.length > outputsize) candles = candles.slice(candles.length - outputsize);

    return new Response(JSON.stringify(candles), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
