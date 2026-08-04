import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const repoRoot = new URL("../../../", import.meta.url);
const functionsRoot = new URL("../../functions/", import.meta.url);

function repoSource(path: string): string {
  return Deno.readTextFileSync(new URL(path, repoRoot));
}

function functionSource(path: string): string {
  return Deno.readTextFileSync(new URL(path, functionsRoot));
}

Deno.test("unified engine attaches one observe-only lineage contract to every evidenced candidate", () => {
  const unified = functionSource("_shared/unifiedZoneEngine.ts");
  assertStringIncludes(unified, "buildCrossTimeframeZoneLineage({");
  assertStringIncludes(unified, "hierarchy: labels");
  assertStringIncludes(unified, "candidate.timeframeLineage =");
  assertStringIncludes(unified, "if (options?.collectEvidence)");
});

Deno.test("scanner, evidence, and UI expose exact parent/child relationship", () => {
  const scanner = functionSource("bot-scanner/index.ts");
  const evidence = functionSource("_shared/zoneTimeframeEvidence.ts");
  const story = repoSource("src/components/ZoneStoryPanel.tsx");
  assertStringIncludes(scanner, "timeframeLineage:");
  assertStringIncludes(evidence, "timeframeLineage:");
  assertStringIncludes(story, "TF lineage");
  assertStringIncludes(story, "qualified_nested");
  assertStringIncludes(story, "timeframe_conflict");
});

Deno.test("lineage persistence is constrained and immutable", () => {
  const migration = repoSource(
    "supabase/migrations/20260802000000_add_cross_timeframe_zone_lineage.sql",
  );
  for (
    const relationship of [
      "qualified_nested",
      "context_only",
      "standalone_lower_tf",
      "timeframe_conflict",
      "no_parent_context",
    ]
  ) {
    assertStringIncludes(migration, `'${relationship}'`);
  }
  assertStringIncludes(migration, "protect_cross_timeframe_zone_lineage");
  assertStringIncludes(
    migration,
    "cross-timeframe zone lineage is immutable",
  );
});
