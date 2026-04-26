import { useMemo } from "react";
import { cn } from "@/lib/utils";

export interface TradeItem {
  position_id: string;
  symbol: string;
  direction: "BUY" | "SELL";
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  current_sl?: number;
  status: "open" | "closed" | "staged";
  opened_at: string;
  closed_at?: string;
  exit_price?: number;
  pnl_pips?: number;
  signal_reason?: any;
  scan_detail?: any;
}

interface Props {
  trades: TradeItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const fx = (n: number | undefined, d = 1) =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "—";

const fmtDate = (iso: string) => {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      ", " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return "—"; }
};

export function TradeReplaySidebar({ trades, selectedId, onSelect }: Props) {
  const { open, closed, staged } = useMemo(() => {
    const open: TradeItem[] = [];
    const closed: TradeItem[] = [];
    const staged: TradeItem[] = [];
    for (const t of trades) {
      if (t.status === "open") open.push(t);
      else if (t.status === "staged") staged.push(t);
      else closed.push(t);
    }
    // Sort closed by date descending
    closed.sort((a, b) => new Date(b.closed_at || b.opened_at).getTime() - new Date(a.closed_at || a.opened_at).getTime());
    return { open, closed, staged };
  }, [trades]);

  const renderCard = (t: TradeItem) => {
    const isActive = selectedId === t.position_id;
    const isPositive = (t.pnl_pips ?? 0) >= 0;
    return (
      <button
        key={t.position_id}
        onClick={() => onSelect(t.position_id)}
        className={cn(
          "w-full text-left rounded-lg border p-2.5 mb-1.5 transition-all",
          isActive
            ? "border-cyan-500/60 bg-cyan-500/10"
            : "border-border/50 bg-card hover:border-border hover:bg-accent/30"
        )}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono text-[13px] font-semibold text-foreground">
            {t.symbol}
          </span>
          <span
            className={cn(
              "text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wide",
              t.status === "staged"
                ? "text-amber-400 bg-amber-400/15"
                : t.direction === "BUY"
                ? "text-green-400 bg-green-400/15"
                : "text-red-400 bg-red-400/15"
            )}
          >
            {t.status === "staged" ? "WATCH" : t.direction}
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{fmtDate(t.opened_at)}</span>
          {t.status !== "staged" && t.pnl_pips !== undefined && (
            <span
              className={cn(
                "font-mono font-semibold",
                isPositive ? "text-green-400" : "text-red-400"
              )}
            >
              {isPositive ? "+" : ""}{fx(t.pnl_pips)} pips
            </span>
          )}
          {t.status === "staged" && (
            <span className="text-amber-400 font-medium">
              {t.signal_reason?.score ? `${t.signal_reason.score}%` : "—"}
            </span>
          )}
        </div>
      </button>
    );
  };

  const SectionTitle = ({ children }: { children: React.ReactNode }) => (
    <div className="text-[10px] font-semibold uppercase tracking-[1.5px] text-muted-foreground px-2 pt-3 pb-1.5">
      {children}
    </div>
  );

  return (
    <div className="w-[260px] shrink-0 border-r border-border bg-card/50 overflow-y-auto">
      <div className="p-2">
        {open.length > 0 && (
          <>
            <SectionTitle>Open Positions</SectionTitle>
            {open.map(renderCard)}
          </>
        )}
        {closed.length > 0 && (
          <>
            <SectionTitle>Closed Trades</SectionTitle>
            {closed.map(renderCard)}
          </>
        )}
        {staged.length > 0 && (
          <>
            <SectionTitle>Staged (Watching)</SectionTitle>
            {staged.map(renderCard)}
          </>
        )}
        {trades.length === 0 && (
          <div className="text-center text-muted-foreground text-sm py-12">
            No trades yet
          </div>
        )}
      </div>
    </div>
  );
}
