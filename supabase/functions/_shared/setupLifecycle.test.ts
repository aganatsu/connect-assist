import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFrozenSetupStrategyContext,
  buildSetupLifecycleEvidence,
  canTransitionSetup,
  resolvePendingConfirmationMethod,
  resolvePendingIndicatorMinimum,
  resolvePendingMaxConfirmationAttempts,
  resolvePendingStylePolicy,
  validateFrozenSetupIdentity,
} from "./setupLifecycle.ts";

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
