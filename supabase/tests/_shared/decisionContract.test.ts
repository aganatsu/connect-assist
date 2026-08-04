import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTradeDecisionContext,
  type DecisionHierarchyInput,
  evaluateDecisionHierarchy,
} from "../../functions/_shared/decisionContract.ts";

const gamePlan = {
  planVersion: "11111111-1111-4111-8111-111111111111",
  session: "London",
  generatedAt: "2026-07-29T10:00:00.000Z",
  focusPairs: ["GBP/CAD"],
  newsEvents: [],
  summary: "Bearish session plan",
  plans: [{
    gamePlanId: "22222222-2222-4222-8222-222222222222",
    planVersion: "11111111-1111-4111-8111-111111111111",
    symbol: "GBP/CAD",
    bias: "bearish",
    biasConfidence: 82,
    state: "tradeable",
    tradeable: true,
    regime: "trending",
    generatedAt: "2026-07-29T10:00:00.000Z",
    expiresAt: "2026-07-29T14:00:00.000Z",
  }],
} as any;

function input(): DecisionHierarchyInput {
  return {
    symbol: "GBP/CAD",
    direction: "short" as const,
    gamePlan,
    gamePlanEnabled: true,
    gamePlanMode: "hard" as const,
    gamePlanMinimumConfidence: 75,
    directionVerdict: {
      id: "33333333-3333-4333-8333-333333333333",
      verdictVersion: "44444444-4444-4444-8444-444444444444",
      gamePlanId: "22222222-2222-4222-8222-222222222222",
      gamePlanVersion: "11111111-1111-4111-8111-111111111111",
      verdict: "short" as const,
      confidence: 78,
      agreement: 0.8,
      shouldBlock: false,
    },
    requireDirectionVerdict: true,
    thesisResult: {
      valid: true,
      reason: null,
      checkType: null,
      cancelReason: null,
    },
    requireThesisValidation: true,
    entryConfirmation: {
      required: true,
      passed: true,
      method: "choch",
      reason: "5m bearish CHoCH confirmed",
      evaluatedAt: "2026-07-29T10:05:00.000Z",
    },
  };
}

Deno.test("decision hierarchy passes only when all four layers agree", () => {
  const result = evaluateDecisionHierarchy(input());
  assertEquals(result.passed, true);
  assertEquals(
    result.checks.map((check) => check.layer),
    [
      "game_plan",
      "direction_verdict",
      "thesis_validity",
      "entry_confirmation",
    ],
  );
});

Deno.test("Gameplan context cannot manufacture a trade without Direction Verdict", () => {
  const value = input();
  value.directionVerdict = null as any;
  const result = evaluateDecisionHierarchy(value);
  assertEquals(result.passed, false);
  assertEquals(result.code, "direction_unavailable");
});

Deno.test("confirmation cannot override a broken thesis", () => {
  const value = input();
  value.thesisResult = {
    valid: false,
    reason: "Daily structure flipped bullish",
    checkType: "direction_flip",
    cancelReason: "thesis_invalid:direction_flip:long:80",
  };
  const result = evaluateDecisionHierarchy(value);
  assertEquals(result.passed, false);
  assertEquals(result.code, "thesis_invalid");
  assertEquals(
    result.checks.some((check) => check.layer === "entry_confirmation"),
    false,
  );
});

Deno.test("entry confirmation is the final timing layer", () => {
  const value = input();
  value.entryConfirmation!.passed = false;
  value.entryConfirmation!.reason = "No bearish CHoCH yet";
  const result = evaluateDecisionHierarchy(value);
  assertEquals(result.code, "confirmation_blocked");
  assertStringIncludes(result.reason, "No bearish CHoCH");
});

Deno.test("decision context separates hard thesis validity from observational conviction", () => {
  const hierarchy = evaluateDecisionHierarchy(input());
  const context = buildTradeDecisionContext({
    stage: "fill",
    symbol: "GBP/CAD",
    direction: "short",
    gamePlan,
    directionVerdict: input().directionVerdict,
    thesisResult: input().thesisResult,
    requireThesisValidation: true,
    thesisConviction: { conviction: 6, mode: "shadow" },
    entryConfirmation: input().entryConfirmation,
    hierarchy,
    evaluatedAt: "2026-07-29T10:05:00.000Z",
  });
  assertEquals(context.gamePlan.version, gamePlan.planVersion);
  assertEquals(context.thesisValidity.valid, true);
  assertEquals(context.thesisConviction.observational, true);
  assertEquals(context.thesisConviction.affectsAuthorization, false);
});
