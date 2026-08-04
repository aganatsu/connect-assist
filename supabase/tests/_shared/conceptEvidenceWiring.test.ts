import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../functions/", import.meta.url);

function source(relativePath: string): string {
  return Deno.readTextFileSync(new URL(relativePath, root));
}

Deno.test("concept evidence is wired symmetrically into live and backtest zone candidates", () => {
  const scanner = source("bot-scanner/index.ts");
  const backtest = source("backtest-engine/index.ts");
  for (const content of [scanner, backtest]) {
    assertStringIncludes(content, "evidenceContext: {");
    assertStringIncludes(
      content,
      "evidence: multiTF.bestZone.zone.poi.evidence",
    );
    assertStringIncludes(content, "zoneCandidates: multiTF.allZones.map");
  }
});

Deno.test("selected live zone evidence is frozen with candidate authority", () => {
  const scanner = source("bot-scanner/index.ts");
  const lifecycle = source("_shared/setupLifecycle.ts");
  assertStringIncludes(scanner, "selectedZoneConceptEvidence");
  assertStringIncludes(
    scanner,
    "conceptEvidence: selectedZoneConceptEvidence()",
  );
  assertStringIncludes(
    lifecycle,
    "conceptEvidence: input.conceptEvidence || []",
  );
});

Deno.test("zone-local policy remains non-enforcing in the evidence foundation slice", () => {
  const scanner = source("bot-scanner/index.ts");
  const backtest = source("backtest-engine/index.ts");
  assertEquals(scanner.includes("zoneLocalConfluence.ts"), false);
  assertEquals(backtest.includes("zoneLocalConfluence.ts"), false);
});
