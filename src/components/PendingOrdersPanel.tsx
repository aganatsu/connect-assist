import { useState, useEffect, useCallback } from "react";
import { scannerApi, PendingOrder } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Clock, X, TrendingUp, TrendingDown, Target, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
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
      setHistory((allRes || []).filter((o: PendingOrder) => o.status !== "pending"));
    } catch (err) {
      console.error("Failed to fetch pending orders:", err);
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
      toast({ title: "Order cancelled", description: "Pending order has been cancelled." });
      fetchOrders();
    } catch (err) {
      toast({ title: "Error", description: "Failed to cancel order.", variant: "destructive" });
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

  const getDistancePips = (order: PendingOrder): string => {
    if (!order.current_price) return "—";
    const specs: Record<string, number> = {
      "EUR/USD": 0.0001, "GBP/USD": 0.0001, "AUD/USD": 0.0001, "NZD/USD": 0.0001,
      "USD/CAD": 0.0001, "USD/CHF": 0.0001, "EUR/GBP": 0.0001, "EUR/JPY": 0.01,
      "GBP/JPY": 0.01, "USD/JPY": 0.01, "AUD/JPY": 0.01, "NZD/JPY": 0.01,
      "CHF/JPY": 0.01, "CAD/JPY": 0.01, "GBP/CAD": 0.0001, "EUR/AUD": 0.0001,
      "EUR/CAD": 0.0001, "EUR/NZD": 0.0001, "GBP/AUD": 0.0001, "GBP/NZD": 0.0001,
      "AUD/CAD": 0.0001, "AUD/NZD": 0.0001, "NZD/CAD": 0.0001, "XAU/USD": 0.01,
    };
    const pipSize = specs[order.symbol] || 0.0001;
    const dist = Math.abs(Number(order.current_price) - Number(order.entry_price)) / pipSize;
    return dist.toFixed(1);
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case "filled": return <TrendingUp className="w-3 h-3 text-green-400" />;
      case "expired": return <Clock className="w-3 h-3 text-yellow-400" />;
      case "cancelled": return <X className="w-3 h-3 text-red-400" />;
      default: return <Target className="w-3 h-3 text-blue-400" />;
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case "filled": return "text-green-400";
      case "expired": return "text-yellow-400";
      case "cancelled": return "text-red-400";
      default: return "text-blue-400";
    }
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-semibold text-blue-300 uppercase tracking-wider">
            Pending Orders
          </span>
          {orders.length > 0 && (
            <Badge variant="outline" className="text-xs border-blue-500/50 text-blue-300 bg-blue-500/10">
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

      {/* Active Pending Orders */}
      {orders.length === 0 ? (
        <div className="text-xs text-muted-foreground/60 py-2 text-center">
          No active limit orders. When the bot places a limit order at an OB/FVG zone, it will appear here.
        </div>
      ) : (
        <div className="space-y-2">
          {orders.map((order) => {
            const expiryPct = getExpiryPercent(order.placed_at, order.expires_at);
            const isExpiringSoon = expiryPct > 75;
            return (
              <div
                key={order.order_id}
                className="border border-blue-500/30 bg-blue-500/5 rounded-lg p-3 space-y-2"
              >
                {/* Row 1: Symbol, Direction, Entry Price, Cancel */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {order.direction === "long" ? (
                      <TrendingUp className="w-3.5 h-3.5 text-green-400" />
                    ) : (
                      <TrendingDown className="w-3.5 h-3.5 text-red-400" />
                    )}
                    <span className="font-mono text-sm font-semibold text-foreground">
                      {order.symbol}
                    </span>
                    <Badge
                      variant="outline"
                      className={`text-[10px] px-1.5 py-0 ${
                        order.direction === "long"
                          ? "border-green-500/50 text-green-400 bg-green-500/10"
                          : "border-red-500/50 text-red-400 bg-red-500/10"
                      }`}
                    >
                      {order.direction.toUpperCase()}
                    </Badge>
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 border-blue-500/50 text-blue-300 bg-blue-500/10"
                    >
                      {order.order_type === "limit_ob" ? "OB" : "FVG"}
                    </Badge>
                    {order.from_watchlist && (
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1.5 py-0 border-cyan-500/50 text-cyan-300 bg-cyan-500/10"
                      >
                        📋 WL
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono font-bold text-blue-300">
                      @ {Number(order.entry_price).toFixed(5)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleCancel(order.order_id)}
                      disabled={cancelling === order.order_id}
                      className="h-5 w-5 p-0 text-muted-foreground hover:text-red-400"
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                </div>

                {/* Row 2: Current price, distance, SL/TP */}
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>
                    Current: <span className="text-foreground font-mono">{order.current_price ? Number(order.current_price).toFixed(5) : "—"}</span>
                    {" · "}
                    <span className="text-blue-300">{getDistancePips(order)} pips away</span>
                  </span>
                  <span>
                    SL: <span className="text-red-400 font-mono">{Number(order.stop_loss).toFixed(5)}</span>
                    {" · "}
                    TP: <span className="text-green-400 font-mono">{Number(order.take_profit).toFixed(5)}</span>
                  </span>
                </div>

                {/* Row 3: Zone info */}
                <div className="text-[11px] text-muted-foreground">
                  Zone: <span className="text-blue-300">{order.entry_zone_type}</span>
                  {" "}[{Number(order.entry_zone_low).toFixed(5)} – {Number(order.entry_zone_high).toFixed(5)}]
                  {" · "}
                  Size: <span className="text-foreground">{order.size} lots</span>
                  {" · "}
                  Score: <span className="text-foreground">{Number(order.signal_score).toFixed(1)}%</span>
                </div>

                {/* Row 4: Expiry bar */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[10px]">
                    <div className="flex items-center gap-1">
                      <Clock className="w-3 h-3 text-muted-foreground" />
                      <span className={isExpiringSoon ? "text-amber-400" : "text-muted-foreground"}>
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
              </div>
            );
          })}
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
            {showHistory ? "Hide" : "Show"} order history ({history.length})
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
                          ? "border-green-500/30 text-green-400"
                          : "border-red-500/30 text-red-400"
                      }`}
                    >
                      {order.direction.toUpperCase()}
                    </Badge>
                    <span className="text-muted-foreground">@ {Number(order.entry_price).toFixed(5)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`capitalize ${statusColor(order.status)}`}>
                      {order.status}
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
