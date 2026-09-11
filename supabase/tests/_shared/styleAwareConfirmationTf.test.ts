import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MIN_CONFIRMATION_CANDLES,
  STYLE_CONFIRMATION_TIMEFRAME,
  styleConfirmationTimeframe,
} from "../../functions/_shared/styleTimeframes.ts";

/**
 * bot-scanner hunted zone confirmation on a hardcoded 5m series while
 * zone-confirmation-scanner — the other half of the same lifecycle, acting on
 * the same orders — resolved it per style at :304.
 *
 * Harmless for a scalper, whose confirmation timeframe IS 5m. For a swing
 * trader it means a Weekly-bias, Daily-structure, 4H/1H zone adjudicated by
 * five-minute candles: "a setup decided on noise the style deliberately
 * ignores", in the words of the module that defines the mapping.
 *
 * bot-scanner already IMPORTED STYLE_CONFIRMATION_TIMEFRAME and used it in
 * exactly one place — a console.log announcing the correct timeframe before
 * hunting on the wrong one.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("the confirmation timeframe is each style's entry timeframe", () => {
  assertEquals(styleConfirmationTimeframe("scalper"), "5m");
  assertEquals(styleConfirmationTimeframe("day_trader"), "15m");
  assertEquals(styleConfirmationTimeframe("swing_trader"), "1h");
  // Unknown input falls back to day_trader, matching configMapper's default.
  assertEquals(styleConfirmationTimeframe(undefined), "15m");
  assertEquals(styleConfirmationTimeframe("nonsense"), "15m");
});

Deno.test("bot-scanner resolves it rather than hardcoding 5m", () => {
  assert(
    !/cachedFetch\(pending\.symbol, "5m", "5d"\)/.test(scanner),
    "the literal 5m fetch must be gone",
  );
  assert(
    /const confirmTF = styleConfirmationTimeframe\(resolvedStyle\);/.test(scanner),
    "resolved from the style the scan is running",
  );
  assert(
    /cachedFetch\(pending\.symbol, confirmTF, confirmRange\)/.test(scanner),
    "and used for the fetch",
  );
});

Deno.test("the range scales with the timeframe", () => {
  // "5d" of 1h candles is 120 bars; "5d" of 1w candles would be nothing. The
  // range has to follow the interval or a swing hunt starves on bar count.
  assert(
    /const confirmRange = getEntryRange\(confirmTF\);/.test(scanner),
    "range derived from the timeframe, not fixed",
  );
});

Deno.test("the minimum bar count comes from the shared constant", () => {
  assertEquals(MIN_CONFIRMATION_CANDLES, 10);
  assert(
    /if \(confirmCandles\.length < MIN_CONFIRMATION_CANDLES\)/.test(scanner),
    "a second literal 10 here would drift from zone-confirmation-scanner",
  );
});

Deno.test("no variable still claims the series is 5m", () => {
  // `confirm5mCandles` baked the assumption into the name, which is how it
  // survived a style-aware refactor of everything around it.
  assert(!/confirm5mCandles/.test(scanner), "the 5m-named variable must be gone");
});

Deno.test("the timeframe is recorded on the hunt outcome", () => {
  // Otherwise a swing hunt failing on 1h and a scalper hunt failing on 5m are
  // indistinguishable in the diagnostics.
  assertEquals(
    (scanner.match(/confirmTF,\s*$/gm) ?? []).length >= 2, true,
    "recorded on the outcomes that can fail for want of bars",
  );
});

Deno.test("both scanners agree on the mapping", () => {
  // Two copies of a style table is the drift this repo has been bitten by.
  const zcs = Deno.readTextFileSync(
    new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url),
  );
  assert(
    /styleConfirmationTimeframe\(config\.tradingStyle\?\.mode\)/.test(zcs),
    "zone-confirmation-scanner resolves from the same helper",
  );
  assertEquals(Object.keys(STYLE_CONFIRMATION_TIMEFRAME).sort(),
    ["day_trader", "scalper", "swing_trader"]);
});
