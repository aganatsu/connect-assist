/**
 * Friday pre-close cutoff (owner request 2026-11-16). Bot Config → Sessions →
 * "No new trades before Friday close (minutes)". 0 = off (default).
 *
 * FX and metals stop trading Friday 17:00 New York (DST-aware, the same boundary
 * as sessions.isFxClosedAt). The last hour is thin and spreads widen: USD/CAD
 * 2026-11-13 opened two shorts at 21:25 and 21:55 UTC (35 and 5 minutes before the
 * close) on a market that moved ~10 pips that hour; both stopped out. Crypto trades
 * through the weekend and is never cut off. Not a proven edge — a risk rule.
 */
import { toNYTimeAt } from "./sessions.ts";

/** Config value → whole minutes, 0–600. Absent, non-numeric or ≤ 0 → 0 (off). */
export function resolveFridayCutoffMinutes(raw: unknown): number {
  const n = Number(raw);
  if (raw === undefined || raw === null || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(600, Math.round(n));
}

/** Minutes until the Friday 17:00 New York close, or null when it is not Friday before the close. */
export function minutesToFridayClose(utcMs: number): number | null {
  const ny = toNYTimeAt(utcMs);
  if (ny.nyDay !== 5) return null;
  const left = 17 * 60 - ny.tMin;
  return left > 0 ? left : null;
}

export type FridayCutoffVerdict = { pass: boolean; reason: string };

export function fridayCutoffGate(utcMs: number, cutoffMinutes: number, isCrypto: boolean): FridayCutoffVerdict {
  if (!(cutoffMinutes > 0)) return { pass: true, reason: "off" };
  if (isCrypto) return { pass: true, reason: "crypto trades through the weekend — no Friday cutoff" };
  const left = minutesToFridayClose(utcMs);
  if (left === null || left > cutoffMinutes) return { pass: true, reason: `Friday cutoff ${cutoffMinutes}min: not in window` };
  return { pass: false, reason: `Friday cutoff: ${left}min to the weekly close (no new trades in the last ${cutoffMinutes}min)` };
}
