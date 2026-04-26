import { useState, useMemo, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { paperApi, marketApi, scannerApi } from "@/lib/api";
import TradeReplayChart, {
  type TradeMarker,
  type ZoneOverlay,
  type TradeLevels,
} from "@/components/TradeReplayChart";
import { TradeReplaySidebar, type TradeItem } from "@/components/TradeReplaySidebar";
import { TradeReplayDetails } from "@/components/TradeReplayDetails";
import { type CandlestickData, type Time } from "lightweight-charts";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  Layers,
  BarChart3,
  TrendingUp,
  Droplets,
  Shield,
  Maximize2,
  Minimize2,
} from "lucide-react";

/* ─── Timeframe options ─── */
const TIMEFRAMES = [
  { label: "M15", value: "15min" },
  { label: "M30", value: "30min" },
  { label: "H1", value: "1h" },
  { label: "H4", value: "4h" },
  { label: "D1", value: "1day" },
];

/* ─── Overlay toggle config ─── */
const OVERLAY_TOGGLES = [
  { key: "ob", label: "OB", icon: Layers, color: "#3b82f6" },
  { key: "fvg", label: "FVG", icon: BarChart3, color: "#a855f7" },
  { key: "sr", label: "S/R", icon: TrendingUp, color: "#f59e0b" },
  { key: "liquidity", label: "Liq", icon: Droplets, color: "#06b6d4" },
  { key: "breaker", label: "BRK", icon: Shield, color: "#ec4899" },
];

export default function TradeReplay() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState("4h");
  const [overlays, setOverlays] = useState<Record<string, boolean>>({
    ob: true, fvg: true, sr: true, liquidity: true, breaker: true,
  });
  const [detailsExpanded, setDetailsExpanded] = useState(true);

  /* ─── Fetch positions + history ─── */
  const { data: status } = useQuery({
    queryKey: ["paper-status-replay"],
    queryFn: () => paperApi.status(),
    refetchInterval: 15000,
  });

  /* ─── Fetch staged setups ─── */
  const { data: stagedSetups } = useQuery({
    queryKey: ["staged-setups-replay"],
    queryFn: () => scannerApi.activeStaged(),
    refetchInterval: 30000,
  });

  /* ─── Fetch scan logs for analysis snapshots ─── */
  const { data: scanLogs } = useQuery({
    queryKey: ["scan-logs-replay"],
    queryFn: () => scannerApi.logs(),
    refetchInterval: 60000,
  });

  /* ─── Build unified trade list ─── */
  const trades: TradeItem[] = useMemo(() => {
    const items: TradeItem[] = [];

    // Open positions
    const positions = Array.isArray(status?.positions) ? status.positions : [];
    if (positions.length > 0) {
      for (const p of positions) {
        items.push({
          position_id: p.id || p.positionId,
          symbol: p.symbol,
          direction: p.direction?.toUpperCase() === "LONG" || p.direction?.toUpperCase() === "BUY" ? "BUY" : "SELL",
          entry_price: p.entryPrice,
          stop_loss: p.stopLoss ?? null,
          take_profit: p.takeProfit ?? null,
          current_sl: p.stopLoss ?? null,
          status: "open",
          opened_at: p.openTime,
          pnl_pips: p.pnl ? undefined : undefined, // will compute from pnl
          signal_reason: parseSignalReason(p.signalReason),
        });
      }
    }

    // Closed trades
    const history = Array.isArray(status?.tradeHistory) ? status.tradeHistory : [];
    if (history.length > 0) {
      for (const t of history) {
        items.push({
          position_id: t.id || t.positionId,
          symbol: t.symbol,
          direction: t.direction?.toUpperCase() === "LONG" || t.direction?.toUpperCase() === "BUY" ? "BUY" : "SELL",
          entry_price: t.entryPrice,
          stop_loss: t.stopLoss != null ? parseFloat(t.stopLoss) : null,
          take_profit: t.takeProfit != null ? parseFloat(t.takeProfit) : null,
          status: "closed",
          opened_at: t.openTime,
          closed_at: t.closedAt,
          exit_price: t.exitPrice,
          pnl_pips: t.pnlPips,
          signal_reason: parseSignalReason(t.signalReason),
        });
      }
    }

    // Staged setups
    const staged = Array.isArray(stagedSetups) ? stagedSetups : [];
    if (staged.length > 0) {
      for (const s of staged) {
        items.push({
          position_id: s.id || s.setup_id || `staged-${s.symbol}`,
          symbol: s.symbol,
          direction: s.direction?.toUpperCase() === "LONG" || s.direction?.toUpperCase() === "BUY" ? "BUY" : "SELL",
          entry_price: parseFloat(s.entry_price) || 0,
          stop_loss: s.stop_loss != null ? parseFloat(s.stop_loss) : null,
          take_profit: s.take_profit != null ? parseFloat(s.take_profit) : null,
          status: "staged",
          opened_at: s.staged_at || s.created_at,
          signal_reason: {
            score: parseFloat(s.current_score || s.initial_score || "0"),
            summary: s.signal_reason || "",
          },
        });
      }
    }

    return items;
  }, [status, stagedSetups]);

  /* ─── Selected trade ─── */
  const selectedTrade = useMemo(
    () => trades.find((t) => t.position_id === selectedId) || null,
    [trades, selectedId]
  );

  // Auto-select first trade if none selected
  useEffect(() => {
    if (!selectedId && trades.length > 0) {
      setSelectedId(trades[0].position_id);
    }
  }, [trades, selectedId]);

  /* ─── Fetch candles for selected trade ─── */
  const { data: candleData, isLoading: candlesLoading } = useQuery({
    queryKey: ["replay-candles", selectedTrade?.symbol, timeframe],
    queryFn: async () => {
      if (!selectedTrade?.symbol) return [];
      const result = await marketApi.candles(selectedTrade.symbol, timeframe, 300);
      if (Array.isArray(result)) return result;
      if (result?.values && Array.isArray(result.values)) return result.values;
      if (result?.data && Array.isArray(result.data)) return result.data;
      return [];
    },
    enabled: !!selectedTrade?.symbol,
    staleTime: 60000,
  });

  /* ─── Transform candles for lightweight-charts ─── */
  const chartCandles: CandlestickData<Time>[] = useMemo(() => {
    if (!candleData || !Array.isArray(candleData)) return [];
    return candleData
      .map((c: any) => {
        const time = c.datetime
          ? Math.floor(new Date(c.datetime).getTime() / 1000)
          : c.time || c.timestamp;
        return {
          time: time as Time,
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
        };
      })
      .filter((c: any) => !isNaN(c.open) && !isNaN(c.close))
      .sort((a: any, b: any) => (a.time as number) - (b.time as number));
  }, [candleData]);

  /* ─── Trade markers ─── */
  const markers: TradeMarker[] = useMemo(() => {
    if (!selectedTrade) return [];
    const m: TradeMarker[] = [];
    const entryTime = Math.floor(new Date(selectedTrade.opened_at).getTime() / 1000);
    m.push({
      time: entryTime,
      type: "entry",
      label: `${selectedTrade.direction} @ ${selectedTrade.entry_price.toFixed(5)}`,
      price: selectedTrade.entry_price,
    });
    if (selectedTrade.status === "closed" && selectedTrade.exit_price && selectedTrade.closed_at) {
      const exitTime = Math.floor(new Date(selectedTrade.closed_at).getTime() / 1000);
      m.push({
        time: exitTime,
        type: "exit",
        label: `Exit @ ${selectedTrade.exit_price.toFixed(5)}`,
        price: selectedTrade.exit_price,
      });
    }
    return m;
  }, [selectedTrade]);

  /* ─── Trade levels ─── */
  const levels: TradeLevels | null = useMemo(() => {
    if (!selectedTrade) return null;
    return {
      entry: selectedTrade.entry_price,
      originalSL: selectedTrade.stop_loss,
      currentSL: selectedTrade.current_sl || null,
      takeProfit: selectedTrade.take_profit,
      direction: selectedTrade.direction,
    };
  }, [selectedTrade]);

  /* ─── Zone overlays from scan detail ─── */
  const zones: ZoneOverlay[] = useMemo(() => {
    if (!selectedTrade || !scanLogs) return [];
    const z: ZoneOverlay[] = [];

    // Find the most recent scan log that has details for this symbol
    const logs = Array.isArray(scanLogs) ? scanLogs : (scanLogs?.logs ? (Array.isArray(scanLogs.logs) ? scanLogs.logs : []) : []);
    let scanDetail: any = null;
    for (const log of logs) {
      const details = log.details_json?.details || log.details_json || [];
      if (Array.isArray(details)) {
        const found = details.find((d: any) => d.pair === selectedTrade.symbol);
        if (found) { scanDetail = found; break; }
      }
    }

    if (!scanDetail?.analysis_snapshot) return z;
    const snap = scanDetail.analysis_snapshot;

    // Order Blocks
    if (snap.orderBlock?.zones || snap.orderBlocks) {
      const obsRaw = snap.orderBlock?.zones || snap.orderBlocks || [];
      const obs = Array.isArray(obsRaw) ? obsRaw : [];
      for (const ob of obs) {
        z.push({
          type: "ob",
          high: ob.high || ob.top || 0,
          low: ob.low || ob.bottom || 0,
          label: `OB ${ob.type || ""} ${ob.state || ""}`.trim(),
          state: ob.state,
        });
      }
    }

    // FVGs
    if (snap.fvg?.zones || snap.fvgs) {
      const fvgsRaw = snap.fvg?.zones || snap.fvgs || [];
      const fvgs = Array.isArray(fvgsRaw) ? fvgsRaw : [];
      for (const fvg of fvgs) {
        z.push({
          type: "fvg",
          high: fvg.high || fvg.top || 0,
          low: fvg.low || fvg.bottom || 0,
          label: `FVG ${fvg.type || ""} ${fvg.state || ""}`.trim(),
          state: fvg.state,
        });
      }
    }

    // S/R levels from structure intel
    if (snap.structureIntel?.derivedSR || scanDetail.structureIntel?.derivedSR) {
      const srRaw = snap.structureIntel?.derivedSR || scanDetail.structureIntel?.derivedSR || [];
      const srLevels = Array.isArray(srRaw) ? srRaw : [];
      for (const sr of srLevels) {
        const price = sr.price || sr.level || 0;
        z.push({
          type: "sr",
          high: price + (price * 0.0002),
          low: price - (price * 0.0002),
          label: `S/R ${sr.type || ""} ${sr.state || ""}`.trim(),
          state: sr.state,
        });
      }
    }

    // Liquidity pools
    if (snap.liquiditySweep?.pools || snap.liquidityPools) {
      const poolsRaw = snap.liquiditySweep?.pools || snap.liquidityPools || [];
      const pools = Array.isArray(poolsRaw) ? poolsRaw : [];
      for (const pool of pools.slice(0, 10)) { // limit to 10 most relevant
        const price = pool.level || pool.price || 0;
        z.push({
          type: "liquidity",
          high: price + (price * 0.0001),
          low: price - (price * 0.0001),
          label: `Liq ${pool.type || ""} ${pool.state || ""}`.trim(),
          state: pool.state,
        });
      }
    }

    // Breaker blocks
    if (snap.breakerBlock?.zones || snap.breakerBlocks) {
      const breakersRaw = snap.breakerBlock?.zones || snap.breakerBlocks || [];
      const breakers = Array.isArray(breakersRaw) ? breakersRaw : [];
      for (const brk of breakers) {
        z.push({
          type: "breaker",
          high: brk.high || brk.top || 0,
          low: brk.low || brk.bottom || 0,
          label: `BRK ${brk.type || ""} ${brk.state || ""}`.trim(),
          state: brk.state,
        });
      }
    }

    return z;
  }, [selectedTrade, scanLogs]);

  /* ─── Toggle overlay ─── */
  const toggleOverlay = useCallback((key: string) => {
    setOverlays((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  return (
    <AppShell>
    <div className="h-full flex flex-col overflow-hidden">
      {/* Top toolbar */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-bold tracking-wide text-foreground">
            TRADE REPLAY
          </h1>
          {selectedTrade && (
            <span className="text-xs font-mono text-muted-foreground">
              {selectedTrade.symbol} — {selectedTrade.direction}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Timeframe selector */}
          <ToggleGroup
            type="single"
            value={timeframe}
            onValueChange={(v) => v && setTimeframe(v)}
            className="gap-0.5"
          >
            {TIMEFRAMES.map((tf) => (
              <ToggleGroupItem
                key={tf.value}
                value={tf.value}
                className={cn(
                  "h-7 px-2.5 text-[11px] font-mono font-semibold",
                  timeframe === tf.value
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {tf.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          {/* Divider */}
          <div className="w-px h-5 bg-border" />

          {/* Overlay toggles */}
          {OVERLAY_TOGGLES.map((ot) => (
            <button
              key={ot.key}
              onClick={() => toggleOverlay(ot.key)}
              className={cn(
                "h-7 px-2 rounded text-[10px] font-bold uppercase tracking-wide transition-all flex items-center gap-1",
                overlays[ot.key]
                  ? "bg-opacity-15 text-opacity-100"
                  : "text-muted-foreground/40 hover:text-muted-foreground"
              )}
              style={{
                backgroundColor: overlays[ot.key] ? `${ot.color}20` : undefined,
                color: overlays[ot.key] ? ot.color : undefined,
              }}
            >
              <ot.icon className="w-3 h-3" />
              {ot.label}
            </button>
          ))}

          {/* Divider */}
          <div className="w-px h-5 bg-border" />

          {/* Expand/collapse details */}
          <button
            onClick={() => setDetailsExpanded(!detailsExpanded)}
            className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            title={detailsExpanded ? "Collapse details" : "Expand details"}
          >
            {detailsExpanded ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        <TradeReplaySidebar
          trades={trades}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        {/* Chart + Details */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Chart area */}
          <div className={cn("flex-1 min-h-0 relative", !detailsExpanded && "flex-[3]")}>
            {candlesLoading ? (
              <div className="h-full flex items-center justify-center text-muted-foreground">
                <div className="flex flex-col items-center gap-2">
                  <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  <span className="text-xs">Loading chart data...</span>
                </div>
              </div>
            ) : chartCandles.length === 0 ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                {selectedTrade ? "No candle data available" : "Select a trade to view chart"}
              </div>
            ) : (
              <TradeReplayChart
                candles={chartCandles}
                markers={markers}
                zones={zones}
                levels={levels}
                overlayToggles={overlays}
              />
            )}

            {/* Floating trade summary */}
            {selectedTrade && chartCandles.length > 0 && (
              <div className="absolute top-3 left-3 bg-card/90 backdrop-blur-sm border border-border rounded-lg p-2.5 shadow-lg">
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={cn(
                      "text-[10px] font-bold px-2 py-0.5 rounded",
                      selectedTrade.direction === "BUY"
                        ? "text-green-400 bg-green-400/15"
                        : "text-red-400 bg-red-400/15"
                    )}
                  >
                    {selectedTrade.direction}
                  </span>
                  <span className="font-mono text-xs font-semibold">
                    {selectedTrade.symbol}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
                  <span className="text-muted-foreground">Entry</span>
                  <span className="font-mono text-right">{selectedTrade.entry_price.toFixed(5)}</span>
                  <span className="text-muted-foreground">SL</span>
                  <span className="font-mono text-right text-red-400">{selectedTrade.stop_loss ? selectedTrade.stop_loss.toFixed(5) : "N/A"}</span>
                  <span className="text-muted-foreground">TP</span>
                  <span className="font-mono text-right text-green-400">{selectedTrade.take_profit ? selectedTrade.take_profit.toFixed(5) : "N/A"}</span>
                  {selectedTrade.pnl_pips !== undefined && (
                    <>
                      <span className="text-muted-foreground">P&L</span>
                      <span
                        className={cn(
                          "font-mono text-right font-semibold",
                          (selectedTrade.pnl_pips ?? 0) >= 0 ? "text-green-400" : "text-red-400"
                        )}
                      >
                        {(selectedTrade.pnl_pips ?? 0) >= 0 ? "+" : ""}
                        {selectedTrade.pnl_pips?.toFixed(1)} pips
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Floating legend */}
            {selectedTrade && chartCandles.length > 0 && (
              <div className="absolute top-3 right-3 bg-card/90 backdrop-blur-sm border border-border rounded-lg p-2 shadow-lg">
                <div className="space-y-0.5 text-[9px]">
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-0.5 bg-green-500" />
                    <span className="text-muted-foreground">Entry / TP</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-0.5 bg-red-500 border-dashed" style={{ borderTop: "1px dashed #ef4444" }} />
                    <span className="text-muted-foreground">Original SL</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-0.5 bg-amber-500" />
                    <span className="text-muted-foreground">Current SL</span>
                  </div>
                  {overlays.ob && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-2 rounded-sm" style={{ background: "rgba(59,130,246,0.3)" }} />
                      <span className="text-muted-foreground">Order Block</span>
                    </div>
                  )}
                  {overlays.fvg && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-2 rounded-sm" style={{ background: "rgba(168,85,247,0.3)" }} />
                      <span className="text-muted-foreground">FVG</span>
                    </div>
                  )}
                  {overlays.sr && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-0.5 bg-amber-500" style={{ borderTop: "1px dotted #f59e0b" }} />
                      <span className="text-muted-foreground">S/R Level</span>
                    </div>
                  )}
                  {overlays.liquidity && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-0.5 bg-cyan-500" />
                      <span className="text-muted-foreground">Liquidity</span>
                    </div>
                  )}
                  {overlays.breaker && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-2 rounded-sm" style={{ background: "rgba(236,72,153,0.3)" }} />
                      <span className="text-muted-foreground">Breaker</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Details panel */}
          {detailsExpanded && (
            <div className="h-[220px] shrink-0 border-t border-border bg-card/30">
              <TradeReplayDetails trade={selectedTrade} />
            </div>
          )}
        </div>
      </div>
    </div>
    </AppShell>
  );
}

/* ─── helpers ─── */
function parseSignalReason(raw: any): any {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}
