import {
  assert,
  assertMatch,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  new URL("../functions/zone-confirmation-scanner/index.ts", import.meta.url),
);

Deno.test("nested confirmation replay processes only completed candles unseen by the persisted cursor", () => {
  assertMatch(
    scanner,
    /const confirmationReplayCursor = String\([\s\S]*last_confirmation_checked_at[\s\S]*zone_touch_time/,
  );
  assertMatch(
    scanner,
    /completedCandlesSinceCursor\(\{[\s\S]*candles: candles5m[\s\S]*observedAfter: confirmationReplayCursor[\s\S]*interval: lifecycleMonitoringTimeframe/,
  );
  assertStringIncludes(scanner, "loadImpulseEntryLifecycle");

  const replay = scanner.indexOf("completedCandlesSinceCursor({");
  const cursorWrite = scanner.indexOf(
    "last_confirmation_checked_at: persistedConfirmationCursor",
  );
  assert(replay >= 0 && cursorWrite > replay);
  assertMatch(
    scanner,
    /nextConfirmationReplayCursor = cursorAfterLatestTouchCandle\([\s\S]*processedNestedCandles[\s\S]*lifecycleMonitoringTimeframe[\s\S]*confirmationReplayCursor/,
  );
  assertMatch(
    scanner,
    /const persistedConfirmationCursor = nestedPoiEnforced[\s\S]*\? nextConfirmationReplayCursor[\s\S]*: confirmationCheckStartedAt/,
  );
});

Deno.test("nested confirmation uses the frozen runtime-entry monitoring timeframe", () => {
  assertMatch(
    scanner,
    /const lifecycleMonitoringTimeframe = nestedPoiEnforced[\s\S]*frozenNestedPoiEntry!\.monitoringTimeframe[\s\S]*: confirmationTimeframe/,
  );
  assertMatch(
    scanner,
    /fetchCandles\([\s\S]*pending\.symbol,[\s\S]*lifecycleMonitoringTimeframe/,
  );
  assertMatch(
    scanner,
    /recordConfirmationMatrixObservation\([\s\S]*timeframe: lifecycleMonitoringTimeframe/,
  );
  assert(
    !scanner.includes("interval: frozenNestedPoiEntry!.selected!.timeframe"),
  );
});

Deno.test("nested POI touch evidence is not mislabeled as close-based confirmation", () => {
  const signalStart = scanner.indexOf('type: "nested_poi_trigger"');
  const authorityStart = scanner.indexOf('source: "nested_poi_entry"');
  assert(signalStart >= 0 && authorityStart > signalStart);
  assertStringIncludes(
    scanner.slice(signalStart, authorityStart),
    "closeBased: false",
  );
  assertStringIncludes(
    scanner.slice(authorityStart, authorityStart + 1_500),
    "closeBased: false",
  );
});

Deno.test("awaiting nested route with no frozen selected plan is terminally invalidated", () => {
  const guardStart = scanner.indexOf(
    "const frozenNestedPlanState =",
  );
  const activationStart = scanner.indexOf(
    "const nestedPoiActivation =",
    guardStart,
  );
  assert(guardStart >= 0 && activationStart > guardStart);
  const guard = scanner.slice(guardStart, activationStart);
  assertStringIncludes(guard, "resolvePendingNestedPoiEntryPlanState(pending)");
  assertStringIncludes(guard, "if (!frozenNestedPlanState.valid)");
  assertStringIncludes(guard, 'status: "invalidated"');
  assertStringIncludes(guard, "cancel_reason: reason");
  assertStringIncludes(guard, '.eq("status", "awaiting_confirmation")');
  assertStringIncludes(guard, "continue;");
});

Deno.test("confirmation scanner derives execution and mismatch from the frozen route", () => {
  assertMatch(
    scanner,
    /resolveFrozenNestedPoiMarketRoute\(\{[\s\S]*route: frozenNestedPoiEntry\.route[\s\S]*nestedPoiActivation\?\.runtimeTargetMismatch === true/,
  );
  assertStringIncludes(
    scanner,
    "const nestedPoiEnforced = nestedPoiActivation?.enforced === true",
  );
  assert(!scanner.includes('frozenNestedPoiEntry?.mode === "enforce_paper"'));
});
