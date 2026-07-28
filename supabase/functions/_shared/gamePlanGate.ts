import {
  filterTradeByGamePlan,
  type SessionGamePlan,
} from "./gamePlan.ts";

export type GamePlanEnforcementMode = "off" | "soft" | "hard";

export interface GamePlanGateResult {
  passed: boolean;
  reason: string;
  mode: GamePlanEnforcementMode;
  biasConfidence: number;
}

/**
 * Convert a Game Plan verdict into an explicit safety-gate decision.
 *
 * - off: record the verdict but never affect entry
 * - soft: retain the confluence score bonus/penalty but never hard-block here
 * - hard: fail closed unless the plan is tradeable, directional, sufficiently
 *   confident, and aligned with the Direction Verdict's final direction
 */
export function evaluateGamePlanGate(
  gamePlan: SessionGamePlan | null,
  pair: string,
  direction: string,
  mode: GamePlanEnforcementMode,
  minimumConfidence: number,
): GamePlanGateResult {
  const gpFilter = filterTradeByGamePlan(gamePlan, pair, direction);
  const pairPlan = gamePlan?.plans?.find((plan) => plan.symbol === pair);
  const biasConfidence = pairPlan?.biasConfidence ?? 0;

  if (mode === "off") {
    return {
      passed: true,
      reason: `GP filter (off — log only): ${gpFilter.reason}`,
      mode,
      biasConfidence,
    };
  }

  if (mode === "soft") {
    return {
      passed: true,
      reason: gpFilter.allowed
        ? `GP filter (soft): ${gpFilter.reason}`
        : `GP filter (soft): ${gpFilter.reason} — handled by GP Bias Confidence scoring (conf: ${biasConfidence}%)`,
      mode,
      biasConfidence,
    };
  }

  // Hard mode is an authorization gate, not a score adjustment. Without a
  // current per-pair plan there is nothing for the Direction Verdict to align
  // with, so the safe behavior is to wait rather than fall through.
  if (!gamePlan) {
    return {
      passed: false,
      reason: "GP alignment BLOCKED: no active Game Plan is available",
      mode,
      biasConfidence,
    };
  }

  if (!pairPlan) {
    return {
      passed: false,
      reason: `GP alignment BLOCKED: no active plan exists for ${pair}`,
      mode,
      biasConfidence,
    };
  }

  if (pairPlan.tradeable === false || pairPlan.state === "skip") {
    return {
      passed: false,
      reason: `GP alignment BLOCKED: ${gpFilter.reason} — pair is marked skip by the active Game Plan`,
      mode,
      biasConfidence,
    };
  }

  if (pairPlan.state === "wait") {
    return {
      passed: false,
      reason: `GP alignment WAIT: ${pair} is not tradeable yet — ${pairPlan.stateReason || "active Game Plan requires more evidence"}`,
      mode,
      biasConfidence,
    };
  }

  if (["transitional", "ranging", "volatile", "unknown"].includes(pairPlan.regime)) {
    return {
      passed: false,
      reason: `GP alignment WAIT: ${pair} regime is ${pairPlan.regime} — refresh or explicit scenario confirmation is required`,
      mode,
      biasConfidence,
    };
  }

  if (pairPlan.bias === "neutral") {
    return {
      passed: false,
      reason: `GP alignment WAIT: ${pair} Game Plan is neutral — no direction is authorized`,
      mode,
      biasConfidence,
    };
  }

  const authorizedDirection = pairPlan.bias === "bullish" ? "long" : "short";
  if (direction !== authorizedDirection) {
    return {
      passed: false,
      reason: `GP alignment BLOCKED: Game Plan authorizes ${authorizedDirection.toUpperCase()} (${pairPlan.bias} ${biasConfidence}%), Direction Verdict is ${direction.toUpperCase()}`,
      mode,
      biasConfidence,
    };
  }

  if (minimumConfidence > 0 && biasConfidence < minimumConfidence) {
    return {
      passed: false,
      reason: `GP alignment WAIT: directions agree on ${direction.toUpperCase()}, but Game Plan confidence ${biasConfidence}% is below the ${minimumConfidence}% minimum`,
      mode,
      biasConfidence,
    };
  }

  return {
    passed: true,
    reason: `GP alignment PASSED: Game Plan and Direction Verdict agree on ${direction.toUpperCase()} (${biasConfidence}% plan confidence, minimum ${minimumConfidence}%)`,
    mode,
    biasConfidence,
  };
}
