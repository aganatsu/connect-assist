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

// ── Phase-correct invalidation boundary ──────────────────────────────
//
// Step 1 of the corrected sequence in docs/PREARM_GATE_AUDIT.md.
//
// bot-scanner:2588 cancelled any 'pending' row whose price breached stop_loss,
// touched or not. A stop loss is sized for a position that EXISTS — entry minus
// risk, floored by MIN_SL_PIPS and spread. Before entry the question is
// different: has the ZONE or IMPULSE that produced this setup been broken?
//
// Observed GBP/CHF: invalidation ~2 pips below an 11-pip zone floor, on a pair
// with a 25-pip minimum stop. Pre-arming an order there under the position stop
// means it dies on any overshoot before it can fill.

export type InvalidationPhase = "pre_touch" | "post_touch";

export interface PhaseInvalidationInput {
  direction: "long" | "short";
  /** Zone/impulse boundary. Null on legacy rows written before the column existed. */
  structuralInvalidation?: number | null;
  /** Position stop loss. Always present. */
  stopLoss: number;
  /** Set once price has reached the zone. Its presence IS the phase. */
  zoneTouchTime?: string | null;
}

export interface PhaseInvalidation {
  phase: InvalidationPhase;
  level: number;
  source: "structural" | "position_stop" | "position_stop_fallback";
  reason: string;
}

/**
 * Which boundary applies right now.
 *
 * Falls back to the position stop when no structural level was recorded, since
 * every row written before this column existed has none — and an un-invalidated
 * order is worse than one invalidated slightly early. The fallback is labelled
 * so it can be counted rather than assumed absent.
 */
export function invalidationForPhase(
  input: PhaseInvalidationInput,
): PhaseInvalidation {
  const touched = typeof input.zoneTouchTime === "string" &&
    input.zoneTouchTime.length > 0;

  if (touched) {
    return {
      phase: "post_touch",
      level: input.stopLoss,
      source: "position_stop",
      reason: "price reached the zone — the position stop governs from here",
    };
  }

  const structural = typeof input.structuralInvalidation === "number" &&
      Number.isFinite(input.structuralInvalidation)
    ? input.structuralInvalidation
    : null;

  if (structural === null) {
    return {
      phase: "pre_touch",
      level: input.stopLoss,
      source: "position_stop_fallback",
      reason: "no structural level recorded (legacy row) — falling back to the position stop",
    };
  }

  return {
    phase: "pre_touch",
    level: structural,
    source: "structural",
    reason: "setup has not been entered — the zone/impulse boundary governs",
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
