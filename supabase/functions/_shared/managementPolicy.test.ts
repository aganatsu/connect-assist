import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveBacktestManagementPolicy,
  resolvePositionManagementPolicy,
} from "./managementPolicy.ts";
import type { ResolvedStylePolicy } from "./stylePolicy.ts";

const FROZEN_STYLE_POLICY: ResolvedStylePolicy = {
  contractVersion: "style-policy.v1.3",
  basePolicyHash: "base-policy",
  policyHash: "pair-policy",
  enforcement: "observe_only",
  scope: "pair",
  style: "scalper",
  symbol: "GBP/USD",
  resolvedAt: "2026-07-30T12:00:00.000Z",
  timeframes: {
    roles: {
      bias: "1h",
      structure: "15min",
      setup: "5min",
      confirmation: "5min",
      refinement: "1min",
    },
    runtimeEntry: "5m",
    runtimeHTF: "1h",
  },
  cadence: { scanIntervalMinutes: 5 },
  qualification: {
    minConfluence: 20,
    effectiveMinConfluence: 20,
    minRiskReward: 1.5,
    minTier1Factors: 1,
    impulseZoneGateMode: "hard",
    minZoneScore: 5,
  },
  risk: {
    riskPerTrade: 0.5,
    positionSizingMethod: "risk_based",
    maxOpenPositions: 4,
    maxPerSymbol: 1,
    portfolioHeat: 2,
    slMethod: "structure",
    slBufferPips: 2,
    tpMethod: "rr_ratio",
    tpRatio: 2,
  },
  management: {
    breakEvenEnabled: true,
    breakEvenPips: 15,
    breakEvenOffsetPips: 3,
    trailingStopEnabled: true,
    trailingStopPips: 12.5,
    trailingStopActivation: "after_1r",
    partialTPEnabled: true,
    partialTPPercent: 50,
    partialTPLevel: 1,
    maxHoldEnabled: true,
    maxHoldHours: 4,
    structureInvalidationEnabled: true,
    adaptiveTrailingEnabled: true,
    baseTrailATRMultiple: 1.25,
    momentumFadeThreshold: 0.35,
    trailTightenFactor: 0.55,
    trailWidenFactor: 1.2,
  },
  lifecycle: {
    gamePlanValidityMinutes: 120,
    stagingTTLMinutes: 30,
    limitOrderExpiryMinutes: 20,
    maxConfirmationAttempts: 3,
  },
  provenance: {
    profileAppliedToRuntime: true,
    styleApplied: [],
    userOverridesPreserved: [],
  },
};

function frozenPosition(overrides: Record<string, unknown> = {}) {
  const frozen = {
    contractVersion: "setup-policy-freeze.v1",
    frozenAt: "2026-07-30T12:00:00.000Z",
    setupId: "setup-1",
    candidateId: "candidate-1",
    symbol: "GBP/USD",
    direction: "long",
    stylePolicy: FROZEN_STYLE_POLICY,
    decisionContext: null,
    gamePlan: { id: "gp-1", version: "gp-v1", validityPolicy: null },
    directionVerdict: null,
    scenarioZoneStory: {
      contractVersion: "scenario-zone-story.v1",
      enforcement: "observe_only",
      originatingZone: null,
      scenarioCandidates: [],
      selectedScenarioIndex: null,
      status: "no_directional_scenario",
      reason: "test",
    },
    confirmation: {
      method: "indicators",
      indicatorMinCount: 3,
      maxAttempts: 3,
      timeframe: "5min",
      refinementTimeframe: "1min",
    },
  };
  return {
    symbol: "GBP/USD",
    direction: "long",
    signal_reason: JSON.stringify({
      frozenStrategyContext: frozen,
      exitFlags: {
        breakEvenEnabled: true,
        breakEvenPips: 15,
        breakEvenOffsetPips: 3,
        trailingStopEnabled: true,
        trailingStopPips: 12.5,
        trailingStopActivation: "after_1r",
        partialTPEnabled: true,
        partialTPPercent: 50,
        partialTPLevel: 1,
        maxHoldEnabled: true,
        maxHoldHours: 4,
      },
    }),
    ...overrides,
  };
}

const CHANGED_RUNTIME = {
  tradingStyle: { mode: "swing_trader" },
  breakEvenEnabled: false,
  breakEvenPips: 50,
  breakEvenOffsetPips: 0,
  trailingStopEnabled: false,
  trailingStopPips: 30,
  trailingStopActivation: "after_2r",
  partialTPEnabled: false,
  partialTPPercent: 25,
  partialTPLevel: 2,
  maxHoldEnabled: false,
  maxHoldHours: 72,
  structureInvalidationEnabled: false,
  adaptiveTrailingEnabled: false,
};

Deno.test("open position keeps its frozen management policy after Bot Config changes", () => {
  const policy = resolvePositionManagementPolicy(
    frozenPosition(),
    CHANGED_RUNTIME,
  );

  assertEquals(policy.source, "frozen_setup");
  assertEquals(policy.tradingStyle, "scalper");
  assertEquals(policy.stylePolicyHash, "pair-policy");
  assertEquals(policy.decision.breakEvenEnabled, true);
  assertEquals(policy.decision.trailingStopPips, 12.5);
  assertEquals(policy.decision.adaptiveTrailingEnabled, true);
  assertEquals(policy.decision.maxHoldHours, 4);
  assertEquals(policy.partialTPPercent, 50);
});

Deno.test("explicit per-trade override can intentionally change a frozen position", () => {
  const policy = resolvePositionManagementPolicy(
    frozenPosition({
      trade_overrides: JSON.stringify({
        trailingStopEnabled: false,
        partialTPPercent: 30,
      }),
    }),
    CHANGED_RUNTIME,
  );

  assertEquals(policy.source, "frozen_setup");
  assertEquals(policy.decision.trailingStopEnabled, false);
  assertEquals(policy.partialTPPercent, 30);
  assertEquals(policy.decision.breakEvenEnabled, true);
});

Deno.test("legacy entry exitFlags beat later runtime changes", () => {
  const policy = resolvePositionManagementPolicy(
    {
      signal_reason: JSON.stringify({
        exitFlags: {
          breakEvenEnabled: true,
          trailingStopEnabled: true,
          trailingStopPips: 10,
          partialTPEnabled: true,
          partialTPPercent: 40,
          partialTPLevel: 1,
          maxHoldEnabled: true,
          maxHoldHours: 6,
        },
      }),
    },
    CHANGED_RUNTIME,
  );

  assertEquals(policy.source, "position_snapshot");
  assertEquals(policy.decision.trailingStopEnabled, true);
  assertEquals(policy.decision.trailingStopPips, 10);
  assertEquals(policy.partialTPPercent, 40);
  assertEquals(policy.decision.maxHoldHours, 6);
});

Deno.test("backtest resolves the same frozen management projection", () => {
  const live = resolvePositionManagementPolicy(
    frozenPosition(),
    CHANGED_RUNTIME,
  );
  const backtest = resolveBacktestManagementPolicy(
    FROZEN_STYLE_POLICY,
    CHANGED_RUNTIME,
  );

  assertEquals(backtest.decision, live.decision);
  assertEquals(backtest.partialTPPercent, live.partialTPPercent);
  assertEquals(backtest.partialTPLevel, live.partialTPLevel);
  assertEquals(backtest.stylePolicyHash, live.stylePolicyHash);
});
