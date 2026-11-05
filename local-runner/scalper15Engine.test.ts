import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { entryFill, lastClosedIndex, MIN, resolveExit, tradeableAt } from "./scalper15Engine.ts";

/** Wednesday 2026-04-01 00:00 UTC onward, one bar per step. */
const WED = Date.UTC(2026, 3, 1);
const bars = (rows: Array<[number, number, number, number]>, stepMs: number, t0 = WED): Candle[] =>
  rows.map(([open, high, low, close], i) => ({ datetime: new Date(t0 + i * stepMs).toISOString(), open, high, low, close }));
const h = 60 * MIN;

Deno.test("closed-bar lookup: a bar is visible only once open + tf ≤ t", () => {
  const open = [0, 60, 120].map((m) => WED + m * MIN);
  assertEquals(lastClosedIndex(open, h, WED + 59 * MIN), -1);
  assertEquals(lastClosedIndex(open, h, WED + 60 * MIN), 0);
  assertEquals(lastClosedIndex(open, h, WED + 179 * MIN), 1);
});

Deno.test("fills: a long pays the ask, a short the bid", () => {
  assertAlmostEquals(entryFill(1.1, 1, 0.0002), 1.1001);
  assertAlmostEquals(entryFill(1.1, -1, 0.0002), 1.0999);
});

const S = 0.0002, SLIP = 0.00003;
const m1 = (rows: Array<[number, number, number, number]>) => bars(rows, MIN);

Deno.test("exit: the target triggers on the bid, not the mid", () => {
  // target 1.1020; a mid high of 1.10205 is only 1.10195 on the bid → not hit
  const r1 = resolveExit(m1([[1.1, 1.1001, 1.0999, 1.1], [1.1, 1.10205, 1.1, 1.102]]), 0, 1, 1.099, 1.102, S, SLIP);
  assertEquals(r1.reason, "OPEN");
  const r2 = resolveExit(m1([[1.1, 1.1001, 1.0999, 1.1], [1.1, 1.1023, 1.1, 1.102]]), 0, 1, 1.099, 1.102, S, SLIP);
  assertEquals(r2.reason, "TARGET");
  assertEquals(r2.exit, 1.102);
});

Deno.test("exit: the stop triggers on the bid and fills with slippage", () => {
  const r = resolveExit(m1([[1.1, 1.1001, 1.0999, 1.1], [1.1, 1.1, 1.09905, 1.0995]]), 0, 1, 1.099, 1.102, S, SLIP);
  assertEquals(r.reason, "STOP");
  assertAlmostEquals(r.exit, 1.099 - SLIP);
});

Deno.test("exit: a later bar opening through the stop fills at that open", () => {
  const r = resolveExit(m1([[1.1, 1.1001, 1.0999, 1.1], [1.098, 1.0982, 1.0978, 1.098]]), 0, 1, 1.099, 1.102, S, SLIP);
  assertEquals(r.reason, "STOP_GAP");
  assertAlmostEquals(r.exit, 1.098 - S / 2 - SLIP);
});

Deno.test("exit: stop and target in one minute is AMBIGUOUS, priced at the stop", () => {
  const r = resolveExit(m1([[1.1, 1.1001, 1.0999, 1.1], [1.1, 1.1025, 1.0985, 1.1]]), 0, 1, 1.099, 1.102, S, SLIP);
  assertEquals(r.reason, "AMBIGUOUS");
  assertAlmostEquals(r.exit, 1.099 - SLIP);
  assertEquals(r.altExit, 1.102);
});

Deno.test("exit: shorts mirror — exits trigger on the ask", () => {
  const r = resolveExit(m1([[1.1, 1.1001, 1.0999, 1.1], [1.1, 1.1, 1.0977, 1.098]]), 0, -1, 1.101, 1.098, S, SLIP);
  assertEquals(r.reason, "TARGET");
  const s = resolveExit(m1([[1.1, 1.1001, 1.0999, 1.1], [1.1, 1.10095, 1.1, 1.1]]), 0, -1, 1.101, 1.098, S, SLIP);
  assertEquals(s.reason, "STOP");   // ask high = 1.10105 ≥ 1.101
});

Deno.test("weekend: the FX tape is skipped and a Monday gap through the stop fills at the open", () => {
  assert(!tradeableAt(Date.UTC(2026, 3, 4, 12)));
  assert(tradeableAt(Date.UTC(2026, 3, 5, 22, 0)));
  const fri = Date.UTC(2026, 3, 3, 21, 58);
  const m: Candle[] = [
    { datetime: new Date(fri).toISOString(), open: 1.1, high: 1.1001, low: 1.0999, close: 1.1 },
    { datetime: new Date(Date.UTC(2026, 3, 4, 12)).toISOString(), open: 1.08, high: 1.08, low: 1.07, close: 1.08 },     // Saturday tape: ignored
    { datetime: new Date(Date.UTC(2026, 3, 5, 22)).toISOString(), open: 1.0985, high: 1.0986, low: 1.098, close: 1.098 }, // Sunday open gaps through
  ];
  const r = resolveExit(m, 0, 1, 1.099, 1.102, S, SLIP);
  assertEquals(r.reason, "STOP_GAP");
  assertAlmostEquals(r.exit, 1.0985 - S / 2 - SLIP);
});
