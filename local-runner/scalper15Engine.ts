/**
 * SCALPER15_PREREG_V1 — the backtest-only parts (docs/SCALPER15_PREREG_V1.md): closed-bar
 * lookup, cost-inclusive fills and the 1m exit resolver. The strategy itself — 1H bias, zone,
 * stop, target, R admission — is _shared/scalper15.ts, the module bot-scanner trades with.
 * No I/O and no provider import, so the tests run without a key.
 */

import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import type { Dir } from "../supabase/functions/_shared/scalper15.ts";

export const MIN = 60_000;
export const H = 60 * MIN;

/** All-in round trip (spread + commission), pips. Frozen in the pre-registration. */
export const COST_PIPS: Record<string, number> = {
  "EUR/USD": 1.5, "GBP/USD": 2.0, "USD/JPY": 1.8, "AUD/USD": 2.0,
  "NZD/USD": 2.5, "USD/CAD": 2.0, "USD/CHF": 2.0,
};
export const STOP_SLIP_PIPS = 0.3;
export const ZONE_LIFETIME_MS = 480 * MIN;
export const pipOf = (sym: string) => (sym.includes("JPY") ? 0.01 : 0.0001);

/**
 * Spot FX is shut at the weekend but TwelveData serves a moving 24/7 tape. Same rule as
 * smc-corpus-fetch.ts `tradeableAt` (restated: that module loads the API key on import).
 */
export function tradeableAt(tMs: number): boolean {
  const d = new Date(tMs);
  const day = d.getUTCDay(), hr = d.getUTCHours();
  if (day === 6) return false;
  if (day === 0) return hr >= 22;
  if (day === 5) return hr < 22;
  return true;
}

/** Index of the last bar CLOSED at t (open + tf ≤ t), or −1. Bars sorted by open time. */
export function lastClosedIndex(openMs: number[], tfMs: number, t: number): number {
  let lo = 0, hi = openMs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (openMs[mid] + tfMs <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Market fill: a long buys at the ask (mid + S/2), a short sells at the bid. */
export const entryFill = (midOpen: number, dir: Dir, sPrice: number) => midOpen + dir * sPrice / 2;

export type ExitReason = "STOP" | "STOP_GAP" | "TARGET" | "AMBIGUOUS" | "OPEN";
export interface ExitResult { exitIdx: number; exitMs: number; exit: number; reason: ExitReason; altExit?: number }

/**
 * Walk 1m bars from the entry bar. Like the live bot, a position is held over the weekend:
 * the weekend tape is skipped and a Monday open beyond the stop fills at that open. Exits trigger on the side the position closes on
 * (a long's stop and target on the bid = mid − S/2). Stop and target both reachable inside
 * one minute is AMBIGUOUS: `exit` carries the conservative (stop) fill, `altExit` the target.
 */
export function resolveExit(m1: Candle[], startIdx: number, dir: Dir, stop: number, target: number, sPrice: number, slip: number): ExitResult {
  const half = sPrice / 2;
  for (let i = startIdx; i < m1.length; i++) {
    const b = m1[i], t = Date.parse(b.datetime);
    if (!tradeableAt(t)) continue;
    const side = (p: number) => p - dir * half;   // the price the position can close at
    const o = side(b.open), hi = side(b.high), lo = side(b.low);
    const gap = dir === 1 ? o <= stop : o >= stop;
    if (gap && i > startIdx) return { exitIdx: i, exitMs: t, exit: o - dir * slip, reason: "STOP_GAP" };
    const stopHit = gap || (dir === 1 ? lo <= stop : hi >= stop);
    const tgtHit = dir === 1 ? hi >= target : lo <= target;
    const stopFill = gap ? o - dir * slip : stop - dir * slip;
    if (stopHit && tgtHit) return { exitIdx: i, exitMs: t, exit: stopFill, reason: "AMBIGUOUS", altExit: target };
    if (stopHit) return { exitIdx: i, exitMs: t, exit: stopFill, reason: gap ? "STOP_GAP" : "STOP" };
    if (tgtHit) return { exitIdx: i, exitMs: t, exit: target, reason: "TARGET" };
  }
  const last = m1.length - 1;
  return { exitIdx: last, exitMs: Date.parse(m1[last].datetime), exit: m1[last].close - dir * half, reason: "OPEN" };
}
