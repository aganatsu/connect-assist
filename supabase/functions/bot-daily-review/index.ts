// ============================================================
// Bot Daily Performance Reviewer — Self-Learning Edge Function
// Runs daily after NY session close (22:00 UTC via pg_cron)
// Analyzes recent trades, generates LLM diagnosis, sends
// recommendations via Telegram
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
  signal_reason?: unknown;
  bot_id?: string;
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

interface BotConfig {
  slMethod: string;
  slATRMultiple: number;
  slFixedPips?: number;
  tpMethod: string;
  tpRatio: number;
  riskPerTrade: number;
  maxConcurrent: number;
  maxDailyLoss: number;
  minConfluenceScore: number;
  minFactorCount: number;
  maxHoldHours: number;
  cooldownMinutes: number;
  trailingStopEnabled: boolean;
  breakEvenEnabled: boolean;
  partialTPEnabled: boolean;
  sessions: Record<string, boolean>;
  instruments: string[];
  [key: string]: unknown;
}

interface PerformanceMetrics {
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
}

interface FactorMetric {
  name: string;
  group: string;
  appearedIn: number;
  appearedInWins: number;
  appearedInLosses: number;
  winRateWhenPresent: number;
  winRateWhenAbsent: number;
  avgPnlWhenPresent: number;
}

interface DimensionalBreakdown {
  dimension: string;
  value: string;
  trades: number;
  wins: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
}

interface SLAnalysis {
  slHitRate: number;
  avgSLDistanceATR: number;
  postSLReversalRate: number;
  avgAdverseExcursion: number;
  totalSLHits: number;
  totalTrades: number;
}

interface LLMRecommendation {
  category: string;
  title: string;
  description: string;
  current_value: Record<string, unknown>;
  suggested_value: Record<string, unknown>;
  confidence: string;
  evidence: string;
  risk_level: string;
}

interface LLMDiagnosis {
  overall_assessment: string;
  diagnosis: string;
  key_findings: Array<{
    finding: string;
    evidence: string;
    severity: string;
  }>;
  recommendations: LLMRecommendation[];
  feature_gaps: string[];
}

// ─── Helpers ─────────────────────────────────────────────────

function toSafeNumber(value: unknown, fallback = 0): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeTradeRecord(raw: any): TradeRecord {
  return {
    id: String(raw.id ?? raw.position_id ?? ""),
    user_id: String(raw.user_id ?? ""),
    symbol: String(raw.symbol ?? ""),
    direction: String(raw.direction ?? ""),
    entry_price: toSafeNumber(raw.entry_price),
    exit_price: toSafeNumber(raw.exit_price),
    sl: toSafeNumber(raw.stop_loss ?? raw.sl),
    tp: toSafeNumber(raw.take_profit ?? raw.tp),
    pnl: toSafeNumber(raw.pnl ?? raw.pnl_amount),
    pnl_percent: toSafeNumber(raw.pnl_percent),
    close_reason: String(raw.close_reason ?? "unknown"),
    opened_at: String(raw.open_time ?? raw.opened_at ?? raw.created_at ?? ""),
    closed_at: String(raw.closed_at ?? raw.exit_time ?? raw.created_at ?? ""),
    lot_size: toSafeNumber(raw.size ?? raw.lot_size),
    signal_reason: raw.signal_reason,
    bot_id: raw.bot_id ? String(raw.bot_id) : undefined,
  };
}

function computePerformanceMetrics(trades: TradeRecord[]): PerformanceMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      totalPnl: 0, avgWin: 0, avgLoss: 0, profitFactor: 0,
      maxConsecutiveLosses: 0, avgRRAchieved: 0,
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  let maxConsec = 0;
  let currentConsec = 0;
  for (const t of trades.sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime())) {
    if (t.pnl <= 0) {
      currentConsec++;
      maxConsec = Math.max(maxConsec, currentConsec);
    } else {
      currentConsec = 0;
    }
  }

  const rrValues = wins.map(t => {
    const risk = Math.abs(t.entry_price - t.sl);
    if (risk === 0) return 0;
    return Math.abs(t.exit_price - t.entry_price) / risk;
  });
  const avgRR = rrValues.length > 0 ? rrValues.reduce((s, v) => s + v, 0) / rrValues.length : 0;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    totalPnl: trades.reduce((s, t) => s + t.pnl, 0),
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxConsecutiveLosses: maxConsec,
    avgRRAchieved: avgRR,
  };
}

function computeFactorMetrics(
  trades: TradeRecord[],
  reasonings: TradeReasoning[]
): FactorMetric[] {
  // Match reasonings to trades by symbol + direction + proximity in time
  const tradeReasoningMap = new Map<string, TradeReasoning>();
  for (const r of reasonings) {
    const key = `${r.symbol}_${r.direction}_${r.created_at}`;
    tradeReasoningMap.set(key, r);
  }

  // Build a map of trade -> reasoning by finding closest reasoning for each trade
  const tradeFactors = new Map<string, TradeReasoning>();
  for (const trade of trades) {
    let bestMatch: TradeReasoning | null = null;
    let bestTimeDiff = Infinity;
    for (const r of reasonings) {
      if (r.symbol === trade.symbol && r.direction?.toLowerCase() === trade.direction?.toLowerCase()) {
        const timeDiff = Math.abs(new Date(trade.opened_at).getTime() - new Date(r.created_at).getTime());
        if (timeDiff < bestTimeDiff && timeDiff < 300000) { // Within 5 minutes
          bestTimeDiff = timeDiff;
          bestMatch = r;
        }
      }
    }
    if (bestMatch) {
      tradeFactors.set(trade.id, bestMatch);
    }
  }

  // Collect all unique factor names
  const allFactorNames = new Map<string, string>(); // name -> group
  for (const r of reasonings) {
    if (r.factors_json) {
      for (const f of r.factors_json) {
        if (!allFactorNames.has(f.name)) {
          allFactorNames.set(f.name, f.group || "Unknown");
        }
      }
    }
  }

  // Compute per-factor metrics
  const metrics: FactorMetric[] = [];
  for (const [factorName, group] of allFactorNames) {
    let appearedIn = 0;
    let appearedInWins = 0;
    let appearedInLosses = 0;
    let pnlWhenPresent = 0;
    let absentWins = 0;
    let absentTotal = 0;

    for (const trade of trades) {
      const reasoning = tradeFactors.get(trade.id);
      if (!reasoning || !reasoning.factors_json) continue;

      const factor = reasoning.factors_json.find(f => f.name === factorName);
      const isPresent = factor?.present === true;
      const isWin = trade.pnl > 0;

      if (isPresent) {
        appearedIn++;
        if (isWin) appearedInWins++;
        else appearedInLosses++;
        pnlWhenPresent += trade.pnl;
      } else {
        absentTotal++;
        if (isWin) absentWins++;
      }
    }

    metrics.push({
      name: factorName,
      group,
      appearedIn,
      appearedInWins,
      appearedInLosses,
      winRateWhenPresent: appearedIn > 0 ? (appearedInWins / appearedIn) * 100 : 0,
      winRateWhenAbsent: absentTotal > 0 ? (absentWins / absentTotal) * 100 : 0,
      avgPnlWhenPresent: appearedIn > 0 ? pnlWhenPresent / appearedIn : 0,
    });
  }

  return metrics.sort((a, b) => b.appearedIn - a.appearedIn);
}

function computeDimensionalBreakdowns(trades: TradeRecord[]): {
  bySession: DimensionalBreakdown[];
  bySymbol: DimensionalBreakdown[];
  byDirection: DimensionalBreakdown[];
  byCloseReason: DimensionalBreakdown[];
  byScoreBucket: DimensionalBreakdown[];
} {
  const groupBy = (dimension: string, keyFn: (t: TradeRecord) => string): DimensionalBreakdown[] => {
    const groups = new Map<string, TradeRecord[]>();
    for (const t of trades) {
      const key = keyFn(t);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }
    return Array.from(groups.entries()).map(([value, group]) => {
      const wins = group.filter(t => t.pnl > 0).length;
      const totalPnl = group.reduce((s, t) => s + t.pnl, 0);
      return {
        dimension,
        value,
        trades: group.length,
        wins,
        winRate: group.length > 0 ? (wins / group.length) * 100 : 0,
        avgPnl: group.length > 0 ? totalPnl / group.length : 0,
        totalPnl,
      };
    }).sort((a, b) => b.trades - a.trades);
  };

  // Determine session from trade open time
  const getSession = (t: TradeRecord): string => {
    const hour = new Date(t.opened_at).getUTCHours();
    if (hour >= 0 && hour < 8) return "Asian";
    if (hour >= 7 && hour < 12) return "London";
    if (hour >= 12 && hour < 17) return "New York AM";
    if (hour >= 17 && hour < 21) return "New York PM";
    return "Off-hours";
  };

  return {
    bySession: groupBy("Session", getSession),
    bySymbol: groupBy("Symbol", t => t.symbol),
    byDirection: groupBy("Direction", t => t.direction?.toUpperCase() || "UNKNOWN"),
    byCloseReason: groupBy("Close Reason", t => t.close_reason || "unknown"),
    byScoreBucket: [], // Will be populated from reasonings
  };
}

function computeSLAnalysis(trades: TradeRecord[]): SLAnalysis {
  const slHits = trades.filter(t => t.close_reason === "sl_hit" || t.close_reason === "stop_loss");
  const slHitRate = trades.length > 0 ? (slHits.length / trades.length) * 100 : 0;

  // Average SL distance in price terms
  const slDistances = trades
    .filter(t => t.sl && t.entry_price)
    .map(t => Math.abs(t.entry_price - t.sl));
  const avgSLDistance = slDistances.length > 0
    ? slDistances.reduce((s, v) => s + v, 0) / slDistances.length
    : 0;

  // For SL hits, check if price reversed after (approximate — we don't have tick data)
  // We'll estimate based on whether the trade would have been profitable at a wider SL
  const postSLReversals = slHits.filter(t => {
    // If the exit was at SL but the TP was eventually reachable, it was a sweep
    // Approximate: if |entry - tp| / |entry - sl| > 1.5, the setup had room
    const risk = Math.abs(t.entry_price - t.sl);
    const reward = Math.abs(t.tp - t.entry_price);
    return risk > 0 && reward / risk >= 1.5;
  });
  const postSLReversalRate = slHits.length > 0
    ? (postSLReversals.length / slHits.length) * 100
    : 0;

  // Average adverse excursion for winners (how far price went against before winning)
  const winners = trades.filter(t => t.pnl > 0 && t.sl && t.entry_price);
  const adverseExcursions = winners.map(t => {
    // Approximate: distance from entry to SL as fraction of total move
    const risk = Math.abs(t.entry_price - t.sl);
    const reward = Math.abs(t.exit_price - t.entry_price);
    return risk > 0 ? risk / (risk + reward) : 0;
  });
  const avgAdverseExcursion = adverseExcursions.length > 0
    ? adverseExcursions.reduce((s, v) => s + v, 0) / adverseExcursions.length
    : 0;

  return {
    slHitRate,
    avgSLDistanceATR: avgSLDistance, // Note: this is in price, not ATR — we don't have ATR data post-trade
    postSLReversalRate,
    avgAdverseExcursion,
    totalSLHits: slHits.length,
    totalTrades: trades.length,
  };
}

// ─── LLM Integration ────────────────────────────────────────

async function callLLM(systemPrompt: string, userPrompt: string): Promise<LLMDiagnosis | null> {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const forgeApiUrl = Deno.env.get("FORGE_API_URL") || Deno.env.get("BUILT_IN_FORGE_API_URL");
  const forgeApiKey = Deno.env.get("FORGE_API_KEY") || Deno.env.get("BUILT_IN_FORGE_API_KEY");

  // Prefer Lovable AI Gateway (uses LOVABLE_API_KEY), fall back to Forge
  const useLovable = !!lovableKey;
  const url = useLovable
    ? "https://ai.gateway.lovable.dev/v1/chat/completions"
    : forgeApiUrl
      ? `${forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions`
      : "";
  const apiKey = useLovable ? lovableKey : forgeApiKey;
  const model = useLovable ? "google/gemini-2.5-flash" : "gemini-2.5-flash";

  if (!url || !apiKey) {
    console.error("LLM API credentials not configured. Set LOVABLE_API_KEY in Supabase secrets.");
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
        temperature: 0.3,
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

    // Parse the JSON response — handle potential markdown wrapping
    let jsonStr = content.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    return JSON.parse(jsonStr) as LLMDiagnosis;
  } catch (err) {
    console.error("LLM call failed:", err);
    return null;
  }
}

// ─── Prompt Construction ─────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert ICT/SMC trading coach reviewing a student's automated trading bot journal.
The bot uses Smart Money Concepts: order blocks, fair value gaps, liquidity sweeps, market structure breaks, premium/discount zones, kill zones, Silver Bullet windows, SMT divergence, displacement, breaker blocks, unicorn model, AMD phases, volume profile, trend direction, and daily bias.

Your job is to:
1. Analyze the performance data provided
2. Identify the PRIMARY reason for underperformance (if any)
3. Suggest SPECIFIC, ACTIONABLE configuration changes with exact values
4. Be honest — if performance is good, say so and suggest minor optimizations only

RULES:
- Never suggest risk per trade above 3%
- Never suggest disabling more than 3 factors at once
- Never suggest changing SL method without strong evidence (10+ trades showing the pattern)
- Always explain your reasoning with specific numbers from the data
- Rate your confidence: high (clear pattern, 15+ trades), medium (suggestive, 8-15 trades), low (preliminary, <8 trades)
- If insufficient data (<5 trades), set overall_assessment to "insufficient_data" and recommend waiting
- Focus on the most impactful changes first — max 3 recommendations per review
- For factor weight suggestions, only suggest changes for factors with 10+ appearances
- Consider market regime — if the bot is losing in ranging markets, suggest regime-aware changes

You MUST respond with valid JSON in this exact format:
{
  "overall_assessment": "winning|losing|breakeven|insufficient_data",
  "diagnosis": "2-3 sentence plain English summary of what is happening and why",
  "key_findings": [
    { "finding": "description", "evidence": "specific numbers", "severity": "critical|warning|info" }
  ],
  "recommendations": [
    {
      "category": "stop_loss|take_profit|factor_weights|session_filter|instrument_filter|risk_management|timing|general",
      "title": "Short actionable title",
      "description": "Detailed explanation with numbers from the data",
      "current_value": { "config_key": "current_value" },
      "suggested_value": { "config_key": "new_value" },
      "confidence": "high|medium|low",
      "evidence": "Specific data points supporting this recommendation",
      "risk_level": "low|medium|high"
    }
  ],
  "feature_gaps": [
    "Description of a capability the bot does not have but would help based on the patterns you see"
  ]
}`;

function buildUserPrompt(
  botId: string,
  botName: string,
  balance: number,
  peakBalance: number,
  dailyMetrics: PerformanceMetrics,
  weeklyMetrics: PerformanceMetrics,
  factorMetrics: FactorMetric[],
  breakdowns: ReturnType<typeof computeDimensionalBreakdowns>,
  slAnalysis: SLAnalysis,
  config: BotConfig,
  reviewType: "daily" | "weekly"
): string {
  const balanceNum = Number(balance);
  const peakNum = Number(peakBalance);
  const drawdown = peakNum > 0 ? (((peakNum - balanceNum) / peakNum) * 100).toFixed(2) : "0.00";

  let prompt = `Here is the performance data for Bot: ${botId} (${botName})
Review type: ${reviewType.toUpperCase()}
Current account balance: $${Number(balance).toFixed(2)} (peak: $${Number(peakBalance).toFixed(2)}, drawdown: ${drawdown}%)

=== CORE METRICS (Last 24 hours) ===
Total trades: ${dailyMetrics.totalTrades}
Wins: ${dailyMetrics.wins} | Losses: ${dailyMetrics.losses} | Win Rate: ${dailyMetrics.winRate.toFixed(1)}%
Total P&L: $${dailyMetrics.totalPnl.toFixed(2)}
Avg Win: $${dailyMetrics.avgWin.toFixed(2)} | Avg Loss: $${dailyMetrics.avgLoss.toFixed(2)}
Profit Factor: ${dailyMetrics.profitFactor === Infinity ? "∞" : dailyMetrics.profitFactor.toFixed(2)}
Max Consecutive Losses: ${dailyMetrics.maxConsecutiveLosses}
Avg RR Achieved (winners): ${dailyMetrics.avgRRAchieved.toFixed(2)}

=== CORE METRICS (Last 7 days) ===
Total trades: ${weeklyMetrics.totalTrades}
Wins: ${weeklyMetrics.wins} | Losses: ${weeklyMetrics.losses} | Win Rate: ${weeklyMetrics.winRate.toFixed(1)}%
Total P&L: $${weeklyMetrics.totalPnl.toFixed(2)}
Avg Win: $${weeklyMetrics.avgWin.toFixed(2)} | Avg Loss: $${weeklyMetrics.avgLoss.toFixed(2)}
Profit Factor: ${weeklyMetrics.profitFactor === Infinity ? "∞" : weeklyMetrics.profitFactor.toFixed(2)}
Max Consecutive Losses: ${weeklyMetrics.maxConsecutiveLosses}
Avg RR Achieved (winners): ${weeklyMetrics.avgRRAchieved.toFixed(2)}
`;

  // Factor performance
  if (factorMetrics.length > 0) {
    prompt += `\n=== FACTOR PERFORMANCE (Last 7 days, ${weeklyMetrics.totalTrades} trades) ===\n`;
    prompt += `Factor Name | Group | Appeared In | Win Rate When Present | Win Rate When Absent | Avg P&L When Present\n`;
    prompt += `---|---|---|---|---|---\n`;
    for (const f of factorMetrics) {
      prompt += `${f.name} | ${f.group} | ${f.appearedIn} trades | ${f.winRateWhenPresent.toFixed(1)}% | ${f.winRateWhenAbsent.toFixed(1)}% | $${f.avgPnlWhenPresent.toFixed(2)}\n`;
    }
  }

  // Session breakdown
  if (breakdowns.bySession.length > 0) {
    prompt += `\n=== SESSION BREAKDOWN ===\n`;
    prompt += `Session | Trades | Wins | Win Rate | Avg P&L | Total P&L\n`;
    prompt += `---|---|---|---|---|---\n`;
    for (const s of breakdowns.bySession) {
      prompt += `${s.value} | ${s.trades} | ${s.wins} | ${s.winRate.toFixed(1)}% | $${s.avgPnl.toFixed(2)} | $${s.totalPnl.toFixed(2)}\n`;
    }
  }

  // Symbol breakdown
  if (breakdowns.bySymbol.length > 0) {
    prompt += `\n=== INSTRUMENT BREAKDOWN ===\n`;
    prompt += `Symbol | Trades | Wins | Win Rate | Avg P&L | Total P&L\n`;
    prompt += `---|---|---|---|---|---\n`;
    for (const s of breakdowns.bySymbol) {
      prompt += `${s.value} | ${s.trades} | ${s.wins} | ${s.winRate.toFixed(1)}% | $${s.avgPnl.toFixed(2)} | $${s.totalPnl.toFixed(2)}\n`;
    }
  }

  // Direction breakdown
  if (breakdowns.byDirection.length > 0) {
    prompt += `\n=== DIRECTION BREAKDOWN ===\n`;
    for (const d of breakdowns.byDirection) {
      prompt += `${d.value}: ${d.trades} trades, ${d.winRate.toFixed(1)}% win rate, $${d.totalPnl.toFixed(2)} total P&L\n`;
    }
  }

  // Close reason breakdown
  if (breakdowns.byCloseReason.length > 0) {
    prompt += `\n=== CLOSE REASON DISTRIBUTION ===\n`;
    for (const c of breakdowns.byCloseReason) {
      prompt += `${c.value}: ${c.trades} trades (${(c.trades / weeklyMetrics.totalTrades * 100).toFixed(0)}%)\n`;
    }
  }

  // SL Analysis
  prompt += `\n=== STOP LOSS ANALYSIS ===\n`;
  prompt += `SL Hit Rate: ${slAnalysis.slHitRate.toFixed(1)}% (${slAnalysis.totalSLHits} of ${slAnalysis.totalTrades} trades)\n`;
  prompt += `Avg SL Distance: ${slAnalysis.avgSLDistanceATR.toFixed(5)} price units\n`;
  prompt += `Post-SL Reversal Rate (estimated): ${slAnalysis.postSLReversalRate.toFixed(1)}%\n`;
  prompt += `Avg Adverse Excursion (winners): ${(slAnalysis.avgAdverseExcursion * 100).toFixed(1)}% of total move\n`;

  // Current config
  prompt += `\n=== CURRENT BOT CONFIGURATION ===\n`;
  prompt += `SL Method: ${config.slMethod}, ATR Multiple: ${config.slATRMultiple}\n`;
  prompt += `TP Method: ${config.tpMethod}, RR Ratio: ${config.tpRatio}\n`;
  prompt += `Min Confluence Score: ${config.minConfluenceScore}, Min Factor Count: ${config.minFactorCount}\n`;
  prompt += `Risk Per Trade: ${config.riskPerTrade}%, Max Concurrent: ${config.maxConcurrent}\n`;
  prompt += `Max Daily Loss: ${config.maxDailyLoss}%, Max Hold Hours: ${config.maxHoldHours}\n`;
  prompt += `Trailing Stop: ${config.trailingStopEnabled ? "ON" : "OFF"}, Break Even: ${config.breakEvenEnabled ? "ON" : "OFF"}\n`;
  prompt += `Sessions: ${Object.entries(config.sessions || {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "All"}\n`;

  return prompt;
}

// ─── Telegram Notification ───────────────────────────────────

async function sendTelegramNotification(
  supabase: any,
  userId: string,
  diagnosis: LLMDiagnosis,
  botId: string,
  botName: string,
  balance: number,
  dailyMetrics: PerformanceMetrics
): Promise<void> {
  // Format the Telegram message
  const assessmentEmoji: Record<string, string> = {
    winning: "🟢",
    losing: "🔴",
    breakeven: "🟡",
    insufficient_data: "⚪",
  };

  const emoji = assessmentEmoji[diagnosis.overall_assessment] || "⚪";
  const pnlSign = dailyMetrics.totalPnl >= 0 ? "+" : "";

  let message = `📊 *Daily Trading Review — ${botName}*\n`;
  message += `Date: ${new Date().toISOString().split("T")[0]}\n\n`;
  message += `${emoji} *Overall: ${diagnosis.overall_assessment.toUpperCase()}*\n`;
  message += `Win Rate: ${dailyMetrics.winRate.toFixed(0)}% (${dailyMetrics.wins}/${dailyMetrics.totalTrades})\n`;
  message += `P&L: ${pnlSign}$${dailyMetrics.totalPnl.toFixed(2)} | Balance: $${Number(balance).toFixed(2)}\n\n`;

  message += `🔍 *Diagnosis:*\n${diagnosis.diagnosis}\n\n`;

  if (diagnosis.key_findings?.length > 0) {
    message += `📋 *Key Findings:*\n`;
    for (const f of diagnosis.key_findings) {
      const icon = f.severity === "critical" ? "🚨" : f.severity === "warning" ? "⚠️" : "ℹ️";
      message += `${icon} ${f.finding}\n`;
    }
    message += "\n";
  }

  if (diagnosis.recommendations?.length > 0) {
    message += `⚡ *Recommendations:*\n`;
    for (let i = 0; i < diagnosis.recommendations.length; i++) {
      const r = diagnosis.recommendations[i];
      const confIcon = r.confidence === "high" ? "🔴" : r.confidence === "medium" ? "🟡" : "🟢";
      message += `${i + 1}. [${r.confidence.toUpperCase()}] ${r.title}\n`;
      message += `   → ${r.description.substring(0, 150)}${r.description.length > 150 ? "..." : ""}\n`;
    }
    message += "\n";
  }

  if (diagnosis.feature_gaps?.length > 0) {
    message += `💡 *Feature Suggestions:*\n`;
    for (const gap of diagnosis.feature_gaps) {
      message += `• ${gap}\n`;
    }
    message += "\n";
  }

  message += `_Open dashboard to review and approve recommendations._`;

  // Send via telegram-notify Edge Function
  try {
    const { error } = await supabase.functions.invoke("telegram-notify", {
      body: { message, parse_mode: "Markdown" },
    });
    if (error) console.error("Telegram notification failed:", error);
  } catch (err) {
    console.error("Failed to send Telegram notification:", err);
    // Fallback: try direct Telegram API if bot token is available
    const telegramToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const telegramChatId = Deno.env.get("TELEGRAM_CHAT_ID");
    if (telegramToken && telegramChatId) {
      try {
        await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: telegramChatId,
            text: message,
            parse_mode: "Markdown",
          }),
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

    // Parse request body for optional parameters
    let reviewType: "daily" | "weekly" = "daily";
    let targetBotId: string | null = null;
    let targetUserId: string | null = null;

    try {
      const body = await req.json();
      reviewType = body.review_type || "daily";
      targetBotId = body.bot_id || null;
      targetUserId = body.user_id || null;
    } catch {
      // No body — use defaults (daily review for all bots)
    }

    console.log(`[Bot Review] Starting ${reviewType} review...`);

    // Step 1: Get all active paper accounts
    let accountQuery = supabase
      .from("paper_accounts")
      .select("*")
      .eq("is_running", true);

    if (targetBotId) accountQuery = accountQuery.eq("bot_id", targetBotId);
    if (targetUserId) accountQuery = accountQuery.eq("user_id", targetUserId);

    const { data: accounts, error: accErr } = await accountQuery;
    if (accErr) throw new Error(`Failed to load accounts: ${accErr.message}`);
    if (!accounts || accounts.length === 0) {
      console.log("[Bot Review] No active accounts found.");
      return new Response(JSON.stringify({ status: "no_active_accounts" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Array<{ botId: string; userId: string; status: string }> = [];

    for (const account of accounts) {
      const userId = account.user_id;
      const botId = account.bot_id || "smc";
      const botName = botId === "smc" ? "Bot #1 (SMC)" : botId === "fotsi_mr" ? "Bot #2 (FOTSI)" : botId;

      console.log(`[Bot Review] Reviewing ${botName} for user ${userId}...`);

      // Step 2: Fetch recent trades (last 24h for daily, last 7d for weekly)
      const now = new Date();
      const dailyCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const weeklyCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

      // Fetch 7-day trades (includes daily subset)
      const { data: weeklyTrades, error: tradeErr } = await supabase
        .from("paper_trade_history")
        .select("*")
        .eq("user_id", userId)
        .gte("closed_at", weeklyCutoff)
        .order("closed_at", { ascending: true });

      if (tradeErr) {
        console.error(`Failed to fetch trades for ${userId}:`, tradeErr);
        results.push({ botId, userId, status: "error_fetching_trades" });
        continue;
      }

      const normalizedTrades = (weeklyTrades || []).map((t: any) => normalizeTradeRecord(t));

      // Filter by bot_id if column exists
      const botTrades = normalizedTrades.filter((t: TradeRecord) => {
        if (t.bot_id) return t.bot_id === botId;
        try {
          const reason = typeof t.signal_reason === "string" ? JSON.parse(t.signal_reason) : t.signal_reason;
          if (reason?.bot === "fotsi_mr") return botId === "fotsi_mr";
          return botId === "smc";
        } catch {
          return botId === "smc";
        }
      });

      const dailyTrades = botTrades.filter((t: TradeRecord) =>
        new Date(t.closed_at).getTime() >= new Date(dailyCutoff).getTime()
      );

      // Check minimum trade count
      if (botTrades.length < 3) {
        console.log(`[Bot Review] ${botName}: Only ${botTrades.length} trades in 7 days — skipping.`);
        results.push({ botId, userId, status: "insufficient_trades" });
        continue;
      }

      // Step 3: Fetch trade reasonings for factor analysis
      const { data: reasonings, error: reasonErr } = await supabase
        .from("trade_reasonings")
        .select("*")
        .eq("user_id", userId)
        .gte("created_at", weeklyCutoff)
        .order("created_at", { ascending: true });

      if (reasonErr) {
        console.error(`Failed to fetch reasonings for ${userId}:`, reasonErr);
      }

      // Filter reasonings by bot_id too
      const botReasonings = (reasonings || []).filter((r: any) => {
        if (r.bot_id) return r.bot_id === botId;
        try {
          const factors = typeof r.factors_json === "string" ? JSON.parse(r.factors_json) : r.factors_json;
          // FOTSI reasonings typically have fewer SMC factors
          return botId === "smc"; // Default
        } catch {
          return botId === "smc";
        }
      });

      // Parse factors_json if stored as string
      for (const r of botReasonings) {
        if (typeof r.factors_json === "string") {
          try { r.factors_json = JSON.parse(r.factors_json); } catch { r.factors_json = []; }
        }
      }

      // Step 4: Fetch bot config
      const { data: configRow } = await supabase
        .from("bot_configs")
        .select("config_json")
        .eq("user_id", userId)
        .single();

      const rawConfig = configRow?.config_json || {};
      const configObj = typeof rawConfig === "string" ? JSON.parse(rawConfig) : rawConfig;
      const botConfig: BotConfig = {
        slMethod: configObj.strategy?.slMethod || configObj.slMethod || "atr",
        slATRMultiple: configObj.strategy?.slATRMultiple || configObj.slATRMultiple || 2.0,
        tpMethod: configObj.strategy?.tpMethod || configObj.tpMethod || "rr_ratio",
        tpRatio: configObj.strategy?.tpRatio || configObj.tpRatio || 3.0,
        riskPerTrade: configObj.risk?.riskPerTrade || configObj.riskPerTrade || 1.0,
        maxConcurrent: configObj.risk?.maxConcurrent || configObj.maxConcurrent || 3,
        maxDailyLoss: configObj.risk?.maxDailyLoss || configObj.maxDailyLoss || 5.0,
        minConfluenceScore: configObj.strategy?.minConfluenceScore || configObj.minConfluenceScore || 5.0,
        minFactorCount: configObj.strategy?.minFactorCount || configObj.minFactorCount || 5,
        maxHoldHours: configObj.risk?.maxHoldHours || configObj.maxHoldHours || 48,
        cooldownMinutes: configObj.risk?.cooldownMinutes || configObj.cooldownMinutes || 60,
        trailingStopEnabled: configObj.exit?.trailingStopEnabled ?? configObj.trailingStopEnabled ?? true,
        breakEvenEnabled: configObj.exit?.breakEvenEnabled ?? configObj.breakEvenEnabled ?? true,
        partialTPEnabled: configObj.exit?.partialTPEnabled ?? configObj.partialTPEnabled ?? true,
        sessions: configObj.filters?.sessions || configObj.sessions || {},
        instruments: configObj.filters?.instruments || configObj.instruments || [],
      };

      // Step 5: Compute all metrics
      const dailyMetrics = computePerformanceMetrics(dailyTrades);
      const weeklyMetrics = computePerformanceMetrics(botTrades);
      const factorMetrics = computeFactorMetrics(botTrades, botReasonings);
      const breakdowns = computeDimensionalBreakdowns(botTrades);
      const slAnalysis = computeSLAnalysis(botTrades);

      // Step 6: Build prompt and call LLM
      const userPrompt = buildUserPrompt(
        botId, botName, account.balance, account.peak_balance,
        dailyMetrics, weeklyMetrics, factorMetrics, breakdowns,
        slAnalysis, botConfig, reviewType
      );

      console.log(`[Bot Review] Calling LLM for ${botName}...`);
      const diagnosis = await callLLM(SYSTEM_PROMPT, userPrompt);

      if (!diagnosis) {
        console.error(`[Bot Review] LLM call failed for ${botName}`);
        results.push({ botId, userId, status: "llm_failed" });
        continue;
      }

      console.log(`[Bot Review] ${botName}: ${diagnosis.overall_assessment} — ${diagnosis.recommendations?.length || 0} recommendations`);

      // Step 7: Store recommendation in database
      const { error: insertErr } = await supabase
        .from("bot_recommendations")
        .insert({
          user_id: userId,
          bot_id: botId,
          review_type: reviewType,
          performance_summary: {
            daily: dailyMetrics,
            weekly: weeklyMetrics,
            factorMetrics: factorMetrics.slice(0, 20), // Top 20 factors
            breakdowns: {
              bySession: breakdowns.bySession,
              bySymbol: breakdowns.bySymbol,
              byDirection: breakdowns.byDirection,
              byCloseReason: breakdowns.byCloseReason,
            },
            slAnalysis,
            balance: account.balance,
            peakBalance: account.peak_balance,
          },
          diagnosis: diagnosis.diagnosis,
          recommendations: diagnosis.recommendations || [],
          feature_gaps: diagnosis.feature_gaps || [],
          status: "pending",
          overall_assessment: diagnosis.overall_assessment,
          llm_model: "gemini-2.5-flash",
        });

      if (insertErr) {
        console.error(`Failed to store recommendation for ${botName}:`, insertErr);
      }

      // Step 8: Send Telegram notification
      if (diagnosis.overall_assessment !== "insufficient_data") {
        await sendTelegramNotification(
          supabase, userId, diagnosis, botId, botName,
          account.balance, dailyMetrics
        );
      }

      results.push({
        botId,
        userId,
        status: `${diagnosis.overall_assessment} — ${diagnosis.recommendations?.length || 0} recommendations`,
      });
    }

    console.log(`[Bot Review] Completed. Results:`, results);

    return new Response(JSON.stringify({ status: "completed", results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[Bot Review] Fatal error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
