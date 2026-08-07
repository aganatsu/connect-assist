import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildCanonicalScannerComparison, workflowDecisionForStage } from "../functions/_shared/canonicalScannerComparison.ts";

const state = (stage: string) => ({ contractVersion: "canonical-scanner-state.v1", observationOnly: true, affectsAuthorization: false, evaluatedAt: "2026-08-07T12:00:00Z", identity: { candidateId: "c", symbol: "EUR/USD", direction: "long" }, stage, reasonCode: `${stage}_reason`, explanation: stage, authorities: [] });

Deno.test("workflow stages retain allow watch and block semantics", () => {
  assertEquals(workflowDecisionForStage("authorized"), "allow");
  assertEquals(workflowDecisionForStage("awaiting_confirmation"), "watch");
  assertEquals(workflowDecisionForStage("invalidated"), "block");
});

Deno.test("comparison aggregates outcomes and stage counts", () => {
  const result = buildCanonicalScannerComparison(
    [{ id: "1", symbol: "EUR/USD", direction: "long", pnl: 10, signal_reason: { canonicalScannerState: state("authorized") } }],
    [{ id: "2", symbol: "GBP/USD", direction: "short", outcome_status: "would_have_lost", raw_detail: { canonicalScannerState: state("blocked") } }, { id: "3", symbol: "USD/JPY", direction: "long", outcome_status: "would_have_won", raw_detail: { canonicalScannerState: state("awaiting_confirmation") } }],
  );
  assertEquals(result.summary.comparable, 3);
  assertEquals(result.summary.winnersPreserved, 1);
  assertEquals(result.summary.poorEntriesRejected, 1);
  assertEquals(result.summary.workflowWatches, 1);
  assertEquals(result.summary.stageCounts.awaiting_confirmation, 1);
});

Deno.test("comparison reports unavailable historical rows", () => {
  const result = buildCanonicalScannerComparison([], [{ id: "old", symbol: "EUR/USD", direction: "long", raw_detail: {} }]);
  assertEquals(result.summary.unavailable, 1);
  assertEquals(result.rows[0].comparable, false);
});
