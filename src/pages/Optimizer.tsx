/**
 * Optimizer — Autonomous TPE-based config optimization dashboard.
 * Shows run history, live progress, trigger controls, and rollback.
 * Calls the Supabase `optimizer` edge function for actions and reads
 * the `optimizer_runs` / `config_backups` tables via the Supabase client.
 */

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  Zap, Play, Square, RotateCcw, CheckCircle2, XCircle,
  Clock, TrendingUp, AlertTriangle, Loader2, FlaskConical, RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { AppShell } from "@/components/AppShell";

// ─── Types ───

interface OptimizerRun {
  id: string;
  user_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  progress: number;
  progress_message: string | null;
  trials_count: number;
  baseline_score: number | null;
  best_score: number | null;
  improvement_percent: number | null;
  auto_applied: boolean;
  reject_reason: string | null;
  config_snapshot: Record<string, any> | null;
  result_summary: Record<string, any> | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

interface ConfigBackup {
  id: string;
  config_id: string;
  config_json: Record<string, any>;
  reason: string;
  optimizer_run_id: string | null;
  created_at: string;
}

// ─── Helpers ───

async function invokeOptimizer(body: Record<string, any>) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("Not authenticated");

  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/optimizer`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      },
      body: JSON.stringify(body),
    }
  );

  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { message: text }; }

  if (!response.ok) {
    throw new Error(data?.error || data?.message || `Error ${response.status}`);
  }
  return data;
}

// ─── Status Badge ───

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    running: "default",
    completed: "secondary",
    failed: "destructive",
    cancelled: "outline",
  };

  return (
    <Badge variant={variants[status] || "outline"} className="gap-1 text-[10px] uppercase font-mono">
      {status === "running" && <Loader2 className="w-3 h-3 animate-spin" />}
      {status === "completed" && <CheckCircle2 className="w-3 h-3" />}
      {status === "failed" && <XCircle className="w-3 h-3" />}
      {status}
    </Badge>
  );
}

// ─── Run Card ───

function RunCard({ run, onRollback }: { run: OptimizerRun; onRollback?: (id: string) => void }) {
  const startedAt = run.started_at ? new Date(run.started_at).toLocaleString() : "—";
  const duration = run.completed_at && run.started_at
    ? Math.round((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1000 / 60)
    : null;

  return (
    <Card className="border-border/50">
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <StatusBadge status={run.status} />
            {run.auto_applied && (
              <Badge variant="secondary" className="gap-1 text-[10px] bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
                <CheckCircle2 className="w-3 h-3" /> Applied
              </Badge>
            )}
          </div>
          <span className="text-[10px] font-mono text-muted-foreground">{startedAt}</span>
        </div>

        {/* Progress (if running) */}
        {run.status === "running" && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
              <span>{run.progress_message || "Processing..."}</span>
              <span>{run.progress}%</span>
            </div>
            <Progress value={run.progress} className="h-1.5" />
          </div>
        )}

        {/* Stats */}
        {run.status === "completed" && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <div className="text-[10px] font-mono text-muted-foreground uppercase">Trials</div>
              <div className="text-sm font-bold">{run.trials_count || 0}</div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-muted-foreground uppercase">Baseline</div>
              <div className="text-sm font-bold">{run.baseline_score?.toFixed(2) ?? "—"}</div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-muted-foreground uppercase">Best</div>
              <div className="text-sm font-bold text-primary">{run.best_score?.toFixed(2) ?? "—"}</div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-muted-foreground uppercase">Improvement</div>
              <div className={`text-sm font-bold ${(run.improvement_percent ?? 0) > 0 ? "text-emerald-500" : "text-muted-foreground"}`}>
                {run.improvement_percent != null ? `+${run.improvement_percent.toFixed(1)}%` : "—"}
              </div>
            </div>
          </div>
        )}

        {/* Reject reason */}
        {run.reject_reason && (
          <div className="flex items-start gap-2 text-[11px] text-amber-500 bg-amber-500/5 border border-amber-500/10 rounded-md px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{run.reject_reason}</span>
          </div>
        )}

        {/* Error */}
        {run.error_message && (
          <div className="flex items-start gap-2 text-[11px] text-destructive bg-destructive/5 border border-destructive/10 rounded-md px-3 py-2">
            <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{run.error_message}</span>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-1 border-t border-border/30">
          <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
            {duration != null && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" /> {duration}m
              </span>
            )}
          </div>
          {run.auto_applied && onRollback && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRollback(run.id)}
              className="h-6 px-2 text-[10px] font-mono text-amber-500 hover:text-amber-400"
            >
              <RotateCcw className="w-3 h-3 mr-1" /> Rollback
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ───

export default function Optimizer() {
  const { toast } = useToast();
  const [runs, setRuns] = useState<OptimizerRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [trials, setTrials] = useState(30);
  const [dryRun, setDryRun] = useState(false);
  const [coreOnly, setCoreOnly] = useState(false);

  // ─── Fetch runs ───
  const fetchRuns = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("optimizer_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(20);

      if (error) throw error;
      setRuns((data as OptimizerRun[]) || []);
    } catch (err: any) {
      console.error("[Optimizer] Failed to fetch runs:", err);
      // Table might not exist yet — show empty state
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  // Auto-refresh when a run is active
  const hasActiveRun = runs.some((r) => r.status === "running");

  useEffect(() => {
    if (!hasActiveRun) return;
    const interval = setInterval(fetchRuns, 5000);
    return () => clearInterval(interval);
  }, [hasActiveRun, fetchRuns]);

  // ─── Trigger ───
  const handleTrigger = async () => {
    setTriggering(true);
    try {
      const result = await invokeOptimizer({
        action: "start",
        source: "manual",
        trials,
        dryRun,
        coreOnly,
      });
      toast({
        title: "Optimization started",
        description: `Run ID: ${result.runId?.slice(0, 8) || "unknown"}...`,
      });
      fetchRuns();
    } catch (err: any) {
      toast({
        title: "Failed to start optimization",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setTriggering(false);
    }
  };

  // ─── Cancel ───
  const handleCancel = async (runId: string) => {
    try {
      await invokeOptimizer({ action: "cancel", runId });
      toast({ title: "Optimization cancelled" });
      fetchRuns();
    } catch (err: any) {
      toast({ title: "Cancel failed", description: err.message, variant: "destructive" });
    }
  };

  // ─── Rollback ───
  const handleRollback = async (runId: string) => {
    try {
      // Find the backup for this run
      const { data: backups } = await supabase
        .from("config_backups")
        .select("id,config_id,config_snapshot")
        .eq("backup_id", runId)
        .limit(1);

      if (!backups || backups.length === 0) {
        toast({ title: "No backup found for this run", variant: "destructive" });
        return;
      }

      const backup = backups[0];

      // Write the backup config back
      const { error } = await supabase
        .from("bot_configs")
        .update({ config_json: backup.config_snapshot as any })
        .eq("id", backup.config_id);

      if (error) throw error;

      toast({ title: "Config rolled back successfully" });
      fetchRuns();
    } catch (err: any) {
      toast({ title: "Rollback failed", description: err.message, variant: "destructive" });
    }
  };

  const activeRun = runs.find((r) => r.status === "running");

  return (
    <AppShell>
      <div className="p-1 sm:p-2 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Zap className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold">Autonomous Optimizer</h1>
            <p className="text-xs text-muted-foreground">
              TPE-based config optimization with walk-forward validation
            </p>
          </div>
        </div>
        {hasActiveRun && (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            <span className="text-[10px] font-mono text-primary uppercase">Running</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-mono flex items-center gap-2">
            <FlaskConical className="w-4 h-4" />
            New Optimization Run
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Trials */}
            <div className="space-y-1.5">
              <Label className="text-[10px] font-mono uppercase text-muted-foreground">Trials</Label>
              <Input
                type="number"
                min={5}
                max={100}
                value={trials}
                onChange={(e) => setTrials(Number(e.target.value))}
                className="h-8 font-mono"
              />
            </div>
            {/* Toggles */}
            <div className="flex items-end gap-4">
              <div className="flex items-center gap-2">
                <Switch id="dry-run" checked={dryRun} onCheckedChange={setDryRun} />
                <Label htmlFor="dry-run" className="text-xs">Dry Run</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="core-only" checked={coreOnly} onCheckedChange={setCoreOnly} />
                <Label htmlFor="core-only" className="text-xs">Core Only</Label>
              </div>
            </div>
            {/* Button */}
            <div className="flex items-end">
              {activeRun ? (
                <Button
                  variant="destructive"
                  size="sm"
                  className="w-full h-8"
                  onClick={() => handleCancel(activeRun.id)}
                >
                  <Square className="w-3.5 h-3.5 mr-1.5" /> Cancel Run
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="w-full h-8"
                  onClick={handleTrigger}
                  disabled={triggering}
                >
                  {triggering ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  {triggering ? "Starting..." : "Start Optimization"}
                </Button>
              )}
            </div>
          </div>

          {/* Info */}
          <div className="text-[10px] font-mono text-muted-foreground flex flex-wrap items-center gap-2">
            <span>Auto-runs every Sunday 22:00 UTC</span>
            <span className="text-border">•</span>
            <span>{trials} trials × ~5min each ≈ {Math.ceil(trials * 5 / 60)}h</span>
            <span className="text-border">•</span>
            <span>Chunked: {Math.ceil(trials / 3)} invocations</span>
          </div>
        </CardContent>
      </Card>

      {/* Active Run Progress */}
      {activeRun && (
        <Card className="border-primary/20">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-mono text-primary">
              <Loader2 className="w-4 h-4 animate-spin" />
              Active Run
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
                <span>{activeRun.progress_message || "Processing..."}</span>
                <span>{activeRun.progress}%</span>
              </div>
              <Progress value={activeRun.progress} className="h-2" />
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="text-[10px] font-mono text-muted-foreground">Trials Done</div>
                <div className="text-sm font-bold">{activeRun.trials_count || 0}</div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground">Best Score</div>
                <div className="text-sm font-bold text-primary">{activeRun.best_score?.toFixed(2) ?? "—"}</div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground">Baseline</div>
                <div className="text-sm font-bold">{activeRun.baseline_score?.toFixed(2) ?? "—"}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Run History */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-mono text-muted-foreground flex items-center gap-2">
            <TrendingUp className="w-4 h-4" /> Run History
          </h2>
          <Button variant="ghost" size="sm" onClick={fetchRuns} className="h-6 px-2">
            <RefreshCw className="w-3 h-3" />
          </Button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        )}

        {!loading && runs.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <Zap className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No optimization runs yet</p>
              <p className="text-[10px] font-mono mt-1">Start your first run above or wait for the weekly cron</p>
            </CardContent>
          </Card>
        )}

        {runs.filter((r) => r.status !== "running").map((run) => (
          <RunCard key={run.id} run={run} onRollback={handleRollback} />
        ))}
      </div>
      </div>
    </AppShell>
  );
}
