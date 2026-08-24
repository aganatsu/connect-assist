import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFrozenSetupStrategyContext,
  buildSetupLifecycleEvidence,
  canTransitionSetup,
  normalizeNestedPoiEntryMode,
  normalizeNestedPoiEntryPlan,
  resolvePendingConfirmationMethod,
  resolvePendingDealingRangeMode,
  resolvePendingIndicatorMinimum,
  resolvePendingMaxConfirmationAttempts,
  resolvePendingNestedPoiEntryPlan,
  resolvePendingNestedPoiEntryPlanState,
  resolvePendingStylePolicy,
  validateFrozenSetupIdentity,
} from "../../functions/_shared/setupLifecycle.ts";
import type { NestedPoiTriggerCandidate } from "../../functions/_shared/impulseZoneEngine.ts";

function stylePolicy(
  style: "scalper" | "day_trader" = "scalper",
): any {
  const scalper = style === "scalper";
  return {
    contractVersion: "style-policy.v1.3",
    basePolicyHash: `${style}-base`,
    policyHash: `${style}-exact`,
    enforcement: "observe_only",
    scope: "pair",
    style,
    symbol: "GBP/USD",
    resolvedAt: "2026-07-29T12:00:00.000Z",
    timeframes: {
      roles: scalper
        ? {
          bias: "1h",
          structure: "15min",
          setup: "5min",
          confirmation: "5min",
          refinement: "1min",
        }
        : {
          bias: "1day",
          structure: "4h",
          setup: "1h",
          confirmation: "15min",
          refinement: "5min",
        },
      runtimeEntry: scalper ? "5m" : "15min",
      runtimeHTF: scalper ? "1h" : "4h",
    },
    cadence: { scanIntervalMinutes: scalper ? 5 : 15 },
    qualification: {},
    risk: {},
    management: {},
    lifecycle: {
      gamePlanValidityMinutes: scalper ? 120 : 240,
      stagingTTLMinutes: 60,
      limitOrderExpiryMinutes: 120,
      maxConfirmationAttempts: scalper ? 2 : 5,
    },
    provenance: {
      profileAppliedToRuntime: true,
      styleApplied: [],
      userOverridesPreserved: [],
    },
  };
}

Deno.test("setup lifecycle permits only canonical forward transitions", () => {
  assertEquals(canTransitionSetup("watching", "qualified"), true);
  assertEquals(canTransitionSetup("qualified", "pending"), true);
  assertEquals(
    canTransitionSetup("pending", "awaiting_confirmation"),
    true,
  );
  assertEquals(canTransitionSetup("awaiting_confirmation", "pending"), true);
  assertEquals(canTransitionSetup("awaiting_confirmation", "filled"), true);
  assertEquals(canTransitionSetup("watching", "filled"), false);
  assertEquals(canTransitionSetup("filled", "pending"), false);
  assertEquals(
    canTransitionSetup("blocked_after_qualification", "pending"),
    false,
  );
});

Deno.test("pending Premium/Discount mode is frozen with the setup", () => {
  const frozen = buildFrozenSetupStrategyContext({
    identity: { setupId: "setup-1", candidateId: "candidate-1" },
    symbol: "GBP/USD",
    direction: "long",
    stylePolicy: stylePolicy("scalper"),
    runtimeConfig: {
      effectiveConfig: { dealingRangeMode: "strict_value" },
    } as any,
    gamePlan: null,
    directionVerdict: null,
    confirmationMethod: "choch",
  });
  assertEquals(
    resolvePendingDealingRangeMode(
      { frozen_strategy_context: frozen },
      "avoid_wrong_side",
    ),
    "strict_value",
  );
  assertEquals(
    resolvePendingDealingRangeMode({}, "avoid_wrong_side"),
    "avoid_wrong_side",
  );
});

Deno.test("pending confirmation method is frozen on the pending row", () => {
  assertEquals(
    resolvePendingConfirmationMethod(
      {
        confirmation_method: "indicators",
        signal_reason: { confirmationMethod: "choch" },
      },
      { confirmationMethod: "choch_and_indicators" },
    ),
    "indicators",
  );
});

Deno.test("legacy pending confirmation method falls back without overriding evidence", () => {
  assertEquals(
    resolvePendingConfirmationMethod(
      {
        signal_reason: {
          watchlistLifecycle: {
            confirmationMethod: "choch_and_indicators",
          },
        },
      },
      { confirmationMethod: "choch" },
    ),
    "choch_and_indicators",
  );
  assertEquals(
    resolvePendingConfirmationMethod({}, { confirmationMethod: "indicators" }),
    "indicators",
  );
});

Deno.test("indicator threshold uses the setup snapshot before runtime config", () => {
  assertEquals(
    resolvePendingIndicatorMinimum(
      { confirmation_config: { indicatorMinCount: 4 } },
      { indicatorMinCount: 2 },
    ),
    4,
  );
});

Deno.test("lifecycle evidence ties candidate to exact strategy versions", () => {
  const evidence = buildSetupLifecycleEvidence({
    identity: {
      setupId: "setup-1",
      candidateId: "candidate-1",
    },
    symbol: "GBP/CAD",
    gamePlan: {
      planVersion: "session-v1",
      plans: [{
        symbol: "GBP/CAD",
        gamePlanId: "gp-1",
        planVersion: "gp-v1",
      }],
    } as any,
    directionVerdict: {
      id: "dv-1",
      verdictVersion: "dv-v1",
      gamePlanId: "gp-1",
      gamePlanVersion: "gp-v1",
    },
    confirmationMethod: "choch_and_indicators",
    originatingZone: { type: "fvg", low: 1.2, high: 1.21 },
  });
  assertEquals(evidence.candidateId, "candidate-1");
  assertEquals(evidence.gamePlanId, "gp-1");
  assertEquals(evidence.gamePlanVersion, "gp-v1");
  assertEquals(evidence.directionVerdictVersion, "dv-v1");
  assertEquals(evidence.confirmationMethod, "choch_and_indicators");
  assertEquals(evidence.thesisVersion, "thesis.v1");
});

Deno.test("frozen setup captures only matching directional scenarios and zone story", () => {
  const frozen = buildFrozenSetupStrategyContext({
    identity: {
      setupId: "setup-1",
      candidateId: "candidate-1",
    },
    symbol: "GBP/USD",
    direction: "long",
    stylePolicy: stylePolicy("scalper"),
    gamePlan: {
      planVersion: "session-v1",
      validityPolicy: { contractVersion: "gameplan-validity.v1" },
      plans: [{
        symbol: "GBP/USD",
        gamePlanId: "gp-1",
        planVersion: "gp-v1",
        scenarios: [
          {
            direction: "long",
            condition: "Price reclaims the demand zone",
            action: "Wait for bullish displacement",
            targetLevel: 1.31,
            invalidation: "Close below demand",
          },
          {
            direction: "short",
            condition: "Price rejects resistance",
            action: "Wait for bearish displacement",
            targetLevel: 1.28,
          },
        ],
      }],
    } as any,
    directionVerdict: {
      id: "dv-1",
      verdictVersion: "dv-v1",
      gamePlanId: "gp-1",
      gamePlanVersion: "gp-v1",
    } as any,
    originatingZone: { type: "impulse_fvg", low: 1.29, high: 1.295 },
    confirmationMethod: "choch_and_indicators",
    indicatorMinCount: 4,
    frozenAt: "2026-07-29T12:05:00.000Z",
  });

  assertEquals(frozen.stylePolicy.policyHash, "scalper-exact");
  assertEquals(frozen.scenarioZoneStory.enforcement, "observe_only");
  assertEquals(frozen.scenarioZoneStory.scenarioCandidates.length, 1);
  assertEquals(
    frozen.scenarioZoneStory.scenarioCandidates[0].condition,
    "Price reclaims the demand zone",
  );
  assertEquals(frozen.scenarioZoneStory.selectedScenarioIndex, null);
  assertEquals(frozen.confirmation.timeframe, "5min");
  assertEquals(frozen.confirmation.refinementTimeframe, "1min");
  assertEquals(frozen.confirmation.maxAttempts, 2);
});

Deno.test("frozen setup preserves observe-only primitive evidence", () => {
  const evidence = {
    contractVersion: "concept-evidence.v1" as const,
    entityId: "fvg:entity1-test",
    evidenceId: "fvg:ce1-test",
    concept: "fvg" as const,
    detector: { name: "smcAnalysis.detectFVGs", version: "1" },
    symbol: "GBP/USD",
    timeframe: "1H",
    observedAt: "2026-07-31T14:00:00.000Z",
    sourceCandleStart: "2026-07-31T12:00:00.000Z",
    sourceCandleEnd: "2026-07-31T13:00:00.000Z",
    direction: "bullish" as const,
    bounds: { low: 1.274, high: 1.275 },
    level: null,
    lifecycle: "open",
    attributes: {},
  };
  const frozen = buildFrozenSetupStrategyContext({
    identity: { setupId: "setup-evidence", candidateId: "candidate-evidence" },
    symbol: "GBP/USD",
    direction: "long",
    stylePolicy: stylePolicy("scalper"),
    gamePlan: null,
    directionVerdict: null,
    conceptEvidence: [evidence],
    zoneLocalConfluence: {
      policyVersion: "zone-local-confluence.v1",
      enforcement: "observe_only",
      candidateId: "candidate-evidence",
      zone: { low: 1.274, high: 1.275 },
      pipSize: 0.0001,
      atr: 0.002,
      items: [],
    },
    zoneCandidateShadowRanking: {
      contractVersion: "zone-candidate-shadow-ranking.v1",
      enforcement: "observe_only",
      candidateId: "candidate-evidence",
      legacyZoneScore: 2,
      legacyComparableScore: 2,
      shadowLocalScore: 1,
      legacyRank: 1,
      shadowRank: 2,
      rankDelta: -1,
      selectedEvidence: [],
      excludedEvidence: [],
      summary: {
        observedItems: 1,
        locallyQualifiedItems: 1,
        contextOnlyItems: 0,
        uniqueEntities: 1,
        creditedFamilies: 1,
      },
    },
    confirmationMethod: "choch",
  });

  assertEquals(frozen.conceptEvidence, [evidence]);
  assertEquals(frozen.zoneLocalConfluence?.candidateId, "candidate-evidence");
  assertEquals(frozen.zoneLocalConfluence?.enforcement, "observe_only");
  assertEquals(frozen.zoneCandidateShadowRanking?.shadowRank, 2);
});

Deno.test("an in-flight setup keeps its original style after runtime style changes", () => {
  const frozen = buildFrozenSetupStrategyContext({
    identity: {
      setupId: "setup-1",
      candidateId: "candidate-1",
    },
    symbol: "GBP/USD",
    direction: "long",
    stylePolicy: stylePolicy("scalper"),
    gamePlan: null,
    directionVerdict: null,
    confirmationMethod: "choch",
  });
  const resolved = resolvePendingStylePolicy(
    {
      candidate_id: "candidate-1",
      symbol: "GBP/USD",
      direction: "long",
      frozen_strategy_context: frozen,
    },
    stylePolicy("day_trader"),
  );

  assertEquals(resolved.source, "frozen_setup");
  assertEquals(resolved.policy.style, "scalper");
  assertEquals(resolved.policy.timeframes.roles.confirmation, "5min");
  assertEquals(
    resolvePendingMaxConfirmationAttempts(
      { frozen_strategy_context: frozen },
      { maxConfirmationAttempts: 9 },
    ),
    2,
  );
});

Deno.test("frozen setup identity rejects candidate or direction drift", () => {
  const frozen = buildFrozenSetupStrategyContext({
    identity: {
      setupId: "setup-1",
      candidateId: "candidate-1",
    },
    symbol: "GBP/USD",
    direction: "long",
    stylePolicy: stylePolicy(),
    gamePlan: null,
    directionVerdict: null,
    confirmationMethod: "choch",
  });
  const result = validateFrozenSetupIdentity(
    {
      candidate_id: "candidate-2",
      symbol: "GBP/USD",
      direction: "short",
    },
    frozen,
  );

  assertEquals(result.valid, false);
  assertEquals(
    result.reason,
    "Frozen setup identity mismatch: candidate ID, direction",
  );
});

Deno.test("lifecycle evidence cannot be rewritten by a newer plan", () => {
  const frozen = buildFrozenSetupStrategyContext({
    identity: {
      setupId: "setup-1",
      candidateId: "candidate-1",
    },
    symbol: "GBP/USD",
    direction: "long",
    stylePolicy: stylePolicy(),
    gamePlan: {
      planVersion: "original-session",
      plans: [{
        symbol: "GBP/USD",
        gamePlanId: "original-gp",
        planVersion: "original-version",
        scenarios: [],
      }],
    } as any,
    directionVerdict: {
      id: "original-dv",
      verdictVersion: "original-dv-version",
    } as any,
    originatingZone: { type: "original-zone" },
    confirmationMethod: "indicators",
  });
  const evidence = buildSetupLifecycleEvidence({
    identity: {
      setupId: "setup-1",
      candidateId: "candidate-1",
    },
    symbol: "GBP/USD",
    gamePlan: {
      planVersion: "new-session",
      plans: [{
        symbol: "GBP/USD",
        gamePlanId: "new-gp",
        planVersion: "new-version",
      }],
    } as any,
    directionVerdict: {
      id: "new-dv",
      verdictVersion: "new-dv-version",
    } as any,
    confirmationMethod: "choch",
    originatingZone: { type: "new-zone" },
    frozenStrategyContext: frozen,
  });

  assertEquals(evidence.gamePlanId, "original-gp");
  assertEquals(evidence.gamePlanVersion, "original-version");
  assertEquals(evidence.directionVerdictId, "original-dv");
  assertEquals(evidence.confirmationMethod, "indicators");
  assertEquals(evidence.originatingZone, { type: "original-zone" });
});
function nestedPoiPlan() {
  const selected: NestedPoiTriggerCandidate = {
    id: "nested-ob-1",
    type: "ob" as const,
    geometry: "range" as const,
    source: "ltf_refinement" as const,
    direction: "bullish" as const,
    low: 1.102,
    high: 1.103,
    entryPrice: 1.103,
    timeframe: "1m",
    lifecycle: "fresh",
    evidenceId: "evidence-ob-1",
    entityId: "nested-ob-1",
    supportingEvidenceIds: ["evidence-ob-1", "evidence-fib-1"],
    supportingFamilies: ["ob" as const, "fib" as const],
    independentEvidenceCount: 2,
    localScore: 2.5,
    lifecycleRank: 5,
    depth: 0.7,
    widthRatio: 0.1,
    rank: 1,
  };
  return {
    contractVersion: "nested-poi-entry.v1" as const,
    enforcement: "observe_only" as const,
    mode: "enforce_paper" as const,
    route: "nested_poi_market" as const,
    monitoringTimeframe: "5m",
    direction: "long" as const,
    frozenAt: "2026-08-24T12:00:00.000Z",
    outerCandidateId: "candidate-1",
    outerZone: {
      low: 1.1,
      high: 1.11,
      direction: "bullish" as const,
    },
    selected,
    candidates: [selected],
    reason: "selected" as const,
  };
}

function nestedLifecycleContext(plan: ReturnType<typeof nestedPoiPlan>) {
  return {
    impulseEntryLifecycleAvailability: {
      mode: "enforce",
      available: true,
      reason: "available",
    },
    impulseEntryLifecycle: {
      mode: "enforce" as "enforce" | "observe",
      entryMode: "nested_poi_market" as
        | "nested_poi_market"
        | "confirmation",
      impulse: { direction: plan.direction as "long" | "short" },
      confirmation: { timeframe: plan.monitoringTimeframe },
      activeCandidateId: plan.selected.id,
      candidates: [{
        id: plan.selected.id,
        type: plan.selected.type,
        low: plan.selected.low,
        high: plan.selected.high,
        triggerKind: plan.selected.geometry,
      }],
    },
  };
}

Deno.test("nested POI entry plan is frozen with the setup and resolves unchanged", () => {
  const nestedPoiEntry = nestedPoiPlan();
  const frozen = buildFrozenSetupStrategyContext({
    identity: { setupId: "setup-1", candidateId: "candidate-1" },
    symbol: "GBP/USD",
    direction: "long",
    stylePolicy: stylePolicy(),
    gamePlan: null,
    directionVerdict: null,
    confirmationMethod: "choch",
    nestedPoiEntry,
  });

  nestedPoiEntry.selected.low = 1.109;
  assertEquals(frozen.nestedPoiEntry?.selected?.low, 1.102);
  assertEquals(
    resolvePendingNestedPoiEntryPlan({ frozen_strategy_context: frozen }),
    frozen.nestedPoiEntry,
  );
});

Deno.test("valid frozen setup context does not fall back to stale duplicate nested fields", () => {
  const frozen = buildFrozenSetupStrategyContext({
    identity: { setupId: "setup-1", candidateId: "candidate-1" },
    symbol: "GBP/USD",
    direction: "long",
    stylePolicy: stylePolicy(),
    gamePlan: null,
    directionVerdict: null,
    confirmationMethod: "choch",
    nestedPoiEntry: null,
  });
  const stale = nestedPoiPlan();

  assertEquals(
    resolvePendingNestedPoiEntryPlan({
      frozen_strategy_context: frozen,
      nested_poi_entry: stale,
      signal_reason: { nestedPoiEntry: stale },
      confirmation_config: { nestedPoiEntry: stale },
    }),
    null,
  );
});

Deno.test("nested POI plan rejects geometry outside the frozen outer zone", () => {
  const plan = nestedPoiPlan();
  plan.selected.low = 1.099;
  plan.candidates[0].low = 1.099;

  assertEquals(normalizeNestedPoiEntryPlan(plan), null);
});

Deno.test("nested POI plan rejects geometry touching the frozen outer boundary", () => {
  const plan = nestedPoiPlan();
  plan.selected.low = plan.outerZone.low;
  plan.candidates[0].low = plan.outerZone.low;

  assertEquals(normalizeNestedPoiEntryPlan(plan), null);
});

Deno.test("nested POI plan rejects an invalid monitoring timeframe", () => {
  const plan = nestedPoiPlan();
  plan.monitoringTimeframe = "not-a-timeframe";

  assertEquals(normalizeNestedPoiEntryPlan(plan), null);
});

Deno.test("nested POI plan canonicalizes a valid monitoring timeframe alias", () => {
  const plan = nestedPoiPlan();
  plan.monitoringTimeframe = "5min";

  assertEquals(normalizeNestedPoiEntryPlan(plan)?.monitoringTimeframe, "5m");
  assertEquals(
    resolvePendingNestedPoiEntryPlanState({
      cross_timeframe_context: nestedLifecycleContext(plan),
      nested_poi_entry: plan,
    }).valid,
    true,
  );
});

Deno.test("nested POI plan rejects point geometry repaired into a range", () => {
  const plan = nestedPoiPlan();
  const point = {
    ...plan.selected,
    id: "fib-1",
    type: "fib" as const,
    geometry: "level" as const,
    low: 1.105,
    high: 1.106,
    entryPrice: 1.105,
    evidenceId: "evidence-fib-1",
    entityId: "fib-1",
    supportingEvidenceIds: ["evidence-fib-1"],
    supportingFamilies: ["fib" as const],
    independentEvidenceCount: 1,
  };
  plan.selected = point;
  plan.candidates = [point];

  assertEquals(normalizeNestedPoiEntryPlan(plan), null);
});

Deno.test("nested POI plan supports an observation with no eligible trigger", () => {
  const plan = {
    ...nestedPoiPlan(),
    mode: "observe",
    route: "observe",
    selected: null,
    candidates: [],
    reason: "no_contained_trigger",
  };

  assertEquals(normalizeNestedPoiEntryPlan(plan)?.selected, null);
  assertEquals(
    normalizeNestedPoiEntryPlan(plan)?.reason,
    "no_contained_trigger",
  );
});

Deno.test("nested POI entry modes fail closed to off", () => {
  assertEquals(normalizeNestedPoiEntryMode("observe"), "observe");
  assertEquals(normalizeNestedPoiEntryMode("enforce_paper"), "enforce_paper");
  assertEquals(normalizeNestedPoiEntryMode("enforce_live"), "enforce_live");
  assertEquals(normalizeNestedPoiEntryMode("hard"), "off");
});

Deno.test("declared nested route fails closed without a valid frozen plan", () => {
  assertEquals(
    resolvePendingNestedPoiEntryPlanState({
      confirmation_config: { entryMode: "nested_poi_market" },
    }),
    {
      declared: true,
      valid: false,
      plan: null,
      reason: "nested_poi_frozen_plan_unavailable",
    },
  );
});

Deno.test("cross-timeframe nested route fails closed without a valid frozen plan", () => {
  const frozen = buildFrozenSetupStrategyContext({
    identity: { setupId: "setup-1", candidateId: "candidate-1" },
    symbol: "GBP/USD",
    direction: "long",
    stylePolicy: stylePolicy(),
    gamePlan: null,
    directionVerdict: null,
    confirmationMethod: "choch",
    crossTimeframeContext: {
      impulseEntryLifecycle: { entryMode: "nested_poi_market" },
    } as any,
    nestedPoiEntry: null,
  });

  assertEquals(
    resolvePendingNestedPoiEntryPlanState({ frozen_strategy_context: frozen }),
    {
      declared: true,
      valid: false,
      plan: null,
      reason: "nested_poi_frozen_plan_unavailable",
    },
  );
});

Deno.test("legacy confirmation row without nested declaration remains valid", () => {
  assertEquals(
    resolvePendingNestedPoiEntryPlanState({
      confirmation_config: { entryMode: "confirmation" },
    }),
    {
      declared: false,
      valid: true,
      plan: null,
      reason: "nested_poi_not_declared",
    },
  );
});

Deno.test("declared nested route resolves its exact valid frozen plan", () => {
  const plan = nestedPoiPlan();
  assertEquals(
    resolvePendingNestedPoiEntryPlanState({
      confirmation_config: { entryMode: "nested_poi_market" },
      cross_timeframe_context: nestedLifecycleContext(plan),
      nested_poi_entry: plan,
    }),
    {
      declared: true,
      valid: true,
      plan,
      reason: "nested_poi_frozen_plan_available",
    },
  );
});

Deno.test("declared nested route rejects a plan without its frozen lifecycle", () => {
  const plan = nestedPoiPlan();
  assertEquals(
    resolvePendingNestedPoiEntryPlanState({
      confirmation_config: { entryMode: "nested_poi_market" },
      nested_poi_entry: plan,
    }),
    {
      declared: true,
      valid: false,
      plan: null,
      reason: "nested_poi_frozen_plan_unavailable",
    },
  );
});

Deno.test("declared nested route rejects confirmation-mode or mismatched lifecycle identity", () => {
  const plan = nestedPoiPlan();
  const confirmationLifecycle = nestedLifecycleContext(plan);
  confirmationLifecycle.impulseEntryLifecycle.entryMode = "confirmation";
  assertEquals(
    resolvePendingNestedPoiEntryPlanState({
      cross_timeframe_context: confirmationLifecycle,
      nested_poi_entry: plan,
    }).valid,
    false,
  );

  const mismatchedTimeframe = nestedLifecycleContext(plan);
  mismatchedTimeframe.impulseEntryLifecycle.confirmation.timeframe = "15m";
  assertEquals(
    resolvePendingNestedPoiEntryPlanState({
      cross_timeframe_context: mismatchedTimeframe,
      nested_poi_entry: plan,
    }).valid,
    false,
  );

  const mismatchedLifecycle = nestedLifecycleContext(plan);
  mismatchedLifecycle.impulseEntryLifecycle.candidates[0].id = "other-trigger";
  assertEquals(
    resolvePendingNestedPoiEntryPlanState({
      cross_timeframe_context: mismatchedLifecycle,
      nested_poi_entry: plan,
    }).valid,
    false,
  );

  const observedLifecycle = nestedLifecycleContext(plan);
  observedLifecycle.impulseEntryLifecycle.mode = "observe";
  assertEquals(
    resolvePendingNestedPoiEntryPlanState({
      cross_timeframe_context: observedLifecycle,
      nested_poi_entry: plan,
    }).valid,
    false,
  );

  const oppositeDirectionLifecycle = nestedLifecycleContext(plan);
  oppositeDirectionLifecycle.impulseEntryLifecycle.impulse.direction = "short";
  assertEquals(
    resolvePendingNestedPoiEntryPlanState({
      cross_timeframe_context: oppositeDirectionLifecycle,
      nested_poi_entry: plan,
    }).valid,
    false,
  );
});

Deno.test("declared nested route rejects a frozen observation with no selected trigger", () => {
  const plan = {
    ...nestedPoiPlan(),
    selected: null,
    candidates: [],
    reason: "no_contained_trigger",
  };
  assertEquals(
    resolvePendingNestedPoiEntryPlanState({
      confirmation_config: { entryMode: "nested_poi_market" },
      nested_poi_entry: plan,
    }),
    {
      declared: true,
      valid: false,
      plan: null,
      reason: "nested_poi_frozen_plan_unavailable",
    },
  );
});

Deno.test("paper-only observation plan does not declare an executable nested route", () => {
  const plan = {
    ...nestedPoiPlan(),
    route: "observe" as const,
  };

  assertEquals(
    resolvePendingNestedPoiEntryPlanState({
      confirmation_config: { entryMode: "confirmation" },
      nested_poi_entry: plan,
    }),
    {
      declared: false,
      valid: true,
      plan,
      reason: "nested_poi_not_declared",
    },
  );
});

Deno.test("nested POI plan rejects impossible mode and route combinations", () => {
  assertEquals(
    normalizeNestedPoiEntryPlan({
      ...nestedPoiPlan(),
      mode: "observe",
      route: "nested_poi_market",
    }),
    null,
  );
  assertEquals(
    normalizeNestedPoiEntryPlan({
      ...nestedPoiPlan(),
      mode: "enforce_live",
      route: "observe",
    }),
    null,
  );
  assertEquals(
    normalizeNestedPoiEntryPlan({
      ...nestedPoiPlan(),
      mode: "off",
      route: "observe",
    }),
    null,
  );
});

Deno.test("nested POI plan rejects a missing effective route", () => {
  const plan = nestedPoiPlan();
  delete (plan as any).route;

  assertEquals(normalizeNestedPoiEntryPlan(plan), null);
});
