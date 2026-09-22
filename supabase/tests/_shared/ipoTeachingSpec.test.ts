import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { finalBaseExit, tookPeopleOut, testTeachingSpec } from "../../functions/_shared/ipoTeachingSpec.ts";
import { ONSET_DEFINITIONS } from "../../functions/_shared/ipoDisplacementOnset.ts";
import { PROVENANCE_BY_KEY, provenanceManifest } from "../../functions/_shared/ipoProvenance.ts";
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

Deno.test("the four taught clauses are recorded as DIRECT_TEACHING", () => {
  for (const k of ["origin.lastOppositeBeforeMajorMove", "origin.candleThatTookPeopleOut",
                   "origin.mustBreakStructure", "origin.notInsideConsolidation"]) {
    const r = PROVENANCE_BY_KEY[k];
    assert(r, `${k} missing from the manifest`);
    assertEquals(r.evidenceSource, "DIRECT_TEACHING");
    assertEquals(r.value, null, "a taught clause carries no tuned number");
  }
  assert(provenanceManifest().rules.some((r) => r.key === "origin.lastOppositeBeforeMajorMove"));
});

Deno.test("the taught consolidation clause is recorded as unevaluable, not as satisfied", () => {
  // The teaching states a rule this project retired the predicate for. Recording
  // it as met would be the worst outcome: a clause nobody checks, reading green.
  const r = PROVENANCE_BY_KEY["origin.notInsideConsolidation"];
  assert(r.note.includes("CANNOT CURRENTLY"), "the gap must be stated, not implied");

  const s = series();
  const ev = directionalEvents(s).find((e) => (e.swingIndex ?? 0) > 5)!;
  const sw = ev.swingIndex!;
  const out = testTeachingSpec(s, Math.min(sw + 1, ev.index),
    ev.direction === "bullish" ? "demand" : "supply", sw, ev.index, null);
  assertEquals(out.consolidation.status, "UNRESOLVED");
  assert(out.consolidation.note.includes("UNEVALUATED"));
});

Deno.test("FINAL_BASE_EXIT needs a real base and a close outside it", () => {
  reset();
  const bars: Candle[] = [];
  for (let k = 0; k < 20; k++) bars.push(candle(100, 100.8, 99.2, 100));   // overlapping base
  bars.push(candle(100, 104, 99.9, 103.5));                                // closes above it
  const ctx = { candles: bars, swingIdx: 0, breakIdx: 20, direction: "demand" as const };
  assertEquals(finalBaseExit(ctx), 20, "the exit bar is the first close outside the base");

  // A bar that merely pokes out without closing beyond is not an exit.
  reset();
  const bars2: Candle[] = [];
  for (let k = 0; k < 20; k++) bars2.push(candle(100, 100.8, 99.2, 100));
  bars2.push(candle(100, 104, 99.9, 100.2));                               // wick out, close inside
  assertEquals(finalBaseExit({ ...ctx, candles: bars2, breakIdx: 20 }), null);
});

Deno.test("FINAL_BASE_EXIT is parameter-free apart from the two-bar minimum", () => {
  // No ATR term, no size threshold: a base is defined by overlap. A size rule
  // would reintroduce the fitted number this whole exercise avoids.
  const src = Deno.readTextFileSync("supabase/functions/_shared/ipoTeachingSpec.ts");
  const fn = src.slice(src.indexOf("export function finalBaseExit"),
                       src.indexOf("export interface TookPeopleOutReadings"));
  assert(!/atr/i.test(fn), "finalBaseExit must not reference ATR");
  assert(!/0\.\d/.test(fn), "finalBaseExit must not carry a fractional threshold");
});

Deno.test("the five 'took people out' readings are distinguishable, not synonyms", () => {
  reset();
  const bars: Candle[] = [];
  for (let k = 0; k < 14; k++) bars.push(candle(100, 101, 99, 100));
  // wick below the prior lows, closes back inside: a stop raid
  bars.push(candle(100, 100.5, 96, 99.8));
  const raid = tookPeopleOut(bars, 14, "demand", 15);
  assertEquals(raid.sweepsPriorLocalExtreme, true);
  assertEquals(raid.wicksThroughAndClosesBack, true, "closed back above the swept low");

  // closes BELOW the prior lows: swept, but not a wick-and-reclaim
  reset();
  const bars2: Candle[] = [];
  for (let k = 0; k < 14; k++) bars2.push(candle(100, 101, 99, 100));
  bars2.push(candle(100, 100.5, 96, 96.5));
  const through = tookPeopleOut(bars2, 14, "demand", 15);
  assertEquals(through.sweepsPriorLocalExtreme, true);
  assertEquals(through.wicksThroughAndClosesBack, false,
    "a close beyond the level is not a wick-and-reclaim; conflating them would make the reading useless");
});

Deno.test("'took people out' is measured on the IPO's own side only", () => {
  reset();
  const bars: Candle[] = [];
  for (let k = 0; k < 14; k++) bars.push(candle(100, 101, 99, 100));
  bars.push(candle(100, 105, 99.5, 104));            // takes prior HIGHS
  // For a demand origin the relevant liquidity is below, so this is not a sweep.
  assertEquals(tookPeopleOut(bars, 14, "demand", 15).sweepsPriorLocalExtreme, false);
  assertEquals(tookPeopleOut(bars, 14, "supply", 15).sweepsPriorLocalExtreme, true);
});

Deno.test("the taught rule steps back unconditionally — no colour branch", () => {
  // The specification says "last opposite candle before the major move". The
  // onset-is-origin branch was our invention and must not leak in here.
  const s = series();
  for (const ev of directionalEvents(s).slice(0, 15)) {
    const sw = ev.swingIndex ?? Math.max(0, ev.index - 10);
    const dir = ev.direction === "bullish" ? "demand" as const : "supply" as const;
    const out = testTeachingSpec(s, Math.min(sw + 1, ev.index), dir, sw, ev.index, null);
    for (const tr of out.trials) {
      if (tr.onsetIndex === null || tr.lastOppositeIndex === null) continue;
      assert(tr.lastOppositeIndex < tr.onsetIndex,
        `${tr.onsetKey}: the taught rule takes a candle strictly BEFORE the move`);
    }
  }
});

Deno.test("the frozen onset definitions are reused unchanged", () => {
  const s = series();
  for (const ev of directionalEvents(s).slice(0, 12)) {
    const sw = ev.swingIndex ?? Math.max(0, ev.index - 10);
    const dir = ev.direction === "bullish" ? "demand" as const : "supply" as const;
    const ctx = { candles: s, swingIdx: sw, breakIdx: ev.index, direction: dir };
    const out = testTeachingSpec(s, Math.min(sw + 1, ev.index), dir, sw, ev.index, null);
    for (const d of ONSET_DEFINITIONS) {
      assertEquals(out.trials.find((x) => x.onsetKey === d.key)!.onsetIndex, d.find(ctx));
    }
  }
});

Deno.test("measuring the taught spec leaves the detector untouched", () => {
  const s = series();
  const before = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.map((z) => z.id);
  for (const ev of directionalEvents(s).slice(0, 12)) {
    const sw = ev.swingIndex ?? Math.max(0, ev.index - 10);
    testTeachingSpec(s, Math.min(sw + 1, ev.index),
      ev.direction === "bullish" ? "demand" : "supply", sw, ev.index, null);
  }
  const after = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.map((z) => z.id);
  assertEquals(after, before);
});

Deno.test("a breakIdx past the end of the series returns a reading, not a crash", () => {
  // Found by a fixture with the wrong index. A measurement path that throws
  // takes the whole batch with it, which is worse than one wrong number.
  reset();
  const bars: Candle[] = [];
  for (let k = 0; k < 14; k++) bars.push(candle(100, 101, 99, 100));
  bars.push(candle(100, 100.5, 96, 99.8));
  const r = tookPeopleOut(bars, 14, "demand", 9999);
  assertEquals(r.sweepsPriorLocalExtreme, true);
  assertEquals(r.merelyPrecedesALaterSweep, false);
});
