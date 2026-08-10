import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFrozenCrossTimeframeContext,
  FROZEN_CROSS_TF_CONTEXT_VERSION,
} from "../../functions/_shared/frozenCrossTimeframeContext.ts";
import { resolveCrossTimeframeAuthority } from "../../functions/_shared/crossTimeframeAuthority.ts";

const stylePolicy = {
  contractVersion: "style-policy.v1.3",
  basePolicyHash: "base-hash",
  policyHash: "pair-hash",
  style: "scalper",
} as any;
const crossTimeframeAuthority = resolveCrossTimeframeAuthority({
  rawConfig: { crossTfAuthorityMode: "observe" },
  runtimeTarget: "paper",
  activation: null,
});

Deno.test("frozen cross-TF context binds plan, verdict, zone, lineage and certificates", () => {
  const frozen = buildFrozenCrossTimeframeContext({
    timeframeEvidenceId: "evidence-1",
    symbol: "GBP/CAD",
    gamePlan: {
      planVersion: "session-plan",
      plans: [{
        symbol: "GBP/CAD",
        gamePlanId: "gameplan-1",
        planVersion: "plan-v1",
      }],
    } as any,
    directionVerdict: {
      id: "verdict-1",
      verdictVersion: "verdict-v1",
      gamePlanId: "gameplan-1",
      gamePlanVersion: "plan-v1",
    } as any,
    stylePolicy,
    zoneStory: {
      selectedTF: "15min",
      candidateAuthorityObservation: {
        contractVersion: "ict-entry-zone-authority.v1",
        enforcement: "observe_only",
        selected: { id: "child-1+fvg-1", type: "ob_fvg" },
      },
      impulseQualification: { contractVersion: "impulse-zone-qualification.v1", state: "qualified", qualified: true },
      impulse: {
        high: 1.72,
        low: 1.7,
        direction: "bearish",
      },
      bestZone: {
        type: "fvg",
        low: 1.71,
        high: 1.712,
        candidateModel: {
          candidateId: "child-1",
          rank: 1,
        },
        candidateLifecycle: { state: "fresh" },
        canonicalImpulseMetrics: { displacementPercentile: 92 },
        timeframeLineage: {
          candidateTimeframe: "15min",
          relationship: "qualified_nested",
          parentCandidateId: "parent-1",
          parentTimeframe: "1h",
          overlapPercentOfChild: 80,
          parentDistanceATR: 0,
        },
      },
      zoneCandidates: [{
        timeframe: "1h",
        candidateModel: { candidateId: "parent-1", rank: 2 },
        canonicalImpulseMetrics: { displacementPercentile: 88 },
      }],
    },
    evidenceCertificates: [{
      featureKey: "thesis_conviction",
      variantKey: "default",
      certificateHash: "cert-b",
      status: "collecting",
      generatedAt: null,
    }, {
      featureKey: "gameplan_hierarchy",
      variantKey: "default",
      certificateHash: "cert-a",
      status: "eligible_log_only",
      generatedAt: "2026-08-01T12:00:00.000Z",
    }],
    crossTimeframeAuthority,
    timeframeEvidence: {
      observed_at: "2026-08-03T12:00:00.000Z",
      selected_timeframe: "15min",
      slots: [{
        timeframe: "1h",
        impulses: [{
          impulseId: "impulse-parent-1h",
          selected: true,
          direction: "bearish",
          high: 1.72,
          low: 1.68,
        }],
      }],
    } as any,
  });

  assertEquals(frozen.contractVersion, FROZEN_CROSS_TF_CONTEXT_VERSION);
  assertEquals(frozen.enforcement, "observe_only");
  assertEquals(frozen.gamePlan.version, "plan-v1");
  assertEquals(frozen.directionVerdict.version, "verdict-v1");
  assertEquals(frozen.selectedZone?.candidateId, "child-1");
  assertEquals(
    frozen.ictEntryZoneAuthority?.contractVersion,
    "ict-entry-zone-authority.v1",
  );
  assertEquals(
    frozen.relationship?.classification,
    "qualified_nested",
  );
  assertEquals(frozen.parentImpulse?.candidateId, "parent-1");
  assertEquals(frozen.childImpulse?.timeframe, "15min");
  assertEquals(frozen.childImpulse?.qualification?.state, "qualified");
  assertEquals(frozen.canonicalDealingRange.available, true);
  if (frozen.canonicalDealingRange.available) {
    assertEquals(
      frozen.canonicalDealingRange.range.impulseId,
      "impulse-parent-1h",
    );
    assertEquals(frozen.canonicalDealingRange.range.high, 1.72);
    assertEquals(frozen.canonicalDealingRange.range.low, 1.68);
  }
  assertEquals(
    frozen.evidenceCertificates.map((item) => item.featureKey),
    ["gameplan_hierarchy", "thesis_conviction"],
  );
  assertEquals(frozen.authority.effectiveMode, "observe");
  assertEquals(frozen.authority.allowed, true);
});

Deno.test("frozen cross-TF context records absence instead of inventing lineage", () => {
  const frozen = buildFrozenCrossTimeframeContext({
    symbol: "EUR/USD",
    gamePlan: null,
    directionVerdict: null,
    stylePolicy,
    zoneStory: null,
    crossTimeframeAuthority,
  });
  assertEquals(frozen.selectedZone, null);
  assertEquals(frozen.ictEntryZoneAuthority, null);
  assertEquals(frozen.relationship, null);
  assertEquals(frozen.parentImpulse, null);
  assertEquals(frozen.childImpulse, null);
  assertEquals(frozen.canonicalDealingRange.available, false);
  assertEquals(frozen.evidenceCertificates, []);
  assertEquals(frozen.authority.evidenceAvailable, false);
});
