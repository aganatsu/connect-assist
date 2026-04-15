import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

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
      const limit = payload.limit || 50;
      const offset = payload.offset || 0;
      const { data, error } = await supabase.from("trades")
        .select("*").eq("user_id", user.id)
        .order("entry_time", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return respond(data);
    }

    if (action === "get") {
      const { data, error } = await supabase.from("trades").select("*").eq("id", payload.id).eq("user_id", user.id).maybeSingle();
      if (error) throw error;
      return respond(data);
    }

    if (action === "create") {
      const { data, error } = await supabase.from("trades").insert({ ...payload.trade, user_id: user.id }).select().single();
      if (error) throw error;
      return respond(data);
    }

    if (action === "update") {
      const { id, ...updates } = payload.trade;
      const { data, error } = await supabase.from("trades").update(updates).eq("id", id).eq("user_id", user.id).select().single();
      if (error) throw error;
      return respond(data);
    }

    if (action === "delete") {
      const { error } = await supabase.from("trades").delete().eq("id", payload.id).eq("user_id", user.id);
      if (error) throw error;
      return respond({ success: true });
    }

    if (action === "stats") {
      const { data, error } = await supabase.from("trades").select("*").eq("user_id", user.id).eq("status", "closed");
      if (error) throw error;
      const trades = data || [];
      const wins = trades.filter(t => parseFloat(t.pnl_amount || "0") > 0);
      const losses = trades.filter(t => parseFloat(t.pnl_amount || "0") <= 0);
      const totalPnl = trades.reduce((s, t) => s + parseFloat(t.pnl_amount || "0"), 0);
      const grossProfit = wins.reduce((s, t) => s + parseFloat(t.pnl_amount || "0"), 0);
      const grossLoss = Math.abs(losses.reduce((s, t) => s + parseFloat(t.pnl_amount || "0"), 0));
      return respond({
        totalTrades: trades.length, wins: wins.length, losses: losses.length,
        winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
        totalPnl, grossProfit, grossLoss,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
        avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
        avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
      });
    }

    if (action === "equity_curve") {
      const { data, error } = await supabase.from("trades").select("id, exit_time, pnl_amount, symbol")
        .eq("user_id", user.id).eq("status", "closed")
        .order("exit_time", { ascending: true });
      if (error) throw error;
      let cumulative = 0;
      const curve = (data || []).map(t => {
        cumulative += parseFloat(t.pnl_amount || "0");
        return { id: t.id, date: t.exit_time, pnl: parseFloat(t.pnl_amount || "0"), cumulative, symbol: t.symbol };
      });
      return respond(curve);
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
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
