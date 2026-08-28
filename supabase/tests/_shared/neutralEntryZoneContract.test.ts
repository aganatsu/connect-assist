import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFrozenSetupStrategyContext,
  FROZEN_ENTRY_ZONE_VERSION,
  FROZEN_SETUP_POLICY_VERSION,
  readFrozenSetupStrategyContext,
} from "../../functions/_shared/setupLifecycle.ts";
import {
  evaluateSingleOwnershipDecision,
  normalizeSingleOwnershipDecision,
  SINGLE_OWNERSHIP_DECISION_VERSION,
} from "../../functions/_shared/singleOwnershipDecision.ts";
import {
  CANONICAL_SCANNER_STATE_VERSION,
  normalizeCanonicalScannerState,
  projectCanonicalScannerState,
} from "../../functions/_shared/canonicalScannerState.ts";

function stylePolicy(): any {
  return {
    contractVersion: "style-policy.v1.3",
    basePolicyHash: "scalper-base",
    policyHash: "scalper-exact",
    enforcement: "observe_only",
    scope: "pair",
    style: "scalper",
    symbol: "GBP/USD",
    resolvedAt: "2026-08-28T12:00:00.000Z",
    timeframes: {
      roles: {
        bias: "1h",
        structure: "15min",
        setup: "5min",
        confirmation: "5min",
        refinement: "1min",
      },
      runtimeEntry: "5min",
      runtimeHTF: "1h",
    },
    cadence: { scanIntervalMinutes: 5 },
    qualification: {},
    risk: {},
    management: {},
    lifecycle: {
      gamePlanValidityMinutes: 120,
      stagingTTLMinutes: 60,
      limitOrderExpiryMinutes: 120,
      maxConfirmationAttempts: 2,
    },
    provenance: {
      profileAppliedToRuntime: true,
      styleApplied: [],
      userOverridesPreserved: [],
    },
  };
}

function currentFrozenContext() {
  return buildFrozenSetupStrategyContext({
    identity: {
      setupId: "setup-1",
      candidateId: "lifecycle-candidate-1",
    },
    timeframeEvidenceId: "timeframe-evidence-1",
    symbol: "GBP/USD",
    direction: "long",
    stylePolicy: stylePolicy(),
    gamePlan: null,
    directionVerdict: null,
    conceptEvidence: [
      {
        contractVersion: "concept-evidence.v1",
        entityId: "order_block:entity-1",
        evidenceId: "order_block:evidence-1",
        concept: "order_block",
        detector: { name: "detectOrderBlocks", version: "1" },
        symbol: "GBP/USD",
        timeframe: "5m",
        observedAt: "2026-08-28T12:05:00.000Z",
        sourceCandleStart: "2026-08-28T11:50:00.000Z",
        sourceCandleEnd: "2026-08-28T11:55:00.000Z",
        direction: "bullish",
        bounds: { low: 1.2, high: 1.21 },
        level: null,
        lifecycle: "fresh",
        attributes: {},
      },
    ],
    entryZone: {
      setupFamily: "structure_poi",
      candidateId: "structure_poi:order_block:entity-1",
      sourceContextId: "structure-context-1",
      sourceEvidenceIds: [
        "order_block:evidence-1",
        "order_block:evidence-1",
      ],
      type: "ob",
      timeframe: "5min",
      low: 1.2,
      high: 1.21,
      lifecycle: "fresh",
      entry: 1.205,
      structuralInvalidation: 1.198,
      positionStop: 1.1975,
      target: 1.22,
    },
    confirmationMethod: "choch",
    frozenAt: "2026-08-28T12:05:00.000Z",
  });
}

Deno.test("frozen setup v2 owns one neutral style-aware entry-zone contract", () => {
  const frozen = currentFrozenContext();

  assertEquals(frozen.contractVersion, FROZEN_SETUP_POLICY_VERSION);
  assertEquals(FROZEN_SETUP_POLICY_VERSION, "setup-policy-freeze.v2");
  assertExists(frozen.entryZone);
  assertEquals(frozen.entryZone.contractVersion, FROZEN_ENTRY_ZONE_VERSION);
  assertEquals(frozen.entryZone.setupFamily, "structure_poi");
  assertEquals(
    frozen.entryZone.candidateId,
    "structure_poi:order_block:entity-1",
  );
  assertEquals(frozen.entryZone.sourceEvidenceIds, [
    "order_block:evidence-1",
  ]);
  assertEquals(frozen.entryZone.timeframe, "5m");
  assertEquals(frozen.entryZone.bounds, { low: 1.2, high: 1.21 });
  assertEquals(frozen.entryZone.geometry, {
    entry: 1.205,
    structuralInvalidation: 1.198,
    positionStop: 1.1975,
    target: 1.22,
  });
  assertEquals(frozen.entryZone.stylePolicy.policyHash, "scalper-exact");
  assertEquals(frozen.entryZone.timeframeRoles.setup, "5m");
  assertEquals(frozen.entryZone.enforcement, "observe_only");
  assertEquals(frozen.entryZone.affectsAuthorization, false);
  assertEquals("scenarioZoneStory" in frozen, false);
  assertEquals(frozen.scenarioStory.enforcement, "observe_only");
});

Deno.test("frozen setup accepts the existing structure-POI selector identity", () => {
  const frozen = buildFrozenSetupStrategyContext({
    identity: {
      setupId: "setup-2",
      candidateId: "lifecycle-candidate-2",
    },
    symbol: "GBP/USD",
    direction: "long",
    stylePolicy: stylePolicy(),
    gamePlan: null,
    directionVerdict: null,
    entryZone: {
      setupFamily: "structure_poi",
      id: "structure_poi:order_block:entity-2",
      contextId: "structure-context-2",
      sourceEvidenceIds: ["order_block:evidence-2"],
      sourceWindow: {
        start: "2026-08-28T11:50:00.000Z",
        end: "2026-08-28T11:55:00.000Z",
      },
      type: "ob",
      timeframe: "5min",
      low: 1.2,
      high: 1.21,
      entry: 1.205,
      structuralInvalidation: 1.198,
      positionStop: 1.1975,
      target: 1.22,
    },
    confirmationMethod: "choch",
    frozenAt: "2026-08-28T12:05:00.000Z",
  });

  assertEquals(
    frozen.entryZone?.candidateId,
    "structure_poi:order_block:entity-2",
  );
  assertEquals(frozen.entryZone?.sourceContextId, "structure-context-2");
});

Deno.test("frozen setup v2 rejects entry-zone style or timestamp drift", () => {
  const styleDrift = JSON.parse(JSON.stringify(currentFrozenContext()));
  styleDrift.entryZone.stylePolicy.policyHash = "different-policy";
  assertEquals(
    readFrozenSetupStrategyContext({ frozen_strategy_context: styleDrift }),
    null,
  );

  const timestampDrift = JSON.parse(JSON.stringify(currentFrozenContext()));
  timestampDrift.entryZone.frozenAt = "2026-08-28T12:06:00.000Z";
  assertEquals(
    readFrozenSetupStrategyContext({ frozen_strategy_context: timestampDrift }),
    null,
  );
});

Deno.test("legacy frozen setup rows are read through the neutral entry-zone adapter", () => {
  const current = currentFrozenContext() as any;
  const legacy = {
    ...current,
    contractVersion: "setup-policy-freeze.v1",
    scenarioZoneStory: {
      contractVersion: "scenario-zone-story.v1",
      enforcement: "observe_only",
      originatingZone: {
        candidateId: "legacy-zone-1",
        type: "fvg",
        low: 1.201,
        high: 1.204,
        entry: 1.204,
        stopLoss: 1.198,
        takeProfit: 1.216,
        selectedTimeframe: "5min",
        signalSource: "standalone",
      },
      scenarioCandidates: [],
      selectedScenarioIndex: null,
      status: "no_directional_scenario",
      reason: "legacy row",
    },
  };
  delete legacy.entryZone;
  delete legacy.scenarioStory;

  const read = readFrozenSetupStrategyContext({
    frozen_strategy_context: legacy,
  });

  assertExists(read);
  assertEquals(read.contractVersion, "setup-policy-freeze.v2");
  assertEquals(read.entryZone?.setupFamily, "impulse");
  assertEquals(read.entryZone?.candidateId, "legacy-zone-1");
  assertEquals(read.entryZone?.timeframe, "5m");
  assertEquals(read.entryZone?.geometry.positionStop, 1.198);
  assertEquals(read.scenarioStory.reason, "legacy row");
  assertEquals("scenarioZoneStory" in read, false);
});

Deno.test("single ownership emits entry-zone authority and reads legacy zone-story decisions", () => {
  const decision = evaluateSingleOwnershipDecision({
    evaluatedAt: "2026-08-28T12:05:00.000Z",
    identity: {
      candidateId: "lifecycle-candidate-1",
      symbol: "GBP/USD",
      direction: "long",
    },
    direction: { verdict: "long", shouldBlock: false },
    entryZone: {
      available: true,
      valid: true,
      entryReady: true,
      source: "structure_poi",
      candidateId: "structure_poi:order_block:entity-1",
      setupFamily: "structure_poi",
      sourceEvidenceIds: ["order_block:evidence-1"],
      reasonCodes: [],
    },
    canonicalLocation: { required: false, available: true, allowed: true },
    confirmation: { required: true, passed: true, reasonCodes: [] },
    thesis: { required: false, valid: true, reasonCodes: [] },
    safety: { complete: true, checks: [] },
  });
  assertEquals(decision.contractVersion, SINGLE_OWNERSHIP_DECISION_VERSION);
  assertEquals(
    SINGLE_OWNERSHIP_DECISION_VERSION,
    "single-ownership-decision.v2",
  );
  assertEquals(decision.authorities.entryZone.setupFamily, "structure_poi");
  assertEquals("zoneStory" in decision.authorities, false);

  const legacy = normalizeSingleOwnershipDecision({
    ...decision,
    contractVersion: "single-ownership-decision.v1",
    authorities: {
      ...decision.authorities,
      zoneStory: decision.authorities.entryZone,
      entryZone: undefined,
    },
    reasonCodes: ["zone_story_waiting"],
    completeness: {
      complete: false,
      unavailable: ["zone_story_entry_readiness"],
    },
  });
  assertExists(legacy);
  assertEquals(legacy.authorities.entryZone.source, "structure_poi");
  assertEquals(legacy.reasonCodes, ["entry_zone_waiting"]);
  assertEquals(legacy.completeness.unavailable, [
    "entry_zone_entry_readiness",
  ]);
});

Deno.test("malformed persisted entry-zone decisions fail closed", () => {
  const malformed = normalizeSingleOwnershipDecision({
    contractVersion: "single-ownership-decision.v2",
    authorities: {
      entryZone: {
        available: true,
        valid: true,
        entryReady: true,
        source: "structure_poi",
      },
    },
    decision: "allow",
    reasonCodes: [],
    completeness: { complete: true, unavailable: [] },
  });
  assertEquals(malformed, null);
});

Deno.test("canonical scanner v2 exposes entry_zone and normalizes v1 evidence", () => {
  const current = projectCanonicalScannerState({
    evaluatedAt: "2026-08-28T12:05:00.000Z",
    identity: {
      candidateId: "lifecycle-candidate-1",
      symbol: "GBP/USD",
      direction: "long",
    },
    direction: { available: true, allowed: true },
    zone: { available: false, valid: null, atPoi: false },
    location: { required: false, available: true, allowed: true },
    liquidity: { policy: "not_required", state: "none" },
    confirmation: { required: false, passed: true },
    thesis: { required: false, valid: true },
    safety: { complete: true, passed: true },
  });
  assertEquals(current.contractVersion, CANONICAL_SCANNER_STATE_VERSION);
  assertEquals(CANONICAL_SCANNER_STATE_VERSION, "canonical-scanner-state.v2");
  assertEquals(current.reasonCode, "entry_zone_pending");
  assertEquals(
    current.authorities.some((authority) => authority.role === "entry_zone"),
    true,
  );
  assertEquals(
    current.authorities.some((authority) =>
      String(authority.role) === "impulse_zone"
    ),
    false,
  );

  const legacy = normalizeCanonicalScannerState({
    ...current,
    contractVersion: "canonical-scanner-state.v1",
    authorities: current.authorities.map((authority) =>
      authority.role === "entry_zone"
        ? { ...authority, role: "impulse_zone" }
        : authority
    ),
  });
  assertExists(legacy);
  assertEquals(legacy.contractVersion, "canonical-scanner-state.v2");
  assertEquals(
    legacy.authorities.some((authority) => authority.role === "entry_zone"),
    true,
  );
});
