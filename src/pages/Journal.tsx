import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatMoney, INSTRUMENTS } from "@/lib/marketData";
import { tradesApi } from "@/lib/api";
import { toast } from "sonner";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, CartesianGrid,
} from "recharts";
import { Filter, Calculator, Plus } from "lucide-react";

const ALL_SYMBOLS = ["all", ...INSTRUMENTS.map(i => i.symbol)];
const SETUP_TYPES = ["BOS + Order Block", "CHoCH + FVG Fill", "Liquidity Sweep + OB", "Premium/Discount + BOS", "FVG Fill + Confluence", "Manual"];

export default function JournalView() {
  const queryClient = useQueryClient();
  const [filterSymbol, setFilterSymbol] = useState("all");
  const [filterDirection, setFilterDirection] = useState<"all" | "long" | "short">("all");
  const [addOpen, setAddOpen] = useState(false);

  // Manual trade form state
  const [formSymbol, setFormSymbol] = useState("EUR/USD");
  const [formDirection, setFormDirection] = useState<"long" | "short">("long");
  const [formEntry, setFormEntry] = useState("");
  const [formExit, setFormExit] = useState("");
  const [formSetup, setFormSetup] = useState(SETUP_TYPES[0]);
  const [formTimeframe, setFormTimeframe] = useState("1h");
  const [formNotes, setFormNotes] = useState("");
  const [formRisk, setFormRisk] = useState("");
  const [formRR, setFormRR] = useState("");
  const [formPnl, setFormPnl] = useState("");

  const { data: trades = [], isLoading } = useQuery({
    queryKey: ["trades"],
    queryFn: () => tradesApi.list(100),
  });

  const { data: stats } = useQuery({
    queryKey: ["trade-stats"],
    queryFn: () => tradesApi.stats(),
  });

  const createMutation = useMutation({
    mutationFn: (trade: any) => tradesApi.create(trade),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trades"] });
      queryClient.invalidateQueries({ queryKey: ["trade-stats"] });
      toast.success("Trade added");
      setAddOpen(false);
      resetForm();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const resetForm = () => {
    setFormEntry(""); setFormExit(""); setFormNotes(""); setFormRisk(""); setFormRR(""); setFormPnl("");
  };

  const handleAddTrade = () => {
    createMutation.mutate({
      symbol: formSymbol,
      direction: formDirection,
      entry_price: formEntry,
      entry_time: new Date().toISOString(),
      exit_price: formExit || null,
      exit_time: formExit ? new Date().toISOString() : null,
      status: formExit ? "closed" : "open",
      setup_type: formSetup,
      timeframe: formTimeframe,
      notes: formNotes,
      risk_percent: formRisk || null,
      risk_reward: formRR || null,
      pnl_amount: formPnl || null,
    });
  };

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

  // Performance by pair
  const pairStats = useMemo(() => {
    const map: Record<string, { wins: number; losses: number; pnl: number }> = {};
    filteredTrades.forEach((t: any) => {
      if (!map[t.symbol]) map[t.symbol] = { wins: 0, losses: 0, pnl: 0 };
      const pnl = parseFloat(t.pnl_amount || "0");
      map[t.symbol].pnl += pnl;
      if (pnl > 0) map[t.symbol].wins++;
      else map[t.symbol].losses++;
    });
    return Object.entries(map).map(([pair, s]) => ({
      pair, ...s, total: s.wins + s.losses,
      winRate: s.wins + s.losses > 0 ? (s.wins / (s.wins + s.losses) * 100) : 0,
    })).sort((a, b) => b.pnl - a.pnl);
  }, [filteredTrades]);

  // Performance by setup
  const setupStats = useMemo(() => {
    const map: Record<string, { wins: number; losses: number; pnl: number }> = {};
    filteredTrades.forEach((t: any) => {
      const setup = t.setup_type || "Unknown";
      if (!map[setup]) map[setup] = { wins: 0, losses: 0, pnl: 0 };
      const pnl = parseFloat(t.pnl_amount || "0");
      map[setup].pnl += pnl;
      if (pnl > 0) map[setup].wins++;
      else map[setup].losses++;
    });
    return Object.entries(map).map(([setup, s]) => ({
      setup, ...s, total: s.wins + s.losses,
      winRate: s.wins + s.losses > 0 ? (s.wins / (s.wins + s.losses) * 100) : 0,
    })).sort((a, b) => b.pnl - a.pnl);
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
            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogTrigger asChild>
                <Button size="sm"><Plus className="h-3 w-3 mr-1" /> Add Trade</Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader><DialogTitle>Add Manual Trade</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Symbol</Label>
                      <select value={formSymbol} onChange={e => setFormSymbol(e.target.value)} className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs">
                        {INSTRUMENTS.map(i => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs">Direction</Label>
                      <select value={formDirection} onChange={e => setFormDirection(e.target.value as any)} className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs">
                        <option value="long">Long</option>
                        <option value="short">Short</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><Label className="text-xs">Entry Price</Label><Input value={formEntry} onChange={e => setFormEntry(e.target.value)} className="mt-1" placeholder="1.08500" /></div>
                    <div><Label className="text-xs">Exit Price (optional)</Label><Input value={formExit} onChange={e => setFormExit(e.target.value)} className="mt-1" placeholder="1.09200" /></div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Setup Type</Label>
                      <select value={formSetup} onChange={e => setFormSetup(e.target.value)} className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs">
                        {SETUP_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs">Timeframe</Label>
                      <select value={formTimeframe} onChange={e => setFormTimeframe(e.target.value)} className="w-full mt-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs">
                        {["5min", "15min", "1h", "4h", "1day"].map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div><Label className="text-xs">Risk %</Label><Input value={formRisk} onChange={e => setFormRisk(e.target.value)} className="mt-1" placeholder="1.0" /></div>
                    <div><Label className="text-xs">R:R</Label><Input value={formRR} onChange={e => setFormRR(e.target.value)} className="mt-1" placeholder="3.0" /></div>
                    <div><Label className="text-xs">P&L ($)</Label><Input value={formPnl} onChange={e => setFormPnl(e.target.value)} className="mt-1" placeholder="150" /></div>
                  </div>
                  <div><Label className="text-xs">Notes</Label><Textarea value={formNotes} onChange={e => setFormNotes(e.target.value)} className="mt-1" rows={3} placeholder="Trade reasoning, observations..." /></div>
                  <Button onClick={handleAddTrade} disabled={!formEntry} className="w-full">Save Trade</Button>
                </div>
              </DialogContent>
            </Dialog>
            <Filter className="h-4 w-4 text-muted-foreground" />
            <select value={filterSymbol} onChange={e => setFilterSymbol(e.target.value)} className="bg-card border border-border rounded px-2 py-1 text-xs">
              {ALL_SYMBOLS.map(s => <option key={s} value={s}>{s === "all" ? "All Symbols" : s}</option>)}
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
            <TabsTrigger value="by-pair">By Pair</TabsTrigger>
            <TabsTrigger value="by-setup">By Setup</TabsTrigger>
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
                <Card key={s.label}><CardContent className="pt-2 pb-1.5"><p className="text-[9px] text-muted-foreground uppercase tracking-wider">{s.label}</p><p className={`text-sm font-bold ${s.color || ""}`}>{s.value}</p></CardContent></Card>
              ))}
            </div>

            <Card>
              <CardContent className="pt-4">
                {isLoading ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">Loading trades...</p>
                ) : filteredTrades.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No trades yet. Click "Add Trade" to log a trade manually.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground">
                          <th className="text-left py-2 px-1">Symbol</th>
                          <th className="text-left py-2 px-1">Dir</th>
                          <th className="text-left py-2 px-1">Setup</th>
                          <th className="text-left py-2 px-1">TF</th>
                          <th className="text-left py-2 px-1">Entry</th>
                          <th className="text-right py-2 px-1">R:R</th>
                          <th className="text-right py-2 px-1">P&L</th>
                          <th className="text-left py-2 px-1">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredTrades.map((t: any) => (
                          <tr key={t.id} className="border-b border-border/30 hover:bg-secondary/30">
                            <td className="py-2 px-1 font-medium">{t.symbol}</td>
                            <td className={`py-2 px-1 ${t.direction === "long" ? "text-success" : "text-destructive"}`}>{t.direction === "long" ? "▲" : "▼"}</td>
                            <td className="py-2 px-1">{t.setup_type || "-"}</td>
                            <td className="py-2 px-1 text-muted-foreground">{t.timeframe || "-"}</td>
                            <td className="py-2 px-1 text-muted-foreground">{t.entry_time?.split("T")[0]}</td>
                            <td className="py-2 px-1 text-right">{t.risk_reward || "-"}</td>
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

          <TabsContent value="by-pair" className="mt-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Performance by Pair</CardTitle></CardHeader>
              <CardContent>
                {pairStats.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No data</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-2">Pair</th>
                        <th className="text-right py-2">Trades</th>
                        <th className="text-right py-2">W/L</th>
                        <th className="text-right py-2">Win Rate</th>
                        <th className="text-right py-2">Net P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pairStats.map(p => (
                        <tr key={p.pair} className="border-b border-border/30">
                          <td className="py-2 font-medium">{p.pair}</td>
                          <td className="py-2 text-right">{p.total}</td>
                          <td className="py-2 text-right">{p.wins}W / {p.losses}L</td>
                          <td className={`py-2 text-right ${p.winRate >= 50 ? 'text-success' : 'text-destructive'}`}>{p.winRate.toFixed(1)}%</td>
                          <td className={`py-2 text-right font-medium ${p.pnl >= 0 ? 'text-success' : 'text-destructive'}`}>{formatMoney(p.pnl, true)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="by-setup" className="mt-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Performance by Setup Type</CardTitle></CardHeader>
              <CardContent>
                {setupStats.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No data</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-2">Setup</th>
                        <th className="text-right py-2">Trades</th>
                        <th className="text-right py-2">W/L</th>
                        <th className="text-right py-2">Win Rate</th>
                        <th className="text-right py-2">Net P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {setupStats.map(s => (
                        <tr key={s.setup} className="border-b border-border/30">
                          <td className="py-2 font-medium">{s.setup}</td>
                          <td className="py-2 text-right">{s.total}</td>
                          <td className="py-2 text-right">{s.wins}W / {s.losses}L</td>
                          <td className={`py-2 text-right ${s.winRate >= 50 ? 'text-success' : 'text-destructive'}`}>{s.winRate.toFixed(1)}%</td>
                          <td className={`py-2 text-right font-medium ${s.pnl >= 0 ? 'text-success' : 'text-destructive'}`}>{formatMoney(s.pnl, true)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
