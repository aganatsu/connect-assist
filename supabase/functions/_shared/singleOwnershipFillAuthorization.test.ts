import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateSingleOwnershipFillAuthorization } from "./singleOwnershipFillAuthorization.ts";
import type { SingleOwnershipDecisionResult } from "./singleOwnershipDecision.ts";

const frozen = {
  authorities: {
    zoneStory: {
      available: true, valid: true, entryReady: true, source: "unified",
      reasonCodes: ["zone_story_available"],
    },
  },
  legacyDiagnostics: { effectiveScore: 20, threshold: 55 },
} as SingleOwnershipDecisionResult;

const base = {
  frozenDecision: frozen,
  evaluatedAt: "2026-08-03T00:00:00Z",
  candidateId: "candidate-1",
  symbol: "EUR/USD",
  direction: "short" as const,
  directionVerdict: { verdict: "short", shouldBlock: false },
  canonicalLocation: { required: true, available: true, allowed: true },
  confirmation: { passed: true },
  thesis: { valid: true },
  finalChecks: [{ passed: true, reason: "Spread OK" }],
  rawFinalAuthorized: true,
  requestedMode: "enforce",
  runtimeTarget: "paper" as const,
};

Deno.test("fill authorization refreshes frozen story and allows complete paper setup", () => {
  const result = evaluateSingleOwnershipFillAuthorization(base);
  assertEquals(result.decision.authorities.zoneStory.source, "unified");
  assertEquals(result.authorized, true);
});

Deno.test("fill authorization blocks changed canonical location", () => {
  const result = evaluateSingleOwnershipFillAuthorization({
    ...base,
    canonicalLocation: { required: true, available: true, allowed: false },
  });
  assertEquals(result.authorized, false);
  assertEquals(result.enforcement.authorized, false);
  assertEquals(result.retryable, false);
  assertEquals(result.reason.includes("canonical_location"), true);
});

Deno.test("fill authorization cannot override raw operational failure", () => {
  const result = evaluateSingleOwnershipFillAuthorization({
    ...base, rawFinalAuthorized: false,
  });
  assertEquals(result.enforcement.authorized, true);
  assertEquals(result.authorized, false);
});

Deno.test("fill enforcement fails closed without frozen Zone Story", () => {
  const result = evaluateSingleOwnershipFillAuthorization({
    ...base, frozenDecision: null,
  });
  assertEquals(result.authorized, false);
  assertEquals(result.decision.completeness.unavailable, ["zone_story"]);
  assertEquals(result.retryable, true);
  assertEquals(result.reason.includes("zone_story_unavailable"), true);
});
