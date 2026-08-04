import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authorityGateOwner,
  classifyAuthorityGates,
  evaluateAuthorityGateDisposition,
  isLegacyDiagnosticGate,
} from "../../functions/_shared/authorityGateOwnership.ts";

Deno.test("duplicate market-quality gates are legacy diagnostics", () => {
  for (const code of [
    "minimum_score", "tier1_minimum", "structural_conviction",
    "reaction_confirmation", "smt_veto", "conflict_count", "ict_judas",
    "ict_fvg_invalidation", "ict_risk", "impulse_zone_score",
  ]) {
    assertEquals(isLegacyDiagnosticGate(code), true, code);
  }
});

Deno.test("owned authorities and operational safety remain enforcing", () => {
  assertEquals(authorityGateOwner("premium_discount"), "canonical_location");
  assertEquals(authorityGateOwner("direction_verdict"), "direction");
  assertEquals(authorityGateOwner("confirmation"), "confirmation");
  assertEquals(authorityGateOwner("thesis"), "thesis");
  for (const code of [
    "daily_loss_limit", "drawdown_limit", "duplicate_position",
    "portfolio_heat", "high_impact_news", "spread", "minimum_risk_reward",
    "invalid_sl_tp",
  ]) {
    assertEquals(authorityGateOwner(code), "operational_safety", code);
  }
});

Deno.test("legacy gates stop blocking whenever ownership enforcement is active", () => {
  assertEquals(evaluateAuthorityGateDisposition({ code: "ict_judas", passed: false, requestedMode: "enforce", runtimeTarget: "paper" }).blocksAuthorization, false);
  assertEquals(evaluateAuthorityGateDisposition({ code: "ict_judas", passed: false, requestedMode: "enforce", runtimeTarget: "live" }).blocksAuthorization, false);
  assertEquals(evaluateAuthorityGateDisposition({ code: "ict_judas", passed: false, requestedMode: "observe", runtimeTarget: "paper" }).blocksAuthorization, true);
  assertEquals(evaluateAuthorityGateDisposition({ code: "ict_judas", passed: false, requestedMode: "observe", runtimeTarget: "live" }).blocksAuthorization, true);
});

Deno.test("legacy gates are diagnostic under explicit live enforcement", () => {
  assertEquals(evaluateAuthorityGateDisposition({ code: "ict_judas", passed: false, requestedMode: "enforce_live", runtimeTarget: "live" }).blocksAuthorization, false);
});

Deno.test("operational safety always blocks when failed", () => {
  assertEquals(evaluateAuthorityGateDisposition({ code: "daily_loss_limit", passed: false, requestedMode: "enforce", runtimeTarget: "paper" }).blocksAuthorization, true);
});

Deno.test("unclassified gates remain enforcing by default", () => {
  const [check] = classifyAuthorityGates([
    { code: "new_unknown_gate", passed: false },
  ]);
  assertEquals(check.owner, "unclassified");
  assertEquals(check.affectsSingleOwnershipAuthorization, true);
});
