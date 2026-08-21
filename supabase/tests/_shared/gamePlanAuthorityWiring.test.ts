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
const functionsRoot = new URL("../../functions/", import.meta.url);

function collectFunctionSources(dir: URL, sources: URL[] = []): URL[] {
  for (const entry of Deno.readDirSync(dir)) {
    if (
      entry.isDirectory &&
      (entry.name === "_shared" || entry.name === "backtest-engine")
    ) {
      continue;
    }
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) collectFunctionSources(child, sources);
    else if (entry.name.endsWith(".ts")) sources.push(child);
  }
  return sources;
}

Deno.test("automatic scanner consumes but never generates Gameplan versions", async () => {
  const source = await Deno.readTextFile(scannerUrl.pathname);
  assertStringIncludes(source, "loadActiveGamePlan(");
  assertStringIncludes(source, "Game Plan consumer validation failed");
  for (
    const forbiddenCall of [
      "generateInstrumentGamePlan(",
      "buildSessionGamePlan(",
      "fetchNewsForGamePlan(",
      "persistActiveGamePlan(",
      "applyGamePlanValidityWindow(",
    ]
  ) {
    assertEquals(
      source.includes(forbiddenCall),
      false,
      `bot-scanner must not call ${forbiddenCall}`,
    );
  }
  assertEquals(source.includes('source: "automatic_scan"'), false);
  assertEquals(
    source.includes('.contains("details_json", { type: "game_plan" })'),
    false,
  );
});

Deno.test("game-plan-refresh is the sole live Gameplan generator", () => {
  const callSites = collectFunctionSources(functionsRoot)
    .filter((file) =>
      Deno.readTextFileSync(file).includes("generateInstrumentGamePlan(")
    )
    .map((file) => file.pathname.split("/functions/")[1])
    .sort();

  assertEquals(callSites, ["game-plan-refresh/index.ts"]);
});

Deno.test("Gameplan observation mode cannot change scanner execution", async () => {
  const scannerSource = await Deno.readTextFile(scannerUrl.pathname);
  const fastScannerSource = await Deno.readTextFile(fastScannerUrl.pathname);

  assertStringIncludes(
    scannerSource,
    "const gamePlanAffectsExecution =\n    gamePlanEnabled && gpEnforcementMode !== \"off\";",
  );
  assertStringIncludes(
    scannerSource,
    "if (gamePlanAffectsExecution && activeGamePlan?.focusPairs?.length)",
  );
  assertStringIncludes(
    scannerSource,
    "const newsConflictEnforced =",
  );
  assertStringIncludes(
    scannerSource,
    "gamePlanAffectsExecution && newsAlignment.conflicting;",
  );
  assertStringIncludes(
    fastScannerSource,
    "config.gpEnforcementMode !== \"off\" &&",
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
