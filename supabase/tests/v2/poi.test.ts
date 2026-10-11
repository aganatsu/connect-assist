import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clause } from "./helpers/clause.ts";
import { D, mkSeries, P } from "./helpers/series.ts";
import { baseScenario, type OHLC } from "./helpers/scenario.ts";
import { buildStructure } from "../../functions/_shared/v2/v2Structure.ts";
import { isDisplacement, type Leg, legsAt, poisOf } from "../../functions/_shared/v2/v2Poi.ts";

const mir = (bs: (OHLC | null)[]) => bs.map((b) => (b ? [-b[0], -b[2], -b[1], -b[3]] as OHLC : null));
const H = (): (OHLC | null)[] => baseScenario().h1.slice(0, 34);
function legs(bars: (OHLC | null)[], B = 29) {
  const s = mkSeries(bars, "1h");
  return { s, legs: legsAt("EUR/USD", s, buildStructure(s), B) };
}

clause(["3.1", "3.2"], "LONG leg: o=25 (swing low −10), j=22 (latest swing high before o), b=29 (first close > 10); mirror → SHORT", () => {
  const { legs: L } = legs(H());
  assertEquals(L.length, 1);
  assertEquals([L[0].dir, L[0].o, L[0].j, L[0].b, L[0].legHigh, L[0].legLow], ["LONG", 25, 22, 29, P(15), P(-10)]);
  const { legs: M } = legs(mir(H()));
  assertEquals([M[0].dir, M[0].o, M[0].j, M[0].b, M[0].legHigh, M[0].legLow], ["SHORT", 25, 22, 29, P(10), P(-15)]);
});

clause(["3.1"], "b − o ≥ 3 boundary: o at 26 (b − o = 3) qualifies, b − o = 2 does not", () => {
  const ok = H(); ok[25] = [-7, -5, -7.5, -6]; ok[26] = [-4, -3, -10, -6];   // origin moves to 26
  assertEquals(legs(ok).legs.map((l) => l.o), [26]);
  // origin 27 (only swing low): 24 raised to −7.4 so it is not a swing low → b−o = 2 → no leg
  const bad = H(); bad[24] = [-2, 0, -7.4, -7]; bad[25] = [-7, -5, -7.5, -6]; bad[26] = [-4, -3, -7.6, -6]; bad[27] = [-6, 3, -10, 2];
  assertEquals(legs(bad).legs.length, 0);
});

clause(["3.1"], "O1: a close beyond the origin before b → that origin produces no leg (both directions)", () => {
  const b = H(); b[27] = [-6, 3, -11, -10.5];                 // close −10.5 < low[o] −10 inside (o, b]
  b[27] = [-6, -5, -11, -10.5]; b[28] = [-10.5, 8, -10.6, 7];
  const r = legs(b);
  assertFalse(r.legs.some((l) => l.o === 25));
  assertFalse(legs(mir(b)).legs.some((l) => l.o === 25));
});

clause(["3.1"], "the reference must be unbroken at o: j broken before o → no leg", () => {
  // j=22 (10) breaks at 25 (close 10.5); 25/26 equal highs → no newer swing high; o=28 swing low; later close 11.5
  const b = H().slice(0, 22);
  b.push([1, 10, 0, 8], [8, 9, -3, -2], [-2, 0, -8, -7], [-7, 10.6, -7.5, 10.5], [10.5, 10.6, 2, 3], [3, 4, -9, -8],
    [-8, -6, -10, -7], [-7, -2, -8, -3], [-3, 5, -4, 4], [4, 12, 3, 11.5], [11.5, 12, 11, 11.5], [11.5, 12, 11, 11.5]);
  const s = mkSeries(b, "1h"), ix = buildStructure(s);
  assertEquals(ix.swings.find((w) => w.i === 22)!.breakIdx, 25);
  assertEquals(legsAt("EUR/USD", s, ix, 25).length, 0);       // origin 24 → b − o = 1
  assertEquals(legsAt("EUR/USD", s, ix, 31).length, 0);       // origin 28: reference 22 already broken at 25
});

clause(["3.1", "1.3a"], "every bar from min(j−2, o−20) to b must be in one segment", () => {
  const g = H(); g[6] = null;                                 // o−20 = 5 → slot 6 inside the span
  assertEquals(legs(g).legs.length, 0);
  const g2 = H(); g2[4] = null;                               // before o−20 → irrelevant
  assertEquals(legs(g2).legs.length, 1);
});

clause(["3.3", "0.7"], "displacement candle thresholds are inclusive; colour required; mirror", () => {
  // baseline sums for 20 bars with body 1 pip and range 4 pips
  const sb = D(1) * 20, sr = D(4) * 20;
  // body 2.0×avg, body/range exactly 0.7, range exactly 1.5×avg → body 2.1, range 3? need range ≥ 6 → choose body 4.2, range 6
  assert(isDisplacement("LONG", { o: 0, h: D(6), l: 0, c: D(4.2) }, sb, sr));
  assertFalse(isDisplacement("LONG", { o: 0, h: D(6), l: 0, c: D(4.19) }, sb, sr));      // body/range < 0.7
  assertFalse(isDisplacement("LONG", { o: 0, h: D(5.99), l: 0, c: D(4.2) }, sb, sr));    // range < 1.5×avg
  assert(isDisplacement("LONG", { o: 0, h: D(10), l: 0, c: D(10) }, D(5) * 20, sr));     // body exactly 2×avgBody (5)
  assertFalse(isDisplacement("LONG", { o: 0, h: D(10), l: 0, c: D(10) }, D(5.01) * 20, sr));
  assertFalse(isDisplacement("SHORT", { o: 0, h: D(6), l: 0, c: D(4.2) }, sb, sr));      // wrong colour
  assert(isDisplacement("SHORT", { o: D(4.2), h: D(6), l: 0, c: 0 }, sb, sr));
  assertFalse(isDisplacement("LONG", { o: D(1), h: D(6), l: 0, c: D(1) }, sb, sr));      // close = open is neither colour
});

clause(["3.3"], "leg qualifies iff count ≥ ceil(0.10·n) OR max single-bar range ≥ 2.0 × avgRange; else no POIs", () => {
  const { s, legs: L } = legs(H());
  assert(L[0].qualifies);
  // baseline 5..24 includes j..o: avgBody 1.95, avgRange 4.9 → bar 28 (range 7 < 7.35) is not a displacement candle
  assertEquals(L[0].displacementCount, 2);                    // bars 27, 29
  // remove displacement and keep every leg bar's range < 8 pips (2 × avgRange 4) → not qualifying
  const b = H(); b[27] = [-6, -1, -7, -2]; b[28] = [-2, 4, -3, 3]; b[29] = [6, 10.5, 3, 10.4];   // max range 7.5 < 9.8
  const r = legs(b);
  assertEquals(r.legs[0]?.qualifies, false);
  assertEquals(poisOf(r.legs[0], r.s).length, 0);
  // range alternative at exactly 2.0 × avgRange (8 pips) with no displacement candle
  const c = H(); c[27] = [-6, -1, -7, -2]; c[28] = [-2, 4, -3, 3]; c[29] = [6, 13.8, 4, 10.4];     // range 9.8 = 2 × 4.9
  assertEquals(legs(c).legs[0].qualifies, true);
  const c2 = H(); c2[27] = [-6, -1, -7, -2]; c2[28] = [-2, 4, -3, 3]; c2[29] = [6, 13.7, 4, 10.4];   // 9.7 < 9.8 (5-decimal prices)
  assertEquals(legs(c2).legs[0].qualifies, false);
  void s;
});

clause(["3.4", "3.5", "3.6", "3.7"], "POIs of the scenario leg: FVG [−3,1] and OB [−8,−3]; FVG [3,6] fails depth; identity", () => {
  const { s, legs: L } = legs(H());
  const pois = poisOf(L[0], s);
  assertEquals(pois.map((p) => [p.type, p.low, p.high]).sort(), [["FVG", P(-3), P(1)], ["OB", P(-8), P(-3)]].sort());
  const fvg = pois.find((p) => p.type === "FVG")!;
  assertEquals(fvg.formationTime, s.grid[28] + s.step);
  assertEquals(fvg.id, `EUR/USD|LONG|${s.grid[25]}|${s.grid[29]}|FVG|${s.grid[28] + s.step}|${P(-3)}|${P(1)}`);
  const ob = pois.find((p) => p.type === "OB")!;
  assertEquals(ob.formationTime, s.grid[26] + s.step);
  const m = legs(mir(H()));
  assertEquals(poisOf(m.legs[0], m.s).map((p) => [p.type, p.low, p.high]).sort(), [["FVG", P(-1), P(3)], ["OB", P(3), P(8)]].sort());
});

clause(["3.6"], "fib depth boundary: exactly 0.50 is kept", () => {
  const { s, legs: L } = legs(H());
  const leg: Leg = { ...L[0], legHigh: P(15), legLow: P(-10) };
  // FVG high 1 → depth 14/25; move legHigh so that depth of FVG high (1) is exactly 0.5: legHigh − 1 = 0.5·(legHigh + 10) → legHigh = 12
  const exact = poisOf({ ...leg, legHigh: P(12) }, s).filter((p) => p.type === "FVG" && p.high === P(1));
  assertEquals(exact.length, 1);
  const below = poisOf({ ...leg, legHigh: P(11.9) }, s).filter((p) => p.type === "FVG" && p.high === P(1));
  assertEquals(below.length, 0);
});

clause(["3.5"], "OB: first displacement at o (d = o) → no qualifying bar in [o, d−1] → no OB", () => {
  const { s, legs: L } = legs(H());
  assertEquals(poisOf({ ...L[0], firstDisplacement: 25 }, s).filter((p) => p.type === "OB").length, 0);
});

clause(["3.4", "0.5"], "FVG width boundary: width ≥ 0.10 × ATR14 at c3 (exact), not computable ATR → no FVG", () => {
  const { s, legs: L } = legs(H());
  // ATR at c3=28: sum of TRs 15..28 = 85 pips → 0.1·ATR = 85/140 pips; widen the gap test by scaling: width 4 ≥ 0.607 ✓
  assert(poisOf(L[0], s).some((p) => p.type === "FVG"));
  const g = H(); g[14] = null;                                // ATR at 28 needs 14..28 → not computable
  const r = mkSeries(g, "1h");
  assertEquals(poisOf({ ...L[0] }, r).filter((p) => p.type === "FVG").length, 0);
});
