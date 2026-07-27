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
 * - hard: block explicit plan skips and counter-bias signals at the threshold
 */
export function evaluateGamePlanGate(
  gamePlan: SessionGamePlan | null,
  pair: string,
  direction: string,
  mode: GamePlanEnforcementMode,
  hardBlockThreshold: number,
): GamePlanGateResult {
  const gpFilter = filterTradeByGamePlan(gamePlan, pair, direction);
  const pairPlan = gamePlan?.plans?.find((plan) => plan.symbol === pair);
  const biasConfidence = pairPlan?.biasConfidence ?? 0;

  if (gpFilter.allowed) {
    return { passed: true, reason: gpFilter.reason, mode, biasConfidence };
  }

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
      reason: `GP filter (soft): ${gpFilter.reason} — handled by GP Bias Confidence scoring (conf: ${biasConfidence}%)`,
      mode,
      biasConfidence,
    };
  }

  if (pairPlan?.tradeable === false) {
    return {
      passed: false,
      reason: `GP filter (hard block): ${gpFilter.reason} — pair is marked skip by the active Game Plan`,
      mode,
      biasConfidence,
    };
  }

  if (hardBlockThreshold > 0 && biasConfidence >= hardBlockThreshold) {
    return {
      passed: false,
      reason: `GP filter (hard block): ${gpFilter.reason} — bias confidence ${biasConfidence}% >= threshold ${hardBlockThreshold}%`,
      mode,
      biasConfidence,
    };
  }

  return {
    passed: true,
    reason: `GP filter (hard mode, below threshold): ${gpFilter.reason} — soft scoring only (conf: ${biasConfidence}%, threshold: ${hardBlockThreshold}%)`,
    mode,
    biasConfidence,
  };
}
