import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260730140000_add_prezone_watchlist_observations.sql",
    import.meta.url,
  ),
);

Deno.test("Slice 7.1 distinguishes visibility from execution eligibility", () => {
  assertStringIncludes(migration, "execution_eligible BOOLEAN");
  assertStringIncludes(migration, "observation_parent_id UUID");
  assertStringIncludes(migration, "observation_reason TEXT");
  assertStringIncludes(migration, "staged_prezone_observation_shape");
  assertStringIncludes(migration, "'waiting_for_unified_zone'");
});

Deno.test("a pre-zone observation cannot be converted in place", () => {
  assertStringIncludes(migration, "protect_prezone_observation()");
  assertStringIncludes(
    migration,
    "OLD.execution_eligible = false",
  );
  assertStringIncludes(
    migration,
    "create a fresh candidate",
  );
});

Deno.test("database guards prevent observations from creating orders or positions", () => {
  assertStringIncludes(
    migration,
    "guard_prezone_observation_execution()",
  );
  assertStringIncludes(
    migration,
    "zzz_guard_pending_prezone_execution",
  );
  assertStringIncludes(
    migration,
    "zzz_guard_position_prezone_execution",
  );
  assertStringIncludes(
    migration,
    "cannot create an order or position",
  );
});
