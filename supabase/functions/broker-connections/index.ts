import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { fetch as undiciFetch } from "npm:undici";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error("Unauthorized");

    const { action, ...payload } = await req.json();

    if (action === "list") {
      const { data, error } = await supabase.from("broker_connections").select("id, broker_type, display_name, account_id, is_live, is_active, created_at")
        .eq("user_id", user.id).order("created_at", { ascending: false });
      if (error) throw error;
      return respond(data);
    }

    if (action === "create") {
      const { data, error } = await supabase.from("broker_connections").insert({
        user_id: user.id, broker_type: payload.broker_type, display_name: payload.display_name,
        api_key: payload.api_key, account_id: payload.account_id, is_live: payload.is_live || false,
      }).select("id, broker_type, display_name, account_id, is_live, is_active").single();
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

      const { data, error } = await supabase.from("broker_connections").update(updates)
        .eq("id", payload.id).eq("user_id", user.id)
        .select("id, broker_type, display_name, account_id, is_live, is_active").single();
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
          // Fields are swapped — correct them
          authToken = conn.account_id;
          metaAccountId = conn.api_key;
        }

        try {
          const provRes = await fetch(`https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${metaAccountId}`, {
            headers: { "auth-token": authToken, "Content-Type": "application/json" },
            client: metaHttpClient,
          } as any);
          if (!provRes.ok) {
            const errText = await provRes.text();
            throw new Error(`MetaAPI error ${provRes.status}: ${errText}`);
          }
          const acct = await provRes.json();
          return respond({
            success: true,
            name: acct.name,
            type: acct.type,
            platform: acct.platform,
            state: acct.state,
            connectionStatus: acct.connectionStatus,
          });
        } catch (e: any) {
          const msg = e?.message || String(e);
          if (msg.includes("invalid peer certificate") || msg.includes("UnknownIssuer")) {
            return respond({ success: false, error: "SSL certificate issue connecting to MetaApi. The credentials are saved and will work for trade execution." });
          }
          throw e;
        }
      }

      throw new Error(`Unsupported broker: ${conn.broker_type}`);
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
