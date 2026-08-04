import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scannerUrl = new URL("../../functions/bot-scanner/index.ts", import.meta.url);
const fastScannerUrl = new URL(
  "../../functions/zone-confirmation-scanner/index.ts",
  import.meta.url,
);
const refreshUrl = new URL("../../functions/game-plan-refresh/index.ts", import.meta.url);
const migrationUrl = new URL(
  "../../migrations/20260729100000_create_active_game_plans.sql",
  import.meta.url,
);

Deno.test("automatic scanner reads and activates dedicated Gameplan versions", async () => {
  const source = await Deno.readTextFile(scannerUrl.pathname);
  assertStringIncludes(source, "loadActiveGamePlan(");
  assertStringIncludes(source, "persistActiveGamePlan(");
  assertStringIncludes(source, "applyGamePlanValidityWindow(");
  assertStringIncludes(source, 'source: "automatic_scan"');
  assertEquals(
    source.includes('.contains("details_json", { type: "game_plan" })'),
    false,
  );
});

Deno.test("manual refresh uses the same persistence and enrichment contract", async () => {
  const source = await Deno.readTextFile(refreshUrl.pathname);
  assertStringIncludes(source, "persistActiveGamePlan(");
  assertStringIncludes(source, "enrichGamePlanWithDirectionalNews(");
  assertStringIncludes(source, "applyGamePlanValidityWindow(");
  assertStringIncludes(source, 'source: "manual_refresh"');
});

Deno.test("fast confirmation reads the dedicated active version", async () => {
  const source = await Deno.readTextFile(fastScannerUrl.pathname);
  assertStringIncludes(source, "loadActiveGamePlan(");
  assertEquals(
    source.includes('.contains("details_json", { type: "game_plan" })'),
    false,
  );
});

Deno.test("migration provides immutable version fields and atomic activation", async () => {
  const source = await Deno.readTextFile(migrationUrl.pathname);
  for (
    const expected of [
      "CREATE TABLE IF NOT EXISTS public.active_game_plans",
      "plan_version UUID NOT NULL",
      "v2_conviction JSONB",
      "invalidation_conditions JSONB",
      "source_candle_timestamps JSONB",
      "CREATE OR REPLACE FUNCTION public.activate_game_plan_version",
      "WHERE is_active",
      "GRANT EXECUTE ON FUNCTION public.activate_game_plan_version",
    ]
  ) {
    assertStringIncludes(source, expected);
  }
});
