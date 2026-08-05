export type BreakerDirection = "bullish" | "bearish";

export interface BreakerBounds {
  low: number;
  high: number;
}

export function breakerDirectionForOriginalOB(
  originalDirection: BreakerDirection,
): BreakerDirection {
  return originalDirection === "bullish" ? "bearish" : "bullish";
}

export function breakerCloseInvalidated(
  direction: BreakerDirection,
  bounds: BreakerBounds,
  close: number,
): boolean {
  return direction === "bullish" ? close < bounds.low : close > bounds.high;
}

export function breakerRetestHeld(
  direction: BreakerDirection,
  bounds: BreakerBounds,
  candle: { high: number; low: number; close: number },
): boolean {
  const touched = candle.high >= bounds.low && candle.low <= bounds.high;
  if (!touched || breakerCloseInvalidated(direction, bounds, candle.close)) {
    return false;
  }
  return direction === "bullish"
    ? candle.close >= bounds.low
    : candle.close <= bounds.high;
}

export function hasOppositeStructureBreak(
  direction: BreakerDirection,
  originalIndex: number,
  breakIndex: number,
  structureBreaks: readonly { index: number; type: string }[],
  confirmationWindow = 10,
): boolean {
  return structureBreaks.some((item) =>
    item.type === direction &&
    item.index >= originalIndex &&
    item.index <= breakIndex + confirmationWindow
  );
}

export interface BreakerFillLifecycleDecision {
  allowed: boolean;
  code: "valid" | "missing_structure_ownership" | "breaker_invalidated" | "invalid_bounds";
  reason: string;
}

export function evaluateBreakerFillLifecycle(input: {
  direction: "long" | "short";
  bounds: BreakerBounds;
  currentClose: number;
  structureBreakIndex: unknown;
}): BreakerFillLifecycleDecision {
  if (!(input.bounds.high > input.bounds.low)) {
    return { allowed: false, code: "invalid_bounds", reason: "Breaker bounds are invalid" };
  }
  if (!Number.isInteger(Number(input.structureBreakIndex))) {
    return {
      allowed: false,
      code: "missing_structure_ownership",
      reason: "Breaker has no frozen opposite-structure ownership",
    };
  }
  const direction = input.direction === "long" ? "bullish" : "bearish";
  if (breakerCloseInvalidated(direction, input.bounds, input.currentClose)) {
    return {
      allowed: false,
      code: "breaker_invalidated",
      reason: `Price ${input.currentClose} closed through the ${direction} breaker far boundary`,
    };
  }
  return { allowed: true, code: "valid", reason: "Breaker structure and far boundary remain valid" };
}
