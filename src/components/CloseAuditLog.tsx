import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatMoney } from "@/lib/marketData";
import { formatBrokerTime } from "@/lib/formatTime";

type CloseRow = {
  id: string;
  created_at: string;
  position_id: string;
  symbol: string;
  broker_connection_id: string | null;
  close_reason: string;
  close_source: string;
  pnl: string | null;
  exit_price: string | null;
};

type BrokerConn = { id: string; display_name: string };

const REASON_COLORS: Record<string, string> = {
  sl_hit: "text-destructive bg-destructive/10 border-destructive/30",
  tp_hit: "text-success bg-success/10 border-success/30",
  reverse_signal: "text-warning bg-warning/10 border-warning/30",
  manual: "text-muted-foreground bg-muted/30 border-border",
  kill_switch: "text-destructive bg-destructive/20 border-destructive/40",
  drawdown_stop_out: "text-destructive bg-destructive/10 border-destructive/30",
  sync_orphan: "text-muted-foreground bg-muted/30 border-border",
  max_concurrent: "text-warning bg-warning/10 border-warning/30",
};

export function CloseAuditLog({ brokerConns }: { brokerConns: BrokerConn[] }) {
  const [reasonFilter, setReasonFilter] = useState<string>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["close-audit-log"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("close_audit_log")
        .select("id, created_at, position_id, symbol, broker_connection_id, close_reason, close_source, pnl, exit_price")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data || []) as CloseRow[];
    },
    refetchInterval: 15000,
  });

  const rows = data || [];

  const reasons = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => set.add(r.close_reason));
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    if (reasonFilter === "all") return rows;
    return rows.filter((r) => r.close_reason === reasonFilter);
  }, [rows, reasonFilter]);

  const brokerName = (id: string | null) => {
    if (!id) return "—";
    const c = brokerConns.find((b) => b.id === id);
    return c?.display_name || id.slice(0, 6);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="flex items-center gap-2 pb-1.5 border-b border-border/50">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Filter</span>
        <button
          onClick={() => setReasonFilter("all")}
          className={`text-[10px] px-1.5 py-0.5 border ${
            reasonFilter === "all"
              ? "bg-primary/20 text-primary border-primary/40"
              : "bg-card text-muted-foreground border-border hover:text-foreground"
          }`}
        >
          All ({rows.length})
        </button>
        {reasons.map((r) => (
          <button
            key={r}
            onClick={() => setReasonFilter(r)}
            className={`text-[10px] px-1.5 py-0.5 border ${
              reasonFilter === r
                ? "bg-primary/20 text-primary border-primary/40"
                : "bg-card text-muted-foreground border-border hover:text-foreground"
            }`}
          >
            {r} ({rows.filter((x) => x.close_reason === r).length})
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto mt-1">
        {isLoading ? (
          <p className="text-[10px] text-muted-foreground text-center py-8">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="text-[10px] text-muted-foreground text-center py-8">No close events recorded</p>
        ) : (
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="border-b border-border text-muted-foreground text-[10px]">
                <th className="text-left py-1 px-1">Time</th>
                <th className="text-left py-1 px-1">Symbol</th>
                <th className="text-left py-1 px-1">Broker</th>
                <th className="text-left py-1 px-1">Reason</th>
                <th className="text-left py-1 px-1">Source</th>
                <th className="text-right py-1 px-1">Exit</th>
                <th className="text-right py-1 px-1">P&L</th>
                <th className="text-left py-1 px-1">Position</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, idx) => {
                const pnl = r.pnl != null ? parseFloat(r.pnl) : null;
                const time = formatBrokerTime(r.created_at);
                const reasonClass = REASON_COLORS[r.close_reason] || "text-muted-foreground bg-muted/20 border-border";
                return (
                  <tr
                    key={r.id}
                    className={`border-b border-border/30 hover:bg-secondary/30 ${idx % 2 === 1 ? "bg-secondary/10" : ""}`}
                  >
                    <td className="py-1 px-1 text-muted-foreground">{time}</td>
                    <td className="py-1 px-1 font-medium">{r.symbol}</td>
                    <td className="py-1 px-1 text-[10px]">{brokerName(r.broker_connection_id)}</td>
                    <td className="py-1 px-1">
                      <span className={`text-[9px] font-bold uppercase px-1 py-0.5 border ${reasonClass}`}>
                        {r.close_reason}
                      </span>
                    </td>
                    <td className="py-1 px-1 text-[10px] text-muted-foreground">{r.close_source}</td>
                    <td className="py-1 px-1 text-right">{r.exit_price ? parseFloat(r.exit_price).toFixed(5) : "—"}</td>
                    <td
                      className={`py-1 px-1 text-right font-medium ${
                        pnl == null ? "text-muted-foreground" : pnl >= 0 ? "text-success" : "text-destructive"
                      }`}
                    >
                      {pnl == null ? "—" : formatMoney(pnl, true)}
                    </td>
                    <td className="py-1 px-1 text-[9px] text-muted-foreground truncate max-w-[120px]" title={r.position_id}>
                      {r.position_id}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
