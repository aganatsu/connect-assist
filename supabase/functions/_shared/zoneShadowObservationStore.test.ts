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
    "legacy:shadow",
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
