import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/marketData";
import { paperApi, scannerApi } from "@/lib/api";
import { toast } from "sonner";
import {
  Play, Pause, Square, AlertTriangle, Scan, Loader2,
  TrendingUp, TrendingDown, Minus, Clock,
} from "lucide-react";

export default function BotView() {
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useQuery({
    queryKey: ["paper-status"],
    queryFn: () => paperApi.status(),
    refetchInterval: 5000,
  });

  const { data: scanLogs } = useQuery({
    queryKey: ["scan-logs"],
    queryFn: () => scannerApi.logs(),
    refetchInterval: 30000,
  });

  const startMutation = useMutation({
    mutationFn: () => paperApi.startEngine(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Engine started"); },
  });
  const pauseMutation = useMutation({
    mutationFn: () => paperApi.pauseEngine(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Engine paused"); },
  });
  const stopMutation = useMutation({
    mutationFn: () => paperApi.stopEngine(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Engine stopped"); },
  });
  const killMutation = useMutation({
    mutationFn: () => paperApi.killSwitch(true),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.error("Kill switch activated"); },
  });
  const resetMutation = useMutation({
    mutationFn: () => paperApi.resetAccount(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Account reset"); },
  });

  const scanMutation = useMutation({
    mutationFn: () => scannerApi.manualScan(),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["paper-status"] });
      queryClient.invalidateQueries({ queryKey: ["scan-logs"] });
      toast.success(`Scan complete: ${data.signalsFound} signals, ${data.tradesPlaced} trades placed`);
    },
    onError: (err: any) => toast.error(err.message),
  });

  const d = status || {
    isRunning: false, isPaused: false, balance: 10000, equity: 10000, dailyPnl: 0,
    positions: [], tradeHistory: [], totalTrades: 0, winRate: 0, wins: 0, losses: 0,
    scanCount: 0, signalCount: 0, rejectedCount: 0, executionMode: "paper",
    killSwitchActive: false, uptime: 0, strategy: { name: "SMC Default" },
  };

  const logs = Array.isArray(scanLogs) ? scanLogs : [];

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Bot Monitor</h1>
            <p className="text-sm text-muted-foreground">Autonomous SMC scanner & paper trading engine</p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => scanMutation.mutate()} disabled={scanMutation.isPending}>
              {scanMutation.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Scan className="h-3 w-3 mr-1" />}
              Scan Now
            </Button>
            <Button size="sm" variant={d.isRunning ? "secondary" : "default"} onClick={() => startMutation.mutate()} disabled={d.isRunning && !d.isPaused}>
              <Play className="h-3 w-3 mr-1" /> Start
            </Button>
            <Button size="sm" variant="secondary" onClick={() => pauseMutation.mutate()} disabled={!d.isRunning || d.isPaused}>
              <Pause className="h-3 w-3 mr-1" /> Pause
            </Button>
            <Button size="sm" variant="secondary" onClick={() => stopMutation.mutate()} disabled={!d.isRunning}>
              <Square className="h-3 w-3 mr-1" /> Stop
            </Button>
            <Button size="sm" variant="destructive" onClick={() => killMutation.mutate()}>
              <AlertTriangle className="h-3 w-3 mr-1" /> Kill
            </Button>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          {[
            { label: "Status", value: d.isRunning ? (d.isPaused ? "Paused" : "Running") : "Stopped", color: d.isRunning ? (d.isPaused ? "text-warning" : "text-success") : "text-muted-foreground" },
            { label: "Mode", value: d.executionMode === "live" ? "LIVE" : "Paper", color: d.executionMode === "live" ? "text-destructive" : "" },
            { label: "Balance", value: formatMoney(d.balance) },
            { label: "Equity", value: formatMoney(d.equity) },
            { label: "Win/Loss", value: `${d.wins}W / ${d.losses}L` },
            { label: "Win Rate", value: `${(d.winRate || 0).toFixed(1)}%`, color: (d.winRate || 0) >= 50 ? "text-success" : "text-destructive" },
          ].map(kpi => (
            <Card key={kpi.label}>
              <CardContent className="pt-3 pb-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{kpi.label}</p>
                <p className={`text-sm font-bold mt-0.5 ${kpi.color || ""}`}>{kpi.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Active Positions */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Active Positions ({d.positions?.length || 0})</CardTitle>
            </CardHeader>
            <CardContent>
              {(!d.positions || d.positions.length === 0) ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No open positions</p>
              ) : (
                <div className="space-y-2">
                  {d.positions.map((p: any) => (
                    <div key={p.id} className="flex items-center justify-between p-2 rounded bg-secondary/30 text-xs">
                      <div className="flex items-center gap-2">
                        <span className={p.direction === "long" ? "text-success" : "text-destructive"}>
                          {p.direction === "long" ? "▲" : "▼"}
                        </span>
                        <span className="font-medium">{p.symbol}</span>
                        <span className="text-muted-foreground">{p.size?.toFixed(2)} lots</span>
                      </div>
                      <span className={`font-medium ${p.pnl >= 0 ? "text-success" : "text-destructive"}`}>
                        {formatMoney(p.pnl, true)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Trade History */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Recent Trades</CardTitle>
                <Button size="sm" variant="ghost" onClick={() => resetMutation.mutate()}>Reset Account</Button>
              </div>
            </CardHeader>
            <CardContent>
              {(!d.tradeHistory || d.tradeHistory.length === 0) ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No trade history yet</p>
              ) : (
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {d.tradeHistory.slice(0, 20).map((t: any, i: number) => (
                    <div key={i} className="flex items-center justify-between text-xs py-1.5 border-b border-border/30">
                      <div className="flex items-center gap-2">
                        <span className={t.direction === "long" ? "text-success" : "text-destructive"}>
                          {t.direction === "long" ? "▲" : "▼"}
                        </span>
                        <span>{t.symbol}</span>
                        <span className="text-muted-foreground">{t.closeReason}</span>
                      </div>
                      <span className={`font-medium ${t.pnl >= 0 ? "text-success" : "text-destructive"}`}>
                        {formatMoney(t.pnl, true)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Counters */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex gap-6 text-sm flex-wrap">
              <span>Scans: <strong>{d.scanCount}</strong></span>
              <span>Signals: <strong>{d.signalCount}</strong></span>
              <span>Trades: <strong>{d.totalTrades}</strong></span>
              <span>Rejected: <strong>{d.rejectedCount}</strong></span>
              <span>Kill Switch: <strong className={d.killSwitchActive ? "text-destructive" : "text-success"}>{d.killSwitchActive ? "ACTIVE" : "Off"}</strong></span>
            </div>
          </CardContent>
        </Card>

        {/* Scan Logs */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Scan History</CardTitle>
          </CardHeader>
          <CardContent>
            {logs.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No scans yet — click "Scan Now" or start the engine</p>
            ) : (
              <div className="space-y-3">
                {logs.map((log: any) => (
                  <ScanLogEntry key={log.id} log={log} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function ScanLogEntry({ log }: { log: any }) {
  const [expanded, setExpanded] = useState(false);
  const details = log.details_json || [];
  const signals = details.filter((d: any) => d.status === "trade_placed" || d.status === "signal_only");

  return (
    <div className="border border-border/50 rounded-lg p-3">
      <div className="flex items-center justify-between cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-3 text-sm">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">{new Date(log.scanned_at).toLocaleString()}</span>
          <Badge variant="outline" className="text-[10px]">{log.pairs_scanned} pairs</Badge>
          {log.signals_found > 0 && (
            <Badge variant="default" className="text-[10px] bg-primary/20 text-primary">{log.signals_found} signals</Badge>
          )}
          {log.trades_placed > 0 && (
            <Badge className="text-[10px] bg-success/20 text-success">{log.trades_placed} trades</Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground">{expanded ? "▲" : "▼"}</span>
      </div>

      {expanded && details.length > 0 && (
        <div className="mt-3 space-y-1">
          {details.map((d: any, i: number) => (
            <div key={i} className="flex items-center justify-between text-xs py-1 px-2 rounded bg-secondary/20">
              <div className="flex items-center gap-2">
                {d.direction === "long" ? <TrendingUp className="h-3 w-3 text-success" /> :
                 d.direction === "short" ? <TrendingDown className="h-3 w-3 text-destructive" /> :
                 <Minus className="h-3 w-3 text-muted-foreground" />}
                <span className="font-medium">{d.pair}</span>
                <span className="text-muted-foreground">{d.trend || "—"}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`font-mono ${d.score >= 6 ? "text-success" : d.score >= 4 ? "text-warning" : "text-muted-foreground"}`}>
                  {d.score?.toFixed(1) || "—"}
                </span>
                <Badge variant="outline" className="text-[9px]">
                  {d.status === "trade_placed" ? "📈 Traded" :
                   d.status === "signal_only" ? "⚡ Signal" :
                   d.status === "skipped" ? "⏭ Skip" :
                   d.status === "below_threshold" ? "📉 Low" : d.status}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
