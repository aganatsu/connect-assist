import { describe, expect, it } from "vitest";
import {
  buildStopPolicyEvidenceReport,
  type StopPolicyObservation,
} from "./stopPolicyEvidence";

function observation(
  overrides: Partial<StopPolicyObservation> = {},
): StopPolicyObservation {
  return {
    id: "1",
    candidate_id: "candidate-1",
    observed_at: "2026-08-20T12:00:00Z",
    symbol: "GBP/USD",
    direction: "long",
    trading_style: "scalper",
    confirmation_timeframe: "5m",
    entry_price: 1.3525,
    current_plan_valid: true,
    current_stop_loss: 1.35,
    current_take_profit: 1.355,
    current_risk_reward: 1,
    current_take_profit_source: "next_level",
    current_plan_reason: null,
    shadow_plan_valid: true,
    shadow_stop_loss: 1.3519,
    shadow_take_profit: 1.3539,
    shadow_risk_reward: 2.33,
    shadow_take_profit_source: "next_level",
    shadow_plan_reason: null,
    execution_floor_source: "spread_proxy",
    broker_stops_level: null,
    broker_digits: null,
    tick_size: null,
    shadow_measurements: { riskCapBreached: false, reason: null },
    ...overrides,
  };
}

describe("stop-policy evidence report", () => {
  it("compares candidates once and reports tighter proposed stops", () => {
    const report = buildStopPolicyEvidenceReport([observation()]);

    expect(report.summary.total).toBe(1);
    expect(report.summary.comparable).toBe(1);
    expect(report.summary.tighter).toBe(1);
    expect(report.summary.wider).toBe(0);
    expect(report.summary.proxySamples).toBe(1);
    expect(report.rows[0].currentStopDistancePips).toBeCloseTo(25);
    expect(report.rows[0].shadowStopDistancePips).toBeCloseTo(6);
    expect(report.rows[0].stopDistanceDeltaPips).toBeCloseTo(-19);
  });

  it("keeps invalid and cap-breached proposals out of comparable averages", () => {
    const report = buildStopPolicyEvidenceReport([
      observation({
        id: "2",
        shadow_plan_valid: false,
        shadow_plan_reason: "style_risk_cap_exceeded",
        shadow_measurements: {
          riskCapBreached: true,
          reason: "style_risk_cap_exceeded",
        },
      }),
    ]);

    expect(report.summary.shadowValid).toBe(0);
    expect(report.summary.comparable).toBe(0);
    expect(report.summary.capBreaches).toBe(1);
    expect(report.summary.averageShadowStopPips).toBeNull();
  });

  it("distinguishes exact broker snapshots from spread proxies", () => {
    const report = buildStopPolicyEvidenceReport([
      observation({ execution_floor_source: "broker_snapshot" }),
      observation({ id: "2" }),
    ]);

    expect(report.summary.exactBrokerSamples).toBe(1);
    expect(report.summary.proxySamples).toBe(1);
  });
});
