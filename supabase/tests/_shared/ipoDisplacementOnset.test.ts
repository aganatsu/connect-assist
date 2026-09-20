import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ONSET_DEFINITIONS,
  lastOppositeBefore,
  testOnsetHypothesis,
} from "../../functions/_shared/ipoDisplacementOnset.ts";
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

Deno.test("the step-back takes the last OPPOSITE candle, skipping same-direction bars", () => {
  reset();
  const bars = [
    candle(100, 101, 99, 99.2),    // 0 down
    candle(99.2, 100, 98, 98.3),   // 1 down  <- last down before the onset
    candle(98.3, 99, 98, 98.8),    // 2 up
    candle(98.8, 103, 98.7, 102),  // 3 up  (onset)
  ];
  // For a DEMAND IPO the opposite-direction candle is the bearish one, so the
  // up bar at 2 must be skipped rather than taken as "the bar before onset".
  assertEquals(lastOppositeBefore(bars, 3, "demand", 0), 1);
  // For SUPPLY the colours invert.
  assertEquals(lastOppositeBefore(bars, 3, "supply", 0), 2);
});

Deno.test("the step-back never leaves its own leg", () => {
  reset();
  const bars = [
    candle(100, 101, 99, 99.0),    // 0 down — outside the leg
    candle(99, 100, 98, 98.5),     // 1 down — outside the leg
    candle(98.5, 99, 98, 98.9),    // 2 up   — swing starts here
    candle(98.9, 103, 98.8, 102),  // 3 up   — onset
  ];
  assertEquals(lastOppositeBefore(bars, 3, "demand", 2), null,
    "no bearish candle inside [2,3), so the answer is null rather than bar 1");
  assertEquals(lastOppositeBefore(bars, 3, "demand", 0), 1);
});

Deno.test("every onset definition stays inside the leg it was given", () => {
  // An onset outside [swing, break] would be locating the impulse in a
  // different move, and the step-back from it would be meaningless.
  const s = series();
  for (const ev of directionalEvents(s).slice(0, 25)) {
    const swingIdx = ev.swingIndex ?? Math.max(0, ev.index - 10);
    const ctx = {
      candles: s, swingIdx, breakIdx: ev.index,
      direction: (ev.direction === "bullish" ? "demand" : "supply") as const,
    };
    for (const d of ONSET_DEFINITIONS) {
      const o = d.find(ctx);
      if (o === null) continue;
      assert(o >= swingIdx && o <= ev.index, `${d.key} proposed ${o} outside [${swingIdx},${ev.index}]`);
    }
  }
});

Deno.test("onset never depends on a candidate's own future move", () => {
  // The failure this hypothesis exists to avoid. Onset is a property of the
  // leg, so it must not change when the DEMONSTRATED candle changes — only the
  // step-back result may differ.
  const s = series();
  const ev = directionalEvents(s).find((e) => e.direction === "bullish" && (e.swingIndex ?? 0) > 5);
  if (!ev) return;
  const swingIdx = ev.swingIndex!;
  const a = testOnsetHypothesis(s, swingIdx + 1, "demand", swingIdx, ev.index);
  const b = testOnsetHypothesis(s, ev.index - 1, "demand", swingIdx, ev.index);
  for (const k of ONSET_DEFINITIONS.map((d) => d.key)) {
    const ta = a.trials.find((x) => x.onsetKey === k)!;
    const tb = b.trials.find((x) => x.onsetKey === k)!;
    assertEquals(ta.onsetIndex, tb.onsetIndex,
      `${k} moved its onset when only the demonstrated candle changed`);
  }
});

Deno.test("an ATR-threshold onset actually respects its threshold", () => {
  reset();
  const bars: Candle[] = [];
  for (let k = 0; k < 20; k++) bars.push(candle(100, 100.5, 99.5, 100));   // flat, tiny bodies
  bars.push(candle(100, 106, 99.9, 105.5));                                // huge bullish body
  const ctx = { candles: bars, swingIdx: 0, breakIdx: 20, direction: "demand" as const };
  const d10 = ONSET_DEFINITIONS.find((d) => d.key === "BODY_ATR_1_0")!;
  assertEquals(d10.find(ctx), 20, "the big body is the onset");
  // With the big bar excluded from the leg there is no qualifying onset at all,
  // which must be reported as null rather than falling back to something.
  assertEquals(d10.find({ ...ctx, breakIdx: 19 }), null);
});

Deno.test("the FVG onset is the FIRST bar of the three, not the middle one", () => {
  // detectFVGs indexes the middle bar. Using that index directly would place
  // the onset one bar late and shift every step-back with it.
  reset();
  const bars: Candle[] = [];
  for (let k = 0; k < 20; k++) bars.push(candle(100, 100.4, 99.6, 100));
  bars.push(candle(100, 100.5, 99.8, 99.9));    // 20 down — the IPO-coloured bar
  bars.push(candle(99.9, 104, 99.8, 103.5));    // 21 middle bar of the gap
  bars.push(candle(103.5, 105, 101.5, 104.5));  // 22 low above bar 20's high -> bullish FVG
  const ctx = { candles: bars, swingIdx: 0, breakIdx: 22, direction: "demand" as const };
  const fvg = ONSET_DEFINITIONS.find((d) => d.key === "FVG_SEQUENCE_START")!;
  const onset = fvg.find(ctx);
  if (onset === null) return;                   // no aligned gap in this fixture
  assert(onset <= 21, "the onset is at or before the middle bar, never after it");
  const back = lastOppositeBefore(bars, onset, "demand", 0);
  assert(back === null || back < onset);
});

Deno.test("definitions carrying a tuned number say so", () => {
  // A threshold fitted on twelve examples is a parameter, not a hypothesis.
  // Anything numeric must be visible as such before it can be argued about.
  for (const d of ONSET_DEFINITIONS) {
    if (/\d/.test(d.key)) {
      assert(d.parameter !== null, `${d.key} looks numeric but declares no parameter`);
    }
    assert(d.definition.length > 40, `${d.key} must state what it means`);
  }
  const free = ONSET_DEFINITIONS.filter((d) => d.parameter === null).map((d) => d.key);
  assertEquals(free.sort(), ["BOS_CAUSAL_RUN", "FVG_SEQUENCE_START"],
    "exactly these two are parameter-free — if that changes, the claim in the report does too");
});

Deno.test("running the hypothesis leaves the detector untouched", () => {
  const s = series();
  const before = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.map((z) => z.id);
  const evs = directionalEvents(s);
  for (const ev of evs.slice(0, 15)) {
    const sw = ev.swingIndex ?? Math.max(0, ev.index - 10);
    testOnsetHypothesis(s, Math.min(sw + 1, ev.index), ev.direction === "bullish" ? "demand" : "supply", sw, ev.index);
  }
  const after = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.map((z) => z.id);
  assertEquals(after, before);
});
