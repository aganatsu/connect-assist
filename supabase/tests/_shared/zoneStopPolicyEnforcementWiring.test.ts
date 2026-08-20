import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const botScanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const confirmationScanner = await Deno.readTextFile(
  new URL(
    "../../functions/zone-confirmation-scanner/index.ts",
    import.meta.url,
  ),
);
const backtest = await Deno.readTextFile(
  new URL("../../functions/backtest-engine/index.ts", import.meta.url),
);

Deno.test("Zone Setup stop policy activation freezes on both pre-arm routes", () => {
  assertEquals(
    botScanner.match(
      /zoneSetupStopPolicyAppliedAtArm: zoneStopPolicyResolution\.enforced/g,
    )
      ?.length,
    2,
  );
  assertEquals(
    botScanner.match(
      /zoneSetupStopPolicyMode: zoneStopPolicyResolution\.requestedMode/g,
    )
      ?.length,
    2,
  );
  assertEquals(
    botScanner.match(/zoneSetupStopPolicyBufferQuoteDistance:/g)?.length,
    2,
  );
});

Deno.test("confirmation only enforces the policy frozen when the order armed", () => {
  assertStringIncludes(
    confirmationScanner,
    "parsedPendingEvidence.zoneSetupStopPolicyAppliedAtArm === true",
  );
  assertStringIncludes(
    confirmationScanner,
    "Stop policy was not active when this order was armed",
  );
});

Deno.test("live enforcement requires normalized constraints from every active broker", () => {
  assertStringIncludes(confirmationScanner, 'eq("is_active", true)');
  assertStringIncludes(
    confirmationScanner,
    "exactConstraints.length !== brokerConnections.length",
  );
  assertStringIncludes(confirmationScanner, "calculateBrokerExecutionFloor");
  assertStringIncludes(
    confirmationScanner,
    'executionFloorSource = "broker_snapshot"',
  );
});

Deno.test("one final stop owns authorization and the execution plan", () => {
  assertStringIncludes(confirmationScanner, "stopLoss: authorizationStop");
  assertStringIncludes(
    confirmationScanner,
    "lifecycleAfterLock?.confirmation?.protectedLevel",
  );
  assertStringIncludes(
    confirmationScanner,
    "const finalRiskPlan = wouldBeExecutionPlan",
  );
  assertStringIncludes(
    confirmationScanner,
    "finalPositionStop: pendingStopPolicyResolution.enforced",
  );
});

Deno.test("route-specific activation is not applied to market-fill backtests", () => {
  assert(!backtest.includes("zoneSetupStopPolicyMode"));
});
