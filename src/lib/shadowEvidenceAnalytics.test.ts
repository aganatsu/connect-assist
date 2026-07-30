import { describe, expect, it } from "vitest";
import { buildShadowEvidenceReport } from "./shadowEvidenceAnalytics";

function rejected(
  id: string,
  outcome: "would_have_won" | "would_have_lost",
  auditDecision: "eligible" | "wait" | "skip",
  options: {
    type?: "gate_blocked" | "below_threshold_strong_t1";
    score?: number;
    adjustment?: number;
    threshold?: number;
    style?: string;
  } = {},
) {
  const score = options.score ?? 45;
  return {
    id,
    symbol: "GBP/USD",
    direction: "long",
    rejection_type: options.type ?? "gate_blocked",
    confluence_score: score,
    outcome_status: outcome,
    shadow_decision: { decision: auditDecision },
    raw_detail: {
      gamePlanShadowAudit: { decision: auditDecision },
      thesisConviction: {
        scoreAdjustment: options.adjustment ?? 0,
      },
      stylePolicy: {
        style: options.style ?? "scalper",
        qualification: {
          effectiveMinConfluence: options.threshold ?? 50,
        },
      },
      shadowEvaluation: {
        effectiveScore: score,
        threshold: options.threshold ?? 50,
      },
    },
  };
}

function trade(
  id: string,
  pnl: number,
  auditDecision: "eligible" | "wait" | "skip",
  adjustment = 0,
  score = 55,
  threshold = 50,
) {
  return {
    id,
    position_id: id,
    symbol: "GBP/USD",
    pnl,
    signal_score: score,
    close_reason: "take_profit",
    closed_at: "2026-07-30T10:00:00Z",
    signal_reason: JSON.stringify({
      gamePlanShadowAudit: { decision: auditDecision },
      decisionContext: {
        thesisConviction: {
          evidence: { scoreAdjustment: adjustment },
        },
        stylePolicy: {
          style: "scalper",
          qualification: { effectiveMinConfluence: threshold },
        },
      },
    }),
  };
}

describe("shadow evidence analytics", () => {
  it("counts rescued winners and admitted losses from rejected opportunities", () => {
    const report = buildShadowEvidenceReport([
      rejected("winner", "would_have_won", "eligible"),
      rejected("loser", "would_have_lost", "eligible"),
    ], []);

    expect(report.gameplanHierarchy.changed).toBe(2);
    expect(report.gameplanHierarchy.rescuedWinners).toBe(1);
    expect(report.gameplanHierarchy.admittedLosses).toBe(1);
    expect(report.gameplanHierarchy.beneficialRate).toBe(50);
  });

  it("counts avoided losses and blocked winners from completed trades", () => {
    const report = buildShadowEvidenceReport([], [
      trade("loser", -100, "wait"),
      trade("winner", 100, "skip"),
    ]);

    expect(report.gameplanHierarchy.avoidedLosses).toBe(1);
    expect(report.gameplanHierarchy.blockedWinners).toBe(1);
  });

  it("simulates score-only Thesis Conviction without overriding other gates", () => {
    const report = buildShadowEvidenceReport([
      rejected("score", "would_have_won", "wait", {
        type: "below_threshold_strong_t1",
        score: 47,
        adjustment: 5,
        threshold: 50,
      }),
      rejected("gate", "would_have_won", "wait", {
        type: "gate_blocked",
        score: 47,
        adjustment: 5,
        threshold: 50,
      }),
    ], []);

    expect(report.thesisConviction.changed).toBe(1);
    expect(report.thesisConviction.rescuedWinners).toBe(1);
  });

  it("detects a completed winner that score-only conviction would block", () => {
    const report = buildShadowEvidenceReport([], [
      trade("winner", 120, "eligible", -10, 55, 50),
    ]);

    expect(report.thesisConviction.changed).toBe(1);
    expect(report.thesisConviction.blockedWinners).toBe(1);
  });

  it("collapses partial-close history rows into one completed trade", () => {
    const first = {
      ...trade("partial-row", 40, "eligible"),
      position_id: "position-1_partial",
      close_reason: "partial_tp",
    };
    const second = {
      ...trade("final-row", -10, "eligible"),
      position_id: "position-1",
    };
    const report = buildShadowEvidenceReport([], [first, second]);

    expect(report.totalCandidates).toBe(1);
    expect(report.gameplanHierarchy.resolved).toBe(1);
  });

  it("does not treat a partial close from an open position as completed", () => {
    const partial = {
      ...trade("partial-row", 40, "eligible"),
      position_id: "position-1_partial",
      close_reason: "partial_tp",
    };
    const report = buildShadowEvidenceReport([], [partial]);

    expect(report.totalCandidates).toBe(0);
  });

  it("keeps activation in collecting until evidence thresholds are met", () => {
    const report = buildShadowEvidenceReport([
      rejected("one", "would_have_won", "eligible"),
    ], []);

    expect(report.gameplanHierarchy.status).toBe("collecting");
    expect(report.gameplanHierarchy.statusReason).toContain("paper-mode");
  });
});
