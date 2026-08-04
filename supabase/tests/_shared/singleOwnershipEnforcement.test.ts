import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SingleOwnershipDecisionResult } from "./singleOwnershipDecision.ts";
import { evaluateSingleOwnershipEnforcement } from "./singleOwnershipEnforcement.ts";

const decision = (value: "allow" | "block" | "watch" | "unavailable") => ({
  decision: value,
  completeness: { complete: value !== "unavailable", unavailable: [] },
} as SingleOwnershipDecisionResult);

Deno.test("single ownership defaults to observation", () => {
  const result = evaluateSingleOwnershipEnforcement({
    runtimeTarget: "paper", decision: decision("allow"),
  });
  assertEquals(result.effectiveMode, "observe");
  assertEquals(result.affectsAuthorization, false);
});

Deno.test("single ownership can authorize a complete decision", () => {
  const result = evaluateSingleOwnershipEnforcement({
    requestedMode: "enforce", runtimeTarget: "paper",
    decision: decision("allow"),
  });
  assertEquals(result.authorized, true);
  assertEquals(result.affectsAuthorization, true);
});

Deno.test("single ownership enforcement fails closed for watch and unavailable", () => {
  for (const value of ["watch", "unavailable"] as const) {
    const result = evaluateSingleOwnershipEnforcement({
      requestedMode: "enforce", runtimeTarget: "paper",
      decision: decision(value),
    });
    assertEquals(result.authorized, false);
  }
});

Deno.test("single ownership live mode explicitly enforces live execution", () => {
  const result = evaluateSingleOwnershipEnforcement({
    requestedMode: "enforce_live", runtimeTarget: "live",
    decision: decision("allow"),
  });
  assertEquals(result.effectiveMode, "enforce");
  assertEquals(result.authorized, true);
  assertEquals(result.affectsAuthorization, true);
});

Deno.test("enforce follows the selected live account", () => {
  const result = evaluateSingleOwnershipEnforcement({
    requestedMode: "enforce", runtimeTarget: "live",
    decision: decision("allow"),
  });
  assertEquals(result.effectiveMode, "enforce");
  assertEquals(result.authorized, true);
  assertEquals(result.affectsAuthorization, true);
});
