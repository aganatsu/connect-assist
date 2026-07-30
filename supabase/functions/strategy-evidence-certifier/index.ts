import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import {
  buildStrategyEvidenceCertificate,
  type StrategyEvidenceFeature,
} from "../_shared/strategyEvidenceCertificate.ts";
import {
  buildStrategyEvidenceSource,
  type StrategyEvidenceRejectedRow,
  type StrategyEvidenceTradeRow,
} from "../_shared/strategyEvidenceSource.ts";

const FEATURES: StrategyEvidenceFeature[] = [
  "gameplan_hierarchy",
  "thesis_conviction",
];
const PAGE_SIZE = 1000;
const MAX_ROWS = 5000;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const authHeader = req.headers.get("Authorization");
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return jsonResponse({ error: "Server configuration is incomplete" }, 500);
    }
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.slice("Bearer ".length);
    const { data: claimsData, error: claimsError } = await userClient.auth
      .getClaims(token);
    const userId = claimsData?.claims?.sub;
    if (claimsError || typeof userId !== "string" || !userId) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const botId = typeof body.bot_id === "string" && body.bot_id.trim()
      ? body.bot_id.trim()
      : "smc";
    const requestedDays = Number(body.days ?? 90);
    const days = Number.isFinite(requestedDays)
      ? Math.max(7, Math.min(365, Math.round(requestedDays)))
      : 90;
    const since = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString();
    const admin = createClient(supabaseUrl, serviceRoleKey);

    const rejectedRows: StrategyEvidenceRejectedRow[] = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
      const { data, error } = await admin
        .from("rejected_setups")
        .select(
          "id, bot_id, symbol, direction, rejection_type, session_name, failed_gates, opportunity_key, outcome_status, confluence_score, rr_ratio, shadow_decision, raw_detail, rejected_at",
        )
        .eq("user_id", userId)
        .gte("rejected_at", since)
        .order("rejected_at", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      const scoped = (data || []).filter((row) =>
        !row.bot_id || row.bot_id === botId
      );
      rejectedRows.push(...scoped as StrategyEvidenceRejectedRow[]);
      if (!data || data.length < PAGE_SIZE) break;
    }

    const tradeRows: StrategyEvidenceTradeRow[] = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
      const { data, error } = await admin
        .from("paper_trade_history")
        .select(
          "id, bot_id, position_id, symbol, direction, pnl, size, entry_price, exit_price, stop_loss, signal_score, signal_reason, close_reason, closed_at",
        )
        .eq("user_id", userId)
        .gte("closed_at", since)
        .order("closed_at", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      const scoped = (data || []).filter((row) =>
        !row.bot_id || row.bot_id === botId
      );
      tradeRows.push(...scoped as StrategyEvidenceTradeRow[]);
      if (!data || data.length < PAGE_SIZE) break;
    }

    const source = buildStrategyEvidenceSource(rejectedRows, tradeRows);
    const generatedAt = new Date().toISOString();
    const results: unknown[] = [];

    for (const feature of FEATURES) {
      const certificate = buildStrategyEvidenceCertificate({
        feature,
        observations: source.observations,
        totalCandidates: source.totalCandidates,
        generatedAt,
      });
      const { data, error } = await admin.rpc(
        "publish_strategy_evidence_certificate",
        {
          p_user_id: userId,
          p_bot_id: botId,
          p_feature_key: feature,
          p_variant_key: "default",
          p_activation_scope: {},
          p_certificate: certificate,
        },
      );
      if (error) throw error;
      results.push(data);
    }

    return jsonResponse({
      success: true,
      runtimeEnforced: false,
      botId,
      days,
      source: {
        rejectedRows: rejectedRows.length,
        tradeRows: tradeRows.length,
        totalCandidates: source.totalCandidates,
        observations: source.observations.length,
        window: source.sourceWindow,
      },
      certificates: results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[strategy-evidence-certifier]", message);
    return jsonResponse({ error: message }, 500);
  }
});
