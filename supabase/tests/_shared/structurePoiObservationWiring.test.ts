import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const backtest = await Deno.readTextFile(
  new URL("../../functions/backtest-engine/index.ts", import.meta.url),
);
const unified = await Deno.readTextFile(
  new URL("../../functions/_shared/unifiedZoneEngine.ts", import.meta.url),
);
const outcomeTracker = await Deno.readTextFile(
  new URL("../../functions/outcome-tracker/index.ts", import.meta.url),
);
const observationStore = await Deno.readTextFile(
  new URL("../../functions/_shared/ictEntryZoneObservationStore.ts", import.meta.url),
);

Deno.test("live and backtest retain the shared structure POI observation", () => {
  assertStringIncludes(
    unified,
    "const structurePoiObservation = buildStructurePoiObservation",
  );
  assertStringIncludes(
    scanner,
    "unifiedResult.structurePoiObservation ?? null",
  );
  assertStringIncludes(
    backtest,
    "unifiedResult.structurePoiObservation ?? null",
  );
});

Deno.test("structure POI observation cannot authorize a trade", () => {
  assertStringIncludes(unified, 'mode: "structure_poi"');
  assertStringIncludes(unified, "return selectICTEntryZone({");
  assertStringIncludes(
    scanner,
    "structurePoiObservation:\n            unifiedResult.structurePoiObservation ?? null",
  );
});

Deno.test("live scanner persists forward structure POI disagreements without routing them to execution", () => {
  assertStringIncludes(scanner, 'setupFamily: "structure_poi"');
  assertStringIncludes(scanner, "structurePoiForwardPlan");
  assertStringIncludes(scanner, "currentImpulseDecision");
  assertStringIncludes(scanner, "candleSnapshotRefs");
  assertStringIncludes(scanner, "affectsAuthorization: false");
  assertStringIncludes(outcomeTracker, '.eq("comparison_status", "comparable")');
  assertStringIncludes(
    observationStore,
    '"user_id,bot_id,setup_family,opportunity_key"',
  );
});
