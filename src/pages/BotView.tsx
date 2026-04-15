import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatMoney, INSTRUMENTS } from "@/lib/marketData";
import { paperApi, scannerApi } from "@/lib/api";
import { toast } from "sonner";
import {
  Play, Pause, Square, AlertTriangle, Scan, Loader2,
  TrendingUp, TrendingDown, Minus, Clock, ShieldCheck, ShieldX,
  ChevronDown, ChevronUp, Plus, Settings, Activity,
} from "lucide-react";
import { BotConfigModal } from "@/components/BotConfigModal";

export default function BotView() {
  const queryClient = useQueryClient();
  const [orderFormOpen, setOrderFormOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [liveModeConfirm, setLiveModeConfirm] = useState(false);

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
                  <p className="text-xs text-muted-foreground py-8 text-center border border-dashed border-border">No open positions. Click "+ Order" to place a trade.</p>
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
                        <tr key={p.id} className={`border-b border-border/30 hover:bg-secondary/30 ${idx % 2 === 1 ? "bg-secondary/10" : ""}`}>
                          <td className="py-1.5 px-1 font-medium">{p.symbol}</td>
                          <td className={`py-1.5 px-1 ${p.direction === "long" ? "text-success" : "text-destructive"}`}>{p.direction === "long" ? "▲" : "▼"}</td>
                          <td className="py-1.5 px-1 text-right">{parseFloat(p.entryPrice)?.toFixed(5)}</td>
                          <td className="py-1.5 px-1 text-right">{parseFloat(p.currentPrice)?.toFixed(5)}</td>
                          <td className={`py-1.5 px-1 text-right font-medium ${p.pnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(p.pnl, true)}</td>
                          <td className="py-1.5 px-1 text-right">{parseFloat(p.size)?.toFixed(2)}</td>
                          <td className="py-1.5 px-1 text-right">{p.stopLoss ? parseFloat(p.stopLoss).toFixed(5) : "—"}</td>
                          <td className="py-1.5 px-1 text-right">{p.takeProfit ? parseFloat(p.takeProfit).toFixed(5) : "—"}</td>
                          <td className="py-1.5 px-1 text-[10px] text-muted-foreground truncate max-w-[100px]">{p.signalReason || "—"}</td>
                          <td className="py-1.5 px-1">
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
            <Card>
              <CardContent className="pt-3 pb-2 space-y-1.5 text-[11px]">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Account</p>
                <div className="flex justify-between"><span className="text-muted-foreground">Balance</span><span className="font-mono font-bold">{formatMoney(d.balance)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Equity</span><span className="font-mono">{formatMoney(d.equity)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Daily P&L</span><span className={`font-mono font-medium ${d.dailyPnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(d.dailyPnl, true)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Drawdown</span><span className={`font-mono ${(d.drawdown || 0) > 10 ? "text-destructive" : (d.drawdown || 0) > 5 ? "text-warning" : ""}`}>{(d.drawdown || 0).toFixed(1)}%</span></div>
              </CardContent>
            </Card>

            {/* Strategy Metrics */}
            <Card>
              <CardContent className="pt-3 pb-2 space-y-1.5 text-[11px]">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Metrics</p>
                <div className="flex justify-between"><span className="text-muted-foreground">Win Rate</span><span className={`font-mono font-bold ${(d.winRate || 0) >= 50 ? "text-success" : "text-destructive"}`}>{(d.winRate || 0).toFixed(1)}%</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Win / Loss</span><span className="font-mono">{d.wins}W / {d.losses}L</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Total Trades</span><span className="font-mono">{d.totalTrades}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Rejected</span><span className="font-mono text-warning">{d.rejectedCount}</span></div>
              </CardContent>
            </Card>

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

            {/* Latest Scan Results */}
            {logs.length > 0 && logs[0]?.details_json && (
              <Card>
                <CardHeader className="pb-1 pt-3"><CardTitle className="text-[11px]">Latest Scan</CardTitle></CardHeader>
                <CardContent className="space-y-1">
                  {(Array.isArray(logs[0].details_json) ? logs[0].details_json : []).slice(0, 6).map((d: any, i: number) => (
                    <div key={i} className="flex items-center justify-between text-[10px] py-0.5">
                      <div className="flex items-center gap-1.5">
                        {d.direction === "long" ? <TrendingUp className="h-2.5 w-2.5 text-success" /> : d.direction === "short" ? <TrendingDown className="h-2.5 w-2.5 text-destructive" /> : <Minus className="h-2.5 w-2.5 text-muted-foreground" />}
                        <span className="font-medium">{d.pair}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className={`font-mono font-bold ${d.score >= 6 ? "text-success" : d.score >= 4 ? "text-warning" : "text-muted-foreground"}`}>{d.score?.toFixed(1)}</span>
                        <span className={`text-[9px] ${d.status === "trade_placed" ? "text-success" : d.status === "rejected" ? "text-destructive" : "text-muted-foreground"}`}>
                          {d.status === "trade_placed" ? "📈" : d.status === "rejected" ? "🛡" : "—"}
                        </span>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Bottom: Live Log */}
        <div className="h-44 border-t border-border mt-2 pt-2 overflow-y-auto shrink-0">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Live Log</p>
          {logs.length === 0 ? (
            <p className="text-[10px] text-muted-foreground text-center py-4">No scans yet — click "Scan Now" or start the engine</p>
          ) : (
            <div className="space-y-0.5">
              {logs.slice(0, 15).map((log: any) => (
                <ScanLogLine key={log.id} log={log} />
              ))}
            </div>
          )}
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
