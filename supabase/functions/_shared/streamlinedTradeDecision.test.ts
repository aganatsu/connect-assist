import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateStreamlinedTradeDecision,
  STREAMLINED_TRADE_DECISION_VERSION,
  type SetupQualityPillar,
  type StreamlinedTradeDecisionInput,
} from "./streamlinedTradeDecision.ts";

const completePillars = Object.fromEntries(
  (["structure", "location", "confirmation", "timing"] as SetupQualityPillar[])
    .map((pillar) => [pillar, {
      score: 20,
      complete: true,
      evidence: [{ source: `${pillar}_evidence`, id: `${pillar}-1` }],
      reasonCodes: [`${pillar}_mapped`],
    }]),
) as StreamlinedTradeDecisionInput["setupQuality"]["pillars"];

function baseInput(): StreamlinedTradeDecisionInput {
  return {
    evaluatedAt: "2026-08-03T16:00:00.000Z",
    identity: {
      candidateId: "cycle-1:EUR/USD",
      symbol: "EUR/USD",
      direction: "long",
      stage: "candidate",
    },
    authority: {
      stylePolicyVersion: "style-policy.v1.3",
      stylePolicyHash: "policy-hash",
      styleBasePolicyHash: "base-hash",
      timeframeEvidenceId: "tf-1",
      gamePlanId: "gp-1",
      gamePlanVersion: "gp-v1",
      directionVerdictVersion: "direction-verdict.v1",
    },
    direction: {
      verdict: "long",
      confidence: 82,
      shouldBlock: false,
      reasonCodes: ["direction_authorized"],
      evidence: [{ source: "direction_verdict", id: "dv-1" }],
    },
    setupQuality: {
      threshold: 60,
      pillars: structuredClone(completePillars),
      evidenceMapping: {
        version: "streamlined-evidence-registry.v1",
        complete: true,
        unmappedFactors: [],
        excludedEvidence: [],
      },
      legacyDiagnostics: {
        rawScore: 67,
        effectiveScore: 72,
        threshold: 60,
      },
    },
    thesis: {
      validationRequired: true,
      valid: true,
      conviction: 78,
      degrading: false,
      reasonCodes: ["thesis_valid"],
      evidence: [{ source: "thesis_validation" }],
    },
    confirmation: {
      required: true,
      passed: true,
      reasonCodes: ["confirmation_passed"],
      evidence: [{ source: "entry_confirmation" }],
    },
    safety: {
      complete: true,
      evidence: [],
      checks: [
        { code: "spread", passed: true },
        { code: "portfolio_heat", passed: true },
      ],
    },
  };
}

Deno.test("complete evidence produces a deterministic observation-only allow", () => {
  const input = baseInput();
  const first = evaluateStreamlinedTradeDecision(input);
  const second = evaluateStreamlinedTradeDecision(input);

  assertEquals(first, second);
  assertEquals(first.contractVersion, STREAMLINED_TRADE_DECISION_VERSION);
  assertEquals(first.observationOnly, true);
  assertEquals(first.affectsAuthorization, false);
  assertEquals(first.setupQuality.score, 80);
  assertEquals(first.direction.confidenceBand, "high");
  assertEquals(first.thesisHealth.state, "healthy");
  assertEquals(first.safetyAuthorization.state, "passed");
  assertEquals(first.proposedDecision.decision, "allow");
  assertEquals(first.completeness.complete, true);
});

Deno.test("missing pillar ownership stays unavailable instead of inventing a score", () => {
  const input = baseInput();
  input.setupQuality.pillars.location = {
    score: null,
    complete: false,
    evidence: [{ source: "zone_story", id: "zone-1" }],
    reasonCodes: ["phase2_mapping_pending"],
  };
  input.safety.complete = false;

  const result = evaluateStreamlinedTradeDecision(input);

  assertEquals(result.setupQuality.score, null);
  assertEquals(result.setupQuality.passed, null);
  assertEquals(result.safetyAuthorization.state, "unavailable");
  assertEquals(result.proposedDecision, {
    decision: "unavailable",
    reasonCodes: ["evidence_incomplete"],
  });
  assertEquals(result.completeness.unavailable, [
    "safety_authorization",
    "setup_quality.location",
  ]);
});

Deno.test("a known safety failure blocks even when other evidence is incomplete", () => {
  const input = baseInput();
  input.setupQuality.pillars.structure.complete = false;
  input.setupQuality.pillars.structure.score = null;
  input.safety.complete = false;
  input.safety.checks = [{ code: "high_impact_news", passed: false }];

  const result = evaluateStreamlinedTradeDecision(input);

  assertEquals(result.safetyAuthorization.state, "blocked");
  assertEquals(result.proposedDecision, {
    decision: "block",
    reasonCodes: ["safety.high_impact_news"],
  });
  assertEquals(result.affectsAuthorization, false);
});

Deno.test("invalid thesis blocks without changing the legacy score diagnostics", () => {
  const input = baseInput();
  input.thesis.valid = false;
  input.thesis.conviction = 91;

  const result = evaluateStreamlinedTradeDecision(input);

  assertEquals(result.thesisHealth.state, "invalid");
  assertEquals(result.proposedDecision.decision, "block");
  assertEquals(result.setupQuality.legacyDiagnostics, {
    rawScore: 67,
    effectiveScore: 72,
    threshold: 60,
  });
});
