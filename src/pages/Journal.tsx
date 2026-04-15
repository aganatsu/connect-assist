import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatMoney } from "@/lib/marketData";
import { tradesApi } from "@/lib/api";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, CartesianGrid,
} from "recharts";
import { Filter, Calculator } from "lucide-react";

const SYMBOLS = ["all", "EUR/USD", "GBP/USD", "USD/JPY", "GBP/JPY", "AUD/USD", "XAU/USD", "BTC/USD"];

export default function JournalView() {
  const [filterSymbol, setFilterSymbol] = useState("all");
  const [filterDirection, setFilterDirection] = useState<"all" | "long" | "short">("all");

  const { data: trades = [], isLoading } = useQuery({
    queryKey: ["trades"],
    queryFn: () => tradesApi.list(100),
  });

  const { data: stats } = useQuery({
    queryKey: ["trade-stats"],
    queryFn: () => tradesApi.stats(),
  });

  const filteredTrades = useMemo(() => {
    return (trades as any[]).filter((t: any) => {
      if (filterSymbol !== "all" && t.symbol !== filterSymbol) return false;
      if (filterDirection !== "all" && t.direction !== filterDirection) return false;
      return true;
    });
  }, [trades, filterSymbol, filterDirection]);

  const computedStats = useMemo(() => {
    const wins = filteredTrades.filter((t: any) => parseFloat(t.pnl_amount || "0") > 0);
    const losses = filteredTrades.filter((t: any) => parseFloat(t.pnl_amount || "0") <= 0);
    const totalPnl = filteredTrades.reduce((s: number, t: any) => s + parseFloat(t.pnl_amount || "0"), 0);
    const grossProfit = wins.reduce((s: number, t: any) => s + parseFloat(t.pnl_amount || "0"), 0);
    const grossLoss = Math.abs(losses.reduce((s: number, t: any) => s + parseFloat(t.pnl_amount || "0"), 0));
    return {
      total: filteredTrades.length, wins: wins.length, losses: losses.length,
      winRate: filteredTrades.length > 0 ? (wins.length / filteredTrades.length * 100) : 0,
      totalPnl, profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    };
  }, [filteredTrades]);

  const equityCurveData = useMemo(() => {
    let cum = 10000;
    return filteredTrades.filter((t: any) => t.status === "closed").map((t: any) => {
      cum += parseFloat(t.pnl_amount || "0");
      return { date: t.entry_time?.split("T")[0] ?? "", equity: cum };
    }).reverse();
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
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
              {[
                { label: "Total", value: computedStats.total },
                { label: "Wins", value: computedStats.wins, color: "text-success" },
                { label: "Losses", value: computedStats.losses, color: "text-destructive" },
                { label: "Win Rate", value: `${computedStats.winRate.toFixed(1)}%`, color: computedStats.winRate >= 50 ? "text-success" : "text-destructive" },
                { label: "Net P&L", value: formatMoney(computedStats.totalPnl, true), color: computedStats.totalPnl >= 0 ? "text-success" : "text-destructive" },
                { label: "PF", value: computedStats.profitFactor >= 999 ? "∞" : computedStats.profitFactor.toFixed(2) },
              ].map(s => (
                <Card key={s.label}>
                  <CardContent className="pt-2 pb-1.5">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">{s.label}</p>
                    <p className={`text-sm font-bold ${s.color || ""}`}>{s.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card>
              <CardContent className="pt-4">
                {isLoading ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">Loading trades...</p>
                ) : filteredTrades.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No trades yet. Start trading to see your journal.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground">
                          <th className="text-left py-2 px-1">Symbol</th>
                          <th className="text-left py-2 px-1">Dir</th>
                          <th className="text-left py-2 px-1">Setup</th>
                          <th className="text-left py-2 px-1">Entry</th>
                          <th className="text-right py-2 px-1">P&L</th>
                          <th className="text-left py-2 px-1">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredTrades.map((t: any) => (
                          <tr key={t.id} className="border-b border-border/30 hover:bg-secondary/30">
                            <td className="py-2 px-1 font-medium">{t.symbol}</td>
                            <td className={`py-2 px-1 ${t.direction === "long" ? "text-success" : "text-destructive"}`}>
                              {t.direction === "long" ? "▲" : "▼"}
                            </td>
                            <td className="py-2 px-1">{t.setup_type || "-"}</td>
                            <td className="py-2 px-1 text-muted-foreground">{t.entry_time?.split("T")[0]}</td>
                            <td className={`py-2 px-1 text-right font-medium ${parseFloat(t.pnl_amount || "0") >= 0 ? "text-success" : "text-destructive"}`}>
                              {formatMoney(parseFloat(t.pnl_amount || "0"), true)}
                            </td>
                            <td className="py-2 px-1 text-muted-foreground max-w-[200px] truncate">{t.notes || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="performance" className="mt-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Equity Curve</CardTitle></CardHeader>
              <CardContent>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={equityCurveData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 16%, 18%)" />
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" />
                      <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 15%, 55%)" tickFormatter={v => `$${(v / 1000).toFixed(1)}k`} />
                      <Tooltip contentStyle={{ backgroundColor: "hsl(220, 18%, 10%)", border: "1px solid hsl(220, 16%, 18%)", borderRadius: "8px" }} />
                      <Area type="monotone" dataKey="equity" stroke="hsl(210, 100%, 52%)" fill="hsl(210, 100%, 52%)" fillOpacity={0.1} strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
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
              { label: "Account Balance ($)", value: accountBalance, set: setAccountBalance },
              { label: "Risk (%)", value: riskPercent, set: setRiskPercent },
              { label: "Stop Loss (pips)", value: stopLossPips, set: setStopLossPips },
              { label: "Pip Value ($)", value: pipValue, set: setPipValue },
            ].map(f => (
              <div key={f.label}>
                <label className="text-xs text-muted-foreground">{f.label}</label>
                <input type="number" value={f.value} onChange={e => f.set(parseFloat(e.target.value) || 0)}
                  className="w-full mt-1 bg-secondary border border-border rounded px-3 py-2 text-sm" />
              </div>
            ))}
          </div>
          <div className="space-y-4 p-4 bg-secondary/30 rounded-lg">
            <h3 className="text-sm font-medium">Results</h3>
            <div className="space-y-3">
              <div className="flex justify-between text-sm"><span className="text-muted-foreground">Risk Amount</span><span className="font-medium text-destructive">{formatMoney(riskAmount)}</span></div>
              <div className="flex justify-between text-sm"><span className="text-muted-foreground">Position Size</span><span className="font-bold text-lg">{positionSize.toFixed(2)} lots</span></div>
              <div className="flex justify-between text-sm"><span className="text-muted-foreground">2R Target</span><span className="font-medium text-success">{formatMoney(riskAmount * 2)}</span></div>
              <div className="flex justify-between text-sm"><span className="text-muted-foreground">3R Target</span><span className="font-medium text-success">{formatMoney(riskAmount * 3)}</span></div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
