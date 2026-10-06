/**
 * STEP 10 — Route 2 stop anchored to the ORDER's entry.
 *
 * The stop chain (swing stop → minimum-stop floor → Impulse-origin override →
 * cap) measured every distance from the MARKET price at scan time, and the
 * Route 2 order then kept that absolute stop with its own limit entry. In the
 * 8 days before the reset, 33 of 53 FX Route 2 orders had a limit→stop
 * distance BELOW the floor the chain thought it had enforced (median 0.67× of
 * the checked distance).
 *
 * Same rules, measured from the limit entry the order will actually use:
 *   1. swing (structural) stop, if on the correct side of the limit;
 *   2. Impulse-origin stop instead, if farther from the limit and within the
 *      cap (cap also measured from the limit);
 *   3. if the result is missing or closer than the floor → limit ∓ floor;
 *   4. target = limit ± risk × tpRatio.
 */

export interface StopGeometryInput {
  direction: "long" | "short";
  limit: number;
  /** Structural (swing) stop before any floor widening. */
  swingSL: number | null;
  /** Impulse-origin stop (origin ∓ buffer), if an impulse leg exists. */
  impulseSL: number | null;
  /** Maximum distance in pips for the Impulse stop (same cap rule as the market chain). */
  impulseCapPips: number | null;
  /** Minimum stop distance in pips (effective floor). */
  minSlPips: number;
  pipSize: number;
  tpRatio: number;
}

export interface StopGeometry {
  ok: boolean;
  reason: string | null;
  sl: number;
  tp: number;
  riskPips: number;
  source: "swing" | "impulse" | "floor";
  widenedToFloor: boolean;
  impulseRejected: "wrong_side" | "not_wider" | "over_cap" | null;
}

export function route2StopFromLimit(i: StopGeometryInput): StopGeometry {
  const sideOk = (sl: number | null): sl is number =>
    sl != null && Number.isFinite(sl) && (i.direction === "long" ? sl < i.limit : sl > i.limit);
  const dist = (sl: number) => Math.abs(i.limit - sl) / i.pipSize;
  const fail = (reason: string): StopGeometry => ({ ok: false, reason, sl: NaN, tp: NaN, riskPips: NaN, source: "floor", widenedToFloor: false, impulseRejected: null });
  if (!(i.limit > 0) || !(i.pipSize > 0) || !(i.minSlPips > 0) || !(i.tpRatio > 0)) return fail("invalid geometry inputs");

  let sl: number | null = sideOk(i.swingSL) ? i.swingSL : null;
  let source: StopGeometry["source"] = "swing";
  let impulseRejected: StopGeometry["impulseRejected"] = null;

  if (i.impulseSL != null) {
    if (!sideOk(i.impulseSL)) impulseRejected = "wrong_side";
    else if (sl != null && dist(i.impulseSL) <= dist(sl)) impulseRejected = "not_wider";
    else if (i.impulseCapPips != null && dist(i.impulseSL) > i.impulseCapPips) impulseRejected = "over_cap";
    else { sl = i.impulseSL; source = "impulse"; }
  }

  let widenedToFloor = false;
  if (sl == null || dist(sl) < i.minSlPips) {
    sl = i.direction === "long" ? i.limit - i.minSlPips * i.pipSize : i.limit + i.minSlPips * i.pipSize;
    source = "floor";
    widenedToFloor = true;
  }
  const risk = Math.abs(i.limit - sl);
  const tp = i.direction === "long" ? i.limit + risk * i.tpRatio : i.limit - risk * i.tpRatio;
  return { ok: true, reason: null, sl, tp, riskPips: risk / i.pipSize, source, widenedToFloor, impulseRejected };
}
