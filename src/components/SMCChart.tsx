/**
 * SMCChart — Consolidated Lightweight Charts v5 component
 * Replaces TradingViewChart (iframe) with a fully programmable chart.
 *
 * Supports: OBs, FVGs, Breakers, Swing Points, Liquidity Pools, Fibs,
 * HTF POIs, Daily Entities, Trade Entry/SL/TP overlays.
 * Layer toggles let users show/hide each overlay category.
 */

import { useEffect, useRef, useState, useMemo, useCallback, memo } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type CandlestickData,
  type Time,
} from 'lightweight-charts';

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
  direction: 'bullish' | 'bearish';
  state?: string;
  timeframe?: string;
}

export interface ChartFVG {
  high: number;
  low: number;
  datetime?: string;
  direction: 'bullish' | 'bearish';
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
  type: 'high' | 'low';
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
  direction: 'long' | 'short';
  label?: string;
  size?: number;
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
}

export type OverlayLayer =
  | 'orderBlocks'
  | 'fvgs'
  | 'breakers'
  | 'swingPoints'
  | 'liquidity'
  | 'fibs'
  | 'htfPOIs'
  | 'trades'
  | 'support'
  | 'resistance';

interface Props {
  candles: ChartCandle[];
  overlays?: SMCOverlays;
  loading?: boolean;
  symbol?: string;
  /** Layers to show by default. If not provided, all are visible. */
  defaultLayers?: OverlayLayer[];
  /** Hide the layer toggle toolbar */
  hideToolbar?: boolean;
  /** Compact mode (smaller font, tighter margins) */
  compact?: boolean;
}

// ─── Color Constants ────────────────────────────────────────────────────────

const COLORS = {
  bg: '#0a0e17',
  grid: 'rgba(42,49,68,0.4)',
  crosshair: 'rgba(6,182,212,0.3)',
  bullCandle: '#22c55e',
  bearCandle: '#ef4444',
  bullOB: 'rgba(59,130,246,0.6)',
  bearOB: 'rgba(239,68,68,0.6)',
  bullFVG: 'rgba(168,85,247,0.35)',
  bearFVG: 'rgba(239,68,68,0.35)',
  bullBreaker: 'rgba(236,72,153,0.5)',
  bearBreaker: 'rgba(245,158,11,0.5)',
  fib50: '#f59e0b',
  fibKey: 'rgba(6,182,212,0.6)',
  fibMinor: 'rgba(6,182,212,0.25)',
  support: 'rgba(34,197,94,0.5)',
  resistance: 'rgba(239,68,68,0.5)',
  liquidity: 'rgba(6,182,212,0.5)',
  htfD: 'rgba(34,197,94,0.5)',
  htf4H: 'rgba(59,130,246,0.4)',
  htf1H: 'rgba(168,85,247,0.35)',
  entry: '#06b6d4',
  sl: '#ef4444',
  tp: '#22c55e',
};

// ─── Layer Definitions ──────────────────────────────────────────────────────

const LAYER_DEFS: { id: OverlayLayer; label: string; color: string }[] = [
  { id: 'orderBlocks', label: 'OB', color: '#3b82f6' },
  { id: 'fvgs', label: 'FVG', color: '#a855f7' },
  { id: 'breakers', label: 'BRK', color: '#ec4899' },
  { id: 'swingPoints', label: 'SP', color: '#f59e0b' },
  { id: 'liquidity', label: 'LIQ', color: '#06b6d4' },
  { id: 'fibs', label: 'FIB', color: '#f59e0b' },
  { id: 'htfPOIs', label: 'HTF', color: '#22c55e' },
  { id: 'trades', label: 'TRD', color: '#06b6d4' },
  { id: 'support', label: 'S', color: '#22c55e' },
  { id: 'resistance', label: 'R', color: '#ef4444' },
];

// ─── Component ──────────────────────────────────────────────────────────────

function SMCChart({ candles, overlays, loading, symbol, defaultLayers, hideToolbar, compact }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<any>(null);

  const allLayers: OverlayLayer[] = LAYER_DEFS.map(l => l.id);
  const [visibleLayers, setVisibleLayers] = useState<Set<OverlayLayer>>(
    new Set(defaultLayers ?? allLayers)
  );

  const toggleLayer = useCallback((layer: OverlayLayer) => {
    setVisibleLayers(prev => {
      const next = new Set(prev);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
  }, []);

  // Convert candles to chart format
  const chartData: CandlestickData<Time>[] = useMemo(() => {
    if (!candles?.length) return [];
    const seen = new Set<string>();
    return candles
      .map(c => {
        // Handle "2024-01-15", "2024-01-15T10:00:00", "2024-01-15 10:00:00" formats
        const timePart = c.datetime.includes('T')
          ? c.datetime.split('T')[0]
          : c.datetime.split(' ')[0];
        return { time: timePart as Time, open: c.open, high: c.high, low: c.low, close: c.close };
      })
      .filter(d => {
        const key = String(d.time);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [candles]);

  // Initialize chart
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: COLORS.bg },
        textColor: '#64748b',
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
        borderColor: 'rgba(42,49,68,0.6)',
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: 'rgba(42,49,68,0.6)',
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: true,
      handleScale: true,
    });

    chartRef.current = chart;

    // v5 API: addSeries with CandlestickSeries or fallback to v4 addCandlestickSeries
    let series: any;
    if (typeof (chart as any).addCandlestickSeries === 'function') {
      // v4 fallback
      series = (chart as any).addCandlestickSeries({
        upColor: COLORS.bullCandle,
        downColor: COLORS.bearCandle,
        borderUpColor: COLORS.bullCandle,
        borderDownColor: COLORS.bearCandle,
        wickUpColor: COLORS.bullCandle,
        wickDownColor: COLORS.bearCandle,
      });
    } else {
      // v5 API
      const { CandlestickSeries: CS } = require('lightweight-charts');
      series = chart.addSeries(CS, {
        upColor: COLORS.bullCandle,
        downColor: COLORS.bearCandle,
        borderUpColor: COLORS.bullCandle,
        borderDownColor: COLORS.bearCandle,
        wickUpColor: COLORS.bullCandle,
        wickDownColor: COLORS.bearCandle,
      });
    }

    candleSeriesRef.current = series;

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        chart.applyOptions({ width, height });
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, [compact]);

  // Update data and overlays
  useEffect(() => {
    if (!candleSeriesRef.current || !chartRef.current || chartData.length === 0) return;

    const series = candleSeriesRef.current;
    series.setData(chartData);

    // Clear previous price lines
    try {
      const existingLines = (series as any).priceLines?.() ?? [];
      existingLines.forEach((line: any) => {
        try { series.removePriceLine(line); } catch {}
      });
    } catch {}

    if (!overlays) {
      chartRef.current.timeScale().fitContent();
      return;
    }

    // ─── Order Blocks (price lines for high/low of each OB) ─────────
    if (visibleLayers.has('orderBlocks') && overlays.orderBlocks?.length) {
      for (const ob of overlays.orderBlocks.slice(0, 20)) {
        const isBull = ob.direction === 'bullish';
        const color = isBull ? COLORS.bullOB : COLORS.bearOB;
        try {
          series.createPriceLine({
            price: ob.high,
            color,
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: false,
            title: '',
          });
          series.createPriceLine({
            price: ob.low,
            color,
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: false,
            title: '',
          });
        } catch {}
      }
    }

    // ─── FVGs (price lines for gap boundaries) ──────────────────────
    if (visibleLayers.has('fvgs') && overlays.fvgs?.length) {
      for (const fvg of overlays.fvgs.slice(0, 20)) {
        const isBull = fvg.direction === 'bullish';
        const color = isBull ? COLORS.bullFVG : COLORS.bearFVG;
        try {
          series.createPriceLine({
            price: fvg.high,
            color,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
            title: '',
          });
          series.createPriceLine({
            price: fvg.low,
            color,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
            title: '',
          });
        } catch {}
      }
    }

    // ─── Breaker Blocks ─────────────────────────────────────────────
    if (visibleLayers.has('breakers') && overlays.breakerBlocks?.length) {
      for (const bb of overlays.breakerBlocks.slice(0, 10)) {
        const isBull = bb.direction.includes('bullish');
        const color = isBull ? COLORS.bullBreaker : COLORS.bearBreaker;
        try {
          series.createPriceLine({
            price: (bb.high + bb.low) / 2,
            color,
            lineWidth: 1,
            lineStyle: LineStyle.LargeDashed,
            axisLabelVisible: false,
            title: `BRK ${bb.timeframe ?? ''}`,
          });
        } catch {}
      }
    }

    // ─── Liquidity Pools ────────────────────────────────────────────
    if (visibleLayers.has('liquidity') && overlays.liquidityPools?.length) {
      for (const lp of overlays.liquidityPools.slice(0, 10)) {
        if (lp.swept) continue;
        try {
          series.createPriceLine({
            price: lp.price,
            color: COLORS.liquidity,
            lineWidth: 2,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: `LIQ ${lp.strength ?? ''}`,
          });
        } catch {}
      }
    }

    // ─── Fibonacci Levels ───────────────────────────────────────────
    if (visibleLayers.has('fibs')) {
      if (overlays.fiftyPercentLevel) {
        try {
          series.createPriceLine({
            price: overlays.fiftyPercentLevel,
            color: COLORS.fib50,
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: '50%',
          });
        } catch {}
      }
      if (overlays.fibLevels?.length) {
        for (const fib of overlays.fibLevels) {
          const isFifty = fib.label === '50%';
          const isKey = fib.label === '61.8%' || fib.label === '38.2%';
          try {
            series.createPriceLine({
              price: fib.price,
              color: isFifty ? COLORS.fib50 : isKey ? COLORS.fibKey : COLORS.fibMinor,
              lineWidth: isFifty ? 2 : 1,
              lineStyle: isFifty ? LineStyle.Solid : LineStyle.Dashed,
              axisLabelVisible: isFifty || isKey,
              title: fib.label,
            });
          } catch {}
        }
      }
    }

    // ─── HTF POIs ───────────────────────────────────────────────────
    if (visibleLayers.has('htfPOIs') && overlays.htfPOIs?.length) {
      for (const poi of overlays.htfPOIs.slice(0, 15)) {
        const colorMap: Record<string, string> = { D: COLORS.htfD, '4H': COLORS.htf4H, '1H': COLORS.htf1H };
        const color = colorMap[poi.timeframe] ?? COLORS.htf1H;
        try {
          series.createPriceLine({
            price: (poi.high + poi.low) / 2,
            color,
            lineWidth: 2,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: `${poi.timeframe} ${poi.type.toUpperCase()}`,
          });
        } catch {}
      }
    }

    // ─── Support Levels ─────────────────────────────────────────────
    if (visibleLayers.has('support') && overlays.keySupport?.length) {
      for (const level of overlays.keySupport.slice(0, 5)) {
        try {
          series.createPriceLine({
            price: level,
            color: COLORS.support,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'S',
          });
        } catch {}
      }
    }

    // ─── Resistance Levels ──────────────────────────────────────────
    if (visibleLayers.has('resistance') && overlays.keyResistance?.length) {
      for (const level of overlays.keyResistance.slice(0, 5)) {
        try {
          series.createPriceLine({
            price: level,
            color: COLORS.resistance,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'R',
          });
        } catch {}
      }
    }

    // ─── Trade Overlays (Entry/SL/TP) ───────────────────────────────
    if (visibleLayers.has('trades') && overlays.trades?.length) {
      for (const trade of overlays.trades) {
        const isLong = trade.direction === 'long';
        try {
          series.createPriceLine({
            price: trade.entryPrice,
            color: isLong ? COLORS.entry : COLORS.sl,
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: `${isLong ? 'BUY' : 'SELL'} ${trade.label ?? ''}`,
          });
        } catch {}
        if (trade.stopLoss != null) {
          try {
            series.createPriceLine({
              price: trade.stopLoss,
              color: COLORS.sl,
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: 'SL',
            });
          } catch {}
        }
        if (trade.takeProfit != null) {
          try {
            series.createPriceLine({
              price: trade.takeProfit,
              color: COLORS.tp,
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: 'TP',
            });
          } catch {}
        }
      }
    }

    // ─── Swing Point Markers ────────────────────────────────────────
    if (visibleLayers.has('swingPoints') && overlays.swingPoints?.length && chartData.length > 0) {
      const markers = overlays.swingPoints
        .filter(sp => sp.index != null && sp.index! < chartData.length)
        .map(sp => ({
          time: chartData[Math.min(sp.index!, chartData.length - 1)]?.time,
          position: sp.type === 'high' ? 'aboveBar' as const : 'belowBar' as const,
          color: sp.type === 'high' ? COLORS.bearCandle : COLORS.bullCandle,
          shape: sp.type === 'high' ? 'arrowDown' as const : 'arrowUp' as const,
          text: sp.type === 'high' ? 'HH' : 'HL',
        }))
        .filter(m => m.time);

      if (markers.length > 0) {
        try {
          // v5: createSeriesMarkers, v4: series.setMarkers
          if (typeof series.setMarkers === 'function') {
            series.setMarkers(markers);
          } else {
            const { createSeriesMarkers } = require('lightweight-charts');
            createSeriesMarkers(series, markers);
          }
        } catch {}
      }
    }

    chartRef.current.timeScale().fitContent();
  }, [chartData, overlays, visibleLayers]);

  return (
    <div className="relative w-full h-full flex flex-col" style={{ backgroundColor: COLORS.bg }}>
      {/* Layer Toggle Toolbar */}
      {!hideToolbar && (
        <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border/30 flex-shrink-0 overflow-x-auto" style={{ backgroundColor: COLORS.bg }}>
          {symbol && (
            <span className="text-xs font-mono font-bold text-primary mr-2 flex-shrink-0">{symbol}</span>
          )}
          {LAYER_DEFS.map(layer => {
            const active = visibleLayers.has(layer.id);
            const hasData = overlays ? (
              (layer.id === 'orderBlocks' && overlays.orderBlocks?.length) ||
              (layer.id === 'fvgs' && overlays.fvgs?.length) ||
              (layer.id === 'breakers' && overlays.breakerBlocks?.length) ||
              (layer.id === 'swingPoints' && overlays.swingPoints?.length) ||
              (layer.id === 'liquidity' && overlays.liquidityPools?.length) ||
              (layer.id === 'fibs' && (overlays.fibLevels?.length || overlays.fiftyPercentLevel)) ||
              (layer.id === 'htfPOIs' && overlays.htfPOIs?.length) ||
              (layer.id === 'trades' && overlays.trades?.length) ||
              (layer.id === 'support' && overlays.keySupport?.length) ||
              (layer.id === 'resistance' && overlays.keyResistance?.length)
            ) : false;

            if (!hasData) return null;

            return (
              <button
                key={layer.id}
                onClick={() => toggleLayer(layer.id)}
                className={`px-1.5 py-0.5 text-[9px] font-mono font-bold rounded transition-all flex-shrink-0 ${
                  active
                    ? 'bg-white/10 text-foreground'
                    : 'text-muted-foreground/40 hover:text-muted-foreground'
                }`}
                title={`Toggle ${layer.label}`}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full mr-1"
                  style={{ backgroundColor: active ? layer.color : 'transparent', border: `1px solid ${layer.color}` }}
                />
                {layer.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Chart Container */}
      <div ref={containerRef} className="flex-1 min-h-0" />

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10" style={{ backgroundColor: 'rgba(10,14,23,0.85)' }}>
          <div className="flex items-center gap-3">
            <div className="w-1.5 h-8 bg-primary animate-pulse" />
            <div className="w-1.5 h-8 bg-primary animate-pulse" style={{ animationDelay: '0.15s' }} />
            <div className="w-1.5 h-8 bg-primary animate-pulse" style={{ animationDelay: '0.3s' }} />
            <span className="text-xs font-mono text-muted-foreground ml-3 uppercase tracking-wider">Loading chart</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(SMCChart);
