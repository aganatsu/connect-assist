import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ComposedChart, Line, CartesianGrid, ReferenceLine, BarChart, Bar, Cell,
} from "recharts";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney, INSTRUMENTS, getCurrentSession, isInKillzone } from "@/lib/marketData";
import { paperApi, tradesApi, marketApi, smcApi } from "@/lib/api";
import { TrendingUp, TrendingDown, Zap, Clock } from "lucide-react";

type TimeRange = "1W" | "1M" | "3M" | "6M" | "ALL";

const WATCHED_PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "GBP/JPY", "EUR/GBP", "NZD/USD", "USD/CHF", "EUR/JPY"];

export default function Dashboard() {
  const [timeRange, setTimeRange] = useState<TimeRange>("3M");

  const { data: botStatus } = useQuery({
    queryKey: ["paper-status"],
    queryFn: () => paperApi.status(),
    refetchInterval: 10000,
  });

  const { data: tradeStats } = useQuery({
    queryKey: ["trade-stats"],
    queryFn: () => tradesApi.stats(),
  });

  const { data: equityCurve } = useQuery({
    queryKey: ["equity-curve"],
    queryFn: () => tradesApi.equityCurve(),
  });

  // Live prices polling
  const { data: liveQuotes } = useQuery({
    queryKey: ["live-quotes"],
    queryFn: async () => {
      const results: Record<string, any> = {};
      // Fetch in parallel batches
      const promises = WATCHED_PAIRS.map(async (pair) => {
        try {
          const q = await marketApi.quote(pair);
          results[pair] = q;
        } catch { results[pair] = null; }
      });
      await Promise.all(promises);
      return results;
    },
    refetchInterval: 10000,
  });

  // Currency strength
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

  const balance = botStatus?.balance ?? 10000;
  const profit = balance - 10000;
  const profitPct = ((profit / 10000) * 100).toFixed(1);
  const dailyPnl = botStatus?.dailyPnl ?? 0;
  const positions = botStatus?.positions ?? [];
  const winRate = tradeStats?.winRate ?? 0;
  const totalTrades = tradeStats?.totalTrades ?? 0;
  const wins = tradeStats?.wins ?? 0;
  const losses = tradeStats?.losses ?? 0;
  const session = getCurrentSession();
  const kz = isInKillzone();

  const equityData = useMemo(() => {
    if (!equityCurve || equityCurve.length === 0) {
      return Array.from({ length: 30 }, (_, i) => ({
        date: `Day ${i + 1}`, equity: 10000 + Math.random() * 500 * (i / 30), drawdown: Math.random() * 3,
      }));
    }
    return equityCurve.map((p: any) => ({
      date: p.date?.split("T")[0] ?? "", equity: 10000 + p.cumulative, drawdown: 0,
    }));
  }, [equityCurve]);

  const strengthData = useMemo(() => {
    if (!currencyStrength) return [];
    return Object.entries(currencyStrength).map(([currency, score]: [string, any]) => ({
      currency, score: typeof score === 'number' ? score : 0,
    })).sort((a, b) => b.score - a.score);
  }, [currencyStrength]);

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">SMC Trading Dashboard</h1>
            <p className="text-muted-foreground text-sm flex items-center gap-2">
              <Clock className="h-3 w-3" /> {session}
              {kz.active && <span className="text-primary font-medium">⚡ {kz.name}</span>}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
              botStatus?.isRunning ? "bg-success/20 text-success" : "bg-muted/20 text-muted-foreground"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${botStatus?.isRunning ? "bg-success animate-pulse" : "bg-muted-foreground"}`} />
              {botStatus?.isRunning ? "Bot Running" : "Bot Stopped"}
            </span>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Balance</p>
              <p className="text-2xl font-bold mt-1">{formatMoney(balance)}</p>
              <p className={`text-xs mt-1 ${profit >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(profit, true)} ({profitPct}%)</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Today P&L</p>
              <p className={`text-2xl font-bold mt-1 ${dailyPnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(dailyPnl, true)}</p>
              <p className="text-xs text-muted-foreground mt-1">{totalTrades} trades</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Open Positions</p>
              <p className="text-2xl font-bold mt-1">{positions.length}</p>
              <p className="text-xs text-muted-foreground mt-1">{formatMoney(positions.reduce((s: number, p: any) => s + Math.abs(p.pnl || 0), 0))} exposure</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Win Rate</p>
              <p className={`text-2xl font-bold mt-1 ${winRate >= 50 ? "text-success" : "text-destructive"}`}>{winRate.toFixed(1)}%</p>
              <p className="text-xs text-muted-foreground mt-1">{wins}W / {losses}L</p>
            </CardContent>
          </Card>
        </div>

        {/* Live Prices Grid */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="h-4 w-4 text-primary" /> Live Prices
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {WATCHED_PAIRS.map(pair => {
                const q = liveQuotes?.[pair];
                const inst = INSTRUMENTS.find(i => i.symbol === pair);
                const decimals = (inst?.pipSize ?? 0.0001) < 0.01 ? 5 : 3;
                return (
                  <div key={pair} className="p-2 rounded bg-secondary/30 border border-border/50">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">{pair}</span>
                      {q?.change != null && (
                        <span className={`text-[10px] flex items-center gap-0.5 ${q.change >= 0 ? 'text-success' : 'text-destructive'}`}>
                          {q.change >= 0 ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                          {q.change >= 0 ? '+' : ''}{q.change?.toFixed(2)}%
                        </span>
                      )}
                    </div>
                    <p className="text-sm font-mono font-bold mt-0.5">
                      {q?.price?.toFixed(decimals) ?? '—'}
                    </p>
                    {q?.spread != null && (
                      <p className="text-[10px] text-muted-foreground">{q.spread.toFixed(1)} spread</p>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Equity Curve */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Equity Curve</CardTitle>
              <div className="flex gap-1">
                {(["1W", "1M", "3M", "6M", "ALL"] as TimeRange[]).map((range) => (
                  <button key={range} onClick={() => setTimeRange(range)}
                    className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded transition-colors ${
                      timeRange === range ? "bg-primary/20 text-primary border border-primary/40" : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                    }`}>{range}</button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={equityData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 18%)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`} />
                  <Tooltip contentStyle={{ backgroundColor: "hsl(220, 18%, 10%)", border: "1px solid hsl(220, 16%, 18%)", borderRadius: "8px" }} />
                  <ReferenceLine y={10000} stroke="hsl(215, 15%, 55%)" strokeDasharray="3 3" strokeOpacity={0.5} />
                  <Line type="monotone" dataKey="equity" stroke="hsl(210, 100%, 52%)" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Currency Strength */}
          {strengthData.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Currency Strength</CardTitle></CardHeader>
              <CardContent>
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={strengthData} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 18%)" />
                      <XAxis type="number" tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" />
                      <YAxis dataKey="currency" type="category" tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" width={35} />
                      <Tooltip contentStyle={{ backgroundColor: "hsl(220, 18%, 10%)", border: "1px solid hsl(220, 16%, 18%)", borderRadius: "8px" }} />
                      <Bar dataKey="score">
                        {strengthData.map((entry, i) => (
                          <Cell key={i} fill={entry.score >= 0 ? 'hsl(142, 72%, 45%)' : 'hsl(0, 72%, 51%)'} />
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
              <CardTitle className="text-base">Active Positions ({positions.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {positions.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No open positions</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-2 px-1">Symbol</th>
                        <th className="text-left py-2 px-1">Dir</th>
                        <th className="text-right py-2 px-1">Entry</th>
                        <th className="text-right py-2 px-1">Current</th>
                        <th className="text-right py-2 px-1">P&L</th>
                        <th className="text-right py-2 px-1">Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map((p: any) => (
                        <tr key={p.id} className="border-b border-border/50 hover:bg-secondary/30">
                          <td className="py-2 px-1 font-medium">{p.symbol}</td>
                          <td className={`py-2 px-1 ${p.direction === "long" ? "text-success" : "text-destructive"}`}>
                            {p.direction === "long" ? "▲ Long" : "▼ Short"}
                          </td>
                          <td className="py-2 px-1 text-right">{p.entryPrice?.toFixed(5)}</td>
                          <td className="py-2 px-1 text-right">{p.currentPrice?.toFixed(5)}</td>
                          <td className={`py-2 px-1 text-right font-medium ${p.pnl >= 0 ? "text-success" : "text-destructive"}`}>
                            {formatMoney(p.pnl, true)}
                          </td>
                          <td className="py-2 px-1 text-right">{p.size?.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Bot Activity */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Bot Activity</CardTitle></CardHeader>
          <CardContent>
            <div className="flex gap-4 text-xs text-muted-foreground">
              <span>Scans: {botStatus?.scanCount ?? 0}</span>
              <span>Signals: {botStatus?.signalCount ?? 0}</span>
              <span>Trades: {botStatus?.totalTrades ?? 0}</span>
              <span>Rejected: {botStatus?.rejectedCount ?? 0}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
