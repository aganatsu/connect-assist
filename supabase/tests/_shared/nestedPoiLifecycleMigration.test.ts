import {
  assertMatch,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260824110000_allow_nested_poi_entry_trigger_event.sql",
    import.meta.url,
  ),
);

Deno.test("nested POI trigger touch is accepted by the persisted lifecycle event contract", () => {
  assertStringIncludes(migration, "entry_trigger_touched");
  assertMatch(
    migration,
    /DROP CONSTRAINT IF EXISTS impulse_entry_lifecycle_transitions_event_type_check/,
  );
  assertMatch(
    migration,
    /ADD CONSTRAINT impulse_entry_lifecycle_transitions_event_type_check CHECK/,
  );
});
