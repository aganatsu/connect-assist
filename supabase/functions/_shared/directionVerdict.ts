/**
 * directionVerdict.ts — Single Source of Truth for Trade Direction
 * ═══════════════════════════════════════════════════════════════════
 *
 * Consolidates 6 competing direction sources into ONE verdict:
 *
 *   SPINE (determines direction):
 *     1. simpleDirection — bias TF → structure retrace without CHoCH against →
 *        confirmation TF BOS in the bias direction. The only source that can
 *        tell a retracement from a reversal, and the only one that is
 *        style-aware. Its timeframes come from STYLE_TF_LABELS.
 *
 *   CONTEXT (modifies confidence, never flips direction):
 *     2. confirmedTrend (fib-filtered MSBs on the style's bias TF)
 *     3. Regime Classification (trending/ranging/volatile)
 *     4. Weekly Bias (ICT HTF weekly candle structure)
 *
 *   ADVISORY (score modifier only):
 *     5. Game Plan Bias (LLM-generated premarket analysis)
 *
 * confirmedTrend was a second spine until 2026-09-02 and could flip the
 * direction simpleDirection had derived. It is also already used INSIDE
 * simpleDirection as its bias step, so as a separate spine it re-voted against
 * a conclusion it had helped produce. It is context now.
 *
 * Output: { verdict, confidence, sources, scoreAdjustment }
 *   - verdict: "long" | "short" | "neutral"
 *   - confidence: 0-100 (used for size scaling + gate threshold)
 *   - sources: which inputs agreed/disagreed
 *   - scoreAdjustment: net score modifier to apply to confluence
 *
 * NO LONGER ADDITIVE. This header described a shadow-mode rollout that has
 * since completed: the verdict is Gate 1 (bot-scanner, "Direction OK" /
 * "Direction CONFLICT"), it supplies scoreAdjustment to the effective score,
 * and it subsumes the regime gate. A stale claim that it "does NOT modify
 * existing gates" was left here through that transition.
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
    /** Which timeframe set the bias. Style-dependent: "1h" for scalper,
     *  "daily" for day_trader, "weekly" for swing. Was typed
     *  `"daily" | "4h" | null` — day_trader values only — which forced
     *  bot-scanner to cast a scalper's "1h" through it. */
    biasSource: string | null;
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
// DESCRIPTIVE ONLY — nothing multiplies by these. No arithmetic in this module
// reads `.weight`; they are attached to each DirectionSource for logging and
// for the UI breakdown. Direction is decided by the SPINE precedence below, and
// confidence by the explicit +/- adjustments, not by any weighted sum.
//
// They are kept because they describe the intended influence of each source and
// are surfaced in scan detail, but do not reason about this module by reading
// them — an earlier analysis concluded confirmedTrend "outvoted" simpleDirection
// 0.40 to 0.25 when in fact it won by claiming the spine first.
//
// simpleDirection is the spine: it is the only source that distinguishes a
// retracement from a reversal. The rest are context.

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

  // ── 1. SPINE: simpleDirection owns the direction ──
  //
  // simpleDirection is the only source that can tell a retracement from a
  // reversal. It is a conjunction, not an opinion: the bias timeframe sets a
  // direction, the structure timeframe must be pulling back WITHOUT a CHoCH
  // against that bias, and the confirmation timeframe must actually break in
  // the bias direction. That sequence is what separates "this dip is an entry"
  // from "this dip is the new trend".
  //
  // confirmedTrend, regime, weeklyBias and gamePlan cannot make that
  // distinction — they report a trend and stop. Previously confirmedTrend
  // claimed the spine first and simpleDirection could only nudge confidence,
  // so the source that had done the reasoning was overruled by sources that
  // had not. Measured 2026-09-02: 255 of 320 evaluations (80%) had the verdict
  // opposing the entry direction, and the entry direction IS simpleDirection —
  // bot-scanner sets _overrideDirection from it and confluenceScoring honours
  // it. Every one of those was the verdict overruling its own structural read.
  //
  // Note also that simpleDirection ALREADY calls confirmedTrend internally as
  // its bias step (directionEngine, step 1). Treating confirmedTrend as a
  // second spine let the same signal vote twice against a conclusion it had
  // already contributed to.
  //
  // This matches what this module's own header says context sources should do:
  // "modifies confidence, never flips direction". confirmedTrend was classed as
  // spine and flipped things constantly.

  let spineDirection: "bullish" | "bearish" | null = null;
  let spineConfidence = 0;

  // 1a. Simple Direction — the spine.
  if (input.simpleDirection && input.simpleDirection.direction) {
    const dir = input.simpleDirection.bias ?? (input.simpleDirection.direction === "long" ? "bullish" : "bearish");
    let conf = 50; // Base confidence for simple direction
    if (input.simpleDirection.h1Confirmed) conf += 15;
    if (input.simpleDirection.h4Retrace) conf += 10;
    if (input.simpleDirection.h4ChochAgainst) conf -= 30; // Strong negative signal

    spineDirection = dir;
    spineConfidence = Math.max(0, Math.min(100, conf));

    sources.push({
      name: "simpleDirection",
      direction: dir,
      confidence: spineConfidence,
      weight: WEIGHTS.simpleDirection,
      detail: input.simpleDirection.reason,
    });
  } else {
    sources.push({
      name: "simpleDirection",
      direction: null,
      confidence: 0,
      weight: WEIGHTS.simpleDirection,
      detail: input.simpleDirection?.reason ?? "No data",
    });
  }

  // 1b. Confirmed Trend — context. Adjusts confidence, never flips direction.
  if (input.confirmedTrend && input.confirmedTrend.trend !== "ranging") {
    const dir = input.confirmedTrend.trend; // "bullish" | "bearish"
    sources.push({
      name: "confirmedTrend",
      direction: dir,
      confidence: 80,
      weight: WEIGHTS.confirmedTrend,
      detail: input.confirmedTrend.reason,
    });

    if (!spineDirection) {
      // No structural read available at all. Fall back to the trend rather than
      // returning neutral — a trend-only signal is weaker but not nothing, and
      // the entry has no direction in this case either, so nothing can conflict.
      spineDirection = dir;
      spineConfidence = 80;
    } else if (spineDirection === dir) {
      spineConfidence = Math.min(100, spineConfidence + 15);
    } else {
      // The trend disagrees with the structural read. Reduce conviction; if it
      // falls below minConfidence the verdict goes neutral, which is the honest
      // answer — not a silent flip to the trend's side.
      spineConfidence = Math.max(20, spineConfidence - 20);
    }
  } else {
    sources.push({
      name: "confirmedTrend",
      direction: input.confirmedTrend?.trend === "ranging" ? "neutral" : null,
      confidence: 0,
      weight: WEIGHTS.confirmedTrend,
      detail: input.confirmedTrend?.reason ?? "No data",
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
