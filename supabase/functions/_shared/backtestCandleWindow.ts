export interface TimestampedCandle {
  datetime: string;
}

function timestamp(value: string): number {
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? value
    : `${value}Z`;
  return new Date(normalized).getTime();
}

function lowerBound(
  candles: TimestampedCandle[],
  targetMs: number,
  includeEqual: boolean,
): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    const candleMs = timestamp(candles[mid].datetime);
    const belongsBefore = includeEqual
      ? candleMs <= targetMs
      : candleMs < targetMs;
    if (belongsBefore) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Returns only the most recent candles before a point in time.
 *
 * Backtests used to filter every historical candle on every bar and then take
 * the tail. The bounded binary-search form keeps the exact no-lookahead
 * semantics without repeatedly scanning and copying the full history.
 */
export function boundedCandlesBefore<T extends TimestampedCandle>(
  candles: T[],
  cutoffMs: number,
  maxItems: number,
  includeEqual = false,
): T[] {
  if (maxItems <= 0 || candles.length === 0) return [];
  const end = lowerBound(candles, cutoffMs, includeEqual);
  return candles.slice(Math.max(0, end - maxItems), end);
}

/**
 * Returns the forward candles that can resolve a replay observation.
 */
export function outcomeCandlesAfter<T extends TimestampedCandle>(
  candles: T[],
  observedMs: number,
  windowHours = 24,
): T[] {
  if (windowHours <= 0 || candles.length === 0) return [];
  const start = lowerBound(candles, observedMs, true);
  const endMs = observedMs + windowHours * 60 * 60 * 1000;
  const end = lowerBound(candles, endMs, true);
  return candles.slice(start, end);
}

export function utcDayStart(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
}
