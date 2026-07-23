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
import { Badge } from "@/components/ui/badge";
import { formatMoney, INSTRUMENTS } from "@/lib/marketData";
import { tradesApi, paperApi } from "@/lib/api";
import { SignalReasoningCard } from "@/components/SignalReasoningCard";
import { toast } from "sonner";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, CartesianGrid, PieChart, Pie,
} from "recharts";
import { Filter, Calculator, Plus, X, BookOpen, Download, Import, Tag, ChevronDown } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { getChartTheme } from "@/lib/chartTheme";

const ALL_SYMBOLS = ["all", ...INSTRUMENTS.map(i => i.symbol)];
const SETUP_TYPES = ["BOS + Order Block", "CHoCH + FVG Fill", "Liquidity Sweep + OB", "Premium/Discount + BOS", "FVG Fill + Confluence", "Manual"];

// ─── Auto-Tag Extraction ─────────────────────────────────────────────
interface AutoTags {
  setupType: string | null;
  session: string | null;
  regime: string | null;
  confirmation: string | null;
  keyFactors: string[];
  signalSource: string | null;
  score: number | null;
}

function getSessionFromTime(entryTime: string | null): string | null {
  if (!entryTime) return null;
  const d = new Date(entryTime);
  const h = d.getUTCHours();
  if (h >= 0 && h < 8) return "Asian";
  if (h >= 7 && h < 12) return "London";
  if (h >= 12 && h < 17) return "New York";
  if (h >= 17 && h < 21) return "NY PM";
  return "Off-Hours";
}

function extractAutoTags(trade: any): AutoTags {
  const tags: AutoTags = { setupType: null, session: null, regime: null, confirmation: null, keyFactors: [], signalSource: null, score: null };
  tags.session = getSessionFromTime(trade.entry_time);

  let reasoning: any = null;
  if (trade.reasoning_json) {
    reasoning = typeof trade.reasoning_json === "string"
      ? (() => { try { return JSON.parse(trade.reasoning_json); } catch { return null; } })()
      : trade.reasoning_json;
  }
  if (!reasoning) return tags;

  // Setup type from scanner classification
  tags.setupType = reasoning.setupType || reasoning.setupClassification?.setupType || null;
  // Signal source
  tags.signalSource = reasoning.signalSource || (reasoning.filledFromLimitOrder ? "limit_order" : reasoning.paper_position_id ? "bot" : null);
  // Confirmation method
  tags.confirmation = reasoning.confirmationMethod || reasoning.confirmation?.type || null;
  // Regime
  if (reasoning.regimeData?.daily?.regime) {
    tags.regime = reasoning.regimeData.daily.regime;
  }
  // Score
  tags.score = reasoning.signal_score != null ? parseFloat(reasoning.signal_score) : null;
  // Key factors (top 3 present factors by weight)
  if (reasoning.factorScores && Array.isArray(reasoning.factorScores)) {
    tags.keyFactors = reasoning.factorScores
      .filter((f: any) => f.present)
      .sort((a: any, b: any) => (b.weight || 0) - (a.weight || 0))
      .slice(0, 3)
      .map((f: any) => f.name);
  } else if (reasoning.tieredScoring) {
    // Extract from tiered scoring
    const allFactors: string[] = [];
    for (const tier of ["t1", "t2", "t3"]) {
      const t = reasoning.tieredScoring[tier];
      if (t?.factors) {
        allFactors.push(...t.factors.filter((f: any) => f.pass || f.present).map((f: any) => f.name || f.label));
      }
    }
    tags.keyFactors = allFactors.slice(0, 3);
  }
  return tags;
}

const TAG_COLORS: Record<string, string> = {
  // Sessions
  "Asian": "bg-violet-500/15 text-violet-400 border-violet-500/30",
  "London": "bg-blue-500/15 text-blue-400 border-blue-500/30",
  "New York": "bg-amber-500/15 text-amber-400 border-amber-500/30",
  "NY PM": "bg-orange-500/15 text-orange-400 border-orange-500/30",
  "Off-Hours": "bg-gray-500/15 text-gray-400 border-gray-500/30",
  // Regimes
  "trending": "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  "ranging": "bg-sky-500/15 text-sky-400 border-sky-500/30",
  "volatile": "bg-red-500/15 text-red-400 border-red-500/30",
  "transitioning": "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  // Sources
  "bot": "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  "limit_order": "bg-indigo-500/15 text-indigo-400 border-indigo-500/30",
  // Default
  "default": "bg-muted/40 text-muted-foreground border-border",
};

function getTagColor(tag: string): string {
  return TAG_COLORS[tag] || TAG_COLORS.default;
}

export default function JournalView() {
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const ct = getChartTheme(resolvedTheme);
  const [filterSymbol, setFilterSymbol] = useState("all");
  const [filterDirection, setFilterDirection] = useState<"all" | "long" | "short">("all");
  const [filterTag, setFilterTag] = useState<string>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [selectedTrade, setSelectedTrade] = useState<any>(null);
  const [showTagFilters, setShowTagFilters] = useState(false);

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
  const { data: accountStatus } = useQuery({
    queryKey: ["paper-status-journal"],
    queryFn: () => paperApi.status(),
    staleTime: 60_000,
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
    const headers = ["Date", "Symbol", "Direction", "Setup", "Entry", "Exit", "P&L", "R:R", "Risk%", "Session", "Regime", "Score", "Notes"];
    const rows = filteredTrades.map((t: any) => {
      const tags = extractAutoTags(t);
      return [
        t.entry_time?.split("T")[0] ?? "", t.symbol, t.direction, tags.setupType || t.setup_type || "",
        t.entry_price, t.exit_price || "", t.pnl_amount || "", t.risk_reward || "",
        t.risk_percent || "", tags.session || "", tags.regime || "", tags.score ?? "",
        (t.notes || "").replace(/"/g, '""'),
      ];
    });
    const csv = [headers.join(","), ...rows.map(r => r.map((v: any) => `"${v}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `trades_${new Date().toISOString().split("T")[0]}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV downloaded");
  };

  // Extract all unique tags for the filter dropdown
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    trades.forEach((t: any) => {
      const tags = extractAutoTags(t);
      if (tags.session) tagSet.add(`session:${tags.session}`);
      if (tags.regime) tagSet.add(`regime:${tags.regime}`);
      if (tags.setupType) tagSet.add(`setup:${tags.setupType}`);
      if (tags.signalSource) tagSet.add(`source:${tags.signalSource}`);
      if (tags.confirmation) tagSet.add(`confirm:${tags.confirmation}`);
      tags.keyFactors.forEach(f => tagSet.add(`factor:${f}`));
    });
    return Array.from(tagSet).sort();
  }, [trades]);

  const filteredTrades = useMemo(() => {
    return (trades as any[]).filter((t: any) => {
      if (filterSymbol !== "all" && t.symbol !== filterSymbol) return false;
      if (filterDirection !== "all" && t.direction !== filterDirection) return false;
      if (filterTag !== "all") {
        const tags = extractAutoTags(t);
        const [category, value] = filterTag.split(":");
        switch (category) {
          case "session": if (tags.session !== value) return false; break;
          case "regime": if (tags.regime !== value) return false; break;
          case "setup": if (tags.setupType !== value) return false; break;
          case "source": if (tags.signalSource !== value) return false; break;
          case "confirm": if (tags.confirmation !== value) return false; break;
          case "factor": if (!tags.keyFactors.includes(value)) return false; break;
        }
      }
      return true;
    });
  }, [trades, filterSymbol, filterDirection, filterTag]);

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
    const closedTrades = filteredTrades.filter((t: any) => t.status === "closed");
    const totalClosedPnl = closedTrades.reduce((s: number, t: any) => s + parseFloat(t.pnl_amount || "0"), 0);
    const currentBalance = accountStatus?.balance ?? 10000;
    let cum = currentBalance - totalClosedPnl;
    const sorted = [...closedTrades].sort((a: any, b: any) => {
      const da = a.exit_time || a.entry_time || "";
      const db = b.exit_time || b.entry_time || "";
      return da.localeCompare(db);
    });
    return sorted.map((t: any) => {
      cum += parseFloat(t.pnl_amount || "0");
      const dateStr = (t.exit_time || t.entry_time)?.split("T")[0] ?? "";
      return { date: dateStr, equity: cum };
    });
  }, [filteredTrades, accountStatus]);

  const dailyPnlData = useMemo(() => {
    const map: Record<string, number> = {};
    filteredTrades.filter((t: any) => t.status === "closed").forEach((t: any) => {
      const date = (t.exit_time || t.entry_time)?.split("T")[0] ?? "";
      map[date] = (map[date] || 0) + parseFloat(t.pnl_amount || "0");
    });
    return Object.entries(map).map(([date, pnl]) => ({ date, pnl })).sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredTrades]);

  // ─── Analytics: Performance by Tag ─────────────────────────────────
  const tagPerformance = useMemo(() => {
    const closedTrades = filteredTrades.filter((t: any) => t.status === "closed" && t.pnl_amount != null);
    // By session
    const bySession: Record<string, { wins: number; total: number; pnl: number }> = {};
    // By setup type
    const bySetup: Record<string, { wins: number; total: number; pnl: number }> = {};
    // By regime
    const byRegime: Record<string, { wins: number; total: number; pnl: number }> = {};

    closedTrades.forEach((t: any) => {
      const tags = extractAutoTags(t);
      const pnl = parseFloat(t.pnl_amount || "0");
      const isWin = pnl > 0;

      if (tags.session) {
        if (!bySession[tags.session]) bySession[tags.session] = { wins: 0, total: 0, pnl: 0 };
        bySession[tags.session].total++;
        if (isWin) bySession[tags.session].wins++;
        bySession[tags.session].pnl += pnl;
      }
      const setup = tags.setupType || t.setup_type;
      if (setup) {
        if (!bySetup[setup]) bySetup[setup] = { wins: 0, total: 0, pnl: 0 };
        bySetup[setup].total++;
        if (isWin) bySetup[setup].wins++;
        bySetup[setup].pnl += pnl;
      }
      if (tags.regime) {
        if (!byRegime[tags.regime]) byRegime[tags.regime] = { wins: 0, total: 0, pnl: 0 };
        byRegime[tags.regime].total++;
        if (isWin) byRegime[tags.regime].wins++;
        byRegime[tags.regime].pnl += pnl;
      }
    });

    return { bySession, bySetup, byRegime };
  }, [filteredTrades]);

  return (
    <AppShell>
      <div className="flex flex-col md:flex-row h-[calc(100vh-3.5rem)] md:h-[calc(100vh-4.5rem)]">
        {/* Main content */}
        <div className={`${selectedTrade ? 'flex-[2]' : 'flex-1'} flex flex-col min-h-0 space-y-3 overflow-y-auto pr-2`}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h1 className="text-xl font-bold">Trade Journal</h1>
            <div className="flex items-center gap-2 flex-wrap">
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
              <div className="flex items-center gap-1.5">
                <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                <select value={filterSymbol} onChange={e => setFilterSymbol(e.target.value)} className="bg-card border border-border px-2 py-1 text-[11px]">{ALL_SYMBOLS.map(s => <option key={s} value={s}>{s === "all" ? "All Symbols" : s}</option>)}</select>
                <select value={filterDirection} onChange={e => setFilterDirection(e.target.value as any)} className="bg-card border border-border px-2 py-1 text-[11px]"><option value="all">All</option><option value="long">Long</option><option value="short">Short</option></select>
                <button onClick={() => setShowTagFilters(!showTagFilters)} className={`flex items-center gap-1 px-2 py-1 text-[11px] border rounded ${showTagFilters ? 'bg-primary/10 border-primary/40 text-primary' : 'bg-card border-border text-muted-foreground'}`}>
                  <Tag className="h-3 w-3" /> Tags <ChevronDown className={`h-2.5 w-2.5 transition-transform ${showTagFilters ? 'rotate-180' : ''}`} />
                </button>
              </div>
            </div>
          </div>

          {/* Tag filter chips */}
          {showTagFilters && (
            <div className="flex flex-wrap gap-1.5 pb-1">
              <button onClick={() => setFilterTag("all")} className={`px-2 py-0.5 text-[10px] rounded border ${filterTag === "all" ? "bg-primary/15 border-primary/40 text-primary" : "bg-card border-border text-muted-foreground"}`}>All</button>
              {allTags.map(tag => {
                const [cat, val] = tag.split(":");
                const label = `${cat === "factor" ? "" : cat + ": "}${val}`;
                return (
                  <button key={tag} onClick={() => setFilterTag(filterTag === tag ? "all" : tag)}
                    className={`px-2 py-0.5 text-[10px] rounded border ${filterTag === tag ? "bg-primary/15 border-primary/40 text-primary font-medium" : getTagColor(val)}`}>
                    {label}
                  </button>
                );
              })}
            </div>
          )}

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
              <TabsTrigger value="analytics" className="text-[11px] h-6">Analytics</TabsTrigger>
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
                        <th className="text-left py-1 px-1">Tags</th><th className="text-left py-1 px-1">Date</th>
                        <th className="text-right py-1 px-1">Score</th><th className="text-right py-1 px-1">P&L</th>
                      </tr></thead>
                      <tbody>
                        {filteredTrades.map((t: any) => {
                          const tags = extractAutoTags(t);
                          return (
                            <tr key={t.id} className={`border-b border-border/30 hover:bg-secondary/30 cursor-pointer ${selectedTrade?.id === t.id ? 'bg-primary/5' : ''}`}
                              onClick={() => setSelectedTrade(selectedTrade?.id === t.id ? null : t)}>
                              <td className="py-1.5 px-1">
                                <span className="font-medium">{t.symbol}</span>
                                <span className={`ml-1 ${t.direction === "long" ? "text-success" : "text-destructive"}`}>{t.direction === "long" ? "▲" : "▼"}</span>
                              </td>
                              <td className={`py-1.5 px-1 text-[10px] ${t.direction === "long" ? "text-success" : "text-destructive"}`}>
                                {t.direction}
                              </td>
                              <td className="py-1.5 px-1">
                                <div className="flex flex-wrap gap-0.5">
                                  {tags.session && <Badge variant="outline" className={`text-[8px] px-1 py-0 h-4 ${getTagColor(tags.session)}`}>{tags.session}</Badge>}
                                  {tags.setupType && <Badge variant="outline" className="text-[8px] px-1 py-0 h-4 bg-muted/40 text-muted-foreground border-border">{tags.setupType.replace(/_/g, " ")}</Badge>}
                                  {tags.regime && <Badge variant="outline" className={`text-[8px] px-1 py-0 h-4 ${getTagColor(tags.regime)}`}>{tags.regime}</Badge>}
                                </div>
                              </td>
                              <td className="py-1.5 px-1 text-muted-foreground font-mono">{t.entry_time?.split("T")[0]}</td>
                              <td className="py-1.5 px-1 text-right font-mono">{tags.score != null ? tags.score.toFixed(1) : (t.risk_reward || "-")}</td>
                              <td className={`py-1.5 px-1 text-right font-mono font-medium ${parseFloat(t.pnl_amount || "0") >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(parseFloat(t.pnl_amount || "0"), true)}</td>
                            </tr>
                          );
                        })}
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

            {/* ─── Analytics Tab: Tag Performance ─────────────────────── */}
            <TabsContent value="analytics" className="mt-2 space-y-3">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                <TagPerformanceCard title="By Session" data={tagPerformance.bySession} ct={ct} />
                <TagPerformanceCard title="By Setup Type" data={tagPerformance.bySetup} ct={ct} />
                <TagPerformanceCard title="By Regime" data={tagPerformance.byRegime} ct={ct} />
              </div>
              {/* Factor frequency heatmap */}
              <Card>
                <CardHeader className="pb-1"><CardTitle className="text-sm">Factor Frequency (Top Factors in Winning Trades)</CardTitle></CardHeader>
                <CardContent>
                  <FactorHeatmap trades={filteredTrades} />
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
                          <YAxis tick={{ fontSize: 9, fontFamily: "'IBM Plex Mono'" }} stroke={ct.axis} tickFormatter={(v: number) => v >= 1000 ? `$${Math.round(v/1000)}k` : `$${Math.round(v)}`} domain={[(dataMin: number) => Math.floor(dataMin * 0.995), (dataMax: number) => Math.ceil(dataMax * 1.005)]} />
                          <Tooltip contentStyle={{ backgroundColor: ct.tooltipBg, border: `1px solid ${ct.tooltipBorder}`, borderRadius: "0" }} formatter={(value: number) => [`$${Math.round(value).toLocaleString()}`, 'Equity']} />
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
                          <YAxis tick={{ fontSize: 9, fontFamily: "'IBM Plex Mono'" }} stroke={ct.axis} tickFormatter={(v: number) => v >= 1000 ? `$${Math.round(v/1000)}k` : `$${Math.round(v)}`} />
                          <Tooltip contentStyle={{ backgroundColor: ct.tooltipBg, border: `1px solid ${ct.tooltipBorder}`, borderRadius: "0" }} formatter={(value: number) => [`$${Math.round(value).toLocaleString()}`, 'P&L']} />
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
            <TradeDetailPanel trade={selectedTrade} />
          </div>
        )}
      </div>
    </AppShell>
  );
}

// ─── Trade Detail Panel ──────────────────────────────────────────────
function TradeDetailPanel({ trade }: { trade: any }) {
  const tags = extractAutoTags(trade);

  return (
    <div className="space-y-3 text-[11px]">
      {/* Auto-Tags */}
      <div>
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Auto-Tags</p>
        <div className="flex flex-wrap gap-1">
          {tags.session && <Badge variant="outline" className={`text-[9px] ${getTagColor(tags.session)}`}>{tags.session}</Badge>}
          {tags.setupType && <Badge variant="outline" className="text-[9px] bg-muted/40 text-muted-foreground border-border">{tags.setupType.replace(/_/g, " ")}</Badge>}
          {tags.regime && <Badge variant="outline" className={`text-[9px] ${getTagColor(tags.regime)}`}>{tags.regime}</Badge>}
          {tags.confirmation && <Badge variant="outline" className="text-[9px] bg-indigo-500/15 text-indigo-400 border-indigo-500/30">{tags.confirmation}</Badge>}
          {tags.signalSource && <Badge variant="outline" className={`text-[9px] ${getTagColor(tags.signalSource)}`}>{tags.signalSource === "limit_order" ? "Limit Fill" : tags.signalSource}</Badge>}
          {tags.keyFactors.map(f => (
            <Badge key={f} variant="outline" className="text-[9px] bg-emerald-500/10 text-emerald-400 border-emerald-500/25">{f}</Badge>
          ))}
          {tags.score != null && <Badge variant="outline" className="text-[9px] bg-primary/10 text-primary border-primary/30 font-mono">{tags.score.toFixed(1)} pts</Badge>}
        </div>
      </div>

      {/* Trade Metadata */}
      <div className="space-y-1.5">
        <div className="flex justify-between"><span className="text-muted-foreground">Symbol</span><span className="font-bold">{trade.symbol}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Direction</span><span className={trade.direction === "long" ? "text-success" : "text-destructive"}>{trade.direction === "long" ? "▲ Long" : "▼ Short"}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Status</span><span>{trade.status}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Entry</span><span className="font-mono">{trade.entry_price}</span></div>
        {trade.exit_price && <div className="flex justify-between"><span className="text-muted-foreground">Exit</span><span className="font-mono">{trade.exit_price}</span></div>}
        {trade.stop_loss && <div className="flex justify-between"><span className="text-muted-foreground">SL</span><span className="font-mono">{trade.stop_loss}</span></div>}
        {trade.take_profit && <div className="flex justify-between"><span className="text-muted-foreground">TP</span><span className="font-mono">{trade.take_profit}</span></div>}
        <div className="flex justify-between"><span className="text-muted-foreground">R:R</span><span className="font-mono">{trade.risk_reward || "—"}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">P&L</span>
          <span className={`font-mono font-bold ${parseFloat(trade.pnl_amount || "0") >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(parseFloat(trade.pnl_amount || "0"), true)}</span>
        </div>
        <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span className="font-mono">{trade.entry_time?.split("T")[0]}</span></div>
      </div>

      {trade.notes && (
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Notes</p>
          <p className="text-[11px] text-foreground bg-secondary/30 border border-border p-2">{trade.notes}</p>
        </div>
      )}

      {trade.reasoning_json && (
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Signal Reasoning</p>
          <div className="bg-secondary/30 border border-border p-2">
            <SignalReasoningCard signalReason={typeof trade.reasoning_json === "string" ? trade.reasoning_json : JSON.stringify(trade.reasoning_json)} />
          </div>
        </div>
      )}

      {trade.post_mortem_json && (
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Post-Mortem</p>
          <PostMortemDisplay data={trade.post_mortem_json} />
        </div>
      )}
    </div>
  );
}

// ─── Post-Mortem Display ─────────────────────────────────────────────
function PostMortemDisplay({ data }: { data: any }) {
  const pm = typeof data === "string" ? (() => { try { return JSON.parse(data); } catch { return null; } })() : data;
  if (!pm) return <pre className="text-[10px] text-muted-foreground bg-secondary/30 border border-border p-2 whitespace-pre-wrap font-mono">{JSON.stringify(data, null, 2)}</pre>;

  return (
    <div className="bg-secondary/30 border border-border p-2 space-y-2">
      {pm.outcome && (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-[9px] ${pm.outcome === "win" ? "bg-success/15 text-success border-success/30" : pm.outcome === "loss" ? "bg-destructive/15 text-destructive border-destructive/30" : "bg-muted/40 text-muted-foreground border-border"}`}>
            {pm.outcome.toUpperCase()}
          </Badge>
          {pm.holdDuration && <span className="text-[10px] text-muted-foreground">{pm.holdDuration}</span>}
        </div>
      )}
      {pm.whatWorked && (
        <div><p className="text-[9px] text-success/80 uppercase">What Worked</p><p className="text-[10px] text-foreground">{pm.whatWorked}</p></div>
      )}
      {pm.whatFailed && (
        <div><p className="text-[9px] text-destructive/80 uppercase">What Failed</p><p className="text-[10px] text-foreground">{pm.whatFailed}</p></div>
      )}
      {pm.lessonLearned && (
        <div><p className="text-[9px] text-primary/80 uppercase">Lesson</p><p className="text-[10px] text-foreground">{pm.lessonLearned}</p></div>
      )}
    </div>
  );
}

// ─── Tag Performance Card ────────────────────────────────────────────
function TagPerformanceCard({ title, data, ct }: { title: string; data: Record<string, { wins: number; total: number; pnl: number }>; ct: any }) {
  const entries = Object.entries(data).sort((a, b) => b[1].total - a[1].total);
  if (entries.length === 0) return (
    <Card><CardHeader className="pb-1"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent><p className="text-xs text-muted-foreground py-4 text-center">No data yet</p></CardContent></Card>
  );

  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent>
        <div className="space-y-1.5">
          {entries.slice(0, 8).map(([key, stats]) => {
            const wr = stats.total > 0 ? (stats.wins / stats.total * 100) : 0;
            return (
              <div key={key} className="flex items-center justify-between text-[10px]">
                <span className="text-muted-foreground truncate max-w-[100px]">{key.replace(/_/g, " ")}</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-muted-foreground">{stats.total}t</span>
                  <span className={`font-mono font-medium ${wr >= 50 ? "text-success" : "text-destructive"}`}>{wr.toFixed(0)}%</span>
                  <span className={`font-mono w-14 text-right ${stats.pnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(stats.pnl, true)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Factor Heatmap ──────────────────────────────────────────────────
function FactorHeatmap({ trades }: { trades: any[] }) {
  const factorStats = useMemo(() => {
    const stats: Record<string, { winCount: number; lossCount: number; total: number }> = {};
    const closedTrades = trades.filter((t: any) => t.status === "closed" && t.pnl_amount != null);

    closedTrades.forEach((t: any) => {
      const tags = extractAutoTags(t);
      const isWin = parseFloat(t.pnl_amount || "0") > 0;
      tags.keyFactors.forEach(f => {
        if (!stats[f]) stats[f] = { winCount: 0, lossCount: 0, total: 0 };
        stats[f].total++;
        if (isWin) stats[f].winCount++;
        else stats[f].lossCount++;
      });
    });

    return Object.entries(stats)
      .filter(([, s]) => s.total >= 2)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 12);
  }, [trades]);

  if (factorStats.length === 0) return <p className="text-xs text-muted-foreground py-4 text-center">Import bot trades to see factor performance</p>;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
      {factorStats.map(([name, stats]) => {
        const wr = stats.total > 0 ? (stats.winCount / stats.total * 100) : 0;
        const intensity = Math.min(1, stats.total / 10);
        return (
          <div key={name} className="p-2 rounded border border-border bg-secondary/20" style={{ opacity: 0.5 + intensity * 0.5 }}>
            <p className="text-[9px] text-muted-foreground truncate">{name}</p>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className={`text-sm font-bold font-mono ${wr >= 55 ? "text-success" : wr >= 45 ? "text-foreground" : "text-destructive"}`}>{wr.toFixed(0)}%</span>
              <span className="text-[9px] text-muted-foreground">({stats.total})</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Risk Calculator ─────────────────────────────────────────────────
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
