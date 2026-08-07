import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveDirectionAvailability } from "../functions/_shared/directionAvailabilityPolicy.ts";

Deno.test("direction availability preserves legacy behavior in observation", () => {
  const result = resolveDirectionAvailability({ mode: "observe_fail_closed", verdictDirection: null, legacyDirection: "long" });
  assertEquals(result.selectedDirection, "long");
  assertEquals(result.wouldWait, true);
  assertEquals(result.observationOnly, true);
});

Deno.test("direction availability can fail closed explicitly", () => {
  const result = resolveDirectionAvailability({ mode: "fail_closed", verdictDirection: null, legacyDirection: "short" });
  assertEquals(result.selectedDirection, null);
  assertEquals(result.reasonCode, "direction_authority_unavailable");
  assertEquals(result.observationOnly, false);
});
