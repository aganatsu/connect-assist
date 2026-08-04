import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const sql = await Deno.readTextFile(
  "./supabase/migrations/20260731160000_enable_zone_local_controlled_enforcement.sql",
);

Deno.test("runtime activation cannot promote an unproven registry row", () => {
  assertStringIncludes(
    sql,
    "authority_stage NOT IN ('soft_adjustment', 'hard_block')",
  );
  assertStringIncludes(
    sql,
    "runtime_scope NOT IN ('paper', 'live_canary', 'live')",
  );
  assertStringIncludes(sql, "evidence_window_start IS NULL");
  assertStringIncludes(sql, "evidence_snapshot = '{}'::JSONB");
});

Deno.test("runtime activation is service-only and revision guarded", () => {
  assertStringIncludes(sql, "Activation revision conflict");
  assertStringIncludes(sql, "REVOKE ALL ON FUNCTION");
  assertStringIncludes(sql, "TO service_role");
  assertStringIncludes(
    sql,
    "Never promotes authority stage or runtime scope",
  );
});
