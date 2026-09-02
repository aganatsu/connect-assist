import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MIN_CONFIRMATION_CANDLES,
  STYLE_CONFIRMATION_TIMEFRAME,
  resolveStyleMode,
  styleConfirmationTimeframe,
  stylePendingExpiryMinutes,
} from "../../functions/_shared/styleTimeframes.ts";

Deno.test("scalper confirmation is unchanged from the old hardcoded value", () => {
  // Every style used to confirm on 5m. Scalper must still, or this is a
  // behaviour change for a style that was already correct.
  assertEquals(styleConfirmationTimeframe("scalper"), "5m");
});

Deno.test("slower styles no longer confirm on 5m noise", () => {
  assertEquals(styleConfirmationTimeframe("day_trader"), "15m");
  assertEquals(styleConfirmationTimeframe("swing_trader"), "1h");
});

Deno.test("an unknown or missing style falls back to day_trader", () => {
  // Matches configMapper's RUNTIME_DEFAULTS. zone-confirmation-scanner reads
  // raw config_json, where tradingStyle may be absent entirely.
  assertEquals(resolveStyleMode(undefined), "day_trader");
  assertEquals(resolveStyleMode(null), "day_trader");
  assertEquals(resolveStyleMode(""), "day_trader");
  assertEquals(resolveStyleMode("scalper_v2"), "day_trader");
  assertEquals(styleConfirmationTimeframe(undefined), "15m");
});

Deno.test("swing pending orders outlive the gap between scans", () => {
  // A swing trader scans every 60 minutes. The old flat 60-minute expiry meant
  // the order died at about the moment the next scan would look at it, and it
  // now also has to survive long enough to confirm on 1h candles.
  const scanIntervalMinutes = 60;
  const expiry = stylePendingExpiryMinutes("swing_trader", 60);
  assert(
    expiry > scanIntervalMinutes * 2,
    `swing expiry ${expiry}min must outlast more than two 60min scan cycles`,
  );
  assertEquals(expiry, 480);
});

Deno.test("a longer configured expiry is respected, not clamped down", () => {
  assertEquals(stylePendingExpiryMinutes("swing_trader", 720), 720);
  assertEquals(stylePendingExpiryMinutes("day_trader", 180), 180);
});

Deno.test("scalper orders do not linger", () => {
  assertEquals(stylePendingExpiryMinutes("scalper", 240), 60);
  // Below the cap the user's value stands.
  assertEquals(stylePendingExpiryMinutes("scalper", 20), 20);
});

Deno.test("day_trader expiry is left to the user", () => {
  assertEquals(stylePendingExpiryMinutes("day_trader", 60), 60);
});

Deno.test("every style has a confirmation timeframe", () => {
  for (const style of ["scalper", "day_trader", "swing_trader"] as const) {
    assert(
      typeof STYLE_CONFIRMATION_TIMEFRAME[style] === "string" &&
        STYLE_CONFIRMATION_TIMEFRAME[style].length > 0,
      `${style} has no confirmation timeframe`,
    );
  }
});

Deno.test("the candle floor is high enough for CHoCH detection", () => {
  assert(MIN_CONFIRMATION_CANDLES >= 10);
});
