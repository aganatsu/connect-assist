import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  annotate, buildContext, trendAt, retracementAt, resampleTo4h, resampleToDaily,
  FEATURE_KEYS, type FeatureContext,
} from "../../functions/_shared/ipoConfluenceFeatures.ts";
import type { Setup } from "../../functions/_shared/ipoRawBacktest.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const at = (h: number) => {
  const d = new Date(Date.UTC(2021, 0, 1 + Math.floor(h / 24), h % 24));
  return d.toISOString();          // MUST keep the Z — see resample()
};
const bar = (i: number, o: number, h: number, l: number, c: number, v = 0): Candle =>
  ({ datetime: at(i), open: o, high: h, low: l, close: c, volume: v } as Candle);

/** A long, gently drifting series — enough bars for every primitive to run. */
function series(n: number): Candle[] {
  const s: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + Math.sin(i / 9) * 6 + i * 0.02;
    s.push(bar(i, base, base + 0.7, base - 0.7, base + 0.2));
  }
  return s;
}

const setupAt = (touchIndex: number, touchNumber = 1): Setup => ({
  ipoIndex: 5, direction: "demand", zoneLow: 99, zoneHigh: 101, extreme: 97,
  touchIndex, touchNumber, hasFvg: false, afterContraction: false, structuralTarget: null,
});

Deno.test("4h resampling buckets on UTC boundaries and records the closing index", () => {
  const { bars, closesAt } = resampleTo4h(series(12));
  assertEquals(bars.length, 3, "12 hourly bars are exactly three 4h buckets");
  assertEquals(closesAt, [3, 7, 11], "each bucket closes on its last source bar");
  assertEquals(bars[0].open, series(12)[0].open);
  assertEquals(bars[0].close, series(12)[3].close);
  assertEquals(bars[0].high, Math.max(...series(12).slice(0, 4).map((c) => c.high)));
});

Deno.test("daily resampling aggregates volume and splits on the date", () => {
  const s = [bar(0, 1, 2, 0, 1, 10), bar(5, 1, 3, 0, 2, 20), bar(30, 1, 2, 0, 1, 5)];
  const { bars, closesAt } = resampleToDaily(s);
  assertEquals(bars.length, 2, "hours 0 and 5 are one day, hour 30 is the next");
  assertEquals(bars[0].volume, 30);
  assertEquals(bars[0].high, 3);
  assertEquals(closesAt, [1, 2]);
});

Deno.test("trendAt uses the last EXTERNAL break and ignores internal noise", () => {
  const evs = [
    { index: 5, direction: "bullish", significance: "external" },
    { index: 9, direction: "bearish", significance: "internal" },
    { index: 12, direction: "bearish", significance: "external" },
  ];
  assertEquals(trendAt(evs, 4), null, "nothing has happened yet");
  assertEquals(trendAt(evs, 8), "bullish");
  assertEquals(trendAt(evs, 11), "bullish", "the internal bearish break must not flip it");
  assertEquals(trendAt(evs, 20), "bearish");
});

Deno.test("trendAt is strictly causal — an event ON the bar does not count", () => {
  const evs = [{ index: 10, direction: "bullish", significance: "external" }];
  assertEquals(trendAt(evs, 10), null, "the break at bar 10 is not knowable when bar 10 opens");
  assertEquals(trendAt(evs, 11), "bullish");
});

Deno.test("retracementAt reports where a price sits in the last completed swing", () => {
  const s = series(160);
  const mid = retracementAt(s, s[s.length - 1].close);
  assert(mid === null || (mid > -200 && mid < 300), "a retracement must be a finite percentage");
});

Deno.test("no feature reads a bar later than the touch", () => {
  // Annotating a prefix and annotating the full series at the same touch index
  // must agree. If any feature peeked forward, the two would diverge.
  const full = series(400);
  const eps = () => [];
  const ctxFull = buildContext(full, "EUR/USD", eps);
  const ctxPrefix = buildContext(full.slice(0, 201), "EUR/USD", eps);
  const evs: any[] = [];
  const a = annotate(setupAt(200), ctxFull, evs);
  const b = annotate(setupAt(200), ctxPrefix, evs);
  for (const k of FEATURE_KEYS) {
    assertEquals(a[k], b[k], `${k} changed when future bars were removed — it is not causal`);
  }
});

Deno.test("volume-profile institutional level is never claimed, on any series", () => {
  const withVol = series(120).map((c, i) => ({ ...c, volume: 1000 + i }));
  const ctx = buildContext(withVol, "BTC/USD", () => []);
  assert(ctx.hasVolume, "the fixture does carry volume");
  const a = annotate(setupAt(100), ctx, []);
  assertEquals(a.INSTITUTIONAL_VOLUME_PROFILE, "NOT_YET_MACHINE_DEFINED",
    "it must stay unresolved even where volume exists — no extractable primitive");
});

Deno.test("IPDA stays unresolved until 20 daily bars exist, rather than guessing", () => {
  const short = series(24 * 5);                  // five days
  const ctx = buildContext(short, "EUR/USD", () => []);
  assertEquals(annotate(setupAt(100), ctx, []).INSTITUTIONAL_IPDA, "NOT_YET_MACHINE_DEFINED");

  const long = series(24 * 40);                  // forty days
  const ctxL = buildContext(long, "EUR/USD", () => []);
  const v = annotate(setupAt(900), ctxL, []).INSTITUTIONAL_IPDA;
  assert(v === "PRESENT" || v === "ABSENT", `expected a resolved verdict, got ${v}`);
});

Deno.test("trend is tri-state: no reference is not the same as counter-trend", () => {
  const ctx = buildContext(series(120), "EUR/USD", () => []);
  const none = annotate(setupAt(100), ctx, []);
  assertEquals(none.TREND_ALIGNED, "NO_TREND_REFERENCE");

  const bull = annotate(setupAt(100), ctx,
    [{ index: 50, direction: "bullish", significance: "external" }]);
  assertEquals(bull.TREND_ALIGNED, "PRESENT", "a demand setup under a bullish trend is aligned");

  const bear = annotate(setupAt(100), ctx,
    [{ index: 50, direction: "bearish", significance: "external" }]);
  assertEquals(bear.TREND_ALIGNED, "ABSENT");
});

Deno.test("HTF parent distinguishes absent, aligned, conflicting and both", () => {
  const ctx = buildContext(series(400), "EUR/USD", () => []);
  const base: FeatureContext = { ...ctx, htfIpos: [], htfClosesAt: ctx.htfClosesAt };
  const su = setupAt(200);                       // demand, entry = zoneLow = 99

  const parent = (direction: "demand" | "supply", validAt: number) => ({
    candidateIndex: 0, direction, onsetIndex: 1, zoneLow: 98, zoneHigh: 100,
    invalidationLevel: 95, priorContraction: null, clearedAt: validAt, validAt,
    touches: [], invalidatedAt: null, outcome: "VALID_LIVE", hasFvg: false,
    hasBos: false, suppressedByContraction: false,
  }) as any;

  assertEquals(annotate(su, base, []).HTF_PARENT, "NO_PARENT");
  assertEquals(annotate(su, { ...base, htfIpos: [parent("demand", 2)] }, []).HTF_PARENT, "PRESENT");
  assertEquals(annotate(su, { ...base, htfIpos: [parent("supply", 2)] }, []).HTF_PARENT,
    "CONFLICTING_PARENT");
  assertEquals(
    annotate(su, { ...base, htfIpos: [parent("demand", 2), parent("supply", 2)] }, []).HTF_PARENT,
    "PARENT_BOTH_SIDES");
});

Deno.test("an HTF parent that has not validated yet is not counted", () => {
  const ctx = buildContext(series(400), "EUR/USD", () => []);
  const su = setupAt(20);
  const late = {
    candidateIndex: 0, direction: "demand", onsetIndex: 1, zoneLow: 98, zoneHigh: 100,
    invalidationLevel: 95, priorContraction: null, clearedAt: 90, validAt: 90,
    touches: [], invalidatedAt: null, outcome: "VALID_LIVE", hasFvg: false,
    hasBos: false, suppressedByContraction: false,
  } as any;
  assertEquals(annotate(su, { ...ctx, htfIpos: [late] }, []).HTF_PARENT, "NO_PARENT",
    "an HTF IPO validating at 4h bar 90 cannot be known at LTF bar 20");
});

Deno.test("FVG is read from the frozen lifecycle record, not recomputed", () => {
  const ctx = buildContext(series(200), "EUR/USD", () => []);
  assertEquals(annotate({ ...setupAt(150), hasFvg: true }, ctx, []).FVG, "PRESENT");
  assertEquals(annotate({ ...setupAt(150), hasFvg: false }, ctx, []).FVG, "ABSENT");
});

Deno.test("touch buckets are 1st / 2nd / 3rd+", () => {
  const ctx = buildContext(series(200), "EUR/USD", () => []);
  assertEquals(annotate(setupAt(150, 1), ctx, []).touchBucket, "1st");
  assertEquals(annotate(setupAt(150, 2), ctx, []).touchBucket, "2nd");
  assertEquals(annotate(setupAt(150, 3), ctx, []).touchBucket, "3rd+");
  assertEquals(annotate(setupAt(150, 9), ctx, []).touchBucket, "3rd+");
});

Deno.test("this layer measures only — it exposes no weight, score or threshold", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoConfluenceFeatures.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const banned of ["weight", "score", "rank", "threshold"]) {
    assert(!new RegExp(banned, "i").test(code),
      `"${banned}" appears in the annotation layer; it must stay a measurement layer`);
  }
});
