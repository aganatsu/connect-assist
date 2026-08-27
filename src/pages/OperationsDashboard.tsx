/* eslint-disable @typescript-eslint/no-explicit-any -- Existing edge-function responses are untyped at this UI boundary. */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  AreaChart as AreaChartIcon,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Download,
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
import { ScanDetailBreakdown } from "@/components/ScanDetailBreakdown";
import { WorkspaceHeader, WorkspacePage } from "@/components/WorkspacePage";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  brokerApi,
  brokerExecApi,
  paperApi,
  scannerApi,
  type ImpulseEntryLifecycleTransition,
  type PendingOrder,
  type PendingOrderSnapshot,
  type SetupLifecycleEvent,
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
import {
  pendingOrderConfirmationPresentation,
  pendingOrderDisplayStage,
  pendingOrderDistancePrice,
  pendingOrderNestedPoiPresentation,
  pendingOrderPostConfirmationPresentation,
} from "@/lib/pendingOrderDisplay";
import "@/styles/operations-dashboard.css";

type ScanFilter = "all" | "signals" | "qualified";
type ContextPanel = "detail" | "lifecycle";
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

function scanStatusDetail(detail: any): string {
  const status = String(detail?.status || "");
  if (status === "skipped_no_impulse_zone") {
    const hasImpulseCandidate = Boolean(
      detail?.unifiedZone?.impulse || detail?.impulseZone?.impulse,
    );
    return hasImpulseCandidate
      ? "impulse candidate found · no valid entry zone"
      : "no valid impulse or entry zone";
  }
  return detail?.reason || detail?.skipReason || status.replace(/_/g, " ") || "No status detail";
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

function timeRemaining(expiresAt: string | null | undefined): string {
  if (!expiresAt) return "No expiry";
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return "Expired";
  const minutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function formatDistance(
  order: PendingOrder,
  target: "entry" | "outer_zone" = "entry",
): string {
  const distance = pendingOrderDistancePrice(order, target);
  if (distance === null) return "—";
  return formatPipDisplay(distance / getPipSize(order.symbol), order.symbol, {
    showSign: false,
  });
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

interface SetupIdentity {
  orderId: string | null;
  stagedSetupId: string | null;
  candidateId: string | null;
  impulseEntryLifecycleId: string | null;
  symbol: string;
  direction: "long" | "short" | null;
}

function scanSetupIdentity(detail: any): SetupIdentity {
  const rawDirection = String(detail?.direction || "").toLowerCase();
  return {
    orderId: recordIdentifier(
      detail?.setupIdentity?.orderId ??
        detail?.limitOrder?.orderId ??
        detail?.goldenReplaySnapshot?.provenance?.orderId,
    ),
    stagedSetupId: recordIdentifier(
      detail?.setupIdentity?.stagedSetupId ??
        detail?.staging?.setupId ??
        detail?.staging?.stagedSetupId ??
        detail?.watchlistLifecycle?.setupId ??
        detail?.goldenReplaySnapshot?.provenance?.stagedSetupId,
    ),
    candidateId: recordIdentifier(
      detail?.setupIdentity?.candidateId ??
        detail?.staging?.candidateId ??
        detail?.limitOrder?.candidateId ??
        detail?.goldenReplaySnapshot?.provenance?.candidateId ??
        detail?.singleOwnershipDecision?.identity?.candidateId,
    ),
    impulseEntryLifecycleId: recordIdentifier(
      detail?.setupIdentity?.impulseEntryLifecycleId ??
        detail?.impulseEntryLifecycleId ??
        detail?.impulse_entry_lifecycle_id,
    ),
    symbol: pairName(detail),
    direction: rawDirection === "long" || rawDirection === "short"
      ? rawDirection
      : null,
  };
}

function orderMatchesIdentity(
  order: PendingOrder,
  identity: SetupIdentity,
): boolean {
  if (identity.orderId && order.order_id === identity.orderId) return true;
  if (
    identity.stagedSetupId &&
    recordIdentifier(order.staged_setup_id) === identity.stagedSetupId
  ) return true;
  if (
    identity.candidateId &&
    recordIdentifier(order.candidate_id) === identity.candidateId
  ) return true;
  if (
    identity.impulseEntryLifecycleId &&
    recordIdentifier(order.impulse_entry_lifecycle_id) ===
      identity.impulseEntryLifecycleId
  ) return true;
  return false;
}

type SetupLinkMethod =
  | "order_id"
  | "staged_setup_id"
  | "candidate_id"
  | "impulse_entry_lifecycle_id"
  | "legacy_symbol";

function linkedOrderForScan(
  orders: PendingOrder[],
  detail: any,
): { order: PendingOrder; method: SetupLinkMethod } | null {
  if (!detail) return null;
  const identity = scanSetupIdentity(detail);
  const exactOrder = orders.find((order) => orderMatchesIdentity(order, identity));
  if (exactOrder) {
    const method: SetupLinkMethod = identity.orderId === exactOrder.order_id
      ? "order_id"
      : identity.stagedSetupId === recordIdentifier(exactOrder.staged_setup_id)
      ? "staged_setup_id"
      : identity.candidateId === recordIdentifier(exactOrder.candidate_id)
      ? "candidate_id"
      : "impulse_entry_lifecycle_id";
    return { order: exactOrder, method };
  }

  if (
    identity.orderId ||
    identity.stagedSetupId ||
    identity.candidateId ||
    identity.impulseEntryLifecycleId
  ) {
    return null;
  }
  const sameSymbol = orders.filter((order) => order.symbol === identity.symbol);
  const sameDirection = identity.direction
    ? sameSymbol.filter((order) => order.direction === identity.direction)
    : sameSymbol;
  const legacyMatches = sameDirection.length === 1 ? sameDirection : sameSymbol;
  return legacyMatches.length === 1
    ? { order: legacyMatches[0], method: "legacy_symbol" }
    : null;
}

function lifecycleEventMatchesIdentity(
  event: SetupLifecycleEvent,
  identity: SetupIdentity,
): boolean {
  if (
    identity.stagedSetupId &&
    event.staged_setup_id === identity.stagedSetupId
  ) return true;
  return Boolean(
    identity.candidateId && event.candidate_id === identity.candidateId,
  );
}

function lifecycleEventTone(event: SetupLifecycleEvent): string {
  if (event.to_status === "filled") return "green";
  if (["invalidated", "cancelled", "expired", "blocked_after_qualification"].includes(event.to_status)) {
    return "red";
  }
  if (["qualified", "pending", "awaiting_confirmation"].includes(event.to_status)) {
    return "orange";
  }
  return "cyan";
}

function impulseLifecycleEventTone(
  event: ImpulseEntryLifecycleTransition,
): string {
  if (["confirmation_passed", "entered"].includes(event.event_type)) return "green";
  if (["impulse_invalidated", "expired", "no_zones_left"].includes(event.event_type)) return "red";
  if (["candidate_failed", "zone_touched", "trigger_locked"].includes(event.event_type)) return "orange";
  return "cyan";
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
  anchor.download = `smc-trading-dashboard-scan-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildPipeline(order: PendingOrder | null): Array<{ label: string; detail: string; state: PipelineState }> {
  if (!order) {
    return [
      { label: "Zone entered", detail: "Waiting for an active setup", state: "pending" },
      { label: "Confirmation", detail: "Frozen when the next setup is created", state: "pending" },
      { label: "Post-confirmation entry", detail: "Frozen when the next setup is created", state: "pending" },
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
  const nestedPoi = pendingOrderNestedPoiPresentation(order);
  const confirmationStep = pendingOrderConfirmationPresentation(order);
  const confirmationDone = confirmationStep.complete;
  const zoneEntered = stage !== "watching";
  const finalAuthorized = order.final_authorization?.authorized === true;

  const steps: Array<{ label: string; detail: string; state: PipelineState }> = [
    {
      label: nestedPoi.route === "none" ? "Zone entered" : "Outer zone entered",
      detail: zoneEntered ? `Frozen ${zoneType(order)} engaged` : `${formatDistance(order, nestedPoi.route === "enforce" ? "outer_zone" : "entry")} from ${nestedPoi.route === "enforce" ? "outer zone" : "entry"}`,
      state: zoneEntered ? "complete" : "active",
    },
  ];

  if (nestedPoi.route === "enforce") {
    steps.push({
      label: nestedPoi.label,
      detail: nestedPoi.detail,
      state: nestedPoi.complete ? "complete" : zoneEntered ? "active" : "pending",
    });
    steps.push({
      label: "Final authorization",
      detail: finalAuthorized ? "Risk and execution checks passed" : "Awaiting fresh price, risk, and broker checks",
      state: finalAuthorized ? "complete" : nestedPoi.entryReady ? "active" : "pending",
    });
    return steps;
  }

  if (nestedPoi.route === "observe") {
    steps.push({
      label: nestedPoi.label,
      detail: nestedPoi.detail,
      state: "complete",
    });
  }

  steps.push({
    label: confirmationStep.label,
    detail: confirmationStep.detail,
    state: confirmationDone ? "complete" : zoneEntered ? "active" : "pending",
  });
  const postConfirmation =
    pendingOrderPostConfirmationPresentation(order, confirmationDone);
  if (postConfirmation.step) {
    steps.push(postConfirmation.step);
  }
  const entryReady = postConfirmation.entryReady;
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
    const nestedPoi = pendingOrderNestedPoiPresentation(order);
    if (nestedPoi.route === "enforce") {
      return nestedPoi.complete
        ? `${order.symbol} touched its frozen nested POI on a closed candle. Fresh price, risk, direction, and broker checks now decide whether a market order may be sent.`
        : `${order.symbol} entered its outer ${zoneType(order)}. ${nestedPoi.detail}. No order is sent from the broad zone alone.`;
    }
    const confirmation = pendingOrderConfirmationPresentation(order);
    const contractDescription = confirmation.frozenAtSetup
      ? `the frozen ${confirmation.label} contract`
      : confirmation.methodSource === "frozen"
      ? `the persisted ${confirmation.label} contract`
      : confirmation.methodSource === "legacy_persisted"
      ? `the legacy persisted ${confirmation.label} contract`
      : confirmation.methodSource === "runtime_observation"
      ? `the currently observed ${confirmation.label} contract`
      : "the current confirmation settings for this legacy setup";
    return `${order.symbol} has entered its frozen ${zoneType(order)}. Price is now being evaluated against ${contractDescription}. Current state: ${confirmation.detail}. No order is sent until the remaining authorization checks pass.`;
  }
  if (stage === "retracement") {
    return `${order.symbol} completed its ${direction} confirmation contract and is now waiting for price to return to its frozen retracement zone before final authorization.`;
  }
  const nestedPoi = pendingOrderNestedPoiPresentation(order);
  const distanceTarget = nestedPoi.route === "enforce" ? "outer_zone" : "entry";
  return `${order.symbol} remains pre-armed ${formatDistance(order, distanceTarget)} from its frozen ${zoneType(order)}. Lightweight monitoring continues until price approaches the zone; deeper confirmation analysis starts before touch.`;
}

function OperationsDashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [now, setNow] = useState(new Date());
  const [scanIndex, setScanIndex] = useState(0);
  const [scanFilter, setScanFilter] = useState<ScanFilter>("all");
  const [selectedPair, setSelectedPair] = useState<string | null>(null);
  const [contextPanel, setContextPanel] = useState<ContextPanel>("detail");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [positionsOpen, setPositionsOpen] = useState(false);
  const [scanPolling, setScanPolling] = useState(false);
  const scanPollRef = useRef<number | null>(null);
  const scanStartedAtRef = useRef<string | null>(null);

  const handleContextTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let nextPanel: ContextPanel | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      nextPanel = contextPanel === "detail" ? "lifecycle" : "detail";
    } else if (event.key === "Home") {
      nextPanel = "detail";
    } else if (event.key === "End") {
      nextPanel = "lifecycle";
    }
    if (!nextPanel) return;

    event.preventDefault();
    setContextPanel(nextPanel);
    document.getElementById(nextPanel === "detail" ? "detail-breakdown-tab" : "lifecycle-tab")?.focus();
  };

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
  const connectionListUnavailable = connectionsQuery.isError ||
    (connectionsQuery.isSuccess && !Array.isArray(connectionsQuery.data));
  const connectionChecksUnavailable = connectionListUnavailable
    || connectionStatusQueries.some((query) => query.isError || query.data?.fallback === true);
  const brokerExposurePending = connectionsQuery.isPending || activeConnections.some((_: any, index: number) => {
    const statusCheck = connectionStatusQueries[index];
    const positionsCheck = brokerTradeQueries[index];
    return statusCheck?.isPending || positionsCheck?.isPending;
  });
  const brokerExposureUnavailable = connectionListUnavailable || activeConnections.some((_: any, index: number) => {
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
  const sessionRotationObservation =
    meta?.impulseRotation?.sessionObservation?.contract ===
        "session-aware-rotation-observation.v1"
      ? meta.impulseRotation.sessionObservation
      : null;
  const sessionRotationActual = Array.isArray(sessionRotationObservation?.actual)
    ? sessionRotationObservation.actual.map(String)
    : [];
  const sessionRotationProposed = Array.isArray(sessionRotationObservation?.proposed)
    ? sessionRotationObservation.proposed.map(String)
    : [];
  const sessionRotationSlots = Math.max(
    sessionRotationActual.length,
    sessionRotationProposed.length,
  );
  const sessionRotationOverlap = Number.isFinite(
      Number(sessionRotationObservation?.overlapCount),
    )
    ? Number(sessionRotationObservation.overlapCount)
    : sessionRotationActual.filter((symbol: string) =>
      sessionRotationProposed.includes(symbol)
    ).length;
  const sessionRotationTitle = sessionRotationObservation
    ? [
      `Current: ${sessionRotationActual.join(", ") || "none"}`,
      `Proposed: ${sessionRotationProposed.join(", ") || "none"}`,
      `Would promote: ${Array.isArray(sessionRotationObservation.wouldPromote) ? sessionRotationObservation.wouldPromote.join(", ") || "none" : "none"}`,
      `Would defer: ${Array.isArray(sessionRotationObservation.wouldDefer) ? sessionRotationObservation.wouldDefer.join(", ") || "none" : "none"}`,
    ].join(" · ")
    : undefined;
  const sessionRotationAvailable = sessionRotationObservation?.status !==
    "unavailable";
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
  const selectedScanIdentity = useMemo(
    () => selectedScanDetail ? scanSetupIdentity(selectedScanDetail) : null,
    [selectedScanDetail],
  );
  const huntingOrders = activeOrders.filter((order) => {
    const stage = pendingOrderDisplayStage(order);
    return stage === "confirmation" || stage === "retracement";
  });
  const reconciliationOrders = activeOrders.filter((order) => pendingOrderDisplayStage(order) === "reconciliation");
  const explicitlySelectedOrder = activeOrders.find((order) =>
    order.order_id === selectedOrderId &&
    (!selectedPair || order.symbol === selectedPair)
  ) || null;
  const linkedOrder = useMemo(
    () => linkedOrderForScan(activeOrders, selectedScanDetail),
    [activeOrders, selectedScanDetail],
  );
  const focusedOrder = explicitlySelectedOrder || linkedOrder?.order || null;
  const focusedOrderLinkMethod: SetupLinkMethod | null = explicitlySelectedOrder
    ? "order_id"
    : linkedOrder?.method || null;
  const watchingOrders = activeOrders.filter((order) => pendingOrderDisplayStage(order) === "watching");
  const priceHistory = focusedOrder ? scanPriceHistory(scans, focusedOrder.symbol) : [];
  const pipeline = buildPipeline(focusedOrder);
  const focusedNestedPoi = focusedOrder
    ? pendingOrderNestedPoiPresentation(focusedOrder)
    : null;
  const focusedConfirmation = focusedOrder
    ? pendingOrderConfirmationPresentation(focusedOrder)
    : null;
  const focusedConfirmationContext = focusedNestedPoi?.route === "enforce"
    ? "Nested POI market route frozen at setup"
    : focusedNestedPoi?.route === "observe"
    ? "Nested POI observed only; confirmation route still controls entry"
    : focusedConfirmation?.frozenAtSetup
    ? "Confirmation and entry modes frozen at setup"
    : focusedConfirmation?.methodSource === "frozen"
    ? "Confirmation method frozen; entry mode unavailable"
    : focusedConfirmation?.methodSource === "legacy_persisted"
    ? "Legacy setup · persisted confirmation method"
    : focusedConfirmation?.methodSource === "runtime_observation"
    ? "Legacy setup · current observed confirmation settings"
    : focusedConfirmation
    ? "Legacy setup · current confirmation settings"
    : null;
  const focusedGeometry = focusedOrder ? zoneGeometry(focusedOrder) : null;
  const focusedStopPolicy = focusedOrder ? stopPolicyPresentation(focusedOrder) : null;
  const selectedLifecycleIdentity: SetupIdentity | null = useMemo(
    () => focusedOrder
      ? {
          orderId: focusedOrder.order_id,
          stagedSetupId: recordIdentifier(focusedOrder.staged_setup_id),
          candidateId: recordIdentifier(focusedOrder.candidate_id),
          impulseEntryLifecycleId: recordIdentifier(
            focusedOrder.impulse_entry_lifecycle_id,
          ),
          symbol: focusedOrder.symbol,
          direction: focusedOrder.direction,
        }
      : selectedScanIdentity,
    [focusedOrder, selectedScanIdentity],
  );
  const hasSetupLedgerIdentity = Boolean(
    selectedLifecycleIdentity?.stagedSetupId ||
      selectedLifecycleIdentity?.candidateId,
  );
  const hasImpulseLedgerIdentity = Boolean(
    selectedLifecycleIdentity?.impulseEntryLifecycleId,
  );
  const lifecycleEventsQuery = useQuery({
    queryKey: [
      "setup-lifecycle-events",
      selectedLifecycleIdentity?.stagedSetupId,
      selectedLifecycleIdentity?.candidateId,
    ],
    queryFn: () => scannerApi.lifecycleEvents({
      stagedSetupId: selectedLifecycleIdentity?.stagedSetupId,
      candidateId: selectedLifecycleIdentity?.candidateId,
    }),
    enabled: hasSetupLedgerIdentity,
    refetchInterval: 15_000,
    retry: false,
  });
  const impulseLifecycleQuery = useQuery({
    queryKey: [
      "impulse-entry-lifecycle-transitions",
      selectedLifecycleIdentity?.impulseEntryLifecycleId,
    ],
    queryFn: () => scannerApi.impulseLifecycleTransitions(
      selectedLifecycleIdentity!.impulseEntryLifecycleId!,
    ),
    enabled: hasImpulseLedgerIdentity,
    refetchInterval: 15_000,
    retry: false,
  });
  const lifecycleEvents: SetupLifecycleEvent[] = useMemo(
    () => Array.isArray(lifecycleEventsQuery.data) ? lifecycleEventsQuery.data : [],
    [lifecycleEventsQuery.data],
  );
  const impulseLifecycleTransitions: ImpulseEntryLifecycleTransition[] = useMemo(
    () => Array.isArray(impulseLifecycleQuery.data) ? impulseLifecycleQuery.data : [],
    [impulseLifecycleQuery.data],
  );
  const selectedLifecycleEvents = useMemo(
    () => selectedLifecycleIdentity
      ? lifecycleEvents.filter((event) =>
          lifecycleEventMatchesIdentity(event, selectedLifecycleIdentity)
        )
      : [],
    [lifecycleEvents, selectedLifecycleIdentity],
  );
  const selectedImpulseLifecycleTransitions = useMemo(
    () => selectedLifecycleIdentity?.impulseEntryLifecycleId
      ? impulseLifecycleTransitions.filter((event) =>
          event.lifecycle_id === selectedLifecycleIdentity.impulseEntryLifecycleId
        )
      : [],
    [impulseLifecycleTransitions, selectedLifecycleIdentity],
  );

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
    const rows: Array<{
      id: string;
      time: string;
      label: string;
      detail: string;
      tone: string;
    }> = [];
    const latestScan = scans[0];
    if (latestScan?.scanned_at) {
      rows.push({
        id: `scan:${latestScan.scanned_at}`,
        time: latestScan.scanned_at,
        label: "Scan completed",
        detail: `${latestScan.pairs_scanned || 0} pairs · ${latestScan.signals_found || 0} signals`,
        tone: "cyan",
      });
    }
    const ordersById = new Map<string, PendingOrder>();
    for (const order of [...(pendingSnapshot.history || []), ...activeOrders]) {
      ordersById.set(order.order_id, order);
    }
    for (const order of ordersById.values()) {
      const time = order.resolved_at || order.updated_at || order.placed_at;
      if (!time) continue;
      rows.push({
        id: `order:${order.order_id}`,
        time,
        label: `${order.symbol} · ${order.status.replace(/_/g, " ")}`,
        detail: order.cancel_reason || order.fill_reason || `${order.direction.toUpperCase()} ${zoneType(order)}`,
        tone: order.status === "filled"
          ? "green"
          : ["invalidated", "expired", "cancelled", "broker_rejected"].includes(order.status)
          ? "red"
          : "orange",
      });
    }
    rows.push(
      ...selectedLifecycleEvents.map((event) => ({
        id: `setup:${event.id}`,
        time: event.created_at,
        label: `${event.symbol} · setup · ${event.to_status.replace(/_/g, " ")}`,
        detail: event.reason || event.reason_code?.replace(/_/g, " ") || "Setup transition recorded",
        tone: lifecycleEventTone(event),
      })),
      ...selectedImpulseLifecycleTransitions.map((event) => ({
        id: `impulse:${event.id}`,
        time: event.created_at,
        label: `${selectedLifecycleIdentity?.symbol || "Setup"} · impulse · ${event.event_type.replace(/_/g, " ")}`,
        detail: event.reason || "Impulse-entry transition recorded",
        tone: impulseLifecycleEventTone(event),
      })),
    );
    return rows.sort((left, right) =>
      new Date(right.time).getTime() - new Date(left.time).getTime()
    ).slice(0, 8);
  }, [
    activeOrders,
    pendingSnapshot.history,
    scans,
    selectedLifecycleEvents,
    selectedLifecycleIdentity?.symbol,
    selectedImpulseLifecycleTransitions,
  ]);

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
            queryClient.invalidateQueries({ queryKey: ["setup-lifecycle-events"] });
            queryClient.invalidateQueries({ queryKey: ["impulse-entry-lifecycle-transitions"] });
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
      queryClient.invalidateQueries({ queryKey: ["setup-lifecycle-events"] });
      queryClient.invalidateQueries({ queryKey: ["impulse-entry-lifecycle-transitions"] });
      toast.success("Zone setup cancelled");
    },
    onError: (error: any) => toast.error(error?.message || "Zone setup was not cancelled"),
  });
  const dismissStagedMutation = useMutation({
    mutationFn: (setupId: string) => scannerApi.dismissStaged(setupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staged-setups-active"] });
      queryClient.invalidateQueries({ queryKey: ["setup-lifecycle-events"] });
      queryClient.invalidateQueries({ queryKey: ["impulse-entry-lifecycle-transitions"] });
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

  const pendingOperationalSources = Array.from(new Set([
    ...(statusQuery.isPending ? ["Trading status"] : []),
    ...(scansQuery.isPending ? ["Scan ledger"] : []),
    ...(pendingQuery.isPending ? ["Zone setup ledger"] : []),
    ...(stagedQuery.isPending ? ["Staged candidates"] : []),
    ...(hasSetupLedgerIdentity && lifecycleEventsQuery.isPending ? ["Setup lifecycle ledger"] : []),
    ...(hasImpulseLedgerIdentity && impulseLifecycleQuery.isPending ? ["Impulse-entry lifecycle ledger"] : []),
    ...(connectionsQuery.isPending ? ["Broker connections"] : []),
    ...activeConnections.flatMap((connection: any, index: number) => {
      const brokerName = String(connection.display_name || connection.broker_type || `Broker ${index + 1}`);
      const sources: string[] = [];
      if (connectionStatusQueries[index]?.isPending) sources.push(`${brokerName} connection status`);
      if (brokerTradeQueries[index]?.isPending) sources.push(`${brokerName} open positions`);
      if (
        connectionStatusQueries[index]?.data?.ready === true
        && brokerAccountQueries[index]?.isPending
      ) {
        sources.push(`${brokerName} account summary`);
      }
      return sources;
    }),
  ]));
  const unavailableOperationalSources = Array.from(new Set([
    ...(statusQuery.isError || (!statusQuery.isPending && statusUnavailable) ? ["Trading status"] : []),
    ...(scansQuery.isError || (scansQuery.isSuccess && !Array.isArray(scansQuery.data)) ? ["Scan ledger"] : []),
    ...(pendingQuery.isError || pendingSnapshot.fallback === true ? ["Zone setup ledger"] : []),
    ...(stagedQuery.isError || (stagedQuery.isSuccess && !Array.isArray(stagedQuery.data)) ? ["Staged candidates"] : []),
    ...(hasSetupLedgerIdentity && (lifecycleEventsQuery.isError || (lifecycleEventsQuery.isSuccess && !Array.isArray(lifecycleEventsQuery.data))) ? ["Setup lifecycle ledger"] : []),
    ...(hasImpulseLedgerIdentity && (impulseLifecycleQuery.isError || (impulseLifecycleQuery.isSuccess && !Array.isArray(impulseLifecycleQuery.data))) ? ["Impulse-entry lifecycle ledger"] : []),
    ...(connectionListUnavailable ? ["Broker connections"] : []),
    ...activeConnections.flatMap((connection: any, index: number) => {
      const brokerName = String(connection.display_name || connection.broker_type || `Broker ${index + 1}`);
      const sources: string[] = [];
      const statusCheck = connectionStatusQueries[index];
      const positionsCheck = brokerTradeQueries[index];
      const accountCheck = brokerAccountQueries[index];
      if (statusCheck?.isError || statusCheck?.data?.fallback === true) {
        sources.push(`${brokerName} connection status`);
      }
      if (positionsCheck?.isError || (positionsCheck?.isSuccess && !Array.isArray(positionsCheck.data))) {
        sources.push(`${brokerName} open positions`);
      }
      if (
        statusCheck?.data?.ready === true
        && (accountCheck?.isError || accountCheck?.data?.fallback === true)
      ) {
        sources.push(`${brokerName} account summary`);
      }
      return sources;
    }),
  ]));

  return (
    <AppShell>
      <WorkspacePage layout="canvas" className="apex-ledger">
        <WorkspaceHeader
          icon={Radar}
          eyebrow="Bot operations"
          title="SMC Trading Dashboard"
          actions={
            <>
              <div className="apex-header-connection">
                <span className={connectedConnections.length ? "connection-dot live" : "connection-dot"} />
                <span>{connectionChecksPending
                  ? "Checking brokers"
                  : connectionChecksUnavailable
                  ? "Broker state unavailable"
                  : connectedConnections.length
                  ? `${connectedConnections.length}/${activeConnections.length} connected`
                  : "No broker verified"}</span>
              </div>
              <button className="workspace-page__action" onClick={() => setPositionsOpen(true)}>
                <CircleDollarSign aria-hidden="true" /> <span>Positions</span>
              </button>
              <button className="workspace-page__action" onClick={() => downloadScanCsv(scanDetails, currentScan?.scanned_at)} disabled={!scanDetails.length}>
                <Download aria-hidden="true" /> <span>Export</span>
              </button>
              <button className="workspace-page__action" onClick={() => navigate("/bot-config")}>
                <Settings aria-hidden="true" /> <span>Bot settings</span>
              </button>
            </>
          }
        />

        <main className="apex-main">
            {unavailableOperationalSources.length > 0 && (
              <div className="apex-stale-notice" role="alert">
                <WifiOff aria-hidden="true" />
                <span>Operational data unavailable: {unavailableOperationalSources.join(", ")}. Unknown values remain labelled.</span>
              </div>
            )}
            {pendingOperationalSources.length > 0 && (
              <div className="apex-stale-notice is-pending" role="status">
                <Loader2 className="spin" aria-hidden="true" />
                <span>Verifying operational data: {pendingOperationalSources.join(", ")}.</span>
              </div>
            )}

            <div className="apex-editorial-grid">
              <section className="apex-column apex-scan-column" aria-labelledby="latest-scan-title">
                <div className="apex-section-head">
                  <div>
                    <p className="apex-kicker">{getCurrentSession()} Session</p>
                    <h2 id="latest-scan-title">Latest Scan</h2>
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
                    <button onClick={() => { setScanIndex((value) => Math.min(scans.length - 1, value + 1)); setSelectedPair(null); setSelectedOrderId(null); }} disabled={safeScanIndex >= scans.length - 1}>
                      <ChevronLeft /> older
                    </button>
                    <button onClick={() => { setScanIndex((value) => Math.max(0, value - 1)); setSelectedPair(null); setSelectedOrderId(null); }} disabled={safeScanIndex === 0}>
                      newer <ChevronRight />
                    </button>
                  </div>
                </div>

                {sessionRotationObservation && (
                  <div
                    className="apex-session-observation"
                    role="status"
                    aria-label="Session-aware scan priority observation"
                    title={sessionRotationTitle}
                  >
                    <div className="apex-session-observation__heading">
                      <span>Session priority</span>
                      <span className="apex-session-observation__mode">Observe only</span>
                    </div>
                    <strong>
                      {sessionRotationAvailable
                        ? `${sessionRotationOverlap}/${sessionRotationSlots} same slots`
                        : "Unavailable"}
                    </strong>
                    <span>
                      {String(sessionRotationObservation.session?.name || "Unknown session")}
                      {" · "}
                      {String(sessionRotationObservation.style || meta?.activeStyle || "unknown").replace(/_/g, " ")}
                      {sessionRotationAvailable
                        ? sessionRotationObservation.restrictedAssetSessionGateOpen === false
                          ? " · gated session disabled · no extra API calls"
                          : " · no extra API calls"
                        : " · scan continued unchanged"}
                    </span>
                  </div>
                )}

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
                        onClick={() => {
                          setSelectedPair(symbol);
                          setSelectedOrderId(
                            linkedOrderForScan(activeOrders, detail)?.order.order_id || null,
                          );
                          setContextPanel("detail");
                        }}
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
                                  <Line type="linear" dataKey="value" stroke="hsl(var(--foreground))" strokeWidth={1.2} dot={false} isAnimationActive={false} />
                                </LineChart>
                              </ResponsiveContainer>
                            ) : <span />}
                          </div>
                          <div className="apex-score-track"><span style={{ width: `${Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0))}%` }} /></div>
                          <span className="apex-row-note">{scanStatusDetail(detail)}</span>
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
                    <span>{scanStatusDetail(selectedScanDetail)}</span>
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

                {activeOrders.length > 0 && (
                  <div className="apex-active-order-strip" aria-label="Select active zone setup">
                    {activeOrders.map((order) => (
                      <button
                        key={order.order_id}
                        className={focusedOrder?.order_id === order.order_id ? "active" : ""}
                        aria-label={`Select ${order.symbol} active setup`}
                        onClick={() => {
                          setScanFilter("all");
                          setSelectedOrderId(order.order_id);
                          setSelectedPair(order.symbol);
                        }}
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
                            <Area type="linear" dataKey="value" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.14} strokeWidth={2} dot={false} isAnimationActive={false} />
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
                    <strong>{selectedScanDetail
                      ? `No active setup linked to ${pairName(selectedScanDetail)}`
                      : "No active zone setup"}</strong>
                    <span>{activeOrders.length > 0
                      ? "Choose an active setup above, or select the scan that created it."
                      : "Qualified setups will appear after the scanner freezes executable geometry."}</span>
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
                      <td><button className="apex-row-select" onClick={() => { setScanFilter("all"); setSelectedOrderId(order.order_id); setSelectedPair(order.symbol); }}>{order.symbol}</button></td>
                      <td><span className={order.direction}>{order.direction}</span></td>
                      <td>{zoneType(order)}</td>
                      <td className="distance">{formatDistance(
                        order,
                        pendingOrderNestedPoiPresentation(order).route === "enforce"
                          ? "outer_zone"
                          : "entry",
                      )}</td>
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

              <aside className="apex-column apex-now-column" aria-label="Scan and lifecycle context">
                <div className="apex-context-tabs" role="tablist" aria-label="Context panel">
                  <button
                    id="detail-breakdown-tab"
                    role="tab"
                    aria-controls="detail-breakdown-panel"
                    aria-selected={contextPanel === "detail"}
                    tabIndex={contextPanel === "detail" ? 0 : -1}
                    className={contextPanel === "detail" ? "active" : ""}
                    onKeyDown={handleContextTabKeyDown}
                    onClick={() => setContextPanel("detail")}
                  >
                    Detail Breakdown
                  </button>
                  <button
                    id="lifecycle-tab"
                    role="tab"
                    aria-controls="lifecycle-panel"
                    aria-selected={contextPanel === "lifecycle"}
                    tabIndex={contextPanel === "lifecycle" ? 0 : -1}
                    className={contextPanel === "lifecycle" ? "active" : ""}
                    onKeyDown={handleContextTabKeyDown}
                    onClick={() => setContextPanel("lifecycle")}
                  >
                    Lifecycle
                  </button>
                </div>

                {contextPanel === "detail" ? (
                  <section
                    id="detail-breakdown-panel"
                    className="apex-detail-breakdown"
                    role="tabpanel"
                    aria-labelledby="detail-breakdown-tab"
                  >
                    <div className="apex-subsection-head">
                      <div>
                        <p className="apex-kicker">Selected scan</p>
                        <h2>Detail Breakdown</h2>
                      </div>
                      <span>{selectedScanDetail
                        ? `${pairName(selectedScanDetail)} · scan ${formatClock(currentScan?.scanned_at)}`
                        : "No row"}</span>
                    </div>
                    {selectedScanDetail ? (
                      <ScanDetailBreakdown signal={selectedScanDetail} observedAt={currentScan?.scanned_at} />
                    ) : (
                      <p className="apex-detail-empty">Select a scan row to inspect its setup model.</p>
                    )}
                  </section>
                ) : (
                  <div id="lifecycle-panel" className="apex-lifecycle-context" role="tabpanel" aria-labelledby="lifecycle-tab">
                    <section className="apex-commentary">
                      <p className="apex-kicker">Desk brief{selectedScanDetail ? ` · ${pairName(selectedScanDetail)}` : ""}</p>
                      <h2 id="now-title">What’s happening now</h2>
                      <p>{focusedOrder
                        ? commentary(focusedOrder)
                        : selectedScanDetail
                        ? `No active order is linked to the selected ${pairName(selectedScanDetail)} scan. Its exact lifecycle is added to Recent Activity when available; another instrument's lifecycle is never substituted into this pipeline.`
                        : commentary(null)}</p>
                      {focusedOrder && (
                        <>
                          <p className="apex-lifecycle-provenance">
                            Frozen {formatClock(focusedOrder.placed_at)} · Updated {formatClock(focusedOrder.updated_at)}
                            {pendingSnapshot.fetchedAt ? ` · Ledger fetched ${formatClock(pendingSnapshot.fetchedAt)}` : ""}
                            {focusedOrderLinkMethod === "legacy_symbol" ? " · Legacy symbol link" : ""}
                          </p>
                          <button className="apex-text-action" onClick={() => navigate(`/chart?symbol=${encodeURIComponent(focusedOrder.symbol)}`)}>
                            Open {focusedOrder.symbol} chart <ChevronRight />
                          </button>
                        </>
                      )}
                    </section>

                    <section className="apex-pipeline" aria-labelledby="pipeline-title">
                      <div className="apex-subsection-head">
                        <div>
                          <h3 id="pipeline-title">Decision Pipeline</h3>
                          {focusedOrder && (
                            <p className="apex-pipeline-frozen">
                              {focusedConfirmationContext}
                            </p>
                          )}
                        </div>
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
                        <h3 id="events-title">Recent Activity</h3>
                        <span>Operational ledger · selected setup detail</span>
                      </div>
                      <div>
                        {recentEvents.length === 0 &&
                            (lifecycleEventsQuery.isLoading || impulseLifecycleQuery.isLoading) ? (
                          <p className="apex-table-empty">Loading lifecycle events…</p>
                        ) : recentEvents.length === 0 ? (
                          <p className="apex-table-empty">No operational activity has been recorded yet.</p>
                        ) : recentEvents.map((event) => (
                          <div className="apex-event" key={event.id}>
                            <time>{formatClock(event.time, false)}</time>
                            <span className={`event-dot ${event.tone}`} />
                            <p><strong>{event.label}</strong><span>{event.detail}</span></p>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                )}
              </aside>
            </div>
        </main>

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
      </WorkspacePage>
    </AppShell>
  );
}

export default OperationsDashboard;
