import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../functions/", import.meta.url);

function source(relativePath: string): string {
  return Deno.readTextFileSync(new URL(relativePath, root));
}

Deno.test("scanner persists only observe-only zone rank disagreements", () => {
  const scanner = source("bot-scanner/index.ts");
  const store = source("_shared/zoneShadowObservationStore.ts");
  assertStringIncludes(scanner, "persistZoneShadowObservations(supabase");
  assertStringIncludes(
    store,
    '.from("zone_candidate_shadow_observations")',
  );
  assertStringIncludes(store, "legacyWinner");
  assertStringIncludes(store, "shadowWinner");
  assertStringIncludes(store, "return [];");
  assertEquals(store.includes("pending_orders"), false);
  assertEquals(store.includes("paper_positions"), false);
});

Deno.test("outcome tracker waits for the complete 24-hour window", () => {
  const tracker = source("outcome-tracker/index.ts");
  assertStringIncludes(
    tracker,
    "SHADOW_MIN_AGE_MS = OUTCOME_WINDOW_HOURS",
  );
  assertStringIncludes(
    tracker,
    '.from("zone_candidate_shadow_observations")',
  );
  assertStringIncludes(tracker, 'interval: "1h"');
  assertStringIncludes(
    tracker,
    "outcome_status: status",
  );
});

Deno.test("validation collection does not alter scanner authorization", () => {
  const scanner = source("bot-scanner/index.ts");
  const persistIndex = scanner.indexOf(
    "persistZoneShadowObservations(supabase",
  );
  const gateIndex = scanner.indexOf(
    "} else if (pairConfig.requireUnifiedZone)",
    persistIndex,
  );
  assertEquals(persistIndex >= 0, true);
  assertEquals(gateIndex > persistIndex, true);
});
