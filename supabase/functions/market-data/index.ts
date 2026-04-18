import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { fetchCandlesWithFallback, type BrokerConn } from "../_shared/candleSource.ts";

// market-data: unified candle/quote endpoint with MetaAPI → Twelve Data → Yahoo failover.
// If the caller is authenticated and has an active MetaAPI broker connection, we prefer it.
// Otherwise we fall back to Twelve Data, then Yahoo.

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
      .select("api_key, account_id, symbol_suffix, symbol_overrides, created_at")
      .eq("user_id", userId).eq("broker_type", "metaapi").eq("is_active", true)
      .order("created_at", { ascending: false });
    if (!data || data.length === 0) return null;
    // Prefer rows where account_id looks like a clean UUID (most likely correctly stored).
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const preferred = data.find((r: any) => uuidRe.test(r.account_id)) || data[0];
    return preferred as BrokerConn;
  } catch (e: any) {
    console.warn(`[market-data] broker conn load failed: ${e?.message}`);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { action, symbol, interval, outputsize = 200 } = await req.json();
    if (!symbol) {
      return new Response(JSON.stringify({ error: "Missing symbol" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const brokerConn = await loadBrokerConn(req);

    if (action === "quote") {
      // Quote = last close from a small daily fetch
      const { candles, source } = await fetchCandlesWithFallback({
        symbol, interval: "1d", limit: 5, brokerConn,
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
