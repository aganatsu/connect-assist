/**
 * Pure behavior decisions driven directly by the canonical Bot Config.
 *
 * Keep these decisions small and testable so a visible control cannot be
 * silently overridden inside a scanner route.
 */

export type NestedPoiMarketMode =
  | "off"
  | "observe"
  | "enforce_paper"
  | "enforce_live";

/** Route frozen with a setup after rollout scope is resolved. */
export type NestedPoiMarketRoute = "observe" | "nested_poi_market";

export function normalizeNestedPoiMarketMode(
  value: unknown,
): NestedPoiMarketMode {
  return value === "observe" || value === "enforce_paper" ||
      value === "enforce_live"
    ? value
    : "off";
}

export interface NestedPoiMarketActivation {
  mode: NestedPoiMarketMode;
  enabled: boolean;
  observing: boolean;
  enforced: boolean;
  route: "legacy" | NestedPoiMarketRoute;
  runtimeTarget: "paper" | "live";
}

/**
 * Resolves the one rollout policy shared by live scanning and backtest.
 * Paper+Live is explicit; Paper never changes live execution.
 */
export function resolveNestedPoiMarketActivation(input: {
  marketFillAtZone: boolean;
  mode: unknown;
  runtimeTarget: "paper" | "live";
}): NestedPoiMarketActivation {
  const mode = normalizeNestedPoiMarketMode(input.mode);
  const enabled = input.marketFillAtZone && mode !== "off";
  const enforced = enabled &&
    (mode === "enforce_live" ||
      (mode === "enforce_paper" && input.runtimeTarget === "paper"));
  const route = !enabled
    ? "legacy"
    : enforced
    ? "nested_poi_market"
    : "observe";
  return {
    mode,
    enabled,
    observing: route === "observe",
    enforced,
    route,
    runtimeTarget: input.runtimeTarget,
  };
}

export function normalizeNestedPoiMarketRoute(
  value: unknown,
): NestedPoiMarketRoute | null {
  return value === "observe" || value === "nested_poi_market" ? value : null;
}

export function isNestedPoiMarketRouteCompatible(input: {
  mode: unknown;
  route: unknown;
}): boolean {
  const mode = normalizeNestedPoiMarketMode(input.mode);
  const route = normalizeNestedPoiMarketRoute(input.route);
  return !!route && mode !== "off" &&
    !(mode === "observe" && route !== "observe") &&
    !(mode === "enforce_live" && route !== "nested_poi_market");
}

/**
 * A frozen route never upgrades because the account target or settings change.
 * A paper-only executable route still fails closed if the account later turns live.
 */
export function resolveFrozenNestedPoiMarketRoute(input: {
  mode: unknown;
  route: unknown;
  runtimeTarget: "paper" | "live";
}): {
  mode: NestedPoiMarketMode;
  route: NestedPoiMarketRoute | null;
  observing: boolean;
  enforced: boolean;
  runtimeTargetMismatch: boolean;
} {
  const mode = normalizeNestedPoiMarketMode(input.mode);
  const normalizedRoute = normalizeNestedPoiMarketRoute(input.route);
  const route =
    isNestedPoiMarketRouteCompatible({ mode, route: normalizedRoute })
      ? normalizedRoute
      : null;
  const runtimeTargetMismatch = route === "nested_poi_market" &&
    mode === "enforce_paper" && input.runtimeTarget === "live";
  return {
    mode,
    route,
    observing: route === "observe",
    enforced: route === "nested_poi_market" && !runtimeTargetMismatch,
    runtimeTargetMismatch,
  };
}

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
  const width = Number.isFinite(input.zoneWidth) && input.zoneWidth > 0
    ? input.zoneWidth
    : 0;
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

  return {
    supersede: false,
    reason: "unchanged setup — existing order retained",
  };
}

export interface PreArmReachabilityInput {
  currentPrice: number;
  entryPrice: number;
  pipSize: number;
  atrValue?: number | null;
  ttlMinutes: number;
  referenceMaxDistancePips: number;
  armedAt: string;
}

export interface PreArmReachabilityObservation {
  contractVersion: "prearm-reachability.v1";
  armedAt: string;
  distancePrice: number;
  distancePips: number;
  distanceAtr: number | null;
  ttlMinutes: number;
  referenceMaxDistancePips: number;
  withinReferenceDistance: boolean;
}

/**
 * Records how reachable a pre-armed entry was at creation time.
 *
 * This is deliberately observation-only. The regular limit-order route has a
 * distance setting, while pre-arming currently does not enforce it. Persisting
 * both values lets outcome evidence decide whether that policy should change.
 */
export function observePreArmReachability(
  input: PreArmReachabilityInput,
): PreArmReachabilityObservation {
  const distancePrice = Math.abs(input.currentPrice - input.entryPrice);
  const distancePips = input.pipSize > 0 ? distancePrice / input.pipSize : 0;
  const distanceAtr = input.atrValue != null && input.atrValue > 0
    ? distancePrice / input.atrValue
    : null;

  return {
    contractVersion: "prearm-reachability.v1",
    armedAt: input.armedAt,
    distancePrice,
    distancePips,
    distanceAtr,
    ttlMinutes: input.ttlMinutes,
    referenceMaxDistancePips: input.referenceMaxDistancePips,
    withinReferenceDistance: distancePips <= input.referenceMaxDistancePips,
  };
}
