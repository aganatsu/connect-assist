import {
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateSLTP } from "../../functions/_shared/smcAnalysis.ts";

const baseInput = {
  direction: "long" as const,
  lastPrice: 100,
  pipSize: 0.01,
  config: {
    slMethod: "fixed_pips",
    fixedSLPips: 25,
    tpMethod: "rr_ratio",
    tpRatio: 2,
  },
  swings: [],
  orderBlocks: [],
  liquidityPools: [],
  pdLevels: null,
  atrValue: 0.1,
  fvgs: [],
};

Deno.test("stop-policy shadow is opt-in and leaves the live calculation unchanged", () => {
  const live = calculateSLTP(baseInput);
  const observed = calculateSLTP({
    ...baseInput,
    stopPolicyShadow: {
      structuralInvalidation: 99.8,
      confirmationAtr: 0.1,
      atrMultiplier: 1.5,
      executionFloorQuoteDistance: 0.05,
      executionFloorSource: "spread_proxy",
      riskCapAtrMultiplier: 4,
    },
  });

  assertAlmostEquals(live.stopLoss!, 99.75);
  assertAlmostEquals(live.takeProfit!, 100.5);
  assertEquals(live.stopPolicyShadow, undefined);

  assertAlmostEquals(observed.stopLoss!, 99.8);
  assertAlmostEquals(observed.takeProfit!, 100.4);
  assertEquals(observed.stopPolicyShadow?.observationOnly, true);
  assertEquals(observed.stopPolicyShadow?.valid, true);
  assertAlmostEquals(
    observed.stopPolicyShadow?.finalStopDistance ?? 0,
    0.2,
  );
});

Deno.test("stop-policy shadow records a cap breach without authorizing it", () => {
  const observed = calculateSLTP({
    ...baseInput,
    stopPolicyShadow: {
      structuralInvalidation: 90,
      confirmationAtr: 1,
      atrMultiplier: 1.5,
      executionFloorQuoteDistance: 0.05,
      executionFloorSource: "spread_proxy",
      riskCapAtrMultiplier: 4,
    },
  });

  assertEquals(observed.stopPolicyShadow?.valid, false);
  assertEquals(
    observed.stopPolicyShadow?.reason,
    "style_risk_cap_exceeded",
  );
  assertEquals(observed.stopPolicyShadow?.riskCapBreached, true);
  assertAlmostEquals(observed.stopLoss!, 90);
});
