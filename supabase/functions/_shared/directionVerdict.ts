/**
 * directionVerdict.ts — Single Source of Truth for Trade Direction
 * ═══════════════════════════════════════════════════════════════════
 *
 * Consolidates 6 competing direction sources into ONE verdict:
 *
 *   SPINE (determines direction):
 *     1. confirmedTrend (fib-filtered MSBs on Daily)
 *     2. SimpleDirection fallback (4H+1H CHoCH/BOS)
 *
 *   CONTEXT (modifies confidence, never flips direction):
 *     3. Regime Classification (trending/ranging/volatile)
 *     4. Weekly Bias (ICT HTF weekly candle structure)
 *
 *   ADVISORY (score modifier only):
 *     5. Game Plan Bias (LLM-generated premarket analysis)
 *
 * Output: { verdict, confidence, sources, scoreAdjustment }
 *   - verdict: "long" | "short" | "neutral"
 *   - confidence: 0-100 (used for size scaling + gate threshold)
 *   - sources: which inputs agreed/disagreed
 *   - scoreAdjustment: net score modifier to apply to confluence
 *
 * This module is ADDITIVE — it does NOT modify existing gates or scoring.
 * It is wired as a parallel computation for logging/validation first.
 * Once validated, it replaces Gate 1, Gate 20, falling knife guard,
 * Factor 22, and the GP bias adjustment.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type VerdictDirection = "long" | "short" | "neutral";

export interface DirectionSource {
  name: string;
  direction: "bullish" | "bearish" | "neutral" | null;
  confidence: number; // 0-100
  weight: number;     // How much this source matters (0-1)
  detail: string;
}

export interface DirectionVerdictResult {
  /** Final direction decision */
  verdict: VerdictDirection;
  /** Confidence 0-100 — below 40 = neutral, 40-60 = low, 60-80 = medium, 80+ = high */
  confidence: number;
  /** Net score adjustment to apply (replaces regime + GP + Factor 22 adjustments) */
  scoreAdjustment: number;
  /** Whether this verdict would BLOCK the trade (replaces Gate 1 + Gate 20 + falling knife) */
  shouldBlock: boolean;
  /** Block reason (if shouldBlock = true) */
  blockReason: string | null;
  /** Individual source contributions */
  sources: DirectionSource[];
  /** How many sources agree with the verdict */
  agreement: number; // 0-1 (1 = all agree)
  /** Human-readable summary */
  summary: string;
}

export interface DirectionVerdictInput {
  /** From directionEngine.ts confirmedTrend() */
  confirmedTrend: {
    trend: "bullish" | "bearish" | "ranging";
    reason: string;
  } | null;

  /** From directionEngine.ts determineDirection() */
  simpleDirection: {
    direction: "long" | "short" | null;
    bias: "bullish" | "bearish" | null;
    biasSource: "daily" | "4h" | null;
    h4Retrace: boolean;
    h4ChochAgainst: boolean;
    h1Confirmed: boolean;
    reason: string;
  } | null;

  /** From smcAnalysis.ts classifyInstrumentRegime() */
  regime: {
    regime: string;       // "strong_trend" | "mild_trend" | "choppy_range" | "mild_range" | "transitional"
    confidence: number;   // 0-1
    directionalBias: string; // "bullish" | "bearish" | "neutral"
  } | null;

  /** From weeklyBiasDOL.ts analyzeWeeklyBiasAndDOL() */
  weeklyBias: {
    bias: "bullish" | "bearish" | "neutral";
    confidence: number;   // 0-100
  } | null;

  /** From gamePlan.ts */
  gamePlanBias: {
    bias: "bullish" | "bearish" | "neutral";
    confidence: number;   // 0-100
  } | null;
}

// ─── Configuration ───────────────────────────────────────────────────

export interface DirectionVerdictConfig {
  /** Minimum confidence to produce a non-neutral verdict (default: 40) */
  minConfidence: number;
  /** Confidence below which the trade is blocked (default: 25) */
  blockThreshold: number;
  /** Maximum score penalty for opposing context (default: -2.0) */
  maxPenalty: number;
  /** Maximum score bonus for aligned context (default: 1.5) */
  maxBonus: number;
  /** Whether regime can veto (block) a trade when strongly opposing (default: true) */
  regimeCanVeto: boolean;
  /** Regime confidence threshold for veto (default: 0.75) */
  regimeVetoThreshold: number;
}

export const DEFAULT_VERDICT_CONFIG: DirectionVerdictConfig = {
  minConfidence: 40,
  blockThreshold: 25,
  maxPenalty: -2.0,
  maxBonus: 1.5,
  regimeCanVeto: true,
  regimeVetoThreshold: 0.75,
};

// ─── Source Weights ──────────────────────────────────────────────────
// These define how much each source contributes to the final confidence.
// The spine sources (confirmedTrend + simpleDirection) determine direction.
// Context sources can only reduce confidence, never flip direction.

const WEIGHTS = {
  confirmedTrend: 0.40,   // Strongest — fib-filtered, close-based MSBs
  simpleDirection: 0.25,  // Second — multi-TF CHoCH/BOS
  regime: 0.15,           // Context — can reduce confidence
  weeklyBias: 0.12,       // Context — weekly structure
  gamePlan: 0.08,         // Advisory — LLM-generated, lowest weight
} as const;

// ─── Main Function ───────────────────────────────────────────────────

export function computeDirectionVerdict(
  input: DirectionVerdictInput,
  config: Partial<DirectionVerdictConfig> = {},
): DirectionVerdictResult {
  const cfg = { ...DEFAULT_VERDICT_CONFIG, ...config };
  const sources: DirectionSource[] = [];

  // ── 1. SPINE: Determine base direction from structural sources ──

  let spineDirection: "bullish" | "bearish" | null = null;
  let spineConfidence = 0;

  // 1a. Confirmed Trend (primary spine)
  if (input.confirmedTrend && input.confirmedTrend.trend !== "ranging") {
    const dir = input.confirmedTrend.trend; // "bullish" | "bearish"
    spineDirection = dir;
    spineConfidence = 80; // High base confidence for fib-confirmed trend
    sources.push({
      name: "confirmedTrend",
      direction: dir,
      confidence: 80,
      weight: WEIGHTS.confirmedTrend,
      detail: input.confirmedTrend.reason,
    });
  } else {
    sources.push({
      name: "confirmedTrend",
      direction: input.confirmedTrend?.trend === "ranging" ? "neutral" : null,
      confidence: 0,
      weight: WEIGHTS.confirmedTrend,
      detail: input.confirmedTrend?.reason ?? "No data",
    });
  }

  // 1b. Simple Direction (fallback/confirmation)
  if (input.simpleDirection && input.simpleDirection.direction) {
    const dir = input.simpleDirection.bias ?? (input.simpleDirection.direction === "long" ? "bullish" : "bearish");
    let conf = 50; // Base confidence for simple direction
    if (input.simpleDirection.h1Confirmed) conf += 15;
    if (input.simpleDirection.h4Retrace) conf += 10;
    if (input.simpleDirection.h4ChochAgainst) conf -= 30; // Strong negative signal

    sources.push({
      name: "simpleDirection",
      direction: dir,
      confidence: Math.max(0, Math.min(100, conf)),
      weight: WEIGHTS.simpleDirection,
      detail: input.simpleDirection.reason,
    });

    // If confirmedTrend didn't produce a direction, use simpleDirection as spine
    if (!spineDirection) {
      spineDirection = dir;
      spineConfidence = Math.max(0, Math.min(100, conf));
    }
    // If confirmedTrend agrees, boost confidence
    else if (spineDirection === dir) {
      spineConfidence = Math.min(100, spineConfidence + 10);
    }
    // If confirmedTrend disagrees, reduce confidence
    else {
      spineConfidence = Math.max(20, spineConfidence - 20);
    }
  } else {
    sources.push({
      name: "simpleDirection",
      direction: null,
      confidence: 0,
      weight: WEIGHTS.simpleDirection,
      detail: input.simpleDirection?.reason ?? "No data",
    });
  }

  // If no spine direction at all, return neutral
  if (!spineDirection) {
    return {
      verdict: "neutral",
      confidence: 0,
      scoreAdjustment: 0,
      shouldBlock: true,
      blockReason: "No directional signal from either confirmedTrend or simpleDirection",
      sources,
      agreement: 0,
      summary: "No direction — both structural sources are neutral/unavailable",
    };
  }

  // ── 2. CONTEXT: Modify confidence based on regime + weekly ──

  let contextAdjustment = 0;

  // 2a. Regime Classification
  if (input.regime && input.regime.confidence > 0.5) {
    const regimeBias = input.regime.directionalBias as "bullish" | "bearish" | "neutral";
    const regimeConf = input.regime.confidence * 100;
    const isAligned = regimeBias === spineDirection;
    const isOpposing = regimeBias !== "neutral" && regimeBias !== spineDirection;
    const isRanging = input.regime.regime.includes("range") || input.regime.regime === "choppy_range";

    if (isAligned) {
      contextAdjustment += 10 * input.regime.confidence;
      sources.push({
        name: "regime",
        direction: regimeBias,
        confidence: regimeConf,
        weight: WEIGHTS.regime,
        detail: `${input.regime.regime} regime ALIGNS with ${spineDirection} (conf: ${regimeConf.toFixed(0)}%)`,
      });
    } else if (isOpposing) {
      contextAdjustment -= 20 * input.regime.confidence;
      sources.push({
        name: "regime",
        direction: regimeBias,
        confidence: regimeConf,
        weight: WEIGHTS.regime,
        detail: `${input.regime.regime} regime OPPOSES ${spineDirection} — bias is ${regimeBias} (conf: ${regimeConf.toFixed(0)}%)`,
      });
    } else if (isRanging) {
      contextAdjustment -= 10 * input.regime.confidence;
      sources.push({
        name: "regime",
        direction: "neutral",
        confidence: regimeConf,
        weight: WEIGHTS.regime,
        detail: `${input.regime.regime} — no directional edge (conf: ${regimeConf.toFixed(0)}%)`,
      });
    } else {
      sources.push({
        name: "regime",
        direction: "neutral",
        confidence: regimeConf,
        weight: WEIGHTS.regime,
        detail: `Transitional regime — no adjustment`,
      });
    }
  } else {
    sources.push({
      name: "regime",
      direction: null,
      confidence: 0,
      weight: WEIGHTS.regime,
      detail: "Regime data unavailable or low confidence",
    });
  }

  // 2b. Weekly Bias
  if (input.weeklyBias && input.weeklyBias.bias !== "neutral" && input.weeklyBias.confidence > 40) {
    const wkBias = input.weeklyBias.bias;
    const wkConf = input.weeklyBias.confidence;
    const isAligned = wkBias === spineDirection;
    const isOpposing = wkBias !== spineDirection;

    if (isAligned) {
      contextAdjustment += 8 * (wkConf / 100);
      sources.push({
        name: "weeklyBias",
        direction: wkBias,
        confidence: wkConf,
        weight: WEIGHTS.weeklyBias,
        detail: `Weekly bias ${wkBias} ALIGNS (conf: ${wkConf}%)`,
      });
    } else if (isOpposing) {
      contextAdjustment -= 12 * (wkConf / 100);
      sources.push({
        name: "weeklyBias",
        direction: wkBias,
        confidence: wkConf,
        weight: WEIGHTS.weeklyBias,
        detail: `Weekly bias ${wkBias} OPPOSES ${spineDirection} (conf: ${wkConf}%)`,
      });
    }
  } else {
    sources.push({
      name: "weeklyBias",
      direction: input.weeklyBias?.bias ?? null,
      confidence: input.weeklyBias?.confidence ?? 0,
      weight: WEIGHTS.weeklyBias,
      detail: input.weeklyBias ? `Weekly bias ${input.weeklyBias.bias} (conf: ${input.weeklyBias.confidence}% — below threshold)` : "No weekly data",
    });
  }

  // ── 3. ADVISORY: Game Plan (lightest touch) ──

  if (input.gamePlanBias && input.gamePlanBias.bias !== "neutral" && input.gamePlanBias.confidence >= 50) {
    const gpBias = input.gamePlanBias.bias;
    const gpConf = input.gamePlanBias.confidence;
    const isAligned = gpBias === spineDirection;

    if (isAligned) {
      contextAdjustment += 5 * (gpConf / 100);
    } else {
      contextAdjustment -= 5 * (gpConf / 100);
    }
    sources.push({
      name: "gamePlan",
      direction: gpBias,
      confidence: gpConf,
      weight: WEIGHTS.gamePlan,
      detail: `GP bias ${gpBias} ${isAligned ? "aligns" : "opposes"} (conf: ${gpConf}%)`,
    });
  } else {
    sources.push({
      name: "gamePlan",
      direction: input.gamePlanBias?.bias ?? null,
      confidence: input.gamePlanBias?.confidence ?? 0,
      weight: WEIGHTS.gamePlan,
      detail: input.gamePlanBias ? `GP bias ${input.gamePlanBias.bias} (conf: ${input.gamePlanBias.confidence}% — below threshold)` : "No game plan",
    });
  }

  // ── 4. COMPUTE FINAL CONFIDENCE ──

  const finalConfidence = Math.max(0, Math.min(100, spineConfidence + contextAdjustment));

  // ── 5. DETERMINE VERDICT ──

  let verdict: VerdictDirection;
  if (finalConfidence < cfg.minConfidence) {
    verdict = "neutral";
  } else {
    verdict = spineDirection === "bullish" ? "long" : "short";
  }

  // ── 6. BLOCK CHECK ──

  let shouldBlock = false;
  let blockReason: string | null = null;

  // Block if confidence is too low
  if (finalConfidence < cfg.blockThreshold) {
    shouldBlock = true;
    blockReason = `Direction confidence ${finalConfidence.toFixed(0)}% below block threshold ${cfg.blockThreshold}%`;
  }

  // Regime veto: if regime strongly opposes and confidence is high
  if (cfg.regimeCanVeto && input.regime && !shouldBlock) {
    const regimeBias = input.regime.directionalBias;
    const isStronglyOpposing = regimeBias !== "neutral" && regimeBias !== spineDirection;
    const regimeIsStrong = input.regime.confidence >= cfg.regimeVetoThreshold;
    const regimeIsTrending = input.regime.regime === "strong_trend" || input.regime.regime === "mild_trend";

    if (isStronglyOpposing && regimeIsStrong && regimeIsTrending) {
      shouldBlock = true;
      blockReason = `Regime veto: ${input.regime.regime} (${(input.regime.confidence * 100).toFixed(0)}% conf) strongly opposes ${spineDirection} direction`;
    }
  }

  // ── 7. SCORE ADJUSTMENT ──
  // Convert confidence into a score modifier (replaces regime + GP + Factor 22 adjustments)

  let scoreAdjustment = 0;
  if (verdict !== "neutral") {
    // Scale from -maxPenalty to +maxBonus based on confidence
    const normalizedConf = (finalConfidence - 50) / 50; // -1 to +1
    if (normalizedConf >= 0) {
      scoreAdjustment = normalizedConf * cfg.maxBonus;
    } else {
      scoreAdjustment = normalizedConf * Math.abs(cfg.maxPenalty);
    }
    scoreAdjustment = Math.max(cfg.maxPenalty, Math.min(cfg.maxBonus, scoreAdjustment));
  }

  // ── 8. AGREEMENT CALCULATION ──

  const directionalSources = sources.filter(s => s.direction && s.direction !== "neutral");
  const agreeing = directionalSources.filter(s => s.direction === spineDirection).length;
  const agreement = directionalSources.length > 0 ? agreeing / directionalSources.length : 0;

  // ── 9. SUMMARY ──

  const summaryParts: string[] = [];
  summaryParts.push(`${verdict.toUpperCase()} (${finalConfidence.toFixed(0)}% conf)`);
  if (shouldBlock) summaryParts.push(`BLOCKED: ${blockReason}`);
  summaryParts.push(`Agreement: ${(agreement * 100).toFixed(0)}% (${agreeing}/${directionalSources.length} sources)`);
  summaryParts.push(`Score adj: ${scoreAdjustment >= 0 ? "+" : ""}${scoreAdjustment.toFixed(2)}`);

  return {
    verdict,
    confidence: Math.round(finalConfidence),
    scoreAdjustment: +scoreAdjustment.toFixed(2),
    shouldBlock,
    blockReason,
    sources,
    agreement: +agreement.toFixed(2),
    summary: summaryParts.join(" | "),
  };
}
