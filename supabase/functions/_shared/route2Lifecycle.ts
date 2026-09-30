/**
 * ROUTE 2 CONFIRMATION LIFECYCLE — V2.
 *
 * Fixes two defects proven on forward order b64d4d7b (NZD/CAD short,
 * 2026-09-29), both visible for the first time because route2_poll_log
 * existed to record them.
 *
 * DEFECT 1 — STALE FORMING-BAR RE-ARM. Branch A arms on
 * `lastCandle.high >= entryPrice` evaluated against the FORMING entry-TF
 * bar. That bar's running high retains the touch for the whole bar, so once
 * it spikes through the level the arm condition stays true for up to 15
 * minutes regardless of where price actually is. Measured: armed 21:50:01,
 * reset 21:50:04, re-armed 21:51:01 off the same 21:45 bar — while the 1m
 * tape shows the only crossing was at 21:48 and highs at 21:49/50/51 were
 * 0.80117 / 0.80076 / 0.80051 against an entry of 0.80129. No new touch
 * existed. A touch is now an EVENT that is consumed, not a bar state.
 *
 * DEFECT 2 — RESET BEFORE THE CONFIRMATION TIMEFRAME CAN CLOSE. A Tier-1
 * close-based CHoCH needs at least one CLOSED confirm-TF bar after the
 * touch, so the minimum viable hunt is one confirm-TF period. The zone-exit
 * reset runs on instantaneous price against a refined zone whose median
 * width is 1.60 pips (0.094 H1 ATR), so it fires in seconds. Measured hunt
 * durations: 3.4 s and 60.0 s; 0 of 2 could contain a closed 5m bar. The two
 * clocks were in incompatible units. An ORDINARY zone departure can no
 * longer end a hunt before the confirmation logic has had one causal
 * opportunity to evaluate; a HARD invalidation still ends it immediately.
 *
 * NOT CHANGED HERE: refined zone geometry, refinedEntry, the 1.5 ATR cap,
 * the 8h TTL, confluence, the confirmation rules and tiers, stop/target,
 * Zone Story, the instrument universe. This module decides only WHEN a hunt
 * may start and WHEN it may be torn down.
 *
 * Pure: no clock, no database, no config reads. Both pollers call it, so
 * they cannot drift apart.
 */

/** V2 identity. Deliberately distinct from SMC_CONTRACT_VERSION. */
export const ROUTE2_LIFECYCLE_VERSION = "smc-route2-confirmation-lifecycle-v2";

// ─── touch identity ─────────────────────────────────────────────────────────

export type TouchVerdict = "NEW_TOUCH" | "ALREADY_CONSUMED_TOUCH" | "NEW_CROSS_AFTER_RESET";

/** Stable id for one touch event. Same bar + same arm count => same id. */
export function touchId(orderId: string, barTime: string | null, armCount: number): string {
  return `${orderId}:${barTime ?? "nobar"}:${armCount}`;
}

/**
 * The bar extreme that matters for a touch, given direction.
 *
 * A short is touched from BELOW by a rising high; a long from ABOVE by a
 * falling low.
 */
export function touchExtreme(direction: "long" | "short", high: number, low: number): number {
  return direction === "short" ? high : low;
}

/** Has the bar reached the entry level at all? */
export function barReachesEntry(
  direction: "long" | "short", high: number, low: number, entry: number,
): boolean {
  return direction === "short" ? high >= entry : low <= entry;
}

export interface TouchClassificationInput {
  direction: "long" | "short";
  entryPrice: number;
  /** Forming entry-TF bar currently observed. */
  barTime: string | null;
  barHigh: number;
  barLow: number;
  /** State carried on the order from the last consumed touch. */
  lastConsumedBarTime: string | null;
  lastConsumedExtreme: number | null;
}

/**
 * Decide whether this observation is a fresh touch event.
 *
 * Rules, in order:
 *   - the bar must actually reach the entry level, or there is no touch;
 *   - a DIFFERENT bar than the last consumed one is a new touch;
 *   - the SAME bar is a re-arm ONLY on explicit new evidence: the bar's
 *     directional extreme must have EXTENDED strictly beyond where it stood
 *     when the touch was consumed. That is a genuinely new crossing inside
 *     the bar, not the same spike being re-read.
 *
 * Anything else is ALREADY_CONSUMED_TOUCH. Returning "no new touch" is the
 * safe default: the cost is waiting for the next bar, whereas the cost of
 * guessing wrong is the arm/reset oscillation this replaces.
 */
export function classifyTouch(i: TouchClassificationInput): TouchVerdict | null {
  if (!barReachesEntry(i.direction, i.barHigh, i.barLow, i.entryPrice)) return null;
  if (i.lastConsumedBarTime === null) return "NEW_TOUCH";
  if (i.barTime !== i.lastConsumedBarTime) return "NEW_TOUCH";
  if (i.lastConsumedExtreme === null || !Number.isFinite(i.lastConsumedExtreme)) {
    return "ALREADY_CONSUMED_TOUCH";
  }
  const now = touchExtreme(i.direction, i.barHigh, i.barLow);
  const extended = i.direction === "short"
    ? now > i.lastConsumedExtreme
    : now < i.lastConsumedExtreme;
  return extended ? "NEW_CROSS_AFTER_RESET" : "ALREADY_CONSUMED_TOUCH";
}

// ─── minimum confirmation observation window ────────────────────────────────

/** Minutes in a confirmation timeframe string ("5m", "15m", "1h"). */
export function confirmTfMinutes(tf: string): number {
  const m = /^(\d+)\s*(m|min|h)$/i.exec(String(tf).trim());
  if (!m) return 5;
  const n = Number(m[1]);
  return /h/i.test(m[2]) ? n * 60 : n;
}

/**
 * The instant by which one complete confirmation candle will have closed
 * AFTER the touch.
 *
 * The bar containing the touch is not enough — it opened before the touch,
 * so a CHoCH detected in it could predate the event. The first bar that
 * both opens at/after the touch and closes is the first causal opportunity.
 *
 * touch 21:48 on a 5m TF -> next open 21:50 -> that bar closes 21:55.
 */
export function confirmationMinObservationUntil(touchIso: string, tf: string): string {
  const t = Date.parse(touchIso);
  if (!Number.isFinite(t)) throw new Error(`confirmationMinObservationUntil: bad instant "${touchIso}"`);
  const stepMs = confirmTfMinutes(tf) * 60_000;
  const nextOpen = Math.ceil(t / stepMs) * stepMs;
  return new Date(nextOpen + stepMs).toISOString();
}

/** Is the hunt still inside its protected observation window? */
export function withinMinObservation(nowIso: string, minUntilIso: string | null): boolean {
  if (!minUntilIso) return false;
  const n = Date.parse(nowIso), u = Date.parse(minUntilIso);
  return Number.isFinite(n) && Number.isFinite(u) && n < u;
}

// ─── reset severity ─────────────────────────────────────────────────────────

export type ResetSeverity = "HARD" | "ORDINARY";

/**
 * Every reset reason, classified once, in one place.
 *
 * HARD means the trade thesis itself is dead, so waiting for a confirmation
 * candle would be waiting to enter a setup that no longer exists. ORDINARY
 * means price merely left a zone whose median width is 1.6 pips — which is
 * the normal texture of a retest, not evidence against the setup.
 *
 * Nothing is reclassified silently: changing an entry here changes
 * documented behaviour and the tests below pin the table.
 */
export const RESET_SEVERITY: Record<string, ResetSeverity> = {
  // thesis-invalidating — may terminate immediately, even mid-window
  sl_invalidation: "HARD",
  impulse_broken: "HARD",
  direction_flip: "HARD",
  thesis_invalid: "HARD",
  refined_zone_close_through: "HARD",
  ttl_expiry: "HARD",
  superseded: "HARD",
  // ordinary zone departure — must not pre-empt the first confirmation close
  left_breach: "ORDINARY",
  left_favourable_far: "ORDINARY",
  left_favourable: "ORDINARY",
  zone_exit: "ORDINARY",
};

export function resetSeverity(reason: string): ResetSeverity {
  return RESET_SEVERITY[reason] ?? "HARD";   // unknown reasons fail safe: allow the kill
}

/**
 * May this reset fire now?
 *
 * HARD always may. ORDINARY may only once the protected window has elapsed —
 * i.e. once the confirmation logic has had at least one causal chance to
 * evaluate a closed bar.
 */
export function mayResetNow(
  reason: string, nowIso: string, minUntilIso: string | null,
): { allowed: boolean; severity: ResetSeverity; deferred: boolean } {
  const severity = resetSeverity(reason);
  if (severity === "HARD") return { allowed: true, severity, deferred: false };
  const held = withinMinObservation(nowIso, minUntilIso);
  return { allowed: !held, severity, deferred: held };
}
