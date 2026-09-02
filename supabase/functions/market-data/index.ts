import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { fetchCandlesWithFallback, type BrokerConn } from "../_shared/candleSource.ts";
import { setCreditCallerContext } from "../_shared/apiCreditBudget.ts";

// Attribute this isolate's TwelveData credits. Six functions reach the
// provider through candleSource; unlabelled, they all report as "unknown"
// and api_credit_usage cannot say which one to trim. Measured 2026-09-02:
// 250 of 589 credits in a 29-minute window were unattributed.
setCreditCallerContext("market-data");

/**
 * Candles requested for a quote.
 *
 * A quote needs two closes — last and previous — but fetchCandlesWithFallback
 * discards any source returning fewer than 30, so asking for fewer than 30 is
 * asking for nothing. TwelveData bills per request, not per candle, so 60 costs
 * exactly what 5 cost and actually clears the floor.
 *
 * Clearing it also makes the result cacheable: setCachedCandles is only reached
 * from the same >= 30 branches, and daily candles hold for CACHE_TTL_DAILY_MS
 * (5 minutes). Measured 2026-09-02, market-data was the single largest consumer
 * of the plan at ~32 credits/min — 58% of a 55/min plan — every one of them
 * returning NO_DATA.
 */
const QUOTE_CANDLE_LIMIT = 60;

// market-data: unified candle/quote endpoint with MetaAPI → Twelve Data → Polygon.io failover.
// If the caller is authenticated and has an active MetaAPI broker connection, we prefer it.
// Otherwise we fall back to Twelve Data, then Polygon.io.

async function loadBrokerConn(req: Request): Promise<BrokerConn | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error } = await supabase.auth.getClaims(token);
    if (error || !claimsData?.claims?.sub) return null;
    const userId = claimsData.claims.sub as string;
    const { data } = await supabase.from("broker_connections")
      .select("id, api_key, account_id, symbol_suffix, symbol_overrides")
      .eq("user_id", userId).eq("broker_type", "metaapi").eq("is_active", true).limit(1);
    return (data && data[0]) ? ({ ...data[0], user_id: userId } as BrokerConn) : null;
  } catch (e: any) {
    console.warn(`[market-data] broker conn load failed: ${e?.message}`);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { action, symbol, symbols, interval, outputsize = 200 } = await req.json();
    if (!symbol && action !== "batch_quotes") {
      // Return a soft fallback instead of 400 so callers (charts/quotes) don't crash
      // when a symbol is briefly undefined during render.
      console.warn(`[market-data] missing symbol for action=${action}`);
      return new Response(
        JSON.stringify(action === "candles" ? [] : { error: "NO_DATA", fallback: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const brokerConn = await loadBrokerConn(req);

    if (action === "quote") {
      // Quote = last close from a daily fetch.
      //
      // QUOTE_CANDLE_LIMIT, not 5. fetchCandlesWithFallback rejects any source
      // returning fewer than 30 candles, at every accept point, so a 5-candle
      // request spent the credit and then failed the floor — falling through to
      // Polygon, which has no key, and returning NO_DATA every time. It was also
      // never cached, because setCachedCandles only runs inside those same
      // >= 30 branches, so all six polls a minute went to the network.
      const { candles, source } = await fetchCandlesWithFallback({
        symbol, interval: "1d", limit: QUOTE_CANDLE_LIMIT, brokerConn,
      });
      if (candles.length === 0) {
        return new Response(JSON.stringify({ error: "NO_DATA", fallback: true }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const last = candles[candles.length - 1];
      const prev = candles.length > 1 ? candles[candles.length - 2] : last;
      const previousClose = prev.close;
      const currentPrice = last.close;
      const change = currentPrice - previousClose;
      const percentChange = previousClose > 0 ? (change / previousClose) * 100 : 0;
      return new Response(JSON.stringify({
        price: currentPrice, change, percentChange,
        open: last.open, high: last.high, low: last.low,
        previousClose, source,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Fix #5: Batch quotes — fetch multiple symbols in one call to reduce request count
    if (action === "batch_quotes") {
      const batchSymbols: string[] = (Array.isArray(symbols) ? symbols : (symbol ? [symbol] : []));
      if (!batchSymbols.length || batchSymbols.length > 30) {
        return new Response(JSON.stringify({ error: "Provide 1-30 symbols in 'symbols' array" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Fetch all quotes concurrently
      const results: Record<string, any> = {};
      await Promise.all(batchSymbols.map(async (sym: string) => {
        try {
          const { candles, source } = await fetchCandlesWithFallback({
            symbol: sym, interval: "1d", limit: QUOTE_CANDLE_LIMIT, brokerConn,
          });
          if (candles.length === 0) {
            results[sym] = { error: "NO_DATA" };
            return;
          }
          const last = candles[candles.length - 1];
          const prev = candles.length > 1 ? candles[candles.length - 2] : last;
          const previousClose = prev.close;
          const currentPrice = last.close;
          const change = currentPrice - previousClose;
          const percentChange = previousClose > 0 ? (change / previousClose) * 100 : 0;
          results[sym] = {
            price: currentPrice, change, percentChange,
            open: last.open, high: last.high, low: last.low,
            previousClose, source,
          };
        } catch (e: any) {
          results[sym] = { error: e?.message || "FETCH_FAILED" };
        }
      }));
      return new Response(JSON.stringify(results), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Default: candles
    const { candles, source } = await fetchCandlesWithFallback({
      symbol,
      interval: interval || "1day",
      limit: outputsize,
      brokerConn,
    });

    if (candles.length === 0) {
      return new Response(JSON.stringify({ error: "NO_DATA", fallback: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Match legacy datetime format ("YYYY-MM-DD HH:MM:SS") expected by existing chart code
    const formatted = candles.map((c) => ({
      datetime: c.datetime.replace("T", " ").substring(0, 19),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    return new Response(JSON.stringify(formatted), {
      headers: { ...corsHeaders, "Content-Type": "application/json", "x-data-source": source },
    });
  } catch (error: any) {
    console.error("market-data unexpected error:", error?.message);
    return new Response(JSON.stringify({ error: "SERVICE_FAILED", fallback: true }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
