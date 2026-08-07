import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeBreakerCandidate } from "../functions/_shared/breakerCandidateAuthority.ts";

Deno.test("supplemental breaker becomes eligible only inside its frozen impulse", () => {
  const result = normalizeBreakerCandidate({ semantic: "sweep_displacement_retest_breaker_setup", symbol: "EUR/USD", direction: "long", low: 1.1, high: 1.11, timeframe: "1h", structureBreakIndex: 12, retestComplete: true, impulse: { id: "i1", low: 1.09, high: 1.14, direction: "long" } });
  assertEquals(result.impulseOwned, true);
  assertEquals(result.eligibleForUnifiedQueue, true);
});

Deno.test("breaker outside impulse cannot join unified queue", () => {
  const result = normalizeBreakerCandidate({ semantic: "base_breaker_zone", symbol: "EUR/USD", direction: "short", low: 1.2, high: 1.21, timeframe: "1h", structureBreakIndex: 4, impulse: { id: "i1", low: 1.1, high: 1.15, direction: "short" } });
  assertEquals(result.impulseOwned, false);
  assertEquals(result.eligibleForUnifiedQueue, false);
});
