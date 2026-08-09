/**
 * Parameter Space Definition for Canonical Strategy Research
 * 
 * Defines all tunable parameters with their types, bounds, and constraints.
 * The optimizer explores this space using TPE to find better configurations.
 * 
 * Design principles:
 * - Every parameter has a bounded range (no unbounded search)
 * - Authority modes and legacy diagnostics are never tunable
 * - Candidates overlay one immutable canonical runtime snapshot
 * - The focused space stays small enough for the trial budget
 */

import { ParameterSpec } from "./tpe.ts";

// Canonical research space
//
// Authority modes and legacy diagnostic scores are deliberately excluded. The
// optimizer calibrates detection and trade-management parameters while the
// canonical ICT workflow remains frozen for the whole experiment.

const FACTOR_WEIGHT_DEFAULTS: Record<string, number> = {};

const CORE_STRATEGY_SPECS: ParameterSpec[] = [
  // Detection calibration
  { name: "obLookbackCandles", type: "integer", low: 30, high: 100 },
  { name: "structureLookback", type: "integer", low: 30, high: 100 },
  { name: "liquidityPoolMinTouches", type: "integer", low: 2, high: 4 },
  { name: "simpleDirectionH4ChochLookback", type: "integer", low: 6, high: 16 },
  { name: "simpleDirectionH1BosLookback", type: "integer", low: 5, high: 14 },
  { name: "confirmedTrendSwingLookback", type: "integer", low: 3, high: 8 },

  // Canonical zone calibration (authority mode itself remains frozen)
  { name: "zoneQualityThreshold", type: "continuous", low: 2.5, high: 7 },
  { name: "zoneMaxAgeBars", type: "integer", low: 20, high: 120 },
  { name: "zoneMinBodyRatio", type: "continuous", low: 0.45, high: 0.8 },
  { name: "zoneMinDisplacementATR", type: "continuous", low: 1.0, high: 2.5 },
  { name: "crossTfMinimumParentChildOverlapPercent", type: "continuous", low: 0, high: 40 },
  { name: "crossTfMaximumZoneSeparationATR", type: "continuous", low: 0.5, high: 3 },

  // Risk-normalized trade construction
  { name: "minRiskReward", type: "continuous", low: 1.0, high: 3.0 },
  { name: "slATRMultiple", type: "continuous", low: 0.8, high: 2.5 },
  { name: "slBufferPips", type: "continuous", low: 0, high: 6 },
  { name: "tpRatio", type: "continuous", low: 1.2, high: 4.0 },
];

const CATEGORICAL_SPECS: ParameterSpec[] = [
  { name: "slMethod", type: "categorical", choices: ["structure", "atr_based"] },
  { name: "tpMethod", type: "categorical", choices: ["rr_ratio", "next_level"] },
];

export function getFullParameterSpace(): ParameterSpec[] {
  return [...CORE_STRATEGY_SPECS, ...CATEGORICAL_SPECS];
}

export function getCoreParameterSpace(): ParameterSpec[] {
  const names = new Set([
    "structureLookback", "liquidityPoolMinTouches",
    "zoneQualityThreshold", "zoneMinDisplacementATR",
    "minRiskReward", "slATRMultiple", "slBufferPips", "tpRatio",
  ]);
  return getFullParameterSpace().filter(spec => names.has(spec.name));
}

export function paramsToConfig(
  params: Record<string, number | string | boolean>,
  baseConfig: Record<string, any>,
): Record<string, any> {
  return { ...baseConfig, ...params };
}

export function configToParams(
  config: Record<string, any>,
): Record<string, number | string | boolean> {
  const params: Record<string, number | string | boolean> = {};
  for (const spec of getFullParameterSpace()) {
    if (config[spec.name] !== undefined) params[spec.name] = config[spec.name];
  }
  return params;
}

/**
 * Validate that a parameter set respects all constraints.
 * Returns list of violations (empty = valid).
 */
export function validateParams(
  params: Record<string, number | string | boolean>,
): string[] {
  const violations: string[] = [];

  // minRiskReward must be <= tpRatio (otherwise TP can never be hit)
  const minRR = params.minRiskReward as number;
  const tpRatio = params.tpRatio as number;
  if (minRR !== undefined && tpRatio !== undefined && minRR > tpRatio) {
    violations.push(`minRiskReward (${minRR}) > tpRatio (${tpRatio})`);
  }

  // conflictThresholdRaise must be < conflictBlockAt
  const raise = params.conflictThresholdRaise as number;
  const block = params.conflictBlockAt as number;
  if (raise !== undefined && block !== undefined && raise >= block) {
    violations.push(`conflictThresholdRaise (${raise}) >= conflictBlockAt (${block})`);
  }

  // trendingRRMultiplier should be > rangingRRMultiplier
  const trending = params.trendingRRMultiplier as number;
  const ranging = params.rangingRRMultiplier as number;
  if (trending !== undefined && ranging !== undefined && trending <= ranging) {
    violations.push(`trendingRRMultiplier (${trending}) <= rangingRRMultiplier (${ranging})`);
  }


  return violations;
}

/**
 * Compute the maximum allowed change from a baseline config.
 * Used to enforce the ±50% per-cycle safety rail.
 */
export function enforceMaxDelta(
  candidate: Record<string, number | string | boolean>,
  baseline: Record<string, number | string | boolean>,
  maxDeltaPercent: number = 0.50,
): Record<string, number | string | boolean> {
  const clamped = { ...candidate };

  for (const [key, value] of Object.entries(candidate)) {
    const baseVal = baseline[key];
    if (baseVal === undefined) continue;

    // Only clamp numerical values
    if (typeof value === "number" && typeof baseVal === "number" && baseVal !== 0) {
      const maxChange = Math.abs(baseVal) * maxDeltaPercent;
      const lower = baseVal - maxChange;
      const upper = baseVal + maxChange;
      clamped[key] = Math.max(lower, Math.min(upper, value));
    }
  }

  return clamped;
}

export { FACTOR_WEIGHT_DEFAULTS };
