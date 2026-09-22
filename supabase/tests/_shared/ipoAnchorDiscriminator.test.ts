import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { discriminateAnchorModes } from "../../functions/_shared/ipoAnchorDiscriminator.ts";
import { ONSET_DEFINITIONS, lastOppositeBefore } from "../../functions/_shared/ipoDisplacementOnset.ts";
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
const legs = (s: Candle[], n = 20) =>
  directionalEvents(s).slice(0, n).map((ev) => ({
    sw: ev.swingIndex ?? Math.max(0, ev.index - 10),
    brk: ev.index,
    dir: (ev.direction === "bullish" ? "demand" : "supply") as const,
  }));

Deno.test("discriminating means BOTH readings are available and different", () => {
  // The scope claim. A pair where mode A is impossible cannot be evidence for
  // B, and counting it as such would manufacture support for the step-back.
  const s = series();
  for (const { sw, brk, dir } of legs(s)) {
    const r = discriminateAnchorModes(s, Math.min(sw + 1, brk), dir, sw, brk);
    for (const w of r.rows) {
      if (!w.discriminating) continue;
      assertEquals(w.modeAAvailable, true);
      assertEquals(w.modeBAvailable, true);
      assert(w.stepBackIndex !== w.onsetIndex, "identical readings cannot discriminate");
      const wantUp = dir === "supply";
      assertEquals((s[w.onsetIndex!].close >= s[w.onsetIndex!].open) === wantUp, true,
        "mode A is only available when the onset already carries the IPO colour");
    }
  }
});

Deno.test("demonstratedMode is read off the label and never fed back as a feature", () => {
  // Every other field must be identical for two runs that differ only in which
  // candle is called demonstrated. Otherwise the 'discriminator' would be
  // partly reading the answer.
  const s = series();
  const { sw, brk, dir } = legs(s)[3];
  const a = discriminateAnchorModes(s, Math.min(sw + 1, brk), dir, sw, brk);
  const b = discriminateAnchorModes(s, Math.max(sw, brk - 1), dir, sw, brk);
  for (let i = 0; i < a.rows.length; i++) {
    const { demonstratedMode: _ma, ...ra } = a.rows[i];
    const { demonstratedMode: _mb, ...rb } = b.rows[i];
    assertEquals(JSON.stringify(ra), JSON.stringify(rb),
      `${a.rows[i].onsetKey}: a feature moved when only the demonstrated candle changed`);
  }
});

Deno.test("causal-run position is consistent with membership", () => {
  const s = series();
  for (const { sw, brk, dir } of legs(s)) {
    const r = discriminateAnchorModes(s, Math.min(sw + 1, brk), dir, sw, brk);
    for (const w of r.rows) {
      if (w.onsetIndex === null) continue;
      if (!w.onsetInCausalRun) { assertEquals(w.onsetPositionInCausalRun, "outside"); continue; }
      assert(["first", "middle", "last", "only"].includes(w.onsetPositionInCausalRun));
      assert(w.onsetIndex >= w.causalRunStart!, "a run member cannot precede the run start");
    }
  }
});

Deno.test("the FVG role distinguishes the three positions in the sequence", () => {
  // detectFVGs indexes the MIDDLE bar. Collapsing candle 1 and candle 2 would
  // erase the only part of the role that says whether the onset formed the gap
  // or merely preceded it.
  const s = series();
  const seen = new Set<string>();
  for (const { sw, brk, dir } of legs(s, 40)) {
    const r = discriminateAnchorModes(s, Math.min(sw + 1, brk), dir, sw, brk);
    for (const w of r.rows) if (w.onsetIndex !== null) seen.add(w.onsetFvgRole);
  }
  assert(seen.size >= 2, `the fixture must exercise several roles, saw ${[...seen]}`);
  for (const v of seen) {
    assert(["CANDLE_1_OF_3", "CANDLE_2_OF_3", "CANDLE_3_OF_3", "BEFORE_AN_FVG", "NONE"].includes(v));
  }
});

Deno.test("step-back agrees with the frozen helper exactly", () => {
  const s = series();
  for (const { sw, brk, dir } of legs(s)) {
    const r = discriminateAnchorModes(s, Math.min(sw + 1, brk), dir, sw, brk);
    for (const w of r.rows) {
      if (w.onsetIndex === null) continue;
      assertEquals(w.stepBackIndex, lastOppositeBefore(s, w.onsetIndex, dir, sw));
    }
  }
});

Deno.test("onset indices match the frozen detectors called directly", () => {
  const s = series();
  for (const { sw, brk, dir } of legs(s)) {
    const ctx = { candles: s, swingIdx: sw, breakIdx: brk, direction: dir };
    const r = discriminateAnchorModes(s, Math.min(sw + 1, brk), dir, sw, brk);
    for (const d of ONSET_DEFINITIONS) {
      assertEquals(r.rows.find((w) => w.onsetKey === d.key)!.onsetIndex, d.find(ctx));
    }
  }
});

Deno.test("measuring the discriminator leaves the detector untouched", () => {
  const s = series();
  const before = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.map((z) => z.id);
  for (const { sw, brk, dir } of legs(s)) discriminateAnchorModes(s, Math.min(sw + 1, brk), dir, sw, brk);
  const after = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.map((z) => z.id);
  assertEquals(after, before);
});
