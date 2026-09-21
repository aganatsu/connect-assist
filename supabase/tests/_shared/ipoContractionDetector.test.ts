import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DETECTOR_INHERITED_CONSTANTS,
  DETECTOR_KEYS,
  baseRate,
  discoverContractions,
  evaluateDiscovery,
  ipoRelation,
  windowsFor,
  modalInterval,
  activeContextIndices,
  discoverContractionsV2,
  CONTINUATION_KEYS,
} from "../../functions/_shared/ipoContractionDetector.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  datetime: new Date(Date.UTC(2021, 0, 1, i)).toISOString(),
  open: o, high: h, low: l, close: c, volume: 0,
} as Candle);

/** 20 wide trending bars, 15 tight ones, 20 wide again. */
function series(): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < 20; i++) { out.push(bar(i, p, p + 12, p - 2, p + 10)); p += 10; }
  for (let i = 20; i < 35; i++) { out.push(bar(i, p, p + 2, p - 2, p + (i % 2 ? 1 : -1))); }
  for (let i = 35; i < 55; i++) { out.push(bar(i, p, p + 12, p - 2, p + 10)); p += 10; }
  return out;
}

Deno.test("discovery finds the quiet stretch WITHOUT being told where it is", () => {
  const s = series();
  const all = discoverContractions(s);
  assert(all.length > 0, "nothing discovered");
  const hit = all.find((w) => w.start >= 18 && w.end <= 37);
  assert(hit, `no window near the quiet stretch; got ${all.map((w) => `${w.start}-${w.end}`).join(",")}`);
  assert(hit!.bodyCompression < 1, "a discovered window must compress by definition");
});

Deno.test("no discovered window may swallow the whole series", () => {
  const s = series();
  for (const w of discoverContractions(s)) {
    assert(!(w.start <= 15 && w.end >= 50), `window ${w.start}-${w.end} covers everything`);
  }
});

Deno.test("the variants are nested: D4 implies D2 and D3, all imply D1", () => {
  const s = series();
  const all = discoverContractions(s);
  for (const w of all) {
    if (w.passes.D4_ALL_THREE) {
      assert(w.passes.D2_BODY_VOLATILITY && w.passes.D3_BODY_REPETITION, "D4 must imply D2 and D3");
    }
    if (w.passes.D2_BODY_VOLATILITY || w.passes.D3_BODY_REPETITION) {
      assert(w.passes.D1_BODY, "every variant must imply body compression");
    }
  }
  for (const k of DETECTOR_KEYS) assert(windowsFor(all, k).length <= all.length);
});

Deno.test("only inherited constants exist, and they are declared with a reason", () => {
  // The guard against quietly acquiring a fitted cutoff.
  assertEquals(DETECTOR_INHERITED_CONSTANTS.contextBars.value, 14);
  assertEquals(DETECTOR_INHERITED_CONSTANTS.minWindowBars.value, 2);
  for (const v of Object.values(DETECTOR_INHERITED_CONSTANTS)) {
    assert(v.why.length > 20, "an inherited constant must say where it came from");
  }
});

Deno.test("IoU rewards a tight match and punishes an enormous one", () => {
  const mk = (start: number, end: number) => ({
    start, end, bars: end - start + 1, startDatetime: "", endDatetime: "",
    bodyCompression: 0.5, volatilityDelta: -1, repetitionDelta: 1,
    passes: { D1_BODY: true, D2_BODY_VOLATILITY: true, D3_BODY_REPETITION: true, D4_ALL_THREE: true },
  });
  const marked = { start: 20, end: 34 };
  const tight = evaluateDiscovery([mk(20, 34)], marked);
  assertEquals(tight.bestIoU, 1);
  assertEquals(tight.startError, 0);
  assertEquals(tight.overExtends, false);
  const huge = evaluateDiscovery([mk(0, 200)], marked);
  assert(huge.bestIoU < 0.1, "a window covering everything must not score well");
  assertEquals(huge.overExtends, true);
});

Deno.test("a split is visible as more than one overlapping window", () => {
  const mk = (start: number, end: number) => ({
    start, end, bars: end - start + 1, startDatetime: "", endDatetime: "",
    bodyCompression: 0.5, volatilityDelta: null, repetitionDelta: null,
    passes: { D1_BODY: true, D2_BODY_VOLATILITY: false, D3_BODY_REPETITION: false, D4_ALL_THREE: false },
  });
  const r = evaluateDiscovery([mk(20, 25), mk(28, 34)], { start: 20, end: 34 });
  assertEquals(r.overlappingCount, 2);
});

Deno.test("base rate exposes a detector that calls most bars a contraction", () => {
  const s = series();
  const all = discoverContractions(s);
  const br = baseRate(s, all);
  assertEquals(br.bars, s.length);
  assert(br.pctBarsInsideAWindow < 100);
  assert(br.windowsPer1000Bars >= 0);
});

Deno.test("IPO relation reports INSIDE without rewarding it", () => {
  const w = { start: 20, end: 34 };
  assertEquals(ipoRelation(19, w), "OUTSIDE_BEFORE");
  assertEquals(ipoRelation(20, w), "BOUNDARY");
  assertEquals(ipoRelation(27, w), "INSIDE");
  assertEquals(ipoRelation(34, w), "BOUNDARY");
  assertEquals(ipoRelation(40, w), "OUTSIDE_AFTER");
});

// ─── v2: session-aware context and continuation variants ─────────────────────

Deno.test("modal interval is inferred from the series, not configured", () => {
  const s: Candle[] = Array.from({ length: 30 }, (_, i) => bar(i, 100, 101, 99, 100));
  assertEquals(modalInterval(s), 3600_000);
});

Deno.test("session-aware context is a NO-OP on a continuous market", () => {
  // Crypto has no delta above the modal interval, so nothing may be excluded.
  const s: Candle[] = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i, 102 + i, 98 + i, 101 + i));
  for (const a of [20, 35, 50]) {
    const active = activeContextIndices(s, a);
    const naive = Array.from({ length: 14 }, (_, i) => a - 14 + i);
    assertEquals(active, naive, `context changed on a gapless series at bar ${a}`);
  }
});

Deno.test("session-aware context excludes a genuine post-gap lull", () => {
  // 20 active bars, a 3-day hole, then 6 dead bars, then activity resumes.
  const s: Candle[] = [];
  for (let i = 0; i < 20; i++) s.push(bar(i, 100, 110, 90, 105));
  const jump = (h: number, o: number, hi: number, lo: number, c: number): Candle => ({
    datetime: new Date(Date.UTC(2021, 0, 4, h)).toISOString(), open: o, high: hi, low: lo, close: c, volume: 0,
  } as Candle);
  for (let i = 0; i < 6; i++) s.push(jump(i, 100, 100.4, 99.6, 100.1));
  for (let i = 6; i < 14; i++) s.push(jump(i, 100, 110, 90, 105));
  const active = activeContextIndices(s, 24);            // inside the dead stretch
  assert(active.some((i) => i < 20), "context must reach back past the closure");
  assert(active.filter((i) => i >= 20 && i <= 25).length < 5, "dead bars must be largely excluded");
});

Deno.test("every continuation variant is offered, and none is marked preferred", () => {
  assertEquals(CONTINUATION_KEYS.length, 5);
  assert(CONTINUATION_KEYS.includes("PER_BAR"));
  const s = series();
  for (const k of CONTINUATION_KEYS) {
    const w = discoverContractionsV2(s, 0, s.length - 1, { continuation: k });
    assert(Array.isArray(w), `${k} did not return windows`);
  }
});

Deno.test("v2 with PER_BAR and no session adjustment reproduces v1", () => {
  const s = series();
  const v1 = discoverContractions(s);
  const v2 = discoverContractionsV2(s, 0, s.length - 1, { continuation: "PER_BAR", sessionAware: false });
  assertEquals(v2.map((w) => `${w.start}-${w.end}`), v1.map((w) => `${w.start}-${w.end}`));
});
