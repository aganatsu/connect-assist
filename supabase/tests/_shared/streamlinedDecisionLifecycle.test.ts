import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateStreamlinedTradeDecision } from "./streamlinedTradeDecision.ts";
import { freezeStreamlinedDecision, lifecycleProjection } from "./streamlinedDecisionLifecycle.ts";

function summary() {
  return evaluateStreamlinedTradeDecision({
    evaluatedAt: "2026-08-03T12:00:00Z",
    identity: { candidateId: "candidate-1", symbol: "EUR/USD", direction: "long", stage: "candidate" },
    authority: {},
    direction: { verdict: "long", confidence: 80, shouldBlock: false, reasonCodes: [], evidence: [] },
    setupQuality: {
      threshold: 55,
      pillars: Object.fromEntries(["structure", "location", "confirmation", "timing"].map((name) => [name, { score: 20, complete: true, evidence: [], reasonCodes: [] }])) as any,
      evidenceMapping: { version: "test", complete: true, unmappedFactors: [], excludedEvidence: [] },
    },
    thesis: { validationRequired: false, valid: true, conviction: 80, degrading: false, reasonCodes: [], evidence: [] },
    confirmation: { required: false, passed: true, reasonCodes: [], evidence: [] },
    safety: { complete: true, evidence: [], checks: [] },
  });
}

Deno.test("freezes origin and separates refreshable lifecycle state", () => {
  const projection = lifecycleProjection(summary(), "watchlist", 1.15);
  assertEquals(projection.streamlinedDecisionOrigin.candidateId, "candidate-1");
  assertEquals(projection.streamlinedDecisionLatest.stage, "watchlist");
  assertEquals(projection.streamlinedDecisionLatest.currentPrice, 1.15);
});

Deno.test("rejects a non-observation origin", () => {
  const value = summary() as any;
  value.affectsAuthorization = true;
  assertThrows(() => freezeStreamlinedDecision(value));
});
