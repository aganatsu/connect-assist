import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";


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
      const { data, error } = await supabase.from("broker_connections").select("id, broker_type, display_name, account_id, is_live, is_active, symbol_suffix, symbol_overrides, created_at")
        .eq("user_id", user.id).order("created_at", { ascending: false });
      if (error) throw error;
      return respond(data);
    }

    if (action === "create") {
      const { data, error } = await supabase.from("broker_connections").insert({
        user_id: user.id, broker_type: payload.broker_type, display_name: payload.display_name,
        api_key: payload.api_key, account_id: payload.account_id, is_live: payload.is_live || false,
        symbol_suffix: payload.symbol_suffix || "",
        symbol_overrides: payload.symbol_overrides || {},
      }).select("id, broker_type, display_name, account_id, is_live, is_active, symbol_suffix, symbol_overrides").single();
      if (error) throw error;
      return respond(data);
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

      const { data, error } = await supabase.from("broker_connections").update(updates)
        .eq("id", payload.id).eq("user_id", user.id)
        .select("id, broker_type, display_name, account_id, is_live, is_active, symbol_suffix, symbol_overrides").single();
      if (error) throw error;
      return respond(data);
    }

    if (action === "delete") {
      const { error } = await supabase.from("broker_connections").delete().eq("id", payload.id).eq("user_id", user.id);
      if (error) throw error;
      return respond({ success: true });
    }

    if (action === "test") {
      // Fetch the connection's API key server-side
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
        // Auto-detect swapped fields: JWT tokens start with "eyJ", account IDs are UUIDs
        let authToken = conn.api_key;
        let metaAccountId = conn.account_id;
        if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
          authToken = conn.account_id;
          metaAccountId = conn.api_key;
        }

        // Step 1: provisioning API — does the account exist on MetaAPI at all?
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

        // Step 2: ping each market-data region to find where candles can actually be served from
        const REGIONS = ["london", "new-york", "singapore"];
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
      // List all symbols exposed by a MetaAPI broker account.
      // Useful for figuring out the exact name a broker uses (e.g. crypto on HFMarkets).
      const { data: conn, error } = await supabase.from("broker_connections").select("*")
        .eq("id", payload.id).eq("user_id", user.id).single();
      if (error || !conn) throw new Error("Connection not found");
      if (conn.broker_type !== "metaapi") throw new Error("list_symbols only supported for MetaAPI");

      let authToken = conn.api_key;
      let metaAccountId = conn.account_id;
      if (metaAccountId.startsWith("eyJ") && /^[0-9a-f-]{36}$/.test(authToken)) {
        authToken = conn.account_id;
        metaAccountId = conn.api_key;
      }

      const REGIONS = ["london", "new-york", "singapore"];
      let symbols: string[] = [];
      let usedRegion: string | null = null;
      let lastError = "No region returned symbols";

      for (const region of REGIONS) {
        const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${metaAccountId}/symbols`;
        try {
          const res = await fetch(url, { headers: { "auth-token": authToken } });
          const body = await res.text();
          if (res.ok) {
            const arr = JSON.parse(body);
            if (Array.isArray(arr)) {
              symbols = arr.map((s) => String(s));
              usedRegion = region;
              break;
            }
          } else {
            lastError = `${region}: ${res.status} ${body.slice(0, 120)}`;
          }
        } catch (e: any) {
          lastError = `${region}: ${e?.message || String(e)}`;
        }
      }

      if (!usedRegion) {
        return respond({ success: false, error: lastError });
      }

      // Group symbols by category for easier scanning
      const fx: string[] = [];
      const crypto: string[] = [];
      const metals: string[] = [];
      const indices: string[] = [];
      const other: string[] = [];
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
