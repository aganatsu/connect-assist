import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyAuthorityOwnershipToGateResults } from "../functions/_shared/authorityGateOwnership.ts";

const normalizeCode = (reason: string) => reason;
Deno.test("single ownership demotes legacy gates and duplicate rolling location", () => {
  const results = applyAuthorityOwnershipToGateResults({
    gates: [
      { passed: false, reason: "tier1_minimum" },
      { passed: false, reason: "structural_conviction" },
      { passed: false, reason: "premium_discount" },
      { passed: false, reason: "duplicate_position" },
    ],
    requestedMode: "enforce",
    runtimeTarget: "paper",
    canonicalRangeAvailable: true,
    normalizeCode,
  });
  assertEquals(results.map((result) => result.passed), [true, true, true, false]);
});

Deno.test("rolling location remains fallback when canonical range is unavailable", () => {
  const [result] = applyAuthorityOwnershipToGateResults({
    gates: [{ passed: false, reason: "premium_discount" }],
    requestedMode: "enforce",
    runtimeTarget: "paper",
    canonicalRangeAvailable: false,
    normalizeCode,
  });
  assertEquals(result.passed, false);
});
