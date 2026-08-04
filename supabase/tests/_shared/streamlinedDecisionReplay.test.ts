import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildStreamlinedReplay } from "../../functions/_shared/streamlinedDecisionReplay.ts";

const base = {
  contractVersion: "streamlined-trade-decision.v1",
  observationOnly: true, affectsAuthorization: false,
  completeness: { complete: true, coveragePercent: 100, unavailable: [] },
  proposedDecision: { decision: "allow", reasonCodes: [] },
};

Deno.test("replay compares only complete point-in-time summaries", () => {
  const result = buildStreamlinedReplay([
    { id: "1", symbol: "EUR/USD", direction: "long", pnl: 10, created_at: "2026-08-03", streamlined_decision_origin: { summary: base } },
  ], [
    { id: "2", symbol: "GBP/USD", direction: "short", outcome_status: "pending", created_at: "2026-08-02" },
  ]);
  assertEquals(result.summary.sampleSize, 2);
  assertEquals(result.summary.comparable, 1);
  assertEquals(result.summary.winnersPreserved, 1);
  assertEquals(result.summary.unavailable, 1);
});
