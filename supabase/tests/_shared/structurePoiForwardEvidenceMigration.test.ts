import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(new URL(
  "../../migrations/20260830223000_add_structure_poi_forward_evidence.sql",
  import.meta.url,
));

Deno.test("structure POI evidence migration separates setup families and non-comparable rows", () => {
  assertStringIncludes(migration, "ADD COLUMN IF NOT EXISTS setup_family");
  assertStringIncludes(migration, "ADD COLUMN IF NOT EXISTS opportunity_key");
  assertStringIncludes(migration, "ADD COLUMN IF NOT EXISTS comparison_status");
  assertStringIncludes(migration, "setup_family <> 'structure_poi' OR opportunity_key IS NOT NULL");
  assertStringIncludes(migration, "DROP NOT NULL");
  assertStringIncludes(migration, "UNIQUE (user_id, bot_id, scan_cycle_id, symbol, setup_family)");
  assertStringIncludes(migration, "UNIQUE (user_id, bot_id, setup_family, opportunity_key)");
  assertStringIncludes(migration, "GROUP BY user_id, bot_id, trading_style, symbol, setup_family");
  assertStringIncludes(migration, "outcome_status = 'unavailable'");
});
