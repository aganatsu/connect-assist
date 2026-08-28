import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateSingleOwnershipDecision } from "../../functions/_shared/singleOwnershipDecision.ts";

function input() {
  return {
    evaluatedAt: "2026-08-03T21:00:00Z",
    identity: { candidateId: "c1", symbol: "EUR/USD", direction: "long" as const },
    direction: { verdict: "long" as const, shouldBlock: false },
    entryZone: { available: true, valid: true, entryReady: true, source: "unified", reasonCodes: [] },
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

Deno.test("waits for entry zone or confirmation without treating it as a hard rejection", () => {
  const value = input();
  value.entryZone.entryReady = false;
  value.confirmation.passed = false;
  const result = evaluateSingleOwnershipDecision(value);
  assertEquals(result.decision, "watch");
  assertEquals(result.reasonCodes, ["confirmation_waiting", "entry_zone_waiting"]);
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

Deno.test("frozen ownership waits on neutral direction but blocks an explicit reversal", () => {
  const unavailable: any = input();
  unavailable.direction = {
    verdict: "neutral",
    shouldBlock: true,
    policy: "retain_frozen_until_opposed",
  };
  const waiting = evaluateSingleOwnershipDecision(unavailable);
  assertEquals(waiting.decision, "unavailable");
  assertEquals(waiting.completeness.unavailable, ["direction"]);
  assertEquals(waiting.reasonCodes, []);

  const reversed: any = input();
  reversed.direction = {
    verdict: "short",
    shouldBlock: false,
    policy: "retain_frozen_until_opposed",
  };
  const blocked = evaluateSingleOwnershipDecision(reversed);
  assertEquals(blocked.decision, "block");
  assertEquals(blocked.reasonCodes, ["direction_not_authorized"]);
});

Deno.test("frozen ownership waits when an opposite direction label is itself blocked", () => {
  const value: any = input();
  value.direction = {
    verdict: "short",
    shouldBlock: true,
    policy: "retain_frozen_until_opposed",
  };
  const result = evaluateSingleOwnershipDecision(value);
  assertEquals(result.decision, "unavailable");
  assertEquals(result.completeness.unavailable, ["direction"]);
  assertEquals(result.reasonCodes, []);
});

Deno.test("operational safety excludes market evidence and legacy score gates", async () => {
  const { operationalSafetyChecks } = await import("../../functions/_shared/singleOwnershipDecision.ts");
  assertEquals(operationalSafetyChecks([
    { code: "minimum_score", passed: false },
    { code: "tier1_minimum", passed: false },
    { code: "high_impact_news", passed: false },
    { code: "multiple_live_connections_require_per_connection_sizing", passed: false },
    { code: "portfolio_heat", passed: true },
  ]), [
    { code: "high_impact_news", passed: false },
    { code: "multiple_live_connections_require_per_connection_sizing", passed: false },
    { code: "portfolio_heat", passed: true },
  ]);
});
