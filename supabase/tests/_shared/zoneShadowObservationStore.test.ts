import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildZoneShadowObservationRows,
  zoneShadowDisagreementKey,
} from "./zoneShadowObservationStore.ts";

function candidate(
  candidateId: string,
  legacyRank: number,
  shadowRank: number,
): any {
  return {
    poi: {
      type: "ob",
      low: 1.274,
      high: 1.275,
      direction: "bullish",
    },
    localConfluence: {
      policyVersion: "zone-local-confluence.v1",
      enforcement: "observe_only",
      candidateId,
      zone: { low: 1.274, high: 1.275 },
      pipSize: 0.0001,
      atr: 0.002,
      items: [],
    },
    shadowRanking: {
      contractVersion: "zone-candidate-shadow-ranking.v1",
      enforcement: "observe_only",
      candidateId,
      legacyZoneScore: 3,
      legacyComparableScore: 3,
      shadowLocalScore: shadowRank === 1 ? 2 : 1,
      legacyRank,
      shadowRank,
      rankDelta: legacyRank - shadowRank,
      selectedEvidence: [],
      excludedEvidence: [],
      summary: {
        observedItems: 0,
        locallyQualifiedItems: 0,
        contextOnlyItems: 0,
        uniqueEntities: 0,
        creditedFamilies: 0,
      },
    },
    validationTrade: {
      direction: "long",
      entryPrice: 1.274,
      stopLoss: 1.2735,
      takeProfit: 1.28,
      source: "zone_bounds",
    },
  };
}

function modeledCandidate(
  candidateId: string,
  legacyRank: number,
  shadowRank: number,
  modelRank: number,
): any {
  const value = candidate(candidateId, legacyRank, shadowRank);
  value.candidateLifecycle = {
    contractVersion: "zone-candidate-model.v1",
    state: modelRank === 1 ? "tapped_and_held" : "fresh",
    retestCount: modelRank === 1 ? 1 : 0,
    maxPenetrationPercent: modelRank === 1 ? 35 : 0,
    lastTouchIndex: modelRank === 1 ? 4 : null,
    lastTouchClosedOutsideNearBoundary: modelRank === 1,
    violatedAtIndex: null,
    structureIntact: true,
    explanation: "test fixture",
  };
  value.candidateModel = {
    contractVersion: "zone-candidate-model.v1",
    enforcement: "observe_only",
    candidateId,
    rank: modelRank,
    topCandidate: modelRank <= 3,
    eligible: true,
    totalScore: 20 - modelRank,
    distanceToCurrentPrice: 0.001,
    distanceATR: 0.5,
    lifecycle: value.candidateLifecycle,
    factors: {
      zoneLocalConfluence: 2,
      proximityToCurrentPrice: 2,
      sweepQuality: 1.5,
      retestQuality: 2,
      displacementQuality: 3,
      structuralImportance: 2,
    },
  };
  value.timeframeLineage = {
    contractVersion: "cross-tf-zone-lineage.v1",
    enforcement: "observe_only",
    candidateId,
    candidateTimeframe: "5min",
    parentCandidateId: "parent-1h",
    parentTimeframe: "1h",
    relationship: modelRank === 1 ? "qualified_nested" : "context_only",
    directionAligned: true,
    overlapAmount: modelRank === 1 ? 0.001 : 0,
    overlapPercentOfChild: modelRank === 1 ? 100 : 0,
    parentDistance: modelRank === 1 ? 0 : 0.002,
    parentDistanceATR: modelRank === 1 ? 0 : 1,
    explanation: "test lineage",
  };
  return value;
}

const context = {
  userId: "57c79dee-db6b-4fae-b34a-4b64ce33ca34",
  botId: "smc",
  scanCycleId: "40d0a10c-3055-4feb-ade2-560adf73df81",
  symbol: "GBP/USD",
  tradingStyle: "scalper",
  stylePolicyVersion: "style-policy.v1.3",
  styleBasePolicyHash: "base",
  stylePolicyHash: "pair",
  observedAt: "2026-07-31T12:00:00Z",
};

Deno.test("zone shadow store records only competing winners when ranks disagree", () => {
  const rows = buildZoneShadowObservationRows({
    ...context,
    candidates: [
      candidate("legacy", 1, 2),
      candidate("shadow", 2, 1),
      candidate("third", 3, 3),
    ],
  });
  assertEquals(rows.length, 2);
  assertEquals(
    rows.map((row) => row.candidate_id).sort(),
    ["legacy", "shadow"],
  );
  assertEquals(rows.every((row) => row.ranking_disagreed === true), true);
  assertEquals(
    rows.find((row) => row.candidate_id === "legacy")?.legacy_winner,
    true,
  );
  assertEquals(
    rows.find((row) => row.candidate_id === "shadow")?.shadow_winner,
    true,
  );
});

Deno.test("zone shadow store skips agreement scans to avoid noisy data volume", () => {
  const rows = buildZoneShadowObservationRows({
    ...context,
    candidates: [candidate("same", 1, 1)],
  });
  assertEquals(rows, []);
});

Deno.test("zone shadow store records the observation-only model top three even when legacy and local agree", () => {
  const rows = buildZoneShadowObservationRows({
    ...context,
    candidates: [
      modeledCandidate("first", 1, 1, 1),
      modeledCandidate("second", 2, 2, 2),
      modeledCandidate("third", 3, 3, 3),
      modeledCandidate("fourth", 4, 4, 4),
    ],
  });
  assertEquals(rows.length, 3);
  assertEquals(
    rows.map((row) => row.candidate_model_rank),
    [1, 2, 3],
  );
  assertEquals(rows[0].candidate_model_winner, true);
  assertEquals(rows[0].candidate_lifecycle_state, "tapped_and_held");
  assertEquals(rows[0].timeframe_relationship, "qualified_nested");
  assertEquals(rows[0].parent_candidate_id, "parent-1h");
  assertEquals(rows[0].cross_tf_shadow_decision, "allow");
  assertEquals(rows[1].cross_tf_shadow_decision, "block");
  assertEquals(
    rows[1].cross_tf_reason_codes,
    ["parent_zone_too_far", "nested_impulse_required"],
  );
  assertEquals(rows.every((row) => row.ranking_disagreed === false), true);
});

Deno.test("cross-TF policy disagreement is persisted even when local rank agrees", () => {
  const value = modeledCandidate("legacy", 1, 1, 1);
  value.timeframeLineage = {
    ...value.timeframeLineage,
    relationship: "timeframe_conflict",
    directionAligned: false,
  };
  const rows = buildZoneShadowObservationRows({
    ...context,
    candidates: [value],
  });
  assertEquals(
    zoneShadowDisagreementKey([value])?.startsWith("authority:"),
    true,
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].legacy_execution_decision, "allow");
  assertEquals(rows[0].cross_tf_shadow_decision, "block");
  assertEquals(rows[0].cross_tf_disagreed, true);
});

Deno.test("zone shadow store preserves style provenance and validation levels", () => {
  const rows = buildZoneShadowObservationRows({
    ...context,
    candidates: [
      candidate("legacy", 1, 2),
      candidate("shadow", 2, 1),
    ],
  });
  assertEquals(rows[0].trading_style, "scalper");
  assertEquals(rows[0].style_policy_version, "style-policy.v1.3");
  assertEquals(rows[0].style_base_policy_hash, "base");
  assertEquals(rows[0].entry_price, 1.274);
  assertEquals(rows[0].stop_loss, 1.2735);
  assertEquals(rows[0].take_profit, 1.28);
  assertEquals(rows[0].evidence_source, "forward_observation");
  assertEquals(rows[0].activation_eligible, true);
});

Deno.test("zone shadow store separates retrospective evidence from activation", () => {
  const candidates = [
    candidate("legacy", 1, 2),
    candidate("shadow", 2, 1),
  ];
  assertEquals(
    zoneShadowDisagreementKey(candidates),
    "rank:legacy:shadow",
  );
  const rows = buildZoneShadowObservationRows({
    ...context,
    candidates,
    evidenceSource: "retrospective_replay",
    replayRunId: "0d2c5a6c-82ad-40a4-8e1f-0ffc7ee73afb",
    replayContractVersion: "zone-local-retrospective-replay.v1",
    activationEligible: false,
  });
  assertEquals(rows[0].evidence_source, "retrospective_replay");
  assertEquals(rows[0].activation_eligible, false);
  assertEquals(
    rows[0].replay_run_id,
    "0d2c5a6c-82ad-40a4-8e1f-0ffc7ee73afb",
  );
});
