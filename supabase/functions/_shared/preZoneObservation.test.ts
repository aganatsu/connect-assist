import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyUnifiedWatch,
  isPreZoneObservation,
  requiresFreshCandidateHandoff,
} from "./preZoneObservation.ts";

const base = {
  requireUnifiedZone: true,
  unifiedGatePassed: false,
  unifiedState: "no_zone",
  hasZone: false,
  stagingEnabled: true,
  hasDirection: true,
  isPaused: false,
  score: 45,
  watchThreshold: 25,
  tier1Count: 1,
};

Deno.test("a viable directional candidate without a zone is observe-only", () => {
  assertEquals(
    classifyUnifiedWatch(base),
    "pre_zone_observation",
  );
});

Deno.test("noise below the normal Watchlist quality floor is not staged", () => {
  assertEquals(
    classifyUnifiedWatch({ ...base, score: 20 }),
    "none",
  );
  assertEquals(
    classifyUnifiedWatch({ ...base, tier1Count: 0 }),
    "none",
  );
});

Deno.test("a complete zone waiting for price, confirmation or sweep is executable watch evidence", () => {
  for (const unifiedState of ["watching", "at_zone", "waiting_for_sweep"]) {
    assertEquals(
      classifyUnifiedWatch({
        ...base,
        unifiedState,
        hasZone: true,
        score: 0,
        tier1Count: 0,
      }),
      "execution_watch",
    );
  }
});

Deno.test("ordinary unified watching does not replace standalone flow when unified zones are optional", () => {
  assertEquals(
    classifyUnifiedWatch({
      ...base,
      requireUnifiedZone: false,
      unifiedState: "watching",
      hasZone: true,
    }),
    "none",
  );
  assertEquals(
    classifyUnifiedWatch({
      ...base,
      requireUnifiedZone: false,
      unifiedState: "waiting_for_sweep",
      hasZone: true,
    }),
    "execution_watch",
  );
});

Deno.test("a triggered unified story remains ready for the normal execution pipeline", () => {
  assertEquals(
    classifyUnifiedWatch({ ...base, unifiedGatePassed: true }),
    "ready",
  );
});

Deno.test("an observation can never be silently converted into an execution candidate", () => {
  const observation = {
    execution_eligible: false,
    setup_type: "waiting_for_unified_zone",
  };
  assertEquals(isPreZoneObservation(observation), true);
  assertEquals(
    requiresFreshCandidateHandoff(observation, true),
    true,
  );
  assertEquals(
    requiresFreshCandidateHandoff(observation, false),
    false,
  );
  assertEquals(
    requiresFreshCandidateHandoff({ execution_eligible: true }, false),
    true,
  );
});
