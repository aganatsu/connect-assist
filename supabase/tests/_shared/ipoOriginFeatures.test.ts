import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  candidateFeatures,
  legCandidateSet,
  summariseFeatures,
  BOOLEAN_FEATURES,
  NUMERIC_FEATURES,
} from "../../functions/_shared/ipoOriginFeatures.ts";
import { directionalEvents } from "../../functions/_shared/ipoOriginExperiments.ts";
import { detectIPOCandidates } from "../../functions/_shared/ipoZones.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

let t = 0;
function candle(o: number, h: number, l: number, c: number): Candle {
  const dt = new Date(Date.UTC(2026, 0, 1 + t++)).toISOString().slice(0, 19);
  return { datetime: dt, open: o, high: h, low: l, close: c } as Candle;
}
const reset = () => { t = 0; };

function series(): Candle[] {
  reset();
  const out: Candle[] = [];
  let p = 100;
  for (let cycle = 0; cycle < 14; cycle++) {
    for (let k = 0; k < 6; k++) { const o = p; p -= 0.9; out.push(candle(o, o + 0.25, p - 0.25, p)); }
    out.push(candle(p, p + 0.2, p - 1.1, p - 0.9)); p -= 0.9;
    for (let k = 0; k < 8; k++) { const o = p; p += 1.1; out.push(candle(o, p + 0.3, o - 0.3, p)); }
    out.push(candle(p, p + 1.0, p - 0.2, p + 0.8)); p += 0.8;
  }
  return out;
}

Deno.test("a competitor is every IPO-coloured bar in the leg, and only those", () => {
  // The comparison only controls for the leg if the candidate set IS the leg.
  const s = series();
  const evs = directionalEvents(s);
  const ev = evs.find((e) => e.direction === "bullish" && (e.swingIndex ?? 0) > 5);
  if (!ev) return;
  const swing = ev.swingIndex!;
  const demo = swing + 1;
  const set = legCandidateSet(s, demo, "demand", evs, null);
  if (!set) return;

  for (const c of set.candidates) {
    assert(c.index >= set.swingIndex && c.index <= set.breakIndex, "inside the leg");
    assertEquals(c.colour, "down", "demand IPOs are down candles; up bars are not candidates");
  }
  // Nothing in the leg of the right colour may be missing.
  let expected = 0;
  for (let i = set.swingIndex; i <= set.breakIndex; i++) {
    if (s[i] && s[i].close < s[i].open) expected++;
  }
  assertEquals(set.candidates.length, expected);
});

Deno.test("exactly one candidate is flagged demonstrated", () => {
  const s = series();
  const evs = directionalEvents(s);
  const ev = evs.find((e) => e.direction === "bearish" && (e.swingIndex ?? 0) > 5);
  if (!ev) return;
  // Pick a real up-candle inside the leg so the flag can land.
  let demo = -1;
  for (let i = ev.swingIndex!; i <= ev.index; i++) if (s[i].close >= s[i].open) { demo = i; break; }
  if (demo < 0) return;
  const set = legCandidateSet(s, demo, "supply", evs, null);
  if (!set) return;
  assertEquals(set.candidates.filter((c) => c.isDemonstrated).length, 1);
  assertEquals(set.candidates.find((c) => c.isDemonstrated)!.index, demo);
});

Deno.test("run position is computed against the candle's own colour run", () => {
  reset();
  const bars = [
    candle(100, 101, 99, 100.5),   // 0 up
    candle(100.5, 101, 99, 99.5),  // 1 down  <- first of run
    candle(99.5, 100, 98, 98.5),   // 2 down  <- middle
    candle(98.5, 99, 97, 97.5),    // 3 down  <- last
    candle(97.5, 101, 97, 100.5),  // 4 up
  ];
  const ctx = { swingIdx: 0, breakIdx: 4, extremeIdx: 3, demonstratedIdx: 3, productionIdx: null };
  assertEquals(candidateFeatures(bars, 1, "demand", ctx).positionInRun, "first");
  assertEquals(candidateFeatures(bars, 2, "demand", ctx).positionInRun, "middle");
  assertEquals(candidateFeatures(bars, 3, "demand", ctx).positionInRun, "last");
  assertEquals(candidateFeatures(bars, 1, "demand", ctx).runLength, 3);
});

Deno.test("a sweep is measured on the IPO's own side, not either side", () => {
  // A demand IPO forms at a low, so what matters is taking prior LOWS. Counting
  // a high sweep for a demand candidate would make the feature meaningless.
  reset();
  const bars: Candle[] = [];
  for (let k = 0; k < 14; k++) bars.push(candle(100, 101, 99, 100.5));
  bars.push(candle(100, 100.5, 96, 97));      // 14: takes prior lows, closes below
  bars.push(candle(97, 103, 96.9, 102.5));    // 15: up
  const ctx = { swingIdx: 0, breakIdx: 15, extremeIdx: 14, demonstratedIdx: 14, productionIdx: null };
  const f = candidateFeatures(bars, 14, "demand", ctx);
  assertEquals(f.sweptPriorLocalExtreme, true);
  assertEquals(f.sweepWickOnly, false, "it closed beyond the prior low, so not wick-only");

  // The same bar judged as a SUPPLY candidate swept nothing: it took no highs.
  const g = candidateFeatures(bars, 14, "supply", { ...ctx, demonstratedIdx: -1 });
  assertEquals(g.sweptPriorLocalExtreme, false);
});

Deno.test("displacement is measured from the candle's own anchor, in its own direction", () => {
  reset();
  const bars: Candle[] = [];
  for (let k = 0; k < 20; k++) bars.push(candle(100, 100.6, 99.4, 100));
  bars.push(candle(100, 100.2, 98, 98.5));    // 20: the low anchor
  bars.push(candle(98.5, 104, 98.4, 103.5));  // 21: rallies
  const ctx = { swingIdx: 0, breakIdx: 21, extremeIdx: 20, demonstratedIdx: 20, productionIdx: null };
  const f = candidateFeatures(bars, 20, "demand", ctx);
  assert(f.displacementAtr > 0, "a demand candle measures the rally above its LOW");
  // Efficiency can exceed 1: the anchor is the candle's own low, which sits
  // below the following bars' ranges, so net travel can beat their summed
  // range. Left unclamped — clamping would hide that the move began below the
  // window being summed.
  assert(f.pathEfficiency > 0, "efficiency is positive for a favourable move");
  assertEquals(f.barsToBreak, 1);
});

Deno.test("the summary reports counts and never a combined score", () => {
  const s = series();
  const evs = directionalEvents(s);
  const zones = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.slice(0, 4);
  const sets = zones
    .map((z) => legCandidateSet(s, z.candleIndex, z.direction, evs, z.candleIndex))
    .filter(Boolean) as any[];
  if (!sets.length) return;

  const sum = summariseFeatures(sets);
  assertEquals(sum.legs, sets.length);
  assertEquals(sum.demonstratedCandles, sets.length);
  assert(sum.competitorCandles >= 0);
  assert(sum.note.includes("Nothing is combined into a score"));

  // Key names only — the prose note legitimately contains the word "weighted"
  // while explaining why no weighting is applied.
  const keys = JSON.stringify(sum).toLowerCase().match(/"[a-z0-9_]+":/g) ?? [];
  for (const banned of ["score", "weight", "confidence", "probability"]) {
    assert(!keys.some((k) => k.includes(banned)), `the summary must expose no ${banned} field`);
  }
  // Every declared feature appears exactly once.
  assertEquals(sum.booleans.length, BOOLEAN_FEATURES.length);
  assertEquals(sum.numerics.length, NUMERIC_FEATURES.length);
  assertEquals(new Set(sum.booleans.map((b: any) => b.feature)).size, BOOLEAN_FEATURES.length);
});

Deno.test("a feature true for everything reports zero lift rather than looking useful", () => {
  // mitigatedBeforeBreak came back 100% for demonstrated AND competitors. A
  // summary that hid that would present a constant as a discriminator.
  const s = series();
  const evs = directionalEvents(s);
  const zones = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.slice(0, 5);
  const sets = zones
    .map((z) => legCandidateSet(s, z.candleIndex, z.direction, evs, z.candleIndex))
    .filter(Boolean) as any[];
  if (!sets.length) return;
  const sum = summariseFeatures(sets);
  for (const b of sum.booleans) {
    if (b.demonstratedPct === 100 && b.competitorsPct === 100) {
      assertEquals(b.lift, 0, "a constant feature must show no lift");
    }
  }
});

Deno.test("feature extraction leaves the detector untouched", () => {
  const s = series();
  const before = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.map((z) => z.id);
  const evs = directionalEvents(s);
  for (let i = 40; i < 80; i++) legCandidateSet(s, i, i % 2 ? "demand" : "supply", evs, null);
  const after = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.map((z) => z.id);
  assertEquals(after, before);
});
