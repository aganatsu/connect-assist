import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { brokerExecApi, brokerApi, paperApi } from "@/lib/api";
import {
  ArrowUpRight, ArrowDownRight, RefreshCw, Loader2, AlertTriangle,
  CheckCircle2, XCircle, Minus, TrendingUp, TrendingDown, Clock,
  DollarSign, Shield, Activity, ChevronDown, ChevronUp, Bot, User,
  Link2, Link2Off, Edit3, X, Check, GripVertical, Eye, EyeOff,
} from "lucide-react";
import { toast } from "sonner";

// ── Persistence ──
const STORAGE_KEY = "broker-tab-layout";
type LayoutState = { order: string[]; collapsed: Record<string, boolean> };

function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { order: ["account", "positions", "sync", "history"], collapsed: {} };
}

function saveLayout(state: LayoutState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

// ── Helpers ──
function formatDuration(openTime: string): string {
  const ms = Date.now() - new Date(openTime).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function formatPrice(price: number | undefined, digits = 5): string {
  if (price === undefined || price === null) return "—";
  return price.toFixed(digits);
}

function pnlColor(pnl: number): string {
  if (pnl > 0) return "text-success";
  if (pnl < 0) return "text-destructive";
  return "text-muted-foreground";
}

function getDigits(symbol: string): number {
  const s = (symbol || "").toUpperCase();
  if (s.includes("JPY")) return 3;
  if (s.includes("XAU") || s.includes("GOLD")) return 2;
  if (s.includes("XAG") || s.includes("SILVER")) return 4;
  return 5;
}

// ── Collapsible Section Wrapper ──
function CollapsibleSection({
  id, title, icon, badge, collapsed, onToggle, dragHandleProps, isDragOver, children,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  dragHandleProps: {
    draggable: boolean;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragEnter: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
  isDragOver: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`border rounded-lg overflow-hidden transition-all duration-200 ${
        isDragOver ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20" : "border-border/50"
      }`}
      {...dragHandleProps}
    >
      <div className="flex items-center gap-1 px-1.5 py-1.5 bg-muted/10">
        {/* Drag handle */}
        <div className="cursor-grab active:cursor-grabbing p-0.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors">
          <GripVertical className="h-3.5 w-3.5" />
        </div>

        {/* Collapse toggle + title */}
        <button
          onClick={onToggle}
          className="flex items-center gap-1.5 flex-1 min-w-0 hover:bg-muted/20 rounded px-1 py-0.5 transition-colors"
        >
          <span className="text-muted-foreground/60">{icon}</span>
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground truncate">
            {title}
          </h4>
          {badge}
          <span className="ml-auto">
            {collapsed ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground/50" />
            ) : (
              <ChevronUp className="h-3 w-3 text-muted-foreground/50" />
            )}
          </span>
        </button>

        {/* Visibility indicator */}
        <button
          onClick={onToggle}
          className="p-0.5 text-muted-foreground/30 hover:text-muted-foreground transition-colors"
          title={collapsed ? "Show section" : "Hide section"}
        >
          {collapsed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        </button>
      </div>

      {!collapsed && (
        <div className="animate-in slide-in-from-top-1 duration-200">
          {children}
        </div>
      )}
    </div>
  );
}

// ── Section: Account Summary ──
function AccountSummaryContent({ data, isLoading }: { data: any; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="p-3 animate-pulse">
        <div className="grid grid-cols-2 gap-2">
          {[...Array(6)].map((_, i) => <div key={i} className="h-8 bg-muted rounded" />)}
        </div>
      </div>
    );
  }
  if (!data) return <div className="p-3 text-xs text-muted-foreground text-center">No account data</div>;

  const balance = parseFloat(data.balance ?? 0);
  const equity = parseFloat(data.equity ?? data.balance ?? 0);
  const margin = parseFloat(data.margin ?? 0);
  const freeMargin = parseFloat(data.freeMargin ?? data.equity ?? 0);
  const floatingPnl = equity - balance;
  const marginLevel = margin > 0 ? (equity / margin) * 100 : 0;
  const currency = data.currency || "USD";

  return (
    <div className="p-3 pt-1">
      <div className="flex justify-end mb-1">
        <span className="text-[9px] text-muted-foreground/60">{currency}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-muted/30 rounded p-2">
          <p className="text-[9px] text-muted-foreground">Balance</p>
          <p className="text-xs font-mono font-bold">${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>
        <div className="bg-muted/30 rounded p-2">
          <p className="text-[9px] text-muted-foreground">Equity</p>
          <p className="text-xs font-mono font-bold">${equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>
        <div className="bg-muted/30 rounded p-2">
          <p className="text-[9px] text-muted-foreground">Floating P&L</p>
          <p className={`text-xs font-mono font-bold ${pnlColor(floatingPnl)}`}>
            {floatingPnl >= 0 ? "+" : ""}{floatingPnl.toFixed(2)}
          </p>
        </div>
        <div className="bg-muted/30 rounded p-2">
          <p className="text-[9px] text-muted-foreground">Margin Used</p>
          <p className="text-xs font-mono font-bold">${margin.toFixed(2)}</p>
        </div>
        <div className="bg-muted/30 rounded p-2">
          <p className="text-[9px] text-muted-foreground">Free Margin</p>
          <p className="text-xs font-mono font-bold">${freeMargin.toFixed(2)}</p>
        </div>
        <div className="bg-muted/30 rounded p-2">
          <p className="text-[9px] text-muted-foreground">Margin Level</p>
          <p className={`text-xs font-mono font-bold ${marginLevel > 200 ? "text-success" : marginLevel > 100 ? "text-warning" : "text-destructive"}`}>
            {margin > 0 ? `${marginLevel.toFixed(0)}%` : "—"}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Section: Open Positions ──
function OpenPositionsContent({
  positions, paperPositions, connectionId, isLoading,
}: {
  positions: any[]; paperPositions: any[]; connectionId: string; isLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSL, setEditSL] = useState("");
  const [editTP, setEditTP] = useState("");

  const closeMut = useMutation({
    mutationFn: (tradeId: string) => brokerExecApi.closeTrade(connectionId, tradeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["broker-open-trades"] });
      queryClient.invalidateQueries({ queryKey: ["broker-account"] });
      toast.success("Position closed on broker");
    },
    onError: (err: any) => toast.error(`Close failed: ${err.message}`),
  });

  const modifyMut = useMutation({
    mutationFn: ({ tradeId, updates }: { tradeId: string; updates: any }) =>
      brokerExecApi.modifyTrade(connectionId, tradeId, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["broker-open-trades"] });
      setEditingId(null);
      toast.success("Position modified");
    },
    onError: (err: any) => toast.error(`Modify failed: ${err.message}`),
  });

  if (isLoading) {
    return (
      <div className="p-3 animate-pulse">
        {[...Array(3)].map((_, i) => <div key={i} className="h-10 bg-muted rounded mb-2" />)}
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="p-6 text-center">
        <p className="text-xs text-muted-foreground">No open positions on broker</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px]">
        <thead>
          <tr className="border-b border-border/30 bg-muted/20">
            <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Symbol</th>
            <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Dir</th>
            <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Lots</th>
            <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Entry</th>
            <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Current</th>
            <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">SL</th>
            <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">TP</th>
            <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">P&L</th>
            <th className="text-center px-2 py-1.5 font-medium text-muted-foreground">Source</th>
            <th className="text-center px-2 py-1.5 font-medium text-muted-foreground">Time</th>
            <th className="text-center px-2 py-1.5 font-medium text-muted-foreground">Actions</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((pos: any) => {
            const isLong = pos.type?.includes("BUY") || pos.type === "POSITION_TYPE_BUY";
            const pnl = parseFloat(pos.profit ?? pos.unrealizedPL ?? 0);
            const swap = parseFloat(pos.swap ?? 0);
            const commission = parseFloat(pos.commission ?? 0);
            const totalPnl = pnl + swap + commission;
            const digits = getDigits(pos.symbol);
            const isBotManaged = /paper:/i.test(pos.comment || pos.clientExtensions?.comment || "");
            const isEditing = editingId === pos.id;

            return (
              <tr key={pos.id} className="border-b border-border/20 hover:bg-muted/10 transition-colors">
                <td className="px-2 py-1.5 font-mono font-bold">{pos.symbol}</td>
                <td className="px-2 py-1.5">
                  <span className={`inline-flex items-center gap-0.5 font-bold ${isLong ? "text-success" : "text-destructive"}`}>
                    {isLong ? <ArrowUpRight className="h-2.5 w-2.5" /> : <ArrowDownRight className="h-2.5 w-2.5" />}
                    {isLong ? "BUY" : "SELL"}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right font-mono">{parseFloat(pos.volume ?? pos.currentUnits ?? 0).toFixed(2)}</td>
                <td className="px-2 py-1.5 text-right font-mono">{formatPrice(pos.openPrice ?? pos.price, digits)}</td>
                <td className="px-2 py-1.5 text-right font-mono">{formatPrice(pos.currentPrice, digits)}</td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {isEditing ? (
                    <input
                      type="number"
                      step="any"
                      value={editSL}
                      onChange={(e) => setEditSL(e.target.value)}
                      className="w-20 bg-background border border-border rounded px-1 py-0.5 text-[10px] font-mono"
                    />
                  ) : (
                    <span className={pos.stopLoss ? "text-destructive/80" : "text-muted-foreground/40"}>
                      {formatPrice(pos.stopLoss, digits)}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {isEditing ? (
                    <input
                      type="number"
                      step="any"
                      value={editTP}
                      onChange={(e) => setEditTP(e.target.value)}
                      className="w-20 bg-background border border-border rounded px-1 py-0.5 text-[10px] font-mono"
                    />
                  ) : (
                    <span className={pos.takeProfit ? "text-success/80" : "text-muted-foreground/40"}>
                      {formatPrice(pos.takeProfit, digits)}
                    </span>
                  )}
                </td>
                <td className={`px-2 py-1.5 text-right font-mono font-bold ${pnlColor(totalPnl)}`}>
                  {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {isBotManaged ? (
                    <span className="inline-flex items-center gap-0.5 text-[8px] font-bold text-primary bg-primary/10 border border-primary/20 px-1 py-0.5 rounded">
                      <Bot className="h-2 w-2" /> BOT
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-0.5 text-[8px] font-bold text-muted-foreground bg-muted/30 border border-border px-1 py-0.5 rounded">
                      <User className="h-2 w-2" /> MANUAL
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-center text-muted-foreground">
                  <Clock className="h-2.5 w-2.5 inline mr-0.5" />
                  {pos.time || pos.openTime ? formatDuration(pos.time || pos.openTime) : "—"}
                </td>
                <td className="px-2 py-1.5 text-center">
                  <div className="flex items-center justify-center gap-1">
                    {isEditing ? (
                      <>
                        <button
                          onClick={() => {
                            const updates: any = {};
                            if (editSL) updates.stopLoss = parseFloat(editSL);
                            if (editTP) updates.takeProfit = parseFloat(editTP);
                            updates.symbol = pos.symbol;
                            modifyMut.mutate({ tradeId: pos.id, updates });
                          }}
                          className="text-success hover:bg-success/10 p-0.5 rounded transition-colors"
                          disabled={modifyMut.isPending}
                        >
                          {modifyMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        </button>
                        <button onClick={() => setEditingId(null)} className="text-muted-foreground hover:bg-muted/30 p-0.5 rounded transition-colors">
                          <X className="h-3 w-3" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => {
                            setEditingId(pos.id);
                            setEditSL(pos.stopLoss?.toString() || "");
                            setEditTP(pos.takeProfit?.toString() || "");
                          }}
                          className="text-muted-foreground hover:text-foreground hover:bg-muted/30 p-0.5 rounded transition-colors"
                          title="Edit SL/TP"
                        >
                          <Edit3 className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(`Close ${pos.symbol} ${isLong ? "BUY" : "SELL"} position on broker?`)) {
                              closeMut.mutate(pos.id);
                            }
                          }}
                          className="text-destructive hover:bg-destructive/10 p-0.5 rounded transition-colors"
                          disabled={closeMut.isPending}
                          title="Close position"
                        >
                          <XCircle className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Section: Sync Status ──
function SyncStatusContent({
  brokerPositions, paperPositions, isLoading,
}: {
  brokerPositions: any[]; paperPositions: any[]; isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="p-3 animate-pulse">
        <div className="h-4 w-32 bg-muted rounded" />
      </div>
    );
  }

  const syncResults = paperPositions.map((pp: any) => {
    const tag = `paper:${pp.id || pp.position_id}`;
    const shortTag = tag.slice(0, 28);
    const brokerMatch = brokerPositions.find((bp: any) =>
      (bp.comment || "").includes(tag) || (bp.comment || "").includes(shortTag)
    );
    return { paper: pp, broker: brokerMatch, synced: !!brokerMatch };
  });

  const matchedBrokerIds = new Set(syncResults.filter(s => s.broker).map(s => s.broker.id));
  const orphanedBroker = brokerPositions.filter((bp: any) =>
    /paper:/i.test(bp.comment || "") && !matchedBrokerIds.has(bp.id)
  );

  if (syncResults.length === 0 && orphanedBroker.length === 0) {
    return <div className="p-3 text-[10px] text-muted-foreground text-center">No positions to compare</div>;
  }

  return (
    <div className="px-3 pb-3 pt-1 space-y-1">
      {syncResults.map((sr, i) => {
        const pp = sr.paper;
        const bp = sr.broker;
        const paperSL = parseFloat(pp.stop_loss || pp.stopLoss || 0);
        const brokerSL = bp ? parseFloat(bp.stopLoss || 0) : 0;
        const slMismatch = bp && Math.abs(paperSL - brokerSL) > 0.0001;
        const digits = getDigits(pp.symbol);

        return (
          <div key={i} className={`flex items-center justify-between text-[10px] px-2 py-1 rounded ${slMismatch ? "bg-destructive/5 border border-destructive/20" : sr.synced ? "bg-success/5 border border-success/20" : "bg-warning/5 border border-warning/20"}`}>
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold">{pp.symbol}</span>
              <span className={pp.direction === "long" ? "text-success" : "text-destructive"}>{pp.direction?.toUpperCase()}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground">Paper SL: <span className="font-mono">{formatPrice(paperSL, digits)}</span></span>
              {bp ? (
                <>
                  <span className="text-muted-foreground">Broker SL: <span className={`font-mono ${slMismatch ? "text-destructive font-bold" : ""}`}>{formatPrice(brokerSL, digits)}</span></span>
                  {slMismatch ? <AlertTriangle className="h-3 w-3 text-destructive" /> : <CheckCircle2 className="h-3 w-3 text-success" />}
                </>
              ) : (
                <span className="text-warning font-bold">NOT ON BROKER</span>
              )}
            </div>
          </div>
        );
      })}
      {orphanedBroker.map((bp: any, i: number) => (
        <div key={`orphan-${i}`} className="flex items-center justify-between text-[10px] px-2 py-1 rounded bg-muted/20 border border-border">
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold">{bp.symbol}</span>
            <span className="text-muted-foreground">Orphaned on broker</span>
          </div>
          <span className="text-[8px] text-muted-foreground bg-muted/30 px-1 py-0.5 rounded">paper tag not found in ledger</span>
        </div>
      ))}
    </div>
  );
}

// ── Section: Trade History ──
function TradeHistoryContent({
  trades, paperHistory, isLoading,
}: {
  trades: any[]; paperHistory: any[]; isLoading: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const displayed = showAll ? trades : trades.slice(0, 15);

  if (isLoading) {
    return (
      <div className="p-3 animate-pulse">
        {[...Array(5)].map((_, i) => <div key={i} className="h-8 bg-muted rounded mb-2" />)}
      </div>
    );
  }

  const totalPnl = trades.reduce((s, t) => s + (t.netPnl ?? t.pnl ?? parseFloat(t.realizedPL ?? 0)), 0);
  const totalComm = trades.reduce((s, t) => s + (t.commission ?? 0), 0);
  const wins = trades.filter(t => (t.netPnl ?? t.pnl ?? parseFloat(t.realizedPL ?? 0)) > 0).length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;

  if (trades.length === 0) {
    return (
      <div className="p-6 text-center">
        <p className="text-xs text-muted-foreground">No closed trades in the last 30 days</p>
      </div>
    );
  }

  return (
    <>
      {/* Summary bar */}
      <div className="px-3 py-1.5 border-b border-border/30 flex items-center justify-end gap-3 text-[9px]">
        <span className={`font-mono font-bold ${pnlColor(totalPnl)}`}>
          Net: {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)}
        </span>
        <span className="text-muted-foreground">Comm: {totalComm.toFixed(2)}</span>
        <span className={`font-bold ${winRate >= 50 ? "text-success" : "text-destructive"}`}>
          WR: {winRate.toFixed(0)}%
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="border-b border-border/30 bg-muted/20">
              <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Symbol</th>
              <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Dir</th>
              <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Lots</th>
              <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Entry</th>
              <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Exit</th>
              <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Gross P&L</th>
              <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Comm</th>
              <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Net P&L</th>
              <th className="text-center px-2 py-1.5 font-medium text-muted-foreground">Source</th>
              <th className="text-center px-2 py-1.5 font-medium text-muted-foreground">Closed</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((trade: any, i: number) => {
              const isLong = trade.direction === "long" || trade.type?.includes("BUY");
              const grossPnl = trade.pnl ?? parseFloat(trade.realizedPL ?? 0);
              const netPnl = trade.netPnl ?? grossPnl;
              const comm = trade.commission ?? 0;
              const digits = getDigits(trade.symbol);
              const isBotManaged = trade.botManaged || /paper:/i.test(trade.comment || "");
              const closeTime = trade.closeTime;

              return (
                <tr key={trade.positionId || i} className="border-b border-border/20 hover:bg-muted/10 transition-colors">
                  <td className="px-2 py-1.5 font-mono font-bold">{trade.symbol}</td>
                  <td className="px-2 py-1.5">
                    <span className={`font-bold ${isLong ? "text-success" : "text-destructive"}`}>
                      {isLong ? "BUY" : "SELL"}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">{parseFloat(trade.volume ?? trade.initialUnits ?? 0).toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{formatPrice(trade.entryPrice ?? trade.price, digits)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{formatPrice(trade.exitPrice ?? trade.averageClosePrice, digits)}</td>
                  <td className={`px-2 py-1.5 text-right font-mono ${pnlColor(grossPnl)}`}>
                    {grossPnl >= 0 ? "+" : ""}{grossPnl.toFixed(2)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{comm.toFixed(2)}</td>
                  <td className={`px-2 py-1.5 text-right font-mono font-bold ${pnlColor(netPnl)}`}>
                    {netPnl >= 0 ? "+" : ""}{netPnl.toFixed(2)}
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    {isBotManaged ? (
                      <span className="text-[8px] font-bold text-primary bg-primary/10 px-1 py-0.5 rounded">BOT</span>
                    ) : (
                      <span className="text-[8px] font-bold text-muted-foreground bg-muted/30 px-1 py-0.5 rounded">MANUAL</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-center text-muted-foreground">
                    {closeTime ? new Date(closeTime).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {trades.length > 15 && (
        <div className="px-3 py-2 border-t border-border/30 text-center">
          <button onClick={() => setShowAll(!showAll)} className="text-[10px] text-primary hover:underline">
            {showAll ? "Show less" : `Show all ${trades.length} trades`}
          </button>
        </div>
      )}
    </>
  );
}

// ── Main Component ──
export default function BrokerTradesTab() {
  const queryClient = useQueryClient();
  const [layout, setLayout] = useState<LayoutState>(loadLayout);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Persist layout changes
  const updateLayout = useCallback((updater: (prev: LayoutState) => LayoutState) => {
    setLayout(prev => {
      const next = updater(prev);
      saveLayout(next);
      return next;
    });
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    updateLayout(prev => ({
      ...prev,
      collapsed: { ...prev.collapsed, [id]: !prev.collapsed[id] },
    }));
  }, [updateLayout]);

  // Drag handlers
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    // Make the drag image slightly transparent
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "0.5";
    }
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    setDragId(null);
    setDragOverId(null);
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "1";
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    setDragOverId(id);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear if leaving the container, not entering a child
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const { clientX, clientY } = e;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      setDragOverId(null);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData("text/plain");
    if (!sourceId || sourceId === targetId) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    updateLayout(prev => {
      const newOrder = [...prev.order];
      const srcIdx = newOrder.indexOf(sourceId);
      const tgtIdx = newOrder.indexOf(targetId);
      if (srcIdx === -1 || tgtIdx === -1) return prev;
      newOrder.splice(srcIdx, 1);
      newOrder.splice(tgtIdx, 0, sourceId);
      return { ...prev, order: newOrder };
    });
    setDragId(null);
    setDragOverId(null);
  }, [updateLayout]);

  const makeDragProps = useCallback((id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => handleDragStart(e, id),
    onDragEnd: handleDragEnd,
    onDragOver: handleDragOver,
    onDragEnter: (e: React.DragEvent) => handleDragEnter(e, id),
    onDragLeave: handleDragLeave,
    onDrop: (e: React.DragEvent) => handleDrop(e, id),
  }), [handleDragStart, handleDragEnd, handleDragOver, handleDragEnter, handleDragLeave, handleDrop]);

  // Load broker connections
  const { data: connections, isLoading: connsLoading } = useQuery({
    queryKey: ["broker-connections"],
    queryFn: () => brokerApi.list(),
    staleTime: 60000,
  });

  const activeConns = useMemo(() =>
    (connections || []).filter((c: any) => c.is_active && c.broker_type === "metaapi"),
    [connections]
  );
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  const connId = selectedConnId || activeConns[0]?.id;

  // Load broker data
  const { data: accountData, isLoading: accountLoading } = useQuery({
    queryKey: ["broker-account", connId],
    queryFn: () => brokerExecApi.accountSummary(connId),
    enabled: !!connId,
    refetchInterval: 15000,
  });

  const { data: brokerPositions, isLoading: positionsLoading } = useQuery({
    queryKey: ["broker-open-trades", connId],
    queryFn: () => brokerExecApi.openTrades(connId),
    enabled: !!connId,
    refetchInterval: 10000,
  });

  const { data: tradeHistory, isLoading: historyLoading } = useQuery({
    queryKey: ["broker-trade-history", connId],
    queryFn: () => brokerExecApi.tradeHistory(connId),
    enabled: !!connId,
    staleTime: 30000,
  });

  // Load paper positions for sync comparison
  const { data: paperStatus } = useQuery({
    queryKey: ["paper-status"],
    queryFn: () => paperApi.status(),
    refetchInterval: 5000,
  });

  const paperPositions = paperStatus?.positions || [];
  const paperHistory = paperStatus?.tradeHistory || [];
  const brokerPos = Array.isArray(brokerPositions) ? brokerPositions : [];
  const brokerHist = Array.isArray(tradeHistory) ? tradeHistory : [];

  // Sync status badges for the section header
  const syncBadges = useMemo(() => {
    const syncResults = paperPositions.map((pp: any) => {
      const tag = `paper:${pp.id || pp.position_id}`;
      const shortTag = tag.slice(0, 28);
      const brokerMatch = brokerPos.find((bp: any) =>
        (bp.comment || "").includes(tag) || (bp.comment || "").includes(shortTag)
      );
      return { paper: pp, broker: brokerMatch, synced: !!brokerMatch };
    });
    const syncedCount = syncResults.filter(s => s.synced).length;
    const unsyncedCount = syncResults.filter(s => !s.synced).length;
    const mismatchCount = syncResults.filter(s => {
      if (!s.broker) return false;
      const paperSL = parseFloat(s.paper.stop_loss || s.paper.stopLoss || 0);
      const brokerSL = parseFloat(s.broker.stopLoss || 0);
      return Math.abs(paperSL - brokerSL) > 0.0001;
    }).length;
    return { syncedCount, unsyncedCount, mismatchCount };
  }, [paperPositions, brokerPos]);

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ["broker-account"] });
    queryClient.invalidateQueries({ queryKey: ["broker-open-trades"] });
    queryClient.invalidateQueries({ queryKey: ["broker-trade-history"] });
    toast.success("Refreshing broker data...");
  };

  if (connsLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (activeConns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center">
        <Shield className="h-8 w-8 text-muted-foreground/40 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">No Active Broker Connection</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Connect your MT4/MT5 account via MetaAPI in the Settings tab to view live trades.
        </p>
      </div>
    );
  }

  // Section definitions
  const sections: Record<string, { title: string; icon: React.ReactNode; badge?: React.ReactNode; content: React.ReactNode }> = {
    account: {
      title: "Account Summary",
      icon: <DollarSign className="h-3 w-3" />,
      content: <AccountSummaryContent data={accountData?.error ? null : accountData} isLoading={accountLoading} />,
    },
    positions: {
      title: `Open Positions (${brokerPos.length})`,
      icon: <Activity className="h-3 w-3" />,
      content: (
        <OpenPositionsContent
          positions={brokerPos}
          paperPositions={paperPositions}
          connectionId={connId}
          isLoading={positionsLoading}
        />
      ),
    },
    sync: {
      title: "Sync Status",
      icon: syncBadges.unsyncedCount > 0 || syncBadges.mismatchCount > 0
        ? <AlertTriangle className="h-3 w-3 text-warning" />
        : <CheckCircle2 className="h-3 w-3 text-success" />,
      badge: (
        <div className="flex items-center gap-1">
          {syncBadges.syncedCount > 0 && (
            <span className="text-[8px] font-bold text-success bg-success/10 border border-success/20 px-1 py-0.5 rounded">
              {syncBadges.syncedCount} synced
            </span>
          )}
          {syncBadges.unsyncedCount > 0 && (
            <span className="text-[8px] font-bold text-warning bg-warning/10 border border-warning/20 px-1 py-0.5 rounded">
              {syncBadges.unsyncedCount} unsynced
            </span>
          )}
          {syncBadges.mismatchCount > 0 && (
            <span className="text-[8px] font-bold text-destructive bg-destructive/10 border border-destructive/20 px-1 py-0.5 rounded">
              {syncBadges.mismatchCount} SL mismatch
            </span>
          )}
        </div>
      ),
      content: (
        <SyncStatusContent
          brokerPositions={brokerPos}
          paperPositions={paperPositions}
          isLoading={positionsLoading}
        />
      ),
    },
    history: {
      title: `Trade History (${brokerHist.length})`,
      icon: <Clock className="h-3 w-3" />,
      content: (
        <TradeHistoryContent
          trades={brokerHist}
          paperHistory={paperHistory}
          isLoading={historyLoading}
        />
      ),
    },
  };

  return (
    <div className="space-y-2 p-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wider">
            <TrendingUp className="h-3.5 w-3.5 inline mr-1" />
            Live Broker
          </h3>
          {activeConns.length > 1 && (
            <select
              value={connId || ""}
              onChange={(e) => setSelectedConnId(e.target.value)}
              className="text-[10px] bg-background border border-border rounded px-1.5 py-0.5"
            >
              {activeConns.map((c: any) => (
                <option key={c.id} value={c.id}>{c.display_name}</option>
              ))}
            </select>
          )}
          {activeConns.length === 1 && (
            <span className="text-[10px] text-muted-foreground font-mono">{activeConns[0].display_name}</span>
          )}
        </div>
        <button
          onClick={refreshAll}
          className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>

      {/* Account error state */}
      {accountData?.error && (
        <div className="border border-destructive/30 bg-destructive/5 rounded-lg p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-medium text-destructive">Broker Connection Error</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{accountData.error}</p>
          </div>
        </div>
      )}

      {/* Draggable + Collapsible Sections */}
      {layout.order.map(id => {
        const section = sections[id];
        if (!section) return null;
        return (
          <CollapsibleSection
            key={id}
            id={id}
            title={section.title}
            icon={section.icon}
            badge={section.badge}
            collapsed={!!layout.collapsed[id]}
            onToggle={() => toggleCollapse(id)}
            dragHandleProps={makeDragProps(id)}
            isDragOver={dragOverId === id && dragId !== id}
          >
            {section.content}
          </CollapsibleSection>
        );
      })}

      {/* Layout hint */}
      <p className="text-[9px] text-muted-foreground/40 text-center pt-1">
        Drag sections to reorder · Click headers to collapse
      </p>
    </div>
  );
}
