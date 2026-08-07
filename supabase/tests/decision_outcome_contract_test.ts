import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildDecisionOutcomeSnapshot, outcomeWindowForStyle } from "../functions/_shared/decisionOutcomeContract.ts";

Deno.test("style-specific outcome windows are deterministic", () => {
  assertEquals(outcomeWindowForStyle("scalper"), 8);
  assertEquals(outcomeWindowForStyle("day_trader"), 24);
  assertEquals(outcomeWindowForStyle("swing_trader"), 72);
});

Deno.test("snapshot separates authority from legacy diagnostics", () => {
  const snapshot = buildDecisionOutcomeSnapshot({
    rawDetail: { stylePolicy: { style: "day_trader" }, canonicalScannerState: { contractVersion: "canonical-scanner-state.v1", stage: "blocked" } },
    confluenceScore: 73,
    tier1Count: 3,
    tier1Factors: ["Market Structure"],
  });
  assertEquals(snapshot.compatibility, "complete");
  assertEquals(snapshot.tradingStyle, "day_trader");
  assertEquals(snapshot.legacyDiagnostics.confluenceScore, 73);
});
