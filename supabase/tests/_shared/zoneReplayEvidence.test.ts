import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cleanupZoneReplayEvidence,
  deterministicReplayScanCycleId,
  persistZoneReplayEvidence,
  ZONE_LOCAL_REPLAY_CONTRACT_VERSION,
} from "../../functions/_shared/zoneReplayEvidence.ts";

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
      stopLoss: 1.273,
      takeProfit: 1.276,
      source: "zone_bounds",
    },
  };
}

function fakeClient(captured: Record<string, unknown>[]) {
  return {
    from: () => ({
      upsert: (rows: Record<string, unknown>[]) => {
        captured.push(...rows);
        return {
          select: () =>
            Promise.resolve({
              data: rows.map((_, index) => ({ id: `${index}` })),
              error: null,
            }),
        };
      },
    }),
  };
}

Deno.test("retrospective replay identity is deterministic and UUID-shaped", async () => {
  const first = await deterministicReplayScanCycleId(
    "40d0a10c-3055-4feb-ade2-560adf73df81",
    "GBP/USD",
    "legacy:local",
  );
  const second = await deterministicReplayScanCycleId(
    "40d0a10c-3055-4feb-ade2-560adf73df81",
    "GBP/USD",
    "legacy:local",
  );
  assertEquals(first, second);
  assertMatch(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

Deno.test("retrospective replay stores resolved non-activating evidence", async () => {
  const captured: Record<string, unknown>[] = [];
  const result = await persistZoneReplayEvidence(fakeClient(captured), {
    userId: "57c79dee-db6b-4fae-b34a-4b64ce33ca34",
    botId: "smc",
    replayRunId: "40d0a10c-3055-4feb-ade2-560adf73df81",
    symbol: "GBP/USD",
    tradingStyle: "day_trader",
    stylePolicyVersion: "style-policy.v1.3",
    styleBasePolicyHash: "base",
    stylePolicyHash: "pair",
    observedAt: "2026-07-01T00:00:00Z",
    candidates: [
      candidate("legacy", 1, 2),
      candidate("local", 2, 1),
    ],
    pipSize: 0.0001,
    candles: [
      {
        datetime: "2026-07-01T01:00:00Z",
        open: 1.274,
        high: 1.2765,
        low: 1.2738,
        close: 1.276,
      },
    ],
  });

  assertEquals(result.disagreement, true);
  assertEquals(result.inserted, 2);
  assertEquals(captured.length, 2);
  assertEquals(
    captured.every((row) =>
      row.evidence_source === "retrospective_replay" &&
      row.activation_eligible === false &&
      row.replay_contract_version === ZONE_LOCAL_REPLAY_CONTRACT_VERSION
    ),
    true,
  );
  assertEquals(captured[0].outcome_status, "would_have_won");
  assertEquals(captured[0].price_reached_entry, true);
});

Deno.test("incomplete replay evidence can be removed by run identity", async () => {
  const calls: Array<[string, string]> = [];
  const client = {
    from: () => ({
      delete: () => ({
        eq: (column: string, value: string) => {
          calls.push([column, value]);
          return {
            eq: (nextColumn: string, nextValue: string) => {
              calls.push([nextColumn, nextValue]);
              return Promise.resolve({ error: null });
            },
          };
        },
      }),
    }),
  };

  await cleanupZoneReplayEvidence(
    client,
    "40d0a10c-3055-4feb-ade2-560adf73df81",
  );
  assertEquals(calls, [
    ["replay_run_id", "40d0a10c-3055-4feb-ade2-560adf73df81"],
    ["evidence_source", "retrospective_replay"],
    ["replay_run_id", "40d0a10c-3055-4feb-ade2-560adf73df81"],
    ["evidence_source", "retrospective_replay"],
  ]);
});
