import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

// ─── Instrument Specs ───────────────────────────────────────────────
const SPECS: Record<string, { pipSize: number; lotUnits: number; marginPerLot: number }> = {
  "EUR/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  "GBP/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  "USD/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 1000 },
  "GBP/JPY": { pipSize: 0.01, lotUnits: 100000, marginPerLot: 1500 },
  "AUD/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 800 },
  "USD/CAD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1000 },
  "EUR/GBP": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 1200 },
  "NZD/USD": { pipSize: 0.0001, lotUnits: 100000, marginPerLot: 700 },
  "BTC/USD": { pipSize: 1, lotUnits: 1, marginPerLot: 5000 },
  "ETH/USD": { pipSize: 0.01, lotUnits: 1, marginPerLot: 1000 },
  "XAU/USD": { pipSize: 0.01, lotUnits: 100, marginPerLot: 2000 },
  "XAG/USD": { pipSize: 0.001, lotUnits: 5000, marginPerLot: 1500 },
};

function calcPnl(dir: string, entry: number, current: number, size: number, symbol: string) {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  const diff = dir === "long" ? current - entry : entry - current;
  return { pnl: diff * spec.lotUnits * size, pnlPips: diff / spec.pipSize };
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

    const { action, ...payload } = await req.json();

    // ── Get account state ──
    if (action === "status") {
      const { data: account } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).maybeSingle();
      const { data: positions } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "open");
      const { data: pending } = await supabase.from("paper_positions").select("*").eq("user_id", user.id).eq("position_status", "pending");
      const { data: history } = await supabase.from("paper_trade_history").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50);

      const balance = parseFloat(account?.balance || "10000");
      const posArr = (positions || []).map((p: any) => ({
        id: p.position_id, symbol: p.symbol, direction: p.direction,
        size: parseFloat(p.size), entryPrice: parseFloat(p.entry_price),
        currentPrice: parseFloat(p.current_price),
        pnl: calcPnl(p.direction, parseFloat(p.entry_price), parseFloat(p.current_price), parseFloat(p.size), p.symbol).pnl,
        stopLoss: p.stop_loss ? parseFloat(p.stop_loss) : null,
        takeProfit: p.take_profit ? parseFloat(p.take_profit) : null,
        openTime: p.open_time, signalReason: p.signal_reason || "",
        signalScore: parseFloat(p.signal_score || "0"), orderId: p.order_id,
      }));
      const unrealizedPnl = posArr.reduce((s: number, p: any) => s + p.pnl, 0);
      const histArr = (history || []).map((t: any) => ({
        id: t.position_id, symbol: t.symbol, direction: t.direction,
        size: parseFloat(t.size), entryPrice: parseFloat(t.entry_price),
        exitPrice: parseFloat(t.exit_price), pnl: parseFloat(t.pnl),
        pnlPips: parseFloat(t.pnl_pips), openTime: t.open_time,
        closedAt: t.closed_at, closeReason: t.close_reason,
        signalReason: t.signal_reason || "", signalScore: parseFloat(t.signal_score || "0"),
        orderId: t.order_id,
      }));
      const wins = histArr.filter((t: any) => t.pnl > 0).length;
      const losses = histArr.filter((t: any) => t.pnl <= 0).length;

      return respond({
        balance, equity: balance + unrealizedPnl, unrealizedPnl,
        positions: posArr, pendingOrders: pending || [],
        tradeHistory: histArr, isRunning: account?.is_running || false,
        isPaused: account?.is_paused || false,
        startedAt: account?.started_at, totalTrades: histArr.length,
        winRate: histArr.length > 0 ? (wins / histArr.length) * 100 : 0,
        wins, losses, scanCount: account?.scan_count || 0,
        signalCount: account?.signal_count || 0,
        rejectedCount: account?.rejected_count || 0,
        executionMode: account?.execution_mode || "paper",
        killSwitchActive: account?.kill_switch_active || false,
        dailyPnl: 0, drawdown: 0, marginUsed: 0, freeMargin: balance + unrealizedPnl,
        marginLevel: 0, uptime: 0, strategy: { name: "SMC Default", winRate: histArr.length > 0 ? (wins / histArr.length) * 100 : 0, avgRR: 0, profitFactor: 0, expectancy: 0, maxDrawdown: 0 },
        log: [],
      });
    }

    // ── Place order ──
    if (action === "place_order") {
      const { symbol, direction, size, stopLoss, takeProfit, signalReason, signalScore } = payload;
      // Ensure account exists
      const { data: account } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).maybeSingle();
      if (!account) {
        await supabase.from("paper_accounts").insert({ user_id: user.id, balance: "10000", peak_balance: "10000", daily_pnl_base: "10000" });
      }
      // Get current price via market data
      const positionId = crypto.randomUUID().slice(0, 8);
      const orderId = crypto.randomUUID().slice(0, 8);
      const now = new Date().toISOString();
      // Use payload entry price or 0
      const entryPrice = payload.entryPrice || 0;

      await supabase.from("paper_positions").insert({
        user_id: user.id, position_id: positionId, symbol, direction, size: size.toString(),
        entry_price: entryPrice.toString(), current_price: entryPrice.toString(),
        stop_loss: stopLoss?.toString() || null, take_profit: takeProfit?.toString() || null,
        open_time: now, signal_reason: signalReason || "", signal_score: (signalScore || 0).toString(),
        order_id: orderId, position_status: "open",
      });

      return respond({ success: true, positionId, orderId });
    }

    // ── Close position ──
    if (action === "close_position") {
      const { positionId, exitPrice } = payload;
      const { data: pos } = await supabase.from("paper_positions").select("*")
        .eq("user_id", user.id).eq("position_id", positionId).single();
      if (!pos) throw new Error("Position not found");

      const ep = exitPrice || parseFloat(pos.current_price);
      const { pnl, pnlPips } = calcPnl(pos.direction, parseFloat(pos.entry_price), ep, parseFloat(pos.size), pos.symbol);

      // Record in history
      await supabase.from("paper_trade_history").insert({
        user_id: user.id, position_id: pos.position_id, symbol: pos.symbol,
        direction: pos.direction, size: pos.size, entry_price: pos.entry_price,
        exit_price: ep.toString(), pnl: pnl.toString(), pnl_pips: pnlPips.toString(),
        open_time: pos.open_time, closed_at: new Date().toISOString(),
        close_reason: payload.reason || "manual", signal_reason: pos.signal_reason || "",
        signal_score: pos.signal_score, order_id: pos.order_id,
      });

      // Update balance
      const { data: account } = await supabase.from("paper_accounts").select("*").eq("user_id", user.id).single();
      const newBalance = parseFloat(account.balance) + pnl;
      const newPeak = Math.max(parseFloat(account.peak_balance), newBalance);
      await supabase.from("paper_accounts").update({ balance: newBalance.toString(), peak_balance: newPeak.toString() }).eq("user_id", user.id);

      // Remove position
      await supabase.from("paper_positions").delete().eq("id", pos.id);

      return respond({ success: true, pnl, pnlPips });
    }

    // ── Engine controls ──
    if (action === "start_engine") {
      await ensureAccount(supabase, user.id);
      await supabase.from("paper_accounts").update({ is_running: true, started_at: new Date().toISOString() }).eq("user_id", user.id);
      return respond({ success: true });
    }
    if (action === "pause_engine") {
      await supabase.from("paper_accounts").update({ is_paused: true }).eq("user_id", user.id);
      return respond({ success: true });
    }
    if (action === "stop_engine") {
      await supabase.from("paper_accounts").update({ is_running: false, is_paused: false }).eq("user_id", user.id);
      return respond({ success: true });
    }
    if (action === "kill_switch") {
      await supabase.from("paper_accounts").update({ kill_switch_active: payload.active }).eq("user_id", user.id);
      if (payload.active) {
        // Close all positions
        const { data: positions } = await supabase.from("paper_positions").select("*").eq("user_id", user.id);
        // Would need to close each — simplified here
        await supabase.from("paper_accounts").update({ is_running: false, is_paused: false }).eq("user_id", user.id);
      }
      return respond({ success: true });
    }
    if (action === "reset_account") {
      await supabase.from("paper_positions").delete().eq("user_id", user.id);
      await supabase.from("paper_trade_history").delete().eq("user_id", user.id);
      await supabase.from("paper_accounts").update({
        balance: "10000", peak_balance: "10000", is_running: false, is_paused: false,
        scan_count: 0, signal_count: 0, rejected_count: 0, daily_pnl_base: "10000",
        kill_switch_active: false, execution_mode: "paper",
      }).eq("user_id", user.id);
      return respond({ success: true });
    }
    if (action === "set_execution_mode") {
      await supabase.from("paper_accounts").update({ execution_mode: payload.mode }).eq("user_id", user.id);
      return respond({ success: true });
    }

    return respond({ error: "Unknown action" });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function ensureAccount(supabase: any, userId: string) {
  const { data } = await supabase.from("paper_accounts").select("id").eq("user_id", userId).maybeSingle();
  if (!data) {
    await supabase.from("paper_accounts").insert({ user_id: userId, balance: "10000", peak_balance: "10000", daily_pnl_base: "10000" });
  }
}

function respond(data: any) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
