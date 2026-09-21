import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { LiveVolatility, classifyCausal, isEligible, MIN_REFERENCE } from "../../functions/_shared/ipoLiveVolatility.ts";
import { labelSeries, buildReference, measureSeries } from "../../functions/_shared/ipoRegimeDescriptors.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime: new Date(Date.UTC(2025, 0, 1) + i * 3600_000).toISOString(),
     open: o, high: h, low: l, close: c, volume: 0 } as Candle);

/** Trend, then chop, then a volatile stretch — all three buckets get exercised. */
function mixed(n: number): Candle[] {
  const s: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const phase = Math.floor(i / (n / 3));
    const amp = phase === 0 ? 0.4 : phase === 1 ? 0.15 : 1.6;
    const base = 100 + Math.sin(i / 7) * 5 + i * 0.01;
    s.push(bar(i, base, base + amp, base - amp, base + Math.sin(i / 3) * amp * 0.6));
  }
  return s;
}

Deno.test("streaming and batch causal classification agree bar for bar", () => {
  const s = mixed(600);
  const batch = classifyCausal(s);
  const live = new LiveVolatility().pushAll(s);
  assertEquals(live.length, batch.length);
  for (let k = 0; k < s.length; k++) {
    assertEquals(live[k].vol, batch[k].vol, `volatility bucket diverged at bar ${k}`);
    assertEquals(live[k].label, batch[k].label, `regime label diverged at bar ${k}`);
  }
});

Deno.test("a bar never helps rank itself", () => {
  // Feeding the same prefix must give the same answer regardless of what comes
  // after it — the defining property of a causal classifier.
  const s = mixed(600);
  const full = new LiveVolatility().pushAll(s);
  const partial = new LiveVolatility().pushAll(s.slice(0, 400));
  for (let k = 0; k < 400; k++) {
    assertEquals(full[k].vol, partial[k].vol, `bar ${k} changed once the future arrived`);
  }
});

Deno.test("the causal reference differs from a full-window reference — that is the point", () => {
  const s = mixed(600);
  const nonCausal = labelSeries(s, buildReference(measureSeries(s)));
  const causal = classifyCausal(s);
  const differing = causal.filter((r, k) => r.vol !== nonCausal[k].vol).length;
  assert(differing > 0,
    "if these agreed everywhere, the non-causal reference was never doing anything");
});

Deno.test("nothing is classified during warmup", () => {
  const live = new LiveVolatility();
  const s = mixed(60);
  for (const b of s) assertEquals(live.push(b).vol, "UNCLASSIFIED");
  assert(live.referenceSize < MIN_REFERENCE);
});

Deno.test("UNCLASSIFIED is NOT eligible for a volatility-gated instrument", () => {
  assertEquals(isEligible("UNCLASSIFIED", true), false, "warmup must stand down, not guess");
  assertEquals(isEligible("MID_VOL", true), false);
  assertEquals(isEligible("LOW_VOL", true), false);
  assertEquals(isEligible("HIGH_VOL", true), true);
});

Deno.test("an ungated instrument trades every bucket, including warmup", () => {
  for (const v of ["HIGH_VOL", "MID_VOL", "LOW_VOL", "UNCLASSIFIED"] as const) {
    assertEquals(isEligible(v, false), true);
  }
});

Deno.test("the reference grows by one usable observation per bar once measurable", () => {
  const live = new LiveVolatility();
  const s = mixed(300);
  s.slice(0, 100).forEach((b) => live.push(b));
  const a = live.referenceSize;
  s.slice(100, 150).forEach((b) => live.push(b));
  assertEquals(live.referenceSize, a + 50);
});

Deno.test("this module changes the reference only — no new cutoff", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoLiveVolatility.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(code.match(/\d+\.\d+/g) ?? [], [], "a decimal literal would be a new cutoff");
  for (const banned of ["ATR", "14", "third", "percentile"]) {
    assert(!code.includes(banned),
      `"${banned}" is redefined here; it must come from the frozen descriptor`);
  }
});
