import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deterministicICTEntryZoneReplayScanCycleId,
  persistICTEntryZoneReplayEvidence,
} from "../../functions/_shared/ictEntryZoneReplayEvidence.ts";

Deno.test("ICT entry-zone replay IDs are deterministic UUIDs", async () => {
  const first = await deterministicICTEntryZoneReplayScanCycleId(
    "11111111-1111-4111-8111-111111111111",
    "EUR/USD",
    "2026-08-01T12:00:00.000Z",
  );
  const second = await deterministicICTEntryZoneReplayScanCycleId(
    "11111111-1111-4111-8111-111111111111",
    "EUR/USD",
    "2026-08-01T12:00:00.000Z",
  );
  assertEquals(first, second);
  assertMatch(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

Deno.test("ICT entry-zone replay stores source-separated counterfactual outcomes", async () => {
  let stored: Record<string, unknown> | null = null;
  const client = {
    from: (table: string) => {
      assertEquals(table, "ict_entry_zone_authority_observations");
      return {
        upsert: (row: Record<string, unknown>) => {
          stored = row;
          return { select: () => Promise.resolve({ data: [{ id: "row" }], error: null }) };
        },
      };
    },
  };
  const result = await persistICTEntryZoneReplayEvidence(client, {
    userId: "user",
    botId: "smc",
    replayRunId: "11111111-1111-4111-8111-111111111111",
    symbol: "EUR/USD",
    tradingStyle: "day_trader",
    observedAt: "2026-08-01T12:00:00.000Z",
    pipSize: 0.0001,
    legacyBestZone: {
      zone: {
        poi: { type: "ob", low: 104, high: 105, direction: "bullish" },
        localConfluence: { candidateId: "legacy-ob" },
        validationTrade: {
          direction: "long",
          entryPrice: 105,
          stopLoss: 104,
          takeProfit: 108,
          source: "zone_bounds",
        },
      },
    } as any,
    authority: {
      contractVersion: "ict-entry-zone-authority.v1",
      enforcement: "observe_only",
      selected: {
        id: "authority-ob+fvg",
        type: "ob_fvg",
        direction: "bullish",
        low: 99.8,
        high: 100,
        score: 10,
        componentIds: ["authority-ob", "authority-fvg"],
        validationTrade: { entryPrice: 100, stopLoss: 99, takeProfit: 102 },
      },
      ranked: [],
      explanation: "test",
    } as any,
    candles: [
      { datetime: "2026-08-01T12:05:00.000Z", open: 105, high: 105.5, low: 104.5, close: 105 },
      { datetime: "2026-08-01T12:10:00.000Z", open: 105, high: 105, low: 103.5, close: 104 },
      { datetime: "2026-08-01T12:15:00.000Z", open: 100.2, high: 100.5, low: 99.8, close: 100 },
      { datetime: "2026-08-01T12:20:00.000Z", open: 100, high: 102, low: 100, close: 102 },
    ],
  });
  assertEquals(result.inserted, true);
  assertEquals(stored?.evidence_source, "retrospective_replay");
  assertEquals(stored?.activation_eligible, false);
  assertEquals(stored?.outcome_status, "would_have_won");
  assertEquals(stored?.legacy_outcome_status, "would_have_lost");
});
