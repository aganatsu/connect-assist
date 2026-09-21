import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CONTRACTION_DEFINITIONS,
  findContractions,
  measureContraction,
  positionOfIPO,
  revisitOfIPO,
  baseConstructIsDegenerate,
  CONTRACTION_FAMILIES,
  EXCLUDED_FROM_FAMILIES,
} from "../../functions/_shared/ipoContraction.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  datetime: `2020-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
  open: o, high: h, low: l, close: c, volume: 1,
} as Candle);

/**
 * Three wide trending bars, six tight ones, then three wide again.
 *
 * The trending bars deliberately GAP away from the quiet stretch. An earlier
 * fixture let them overlap it, which made even OVERLAP_CLUSTER swallow the whole
 * series — a property of the fixture, not of the definitions, and it masked what
 * the test was meant to check.
 */
const SERIES: Candle[] = [
  bar(0, 100, 130, 95, 128),
  bar(1, 128, 160, 125, 158),
  bar(2, 158, 175, 155, 173),
  bar(3, 182, 192, 180, 185),
  bar(4, 185, 190, 182, 187),
  bar(5, 187, 191, 183, 184),
  bar(6, 184, 189, 181, 188),
  bar(7, 188, 192, 184, 186),
  bar(8, 186, 190, 182, 189),
  bar(9, 196, 230, 195, 228),
  bar(10, 228, 270, 225, 268),
  bar(11, 268, 310, 265, 308),
];

Deno.test("the definitions are parameter-free and each locates the quiet middle", () => {
  // Not asserting identical windows — they are different readings on purpose.
  // What must hold is that each one finds SOMETHING inside bars 3..8 and does
  // not simply return the whole series.
  for (const d of CONTRACTION_DEFINITIONS) {
    const ws = d.find(SERIES, 0, SERIES.length - 1);
    assert(ws.length > 0, `${d.key} found nothing`);
    // Overlap, not containment: CONTAINED_BY_OPENING_PAIR legitimately opens on
    // bar 2, because bars 2 and 3 together form the box the quiet run sits in.
    // Demanding an exact 3..8 window would encode one definition's edge case as
    // the spec for all three.
    const coversQuiet = ws.some(([a, b]) => Math.min(b, 8) - Math.max(a, 3) + 1 >= 4);
    const swallowsAll = ws.some(([a, b]) => a === 0 && b === SERIES.length - 1);
    assert(coversQuiet, `${d.key} missed the quiet stretch`);
    assert(!swallowsAll, `${d.key} returned the entire series`);
  }
});

Deno.test("a quiet stretch measures as low efficiency, a trend as high", () => {
  const quiet = measureContraction(SERIES, 3, 8);
  const trend = measureContraction(SERIES, 9, 11);
  assert(quiet.directionalEfficiency! < trend.directionalEfficiency!,
    `quiet ${quiet.directionalEfficiency} should be below trend ${trend.directionalEfficiency}`);
  assertEquals(quiet.overlapFraction, 1, "every bar of the quiet stretch overlaps its neighbour");
});

Deno.test("measurements are numbers, never verdicts", () => {
  const m = measureContraction(SERIES, 3, 8);
  for (const [k, v] of Object.entries(m)) {
    assert(v === null || typeof v === "number", `${k} must be numeric or null, got ${typeof v}`);
  }
});

Deno.test("IPO position is reported relative to a window, every case distinct", () => {
  const w = { definition: "OVERLAP_CLUSTER" as const, start: 3, end: 8,
    startDatetime: "", endDatetime: "", bars: 6, high: 192, low: 180 };
  assertEquals(positionOfIPO(2, w), "BEFORE_CONTRACTION");
  assertEquals(positionOfIPO(3, w), "AT_START_BOUNDARY");
  assertEquals(positionOfIPO(5, w), "INSIDE_CONTRACTION");
  assertEquals(positionOfIPO(8, w), "AT_END_BOUNDARY");
  assertEquals(positionOfIPO(9, w), "IMMEDIATELY_AFTER");
  assertEquals(positionOfIPO(11, w), "AFTER_CONTRACTION");
});

Deno.test("revisit reports absence as absence, not as a weak yes", () => {
  // Bars 9-11 run straight up and away, so a demand zone on bar 3 is never retested.
  const away = revisitOfIPO(SERIES, 3, "demand", 8, 11);
  assertEquals(away.revisited, false);
  assertEquals(away.firstRevisitIndex, null);
  assertEquals(away.barsAfterContraction, null);
});

Deno.test("findContractions reports which definition produced each window", () => {
  const ws = findContractions(SERIES, 0, SERIES.length - 1);
  assert(ws.length > 0);
  const keys = new Set(ws.map((w) => w.definition));
  for (const k of keys) {
    assert(CONTRACTION_DEFINITIONS.some((d) => d.key === k), `unknown definition ${k}`);
  }
  // No window may be silently merged across definitions.
  for (const w of ws) assert(w.end >= w.start && w.bars === w.end - w.start + 1);
});

Deno.test("OVERLAP_CLUSTER degenerates when every bar overlaps — pinned, not hidden", () => {
  // Real BTC daily/4h data has ~100% adjacent-bar overlap, so this definition
  // returns one window covering everything and discriminates nothing. The same
  // construct backs finalBaseExit and permanentBaseExit, so the degeneracy is
  // pinned here rather than left to be rediscovered.
  const allOverlap: Candle[] = Array.from({ length: 20 }, (_, i) =>
    bar(i, 100 + i, 120 + i, 80 + i, 110 + i));
  const ws = CONTRACTION_DEFINITIONS.find((d) => d.key === "OVERLAP_CLUSTER")!
    .find(allOverlap, 0, allOverlap.length - 1);
  assertEquals(ws.length, 1);
  assertEquals(ws[0], [0, allOverlap.length - 1], "one window swallowing the whole span");
});

Deno.test("the adjacent-overlap base construct is flagged degenerate when it cannot separate", () => {
  const allOverlap: Candle[] = Array.from({ length: 20 }, (_, i) =>
    bar(i, 100 + i, 120 + i, 80 + i, 110 + i));
  const d = baseConstructIsDegenerate(allOverlap, 0, allOverlap.length - 1);
  assertEquals(d.degenerate, true);
  assertEquals(d.adjacentOverlapFraction, 1);
  assert(d.note.includes("DEGENERATE_FOR_RESEARCH"));
  assert(d.note.includes("LAST_OPPOSITE_BEFORE_BREAK"),
    "the note must name the rule it collapses into, or the flag is not actionable");
});

Deno.test("degeneracy is a property of the series, not a blanket verdict", () => {
  // SERIES gaps twice, so the construct still separates clusters there.
  const d = baseConstructIsDegenerate(SERIES, 0, SERIES.length - 1);
  assertEquals(d.degenerate, false);
  assert((d.adjacentOverlapFraction ?? 1) < 1);
});

Deno.test("equalLevelDensity is normalised; the raw counts are not comparable across lengths", () => {
  // The defect this fixes: the same behaviour scored 8 on a 10-bar box and 37
  // on a 62-bar box purely because of length.
  const quiet = measureContraction(SERIES, 3, 8);
  assert(quiet.equalLevelDensity !== null);
  assertEquals(
    quiet.equalLevelDensity,
    (quiet.equalHighs + quiet.equalLows) / 6,
    "density must be the raw sum divided by bar count",
  );
  assert(quiet.equalLevelDensity! <= 2, "density is per bar, so it cannot exceed 2");
});

Deno.test("the family list is frozen, and rejected measures stay rejected", () => {
  assertEquals(CONTRACTION_FAMILIES.length, 3);
  assertEquals(CONTRACTION_FAMILIES.map((f) => f.key).sort(),
    ["BODY_COMPRESSION", "LEVEL_REPETITION", "VOLATILITY_COMPRESSION"]);
  // Level repetition must be defined on the NORMALISED measure, never the raw count.
  const lr = CONTRACTION_FAMILIES.find((f) => f.key === "LEVEL_REPETITION")!;
  assertEquals(lr.measure, "equalLevelDensity");
  // Nothing rejected may reappear as a family.
  const fam = new Set(CONTRACTION_FAMILIES.map((f) => f.measure as string));
  for (const x of EXCLUDED_FROM_FAMILIES) {
    assert(!fam.has(x.measure), `${x.measure} was rejected and must not be a family`);
    assert(x.why.length > 20, `${x.measure} must record WHY it was rejected`);
  }
});

Deno.test("no family carries a fitted threshold", () => {
  for (const f of CONTRACTION_FAMILIES) {
    assert(!("threshold" in f), `${f.key} must not carry a threshold`);
    assert(f.direction === "LOWER_INSIDE_CONTRACTION" || f.direction === "HIGHER_INSIDE_CONTRACTION");
    assert(f.observedRange[0] < f.observedRange[1]);
  }
});
