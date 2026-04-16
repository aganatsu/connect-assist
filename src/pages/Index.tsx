import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ComposedChart, Line, CartesianGrid, ReferenceLine, BarChart, Bar, Cell,
} from "recharts";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney, INSTRUMENTS, getCurrentSession, isInKillzone } from "@/lib/marketData";
import { paperApi, marketApi, smcApi, scannerApi } from "@/lib/api";
import { TrendingUp, TrendingDown, Zap, Clock, Activity, AlertTriangle, CheckCircle } from "lucide-react";

type TimeRange = "1W" | "1M" | "3M" | "6M" | "ALL";

const WATCHED_PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "GBP/JPY", "EUR/GBP", "NZD/USD", "USD/CHF", "EUR/JPY"];

export default function Dashboard() {
  const [timeRange, setTimeRange] = useState<TimeRange>("3M");

  const { data: botStatus } = useQuery({
    queryKey: ["paper-status"],
    queryFn: () => paperApi.status(),
    refetchInterval: 10000,
  });


  const { data: liveQuotes } = useQuery({
    queryKey: ["live-quotes"],
    queryFn: async () => {
      const results: Record<string, any> = {};
      await Promise.all(WATCHED_PAIRS.map(async (pair) => {
        try { results[pair] = await marketApi.quote(pair); } catch { results[pair] = null; }
      }));
      return results;
    },
    refetchInterval: 10000,
  });

  const { data: currencyStrength } = useQuery({
    queryKey: ["currency-strength"],
    queryFn: () => {
      if (!liveQuotes) return null;
      const pairData: Record<string, { change: number }> = {};
      Object.entries(liveQuotes).forEach(([pair, q]: [string, any]) => {
        if (q?.change != null) pairData[pair] = { change: q.change };
      });
      return Object.keys(pairData).length > 0 ? smcApi.currencyStrength(pairData) : null;
    },
    enabled: !!liveQuotes,
    staleTime: 30000,
  });

  const { data: scanLogs } = useQuery({
    queryKey: ["scan-logs"],
    queryFn: () => scannerApi.logs(),
    refetchInterval: 30000,
  });

  const balance = botStatus?.balance ?? 10000;
  const profit = balance - 10000;
  const profitPct = ((profit / 10000) * 100).toFixed(1);
  const dailyPnl = botStatus?.dailyPnl ?? 0;
  const positions = botStatus?.positions ?? [];
  const winRate = botStatus?.winRate ?? 0;
  const totalTrades = botStatus?.totalTrades ?? 0;
  const wins = botStatus?.wins ?? 0;
  const losses = botStatus?.losses ?? 0;
  const session = getCurrentSession();
  const kz = isInKillzone();

  const equityData = useMemo(() => {
    const curve = botStatus?.equityCurve;
    if (!curve || curve.length === 0) {
      return [{ date: "Now", equity: balance, drawdown: 0 }];
    }

    // Filter by selected time range
    const now = new Date();
    const cutoff = new Date();
    switch (timeRange) {
      case "1W": cutoff.setDate(now.getDate() - 7); break;
      case "1M": cutoff.setMonth(now.getMonth() - 1); break;
      case "3M": cutoff.setMonth(now.getMonth() - 3); break;
      case "6M": cutoff.setMonth(now.getMonth() - 6); break;
      case "ALL": cutoff.setFullYear(2000); break;
    }

    const filtered = curve.filter((p: any) => {
      const d = new Date(p.date);
      return d >= cutoff;
    });

    if (filtered.length === 0) {
      return [{ date: "Now", equity: balance, drawdown: 0 }];
    }

    return filtered.map((p: any) => {
      const d = new Date(p.date);
      let label: string;
      if (timeRange === "1W") {
        label = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } else if (timeRange === "1M") {
        label = `${d.getMonth() + 1}/${d.getDate()}`;
      } else {
        label = d.toLocaleDateString([], { month: "short", day: "numeric" });
      }
      return { date: label, equity: p.equity, drawdown: 0 };
    });
  }, [botStatus?.equityCurve, balance, timeRange]);

  const strengthData = useMemo(() => {
    if (!currencyStrength) return [];
    return Object.entries(currencyStrength).map(([currency, score]: [string, any]) => ({
      currency, score: typeof score === 'number' ? score : 0,
    })).sort((a, b) => b.score - a.score);
  }, [currencyStrength]);

  // Latest scan signals
  const latestSignals = useMemo(() => {
    const logs = Array.isArray(scanLogs) ? scanLogs : [];
    if (logs.length === 0) return [];
    const latest = logs[0];
    const details = Array.isArray(latest?.details_json) ? latest.details_json : [];
    return details.filter((d: any) => d.score >= 4).slice(0, 5);
  }, [scanLogs]);

  // Bot activity timeline
  const activityLog = useMemo(() => {
    const logs = Array.isArray(scanLogs) ? scanLogs : [];
    const events: { time: string; type: string; message: string }[] = [];
    logs.slice(0, 10).forEach((log: any) => {
      const time = new Date(log.scanned_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      events.push({ time, type: "scan", message: `Scanned ${log.pairs_scanned} pairs — ${log.signals_found} signals, ${log.trades_placed} trades` });
    });
    return events.slice(0, 20);
  }, [scanLogs]);

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">SMC Trading Dashboard</h1>
            <p className="text-muted-foreground text-xs flex items-center gap-2">
              <Clock className="h-3 w-3" /> {session}
              {kz.active && <span className="text-primary font-medium">⚡ {kz.name}</span>}
            </p>
          </div>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium ${
            botStatus?.isRunning ? "text-success" : "text-muted-foreground"
          }`}>
            <span className={`${botStatus?.isRunning ? "status-dot-active" : "w-1.5 h-1.5 rounded-full bg-muted-foreground"}`} />
            {botStatus?.isRunning ? "Bot Running" : "Bot Stopped"}
          </span>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: "Balance", value: formatMoney(balance), sub: `${formatMoney(profit, true)} (${profitPct}%)`, color: profit >= 0 ? "text-success" : "text-destructive" },
            { label: "Today P&L", value: formatMoney(dailyPnl, true), sub: `${totalTrades} trades`, color: dailyPnl >= 0 ? "text-success" : "text-destructive" },
            { label: "Open Positions", value: String(positions.length), sub: `${formatMoney(positions.reduce((s: number, p: any) => s + (p.pnl || 0), 0), true)} unrealized`, color: positions.reduce((s: number, p: any) => s + (p.pnl || 0), 0) >= 0 ? "text-success" : "text-destructive" },
            { label: "Win Rate", value: `${winRate.toFixed(1)}%`, sub: `${wins}W / ${losses}L`, color: winRate >= 50 ? "text-success" : "text-destructive" },
          ].map((kpi) => (
            <Card key={kpi.label}>
              <CardContent className="pt-4 pb-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{kpi.label}</p>
                <p className={`text-xl font-bold font-mono mt-1 ${kpi.color || ""}`}>{kpi.value}</p>
                <p className={`text-xs mt-1 ${kpi.color || "text-muted-foreground"}`}>{kpi.sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Live Prices Grid */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Zap className="h-3.5 w-3.5 text-primary" /> Live Prices
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {WATCHED_PAIRS.map(pair => {
                const q = liveQuotes?.[pair];
                const inst = INSTRUMENTS.find(i => i.symbol === pair);
                const decimals = (inst?.pipSize ?? 0.0001) < 0.01 ? 5 : 3;
                return (
                  <div key={pair} className="p-2.5 bg-secondary/30 border border-border">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">{pair}</span>
                      {q?.change != null && (
                        <span className={`text-[10px] flex items-center gap-0.5 ${q.change >= 0 ? 'text-success' : 'text-destructive'}`}>
                          {q.change >= 0 ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                          {q.change >= 0 ? '+' : ''}{q.change?.toFixed(2)}%
                        </span>
                      )}
                    </div>
                    <p className="text-sm font-mono font-bold mt-1">
                      {q?.price?.toFixed(decimals) ?? '—'}
                    </p>
                    {q?.spread != null && (
                      <p className="text-[10px] text-muted-foreground mt-0.5">{q.spread.toFixed(1)} spread</p>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Active Signals Strip */}
        {latestSignals.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {latestSignals.map((sig: any, i: number) => (
              <div key={i} className={`shrink-0 p-3 border-l-2 bg-card border border-border min-w-[200px] ${
                sig.direction === 'long' ? 'border-l-success' : sig.direction === 'short' ? 'border-l-destructive' : 'border-l-muted-foreground'
              }`}>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold">{sig.pair}</span>
                  <span className={`text-[11px] font-medium ${sig.direction === 'long' ? 'text-success' : 'text-destructive'}`}>
                    {sig.direction === 'long' ? '▲ BUY' : '▼ SELL'}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[11px] font-mono text-primary font-bold">{sig.score?.toFixed(1)}/10</span>
                  <span className="text-[10px] text-muted-foreground">{sig.status === 'trade_placed' ? '✓ Placed' : sig.status === 'rejected' ? '✗ Rejected' : 'Skip'}</span>
                </div>
                {(sig.summary || sig.trend) && (
                  <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">{sig.summary || sig.trend}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Equity Curve */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Equity Curve</CardTitle>
              <div className="flex gap-1">
                {(["1W", "1M", "3M", "6M", "ALL"] as TimeRange[]).map((range) => (
                  <button key={range} onClick={() => setTimeRange(range)}
                    className={`px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider transition-colors ${
                      timeRange === range ? "bg-primary/20 text-primary border border-primary/40" : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                    }`}>{range}</button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {(!botStatus?.equityCurve || botStatus.equityCurve.length === 0) ? (
              <div className="h-[240px] flex flex-col items-center justify-center text-muted-foreground border border-dashed border-border">
                <TrendingUp className="h-10 w-10 mb-3 opacity-20" />
                <p className="text-sm font-medium">No trade history yet</p>
                <p className="text-xs mt-1 text-muted-foreground/70">Equity curve will appear after your first closed trade</p>
              </div>
            ) : (
              <div className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={equityData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(240, 6%, 20%)" />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fontFamily: "'IBM Plex Mono'", fill: "hsl(220, 8%, 65%)" }} stroke="hsl(220, 8%, 40%)" interval={Math.max(0, Math.floor(equityData.length / 8))} angle={-30} textAnchor="end" height={50} />
                    <YAxis tick={{ fontSize: 10, fontFamily: "'IBM Plex Mono'", fill: "hsl(220, 8%, 65%)" }} stroke="hsl(220, 8%, 40%)" tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`} />
                    <Tooltip contentStyle={{ backgroundColor: "hsl(240, 8%, 9%)", border: "1px solid hsl(240, 6%, 20%)", borderRadius: "0", fontSize: "11px" }} />
                    <ReferenceLine y={10000} stroke="hsl(220, 8%, 40%)" strokeDasharray="3 3" strokeOpacity={0.6} />
                    <Line type="monotone" dataKey="equity" stroke="hsl(185, 80%, 55%)" strokeWidth={2.5} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* Currency Strength */}
          {strengthData.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Currency Strength</CardTitle></CardHeader>
              <CardContent>
                <div className="h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={strengthData} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(240, 6%, 20%)" />
                      <XAxis type="number" tick={{ fontSize: 10, fontFamily: "'IBM Plex Mono'", fill: "hsl(220, 8%, 65%)" }} stroke="hsl(220, 8%, 40%)" />
                      <YAxis dataKey="currency" type="category" tick={{ fontSize: 11, fontFamily: "'IBM Plex Mono'", fontWeight: 600, fill: "hsl(220, 8%, 75%)" }} stroke="hsl(220, 8%, 40%)" width={40} />
                      <Tooltip contentStyle={{ backgroundColor: "hsl(240, 8%, 9%)", border: "1px solid hsl(240, 6%, 20%)", borderRadius: "0", fontSize: "11px" }} />
                      <Bar dataKey="score">
                        {strengthData.map((entry, i) => (
                          <Cell key={i} fill={entry.score >= 0 ? 'hsl(155, 70%, 45%)' : 'hsl(0, 72%, 51%)'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Active Positions */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Active Positions ({positions.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {positions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <Activity className="h-8 w-8 mb-2 opacity-20" />
                  <p className="text-xs font-medium">No open positions</p>
                  <p className="text-[10px] mt-1 text-muted-foreground/70">Positions will appear here when the bot opens trades</p>
                </div>
              ) : (
                <table className="w-full text-[11px] font-mono">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="text-left py-1.5 px-1">Symbol</th>
                      <th className="text-left py-1.5 px-1">Dir</th>
                      <th className="text-right py-1.5 px-1">Entry</th>
                      <th className="text-right py-1.5 px-1">P&L</th>
                      <th className="text-right py-1.5 px-1">Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p: any) => (
                      <tr key={p.id} className="border-b border-border/50 hover:bg-secondary/30">
                        <td className="py-1.5 px-1 font-medium">{p.symbol}</td>
                        <td className={`py-1.5 px-1 ${p.direction === "long" ? "text-success" : "text-destructive"}`}>
                          {p.direction === "long" ? "▲" : "▼"}
                        </td>
                        <td className="py-1.5 px-1 text-right">{p.entryPrice?.toFixed(5)}</td>
                        <td className={`py-1.5 px-1 text-right font-medium ${p.pnl >= 0 ? "text-success" : "text-destructive"}`}>
                          {formatMoney(p.pnl, true)}
                        </td>
                        <td className="py-1.5 px-1 text-right">{p.size?.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Bot Activity Timeline */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Bot Activity</CardTitle></CardHeader>
          <CardContent>
            <div className="flex gap-4 text-xs text-muted-foreground mb-3">
              <span>Scans: <strong className="text-foreground">{botStatus?.scanCount ?? 0}</strong></span>
              <span>Signals: <strong className="text-foreground">{botStatus?.signalCount ?? 0}</strong></span>
              <span>Trades: <strong className="text-foreground">{botStatus?.totalTrades ?? 0}</strong></span>
              <span>Rejected: <strong className="text-warning">{botStatus?.rejectedCount ?? 0}</strong></span>
            </div>
            {activityLog.length > 0 ? (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                {activityLog.map((ev, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs py-1.5 border-b border-border/30">
                    <span className="font-mono text-muted-foreground w-14 shrink-0">{ev.time}</span>
                    <Activity className="h-3 w-3 text-primary shrink-0" />
                    <span className="text-foreground">{ev.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
                <Clock className="h-8 w-8 mb-2 opacity-20" />
                <p className="text-xs font-medium">No activity yet</p>
                <p className="text-[10px] mt-1 text-muted-foreground/70">Start the bot or run a manual scan</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
