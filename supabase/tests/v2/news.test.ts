import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clause } from "./helpers/clause.ts";
import { nyLocalToUtc } from "../../functions/_shared/v2/calendar.ts";
import { feedAt, newsBlock, validate } from "../../functions/_shared/v2/v2News.ts";

const T = nyLocalToUtc(2026, 10, 7, 8, 30);
const ev = (o: Partial<Record<string, string>> = {}) => ({ title: "CPI", country: "USD", date: "2026-10-07T08:30:00-04:00", impact: "High", ...o });

clause(["8.1"], "news block: High impact, base or quote currency, |t − date| ≤ 30 min (inclusive)", () => {
  const e = validate({ fetchTime: T - 600_000, httpStatus: 200, body: [ev()] }).events;
  assert(newsBlock("EUR/USD", e, T + 30 * 60_000));
  assertFalse(newsBlock("EUR/USD", e, T + 30 * 60_000 + 1));
  assert(newsBlock("EUR/USD", e, T - 30 * 60_000));
  assertFalse(newsBlock("NZD/CHF", e, T));
  const m = validate({ fetchTime: T - 600_000, httpStatus: 200, body: [ev({ impact: "Medium" })] }).events;
  assertFalse(newsBlock("EUR/USD", m, T));
  const chf = validate({ fetchTime: T - 600_000, httpStatus: 200, body: [ev({ country: "CHF" })] }).events;
  assert(newsBlock("NZD/CHF", chf, T)); assert(newsBlock("CHF/JPY", chf, T));
});

clause(["8.2"], "feed AVAILABLE only for a fresh (≤ 60 min), HTTP 200, schema-valid snapshot of the week containing t; empty array is AVAILABLE", () => {
  const ok = { fetchTime: T - 60 * 60_000, httpStatus: 200, body: [ev()] };
  assert(feedAt([ok], T, T).available);
  assertFalse(feedAt([ok], T, T + 1).available);                                    // 60 min + 1 ms
  assertFalse(feedAt([{ ...ok, httpStatus: 500 }], T, T).available);
  assertFalse(feedAt([{ ...ok, body: [{ title: "x" }] }], T, T).available);
  assertFalse(feedAt([{ ...ok, body: [ev({ date: "2026-10-07T08:30:00" })] }], T, T).available);   // no offset
  assertFalse(feedAt([{ ...ok, body: [ev({ date: "2026-10-12T08:30:00-04:00" })] }], T, T).available); // outside the week
  assert(feedAt([{ ...ok, body: [] }], T, T).available);
  assertFalse(feedAt([{ ...ok, body: { not: "array" } }], T, T).available);
  assertFalse(feedAt([], T, T).available);
  // latest fetch at or before the run wins (a later failed fetch makes the feed UNAVAILABLE)
  assertFalse(feedAt([ok, { fetchTime: T - 60_000, httpStatus: 503, body: null }], T, T).available);
  // snapshot week must contain t
  const sunday = nyLocalToUtc(2026, 10, 11, 0, 5);
  assertFalse(feedAt([{ ...ok, fetchTime: sunday - 10 * 60_000, body: [] }], sunday, sunday).available);
});

clause(["8.3"], "validation reports week id and event count (persisted fields)", () => {
  const v = validate({ fetchTime: T, httpStatus: 200, body: [ev(), ev({ title: "NFP" })] });
  assertEquals([v.ok, v.weekId, v.events.length], [true, "2026-10-04", 2]);
});
