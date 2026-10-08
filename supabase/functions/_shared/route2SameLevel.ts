/**
 * STEP 16-C — Route 2 same-level detection for a re-detected setup.
 *
 * When the scanner re-detects a setup for a symbol + direction that already
 * has a live `pending` order, an UNCHANGED level refreshes that order in place
 * (same order_id and signal_id, expires_at not extended) and a MOVED level
 * supersedes it (cancelled and replaced atomically in route2_place_order).
 *
 * This used to be `Number(a) === Number(b)`. The stored numeric entry price
 * and the freshly computed float can differ by representation noise
 * (0.8029075 vs 0.8029074999999999), which turned an unchanged level into a
 * supersede: a new order, a new signal_id, a reset hunt and a fresh 8-hour
 * window, defeating the fixed-lifetime rule.
 */

/**
 * Two levels within this distance, in PIPS, are the same level.
 *
 * Evidence (all 31 superseded orders in production, 2026-09-24 → 10-08, parsed
 * from cancel_reason "entry X vs old Y"):
 *   - 14 were float noise: |Δ| ≤ 4.5×10⁻¹³ in price (≈ 4.5×10⁻⁹ pips on FX);
 *   - 17 were genuine moves: the smallest, in pips (SPECS pip size), was
 *     1.015 pips (GBP/USD 1.3255765 → 1.325475); all others ≥ 1.7 pips.
 * 0.001 pip sits ≥ 5 orders of magnitude above the noise and ≥ 3 below the
 * smallest genuine move, so no genuine move can be absorbed.
 * Replayed case by case in step16SameLevelTolerance.test.ts.
 */
export const ROUTE2_SAME_LEVEL_TOLERANCE_PIPS = 0.001;

/** Distance between two price levels in pips (always ≥ 0). */
export function levelDistancePips(a: number, b: number, pipSize: number): number {
  return Math.abs(Number(a) - Number(b)) / pipSize;
}

/** True when the distance (in pips) is within the same-level tolerance (inclusive). */
export function isSameLevelPips(distancePips: number): boolean {
  return distancePips <= ROUTE2_SAME_LEVEL_TOLERANCE_PIPS;
}

/**
 * Same level, compared in pip space. A non-finite input or pip size is never
 * "same" (fails toward a supersede, the previous behaviour for any mismatch).
 */
export function isSameLevel(a: number, b: number, pipSize: number): boolean {
  if (!(pipSize > 0) || !Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return false;
  return isSameLevelPips(levelDistancePips(a, b, pipSize));
}

/** Split live orders into same-level (refresh in place) and moved (supersede). */
export function splitByLevel<T extends { entry_price: unknown }>(
  orders: T[], newPrice: number, pipSize: number,
): { same: T[]; moved: T[] } {
  const same: T[] = [], moved: T[] = [];
  for (const o of orders) (isSameLevel(Number(o.entry_price), newPrice, pipSize) ? same : moved).push(o);
  return { same, moved };
}
