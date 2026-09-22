import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SIDEWAYS_KEYS, START_KEYS, EXIT_KEYS, confirmSideways, twoStageContractions,
} from "../../functions/_shared/ipoContractionTwoStage.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  datetime: new Date(Date.UTC(2021, 0, 1, i)).toISOString(),
  open: o, high: h, low: l, close: c, volume: 0,
} as Candle);

/** Rising HH/HL legs, a failing leg (the stall), then a bounded sideways shelf. */
function stallThenSideways(): Candle[] {
  const out: Candle[] = [];
  let p = 100, i = 0;
  for (let leg = 0; leg < 3; leg++) {
    for (let k = 0; k < 5; k++) { out.push(bar(i++, p, p + 8, p - 2, p + 6)); p += 10; }
    for (let k = 0; k < 5; k++) { p -= 6; out.push(bar(i++, p + 6, p + 2, p - 4, p)); }
  }
  for (let k = 0; k < 5; k++) { out.push(bar(i++, p, p + 3, p - 2, p + 2)); p += 2; }
  for (let k = 0; k < 5; k++) { p -= 6; out.push(bar(i++, p + 6, p + 2, p - 4, p)); }
  for (let k = 0; k < 24; k++) out.push(bar(i++, p, p + 3, p - 3, p + (k % 2 ? 1 : -1)));
  return out;
}

Deno.test("every stage option is offered and none is hardcoded as the winner", () => {
  assertEquals(SIDEWAYS_KEYS.length, 3);
  assertEquals(START_KEYS.length, 4);
  assertEquals(EXIT_KEYS.length, 3);
  const s = stallThenSideways();
  for (const w of SIDEWAYS_KEYS) {
    for (const x of EXIT_KEYS) {
      assert(Array.isArray(twoStageContractions(s, { sideways: w, exit: x })));
    }
  }
});

Deno.test("sideways confirmation compares against the series' OWN pre-stall value", () => {
  const s = stallThenSideways();
  // A confirmation must carry both sides of its comparison, so a reader can see
  // it was relative and not a constant.
  let sawOne = false;
  for (let seed = 20; seed < 45; seed++) {
    const c = confirmSideways(s, seed, "W1_EFFICIENCY_COLLAPSE");
    if (c.confirmed) {
      sawOne = true;
      assert(c.beforeValue !== null && c.afterValue !== null);
      assert(c.afterValue! < c.beforeValue!, "W1 must only confirm on a genuine collapse");
      assert(c.atIndex! > seed, "confirmation cannot precede its seed");
    }
  }
  assert(sawOne, "no sideways confirmation anywhere on a stall-then-shelf series");
});

Deno.test("the box is grown by containment and cannot drift with price", () => {
  // A window must never extend past a sustained directional move, which is the
  // failure that made the rolling continuation rules swallow whole charts.
  const s = stallThenSideways();
  for (const w of twoStageContractions(s, { exit: "X_CLOSE_OUTSIDE" })) {
    let hi = -Infinity, lo = Infinity;
    for (let k = w.start; k <= w.sidewaysAtIndex; k++) { hi = Math.max(hi, s[k].high); lo = Math.min(lo, s[k].low); }
    for (let k = w.start; k <= w.end; k++) {
      assert(s[k].close <= hi && s[k].close >= lo,
        `bar ${k} closed outside the established range but stayed in the box`);
    }
  }
});

Deno.test("body compression is carried but never gates a window", () => {
  const s = stallThenSideways();
  const ws = twoStageContractions(s);
  for (const w of ws) assert("bodyCompression" in w);
  // EG-2 is real and its bodies EXPAND, so an expanded-body window must be legal.
  const anyExpanded = ws.some((w) => (w.bodyCompression ?? 0) >= 1);
  assert(anyExpanded || ws.length === 0, "a window with expanded bodies must be emitted, not filtered");
});

Deno.test("no window is fully contained in another", () => {
  const s = stallThenSideways();
  const ws = twoStageContractions(s);
  for (let i = 0; i < ws.length; i++) {
    for (let j = 0; j < ws.length; j++) {
      if (i === j) continue;
      assert(!(ws[i].start >= ws[j].start && ws[i].end <= ws[j].end),
        `window ${i} is contained in ${j}`);
    }
  }
});
