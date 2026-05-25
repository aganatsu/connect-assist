import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
  Clock, Play, Pause, RotateCw, Zap, BarChart3, Wrench,
  CheckCircle2, XCircle, Minus, ChevronDown, ChevronUp,
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
  last_status: "success" | "error" | null;
  last_error: string | null;
  run_count: number;
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

export default function ScheduledTasks() {
  const queryClient = useQueryClient();
  const [expandedTask, setExpandedTask] = useState<string | null>(null);

  const { data: tasks = [], isLoading } = useQuery<ScheduledTask[]>({
    queryKey: ["scheduled-tasks"],
    queryFn: async () => {
      const res = await invokeFunction("scheduled-tasks", { action: "list" });
      return res?.tasks || [];
    },
    refetchInterval: 30000,
  });

  const updateMutation = useMutation({
    mutationFn: async (params: { taskId: string; enabled?: boolean; interval_minutes?: number }) => {
      return invokeFunction("scheduled-tasks", { action: "update", ...params });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
    },
    onError: (err: any) => {
      toast.error("Failed to update task", { description: err.message });
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
    onError: (err: any) => {
      toast.error("Failed to trigger task", { description: err.message });
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
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              Scheduled Tasks
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Manage cron jobs — pause, resume, change intervals, or trigger manually
            </p>
          </div>
          <Badge variant="outline" className="text-xs">
            {tasks.filter((t) => t.enabled).length}/{tasks.length} active
          </Badge>
        </div>

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
                                <span className="font-medium text-sm truncate">
                                  {task.display_name}
                                </span>
                                {task.last_status === "success" && (
                                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                                )}
                                {task.last_status === "error" && (
                                  <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                                )}
                                {!task.last_status && (
                                  <Minus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground truncate mt-0.5 hidden md:block">
                                {task.description}
                              </p>
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
                              {task.last_error && (
                                <div className="text-xs text-red-400 bg-red-500/10 p-2 rounded">
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
    </AppShell>
  );
}
