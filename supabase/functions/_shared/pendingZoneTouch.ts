import type { Candle } from "./smcAnalysis.ts";
import { normalizeAnalysisTimeframe } from "./timeframeAuthority.ts";
import {
  type NestedPoiEntryPlan,
  type NestedPoiTriggerCandidate,
} from "./impulseZoneEngine.ts";

export interface ExactPriceRange {
  low: number;
  high: number;
}

export type ExactNestedPoiTrigger = Pick<
  NestedPoiTriggerCandidate,
  "low" | "high"
>;

export type ExactNestedPoiOuterZone = NestedPoiEntryPlan["outerZone"];

export interface NestedPoiTriggerTouchInput {
  candles: Candle[];
  trigger: ExactNestedPoiTrigger;
  observedAfter: string;
  interval: string;
}

export interface PendingZoneTouchInput {
  candles: Candle[];
  direction: "long" | "short";
  entryPrice?: number;
  zoneLow?: number;
  zoneHigh?: number;
  observedAfter: string;
  interval: string;
}

export interface PendingZoneTouchResult {
  touchTime: string | null;
  checkedAt: string;
  candlesChecked: number;
}

export interface CompletedCandleCursorInput {
  candles: Candle[];
  observedAfter: string;
  interval: string;
}

function finiteTime(value: string): number | null {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedRange(
  low: unknown,
  high: unknown,
): ExactPriceRange | null {
  const parsedLow = Number(low);
  const parsedHigh = Number(high);
  if (!Number.isFinite(parsedLow) || !Number.isFinite(parsedHigh)) return null;
  return parsedHigh >= parsedLow ? { low: parsedLow, high: parsedHigh } : null;
}

/** Exact OHLC overlap. Callers must supply completed candles. */
export function closedCandleTouchesRange(
  candle: Candle,
  range: ExactPriceRange,
): boolean {
  const normalized = normalizedRange(range.low, range.high);
  return !!normalized && Number.isFinite(candle.low) &&
    Number.isFinite(candle.high) && candle.high >= normalized.low &&
    candle.low <= normalized.high;
}

/** Exact level crossing. No midpoint, proximity, spread, or ATR buffer applies. */
export function closedCandleTouchesLevel(
  candle: Candle,
  level: number,
): boolean {
  return Number.isFinite(level) && closedCandleTouchesRange(candle, {
    low: level,
    high: level,
  });
}

export function closedCandleTouchesNestedPoiOuterZone(
  candle: Candle,
  outerZone: ExactNestedPoiOuterZone,
): boolean {
  return closedCandleTouchesRange(candle, outerZone);
}

/** Delegates nested-trigger overlap to the exact completed-candle touch owner. */
export function closedCandleTouchesNestedPoiTrigger(
  candle: Candle,
  trigger: ExactNestedPoiTrigger,
): boolean {
  return closedCandleTouchesRange(candle, trigger);
}

export function pendingTouchIntervalMinutes(value: string): number | null {
  // Normalise first. runtimeEntry is config.entryTimeframe verbatim, and the
  // stored values are long-form: configMapper defaults to "15min" and the
  // day_trader profile sets "15min". A strict short-form regex returns null for
  // those, which made intervalMs NaN and the guard in
  // findEarliestPendingZoneTouch return "no touch" for every candle regardless
  // of price — touch detection silently off, with no error and no log.
  //
  // normalizeAnalysisTimeframe is the existing owner of this conversion and
  // already maps 15min/5min/30min/60min/1day/1week/monthly to the canonical
  // short forms.
  const match = /^(\d+)(m|h|d|w|M)$/.exec(
    normalizeAnalysisTimeframe(value, "15m"),
  );
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "m"
    ? 1
    : unit === "h"
    ? 60
    : unit === "d"
    ? 1_440
    : unit === "w"
    ? 10_080
    : 43_200;
  return amount * multiplier;
}

/**
 * Returns completed candles whose time window was not fully covered by the
 * prior observation. A candle that started before the cursor but closed after
 * it remains eligible, so the first post-touch candle cannot be skipped.
 */
export function completedCandlesSinceCursor(
  input: CompletedCandleCursorInput,
): Candle[] {
  const observedAfterMs = finiteTime(input.observedAfter);
  const minutes = pendingTouchIntervalMinutes(input.interval);
  const intervalMs = minutes === null ? Number.NaN : minutes * 60_000;
  if (
    observedAfterMs === null || !Number.isFinite(intervalMs) || intervalMs <= 0
  ) return [];

  return input.candles
    .map((candle) => ({ candle, startedAt: finiteTime(candle.datetime) }))
    .filter(
      (item): item is { candle: Candle; startedAt: number } =>
        item.startedAt !== null &&
        item.startedAt + intervalMs > observedAfterMs,
    )
    .sort((left, right) => left.startedAt - right.startedAt)
    .map((item) => item.candle);
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
  const zone = normalizedRange(input.zoneLow, input.zoneHigh);
  const entryPrice = Number(input.entryPrice);
  const hasLegacyEntry = Number.isFinite(entryPrice);
  if (
    observedAfterMs === null || (!zone && !hasLegacyEntry) ||
    !Number.isFinite(intervalMs) || intervalMs <= 0
  ) {
    return { touchTime: null, checkedAt, candlesChecked: 0 };
  }

  const eligible = completedCandlesSinceCursor(input).map((candle) => ({
    candle,
    startedAt: finiteTime(candle.datetime)!,
  }));

  for (const { candle, startedAt } of eligible) {
    const touched = zone
      ? closedCandleTouchesRange(candle, zone)
      : input.direction === "long"
      ? candle.low <= entryPrice
      : candle.high >= entryPrice;
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

/** Finds the first exact nested-trigger touch on completed candles. */
export function findEarliestNestedPoiTriggerTouch(
  input: NestedPoiTriggerTouchInput,
  checkedAt = new Date().toISOString(),
): PendingZoneTouchResult {
  return findEarliestPendingZoneTouch({
    candles: input.candles,
    direction: "long",
    zoneLow: input.trigger.low,
    zoneHigh: input.trigger.high,
    observedAfter: input.observedAfter,
    interval: input.interval,
  }, checkedAt);
}
