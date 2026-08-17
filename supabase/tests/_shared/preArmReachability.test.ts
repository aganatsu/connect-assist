import {
  assert,
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { observePreArmReachability } from "../../functions/_shared/botConfigBehavior.ts";

Deno.test("pre-arm reachability records arm-time distance without enforcing it", () => {
  const observation = observePreArmReachability({
    currentPrice: 1.105,
    entryPrice: 1.1,
    pipSize: 0.0001,
    atrValue: 0.0025,
    ttlMinutes: 480,
    referenceMaxDistancePips: 30,
    armedAt: "2026-08-17T12:00:00Z",
  });

  assertEquals(observation.contractVersion, "prearm-reachability.v1");
  assertAlmostEquals(observation.distancePrice, 0.005, 1e-12);
  assertAlmostEquals(observation.distancePips, 50, 1e-9);
  assertAlmostEquals(observation.distanceAtr!, 2, 1e-9);
  assertEquals(observation.ttlMinutes, 480);
  assertEquals(observation.referenceMaxDistancePips, 30);
  assert(!observation.withinReferenceDistance);
});

Deno.test("pre-arm reachability tolerates unavailable ATR", () => {
  const observation = observePreArmReachability({
    currentPrice: 100,
    entryPrice: 99,
    pipSize: 0.01,
    atrValue: null,
    ttlMinutes: 120,
    referenceMaxDistancePips: 120,
    armedAt: "2026-08-17T12:00:00Z",
  });

  assertEquals(observation.distanceAtr, null);
  assert(observation.withinReferenceDistance);
});
