export type WatchlistDirection = "long" | "short";

export interface PriceBounds {
  low: number;
  high: number;
}

export type WatchlistInvalidationSource =
  | "zone_boundary"
  | "impulse_boundary"
  | "proposed_level"
  | "unavailable";

export interface WatchlistInvalidation {
  level: number | null;
  source: WatchlistInvalidationSource;
  bufferPrice: number;
  zone: PriceBounds | null;
  adjusted: boolean;
}

export interface WatchlistInvalidationInput {
  direction: WatchlistDirection;
  zone?: unknown;
  impulse?: unknown;
  proposedLevel?: unknown;
  bufferPrice?: unknown;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizePriceBounds(value: unknown): PriceBounds | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const first = finiteNumber(record.low);
  const second = finiteNumber(record.high);
  if (first === null || second === null) return null;
  return {
    low: Math.min(first, second),
    high: Math.max(first, second),
  };
}

/**
 * A Watchlist boundary describes when the setup thesis is structurally invalid.
 * It is deliberately separate from the stop loss eventually assigned to a trade.
 */
export function deriveWatchlistInvalidation(
  input: WatchlistInvalidationInput,
): WatchlistInvalidation {
  const zone = normalizePriceBounds(input.zone);
  const impulse = normalizePriceBounds(input.impulse);
  const proposedLevel = finiteNumber(input.proposedLevel);
  const parsedBuffer = finiteNumber(input.bufferPrice);
  const bufferPrice = parsedBuffer === null ? 0 : Math.max(0, parsedBuffer);

  if (zone) {
    const level = input.direction === "long"
      ? zone.low - bufferPrice
      : zone.high + bufferPrice;
    return {
      level,
      source: "zone_boundary",
      bufferPrice,
      zone,
      adjusted: proposedLevel !== null && proposedLevel !== level,
    };
  }

  if (impulse) {
    const level = input.direction === "long"
      ? impulse.low - bufferPrice
      : impulse.high + bufferPrice;
    return {
      level,
      source: "impulse_boundary",
      bufferPrice,
      zone: null,
      adjusted: proposedLevel !== null && proposedLevel !== level,
    };
  }

  if (proposedLevel !== null) {
    return {
      level: proposedLevel,
      source: "proposed_level",
      bufferPrice,
      zone: null,
      adjusted: false,
    };
  }

  return {
    level: null,
    source: "unavailable",
    bufferPrice,
    zone: null,
    adjusted: false,
  };
}

export function isWatchlistInvalidated(
  direction: WatchlistDirection,
  currentPrice: unknown,
  boundary: unknown,
): boolean {
  const price = finiteNumber(currentPrice);
  const level = finiteNumber(boundary);
  if (price === null || level === null) return false;
  return direction === "long" ? price < level : price > level;
}

// ── Lifecycle-correct invalidation boundary ──────────────────────────
//
// Step 1 of the corrected sequence in docs/PREARM_GATE_AUDIT.md.
//
// bot-scanner:2588 cancelled any row with status 'pending' by comparing price
// against stop_loss. That is the wrong LEVEL for the wrong REASON:
//
//   A stop loss is sized for a position that exists — entry minus risk, floored
//   by MIN_SL_PIPS and spread. Nothing in pending_orders has entered. Through
//   'pending' AND 'awaiting_confirmation' there is no position, so a position
//   stop has nothing to govern.
//
// The boundary that applies before entry is structural: has the ZONE or IMPULSE
// that produced this setup broken?
//
// Note the direction of the difference, which is easy to get backwards. On the
// observed GBP/CHF setup the structural boundary sits ~2 pips below the zone
// floor while the position stop sits ~23 pips lower. Structural is TIGHTER.
// Switching to it makes pre-entry invalidation FIRE EARLIER, not later — and
// that is the point: a setup whose zone has broken is dead regardless of how
// much room a hypothetical position would have had.
//
// Keyed on LIFECYCLE STATE, not on zone_touch_time. Touch means price arrived,
// not that a trade exists.

/** Where a row sits in the lifecycle. Only 'filled' has a position. */
export type InvalidationLifecycle = "pre_entry" | "entered";

export interface LifecycleInvalidationInput {
  direction: "long" | "short";
  /** pending_orders.status, or the position lifecycle for an entered trade. */
  status: string;
  /** Zone/impulse boundary. Null on rows written before the column existed. */
  structuralInvalidation?: number | null;
  /** Position stop loss. Governs only once a position exists. */
  stopLoss: number;
}

export interface LifecycleInvalidation {
  lifecycle: InvalidationLifecycle;
  level: number;
  source: "structural" | "position_stop" | "legacy_stop_fallback";
  reason: string;
}

/** Statuses in which no position exists yet. */
const PRE_ENTRY_STATUSES = new Set(["pending", "awaiting_confirmation"]);

/**
 * Which boundary applies to this row right now.
 *
 * `legacy_stop_fallback` covers rows written before structural_invalidation
 * existed. It is deliberately named as legacy and MIGRATION-SHAPED: an
 * un-invalidated order is worse than one invalidated on the wrong level, but
 * this branch should trend to zero as old rows terminate. A persistent non-zero
 * count on NEW rows means the zone is not reaching the insert.
 */
export function invalidationForLifecycle(
  input: LifecycleInvalidationInput,
): LifecycleInvalidation {
  const preEntry = PRE_ENTRY_STATUSES.has(input.status);

  if (!preEntry) {
    return {
      lifecycle: "entered",
      level: input.stopLoss,
      source: "position_stop",
      reason: "a position exists — the position stop governs",
    };
  }

  const structural =
    typeof input.structuralInvalidation === "number" &&
      Number.isFinite(input.structuralInvalidation)
      ? input.structuralInvalidation
      : null;

  if (structural === null) {
    return {
      lifecycle: "pre_entry",
      level: input.stopLoss,
      source: "legacy_stop_fallback",
      reason:
        "no structural level recorded (row predates the column) — falling back to the position stop",
    };
  }

  return {
    lifecycle: "pre_entry",
    level: structural,
    source: "structural",
    reason: "no position exists — the zone/impulse boundary governs",
  };
}

/** Has this boundary been breached? Direction-aware. */
export function invalidationBreached(
  direction: "long" | "short",
  currentPrice: number,
  level: number,
): boolean {
  return direction === "long" ? currentPrice < level : currentPrice > level;
}
