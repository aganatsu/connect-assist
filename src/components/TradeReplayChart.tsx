import { useEffect, useRef, memo } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
  CrosshairMode,
  LineStyle,
  ColorType,
} from "lightweight-charts";

/* ─── types ─── */
export interface TradeMarker {
  time: number; // unix seconds
  type: "entry" | "exit" | "be" | "trail";
  label: string;
  price: number;
  direction?: "BUY" | "SELL";
}

export interface ZoneOverlay {
  type: "ob" | "fvg" | "sr" | "liquidity" | "breaker" | "bsl" | "ssl" | "fib";
  high: number;
  low: number;
  label: string;
  state?: string; // lifecycle state: active, tested, mitigating, broken, filled, swept
  strength?: number; // for liquidity/bsl/ssl
}

export interface TradeLevels {
  entry: number;
  originalSL: number | null;
  currentSL: number | null;
  takeProfit: number | null;
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
  ob:        { line: "#3b82f6", bg: "rgba(59,130,246,0.15)" },
  fvg:       { line: "#a855f7", bg: "rgba(168,85,247,0.15)" },
  sr:        { line: "#f59e0b", bg: "rgba(245,158,11,0.10)" },
  liquidity: { line: "#06b6d4", bg: "rgba(6,182,212,0.12)" },
  breaker:   { line: "#ec4899", bg: "rgba(236,72,153,0.12)" },
  bsl:       { line: "#d946ef", bg: "rgba(217,70,239,0.10)" },
  ssl:       { line: "#8b5cf6", bg: "rgba(139,92,246,0.10)" },
  fib:       { line: "#fbbf24", bg: "rgba(251,191,36,0.06)" },
};

/* ─── state-based styling ─── */
function getStateStyle(state?: string): { lineStyle: LineStyle; opacity: number } {
  switch (state?.toLowerCase()) {
    case "active":
    case "untested":
      return { lineStyle: LineStyle.Solid, opacity: 1.0 };
    case "tested":
      return { lineStyle: LineStyle.Dashed, opacity: 0.7 };
    case "mitigating":
    case "partially_filled":
      return { lineStyle: LineStyle.Dotted, opacity: 0.5 };
    case "broken":
    case "filled":
    case "swept":
      return { lineStyle: LineStyle.SparseDotted, opacity: 0.25 };
    default:
      return { lineStyle: LineStyle.Solid, opacity: 0.85 };
  }
}

/* ─── apply opacity to hex color ─── */
function hexWithOpacity(hex: string, opacity: number): string {
  const alpha = Math.round(opacity * 255).toString(16).padStart(2, "0");
  return hex.length === 7 ? hex + alpha : hex;
}

function TradeReplayChart({ candles, markers, zones, levels, overlayToggles, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  /* ─── create chart once ─── */
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0a0e17" },
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

    // Derive price precision from candle data
    const inferPrecision = (): number => {
      if (!candles.length) return 5;
      const sample = candles[0].close;
      const str = sample.toString();
      const dotIdx = str.indexOf(".");
      if (dotIdx === -1) return 2;
      const decimals = str.length - dotIdx - 1;
      return Math.max(decimals, 4);
    };
    const precision = inferPrecision();
    const minMove = 1 / Math.pow(10, precision);

    const series = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      priceFormat: {
        type: "price",
        precision,
        minMove,
      },
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
  }, [candles]);

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
      sorted.map((m) => {
        const isBuy = m.direction === "BUY";
        if (m.type === "entry") {
          return {
            time: m.time as Time,
            position: isBuy ? "belowBar" as const : "aboveBar" as const,
            color: isBuy ? "#22c55e" : "#ef4444",
            shape: isBuy ? "arrowUp" as const : "arrowDown" as const,
            text: m.label,
          };
        }
        if (m.type === "exit") {
          return {
            time: m.time as Time,
            position: isBuy ? "aboveBar" as const : "belowBar" as const,
            color: isBuy ? "#ef4444" : "#22c55e",
            shape: isBuy ? "arrowDown" as const : "arrowUp" as const,
            text: m.label,
          };
        }
        return {
          time: m.time as Time,
          position: "inBar" as const,
          color: m.type === "be" ? "#3b82f6" : "#f59e0b",
          shape: "circle" as const,
          text: m.label,
        };
      })
    );
  }, [markers]);

  /* ─── update trade levels & zone overlays ─── */
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    const lines: ReturnType<typeof series.createPriceLine>[] = [];

    // ── Trade levels ──
    if (levels) {
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

    // ── Zone overlays with state-based styling ──
    if (zones?.length) {
      for (const zone of zones) {
        // Check toggle — bsl/ssl have their own keys passed from parent
        const toggle = overlayToggles?.[zone.type];
        if (toggle === false) continue;

        const colors = ZONE_COLORS[zone.type] || ZONE_COLORS.ob;
        const stateStyle = getStateStyle(zone.state);
        const lineColor = hexWithOpacity(colors.line, stateStyle.opacity);

        // For zones with meaningful height (OB, FVG, Breaker), render both high and low
        const isRange = zone.high !== zone.low && Math.abs(zone.high - zone.low) > 0.00001;

        if (isRange) {
          // High boundary with label
          lines.push(
            series.createPriceLine({
              price: zone.high,
              color: lineColor,
              lineWidth: 1,
              lineStyle: stateStyle.lineStyle,
              axisLabelVisible: false,
              title: zone.label,
            })
          );
          // Low boundary
          lines.push(
            series.createPriceLine({
              price: zone.low,
              color: lineColor,
              lineWidth: 1,
              lineStyle: stateStyle.lineStyle,
              axisLabelVisible: false,
              title: "",
            })
          );
          // Midpoint (very faint) to give visual fill effect
          const mid = (zone.high + zone.low) / 2;
          lines.push(
            series.createPriceLine({
              price: mid,
              color: hexWithOpacity(colors.line, stateStyle.opacity * 0.3),
              lineWidth: 1,
              lineStyle: LineStyle.SparseDotted,
              axisLabelVisible: false,
              title: "",
            })
          );
        } else {
          // Single level (S/R, liquidity, BSL/SSL, Fib)
          lines.push(
            series.createPriceLine({
              price: zone.high || zone.low,
              color: lineColor,
              lineWidth: zone.type === "fib" ? 1 : 2,
              lineStyle: stateStyle.lineStyle,
              axisLabelVisible: zone.type === "fib" || zone.type === "sr",
              title: zone.label,
            })
          );
        }
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
