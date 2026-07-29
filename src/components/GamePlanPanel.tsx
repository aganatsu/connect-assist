import React, { useState, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  TrendingUp, TrendingDown, Minus, Target, Shield, AlertTriangle,
  Clock, Newspaper, ChevronDown, ChevronUp, MapPin, Crosshair,
  Zap, Eye, EyeOff, BarChart3, Activity, RefreshCw, History,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { formatPrice } from "@/lib/formatTime";
import { scannerApi } from "@/lib/api";
import {
  activeGamePlanRowsToLogs,
  type ActiveGamePlanDisplayRow,
} from "@/lib/activeGamePlans";
import { toast } from "sonner";

// ─── Types ──────────────────────────────────────────────────────────

interface DOLTarget {
  price: number;
  type: "buy-side" | "sell-side";
  description: string;
  distancePips: number;
  strength: number;
}

interface KeyLevel {
  price: number;
  label: string;
  type: "support" | "resistance" | "pd_level" | "ob" | "fvg" | "liquidity";
  significance: "high" | "medium" | "low";
}

interface Scenario {
  condition: string;
  action: string;
  direction: "long" | "short";
  targetLevel?: number;
  invalidation?: string;
}

interface NewsEvent {
  time: string;
  currency: string;
  event: string;
  impact: "high" | "medium" | "low";
  forecast?: string;
  previous?: string;
}

type GamePlanState = "tradeable" | "wait" | "skip";

interface BiasEvidence {
  id: string;
  label: string;
  direction: "bullish" | "bearish" | "neutral";
  weight: number;
  available: boolean;
  contribution: number;
  reason: string;
}

interface GamePlanConviction {
  directionalStrength: number;
  evidenceCoverage: number;
  planQuality: number;
  confidence: number;
}

interface InstrumentPlan {
  gamePlanId?: string;
  planVersion?: string;
  symbol: string;
  bias: "bullish" | "bearish" | "neutral";
  biasConfidence: number;
  biasReasoning: string[];
  dol: DOLTarget | null;
  regime: string;
  amdPhase: string;
  zone: string;
  htfTrend: string;
  h4Trend: string;
  decisionEvidence?: {
    version: string;
    style: string;
    labels: {
      bias: string;
      structure: string;
      setup: string;
      confirmation: string;
      refinement: string;
    };
  };
  tradeable: boolean;
  state?: GamePlanState;
  stateReason?: string;
  conviction?: GamePlanConviction;
  evidence?: BiasEvidence[];
  supportingEvidence?: BiasEvidence[];
  conflictingEvidence?: BiasEvidence[];
  expiresAt?: string;
  skipReason?: string;
  scenarios: Scenario[];
  keyLevels: KeyLevel[];
  directionVerdict?: {
    id: string;
    verdictVersion: string;
    verdict: "long" | "short" | "neutral";
    confidence: number;
    shouldBlock: boolean;
    blockReason?: string | null;
    evaluatedAt: string;
    gamePlanVersion?: string | null;
  } | null;
}

interface GamePlanData {
  type: "game_plan";
  plan_version: string;
  source: "automatic_scan" | "manual_refresh";
  contract_version: string;
  session: string;
  generated_at: string;
  focus_pairs: string[];
  plans: InstrumentPlan[];
  newsEvents: NewsEvent[];
  summary: string;
}

interface GamePlanLog {
  id: string;
  scanned_at: string;
  details_json: GamePlanData;
}

// ─── API ────────────────────────────────────────────────────────────

async function fetchGamePlans(): Promise<GamePlanLog[]> {
  const [plansResult, verdictsResult] = await Promise.all([
    (supabase as any)
      .from("active_game_plans")
      .select("id,plan_version,symbol,session,bias,bias_confidence,v2_conviction,state,state_reason,generated_at,expires_at,invalidation_conditions,source_candle_timestamps,plan_json,focus_pairs,news_events,news_impacts,summary,generation_source,contract_version,is_active")
      .eq("bot_id", "smc")
      .order("generated_at", { ascending: false })
      .limit(300),
    (supabase as any)
      .from("active_direction_verdicts")
      .select("id,verdict_version,symbol,game_plan_version,verdict,confidence,should_block,block_reason,evaluated_at,is_active")
      .eq("bot_id", "smc")
      .eq("is_active", true),
  ]);
  if (plansResult.error) throw new Error(plansResult.error.message);
  if (verdictsResult.error) throw new Error(verdictsResult.error.message);
  const logs = activeGamePlanRowsToLogs(
    (plansResult.data || []) as ActiveGamePlanDisplayRow[],
  ) as unknown as GamePlanLog[];
  const verdicts = verdictsResult.data || [];
  return logs.map((log) => ({
    ...log,
    details_json: {
      ...log.details_json,
      plans: log.details_json.plans.map((plan) => {
        const verdict = verdicts.find((item: any) =>
          item.symbol === plan.symbol &&
          item.game_plan_version === plan.planVersion
        );
        return {
          ...plan,
          directionVerdict: verdict
            ? {
              id: verdict.id,
              verdictVersion: verdict.verdict_version,
              verdict: verdict.verdict,
              confidence: Number(verdict.confidence),
              shouldBlock: verdict.should_block,
              blockReason: verdict.block_reason,
              evaluatedAt: verdict.evaluated_at,
              gamePlanVersion: verdict.game_plan_version,
            }
            : null,
        };
      }),
    },
  }));
}

// ─── Helpers ────────────────────────────────────────────────────────

function getBiasColor(bias: string) {
  if (bias === "bullish") return "text-profit";
  if (bias === "bearish") return "text-loss";
  return "text-muted-foreground";
}

function getBiasBg(bias: string) {
  if (bias === "bullish") return "bg-badge-profit border-emerald-500/30";
  if (bias === "bearish") return "bg-badge-loss border-destructive/30";
  return "bg-zinc-500/10 border-zinc-500/30";
}

function getBiasIcon(bias: string) {
  if (bias === "bullish") return <TrendingUp className="h-4 w-4 text-profit" />;
  if (bias === "bearish") return <TrendingDown className="h-4 w-4 text-loss" />;
  return <Minus className="h-4 w-4 text-muted-foreground" />;
}

function getConfidenceColor(confidence: number) {
  if (confidence >= 60) return "text-profit";
  if (confidence >= 40) return "text-highlight";
  return "text-muted-foreground";
}

function getPlanState(plan: InstrumentPlan): GamePlanState {
  return plan.state || (plan.tradeable && plan.bias !== "neutral" ? "tradeable" : "skip");
}

function getStateBadge(state: GamePlanState) {
  if (state === "tradeable") return "bg-badge-profit text-profit border-emerald-500/30";
  if (state === "wait") return "bg-badge-warn text-warn border-orange-500/30";
  return "bg-zinc-800/50 text-muted-foreground border-zinc-600";
}

function getLevelTypeIcon(type: string) {
  switch (type) {
    case "ob": return <Shield className="h-3 w-3 text-cyan-400" />;
    case "fvg": return <Zap className="h-3 w-3 text-tier3" />;
    case "liquidity": return <Target className="h-3 w-3 text-warn" />;
    case "pd_level": return <MapPin className="h-3 w-3 text-highlight" />;
    default: return <Crosshair className="h-3 w-3 text-muted-foreground" />;
  }
}

function getLevelTypeBadge(type: string) {
  const colors: Record<string, string> = {
    ob: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
    fvg: "bg-purple-500/15 text-tier3 border-purple-500/30",
    liquidity: "bg-badge-warn text-warn border-orange-500/30",
    pd_level: "bg-warning/15 text-highlight border-yellow-500/30",
    support: "bg-badge-profit text-profit border-emerald-500/30",
    resistance: "bg-badge-loss text-loss border-destructive/30",
  };
  return colors[type] || "bg-zinc-500/15 text-muted-foreground border-zinc-500/30";
}

function formatTime(isoStr: string) {
  try {
    return new Date(isoStr).toLocaleTimeString("en-US", {
      hour: "2-digit", minute: "2-digit", timeZone: "America/New_York",
    });
  } catch { return isoStr; }
}

function formatDateTime(isoStr: string) {
  try {
    return new Date(isoStr).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch { return isoStr; }
}

// formatPrice is now imported from @/lib/formatTime (single source of truth)

// ─── Sub-Components ─────────────────────────────────────────────────

function BiasCard({ plan }: { plan: InstrumentPlan }) {
  const [expanded, setExpanded] = useState(false);
  const state = getPlanState(plan);
  const biasLabel = plan.decisionEvidence?.labels.bias || "D1";
  const structureLabel =
    plan.decisionEvidence?.labels.structure || "4H";
  const setupLabel = plan.decisionEvidence?.labels.setup || "1H";

  return (
    <div
      className={`border p-3 transition-all cursor-pointer hover:bg-accent/30 ${getBiasBg(plan.bias)}`}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {getBiasIcon(plan.bias)}
          <span className="font-mono text-sm font-semibold">{plan.symbol}</span>
          <Badge variant="outline" className={`text-[9px] h-4 ${getStateBadge(state)}`}>
            {state.toUpperCase()}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className={`font-mono text-xs font-bold uppercase ${getBiasColor(plan.bias)}`}>
            {plan.bias}
          </span>
          <span
            className={`font-mono text-[10px] ${getConfidenceColor(plan.biasConfidence)}`}
            title="Weighted directional support from the legacy vote model; this is not a win probability."
          >
            {plan.biasConfidence}% support
          </span>
          {expanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
        </div>
      </div>

      {/* Quick info row */}
      <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground font-mono">
        <span>{biasLabel}: {plan.htfTrend}</span>
        <span className="text-zinc-600">|</span>
        <span>{structureLabel}: {plan.h4Trend}</span>
        <span className="text-zinc-600">|</span>
        <span>Setup: {setupLabel}</span>
        <span className="text-zinc-600">|</span>
        <span>{plan.zone}</span>
        <span className="text-zinc-600">|</span>
        <span>{plan.regime}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[9px] font-mono">
        <span className="text-muted-foreground">
          GP v{plan.planVersion?.slice(0, 8) || "unversioned"}
        </span>
        {plan.directionVerdict ? (
          <span className={
            plan.directionVerdict.shouldBlock ||
              plan.directionVerdict.verdict === "neutral"
              ? "text-loss"
              : plan.directionVerdict.verdict === "long"
              ? "text-profit"
              : "text-loss"
          }>
            DV {plan.directionVerdict.verdict.toUpperCase()}{" "}
            {Math.round(plan.directionVerdict.confidence)}% · v
            {plan.directionVerdict.verdictVersion.slice(0, 8)}
          </span>
        ) : (
          <span className="text-highlight">
            Direction Verdict pending next scan
          </span>
        )}
        <span className="text-muted-foreground">
          Thesis validity: checked per candidate and again at fill
        </span>
      </div>

      {/* DOL row */}
      {plan.dol && (
        <div className="flex items-center gap-1.5 mt-1.5">
          <Target className="h-3 w-3 text-cyan-400 shrink-0" />
          <span className="text-[10px] text-cyan-300 font-mono">
            DOL: {plan.dol.description} @ {formatPrice(plan.dol.price, plan.symbol)}
            <span className="text-muted-foreground ml-1">({plan.dol.distancePips.toFixed(0)} pips)</span>
          </span>
        </div>
      )}

      {/* Skip reason */}
      {plan.skipReason && (
        <div className="flex items-center gap-1.5 mt-1.5">
          <AlertTriangle className="h-3 w-3 text-highlight shrink-0" />
          <span className="text-[10px] text-highlight font-mono">{plan.skipReason}</span>
        </div>
      )}
      {!plan.skipReason && plan.stateReason && state !== "tradeable" && (
        <div className="flex items-center gap-1.5 mt-1.5">
          <AlertTriangle className="h-3 w-3 text-highlight shrink-0" />
          <span className="text-[10px] text-highlight font-mono">{plan.stateReason}</span>
        </div>
      )}

      {/* Expanded content */}
      {expanded && (
        <div className="mt-3 space-y-3">
          <Separator className="bg-border/50" />

          {plan.conviction && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                Decision Evidence
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
                {[
                  ["Actionable Conviction", plan.conviction.confidence],
                  ["Net Directional Edge", plan.conviction.directionalStrength],
                  ["Input Coverage", plan.conviction.evidenceCoverage],
                  ["Plan Coherence", plan.conviction.planQuality],
                ].map(([label, value]) => (
                  <div key={String(label)} className="border border-border/50 bg-background/30 p-1.5">
                    <div className="text-[8px] uppercase text-muted-foreground">{label}</div>
                    <div className="text-xs font-mono font-semibold">{Number(value).toFixed(0)}%</div>
                  </div>
                ))}
              </div>
              {plan.stateReason && (
                <div className="text-[10px] text-foreground/70 font-mono mt-1.5">
                  {plan.stateReason}
                </div>
              )}
              {plan.expiresAt && (
                <div className="text-[9px] text-muted-foreground font-mono mt-1">
                  Expires: {formatDateTime(plan.expiresAt)}
                </div>
              )}
            </div>
          )}

          {plan.evidence && plan.evidence.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                Evidence
              </div>
              <div className="space-y-1">
                {plan.evidence.map((item) => (
                  <div key={item.id} className="flex items-start justify-between gap-2 text-[10px] font-mono">
                    <div className="min-w-0">
                      <span className={
                        !item.available ? "text-muted-foreground"
                        : item.direction === plan.bias ? "text-profit"
                        : item.direction === "neutral" ? "text-muted-foreground"
                        : "text-loss"
                      }>
                        {!item.available ? "○" : item.direction === plan.bias ? "✓" : item.direction === "neutral" ? "—" : "×"}
                      </span>
                      <span className="ml-1.5 text-foreground/80">{item.label}</span>
                      <div className="text-[9px] text-muted-foreground ml-4">{item.reason}</div>
                    </div>
                    <span className="text-muted-foreground shrink-0">{item.weight}w</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Bias Reasoning */}
          <div>
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Bias Reasoning</div>
            <div className="space-y-1">
              {plan.biasReasoning.map((reason, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className="text-cyan-500 text-[10px] mt-0.5">•</span>
                  <span className="text-[10px] text-foreground/80 font-mono">{reason}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Scenarios */}
          {plan.scenarios.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Trade Scenarios</div>
              <div className="space-y-2">
                {plan.scenarios.map((scenario, i) => (
                  <div key={i} className="border border-border/50 bg-background/30 p-2">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Badge
                        variant="outline"
                        className={`text-[9px] h-4 ${
                          scenario.direction === "long"
                            ? "bg-badge-profit text-profit border-emerald-500/30"
                            : "bg-badge-loss text-loss border-destructive/30"
                        }`}
                      >
                        {scenario.direction.toUpperCase()}
                      </Badge>
                      <span className="text-[10px] text-foreground/70 font-mono">Scenario {i + 1}</span>
                    </div>
                    <div className="text-[10px] text-foreground/90 font-mono mb-0.5">
                      <span className="text-cyan-400">IF:</span> {scenario.condition}
                    </div>
                    <div className="text-[10px] text-foreground/90 font-mono mb-0.5">
                      <span className="text-profit">THEN:</span> {scenario.action}
                    </div>
                    {scenario.targetLevel && (
                      <div className="text-[10px] text-foreground/70 font-mono">
                        <span className="text-highlight">TARGET:</span> {formatPrice(scenario.targetLevel, plan.symbol)}
                      </div>
                    )}
                    {scenario.invalidation && (
                      <div className="text-[10px] text-foreground/70 font-mono">
                        <span className="text-loss">INVALID:</span> {scenario.invalidation}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Key Levels */}
          {plan.keyLevels.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Key Levels</div>
              <div className="space-y-1">
                {plan.keyLevels.slice(0, 8).map((level, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      {getLevelTypeIcon(level.type)}
                      <Badge variant="outline" className={`text-[8px] h-3.5 px-1 ${getLevelTypeBadge(level.type)}`}>
                        {level.type.toUpperCase()}
                      </Badge>
                      <span className="text-[10px] text-foreground/70 font-mono">{level.label}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-mono font-semibold">{formatPrice(level.price, plan.symbol)}</span>
                      <Badge
                        variant="outline"
                        className={`text-[8px] h-3.5 px-1 ${
                          level.significance === "high"
                            ? "text-highlight border-yellow-500/30"
                            : level.significance === "medium"
                            ? "text-muted-foreground border-zinc-500/30"
                            : "text-zinc-600 border-zinc-700/30"
                        }`}
                      >
                        {level.significance}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NewsTimeline({ events }: { events: NewsEvent[] }) {
  if (!events || events.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {events.map((ev, i) => {
        const isPast = new Date(ev.time) < new Date();
        return (
          <div key={i} className={`flex items-center gap-2 ${isPast ? "opacity-50" : ""}`}>
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              ev.impact === "high" ? "bg-destructive" : ev.impact === "medium" ? "bg-warning" : "bg-zinc-500"
            }`} />
            <span className="text-[10px] font-mono text-muted-foreground w-16 shrink-0">
              {formatTime(ev.time)} ET
            </span>
            <Badge
              variant="outline"
              className={`text-[8px] h-3.5 px-1 shrink-0 ${
                ev.impact === "high"
                  ? "bg-badge-loss text-loss border-destructive/30"
                  : "bg-badge-warn text-warn border-orange-500/30"
              }`}
            >
              {ev.currency}
            </Badge>
            <span className="text-[10px] font-mono text-foreground/80 truncate">{ev.event}</span>
            {isPast && <span className="text-[9px] text-zinc-600 font-mono">DONE</span>}
          </div>
        );
      })}
    </div>
  );
}

function GamePlanSkeleton() {
  return (
    <div className="space-y-3 p-3">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-32" />
      <div className="space-y-2 mt-4">
        {[1, 2, 3].map(i => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function GamePlanPanel() {
  const [showHistory, setShowHistory] = useState(false);
  const [selectedPlanIdx, setSelectedPlanIdx] = useState(0);

  const { data: gamePlanLogs, isLoading, error, refetch } = useQuery({
    queryKey: ["game-plans"],
    queryFn: fetchGamePlans,
    refetchInterval: 60000, // refresh every minute
  });

  const refreshGamePlan = useMutation({
    mutationFn: scannerApi.refreshGamePlan,
    onSuccess: async (result) => {
      setSelectedPlanIdx(0);
      await refetch();
      toast.success(
        `Game Plan regenerated: ${result.tradeableCount} tradeable, ${result.waitCount} wait, ${result.skipCount} skip`,
      );
    },
    onError: (refreshError: Error) => {
      toast.error(`Game Plan refresh failed: ${refreshError.message}`);
    },
  });

  const currentPlan = useMemo(() => {
    if (!gamePlanLogs || gamePlanLogs.length === 0) return null;
    return gamePlanLogs[selectedPlanIdx]?.details_json || null;
  }, [gamePlanLogs, selectedPlanIdx]);

  const currentLog = useMemo(() => {
    if (!gamePlanLogs || gamePlanLogs.length === 0) return null;
    return gamePlanLogs[selectedPlanIdx] || null;
  }, [gamePlanLogs, selectedPlanIdx]);

  const tradeablePairs = useMemo(() => {
    if (!currentPlan) return [];
    return currentPlan.plans.filter(p => getPlanState(p) === "tradeable");
  }, [currentPlan]);

  const waitPairs = useMemo(() => {
    if (!currentPlan) return [];
    return currentPlan.plans.filter(p => getPlanState(p) === "wait");
  }, [currentPlan]);

  const skipPairs = useMemo(() => {
    if (!currentPlan) return [];
    return currentPlan.plans.filter(p => getPlanState(p) === "skip");
  }, [currentPlan]);

  if (isLoading) return <GamePlanSkeleton />;

  if (error || !currentPlan) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-6">
        <Activity className="h-10 w-10 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground font-mono">No game plan available yet</p>
        <p className="text-[10px] text-muted-foreground/60 font-mono mt-1">
          The bot will generate a game plan on the next scan cycle
        </p>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <ScrollArea className="h-full">
        <div className="p-3 space-y-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-cyan-400" />
              <span className="text-sm font-semibold font-mono">
                {currentPlan.session} Session
              </span>
              <Badge variant="outline" className="text-[9px] h-4 bg-badge-profit text-profit border-emerald-500/30">
                {tradeablePairs.length} TRADEABLE
              </Badge>
              <Badge variant="outline" className="text-[9px] h-4 bg-badge-warn text-warn border-orange-500/30">
                {waitPairs.length} WAIT
              </Badge>
              <Badge variant="outline" className="text-[9px] h-4 bg-zinc-500/10 text-muted-foreground border-zinc-500/30">
                {skipPairs.length} SKIP
              </Badge>
            </div>
            <div className="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setShowHistory(!showHistory)}
                    className="p-1 hover:bg-accent/50 transition-colors"
                  >
                    <History className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-[10px]">
                  View game plan history
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Regenerate game plan"
                    onClick={() => refreshGamePlan.mutate()}
                    disabled={refreshGamePlan.isPending}
                    className="p-1 hover:bg-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 text-muted-foreground ${refreshGamePlan.isPending ? "animate-spin" : ""}`} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-[10px]">
                  {refreshGamePlan.isPending ? "Generating new game plan…" : "Regenerate game plan now"}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Generated time */}
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono">
            <Clock className="h-3 w-3" />
            Generated: {formatDateTime(currentPlan.generated_at)}
            {currentLog && (
              <span className="text-zinc-600 ml-1">
                ({currentPlan.source === "manual_refresh" ? "manual" : "automatic"} · version {currentPlan.plan_version.slice(0, 8)})
              </span>
            )}
          </div>

          {/* History selector */}
          {showHistory && gamePlanLogs && gamePlanLogs.length > 1 && (
            <div className="border border-border/50 bg-background/30 p-2">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                Game Plan History
              </div>
              <div className="space-y-1">
                {gamePlanLogs.map((log, i) => (
                  <button
                    key={log.id}
                    onClick={() => { setSelectedPlanIdx(i); setShowHistory(false); }}
                    className={`w-full text-left flex items-center justify-between p-1.5 text-[10px] font-mono transition-colors ${
                      i === selectedPlanIdx
                        ? "bg-cyan-500/10 text-cyan-400"
                        : "hover:bg-accent/30 text-muted-foreground"
                    }`}
                  >
                    <span>{log.details_json.session} — {formatDateTime(log.scanned_at)}</span>
                    <span>{log.details_json.focus_pairs.length} focus</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* News Events */}
          {currentPlan.newsEvents && currentPlan.newsEvents.length > 0 && (
            <Card className="border-orange-500/20 bg-warning/5">
              <CardHeader className="pb-1.5 pt-2.5 px-3">
                <CardTitle className="text-[11px] font-mono flex items-center gap-1.5">
                  <Newspaper className="h-3.5 w-3.5 text-warn" />
                  Today's Events
                  <Badge variant="outline" className="text-[8px] h-3.5 bg-badge-warn text-warn border-orange-500/30 ml-auto">
                    {currentPlan.newsEvents.filter(e => e.impact === "high").length} HIGH
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-2.5">
                <NewsTimeline events={currentPlan.newsEvents} />
              </CardContent>
            </Card>
          )}

          {/* Tradeable Pairs */}
          {tradeablePairs.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Eye className="h-3.5 w-3.5 text-cyan-400" />
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Tradeable Pairs ({tradeablePairs.length})
                </span>
              </div>
              <div className="space-y-1.5">
                {tradeablePairs.map(plan => (
                  <BiasCard key={plan.symbol} plan={plan} />
                ))}
              </div>
            </div>
          )}

          {/* Waiting Pairs */}
          {waitPairs.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Clock className="h-3.5 w-3.5 text-warn" />
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Waiting for Conditions ({waitPairs.length})
                </span>
              </div>
              <div className="space-y-1.5">
                {waitPairs.map(plan => (
                  <BiasCard key={plan.symbol} plan={plan} />
                ))}
              </div>
            </div>
          )}

          {/* Skip Pairs */}
          {skipPairs.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Skipped ({skipPairs.length})
                </span>
              </div>
              <div className="space-y-1.5">
                {skipPairs.map(plan => (
                  <BiasCard key={plan.symbol} plan={plan} />
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </TooltipProvider>
  );
}
