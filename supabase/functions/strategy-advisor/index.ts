// ============================================================
// Strategy Advisor — AI-Powered Actionable Recommendations
// Analyzes rejected setups data and produces specific,
// quantified recommendations to improve profitability.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Types ───────────────────────────────────────────────────
interface RejectedSetup {
  id: string;
  symbol: string;
  direction: string;
  rejection_type: string;
  failed_gates: string[] | null;
  confluence_score: number;
  tier1_count: number;
  tier1_factors: string[] | null;
  entry_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  rr_ratio: number | null;
  session_name: string | null;
  regime: string | null;
  fotsi_base_tsi: number | null;
  fotsi_quote_tsi: number | null;
  outcome_status: string;
  mfe_pips: number | null;
  mae_pips: number | null;
  tp_hit: boolean | null;
  sl_hit: boolean | null;
  price_reached_entry: boolean | null;
  rejected_at: string;
}

interface GateStats {
  gate: string;
  total: number;
  wouldWon: number;
  wouldLost: number;
  winRate: number;
  avgMfe: number;
  avgMae: number;
}

interface SymbolStats {
  symbol: string;
  total: number;
  wouldWon: number;
  wouldLost: number;
  winRate: number;
  avgScore: number;
}

interface SessionStats {
  session: string;
  total: number;
  wouldWon: number;
  wouldLost: number;
  winRate: number;
}

interface ThresholdBucket {
  range: string;
  min: number;
  max: number;
  total: number;
  wouldWon: number;
  wouldLost: number;
  winRate: number;
}

interface AnalysisSummary {
  totalRejected: number;
  totalResolved: number;
  overallWinnerBlockRate: number;
  gateStats: GateStats[];
  symbolStats: SymbolStats[];
  sessionStats: SessionStats[];
  thresholdBuckets: ThresholdBucket[];
  avgRR: number;
  avgMfe: number;
  avgMae: number;
  directionStats: { long: { total: number; won: number }; short: { total: number; won: number } };
}

// ─── Analysis Functions ──────────────────────────────────────
function analyzeSetups(setups: RejectedSetup[]): AnalysisSummary {
  const resolved = setups.filter(s => s.outcome_status === "would_have_won" || s.outcome_status === "would_have_lost");
  const winners = resolved.filter(s => s.outcome_status === "would_have_won");
  const losers = resolved.filter(s => s.outcome_status === "would_have_lost");

  // Gate breakdown
  const gateMap = new Map<string, { total: number; wouldWon: number; wouldLost: number; mfeSum: number; maeSum: number }>();
  for (const s of resolved) {
    if (!s.failed_gates) continue;
    for (const gate of s.failed_gates) {
      const entry = gateMap.get(gate) || { total: 0, wouldWon: 0, wouldLost: 0, mfeSum: 0, maeSum: 0 };
      entry.total++;
      if (s.outcome_status === "would_have_won") entry.wouldWon++;
      else entry.wouldLost++;
      entry.mfeSum += s.mfe_pips || 0;
      entry.maeSum += s.mae_pips || 0;
      gateMap.set(gate, entry);
    }
  }
  const gateStats: GateStats[] = Array.from(gateMap.entries())
    .map(([gate, stats]) => ({
      gate,
      total: stats.total,
      wouldWon: stats.wouldWon,
      wouldLost: stats.wouldLost,
      winRate: stats.total > 0 ? (stats.wouldWon / stats.total) * 100 : 0,
      avgMfe: stats.total > 0 ? stats.mfeSum / stats.total : 0,
      avgMae: stats.total > 0 ? stats.maeSum / stats.total : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // Symbol breakdown
  const symbolMap = new Map<string, { total: number; wouldWon: number; wouldLost: number; scoreSum: number }>();
  for (const s of resolved) {
    const entry = symbolMap.get(s.symbol) || { total: 0, wouldWon: 0, wouldLost: 0, scoreSum: 0 };
    entry.total++;
    entry.scoreSum += s.confluence_score;
    if (s.outcome_status === "would_have_won") entry.wouldWon++;
    else entry.wouldLost++;
    symbolMap.set(s.symbol, entry);
  }
  const symbolStats: SymbolStats[] = Array.from(symbolMap.entries())
    .map(([symbol, stats]) => ({
      symbol,
      total: stats.total,
      wouldWon: stats.wouldWon,
      wouldLost: stats.wouldLost,
      winRate: stats.total > 0 ? (stats.wouldWon / stats.total) * 100 : 0,
      avgScore: stats.total > 0 ? stats.scoreSum / stats.total : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // Session breakdown
  const sessionMap = new Map<string, { total: number; wouldWon: number; wouldLost: number }>();
  for (const s of resolved) {
    const session = s.session_name || "Unknown";
    const entry = sessionMap.get(session) || { total: 0, wouldWon: 0, wouldLost: 0 };
    entry.total++;
    if (s.outcome_status === "would_have_won") entry.wouldWon++;
    else entry.wouldLost++;
    sessionMap.set(session, entry);
  }
  const sessionStats: SessionStats[] = Array.from(sessionMap.entries())
    .map(([session, stats]) => ({
      session,
      total: stats.total,
      wouldWon: stats.wouldWon,
      wouldLost: stats.wouldLost,
      winRate: stats.total > 0 ? (stats.wouldWon / stats.total) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // Threshold buckets
  const buckets = [
    { range: "30-40", min: 30, max: 40 },
    { range: "40-50", min: 40, max: 50 },
    { range: "50-55", min: 50, max: 55 },
    { range: "55-60", min: 55, max: 60 },
    { range: "60-70", min: 60, max: 70 },
    { range: "70-80", min: 70, max: 80 },
    { range: "80+", min: 80, max: 200 },
  ];
  const thresholdBuckets: ThresholdBucket[] = buckets.map(b => {
    const inBucket = resolved.filter(s => s.confluence_score >= b.min && s.confluence_score < b.max);
    const won = inBucket.filter(s => s.outcome_status === "would_have_won").length;
    return { ...b, total: inBucket.length, wouldWon: won, wouldLost: inBucket.length - won, winRate: inBucket.length > 0 ? (won / inBucket.length) * 100 : 0 };
  });

  // Direction breakdown
  const longResolved = resolved.filter(s => s.direction === "long");
  const shortResolved = resolved.filter(s => s.direction === "short");
  const directionStats = {
    long: { total: longResolved.length, won: longResolved.filter(s => s.outcome_status === "would_have_won").length },
    short: { total: shortResolved.length, won: shortResolved.filter(s => s.outcome_status === "would_have_won").length },
  };

  // Averages
  const avgRR = resolved.length > 0 ? resolved.reduce((sum, s) => sum + (s.rr_ratio || 0), 0) / resolved.length : 0;
  const avgMfe = resolved.length > 0 ? resolved.reduce((sum, s) => sum + (s.mfe_pips || 0), 0) / resolved.length : 0;
  const avgMae = resolved.length > 0 ? resolved.reduce((sum, s) => sum + (s.mae_pips || 0), 0) / resolved.length : 0;

  return {
    totalRejected: setups.length,
    totalResolved: resolved.length,
    overallWinnerBlockRate: resolved.length > 0 ? (winners.length / resolved.length) * 100 : 0,
    gateStats,
    symbolStats,
    sessionStats,
    thresholdBuckets,
    avgRR,
    avgMfe,
    avgMae,
    directionStats,
  };
}

// ─── LLM Call ────────────────────────────────────────────────
async function callLLM(systemPrompt: string, userPrompt: string): Promise<any | null> {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const forgeApiUrl = Deno.env.get("FORGE_API_URL") || Deno.env.get("BUILT_IN_FORGE_API_URL");
  const forgeApiKey = Deno.env.get("FORGE_API_KEY") || Deno.env.get("BUILT_IN_FORGE_API_KEY");
  const useLovable = !!lovableKey;
  const url = useLovable
    ? "https://ai.gateway.lovable.dev/v1/chat/completions"
    : forgeApiUrl
      ? `${forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions`
      : "";
  const apiKey = useLovable ? lovableKey : forgeApiKey;
  const model = useLovable ? "google/gemini-2.5-flash" : "gemini-2.5-flash";

  if (!url || !apiKey) {
    console.error("LLM API credentials not configured.");
    return null;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`LLM API error: ${response.status} — ${errText}`);
      return null;
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (!content) return null;

    let jsonStr = content.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error("LLM call failed:", err);
    return null;
  }
}

// ─── Prompt ──────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a senior ICT/SMC trading strategist analyzing a bot's rejected trade setups.
Your job is to produce SPECIFIC, ACTIONABLE recommendations that will improve profitability.

You are given statistical analysis of trades that were BLOCKED by the bot's safety gates or threshold filters.
For each blocked trade, we know whether it WOULD HAVE WON or WOULD HAVE LOST if taken.

Your recommendations must be:
1. SPECIFIC — name the exact gate, threshold, symbol, or session to change
2. QUANTIFIED — estimate the $ or pip impact based on the data
3. PRIORITIZED — highest impact first
4. RISK-AWARE — flag if a recommendation could increase drawdown

Output JSON with this exact structure:
{
  "overall_assessment": "One paragraph summary of the situation — is the bot over-filtering, under-filtering, or well-calibrated?",
  "profitability_score": <1-10 rating of current gate configuration>,
  "recommendations": [
    {
      "id": 1,
      "priority": "critical" | "high" | "medium" | "low",
      "action": "The specific action to take (e.g., 'Disable P/D Zone gate for ETH/USD', 'Lower threshold from 55 to 48')",
      "reasoning": "Why this will help, based on the data",
      "expected_impact": "Quantified impact (e.g., '+12 winning trades/week', '+$450/week estimated')",
      "risk_warning": "What could go wrong if this change is made",
      "confidence": "high" | "medium" | "low"
    }
  ],
  "gates_verdict": {
    "working_well": ["Gate names that are correctly blocking losers"],
    "over_filtering": ["Gate names that are blocking too many winners"],
    "under_filtering": ["Gate names that should be stricter"]
  },
  "threshold_recommendation": {
    "current_effective": <the threshold most setups are being blocked at>,
    "suggested": <your recommended threshold>,
    "reasoning": "Why this threshold is better"
  },
  "symbol_specific": [
    {
      "symbol": "PAIR/NAME",
      "issue": "What's wrong for this specific pair",
      "fix": "What to change"
    }
  ],
  "data_quality_warning": "Any caveats about sample size, time period, or data reliability"
}`;

function buildUserPrompt(analysis: AnalysisSummary, days: number): string {
  return `Here is the rejected setups analysis for the past ${days} days:

## Overall Stats
- Total rejected: ${analysis.totalRejected}
- Total resolved (outcome known): ${analysis.totalResolved}
- Winner block rate: ${analysis.overallWinnerBlockRate.toFixed(1)}% (${analysis.overallWinnerBlockRate > 50 ? "PROBLEM: blocking more winners than losers" : "OK: blocking more losers"})
- Average RR of blocked trades: ${analysis.avgRR.toFixed(1)}
- Average MFE (raw pips): ${analysis.avgMfe.toFixed(1)}
- Average MAE (raw pips): ${analysis.avgMae.toFixed(1)}

## Direction Breakdown
- Long: ${analysis.directionStats.long.total} blocked, ${analysis.directionStats.long.won} would have won (${analysis.directionStats.long.total > 0 ? ((analysis.directionStats.long.won / analysis.directionStats.long.total) * 100).toFixed(0) : 0}%)
- Short: ${analysis.directionStats.short.total} blocked, ${analysis.directionStats.short.won} would have won (${analysis.directionStats.short.total > 0 ? ((analysis.directionStats.short.won / analysis.directionStats.short.total) * 100).toFixed(0) : 0}%)

## Gate Breakdown (which gates blocked what)
${analysis.gateStats.map(g => `- "${g.gate}": blocked ${g.total} trades, ${g.wouldWon} would have won (${g.winRate.toFixed(0)}% winner block rate), avg MFE: ${g.avgMfe.toFixed(1)}, avg MAE: ${g.avgMae.toFixed(1)}`).join("\n")}

## Symbol Breakdown
${analysis.symbolStats.map(s => `- ${s.symbol}: ${s.total} blocked, ${s.wouldWon} would have won (${s.winRate.toFixed(0)}%), avg score: ${s.avgScore.toFixed(1)}`).join("\n")}

## Session Breakdown
${analysis.sessionStats.map(s => `- ${s.session}: ${s.total} blocked, ${s.wouldWon} would have won (${s.winRate.toFixed(0)}%)`).join("\n")}

## Confluence Score Buckets (would the trade have won at different thresholds?)
${analysis.thresholdBuckets.filter(b => b.total > 0).map(b => `- Score ${b.range}: ${b.total} trades, ${b.wouldWon} won (${b.winRate.toFixed(0)}%)`).join("\n")}

Based on this data, provide your specific recommendations to improve profitability.
Remember: a high winner-block-rate means the gates are HURTING profitability by blocking good trades.
A low winner-block-rate means the gates are HELPING by correctly filtering out losers.`;
}

// ─── Main Handler ────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const days = body.days || 7;

    // Fetch rejected setups
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data: setups, error: fetchError } = await supabase
      .from("rejected_setups")
      .select("*")
      .eq("user_id", user.id)
      .gte("rejected_at", since)
      .order("rejected_at", { ascending: false })
      .limit(500);

    if (fetchError) {
      return new Response(JSON.stringify({ error: fetchError.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!setups || setups.length === 0) {
      return new Response(JSON.stringify({
        recommendations: [],
        overall_assessment: "No rejected setups found in the selected time period. The bot needs to run for a few days to collect enough data for analysis.",
        profitability_score: 5,
        data_quality_warning: "Insufficient data — need at least 20+ resolved setups for meaningful analysis.",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Analyze
    const analysis = analyzeSetups(setups as RejectedSetup[]);

    // If too few resolved, return a warning
    if (analysis.totalResolved < 5) {
      return new Response(JSON.stringify({
        recommendations: [],
        overall_assessment: `Only ${analysis.totalResolved} setups have resolved outcomes. Need at least 5+ for meaningful recommendations. Wait for the outcome tracker to process pending setups.`,
        profitability_score: 5,
        analysis_summary: analysis,
        data_quality_warning: "Insufficient resolved data — most setups are still pending or inconclusive.",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Call LLM
    const userPrompt = buildUserPrompt(analysis, days);
    const llmResult = await callLLM(SYSTEM_PROMPT, userPrompt);

    if (!llmResult) {
      // Fallback: return raw analysis without LLM recommendations
      return new Response(JSON.stringify({
        recommendations: generateFallbackRecommendations(analysis),
        overall_assessment: `Winner block rate is ${analysis.overallWinnerBlockRate.toFixed(0)}%. ${analysis.overallWinnerBlockRate > 60 ? "Your gates are blocking too many profitable trades — consider relaxing filters." : analysis.overallWinnerBlockRate > 40 ? "Gates are borderline — some tuning may help." : "Gates are working well — they're correctly filtering losers."}`,
        profitability_score: analysis.overallWinnerBlockRate > 60 ? 3 : analysis.overallWinnerBlockRate > 40 ? 5 : 7,
        analysis_summary: analysis,
        data_quality_warning: "LLM analysis unavailable — showing rule-based recommendations.",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({
      ...llmResult,
      analysis_summary: analysis,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("Strategy advisor error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

// ─── Fallback Recommendations (no LLM) ──────────────────────
function generateFallbackRecommendations(analysis: AnalysisSummary) {
  const recs: any[] = [];

  // Check for over-filtering gates
  for (const gate of analysis.gateStats) {
    if (gate.total >= 3 && gate.winRate > 60) {
      recs.push({
        id: recs.length + 1,
        priority: gate.winRate > 80 ? "critical" : "high",
        action: `Review or disable gate: "${gate.gate}"`,
        reasoning: `This gate blocked ${gate.total} trades, ${gate.winRate.toFixed(0)}% of which would have won. It's destroying profitability.`,
        expected_impact: `+${gate.wouldWon} winning trades recovered`,
        risk_warning: `${gate.wouldLost} losing trades would also be taken. Net depends on RR.`,
        confidence: gate.total >= 10 ? "high" : "medium",
      });
    }
  }

  // Check threshold
  const highScoreBuckets = analysis.thresholdBuckets.filter(b => b.min >= 50 && b.total >= 3 && b.winRate > 55);
  if (highScoreBuckets.length > 0) {
    const lowestGood = highScoreBuckets.reduce((min, b) => b.min < min.min ? b : min, highScoreBuckets[0]);
    recs.push({
      id: recs.length + 1,
      priority: "high",
      action: `Consider lowering confluence threshold to ${lowestGood.min}`,
      reasoning: `Trades with scores ${lowestGood.range} have a ${lowestGood.winRate.toFixed(0)}% win rate — they're being blocked unnecessarily.`,
      expected_impact: `+${lowestGood.wouldWon} winning trades at this score range`,
      risk_warning: `${lowestGood.wouldLost} additional losers would also be taken.`,
      confidence: lowestGood.total >= 10 ? "high" : "medium",
    });
  }

  // Symbol-specific issues
  for (const sym of analysis.symbolStats) {
    if (sym.total >= 5 && sym.winRate > 70) {
      recs.push({
        id: recs.length + 1,
        priority: "medium",
        action: `Relax gate filters specifically for ${sym.symbol}`,
        reasoning: `${sym.symbol} has ${sym.winRate.toFixed(0)}% winner block rate — the gates are too strict for this pair.`,
        expected_impact: `+${sym.wouldWon} winning trades on ${sym.symbol}`,
        risk_warning: `Pair-specific overrides add complexity to the system.`,
        confidence: sym.total >= 10 ? "high" : "medium",
      });
    }
  }

  return recs;
}
