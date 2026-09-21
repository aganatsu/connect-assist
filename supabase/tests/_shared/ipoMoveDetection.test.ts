import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MOVE_FAMILIES, ONSET_DEFS, detectMoves, moveOnset, ipoForMove,
} from "../../functions/_shared/ipoMoveDetection.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  datetime: new Date(Date.UTC(2021, 0, 1, i)).toISOString(),
  open: o, high: h, low: l, close: c, volume: 0,
} as Candle);

/** Quiet drift, one clearly bearish candle, then a sustained rally. */
function departure(): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < 25; i++) { out.push(bar(i, p, p + 1, p - 1, p + (i % 2 ? 0.3 : -0.3))); }
  out.push(bar(25, p, p + 0.5, p - 4, p - 3.5));          // the last BEARISH candle
  p -= 3.5;
  for (let i = 26; i < 40; i++) { out.push(bar(i, p, p + 7, p - 1, p + 6)); p += 6; }
  return out;
}

Deno.test("all six families and six onsets are offered", () => {
  assertEquals(MOVE_FAMILIES.length, 6);
  assertEquals(ONSET_DEFS.length, 6);
  const s = departure();
  for (const f of MOVE_FAMILIES) assert(Array.isArray(detectMoves(s, f, [])));
});

Deno.test("moves are detected without any knowledge of an IPO", () => {
  // The anti-circularity guarantee: detectMoves takes no demonstration input.
  const s = departure();
  const moves = detectMoves(s, "M2_DISPLACEMENT", []);
  assert(moves.length > 0);
  assert(moves.some((m) => m.direction === "bullish" && m.spanStart >= 25),
    "the rally after bar 25 must be found");
});

Deno.test("the frozen candle rule picks the opposite colour, never the same", () => {
  const s = departure();
  for (const m of detectMoves(s, "M2_DISPLACEMENT", [])) {
    for (const o of ONSET_DEFS) {
      const on = moveOnset(s, m, o);
      if (on === null) continue;
      const ipo = ipoForMove(s, m, on);
      if (ipo === null) continue;
      const up = s[ipo].close >= s[ipo].open;
      assertEquals(up, m.direction === "bearish",
        `${m.direction} move selected a ${up ? "bullish" : "bearish"} candle`);
      assert(ipo < on, "the IPO must precede the onset");
    }
  }
});

Deno.test("a bullish departure recovers the last bearish candle before it", () => {
  const s = departure();
  const bull = detectMoves(s, "M2_DISPLACEMENT", []).filter((m) => m.direction === "bullish");
  const hits = bull.map((m) => {
    const on = moveOnset(s, m, "O3_SUSTAINED_RUN_START");
    return on === null ? null : ipoForMove(s, m, on);
  }).filter((x) => x !== null);
  assert(hits.includes(25), `expected bar 25 among ${hits.join(",")}`);
});

Deno.test("contraction-expansion moves are optional, not required", () => {
  // Ezzy explicitly trades without a contraction, so M5 with no episodes must
  // simply return nothing rather than failing or blocking other families.
  const s = departure();
  assertEquals(detectMoves(s, "M5_CONTRACTION_EXPANSION", []).length, 0);
  assert(detectMoves(s, "M1_STRUCTURAL_BREAK", []).length >= 0);
});

Deno.test("the degenerate base-exit definitions are absent", async () => {
  const src = await Deno.readTextFile("./supabase/functions/_shared/ipoMoveDetection.ts");
  for (const bad of ["finalBaseExit", "permanentBaseExit"]) {
    assert(!src.includes(`${bad}(`), `${bad} is DEGENERATE_FOR_RESEARCH and must not be revived`);
  }
});
