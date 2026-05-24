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
      setHistory((allRes || []).filter((o: PendingOrder) => o.status !== "pending" && o.status !== "awaiting_confirmation"));
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
      case "cancelled": return <X className="w-3 h-3 text-loss" />;
      default: return <Target className="w-3 h-3 text-info-c" />;
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case "filled": return "text-profit";
      case "expired": return "text-highlight";
      case "cancelled": return "text-loss";
      default: return "text-info-c";
    }
  };

  // Separate orders into watching (pending) and hunting (awaiting_confirmation)
  const watchingOrders = orders.filter(o => o.status === "pending");
  const huntingOrders = orders.filter(o => o.status === "awaiting_confirmation");

  const renderOrderCard = (order: PendingOrder, isHunting: boolean) => {
    const expiryPct = getExpiryPercent(order.placed_at, order.expires_at);
    const isExpiringSoon = expiryPct > 75;
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
              className={`text-[10px] px-1.5 py-0 ${
                order.direction === "long"
                  ? "border-green-500/50 text-profit bg-badge-profit"
                  : "border-red-500/50 text-loss bg-badge-loss"
              }`}
            >
              {order.direction.toUpperCase()}
            </Badge>
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 border-blue-500/50 text-info-c bg-badge-info"
            >
              {order.order_type === "limit_ob" ? "OB" : "FVG"}
            </Badge>
            {isHunting && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 border-amber-500/50 text-warn bg-badge-warn animate-pulse"
              >
                <Crosshair className="w-2.5 h-2.5 mr-0.5" />
                HUNTING
              </Badge>
            )}
            {!isHunting && order.from_watchlist && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 border-cyan-500/50 text-cyan-300 bg-cyan-500/10"
              >
                WL
              </Badge>
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
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-warn font-medium">
              <Crosshair className="w-3 h-3 inline mr-1" />
              Price in zone — waiting for {order.direction === "short" ? "bearish" : "bullish"} CHoCH on 5m
            </span>
            <span className="text-muted-foreground">
              SL: <span className="text-loss font-mono">{Number(order.stop_loss).toFixed(5)}</span>
              {" · "}
              TP: <span className="text-profit font-mono">{Number(order.take_profit).toFixed(5)}</span>
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
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
        <div className="text-[11px] text-muted-foreground">
          Zone: <span className={isHunting ? "text-warn" : "text-info-c"}>{order.entry_zone_type}</span>
          {" "}[{Number(order.entry_zone_low).toFixed(5)} – {Number(order.entry_zone_high).toFixed(5)}]
          {" · "}
          Size: <span className="text-foreground">{order.size} lots</span>
          {" · "}
          Score: <span className="text-foreground">{Number(order.signal_score).toFixed(1)}%</span>
        </div>

        {/* Narrative sentence */}
        <p className="text-[9px] text-muted-foreground/80 italic leading-tight">
          {isHunting
            ? `Price has entered the ${order.entry_zone_type} zone. Watching 5m candles for ${order.direction === "short" ? "bearish" : "bullish"} CHoCH confirmation before entry.`
            : generatePendingOrderNarrative(order)
          }
        </p>

        {/* Row 4: Expiry bar (only for watching stage) */}
        {!isHunting && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px]">
              <div className="flex items-center gap-1">
                <Clock className="w-3 h-3 text-muted-foreground" />
                <span className={isExpiringSoon ? "text-warn" : "text-muted-foreground"}>
                  {getTimeRemaining(order.expires_at)}
                </span>
              </div>
              <span className="text-muted-foreground/60">
                {new Date(order.placed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <div className="h-1 bg-muted/30 rounded-full overflow-hidden">
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
          <div className="flex items-center justify-between text-[10px]">
            <div className="flex items-center gap-1">
              <Crosshair className="w-3 h-3 text-warn animate-pulse" />
              <span className="text-warn">
                Confirmation active — no time limit
              </span>
            </div>
            <span className="text-muted-foreground/60">
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
        <div className="text-xs text-muted-foreground/60 py-2 text-center">
          No active zone setups. When the bot identifies an impulse zone entry, it will appear here.
        </div>
      ) : (
        <div className="space-y-3">
          {/* Hunting section (higher priority) */}
          {huntingOrders.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] text-warn uppercase tracking-wider font-semibold">
                <Crosshair className="w-3 h-3" />
                Hunting Confirmation ({huntingOrders.length})
              </div>
              {huntingOrders.map((order) => renderOrderCard(order, true))}
            </div>
          )}

          {/* Watching section */}
          {watchingOrders.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] text-info-c uppercase tracking-wider font-semibold">
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
            className="flex items-center gap-1 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
          >
            {showHistory ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showHistory ? "Hide" : "Show"} setup history ({history.length})
          </button>

          {showHistory && (
            <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
              {history.slice(0, 20).map((order) => (
                <div
                  key={order.order_id}
                  className="flex items-center justify-between text-[11px] px-2 py-1.5 rounded bg-muted/10 border border-muted/20"
                >
                  <div className="flex items-center gap-2">
                    {statusIcon(order.status)}
                    <span className="font-mono text-foreground">{order.symbol}</span>
                    <Badge
                      variant="outline"
                      className={`text-[9px] px-1 py-0 ${
                        order.direction === "long"
                          ? "border-green-500/30 text-profit"
                          : "border-red-500/30 text-loss"
                      }`}
                    >
                      {order.direction.toUpperCase()}
                    </Badge>
                    <span className="text-muted-foreground">@ {Number(order.entry_price).toFixed(5)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`capitalize ${statusColor(order.status)}`}>
                      {order.status === "filled" ? "confirmed" : order.status}
                    </span>
                    <span className="text-muted-foreground/50">
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
