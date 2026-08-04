import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../functions/", import.meta.url);

function source(relativePath: string): string {
  return Deno.readTextFileSync(new URL(relativePath, root));
}

Deno.test("shadow zone ranking is attached after local liquidity observations", () => {
  const unified = source("_shared/unifiedZoneEngine.ts");
  const liquidityIndex = unified.indexOf(
    "annotateZoneLiquidityObservations({",
  );
  const shadowIndex = unified.indexOf("rankZoneCandidatesShadow(");
  assertEquals(liquidityIndex >= 0, true);
  assertEquals(shadowIndex > liquidityIndex, true);
});

Deno.test("shadow ranking is persisted symmetrically in live and backtest snapshots", () => {
  const scanner = source("bot-scanner/index.ts");
  const backtest = source("backtest-engine/index.ts");
  for (const content of [scanner, backtest]) {
    assertStringIncludes(
      content,
      "multiTF.bestZone.zone.shadowRanking ?? null",
    );
    assertStringIncludes(
      content,
      "shadowRanking: candidate.shadowRanking ?? null",
    );
  }
});

Deno.test("selected shadow rank is frozen but remains observe-only", () => {
  const scanner = source("bot-scanner/index.ts");
  const lifecycle = source("_shared/setupLifecycle.ts");
  const ranking = source("_shared/zoneCandidateShadowRanking.ts");
  assertStringIncludes(scanner, "selectedZoneShadowRanking");
  assertStringIncludes(
    scanner,
    "zoneCandidateShadowRanking: selectedZoneShadowRanking()",
  );
  assertStringIncludes(
    lifecycle,
    "input.zoneCandidateShadowRanking || null",
  );
  assertStringIncludes(ranking, 'enforcement: "observe_only"');
  assertEquals(ranking.includes('enforcement: "hard"'), false);
});
