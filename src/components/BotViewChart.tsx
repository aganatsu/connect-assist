/**
 * BotViewChart — the chart as the SMC bot saw it on its latest scan of the pair.
 *
 * Draws only what the bot used: swing highs/lows (HH/HL/LH/LL) and the latest
 * CHoCH/BOS from the bot's own structure code (supabase/functions/_shared/smcAnalysis.ts),
 * the impulse leg, the zone, and the planned entry / stop / target from the scan record.
 */
import { useEffect, useMemo, useRef } from "react";
import {
  createChart, ColorType, CrosshairMode, LineStyle,
  type IChartApi, type ISeriesApi, type IPriceLine, type Time, type SeriesMarker, type CandlestickData,
} from "lightweight-charts";
import { analyzeMarketStructure, SPECS } from "../../supabase/functions/_shared/smcAnalysis.ts";
import { isFxClosedAt } from "../../supabase/functions/_shared/sessions.ts";
import { labelSwings, type BotView } from "@/lib/botView";
import { closeReasonLabel, type ChartTrade, type Excursion } from "@/lib/chartTrades";
import { useTheme } from "@/contexts/ThemeContext";
import { saveRange, restoreRange, barSpacingSec, tradeShapeKey, type SavedRange } from "@/lib/chartRange";

interface Props {
  candles: Array<{ datetime: string; open: number; high: number; low: number; close: number; volume?: number }>;
  symbol: string;
  view: BotView | null;
  loading?: boolean;
  /** Open positions on this symbol: entry / stop / target lines that stay until the trade closes. */
  openTrades?: ChartTrade[];
  /** Trades tab: the trade under review — entry/exit markers, its levels over its lifetime, and the excursion band. */
  focusTrade?: ChartTrade | null;
  excursion?: Excursion | null;
}

const GREEN = "#22c55e", RED = "#ef4444", BLUE = "#3b82f6", AMBER = "#f59e0b", PURPLE = "#a78bfa", CYAN = "#06b6d4";
const fmtR = (r: number | null) => (r == null ? "" : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`);
const CLOSED = "rgba(100,116,139,0.35)";
const VISIBLE_BARS = 160;

const toIso = (d: string) => (/[zZ]|[+-]\d\d:?\d\d$/.test(d) ? d : d.replace(" ", "T") + "Z");
const toSec = (d: string) => Math.floor(Date.parse(toIso(d)) / 1000);

/** Same content → same reference, so a refetch that changes nothing on screen doesn't rebuild the chart. */
function useStable<T>(value: T, key: string): T {
  const ref = useRef<{ key: string; value: T } | null>(null);
  if (!ref.current || ref.current.key !== key) ref.current = { key, value };
  return ref.current.value;
}

const openTitle = (t: ChartTrade) => `${t.direction === "long" ? "BUY" : "SELL"} open ${fmtR(t.r)}`.trim();

function precisionFor(sym: string): { precision: number; minMove: number } {
  const s = sym.toUpperCase();
  if (s.includes("JPY")) return { precision: 3, minMove: 0.001 };
  if (s.includes("XAU") || s.includes("BTC") || s.includes("ETH")) return { precision: 2, minMove: 0.01 };
  return { precision: 5, minMove: 0.00001 };
}

export default function BotViewChart({ candles, symbol, view: viewProp, loading, openTrades: openProp, focusTrade: focusProp, excursion: excProp }: Props) {
  const view = useStable(viewProp, JSON.stringify(viewProp ?? null));
  const openTrades = useStable(openProp, (openProp ?? []).map(tradeShapeKey).join("|"));
  const focusTrade = useStable(focusProp, focusProp ? tradeShapeKey(focusProp) : "");
  const excursion = useStable(excProp, JSON.stringify(excProp ?? null));
  // Running R on open positions changes every refetch: it updates the line titles in place.
  const latestOpen = useRef(openProp);
  latestOpen.current = openProp;
  const openLines = useRef(new Map<string, IPriceLine>());
  // The user's zoom/scroll, kept across rebuilds (src/lib/chartRange.ts).
  const savedRange = useRef<SavedRange | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();
  const light = resolvedTheme === "light";

  // Forex: the bot drops weekend bars (WEEKEND_BARS_PREREG_V1, Bot Config dropFxWeekendBars,
  // default on), so they are dropped here too and the structure matches the bot's.
  const isForex = (SPECS as any)[symbol]?.type === "forex";
  const bars: CandlestickData<Time>[] = useMemo(() => {
    const seen = new Set<number>();
    return (candles ?? [])
      .map((c) => ({ time: toSec(c.datetime) as Time, open: c.open, high: c.high, low: c.low, close: c.close }))
      .filter((b) => Number.isFinite(b.time as number) && !seen.has(b.time as number) && !!seen.add(b.time as number))
      .filter((b) => !isForex || !isFxClosedAt((b.time as number) * 1000))
      .sort((a, b) => (a.time as number) - (b.time as number));
  }, [candles, isForex]);

  // Other weekend-closed markets (gold): the feed still sends weekend bars and the bot
  // reads them. Kept, so the structure matches the bot's; greyed.
  const closesWeekends = !isForex && (SPECS as any)[symbol]?.type !== "crypto";
  const closedCount = useMemo(
    () => (closesWeekends ? bars.filter((b) => isFxClosedAt((b.time as number) * 1000)).length : 0),
    [bars, closesWeekends],
  );

  // The bot's own structure read on these candles.
  const structure = useMemo(() => {
    if (bars.length < 20) return null;
    const cs = bars.map((b) => ({
      datetime: new Date((b.time as number) * 1000).toISOString(), open: b.open, high: b.high, low: b.low, close: b.close, volume: 0,
    }));
    try { return analyzeMarketStructure(cs as never) as any; } catch { return null; }
  }, [bars]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || bars.length === 0) return;
    const chart: IChartApi = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: light ? "#ffffff" : "#0a0e17" },
        textColor: light ? "#475569" : "#8b95a7",
        fontFamily: "'JetBrains Mono', 'IBM Plex Mono', monospace",
        fontSize: 11,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: light ? "rgba(15,23,42,0.06)" : "rgba(42,49,68,0.25)" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 8 },
      autoSize: true,
    });
    const series: ISeriesApi<"Candlestick"> = chart.addCandlestickSeries({
      upColor: GREEN, downColor: RED, borderVisible: false, wickUpColor: GREEN, wickDownColor: RED,
      priceFormat: { type: "price", ...precisionFor(symbol) },
    });
    series.setData(closesWeekends
      ? bars.map((b) => (isFxClosedAt((b.time as number) * 1000) ? { ...b, color: CLOSED, wickColor: CLOSED } : b))
      : bars);

    const times = bars.map((b) => b.time as number);
    const snap = (iso: string | null | undefined): number | null => {
      if (!iso) return null;
      const t = toSec(iso);
      if (!Number.isFinite(t) || t < times[0]) return null;
      let lo = 0, hi = times.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= t) lo = mid; else hi = mid - 1; }
      return times[lo];
    };
    const quiet = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const;

    const markers: SeriesMarker<Time>[] = [];
    const firstVisible = times[Math.max(0, times.length - VISIBLE_BARS * 2)];

    // ── Swings: zigzag + HH/HL/LH/LL ──
    if (structure?.swingPoints?.length) {
      const labelled = labelSwings(structure.swingPoints).filter((s) => toSec(s.datetime) >= firstVisible);
      const zig = chart.addLineSeries({ color: light ? "rgba(71,85,105,0.55)" : "rgba(148,163,184,0.45)", lineWidth: 1, ...quiet });
      zig.setData(labelled.map((s) => ({ time: snap(s.datetime) as Time, value: s.price })).filter((p) => p.time != null));
      for (const s of labelled) {
        const t = snap(s.datetime); if (t == null) continue;
        const up = s.label === "HH" || s.label === "HL";
        const down = s.label === "LH" || s.label === "LL";
        markers.push({
          time: t as Time, position: s.type === "high" ? "aboveBar" : "belowBar",
          color: up ? GREEN : down ? RED : "#94a3b8", shape: "circle", size: s.major ? 0.6 : 0.3, text: s.label,
        });
      }
    }

    // ── Latest structure breaks (the ones the direction check reads) ──
    if (structure) {
      const breaks = [
        ...(structure.choch ?? []).map((b: any) => ({ ...b, kind: "CHoCH" })),
        ...(structure.bos ?? []).map((b: any) => ({ ...b, kind: "BOS" })),
      ].sort((a, b) => toSec(a.datetime) - toSec(b.datetime)).slice(-4);
      for (const b of breaks) {
        const t = snap(b.datetime); if (t == null) continue;
        const i = times.indexOf(t);
        const from = times[Math.max(0, i - 10)];
        const col = b.type === "bullish" ? GREEN : RED;
        const seg = chart.addLineSeries({ color: col, lineWidth: 1, lineStyle: LineStyle.Dashed, ...quiet });
        seg.setData([{ time: from as Time, value: b.level ?? b.price }, { time: t as Time, value: b.level ?? b.price }]);
        markers.push({
          time: t as Time, position: b.type === "bullish" ? "aboveBar" : "belowBar", color: col,
          shape: b.type === "bullish" ? "arrowUp" : "arrowDown", text: `${b.kind} ${b.type === "bullish" ? "↑" : "↓"}`,
        });
      }
    }

    // ── Impulse leg ──
    const imp = view?.impulse;
    if (imp) {
      const a = snap(imp.fromTime), b = snap(imp.toTime);
      if (a != null && b != null && b > a) {
        const leg = chart.addLineSeries({ color: PURPLE, lineWidth: 3, ...quiet });
        leg.setData([{ time: a as Time, value: imp.fromPrice }, { time: b as Time, value: imp.toPrice }]);
      }
    }

    // ── Planned entry / stop / target ──
    const L = view?.levels;
    if (L?.entry != null) series.createPriceLine({ price: L.entry, color: BLUE, lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "entry" });
    if (L?.sl != null) series.createPriceLine({ price: L.sl, color: RED, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "stop" });
    if (L?.tp != null) series.createPriceLine({ price: L.tp, color: GREEN, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "target" });

    // ── Open positions on this symbol ──
    openLines.current.clear();
    for (const t of openTrades ?? []) {
      const long = t.direction === "long";
      const live = latestOpen.current?.find((x) => x.id === t.id) ?? t;
      openLines.current.set(t.id, series.createPriceLine({ price: t.entryPrice, color: CYAN, lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: openTitle(live) }));
      if (t.sl != null) series.createPriceLine({ price: t.sl, color: RED, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "SL" });
      if (t.tp != null) series.createPriceLine({ price: t.tp, color: GREEN, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "TP" });
      const et = snap(t.openTime);
      if (et != null) markers.push({ time: et as Time, position: long ? "belowBar" : "aboveBar", color: CYAN, shape: long ? "arrowUp" : "arrowDown", text: long ? "BUY" : "SELL" });
    }

    // ── The trade under review (Trades tab) ──
    const ft = focusTrade ?? null;
    const ftEntryT = ft ? snap(ft.openTime) : null;
    const ftEndT = ft ? (ft.closeTime ? snap(ft.closeTime) : times[times.length - 1]) : null;
    if (ft && ftEntryT != null && ftEndT != null) {
      const long = ft.direction === "long";
      const seg = (price: number | null, color: string, style: LineStyle, width: 1 | 2) => {
        if (price == null) return;
        const ls = chart.addLineSeries({ color, lineWidth: width, lineStyle: style, ...quiet });
        ls.setData(ftEndT > ftEntryT
          ? [{ time: ftEntryT as Time, value: price }, { time: ftEndT as Time, value: price }]
          : [{ time: ftEntryT as Time, value: price }]);
      };
      seg(ft.entryPrice, CYAN, LineStyle.Solid, 2);
      seg(ft.sl, RED, LineStyle.Dashed, 1);
      seg(ft.tp, GREEN, LineStyle.Dashed, 1);
      // Axis labels without full-width lines, so the levels read off the scale.
      series.createPriceLine({ price: ft.entryPrice, color: CYAN, lineVisible: false, axisLabelVisible: true, title: long ? "BUY" : "SELL" } as never);
      if (ft.sl != null) series.createPriceLine({ price: ft.sl, color: RED, lineVisible: false, axisLabelVisible: true, title: "SL" } as never);
      if (ft.tp != null) series.createPriceLine({ price: ft.tp, color: GREEN, lineVisible: false, axisLabelVisible: true, title: "TP" } as never);
      markers.push({ time: ftEntryT as Time, position: long ? "belowBar" : "aboveBar", color: CYAN,
        shape: long ? "arrowUp" : "arrowDown", text: `${long ? "BUY" : "SELL"} ${ft.entryPrice}` });
      if (ft.status === "closed" && ft.closeTime) {
        markers.push({ time: ftEndT as Time, position: long ? "aboveBar" : "belowBar", color: (ft.r ?? 0) > 0 ? GREEN : RED,
          shape: "circle", text: `${closeReasonLabel(ft.closeReason)} ${fmtR(ft.r)}`.trim() });
      }
    }

    markers.sort((x, y) => (x.time as number) - (y.time as number));
    series.setMarkers(markers);
    // Show the latest bars. Set once the chart has a width — set at width 0 (autoSize
    // before layout) it did not stick and the newest candles ended up off-screen.
    // A rebuild of the same pair / timeframe / trade keeps where the user had zoomed to.
    const rangeKey = `${symbol}|${barSpacingSec(times)}|${ft?.id ?? ""}`;
    let rangeSet = false;
    const showLatest = () => {
      if (rangeSet || el.clientWidth === 0) return;
      rangeSet = true;
      const kept = restoreRange(savedRange.current, rangeKey, bars.length);
      if (kept) { chart.timeScale().setVisibleLogicalRange(kept); return; }
      if (ftEntryT != null && ftEndT != null) {
        // From the start of the impulse the trade was built on (when loaded), so the purple
        // leg and its zone are on screen, not just the trade.
        const impT = snap(imp?.fromTime ?? null);
        const a = Math.min(times.indexOf(ftEntryT), impT != null ? times.indexOf(impT) : Infinity), b = times.indexOf(ftEndT);
        const pad = Math.max(20, Math.round((b - a) * 0.2));
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, a - pad), to: Math.min(bars.length + 6, b + pad) });
        return;
      }
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - VISIBLE_BARS), to: bars.length + 6 });
    };
    const raf = requestAnimationFrame(showLatest);

    // ── Zone box (canvas overlay, follows scroll/zoom) ──
    const canvas = canvasRef.current;
    const zone = view?.zone;
    const zoneStart = snap(imp?.toTime ?? null);
    const drawZone = () => {
      if (!canvas) return;
      const r = el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      canvas.width = r.width * dpr; canvas.height = r.height * dpr;
      canvas.style.width = `${r.width}px`; canvas.style.height = `${r.height}px`;
      const ctx = canvas.getContext("2d"); if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, r.width, r.height);
      // How far price went for (green) and against (red) the trade while it was open.
      if (ft && excursion && ftEntryT != null && ftEndT != null) {
        const x0 = chart.timeScale().timeToCoordinate(ftEntryT as Time);
        const x1 = chart.timeScale().timeToCoordinate(ftEndT as Time);
        const yE = series.priceToCoordinate(ft.entryPrice);
        const yB = series.priceToCoordinate(excursion.best), yW = series.priceToCoordinate(excursion.worst);
        if (x0 != null && x1 != null && yE != null && yB != null && yW != null) {
          const w = Math.max(2, x1 - x0);
          ctx.fillStyle = "rgba(34,197,94,0.10)"; ctx.fillRect(x0, Math.min(yE, yB), w, Math.abs(yB - yE));
          ctx.fillStyle = "rgba(239,68,68,0.10)"; ctx.fillRect(x0, Math.min(yE, yW), w, Math.abs(yW - yE));
        }
      }
      if (!zone) return;
      const yTop = series.priceToCoordinate(zone.high), yBot = series.priceToCoordinate(zone.low);
      if (yTop == null || yBot == null) return;
      const plotRight = r.width - chart.priceScale("right").width();
      const xStartRaw = zoneStart != null ? chart.timeScale().timeToCoordinate(zoneStart as Time) : null;
      const xStart = Math.max(0, xStartRaw ?? 0);
      const bull = imp?.direction === "bullish";
      ctx.fillStyle = bull ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)";
      ctx.strokeStyle = bull ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)";
      ctx.lineWidth = 1;
      ctx.fillRect(xStart, yTop, plotRight - xStart, yBot - yTop);
      ctx.strokeRect(xStart + 0.5, yTop + 0.5, plotRight - xStart - 1, yBot - yTop - 1);
      const label = `${bull ? "Demand" : "Supply"} zone · ${zone.label}${zone.score != null ? ` · ${zone.score}/9` : ""}`;
      ctx.font = "600 11px 'JetBrains Mono', monospace";
      const w = ctx.measureText(label).width;
      ctx.fillStyle = light ? "rgba(255,255,255,0.85)" : "rgba(10,14,23,0.8)";
      ctx.fillRect(plotRight - w - 14, yTop + 3, w + 10, 16);
      ctx.fillStyle = AMBER;
      ctx.fillText(label, plotRight - w - 9, yTop + 15);
    };
    drawZone();
    chart.timeScale().subscribeVisibleLogicalRangeChange(drawZone);
    const keepRange = (r: { from: number; to: number } | null) => {
      if (rangeSet && r) savedRange.current = saveRange(rangeKey, bars.length, r);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(keepRange);
    const ro = new ResizeObserver(() => { showLatest(); drawZone(); }); ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(drawZone);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(keepRange);
      openLines.current.clear();
      chart.remove();
    };
  }, [bars, structure, view, symbol, light, closesWeekends, openTrades, focusTrade, excursion]);

  useEffect(() => {
    for (const t of openProp ?? []) openLines.current.get(t.id)?.applyOptions({ title: openTitle(t) });
  }, [openProp]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="absolute inset-0" />
      <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" style={{ zIndex: 2 }} />
      {closedCount > 0 && (
        <div className="absolute top-2 left-2 z-[3] text-[10px] text-muted-foreground bg-background/70 rounded px-1.5 py-0.5 pointer-events-none">
          Grey candles = market closed (weekend data the bot still reads)
        </div>
      )}
      {(loading || bars.length === 0) && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Loading chart…</div>
      )}
    </div>
  );
}
