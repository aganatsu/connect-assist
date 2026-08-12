/**
 * Pure behavior decisions driven directly by the canonical Bot Config.
 *
 * Keep these decisions small and testable so a visible control cannot be
 * silently overridden inside a scanner route.
 */

export interface PendingZoneOrderDecisionInput {
  pendingZoneOrdersEnabled: boolean;
  useMarketFillAtZone: boolean;
  hasLimitEntry: boolean;
}

export function shouldCreatePendingZoneOrder(
  input: PendingZoneOrderDecisionInput,
): boolean {
  return input.pendingZoneOrdersEnabled &&
    !input.useMarketFillAtZone &&
    input.hasLimitEntry;
}

// ── Pending order supersede ──────────────────────────────────────────
//
// bot-scanner re-detects setups every scan cycle. When a pending order already
// exists for the same symbol+direction it was cancelled and replaced
// unconditionally, on the reasoning that "market evolves — a new setup is a
// different trade idea". Production said otherwise:
//
//   Superseded by new setup (score 39.2 vs old 39.2, entry 1.4043 vs old 1.4043)
//   Superseded by new setup (score 27.7 vs old 27.7, entry 1.14413 vs old 1.14413)
//
// Identical score, identical entry — the same setup replacing itself every
// cycle. That is not cosmetic. zone_touch_time and confirmation_attempts live
// on the pending order row, and zone-confirmation-scanner uses zone_touch_time
// to anchor its CHoCH search (zoneTouchIdx). Recreating the row nulls both, so
// the confirmation hunt restarts from zero every scan and can only succeed if
// CHoCH happens to land inside one 5-minute gap.
//
// Measured: 1,047 cancelled pending orders, of which ~542 were supersedes, and
// no pending order has filled since 2026-05-15.
//
// So an order is now replaced only when the setup MATERIALLY changed. An
// unchanged setup leaves the existing order — and its accumulated zone-touch
// and confirmation state — alone.

export interface SupersedeDecisionInput {
  newEntry: number;
  newStopLoss: number;
  newTakeProfit: number;
  newScore: number;
  existingEntry: number;
  existingStopLoss: number;
  existingTakeProfit: number;
  existingScore: number | null;
  /** High minus low of the zone the entry came from. Used to scale tolerance. */
  zoneWidth: number;
}

export interface SupersedeDecision {
  supersede: boolean;
  reason: string;
}

/**
 * Price tolerance as a fraction of zone width.
 *
 * Expressed relative to the zone rather than in pips so it works unchanged
 * across FX, gold and crypto — a 1-pip absolute tolerance is meaningless on
 * BTC/USD and enormous on a tight FVG.
 */
const SUPERSEDE_PRICE_TOLERANCE_FRACTION = 0.05;

/** Score movement below this is noise from recalculation, not a new idea. */
const SUPERSEDE_SCORE_DELTA = 5;

export function shouldSupersedePendingOrder(
  input: SupersedeDecisionInput,
): SupersedeDecision {
  const width = Number.isFinite(input.zoneWidth) && input.zoneWidth > 0 ? input.zoneWidth : 0;
  // Fall back to a relative epsilon when zone width is unavailable, so a
  // missing zone cannot make the tolerance zero and reinstate the churn.
  const tolerance = width > 0
    ? width * SUPERSEDE_PRICE_TOLERANCE_FRACTION
    : Math.abs(input.newEntry) * 1e-6;

  const moved = (a: number, b: number) => Math.abs(a - b) > tolerance;

  if (moved(input.newEntry, input.existingEntry)) {
    return { supersede: true, reason: "entry moved" };
  }
  if (moved(input.newStopLoss, input.existingStopLoss)) {
    return { supersede: true, reason: "stop moved" };
  }
  if (moved(input.newTakeProfit, input.existingTakeProfit)) {
    return { supersede: true, reason: "target moved" };
  }
  // A null existing score is old data, not evidence of change — do not churn on it.
  if (
    input.existingScore != null &&
    Math.abs(input.newScore - input.existingScore) >= SUPERSEDE_SCORE_DELTA
  ) {
    return { supersede: true, reason: "score changed materially" };
  }

  return { supersede: false, reason: "unchanged setup — existing order retained" };
}
