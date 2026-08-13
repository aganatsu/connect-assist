import { assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

const migration = await Deno.readTextFile(new URL(
  "../../migrations/20260813033000_explain_impulse_replay_readiness.sql",
  import.meta.url,
));

Deno.test("impulse replay summary explains readiness denominator", () => {
  assertStringIncludes(migration, "AS no_entries");
  assertStringIncludes(migration, "AS inconclusive");
  assertStringIncludes(migration, "AS resolved_outcomes");
  assertStringIncludes(migration, "AS never_touched");
  assertStringIncludes(migration, "AS touched_trigger_not_locked");
  assertStringIncludes(migration, "AS trigger_locked_not_confirmed");
  assertStringIncludes(migration, "jsonb_path_exists");
  assertStringIncludes(migration, "AS invalidated");
  assertStringIncludes(migration, "AS expired");
  assertStringIncludes(migration, "AS exhausted");
  assertStringIncludes(migration, "outcome IN ('won', 'lost')) >= 30 AS minimum_sample_ready");
});
