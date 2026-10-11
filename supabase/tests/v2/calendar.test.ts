import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clause } from "./helpers/clause.ts";
import {
  asianEnd, EXPLICIT_CLOSURES, inAsianRange, inTradingWindow, isExpected, newsWeekOf, nyLocalToUtc, nyParts, tradingDayOf, tradingDayStart,
} from "../../functions/_shared/v2/calendar.ts";
import { ny as checkerNy } from "../../functions/_shared/v2check/checker.ts";

const utc = (s: string) => Date.parse(s);

clause(["0.11"], "IANA America/New_York, DST-correct across both 2026 switches and March 2027", () => {
  // 2026-03-08 (Mar 1 is a Sunday — the legacy toNYTime gets this week wrong)
  assertEquals(nyParts(utc("2026-03-08T06:59:00Z")).h, 1);   // 01:59 EST
  assertEquals(nyParts(utc("2026-03-08T07:00:00Z")).h, 3);   // 03:00 EDT
  assertEquals(nyParts(utc("2026-03-10T12:00:00Z")).h, 8);   // EDT (legacy says 7)
  assertEquals(nyParts(utc("2026-11-01T05:59:00Z")).h, 1);   // 01:59 EDT
  assertEquals(nyParts(utc("2026-11-01T06:00:00Z")).h, 1);   // 01:00 EST (repeated hour)
  assertEquals(nyParts(utc("2027-03-14T07:00:00Z")).h, 3);
  assertEquals(nyParts(utc("2027-03-13T12:00:00Z")).h, 7);   // still EST on Saturday 13th
});

clause(["0.11"], "checker's hand-written US DST rule equals IANA every hour 2026-01-01 → 2028-01-01", () => {
  for (let t = utc("2026-01-01T00:00:00Z"); t < utc("2028-01-01T00:00:00Z"); t += 3_600_000) {
    const a = nyParts(t), b = checkerNy(t);
    if (a.h !== b.h || a.d !== b.d || a.dow !== b.dow) throw new Error(`mismatch at ${new Date(t).toISOString()}`);
  }
});

clause(["1.1", "1.2"], "weekly closure Fri 17:00 → Sun 17:00 NY, boundary equality, both DST regimes", () => {
  assert(isExpected(nyLocalToUtc(2026, 10, 9, 16, 55)));          // Fri 16:55 interval expected
  assertFalse(isExpected(nyLocalToUtc(2026, 10, 9, 17, 0)));      // Fri 17:00 not
  assertFalse(isExpected(nyLocalToUtc(2026, 10, 11, 16, 55)));    // Sun 16:55 not
  assert(isExpected(nyLocalToUtc(2026, 10, 11, 17, 0)));          // Sun 17:00 expected
  assertFalse(isExpected(nyLocalToUtc(2026, 10, 10, 12, 0)));     // Saturday
  // winter: Fri 17:00 NY = 22:00Z
  assert(isExpected(utc("2026-11-13T21:55:00Z")));
  assertFalse(isExpected(utc("2026-11-13T22:00:00Z")));
  // March 2026 week the legacy isFxClosedAt gets wrong: Sun 2026-03-08 17:00 EDT = 21:00Z is open
  assert(isExpected(utc("2026-03-08T21:00:00Z")));
  assertFalse(isExpected(utc("2026-03-13T21:00:00Z")));           // Fri 17:00 EDT closed
});

clause(["1.1"], "explicit closures: Christmas and New Year 2026/27, half-open at their 17:00 NY ends", () => {
  assertEquals(EXPLICIT_CLOSURES.map((c) => new Date(c.from).toISOString()), ["2026-12-24T22:00:00.000Z", "2026-12-31T22:00:00.000Z"]);
  assertFalse(isExpected(utc("2026-12-24T22:00:00Z")));
  assert(isExpected(utc("2026-12-24T21:55:00Z")));
  assertFalse(isExpected(utc("2026-12-29T12:00:00Z")) && false); // Tue 29th is an ordinary weekday
  assert(isExpected(utc("2026-12-29T12:00:00Z")));
  assertFalse(isExpected(utc("2027-01-03T21:55:00Z")));
  assert(isExpected(utc("2027-01-03T22:00:00Z")));
});

clause(["0.8"], "trading window [02:00, 12:00) NY on Mon–Fri by the close's NY date", () => {
  assertFalse(inTradingWindow(nyLocalToUtc(2026, 10, 6, 1, 55)));
  assert(inTradingWindow(nyLocalToUtc(2026, 10, 6, 2, 0)));
  assert(inTradingWindow(nyLocalToUtc(2026, 10, 6, 11, 55)));
  assertFalse(inTradingWindow(nyLocalToUtc(2026, 10, 6, 12, 0)));
  assertFalse(inTradingWindow(nyLocalToUtc(2026, 10, 11, 3, 0)));   // Sunday
  assert(inTradingWindow(utc("2026-11-03T07:00:00Z")));             // 02:00 EST
  assertFalse(inTradingWindow(utc("2026-11-03T06:55:00Z")));
});

clause(["0.9"], "NY trading day 17:00:00 → 16:59:59, labelled by end date; previous day skips the weekend", () => {
  assertEquals(tradingDayOf(nyLocalToUtc(2026, 10, 6, 16, 55)), "2026-10-06");
  assertEquals(tradingDayOf(nyLocalToUtc(2026, 10, 6, 17, 0)), "2026-10-07");
  assertEquals(tradingDayOf(nyLocalToUtc(2026, 10, 11, 17, 0)), "2026-10-12");   // Sunday evening → Monday
  assertEquals(new Date(tradingDayStart("2026-10-12")).toISOString(), "2026-10-11T21:00:00.000Z");
  assertEquals(new Date(tradingDayStart("2026-11-02")).toISOString(), "2026-11-01T22:00:00.000Z"); // EST after the switch
});

clause(["7.1"], "Asian range [20:00, 02:00) NY and its 02:00 end", () => {
  assert(inAsianRange(nyLocalToUtc(2026, 10, 5, 20, 0)));
  assert(inAsianRange(nyLocalToUtc(2026, 10, 6, 1, 55)));
  assertFalse(inAsianRange(nyLocalToUtc(2026, 10, 6, 2, 0)));
  assertFalse(inAsianRange(nyLocalToUtc(2026, 10, 5, 19, 55)));
  assertEquals(asianEnd("2026-10-06"), nyLocalToUtc(2026, 10, 6, 2, 0));
});

clause(["8.2"], "news week Sunday 00:00 → next Sunday 00:00 NY", () => {
  const w = newsWeekOf(nyLocalToUtc(2026, 10, 7, 9, 0));
  assertEquals(w.id, "2026-10-04");
  assertEquals(w.from, nyLocalToUtc(2026, 10, 4, 0, 0));
  assertEquals(w.to, nyLocalToUtc(2026, 10, 11, 0, 0));
  assertEquals(newsWeekOf(nyLocalToUtc(2026, 10, 11, 0, 0)).id, "2026-10-11");
});
