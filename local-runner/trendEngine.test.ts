import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { atrWilder, type Bar, breakoutEntry, costR, type Params, runTrend, summarize } from "./trendEngine.ts";

const P: Params = { entryN: 5, exitN: 3, atrN: 3, stopAtr: 2 };
const FREE = { roundTrip: 0, roundTripPct: 0, finPerYear: 0 };

/** One bar per UTC day; h/l = c ± 0.5 unless given. */
function series(rows: Array<[number, number, number?, number?]>): Bar[] {
  return rows.map(([o, c, h, l], i) => ({
    t: new Date(Date.UTC(2020, 0, 1 + i)).toISOString(),
    o, c, h: h ?? Math.max(o, c) + 0.5, l: l ?? Math.min(o, c) - 0.5,
  }));
}

/** Six quiet bars at 100 so every window is defined and ATR = 1. */
const FLAT: Array<[number, number]> = Array.from({ length: 6 }, () => [100, 100]);

Deno.test("ATR is NaN until n true ranges exist, then Wilder-smoothed", () => {
  const atr = atrWilder(series([...FLAT]), 3);
  assert(Number.isNaN(atr[2]));
  assertAlmostEquals(atr[3], 1);
  assertAlmostEquals(atr[5], 1);
});

Deno.test("a breakout at close t enters at the open of t+1, never at t", () => {
  const bars = series([...FLAT, [100, 102], [103, 103.2], [103.2, 103.4]]);
  const [t] = runTrend(bars, P, FREE);
  assertEquals(t.signalT, bars[6].t);
  assertEquals(t.entryT, bars[7].t);
  assertEquals(t.entry, 103);
  assertEquals(t.dir, 1);
  assertEquals(t.reason, "OPEN");
});

Deno.test("the breakout window excludes the signal bar itself", () => {
  // Bar 6 closes at 100.4: below the previous highs (100.5), so no signal even though
  // its own high is 101. Including bar 6 in its own window would make breakouts impossible.
  const bars = series([...FLAT, [100, 100.4, 101, 99.9], [100.4, 100.4]]);
  assertEquals(breakoutEntry(5)(bars, 6), 0);
  assertEquals(runTrend(bars, P, FREE).length, 0);
});

Deno.test("intraday stop fills at the stop; R = stopAtr × ATR at the signal bar", () => {
  // Bar 6's true range is 3, so ATR(3) there is 5/3 and 1R = 10/3: the stop sits at 99.67.
  const bars = series([...FLAT, [100, 102], [103, 103], [103, 101, 103.5, 99]]);
  const [t] = runTrend(bars, P, FREE);
  const risk = 2 * atrWilder(bars, 3)[6];
  assertAlmostEquals(t.risk, risk);
  assertAlmostEquals(t.stop, 103 - risk);
  assertEquals(t.reason, "STOP");
  assertAlmostEquals(t.grossR, -1);
});

Deno.test("a gap through the stop fills at the open, worse than −1R", () => {
  const bars = series([...FLAT, [100, 102], [103, 103], [97, 96]]);
  const [t] = runTrend(bars, P, FREE);
  assertEquals(t.reason, "STOP_GAP");
  assertEquals(t.exit, 97);
  assert(t.grossR < -1);
});

Deno.test("channel exit: close below the previous 3 lows exits at the next open", () => {
  const bars = series([
    ...FLAT, [100, 102], [103, 105], [105, 107], [107, 109],
    [109, 102, 109.2, 101.8],   // close 102 < min low of previous 3 (102.5); stop 99.67 untouched
    [102.2, 102],
  ]);
  const [t] = runTrend(bars, P, FREE);
  assertEquals(t.reason, "CHANNEL");
  assertEquals(t.exitT, bars[11].t);
  assertEquals(t.exit, 102.2);
});

Deno.test("shorts mirror longs", () => {
  // 1R = 10/3 again, so the short's stop sits at 100.33.
  const bars = series([...FLAT, [100, 98], [97, 97], [97, 99, 101, 96.5]]);
  const [t] = runTrend(bars, P, FREE);
  assertEquals(t.dir, -1);
  assertEquals(t.entry, 97);
  assertEquals(t.reason, "STOP");
  assertAlmostEquals(t.grossR, -1);
});

Deno.test("costs: round trip + % of price + financing per calendar day, all in R", () => {
  // 2 price-unit round trip, 0.1% of 100, 3.65%/yr for 10 days on notional 100, risk 4
  const c = costR({ roundTrip: 2, roundTripPct: 0.001, finPerYear: 0.0365 }, 100, 4, 10);
  // financing: 3.65%/yr × 10/365 = 0.1% of notional 100 = 0.1, over risk 4
  assertAlmostEquals(c, (2 + 0.1) / 4 + 0.1 / 4);
});

Deno.test("one position per instrument: signals while in a trade are ignored", () => {
  const bars = series([...FLAT, [100, 102], [103, 104], [104, 106], [106, 108], [108, 110]]);
  const ts = runTrend(bars, P, FREE);
  assertEquals(ts.length, 1);
});

Deno.test("summarize: expectancy, PF, closed-trade drawdown", () => {
  const s = summarize([2, -1, -1, 3, -1]);
  assertEquals(s.n, 5);
  assertAlmostEquals(s.exp, 0.4);
  assertAlmostEquals(s.pf, 5 / 3);
  assertAlmostEquals(s.maxDD, 2);
  assert(s.ciLo <= s.exp && s.exp <= s.ciHi);
});
