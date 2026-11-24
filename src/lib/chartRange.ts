/**
 * Keeping the user's zoom/scroll when a chart is rebuilt.
 *
 * The chart page refetches candles, positions (15 s) and the bot scan (30 s). The Bot View
 * chart is rebuilt when what it draws changes, and a rebuild used to snap back to the default
 * view — so zooming in lasted until the next refetch. The range is saved as distances from the
 * newest bar, so a new candle keeps the same window (sliding with price when you are at the
 * right edge), and restored only while the chart is the same pair, timeframe and trade.
 */
export interface LogicalRange { from: number; to: number }
export interface SavedRange { key: string; fromEnd: number; toEnd: number }

export function saveRange(key: string, barCount: number, r: LogicalRange): SavedRange {
  return { key, fromEnd: barCount - r.from, toEnd: barCount - r.to };
}

export function restoreRange(saved: SavedRange | null, key: string, barCount: number): LogicalRange | null {
  if (!saved || saved.key !== key) return null;
  return { from: barCount - saved.fromEnd, to: barCount - saved.toEnd };
}

/** The bar interval in seconds: the smallest gap between the first bars (weekend gaps are larger). */
export function barSpacingSec(times: number[]): number {
  let best = Infinity;
  for (let i = 1; i < Math.min(times.length, 30); i++) {
    const d = times[i] - times[i - 1];
    if (d > 0 && d < best) best = d;
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * What a trade looks like on the chart, minus the numbers that move with price (running R,
 * current price, P&L) — those update every positions refetch and must not rebuild the chart.
 * A closed trade's R is fixed and is drawn in its exit marker, so it stays in.
 */
export function tradeShapeKey<T extends { status: string; r: number | null; exitPrice: number | null; pnl: number | null }>(t: T): string {
  return JSON.stringify({ ...t, r: t.status === "closed" ? t.r : null, exitPrice: t.status === "closed" ? t.exitPrice : null, pnl: null });
}
