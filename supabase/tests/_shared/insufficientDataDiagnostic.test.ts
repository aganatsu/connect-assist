import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * A pair whose entry series comes back with under 30 candles is skipped with
 * "Insufficient data" — a message that cannot distinguish:
 *
 *   - the credit budget refusing the fetch
 *   - the provider erroring or lacking that interval
 *   - a genuinely thin series
 *
 * Observed 2026-09-08 ~20:35 local: XAU/USD showed a zone setup on one scan and
 * "Insufficient data" on the next. Transient, so the instrument is fine and the
 * fetch is not — but nothing recorded said which.
 *
 * It matters because dataCache caches an empty result for the rest of the cycle
 * ("Cache the failure so we don't retry"), so a single failed fetch silences
 * that pair for the whole scan.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

/** Mirrors the classification in the skip branch. */
function classify(entry: number, daily: number, hourly: number) {
  return entry < 30 && daily < 30 && hourly < 30 ? "fetch_layer" : "interval_specific";
}

Deno.test("all series short means the fetch layer failed, not the instrument", () => {
  assertEquals(classify(0, 0, 0), "fetch_layer");
  assertEquals(classify(12, 4, 0), "fetch_layer");
});

Deno.test("one short series means that interval specifically", () => {
  // The distinction that decides whether to look at the credit budget or at
  // the provider's coverage of that timeframe.
  assertEquals(classify(0, 300, 300), "interval_specific");
  assertEquals(classify(29, 300, 120), "interval_specific");
});

Deno.test("every series count is recorded, not just the failing one", () => {
  const i = scanner.indexOf("const seriesCounts = {");
  assert(i > -1, "series counts must be captured");
  const block = scanner.slice(i, i + 400);
  // Object literals mix `name: value` and shorthand `name,` — match either,
  // rather than assuming one form and failing on a correct implementation.
  const records = (field: string) => new RegExp(`\\b${field}\\s*[,:]`).test(block);
  for (const f of ["entry", "entryInterval", "daily", "hourly", "h4", "m15", "weekly"]) {
    assert(records(f), `must record ${f}`);
  }
});

Deno.test("the skip detail is queryable, not just logged", () => {
  // A console line is invisible from SQL; every other diagnostic added this
  // week lives in scan detail so it can be aggregated.
  assert(/insufficientData: \{ \.\.\.seriesCounts, allSeriesShort: allShort \}/.test(scanner));
});

Deno.test("the reason names the interval and the counts", () => {
  assert(/entry \$\{entryInterval\}: \$\{candles\.length\}/.test(scanner),
    "the message must say which interval and how many");
  assert(/The fetch layer failed for this pair, not the instrument\./.test(scanner),
    "and state the conclusion, so it is not re-derived next time");
});

Deno.test("it warns rather than logging at info level", () => {
  const i = scanner.indexOf("const seriesCounts = {");
  const block = scanner.slice(i, i + 1400);
  assert(/console\.warn/.test(block), "a silently skipped pair should be a warning");
});

Deno.test("weekly is null-safe", () => {
  // weeklyCandles is Candle[] | null; `.length` on it would throw inside the
  // handler for a pair that is already failing.
  assert(/weekly: weeklyCandles\?\.length \?\? null,/.test(scanner));
});
