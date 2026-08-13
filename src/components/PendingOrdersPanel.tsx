import { useState, useEffect, useCallback } from "react";
import { scannerApi, PendingOrder } from "@/lib/api";
import { generatePendingOrderNarrative } from "@/lib/narrative";
import { getPipSize, formatPipDisplay } from "@/lib/pipDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Clock, X, TrendingUp, TrendingDown, Target, ChevronDown, ChevronUp, AlertTriangle, Eye, Crosshair } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface PendingOrdersPanelProps {
  refreshTrigger?: number;
}

export default function PendingOrdersPanel({ refreshTrigger }: PendingOrdersPanelProps) {
  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [history, setHistory] = useState<PendingOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const { toast } = useToast();

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const [activeRes, allRes] = await Promise.all([
        scannerApi.activePending(),
        scannerApi.allPending(),
      ]);
      setOrders(activeRes || []);
      setHistory((allRes || []).filter((o: PendingOrder) => o.status !== "pending" && o.status !== "awaiting_confirmation" && o.status !== "reconciliation_required"));
    } catch (err) {
      console.error("Failed to fetch zone setups:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders, refreshTrigger]);

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(fetchOrders, 30000);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  const handleCancel = async (orderId: string) => {
    setCancelling(orderId);
    try {
      await scannerApi.cancelPending(orderId);
      toast({ title: "Setup cancelled", description: "Zone setup has been cancelled." });
      fetchOrders();
    } catch (err) {
      toast({ title: "Error", description: "Failed to cancel setup.", variant: "destructive" });
    } finally {
      setCancelling(null);
    }
  };

  const getTimeRemaining = (expiresAt: string): string => {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return "Expired";
    const mins = Math.floor(diff / 60000);
    const hrs = Math.floor(mins / 60);
    if (hrs > 0) return `${hrs}h ${mins % 60}m left`;
    return `${mins}m left`;
  };

  const getExpiryPercent = (placedAt: string, expiresAt: string): number => {
    const total = new Date(expiresAt).getTime() - new Date(placedAt).getTime();
    const elapsed = Date.now() - new Date(placedAt).getTime();
    return Math.min(100, Math.max(0, (elapsed / total) * 100));
  };

  const liquidityReason = (reason?: string): string => {
    switch (reason) {
      case "sequence_confirmed": return "Fresh sweep followed by later structure confirmation observed";
      case "zone_touch_pending": return "Waiting for price to touch the frozen entry zone";
      case "no_qualifying_sweep": return "Zone touched; no fresh qualifying liquidity sweep yet";
      case "sweep_before_zone_touch": return "Only a pre-touch sweep is available; a fresh sequence is required";
      case "confirmation_pending": return "Fresh sweep observed; waiting for later structure confirmation";
      case "confirmation_not_after_sweep": return "Structure confirmation is not later than the sweep";
      case "sweep_identity_unresolved": return "Sweep identity could not be resolved";
      case "legacy_contract_requires_fresh_sequence": return "Legacy evidence cannot authorize this sequence";
      case "setup_activation_time_unavailable": return "Setup activation time is unavailable";
      default: return "No sequence observation recorded yet";
    }
  };

  const getDistanceDisplay = (order: PendingOrder): string => {
    if (!order.current_price) return "—";
    const pipSize = getPipSize(order.symbol);
    const rawPips = Math.abs(Number(order.current_price) - Number(order.entry_price)) / pipSize;
    return formatPipDisplay(rawPips, order.symbol, { showSign: false });
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case "filled": return <TrendingUp className="w-3 h-3 text-profit" />;
      case "expired": return <Clock className="w-3 h-3 text-highlight" />;
      case "invalidated": return <AlertTriangle className="w-3 h-3 text-loss" />;
      case "reconciliation_required": return <AlertTriangle className="w-3 h-3 text-warn" />;
      case "broker_rejected": return <X className="w-3 h-3 text-loss" />;
      case "cancelled": return <X className="w-3 h-3 text-loss" />;
      default: return <Target className="w-3 h-3 text-info-c" />;
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case "filled": return "text-profit";
      case "expired": return "text-highlight";
      case "invalidated": return "text-loss";
      case "broker_rejected": return "text-loss";
      case "reconciliation_required": return "text-warn";
      case "cancelled": return "text-loss";
      default: return "text-info-c";
    }
  };

  // Separate orders into watching (pending) and hunting (awaiting_confirmation)
  const watchingOrders = orders.filter(o => o.status === "pending");
  const huntingOrders = orders.filter(o => o.status === "awaiting_confirmation");
  const reconciliationOrders = orders.filter(o => o.status === "reconciliation_required");

  const renderOrderCard = (order: PendingOrder, isHunting: boolean) => {
    const expiryPct = getExpiryPercent(order.placed_at, order.expires_at);
    const isExpiringSoon = expiryPct > 75;
    const signalReason = typeof order.signal_reason === "string"
      ? (() => {
        try {
          return JSON.parse(order.signal_reason);
        } catch {
          return {};
        }
      })()
      : (order.signal_reason || {});
    const decision = order.decision_context ||
      signalReason.decisionContext ||
      order.final_authorization?.decisionContext ||
      null;
    const confirmationMethod = order.confirmation_method ||
      signalReason.watchlistLifecycle?.confirmationMethod ||
      signalReason.confirmationMethod ||
      "choch";
    const confirmationLabel = confirmationMethod === "indicators"
      ? "indicator consensus"
      : confirmationMethod === "choch_and_indicators"
      ? "CHoCH + indicators"
      : "CHoCH/BOS";
    const retracementPlan = order.post_confirmation_entry;
    const waitingForRetracement =
      retracementPlan?.state === "awaiting_retracement";
    return (
      <div
        key={order.order_id}
        className={`border rounded-lg p-3 space-y-2 ${
          isHunting
            ? "border-amber-500/30 bg-badge-warn"
            : "border-blue-500/30 bg-badge-info"
        }`}
      >
        {/* Row 1: Symbol, Direction, Stage Badge, Cancel */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {order.direction === "long" ? (
              <TrendingUp className="w-3.5 h-3.5 text-profit" />
            ) : (
              <TrendingDown className="w-3.5 h-3.5 text-loss" />
            )}
            <span className="font-mono text-sm font-semibold text-foreground">
              {order.symbol}
            </span>
            <Badge
              variant="outline"
              className={`text-[11px] px-1.5 py-0 ${
                order.direction === "long"
                  ? "border-success/50 text-profit bg-badge-profit"
                  : "border-destructive/50 text-loss bg-badge-loss"
              }`}
            >
              {order.direction.toUpperCase()}
            </Badge>
            <Badge
              variant="outline"
              className="text-[11px] px-1.5 py-0 border-blue-500/50 text-info-c bg-badge-info"
            >
              {String(order.entry_zone_type || order.order_type).toLowerCase().includes("ob")
                ? "OB"
                : String(order.entry_zone_type || order.order_type).toLowerCase().includes("fvg")
                ? "FVG"
                : "ZONE"}
            </Badge>
            {isHunting && (
              <Badge
                variant="outline"
                className="text-[11px] px-1.5 py-0 border-amber-500/50 text-warn bg-badge-warn animate-pulse"
              >
                <Crosshair className="w-2.5 h-2.5 mr-0.5" />
                {waitingForRetracement ? "RETRACEMENT" : "HUNTING"}
              </Badge>
            )}
            {!isHunting && order.from_watchlist && (
              <Badge
                variant="outline"
                className="text-[11px] px-1.5 py-0 border-cyan-500/50 text-cyan-300 bg-cyan-500/10"
              >
                WL
              </Badge>
            )}
            {order.candidate_id && (
              <span className="text-[9px] font-mono text-foreground/45">
                #{order.candidate_id.slice(0, 8)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleCancel(order.order_id)}
              disabled={cancelling === order.order_id}
              className="h-5 w-5 p-0 text-muted-foreground hover:text-loss"
            >
              <X className="w-3 h-3" />
            </Button>
          </div>
        </div>

        {/* Row 2: Status-specific info */}
        {isHunting ? (
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-warn font-medium">
              <Crosshair className="w-3 h-3 inline mr-1" />
              {waitingForRetracement
                ? `CHoCH confirmed — waiting for ${retracementPlan.zone.type.replace(/_/g, " ")} [${Number(retracementPlan.zone.low).toFixed(5)} – ${Number(retracementPlan.zone.high).toFixed(5)}]`
                : `Price in zone — awaiting ${order.direction === "short" ? "bearish" : "bullish"} ${confirmationLabel}`}
            </span>
            <span className="text-foreground/60">
              SL: <span className="text-loss font-mono">{Number(order.stop_loss).toFixed(5)}</span>
              {" · "}
              TP: <span className="text-profit font-mono">{Number(order.take_profit).toFixed(5)}</span>
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-between text-[12px] text-foreground/70">
            <span>
              Current: <span className="text-foreground font-mono">{order.current_price ? Number(order.current_price).toFixed(5) : "—"}</span>
              {" · "}
              <span className="text-info-c">{getDistanceDisplay(order)} away</span>
            </span>
            <span>
              SL: <span className="text-loss font-mono">{Number(order.stop_loss).toFixed(5)}</span>
              {" · "}
              TP: <span className="text-profit font-mono">{Number(order.take_profit).toFixed(5)}</span>
            </span>
          </div>
        )}

        {/* Row 3: Zone info */}
        <div className="text-[12px] text-foreground/70">
          Zone: <span className={isHunting ? "text-warn" : "text-info-c"}>{order.entry_zone_type}</span>
          {" "}[{Number(order.entry_zone_low).toFixed(5)} – {Number(order.entry_zone_high).toFixed(5)}]
          {" · "}
          Size: <span className="text-foreground">
            {order.size == null ? "Calculated at final authorization" : `${order.size} lots`}
          </span>
          {" · "}
          Score: <span className="text-foreground">{Number(order.signal_score).toFixed(1)}%</span>
        </div>

        {/* Narrative sentence */}
        <p className="text-[11px] text-foreground/50 italic leading-tight">
          {isHunting
            ? `Price has entered the ${order.entry_zone_type} zone. The saved ${confirmationLabel} rule must pass before entry.`
            : generatePendingOrderNarrative(order)
          }
        </p>

        {order.liquidity_confirmation_observation && (
          <details className="border-t border-border/40 pt-2 text-[11px]">
            <summary className="cursor-pointer text-foreground/70 font-medium">
              Liquidity → structure observation · {order.liquidity_confirmation_observation.ready ? "SEQUENCE SEEN" : "WAITING"}
              <span className="ml-2 text-[9px] text-highlight">OBSERVE ONLY</span>
            </summary>
            <div className="mt-1.5 space-y-1 text-foreground/60">
              <p>{liquidityReason(order.liquidity_confirmation_observation.reasonCode)}</p>
              <p className="text-[10px] text-muted-foreground">
                This v2 observation records evidence only. It does not authorize or block this order.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-3 gap-y-1 font-mono text-[9px]">
                <span>Touch: {order.liquidity_confirmation_observation.zoneTouchTime ? new Date(order.liquidity_confirmation_observation.zoneTouchTime).toLocaleString() : "pending"}</span>
                <span>Sweep: {order.liquidity_confirmation_observation.sweepTime ? new Date(order.liquidity_confirmation_observation.sweepTime).toLocaleString() : "pending"}</span>
                <span>Confirmation: {order.liquidity_confirmation_observation.confirmationTime ? new Date(order.liquidity_confirmation_observation.confirmationTime).toLocaleString() : "pending"}</span>
              </div>
            </div>
          </details>
        )}

        {order.impulse_entry_lifecycle?.confirmation && (
          <details className="border-t border-border/40 pt-2 text-[11px]">
            <summary className="cursor-pointer text-foreground/70 font-medium">
              Structure confirmation plan · {order.impulse_entry_lifecycle.confirmation.status.replace(/_/g, " ").toUpperCase()}
            </summary>
            <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 text-foreground/60">
              <span>
                Candidate: <strong className="font-mono text-foreground/80">
                  {order.impulse_entry_lifecycle.confirmation.candidateId.slice(0, 10)}
                </strong> · generation {order.impulse_entry_lifecycle.confirmation.generation}
              </span>
              <span>
                Protected pivot: <strong className="font-mono text-foreground/80">
                  {order.impulse_entry_lifecycle.confirmation.protectedLevel == null
                    ? "Building"
                    : Number(order.impulse_entry_lifecycle.confirmation.protectedLevel).toFixed(5)}
                </strong>
              </span>
              <span>
                CHoCH/MSS break: <strong className="font-mono text-foreground/80">
                  {order.impulse_entry_lifecycle.confirmation.breakLevel == null
                    ? "Building"
                    : Number(order.impulse_entry_lifecycle.confirmation.breakLevel).toFixed(5)}
                </strong>
              </span>
              <span>
                Revisions: <strong className="font-mono text-foreground/80">
                  {order.impulse_entry_lifecycle.confirmation.revisions?.length || 0}
                </strong>
              </span>
              <p className="sm:col-span-2 text-[10px] text-muted-foreground">
                {order.impulse_entry_lifecycle.lastTransitionReason}
              </p>
              {(order.impulse_entry_lifecycle.confirmation.revisions || []).slice(-3).reverse().map((revision) => (
                <p key={revision.revision} className="sm:col-span-2 text-[9px] font-mono text-muted-foreground">
                  r{revision.revision} · protected {Number(revision.protectedLevel).toFixed(5)} · break {Number(revision.breakLevel).toFixed(5)} · {revision.reason}
                </p>
              ))}
            </div>
          </details>
        )}

        {decision && (
          <div className="border border-border/50 bg-background/30 p-2 space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono">
              <span className="text-muted-foreground">
                GP v{decision.gamePlan?.version?.slice(0, 8) || "none"}
              </span>
              <span className={
                decision.directionVerdict?.shouldBlock
                  ? "text-loss"
                  : "text-foreground"
              }>
                DV {(decision.directionVerdict?.verdict || "missing").toUpperCase()}
                {Number.isFinite(Number(decision.directionVerdict?.confidence))
                  ? ` ${Math.round(Number(decision.directionVerdict.confidence))}%`
                  : ""}
              </span>
              <span className={
                decision.thesisValidity?.valid === false
                  ? "text-loss"
                  : decision.thesisValidity?.valid === true
                  ? "text-profit"
                  : "text-highlight"
              }>
                Thesis {decision.thesisValidity?.valid === true
                  ? "VALID"
                  : decision.thesisValidity?.valid === false
                  ? "INVALID"
                  : "PENDING"}
              </span>
              <span className={
                decision.entryConfirmation?.passed
                  ? "text-profit"
                  : "text-highlight"
              }>
                Confirmation {decision.entryConfirmation?.passed
                  ? "PASSED"
                  : `WAITING (${confirmationLabel})`}
              </span>
            </div>
            <p className="text-[9px] text-muted-foreground">
              {decision.hierarchy?.reason ||
                "Decision evidence will be refreshed before any fill."}
            </p>
          </div>
        )}

        {/* Row 4: Expiry bar (only for watching stage) */}
        {!isHunting && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-1">
                <Clock className="w-3 h-3 text-foreground/50" />
                <span className={isExpiringSoon ? "text-warn" : "text-foreground/60"}>
                  {getTimeRemaining(order.expires_at)}
                </span>
              </div>
              <span className="text-foreground/40">
                {new Date(order.placed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            {order.from_watchlist && (
              <p className="text-[10px] text-foreground/45">
                Expiry is inherited from the original Watchlist setup and does not restart when this zone is pre-armed.
              </p>
            )}
            <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  isExpiringSoon ? "bg-amber-500" : "bg-blue-500"
                }`}
                style={{ width: `${100 - expiryPct}%` }}
              />
            </div>
          </div>
        )}

        {/* Hunting stage: show confirmation info instead of expiry */}
        {isHunting && (
          <div className="flex items-center justify-between text-[11px]">
            <div className="flex items-center gap-1">
              <Crosshair className="w-3 h-3 text-warn animate-pulse" />
              <span className="text-warn">
                Confirmation active · {getTimeRemaining(order.expires_at)}
              </span>
            </div>
            <span className="text-foreground/40">
              Zone touched: {(order as any).zone_touch_time
                ? new Date((order as any).zone_touch_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                : "just now"
              }
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Crosshair className="w-4 h-4 text-info-c" />
          <span className="text-sm font-semibold text-info-c uppercase tracking-wider">
            Zone Setups
          </span>
          {orders.length > 0 && (
            <Badge variant="outline" className="text-xs border-blue-500/50 text-info-c bg-badge-info">
              {orders.length}
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={fetchOrders}
          disabled={loading}
          className="text-xs text-muted-foreground hover:text-foreground h-6 px-2"
        >
          {loading ? "..." : "↻"}
        </Button>
      </div>

      {/* Active Zone Setups */}
      {orders.length === 0 ? (
        <div className="text-xs text-foreground/50 py-2 text-center">
          No active zone setups. When the bot identifies an impulse zone entry, it will appear here.
        </div>
      ) : (
        <div className="space-y-3">
          {reconciliationOrders.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] text-warn uppercase tracking-wider font-semibold">
                <AlertTriangle className="w-3 h-3" />
                Broker Reconciliation ({reconciliationOrders.length})
              </div>
              {reconciliationOrders.map((order) => renderOrderCard(order, true))}
            </div>
          )}

          {/* Hunting section (higher priority) */}
          {huntingOrders.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] text-warn uppercase tracking-wider font-semibold">
                <Crosshair className="w-3 h-3" />
                Hunting Confirmation ({huntingOrders.length})
              </div>
              {huntingOrders.map((order) => renderOrderCard(order, true))}
            </div>
          )}

          {/* Watching section */}
          {watchingOrders.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] text-info-c uppercase tracking-wider font-semibold">
                <Eye className="w-3 h-3" />
                Watching — Waiting for Zone ({watchingOrders.length})
              </div>
              {watchingOrders.map((order) => renderOrderCard(order, false))}
            </div>
          )}
        </div>
      )}

      {/* History Toggle */}
      {history.length > 0 && (
        <div className="pt-1">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center gap-1 text-[11px] text-foreground/50 hover:text-foreground/70 transition-colors"
          >
            {showHistory ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showHistory ? "Hide" : "Show"} setup history ({history.length})
          </button>

          {showHistory && (
            <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
              {history.slice(0, 20).map((order) => (
                <div
                  key={order.order_id}
                  className="flex items-center justify-between text-[12px] px-2 py-1.5 rounded bg-muted/10 border border-muted/20"
                >
                  <div className="flex items-center gap-2">
                    {statusIcon(order.status)}
                    <span className="font-mono text-foreground">{order.symbol}</span>
                    <Badge
                      variant="outline"
                      className={`text-[10px] px-1 py-0 ${
                        order.direction === "long"
                          ? "border-success/30 text-profit"
                          : "border-destructive/30 text-loss"
                      }`}
                    >
                      {order.direction.toUpperCase()}
                    </Badge>
                    <span className="text-foreground/60">@ {Number(order.entry_price).toFixed(5)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`capitalize ${statusColor(order.status)}`}>
                      {order.status === "filled" ? "confirmed" : order.status}
                    </span>
                    <span className="text-foreground/40">
                      {order.resolved_at
                        ? new Date(order.resolved_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                        : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
