/**
 * WEEKEND_BARS_PREREG_V1 (docs/WEEKEND_BARS_PREREG_V1.md).
 *
 * TwelveData sends bars for the FX weekend (Fri 17:00 → Sun 17:00 New York), when the
 * market is shut. A broker or TradingView FX chart has none. The SMC analysis drops them
 * (fxRealBars). So a forex series keeps its usual count of REAL bars after the drop, the
 * fetch asks for enough extra bars to cover the weekends inside it (weekendAllowance).
 * Without that, 300 5m bars early on Monday are mostly weekend, leaving a few dozen.
 */
import { SPECS, type Candle } from "./smcAnalysis.ts";
import { dropFxClosedBars } from "./sessions.ts";

const INTERVAL_HOURS: Record<string, number> = { "1m": 1 / 60, "5m": 1 / 12, "15m": 0.25, "30m": 0.5, "1h": 1, "4h": 4 };

/** Extra bars to fetch so `limit` real bars survive the weekend drop. 0 for daily/weekly. */
export function weekendAllowance(interval: string, limit: number): number {
  const h = INTERVAL_HOURS[interval];
  if (!h) return 0;
  const weekends = Math.floor((limit * h) / 120) + 1;     // 120 open hours per week
  return weekends * Math.ceil(48 / h);                    // 48 closed hours per weekend
}

export const isForexSymbol = (symbol: string): boolean => SPECS[symbol]?.type === "forex";

/**
 * The series without FX weekend bars, at the same length as `bars` (real bars only).
 * Uses `deep` (this scan's deeper fetch) when it ends on the same bar as `bars`;
 * otherwise (e.g. daily from the persistent cache) drops from `bars` and comes back shorter.
 * Non-forex, or `enabled` false: `bars` unchanged.
 */
export function fxRealBars(symbol: string, bars: Candle[], enabled: boolean, deep?: Candle[] | null): Candle[] {
  if (!enabled || !isForexSymbol(symbol) || !bars?.length) return bars;
  const src = deep && deep.length > bars.length && deep[deep.length - 1].datetime === bars[bars.length - 1].datetime ? deep : bars;
  return dropFxClosedBars(src, true).slice(-bars.length);
}
