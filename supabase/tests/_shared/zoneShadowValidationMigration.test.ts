import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = Deno.readTextFileSync(
  new URL(
    "../../migrations/20260731150000_add_zone_candidate_shadow_validation.sql",
    import.meta.url,
  ),
);

Deno.test("zone shadow validation table is isolated from execution tables", () => {
  assertStringIncludes(
    migration,
    "CREATE TABLE IF NOT EXISTS public.zone_candidate_shadow_observations",
  );
  assertEquals(migration.includes("REFERENCES public.pending_orders"), false);
  assertEquals(migration.includes("REFERENCES public.paper_positions"), false);
  assertEquals(migration.includes("REFERENCES public.staged_setups"), false);
  assertStringIncludes(
    migration,
    "'observe_only'::TEXT AS enforcement",
  );
});

Deno.test("zone shadow evidence is immutable while outcome fields remain updateable", () => {
  assertStringIncludes(
    migration,
    "protect_zone_shadow_observation_evidence",
  );
  assertStringIncludes(
    migration,
    "zone shadow observation evidence is immutable",
  );
  assertEquals(
    migration.includes("NEW.outcome_status"),
    false,
  );
  assertEquals(
    migration.includes("NEW.mfe_pips"),
    false,
  );
});

Deno.test("zone shadow validation is owner-readable and service-managed", () => {
  assertStringIncludes(
    migration,
    "ALTER TABLE public.zone_candidate_shadow_observations",
  );
  assertStringIncludes(migration, "ENABLE ROW LEVEL SECURITY");
  assertStringIncludes(migration, "USING (auth.uid() = user_id)");
  assertStringIncludes(migration, "TO service_role");
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE VIEW public.zone_candidate_shadow_validation_summary",
  );
  assertStringIncludes(migration, "minimum_sample_ready");
});
