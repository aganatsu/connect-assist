import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateCrossTimeframeShadowCandidate,
  summarizeCrossTimeframeShadowOutcomes,
} from "../../functions/_shared/crossTimeframeShadowValidation.ts";

function candidate(input: {
  legacyRank?: number;
  relationship:
    | "qualified_nested"
    | "context_only"
    | "standalone_lower_tf"
    | "timeframe_conflict"
    | "no_parent_context";
  overlap?: number;
  distanceATR?: number | null;
  lifecycle?: string;
}): any {
  return {
    shadowRanking: { legacyRank: input.legacyRank ?? 1, shadowRank: 1 },
    candidateModel: { rank: 1 },
    candidateLifecycle: { state: input.lifecycle ?? "fresh" },
    canonicalImpulseMetrics: { sweepOrigin: false },
    timeframeLineage: {
      relationship: input.relationship,
      overlapPercentOfChild: input.overlap ?? 0,
      parentDistanceATR: input.distanceATR ?? null,
    },
  };
}

Deno.test("reference shadow policy retains a properly nested candidate", () => {
  const result = evaluateCrossTimeframeShadowCandidate(candidate({
    relationship: "qualified_nested",
    overlap: 75,
  }));
  assertEquals(result.legacyDecision, "allow");
  assertEquals(result.proposedDecision, "allow");
  assertEquals(result.reasonCodes, []);
});

Deno.test("reference shadow policy blocks false lower-TF independence", () => {
  const standalone = evaluateCrossTimeframeShadowCandidate(candidate({
    relationship: "standalone_lower_tf",
  }));
  assertEquals(standalone.proposedDecision, "block");
  assertEquals(
    standalone.reasonCodes,
    [
      "standalone_lower_timeframe_not_allowed",
      "nested_impulse_required",
    ],
  );

  const conflict = evaluateCrossTimeframeShadowCandidate(candidate({
    relationship: "timeframe_conflict",
  }));
  assertEquals(conflict.proposedDecision, "block");
  assertEquals(conflict.reasonCodes, [
    "parent_direction_conflict",
    "nested_impulse_required",
  ]);
});

Deno.test("context-only parent obeys both nesting and ATR policy controls", () => {
  const contextPolicy = {
    contractVersion: "cross-tf-shadow-policy.v1" as const,
    enforcement: "observe_only" as const,
    requireNestedImpulse: false,
    allowStandaloneLowerTimeframe: false,
    maximumZoneSeparationATR: 0.25,
    minimumParentChildOverlapPercent: 50,
    requireSweepOrigin: false,
    allowedRetestQuality: ["fresh", "tapped_and_held"] as const,
    maximumCandidatesPerTimeframe: 3,
  };
  assertEquals(
    evaluateCrossTimeframeShadowCandidate(candidate({
      relationship: "context_only",
      distanceATR: 0.2,
    }), contextPolicy).proposedDecision,
    "allow",
  );
  assertEquals(
    evaluateCrossTimeframeShadowCandidate(candidate({
      relationship: "context_only",
      distanceATR: 0.8,
    }), contextPolicy).reasonCodes,
    ["parent_zone_too_far"],
  );
  assertEquals(
    evaluateCrossTimeframeShadowCandidate(candidate({
      relationship: "context_only",
      distanceATR: 0.2,
    })).reasonCodes,
    ["nested_impulse_required"],
  );
});

Deno.test("outcome summary reports retained winners, avoided losses and missed opportunities", () => {
  const summary = summarizeCrossTimeframeShadowOutcomes([
    {
      legacyWinner: true,
      proposedDecision: "allow",
      outcomeStatus: "would_have_won",
      rewardRisk: 2,
      mfePips: 20,
      maePips: 5,
    },
    {
      legacyWinner: true,
      proposedDecision: "block",
      outcomeStatus: "would_have_lost",
      rewardRisk: 2,
      mfePips: 4,
      maePips: 10,
    },
    {
      legacyWinner: true,
      proposedDecision: "block",
      outcomeStatus: "would_have_won",
      rewardRisk: 2,
      mfePips: 18,
      maePips: 6,
    },
    {
      legacyWinner: true,
      proposedDecision: "allow",
      outcomeStatus: "would_have_lost",
      rewardRisk: 2,
      mfePips: 3,
      maePips: 11,
    },
  ]);
  assertEquals(summary.winnersRetained, 1);
  assertEquals(summary.losersAvoided, 1);
  assertEquals(summary.missedOpportunities, 1);
  assertEquals(summary.falsePositives, 1);
  assertEquals(summary.legacyExpectancyR, 0.5);
  assertEquals(summary.proposedExpectancyR, 0.25);
  assertEquals(summary.expectancyDeltaR, -0.25);
});

Deno.test("GBP/CAD 2:25 regression: 15m impulse cannot replace conflicting 1H authority", () => {
  // Golden classification fixture for the reported incident. Historical
  // candles remain external replay input; this locks the expected decision
  // once replay identifies the 15m candidate as conflicting with its 1H parent.
  const result = evaluateCrossTimeframeShadowCandidate(candidate({
    relationship: "timeframe_conflict",
    overlap: 0,
    distanceATR: 0,
  }));
  assertEquals(result.legacyDecision, "allow");
  assertEquals(result.proposedDecision, "block");
  assertEquals(result.reasonCodes, [
    "parent_direction_conflict",
    "nested_impulse_required",
  ]);
  assertEquals(result.enforcement, "observe_only");
});
