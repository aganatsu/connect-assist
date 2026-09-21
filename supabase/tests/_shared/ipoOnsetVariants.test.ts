import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { permanentBaseExit, runNeverRevisitsOrigin, describeMove } from "../../functions/_shared/ipoOnsetVariants.ts";
import { finalBaseExit } from "../../functions/_shared/ipoTeachingSpec.ts";
import { lastOppositeBefore } from "../../functions/_shared/ipoDisplacementOnset.ts";
import { ipoGeometry, detectIPOCandidates } from "../../functions/_shared/ipoZones.ts";
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

Deno.test("a probe out of the base is not a PERMANENT exit", () => {
  // The whole point of the variant. FINAL_BASE_EXIT takes the first close
  // outside; if price falls straight back in, that was not the move leaving.
  reset();
  const bars: Candle[] = [];
  for (let k = 0; k < 12; k++) bars.push(candle(100, 100.8, 99.2, 100));  // base 99.2-100.8
  bars.push(candle(101.0, 101.5, 101.0, 101.3));   // 12 closes clear above, no overlap
  bars.push(candle(101.3, 101.4, 99.5, 99.8));     // 13 falls straight back in
  const ctx = { candles: bars, swingIdx: 0, breakIdx: 13, direction: "demand" as const };
  assertEquals(finalBaseExit(ctx), 12, "the frozen definition takes the probe");
  assert(permanentBaseExit(ctx) !== 12,
    "the permanent variant must not take an exit that was reclaimed");
});

Deno.test("an overlap-defined base can swallow the whole leg — a real limitation", () => {
  // Observed on every Ezzy example: gently trending bars all overlap their
  // neighbour, so the 'base' grows to the entire leg and every base-exit
  // definition degenerates to the break bar. Pinned because it is the reason
  // those definitions score zero, not an incidental fixture quirk.
  reset();
  const bars: Candle[] = [];
  let p = 100;
  for (let k = 0; k < 18; k++) { const o = p; p += 0.25; bars.push(candle(o, p + 0.6, o - 0.6, p)); }
  const ctx = { candles: bars, swingIdx: 0, breakIdx: bars.length - 1, direction: "demand" as const };
  const a = describeMove(ctx);
  assert(a.base, "a base is found");
  assertEquals(a.base!.start, 0, "it starts at the swing");
  assertEquals(a.base!.end, bars.length - 2, "and runs to the bar before the break");
  assertEquals(a.firstBaseExitIndex, null,
    "and nothing ever closes beyond it, so there is no exit at all");
  assertEquals(a.permanentExitFromReportedBase, null,
    "which means no permanent exit from the reported base either");
});

Deno.test("PERMANENT_BASE_EXIT equals FINAL_BASE_EXIT when the exit holds", () => {
  reset();
  const bars: Candle[] = [];
  for (let k = 0; k < 12; k++) bars.push(candle(100, 100.8, 99.2, 100));
  for (let k = 0; k < 5; k++) bars.push(candle(101 + k, 102 + k, 100.9 + k, 101.8 + k));
  const ctx = { candles: bars, swingIdx: 0, breakIdx: bars.length - 1, direction: "demand" as const };
  assertEquals(permanentBaseExit(ctx), finalBaseExit(ctx),
    "with no reclaim the two must agree, or the variant is measuring something else");
});

Deno.test("RUN_NEVER_REVISITS_ORIGIN uses the FIXED taught anchor", () => {
  // The anchor is not a variable any more: mode A fires 0/4 on Ezzy and the
  // teaching states the step-back unconditionally.
  const s = series();
  for (const ev of directionalEvents(s).slice(0, 15)) {
    const sw = ev.swingIndex ?? Math.max(0, ev.index - 10);
    const dir = ev.direction === "bullish" ? "demand" as const : "supply" as const;
    const ctx = { candles: s, swingIdx: sw, breakIdx: ev.index, direction: dir };
    const onset = runNeverRevisitsOrigin(ctx);
    if (onset === null) continue;
    const origin = lastOppositeBefore(s, onset, dir, sw);
    assert(origin !== null && origin < onset, "the origin is always strictly before the onset");
    // And the promise it makes must actually hold.
    const g = ipoGeometry(s[origin!], dir);
    for (let j = onset; j <= ev.index; j++) {
      assert(!(s[j].low <= g.zoneHigh && s[j].high >= g.zoneLow),
        "a bar re-entered the origin zone, so the onset should not have qualified");
    }
  }
});

Deno.test("describeMove reports base, exits and sustained close consistently", () => {
  const s = series();
  for (const ev of directionalEvents(s).slice(0, 15)) {
    const sw = ev.swingIndex ?? Math.max(0, ev.index - 10);
    const dir = ev.direction === "bullish" ? "demand" as const : "supply" as const;
    const a = describeMove({ candles: s, swingIdx: sw, breakIdx: ev.index, direction: dir });
    if (a.base) {
      assert(a.base.start <= a.base.end);
      assert(a.base.low <= a.base.high);
      assert(a.base.start >= sw && a.base.end <= ev.index);
      if (a.firstBaseExitIndex !== null) assert(a.firstBaseExitIndex > a.base.end);
    }
    if (a.permanentExitFromReportedBase !== null && a.firstBaseExitIndex !== null) {
      assert(a.permanentExitFromReportedBase >= a.firstBaseExitIndex,
        "a permanent exit cannot precede the first exit from the SAME base");
    }
    // The definition may legitimately come from a different cluster, which is
    // exactly why it is reported under its own name.
    if (a.permanentBaseExitAnyCluster !== null) {
      assert(a.permanentBaseExitAnyCluster >= sw && a.permanentBaseExitAnyCluster <= ev.index);
    }
  }
});

Deno.test("both variants are parameter-free", () => {
  const src = Deno.readTextFileSync("supabase/functions/_shared/ipoOnsetVariants.ts");
  const body = src.slice(src.indexOf("export function permanentBaseExit"));
  assert(!/atr/i.test(body), "no ATR term");
  assert(!/[^.\w]0\.\d/.test(body.replace(/\/\*[\s\S]*?\*\//g, "")), "no fractional threshold");
});

Deno.test("running the variants leaves the detector untouched", () => {
  const s = series();
  const before = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.map((z) => z.id);
  for (const ev of directionalEvents(s).slice(0, 15)) {
    const sw = ev.swingIndex ?? Math.max(0, ev.index - 10);
    const dir = ev.direction === "bullish" ? "demand" as const : "supply" as const;
    const ctx = { candles: s, swingIdx: sw, breakIdx: ev.index, direction: dir };
    permanentBaseExit(ctx); runNeverRevisitsOrigin(ctx); describeMove(ctx);
  }
  const after = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.map((z) => z.id);
  assertEquals(after, before);
});
