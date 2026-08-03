import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  "./supabase/functions/bot-scanner/index.ts",
);
const contract = await Deno.readTextFile(
  "./supabase/functions/_shared/streamlinedTradeDecision.ts",
);
const observationAdapter = await Deno.readTextFile(
  "./supabase/functions/_shared/streamlinedTradeDecisionObservation.ts",
);

Deno.test("scanner attaches the streamlined summary as observation-only detail", () => {
  assertStringIncludes(
    scanner,
    "(detail as any).streamlinedTradeDecision =",
  );
  assertStringIncludes(
    scanner,
    "buildPhase1StreamlinedTradeDecisionObservation({",
  );
  assertStringIncludes(
    observationAdapter,
    "phase2_evidence_mapping_pending",
  );
  assertStringIncludes(
    observationAdapter,
    "// Candidate discovery predates final runtime authorization.",
  );
});

Deno.test("streamlined observation cannot participate in scanner authorization", () => {
  assertStringIncludes(contract, "observationOnly: true");
  assertStringIncludes(contract, "affectsAuthorization: false");
  assertEquals(
    (scanner.match(/buildPhase1StreamlinedTradeDecisionObservation\(/g) || [])
      .length,
    1,
  );
  assert(
    !scanner.includes("streamlinedTradeDecision.authorized"),
    "Observation summary must not authorize a trade",
  );
  assert(
    !scanner.includes("streamlinedTradeDecision.affectsAuthorization"),
    "Scanner must not branch on the observation marker",
  );
});

Deno.test("Phase 1 preserves the protected Zone Story evidence reference", () => {
  assertStringIncludes(scanner, '"zone_story_and_market_location"');
  assertStringIncludes(
    observationAdapter,
    '"phase2_evidence_mapping_pending"',
  );
});
