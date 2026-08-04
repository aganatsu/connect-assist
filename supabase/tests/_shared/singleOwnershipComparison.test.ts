import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildSingleOwnershipComparison } from "./singleOwnershipComparison.ts";

const observation = {
  contractVersion: "single-ownership-decision.v1",
  completeness: { complete: true, unavailable: [] },
  decision: "allow",
  reasonCodes: [],
  legacyDiagnostics: { effectiveScore: 20, threshold: 30 },
};

Deno.test("comparison reports winner preservation and unavailable legacy rows", () => {
  const result = buildSingleOwnershipComparison([
    { id: "1", symbol: "EUR/USD", direction: "long", pnl: 10, created_at: "2026-08-03", signal_reason: { singleOwnershipDecision: observation } },
  ], [
    { id: "2", symbol: "GBP/USD", direction: "short", outcome_status: "pending", created_at: "2026-08-02", raw_detail: {} },
  ]);
  assertEquals(result.summary.sampleSize, 2);
  assertEquals(result.summary.comparable, 1);
  assertEquals(result.summary.winnersPreserved, 1);
  assertEquals(result.summary.unavailable, 1);
});
