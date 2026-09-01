import React, { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { formatBrokerTime } from "@/lib/formatTime";
import { formatPipDisplay, rawPipsToDisplay, getPipLabel } from "@/lib/pipDisplay";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTheme } from "@/contexts/ThemeContext";
import { getChartTheme } from "@/lib/chartTheme";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line, Area, AreaChart,
} from "recharts";
import {
  ShieldX, ShieldCheck, TrendingUp, TrendingDown, Target, AlertTriangle,
  RefreshCw, Filter, ArrowUpDown, Sparkles, Download,
} from "lucide-react";
import { StrategyAdvisor } from "@/components/StrategyAdvisor";
import { TradeDetailCard } from "@/components/TradeDetailCard";

// ── Types ──
interface RejectedSetup {
  id: string;
  symbol: string;
  direction: string;
  rejection_type: string;
  failed_gates: string[] | null;
  confluence_score: number;
  tier1_count: number;
  tier1_factors: string[] | null;
  entry_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  rr_ratio: number | null;
  session_name: string | null;
  regime: string | null;
  gp_bias: string | null;
  gp_bias_confidence: number | null;
  fotsi_base_tsi: number | null;
  fotsi_quote_tsi: number | null;
  price_at_rejection: number | null;
  outcome_status: string;
  outcome_checked_at: string | null;
  mfe_pips: number | null;
  mae_pips: number | null;
  tp_hit: boolean | null;
  sl_hit: boolean | null;
  tp_hit_time_minutes: number | null;
  price_reached_entry: boolean | null;
  rejected_at: string;
}

// ── Constants ──
const OUTCOME_COLORS: Record<string, string> = {
  would_have_won: "#22c55e",
  would_have_lost: "#ef4444",
  inconclusive: "#6b7280",
  pending: "#f59e0b",
};

const REJECTION_TYPE_LABELS: Record<string, string> = {
  gate_blocked: "Gate Blocked",
  below_threshold_strong_t1: "Below Threshold (Strong T1)",
};

// ── CSV/Download helpers ──
function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function toCSV(rows: Record<string, any>[]): string {
  if (rows.length === 0) return "";
  const headerSet = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) headerSet.add(k);
  const headers = Array.from(headerSet);
  const escape = (v: any) => {
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) v = v.join("; ");
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map((h) => escape(r[h])).join(","));
  return lines.join("\n");
}

const tsStamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

// ── Data Fetching ──
async function fetchRejectedSetups(userId: string, days: number): Promise<RejectedSetup[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await (supabase as any)
    .from("rejected_setups")
    .select("*")
    .eq("user_id", userId)
    .gte("rejected_at", since)
    .order("rejected_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return data || [];
}

// ── Summary Stats ──
function computeStats(setups: RejectedSetup[]) {
  const resolved = setups.filter(s => s.outcome_status !== "pending" && s.outcome_status !== "inconclusive");
  const winners = resolved.filter(s => s.outcome_status === "would_have_won");
  const losers = resolved.filter(s => s.outcome_status === "would_have_lost");
  const winnerBlockRate = resolved.length > 0 ? (winners.length / resolved.length) * 100 : 0;
  const avgMfe = resolved.length > 0 ? resolved.reduce((sum, s) => sum + rawPipsToDisplay(s.mfe_pips || 0, s.symbol), 0) / resolved.length : 0;
  const avgMae = resolved.length > 0 ? resolved.reduce((sum, s) => sum + rawPipsToDisplay(s.mae_pips || 0, s.symbol), 0) / resolved.length : 0;
  const avgScore = setups.length > 0 ? setups.reduce((sum, s) => sum + s.confluence_score, 0) / setups.length : 0;
  const entryReachedRate = resolved.length > 0
    ? (resolved.filter(s => s.price_reached_entry).length / resolved.length) * 100
    : 0;

  return { total: setups.length, resolved: resolved.length, winners: winners.length, losers: losers.length, winnerBlockRate, avgMfe, avgMae, avgScore, entryReachedRate };
}

// ── Gate Breakdown ──
function computeGateBreakdown(setups: RejectedSetup[]) {
  const gateMap = new Map<string, { total: number; wouldWon: number; wouldLost: number }>();
  for (const s of setups) {
    if (!s.failed_gates) continue;
    for (const gate of s.failed_gates) {
      const entry = gateMap.get(gate) || { total: 0, wouldWon: 0, wouldLost: 0 };
      entry.total++;
      if (s.outcome_status === "would_have_won") entry.wouldWon++;
      if (s.outcome_status === "would_have_lost") entry.wouldLost++;
      gateMap.set(gate, entry);
    }
  }
  return Array.from(gateMap.entries())
    .map(([gate, stats]) => ({ gate, ...stats, winRate: stats.total > 0 ? (stats.wouldWon / stats.total) * 100 : 0 }))
    .sort((a, b) => b.total - a.total);
}

// ── Daily Trend ──
function computeDailyTrend(setups: RejectedSetup[]) {
  const dayMap = new Map<string, { date: string; total: number; wouldWon: number; wouldLost: number }>();
  for (const s of setups) {
    const day = s.rejected_at.slice(0, 10);
    const entry = dayMap.get(day) || { date: day, total: 0, wouldWon: 0, wouldLost: 0 };
    entry.total++;
    if (s.outcome_status === "would_have_won") entry.wouldWon++;
    if (s.outcome_status === "would_have_lost") entry.wouldLost++;
    dayMap.set(day, entry);
  }
  return Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Gate label shortener (long messages → concise chart labels) ──
function shortenGateLabel(gate: string): string {
  if (gate.startsWith("Selling in discount zone")) return "P/D Zone Rejection";
  if (gate.startsWith("Buying in premium zone")) return "P/D Zone Rejection";
  if (gate.includes("SMT divergence opposite")) return "SMT Divergence";
  if (gate.includes("threshold")) {
    const match = gate.match(/Score ([\d.]+) < (\d+)/);
    return match ? `Score < ${match[2]}` : "Below Threshold";
  }
  if (gate.length > 30) return gate.slice(0, 27) + "...";
  return gate;
}

// ── Component ──
export default function RejectedSetups() {
  const { user } = useAuth();
  const { resolvedTheme } = useTheme();
  const chartTheme = getChartTheme(resolvedTheme);
  const isMobile = useIsMobile();
  const [days, setDays] = useState(7);
  const [symbolFilter, setSymbolFilter] = useState<string>("all");
  const [outcomeFilter, setOutcomeFilter] = useState<string>("all");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const { data: rawSetups = [], isLoading, refetch } = useQuery({
    queryKey: ["rejected-setups", user?.id, days],
    queryFn: () => fetchRejectedSetups(user!.id, days),
    enabled: !!user?.id,
    refetchInterval: 60_000,
  });

  // Filters
  const setups = useMemo(() => {
    let filtered = rawSetups;
    if (symbolFilter !== "all") filtered = filtered.filter(s => s.symbol === symbolFilter);
    if (outcomeFilter !== "all") filtered = filtered.filter(s => s.outcome_status === outcomeFilter);
    return filtered;
  }, [rawSetups, symbolFilter, outcomeFilter]);

  const symbols = useMemo(() => [...new Set(rawSetups.map(s => s.symbol))].sort(), [rawSetups]);
  const stats = useMemo(() => computeStats(setups), [setups]);
  const gateBreakdown = useMemo(() => computeGateBreakdown(setups), [setups]);
  const dailyTrend = useMemo(() => computeDailyTrend(setups), [setups]);

  // ── Download handlers ──
  const downloadSummary = () => {
    const rows = [
      { metric: "Range (days)", value: days },
      { metric: "Symbol Filter", value: symbolFilter },
      { metric: "Outcome Filter", value: outcomeFilter },
      { metric: "Total Rejected", value: stats.total },
      { metric: "Resolved", value: stats.resolved },
      { metric: "Would Have Won", value: stats.winners },
      { metric: "Would Have Lost", value: stats.losers },
      { metric: "Winner-Block Rate (%)", value: stats.winnerBlockRate.toFixed(2) },
      { metric: "Avg MFE (pips)", value: stats.avgMfe.toFixed(2) },
      { metric: "Avg MAE (pips)", value: stats.avgMae.toFixed(2) },
      { metric: "Avg Confluence Score", value: stats.avgScore.toFixed(2) },
      { metric: "Entry Reached Rate (%)", value: stats.entryReachedRate.toFixed(2) },
    ];
    downloadFile(`rejected-summary-${tsStamp()}.csv`, toCSV(rows), "text/csv");
  };

  const downloadOverview = () => {
    const outcome = outcomeDistribution.map((o) => ({ section: "outcome_distribution", name: o.name, value: o.value }));
    const daily = dailyTrend.map((d) => ({ section: "daily_trend", date: d.date, total: d.total, would_won: d.wouldWon, would_lost: d.wouldLost }));
    const scoreBuckets = (() => {
      const buckets = [
        { range: "30-40", won: 0, lost: 0 },
        { range: "40-50", won: 0, lost: 0 },
        { range: "50-60", won: 0, lost: 0 },
        { range: "60-70", won: 0, lost: 0 },
        { range: "70-80", won: 0, lost: 0 },
        { range: "80+", won: 0, lost: 0 },
      ];
      for (const s of setups) {
        const score = s.confluence_score;
        const idx = score < 40 ? 0 : score < 50 ? 1 : score < 60 ? 2 : score < 70 ? 3 : score < 80 ? 4 : 5;
        if (s.outcome_status === "would_have_won") buckets[idx].won++;
        if (s.outcome_status === "would_have_lost") buckets[idx].lost++;
      }
      return buckets.map((b) => ({ section: "score_distribution", range: b.range, won: b.won, lost: b.lost }));
    })();
    downloadFile(`rejected-overview-${tsStamp()}.csv`, toCSV([...outcome, ...daily, ...scoreBuckets]), "text/csv");
  };

  const downloadGates = () => {
    const rows = gateBreakdown.map((g) => ({
      gate: g.gate,
      total_blocked: g.total,
      would_won: g.wouldWon,
      would_lost: g.wouldLost,
      win_rate_pct: g.winRate.toFixed(2),
    }));
    downloadFile(`rejected-gates-${tsStamp()}.csv`, toCSV(rows), "text/csv");
  };

  const downloadSetups = () => {
    const rows = setups.map((s) => ({
      rejected_at: s.rejected_at,
      symbol: s.symbol,
      direction: s.direction,
      rejection_type: s.rejection_type,
      confluence_score: s.confluence_score,
      tier1_count: s.tier1_count,
      tier1_factors: s.tier1_factors,
      failed_gates: s.failed_gates,
      entry_price: s.entry_price,
      stop_loss: s.stop_loss,
      take_profit: s.take_profit,
      rr_ratio: s.rr_ratio,
      session_name: s.session_name,
      regime: s.regime,
      gp_bias: s.gp_bias,
      gp_bias_confidence: s.gp_bias_confidence,
      fotsi_base_tsi: s.fotsi_base_tsi,
      fotsi_quote_tsi: s.fotsi_quote_tsi,
      price_at_rejection: s.price_at_rejection,
      outcome_status: s.outcome_status,
      mfe_pips: s.mfe_pips,
      mae_pips: s.mae_pips,
      tp_hit: s.tp_hit,
      sl_hit: s.sl_hit,
      tp_hit_time_minutes: s.tp_hit_time_minutes,
      price_reached_entry: s.price_reached_entry,
      outcome_checked_at: s.outcome_checked_at,
    }));
    downloadFile(`rejected-setups-${tsStamp()}.csv`, toCSV(rows), "text/csv");
  };

  const downloadAdvisor = () => {
    try {
      const raw = localStorage.getItem("strategyAdvisor:lastResult");
      if (!raw) {
        downloadFile(`advisor-${tsStamp()}.json`, JSON.stringify({ error: "No advisor analysis saved. Run analysis first." }, null, 2), "application/json");
        return;
      }
      const parsed = JSON.parse(raw);
      downloadFile(`advisor-${tsStamp()}.json`, JSON.stringify(parsed, null, 2), "application/json");
    } catch (e: any) {
      downloadFile(`advisor-${tsStamp()}.json`, JSON.stringify({ error: e?.message || "Failed" }, null, 2), "application/json");
    }
  };

  const downloadAll = () => {
    downloadSummary();
    downloadOverview();
    downloadGates();
    downloadSetups();
    downloadAdvisor();
  };

  // Pie chart data
  const outcomeDistribution = useMemo(() => [
    { name: "Would Have Won", value: stats.winners, color: OUTCOME_COLORS.would_have_won },
    { name: "Would Have Lost", value: stats.losers, color: OUTCOME_COLORS.would_have_lost },
    { name: "Inconclusive", value: setups.filter(s => s.outcome_status === "inconclusive").length, color: OUTCOME_COLORS.inconclusive },
    { name: "Pending", value: setups.filter(s => s.outcome_status === "pending").length, color: OUTCOME_COLORS.pending },
  ].filter(d => d.value > 0), [stats, setups]);

  return (
    <AppShell>
      <div className="space-y-4 pb-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">Rejected Setups Analytics</h1>
            <p className="text-sm text-muted-foreground">Counterfactual outcomes of gate-blocked and below-threshold setups</p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="w-[100px] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="3">3 days</SelectItem>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="14">14 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" onClick={() => refetch()} className="h-8 w-8 p-0">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
                  <Download className="h-3.5 w-3.5" /> Download
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel className="text-xs">Export current view</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={downloadSummary} className="text-xs">Summary Analytics (CSV)</DropdownMenuItem>
                <DropdownMenuItem onClick={downloadOverview} className="text-xs">Overview Charts (CSV)</DropdownMenuItem>
                <DropdownMenuItem onClick={downloadGates} className="text-xs">Gate Analysis (CSV)</DropdownMenuItem>
                <DropdownMenuItem onClick={downloadSetups} className="text-xs">All Setups (CSV)</DropdownMenuItem>
                <DropdownMenuItem onClick={downloadAdvisor} className="text-xs">AI Advisor (JSON)</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={downloadAll} className="text-xs font-medium">Download All</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <Select value={symbolFilter} onValueChange={setSymbolFilter}>
            <SelectTrigger className="w-[130px] h-8 text-xs">
              <Filter className="h-3 w-3 mr-1" />
              <SelectValue placeholder="Symbol" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Symbols</SelectItem>
              {symbols.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={outcomeFilter} onValueChange={setOutcomeFilter}>
            <SelectTrigger className="w-[150px] h-8 text-xs">
              <ArrowUpDown className="h-3 w-3 mr-1" />
              <SelectValue placeholder="Outcome" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Outcomes</SelectItem>
              <SelectItem value="would_have_won">Would Have Won</SelectItem>
              <SelectItem value="would_have_lost">Would Have Lost</SelectItem>
              <SelectItem value="inconclusive">Inconclusive</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="border-border/50">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Total Rejected</p>
              <p className="text-2xl font-bold">{stats.total}</p>
            </CardContent>
          </Card>
          <Card className="border-border/50">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Winner-Block Rate</p>
              <p className={`text-2xl font-bold ${stats.winnerBlockRate > 50 ? "text-amber-500" : "text-profit"}`}>
                {stats.winnerBlockRate.toFixed(1)}%
              </p>
              <p className="text-[10px] text-muted-foreground">{stats.winners}/{stats.resolved} resolved</p>
            </CardContent>
          </Card>
          <Card className="border-border/50">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Avg MFE</p>
              <p className="text-2xl font-bold text-profit">+{stats.avgMfe.toFixed(1)}</p>
              <p className="text-[10px] text-muted-foreground">(converted)</p>
            </CardContent>
          </Card>
          <Card className="border-border/50">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Avg MAE</p>
              <p className="text-2xl font-bold text-loss">-{stats.avgMae.toFixed(1)}</p>
              <p className="text-[10px] text-muted-foreground">(converted)</p>
            </CardContent>
          </Card>
          <Card className="border-border/50">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Entry Reached</p>
              <p className="text-2xl font-bold">{stats.entryReachedRate.toFixed(0)}%</p>
              <p className="text-[10px] text-muted-foreground">of resolved</p>
            </CardContent>
          </Card>
        </div>

        {/* Charts */}
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="h-8">
            <TabsTrigger value="overview" className="text-xs h-7">Overview</TabsTrigger>
            <TabsTrigger value="gates" className="text-xs h-7">Gate Analysis</TabsTrigger>
            <TabsTrigger value="advisor" className="text-xs h-7 gap-1">
              <Sparkles className="h-3 w-3" /> Advisor
            </TabsTrigger>
            <TabsTrigger value="table" className="text-xs h-7">All Setups</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-4 mt-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Outcome Distribution Pie */}
              <Card className="border-border/50">
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-sm font-medium">Outcome Distribution</CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-3">
                  {outcomeDistribution.length > 0 ? (
                    <ChartContainer config={{ won: { label: "Won", color: "#22c55e" }, lost: { label: "Lost", color: "#ef4444" }, inconclusive: { label: "Inconclusive", color: "#6b7280" }, pending: { label: "Pending", color: "#f59e0b" } }} className="h-[200px] w-full">
                      <PieChart>
                        <Pie
                          data={outcomeDistribution}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={70}
                          innerRadius={35}
                          strokeWidth={2}
                          stroke={chartTheme.tooltipBg}
                          label={({ name, percent }) => `${name.split(" ").pop()} ${(percent * 100).toFixed(0)}%`}
                          labelLine={false}
                          fontSize={10}
                        >
                          {outcomeDistribution.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Pie>
                        <ChartTooltip content={<ChartTooltipContent hideIndicator />} />
                      </PieChart>
                    </ChartContainer>
                  ) : (
                    <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">No data yet</div>
                  )}
                </CardContent>
              </Card>

              {/* Daily Trend */}
              <Card className="border-border/50">
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-sm font-medium">Daily Rejections & Outcomes</CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-3">
                  {dailyTrend.length > 0 ? (
                    <ChartContainer config={{ total: { label: "Total", color: "#6b7280" }, wouldWon: { label: "Would Won", color: "#22c55e" }, wouldLost: { label: "Would Lost", color: "#ef4444" } }} className="h-[200px] w-full">
                      <AreaChart data={dailyTrend}>
                        <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} opacity={0.5} />
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: chartTheme.axis }} tickFormatter={(v) => v.slice(5)} axisLine={{ stroke: chartTheme.grid }} tickLine={false} />
                        <YAxis tick={{ fontSize: 10, fill: chartTheme.axis }} axisLine={false} tickLine={false} />
                        <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => `Date: ${v}`} />} />
                        <Area type="monotone" dataKey="total" name="Total" stroke="#6b7280" fill="#6b728030" strokeWidth={1.5} />
                        <Area type="monotone" dataKey="wouldWon" name="Would Won" stroke="#22c55e" fill="#22c55e20" strokeWidth={2} />
                        <Area type="monotone" dataKey="wouldLost" name="Would Lost" stroke="#ef4444" fill="#ef444420" strokeWidth={2} />
                      </AreaChart>
                    </ChartContainer>
                  ) : (
                    <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">No data yet</div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Score Distribution */}
            <Card className="border-border/50">
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-sm font-medium">Confluence Score vs Outcome</CardTitle>
              </CardHeader>
              <CardContent className="px-2 pb-3">
                {setups.length > 0 ? (
                  <ChartContainer config={{ won: { label: "Would Have Won", color: "#22c55e" }, lost: { label: "Would Have Lost", color: "#ef4444" } }} className="h-[200px] w-full">
                    <BarChart data={(() => {
                      const buckets = [
                        { range: "30-40", won: 0, lost: 0 },
                        { range: "40-50", won: 0, lost: 0 },
                        { range: "50-60", won: 0, lost: 0 },
                        { range: "60-70", won: 0, lost: 0 },
                        { range: "70-80", won: 0, lost: 0 },
                        { range: "80+", won: 0, lost: 0 },
                      ];
                      for (const s of setups) {
                        const score = s.confluence_score;
                        let idx = score < 40 ? 0 : score < 50 ? 1 : score < 60 ? 2 : score < 70 ? 3 : score < 80 ? 4 : 5;
                        if (s.outcome_status === "would_have_won") buckets[idx].won++;
                        if (s.outcome_status === "would_have_lost") buckets[idx].lost++;
                      }
                      return buckets;
                    })()} barGap={2}>
                      <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} opacity={0.4} vertical={false} />
                      <XAxis dataKey="range" tick={{ fontSize: 10, fill: chartTheme.axis }} axisLine={{ stroke: chartTheme.grid }} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: chartTheme.axis }} axisLine={false} tickLine={false} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="won" name="Would Have Won" fill="#22c55e" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="lost" name="Would Have Lost" fill="#ef4444" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ChartContainer>
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">No data yet</div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Gate Analysis Tab */}
          <TabsContent value="gates" className="space-y-4 mt-3">
            <Card className="border-border/50">
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-sm font-medium">Gate Effectiveness</CardTitle>
                <p className="text-xs text-muted-foreground">Which gates block the most would-have-won setups? High % = gate may be too aggressive.</p>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                {gateBreakdown.length > 0 ? (
                  <div className="space-y-1">
                    {gateBreakdown.map((g) => (
                      <div key={g.gate} className="flex items-center gap-3 py-2 border-b border-border/20 last:border-0">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate" title={g.gate}>{shortenGateLabel(g.gate)}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {g.total} blocked · <span className="text-profit">{g.wouldWon} won</span> · <span className="text-loss">{g.wouldLost} lost</span>
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="w-24 h-2.5 bg-muted/50 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{
                                width: `${g.winRate}%`,
                                backgroundColor: g.winRate > 50 ? "hsl(var(--warn))" : "hsl(var(--profit))",
                              }}
                            />
                          </div>
                          <span className={`text-xs font-mono w-12 text-right ${g.winRate > 50 ? "text-warn" : "text-profit"}`}>
                            {g.winRate.toFixed(0)}% WR
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="py-8 text-center text-sm text-muted-foreground">No gate data available</div>
                )}
              </CardContent>
            </Card>

            {/* Gate chart */}
            {gateBreakdown.length > 0 && (
              <Card className="border-border/50">
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-sm font-medium">Gates by Block Count</CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-3">
                  <ChartContainer config={{ wouldWon: { label: "Would Won", color: "#22c55e" }, wouldLost: { label: "Would Lost", color: "#ef4444" } }} className="w-full" style={{ height: `${Math.max(180, gateBreakdown.slice(0, 10).length * 40)}px` }}>
                    <BarChart data={gateBreakdown.slice(0, 10).map(g => ({ ...g, gate: shortenGateLabel(g.gate) }))} layout="vertical" margin={{ left: 10, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} opacity={0.3} horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10, fill: chartTheme.axis }} axisLine={false} tickLine={false} />
                      <YAxis dataKey="gate" type="category" tick={{ fontSize: 10, fill: chartTheme.axis }} width={120} axisLine={false} tickLine={false} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="wouldWon" name="Would Won" fill="#22c55e" stackId="a" radius={[0, 0, 0, 0]} />
                      <Bar dataKey="wouldLost" name="Would Lost" fill="#ef4444" stackId="a" radius={[0, 3, 3, 0]} />
                    </BarChart>
                  </ChartContainer>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Table Tab */}
          {/* Strategy Advisor Tab */}
          <TabsContent value="advisor" className="mt-3">
            <StrategyAdvisor days={days} />
          </TabsContent>

          <TabsContent value="table" className="mt-3">
            <Card className="border-border/50">
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="py-12 text-center text-sm text-muted-foreground">Loading...</div>
                ) : setups.length === 0 ? (
                  <div className="py-12 text-center text-sm text-muted-foreground">No rejected setups in this period</div>
                ) : isMobile ? (
                  /* Mobile: stacked cards */
                  <div className="divide-y divide-border/30">
                    {setups.slice(0, 50).map((s) => (
                      <div key={s.id} className="p-3 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium">{s.symbol}</span>
                            <Badge variant="outline" className={`text-[10px] px-1 py-0 ${s.direction === "long" ? "text-profit border-emerald-500/30" : "text-loss border-destructive/30"}`}>
                              {s.direction.toUpperCase()}
                            </Badge>
                          </div>
                          <OutcomeBadge status={s.outcome_status} />
                        </div>
                        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                          <span>{formatBrokerTime(s.rejected_at)}</span>
                          <span>Score: {s.confluence_score.toFixed(1)}</span>
                          <span>T1: {s.tier1_count}</span>
                        </div>
                        {s.failed_gates && s.failed_gates.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {s.failed_gates.slice(0, 3).map((g, i) => (
                              <Badge key={i} variant="secondary" className="text-[9px] px-1 py-0">{g}</Badge>
                            ))}
                            {s.failed_gates.length > 3 && <Badge variant="secondary" className="text-[9px] px-1 py-0">+{s.failed_gates.length - 3}</Badge>}
                          </div>
                        )}
                        {(s.mfe_pips !== null || s.mae_pips !== null) && (
                          <div className="flex gap-3 text-[10px]">
                            {s.mfe_pips !== null && <span className="text-profit">MFE: {formatPipDisplay(s.mfe_pips, s.symbol)}</span>}
                            {s.mae_pips !== null && <span className="text-loss">MAE: {formatPipDisplay(-s.mae_pips, s.symbol)}</span>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  /* Desktop: table */
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border/50 bg-muted/30">
                          <th className="text-left px-3 py-2 font-medium">Time</th>
                          <th className="text-left px-3 py-2 font-medium">Symbol</th>
                          <th className="text-left px-3 py-2 font-medium">Dir</th>
                          <th className="text-left px-3 py-2 font-medium">Type</th>
                          <th className="text-left px-3 py-2 font-medium">Score</th>
                          <th className="text-left px-3 py-2 font-medium">T1</th>
                          <th className="text-left px-3 py-2 font-medium">Failed Gates</th>
                          <th className="text-left px-3 py-2 font-medium">RR</th>
                          <th className="text-left px-3 py-2 font-medium">MFE</th>
                          <th className="text-left px-3 py-2 font-medium">MAE</th>
                          <th className="text-left px-3 py-2 font-medium">Outcome</th>
                        </tr>
                      </thead>
                      <tbody>
                        {setups.slice(0, 100).map((s) => (
                          <React.Fragment key={s.id}>
                            <tr 
                              className={`border-b border-border/20 hover:bg-muted/20 cursor-pointer transition-colors ${expandedRow === s.id ? 'bg-muted/30' : ''}`}
                              onClick={() => setExpandedRow(expandedRow === s.id ? null : s.id)}
                            >
                              <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatBrokerTime(s.rejected_at)}</td>
                              <td className="px-3 py-2 font-medium">{s.symbol}</td>
                              <td className="px-3 py-2">
                                <span className={s.direction === "long" ? "text-profit" : "text-loss"}>
                                  {s.direction === "long" ? "▲" : "▼"} {s.direction.toUpperCase()}
                                </span>
                              </td>
                              <td className="px-3 py-2">{REJECTION_TYPE_LABELS[s.rejection_type] || s.rejection_type}</td>
                              <td className="px-3 py-2 font-mono">{s.confluence_score.toFixed(1)}</td>
                              <td className="px-3 py-2">{s.tier1_count}</td>
                              <td className="px-3 py-2 max-w-[200px]">
                                <div className="flex flex-wrap gap-0.5">
                                  {(s.failed_gates || []).slice(0, 2).map((g, i) => (
                                    <Badge key={i} variant="secondary" className="text-[9px] px-1 py-0">{g}</Badge>
                                  ))}
                                  {(s.failed_gates || []).length > 2 && <Badge variant="secondary" className="text-[9px] px-1 py-0">+{(s.failed_gates || []).length - 2}</Badge>}
                                </div>
                              </td>
                              <td className="px-3 py-2 font-mono">{s.rr_ratio ? s.rr_ratio.toFixed(1) : "—"}</td>
                              <td className="px-3 py-2 font-mono text-profit">{formatPipDisplay(s.mfe_pips, s.symbol)}</td>
                              <td className="px-3 py-2 font-mono text-loss">{formatPipDisplay(s.mae_pips !== null ? -s.mae_pips : null, s.symbol)}</td>
                              <td className="px-3 py-2"><OutcomeBadge status={s.outcome_status} /></td>
                            </tr>
                            {expandedRow === s.id && (
                              <tr>
                                <td colSpan={11} className="px-3 py-0">
                                  <TradeDetailCard
                                    symbol={s.symbol}
                                    direction={s.direction}
                                    entryPrice={s.entry_price}
                                    stopLoss={s.stop_loss}
                                    takeProfit={s.take_profit}
                                    mfePips={s.mfe_pips}
                                    maePips={s.mae_pips}
                                    rrRatio={s.rr_ratio}
                                    outcomeStatus={s.outcome_status}
                                    tpHit={s.tp_hit}
                                    slHit={s.sl_hit}
                                    tpHitTimeMinutes={s.tp_hit_time_minutes}
                                    priceReachedEntry={s.price_reached_entry}
                                    confluenceScore={s.confluence_score}
                                    tier1Count={s.tier1_count}
                                    failedGates={s.failed_gates}
                                    sessionName={s.session_name}
                                    regime={s.regime}
                                  />
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}

// ── Sub-components ──
function OutcomeBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    would_have_won: { label: "Won ✓", className: "bg-emerald-500/10 text-profit border-emerald-500/30" },
    would_have_lost: { label: "Lost ✗", className: "bg-destructive/10 text-loss border-destructive/30" },
    inconclusive: { label: "Inconclusive", className: "bg-muted text-muted-foreground border-border/50" },
    pending: { label: "Pending", className: "bg-amber-500/10 text-amber-500 border-amber-500/30" },
  };
  const c = config[status] || config.pending;
  return <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${c.className}`}>{c.label}</Badge>;
}
