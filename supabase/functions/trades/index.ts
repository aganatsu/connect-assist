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

    if (action === "reviews") {
      const limit = Math.min(500, Math.max(1, Number(payload.limit) || 250));
      const { data: history, error: historyError } = await supabase
        .from("paper_trade_history").select("*").eq("user_id", user.id)
        .order("closed_at", { ascending: false }).limit(limit);
      if (historyError) throw historyError;
      const positionIds = (history || []).map((row: any) => row.position_id);
      const [mortemsResult, notesResult] = await Promise.all([
        positionIds.length
          ? supabase.from("trade_post_mortems").select("*")
            .eq("user_id", user.id).in("position_id", positionIds)
          : Promise.resolve({ data: [], error: null }),
        positionIds.length
          ? supabase.from("trade_review_notes").select("*")
            .eq("user_id", user.id).in("position_id", positionIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (mortemsResult.error) throw mortemsResult.error;
      if (notesResult.error) throw notesResult.error;
      const mortems = new Map((mortemsResult.data || []).map((row: any) => [row.position_id, row]));
      const notes = new Map((notesResult.data || []).map((row: any) => [row.position_id, row]));
      return respond((history || []).map((row: any) => {
        let reasoning: any = {};
        try {
          reasoning = typeof row.signal_reason === "string"
            ? JSON.parse(row.signal_reason) : (row.signal_reason || {});
        } catch { reasoning = { raw: row.signal_reason }; }
        const mortem: any = mortems.get(row.position_id) || null;
        const review: any = notes.get(row.position_id) || null;
        return {
          id: row.id, position_id: row.position_id, symbol: row.symbol,
          direction: row.direction, size: Number(row.size),
          entry_price: Number(row.entry_price), exit_price: Number(row.exit_price),
          entry_time: row.open_time, exit_time: row.closed_at, status: "closed",
          pnl_amount: Number(row.pnl), pnl_pips: Number(row.pnl_pips),
          stop_loss: row.stop_loss == null ? null : Number(row.stop_loss),
          take_profit: row.take_profit == null ? null : Number(row.take_profit),
          close_reason: row.close_reason, order_id: row.order_id,
          bot_id: row.bot_id || "smc", signal_score: Number(row.signal_score || 0),
          reasoning_json: { ...reasoning, paper_position_id: row.position_id },
          post_mortem_json: mortem?.detail_json || (mortem ? {
            whatWorked: mortem.what_worked, whatFailed: mortem.what_failed,
            lessonLearned: mortem.lesson_learned,
          } : null),
          review_status: review?.review_status || "pending",
          review_notes: review?.notes || "",
          review_lesson: review?.lesson || "",
          review_tags: review?.tags || [],
          reviewed_at: review?.reviewed_at || null,
        };
      }));
    }

    if (action === "save_review") {
      if (!payload.positionId) throw new Error("positionId is required");
      const reviewed = payload.reviewStatus === "reviewed";
      const { data, error } = await supabase.from("trade_review_notes").upsert({
        user_id: user.id,
        position_id: payload.positionId,
        review_status: reviewed ? "reviewed" : "pending",
        notes: payload.notes || null,
        lesson: payload.lesson || null,
        tags: Array.isArray(payload.tags) ? payload.tags : [],
        reviewed_at: reviewed ? new Date().toISOString() : null,
      }, { onConflict: "user_id,position_id" }).select().single();
      if (error) throw error;
      return respond(data);
    }

    if (action === "list") {
      const page = Math.max(1, payload.page || 1);
      const pageSize = Math.min(100, Math.max(1, payload.pageSize || payload.limit || 50));
      const offset = (page - 1) * pageSize;

      // M8: Get total count for pagination
      const { count, error: countErr } = await supabase.from("trades")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id);
      if (countErr) throw countErr;

      // Optional symbol filter
      let query = supabase.from("trades")
        .select("*").eq("user_id", user.id);
      if (payload.symbol) {
        query = query.eq("symbol", payload.symbol);
      }
      const { data, error } = await query
        .order("entry_time", { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      return respond({ data: data || [], total: count || 0, page, pageSize });
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

    if (action === "import_from_paper") {
      // Get all paper_trade_history for this user
      const { data: paperTrades, error: ptErr } = await supabase
        .from("paper_trade_history")
        .select("*")
        .eq("user_id", user.id);
      if (ptErr) throw ptErr;
      if (!paperTrades || paperTrades.length === 0) return respond({ imported: 0 });

      // Get existing trades to find already-imported position_ids (stored in notes or reasoning_json)
      const { data: existingTrades, error: etErr } = await supabase
        .from("trades")
        .select("reasoning_json")
        .eq("user_id", user.id);
      if (etErr) throw etErr;

      const existingPositionIds = new Set(
        (existingTrades || [])
          .map((t: any) => t.reasoning_json?.paper_position_id)
          .filter(Boolean)
      );

      const toInsert = paperTrades
        .filter((pt: any) => !existingPositionIds.has(pt.position_id))
        .map((pt: any) => ({
          user_id: user.id,
          symbol: pt.symbol,
          direction: pt.direction,
          entry_price: pt.entry_price,
          exit_price: pt.exit_price,
          entry_time: pt.open_time ? new Date(pt.open_time).toISOString() : new Date().toISOString(),
          exit_time: pt.closed_at ? new Date(pt.closed_at).toISOString() : null,
          status: "closed",
          pnl_amount: pt.pnl,
          pnl_pips: pt.pnl_pips,
          setup_type: "Bot Signal",
          notes: `Auto-imported from bot. Reason: ${pt.signal_reason || "N/A"}. Close: ${pt.close_reason}`,
          reasoning_json: {
            paper_position_id: pt.position_id,
            signal_score: pt.signal_score,
            signal_reason: pt.signal_reason,
            close_reason: pt.close_reason,
            order_id: pt.order_id,
          },
        }));

      if (toInsert.length === 0) return respond({ imported: 0 });

      const { error: insertErr } = await supabase.from("trades").insert(toInsert);
      if (insertErr) throw insertErr;

      return respond({ imported: toInsert.length });
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
