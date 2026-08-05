import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildICTEntryZoneObservationRow } from "../../functions/_shared/ictEntryZoneObservationStore.ts";

Deno.test("ICT entry zone observation persists the authority counterfactual", () => {
  const row = buildICTEntryZoneObservationRow({
    userId: "user",
    botId: "smc",
    scanCycleId: "scan",
    symbol: "EUR/USD",
    tradingStyle: "day_trader",
    observedAt: "2026-08-05T12:00:00.000Z",
    legacyBestZone: {
      zone: {
        poi: { type: "ob", low: 1.1, high: 1.101 },
        localConfluence: { candidateId: "legacy-ob" },
      },
    } as any,
    authority: {
      contractVersion: "ict-entry-zone-authority.v1",
      enforcement: "observe_only",
      selected: {
        id: "ob+fvg",
        type: "ob_fvg",
        direction: "bullish",
        low: 1.1005,
        high: 1.101,
        score: 9,
        componentIds: ["ob", "fvg"],
        validationTrade: {
          entryPrice: 1.1005,
          stopLoss: 1.099,
          takeProfit: 1.11,
        },
      },
      ranked: [],
      explanation: "test",
    } as any,
  });
  assertEquals(row?.legacy_candidate_id, "legacy-ob");
  assertEquals(row?.authority_zone_type, "ob_fvg");
  assertEquals(row?.disagreed, true);
  assertEquals(row?.entry_price, 1.1005);
});
