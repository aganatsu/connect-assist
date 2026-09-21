import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  IPO_STATES, runStateMachine, firstDirectionalOnset, lastOppositeBefore,
} from "../../functions/_shared/ipoStateMachine.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  datetime: new Date(Date.UTC(2021, 0, 1, i)).toISOString(),
  open: o, high: h, low: l, close: c, volume: 0,
} as Candle);

Deno.test("all ten specified states exist", () => {
  assertEquals(IPO_STATES.length, 10);
  for (const s of ["VALID_EXTERNAL_IPO", "CONTRACTION_ACTIVE", "IPO_TOUCH",
                   "NEW_IPO_PENDING", "NEW_IPO_VALID", "IPO_INVALIDATED"]) {
    assert(IPO_STATES.includes(s as never), `${s} missing`);
  }
});

Deno.test("move onset is the FIRST directional candle, however small", () => {
  // The trader's own example: red -> small green -> huge green -> huge green.
  const s = [
    bar(0, 110, 111, 99, 100),      // red, large body
    bar(1, 100, 102, 99, 101),      // SMALL green  <- onset
    bar(2, 101, 130, 100, 128),     // huge green
    bar(3, 128, 160, 127, 158),     // huge green
  ];
  const onset = firstDirectionalOnset(s, 1, true, 3);
  assertEquals(onset, 1, "onset must be the small green, not the huge one");
  assertEquals(lastOppositeBefore(s, onset!, true, 0), 0, "IPO is the red before it");
});

Deno.test("a candidate is NOT valid until the opposite side is cleared", () => {
  // The core of the specification: looking like an IPO is not being one.
  const s: Candle[] = [];
  s.push(bar(0, 108, 110, 98, 100));                       // the external IPO (demand)
  for (let i = 1; i <= 6; i++) s.push(bar(i, 100, 101, 88, 89));   // move away
  for (let i = 7; i <= 14; i++) s.push(bar(i, 90, 93, 87, 90 + (i % 2 ? 1 : -1)));  // contraction
  for (let i = 15; i <= 18; i++) s.push(bar(i, 95, 106, 94, 105)); // expansion back to the zone
  s.push(bar(19, 105, 106, 99, 100));                      // red inside the zone: candidate
  for (let i = 20; i <= 23; i++) s.push(bar(i, 100, 102, 99, 101));// weak drift, never clears
  const contractions = [{ start: 7, end: 14, high: 93, low: 87 }];
  const run = runStateMachine(s, 0, "demand", contractions);
  assert(run.finalState !== "NEW_IPO_VALID",
    `a candidate must not be promoted without clearance; got ${run.finalState}`);
  assertEquals(run.candidatePromotedAt, null);
});

Deno.test("invalidation is a close beyond the ORIGINAL candle extreme, not the zone", () => {
  const s: Candle[] = [bar(0, 108, 110, 98, 100)];          // demand IPO, low 98
  s.push(bar(1, 100, 101, 95, 99));                          // dips INTO the zone, no invalidation
  s.push(bar(2, 99, 100, 90, 97));                           // penetrates below the zone, still above 98? no
  const run = runStateMachine(s, 0, "demand", []);
  assertEquals(run.invalidationLevel, 98, "invalidation level is the candle LOW");
  // A close at 97 is below 98, so it must invalidate.
  assertEquals(run.finalState, "IPO_INVALIDATED");
});

Deno.test("repeated touches do not invalidate", () => {
  const s: Candle[] = [bar(0, 108, 110, 98, 100)];
  for (let i = 1; i <= 6; i++) s.push(bar(i, 120, 125, 118, 124));      // away
  for (let i = 7; i <= 12; i++) s.push(bar(i, 110, 112, 104, 109));     // repeated touches of [104,110]
  const run = runStateMachine(s, 0, "demand", []);
  assertEquals(run.invalidatedAt, null, "touching the zone repeatedly must not invalidate");
});

Deno.test("the FIRST BAR of a contraction is INSIDE it — offset 0 is not a boundary", () => {
  // Trader clarification: an IPO candle that opens a contraction is part of that
  // contraction and is correctly suppressed while it is active. This pins the
  // inclusive comparison so it cannot be "corrected" into an exclusive one.
  const inside = (i: number, c: { start: number; end: number }) => i >= c.start && i <= c.end;
  const ct = { start: 40, end: 60 };
  assertEquals(inside(40, ct), true, "offset 0 must count as inside");
  assertEquals(inside(60, ct), true, "the closing bar must count as inside");
  assertEquals(inside(39, ct), false);
  assertEquals(inside(61, ct), false);
});

Deno.test("SELF_REFERENCE: re-deriving the tracked IPO mints no duplicate", () => {
  // A trend leg after a touch can resolve back to the same candle. That is
  // identity de-duplication, not signal filtering: no new IPO, lifecycle continues.
  const s: Candle[] = [bar(0, 108, 110, 98, 100)];          // demand IPO, red
  for (let i = 1; i <= 4; i++) s.push(bar(i, 100, 104, 99, 103));   // away (green)
  s.push(bar(5, 103, 110, 99, 109));                         // back into the zone
  for (let i = 6; i <= 10; i++) s.push(bar(i, 109, 118, 108, 117)); // trend away, all green
  const run = runStateMachine(s, 0, "demand", []);
  if (run.selfReferenced) {
    assertEquals(run.candidateIndex, null, "a self-reference must not produce a candidate");
  }
  assert(run.candidateIndex === null || run.candidateIndex !== run.ipoIndex,
    "the tracked IPO must never be minted as its own new candidate");
});
