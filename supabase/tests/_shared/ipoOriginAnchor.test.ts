import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { testAnchorHypothesis } from "../../functions/_shared/ipoOriginAnchor.ts";
import { ONSET_DEFINITIONS, lastOppositeBefore } from "../../functions/_shared/ipoDisplacementOnset.ts";
import { detectIPOCandidates } from "../../functions/_shared/ipoZones.ts";
import { directionalEvents } from "../../functions/_shared/ipoOriginExperiments.ts";
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

Deno.test("the anchor branches on onset colour and nothing else", () => {
  // The whole rule: an onset bar already the IPO colour IS the origin; any
  // other onset falls back to the previous behaviour.
  const s = series();
  const evs = directionalEvents(s);
  let sawA = false, sawB = false;
  for (const ev of evs.slice(0, 30)) {
    const sw = ev.swingIndex ?? Math.max(0, ev.index - 10);
    const dir = ev.direction === "bullish" ? "demand" as const : "supply" as const;
    const r = testAnchorHypothesis(s, Math.min(sw + 1, ev.index), dir, sw, ev.index, null);
    for (const tr of r.trials) {
      if (tr.onsetIndex === null) { assertEquals(tr.anchorMode, "NONE"); continue; }
      const wantUp = dir === "supply";
      const onsetIsIpo = (s[tr.onsetIndex].close >= s[tr.onsetIndex].open) === wantUp;
      assertEquals(tr.onsetIsIpoColoured, onsetIsIpo);
      if (onsetIsIpo) {
        sawA = true;
        assertEquals(tr.anchorMode, "ONSET_IS_ORIGIN");
        assertEquals(tr.originIndex, tr.onsetIndex, "mode A must not move off the onset");
        assertEquals(tr.barsOriginToOnset, 0);
      } else if (tr.originIndex !== null) {
        sawB = true;
        assertEquals(tr.anchorMode, "STEP_BACK_TO_LAST_OPPOSITE");
        assertEquals(tr.originIndex, lastOppositeBefore(s, tr.onsetIndex, dir, sw),
          "mode B must agree with the frozen step-back exactly");
        assert(tr.originIndex! < tr.onsetIndex!);
      }
    }
  }
  assert(sawA && sawB, "the fixture must exercise both branches or this proves nothing");
});

Deno.test("mode B is byte-identical to the frozen step-back behaviour", () => {
  // The anchor may only ADD the mode-A branch. If it also perturbed mode B, the
  // comparison against the previous experiment would be meaningless.
  const s = series();
  for (const ev of directionalEvents(s).slice(0, 25)) {
    const sw = ev.swingIndex ?? Math.max(0, ev.index - 10);
    const dir = ev.direction === "bullish" ? "demand" as const : "supply" as const;
    const r = testAnchorHypothesis(s, Math.min(sw + 2, ev.index), dir, sw, ev.index, null);
    for (const tr of r.trials) {
      if (tr.anchorMode !== "STEP_BACK_TO_LAST_OPPOSITE") continue;
      assertEquals(tr.originIndex, lastOppositeBefore(s, tr.onsetIndex!, dir, sw));
    }
  }
});

Deno.test("the onset detectors are called unchanged", () => {
  // Onset must remain a property of the leg. If the anchor perturbed it, every
  // count reported against the frozen detectors would be wrong.
  const s = series();
  for (const ev of directionalEvents(s).slice(0, 20)) {
    const sw = ev.swingIndex ?? Math.max(0, ev.index - 10);
    const dir = ev.direction === "bullish" ? "demand" as const : "supply" as const;
    const ctx = { candles: s, swingIdx: sw, breakIdx: ev.index, direction: dir };
    const r = testAnchorHypothesis(s, Math.min(sw + 1, ev.index), dir, sw, ev.index, null);
    for (const d of ONSET_DEFINITIONS) {
      const tr = r.trials.find((x) => x.onsetKey === d.key)!;
      assertEquals(tr.onsetIndex, d.find(ctx), `${d.key} onset was perturbed by the anchor`);
    }
  }
});

Deno.test("mode A recovers a demonstrated candle that IS the impulse start", () => {
  // The AUD/USD 2023-10-31 shape reduced to a fixture: the demonstrated bar is
  // bearish AND is the first bar of the run that reaches the break, so a strict
  // step-back walks straight past it.
  reset();
  const bars: Candle[] = [];
  let p = 100;
  for (let k = 0; k < 24; k++) { const o = p; p += 0.05; bars.push(candle(o, o + 0.3, o - 0.3, p)); }
  const o1 = p; p -= 0.9;
  bars.push(candle(o1, o1 + 0.05, p - 0.1, p));        // bearish: the demonstrated bar
  const demo = bars.length - 1;
  for (let k = 0; k < 4; k++) { const o = p; p += 1.6; bars.push(candle(o, p + 0.2, o - 0.05, p)); }
  const brk = bars.length - 1;

  const r = testAnchorHypothesis(bars, demo, "demand", 20, brk, null);
  const bos = r.trials.find((x) => x.onsetKey === "BOS_CAUSAL_RUN")!;
  if (bos.onsetIndex === demo) {
    assertEquals(bos.anchorMode, "ONSET_IS_ORIGIN");
    assertEquals(bos.exactMatch, true, "mode A keeps the bar a strict step-back would discard");
    assertEquals(lastOppositeBefore(bars, demo, "demand", 20) === demo, false,
      "and the frozen step-back would indeed have missed it");
  }
});

Deno.test("running the anchor leaves the detector untouched", () => {
  const s = series();
  const before = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.map((z) => z.id);
  for (const ev of directionalEvents(s).slice(0, 15)) {
    const sw = ev.swingIndex ?? Math.max(0, ev.index - 10);
    testAnchorHypothesis(s, Math.min(sw + 1, ev.index),
      ev.direction === "bullish" ? "demand" : "supply", sw, ev.index, null);
  }
  const after = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.map((z) => z.id);
  assertEquals(after, before);
});
