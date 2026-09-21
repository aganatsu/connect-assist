import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { STATE_EXITS, applyStateExit, segmentEpisodes } from "../../functions/_shared/ipoContractionStateExit.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  datetime: new Date(Date.UTC(2021, 0, 1, i)).toISOString(),
  open: o, high: h, low: l, close: c, volume: 0,
} as Candle);

/** 14 quiet bars, then a sustained directional run. */
function sidewaysThenTrend(): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < 20; i++) out.push(bar(i, p, p + 2, p - 2, p + (i % 2 ? 0.4 : -0.4)));
  for (let i = 20; i < 40; i++) { out.push(bar(i, p, p + 9, p - 1, p + 8)); p += 8; }
  return out;
}

Deno.test("all five exit rules are offered, NONE included as the baseline", () => {
  assertEquals(STATE_EXITS.length, 5);
  assert(STATE_EXITS.includes("NONE"));
});

Deno.test("no exit rule introduces a length cap or bar tolerance", async () => {
  // The forbidden levers, asserted absent from the CODE. Comments are stripped
  // first: the module's own header says these levers are absent, and matching
  // that prose is what the first version of this test did.
  const raw = await Deno.readTextFile("./supabase/functions/_shared/ipoContractionStateExit.ts");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const bad of ["maxLength", "maxBars", "tolerance", "MAX_", "LIMIT"]) {
    assert(!code.includes(bad), `${bad} suggests a fitted cap crept into the code`);
  }
  // And no bare numeric comparison against a bar count.
  assert(!/end\s*-\s*start\s*[<>]=?\s*\d\d/.test(code), "a hardcoded episode-length bound appeared");
});

Deno.test("an efficiency regime shift ends a contraction that turns into a trend", () => {
  const s = sidewaysThenTrend();
  const ep = { start: 2, end: 39, sidewaysAtIndex: 14 };
  const r = applyStateExit(s, ep, "S2_EFFICIENCY_REGIME_SHIFT");
  assertEquals(r.exitedBy, "S2_EFFICIENCY_REGIME_SHIFT");
  assert(r.end < 39, "the episode must not run to the end of the trend");
});

Deno.test("NONE leaves the episode untouched, so it is a fair baseline", () => {
  const s = sidewaysThenTrend();
  const ep = { start: 2, end: 39, sidewaysAtIndex: 14 };
  const r = applyStateExit(s, ep, "NONE");
  assertEquals(r.end, 39);
  assertEquals(r.exitedBy, "NO_EXIT");
});

Deno.test("segmentation never produces an episode shorter than its own start", () => {
  const s = sidewaysThenTrend();
  for (const rule of STATE_EXITS) {
    for (const e of segmentEpisodes(s, [{ start: 2, end: 39, sidewaysAtIndex: 14 }], rule)) {
      assert(e.end > e.start, `${rule} produced a degenerate episode`);
    }
  }
});
