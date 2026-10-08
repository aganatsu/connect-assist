/**
 * STEP 17-A — Route 2 fill-floor re-anchor (DRY RUN ONLY; the live fill path
 * does not call this).
 *
 * The stop is anchored to the LIMIT with |limit − stop| ≥ floor (step 10). The
 * hunt fills at the confirmation price and the stop did not move, so a better
 * fill sat inside the floor (5 of 8 dry-run fills, 0.72–6.45 pips). Approved
 * policy (2026-10-08):
 *   fill → stop ≥ floor            → nothing changes;
 *   fill → stop < floor            → stop = fill ∓ floor; target = fill ± floor × tpRatio;
 *                                    the caller re-sizes at 0.5% on the new distance.
 * It never tightens a stop, and it does not silently break an existing
 * constraint — a re-anchor that would is REJECTED (tagged with the reason) and
 * the fill keeps its original geometry, exactly as before:
 *   floor_unknown       the order recorded no floor (route2Stop.floorPips);
 *   fill_through_stop   the fill is at / beyond the stop (no valid long/short geometry);
 *   exceeds_stop_cap    the floor distance exceeds the order's recorded stop cap;
 *   order_rr_below_min  the re-anchored order fails the order-geometry R:R gate
 *                       (same orderEffectiveRR and `< orderRRMin` as placement).
 */
import { orderEffectiveRR } from "./simplification.ts";

export const FILL_REANCHOR_VERSION = "route2_fill_reanchor.v1";

export interface ReanchorInput {
  symbol: string;
  direction: "long" | "short";
  fillPrice: number;
  stop: number;
  target: number;
  floorPips: number | null;
  capPips: number | null;
  pipSize: number;
  tpRatio: number;
  orderRRMin: number;
  rateMap?: Record<string, number>;
  commissionPerLot?: number;
}

export type RejectReason = "floor_unknown" | "fill_through_stop" | "exceeds_stop_cap" | "order_rr_below_min";

export type ReanchorResult =
  | { status: "not_needed"; fillToStopPips: number; floorPips: number }
  | {
    status: "reanchored"; originalStop: number; originalTarget: number; stop: number; target: number;
    fillToOriginalStopPips: number; stopDistancePips: number; floorPips: number;
    rawRR: number; effectiveRR: number; costInPrice: number;
  }
  | { status: "rejected"; reason: RejectReason; detail: string; fillToStopPips: number | null; floorPips: number | null };

export function reanchorFill(i: ReanchorInput): ReanchorResult {
  const long = i.direction === "long";
  const signedPips = (long ? i.fillPrice - i.stop : i.stop - i.fillPrice) / i.pipSize; // > 0 when the stop is on the right side
  const floor = i.floorPips;
  if (!(typeof floor === "number" && Number.isFinite(floor) && floor > 0)) {
    return { status: "rejected", reason: "floor_unknown", detail: "order has no recorded route2Stop.floorPips", fillToStopPips: signedPips, floorPips: null };
  }
  if (!(signedPips > 0)) {
    return { status: "rejected", reason: "fill_through_stop", detail: `fill ${i.fillPrice} is at or beyond the stop ${i.stop}`, fillToStopPips: signedPips, floorPips: floor };
  }
  // same inside-floor test the fill-sizing record uses
  if (!(signedPips < floor - 1e-9)) return { status: "not_needed", fillToStopPips: signedPips, floorPips: floor };

  if (typeof i.capPips === "number" && Number.isFinite(i.capPips) && floor > i.capPips + 1e-9) {
    return { status: "rejected", reason: "exceeds_stop_cap", detail: `floor ${floor}p exceeds the order's stop cap ${i.capPips}p`, fillToStopPips: signedPips, floorPips: floor };
  }
  const dist = floor * i.pipSize;
  const stop = long ? i.fillPrice - dist : i.fillPrice + dist;
  const target = long ? i.fillPrice + dist * i.tpRatio : i.fillPrice - dist * i.tpRatio;
  const orr = orderEffectiveRR({ entry: i.fillPrice, stop, target, symbol: i.symbol, rateMap: i.rateMap, commissionPerLot: i.commissionPerLot });
  if (orr.effectiveRR < i.orderRRMin) {
    return {
      status: "rejected", reason: "order_rr_below_min",
      detail: `re-anchored effective R:R ${orr.effectiveRR.toFixed(4)} (${orr.rawRR.toFixed(2)} raw, cost ${orr.costInPrice}) < ${i.orderRRMin}`,
      fillToStopPips: signedPips, floorPips: floor,
    };
  }
  return {
    status: "reanchored", originalStop: i.stop, originalTarget: i.target, stop, target,
    fillToOriginalStopPips: signedPips, stopDistancePips: floor, floorPips: floor,
    rawRR: orr.rawRR, effectiveRR: orr.effectiveRR, costInPrice: orr.costInPrice,
  };
}

/**
 * What the dry-run fill records. Re-anchored: the new stop / target, sizing at
 * 0.5% on the new distance (stopDistancePips = the final distance), and the
 * re-anchor record. Not needed / rejected: the original geometry and sizing,
 * unchanged. `insideFloor` keeps its Step 15 meaning — where the fill LANDED
 * against the planned stop, before any re-anchor.
 */
export function dryRunFillGeometry(a: {
  input: ReanchorInput;
  baseSizing: Record<string, unknown> | null;
  resize: (stop: number) => { ok: boolean; reason?: string | null; stopDistance?: number; riskUsdActual?: number } & Record<string, unknown> | null;
}): { stop: number; target: number; sizing: Record<string, unknown>; record: Record<string, unknown> } {
  const r = reanchorFill(a.input);
  const base = a.baseSizing ?? {};
  if (r.status !== "reanchored") {
    const record = { version: FILL_REANCHOR_VERSION, ...r, fillPrice: a.input.fillPrice, plannedStop: a.input.stop, plannedTarget: a.input.target };
    return { stop: a.input.stop, target: a.input.target, sizing: { ...base, reanchor: record }, record };
  }
  const s = a.resize(r.stop);
  if (s && !s.ok) {
    const record = {
      version: FILL_REANCHOR_VERSION, status: "rejected", reason: "sizing_unavailable", detail: s.reason ?? "fill-time sizing failed",
      fillToStopPips: r.fillToOriginalStopPips, floorPips: r.floorPips, fillPrice: a.input.fillPrice, plannedStop: a.input.stop, plannedTarget: a.input.target,
    };
    return { stop: a.input.stop, target: a.input.target, sizing: { ...base, reanchor: record }, record };
  }
  const record = {
    version: FILL_REANCHOR_VERSION, ...r, fillPrice: a.input.fillPrice, plannedStop: a.input.stop, plannedTarget: a.input.target,
    riskUsd: s?.riskUsdActual ?? null,
  };
  const sizing = s
    ? { ...s, stopDistancePips: (s.stopDistance as number) / a.input.pipSize, insideFloor: base.insideFloor ?? true, reanchor: record }
    : { ...base, stopDistancePips: r.stopDistancePips, reanchor: record };
  return { stop: r.stop, target: r.target, sizing, record };
}
