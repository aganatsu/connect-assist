import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../../", import.meta.url);
const source = async (path: string) =>
  await Deno.readTextFile(new URL(path, root));

Deno.test("Phase 7 UI exposes every HTF-to-LTF alignment control", async () => {
  const ui = await source("src/components/config/EnterTab.tsx");
  for (
    const label of [
      "HTF-to-LTF Alignment Mode",
      "Require LTF POI Inside HTF Impulse",
      "Allow LTF Setup Without HTF POI",
      "Maximum HTF/LTF POI Distance",
      "Minimum HTF/LTF POI Overlap",
      "Require BSL/SSL Sweep Before Displacement",
      "POI Mitigation State",
      "Maximum Candidates Per Timeframe",
      "RuntimeModeStatus",
      "runtimeAuthorityModes?.crossTimeframe",
    ]
  ) {
    assertStringIncludes(ui, label);
  }
});

Deno.test("Phase 7 scanner applies the saved authority mode directly", async () => {
  const scanner = await source("supabase/functions/bot-scanner/index.ts");
  assertStringIncludes(scanner, "resolveCrossTimeframeAuthority");
  assertStringIncludes(scanner, "crossTimeframePolicy:");
  assertStringIncludes(
    scanner,
    "requested=${crossTimeframeAuthority.requestedMode}",
  );
  assertStringIncludes(
    scanner,
    "effective=${crossTimeframeAuthority.effectiveMode}",
  );
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
