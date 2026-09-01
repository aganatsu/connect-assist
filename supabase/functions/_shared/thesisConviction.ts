/**
 * thesisConviction.ts — Thesis Conviction Tracker
 * ═══════════════════════════════════════════════════════════════════
 *
 * Tracks how much real-time evidence supports or opposes an active trade thesis
 * across scan cycles. Outputs a conviction score (0-100) that determines whether
 * the impulse-zone credit should be granted.
 *
 * PROBLEM SOLVED:
 *   The scanner takes a snapshot each cycle and evaluates zones independently.
 *   It cannot see that evidence has been ACCUMULATING against a thesis over time.
 *   Example: XAU short thesis created at 09:00 when daily bias = bearish.
 *   By 11:50, 4H regime flipped bullish, entry-TF trend flipped bullish,
 *   all HTF POIs are counter-directional — but the zone still exists and
 *   impulse credit fires. Result: 2 SL hits.
 *
 * SOLUTION:
 *   Each scan cycle, we sample 6 evidence sources that are ALREADY COMPUTED.
 *   We track whether each source supports or opposes the thesis direction.
 *   Conviction starts at 100 and decays as counter-evidence accumulates.
 *   When conviction drops below a threshold, impulse-zone credit is revoked.
 *
 * EVIDENCE SOURCES (zero additional API cost — all pre-computed):
 *   1. Direction Verdict agreement (0-1) — how many direction sources agree
 *   2. Regime 4H bias — does the 4H regime support the thesis direction?
 *   3. Opposing factor count — how many scored factors oppose the trade?
 *   4. Direction Verdict confidence — overall confidence in the direction
 *   5. FOTSI alignment — does currency strength support the thesis?
 *   6. Game Plan bias — does the session bias still agree?
 *
 * OUTPUT:
 *   - convictionScore: 0-100
 *   - impulseCredit: "granted" | "revoked" | "reduced"
 *   - decayHistory: compact array of per-cycle snapshots
 *   - summary: human-readable explanation
 *
 * INTEGRATION:
 *   Shadow mode: logs conviction score alongside trade decisions.
 *   Active mode: gates impulse-zone credit based on conviction threshold.
 *
 * PERSISTENCE:
 *   Uses kv_cache table (same pattern as FOTSI cache).
 *   Key: `thesis_conviction:${userId}:${botId}:${symbol}:${direction}`
 *   TTL: 8 hours (thesis dies with the session)
 */

import type { DirectionVerdictResult } from "./directionVerdict.ts";

// ─── Types ───────────────────────────────────────────────────────────

export type ThesisDirection = "long" | "short";

export type ImpulseCreditDecision = "granted" | "revoked" | "reduced";

/** A single evidence snapshot taken during one scan cycle */
export interface EvidenceSnapshot {
  /** Unix ms timestamp of this snapshot */
  ts: number;
  /** Direction verdict agreement (0-1, higher = more sources agree) */
  verdictAgreement: number;
  /** Direction verdict confidence (0-100) */
  verdictConfidence: number;
  /** Whether 4H regime bias supports thesis direction */
  regime4HAligned: boolean;
  /** Number of opposing factors from confluence scoring */
  opposingCount: number;
  /** Whether FOTSI supports the thesis direction (null if unavailable) */
  fotsiAligned: boolean | null;
  /** Whether game plan bias supports the thesis direction (null if unavailable) */
  gamePlanAligned: boolean | null;
  /** Computed conviction for this cycle (0-100) */
  cycleConviction: number;
}

/** The full conviction state for one thesis (pair + direction) */
export interface ThesisConvictionState {
  symbol: string;
  direction: ThesisDirection;
  /** When the thesis was first tracked */
  createdAt: number;
  /** Latest conviction score (0-100) */
  conviction: number;
  /** History of evidence snapshots (capped at maxHistory) */
  history: EvidenceSnapshot[];
  /** How many consecutive cycles had declining conviction */
  consecutiveDeclines: number;
  /** Peak conviction ever reached */
  peakConviction: number;
}

/** Result returned to the caller (bot-scanner) */
export interface ConvictionResult {
  /** Current conviction score (0-100) */
  conviction: number;
  /** Whether impulse-zone credit should be granted */
  impulseCreditDecision: ImpulseCreditDecision;
  /** Human-readable summary */
  summary: string;
  /** How many cycles of evidence we have */
  cycleCount: number;
  /** How many consecutive cycles conviction has declined */
  consecutiveDeclines: number;
  /** Whether the thesis is "dying" (conviction trending down) */
  thesisDegrading: boolean;
  /** Score adjustment to apply (negative when conviction is low) */
  scoreAdjustment: number;
}

/** Input data from the current scan cycle (all pre-computed, zero cost) */
export interface ConvictionInput {
  symbol: string;
  direction: ThesisDirection;
  /** Direction verdict result (from computeDirectionVerdict) */
  directionVerdict: DirectionVerdictResult | null;
  /** 4H regime info */
  regime4H: {
    regime: string;
    confidence: number;
    bias: string; // "bullish" | "bearish" | "neutral"
  } | null;
  /** Opposing factor count from tieredScoring */
  opposingFactorCount: number;
  /** FOTSI alignment for this pair */
  fotsiAlignment: {
    label: string; // "strong_aligned" | "aligned" | "neutral" | "opposing" | "strong_opposing"
    score: number;
  } | null;
  /** Game plan bias for this pair */
  gamePlanBias: {
    bias: "bullish" | "bearish" | "neutral";
    confidence: number;
  } | null;
}

// ─── Configuration ───────────────────────────────────────────────────

export interface ConvictionConfig {
  /** Conviction below which impulse credit is REVOKED (default: 40) */
  revokeThreshold: number;
  /** Conviction below which impulse credit is REDUCED (score +5% threshold) (default: 60) */
  reduceThreshold: number;
  /** How much each opposing evidence source decays conviction per cycle (default: 8) */
  decayPerOpposingSource: number;
  /** How much each supporting evidence source recovers conviction per cycle (default: 3) */
  recoveryPerAlignedSource: number;
  /** Minimum cycles of data before conviction can revoke credit (default: 2) */
  minCyclesForRevoke: number;
  /** Maximum history snapshots to keep (default: 12) */
  maxHistory: number;
  /** Extra decay when consecutive declines exceed this count (default: 3) */
  acceleratedDecayAfter: number;
  /** Multiplier for accelerated decay (default: 1.5) */
  acceleratedDecayMultiplier: number;
  /** Score penalty when conviction is in "reduced" zone (default: 5) */
  reducedScorePenalty: number;
  /** Score penalty when conviction is in "revoked" zone (default: 10) */
  revokedScorePenalty: number;
}

export const DEFAULT_CONVICTION_CONFIG: ConvictionConfig = {
  revokeThreshold: 40,
  reduceThreshold: 60,
  decayPerOpposingSource: 8,
  recoveryPerAlignedSource: 3,
  minCyclesForRevoke: 2,
  maxHistory: 12,
  acceleratedDecayAfter: 3,
  acceleratedDecayMultiplier: 1.5,
  reducedScorePenalty: 5,
  revokedScorePenalty: 10,
};

// ─── Core Logic ──────────────────────────────────────────────────────

/**
 * Evaluate a single evidence snapshot from the current cycle.
 * Returns the cycle-level conviction delta (positive = supporting, negative = opposing).
 */
export function evaluateEvidence(
  input: ConvictionInput,
  config: ConvictionConfig = DEFAULT_CONVICTION_CONFIG,
): { snapshot: EvidenceSnapshot; delta: number; details: string[] } {
  const details: string[] = [];
  let supportingCount = 0;
  let opposingCount = 0;

  // 1. Direction Verdict Agreement
  const verdictAgreement = input.directionVerdict?.agreement ?? 0.5;
  const verdictConfidence = input.directionVerdict?.confidence ?? 50;
  if (verdictAgreement >= 0.7) {
    supportingCount++;
    details.push(`Verdict agreement ${(verdictAgreement * 100).toFixed(0)}% — supporting`);
  } else if (verdictAgreement < 0.4) {
    opposingCount++;
    details.push(`Verdict agreement ${(verdictAgreement * 100).toFixed(0)}% — opposing (sources disagree)`);
  }

  // 2. Direction Verdict Confidence
  if (verdictConfidence >= 60) {
    // Check if verdict direction matches thesis
    const verdictDir = input.directionVerdict?.verdict;
    if (verdictDir === input.direction) {
      supportingCount++;
      details.push(`Verdict confidence ${verdictConfidence}% for ${verdictDir} — supporting`);
    } else if (verdictDir && verdictDir !== "neutral" && verdictDir !== input.direction) {
      opposingCount++;
      details.push(`Verdict confidence ${verdictConfidence}% for ${verdictDir} — OPPOSING thesis (${input.direction})`);
    }
  }

  // 3. Regime 4H Alignment
  let regime4HAligned = true; // default: neutral = not opposing
  if (input.regime4H && input.regime4H.confidence > 0.5) {
    const regimeBias = input.regime4H.bias;
    const thesisBullish = input.direction === "long";
    if (regimeBias === "bullish" && !thesisBullish) {
      regime4HAligned = false;
      opposingCount++;
      details.push(`4H regime bullish (conf ${(input.regime4H.confidence * 100).toFixed(0)}%) — OPPOSING short thesis`);
    } else if (regimeBias === "bearish" && thesisBullish) {
      regime4HAligned = false;
      opposingCount++;
      details.push(`4H regime bearish (conf ${(input.regime4H.confidence * 100).toFixed(0)}%) — OPPOSING long thesis`);
    } else if ((regimeBias === "bullish" && thesisBullish) || (regimeBias === "bearish" && !thesisBullish)) {
      supportingCount++;
      details.push(`4H regime ${regimeBias} — supporting ${input.direction} thesis`);
    }
  }

  // 4. Opposing Factor Count
  if (input.opposingFactorCount >= 3) {
    opposingCount++;
    details.push(`${input.opposingFactorCount} opposing factors — significant counter-evidence`);
  } else if (input.opposingFactorCount >= 2) {
    // Mild opposing — counts as 0.5
    opposingCount += 0.5;
    details.push(`${input.opposingFactorCount} opposing factors — mild counter-evidence`);
  } else if (input.opposingFactorCount === 0) {
    supportingCount++;
    details.push(`0 opposing factors — clean signal`);
  }

  // 5. FOTSI Alignment
  let fotsiAligned: boolean | null = null;
  if (input.fotsiAlignment) {
    const label = input.fotsiAlignment.label;
    if (label === "strong_aligned" || label === "aligned") {
      fotsiAligned = true;
      supportingCount++;
      details.push(`FOTSI ${label} — currency strength supports thesis`);
    } else if (label === "opposing" || label === "strong_opposing") {
      fotsiAligned = false;
      opposingCount++;
      details.push(`FOTSI ${label} — currency strength OPPOSES thesis`);
    }
  }

  // 6. Game Plan Bias
  let gamePlanAligned: boolean | null = null;
  if (input.gamePlanBias && input.gamePlanBias.bias !== "neutral" && input.gamePlanBias.confidence >= 50) {
    const gpBullish = input.gamePlanBias.bias === "bullish";
    const thesisBullish = input.direction === "long";
    if (gpBullish === thesisBullish) {
      gamePlanAligned = true;
      supportingCount++;
      details.push(`Game plan ${input.gamePlanBias.bias} (${input.gamePlanBias.confidence}%) — aligned with thesis`);
    } else {
      gamePlanAligned = false;
      opposingCount++;
      details.push(`Game plan ${input.gamePlanBias.bias} (${input.gamePlanBias.confidence}%) — OPPOSES thesis`);
    }
  }

  // Compute delta
  const decay = opposingCount * config.decayPerOpposingSource;
  const recovery = supportingCount * config.recoveryPerAlignedSource;
  const delta = recovery - decay;

  // Compute cycle conviction (independent of history — just this cycle's evidence)
  // Scale: 6 sources max, each either +1 or -1. Map to 0-100.
  const totalSources = supportingCount + opposingCount;
  const netAlignment = totalSources > 0 ? (supportingCount - opposingCount) / totalSources : 0;
  const cycleConviction = Math.round(50 + netAlignment * 50); // 0-100, 50 = neutral

  const snapshot: EvidenceSnapshot = {
    ts: Date.now(),
    verdictAgreement,
    verdictConfidence,
    regime4HAligned,
    opposingCount: input.opposingFactorCount,
    fotsiAligned,
    gamePlanAligned,
    cycleConviction,
  };

  return { snapshot, delta, details };
}

/**
 * Update the conviction state with a new evidence snapshot.
 * Returns the updated state and the conviction result.
 */
export function updateConviction(
  state: ThesisConvictionState | null,
  input: ConvictionInput,
  config: ConvictionConfig = DEFAULT_CONVICTION_CONFIG,
): { state: ThesisConvictionState; result: ConvictionResult } {
  const { snapshot, delta, details } = evaluateEvidence(input, config);

  // Initialize state if first cycle
  if (!state) {
    state = {
      symbol: input.symbol,
      direction: input.direction,
      createdAt: Date.now(),
      conviction: 100, // Start at full conviction
      history: [],
      consecutiveDeclines: 0,
      peakConviction: 100,
    };
  }

  // Apply delta to conviction
  let newConviction = state.conviction + delta;

  // Accelerated decay if consecutive declines exceed threshold
  if (delta < 0 && state.consecutiveDeclines >= config.acceleratedDecayAfter) {
    const extraDecay = Math.abs(delta) * (config.acceleratedDecayMultiplier - 1);
    newConviction -= extraDecay;
    details.push(`Accelerated decay: ${state.consecutiveDeclines} consecutive declines → extra -${extraDecay.toFixed(1)}`);
  }

  // Clamp to 0-100
  newConviction = Math.max(0, Math.min(100, newConviction));

  // Track consecutive declines
  const consecutiveDeclines = delta < 0
    ? state.consecutiveDeclines + 1
    : delta > 0 ? 0 : state.consecutiveDeclines;

  // Update peak
  const peakConviction = Math.max(state.peakConviction, newConviction);

  // Add snapshot to history (capped)
  const history = [...state.history, snapshot].slice(-config.maxHistory);

  // Build updated state
  const updatedState: ThesisConvictionState = {
    symbol: input.symbol,
    direction: input.direction,
    createdAt: state.createdAt,
    conviction: Math.round(newConviction * 10) / 10,
    history,
    consecutiveDeclines,
    peakConviction,
  };

  // Determine impulse credit decision
  let impulseCreditDecision: ImpulseCreditDecision = "granted";
  let scoreAdjustment = 0;

  if (history.length >= config.minCyclesForRevoke) {
    if (newConviction <= config.revokeThreshold) {
      impulseCreditDecision = "revoked";
      scoreAdjustment = -config.revokedScorePenalty;
    } else if (newConviction <= config.reduceThreshold) {
      impulseCreditDecision = "reduced";
      scoreAdjustment = -config.reducedScorePenalty;
    }
  }

  // Detect degrading thesis (conviction trending down over last 3+ cycles)
  const thesisDegrading = consecutiveDeclines >= 3
    || (history.length >= 3 && newConviction < peakConviction * 0.6);

  // Build summary
  const decisionEmoji = impulseCreditDecision === "granted" ? "✅"
    : impulseCreditDecision === "reduced" ? "⚠️" : "🚫";
  const summary = `${decisionEmoji} Conviction ${newConviction.toFixed(0)}% (${impulseCreditDecision}) | `
    + `Δ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} | `
    + `${history.length} cycles | `
    + `${consecutiveDeclines > 0 ? `${consecutiveDeclines} consecutive declines | ` : ""}`
    + details.slice(0, 3).join("; ");

  const result: ConvictionResult = {
    conviction: updatedState.conviction,
    impulseCreditDecision,
    summary,
    cycleCount: history.length,
    consecutiveDeclines,
    thesisDegrading,
    scoreAdjustment,
  };

  return { state: updatedState, result };
}

// ─── Persistence Helpers (kv_cache pattern) ──────────────────────────

const CONVICTION_KEY_PREFIX = "thesis_conviction";
const CONVICTION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

/** Build the kv_cache key for a thesis */
export function buildConvictionKey(
  userId: string,
  botId: string,
  symbol: string,
  direction: ThesisDirection,
): string {
  return `${CONVICTION_KEY_PREFIX}:${userId}:${botId}:${symbol}:${direction}`;
}

/**
 * Load conviction state from kv_cache.
 * Returns null on cache miss, expiry, or error (fail-open).
 */
export async function loadConvictionState(
  supabase: any,
  userId: string,
  botId: string,
  symbol: string,
  direction: ThesisDirection,
): Promise<ThesisConvictionState | null> {
  try {
    const key = buildConvictionKey(userId, botId, symbol, direction);
    const { data, error } = await supabase
      .from("kv_cache")
      .select("value, expires_at")
      .eq("key", key)
      .single();

    if (error || !data) return null;

    const now = Date.now();
    const expiresAt = new Date(data.expires_at).getTime();
    if (now >= expiresAt) return null;

    return JSON.parse(data.value) as ThesisConvictionState;
  } catch {
    return null; // Fail-open
  }
}

/**
 * Save conviction state to kv_cache with TTL.
 * Non-critical — failure doesn't block the scan.
 */
export async function saveConvictionState(
  supabase: any,
  userId: string,
  botId: string,
  state: ThesisConvictionState,
): Promise<void> {
  try {
    const key = buildConvictionKey(userId, botId, state.symbol, state.direction);
    const now = Date.now();
    const expiresAt = now + CONVICTION_TTL_MS;

    await supabase
      .from("kv_cache")
      .upsert({
        key,
        value: JSON.stringify(state),
        expires_at: new Date(expiresAt).toISOString(),
        updated_at: new Date(now).toISOString(),
      }, { onConflict: "key" });
  } catch {
    // Non-critical — next cycle will start fresh
  }
}

/**
 * Clear conviction state (call when thesis is invalidated or trade is opened).
 */
export async function clearConvictionState(
  supabase: any,
  userId: string,
  botId: string,
  symbol: string,
  direction: ThesisDirection,
): Promise<void> {
  try {
    const key = buildConvictionKey(userId, botId, symbol, direction);
    await supabase.from("kv_cache").delete().eq("key", key);
  } catch {
    // Non-critical
  }
}
