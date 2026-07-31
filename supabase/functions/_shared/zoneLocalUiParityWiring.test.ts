import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../../", import.meta.url);

function source(relativePath: string): string {
  return Deno.readTextFileSync(new URL(relativePath, root));
}

const panel = source("src/components/ZoneStoryPanel.tsx");
const botView = source("src/pages/BotView.tsx");
const ictAnalysis = source("src/pages/IctAnalysis.tsx");
const rejectedSetups = source("src/pages/RejectedSetups.tsx");
const scanner = source("supabase/functions/bot-scanner/index.ts");

Deno.test("zone story explains canonical local evidence instead of presenting legacy proximity as fact", () => {
  assertStringIncludes(panel, "Local evidence");
  assertStringIncludes(panel, "outside · 0 local credit");
  assertStringIncludes(panel, "near · partial credit");
  assertStringIncludes(panel, "inside · full credit");
  assertStringIncludes(panel, "Legacy S/R");
  assertStringIncludes(panel, "Legacy HTF");
  assertStringIncludes(panel, "Legacy score");
  assertEquals(panel.includes("(S/R "), false);
});

Deno.test("all zone story surfaces receive ranking and effective policy evidence", () => {
  const botWiring = botView.match(
    /zoneLocalEnforcement=\{(?:sr|d)\.zoneLocalEnforcement\}/g,
  ) || [];
  assertEquals(botWiring.length, 3);
  assertStringIncludes(
    ictAnalysis,
    "zoneLocalEnforcement={d.zoneLocalEnforcement}",
  );
  assertStringIncludes(panel, "shadowRanking");
  assertStringIncludes(panel, "Candidate rank");
  assertStringIncludes(panel, "RANK DISAGREEMENT");
  assertStringIncludes(panel, "Certified max");
});

Deno.test("frontend evidence comes from the exact scanner decision payload", () => {
  assertStringIncludes(
    scanner,
    "multiTF.bestZone.zone.localConfluence ?? null",
  );
  assertStringIncludes(
    scanner,
    "multiTF.bestZone.zone.shadowRanking ?? null",
  );
  assertStringIncludes(
    scanner,
    "(detail as any).zoneLocalEnforcement = zoneLocalDecision",
  );
});

Deno.test("rejected setups exposes read-only historical zone ranking validation", () => {
  assertStringIncludes(
    rejectedSetups,
    '.from("zone_candidate_shadow_validation_summary")',
  );
  assertStringIncludes(rejectedSetups, "Zone-Local Candidate Validation");
  assertStringIncludes(rejectedSetups, "SOURCE SEPARATED");
  assertStringIncludes(rejectedSetups, "ACTIVATION EVIDENCE");
  assertStringIncludes(rejectedSetups, "RESEARCH ONLY");
  assertStringIncludes(rejectedSetups, "zone_local_confluence");
  assert(
    rejectedSetups.indexOf("permanently") >
      rejectedSetups.indexOf("Zone-Local Candidate Validation"),
  );
});
