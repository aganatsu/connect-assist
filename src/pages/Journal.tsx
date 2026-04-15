import { useState, useMemo } from "react";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatMoney, generateEquityCurve } from "@/lib/marketData";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, CartesianGrid,
} from "recharts";
import {
  BookOpen, TrendingUp, TrendingDown, BarChart3, Target,
  Filter, Calculator, Calendar,
} from "lucide-react";

const DEMO_TRADES = [
  { id: 1, symbol: "EUR/USD", direction: "long", entryTime: "2026-04-14 09:15", exitTime: "2026-04-14 14:30", entryPrice: 1.0815, exitPrice: 1.0862, pnl: 470, rr: 3.2, setup: "BOS + OB", notes: "Clean London session entry" },
  { id: 2, symbol: "GBP/JPY", direction: "short", entryTime: "2026-04-13 13:00", exitTime: "2026-04-13 16:45", entryPrice: 189.85, exitPrice: 189.42, pnl: 280, rr: 2.1, setup: "CHoCH + FVG", notes: "NY session reversal" },
  { id: 3, symbol: "XAU/USD", direction: "long", entryTime: "2026-04-13 08:30", exitTime: "2026-04-13 11:20", entryPrice: 2338.00, exitPrice: 2355.50, pnl: 1750, rr: 4.1, setup: "OB Rejection", notes: "Strong OB bounce on 1H" },
  { id: 4, symbol: "USD/JPY", direction: "short", entryTime: "2026-04-12 14:00", exitTime: "2026-04-12 15:30", entryPrice: 153.42, exitPrice: 153.65, pnl: -230, rr: -1.0, setup: "FVG Fill", notes: "Stopped out — failed reversal" },
  { id: 5, symbol: "GBP/USD", direction: "long", entryTime: "2026-04-12 08:15", exitTime: "2026-04-12 12:00", entryPrice: 1.2680, exitPrice: 1.2735, pnl: 550, rr: 2.8, setup: "BOS + Liquidity Sweep", notes: "London open sweep and go" },
  { id: 6, symbol: "EUR/USD", direction: "short", entryTime: "2026-04-11 13:30", exitTime: "2026-04-11 14:15", entryPrice: 1.0870, exitPrice: 1.0885, pnl: -150, rr: -0.8, setup: "CHoCH", notes: "Weak setup, premature entry" },
  { id: 7, symbol: "AUD/USD", direction: "long", entryTime: "2026-04-11 02:00", exitTime: "2026-04-11 06:30", entryPrice: 0.6425, exitPrice: 0.6468, pnl: 430, rr: 3.5, setup: "OB + BOS", notes: "Asian session trend continuation" },
  { id: 8, symbol: "BTC/USD", direction: "long", entryTime: "2026-04-10 10:00", exitTime: "2026-04-10 18:00", entryPrice: 68450, exitPrice: 69850, pnl: 1400, rr: 2.3, setup: "Liquidity Grab", notes: "Sunday low sweep, strong bounce" },
];

const SYMBOLS = ["all", "EUR/USD", "GBP/USD", "USD/JPY", "GBP/JPY", "AUD/USD", "XAU/USD", "BTC/USD"];

export default function JournalView() {
  const [filterSymbol, setFilterSymbol] = useState("all");
  const [filterDirection, setFilterDirection] = useState<"all" | "long" | "short">("all");

  const filteredTrades = useMemo(() => {
    return DEMO_TRADES.filter(t => {
      if (filterSymbol !== "all" && t.symbol !== filterSymbol) return false;
      if (filterDirection !== "all" && t.direction !== filterDirection) return false;
      return true;
    });
  }, [filterSymbol, filterDirection]);

  const stats = useMemo(() => {
    const wins = filteredTrades.filter(t => t.pnl > 0);
    const losses = filteredTrades.filter(t => t.pnl <= 0);
    const totalPnl = filteredTrades.reduce((s, t) => s + t.pnl, 0);
    const avgRR = filteredTrades.reduce((s, t) => s + t.rr, 0) / (filteredTrades.length || 1);
    const profitFactor = losses.length > 0
      ? wins.reduce((s, t) => s + t.pnl, 0) / Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
      : wins.length > 0 ? Infinity : 0;
    return {
      total: filteredTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: filteredTrades.length > 0 ? (wins.length / filteredTrades.length * 100) : 0,
      totalPnl,
      avgRR,
      profitFactor,
      bestTrade: wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : 0,
      worstTrade: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
    };
  }, [filteredTrades]);

  const equityCurveData = useMemo(() => {
    let cum = 10000;
    return filteredTrades.map(t => {
      cum += t.pnl;
      return { date: t.entryTime.split(' ')[0], equity: cum, pnl: t.pnl };
    }).reverse();
  }, [filteredTrades]);

  const pnlByDay = useMemo(() => {
    const groups: Record<string, number> = {};
    filteredTrades.forEach(t => {
      const day = t.entryTime.split(' ')[0];
      groups[day] = (groups[day] || 0) + t.pnl;
    });
    return Object.entries(groups).map(([date, pnl]) => ({ date, pnl })).reverse();
  }, [filteredTrades]);

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Trade Journal</h1>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <select value={filterSymbol} onChange={e => setFilterSymbol(e.target.value)} className="bg-card border border-border rounded px-2 py-1 text-xs">
              {SYMBOLS.map(s => <option key={s} value={s}>{s === "all" ? "All Symbols" : s}</option>)}
            </select>
            <select value={filterDirection} onChange={e => setFilterDirection(e.target.value as any)} className="bg-card border border-border rounded px-2 py-1 text-xs">
              <option value="all">All Directions</option>
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
          </div>
        </div>

        <Tabs defaultValue="journal">
          <TabsList>
            <TabsTrigger value="journal">Trades</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
            <TabsTrigger value="calculator">Calculator</TabsTrigger>
          </TabsList>

          <TabsContent value="journal" className="space-y-4 mt-4">
            {/* Stats Row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              {[
                { label: "Total", value: stats.total },
                { label: "Wins", value: stats.wins, color: "text-success" },
                { label: "Losses", value: stats.losses, color: "text-destructive" },
                { label: "Win Rate", value: `${stats.winRate.toFixed(1)}%`, color: stats.winRate >= 50 ? "text-success" : "text-destructive" },
                { label: "Net P&L", value: formatMoney(stats.totalPnl, true), color: stats.totalPnl >= 0 ? "text-success" : "text-destructive" },
                { label: "Avg RR", value: stats.avgRR.toFixed(1) },
                { label: "Profit Factor", value: stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2) },
              ].map(s => (
                <Card key={s.label}>
                  <CardContent className="pt-2 pb-1.5">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">{s.label}</p>
                    <p className={`text-sm font-bold ${s.color || ''}`}>{s.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Trade List */}
            <Card>
              <CardContent className="pt-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-2 px-1">Symbol</th>
                        <th className="text-left py-2 px-1">Dir</th>
                        <th className="text-left py-2 px-1">Setup</th>
                        <th className="text-left py-2 px-1">Entry</th>
                        <th className="text-left py-2 px-1">Exit</th>
                        <th className="text-right py-2 px-1">P&L</th>
                        <th className="text-right py-2 px-1">RR</th>
                        <th className="text-left py-2 px-1">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTrades.map(t => (
                        <tr key={t.id} className="border-b border-border/30 hover:bg-secondary/30">
                          <td className="py-2 px-1 font-medium">{t.symbol}</td>
                          <td className={`py-2 px-1 ${t.direction === 'long' ? 'text-success' : 'text-destructive'}`}>
                            {t.direction === 'long' ? '▲' : '▼'}
                          </td>
                          <td className="py-2 px-1">{t.setup}</td>
                          <td className="py-2 px-1 text-muted-foreground">{t.entryTime}</td>
                          <td className="py-2 px-1 text-muted-foreground">{t.exitTime}</td>
                          <td className={`py-2 px-1 text-right font-medium ${t.pnl >= 0 ? 'text-success' : 'text-destructive'}`}>
                            {formatMoney(t.pnl, true)}
                          </td>
                          <td className={`py-2 px-1 text-right ${t.rr >= 0 ? 'text-success' : 'text-destructive'}`}>
                            {t.rr > 0 ? '+' : ''}{t.rr.toFixed(1)}R
                          </td>
                          <td className="py-2 px-1 text-muted-foreground max-w-[200px] truncate">{t.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="performance" className="space-y-4 mt-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">Equity Curve</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-[250px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={equityCurveData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 18%)" />
                        <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" />
                        <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" tickFormatter={v => `$${(v/1000).toFixed(1)}k`} />
                        <Tooltip contentStyle={{ backgroundColor: 'hsl(220, 18%, 10%)', border: '1px solid hsl(220, 16%, 18%)', borderRadius: '8px' }} />
                        <Area type="monotone" dataKey="equity" stroke="hsl(210, 100%, 52%)" fill="hsl(210, 100%, 52%)" fillOpacity={0.1} strokeWidth={2} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">Daily P&L</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-[250px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={pnlByDay}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 18%)" />
                        <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" />
                        <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" />
                        <Tooltip contentStyle={{ backgroundColor: 'hsl(220, 18%, 10%)', border: '1px solid hsl(220, 16%, 18%)', borderRadius: '8px' }} />
                        <Bar dataKey="pnl">
                          {pnlByDay.map((entry, i) => (
                            <Cell key={i} fill={entry.pnl >= 0 ? 'hsl(142, 72%, 45%)' : 'hsl(0, 72%, 51%)'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="calculator" className="mt-4">
            <RiskCalculator />
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}

function RiskCalculator() {
  const [accountBalance, setAccountBalance] = useState(10000);
  const [riskPercent, setRiskPercent] = useState(1);
  const [stopLossPips, setStopLossPips] = useState(25);
  const [pipValue, setPipValue] = useState(10);

  const riskAmount = accountBalance * (riskPercent / 100);
  const positionSize = stopLossPips > 0 ? riskAmount / (stopLossPips * pipValue) : 0;

  return (
    <Card>
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><Calculator className="h-4 w-4" /> Risk Calculator</CardTitle></CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div className="space-y-4">
            {[
              { label: "Account Balance ($)", value: accountBalance, set: setAccountBalance, min: 0 },
              { label: "Risk (%)", value: riskPercent, set: setRiskPercent, min: 0, max: 100, step: 0.1 },
              { label: "Stop Loss (pips)", value: stopLossPips, set: setStopLossPips, min: 1 },
              { label: "Pip Value ($)", value: pipValue, set: setPipValue, min: 0.01, step: 0.01 },
            ].map(f => (
              <div key={f.label}>
                <label className="text-xs text-muted-foreground">{f.label}</label>
                <input
                  type="number"
                  value={f.value}
                  onChange={e => f.set(parseFloat(e.target.value) || 0)}
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  className="w-full mt-1 bg-secondary border border-border rounded px-3 py-2 text-sm"
                />
              </div>
            ))}
          </div>
          <div className="space-y-4 p-4 bg-secondary/30 rounded-lg">
            <h3 className="text-sm font-medium">Results</h3>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Risk Amount</span>
                <span className="font-medium text-destructive">{formatMoney(riskAmount)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Position Size</span>
                <span className="font-bold text-lg">{positionSize.toFixed(2)} lots</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">2R Target</span>
                <span className="font-medium text-success">{formatMoney(riskAmount * 2)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">3R Target</span>
                <span className="font-medium text-success">{formatMoney(riskAmount * 3)}</span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
