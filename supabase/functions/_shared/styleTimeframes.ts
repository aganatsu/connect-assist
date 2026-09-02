// ─── Style-Aware Confirmation Timeframe and Pending Expiry ───────────────
//
// Two decisions were style-blind while everything around them was not.
//
// zone-confirmation-scanner hardcoded 5m in three places. It is the function
// that confirms or invalidates a pending order once price touches the zone, so
// a swing setup built from a weekly bias and daily structure was being decided
// by five-minute noise. Confirmation should happen on the timeframe the setup
// is entered on, which is what 5m already was for a scalper — the rule below
// generalises the existing scalper behaviour rather than inventing a new one.
//
// Pending-order expiry was a flat 60 minutes. For a swing trader on a
// 60-minute scan interval that is one cycle: the order expires at roughly the
// moment the next scan would look at it. Staging TTL was already scaled per
// style at bot-scanner (scalper capped, swing floored); this applies the same
// shape to expiry so the two agree.
//
// Shared rather than duplicated because bot-scanner and
// zone-confirmation-scanner both need it, and a second copy of a style table is
// the drift this repo has been bitten by before.

export type TradingStyleMode = "scalper" | "day_trader" | "swing_trader";

/**
 * The timeframe a zone touch is confirmed on, per style.
 *
 * Equal to each style's entry timeframe. Confirming above the entry timeframe
 * would miss entries the style is built to take; confirming below it decides a
 * setup on noise the style deliberately ignores.
 */
export const STYLE_CONFIRMATION_TIMEFRAME: Record<TradingStyleMode, string> = {
  scalper: "5m",       // unchanged — this is what every style used before
  day_trader: "15m",
  swing_trader: "1h",
};

/** Minimum candles needed before a confirmation verdict is meaningful. */
export const MIN_CONFIRMATION_CANDLES = 10;

export function resolveStyleMode(raw: unknown): TradingStyleMode {
  return raw === "scalper" || raw === "swing_trader" || raw === "day_trader"
    ? raw
    : "day_trader"; // matches configMapper's RUNTIME_DEFAULTS
}

export function styleConfirmationTimeframe(style: unknown): string {
  return STYLE_CONFIRMATION_TIMEFRAME[resolveStyleMode(style)];
}

/**
 * Pending-order expiry, scaled to the style.
 *
 * Mirrors the staged-setup TTL rule already in bot-scanner: cap the fast style
 * so stale orders do not linger, floor the slow one so an order outlives the
 * gap between scans. The configured value is respected in between, so a user
 * who has set an explicit expiry keeps it unless it contradicts the style.
 */
export function stylePendingExpiryMinutes(
  style: unknown,
  configuredMinutes: number,
): number {
  const mode = resolveStyleMode(style);
  if (mode === "scalper") return Math.min(configuredMinutes, 60);
  if (mode === "swing_trader") return Math.max(configuredMinutes, 480);
  return configuredMinutes;
}
