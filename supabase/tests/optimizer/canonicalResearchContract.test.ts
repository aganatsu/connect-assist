import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getFullParameterSpace, paramsToConfig } from "../../functions/optimizer/lib/parameterSpace.ts";

const read = (path: string) => Deno.readTextFileSync(new URL(path, import.meta.url));

Deno.test("optimizer is research-only and cannot auto-apply", () => {
  const source = read("../../functions/optimizer/index.ts");
  assertEquals(source.includes("autoApplyResult"), false);
  assertStringIncludes(source, 'const applyOutcome = recommendationQualified ? "recommendation_ready"');
  assertStringIncludes(source, "auto_applied: false");
  assertStringIncludes(source, "researchOnly: true");
});

Deno.test("optimizer freezes the complete canonical runtime snapshot", () => {
  const source = read("../../functions/optimizer/index.ts");
  assertStringIncludes(source, "mapNestedToFlat");
  assertStringIncludes(source, "paramsToConfig(candidateParams, state.runtimeSnapshot)");
  const base = { singleOwnershipMode: "enforce", canonicalScannerMode: "enforce", confirmationMethod: "choch" };
  const candidate = paramsToConfig({ structureLookback: 64 }, base);
  assertEquals(candidate.singleOwnershipMode, "enforce");
  assertEquals(candidate.canonicalScannerMode, "enforce");
  assertEquals(candidate.confirmationMethod, "choch");
});

Deno.test("research space excludes legacy scores and authority switches", () => {
  const names = getFullParameterSpace().map(spec => spec.name);
  for (const forbidden of ["minConfluence", "minTier1Factors", "riskPerTrade", "singleOwnershipMode", "canonicalScannerMode", "dealingRangeMode"]) {
    assertEquals(names.includes(forbidden), false, `${forbidden} must stay frozen`);
  }
  assert(names.length <= 24, "search space must remain statistically bounded");
});

Deno.test("legacy weekly optimizer schedule is disabled", () => {
  const migration = read("../../migrations/20260809210000_disable_legacy_optimizer_cron.sql");
  assertStringIncludes(migration, "cron.unschedule('optimizer-weekly-run')");
});
