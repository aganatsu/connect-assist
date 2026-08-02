import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../../", import.meta.url);
const source = async (path: string) =>
  await Deno.readTextFile(new URL(path, root));

Deno.test("Phase 7 UI exposes every Cross-Timeframe Authority control", async () => {
  const ui = await source("src/components/config/EnterTab.tsx");
  for (
    const label of [
      "Cross-Timeframe Authority Mode",
      "Require Nested Impulse",
      "Allow Standalone Lower-TF Setup",
      "Maximum Zone Separation",
      "Minimum Parent-Child Overlap",
      "Sweep-Origin Requirement",
      "Retest Quality",
      "Maximum Candidates Per Timeframe",
      "Certified max",
      "Effective",
    ]
  ) {
    assertStringIncludes(ui, label);
  }
});

Deno.test("Phase 7 scanner resolves authority without enforcing it", async () => {
  const scanner = await source("supabase/functions/bot-scanner/index.ts");
  assertStringIncludes(scanner, "resolveCrossTimeframeAuthority");
  assertStringIncludes(scanner, "crossTimeframePolicy:");
  assertStringIncludes(scanner, "requested=${crossTimeframeAuthority.requestedMode}");
  assertStringIncludes(scanner, "effective=${crossTimeframeAuthority.effectiveMode}");
});

Deno.test("Phase 7 audit view keeps availability and runtime modes separate", async () => {
  const migration = await source(
    "supabase/migrations/20260802030000_add_cross_timeframe_authority_controls.sql",
  );
  assertStringIncludes(
    migration,
    "cross_timeframe_authority_runtime_status",
  );
  assertStringIncludes(migration, "AS requested_mode");
  assertStringIncludes(migration, "AS certified_maximum");
  assertStringIncludes(migration, "AS effective_mode");
  assertStringIncludes(migration, "true AS available");
});
