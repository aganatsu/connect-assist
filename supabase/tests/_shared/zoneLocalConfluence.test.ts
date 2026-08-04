import {
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  measurePointAgainstZone,
  measureRangeAgainstZone,
  permittedZoneBuffer,
} from "../../functions/_shared/zoneLocalConfluence.ts";

const zone = { low: 1.274, high: 1.275 }; // 10 pips on GBP/USD

Deno.test("zone-local policy gives full credit to a Fib inside the zone", () => {
  const result = measurePointAgainstZone({
    zone,
    level: 1.2746,
    pipSize: 0.0001,
    atr: 0.002,
  });
  assertEquals(result.proximityClass, "inside");
  assertEquals(result.qualifiedLocally, true);
  assertEquals(result.fullCreditEligible, true);
  assertEquals(result.distancePips, 0);
});

Deno.test("zone-local policy rejects a Fib 15 pips outside a 10-pip zone", () => {
  const result = measurePointAgainstZone({
    zone,
    level: 1.2725,
    pipSize: 0.0001,
    atr: 0.01,
  });
  assertEquals(result.proximityClass, "context_only");
  assertEquals(result.qualifiedLocally, false);
  assertEquals(result.fullCreditEligible, false);
  assertAlmostEquals(result.distancePips, 15);
  assertAlmostEquals(result.permittedBufferPips, 2.5);
});

Deno.test("zone-local buffer uses the smallest zone, pip, and ATR ceiling", () => {
  assertAlmostEquals(
    permittedZoneBuffer({
      zone,
      pipSize: 0.0001,
      atr: 0.002,
    }),
    0.0002,
  );
  assertAlmostEquals(
    permittedZoneBuffer({
      zone,
      pipSize: 0.0001,
      atr: 0.01,
    }),
    0.00025,
  );
});

Deno.test("range evidence records partial overlap instead of claiming full confluence", () => {
  const result = measureRangeAgainstZone({
    zone,
    evidence: { low: 1.2748, high: 1.2758 },
    pipSize: 0.0001,
    atr: 0.002,
  });
  assertEquals(result.proximityClass, "overlapping");
  assertEquals(result.qualifiedLocally, true);
  assertEquals(result.fullCreditEligible, false);
  assertAlmostEquals(result.overlapPercent, 20);
  assertEquals(result.reasonCode, "partial_overlap");
});

Deno.test("range evidence with majority overlap is full-credit eligible", () => {
  const result = measureRangeAgainstZone({
    zone,
    evidence: { low: 1.2742, high: 1.2748 },
    pipSize: 0.0001,
    atr: 0.002,
  });
  assertEquals(result.fullCreditEligible, true);
  assertAlmostEquals(result.overlapPercent, 100);
  assertEquals(result.reasonCode, "full_overlap");
});
