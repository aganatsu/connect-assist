import type { Candle } from "./smcAnalysis.ts";

export interface PendingZoneTouchInput {
  candles: Candle[];
  direction: "long" | "short";
  entryPrice: number;
  observedAfter: string;
  interval: string;
}

export interface PendingZoneTouchResult {
  touchTime: string | null;
  checkedAt: string;
  candlesChecked: number;
}

function finiteTime(value: string): number | null {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function pendingTouchIntervalMinutes(value: string): number | null {
  const match = /^(\d+)(m|h|d|w|M)$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "m" ? 1 : unit === "h" ? 60 : unit === "d" ? 1_440 : unit === "w" ? 10_080 : 43_200;
  return amount * multiplier;
}

/** Cursor used after a completed touch attempt so that touch cannot replay. */
export function cursorAfterLatestTouchCandle(
  candles: Candle[],
  interval: string,
  fallback = new Date().toISOString(),
): string {
  const minutes = pendingTouchIntervalMinutes(interval);
  const latest = candles
    .map((candle) => finiteTime(candle.datetime))
    .filter((value): value is number => value !== null)
    .sort((a, b) => b - a)[0];
  if (minutes === null || latest === undefined) return fallback;
  return new Date(latest + minutes * 60_000).toISOString();
}

/** Finds the earliest touch among candles not fully covered by the prior scan. */
export function findEarliestPendingZoneTouch(
  input: PendingZoneTouchInput,
  checkedAt = new Date().toISOString(),
): PendingZoneTouchResult {
  const observedAfterMs = finiteTime(input.observedAfter);
  const minutes = pendingTouchIntervalMinutes(input.interval);
  const intervalMs = minutes === null ? Number.NaN : minutes * 60_000;
  if (
    observedAfterMs === null || !Number.isFinite(input.entryPrice) ||
    !Number.isFinite(intervalMs) || intervalMs <= 0
  ) {
    return { touchTime: null, checkedAt, candlesChecked: 0 };
  }

  const eligible = input.candles
    .map((candle) => ({ candle, startedAt: finiteTime(candle.datetime) }))
    .filter(
      (item): item is { candle: Candle; startedAt: number } =>
        item.startedAt !== null && item.startedAt + intervalMs > observedAfterMs,
    )
    .sort((a, b) => a.startedAt - b.startedAt);

  for (const { candle, startedAt } of eligible) {
    const touched = input.direction === "long"
      ? candle.low <= input.entryPrice
      : candle.high >= input.entryPrice;
    if (touched) {
      // OHLC data cannot identify the intrabar second. Never claim a touch
      // before the setup existed or before the previous scan observed the bar.
      return {
        touchTime: new Date(Math.max(startedAt, observedAfterMs)).toISOString(),
        checkedAt,
        candlesChecked: eligible.length,
      };
    }
  }

  return { touchTime: null, checkedAt, candlesChecked: eligible.length };
}

