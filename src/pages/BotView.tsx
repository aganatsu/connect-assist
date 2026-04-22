import React, { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatMoney, INSTRUMENTS } from "@/lib/marketData";
import { formatBrokerTime, formatTimeOnly, formatFullDateTime } from "@/lib/formatTime";
import { paperApi, scannerApi, brokerApi, botConfigApi, brokerExecApi } from "@/lib/api";
import { STYLE_META, getActiveStyle } from "@/lib/botStyleClassifier";
import { toast } from "sonner";
import {
  Play, Pause, Square, AlertTriangle, Scan, Loader2,
  TrendingUp, TrendingDown, Minus, Clock, ShieldCheck, ShieldX,
  ChevronDown, ChevronUp, Plus, Settings, Activity, Monitor, RefreshCw,
} from "lucide-react";
import { BotConfigModal } from "@/components/BotConfigModal";

import { CloseAuditLog } from "@/components/CloseAuditLog";
import { BrokerLog } from "@/components/BrokerLog";
import { SignalReasoningCard } from "@/components/SignalReasoningCard";
import { ExpandedPositionCard } from "@/components/ExpandedPositionCard";
import { DataSourceBadge } from "@/components/DataSourceBadge";
import { FOTSIStrengthMeter } from "@/components/FOTSIStrengthMeter";
import { RecommendationsDashboard } from "@/components/RecommendationsDashboard";
import SessionStatusPill from "@/components/SessionStatusPill";
import type { CandleSource } from "@/lib/api";
import { useNavigate } from "react-router-dom";

export default function BotView() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [orderFormOpen, setOrderFormOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [liveModeConfirm, setLiveModeConfirm] = useState(false);
  const [expandedPosition, setExpandedPosition] = useState<string | null>(null);
  const [selectedPairIdx, setSelectedPairIdx] = useState(0);
  const [selectedScanIdx, setSelectedScanIdx] = useState(0);

  const [customBalanceInput, setCustomBalanceInput] = useState("");
  const [showSetBalance, setShowSetBalance] = useState(false);

  // Order form state
  const [orderType, setOrderType] = useState("market");
  const [orderSymbol, setOrderSymbol] = useState("EUR/USD");
  const [orderDirection, setOrderDirection] = useState<"long" | "short">("long");
  const [orderSize, setOrderSize] = useState("0.01");
  const [orderTrigger, setOrderTrigger] = useState("");
  const [orderSL, setOrderSL] = useState("");
  const [orderTP, setOrderTP] = useState("");
  const [orderReason, setOrderReason] = useState("");
  const [orderScore, setOrderScore] = useState("5");

  const { data: status } = useQuery({
    queryKey: ["paper-status"],
    queryFn: () => paperApi.status(),
    refetchInterval: 5000,
  });

  const { data: scanLogs } = useQuery({
    queryKey: ["scan-logs"],
    queryFn: () => scannerApi.logs(),
    refetchInterval: 30000,
  });

  const { data: botConfig } = useQuery({
    queryKey: ["bot-config"],
    queryFn: () => botConfigApi.get(),
  });

  const { data: brokerConns } = useQuery({
    queryKey: ["broker-connections"],
    queryFn: () => brokerApi.list(),
    refetchInterval: 30000,
  });
  const activeConnections = Array.isArray(brokerConns) ? brokerConns.filter((c: any) => c.is_active) : [];
  const [selectedConnIdx, setSelectedConnIdx] = useState(0);
  const selectedConnection = activeConnections[selectedConnIdx] || activeConnections[0];

  // Live broker account data (only when in live mode with an active connection)
  const isLiveMode = status?.executionMode === "live";
  const { data: brokerAccount } = useQuery({
    queryKey: ["broker-account", selectedConnection?.id],
    queryFn: () => brokerExecApi.accountSummary(selectedConnection.id),
    enabled: !!selectedConnection && isLiveMode,
    refetchInterval: 10000,
  });

  const { data: brokerOpenTrades } = useQuery({
    queryKey: ["broker-open-trades", selectedConnection?.id],
    queryFn: () => brokerExecApi.openTrades(selectedConnection.id),
    enabled: !!selectedConnection && isLiveMode,
    refetchInterval: 10000,
  });

  const startMut = useMutation({ mutationFn: () => paperApi.startEngine(), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Engine started"); } });
  const pauseMut = useMutation({ mutationFn: () => paperApi.pauseEngine(), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Engine paused"); } });
  const stopMut = useMutation({ mutationFn: () => paperApi.stopEngine(), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Engine stopped"); } });
  const killMut = useMutation({ mutationFn: () => paperApi.killSwitch(true), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.error("Kill switch activated"); } });
  const deactivateKill = useMutation({ mutationFn: () => paperApi.killSwitch(false), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Kill switch deactivated"); } });
  const resetMut = useMutation({ mutationFn: () => paperApi.resetAccount(), onSuccess: (data: any) => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success(`Full reset complete — balance set to $${data?.startingBalance || "10,000"}`); } });
  const resetBalMut = useMutation({ mutationFn: () => paperApi.resetBalanceOnly(), onSuccess: (data: any) => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success(`Balance reset to $${data?.startingBalance || "10,000"} — history preserved`); } });
  const setBalMut = useMutation({
    mutationFn: (balance: number) => paperApi.setBalance(balance),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["paper-status"] });
      toast.success(`Balance set to $${parseFloat(data?.balance || "0").toLocaleString()}`);
      setCustomBalanceInput("");
      setShowSetBalance(false);
    },
    onError: (err: any) => toast.error(err.message || "Failed to set balance"),
  });
  const scanMut = useMutation({
    mutationFn: () => scannerApi.manualScan(),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["paper-status"] });
      queryClient.invalidateQueries({ queryKey: ["scan-logs"] });

      // Reset to latest scan so the UI shows the new result, not the old one
      setSelectedScanIdx(0);
      setSelectedPairIdx(0);

      // Backend now returns the full scan result (not fire-and-forget).
      // Handle error responses from the backend
      if (data.error) {
        toast.error(`Scan failed: ${data.error}`);
        return;
      }

      // Handle skip reasons (overlap, interval, day not enabled, no account, etc.)
      if (data.skippedReason) {
        const reason = data.skippedReason;
        const friendlyReasons: Record<string, string> = {
          overlap: "Another scan is still running — try again in a minute",
          "Day not enabled": "Today is not an enabled trading day in your config",
          "No paper account": "No paper trading account found — set one up first",
        };
        const msg = friendlyReasons[reason] || (reason.startsWith("interval") ? `Scan skipped — ${reason}` : `Scan skipped: ${reason}`);
        toast.warning(msg, { duration: 5000 });
        return;
      }

      // Show detailed results
      const pairs = data.pairsScanned ?? 0;
      const signals = data.signalsFound ?? 0;
      const trades = data.tradesPlaced ?? 0;
      const rejected = data.rejected ?? 0;

      if (signals > 0 || trades > 0) {
        toast.success(`Scan complete: ${pairs} pairs → ${signals} signal${signals !== 1 ? "s" : ""}, ${trades} trade${trades !== 1 ? "s" : ""} placed`, { duration: 5000 });
      } else if (pairs > 0) {
        // Scanned pairs but found nothing — show the details breakdown
        const details: any[] = data.details || [];
        const sessionSkipped = details.filter((d: any) => d.reason?.includes("session not enabled")).length;
        const belowThreshold = details.filter((d: any) => d.reason?.includes("Below threshold") || d.reason?.includes("below threshold")).length;
        const noDirection = details.filter((d: any) => d.reason?.includes("No direction")).length;
        const insufficientData = details.filter((d: any) => d.reason?.includes("Insufficient")).length;

        let detail = `${pairs} pairs scanned, 0 signals.`;
        const reasons: string[] = [];
        if (sessionSkipped > 0) reasons.push(`${sessionSkipped} session-filtered`);
        if (belowThreshold > 0) reasons.push(`${belowThreshold} below threshold`);
        if (noDirection > 0) reasons.push(`${noDirection} no direction`);
        if (insufficientData > 0) reasons.push(`${insufficientData} insufficient data`);
        if (reasons.length > 0) detail += " " + reasons.join(", ") + ".";

        toast.info(detail, { duration: 6000 });
      } else {
        toast.info("Scan completed — no pairs were scanned", { duration: 4000 });
      }
    },
    onError: (err: any) => toast.error(`Scan request failed: ${err.message}`),
  });



  const orderMut = useMutation({
    mutationFn: () => paperApi.placeOrder({
      symbol: orderSymbol, direction: orderDirection, size: parseFloat(orderSize) || 0.01,
      entryPrice: parseFloat(orderTrigger) || 0,
      stopLoss: orderSL ? parseFloat(orderSL) : undefined,
      takeProfit: orderTP ? parseFloat(orderTP) : undefined,
      signalReason: orderReason, signalScore: parseInt(orderScore) || 5,
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Order placed"); setOrderFormOpen(false); },
    onError: (err: any) => toast.error(err.message),
  });

  const d = status || {
    isRunning: false, isPaused: false, balance: 10000, equity: 10000, dailyPnl: 0,
    positions: [], tradeHistory: [], totalTrades: 0, winRate: 0, wins: 0, losses: 0,
    scanCount: 0, signalCount: 0, rejectedCount: 0, executionMode: "paper",
    killSwitchActive: false, drawdown: 0,
  };

  const logs = Array.isArray(scanLogs) ? scanLogs : [];

  // Clamp selected scan index to available logs
  const safeScanIdx = Math.min(selectedScanIdx, Math.max(0, logs.length - 1));
  const currentScan = logs[safeScanIdx];

  // Pull the candle-source meta entry that the scanner prepends to details_json
  // (so we can show which feed served the selected scan), and produce a filtered
  // list that excludes the meta row from rendering as a fake "pair".
  const latestRawDetails: any[] = (() => {
    if (!currentScan) return [];
    let dj = currentScan.details_json;
    // Supabase may return details_json as a JSON string — parse it safely
    if (typeof dj === "string") {
      try { dj = JSON.parse(dj); } catch { return []; }
    }
    return Array.isArray(dj) ? dj : [];
  })();
  const latestMeta = latestRawDetails.find((d: any) => d?.__meta) ?? null;
  const latestDetailsClean: any[] = latestRawDetails.filter((d: any) => !d?.__meta);
  const latestSource: CandleSource = (latestMeta?.candleSource as CandleSource) ?? "unknown";

  // Extract FOTSI strengths: prefer __meta.fotsiStrengths (new), fallback to reconstructing from per-pair fotsi alignment data (legacy)
  const fotsiStrengths: Record<string, number> | null = (() => {
    // New format: scanner includes fotsiStrengths directly in __meta
    if (latestMeta?.fotsiStrengths && typeof latestMeta.fotsiStrengths === "object") {
      return latestMeta.fotsiStrengths;
    }
    // Legacy fallback: reconstruct from per-pair fotsi.baseTSI / fotsi.quoteTSI
    const currencyValues: Record<string, number[]> = {};
    for (const detail of latestDetailsClean) {
      const fotsi = detail?.analysis_snapshot?.fotsi || detail?.analysis?.fotsi || detail?.fotsi;
      if (!fotsi || !detail?.pair) continue;
      const parts = (detail.pair as string).split("/");
      if (parts.length !== 2) continue;
      const [base, quote] = parts;
      if (typeof fotsi.baseTSI === "number") {
        (currencyValues[base] ??= []).push(fotsi.baseTSI);
      }
      if (typeof fotsi.quoteTSI === "number") {
        (currencyValues[quote] ??= []).push(fotsi.quoteTSI);
      }
    }
    const keys = Object.keys(currencyValues);
    if (keys.length < 4) return null; // Not enough data
    const result: Record<string, number> = {};
    for (const [k, vals] of Object.entries(currencyValues)) {
      result[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    return result;
  })();

  // Filter positions and trades (SMC bot only)
  const allPositions = d.positions || [];
  const allTradeHistory = d.tradeHistory || [];
  const botPositions = allPositions.filter((p: any) => (p.botId || "smc") === "smc");
  const botTradeHistory = allTradeHistory.filter((t: any) => (t.botId || "smc") === "smc");

  const closedToday = botTradeHistory.filter((t: any) => {
    const today = new Date().toISOString().split('T')[0];
    return t.closedAt?.startsWith(today);
  });

  return (
    <AppShell>
      <div className="flex flex-col h-[calc(100vh-3.5rem)] md:h-[calc(100vh-4.5rem)]">
        {/* Live Mode Banner */}
        {d.executionMode === "live" && (
          <div className="bg-destructive/20 border border-destructive text-destructive px-3 py-1.5 text-xs font-medium flex items-center justify-between mb-2">
            <span>⚠ LIVE TRADING ACTIVE — Real Money at Risk</span>
            <Button size="sm" variant="outline" className="h-6 text-[10px] border-destructive text-destructive" onClick={() => paperApi.setExecutionMode("paper").then(() => queryClient.invalidateQueries({ queryKey: ["paper-status"] }))}>
              Switch to Paper
            </Button>
          </div>
        )}
        {d.executionMode !== "live" && (
          <div className="bg-muted border border-border px-3 py-1.5 text-xs font-medium flex items-center justify-between mb-2">
            <span>📝 Paper Mode — trades are simulated, broker mirroring is OFF</span>
            <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => {
              if (confirm("Switch to LIVE mode? Bot trades will be mirrored to your connected broker account(s).")) {
                paperApi.setExecutionMode("live").then(() => queryClient.invalidateQueries({ queryKey: ["paper-status"] }));
              }
            }}>
              Switch to Live
            </Button>
          </div>
        )}

        {/* Bot Selector Tabs */}
        <div className="flex items-center gap-0 border-b border-border mb-1 overflow-x-auto">
          <span className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider border-b-2 border-primary text-primary bg-primary/5">
            SMC Confluence Bot
          </span>
        </div>

        {/* Top Control Bar */}
        <div className="flex items-center gap-2 pb-2 border-b border-border flex-wrap text-[10px] md:text-[11px]">
          <div className="flex items-center gap-1">
            <Button size="sm" variant={d.isRunning ? "secondary" : "default"} className="h-7 text-[11px]" onClick={() => startMut.mutate()} disabled={d.isRunning && !d.isPaused}>
              <Play className="h-3 w-3 mr-1" /> Start
            </Button>
            <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => pauseMut.mutate()} disabled={!d.isRunning || d.isPaused}>
              <Pause className="h-3 w-3 mr-1" /> Pause
            </Button>
            <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => stopMut.mutate()} disabled={!d.isRunning}>
              <Square className="h-3 w-3 mr-1" /> Stop
            </Button>
          </div>

          <div className="w-px h-5 bg-border" />

          <Button size="sm" className="h-7 text-[11px] bg-primary text-primary-foreground" onClick={() => setOrderFormOpen(!orderFormOpen)}>
            <Plus className="h-3 w-3 mr-1" /> Order
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setConfigOpen(true)}>
            <Settings className="h-3 w-3 mr-1" /> Config
          </Button>

          <div className="w-px h-5 bg-border" />

          {/* Engine status */}
          <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${d.isRunning ? (d.isPaused ? "text-warning" : "text-success") : "text-muted-foreground"}`}>
            <span className={d.isRunning && !d.isPaused ? "status-dot-active" : "w-1.5 h-1.5 rounded-full bg-muted-foreground"} />
            {d.isRunning ? (d.isPaused ? "Paused" : "Running") : "Stopped"}
          </span>

          <span className={`text-[10px] font-medium px-1.5 py-0.5 ${d.executionMode === "live" ? "bg-destructive/20 text-destructive" : "bg-success/20 text-success"}`}>
            {d.executionMode === "live" ? "LIVE" : "PAPER"}
          </span>

          {activeConnections.length > 0 ? (
            activeConnections.map((conn: any) => (
              <span key={conn.id} className="text-[10px] font-medium px-1.5 py-0.5 bg-primary/20 text-primary flex items-center gap-1">
                <Monitor className="h-2.5 w-2.5" /> {conn.display_name} ✓
              </span>
            ))
          ) : (
            <button onClick={() => navigate("/settings")} className="text-[10px] font-medium px-1.5 py-0.5 bg-muted text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
              <Monitor className="h-2.5 w-2.5" /> Connect Broker
            </button>
          )}

          {/* Trading Style Badge */}
          {(() => {
            const styleMode = botConfig?.tradingStyle?.mode || "day_trader";
            const meta = STYLE_META[styleMode as keyof typeof STYLE_META];
            if (meta) {
              return (
                <span className={`text-[10px] font-medium px-1.5 py-0.5 border flex items-center gap-1 ${meta.color}`}>
                  {meta.icon} {meta.label}
                </span>
              );
            }
            return null;
          })()}

          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => scanMut.mutate()} disabled={scanMut.isPending}>
              {scanMut.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Scan className="h-3 w-3 mr-1" />} Scan Now
            </Button>
            <div className="w-px h-5 bg-border" />
            <Button size="sm" variant="destructive" className="h-7 text-[11px]" onClick={() => {
              if (window.confirm("⚠️ KILL SWITCH: This will close ALL open positions and halt trading. Are you sure?")) killMut.mutate();
            }}>
              <AlertTriangle className="h-3 w-3 mr-1" /> Kill
            </Button>

            <div className="hidden md:flex gap-3 text-[10px] text-muted-foreground">
              <span>Interval: <strong className="text-foreground">{`${botConfig?.entry?.scanIntervalMinutes ?? 15}m`}</strong></span>
              <span>Scans: <strong className="text-foreground">{d.scanCount}</strong></span>
              <span>Signals: <strong className="text-foreground">{d.signalCount}</strong></span>
              <span>Trades: <strong className="text-foreground">{d.totalTrades}</strong></span>
              <span>WR: <strong className={`${(d.winRate || 0) >= 50 ? "text-success" : "text-destructive"}`}>{(d.winRate || 0).toFixed(0)}%</strong></span>
            </div>
          </div>
        </div>

        {/* Manual Order Form (collapsible) */}
        {orderFormOpen && (
          <div className="py-2 border-b border-border">
            <div className="flex items-end gap-2 flex-wrap">
              <div className="w-24"><Label className="text-[10px]">Type</Label>
                <select value={orderType} onChange={e => setOrderType(e.target.value)} className="w-full bg-card border border-border px-1.5 py-1 text-[11px]">
                  <option value="market">Market</option><option value="buy_limit">Buy Limit</option><option value="sell_limit">Sell Limit</option><option value="buy_stop">Buy Stop</option><option value="sell_stop">Sell Stop</option>
                </select>
              </div>
              <div className="w-24"><Label className="text-[10px]">Symbol</Label>
                <select value={orderSymbol} onChange={e => setOrderSymbol(e.target.value)} className="w-full bg-card border border-border px-1.5 py-1 text-[11px]">
                  {INSTRUMENTS.map(i => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
                </select>
              </div>
              <div className="flex gap-0.5">
                <button onClick={() => setOrderDirection("long")} className={`px-3 py-1 text-[11px] font-medium ${orderDirection === "long" ? "bg-success text-success-foreground" : "bg-secondary text-muted-foreground"}`}>BUY</button>
                <button onClick={() => setOrderDirection("short")} className={`px-3 py-1 text-[11px] font-medium ${orderDirection === "short" ? "bg-destructive text-destructive-foreground" : "bg-secondary text-muted-foreground"}`}>SELL</button>
              </div>
              <div className="w-16"><Label className="text-[10px]">Size</Label><Input value={orderSize} onChange={e => setOrderSize(e.target.value)} className="h-7 text-[11px]" /></div>
              {orderType !== "market" && <div className="w-20"><Label className="text-[10px]">Trigger</Label><Input value={orderTrigger} onChange={e => setOrderTrigger(e.target.value)} className="h-7 text-[11px]" /></div>}
              <div className="w-20"><Label className="text-[10px]">SL</Label><Input value={orderSL} onChange={e => setOrderSL(e.target.value)} className="h-7 text-[11px]" placeholder="0.00000" /></div>
              <div className="w-20"><Label className="text-[10px]">TP</Label><Input value={orderTP} onChange={e => setOrderTP(e.target.value)} className="h-7 text-[11px]" placeholder="0.00000" /></div>
              <div className="w-14"><Label className="text-[10px]">Score</Label><Input type="number" min={0} max={10} value={orderScore} onChange={e => setOrderScore(e.target.value)} className="h-7 text-[11px]" /></div>
              <Button size="sm" className={`h-7 text-[11px] ${orderDirection === "long" ? "bg-success hover:bg-success/80" : "bg-destructive hover:bg-destructive/80"}`} onClick={() => orderMut.mutate()}>
                {orderDirection === "long" ? "BUY" : "SELL"} {orderSymbol}
              </Button>
            </div>
          </div>
        )}

        {/* Main workspace: 65/35 split */}
        <div className="flex-1 flex flex-col md:flex-row gap-3 mt-2 min-h-0">
          {/* Left: Tabbed Positions (~65%) */}
          <div className="flex-[2] flex flex-col min-h-0 min-h-[300px] md:min-h-0">
            <Tabs defaultValue="open" className="flex-1 flex flex-col min-h-0">
              <TabsList className="h-7 shrink-0 overflow-x-auto">
                <TabsTrigger value="open" className="text-[11px] h-6">Open ({botPositions.length})</TabsTrigger>
                <TabsTrigger value="today" className="text-[11px] h-6">Closed Today ({closedToday.length})</TabsTrigger>
                <TabsTrigger value="history" className="text-[11px] h-6">All History</TabsTrigger>
                <TabsTrigger value="audit" className="text-[11px] h-6">Close Audit</TabsTrigger>
                <TabsTrigger value="broker-log" className="text-[11px] h-6">Broker Log</TabsTrigger>
                <TabsTrigger value="ai-advisor" className="text-[11px] h-6">AI Advisor</TabsTrigger>
              </TabsList>
              <TabsContent value="open" className="flex-1 overflow-auto mt-1">
                {(botPositions.length === 0) ? (
                  <div className="flex flex-col items-center justify-center py-12 border border-dashed border-border">
                    <Plus className="h-8 w-8 text-muted-foreground/20 mb-2" />
                    <p className="text-xs font-medium text-muted-foreground">No open positions</p>
                    <p className="text-[10px] text-muted-foreground/70 mt-1">Click "+ Order" to place a trade or start the bot scanner</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto"><table className="w-full text-[11px] font-mono min-w-[800px]">
                    <thead><tr className="border-b border-border text-muted-foreground text-[10px]">
                      <th className="text-center py-1 px-1 w-6">#</th>
                      <th className="text-left py-1 px-1">Opened</th>
                      <th className="text-left py-1 px-1">Symbol</th><th className="text-left py-1 px-1">Dir</th>
                      <th className="text-right py-1 px-1">Entry</th><th className="text-right py-1 px-1">Current</th>
                      <th className="text-right py-1 px-1">Pips</th>
                      <th className="text-right py-1 px-1">P&L</th>
                      <th className="text-right py-1 px-1">R</th>
                      <th className="text-center py-1 px-1">BE</th>
                      <th className="text-right py-1 px-1">SL</th><th className="text-right py-1 px-1">TP</th>
                      <th className="text-center py-1 px-1">Trail</th>
                      <th className="text-center py-1 px-1">Hold</th>
                      <th className="py-1 px-1"></th>
                    </tr></thead>
                    <tbody>
                      {botPositions.map((p: any, idx: number) => {
                        // Parse exitFlags for management columns
                        let ef: any = {};
                        try { const parsed = JSON.parse(p.signalReason || "{}"); ef = parsed.exitFlags || {}; } catch {}
                        const inst = INSTRUMENTS.find((i: any) => i.symbol === p.symbol);
                        const pipSize = inst?.pipSize || 0.0001;
                        const entry = parseFloat(p.entryPrice);
                        const current = parseFloat(p.currentPrice);
                        const sl = p.stopLoss ? parseFloat(p.stopLoss) : null;
                        // R-multiple calculation
                        const riskPips = sl !== null ? Math.abs(entry - sl) / pipSize : 0;
                        const profitPips = p.direction === "long" ? (current - entry) / pipSize : (entry - current) / pipSize;
                        const rMult = riskPips > 0 ? profitPips / riskPips : 0;
                        // BE status
                        const beEnabled = ef.breakEvenEnabled ?? ef.breakEven ?? false;
                        const beFired = ef.breakEvenActivated === true;
                        const beActivationR = riskPips > 0 ? Math.min(2.0, Math.max(1.0, (ef.breakEvenPips || 0) / riskPips)) : 1.0;
                        // Trail status
                        const trailEnabled = ef.trailingStopEnabled ?? ef.trailingStop ?? false;
                        const trailFired = ef.trailingStopActivated === true;
                        const trailActivationR = ef.trailingActivationR || 1.0;
                        const trailLevel = ef.currentTrailLevel ? parseFloat(ef.currentTrailLevel) : null;
                        // Hold time — live config override: if user toggled maxHold off globally, show Off
                        const liveMaxHoldOff = botConfig?.exit?.maxHoldEnabled === false || botConfig?.exit?.timeBasedExitEnabled === false;
                        const holdEnabled = !liveMaxHoldOff && ef.maxHoldEnabled !== false && ef.maxHoldHours && ef.maxHoldHours > 0;
                        const openMs = new Date(p.openTime).getTime();
                        const holdHours = (Date.now() - openMs) / 3600000;
                        const holdPct = holdEnabled ? holdHours / ef.maxHoldHours : 0;
                        return (
                        <React.Fragment key={p.id}>
                          <tr className={`border-b border-border/30 hover:bg-secondary/30 cursor-pointer ${idx % 2 === 1 ? "bg-secondary/10" : ""}`}
                            onClick={() => setExpandedPosition(expandedPosition === p.id ? null : p.id)}>
                            <td className="py-1.5 px-1 text-center text-muted-foreground text-[10px]">{idx + 1}</td>
                            <td className="py-1.5 px-1 text-muted-foreground text-[10px] whitespace-nowrap">{new Date(p.openTime).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })} {new Date(p.openTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</td>
                            <td className="py-1.5 px-1 font-medium">{p.symbol}</td>
                            <td className={`py-1.5 px-1 ${p.direction === "long" ? "text-success" : "text-destructive"}`}>{p.direction === "long" ? "▲" : "▼"}</td>
                            <td className="py-1.5 px-1 text-right">{entry.toFixed(5)}</td>
                            <td className="py-1.5 px-1 text-right">{current.toFixed(5)}</td>
                            <td className={`py-1.5 px-1 text-right font-medium ${profitPips >= 0 ? "text-success" : "text-destructive"}`}>{profitPips >= 0 ? "+" : ""}{profitPips.toFixed(1)}</td>
                            <td className={`py-1.5 px-1 text-right font-medium ${p.pnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(p.pnl, true)}</td>
                            <td className={`py-1.5 px-1 text-right font-bold ${rMult >= 0 ? "text-success" : "text-destructive"}`}>{rMult >= 0 ? "+" : ""}{rMult.toFixed(1)}R</td>
                            <td className="py-1.5 px-1 text-center text-[10px]">
                              {!beEnabled ? <span className="text-muted-foreground">—</span>
                                : beFired ? <span className="text-success" title="Break-even active">✅</span>
                                : <span className="text-muted-foreground" title={`Triggers at ${beActivationR.toFixed(1)}R`}>⏳{beActivationR.toFixed(1)}R</span>}
                            </td>
                            <td className="py-1.5 px-1 text-right">{sl !== null ? sl.toFixed(5) : "—"}</td>
                            <td className="py-1.5 px-1 text-right">{p.takeProfit ? parseFloat(p.takeProfit).toFixed(5) : "—"}</td>
                            <td className="py-1.5 px-1 text-center text-[10px]">
                              {!trailEnabled ? <span className="text-muted-foreground">—</span>
                                : trailFired ? <span className={trailLevel ? "text-cyan-400" : "text-success"} title={trailLevel ? `Trail at ${trailLevel.toFixed(5)}` : "Trailing active"}>{trailLevel ? `🟢${trailLevel.toFixed(inst?.pipSize === 0.01 ? 3 : 5)}` : "🟢"}</span>
                                : <span className="text-muted-foreground" title={`Triggers at ${trailActivationR.toFixed(1)}R`}>⏳{trailActivationR.toFixed(1)}R</span>}
                            </td>
                            <td className={`py-1.5 px-1 text-center text-[10px] ${holdEnabled ? (holdPct >= 0.9 ? "text-destructive" : holdPct >= 0.75 ? "text-yellow-500" : "text-muted-foreground") : "text-muted-foreground"}`}>
                              {!holdEnabled ? "Off" : `${holdHours.toFixed(1)}h/${ef.maxHoldHours}h`}
                            </td>
                            <td className="py-1.5 px-1" onClick={e => e.stopPropagation()}>
                              <button
                                onClick={() => {
                                  if (window.confirm(`Close ${p.symbol} ${p.direction} position?`)) {
                                    paperApi.closePosition(p.id).then(() => queryClient.invalidateQueries({ queryKey: ["paper-status"] }));
                                  }
                                }}
                                className="text-destructive hover:bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium transition-colors"
                              >✕ Close</button>
                            </td>
                          </tr>
                          {expandedPosition === p.id && (
                            <tr>
                              <td colSpan={15} className="border-b border-border p-2">
                                <ExpandedPositionCard position={p} onSaved={() => queryClient.invalidateQueries({ queryKey: ["paper-status"] })} />
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table></div>
                )}
              </TabsContent>
              <TabsContent value="today" className="flex-1 overflow-auto mt-1">
                <TradeHistoryTable trades={closedToday} />
              </TabsContent>
              <TabsContent value="history" className="flex-1 overflow-auto mt-1">
                <TradeHistoryTable trades={botTradeHistory} />
              </TabsContent>
              <TabsContent value="audit" className="flex-1 overflow-hidden mt-1">
                <CloseAuditLog brokerConns={Array.isArray(brokerConns) ? brokerConns : []} />
              </TabsContent>
              <TabsContent value="broker-log" className="flex-1 overflow-hidden mt-1">
                <BrokerLog />
              </TabsContent>
              <TabsContent value="ai-advisor" className="flex-1 overflow-auto mt-1">
                <RecommendationsDashboard botId="smc" />
              </TabsContent>
            </Tabs>
          </div>

          {/* Right sidebar (~35%) */}
          <div className="flex-1 overflow-y-auto space-y-2 md:max-w-none">

            {/* Account Summary */}
            {(() => {
              const positions = botPositions;
              const unrealizedPnl = positions.reduce((s: number, p: any) => s + (p.pnl || 0), 0);
              const totalExposure = positions.reduce((s: number, p: any) => s + (parseFloat(p.size) || 0), 0);
              const longCount = positions.filter((p: any) => p.direction === "long").length;
              const shortCount = positions.filter((p: any) => p.direction === "short").length;
              const bestPos = positions.length > 0 ? positions.reduce((best: any, p: any) => (p.pnl || 0) > (best.pnl || 0) ? p : best, positions[0]) : null;
              const worstPos = positions.length > 0 ? positions.reduce((worst: any, p: any) => (p.pnl || 0) < (worst.pnl || 0) ? p : worst, positions[0]) : null;
              const equity = parseFloat(d.balance) + unrealizedPnl;
              const profitPct = (((parseFloat(d.balance) - 10000) / 10000) * 100);
              const history = botTradeHistory;
              const totalRealizedPnl = history.reduce((s: number, t: any) => s + (parseFloat(t.pnl) || 0), 0);
              const avgWin = d.wins > 0 ? history.filter((t: any) => parseFloat(t.pnl) >= 0).reduce((s: number, t: any) => s + (parseFloat(t.pnl) || 0), 0) / d.wins : 0;
              const avgLoss = d.losses > 0 ? history.filter((t: any) => parseFloat(t.pnl) < 0).reduce((s: number, t: any) => s + (parseFloat(t.pnl) || 0), 0) / d.losses : 0;
              const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

              return (
                <>
                  <Card>
                    <CardContent className="pt-3 pb-2 space-y-1.5 text-[11px]">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Account</p>
                      <div className="flex justify-between"><span className="text-muted-foreground">Balance</span><span className="font-mono font-bold">{formatMoney(d.balance)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Equity</span><span className="font-mono">{formatMoney(equity)}</span></div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Unrealized P&L</span>
                        <span className={`font-mono font-bold ${unrealizedPnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(unrealizedPnl, true)}</span>
                      </div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Daily P&L</span><span className={`font-mono font-medium ${d.dailyPnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(d.dailyPnl, true)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Total Return</span><span className={`font-mono font-medium ${profitPct >= 0 ? "text-success" : "text-destructive"}`}>{profitPct >= 0 ? "+" : ""}{profitPct.toFixed(2)}%</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Drawdown</span><span className={`font-mono ${(d.drawdown || 0) > 10 ? "text-destructive" : (d.drawdown || 0) > 5 ? "text-warning" : ""}`}>{(d.drawdown || 0).toFixed(1)}%</span></div>
                    </CardContent>
                  </Card>

                  {/* Exposure */}
                  <Card>
                    <CardContent className="pt-3 pb-2 space-y-1.5 text-[11px]">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Exposure</p>
                      <div className="flex justify-between"><span className="text-muted-foreground">Open Positions</span><span className="font-mono font-bold">{positions.length}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Long / Short</span><span className="font-mono"><span className="text-success">{longCount}L</span> / <span className="text-destructive">{shortCount}S</span></span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Total Lots</span><span className="font-mono">{totalExposure.toFixed(2)}</span></div>
                      {bestPos && bestPos.pnl !== 0 && (
                        <div className="flex justify-between"><span className="text-muted-foreground">Best Open</span><span className="font-mono text-success text-[10px]">{bestPos.symbol} {formatMoney(bestPos.pnl, true)}</span></div>
                      )}
                      {worstPos && worstPos.pnl !== 0 && (
                        <div className="flex justify-between"><span className="text-muted-foreground">Worst Open</span><span className="font-mono text-destructive text-[10px]">{worstPos.symbol} {formatMoney(worstPos.pnl, true)}</span></div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Performance Metrics */}
                  <Card>
                    <CardContent className="pt-3 pb-2 space-y-1.5 text-[11px]">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Performance</p>
                      <div className="flex justify-between"><span className="text-muted-foreground">Win Rate</span><span className={`font-mono font-bold ${(d.winRate || 0) >= 50 ? "text-success" : "text-destructive"}`}>{(d.winRate || 0).toFixed(1)}%</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Win / Loss</span><span className="font-mono">{d.wins}W / {d.losses}L</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Total Trades</span><span className="font-mono">{d.totalTrades}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Realized P&L</span><span className={`font-mono ${totalRealizedPnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(totalRealizedPnl, true)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Avg Win</span><span className="font-mono text-success">{formatMoney(avgWin, true)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Avg Loss</span><span className="font-mono text-destructive">{formatMoney(avgLoss, true)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Profit Factor</span><span className="font-mono">{profitFactor > 0 ? profitFactor.toFixed(2) : "—"}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Rejected</span><span className="font-mono text-warning">{d.rejectedCount}</span></div>
                    </CardContent>
                  </Card>
                </>
              );
            })()}

            {/* FOTSI Currency Strength Meter */}
            <FOTSIStrengthMeter
              strengths={fotsiStrengths}
              lastScanTime={currentScan?.scanned_at}
              onRefresh={() => scanMut.mutate()}
              isRefreshing={scanMut.isPending}
            />

            {/* Engine Controls */}
            <Card>
              <CardContent className="pt-3 pb-2 space-y-2 text-[11px]">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Engine</p>
                <Button size="sm" variant="outline" className="w-full h-7 text-[11px]" onClick={() => scanMut.mutate()} disabled={scanMut.isPending}>
                  {scanMut.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Scan className="h-3 w-3 mr-1" />} Manual Scan
                </Button>
                {/* Set Balance — inline expandable */}
                <Button size="sm" variant="outline" className="w-full h-7 text-[11px] border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10" onClick={() => setShowSetBalance(!showSetBalance)}>
                  <Settings className="h-3 w-3 mr-1" /> Set Balance
                </Button>
                {showSetBalance && (
                  <div className="flex gap-1.5 items-center">
                    <div className="relative flex-1">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">$</span>
                      <Input
                        type="number"
                        min="0"
                        step="100"
                        placeholder="e.g. 50000"
                        value={customBalanceInput}
                        onChange={(e) => setCustomBalanceInput(e.target.value)}
                        className="h-7 text-[11px] pl-5 font-mono"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const val = parseFloat(customBalanceInput);
                            if (!isNaN(val) && val >= 0) setBalMut.mutate(val);
                          }
                        }}
                      />
                    </div>
                    <Button
                      size="sm"
                      className="h-7 text-[11px] px-3 bg-cyan-600 hover:bg-cyan-700 text-white"
                      disabled={setBalMut.isPending || !customBalanceInput || isNaN(parseFloat(customBalanceInput)) || parseFloat(customBalanceInput) < 0}
                      onClick={() => {
                        const val = parseFloat(customBalanceInput);
                        if (!isNaN(val) && val >= 0) setBalMut.mutate(val);
                      }}
                    >
                      {setBalMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Apply"}
                    </Button>
                  </div>
                )}
                <Button size="sm" variant="outline" className="w-full h-7 text-[11px] border-amber-500/30 text-amber-400 hover:bg-amber-500/10" onClick={() => {
                  if (window.confirm("Reset balance to configured starting amount?\n\nThis will reset your balance, peak balance, and daily PnL counters.\n\nYour positions, trade history, scan logs, and reasonings will be PRESERVED.")) resetBalMut.mutate();
                }} disabled={resetBalMut.isPending}>
                  {resetBalMut.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />} Reset Balance
                </Button>
                <Button size="sm" variant="outline" className="w-full h-7 text-[11px] border-destructive/30 text-destructive hover:bg-destructive/10" onClick={() => {
                  if (window.confirm("⚠️ FULL RESET — This will:\n\n• Close all open positions\n• Delete ALL trade history\n• Delete ALL scan logs\n• Delete ALL reasonings & post-mortems\n• Reset balance to configured starting amount\n• Stop the engine\n\nThis CANNOT be undone. Are you sure?")) resetMut.mutate();
                }} disabled={resetMut.isPending}>
                  {resetMut.isPending ? <Loader2 className="h-3 w-3 mr-1" /> : null} Full Reset
                </Button>
              </CardContent>
            </Card>

            {/* Live Broker Account (only in live mode) */}
            {isLiveMode && activeConnections.length > 0 && (
              <Card>
                <CardContent className="pt-3 pb-2 space-y-1.5 text-[11px]">
                  {activeConnections.length > 1 && (
                    <select
                      value={selectedConnIdx}
                      onChange={e => setSelectedConnIdx(Number(e.target.value))}
                      className="w-full bg-card border border-border px-1.5 py-1 text-[10px] mb-1"
                    >
                      {activeConnections.map((c: any, i: number) => (
                        <option key={c.id} value={i}>{c.display_name} ({c.broker_type})</option>
                      ))}
                    </select>
                  )}
                  <p className="text-[10px] text-destructive uppercase tracking-wider mb-1 font-bold">Live Broker — {selectedConnection?.display_name}</p>
                  {brokerAccount ? (
                    <>
                      <div className="flex justify-between"><span className="text-muted-foreground">Balance</span><span className="font-mono font-bold">{brokerAccount.balance ?? brokerAccount.equity ?? "—"} {brokerAccount.currency || ""}</span></div>
                      {brokerAccount.equity && <div className="flex justify-between"><span className="text-muted-foreground">Equity</span><span className="font-mono">{brokerAccount.equity} {brokerAccount.currency || ""}</span></div>}
                      {brokerAccount.margin != null && <div className="flex justify-between"><span className="text-muted-foreground">Margin Used</span><span className="font-mono">{brokerAccount.margin}</span></div>}
                      {brokerAccount.freeMargin != null && <div className="flex justify-between"><span className="text-muted-foreground">Free Margin</span><span className="font-mono">{brokerAccount.freeMargin}</span></div>}
                      {brokerAccount.marginLevel != null && <div className="flex justify-between"><span className="text-muted-foreground">Margin Level</span><span className="font-mono">{brokerAccount.marginLevel}%</span></div>}
                      {brokerAccount.leverage && <div className="flex justify-between"><span className="text-muted-foreground">Leverage</span><span className="font-mono">1:{brokerAccount.leverage}</span></div>}
                    </>
                  ) : (
                    <p className="text-muted-foreground text-[10px]">Loading broker data...</p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Live Broker Open Trades */}
            {isLiveMode && selectedConnection && brokerOpenTrades && Array.isArray(brokerOpenTrades) && brokerOpenTrades.length > 0 && (
              <Card>
                <CardContent className="pt-3 pb-2 space-y-1.5 text-[11px]">
                  <p className="text-[10px] text-destructive uppercase tracking-wider mb-1 font-bold">Broker Positions ({brokerOpenTrades.length})</p>
                  {brokerOpenTrades.slice(0, 10).map((t: any, i: number) => (
                    <div key={t.id || i} className="flex items-center justify-between text-[10px] py-0.5 border-b border-border/20 last:border-0">
                      <div className="flex items-center gap-1">
                        <span className={t.type === "SELL" || t.currentUnits < 0 || t.type === "POSITION_TYPE_SELL" ? "text-destructive" : "text-success"}>
                          {t.type === "SELL" || t.currentUnits < 0 || t.type === "POSITION_TYPE_SELL" ? "▼" : "▲"}
                        </span>
                        <span className="font-mono font-medium">{t.instrument || t.symbol}</span>
                      </div>
                      <span className={`font-mono ${parseFloat(t.unrealizedPL || t.profit || t.unrealizedProfit || 0) >= 0 ? "text-success" : "text-destructive"}`}>
                        {formatMoney(parseFloat(t.unrealizedPL || t.profit || t.unrealizedProfit || 0), true)}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

          </div>
        </div>

        {/* Bottom: Scan Master-Detail 60/40 */}
        <div className="md:h-56 border-t border-border mt-2 pt-2 shrink-0 flex flex-col md:flex-row gap-0 min-h-0">
          {/* Left: Latest Scan Pairs (60%) */}
          <div className="w-full md:w-[60%] flex flex-col min-h-0 md:border-r border-border md:pr-2 max-h-48 md:max-h-none">
            <div className="flex items-center justify-between mb-1 gap-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider truncate flex items-center gap-1.5">
                {safeScanIdx === 0 ? "Latest Scan" : `Scan #${safeScanIdx + 1} of ${logs.length}`}
                {currentScan?.scanned_at && (
                  <span className="ml-1 text-foreground font-mono">
                    — {formatTimeOnly(currentScan.scanned_at)}
                  </span>
                )}
                {logs.length > 1 && (
                  <span className="inline-flex items-center gap-0.5 ml-1">
                    <button
                      onClick={() => { setSelectedScanIdx(i => Math.min(logs.length - 1, i + 1)); setSelectedPairIdx(0); }}
                      disabled={safeScanIdx >= logs.length - 1}
                      className="px-1 py-0 h-4 text-[9px] rounded border border-border hover:bg-secondary/50 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Older scan"
                    >‹ older</button>
                    <button
                      onClick={() => { setSelectedScanIdx(i => Math.max(0, i - 1)); setSelectedPairIdx(0); }}
                      disabled={safeScanIdx <= 0}
                      className="px-1 py-0 h-4 text-[9px] rounded border border-border hover:bg-secondary/50 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Newer scan"
                    >newer ›</button>
                    {safeScanIdx > 0 && (
                      <button
                        onClick={() => { setSelectedScanIdx(0); setSelectedPairIdx(0); }}
                        className="px-1 py-0 h-4 text-[9px] rounded border border-primary/40 text-primary hover:bg-primary/10"
                        title="Jump to latest"
                      >latest</button>
                    )}
                  </span>
                )}

              </p>
              <div className="flex items-center gap-2 shrink-0">
                <SessionStatusPill sessions={botConfig?.sessions} scanDetails={latestRawDetails} />
                {botConfig?.strategy && (
                  <Badge
                    variant="outline"
                    className="text-[8px] font-mono px-1.5 py-0 h-4 border-border/60"
                    title="Active confluence gate. Setups must score above this percentage to trigger."
                  >
                    Gate: ≥{(botConfig.strategy?.confluenceThreshold ?? 55)}%
                  </Badge>
                )}
                {currentScan && (
                  <span className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
                    <DataSourceBadge source={latestSource} />
                    {currentScan?.pairs_scanned || 0} pairs · {currentScan?.signals_found || 0} signals · {currentScan?.trades_placed || 0} trades
                  </span>
                )}

              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {(() => {
                  if (latestDetailsClean.length === 0) {
                    return <p className="text-[10px] text-muted-foreground text-center py-8">No scans yet — click "Scan Now"</p>;
                  }
                  return (
                    <div className="space-y-0">
                      {latestDetailsClean.map((sig: any, i: number) => {
                        const statusLabel = sig.status === "trade_placed" ? "PLACED" : sig.status === "rejected" ? "REJECTED" : sig.status === "below_threshold" ? "SKIP" : sig.status?.toUpperCase() || "—";
                        const statusColor = sig.status === "trade_placed" ? "text-success bg-success/10 border-success/30" : sig.status === "rejected" ? "text-destructive bg-destructive/10 border-destructive/30" : "text-muted-foreground bg-muted/20 border-border";
                        const isSelected = selectedPairIdx === i;
                        return (
                          <button
                            key={i}
                            onClick={() => setSelectedPairIdx(i)}
                            className={`w-full flex items-center justify-between text-[10px] py-1.5 px-2 transition-colors ${isSelected ? "bg-primary/10 border-l-2 border-primary" : "border-l-2 border-transparent hover:bg-secondary/30"}`}
                          >
                            <div className="min-w-0 flex items-center gap-1.5 flex-1">
                              {sig.direction === "long" ? <TrendingUp className="h-2.5 w-2.5 shrink-0 text-success" /> : sig.direction === "short" ? <TrendingDown className="h-2.5 w-2.5 shrink-0 text-destructive" /> : <Minus className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />}
                              <span className="font-medium shrink-0">{sig.pair}</span>

                              {sig.reason && <span className="truncate text-[9px] text-muted-foreground min-w-0">— {sig.reason}</span>}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className={`font-mono font-bold ${sig.score >= 60 ? "text-success" : sig.score >= 40 ? "text-warning" : "text-muted-foreground"}`}>{typeof sig.score === "number" ? `${sig.score.toFixed(1)}%` : "—"}</span>
                              <span className={`text-[8px] font-bold uppercase px-1 py-0.5 border ${statusColor}`}>{statusLabel}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
            </div>
          </div>

          {/* Right: Detail Breakdown (40%) */}
          <div className="w-full md:w-[40%] flex flex-col min-h-0 md:pl-2 border-t md:border-t-0 border-border pt-2 md:pt-0 max-h-64 md:max-h-none">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Detail Breakdown</p>
            <div className="flex-1 overflow-y-auto">
              {(() => {
                  const selected = latestDetailsClean[selectedPairIdx];
                  if (!selected) {
                    return <p className="text-[10px] text-muted-foreground text-center py-8">Select a pair to view details</p>;
                  }
                  return <ScanDetailInline signal={selected} />;
                })()}
            </div>
          </div>
        </div>

        {/* Kill Switch Banner */}
        {d.killSwitchActive && (
          <div className="fixed bottom-16 md:bottom-6 left-0 md:left-12 right-0 bg-destructive/95 text-destructive-foreground px-4 py-2 flex items-center justify-between z-50">
            <span className="text-xs font-bold">⚠ KILL SWITCH ACTIVE — All Trading Halted</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="h-6 text-[10px] border-destructive-foreground text-destructive-foreground" onClick={() => deactivateKill.mutate()}>Deactivate</Button>
            </div>
          </div>
        )}

        <BotConfigModal open={configOpen} onClose={() => setConfigOpen(false)} />
      </div>
    </AppShell>
  );
}

function TradeHistoryTable({ trades }: { trades: any[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const totalPages = Math.ceil((trades?.length || 0) / pageSize);
  if (!trades || trades.length === 0) return <p className="text-xs text-muted-foreground py-4 text-center">No trades</p>;
  const pagedTrades = trades.slice(page * pageSize, (page + 1) * pageSize);

  const reasonColor = (r: string) => {
    if (r === "tp_hit" || r === "trail_hit") return "text-success";
    if (r === "sl_hit") return "text-destructive";
    if (r === "be_hit") return "text-muted-foreground";
    if (r === "time_exit" || r === "kill_switch") return "text-warning";
    return "text-muted-foreground";
  };

  return (
    <>
    <div className="overflow-x-auto"><table className="w-full text-[11px] font-mono min-w-[700px]">
      <thead><tr className="border-b border-border text-muted-foreground text-[10px]">
        <th className="w-4 py-1 px-1"></th>
        <th className="text-left py-1 px-1">Opened</th><th className="text-left py-1 px-1">Closed</th>
        <th className="text-left py-1 px-1">Symbol</th><th className="text-left py-1 px-1">Dir</th>
        <th className="text-right py-1 px-1">Entry</th><th className="text-right py-1 px-1">Exit</th>
        <th className="text-right py-1 px-1">Pips</th><th className="text-right py-1 px-1">P&L</th>
        <th className="text-left py-1 px-1">Reason</th>
      </tr></thead>
      <tbody>
        {pagedTrades.map((t: any, i: number) => {
          const key = t.orderId || t.positionId || `${t.symbol}-${t.closedAt}-${i}`;
          const isOpen = expanded === key;
          return (
            <React.Fragment key={key}>
              <tr
                onClick={() => setExpanded(isOpen ? null : key)}
                className={`border-b border-border/30 hover:bg-secondary/30 cursor-pointer ${i % 2 === 1 ? "bg-secondary/10" : ""}`}
              >
                <td className="py-1 px-1 text-muted-foreground">
                  <ChevronDown className={`h-2.5 w-2.5 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </td>
                <td className="py-1 px-1 text-[10px] text-muted-foreground">{formatBrokerTime(t.openTime)}</td>
                <td className="py-1 px-1 text-[10px] text-muted-foreground">{formatBrokerTime(t.closedAt)}</td>
                <td className="py-1 px-1">{t.symbol}</td>
                <td className={`py-1 px-1 ${t.direction === "long" ? "text-success" : "text-destructive"}`}>{t.direction === "long" ? "▲" : "▼"}</td>
                <td className="py-1 px-1 text-right">{parseFloat(t.entryPrice)?.toFixed(5)}</td>
                <td className="py-1 px-1 text-right">{parseFloat(t.exitPrice)?.toFixed(5)}</td>
                <td className="py-1 px-1 text-right">{t.pnlPips?.toFixed(1)}</td>
                <td className={`py-1 px-1 text-right font-medium ${t.pnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(t.pnl, true)}</td>
                <td className={`py-1 px-1 text-[10px] ${reasonColor(t.closeReason)}`}>{t.closeReason}</td>
              </tr>
              {isOpen && (
                <tr className="bg-secondary/20 border-b border-border">
                  <td colSpan={10} className="p-2">
                    <div className="space-y-1 text-[10px]">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-bold">Signal Reasoning</p>
                        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 border rounded ${
                          t.closeReason === "tp_hit" || t.closeReason === "trail_hit" ? "bg-success/15 border-success/40 text-success" :
                          t.closeReason === "sl_hit" ? "bg-destructive/15 border-destructive/40 text-destructive" :
                          t.closeReason === "be_hit" ? "bg-secondary border-border text-foreground" :
                          "bg-muted/40 border-border text-muted-foreground"
                        }`}>
                          Closed: {t.closeReason || "—"}
                          {t.closeReason === "trail_hit" && " (trailing stop locked profit)"}
                          {t.closeReason === "be_hit" && " (break-even SL)"}
                        </span>
                      </div>
                      <SignalReasoningCard signalReason={t.signalReason || ""} />
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mt-1 text-[9px]">
                        <div className="flex justify-between"><span className="text-muted-foreground">Score</span><span className="font-mono font-bold text-primary">{t.signalScore > 10 ? `${Number(t.signalScore).toFixed(1)}%` : `${t.signalScore}/10`}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Order ID</span><span className="font-mono">{t.orderId}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Opened</span><span className="font-mono">{formatFullDateTime(t.openTime)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Closed</span><span className="font-mono">{formatFullDateTime(t.closedAt)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Size</span><span className="font-mono">{t.size}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">P&L Pips</span><span className="font-mono">{t.pnlPips?.toFixed(1)}</span></div>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table></div>
    {totalPages > 1 && (
      <div className="flex items-center justify-between px-2 py-2 border-t border-border">
        <span className="text-[10px] text-muted-foreground font-mono">
          {page * pageSize + 1}–{Math.min((page + 1) * pageSize, trades.length)} of {trades.length}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPage(0)}
            disabled={page === 0}
            className="px-1.5 py-0.5 text-[10px] font-mono border border-border rounded hover:bg-secondary/50 disabled:opacity-30 disabled:cursor-not-allowed"
          >«</button>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-1.5 py-0.5 text-[10px] font-mono border border-border rounded hover:bg-secondary/50 disabled:opacity-30 disabled:cursor-not-allowed"
          >‹</button>
          <span className="text-[10px] font-mono text-muted-foreground px-2">{page + 1}/{totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="px-1.5 py-0.5 text-[10px] font-mono border border-border rounded hover:bg-secondary/50 disabled:opacity-30 disabled:cursor-not-allowed"
          >›</button>
          <button
            onClick={() => setPage(totalPages - 1)}
            disabled={page >= totalPages - 1}
            className="px-1.5 py-0.5 text-[10px] font-mono border border-border rounded hover:bg-secondary/50 disabled:opacity-30 disabled:cursor-not-allowed"
          >»</button>
        </div>
      </div>
    )}
    </>
  );
}

function ScanLogLine({ log }: { log: any }) {
  const time = formatTimeOnly(log.scanned_at);
  return (
    <div className="flex items-center gap-2 text-[10px] py-0.5">
      <span className="font-mono text-muted-foreground w-16 shrink-0">{time}</span>
      <Activity className="h-2.5 w-2.5 text-primary shrink-0" />
      <span>{log.pairs_scanned} pairs scanned</span>
      {log.signals_found > 0 && <span className="text-primary">⚡ {log.signals_found} signals</span>}
      {log.trades_placed > 0 && <span className="text-success">✓ {log.trades_placed} trades</span>}
    </div>
  );
}

function ScanSignalDetail({ signal: d }: { signal: any }) {
  const [expanded, setExpanded] = useState(false);
  const statusLabel = d.status === "trade_placed" ? "PLACED" : d.status === "rejected" ? "REJECTED" : d.status === "below_threshold" ? "SKIP" : d.status?.toUpperCase() || "—";
  const statusColor = d.status === "trade_placed" ? "text-success bg-success/10 border-success/30" : d.status === "rejected" ? "text-destructive bg-destructive/10 border-destructive/30" : "text-muted-foreground bg-muted/20 border-border";

  return (
    <div className="border-b border-border/30 last:border-b-0">
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center justify-between text-[10px] py-1.5 hover:bg-secondary/30 transition-colors px-1">
        <div className="flex items-center gap-1.5">
          {d.direction === "long" ? <TrendingUp className="h-2.5 w-2.5 text-success" /> : d.direction === "short" ? <TrendingDown className="h-2.5 w-2.5 text-destructive" /> : <Minus className="h-2.5 w-2.5 text-muted-foreground" />}
          <span className="font-medium">{d.pair}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`font-mono font-bold ${d.score > 10 ? (d.score >= 60 ? "text-success" : d.score >= 40 ? "text-warning" : "text-muted-foreground") : (d.score >= 6 ? "text-success" : d.score >= 4 ? "text-warning" : "text-muted-foreground")}`}>{d.score > 10 ? `${d.score.toFixed(1)}%` : d.score?.toFixed(1)}</span>
          <span className={`text-[8px] font-bold uppercase px-1 py-0.5 border ${statusColor}`}>{statusLabel}</span>
          <ChevronDown className={`h-2.5 w-2.5 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
        </div>
      </button>
      {expanded && (
        <div className="px-1 pb-2 space-y-1.5">
          {/* Factors */}
          {d.factors && (() => {
            const isDisabled = (f: any) => f.weight === 0 || (typeof f.detail === "string" && /disabled/i.test(f.detail));
            const enabledFactors = d.factors.filter((f: any) => !isDisabled(f) || f.name === "Power of 3 Combo");
            const disabledFactors = d.factors.filter((f: any) => isDisabled(f) && f.name !== "Power of 3 Combo");
            const primaryFactors = enabledFactors.filter((f: any) => f.name !== "Power of 3 Combo");
            const primaryPresent = primaryFactors.filter((f: any) => f.present).length;
            const ratio = primaryFactors.length > 0 ? primaryPresent / primaryFactors.length : 0;
            return (
            <div className="space-y-0.5">
              <p
                className={`text-[8px] uppercase tracking-wider ${
                  ratio >= 0.6 ? "text-success" : ratio >= 0.4 ? "text-warning" : "text-muted-foreground"
                }`}
                title={`${primaryPresent} primary factors present out of ${primaryFactors.length} total (Power of 3 Combo is an enhancement). Score is weighted, grouped into 9 categories with anti-double-count rules, capped at 10.`}
              >
                Factors ({primaryPresent}/{primaryFactors.length})
              </p>
              {enabledFactors.map((f: any, fi: number) => (
                <div key={fi} className="flex items-start gap-1 text-[9px]">
                  <span className={`mt-0.5 ${f.present ? "text-success" : "text-muted-foreground/50"}`}>{f.present ? "✓" : "✗"}</span>
                  <div>
                    <span className={f.present ? "text-foreground" : "text-muted-foreground/60"}>{f.name}</span>
                    {f.detail && <span className="text-muted-foreground ml-1">— {f.detail}</span>}
                  </div>
                </div>
              ))}
              {disabledFactors.length > 0 && (
                <>
                  <div className="border-t border-dashed border-border/50 my-1.5" />
                  <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60 font-medium">Disabled ({disabledFactors.length})</p>
                  {disabledFactors.map((f: any, fi: number) => (
                    <div key={`dis-${fi}`} className="flex items-start gap-1 text-[9px] opacity-50">
                      <span className="mt-0.5 text-muted-foreground/60">—</span>
                      <div>
                        <span className="text-muted-foreground/70 line-through">{f.name}</span>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
            );
          })()}
          {/* Risk Gates */}
          {d.gates && (
            <div className="space-y-0.5">
              <p className="text-[8px] text-muted-foreground uppercase tracking-wider">Risk Gates</p>
              {d.gates.map((g: any, gi: number) => (
                <div key={gi} className={`flex items-center gap-1 text-[9px] ${g.passed ? "text-muted-foreground" : "text-destructive"}`}>
                  <span>{g.passed ? "✓" : "✗"}</span>
                  <span>{g.reason}</span>
                </div>
              ))}
            </div>
          )}
          {/* Rejection Reasons */}
          {d.rejectionReasons && d.rejectionReasons.length > 0 && (
            <div className="space-y-0.5">
              <p className="text-[8px] text-destructive uppercase tracking-wider font-bold">Rejection Reasons</p>
              {d.rejectionReasons.map((r: string, ri: number) => (
                <p key={ri} className="text-[9px] text-destructive">⚠ {r}</p>
              ))}
            </div>
          )}

          {/* Summary */}
          {d.summary && <p className="text-[9px] text-muted-foreground italic mt-1">{d.summary}</p>}
        </div>
      )}
    </div>
  );
}

function ScanDetailInline({ signal: d }: { signal: any }) {
  const statusLabel = d.status === "trade_placed" ? "PLACED" : d.status === "rejected" ? "REJECTED" : d.status === "below_threshold" ? "SKIP" : d.status?.toUpperCase() || "—";
  const statusColor = d.status === "trade_placed" ? "text-success" : d.status === "rejected" ? "text-destructive" : "text-muted-foreground";

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        {d.direction === "long" ? <TrendingUp className="h-3 w-3 text-success" /> : d.direction === "short" ? <TrendingDown className="h-3 w-3 text-destructive" /> : <Minus className="h-3 w-3 text-muted-foreground" />}
        <span className="text-[11px] font-bold">{d.pair}</span>
        <span className={`text-[10px] font-bold ${statusColor}`}>{statusLabel}</span>
        <span className={`text-[10px] font-mono font-bold ml-auto ${d.score > 10 ? (d.score >= 60 ? "text-success" : d.score >= 40 ? "text-warning" : "text-muted-foreground") : (d.score >= 6 ? "text-success" : d.score >= 4 ? "text-warning" : "text-muted-foreground")}`}>{d.score > 10 ? `${d.score.toFixed(1)}%` : `${d.score?.toFixed(1)}/10`}</span>
      </div>

      {d.reason && (
        <div className="rounded border border-border bg-muted/20 px-2 py-1.5">
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider font-bold">Why it was skipped</p>
          <p className="mt-1 text-[10px] text-foreground">{d.reason}</p>
        </div>
      )}

      {/* Factors */}
      {d.factors && (() => {
        const isDisabled = (f: any) => f.weight === 0 || (typeof f.detail === "string" && /disabled/i.test(f.detail));
        const enabledFactors = d.factors.filter((f: any) => !isDisabled(f) || f.name === "Power of 3 Combo");
        const disabledFactors = d.factors.filter((f: any) => isDisabled(f) && f.name !== "Power of 3 Combo");
        const primaryFactors = enabledFactors.filter((f: any) => f.name !== "Power of 3 Combo");
        const primaryPresent = primaryFactors.filter((f: any) => f.present).length;
        const ratio = primaryFactors.length > 0 ? primaryPresent / primaryFactors.length : 0;
        return (
        <div className="space-y-0.5">
          <p
            className={`text-[8px] uppercase tracking-wider font-bold ${
              ratio >= 0.6 ? "text-success" : ratio >= 0.4 ? "text-warning" : "text-muted-foreground"
            }`}
            title={`${primaryPresent} primary factors present out of ${primaryFactors.length} total (Power of 3 Combo is an enhancement). Score is weighted, grouped into 9 categories with anti-double-count rules, capped at 10.`}
          >
            Factors ({primaryPresent}/{primaryFactors.length})
          </p>
          {enabledFactors.map((f: any, fi: number) => (
            <div key={fi} className="flex items-start gap-1 text-[9px]">
              <span className={`mt-0.5 ${f.present ? "text-success" : "text-muted-foreground/50"}`}>{f.present ? "✓" : "✗"}</span>
              <div>
                <span className={f.present ? "text-foreground" : "text-muted-foreground/60"}>{f.name}</span>
                {f.detail && <span className="text-muted-foreground ml-1">— {f.detail}</span>}
              </div>
            </div>
          ))}
          {disabledFactors.length > 0 && (
            <>
              <div className="border-t border-dashed border-border/50 my-1.5" />
              <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60 font-medium">Disabled ({disabledFactors.length})</p>
              {disabledFactors.map((f: any, fi: number) => (
                <div key={`dis-${fi}`} className="flex items-start gap-1 text-[9px] opacity-50">
                  <span className="mt-0.5 text-muted-foreground/60">—</span>
                  <div>
                    <span className="text-muted-foreground/70 line-through">{f.name}</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
        );
      })()}

      {/* Risk Gates */}
      {d.gates && (
        <div className="space-y-0.5">
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider font-bold">Risk Gates</p>
          {d.gates.map((g: any, gi: number) => (
            <div key={gi} className={`flex items-center gap-1 text-[9px] ${g.passed ? "text-muted-foreground" : "text-destructive"}`}>
              <span>{g.passed ? <ShieldCheck className="h-2.5 w-2.5" /> : <ShieldX className="h-2.5 w-2.5" />}</span>
              <span>{g.reason}</span>
            </div>
          ))}
        </div>
      )}

      {/* Rejection Reasons */}
      {d.rejectionReasons && d.rejectionReasons.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[8px] text-destructive uppercase tracking-wider font-bold">Rejection Reasons</p>
          {d.rejectionReasons.map((r: string, ri: number) => (
            <p key={ri} className="text-[9px] text-destructive">⚠ {r}</p>
          ))}
        </div>
      )}


      {/* Summary */}
      {d.summary && <p className="text-[9px] text-muted-foreground italic mt-1">{d.summary}</p>}
    </div>
  );
}

// ── Inline SL/TP editor for an open paper position ──
function EditSLTPInline({ position, onSaved }: { position: any; onSaved: () => void }) {
  const [sl, setSl] = useState(position.stopLoss ? String(parseFloat(position.stopLoss)) : "");
  const [tp, setTp] = useState(position.takeProfit ? String(parseFloat(position.takeProfit)) : "");
  const [saving, setSaving] = useState(false);

  const initialSl = position.stopLoss ? String(parseFloat(position.stopLoss)) : "";
  const initialTp = position.takeProfit ? String(parseFloat(position.takeProfit)) : "";
  const dirty = sl !== initialSl || tp !== initialTp;

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates: { stopLoss?: number | null; takeProfit?: number | null } = {};
      if (sl !== initialSl) updates.stopLoss = sl === "" ? null : parseFloat(sl);
      if (tp !== initialTp) updates.takeProfit = tp === "" ? null : parseFloat(tp);
      await paperApi.updatePosition(position.id, updates);
      toast.success("SL/TP updated");
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Failed to update SL/TP");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-end gap-2 pt-2 border-t border-border/40">
      <div className="space-y-0.5">
        <Label className="text-[9px] text-muted-foreground uppercase tracking-wider">Stop Loss</Label>
        <Input
          type="number"
          step="0.00001"
          value={sl}
          onChange={(e) => setSl(e.target.value)}
          placeholder="—"
          className="h-7 w-24 text-[10px] font-mono px-1.5"
        />
      </div>
      <div className="space-y-0.5">
        <Label className="text-[9px] text-muted-foreground uppercase tracking-wider">Take Profit</Label>
        <Input
          type="number"
          step="0.00001"
          value={tp}
          onChange={(e) => setTp(e.target.value)}
          placeholder="—"
          className="h-7 w-24 text-[10px] font-mono px-1.5"
        />
      </div>
      <Button
        size="sm"
        className="h-7 text-[10px]"
        disabled={!dirty || saving}
        onClick={handleSave}
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
      </Button>
      {dirty && !saving && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[10px]"
          onClick={() => { setSl(initialSl); setTp(initialTp); }}
        >
          Reset
        </Button>
      )}
    </div>
  );
}
