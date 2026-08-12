// ── Zone touch detection ─────────────────────────────────────────────
//
// Step 2 of the corrected sequence in docs/PREARM_GATE_AUDIT.md.
//
// bot-scanner sampled a single bar:
//
//   const lastCandle = pendingCandles[pendingCandles.length - 1];
//   const filled = pending.direction === "long"
//     ? lastCandle.low <= entryPrice : lastCandle.high >= entryPrice;
//
// The shape was right — candle high/low rather than close, off cached bars —
// but a single sample only sees the most recent bar. If a scan is delayed,
// throttled, or a cron fires late, an earlier candle can wick into the zone and
// never be seen. The tighter the zone the likelier the miss, and pre-arming
// makes orders live far longer, so the exposure grows with it.
//
// EARLIEST touch, not latest. zone_touch_time anchors the CHoCH search window
// in zone-confirmation-scanner (zoneTouchIdx). A late timestamp silently
// truncates that window and confirmations that did occur are never found —
// the same class of failure as #318, arriving by a different route.

export interface TouchCandle {
  datetime: string;
  high: number;
  low: number;
}

export interface ZoneTouchQuery {
  direction: "long" | "short";
  /** The limit price the order is waiting for. */
  entryPrice: number;
  /**
   * Only consider bars at or after this instant — normally `placed_at`.
   * Bars that closed before the order existed cannot have touched it.
   */
  since?: string | null;
}

export interface ZoneTouch {
  touched: boolean;
  /** Datetime of the EARLIEST qualifying bar. */
  at: string | null;
  /** How many bars in the examined window qualified. >1 means earlier ones were being missed. */
  matchCount: number;
  /** Bars considered after the `since` filter — 0 means the window did not reach the order. */
  examined: number;
}

function touches(
  candle: TouchCandle,
  direction: "long" | "short",
  entryPrice: number,
): boolean {
  // High/low, never close: a wick through the level is a touch. A close-based
  // test misses exactly the fast rejections these zones are built to catch.
  return direction === "long"
    ? candle.low <= entryPrice
    : candle.high >= entryPrice;
}

/**
 * Earliest bar in the window that reached the entry price.
 *
 * Bars are assumed ascending by time, which is how candleSource returns them.
 * The scan is left-to-right and returns on the first match, so the result is
 * the earliest regardless of how many later bars also qualify.
 */
export function findEarliestZoneTouch(
  candles: TouchCandle[],
  query: ZoneTouchQuery,
): ZoneTouch {
  if (!Number.isFinite(query.entryPrice)) {
    return { touched: false, at: null, matchCount: 0, examined: 0 };
  }

  const sinceMs = query.since ? Date.parse(query.since) : NaN;
  const hasSince = Number.isFinite(sinceMs);

  let at: string | null = null;
  let matchCount = 0;
  let examined = 0;

  for (const candle of candles) {
    if (hasSince) {
      const t = Date.parse(candle.datetime);
      // Skip unparseable rather than admitting them: a NaN comparison is false
      // either way, and letting them through would make the window unbounded.
      if (!Number.isFinite(t) || t < sinceMs) continue;
    }
    examined++;
    if (!touches(candle, query.direction, query.entryPrice)) continue;
    matchCount++;
    if (at === null) at = candle.datetime;
  }

  return { touched: at !== null, at, matchCount, examined };
}
