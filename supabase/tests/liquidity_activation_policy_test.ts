import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildLiquidityActivationPolicy, evaluateLiquidityActivation } from "../functions/_shared/liquidityActivationPolicy.ts";

Deno.test("required policy preserves current no-pool behavior explicitly", () => {
  const policy = buildLiquidityActivationPolicy({ role: "required" });
  assertEquals(evaluateLiquidityActivation({ policy, entryTriggerState: "none" }), { ready: true, reasonCode: "no_qualified_local_pool_not_applicable" });
});

Deno.test("required policy waits for a known unswept local pool", () => {
  const policy = buildLiquidityActivationPolicy({ role: "required" });
  assertEquals(evaluateLiquidityActivation({ policy, entryTriggerState: "unswept" }).ready, false);
  assertEquals(evaluateLiquidityActivation({ policy, entryTriggerState: "swept_rejected" }).ready, true);
});

Deno.test("absorbed trigger always requires fresh activation", () => {
  const policy = buildLiquidityActivationPolicy({ role: "supporting" });
  assertEquals(evaluateLiquidityActivation({ policy, entryTriggerState: "swept_absorbed" }).ready, false);
});
