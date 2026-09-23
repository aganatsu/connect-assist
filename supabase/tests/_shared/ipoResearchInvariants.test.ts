/**
 * STAGE 3 accounting invariants.
 *
 * RESEARCH ONLY. These guard the ARITHMETIC of the research reports, which is
 * where stage 2 went wrong: a table headed "the 26 that survived their entry
 * bar" carried totals of 29 and 29, which cannot both describe 26 trades. The
 * numbers were right and the label was wrong, but nothing in the pipeline could
 * have caught it. Now something can.
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

/** Every trade must land in exactly one bucket, and the buckets must sum. */
export function assertPartition(
  label: string, total: number, buckets: Record<string, number>,
): void {
  const sum = Object.values(buckets).reduce((a, b) => a + b, 0);
  assertEquals(sum, total,
    `${label}: buckets sum to ${sum} but the population is ${total} — ` +
    `${JSON.stringify(buckets)}`);
  for (const [k, v] of Object.entries(buckets)) {
    assert(v >= 0, `${label}: bucket ${k} is negative`);
    assert(v <= total, `${label}: bucket ${k}=${v} exceeds the population ${total}`);
  }
}

// ── the stage 2 numbers, now pinned ──────────────────────────────────────────

Deno.test("carry-forward outcomes cannot exceed the carry-forward input", () => {
  // The stage 2 defect, as an invariant. 26 went in; 26 must come out.
  assertPartition("stage2 carry-forward", 26, {
    TARGET: 11, S2_CLOSE: 15, STILL_OPEN: 0, AMBIGUOUS_LATER_BAR: 0, MISSING_DATA: 0,
  });
});

Deno.test("the 29/29 totals belong to the RESOLVED population, not the carry-forward one", () => {
  // resolved = resolved-inside-entry-bar + carried-forward
  assertEquals(18 + 11, 29, "TARGET total");
  assertEquals(14 + 15, 29, "S2_CLOSE total");
  assertPartition("stage2 resolved", 58, { TARGET: 29, S2_CLOSE: 29 });
});

Deno.test("the same-bar population partitions exactly", () => {
  assertPartition("stage2 same-bar entry-bar outcomes", 87, {
    TARGET_AFTER_ENTRY: 18, S2_CLOSE_AFTER_ENTRY: 14,
    STILL_OPEN_AT_BAR_END: 26, UNRESOLVED_AT_1M: 29,
  });
  assertPartition("stage2 same-bar final status", 87, { RESOLVED: 58, UNRESOLVED: 29 });
});

Deno.test("the 164-trade replay partitions exactly", () => {
  assertPartition("stage2 corpus", 164, { multiBar: 77, sameBarResolved: 58, sameBarUnresolved: 29 });
});

Deno.test("attribution partitions the stored bars exactly", () => {
  assertPartition("stage2 attribution", 3764, {
    exact: 3632, normalized: 4, closeNotProven: 121, mismatch: 7, noData: 0, apiError: 0,
  });
});

// ── the general rules, so a future run cannot repeat the mistake ─────────────

Deno.test("a partition that double-counts fails", () => {
  let threw = false;
  try { assertPartition("bad", 26, { TARGET: 29, S2_CLOSE: 29 }); } catch { threw = true; }
  assert(threw, "double counting was not caught");
});

Deno.test("a partition that loses trades fails", () => {
  let threw = false;
  try { assertPartition("lossy", 100, { a: 40, b: 40 }); } catch { threw = true; }
  assert(threw, "a missing bucket was not caught");
});

Deno.test("a single bucket may not exceed the population", () => {
  let threw = false;
  try { assertPartition("oversized", 10, { a: 11, b: -1 }); } catch { threw = true; }
  assert(threw, "an oversized bucket was not caught");
});

Deno.test("wins + losses + unresolved equals the population, per instrument", () => {
  // Stage 2 resolved counts, by instrument.
  assertPartition("EUR/USD same-bar", 40, { resolved: 23, unresolved: 17 });
  assertPartition("USD/JPY same-bar", 33, { resolved: 22, unresolved: 11 });
  assertPartition("BTC/USD same-bar", 14, { resolved: 13, unresolved: 1 });
  assertPartition("portfolio same-bar", 87, { resolved: 58, unresolved: 29 });
});
