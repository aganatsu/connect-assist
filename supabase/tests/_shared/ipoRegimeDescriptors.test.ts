import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  efficiency, percentileOf, buildReference, classify, measureSeries,
  labelSeriesCausal, REGIME_LABELS, ATR_PERIOD, MIN_REFERENCE,
} from "../../functions/_shared/ipoRegimeDescriptors.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime: new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + i * 3600_000).toISOString(),
     open: o, high: h, low: l, close: c, volume: 0 } as Candle);

/** A straight line up — maximally efficient by construction. */
const straight = (n: number) =>
  Array.from({ length: n }, (_, i) => bar(i, 100 + i, 100.5 + i, 99.5 + i, 100 + i));
/** A pure zig-zag — travels constantly and arrives nowhere. */
const zigzag = (n: number) =>
  Array.from({ length: n }, (_, i) => bar(i, 100, 101, 99, i % 2 ? 100.5 : 99.5));

const refOf = (effs: number[], atrs: number[]) => ({
  efficiency: [...effs].sort((a, b) => a - b),
  atrPct: [...atrs].sort((a, b) => a - b),
});
/** A fine uniform reference: value i/N for i = 1..N, so ranks are exact. */
const N_REF = 300;
const bigRef = (v: number) => Array.from({ length: N_REF }, (_, i) => v * (i + 1) / N_REF);

Deno.test("efficiency is |net| / summed travel — the frozen S2 formula", () => {
  // Explicit hand-computed case, so the formula cannot drift silently.
  const s = [bar(0, 0, 0, 0, 100), bar(1, 0, 0, 0, 110), bar(2, 0, 0, 0, 105)];
  // net = |105-100| = 5; path = 10 + 5 = 15
  assertEquals(efficiency(s, 0, 2), 5 / 15);
  assertEquals(efficiency(s, 0, 0), null, "a zero-length window has no efficiency");
  assertEquals(efficiency(s, 2, 0), null);
});

Deno.test("a straight line scores ~1 and a zig-zag scores ~0", () => {
  const up = efficiency(straight(30), 0, 29)!;
  const zz = efficiency(zigzag(30), 0, 29)!;
  assert(up > 0.99, `a monotone line should be maximally efficient, got ${up}`);
  assert(zz < 0.1, `a zig-zag should be minimally efficient, got ${zz}`);
});

Deno.test("percentileOf is the fraction strictly below", () => {
  const s = [1, 2, 3, 4];
  assertEquals(percentileOf(s, 0), 0);
  assertEquals(percentileOf(s, 3), 0.5);
  assertEquals(percentileOf(s, 99), 1);
  assertEquals(percentileOf([], 5), 0, "an empty reference ranks nothing");
});

Deno.test("buckets are distributional THIRDS and nothing else", () => {
  const s = straight(50);
  const ref = refOf(bigRef(1), bigRef(0.01));
  const at = (eff: number) =>
    classify(s, 40, { efficiency: eff, atrPct: 0.005, legStart: 0 }, ref).trend;
  assertEquals(at(0.10), "RANGING", "bottom third");
  assertEquals(at(0.50), "WEAK", "middle third");
  assertEquals(at(0.90), "STRONG", "top third");
  // Boundaries land exactly on 1/3 and 2/3, not on a hand-picked number.
  // With 300 reference points, rank(0.3333) = 99/300 < 1/3 and rank(0.3334) = 100/300 = 1/3.
  assertEquals(at(0.3333), "RANGING", "just below the lower third");
  assertEquals(at(0.3334), "WEAK", "exactly on the lower third belongs to the middle");
  assertEquals(at(0.6666), "WEAK", "just below the upper third");
  assertEquals(at(0.6667), "STRONG", "exactly on the upper third belongs to the top");
});

Deno.test("RANGING carries no direction — a low-efficiency net sign is noise", () => {
  const s = straight(50);
  const ref = refOf(bigRef(1), bigRef(0.01));
  const r = classify(s, 40, { efficiency: 0.05, atrPct: 0.005, legStart: 0 }, ref);
  assertEquals(r.trend, "RANGING");
  assertEquals(r.direction, null);
  assertEquals(r.label, "RANGING");
});

Deno.test("direction follows the net move over the structural leg", () => {
  const up = straight(50);
  const down = up.map((c, i) => bar(i, 200 - c.open, 200 - c.low, 200 - c.high, 200 - c.close));
  const ref = refOf(bigRef(1), bigRef(0.01));
  const m = { efficiency: 0.9, atrPct: 0.005, legStart: 0 };
  assertEquals(classify(up, 40, m, ref).label, "STRONG_BULL");
  assertEquals(classify(down, 40, m, ref).label, "STRONG_BEAR");
});

Deno.test("nothing is classified below the minimum reference size", () => {
  const s = straight(50);
  const thin = refOf([0.1, 0.5, 0.9], [0.001, 0.005, 0.01]);
  const r = classify(s, 40, { efficiency: 0.9, atrPct: 0.005, legStart: 0 }, thin);
  assertEquals(r.trend, "UNCLASSIFIED");
  assertEquals(r.vol, "UNCLASSIFIED");
  assertEquals(r.label, "UNCLASSIFIED");
});

Deno.test("a bar with no confirmed structural leg is not classified", () => {
  const s = straight(50);
  const ref = refOf(bigRef(1), bigRef(0.01));
  const r = classify(s, 40, { efficiency: null, atrPct: 0.005, legStart: null }, ref);
  assertEquals(r.trend, "UNCLASSIFIED");
  assertEquals(r.vol, "MID_VOL", "volatility is independent and still resolves");
});

Deno.test("volatility is an axis of its own, not folded into the trend label", () => {
  const s = straight(50);
  const ref = refOf(bigRef(1), bigRef(0.01));
  const hi = classify(s, 40, { efficiency: 0.9, atrPct: 0.009, legStart: 0 }, ref);
  const lo = classify(s, 40, { efficiency: 0.9, atrPct: 0.001, legStart: 0 }, ref);
  assertEquals(hi.vol, "HIGH_VOL");
  assertEquals(lo.vol, "LOW_VOL");
  assertEquals(hi.label, lo.label, "the trend label must not change with volatility");
});

Deno.test("measureSeries never reads a swing before it is confirmed", () => {
  const s = [...straight(40), ...zigzag(40).map((c, i) => bar(40 + i, c.open + 40, c.high + 40, c.low + 40, c.close + 40))];
  const full = measureSeries(s);
  const prefix = measureSeries(s.slice(0, 60));
  for (let k = 0; k < 60; k++) {
    assertEquals(full[k].legStart, prefix[k].legStart,
      `leg at bar ${k} moved when future bars were removed`);
  }
});

Deno.test("the causal variant ranks each bar only against its own past", () => {
  const s = [...straight(300), ...zigzag(300).map((c, i) => bar(300 + i, c.open, c.high, c.low, c.close))];
  const full = labelSeriesCausal(s);
  const prefix = labelSeriesCausal(s.slice(0, 400));
  for (let k = 0; k < 400; k++) {
    assertEquals(full[k].label, prefix[k].label, `bar ${k} changed label when the future was removed`);
  }
});

Deno.test("ATR period is the production default, not a number chosen here", () => {
  assertEquals(ATR_PERIOD, 14);
});

Deno.test("every produced label is a declared label", () => {
  const s = [...straight(250), ...zigzag(250)];
  for (const r of labelSeriesCausal(s)) {
    assert(REGIME_LABELS.includes(r.label), `undeclared label ${r.label}`);
  }
});

Deno.test("this module describes and does not select", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoRegimeDescriptors.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const banned of ["admits", "weight", "score", "tune"]) {
    assert(!new RegExp(banned, "i").test(code), `"${banned}" leaked into a descriptive module`);
  }
  // A hand-picked cutoff would show up as a decimal literal. The thirds are
  // written as 1 / 3 and 2 / 3 precisely so that this check can be exact.
  const decimals = code.match(/\d+\.\d+/g) ?? [];
  assertEquals(decimals, [], `decimal literals in a module that must have no tuned cutoffs: ${decimals}`);
});

Deno.test("buildReference drops nulls and sorts", () => {
  const ref = buildReference([
    { efficiency: 0.5, atrPct: null }, { efficiency: null, atrPct: 0.02 },
    { efficiency: 0.1, atrPct: 0.01 },
  ]);
  assertEquals(ref.efficiency, [0.1, 0.5]);
  assertEquals(ref.atrPct, [0.01, 0.02]);
});
