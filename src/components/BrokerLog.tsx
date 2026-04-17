import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { CheckCircle2, SkipForward, XCircle, ArrowUpRight, ArrowDownRight } from "lucide-react";

type BrokerLogRow = {
  id: string;
  time: string;
  symbol: string;
  direction: string;
  positionId: string;
  size: number | null;
  entryPrice: number | null;
  mirrorResult: string;
  status: "success" | "skipped" | "failed" | "unknown";
};

function classifyResult(result: string): BrokerLogRow["status"] {
  const lower = result.toLowerCase();
  if (lower.includes("success")) return "success";
  if (lower.includes("skipped") || lower === "skipped_paper_mode" || lower === "skipped_no_connection") return "skipped";
  if (lower.includes("rejected") || lower.includes("failed") || lower.includes("error")) return "failed";
  return "unknown";
}

export function BrokerLog() {
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["broker-log"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("scan_logs")
        .select("id, created_at, details_json")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;

      const rows: BrokerLogRow[] = [];
      for (const log of data || []) {
        const details = Array.isArray(log.details_json) ? log.details_json : [];
        for (const d of details) {
          if (d.status !== "trade_placed") continue;

          const mt5 = d.mt5Mirror;
          if (!mt5) continue;

          // Handle special single-value strings
          if (mt5 === "skipped_paper_mode") {
            rows.push({
              id: `${log.id}-${d.pair}-paper`,
              time: log.created_at,
              symbol: d.pair,
              direction: d.direction || "—",
              positionId: d.positionId || "—",
              size: d.size ?? null,
              entryPrice: d.entryPrice ?? null,
              mirrorResult: "Paper mode — not sent to broker",
              status: "skipped",
            });
            continue;
          }
          if (mt5 === "skipped_no_connection") {
            rows.push({
              id: `${log.id}-${d.pair}-noconn`,
              time: log.created_at,
              symbol: d.pair,
              direction: d.direction || "—",
              positionId: d.positionId || "—",
              size: d.size ?? null,
              entryPrice: d.entryPrice ?? null,
              mirrorResult: "No active broker connection",
              status: "skipped",
            });
            continue;
          }
          if (mt5 === "error") {
            rows.push({
              id: `${log.id}-${d.pair}-err`,
              time: log.created_at,
              symbol: d.pair,
              direction: d.direction || "—",
              positionId: d.positionId || "—",
              size: d.size ?? null,
              entryPrice: d.entryPrice ?? null,
              mirrorResult: "Broker mirror error",
              status: "failed",
            });
            continue;
          }

          // Split semicolon-separated results for multiple brokers
          const parts = mt5.split("; ").filter(Boolean);
          for (const result of parts) {
            rows.push({
              id: `${log.id}-${d.pair}-${result.slice(0, 20)}`,
              time: log.created_at,
              symbol: d.pair,
              direction: d.direction || "—",
              positionId: d.positionId || "—",
              size: d.size ?? null,
              entryPrice: d.entryPrice ?? null,
              mirrorResult: result,
              status: classifyResult(result),
            });
          }
        }
      }
      return rows;
    },
    refetchInterval: 15000,
  });

  const rows = data || [];

  const counts = useMemo(() => {
    const c = { success: 0, skipped: 0, failed: 0 };
    rows.forEach((r) => {
      if (r.status === "success") c.success++;
      else if (r.status === "skipped") c.skipped++;
      else if (r.status === "failed") c.failed++;
    });
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return rows;
    return rows.filter((r) => r.status === statusFilter);
  }, [rows, statusFilter]);

  const StatusIcon = ({ status }: { status: BrokerLogRow["status"] }) => {
    if (status === "success") return <CheckCircle2 className="h-3 w-3 text-success" />;
    if (status === "skipped") return <SkipForward className="h-3 w-3 text-warning" />;
    if (status === "failed") return <XCircle className="h-3 w-3 text-destructive" />;
    return <span className="text-muted-foreground">—</span>;
  };

  const statusTextColor = (status: BrokerLogRow["status"]) => {
    if (status === "success") return "text-success";
    if (status === "skipped") return "text-warning";
    if (status === "failed") return "text-destructive";
    return "text-muted-foreground";
  };

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="flex items-center gap-2 pb-1.5 border-b border-border/50">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Filter</span>
        {[
          { key: "all", label: `All (${rows.length})` },
          { key: "success", label: `✓ Success (${counts.success})` },
          { key: "skipped", label: `⏭ Skipped (${counts.skipped})` },
          { key: "failed", label: `✗ Failed (${counts.failed})` },
        ].map((f) => (
          <button
            key={f.key}
            onClick={() => setStatusFilter(f.key)}
            className={`text-[10px] px-1.5 py-0.5 border ${
              statusFilter === f.key
                ? "bg-primary/20 text-primary border-primary/40"
                : "bg-card text-muted-foreground border-border hover:text-foreground"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto mt-1">
        {isLoading ? (
          <p className="text-[10px] text-muted-foreground text-center py-8">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="text-[10px] text-muted-foreground text-center py-8">
            {statusFilter === "all" ? "No broker execution events recorded" : `No ${statusFilter} events`}
          </p>
        ) : (
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="border-b border-border text-muted-foreground text-[10px]">
                <th className="text-left py-1 px-1">Time</th>
                <th className="text-left py-1 px-1">Symbol</th>
                <th className="text-left py-1 px-1">Dir</th>
                <th className="text-right py-1 px-1">Size</th>
                <th className="text-right py-1 px-1">Entry</th>
                <th className="text-center py-1 px-1">Status</th>
                <th className="text-left py-1 px-1">Broker Result</th>
                <th className="text-left py-1 px-1">Position</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, idx) => {
                const time = new Date(r.time).toLocaleString([], {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                });
                return (
                  <tr
                    key={r.id}
                    className={`border-b border-border/30 hover:bg-secondary/30 ${idx % 2 === 1 ? "bg-secondary/10" : ""}`}
                  >
                    <td className="py-1 px-1 text-muted-foreground">{time}</td>
                    <td className="py-1 px-1 font-medium">{r.symbol}</td>
                    <td className="py-1 px-1">
                      <span className={`flex items-center gap-0.5 ${r.direction === "long" ? "text-success" : r.direction === "short" ? "text-destructive" : "text-muted-foreground"}`}>
                        {r.direction === "long" ? <ArrowUpRight className="h-2.5 w-2.5" /> : r.direction === "short" ? <ArrowDownRight className="h-2.5 w-2.5" /> : null}
                        {r.direction === "long" ? "BUY" : r.direction === "short" ? "SELL" : "—"}
                      </span>
                    </td>
                    <td className="py-1 px-1 text-right">{r.size != null ? r.size.toFixed(2) : "—"}</td>
                    <td className="py-1 px-1 text-right">{r.entryPrice != null ? r.entryPrice.toFixed(5) : "—"}</td>
                    <td className="py-1 px-1 text-center">
                      <StatusIcon status={r.status} />
                    </td>
                    <td className={`py-1 px-1 text-[10px] ${statusTextColor(r.status)}`}>
                      {r.mirrorResult}
                    </td>
                    <td className="py-1 px-1 text-[9px] text-muted-foreground truncate max-w-[100px]" title={r.positionId}>
                      {r.positionId}
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
