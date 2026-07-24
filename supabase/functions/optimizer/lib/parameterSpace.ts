/**
 * Parameter Space Definition for the Autonomous Optimizer
 * 
 * Defines all tunable parameters with their types, bounds, and constraints.
 * The optimizer explores this space using TPE to find better configurations.
 * 
 * Design principles:
 * - Every parameter has a bounded range (no unbounded search)
 * - Ranges are centered on RUNTIME_DEFAULTS (±50% for most)
 * - Factor weights can go from 0 (disabled) to 2× default
 * - Boolean toggles are categorical (true/false)
 * - Gate modes are categorical (hard/soft/off)
 */

import { ParameterSpec } from "./tpe.ts";

// ─── Factor Weights (25 parameters) ───

const FACTOR_WEIGHT_DEFAULTS: Record<string, number> = {
  marketStructure: 2.5,
  orderBlock: 2.0,
  fairValueGap: 2.0,
  premiumDiscountFib: 2.0,
  sessionQuality: 1.5,
  judasSwing: 0.75,
  pdPwLevels: 1.0,
  reversalCandle: 1.5,
  liquiditySweep: 1.5,
  displacement: 1.0,
  breakerBlock: 1.0,
  unicornModel: 1.5,
  smtDivergence: 1.0,
  volumeProfile: 0.75,
  amdPhase: 1.0,
  currencyStrength: 1.5,
  dailyBias: 1.0,
  htfPoiAlignment: 2.0,
  htfFibPdLiquidity: 2.5,
  confluenceStack: 1.5,
  pullbackHealth: 0.5,
  gamePlanKeyLevel: 1.0,
  sessionAffinity: 1.5,
};

function buildFactorWeightSpecs(): ParameterSpec[] {
  return Object.entries(FACTOR_WEIGHT_DEFAULTS).map(([name, defaultVal]) => ({
    name: `fw_${name}`,
    type: "continuous" as const,
    low: 0,
    high: defaultVal * 2.5, // Allow up to 2.5× default (or zero to disable)
  }));
}

// ─── Core Strategy Parameters ───

const CORE_STRATEGY_SPECS: ParameterSpec[] = [
  // Score threshold
  { name: "minConfluence", type: "continuous", low: 35, high: 80 },

  // Risk Management
  { name: "riskPerTrade", type: "continuous", low: 0.25, high: 3.0 },
  { name: "maxOpenPositions", type: "integer", low: 1, high: 8 },
  { name: "maxPerSymbol", type: "integer", low: 1, high: 4 },
  { name: "minRiskReward", type: "continuous", low: 1.0, high: 4.0 },
  { name: "portfolioHeat", type: "continuous", low: 3, high: 20 },

  // SL/TP Configuration
  { name: "slATRMultiple", type: "continuous", low: 0.8, high: 3.0 },
  { name: "slBufferPips", type: "continuous", low: 0, high: 8 },
  { name: "tpRatio", type: "continuous", low: 1.2, high: 5.0 },

  // Impulse Zone
  { name: "impulseZonePenalty", type: "continuous", low: 0.5, high: 5.0 },
  { name: "impulseZoneBonus", type: "continuous", low: 0, high: 3.0 },
  { name: "minZoneScore", type: "integer", low: 2, high: 7 },
  { name: "impulseSlCapMultiplier", type: "continuous", low: 2, high: 8 },
  { name: "fibMaxRetracement", type: "continuous", low: 0.5, high: 1.0 },

  // Direction Engine
  { name: "simpleDirectionH4ChochLookback", type: "integer", low: 5, high: 20 },
  { name: "simpleDirectionH1BosLookback", type: "integer", low: 4, high: 16 },
  { name: "confirmedTrendFibFactor", type: "continuous", low: 0.1, high: 0.5 },
  { name: "confirmedTrendSwingLookback", type: "integer", low: 3, high: 10 },

  // Structural Conviction
  { name: "structuralConvictionS2FLong", type: "continuous", low: 0.15, high: 0.60 },
  { name: "structuralConvictionS2FShort", type: "continuous", low: 0.10, high: 0.45 },
  { name: "structuralConvictionOppositeLong", type: "continuous", low: 0.15, high: 0.55 },
  { name: "structuralConvictionOppositeShort", type: "continuous", low: 0.20, high: 0.70 },

  // Regime Scoring
  { name: "regimeScoringStrength", type: "continuous", low: 0.3, high: 2.0 },

  // Regime-Adaptive TP
  { name: "trendingRRMultiplier", type: "continuous", low: 1.0, high: 2.5 },
  { name: "rangingRRMultiplier", type: "continuous", low: 0.4, high: 1.0 },

  // Tier 1 Gate
  { name: "minTier1Factors", type: "integer", low: 1, high: 6 },

  // P1 Tuning
  { name: "obLookbackCandles", type: "integer", low: 20, high: 100 },
  { name: "structureLookback", type: "integer", low: 20, high: 100 },
  { name: "liquidityPoolMinTouches", type: "integer", low: 1, high: 5 },

  // ICT Penalties/Bonuses
  { name: "ictHTFAlignedBonus", type: "continuous", low: 0.5, high: 4.0 },
  { name: "ictHTFMisalignedPenalty", type: "continuous", low: 1.0, high: 6.0 },
  { name: "ictDisplacementMSSPenalty", type: "continuous", low: 0.5, high: 4.0 },
  { name: "ictJudasSwingPenalty", type: "continuous", low: 0.5, high: 3.0 },
  { name: "ictFVGExhaustedPenalty", type: "continuous", low: 0.5, high: 3.0 },
  { name: "ictFVGInvalidatedPenalty", type: "continuous", low: 1.0, high: 6.0 },
  { name: "ictKillZoneOutsidePenalty", type: "continuous", low: 0.3, high: 3.0 },
  { name: "ictKillZonePrimeBonus", type: "continuous", low: 0.5, high: 3.0 },

  // Staging
  { name: "watchThreshold", type: "integer", low: 10, high: 50 },
  { name: "stagingTTLMinutes", type: "integer", low: 60, high: 480 },

  // Correlation Filter
  { name: "maxCorrelatedPositions", type: "integer", low: 1, high: 5 },
  { name: "conflictThresholdRaise", type: "integer", low: 2, high: 8 },
  { name: "conflictBlockAt", type: "integer", low: 4, high: 10 },
];

// ─── Categorical Parameters (gate modes, methods) ───

const CATEGORICAL_SPECS: ParameterSpec[] = [
  { name: "impulseZoneGateMode", type: "categorical", choices: ["hard", "soft", "off"] },
  { name: "ictHTFGateMode", type: "categorical", choices: ["hard", "soft", "off"] },
  { name: "ictDisplacementMSSGateMode", type: "categorical", choices: ["hard", "soft", "off"] },
  { name: "ictJudasSwingGateMode", type: "categorical", choices: ["hard", "soft", "off"] },
  { name: "ictFVGInvalidationGateMode", type: "categorical", choices: ["hard", "soft", "off"] },
  { name: "ictKillZoneGateMode", type: "categorical", choices: ["hard", "soft", "off"] },
  { name: "slMethod", type: "categorical", choices: ["structure", "atr_based", "fixed_pips"] },
  { name: "tpMethod", type: "categorical", choices: ["rr_ratio", "atr_multiple", "next_level"] },
  { name: "positionSizingMethod", type: "categorical", choices: ["percent_risk", "atr_volatility"] },
  { name: "regimeAdaptiveTPEnabled", type: "categorical", choices: [true, false] },
  { name: "cascadeZoneMode", type: "categorical", choices: ["prefer", "only", "off"] },
];

// ─── Full Parameter Space ───

export function getFullParameterSpace(): ParameterSpec[] {
  return [
    ...buildFactorWeightSpecs(),
    ...CORE_STRATEGY_SPECS,
    ...CATEGORICAL_SPECS,
  ];
}

/**
 * Get a reduced parameter space for faster initial optimization.
 * Focuses on the most impactful parameters.
 */
export function getCoreParameterSpace(): ParameterSpec[] {
  const coreNames = new Set([
    // Most impactful factor weights
    "fw_marketStructure", "fw_orderBlock", "fw_fairValueGap",
    "fw_premiumDiscountFib", "fw_liquiditySweep", "fw_displacement",
    "fw_htfPoiAlignment", "fw_htfFibPdLiquidity",
    // Core strategy
    "minConfluence", "riskPerTrade", "minRiskReward", "tpRatio",
    "slATRMultiple", "minZoneScore", "impulseZonePenalty",
    // Key gates
    "impulseZoneGateMode", "regimeAdaptiveTPEnabled",
    "trendingRRMultiplier", "rangingRRMultiplier",
    // Structural
    "structuralConvictionS2FLong", "structuralConvictionS2FShort",
    "minTier1Factors",
  ]);

  return getFullParameterSpace().filter(s => coreNames.has(s.name));
}

/**
 * Convert optimizer params (with fw_ prefix) back to a config object
 * that can be passed to the backtest engine.
 */
export function paramsToConfig(
  params: Record<string, number | string | boolean>,
  baseConfig: Record<string, any>,
): Record<string, any> {
  const config = { ...baseConfig };
  const factorWeights: Record<string, number> = { ...(baseConfig.factorWeights || {}) };

  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith("fw_")) {
      // Factor weight
      const factorName = key.slice(3);
      factorWeights[factorName] = value as number;
    } else {
      // Direct config field
      config[key] = value;
    }
  }

  config.factorWeights = factorWeights;
  return config;
}

/**
 * Extract optimizer params from a config object (inverse of paramsToConfig).
 * Used for warm-starting from an existing config.
 */
export function configToParams(
  config: Record<string, any>,
): Record<string, number | string | boolean> {
  const params: Record<string, number | string | boolean> = {};
  const factorWeights = config.factorWeights || {};

  // Extract factor weights
  for (const [name, defaultVal] of Object.entries(FACTOR_WEIGHT_DEFAULTS)) {
    params[`fw_${name}`] = factorWeights[name] ?? defaultVal;
  }

  // Extract core strategy params
  for (const spec of CORE_STRATEGY_SPECS) {
    if (config[spec.name] !== undefined) {
      params[spec.name] = config[spec.name];
    }
  }

  // Extract categorical params
  for (const spec of CATEGORICAL_SPECS) {
    if (config[spec.name] !== undefined) {
      params[spec.name] = config[spec.name];
    }
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

  // Factor weights should not all be zero
  const fwKeys = Object.keys(params).filter(k => k.startsWith("fw_"));
  const allZero = fwKeys.every(k => (params[k] as number) === 0);
  if (fwKeys.length > 0 && allZero) {
    violations.push("All factor weights are zero — no scoring possible");
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
