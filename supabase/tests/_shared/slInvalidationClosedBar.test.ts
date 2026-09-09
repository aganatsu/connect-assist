import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { lastClosedCandle, type Candle } from "../../functions/_shared/candleSource.ts";

/**
 * Pending orders were being cancelled by intrabar noise.
 *
 * Measured 2026-09-09 over the 15 orders placed since 09-08 — the first cohort
 * running on candles with correct timestamps — 4 died on "Price X breached SL Y"
 * and every breach was marginal:
 *
 *   BTC/USD   79076.1     vs SL 79051.99    24.11 pts   0.03%
 *   ETH/USD    4420.86077 vs SL  4419.95628  0.90
 *   ETH/USD    4394.65903 vs SL  4394.10223  0.56
 *   GBP/JPY     208.99985 vs SL   208.96602  3.4 pips
 *
 * The rule read `candles[length - 1].close`, and providers put the IN-PROGRESS
 * bar there. So a rule written as "a bar closed beyond the stop" behaved as
 * "price ticked beyond the stop at some point in the last five minutes".
 *
 * A pending order holds no position. Invalidating it late costs a setup already
 * being waited on; invalidating it early costs the setup outright. The
 * asymmetry says decide on a bar that has closed.
 *
 * Three of those four also recorded zone_touch_time as null on orders price had
 * demonstrably reached — the SL check runs ~170 lines before the touch check
 * and `continue`s, so the touch was never recorded. That corrupted the one
 * measurement the pending loop most needs.
 */

const bar = (minutesAgo: number, close: number): Candle => ({
  datetime: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  open: close, high: close, low: close, close,
});

Deno.test("the in-progress bar is skipped in favour of the last closed one", () => {
  // 5m bars: the last opened 2 minutes ago, so it has 3 minutes left to run.
  const got = lastClosedCandle([bar(12, 100), bar(7, 101), bar(2, 102)], "5m");
  assertEquals(got?.candle.close, 101, "must use the bar that closed, not spot");
  assertEquals(got?.skippedForming, true);
});

Deno.test("a series whose last bar has already closed uses that bar", () => {
  // Last bar opened 7 minutes ago on a 5m interval — its period is over.
  const got = lastClosedCandle([bar(12, 100), bar(7, 101)], "5m");
  assertEquals(got?.candle.close, 101);
  assertEquals(got?.skippedForming, false, "nothing was skipped");
});

Deno.test("a bar exactly at its close boundary counts as closed", () => {
  const got = lastClosedCandle([bar(11, 100), bar(5, 101)], "5m");
  assertEquals(got?.candle.close, 101);
  assertEquals(got?.skippedForming, false);
});

Deno.test("null when the only bar available is still forming", () => {
  // The caller must skip the decision here. Falling back to spot would restore
  // exactly the behaviour being removed.
  assertEquals(lastClosedCandle([bar(2, 102)], "5m"), null);
  assertEquals(lastClosedCandle([], "5m"), null);
});

Deno.test("an unknown interval or unparseable stamp treats the bar as closed", () => {
  // Stalling the check forever on a data-shape change is the worse failure.
  assertEquals(lastClosedCandle([bar(12, 100), bar(2, 102)], "7m")?.candle.close, 102);
  const junk: Candle = { datetime: "not a date", open: 1, high: 1, low: 1, close: 103 };
  assertEquals(lastClosedCandle([bar(12, 100), junk], "5m")?.candle.close, 103);
});

Deno.test("the BTC cancel that prompted this would not fire now", () => {
  // Short order, SL 79051.99. Spot ticked to 79076.1 inside the forming bar;
  // the bar that actually closed was below the stop.
  const slLevel = 79051.99;
  const candles = [bar(12, 78990), bar(7, 79020), bar(2, 79076.1)];
  const spot = candles[candles.length - 1].close;
  const closed = lastClosedCandle(candles, "5m")!.candle.close;
  assert(spot > slLevel, "the old rule cancelled");
  assert(!(closed > slLevel), "the closed-bar rule does not");
});

Deno.test("a breach confirmed by a closed bar still cancels", () => {
  // The gate must still work. Same short, but the bar closes past the stop.
  const slLevel = 79051.99;
  const closed = lastClosedCandle([bar(12, 78990), bar(7, 79080), bar(2, 79076.1)], "5m")!.candle.close;
  assert(closed > slLevel, "a real invalidation is still an invalidation");
});

// ── The wiring in bot-scanner ──

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("the SL decision reads the closed bar, never spot", () => {
  assert(
    /const closedBar = lastClosedCandle\(pendingCandles, pendingInterval\);/.test(scanner),
    "resolve the closed bar from the same series the loop already fetched",
  );
  assert(
    /const slBreached = slPrice != null &&\s*\n?\s*\(pending\.direction === "long" \? slPrice < slLevel : slPrice > slLevel\);/.test(scanner),
    "the comparison must use slPrice, not currentPrice",
  );
  // The old rule must be gone, not merely bypassed.
  assert(
    !/if \(pending\.direction === "long" && currentPrice < slLevel\)/.test(scanner),
    "the spot-price cancel must be removed",
  );
});

Deno.test("the old rule is shadowed so the change is measurable without a redeploy", () => {
  // These are precisely the orders that used to die and now survive. Without
  // the log the effect is invisible until fills appear, which could be weeks.
  const i = scanner.indexOf("const spotBreached");
  assert(i > -1, "compute what the old rule would have said");
  const block = scanner.slice(i, i + 700);
  assert(/if \(spotBreached && !slBreached\)/.test(block), "report only the divergence");
});

Deno.test("a touch reached in the same bar is recorded before the order dies", () => {
  const i = scanner.indexOf("if (slBreached) {");
  assert(i > -1, "the cancel branch");
  const block = scanner.slice(i, i + 1400);
  assert(/const reachedEntry = pending\.direction === "long"/.test(block), "test the touch here too");
  assert(/lastCandle\.low <= entryPrice/.test(block) && /lastCandle\.high >= entryPrice/.test(block),
    "using the same low/high comparison as the touch check itself");
  assert(/!pending\.zone_touch_time/.test(block), "never overwrite a touch already stamped");
  assert(/zone_touch_time: new Date\(\)\.toISOString\(\)/.test(block), "stamp it");
  assert(/entry reached first/.test(block), "and say so in the cancel reason");
});

Deno.test("no closed bar means no cancel", () => {
  // Fail open. The order waits a cycle rather than dying on a partial bar.
  const i = scanner.indexOf("if (!closedBar) {");
  assert(i > -1, "handle the degenerate series explicitly");
  const block = scanner.slice(i, i + 400);
  assert(/SL invalidation skipped/.test(block), "say why nothing happened");
  assert(!/status: "cancelled"/.test(block), "and do not cancel");
});
