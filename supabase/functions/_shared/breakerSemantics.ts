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
