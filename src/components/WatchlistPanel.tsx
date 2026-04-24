import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { scannerApi, type StagedSetup } from "@/lib/api";
import { toast } from "sonner";
import {
  Eye, EyeOff, TrendingUp, TrendingDown, X, Clock,
  ChevronDown, ChevronUp, Loader2, Target, ShieldX,
  Zap, RefreshCw,
} from "lucide-react";

// ── Time helpers ──
function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ${min % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ttlRemaining(stagedAt: string, ttlMinutes: number): { text: string; pct: number; urgent: boolean } {
  const elapsed = (Date.now() - new Date(stagedAt).getTime()) / 60_000;
  const remaining = Math.max(0, ttlMinutes - elapsed);
  const pct = Math.max(0, Math.min(100, (remaining / ttlMinutes) * 100));
  if (remaining <= 0) return { text: "Expired", pct: 0, urgent: true };
  if (remaining < 15) return { text: `${Math.ceil(remaining)}m left`, pct, urgent: true };
  if (remaining < 60) return { text: `${Math.ceil(remaining)}m left`, pct, urgent: false };
  const hrs = Math.floor(remaining / 60);
  const mins = Math.ceil(remaining % 60);
  return { text: `${hrs}h ${mins}m left`, pct, urgent: false };
}

// ── Score bar component ──
function ScoreBar({ current, gate, watchThreshold }: { current: number; gate: number; watchThreshold: number }) {
  const barPct = Math.min(100, Math.max(0, current));
  const gatePct = Math.min(100, Math.max(0, gate));
  const watchPct = Math.min(100, Math.max(0, watchThreshold));
  return (
    <div className="relative h-2 bg-muted/30 rounded-full overflow-hidden">
      {/* Score fill */}
      <div
        className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${
          current >= gate ? "bg-success" : current >= gate * 0.8 ? "bg-amber-500" : "bg-muted-foreground/40"
        }`}
        style={{ width: `${barPct}%` }}
      />
      {/* Watch threshold marker */}
      <div
        className="absolute inset-y-0 w-px bg-muted-foreground/50"
        style={{ left: `${watchPct}%` }}
        title={`Watch threshold: ${watchThreshold}%`}
      />
      {/* Gate marker */}
      <div
        className="absolute inset-y-0 w-0.5 bg-primary"
        style={{ left: `${gatePct}%` }}
        title={`Trade gate: ${gate}%`}
      />
    </div>
  );
}

// ── Factor pill ──
function FactorPill({ name, tier, present }: { name: string; tier?: string; present: boolean }) {
  const tierColor = tier === "T1" ? "border-amber-500/40 text-amber-400"
    : tier === "T2" ? "border-blue-500/40 text-blue-400"
    : "border-muted-foreground/30 text-muted-foreground";
  return (
    <span className={`inline-flex items-center text-[8px] px-1.5 py-0 rounded border ${present ? tierColor : "border-border/40 text-muted-foreground/40 line-through"}`}>
      {tier && <span className="mr-0.5 font-bold">{tier}</span>}
      {name}
    </span>
  );
}

// ── Single staged setup card ──
function StagedSetupCard({ setup, gate, onDismiss, isDismissing }: {
  setup: StagedSetup;
  gate: number;
  onDismiss: (id: string) => void;
  isDismissing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const ttl = ttlRemaining(setup.staged_at, setup.ttl_minutes);
  const isNearGate = setup.current_score >= gate * 0.85;

  return (
    <div className={`border rounded-md p-2 transition-all ${
      isNearGate ? "border-amber-500/40 bg-amber-500/5" : "border-border/60 bg-card/50"
    }`}>
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {setup.direction === "long"
            ? <TrendingUp className="h-3 w-3 shrink-0 text-success" />
            : <TrendingDown className="h-3 w-3 shrink-0 text-destructive" />
          }
          <span className="font-bold text-[11px]">{setup.symbol}</span>
          <Badge variant="outline" className={`text-[7px] h-3.5 px-1 ${
            setup.direction === "long" ? "text-success border-success/30" : "text-destructive border-destructive/30"
          }`}>
            {setup.direction.toUpperCase()}
          </Badge>
          {setup.setup_type && (
            <span className="text-[8px] text-muted-foreground truncate">{setup.setup_type}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className={`font-mono font-bold text-[11px] ${
            setup.current_score >= gate ? "text-success" : isNearGate ? "text-amber-400" : "text-muted-foreground"
          }`}>
            {setup.current_score.toFixed(1)}%
          </span>
          <button
            onClick={() => onDismiss(setup.id)}
            disabled={isDismissing}
            className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
            title="Dismiss this setup"
          >
            {isDismissing ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {/* Score bar */}
      <div className="mt-1.5">
        <ScoreBar current={setup.current_score} gate={gate} watchThreshold={setup.watch_threshold} />
        <div className="flex justify-between text-[8px] text-muted-foreground mt-0.5">
          <span>Watch: {setup.watch_threshold}%</span>
          <span className="font-mono">{setup.current_score.toFixed(1)}% / {gate}%</span>
        </div>
      </div>

      {/* Meta row */}
      <div className="flex items-center justify-between mt-1.5 text-[9px] text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-0.5">
            <RefreshCw className="h-2.5 w-2.5" /> Cycle {setup.scan_cycles}
          </span>
          <span className="flex items-center gap-0.5">
            <Clock className="h-2.5 w-2.5" />
            <span className={ttl.urgent ? "text-destructive font-medium" : ""}>{ttl.text}</span>
          </span>
        </div>
        <span>{timeAgo(setup.staged_at)}</span>
      </div>

      {/* TTL progress bar */}
      <div className="h-0.5 bg-muted/20 rounded-full mt-1 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${ttl.urgent ? "bg-destructive" : "bg-primary/40"}`}
          style={{ width: `${ttl.pct}%` }}
        />
      </div>

      {/* Tier summary */}
      <div className="flex items-center gap-2 mt-1.5 text-[9px]">
        <span className="text-amber-400 font-medium">T1: {setup.tier1_count}/4</span>
        <span className="text-blue-400 font-medium">T2: {setup.tier2_count}/5</span>
        <span className="text-muted-foreground">T3: {setup.tier3_count}</span>
        {setup.current_score > setup.initial_score && (
          <span className="text-success text-[8px]">↑ {(setup.current_score - setup.initial_score).toFixed(1)}%</span>
        )}
        {setup.current_score < setup.initial_score && (
          <span className="text-destructive text-[8px]">↓ {(setup.initial_score - setup.current_score).toFixed(1)}%</span>
        )}
      </div>

      {/* Expand/collapse for factors */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-0.5 text-[8px] text-muted-foreground hover:text-foreground mt-1 transition-colors"
      >
        {expanded ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
        {expanded ? "Hide factors" : "Show factors"}
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1">
          {/* Present factors */}
          <div>
            <p className="text-[8px] text-muted-foreground uppercase tracking-wider mb-0.5">Present</p>
            <div className="flex flex-wrap gap-0.5">
              {setup.current_factors.map((f, i) => (
                <FactorPill key={i} name={f.name} tier={f.tier} present />
              ))}
            </div>
          </div>
          {/* Missing factors */}
          {setup.missing_factors.length > 0 && (
            <div>
              <p className="text-[8px] text-muted-foreground uppercase tracking-wider mb-0.5">Missing</p>
              <div className="flex flex-wrap gap-0.5">
                {setup.missing_factors.map((f, i) => (
                  <FactorPill key={i} name={f.name} tier={f.tier} present={false} />
                ))}
              </div>
            </div>
          )}
          {/* Key levels */}
          {(setup.entry_price || setup.sl_level || setup.tp_level) && (
            <div className="flex gap-3 text-[9px] font-mono mt-1">
              {setup.entry_price && <span className="text-muted-foreground">Entry: <span className="text-foreground">{Number(setup.entry_price).toFixed(5)}</span></span>}
              {setup.sl_level && <span className="text-muted-foreground">SL: <span className="text-destructive">{Number(setup.sl_level).toFixed(5)}</span></span>}
              {setup.tp_level && <span className="text-muted-foreground">TP: <span className="text-success">{Number(setup.tp_level).toFixed(5)}</span></span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Watchlist Panel ──
export function WatchlistPanel({ confluenceGate }: { confluenceGate: number }) {
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const { data: activeSetups, isLoading: loadingActive } = useQuery({
    queryKey: ["staged-setups-active"],
    queryFn: () => scannerApi.activeStaged(),
    refetchInterval: 15000, // Refresh every 15s to stay current
  });

  const { data: allSetups, isLoading: loadingAll } = useQuery({
    queryKey: ["staged-setups-all"],
    queryFn: () => scannerApi.allStaged(),
    enabled: showHistory,
    refetchInterval: 30000,
  });

  const dismissMut = useMutation({
    mutationFn: (setupId: string) => scannerApi.dismissStaged(setupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staged-setups-active"] });
      queryClient.invalidateQueries({ queryKey: ["staged-setups-all"] });
      toast.success("Setup dismissed");
    },
    onError: (err: any) => toast.error(err.message || "Failed to dismiss"),
  });

  const active = activeSetups || [];
  const history = (allSetups || []).filter(s => s.status !== "watching");
  const nearGateCount = active.filter(s => s.current_score >= confluenceGate * 0.85).length;

  return (
    <Card className="border-amber-500/20">
      <CardContent className="pt-3 pb-2">
        {/* Header */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full flex items-center justify-between mb-1"
        >
          <div className="flex items-center gap-1.5">
            <Eye className="h-3.5 w-3.5 text-amber-400" />
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
              Watchlist
            </span>
            {active.length > 0 && (
              <Badge variant="outline" className="text-[8px] h-4 px-1 border-amber-500/30 text-amber-400">
                {active.length}
              </Badge>
            )}
            {nearGateCount > 0 && (
              <Badge variant="outline" className="text-[8px] h-4 px-1 border-success/30 text-success animate-pulse">
                <Zap className="h-2 w-2 mr-0.5" /> {nearGateCount} near gate
              </Badge>
            )}
          </div>
          {collapsed ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronUp className="h-3 w-3 text-muted-foreground" />}
        </button>

        {!collapsed && (
          <div className="space-y-1.5">
            {loadingActive ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : active.length === 0 ? (
              <p className="text-[10px] text-muted-foreground text-center py-3">
                No setups being watched. Setups scoring {confluenceGate > 0 ? `${Math.round(confluenceGate * 0.45)}%–${confluenceGate}%` : "between watch threshold and gate"} with at least 1 Tier 1 factor will appear here.
              </p>
            ) : (
              active.map(setup => (
                <StagedSetupCard
                  key={setup.id}
                  setup={setup}
                  gate={confluenceGate}
                  onDismiss={(id) => dismissMut.mutate(id)}
                  isDismissing={dismissMut.isPending}
                />
              ))
            )}

            {/* History toggle */}
            <div className="border-t border-border/30 pt-1 mt-1">
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {showHistory ? <EyeOff className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
                {showHistory ? "Hide history" : "Show resolved setups"}
              </button>

              {showHistory && (
                <div className="mt-1.5 space-y-1 max-h-40 overflow-y-auto">
                  {loadingAll ? (
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground mx-auto" />
                  ) : history.length === 0 ? (
                    <p className="text-[9px] text-muted-foreground text-center py-2">No resolved setups yet</p>
                  ) : (
                    history.slice(0, 20).map(s => (
                      <div key={s.id} className="flex items-center justify-between text-[9px] py-0.5 px-1.5 rounded bg-muted/10">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {s.direction === "long"
                            ? <TrendingUp className="h-2.5 w-2.5 text-success shrink-0" />
                            : <TrendingDown className="h-2.5 w-2.5 text-destructive shrink-0" />
                          }
                          <span className="font-medium">{s.symbol}</span>
                          <Badge variant="outline" className={`text-[7px] h-3 px-1 ${
                            s.status === "promoted" ? "text-success border-success/30"
                            : s.status === "expired" ? "text-muted-foreground border-border"
                            : "text-destructive border-destructive/30"
                          }`}>
                            {s.status === "promoted" ? <Target className="h-2 w-2 mr-0.5" /> : s.status === "invalidated" ? <ShieldX className="h-2 w-2 mr-0.5" /> : <Clock className="h-2 w-2 mr-0.5" />}
                            {s.status.toUpperCase()}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="font-mono text-[8px]">{s.initial_score.toFixed(0)}% → {s.current_score.toFixed(0)}%</span>
                          <span className="text-muted-foreground text-[8px]">{s.scan_cycles} cycles</span>
                          <span className="text-muted-foreground text-[8px]">{timeAgo(s.resolved_at || s.updated_at)}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
