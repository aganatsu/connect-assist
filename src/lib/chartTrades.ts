/* eslint-disable @typescript-eslint/no-explicit-any -- parses the untyped paperApi.status() payload */
/**
 * Chart trades — open positions and closed trades from paperApi.status(), shaped for the chart.
 *
 * The impulse and zone are the bot's record AT ENTRY (signal_reason / frozen context, via
 * getPositionEntryEvidence), never re-derived from today's candles: the point is to see the
 * decision that created the trade.
 */
import { buildBotView, type BotViewImpulse, type BotViewZone } from "@/lib/botView";
import { getPositionEntryEvidence } from "@/lib/positionEvidence";

export interface ChartTrade {
  id: string;
  symbol: string;
  direction: "long" | "short";
  status: "open" | "closed";
  entryPrice: number;
  /** Exit price (closed) or the latest price (open). */
  exitPrice: number | null;
  /** Stop / target as planned at entry (signal originalSL/TP), else the stored ones. */
  sl: number | null;
  tp: number | null;
  openTime: string;
  closeTime: string | null;
  closeReason: string | null;
  pnl: number | null;
  /** Result in R against the planned stop: realised (closed) or running (open). */
  r: number | null;
  impulse: BotViewImpulse | null;
  zone: BotViewZone | null;
  summary: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const dirOf = (d: unknown): "long" | "short" => {
  const s = String(d ?? "").toLowerCase();
  return s === "long" || s === "buy" ? "long" : "short";
};

export function rMultiple(direction: "long" | "short", entry: number, price: number | null, sl: number | null): number | null {
  if (price == null || sl == null) return null;
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  return (direction === "long" ? price - entry : entry - price) / risk;
}

function toTrade(raw: any, status: "open" | "closed"): ChartTrade | null {
  const entryPrice = num(raw?.entryPrice);
  const openTime = typeof raw?.openTime === "string" ? raw.openTime : null;
  if (!raw?.symbol || entryPrice == null || !openTime) return null;
  const direction = dirOf(raw.direction);
  const ev = getPositionEntryEvidence(raw);
  const view = buildBotView(
    { unifiedZone: ev.zoneStory, impulseZone: ev.impulseZone, simpleDirection: ev.signal?.simpleDirection ?? null, status: "trade_placed" },
    openTime,
  );
  const sl = num(ev.signal?.originalSL) ?? num(raw.stopLoss);
  const tp = num(ev.signal?.originalTP) ?? num(raw.takeProfit);
  const exitPrice = status === "closed" ? num(raw.exitPrice) : num(raw.currentPrice);
  return {
    id: String(raw.id ?? raw.positionId ?? `${raw.symbol}-${openTime}`),
    symbol: raw.symbol,
    direction,
    status,
    entryPrice,
    exitPrice,
    sl, tp,
    openTime,
    closeTime: status === "closed" ? (raw.closedAt ?? null) : null,
    closeReason: status === "closed" ? (raw.closeReason ?? null) : null,
    pnl: num(raw.pnl),
    r: rMultiple(direction, entryPrice, exitPrice, sl),
    impulse: view.impulse,
    zone: view.zone,
    summary: typeof ev.signal?.summary === "string" ? ev.signal.summary : null,
  };
}

/** Open positions first (newest first), then closed trades (newest first). */
export function toChartTrades(status: any): ChartTrade[] {
  const open = (Array.isArray(status?.positions) ? status.positions : [])
    .map((p: any) => toTrade(p, "open")).filter(Boolean) as ChartTrade[];
  const closed = (Array.isArray(status?.tradeHistory) ? status.tradeHistory : [])
    .map((t: any) => toTrade(t, "closed")).filter(Boolean) as ChartTrade[];
  const newest = (a: ChartTrade, b: ChartTrade) => Date.parse(b.openTime) - Date.parse(a.openTime);
  return [...open.sort(newest), ...closed.sort((a, b) =>
    Date.parse(b.closeTime ?? b.openTime) - Date.parse(a.closeTime ?? a.openTime))];
}

const TF_MINUTES: Record<string, number> = { "5min": 5, "15min": 15, "1h": 60, "4h": 240 };
export const TRADE_TIMEFRAMES = [
  { value: "5min", label: "5M" }, { value: "15min", label: "15M" },
  { value: "1h", label: "1H" }, { value: "4h", label: "4H" },
] as const;

/** Where the trade's story starts: the impulse it was built on, else the entry. */
export function tradeStoryStart(t: ChartTrade): string {
  const imp = t.impulse?.fromTime ? Date.parse(t.impulse.fromTime) : NaN;
  return Number.isFinite(imp) && imp < Date.parse(t.openTime) ? t.impulse!.fromTime! : t.openTime;
}

/**
 * The smallest timeframe whose `bars`-candle window still reaches back to a little before
 * the impulse the trade was built on (else the entry). The chart fetches the latest `bars`
 * candles only, so an old trade needs a coarser timeframe to be on screen at all.
 */
export function timeframeForTrade(t: ChartTrade, nowMs = Date.now(), bars = 500): string {
  const ageMin = (nowMs - Date.parse(tradeStoryStart(t))) / 60_000;
  for (const tf of ["5min", "15min", "1h", "4h"]) {
    if (ageMin / TF_MINUTES[tf] + 60 <= bars) return tf;   // 60 bars of context before the entry
  }
  return "4h";
}

export interface Excursion { best: number; worst: number; bestR: number | null; worstR: number | null }

/**
 * How far price went for and against the trade between entry and exit (or now): the best and
 * worst prices on candles that overlap the trade's life.
 */
export function tradeExcursion(
  t: ChartTrade,
  candles: Array<{ datetime: string; high: number; low: number }>,
  nowMs = Date.now(),
): Excursion | null {
  const from = Date.parse(t.openTime), to = t.closeTime ? Date.parse(t.closeTime) : nowMs;
  const iso = (d: string) => (/[zZ]|[+-]\d\d:?\d\d$/.test(d) ? d : d.replace(" ", "T") + "Z");
  let hi = -Infinity, lo = Infinity;
  const starts = candles.map((c) => Date.parse(iso(c.datetime)));
  for (let i = 0; i < candles.length; i++) {
    const s = starts[i], e = starts[i + 1] ?? Infinity;
    if (e <= from || s > to) continue;
    hi = Math.max(hi, candles[i].high); lo = Math.min(lo, candles[i].low);
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  const long = t.direction === "long";
  const best = long ? hi : lo, worst = long ? lo : hi;
  return { best, worst, bestR: rMultiple(t.direction, t.entryPrice, best, t.sl), worstR: rMultiple(t.direction, t.entryPrice, worst, t.sl) };
}

export function closeReasonLabel(reason: string | null): string {
  switch (reason) {
    case "tp_hit": return "Target hit";
    case "sl_hit": return "Stop hit";
    case "trail_hit": return "Trailing stop";
    case "be_hit": return "Breakeven stop";
    case "time_exit": return "Max hold";
    case "reverse_signal": return "Reverse signal";
    case "manual": return "Closed manually";
    case null: case undefined: case "": return "—";
    default: return reason.replace(/_/g, " ");
  }
}
