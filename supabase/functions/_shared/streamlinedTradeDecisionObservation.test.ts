import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildPhase1StreamlinedTradeDecisionObservation,
  type Phase1StreamlinedObservationInput,
} from "./streamlinedTradeDecisionObservation.ts";

function observationInput(): Phase1StreamlinedObservationInput {
  return {
    evaluatedAt: "2026-08-03T16:00:00.000Z",
    candidateId: "cycle-1:EUR/USD",
    symbol: "EUR/USD",
    direction: "long",
    authority: {
      stylePolicyVersion: "style-policy.v1.3",
      stylePolicyHash: "policy-hash",
      timeframeEvidenceId: "tf-1",
    },
    directionVerdict: {
      id: "dv-1",
      verdict: "long",
      confidence: 80,
      shouldBlock: false,
      verdictVersion: "direction-verdict.v1",
      evaluatedAt: "2026-08-03T16:00:00.000Z",
    },
    directionReasonCode: "decision_hierarchy_passed",
    legacyScoring: {
      rawScore: 64,
      effectiveScore: 69,
      threshold: 60,
    },
    thesis: {
      validationRequired: true,
      valid: true,
      conviction: 75,
      degrading: false,
      reasonCode: "structure_still_valid",
      version: "thesis-validation.v1",
      evaluatedAt: "2026-08-03T16:00:00.000Z",
    },
    confirmation: {
      required: false,
      passed: false,
      reasonCode: "candidate_discovered",
      evaluatedAt: "2026-08-03T16:00:00.000Z",
    },
    gates: [
      { passed: true, reason: "Portfolio heat 1.0%" },
      { passed: true, reason: "Spread 1.2 pips <= 2.0 maximum" },
    ],
    locationEvidence: {
      source: "zone_story_and_market_location",
      id: "zone-1",
    },
  };
}

Deno.test("Phase 1 adapter records evidence but keeps the proposal unavailable", () => {
  const result = buildPhase1StreamlinedTradeDecisionObservation(
    observationInput(),
  );

  assertEquals(result.proposedDecision.decision, "unavailable");
  assertEquals(result.setupQuality.score, null);
  assertEquals(result.setupQuality.legacyDiagnostics.effectiveScore, 69);
  assertEquals(result.safetyAuthorization.state, "unavailable");
  assertEquals(result.affectsAuthorization, false);
  assertEquals(result.setupQuality.pillars.location.evidence[0].id, "zone-1");
});

Deno.test("duplicate normalized safety checks preserve a failure", () => {
  const input = observationInput();
  input.gates = [
    { passed: false, reason: "Portfolio heat 5.0% >= 4.0% limit" },
    { passed: true, reason: "Portfolio heat 1.0%" },
  ];

  const result = buildPhase1StreamlinedTradeDecisionObservation(input);

  assertEquals(result.safetyAuthorization.checks, [{
    code: "portfolio_heat",
    passed: false,
    evidence: {
      source: "scanner_safety_gate",
      observedAt: "2026-08-03T16:00:00.000Z",
    },
  }]);
  assertEquals(result.proposedDecision, {
    decision: "block",
    reasonCodes: ["safety.portfolio_heat"],
  });
  assertEquals(result.affectsAuthorization, false);
});
