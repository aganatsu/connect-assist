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
