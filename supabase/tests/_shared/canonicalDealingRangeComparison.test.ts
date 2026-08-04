import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildLast100Comparison,
  comparisonRecordFromClosed,
  comparisonRecordFromRejected,
} from "../../functions/_shared/canonicalDealingRangeComparison.ts";

const canonical = { available: true, allowed: false, percent: 32.4, explanation: "Short rejected" };

Deno.test("comparison reads closed final authorization and explicit rolling observation", () => {
  const row = comparisonRecordFromClosed({
    id: "c1", symbol: "EUR/USD", direction: "short", pnl: 10, closed_at: "2026-08-03T12:00:00Z",
    signal_reason: JSON.stringify({
      canonicalDealingRangeObservation: { rollingAllowed: true },
      finalAuthorization: { canonicalDealingRange: canonical },
    }),
  });
  assertEquals(row.outcome, "won");
  assertEquals(row.canonicalAllowed, false);
  assertEquals(row.decisionsMatch, false);
});

Deno.test("comparison reads rejected observation and outcome", () => {
  const row = comparisonRecordFromRejected({
    id: "r1", symbol: "EUR/USD", direction: "short", outcome_status: "would_have_lost",
    raw_detail: { canonicalDealingRangeObservation: { rollingAllowed: true, canonical } },
  });
  assertEquals(row.outcome, "lost");
  assertEquals(row.canonicalAllowed, false);
});

Deno.test("last-100 summary separates unavailable evidence", () => {
  const result = buildLast100Comparison([
    { id: "old", pnl: -1, closed_at: "2026-08-01", signal_reason: "{}" },
  ], [{
    id: "new", outcome_status: "would_have_lost", rejected_at: "2026-08-03",
    raw_detail: { canonicalDealingRangeObservation: { rollingAllowed: true, canonical } },
  }]);
  assertEquals(result.summary.sampleSize, 2);
  assertEquals(result.summary.available, 1);
  assertEquals(result.summary.unavailable, 1);
  assertEquals(result.summary.poorEntriesRejected, 1);
});
