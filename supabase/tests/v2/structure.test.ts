import { assert, assertEquals, assertFalse, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clause } from "./helpers/clause.ts";
import { D, mkSeries, P } from "./helpers/series.ts";
import type { OHLC } from "./helpers/scenario.ts";
import { buildStructure, protectedSwing, swingRecord, unbrokenAt, view, visibleBreaks, visibleSwings } from "../../functions/_shared/v2/v2Structure.ts";
import { anyMissing, buildSeries, contiguous, isProviderWide, lastClosed, toPoints } from "../../functions/_shared/v2/barStore.ts";
import { atrSum } from "../../functions/_shared/v2/atr.ts";

const F: OHLC = [0, 1, -1, 0];               // flat: equal highs/lows → never a swing
const mirror = (bs: (OHLC | null)[]) => bs.map((b) => (b ? [-b[0], -b[2], -b[1], -b[3]] as OHLC : null));

clause(["0.3", "1.3"], "prices become exact integer points; too many decimals are rejected", () => {
  assertEquals(toPoints("EUR/USD", 1.16394), 11639400);
  assertEquals(toPoints("USD/JPY", 158.31985), 15831985);
  assertThrows(() => toPoints("USD/JPY", 158.319851));
});

clause(["1.3", "1.3a", "1.4"], "MISSING slots split segments; series start is a segment start; provider-wide needs all six pairs", () => {
  const s = mkSeries([F, F, null, F, F, F]);
  assertEquals([...s.seg], [0, 0, -1, 1, 1, 1]);
  assertEquals([...s.segStart], [0, 0, -1, 3, 3, 3]);
  assert(contiguous(s, 3, 5)); assertFalse(contiguous(s, 1, 4));
  assert(anyMissing(s, 0, 3)); assertFalse(anyMissing(s, 3, 5));
  assertEquals(lastClosed(s.grid, s.step, s.grid[3] + s.step), 3);
  assertEquals(lastClosed(s.grid, s.step, s.grid[3] + s.step - 1), 2);
  const store = { series: Object.fromEntries(["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF"].map((p) => [p, { "1h": s }])) } as never;
  assert(isProviderWide(store, "1h", 2));
  assertFalse(isProviderWide(store, "1h", 1));
});

clause(["1.2"], "bars stamped in non-expected time are dropped", () => {
  const sat = Date.parse("2026-10-10T12:00:00Z");
  const s = buildSeries("EUR/USD", "1h", [{ t: sat, o: 1.16, h: 1.161, l: 1.159, c: 1.16 }], [sat]);
  assertEquals(s.bars[0], null);
});

clause(["0.6"], "strict N=2 fractal: strict inequality on all four neighbours; equal values never swing; LONG/SHORT mirror", () => {
  const bars: OHLC[] = [F, F, [0, 5, -1, 0], F, F, F, [0, 1, -1, 0]];
  const ix = buildStructure(mkSeries(bars));
  assertEquals(ix.swings.map((s) => [s.i, s.kind, s.level]), [[2, "H", P(5)]]);
  const ixm = buildStructure(mkSeries(mirror(bars)));
  assertEquals(ixm.swings.map((s) => [s.i, s.kind, s.level]), [[2, "L", P(-5)]]);
  // equality with one neighbour → no swing
  const eq = buildStructure(mkSeries([F, F, [0, 5, -1, 0], [0, 5, -1, 0], F, F]));
  assertEquals(eq.swings.length, 0);
  // exists from the close of i+2 (conf = i+2)
  assertEquals(ix.swings[0].conf, 4);
});

clause(["0.6", "1.3a"], "a swing needs five present bars in one segment", () => {
  const ix = buildStructure(mkSeries([F, F, [0, 5, -1, 0], null, F, F]));
  assertEquals(ix.swings.length, 0);
  const ix2 = buildStructure(mkSeries([null, F, [0, 5, -1, 0], F, F, F]));
  assertEquals(ix2.swings.length, 0);
});

clause(["2.0"], "break = first close strictly beyond after confirmation; a wick or an equal close is not a break; once only", () => {
  //            0  1  2(H5)        3  4  5 wick6   6 close=5     7 close 5.1      8 close 6
  const bars: OHLC[] = [F, F, [0, 5, -1, 0], F, F, [0, 6, -1, 0], [0, 5, -1, 5], [0, 5.2, -1, 5.1], [0, 6, -1, 6]];
  const ix = buildStructure(mkSeries(bars));
  const h = ix.swings.find((s) => s.i === 2)!;
  assertEquals(h.breakIdx, 7);                 // bar 5: wick only; bar 6: close == level; bar 7: close > level
  assert(unbrokenAt(h, 6)); assertFalse(unbrokenAt(h, 7));
  const ixm = buildStructure(mkSeries(mirror(bars)));
  assertEquals(ixm.swings.find((s) => s.i === 2)!.breakIdx, 7);
});

clause(["2.0", "1.3a"], "a pre-gap swing is never broken by a post-gap bar", () => {
  const ix = buildStructure(mkSeries([F, F, [0, 5, -1, 0], F, F, null, [0, 9, -1, 9]]));
  assertEquals(ix.swings[0].breakIdx, -1);
});

clause(["2.0"], "window membership: a swing is visible only if all five bars are inside window ∩ current segment", () => {
  const bars: OHLC[] = [F, F, [0, 5, -1, 0], F, F, F, F, F];
  const s = mkSeries(bars), ix = buildStructure(s);
  assertEquals(visibleSwings(ix, view(s, 7, 8)).length, 1);
  assertEquals(visibleSwings(ix, view(s, 7, 7)).length, 0);   // window starts at slot 1 → bar 0 outside
  const g = mkSeries([F, F, [0, 5, -1, 0], F, F, null, F, F]);
  assertEquals(visibleSwings(buildStructure(g), view(g, 7, 50)).length, 0);   // swing in an earlier segment
  assertEquals(view(g, 5, 50).seg, -1);                                       // L MISSING → no current segment
});

clause(["2.0"], "swing record keeps swings from earlier segments (AM2); visible breaks only up to L", () => {
  const g = mkSeries([F, F, [0, 5, -1, 0], F, F, null, F, F, F]);
  const ix = buildStructure(g);
  assertEquals(swingRecord(ix, 8).length, 1);
  assertEquals(swingRecord(ix, 3).length, 0);                                  // not yet confirmed at L=3
  const s = mkSeries([F, F, [0, 5, -1, 0], F, F, [0, 6, -1, 6], F]);
  const ix2 = buildStructure(s);
  assertEquals(visibleBreaks(ix2, view(s, 4, 50)).length, 0);
  assertEquals(visibleBreaks(ix2, view(s, 5, 50)).length, 1);
});

clause(["5.1", "2.0", "PS"], "protected swing: in 5m scope (five bars after b), confirmed by k−1, unbroken at k−1, most recent", () => {
  const bars: OHLC[] = [F, F, F, [0, 4, -1, 0], F, F, [0, 3, -1, 0], F, F, F, [0, 5, -1, 5]];
  const s = mkSeries(bars, "5m"), ix = buildStructure(s);
  // swings H at 3 (4) and 6 (3); at k=9 most recent unbroken = 6
  assertEquals(protectedSwing(ix, "H", 0, 9)!.i, 6);
  // PS: the swing bar must be in scope; its left context bars may precede it
  assertEquals(protectedSwing(ix, "H", 3, 8)!.i, 3);            // scope starts at the swing bar itself (left bars 1, 2 before scope)
  assertEquals(protectedSwing(ix, "H", 4, 8), null);            // swing bar 3 before scope → excluded
  // swing 6 confirmed at 8: at k=8 it is not yet usable (conf ≤ k−1 fails) → swing 3
  assertEquals(protectedSwing(ix, "H", 0, 8)!.i, 3);
  // bar 10 closes 5 > 3 → breaks swing 6 at 10; at k=11 swing 6 is broken (k−1=10) → swing 3 (4 < 5 close → broken too at 10)
  assertEquals(protectedSwing(ix, "H", 0, 11), null);
  const sm = mkSeries(mirror(bars), "5m");
  assertEquals(protectedSwing(buildStructure(sm), "L", 0, 9)!.i, 6);
});

clause(["0.5", "11.4"], "ATR14 = mean of 14 TRs over 15 consecutive present bars (via calculateATR); MISSING → not computable", () => {
  const bars: OHLC[] = [];
  for (let i = 0; i < 15; i++) bars.push([0, 2, -2, 1]);
  const s = mkSeries(bars);
  assertEquals(atrSum(s, 14), D(4) * 14);
  assertEquals(atrSum(s, 13), null);                       // only 14 bars
  const g = mkSeries([...bars.slice(0, 7), null, ...bars.slice(8)]);
  assertEquals(atrSum(g, 14), null);
  // true range uses the previous close: gap up open
  const gp: OHLC[] = [...bars.slice(0, 14), [10, 12, 9, 11]];
  assertEquals(atrSum(mkSeries(gp), 14), D(4) * 13 + D(11));   // max(3, |12−1|, |9−1|) = 11
});

clause(["5.1", "PS", "1.3a"], "PS: left context bars before the scope must still be present (a MISSING left bar → no swing)", () => {
  const bars: (OHLC | null)[] = [F, null, F, [0, 4, -1, 0], F, F, F, F];
  const ix = buildStructure(mkSeries(bars, "5m"));
  assertEquals(protectedSwing(ix, "H", 3, 7), null);
});
