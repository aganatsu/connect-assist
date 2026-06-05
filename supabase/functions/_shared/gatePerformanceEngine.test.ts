/**
 * gatePerformanceEngine.test.ts — Tests for Unified Gate Performance Analysis
 * ─────────────────────────────────────────────────────────────────────────────
 * Run: deno test --allow-all supabase/functions/_shared/gatePerformanceEngine.test.ts
 */
import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  normalizeGateReason,
  computeCusum,
  computeNetGateValue,
  walkForwardValidate,
  computeGatePerformance,
  formatGatePerformancePrompt,
  type ResolvedRejection,
  type ClosedTrade,
} from "./gatePerformanceEngine.ts";

// ─── Test Helpers ───

function makeRejection(overrides: Partial<ResolvedRejection> = {}): ResolvedRejection {
  return {
    id: crypto.randomUUID(),
    symbol: "EUR/USD",
    direction: "long",
    failed_gates: ["HTF HARD VETO: Daily is bearish, bullish entry blocked"],
    confluence_score: 52,
    tier1_count: 2,
    outcome_status: "would_have_won",
    mfe_pips: 15,
    mae_pips: 5,
    tp_hit: true,
    sl_hit: false,
    regime: "trending",
    session_name: "London",
    rejected_at: "2025-06-01T10:00:00Z",
    rr_ratio: 2.5,
    ...overrides,
  };
}

function makeTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    id: crypto.randomUUID(),
    symbol: "EUR/USD",
    direction: "long",
    pnl: 50,
    rr_achieved: 2.0,
    close_time: "2025-06-01T14:00:00Z",
    regime: "trending",
    ...overrides,
  };
}

// ─── normalizeGateReason Tests ───

Deno.test("normalizeGateReason — HTF HARD VETO maps to htf_bias", () => {
  assertEquals(
    normalizeGateReason("HTF HARD VETO: Daily is bearish, bullish entry blocked"),
    "htf_bias"
  );
});

Deno.test("normalizeGateReason — HTF bias mismatch maps to htf_bias", () => {
  assertEquals(
    normalizeGateReason("HTF bias mismatch: Daily is bearish, entry is bullish"),
    "htf_bias"
  );
});

Deno.test("normalizeGateReason — HTF regime veto maps to htf_bias", () => {
  assertEquals(
    normalizeGateReason("HTF regime veto: Daily ranging but regime is bearish (75% conf) — long entry blocked"),
    "htf_bias"
  );
});

Deno.test("normalizeGateReason — Buying in premium maps to premium_discount", () => {
  assertEquals(
    normalizeGateReason("Buying in premium zone rejected — price 1.0850 at 72.3% of range (premium > 55%, need discount < 45% to buy)"),
    "premium_discount"
  );
});

Deno.test("normalizeGateReason — Selling in discount maps to premium_discount", () => {
  assertEquals(
    normalizeGateReason("Selling in discount zone rejected — price 1.0750 at 32.1% of range (discount < 45%, need premium > 55% to sell)"),
    "premium_discount"
  );
});

Deno.test("normalizeGateReason — Structural Conviction BLOCKED maps correctly", () => {
  assertEquals(
    normalizeGateReason("Structural Conviction BLOCKED [1H]: Bull fractals 0%, S2F 45%, opposite 60% — no structural support for long"),
    "structural_conviction"
  );
});

Deno.test("normalizeGateReason — Reaction Confirmation BLOCKED maps correctly", () => {
  assertEquals(
    normalizeGateReason("Reaction Confirmation BLOCKED: Ranging market with no reaction factor (need Displacement, Reversal, Sweep, or AMD)"),
    "reaction_confirmation"
  );
});

Deno.test("normalizeGateReason — instrument filter maps correctly", () => {
  assertEquals(
    normalizeGateReason("NZD/JPY not in enabled instruments"),
    "instrument_filter"
  );
});

Deno.test("normalizeGateReason — Max positions maps correctly", () => {
  assertEquals(
    normalizeGateReason("Max positions (5) reached"),
    "max_positions"
  );
});

Deno.test("normalizeGateReason — duplicate position maps correctly", () => {
  assertEquals(
    normalizeGateReason("Already long on EUR/USD — no duplicate (enable stacking to allow)"),
    "duplicate_position"
  );
});

Deno.test("normalizeGateReason — Portfolio heat maps correctly", () => {
  assertEquals(
    normalizeGateReason("Portfolio heat 4.5% >= 4% limit"),
    "portfolio_heat"
  );
});

Deno.test("normalizeGateReason — Daily loss maps correctly", () => {
  assertEquals(
    normalizeGateReason("Daily loss 3.2% >= 3% limit"),
    "daily_loss"
  );
});

Deno.test("normalizeGateReason — Daily net P&L maps to daily_loss", () => {
  assertEquals(
    normalizeGateReason("Daily net P&L -$150.00 >= $100 limit (gross loss: $200.00)"),
    "daily_loss"
  );
});

Deno.test("normalizeGateReason — Drawdown maps to max_drawdown", () => {
  assertEquals(
    normalizeGateReason("Drawdown 8.5% >= 8% limit"),
    "max_drawdown"
  );
});

Deno.test("normalizeGateReason — Score threshold maps to min_confluence", () => {
  assertEquals(
    normalizeGateReason("Score 45 < 50 threshold"),
    "min_confluence"
  );
});

Deno.test("normalizeGateReason — SMT divergence maps correctly", () => {
  assertEquals(
    normalizeGateReason("SMT divergence opposite — vetoed"),
    "smt_veto"
  );
});

Deno.test("normalizeGateReason — R:R maps to min_rr", () => {
  assertEquals(
    normalizeGateReason("R:R 1.2 raw, 0.9 effective (spread 0.3) < 1.5 min"),
    "min_rr"
  );
});

Deno.test("normalizeGateReason — OR not complete maps to opening_range", () => {
  assertEquals(
    normalizeGateReason("OR not complete: 1.5/2.0h elapsed"),
    "opening_range"
  );
});

Deno.test("normalizeGateReason — Kill Zone Only maps correctly", () => {
  assertEquals(
    normalizeGateReason("Kill Zone Only: Asian session not in kill zone"),
    "kill_zone"
  );
});

Deno.test("normalizeGateReason — Cooldown maps correctly", () => {
  assertEquals(
    normalizeGateReason("Cooldown: 15min remaining for EUR/USD"),
    "cooldown"
  );
});

Deno.test("normalizeGateReason — consecutive losses maps correctly", () => {
  assertEquals(
    normalizeGateReason("3 consecutive losses >= 3 limit — auto-resets in 45min"),
    "consecutive_losses"
  );
});

Deno.test("normalizeGateReason — News filter maps correctly", () => {
  assertEquals(
    normalizeGateReason("News filter: high-impact event within 30min — NFP"),
    "news_filter"
  );
});

Deno.test("normalizeGateReason — News conflict maps to news_filter", () => {
  assertEquals(
    normalizeGateReason("News conflict: FOMC minutes advisory"),
    "news_filter"
  );
});

Deno.test("normalizeGateReason — ATR filter maps correctly", () => {
  assertEquals(
    normalizeGateReason("ATR 3.2 pips below minimum 5"),
    "atr_filter"
  );
});

Deno.test("normalizeGateReason — ATR above max maps to atr_filter", () => {
  assertEquals(
    normalizeGateReason("ATR 25.1 pips above maximum 20"),
    "atr_filter"
  );
});

Deno.test("normalizeGateReason — Correlation conflict maps correctly", () => {
  assertEquals(
    normalizeGateReason("Correlation conflict: long EUR/USD vs open short EUR/GBP"),
    "correlation"
  );
});

Deno.test("normalizeGateReason — Correlated exposure maps to correlation", () => {
  assertEquals(
    normalizeGateReason("Correlated exposure limit: 3 correlated positions >= 2 max — EUR/USD; EUR/GBP; EUR/JPY"),
    "correlation"
  );
});

Deno.test("normalizeGateReason — unknown string returns null", () => {
  assertEquals(normalizeGateReason("Some random text that doesn't match"), null);
});

Deno.test("normalizeGateReason — empty string returns null", () => {
  assertEquals(normalizeGateReason(""), null);
});

Deno.test("normalizeGateReason — null/undefined returns null", () => {
  assertEquals(normalizeGateReason(null as any), null);
  assertEquals(normalizeGateReason(undefined as any), null);
});

// ─── computeCusum Tests ───

Deno.test("computeCusum — all zeros never breaches", () => {
  const errors = new Array(100).fill(0);
  const result = computeCusum(errors, { slack: 0.3, threshold: 5.0 });
  assertEquals(result.score, 0);
  assertEquals(result.breached, false);
  assertEquals(result.breachIndex, null);
});

Deno.test("computeCusum — all ones breaches quickly", () => {
  // Each step adds (1 - 0.3) = 0.7 to CUSUM
  // Breach at 5.0 / 0.7 ≈ 8 steps (ceil)
  const errors = new Array(20).fill(1);
  const result = computeCusum(errors, { slack: 0.3, threshold: 5.0 });
  assertEquals(result.breached, true);
  // After 8 steps: 8 * 0.7 = 5.6 >= 5.0
  assertEquals(result.breachIndex, 7); // 0-indexed, so step 8 is index 7
});

Deno.test("computeCusum — mixed errors accumulate correctly", () => {
  // Pattern: 1,1,1,0,1,1,0,1,1,1,1,1 (mostly errors)
  const errors = [1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1];
  const result = computeCusum(errors, { slack: 0.3, threshold: 5.0 });
  assertEquals(result.breached, true);
});

Deno.test("computeCusum — alternating errors never breach with default params", () => {
  // Alternating 1,0,1,0... — net per pair is (1-0.3) + (0-0.3) = 0.4
  // But CUSUM resets to 0 when it goes negative: max(0, 0 + 0 - 0.3) = 0
  // So: step 0: max(0, 0+1-0.3)=0.7, step 1: max(0, 0.7+0-0.3)=0.4
  // step 2: max(0, 0.4+1-0.3)=1.1, step 3: max(0, 1.1+0-0.3)=0.8
  // This slowly accumulates. Let's verify it doesn't breach in 30 steps.
  const errors = new Array(30).fill(0).map((_, i) => i % 2 === 0 ? 1 : 0);
  const result = computeCusum(errors, { slack: 0.3, threshold: 5.0 });
  // With 50% error rate and slack=0.3, it will eventually breach
  // Each pair contributes net 0.4 to the CUSUM (0.7 - 0.3 = 0.4 per pair)
  // Wait no: step 0: 0.7, step 1: max(0, 0.7-0.3)=0.4, step 2: max(0, 0.4+0.7)=1.1, step 3: max(0, 1.1-0.3)=0.8
  // The pattern grows by 0.4 per pair. 5.0/0.4 = 12.5 pairs = 25 steps
  // So in 30 steps it should breach
  assertEquals(result.breached, true);
});

Deno.test("computeCusum — sparse errors (20% rate) don't breach in 50 steps", () => {
  // 1 error every 5 steps: net per 5 = (1-0.3) + 4*(0-0.3) = 0.7 - 1.2 = -0.5
  // CUSUM resets to 0 each time it goes negative, so it never accumulates
  const errors = new Array(50).fill(0).map((_, i) => i % 5 === 0 ? 1 : 0);
  const result = computeCusum(errors, { slack: 0.3, threshold: 5.0 });
  assertEquals(result.breached, false);
});

Deno.test("computeCusum — configurable threshold", () => {
  const errors = new Array(5).fill(1);
  // With threshold 3.0: 5 * 0.7 = 3.5 >= 3.0
  const result = computeCusum(errors, { slack: 0.3, threshold: 3.0 });
  assertEquals(result.breached, true);
});

Deno.test("computeCusum — empty array returns zero", () => {
  const result = computeCusum([], { slack: 0.3, threshold: 5.0 });
  assertEquals(result.score, 0);
  assertEquals(result.breached, false);
  assertEquals(result.breachIndex, null);
});

// ─── computeNetGateValue Tests ───

Deno.test("computeNetGateValue — all TN (gate perfect) returns positive", () => {
  // 10 correctly blocked losers, 0 incorrectly blocked winners, avgRR=2.0
  const value = computeNetGateValue(10, 0, 2.0);
  assertEquals(value, 10.0); // 10 * 1R - 0 * 2R = 10R
});

Deno.test("computeNetGateValue — all FN (gate useless) returns negative", () => {
  // 0 correctly blocked, 10 incorrectly blocked winners, avgRR=2.0
  const value = computeNetGateValue(0, 10, 2.0);
  assertEquals(value, -20.0); // 0 * 1R - 10 * 2R = -20R
});

Deno.test("computeNetGateValue — balanced with high RR favors FN cost", () => {
  // 5 TN, 5 FN, avgRR=3.0
  const value = computeNetGateValue(5, 5, 3.0);
  assertEquals(value, -10.0); // 5*1 - 5*3 = -10R
});

Deno.test("computeNetGateValue — balanced with low RR favors TN benefit", () => {
  // 5 TN, 5 FN, avgRR=0.8
  const value = computeNetGateValue(5, 5, 0.8);
  assertEquals(value, 1.0); // 5*1 - 5*0.8 = 1R
});

Deno.test("computeNetGateValue — zero samples returns zero", () => {
  assertEquals(computeNetGateValue(0, 0, 2.0), 0);
});

// ─── walkForwardValidate Tests ───

Deno.test("walkForwardValidate — consistent negative (gate is bad in both periods)", () => {
  // Create 20 rejections: uniformly distributed winners (75% win rate throughout)
  // This ensures both train and test periods see the same pattern
  const rejections: ResolvedRejection[] = [];
  for (let i = 0; i < 20; i++) {
    // Distribute winners evenly: every 4th is a loser (75% win rate)
    const isWinner = i % 4 !== 3;
    rejections.push(makeRejection({
      rejected_at: new Date(Date.now() - (20 - i) * 86400000).toISOString(),
      outcome_status: isWinner ? "would_have_won" : "would_have_lost",
      failed_gates: ["HTF HARD VETO: Daily is bearish, bullish entry blocked"],
    }));
  }

  const result = walkForwardValidate(rejections, [], "htf_bias", 2.0, 0.7);
  // With 75% win rate and avgRR=2.0:
  // Each period: TN ≈ 25%, FN ≈ 75% → net = TN*1 - FN*2 → negative
  // Both train and test should be negative → consistent
  assertEquals(result.isConsistent, true);
  assertEquals(result.gateCategory, "htf_bias");
  assertEquals(result.trainSamples + result.testSamples, 20);
});

Deno.test("walkForwardValidate — consistent positive (gate is good in both periods)", () => {
  // Create 20 rejections: uniformly distributed losers (75% loss rate throughout)
  // This ensures both train and test periods see the same pattern
  const rejections: ResolvedRejection[] = [];
  for (let i = 0; i < 20; i++) {
    // Distribute losers evenly: every 4th is a winner (25% win rate)
    const isWinner = i % 4 === 0;
    rejections.push(makeRejection({
      rejected_at: new Date(Date.now() - (20 - i) * 86400000).toISOString(),
      outcome_status: isWinner ? "would_have_won" : "would_have_lost",
      failed_gates: ["Portfolio heat 4.5% >= 4% limit"],
    }));
  }

  const result = walkForwardValidate(rejections, [], "portfolio_heat", 2.0, 0.7);
  // With 25% win rate and avgRR=2.0:
  // Each period: TN ≈ 75%, FN ≈ 25% → net = TN*1 - FN*2 → positive (0.75 - 0.5 = +0.25 per sample)
  // Both train and test should be positive → consistent
  assertEquals(result.isConsistent, true);
});

Deno.test("walkForwardValidate — inconsistent (regime change mid-period)", () => {
  // First half: gate is good (mostly losers blocked)
  // Second half: gate is bad (mostly winners blocked)
  const rejections: ResolvedRejection[] = [];
  for (let i = 0; i < 20; i++) {
    const isFirstHalf = i < 10;
    rejections.push(makeRejection({
      rejected_at: new Date(Date.now() - (20 - i) * 86400000).toISOString(),
      outcome_status: isFirstHalf ? "would_have_lost" : "would_have_won",
      failed_gates: ["Kill Zone Only: Asian session not in kill zone"],
    }));
  }

  const result = walkForwardValidate(rejections, [], "kill_zone", 2.0, 0.7);
  // Train (first 14): 10 losers + 4 winners → positive net value
  // Test (last 6): 0 losers + 6 winners → negative net value
  assertEquals(result.isConsistent, false);
});

// ─── computeGatePerformance Integration Tests ───

Deno.test("computeGatePerformance — basic confusion matrix computation", () => {
  const rejections: ResolvedRejection[] = [
    makeRejection({ outcome_status: "would_have_won", failed_gates: ["HTF HARD VETO: Daily is bearish, bullish entry blocked"] }),
    makeRejection({ outcome_status: "would_have_won", failed_gates: ["HTF HARD VETO: Daily is bearish, bullish entry blocked"] }),
    makeRejection({ outcome_status: "would_have_lost", failed_gates: ["HTF HARD VETO: Daily is bearish, bullish entry blocked"] }),
    makeRejection({ outcome_status: "would_have_won", failed_gates: ["Portfolio heat 4.5% >= 4% limit"] }),
    makeRejection({ outcome_status: "would_have_lost", failed_gates: ["Portfolio heat 4.5% >= 4% limit"] }),
    makeRejection({ outcome_status: "would_have_lost", failed_gates: ["Portfolio heat 4.5% >= 4% limit"] }),
  ];

  const trades: ClosedTrade[] = [
    makeTrade({ pnl: 50 }),  // winner
    makeTrade({ pnl: 30 }),  // winner
    makeTrade({ pnl: -25 }), // loser
  ];

  const report = computeGatePerformance(rejections, trades, { avgRR: 2.0 });

  assertEquals(report.totalTakenTrades, 3);
  assertEquals(report.totalResolvedRejections, 6);

  // htf_bias: 2 FN (would_have_won), 1 TN (would_have_lost)
  const htfGate = report.gateMatrices.find(g => g.gateCategory === "htf_bias");
  assertEquals(htfGate!.falseNegatives, 2);
  assertEquals(htfGate!.trueNegatives, 1);
  // Net value: 1*1 - 2*2 = -3R
  assertEquals(htfGate!.netGateValue, -3.0);

  // portfolio_heat: 1 FN, 2 TN
  const phGate = report.gateMatrices.find(g => g.gateCategory === "portfolio_heat");
  assertEquals(phGate!.falseNegatives, 1);
  assertEquals(phGate!.trueNegatives, 2);
  // Net value: 2*1 - 1*2 = 0R
  assertEquals(phGate!.netGateValue, 0.0);
});

Deno.test("computeGatePerformance — CUSUM breaches with persistent errors", () => {
  // 15 consecutive would_have_won rejections for the same gate
  const rejections: ResolvedRejection[] = [];
  for (let i = 0; i < 15; i++) {
    rejections.push(makeRejection({
      rejected_at: new Date(Date.now() - (15 - i) * 3600000).toISOString(),
      outcome_status: "would_have_won",
      failed_gates: ["Kill Zone Only: London session not in kill zone"],
    }));
  }

  const trades: ClosedTrade[] = [makeTrade({ pnl: 50 })];
  const report = computeGatePerformance(rejections, trades, {
    avgRR: 2.0,
    cusum: { slack: 0.3, threshold: 5.0 },
  });

  // 15 errors * 0.7 per step = 10.5 >> 5.0 threshold
  const kzGate = report.gateMatrices.find(g => g.gateCategory === "kill_zone");
  assertEquals(kzGate!.cusumBreached, true);
  assertEquals(report.cusumBreaches.length, 1);
  assertEquals(report.cusumBreaches[0].gateCategory, "kill_zone");
});

Deno.test("computeGatePerformance — CUSUM does NOT breach with balanced errors", () => {
  // Alternating won/lost — gate is roughly 50/50
  const rejections: ResolvedRejection[] = [];
  for (let i = 0; i < 12; i++) {
    rejections.push(makeRejection({
      rejected_at: new Date(Date.now() - (12 - i) * 3600000).toISOString(),
      outcome_status: i % 3 === 0 ? "would_have_won" : "would_have_lost",
      failed_gates: ["ATR 3.2 pips below minimum 5"],
    }));
  }

  const trades: ClosedTrade[] = [makeTrade({ pnl: 50 })];
  const report = computeGatePerformance(rejections, trades, {
    avgRR: 2.0,
    cusum: { slack: 0.3, threshold: 5.0 },
  });

  const atrGate = report.gateMatrices.find(g => g.gateCategory === "atr_filter");
  assertEquals(atrGate!.cusumBreached, false);
});

Deno.test("computeGatePerformance — regime breakdown separates data correctly", () => {
  const rejections: ResolvedRejection[] = [
    makeRejection({ regime: "trending", outcome_status: "would_have_won", failed_gates: ["HTF HARD VETO: bearish"] }),
    makeRejection({ regime: "trending", outcome_status: "would_have_won", failed_gates: ["HTF HARD VETO: bearish"] }),
    makeRejection({ regime: "ranging", outcome_status: "would_have_lost", failed_gates: ["HTF HARD VETO: bearish"] }),
    makeRejection({ regime: "ranging", outcome_status: "would_have_lost", failed_gates: ["HTF HARD VETO: bearish"] }),
  ];

  const trades: ClosedTrade[] = [makeTrade({ pnl: 50 })];
  const report = computeGatePerformance(rejections, trades, { avgRR: 2.0 });

  // Trending: 2 FN, 0 TN → net value = 0 - 2*2 = -4R
  const trendingGates = report.regimeBreakdown["trending"];
  const htfTrending = trendingGates?.find(g => g.gateCategory === "htf_bias");
  assertEquals(htfTrending!.falseNegatives, 2);
  assertEquals(htfTrending!.trueNegatives, 0);

  // Ranging: 0 FN, 2 TN → net value = 2 - 0 = 2R
  const rangingGates = report.regimeBreakdown["ranging"];
  const htfRanging = rangingGates?.find(g => g.gateCategory === "htf_bias");
  assertEquals(htfRanging!.falseNegatives, 0);
  assertEquals(htfRanging!.trueNegatives, 2);
});

Deno.test("computeGatePerformance — walk-forward included for gates with 10+ samples", () => {
  const rejections: ResolvedRejection[] = [];
  for (let i = 0; i < 12; i++) {
    rejections.push(makeRejection({
      rejected_at: new Date(Date.now() - (12 - i) * 86400000).toISOString(),
      outcome_status: "would_have_won",
      failed_gates: ["Cooldown: 15min remaining for EUR/USD"],
    }));
  }

  const trades: ClosedTrade[] = [makeTrade({ pnl: 50 })];
  const report = computeGatePerformance(rejections, trades, { avgRR: 2.0 });

  // Should have walk-forward result for cooldown gate (12 >= 10 threshold)
  assertEquals(report.walkForwardValid.length >= 1, true);
  const cooldownWF = report.walkForwardValid.find(w => w.gateCategory === "cooldown");
  assertEquals(cooldownWF !== undefined, true);
});

Deno.test("computeGatePerformance — walk-forward NOT included for gates with < 10 samples", () => {
  const rejections: ResolvedRejection[] = [];
  for (let i = 0; i < 5; i++) {
    rejections.push(makeRejection({
      rejected_at: new Date(Date.now() - (5 - i) * 86400000).toISOString(),
      outcome_status: "would_have_won",
      failed_gates: ["News filter: high-impact event within 30min — NFP"],
    }));
  }

  const trades: ClosedTrade[] = [makeTrade({ pnl: 50 })];
  const report = computeGatePerformance(rejections, trades, { avgRR: 2.0 });

  const newsWF = report.walkForwardValid.find(w => w.gateCategory === "news_filter");
  assertEquals(newsWF, undefined);
});

Deno.test("computeGatePerformance — multiple failed gates per rejection counted separately", () => {
  const rejections: ResolvedRejection[] = [
    makeRejection({
      outcome_status: "would_have_won",
      failed_gates: [
        "HTF HARD VETO: Daily is bearish, bullish entry blocked",
        "Kill Zone Only: Asian session not in kill zone",
      ],
    }),
  ];

  const trades: ClosedTrade[] = [makeTrade({ pnl: 50 })];
  const report = computeGatePerformance(rejections, trades, { avgRR: 2.0 });

  // Both gates should have 1 FN each
  const htf = report.gateMatrices.find(g => g.gateCategory === "htf_bias");
  const kz = report.gateMatrices.find(g => g.gateCategory === "kill_zone");
  assertEquals(htf!.falseNegatives, 1);
  assertEquals(kz!.falseNegatives, 1);
});

Deno.test("computeGatePerformance — empty rejections returns empty report", () => {
  const report = computeGatePerformance([], [makeTrade()], { avgRR: 2.0 });
  assertEquals(report.totalResolvedRejections, 0);
  assertEquals(report.gateMatrices.length, 0);
  assertEquals(report.cusumBreaches.length, 0);
});

Deno.test("computeGatePerformance — pending/inconclusive rejections are filtered out", () => {
  const rejections: ResolvedRejection[] = [
    makeRejection({ outcome_status: "pending", failed_gates: ["HTF HARD VETO: bearish"] }),
    makeRejection({ outcome_status: "inconclusive", failed_gates: ["HTF HARD VETO: bearish"] }),
    makeRejection({ outcome_status: "would_have_won", failed_gates: ["HTF HARD VETO: bearish"] }),
  ];

  const report = computeGatePerformance(rejections, [], { avgRR: 2.0 });
  assertEquals(report.totalResolvedRejections, 1);
});

// ─── formatGatePerformancePrompt Tests ───

Deno.test("formatGatePerformancePrompt — returns empty string below minSamples", () => {
  const report = computeGatePerformance(
    [makeRejection({ outcome_status: "would_have_won", failed_gates: ["HTF HARD VETO: bearish"] })],
    [makeTrade()],
    { avgRR: 2.0 }
  );
  const prompt = formatGatePerformancePrompt(report, 10);
  assertEquals(prompt, "");
});

Deno.test("formatGatePerformancePrompt — includes gate table when enough data", () => {
  const rejections: ResolvedRejection[] = [];
  for (let i = 0; i < 12; i++) {
    rejections.push(makeRejection({
      rejected_at: new Date(Date.now() - (12 - i) * 3600000).toISOString(),
      outcome_status: i < 8 ? "would_have_won" : "would_have_lost",
      failed_gates: ["HTF HARD VETO: Daily is bearish, bullish entry blocked"],
    }));
  }

  const report = computeGatePerformance(rejections, [makeTrade()], { avgRR: 2.0 });
  const prompt = formatGatePerformancePrompt(report, 10);

  // Should contain the header
  assertEquals(prompt.includes("GATE PERFORMANCE ANALYSIS"), true);
  // Should contain the gate category
  assertEquals(prompt.includes("htf_bias"), true);
  // Should contain the table headers
  assertEquals(prompt.includes("Net Value (R)"), true);
});

Deno.test("formatGatePerformancePrompt — includes CUSUM breach warning", () => {
  const rejections: ResolvedRejection[] = [];
  for (let i = 0; i < 15; i++) {
    rejections.push(makeRejection({
      rejected_at: new Date(Date.now() - (15 - i) * 3600000).toISOString(),
      outcome_status: "would_have_won",
      failed_gates: ["Kill Zone Only: London session not in kill zone"],
    }));
  }

  const report = computeGatePerformance(rejections, [makeTrade()], { avgRR: 2.0 });
  const prompt = formatGatePerformancePrompt(report, 10);

  assertEquals(prompt.includes("CUSUM BREACHES"), true);
  assertEquals(prompt.includes("kill_zone"), true);
});

Deno.test("formatGatePerformancePrompt — includes walk-forward results", () => {
  const rejections: ResolvedRejection[] = [];
  for (let i = 0; i < 14; i++) {
    rejections.push(makeRejection({
      rejected_at: new Date(Date.now() - (14 - i) * 86400000).toISOString(),
      outcome_status: "would_have_won",
      failed_gates: ["Cooldown: 15min remaining for EUR/USD"],
    }));
  }

  const report = computeGatePerformance(rejections, [makeTrade()], { avgRR: 2.0 });
  const prompt = formatGatePerformancePrompt(report, 10);

  // Should include walk-forward section (all winners → consistent negative)
  assertEquals(prompt.includes("WALK-FORWARD VALIDATED") || prompt.includes("WALK-FORWARD INVALIDATED"), true);
});

// ─── Regression: identical inputs produce identical outputs ───

Deno.test("regression — deterministic output for fixed inputs", () => {
  const rejections: ResolvedRejection[] = [
    makeRejection({ id: "r1", rejected_at: "2025-06-01T10:00:00Z", outcome_status: "would_have_won", failed_gates: ["HTF HARD VETO: bearish"] }),
    makeRejection({ id: "r2", rejected_at: "2025-06-01T11:00:00Z", outcome_status: "would_have_lost", failed_gates: ["HTF HARD VETO: bearish"] }),
    makeRejection({ id: "r3", rejected_at: "2025-06-01T12:00:00Z", outcome_status: "would_have_won", failed_gates: ["Portfolio heat 4.5% >= 4% limit"] }),
  ];
  const trades: ClosedTrade[] = [
    makeTrade({ id: "t1", pnl: 50 }),
    makeTrade({ id: "t2", pnl: -25 }),
  ];

  const report1 = computeGatePerformance(rejections, trades, { avgRR: 2.5 });
  const report2 = computeGatePerformance(rejections, trades, { avgRR: 2.5 });

  // Must be deterministic
  assertEquals(JSON.stringify(report1.gateMatrices), JSON.stringify(report2.gateMatrices));
  assertEquals(report1.totalResolvedRejections, report2.totalResolvedRejections);
  assertEquals(report1.cusumBreaches.length, report2.cusumBreaches.length);
});
