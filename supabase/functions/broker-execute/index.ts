import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";


// Broker execution — routes orders to OANDA or MetaAPI

// Normalize a symbol/key for case-insensitive, whitespace-insensitive matching.
// Strips slashes, spaces, dots, hyphens, underscores; uppercases.
function normalizeKey(s: string): string {
  return (s || "").toString().trim().toUpperCase().replace(/[\s/._-]/g, "");
}

// Resolve symbol name: check normalized override map first, then apply default suffix.
// Override value (broker symbol) is returned EXACTLY as the user entered it.
function resolveSymbol(symbol: string, conn: any): string {
  const rawOverrides = conn.symbol_overrides || {};
  const norm = normalizeKey(symbol);
  // Build a normalized lookup so "EUR/USD", "eurusd", "EURUSD" all hit the same entry
  for (const [k, v] of Object.entries(rawOverrides)) {
    if (normalizeKey(k) === norm && v) return String(v);
  }
  const base = symbol.trim().replace(/\s+/g, "").replace("/", "").toUpperCase();
  return base + (conn.symbol_suffix || "");
}

// OANDA uses underscore format (EUR_USD). Honor overrides first.
function resolveOandaSymbol(symbol: string, conn: any): string {
  const rawOverrides = conn.symbol_overrides || {};
  const norm = normalizeKey(symbol);
  for (const [k, v] of Object.entries(rawOverrides)) {
    if (normalizeKey(k) === norm && v) return String(v);
  }
  // Default: convert "EUR/USD" or "EURUSD" to "EUR_USD"
  const cleaned = symbol.trim().replace(/\s+/g, "").toUpperCase();
  if (cleaned.includes("/")) return cleaned.replace("/", "_");
  if (cleaned.length === 6 && !cleaned.includes("_")) return `${cleaned.slice(0, 3)}_${cleaned.slice(3)}`;
  return cleaned;
}

// MetaAPI regions — try in order until one returns a non-region-mismatch response. Cached per account.
const META_REGIONS = ["london", "new-york", "singapore"];
const regionCache = new Map<string, string>();
function metaBaseUrl(region: string, accountId: string) {
  return `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}`;
}
// Try each region until one succeeds (or until the error is clearly not a region mismatch).
async function metaFetch(accountId: string, authToken: string, pathBuilder: (base: string) => string, init?: RequestInit): Promise<{ res: Response; body: string }> {
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
    if (!/region|not connected to broker/i.test(body)) {
      return { res: new Response(body, { status: res.status }), body };
    }
    console.warn(`MetaAPI ${region} returned ${res.status} (region/connection mismatch), trying next...`);
  }
  return { res: new Response(lastBody, { status: lastStatus }), body: lastBody };
}

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
        if (!res.ok) { const errText = await res.text(); return respond({ error: `OANDA error: ${res.status}`, details: errText, fallback: res.status >= 500 }, res.status); }
        return respond((await res.json()).account);
      }
      if (conn.broker_type === "metaapi") {
        const { res, body } = await metaFetch(conn.account_id, conn.api_key, (b) => `${b}/account-information`);
        if (!res.ok) return respond({ error: `MetaAPI error: ${res.status}`, details: body, fallback: res.status >= 500 || /not connected to broker|region/i.test(body) }, 200);
        return respond(JSON.parse(body));
      }
    }

    if (action === "open_trades") {
      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/openTrades`, {
          headers: { Authorization: `Bearer ${conn.api_key}` },
        });
        if (!res.ok) { const errText = await res.text(); return respond({ error: `OANDA error: ${res.status}`, details: errText, fallback: res.status >= 500 }, res.status); }
        return respond((await res.json()).trades);
      }
      if (conn.broker_type === "metaapi") {
        const { res, body } = await metaFetch(conn.account_id, conn.api_key, (b) => `${b}/positions`);
        if (!res.ok) return respond({ error: `MetaAPI error: ${res.status}`, details: body, fallback: res.status >= 500 || /not connected to broker|region/i.test(body) }, 200);
        return respond(JSON.parse(body));
      }
    }

    if (action === "place_order") {
      const { symbol, direction, size, stopLoss, takeProfit } = payload;

      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const units = direction === "long" ? Math.round(size * 100000) : -Math.round(size * 100000);
        const oandaInstrument = resolveOandaSymbol(symbol, conn);
        const orderBody: any = {
          order: { type: "MARKET", instrument: oandaInstrument, units: units.toString(), timeInForce: "FOK", positionFill: "DEFAULT" },
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
        const tradeBody: any = {
          actionType: direction === "long" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
          symbol: resolveSymbol(symbol, conn), volume: size,
        };
        if (stopLoss) tradeBody.stopLoss = stopLoss;
        if (takeProfit) tradeBody.takeProfit = takeProfit;
        const { res, body } = await metaFetch(conn.account_id, conn.api_key, (b) => `${b}/trade`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tradeBody),
        });
        if (!res.ok) return respond({ error: `MetaAPI order failed: ${res.status}`, details: body, fallback: res.status >= 500 || /not connected to broker|region/i.test(body) }, 200);
        return respond(JSON.parse(body));
      }
    }

    if (action === "account_balance") {
      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/summary`, {
          headers: { Authorization: `Bearer ${conn.api_key}`, "Content-Type": "application/json" },
        });
        if (!res.ok) { const errText = await res.text(); return respond({ error: `OANDA error: ${res.status}`, details: errText, fallback: res.status >= 500 }, res.status); }
        const acct = (await res.json()).account;
        return respond({
          balance: parseFloat(acct.balance ?? "0"),
          equity: parseFloat(acct.NAV ?? acct.balance ?? "0"),
          currency: acct.currency ?? "USD",
        });
      }
      if (conn.broker_type === "metaapi") {
        const { res, body } = await metaFetch(conn.account_id, conn.api_key, (b) => `${b}/account-information`);
        if (!res.ok) return respond({ error: `MetaAPI error: ${res.status}`, details: body, fallback: res.status >= 500 || /not connected to broker|region/i.test(body) }, 200);
        const info: any = JSON.parse(body);
        return respond({
          balance: parseFloat(info.balance ?? "0"),
          equity: parseFloat(info.equity ?? info.balance ?? "0"),
          currency: info.currency ?? "USD",
        });
      }
      throw new Error(`account_balance not supported for broker type: ${conn.broker_type}`);
    }

    if (action === "symbol_specs" || action === "validate_symbol") {
      const { symbol } = payload;
      if (!symbol) throw new Error("Missing symbol parameter");

      if (conn.broker_type === "metaapi") {
        let authToken = conn.api_key;
        let metaAccountId = conn.account_id;
        if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
          authToken = conn.account_id;
          metaAccountId = conn.api_key;
        }
        const brokerSym = resolveSymbol(symbol, conn);
        const { res, body } = await metaFetch(metaAccountId, authToken, (b) => `${b}/symbols/${encodeURIComponent(brokerSym)}/specification`);
        if (!res.ok) {
          if (action === "validate_symbol") {
            return respond({ ok: false, brokerSymbol: brokerSym, status: res.status, error: body.slice(0, 300) });
          }
          return respond({ error: `MetaAPI symbol_specs error: ${res.status}`, details: body, fallback: res.status >= 500 || /not connected to broker|region/i.test(body) }, 200);
        }
        const spec: any = JSON.parse(body);
        if (action === "validate_symbol") {
          return respond({ ok: true, brokerSymbol: brokerSym, digits: spec.digits, minVolume: spec.minVolume, maxVolume: spec.maxVolume });
        }
        return respond({
          contractSize: spec.contractSize ?? 1,
          minVolume: spec.minVolume ?? 0.01,
          maxVolume: spec.maxVolume ?? 100,
          volumeStep: spec.volumeStep ?? 0.01,
          digits: spec.digits ?? 5,
          stopsLevel: spec.stopsLevel ?? 0,
        });
      }

      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const oandaSym = resolveOandaSymbol(symbol, conn);
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/instruments?instruments=${encodeURIComponent(oandaSym)}`, {
          headers: { Authorization: `Bearer ${conn.api_key}` },
        });
        if (!res.ok) {
          const errText = await res.text();
          if (action === "validate_symbol") {
            return respond({ ok: false, brokerSymbol: oandaSym, status: res.status, error: errText.slice(0, 300) });
          }
          throw new Error(`OANDA symbol_specs error: ${res.status}`);
        }
        const data: any = await res.json();
        const inst = data.instruments?.[0];
        if (!inst) {
          if (action === "validate_symbol") {
            return respond({ ok: false, brokerSymbol: oandaSym, error: `Instrument not found: ${oandaSym}` });
          }
          throw new Error(`OANDA instrument not found: ${oandaSym}`);
        }
        if (action === "validate_symbol") {
          return respond({ ok: true, brokerSymbol: oandaSym, digits: inst.displayPrecision });
        }
        return respond({
          contractSize: 1,
          minVolume: parseFloat(inst.minimumTradeSize || "0.01"),
          maxVolume: parseFloat(inst.maximumOrderUnits || "100000000"),
          volumeStep: parseFloat(inst.minimumTradeSize || "0.01"),
          digits: inst.displayPrecision ?? 5,
          stopsLevel: 0,
        });
      }

      throw new Error(`${action} not supported for broker type: ${conn.broker_type}`);
    }

    if (action === "connection_status") {
      if (conn.broker_type === "metaapi") {
        // Provisioning API — returns account state regardless of broker connection
        const provUrl = `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${conn.account_id}`;
        const res = await fetch(provUrl, { headers: { "auth-token": conn.api_key } });
        const body = await res.text();
        if (!res.ok) {
          return respond({ ok: false, error: `MetaAPI provisioning ${res.status}`, details: body.slice(0, 300), fallback: true }, 200);
        }
        const info: any = JSON.parse(body);
        return respond({
          ok: true,
          state: info.state ?? "UNKNOWN",          // DEPLOYED / UNDEPLOYED / DEPLOYING
          connectionStatus: info.connectionStatus ?? "UNKNOWN", // CONNECTED / DISCONNECTED / DISCONNECTED_FROM_BROKER
          name: info.name,
          login: info.login,
          server: info.server,
          region: info.region,
          ready: info.state === "DEPLOYED" && info.connectionStatus === "CONNECTED",
        });
      }
      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/summary`, {
          headers: { Authorization: `Bearer ${conn.api_key}` },
        });
        if (!res.ok) return respond({ ok: false, error: `OANDA ${res.status}`, fallback: true }, 200);
        const acct = (await res.json()).account;
        return respond({ ok: true, state: "DEPLOYED", connectionStatus: "CONNECTED", ready: true, name: acct.alias, login: acct.id });
      }
      throw new Error(`connection_status not supported for: ${conn.broker_type}`);
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
        const { res, body } = await metaFetch(conn.account_id, conn.api_key, (b) => `${b}/trade`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId: payload.tradeId }),
        });
        if (!res.ok) return respond({ error: `MetaAPI close failed: ${res.status}`, details: body, fallback: res.status >= 500 || /not connected to broker|region/i.test(body) }, 200);
        return respond(JSON.parse(body));
      }
    }

    return respond({ error: "Unknown action" });
  } catch (error: any) {
    console.error("broker-execute error:", error?.message || error);
    return new Response(JSON.stringify({ error: error.message, fallback: true }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function respond(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
