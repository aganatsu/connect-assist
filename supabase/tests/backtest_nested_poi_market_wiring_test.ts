import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const engine = await Deno.readTextFile(
  new URL("../functions/backtest-engine/index.ts", import.meta.url),
);

Deno.test("backtest nested POI mode is opt-in and reuses the shared selector", () => {
  assertStringIncludes(engine, "buildNestedPoiEntryPlan");
  assertStringIncludes(engine, "resolveNestedPoiMarketActivation");
  assertMatch(
    engine,
    /marketFillAtZone: pairConfig\.marketFillAtZone === true[\s\S]*mode: pairConfig\.nestedPoiMarketMode[\s\S]*runtimeTarget: "paper"/,
  );
});

Deno.test("backtest arms the selected nested trigger without an outer-zone fallback", () => {
  assertStringIncludes(
    engine,
    "const nestedTrigger = nestedPoiMarketEnforced",
  );
  assertMatch(
    engine,
    /const lifecycleExecutableZone = nestedPoiMarketEnforced[\s\S]*\? nestedTrigger[\s\S]*id: nestedTrigger\.id[\s\S]*triggerKind: nestedTrigger\.geometry[\s\S]*: null[\s\S]*: multiTF\.bestZone/,
  );
  assertStringIncludes(
    engine,
    "entryMode: nestedPoiMarketEnforced",
  );
  assertStringIncludes(engine, '? "nested_poi_market"');
});

Deno.test("backtest freezes nested entry only after admission and never replays the discovery candle", () => {
  assertStringIncludes(
    engine,
    "const lifecycleMode = nestedPoiMarketEnforced",
  );
  assertMatch(
    engine,
    /if \(nestedPoiMarketEnforced\) \{[\s\S]*pendingNestedLifecycleDiscovery = lifecycleDiscoveryInput;[\s\S]*\} else \{[\s\S]*advanceBacktestTradeLifecycle/,
  );
  assertMatch(
    engine,
    /if \(pendingNestedLifecycleDiscovery\) \{[\s\S]*const armedNestedState = discoverBacktestTradeLifecycle[\s\S]*tradeLifecycleState = armedNestedState;[\s\S]*continue;/,
  );
  assertStringIncludes(engine, "frozen_nested_poi_trigger_touched");
});

Deno.test("legacy backtest path remains the fallback only when nested mode is not enforced", () => {
  const nestedBranch = engine.indexOf(
    "const lifecycleExecutableZone = nestedPoiMarketEnforced",
  );
  const legacyBranch = engine.indexOf(": multiTF.bestZone", nestedBranch);
  assertEquals(nestedBranch >= 0, true);
  assertEquals(legacyBranch > nestedBranch, true);
});

Deno.test("backtest derives frozen nested geometry from the shared pending-order plan", () => {
  assertStringIncludes(engine, "activeBacktestFrozenExecutionCandidate");
  assertStringIncludes(engine, "activeBacktestFrozenSignalSource");
  assertStringIncludes(
    engine,
    "const pendingPlanResult = buildPendingOrderPlan({",
  );
  assertMatch(
    engine,
    /zone: \{[\s\S]*price: nestedTrigger\.entryPrice[\s\S]*stopLoss: analysis\.stopLoss[\s\S]*takeProfitFor:[\s\S]*calculateSLTP/,
  );
  assertMatch(
    engine,
    /if \(!pendingPlanResult\.valid\) \{[\s\S]*continue;[\s\S]*executionCandidate: \{[\s\S]*stopLoss: pendingPlan\.stopLoss[\s\S]*takeProfit: pendingPlan\.takeProfit/,
  );
  assertMatch(
    engine,
    /let signalSource:[\s\S]*activeBacktestFrozenSignalSource\(tradeLifecycleState\) \?\? "standalone"/,
  );
});

Deno.test("backtest replays the frozen nested plan without requiring zone rediscovery", () => {
  assertStringIncludes(engine, "activeBacktestFrozenNestedPoiEntryPlan");
  assertStringIncludes(
    engine,
    "nestedPoiMonitoringTimeframe: nestedPoiMarketEnforced",
  );
  assertMatch(
    engine,
    /const frozenNestedAuthorizationPlan =[\s\S]*lifecycle\?\.entryMode === "nested_poi_market" && lifecycleEntryReady[\s\S]*activeBacktestFrozenNestedPoiEntryPlan\(tradeLifecycleState\)/,
  );
  const frozenBranch = engine.indexOf(
    "if (frozenNestedAuthorizationRoute || prospectiveNestedLifecycle)",
  );
  const missingCurrentZone = engine.indexOf(
    "if (!izData || !izData.hasZone)",
    frozenBranch,
  );
  assertEquals(frozenBranch >= 0, true);
  assertEquals(missingCurrentZone > frozenBranch, true);
  assertMatch(
    engine,
    /const replayNestedPlan = frozenNestedAuthorizationPlan \?\?[\s\S]*pendingNestedLifecycleDiscovery\?\.nestedPoiEntryPlan[\s\S]*source: signalSource[\s\S]*frozenNestedPoiEntry = replayNestedPlan[\s\S]*frozenSignalSource = signalSource/,
  );
  assertStringIncludes(
    engine,
    "tradeLifecycleState.nestedTriggerTimeframe",
  );
});

Deno.test("new nested lifecycle is retained only after setup admission passes", () => {
  const prospective = engine.indexOf(
    "pendingNestedLifecycleDiscovery = lifecycleDiscoveryInput;",
  );
  const safety = engine.indexOf(
    "const safetyGateEvaluation = runBacktestSafetyGates(",
    prospective,
  );
  const admissionBlock = engine.indexOf("if (!allPassed)", safety);
  const orderPlan = engine.indexOf(
    "const pendingPlanResult = buildPendingOrderPlan({",
    admissionBlock,
  );
  const retained = engine.indexOf(
    "tradeLifecycleState = armedNestedState;",
    orderPlan,
  );
  assertEquals(prospective >= 0, true);
  assertEquals(safety > prospective, true);
  assertEquals(admissionBlock > safety, true);
  assertEquals(orderPlan > admissionBlock, true);
  assertEquals(retained > orderPlan, true);
});

Deno.test("ready frozen nested setups bypass discovery admission but rerun final safety gates", () => {
  assertStringIncludes(engine, "if (!analysis && activeFrozenAnalysis)");
  assertStringIncludes(
    engine,
    "if ((candleDow === 0 || candleDow === 6) &&",
  );
  assertStringIncludes(engine, "!frozenNestedLifecyclePlan");
  assertStringIncludes(
    engine,
    "const frozenNestedLifecycleWaiting =",
  );
  assertStringIncludes(
    engine,
    "if (preGateFailed && !frozenNestedLifecycleWaiting)",
  );
  assertStringIncludes(
    engine,
    "if (!frozenNestedAuthorizationRoute && !zoneLocalDecision.allowed)",
  );
  assertStringIncludes(
    engine,
    "if (!frozenNestedAuthorizationRoute && !crossTimeframeDecision.allowed)",
  );
  assertStringIncludes(
    engine,
    'if (!frozenNestedAuthorizationRoute && backtestLegacyGateBlocks("conflict_count"',
  );
  assertStringIncludes(
    engine,
    "if (!frozenNestedAuthorizationRoute && effectiveScore <",
  );
  assertStringIncludes(
    engine,
    "if (!frozenNestedAuthorizationRoute && izData?.bestZone)",
  );
  assertStringIncludes(
    engine,
    "if (!frozenNestedAuthorizationRoute && actualTpPips < minTpPips)",
  );
  assertStringIncludes(
    engine,
    'if (!frozenNestedAuthorizationRoute && izGateMode === "hard"',
  );
  assertStringIncludes(
    engine,
    "const safetyGateEvaluation = runBacktestSafetyGates(",
  );
  assertMatch(
    engine,
    /const gates = frozenNestedAuthorizationRoute[\s\S]*\? \[\][\s\S]*: safetyGateEvaluation\.gates/,
  );
  assertStringIncludes(
    engine,
    "cooldown: safetyGateEvaluation.runtimeGates.cooldown",
  );
  assertStringIncludes(
    engine,
    "correlation: safetyGateEvaluation.runtimeGates.correlation",
  );
  assertStringIncludes(
    engine,
    "portfolioHeat: safetyGateEvaluation.runtimeGates.portfolioHeat",
  );
  assertStringIncludes(
    engine,
    "if (!frozenNestedLifecyclePlan && !isSessionEnabled(session, config.enabledSessions))",
  );
  assertStringIncludes(engine, "passed: finalSessionPassed");
});

Deno.test("backtest reevaluates the frozen dealing range at the actual nested fill", () => {
  assertStringIncludes(
    engine,
    "range: tradeLifecycleState.frozenCanonicalLocation?.range ?? null",
  );
  assertMatch(
    engine,
    /canonicalDealingRangeEvaluation = evaluateCanonicalDealingRange\(\{[\s\S]*price: candle\.close,[\s\S]*mode: normalizeDealingRangeMode/,
  );
  assertEquals(
    engine.includes("? tradeLifecycleState.frozenCanonicalLocation\n"),
    false,
  );
});

Deno.test("backtest terminal final-authorization denials cancel the frozen lifecycle", () => {
  assertStringIncludes(engine, "pendingFinalAuthorizationRetryable({");
  assertMatch(
    engine,
    /if \(!ownershipFill\.authorized\) \{[\s\S]*if \(frozenNestedAuthorizationRoute &&[\s\S]*!finalAuthorizationRetryable\)[\s\S]*cancelBacktestTradeLifecycle/,
  );
});

Deno.test("backtest restores the frozen target around later target adjustments", () => {
  const firstTargetRestore = engine.indexOf(
    "analysis = restoreBacktestFrozenTarget(",
  );
  const missingTargetGuard = engine.indexOf("if (!analysis.takeProfit)");
  const regimeAdjustment = engine.indexOf(
    "if (config.regimeAdaptiveTPEnabled && analysis.regimeInfo)",
  );
  const finalTargetRestore = engine.lastIndexOf(
    "analysis = restoreBacktestFrozenTarget(",
  );
  const finalAuthorization = engine.indexOf(
    "const finalAuthorization = evaluateFinalTradeAuthorization(",
  );
  assertEquals(firstTargetRestore >= 0, true);
  assertEquals(missingTargetGuard > firstTargetRestore, true);
  assertEquals(regimeAdjustment > missingTargetGuard, true);
  assertEquals(finalTargetRestore > regimeAdjustment, true);
  assertEquals(finalAuthorization > finalTargetRestore, true);
});
