// ============================================================
// Unified Advisor — Single Edge Function with 3 Modes
// Modes: on_demand (user-triggered), daily (cron), weekly (cron)
// Replaces: strategy-advisor, bot-daily-review, bot-weekly-advisor
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { mapNestedToFlat } from "../_shared/configMapper.ts";
import {
  type AdvisorMode,
  type AdvisorContext,
  type TradeRecord,
  type TradeReasoning,
  normalizeTradeRecord,
  runAdvisorPipeline,
  sendTelegramNotification,
} from "../_shared/advisorCore.ts";
import type { ResolvedRejection } from "../_shared/gatePerformanceEngine.ts";

// ─── Mode Configuration ─────────────────────────────────────
const MODE_CONFIG: Record<AdvisorMode, { windowDays: number; notifyCategory: string }> = {
  on_demand: { windowDays: 14, notifyCategory: "strategy_advisor" },
  daily: { windowDays: 3, notifyCategory: "daily_review" },
  weekly: { windowDays: 28, notifyCategory: "weekly_advisor" },
};

// ─── Data Loading ───────────────────────────────────────────
async function loadContext(
  supabase: ReturnType<typeof createClient>,
  mode: AdvisorMode,
  userId: string,
  botId: string,
  botName: string,
  balance: number,
  peakBalance: number,
): Promise<AdvisorContext> {
  const { windowDays } = MODE_CONFIG[mode];
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  // Fetch trades
  const { data: rawTrades } = await supabase
    .from("paper_trade_history")
    .select("*")
    .eq("user_id", userId)
    .eq("bot_id", botId)
    .gte("closed_at", cutoff)
    .order("closed_at", { ascending: false })
    .limit(500);

  const trades: TradeRecord[] = (rawTrades || []).map((r: Record<string, unknown>) => normalizeTradeRecord(r));

  // Fetch reasonings
  const { data: rawReasonings } = await supabase
    .from("trade_reasonings")
    .select("*")
    .eq("user_id", userId)
    .eq("bot_id", botId)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(500);

  const reasonings: TradeReasoning[] = (rawReasonings || []) as TradeReasoning[];

  // Fetch resolved rejections
  const { data: rawRejections } = await supabase
    .from("rejected_setups")
    .select("id, symbol, direction, failed_gates, confluence_score, tier1_count, outcome_status, mfe_pips, mae_pips, tp_hit, sl_hit, regime, session_name, rejected_at, rr_ratio")
    .eq("user_id", userId)
    .in("outcome_status", ["would_have_won", "would_have_lost"])
    .gte("rejected_at", cutoff)
    .limit(300);

  const rejections: ResolvedRejection[] = (rawRejections || []) as ResolvedRejection[];

  // Fetch config
  const { data: configRow } = await supabase
    .from("bot_configs")
    .select("config_json")
    .eq("user_id", userId)
    .eq("bot_id", botId)
    .maybeSingle();

  const configRaw = (configRow?.config_json as Record<string, unknown>) || {};
  const config = mapNestedToFlat(configRaw);

  // Fetch past recommendations (for context)
  const { data: pastRecs } = await supabase
    .from("bot_recommendations")
    .select("id, created_at, status, overall_assessment, recommendations, resolved_at")
    .eq("user_id", userId)
    .eq("bot_id", botId)
    .order("created_at", { ascending: false })
    .limit(10);

  return {
    mode,
    userId,
    botId,
    botName,
    config,
    configRaw,
    trades,
    reasonings,
    rejections,
    pastRecommendations: pastRecs || [],
    balance,
    peakBalance,
    windowDays,
  };
}

// ─── Dedup Check ────────────────────────────────────────────
async function hasPendingRecToday(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  botId: string,
  reviewType: string,
): Promise<boolean> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { data } = await supabase
    .from("bot_recommendations")
    .select("id")
    .eq("user_id", userId)
    .eq("bot_id", botId)
    .eq("review_type", reviewType)
    .eq("status", "pending")
    .gte("created_at", todayStart.toISOString())
    .limit(1);

  return (data?.length ?? 0) > 0;
}

// ─── Persist Result ─────────────────────────────────────────
async function persistRecommendation(
  supabase: ReturnType<typeof createClient>,
  ctx: AdvisorContext,
  result: Awaited<ReturnType<typeof runAdvisorPipeline>>,
): Promise<void> {
  const { error } = await supabase
    .from("bot_recommendations")
    .insert({
      user_id: ctx.userId,
      bot_id: ctx.botId,
      review_type: ctx.mode === "on_demand" ? "on_demand" : ctx.mode,
      performance_summary: {
        metrics: result.performance,
        factorLift: result.factorLift.slice(0, 15),
        symbolStats: result.symbolStats.slice(0, 10),
        regime: result.regime,
        balance: ctx.balance,
        peakBalance: ctx.peakBalance,
        llmTokens: { prompt: result.promptTokens, completion: result.completionTokens },
      },
      diagnosis: result.diagnosis,
      recommendations: result.recommendations,
      feature_gaps: result.feature_gaps,
      status: "pending",
      overall_assessment: result.overall_assessment,
      llm_model: result.llmModel,
    });

  if (error) {
    console.error(`[advisor] Failed to persist recommendation:`, error);
  }
}

// ─── Build Telegram Message ─────────────────────────────────
function buildNotificationMessage(
  botName: string,
  mode: AdvisorMode,
  result: Awaited<ReturnType<typeof runAdvisorPipeline>>,
): string {
  const modeLabel = mode === "daily" ? "📊 Daily Review" : mode === "weekly" ? "📈 Weekly Deep Review" : "🔍 Strategy Analysis";
  let msg = `${modeLabel} — ${botName}\n\n`;
  msg += `${result.overall_assessment}\n\n`;
  msg += `📉 ${result.performance.totalTrades} trades | ${result.performance.winRate.toFixed(0)}% win | $${result.performance.totalPnl.toFixed(2)} P&L\n`;
  msg += `🎯 Regime: ${result.regime.currentRegime.replace(/_/g, " ")} (${(result.regime.regimeConfidence * 100).toFixed(0)}%)\n\n`;

  if (result.recommendations.length > 0) {
    msg += `💡 Top Recommendations:\n`;
    for (const rec of result.recommendations.slice(0, 3)) {
      msg += `• [${rec.confidence}] ${rec.title}\n`;
    }
    msg += `\n_${result.recommendations.length} total recommendations — open dashboard to review._`;
  }

  return msg;
}

// ─── Process Single Bot ─────────────────────────────────────
async function processSingleBot(
  supabase: ReturnType<typeof createClient>,
  mode: AdvisorMode,
  userId: string,
  botId: string,
  botName: string,
  balance: number,
  peakBalance: number,
): Promise<{ success: boolean; error?: string; result?: Awaited<ReturnType<typeof runAdvisorPipeline>> }> {
  try {
    // Dedup check (skip for on_demand — user explicitly requested)
    if (mode !== "on_demand") {
      const hasPending = await hasPendingRecToday(supabase, userId, botId, mode);
      if (hasPending) {
        console.log(`[advisor] Skipping ${botName} — already has pending ${mode} rec today`);
        return { success: true };
      }
    }

    // Load context
    const ctx = await loadContext(supabase, mode, userId, botId, botName, balance, peakBalance);

    // Minimum data check
    if (ctx.trades.length < 3) {
      console.log(`[advisor] Skipping ${botName} — only ${ctx.trades.length} trades in window`);
      return { success: true };
    }

    // Run pipeline
    const result = await runAdvisorPipeline(ctx);

    // Persist
    await persistRecommendation(supabase, ctx, result);

    // Notify (skip for on_demand — user is already looking at the dashboard)
    if (mode !== "on_demand") {
      const { notifyCategory } = MODE_CONFIG[mode];
      const message = buildNotificationMessage(botName, mode, result);
      await sendTelegramNotification(supabase, userId, notifyCategory, message);
    }

    console.log(`[advisor] ${mode} complete for ${botName}: ${result.recommendations.length} recs, ${result.promptTokens}+${result.completionTokens} tokens`);
    return { success: true, result };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[advisor] Error processing ${botName}:`, errMsg);
    return { success: false, error: errMsg };
  }
}

// ─── Main Handler ───────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Parse request
    const body = await req.json().catch(() => ({}));
    const mode: AdvisorMode = body.mode || "on_demand";
    const specificBotId: string | undefined = body.bot_id;
    const specificUserId: string | undefined = body.user_id;

    if (!["on_demand", "daily", "weekly"].includes(mode)) {
      return new Response(
        JSON.stringify({ error: "Invalid mode. Use: on_demand, daily, weekly" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // For on_demand: require bot_id and user_id
    if (mode === "on_demand") {
      if (!specificBotId || !specificUserId) {
        return new Response(
          JSON.stringify({ error: "on_demand mode requires bot_id and user_id" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Fetch the specific account
      const { data: account } = await supabase
        .from("paper_accounts")
        .select("*")
        .eq("user_id", specificUserId)
        .eq("bot_id", specificBotId)
        .maybeSingle();

      if (!account) {
        return new Response(
          JSON.stringify({ error: "Bot account not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const result = await processSingleBot(
        supabase, mode, specificUserId, specificBotId,
        account.bot_name || specificBotId,
        Number(account.balance) || 0,
        Number(account.peak_balance) || 0,
      );

      return new Response(
        JSON.stringify(result),
        { status: result.success ? 200 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // For daily/weekly: process all running bots
    const { data: accounts } = await supabase
      .from("paper_accounts")
      .select("*")
      .eq("is_running", true);

    if (!accounts || accounts.length === 0) {
      return new Response(
        JSON.stringify({ message: "No running bots found", processed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Filter to specific user if provided (useful for testing)
    const targetAccounts = specificUserId
      ? accounts.filter(a => a.user_id === specificUserId)
      : accounts;

    const results: Array<{ botId: string; botName: string; success: boolean; error?: string }> = [];

    for (const account of targetAccounts) {
      const res = await processSingleBot(
        supabase, mode,
        account.user_id,
        account.bot_id,
        account.bot_name || account.bot_id,
        Number(account.balance) || 0,
        Number(account.peak_balance) || 0,
      );
      results.push({
        botId: account.bot_id,
        botName: account.bot_name || account.bot_id,
        success: res.success,
        error: res.error,
      });
    }

    const successCount = results.filter(r => r.success).length;
    return new Response(
      JSON.stringify({
        mode,
        processed: results.length,
        success: successCount,
        failed: results.length - successCount,
        details: results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[advisor] Unhandled error:", errMsg);
    return new Response(
      JSON.stringify({ error: errMsg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
