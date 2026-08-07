import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildAuthorityOutcomeComparison } from "../functions/_shared/authorityOutcomeComparison.ts";

const state = (stage: string, passed: boolean) => ({ contractVersion: "canonical-scanner-state.v1", stage, reasonCode: stage, explanation: stage, authorities: [{ role: "direction", available: true, passed }] });

Deno.test("authority comparison separates complete and compatible evidence", () => {
  const report = buildAuthorityOutcomeComparison([], [
    { id: "1", symbol: "EUR/USD", direction: "long", outcome_status: "would_have_won", outcome_r: 2, rejected_at: "2026-08-07T02:00:00Z", decision_outcome_snapshot: { contractVersion: "decision-outcome.v1", compatibility: "complete", authority: state("authorized", true) } },
    { id: "2", symbol: "GBP/USD", direction: "short", outcome_status: "would_have_lost", outcome_r: -1, rejected_at: "2026-08-07T01:00:00Z", raw_detail: { canonicalScannerState: state("blocked", false) } },
  ]);
  assertEquals(report.summary.complete, 1);
  assertEquals(report.summary.historicalCompatible, 1);
  assertEquals(report.summary.winnersPreserved, 1);
  assertEquals(report.summary.poorEntriesRejected, 1);
  assertEquals(report.components.find((item) => item.role === "direction")?.expectancyR, 2);
});
