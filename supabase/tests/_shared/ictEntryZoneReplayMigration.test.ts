import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const sql = await Deno.readTextFile(
  new URL(
    "../../migrations/20260805160000_add_ict_entry_zone_replay_evidence.sql",
    import.meta.url,
  ),
);

Deno.test("ICT entry-zone replay is source separated and activation ineligible", () => {
  assertStringIncludes(sql, "evidence_source");
  assertStringIncludes(sql, "retrospective_replay");
  assertStringIncludes(sql, "activation_eligible");
  assertStringIncludes(sql, "evidence_source = 'forward_observation'");
  assertStringIncludes(sql, "COUNT(DISTINCT replay_run_id)");
});
