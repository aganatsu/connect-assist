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
import { SignalReasoningCard } from "@/components/SignalReasoningCard";
import { toast } from "sonner";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, CartesianGrid,
} from "recharts";
import { Filter, Calculator, Plus, X, BookOpen, Download, Import } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { getChartTheme } from "@/lib/chartTheme";

const ALL_SYMBOLS = ["all", ...INSTRUMENTS.map(i => i.symbol)];
const SETUP_TYPES = ["BOS + Order Block", "CHoCH + FVG Fill", "Liquidity Sweep + OB", "Premium/Discount + BOS", "FVG Fill + Confluence", "Manual"];

export default function JournalView() {
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const ct = getChartTheme(resolvedTheme);
  const [filterSymbol, setFilterSymbol] = useState("all");
  const [filterDirection, setFilterDirection] = useState<"all" | "long" | "short">("all");
  const [addOpen, setAddOpen] = useState(false);
  const [selectedTrade, setSelectedTrade] = useState<any>(null);

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
  const [journalPage, setJournalPage] = useState(0);
  const journalPageSize = 50;

  const { data: tradesResponse, isLoading } = useQuery({
    queryKey: ["trades", journalPage],
    queryFn: () => tradesApi.list(journalPageSize, journalPage * journalPageSize),
  });
  // Support both old (array) and new (paginated object) response shapes
  const trades: any[] = Array.isArray(tradesResponse) ? tradesResponse : (tradesResponse?.data ?? []);
  const tradesTotalCount: number = Array.isArray(tradesResponse) ? tradesResponse.length : (tradesResponse?.total ?? trades.length);
  const journalTotalPages = Math.max(1, Math.ceil(tradesTotalCount / journalPageSize));

  const createMutation = useMutation({
    mutationFn: (trade: any) => tradesApi.create(trade),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["trades"] }); toast.success("Trade added"); setAddOpen(false); setFormEntry(""); setFormExit(""); setFormNotes(""); setFormRisk(""); setFormRR(""); setFormPnl(""); },
    onError: (e: any) => toast.error(e.message),
  });

  const importMutation = useMutation({
    mutationFn: () => tradesApi.importFromPaper(),
    onSuccess: (data: any) => { queryClient.invalidateQueries({ queryKey: ["trades"] }); toast.success(`Imported ${data?.imported ?? 0} bot trades`); },
    onError: (e: any) => toast.error(e.message),
  });

  const handleAddTrade = () => {
    createMutation.mutate({
      symbol: formSymbol, direction: formDirection, entry_price: formEntry, entry_time: new Date().toISOString(),
      exit_price: formExit || null, exit_time: formExit ? new Date().toISOString() : null, status: formExit ? "closed" : "open",
      setup_type: formSetup, timeframe: formTimeframe, notes: formNotes,
      risk_percent: formRisk || null, risk_reward: formRR || null, pnl_amount: formPnl || null,
    });
  };

  const handleExportCSV = () => {
    const headers = ["Date", "Symbol", "Direction", "Setup", "Entry", "Exit", "P&L", "R:R", "Risk%", "Notes"];
    const rows = filteredTrades.map((t: any) => [
      t.entry_time?.split("T")[0] ?? "", t.symbol, t.direction, t.setup_type || "",
      t.entry_price, t.exit_price || "", t.pnl_amount || "", t.risk_reward || "",
      t.risk_percent || "", (t.notes || "").replace(/"/g, '""'),
    ]);
    const csv = [headers.join(","), ...rows.map(r => r.map((v: string) => `"${v}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `trades_${new Date().toISOString().split("T")[0]}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV downloaded");
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

  const equityCurveData = useMemo(() => {
    let cum = 10000;
    return filteredTrades.filter((t: any) => t.status === "closed").map((t: any) => {
      cum += parseFloat(t.pnl_amount || "0");
      return { date: t.entry_time?.split("T")[0] ?? "", equity: cum };
    }).reverse();
  }, [filteredTrades]);

  const dailyPnlData = useMemo(() => {
    const map: Record<string, number> = {};
    filteredTrades.filter((t: any) => t.status === "closed").forEach((t: any) => {
      const date = t.entry_time?.split("T")[0] ?? "";
      map[date] = (map[date] || 0) + parseFloat(t.pnl_amount || "0");
    });
    return Object.entries(map).map(([date, pnl]) => ({ date, pnl })).sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredTrades]);

  return (
    <AppShell>
      <div className="flex flex-col md:flex-row h-[calc(100vh-3.5rem)] md:h-[calc(100vh-4.5rem)]">
        {/* Main content */}
        <div className={`${selectedTrade ? 'flex-[2]' : 'flex-1'} flex flex-col min-h-0 space-y-3 overflow-y-auto pr-2`}>
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold">Trade Journal</h1>
            <div className="flex items-center gap-2">
              <Dialog open={addOpen} onOpenChange={setAddOpen}>
                <DialogTrigger asChild><Button size="sm" className="h-7 text-[11px]"><Plus className="h-3 w-3 mr-1" /> Add Trade</Button></DialogTrigger>
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => importMutation.mutate()} disabled={importMutation.isPending}>
                <Import className="h-3 w-3 mr-1" /> {importMutation.isPending ? "Importing…" : "Import Bot Trades"}
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={handleExportCSV} disabled={filteredTrades.length === 0}>
                <Download className="h-3 w-3 mr-1" /> CSV
              </Button>
                <DialogContent className="max-w-md">
                  <DialogHeader><DialogTitle>Add Manual Trade</DialogTitle></DialogHeader>
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div><Label className="text-[10px]">Symbol</Label>
                        <select value={formSymbol} onChange={e => setFormSymbol(e.target.value)} className="w-full mt-1 bg-secondary border border-border px-2 py-1.5 text-xs">{INSTRUMENTS.map(i => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}</select></div>
                      <div><Label className="text-[10px]">Direction</Label>
                        <select value={formDirection} onChange={e => setFormDirection(e.target.value as any)} className="w-full mt-1 bg-secondary border border-border px-2 py-1.5 text-xs"><option value="long">Long</option><option value="short">Short</option></select></div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div><Label className="text-[10px]">Entry Price</Label><Input value={formEntry} onChange={e => setFormEntry(e.target.value)} className="mt-1 h-7 text-xs" placeholder="1.08500" /></div>
                      <div><Label className="text-[10px]">Exit Price</Label><Input value={formExit} onChange={e => setFormExit(e.target.value)} className="mt-1 h-7 text-xs" placeholder="1.09200" /></div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div><Label className="text-[10px]">Setup</Label>
                        <select value={formSetup} onChange={e => setFormSetup(e.target.value)} className="w-full mt-1 bg-secondary border border-border px-2 py-1.5 text-xs">{SETUP_TYPES.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
                      <div><Label className="text-[10px]">Timeframe</Label>
                        <select value={formTimeframe} onChange={e => setFormTimeframe(e.target.value)} className="w-full mt-1 bg-secondary border border-border px-2 py-1.5 text-xs">{["5min","15min","1h","4h","1day"].map(t => <option key={t} value={t}>{t}</option>)}</select></div>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div><Label className="text-[10px]">Risk %</Label><Input value={formRisk} onChange={e => setFormRisk(e.target.value)} className="mt-1 h-7 text-xs" /></div>
                      <div><Label className="text-[10px]">R:R</Label><Input value={formRR} onChange={e => setFormRR(e.target.value)} className="mt-1 h-7 text-xs" /></div>
                      <div><Label className="text-[10px]">P&L</Label><Input value={formPnl} onChange={e => setFormPnl(e.target.value)} className="mt-1 h-7 text-xs" /></div>
                    </div>
                    <div><Label className="text-[10px]">Notes</Label><Textarea value={formNotes} onChange={e => setFormNotes(e.target.value)} className="mt-1 text-xs" rows={2} /></div>
                    <Button onClick={handleAddTrade} disabled={!formEntry} className="w-full h-7 text-xs">Save Trade</Button>
                  </div>
                </DialogContent>
              </Dialog>
              <Filter className="h-3.5 w-3.5 text-muted-foreground" />
              <select value={filterSymbol} onChange={e => setFilterSymbol(e.target.value)} className="bg-card border border-border px-2 py-1 text-[11px]">{ALL_SYMBOLS.map(s => <option key={s} value={s}>{s === "all" ? "All Symbols" : s}</option>)}</select>
              <select value={filterDirection} onChange={e => setFilterDirection(e.target.value as any)} className="bg-card border border-border px-2 py-1 text-[11px]"><option value="all">All</option><option value="long">Long</option><option value="short">Short</option></select>
            </div>
          </div>

          {/* Summary KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {[
              { label: "Total", value: computedStats.total },
              { label: "Wins", value: computedStats.wins, color: "text-success" },
              { label: "Losses", value: computedStats.losses, color: "text-destructive" },
              { label: "Win Rate", value: `${computedStats.winRate.toFixed(1)}%`, color: computedStats.winRate >= 50 ? "text-success" : "text-destructive" },
              { label: "Net P&L", value: formatMoney(computedStats.totalPnl, true), color: computedStats.totalPnl >= 0 ? "text-success" : "text-destructive" },
              { label: "PF", value: computedStats.profitFactor >= 999 ? "∞" : computedStats.profitFactor.toFixed(2) },
            ].map(s => (
              <Card key={s.label}><CardContent className="pt-2 pb-1"><p className="text-[9px] text-muted-foreground uppercase tracking-wider">{s.label}</p><p className={`text-sm font-bold font-mono ${s.color || ""}`}>{s.value}</p></CardContent></Card>
            ))}
          </div>

          <Tabs defaultValue="journal">
            <TabsList className="h-7">
              <TabsTrigger value="journal" className="text-[11px] h-6">Trades</TabsTrigger>
              <TabsTrigger value="performance" className="text-[11px] h-6">Performance</TabsTrigger>
              <TabsTrigger value="calculator" className="text-[11px] h-6">Calculator</TabsTrigger>
            </TabsList>

            <TabsContent value="journal" className="mt-2">
              <Card>
                <CardContent className="pt-3">
                  {isLoading ? <p className="text-xs text-muted-foreground py-4 text-center">Loading...</p> :
                  filteredTrades.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                      <BookOpen className="h-10 w-10 mb-3 opacity-20" />
                      <p className="text-sm font-medium">No trades recorded yet</p>
                      <p className="text-[11px] mt-1 text-center max-w-xs">Add trades manually with the "+ Add Trade" button, or they'll appear here automatically when your bot closes positions.</p>
                    </div>
                  ) : (
                    <table className="w-full text-[11px]">
                      <thead><tr className="border-b border-border text-muted-foreground text-[10px]">
                        <th className="text-left py-1 px-1">Symbol</th><th className="text-left py-1 px-1">Dir</th>
                        <th className="text-left py-1 px-1">Setup</th><th className="text-left py-1 px-1">Date</th>
                        <th className="text-right py-1 px-1">R:R</th><th className="text-right py-1 px-1">P&L</th>
                      </tr></thead>
                      <tbody>
                        {filteredTrades.map((t: any) => (
                          <tr key={t.id} className={`border-b border-border/30 hover:bg-secondary/30 cursor-pointer ${selectedTrade?.id === t.id ? 'bg-primary/5' : ''}`}
                            onClick={() => setSelectedTrade(selectedTrade?.id === t.id ? null : t)}>
                            <td className="py-1.5 px-1 font-medium">{t.symbol}</td>
                            <td className={`py-1.5 px-1 ${t.direction === "long" ? "text-success" : "text-destructive"}`}>{t.direction === "long" ? "▲" : "▼"}</td>
                            <td className="py-1.5 px-1 text-muted-foreground">{t.setup_type || "-"}</td>
                            <td className="py-1.5 px-1 text-muted-foreground font-mono">{t.entry_time?.split("T")[0]}</td>
                            <td className="py-1.5 px-1 text-right font-mono">{t.risk_reward || "-"}</td>
                            <td className={`py-1.5 px-1 text-right font-mono font-medium ${parseFloat(t.pnl_amount || "0") >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(parseFloat(t.pnl_amount || "0"), true)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {journalTotalPages > 1 && (
                    <div className="flex items-center justify-between px-2 py-2 border-t border-border mt-2">
                      <span className="text-[10px] text-muted-foreground font-mono">
                        Page {journalPage + 1} of {journalTotalPages} ({tradesTotalCount} total)
                      </span>
                      <div className="flex items-center gap-1">
                        <Button variant="outline" size="sm" className="h-7 px-2 text-[10px]" disabled={journalPage === 0} onClick={() => setJournalPage(0)}>«</Button>
                        <Button variant="outline" size="sm" className="h-7 px-2 text-[10px]" disabled={journalPage === 0} onClick={() => setJournalPage(p => p - 1)}>‹ Prev</Button>
                        <Button variant="outline" size="sm" className="h-7 px-2 text-[10px]" disabled={journalPage >= journalTotalPages - 1} onClick={() => setJournalPage(p => p + 1)}>Next ›</Button>
                        <Button variant="outline" size="sm" className="h-7 px-2 text-[10px]" disabled={journalPage >= journalTotalPages - 1} onClick={() => setJournalPage(journalTotalPages - 1)}>»</Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="performance" className="mt-2 space-y-3">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <Card>
                  <CardHeader className="pb-1"><CardTitle className="text-sm">Equity Curve</CardTitle></CardHeader>
                  <CardContent>
                    <div className="h-[200px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={equityCurveData}>
                          <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} />
                          <XAxis dataKey="date" tick={{ fontSize: 9, fontFamily: "'IBM Plex Mono'" }} stroke={ct.axis} />
                          <YAxis tick={{ fontSize: 9, fontFamily: "'IBM Plex Mono'" }} stroke={ct.axis} tickFormatter={v => `$${(v/1000).toFixed(1)}k`} />
                          <Tooltip contentStyle={{ backgroundColor: ct.tooltipBg, border: `1px solid ${ct.tooltipBorder}`, borderRadius: "0" }} />
                          <Area type="monotone" dataKey="equity" stroke="hsl(185, 80%, 55%)" fill="hsl(185, 80%, 55%)" fillOpacity={0.1} strokeWidth={2} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-1"><CardTitle className="text-sm">Daily P&L</CardTitle></CardHeader>
                  <CardContent>
                    <div className="h-[200px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={dailyPnlData}>
                          <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} />
                          <XAxis dataKey="date" tick={{ fontSize: 9, fontFamily: "'IBM Plex Mono'" }} stroke={ct.axis} />
                          <YAxis tick={{ fontSize: 9, fontFamily: "'IBM Plex Mono'" }} stroke={ct.axis} />
                          <Tooltip contentStyle={{ backgroundColor: ct.tooltipBg, border: `1px solid ${ct.tooltipBorder}`, borderRadius: "0" }} />
                          <Bar dataKey="pnl">{dailyPnlData.map((e, i) => <Cell key={i} fill={e.pnl >= 0 ? 'hsl(155, 70%, 45%)' : 'hsl(0, 72%, 51%)'} />)}</Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="calculator" className="mt-2">
              <RiskCalculator />
            </TabsContent>
          </Tabs>
        </div>

        {/* Trade Detail Panel (slide-in) */}
        {selectedTrade && (
          <div className="flex-1 border-t md:border-t-0 md:border-l border-border pt-3 md:pt-0 md:pl-3 md:ml-3 overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold">Trade Detail</h3>
              <button onClick={() => setSelectedTrade(null)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3 text-[11px]">
              <div className="space-y-1.5">
                <div className="flex justify-between"><span className="text-muted-foreground">Symbol</span><span className="font-bold">{selectedTrade.symbol}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Direction</span><span className={selectedTrade.direction === "long" ? "text-success" : "text-destructive"}>{selectedTrade.direction === "long" ? "▲ Long" : "▼ Short"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Status</span><span>{selectedTrade.status}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Entry</span><span className="font-mono">{selectedTrade.entry_price}</span></div>
                {selectedTrade.exit_price && <div className="flex justify-between"><span className="text-muted-foreground">Exit</span><span className="font-mono">{selectedTrade.exit_price}</span></div>}
                {selectedTrade.stop_loss && <div className="flex justify-between"><span className="text-muted-foreground">SL</span><span className="font-mono">{selectedTrade.stop_loss}</span></div>}
                {selectedTrade.take_profit && <div className="flex justify-between"><span className="text-muted-foreground">TP</span><span className="font-mono">{selectedTrade.take_profit}</span></div>}
                <div className="flex justify-between"><span className="text-muted-foreground">Setup</span><span>{selectedTrade.setup_type || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Timeframe</span><span>{selectedTrade.timeframe || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">R:R</span><span className="font-mono">{selectedTrade.risk_reward || "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">P&L</span>
                  <span className={`font-mono font-bold ${parseFloat(selectedTrade.pnl_amount || "0") >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(parseFloat(selectedTrade.pnl_amount || "0"), true)}</span>
                </div>
                <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span className="font-mono">{selectedTrade.entry_time?.split("T")[0]}</span></div>
              </div>

              {selectedTrade.notes && (
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Notes</p>
                  <p className="text-[11px] text-foreground bg-secondary/30 border border-border p-2">{selectedTrade.notes}</p>
                </div>
              )}

              {selectedTrade.reasoning_json && (
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Signal Reasoning</p>
                  <div className="bg-secondary/30 border border-border p-2">
                    <SignalReasoningCard signalReason={typeof selectedTrade.reasoning_json === "string" ? selectedTrade.reasoning_json : JSON.stringify(selectedTrade.reasoning_json)} />
                  </div>
                </div>
              )}

              {selectedTrade.post_mortem_json && (
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Post-Mortem</p>
                  <pre className="text-[10px] text-muted-foreground bg-secondary/30 border border-border p-2 whitespace-pre-wrap font-mono">{JSON.stringify(selectedTrade.post_mortem_json, null, 2)}</pre>
                </div>
              )}
            </div>
          </div>
        )}
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
      <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Calculator className="h-4 w-4" /> Risk Calculator</CardTitle></CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-3">
            {[
              { label: "Account Balance ($)", value: accountBalance, set: setAccountBalance },
              { label: "Risk (%)", value: riskPercent, set: setRiskPercent },
              { label: "Stop Loss (pips)", value: stopLossPips, set: setStopLossPips },
              { label: "Pip Value ($)", value: pipValue, set: setPipValue },
            ].map(f => (
              <div key={f.label}>
                <label className="text-[10px] text-muted-foreground">{f.label}</label>
                <input type="number" value={f.value} onChange={e => f.set(parseFloat(e.target.value) || 0)} className="w-full mt-1 bg-secondary border border-border px-2 py-1.5 text-xs font-mono" />
              </div>
            ))}
          </div>
          <div className="space-y-3 p-3 bg-secondary/30 border border-border">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Results</p>
            <div className="space-y-2 text-[11px]">
              <div className="flex justify-between"><span className="text-muted-foreground">Risk Amount</span><span className="font-mono text-destructive">{formatMoney(riskAmount)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Position Size</span><span className="font-mono font-bold text-lg">{positionSize.toFixed(2)} lots</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">2R Target</span><span className="font-mono text-success">{formatMoney(riskAmount * 2)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">3R Target</span><span className="font-mono text-success">{formatMoney(riskAmount * 3)}</span></div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
