import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildICTConfirmationPolicy } from "../functions/_shared/ictConfirmationPolicy.ts";

Deno.test("choch policy freezes structure with supporting displacement", () => {
  const policy = buildICTConfirmationPolicy({ method: "choch", confirmationTimeframe: "15m", refinementTimeframe: "5m" });
  assertEquals(policy.structureShift, "required");
  assertEquals(policy.displacement, "supporting");
  assertEquals(policy.indicators, "not_required");
});

Deno.test("combined policy requires structural and indicator evidence", () => {
  const policy = buildICTConfirmationPolicy({ method: "choch_and_indicators", confirmationTimeframe: "15m", refinementTimeframe: "5m", indicatorMinimum: 2, liquiditySweep: "required", entryMode: "wait_retracement" });
  assertEquals(policy.structureShift, "required");
  assertEquals(policy.indicators, "required");
  assertEquals(policy.liquiditySweep, "required");
  assertEquals(policy.entryMode, "wait_retracement");
});
