import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { formatBrokerTime } from "@/lib/formatTime";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line, Area, AreaChart,
} from "recharts";
import {
  ShieldX, ShieldCheck, TrendingUp, TrendingDown, Target, AlertTriangle,
  RefreshCw, Filter, ArrowUpDown,
} from "lucide-react";

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
  const avgMfe = resolved.length > 0 ? resolved.reduce((sum, s) => sum + (s.mfe_pips || 0), 0) / resolved.length : 0;
  const avgMae = resolved.length > 0 ? resolved.reduce((sum, s) => sum + (s.mae_pips || 0), 0) / resolved.length : 0;
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

// ── Component ──
export default function RejectedSetups() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [days, setDays] = useState(7);
  const [symbolFilter, setSymbolFilter] = useState<string>("all");
  const [outcomeFilter, setOutcomeFilter] = useState<string>("all");

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
              <p className="text-[10px] text-muted-foreground">pips</p>
            </CardContent>
          </Card>
          <Card className="border-border/50">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Avg MAE</p>
              <p className="text-2xl font-bold text-loss">-{stats.avgMae.toFixed(1)}</p>
              <p className="text-[10px] text-muted-foreground">pips</p>
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
                    <ResponsiveContainer width="100%" height={200}>
                      <PieChart>
                        <Pie data={outcomeDistribution} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name, percent }) => `${name.split(" ").pop()} ${(percent * 100).toFixed(0)}%`} labelLine={false} fontSize={10}>
                          {outcomeDistribution.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
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
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={dailyTrend}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v) => v.slice(5)} />
                        <YAxis tick={{ fontSize: 10 }} />
                        <Tooltip labelFormatter={(v) => `Date: ${v}`} />
                        <Area type="monotone" dataKey="total" name="Total" stroke="#6b7280" fill="#6b728020" />
                        <Area type="monotone" dataKey="wouldWon" name="Would Won" stroke="#22c55e" fill="#22c55e20" />
                        <Area type="monotone" dataKey="wouldLost" name="Would Lost" stroke="#ef4444" fill="#ef444420" />
                      </AreaChart>
                    </ResponsiveContainer>
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
                  <ResponsiveContainer width="100%" height={180}>
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
                    })()}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="range" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} />
                      <Tooltip />
                      <Bar dataKey="won" name="Would Have Won" fill="#22c55e" radius={[2, 2, 0, 0]} />
                      <Bar dataKey="lost" name="Would Have Lost" fill="#ef4444" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[180px] flex items-center justify-center text-sm text-muted-foreground">No data yet</div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Gate Analysis Tab */}
          <TabsContent value="gates" className="space-y-4 mt-3">
            <Card className="border-border/50">
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-sm font-medium">Gate Effectiveness Breakdown</CardTitle>
                <p className="text-xs text-muted-foreground">Which gates are blocking the most would-have-won setups?</p>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                {gateBreakdown.length > 0 ? (
                  <div className="space-y-2">
                    {gateBreakdown.map((g) => (
                      <div key={g.gate} className="flex items-center gap-3 py-1.5 border-b border-border/30 last:border-0">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate">{g.gate}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {g.total} blocked · {g.wouldWon} would have won · {g.wouldLost} would have lost
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="w-20 h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${g.winRate}%`,
                                backgroundColor: g.winRate > 50 ? "#f59e0b" : "#22c55e",
                              }}
                            />
                          </div>
                          <span className={`text-xs font-mono w-10 text-right ${g.winRate > 50 ? "text-amber-500" : "text-muted-foreground"}`}>
                            {g.winRate.toFixed(0)}%
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
                  <ResponsiveContainer width="100%" height={Math.max(150, gateBreakdown.length * 30)}>
                    <BarChart data={gateBreakdown.slice(0, 10)} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis type="number" tick={{ fontSize: 10 }} />
                      <YAxis dataKey="gate" type="category" tick={{ fontSize: 9 }} width={140} />
                      <Tooltip />
                      <Bar dataKey="wouldWon" name="Would Won" fill="#22c55e" stackId="a" radius={[0, 0, 0, 0]} />
                      <Bar dataKey="wouldLost" name="Would Lost" fill="#ef4444" stackId="a" radius={[0, 2, 2, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Table Tab */}
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
                            <Badge variant="outline" className={`text-[10px] px-1 py-0 ${s.direction === "long" ? "text-profit border-emerald-500/30" : "text-loss border-red-500/30"}`}>
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
                            {s.mfe_pips !== null && <span className="text-profit">MFE: +{s.mfe_pips.toFixed(1)}</span>}
                            {s.mae_pips !== null && <span className="text-loss">MAE: -{s.mae_pips.toFixed(1)}</span>}
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
                          <tr key={s.id} className="border-b border-border/20 hover:bg-muted/20">
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
                            <td className="px-3 py-2 font-mono text-profit">{s.mfe_pips !== null ? `+${s.mfe_pips.toFixed(1)}` : "—"}</td>
                            <td className="px-3 py-2 font-mono text-loss">{s.mae_pips !== null ? `-${s.mae_pips.toFixed(1)}` : "—"}</td>
                            <td className="px-3 py-2"><OutcomeBadge status={s.outcome_status} /></td>
                          </tr>
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
    would_have_lost: { label: "Lost ✗", className: "bg-red-500/10 text-loss border-red-500/30" },
    inconclusive: { label: "Inconclusive", className: "bg-muted text-muted-foreground border-border/50" },
    pending: { label: "Pending", className: "bg-amber-500/10 text-amber-500 border-amber-500/30" },
  };
  const c = config[status] || config.pending;
  return <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${c.className}`}>{c.label}</Badge>;
}
