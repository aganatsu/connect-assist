import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const repoRoot = new URL("../../../", import.meta.url);
const functionsRoot = new URL("../", import.meta.url);

function repoSource(path: string): string {
  return Deno.readTextFileSync(new URL(path, repoRoot));
}

function functionSource(path: string): string {
  return Deno.readTextFileSync(new URL(path, functionsRoot));
}

Deno.test("candidate model runs after local and liquidity observations without replacing the legacy winner", () => {
  const unified = functionSource("_shared/unifiedZoneEngine.ts");
  const candidateModel = functionSource("_shared/zoneCandidateModel.ts");
  const liquidity = unified.indexOf("annotateZoneLiquidityObservations({");
  const model = unified.indexOf("rankZoneCandidateModels(");
  const productionWinner = unified.indexOf("const bestZone = multiTFResult.bestZone");
  assertStringIncludes(candidateModel, 'enforcement: "observe_only"');
  if (!(liquidity >= 0 && model > liquidity && productionWinner > model)) {
    throw new Error(
      "Candidate model must run after liquidity evidence and before the unchanged legacy winner is read",
    );
  }
});

Deno.test("scanner and evidence surfaces retain lifecycle and top-three model evidence", () => {
  const scanner = functionSource("bot-scanner/index.ts");
  const evidence = functionSource("_shared/zoneTimeframeEvidence.ts");
  const panel = repoSource("src/components/ZoneStoryPanel.tsx");
  assertStringIncludes(scanner, "candidateLifecycle:");
  assertStringIncludes(scanner, "candidateModel:");
  assertStringIncludes(evidence, "candidateLifecycle:");
  assertStringIncludes(evidence, "candidateModel:");
  assertStringIncludes(panel, "Candidate model");
  assertStringIncludes(panel, "tapped_and_held");
});

Deno.test("candidate model database evidence is immutable and constrained", () => {
  const migration = repoSource(
    "supabase/migrations/20260801230000_add_zone_candidate_lifecycle_model.sql",
  );
  assertStringIncludes(migration, "candidate_model_rank > 0");
  assertStringIncludes(migration, "'tapped_and_held'");
  assertStringIncludes(migration, "'partially_mitigated'");
  assertStringIncludes(migration, "protect_zone_candidate_model_evidence");
  assertStringIncludes(
    migration,
    "zone candidate model evidence is immutable",
  );
});
