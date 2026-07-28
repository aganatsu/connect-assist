import { describe, expect, it } from "vitest";
import {
  collapseRejectedOpportunities,
  normalizeRejectedGate,
  normalizedGateLabel,
} from "./rejectedSetupAnalytics";

const record = (
  id: string,
  rejected_at: string,
  failedGate: string,
  outcome_status = "would_have_lost",
) => ({
  id,
  rejected_at,
  symbol: "GBP/USD",
  direction: "long",
  rejection_type: "gate_blocked",
  session_name: "London",
  failed_gates: [failedGate],
  outcome_status,
});

describe("rejected setup opportunity analytics", () => {
  it("normalizes dynamic gate messages", () => {
    expect(normalizeRejectedGate("5 consecutive losses >= 5 limit — auto-resets in 23min"))
      .toBe("consecutive_loss_limit");
    expect(normalizeRejectedGate("Direction BLOCKED: verdict conflicts with signal (conf: 74%)"))
      .toBe("direction_verdict");
    expect(normalizeRejectedGate("Buying in premium zone rejected — price at 72% of range"))
      .toBe("premium_discount");
    expect(normalizeRejectedGate("Gameplan hard block: bearish 64% vs LONG"))
      .toBe("gameplan_alignment");
    expect(normalizedGateLabel("consecutive_loss_limit"))
      .toBe("Consecutive-Loss Limit");
  });

  it("collapses repeated scans within a rolling 60-minute gap", () => {
    const records = [
      record("1", "2026-07-27T16:05:00Z", "5 consecutive losses >= 5 limit — auto-resets in 63min"),
      record("2", "2026-07-27T16:35:00Z", "5 consecutive losses >= 5 limit — auto-resets in 33min"),
      record("3", "2026-07-27T17:25:00Z", "5 consecutive losses >= 5 limit — auto-resets in 1min"),
    ];

    const opportunities = collapseRejectedOpportunities(records);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].occurrence_count).toBe(3);
  });

  it("starts a new opportunity after the rolling gap", () => {
    const records = [
      record("1", "2026-07-27T16:05:00Z", "Already long on GBP/USD — no duplicate"),
      record("2", "2026-07-27T18:10:00Z", "Already long on GBP/USD — no duplicate"),
    ];

    expect(collapseRejectedOpportunities(records)).toHaveLength(2);
  });

  it("marks clusters with contradictory outcomes inconclusive", () => {
    const records = [
      record("1", "2026-07-27T16:05:00Z", "Already long on GBP/USD", "would_have_won"),
      record("2", "2026-07-27T16:15:00Z", "Already long on GBP/USD", "would_have_lost"),
    ];

    const [opportunity] = collapseRejectedOpportunities(records);
    expect(opportunity.mixed_outcome).toBe(true);
    expect(opportunity.outcome_status).toBe("inconclusive");
  });
});
