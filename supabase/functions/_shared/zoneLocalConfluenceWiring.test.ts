import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../", import.meta.url);

function source(relativePath: string): string {
  return Deno.readTextFileSync(new URL(relativePath, root));
}

Deno.test("zone-local observations are persisted symmetrically in live and backtest candidates", () => {
  const scanner = source("bot-scanner/index.ts");
  const backtest = source("backtest-engine/index.ts");
  for (const content of [scanner, backtest]) {
    assertStringIncludes(
      content,
      "multiTF.bestZone.zone.localConfluence ?? null",
    );
    assertStringIncludes(
      content,
      "localConfluence: candidate.localConfluence ?? null",
    );
  }
});

Deno.test("selected zone-local observations are frozen with live setup authority", () => {
  const scanner = source("bot-scanner/index.ts");
  const lifecycle = source("_shared/setupLifecycle.ts");
  assertStringIncludes(scanner, "selectedZoneLocalConfluence");
  assertStringIncludes(
    scanner,
    "zoneLocalConfluence: selectedZoneLocalConfluence()",
  );
  assertStringIncludes(
    lifecycle,
    "zoneLocalConfluence: input.zoneLocalConfluence || null",
  );
});

Deno.test("zone-local policy remains observe-only and cannot add score", () => {
  const localPolicy = source("_shared/zoneLocalConfluence.ts");
  assertStringIncludes(localPolicy, 'enforcement: "observe_only"');
  assertStringIncludes(localPolicy, "scoreContribution: 0");
  assertEquals(localPolicy.includes('enforcement: "hard"'), false);
});
