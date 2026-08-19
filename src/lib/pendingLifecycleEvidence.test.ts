import { describe, expect, it } from "vitest";
import { buildPendingLifecycleEvidence } from "./pendingLifecycleEvidence";

describe("pending lifecycle evidence", () => {
  it("keeps waiting outcomes separate and links a filled position", () => {
    const report = buildPendingLifecycleEvidence([
      {
        id: "1", order_id: "pending-1", candidate_id: "candidate-1",
        symbol: "EUR/USD", direction: "long", status: "filled",
        entry_price: 1.1, current_price: 1.101, placed_at: "2026-08-12T10:00:00Z",
        expires_at: "2026-08-12T14:00:00Z", zone_touch_time: "2026-08-12T11:00:00Z",
        resolved_at: "2026-08-12T11:30:00Z",
        liquidity_confirmation_observation: {
          contractVersion: "liquidity-confirmation.v2", ready: true,
          reasonCode: "sequence_confirmed",
        },
        pending_authorization_observation: {
          contractVersion: "pending-authorization-observation.v1",
          confirmation: {
            evaluations: 4,
            matrixCounts: {
              both_passed: 1,
              detector_only: 2,
              lifecycle_only: 0,
              neither_passed: 1,
            },
            missingContractSamples: 1,
          },
          finalAuthorization: {
            authorized: false,
            code: "additional_gate",
            reason: "safety_minimum_risk_reward",
            effectiveTargetRiskReward: 1,
            effectiveMinimumRiskReward: 1,
            authorizationGeometry: { riskReward: 0.8 },
            wouldBeExecutionGeometry: { riskReward: 1 },
            favorableEntryDriftR: 0.12,
          },
        },
      },
    ], [{
      source_pending_order_id: "1", position_id: "position-1",
      position_status: "closed", close_reason: "tp_hit", pnl: 100, pnl_pips: 20,
    }]);
    expect(report.summary.touched).toBe(1);
    expect(report.summary.sequenceReady).toBe(1);
    expect(report.summary.linkedOutcomes).toBe(1);
    expect(report.rows[0].linkedPosition?.close_reason).toBe("tp_hit");
    expect(report.summary.confirmationEvaluations).toBe(4);
    expect(report.summary.confirmationBothPassed).toBe(1);
    expect(report.summary.confirmationDetectorOnly).toBe(2);
    expect(report.summary.confirmationNeitherPassed).toBe(1);
    expect(report.summary.missingLifecycleContractSamples).toBe(1);
    expect(report.summary.finalAuthorizationBlocked).toBe(1);
    expect(report.summary.finalAuthorizationRiskRewardBlocked).toBe(1);
    expect(report.summary.averageFavorableEntryDriftR).toBeCloseTo(0.12);
    expect(report.summary.riskRewardRegimes).toEqual({
      "1.00 target / 1.00 floor": 1,
    });
  });

  it("uses arm-time reachability and identifies repeated executable plans", () => {
    const base = {
      order_id: "pending", candidate_id: "candidate",
      symbol: "EUR/USD", direction: "long",
      entry_price: 1.1, entry_zone_type: "fvg",
      entry_zone_low: 1.099, entry_zone_high: 1.101,
      placed_at: "2026-08-12T10:00:00Z",
      expires_at: "2026-08-12T14:00:00Z",
      zone_touch_time: null, resolved_at: "2026-08-12T14:00:00Z",
      liquidity_confirmation_observation: null,
      signal_reason: {
        preArmReachability: {
          contractVersion: "prearm-reachability.v1",
          distancePips: 50,
          distanceAtr: 1.25,
          ttlMinutes: 240,
          referenceMaxDistancePips: 30,
          withinReferenceDistance: false,
        },
      },
    };
    const report = buildPendingLifecycleEvidence([
      { ...base, id: "1", status: "expired", current_price: 1.1002 },
      { ...base, id: "2", status: "expired", current_price: 1.12 },
      {
        ...base, id: "3", status: "filled", current_price: 1.1,
        entry_price: 1.09, entry_zone_low: 1.089, entry_zone_high: 1.091,
        zone_touch_time: "2026-08-12T11:00:00Z",
        signal_reason: {
          preArmReachability: {
            contractVersion: "prearm-reachability.v1",
            distancePips: 20,
            distanceAtr: 0.5,
            ttlMinutes: 240,
            referenceMaxDistancePips: 30,
            withinReferenceDistance: true,
          },
        },
      },
    ], []);

    expect(report.rows[0].armDistancePips).toBe(50);
    expect(report.rows[0].latestDistancePips).toBeCloseTo(2);
    expect(report.rows[0].repeatPlanCount).toBe(2);
    expect(report.rows[1].repeatPlanCount).toBe(2);
    expect(report.summary.expiredUntouched).toBe(2);
    expect(report.summary.expiredUntouchedRate).toBeCloseTo(2 / 3);
    expect(report.summary.averageArmDistancePips).toBeCloseTo(40);
    expect(report.summary.averageArmDistanceAtr).toBeCloseTo(1);
    expect(report.summary.repeatedPlans).toBe(1);
    expect(report.summary.repeatedLifecycleRows).toBe(2);
    expect(report.summary.withinReferenceDistance).toBe(1);
  });
});
