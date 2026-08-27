import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { emptyRotationState, measureLifecycleZoneProximity, selectRotatingImpulseUniverse, updateRotatingImpulseState, classifyRotationOutcome } from "../../functions/_shared/rotatingImpulseUniverse.ts";

Deno.test("lifecycle proximity uses the wider of zone width and pip buffer", () => {
  assertEquals(measureLifecycleZoneProximity({
    currentPrice: 103, zoneLow: 100, zoneHigh: 101, pipSize: 0.1,
  }), { distance: 2, nearBuffer: 2, nearZone: true });
  assertEquals(measureLifecycleZoneProximity({
    currentPrice: 103.01, zoneLow: 100, zoneHigh: 101, pipSize: 0.1,
  })?.nearZone, false);
});

Deno.test("lifecycle proximity handles reversed bounds and rejects invalid values", () => {
  assertEquals(measureLifecycleZoneProximity({
    currentPrice: 100, zoneLow: 101, zoneHigh: 99, pipSize: 0.01,
  }), { distance: 0, nearBuffer: 4, nearZone: true });
  assertEquals(measureLifecycleZoneProximity({
    currentPrice: Number.NaN, zoneLow: 99, zoneHigh: 101, pipSize: 0.01,
  }), null);
});

Deno.test("rotation selects eight never-scanned pairs first", () => {
  const universe = Array.from({ length: 40 }, (_, i) => `PAIR-${i + 1}`);
  const result = selectRotatingImpulseUniverse(universe, 8, emptyRotationState("2026-01-01T00:00:00Z"));
  assertEquals(result.selected, universe.slice(0, 8));
  assertEquals(result.pinned, []);
  assertEquals(result.priority, undefined);
});

Deno.test("session-aware rotation reserves style-weighted priority and fairness slots", () => {
  const universe = [
    "USD/CAD",
    "SPX500",
    "AUD/NZD",
    "AUD/USD",
    "AUD/JPY",
    "NZD/JPY",
    "USD/JPY",
    "BTC/USD",
    "EUR/USD",
    "US Oil",
  ];
  const result = selectRotatingImpulseUniverse(
    universe,
    8,
    emptyRotationState("2026-08-25T00:00:00Z"),
    "2026-08-25T21:00:00Z",
    [],
    {
      style: "scalper",
      session: {
        name: "Asian",
        filterKey: "asian",
        isKillZone: false,
      },
      atMs: Date.parse("2026-08-26T01:00:00Z"),
      focusSymbols: [],
    },
  );

  assertEquals(result.priority?.preferredCapacity, 6);
  assertEquals(result.priority?.preferredSelected, 6);
  assertEquals(result.priority?.fairnessSelected, 2);
  assertEquals(result.selected.slice(0, 6), [
    "AUD/NZD",
    "AUD/USD",
    "AUD/JPY",
    "NZD/JPY",
    "USD/JPY",
    "BTC/USD",
  ]);
  // Fairness is deliberately retained: session preference may reorder discovery,
  // but it must not become a hidden hard gate for lower-affinity instruments.
  assertEquals(result.selected.slice(6), ["USD/CAD", "SPX500"]);
  assertEquals(
    result.priority?.selected.map((candidate) => candidate.reason),
    [
      "primary_session",
      "session_affinity",
      "session_affinity",
      "session_affinity",
      "session_affinity",
      "session_affinity",
      "fairness",
      "fairness",
    ],
  );
});

Deno.test("session-aware rotation is style-aware and Gameplan focus uses the same selector", () => {
  const universe = [
    "USD/CAD",
    "SPX500",
    "AUD/NZD",
    "AUD/USD",
    "AUD/JPY",
    "NZD/JPY",
    "USD/JPY",
    "BTC/USD",
    "EUR/USD",
    "US Oil",
  ];
  const common = {
    session: {
      name: "Asian" as const,
      filterKey: "asian" as const,
      isKillZone: false,
    },
    atMs: Date.parse("2026-08-26T01:00:00Z"),
    // Lifecycle ownership must outrank Gameplan focus; AUD/NZD is excluded
    // below even though the plan also names it.
    focusSymbols: ["AUD/NZD", "EUR/USD"],
  };
  const state = emptyRotationState("2026-08-25T00:00:00Z");
  const scalper = selectRotatingImpulseUniverse(
    universe,
    8,
    state,
    "2026-08-25T21:00:00Z",
    ["AUD/NZD"],
    { ...common, style: "scalper" },
  );
  const dayTrader = selectRotatingImpulseUniverse(
    universe,
    8,
    state,
    "2026-08-25T21:00:00Z",
    ["AUD/NZD"],
    { ...common, style: "day_trader" },
  );
  const swingTrader = selectRotatingImpulseUniverse(
    universe,
    8,
    state,
    "2026-08-25T21:00:00Z",
    ["AUD/NZD"],
    { ...common, style: "swing_trader" },
  );

  assertEquals(scalper.priority?.preferredCapacity, 6);
  assertEquals(dayTrader.priority?.preferredCapacity, 4);
  assertEquals(swingTrader.priority?.preferredCapacity, 2);
  assertEquals(dayTrader.priority?.fairnessSelected, 4);
  assertEquals(swingTrader.priority?.fairnessSelected, 6);
  assertEquals(scalper.selected.includes("AUD/NZD"), false);
  assertEquals(scalper.selected[0], "EUR/USD");
  assertEquals(scalper.priority?.selected[0].reason, "gameplan_focus");
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
    'monitorLane: "lightweight"',
    "if (nearZone) lifecycleDeepScanSymbols.add(setup.symbol)",
    "const rotationResults = discoveryScanUniverse.map",
  ]) assertEquals(scanner.includes(expected), true);
  for (const pendingWiring of [
    "const pendingProximity = measureLifecycleZoneProximity({",
    "if (pendingProximity?.nearZone) {",
    "lifecycleDeepScanSymbols.add(pending.symbol);",
  ]) assertEquals(scanner.includes(pendingWiring), true);
});

Deno.test("scanner records session-aware rotation as zero-call observation only", async () => {
  const scanner = await Deno.readTextFile("./supabase/functions/bot-scanner/index.ts");
  const selector = await Deno.readTextFile(
    "./supabase/functions/_shared/rotatingImpulseUniverse.ts",
  );
  for (const expected of [
    "SESSION_AWARE_ROTATION_OBSERVATION_CONTRACT",
    'mode: "observe"',
    "affectsExecution: false",
    "additionalMarketDataCalls: 0",
    "restrictedAssetSessionGateOpen,",
    "offHoursImplicitlyAllowed,",
    "if (!pairAssetProfile.skipSessionGate && !restrictedAssetSessionGateOpen)",
    "lifecycleExcludedSymbols: Array.from(lifecycleOwnedSymbols)",
    'status: "unavailable"',
    "Session-aware rotation observation unavailable (non-fatal)",
    "sessionObservation: sessionRotationObservation",
    "const proposedRotationSelection = selectRotatingImpulseUniverse(",
    "const gamePlanFocusSymbols = gamePlanAffectsExecution",
    "focusSymbols: gamePlanFocusSymbols",
  ]) assertEquals(scanner.includes(expected), true, `missing scanner wiring: ${expected}`);
  assertEquals(
    selector.includes(
      '"session-aware-rotation-observation.v1" as const',
    ),
    true,
  );

  // Production discovery and state updates must remain owned by the legacy
  // selection. The proposed selection may be compared and displayed only.
  assertEquals(
    scanner.includes("discoveryScanUniverse = rotationSelection.selected;"),
    true,
  );
  assertEquals(
    scanner.includes("discoveryScanUniverse = proposedRotationSelection.selected;"),
    false,
  );
  assertEquals(
    scanner.includes("scanUniverse = proposedRotationSelection.selected;"),
    false,
  );
  for (const forbidden of [
    "fetchCandles",
    "fetchLivePrice",
    "cachedFetch",
    "TwelveData",
    "twelvedata",
  ]) {
    assertEquals(
      selector.includes(forbidden),
      false,
      `rotation selector must remain market-data free: ${forbidden}`,
    );
  }
});
