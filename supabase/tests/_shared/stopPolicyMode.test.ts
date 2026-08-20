import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateBrokerExecutionFloor,
  normalizeZoneStopPolicyMode,
  resolveZoneStopPolicyMode,
} from "../../functions/_shared/stopPolicyMode.ts";

Deno.test("zone stop policy defaults unknown values to observe", () => {
  assertEquals(normalizeZoneStopPolicyMode(undefined), "observe");
  assertEquals(normalizeZoneStopPolicyMode("enforce"), "observe");
});

Deno.test("paper enforcement cannot affect a live account", () => {
  assertEquals(
    resolveZoneStopPolicyMode("enforce_paper", "paper").enforced,
    true,
  );
  assertEquals(
    resolveZoneStopPolicyMode("enforce_paper", "live").enforced,
    false,
  );
});

Deno.test("live enforcement explicitly covers paper and live execution", () => {
  assertEquals(
    resolveZoneStopPolicyMode("enforce_live", "paper").enforced,
    true,
  );
  assertEquals(
    resolveZoneStopPolicyMode("enforce_live", "live").enforced,
    true,
  );
});

Deno.test("live broker floor uses the strictest normalized constraint", () => {
  const floor = calculateBrokerExecutionFloor([{
    bid: 1,
    ask: 1.0002,
    digits: 5,
    stopsLevel: 45,
    tickSize: 0.00001,
  }]);
  assertEquals(floor, 45 * Math.pow(10, -5));
});

Deno.test("live broker floor fails closed when any snapshot is invalid", () => {
  assertEquals(calculateBrokerExecutionFloor([]), null);
  assertEquals(
    calculateBrokerExecutionFloor([{
      bid: 1,
      ask: 0.999,
      digits: 5,
      stopsLevel: 0,
      tickSize: 0.00001,
    }]),
    null,
  );
});

Deno.test("live broker floor supports integer-priced instruments and zero spread", () => {
  const floor = calculateBrokerExecutionFloor([{
    bid: 100,
    ask: 100,
    digits: 0,
    stopsLevel: 2,
    tickSize: 1,
  }]);

  assertEquals(floor, 2);
});
