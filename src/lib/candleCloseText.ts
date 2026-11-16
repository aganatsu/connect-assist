/**
 * Plain-English reading of a candle's close strength (Zone Story "how the candles closed").
 *
 * strength is 0-1, already normalised by the engine so that 1 = closed at the extreme
 * in the direction of the move (the low for a bearish leg, the high for a bullish one)
 * and 0 = closed at the opposite extreme (fully rejected).
 */
export type CloseTone = "strong" | "mixed" | "weak";

export function describeClose(strength: number, direction: "bullish" | "bearish"): { tone: CloseTone; text: string } {
  const pct = Math.round(strength * 100);
  const toward = direction === "bearish" ? "low" : "high";
  const away = direction === "bearish" ? "high" : "low";
  if (strength >= 0.8) return { tone: "strong", text: `closed near its ${toward} (${pct}%) — strong` };
  if (strength >= 0.6) return { tone: "strong", text: `closed in its ${direction === "bearish" ? "lower" : "upper"} part (${pct}%) — solid` };
  if (strength >= 0.4) return { tone: "mixed", text: `closed near the middle (${pct}%) — undecided` };
  return { tone: "weak", text: `closed back toward its ${away} (${pct}%) — rejected` };
}

/** What 100% and 0% mean for this move, in one line. */
export function closeScaleHint(direction: "bullish" | "bearish"): string {
  return direction === "bearish"
    ? "100% = closed at the very low (sellers in full control) · 0% = closed at the high (sellers rejected)"
    : "100% = closed at the very high (buyers in full control) · 0% = closed at the low (buyers rejected)";
}
