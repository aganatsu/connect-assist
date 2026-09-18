import { assert, assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectStructuralOrderBlocks,
  findImpulseBase,
  pathEfficiency,
  type StructuralOrderBlock,
} from "../../functions/_shared/structuralOrderBlocks.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";
import type { ImpulseLeg } from "../../functions/_shared/impulseZoneEngine.ts";

/**
 * V2 order blocks — structure-first detection.
 *
 * GEOMETRY: the zone is the PROXIMAL HALF of the base, measured wick to wick.
 *
 *   proximal  the wick extreme price meets first
 *   distal    the 50% of the base's full wick range
 *   extent    the far wick extreme — beyond this the block is invalidated
 *
 * Read off two hand-drawn AUD/USD daily boxes via TradingView's coordinates.
 * Four edges, both directions, every one within 1.4 pips. The 30 March high
 * was PREDICTED from the drawn box at 0.68761 and came back 0.68758 from the
 * raw candle, so the rule was derived rather than fitted.
 *
 * These tests previously asserted a BODY-based rule, inferred from a single
 * zoomed screenshot of one box on one side. That was wrong, and the tests
 * encoding it were replaced rather than adjusted — an assertion pinning a
 * disproved model is worse than no assertion.
 */

let t = 0;
function candle(o: number, h: number, l: number, c: number): Candle {
  const dt = new Date(Date.UTC(2026, 0, 1 + t++)).toISOString().slice(0, 19);
  return { datetime: dt, open: o, high: h, low: l, close: c } as Candle;
}
function reset() { t = 0; }

/** 20 filler bars of range 5, so ATR ≈ 5. Deliberately parked at 90, away from
 *  the 100-handle bases below: a flat candle's body is a POINT, and a point at
 *  100 overlaps a 100–103 base and gets absorbed into it. Correct behaviour —
 *  a flat consolidation is part of a base — but it makes the fixtures lie. */
function filler(n = 20, price = 90): Candle[] {
  return Array.from({ length: n }, () => candle(price, price + 2.5, price - 2.5, price));
}

const leg = (startIndex: number, endIndex: number, direction: "bullish" | "bearish", high: number, low: number): ImpulseLeg =>
  ({ startIndex, endIndex, direction, high, low, isValid: true, bosPrice: high } as ImpulseLeg);

const OPTS = { symbol: "TEST/USD", timeframe: "D" as const };

// ─── geometry ────────────────────────────────────────────────────────────────

Deno.test("the zone is the PROXIMAL HALF of the base, wick to wick", () => {
  reset();
  const candles = [
    ...filler(),
    // base: bodies 100→103, wicks 95→104
    candle(100, 104, 95, 102),
    candle(101, 104, 96, 103),
    // impulse up
    candle(103, 112, 103, 111),
    candle(111, 120, 110, 119),
  ];
  const [ob] = detectStructuralOrderBlocks(candles, [leg(21, 23, "bullish", 120, 95)], OPTS);
  assert(ob, "a block was produced");
  assertEquals(ob.proximal, 104, "proximal = the wick HIGH, the edge price meets first");
  assertEquals(ob.distal, 99.5, "distal = 50% of the 95–104 wick range");
  assertEquals(ob.extent, 95, "extent = the far wick extreme");
});

Deno.test("it uses neither bodies nor the legacy body+50%wick formula", () => {
  // THE DISCRIMINATOR, against both rules this has been through.
  //   legacy obZoneWithWicks:  bodyLow - lowerWick*0.5 = 100 - 2.5 = 97.5
  //   the old V2 body rule:    bodyHigh/bodyLow        = 103 / 100
  //   measured from the chart: wickHigh / 50%          = 104 / 99.5
  reset();
  const candles = [
    ...filler(),
    candle(100, 104, 95, 103),
    candle(103, 112, 103, 111),
    candle(111, 120, 110, 119),
  ];
  const [ob] = detectStructuralOrderBlocks(candles, [leg(20, 22, "bullish", 120, 95)], OPTS);
  assertEquals(ob.proximal, 104);
  assertEquals(ob.distal, 99.5);
  for (const wrong of [97.5, 100, 103]) {
    assert(ob.distal !== wrong && ob.proximal !== wrong,
      `${wrong} belongs to a rule that was disproved`);
  }
});

Deno.test("a bearish base inverts proximal and distal", () => {
  // Price rises INTO supply, so the first edge met is the body LOW.
  reset();
  const candles = [
    ...filler(),
    candle(103, 108, 99, 100),
    candle(100, 107, 88, 89),
    candle(89, 90, 80, 81),
  ];
  const [ob] = detectStructuralOrderBlocks(candles, [leg(20, 22, "bearish", 108, 80)], OPTS);
  assertEquals(ob.proximal, 99, "proximal = the wick LOW — price rises into supply");
  assertEquals(ob.distal, 103.5, "distal = 50% of the 99–108 wick range");
  assertEquals(ob.extent, 108, "extent = the far wick extreme, the wick high");
});

// ─── base detection ──────────────────────────────────────────────────────────

Deno.test("a base can span several candles", () => {
  reset();
  const candles = [
    ...filler(),
    candle(100, 103, 98, 101),
    candle(101, 103, 99, 100),
    candle(100, 104, 98, 102),
    candle(102, 112, 102, 111),
  ];
  const base = findImpulseBase(candles, leg(22, 23, "bullish", 112, 98));
  assert(base, "found a base");
  assertEquals(base!.startIndex, 20);
  assertEquals(base!.endIndex, 22);
  assertEquals(base!.bodyHigh, 102);
  assertEquals(base!.bodyLow, 100);
});

Deno.test("accumulation stops at a body that does not overlap", () => {
  // A gap means a different price area, not the same base.
  reset();
  const candles = [
    ...filler(),
    candle(80, 82, 79, 81),      // far below — must not join
    candle(100, 103, 98, 101),
    candle(101, 112, 101, 111),
  ];
  const base = findImpulseBase(candles, leg(21, 22, "bullish", 112, 98));
  assertEquals(base!.startIndex, 21, "the 80-handle candle is excluded");
  assertEquals(base!.bodyLow, 100);
});

Deno.test("accumulation stops when the base stops being compact", () => {
  reset();
  const candles = [
    ...filler(),                  // ATR ~5
    candle(100, 108, 99, 107),    // joining this would make the body range 7 > 1x ATR
    candle(101, 103, 100, 102),
    candle(102, 112, 102, 111),
  ];
  const base = findImpulseBase(candles, leg(21, 22, "bullish", 112, 99), { maxBaseAtr: 1.0 });
  assertEquals(base!.startIndex, 21, "the wide candle is left out of the base");
});

Deno.test("the base never exceeds maxBaseCandles", () => {
  reset();
  const candles = [...filler(), ...Array.from({ length: 8 }, () => candle(100, 101, 99, 100.5)),
    candle(100.5, 112, 100, 111)];
  const base = findImpulseBase(candles, leg(27, 28, "bullish", 112, 99), { maxBaseCandles: 3 });
  assertEquals(base!.endIndex - base!.startIndex + 1, 3);
});

// ─── invalidation (§12) ──────────────────────────────────────────────────────

Deno.test("a wick through distal that closes back inside is a SWEEP, not invalidation", () => {
  // The whole point of separating sweepLevel from distal.
  reset();
  const candles = [
    ...filler(),
    candle(100, 104, 95, 103),
    candle(103, 112, 103, 111),
    candle(111, 112, 90, 102),   // wick to 90, well below distal 100 — closes back at 102
    candle(102, 106, 101, 105),
  ];
  const [ob] = detectStructuralOrderBlocks(candles, [leg(20, 21, "bullish", 112, 95)], OPTS);
  assert(ob.status !== "INVALIDATED", `swept, not invalidated (got ${ob.status})`);
  assert(ob.touches > 0, "but it does count as a touch");
});

Deno.test("two consecutive closes beyond EXTENT invalidate; one does not", () => {
  // Acceptance is measured against the far wick extreme, not distal. distal is
  // the midpoint, and closing past it is deep mitigation — invalidating there
  // would kill zones roughly twice as fast as the reference charts show.
  reset();
  const base = [
    ...filler(),
    candle(100, 104, 95, 103),
    candle(103, 112, 103, 111),
  ];
  // zone 104 → 99.5, extent 95
  const one = [...base, candle(111, 112, 94, 94.5), candle(94.5, 106, 94, 105)];
  const [obOne] = detectStructuralOrderBlocks(one, [leg(20, 21, "bullish", 112, 95)], OPTS);
  assert(obOne.status !== "INVALIDATED", "a single close back below is not acceptance");

  reset();
  const base2 = [
    ...filler(),
    candle(100, 104, 95, 103),
    candle(103, 112, 103, 111),
  ];
  const two = [...base2, candle(111, 112, 94, 94.5), candle(94.5, 95, 92, 93)];
  const [obTwo] = detectStructuralOrderBlocks(two, [leg(20, 21, "bullish", 112, 95)], OPTS);
  assertEquals(obTwo.status, "INVALIDATED");
  assertEquals(obTwo.invalidationCount, 2);
});

Deno.test("a close back inside resets the invalidation counter", () => {
  reset();
  const candles = [
    ...filler(),
    candle(100, 104, 95, 103),
    candle(103, 112, 103, 111),
    candle(111, 112, 94, 94.5),  // one below extent
    candle(94.5, 106, 94, 105),  // back inside — reset
    candle(105, 106, 94, 94.5),  // one below again
  ];
  const [ob] = detectStructuralOrderBlocks(candles, [leg(20, 21, "bullish", 112, 95)], OPTS);
  assert(ob.status !== "INVALIDATED", "two non-consecutive closes must not invalidate");
});

// ─── mitigation depth (§11) ──────────────────────────────────────────────────

Deno.test("penetration depth is banded, not a boolean", () => {
  reset();
  const candles = [
    ...filler(),
    candle(100, 104, 95, 103),    // zone 104 → 99.5, height 4.5
    candle(103, 112, 103, 111),
    candle(111, 112, 101.6, 110), // dips to 101.6 → 53% of the way in
  ];
  const [ob] = detectStructuralOrderBlocks(candles, [leg(20, 21, "bullish", 112, 95)], OPTS);
  assertAlmostEquals(ob.maxPenetrationPercent, 53.3, 1);
  assertEquals(ob.mitigationBand, "deep");
  assertEquals(ob.status, "MITIGATED");
});

Deno.test("an untouched block that price left behind is ACTIVE, not MITIGATED", () => {
  reset();
  const candles = [
    ...filler(),
    candle(100, 104, 95, 103),
    candle(103, 112, 103, 111),
    candle(111, 120, 110, 119),
  ];
  const [ob] = detectStructuralOrderBlocks(candles, [leg(20, 21, "bullish", 120, 95)], OPTS);
  assertEquals(ob.touches, 0);
  assertEquals(ob.status, "ACTIVE");
  assertEquals(ob.mitigationBand, "none");
});

// ─── §8: a new block must not delete an old one ──────────────────────────────

Deno.test("a newer block makes the older one OLD, never removes it", () => {
  reset();
  const candles = [
    ...filler(),
    candle(100, 104, 95, 103),    // base 1
    candle(103, 112, 103, 111),   // impulse 1
    candle(111, 118, 110, 112),   // base 2
    candle(112, 125, 112, 124),   // impulse 2
    candle(124, 130, 123, 129),
  ];
  const obs = detectStructuralOrderBlocks(candles, [
    leg(20, 21, "bullish", 112, 95),
    leg(22, 23, "bullish", 125, 110),
  ], OPTS);
  assertEquals(obs.length, 2, "both survive — the newer does not delete the older");
  const statuses = obs.map(o => o.status);
  assert(statuses.includes("OLD"), `the earlier one is OLD, got ${statuses.join(",")}`);
});

// ─── identity, scoring, timeframes ───────────────────────────────────────────

Deno.test("ids are deterministic, so a rescan upserts instead of duplicating", () => {
  reset();
  const build = () => {
    reset();
    const candles = [...filler(), candle(100, 104, 95, 103), candle(103, 112, 103, 111)];
    return detectStructuralOrderBlocks(candles, [leg(20, 21, "bullish", 112, 95)], OPTS)[0];
  };
  assertEquals(build().id, build().id);
  assert(build().id.includes("TEST/USD") && build().id.includes("|D|bullish|"));
});

Deno.test("an unmeasurable score factor is absent, never a zero", () => {
  // The failure this repo keeps producing: something unmeasured that reads as a
  // measured zero. A missing EMA series must not look like "trend opposed".
  reset();
  const candles = [...filler(), candle(100, 104, 95, 103), candle(103, 112, 103, 111)];
  const [ob] = detectStructuralOrderBlocks(candles, [leg(20, 21, "bullish", 112, 95)], OPTS);
  assert(ob.scoreUnavailable.includes("trendAlignment"));
  assert(ob.scoreUnavailable.includes("htfAlignment"));
  assert(!("trendAlignment" in ob.scoreBreakdown), "unscored factors are omitted from the breakdown");
  assertEquals(ob.score, Object.values(ob.scoreBreakdown).reduce((a, b) => a + b, 0));
});

Deno.test("Daily and 4H blocks at the same price both survive", () => {
  // §6 of the answers: they carry different structural information and must
  // not be merged across timeframes.
  reset();
  const mk = (tf: "D" | "4H") => {
    reset();
    const candles = [...filler(), candle(100, 104, 95, 103), candle(103, 112, 103, 111)];
    return detectStructuralOrderBlocks(candles, [leg(20, 21, "bullish", 112, 95)], { symbol: "TEST/USD", timeframe: tf })[0];
  };
  const d = mk("D"), h4 = mk("4H");
  assertEquals(d.proximal, h4.proximal);
  assert(d.id !== h4.id, "identical price, different timeframe, different identity");
});

Deno.test("path efficiency separates a clean leg from a choppy one", () => {
  reset();
  const clean = [candle(100, 101, 100, 101), candle(101, 110, 101, 110)];
  reset();
  const choppy = [candle(100, 106, 94, 101), candle(101, 116, 90, 110)];
  assert(pathEfficiency(clean, 0, 1) > pathEfficiency(choppy, 0, 1));
  assert(pathEfficiency(clean, 0, 1) <= 1);
});

Deno.test("nothing here decides a trade", () => {
  // Shadow mode. Displaying V2 output is allowed; acting on it is not.
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/structuralOrderBlocks.ts", import.meta.url));
  for (const forbidden of ["paper_positions", "pending_orders", "_overrideDirection", "takeProfit", "stopLoss"]) {
    assert(!src.includes(forbidden), `${forbidden} must not appear in a shadow-mode detector`);
  }
});

// ─── the reference charts, as regression anchors ─────────────────────────────

/**
 * The two AUD/USD daily boxes the geometry was derived from, using the real
 * candle OHLC and the coordinates read out of TradingView.
 *
 * Synthetic fixtures prove the formula is implemented; these prove it is the
 * RIGHT formula. If someone later "simplifies" the geometry, the synthetic
 * tests can be made to pass by changing their expectations — these cannot,
 * because the numbers came off a chart drawn by hand.
 */
function isolatedBase(c: Candle, dir: "bullish" | "bearish"): { candles: Candle[]; leg: ImpulseLeg } {
  reset();
  // Fillers parked far away so nothing joins the base: a body only merges when
  // it overlaps the accumulating range.
  const pad = Array.from({ length: 20 }, () => candle(0.5, 0.5025, 0.4975, 0.5));
  const after = dir === "bullish"
    ? [candle(c.close, c.close + 0.01, c.close, c.close + 0.009),
       candle(c.close + 0.009, c.close + 0.02, c.close + 0.008, c.close + 0.019)]
    : [candle(c.close, c.close, c.close - 0.01, c.close - 0.009),
       candle(c.close - 0.009, c.close - 0.008, c.close - 0.02, c.close - 0.019)];
  const candles = [...pad, c, ...after];
  return { candles, leg: leg(20, 22, dir, c.high, c.low) };
}

Deno.test("AUD/USD 30 Mar demand reproduces the drawn box", () => {
  // Raw candle from the provider. Box read from TradingView: 0.68549 → 0.68761.
  const bar = candle(0.68705, 0.68758, 0.68347, 0.68488);
  const { candles, leg: l } = isolatedBase(bar, "bullish");
  const [ob] = detectStructuralOrderBlocks(candles, [l], OPTS);
  assert(ob, "a block was produced");
  assertAlmostEquals(ob.proximal, 0.68758, 1e-9, "proximal = the candle high");
  assertAlmostEquals(ob.distal, 0.685525, 1e-9, "distal = 50% of 0.68347–0.68758");
  // Against the hand-drawn box, in pips.
  assert(Math.abs(ob.proximal - 0.68761) * 10000 < 1.5, "proximal within 1.5 pips of the box top");
  assert(Math.abs(ob.distal - 0.68549) * 10000 < 1.5, "distal within 1.5 pips of the box bottom");
});

Deno.test("AUD/USD 19 Mar supply reproduces the drawn box", () => {
  // Box read from TradingView: 0.70002 → 0.70534.
  const bar = candle(0.70360, 0.71089, 0.70007, 0.70832);
  const { candles, leg: l } = isolatedBase(bar, "bearish");
  const [ob] = detectStructuralOrderBlocks(candles, [l], OPTS);
  assert(ob, "a block was produced");
  assertAlmostEquals(ob.proximal, 0.70007, 1e-9, "proximal = the candle low — price rises into supply");
  assertAlmostEquals(ob.distal, 0.70548, 1e-9, "distal = 50% of 0.70007–0.71089");
  assert(Math.abs(ob.proximal - 0.70002) * 10000 < 1.5, "proximal within 1.5 pips of the box bottom");
  assert(Math.abs(ob.distal - 0.70534) * 10000 < 1.5, "distal within 1.5 pips of the box top");
});

Deno.test("the body rule would miss both boxes", () => {
  // What the previous implementation produced, for the record. Both were close
  // enough to look plausible on a chart and neither was the rule.
  const demand = candle(0.68705, 0.68758, 0.68347, 0.68488);
  assert(Math.abs(0.68705 - 0.68761) * 10000 > 5, "body high is >5 pips from the box top");
  const supply = candle(0.70360, 0.71089, 0.70007, 0.70832);
  assert(Math.abs(0.70360 - 0.70002) * 10000 > 30, "body low is >30 pips from the box bottom");
  assert(demand.high !== demand.close && supply.low !== supply.open, "fixtures are the real bars");
});

Deno.test("the documentation describes the rule the code implements", () => {
  // The body-rule doc block survived a geometry rewrite once: a script hit an
  // assertion before writing the file, so the code changed and the comment
  // above it did not. It then described a disproved model for two merges.
  //
  // Cheap to assert, and the failure mode is someone reading the comment and
  // "correcting" the code back.
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/structuralOrderBlocks.ts", import.meta.url));
  const header = src.slice(0, src.indexOf("import "));
  assert(!/sweepLevel/.test(header), "sweepLevel no longer exists");
  assert(!/BASE BODIES|Zone boundaries are the/.test(header), "the body rule is gone");
  assert(/PROXIMAL HALF/.test(header), "the header states the actual rule");
  assert(/MEASURED vs MODELLED/.test(header),
    "and keeps the geometry measurement apart from the lifecycle model");
  // The code it describes.
  assert(/distal: \(base\.wickHigh \+ base\.wickLow\) \/ 2/.test(src));
  assert(/c\.close < ob\.extent : c\.close > ob\.extent/.test(src));
});
