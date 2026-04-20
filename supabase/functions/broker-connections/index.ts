import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { buildBrokerSymbolMapProbed, type TradabilityProbe } from "../_shared/symbolMatcher.ts";

// Canonical pairs the bot scanner cares about — used for auto-mapping.
const CANONICAL_PAIRS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "NZD/USD", "USD/CAD", "USD/CHF",
  "EUR/GBP", "EUR/JPY", "GBP/JPY", "EUR/AUD", "EUR/CAD", "EUR/CHF", "EUR/NZD",
  "GBP/AUD", "GBP/CAD", "GBP/CHF", "GBP/NZD", "AUD/CAD", "AUD/JPY", "CAD/JPY",
  "AUD/CHF", "AUD/NZD", "CAD/CHF", "CHF/JPY", "NZD/CAD", "NZD/CHF", "NZD/JPY",
  "XAU/USD", "XAG/USD", "BTC/USD", "ETH/USD",
  "US30", "NAS100", "SPX500", "US Oil",
];

const REGIONS = ["london", "new-york", "singapore"];

async function fetchMetaApiSymbols(authToken: string, metaAccountId: string): Promise<{ symbols: string[]; region: string | null; error?: string }> {
  let lastError = "No region returned symbols";
  for (const region of REGIONS) {
    const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${metaAccountId}/symbols`;
    try {
      const res = await fetch(url, { headers: { "auth-token": authToken } });
      const body = await res.text();
      if (res.ok) {
        const arr = JSON.parse(body);
        if (Array.isArray(arr)) return { symbols: arr.map(String), region };
      } else {
        lastError = `${region}: ${res.status} ${body.slice(0, 120)}`;
      }
    } catch (e: any) {
      lastError = `${region}: ${e?.message || String(e)}`;
    }
  }
  return { symbols: [], region: null, error: lastError };
}

function unswap(api_key: string, account_id: string): { authToken: string; metaAccountId: string } {
  if (account_id.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(api_key)) {
    return { authToken: account_id, metaAccountId: api_key };
  }
  return { authToken: api_key, metaAccountId: account_id };
}

/**
 * Build a TradabilityProbe for a MetaAPI account in a specific region.
 * Calls /symbols/{name}/specification and /symbols/{name}/current-price.
 * Both endpoints are cheap GETs; failures are swallowed (return null).
 */
function makeMetaApiProbe(authToken: string, metaAccountId: string, region: string): TradabilityProbe {
  const base = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${metaAccountId}/symbols`;
  const headers = { "auth-token": authToken };
  const cache = new Map<string, { tradeMode?: string; hasLivePrice?: boolean } | null>();

  return async (sym: string) => {
    if (cache.has(sym)) return cache.get(sym)!;
    try {
      const enc = encodeURIComponent(sym);
      const [specRes, priceRes] = await Promise.all([
        fetch(`${base}/${enc}/specification`, { headers }),
        fetch(`${base}/${enc}/current-price`, { headers }),
      ]);
      let tradeMode: string | undefined;
      let hasLivePrice = false;
      if (specRes.ok) {
        const j = await specRes.json().catch(() => null);
        // MetaAPI returns either tradeMode or trade (depending on platform)
        tradeMode = j?.tradeMode ?? j?.trade ?? undefined;
        if (typeof tradeMode === "string") tradeMode = tradeMode.toUpperCase();
      }
      if (priceRes.ok) {
        const j = await priceRes.json().catch(() => null);
        hasLivePrice = !!(j && (j.bid ?? j.ask));
      }
      const out = { tradeMode, hasLivePrice };
      cache.set(sym, out);
      return out;
    } catch {
      cache.set(sym, null);
      return null;
    }
  };
}

/** Best-effort auto-mapping with tradability probe. Logs failures, never throws. */
async function autoMapBrokerSymbols(api_key: string, account_id: string): Promise<{
  symbol_suffix: string;
  symbol_overrides: Record<string, string>;
  mapped: number;
  unmapped: string[];
  details?: Record<string, { picked: string; candidates: any[] }>;
} | null> {
  try {
    const { authToken, metaAccountId } = unswap(api_key, account_id);
    const { symbols, region } = await fetchMetaApiSymbols(authToken, metaAccountId);
    if (!symbols.length || !region) return null;

    // Use probe-aware mapper to distinguish EURUSD vs EURUSDr vs EURUSDm
    const probe = makeMetaApiProbe(authToken, metaAccountId, region);
    const { overrides, suffix, unmapped, details } = await buildBrokerSymbolMapProbed(
      CANONICAL_PAIRS, symbols, probe, { concurrency: 4 },
    );
    return { symbol_suffix: suffix, symbol_overrides: overrides, mapped: Object.keys(overrides).length, unmapped, details };
  } catch (e: any) {
    console.warn(`[broker-connections] auto-map failed: ${e?.message}`);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) throw new Error("Missing authorization");

    const token = authHeader.replace("Bearer ", "");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: claimsData, error: authError } = await supabase.auth.getClaims(token);
    if (authError || !claimsData?.claims?.sub) throw new Error("Unauthorized");
    const user = { id: claimsData.claims.sub as string };

    const { action, ...payload } = await req.json();

    if (action === "list") {
      const { data, error } = await supabase.from("broker_connections").select("id, broker_type, display_name, account_id, is_live, is_active, symbol_suffix, symbol_overrides, commission_per_lot, detected_commission_per_lot, created_at")
        .eq("user_id", user.id).order("created_at", { ascending: false });
      if (error) throw error;
      return respond(data);
    }

    if (action === "create") {
      // Auto-map MetaAPI symbols on create unless caller provided overrides
      let symbol_suffix = payload.symbol_suffix || "";
      let symbol_overrides = payload.symbol_overrides || {};
      let auto_map_info: any = null;
      if (
        payload.broker_type === "metaapi" &&
        Object.keys(symbol_overrides).length === 0
      ) {
        const mapped = await autoMapBrokerSymbols(payload.api_key, payload.account_id);
        if (mapped) {
          symbol_suffix = symbol_suffix || mapped.symbol_suffix;
          symbol_overrides = mapped.symbol_overrides;
          auto_map_info = { mapped: mapped.mapped, unmapped: mapped.unmapped, details: mapped.details };
        }
      }

      const { data, error } = await supabase.from("broker_connections").insert({
        user_id: user.id, broker_type: payload.broker_type, display_name: payload.display_name,
        api_key: payload.api_key, account_id: payload.account_id, is_live: payload.is_live || false,
        symbol_suffix, symbol_overrides,
        commission_per_lot: payload.commission_per_lot ?? 0,
      }).select("id, broker_type, display_name, account_id, is_live, is_active, symbol_suffix, symbol_overrides, commission_per_lot, detected_commission_per_lot").single();
      if (error) throw error;
      return respond({ ...data, auto_map_info });
    }

    if (action === "update") {
      const updates: any = {};
      if (payload.display_name !== undefined) updates.display_name = payload.display_name;
      if (payload.api_key !== undefined) updates.api_key = payload.api_key;
      if (payload.account_id !== undefined) updates.account_id = payload.account_id;
      if (payload.is_live !== undefined) updates.is_live = payload.is_live;
      if (payload.is_active !== undefined) updates.is_active = payload.is_active;
      if (payload.symbol_suffix !== undefined) updates.symbol_suffix = payload.symbol_suffix;
      if (payload.symbol_overrides !== undefined) updates.symbol_overrides = payload.symbol_overrides;
      if (payload.commission_per_lot !== undefined) updates.commission_per_lot = payload.commission_per_lot;
      if (payload.detected_commission_per_lot !== undefined) updates.detected_commission_per_lot = payload.detected_commission_per_lot;

      const { data, error } = await supabase.from("broker_connections").update(updates)
        .eq("id", payload.id).eq("user_id", user.id)
        .select("id, broker_type, display_name, account_id, is_live, is_active, symbol_suffix, symbol_overrides, commission_per_lot, detected_commission_per_lot").single();
      if (error) throw error;
      return respond(data);
    }

    if (action === "delete") {
      const { error } = await supabase.from("broker_connections").delete().eq("id", payload.id).eq("user_id", user.id);
      if (error) throw error;
      return respond({ success: true });
    }

    if (action === "auto_map_symbols") {
      // Manual re-discovery: fetch broker's symbol list, run strict matcher,
      // overwrite symbol_suffix + symbol_overrides on the connection.
      const { data: conn, error } = await supabase.from("broker_connections").select("*")
        .eq("id", payload.id).eq("user_id", user.id).single();
      if (error || !conn) throw new Error("Connection not found");
      if (conn.broker_type !== "metaapi") throw new Error("auto_map_symbols only supported for MetaAPI");

      const mapped = await autoMapBrokerSymbols(conn.api_key, conn.account_id);
      if (!mapped) return respond({ success: false, error: "Could not fetch symbols from broker" });

      const { error: upErr } = await supabase.from("broker_connections")
        .update({ symbol_suffix: mapped.symbol_suffix, symbol_overrides: mapped.symbol_overrides })
        .eq("id", payload.id).eq("user_id", user.id);
      if (upErr) throw upErr;

      return respond({
        success: true,
        symbol_suffix: mapped.symbol_suffix,
        symbol_overrides: mapped.symbol_overrides,
        mapped: mapped.mapped,
        unmapped: mapped.unmapped,
        details: mapped.details,
      });
    }

    if (action === "probe_symbols") {
      // Validate a list of broker symbols against MetaAPI: returns tradeMode + live-price for each.
      // Used by the UI to auto-validate manually-typed symbol mappings on save.
      const { data: conn, error } = await supabase.from("broker_connections").select("*")
        .eq("id", payload.id).eq("user_id", user.id).single();
      if (error || !conn) throw new Error("Connection not found");
      if (conn.broker_type !== "metaapi") throw new Error("probe_symbols only supported for MetaAPI");

      const symbols: string[] = Array.isArray(payload.symbols) ? payload.symbols.filter(Boolean) : [];
      if (!symbols.length) return respond({ success: true, results: {} });

      const { authToken, metaAccountId } = unswap(conn.api_key, conn.account_id);
      // Find a reachable region (use the same approach as fetchMetaApiSymbols)
      const { region } = await fetchMetaApiSymbols(authToken, metaAccountId);
      if (!region) return respond({ success: false, error: "No reachable MetaAPI region" });

      const probe = makeMetaApiProbe(authToken, metaAccountId, region);
      // Probe in parallel (small concurrency to be polite to MetaAPI)
      const results: Record<string, { tradeMode?: string; hasLivePrice?: boolean } | null> = {};
      const queue = [...symbols];
      const workers = Array.from({ length: 4 }, async () => {
        while (queue.length) {
          const sym = queue.shift()!;
          results[sym] = await probe(sym);
        }
      });
      await Promise.all(workers);
      return respond({ success: true, region, results });
    }

    if (action === "test") {
      const { data: conn, error } = await supabase.from("broker_connections").select("*")
        .eq("id", payload.id).eq("user_id", user.id).single();
      if (error || !conn) throw new Error("Connection not found");

      if (conn.broker_type === "oanda") {
        const baseUrl = conn.is_live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
        const res = await fetch(`${baseUrl}/v3/accounts/${conn.account_id}/summary`, {
          headers: { Authorization: `Bearer ${conn.api_key}`, "Content-Type": "application/json" },
        });
        if (!res.ok) throw new Error(`OANDA API error: ${res.status}`);
        const data = await res.json();
        return respond({ success: true, balance: data.account?.balance, currency: data.account?.currency });
      }

      if (conn.broker_type === "metaapi") {
        const { authToken, metaAccountId } = unswap(conn.api_key, conn.account_id);

        let provisioning: any = null;
        try {
          const provRes = await fetch(`https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${metaAccountId}`, {
            headers: { "auth-token": authToken, "Content-Type": "application/json" },
          });
          if (provRes.ok) {
            provisioning = await provRes.json();
          } else {
            const errText = await provRes.text();
            return respond({
              success: false,
              stage: "provisioning",
              error: `MetaAPI provisioning ${provRes.status}: ${errText.slice(0, 200)}`,
              hint: provRes.status === 404
                ? "Account ID not found in your MetaAPI account. Check the UUID in your MetaAPI dashboard."
                : provRes.status === 401
                ? "Auth token is invalid or expired. Generate a new one in your MetaAPI dashboard."
                : "Check MetaAPI dashboard for account status.",
            });
          }
        } catch (e: any) {
          const msg = e?.message || String(e);
          if (msg.includes("invalid peer certificate") || msg.includes("UnknownIssuer")) {
            return respond({ success: false, error: "SSL certificate issue connecting to MetaApi." });
          }
          return respond({ success: false, stage: "provisioning", error: msg });
        }

        const regionResults = await Promise.all(REGIONS.map(async (region) => {
          const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${metaAccountId}/historical-market-data/symbols/EURUSD${conn.symbol_suffix || ""}/timeframes/1d/candles?limit=1`;
          try {
            const res = await fetch(url, { headers: { "auth-token": authToken } });
            const body = await res.text();
            if (res.ok) {
              const arr = JSON.parse(body);
              return { region, ok: true, status: res.status, candleCount: Array.isArray(arr) ? arr.length : 0 };
            }
            return { region, ok: false, status: res.status, error: body.slice(0, 150) };
          } catch (e: any) {
            const msg = e?.message || String(e);
            return { region, ok: false, status: 0, error: msg.includes("dns error") ? "DNS lookup failed (region not provisioned)" : msg.slice(0, 150) };
          }
        }));

        const reachableRegion = regionResults.find((r) => r.ok)?.region ?? null;
        return respond({
          success: !!reachableRegion,
          name: provisioning?.name,
          type: provisioning?.type,
          platform: provisioning?.platform,
          state: provisioning?.state,
          connectionStatus: provisioning?.connectionStatus,
          configuredRegion: provisioning?.region,
          reachableRegion,
          regions: regionResults,
          hint: !reachableRegion
            ? "Account exists in MetaAPI but no region can serve candle data. Most likely the account is UNDEPLOYED — deploy it from your MetaAPI dashboard."
            : undefined,
        });
      }

      throw new Error(`Unsupported broker: ${conn.broker_type}`);
    }

    if (action === "list_symbols") {
      const { data: conn, error } = await supabase.from("broker_connections").select("*")
        .eq("id", payload.id).eq("user_id", user.id).single();
      if (error || !conn) throw new Error("Connection not found");
      if (conn.broker_type !== "metaapi") throw new Error("list_symbols only supported for MetaAPI");

      const { authToken, metaAccountId } = unswap(conn.api_key, conn.account_id);
      const { symbols, region: usedRegion, error: lastError } = await fetchMetaApiSymbols(authToken, metaAccountId);
      if (!usedRegion) return respond({ success: false, error: lastError });

      const fx: string[] = [], crypto: string[] = [], metals: string[] = [], indices: string[] = [], other: string[] = [];
      for (const s of symbols) {
        const u = s.toUpperCase();
        if (/BTC|ETH|XRP|LTC|BCH|SOL|DOGE|ADA|DOT|LINK|XLM|TRX|AVAX|MATIC/.test(u)) crypto.push(s);
        else if (/XAU|XAG|GOLD|SILV/.test(u)) metals.push(s);
        else if (/US30|US500|SPX|NAS|DAX|FTSE|NIK|HK|JPN|GER|UK100|NDX/.test(u)) indices.push(s);
        else if (/^[#a-z]?(EUR|USD|GBP|JPY|AUD|CAD|CHF|NZD)/i.test(u) && u.length <= 12) fx.push(s);
        else other.push(s);
      }

      return respond({ success: true, region: usedRegion, total: symbols.length, symbols, grouped: { fx, crypto, metals, indices, other } });
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
