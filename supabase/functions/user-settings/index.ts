import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) throw new Error("Missing authorization");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    // Use getClaims() for local JWT verification — prevents 150s hang on expired tokens
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: authError } = await supabase.auth.getClaims(token);
    if (authError || !claimsData?.claims?.sub) throw new Error("Unauthorized");
    const user = { id: claimsData.claims.sub as string };

    const { action, ...payload } = await req.json();

    if (action === "get") {
      const { data, error } = await supabase.from("user_settings").select("*").eq("user_id", user.id).maybeSingle();
      if (error) throw error;
      return respond(data || { risk_settings_json: null, preferences_json: null });
    }

    if (action === "upsert") {
      const { data: existing } = await supabase.from("user_settings").select("id").eq("user_id", user.id).maybeSingle();
      if (existing) {
        const { error } = await supabase.from("user_settings").update({
          risk_settings_json: payload.risk_settings,
          preferences_json: payload.preferences,
        }).eq("user_id", user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("user_settings").insert({
          user_id: user.id,
          risk_settings_json: payload.risk_settings,
          preferences_json: payload.preferences,
        });
        if (error) throw error;
      }
      return respond({ success: true });
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
