import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260828150000_accept_neutral_frozen_setup_contract.sql",
    import.meta.url,
  ),
);

Deno.test("neutral frozen setup migration keeps one trigger owner and both stored versions readable", () => {
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.freeze_setup_strategy_context()",
  );
  assertStringIncludes(migration, "'setup-policy-freeze.v1'");
  assertStringIncludes(migration, "'setup-policy-freeze.v2'");
  assertStringIncludes(migration, "'frozen-entry-zone.v1'");
  assertStringIncludes(migration, "'scenario-story.v1'");
  assertStringIncludes(migration, "v_entry_zone->'affectsAuthorization'");
  assertStringIncludes(
    migration,
    "structure POI entry zone provenance is incomplete",
  );
});

Deno.test("neutral frozen setup migration preserves historical rows instead of rewriting them", () => {
  assertStringIncludes(
    migration,
    "The generated package remains v1",
  );
  assertStringIncludes(
    migration,
    "NEW.frozen_strategy_hash := md5(v_context::TEXT)",
  );
  assertStringIncludes(
    migration,
    "frozen strategy context is immutable",
  );
});
