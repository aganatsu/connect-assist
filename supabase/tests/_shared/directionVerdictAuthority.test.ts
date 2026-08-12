// Single directional authority for pending orders.
//
// Before: three post-placement checks could each cancel independently, two of
// them re-deciding the entry rather than detecting change.
//   Superseded by identical setup   511
//   Direction flip                  300
//   Game plan bias reversal         203
//
// The Game Plan cancellations showed the shape of the bug: "bullish 64%"
// killing the same short across Asian, London and New York. The bias never
// moved. The order was placed against it and then repeatedly re-judged.
//
// Game Plan is an input to the Direction Verdict at weight 0.08 — the lowest of
// five, labelled advisory. Cancelling on it separately counted that evidence
// twice and gave it more authority after placement than at placement.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  compareDirectionVerdicts,
  isVerdictComplete,
} from "../../functions/_shared/thesisValidator.ts";

const frozenLong = { verdict: "long" as const, confidence: 72 };
const MIN = 55;

Deno.test("confident reversal is the ONLY outcome that cancels", () => {
  const r = compareDirectionVerdicts({
    frozen: frozenLong,
    current: { verdict: "short", confidence: 80 },
    complete: true,
    minConfidence: MIN,
  });
  assertEquals(r.outcome, "confident_reversal");
  assertEquals(r.shouldCancel, true);
});

Deno.test("an unchanged verdict keeps the order — the 203 Game Plan case", () => {
  // Placed long, still long. Any disagreement present at placement was already
  // weighed by the verdict, which chose to trade anyway.
  const r = compareDirectionVerdicts({
    frozen: frozenLong,
    current: { verdict: "long", confidence: 60 },
    complete: true,
    minConfidence: MIN,
  });
  assertEquals(r.outcome, "verdict_unchanged");
  assertEquals(r.shouldCancel, false);
});

Deno.test("a neutral verdict is not a reversal", () => {
  const r = compareDirectionVerdicts({
    frozen: frozenLong,
    current: { verdict: "neutral", confidence: 90 },
    complete: true,
    minConfidence: MIN,
  });
  assertEquals(r.outcome, "verdict_neutral");
  assertEquals(
    r.shouldCancel,
    false,
    "the panel failing to agree is not evidence direction changed",
  );
});

Deno.test("opposing but under-confident keeps the order", () => {
  const r = compareDirectionVerdicts({
    frozen: frozenLong,
    current: { verdict: "short", confidence: 54 },
    complete: true,
    minConfidence: MIN,
  });
  assertEquals(r.shouldCancel, false);
});

Deno.test("a missing baseline never cancels — it would empty the book on deploy", () => {
  const r = compareDirectionVerdicts({
    frozen: null,
    current: { verdict: "short", confidence: 95 },
    complete: true,
    minConfidence: MIN,
  });
  assertEquals(r.outcome, "baseline_missing");
  assertEquals(
    r.shouldCancel,
    false,
    "orders placed before the verdict was frozen have no baseline; treating that " +
      "as 'changed' would cancel every open order the first time this deploys",
  );
});

Deno.test("a PARTIAL verdict never cancels, even at high confidence", () => {
  // This is the subtle one. agreement = agreeing/directionalSources is an
  // unweighted headcount, so dropping an OPPOSING source RAISES agreement and
  // removes its confidence penalty. A verdict missing Weekly/Game Plan can be
  // MORE confident than the complete one it stands in for. Confidence is
  // therefore not a safe proxy for completeness.
  const r = compareDirectionVerdicts({
    frozen: frozenLong,
    current: { verdict: "short", confidence: 99 },
    complete: false,
    minConfidence: MIN,
  });
  assertEquals(r.outcome, "current_verdict_partial");
  assertEquals(r.shouldCancel, false);
});

Deno.test("an unavailable verdict never cancels", () => {
  const r = compareDirectionVerdicts({
    frozen: frozenLong,
    current: null,
    complete: true,
    minConfidence: MIN,
  });
  assertEquals(r.outcome, "current_verdict_partial");
  assertEquals(r.shouldCancel, false);
});

Deno.test("a neutral frozen verdict is treated as no baseline", () => {
  const r = compareDirectionVerdicts({
    frozen: { verdict: "neutral", confidence: 40 },
    current: { verdict: "short", confidence: 90 },
    complete: true,
    minConfidence: MIN,
  });
  assertEquals(r.outcome, "baseline_missing");
  assertEquals(r.shouldCancel, false);
});

Deno.test("every non-cancelling outcome is still reported, not silently swallowed", () => {
  const outcomes = new Set(
    [
      compareDirectionVerdicts({ frozen: null, current: null, complete: true, minConfidence: MIN }),
      compareDirectionVerdicts({ frozen: frozenLong, current: null, complete: true, minConfidence: MIN }),
      compareDirectionVerdicts({ frozen: frozenLong, current: { verdict: "neutral", confidence: 10 }, complete: true, minConfidence: MIN }),
      compareDirectionVerdicts({ frozen: frozenLong, current: { verdict: "long", confidence: 80 }, complete: true, minConfidence: MIN }),
    ].map((r) => r.outcome),
  );
  assertEquals(outcomes.size, 4, "each keep-alive reason must be distinguishable in the data");
  for (const o of outcomes) assert(o !== "confident_reversal");
});

// ─── Completeness is relative to the style ───────────────────────────

const allPresent = {
  confirmedTrend: true,
  simpleDirection: true,
  regime: true,
  weeklyBias: true,
  gamePlan: true,
};

Deno.test("Day Trader is complete WITHOUT weekly — it is not a source for that style", () => {
  // bot-scanner supplies weeklyBias only when roles.bias === "1w":
  //   "Scalper/Day Trader no longer receive an unrelated weekly vote."
  // Requiring all five would mark every Day Trader verdict partial and disable
  // directional cancellation permanently, while appearing to work.
  const complete = isVerdictComplete(
    { ...allPresent, weeklyBias: false },
    { weeklyExpected: false, gamePlanExpected: true },
  );
  assertEquals(complete, true);
});

Deno.test("Swing IS incomplete without weekly — there it is the bias role", () => {
  const complete = isVerdictComplete(
    { ...allPresent, weeklyBias: false },
    { weeklyExpected: true, gamePlanExpected: true },
  );
  assertEquals(complete, false);
});

Deno.test("Game Plan is not required when enforcement is off", () => {
  assertEquals(
    isVerdictComplete({ ...allPresent, gamePlan: false }, { weeklyExpected: false, gamePlanExpected: false }),
    true,
  );
  assertEquals(
    isVerdictComplete({ ...allPresent, gamePlan: false }, { weeklyExpected: false, gamePlanExpected: true }),
    false,
  );
});

Deno.test("either missing spine source makes the verdict incomplete", () => {
  const expected = { weeklyExpected: false, gamePlanExpected: false };
  assertEquals(isVerdictComplete({ ...allPresent, confirmedTrend: false }, expected), false);
  assertEquals(isVerdictComplete({ ...allPresent, simpleDirection: false }, expected), false);
  assertEquals(
    isVerdictComplete({ ...allPresent, regime: false }, expected),
    false,
    "regime feeds the confidence penalty and the strong-regime veto",
  );
});

// ─── The removed authority stays removed ─────────────────────────────

const validator = await Deno.readTextFile(
  new URL("../../functions/_shared/thesisValidator.ts", import.meta.url),
);

Deno.test("Game Plan can no longer cancel an order on its own", () => {
  assert(
    !validator.includes("checkType: \"gp_bias_reversal\""),
    "Game Plan is an input to the Direction Verdict at weight 0.08; a separate hard " +
      "cancel double-counts it and gives advisory evidence more authority after " +
      "placement than before",
  );
  assert(
    !/biasOpposesDirection\(pairPlan\.bias/.test(validator),
    "the absolute bias-vs-direction comparison must be gone, not merely thresholded",
  );
});

Deno.test("the direction check no longer compares against the order direction absolutely", () => {
  assert(
    !/dirResult\.direction !== pending\.direction/.test(validator),
    "comparing current direction to the ORDER direction re-litigates the entry; the " +
      "comparison must be current verdict vs FROZEN verdict",
  );
  assert(
    validator.includes("compareDirectionVerdicts("),
    "the frozen-verdict comparison must be the directional authority",
  );
});
