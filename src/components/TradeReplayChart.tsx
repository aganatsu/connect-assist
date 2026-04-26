import { useEffect, useRef, useCallback, memo } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
  CrosshairMode,
  LineStyle,
} from "lightweight-charts";

/* ─── types ─── */
export interface TradeMarker {
  time: number; // unix seconds
  type: "entry" | "exit" | "be" | "trail";
  label: string;
  price: number;
}

export interface ZoneOverlay {
  type: "ob" | "fvg" | "sr" | "liquidity" | "breaker";
  high: number;
  low: number;
  label: string;
  state?: string; // lifecycle state
}

export interface TradeLevels {
  entry: number;
  originalSL: number;
  currentSL: number | null;
  takeProfit: number;
  direction: "BUY" | "SELL";
}

interface Props {
  candles: CandlestickData<Time>[];
  markers?: TradeMarker[];
  zones?: ZoneOverlay[];
  levels?: TradeLevels | null;
  overlayToggles?: Record<string, boolean>;
  className?: string;
}

/* ─── color map ─── */
const ZONE_COLORS: Record<string, { line: string; bg: string }> = {
  ob:        { line: "#3b82f6", bg: "rgba(59,130,246,0.12)" },
  fvg:       { line: "#a855f7", bg: "rgba(168,85,247,0.12)" },
  sr:        { line: "#f59e0b", bg: "rgba(245,158,11,0.08)" },
  liquidity: { line: "#06b6d4", bg: "rgba(6,182,212,0.10)" },
  breaker:   { line: "#ec4899", bg: "rgba(236,72,153,0.10)" },
};

function TradeReplayChart({ candles, markers, zones, levels, overlayToggles, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  /* ─── create chart once ─── */
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: "solid" as const, color: "#0a0e17" },
        textColor: "#64748b",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(42,49,68,0.4)" },
        horzLines: { color: "rgba(42,49,68,0.4)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(6,182,212,0.3)", width: 1, style: LineStyle.Dashed },
        horzLine: { color: "rgba(6,182,212,0.3)", width: 1, style: LineStyle.Dashed },
      },
      rightPriceScale: {
        borderColor: "#2a3144",
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: "#2a3144",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: true,
      handleScale: true,
    });

    const series = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
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
  }, []);

  /* ─── update candle data ─── */
  useEffect(() => {
    if (!candleSeriesRef.current || !candles.length) return;
    candleSeriesRef.current.setData(candles);
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  /* ─── update markers ─── */
  useEffect(() => {
    if (!candleSeriesRef.current || !markers?.length) return;
    const sorted = [...markers].sort((a, b) => a.time - b.time);
    candleSeriesRef.current.setMarkers(
      sorted.map((m) => ({
        time: m.time as Time,
        position: m.type === "entry"
          ? "belowBar" as const
          : m.type === "exit"
          ? "aboveBar" as const
          : "inBar" as const,
        color:
          m.type === "entry" ? "#22c55e" :
          m.type === "exit" ? "#ef4444" :
          m.type === "be" ? "#3b82f6" : "#f59e0b",
        shape:
          m.type === "entry" ? "arrowUp" as const :
          m.type === "exit" ? "arrowDown" as const :
          "circle" as const,
        text: m.label,
      }))
    );
  }, [markers]);

  /* ─── update trade levels (price lines) ─── */
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    // Remove all existing price lines first
    // lightweight-charts doesn't have removeAllPriceLines, so we recreate
    // by tracking them. For simplicity, we'll use a fresh approach each time.

    // Clear existing lines by removing series and re-adding data
    // Actually, we can use createPriceLine and store refs
    const lines: ReturnType<typeof series.createPriceLine>[] = [];

    if (levels) {
      // Entry
      lines.push(
        series.createPriceLine({
          price: levels.entry,
          color: "#22c55e",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: "Entry",
        })
      );

      // Original SL (only if we have a real value)
      if (levels.originalSL && levels.originalSL > 0) {
        lines.push(
          series.createPriceLine({
            price: levels.originalSL,
            color: "#ef4444",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "Original SL",
          })
        );
      }

      // Current SL (if trailed)
      if (levels.currentSL && levels.currentSL !== levels.originalSL) {
        lines.push(
          series.createPriceLine({
            price: levels.currentSL,
            color: "#f59e0b",
            lineWidth: 2,
            lineStyle: LineStyle.LargeDashed,
            axisLabelVisible: true,
            title: "Current SL",
          })
        );
      }

      // Take Profit (only if we have a real value)
      if (levels.takeProfit && levels.takeProfit > 0) {
        lines.push(
          series.createPriceLine({
            price: levels.takeProfit,
            color: "#22c55e",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "TP",
          })
        );
      }
    }

    // Zone overlays as price lines (pairs of lines for high/low)
    if (zones?.length) {
      for (const zone of zones) {
        const toggle = overlayToggles?.[zone.type];
        if (toggle === false) continue;
        const colors = ZONE_COLORS[zone.type] || ZONE_COLORS.ob;
        lines.push(
          series.createPriceLine({
            price: zone.high,
            color: colors.line,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: false,
            title: "",
          })
        );
        lines.push(
          series.createPriceLine({
            price: zone.low,
            color: colors.line,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: false,
            title: "",
          })
        );
      }
    }

    return () => {
      for (const line of lines) {
        try { series.removePriceLine(line); } catch {}
      }
    };
  }, [levels, zones, overlayToggles]);

  return (
    <div ref={containerRef} className={`w-full h-full ${className || ""}`} />
  );
}

export default memo(TradeReplayChart);
