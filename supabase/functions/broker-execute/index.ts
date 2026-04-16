import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

// Broker execution — routes orders to OANDA or MetaAPI
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization");

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error("Unauthorized");

    const { action, connectionId, ...payload } = await req.json();

    // Fetch the broker connection
    const { data: conn, error: connErr } = await supabase.from("broker_connections")
      .select("*").eq("id", connectionId).eq("user_id", user.id).single();
    if (connErr || !conn) throw new Error("Broker connection not found");

    // Auto-detect swapped fields for MetaAPI: JWT tokens start with "eyJ", account IDs are UUIDs
    if (conn.broker_type === "metaapi") {
      if (conn.account_id.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(conn.api_key)) {
        const tmp = conn.api_key;
        conn.api_key = conn.account_id;
        conn.account_id = tmp;
      }
    }

    if (action === "account_summary") {
      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/summary`, {
          headers: { Authorization: `Bearer ${conn.api_key}`, "Content-Type": "application/json" },
        });
        if (!res.ok) throw new Error(`OANDA error: ${res.status}`);
        return respond((await res.json()).account);
      }
      if (conn.broker_type === "metaapi") {
        const res = await fetch(`https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${conn.account_id}/account-information`, {
          headers: { "auth-token": conn.api_key },
        });
        if (!res.ok) throw new Error(`MetaAPI error: ${res.status}`);
        return respond(await res.json());
      }
    }

    if (action === "open_trades") {
      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/openTrades`, {
          headers: { Authorization: `Bearer ${conn.api_key}` },
        });
        if (!res.ok) throw new Error(`OANDA error: ${res.status}`);
        return respond((await res.json()).trades);
      }
      if (conn.broker_type === "metaapi") {
        const res = await fetch(`https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${conn.account_id}/positions`, {
          headers: { "auth-token": conn.api_key },
        });
        if (!res.ok) throw new Error(`MetaAPI error: ${res.status}`);
        return respond(await res.json());
      }
    }

    if (action === "place_order") {
      const { symbol, direction, size, stopLoss, takeProfit } = payload;

      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const units = direction === "long" ? Math.round(size * 100000) : -Math.round(size * 100000);
        const orderBody: any = {
          order: { type: "MARKET", instrument: symbol.replace("/", "_"), units: units.toString(), timeInForce: "FOK", positionFill: "DEFAULT" },
        };
        if (stopLoss) orderBody.order.stopLossOnFill = { price: stopLoss.toString(), timeInForce: "GTC" };
        if (takeProfit) orderBody.order.takeProfitOnFill = { price: takeProfit.toString() };

        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/orders`, {
          method: "POST", headers: { Authorization: `Bearer ${conn.api_key}`, "Content-Type": "application/json" },
          body: JSON.stringify(orderBody),
        });
        if (!res.ok) { const err = await res.json(); throw new Error(`OANDA order failed: ${JSON.stringify(err)}`); }
        return respond(await res.json());
      }

      if (conn.broker_type === "metaapi") {
        const body: any = {
          actionType: direction === "long" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
          symbol: symbol.replace("/", ""), volume: size,
        };
        if (stopLoss) body.stopLoss = stopLoss;
        if (takeProfit) body.takeProfit = takeProfit;

        const res = await fetch(`https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${conn.account_id}/trade`, {
          method: "POST", headers: { "auth-token": conn.api_key, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`MetaAPI order failed: ${res.status}`);
        return respond(await res.json());
      }
    }

    if (action === "close_trade") {
      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/trades/${payload.tradeId}/close`, {
          method: "PUT", headers: { Authorization: `Bearer ${conn.api_key}`, "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!res.ok) throw new Error(`OANDA close failed: ${res.status}`);
        return respond(await res.json());
      }
      if (conn.broker_type === "metaapi") {
        const res = await fetch(`https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${conn.account_id}/trade`, {
          method: "POST", headers: { "auth-token": conn.api_key, "Content-Type": "application/json" },
          body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId: payload.tradeId }),
        });
        if (!res.ok) throw new Error(`MetaAPI close failed: ${res.status}`);
        return respond(await res.json());
      }
    }

    return respond({ error: "Unknown action" });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function respond(data: any) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
