import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildPendingOrderPlan, buildPreArmedPositionPlan } from "../../functions/_shared/pendingOrderPlan.ts";

const zone = {
  price: 1.2000,
  zoneType: "ob",
  zoneLow: 1.1980,
  zoneHigh: 1.2010,
};

const tp = (entry: number, stop: number, direction: "long" | "short") =>
  direction === "long" ? entry + 2 * (entry - stop) : entry - 2 * (stop - entry);

Deno.test("builder freezes geometry but has no position size", () => {
  const result = buildPendingOrderPlan({ direction: "long", zone, stopLoss: 1.195, takeProfitFor: tp });
  assert(result.valid);
  assertAlmostEquals(result.plan.takeProfit, 1.21);
  assertEquals(result.plan.riskReward, 2);
  assert(!("size" in result.plan));
});

Deno.test("builder rejects inverted geometry", () => {
  const result = buildPendingOrderPlan({ direction: "long", zone, stopLoss: 1.205, takeProfitFor: tp });
  assertEquals(result.valid, false);
});

Deno.test("pre-armed long keeps structural invalidation separate from position stop", () => {
  const result = buildPreArmedPositionPlan({
    direction: "long",
    zone,
    structuralInvalidation: 1.1979,
    preferredPositionStop: 1.1979,
    pipSize: 0.0001,
    minimumStopPips: 25,
    takeProfitRatio: 2,
  });
  assert(result.valid);
  assert(result.plan.stopLoss < 1.1979);
  assertEquals(result.plan.stopLoss, 1.1975);
  assertAlmostEquals(result.plan.takeProfit, 1.205);
});

Deno.test("pre-armed short keeps structural invalidation separate from position stop", () => {
  const result = buildPreArmedPositionPlan({
    direction: "short",
    zone,
    structuralInvalidation: 1.2011,
    preferredPositionStop: 1.2011,
    pipSize: 0.0001,
    minimumStopPips: 25,
    takeProfitRatio: 2,
  });
  assert(result.valid);
  assert(result.plan.stopLoss > 1.2011);
  assertEquals(result.plan.stopLoss, 1.2025);
  assertAlmostEquals(result.plan.takeProfit, 1.195);
});

Deno.test("valid wider position stop is preserved at final authorization", () => {
  const result = buildPreArmedPositionPlan({
    direction: "long",
    zone,
    structuralInvalidation: 1.1979,
    preferredPositionStop: 1.196,
    pipSize: 0.0001,
    minimumStopPips: 25,
    atrValue: 0.001,
    atrFloorMultiplier: 1.5,
    takeProfitRatio: 2,
  });
  assert(result.valid);
  assertEquals(result.plan.stopLoss, 1.196);
  assertAlmostEquals(result.plan.takeProfit, 1.208);
});
