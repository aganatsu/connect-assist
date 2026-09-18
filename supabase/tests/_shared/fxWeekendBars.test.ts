import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isFxClosedAt, dropFxClosedBars } from "../../functions/_shared/sessions.ts";

/**
 * Weekend bars are not real price.
 *
 * Measured 2026-09-17 across the V2 order blocks: 26% of 4H bases and 19% of
 * Daily bases originated on bars the FX market was shut for — Saturday 17:00,
 * Sunday 09:00, Daily bars stamped Saturday. Nothing in the candle path
 * filtered them, so they reached swing detection, structure breaks and base
 * detection intact. A base formed on a bar that does not exist is not a base.
 *
 * The boundary is DST-aware on purpose: 17:00 ET is 21:00 UTC in summer and
 * 22:00 UTC in winter. A fixed UTC hour would delete an hour of real Sunday
 * trading for half the year, or admit an hour of phantom bars for the other
 * half.
 */

const ms = (iso: string) => Date.parse(iso);

Deno.test("Saturday is closed all day", () => {
  for (const t of ["2026-05-30T00:00:00Z", "2026-05-30T17:00:00Z", "2026-05-30T21:00:00Z"]) {
    assert(isFxClosedAt(ms(t)), `${t} is a Saturday`);
  }
});

Deno.test("Sunday is closed until the 17:00 ET open", () => {
  // Real rows from the live table, all before the open.
  for (const t of ["2026-08-23T01:00:00Z", "2026-07-26T09:00:00Z", "2026-05-10T13:00:00Z", "2026-05-10T17:00:00Z"]) {
    assert(isFxClosedAt(ms(t)), `${t} precedes the weekly open`);
  }
});

Deno.test("the Sunday open itself is OPEN", () => {
  // 17:00 EDT = 21:00 UTC. Three live blocks sit here and they are legitimate;
  // filtering on a fixed UTC hour would have thrown them away.
  assert(!isFxClosedAt(ms("2026-05-31T21:00:00Z")), "21:00 UTC in summer is the open");
  assert(!isFxClosedAt(ms("2026-05-31T22:00:00Z")));
});

Deno.test("the boundary moves with DST, not with the clock", () => {
  // January: 17:00 EST = 22:00 UTC, so 21:00 UTC is still shut.
  assert(isFxClosedAt(ms("2026-01-11T21:00:00Z")), "21:00 UTC in winter is still closed");
  assert(!isFxClosedAt(ms("2026-01-11T22:00:00Z")), "22:00 UTC in winter is the open");
  // July: 17:00 EDT = 21:00 UTC, so 21:00 UTC is open.
  assert(!isFxClosedAt(ms("2026-07-12T21:00:00Z")), "21:00 UTC in summer is open");
});

Deno.test("Friday closes at 17:00 ET", () => {
  assert(!isFxClosedAt(ms("2026-05-29T20:00:00Z")), "before the close");
  assert(isFxClosedAt(ms("2026-05-29T21:00:00Z")), "after the close");
});

Deno.test("midweek is never filtered", () => {
  for (const t of ["2026-05-11T09:00:00Z", "2026-05-13T00:00:00Z", "2026-05-14T21:00:00Z"]) {
    assert(!isFxClosedAt(ms(t)), t);
  }
});

Deno.test("only forex is filtered", () => {
  // Crypto trades continuously and index futures keep their own calendar.
  // Filtering either against FX hours would delete real bars.
  const bars = [
    { datetime: "2026-05-29T12:00:00Z" },   // Friday, open
    { datetime: "2026-05-30T12:00:00Z" },   // Saturday
    { datetime: "2026-05-31T21:00:00Z" },   // Sunday open
  ];
  assertEquals(dropFxClosedBars(bars, true).map(b => b.datetime),
    ["2026-05-29T12:00:00Z", "2026-05-31T21:00:00Z"]);
  assertEquals(dropFxClosedBars(bars, false).length, 3, "non-forex is untouched");
});

Deno.test("an unparseable timestamp is kept, not silently dropped", () => {
  // Deleting a bar because its stamp could not be read would quietly shorten
  // the series and change structure detection with no error anywhere.
  const bars = [{ datetime: "not-a-date" }, { datetime: "2026-05-30T12:00:00Z" }];
  assertEquals(dropFxClosedBars(bars, true).map(b => b.datetime), ["not-a-date"]);
});

Deno.test("the V2 runner filters, and only V2 does", () => {
  const runner = Deno.readTextFileSync(
    new URL("../../functions/_shared/structuralOrderBlockRunner.ts", import.meta.url));
  assert(/dropFxClosedBars\(s\.candles \?\? \[\], isForex\)/.test(runner));
  assert(/type === "forex"/.test(runner), "asset-aware");

  // Legacy engines still read the contaminated series. That is deliberate:
  // filtering there changes which trades fire and is a separate decision.
  const scanner = Deno.readTextFileSync(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url));
  assert(!/dropFxClosedBars/.test(scanner),
    "bot-scanner must not start filtering behind a shadow-mode change");
});
