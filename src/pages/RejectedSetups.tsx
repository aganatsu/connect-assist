import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { botConfigApi } from "@/lib/api";
import { formatPipDisplay, rawPipsToDisplay, getPipLabel } from "@/lib/pipDisplay";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTheme } from "@/contexts/ThemeContext";
import { getChartTheme } from "@/lib/chartTheme";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  PieChart, Pie, Cell, Area, AreaChart,
} from "recharts";
import {
  RefreshCw, Filter, ArrowUpDown, Sparkles, Download,
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { RecommendationsDashboard } from "@/components/RecommendationsDashboard";
import { TradeDetailCard } from "@/components/TradeDetailCard";
import {
  collapseRejectedOpportunities,
  normalizeRejectedGate,
  normalizedGateLabel,
} from "@/lib/rejectedSetupAnalytics";
import {
  buildShadowEvidenceReport,
  type ClosedTradeShadowEvidenceRecord,
  type ShadowEvidenceBreakdown,
  type ShadowFeatureEvidenceSummary,
} from "@/lib/shadowEvidenceAnalytics";
import {
  getStrategyActivationDisplay,
  type StrategyActivationRecord,
} from "@/lib/strategyActivation";
import {
  shortCertificateHash,
  reviewStrategyEvidence,
  STRATEGY_EVIDENCE_STATUS,
  type StrategyEvidenceCertificateRecord,
} from "@/lib/strategyEvidenceCertificate";

// ── Types ──
interface ShadowAudit {
  decision?: string;
  riskBand?: string;
  reasons?: string[];
  currentSystem?: {
    decision?: string;
    reason?: string | null;
  };
}

interface RejectedSetup {
  id: string;
  symbol: string;
  direction: string;
  rejection_type: string;
  failed_gates: string[] | null;
  normalized_gates?: string[] | null;
  opportunity_key?: string | null;
  shadow_decision?: ShadowAudit | null;
  raw_detail?: {
    gamePlanShadowAudit?: ShadowAudit | null;
    [key: string]: unknown;
  } | null;
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

interface ZoneLocalValidationSummary {
  user_id: string;
  bot_id: string;
  trading_style: string;
  symbol: string;
  observed_scans: number;
  disagreement_scans: number;
  resolved_candidates: number;
  legacy_disagreement_samples: number;
  shadow_disagreement_samples: number;
  legacy_disagreement_win_rate: number | null;
  shadow_disagreement_win_rate: number | null;
  shadow_winner_avg_mfe_pips: number | null;
  shadow_winner_avg_mae_pips: number | null;
  minimum_sample_ready: boolean;
  enforcement: "observe_only";
  evidence_source: "forward_observation" | "retrospective_replay";
  activation_eligible: boolean;
  replay_runs: number;
  cross_tf_disagreement_scans: number;
  cross_tf_resolved_legacy_trades: number;
  winners_retained: number;
  losers_avoided: number;
  missed_opportunities: number;
  false_positives: number;
  legacy_expectancy_r: number | null;
  cross_tf_expectancy_r: number | null;
  cross_tf_expectancy_delta_r: number | null;
  cross_tf_avg_mfe_pips: number | null;
  cross_tf_avg_mae_pips: number | null;
  cross_tf_minimum_sample_ready: boolean;
  cross_tf_enforcement: "observe_only";
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

function getShadowAudit(setup: RejectedSetup): ShadowAudit | null {
  return setup.shadow_decision || setup.raw_detail?.gamePlanShadowAudit || null;
}

function getDisplayGates(setup: RejectedSetup): string[] {
  const codes = setup.normalized_gates?.length
    ? setup.normalized_gates
    : (setup.failed_gates || []).map(normalizeRejectedGate);
  return [...new Set(codes)].map(normalizedGateLabel);
}

// ── Data Fetching ──
async function fetchRejectedSetups(userId: string, days: number): Promise<RejectedSetup[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const pageSize = 1000;
  const rows: RejectedSetup[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await (supabase as any)
      .from("rejected_setups")
      .select("*")
      .eq("user_id", userId)
      .gte("rejected_at", since)
      .order("rejected_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function fetchClosedTradeEvidence(
  userId: string,
  days: number,
): Promise<ClosedTradeShadowEvidenceRecord[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const pageSize = 1000;
  const rows: ClosedTradeShadowEvidenceRecord[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("paper_trade_history")
      .select("id, position_id, symbol, pnl, signal_score, signal_reason, close_reason, closed_at")
      .eq("user_id", userId)
      .gte("closed_at", since)
      .order("closed_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function fetchStrategyActivations(
  userId: string,
): Promise<StrategyActivationRecord[]> {
  const { data, error } = await supabase
    .from("strategy_activation_registry")
    .select(
      "feature_key, variant_key, authority_stage, runtime_scope, runtime_enforced, revision, transition_reason, evidence_hash, updated_at",
    )
    .eq("user_id", userId)
    .eq("bot_id", "smc");
  if (error) throw new Error(error.message);
  return (data || []) as unknown as StrategyActivationRecord[];
}

async function fetchStrategyEvidenceCertificates(
  userId: string,
): Promise<StrategyEvidenceCertificateRecord[]> {
  const { data, error } = await supabase
    .from("strategy_evidence_certificates")
    .select(
      "feature_key, variant_key, status, certificate_hash, resolved_count, changed_count, coverage_percent, beneficial_rate_percent, expectancy_delta_r, max_drawdown_delta_percent, good_trade_retention_percent, out_of_sample_passed, walk_forward_consistent, source_window_start, source_window_end, generated_at, is_current",
    )
    .eq("user_id", userId)
    .eq("bot_id", "smc")
    .eq("is_current", true);
  if (error) throw new Error(error.message);
  return (data || []) as unknown as StrategyEvidenceCertificateRecord[];
}

async function fetchZoneLocalValidation(
  userId: string,
): Promise<ZoneLocalValidationSummary[]> {
  // Generated Supabase types intentionally lag additive migrations.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("zone_candidate_shadow_validation_summary")
    .select(
      "user_id, bot_id, trading_style, symbol, observed_scans, disagreement_scans, resolved_candidates, legacy_disagreement_samples, shadow_disagreement_samples, legacy_disagreement_win_rate, shadow_disagreement_win_rate, shadow_winner_avg_mfe_pips, shadow_winner_avg_mae_pips, minimum_sample_ready, enforcement, evidence_source, activation_eligible, replay_runs, cross_tf_disagreement_scans, cross_tf_resolved_legacy_trades, winners_retained, losers_avoided, missed_opportunities, false_positives, legacy_expectancy_r, cross_tf_expectancy_r, cross_tf_expectancy_delta_r, cross_tf_avg_mfe_pips, cross_tf_avg_mae_pips, cross_tf_minimum_sample_ready, cross_tf_enforcement",
    )
    .eq("user_id", userId)
    .eq("bot_id", "smc")
    .order("resolved_candidates", { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []) as ZoneLocalValidationSummary[];
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
    const gates = s.normalized_gates?.length
      ? s.normalized_gates
      : (s.failed_gates || []).map(normalizeRejectedGate);
    for (const gateCode of new Set(gates)) {
      const entry = gateMap.get(gateCode) || { total: 0, wouldWon: 0, wouldLost: 0 };
      entry.total++;
      if (s.outcome_status === "would_have_won") entry.wouldWon++;
      if (s.outcome_status === "would_have_lost") entry.wouldLost++;
      gateMap.set(gateCode, entry);
    }
  }
  return Array.from(gateMap.entries())
    .map(([gateCode, stats]) => {
      const resolved = stats.wouldWon + stats.wouldLost;
      return {
        gateCode,
        gate: normalizedGateLabel(gateCode),
        ...stats,
        winRate: resolved > 0 ? (stats.wouldWon / resolved) * 100 : 0,
      };
    })
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
  const [isGeneratingCertificate, setIsGeneratingCertificate] = useState(false);

  const { data: rawSetups = [], isLoading, refetch } = useQuery({
    queryKey: ["rejected-setups", user?.id, days],
    queryFn: () => fetchRejectedSetups(user!.id, days),
    enabled: !!user?.id,
    refetchInterval: 60_000,
  });
  const { data: singleOwnershipComparison, isLoading: isLoadingSingleOwnership } = useQuery({
    queryKey: ["single-ownership-comparison"],
    queryFn: () => botConfigApi.getSingleOwnershipComparison(),
    staleTime: 60_000, retry: false,
  });
  const {
    data: streamlinedDecisionComparison,
    isLoading: isLoadingStreamlinedDecisionComparison,
  } = useQuery({
    queryKey: ["streamlined-decision-comparison"],
    queryFn: () => botConfigApi.getStreamlinedDecisionComparison(),
    staleTime: 60_000,
    retry: false,
  });
  const {
    data: dealingRangeComparison,
    isLoading: isLoadingDealingRangeComparison,
    refetch: refetchDealingRangeComparison,
  } = useQuery({
    queryKey: ["canonical-dealing-range-comparison"],
    queryFn: () => botConfigApi.getDealingRangeComparison(),
    staleTime: 60_000,
    retry: false,
  });
  const {
    data: closedTradeEvidence = [],
    isLoading: isLoadingClosedTrades,
    refetch: refetchClosedTrades,
  } = useQuery({
    queryKey: ["shadow-evidence-closed-trades", user?.id, days],
    queryFn: () => fetchClosedTradeEvidence(user!.id, days),
    enabled: !!user?.id,
    refetchInterval: 60_000,
  });
  const {
    data: strategyActivations = [],
    isLoading: isLoadingStrategyActivations,
  } = useQuery({
    queryKey: ["strategy-activation-registry", user?.id],
    queryFn: () => fetchStrategyActivations(user!.id),
    enabled: !!user?.id,
    refetchInterval: 60_000,
  });
  const {
    data: strategyEvidenceCertificates = [],
    isLoading: isLoadingStrategyEvidenceCertificates,
    refetch: refetchStrategyEvidenceCertificates,
  } = useQuery({
    queryKey: ["strategy-evidence-certificates", user?.id],
    queryFn: () => fetchStrategyEvidenceCertificates(user!.id),
    enabled: !!user?.id,
    refetchInterval: 60_000,
  });
  const {
    data: zoneLocalValidation = [],
    isLoading: isLoadingZoneLocalValidation,
  } = useQuery({
    queryKey: ["zone-local-validation", user?.id],
    queryFn: () => fetchZoneLocalValidation(user!.id),
    enabled: !!user?.id,
    refetchInterval: 60_000,
  });

  // Collapse repeated scanner observations before applying outcome filters so
  // analytics measure distinct market opportunities instead of scan frequency.
  const filteredRawSetups = useMemo(
    () => symbolFilter === "all"
      ? rawSetups
      : rawSetups.filter((setup) => setup.symbol === symbolFilter),
    [rawSetups, symbolFilter],
  );
  const opportunities = useMemo(
    () => collapseRejectedOpportunities(filteredRawSetups),
    [filteredRawSetups],
  );
  const setups = useMemo(
    () => outcomeFilter === "all"
      ? opportunities
      : opportunities.filter((setup) => setup.outcome_status === outcomeFilter),
    [opportunities, outcomeFilter],
  );
  const displayedScanCount = useMemo(
    () => setups.reduce((total, setup) => total + setup.occurrence_count, 0),
    [setups],
  );
  const filteredClosedTradeEvidence = useMemo(
    () => symbolFilter === "all"
      ? closedTradeEvidence
      : closedTradeEvidence.filter((trade) => trade.symbol === symbolFilter),
    [closedTradeEvidence, symbolFilter],
  );
  const shadowEvidenceReport = useMemo(
    () => buildShadowEvidenceReport(opportunities, filteredClosedTradeEvidence),
    [opportunities, filteredClosedTradeEvidence],
  );
  const activationByFeature = useMemo(
    () => new Map(
      strategyActivations.map((record) => [record.feature_key, record]),
    ),
    [strategyActivations],
  );
  const certificateByFeature = useMemo(
    () => new Map(
      strategyEvidenceCertificates.map((record) => [
        record.feature_key,
        record,
      ]),
    ),
    [strategyEvidenceCertificates],
  );
  const shadowEvidenceReviews = useMemo(() => [
    { summary: shadowEvidenceReport.gameplanHierarchy, certificate: certificateByFeature.get("gameplan_hierarchy") },
    { summary: shadowEvidenceReport.thesisConviction, certificate: certificateByFeature.get("thesis_conviction") },
  ].map((item) => ({ ...item, review: reviewStrategyEvidence(item.certificate) })), [certificateByFeature, shadowEvidenceReport]);
  const filteredZoneLocalValidation = useMemo(
    () => symbolFilter === "all"
      ? zoneLocalValidation
      : zoneLocalValidation.filter((row) => row.symbol === symbolFilter),
    [symbolFilter, zoneLocalValidation],
  );

  const generateStrategyEvidenceCertificate = async () => {
    setIsGeneratingCertificate(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        "strategy-evidence-certifier",
        { body: { bot_id: "smc", days } },
      );
      if (error) throw error;
      if (!data?.success) {
        throw new Error(data?.error || "Certificate generation failed");
      }
      await refetchStrategyEvidenceCertificates();
      toast.success(
        `Trusted ${days}-day evidence certificates generated. Runtime remains unchanged.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Evidence certificate failed: ${message}`);
    } finally {
      setIsGeneratingCertificate(false);
    }
  };

  const symbols = useMemo(
    () => [...new Set([
      ...rawSetups.map((setup) => setup.symbol),
      ...closedTradeEvidence.map((trade) => trade.symbol),
      ...zoneLocalValidation.map((row) => row.symbol),
    ])].sort(),
    [rawSetups, closedTradeEvidence, zoneLocalValidation],
  );
  const stats = useMemo(() => computeStats(setups), [setups]);
  const gateBreakdown = useMemo(() => computeGateBreakdown(setups), [setups]);
  const dailyTrend = useMemo(() => computeDailyTrend(setups), [setups]);

  // ── Download handlers ──
  const downloadSummary = () => {
    const rows = [
      { metric: "Range (days)", value: days },
      { metric: "Symbol Filter", value: symbolFilter },
      { metric: "Outcome Filter", value: outcomeFilter },
      { metric: "Distinct Opportunities", value: stats.total },
      { metric: "Scanner Observations", value: displayedScanCount },
      { metric: "Repeated Observations Collapsed", value: displayedScanCount - setups.length },
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
      gate_code: g.gateCode,
      gate: g.gate,
      total_blocked: g.total,
      would_won: g.wouldWon,
      would_lost: g.wouldLost,
      winner_block_rate_pct: g.winRate.toFixed(2),
    }));
    downloadFile(`rejected-gates-${tsStamp()}.csv`, toCSV(rows), "text/csv");
  };

  const downloadSetups = () => {
    const rows = setups.map((s) => ({
      rejected_at: s.rejected_at,
      first_seen_at: s.first_seen_at,
      last_seen_at: s.last_seen_at,
      scanner_observations: s.occurrence_count,
      symbol: s.symbol,
      direction: s.direction,
      rejection_type: s.rejection_type,
      confluence_score: s.confluence_score,
      tier1_count: s.tier1_count,
      tier1_factors: s.tier1_factors,
      failed_gates: s.failed_gates,
      normalized_gates: s.normalized_gates,
      current_decision: getShadowAudit(s)?.currentSystem?.decision,
      current_reason: getShadowAudit(s)?.currentSystem?.reason,
      shadow_decision: getShadowAudit(s)?.decision,
      shadow_risk_band: getShadowAudit(s)?.riskBand,
      shadow_reasons: getShadowAudit(s)?.reasons,
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
      mixed_outcome: s.mixed_outcome,
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

  const downloadShadowEvidence = () => {
    const summaries = [
      shadowEvidenceReport.gameplanHierarchy,
      shadowEvidenceReport.thesisConviction,
    ];
    const rows = summaries.flatMap((summary) => [
      {
        section: "summary",
        feature: summary.label,
        status: summary.status,
        total_candidates: summary.totalCandidates,
        evidence_count: summary.evidenceCount,
        coverage_pct: summary.coveragePercent.toFixed(2),
        resolved: summary.resolved,
        changed: summary.changed,
        beneficial: summary.beneficial,
        harmful: summary.harmful,
        beneficial_rate_pct: summary.beneficialRate?.toFixed(2) ?? "",
        rescued_winners: summary.rescuedWinners,
        avoided_losses: summary.avoidedLosses,
        admitted_losses: summary.admittedLosses,
        blocked_winners: summary.blockedWinners,
      },
      ...summary.byStyle.map((row) => ({
        section: "style",
        feature: summary.label,
        key: row.key,
        resolved: row.resolved,
        changed: row.changed,
        beneficial: row.beneficial,
        harmful: row.harmful,
        beneficial_rate_pct: row.beneficialRate?.toFixed(2) ?? "",
      })),
      ...summary.byPair.map((row) => ({
        section: "pair",
        feature: summary.label,
        key: row.key,
        resolved: row.resolved,
        changed: row.changed,
        beneficial: row.beneficial,
        harmful: row.harmful,
        beneficial_rate_pct: row.beneficialRate?.toFixed(2) ?? "",
      })),
    ]);
    downloadFile(`shadow-evidence-${tsStamp()}.csv`, toCSV(rows), "text/csv");
  };

  const downloadAll = () => {
    downloadSummary();
    downloadOverview();
    downloadGates();
    downloadSetups();
    downloadShadowEvidence();
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
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-foreground">Rejected Setups Analytics</h1>
              <Badge variant="outline" className="text-[9px] border-info-c/40 text-info-c">
                MONITORING
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Counterfactual outcomes of blocked setups. This page measures what happened afterward; it never reopens or executes a trade.
            </p>
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                refetch();
                refetchClosedTrades();
                refetchDealingRangeComparison();
              }}
              className="h-8 w-8 p-0"
            >
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
                <DropdownMenuItem onClick={downloadShadowEvidence} className="text-xs">Shadow Evidence (CSV)</DropdownMenuItem>
                <DropdownMenuItem onClick={downloadSetups} className="text-xs">Distinct Opportunities (CSV)</DropdownMenuItem>
                <DropdownMenuItem onClick={downloadAdvisor} className="text-xs">Advisor (JSON)</DropdownMenuItem>
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
              <p className="text-xs text-muted-foreground">Distinct Opportunities</p>
              <p className="text-2xl font-bold">{stats.total}</p>
              <p className="text-[10px] text-muted-foreground">
                {displayedScanCount} scans · {displayedScanCount - setups.length} repeats removed
              </p>
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
            <TabsTrigger value="shadow" className="text-xs h-7">Shadow Evidence</TabsTrigger>
            <TabsTrigger value="advisor" className="text-xs h-7 gap-1">
              <Sparkles className="h-3 w-3" /> Advisor
            </TabsTrigger>
            <TabsTrigger value="table" className="text-xs h-7">Opportunities</TabsTrigger>
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
                  <CardTitle className="text-sm font-medium">Daily Opportunities & Outcomes</CardTitle>
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
                        const idx = score < 40 ? 0 : score < 50 ? 1 : score < 60 ? 2 : score < 70 ? 3 : score < 80 ? 4 : 5;
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
                <p className="text-xs text-muted-foreground">Distinct opportunities by normalized gate. High winner-block % may indicate an overly aggressive gate.</p>
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
                            {g.winRate.toFixed(0)}% WB
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

          {/* Shadow Evidence Tab */}
          <TabsContent value="shadow" className="space-y-4 mt-3">
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold text-foreground">
                      Observation only — no execution impact
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      Compares the feature&apos;s proposed decision with the actual system decision across distinct rejected opportunities and completed trades.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[9px] border-primary/40 text-primary">
                      {shadowEvidenceReport.totalCandidates} CANDIDATES
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px]"
                      disabled={isGeneratingCertificate}
                      onClick={generateStrategyEvidenceCertificate}
                    >
                      <RefreshCw className={`h-3 w-3 mr-1 ${isGeneratingCertificate ? "animate-spin" : ""}`} />
                      {isGeneratingCertificate ? "Certifying…" : `Certify ${days} days`}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border/50">
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-sm font-medium">Evidence Review: What Happens Next</CardTitle>
                <p className="text-[10px] text-muted-foreground mt-1">Trusted certificates convert completed Shadow Evidence into an action recommendation. No recommendation changes trade execution.</p>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-2">
                {shadowEvidenceReviews.map(({ summary, certificate, review }) => (
                  <div key={summary.feature} className="grid grid-cols-1 md:grid-cols-[180px_160px_1fr] gap-2 rounded border border-border/50 p-3 items-start">
                    <div>
                      <p className="text-xs font-semibold">{summary.label}</p>
                      <p className="text-[9px] text-muted-foreground">{certificate ? certificate.resolved_count + " resolved · " + certificate.changed_count + " changed" : "Not certified"}</p>
                    </div>
                    <Badge variant="outline" className={"w-fit text-[9px] " + (review.action === "promote_log_only" ? "border-success/40 text-success" : review.action === "remove_candidate" ? "border-destructive/40 text-destructive" : "border-warning/40 text-warning")}>
                      {review.label}
                    </Badge>
                    <p className="text-[10px] leading-relaxed text-muted-foreground">{review.reason}</p>
                  </div>
                ))}
                <p className="text-[9px] text-muted-foreground">Promotion means Log-only review first. It does not mean soft adjustment, hard blocking, paper execution, or live execution.</p>
              </CardContent>
            </Card>

            <Card className="border-border/50">
              <CardHeader className="pb-2 pt-3 px-4"><div className="flex flex-wrap items-center justify-between gap-2"><div>
                <CardTitle className="text-sm font-medium">Trade Decision Comparison</CardTitle>
                <p className="text-[10px] text-muted-foreground mt-1">ICT setup decisions compared with legacy scores and filters.</p>
              </div><Badge variant="outline" className="text-[9px]">{isLoadingSingleOwnership ? "Loading" : <>{singleOwnershipComparison?.summary.comparable ?? 0}/{singleOwnershipComparison?.summary.sampleSize ?? 0} comparable</>}</Badge></div></CardHeader>
              <CardContent className="px-4 pb-4">
                {singleOwnershipComparison ? <div className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 text-xs">
                    <div><span className="text-muted-foreground">Coverage</span><p className="font-mono font-bold">{singleOwnershipComparison.summary.coveragePercent.toFixed(1)}%</p></div>
                    <div><span className="text-muted-foreground">Disagreements</span><p className="font-mono font-bold">{singleOwnershipComparison.summary.disagreements}</p></div>
                    <div><span className="text-muted-foreground">Winners preserved</span><p className="font-mono font-bold text-success">{singleOwnershipComparison.summary.winnersPreserved}</p></div>
                    <div><span className="text-muted-foreground">Poor entries rejected</span><p className="font-mono font-bold text-success">{singleOwnershipComparison.summary.poorEntriesRejected}</p></div>
                  </div>
                  {singleOwnershipComparison.rows.filter(row => row.decisionsMatch === false).slice(0, 10).map(row => <div key={["ownership", row.source, row.id].join(":")} className="border-l-2 border-warning pl-3 text-xs">
                    <span className="font-mono">{row.symbol} {row.direction.toUpperCase()} · legacy {row.legacyDecision} · owned {row.proposedDecision}</span>
                    <p className="text-muted-foreground mt-0.5">{row.reasonCodes.join(", ") || "ICT setup rules allow this setup without legacy score ownership"}</p>
                  </div>)}
                </div> : <div className="py-8 text-center text-sm text-muted-foreground">Trade decision comparison is unavailable.</div>}
              </CardContent>
            </Card>

            <Card className="border-border/50">
              <CardHeader className="pb-2 pt-3 px-4"><div className="flex flex-wrap items-center justify-between gap-2"><div>
                <CardTitle className="text-sm font-medium">Decision Research Comparison</CardTitle>
                <p className="text-[10px] text-muted-foreground mt-1">Point-in-time legacy decisions compared with the four-pillar observation.</p>
              </div><Badge variant="outline" className="text-[9px]">{isLoadingStreamlinedDecisionComparison ? "Loading" : <>{streamlinedDecisionComparison?.summary.comparable ?? 0}/{streamlinedDecisionComparison?.summary.sampleSize ?? 0} comparable</>}</Badge></div></CardHeader>
              <CardContent className="px-4 pb-4">
                {streamlinedDecisionComparison ? <div className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 text-xs">
                    <div><span className="text-muted-foreground">Coverage</span><p className="font-mono font-bold">{streamlinedDecisionComparison.summary.coveragePercent.toFixed(1)}%</p></div>
                    <div><span className="text-muted-foreground">Agreements</span><p className="font-mono font-bold">{streamlinedDecisionComparison.summary.agreements}</p></div>
                    <div><span className="text-muted-foreground">Winners preserved</span><p className="font-mono font-bold text-success">{streamlinedDecisionComparison.summary.winnersPreserved}</p></div>
                    <div><span className="text-muted-foreground">Poor entries rejected</span><p className="font-mono font-bold text-success">{streamlinedDecisionComparison.summary.poorEntriesRejected}</p></div>
                  </div>
                  {streamlinedDecisionComparison.rows.filter(row => row.comparable && row.disagreementReasons.length > 0).slice(0, 10).map(row => <div key={["streamlined", row.source, row.id].join(":")} className="border-l-2 border-warning pl-3 text-xs">
                    <span className="font-mono">{row.symbol} {row.direction.toUpperCase()} · {row.currentDecision} to {row.proposedDecision}</span>
                    <p className="text-muted-foreground mt-0.5">{row.disagreementReasons.join(", ") || "Decision changed"}</p>
                  </div>)}
                </div> : <div className="py-8 text-center text-sm text-muted-foreground">Streamlined comparison is unavailable.</div>}
              </CardContent>
            </Card>

            <Card className="border-border/50">
              <CardHeader className="pb-2 pt-3 px-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="text-sm font-medium">Premium/Discount Range Comparison</CardTitle>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Last 100 setups: rolling entry-timeframe decisions compared with the frozen HTF impulse range.
                    </p>
                  </div>
                  <Badge variant="outline" className="text-[9px]">
                    {isLoadingDealingRangeComparison
                      ? "Loading"
                      : `${dealingRangeComparison?.summary.available ?? 0}/${dealingRangeComparison?.summary.sampleSize ?? 0} comparable`}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {isLoadingDealingRangeComparison ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    Loading Premium/Discount range comparison…
                  </div>
                ) : dealingRangeComparison ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 text-xs">
                      <div><span className="text-muted-foreground">Agreements</span><p className="font-mono font-bold">{dealingRangeComparison.summary.agreements}</p></div>
                      <div><span className="text-muted-foreground">Disagreements</span><p className="font-mono font-bold">{dealingRangeComparison.summary.disagreements}</p></div>
                      <div><span className="text-muted-foreground">Winners preserved</span><p className="font-mono font-bold text-success">{dealingRangeComparison.summary.winnersPreserved}</p></div>
                      <div><span className="text-muted-foreground">Winners blocked</span><p className="font-mono font-bold text-destructive">{dealingRangeComparison.summary.winnersBlocked}</p></div>
                      <div><span className="text-muted-foreground">Poor entries rejected</span><p className="font-mono font-bold text-success">{dealingRangeComparison.summary.poorEntriesRejected}</p></div>
                      <div><span className="text-muted-foreground">Poor entries allowed</span><p className="font-mono font-bold text-warning">{dealingRangeComparison.summary.poorEntriesAllowed}</p></div>
                      <div><span className="text-muted-foreground">HTF range blocks</span><p className="font-mono font-bold">{dealingRangeComparison.summary.canonicalBlocked}</p></div>
                      <div><span className="text-muted-foreground">Unavailable</span><p className="font-mono font-bold text-muted-foreground">{dealingRangeComparison.summary.unavailable}</p></div>
                    </div>
                    {dealingRangeComparison.rows
                      .filter((row) => row.decisionsMatch === false)
                      .slice(0, 10)
                      .map((row) => (
                        <div key={`${row.source}:${row.id}`} className="border-l-2 border-warning pl-3 text-xs">
                          <span className="font-mono">
                            {row.symbol} {row.direction.toUpperCase()} · {row.canonicalPercent?.toFixed(1) ?? "—"}%
                          </span>
                          <p className="text-muted-foreground mt-0.5">
                            {row.explanation || "Premium/Discount explanation unavailable"}
                          </p>
                        </div>
                      ))}
                  </div>
                ) : (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    Premium/Discount range comparison is unavailable.
                  </div>
                )}
              </CardContent>
            </Card>

            {isLoading || isLoadingClosedTrades || isLoadingStrategyActivations ||
                isLoadingStrategyEvidenceCertificates || isLoadingZoneLocalValidation ? (
              <Card className="border-border/50">
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  Loading shadow evidence…
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                <ZoneLocalValidationCard
                  rows={filteredZoneLocalValidation}
                  activation={activationByFeature.get("zone_local_confluence")}
                />
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <ShadowFeatureEvidenceCard
                    summary={shadowEvidenceReport.gameplanHierarchy}
                    activation={activationByFeature.get("gameplan_hierarchy")}
                    certificate={certificateByFeature.get("gameplan_hierarchy")}
                  />
                  <ShadowFeatureEvidenceCard
                    summary={shadowEvidenceReport.thesisConviction}
                    activation={activationByFeature.get("thesis_conviction")}
                    certificate={certificateByFeature.get("thesis_conviction")}
                  />
                </div>
              </div>
            )}
          </TabsContent>

          {/* Table Tab */}
          {/* Strategy Advisor Tab */}
          <TabsContent value="advisor" className="mt-3">
            <RecommendationsDashboard botId="smc" defaultReviewMode="on_demand" />
          </TabsContent>

          <TabsContent value="table" className="mt-3">
            <Card className="border-border/50">
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="py-12 text-center text-sm text-muted-foreground">Loading...</div>
                ) : setups.length === 0 ? (
                  <div className="py-12 text-center text-sm text-muted-foreground">No rejected opportunities in this period</div>
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
                          {s.occurrence_count > 1 && <span>{s.occurrence_count} scans</span>}
                        </div>
                        {getDisplayGates(s).length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {getDisplayGates(s).slice(0, 3).map((g, i) => (
                              <Badge key={i} variant="secondary" className="text-[9px] px-1 py-0">{g}</Badge>
                            ))}
                            {getDisplayGates(s).length > 3 && <Badge variant="secondary" className="text-[9px] px-1 py-0">+{getDisplayGates(s).length - 3}</Badge>}
                          </div>
                        )}
                        <ShadowDecision audit={getShadowAudit(s)} />
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
                          <th className="text-left px-3 py-2 font-medium">Current vs Shadow</th>
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
                              <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                                <div>{formatBrokerTime(s.rejected_at)}</div>
                                {s.occurrence_count > 1 && (
                                  <div className="text-[9px]">{s.occurrence_count} scans collapsed</div>
                                )}
                              </td>
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
                                  {getDisplayGates(s).slice(0, 2).map((g, i) => (
                                    <Badge key={i} variant="secondary" className="text-[9px] px-1 py-0">{g}</Badge>
                                  ))}
                                  {getDisplayGates(s).length > 2 && <Badge variant="secondary" className="text-[9px] px-1 py-0">+{getDisplayGates(s).length - 2}</Badge>}
                                </div>
                              </td>
                              <td className="px-3 py-2 font-mono">{s.rr_ratio ? s.rr_ratio.toFixed(1) : "—"}</td>
                              <td className="px-3 py-2 font-mono text-profit">{formatPipDisplay(s.mfe_pips, s.symbol)}</td>
                              <td className="px-3 py-2 font-mono text-loss">{formatPipDisplay(s.mae_pips !== null ? -s.mae_pips : null, s.symbol)}</td>
                              <td className="px-3 py-2 min-w-[150px]"><ShadowDecision audit={getShadowAudit(s)} /></td>
                              <td className="px-3 py-2"><OutcomeBadge status={s.outcome_status} /></td>
                            </tr>
                            {expandedRow === s.id && (
                              <tr>
                                <td colSpan={12} className="px-3 py-0">
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
const SHADOW_STATUS_CONFIG = {
  no_data: {
    label: "NO DATA",
    className: "border-border text-muted-foreground",
  },
  collecting: {
    label: "COLLECTING",
    className: "border-info-c/40 text-info-c",
  },
  paper_candidate: {
    label: "PAPER CANDIDATE",
    className: "border-success/40 text-success",
  },
  keep_shadow: {
    label: "KEEP SHADOW",
    className: "border-warning/40 text-warning",
  },
} as const;

function EvidenceBreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: ShadowEvidenceBreakdown[];
}) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="text-[10px] text-muted-foreground">No resolved decision changes yet.</p>
      ) : (
        <div className="space-y-1">
          {rows.slice(0, 8).map((row) => (
            <div
              key={row.key}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded border border-border/40 px-2 py-1.5"
            >
              <div className="min-w-0">
                <p className="text-[11px] font-medium truncate">{row.key}</p>
                <p className="text-[9px] text-muted-foreground">
                  {row.resolved} resolved · {row.changed} changed
                </p>
              </div>
              <span className="text-[10px] text-success">{row.beneficial} useful</span>
              <span className="text-[10px] text-destructive">{row.harmful} harmful</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ZoneLocalValidationCard({
  rows,
  activation,
}: {
  rows: ZoneLocalValidationSummary[];
  activation?: StrategyActivationRecord;
}) {
  const activationDisplay = getStrategyActivationDisplay(activation);
  const forwardRows = rows.filter(
    (row) => row.evidence_source === "forward_observation",
  );
  const replayRows = rows.filter(
    (row) => row.evidence_source === "retrospective_replay",
  );
  const totals = forwardRows.reduce(
    (acc, row) => ({
      scans: acc.scans + Number(row.observed_scans || 0),
      disagreements: acc.disagreements + Number(row.disagreement_scans || 0),
      resolved: acc.resolved + Number(row.resolved_candidates || 0),
    }),
    { scans: 0, disagreements: 0, resolved: 0 },
  );

  return (
    <Card className="border-border/50">
      <CardHeader className="px-4 pt-3 pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-medium">
              Zone Candidate & Cross-TF Validation
            </CardTitle>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Compares legacy selection with zone-local ranking and the
              observation-only parent/child timeframe policy.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild size="sm" variant="outline" className="h-7 text-[10px]">
              <Link to="/backtest?zoneLocalReplay=1">
                Run Historical Replay
              </Link>
            </Button>
            <Badge variant="outline" className="text-[9px] border-cyan-500/40 text-cyan-500">
              {activationDisplay.runtimeLabel}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <div className="rounded border border-primary/25 bg-primary/5 p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[9px] border-primary/40 text-primary">
              {activationDisplay.authorityLabel}
            </Badge>
            <Badge variant="outline" className="text-[9px]">
              {activationDisplay.scopeLabel}
            </Badge>
            <Badge variant="outline" className="text-[9px] border-cyan-500/40 text-cyan-500">
              SOURCE SEPARATED
            </Badge>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {activationDisplay.description} Forward observations and historical
            replay are reported separately. Replay data is permanently
            ineligible to activate Soft or Hard enforcement.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded border border-border/40 p-2">
            <p className="text-sm font-semibold">{totals.scans}</p>
            <p className="text-[9px] text-muted-foreground">observed scans</p>
          </div>
          <div className="rounded border border-border/40 p-2">
            <p className="text-sm font-semibold text-warning">{totals.disagreements}</p>
            <p className="text-[9px] text-muted-foreground">rank disagreements</p>
          </div>
          <div className="rounded border border-border/40 p-2">
            <p className="text-sm font-semibold">{totals.resolved}</p>
            <p className="text-[9px] text-muted-foreground">resolved candidates</p>
          </div>
        </div>

        <ZoneLocalDatasetTable
          title="Forward Observation"
          description="Natural scanner evidence. This is the only dataset that may become activation-ready."
          rows={forwardRows}
          retrospective={false}
        />
        <ZoneLocalDatasetTable
          title="Retrospective Replay"
          description="Backtest-derived research for faster learning. It can inform review, but never runtime activation."
          rows={replayRows}
          retrospective
        />
        <p className="text-[9px] text-muted-foreground">
          “Ready” applies only to forward observations and still means review,
          not automatic permission to change live or paper execution.
        </p>
      </CardContent>
    </Card>
  );
}

function ZoneLocalDatasetTable({
  title,
  description,
  rows,
  retrospective,
}: {
  title: string;
  description: string;
  rows: ZoneLocalValidationSummary[];
  retrospective: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-medium">{title}</p>
          <p className="text-[9px] text-muted-foreground">{description}</p>
        </div>
        <Badge
          variant="outline"
          className={`text-[8px] ${
            retrospective
              ? "border-cyan-500/40 text-cyan-500"
              : "border-success/40 text-success"
          }`}
        >
          {retrospective ? "RESEARCH ONLY" : "ACTIVATION EVIDENCE"}
        </Badge>
      </div>
      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-border/60 p-3 text-center">
          <p className="text-[10px] text-muted-foreground">
            {retrospective
              ? "No historical replay evidence yet. Use Run Historical Replay to collect it."
              : "No forward rank disagreement has completed outcome tracking yet."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-border/40">
          <table className="w-full min-w-[1180px] text-[10px]">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Style / Pair</th>
                <th className="px-2 py-1.5 text-right font-medium">Disagreements</th>
                <th className="px-2 py-1.5 text-right font-medium">Resolved</th>
                <th className="px-2 py-1.5 text-right font-medium">Legacy win</th>
                <th className="px-2 py-1.5 text-right font-medium">Local win</th>
                <th className="px-2 py-1.5 text-right font-medium">Local MFE</th>
                <th className="px-2 py-1.5 text-right font-medium">Local MAE</th>
                <th className="px-2 py-1.5 text-right font-medium">TF disagreements</th>
                <th className="px-2 py-1.5 text-right font-medium">Winners kept</th>
                <th className="px-2 py-1.5 text-right font-medium">Losers avoided</th>
                <th className="px-2 py-1.5 text-right font-medium">Missed</th>
                <th className="px-2 py-1.5 text-right font-medium">False +</th>
                <th className="px-2 py-1.5 text-right font-medium">Expectancy Δ</th>
                <th className="px-2 py-1.5 text-right font-medium">
                  {retrospective ? "Replay runs" : "Readiness"}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.evidence_source}:${row.trading_style}:${row.symbol}`}
                  className="border-t border-border/30"
                >
                  <td className="px-2 py-1.5">
                    <span className="font-medium">{row.symbol}</span>
                    <span className="ml-1 text-muted-foreground">
                      {row.trading_style}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right">{Number(row.disagreement_scans || 0)}</td>
                  <td className="px-2 py-1.5 text-right">{Number(row.resolved_candidates || 0)}</td>
                  <td className="px-2 py-1.5 text-right">{formatValidationPercent(row.legacy_disagreement_win_rate)}</td>
                  <td className="px-2 py-1.5 text-right font-medium text-primary">{formatValidationPercent(row.shadow_disagreement_win_rate)}</td>
                  <td className="px-2 py-1.5 text-right text-success">{formatValidationPips(row.shadow_winner_avg_mfe_pips, row.symbol)}</td>
                  <td className="px-2 py-1.5 text-right text-destructive">{formatValidationPips(row.shadow_winner_avg_mae_pips, row.symbol)}</td>
                  <td className="px-2 py-1.5 text-right">{Number(row.cross_tf_disagreement_scans || 0)}</td>
                  <td className="px-2 py-1.5 text-right text-success">{Number(row.winners_retained || 0)}</td>
                  <td className="px-2 py-1.5 text-right text-success">{Number(row.losers_avoided || 0)}</td>
                  <td className="px-2 py-1.5 text-right text-warning">{Number(row.missed_opportunities || 0)}</td>
                  <td className="px-2 py-1.5 text-right text-destructive">{Number(row.false_positives || 0)}</td>
                  <td className={`px-2 py-1.5 text-right font-mono ${
                    Number(row.cross_tf_expectancy_delta_r || 0) >= 0
                      ? "text-success"
                      : "text-destructive"
                  }`}>
                    {row.cross_tf_expectancy_delta_r == null
                      ? "—"
                      : `${Number(row.cross_tf_expectancy_delta_r).toFixed(3)}R`}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {retrospective ? (
                      <span>{Number(row.replay_runs || 0)}</span>
                    ) : (
                      <Badge
                        variant="outline"
                        className={`text-[8px] ${
                          row.minimum_sample_ready
                            ? "border-success/40 text-success"
                            : "border-warning/40 text-warning"
                        }`}
                      >
                        {row.minimum_sample_ready ? "30+ READY" : "COLLECTING"}
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatValidationPercent(value: number | null): string {
  if (value == null) return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(1)}%` : "—";
}

function formatValidationPips(value: number | null, symbol: string): string {
  if (value == null) return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? formatPipDisplay(parsed, symbol, { showSign: false })
    : "—";
}

function ShadowFeatureEvidenceCard({
  summary,
  activation,
  certificate,
}: {
  summary: ShadowFeatureEvidenceSummary;
  activation?: StrategyActivationRecord;
  certificate?: StrategyEvidenceCertificateRecord;
}) {
  const status = SHADOW_STATUS_CONFIG[summary.status];
  const activationDisplay = getStrategyActivationDisplay(activation);
  const certificateStatus = certificate
    ? STRATEGY_EVIDENCE_STATUS[certificate.status]
    : null;
  return (
    <Card className="border-border/50">
      <CardHeader className="px-4 pt-3 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-medium">{summary.label}</CardTitle>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {summary.evidenceCount}/{summary.totalCandidates} candidates have comparable evidence
            </p>
          </div>
          <Badge variant="outline" className={`text-[9px] ${status.className}`}>
            {status.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <div className="rounded border border-primary/25 bg-primary/5 p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[9px] border-primary/40 text-primary">
              {activationDisplay.authorityLabel}
            </Badge>
            <Badge variant="outline" className="text-[9px]">
              {activationDisplay.scopeLabel}
            </Badge>
            <Badge variant="outline" className="text-[9px] border-warning/40 text-warning">
              {activationDisplay.runtimeLabel}
            </Badge>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {activationDisplay.description}
          </p>
        </div>

        <div className="rounded border border-border/40 p-2">
          {certificate && certificateStatus ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge
                  variant="outline"
                  className={`text-[9px] ${certificateStatus.className}`}
                >
                  {certificateStatus.label}
                </Badge>
                <span className="font-mono text-[9px] text-muted-foreground">
                  {shortCertificateHash(certificate.certificate_hash)}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
                <span>
                  Out-of-sample:{" "}
                  <strong>{certificate.out_of_sample_passed ? "PASS" : "WAIT"}</strong>
                </span>
                <span>
                  Walk-forward:{" "}
                  <strong>{certificate.walk_forward_consistent ? "PASS" : "WAIT"}</strong>
                </span>
                <span>Expectancy Δ: {certificate.expectancy_delta_r.toFixed(3)}R</span>
                <span>Drawdown Δ: {certificate.max_drawdown_delta_percent.toFixed(1)}%</span>
                <span>Good trades kept: {certificate.good_trade_retention_percent.toFixed(0)}%</span>
                <span>{certificate.resolved_count} resolved · {certificate.changed_count} changed</span>
              </div>
              <p className="mt-1 text-[9px] text-muted-foreground">
                Server-generated certificate. It can recommend Log-only but cannot activate it.
              </p>
            </>
          ) : (
            <>
              <Badge variant="outline" className="text-[9px] border-border text-muted-foreground">
                NO TRUSTED CERTIFICATE
              </Badge>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Use Certify to create an immutable server-side snapshot of the selected history window.
              </p>
            </>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="rounded border border-border/40 p-2">
            <p className="text-[9px] text-muted-foreground uppercase">Coverage</p>
            <p className="text-lg font-bold">{summary.coveragePercent.toFixed(0)}%</p>
          </div>
          <div className="rounded border border-border/40 p-2">
            <p className="text-[9px] text-muted-foreground uppercase">Resolved</p>
            <p className="text-lg font-bold">{summary.resolved}</p>
          </div>
          <div className="rounded border border-border/40 p-2">
            <p className="text-[9px] text-muted-foreground uppercase">Changes</p>
            <p className="text-lg font-bold">{summary.changed}</p>
          </div>
          <div className="rounded border border-border/40 p-2">
            <p className="text-[9px] text-muted-foreground uppercase">Useful Rate</p>
            <p className="text-lg font-bold">
              {summary.beneficialRate === null ? "—" : `${summary.beneficialRate.toFixed(0)}%`}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded bg-muted/20 p-2 text-[10px]">
          <span className="text-success">Rescued winners: {summary.rescuedWinners}</span>
          <span className="text-success">Avoided losses: {summary.avoidedLosses}</span>
          <span className="text-destructive">Admitted losses: {summary.admittedLosses}</span>
          <span className="text-destructive">Blocked winners: {summary.blockedWinners}</span>
        </div>

        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {summary.statusReason}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <EvidenceBreakdownTable title="By trading style" rows={summary.byStyle} />
          <EvidenceBreakdownTable title="By pair" rows={summary.byPair} />
        </div>
      </CardContent>
    </Card>
  );
}

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

function ShadowDecision({ audit }: { audit: ShadowAudit | null }) {
  if (!audit) {
    return <span className="text-[10px] text-muted-foreground">Available on new scans</span>;
  }

  const current = audit.currentSystem?.decision || "not_evaluated";
  const proposed = audit.decision || "not_evaluated";
  const reason = [
    audit.currentSystem?.reason ? `Current: ${audit.currentSystem.reason}` : null,
    audit.reasons?.length ? `Shadow: ${audit.reasons.join("; ")}` : null,
  ].filter(Boolean).join("\n");

  return (
    <div className="flex flex-wrap items-center gap-1" title={reason}>
      <Badge variant="outline" className="text-[9px] px-1 py-0">
        NOW {current.toUpperCase()}
      </Badge>
      <span className="text-[9px] text-muted-foreground">→</span>
      <Badge
        variant="outline"
        className={`text-[9px] px-1 py-0 ${
          proposed === "eligible"
            ? "text-profit border-emerald-500/30"
            : proposed === "skip"
              ? "text-loss border-destructive/30"
              : "text-amber-500 border-amber-500/30"
        }`}
      >
        SHADOW {proposed.toUpperCase()}
      </Badge>
    </div>
  );
}
