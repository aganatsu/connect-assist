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
  buildDirectionVerdictThesisOptions,
  compareDirectionVerdicts,
  isVerdictComplete,
  validatePendingOrderThesis,
} from "../../functions/_shared/thesisValidator.ts";

const frozenLong = { verdict: "long" as const, confidence: 72 };
const MIN = 55;

const scalperEvidence = {
  version: "style-decision-evidence.v1" as const,
  style: "scalper" as const,
  roles: {
    bias: "1h" as const,
    structure: "15m" as const,
    setup: "5m" as const,
    confirmation: "5m" as const,
    refinement: "1m" as const,
  },
};

function storedVerdict(
  verdict: "long" | "short" | "neutral",
  confidence: number,
  options: {
    weekly?: boolean;
    gamePlan?: boolean;
    shouldBlock?: boolean;
    evidence?: unknown;
  } = {},
) {
  return {
    verdict,
    confidence,
    shouldBlock: options.shouldBlock ?? false,
    decisionEvidence: options.evidence ?? scalperEvidence,
    sources: [
      { name: "confirmedTrend", direction: verdict === "neutral" ? "neutral" : verdict === "long" ? "bullish" : "bearish" },
      { name: "simpleDirection", direction: verdict === "neutral" ? "neutral" : verdict === "long" ? "bullish" : "bearish" },
      { name: "regime", direction: "neutral" },
      { name: "weeklyBias", direction: options.weekly ? "neutral" : null },
      { name: "gamePlan", direction: options.gamePlan === false ? null : "neutral" },
    ],
  };
}

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

Deno.test("XAU regression: a complete scalper verdict reversal cancels the frozen setup", () => {
  const directionVerdictThesisOptions = buildDirectionVerdictThesisOptions({
    frozenDirectionVerdict: storedVerdict("long", 80),
    currentDirectionVerdict: storedVerdict("short", 80),
    expectedDecisionEvidence: scalperEvidence,
    frozenEffectiveConfig: { gamePlanEnabled: true, gpEnforcementMode: "hard" },
  });
  const result = validatePendingOrderThesis({
    order_id: "f60f0479",
    symbol: "XAU/USD",
    direction: "long",
    entry_price: 4478.3753748,
  }, {
    fotsiResult: null,
    lastGamePlan: null,
    dailyCandles: null,
    h4Candles: null,
    h1Candles: null,
    decisionEvidence: null,
    ...directionVerdictThesisOptions,
  });

  assertEquals(directionVerdictThesisOptions.currentDirectionVerdictComplete, true);
  assertEquals(result.valid, false);
  assertEquals(result.checkType, "direction_verdict_reversal");
});

Deno.test("Scalper completeness does not require Weekly evidence", () => {
  const result = buildDirectionVerdictThesisOptions({
    frozenDirectionVerdict: storedVerdict("long", 70),
    currentDirectionVerdict: storedVerdict("short", 80),
    expectedDecisionEvidence: scalperEvidence,
    frozenEffectiveConfig: { gamePlanEnabled: true, gpEnforcementMode: "hard" },
  });
  assertEquals(result.currentDirectionVerdictComplete, true);
});

Deno.test("frozen Game Plan observation mode does not require a Game Plan source", () => {
  const result = buildDirectionVerdictThesisOptions({
    frozenDirectionVerdict: storedVerdict("long", 70, { gamePlan: false }),
    currentDirectionVerdict: storedVerdict("short", 80, { gamePlan: false }),
    expectedDecisionEvidence: scalperEvidence,
    frozenEffectiveConfig: {
      gamePlanEnabled: true,
      gpEnforcementMode: "off",
    },
  });
  assertEquals(result.currentDirectionVerdictComplete, true);
});

Deno.test("Swing completeness requires Weekly evidence", () => {
  const swingEvidence = {
    ...scalperEvidence,
    style: "swing_trader" as const,
    roles: {
      bias: "1w" as const,
      structure: "1d" as const,
      setup: "4h" as const,
      confirmation: "1h" as const,
      refinement: "15m" as const,
    },
  };
  const result = buildDirectionVerdictThesisOptions({
    frozenDirectionVerdict: storedVerdict("long", 70, { weekly: true, evidence: swingEvidence }),
    currentDirectionVerdict: storedVerdict("short", 80, { evidence: swingEvidence }),
    expectedDecisionEvidence: swingEvidence,
    frozenEffectiveConfig: { gamePlanEnabled: true, gpEnforcementMode: "hard" },
  });
  assertEquals(result.currentDirectionVerdictComplete, false);
});

Deno.test("a blocked or wrong-style opposite verdict cannot cancel a frozen setup", () => {
  const blocked = buildDirectionVerdictThesisOptions({
    frozenDirectionVerdict: storedVerdict("long", 70),
    currentDirectionVerdict: storedVerdict("short", 90, { shouldBlock: true }),
    expectedDecisionEvidence: scalperEvidence,
  });
  assertEquals(blocked.currentDirectionVerdict, null);
  assertEquals(blocked.currentDirectionVerdictComplete, false);

  const dayTraderEvidence = { ...scalperEvidence, style: "day_trader" as const };
  const wrongStyle = buildDirectionVerdictThesisOptions({
    frozenDirectionVerdict: storedVerdict("long", 70),
    currentDirectionVerdict: storedVerdict("short", 90, { evidence: dayTraderEvidence }),
    expectedDecisionEvidence: scalperEvidence,
  });
  assertEquals(wrongStyle.currentDirectionVerdictComplete, false);
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
