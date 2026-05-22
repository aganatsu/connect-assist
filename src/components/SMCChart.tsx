/**
 * SMCChart — Consolidated Lightweight Charts component for all SMC overlays.
 *
 * Layers: Impulse Zone, Order Blocks, FVGs, Breakers, Swing Points,
 * Liquidity Pools, Fibs, HTF POIs, Trade Entry/SL/TP, Support/Resistance,
 * BOS/CHoCH, Displacement Candles, Judas Swing, Session Boxes, Kill Zones.
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
import { useTheme } from "@/contexts/ThemeContext";

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
  startIndex?: number;
  endIndex?: number;
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

export interface ChartStructureBreak {
  index: number;
  type: "bullish" | "bearish";
  price: number;
  datetime?: string;
  level: number;
  significance?: "internal" | "external";
}

export interface ChartDisplacementCandle {
  index: number;
  direction: "bullish" | "bearish";
  bodyRatio?: number;
  rangeMultiple?: number;
}

export interface ChartJudasSwing {
  detected: boolean;
  type: "bullish" | "bearish" | null;
  confirmed: boolean;
  description: string;
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
  // New overlays
  bosLevels?: ChartStructureBreak[];
  chochLevels?: ChartStructureBreak[];
  displacementCandles?: ChartDisplacementCandle[];
  judasSwing?: ChartJudasSwing | null;
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
  | "resistance"
  | "bosChoch"
  | "displacement"
  | "judasSwing"
  | "sessions"
  | "killZones";

interface Props {
  candles: ChartCandle[];
  overlays?: SMCOverlays;
  loading?: boolean;
  symbol?: string;
  defaultLayers?: OverlayLayer[];
  hideToolbar?: boolean;
  compact?: boolean;
  /** Controlled visible layers — when provided, overrides internal state */
  visibleLayers?: Set<OverlayLayer>;
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
  // BOS/CHoCH
  bos: "rgba(56,189,248,0.7)", // sky-400
  choch: "rgba(251,146,60,0.8)", // orange-400
  // Displacement
  dispBull: "#34d399", // emerald-400
  dispBear: "#f87171", // red-400
  // Judas
  judas: "#fbbf24", // amber-400
  // Sessions
  sessionAsian: "rgba(99,102,241,0.06)", // indigo
  sessionLondon: "rgba(34,197,94,0.06)", // green
  sessionNY: "rgba(239,68,68,0.06)", // red
  // Kill Zones
  kzLondon: "rgba(236,72,153,0.08)", // pink
  kzNY: "rgba(236,72,153,0.08)",
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
  { id: "bosChoch", label: "BOS", color: "#38bdf8" },
  { id: "displacement", label: "DISP", color: "#34d399" },
  { id: "judasSwing", label: "JDS", color: "#fbbf24" },
  { id: "sessions", label: "SES", color: "#6366f1" },
  { id: "killZones", label: "KZ", color: "#ec4899" },
];

// ─── Session/KZ time helpers (NY local) ─────────────────────────────────────

function getNYHour(utcTimestamp: number): number {
  const d = new Date(utcTimestamp * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h === 24 ? m / 60 : h + m / 60;
}

type SessionName = "asian" | "london" | "newyork" | "offhours";
function getSession(nyHour: number): SessionName {
  if (nyHour >= 2 && nyHour < 8.5) return "london";
  if (nyHour >= 8.5 && nyHour < 16) return "newyork";
  if (nyHour >= 20 || nyHour < 2) return "asian";
  return "offhours";
}
function isKillZone(nyHour: number): "london" | "newyork" | null {
  if (nyHour >= 2 && nyHour < 5) return "london";
  if (nyHour >= 8.5 && nyHour < 12) return "newyork";
  return null;
}

// ─── Component ──────────────────────────────────────────────────────────────

function SMCChart({ candles, overlays, loading, symbol, defaultLayers, hideToolbar, compact, visibleLayers: visibleLayersProp }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceLinesRef = useRef<any[]>([]);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const segmentLineSeriesRef = useRef<any[]>([]);

  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";
  const themedBg = isLight ? "#ffffff" : COLORS.bg;
  const themedGrid = isLight ? "rgba(15,23,42,0.08)" : COLORS.grid;
  const themedText = isLight ? "#475569" : "#64748b";
  const themedBorder = isLight ? "rgba(15,23,42,0.15)" : "rgba(42,49,68,0.6)";
  const themedLoadingBg = isLight ? "rgba(255,255,255,0.85)" : "rgba(10,14,23,0.85)";

  const allLayers: OverlayLayer[] = LAYER_DEFS.map((l) => l.id);
  const [visibleLayersState, setVisibleLayers] = useState<Set<OverlayLayer>>(
    new Set(defaultLayers ?? allLayers)
  );
  const visibleLayers = visibleLayersProp ?? visibleLayersState;
  const [tooltipData, setTooltipData] = useState<{ x: number; y: number; text: string } | null>(null);

  const toggleLayer = useCallback((layer: OverlayLayer) => {
    if (visibleLayersProp) return; // controlled — no-op
    setVisibleLayers((prev) => {
      const next = new Set(prev);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
  }, [visibleLayersProp]);

  // Convert candles to chart format
  const chartData: CandlestickData<Time>[] = useMemo(() => {
    if (!candles?.length) return [];
    const seen = new Set<number>();
    return candles
      .map((c) => {
        const ts = Math.floor(
          new Date(typeof c.datetime === "string" ? c.datetime.replace(" ", "T") + "Z" : c.datetime).getTime() / 1000
        );
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
        background: { type: ColorType.Solid, color: themedBg },
        textColor: themedText,
        fontFamily: "'JetBrains Mono', 'IBM Plex Mono', monospace",
        fontSize: compact ? 10 : 11,
      },
      grid: {
        vertLines: { color: themedGrid },
        horzLines: { color: themedGrid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: COLORS.crosshair, width: 1, style: LineStyle.Dashed },
        horzLine: { color: COLORS.crosshair, width: 1, style: LineStyle.Dashed },
      },
      rightPriceScale: {
        borderColor: themedBorder,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: themedBorder,
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: true,
      handleScale: true,
    });

    // Determine price precision based on symbol
    const getMinMove = (sym?: string): number => {
      if (!sym) return 0.00001;
      const s = sym.toUpperCase();
      if (s.includes("JPY") || s.includes("HUF")) return 0.001;
      if (s.includes("XAU") || s.includes("GOLD")) return 0.01;
      if (s.includes("BTC") || s.includes("ETH")) return 0.01;
      if (s.includes("XAG") || s.includes("SILVER")) return 0.001;
      return 0.00001;
    };
    const getPrecision = (sym?: string): number => {
      if (!sym) return 5;
      const s = sym.toUpperCase();
      if (s.includes("JPY") || s.includes("HUF")) return 3;
      if (s.includes("XAU") || s.includes("GOLD")) return 2;
      if (s.includes("BTC") || s.includes("ETH")) return 2;
      if (s.includes("XAG") || s.includes("SILVER")) return 3;
      return 5;
    };

    const series = chart.addCandlestickSeries({
      upColor: COLORS.bullCandle,
      downColor: COLORS.bearCandle,
      borderUpColor: COLORS.bullCandle,
      borderDownColor: COLORS.bearCandle,
      wickUpColor: COLORS.bullCandle,
      wickDownColor: COLORS.bearCandle,
      priceFormat: {
        type: "price",
        precision: getPrecision(symbol),
        minMove: getMinMove(symbol),
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = series;

    // Crosshair move handler for tooltip
    chart.subscribeCrosshairMove((param) => {
      if (!param.point || !param.time || !param.seriesData) {
        setTooltipData(null);
        return;
      }
      // Show OHLC tooltip
      const data = param.seriesData.get(series) as any;
      if (!data) { setTooltipData(null); return; }
      const { open, high, low, close } = data;
      const prec = getPrecision(symbol);
      const text = `O: ${open.toFixed(prec)}  H: ${high.toFixed(prec)}  L: ${low.toFixed(prec)}  C: ${close.toFixed(prec)}`;
      setTooltipData({ x: param.point.x, y: param.point.y, text });
    });

    let disposed = false;
    const ro = new ResizeObserver((entries) => {
      if (disposed) return;
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        try { chart.applyOptions({ width, height }); } catch {}
      }
    });
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      for (const line of priceLinesRef.current) {
        try { series.removePriceLine(line); } catch {}
      }
      priceLinesRef.current = [];
      for (const s of segmentLineSeriesRef.current) {
        try { chart.removeSeries(s); } catch {}
      }
      segmentLineSeriesRef.current = [];
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, [compact, symbol]);

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

    // Cleanup previous line segments (Fibs + BOS/CHoCH)
    for (const s of segmentLineSeriesRef.current) {
      try { chartRef.current?.removeSeries(s); } catch {}
    }
    segmentLineSeriesRef.current = [];

    if (!overlays) return;

    const addLine = (opts: any) => {
      try {
        const line = series.createPriceLine(opts);
        priceLinesRef.current.push(line);
      } catch {}
    };

    const addSegmentLine = (level: number, startIdx: number, endIdx: number, color: string, width: 1 | 2, style: LineStyle, label?: string) => {
      const chart = chartRef.current;
      if (!chart || !chartData.length || endIdx < 0 || endIdx >= chartData.length) return;
      const sIdx = Math.min(Math.max(0, startIdx), chartData.length - 1);
      if (sIdx >= endIdx) return;
      try {
        const lineSeries = chart.addLineSeries({
          color,
          lineWidth: width,
          lineStyle: style,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        lineSeries.setData([
          { time: chartData[sIdx].time, value: level },
          { time: chartData[endIdx].time, value: level },
        ]);
        if (label) {
          try {
            lineSeries.setMarkers([
              {
                time: chartData[sIdx].time as any,
                position: "inBar",
                color,
                shape: "circle",
                size: 0,
                text: label,
              },
            ]);
          } catch {}
        }
        segmentLineSeriesRef.current.push(lineSeries);
      } catch {}
    };

    // ─── Impulse Zone ─────────────────────────────────────────────────
    if (visibleLayers.has("impulseZone") && overlays.impulseZone?.hasZone) {
      const iz = overlays.impulseZone;
      const isBull = iz.impulse.direction === "bullish";

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
      if (overlays.fiftyPercentLevel && !overlays.fibLevels?.some((fib) => fib.label === "50%")) {
        const endIdx = chartData.length - 1;
        addSegmentLine(overlays.fiftyPercentLevel, Math.max(0, endIdx - 60), endIdx, COLORS.fib50, 2, LineStyle.Dashed, "50%");
      }
      if (overlays.fibLevels?.length) {
        for (const fib of overlays.fibLevels) {
          const isFifty = fib.label === "50%";
          const isKey = fib.label === "61.8%" || fib.label === "38.2%" || fib.label === "78.6%";
          const endIdx = Math.min(fib.endIndex ?? chartData.length - 1, chartData.length - 1);
          const startIdx = fib.startIndex ?? Math.max(0, endIdx - 60);
          addSegmentLine(
            fib.price,
            startIdx,
            endIdx,
            isFifty ? COLORS.fib50 : isKey ? COLORS.fibKey : COLORS.fibMinor,
            isFifty ? 2 : 1,
            isFifty ? LineStyle.Solid : LineStyle.Dashed,
            fib.label,
          );
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

    // ─── BOS / CHoCH Lines ────────────────────────────────────────────
    if (visibleLayers.has("bosChoch")) {
      const chart = chartRef.current;
      if (chart && chartData.length > 0) {
        const findStartIdx = (level: number, endIdx: number): number => {
          const tol = Math.max(Math.abs(level) * 0.0005, 1e-6);
          if (overlays.swingPoints?.length) {
            for (let i = overlays.swingPoints.length - 1; i >= 0; i--) {
              const sp = overlays.swingPoints[i];
              if (sp.index == null || sp.index >= endIdx) continue;
              if (Math.abs(sp.price - level) <= tol) return sp.index;
            }
          }
          return Math.max(0, endIdx - 20);
        };
        if (overlays.bosLevels?.length) {
          for (const b of overlays.bosLevels.slice(-10)) {
            addSegmentLine(b.level, findStartIdx(b.level, b.index), b.index, COLORS.bos, 1, LineStyle.Dashed);
          }
        }
        if (overlays.chochLevels?.length) {
          for (const c of overlays.chochLevels.slice(-6)) {
            addSegmentLine(c.level, findStartIdx(c.level, c.index), c.index, COLORS.choch, 2, LineStyle.Solid);
          }
        }
      }
    }

    // ─── Trade Overlays (Entry/SL/TP + R:R visual) ────────────────────
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
          const risk = Math.abs(trade.entryPrice - trade.stopLoss);
          addLine({
            price: trade.stopLoss,
            color: COLORS.sl,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `SL (${risk.toFixed(5)})`,
          });
        }
        if (trade.takeProfit != null) {
          const reward = Math.abs(trade.takeProfit - trade.entryPrice);
          const risk = trade.stopLoss != null ? Math.abs(trade.entryPrice - trade.stopLoss) : 0;
          const rr = risk > 0 ? (reward / risk).toFixed(1) : "—";
          addLine({
            price: trade.takeProfit,
            color: COLORS.tp,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `TP (${rr}R)`,
          });
        }
        if (trade.takeProfits?.length) {
          trade.takeProfits.forEach((tp, i) => {
            const reward = Math.abs(tp - trade.entryPrice);
            const risk = trade.stopLoss != null ? Math.abs(trade.entryPrice - trade.stopLoss) : 0;
            const rr = risk > 0 ? (reward / risk).toFixed(1) : "—";
            addLine({
              price: tp,
              color: COLORS.tp,
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: `TP${i + 1} (${rr}R)`,
            });
          });
        }
      }
    }

    // ─── Markers (Swing Points + BOS/CHoCH + Displacement + Judas) ───
    const markers: any[] = [];

    // Swing Point Markers
    if (visibleLayers.has("swingPoints") && overlays.swingPoints?.length && chartData.length > 0) {
      for (const sp of overlays.swingPoints) {
        if (sp.index == null || sp.index < 0 || sp.index >= chartData.length) continue;
        markers.push({
          time: chartData[sp.index].time,
          position: sp.type === "high" ? "aboveBar" : "belowBar",
          color: "#f59e0b",
          shape: "diamond",
          text: sp.type === "high" ? "HH" : "LL",
        });
      }
    }

    // BOS/CHoCH break-point markers
    if (visibleLayers.has("bosChoch") && chartData.length > 0) {
      if (overlays.bosLevels?.length) {
        for (const b of overlays.bosLevels.slice(-10)) {
          if (b.index >= 0 && b.index < chartData.length) {
            markers.push({
              time: chartData[b.index].time,
              position: b.type === "bullish" ? "belowBar" : "aboveBar",
              color: COLORS.bos,
              shape: "arrowUp",
              text: b.significance === "external" ? "BOS★" : "BOS",
            });
          }
        }
      }
      if (overlays.chochLevels?.length) {
        for (const c of overlays.chochLevels.slice(-6)) {
          if (c.index >= 0 && c.index < chartData.length) {
            markers.push({
              time: chartData[c.index].time,
              position: c.type === "bullish" ? "belowBar" : "aboveBar",
              color: COLORS.choch,
              shape: "circle",
              text: "CHoCH",
            });
          }
        }
      }
    }

    // Displacement Candle Markers
    if (visibleLayers.has("displacement") && overlays.displacementCandles?.length && chartData.length > 0) {
      for (const d of overlays.displacementCandles) {
        if (d.index >= 0 && d.index < chartData.length) {
          markers.push({
            time: chartData[d.index].time,
            position: d.direction === "bullish" ? "belowBar" : "aboveBar",
            color: d.direction === "bullish" ? COLORS.dispBull : COLORS.dispBear,
            shape: "arrowUp",
            text: "DISP",
          });
        }
      }
    }

    // Judas Swing Marker (mark the most recent candle as the reversal point)
    if (visibleLayers.has("judasSwing") && overlays.judasSwing?.detected && chartData.length > 0) {
      const js = overlays.judasSwing;
      // Place on the last candle (current) since Judas is a live detection
      const lastIdx = chartData.length - 1;
      markers.push({
        time: chartData[lastIdx].time,
        position: js.type === "bullish" ? "belowBar" : "aboveBar",
        color: COLORS.judas,
        shape: "square",
        text: `JDS ${js.type === "bullish" ? "▲" : "▼"}${js.confirmed ? "✓" : ""}`,
      });
    }

    // Sort markers by time (required by lightweight-charts)
    markers.sort((a, b) => (a.time as number) - (b.time as number));

    // Deduplicate markers at same time+position (keep first)
    const seen = new Set<string>();
    const dedupedMarkers = markers.filter((m) => {
      const key = `${m.time}_${m.position}_${m.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    try { series.setMarkers(dedupedMarkers); } catch {}

    return () => {
      for (const line of priceLinesRef.current) {
        try { series.removePriceLine(line); } catch {}
      }
      priceLinesRef.current = [];
    };
  }, [overlays, visibleLayers, chartData]);

  // ─── Session / Kill Zone background shading via canvas overlay ─────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !chartData.length) return;
    if (!visibleLayers.has("sessions") && !visibleLayers.has("killZones")) return;

    // Use a custom canvas overlay for background shading
    const container = containerRef.current;
    if (!container) return;

    // Find or create the overlay canvas
    let canvas = container.querySelector(".smc-session-canvas") as HTMLCanvasElement | null;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "smc-session-canvas";
      canvas.style.position = "absolute";
      canvas.style.top = "0";
      canvas.style.left = "0";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.pointerEvents = "none";
      canvas.style.zIndex = "1";
      container.style.position = "relative";
      container.appendChild(canvas);
    }

    const draw = () => {
      if (!canvas || !chart) return;
      const rect = container!.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const timeScale = chart.timeScale();
      const priceScale = chart.priceScale("right");
      if (!timeScale || !priceScale) return;

      // Get visible range
      const visibleRange = timeScale.getVisibleLogicalRange();
      if (!visibleRange) return;

      const startIdx = Math.max(0, Math.floor(visibleRange.from));
      const endIdx = Math.min(chartData.length - 1, Math.ceil(visibleRange.to));

      // Draw session/KZ bands for each visible candle
      for (let i = startIdx; i <= endIdx; i++) {
        const bar = chartData[i];
        if (!bar) continue;
        const ts = bar.time as number;
        const nyH = getNYHour(ts);

        // Get x coordinate for this bar
        const x = timeScale.timeToCoordinate(bar.time);
        if (x === null) continue;

        // Get next bar x for width (or use a fixed width)
        const nextX = i < endIdx && chartData[i + 1]
          ? timeScale.timeToCoordinate(chartData[i + 1].time)
          : null;
        const barWidth = nextX !== null ? Math.max(2, (nextX as number) - (x as number)) : 8;

        let fillColor: string | null = null;

        if (visibleLayers.has("sessions")) {
          const sess = getSession(nyH);
          if (sess === "asian") fillColor = COLORS.sessionAsian;
          else if (sess === "london") fillColor = COLORS.sessionLondon;
          else if (sess === "newyork") fillColor = COLORS.sessionNY;
        }

        if (visibleLayers.has("killZones")) {
          const kz = isKillZone(nyH);
          if (kz === "london") fillColor = COLORS.kzLondon;
          else if (kz === "newyork") fillColor = COLORS.kzNY;
        }

        if (fillColor) {
          ctx.fillStyle = fillColor;
          ctx.fillRect(x as number, 0, barWidth, rect.height);
        }
      }
    };

    draw();

    // Redraw on visible range change
    const sub = chart.timeScale().subscribeVisibleLogicalRangeChange(draw);

    return () => {
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(draw); } catch {}
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    };
  }, [chartData, visibleLayers]);

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
    if (overlays.bosLevels?.length || overlays.chochLevels?.length) s.add("bosChoch");
    if (overlays.displacementCandles?.length) s.add("displacement");
    if (overlays.judasSwing?.detected) s.add("judasSwing");
    // Sessions and KZ are always "available" (time-based, not data-dependent)
    s.add("sessions");
    s.add("killZones");
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
      <div ref={containerRef} className="flex-1 min-h-0 relative" />

      {/* OHLC Tooltip */}
      {tooltipData && (
        <div
          ref={tooltipRef}
          className="absolute z-30 pointer-events-none px-2 py-1 rounded bg-card/90 border border-border/50 text-[10px] font-mono text-foreground shadow-lg backdrop-blur-sm"
          style={{ left: 12, top: 48 }}
        >
          {tooltipData.text}
        </div>
      )}

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
