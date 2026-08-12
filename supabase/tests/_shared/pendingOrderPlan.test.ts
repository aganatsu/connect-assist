import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildPendingOrderPlan } from "../../functions/_shared/pendingOrderPlan.ts";

const zone = { price: 1.1, zoneType: "IZ-OB", zoneLow: 1.099, zoneHigh: 1.101 };
const tp = (entry: number, stop: number, direction: "long" | "short") =>
  direction === "long" ? entry + 2 * (entry - stop) : entry - 2 * (stop - entry);

Deno.test("builder freezes geometry but has no position size", () => {
  const result = buildPendingOrderPlan({ direction: "long", zone, stopLoss: 1.095, takeProfitFor: tp });
  assert(result.valid);
  assertAlmostEquals(result.plan.takeProfit, 1.11);
  assertEquals(result.plan.riskReward, 2);
  assert(!("size" in result.plan));
});

Deno.test("builder rejects inverted geometry", () => {
  const result = buildPendingOrderPlan({ direction: "long", zone, stopLoss: 1.105, takeProfitFor: tp });
  assertEquals(result.valid, false);
});
