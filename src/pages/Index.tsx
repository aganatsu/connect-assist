import { useMemo, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, ComposedChart, Line, Bar, CartesianGrid, ReferenceLine,
} from "recharts";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { generateEquityCurve, formatMoney } from "@/lib/marketData";

type TimeRange = "1W" | "1M" | "3M" | "6M" | "ALL";

// Demo data
const DEMO_POSITIONS = [
  { symbol: "EUR/USD", direction: "long", entryPrice: 1.0842, currentPrice: 1.0867, pnl: 250, size: 1.0, stopLoss: 1.0800, takeProfit: 1.0920 },
  { symbol: "GBP/USD", direction: "short", entryPrice: 1.2715, currentPrice: 1.2698, pnl: 170, size: 0.5, stopLoss: 1.2780, takeProfit: 1.2620 },
  { symbol: "XAU/USD", direction: "long", entryPrice: 2345.50, currentPrice: 2362.80, pnl: 1730, size: 0.1, stopLoss: 2320.00, takeProfit: 2400.00 },
];

const CURRENCY_EXPOSURE = [
  { name: "USD", value: 42, color: "hsl(38, 92%, 50%)" },
  { name: "EUR", value: 28, color: "hsl(210, 100%, 52%)" },
  { name: "GBP", value: 18, color: "hsl(270, 60%, 65%)" },
  { name: "JPY", value: 12, color: "hsl(215, 15%, 55%)" },
];

export default function Dashboard() {
  const [timeRange, setTimeRange] = useState<TimeRange>("3M");
  const equityData = useMemo(() => generateEquityCurve(90), []);

  const balance = 12450.75;
  const profit = balance - 10000;
  const profitPct = ((profit / 10000) * 100).toFixed(1);
  const dailyPnl = 185.30;
  const winRate = 62.5;
  const totalTrades = 48;
  const wins = 30;
  const losses = 18;

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">SMC Trading Dashboard</h1>
            <p className="text-muted-foreground text-sm">Real-time portfolio overview</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-success/20 text-success">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              Bot Running
            </span>
            <span className="text-sm text-muted-foreground">
              {new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })}
            </span>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Balance</p>
              <p className="text-2xl font-bold mt-1">{formatMoney(balance)}</p>
              <p className={`text-xs mt-1 ${profit >= 0 ? 'text-success' : 'text-destructive'}`}>
                {formatMoney(profit, true)} ({profitPct}%) {profit >= 0 ? '↗' : '↘'}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Today P&L</p>
              <p className={`text-2xl font-bold mt-1 ${dailyPnl >= 0 ? 'text-success' : 'text-destructive'}`}>
                {formatMoney(dailyPnl, true)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{totalTrades} trades</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Open Positions</p>
              <p className="text-2xl font-bold mt-1">{DEMO_POSITIONS.length}</p>
              <p className="text-xs text-muted-foreground mt-1">{formatMoney(2150)} exposure</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Win Rate</p>
              <p className={`text-2xl font-bold mt-1 ${winRate >= 50 ? 'text-success' : 'text-destructive'}`}>
                {winRate.toFixed(1)}%
              </p>
              <p className="text-xs text-muted-foreground mt-1">{wins}W / {losses}L</p>
            </CardContent>
          </Card>
        </div>

        {/* Equity Curve */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Equity Curve</CardTitle>
              <div className="flex gap-1">
                {(["1W", "1M", "3M", "6M", "ALL"] as TimeRange[]).map((range) => (
                  <button
                    key={range}
                    onClick={() => setTimeRange(range)}
                    className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded transition-colors ${
                      timeRange === range
                        ? "bg-primary/20 text-primary border border-primary/40"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                    }`}
                  >
                    {range}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={equityData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 18%)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" />
                  <YAxis yAxisId="equity" tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`} />
                  <YAxis yAxisId="dd" orientation="right" tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" tickFormatter={(v) => `${v.toFixed(0)}%`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(220, 18%, 10%)', border: '1px solid hsl(220, 16%, 18%)', borderRadius: '8px' }}
                    labelStyle={{ color: 'hsl(210, 20%, 90%)' }}
                  />
                  <ReferenceLine yAxisId="equity" y={10000} stroke="hsl(215, 15%, 55%)" strokeDasharray="3 3" strokeOpacity={0.5} />
                  <Area yAxisId="dd" type="monotone" dataKey="drawdown" fill="hsl(0, 72%, 51%)" fillOpacity={0.1} stroke="hsl(0, 72%, 51%)" strokeWidth={1} />
                  <Line yAxisId="equity" type="monotone" dataKey="equity" stroke="hsl(210, 100%, 52%)" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Positions + Portfolio Heat */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* Active Positions */}
          <Card className="lg:col-span-3">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Active Positions</CardTitle>
            </CardHeader>
            <CardContent>
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
                      <th className="text-right py-2 px-1">SL</th>
                      <th className="text-right py-2 px-1">TP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DEMO_POSITIONS.map((p) => {
                      const decimals = p.symbol.includes("JPY") || p.symbol.includes("XAU") ? 2 : 4;
                      return (
                        <tr key={p.symbol} className="border-b border-border/50 hover:bg-secondary/30">
                          <td className="py-2 px-1 font-medium">{p.symbol}</td>
                          <td className={`py-2 px-1 ${p.direction === 'long' ? 'text-success' : 'text-destructive'}`}>
                            {p.direction === 'long' ? '▲ Long' : '▼ Short'}
                          </td>
                          <td className="py-2 px-1 text-right">{p.entryPrice.toFixed(decimals)}</td>
                          <td className="py-2 px-1 text-right">{p.currentPrice.toFixed(decimals)}</td>
                          <td className={`py-2 px-1 text-right font-medium ${p.pnl >= 0 ? 'text-success' : 'text-destructive'}`}>
                            {formatMoney(p.pnl, true)}
                          </td>
                          <td className="py-2 px-1 text-right">{p.size.toFixed(2)}</td>
                          <td className="py-2 px-1 text-right text-muted-foreground">{p.stopLoss.toFixed(decimals)}</td>
                          <td className="py-2 px-1 text-right text-muted-foreground">{p.takeProfit.toFixed(decimals)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Portfolio Heat */}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Portfolio Heat</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-4">
              <div className="w-32 h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={CURRENCY_EXPOSURE} cx="50%" cy="50%" innerRadius={30} outerRadius={50} dataKey="value" strokeWidth={0}>
                      {CURRENCY_EXPOSURE.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-2">
                {CURRENCY_EXPOSURE.map((entry) => (
                  <div key={entry.name} className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                    <span className="text-muted-foreground">{entry.name}</span>
                    <span className="font-medium">{entry.value}%</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Bot Activity */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Bot Activity</CardTitle>
              <span className="text-xs text-muted-foreground">Last 24 hours</span>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex gap-0.5 flex-wrap">
              {Array.from({ length: 48 }, (_, i) => {
                const type = i % 12 === 0 ? 'trade' : i % 5 === 0 ? 'signal' : i % 8 === 0 ? 'reject' : 'scan';
                const colors = {
                  trade: 'bg-success',
                  signal: 'bg-primary',
                  reject: 'bg-destructive',
                  scan: 'bg-muted-foreground/30',
                };
                return (
                  <div key={i} className={`w-2 h-6 rounded-sm ${colors[type]}`} title={`${type} at ${Math.floor(i / 2)}:${i % 2 === 0 ? '00' : '30'}`} />
                );
              })}
            </div>
            <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
              <span>Scans: 124</span>
              <span>Signals: 8</span>
              <span>Trades: 4</span>
              <span>Rejected: 3</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
