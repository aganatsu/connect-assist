/**
 * BOS close-strength gate (owner rule, 2026-11-06). Bot Config → Strategy → "Min BOS Close Strength".
 *
 * The measure is the Zone Story's "Closes: BOS n%": where the impulse's break-of-structure candle
 * closed within its own range, toward the move (100% = at the extreme, 0% = back at the start).
 *
 * The owner set 70% from 12 demo trades (+0.76R vs −0.34R below). The pre-registered replay of
 * 889 trades (docs/BREAK_STRENGTH_PREREG_V1.md) did not confirm it: ≥70% −0.053R vs <70% −0.103R,
 * equal in the second half. It is a choice, not a proven edge; 0 switches it off.
 */

/** Config value (percent, 0–100) → fraction 0–1. Absent, non-numeric or ≤ 0 → 0 (off). */
export function resolveMinBosClose(raw: unknown): number {
  const n = Number(raw);
  if (raw === undefined || raw === null || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, n) / 100;
}

export type BosCloseVerdict =
  | { pass: true; measured: boolean; reason: string }
  | { pass: false; measured: true; reason: string };

/** A setup whose leg did not report the measure is not blocked (and says so). */
export function bosCloseGate(bosClose: number | null | undefined, min: number): BosCloseVerdict {
  if (!(min > 0)) return { pass: true, measured: bosClose != null, reason: "off" };
  if (bosClose == null || !Number.isFinite(bosClose)) {
    return { pass: true, measured: false, reason: `BOS close not measured — not blocked (min ${Math.round(min * 100)}%)` };
  }
  const pct = Math.round(bosClose * 100), minPct = Math.round(min * 100);
  return bosClose >= min
    ? { pass: true, measured: true, reason: `BOS close ${pct}% ≥ ${minPct}%` }
    : { pass: false, measured: true, reason: `BOS close ${pct}% < ${minPct}% — break candle closed weakly` };
}
