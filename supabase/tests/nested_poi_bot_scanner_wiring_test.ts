import {
  assert,
  assertMatch,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  new URL("../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("nested POI observe mode records the plan without routing executable geometry", () => {
  assertMatch(
    scanner,
    /const routedNestedPoiEntry = effectiveNestedPoiActivation\.enforced[\s\S]*\? observedNestedPoiEntry[\s\S]*: null/,
  );
  assertStringIncludes(scanner, "nestedPoiEntry: observedNestedPoiEntry");
  assertMatch(
    scanner,
    /entry_zone_low: routedNestedPoiEntry\?\.outerZone\.low \?\?[\s\S]*limitEntry\.zoneLow/,
  );
  assertMatch(
    scanner,
    /entry_zone_high: routedNestedPoiEntry\?\.outerZone\.high \?\?[\s\S]*limitEntry\.zoneHigh/,
  );
});

Deno.test("pre-arm observe mode keeps nested POI data observational", () => {
  assertMatch(
    scanner,
    /const routedPreArmNestedPlan = effectiveNestedPoiActivation\.enforced[\s\S]*\? preArmNestedPlan[\s\S]*: null/,
  );
  assertMatch(
    scanner,
    /entry_zone_type: routedPreArmNestedPlan[\s\S]*entry_zone_low: routedPreArmNestedPlan\?\.outerZone\.low[\s\S]*entry_zone_high: routedPreArmNestedPlan\?\.outerZone\.high/,
  );
  assertStringIncludes(scanner, "nestedPoiEntry: preArmNestedPlan");
  assertMatch(
    scanner,
    /entryMode: routedPreArmNestedPlan[\s\S]*\? "nested_poi_market"[\s\S]*: "confirmation"/,
  );
});

Deno.test("nested POI route does not override the saved impulse lifecycle mode", () => {
  assertStringIncludes(
    scanner,
    "impulseEntryLifecycleMode: impulseLifecycleEnforcement.effectiveMode",
  );
  assert(
    !scanner.includes(
      'impulseEntryLifecycleMode: nestedPoiLifecycleEnforced\n          ? "enforce"',
    ),
    "nested POI activation must not silently promote lifecycle Observe to Enforce",
  );
  assert(
    !scanner.includes(
      'mode: nestedEntryEnforced ? "enforce" : frozenLifecycleMode',
    ),
    "pending lifecycle validation must use the frozen lifecycle mode",
  );
});

Deno.test("enforced nested POI route always creates its existing pending monitor", () => {
  assertStringIncludes(scanner, "const shouldPreArmZoneSetup =");
  assertMatch(
    scanner,
    /const shouldPreArmZoneSetup =[\s\S]*effectiveNestedPoiActivation\.enforced[\s\S]*pairConfig\.preArmZoneSetups === true/,
  );
  assertMatch(
    scanner,
    /!izData\.bestZone\?\.priceAtZone && zoneWatchPersisted && frozenZoneWatch &&[\s\S]*shouldPreArmZoneSetup/,
  );
});

Deno.test("existing staged setups keep their frozen nested POI rollout mode", () => {
  assertMatch(
    scanner,
    /const stagedNestedPoiPlanState = existingStaged[\s\S]*resolvePendingNestedPoiEntryPlanState\(existingStaged\)[\s\S]*const stagedFrozenNestedPoiEntry = stagedNestedPoiPlanState\?\.valid/,
  );
  assertMatch(
    scanner,
    /const effectiveNestedPoiActivation = existingStaged[\s\S]*\? stagedNestedPoiActivation[\s\S]*: nestedPoiActivation/,
  );
  assertMatch(
    scanner,
    /const effectiveFrozenNestedPoiEntry = existingStaged[\s\S]*\? stagedFrozenNestedPoiEntry[\s\S]*: frozenNestedPoiEntry/,
  );
  assertStringIncludes(
    scanner,
    "Frozen nested POI setup is paper-only and cannot be converted to live execution",
  );
});

Deno.test("paper-only staged nested route fails closed before every entry branch", () => {
  const mismatchGuard = scanner.indexOf(
    "if (stagedNestedPoiRuntimeMismatch)",
  );
  const unifiedBranch = scanner.indexOf(
    "} else if (pairConfig.requireUnifiedZone)",
  );
  const marketFill = scanner.indexOf("let useMarketFillAtZone");
  assert(
    mismatchGuard >= 0 && mismatchGuard < unifiedBranch &&
      mismatchGuard < marketFill,
    "runtime-target mismatch must stop unified, cascade, and legacy market-fill routes",
  );
  assertStringIncludes(
    scanner.slice(mismatchGuard, unifiedBranch),
    "continue;",
  );
});

Deno.test("paper-only frozen nested orders fail closed after a live account switch", () => {
  assertMatch(
    scanner,
    /resolveFrozenNestedPoiMarketRoute\(\{[\s\S]*route: pendingNestedPoiEntry\.route[\s\S]*pendingNestedActivation\?\.runtimeTargetMismatch === true[\s\S]*\.eq\("status", "pending"\)/,
  );
  assertStringIncludes(
    scanner,
    "nested_poi_runtime_target_mismatch: paper-only setup cannot execute live",
  );
});

Deno.test("new live paper-only setups freeze an observation route", () => {
  assertMatch(
    scanner,
    /route: nestedPoiActivation\.enforced[\s\S]*\? "nested_poi_market"[\s\S]*: "observe"/,
  );
  assert(!scanner.includes('pendingNestedPoiEntry?.mode === "enforce_paper"'));
  assert(
    !scanner.includes('stagedFrozenNestedPoiEntry?.mode === "enforce_paper"'),
  );
  assertStringIncludes(
    scanner,
    "monitoringTimeframe: timeframeAuthority.runtimeEntry",
  );
  assertStringIncludes(
    scanner,
    'nestedPoiMonitoringTimeframe: impulseEntryMode === "nested_poi_market"',
  );
});

Deno.test("staged refresh keeps the frozen nested entry instead of recomputing it", () => {
  const refreshStart = scanner.indexOf(
    "// Update observation fields without rewriting frozen executable geometry.",
  );
  const refreshEnd = scanner.indexOf(
    "zoneWatchPersisted = true;",
    refreshStart,
  );
  assert(refreshStart >= 0 && refreshEnd > refreshStart);
  const refresh = scanner.slice(refreshStart, refreshEnd);
  assertStringIncludes(refresh, "existingNestedPoiEntry?.selected?.entryPrice");
  assert(!refresh.includes("frozen_strategy_context:"));
  assert(!refresh.includes("originating_zone:"));
});

Deno.test("staged declared nested route with no valid plan cannot reach market fill", () => {
  const guard = scanner.indexOf(
    "if (stagedNestedPoiPlanState && !stagedNestedPoiPlanState.valid)",
  );
  const marketFill = scanner.indexOf("let useMarketFillAtZone", guard);
  assert(guard >= 0 && marketFill > guard);
  const guardedSection = scanner.slice(guard, marketFill);
  assertStringIncludes(
    guardedSection,
    'detail.status = "skipped_nested_poi_frozen_plan_unavailable"',
  );
  assertStringIncludes(guardedSection, "scanDetails.push(detail)");
  assertStringIncludes(guardedSection, "continue;");
});

Deno.test("pending nested route with no frozen selected plan is terminally invalidated", () => {
  const branchStart = scanner.indexOf(
    'if (pending.status === "pending") {',
  );
  const activationStart = scanner.indexOf(
    "const pendingNestedActivation =",
    branchStart,
  );
  assert(branchStart >= 0 && activationStart > branchStart);
  const guard = scanner.slice(branchStart, activationStart);
  assertStringIncludes(guard, "resolvePendingNestedPoiEntryPlanState(pending)");
  assertStringIncludes(guard, "if (!pendingNestedPlanState.valid)");
  assertStringIncludes(guard, 'status: "invalidated"');
  assertStringIncludes(guard, "cancel_reason: reason");
  assertStringIncludes(guard, '.eq("status", "pending")');
  assertStringIncludes(guard, "continue;");
});

Deno.test("staged setup lookup preserves symbol and direction identity", () => {
  assertStringIncludes(
    scanner,
    'const stagedKey = analysis.direction ? `${pair}:${analysis.direction}` : null;',
  );
});

Deno.test("frozen nested ownership survives a fresh direction flip", () => {
  const ownershipStart = scanner.indexOf(
    "const currentNestedPendingCandidate =",
  );
  const ownershipEnd = scanner.indexOf(
    "const currentPendingNestedPoiPlanState =",
    ownershipStart,
  );
  assert(ownershipStart >= 0 && ownershipEnd > ownershipStart);
  const ownershipLookup = scanner.slice(ownershipStart, ownershipEnd);
  assertStringIncludes(ownershipLookup, "pending.symbol === pair");
  assertStringIncludes(
    ownershipLookup,
    "resolvePendingNestedPoiEntryPlanState(pending).declared",
  );
  assert(
    !ownershipLookup.includes("pending.direction === analysis.direction"),
    "a frozen nested order owns the symbol even when fresh analysis flips direction",
  );
});

Deno.test("active frozen nested route cannot be claimed after a config change", () => {
  const ownership = scanner.indexOf(
    "const currentPendingOwnsNestedPoiRoute =",
  );
  const guard = scanner.indexOf(
    "if (currentPendingOwnsNestedPoiRoute)",
    ownership,
  );
  const marketFill = scanner.indexOf("let useMarketFillAtZone", guard);
  assert(ownership >= 0 && guard > ownership && marketFill > guard);
  const ownershipDeclaration = scanner.slice(ownership - 250, ownership + 250);
  const guardedSection = scanner.slice(guard, marketFill);
  assertStringIncludes(
    ownershipDeclaration,
    "currentPendingNestedPoiPlanState?.declared === true",
  );
  assert(
    !ownershipDeclaration.includes("nestedPoiActivation"),
    "persisted route ownership must not depend on the current rollout setting",
  );
  assertStringIncludes(guardedSection, "scanDetails.push(detail)");
  assertStringIncludes(guardedSection, "continue;");
});

Deno.test("active frozen nested route blocks pre-arm duplication", () => {
  const guard = scanner.indexOf("if (currentPendingOwnsNestedPoiRoute)");
  const preArm = scanner.indexOf("const preArmReachability =", guard);
  assert(guard >= 0 && preArm > guard);
  const guardedSection = scanner.slice(guard - 250, preArm);
  assertStringIncludes(guardedSection, "must not stage, claim, or supersede");
  assertStringIncludes(guardedSection, "continue;");
});

Deno.test("active frozen nested route cannot be superseded by fresh geometry", () => {
  const guard = scanner.indexOf("if (currentPendingOwnsNestedPoiRoute)");
  const supersede = scanner.indexOf("shouldSupersedePendingOrder(", guard);
  assert(guard >= 0 && supersede > guard);
  const guardedSection = scanner.slice(guard, supersede);
  assertStringIncludes(
    guardedSection,
    "current settings and geometry cannot replace it",
  );
  assertStringIncludes(guardedSection, "continue;");
});

Deno.test("at-zone nested setup preserves staged touch eligibility without discovery lookahead", () => {
  assertStringIncludes(
    scanner,
    "closedCandleTouchesNestedPoiOuterZone",
  );
  assertMatch(
    scanner,
    /const nestedOuterZoneTouchedAtCreation = !!\([\s\S]*routedNestedPoiEntry[\s\S]*latestClosedEntryCandle[\s\S]*closedCandleTouchesNestedPoiOuterZone\([\s\S]*latestClosedEntryCandle,[\s\S]*routedNestedPoiEntry\.outerZone/,
  );
  assertMatch(
    scanner,
    /const nestedOuterZoneTouchTime = nestedOuterZoneTouchedAtCreation[\s\S]*latestClosedEntryCandle!\.datetime[\s\S]*const nestedConfirmationCursor = existingStaged && nestedOuterZoneTouchTime[\s\S]*\? nestedOuterZoneTouchTime[\s\S]*: placedAt/,
  );
  assertMatch(
    scanner,
    /status: initialPendingStatus,[\s\S]*zone_touch_time: nestedOuterZoneTouchTime,[\s\S]*last_touch_checked_at: placedAt,[\s\S]*last_confirmation_checked_at: nestedConfirmationCursor,[\s\S]*placed_at: placedAt/,
  );
});
