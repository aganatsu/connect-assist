// ============================================================
// Unified Advisor Core — Shared Math, Data Loading, LLM Wrapper
// Used by the unified advisor edge function (advisor/index.ts)
// ============================================================
import { mapNestedToFlat, type RuntimeConfig } from "./configMapper.ts";
import { DEFAULT_FACTOR_WEIGHTS } from "./confluenceScoring.ts";
import {
  computeGatePerformance,
  formatGatePerformancePrompt,
  type ResolvedRejection,
  type ClosedTrade,
} from "./gatePerformanceEngine.ts";

// ─── Types ──────────────────────────────────────────────────
export type AdvisorMode = "on_demand" | "daily" | "weekly";

export interface TradeRecord {
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

export interface TradeReasoning {
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

export interface FactorLift {
  factorKey: string;
  group: string;
  currentWeight: number;
  presentCount: number;
  absentCount: number;
  presentWinRate: number;
  absentWinRate: number;
  presentAvgPnl: number;
  absentAvgPnl: number;
  /** $ lift = avg PnL when present - avg PnL when absent */
  dollarLift: number;
  /** Suggested weight based on $-lift analysis */
  suggestedWeight: number;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface SymbolStats {
  symbol: string;
  tradeCount: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgHoldHours: number;
  rejectedCount: number;
  rejectedWouldHaveWon: number;
  bestSession: string | null;
  worstSession: string | null;
}

export interface RegimeAnalysis {
  currentRegime: "strong_trend" | "mild_trend" | "transitional" | "mild_range" | "choppy_range" | "unknown";
  regimeConfidence: number;
  regimeIndicators: string[];
  regimeImpact: string;
  directionalBias?: string;
}

export interface PerformanceMetrics {
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxConsecutiveLosses: number;
  avgHoldHours: number;
  expectancy: number;
  sharpeApprox: number;
  byCloseReason: Record<string, { count: number; pnl: number }>;
  bySession: Record<string, { count: number; winRate: number; pnl: number }>;
  byDirection: Record<string, { count: number; winRate: number; pnl: number }>;
}

export interface AdvisorContext {
  mode: AdvisorMode;
  userId: string;
  botId: string;
  botName: string;
  config: RuntimeConfig;
  configRaw: Record<string, unknown>;
  trades: TradeRecord[];
  reasonings: TradeReasoning[];
  rejections: ResolvedRejection[];
  pastRecommendations: Array<{ id: string; created_at: string; status: string; overall_assessment: string; recommendations: unknown[]; resolved_at: string | null }>;
  balance: number;
  peakBalance: number;
  windowDays: number;
}

export interface Recommendation {
  category: string;
  title: string;
  description: string;
  current_value: Record<string, unknown>;
  suggested_value: Record<string, unknown>;
  confidence: "high" | "medium" | "low";
  evidence: string;
  risk_level: "low" | "medium" | "high";
}

export interface AdvisorResult {
  overall_assessment: string;
  diagnosis: string;
  recommendations: Recommendation[];
  feature_gaps: string[];
  performance: PerformanceMetrics;
  factorLift: FactorLift[];
  symbolStats: SymbolStats[];
  regime: RegimeAnalysis;
  llmModel: string;
  promptTokens: number;
  completionTokens: number;
}

// ─── CORRECTED Regime Presets (fixed factor key names) ──────
const REGIME_PRESETS: Record<string, { description: string; factorWeightOverrides: Record<string, number>; configOverrides: Record<string, unknown> }> = {
  strong_trend: {
    description: "Strong trending market — favor trend-following factors, widen TP targets",
    factorWeightOverrides: {
      marketStructure: 2.5,
      dailyBias: 2.0,
      displacement: 1.5,
      premiumDiscountFib: 1.0,
      orderBlock: 1.5,
      fairValueGap: 1.5,
      breakerBlock: 0.5,
      sessionQuality: 1.0,
      amdPhase: 1.0,
    },
    configOverrides: {
      tpRatio: 4.0,
      trailingStopEnabled: true,
    },
  },
  mild_trend: {
    description: "Mild trending market — standard weights, slightly favor trend factors",
    factorWeightOverrides: {
      marketStructure: 2.2,
      dailyBias: 1.5,
      displacement: 1.2,
    },
    configOverrides: {
      tpRatio: 3.5,
    },
  },
  choppy_range: {
    description: "Choppy/ranging market — reduce trend-following, tighten SL, favor reversal setups",
    factorWeightOverrides: {
      marketStructure: 0.8,
      dailyBias: 0.5,
      premiumDiscountFib: 2.0,
      orderBlock: 1.8,
      breakerBlock: 1.5,
      fairValueGap: 0.8,
      displacement: 0.5,
      sessionQuality: 1.5,
      amdPhase: 1.5,
    },
    configOverrides: {
      tpRatio: 2.0,
      slATRMultiple: 1.5,
      riskPerTrade: 0.75,
    },
  },
  mild_range: {
    description: "Mild ranging market — slightly reduce trend factors, tighten risk",
    factorWeightOverrides: {
      marketStructure: 1.5,
      dailyBias: 0.8,
      premiumDiscountFib: 1.8,
      breakerBlock: 1.3,
    },
    configOverrides: {
      tpRatio: 2.5,
      riskPerTrade: 0.85,
    },
  },
  transitional: {
    description: "Market transitioning — reduce position sizes, wait for clarity",
    factorWeightOverrides: {},
    configOverrides: {
      riskPerTrade: 0.5,
      maxConcurrent: 2,
    },
  },
};

// ─── Utility ────────────────────────────────────────────────
function toSafeNumber(v: unknown): number {
  if (typeof v === "number" && !isNaN(v)) return v;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

export function normalizeTradeRecord(raw: Record<string, unknown>): TradeRecord {
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

// ─── Performance Metrics ────────────────────────────────────
export function computePerformance(trades: TradeRecord[]): PerformanceMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0, winRate: 0, totalPnl: 0, avgPnl: 0,
      avgWin: 0, avgLoss: 0, profitFactor: 0, maxConsecutiveLosses: 0,
      avgHoldHours: 0, expectancy: 0, sharpeApprox: 0,
      byCloseReason: {}, bySession: {}, byDirection: {},
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // Max consecutive losses
  let maxConsec = 0, curConsec = 0;
  const sorted = [...trades].sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime());
  for (const t of sorted) {
    if (t.pnl <= 0) { curConsec++; maxConsec = Math.max(maxConsec, curConsec); }
    else curConsec = 0;
  }

  // Hold time
  const holdHours = trades.map(t => {
    const open = new Date(t.opened_at).getTime();
    const close = new Date(t.closed_at).getTime();
    return Math.max(0, (close - open) / (1000 * 60 * 60));
  });
  const avgHoldHours = holdHours.reduce((s, v) => s + v, 0) / holdHours.length;

  // Sharpe approximation (daily returns)
  const pnls = sorted.map(t => t.pnl);
  const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
  const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length;
  const stdDev = Math.sqrt(variance);
  const sharpeApprox = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252 / Math.max(1, trades.length)) : 0;

  // Breakdowns
  const byCloseReason: Record<string, { count: number; pnl: number }> = {};
  const bySession: Record<string, { count: number; winRate: number; pnl: number; wins: number }> = {};
  const byDirection: Record<string, { count: number; winRate: number; pnl: number; wins: number }> = {};

  for (const t of trades) {
    // Close reason
    const reason = t.close_reason || "unknown";
    if (!byCloseReason[reason]) byCloseReason[reason] = { count: 0, pnl: 0 };
    byCloseReason[reason].count++;
    byCloseReason[reason].pnl += t.pnl;

    // Session (from hour of entry)
    const hour = new Date(t.opened_at).getUTCHours();
    const session = hour >= 0 && hour < 8 ? "Asian" : hour >= 8 && hour < 13 ? "London" : hour >= 13 && hour < 17 ? "NY" : "Late";
    if (!bySession[session]) bySession[session] = { count: 0, winRate: 0, pnl: 0, wins: 0 };
    bySession[session].count++;
    bySession[session].pnl += t.pnl;
    if (t.pnl > 0) bySession[session].wins++;

    // Direction
    const dir = (t.direction || "unknown").toLowerCase();
    if (!byDirection[dir]) byDirection[dir] = { count: 0, winRate: 0, pnl: 0, wins: 0 };
    byDirection[dir].count++;
    byDirection[dir].pnl += t.pnl;
    if (t.pnl > 0) byDirection[dir].wins++;
  }

  // Compute win rates for breakdowns
  for (const s of Object.values(bySession)) s.winRate = s.count > 0 ? (s.wins / s.count) * 100 : 0;
  for (const d of Object.values(byDirection)) d.winRate = d.count > 0 ? (d.wins / d.count) * 100 : 0;

  return {
    totalTrades: trades.length,
    winRate: (wins.length / trades.length) * 100,
    totalPnl,
    avgPnl: totalPnl / trades.length,
    avgWin: wins.length > 0 ? grossWin / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxConsecutiveLosses: maxConsec,
    avgHoldHours,
    expectancy: mean,
    sharpeApprox,
    byCloseReason,
    bySession: Object.fromEntries(Object.entries(bySession).map(([k, v]) => [k, { count: v.count, winRate: v.winRate, pnl: v.pnl }])),
    byDirection: Object.fromEntries(Object.entries(byDirection).map(([k, v]) => [k, { count: v.count, winRate: v.winRate, pnl: v.pnl }])),
  };
}

// ─── $-Weighted Factor Lift ─────────────────────────────────
export function computeFactorLift(
  trades: TradeRecord[],
  reasonings: TradeReasoning[],
  currentFactorWeights: Record<string, number> = DEFAULT_FACTOR_WEIGHTS,
): FactorLift[] {
  // Match trades to their closest reasoning (within 5 min)
  const tradeReasoningMap = new Map<string, TradeReasoning>();
  for (const trade of trades) {
    let bestMatch: TradeReasoning | null = null;
    let bestTimeDiff = Infinity;
    for (const r of reasonings) {
      if (r.symbol !== trade.symbol) continue;
      if (r.direction?.toLowerCase() !== trade.direction?.toLowerCase()) continue;
      const timeDiff = Math.abs(new Date(trade.opened_at).getTime() - new Date(r.created_at).getTime());
      if (timeDiff < bestTimeDiff && timeDiff < 300_000) {
        bestTimeDiff = timeDiff;
        bestMatch = r;
      }
    }
    if (bestMatch) tradeReasoningMap.set(trade.id, bestMatch);
  }

  // Collect all factor names with their groups
  const factorMeta = new Map<string, { group: string }>();
  for (const r of reasonings) {
    if (!r.factors_json) continue;
    for (const f of r.factors_json) {
      if (!factorMeta.has(f.name)) {
        factorMeta.set(f.name, { group: f.group || "Unknown" });
      }
    }
  }

  const results: FactorLift[] = [];

  for (const [factorKey, meta] of factorMeta) {
    let presentWins = 0, presentLosses = 0;
    let presentPnlSum = 0, absentPnlSum = 0;
    let absentWins = 0, absentLosses = 0;

    for (const trade of trades) {
      const reasoning = tradeReasoningMap.get(trade.id);
      if (!reasoning?.factors_json) continue;

      const factor = reasoning.factors_json.find(f => f.name === factorKey);
      const isPresent = factor?.present === true;

      if (isPresent) {
        presentPnlSum += trade.pnl;
        if (trade.pnl > 0) presentWins++;
        else presentLosses++;
      } else {
        absentPnlSum += trade.pnl;
        if (trade.pnl > 0) absentWins++;
        else absentLosses++;
      }
    }

    const presentCount = presentWins + presentLosses;
    const absentCount = absentWins + absentLosses;

    // Need minimum 5 present samples for any suggestion
    if (presentCount < 5) continue;

    const presentWinRate = (presentWins / presentCount) * 100;
    const absentWinRate = absentCount > 0 ? (absentWins / absentCount) * 100 : 50;
    const presentAvgPnl = presentPnlSum / presentCount;
    const absentAvgPnl = absentCount > 0 ? absentPnlSum / absentCount : 0;
    const dollarLift = presentAvgPnl - absentAvgPnl;

    const currentWeight = currentFactorWeights[factorKey] ?? 1.0;
    const confidence: "high" | "medium" | "low" = presentCount >= 20 ? "high" : presentCount >= 10 ? "medium" : "low";

    // Compute suggested weight based on $-lift
    let suggestedWeight = currentWeight;
    let reason = "";

    if (dollarLift > 0 && presentWinRate > 60 && presentWinRate > absentWinRate + 10) {
      // Strong positive lift — increase weight
      const multiplier = Math.min(1.0 + (dollarLift / Math.max(Math.abs(absentAvgPnl), 1)) * 0.3, 1.5);
      suggestedWeight = Math.min(currentWeight * multiplier, 3.0);
      reason = `Strong $-lift: +$${dollarLift.toFixed(2)}/trade when present. Win rate ${presentWinRate.toFixed(0)}% vs ${absentWinRate.toFixed(0)}% absent.`;
    } else if (dollarLift < 0 && presentWinRate < 40) {
      // Negative lift — decrease weight
      suggestedWeight = Math.max(currentWeight * 0.5, 0.25);
      reason = `Negative $-lift: $${dollarLift.toFixed(2)}/trade when present. Only ${presentWinRate.toFixed(0)}% win rate (${presentCount} trades).`;
    } else if (Math.abs(dollarLift) < 0.5 && Math.abs(presentWinRate - absentWinRate) < 5) {
      // No edge — reduce slightly
      suggestedWeight = Math.max(currentWeight * 0.75, 0.25);
      reason = `No measurable edge: $-lift $${dollarLift.toFixed(2)}, win rates nearly equal (${presentWinRate.toFixed(0)}% vs ${absentWinRate.toFixed(0)}%).`;
    } else {
      // Moderate — keep
      reason = `Moderate performance: $-lift $${dollarLift.toFixed(2)}, ${presentWinRate.toFixed(0)}% win rate. Current weight adequate.`;
    }

    // Round to 0.25 increments
    suggestedWeight = Math.round(suggestedWeight * 4) / 4;

    results.push({
      factorKey,
      group: meta.group,
      currentWeight,
      presentCount,
      absentCount,
      presentWinRate,
      absentWinRate,
      presentAvgPnl,
      absentAvgPnl,
      dollarLift,
      suggestedWeight,
      confidence,
      reason,
    });
  }

  // Sort by absolute dollar lift descending
  return results.sort((a, b) => Math.abs(b.dollarLift) - Math.abs(a.dollarLift));
}

// ─── Symbol Stats ───────────────────────────────────────────
export function computeSymbolStats(
  trades: TradeRecord[],
  rejections: ResolvedRejection[],
): SymbolStats[] {
  const symbolMap = new Map<string, { trades: TradeRecord[]; rejections: ResolvedRejection[] }>();

  for (const t of trades) {
    if (!symbolMap.has(t.symbol)) symbolMap.set(t.symbol, { trades: [], rejections: [] });
    symbolMap.get(t.symbol)!.trades.push(t);
  }
  for (const r of rejections) {
    if (!symbolMap.has(r.symbol)) symbolMap.set(r.symbol, { trades: [], rejections: [] });
    symbolMap.get(r.symbol)!.rejections.push(r);
  }

  const results: SymbolStats[] = [];
  for (const [symbol, data] of symbolMap) {
    const { trades: symTrades, rejections: symRej } = data;
    const wins = symTrades.filter(t => t.pnl > 0);
    const totalPnl = symTrades.reduce((s, t) => s + t.pnl, 0);

    // Session breakdown for this symbol
    const sessionPnl: Record<string, number> = {};
    for (const t of symTrades) {
      const hour = new Date(t.opened_at).getUTCHours();
      const session = hour >= 0 && hour < 8 ? "Asian" : hour >= 8 && hour < 13 ? "London" : hour >= 13 && hour < 17 ? "NY" : "Late";
      sessionPnl[session] = (sessionPnl[session] || 0) + t.pnl;
    }

    const sessions = Object.entries(sessionPnl);
    const bestSession = sessions.length > 0 ? sessions.sort((a, b) => b[1] - a[1])[0][0] : null;
    const worstSession = sessions.length > 0 ? sessions.sort((a, b) => a[1] - b[1])[0][0] : null;

    // Hold time
    const holdHours = symTrades.map(t => {
      const open = new Date(t.opened_at).getTime();
      const close = new Date(t.closed_at).getTime();
      return Math.max(0, (close - open) / (1000 * 60 * 60));
    });

    results.push({
      symbol,
      tradeCount: symTrades.length,
      winRate: symTrades.length > 0 ? (wins.length / symTrades.length) * 100 : 0,
      totalPnl,
      avgPnl: symTrades.length > 0 ? totalPnl / symTrades.length : 0,
      avgHoldHours: holdHours.length > 0 ? holdHours.reduce((s, v) => s + v, 0) / holdHours.length : 0,
      rejectedCount: symRej.length,
      rejectedWouldHaveWon: symRej.filter(r => r.outcome_status === "would_have_won").length,
      bestSession,
      worstSession,
    });
  }

  return results.sort((a, b) => b.totalPnl - a.totalPnl);
}

// ─── Trade-Based Regime Detection ───────────────────────────
export function detectRegimeFromTrades(trades: TradeRecord[]): RegimeAnalysis {
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
  let regimeScore = 0;

  // 1. Direction consistency
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

  // 2. Hold time analysis
  const holdTimes = sorted.map(t => {
    const open = new Date(t.opened_at).getTime();
    const close = new Date(t.closed_at).getTime();
    return (close - open) / (1000 * 60 * 60);
  });
  const avgHoldTime = holdTimes.reduce((s, v) => s + v, 0) / holdTimes.length;
  if (avgHoldTime > 12) {
    regimeScore += 1;
    indicators.push(`Long avg hold time (${avgHoldTime.toFixed(1)}h) — consistent with trending market`);
  } else if (avgHoldTime < 4) {
    regimeScore -= 1;
    indicators.push(`Short avg hold time (${avgHoldTime.toFixed(1)}h) — consistent with ranging/choppy market`);
  }

  // 3. SL hit rate
  const slHits = trades.filter(t => t.close_reason === "sl_hit" || t.close_reason === "stop_loss").length;
  const slRate = slHits / trades.length;
  if (slRate > 0.6) {
    regimeScore -= 2;
    indicators.push(`High SL hit rate (${(slRate * 100).toFixed(0)}%) — suggests choppy/ranging conditions`);
  } else if (slRate < 0.3) {
    regimeScore += 1;
    indicators.push(`Low SL hit rate (${(slRate * 100).toFixed(0)}%) — price following through on entries`);
  }

  // 4. Consecutive loss streaks
  let maxConsec = 0, currentConsec = 0;
  for (const t of sorted) {
    if (t.pnl <= 0) { currentConsec++; maxConsec = Math.max(maxConsec, currentConsec); }
    else currentConsec = 0;
  }
  if (maxConsec >= 5) {
    indicators.push(`Long losing streak (${maxConsec} consecutive) — possible regime change`);
  }

  // 5. P&L trend (first half vs second half)
  const halfPoint = Math.floor(sorted.length / 2);
  const firstHalfPnl = sorted.slice(0, halfPoint).reduce((s, t) => s + t.pnl, 0);
  const secondHalfPnl = sorted.slice(halfPoint).reduce((s, t) => s + t.pnl, 0);
  if (secondHalfPnl < firstHalfPnl * 0.5 && firstHalfPnl > 0) {
    indicators.push(`Performance deteriorating: first half P&L $${firstHalfPnl.toFixed(2)} vs second half $${secondHalfPnl.toFixed(2)}`);
  }

  // Determine regime
  let currentRegime: RegimeAnalysis["currentRegime"];
  let regimeConfidence: number;
  if (regimeScore >= 3) { currentRegime = "strong_trend"; regimeConfidence = Math.min(regimeScore / 5, 1); }
  else if (regimeScore >= 1) { currentRegime = "mild_trend"; regimeConfidence = 0.5 + regimeScore * 0.1; }
  else if (regimeScore <= -3) { currentRegime = "choppy_range"; regimeConfidence = Math.min(Math.abs(regimeScore) / 5, 1); }
  else if (regimeScore <= -1) { currentRegime = "mild_range"; regimeConfidence = 0.5 + Math.abs(regimeScore) * 0.1; }
  else { currentRegime = "transitional"; regimeConfidence = 0.3; }

  // Impact assessment
  let regimeImpact: string;
  if (currentRegime.includes("range") || currentRegime === "choppy_range") {
    regimeImpact = "SMC trend-following factors may underperform. Consider tightening SL, reducing size, or pausing.";
  } else if (currentRegime.includes("trend")) {
    regimeImpact = "Trending conditions favor SMC strategy. Consider widening TP targets and letting winners run.";
  } else {
    regimeImpact = "Market transitioning — reduce position sizes until direction clarifies.";
  }

  return { currentRegime, regimeConfidence, regimeIndicators: indicators, regimeImpact, directionalBias: buys > sells ? "bullish" : sells > buys ? "bearish" : "neutral" };
}

// ─── Regime Recommendations (using CORRECTED presets) ───────
export function buildRegimeRecommendations(
  regime: RegimeAnalysis,
  currentFactorWeights: Record<string, number>,
  currentConfig: Record<string, unknown>,
): Recommendation[] {
  const preset = REGIME_PRESETS[regime.currentRegime];
  if (!preset || regime.currentRegime === "unknown" || regime.regimeConfidence < 0.4) return [];

  const recs: Recommendation[] = [];

  // Factor weight adjustments
  if (Object.keys(preset.factorWeightOverrides).length > 0) {
    const currentWeights: Record<string, unknown> = {};
    const suggestedWeights: Record<string, number> = {};

    for (const [key, suggested] of Object.entries(preset.factorWeightOverrides)) {
      const current = currentFactorWeights[key] ?? DEFAULT_FACTOR_WEIGHTS[key] ?? "default";
      if (current !== suggested) {
        currentWeights[key] = current;
        suggestedWeights[key] = suggested;
      }
    }

    if (Object.keys(suggestedWeights).length > 0) {
      recs.push({
        category: "regime_adaptation",
        title: `Regime Shift: Adjust Factor Weights for ${regime.currentRegime.replace(/_/g, " ")} Market`,
        description: `${preset.description}. Detected with ${(regime.regimeConfidence * 100).toFixed(0)}% confidence. ${regime.regimeIndicators.slice(0, 2).join(". ")}.`,
        current_value: currentWeights,
        suggested_value: suggestedWeights,
        confidence: regime.regimeConfidence >= 0.7 ? "high" : "medium",
        evidence: regime.regimeIndicators.join("; "),
        risk_level: regime.regimeConfidence >= 0.7 ? "low" : "medium",
      });
    }
  }

  // Config overrides
  if (Object.keys(preset.configOverrides).length > 0) {
    const currentVals: Record<string, unknown> = {};
    const suggestedVals: Record<string, unknown> = {};

    for (const [key, suggested] of Object.entries(preset.configOverrides)) {
      const current = currentConfig[key as keyof typeof currentConfig] ?? "default";
      if (current !== suggested) {
        currentVals[key] = current;
        suggestedVals[key] = suggested;
      }
    }

    if (Object.keys(suggestedVals).length > 0) {
      recs.push({
        category: "regime_adaptation",
        title: `Regime Shift: Adjust Risk/Exit Settings for ${regime.currentRegime.replace(/_/g, " ")} Market`,
        description: `${preset.description}. Adjusting risk and exit parameters to match current market conditions.`,
        current_value: currentVals,
        suggested_value: suggestedVals,
        confidence: regime.regimeConfidence >= 0.7 ? "high" : "medium",
        evidence: regime.regimeIndicators.join("; "),
        risk_level: "medium",
      });
    }
  }

  return recs;
}

// ─── Build Prompt Payload (compact JSON, not markdown) ──────
export function buildPromptPayload(ctx: AdvisorContext, perf: PerformanceMetrics, factorLift: FactorLift[], symbolStats: SymbolStats[], regime: RegimeAnalysis, gateReport: string): Record<string, unknown> {
  return {
    mode: ctx.mode,
    account: {
      balance: ctx.balance,
      peakBalance: ctx.peakBalance,
      drawdown: ctx.peakBalance > 0 ? ((ctx.peakBalance - ctx.balance) / ctx.peakBalance * 100).toFixed(1) + "%" : "0%",
    },
    performance: {
      totalTrades: perf.totalTrades,
      winRate: `${perf.winRate.toFixed(1)}%`,
      totalPnl: `$${perf.totalPnl.toFixed(2)}`,
      avgPnl: `$${perf.avgPnl.toFixed(2)}`,
      profitFactor: perf.profitFactor === Infinity ? "∞" : perf.profitFactor.toFixed(2),
      maxConsecutiveLosses: perf.maxConsecutiveLosses,
      avgHoldHours: `${perf.avgHoldHours.toFixed(1)}h`,
      expectancy: `$${perf.expectancy.toFixed(2)}`,
      sharpe: perf.sharpeApprox.toFixed(2),
    },
    breakdowns: {
      bySession: perf.bySession,
      byDirection: perf.byDirection,
      byCloseReason: perf.byCloseReason,
    },
    topFactors: factorLift.slice(0, 12).map(f => ({
      factor: f.factorKey,
      dollarLift: `$${f.dollarLift.toFixed(2)}`,
      winRatePresent: `${f.presentWinRate.toFixed(0)}%`,
      winRateAbsent: `${f.absentWinRate.toFixed(0)}%`,
      currentWeight: f.currentWeight,
      suggestedWeight: f.suggestedWeight,
      confidence: f.confidence,
      sampleSize: f.presentCount,
    })),
    symbolStats: symbolStats.slice(0, 10).map(s => ({
      symbol: s.symbol,
      trades: s.tradeCount,
      winRate: `${s.winRate.toFixed(0)}%`,
      pnl: `$${s.totalPnl.toFixed(2)}`,
      avgHold: `${s.avgHoldHours.toFixed(1)}h`,
      rejectedWouldWin: s.rejectedWouldHaveWon,
    })),
    regime: {
      current: regime.currentRegime,
      confidence: `${(regime.regimeConfidence * 100).toFixed(0)}%`,
      indicators: regime.regimeIndicators.slice(0, 4),
      impact: regime.regimeImpact,
    },
    gatePerformance: gateReport || "No gate performance data available",
    currentConfig: {
      slMethod: ctx.config.slMethod,
      slATRMultiple: ctx.config.slATRMultiple,
      tpRatio: ctx.config.tpRatio,
      riskPerTrade: ctx.config.riskPerTrade,
      maxConcurrent: ctx.config.maxConcurrent,
      confluenceThreshold: ctx.config.confluenceThreshold,
      trailingStopEnabled: ctx.config.trailingStopEnabled,
      breakEvenEnabled: ctx.config.breakEvenEnabled,
    },
    pastRecommendations: ctx.pastRecommendations.slice(0, 5).map(r => ({
      date: r.created_at?.slice(0, 10),
      status: r.status,
      assessment: r.overall_assessment?.slice(0, 100),
    })),
    windowDays: ctx.windowDays,
  };
}

// ─── System Prompts ─────────────────────────────────────────
const VALID_CATEGORIES = [
  "stop_loss", "take_profit", "factor_weights", "session_filter",
  "instrument_filter", "risk_management", "protection", "exit_management",
  "entry_refinement", "strategy", "timing", "regime_adaptation", "general",
];

const VALID_FACTOR_KEYS = Object.keys(DEFAULT_FACTOR_WEIGHTS).join(", ");

function getSystemPrompt(mode: AdvisorMode): string {
  const base = `You are an expert SMC (Smart Money Concepts) trading strategy advisor for an automated forex/crypto trading bot.

CRITICAL RULES:
1. You MUST respond with valid JSON matching the schema below.
2. All factor_weights recommendations MUST use these exact camelCase keys: ${VALID_FACTOR_KEYS}
3. All recommendation categories MUST be one of: ${VALID_CATEGORIES.join(", ")}
4. Never hallucinate numbers — only reference data provided in the payload.
5. Be specific and actionable. "Consider adjusting" is not actionable. "Reduce orderBlock weight from 2.0 to 1.25" is.
6. Risk assessment must be honest — if a change could hurt performance, say so.
7. current_value and suggested_value MUST use the exact config key names the bot uses (camelCase).

RESPONSE SCHEMA:
{
  "overall_assessment": "1-2 sentence summary of bot health and priority action",
  "diagnosis": "2-4 paragraph analysis of what's working, what's not, and why",
  "recommendations": [
    {
      "category": "<valid_category>",
      "title": "Short actionable title",
      "description": "Why this change helps, with evidence from the data",
      "current_value": { "<config_key>": <current> },
      "suggested_value": { "<config_key>": <suggested> },
      "confidence": "high|medium|low",
      "evidence": "Specific numbers from the data that support this",
      "risk_level": "low|medium|high"
    }
  ],
  "feature_gaps": ["List of missing capabilities that would improve performance"]
}`;

  if (mode === "on_demand") {
    return base + `\n\nMODE: On-demand analysis. Focus on the most impactful 3-5 recommendations. Be concise.`;
  } else if (mode === "daily") {
    return base + `\n\nMODE: Daily review (last 24-48h). Focus on:
- Immediate issues (SL too tight/wide, session timing problems)
- Quick wins that can be applied today
- Any concerning patterns in recent trades
Limit to 3-5 high-confidence recommendations.`;
  } else {
    return base + `\n\nMODE: Weekly deep review (last 28 days). Focus on:
- Week-over-week trend analysis
- Factor weight optimization based on $-lift data
- Regime adaptation recommendations
- Structural improvements (not just parameter tweaks)
- Review past recommendations and their apparent impact
Provide 5-8 comprehensive recommendations.`;
  }
}

// ─── LLM Wrapper ────────────────────────────────────────────
export interface LLMResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export async function callLLM(systemPrompt: string, userPrompt: string): Promise<LLMResult> {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const forgeApiUrl = Deno.env.get("FORGE_API_URL") || Deno.env.get("BUILT_IN_FORGE_API_URL");
  const forgeApiKey = Deno.env.get("FORGE_API_KEY") || Deno.env.get("BUILT_IN_FORGE_API_KEY");

  const useLovable = !!lovableKey;
  const url = useLovable
    ? "https://ai.gateway.lovable.dev/v1/chat/completions"
    : `${forgeApiUrl}/v1/chat/completions`;
  const apiKey = useLovable ? lovableKey : forgeApiKey;
  const model = useLovable ? "google/gemini-2.5-flash" : "gemini-2.5-flash";

  if (!apiKey) throw new Error("No LLM API key configured (LOVABLE_API_KEY or FORGE_API_KEY)");

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 6144,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM API error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const json = await resp.json();
  const choice = json.choices?.[0];
  if (!choice?.message?.content) throw new Error("LLM returned empty response");

  return {
    content: choice.message.content,
    model: json.model || model,
    promptTokens: json.usage?.prompt_tokens || 0,
    completionTokens: json.usage?.completion_tokens || 0,
  };
}

// ─── Notification Helper ────────────────────────────────────
export async function sendTelegramNotification(
  supabase: ReturnType<typeof import("https://esm.sh/@supabase/supabase-js@2").createClient>,
  userId: string,
  category: string,
  message: string,
): Promise<void> {
  const { data: userSettings } = await supabase
    .from("user_settings")
    .select("preferences_json")
    .eq("user_id", userId)
    .maybeSingle();

  const prefs = (userSettings?.preferences_json as Record<string, unknown>) || {};

  // Extract chat IDs
  const telegramChatIds: string[] = (() => {
    const list = Array.isArray(prefs.telegramChatIds) ? prefs.telegramChatIds : [];
    const ids = list.map((c: unknown) => typeof c === "string" ? c : String((c as Record<string, unknown>)?.id ?? "")).filter(Boolean);
    if (ids.length > 0) return ids;
    return prefs.telegramChatId ? [String(prefs.telegramChatId)] : [];
  })();

  if (telegramChatIds.length === 0) {
    console.log(`[advisor] No Telegram chat IDs for user ${userId}`);
    return;
  }

  // Check category toggle
  const notifyCategories = (prefs.telegramNotifyCategories as Record<string, boolean>) || {};
  if (notifyCategories[category] === false) {
    console.log(`[advisor] ${category} notifications disabled for user ${userId}`);
    return;
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  for (const chatId of telegramChatIds) {
    try {
      await fetch(`${supabaseUrl}/functions/v1/telegram-notify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ chat_id: chatId, message }),
      });
    } catch (err) {
      console.warn(`[advisor] Telegram notify failed for chat ${chatId}:`, err);
    }
  }
}

// ─── Main Pipeline ──────────────────────────────────────────
export async function runAdvisorPipeline(ctx: AdvisorContext): Promise<AdvisorResult> {
  // 1. Compute performance metrics
  const perf = computePerformance(ctx.trades);

  // 2. Compute $-weighted factor lift
  const currentFactorWeights: Record<string, number> = {};
  for (const key of Object.keys(DEFAULT_FACTOR_WEIGHTS)) {
    currentFactorWeights[key] = (ctx.config as Record<string, unknown>)[`fw_${key}`] as number ?? DEFAULT_FACTOR_WEIGHTS[key];
  }
  // Also check the factorWeights nested object in raw config
  const rawFW = (ctx.configRaw as Record<string, unknown>)?.factorWeights as Record<string, number> | undefined;
  if (rawFW) {
    for (const [k, v] of Object.entries(rawFW)) {
      if (typeof v === "number") currentFactorWeights[k] = v;
    }
  }

  const factorLift = computeFactorLift(ctx.trades, ctx.reasonings, currentFactorWeights);

  // 3. Compute symbol stats
  const symbolStats = computeSymbolStats(ctx.trades, ctx.rejections);

  // 4. Detect regime from trades
  const regime = detectRegimeFromTrades(ctx.trades);

  // 5. Gate performance (reuse existing engine)
  let gateReport = "";
  if (ctx.rejections.length > 0) {
    const closedTrades: ClosedTrade[] = ctx.trades.map(t => ({
      symbol: t.symbol,
      direction: t.direction as "buy" | "sell",
      pnl: t.pnl,
      opened_at: t.opened_at,
      closed_at: t.closed_at,
    }));
    const gatePerf = computeGatePerformance(ctx.rejections, closedTrades, { minSamples: 5 });
    gateReport = formatGatePerformancePrompt(gatePerf);
  }

  // 6. Build compact prompt payload
  const payload = buildPromptPayload(ctx, perf, factorLift, symbolStats, regime, gateReport);

  // 7. Call LLM
  const systemPrompt = getSystemPrompt(ctx.mode);
  const userPrompt = `Analyze this trading bot's performance and provide recommendations:\n\n${JSON.stringify(payload, null, 2)}`;
  const llmResult = await callLLM(systemPrompt, userPrompt);

  // 8. Parse LLM response
  let diagnosis: { overall_assessment: string; diagnosis: string; recommendations: Recommendation[]; feature_gaps: string[] };
  try {
    diagnosis = JSON.parse(llmResult.content);
  } catch {
    diagnosis = {
      overall_assessment: "LLM returned invalid JSON",
      diagnosis: llmResult.content,
      recommendations: [],
      feature_gaps: [],
    };
  }

  // 9. Merge regime recommendations (deterministic, not LLM-dependent)
  const regimeRecs = buildRegimeRecommendations(regime, currentFactorWeights, ctx.config as unknown as Record<string, unknown>);

  // 10. Merge factor lift recommendations (from deterministic analysis)
  const factorRecs: Recommendation[] = factorLift
    .filter(f => Math.abs(f.suggestedWeight - f.currentWeight) >= 0.25 && f.confidence !== "low")
    .slice(0, 8)
    .map(f => ({
      category: "factor_weights",
      title: `${f.factorKey}: ${f.currentWeight} → ${f.suggestedWeight}`,
      description: f.reason,
      current_value: { [f.factorKey]: f.currentWeight },
      suggested_value: { [f.factorKey]: f.suggestedWeight },
      confidence: f.confidence,
      evidence: `$-lift: $${f.dollarLift.toFixed(2)}/trade. Win rate present: ${f.presentWinRate.toFixed(0)}%, absent: ${f.absentWinRate.toFixed(0)}%. Sample: ${f.presentCount} trades.`,
      risk_level: f.confidence === "high" ? "low" : "medium",
    }));

  // Combine: LLM recs + deterministic factor recs + regime recs (deduped)
  const allRecs = [
    ...(diagnosis.recommendations || []),
    ...factorRecs.filter(fr => !diagnosis.recommendations?.some(lr => lr.title === fr.title)),
    ...regimeRecs,
  ];

  return {
    overall_assessment: diagnosis.overall_assessment || "",
    diagnosis: diagnosis.diagnosis || "",
    recommendations: allRecs,
    feature_gaps: diagnosis.feature_gaps || [],
    performance: perf,
    factorLift,
    symbolStats,
    regime,
    llmModel: llmResult.model,
    promptTokens: llmResult.promptTokens,
    completionTokens: llmResult.completionTokens,
  };
}
