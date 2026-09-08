import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { warnOnFutureBars } from "../../functions/_shared/candleSource.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/**
 * Observed 2026-09-08 via the touch-check instrumentation:
 *
 *   scan ran   2026-09-08 10:11:13 UTC
 *   bar_time   2026-09-08T20:05:00Z     <- 9h54m in the FUTURE
 *   interval   5m
 *
 * The TwelveData request never asked for UTC:
 *
 *   time_series?symbol=..&interval=..&outputsize=..&apikey=..&order=ASC
 *
 * TwelveData defaults to the EXCHANGE timezone. mapTwelveDataValues then does
 * `${v.datetime.replace(" ", "T")}Z`, asserting a UTC that was never requested,
 * so every bar carries the exchange offset stamped as if it were UTC.
 *
 * Polygon is unaffected (`new Date(bar.t)` from epoch ms).
 *
 * WHY IT MATTERS beyond tidiness: zoneTouchIdx is derived by walking back to
 * the last candle whose time is <= zone_touch_time. With every candle stamped
 * in the future that search matches nothing, zoneTouchIdx stays undefined, and
 * detectZoneConfirmation scans the whole series instead of the window since the
 * touch — quietly weakening every confirmation.
 */

const src = await Deno.readTextFile(
  new URL("../../functions/_shared/candleSource.ts", import.meta.url),
);

function bar(datetime: string): Candle {
  return { open: 1, high: 1, low: 1, close: 1, volume: 1, datetime } as Candle;
}

Deno.test("the request asks for UTC", () => {
  assert(/time_series\?[^`]*&timezone=UTC/.test(src), "timezone=UTC missing from the URL");
});

Deno.test("appending Z is only sound because UTC was requested", () => {
  // The two lines are separated by 30-odd lines of code; if the parameter is
  // ever dropped the mapper silently mislabels everything again.
  assert(/\$\{v\.datetime\.replace\(" ", "T"\)\}Z/.test(src), "the mapper still appends Z");
  const i = src.indexOf('Appending "Z" is only correct because');
  assert(i > -1, "the coupling must be documented at the mapper");
});

Deno.test("a future-dated bar is flagged", () => {
  const future = new Date(Date.now() + 9.9 * 60 * 60 * 1000).toISOString();
  const ahead = warnOnFutureBars([bar(future)], "GBP/JPY", "5m");
  assert(ahead > 500, `expected ~594 minutes ahead, got ${ahead.toFixed(1)}`);
});

Deno.test("a normal forming bar is not flagged", () => {
  // Providers differ on whether a bar is stamped at its open or its close, so
  // a small amount of forward stamping is legitimate and must not cry wolf.
  const recent = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  assert(warnOnFutureBars([bar(recent)], "EUR/USD", "5m") < 0);
  const slightlyAhead = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const v = warnOnFutureBars([bar(slightlyAhead)], "EUR/USD", "1h");
  assert(v > 0 && v < 90, "half an hour ahead is within tolerance");
});

Deno.test("empty and malformed input are handled without throwing", () => {
  assertEquals(warnOnFutureBars([], "EUR/USD", "5m"), 0);
  assertEquals(warnOnFutureBars([bar("not a date")], "EUR/USD", "5m"), 0);
  assertEquals(warnOnFutureBars([{ open: 1 } as Candle], "EUR/USD", "5m"), 0);
});

Deno.test("the guard runs on live fetches, not on cache hits", () => {
  // setCachedCandles is reached by all four sources on a live fetch and by none
  // on a cache hit, so a persistent fault is loud without spamming reads.
  const i = src.indexOf("function setCachedCandles(");
  const block = src.slice(i, i + 400);
  assert(/warnOnFutureBars\(candles, `\$\{symbol\}\[\$\{source\}\]`, interval\)/.test(block),
    "the guard must sit inside setCachedCandles");
  const cacheHit = src.indexOf("if (cached && cached.candles.length >= 30)");
  const cacheBlock = src.slice(cacheHit, cacheHit + 300);
  assert(!/warnOnFutureBars/.test(cacheBlock), "must not fire on every cache hit");
});

Deno.test("it names the source, so the culprit is identifiable", () => {
  // Polygon is fine and TwelveData was not; a warning that does not say which
  // sent the bad bar would have taken another round to pin down.
  assert(/\$\{symbol\}\[\$\{source\}\]/.test(src), "the warning must carry the source");
});
