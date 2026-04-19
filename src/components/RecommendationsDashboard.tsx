import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { botConfigApi } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp,
  TrendingUp, TrendingDown, Minus, AlertTriangle, Lightbulb,
  BarChart3, Shield, Target, Zap, Brain, ArrowRight,
} from "lucide-react";
import { applyRecommendationToConfig } from "@/lib/applyRecommendation";

// ─── Types ───────────────────────────────────────────────────

interface Recommendation {
  category: string;
  title: string;
  description: string;
  current_value?: Record<string, unknown>;
  suggested_value?: Record<string, unknown>;
  confidence: string;
  evidence: string;
  risk_level: string;
  status?: "pending" | "approved" | "dismissed"; // per-recommendation status
}

interface PerformanceSummary {
  weeklyData?: Array<{
    weekLabel: string;
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    profitFactor: number;
    maxConsecutiveLosses: number;
  }>;
  factorSuggestions?: Array<{
    factorName: string;
    group: string;
    currentWeight: number;
    suggestedWeight: number;
    winRateWhenPresent: number;
    winRateWhenAbsent: number;
    sampleSize: number;
    confidence: string;
    reason: string;
  }>;
  regimeAnalysis?: {
    currentRegime: string;
    regimeConfidence: number;
    regimeIndicators: string[];
    regimeImpact: string;
    instrumentRegimes?: Array<{
      symbol: string;
      regime: string;
      confidence: number;
      indicators: string[];
      atr14: number;
      atrTrend: string;
      directionalBias: string;
      rangePercent: number;
    }>;
  };
  balance?: number;
  peakBalance?: number;
  // Daily review fields
  totalTrades?: number;
  winRate?: number;
  totalPnl?: number;
  avgRR?: number;
  profitFactor?: number;
  maxConsecutiveLosses?: number;
}

interface BotRecommendation {
  id: string;
  user_id: string;
  bot_id: string;
  review_type: string;
  performance_summary: PerformanceSummary;
  diagnosis: string;
  recommendations: Recommendation[];
  feature_gaps: string[];
  status: string;
  overall_assessment: string;
  llm_model: string;
  created_at: string;
  resolved_at: string | null;
  applied_changes?: any;
  resolved_by?: string | null;
  impact_snapshot?: any;
  token_usage?: any;
}

// ─── Helpers ─────────────────────────────────────────────────

const assessmentConfig: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  winning: { color: "text-green-400", icon: <TrendingUp className="w-3.5 h-3.5" />, label: "WINNING" },
  losing: { color: "text-red-400", icon: <TrendingDown className="w-3.5 h-3.5" />, label: "LOSING" },
  breakeven: { color: "text-yellow-400", icon: <Minus className="w-3.5 h-3.5" />, label: "BREAKEVEN" },
  insufficient_data: { color: "text-muted-foreground", icon: <Clock className="w-3.5 h-3.5" />, label: "INSUFFICIENT DATA" },
};

const categoryIcons: Record<string, React.ReactNode> = {
  stop_loss: <Shield className="w-3.5 h-3.5" />,
  take_profit: <Target className="w-3.5 h-3.5" />,
  factor_weights: <BarChart3 className="w-3.5 h-3.5" />,
  session_filter: <Clock className="w-3.5 h-3.5" />,
  instrument_filter: <Zap className="w-3.5 h-3.5" />,
  risk_management: <Shield className="w-3.5 h-3.5" />,
  timing: <Clock className="w-3.5 h-3.5" />,
  regime_adaptation: <Brain className="w-3.5 h-3.5" />,
  general: <Lightbulb className="w-3.5 h-3.5" />,
};

const confidenceColors: Record<string, string> = {
  high: "bg-green-500/20 text-green-400 border-green-500/30",
  medium: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  low: "bg-muted text-muted-foreground border-border",
};

const riskColors: Record<string, string> = {
  low: "text-green-400",
  medium: "text-yellow-400",
  high: "text-red-400",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

// ─── Sub-Components ──────────────────────────────────────────

function RecommendationCard({
  rec,
  index,
  onApprove,
  onDismiss,
  onMarkDone,
  isPending,
  isAutoApplicable,
}: {
  rec: Recommendation;
  index: number;
  onApprove?: () => void;
  onDismiss?: () => void;
  onMarkDone?: () => void;
  isPending: boolean;
  isAutoApplicable: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border rounded-md p-2.5 space-y-1.5 bg-card/50 hover:bg-card/80 transition-colors">
      <div className="flex items-start gap-2">
        <span className="text-muted-foreground mt-0.5">
          {categoryIcons[rec.category] || <Lightbulb className="w-3.5 h-3.5" />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-semibold text-foreground">{rec.title}</span>
            <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 ${confidenceColors[rec.confidence] || ""}`}>
              {rec.confidence?.toUpperCase()}
            </Badge>
            {rec.risk_level && (
              <span className={`text-[9px] font-medium ${riskColors[rec.risk_level] || ""}`}>
                {rec.risk_level.toUpperCase()} RISK
              </span>
            )}
            {isPending && !isAutoApplicable && (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-amber-500/10 text-amber-400 border-amber-500/30">
                MANUAL
              </Badge>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
            {rec.description?.substring(0, expanded ? 1000 : 120)}
            {!expanded && rec.description?.length > 120 && "..."}
          </p>
        </div>
        <button onClick={() => setExpanded(!expanded)} className="text-muted-foreground hover:text-foreground">
          {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
      </div>

      {expanded && (
        <div className="pl-6 space-y-1.5">
          {/* Current → Suggested values */}
          {rec.current_value && rec.suggested_value && (
            <div className="flex items-center gap-2 text-[10px]">
              <span className="text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded">
                {JSON.stringify(rec.current_value)}
              </span>
              <ArrowRight className="w-3 h-3 text-muted-foreground" />
              <span className="text-primary font-mono bg-primary/10 px-1.5 py-0.5 rounded">
                {JSON.stringify(rec.suggested_value)}
              </span>
            </div>
          )}

          {/* Evidence */}
          {rec.evidence && (
            <p className="text-[10px] text-muted-foreground italic">
              Evidence: {rec.evidence}
            </p>
          )}

          {/* Manual-action notice */}
          {isPending && !isAutoApplicable && (
            <p className="text-[10px] text-amber-400/90 leading-relaxed border-l-2 border-amber-500/40 pl-2">
              💡 Manual action required — this recommendation can&apos;t be auto-applied.
              Apply the change yourself in the relevant config tab, then click <span className="font-semibold">Mark as done</span>.
            </p>
          )}

          {/* Action buttons */}
          {isPending && onDismiss && (
            <div className="flex gap-2 pt-1">
              {isAutoApplicable && onApprove && (
                <Button
                  size="sm"
                  variant="default"
                  className="h-6 text-[10px] px-3"
                  onClick={onApprove}
                >
                  <CheckCircle2 className="w-3 h-3 mr-1" /> Approve
                </Button>
              )}
              {!isAutoApplicable && onMarkDone && (
                <Button
                  size="sm"
                  variant="default"
                  className="h-6 text-[10px] px-3"
                  onClick={onMarkDone}
                >
                  <CheckCircle2 className="w-3 h-3 mr-1" /> Mark as done
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[10px] px-3"
                onClick={onDismiss}
              >
                <XCircle className="w-3 h-3 mr-1" /> Dismiss
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WeeklyPerformanceTable({ weeklyData }: { weeklyData: PerformanceSummary["weeklyData"] }) {
  if (!weeklyData || weeklyData.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px] font-mono">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="text-left py-1 px-1.5">Week</th>
            <th className="text-right py-1 px-1.5">Trades</th>
            <th className="text-right py-1 px-1.5">Win%</th>
            <th className="text-right py-1 px-1.5">P&L</th>
            <th className="text-right py-1 px-1.5">PF</th>
            <th className="text-right py-1 px-1.5">Max Loss Streak</th>
          </tr>
        </thead>
        <tbody>
          {weeklyData.map((w, i) => (
            <tr key={i} className="border-b border-border/50 hover:bg-muted/30">
              <td className="py-1 px-1.5 text-foreground">{w.weekLabel}</td>
              <td className="text-right py-1 px-1.5">{w.totalTrades}</td>
              <td className={`text-right py-1 px-1.5 ${w.winRate >= 50 ? "text-green-400" : "text-red-400"}`}>
                {w.winRate.toFixed(0)}%
              </td>
              <td className={`text-right py-1 px-1.5 ${w.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                ${w.totalPnl.toFixed(2)}
              </td>
              <td className="text-right py-1 px-1.5">{w.profitFactor === Infinity ? "∞" : w.profitFactor?.toFixed(2)}</td>
              <td className="text-right py-1 px-1.5">{w.maxConsecutiveLosses}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RegimeIndicator({ regime }: { regime: PerformanceSummary["regimeAnalysis"] }) {
  const [showInstruments, setShowInstruments] = React.useState(false);
  if (!regime) return null;

  const regimeLabels: Record<string, { label: string; color: string; bg: string }> = {
    strong_trend: { label: "Strong Trend", color: "text-green-400", bg: "bg-green-400/10" },
    mild_trend: { label: "Mild Trend", color: "text-blue-400", bg: "bg-blue-400/10" },
    transitional: { label: "Transitional", color: "text-yellow-400", bg: "bg-yellow-400/10" },
    mild_range: { label: "Mild Range", color: "text-orange-400", bg: "bg-orange-400/10" },
    choppy_range: { label: "Choppy Range", color: "text-red-400", bg: "bg-red-400/10" },
    unknown: { label: "Unknown", color: "text-muted-foreground", bg: "bg-muted/30" },
  };

  const config = regimeLabels[regime.currentRegime] || regimeLabels.unknown;
  const instrumentRegimes = regime.instrumentRegimes?.filter(ir => ir.regime !== "unknown") || [];
  const trendingCount = instrumentRegimes.filter(ir => ir.regime.includes("trend")).length;
  const rangingCount = instrumentRegimes.filter(ir => ir.regime.includes("range")).length;
  const otherCount = instrumentRegimes.length - trendingCount - rangingCount;

  return (
    <div className="border border-border rounded-md p-2 bg-card/50">
      <div className="flex items-center gap-2 mb-1">
        <Brain className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Market Regime</span>
      </div>
      <div className="flex items-center gap-2">
        <span className={`text-[12px] font-bold ${config.color}`}>{config.label}</span>
        <span className="text-[10px] text-muted-foreground">({(regime.regimeConfidence * 100).toFixed(0)}% confidence)</span>
      </div>
      <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{regime.regimeImpact}</p>

      {/* Per-instrument summary badges */}
      {instrumentRegimes.length > 0 && (
        <div className="mt-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {trendingCount > 0 && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-400/10 text-green-400 font-medium">
                {trendingCount} Trending
              </span>
            )}
            {rangingCount > 0 && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-400/10 text-red-400 font-medium">
                {rangingCount} Ranging
              </span>
            )}
            {otherCount > 0 && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-yellow-400/10 text-yellow-400 font-medium">
                {otherCount} Transitional
              </span>
            )}
            <button
              onClick={() => setShowInstruments(!showInstruments)}
              className="text-[9px] text-primary hover:underline ml-1"
            >
              {showInstruments ? "Hide" : "Show"} breakdown
            </button>
          </div>

          {/* Collapsible per-instrument table */}
          {showInstruments && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[10px] font-mono">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left py-1 px-1">Instrument</th>
                    <th className="text-left py-1 px-1">Regime</th>
                    <th className="text-left py-1 px-1">Bias</th>
                    <th className="text-right py-1 px-1">ATR Trend</th>
                    <th className="text-right py-1 px-1">Range%</th>
                    <th className="text-right py-1 px-1">Conf</th>
                  </tr>
                </thead>
                <tbody>
                  {instrumentRegimes
                    .sort((a, b) => b.confidence - a.confidence)
                    .map((ir, i) => {
                      const irConfig = regimeLabels[ir.regime] || regimeLabels.unknown;
                      return (
                        <tr key={i} className="border-b border-border/50 hover:bg-muted/30">
                          <td className="py-1 px-1 text-foreground font-medium">{ir.symbol}</td>
                          <td className="py-1 px-1">
                            <span className={`${irConfig.color} font-medium`}>
                              {irConfig.label}
                            </span>
                          </td>
                          <td className="py-1 px-1">
                            <span className={ir.directionalBias === "bullish" ? "text-green-400" : ir.directionalBias === "bearish" ? "text-red-400" : "text-muted-foreground"}>
                              {ir.directionalBias}
                            </span>
                          </td>
                          <td className="text-right py-1 px-1">
                            <span className={ir.atrTrend === "expanding" ? "text-yellow-400" : ir.atrTrend === "contracting" ? "text-blue-400" : "text-muted-foreground"}>
                              {ir.atrTrend}
                            </span>
                          </td>
                          <td className="text-right py-1 px-1">{ir.rangePercent?.toFixed(1)}%</td>
                          <td className="text-right py-1 px-1">{(ir.confidence * 100).toFixed(0)}%</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {regime.regimeIndicators?.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {regime.regimeIndicators.map((ind, i) => (
            <p key={i} className="text-[9px] text-muted-foreground pl-2 border-l border-border">
              {ind}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function FactorSuggestionsTable({ suggestions }: { suggestions: PerformanceSummary["factorSuggestions"] }) {
  if (!suggestions || suggestions.length === 0) return null;

  return (
    <div className="border border-border rounded-md p-2 bg-card/50">
      <div className="flex items-center gap-2 mb-1.5">
        <BarChart3 className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Factor Analysis</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] font-mono">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th className="text-left py-1 px-1">Factor</th>
              <th className="text-right py-1 px-1">Current</th>
              <th className="text-right py-1 px-1">Suggested</th>
              <th className="text-right py-1 px-1">Win% (Present)</th>
              <th className="text-right py-1 px-1">Win% (Absent)</th>
              <th className="text-right py-1 px-1">N</th>
            </tr>
          </thead>
          <tbody>
            {suggestions.slice(0, 10).map((f, i) => {
              const isIncrease = f.suggestedWeight > f.currentWeight;
              const isDecrease = f.suggestedWeight < f.currentWeight;
              return (
                <tr key={i} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="py-1 px-1 text-foreground">{f.factorName}</td>
                  <td className="text-right py-1 px-1">{f.currentWeight.toFixed(1)}</td>
                  <td className={`text-right py-1 px-1 font-semibold ${isIncrease ? "text-green-400" : isDecrease ? "text-red-400" : "text-foreground"}`}>
                    {f.suggestedWeight.toFixed(1)}
                  </td>
                  <td className={`text-right py-1 px-1 ${f.winRateWhenPresent >= 50 ? "text-green-400" : "text-red-400"}`}>
                    {f.winRateWhenPresent.toFixed(0)}%
                  </td>
                  <td className="text-right py-1 px-1 text-muted-foreground">
                    {f.winRateWhenAbsent.toFixed(0)}%
                  </td>
                  <td className="text-right py-1 px-1 text-muted-foreground">{f.sampleSize}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────

interface RecommendationsDashboardProps {
  botId: string;
}

export function RecommendationsDashboard({ botId }: RecommendationsDashboardProps) {
  const queryClient = useQueryClient();
  const [expandedReview, setExpandedReview] = useState<string | null>(null);

  // Fetch recommendations
  const { data: recommendations, isLoading, error } = useQuery({
    queryKey: ["bot-recommendations", botId],
    queryFn: async () => {
      const mappedBotId = botId === "fotsi" ? "fotsi_mr" : "smc";
      const { data, error } = await supabase
        .from("bot_recommendations")
        .select("*")
        .eq("bot_id", mappedBotId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) throw error;
      return (data || []) as unknown as BotRecommendation[];
    },
    refetchInterval: 60000,
  });

  // Helper: update per-rec status in the recommendations JSONB array, and
  // resolve the row-level status only when ALL recs are handled.
  async function updateRecStatus(
    reviewId: string,
    recIndex: number,
    newStatus: "approved" | "dismissed",
    extraFields?: Record<string, any>
  ) {
    const review = recommendations?.find(r => r.id === reviewId);
    if (!review) return;
    const updatedRecs = [...(review.recommendations || [])];
    updatedRecs[recIndex] = { ...updatedRecs[recIndex], status: newStatus };

    const allResolved = updatedRecs.every(
      r => r.status === "approved" || r.status === "dismissed"
    );
    const anyApproved = updatedRecs.some(r => r.status === "approved");

    const updatePayload: any = {
      recommendations: updatedRecs,
      ...(extraFields || {}),
    };

    // Only mark the row as fully resolved when every recommendation has been acted on
    if (allResolved) {
      updatePayload.status = anyApproved ? "approved" : "dismissed";
      updatePayload.resolved_at = new Date().toISOString();
      updatePayload.resolved_by = "user";
    }

    const { error } = await supabase
      .from("bot_recommendations")
      .update(updatePayload as any)
      .eq("id", reviewId);
    if (error) throw error;
  }

  // Display-name → camelCase config key mapping (shared by approve flows)
  const DISPLAY_TO_CONFIG_KEY: Record<string, string> = {
    "Market Structure": "marketStructure",
    "Order Block": "orderBlock",
    "Fair Value Gap": "fairValueGap",
    "Premium/Discount & Fib": "premiumDiscountFib",
    "Premium/Discount": "premiumDiscountFib",
    "Session/Kill Zone": "sessionKillZone",
    "Judas Swing": "judasSwing",
    "PD/PW Levels": "pdPwLevels",
    "Reversal Candle": "reversalCandle",
    "Liquidity Sweep": "liquiditySweep",
    "Displacement": "displacement",
    "Breaker Block": "breakerBlock",
    "Unicorn Model": "unicornModel",
    "Silver Bullet": "silverBullet",
    "Macro Window": "macroWindow",
    "SMT Divergence": "smtDivergence",
    "Volume Profile": "volumeProfile",
    "AMD Phase": "amdPhase",
    "Currency Strength": "currencyStrength",
    "Trend Direction": "trendDirection",
    "Daily Bias": "dailyBias",
  };

  // Approve mutation — patches bot_configs.config_json for ONE recommendation at a time
  const approveMutation = useMutation({
    mutationFn: async ({ id, recIndex }: { id: string; recIndex: number }) => {
      const review = recommendations?.find(r => r.id === id);
      if (!review) throw new Error("Recommendation not found");

      const rec = review.recommendations?.[recIndex];
      const suggested = rec?.suggested_value;
      if (!rec || !suggested) {
        throw new Error("This recommendation has no suggested config change to apply.");
      }

      // Get current user
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");

      // Load current bot config
      const { data: cfgRow, error: cfgErr } = await supabase
        .from("bot_configs")
        .select("id, config_json")
        .eq("user_id", user.id)
        .maybeSingle();
      if (cfgErr) throw cfgErr;
      if (!cfgRow) throw new Error("No bot config found for this user");

      const currentConfig = (cfgRow.config_json as any) || {};

      // Factor weights recommendations: merge directly into factorWeights
      if (rec.category === "factor_weights") {
        const existingWeights = currentConfig.factorWeights || {};
        const rawSuggested = suggested as Record<string, number>;

        const suggestedWeights: Record<string, number> = {};
        for (const [key, val] of Object.entries(rawSuggested)) {
          const configKey = DISPLAY_TO_CONFIG_KEY[key] || key;
          if (typeof val === "number") {
            suggestedWeights[configKey] = val;
          }
        }

        const mergedWeights = { ...existingWeights, ...suggestedWeights };
        const patched = { ...currentConfig, factorWeights: mergedWeights };

        const { error: updateCfgErr } = await supabase
          .from("bot_configs")
          .update({ config_json: patched, updated_at: new Date().toISOString() })
          .eq("id", cfgRow.id);
        if (updateCfgErr) throw updateCfgErr;
        queryClient.invalidateQueries({ queryKey: ["bot-config"] });

        const applied = Object.entries(suggestedWeights).map(([key, val]) => ({
          key, path: `factorWeights.${key}`, from: existingWeights[key] ?? "default", to: val,
        }));

        // Mark only THIS recommendation as approved (per-rec status)
        await updateRecStatus(id, recIndex, "approved", {
          impact_snapshot: { applied, recIndex },
        });

        return { applied, skipped: [] };
      }

      // Regime adaptation recommendations: handle both factorWeights and config path overrides
      if (rec.category === "regime_adaptation") {
        const rawSuggested = suggested as Record<string, any>;
        let patched = { ...currentConfig };
        const applied: Array<{ key: string; path: string; from: any; to: any }> = [];

        for (const [key, val] of Object.entries(rawSuggested)) {
          // Check if it's a dotted config path (e.g., "strategy.tpRatio")
          if (key.includes(".")) {
            const parts = key.split(".");
            let target: any = patched;
            for (let i = 0; i < parts.length - 1; i++) {
              if (!target[parts[i]]) target[parts[i]] = {};
              target = target[parts[i]];
            }
            const lastKey = parts[parts.length - 1];
            const oldVal = target[lastKey];
            target[lastKey] = val;
            applied.push({ key, path: key, from: oldVal ?? "default", to: val });
          } else {
            // It's a factorWeight key
            const configKey = DISPLAY_TO_CONFIG_KEY[key] || key;
            if (!patched.factorWeights) patched.factorWeights = {};
            const oldVal = patched.factorWeights[configKey];
            patched.factorWeights[configKey] = val;
            applied.push({ key: configKey, path: `factorWeights.${configKey}`, from: oldVal ?? "default", to: val });
          }
        }

        if (applied.length > 0) {
          const { error: updateCfgErr } = await supabase
            .from("bot_configs")
            .update({ config_json: patched, updated_at: new Date().toISOString() })
            .eq("id", cfgRow.id);
          if (updateCfgErr) throw updateCfgErr;
          queryClient.invalidateQueries({ queryKey: ["bot-config"] });
        }

        await updateRecStatus(id, recIndex, "approved", {
          impact_snapshot: { applied, recIndex },
        });

        return { applied, skipped: [] };
      }

      // General recommendations: use applyRecommendationToConfig
      const { patched, applied, skipped } = applyRecommendationToConfig(
        currentConfig,
        suggested as Record<string, unknown>
      );

      if (applied.length === 0) {
        throw new Error(
          `Could not map recommended keys to config: ${skipped.map(s => s.key).join(", ")}`
        );
      }

      // Persist patched config
      const { error: updateCfgErr } = await supabase
        .from("bot_configs")
        .update({ config_json: patched, updated_at: new Date().toISOString() })
        .eq("id", cfgRow.id);
      if (updateCfgErr) throw updateCfgErr;

      // Mark only THIS recommendation as approved (per-rec status)
      await updateRecStatus(id, recIndex, "approved", {
        impact_snapshot: { applied, skipped, recIndex },
      });

      return { applied, skipped };
    },
    onSuccess: ({ applied, skipped }) => {
      queryClient.invalidateQueries({ queryKey: ["bot-recommendations"] });
      const summary = applied
        .map(a => `${a.path}: ${JSON.stringify(a.from)} → ${JSON.stringify(a.to)}`)
        .join(", ");
      toast.success(`Config updated — ${summary}`);
      if (skipped.length > 0) {
        toast.warning(`Skipped unmapped keys: ${skipped.map(s => s.key).join(", ")}`);
      }
    },
    onError: (err: any) => {
      toast.error(`Failed to approve: ${err.message}`);
    },
  });

  // Dismiss mutation — dismisses a SINGLE recommendation by index
  const dismissMutation = useMutation({
    mutationFn: async ({ id, recIndex }: { id: string; recIndex: number }) => {
      await updateRecStatus(id, recIndex, "dismissed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bot-recommendations"] });
      toast.success("Recommendation dismissed.");
    },
    onError: (err: any) => {
      toast.error(`Failed to dismiss: ${err.message}`);
    },
  });

  // Dismiss ALL remaining pending recommendations in a review
  const dismissAllMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("bot_recommendations")
        .update({
          status: "dismissed",
          resolved_at: new Date().toISOString(),
          resolved_by: "user",
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bot-recommendations"] });
      toast.success("All recommendations dismissed.");
    },
    onError: (err: any) => {
      toast.error(`Failed to dismiss: ${err.message}`);
    },
  });

  // Trigger manual review
  const triggerReviewMutation = useMutation({
    mutationFn: async (reviewType: "daily" | "weekly") => {
      const funcName = reviewType === "daily" ? "bot-daily-review" : "bot-weekly-advisor";
      const mappedBotId = botId === "fotsi" ? "fotsi_mr" : "smc";
      const toastId = toast.loading(
        `Running ${reviewType} review... AI is analyzing your trades, this may take 30-60s.`
      );
      try {
        const { data, error } = await supabase.functions.invoke(funcName, {
          body: { bot_id: mappedBotId },
        });
        if (error) throw error;
        // Function returns 200 even when LLM fails internally — only treat
        // explicit error/failure statuses as failures. Values like
        // "losing"/"winning"/"breakeven" are assessment labels, not errors.
        const results: Array<{ status?: string }> = data?.results || [];
        const failed = results.find(r =>
          typeof r.status === "string" &&
          /^(error|failed|failure|llm_error|exception)$/i.test(r.status)
        );
        if (failed) {
          throw new Error(`Review could not complete: ${failed.status}`);
        }
        return { reviewType, toastId };
      } catch (err) {
        toast.dismiss(toastId);
        throw err;
      }
    },
    onSuccess: ({ reviewType, toastId }) => {
      queryClient.invalidateQueries({ queryKey: ["bot-recommendations"] });
      toast.success(
        `${reviewType === "daily" ? "Daily" : "Weekly"} review complete. Results below.`,
        { id: toastId }
      );
    },
    onError: (err: any) => {
      toast.error(`Review failed: ${err.message}`);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground text-[11px]">
        <Clock className="w-4 h-4 mr-2 animate-spin" /> Loading recommendations...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-8 text-red-400 text-[11px]">
        <AlertTriangle className="w-4 h-4 mr-2" /> Failed to load recommendations
      </div>
    );
  }

  const pending = recommendations?.filter(r => r.status === "pending") || [];
  const resolved = recommendations?.filter(r => r.status !== "pending") || [];

  return (
    <div className="space-y-3 p-1">
      {/* Header with trigger buttons */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-primary" />
          <span className="text-[11px] font-bold uppercase tracking-wider text-foreground">
            AI Strategy Advisor
          </span>
          {pending.length > 0 && (
            <Badge variant="destructive" className="text-[9px] px-1.5 py-0 h-4">
              {pending.length} pending
            </Badge>
          )}
        </div>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] px-2"
            onClick={() => triggerReviewMutation.mutate("daily")}
            disabled={triggerReviewMutation.isPending}
          >
            {triggerReviewMutation.isPending ? (
              <Clock className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <Zap className="w-3 h-3 mr-1" />
            )}
            Run Daily Review
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] px-2"
            onClick={() => triggerReviewMutation.mutate("weekly")}
            disabled={triggerReviewMutation.isPending}
          >
            {triggerReviewMutation.isPending ? (
              <Clock className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <BarChart3 className="w-3 h-3 mr-1" />
            )}
            Run Weekly Review
          </Button>
        </div>
      </div>

      {/* Regime Status Card */}
      {(() => {
        // Find the latest weekly review with regime data
        const latestWeekly = recommendations?.find(r => r.review_type === "weekly" && r.performance_summary?.regimeAnalysis);
        const regime = latestWeekly?.performance_summary?.regimeAnalysis;
        if (!regime || regime.currentRegime === "unknown") return null;

        const regimeStyles: Record<string, { bg: string; border: string; icon: string; label: string }> = {
          strong_trend: { bg: "bg-green-500/10", border: "border-green-500/30", icon: "↑↑", label: "Strong Trend" },
          mild_trend: { bg: "bg-green-500/5", border: "border-green-500/20", icon: "↑", label: "Mild Trend" },
          choppy_range: { bg: "bg-red-500/10", border: "border-red-500/30", icon: "⇆", label: "Choppy / Range" },
          mild_range: { bg: "bg-yellow-500/10", border: "border-yellow-500/30", icon: "↔", label: "Mild Range" },
          transitional: { bg: "bg-orange-500/10", border: "border-orange-500/30", icon: "?", label: "Transitional" },
        };
        const style = regimeStyles[regime.currentRegime] || regimeStyles.transitional;

        return (
          <Card className={`${style.bg} ${style.border} border`}>
            <CardContent className="py-2.5 px-3">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{style.icon}</span>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-foreground">
                    Market Regime: {style.label}
                  </span>
                </div>
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">
                  {(regime.regimeConfidence * 100).toFixed(0)}% confidence
                </Badge>
              </div>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                {regime.regimeImpact}
              </p>
              {regime.regimeIndicators.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {regime.regimeIndicators.slice(0, 3).map((ind, i) => (
                    <span key={i} className="text-[9px] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
                      {ind.length > 60 ? ind.slice(0, 57) + "..." : ind}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-1.5 text-[9px] text-muted-foreground">
                Detected {timeAgo(latestWeekly!.created_at)}
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* No recommendations state */}
      {(!recommendations || recommendations.length === 0) && (
        <Card>
          <CardContent className="py-8 text-center">
            <Brain className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-[12px] font-medium text-foreground mb-1">No recommendations yet</p>
            <p className="text-[10px] text-muted-foreground mb-3">
              The AI advisor will analyze your trading performance and provide suggestions.
              <br />
              Reviews run automatically: daily at 22:00 UTC, weekly on Sundays at 23:00 UTC.
            </p>
            <Button
              size="sm"
              variant="default"
              className="h-7 text-[10px]"
              onClick={() => triggerReviewMutation.mutate("daily")}
              disabled={triggerReviewMutation.isPending}
            >
              {triggerReviewMutation.isPending ? (
                <>
                  <Clock className="w-3 h-3 mr-1 animate-spin" />
                  Processing...
                </>
              ) : (
                "Run First Review Now"
              )}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Pending recommendations */}
      {pending.length > 0 && (
        <div className="space-y-2">
          <span className="text-[10px] font-semibold text-yellow-400 uppercase tracking-wider">
            Pending Review ({pending.length})
          </span>
          {pending.map(review => {
            const assessment = assessmentConfig[review.overall_assessment] || assessmentConfig.insufficient_data;
            const isExpanded = expandedReview === review.id;

            return (
              <Card key={review.id} className="border-yellow-500/30">
                <CardContent className="pt-2.5 pb-2 space-y-2">
                  {/* Review header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-primary/10 text-primary border-primary/30">
                        {review.review_type === "weekly" ? "WEEKLY" : "DAILY"}
                      </Badge>
                      <span className={`flex items-center gap-1 text-[11px] font-bold ${assessment.color}`}>
                        {assessment.icon} {assessment.label}
                      </span>
                    </div>
                    <span className="text-[9px] text-muted-foreground">{timeAgo(review.created_at)}</span>
                  </div>

                  {/* Diagnosis */}
                  <p className="text-[10px] text-foreground leading-relaxed">{review.diagnosis}</p>

                  {/* Expand/collapse details */}
                  <button
                    onClick={() => setExpandedReview(isExpanded ? null : review.id)}
                    className="flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors"
                  >
                    {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    {isExpanded ? "Hide details" : `Show details (${review.recommendations?.length || 0} recommendations)`}
                  </button>

                  {isExpanded && (
                    <div className="space-y-2 pt-1 border-t border-border">
                      {/* Weekly performance table */}
                      {review.performance_summary?.weeklyData && (
                        <WeeklyPerformanceTable weeklyData={review.performance_summary.weeklyData} />
                      )}

                      {/* Regime analysis */}
                      {review.performance_summary?.regimeAnalysis && (
                        <RegimeIndicator regime={review.performance_summary.regimeAnalysis} />
                      )}

                      {/* Factor suggestions table */}
                      {review.performance_summary?.factorSuggestions && (
                        <FactorSuggestionsTable suggestions={review.performance_summary.factorSuggestions} />
                      )}

                      {/* Individual recommendations */}
                      {review.recommendations?.map((rec, i) => {
                        const recStatus = rec.status || "pending";
                        const isRecPending = recStatus === "pending";
                        return (
                          <div key={i} className="relative">
                            {!isRecPending && (
                              <div className="absolute top-1 right-1 z-10">
                                <Badge variant="outline" className={`text-[8px] px-1 py-0 h-3.5 ${
                                  recStatus === "approved"
                                    ? "bg-green-500/20 text-green-400 border-green-500/30"
                                    : "bg-muted text-muted-foreground border-border"
                                }`}>
                                  {recStatus.toUpperCase()}
                                </Badge>
                              </div>
                            )}
                            <RecommendationCard
                              rec={rec}
                              index={i}
                              isPending={isRecPending}
                              onApprove={isRecPending ? () => approveMutation.mutate({ id: review.id, recIndex: i }) : undefined}
                              onDismiss={isRecPending ? () => dismissMutation.mutate({ id: review.id, recIndex: i }) : undefined}
                            />
                          </div>
                        );
                      })}

                      {/* Feature gaps */}
                      {review.feature_gaps?.length > 0 && (
                        <div className="border border-border rounded-md p-2 bg-card/50">
                          <div className="flex items-center gap-2 mb-1">
                            <Lightbulb className="w-3.5 h-3.5 text-yellow-400" />
                            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Feature Gaps Identified</span>
                          </div>
                          {review.feature_gaps.map((gap, i) => (
                            <p key={i} className="text-[10px] text-muted-foreground pl-2 border-l border-yellow-500/30 mt-1">
                              {gap}
                            </p>
                          ))}
                        </div>
                      )}

                      {/* Bulk actions — only show if there are still pending recs */}
                      {review.recommendations?.some(r => !r.status || r.status === "pending") && (
                        <div className="flex gap-2 pt-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[10px] px-3"
                            onClick={() => dismissAllMutation.mutate(review.id)}
                            disabled={dismissAllMutation.isPending}
                          >
                            <XCircle className="w-3 h-3 mr-1" /> Dismiss All Remaining
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Resolved recommendations */}
      {resolved.length > 0 && (
        <div className="space-y-2">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            History ({resolved.length})
          </span>
          {resolved.map(review => {
            const assessment = assessmentConfig[review.overall_assessment] || assessmentConfig.insufficient_data;
            const statusBadge = review.status === "approved"
              ? { color: "bg-green-500/20 text-green-400 border-green-500/30", label: "APPROVED" }
              : { color: "bg-muted text-muted-foreground border-border", label: "DISMISSED" };
            const isExpanded = expandedReview === review.id;

            return (
              <Card key={review.id} className="opacity-70 hover:opacity-100 transition-opacity">
                <CardContent className="pt-2 pb-2 space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 ${statusBadge.color}`}>
                        {statusBadge.label}
                      </Badge>
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4">
                        {review.review_type === "weekly" ? "WEEKLY" : "DAILY"}
                      </Badge>
                      <span className={`flex items-center gap-1 text-[10px] ${assessment.color}`}>
                        {assessment.icon} {assessment.label}
                      </span>
                    </div>
                    <span className="text-[9px] text-muted-foreground">{timeAgo(review.created_at)}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2">{review.diagnosis}</p>

                  <button
                    onClick={() => setExpandedReview(isExpanded ? null : review.id)}
                    className="flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    {isExpanded ? "Hide" : `${review.recommendations?.length || 0} recommendations`}
                  </button>

                  {isExpanded && (
                    <div className="space-y-1.5 pt-1 border-t border-border">
                      {review.recommendations?.map((rec, i) => (
                        <RecommendationCard key={i} rec={rec} index={i} isPending={false} />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
