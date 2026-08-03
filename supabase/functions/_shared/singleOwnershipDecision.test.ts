import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateSingleOwnershipDecision } from "./singleOwnershipDecision.ts";

function input() {
  return {
    evaluatedAt: "2026-08-03T21:00:00Z",
    identity: { candidateId: "c1", symbol: "EUR/USD", direction: "long" as const },
    direction: { verdict: "long" as const, shouldBlock: false },
    zoneStory: { available: true, valid: true, entryReady: true, source: "unified", reasonCodes: [] },
    canonicalLocation: { required: true, available: true, allowed: true },
    confirmation: { required: true, passed: true, reasonCodes: [] },
    thesis: { required: true, valid: true, reasonCodes: [] },
    safety: { complete: true, checks: [{ code: "news", passed: true }] },
    legacyDiagnostics: { effectiveScore: 18, threshold: 30, tier1Count: 0, tier1GatePassed: false },
  };
}

Deno.test("allows when owned authorities pass regardless of legacy diagnostics", () => {
  const result = evaluateSingleOwnershipDecision(input());
  assertEquals(result.decision, "allow");
  assertEquals(result.legacyDiagnostics.effectiveScore, 18);
  assertEquals(result.observationOnly, true);
  assertEquals(result.affectsAuthorization, false);
});

Deno.test("waits for Zone Story or confirmation without treating it as a hard rejection", () => {
  const value = input();
  value.zoneStory.entryReady = false;
  value.confirmation.passed = false;
  const result = evaluateSingleOwnershipDecision(value);
  assertEquals(result.decision, "watch");
  assertEquals(result.reasonCodes, ["confirmation_waiting", "zone_story_waiting"]);
});

Deno.test("blocks canonical location, invalid thesis, and operational safety failures", () => {
  const value = input();
  value.canonicalLocation.allowed = false;
  value.canonicalLocation.reasonCode = "strict_value_required";
  value.thesis.valid = false;
  value.safety.checks = [{ code: "news", passed: false }];
  const result = evaluateSingleOwnershipDecision(value);
  assertEquals(result.decision, "block");
  assertEquals(result.reasonCodes, ["safety_news", "strict_value_required", "thesis_invalid"]);
});

Deno.test("operational safety excludes market evidence and legacy score gates", async () => {
  const { operationalSafetyChecks } = await import("./singleOwnershipDecision.ts");
  assertEquals(operationalSafetyChecks([
    { code: "minimum_score", passed: false },
    { code: "tier1_minimum", passed: false },
    { code: "high_impact_news", passed: false },
    { code: "portfolio_heat", passed: true },
  ]), [
    { code: "high_impact_news", passed: false },
    { code: "portfolio_heat", passed: true },
  ]);
});
