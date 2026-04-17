import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { CheckCircle2, SkipForward, XCircle, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { formatBrokerTime } from "@/lib/formatTime";

type BrokerLogRow = {
  id: string;
  time: string;
  symbol: string;
  direction: string;
  positionId: string;
  size: number | null;
  entryPrice: number | null;
  mirrorResult: string;       // raw result from mt5Mirror
  displayResult: string;      // human-readable version
  status: "success" | "skipped" | "failed" | "unknown";
};

// Human-readable translations for broker error codes
const ERROR_TRANSLATIONS: Record<string, string> = {
  // MetaTrader retcodes
  "TRADE_RETCODE_INVALID_STOPS": "Invalid stop loss or take profit levels — broker rejected the SL/TP values",
  "TRADE_RETCODE_NO_MONEY": "Insufficient funds — broker account balance too low to open this trade",
  "TRADE_RETCODE_MARKET_CLOSED": "Market is closed — trading hours ended for this instrument",
  "TRADE_RETCODE_INVALID_VOLUME": "Invalid lot size — volume is outside broker's allowed range",
  "TRADE_RETCODE_INVALID_PRICE": "Invalid price — the requested price is no longer available",
  "TRADE_RETCODE_TOO_MANY_REQUESTS": "Too many requests — broker rate limit hit, try again later",
  "TRADE_RETCODE_CONNECTION": "Connection lost — could not reach broker server",
  "TRADE_RETCODE_TIMEOUT": "Request timed out — broker did not respond in time",
  "TRADE_RETCODE_INVALID_EXPIRATION": "Invalid order expiration — check pending order settings",
  "TRADE_RETCODE_ORDER_CHANGED": "Order was modified by broker during execution",
  "TRADE_RETCODE_PRICE_CHANGED": "Price changed during execution — requote",
  "TRADE_RETCODE_PRICE_OFF": "Price is off — no quotes available for this symbol",
  "TRADE_RETCODE_LIMIT_ORDERS": "Maximum number of pending orders reached",
  "TRADE_RETCODE_LIMIT_VOLUME": "Maximum total volume reached on broker account",
  "TRADE_RETCODE_REJECT": "Trade rejected by broker — general rejection",
  "TRADE_RETCODE_CANCEL": "Trade cancelled by broker",
  "TRADE_RETCODE_LOCKED": "Trade is locked — position modification not allowed",
  "TRADE_RETCODE_FROZEN": "Order is frozen — cannot modify or cancel",
  "TRADE_RETCODE_INVALID_FILL": "Invalid fill policy — order fill type not supported",
  "TRADE_RETCODE_POSITION_CLOSED": "Position already closed",
  "TRADE_RETCODE_CLOSE_ONLY": "Close-only mode — broker only allows closing positions, not opening new ones",
  // ERR_ codes
  "ERR_INVALID_STOPS": "Invalid stop levels — SL/TP too close to current price or outside allowed range",
  "ERR_MARKET_UNKNOWN_SYMBOL": "Unknown symbol — this pair is not available on your broker account",
  "ERR_TRADE_DISABLED": "Trading disabled — broker has disabled trading on this account",
  "ERR_NOT_ENOUGH_MONEY": "Not enough margin — insufficient free margin to open this position",
  "ERR_TRADE_TOO_MANY_ORDERS": "Too many open orders — broker limit reached",
  "ERR_TRADE_HEDGE_PROHIBITED": "Hedging not allowed — broker does not permit opposite positions",
  "ERR_TRADE_CLOSE_ONLY": "Close-only mode — new positions are not allowed",
};

function translateBrokerResult(raw: string): string {
  // Try to extract the error code from patterns like "BrokerName: rejected CODE" or "BrokerName: failed CODE"
  const rejectedMatch = raw.match(/:\s*rejected\s+(.+)$/i);
  const failedMatch = raw.match(/:\s*failed\s+(.+)$/i);

  const code = rejectedMatch?.[1]?.trim() || failedMatch?.[1]?.trim();
  if (code) {
    // Check if it's a known error code
    const translation = ERROR_TRANSLATIONS[code];
    if (translation) {
      // Extract broker name
      const brokerName = raw.split(":")[0]?.trim() || "Broker";
      return `${brokerName}: ${translation}`;
    }
    // If it's an HTTP status code like "401", "403", "500"
    if (/^\d{3}$/.test(code)) {
      const brokerName = raw.split(":")[0]?.trim() || "Broker";
      const httpMeanings: Record<string, string> = {
        "401": "Authentication failed — broker token expired or invalid",
        "403": "Access denied — broker account permissions issue",
        "404": "Endpoint not found — broker API configuration error",
        "429": "Rate limited — too many requests to broker",
        "500": "Broker server error — try again later",
        "502": "Broker gateway error — server temporarily unavailable",
        "503": "Broker service unavailable — server overloaded or in maintenance",
      };
      return `${brokerName}: ${httpMeanings[code] || `HTTP ${code} error from broker`}`;
    }
  }

  // For spread skips, make them more readable
  const spreadMatch = raw.match(/:\s*skipped\s*\(spread\s+([\d.]+)\s*>\s*([\d.]+)\s*(?:max)?\)/i);
  if (spreadMatch) {
    const brokerName = raw.split(":")[0]?.trim() || "Broker";
    return `${brokerName}: Spread too wide (${spreadMatch[1]} pips > ${spreadMatch[2]} max) — trade not sent`;
  }

  // For zero balance
  if (raw.toLowerCase().includes("skipped (zero balance)")) {
    const brokerName = raw.split(":")[0]?.trim() || "Broker";
    return `${brokerName}: Broker account has zero balance — cannot open trade`;
  }

  // For symbol not found
  const symbolMatch = raw.match(/:\s*skipped\s*—\s*symbol\s+(\S+)\s+not found/i);
  if (symbolMatch) {
    const brokerName = raw.split(":")[0]?.trim() || "Broker";
    return `${brokerName}: Symbol ${symbolMatch[1]} not found on this broker — check symbol mapping`;
  }

  // For balance error
  if (raw.toLowerCase().includes("skipped (balance error)")) {
    const brokerName = raw.split(":")[0]?.trim() || "Broker";
    return `${brokerName}: Could not read broker balance — connection issue`;
  }

  // Success stays as-is but make it cleaner
  if (raw.toLowerCase().includes("success")) {
    const brokerName = raw.split(":")[0]?.trim() || "Broker";
    return `${brokerName}: Trade mirrored successfully`;
  }

  return raw;
}

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

      type ScanDetail = {
        status?: string;
        pair?: string;
        direction?: string;
        positionId?: string;
        size?: number | null;
        entryPrice?: number | null;
        mt5Mirror?: string;
      };

      const rows: BrokerLogRow[] = [];
      for (const log of data || []) {
        const details = Array.isArray(log.details_json) ? (log.details_json as unknown as ScanDetail[]) : [];
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
              mirrorResult: mt5,
              displayResult: "Paper mode — trades are simulated, not sent to broker",
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
              mirrorResult: mt5,
              displayResult: "No active broker connection — add a broker in Settings to mirror trades",
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
              mirrorResult: mt5,
              displayResult: "Unexpected broker mirror error — check broker connection status",
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
              displayResult: translateBrokerResult(result),
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
                return (
                  <tr
                    key={r.id}
                    className={`border-b border-border/30 hover:bg-secondary/30 ${idx % 2 === 1 ? "bg-secondary/10" : ""}`}
                  >
                    <td className="py-1 px-1 text-muted-foreground whitespace-nowrap">{formatBrokerTime(r.time)}</td>
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
                    <td className={`py-1 px-1 text-[10px] ${statusTextColor(r.status)}`} title={r.mirrorResult}>
                      {r.displayResult}
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
