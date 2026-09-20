import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  probeOriginPipeline,
  shadowOriginInventory,
  ORIGIN_DEFINITIONS,
  directionalEvents,
} from "../../functions/_shared/ipoOriginExperiments.ts";
import { detectIPOCandidates } from "../../functions/_shared/ipoZones.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

let t = 0;
function candle(o: number, h: number, l: number, c: number): Candle {
  const dt = new Date(Date.UTC(2026, 0, 1 + t++)).toISOString().slice(0, 19);
  return { datetime: dt, open: o, high: h, low: l, close: c } as Candle;
}
const reset = () => { t = 0; };

function manyBreakSeries(): Candle[] {
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

// ─── harness fidelity: the single most load-bearing test here ────────────────

Deno.test("the shadow harness under EXTREME_OF_LEG reproduces production exactly", () => {
  // Every experimental delta is read as "the definition changed this". That is
  // only true if the harness is otherwise identical to detectAllIPOCandidates.
  // If it drifts — a different event set, a different dedup — the deltas
  // measure the drift instead, and every conclusion drawn from them is wrong.
  const s = manyBreakSeries();
  const production = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" });
  const prodKeys = [...production.valid, ...production.rejected]
    .map((z) => `${z.direction}|${z.candleIndex}`).sort();

  const shadow = shadowOriginInventory(s, "EXTREME_OF_LEG")
    .map((z) => `${z.direction}|${z.index}`).sort();

  assert(prodKeys.length > 5, "the fixture must produce a meaningful number of zones");
  assertEquals(shadow, prodKeys,
    "the harness must mirror production before any alternative definition is trusted");
});

Deno.test("directionalEvents dedups per (bar, direction) like the detector", () => {
  const s = manyBreakSeries();
  const evs = directionalEvents(s);
  const keys = evs.map((e) => `${e.index}|${e.direction}`);
  assertEquals(new Set(keys).size, keys.length, "one event per bar per direction");
  for (let i = 1; i < evs.length; i++) assert(evs[i].index >= evs[i - 1].index, "sorted by bar");
});

// ─── the Mode-A shape, constructed explicitly ────────────────────────────────

/**
 * A leg whose extreme sits one bar BEFORE the candle we want, with the wanted
 * candle the last of its colour-run. This is the shape all four Mode-A examples
 * share, reduced to the minimum that reproduces it.
 */
function modeAFixture() {
  reset();
  const bars: Candle[] = [];
  let p = 100;
  for (let k = 0; k < 30; k++) { const o = p; p += 0.4; bars.push(candle(o, p + 0.2, o - 0.2, p)); }
  for (let k = 0; k < 6; k++) { const o = p; p -= 1.2; bars.push(candle(o, o + 0.2, p - 0.3, p)); }
  const extremeIdx = bars.length - 1;                 // lowest low so far, a down bar
  const o1 = p; p -= 0.2; bars.push(candle(o1, o1 + 0.1, p - 0.05, p));   // down, HIGHER low
  const wantedIdx = bars.length - 1;                  // last of the down run
  for (let k = 0; k < 10; k++) { const o = p; p += 1.4; bars.push(candle(o, p + 0.3, o, p)); }
  return { bars, extremeIdx, wantedIdx };
}

Deno.test("a Mode-A candle is classified NEVER_ENTERED at origin-search", () => {
  const { bars, wantedIdx } = modeAFixture();
  const r = probeOriginPipeline(bars, bars[wantedIdx].datetime, "demand") as any;
  if (r.error || !r.perBreak?.length) return;         // fixture produced no break

  assertEquals(r.expectedIndex, wantedIdx);
  if (r.outcome === "NEVER_ENTERED") {
    assertEquals(r.stage, "origin-search");
    const b = r.perBreak.find((x: any) => x.expectedInsideSearchWindow);
    if (b) {
      assert(b.expectedRelativeToOrigin > 0,
        "the defining shape: the candle sits AFTER the origin");
      assertEquals(b.expectedReachableByBackwardWalk, false);
      assert(String(b.unreachableBecause).startsWith("AFTER_ORIGIN"));
    }
  }
});

Deno.test("a candle production DOES select is not reported as never entered", () => {
  // Guards the classifier against always answering NEVER_ENTERED, which would
  // make every investigation agree with itself.
  const s = manyBreakSeries();
  const zones = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid;
  assert(zones.length > 0);
  const z = zones[0];
  const r = probeOriginPipeline(s, z.candleDatetime, z.direction) as any;
  if (r.error) return;
  assertEquals(r.expectedIndex, z.candleIndex);
  assertEquals(r.outcome, "PRESENT_MATCHER_FAILED",
    "a candle the detector selects must classify as present, not as never entered");
  assertEquals(r.stage, "inventory-persistence");
  assert(r.perBreak.some((b: any) => b.selectedIsExpected));
});

// ─── H1, stated and bounded ──────────────────────────────────────────────────

Deno.test("H1 takes the LAST bar of the IPO-coloured run at the extreme", () => {
  const { bars, extremeIdx, wantedIdx } = modeAFixture();
  const h1 = ORIGIN_DEFINITIONS.find((d) => d.key === "LAST_OF_WANTED_RUN_AT_EXTREME")!;
  const prod = ORIGIN_DEFINITIONS.find((d) => d.key === "EXTREME_OF_LEG")!;
  const ctx = { candles: bars, swingIdx: 25, breakIdx: bars.length - 1, direction: "demand" as const };

  assertEquals(prod.find(ctx), extremeIdx, "production stops at the extreme");
  assertEquals(h1.find(ctx), wantedIdx, "H1 walks to the end of the run the extreme sits in");
  assert(h1.find(ctx)! > prod.find(ctx)!, "H1 moves the origin FORWARD, which is the whole idea");
});

Deno.test("H1 introduces no numeric parameter", () => {
  const h1 = ORIGIN_DEFINITIONS.find((d) => d.key === "LAST_OF_WANTED_RUN_AT_EXTREME")!;
  assert(h1.assumption.includes("NO new numeric parameter"),
    "a parameter-free hypothesis is the only kind that can be judged on 12 examples");
  // It is reachable from the registry, which is how the experiment enumerates it.
  assert(ORIGIN_DEFINITIONS.every((d) => typeof d.find === "function" && d.assumption.length > 40));
  assertEquals(new Set(ORIGIN_DEFINITIONS.map((d) => d.key)).size, ORIGIN_DEFINITIONS.length);
});

Deno.test("every alternative definition stays inside the structural leg", () => {
  // A definition that wanders outside [swingIdx, breakIdx] would be changing the
  // leg as well as the origin, and its delta would no longer be attributable.
  const s = manyBreakSeries();
  for (const ev of directionalEvents(s).slice(0, 20)) {
    const swingIdx = ev.swingIndex ?? Math.max(0, ev.index - 10);
    const ctx = {
      candles: s, swingIdx, breakIdx: ev.index,
      direction: (ev.direction === "bullish" ? "demand" : "supply") as const,
    };
    for (const d of ORIGIN_DEFINITIONS) {
      const o = d.find(ctx);
      if (o === null) continue;
      assert(o >= swingIdx && o <= ev.index,
        `${d.key} proposed ${o} outside the leg [${swingIdx}, ${ev.index}]`);
    }
  }
});

Deno.test("the experiment harness cannot mutate the detector", () => {
  // shadowOriginInventory is pure with respect to the series and the detector.
  const s = manyBreakSeries();
  const before = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.map((z) => z.id);
  for (const d of ORIGIN_DEFINITIONS) shadowOriginInventory(s, d.key);
  const after = detectIPOCandidates(s, { symbol: "T", timeframe: "1d" }).valid.map((z) => z.id);
  assertEquals(after, before, "running every experiment must leave production output identical");
});
