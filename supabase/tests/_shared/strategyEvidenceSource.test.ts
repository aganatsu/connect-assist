import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildStrategyEvidenceSource } from "../../functions/_shared/strategyEvidenceSource.ts";

Deno.test("evidence source collapses repeated rejections and partial trade rows", () => {
  const rawDetail = {
    gamePlanShadowAudit: { decision: "eligible" },
    thesisConviction: { scoreAdjustment: 5 },
    stylePolicy: {
      style: "scalper",
      qualification: { effectiveMinConfluence: 50 },
    },
    shadowEvaluation: { effectiveScore: 47, threshold: 50 },
  };
  const source = buildStrategyEvidenceSource([
    {
      id: "rejected-1",
      symbol: "GBP/USD",
      direction: "long",
      rejection_type: "below_threshold_strong_t1",
      session_name: "london",
      failed_gates: ["Score 47 < threshold 50"],
      outcome_status: "would_have_won",
      confluence_score: 47,
      rr_ratio: 2,
      raw_detail: rawDetail,
      rejected_at: "2026-07-30T10:00:00Z",
    },
    {
      id: "rejected-2",
      symbol: "GBP/USD",
      direction: "long",
      rejection_type: "below_threshold_strong_t1",
      session_name: "london",
      failed_gates: ["Score 47 < threshold 50"],
      outcome_status: "would_have_won",
      confluence_score: 47,
      rr_ratio: 2,
      raw_detail: rawDetail,
      rejected_at: "2026-07-30T10:05:00Z",
    },
  ], [
    {
      id: "partial",
      position_id: "position-1_partial",
      symbol: "EUR/USD",
      direction: "long",
      pnl: 50,
      size: 0.5,
      entry_price: 1.1,
      exit_price: 1.102,
      stop_loss: 1.098,
      signal_score: 55,
      signal_reason: JSON.stringify(rawDetail),
      close_reason: "partial_tp",
      closed_at: "2026-07-30T11:00:00Z",
    },
    {
      id: "terminal",
      position_id: "position-1",
      symbol: "EUR/USD",
      direction: "long",
      pnl: 50,
      size: 0.5,
      entry_price: 1.1,
      exit_price: 1.104,
      stop_loss: 1.098,
      signal_score: 55,
      signal_reason: JSON.stringify(rawDetail),
      close_reason: "take_profit",
      closed_at: "2026-07-30T12:00:00Z",
    },
  ]);

  assertEquals(source.totalCandidates, 2);
  assertEquals(
    source.observations.filter((item) => item.feature === "gameplan_hierarchy")
      .length,
    2,
  );
  assertEquals(
    source.observations.filter((item) => item.feature === "thesis_conviction")
      .length,
    2,
  );
  const trade = source.observations.find((item) =>
    item.source === "closed_trade" &&
    item.feature === "gameplan_hierarchy"
  );
  assertEquals(trade?.outcomeR, 1.5);
});
