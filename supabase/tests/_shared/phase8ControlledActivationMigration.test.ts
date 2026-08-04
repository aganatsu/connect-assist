import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const sql = await Deno.readTextFile(
  "./supabase/migrations/20260730230000_add_strategy_activation_registry.sql",
);

Deno.test("Phase 8A creates owner-readable activation and audit tables", () => {
  assertStringIncludes(
    sql,
    "CREATE TABLE IF NOT EXISTS public.strategy_activation_registry",
  );
  assertStringIncludes(
    sql,
    "CREATE TABLE IF NOT EXISTS public.strategy_activation_events",
  );
  assertStringIncludes(sql, "ENABLE ROW LEVEL SECURITY");
  assertStringIncludes(sql, "auth.uid() = user_id");
});

Deno.test("Phase 8A separates decision authority from runtime scope", () => {
  assertStringIncludes(sql, "'shadow'");
  assertStringIncludes(sql, "'log_only'");
  assertStringIncludes(sql, "'soft_adjustment'");
  assertStringIncludes(sql, "'hard_block'");
  assertStringIncludes(sql, "'observation'");
  assertStringIncludes(sql, "'paper'");
  assertStringIncludes(sql, "'live_canary'");
  assertStringIncludes(sql, "'live'");
});

Deno.test("Phase 8A requires evidence and prevents stage skipping", () => {
  assertStringIncludes(
    sql,
    "Forward activation must advance exactly one stage or one runtime scope",
  );
  assertStringIncludes(sql, "v_resolved < 30");
  assertStringIncludes(sql, "v_changed < 10");
  assertStringIncludes(sql, "v_coverage < 50");
  assertStringIncludes(sql, "v_beneficial_rate < 60");
  assertStringIncludes(sql, "walkForwardConsistent");
  assertStringIncludes(sql, "paperForwardPassed");
  assertStringIncludes(sql, "liveCanaryPassed");
});

Deno.test("Phase 8A has an atomic safe rollback and optimistic revision guard", () => {
  assertStringIncludes(
    sql,
    "Rollback must return directly to Shadow / Observation",
  );
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "Activation revision conflict");
  assertStringIncludes(sql, "revision = revision + 1");
});

Deno.test("Phase 8A remains non-executable and service-role controlled", () => {
  assertStringIncludes(sql, "runtime_enforced BOOLEAN NOT NULL DEFAULT false");
  assertStringIncludes(sql, "runtime_enforced = false");
  assertStringIncludes(
    sql,
    "REVOKE ALL ON FUNCTION public.transition_strategy_activation",
  );
  assertStringIncludes(sql, "TO service_role");
});
