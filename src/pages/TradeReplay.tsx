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
  Target,
  Hash,
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
  { key: "fib", label: "Fib", icon: Hash, color: "#fbbf24" },
  { key: "bslssl", label: "BSL/SSL", icon: Target, color: "#d946ef" },
];

export default function TradeReplay() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState("4h");
  const [overlays, setOverlays] = useState<Record<string, boolean>>({
    ob: true, fvg: true, sr: true, liquidity: true, breaker: true, fib: true, bslssl: true,
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
        const snapshot = s.analysis_snapshot as any;
        items.push({
          position_id: s.id || `staged-${s.symbol}`,
          symbol: s.symbol,
          direction: s.direction?.toUpperCase() === "LONG" || s.direction?.toUpperCase() === "BUY" ? "BUY" : "SELL",
          entry_price: Number(s.entry_price) || 0,
          stop_loss: s.sl_level != null ? Number(s.sl_level) : null,
          take_profit: s.tp_level != null ? Number(s.tp_level) : null,
          status: "staged",
          opened_at: s.staged_at || s.created_at,
          signal_reason: {
            score: Number(s.current_score ?? s.initial_score ?? 0),
            summary: snapshot?.summary || s.promotion_reason || "",
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
          ? Math.floor(new Date(c.datetime.replace(" ", "T") + "Z").getTime() / 1000)
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
    if (!selectedTrade || !chartCandles.length) return [];
    const m: TradeMarker[] = [];

    // Helper: snap a unix-seconds timestamp to the nearest candle time
    const snapToCandle = (ts: number): number => {
      let best = chartCandles[0].time as number;
      let bestDiff = Math.abs(ts - best);
      for (const c of chartCandles) {
        const diff = Math.abs(ts - (c.time as number));
        if (diff < bestDiff) {
          bestDiff = diff;
          best = c.time as number;
        }
      }
      return best;
    };

    const entryTime = snapToCandle(Math.floor(new Date(selectedTrade.opened_at).getTime() / 1000));
    m.push({
      time: entryTime,
      type: "entry",
      label: `${selectedTrade.direction} @ ${selectedTrade.entry_price.toFixed(5)}`,
      price: selectedTrade.entry_price,
      direction: selectedTrade.direction,
    });
    if (selectedTrade.status === "closed" && selectedTrade.exit_price && selectedTrade.closed_at) {
      const exitTime = snapToCandle(Math.floor(new Date(selectedTrade.closed_at).getTime() / 1000));
      m.push({
        time: exitTime,
        type: "exit",
        label: `Exit @ ${selectedTrade.exit_price.toFixed(5)}`,
        price: selectedTrade.exit_price,
        direction: selectedTrade.direction,
      });
    }
    return m;
  }, [selectedTrade, chartCandles]);

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

  /* ─── Zone overlays from scan detail + signal_reason (entry-time data) ─── */
  const zones: ZoneOverlay[] = useMemo(() => {
    if (!selectedTrade) return [];
    const z: ZoneOverlay[] = [];

    // Priority 1: Use signal_reason (entry-time snapshot) for entity lifecycles
    const sr = selectedTrade.signal_reason || {};

    // Priority 2: Fall back to scan_logs analysis_snapshot (latest data)
    const logs = Array.isArray(scanLogs) ? scanLogs : (scanLogs?.logs ? (Array.isArray(scanLogs.logs) ? scanLogs.logs : []) : []);
    let scanDetail: any = null;
    for (const log of logs) {
      const details = log.details_json?.details || log.details_json || [];
      if (Array.isArray(details)) {
        const found = details.find((d: any) => d.pair === selectedTrade.symbol);
        if (found) { scanDetail = found; break; }
      }
    }

    const snap = scanDetail?.analysis_snapshot || {};

    // ── Order Blocks ──
    const obsSource = sr.entityLifecycles?.orderBlocks || snap.orderBlock?.zones || snap.orderBlocks || [];
    const obs = Array.isArray(obsSource) ? obsSource : [];
    for (const ob of obs) {
      const high = ob.high || ob.top || 0;
      const low = ob.low || ob.bottom || 0;
      if (!high && !low) continue;
      z.push({
        type: "ob",
        high,
        low,
        label: `OB ${ob.type || ob.direction || ""} [${ob.state || "active"}]`.trim(),
        state: ob.state || "active",
      });
    }

    // ── FVGs ──
    const fvgSource = sr.entityLifecycles?.fvgs || snap.fvg?.zones || snap.fvgs || [];
    const fvgs = Array.isArray(fvgSource) ? fvgSource : [];
    for (const fvg of fvgs) {
      const high = fvg.high || fvg.top || 0;
      const low = fvg.low || fvg.bottom || 0;
      if (!high && !low) continue;
      z.push({
        type: "fvg",
        high,
        low,
        label: `FVG ${fvg.type || fvg.direction || ""} [${fvg.state || "active"}]`.trim(),
        state: fvg.state || "active",
      });
    }

    // ── S/R levels ──
    const srSource = sr.structureIntel?.derivedSR || snap.structureIntel?.derivedSR || scanDetail?.structureIntel?.derivedSR || [];
    const srLevels = Array.isArray(srSource) ? srSource : [];
    for (const level of srLevels) {
      const price = level.price || level.level || 0;
      if (!price) continue;
      z.push({
        type: "sr",
        high: price,
        low: price,
        label: `S/R ${level.type || ""} ${level.touches ? `(${level.touches}x)` : ""}`.trim(),
        state: level.state || "active",
      });
    }

    // ── Liquidity pools ──
    const poolSource = sr.entityLifecycles?.liquidityPools || snap.liquiditySweep?.pools || snap.liquidityPools || [];
    const pools = Array.isArray(poolSource) ? poolSource : [];
    for (const pool of pools.slice(0, 10)) {
      const price = pool.level || pool.price || 0;
      if (!price) continue;
      z.push({
        type: "liquidity",
        high: price,
        low: price,
        label: `Liq ${pool.type || pool.direction || ""} [${pool.state || "active"}]`.trim(),
        state: pool.state || "active",
        strength: pool.strength,
      });
    }

    // ── Breaker blocks ──
    const brkSource = sr.entityLifecycles?.breakerBlocks || snap.breakerBlock?.zones || snap.breakerBlocks || [];
    const breakers = Array.isArray(brkSource) ? brkSource : [];
    for (const brk of breakers) {
      const high = brk.high || brk.top || 0;
      const low = brk.low || brk.bottom || 0;
      if (!high && !low) continue;
      z.push({
        type: "breaker",
        high,
        low,
        label: `BRK ${brk.type || ""} [${brk.state || "active"}]`.trim(),
        state: brk.state || "active",
      });
    }

    // ── BSL/SSL (Buy-Side / Sell-Side Liquidity) ──
    const bslSslSource = sr.entityLifecycles?.swingPoints || snap.swingPoints || snap.liquiditySweep?.pools || [];
    const bslSsl = Array.isArray(bslSslSource) ? bslSslSource : [];
    for (const pt of bslSsl) {
      const price = pt.level || pt.price || pt.high || 0;
      if (!price) continue;
      const isBuy = pt.type === "high" || pt.direction === "bullish" || pt.side === "buy";
      z.push({
        type: isBuy ? "bsl" : "ssl",
        high: price,
        low: price,
        label: `${isBuy ? "BSL" : "SSL"} ${pt.state === "swept" ? "[swept]" : ""}`.trim(),
        state: pt.state || "active",
        strength: pt.strength || pt.touches,
      });
    }

    // ── Fibonacci levels ──
    const fibSource = sr.fibLevels || snap.fibonacci?.levels || scanDetail?.fibLevels || [];
    const fibs = Array.isArray(fibSource) ? fibSource : [];
    for (const fib of fibs) {
      const price = fib.price || fib.level || 0;
      if (!price) continue;
      z.push({
        type: "fib",
        high: price,
        low: price,
        label: `Fib ${fib.ratio || fib.label || ""}`.trim(),
        state: "active",
      });
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
                overlayToggles={{
                  ...overlays,
                  // Map bslssl toggle to both bsl and ssl types in the chart
                  bsl: overlays.bslssl,
                  ssl: overlays.bslssl,
                }}
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
                        ? "text-profit bg-green-400/15"
                        : "text-loss bg-badge-loss"
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
                  <span className="font-mono text-right text-loss">{selectedTrade.stop_loss ? selectedTrade.stop_loss.toFixed(5) : "N/A"}</span>
                  <span className="text-muted-foreground">TP</span>
                  <span className="font-mono text-right text-profit">{selectedTrade.take_profit ? selectedTrade.take_profit.toFixed(5) : "N/A"}</span>
                  {selectedTrade.pnl_pips !== undefined && (
                    <>
                      <span className="text-muted-foreground">P&L</span>
                      <span
                        className={cn(
                          "font-mono text-right font-semibold",
                          (selectedTrade.pnl_pips ?? 0) >= 0 ? "text-profit" : "text-loss"
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
                    <div className="w-3 h-0.5 bg-success" />
                    <span className="text-muted-foreground">Entry / TP</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-0.5 bg-destructive border-dashed" style={{ borderTop: "1px dashed #ef4444" }} />
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
                  {overlays.fib && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-0.5" style={{ background: "#fbbf24" }} />
                      <span className="text-muted-foreground">Fibonacci</span>
                    </div>
                  )}
                  {overlays.bslssl && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-0.5" style={{ background: "#d946ef" }} />
                      <span className="text-muted-foreground">BSL/SSL</span>
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
