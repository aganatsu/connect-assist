import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp,
  TrendingUp, TrendingDown, Minus, AlertTriangle, Lightbulb,
  BarChart3, Shield, Target, Zap, Brain, ArrowRight,
} from "lucide-react";

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
  isPending,
}: {
  rec: Recommendation;
  index: number;
  onApprove?: () => void;
  onDismiss?: () => void;
  isPending: boolean;
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

          {/* Action buttons */}
          {isPending && onApprove && onDismiss && (
            <div className="flex gap-2 pt-1">
              <Button
                size="sm"
                variant="default"
                className="h-6 text-[10px] px-3"
                onClick={onApprove}
              >
                <CheckCircle2 className="w-3 h-3 mr-1" /> Approve
              </Button>
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
  if (!regime) return null;

  const regimeLabels: Record<string, { label: string; color: string }> = {
    strong_trend: { label: "Strong Trend", color: "text-green-400" },
    mild_trend: { label: "Mild Trend", color: "text-blue-400" },
    transitional: { label: "Transitional", color: "text-yellow-400" },
    mild_range: { label: "Mild Range", color: "text-orange-400" },
    choppy_range: { label: "Choppy Range", color: "text-red-400" },
    unknown: { label: "Unknown", color: "text-muted-foreground" },
  };

  const config = regimeLabels[regime.currentRegime] || regimeLabels.unknown;

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

  // Approve mutation
  const approveMutation = useMutation({
    mutationFn: async ({ id, recIndex }: { id: string; recIndex: number }) => {
      const rec = recommendations?.find(r => r.id === id);
      if (!rec) throw new Error("Recommendation not found");

      // Mark as approved
      const { error } = await supabase
        .from("bot_recommendations")
        .update({
          status: "approved",
          resolved_at: new Date().toISOString(),
          resolved_by: "user",
        } as any)
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bot-recommendations"] });
      toast.success("Recommendation approved. Config change will be applied on next scan cycle.");
    },
    onError: (err: any) => {
      toast.error(`Failed to approve: ${err.message}`);
    },
  });

  // Dismiss mutation
  const dismissMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("bot_recommendations")
        .update({
          status: "dismissed",
          resolved_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bot-recommendations"] });
      toast.success("Recommendation dismissed.");
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
      const { error } = await supabase.functions.invoke(funcName, {
        body: { bot_id: mappedBotId },
      });
      if (error) throw error;
    },
    onSuccess: (_, reviewType) => {
      queryClient.invalidateQueries({ queryKey: ["bot-recommendations"] });
      toast.success(`${reviewType === "daily" ? "Daily" : "Weekly"} review triggered. Results will appear shortly.`);
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
              Run First Review Now
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
                      {review.recommendations?.map((rec, i) => (
                        <RecommendationCard
                          key={i}
                          rec={rec}
                          index={i}
                          isPending={true}
                          onApprove={() => approveMutation.mutate({ id: review.id, recIndex: i })}
                          onDismiss={() => dismissMutation.mutate(review.id)}
                        />
                      ))}

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

                      {/* Bulk actions */}
                      <div className="flex gap-2 pt-1">
                        <Button
                          size="sm"
                          variant="default"
                          className="h-6 text-[10px] px-3"
                          onClick={() => approveMutation.mutate({ id: review.id, recIndex: 0 })}
                          disabled={approveMutation.isPending}
                        >
                          <CheckCircle2 className="w-3 h-3 mr-1" /> Approve All
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[10px] px-3"
                          onClick={() => dismissMutation.mutate(review.id)}
                          disabled={dismissMutation.isPending}
                        >
                          <XCircle className="w-3 h-3 mr-1" /> Dismiss All
                        </Button>
                      </div>
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
