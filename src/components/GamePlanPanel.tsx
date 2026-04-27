import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
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

interface InstrumentPlan {
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
  tradeable: boolean;
  skipReason?: string;
  scenarios: Scenario[];
  keyLevels: KeyLevel[];
}

interface GamePlanData {
  type: "game_plan";
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
  const { data, error } = await (supabase as any)
    .from("scan_logs")
    .select("id, scanned_at, details_json")
    .eq("details_json->>type", "game_plan")
    .order("scanned_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);
  return (data || []).filter((d: any) => d.details_json?.type === "game_plan");
}

// ─── Helpers ────────────────────────────────────────────────────────

function getBiasColor(bias: string) {
  if (bias === "bullish") return "text-emerald-400";
  if (bias === "bearish") return "text-red-400";
  return "text-zinc-400";
}

function getBiasBg(bias: string) {
  if (bias === "bullish") return "bg-emerald-500/10 border-emerald-500/30";
  if (bias === "bearish") return "bg-red-500/10 border-red-500/30";
  return "bg-zinc-500/10 border-zinc-500/30";
}

function getBiasIcon(bias: string) {
  if (bias === "bullish") return <TrendingUp className="h-4 w-4 text-emerald-400" />;
  if (bias === "bearish") return <TrendingDown className="h-4 w-4 text-red-400" />;
  return <Minus className="h-4 w-4 text-zinc-400" />;
}

function getConfidenceColor(confidence: number) {
  if (confidence >= 60) return "text-emerald-400";
  if (confidence >= 40) return "text-yellow-400";
  return "text-zinc-500";
}

function getLevelTypeIcon(type: string) {
  switch (type) {
    case "ob": return <Shield className="h-3 w-3 text-cyan-400" />;
    case "fvg": return <Zap className="h-3 w-3 text-purple-400" />;
    case "liquidity": return <Target className="h-3 w-3 text-orange-400" />;
    case "pd_level": return <MapPin className="h-3 w-3 text-yellow-400" />;
    default: return <Crosshair className="h-3 w-3 text-zinc-400" />;
  }
}

function getLevelTypeBadge(type: string) {
  const colors: Record<string, string> = {
    ob: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
    fvg: "bg-purple-500/15 text-purple-400 border-purple-500/30",
    liquidity: "bg-orange-500/15 text-orange-400 border-orange-500/30",
    pd_level: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    support: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    resistance: "bg-red-500/15 text-red-400 border-red-500/30",
  };
  return colors[type] || "bg-zinc-500/15 text-zinc-400 border-zinc-500/30";
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

function formatPrice(price: number, symbol: string) {
  if (symbol.includes("JPY")) return price.toFixed(3);
  if (symbol.includes("XAU") || symbol.includes("BTC")) return price.toFixed(2);
  return price.toFixed(5);
}

// ─── Sub-Components ─────────────────────────────────────────────────

function BiasCard({ plan }: { plan: InstrumentPlan }) {
  const [expanded, setExpanded] = useState(false);

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
          {!plan.tradeable && (
            <Badge variant="outline" className="text-[9px] h-4 bg-zinc-800/50 text-zinc-500 border-zinc-600">
              SKIP
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`font-mono text-xs font-bold uppercase ${getBiasColor(plan.bias)}`}>
            {plan.bias}
          </span>
          <span className={`font-mono text-[10px] ${getConfidenceColor(plan.biasConfidence)}`}>
            {plan.biasConfidence}%
          </span>
          {expanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
        </div>
      </div>

      {/* Quick info row */}
      <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground font-mono">
        <span>D1: {plan.htfTrend}</span>
        <span className="text-zinc-600">|</span>
        <span>4H: {plan.h4Trend}</span>
        <span className="text-zinc-600">|</span>
        <span>{plan.zone}</span>
        <span className="text-zinc-600">|</span>
        <span>{plan.regime}</span>
      </div>

      {/* DOL row */}
      {plan.dol && (
        <div className="flex items-center gap-1.5 mt-1.5">
          <Target className="h-3 w-3 text-cyan-400 shrink-0" />
          <span className="text-[10px] text-cyan-300 font-mono">
            DOL: {plan.dol.description} @ {formatPrice(plan.dol.price, plan.symbol)}
            <span className="text-zinc-500 ml-1">({plan.dol.distancePips.toFixed(0)} pips)</span>
          </span>
        </div>
      )}

      {/* Skip reason */}
      {plan.skipReason && (
        <div className="flex items-center gap-1.5 mt-1.5">
          <AlertTriangle className="h-3 w-3 text-yellow-500 shrink-0" />
          <span className="text-[10px] text-yellow-400 font-mono">{plan.skipReason}</span>
        </div>
      )}

      {/* Expanded content */}
      {expanded && (
        <div className="mt-3 space-y-3">
          <Separator className="bg-border/50" />

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
                            ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                            : "bg-red-500/15 text-red-400 border-red-500/30"
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
                      <span className="text-emerald-400">THEN:</span> {scenario.action}
                    </div>
                    {scenario.targetLevel && (
                      <div className="text-[10px] text-foreground/70 font-mono">
                        <span className="text-yellow-400">TARGET:</span> {formatPrice(scenario.targetLevel, plan.symbol)}
                      </div>
                    )}
                    {scenario.invalidation && (
                      <div className="text-[10px] text-foreground/70 font-mono">
                        <span className="text-red-400">INVALID:</span> {scenario.invalidation}
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
                            ? "text-yellow-400 border-yellow-500/30"
                            : level.significance === "medium"
                            ? "text-zinc-400 border-zinc-500/30"
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
              ev.impact === "high" ? "bg-red-500" : ev.impact === "medium" ? "bg-orange-400" : "bg-zinc-500"
            }`} />
            <span className="text-[10px] font-mono text-muted-foreground w-16 shrink-0">
              {formatTime(ev.time)} ET
            </span>
            <Badge
              variant="outline"
              className={`text-[8px] h-3.5 px-1 shrink-0 ${
                ev.impact === "high"
                  ? "bg-red-500/15 text-red-400 border-red-500/30"
                  : "bg-orange-500/15 text-orange-400 border-orange-500/30"
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

  const currentPlan = useMemo(() => {
    if (!gamePlanLogs || gamePlanLogs.length === 0) return null;
    return gamePlanLogs[selectedPlanIdx]?.details_json || null;
  }, [gamePlanLogs, selectedPlanIdx]);

  const currentLog = useMemo(() => {
    if (!gamePlanLogs || gamePlanLogs.length === 0) return null;
    return gamePlanLogs[selectedPlanIdx] || null;
  }, [gamePlanLogs, selectedPlanIdx]);

  // Separate focus and skip pairs
  const focusPairs = useMemo(() => {
    if (!currentPlan) return [];
    return currentPlan.plans.filter(p => p.tradeable && p.bias !== "neutral");
  }, [currentPlan]);

  const skipPairs = useMemo(() => {
    if (!currentPlan) return [];
    return currentPlan.plans.filter(p => !p.tradeable || p.bias === "neutral");
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
              <Badge variant="outline" className="text-[9px] h-4 bg-cyan-500/10 text-cyan-400 border-cyan-500/30">
                {currentPlan.focus_pairs.length} FOCUS
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
                    onClick={() => refetch()}
                    className="p-1 hover:bg-accent/50 transition-colors"
                  >
                    <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-[10px]">
                  Refresh game plan
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
                (scan: {formatDateTime(currentLog.scanned_at)})
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
            <Card className="border-orange-500/20 bg-orange-500/5">
              <CardHeader className="pb-1.5 pt-2.5 px-3">
                <CardTitle className="text-[11px] font-mono flex items-center gap-1.5">
                  <Newspaper className="h-3.5 w-3.5 text-orange-400" />
                  Today's Events
                  <Badge variant="outline" className="text-[8px] h-3.5 bg-orange-500/15 text-orange-400 border-orange-500/30 ml-auto">
                    {currentPlan.newsEvents.filter(e => e.impact === "high").length} HIGH
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-2.5">
                <NewsTimeline events={currentPlan.newsEvents} />
              </CardContent>
            </Card>
          )}

          {/* Focus Pairs */}
          {focusPairs.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Eye className="h-3.5 w-3.5 text-cyan-400" />
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Focus Pairs ({focusPairs.length})
                </span>
              </div>
              <div className="space-y-1.5">
                {focusPairs.map(plan => (
                  <BiasCard key={plan.symbol} plan={plan} />
                ))}
              </div>
            </div>
          )}

          {/* Skip / Neutral Pairs */}
          {skipPairs.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <EyeOff className="h-3.5 w-3.5 text-zinc-500" />
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Skipped / Neutral ({skipPairs.length})
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
