import { useState, useMemo, useCallback } from "react";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/marketData";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, CartesianGrid,
} from "recharts";
import {
  FlaskConical, Play, TrendingUp, TrendingDown,
  BarChart3, Target, AlertTriangle, Trophy, Skull,
  Shield, Clock, Layers,
} from "lucide-react";

const STRATEGIES = [
  "BOS + Order Block",
  "CHoCH + FVG Fill",
  "Liquidity Sweep + OB",
  "Premium/Discount + BOS",
  "FVG Fill + Confluence",
];

const SYMBOLS = ["EUR/USD", "GBP/USD", "USD/JPY", "GBP/JPY", "AUD/USD", "XAU/USD", "BTC/USD"];

// Generate demo backtest results
function generateBacktestResults(strategy: string, symbol: string, months: number) {
  const trades = [];
  let equity = 10000;
  let peak = 10000;
  let maxDD = 0;
  const totalTrades = Math.floor(months * 15 + Math.random() * 20);

  for (let i = 0; i < totalTrades; i++) {
    const isWin = Math.random() > 0.38;
    const rr = isWin ? 1 + Math.random() * 4 : -(0.5 + Math.random() * 0.5);
    const pnl = rr * 100;
    equity += pnl;
    peak = Math.max(peak, equity);
    const dd = ((equity - peak) / peak) * 100;
    maxDD = Math.min(maxDD, dd);

    const date = new Date(Date.now() - (totalTrades - i) * 86400000 * (months * 30 / totalTrades));
    trades.push({
      id: i + 1,
      date: date.toISOString().split('T')[0],
      direction: Math.random() > 0.5 ? 'long' : 'short',
      pnl: parseFloat(pnl.toFixed(2)),
      rr: parseFloat(rr.toFixed(2)),
      equity: parseFloat(equity.toFixed(2)),
      drawdown: parseFloat(dd.toFixed(2)),
      setup: strategy.split(' + ')[0],
    });
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  return {
    trades,
    stats: {
      totalTrades,
      winRate: (wins.length / totalTrades * 100),
      netProfit: equity - 10000,
      netProfitPct: ((equity - 10000) / 10000 * 100),
      profitFactor: losses.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / Math.abs(losses.reduce((s, t) => s + t.pnl, 0)) : Infinity,
      maxDrawdown: maxDD,
      sharpeRatio: 0.8 + Math.random() * 1.5,
      avgRR: trades.reduce((s, t) => s + t.rr, 0) / totalTrades,
      bestTrade: Math.max(...trades.map(t => t.pnl)),
      worstTrade: Math.min(...trades.map(t => t.pnl)),
      avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
      avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
    },
  };
}

export default function Backtest() {
  const [strategy, setStrategy] = useState(STRATEGIES[0]);
  const [symbol, setSymbol] = useState("EUR/USD");
  const [months, setMonths] = useState(6);
  const [riskPercent, setRiskPercent] = useState(1);
  const [hasRun, setHasRun] = useState(false);
  const [results, setResults] = useState<ReturnType<typeof generateBacktestResults> | null>(null);

  const runBacktest = useCallback(() => {
    setResults(generateBacktestResults(strategy, symbol, months));
    setHasRun(true);
  }, [strategy, symbol, months]);

  // Monthly P&L heatmap
  const monthlyPnl = useMemo(() => {
    if (!results) return [];
    const groups: Record<string, number> = {};
    results.trades.forEach(t => {
      const month = t.date.substring(0, 7);
      groups[month] = (groups[month] || 0) + t.pnl;
    });
    return Object.entries(groups).map(([month, pnl]) => ({ month, pnl }));
  }, [results]);

  return (
    <AppShell>
      <div className="space-y-4">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <FlaskConical className="h-6 w-6" /> Backtest Engine
        </h1>

        {/* Config */}
        <Card>
          <CardContent className="pt-4">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Strategy</label>
                <select value={strategy} onChange={e => setStrategy(e.target.value)} className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs">
                  {STRATEGIES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Symbol</label>
                <select value={symbol} onChange={e => setSymbol(e.target.value)} className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs">
                  {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Lookback (months)</label>
                <input type="number" value={months} onChange={e => setMonths(parseInt(e.target.value) || 1)} min={1} max={24} className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Risk %</label>
                <input type="number" value={riskPercent} onChange={e => setRiskPercent(parseFloat(e.target.value) || 0.5)} min={0.1} max={10} step={0.1} className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs" />
              </div>
              <div className="flex items-end">
                <button
                  onClick={runBacktest}
                  className="w-full flex items-center justify-center gap-2 px-4 py-1.5 bg-primary text-primary-foreground rounded text-xs font-medium hover:bg-primary/90 transition-colors"
                >
                  <Play className="h-3 w-3" /> Run Backtest
                </button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Results */}
        {hasRun && results && (
          <div className="space-y-4">
            {/* Key Metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
              {[
                { label: "Total Trades", value: results.stats.totalTrades },
                { label: "Win Rate", value: `${results.stats.winRate.toFixed(1)}%`, color: results.stats.winRate >= 50 ? "text-success" : "text-destructive" },
                { label: "Net Profit", value: formatMoney(results.stats.netProfit, true), color: results.stats.netProfit >= 0 ? "text-success" : "text-destructive" },
                { label: "Profit Factor", value: results.stats.profitFactor === Infinity ? "∞" : results.stats.profitFactor.toFixed(2) },
                { label: "Max Drawdown", value: `${results.stats.maxDrawdown.toFixed(1)}%`, color: "text-destructive" },
                { label: "Sharpe", value: results.stats.sharpeRatio.toFixed(2) },
                { label: "Avg RR", value: results.stats.avgRR.toFixed(2) },
                { label: "Net %", value: `${results.stats.netProfitPct.toFixed(1)}%`, color: results.stats.netProfitPct >= 0 ? "text-success" : "text-destructive" },
              ].map(s => (
                <Card key={s.label}>
                  <CardContent className="pt-2 pb-1.5">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">{s.label}</p>
                    <p className={`text-sm font-bold ${s.color || ''}`}>{s.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Equity Curve */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">Equity Curve</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-[250px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={results.trades}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 18%)" />
                        <XAxis dataKey="date" tick={{ fontSize: 9 }} stroke="hsl(215, 15%, 55%)" />
                        <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" tickFormatter={v => `$${(v/1000).toFixed(1)}k`} />
                        <Tooltip contentStyle={{ backgroundColor: 'hsl(220, 18%, 10%)', border: '1px solid hsl(220, 16%, 18%)', borderRadius: '8px' }} />
                        <Area type="monotone" dataKey="equity" stroke="hsl(210, 100%, 52%)" fill="hsl(210, 100%, 52%)" fillOpacity={0.1} strokeWidth={2} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* Monthly P&L */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">Monthly P&L</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-[250px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={monthlyPnl}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 18%)" />
                        <XAxis dataKey="month" tick={{ fontSize: 9 }} stroke="hsl(215, 15%, 55%)" />
                        <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" />
                        <Tooltip contentStyle={{ backgroundColor: 'hsl(220, 18%, 10%)', border: '1px solid hsl(220, 16%, 18%)', borderRadius: '8px' }} />
                        <Bar dataKey="pnl">
                          {monthlyPnl.map((entry, i) => (
                            <Cell key={i} fill={entry.pnl >= 0 ? 'hsl(142, 72%, 45%)' : 'hsl(0, 72%, 51%)'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Best/Worst + Trade Table */}
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
              <Card>
                <CardContent className="pt-4 text-center">
                  <Trophy className="h-6 w-6 text-success mx-auto mb-1" />
                  <p className="text-xs text-muted-foreground">Best Trade</p>
                  <p className="text-lg font-bold text-success">{formatMoney(results.stats.bestTrade, true)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 text-center">
                  <Skull className="h-6 w-6 text-destructive mx-auto mb-1" />
                  <p className="text-xs text-muted-foreground">Worst Trade</p>
                  <p className="text-lg font-bold text-destructive">{formatMoney(results.stats.worstTrade, true)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 text-center">
                  <TrendingUp className="h-6 w-6 text-success mx-auto mb-1" />
                  <p className="text-xs text-muted-foreground">Avg Win</p>
                  <p className="text-lg font-bold text-success">{formatMoney(results.stats.avgWin, true)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 text-center">
                  <TrendingDown className="h-6 w-6 text-destructive mx-auto mb-1" />
                  <p className="text-xs text-muted-foreground">Avg Loss</p>
                  <p className="text-lg font-bold text-destructive">{formatMoney(results.stats.avgLoss, true)}</p>
                </CardContent>
              </Card>
            </div>

            {/* Trade Table (last 20) */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Recent Trades (last 20)</CardTitle></CardHeader>
              <CardContent>
                <div className="overflow-x-auto max-h-64 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card">
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-2 px-1">#</th>
                        <th className="text-left py-2 px-1">Date</th>
                        <th className="text-left py-2 px-1">Dir</th>
                        <th className="text-left py-2 px-1">Setup</th>
                        <th className="text-right py-2 px-1">P&L</th>
                        <th className="text-right py-2 px-1">RR</th>
                        <th className="text-right py-2 px-1">Equity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.trades.slice(-20).reverse().map(t => (
                        <tr key={t.id} className="border-b border-border/30 hover:bg-secondary/30">
                          <td className="py-1.5 px-1 text-muted-foreground">{t.id}</td>
                          <td className="py-1.5 px-1">{t.date}</td>
                          <td className={`py-1.5 px-1 ${t.direction === 'long' ? 'text-success' : 'text-destructive'}`}>
                            {t.direction === 'long' ? '▲' : '▼'}
                          </td>
                          <td className="py-1.5 px-1">{t.setup}</td>
                          <td className={`py-1.5 px-1 text-right font-medium ${t.pnl >= 0 ? 'text-success' : 'text-destructive'}`}>
                            {formatMoney(t.pnl, true)}
                          </td>
                          <td className={`py-1.5 px-1 text-right ${t.rr >= 0 ? 'text-success' : 'text-destructive'}`}>
                            {t.rr > 0 ? '+' : ''}{t.rr.toFixed(1)}R
                          </td>
                          <td className="py-1.5 px-1 text-right">{formatMoney(t.equity)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {!hasRun && (
          <Card>
            <CardContent className="py-16 text-center">
              <FlaskConical className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">Configure parameters above and click <strong>Run Backtest</strong> to see results.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
