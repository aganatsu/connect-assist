import React, { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sparkles, Loader2, AlertTriangle, CheckCircle2, XCircle,
  ArrowRight, Shield, TrendingUp, ChevronDown, ChevronUp,
} from "lucide-react";
import { toast } from "sonner";

// ─── Types ───────────────────────────────────────────────────
interface Recommendation {
  id: number;
  priority: "critical" | "high" | "medium" | "low";
  action: string;
  reasoning: string;
  expected_impact: string;
  risk_warning: string;
  confidence: "high" | "medium" | "low";
}

interface GatesVerdict {
  working_well: string[];
  over_filtering: string[];
  under_filtering: string[];
}

interface ThresholdRec {
  current_effective: number;
  suggested: number;
  reasoning: string;
}

interface SymbolSpecific {
  symbol: string;
  issue: string;
  fix: string;
}

interface AdvisorResponse {
  overall_assessment: string;
  profitability_score: number;
  recommendations: Recommendation[];
  gates_verdict?: GatesVerdict;
  threshold_recommendation?: ThresholdRec;
  symbol_specific?: SymbolSpecific[];
  data_quality_warning?: string;
  analysis_summary?: any;
}

// ─── Priority Config ─────────────────────────────────────────
const PRIORITY_CONFIG: Record<string, { color: string; bgColor: string; borderColor: string; icon: React.ReactNode }> = {
  critical: { color: "text-destructive", bgColor: "bg-destructive/10", borderColor: "border-destructive/30", icon: <XCircle className="h-4 w-4 text-destructive" /> },
  high: { color: "text-amber-400", bgColor: "bg-amber-500/10", borderColor: "border-amber-500/30", icon: <AlertTriangle className="h-4 w-4 text-amber-400" /> },
  medium: { color: "text-blue-400", bgColor: "bg-blue-500/10", borderColor: "border-blue-500/30", icon: <ArrowRight className="h-4 w-4 text-blue-400" /> },
  low: { color: "text-muted-foreground", bgColor: "bg-muted/50", borderColor: "border-border/50", icon: <CheckCircle2 className="h-4 w-4 text-muted-foreground" /> },
};

// ─── Component ───────────────────────────────────────────────
interface StrategyAdvisorProps {
  days: number;
}

export function StrategyAdvisor({ days }: StrategyAdvisorProps) {
  const STORAGE_KEY = "strategyAdvisor:lastResult";
  const [result, setResult] = useState<AdvisorResponse | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.data ?? null;
    } catch {
      return null;
    }
  });
  const [savedAt, setSavedAt] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw)?.savedAt ?? null;
    } catch {
      return null;
    }
  });
  const [expandedRecs, setExpandedRecs] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (result) {
      try {
        const savedAt = Date.now();
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ data: result, savedAt }));
        setSavedAt(savedAt);
      } catch {}
    }
  }, [result]);

  const advisorMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await (supabase as any).functions.invoke("strategy-advisor", {
        body: { days },
      });
      if (error) throw error;
      return data as AdvisorResponse;
    },
    onSuccess: (data) => {
      setResult(data);
      if (data.recommendations?.length > 0) {
        toast.success(`Found ${data.recommendations.length} recommendations`);
      } else {
        toast.info("Analysis complete — no actionable recommendations at this time.");
      }
    },
    onError: (err: any) => {
      toast.error(`Analysis failed: ${err.message}`);
    },
  });

  const toggleExpanded = (id: number) => {
    setExpandedRecs(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Score color
  const getScoreColor = (score: number) => {
    if (score >= 7) return "text-emerald-400";
    if (score >= 5) return "text-amber-400";
    return "text-destructive";
  };

  const getScoreLabel = (score: number) => {
    if (score >= 8) return "Well Calibrated";
    if (score >= 6) return "Needs Tuning";
    if (score >= 4) return "Under-performing";
    return "Critically Over-filtering";
  };

  return (
    <div className="space-y-4">
      {/* Header + Trigger */}
      <Card className="border-border/50">
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-violet-500/10 border border-violet-500/30">
                <Sparkles className="h-5 w-5 text-violet-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">AI Strategy Advisor</h3>
                <p className="text-xs text-muted-foreground">
                  Analyzes your rejected setups and recommends specific changes to improve profitability
                </p>
              </div>
            </div>
            <Button
              onClick={() => advisorMutation.mutate()}
              disabled={advisorMutation.isPending}
              size="sm"
              className="bg-violet-600 hover:bg-violet-700 text-white"
            >
              {advisorMutation.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                  Run Analysis
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Loading State */}
      {advisorMutation.isPending && (
        <Card className="border-violet-500/30 bg-violet-500/5">
          <CardContent className="p-6 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-violet-400 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">AI is analyzing your rejected setups data...</p>
            <p className="text-xs text-muted-foreground mt-1">This may take 15-30 seconds</p>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {result && !advisorMutation.isPending && (
        <div className="space-y-4">
          {/* Overall Assessment */}
          <Card className="border-border/50">
            <CardHeader className="pb-2 pt-3 px-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">Overall Assessment</CardTitle>
                {result.profitability_score && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Gate Config Score:</span>
                    <span className={`text-lg font-bold ${getScoreColor(result.profitability_score)}`}>
                      {result.profitability_score}/10
                    </span>
                    <Badge variant="outline" className={`text-[10px] ${getScoreColor(result.profitability_score)}`}>
                      {getScoreLabel(result.profitability_score)}
                    </Badge>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-3">
              <p className="text-sm text-foreground/90 leading-relaxed">{result.overall_assessment}</p>
              {result.data_quality_warning && (
                <div className="mt-3 flex items-start gap-2 p-2 rounded bg-amber-500/10 border border-amber-500/20">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" />
                  <p className="text-xs text-amber-300">{result.data_quality_warning}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recommendations */}
          {result.recommendations && result.recommendations.length > 0 && (
            <Card className="border-border/50">
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-emerald-400" />
                  Actionable Recommendations ({result.recommendations.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3 space-y-3">
                {result.recommendations.map((rec) => {
                  const config = PRIORITY_CONFIG[rec.priority] || PRIORITY_CONFIG.medium;
                  const isExpanded = expandedRecs.has(rec.id);

                  return (
                    <div
                      key={rec.id}
                      className={`rounded-lg border ${config.borderColor} ${config.bgColor} overflow-hidden`}
                    >
                      {/* Header */}
                      <button
                        onClick={() => toggleExpanded(rec.id)}
                        className="w-full flex items-start gap-3 p-3 text-left hover:bg-white/5 transition-colors"
                      >
                        <div className="mt-0.5 shrink-0">{config.icon}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${config.color} ${config.borderColor}`}>
                              {rec.priority.toUpperCase()}
                            </Badge>
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground border-border/50">
                              {rec.confidence} confidence
                            </Badge>
                          </div>
                          <p className="text-sm font-medium text-foreground">{rec.action}</p>
                          <p className="text-xs text-emerald-400 mt-1 font-medium">{rec.expected_impact}</p>
                        </div>
                        <div className="shrink-0 mt-1">
                          {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                        </div>
                      </button>

                      {/* Expanded Details */}
                      {isExpanded && (
                        <div className="px-3 pb-3 pt-0 ml-7 space-y-2 border-t border-border/30">
                          <div className="pt-2">
                            <p className="text-xs text-muted-foreground font-medium mb-1">Reasoning:</p>
                            <p className="text-xs text-foreground/80">{rec.reasoning}</p>
                          </div>
                          <div className="flex items-start gap-2 p-2 rounded bg-destructive/10 border border-destructive/20">
                            <AlertTriangle className="h-3 w-3 text-destructive mt-0.5 shrink-0" />
                            <div>
                              <p className="text-[10px] text-destructive font-medium">Risk Warning</p>
                              <p className="text-xs text-red-300/80">{rec.risk_warning}</p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* Threshold Recommendation */}
          {result.threshold_recommendation && (
            <Card className="border-border/50">
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Shield className="h-4 w-4 text-blue-400" />
                  Threshold Recommendation
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                <div className="flex items-center gap-4 mb-2">
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground">Current</p>
                    <p className="text-lg font-bold text-destructive">{result.threshold_recommendation.current_effective}</p>
                  </div>
                  <ArrowRight className="h-5 w-5 text-muted-foreground" />
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground">Suggested</p>
                    <p className="text-lg font-bold text-emerald-400">{result.threshold_recommendation.suggested}</p>
                  </div>
                </div>
                <p className="text-xs text-foreground/80">{result.threshold_recommendation.reasoning}</p>
              </CardContent>
            </Card>
          )}

          {/* Gates Verdict */}
          {result.gates_verdict && (
            <Card className="border-border/50">
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Shield className="h-4 w-4 text-violet-400" />
                  Gates Verdict
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3 space-y-3">
                {result.gates_verdict.working_well?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-emerald-400 mb-1 flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" /> Working Well
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {result.gates_verdict.working_well.map((g, i) => (
                        <Badge key={i} variant="outline" className="text-[10px] text-emerald-400 border-emerald-500/30 bg-emerald-500/10">
                          {g}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {result.gates_verdict.over_filtering?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-destructive mb-1 flex items-center gap-1">
                      <XCircle className="h-3 w-3" /> Over-filtering (blocking winners)
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {result.gates_verdict.over_filtering.map((g, i) => (
                        <Badge key={i} variant="outline" className="text-[10px] text-destructive border-destructive/30 bg-destructive/10">
                          {g}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {result.gates_verdict.under_filtering?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-amber-400 mb-1 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> Under-filtering (letting losers through)
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {result.gates_verdict.under_filtering.map((g, i) => (
                        <Badge key={i} variant="outline" className="text-[10px] text-amber-400 border-amber-500/30 bg-amber-500/10">
                          {g}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Symbol-Specific Issues */}
          {result.symbol_specific && result.symbol_specific.length > 0 && (
            <Card className="border-border/50">
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-sm font-medium">Symbol-Specific Issues</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                <div className="space-y-2">
                  {result.symbol_specific.map((s, i) => (
                    <div key={i} className="p-2 rounded bg-muted/30 border border-border/30">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className="text-[10px] font-mono">{s.symbol}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{s.issue}</p>
                      <p className="text-xs text-emerald-400 mt-1 font-medium">Fix: {s.fix}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Empty state before first run */}
      {!result && !advisorMutation.isPending && (
        <Card className="border-border/50 border-dashed">
          <CardContent className="p-8 text-center">
            <Sparkles className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              Click "Run Analysis" to get AI-powered recommendations based on your rejected setups data.
            </p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              The advisor analyzes which gates are helping vs hurting, and suggests specific changes to improve profitability.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
