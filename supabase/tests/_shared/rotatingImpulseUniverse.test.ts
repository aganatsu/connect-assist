import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { emptyRotationState, selectRotatingImpulseUniverse, updateRotatingImpulseState, classifyRotationOutcome } from "../../functions/_shared/rotatingImpulseUniverse.ts";

Deno.test("rotation selects eight never-scanned pairs first", () => {
  const universe = Array.from({ length: 40 }, (_, i) => `PAIR-${i + 1}`);
  const result = selectRotatingImpulseUniverse(universe, 8, emptyRotationState("2026-01-01T00:00:00Z"));
  assertEquals(result.selected, universe.slice(0, 8));
  assertEquals(result.pinned, []);
});

Deno.test("lifecycle-owned pairs leave discovery and all slots refill", () => {
  const universe = Array.from({ length: 12 }, (_, i) => `PAIR-${i + 1}`);
  let state = emptyRotationState("2026-01-01T00:00:00Z");
  state = updateRotatingImpulseState(state, universe.slice(0, 8).map((symbol, index) => ({ symbol, outcome: index < 3 ? "active_zone" as const : "no_impulse" as const })), "2026-01-01T01:00:00Z");
  const result = selectRotatingImpulseUniverse(universe, 8, state, "2026-01-01T02:00:00Z", universe.slice(0, 3));
  assertEquals(result.pinned, []);
  assertEquals(result.discovery, universe.slice(8, 12).concat(universe.slice(3, 7)));
});

Deno.test("data failures rotate but are not recorded as no impulse", () => {
  let state = emptyRotationState();
  state = updateRotatingImpulseState(state, [{ symbol: "EUR/USD", outcome: "data_error" }]);
  assertEquals(state.pairs["EUR/USD"].outcome, "data_error");
  assertEquals(state.pairs["EUR/USD"].consecutiveNoImpulse, 0);
  assertEquals(classifyRotationOutcome({ status: "skipped", reason: "Insufficient data" }), "data_error");
  assertEquals(classifyRotationOutcome({ impulseZone: { hasZone: true } }), "active_zone");
  assertEquals(classifyRotationOutcome({ status: "skipped_no_impulse_zone" }), "no_impulse");
});


Deno.test("temporary data failure preserves a previously pinned zone", () => {
  let state = emptyRotationState("2026-01-01T00:00:00Z");
  state = updateRotatingImpulseState(state, [{ symbol: "GBP/USD", outcome: "active_zone" }], "2026-01-01T01:00:00Z");
  state = updateRotatingImpulseState(state, [{ symbol: "GBP/USD", outcome: "data_error" }], "2026-01-01T02:00:00Z");
  assertEquals(state.pairs["GBP/USD"].outcome, "active_zone");
});


Deno.test("scanner separates discovery from lifecycle monitoring", async () => {
  const scanner = await Deno.readTextFile("./supabase/functions/bot-scanner/index.ts");
  for (const expected of [
    "const lifecycleOwnedSymbols = new Set<string>([",
    "lifecycleOwnedSymbols,",
    "monitorLane: \\"lightweight\\"",
    "if (nearZone) lifecycleDeepScanSymbols.add(setup.symbol)",
    "const rotationResults = discoveryScanUniverse.map",
  ]) assertEquals(scanner.includes(expected), true);
});
