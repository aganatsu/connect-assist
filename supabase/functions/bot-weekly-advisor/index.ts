// ============================================================
// Bot Weekly Strategy Advisor — Deep Self-Learning Review
// Runs every Sunday at 23:00 UTC via pg_cron
// Performs deeper analysis: factor weight optimization,
// week-over-week trends, regime detection, feature gap analysis
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Types ───────────────────────────────────────────────────

interface TradeRecord {
  id: string;
  user_id: string;
  symbol: string;
  direction: string;
  entry_price: number;
  exit_price: number;
  sl: number;
  tp: number;
  pnl: number;
  pnl_percent: number;
  close_reason: string;
  opened_at: string;
  closed_at: string;
  lot_size: number;
  bot_id?: string;
  signal_reason?: any;
}

// ─── Number coercion helpers ────────────────────────────────
function toSafeNumber(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeTradeRecord(raw: any): TradeRecord {
  return {
    id: raw.id,
    user_id: raw.user_id,
    symbol: raw.symbol,
    direction: raw.direction,
    entry_price: toSafeNumber(raw.entry_price),
    exit_price: toSafeNumber(raw.exit_price),
    sl: toSafeNumber(raw.sl ?? raw.stop_loss),
    tp: toSafeNumber(raw.tp ?? raw.take_profit),
    pnl: toSafeNumber(raw.pnl ?? raw.pnl_amount),
    pnl_percent: toSafeNumber(raw.pnl_percent ?? raw.pnl_pips),
    close_reason: raw.close_reason ?? "",
    opened_at: raw.opened_at ?? raw.open_time ?? raw.created_at ?? "",
    closed_at: raw.closed_at ?? "",
    lot_size: toSafeNumber(raw.lot_size ?? raw.size),
    bot_id: raw.bot_id,
    signal_reason: raw.signal_reason,
  };
}

interface TradeReasoning {
  id: string;
  user_id: string;
  symbol: string;
  direction: string;
  confluence_score: number;
  summary: string;
  factors_json: Array<{
    name: string;
    present: boolean;
    weight: number;
    detail: string;
    group?: string;
  }>;
  session?: string;
  timeframe?: string;
  created_at: string;
  bot_id?: string;
}

interface WeeklyMetrics {
  weekLabel: string;
  startDate: string;
  endDate: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxConsecutiveLosses: number;
  avgRRAchieved: number;
  maxDrawdownPercent: number;
}

interface FactorWeightSuggestion {
  factorName: string;
  group: string;
  currentWeight: number;
  suggestedWeight: number;
  reason: string;
  winRateWhenPresent: number;
  winRateWhenAbsent: number;
  sampleSize: number;
  confidence: string;
}

interface RegimeAnalysis {
  currentRegime: string;
  regimeConfidence: number;
  regimeIndicators: string[];
  regimeImpact: string;
}

interface PreviousRecommendation {
  id: string;
  created_at: string;
  status: string;
  overall_assessment: string;
  recommendations: any[];
  resolved_at?: string;
}

interface WeeklyDiagnosis {
  overall_assessment: string;
  weekly_trend: string;
  diagnosis: string;
  key_findings: Array<{
    finding: string;
    evidence: string;
    severity: string;
  }>;
  factor_weight_suggestions: FactorWeightSuggestion[];
  regime_analysis: RegimeAnalysis;
  recommendations: Array<{
    category: string;
    title: string;
    description: string;
    current_value: Record<string, unknown>;
    suggested_value: Record<string, unknown>;
    confidence: string;
    evidence: string;
    risk_level: string;
  }>;
  feature_gaps: string[];
  past_recommendation_review: string;
}

// ─── Helpers ─────────────────────────────────────────────────

function computeWeeklyMetrics(trades: TradeRecord[], weekLabel: string, startDate: string, endDate: string): WeeklyMetrics {
  if (trades.length === 0) {
    return {
      weekLabel, startDate, endDate,
      totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      totalPnl: 0, avgWin: 0, avgLoss: 0, profitFactor: 0,
      maxConsecutiveLosses: 0, avgRRAchieved: 0, maxDrawdownPercent: 0,
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // Max consecutive losses
  let maxConsec = 0, currentConsec = 0;
  const sorted = [...trades].sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime());
  for (const t of sorted) {
    if (t.pnl <= 0) { currentConsec++; maxConsec = Math.max(maxConsec, currentConsec); }
    else { currentConsec = 0; }
  }

  // Average RR for winners
  const rrValues = wins.map(t => {
    const risk = Math.abs(t.entry_price - t.sl);
    return risk > 0 ? Math.abs(t.exit_price - t.entry_price) / risk : 0;
  });
  const avgRR = rrValues.length > 0 ? rrValues.reduce((s, v) => s + v, 0) / rrValues.length : 0;

  // Max drawdown within the week (equity curve)
  let peak = 0, maxDD = 0, cumPnl = 0;
  for (const t of sorted) {
    cumPnl += t.pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak > 0 ? (peak - cumPnl) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    weekLabel, startDate, endDate,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / trades.length) * 100,
    totalPnl: trades.reduce((s, t) => s + t.pnl, 0),
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxConsecutiveLosses: maxConsec,
    avgRRAchieved: avgRR,
    maxDrawdownPercent: maxDD,
  };
}

function computeFactorWeightSuggestions(
  trades: TradeRecord[],
  reasonings: TradeReasoning[]
): FactorWeightSuggestion[] {
  // Match trades to reasonings
  const tradeFactors = new Map<string, TradeReasoning>();
  for (const trade of trades) {
    let bestMatch: TradeReasoning | null = null;
    let bestTimeDiff = Infinity;
    for (const r of reasonings) {
      if (r.symbol === trade.symbol && r.direction?.toLowerCase() === trade.direction?.toLowerCase()) {
        const timeDiff = Math.abs(new Date(trade.opened_at).getTime() - new Date(r.created_at).getTime());
        if (timeDiff < bestTimeDiff && timeDiff < 300000) {
          bestTimeDiff = timeDiff;
          bestMatch = r;
        }
      }
    }
    if (bestMatch) tradeFactors.set(trade.id, bestMatch);
  }

  // Collect all factor names with their current weights and groups
  const factorInfo = new Map<string, { weight: number; group: string }>();
  for (const r of reasonings) {
    if (!r.factors_json) continue;
    for (const f of r.factors_json) {
      if (!factorInfo.has(f.name)) {
        factorInfo.set(f.name, { weight: f.weight, group: f.group || "Unknown" });
      }
    }
  }

  const suggestions: FactorWeightSuggestion[] = [];

  for (const [factorName, info] of factorInfo) {
    let presentWins = 0, presentLosses = 0, absentWins = 0, absentLosses = 0;
    let presentPnl = 0, absentPnl = 0;

    for (const trade of trades) {
      const reasoning = tradeFactors.get(trade.id);
      if (!reasoning?.factors_json) continue;

      const factor = reasoning.factors_json.find(f => f.name === factorName);
      const isPresent = factor?.present === true;
      const isWin = trade.pnl > 0;

      if (isPresent) {
        if (isWin) presentWins++; else presentLosses++;
        presentPnl += trade.pnl;
      } else {
        if (isWin) absentWins++; else absentLosses++;
        absentPnl += trade.pnl;
      }
    }

    const presentTotal = presentWins + presentLosses;
    const absentTotal = absentWins + absentLosses;

    // Only suggest changes for factors with enough data
    if (presentTotal < 5) continue;

    const winRatePresent = presentTotal > 0 ? (presentWins / presentTotal) * 100 : 0;
    const winRateAbsent = absentTotal > 0 ? (absentWins / absentTotal) * 100 : 0;
    const avgPnlPresent = presentTotal > 0 ? presentPnl / presentTotal : 0;

    // Determine confidence based on sample size
    const confidence = presentTotal >= 20 ? "high" : presentTotal >= 10 ? "medium" : "low";

    // Calculate suggested weight adjustment
    let suggestedWeight = info.weight;
    let reason = "";

    // Factor is strongly predictive of wins
    if (winRatePresent > 65 && winRatePresent > winRateAbsent + 15 && avgPnlPresent > 0) {
      suggestedWeight = Math.min(info.weight * 1.25, 3.0); // Cap at 3.0
      reason = `Strong win predictor: ${winRatePresent.toFixed(0)}% win rate when present vs ${winRateAbsent.toFixed(0)}% when absent. Avg P&L when present: $${avgPnlPresent.toFixed(2)}`;
    }
    // Factor is weakly predictive or harmful
    else if (winRatePresent < 35 && presentTotal >= 8) {
      suggestedWeight = Math.max(info.weight * 0.5, 0.25); // Floor at 0.25
      reason = `Weak predictor: only ${winRatePresent.toFixed(0)}% win rate when present (${presentTotal} trades). Consider reducing weight.`;
    }
    // Factor makes no difference
    else if (Math.abs(winRatePresent - winRateAbsent) < 5 && presentTotal >= 10) {
      suggestedWeight = Math.max(info.weight * 0.75, 0.25);
      reason = `No edge detected: ${winRatePresent.toFixed(0)}% win rate present vs ${winRateAbsent.toFixed(0)}% absent — factor may be noise.`;
    }
    // Factor is moderately helpful
    else if (winRatePresent > 50 && winRatePresent > winRateAbsent + 5 && avgPnlPresent > 0) {
      // Keep current weight — it's working
      suggestedWeight = info.weight;
      reason = `Performing well: ${winRatePresent.toFixed(0)}% win rate, positive P&L. Keep current weight.`;
    }

    // Only include if there's an actual change suggestion
    if (Math.abs(suggestedWeight - info.weight) > 0.1 || confidence !== "low") {
      suggestions.push({
        factorName,
        group: info.group,
        currentWeight: info.weight,
        suggestedWeight: Math.round(suggestedWeight * 4) / 4, // Round to 0.25 increments
        reason,
        winRateWhenPresent: winRatePresent,
        winRateWhenAbsent: winRateAbsent,
        sampleSize: presentTotal,
        confidence,
      });
    }
  }

  return suggestions.sort((a, b) => {
    // Sort by impact: biggest weight change first
    const impactA = Math.abs(a.suggestedWeight - a.currentWeight) / a.currentWeight;
    const impactB = Math.abs(b.suggestedWeight - b.currentWeight) / b.currentWeight;
    return impactB - impactA;
  });
}

function detectMarketRegime(trades: TradeRecord[]): RegimeAnalysis {
  if (trades.length < 5) {
    return {
      currentRegime: "unknown",
      regimeConfidence: 0,
      regimeIndicators: ["Insufficient data for regime detection"],
      regimeImpact: "Cannot assess — need more trades",
    };
  }

  const sorted = [...trades].sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime());
  const indicators: string[] = [];
  let regimeScore = 0; // Positive = trending, negative = ranging

  // 1. Direction consistency — are most trades in one direction?
  const buys = trades.filter(t => t.direction?.toLowerCase() === "buy").length;
  const sells = trades.filter(t => t.direction?.toLowerCase() === "sell").length;
  const directionBias = Math.abs(buys - sells) / trades.length;
  if (directionBias > 0.6) {
    regimeScore += 2;
    indicators.push(`Strong directional bias: ${buys > sells ? "BUY" : "SELL"} dominant (${Math.max(buys, sells)}/${trades.length})`);
  } else if (directionBias < 0.2) {
    regimeScore -= 2;
    indicators.push(`Mixed direction: nearly equal BUY/SELL split — suggests ranging market`);
  }

  // 2. Win rate on trend-following factors vs mean-reversion
  // High win rate on Market Structure + Trend Direction = trending
  // High win rate on Reversal + Premium/Discount = ranging

  // 3. Average hold time — shorter holds in ranging, longer in trending
  const holdTimes = sorted.map(t => {
    const open = new Date(t.opened_at).getTime();
    const close = new Date(t.closed_at).getTime();
    return (close - open) / (1000 * 60 * 60); // hours
  });
  const avgHoldTime = holdTimes.reduce((s, v) => s + v, 0) / holdTimes.length;
  if (avgHoldTime > 12) {
    regimeScore += 1;
    indicators.push(`Long avg hold time (${avgHoldTime.toFixed(1)}h) — consistent with trending market`);
  } else if (avgHoldTime < 4) {
    regimeScore -= 1;
    indicators.push(`Short avg hold time (${avgHoldTime.toFixed(1)}h) — consistent with ranging/choppy market`);
  }

  // 4. SL hit rate — high SL hits in ranging markets (false breakouts)
  const slHits = trades.filter(t => t.close_reason === "sl_hit" || t.close_reason === "stop_loss").length;
  const slRate = slHits / trades.length;
  if (slRate > 0.6) {
    regimeScore -= 2;
    indicators.push(`High SL hit rate (${(slRate * 100).toFixed(0)}%) — suggests choppy/ranging conditions with false breakouts`);
  } else if (slRate < 0.3) {
    regimeScore += 1;
    indicators.push(`Low SL hit rate (${(slRate * 100).toFixed(0)}%) — price following through on entries`);
  }

  // 5. Consecutive loss streaks — more common in regime transitions
  let maxConsec = 0, currentConsec = 0;
  for (const t of sorted) {
    if (t.pnl <= 0) { currentConsec++; maxConsec = Math.max(maxConsec, currentConsec); }
    else { currentConsec = 0; }
  }
  if (maxConsec >= 5) {
    indicators.push(`Long losing streak (${maxConsec} consecutive) — possible regime change or strategy mismatch`);
  }

  // 6. P&L trend — are recent trades worse than earlier ones?
  const halfPoint = Math.floor(sorted.length / 2);
  const firstHalfPnl = sorted.slice(0, halfPoint).reduce((s, t) => s + t.pnl, 0);
  const secondHalfPnl = sorted.slice(halfPoint).reduce((s, t) => s + t.pnl, 0);
  if (secondHalfPnl < firstHalfPnl * 0.5 && firstHalfPnl > 0) {
    indicators.push(`Performance deteriorating: first half P&L $${firstHalfPnl.toFixed(2)} vs second half $${secondHalfPnl.toFixed(2)}`);
  } else if (secondHalfPnl > firstHalfPnl * 1.5 && secondHalfPnl > 0) {
    indicators.push(`Performance improving: second half P&L $${secondHalfPnl.toFixed(2)} vs first half $${firstHalfPnl.toFixed(2)}`);
  }

  // Determine regime
  let currentRegime: string;
  let regimeConfidence: number;
  if (regimeScore >= 3) {
    currentRegime = "strong_trend";
    regimeConfidence = Math.min(regimeScore / 5, 1);
  } else if (regimeScore >= 1) {
    currentRegime = "mild_trend";
    regimeConfidence = 0.5 + regimeScore * 0.1;
  } else if (regimeScore <= -3) {
    currentRegime = "choppy_range";
    regimeConfidence = Math.min(Math.abs(regimeScore) / 5, 1);
  } else if (regimeScore <= -1) {
    currentRegime = "mild_range";
    regimeConfidence = 0.5 + Math.abs(regimeScore) * 0.1;
  } else {
    currentRegime = "transitional";
    regimeConfidence = 0.3;
  }

  // Impact assessment
  let regimeImpact: string;
  if (currentRegime.includes("range") || currentRegime === "choppy_range") {
    regimeImpact = "SMC trend-following factors (Market Structure, Trend Direction) may underperform. Consider tightening SL, reducing position size, or pausing until trend resumes.";
  } else if (currentRegime.includes("trend")) {
    regimeImpact = "Trending conditions favor the SMC strategy. Consider widening TP targets and letting winners run longer.";
  } else {
    regimeImpact = "Market is transitioning — exercise caution and reduce position sizes until direction clarifies.";
  }

  return { currentRegime, regimeConfidence, regimeIndicators: indicators, regimeImpact };
}

// ─── LLM Integration ────────────────────────────────────────

async function callLLM(systemPrompt: string, userPrompt: string): Promise<WeeklyDiagnosis | null> {
  const forgeApiUrl = Deno.env.get("FORGE_API_URL") || Deno.env.get("BUILT_IN_FORGE_API_URL");
  const forgeApiKey = Deno.env.get("FORGE_API_KEY") || Deno.env.get("BUILT_IN_FORGE_API_KEY");

  if (!forgeApiUrl || !forgeApiKey) {
    console.error("LLM API credentials not configured.");
    return null;
  }

  const url = `${forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${forgeApiKey}`,
      },
      body: JSON.stringify({
        model: "gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
        max_tokens: 6144,
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

    return JSON.parse(jsonStr) as WeeklyDiagnosis;
  } catch (err) {
    console.error("LLM call failed:", err);
    return null;
  }
}

// ─── Prompt Construction ─────────────────────────────────────

const WEEKLY_SYSTEM_PROMPT = `You are a senior ICT/SMC trading strategist conducting a weekly portfolio review for an automated trading bot.

You have access to:
- 4 weeks of week-over-week performance data
- Factor-level win rate analysis with sample sizes
- Market regime indicators
- Pre-computed factor weight suggestions based on statistical analysis
- Previous recommendation history and their outcomes

Your job is to:
1. Identify TRENDS across weeks — is performance improving, degrading, or stable?
2. Validate or challenge the statistical factor weight suggestions with your trading expertise
3. Detect market regime changes and recommend strategy adjustments
4. Review past recommendations — did approved ones help? Were dismissed ones correct to dismiss?
5. Suggest at most 1 new feature/capability if there's a clear gap

RULES:
- Max 5 recommendations total (including factor weight changes)
- Factor weight changes must be justified by BOTH statistics AND trading logic
- Never suggest removing a core SMC factor entirely — minimum weight 0.25
- Regime-based suggestions should be temporary (include "revert when..." conditions)
- Be specific about numbers: "increase from 2.0 to 2.5" not "increase slightly"
- If the bot is profitable and improving, say so — don't fix what isn't broken
- Rate overall weekly_trend as: "improving" | "degrading" | "stable" | "volatile" | "insufficient_data"

Respond with valid JSON:
{
  "overall_assessment": "winning|losing|breakeven|insufficient_data",
  "weekly_trend": "improving|degrading|stable|volatile|insufficient_data",
  "diagnosis": "3-4 sentence summary covering the week's performance, trend, and primary concern/opportunity",
  "key_findings": [
    { "finding": "description", "evidence": "specific numbers across weeks", "severity": "critical|warning|info" }
  ],
  "factor_weight_suggestions": [
    {
      "factorName": "exact factor name",
      "group": "group name",
      "currentWeight": 1.5,
      "suggestedWeight": 2.0,
      "reason": "Statistical evidence + trading logic justification",
      "confidence": "high|medium|low"
    }
  ],
  "regime_analysis": {
    "currentRegime": "strong_trend|mild_trend|transitional|mild_range|choppy_range",
    "regimeConfidence": 0.8,
    "regimeIndicators": ["indicator descriptions"],
    "regimeImpact": "How this regime affects the strategy and what to adjust"
  },
  "recommendations": [
    {
      "category": "stop_loss|take_profit|factor_weights|session_filter|instrument_filter|risk_management|timing|regime_adaptation|general",
      "title": "Short actionable title",
      "description": "Detailed explanation",
      "current_value": {},
      "suggested_value": {},
      "confidence": "high|medium|low",
      "evidence": "Cross-week data supporting this",
      "risk_level": "low|medium|high"
    }
  ],
  "feature_gaps": ["Only include if there's a clear, specific gap — not generic suggestions"],
  "past_recommendation_review": "Brief assessment of how past recommendations performed, if data available"
}`;

function buildWeeklyPrompt(
  botId: string,
  botName: string,
  balance: number,
  peakBalance: number,
  weeklyData: WeeklyMetrics[],
  factorSuggestions: FactorWeightSuggestion[],
  regimeAnalysis: RegimeAnalysis,
  pastRecommendations: PreviousRecommendation[],
  config: any
): string {
  const drawdown = peakBalance > 0 ? ((peakBalance - balance) / peakBalance * 100).toFixed(1) : "0.0";

  let prompt = `=== WEEKLY STRATEGY REVIEW: ${botName} (${botId}) ===
Current balance: $${balance.toFixed(2)} | Peak: $${peakBalance.toFixed(2)} | Drawdown: ${drawdown}%

`;

  // Week-over-week comparison
  prompt += `=== WEEK-OVER-WEEK PERFORMANCE ===\n`;
  prompt += `Week | Trades | Win Rate | P&L | Avg Win | Avg Loss | PF | Max Consec Loss | Max DD%\n`;
  prompt += `---|---|---|---|---|---|---|---|---\n`;
  for (const w of weeklyData) {
    prompt += `${w.weekLabel} | ${w.totalTrades} | ${w.winRate.toFixed(1)}% | $${w.totalPnl.toFixed(2)} | $${w.avgWin.toFixed(2)} | $${w.avgLoss.toFixed(2)} | ${w.profitFactor === Infinity ? "∞" : w.profitFactor.toFixed(2)} | ${w.maxConsecutiveLosses} | ${w.maxDrawdownPercent.toFixed(1)}%\n`;
  }

  // Factor weight suggestions (pre-computed statistically)
  if (factorSuggestions.length > 0) {
    prompt += `\n=== STATISTICAL FACTOR WEIGHT ANALYSIS ===\n`;
    prompt += `These are pre-computed based on win rate correlation. Please validate with your trading expertise.\n\n`;
    prompt += `Factor | Group | Current Wt | Suggested Wt | Win% Present | Win% Absent | Sample | Confidence\n`;
    prompt += `---|---|---|---|---|---|---|---\n`;
    for (const f of factorSuggestions) {
      prompt += `${f.factorName} | ${f.group} | ${f.currentWeight} | ${f.suggestedWeight} | ${f.winRateWhenPresent.toFixed(1)}% | ${f.winRateWhenAbsent.toFixed(1)}% | ${f.sampleSize} | ${f.confidence}\n`;
    }
    prompt += `\n`;
    for (const f of factorSuggestions) {
      if (f.reason) prompt += `• ${f.factorName}: ${f.reason}\n`;
    }
  }

  // Regime analysis
  prompt += `\n=== MARKET REGIME DETECTION ===\n`;
  prompt += `Detected regime: ${regimeAnalysis.currentRegime} (confidence: ${(regimeAnalysis.regimeConfidence * 100).toFixed(0)}%)\n`;
  for (const ind of regimeAnalysis.regimeIndicators) {
    prompt += `• ${ind}\n`;
  }
  prompt += `Impact: ${regimeAnalysis.regimeImpact}\n`;

  // Past recommendations
  if (pastRecommendations.length > 0) {
    prompt += `\n=== PAST RECOMMENDATIONS (last 4 weeks) ===\n`;
    for (const rec of pastRecommendations) {
      const status = rec.status === "approved" ? "✅ APPROVED" : rec.status === "dismissed" ? "❌ DISMISSED" : "⏳ PENDING";
      prompt += `[${new Date(rec.created_at).toISOString().split("T")[0]}] ${status} — ${rec.overall_assessment}\n`;
      if (rec.recommendations) {
        for (const r of rec.recommendations.slice(0, 3)) {
          prompt += `  → ${r.title || r.category}: ${r.description?.substring(0, 100) || "N/A"}\n`;
        }
      }
    }
  }

  // Current config summary
  prompt += `\n=== CURRENT CONFIGURATION ===\n`;
  const c = config;
  prompt += `SL: ${c.slMethod || "atr"} (ATR×${c.slATRMultiple || 2.0})\n`;
  prompt += `TP: ${c.tpMethod || "rr_ratio"} (RR ${c.tpRatio || 3.0})\n`;
  prompt += `Min Score: ${c.minConfluenceScore || 5.0} | Min Factors: ${c.minFactorCount || 5}\n`;
  prompt += `Risk/Trade: ${c.riskPerTrade || 1.0}% | Max Concurrent: ${c.maxConcurrent || 3}\n`;
  prompt += `Max Daily Loss: ${c.maxDailyLoss || 5.0}% | Max Hold: ${c.maxHoldHours || 48}h\n`;
  prompt += `Trailing: ${c.trailingStopEnabled ? "ON" : "OFF"} | Break-Even: ${c.breakEvenEnabled ? "ON" : "OFF"}\n`;

  return prompt;
}

// ─── Telegram Notification ───────────────────────────────────

async function sendTelegramNotification(
  supabase: any,
  userId: string,
  diagnosis: WeeklyDiagnosis,
  botId: string,
  botName: string,
  balance: number,
  weeklyData: WeeklyMetrics[]
): Promise<void> {
  const assessmentEmoji: Record<string, string> = {
    winning: "🟢", losing: "🔴", breakeven: "🟡", insufficient_data: "⚪",
  };
  const trendEmoji: Record<string, string> = {
    improving: "📈", degrading: "📉", stable: "➡️", volatile: "🔀", insufficient_data: "❓",
  };

  const emoji = assessmentEmoji[diagnosis.overall_assessment] || "⚪";
  const trend = trendEmoji[diagnosis.weekly_trend] || "❓";
  const thisWeek = weeklyData[weeklyData.length - 1];

  let message = `📊 *Weekly Strategy Review — ${botName}*\n`;
  message += `Week ending: ${new Date().toISOString().split("T")[0]}\n\n`;
  message += `${emoji} *Overall: ${diagnosis.overall_assessment.toUpperCase()}*\n`;
  message += `${trend} *Trend: ${diagnosis.weekly_trend.toUpperCase()}*\n`;
  if (thisWeek) {
    message += `This week: ${thisWeek.winRate.toFixed(0)}% WR, $${thisWeek.totalPnl.toFixed(2)} P&L (${thisWeek.totalTrades} trades)\n`;
  }
  message += `Balance: $${balance.toFixed(2)}\n\n`;

  message += `🔍 *Diagnosis:*\n${diagnosis.diagnosis}\n\n`;

  // Regime
  if (diagnosis.regime_analysis) {
    message += `🌊 *Market Regime:* ${diagnosis.regime_analysis.currentRegime.replace(/_/g, " ")} (${(diagnosis.regime_analysis.regimeConfidence * 100).toFixed(0)}% confidence)\n`;
    message += `${diagnosis.regime_analysis.regimeImpact}\n\n`;
  }

  // Factor weight suggestions
  if (diagnosis.factor_weight_suggestions?.length > 0) {
    message += `⚖️ *Factor Weight Suggestions:*\n`;
    for (const f of diagnosis.factor_weight_suggestions.slice(0, 5)) {
      const arrow = f.suggestedWeight > f.currentWeight ? "⬆️" : f.suggestedWeight < f.currentWeight ? "⬇️" : "➡️";
      message += `${arrow} ${f.factorName}: ${f.currentWeight} → ${f.suggestedWeight} [${f.confidence}]\n`;
    }
    message += "\n";
  }

  // Recommendations
  if (diagnosis.recommendations?.length > 0) {
    message += `⚡ *Recommendations (${diagnosis.recommendations.length}):*\n`;
    for (let i = 0; i < Math.min(diagnosis.recommendations.length, 5); i++) {
      const r = diagnosis.recommendations[i];
      message += `${i + 1}. [${r.confidence?.toUpperCase()}] ${r.title}\n`;
    }
    message += "\n";
  }

  if (diagnosis.feature_gaps?.length > 0) {
    message += `💡 *Feature Gaps:*\n`;
    for (const gap of diagnosis.feature_gaps) {
      message += `• ${gap}\n`;
    }
    message += "\n";
  }

  if (diagnosis.past_recommendation_review) {
    message += `📝 *Past Recommendations:* ${diagnosis.past_recommendation_review}\n\n`;
  }

  message += `_Open dashboard to review and approve._`;

  try {
    const { error } = await supabase.functions.invoke("telegram-notify", {
      body: { message, parse_mode: "Markdown" },
    });
    if (error) console.error("Telegram notification failed:", error);
  } catch (err) {
    console.error("Failed to send Telegram notification:", err);
    const telegramToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const telegramChatId = Deno.env.get("TELEGRAM_CHAT_ID");
    if (telegramToken && telegramChatId) {
      try {
        await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: telegramChatId, text: message, parse_mode: "Markdown" }),
        });
      } catch (e) {
        console.error("Direct Telegram fallback also failed:", e);
      }
    }
  }
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

    let targetBotId: string | null = null;
    let targetUserId: string | null = null;

    try {
      const body = await req.json();
      targetBotId = body.bot_id || null;
      targetUserId = body.user_id || null;
    } catch { /* No body */ }

    console.log("[Weekly Advisor] Starting weekly strategy review...");

    // Step 1: Get all active paper accounts
    let accountQuery = supabase.from("paper_accounts").select("*").eq("is_running", true);
    if (targetBotId) accountQuery = accountQuery.eq("bot_id", targetBotId);
    if (targetUserId) accountQuery = accountQuery.eq("user_id", targetUserId);

    const { data: accounts, error: accErr } = await accountQuery;
    if (accErr) throw new Error(`Failed to load accounts: ${accErr.message}`);
    if (!accounts || accounts.length === 0) {
      return new Response(JSON.stringify({ status: "no_active_accounts" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Array<{ botId: string; userId: string; status: string }> = [];

    for (const account of accounts) {
      const userId = account.user_id;
      const botId = account.bot_id || "smc";
      const botName = botId === "smc" ? "Bot #1 (SMC)" : botId === "fotsi_mr" ? "Bot #2 (FOTSI)" : botId;

      console.log(`[Weekly Advisor] Reviewing ${botName} for user ${userId}...`);

      // Step 2: Fetch 4 weeks of trades
      const now = new Date();
      const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

      const { data: allTrades, error: tradeErr } = await supabase
        .from("paper_trade_history")
        .select("*")
        .eq("user_id", userId)
        .gte("closed_at", fourWeeksAgo.toISOString())
        .order("closed_at", { ascending: true });

      if (tradeErr) {
        console.error(`Failed to fetch trades:`, tradeErr);
        results.push({ botId, userId, status: "error_fetching_trades" });
        continue;
      }

      // Filter by bot_id
      const botTrades = (allTrades || []).filter((t: any) => {
        if (t.bot_id) return t.bot_id === botId;
        try {
          const reason = typeof t.signal_reason === "string" ? JSON.parse(t.signal_reason) : t.signal_reason;
          if (reason?.bot === "fotsi_mr") return botId === "fotsi_mr";
          return botId === "smc";
        } catch { return botId === "smc"; }
      });

      if (botTrades.length < 5) {
        console.log(`[Weekly Advisor] ${botName}: Only ${botTrades.length} trades in 4 weeks — skipping.`);
        results.push({ botId, userId, status: "insufficient_trades" });
        continue;
      }

      // Step 3: Split into weekly buckets
      const weeklyData: WeeklyMetrics[] = [];
      for (let w = 3; w >= 0; w--) {
        const weekStart = new Date(now.getTime() - (w + 1) * 7 * 24 * 60 * 60 * 1000);
        const weekEnd = new Date(now.getTime() - w * 7 * 24 * 60 * 60 * 1000);
        const weekTrades = botTrades.filter((t: any) => {
          const closedAt = new Date(t.closed_at).getTime();
          return closedAt >= weekStart.getTime() && closedAt < weekEnd.getTime();
        });
        const label = `Week ${4 - w} (${weekStart.toISOString().split("T")[0]})`;
        weeklyData.push(computeWeeklyMetrics(weekTrades, label, weekStart.toISOString(), weekEnd.toISOString()));
      }

      // Normalize trade records (DB stores numeric fields as text)
      const normalizedBotTrades: TradeRecord[] = botTrades.map(normalizeTradeRecord);

      if (normalizedBotTrades.length < 5) {
        console.log(`[Weekly Advisor] ${botName}: Only ${normalizedBotTrades.length} trades after normalization — skipping.`);
        results.push({ botId, userId, status: "insufficient_trades" });
        continue;
      }

      // Step 3.5: Split into weekly buckets (overwrite weeklyData using normalized trades)
      weeklyData.length = 0;
      for (let w = 3; w >= 0; w--) {
        const weekStart = new Date(now.getTime() - (w + 1) * 7 * 24 * 60 * 60 * 1000);
        const weekEnd = new Date(now.getTime() - w * 7 * 24 * 60 * 60 * 1000);
        const weekTrades = normalizedBotTrades.filter(t => {
          const closedAt = new Date(t.closed_at).getTime();
          return closedAt >= weekStart.getTime() && closedAt < weekEnd.getTime();
        });
        const label = `Week ${4 - w} (${weekStart.toISOString().split("T")[0]})`;
        weeklyData.push(computeWeeklyMetrics(weekTrades, label, weekStart.toISOString(), weekEnd.toISOString()));
      }

      // Step 4: Fetch reasonings for factor analysis
      const { data: reasonings } = await supabase
        .from("trade_reasonings")
        .select("*")
        .eq("user_id", userId)
        .gte("created_at", fourWeeksAgo.toISOString())
        .order("created_at", { ascending: true });

      const botReasonings = (reasonings || []).filter((r: any) => {
        if (r.bot_id) return r.bot_id === botId;
        return botId === "smc";
      });

      for (const r of botReasonings) {
        if (typeof r.factors_json === "string") {
          try { r.factors_json = JSON.parse(r.factors_json); } catch { r.factors_json = []; }
        }
      }

      // Step 5: Compute factor weight suggestions
      const factorSuggestions = computeFactorWeightSuggestions(normalizedBotTrades, botReasonings);

      // Step 6: Detect market regime
      const regimeAnalysis = detectMarketRegime(normalizedBotTrades);

      // Step 7: Fetch past recommendations
      const { data: pastRecs } = await supabase
        .from("bot_recommendations")
        .select("id, created_at, status, overall_assessment, recommendations, resolved_at")
        .eq("user_id", userId)
        .eq("bot_id", botId)
        .gte("created_at", fourWeeksAgo.toISOString())
        .order("created_at", { ascending: false })
        .limit(10);

      // Step 8: Fetch bot config
      const { data: configRow } = await supabase
        .from("bot_configs")
        .select("config_json")
        .eq("user_id", userId)
        .single();

      const rawConfig = configRow?.config_json || {};
      const configObj = typeof rawConfig === "string" ? JSON.parse(rawConfig) : rawConfig;
      const strategyConfig = {
        slMethod: configObj.strategy?.slMethod || "atr",
        slATRMultiple: configObj.strategy?.slATRMultiple || 2.0,
        tpMethod: configObj.strategy?.tpMethod || "rr_ratio",
        tpRatio: configObj.strategy?.tpRatio || 3.0,
        riskPerTrade: configObj.risk?.riskPerTrade || 1.0,
        maxConcurrent: configObj.risk?.maxConcurrent || 3,
        maxDailyLoss: configObj.risk?.maxDailyLoss || 5.0,
        minConfluenceScore: configObj.strategy?.minConfluenceScore || 5.0,
        minFactorCount: configObj.strategy?.minFactorCount || 5,
        maxHoldHours: configObj.risk?.maxHoldHours || 48,
        trailingStopEnabled: configObj.exit?.trailingStopEnabled ?? true,
        breakEvenEnabled: configObj.exit?.breakEvenEnabled ?? true,
      };

      // Step 9: Build prompt and call LLM
      const balanceNum = toSafeNumber(account.balance);
      const peakBalanceNum = toSafeNumber(account.peak_balance, balanceNum);
      const userPrompt = buildWeeklyPrompt(
        botId, botName, balanceNum, peakBalanceNum,
        weeklyData, factorSuggestions, regimeAnalysis,
        pastRecs || [], strategyConfig
      );

      console.log(`[Weekly Advisor] Calling LLM for ${botName}...`);
      const diagnosis = await callLLM(WEEKLY_SYSTEM_PROMPT, userPrompt);

      if (!diagnosis) {
        results.push({ botId, userId, status: "llm_failed" });
        continue;
      }

      console.log(`[Weekly Advisor] ${botName}: ${diagnosis.overall_assessment}, trend: ${diagnosis.weekly_trend}, ${diagnosis.recommendations?.length || 0} recommendations`);

      // Step 10: Store in database
      const { error: insertErr } = await supabase
        .from("bot_recommendations")
        .insert({
          user_id: userId,
          bot_id: botId,
          review_type: "weekly",
          performance_summary: {
            weeklyData,
            factorSuggestions: factorSuggestions.slice(0, 20),
            regimeAnalysis,
            balance: balanceNum,
            peakBalance: peakBalanceNum,
          },
          diagnosis: diagnosis.diagnosis,
          recommendations: [
            ...(diagnosis.recommendations || []),
            ...(diagnosis.factor_weight_suggestions || []).map(f => ({
              category: "factor_weights",
              title: `${f.factorName}: ${f.currentWeight} → ${f.suggestedWeight}`,
              description: f.reason,
              current_value: { [f.factorName]: f.currentWeight },
              suggested_value: { [f.factorName]: f.suggestedWeight },
              confidence: f.confidence,
              evidence: `Win rate when present: ${f.winRateWhenPresent?.toFixed(1)}%, absent: ${f.winRateWhenAbsent?.toFixed(1)}%`,
              risk_level: "medium",
            })),
          ],
          feature_gaps: diagnosis.feature_gaps || [],
          status: "pending",
          overall_assessment: diagnosis.overall_assessment,
          llm_model: "gemini-2.5-flash",
        });

      if (insertErr) {
        console.error(`Failed to store weekly recommendation:`, insertErr);
      }

      // Step 11: Send Telegram notification
      await sendTelegramNotification(
        supabase, userId, diagnosis, botId, botName,
        account.balance, weeklyData
      );

      results.push({
        botId, userId,
        status: `${diagnosis.overall_assessment} / ${diagnosis.weekly_trend} — ${(diagnosis.recommendations?.length || 0) + (diagnosis.factor_weight_suggestions?.length || 0)} recommendations`,
      });
    }

    console.log("[Weekly Advisor] Completed.", results);

    return new Response(JSON.stringify({ status: "completed", results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[Weekly Advisor] Fatal error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
