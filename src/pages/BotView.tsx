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
import { paperApi, scannerApi, brokerApi, botConfigApi, brokerExecApi } from "@/lib/api";
import { STYLE_META, getActiveStyle } from "@/lib/botStyleClassifier";
import { toast } from "sonner";
import {
  Play, Pause, Square, AlertTriangle, Scan, Loader2,
  TrendingUp, TrendingDown, Minus, Clock, ShieldCheck, ShieldX,
  ChevronDown, ChevronUp, Plus, Settings, Activity, Monitor,
} from "lucide-react";
import { BotConfigModal } from "@/components/BotConfigModal";
import { useNavigate } from "react-router-dom";

export default function BotView() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [orderFormOpen, setOrderFormOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [liveModeConfirm, setLiveModeConfirm] = useState(false);
  const [expandedPosition, setExpandedPosition] = useState<string | null>(null);
  const [selectedPairIdx, setSelectedPairIdx] = useState(0);

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
  const primaryConnection = activeConnections[0];

  // Live broker account data (only when in live mode with an active connection)
  const isLiveMode = status?.executionMode === "live";
  const { data: brokerAccount } = useQuery({
    queryKey: ["broker-account", primaryConnection?.id],
    queryFn: () => brokerExecApi.accountSummary(primaryConnection.id),
    enabled: !!primaryConnection && isLiveMode,
    refetchInterval: 10000,
  });

  const { data: brokerOpenTrades } = useQuery({
    queryKey: ["broker-open-trades", primaryConnection?.id],
    queryFn: () => brokerExecApi.openTrades(primaryConnection.id),
    enabled: !!primaryConnection && isLiveMode,
    refetchInterval: 10000,
  });

  const startMut = useMutation({ mutationFn: () => paperApi.startEngine(), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Engine started"); } });
  const pauseMut = useMutation({ mutationFn: () => paperApi.pauseEngine(), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Engine paused"); } });
  const stopMut = useMutation({ mutationFn: () => paperApi.stopEngine(), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Engine stopped"); } });
  const killMut = useMutation({ mutationFn: () => paperApi.killSwitch(true), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.error("Kill switch activated"); } });
  const deactivateKill = useMutation({ mutationFn: () => paperApi.killSwitch(false), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Kill switch deactivated"); } });
  const resetMut = useMutation({ mutationFn: () => paperApi.resetAccount(), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Account reset"); } });
  const scanMut = useMutation({
    mutationFn: () => scannerApi.manualScan(),
    onSuccess: (data: any) => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); queryClient.invalidateQueries({ queryKey: ["scan-logs"] }); toast.success(`Scan: ${data.signalsFound} signals, ${data.tradesPlaced} trades`); },
    onError: (err: any) => toast.error(err.message),
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
  const closedToday = (d.tradeHistory || []).filter((t: any) => {
    const today = new Date().toISOString().split('T')[0];
    return t.closedAt?.startsWith(today);
  });

  return (
    <AppShell>
      <div className="flex flex-col h-[calc(100vh-4.5rem)]">
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

        {/* Top Control Bar */}
        <div className="flex items-center gap-2 pb-2 border-b border-border flex-wrap">
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
            if (styleMode === "auto") {
              return (
                <span className="text-[10px] font-medium px-1.5 py-0.5 bg-accent/20 text-accent-foreground border border-accent/30 flex items-center gap-1">
                  🤖 Auto
                </span>
              );
            }
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

          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => scanMut.mutate()} disabled={scanMut.isPending}>
              {scanMut.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Scan className="h-3 w-3 mr-1" />} Scan Now
            </Button>
            <div className="w-px h-5 bg-border" />
            <Button size="sm" variant="destructive" className="h-7 text-[11px]" onClick={() => {
              if (window.confirm("⚠️ KILL SWITCH: This will close ALL open positions and halt trading. Are you sure?")) killMut.mutate();
            }}>
              <AlertTriangle className="h-3 w-3 mr-1" /> Kill
            </Button>

            <div className="flex gap-3 text-[10px] text-muted-foreground">
              <span>Interval: <strong className="text-foreground">{(() => { const s = botConfig?.scanner?.intervalSeconds ?? 30; return s >= 60 ? `${s / 60}m` : `${s}s`; })()}</strong></span>
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
        <div className="flex-1 flex gap-3 mt-2 min-h-0">
          {/* Left: Tabbed Positions (~65%) */}
          <div className="flex-[2] flex flex-col min-h-0">
            <Tabs defaultValue="open" className="flex-1 flex flex-col min-h-0">
              <TabsList className="h-7 shrink-0">
                <TabsTrigger value="open" className="text-[11px] h-6">Open ({d.positions?.length || 0})</TabsTrigger>
                <TabsTrigger value="today" className="text-[11px] h-6">Closed Today ({closedToday.length})</TabsTrigger>
                <TabsTrigger value="history" className="text-[11px] h-6">All History</TabsTrigger>
              </TabsList>
              <TabsContent value="open" className="flex-1 overflow-auto mt-1">
                {(!d.positions || d.positions.length === 0) ? (
                  <div className="flex flex-col items-center justify-center py-12 border border-dashed border-border">
                    <Plus className="h-8 w-8 text-muted-foreground/20 mb-2" />
                    <p className="text-xs font-medium text-muted-foreground">No open positions</p>
                    <p className="text-[10px] text-muted-foreground/70 mt-1">Click "+ Order" to place a trade or start the bot scanner</p>
                  </div>
                ) : (
                  <table className="w-full text-[11px] font-mono">
                    <thead><tr className="border-b border-border text-muted-foreground text-[10px]">
                      <th className="text-left py-1 px-1">Symbol</th><th className="text-left py-1 px-1">Dir</th>
                      <th className="text-right py-1 px-1">Entry</th><th className="text-right py-1 px-1">Current</th>
                      <th className="text-right py-1 px-1">P&L</th><th className="text-right py-1 px-1">Size</th>
                      <th className="text-right py-1 px-1">SL</th><th className="text-right py-1 px-1">TP</th>
                      <th className="text-left py-1 px-1">Signal</th><th className="py-1 px-1"></th>
                    </tr></thead>
                    <tbody>
                      {d.positions.map((p: any, idx: number) => (
                        <React.Fragment key={p.id}>
                          <tr className={`border-b border-border/30 hover:bg-secondary/30 cursor-pointer ${idx % 2 === 1 ? "bg-secondary/10" : ""}`}
                            onClick={() => setExpandedPosition(expandedPosition === p.id ? null : p.id)}>
                            <td className="py-1.5 px-1 font-medium">{p.symbol}</td>
                            <td className={`py-1.5 px-1 ${p.direction === "long" ? "text-success" : "text-destructive"}`}>{p.direction === "long" ? "▲" : "▼"}</td>
                            <td className="py-1.5 px-1 text-right">{parseFloat(p.entryPrice)?.toFixed(5)}</td>
                            <td className="py-1.5 px-1 text-right">{parseFloat(p.currentPrice)?.toFixed(5)}</td>
                            <td className={`py-1.5 px-1 text-right font-medium ${p.pnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(p.pnl, true)}</td>
                            <td className="py-1.5 px-1 text-right">{parseFloat(p.size)?.toFixed(2)}</td>
                            <td className="py-1.5 px-1 text-right">{p.stopLoss ? parseFloat(p.stopLoss).toFixed(5) : "—"}</td>
                            <td className="py-1.5 px-1 text-right">{p.takeProfit ? parseFloat(p.takeProfit).toFixed(5) : "—"}</td>
                            <td className="py-1.5 px-1 text-[10px] text-muted-foreground truncate max-w-[100px]">{p.signalReason || "—"}</td>
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
                              <td colSpan={10} className="bg-secondary/20 border-b border-border p-2">
                                <div className="space-y-1 text-[10px]">
                                  <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-bold">Signal Reasoning</p>
                                  <p className="text-foreground">{p.signalReason || "No reasoning recorded"}</p>
                                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mt-1 text-[9px]">
                                    <div className="flex justify-between"><span className="text-muted-foreground">Score</span><span className="font-mono font-bold text-primary">{p.signalScore}/10</span></div>
                                    <div className="flex justify-between"><span className="text-muted-foreground">Order ID</span><span className="font-mono">{p.orderId}</span></div>
                                    <div className="flex justify-between"><span className="text-muted-foreground">Opened</span><span className="font-mono">{new Date(p.openTime).toLocaleString()}</span></div>
                                    <div className="flex justify-between"><span className="text-muted-foreground">P&L Pips</span><span className="font-mono">{((p.pnl / (parseFloat(p.size) * 100000)) * 10000).toFixed(1)}</span></div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
              </TabsContent>
              <TabsContent value="today" className="flex-1 overflow-auto mt-1">
                <TradeHistoryTable trades={closedToday} />
              </TabsContent>
              <TabsContent value="history" className="flex-1 overflow-auto mt-1">
                <TradeHistoryTable trades={d.tradeHistory || []} />
              </TabsContent>
            </Tabs>
          </div>

          {/* Right sidebar (~35%) */}
          <div className="flex-1 overflow-y-auto space-y-2">
            {/* Account Summary */}
            {(() => {
              const positions = d.positions || [];
              const unrealizedPnl = positions.reduce((s: number, p: any) => s + (p.pnl || 0), 0);
              const totalExposure = positions.reduce((s: number, p: any) => s + (parseFloat(p.size) || 0), 0);
              const longCount = positions.filter((p: any) => p.direction === "long").length;
              const shortCount = positions.filter((p: any) => p.direction === "short").length;
              const bestPos = positions.length > 0 ? positions.reduce((best: any, p: any) => (p.pnl || 0) > (best.pnl || 0) ? p : best, positions[0]) : null;
              const worstPos = positions.length > 0 ? positions.reduce((worst: any, p: any) => (p.pnl || 0) < (worst.pnl || 0) ? p : worst, positions[0]) : null;
              const equity = parseFloat(d.balance) + unrealizedPnl;
              const profitPct = (((parseFloat(d.balance) - 10000) / 10000) * 100);
              const history = d.tradeHistory || [];
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

            {/* Engine Controls */}
            <Card>
              <CardContent className="pt-3 pb-2 space-y-2 text-[11px]">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Engine</p>
                <Button size="sm" variant="outline" className="w-full h-7 text-[11px]" onClick={() => scanMut.mutate()} disabled={scanMut.isPending}>
                  {scanMut.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Scan className="h-3 w-3 mr-1" />} Manual Scan
                </Button>
                <Button size="sm" variant="outline" className="w-full h-7 text-[11px] border-destructive/30 text-destructive hover:bg-destructive/10" onClick={() => {
                  if (window.confirm("Reset account to $10,000? This will close all positions and clear all trade history. This cannot be undone.")) resetMut.mutate();
                }}>Reset Account</Button>
              </CardContent>
            </Card>

            {/* Live Broker Account (only in live mode) */}
            {isLiveMode && primaryConnection && (
              <Card>
                <CardContent className="pt-3 pb-2 space-y-1.5 text-[11px]">
                  <p className="text-[10px] text-destructive uppercase tracking-wider mb-1 font-bold">Live Broker — {primaryConnection.display_name}</p>
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
            {isLiveMode && primaryConnection && brokerOpenTrades && Array.isArray(brokerOpenTrades) && brokerOpenTrades.length > 0 && (
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
        <div className="h-56 border-t border-border mt-2 pt-2 shrink-0 flex gap-0 min-h-0">
          {/* Left: Latest Scan Pairs (60%) */}
          <div className="w-[60%] flex flex-col min-h-0 border-r border-border pr-2">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Latest Scan
                {logs.length > 0 && logs[0]?.scanned_at && (
                  <span className="ml-2 text-foreground font-mono">
                    — {new Date(logs[0].scanned_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                )}
              </p>
              {logs.length > 0 && (
                <span className="text-[9px] text-muted-foreground">
                  {logs[0]?.pairs_scanned || 0} pairs · {logs[0]?.signals_found || 0} signals · {logs[0]?.trades_placed || 0} trades
                </span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {(() => {
                const latestDetails = logs.length > 0 && Array.isArray(logs[0]?.details_json) ? logs[0].details_json : [];
                if (latestDetails.length === 0) {
                  return <p className="text-[10px] text-muted-foreground text-center py-8">No scans yet — click "Scan Now"</p>;
                }
                return (
                  <div className="space-y-0">
                    {latestDetails.map((sig: any, i: number) => {
                      const statusLabel = sig.status === "trade_placed" ? "PLACED" : sig.status === "rejected" ? "REJECTED" : sig.status === "below_threshold" ? "SKIP" : sig.status?.toUpperCase() || "—";
                      const statusColor = sig.status === "trade_placed" ? "text-success bg-success/10 border-success/30" : sig.status === "rejected" ? "text-destructive bg-destructive/10 border-destructive/30" : "text-muted-foreground bg-muted/20 border-border";
                      const isSelected = selectedPairIdx === i;
                      return (
                        <button
                          key={i}
                          onClick={() => setSelectedPairIdx(i)}
                          className={`w-full flex items-center justify-between text-[10px] py-1.5 px-2 transition-colors ${isSelected ? "bg-primary/10 border-l-2 border-primary" : "border-l-2 border-transparent hover:bg-secondary/30"}`}
                        >
                          <div className="min-w-0 flex items-center gap-1.5">
                            {sig.direction === "long" ? <TrendingUp className="h-2.5 w-2.5 shrink-0 text-success" /> : sig.direction === "short" ? <TrendingDown className="h-2.5 w-2.5 shrink-0 text-destructive" /> : <Minus className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />}
                            <div className="min-w-0">
                              <span className="font-medium block">{sig.pair}</span>
                              {sig.reason && <span className="block truncate text-[9px] text-muted-foreground">{sig.reason}</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className={`font-mono font-bold ${sig.score >= 6 ? "text-success" : sig.score >= 4 ? "text-warning" : "text-muted-foreground"}`}>{sig.score?.toFixed(1)}</span>
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
          <div className="w-[40%] flex flex-col min-h-0 pl-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Detail Breakdown</p>
            <div className="flex-1 overflow-y-auto">
              {(() => {
                const latestDetails = logs.length > 0 && Array.isArray(logs[0]?.details_json) ? logs[0].details_json : [];
                const selected = latestDetails[selectedPairIdx];
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
          <div className="fixed bottom-6 left-12 right-0 bg-destructive/95 text-destructive-foreground px-4 py-2 flex items-center justify-between z-50">
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
  if (!trades || trades.length === 0) return <p className="text-xs text-muted-foreground py-4 text-center">No trades</p>;
  return (
    <table className="w-full text-[11px] font-mono">
      <thead><tr className="border-b border-border text-muted-foreground text-[10px]">
        <th className="text-left py-1 px-1">Symbol</th><th className="text-left py-1 px-1">Dir</th>
        <th className="text-right py-1 px-1">Entry</th><th className="text-right py-1 px-1">Exit</th>
        <th className="text-right py-1 px-1">Pips</th><th className="text-right py-1 px-1">P&L</th>
        <th className="text-left py-1 px-1">Reason</th>
      </tr></thead>
      <tbody>
        {trades.slice(0, 30).map((t: any, i: number) => (
          <tr key={i} className={`border-b border-border/30 hover:bg-secondary/30 ${i % 2 === 1 ? "bg-secondary/10" : ""}`}>
            <td className="py-1 px-1">{t.symbol}</td>
            <td className={`py-1 px-1 ${t.direction === "long" ? "text-success" : "text-destructive"}`}>{t.direction === "long" ? "▲" : "▼"}</td>
            <td className="py-1 px-1 text-right">{parseFloat(t.entryPrice)?.toFixed(5)}</td>
            <td className="py-1 px-1 text-right">{parseFloat(t.exitPrice)?.toFixed(5)}</td>
            <td className="py-1 px-1 text-right">{t.pnlPips?.toFixed(1)}</td>
            <td className={`py-1 px-1 text-right font-medium ${t.pnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(t.pnl, true)}</td>
            <td className="py-1 px-1 text-[10px] text-muted-foreground">{t.closeReason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ScanLogLine({ log }: { log: any }) {
  const time = new Date(log.scanned_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
          <span className={`font-mono font-bold ${d.score >= 6 ? "text-success" : d.score >= 4 ? "text-warning" : "text-muted-foreground"}`}>{d.score?.toFixed(1)}</span>
          <span className={`text-[8px] font-bold uppercase px-1 py-0.5 border ${statusColor}`}>{statusLabel}</span>
          <ChevronDown className={`h-2.5 w-2.5 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
        </div>
      </button>
      {expanded && (
        <div className="px-1 pb-2 space-y-1.5">
          {/* Factors */}
          {d.factors && (
            <div className="space-y-0.5">
              <p className="text-[8px] text-muted-foreground uppercase tracking-wider">Factors ({d.factorCount || 0}/9)</p>
              {d.factors.map((f: any, fi: number) => (
                <div key={fi} className="flex items-start gap-1 text-[9px]">
                  <span className={`mt-0.5 ${f.present ? "text-success" : "text-muted-foreground/50"}`}>{f.present ? "✓" : "✗"}</span>
                  <div>
                    <span className={f.present ? "text-foreground" : "text-muted-foreground/60"}>{f.name}</span>
                    {f.detail && <span className="text-muted-foreground ml-1">— {f.detail}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
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
        <span className={`text-[10px] font-mono font-bold ml-auto ${d.score >= 6 ? "text-success" : d.score >= 4 ? "text-warning" : "text-muted-foreground"}`}>{d.score?.toFixed(1)}/10</span>
      </div>

      {d.reason && (
        <div className="rounded border border-border bg-muted/20 px-2 py-1.5">
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider font-bold">Why it was skipped</p>
          <p className="mt-1 text-[10px] text-foreground">{d.reason}</p>
        </div>
      )}

      {/* Factors */}
      {d.factors && (
        <div className="space-y-0.5">
          <p className="text-[8px] text-muted-foreground uppercase tracking-wider font-bold">Factors ({d.factorCount || 0}/9)</p>
          {d.factors.map((f: any, fi: number) => (
            <div key={fi} className="flex items-start gap-1 text-[9px]">
              <span className={`mt-0.5 ${f.present ? "text-success" : "text-muted-foreground/50"}`}>{f.present ? "✓" : "✗"}</span>
              <div>
                <span className={f.present ? "text-foreground" : "text-muted-foreground/60"}>{f.name}</span>
                {f.detail && <span className="text-muted-foreground ml-1">— {f.detail}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

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
