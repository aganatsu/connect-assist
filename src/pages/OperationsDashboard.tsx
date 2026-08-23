/* eslint-disable @typescript-eslint/no-explicit-any -- Existing edge-function responses are untyped at this UI boundary. */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  AreaChart as AreaChartIcon,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Download,
  LayoutDashboard,
  Loader2,
  Pause,
  Play,
  Radar,
  RefreshCw,
  Settings,
  ShieldAlert,
  Square,
  Target,
  TrendingDown,
  TrendingUp,
  WifiOff,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Line,
  LineChart,
  ResponsiveContainer,
  YAxis,
} from "recharts";
import { toast } from "sonner";

import { AppShell } from "@/components/AppShell";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/contexts/AuthContext";
import {
  brokerApi,
  brokerExecApi,
  paperApi,
  scannerApi,
  type PendingOrder,
  type PendingOrderSnapshot,
  type StagedSetup,
} from "@/lib/api";
import {
  canReturnToPaper,
  canUseTradingControls,
  readExecutionMode,
  verifyExecutionModeChange,
  type ExecutionMode,
} from "@/lib/executionMode";
import { formatPrice } from "@/lib/formatTime";
import { getCurrentSession } from "@/lib/marketData";
import { formatPipDisplay, getPipSize } from "@/lib/pipDisplay";
import { pendingOrderDisplayStage } from "@/lib/pendingOrderDisplay";
import "@/styles/operations-dashboard.css";

type ScanFilter = "all" | "signals" | "qualified";
type PipelineState = "complete" | "active" | "pending";

const QUALIFIED_STATUSES = new Set([
  "trade_placed",
  "trade_placed_from_watchlist",
  "trade_placed_at_zone",
  "limit_order_placed",
  "limit_order_from_watchlist",
  "zone_setup_active",
  "zone_setup_from_watchlist",
  "staged_confirming",
]);

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
  rejected: 7,
  below_threshold: 8,
  skipped: 9,
};

const NAV_ITEMS = [
  { label: "Command Center", icon: LayoutDashboard, route: "/" },
  { label: "Scanner", icon: Radar, route: "/bot" },
  { label: "Zone Setups", icon: Target, route: "#zone-setups" },
  { label: "Positions", icon: CircleDollarSign, route: "#positions" },
  { label: "Risk Desk", icon: ShieldAlert, route: "/prop-firm" },
  { label: "Journal", icon: BookOpen, route: "/journal" },
] as const;

function parseDetails(log: any): any[] {
  if (!log) return [];
  let raw = log.details_json;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

function cleanDetails(log: any): any[] {
  return parseDetails(log)
    .filter((detail) => !detail?.__meta)
    .sort((a, b) => {
      const rank = (value: unknown) => STATUS_PRIORITY[String(value || "")] ?? 50;
      const statusDifference = rank(a?.status) - rank(b?.status);
      if (statusDifference !== 0) return statusDifference;
      return Number(b?.score ?? -1) - Number(a?.score ?? -1);
    });
}

function detailMeta(log: any): any {
  return parseDetails(log).find((detail) => detail?.__meta) || null;
}

function pairName(detail: any): string {
  return String(detail?.pair || detail?.symbol || "Unknown");
}

function isSignal(detail: any): boolean {
  const status = String(detail?.status || "");
  return QUALIFIED_STATUSES.has(status)
    || status.startsWith("trade_placed")
    || status.startsWith("market_entry_")
    || status.startsWith("zone_setup_")
    || status === "blocked_final_authorization"
    || status === "skipped_tp_too_small"
    || status === "skipped_sl_sanity";
}

function isQualified(detail: any): boolean {
  return QUALIFIED_STATUSES.has(String(detail?.status || ""));
}

function statusPresentation(detail: any): { label: string; tone: string } {
  const status = String(detail?.status || "");
  if (status.includes("rejected") || status.includes("failed") || status.includes("blocked")) {
    return { label: status.includes("blocked") ? "Blocked" : "Rejected", tone: "negative" };
  }
  if (status.includes("trade_placed")) return { label: "Placed", tone: "positive" };
  if (status.includes("zone_setup") || status.includes("limit_order")) return { label: "Watchlist", tone: "info" };
  if (status === "waiting_for_reconfirmation" || status === "staged_confirming") return { label: "Reconfirm", tone: "attention" };
  if (status.startsWith("staged_")) return { label: "Watching", tone: "info" };
  if (status === "rejected") return { label: "Rejected", tone: "negative" };
  return { label: "Skipped", tone: "neutral" };
}

function scanPrice(detail: any): number | null {
  const candidates = [
    detail?.currentPrice,
    detail?.current_price,
    detail?.lastPrice,
    detail?.price,
    detail?.analysis?.lastPrice,
    detail?.analysis_snapshot?.lastPrice,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function scanScoreHistory(logs: any[], symbol: string): Array<{ value: number }> {
  return [...logs]
    .reverse()
    .map((log) => cleanDetails(log).find((detail) => pairName(detail) === symbol))
    .filter(Boolean)
    .map((detail) => ({ value: Number(detail.score) }))
    .filter((point) => Number.isFinite(point.value))
    .slice(-10);
}

function scanPriceHistory(logs: any[], symbol: string): Array<{ value: number }> {
  return [...logs]
    .reverse()
    .map((log) => cleanDetails(log).find((detail) => pairName(detail) === symbol))
    .map(scanPrice)
    .filter((value): value is number => value !== null)
    .map((value) => ({ value }))
    .slice(-18);
}

function formatClock(value: string | null | undefined, includeSeconds = true): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined,
  });
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function timeRemaining(expiresAt: string | null | undefined): string {
  if (!expiresAt) return "No expiry";
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return "Expired";
  const minutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function formatDistance(order: PendingOrder): string {
  const current = Number(order.current_price);
  const entry = Number(order.entry_price);
  if (!Number.isFinite(current) || !Number.isFinite(entry)) return "—";
  const pips = Math.abs(current - entry) / getPipSize(order.symbol);
  return formatPipDisplay(pips, order.symbol, { showSign: false });
}

function zoneType(order: PendingOrder): string {
  const value = String(order.entry_zone_type || order.order_type || "zone").toUpperCase();
  if (value.includes("OB") && value.includes("FVG")) return "OB + FVG";
  if (value.includes("OB")) return "OB";
  if (value.includes("FVG")) return "FVG";
  return "ZONE";
}

function optionalPrice(value: unknown, symbol: string): string {
  if (value === null || value === undefined || value === "") return "Unavailable";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? formatPrice(parsed, symbol) : "Unavailable";
}

function signalReasonObject(order: PendingOrder): Record<string, any> {
  if (typeof order.signal_reason === "string") {
    try {
      return JSON.parse(order.signal_reason);
    } catch {
      return {};
    }
  }
  return order.signal_reason && typeof order.signal_reason === "object" ? order.signal_reason : {};
}

function stopPolicyPresentation(order: PendingOrder): { label: string; detail: string; enforced: boolean } {
  const reason = signalReasonObject(order);
  const enforced = reason.zoneSetupStopPolicyAppliedAtArm === true;
  const mode = enforced ? reason.zoneSetupStopPolicyMode : "observe";
  const label = mode === "enforce_live" ? "PAPER + LIVE" : mode === "enforce_paper" ? "PAPER" : "OBSERVE";
  const source = reason.zoneSetupStopPolicy?.executionFloorSource === "broker_snapshot"
    ? "broker constraints"
    : "arm-time spread proxy";
  return {
    label,
    enforced,
    detail: enforced ? `ENFORCED / ${source} · Final SL recalculated at authorization` : "OBSERVE ONLY",
  };
}

function zoneGeometry(order: PendingOrder): {
  style: CSSProperties;
  labels: Array<{ key: string; label: string; value: string }>;
} | null {
  const stop = Number(order.stop_loss);
  const target = Number(order.take_profit);
  const zoneLow = Number(order.entry_zone_low);
  const zoneHigh = Number(order.entry_zone_high);
  if (![stop, target, zoneLow, zoneHigh].every(Number.isFinite)) return null;
  const low = Math.min(stop, target, zoneLow, zoneHigh);
  const high = Math.max(stop, target, zoneLow, zoneHigh);
  if (high <= low) return null;
  const position = (value: number) => `${((value - low) / (high - low)) * 100}%`;
  const labels = [
    { key: "stop", label: "Stop", value: optionalPrice(stop, order.symbol), price: stop },
    { key: "zone", label: zoneType(order), value: `${optionalPrice(zoneLow, order.symbol)}–${optionalPrice(zoneHigh, order.symbol)}`, price: (zoneLow + zoneHigh) / 2 },
    { key: "target", label: "Target", value: optionalPrice(target, order.symbol), price: target },
  ].sort((a, b) => a.price - b.price).map(({ key, label, value }) => ({ key, label, value }));
  return {
    style: {
      "--stop-position": position(stop),
      "--zone-start": position(Math.min(zoneLow, zoneHigh)),
      "--zone-width": `${Math.max(1, Math.abs(zoneHigh - zoneLow) / (high - low) * 100)}%`,
      "--target-position": position(target),
    } as CSSProperties,
    labels,
  };
}

function brokerTradeSymbol(trade: any): string {
  return String(trade?.instrument || trade?.symbol || "Unknown").replace(/_/g, "/");
}

function brokerTradeDirection(trade: any): "long" | "short" {
  return trade?.type === "SELL" || trade?.type === "POSITION_TYPE_SELL" || Number(trade?.currentUnits) < 0
    ? "short"
    : "long";
}

function recordIdentifier(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const identifier = String(value).trim();
  return identifier || null;
}

function downloadScanCsv(details: any[], observedAt: string | undefined) {
  const headers = ["observed_at", "pair", "direction", "score", "status", "reason"];
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = details.map((detail) => [
    observedAt,
    pairName(detail),
    detail.direction,
    detail.score,
    detail.status,
    detail.reason,
  ]);
  const csv = [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `apex-ledger-scan-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildPipeline(order: PendingOrder | null): Array<{ label: string; detail: string; state: PipelineState }> {
  if (!order) {
    return [
      { label: "Zone entered", detail: "Waiting for an active setup", state: "pending" },
      { label: "Displaced MSS / CHoCH", detail: "Not started", state: "pending" },
      { label: "Micro OB retracement", detail: "Not started", state: "pending" },
      { label: "Final authorization", detail: "Not started", state: "pending" },
    ];
  }
  const stage = pendingOrderDisplayStage(order);
  if (stage === "reconciliation") {
    return [
      { label: "Entry lifecycle", detail: "Trade reached broker execution", state: "complete" },
      {
        label: "Broker reconciliation",
        detail: order.cancel_reason || "Broker outcome requires operator verification",
        state: "active",
      },
      { label: "Position ownership", detail: "Do not retry until broker state is confirmed", state: "pending" },
    ];
  }
  const confirmation = order.impulse_entry_lifecycle?.confirmation;
  const retracement = order.post_confirmation_entry;
  const confirmationDone = Boolean(confirmation?.confirmedAt || retracement);
  const zoneEntered = stage !== "watching";
  const finalAuthorized = order.final_authorization?.authorized === true;
  const afterChochMode = order.confirmation_config?.afterChochMode || "confirmation_close";
  const requiresRetracement = afterChochMode === "wait_retracement";
  const observesRetracement = afterChochMode === "observe_retracement";

  const steps: Array<{ label: string; detail: string; state: PipelineState }> = [
    {
      label: "Zone entered",
      detail: zoneEntered ? `Frozen ${zoneType(order)} engaged` : `${formatDistance(order)} from entry`,
      state: zoneEntered ? "complete" : "active",
    },
    {
      label: "Displaced MSS / CHoCH",
      detail: confirmationDone
        ? "Closed-bar confirmation recorded"
        : order.confirmation_build_diagnostic?.reasonCode?.replace(/_/g, " ") || "Building protected structure",
      state: confirmationDone ? "complete" : zoneEntered ? "active" : "pending",
    },
  ];
  if (requiresRetracement || observesRetracement || retracement) {
    steps.push({
      label: requiresRetracement ? "Micro OB retracement" : "Retracement observation",
      detail: retracement
        ? retracement.state.replace(/_/g, " ")
        : observesRetracement
        ? "Observation only; does not block entry"
        : "Begins after confirmation",
      state: retracement?.state === "ready"
        ? "complete"
        : retracement?.state === "awaiting_retracement"
        ? "active"
        : observesRetracement && confirmationDone
        ? "complete"
        : "pending",
    });
  }
  const entryReady = confirmationDone && (!requiresRetracement || retracement?.state === "ready");
  steps.push({
      label: "Final authorization",
      detail: finalAuthorized ? "Risk and execution checks passed" : "Awaiting fresh price, risk, and broker checks",
      state: finalAuthorized ? "complete" : entryReady ? "active" : "pending",
  });
  return steps;
}

function commentary(order: PendingOrder | null): string {
  if (!order) {
    return "No zone setup is currently active. The scanner is still evaluating closed-bar structure and will publish the next executable candidate here.";
  }
  const direction = order.direction === "long" ? "bullish" : "bearish";
  const stage = pendingOrderDisplayStage(order);
  if (stage === "reconciliation") {
    return `${order.symbol} requires broker reconciliation. The execution outcome is uncertain, so verify the broker position before retrying or changing this setup.`;
  }
  if (stage === "confirmation") {
    const diagnostic = order.confirmation_build_diagnostic?.reasonCode?.replace(/_/g, " ");
    return `${order.symbol} has entered its frozen ${zoneType(order)}. Price is now being evaluated for a later ${direction} displaced MSS or CHoCH close${diagnostic ? `; the current lock state is ${diagnostic}` : ""}. No order is sent until the remaining authorization checks pass.`;
  }
  if (stage === "retracement") {
    return `${order.symbol} has confirmed the ${direction} structure shift. The lifecycle is now waiting for price to return to the frozen micro order block before final authorization.`;
  }
  return `${order.symbol} remains pre-armed ${formatDistance(order)} from its frozen ${zoneType(order)}. Lightweight monitoring continues until price approaches the zone; deeper confirmation analysis starts before touch.`;
}

function OperationsDashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [now, setNow] = useState(new Date());
  const [scanIndex, setScanIndex] = useState(0);
  const [scanFilter, setScanFilter] = useState<ScanFilter>("all");
  const [selectedPair, setSelectedPair] = useState<string | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [positionsOpen, setPositionsOpen] = useState(false);
  const [scanPolling, setScanPolling] = useState(false);
  const scanPollRef = useRef<number | null>(null);
  const scanStartedAtRef = useRef<string | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => () => {
    if (scanPollRef.current !== null) {
      window.clearInterval(scanPollRef.current);
      scanPollRef.current = null;
    }
  }, []);

  const statusQuery = useQuery({
    queryKey: ["paper-status"],
    queryFn: () => paperApi.status(),
    refetchInterval: 10_000,
    retry: false,
  });
  const scansQuery = useQuery({
    queryKey: ["scan-logs"],
    queryFn: () => scannerApi.logs(),
    refetchInterval: 30_000,
    retry: false,
  });
  const pendingQuery = useQuery({
    queryKey: ["pending-orders-snapshot"],
    queryFn: () => scannerApi.pendingSnapshot(),
    refetchInterval: 30_000,
    retry: false,
    placeholderData: (previous) => previous,
  });
  const stagedQuery = useQuery({
    queryKey: ["staged-setups-active"],
    queryFn: () => scannerApi.activeStaged(),
    refetchInterval: 15_000,
    retry: false,
    placeholderData: (previous) => previous,
  });
  const connectionsQuery = useQuery({
    queryKey: ["broker-connections"],
    queryFn: () => brokerApi.list(),
    refetchInterval: 30_000,
    retry: false,
  });

  const status: any = statusQuery.data || {};
  const executionMode = !statusQuery.isPending && !statusQuery.isError
    ? readExecutionMode(statusQuery.data)
    : "unknown";
  const accountStatusKnown = executionMode !== "unknown";
  const statusUnavailable = !accountStatusKnown;
  const scans = Array.isArray(scansQuery.data) ? scansQuery.data : [];
  const pendingSnapshot: PendingOrderSnapshot = pendingQuery.data || {
    active: [],
    history: [],
    fetchedAt: null,
  };
  const activeOrders = useMemo(
    () => Array.isArray(pendingSnapshot.active) ? pendingSnapshot.active : [],
    [pendingSnapshot.active],
  );
  const stagedSetups: StagedSetup[] = Array.isArray(stagedQuery.data) ? stagedQuery.data : [];
  const brokerConnectionsKnown = connectionsQuery.isSuccess && Array.isArray(connectionsQuery.data);
  const connections = brokerConnectionsKnown ? connectionsQuery.data : [];
  const activeConnections = connections.filter((connection: any) => connection.is_active);
  const connectionStatusQueries = useQueries({
    queries: activeConnections.map((connection: any) => ({
      queryKey: ["broker-connection-status", connection.id],
      queryFn: () => brokerExecApi.connectionStatus(connection.id),
      refetchInterval: 30_000,
      retry: false,
    })),
  });
  const brokerAccountQueries = useQueries({
    queries: activeConnections.map((connection: any, index: number) => ({
      queryKey: ["broker-account", connection.id],
      queryFn: () => brokerExecApi.accountSummary(connection.id),
      enabled: connectionStatusQueries[index]?.data?.ready === true,
      refetchInterval: 15_000,
      retry: false,
    })),
  });
  const brokerTradeQueries = useQueries({
    queries: activeConnections.map((connection: any) => ({
      queryKey: ["broker-open-trades", connection.id],
      queryFn: () => brokerExecApi.openTrades(connection.id),
      enabled: brokerConnectionsKnown,
      refetchInterval: 10_000,
      retry: false,
    })),
  });
  const connectedConnections = activeConnections.filter((_: any, index: number) =>
    connectionStatusQueries[index]?.isSuccess === true &&
    connectionStatusQueries[index]?.data?.ready === true
  );
  const connectionChecksPending = connectionsQuery.isPending ||
    activeConnections.some((_: any, index: number) => connectionStatusQueries[index]?.isPending);
  const connectionChecksUnavailable = connectionsQuery.isError
    || connectionStatusQueries.some((query) => query.isError || query.data?.fallback === true);
  const brokerExposurePending = connectionsQuery.isPending || activeConnections.some((_: any, index: number) => {
    const statusCheck = connectionStatusQueries[index];
    const positionsCheck = brokerTradeQueries[index];
    return statusCheck?.isPending || positionsCheck?.isPending;
  });
  const brokerExposureUnavailable = connectionsQuery.isError || activeConnections.some((_: any, index: number) => {
    const positionsCheck = brokerTradeQueries[index];
    return positionsCheck?.isError ||
      (positionsCheck?.isSuccess && !Array.isArray(positionsCheck.data));
  });
  const brokerExposureComplete = brokerConnectionsKnown &&
    !brokerExposurePending &&
    !brokerExposureUnavailable &&
    activeConnections.every((_: any, index: number) =>
      brokerTradeQueries[index]?.isSuccess === true &&
      Array.isArray(brokerTradeQueries[index]?.data)
    );
  const brokerTrades = activeConnections.flatMap((connection: any, index: number) => {
    const trades = brokerTradeQueries[index]?.data;
    if (!Array.isArray(trades)) return [];
    return trades.map((trade: any) => ({ trade, connection }));
  });
  const brokerAccounts = activeConnections.flatMap((connection: any, index: number) => {
    const query = brokerAccountQueries[index];
    if (!query?.isSuccess || !query.data || query.data.fallback === true) return [];
    return [{ connection, account: query.data }];
  });
  const liveBrokerStates = activeConnections.map((_: any, index: number) =>
    connectionStatusQueries[index]?.isSuccess === true &&
    connectionStatusQueries[index]?.data?.ready === true &&
    brokerAccountQueries[index]?.isSuccess === true &&
    !!brokerAccountQueries[index]?.data &&
    brokerTradeQueries[index]?.isSuccess === true &&
    Array.isArray(brokerTradeQueries[index]?.data)
  );
  const tradingControlsEnabled = canUseTradingControls(executionMode, liveBrokerStates);
  const canSwitchBackToPaper = canReturnToPaper(
    executionMode,
    brokerConnectionsKnown,
    activeConnections.map((_: any, index: number) => ({
      available: brokerTradeQueries[index]?.isSuccess === true,
      positions: brokerTradeQueries[index]?.data,
    })),
  );
  const modeChangeEnabled = accountStatusKnown && (
    executionMode === "paper"
      ? brokerConnectionsKnown && activeConnections.length > 0
      : canSwitchBackToPaper
  );

  const safeScanIndex = Math.min(scanIndex, Math.max(0, scans.length - 1));
  const currentScan = scans[safeScanIndex];
  const scanDetails = useMemo(() => cleanDetails(currentScan), [currentScan]);
  const meta = useMemo(() => detailMeta(currentScan), [currentScan]);
  const displayedScanDetails = useMemo(() => {
    if (scanFilter === "signals") return scanDetails.filter(isSignal);
    if (scanFilter === "qualified") return scanDetails.filter(isQualified);
    return scanDetails;
  }, [scanDetails, scanFilter]);

  useEffect(() => {
    if (!displayedScanDetails.length) {
      setSelectedPair(null);
      return;
    }
    if (!displayedScanDetails.some((detail) => pairName(detail) === selectedPair)) {
      setSelectedPair(pairName(displayedScanDetails[0]));
    }
  }, [displayedScanDetails, selectedPair]);

  const selectedScanDetail = displayedScanDetails.find((detail) => pairName(detail) === selectedPair) || displayedScanDetails[0] || null;
  const huntingOrders = activeOrders.filter((order) => {
    const stage = pendingOrderDisplayStage(order);
    return stage === "confirmation" || stage === "retracement";
  });
  const reconciliationOrders = activeOrders.filter((order) => pendingOrderDisplayStage(order) === "reconciliation");
  const focusedOrder = activeOrders.find((order) => order.order_id === selectedOrderId)
    || reconciliationOrders[0]
    || huntingOrders[0]
    || activeOrders[0]
    || null;
  const watchingOrders = activeOrders.filter((order) => pendingOrderDisplayStage(order) === "watching");
  const priceHistory = focusedOrder ? scanPriceHistory(scans, focusedOrder.symbol) : [];
  const pipeline = buildPipeline(focusedOrder);
  const focusedGeometry = focusedOrder ? zoneGeometry(focusedOrder) : null;
  const focusedStopPolicy = focusedOrder ? stopPolicyPresentation(focusedOrder) : null;

  const scansToday = scans.filter((scan) => {
    const date = new Date(scan.scanned_at);
    return date.toDateString() === now.toDateString();
  });
  const signalsToday = scansToday.reduce((sum, scan) => sum + Number(scan.signals_found || 0), 0);
  const tradesToday = scansToday.reduce((sum, scan) => sum + Number(scan.trades_placed || 0), 0);
  const dailyLedgerTruncated = scans.length >= 100 && scansToday.length === scans.length;
  const scanAgeMinutes = currentScan?.scanned_at ? (now.getTime() - new Date(currentScan.scanned_at).getTime()) / 60_000 : Infinity;
  const scanIsRecent = scanAgeMinutes <= 20;
  const currentScanAge = Number.isFinite(scanAgeMinutes) ? `${Math.max(0, Math.floor(scanAgeMinutes))}m ago` : "No completed scan";
  const scanBudgetHealth = meta?.creditBudget || null;
  const isRunning = Boolean(status.isRunning);
  const isPaused = Boolean(status.isPaused);
  const engineAction: "start" | "pause" = !accountStatusKnown || (isRunning && !isPaused) ? "pause" : "start";
  const engineLabel = statusUnavailable
    ? "Status unavailable"
    : status.killSwitchActive
    ? "Kill switch active"
    : isRunning && !isPaused
    ? "Engine running"
    : isPaused
    ? "Engine paused"
    : "Engine stopped";

  const recentEvents = useMemo(() => {
    const rows: Array<{ id: string; time: string; label: string; detail: string; tone: string }> = [];
    if (currentScan?.scanned_at) {
      rows.push({
        id: `scan-${currentScan.scanned_at}`,
        time: currentScan.scanned_at,
        label: "Scan completed",
        detail: `${currentScan.pairs_scanned || 0} pairs · ${currentScan.signals_found || 0} signals`,
        tone: "cyan",
      });
    }
    const ordersById = new Map<string, PendingOrder>();
    for (const order of [...(pendingSnapshot.history || []), ...activeOrders]) {
      ordersById.set(order.order_id, order);
    }
    for (const order of ordersById.values()) {
      const time = order.resolved_at || order.updated_at || order.placed_at;
      rows.push({
        id: order.order_id,
        time,
        label: `${order.symbol} · ${order.status.replace(/_/g, " ")}`,
        detail: order.cancel_reason || order.fill_reason || `${order.direction.toUpperCase()} ${zoneType(order)}`,
        tone: order.status === "filled" ? "green" : order.status === "invalidated" || order.status === "cancelled" ? "red" : "orange",
      });
    }
    return rows
      .filter((event) => event.time)
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      .slice(0, 5);
  }, [activeOrders, currentScan, pendingSnapshot.history]);

  const manualScan = useMutation({
    mutationFn: () => scannerApi.manualScan(),
    onSuccess: (result: any) => {
      setScanIndex(0);
      if (!result?.started) {
        toast.success("Scan complete");
        queryClient.invalidateQueries({ queryKey: ["scan-logs"] });
        return;
      }
      toast.success("Scan started");
      setScanPolling(true);
      scanStartedAtRef.current = new Date().toISOString();
      if (scanPollRef.current !== null) window.clearInterval(scanPollRef.current);
      scanPollRef.current = window.setInterval(async () => {
        try {
          const latest = await scannerApi.logs();
          const latestTime = latest?.[0]?.scanned_at;
          if (latestTime && scanStartedAtRef.current && latestTime > scanStartedAtRef.current) {
            if (scanPollRef.current !== null) window.clearInterval(scanPollRef.current);
            scanPollRef.current = null;
            scanStartedAtRef.current = null;
            setScanPolling(false);
            queryClient.setQueryData(["scan-logs"], latest);
            queryClient.invalidateQueries({ queryKey: ["pending-orders-snapshot"] });
            queryClient.invalidateQueries({ queryKey: ["paper-status"] });
            toast.success("Scan complete — ledger updated");
          }
        } catch {
          // The normal query error state remains the visible source of truth.
        }
      }, 3_000);
      window.setTimeout(() => {
        if (scanPollRef.current !== null) window.clearInterval(scanPollRef.current);
        scanPollRef.current = null;
        scanStartedAtRef.current = null;
        setScanPolling(false);
        queryClient.invalidateQueries({ queryKey: ["scan-logs"] });
      }, 90_000);
    },
    onError: (error: any) => toast.error(error?.message || "Could not start scan"),
  });
  const engineMutation = useMutation({
    mutationFn: (action: "start" | "pause") => action === "pause" ? paperApi.pauseEngine() : paperApi.startEngine(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["paper-status"] }),
    onError: (error: any) => toast.error(error?.message || "Engine state did not change"),
  });
  const engineControlDisabled = engineMutation.isPending || (engineAction === "start" && !tradingControlsEnabled);
  const stopEngineMutation = useMutation({
    mutationFn: () => paperApi.stopEngine(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["paper-status"] }),
    onError: (error: any) => toast.error(error?.message || "Engine did not stop"),
  });
  const modeMutation = useMutation({
    mutationFn: async (mode: ExecutionMode) => {
      const result = await paperApi.setExecutionMode(mode);
      const verifiedMode = await verifyExecutionModeChange(
        result,
        mode,
        async () => {
          const persistedStatus = await paperApi.status();
          return persistedStatus?.executionMode || persistedStatus?.account?.execution_mode;
        },
      );
      return { ...result, executionMode: verifiedMode };
    },
    onSuccess: (result, mode) => {
      queryClient.setQueryData(["paper-status"], (current: any) => ({
        ...(current || {}),
        executionMode: result.executionMode,
      }));
      queryClient.invalidateQueries({ queryKey: ["paper-status"] });
      queryClient.invalidateQueries({ queryKey: ["broker-connection-status"] });
      queryClient.invalidateQueries({ queryKey: ["broker-open-trades"] });
      queryClient.invalidateQueries({ queryKey: ["broker-account"] });
      toast.success(mode === "live" ? "Live execution enabled and verified" : "Paper execution enabled and verified");
    },
    onError: (error: any) => toast.error(error?.message || "Execution mode did not change"),
  });
  const cancelPendingMutation = useMutation({
    mutationFn: (orderId: string) => scannerApi.cancelPending(orderId),
    onSuccess: () => {
      setSelectedOrderId(null);
      queryClient.invalidateQueries({ queryKey: ["pending-orders-snapshot"] });
      toast.success("Zone setup cancelled");
    },
    onError: (error: any) => toast.error(error?.message || "Zone setup was not cancelled"),
  });
  const dismissStagedMutation = useMutation({
    mutationFn: (setupId: string) => scannerApi.dismissStaged(setupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staged-setups-active"] });
      toast.success("Staged candidate dismissed");
    },
    onError: (error: any) => toast.error(error?.message || "Candidate was not dismissed"),
  });
  const paperCloseMutation = useMutation({
    mutationFn: (positionId: string) => {
      if (!positionId) throw new Error("A known managed position is required to close it.");
      return paperApi.closePosition(positionId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["paper-status"] });
      queryClient.invalidateQueries({ queryKey: ["broker-open-trades"] });
      queryClient.invalidateQueries({ queryKey: ["broker-account"] });
      toast.success("Managed position close confirmed");
    },
    onError: (error: any) => toast.error(error?.message || "Position close was not confirmed"),
  });
  const brokerCloseMutation = useMutation({
    mutationFn: ({ connectionId, tradeId }: { connectionId: string; tradeId: string }) => {
      if (!connectionId || !tradeId) {
        throw new Error("A known broker connection and trade are required to close this position.");
      }
      return brokerExecApi.closeTrade(connectionId, tradeId);
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["broker-open-trades", variables.connectionId] });
      queryClient.invalidateQueries({ queryKey: ["broker-account", variables.connectionId] });
    },
    onError: (error: any) => toast.error(error?.message || "Broker close was not confirmed"),
  });
  const killMutation = useMutation({
    mutationFn: () => paperApi.killSwitch(true),
    onSuccess: () => {
      toast.error("Kill switch activated");
      queryClient.invalidateQueries({ queryKey: ["paper-status"] });
      queryClient.invalidateQueries({ queryKey: ["broker-open-trades"] });
      queryClient.invalidateQueries({ queryKey: ["broker-account"] });
    },
    onError: (error: any) => toast.error(error?.message || "Kill switch request failed"),
  });

  const navigateFromRail = (route: string) => {
    if (route === "#positions") {
      setPositionsOpen(true);
      return;
    }
    if (route.startsWith("#")) {
      document.querySelector(route)?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    navigate(route);
  };

  const avatar = (user?.email || "A").slice(0, 2).toUpperCase();
  const dataStale = statusUnavailable
    || scansQuery.isError
    || pendingQuery.isError
    || pendingSnapshot.fallback
    || stagedQuery.isError
    || connectionChecksUnavailable
    || brokerExposurePending
    || brokerExposureUnavailable
    || brokerAccountQueries.some((query, index) => (
      connectionStatusQueries[index]?.data?.ready === true
      && (query.isPending || query.isError || query.data?.fallback === true)
    ));

  return (
    <AppShell variant="operations">
      <div className="apex-ledger">
        <header className="apex-topbar">
          <button className="apex-brand" onClick={() => navigate("/")} aria-label="Open command center">
            <span className="apex-brand-mark">A</span>
            <span>Apex Ledger</span>
          </button>
          <span className="apex-section-tab"><Radar aria-hidden="true" /> Scanning</span>
          <time className="apex-date" dateTime={now.toISOString()}>{formatDate(now)}</time>
          <div className="apex-utilities">
            <button onClick={() => downloadScanCsv(scanDetails, currentScan?.scanned_at)} disabled={!scanDetails.length}>
              <Download aria-hidden="true" /> <span>Export</span>
            </button>
            <button onClick={() => navigate("/bot-config")}>
              <Settings aria-hidden="true" /> <span>Settings</span>
            </button>
            <button className="apex-avatar" onClick={() => navigate("/settings")} aria-label="Open profile settings">{avatar}</button>
          </div>
        </header>

        <div className="apex-body">
          <aside className="apex-sidebar" aria-label="Trading operations navigation">
            <nav>
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.label}
                  className={item.route === "/bot" ? "active" : ""}
                  onClick={() => navigateFromRail(item.route)}
                >
                  <item.icon aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
            <div className="apex-connection">
              <span className={connectedConnections.length ? "connection-dot live" : "connection-dot"} />
              <div>
                <strong>{connectionChecksPending
                  ? "Checking broker links"
                  : connectionChecksUnavailable
                  ? "Broker state unavailable"
                  : connectedConnections.length
                  ? `${connectedConnections.length}/${activeConnections.length} brokers connected`
                  : "No broker verified"}</strong>
                <span>{connectedConnections.length
                  ? connectedConnections.map((connection: any) => connection.display_name).join(" · ")
                  : activeConnections.length ? "Configured links are not ready" : "No active connection returned"}</span>
              </div>
            </div>
          </aside>

          <main className="apex-main">
            {dataStale && (
              <div className="apex-stale-notice" role="status">
                <WifiOff aria-hidden="true" /> One or more operational sources are unavailable. Unknown values are labelled rather than assumed safe.
              </div>
            )}

            <div className="apex-editorial-grid">
              <section className="apex-column apex-scan-column" aria-labelledby="latest-scan-title">
                <div className="apex-section-head">
                  <div>
                    <p className="apex-kicker">{getCurrentSession()} Session</p>
                    <h1 id="latest-scan-title">Latest Scan</h1>
                  </div>
                  <div className="apex-processed">
                    <span className={scanIsRecent ? "connection-dot live" : "connection-dot"} />
                    {currentScan ? `${currentScan.pairs_scanned || scanDetails.length} pairs processed · ${currentScanAge}` : "Awaiting first scan"}
                  </div>
                </div>

                <div className="apex-scan-time-row">
                  <time>{formatClock(currentScan?.scanned_at)}</time>
                  <div className="apex-inline-actions">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button className="apex-icon-button" onClick={() => manualScan.mutate()} disabled={!tradingControlsEnabled || manualScan.isPending || scanPolling} aria-label="Run scan now">
                          {manualScan.isPending || scanPolling ? <Loader2 className="spin" /> : <RefreshCw />}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{scanPolling ? "Scan running" : "Run scan now"}</TooltipContent>
                    </Tooltip>
                    <button onClick={() => { setScanIndex((value) => Math.min(scans.length - 1, value + 1)); setSelectedPair(null); }} disabled={safeScanIndex >= scans.length - 1}>
                      <ChevronLeft /> older
                    </button>
                    <button onClick={() => { setScanIndex((value) => Math.max(0, value - 1)); setSelectedPair(null); }} disabled={safeScanIndex === 0}>
                      newer <ChevronRight />
                    </button>
                  </div>
                </div>

                <div className="apex-segmented" role="group" aria-label="Filter scan rows">
                  {([
                    ["all", `All ${scanDetails.length}`],
                    ["signals", `Signals ${scanDetails.filter(isSignal).length}`],
                    ["qualified", `Qualified ${scanDetails.filter(isQualified).length}`],
                  ] as Array<[ScanFilter, string]>).map(([value, label]) => (
                    <button key={value} className={scanFilter === value ? "active" : ""} onClick={() => setScanFilter(value)}>{label}</button>
                  ))}
                </div>

                <div className="apex-scan-list">
                  {scansQuery.isLoading ? (
                    <div className="apex-empty"><Loader2 className="spin" /> Loading scan ledger…</div>
                  ) : displayedScanDetails.length === 0 ? (
                    <div className="apex-empty">No rows match this view.</div>
                  ) : displayedScanDetails.map((detail) => {
                    const symbol = pairName(detail);
                    const score = Number(detail.score);
                    const presentation = statusPresentation(detail);
                    const sparkline = scanScoreHistory(scans, symbol);
                    return (
                      <button
                        key={`${symbol}-${detail.status}`}
                        className={`apex-scan-row ${selectedPair === symbol ? "selected" : ""}`}
                        onClick={() => setSelectedPair(symbol)}
                      >
                        <div className="apex-row-primary">
                          <span className="apex-direction-icon">
                            {detail.direction === "long" ? <TrendingUp /> : detail.direction === "short" ? <TrendingDown /> : <Activity />}
                          </span>
                          <strong>{symbol}</strong>
                          <span className="apex-row-score">{Number.isFinite(score) ? `${score.toFixed(1)}%` : "—"}</span>
                          <span className={`apex-badge ${presentation.tone}`}>{presentation.label}</span>
                        </div>
                        <div className="apex-row-secondary">
                          <div className="apex-sparkline" aria-label={`${symbol} score history`}>
                            {sparkline.length > 1 ? (
                              <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={sparkline}>
                                  <YAxis hide domain={[0, 100]} />
                                  <Line type="linear" dataKey="value" stroke="#24231f" strokeWidth={1.2} dot={false} isAnimationActive={false} />
                                </LineChart>
                              </ResponsiveContainer>
                            ) : <span />}
                          </div>
                          <div className="apex-score-track"><span style={{ width: `${Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0))}%` }} /></div>
                          <span className="apex-row-note">{detail.reason || detail.status?.replace(/_/g, " ") || "No status detail"}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {selectedScanDetail && (
                  <div className="apex-scan-footnote">
                    <span>Selected</span>
                    <strong>{pairName(selectedScanDetail)}</strong>
                    <span>{selectedScanDetail.direction || "neutral"}</span>
                    <span>{selectedScanDetail.status?.replace(/_/g, " ") || "observed"}</span>
                  </div>
                )}
              </section>

              <section id="zone-setups" className="apex-column apex-zone-column" aria-labelledby="zone-setups-title">
                <div className="apex-section-head">
                  <div>
                    <p className="apex-kicker">Execution lifecycle</p>
                    <h2 id="zone-setups-title">Zone Setups</h2>
                  </div>
                  <span className="apex-meta-count">{activeOrders.length} active · {huntingOrders.length} hunting{reconciliationOrders.length ? ` · ${reconciliationOrders.length} reconcile` : ""}</span>
                </div>

                {activeOrders.length > 1 && (
                  <div className="apex-active-order-strip" aria-label="Select active zone setup">
                    {activeOrders.map((order) => (
                      <button
                        key={order.order_id}
                        className={focusedOrder?.order_id === order.order_id ? "active" : ""}
                        onClick={() => setSelectedOrderId(order.order_id)}
                      >
                        <strong>{order.symbol}</strong>
                        <span>{pendingOrderDisplayStage(order).replace(/_/g, " ")}</span>
                      </button>
                    ))}
                  </div>
                )}

                {pendingQuery.isLoading ? (
                  <div className="apex-focus-empty"><Loader2 className="spin" /> Loading setup ledger…</div>
                ) : focusedOrder ? (
                  <article className="apex-focus-setup">
                    <div className="apex-focus-heading">
                      <div>
                        <p className="apex-symbol-line">
                          {focusedOrder.symbol}
                          <span className={focusedOrder.direction === "long" ? "long" : "short"}>{focusedOrder.direction}</span>
                        </p>
                        <strong className="apex-quote">{optionalPrice(focusedOrder.current_price ?? focusedOrder.entry_price, focusedOrder.symbol)}</strong>
                      </div>
                      <div className="apex-focus-actions">
                        <span className={`apex-hunt-status ${pendingOrderDisplayStage(focusedOrder)}`}>{pendingOrderDisplayStage(focusedOrder).replace(/_/g, " ")}</span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button className="apex-cancel-setup" aria-label={`Cancel ${focusedOrder.symbol} setup`} disabled={cancelPendingMutation.isPending} onClick={() => {
                              if (window.confirm(`Cancel ${focusedOrder.symbol} zone setup?`)) cancelPendingMutation.mutate(focusedOrder.order_id);
                            }}><X /></button>
                          </TooltipTrigger>
                          <TooltipContent>Cancel frozen setup</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>

                    <div className="apex-zone-chart" aria-label={`${focusedOrder.symbol} setup price history`}>
                      {priceHistory.length > 1 ? (
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={priceHistory} margin={{ top: 10, right: 2, bottom: 0, left: 2 }}>
                            <YAxis hide domain={["dataMin", "dataMax"]} />
                            <Area type="linear" dataKey="value" stroke="#2997a5" fill="#2997a5" fillOpacity={0.14} strokeWidth={2} dot={false} isAnimationActive={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                      ) : (
                        <div className="apex-chart-unavailable"><AreaChartIcon /> Price history will appear after repeated scans.</div>
                      )}
                    </div>

                    <div className="apex-zone-range">
                      {focusedGeometry ? <>
                        <div className="apex-zone-band" style={focusedGeometry.style}>
                          <span className="stop-marker" />
                          <span className="zone-marker" />
                          <span className="target-marker" />
                        </div>
                        <div className="apex-zone-labels">
                          {focusedGeometry.labels.map((label) => <span key={label.key}>{label.label}<strong>{label.value}</strong></span>)}
                        </div>
                      </> : <div className="apex-geometry-unavailable">Frozen stop/zone/target geometry is unavailable.</div>}
                    </div>

                    <dl className="apex-setup-stats">
                      <div><dt>Score</dt><dd>{focusedOrder.signal_score == null ? "Unavailable" : `${Number(focusedOrder.signal_score).toFixed(1)}%`}</dd></div>
                      <div><dt>Time left</dt><dd>{timeRemaining(focusedOrder.expires_at)}</dd></div>
                      <div><dt>Entry</dt><dd>{optionalPrice(focusedOrder.entry_price, focusedOrder.symbol)}</dd></div>
                      <div><dt>Position size</dt><dd>{focusedOrder.size == null ? "At authorization" : `${focusedOrder.size} lots`}</dd></div>
                    </dl>
                    <div className={`apex-stop-policy ${focusedStopPolicy?.enforced ? "enforced" : "observe"}`}>
                      <span>Zone stop policy / <strong>{focusedStopPolicy?.label}</strong></span>
                      <em>{focusedStopPolicy?.detail}</em>
                    </div>
                  </article>
                ) : (
                  <div className="apex-focus-empty">
                    <Target />
                    <strong>No active zone setup</strong>
                    <span>Qualified setups will appear after the scanner freezes executable geometry.</span>
                  </div>
                )}

                <div className="apex-watchlist-head">
                  <h3>Watchlist</h3>
                  <span>{watchingOrders.length} pre-armed · {stagedSetups.length} monitoring</span>
                </div>
                {watchingOrders.length === 0 ? (
                  <div className="apex-table-empty">No pre-armed setups are waiting for price.</div>
                ) : <div className="apex-watchlist-table"><table aria-label="Zone setup watchlist">
                  <thead><tr><th>Instrument</th><th>Direction</th><th>Zone</th><th>Distance</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>{watchingOrders.slice(0, 6).map((order) => (
                    <tr key={order.order_id}>
                      <td><button className="apex-row-select" onClick={() => setSelectedOrderId(order.order_id)}>{order.symbol}</button></td>
                      <td><span className={order.direction}>{order.direction}</span></td>
                      <td>{zoneType(order)}</td>
                      <td className="distance">{formatDistance(order)}</td>
                      <td><button className="apex-row-cancel" aria-label={`Cancel ${order.symbol} setup`} disabled={cancelPendingMutation.isPending} onClick={() => {
                        if (window.confirm(`Cancel ${order.symbol} zone setup?`)) cancelPendingMutation.mutate(order.order_id);
                      }}><X /></button></td>
                    </tr>
                  ))}</tbody>
                </table></div>}

                {stagedSetups.length > 0 && <>
                  <div className="apex-watchlist-head compact">
                    <h3>Staged Candidates</h3>
                    <span>Before pending order</span>
                  </div>
                  <div className="apex-staged-list">
                    {stagedSetups.slice(0, 5).map((setup) => (
                      <div key={setup.id}>
                        <strong>{setup.symbol}</strong>
                        <span className={setup.direction}>{setup.direction}</span>
                        <span>{setup.lifecycle_phase?.replace(/_/g, " ") || setup.status.replace(/_/g, " ")}</span>
                        <span>{Number.isFinite(Number(setup.current_score)) ? `${Number(setup.current_score).toFixed(1)}%` : "—"}</span>
                        <button aria-label={`Dismiss ${setup.symbol} candidate`} disabled={dismissStagedMutation.isPending} onClick={() => {
                          if (window.confirm(`Dismiss ${setup.symbol} staged candidate?`)) dismissStagedMutation.mutate(setup.id);
                        }}><X /></button>
                      </div>
                    ))}
                  </div>
                </>}
              </section>

              <aside className="apex-column apex-now-column" aria-labelledby="now-title">
                <section className="apex-commentary">
                  <p className="apex-kicker">Desk brief</p>
                  <h2 id="now-title">What’s happening now</h2>
                  <p>{commentary(focusedOrder)}</p>
                  {focusedOrder && (
                    <button className="apex-text-action" onClick={() => navigate(`/chart?symbol=${encodeURIComponent(focusedOrder.symbol)}`)}>
                      Open {focusedOrder.symbol} chart <ChevronRight />
                    </button>
                  )}
                </section>

                <section className="apex-pipeline" aria-labelledby="pipeline-title">
                  <div className="apex-subsection-head">
                    <h3 id="pipeline-title">Decision Pipeline</h3>
                    <span>{focusedOrder?.candidate_id ? `#${focusedOrder.candidate_id.slice(0, 8)}` : "No candidate"}</span>
                  </div>
                  <ol>
                    {pipeline.map((step, index) => (
                      <li key={step.label} className={step.state}>
                        <span className="pipeline-marker">{step.state === "complete" ? "✓" : index + 1}</span>
                        <div><strong>{step.label}</strong><span>{step.detail}</span></div>
                      </li>
                    ))}
                  </ol>
                </section>

                <section className="apex-events" aria-labelledby="events-title">
                  <div className="apex-subsection-head">
                    <h3 id="events-title">Recent Events</h3>
                    <span>Live ledger</span>
                  </div>
                  <div>
                    {recentEvents.length === 0 ? (
                      <p className="apex-table-empty">No lifecycle events yet.</p>
                    ) : recentEvents.map((event) => (
                      <div className="apex-event" key={event.id}>
                        <time>{formatClock(event.time, false)}</time>
                        <span className={`event-dot ${event.tone}`} />
                        <p><strong>{event.label}</strong><span>{event.detail}</span></p>
                      </div>
                    ))}
                  </div>
                </section>
              </aside>
            </div>
          </main>
        </div>

        <footer className="apex-bottom-strip">
          <div><span>Scans today</span><strong title="Computed from the latest 100 scan rows">{scansToday.length}{dailyLedgerTruncated ? "+" : ""}</strong></div>
          <div><span>Signals found</span><strong title="Computed from the latest 100 scan rows">{signalsToday}{dailyLedgerTruncated ? "+" : ""}</strong></div>
          <div><span>Trades today</span><strong title="Computed from the latest 100 scan rows">{tradesToday}{dailyLedgerTruncated ? "+" : ""}</strong></div>
          <div className="apex-api-metric">
            <span>API ceiling</span><strong>50 <small>/ min</small></strong>
            <em>{scanBudgetHealth ? `${scanBudgetHealth.refused || 0} refused · ${scanBudgetHealth.unenforced || 0} unenforced` : "Awaiting scan health"}</em>
          </div>
          <div className="apex-engine-suite">
            <button className="apex-engine-control" aria-label={engineAction === "pause" ? "Pause engine" : "Start engine"} onClick={() => engineMutation.mutate(engineAction)} disabled={engineControlDisabled}>
              {engineAction === "pause" ? <Pause /> : <Play />}
              <span><strong>{engineLabel}</strong><small>{statusUnavailable ? "Pause remains available" : executionMode === "live" ? "Live execution" : "Paper execution"}</small></span>
            </button>
            <Tooltip><TooltipTrigger asChild>
              <button className="apex-stop-control" aria-label="Stop engine" disabled={stopEngineMutation.isPending || (accountStatusKnown && !isRunning)} onClick={() => {
                if (window.confirm("Stop the trading engine?")) stopEngineMutation.mutate();
              }}><Square /></button>
            </TooltipTrigger><TooltipContent>Stop engine</TooltipContent></Tooltip>
            <button className="apex-mode-control" disabled={modeMutation.isPending || !modeChangeEnabled} onClick={() => {
              const nextMode: ExecutionMode = executionMode === "live" ? "paper" : "live";
              const warning = nextMode === "live"
                ? "Enable LIVE execution? New authorized trades may be sent to connected brokers."
                : "Switch to PAPER execution? Every active broker has been verified with no open positions.";
              if (window.confirm(warning)) modeMutation.mutate(nextMode);
            }}>{statusUnavailable ? "Mode unknown" : executionMode === "live" ? "→ Paper" : "→ Live"}</button>
          </div>
          <button
            className="apex-kill-switch"
            disabled={killMutation.isPending || (accountStatusKnown && status.killSwitchActive)}
            onClick={() => {
              if (window.confirm("Activate the kill switch? This closes open positions and halts trading.")) killMutation.mutate();
            }}
          >
            <ShieldAlert /> {status.killSwitchActive ? "Kill Switch Active" : "Kill Switch"}
          </button>
        </footer>

        <Sheet open={positionsOpen} onOpenChange={setPositionsOpen}>
          <SheetContent side="right" className="apex-position-sheet">
            <SheetHeader>
              <SheetTitle>Open Positions</SheetTitle>
              <SheetDescription className="sr-only">Known broker exposure and managed position records.</SheetDescription>
            </SheetHeader>
            <section className="apex-position-section">
              <div className="apex-position-section-head"><h3>Broker positions</h3><span>{brokerTrades.length} known</span></div>
              {brokerExposurePending && <div className="apex-position-warning"><Loader2 className="spin" /> Broker exposure is still being verified. Known positions are shown below.</div>}
              {brokerExposureUnavailable && <div className="apex-position-warning"><WifiOff /> Broker exposure could not be verified for every active connection. Do not assume unreported exposure is zero.</div>}
              {brokerConnectionsKnown && activeConnections.length === 0 && <div className="apex-empty">No active broker connection configured.</div>}
              {brokerExposureComplete && activeConnections.length > 0 && brokerTrades.length === 0 && <div className="apex-empty">All verified brokers report no open trades.</div>}
              {brokerTrades.length > 0 && <div className="apex-position-list">{brokerTrades.map(({ trade, connection }: any, index: number) => {
                const symbol = brokerTradeSymbol(trade);
                const direction = brokerTradeDirection(trade);
                const pnl = Number(trade.profit ?? trade.unrealizedPL ?? trade.unrealizedProfit ?? 0);
                const tradeId = recordIdentifier(trade.id);
                return <article key={`${connection.id}-${tradeId || `missing-${index}`}`}>
                  <div><strong>{symbol}</strong><span className={direction}>{direction} · {connection.display_name}</span></div>
                  <dl>
                    <div><dt>Entry</dt><dd>{optionalPrice(trade.openPrice ?? trade.price, symbol)}</dd></div>
                    <div><dt>Current</dt><dd>{optionalPrice(trade.currentPrice, symbol)}</dd></div>
                    <div><dt>P&amp;L</dt><dd>{Number.isFinite(pnl) ? pnl.toFixed(2) : "Unavailable"}</dd></div>
                  </dl>
                  <button disabled={brokerCloseMutation.isPending || !tradeId} onClick={() => {
                    if (tradeId && window.confirm(`Close ${symbol} at ${connection.display_name}?`)) brokerCloseMutation.mutate({ connectionId: connection.id, tradeId });
                  }}><X /> Close at broker</button>
                </article>;
              })}</div>}
              {brokerAccounts.length > 0 && <p className="apex-account-footnote">{brokerAccounts.map(({ connection, account }: any) => `${connection.display_name}: ${account.balance ?? account.equity ?? "balance unavailable"}`).join(" · ")}</p>}
            </section>

            <section className="apex-position-section">
              <div className="apex-position-section-head"><h3>Managed position ledger</h3><span>Broker-first close authority</span></div>
              {statusUnavailable ? (
                <div className="apex-position-warning"><WifiOff /> Internal position state is unavailable. Open exposure has not been assumed to be zero.</div>
              ) : !Array.isArray(status.positions) || status.positions.length === 0 ? (
                <div className="apex-empty">No internal open positions.</div>
              ) : <div className="apex-position-list">{status.positions.map((position: any, index: number) => {
                const positionId = recordIdentifier(position.id);
                return <article key={positionId || `missing-${index}`}>
                  <div><strong>{position.symbol}</strong><span className={position.direction}>{position.direction}</span></div>
                  <dl>
                    <div><dt>Entry</dt><dd>{optionalPrice(position.entryPrice, position.symbol)}</dd></div>
                    <div><dt>Current</dt><dd>{optionalPrice(position.currentPrice, position.symbol)}</dd></div>
                    <div><dt>P&amp;L</dt><dd>{Number(position.pnl || 0).toFixed(2)}</dd></div>
                  </dl>
                  <button disabled={paperCloseMutation.isPending || !positionId} onClick={() => {
                    if (positionId && window.confirm(`Close ${position.symbol} managed position? Linked live broker positions close first; the internal ledger finalizes only after broker confirmation.`)) paperCloseMutation.mutate(positionId);
                  }}><X /> Close managed position</button>
                </article>;
              })}</div>}
            </section>
          </SheetContent>
        </Sheet>
      </div>
    </AppShell>
  );
}

export default OperationsDashboard;
