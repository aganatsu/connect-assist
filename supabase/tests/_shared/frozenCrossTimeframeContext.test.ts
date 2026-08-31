import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFrozenCrossTimeframeContext,
  FROZEN_CROSS_TF_CONTEXT_VERSION,
  validateImpulseLifecycleExecutableZone,
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
      impulseQualification: {
        contractVersion: "impulse-zone-qualification.v3",
        state: "qualified",
        qualified: true,
      },
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

Deno.test("impulse lifecycle starts from the executable zone and queues deeper authority candidates", () => {
  const frozen = buildFrozenCrossTimeframeContext({
    symbol: "CHF/JPY",
    gamePlan: null,
    directionVerdict: null,
    stylePolicy,
    zoneStory: {
      selectedTF: "5m",
      impulseQualification: {
        contractVersion: "impulse-zone-qualification.v2",
        state: "qualified",
        qualified: true,
      },
      bestZone: {
        type: "fvg",
        low: 198.25,
        high: 198.37,
        candidateModel: { candidateId: "executable-fvg", rank: 1 },
        timeframeLineage: { candidateTimeframe: "5m" },
      },
      candidateAuthorityObservation: {
        selected: {
          id: "deeper-ob",
          type: "ob",
          direction: "bullish",
          low: 198.12,
          high: 198.2,
          timeframe: "5m",
          eligible: true,
        },
        ranked: [{
          id: "deeper-ob",
          type: "ob",
          direction: "bullish",
          low: 198.12,
          high: 198.2,
          timeframe: "5m",
          eligible: true,
        }],
      },
    },
    executableZone: {
      type: "FVG",
      low: 198.26666,
      high: 198.3589,
      timeframe: "5m",
    },
    crossTimeframeAuthority,
    impulseEntryLifecycleMode: "enforce",
    timeframeEvidence: {
      observed_at: "2026-08-21T08:00:00.000Z",
      selected_timeframe: "5m",
      slots: [{
        timeframe: "5m",
        impulses: [{
          impulseId: "chfjpy-impulse",
          selected: true,
          direction: "bullish",
          high: 198.5,
          low: 198,
        }],
      }],
    } as any,
  });

  const lifecycle = frozen.impulseEntryLifecycle;
  if (!lifecycle) throw new Error("expected an impulse lifecycle");
  assertEquals(lifecycle.activeCandidateId, "executable-fvg");
  assertEquals(
    validateImpulseLifecycleExecutableZone({
      mode: "enforce",
      context: frozen,
      executableZone: { type: "FVG", low: 198.26666, high: 198.3589 },
    }).valid,
    true,
  );
  assertEquals(
    validateImpulseLifecycleExecutableZone({
      mode: "enforce",
      context: frozen,
      executableZone: { type: "fvg", low: 198.2, high: 198.3589 },
    }).reason,
    "impulse_entry_lifecycle_executable_zone_mismatch",
  );
  assertEquals(
    validateImpulseLifecycleExecutableZone({
      mode: "enforce",
      context: frozen,
      executableZone: { type: "IZ-FVG", low: 198.26666, high: 198.3589 },
    }).reason,
    "impulse_entry_lifecycle_executable_zone_unavailable",
  );
  assertEquals(
    lifecycle.candidates.map((candidate) => ({
      id: candidate.id,
      low: candidate.low,
      high: candidate.high,
      state: candidate.state,
    })),
    [{
      id: "executable-fvg",
      low: 198.26666,
      high: 198.3589,
      state: "active",
    }, {
      id: "deeper-ob",
      low: 198.12,
      high: 198.2,
      state: "queued",
    }],
  );
});

Deno.test("nested executable identity includes candidate ID and trigger kind", () => {
  const frozen = buildFrozenCrossTimeframeContext({
    symbol: "CHF/JPY",
    gamePlan: null,
    directionVerdict: null,
    stylePolicy,
    zoneStory: {
      selectedTF: "5m",
      impulseQualification: {
        contractVersion: "impulse-zone-qualification.v2",
        state: "qualified",
        qualified: true,
      },
      bestZone: {
        type: "fvg",
        low: 198.25,
        high: 198.37,
        candidateModel: { candidateId: "outer-fvg", rank: 1 },
        timeframeLineage: { candidateTimeframe: "5m" },
      },
      candidateAuthorityObservation: { ranked: [] },
    },
    executableZone: {
      candidateId: "nested-fib",
      type: "fib",
      low: 198.3,
      high: 198.3,
      timeframe: "5m",
      triggerKind: "level",
    },
    crossTimeframeAuthority,
    impulseEntryLifecycleMode: "enforce",
    impulseEntryMode: "nested_poi_market",
    nestedPoiMonitoringTimeframe: "1m",
    timeframeEvidence: {
      observed_at: "2026-08-21T08:00:00.000Z",
      selected_timeframe: "5m",
      slots: [{
        timeframe: "5m",
        impulses: [{
          impulseId: "chfjpy-impulse",
          selected: true,
          direction: "bullish",
          high: 198.5,
          low: 198,
        }],
      }],
    } as any,
  });

  assertEquals(frozen.impulseEntryLifecycle?.confirmation?.timeframe, "1m");
  assertEquals(
    validateImpulseLifecycleExecutableZone({
      mode: "enforce",
      context: frozen,
      executableZone: {
        candidateId: "nested-fib",
        type: "fib",
        low: 198.3,
        high: 198.3,
        triggerKind: "level",
      },
    }).valid,
    true,
  );
  assertEquals(
    validateImpulseLifecycleExecutableZone({
      mode: "enforce",
      context: frozen,
      executableZone: {
        candidateId: "other-fib",
        type: "fib",
        low: 198.3,
        high: 198.3,
        triggerKind: "level",
      },
    }).reason,
    "impulse_entry_lifecycle_executable_zone_mismatch",
  );
  assertEquals(
    validateImpulseLifecycleExecutableZone({
      mode: "enforce",
      context: frozen,
      executableZone: {
        candidateId: "nested-fib",
        type: "fib",
        low: 198.3,
        high: 198.3,
        triggerKind: "range",
      },
    }).reason,
    "impulse_entry_lifecycle_executable_zone_mismatch",
  );
});

Deno.test("enforced frozen context reports an out-of-range executable zone without throwing", () => {
  const frozen = buildFrozenCrossTimeframeContext({
    symbol: "GBP/USD",
    gamePlan: null,
    directionVerdict: null,
    stylePolicy,
    zoneStory: {
      selectedTF: "5m",
      impulseQualification: {
        contractVersion: "impulse-zone-qualification.v2",
        state: "qualified",
        qualified: true,
      },
      bestZone: {
        type: "fvg",
        low: 1.099,
        high: 1.101,
        candidateModel: { candidateId: "outside-fvg", rank: 1 },
        timeframeLineage: { candidateTimeframe: "5m" },
      },
      candidateAuthorityObservation: { ranked: [] },
    },
    crossTimeframeAuthority,
    impulseEntryLifecycleMode: "enforce",
    timeframeEvidence: {
      observed_at: "2026-08-21T08:00:00.000Z",
      selected_timeframe: "5m",
      slots: [{
        timeframe: "5m",
        impulses: [{
          impulseId: "gbpusd-impulse",
          selected: true,
          direction: "bullish",
          high: 1.11,
          low: 1.1,
        }],
      }],
    } as any,
  });

  assertEquals(frozen.impulseEntryLifecycle, null);
  assertEquals(frozen.impulseEntryLifecycleAvailability, {
    mode: "enforce",
    available: false,
    reason: "executable_zone_outside_canonical_range",
  });
});
