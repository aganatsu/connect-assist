import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { WorkspaceBody, WorkspaceHeader, WorkspacePage } from "@/components/WorkspacePage";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OverflowText } from "@/components/ui/overflow-text";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
  Clock, Play, Pause, RotateCw, Zap, BarChart3, Wrench,
  CheckCircle2, XCircle, Minus, ChevronDown, ChevronUp,
  AlertTriangle, Rocket, ExternalLink, Loader2,
} from "lucide-react";
import { invokeFunction } from "@/lib/api";

interface ScheduledTask {
  id: string;
  function_name: string;
  action: string;
  display_name: string;
  description: string;
  category: string;
  enabled: boolean;
  interval_minutes: number;
  cron_expression: string;
  last_run_at: string | null;
  last_status: "success" | "error" | "running" | "invoked" | "skipped" | null;
  last_error: string | null;
  run_count: number;
  runtime?: {
    run_id: string;
    trigger_source: "cron" | "manual";
    status: "invoked" | "running" | "completed" | "failed" | "skipped";
    phase: string;
    cron_invoked_at: string;
    scan_started_at: string | null;
    pair_processing_completed_at: string | null;
    scan_completed_at: string | null;
    position_management_completed_at: string | null;
    heartbeat_at: string;
    expected_pairs: number | null;
    processed_pairs: number | null;
    error_code: string | null;
    error_message: string | null;
    metadata: Record<string, unknown> | null;
  };
}

interface OperationalAlert {
  id: string;
  bot_id: string;
  alert_type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  occurrences: number;
  first_detected_at: string;
  last_detected_at: string;
  evidence: Record<string, unknown>;
}

interface ScheduledTasksPayload {
  tasks: ScheduledTask[];
  alerts: OperationalAlert[];
}

interface DeploymentStatus {
  authorized: boolean;
  configured: boolean;
  run: null | {
    id: number;
    status: "queued" | "in_progress" | "completed";
    conclusion: "success" | "failure" | "cancelled" | null;
    createdAt: string;
    updatedAt: string;
    url: string;
    commit: string;
  };
}

const CATEGORY_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  scanning: { label: "Scanning", icon: Zap, color: "text-cyan-400" },
  management: { label: "Management", icon: Wrench, color: "text-amber-400" },
  analytics: { label: "Analytics", icon: BarChart3, color: "text-violet-400" },
  maintenance: { label: "Maintenance", icon: RotateCw, color: "text-gray-400" },
};

const INTERVAL_OPTIONS = [
  { value: "1", label: "1 min" },
  { value: "2", label: "2 min" },
  { value: "3", label: "3 min" },
  { value: "5", label: "5 min" },
  { value: "10", label: "10 min" },
  { value: "15", label: "15 min" },
  { value: "30", label: "30 min" },
  { value: "60", label: "1 hour" },
  { value: "360", label: "6 hours" },
  { value: "720", label: "12 hours" },
  { value: "1440", label: "24 hours" },
  { value: "10080", label: "7 days" },
];

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatInterval(minutes: number): string {
  if (minutes < 60) return `Every ${minutes} min`;
  if (minutes < 1440) return `Every ${minutes / 60}h`;
  if (minutes === 1440) return "Daily";
  if (minutes === 10080) return "Weekly";
  return `Every ${Math.floor(minutes / 1440)}d`;
}

function formatPhase(phase?: string): string {
  if (!phase) return "No runtime evidence";
  const labels: Record<string, string> = {
    cron_invoked: "Cron invoked",
    manual_invoked: "Manual run invoked",
    scan_started: "Scan started",
    pair_processing_started: "Pair processing started",
    pair_processing: "Processing pairs",
    pair_processing_completed: "Pair processing completed",
    position_management_started: "Management started",
    position_management_running: "Managing positions",
    confirmation_processing_started: "Confirmation scan started",
    confirmation_processing: "Checking confirmations",
    completed: "Completed",
    skipped: "Skipped",
    failed: "Failed",
  };
  return labels[phase] || phase.replace(/_/g, " ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function ScheduledTasks() {
  const queryClient = useQueryClient();
  const [expandedTask, setExpandedTask] = useState<string | null>(null);

  const { data, isLoading } = useQuery<ScheduledTasksPayload>({
    queryKey: ["scheduled-tasks"],
    queryFn: async () => {
      const res = await invokeFunction("scheduled-tasks", { action: "list" });
      return {
        tasks: res?.tasks || [],
        alerts: res?.alerts || [],
      };
    },
    refetchInterval: 30000,
  });
  const tasks = data?.tasks || [];
  const alerts = data?.alerts || [];

  const deploymentQuery = useQuery<DeploymentStatus>({
    queryKey: ["edge-function-deployment"],
    queryFn: async () => {
      try {
        return await invokeFunction("deploy-control", { action: "status" });
      } catch {
        return { authorized: false, configured: false, run: null };
      }
    },
    refetchInterval: (query) => {
      const status = query.state.data?.run?.status;
      return status === "queued" || status === "in_progress" ? 5000 : 30000;
    },
    retry: false,
  });

  const deployMutation = useMutation({
    mutationFn: async () => invokeFunction("deploy-control", { action: "deploy" }),
    onSuccess: () => {
      toast.success("Edge-function deployment queued");
      setTimeout(() => deploymentQuery.refetch(), 1500);
    },
    onError: (err: unknown) => {
      toast.error("Deployment could not be started", { description: errorMessage(err) });
    },
  });

  const deployment = deploymentQuery.data;
  const deploymentRunning = deployment?.run?.status === "queued" || deployment?.run?.status === "in_progress";
  const deployAll = () => {
    if (!window.confirm("Redeploy every production edge function from main? Active requests may briefly use mixed versions during rollout.")) return;
    deployMutation.mutate();
  };

  const updateMutation = useMutation({
    mutationFn: async (params: { taskId: string; enabled?: boolean; interval_minutes?: number }) => {
      return invokeFunction("scheduled-tasks", { action: "update", ...params });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
    },
    onError: (err: unknown) => {
      toast.error("Failed to update task", { description: errorMessage(err) });
    },
  });

  const runNowMutation = useMutation({
    mutationFn: async (taskId: string) => {
      return invokeFunction("scheduled-tasks", { action: "run_now", taskId });
    },
    onSuccess: (data) => {
      if (data?.ok) {
        toast.success("Task triggered successfully");
      } else {
        toast.error("Task failed", { description: data?.error });
      }
      queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
    },
    onError: (err: unknown) => {
      toast.error("Failed to trigger task", { description: errorMessage(err) });
    },
  });

  const handleToggle = (task: ScheduledTask) => {
    updateMutation.mutate({ taskId: task.id, enabled: !task.enabled });
    toast(task.enabled ? "Task paused" : "Task resumed", {
      description: task.display_name,
    });
  };

  const handleIntervalChange = (task: ScheduledTask, value: string) => {
    const minutes = parseInt(value);
    updateMutation.mutate({ taskId: task.id, interval_minutes: minutes });
    toast.success("Interval updated", {
      description: `${task.display_name} → ${formatInterval(minutes)}`,
    });
  };

  const handleRunNow = (task: ScheduledTask) => {
    runNowMutation.mutate(task.id);
  };

  // Group by category
  const grouped = tasks.reduce<Record<string, ScheduledTask[]>>((acc, task) => {
    const cat = task.category || "other";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(task);
    return acc;
  }, {});

  const categoryOrder = ["scanning", "management", "analytics", "maintenance"];

  return (
    <AppShell>
      <WorkspacePage>
        <WorkspaceHeader
          icon={Clock}
          eyebrow="Automation"
          title="Scheduled Tasks"
          description="Manage cron jobs, intervals, and manual runs."
          actions={<Badge variant="outline" className="text-xs">
            {tasks.filter((t) => t.enabled).length}/{tasks.length} active
          </Badge>}
        />
        <WorkspaceBody>
          <div className="max-w-4xl mx-auto space-y-6">

        {deployment?.authorized && (
          <Card className="border-primary/40 bg-primary/5">
            <CardContent className="p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <Rocket className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">Production Edge Functions</span>
                      {deploymentRunning ? (
                        <Badge variant="outline" className="gap-1 text-[10px]">
                          <Loader2 className="h-3 w-3 animate-spin" /> Deploying
                        </Badge>
                      ) : deployment.run?.conclusion === "success" ? (
                        <Badge variant="outline" className="border-success/40 text-success text-[10px]">Deployed</Badge>
                      ) : deployment.run?.conclusion ? (
                        <Badge variant="destructive" className="text-[10px]">{deployment.run.conclusion}</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">Ready</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Redeploys every Supabase edge function from the latest commit on main. Migrations and the frontend are not included.
                    </p>
                    {deployment.run && (
                      <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
                        <span>Last started {formatTimeAgo(deployment.run.createdAt)}</span>
                        <a href={deployment.run.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                          View logs <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    )}
                  </div>
                </div>
                <Button onClick={deployAll} disabled={deploymentRunning || deployMutation.isPending || !deployment.configured} className="shrink-0 gap-2">
                  {deploymentRunning || deployMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                  {deploymentRunning ? "Deploying" : "Redeploy All"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {alerts.length > 0 && (
          <Card className="border-destructive/50 bg-destructive/5">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <div className="font-semibold text-sm">
                  Operational alert{alerts.length === 1 ? "" : "s"} ({alerts.length})
                </div>
                <Badge variant="destructive" className="ml-auto text-[10px]">
                  Automatic
                </Badge>
              </div>
              <div className="space-y-2">
                {alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className="rounded-md border border-border/60 bg-background/60 p-3"
                  >
                    <div className="flex items-start gap-3">
                      <Badge
                        variant={alert.severity === "critical" ? "destructive" : "outline"}
                        className="mt-0.5 text-[10px] uppercase"
                      >
                        {alert.severity}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{alert.title}</div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {alert.message}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-1">
                          Last detected {formatTimeAgo(alert.last_detected_at)}
                          {alert.occurrences > 1
                            ? ` · repeated ${alert.occurrences} times`
                            : ""}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                These alerts clear automatically after the underlying scanner condition recovers.
              </p>
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 bg-secondary/30 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : (
          categoryOrder.map((cat) => {
            const catTasks = grouped[cat];
            if (!catTasks || catTasks.length === 0) return null;
            const meta = CATEGORY_META[cat] || { label: cat, icon: Clock, color: "text-muted-foreground" };
            const CatIcon = meta.icon;

            return (
              <div key={cat} className="space-y-2">
                <div className="flex items-center gap-2 px-1">
                  <CatIcon className={`h-3.5 w-3.5 ${meta.color}`} />
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {meta.label}
                  </span>
                </div>

                <div className="space-y-2">
                  {catTasks.map((task) => {
                    const isExpanded = expandedTask === task.id;

                    return (
                      <Card
                        key={task.id}
                        className={`transition-all border ${
                          task.enabled
                            ? "border-border/50 bg-card"
                            : "border-border/30 bg-card/50 opacity-60"
                        }`}
                      >
                        <CardContent className="p-4">
                          {/* Main row */}
                          <div className="flex items-center gap-4">
                            {/* Toggle */}
                            <Switch
                              checked={task.enabled}
                              onCheckedChange={() => handleToggle(task)}
                              className="shrink-0"
                            />

                            {/* Info */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <OverflowText
                                  text={task.display_name}
                                  className="block text-sm font-medium"
                                />
                                {task.last_status === "success" && (
                                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                                )}
                                {task.last_status === "error" && (
                                  <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                                )}
                                {(task.last_status === "running" || task.last_status === "invoked") && (
                                  <RotateCw className="h-3.5 w-3.5 text-cyan-400 shrink-0 animate-spin" />
                                )}
                                {(!task.last_status || task.last_status === "skipped") && (
                                  <Minus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                )}
                              </div>
                              <OverflowText
                                text={task.runtime
                                  ? `${formatPhase(task.runtime.phase)}${
                                    task.runtime.expected_pairs !== null
                                      ? ` · ${task.runtime.processed_pairs ?? 0}/${task.runtime.expected_pairs} pairs`
                                      : ""
                                  } · ${task.runtime.trigger_source}`
                                  : task.description}
                                className="mt-0.5 hidden text-xs text-muted-foreground md:block"
                              />
                            </div>

                            {/* Interval selector */}
                            <div className="hidden sm:block shrink-0">
                              <Select
                                value={String(task.interval_minutes)}
                                onValueChange={(v) => handleIntervalChange(task, v)}
                              >
                                <SelectTrigger className="w-[110px] h-8 text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {INTERVAL_OPTIONS.map((opt) => (
                                    <SelectItem key={opt.value} value={opt.value}>
                                      {opt.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>

                            {/* Last run */}
                            <div className="hidden md:block text-xs text-muted-foreground w-16 text-right shrink-0">
                              {formatTimeAgo(task.last_run_at)}
                            </div>

                            {/* Run now */}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 w-8 p-0 shrink-0"
                              onClick={() => handleRunNow(task)}
                              disabled={runNowMutation.isPending}
                              title="Run now"
                            >
                              <Play className="h-3.5 w-3.5" />
                            </Button>

                            {/* Expand */}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 w-8 p-0 shrink-0 md:hidden"
                              onClick={() => setExpandedTask(isExpanded ? null : task.id)}
                            >
                              {isExpanded ? (
                                <ChevronUp className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </div>

                          {/* Mobile expanded details */}
                          {isExpanded && (
                            <div className="mt-3 pt-3 border-t border-border/50 space-y-3 md:hidden">
                              <p className="text-xs text-muted-foreground">{task.description}</p>
                              <div className="flex items-center justify-between">
                                <span className="text-xs text-muted-foreground">Interval</span>
                                <Select
                                  value={String(task.interval_minutes)}
                                  onValueChange={(v) => handleIntervalChange(task, v)}
                                >
                                  <SelectTrigger className="w-[110px] h-8 text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {INTERVAL_OPTIONS.map((opt) => (
                                      <SelectItem key={opt.value} value={opt.value}>
                                        {opt.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-xs text-muted-foreground">Last run</span>
                                <span className="text-xs">{formatTimeAgo(task.last_run_at)}</span>
                              </div>
                              {task.runtime && (
                                <>
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs text-muted-foreground">Exact stop point</span>
                                    <span className="text-xs">{formatPhase(task.runtime.phase)}</span>
                                  </div>
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs text-muted-foreground">Triggered by</span>
                                    <span className="text-xs capitalize">{task.runtime.trigger_source}</span>
                                  </div>
                                  {task.runtime.expected_pairs !== null && (
                                    <div className="flex items-center justify-between">
                                      <span className="text-xs text-muted-foreground">Pair progress</span>
                                      <span className="text-xs font-mono">
                                        {task.runtime.processed_pairs ?? 0}/{task.runtime.expected_pairs}
                                      </span>
                                    </div>
                                  )}
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs text-muted-foreground">Last heartbeat</span>
                                    <span className="text-xs">{formatTimeAgo(task.runtime.heartbeat_at)}</span>
                                  </div>
                                </>
                              )}
                              {task.last_error && (
                                <div className="text-xs text-destructive bg-destructive/10 p-2 rounded">
                                  {task.last_error}
                                </div>
                              )}
                              <div className="flex items-center justify-between">
                                <span className="text-xs text-muted-foreground">Total runs</span>
                                <span className="text-xs font-mono">{task.run_count}</span>
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}

        {/* Footer note */}
        <p className="text-xs text-muted-foreground text-center pt-4 border-t border-border/30">
          Tasks run via pg_cron. Changing the Bot Scanner interval also updates your scan interval setting.
        </p>
          </div>
        </WorkspaceBody>
      </WorkspacePage>
    </AppShell>
  );
}
