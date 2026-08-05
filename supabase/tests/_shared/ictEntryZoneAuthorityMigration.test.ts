import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const sql = await Deno.readTextFile(
  new URL(
    "../../migrations/20260805150000_add_ict_entry_zone_authority_observations.sql",
    import.meta.url,
  ),
);

Deno.test("ICT entry zone evidence is observation-only and user scoped", () => {
  assertStringIncludes(sql, "ENABLE ROW LEVEL SECURITY");
  assertStringIncludes(sql, "auth.uid() = user_id");
  assertStringIncludes(sql, "'observe_only'::TEXT AS enforcement");
  assertStringIncludes(sql, "minimum_sample_ready");
  assertStringIncludes(sql, ">= 30");
});

Deno.test("ICT entry zone summary compares legacy and authority outcomes", () => {
  assertStringIncludes(sql, "legacy_candidate_id");
  assertStringIncludes(sql, "winners_retained");
  assertStringIncludes(sql, "losers_avoided");
  assertStringIncludes(sql, "missed_opportunities");
  assertStringIncludes(sql, "false_positives");
});
