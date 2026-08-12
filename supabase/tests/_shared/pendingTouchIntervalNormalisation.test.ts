// The interval reaching touch detection is config.entryTimeframe verbatim.
//
// pendingTimeframeAuthority.runtimeEntry is `config.entryTimeframe` with no
// normalisation (stylePolicy.ts:166). The stored values are LONG form:
// configMapper defaults to "15min" (line 392) and the day_trader profile sets
// "15min" (tradingStyleConfig.ts:37).
//
// pendingTouchIntervalMinutes originally matched /^(\d+)(m|h|d|w|M)$/, which
// rejects every long form. That returned null → intervalMs NaN → the guard in
// findEarliestPendingZoneTouch returned {touchTime: null} for EVERY candle
// regardless of price. Touch detection was off, with no error and no log, so a
// pending order would sit at 'pending' indefinitely.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  findEarliestPendingZoneTouch,
  pendingTouchIntervalMinutes,
} from "../../functions/_shared/pendingZoneTouch.ts";

Deno.test("the long forms actually stored in config parse", () => {
  // These are the values the config layer produces, not hypotheticals.
  assertEquals(pendingTouchIntervalMinutes("15min"), 15, "configMapper default AND day_trader");
  assertEquals(pendingTouchIntervalMinutes("5min"), 5);
  assertEquals(pendingTouchIntervalMinutes("30min"), 30);
  assertEquals(pendingTouchIntervalMinutes("1day"), 1440);
  assertEquals(pendingTouchIntervalMinutes("1week"), 10080);
});

Deno.test("short forms still parse", () => {
  assertEquals(pendingTouchIntervalMinutes("15m"), 15);
  assertEquals(pendingTouchIntervalMinutes("1h"), 60);
  assertEquals(pendingTouchIntervalMinutes("4h"), 240);
  assertEquals(pendingTouchIntervalMinutes("1d"), 1440);
});

Deno.test("long and short forms of the same interval agree", () => {
  for (const [long, short] of [["15min", "15m"], ["5min", "5m"], ["1day", "1d"], ["1week", "1w"]]) {
    assertEquals(
      pendingTouchIntervalMinutes(long),
      pendingTouchIntervalMinutes(short),
      `${long} and ${short} are the same interval and must not disagree`,
    );
  }
});

Deno.test("monthly is not mistaken for one minute", () => {
  // normalizeAnalysisTimeframe preserves case-sensitive "1M" precisely because
  // lowercasing it would turn monthly into the one-minute interval.
  assertEquals(pendingTouchIntervalMinutes("1M"), 43200);
  assertEquals(pendingTouchIntervalMinutes("1m"), 1);
});

Deno.test("a touch IS detected with the Day Trader default interval", () => {
  // The regression, end to end. Low 1.0840 is clearly through an entry of
  // 1.0850, but with interval "15min" the old parser reported no touch.
  const candles = [
    { datetime: "2026-08-12T00:05:00.000Z", open: 1.086, high: 1.0875, low: 1.0840, close: 1.087 },
    { datetime: "2026-08-12T00:20:00.000Z", open: 1.086, high: 1.0875, low: 1.0860, close: 1.087 },
  ] as never;
  const r = findEarliestPendingZoneTouch({
    candles,
    direction: "long",
    entryPrice: 1.0850,
    observedAfter: "2026-08-12T00:00:00.000Z",
    interval: "15min",
  });
  assert(
    r.touchTime !== null,
    "with entryTimeframe '15min' — the shipped default — touch detection returned " +
      "null for a candle that plainly touched, silently disabling the whole path",
  );
  assertEquals(r.touchTime, "2026-08-12T00:05:00.000Z", "and it must be the EARLIEST bar");
});

Deno.test("an unrecognised interval falls back rather than disabling detection", () => {
  // normalizeAnalysisTimeframe's fallback means a typo degrades to a default
  // interval instead of switching touch detection off entirely. Failing open on
  // the window is recoverable; failing closed is invisible.
  assertEquals(
    pendingTouchIntervalMinutes("nonsense"),
    15,
    "an unknown interval must not return null — null is what disabled detection",
  );
});
