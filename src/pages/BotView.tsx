import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useQueries, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatMoney, INSTRUMENTS } from "@/lib/marketData";
import { formatBrokerTime, formatTimeOnly, formatFullDateTime } from "@/lib/formatTime";
import { paperApi, scannerApi, brokerApi, botConfigApi, brokerExecApi } from "@/lib/api";
import {
  STYLE_META,
  getActiveStyle,
  getScanLogMeta,
  isTradingStyleMode,
  readRuntimeStylePolicy,
} from "@/lib/botStyleClassifier";
import { toast } from "sonner";
import {
  Play, Pause, Square, AlertTriangle, Scan, Loader2,
  TrendingUp, TrendingDown, Minus, Clock,
  ChevronDown, ChevronUp, Plus, Settings, Activity, Monitor, RefreshCw,
  Eye, EyeOff, PanelRightClose, PanelRightOpen, MoreVertical, Wallet,
} from "lucide-react";
import { BotConfigModal } from "@/components/BotConfigModal";

import { CloseAuditLog } from "@/components/CloseAuditLog";
import { BrokerLog } from "@/components/BrokerLog";
import { SignalReasoningCard } from "@/components/SignalReasoningCard";
import { ExpandedPositionCard } from "@/components/ExpandedPositionCard";
import { OverrideBadge } from "@/components/TradeOverrideEditor";
import { DataSourceBadge } from "@/components/DataSourceBadge";
import { FOTSIStrengthMeter } from "@/components/FOTSIStrengthMeter";
import { RecommendationsDashboard } from "@/components/RecommendationsDashboard";
import BrokerTradesTab from "@/components/BrokerTradesTab";
import { LegacyDiagnosticsPanel } from "@/components/LegacyDiagnosticsPanel";
import { formatNewsGateCountdown } from "@/lib/newsGateCountdown";
import { uniqueRejectionReasons } from "@/lib/rejectedSetupAnalytics";
import { WatchlistPanel } from "@/components/WatchlistPanel";
import PendingOrdersPanel from "@/components/PendingOrdersPanel";
import { GamePlanPanel } from "@/components/GamePlanPanel";
import SessionStatusPill from "@/components/SessionStatusPill";
import { ZoneStoryPanel } from "@/components/ZoneStoryPanel";
import { ScanDetailBreakdown, TradeDecisionPanel } from "@/components/ScanDetailBreakdown";
import type { CandleSource } from "@/lib/api";
import {
  canReturnToPaper,
  canUseTradingControls,
  readExecutionMode,
  verifyExecutionModeChange,
  type ExecutionMode,
} from "@/lib/executionMode";
import { useNavigate } from "react-router-dom";
import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { MobilePositionCard } from "@/components/MobilePositionCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function ReadUnavailable({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center border border-warning/30 py-10 text-warning">
      <AlertTriangle className="mb-2 h-5 w-5" />
      <p className="text-xs font-medium">{label} is unavailable</p>
    </div>
  );
}

function accountControlError(fallback: string) {
  return (error: unknown) =>
    toast.error(error instanceof Error && error.message ? error.message : fallback);
}

export default function BotView() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [mobileAccountSheet, setMobileAccountSheet] = useState(false);
  const [mobileScanDetailSheet, setMobileScanDetailSheet] = useState(false);
  const [orderFormOpen, setOrderFormOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [liveModeConfirm, setLiveModeConfirm] = useState(false);
  const [expandedPosition, setExpandedPosition] = useState<string | null>(null);
  const [selectedPairIdx, setSelectedPairIdx] = useState(0);
  const [selectedScanIdx, setSelectedScanIdx] = useState(0);
  const [botTab, setBotTab] = useState("open");

  const [customBalanceInput, setCustomBalanceInput] = useState("");
  const [showSetBalance, setShowSetBalance] = useState(false);

  // Manual scan polling state — keeps spinner active while background scan runs
  const [scanPolling, setScanPolling] = useState(false);
  const scanPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanStartedAtRef = useRef<string | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (scanPollRef.current) clearInterval(scanPollRef.current);
    };
  }, []);

  // Panel visibility — persisted in localStorage
  const [showSidebar, setShowSidebar] = useState(() => {
    try { return localStorage.getItem("botview-show-sidebar") !== "false"; } catch { return true; }
  });
  const [showScanPanel, setShowScanPanel] = useState(() => {
    try {
      const stored = localStorage.getItem("botview-show-scan");
      if (stored !== null) return stored !== "false";
      // Default: expanded on both mobile and desktop so scan results are immediately visible
      return true;
    } catch { return true; }
  });
  const toggleSidebar = useCallback(() => {
    setShowSidebar(prev => { const next = !prev; try { localStorage.setItem("botview-show-sidebar", String(next)); } catch {} return next; });
  }, []);
  const toggleScanPanel = useCallback(() => {
    setShowScanPanel(prev => { const next = !prev; try { localStorage.setItem("botview-show-scan", String(next)); } catch {} return next; });
  }, []);

  // Order form state
  const [orderType, setOrderType] = useState("market");
  const [orderSymbol, setOrderSymbol] = useState("EUR/USD");
  const [orderDirection, setOrderDirection] = useState<"long" | "short">("long");
  const [orderSize, setOrderSize] = useState("0.01");
  const [orderTrigger, setOrderTrigger] = useState("");
  const [orderSL, setOrderSL] = useState("");
  const [orderTP, setOrderTP] = useState("");
  const [orderReason, setOrderReason] = useState("");
  const [orderScore, setOrderScore] = useState("5");

  const {
    data: status,
    isPending: statusPending,
    isError: statusReadFailed,
    error: statusReadError,
  } = useQuery({
    queryKey: ["paper-status"],
    queryFn: () => paperApi.status(),
    // Shared key with StatusBar and MobileTopBar; React Query refetches at the
    // SHORTEST observer interval, so 5s here set the rate for the whole app and
    // each poll costs one TwelveData credit per open symbol. Matched to the
    // others at 10s.
    refetchInterval: 10000,
  });

  const { data: scanLogs } = useQuery({
    queryKey: ["scan-logs"],
    queryFn: () => scannerApi.logs(),
    refetchInterval: 30000,
  });

  const { data: botConfig } = useQuery({
    queryKey: ["bot-config"],
    queryFn: () => botConfigApi.get(),
  });

  const { data: brokerConns, isError: brokerConnectionsReadFailed } = useQuery({
    queryKey: ["broker-connections"],
    queryFn: () => brokerApi.list(),
    refetchInterval: 30000,
  });
  const brokerConnectionsKnown = !brokerConnectionsReadFailed && Array.isArray(brokerConns);
  const activeConnections = brokerConnectionsKnown ? brokerConns.filter((c: any) => c.is_active) : [];
  const [selectedConnIdx, setSelectedConnIdx] = useState(0);
  const selectedConnection = activeConnections[selectedConnIdx] || activeConnections[0];

  // Live controls stay disabled until every active destination has confirmed
  // connectivity, account state, and open-position state. The selected account
  // controls presentation only; it must not narrow the safety check.
  const executionMode = !statusPending && !statusReadFailed
    ? readExecutionMode(status)
    : "unknown";
  const accountStatusKnown = executionMode !== "unknown";
  const isLiveMode = executionMode === "live";
  const brokerConnectionStateQueries = useQueries({
    queries: activeConnections.map((connection) => ({
      queryKey: ["broker-connection-status", connection.id],
      queryFn: () => brokerExecApi.connectionStatus(connection.id),
      enabled: isLiveMode,
      refetchInterval: 30000,
    })),
  });
  const brokerAccountQueries = useQueries({
    queries: activeConnections.map((connection) => ({
      queryKey: ["broker-account", connection.id],
      queryFn: () => brokerExecApi.accountSummary(connection.id),
      enabled: isLiveMode,
      refetchInterval: 10000,
    })),
  });
  const brokerPositionQueries = useQueries({
    queries: activeConnections.map((connection) => ({
      queryKey: ["broker-open-trades", connection.id],
      queryFn: () => brokerExecApi.openTrades(connection.id),
      enabled: isLiveMode,
      refetchInterval: 10000,
    })),
  });
  const selectedConnectionIndex = selectedConnection
    ? activeConnections.findIndex((connection) => connection.id === selectedConnection.id)
    : -1;
  const selectedConnectionStateQuery = selectedConnectionIndex >= 0
    ? brokerConnectionStateQueries[selectedConnectionIndex]
    : undefined;
  const selectedBrokerAccountQuery = selectedConnectionIndex >= 0
    ? brokerAccountQueries[selectedConnectionIndex]
    : undefined;
  const selectedBrokerPositionQuery = selectedConnectionIndex >= 0
    ? brokerPositionQueries[selectedConnectionIndex]
    : undefined;
  const brokerAccount = selectedBrokerAccountQuery?.data;
  const brokerAccountReadFailed = selectedBrokerAccountQuery?.isError === true;
  const brokerAccountReadError = selectedBrokerAccountQuery?.error;
  const brokerOpenTrades = selectedBrokerPositionQuery?.data;
  const brokerPositionsReadFailed = selectedBrokerPositionQuery?.isError === true;
  const brokerPositionsReadError = selectedBrokerPositionQuery?.error;
  const liveBrokerReadPending = activeConnections.some((_, index) =>
    brokerConnectionStateQueries[index]?.isPending ||
    brokerAccountQueries[index]?.isPending ||
    brokerPositionQueries[index]?.isPending
  );
  const liveBrokerReadFailed = activeConnections.some((_, index) =>
    brokerConnectionStateQueries[index]?.isError ||
    brokerAccountQueries[index]?.isError ||
    brokerPositionQueries[index]?.isError
  );
  const liveBrokerStates = activeConnections.map((_, index) =>
    brokerConnectionStateQueries[index]?.isSuccess === true &&
    brokerConnectionStateQueries[index]?.data?.ready === true &&
    brokerAccountQueries[index]?.isSuccess === true &&
    !!brokerAccountQueries[index]?.data &&
    brokerPositionQueries[index]?.isSuccess === true &&
    Array.isArray(brokerPositionQueries[index]?.data)
  );
  const tradingControlsEnabled = canUseTradingControls(executionMode, liveBrokerStates);
  const canSwitchBackToPaper = canReturnToPaper(
    executionMode,
    brokerConnectionsKnown,
    activeConnections.map((_, index) => ({
      available: brokerPositionQueries[index]?.isSuccess === true,
      positions: brokerPositionQueries[index]?.data,
    })),
  );
  const modeChangeEnabled = accountStatusKnown && (
    executionMode === "paper" ? brokerConnectionsKnown : canSwitchBackToPaper
  );

  useEffect(() => {
    if (tradingControlsEnabled) return;
    setOrderFormOpen(false);
    setShowSetBalance(false);
    setConfigOpen(false);
  }, [tradingControlsEnabled]);

  const requireTradingControls = () => {
    if (!tradingControlsEnabled) {
      throw new Error("Current account and broker state must be available before trading controls can be used.");
    }
  };

  const closePositionFromDashboard = async (positionId: string) => {
    try {
      if (!positionId) throw new Error("A known position is required to close.");
      await paperApi.closePosition(positionId);
      queryClient.invalidateQueries({ queryKey: ["paper-status"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to close position");
    }
  };

  const startMut = useMutation({ mutationFn: () => { requireTradingControls(); return paperApi.startEngine(); }, onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Engine started"); }, onError: accountControlError("Failed to start engine") });
  const pauseMut = useMutation({ mutationFn: () => paperApi.pauseEngine(), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Engine paused"); }, onError: accountControlError("Failed to pause engine") });
  const stopMut = useMutation({ mutationFn: () => paperApi.stopEngine(), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Engine stopped"); }, onError: accountControlError("Failed to stop engine") });
  const killMut = useMutation({ mutationFn: () => paperApi.killSwitch(true), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.error("Kill switch activated"); }, onError: accountControlError("Failed to activate kill switch") });
  const deactivateKill = useMutation({ mutationFn: () => { requireTradingControls(); return paperApi.killSwitch(false); }, onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Kill switch deactivated"); }, onError: accountControlError("Failed to deactivate kill switch") });
  const resetMut = useMutation({ mutationFn: () => { requireTradingControls(); return paperApi.resetAccount(); }, onSuccess: (data: any) => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success(`Full reset complete — balance set to ${data?.startingBalance || "10,000"}`); }, onError: accountControlError("Failed to reset account") });
  const resetBalMut = useMutation({ mutationFn: () => { requireTradingControls(); return paperApi.resetBalanceOnly(); }, onSuccess: (data: any) => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success(`Balance reset to ${data?.startingBalance || "10,000"} — history preserved`); }, onError: accountControlError("Failed to reset balance") });
  const setBalMut = useMutation({
    mutationFn: (balance: number) => { requireTradingControls(); return paperApi.setBalance(balance); },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["paper-status"] });
      toast.success(`Balance set to $${parseFloat(data?.balance || "0").toLocaleString()}`);
      setCustomBalanceInput("");
      setShowSetBalance(false);
    },
    onError: (err: any) => toast.error(err.message || "Failed to set balance"),
  });
  const modeMut = useMutation({
    mutationFn: async (mode: ExecutionMode) => {
      const result = await paperApi.setExecutionMode(mode);
      const executionMode = await verifyExecutionModeChange(
        result,
        mode,
        async () => {
          const persistedStatus = await paperApi.status();
          return persistedStatus?.executionMode
            || persistedStatus?.account?.execution_mode;
        },
      );
      return { ...result, executionMode };
    },
    onSuccess: (result, mode) => {
      queryClient.setQueryData(["paper-status"], (current: any) => ({
        ...(current || {}),
        executionMode: result.executionMode,
      }));
      queryClient.invalidateQueries({ queryKey: ["paper-status"] });
      toast.success(mode === "live"
        ? "Live execution enabled and verified"
        : "Paper execution enabled and verified");
    },
    onError: accountControlError("Execution mode was not changed"),
  });
  const scanMut = useMutation({
    mutationFn: () => { requireTradingControls(); return scannerApi.manualScan(); },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["paper-status"] });
      queryClient.invalidateQueries({ queryKey: ["scan-logs"] });

      // Reset to latest scan so the UI shows the new result, not the old one
      setSelectedScanIdx(0);
      setSelectedPairIdx(0);

      // Backend now returns the full scan result (not fire-and-forget).
      // Handle error responses from the backend
      if (data.error) {
        toast.error(`Scan failed: ${data.error}`);
        return;
      }

      if (data.started) {
        // Backend fired the scan in background — start polling for completion
        setScanPolling(true);
        scanStartedAtRef.current = new Date().toISOString();

        // Poll scan-logs every 3s to detect when the new scan lands
        if (scanPollRef.current) clearInterval(scanPollRef.current);
        scanPollRef.current = setInterval(async () => {
          try {
            const logs = await scannerApi.logs();
            if (logs && logs.length > 0) {
              const latestScanTime = logs[0]?.scanned_at;
              // If the latest scan is newer than when we started, scan is done
              if (latestScanTime && scanStartedAtRef.current && latestScanTime > scanStartedAtRef.current) {
                // Scan completed — stop polling
                if (scanPollRef.current) clearInterval(scanPollRef.current);
                scanPollRef.current = null;
                setScanPolling(false);
                scanStartedAtRef.current = null;

                // Refresh all relevant queries
                queryClient.invalidateQueries({ queryKey: ["scan-logs"] });
                queryClient.invalidateQueries({ queryKey: ["paper-status"] });
                setSelectedScanIdx(0);
                setSelectedPairIdx(0);

                toast.success("Scan complete — results updated", { duration: 4000 });
              }
            }
          } catch (e) {
            // Silently ignore polling errors
          }
        }, 3000);

        // Safety timeout — stop polling after 90s regardless
        setTimeout(() => {
          if (scanPollRef.current) {
            clearInterval(scanPollRef.current);
            scanPollRef.current = null;
            setScanPolling(false);
            scanStartedAtRef.current = null;
            queryClient.invalidateQueries({ queryKey: ["scan-logs"] });
          }
        }, 90000);

        return;
      }

      // Handle skip reasons (overlap, interval, day not enabled, no account, etc.)
      if (data.skippedReason) {
        const reason = data.skippedReason;
        const friendlyReasons: Record<string, string> = {
          overlap: "Another scan is still running — try again in a minute",
          "Day not enabled": "Today is not an enabled trading day in your config",
          "No paper account": "No paper trading account found — set one up first",
        };
        const msg = friendlyReasons[reason] || (reason.startsWith("interval") ? `Scan skipped — ${reason}` : `Scan skipped: ${reason}`);
        toast.warning(msg, { duration: 5000 });
        return;
      }

      // Show detailed results
      const pairs = data.pairsScanned ?? 0;
      const signals = data.signalsFound ?? 0;
      const trades = data.tradesPlaced ?? 0;
      const rejected = data.rejected ?? 0;

      if (signals > 0 || trades > 0) {
        toast.success(`Scan complete: ${pairs} pairs → ${signals} signal${signals !== 1 ? "s" : ""}, ${trades} trade${trades !== 1 ? "s" : ""} placed`, { duration: 5000 });
      } else if (pairs > 0) {
        // Scanned pairs but found nothing — show the details breakdown
        const details: any[] = data.details || [];
        const sessionSkipped = details.filter((d: any) => d.reason?.includes("session not enabled")).length;
        const belowThreshold = details.filter((d: any) => d.reason?.includes("Below threshold") || d.reason?.includes("below threshold")).length;
        const noDirection = details.filter((d: any) => d.reason?.includes("No direction")).length;
        const insufficientData = details.filter((d: any) => d.reason?.includes("Insufficient")).length;

        let detail = `${pairs} pairs scanned, 0 signals.`;
        const reasons: string[] = [];
        if (sessionSkipped > 0) reasons.push(`${sessionSkipped} session-filtered`);
        if (belowThreshold > 0) reasons.push(`${belowThreshold} below threshold`);
        if (noDirection > 0) reasons.push(`${noDirection} no direction`);
        if (insufficientData > 0) reasons.push(`${insufficientData} insufficient data`);
        if (reasons.length > 0) detail += " " + reasons.join(", ") + ".";

        toast.info(detail, { duration: 6000 });
      } else {
        toast.info("Scan completed — no pairs were scanned", { duration: 4000 });
      }
    },
    onError: (err: any) => toast.error(`Scan request failed: ${err.message}`),
  });



  const orderMut = useMutation({
    mutationFn: () => {
      requireTradingControls();
      return paperApi.placeOrder({
      symbol: orderSymbol, direction: orderDirection, size: parseFloat(orderSize) || 0.01,
      entryPrice: parseFloat(orderTrigger) || 0,
      stopLoss: orderSL ? parseFloat(orderSL) : undefined,
      takeProfit: orderTP ? parseFloat(orderTP) : undefined,
      signalReason: orderReason, signalScore: parseInt(orderScore) || 5,
      });
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["paper-status"] }); toast.success("Order placed"); setOrderFormOpen(false); },
    onError: (err: any) => toast.error(err.message),
  });

  const d = accountStatusKnown ? status : {
    isRunning: false, isPaused: false, balance: 0, equity: 0, dailyPnl: 0,
    positions: [], tradeHistory: [], totalTrades: 0, winRate: 0, wins: 0, losses: 0,
    scanCount: 0, signalCount: 0, rejectedCount: 0, executionMode: "unknown",
    killSwitchActive: false, drawdown: 0,
  };

  const logs = Array.isArray(scanLogs) ? scanLogs : [];

  // Clamp selected scan index to available logs
  const safeScanIdx = Math.min(selectedScanIdx, Math.max(0, logs.length - 1));
  const currentScan = logs[safeScanIdx];

  // Pull the candle-source meta entry that the scanner prepends to details_json
  // (so we can show which feed served the selected scan), and produce a filtered
  // list that excludes the meta row from rendering as a fake "pair".
  const latestRawDetails: any[] = (() => {
    if (!currentScan) return [];
    let dj = currentScan.details_json;
    // Supabase may return details_json as a JSON string — parse it safely
    if (typeof dj === "string") {
      try { dj = JSON.parse(dj); } catch { return []; }
    }
    return Array.isArray(dj) ? dj : [];
  })();
  const latestMeta = latestRawDetails.find((d: any) => d?.__meta) ?? null;
  const selectedScanStylePolicy = readRuntimeStylePolicy(latestMeta?.stylePolicy);
  const latestRuntimeMeta = getScanLogMeta(logs[0]);
  const effectiveRuntimeStylePolicy = readRuntimeStylePolicy(
    latestRuntimeMeta?.stylePolicy,
  );
  const latestDetailsCleanRaw: any[] = latestRawDetails.filter((d: any) => !d?.__meta);
  // Group/sort by status so the most actionable rows surface first.
  const STATUS_PRIORITY: Record<string, number> = {
    trade_placed: 0,
    trade_placed_from_watchlist: 1,
    limit_order_placed: 2,
    zone_setup_active: 2,
    limit_order_from_watchlist: 3,
    zone_setup_from_watchlist: 3,
    staged_confirming: 4,
    staged_watching: 5,
    staged_new: 6,
    staged_invalidated: 7,
    rejected: 8,
    below_threshold: 9,
    skipped: 10,
  };
  const statusRank = (s: string | undefined) => {
    if (!s) return 99;
    if (s in STATUS_PRIORITY) return STATUS_PRIORITY[s];
    if (s.startsWith("staged_")) return 6;
    return 50;
  };
  const latestDetailsClean: any[] = [...latestDetailsCleanRaw].sort((a, b) => {
    const ra = statusRank(a?.status);
    const rb = statusRank(b?.status);
    if (ra !== rb) return ra - rb;
    // Tie-break by score desc, then pair name for stability
    const sa = typeof a?.score === "number" ? a.score : -1;
    const sb = typeof b?.score === "number" ? b.score : -1;
    if (sa !== sb) return sb - sa;
    return String(a?.pair || "").localeCompare(String(b?.pair || ""));
  });
  const latestSource: CandleSource = (latestMeta?.candleSource as CandleSource) ?? "unknown";

  // Extract FOTSI strengths: prefer __meta.fotsiStrengths (new), fallback to reconstructing from per-pair fotsi alignment data (legacy)
  const fotsiStrengths: Record<string, number> | null = (() => {
    // New format: scanner includes fotsiStrengths directly in __meta
    if (latestMeta?.fotsiStrengths && typeof latestMeta.fotsiStrengths === "object") {
      return latestMeta.fotsiStrengths;
    }
    // Legacy fallback: reconstruct from per-pair fotsi.baseTSI / fotsi.quoteTSI
    const currencyValues: Record<string, number[]> = {};
    for (const detail of latestDetailsClean) {
      const fotsi = detail?.analysis_snapshot?.fotsi || detail?.analysis?.fotsi || detail?.fotsi;
      if (!fotsi || !detail?.pair) continue;
      const parts = (detail.pair as string).split("/");
      if (parts.length !== 2) continue;
      const [base, quote] = parts;
      if (typeof fotsi.baseTSI === "number") {
        (currencyValues[base] ??= []).push(fotsi.baseTSI);
      }
      if (typeof fotsi.quoteTSI === "number") {
        (currencyValues[quote] ??= []).push(fotsi.quoteTSI);
      }
    }
    const keys = Object.keys(currencyValues);
    if (keys.length < 4) return null; // Not enough data
    const result: Record<string, number> = {};
    for (const [k, vals] of Object.entries(currencyValues)) {
      result[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    return result;
  })();

  // Filter positions and trades (SMC bot only)
  const allPositions = d.positions || [];
  const allTradeHistory = d.tradeHistory || [];
  const botPositions = allPositions.filter((p: any) => (p.botId || "smc") === "smc");
  const botTradeHistory = allTradeHistory.filter((t: any) => (t.botId || "smc") === "smc");

  const closedToday = botTradeHistory.filter((t: any) => {
    const today = new Date().toISOString().split('T')[0];
    return t.closedAt?.startsWith(today);
  });

  // Phase-1 cleanup: header-strip metrics (engineLabel, engineDotClass,
  // nextScanLabel, todayPnl, todayPnlPct, unrealizedPnl) lived here only for
  // the desktop stats strip that was removed. StatusBar + Account drawer cover
  // the same data. Variables removed to keep the component lean.

  return (
    <AppShell>
      <div className="flex flex-col h-[calc(100dvh-7.5rem-env(safe-area-inset-bottom))] md:h-[calc(100vh-4.5rem)] w-full max-w-full min-w-0 overflow-x-hidden overflow-y-auto md:overflow-y-hidden">
        {!accountStatusKnown && (
          <div className="border border-warning/40 bg-warning/10 text-warning px-2 py-1.5 text-[10px] font-medium mb-1">
            {statusPending
              ? "Loading account status. Risk-increasing controls are disabled; Pause, Stop, and Kill remain available."
              : "Account status unavailable. Risk-increasing controls are disabled; Pause, Stop, and Kill remain available. " + (statusReadError instanceof Error ? statusReadError.message : "Refresh to retry.")}
          </div>
        )}
        {isLiveMode && !tradingControlsEnabled && (
          <div className="border border-warning/40 bg-warning/10 text-warning px-2 py-1.5 text-[10px] font-medium mb-1">
            {!brokerConnectionsKnown
              ? "Broker connection state is unavailable. Live trading controls are disabled."
              : activeConnections.length === 0
                ? "No active broker connection is available. Live trading controls are disabled."
                : liveBrokerReadPending
                  ? "Loading every active broker account. Live trading controls are disabled."
                  : liveBrokerReadFailed
                    ? "At least one active broker account is unavailable. Live trading controls are disabled."
                    : "At least one active broker connection is not ready. Live trading controls are disabled."}
          </div>
        )}
        {/* Phase-1 cleanup: removed duplicate desktop stats strip.
            StatusBar (bottom of app shell) and the Account drawer already cover
            balance, equity, P&L, win rate, open positions, and engine status. */}

        {/* Live mode alert (compact, only when live) */}
        {executionMode === "live" && (
          <div className="bg-destructive/10 border border-destructive/40 text-destructive px-2 py-1 text-[10px] font-bold uppercase tracking-wider flex items-center justify-between gap-2 mb-1 min-w-0">
            <span className="min-w-0 truncate">⚠ LIVE TRADING — Real Money at Risk</span>
            <button
              className="underline hover:no-underline disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!modeChangeEnabled || modeMut.isPending}
              onClick={() => modeMut.mutate("paper")}
            >
              {modeMut.isPending ? "Verifying…" : "Switch to Paper"}
            </button>
          </div>
        )}

        {/* ─── Action / Control Row ─────────────────────────────────────── */}
        {isMobile ? (
          <div className="flex items-center justify-between gap-1.5 pb-2 border-b border-border min-w-0 overflow-hidden">
            {/* Left: Start/Pause/Stop (icon-only) + status */}
            <div className="flex items-center gap-1 min-w-0">
              <Button size="sm" variant={d.isRunning ? "secondary" : "default"} className="h-7 w-7 p-0" onClick={() => startMut.mutate()} disabled={!tradingControlsEnabled || (d.isRunning && !d.isPaused)} title="Start">
                <Play className="h-3 w-3" />
              </Button>
              <Button size="sm" variant="secondary" className="h-7 w-7 p-0" onClick={() => pauseMut.mutate()} disabled={pauseMut.isPending || (accountStatusKnown && (!d.isRunning || d.isPaused))} title="Pause">
                <Pause className="h-3 w-3" />
              </Button>
              <Button size="sm" variant="secondary" className="h-7 w-7 p-0" onClick={() => stopMut.mutate()} disabled={stopMut.isPending || (accountStatusKnown && !d.isRunning)} title="Stop">
                <Square className="h-3 w-3" />
              </Button>
              <div className="w-px h-5 bg-border mx-0.5" />
              <span className={`inline-flex items-center gap-1 text-[10px] font-medium min-w-0 ${!accountStatusKnown ? "text-warning" : d.isRunning ? (d.isPaused ? "text-warning" : "text-success") : "text-muted-foreground"}`}>
                <span className={d.isRunning && !d.isPaused ? "status-dot-active" : "w-1.5 h-1.5 rounded-full bg-muted-foreground"} />
                <span className="truncate">{!accountStatusKnown ? "Unknown" : d.isRunning ? (d.isPaused ? "Paused" : "Running") : "Off"}</span>
              </span>
              <span className={`text-[9px] font-medium px-1 py-0.5 ${executionMode === "unknown" ? "bg-warning/20 text-warning" : executionMode === "live" ? "bg-destructive/20 text-destructive" : "bg-success/20 text-success"}`}>
                {executionMode === "unknown" ? "UNKNOWN" : executionMode.toUpperCase()}
              </span>
            </div>

            {/* Right: Scan + Overflow menu */}
            <div className="flex items-center gap-1 shrink-0">
              <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => scanMut.mutate()} disabled={!tradingControlsEnabled || scanMut.isPending || scanPolling} title="Scan Now">
                {(scanMut.isPending || scanPolling) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Scan className="h-3 w-3" />}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7 w-7 p-0">
                    <MoreVertical className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem disabled={!tradingControlsEnabled} onClick={() => setOrderFormOpen(!orderFormOpen)}>
                    <Plus className="h-3.5 w-3.5 mr-2" /> New Order
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!tradingControlsEnabled} onClick={() => setConfigOpen(true)}>
                    <Settings className="h-3.5 w-3.5 mr-2" /> Bot Config
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setMobileAccountSheet(true)}>
                    <Wallet className="h-3.5 w-3.5 mr-2" /> Account Details
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    disabled={killMut.isPending}
                    onClick={() => {
                      if (window.confirm("⚠️ KILL SWITCH: This will close ALL open positions and halt trading. Are you sure?")) killMut.mutate();
                    }}
                  >
                    <AlertTriangle className="h-3.5 w-3.5 mr-2" /> Kill Switch
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-2 py-1.5 border border-border bg-card/40 flex-wrap text-[11px]">
            <div className="flex items-center gap-1">
              <Button size="sm" variant={d.isRunning ? "secondary" : "default"} className="h-7 text-[11px]" onClick={() => startMut.mutate()} disabled={!tradingControlsEnabled || (d.isRunning && !d.isPaused)}>
                <Play className="h-3 w-3 mr-1" /> Start
              </Button>
              <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => pauseMut.mutate()} disabled={pauseMut.isPending || (accountStatusKnown && (!d.isRunning || d.isPaused))}>
                <Pause className="h-3 w-3 mr-1" /> Pause
              </Button>
              <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => stopMut.mutate()} disabled={stopMut.isPending || (accountStatusKnown && !d.isRunning)}>
                <Square className="h-3 w-3 mr-1" /> Stop
              </Button>
            </div>

            <div className="w-px h-5 bg-border" />

            <Button size="sm" className="h-7 text-[11px] bg-primary text-primary-foreground" onClick={() => setOrderFormOpen(!orderFormOpen)} disabled={!tradingControlsEnabled}>
              <Plus className="h-3 w-3 mr-1" /> Order
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setConfigOpen(true)} disabled={!tradingControlsEnabled}>
              <Settings className="h-3 w-3 mr-1" /> Config
            </Button>

            <div className="w-px h-5 bg-border" />

            <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 ${executionMode === "unknown" ? "bg-warning/20 text-warning" : executionMode === "live" ? "bg-destructive/20 text-destructive" : "bg-success/20 text-success"}`}>
              {executionMode === "unknown" ? "UNKNOWN" : executionMode.toUpperCase()}
            </span>
            {executionMode === "paper" ? (
              <button
                className="text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground underline disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!modeChangeEnabled || activeConnections.length === 0 || modeMut.isPending}
                onClick={() => {
                  if (window.confirm("Switch to LIVE mode? New bot trades will be mirrored to your active broker connection(s).")) {
                    modeMut.mutate("live");
                  }
                }}
              >
                {modeMut.isPending ? "Verifying…" : "→ Live"}
              </button>
            ) : executionMode === "live" ? (
              <button
                className="text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground underline disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!canSwitchBackToPaper || modeMut.isPending}
                title={!canSwitchBackToPaper ? "Broker positions must be confirmed empty before switching to Paper" : "Switch new execution back to Paper"}
                onClick={() => {
                  if (window.confirm("Switch to PAPER mode? New bot trades will no longer be mirrored to your broker.")) {
                    modeMut.mutate("paper");
                  }
                }}
              >
                {modeMut.isPending ? "Verifying…" : "→ Paper"}
              </button>
            ) : (
              <span className="text-[9px] uppercase tracking-wider text-warning">Mode unavailable</span>
            )}

            {brokerConnectionsKnown ? activeConnections.length > 0 ? (
              activeConnections.map((conn: any) => (
                <span key={conn.id} className="text-[10px] font-medium px-1.5 py-0.5 bg-primary/20 text-primary flex items-center gap-1">
                  <Monitor className="h-2.5 w-2.5" /> {conn.display_name} ✓
                </span>
              ))
            ) : (
              <button onClick={() => navigate("/settings")} className="text-[10px] font-medium px-1.5 py-0.5 bg-muted text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
                <Monitor className="h-2.5 w-2.5" /> Connect Broker
              </button>
            ) : (
              <span className="text-[10px] font-medium px-1.5 py-0.5 bg-warning/10 text-warning flex items-center gap-1">
                <Monitor className="h-2.5 w-2.5" /> Broker status unknown
              </span>
            )}

            {/* Trading Style Badge — the persisted runtime policy is authoritative */}
            {(() => {
              const configStyle = getActiveStyle(botConfig);
              const legacyScanStyle = isTradingStyleMode(
                latestRuntimeMeta?.activeStyle,
              )
                ? latestRuntimeMeta.activeStyle
                : null;
              const runtimeStyle = effectiveRuntimeStylePolicy?.style ||
                legacyScanStyle;
              const displayStyle = runtimeStyle || configStyle;
              const meta = STYLE_META[displayStyle as keyof typeof STYLE_META];
              const mismatch = runtimeStyle && runtimeStyle !== configStyle;
              if (meta) {
                const policyTitle = effectiveRuntimeStylePolicy
                  ? `Effective runtime: ${meta.label}; ${effectiveRuntimeStylePolicy.cadence.scanIntervalMinutes}m scan; ${effectiveRuntimeStylePolicy.lifecycle.gamePlanValidityMinutes}m Gameplan; ${effectiveRuntimeStylePolicy.timeframes.runtimeEntry}/${effectiveRuntimeStylePolicy.timeframes.runtimeHTF}; gate ≥${effectiveRuntimeStylePolicy.qualification.effectiveMinConfluence}%; ${effectiveRuntimeStylePolicy.contractVersion} ${effectiveRuntimeStylePolicy.basePolicyHash.slice(0, 12)}`
                  : `Active style: ${meta.label} (legacy scan metadata)`;
                return (
                  <span
                    className={`text-[10px] font-medium px-1.5 py-0.5 border flex items-center gap-1 ${meta.color}`}
                    title={mismatch
                      ? `${policyTitle}. Config is now set to ${STYLE_META[configStyle].label}; save and run a new scan to apply.`
                      : policyTitle}
                  >
                    {meta.icon} {meta.label}{mismatch && " ⟳"}
                  </span>
                );
              }
              return null;
            })()}

            <div className="ml-auto flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => scanMut.mutate()} disabled={!tradingControlsEnabled || scanMut.isPending || scanPolling}>
                {(scanMut.isPending || scanPolling) ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Scan className="h-3 w-3 mr-1" />} {scanPolling ? "Scanning..." : "Scan Now"}
              </Button>
              <div className="w-px h-5 bg-border" />
              <Button size="sm" variant="destructive" className="h-7 text-[11px]" disabled={killMut.isPending} onClick={() => {
                if (window.confirm("⚠️ KILL SWITCH: This will close ALL open positions and halt trading. Are you sure?")) killMut.mutate();
              }}>
                <AlertTriangle className="h-3 w-3 mr-1" /> Kill
              </Button>

              <div className="flex gap-3 text-[10px] text-muted-foreground font-mono">
                <span>Interval: <strong className="text-foreground">{`${botConfig?.entry?.scanIntervalMinutes ?? 15}m`}</strong></span>
                <span>Scans: <strong className="text-foreground">{accountStatusKnown ? d.scanCount : "—"}</strong></span>
                <span>Signals: <strong className="text-foreground">{accountStatusKnown ? d.signalCount : "—"}</strong></span>
                <span>Trades: <strong className="text-foreground">{accountStatusKnown ? d.totalTrades : "—"}</strong></span>
              </div>
            </div>
          </div>
        )}

        {/* Manual Order Form (collapsible) */}
        {orderFormOpen && (
          <div className="py-2 border-b border-border">
            <div className="flex items-end gap-2 flex-wrap">
              <div className="w-24"><Label className="text-[10px]">Type</Label>
                <select value={orderType} onChange={e => setOrderType(e.target.value)} className="w-full bg-card border border-border px-1.5 py-1 text-[11px]">
                  <option value="market">Market</option><option value="buy_limit">Buy Limit</option><option value="sell_limit">Sell Limit</option><option value="buy_stop">Buy Stop</option><option value="sell_stop">Sell Stop</option>
                </select>
              </div>
              <div className="w-24"><Label className="text-[10px]">Symbol</Label>
                <select value={orderSymbol} onChange={e => setOrderSymbol(e.target.value)} className="w-full bg-card border border-border px-1.5 py-1 text-[11px]">
                  {INSTRUMENTS.map(i => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
                </select>
              </div>
              <div className="flex gap-0.5">
                <button onClick={() => setOrderDirection("long")} className={`px-3 py-1 text-[11px] font-medium ${orderDirection === "long" ? "bg-success text-success-foreground" : "bg-secondary text-muted-foreground"}`}>BUY</button>
                <button onClick={() => setOrderDirection("short")} className={`px-3 py-1 text-[11px] font-medium ${orderDirection === "short" ? "bg-destructive text-destructive-foreground" : "bg-secondary text-muted-foreground"}`}>SELL</button>
              </div>
              <div className="w-16"><Label className="text-[10px]">Size</Label><Input value={orderSize} onChange={e => setOrderSize(e.target.value)} className="h-7 text-[11px]" /></div>
              {orderType !== "market" && <div className="w-20"><Label className="text-[10px]">Trigger</Label><Input value={orderTrigger} onChange={e => setOrderTrigger(e.target.value)} className="h-7 text-[11px]" /></div>}
              <div className="w-20"><Label className="text-[10px]">SL</Label><Input value={orderSL} onChange={e => setOrderSL(e.target.value)} className="h-7 text-[11px]" placeholder="0.00000" /></div>
              <div className="w-20"><Label className="text-[10px]">TP</Label><Input value={orderTP} onChange={e => setOrderTP(e.target.value)} className="h-7 text-[11px]" placeholder="0.00000" /></div>
              <div className="w-14"><Label className="text-[10px]">Score</Label><Input type="number" min={0} max={10} value={orderScore} onChange={e => setOrderScore(e.target.value)} className="h-7 text-[11px]" /></div>
              <Button size="sm" className={`h-7 text-[11px] ${orderDirection === "long" ? "bg-success hover:bg-success/80" : "bg-destructive hover:bg-destructive/80"}`} onClick={() => orderMut.mutate()} disabled={!tradingControlsEnabled || orderMut.isPending}>
                {orderDirection === "long" ? "BUY" : "SELL"} {orderSymbol}
              </Button>
            </div>
          </div>
        )}

        {/* Mobile Account Summary Strip — tappable to open full account sheet */}
        {isMobile && (
          <button
            onClick={() => setMobileAccountSheet(true)}
            className="w-full max-w-full min-w-0 overflow-hidden flex items-center gap-0 py-2 px-1 border-b border-border active:bg-secondary/20 transition-colors"
          >
            <div className="flex-1 min-w-0 text-center">
              <div className="text-[9px] text-muted-foreground uppercase truncate">Balance</div>
              <div className="text-[12px] font-mono font-bold truncate">{accountStatusKnown ? "$" + (d.balance || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}</div>
            </div>
            <div className="flex-1 min-w-0 text-center">
              <div className="text-[9px] text-muted-foreground uppercase truncate">Unrealized</div>
              <div className={`text-[12px] font-mono font-bold truncate ${(d.equity - d.balance) >= 0 ? "text-success" : "text-destructive"}`}>
                {accountStatusKnown ? ((d.equity - d.balance) >= 0 ? "+" : "") + formatMoney(d.equity - d.balance) : "—"}
              </div>
            </div>
            <div className="flex-1 min-w-0 text-center">
              <div className="text-[9px] text-muted-foreground uppercase">WR</div>
              <div className={`text-[12px] font-mono font-bold ${(d.winRate || 0) >= 50 ? "text-success" : "text-destructive"}`}>
                {accountStatusKnown ? (d.winRate || 0).toFixed(0) + "%" : "—"}
              </div>
            </div>
            <div className="flex-1 min-w-0 text-center">
              <div className="text-[9px] text-muted-foreground uppercase">Trades</div>
              <div className="text-[12px] font-mono font-bold">{accountStatusKnown ? d.totalTrades : "—"}</div>
            </div>
            <div className="flex-1 min-w-0 text-center">
              <div className="text-[9px] text-muted-foreground uppercase">DD</div>
              <div className="text-[12px] font-mono font-bold">{accountStatusKnown ? (d.drawdown || 0).toFixed(1) + "%" : "—"}</div>
            </div>
          </button>
        )}

        {/* Main workspace: 65/35 split */}
        <div className="flex-1 flex flex-col md:flex-row gap-3 mt-2 min-h-0 min-w-0 max-w-full overflow-x-hidden">
          {/* Left: Tabbed Positions — expands to full width when sidebar hidden */}
          <div className={`${showSidebar ? "flex-[2]" : "flex-1"} flex flex-col min-h-0 min-w-0 md:min-h-0`}>
            <Tabs defaultValue="open" value={botTab} onValueChange={setBotTab} className="flex-1 flex flex-col min-h-0 min-w-0 max-w-full overflow-x-hidden">
              {(() => {
                const tabs: [string, string][] = [
                  ["open", `Open (${botPositions.length})`],
                  ["today", `Closed Today (${closedToday.length})`],
                  ["history", "All History"],
                  ["audit", "Close Audit"],
                  ["broker-log", "Broker Log"],
                  ["ai-advisor", "Advisor"],
                  ["broker-live", "MT4/MT5 Live"],
                  ["watchlist", "Watchlist"],
                  ["pending-orders", "Zone Setups"],
                  ["game-plan", "Game Plan"],
                ];
                return (
                  <>
                    {isMobile ? (
                      <Select value={botTab} onValueChange={setBotTab}>
                        <SelectTrigger className="h-8 w-full text-[11px] uppercase tracking-wider font-semibold rounded-none bg-card border border-border">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {tabs.map(([val, label]) => (
                            <SelectItem key={val} value={val} className="text-[12px] uppercase tracking-wider">
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <TabsList className="h-7 shrink-0 overflow-x-auto bg-card border border-border rounded-none p-0 gap-0 justify-start">
                        {tabs.map(([val, label]) => (
                          <TabsTrigger
                            key={val}
                            value={val}
                            className="text-[10px] h-7 px-3 rounded-none uppercase tracking-wider font-semibold text-muted-foreground border-r border-border data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-b-primary"
                          >{label}</TabsTrigger>
                        ))}
                      </TabsList>
                    )}
                  </>
                );
              })()}
              <TabsContent value="open" className="flex-1 overflow-y-auto overflow-x-hidden mt-1 min-w-0 max-w-full">
                {!accountStatusKnown ? (
                  <div className="flex flex-col items-center justify-center py-12 border border-warning/30 text-warning">
                    <AlertTriangle className="h-6 w-6 mb-2" />
                    <p className="text-xs font-medium">Open-position state unavailable</p>
                  </div>
                ) : botPositions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 border border-dashed border-border">
                    <Plus className="h-8 w-8 text-muted-foreground/20 mb-2" />
                    <p className="text-xs font-medium text-muted-foreground">No open positions</p>
                    <p className="text-[10px] text-muted-foreground/70 mt-1">Click "+ Order" to place a trade or start the bot scanner</p>
                  </div>
                ) : isMobile ? (
                  /* Mobile: card-based positions */
                  <div className="divide-y divide-border/40">
                    {botPositions.map((p: any) => (
                      <MobilePositionCard
                        key={p.id}
                        position={p}
                        mutationsEnabled={tradingControlsEnabled}
                        closeEnabled={Boolean(p.id)}
                        isExpanded={expandedPosition === p.id}
                        onToggle={() => setExpandedPosition(expandedPosition === p.id ? null : p.id)}
                        onClose={(id) => {
                          if (window.confirm(`Close ${p.symbol} ${p.direction} position?`)) {
                            void closePositionFromDashboard(id);
                          }
                        }}
                        onSaved={() => queryClient.invalidateQueries({ queryKey: ["paper-status"] })}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="overflow-x-auto border border-border border-t-0 bg-card"><table className="w-full text-[11px] font-mono min-w-[800px]">
                    <thead className="bg-card/60"><tr className="border-b border-border text-muted-foreground text-[9px] uppercase tracking-wider font-semibold font-sans">
                      <th className="text-center py-1.5 px-1 w-6">#</th>
                      <th className="text-left py-1.5 px-1">Opened</th>
                      <th className="text-left py-1.5 px-1">Symbol</th><th className="text-left py-1.5 px-1">Dir</th>
                      <th className="text-right py-1.5 px-1">Entry</th><th className="text-right py-1.5 px-1">Current</th>
                      <th className="text-right py-1.5 px-1">Pips</th>
                      <th className="text-right py-1.5 px-1">P&amp;L</th>
                      <th className="text-right py-1.5 px-1">R</th>
                      <th className="text-center py-1.5 px-1">BE</th>
                      <th className="text-right py-1.5 px-1">SL</th><th className="text-right py-1.5 px-1">TP</th>
                      <th className="text-center py-1.5 px-1">Trail</th>
                      <th className="text-center py-1.5 px-1">Hold</th>
                      <th className="py-1.5 px-1"></th>
                    </tr></thead>
                    <tbody>
                      {botPositions.map((p: any, idx: number) => {
                        // Parse exitFlags for management columns
                        let sr: any = {};
                        try { sr = JSON.parse(p.signalReason || "{}"); } catch {}
                        let ef: any = sr.exitFlags || {};
                        const inst = INSTRUMENTS.find((i: any) => i.symbol === p.symbol);
                        const pipSize = inst?.pipSize || 0.0001;
                        const entry = parseFloat(p.entryPrice);
                        const current = parseFloat(p.currentPrice);
                        const sl = p.stopLoss ? parseFloat(p.stopLoss) : null;
                        // Original SL for R-multiple: prefer stored originalSL, else current SL if management hasn't fired
                        const origSl = sr.originalSL != null ? parseFloat(sr.originalSL) : sl;
                        // R-multiple calculation (uses original SL as risk denominator)
                        const riskPips = origSl !== null ? Math.abs(entry - origSl) / pipSize : 0;
                        const profitPips = p.direction === "long" ? (current - entry) / pipSize : (entry - current) / pipSize;
                        const rMult = riskPips > 0 ? profitPips / riskPips : 0;
                        // BE status
                        const beEnabled = ef.breakEvenEnabled ?? ef.breakEven ?? false;
                        const beFired = ef.breakEvenActivated === true;
                        const beActivationR = riskPips > 0 ? Math.min(2.0, Math.max(1.0, (ef.breakEvenPips || 0) / riskPips)) : 1.0;
                        // Trail status
                        const trailEnabled = ef.trailingStopEnabled ?? ef.trailingStop ?? false;
                        const trailFired = ef.trailingStopActivated === true;
                        const trailActivationR = ef.trailingActivationR || 1.0;
                        const trailLevel = ef.currentTrailLevel ? parseFloat(ef.currentTrailLevel) : null;
                        // Hold time — live config override: if user toggled maxHold off globally, show Off
                        const liveMaxHoldOff = botConfig?.exit?.maxHoldEnabled === false || botConfig?.exit?.timeBasedExitEnabled === false;
                        const holdEnabled = !liveMaxHoldOff && ef.maxHoldEnabled !== false && ef.maxHoldHours && ef.maxHoldHours > 0;
                        const openMs = new Date(p.openTime).getTime();
                        const holdHours = (Date.now() - openMs) / 3600000;
                        const holdPct = holdEnabled ? holdHours / ef.maxHoldHours : 0;
                        return (
                        <React.Fragment key={p.id}>
                          <tr className={`border-b border-border/30 hover:bg-secondary/30 cursor-pointer ${idx % 2 === 1 ? "bg-secondary/10" : ""}`}
                            onClick={() => setExpandedPosition(expandedPosition === p.id ? null : p.id)}>
                            <td className="py-1.5 px-1 text-center text-muted-foreground text-[10px]">{idx + 1}</td>
                            <td className="py-1.5 px-1 text-muted-foreground text-[10px] whitespace-nowrap">{new Date(p.openTime).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })} {new Date(p.openTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</td>
                            <td className="py-1.5 px-1 font-medium"><span className="inline-flex items-center gap-1">{p.symbol}<OverrideBadge position={p} /></span></td>
                            <td className={`py-1.5 px-1 ${p.direction === "long" ? "text-success" : "text-destructive"}`}>{p.direction === "long" ? "▲" : "▼"}</td>
                            <td className="py-1.5 px-1 text-right">{entry.toFixed(5)}</td>
                            <td className="py-1.5 px-1 text-right">{current.toFixed(5)}</td>
                            <td className={`py-1.5 px-1 text-right font-medium ${profitPips >= 0 ? "text-success" : "text-destructive"}`}>{profitPips >= 0 ? "+" : ""}{profitPips.toFixed(1)}</td>
                            <td className={`py-1.5 px-1 text-right font-medium ${p.pnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(p.pnl, true)}</td>
                            <td className={`py-1.5 px-1 text-right font-bold ${rMult >= 0 ? "text-success" : "text-destructive"}`}>{rMult >= 0 ? "+" : ""}{rMult.toFixed(1)}R</td>
                            <td className="py-1.5 px-1 text-center text-[10px]">
                              {!beEnabled ? <span className="text-muted-foreground">—</span>
                                : beFired ? <span className="text-success" title="Break-even active">✅</span>
                                : <span className="text-muted-foreground" title={`Triggers at ${beActivationR.toFixed(1)}R`}>⏳{beActivationR.toFixed(1)}R</span>}
                            </td>
                            <td className="py-1.5 px-1 text-right">{sl !== null ? sl.toFixed(5) : "—"}</td>
                            <td className="py-1.5 px-1 text-right">{p.takeProfit ? parseFloat(p.takeProfit).toFixed(5) : "—"}</td>
                            <td className="py-1.5 px-1 text-center text-[10px]">
                              {!trailEnabled ? <span className="text-muted-foreground">—</span>
                                : trailFired ? <span className={trailLevel ? "text-cyan-400" : "text-success"} title={trailLevel ? `Trail at ${trailLevel.toFixed(5)}` : "Trailing active"}>{trailLevel ? `🟢${trailLevel.toFixed(inst?.pipSize === 0.01 ? 3 : 5)}` : "🟢"}</span>
                                : <span className="text-muted-foreground" title={`Triggers at ${trailActivationR.toFixed(1)}R`}>⏳{trailActivationR.toFixed(1)}R</span>}
                            </td>
                            <td className={`py-1.5 px-1 text-center text-[10px] ${holdEnabled ? (holdPct >= 0.9 ? "text-destructive" : holdPct >= 0.75 ? "text-highlight" : "text-muted-foreground") : "text-muted-foreground"}`}>
                              {!holdEnabled ? "Off" : `${holdHours.toFixed(1)}h/${ef.maxHoldHours}h`}
                            </td>
                            <td className="py-1.5 px-1" onClick={e => e.stopPropagation()}>
                              <button
                                disabled={!p.id}
                                onClick={() => {
                                  if (window.confirm(`Close ${p.symbol} ${p.direction} position?`)) {
                                    void closePositionFromDashboard(p.id);
                                  }
                                }}
                                className="text-destructive hover:bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                              >✕ Close</button>
                            </td>
                          </tr>
                          {expandedPosition === p.id && (
                            <tr>
                              <td colSpan={15} className="border-b border-border p-2">
                                <fieldset disabled={!tradingControlsEnabled} className="contents disabled:opacity-60">
                                  <ExpandedPositionCard position={p} onSaved={() => queryClient.invalidateQueries({ queryKey: ["paper-status"] })} />
                                </fieldset>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table></div>
                )}
              </TabsContent>
              <TabsContent value="today" className="flex-1 overflow-y-auto overflow-x-hidden mt-1 min-w-0 max-w-full">
                {accountStatusKnown ? <TradeHistoryTable trades={closedToday} /> : <ReadUnavailable label="Trade history" />}
              </TabsContent>
              <TabsContent value="history" className="flex-1 overflow-y-auto overflow-x-hidden mt-1 min-w-0 max-w-full">
                {accountStatusKnown ? <TradeHistoryTable trades={botTradeHistory} /> : <ReadUnavailable label="Trade history" />}
              </TabsContent>
              <TabsContent value="audit" className="flex-1 overflow-hidden mt-1">
                {brokerConnectionsKnown ? <CloseAuditLog brokerConns={brokerConns} /> : <ReadUnavailable label="Broker audit" />}
              </TabsContent>
              <TabsContent value="broker-log" className="flex-1 overflow-hidden mt-1">
                <BrokerLog />
              </TabsContent>
              <TabsContent value="ai-advisor" className="flex-1 overflow-y-auto overflow-x-hidden mt-1 min-w-0 max-w-full">
                <RecommendationsDashboard botId="smc" />
              </TabsContent>
              <TabsContent value="broker-live" className="flex-1 overflow-y-auto overflow-x-hidden mt-1 min-w-0 max-w-full">
                <BrokerTradesTab mutationsAllowed={tradingControlsEnabled} />
              </TabsContent>
              <TabsContent value="watchlist" className="flex-1 overflow-y-auto overflow-x-hidden mt-1 min-w-0 max-w-full">
                <WatchlistPanel confluenceGate={(() => {
                  const effectiveGate =
                    effectiveRuntimeStylePolicy?.qualification
                      .effectiveMinConfluence;
                  if (typeof effectiveGate === "number") return effectiveGate;
                  return botConfig?.strategy?.confluenceThreshold ?? 55;
                })()} />
              </TabsContent>
              <TabsContent value="pending-orders" className="flex-1 overflow-y-auto overflow-x-hidden mt-1 min-w-0 max-w-full">
                <PendingOrdersPanel />
              </TabsContent>
              <TabsContent value="game-plan" className="flex-1 overflow-y-auto overflow-x-hidden mt-1 min-w-0 max-w-full">
                <GamePlanPanel />
              </TabsContent>
            </Tabs>
          </div>

          {/* Sidebar toggle — desktop only */}
          {!isMobile && (
          <button
            onClick={toggleSidebar}
            className="hidden md:flex items-center justify-center w-5 h-10 my-auto rounded-l border border-r-0 border-border bg-card hover:bg-secondary/50 transition-colors self-center shrink-0"
            title={showSidebar ? "Hide sidebar" : "Show sidebar"}
          >
            {showSidebar ? <PanelRightClose className="h-3 w-3 text-muted-foreground" /> : <PanelRightOpen className="h-3 w-3 text-muted-foreground" />}
          </button>
          )}

          {/* Right sidebar (~35%) — desktop only, mobile uses account sheet */}
          {!isMobile && showSidebar && (
          <div className="flex-1 overflow-y-auto space-y-2 md:max-w-none">

            {/* Account Summary */}
            {(() => {
              if (!accountStatusKnown) {
                return (
                  <div className="border border-warning/30 bg-warning/5 p-3 text-[10px] text-warning">
                    Account balances, exposure, and performance are unavailable.
                  </div>
                );
              }
              const positions = botPositions;
              const unrealizedPnl = positions.reduce((s: number, p: any) => s + (p.pnl || 0), 0);
              const totalExposure = positions.reduce((s: number, p: any) => s + (parseFloat(p.size) || 0), 0);
              const longCount = positions.filter((p: any) => p.direction === "long").length;
              const shortCount = positions.filter((p: any) => p.direction === "short").length;
              const bestPos = positions.length > 0 ? positions.reduce((best: any, p: any) => (p.pnl || 0) > (best.pnl || 0) ? p : best, positions[0]) : null;
              const worstPos = positions.length > 0 ? positions.reduce((worst: any, p: any) => (p.pnl || 0) < (worst.pnl || 0) ? p : worst, positions[0]) : null;
              const equity = parseFloat(d.balance) + unrealizedPnl;
              const profitPct = (((parseFloat(d.balance) - 10000) / 10000) * 100);
              const history = botTradeHistory;
              const totalRealizedPnl = history.reduce((s: number, t: any) => s + (parseFloat(t.pnl) || 0), 0);
              const grossProfit = history.filter((t: any) => parseFloat(t.pnl) >= 0).reduce((s: number, t: any) => s + (parseFloat(t.pnl) || 0), 0);
              const grossLoss = Math.abs(history.filter((t: any) => parseFloat(t.pnl) < 0).reduce((s: number, t: any) => s + (parseFloat(t.pnl) || 0), 0));
              const avgWin = d.wins > 0 ? grossProfit / d.wins : 0;
              const avgLoss = d.losses > 0 ? -(grossLoss / d.losses) : 0;
              const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

              const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => (
                <div className="border border-border bg-card">
                  <div className="bg-card/60 px-2 py-1 border-b border-border">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
                  </div>
                  <div className="divide-y divide-border/40 font-mono text-[11px]">{children}</div>
                </div>
              );
              const Row = ({ label, value, valueClass = "" }: { label: string; value: React.ReactNode; valueClass?: string }) => (
                <div className="flex justify-between items-center px-2 py-1">
                  <span className="text-muted-foreground text-[10px] uppercase tracking-wide font-sans">{label}</span>
                  <span className={`tabular-nums ${valueClass}`}>{value}</span>
                </div>
              );
              return (
                <>
                  <Panel title="Account">
                    <Row label="Balance" value={formatMoney(d.balance)} valueClass="font-bold text-foreground" />
                    <Row label="Equity" value={formatMoney(equity)} valueClass="text-foreground" />
                    <Row label="Unrealized P&L" value={formatMoney(unrealizedPnl, true)} valueClass={`font-bold ${unrealizedPnl >= 0 ? "text-success" : "text-destructive"}`} />
                    <Row label="Daily P&L" value={formatMoney(d.dailyPnl, true)} valueClass={d.dailyPnl >= 0 ? "text-success" : "text-destructive"} />
                    <Row label="Total Return" value={`${profitPct >= 0 ? "+" : ""}${profitPct.toFixed(2)}%`} valueClass={profitPct >= 0 ? "text-success" : "text-destructive"} />
                    <Row label="Drawdown" value={`${(d.drawdown || 0).toFixed(1)}%`} valueClass={(d.drawdown || 0) > 10 ? "text-destructive" : (d.drawdown || 0) > 5 ? "text-warning" : "text-foreground"} />
                  </Panel>

                  <Panel title="Exposure">
                    <Row label="Open Positions" value={positions.length} valueClass="font-bold text-foreground" />
                    <Row label="Long / Short" value={<><span className="text-success">{longCount}L</span> / <span className="text-destructive">{shortCount}S</span></>} />
                    <Row label="Total Lots" value={totalExposure.toFixed(2)} valueClass="text-foreground" />
                    {bestPos && bestPos.pnl !== 0 && (
                      <Row label="Best Open" value={<span className="text-[10px]">{bestPos.symbol} {formatMoney(bestPos.pnl, true)}</span>} valueClass="text-success" />
                    )}
                    {worstPos && worstPos.pnl !== 0 && (
                      <Row label="Worst Open" value={<span className="text-[10px]">{worstPos.symbol} {formatMoney(worstPos.pnl, true)}</span>} valueClass="text-destructive" />
                    )}
                  </Panel>

                  <Panel title="Performance">
                    <Row label="Win Rate" value={`${(d.winRate || 0).toFixed(1)}%`} valueClass={`font-bold ${(d.winRate || 0) >= 50 ? "text-success" : "text-destructive"}`} />
                    <Row label="Win / Loss" value={<><span className="text-success">{d.wins}W</span> / <span className="text-destructive">{d.losses}L</span></>} />
                    <Row label="Total Trades" value={d.totalTrades} valueClass="text-foreground" />
                    <Row label="Realized P&L" value={formatMoney(totalRealizedPnl, true)} valueClass={totalRealizedPnl >= 0 ? "text-success" : "text-destructive"} />
                    <Row label="Avg Win" value={formatMoney(avgWin, true)} valueClass="text-success" />
                    <Row label="Avg Loss" value={formatMoney(avgLoss, true)} valueClass="text-destructive" />
                    <Row label="Profit Factor" value={profitFactor > 0 ? profitFactor.toFixed(2) : "—"} valueClass="text-foreground" />
                    <Row label="Rejected" value={d.rejectedCount} valueClass="text-warning" />
                  </Panel>
                </>
              );
            })()}

            {/* FOTSI Currency Strength Meter */}
            <FOTSIStrengthMeter
              strengths={fotsiStrengths}
              lastScanTime={currentScan?.scanned_at}
              onRefresh={tradingControlsEnabled ? () => scanMut.mutate() : undefined}
              isRefreshing={scanMut.isPending}
            />

            {/* Engine Controls */}
            <Card>
              <CardContent className="pt-3 pb-2 space-y-2 text-[11px]">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Engine</p>
                <Button size="sm" variant="outline" className="w-full h-7 text-[11px]" onClick={() => scanMut.mutate()} disabled={!tradingControlsEnabled || scanMut.isPending || scanPolling}>
                  {(scanMut.isPending || scanPolling) ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Scan className="h-3 w-3 mr-1" />} {scanPolling ? "Scanning..." : "Manual Scan"}
                </Button>
                {/* Set Balance — inline expandable */}
                <Button size="sm" variant="outline" className="w-full h-7 text-[11px] border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10" onClick={() => setShowSetBalance(!showSetBalance)} disabled={!tradingControlsEnabled}>
                  <Settings className="h-3 w-3 mr-1" /> Set Balance
                </Button>
                {showSetBalance && (
                  <div className="flex gap-1.5 items-center">
                    <div className="relative flex-1">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">$</span>
                      <Input
                        type="number"
                        min="0"
                        step="100"
                        placeholder="e.g. 50000"
                        value={customBalanceInput}
                        onChange={(e) => setCustomBalanceInput(e.target.value)}
                        className="h-7 text-[11px] pl-5 font-mono"
                        disabled={!tradingControlsEnabled}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && tradingControlsEnabled) {
                            const val = parseFloat(customBalanceInput);
                            if (!isNaN(val) && val >= 0) setBalMut.mutate(val);
                          }
                        }}
                      />
                    </div>
                    <Button
                      size="sm"
                      className="h-7 text-[11px] px-3 bg-cyan-600 hover:bg-cyan-700 text-white"
                      disabled={!tradingControlsEnabled || setBalMut.isPending || !customBalanceInput || isNaN(parseFloat(customBalanceInput)) || parseFloat(customBalanceInput) < 0}
                      onClick={() => {
                        const val = parseFloat(customBalanceInput);
                        if (!isNaN(val) && val >= 0) setBalMut.mutate(val);
                      }}
                    >
                      {setBalMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Apply"}
                    </Button>
                  </div>
                )}
                <Button size="sm" variant="outline" className="w-full h-7 text-[11px] border-amber-500/30 text-warn hover:bg-badge-warn" onClick={() => {
                  if (window.confirm("Reset balance to configured starting amount?\n\nThis will reset your balance, peak balance, and daily PnL counters.\n\nYour positions, trade history, scan logs, and reasonings will be PRESERVED.")) resetBalMut.mutate();
                }} disabled={!tradingControlsEnabled || resetBalMut.isPending}>
                  {resetBalMut.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />} Reset Balance
                </Button>
                <Button size="sm" variant="outline" className="w-full h-7 text-[11px] border-destructive/30 text-destructive hover:bg-destructive/10" onClick={() => {
                  if (window.confirm("⚠️ FULL RESET — This will:\n\n• Close all open positions\n• Delete ALL trade history\n• Delete ALL scan logs\n• Delete ALL reasonings & post-mortems\n• Reset balance to configured starting amount\n• Stop the engine\n\nThis CANNOT be undone. Are you sure?")) resetMut.mutate();
                }} disabled={!tradingControlsEnabled || resetMut.isPending}>
                  {resetMut.isPending ? <Loader2 className="h-3 w-3 mr-1" /> : null} Full Reset
                </Button>
              </CardContent>
            </Card>

            {/* Live Broker Account (only in live mode) */}
            {isLiveMode && activeConnections.length > 0 && (
              <Card>
                <CardContent className="pt-3 pb-2 space-y-1.5 text-[11px]">
                  {activeConnections.length > 1 && (
                    <select
                      value={selectedConnIdx}
                      onChange={e => setSelectedConnIdx(Number(e.target.value))}
                      className="w-full bg-card border border-border px-1.5 py-1 text-[10px] mb-1"
                    >
                      {activeConnections.map((c: any, i: number) => (
                        <option key={c.id} value={i}>{c.display_name} ({c.broker_type})</option>
                      ))}
                    </select>
                  )}
                  <p className="text-[10px] text-destructive uppercase tracking-wider mb-1 font-bold">Live Broker — {selectedConnection?.display_name}</p>
                  {selectedConnectionStateQuery?.isError ? (
                    <p className="text-warning text-[10px]">{selectedConnectionStateQuery.error instanceof Error ? selectedConnectionStateQuery.error.message : "Broker connection status unavailable"}</p>
                  ) : selectedConnectionStateQuery?.data?.ready === false ? (
                    <p className="text-warning text-[10px]">Broker connection is not ready</p>
                  ) : brokerAccountReadFailed ? (
                    <p className="text-warning text-[10px]">{brokerAccountReadError instanceof Error ? brokerAccountReadError.message : "Broker account unavailable"}</p>
                  ) : brokerAccount ? (
                    <>
                      <div className="flex justify-between"><span className="text-muted-foreground">Balance</span><span className="font-mono font-bold">{brokerAccount.balance ?? brokerAccount.equity ?? "—"} {brokerAccount.currency || ""}</span></div>
                      {brokerAccount.equity && <div className="flex justify-between"><span className="text-muted-foreground">Equity</span><span className="font-mono">{brokerAccount.equity} {brokerAccount.currency || ""}</span></div>}
                      {brokerAccount.margin != null && <div className="flex justify-between"><span className="text-muted-foreground">Margin Used</span><span className="font-mono">{brokerAccount.margin}</span></div>}
                      {brokerAccount.freeMargin != null && <div className="flex justify-between"><span className="text-muted-foreground">Free Margin</span><span className="font-mono">{brokerAccount.freeMargin}</span></div>}
                      {brokerAccount.marginLevel != null && <div className="flex justify-between"><span className="text-muted-foreground">Margin Level</span><span className="font-mono">{brokerAccount.marginLevel}%</span></div>}
                      {brokerAccount.leverage && <div className="flex justify-between"><span className="text-muted-foreground">Leverage</span><span className="font-mono">1:{brokerAccount.leverage}</span></div>}
                    </>
                  ) : (
                    <p className="text-muted-foreground text-[10px]">Loading broker data...</p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Live Broker Open Trades */}
            {isLiveMode && selectedConnection && (
              <Card>
                <CardContent className="pt-3 pb-2 space-y-1.5 text-[11px]">
                  <p className="text-[10px] text-destructive uppercase tracking-wider mb-1 font-bold">Broker Positions</p>
                  {brokerPositionsReadFailed ? (
                    <p className="text-warning text-[10px]">{brokerPositionsReadError instanceof Error ? brokerPositionsReadError.message : "Broker positions unavailable"}</p>
                  ) : !brokerOpenTrades ? (
                    <p className="text-muted-foreground text-[10px]">Loading broker positions...</p>
                  ) : brokerOpenTrades.length === 0 ? (
                    <p className="text-muted-foreground text-[10px]">No open positions reported by broker</p>
                  ) : brokerOpenTrades.slice(0, 10).map((t: any, i: number) => (
                    <div key={t.id || i} className="flex items-center justify-between text-[10px] py-0.5 border-b border-border/20 last:border-0">
                      <div className="flex items-center gap-1">
                        <span className={t.type === "SELL" || t.currentUnits < 0 || t.type === "POSITION_TYPE_SELL" ? "text-destructive" : "text-success"}>
                          {t.type === "SELL" || t.currentUnits < 0 || t.type === "POSITION_TYPE_SELL" ? "▼" : "▲"}
                        </span>
                        <span className="font-mono font-medium">{t.instrument || t.symbol}</span>
                      </div>
                      <span className={`font-mono ${parseFloat(t.unrealizedPL || t.profit || t.unrealizedProfit || 0) >= 0 ? "text-success" : "text-destructive"}`}>
                        {formatMoney(parseFloat(t.unrealizedPL || t.profit || t.unrealizedProfit || 0), true)}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

          </div>
          )}
        </div>

        {/* Secondary footer band: equity curve + recent closed trades */}
        {/* Bottom: Scan Master-Detail 60/40 */}
        <div className={`border border-border bg-card mt-2 flex flex-col min-h-0 min-w-0 max-w-full overflow-hidden ${showScanPanel ? `flex-1 ${isMobile ? "min-h-[20rem]" : "min-h-[28rem]"}` : "shrink-0"}`}>
          {/* Scan panel header — always visible for toggle */}
          <div
            onClick={isMobile ? toggleScanPanel : undefined}
            className={`flex flex-col md:flex-row md:items-center md:justify-between gap-1 md:gap-2 bg-card/60 border-b border-border px-2 py-1.5 md:py-1 min-w-0 max-w-full overflow-hidden ${isMobile ? "cursor-pointer active:bg-secondary/40 transition-colors" : ""}`}
          >
            <div className="flex items-center gap-1.5 min-w-0 max-w-full">
              <button
                onClick={(e) => { e.stopPropagation(); toggleScanPanel(); }}
                className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors uppercase tracking-wider"
                title={showScanPanel ? "Hide scan results" : "Show scan results"}
              >
                {showScanPanel ? <Eye className="h-3.5 w-3.5 md:h-3 md:w-3" /> : <EyeOff className="h-3.5 w-3.5 md:h-3 md:w-3" />}
                {showScanPanel ? <ChevronDown className="h-3 w-3 md:h-2.5 md:w-2.5" /> : <ChevronUp className="h-3 w-3 md:h-2.5 md:w-2.5" />}
              </button>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 font-semibold min-w-0 flex-1">
                <span className="truncate">{safeScanIdx === 0 ? "Latest Scan" : `Scan #${safeScanIdx + 1} of ${logs.length}`}</span>
                {currentScan?.scanned_at && (
                  <span className="shrink-0 text-foreground font-mono normal-case">
                    — {formatTimeOnly(currentScan.scanned_at)}
                  </span>
                )}
                {(selectedScanStylePolicy?.style || latestMeta?.activeStyle) && (() => {
                  const style = selectedScanStylePolicy?.style || latestMeta.activeStyle;
                  const sm = STYLE_META[style as keyof typeof STYLE_META];
                  return sm ? <span className={`shrink-0 text-[9px] font-medium px-1 py-0 border rounded-sm ${sm.color}`}>{sm.icon} {sm.label}</span> : null;
                })()}
                {logs.length > 1 && (
                  <span className="inline-flex items-center gap-0.5 shrink-0 ml-auto" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={(e) => { e.stopPropagation(); setSelectedScanIdx(i => Math.min(logs.length - 1, i + 1)); setSelectedPairIdx(0); }}
                      disabled={safeScanIdx >= logs.length - 1}
                      className="px-1.5 py-0.5 h-6 md:h-5 w-[52px] text-[10px] md:text-[9px] rounded border border-border hover:bg-secondary/50 disabled:opacity-30 disabled:cursor-not-allowed text-center"
                      title="Older scan"
                    >‹ older</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setSelectedScanIdx(i => Math.max(0, i - 1)); setSelectedPairIdx(0); }}
                      disabled={safeScanIdx <= 0}
                      className="px-1.5 py-0.5 h-6 md:h-5 w-[52px] text-[10px] md:text-[9px] rounded border border-border hover:bg-secondary/50 disabled:opacity-30 disabled:cursor-not-allowed text-center"
                      title="Newer scan"
                    >newer ›</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setSelectedScanIdx(0); setSelectedPairIdx(0); }}
                      className={`px-1.5 py-0.5 h-6 md:h-5 w-[44px] text-[10px] md:text-[9px] rounded border border-primary/40 text-primary hover:bg-primary/10 text-center ${safeScanIdx === 0 ? 'invisible' : ''}`}
                      title="Jump to latest"
                      disabled={safeScanIdx === 0}
                    >latest</button>
                  </span>
                )}

              </div>
            </div>
            <div className="flex items-center gap-1.5 min-w-0 max-w-full overflow-hidden md:flex-wrap md:shrink-0">
              <SessionStatusPill sessions={botConfig?.sessions} scanDetails={latestRawDetails} className="min-w-0 max-w-full truncate" />
              {(selectedScanStylePolicy || botConfig?.strategy) && (() => {
                const configuredGate = botConfig?.strategy?.confluenceThreshold ?? 55;
                const resolvedGate =
                  selectedScanStylePolicy?.qualification
                    .effectiveMinConfluence ?? configuredGate;
                const style = selectedScanStylePolicy?.style ||
                  getActiveStyle(botConfig);
                const styleLabel = STYLE_META[style]?.label || style;
                const preservedOverrides =
                  selectedScanStylePolicy?.provenance.userOverridesPreserved
                    .length ?? 0;
                return (
                  <Badge
                    variant="outline"
                    className="hidden md:inline-flex text-[8px] font-mono px-1.5 py-0 h-4 border-primary/40 text-primary"
                    title={selectedScanStylePolicy
                      ? `Effective policy for this scan: ${styleLabel}; gate ≥${resolvedGate}%; ${selectedScanStylePolicy.cadence.scanIntervalMinutes}m cadence; ${preservedOverrides} explicit override(s) preserved.`
                      : `No policy snapshot on this scan. Showing configured confluence gate ≥${resolvedGate}%.`}
                  >
                    Effective: {styleLabel} · ≥{resolvedGate}%
                  </Badge>
                );
              })()}
              {currentScan && (
                <span className="flex items-center gap-1 text-[9px] text-muted-foreground min-w-0 shrink-0 overflow-hidden">
                  <DataSourceBadge source={latestSource} />
                  <span className="hidden md:inline">
                    {currentScan?.pairs_scanned || 0} pairs · {currentScan?.signals_found || 0} signals · {currentScan?.trades_placed || 0} trades
                  </span>
                  <span className="md:hidden shrink-0">{currentScan?.pairs_scanned || 0}p · {currentScan?.signals_found || 0}s · {currentScan?.trades_placed || 0}t</span>
                </span>
              )}
            </div>
          </div>

          {/* Scan content — conditionally rendered */}
          {showScanPanel && (
          <>
          <div className="flex-1 flex flex-col md:flex-row gap-0 min-h-0 border-t border-border">
            {/* Left: Latest Scan Pairs (60%) */}
            <div className="w-full md:w-[60%] flex flex-col min-h-0 md:border-r border-border max-h-64 md:max-h-none">
              <div className="flex-1 overflow-y-auto overflow-x-hidden max-w-full">
                {(() => {
                    if (latestDetailsClean.length === 0) {
                      return <p className="text-[10px] text-muted-foreground text-center py-8">No scans yet — click "Scan Now"</p>;
                    }
                    return (
                      <div className="divide-y divide-border/40">
                        {latestDetailsClean.map((sig: any, i: number) => {
                          const s = sig.status as string | undefined;
                          const statusLabel = s === "limit_order_from_watchlist" || s === "zone_setup_from_watchlist" ? "🔍📋 ZONE+WL" : s === "limit_order_placed" || s === "zone_setup_active" ? "🔍 ZONE SETUP" : s === "trade_placed_from_watchlist" ? "📋 WATCHLIST" : s === "trade_placed_at_zone" ? "✅ PLACED@ZONE" : s === "trade_placed" ? "✅ PLACED" : s === "rejected" ? "REJECTED" : s === "below_threshold" ? "SKIP" : s === "watching_zone" ? "⏳ WATCHING" : s === "watchlist_persistence_failed" ? "⚠ WATCHLIST ERROR" : s === "waiting_zone_untracked" ? "ZONE AWAY" : s === "waiting_for_sweep" ? "⏳ SWEEP WAIT" : s === "waiting_for_reconfirmation" ? "⏳ RECONFIRM" : s === "paused" ? "⏸ PAUSED" : s === "no_direction" ? "— NO DIR" : s === "zone_setup_rejected_orientation" ? "⚠ ORIENT" : s === "staged_new" ? "\u2B50 NEW WATCH" : s === "staged_watching" ? "\uD83D\uDC41 WATCHING" : s === "staged_confirming" ? "\u23F3 CONFIRMING" : s === "staged_invalidated" ? "\u274C INVALIDATED" : s?.startsWith("skipped_") ? "SKIPPED" : s?.toUpperCase() || "\u2014";
                          const statusColor = s === "limit_order_from_watchlist" || s === "zone_setup_from_watchlist" ? "text-tier3 bg-purple-500/10 border-purple-500/30" : s === "limit_order_placed" || s === "zone_setup_active" ? "text-info-c bg-badge-info border-blue-500/30" : s === "trade_placed_from_watchlist" ? "text-cyan-400 bg-cyan-500/10 border-cyan-500/30" : s?.startsWith("trade_placed") ? "text-success bg-success/10 border-success/30" : s === "rejected" || s === "zone_setup_rejected_orientation" || s === "watchlist_persistence_failed" ? "text-destructive bg-destructive/10 border-destructive/30" : s === "watching_zone" || s === "waiting_zone_untracked" ? "text-warn bg-badge-warn border-amber-500/30" : s === "waiting_for_sweep" ? "text-purple-400 bg-purple-500/10 border-purple-500/30" : s === "waiting_for_reconfirmation" ? "text-orange-400 bg-orange-500/10 border-orange-500/30" : s === "paused" || s === "no_direction" ? "text-zinc-400 bg-zinc-500/10 border-zinc-500/30" : s?.startsWith("staged_") ? "text-warn bg-badge-warn border-amber-500/30" : "text-muted-foreground bg-muted/20 border-border";
                          const isSelected = selectedPairIdx === i;
                          return (
                            <button
                              key={i}
                              onClick={() => { setSelectedPairIdx(i); if (isMobile) setMobileScanDetailSheet(true); }}
                              className={`w-full max-w-full min-w-0 flex items-center justify-between gap-2 text-[10px] font-mono py-1 px-2 transition-colors ${isSelected ? "bg-primary/10 border-l-2 border-primary" : "border-l-2 border-transparent hover:bg-secondary/30"}`}
                            >
                              <div className="min-w-0 flex items-center gap-1.5 flex-1">
                                {sig.direction === "long" ? <TrendingUp className="h-2.5 w-2.5 shrink-0 text-success" /> : sig.direction === "short" ? <TrendingDown className="h-2.5 w-2.5 shrink-0 text-destructive" /> : <Minus className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />}
                                <span className="font-bold shrink-0 text-foreground">{sig.pair}</span>

                                {sig.reason && <span className="truncate text-[9px] text-muted-foreground min-w-0 font-sans">— {sig.reason}</span>}
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <span className={`tabular-nums font-bold ${sig.score >= 60 ? "text-success" : sig.score >= 40 ? "text-warning" : "text-muted-foreground"}`}>{typeof sig.score === "number" ? `${sig.score.toFixed(1)}%` : "—"}</span>
                                <span className={`max-w-[5.5rem] truncate text-[8px] font-bold uppercase tracking-wider px-1 py-0.5 border font-sans ${statusColor}`}>{statusLabel}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()}
              </div>
            </div>

            {/* Right: Detail Breakdown (40%) — hidden on mobile, shown in sheet instead */}
            <div className={`w-full md:w-[40%] flex flex-col min-h-0 border-t md:border-t-0 border-border max-h-96 md:max-h-none ${isMobile ? "hidden" : ""}`}>
              <div className="bg-card/60 px-2 py-1 border-b border-border">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Detail Breakdown</span>
              </div>
              <div className="flex-1 overflow-y-auto px-2 py-1">
                {(() => {
                    const selected = latestDetailsClean[selectedPairIdx];
                    if (!selected) {
                      return <p className="text-[10px] text-muted-foreground text-center py-8">Select a pair to view details</p>;
                    }
                    return <ScanDetailBreakdown signal={selected} observedAt={currentScan?.scanned_at} />;
                  })()}
              </div>
            </div>
          </div>
          </>
          )}
        </div>

        {/* Kill Switch Banner */}
        {d.killSwitchActive && (
          <div className="fixed bottom-16 md:bottom-6 left-0 md:left-12 right-0 max-w-full bg-destructive/95 text-destructive-foreground px-4 py-2 flex items-center justify-between gap-2 z-50 overflow-hidden">
            <span className="min-w-0 truncate text-xs font-bold">⚠ KILL SWITCH ACTIVE — All Trading Halted</span>
            <div className="flex gap-2 shrink-0">
              <Button size="sm" variant="outline" className="h-6 text-[10px] border-destructive-foreground text-destructive-foreground" disabled={!tradingControlsEnabled || deactivateKill.isPending} onClick={() => deactivateKill.mutate()}>Deactivate</Button>
            </div>
          </div>
        )}

        <BotConfigModal
          open={configOpen && tradingControlsEnabled}
          onClose={() => setConfigOpen(false)}
          effectiveStylePolicy={effectiveRuntimeStylePolicy}
        />

        {/* Mobile: Account & Performance Bottom Sheet */}
        <Sheet open={mobileAccountSheet} onOpenChange={setMobileAccountSheet}>
          <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto rounded-t-2xl">
            <SheetHeader className="pb-2">
              <SheetTitle className="text-sm">Account & Performance</SheetTitle>
            </SheetHeader>
            <div className="space-y-3 pb-4">
              {(() => {
                if (!accountStatusKnown) {
                  return (
                    <div className="rounded border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
                      Account balances, exposure, and performance are unavailable.
                    </div>
                  );
                }
                const positions = botPositions;
                const unrealizedPnl = positions.reduce((s: number, p: any) => s + (p.pnl || 0), 0);
                const totalExposure = positions.reduce((s: number, p: any) => s + (parseFloat(p.size) || 0), 0);
                const longCount = positions.filter((p: any) => p.direction === "long").length;
                const shortCount = positions.filter((p: any) => p.direction === "short").length;
                const equity = parseFloat(d.balance) + unrealizedPnl;
                const profitPct = (((parseFloat(d.balance) - 10000) / 10000) * 100);
                const history = botTradeHistory;
                const totalRealizedPnl = history.reduce((s: number, t: any) => s + (parseFloat(t.pnl) || 0), 0);
                const grossProfit = history.filter((t: any) => parseFloat(t.pnl) >= 0).reduce((s: number, t: any) => s + (parseFloat(t.pnl) || 0), 0);
                const grossLoss = Math.abs(history.filter((t: any) => parseFloat(t.pnl) < 0).reduce((s: number, t: any) => s + (parseFloat(t.pnl) || 0), 0));
                const avgWin = d.wins > 0 ? grossProfit / d.wins : 0;
                const avgLoss = d.losses > 0 ? -(grossLoss / d.losses) : 0;
                const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
                return (
                  <>
                    {/* Account */}
                    <div className="rounded-lg border border-border p-3 space-y-1.5 text-[12px]">
                      <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-semibold mb-1">Account</p>
                      <div className="flex justify-between"><span className="text-muted-foreground">Balance</span><span className="font-mono font-bold">{formatMoney(d.balance)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Equity</span><span className="font-mono">{formatMoney(equity)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Unrealized P&L</span><span className={`font-mono font-bold ${unrealizedPnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(unrealizedPnl, true)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Daily P&L</span><span className={`font-mono ${d.dailyPnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(d.dailyPnl, true)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Total Return</span><span className={`font-mono ${profitPct >= 0 ? "text-success" : "text-destructive"}`}>{profitPct >= 0 ? "+" : ""}{profitPct.toFixed(2)}%</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Drawdown</span><span className="font-mono">{(d.drawdown || 0).toFixed(1)}%</span></div>
                    </div>
                    {/* Exposure */}
                    <div className="rounded-lg border border-border p-3 space-y-1.5 text-[12px]">
                      <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-semibold mb-1">Exposure</p>
                      <div className="flex justify-between"><span className="text-muted-foreground">Open Positions</span><span className="font-mono font-bold">{positions.length}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Long / Short</span><span className="font-mono"><span className="text-success">{longCount}L</span> / <span className="text-destructive">{shortCount}S</span></span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Total Lots</span><span className="font-mono">{totalExposure.toFixed(2)}</span></div>
                    </div>
                    {/* Performance */}
                    <div className="rounded-lg border border-border p-3 space-y-1.5 text-[12px]">
                      <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-semibold mb-1">Performance</p>
                      <div className="flex justify-between"><span className="text-muted-foreground">Win Rate</span><span className={`font-mono font-bold ${(d.winRate || 0) >= 50 ? "text-success" : "text-destructive"}`}>{(d.winRate || 0).toFixed(1)}%</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Win / Loss</span><span className="font-mono">{d.wins}W / {d.losses}L</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Total Trades</span><span className="font-mono">{d.totalTrades}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Realized P&L</span><span className={`font-mono ${totalRealizedPnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(totalRealizedPnl, true)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Avg Win</span><span className="font-mono text-success">{formatMoney(avgWin, true)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Avg Loss</span><span className="font-mono text-destructive">{formatMoney(avgLoss, true)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Profit Factor</span><span className="font-mono">{profitFactor > 0 ? profitFactor.toFixed(2) : "—"}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Rejected</span><span className="font-mono text-warning">{d.rejectedCount}</span></div>
                    </div>
                    {/* Engine Controls */}
                    <div className="rounded-lg border border-border p-3 space-y-2 text-[12px]">
                      <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-semibold mb-1">Engine Controls</p>
                      <Button size="sm" variant="outline" className="w-full h-8 text-[11px]" onClick={() => { scanMut.mutate(); setMobileAccountSheet(false); }} disabled={!tradingControlsEnabled || scanMut.isPending || scanPolling}>
                        {(scanMut.isPending || scanPolling) ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Scan className="h-3 w-3 mr-1" />} {scanPolling ? "Scanning..." : "Manual Scan"}
                      </Button>
                      <Button size="sm" variant="outline" className="w-full h-8 text-[11px] border-cyan-500/30 text-cyan-400" onClick={() => setShowSetBalance(!showSetBalance)} disabled={!tradingControlsEnabled}>
                        <Settings className="h-3 w-3 mr-1" /> Set Balance
                      </Button>
                      {showSetBalance && (
                        <div className="flex gap-1.5 items-center">
                          <Input
                            type="number"
                            placeholder="e.g. 10000"
                            value={customBalanceInput}
                            onChange={e => setCustomBalanceInput(e.target.value)}
                            disabled={!tradingControlsEnabled}
                            className="h-7 text-[11px] flex-1 pl-5"
                          />
                          <Button size="sm" className="h-7 text-[11px] px-3 bg-cyan-600 text-white" disabled={!tradingControlsEnabled || setBalMut.isPending || !customBalanceInput} onClick={() => { const val = parseFloat(customBalanceInput); if (!isNaN(val) && val >= 0) setBalMut.mutate(val); }}>
                            {setBalMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Apply"}
                          </Button>
                        </div>
                      )}
                      <Button size="sm" variant="outline" className="w-full h-8 text-[11px] border-amber-500/30 text-warn" onClick={() => { if (window.confirm("Reset balance to configured starting amount?")) { resetBalMut.mutate(); setMobileAccountSheet(false); } }} disabled={!tradingControlsEnabled || resetBalMut.isPending}>
                        <RefreshCw className="h-3 w-3 mr-1" /> Reset Balance
                      </Button>
                      <Button size="sm" variant="outline" className="w-full h-8 text-[11px] border-destructive/30 text-destructive" onClick={() => { if (window.confirm("⚠️ FULL RESET — This will delete ALL data. Are you sure?")) { resetMut.mutate(); setMobileAccountSheet(false); } }} disabled={!tradingControlsEnabled || resetMut.isPending}>
                        Full Reset
                      </Button>
                    </div>
                  </>
                );
              })()}
            </div>
          </SheetContent>
        </Sheet>

        {/* Mobile: Scan Detail Bottom Sheet */}
        <Sheet open={mobileScanDetailSheet} onOpenChange={setMobileScanDetailSheet}>
          <SheetContent side="bottom" className="max-h-[75vh] overflow-y-auto rounded-t-2xl">
            <SheetHeader className="pb-2">
              <SheetTitle className="text-sm flex items-center gap-2">
                {(() => {
                  const sel = latestDetailsClean[selectedPairIdx];
                  if (!sel) return "Scan Detail";
                  return (
                    <>
                      {sel.pair}
                      {sel.direction === "long" ? <span className="text-success text-xs">▲ Long</span> : sel.direction === "short" ? <span className="text-destructive text-xs">▼ Short</span> : null}
                      <span className="text-xs font-mono text-muted-foreground ml-auto">{typeof sel.score === "number" ? `${sel.score.toFixed(1)}%` : ""}</span>
                    </>
                  );
                })()}
              </SheetTitle>
            </SheetHeader>
            <div className="pb-4">
              {(() => {
                const selected = latestDetailsClean[selectedPairIdx];
                if (!selected) return <p className="text-xs text-muted-foreground text-center py-8">No pair selected</p>;
                return <ScanDetailBreakdown signal={selected} observedAt={currentScan?.scanned_at} />;
              })()}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </AppShell>
  );
}

function TradeHistoryTable({ trades }: { trades: any[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const totalPages = Math.ceil((trades?.length || 0) / pageSize);
  if (!trades || trades.length === 0) return <p className="text-xs text-muted-foreground py-4 text-center">No trades</p>;
  const pagedTrades = trades.slice(page * pageSize, (page + 1) * pageSize);

  const reasonColor = (r: string) => {
    if (r === "tp_hit" || r === "trail_hit") return "text-success";
    if (r === "sl_hit") return "text-destructive";
    if (r === "be_hit") return "text-muted-foreground";
    if (r === "time_exit" || r === "kill_switch") return "text-warning";
    return "text-muted-foreground";
  };

  return (
    <>
    {/* Mobile: Stacked cards */}
    <div className="md:hidden space-y-1.5">
      {pagedTrades.map((t: any, i: number) => {
        const key = t.orderId || t.positionId || `${t.symbol}-${t.closedAt}-${i}`;
        return (
          <div key={key} className="border border-border bg-card/50 p-2 space-y-1 cursor-pointer" onClick={() => setExpanded(expanded === key ? null : key)}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-[11px]">{t.symbol}</span>
                <span className={`text-[10px] ${t.direction === "long" ? "text-success" : "text-destructive"}`}>{t.direction === "long" ? "▲ BUY" : "▼ SELL"}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className={`text-[11px] font-medium ${t.pnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(t.pnl, true)}</span>
                <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${expanded === key ? "rotate-180" : ""}`} />
              </div>
            </div>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>{formatBrokerTime(t.closedAt)}</span>
              <span className={reasonColor(t.closeReason)}>{t.closeReason}</span>
            </div>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>Entry: {parseFloat(t.entryPrice)?.toFixed(5)}</span>
              <span>Exit: {parseFloat(t.exitPrice)?.toFixed(5)}</span>
              <span>{t.pnlPips?.toFixed(1)} pips</span>
            </div>
            {expanded === key && (
              <div className="mt-1.5 pt-1.5 border-t border-border/40 space-y-1.5">
                {/* Score + Signal source */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {(() => { try { const sr = JSON.parse(t.signalReason || "{}"); return sr?.signalSource ? (
                    <span className={`text-[8px] font-mono font-bold px-1 py-0.5 rounded ${
                      sr.signalSource === "unified" ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30" :
                      sr.signalSource === "cascade" ? "bg-purple-500/15 text-purple-400 border border-purple-500/30" :
                      "bg-orange-500/15 text-orange-400 border border-orange-500/30"
                    }`}>{sr.signalSource === "unified" ? "UNIFIED" : sr.signalSource === "cascade" ? "CASCADE" : "STANDALONE"}</span>
                  ) : null; } catch { return null; } })()}
                </div>
                {/* Post-Mortem */}
                {t.postMortem && (
                  <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[8px] uppercase tracking-wider font-bold text-amber-400">Post-Mortem</span>
                      {t.postMortem.outcome && (
                        <span className={`text-[8px] font-bold px-1 py-0.5 rounded ${
                          t.postMortem.outcome === "Win" ? "bg-success/15 text-success border border-success/30" :
                          t.postMortem.outcome === "Loss" ? "bg-destructive/15 text-destructive border border-destructive/30" :
                          "bg-muted/30 text-muted-foreground border border-border"
                        }`}>{t.postMortem.outcome}</span>
                      )}
                      {t.postMortem.holdDuration && (
                        <span className="text-[8px] text-muted-foreground font-mono">{t.postMortem.holdDuration}</span>
                      )}
                    </div>
                    {t.postMortem.whatWorked && (
                      <div className="text-[9px] text-foreground/80"><span className="text-success font-semibold">✓</span> {t.postMortem.whatWorked}</div>
                    )}
                    {t.postMortem.whatFailed && (
                      <div className="text-[9px] text-foreground/80"><span className="text-destructive font-semibold">✗</span> {t.postMortem.whatFailed}</div>
                    )}
                    {t.postMortem.lessonLearned && (
                      <div className="text-[9px] text-foreground/80 italic">💡 {t.postMortem.lessonLearned}</div>
                    )}
                  </div>
                )}
                {/* Metadata */}
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px]">
                  <div className="flex justify-between"><span className="text-muted-foreground">Size</span><span className="font-mono">{t.size}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Order</span><span className="font-mono text-[8px]">{t.orderId?.slice(0,8)}</span></div>
                  {t.stopLoss != null && <div className="flex justify-between"><span className="text-muted-foreground">SL</span><span className="font-mono text-loss">{Number(t.stopLoss).toFixed(5)}</span></div>}
                  {t.takeProfit != null && <div className="flex justify-between"><span className="text-muted-foreground">TP</span><span className="font-mono text-profit">{Number(t.takeProfit).toFixed(5)}</span></div>}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
    {/* Desktop: Table */}
    <div className="hidden md:block overflow-x-auto"><table className="w-full text-[11px] font-mono min-w-[700px]">
      <thead><tr className="border-b border-border text-muted-foreground text-[10px]">
        <th className="w-4 py-1 px-1"></th>
        <th className="text-left py-1 px-1">Opened</th><th className="text-left py-1 px-1">Closed</th>
        <th className="text-left py-1 px-1">Symbol</th><th className="text-left py-1 px-1">Dir</th>
        <th className="text-right py-1 px-1">Entry</th><th className="text-right py-1 px-1">Exit</th>
        <th className="text-right py-1 px-1">Pips</th><th className="text-right py-1 px-1">P&L</th>
        <th className="text-left py-1 px-1">Reason</th>
      </tr></thead>
      <tbody>
        {pagedTrades.map((t: any, i: number) => {
          const key = t.orderId || t.positionId || `${t.symbol}-${t.closedAt}-${i}`;
          const isOpen = expanded === key;
          return (
            <React.Fragment key={key}>
              <tr
                onClick={() => setExpanded(isOpen ? null : key)}
                className={`border-b border-border/30 hover:bg-secondary/30 cursor-pointer ${i % 2 === 1 ? "bg-secondary/10" : ""}`}
              >
                <td className="py-1 px-1 text-muted-foreground">
                  <ChevronDown className={`h-2.5 w-2.5 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </td>
                <td className="py-1 px-1 text-[10px] text-muted-foreground">{formatBrokerTime(t.openTime)}</td>
                <td className="py-1 px-1 text-[10px] text-muted-foreground">{formatBrokerTime(t.closedAt)}</td>
                <td className="py-1 px-1">{t.symbol}</td>
                <td className={`py-1 px-1 ${t.direction === "long" ? "text-success" : "text-destructive"}`}>{t.direction === "long" ? "▲" : "▼"}</td>
                <td className="py-1 px-1 text-right">{parseFloat(t.entryPrice)?.toFixed(5)}</td>
                <td className="py-1 px-1 text-right">{parseFloat(t.exitPrice)?.toFixed(5)}</td>
                <td className="py-1 px-1 text-right">{t.pnlPips?.toFixed(1)}</td>
                <td className={`py-1 px-1 text-right font-medium ${t.pnl >= 0 ? "text-success" : "text-destructive"}`}>{formatMoney(t.pnl, true)}</td>
                <td className={`py-1 px-1 text-[10px] ${reasonColor(t.closeReason)}`}>{t.closeReason}</td>
              </tr>
              {isOpen && (() => {
                // Parse enriched signal_reason JSON
                let sr: any = null;
                try { sr = JSON.parse(t.signalReason || "{}"); } catch {}
                const hasRichData = sr && (sr.regimeData || sr.confluenceStacking || sr.structureIntel || sr.factorScores || sr.impulseZone || sr.directionVerdict || sr.gamePlanSnapshot || sr.decisionContext || sr.timeframeEvidenceId || sr.frozenStrategyContext?.timeframeEvidenceId);

                return (
                <tr className="bg-secondary/20 border-b border-border">
                  <td colSpan={10} className="p-2">
                    <div className="space-y-2 text-[10px]">
                      {/* Header: Close reason badge + Score + Signal source + Tier summary */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 border rounded ${
                          t.closeReason === "tp_hit" || t.closeReason === "trail_hit" ? "bg-success/15 border-success/40 text-success" :
                          t.closeReason === "sl_hit" ? "bg-destructive/15 border-destructive/40 text-destructive" :
                          t.closeReason === "be_hit" ? "bg-secondary border-border text-foreground" :
                          "bg-muted/40 border-border text-muted-foreground"
                        }`}>
                          Closed: {t.closeReason || "—"}
                          {t.closeReason === "trail_hit" && " (trailing stop locked profit)"}
                          {t.closeReason === "be_hit" && " (break-even SL)"}
                        </span>
                        {sr?.signalSource && (
                          <span className={`text-[8px] font-mono font-bold px-1 py-0.5 rounded ${
                            sr.signalSource === "unified" ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30" :
                            sr.signalSource === "cascade" ? "bg-purple-500/15 text-purple-400 border border-purple-500/30" :
                            "bg-orange-500/15 text-orange-400 border border-orange-500/30"
                          }`}>
                            {sr.signalSource === "unified" ? "UNIFIED ×1" : sr.signalSource === "cascade" ? "CASCADE ×1" : "STANDALONE ×0.5"}
                          </span>
                        )}
                      </div>
                      {/* Signal source context note for standalone trades */}
                      {sr?.signalSource && sr.signalSource !== "unified" && sr.signalSource !== "cascade" && (
                        <div className="text-[9px] px-2 py-1 rounded bg-orange-500/10 border border-orange-500/20 text-orange-300">
                          Entry via <span className="font-bold">standalone impulse zone</span> — unified confirmation not met. Position size halved (×0.5).
                        </div>
                      )}
                      <LegacyDiagnosticsPanel
                        score={Number(t.signalScore)}
                        factors={sr?.factorScores}
                        tieredScoring={sr?.tieredScoring}
                        gates={sr?.gates}
                        ownershipDiagnostics={sr?.legacyGateDiagnostics}
                        compact
                      />

                      {hasRichData ? (
                        <>
                          {/* Zone Story — consolidated impulse + unified zone narrative */}
                          <ZoneStoryPanel
                            unifiedData={sr.unifiedZone}
                            gateData={sr.impulseZone}
                            zoneLocalEnforcement={sr.zoneLocalEnforcement}
                            symbol={t.symbol}
                            direction={t.direction}
                            timeframeEvidenceId={sr.timeframeEvidenceId || sr.frozenStrategyContext?.timeframeEvidenceId}
                            frozenCrossTimeframeContext={sr.frozenStrategyContext?.crossTimeframeContext}
                            frozenExecutablePlan={sr.frozenExecutablePlan}
                          />
                          {sr.decisionContext && (
                            <div className="rounded border border-primary/30 bg-primary/5 px-2 py-1.5 space-y-1">
                              <p className="text-[8px] text-primary uppercase tracking-wider font-bold">
                                Unified Entry Decision · {sr.decisionContext.contractVersion}
                              </p>
                              <div className="flex flex-wrap gap-2 text-[9px] font-mono">
                                <span>
                                  GP v{sr.decisionContext.gamePlan?.version?.slice(0, 8) || "none"}
                                </span>
                                <span>
                                  DV {(sr.decisionContext.directionVerdict?.verdict || "missing").toUpperCase()}{" "}
                                  {Math.round(Number(sr.decisionContext.directionVerdict?.confidence || 0))}%
                                </span>
                                <span className={
                                  sr.decisionContext.thesisValidity?.valid
                                    ? "text-success"
                                    : "text-destructive"
                                }>
                                  Thesis {sr.decisionContext.thesisValidity?.valid ? "VALID" : "INVALID"}
                                </span>
                                <span className={
                                  sr.decisionContext.entryConfirmation?.passed
                                    ? "text-success"
                                    : "text-warning"
                                }>
                                  Confirmation {sr.decisionContext.entryConfirmation?.passed ? "PASSED" : "WAITING"}
                                </span>
                              </div>
                              <p className="text-[8px] text-muted-foreground">
                                {sr.decisionContext.hierarchy?.reason}
                              </p>
                              <p className="text-[8px] text-muted-foreground">
                                Thesis Conviction is observational and did not authorize this trade.
                              </p>
                            </div>
                          )}
                          {/* ── Direction Verdict ── */}
                          {sr.directionVerdict && !sr.directionVerdict.error && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-sm ${
                                sr.directionVerdict.verdict === "long" ? "bg-success/15 text-success border border-success/30" :
                                sr.directionVerdict.verdict === "short" ? "bg-destructive/15 text-destructive border border-destructive/30" :
                                "bg-muted/30 text-muted-foreground border border-border"
                              }`}>
                                {sr.directionVerdict.verdict === "long" ? "↑ LONG" : sr.directionVerdict.verdict === "short" ? "↓ SHORT" : "— NEUTRAL"}
                              </span>
                              <span className={`text-[9px] font-mono font-bold ${
                                sr.directionVerdict.confidence >= 70 ? "text-success" :
                                sr.directionVerdict.confidence >= 50 ? "text-warning" : "text-destructive"
                              }`}>{sr.directionVerdict.confidence}%</span>
                              <span className="text-[8px] text-muted-foreground">{Math.round(sr.directionVerdict.agreement * 100)}% agree</span>
                              {sr.directionVerdict.shouldBlock && (
                                <span className="text-[8px] font-bold text-destructive bg-destructive/10 px-1 rounded">BLOCKED</span>
                              )}
                              {sr.directionVerdict.scoreAdjustment !== 0 && (
                                <span className={`text-[8px] font-mono ${sr.directionVerdict.scoreAdjustment > 0 ? "text-success" : "text-destructive"}`}>
                                  adj: {sr.directionVerdict.scoreAdjustment > 0 ? "+" : ""}{sr.directionVerdict.scoreAdjustment.toFixed(2)}
                                </span>
                              )}
                            </div>
                          )}
                          {/* ── Immutable entry-time Game Plan snapshot ── */}
                          {sr.gamePlanSnapshot && (
                            <div className="rounded border border-cyan-500/30 bg-cyan-500/5 px-2 py-1.5 space-y-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <p className="text-[8px] text-cyan-400 uppercase tracking-wider font-bold">Entry Game Plan</p>
                                <span className={`text-[8px] font-bold px-1 py-0.5 rounded ${
                                  sr.gamePlanSnapshot.state === "tradeable" ? "bg-success/15 text-success"
                                  : sr.gamePlanSnapshot.state === "wait" ? "bg-warning/15 text-warning"
                                  : "bg-muted/30 text-muted-foreground"
                                }`}>
                                  {(sr.gamePlanSnapshot.state || "legacy").toUpperCase()}
                                </span>
                                <span className={`text-[9px] font-bold ${
                                  sr.gamePlanSnapshot.bias === "bullish" ? "text-success"
                                  : sr.gamePlanSnapshot.bias === "bearish" ? "text-destructive"
                                  : "text-muted-foreground"
                                }`}>
                                  {(sr.gamePlanSnapshot.bias || "neutral").toUpperCase()} {sr.gamePlanSnapshot.legacyConfidence ?? 0}%
                                </span>
                                <span className="text-[8px] text-muted-foreground">
                                  {sr.gamePlanSnapshot.enforcementMode || "unknown"} mode
                                </span>
                              </div>
                              {sr.gamePlanSnapshot.stateReason && (
                                <p className="text-[9px] text-foreground/80">{sr.gamePlanSnapshot.stateReason}</p>
                              )}
                              {sr.gamePlanSnapshot.conviction && (
                                <div className="flex gap-2 text-[8px] font-mono text-muted-foreground flex-wrap">
                                  <span>V2 {Math.round(sr.gamePlanSnapshot.conviction.confidence)}%</span>
                                  <span>Direction {Math.round(sr.gamePlanSnapshot.conviction.directionalStrength)}%</span>
                                  <span>Coverage {Math.round(sr.gamePlanSnapshot.conviction.evidenceCoverage)}%</span>
                                  <span>Quality {Math.round(sr.gamePlanSnapshot.conviction.planQuality)}%</span>
                                </div>
                              )}
                              {sr.gamePlanSnapshot.gateDecision?.reason && (
                                <p className={`text-[9px] ${sr.gamePlanSnapshot.gateDecision.passed ? "text-muted-foreground" : "text-destructive"}`}>
                                  {sr.gamePlanSnapshot.gateDecision.passed ? "✓" : "✕"} {sr.gamePlanSnapshot.gateDecision.reason}
                                </p>
                              )}
                              <div className="text-[8px] text-muted-foreground">
                                Captured {sr.gamePlanSnapshot.capturedAt ? new Date(sr.gamePlanSnapshot.capturedAt).toLocaleString() : "at entry"}
                              </div>
                            </div>
                          )}
                          {/* ── Regime Detection ── */}
                          {sr.regimeData && (
                            <div className="rounded border border-violet-500/30 bg-badge-info px-2 py-1.5 space-y-1">
                              <p className="text-[8px] text-tier3 uppercase tracking-wider font-bold">Regime Detection</p>
                              <div className="flex flex-wrap gap-x-3 gap-y-1">
                                {sr.regimeData.daily && (
                                  <div className="flex items-center gap-1">
                                    <span className="text-[8px] text-muted-foreground">Daily:</span>
                                    <span className={`text-[9px] font-bold ${
                                      sr.regimeData.daily.regime?.includes("trend") ? "text-profit"
                                      : sr.regimeData.daily.regime?.includes("range") ? "text-warn"
                                      : "text-highlight"
                                    }`}>{(sr.regimeData.daily.regime || "—").replace(/_/g, " ")}</span>
                                    <span className="text-[8px] text-muted-foreground">({Math.round((sr.regimeData.daily.confidence || 0) * 100)}%)</span>
                                    {sr.regimeData.daily.bias && sr.regimeData.daily.bias !== "neutral" && (
                                      <span className={`text-[8px] ${sr.regimeData.daily.bias === "bullish" ? "text-success" : "text-destructive"}`}>
                                        {sr.regimeData.daily.bias === "bullish" ? "↑" : "↓"}
                                      </span>
                                    )}
                                  </div>
                                )}
                                {sr.regimeData.h4 && (
                                  <div className="flex items-center gap-1">
                                    <span className="text-[8px] text-muted-foreground">4H:</span>
                                    <span className={`text-[9px] font-bold ${
                                      sr.regimeData.h4.regime?.includes("trend") ? "text-profit"
                                      : sr.regimeData.h4.regime?.includes("range") ? "text-warn"
                                      : "text-highlight"
                                    }`}>{(sr.regimeData.h4.regime || "—").replace(/_/g, " ")}</span>
                                    <span className="text-[8px] text-muted-foreground">({Math.round((sr.regimeData.h4.confidence || 0) * 100)}%)</span>
                                  </div>
                                )}
                                {/* Phase-1 cleanup: only render alignment badge when meaningful (agree/disagree). */}
                                {sr.regimeData.multiTFAlignment && sr.regimeData.multiTFAlignment !== "mixed" && (
                                  <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${
                                    sr.regimeData.multiTFAlignment === "agree" ? "bg-badge-profit text-profit"
                                    : sr.regimeData.multiTFAlignment === "disagree" ? "bg-badge-loss text-loss"
                                    : "bg-badge-warn text-highlight"
                                  }`}>
                                    {sr.regimeData.multiTFAlignment === "agree" ? "TF ✓ AGREE" : sr.regimeData.multiTFAlignment === "disagree" ? "TF ✗ DISAGREE" : "TF ~ MIXED"}
                                  </span>
                                )}
                              </div>
                              {sr.regimeData.daily?.transition && sr.regimeData.daily.transition.state !== "stable" && (
                                <div className="flex items-center gap-1 mt-0.5">
                                  <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${
                                    sr.regimeData.daily.transition.state === "accelerating" ? "bg-badge-info text-info-c"
                                    : sr.regimeData.daily.transition.state === "range_to_trending" ? "bg-badge-profit text-profit"
                                    : sr.regimeData.daily.transition.state === "trending_to_range" ? "bg-badge-warn text-warn"
                                    : sr.regimeData.daily.transition.state === "decelerating" ? "bg-badge-loss text-loss"
                                    : "bg-muted text-muted-foreground"
                                  }`}>
                                    {sr.regimeData.daily.transition.state === "accelerating" ? "🚀 ACCELERATING"
                                      : sr.regimeData.daily.transition.state === "range_to_trending" ? "⚡ RANGE → TREND"
                                      : sr.regimeData.daily.transition.state === "trending_to_range" ? "⏸ TREND → RANGE"
                                      : sr.regimeData.daily.transition.state === "decelerating" ? "📉 DECELERATING"
                                      : sr.regimeData.daily.transition.state.replace(/_/g, " ").toUpperCase()}
                                  </span>
                                  <span className="text-[8px] text-muted-foreground">
                                    ({Math.round(sr.regimeData.daily.transition.confidence * 100)}% conf, momentum {sr.regimeData.daily.transition.momentum > 0 ? "+" : ""}{sr.regimeData.daily.transition.momentum.toFixed(3)}/candle)
                                  </span>
                                </div>
                              )}
                            </div>
                          )}

                          {/* ── Structure Intelligence ── */}
                          {sr.structureIntel && (
                            <div className="rounded border border-violet-500/30 bg-badge-info px-2 py-1.5 space-y-1">
                              <p className="text-[8px] uppercase tracking-wider font-bold text-tier3">Structure Intelligence</p>
                              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                                <div className="flex items-center gap-1"><span className="text-[8px] text-muted-foreground">Internal BOS:</span><span className="text-[9px] font-mono text-foreground">{sr.structureIntel.counts?.internalBOS ?? 0}</span></div>
                                <div className="flex items-center gap-1"><span className="text-[8px] text-muted-foreground">External BOS:</span><span className="text-[9px] font-mono text-foreground">{sr.structureIntel.counts?.externalBOS ?? 0}</span></div>
                                <div className="flex items-center gap-1"><span className="text-[8px] text-muted-foreground">Internal CHoCH:</span><span className="text-[9px] font-mono text-foreground">{sr.structureIntel.counts?.internalCHoCH ?? 0}</span></div>
                                <div className="flex items-center gap-1"><span className="text-[8px] text-muted-foreground">External CHoCH:</span><span className="text-[9px] font-mono text-foreground">{sr.structureIntel.counts?.externalCHoCH ?? 0}</span></div>
                              </div>
                              {sr.structureIntel.s2f && (
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[8px] text-muted-foreground">S2F Rate:</span>
                                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                    sr.structureIntel.s2f.overallRate > 0.4 ? "bg-badge-profit text-profit"
                                    : sr.structureIntel.s2f.overallRate > 0.2 ? "bg-badge-warn text-warn"
                                    : "bg-badge-loss text-loss"
                                  }`}>{(sr.structureIntel.s2f.overallRate * 100).toFixed(0)}%</span>
                                  <span className="text-[8px] text-muted-foreground">
                                    ({sr.structureIntel.s2f.totalFractals} fractals | Bull {(sr.structureIntel.s2f.bullishRate * 100).toFixed(0)}% / Bear {(sr.structureIntel.s2f.bearishRate * 100).toFixed(0)}%)
                                  </span>
                                </div>
                              )}
                              {sr.structureIntel.derivedSR && (
                                <div className="space-y-0.5 mt-0.5">
                                  {sr.structureIntel.derivedSR.active?.length > 0 && (
                                    <div className="flex items-center gap-1 flex-wrap">
                                      <span className="text-[8px] text-profit font-semibold">Active S/R:</span>
                                      {sr.structureIntel.derivedSR.active.map((lv: any, li: number) => (
                                        <span key={li} className={`text-[8px] font-mono px-1 py-0.5 rounded ${lv.type === "support" ? "bg-badge-profit text-profit" : "bg-badge-loss text-loss"}`}>
                                          {lv.type === "support" ? "S" : "R"} {lv.price?.toFixed(lv.price > 10 ? 3 : 5)}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  {sr.structureIntel.derivedSR.broken?.length > 0 && (
                                    <div className="flex items-center gap-1 flex-wrap">
                                      <span className="text-[8px] text-muted-foreground">Broken:</span>
                                      {sr.structureIntel.derivedSR.broken.map((lv: any, li: number) => (
                                        <span key={li} className="text-[8px] font-mono text-muted-foreground line-through px-1 py-0.5">
                                          {lv.type === "support" ? "S" : "R"} {lv.price?.toFixed(lv.price > 10 ? 3 : 5)}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}


                          {/* ── Exit Strategy + Filters (inline for rich data) ── */}
                          {(() => {
                            const exitFlags = sr.exitFlags ?? null;
                            const spreadFilter = sr.spreadFilter ?? null;
                            const newsFilter = sr.newsFilter ?? null;
                            const exitRows: { label: string; value: string }[] = [];
                            if (exitFlags) {
                              if (exitFlags.trailingStopPips != null) exitRows.push({ label: "Trailing Stop", value: `${exitFlags.trailingStopPips} pips${exitFlags.trailingStopActivation ? ` (${exitFlags.trailingStopActivation})` : ""}` });
                              if (exitFlags.breakEvenPips != null) exitRows.push({ label: "Break Even", value: `${exitFlags.breakEvenPips} pips` });
                              if (exitFlags.partialTPPercent != null || exitFlags.partialTPLevel != null) exitRows.push({ label: "Partial TP", value: `${exitFlags.partialTPPercent ?? "—"}% @ ${exitFlags.partialTPLevel != null ? `${exitFlags.partialTPLevel}R` : "—"}` });
                              if (exitFlags.tpRatio != null) exitRows.push({ label: "TP Ratio", value: `${exitFlags.tpRatio}` });
                              if (exitFlags.maxHoldHours != null) exitRows.push({ label: "Max Hold", value: `${exitFlags.maxHoldHours}h` });
                            }
                            return (
                              <>
                                {exitRows.length > 0 && (
                                  <div>
                                    <p className="text-[8px] text-muted-foreground uppercase tracking-wider mb-1 font-bold">Exit Strategy</p>
                                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                                      {exitRows.map((r, i) => (
                                        <div key={i} className="flex justify-between gap-2 border-b border-border/30 py-0.5">
                                          <span className="text-muted-foreground text-[9px]">{r.label}</span>
                                          <span className="font-mono text-[9px] text-foreground">{r.value}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {(spreadFilter || newsFilter) && (
                                  <div>
                                    <p className="text-[8px] text-muted-foreground uppercase tracking-wider mb-1 font-bold">Filters</p>
                                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                                      {spreadFilter && (
                                        <div className="flex justify-between gap-2 border-b border-border/30 py-0.5">
                                          <span className="text-muted-foreground text-[9px]">Spread</span>
                                          <span className="font-mono text-[9px] text-foreground">{spreadFilter.enabled ? "on" : "off"}{spreadFilter.maxPips != null ? ` · max ${spreadFilter.maxPips} pips` : ""}</span>
                                        </div>
                                      )}
                                      {newsFilter && (
                                        <div className="flex justify-between gap-2 border-b border-border/30 py-0.5">
                                          <span className="text-muted-foreground text-[9px]">News</span>
                                          <span className="font-mono text-[9px] text-foreground">{newsFilter.enabled ? "on" : "off"}{newsFilter.pauseMinutes != null ? ` · pause ${newsFilter.pauseMinutes} min` : ""}</span>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </>
                      ) : (
                        /* ── Legacy fallback: old trades without rich data ── */
                        <SignalReasoningCard signalReason={t.signalReason || ""} />
                      )}

                      {/* ── Post-Mortem Analysis ── */}
                      {t.postMortem && (
                        <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 space-y-1">
                          <div className="flex items-center gap-1.5">
                            <p className="text-[8px] uppercase tracking-wider font-bold text-amber-400">Post-Mortem</p>
                            {t.postMortem.outcome && (
                              <span className={`text-[8px] font-bold px-1 py-0.5 rounded ${
                                t.postMortem.outcome === "Win" ? "bg-success/15 text-success border border-success/30" :
                                t.postMortem.outcome === "Loss" ? "bg-destructive/15 text-destructive border border-destructive/30" :
                                "bg-muted/30 text-muted-foreground border border-border"
                              }`}>{t.postMortem.outcome}</span>
                            )}
                            {t.postMortem.holdDuration && (
                              <span className="text-[8px] text-muted-foreground font-mono">Hold: {t.postMortem.holdDuration}</span>
                            )}
                          </div>
                          {t.postMortem.whatWorked && (
                            <div className="flex gap-1">
                              <span className="text-[8px] text-success font-semibold shrink-0">✓ Worked:</span>
                              <span className="text-[9px] text-foreground/80">{t.postMortem.whatWorked}</span>
                            </div>
                          )}
                          {t.postMortem.whatFailed && (
                            <div className="flex gap-1">
                              <span className="text-[8px] text-destructive font-semibold shrink-0">✗ Failed:</span>
                              <span className="text-[9px] text-foreground/80">{t.postMortem.whatFailed}</span>
                            </div>
                          )}
                          {t.postMortem.lessonLearned && (
                            <div className="flex gap-1">
                              <span className="text-[8px] text-amber-400 font-semibold shrink-0">💡 Lesson:</span>
                              <span className="text-[9px] text-foreground/80 italic">{t.postMortem.lessonLearned}</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* ── Trade Metadata Grid ── */}
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mt-1 text-[9px] border-t border-border/30 pt-1.5">
                        <div className="flex justify-between"><span className="text-muted-foreground">Order ID</span><span className="font-mono">{t.orderId}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Opened</span><span className="font-mono">{formatFullDateTime(t.openTime)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Closed</span><span className="font-mono">{formatFullDateTime(t.closedAt)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Size</span><span className="font-mono">{t.size}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">P&L Pips</span><span className="font-mono">{t.pnlPips?.toFixed(1)}</span></div>
                        {t.stopLoss != null && <div className="flex justify-between"><span className="text-muted-foreground">Stop Loss</span><span className="font-mono text-loss">{Number(t.stopLoss).toFixed(5)}</span></div>}
                        {t.takeProfit != null && <div className="flex justify-between"><span className="text-muted-foreground">Take Profit</span><span className="font-mono text-profit">{Number(t.takeProfit).toFixed(5)}</span></div>}
                      </div>
                    </div>
                  </td>
                </tr>
                );
              })()}
            </React.Fragment>
          );
        })}
      </tbody>
    </table></div>
    {totalPages > 1 && (
      <div className="flex items-center justify-between px-2 py-2 border-t border-border">
        <span className="text-[10px] text-muted-foreground font-mono">
          {page * pageSize + 1}–{Math.min((page + 1) * pageSize, trades.length)} of {trades.length}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPage(0)}
            disabled={page === 0}
            className="px-1.5 py-0.5 text-[10px] font-mono border border-border rounded hover:bg-secondary/50 disabled:opacity-30 disabled:cursor-not-allowed"
          >«</button>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-1.5 py-0.5 text-[10px] font-mono border border-border rounded hover:bg-secondary/50 disabled:opacity-30 disabled:cursor-not-allowed"
          >‹</button>
          <span className="text-[10px] font-mono text-muted-foreground px-2">{page + 1}/{totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="px-1.5 py-0.5 text-[10px] font-mono border border-border rounded hover:bg-secondary/50 disabled:opacity-30 disabled:cursor-not-allowed"
          >›</button>
          <button
            onClick={() => setPage(totalPages - 1)}
            disabled={page >= totalPages - 1}
            className="px-1.5 py-0.5 text-[10px] font-mono border border-border rounded hover:bg-secondary/50 disabled:opacity-30 disabled:cursor-not-allowed"
          >»</button>
        </div>
      </div>
    )}
    </>
  );
}

function ScanLogLine({ log }: { log: any }) {
  const time = formatTimeOnly(log.scanned_at);
  return (
    <div className="flex items-center gap-2 text-[10px] py-0.5">
      <span className="font-mono text-muted-foreground w-16 shrink-0">{time}</span>
      <Activity className="h-2.5 w-2.5 text-primary shrink-0" />
      <span>{log.pairs_scanned} pairs scanned</span>
      {log.signals_found > 0 && <span className="text-primary">⚡ {log.signals_found} signals</span>}
      {log.trades_placed > 0 && <span className="text-success">✓ {log.trades_placed} trades</span>}
    </div>
  );
}

function ScanSignalDetail({ signal: d }: { signal: any }) {
  const [expanded, setExpanded] = useState(false);
  const [newsClock, setNewsClock] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNewsClock(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const statusLabel = d.status === "limit_order_from_watchlist" || d.status === "zone_setup_from_watchlist" ? "🔍📋 ZONE+WL" : d.status === "limit_order_placed" || d.status === "zone_setup_active" ? "🔍 ZONE SETUP" : d.status === "trade_placed_from_watchlist" ? "📋 WATCHLIST" : d.status === "trade_placed_at_zone" ? "✅ PLACED@ZONE" : d.status === "trade_placed" ? "✅ PLACED" : d.status === "waiting_for_sweep" ? "⏳ SWEEP WAIT" : d.status === "waiting_for_reconfirmation" ? "⏳ RECONFIRM" : d.status === "watching_zone" ? "⏳ WATCHING" : d.status === "watchlist_persistence_failed" ? "⚠ WATCHLIST ERROR" : d.status === "waiting_zone_untracked" ? "ZONE AWAY" : d.status === "paused" ? "⏸ PAUSED" : d.status === "no_direction" ? "— NO DIR" : d.status === "rejected" ? "REJECTED" : d.status === "below_threshold" ? "SKIP" : d.status?.startsWith("skipped_") ? "SKIPPED" : d.status?.startsWith("staged_") ? "⏳ STAGED" : d.status?.toUpperCase() || "—";
  const statusColor = d.status === "limit_order_from_watchlist" || d.status === "zone_setup_from_watchlist" ? "text-tier3 bg-purple-500/10 border-purple-500/30" : d.status === "limit_order_placed" || d.status === "zone_setup_active" ? "text-info-c bg-badge-info border-blue-500/30" : d.status === "trade_placed_from_watchlist" ? "text-cyan-400 bg-cyan-500/10 border-cyan-500/30" : d.status?.startsWith("trade_placed") ? "text-success bg-success/10 border-success/30" : d.status === "rejected" || d.status === "watchlist_persistence_failed" ? "text-destructive bg-destructive/10 border-destructive/30" : d.status === "waiting_for_sweep" ? "text-purple-400 bg-purple-500/10 border-purple-500/30" : d.status === "waiting_for_reconfirmation" ? "text-orange-400 bg-orange-500/10 border-orange-500/30" : d.status === "paused" || d.status === "no_direction" ? "text-zinc-400 bg-zinc-500/10 border-zinc-500/30" : "text-muted-foreground bg-muted/20 border-border";
  const visibleRejectionReasons = uniqueRejectionReasons(d.gates, d.rejectionReasons);

  return (
    <div className="border-b border-border/30 last:border-b-0">
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center justify-between text-[10px] py-1.5 hover:bg-secondary/30 transition-colors px-1">
        <div className="flex items-center gap-1.5">
          {d.direction === "long" ? <TrendingUp className="h-2.5 w-2.5 text-success" /> : d.direction === "short" ? <TrendingDown className="h-2.5 w-2.5 text-destructive" /> : <Minus className="h-2.5 w-2.5 text-muted-foreground" />}
          <span className="font-medium">{d.pair}</span>
          {d.signalSource && (d.status === "trade_placed" || d.status === "trade_placed_from_watchlist" || d.status === "trade_placed_at_zone") && (
            <span className={`text-[8px] font-mono font-bold px-1 py-0.5 rounded ${
              d.signalSource === "unified" ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30" :
              d.signalSource === "cascade" ? "bg-purple-500/15 text-purple-400 border border-purple-500/30" :
              "bg-orange-500/15 text-orange-400 border border-orange-500/30"
            }`}>
              {d.signalSource === "unified" ? "UNIFIED ×1" : d.signalSource === "cascade" ? "CASCADE ×1" : "STANDALONE ×0.5"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[8px] font-bold uppercase px-1 py-0.5 border ${statusColor}`}>{statusLabel}</span>
          <ChevronDown className={`h-2.5 w-2.5 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
        </div>
      </button>
      {expanded && (
        <div className="px-1 pb-2 space-y-1.5">
          {/* Signal source context note */}
          {d.signalSource && d.signalSource !== "unified" && (d.status === "trade_placed" || d.status === "trade_placed_from_watchlist" || d.status === "trade_placed_at_zone") && (
            <div className="text-[9px] px-2 py-1 rounded bg-orange-500/10 border border-orange-500/20 text-orange-300">
              Entry via <span className="font-bold">standalone impulse zone</span> — unified confirmation not met. Position size halved (×0.5).
            </div>
          )}
          {/* Zone Story — consolidated impulse + unified zone narrative */}
          <ZoneStoryPanel
            unifiedData={d.unifiedZone}
            gateData={d.impulseZone}
            zoneLocalEnforcement={d.zoneLocalEnforcement}
            isLiveContext
            symbol={d.pair}
            direction={d.direction}
            timeframeEvidenceId={d.timeframeEvidenceId}
            frozenExecutablePlan={d.frozenExecutablePlan}
          />
          {/* Direction Verdict */}
          {d.directionVerdict && !d.directionVerdict.error && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-sm ${
                d.directionVerdict.verdict === "long" ? "bg-success/15 text-success border border-success/30" :
                d.directionVerdict.verdict === "short" ? "bg-destructive/15 text-destructive border border-destructive/30" :
                "bg-muted/30 text-muted-foreground border border-border"
              }`}>
                {d.directionVerdict.verdict === "long" ? "↑ LONG" : d.directionVerdict.verdict === "short" ? "↓ SHORT" : "— NEUTRAL"}
              </span>
              <span className={`text-[9px] font-mono font-bold ${
                d.directionVerdict.confidence >= 70 ? "text-success" :
                d.directionVerdict.confidence >= 50 ? "text-warning" : "text-destructive"
              }`}>{d.directionVerdict.confidence}%</span>
              <span className="text-[8px] text-muted-foreground">{Math.round(d.directionVerdict.agreement * 100)}% agree</span>
              {d.directionVerdict.shouldBlock && (
                <span className="text-[8px] font-bold text-destructive bg-destructive/10 px-1 rounded">BLOCKED</span>
              )}
              {d.directionVerdict.scoreAdjustment !== 0 && (
                <span className={`text-[8px] font-mono ${d.directionVerdict.scoreAdjustment > 0 ? "text-success" : "text-destructive"}`}>
                  adj: {d.directionVerdict.scoreAdjustment > 0 ? "+" : ""}{d.directionVerdict.scoreAdjustment.toFixed(2)}
                </span>
              )}
            </div>
          )}

          <LegacyDiagnosticsPanel
            score={d.score}
            factorCount={d.factorCount}
            factors={d.factors}
            tieredScoring={d.tieredScoring}
            gates={d.gates}
            ownershipDiagnostics={d.legacyGateDiagnostics}
            formatGateReason={(reason) => formatNewsGateCountdown(reason, newsClock, d.scanned_at)}
            compact
          />
          <TradeDecisionPanel detail={d} />
          {/* Rejection Reasons */}
          {visibleRejectionReasons.length > 0 && (
            <div className="space-y-0.5">
              <p className="text-[8px] text-destructive uppercase tracking-wider font-bold">Rejection Reasons</p>
              {visibleRejectionReasons.map((r: string, ri: number) => (
                <p key={ri} className="text-[9px] text-destructive">⚠ {formatNewsGateCountdown(r, newsClock, d.scanned_at)}</p>
              ))}
            </div>
          )}


        </div>
      )}
    </div>
  );
}

function RejectionSummaryPanel({ summary }: { summary: any }) {
  if (!summary || !summary.buckets || Object.keys(summary.buckets).length === 0) return null;
  const { buckets, impulseZoneBreakdown = {}, directionBreakdown = {}, samplePairs = {}, totalScanned = 0 } = summary;

  const STATUS_META: Record<string, { label: string; color: string; icon: string }> = {
    skipped_no_impulse_zone: { label: "No impulse zone", color: "text-destructive border-destructive/30 bg-destructive/5", icon: "⛔" },
    skipped_weak_zone: { label: "Weak zone rejected", color: "text-warn border-amber-500/30 bg-badge-warn", icon: "⛔" },
    watching_zone: { label: "Watching zone", color: "text-warn border-amber-500/30 bg-badge-warn", icon: "⏳" },
    no_direction: { label: "No direction", color: "text-muted-foreground border-border bg-muted/20", icon: "🚫" },
    trade_placed: { label: "Trade placed", color: "text-success border-success/30 bg-success/5", icon: "✅" },
    trade_placed_from_watchlist: { label: "Traded from watchlist", color: "text-cyan-400 border-cyan-500/30 bg-cyan-500/5", icon: "📋" },
    zone_setup_active: { label: "Zone setup active", color: "text-info-c border-blue-500/30 bg-badge-info", icon: "🔍" },
    zone_setup_from_watchlist: { label: "Zone + watchlist", color: "text-tier3 border-purple-500/30 bg-purple-500/5", icon: "🔍📋" },
    rejected: { label: "Rejected (post-gate)", color: "text-destructive border-destructive/30 bg-destructive/5", icon: "✗" },
    below_threshold: { label: "Below confluence", color: "text-muted-foreground border-border bg-muted/20", icon: "↓" },
    staged_new: { label: "Newly staged", color: "text-warn border-amber-500/30 bg-badge-warn", icon: "⭐" },
    staged_watching: { label: "Staged watching", color: "text-warn border-amber-500/30 bg-badge-warn", icon: "👁" },
    staged_confirming: { label: "Staged confirming", color: "text-warn border-amber-500/30 bg-badge-warn", icon: "⏳" },
    staged_invalidated: { label: "Staged invalidated", color: "text-muted-foreground border-border bg-muted/20", icon: "❌" },
    skipped: { label: "Skipped (session/data)", color: "text-muted-foreground border-border bg-muted/20", icon: "–" },
    paused: { label: "Paused", color: "text-muted-foreground border-border bg-muted/20", icon: "⏸" },
  };

  const SUB_LABELS: Record<string, string> = {
    no_impulse_leg: "No valid impulse leg (no BOS / origin broken)",
    no_pois_in_impulse: "No FVG/OB inside impulse leg",
    no_fib_alignment: "POIs not at key Fib (50–78.6%)",
    not_deep_enough: "Zone exists but not deep enough on Fib",
    no_zone_either_tf: "No zone on 1H or 4H",
    price_not_at_zone: "Price not at zone (watchlisted)",
    engine_error: "Engine error",
    daily_and_4h_ranging: "Daily AND 4H ranging",
    daily_ranging_4h_weak: "Daily ranging, 4H structure weak",
    daily_ranging_no_4h: "Daily ranging, no 4H data",
    daily_ranging: "Daily ranging",
    "4h_choch_against": "4H CHoCH against bias",
    "1h_choch_against": "1H CHoCH against bias",
    "1h_unconfirmed": "1H not confirmed",
    insufficient_daily_candles: "Insufficient daily candles",
    unknown: "Unknown",
    other: "Other",
  };

  // Sort buckets by count desc, then put status entries with no meta last
  const sortedBuckets = Object.entries(buckets as Record<string, number>)
    .sort(([, a], [, b]) => (b as number) - (a as number));

  return (
    <div className="border border-border bg-card/40 p-2 mb-1">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Rejection Summary</p>
        <span className="text-[9px] text-muted-foreground font-mono">{totalScanned} pairs scanned</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5">
        {sortedBuckets.map(([key, count]) => {
          const meta = STATUS_META[key] || { label: key, color: "text-muted-foreground border-border bg-muted/20", icon: "•" };
          const samples: string[] = samplePairs[key] || [];
          // Pick the breakdown that applies to this bucket
          const sub = key === "skipped_no_impulse_zone" ? impulseZoneBreakdown
            : key === "watching_zone" ? { price_not_at_zone: (impulseZoneBreakdown.price_not_at_zone ?? count) }
            : key === "no_direction" ? directionBreakdown
            : null;
          const subEntries = sub ? Object.entries(sub).sort(([, a], [, b]) => (b as number) - (a as number)) : [];
          return (
            <div key={key} className={`border px-1.5 py-1 ${meta.color}`}>
              <div className="flex items-center justify-between text-[10px] font-medium">
                <span className="truncate">{meta.icon} {meta.label}</span>
                <span className="font-mono font-bold ml-1">{count}</span>
              </div>
              {subEntries.length > 0 && (
                <div className="mt-0.5 space-y-0.5">
                  {subEntries.map(([sk, sv]) => (
                    <div key={sk} className="flex items-center justify-between text-[9px] text-muted-foreground">
                      <span className="truncate">└ {SUB_LABELS[sk] || sk}</span>
                      <span className="font-mono ml-1">{sv as number}</span>
                    </div>
                  ))}
                </div>
              )}
              {samples.length > 0 && (
                <div className="mt-0.5 text-[9px] text-muted-foreground/80 truncate font-mono">
                  {samples.join(", ")}{(count as number) > samples.length ? ` +${(count as number) - samples.length}` : ""}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Inline SL/TP editor for an open paper position ──
function EditSLTPInline({ position, onSaved }: { position: any; onSaved: () => void }) {
  const [sl, setSl] = useState(position.stopLoss ? String(parseFloat(position.stopLoss)) : "");
  const [tp, setTp] = useState(position.takeProfit ? String(parseFloat(position.takeProfit)) : "");
  const [saving, setSaving] = useState(false);

  const initialSl = position.stopLoss ? String(parseFloat(position.stopLoss)) : "";
  const initialTp = position.takeProfit ? String(parseFloat(position.takeProfit)) : "";
  const dirty = sl !== initialSl || tp !== initialTp;

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates: { stopLoss?: number | null; takeProfit?: number | null } = {};
      if (sl !== initialSl) updates.stopLoss = sl === "" ? null : parseFloat(sl);
      if (tp !== initialTp) updates.takeProfit = tp === "" ? null : parseFloat(tp);
      await paperApi.updatePosition(position.id, updates);
      toast.success("SL/TP updated");
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Failed to update SL/TP");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-end gap-2 pt-2 border-t border-border/40">
      <div className="space-y-0.5">
        <Label className="text-[9px] text-muted-foreground uppercase tracking-wider">Stop Loss</Label>
        <Input
          type="number"
          step="0.00001"
          value={sl}
          onChange={(e) => setSl(e.target.value)}
          placeholder="—"
          className="h-7 w-24 text-[10px] font-mono px-1.5"
        />
      </div>
      <div className="space-y-0.5">
        <Label className="text-[9px] text-muted-foreground uppercase tracking-wider">Take Profit</Label>
        <Input
          type="number"
          step="0.00001"
          value={tp}
          onChange={(e) => setTp(e.target.value)}
          placeholder="—"
          className="h-7 w-24 text-[10px] font-mono px-1.5"
        />
      </div>
      <Button
        size="sm"
        className="h-7 text-[10px]"
        disabled={!dirty || saving}
        onClick={handleSave}
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
      </Button>
      {dirty && !saving && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[10px]"
          onClick={() => { setSl(initialSl); setTp(initialTp); }}
        >
          Reset
        </Button>
      )}
    </div>
  );
}
