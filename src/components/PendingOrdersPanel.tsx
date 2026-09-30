import { useState, useEffect, useCallback, type ReactNode } from "react";
import { scannerApi, PendingOrder } from "@/lib/api";
import { generatePendingOrderNarrative } from "@/lib/narrative";
import { getPipSize, formatPipDisplay } from "@/lib/pipDisplay";
import {
  readConfirmation, entryDifference, cohortLabel, lifecycleShort, outcomeLabel,
  tierLabel, typeLabel, huntingCaption, HUNT_TIERS_TEXT,
} from "@/lib/route2Display";
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
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
                  ? "border-success/50 text-profit bg-badge-profit"
                  : "border-destructive/50 text-loss bg-badge-loss"
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
            <CohortChip value={order.would_have_been_route1} />
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
          <div className="text-[11px] space-y-0.5">
            <div className="flex items-center justify-between">
              {/* Three tiers, not "CHoCH": a Tier 3 reversal fills with no
                  CHoCH at all, which the old caption made invisible. */}
              <span className="text-warn font-medium">
                <Crosshair className="w-3 h-3 inline mr-1" />
                {huntingCaption(order.direction, huntTimeframe(order))}:
              </span>
              <span className="text-muted-foreground">
                SL: <span className="text-loss font-mono">{Number(order.stop_loss).toFixed(5)}</span>
                {" · "}
                TP: <span className="text-profit font-mono">{Number(order.take_profit).toFixed(5)}</span>
              </span>
            </div>
            <div className="text-[10px] text-warn/80 font-mono pl-4">{HUNT_TIERS_TEXT}</div>
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
            ? `Price has entered the ${order.entry_zone_type} zone. Watching ${huntTimeframe(order)} candles for a ${order.direction === "short" ? "bearish" : "bullish"} confirmation (${HUNT_TIERS_TEXT}) before entry.`
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
          <div className="space-y-0.5 text-[10px]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <Crosshair className="w-3 h-3 text-warn animate-pulse" />
                {/* Was "no time limit" — wrong: the order still expires on
                    its fixed TTL while hunting. */}
                <span className="text-warn">Confirmation active · {getTimeRemaining(order.expires_at)}</span>
              </div>
              <span className="text-muted-foreground/60">
                Zone touched: {order.zone_touch_time ? fmtTime(order.zone_touch_time) : "—"}
              </span>
            </div>
            <HuntFacts order={order} />
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
            <div className="mt-2 space-y-1.5 max-h-96 overflow-y-auto">
              {history.slice(0, 20).map((order) => (
                <HistoryRow
                  key={order.order_id}
                  order={order}
                  open={expanded.has(order.order_id)}
                  onToggle={() => toggleExpanded(order.order_id)}
                  icon={statusIcon(order.status)}
                  color={statusColor(order.status)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

const fmtTime = (iso: string | null | undefined, seconds = false): string =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) }) : "—";

const px = (v: unknown): string | null => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n.toFixed(5);
};

/**
 * Confirmation timeframe for an ACTIVE hunt. The pending row records it only
 * at fill, so a live hunt uses the style's confirmation TF — 5m for the
 * scalper style (supabase/functions/_shared/styleTimeframes.ts), which is
 * what the hunt is actually checking.
 */
function huntTimeframe(order: PendingOrder): string {
  return order.confirmation_timeframe || "5m";
}

/** A labelled value, or nothing at all. Never renders a placeholder as data. */
function Fact({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground font-mono text-right">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-0.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70 font-semibold">{title}</div>
      {children}
    </section>
  );
}

function CohortChip({ value }: { value: boolean | null | undefined }) {
  const label = cohortLabel(value);
  if (!label) return null;
  return (
    <Badge
      variant="outline"
      title="Research cohort only — does not affect execution"
      className={`text-[9px] px-1 py-0 ${value ? "border-muted/40 text-muted-foreground" : "border-emerald-500/40 text-emerald-300"}`}
    >
      {value ? "EX-R1" : "PRIMARY"}
    </Badge>
  );
}

/** Live hunt state, only the fields that exist. */
function HuntFacts({ order }: { order: PendingOrder }) {
  const facts: string[] = [];
  if (order.confirmation_arm_count != null) facts.push(`Arms ${order.confirmation_arm_count}`);
  if (order.confirmation_checks_count != null) facts.push(`Checks ${order.confirmation_checks_count}`);
  if (order.confirmation_min_observation_until) facts.push(`Protected until ${fmtTime(order.confirmation_min_observation_until)}`);
  if (order.pending_distance_atr != null) facts.push(`${Number(order.pending_distance_atr).toFixed(2)} ATR`);
  const lc = lifecycleShort(order.strategy_version);
  if (lc) facts.push(`Lifecycle ${lc}`);
  if (facts.length === 0) return null;
  return <div data-testid="hunt-facts" className="text-muted-foreground/70 font-mono pl-4">{facts.join(" · ")}</div>;
}

function HistoryRow({ order, open, onToggle, icon, color }: {
  order: PendingOrder; open: boolean; onToggle: () => void;
  icon: ReactNode; color: string;
}) {
  const conf = readConfirmation(order);
  const outcome = outcomeLabel(order);
  const filled = order.status === "filled";
  const shownPrice = filled && order.fill_price != null ? order.fill_price : order.entry_price;
  const tier = conf ? tierLabel(conf.tier) : null;

  return (
    <div className="rounded bg-muted/10 border border-muted/20 text-[11px]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-2 py-1.5 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <span className="font-mono text-foreground">{order.symbol}</span>
          <Badge
            variant="outline"
            className={`text-[9px] px-1 py-0 ${
              order.direction === "long" ? "border-success/30 text-profit" : "border-destructive/30 text-loss"
            }`}
          >
            {order.direction.toUpperCase()}
          </Badge>
          <span className={`font-semibold ${color}`}>{outcome.primary}</span>
          {filled && tier && (
            <Badge variant="outline" className="text-[9px] px-1 py-0 border-emerald-500/40 text-emerald-300 uppercase">
              {tier}
            </Badge>
          )}
          {!filled && outcome.detail && (
            <span className="text-muted-foreground/70 truncate">{outcome.detail.toLowerCase()}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-muted-foreground font-mono">
            {filled ? "Entry" : "@"} {px(shownPrice) ?? "—"}
          </span>
          <span className="text-muted-foreground/50">{fmtTime(order.resolved_at)}</span>
          {open ? <ChevronUp className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
        </div>
      </button>

      {open && (
        <div data-testid="history-detail" className="px-2 pb-2 pt-1 space-y-2 border-t border-muted/20">
          {filled ? <FilledDetail order={order} conf={conf} /> : <UnfilledDetail order={order} />}
          <LifecycleDetail order={order} />
        </div>
      )}
    </div>
  );
}

function FilledDetail({ order, conf }: { order: PendingOrder; conf: ReturnType<typeof readConfirmation> }) {
  const diff = entryDifference(order);
  return (
    <>
      <Section title="Confirmation">
        {conf ? (
          <>
            <Fact label="Tier" value={conf.tier != null ? `T${conf.tier}` : null} />
            <Fact label="Type" value={typeLabel(conf.type)} />
            <Fact label="TF" value={conf.timeframe} />
            <Fact label="Confirmation price" value={px(conf.price)} />
            <Fact label="Displacement" value={conf.displacement != null ? `${(conf.displacement * 100).toFixed(0)}%` : null} />
            <Fact label="Close based" value={conf.closeBased == null ? null : conf.closeBased ? "Yes" : "No"} />
            <Fact label="Significance" value={conf.significance} />
            <Fact label="Signals" value={conf.supportingSignals.length ? conf.supportingSignals.join(", ") : null} />
          </>
        ) : (
          <div className="text-muted-foreground/60 italic">Not recorded for this order.</div>
        )}
        <Fact label="Zone touched" value={order.zone_touch_time ? fmtTime(order.zone_touch_time, true) : null} />
        <Fact label="Filled" value={fmtTime(order.fill_timestamp ?? order.filled_at, true)} />
      </Section>
      <Section title="Execution">
        <Fact label="Pending entry" value={px(order.entry_price)} />
        <Fact label="Actual fill" value={px(order.fill_price)} />
        <Fact
          label="Entry difference"
          value={diff ? `${diff.display} (${diff.favourable ? "favourable" : "adverse"})` : null}
        />
        <Fact label="SL" value={px(order.stop_loss)} />
        <Fact label="TP" value={px(order.take_profit)} />
        <Fact label="Size" value={order.size != null ? `${order.size} lots` : null} />
      </Section>
    </>
  );
}

function UnfilledDetail({ order }: { order: PendingOrder }) {
  return (
    <Section title="Outcome">
      <Fact label="Terminal reason" value={order.terminal_reason} />
      <Fact label="Reset reason" value={order.reset_reason} />
      <Fact label="Structural invalidation" value={order.structural_invalidation} />
      <Fact label="Hard invalidation" value={order.hard_invalidation == null ? null : order.hard_invalidation ? "Yes" : "No"} />
      <Fact label="Last touch" value={order.zone_touch_time ? fmtTime(order.zone_touch_time, true) : null} />
      {/* Free text, shown as written — never mapped into a guessed category. */}
      <Fact label="Note" value={order.cancel_reason} />
    </Section>
  );
}

function LifecycleDetail({ order }: { order: PendingOrder }) {
  const lc = lifecycleShort(order.strategy_version);
  return (
    <Section title="Lifecycle">
      <Fact label="Route" value="Route 2 Pending" />
      <Fact label="Lifecycle" value={lc} />
      <Fact label="Strategy version" value={order.strategy_version} />
      <Fact label="Cohort" value={cohortLabel(order.would_have_been_route1)} />
      <Fact label="Distance" value={order.pending_distance_atr != null ? `${Number(order.pending_distance_atr).toFixed(2)} ATR` : null} />
      <Fact label="Placed" value={fmtTime(order.placed_at, true)} />
      <Fact label="Expires" value={fmtTime(order.expires_at, true)} />
      <Fact label="Confirmation arms" value={order.confirmation_arm_count} />
      <Fact label="Confirmation checks" value={order.confirmation_checks_count} />
    </Section>
  );
}
