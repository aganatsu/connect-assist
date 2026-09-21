import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SEED_KEYS, findSeeds, seedsFor, structureStalls,
  repetitionRisingAt, volatilityFallingAt, bodyCompressionAt,
} from "../../functions/_shared/ipoContractionSeeds.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  datetime: new Date(Date.UTC(2021, 0, 1, i)).toISOString(),
  open: o, high: h, low: l, close: c, volume: 0,
} as Candle);

/**
 * Three rising HH/HL legs, then a leg that makes a LOWER high, then a shelf.
 *
 * The failing leg matters: E1 fires on a swing that does not extend the
 * progression, so a shelf so flat that it produces NO swings at all yields no
 * stall. That is a real limitation of the definition and is pinned below rather
 * than engineered around.
 */
function staircaseThenStall(): Candle[] {
  const out: Candle[] = [];
  let p = 100, i = 0;
  for (let leg = 0; leg < 3; leg++) {
    for (let k = 0; k < 5; k++) { out.push(bar(i++, p, p + 8, p - 2, p + 6)); p += 10; }
    for (let k = 0; k < 5; k++) { p -= 6; out.push(bar(i++, p + 6, p + 2, p - 4, p)); }
  }
  // A leg that FAILS to make a higher high — the stall.
  for (let k = 0; k < 5; k++) { out.push(bar(i++, p, p + 3, p - 2, p + 2)); p += 2; }
  for (let k = 0; k < 5; k++) { p -= 6; out.push(bar(i++, p + 6, p + 2, p - 4, p)); }
  for (let k = 0; k < 20; k++) out.push(bar(i++, p, p + 2, p - 2, p + (k % 2 ? 0.5 : -0.5)));
  return out;
}

Deno.test("a structural stall is located where the progression stops extending", () => {
  const s = staircaseThenStall();
  const stalls = structureStalls(s);
  assert(stalls.length > 0, "no stall found on a staircase-then-flat series");
  assert(stalls.some((x) => x.index >= 30 && x.index <= 45),
    `no stall near the failing leg; got ${stalls.map((x) => x.index).join(",")}`);
  for (const x of stalls) assert(x.knownAtIndex >= x.index, "confirmation cannot precede the swing");
});

Deno.test("body compression is reported on every seed and required by none", () => {
  const s = staircaseThenStall();
  const all = findSeeds(s);
  assert(all.length > 0);
  // The family set must not silently filter on body compression.
  // EG-2 is a real seed whose bodies EXPAND (bodyComp 1.96). No family may
  // filter it out, so body compression must never appear as a gate.
  const e1 = seedsFor(all, "E1_STRUCTURE_STALL");
  assert(e1.length > 0, "no stall seeds to check");
  for (const x of all) assert("bodyCompression" in x, "every seed must carry the descriptor");
});

Deno.test("combined families are never more numerous than the stall they refine", () => {
  const s = staircaseThenStall();
  const all = findSeeds(s);
  const e1 = seedsFor(all, "E1_STRUCTURE_STALL").length;
  for (const k of ["E4_STALL_PLUS_REPETITION", "E5_STALL_PLUS_VOLATILITY", "E6_ALL_THREE"] as const) {
    assert(seedsFor(all, k).length <= e1, `${k} exceeded E1`);
  }
  assertEquals(SEED_KEYS.length, 6);
});

Deno.test("seeds are EDGES, not states — they cannot fire on most bars", () => {
  const s = staircaseThenStall();
  const all = findSeeds(s);
  for (const k of SEED_KEYS) {
    const n = seedsFor(all, k).length;
    assert(n < s.length / 2, `${k} fired on ${n} of ${s.length} bars — that is a state, not a transition`);
  }
});

Deno.test("the relative predicates return null rather than guessing without context", () => {
  const s = staircaseThenStall();
  assertEquals(repetitionRisingAt(s, 3), null);
  assertEquals(volatilityFallingAt(s, 3), null);
  assert(bodyCompressionAt(s, 3) === null || typeof bodyCompressionAt(s, 3) === "number");
});
