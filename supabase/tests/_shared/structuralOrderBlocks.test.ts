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
 * The rule under test that matters most is the GEOMETRY. Measured against a
 * zoomed AUD/USD daily chart: the drawn box stopped at the base bodies while
 * the wicks ran ~40% further, and that wick extreme was marked separately.
 * The legacy detector uses body + 50% of each wick, which sits about a third
 * deeper. If this file ever stops failing on that difference, the two
 * detectors have silently converged again.
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

Deno.test("the zone is the base BODIES; wicks are excluded", () => {
  reset();
  const candles = [
    ...filler(),
    // base: bodies 100→103, wicks down to 95
    candle(100, 104, 95, 102),
    candle(101, 104, 96, 103),
    // impulse up
    candle(103, 112, 103, 111),
    candle(111, 120, 110, 119),
  ];
  const [ob] = detectStructuralOrderBlocks(candles, [leg(21, 23, "bullish", 120, 95)], OPTS);
  assert(ob, "a block was produced");
  assertEquals(ob.proximal, 103, "proximal = highest body in the base");
  assertEquals(ob.distal, 100, "distal = lowest body — NOT the 95 wick");
  assertEquals(ob.sweepLevel, 95, "the wick extreme is recorded separately");
});

Deno.test("it does NOT use the legacy body + 50% wick formula", () => {
  // THE DISCRIMINATOR. smcAnalysis obZoneWithWicks() would put the low at
  // bodyLow - lowerWick*0.5 = 100 - 2.5 = 97.5. The charts say 100.
  reset();
  const candles = [
    ...filler(),
    candle(100, 104, 95, 103),
    candle(103, 112, 103, 111),
    candle(111, 120, 110, 119),
  ];
  const [ob] = detectStructuralOrderBlocks(candles, [leg(20, 22, "bullish", 120, 95)], OPTS);
  assertEquals(ob.distal, 100);
  assert(ob.distal !== 97.5, "body+50%wick would be 97.5 — that is the legacy rule");
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
  assertEquals(ob.proximal, 100, "proximal = lowest body");
  assertEquals(ob.distal, 103, "distal = highest body");
  assertEquals(ob.sweepLevel, 108, "sweep marker is the wick high");
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

Deno.test("two consecutive closes beyond distal invalidate; one does not", () => {
  reset();
  const base = [
    ...filler(),
    candle(100, 104, 95, 103),
    candle(103, 112, 103, 111),
  ];
  const one = [...base, candle(111, 112, 98, 99), candle(99, 106, 99, 105)];
  const [obOne] = detectStructuralOrderBlocks(one, [leg(20, 21, "bullish", 112, 95)], OPTS);
  assert(obOne.status !== "INVALIDATED", "a single close back below is not acceptance");

  reset();
  const base2 = [
    ...filler(),
    candle(100, 104, 95, 103),
    candle(103, 112, 103, 111),
  ];
  const two = [...base2, candle(111, 112, 98, 99), candle(99, 99.5, 96, 97)];
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
    candle(111, 112, 98, 99),    // one below
    candle(99, 106, 99, 105),    // back inside — reset
    candle(105, 106, 98, 99),    // one below again
  ];
  const [ob] = detectStructuralOrderBlocks(candles, [leg(20, 21, "bullish", 112, 95)], OPTS);
  assert(ob.status !== "INVALIDATED", "two non-consecutive closes must not invalidate");
});

// ─── mitigation depth (§11) ──────────────────────────────────────────────────

Deno.test("penetration depth is banded, not a boolean", () => {
  reset();
  const candles = [
    ...filler(),
    candle(100, 104, 95, 103),   // zone 100..103, height 3
    candle(103, 112, 103, 111),
    candle(111, 112, 101.4, 110), // dips to 101.4 → 53% of the way down
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
