/**
 * gatePerformanceEngine.ts — Unified Gate Performance Analysis
 * ─────────────────────────────────────────────────────────────
 * Computes per-gate confusion matrices, CUSUM change detection,
 * Net Gate Value, and walk-forward validated recommendations.
 *
 * Used by bot-daily-review and bot-weekly-advisor to provide
 * the LLM with unified taken-vs-blocked performance data.
 *
 * References:
 * - CUSUM: Page (1954), Morgan Stanley PSG (2025)
 * - Meta-Labeling: López de Prado, "Advances in Financial ML" Ch.3
 * - Reject Inference: Banasik & Crook (2007), banking industry standard
 *
 * Run: deno test --allow-all supabase/functions/_shared/gatePerformanceEngine.test.ts
 */

// ─── Types ───

export interface ResolvedRejection {
  id: string;
  symbol: string;
  direction: string;
  failed_gates: string[] | null;
  confluence_score: number;
  tier1_count: number;
  outcome_status: string; // "would_have_won" | "would_have_lost"
  mfe_pips: number | null;
  mae_pips: number | null;
  tp_hit: boolean | null;
  sl_hit: boolean | null;
  regime: string | null;
  session_name: string | null;
  rejected_at: string;
  rr_ratio: number | null;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  direction: string;
  pnl: number; // positive = win, negative = loss
  rr_achieved: number | null;
  close_time: string;
  regime?: string | null;
}

export interface GateConfusionMatrix {
  gateCategory: string;
  truePositives: number;   // Gate passed, trade won
  falsePositives: number;  // Gate passed, trade lost
  trueNegatives: number;   // Gate blocked, would have lost
  falseNegatives: number;  // Gate blocked, would have won
  precision: number;       // TP / (TP + FP)
  recall: number;          // TP / (TP + FN)
  f1Score: number;         // 2 * (P * R) / (P + R)
  netGateValue: number;    // Protection benefit - opportunity cost (in R-units)
  cusumScore: number;      // Running CUSUM of gate errors
  cusumBreached: boolean;  // Has CUSUM exceeded threshold h?
  sampleSize: number;      // Total observations for this gate
}

export interface GatePerformanceReport {
  period: string;
  totalTakenTrades: number;
  totalResolvedRejections: number;
  gateMatrices: GateConfusionMatrix[];
  topOpportunityCostGates: GateConfusionMatrix[];
  cusumBreaches: GateConfusionMatrix[];
  regimeBreakdown: Record<string, GateConfusionMatrix[]>;
  walkForwardValid: WalkForwardResult[];
}

export interface WalkForwardResult {
  gateCategory: string;
  trainNetValue: number;
  testNetValue: number;
  isConsistent: boolean; // Both train and test agree on direction (positive or negative)
  trainSamples: number;
  testSamples: number;
}

export interface CusumOptions {
  /** Slack parameter — allowable deviation before accumulation. Default 0.3 */
  slack: number;
  /** Threshold — cumulative sum that triggers a breach. Default 5.0 */
  threshold: number;
}

export interface EngineOptions {
  cusum?: Partial<CusumOptions>;
  /** Average R:R achieved by the bot (for Net Gate Value calc). Default 2.0 */
  avgRR?: number;
  /** Walk-forward split ratio (fraction used for training). Default 0.7 */
  walkForwardSplit?: number;
}

// ─── Gate Normalization ───

/**
 * Gate category definitions with their matching patterns.
 * Order matters: first match wins.
 */
const GATE_PATTERNS: Array<{ category: string; patterns: string[] }> = [
  { category: "htf_bias", patterns: ["HTF HARD VETO", "HTF bias mismatch", "HTF regime veto"] },
  { category: "premium_discount", patterns: ["Buying in premium", "Selling in discount"] },
  { category: "structural_conviction", patterns: ["Structural Conviction BLOCKED"] },
  { category: "reaction_confirmation", patterns: ["Reaction Confirmation BLOCKED"] },
  { category: "instrument_filter", patterns: ["not in enabled instruments"] },
  { category: "max_positions", patterns: ["Max positions"] },
  { category: "duplicate_position", patterns: ["Already "] },
  { category: "max_per_symbol", patterns: ["Max ", " positions for "] },
  { category: "portfolio_heat", patterns: ["Portfolio heat"] },
  { category: "daily_loss", patterns: ["Daily loss", "Daily net P&L"] },
  { category: "max_drawdown", patterns: ["Drawdown"] },
  { category: "min_confluence", patterns: ["Score ", "threshold"] },
  { category: "smt_veto", patterns: ["SMT divergence opposite"] },
  { category: "min_rr", patterns: ["R:R "] },
  { category: "opening_range", patterns: ["OR not complete"] },
  { category: "kill_zone", patterns: ["Kill Zone Only"] },
  { category: "cooldown", patterns: ["Cooldown"] },
  { category: "consecutive_losses", patterns: ["consecutive losses"] },
  { category: "news_filter", patterns: ["News filter", "News conflict"] },
  { category: "atr_filter", patterns: ["ATR "] },
  { category: "correlation", patterns: ["Correlation conflict", "Correlated exposure"] },
  { category: "tier1_gate", patterns: ["Tier 1", "tier1", "T1 "] },
  { category: "regime_gate", patterns: ["Regime gate", "regime mismatch", "Regime alignment"] },
];

/**
 * Normalize a raw gate reason string into a gate category.
 * Returns null if the reason doesn't match any known gate pattern.
 */
export function normalizeGateReason(reason: string): string | null {
  if (!reason || typeof reason !== "string") return null;

  for (const { category, patterns } of GATE_PATTERNS) {
    for (const pattern of patterns) {
      if (reason.includes(pattern)) {
        return category;
      }
    }
  }
  return null;
}

// ─── CUSUM Implementation ───

/**
 * Compute one-sided upper CUSUM for a sequence of errors.
 * Each error is 1 (gate was wrong) or 0 (gate was right).
 *
 * For a gate blocking a setup:
 * - Error = 1 if outcome_status === "would_have_won" (gate was wrong to block)
 * - Error = 0 if outcome_status === "would_have_lost" (gate was right to block)
 *
 * Returns the final CUSUM value and whether it breached the threshold.
 */
export function computeCusum(
  errors: number[],
  options: CusumOptions = { slack: 0.3, threshold: 5.0 }
): { score: number; breached: boolean; breachIndex: number | null } {
  const { slack, threshold } = options;
  let cusum = 0;
  let breachIndex: number | null = null;

  for (let i = 0; i < errors.length; i++) {
    cusum = Math.max(0, cusum + errors[i] - slack);
    if (cusum >= threshold && breachIndex === null) {
      breachIndex = i;
    }
  }

  return {
    score: cusum,
    breached: cusum >= threshold,
    breachIndex,
  };
}

// ─── Net Gate Value ───

/**
 * Calculate Net Gate Value in R-units.
 *
 * Protection benefit: Each correctly blocked loser saves 1R.
 * Opportunity cost: Each incorrectly blocked winner costs avgRR × 1R.
 *
 * Positive = gate is net beneficial (protecting more than costing).
 * Negative = gate is net harmful (costing more than protecting).
 */
export function computeNetGateValue(
  trueNegatives: number,
  falseNegatives: number,
  avgRR: number
): number {
  const protectionBenefit = trueNegatives * 1.0; // Each avoided loss saves 1R
  const opportunityCost = falseNegatives * avgRR; // Each missed winner costs avgRR
  return protectionBenefit - opportunityCost;
}

// ─── Walk-Forward Validation ───

/**
 * Split data chronologically and verify that gate performance
 * conclusions hold in the out-of-sample (test) period.
 *
 * A recommendation is "walk-forward valid" if the Net Gate Value
 * has the same sign in both train and test periods.
 */
export function walkForwardValidate(
  rejections: ResolvedRejection[],
  trades: ClosedTrade[],
  gateCategory: string,
  avgRR: number,
  splitRatio: number = 0.7
): WalkForwardResult {
  // Sort rejections chronologically
  const sorted = [...rejections]
    .filter(r => {
      const cats = (r.failed_gates || []).map(normalizeGateReason).filter(Boolean);
      return cats.includes(gateCategory);
    })
    .sort((a, b) => new Date(a.rejected_at).getTime() - new Date(b.rejected_at).getTime());

  const splitIdx = Math.floor(sorted.length * splitRatio);
  const trainSet = sorted.slice(0, splitIdx);
  const testSet = sorted.slice(splitIdx);

  const computeNetValue = (set: ResolvedRejection[]): number => {
    const tn = set.filter(r => r.outcome_status === "would_have_lost").length;
    const fn = set.filter(r => r.outcome_status === "would_have_won").length;
    return computeNetGateValue(tn, fn, avgRR);
  };

  const trainNetValue = computeNetValue(trainSet);
  const testNetValue = computeNetValue(testSet);

  // Consistent = both positive (gate is good) or both negative (gate is bad)
  const isConsistent = (trainNetValue >= 0 && testNetValue >= 0) ||
                       (trainNetValue < 0 && testNetValue < 0);

  return {
    gateCategory,
    trainNetValue: parseFloat(trainNetValue.toFixed(2)),
    testNetValue: parseFloat(testNetValue.toFixed(2)),
    isConsistent,
    trainSamples: trainSet.length,
    testSamples: testSet.length,
  };
}

// ─── Main Engine ───

/**
 * Compute the full gate performance report.
 *
 * @param resolvedRejections - Rejected setups with outcome resolved (would_have_won/lost)
 * @param closedTrades - Trades from paper_trade_history (with pnl for win/loss)
 * @param options - CUSUM parameters, avg R:R, walk-forward split
 */
export function computeGatePerformance(
  resolvedRejections: ResolvedRejection[],
  closedTrades: ClosedTrade[],
  options: EngineOptions = {}
): GatePerformanceReport {
  const cusumOpts: CusumOptions = {
    slack: options.cusum?.slack ?? 0.3,
    threshold: options.cusum?.threshold ?? 5.0,
  };
  const avgRR = options.avgRR ?? 2.0;
  const walkForwardSplit = options.walkForwardSplit ?? 0.7;

  // Filter to only resolved outcomes
  const resolved = resolvedRejections.filter(
    r => r.outcome_status === "would_have_won" || r.outcome_status === "would_have_lost"
  );

  // Classify trades
  const winningTrades = closedTrades.filter(t => t.pnl > 0);
  const losingTrades = closedTrades.filter(t => t.pnl <= 0);

  // ─── Build per-gate confusion matrices ───
  const gateData = new Map<string, {
    trueNegatives: number;   // blocked + would have lost
    falseNegatives: number;  // blocked + would have won
    errors: number[];        // chronological error sequence for CUSUM
    rejections: ResolvedRejection[]; // for walk-forward
  }>();

  // Process rejections (TN and FN)
  // Sort by time for CUSUM
  const sortedRejections = [...resolved].sort(
    (a, b) => new Date(a.rejected_at).getTime() - new Date(b.rejected_at).getTime()
  );

  for (const rejection of sortedRejections) {
    if (!rejection.failed_gates) continue;
    const isWinner = rejection.outcome_status === "would_have_won";

    for (const rawGate of rejection.failed_gates) {
      const category = normalizeGateReason(rawGate);
      if (!category) continue;

      const entry = gateData.get(category) || {
        trueNegatives: 0,
        falseNegatives: 0,
        errors: [],
        rejections: [],
      };

      if (isWinner) {
        entry.falseNegatives++;
        entry.errors.push(1); // Error: gate was wrong
      } else {
        entry.trueNegatives++;
        entry.errors.push(0); // Correct: gate was right
      }
      entry.rejections.push(rejection);
      gateData.set(category, entry);
    }
  }

  // TP and FP come from taken trades
  // If a trade was taken and won → all gates passed correctly (TP for each gate)
  // If a trade was taken and lost → all gates passed incorrectly (FP for each gate)
  const totalTP = winningTrades.length;
  const totalFP = losingTrades.length;

  // ─── Compute matrices ───
  const gateMatrices: GateConfusionMatrix[] = [];

  for (const [category, data] of gateData.entries()) {
    const { trueNegatives, falseNegatives, errors } = data;

    // For per-gate TP/FP, we use the global taken-trade stats
    // (since all gates must pass for a trade to be taken)
    const tp = totalTP;
    const fp = totalFP;
    const tn = trueNegatives;
    const fn = falseNegatives;

    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1 = (precision + recall) > 0 ? 2 * (precision * recall) / (precision + recall) : 0;
    const netValue = computeNetGateValue(tn, fn, avgRR);
    const cusum = computeCusum(errors, cusumOpts);

    gateMatrices.push({
      gateCategory: category,
      truePositives: tp,
      falsePositives: fp,
      trueNegatives: tn,
      falseNegatives: fn,
      precision: parseFloat(precision.toFixed(4)),
      recall: parseFloat(recall.toFixed(4)),
      f1Score: parseFloat(f1.toFixed(4)),
      netGateValue: parseFloat(netValue.toFixed(2)),
      cusumScore: parseFloat(cusum.score.toFixed(2)),
      cusumBreached: cusum.breached,
      sampleSize: tn + fn,
    });
  }

  // Sort by opportunity cost (most false negatives first)
  const topOpportunityCostGates = [...gateMatrices]
    .sort((a, b) => b.falseNegatives - a.falseNegatives);

  // Gates where CUSUM has breached
  const cusumBreaches = gateMatrices.filter(g => g.cusumBreached);

  // ─── Regime breakdown ───
  const regimeBreakdown: Record<string, GateConfusionMatrix[]> = {};
  const regimes = [...new Set(resolved.map(r => r.regime || "unknown"))];

  for (const regime of regimes) {
    const regimeRejections = resolved.filter(r => (r.regime || "unknown") === regime);
    const regimeGateData = new Map<string, { tn: number; fn: number }>();

    for (const rejection of regimeRejections) {
      if (!rejection.failed_gates) continue;
      const isWinner = rejection.outcome_status === "would_have_won";

      for (const rawGate of rejection.failed_gates) {
        const category = normalizeGateReason(rawGate);
        if (!category) continue;

        const entry = regimeGateData.get(category) || { tn: 0, fn: 0 };
        if (isWinner) entry.fn++;
        else entry.tn++;
        regimeGateData.set(category, entry);
      }
    }

    regimeBreakdown[regime] = Array.from(regimeGateData.entries()).map(([cat, { tn, fn }]) => ({
      gateCategory: cat,
      truePositives: totalTP,
      falsePositives: totalFP,
      trueNegatives: tn,
      falseNegatives: fn,
      precision: (totalTP + totalFP) > 0 ? parseFloat((totalTP / (totalTP + totalFP)).toFixed(4)) : 0,
      recall: (totalTP + fn) > 0 ? parseFloat((totalTP / (totalTP + fn)).toFixed(4)) : 0,
      f1Score: 0, // Simplified for regime breakdown
      netGateValue: parseFloat(computeNetGateValue(tn, fn, avgRR).toFixed(2)),
      cusumScore: 0,
      cusumBreached: false,
      sampleSize: tn + fn,
    }));
  }

  // ─── Walk-forward validation ───
  const walkForwardValid: WalkForwardResult[] = [];

  // Only validate gates with enough data (at least 10 rejections for this gate)
  for (const [category, data] of gateData.entries()) {
    if (data.rejections.length >= 10) {
      const result = walkForwardValidate(
        resolved,
        closedTrades,
        category,
        avgRR,
        walkForwardSplit
      );
      // Only include if test set has at least 3 samples
      if (result.testSamples >= 3) {
        walkForwardValid.push(result);
      }
    }
  }

  return {
    period: "custom",
    totalTakenTrades: closedTrades.length,
    totalResolvedRejections: resolved.length,
    gateMatrices,
    topOpportunityCostGates,
    cusumBreaches,
    regimeBreakdown,
    walkForwardValid,
  };
}

/**
 * Format the gate performance report as a text section for the LLM prompt.
 * Returns empty string if insufficient data.
 *
 * @param report - The computed gate performance report
 * @param minSamples - Minimum resolved rejections to include analysis (default 10)
 */
export function formatGatePerformancePrompt(
  report: GatePerformanceReport,
  minSamples: number = 10
): string {
  if (report.totalResolvedRejections < minSamples) {
    return "";
  }

  let prompt = `\n=== GATE PERFORMANCE ANALYSIS (Taken vs Blocked — Unified View) ===\n`;
  prompt += `Taken trades: ${report.totalTakenTrades} | Resolved rejected setups: ${report.totalResolvedRejections}\n`;

  // Top opportunity cost gates (max 8)
  const topGates = report.topOpportunityCostGates
    .filter(g => g.sampleSize >= 3)
    .slice(0, 8);

  if (topGates.length > 0) {
    prompt += `\nGate | Blocked | Would Won | Would Lost | FN Rate | Net Value (R) | CUSUM\n`;
    prompt += `---|---|---|---|---|---|---\n`;
    for (const g of topGates) {
      const fnRate = g.sampleSize > 0 ? ((g.falseNegatives / g.sampleSize) * 100).toFixed(0) : "0";
      const cusumFlag = g.cusumBreached ? " ⚠️" : "";
      prompt += `${g.gateCategory} | ${g.sampleSize} | ${g.falseNegatives} | ${g.trueNegatives} | ${fnRate}% | ${g.netGateValue.toFixed(1)}R | ${g.cusumScore.toFixed(1)}${cusumFlag}\n`;
    }
  }

  // CUSUM breaches
  if (report.cusumBreaches.length > 0) {
    prompt += `\n⚠️ CUSUM BREACHES (statistically significant persistent over-filtering):\n`;
    for (const g of report.cusumBreaches) {
      prompt += `- ${g.gateCategory}: CUSUM=${g.cusumScore.toFixed(1)} (breached threshold) — ${g.falseNegatives} winners blocked, Net Value=${g.netGateValue.toFixed(1)}R\n`;
    }
  }

  // Walk-forward validation results
  const invalidated = report.walkForwardValid.filter(w => !w.isConsistent);
  const validated = report.walkForwardValid.filter(w => w.isConsistent && w.testNetValue < 0);

  if (validated.length > 0) {
    prompt += `\n✅ WALK-FORWARD VALIDATED (conclusion holds in out-of-sample period):\n`;
    for (const w of validated) {
      prompt += `- ${w.gateCategory}: Train=${w.trainNetValue.toFixed(1)}R, Test=${w.testNetValue.toFixed(1)}R (consistent negative — gate is over-filtering)\n`;
    }
  }

  if (invalidated.length > 0) {
    prompt += `\n❌ WALK-FORWARD INVALIDATED (conclusion does NOT hold out-of-sample — do NOT recommend changes):\n`;
    for (const w of invalidated) {
      prompt += `- ${w.gateCategory}: Train=${w.trainNetValue.toFixed(1)}R, Test=${w.testNetValue.toFixed(1)}R (inconsistent — likely noise)\n`;
    }
  }

  // Regime breakdown (only show regimes with meaningful data)
  const significantRegimes = Object.entries(report.regimeBreakdown)
    .filter(([_, gates]) => gates.reduce((sum, g) => sum + g.sampleSize, 0) >= 5);

  if (significantRegimes.length > 1) {
    prompt += `\nRegime-specific gate performance:\n`;
    for (const [regime, gates] of significantRegimes) {
      const worstGate = gates.sort((a, b) => a.netGateValue - b.netGateValue)[0];
      if (worstGate && worstGate.netGateValue < 0) {
        prompt += `- ${regime}: worst gate = ${worstGate.gateCategory} (${worstGate.netGateValue.toFixed(1)}R, ${worstGate.falseNegatives} FN / ${worstGate.sampleSize} total)\n`;
      }
    }
  }

  return prompt;
}
