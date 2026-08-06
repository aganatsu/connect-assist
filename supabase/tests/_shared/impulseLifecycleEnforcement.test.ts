import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveImpulseLifecycleEnforcement } from "../../functions/_shared/impulseLifecycleEnforcement.ts";

const eligible = {
  evidence_hash: "abcdef1234567890",
  status: "eligible" as const,
  reviewed: true,
  reviewed_at: "2026-08-06T00:00:00.000Z",
  replay_count: 40,
  resolved_count: 32,
  rescued_winners: 5,
  added_losses: 2,
  minimum_sample_ready: true,
  is_current: true,
};

Deno.test("enforcement fails closed without reviewed evidence", () => {
  assertEquals(
    resolveImpulseLifecycleEnforcement("enforce", null).effectiveMode,
    "observe",
  );
  assertEquals(
    resolveImpulseLifecycleEnforcement("enforce", { ...eligible, reviewed: false }).effectiveMode,
    "observe",
  );
});

Deno.test("current beneficial reviewed evidence unlocks enforcement", () => {
  const resolution = resolveImpulseLifecycleEnforcement("enforce", eligible);
  assertEquals(resolution.effectiveMode, "enforce");
  assertEquals(resolution.allowed, true);
  assertEquals(resolution.evidenceHash, eligible.evidence_hash);
});

Deno.test("harmful evidence cannot unlock enforcement", () => {
  const resolution = resolveImpulseLifecycleEnforcement("enforce", {
    ...eligible, rescued_winners: 1, added_losses: 2,
  });
  assertEquals(resolution.effectiveMode, "observe");
  assertEquals(resolution.allowed, false);
});
