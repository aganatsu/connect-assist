/**
 * SMCChart — Consolidated Lightweight Charts component for all SMC overlays.
 *
 * Layers: Impulse Zone, Order Blocks, FVGs, Breakers, Swing Points,
 * Liquidity Pools, Fibs, HTF POIs, Trade Entry/SL/TP, Support/Resistance.
 *
 * Uses v4 API (addCandlestickSeries) for stability.
 * Proper cleanup: stores all price line refs and removes them on re-render.
 */

import { useEffect, useRef, useState, useMemo, useCallback, memo } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
} from "lightweight-charts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChartCandle {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface ChartOrderBlock {
  high: number;
  low: number;
  datetime?: string;
  direction: "bullish" | "bearish";
  state?: string;
  timeframe?: string;
}

export interface ChartFVG {
  high: number;
  low: number;
  datetime?: string;
  direction: "bullish" | "bearish";
  state?: string;
  fillPercent?: number;
  timeframe?: string;
}

export interface ChartBreakerBlock {
  high: number;
  low: number;
  datetime?: string;
  direction: string;
  state?: string;
  timeframe?: string;
}

export interface ChartSwingPoint {
  price: number;
  index?: number;
  type: "high" | "low";
  datetime?: string;
  state?: string;
}

export interface ChartLiquidityPool {
  price: number;
  high?: number;
  low?: number;
  type?: string;
  direction?: string;
  strength?: number;
  swept?: boolean;
  state?: string;
}

export interface ChartFibLevel {
  level: number;
  price: number;
  label: string;
}

export interface ChartHTFPOI {
  timeframe: string;
  type: string;
  high: number;
  low: number;
  direction: string;
}

export interface ChartTrade {
  entryPrice: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  takeProfits?: number[];
  direction: "long" | "short";
  label?: string;
  size?: number;
}

export interface ChartImpulseZone {
  impulse: {
    high: number;
    low: number;
    direction: "bullish" | "bearish";
  };
  bestZone: {
    type: "ob" | "fvg";
    high: number;
    low: number;
    fibLevel: number;
    fibDepth: number;
    totalScore: number;
    refinedEntry: number | null;
    refinedSL: number | null;
    priceAtZone: boolean;
    distanceToZone: number;
  } | null;
  selectedTF: "1H" | "4H" | null;
  hasZone: boolean;
}

export interface SMCOverlays {
  orderBlocks?: ChartOrderBlock[];
  fvgs?: ChartFVG[];
  breakerBlocks?: ChartBreakerBlock[];
  swingPoints?: ChartSwingPoint[];
  liquidityPools?: ChartLiquidityPool[];
  fibLevels?: ChartFibLevel[];
  fiftyPercentLevel?: number;
  htfPOIs?: ChartHTFPOI[];
  trades?: ChartTrade[];
  keySupport?: number[];
  keyResistance?: number[];
  impulseZone?: ChartImpulseZone;
}

export type OverlayLayer =
  | "impulseZone"
  | "orderBlocks"
  | "fvgs"
  | "breakers"
  | "swingPoints"
  | "liquidity"
  | "fibs"
  | "htfPOIs"
  | "trades"
  | "support"
  | "resistance";

interface Props {
  candles: ChartCandle[];
  overlays?: SMCOverlays;
  loading?: boolean;
  symbol?: string;
  defaultLayers?: OverlayLayer[];
  hideToolbar?: boolean;
  compact?: boolean;
}

// ─── Color Constants ────────────────────────────────────────────────────────

const COLORS = {
  bg: "#0a0e17",
  grid: "rgba(42,49,68,0.3)",
  crosshair: "rgba(6,182,212,0.3)",
  bullCandle: "#22c55e",
  bearCandle: "#ef4444",
  // Impulse Zone
  impulseZoneBull: "rgba(6,182,212,0.08)",
  impulseZoneBear: "rgba(239,68,68,0.08)",
  impulseEntryBull: "rgba(6,182,212,0.25)",
  impulseEntryBear: "rgba(239,68,68,0.20)",
  impulseEntryBorder: "#06b6d4",
  // Order Blocks
  bullOB: "rgba(6,182,212,0.5)",
  bearOB: "rgba(239,68,68,0.5)",
  bullOBFill: "rgba(6,182,212,0.12)",
  bearOBFill: "rgba(239,68,68,0.12)",
  // FVGs
  bullFVG: "rgba(34,197,94,0.45)",
  bearFVG: "rgba(239,68,68,0.40)",
  // Breakers
  bullBreaker: "rgba(236,72,153,0.5)",
  bearBreaker: "rgba(245,158,11,0.5)",
  // Fibs
  fib50: "#f59e0b",
  fibKey: "rgba(6,182,212,0.7)",
  fibMinor: "rgba(6,182,212,0.25)",
  // Levels
  support: "rgba(34,197,94,0.5)",
  resistance: "rgba(239,68,68,0.5)",
  liquidity: "rgba(168,85,247,0.6)",
  // HTF POIs
  htfD: "rgba(34,197,94,0.6)",
  htf4H: "rgba(59,130,246,0.5)",
  htf1H: "rgba(168,85,247,0.4)",
  // Trade
  entry: "#06b6d4",
  sl: "#ef4444",
  tp: "#22c55e",
};

// ─── Layer Definitions ──────────────────────────────────────────────────────

const LAYER_DEFS: { id: OverlayLayer; label: string; color: string }[] = [
  { id: "impulseZone", label: "IZ", color: "#06b6d4" },
  { id: "orderBlocks", label: "OB", color: "#06b6d4" },
  { id: "fvgs", label: "FVG", color: "#22c55e" },
  { id: "breakers", label: "BRK", color: "#ec4899" },
  { id: "swingPoints", label: "SP", color: "#f59e0b" },
  { id: "liquidity", label: "LIQ", color: "#a855f7" },
  { id: "fibs", label: "FIB", color: "#f59e0b" },
  { id: "htfPOIs", label: "HTF", color: "#22c55e" },
  { id: "trades", label: "TRADE", color: "#06b6d4" },
  { id: "support", label: "S", color: "#22c55e" },
  { id: "resistance", label: "R", color: "#ef4444" },
];

// ─── Component ──────────────────────────────────────────────────────────────

function SMCChart({ candles, overlays, loading, symbol, defaultLayers, hideToolbar, compact }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceLinesRef = useRef<any[]>([]);

  const allLayers: OverlayLayer[] = LAYER_DEFS.map((l) => l.id);
  const [visibleLayers, setVisibleLayers] = useState<Set<OverlayLayer>>(
    new Set(defaultLayers ?? allLayers)
  );

  const toggleLayer = useCallback((layer: OverlayLayer) => {
    setVisibleLayers((prev) => {
      const next = new Set(prev);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
  }, []);

  // Convert candles to chart format
  const chartData: CandlestickData<Time>[] = useMemo(() => {
    if (!candles?.length) return [];
    const seen = new Set<number>();
    return candles
      .map((c) => {
        // Parse datetime to unix timestamp for proper time handling
        const ts = Math.floor(new Date(c.datetime).getTime() / 1000);
        return { time: ts as Time, open: c.open, high: c.high, low: c.low, close: c.close };
      })
      .filter((d) => {
        const key = d.time as number;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (a.time as number) - (b.time as number));
  }, [candles]);

  // Initialize chart once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: COLORS.bg },
        textColor: "#64748b",
        fontFamily: "'JetBrains Mono', 'IBM Plex Mono', monospace",
        fontSize: compact ? 10 : 11,
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: COLORS.crosshair, width: 1, style: LineStyle.Dashed },
        horzLine: { color: COLORS.crosshair, width: 1, style: LineStyle.Dashed },
      },
      rightPriceScale: {
        borderColor: "rgba(42,49,68,0.6)",
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: "rgba(42,49,68,0.6)",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: true,
      handleScale: true,
    });

    const series = chart.addCandlestickSeries({
      upColor: COLORS.bullCandle,
      downColor: COLORS.bearCandle,
      borderUpColor: COLORS.bullCandle,
      borderDownColor: COLORS.bearCandle,
      wickUpColor: COLORS.bullCandle,
      wickDownColor: COLORS.bearCandle,
    });

    chartRef.current = chart;
    candleSeriesRef.current = series;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        chart.applyOptions({ width, height });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, [compact]);

  // Update candle data
  useEffect(() => {
    if (!candleSeriesRef.current || !chartData.length) return;
    candleSeriesRef.current.setData(chartData);
    chartRef.current?.timeScale().fitContent();
  }, [chartData]);

  // Update overlays (price lines + markers)
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    // Cleanup previous lines
    for (const line of priceLinesRef.current) {
      try { series.removePriceLine(line); } catch {}
    }
    priceLinesRef.current = [];

    if (!overlays) return;

    const addLine = (opts: any) => {
      try {
        const line = series.createPriceLine(opts);
        priceLinesRef.current.push(line);
      } catch {}
    };

    // ─── Impulse Zone ─────────────────────────────────────────────────
    if (visibleLayers.has("impulseZone") && overlays.impulseZone?.hasZone) {
      const iz = overlays.impulseZone;
      const isBull = iz.impulse.direction === "bullish";

      // Full impulse leg boundaries (subtle)
      addLine({
        price: iz.impulse.high,
        color: isBull ? "rgba(6,182,212,0.3)" : "rgba(239,68,68,0.25)",
        lineWidth: 1,
        lineStyle: LineStyle.LargeDashed,
        axisLabelVisible: false,
        title: "",
      });
      addLine({
        price: iz.impulse.low,
        color: isBull ? "rgba(6,182,212,0.3)" : "rgba(239,68,68,0.25)",
        lineWidth: 1,
        lineStyle: LineStyle.LargeDashed,
        axisLabelVisible: false,
        title: "",
      });

      // Entry zone (the POI inside the impulse) — prominent
      if (iz.bestZone) {
        const fibLabel = `${(iz.bestZone.fibLevel * 100).toFixed(0)}%`;
        const tfLabel = iz.selectedTF ?? "";
        const typeLabel = iz.bestZone.type.toUpperCase();
        addLine({
          price: iz.bestZone.high,
          color: COLORS.impulseEntryBorder,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `${tfLabel} ${typeLabel} @ ${fibLabel}`,
        });
        addLine({
          price: iz.bestZone.low,
          color: COLORS.impulseEntryBorder,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: false,
          title: "",
        });

        // Refined entry line (if LTF refined)
        if (iz.bestZone.refinedEntry) {
          addLine({
            price: iz.bestZone.refinedEntry,
            color: "#06b6d4",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "Refined Entry",
          });
        }
        // Refined SL
        if (iz.bestZone.refinedSL) {
          addLine({
            price: iz.bestZone.refinedSL,
            color: COLORS.sl,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "Zone SL",
          });
        }
      }
    }

    // ─── Order Blocks ─────────────────────────────────────────────────
    if (visibleLayers.has("orderBlocks") && overlays.orderBlocks?.length) {
      for (const ob of overlays.orderBlocks.slice(0, 15)) {
        const isBull = ob.direction === "bullish";
        const color = isBull ? COLORS.bullOB : COLORS.bearOB;
        const tf = ob.timeframe ? ` ${ob.timeframe}` : "";
        addLine({
          price: ob.high,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: false,
          title: `OB${tf}`,
        });
        addLine({
          price: ob.low,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: false,
          title: "",
        });
      }
    }

    // ─── FVGs ─────────────────────────────────────────────────────────
    if (visibleLayers.has("fvgs") && overlays.fvgs?.length) {
      for (const fvg of overlays.fvgs.slice(0, 15)) {
        const isBull = fvg.direction === "bullish";
        const color = isBull ? COLORS.bullFVG : COLORS.bearFVG;
        addLine({
          price: fvg.high,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: "FVG",
        });
        addLine({
          price: fvg.low,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: "",
        });
      }
    }

    // ─── Breaker Blocks ───────────────────────────────────────────────
    if (visibleLayers.has("breakers") && overlays.breakerBlocks?.length) {
      for (const bb of overlays.breakerBlocks.slice(0, 8)) {
        const isBull = bb.direction.includes("bullish");
        const color = isBull ? COLORS.bullBreaker : COLORS.bearBreaker;
        addLine({
          price: (bb.high + bb.low) / 2,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.LargeDashed,
          axisLabelVisible: false,
          title: `BRK ${bb.timeframe ?? ""}`,
        });
      }
    }

    // ─── Liquidity Pools ──────────────────────────────────────────────
    if (visibleLayers.has("liquidity") && overlays.liquidityPools?.length) {
      for (const lp of overlays.liquidityPools.slice(0, 8)) {
        if (lp.swept) continue;
        addLine({
          price: lp.price,
          color: COLORS.liquidity,
          lineWidth: 2,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `$$$ ${lp.strength ? `(${lp.strength})` : ""}`,
        });
      }
    }

    // ─── Fibonacci Levels ─────────────────────────────────────────────
    if (visibleLayers.has("fibs")) {
      if (overlays.fiftyPercentLevel) {
        addLine({
          price: overlays.fiftyPercentLevel,
          color: COLORS.fib50,
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "50% EQ",
        });
      }
      if (overlays.fibLevels?.length) {
        for (const fib of overlays.fibLevels) {
          const isFifty = fib.label === "50%";
          const isKey = fib.label === "61.8%" || fib.label === "38.2%" || fib.label === "78.6%";
          addLine({
            price: fib.price,
            color: isFifty ? COLORS.fib50 : isKey ? COLORS.fibKey : COLORS.fibMinor,
            lineWidth: isFifty ? 2 : 1,
            lineStyle: isFifty ? LineStyle.Solid : LineStyle.Dashed,
            axisLabelVisible: isFifty || isKey,
            title: fib.label,
          });
        }
      }
    }

    // ─── HTF POIs ─────────────────────────────────────────────────────
    if (visibleLayers.has("htfPOIs") && overlays.htfPOIs?.length) {
      for (const poi of overlays.htfPOIs.slice(0, 12)) {
        const colorMap: Record<string, string> = { D: COLORS.htfD, "4H": COLORS.htf4H, "1H": COLORS.htf1H };
        const color = colorMap[poi.timeframe] ?? COLORS.htf1H;
        addLine({
          price: (poi.high + poi.low) / 2,
          color,
          lineWidth: 2,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `${poi.timeframe} ${poi.type.toUpperCase()}`,
        });
      }
    }

    // ─── Support ──────────────────────────────────────────────────────
    if (visibleLayers.has("support") && overlays.keySupport?.length) {
      for (const level of overlays.keySupport.slice(0, 4)) {
        addLine({
          price: level,
          color: COLORS.support,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: "S",
        });
      }
    }

    // ─── Resistance ───────────────────────────────────────────────────
    if (visibleLayers.has("resistance") && overlays.keyResistance?.length) {
      for (const level of overlays.keyResistance.slice(0, 4)) {
        addLine({
          price: level,
          color: COLORS.resistance,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: "R",
        });
      }
    }

    // ─── Trade Overlays (Entry/SL/TP) ─────────────────────────────────
    if (visibleLayers.has("trades") && overlays.trades?.length) {
      for (const trade of overlays.trades) {
        const isLong = trade.direction === "long";
        addLine({
          price: trade.entryPrice,
          color: COLORS.entry,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `${isLong ? "BUY" : "SELL"} ${trade.label ?? ""}`.trim(),
        });
        if (trade.stopLoss != null) {
          addLine({
            price: trade.stopLoss,
            color: COLORS.sl,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "SL",
          });
        }
        if (trade.takeProfit != null) {
          addLine({
            price: trade.takeProfit,
            color: COLORS.tp,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "TP",
          });
        }
        // Multiple TPs
        if (trade.takeProfits?.length) {
          trade.takeProfits.forEach((tp, i) => {
            addLine({
              price: tp,
              color: COLORS.tp,
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: `TP${i + 1}`,
            });
          });
        }
      }
    }

    // ─── Swing Point Markers ──────────────────────────────────────────
    if (visibleLayers.has("swingPoints") && overlays.swingPoints?.length && chartData.length > 0) {
      const markers = overlays.swingPoints
        .filter((sp) => sp.index != null && sp.index! >= 0 && sp.index! < chartData.length)
        .map((sp) => ({
          time: chartData[sp.index!].time,
          position: sp.type === "high" ? ("aboveBar" as const) : ("belowBar" as const),
          color: sp.type === "high" ? "#f59e0b" : "#f59e0b",
          shape: "diamond" as const,
          text: sp.type === "high" ? "HH" : "LL",
        }))
        .sort((a, b) => (a.time as number) - (b.time as number));

      if (markers.length > 0) {
        try { series.setMarkers(markers as any); } catch {}
      }
    } else {
      try { series.setMarkers([]); } catch {}
    }

    return () => {
      for (const line of priceLinesRef.current) {
        try { series.removePriceLine(line); } catch {}
      }
      priceLinesRef.current = [];
    };
  }, [overlays, visibleLayers, chartData]);

  // Check which layers have data
  const layerHasData = useMemo(() => {
    if (!overlays) return new Set<OverlayLayer>();
    const s = new Set<OverlayLayer>();
    if (overlays.impulseZone?.hasZone) s.add("impulseZone");
    if (overlays.orderBlocks?.length) s.add("orderBlocks");
    if (overlays.fvgs?.length) s.add("fvgs");
    if (overlays.breakerBlocks?.length) s.add("breakers");
    if (overlays.swingPoints?.length) s.add("swingPoints");
    if (overlays.liquidityPools?.length) s.add("liquidity");
    if (overlays.fibLevels?.length || overlays.fiftyPercentLevel) s.add("fibs");
    if (overlays.htfPOIs?.length) s.add("htfPOIs");
    if (overlays.trades?.length) s.add("trades");
    if (overlays.keySupport?.length) s.add("support");
    if (overlays.keyResistance?.length) s.add("resistance");
    return s;
  }, [overlays]);

  return (
    <div className="relative w-full h-full flex flex-col" style={{ backgroundColor: COLORS.bg }}>
      {/* Layer Toggle Toolbar */}
      {!hideToolbar && (
        <div
          className="flex items-center gap-1 px-3 py-1.5 border-b border-white/5 flex-shrink-0 overflow-x-auto"
          style={{ backgroundColor: COLORS.bg }}
        >
          {symbol && (
            <span className="text-xs font-mono font-bold text-cyan-400 mr-3 flex-shrink-0">
              {symbol}
            </span>
          )}
          {LAYER_DEFS.map((layer) => {
            const hasData = layerHasData.has(layer.id);
            if (!hasData) return null;
            const active = visibleLayers.has(layer.id);

            return (
              <button
                key={layer.id}
                onClick={() => toggleLayer(layer.id)}
                className={`px-2 py-0.5 text-[10px] font-mono font-bold rounded-full transition-all flex-shrink-0 border ${
                  active
                    ? "border-current bg-white/5"
                    : "border-transparent text-gray-600 hover:text-gray-400"
                }`}
                style={{ color: active ? layer.color : undefined }}
                title={`Toggle ${layer.label}`}
              >
                {layer.label}
              </button>
            );
          })}

          {/* R:R badge when trade is visible */}
          {visibleLayers.has("trades") && overlays?.trades?.[0] && (() => {
            const t = overlays.trades![0];
            if (!t.stopLoss || !t.takeProfit) return null;
            const risk = Math.abs(t.entryPrice - t.stopLoss);
            const reward = Math.abs(t.takeProfit - t.entryPrice);
            if (risk === 0) return null;
            const rr = (reward / risk).toFixed(1);
            return (
              <span className="ml-auto text-[10px] font-mono font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full flex-shrink-0">
                {rr}R
              </span>
            );
          })()}
        </div>
      )}

      {/* Chart Container */}
      <div ref={containerRef} className="flex-1 min-h-0" />

      {/* Loading overlay */}
      {loading && (
        <div
          className="absolute inset-0 flex items-center justify-center z-10"
          style={{ backgroundColor: "rgba(10,14,23,0.85)" }}
        >
          <div className="flex items-center gap-3">
            <div className="w-1.5 h-8 bg-cyan-500 animate-pulse" />
            <div className="w-1.5 h-8 bg-cyan-500 animate-pulse" style={{ animationDelay: "0.15s" }} />
            <div className="w-1.5 h-8 bg-cyan-500 animate-pulse" style={{ animationDelay: "0.3s" }} />
            <span className="text-xs font-mono text-gray-500 ml-3 uppercase tracking-wider">
              Loading chart
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(SMCChart);
