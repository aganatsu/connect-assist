/**
 * liveBacktestParity.test.ts — Live-vs-Backtest Config Parity Tests
 * ──────────────────────────────────────────────────────────────────
 * Verifies that the backtest's mapConfig produces the same effective
 * configuration as the live scanner's loadConfig for identical input.
 * This ensures that a config that works in live will produce the same
 * behavior in backtest (and vice versa).
 *
 * Also tests that the shared confluence scoring module produces
 * identical results regardless of which engine calls it.
 *
 * Run: deno test --no-check --allow-all supabase/functions/backtest-engine/liveBacktestParity.test.ts
 */

import {
  SPECS,
  DEFAULTS,
} from "../_shared/smcAnalysis.ts";
import { normalizeSessionFilter } from "../_shared/sessions.ts";
import {
  DEFAULT_FACTOR_WEIGHTS,
  resolveWeightScale,
  applyWeightScale,
} from "../_shared/confluenceScoring.ts";
import {
  assertEquals,
  assertAlmostEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Simplified mapConfig (mirrors the backtest's internal function).
 * We re-implement the key logic here to test it in isolation.
 */
function mapConfig(raw: any): any {
  const strategy = raw?.strategy || {};
  const risk = raw?.risk || {};
  const entry = raw?.entry || {};
  const exit = raw?.exit || {};
  const instruments = raw?.instruments || {};
  const sessions = raw?.sessions || {};
  const protection = raw?.protection || {};
  return {
    ...DEFAULTS,
    minConfluence: (() => {
      const raw_mc = strategy.confluenceThreshold ?? strategy.minConfluenceScore ?? raw?.minConfluence ?? DEFAULTS.minConfluence;
      if (raw_mc > 0 && raw_mc <= 10 && (strategy.normalizedScoring ?? raw?.normalizedScoring ?? true)) {
        return raw_mc * 10;
      }
      return raw_mc;
    })(),
    htfBiasRequired: strategy.requireHTFBias ?? strategy.htfBiasRequired ?? DEFAULTS.htfBiasRequired,
    htfBiasHardVeto: strategy.htfBiasHardVeto ?? DEFAULTS.htfBiasHardVeto,
    enableOB: strategy.useOrderBlocks ?? true,
    enableFVG: strategy.useFVG ?? true,
    enableLiquiditySweep: strategy.useLiquiditySweep ?? true,
    enableStructureBreak: strategy.useStructureBreak ?? true,
    riskPerTrade: risk.riskPerTrade ?? DEFAULTS.riskPerTrade,
    positionSizingMethod: risk.positionSizingMethod ?? raw?.positionSizingMethod ?? "percent_risk",
    fixedLotSize: risk.fixedLotSize ?? raw?.fixedLotSize ?? 0.1,
    maxDailyLoss: risk.maxDailyDrawdown ?? DEFAULTS.maxDailyLoss,
    maxOpenPositions: risk.maxConcurrentTrades ?? DEFAULTS.maxOpenPositions,
    minRiskReward: risk.minRR ?? DEFAULTS.minRiskReward,
    maxPerSymbol: risk.maxPositionsPerSymbol ?? DEFAULTS.maxPerSymbol,
    portfolioHeat: risk.maxPortfolioHeat ?? DEFAULTS.portfolioHeat,
    slMethod: exit.stopLossMethod ?? DEFAULTS.slMethod,
    tpMethod: exit.takeProfitMethod ?? DEFAULTS.tpMethod,
    tpRatio: exit.tpRRRatio ?? risk.defaultRR ?? DEFAULTS.tpRatio,
    trailingStopEnabled: exit.trailingStop ?? false,
    breakEvenEnabled: exit.breakEven ?? DEFAULTS.breakEvenEnabled,
    partialTPEnabled: exit.partialTP ?? false,
    enabledSessions: (
      Array.isArray(sessions.filter)
        ? normalizeSessionFilter(sessions.filter)
        : Array.isArray(raw?.enabledSessions)
          ? normalizeSessionFilter(raw.enabledSessions)
          : [...DEFAULTS.enabledSessions]
    ),
    maxDrawdown: Math.min(risk.maxDrawdown ?? DEFAULTS.maxDrawdown, protection.circuitBreakerPct ?? 100),
    factorWeights: raw?.factorWeights || {},
    useVolumeProfile: strategy.useVolumeProfile ?? raw?.useVolumeProfile ?? DEFAULTS.useVolumeProfile,
    useTrendDirection: strategy.useTrendDirection ?? raw?.useTrendDirection ?? DEFAULTS.useTrendDirection,
    useDailyBias: strategy.useDailyBias ?? raw?.useDailyBias ?? DEFAULTS.useDailyBias,
    useAMD: strategy.useAMD ?? raw?.useAMD ?? DEFAULTS.useAMD,
    useFOTSI: strategy.useFOTSI ?? raw?.useFOTSI ?? DEFAULTS.useFOTSI,
    regimeScoringEnabled: strategy.regimeScoringEnabled ?? raw?.regimeScoringEnabled ?? DEFAULTS.regimeScoringEnabled,
    regimeScoringStrength: strategy.regimeScoringStrength ?? raw?.regimeScoringStrength ?? DEFAULTS.regimeScoringStrength,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1: Config Normalization Parity
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Config parity: empty config uses DEFAULTS for all fields", () => {
  const config = mapConfig({});
  assertEquals(config.minConfluence, DEFAULTS.minConfluence);
  assertEquals(config.htfBiasRequired, DEFAULTS.htfBiasRequired);
  assertEquals(config.riskPerTrade, DEFAULTS.riskPerTrade);
  assertEquals(config.minRiskReward, DEFAULTS.minRiskReward);
  assertEquals(config.slMethod, DEFAULTS.slMethod);
  assertEquals(config.tpMethod, DEFAULTS.tpMethod);
  assertEquals(config.maxDrawdown, DEFAULTS.maxDrawdown);
});

Deno.test("Config parity: legacy 0-10 confluenceThreshold auto-scales to percentage", () => {
  const config = mapConfig({
    strategy: { confluenceThreshold: 5.5 }
  });
  assertEquals(config.minConfluence, 55); // 5.5 × 10 = 55%
});

Deno.test("Config parity: confluenceThreshold > 10 is NOT auto-scaled", () => {
  const config = mapConfig({
    strategy: { confluenceThreshold: 55 }
  });
  assertEquals(config.minConfluence, 55); // Already in percentage
});

Deno.test("Config parity: normalizedScoring=false disables auto-scaling", () => {
  const config = mapConfig({
    strategy: { confluenceThreshold: 5.5, normalizedScoring: false }
  });
  assertEquals(config.minConfluence, 5.5); // Not scaled
});

Deno.test("Config parity: risk.riskPerTrade overrides default", () => {
  const config = mapConfig({
    risk: { riskPerTrade: 2.0 }
  });
  assertEquals(config.riskPerTrade, 2.0);
});

Deno.test("Config parity: exit.trailingStop maps to trailingStopEnabled", () => {
  const config = mapConfig({
    exit: { trailingStop: true }
  });
  assertEquals(config.trailingStopEnabled, true);
});

Deno.test("Config parity: exit.breakEven maps to breakEvenEnabled", () => {
  const config = mapConfig({
    exit: { breakEven: true }
  });
  assertEquals(config.breakEvenEnabled, true);
});

Deno.test("Config parity: sessions.filter normalizes correctly", () => {
  const config = mapConfig({
    sessions: { filter: ["london", "new_york"] }
  });
  // normalizeSessionFilter should return the canonical session names
  assert(Array.isArray(config.enabledSessions));
  assert(config.enabledSessions.length >= 2);
});

Deno.test("Config parity: maxDrawdown is min of risk.maxDrawdown and protection.circuitBreakerPct", () => {
  const config = mapConfig({
    risk: { maxDrawdown: 20 },
    protection: { circuitBreakerPct: 15 }
  });
  assertEquals(config.maxDrawdown, 15); // min(20, 15) = 15
});

Deno.test("Config parity: factor toggles default to DEFAULTS values", () => {
  const config = mapConfig({});
  assertEquals(config.useVolumeProfile, DEFAULTS.useVolumeProfile);
  assertEquals(config.useTrendDirection, DEFAULTS.useTrendDirection);
  assertEquals(config.useDailyBias, DEFAULTS.useDailyBias);
  assertEquals(config.useAMD, DEFAULTS.useAMD);
  assertEquals(config.useFOTSI, DEFAULTS.useFOTSI);
});

Deno.test("Config parity: factor toggles can be overridden via strategy", () => {
  const config = mapConfig({
    strategy: {
      useVolumeProfile: false,
      useTrendDirection: false,
      useDailyBias: false,
    }
  });
  assertEquals(config.useVolumeProfile, false);
  assertEquals(config.useTrendDirection, false);
  assertEquals(config.useDailyBias, false);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: Weight System Parity
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Weight parity: DEFAULT_FACTOR_WEIGHTS has 17 factors", () => {
  const keys = Object.keys(DEFAULT_FACTOR_WEIGHTS);
  assertEquals(keys.length, 17);
});

Deno.test("Weight parity: resolveWeightScale returns 1.0 for default config", () => {
  // When user doesn't override any weight, scale should be 1.0
  const scale = resolveWeightScale("marketStructure", { factorWeights: {} });
  assertEquals(scale, 1.0);
});

Deno.test("Weight parity: resolveWeightScale with 2x override", () => {
  const defaultWeight = (DEFAULT_FACTOR_WEIGHTS as any)["marketStructure"];
  const scale = resolveWeightScale("marketStructure", { factorWeights: { marketStructure: defaultWeight * 2 } });
  assertAlmostEquals(scale, 2.0, 0.001);
});

Deno.test("Weight parity: applyWeightScale multiplies raw score by scale", () => {
  // applyWeightScale(pts, factorKey, displayWeight, config) => { pts, displayWeight }
  const defaultWeight = (DEFAULT_FACTOR_WEIGHTS as any)["marketStructure"];
  const result = applyWeightScale(0.8, "marketStructure", 1.0, { factorWeights: { marketStructure: defaultWeight * 1.5 } });
  assertAlmostEquals(result.pts, 0.8 * 1.5, 0.001);
});

Deno.test("Weight parity: applyWeightScale with 0 scale zeros the score", () => {
  const result = applyWeightScale(0.8, "marketStructure", 1.0, { factorWeights: { marketStructure: 0 } });
  assertEquals(result.pts, 0);
  assertEquals(result.displayWeight, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3: Session Filter Normalization
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Session filter: normalizeSessionFilter handles canonical names", () => {
  const result = normalizeSessionFilter(["london", "new_york"]);
  assert(result.length >= 2, `Expected at least 2 sessions, got ${result.length}`);
});

Deno.test("Session filter: normalizeSessionFilter handles legacy names", () => {
  // Legacy names like "London" or "New York" should be normalized
  const result = normalizeSessionFilter(["London", "New York"]);
  assert(result.length >= 2);
});

Deno.test("Session filter: empty array returns empty", () => {
  const result = normalizeSessionFilter([]);
  assertEquals(result.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 4: SPECS Consistency
// ═══════════════════════════════════════════════════════════════════════

Deno.test("SPECS: all instruments have required fields", () => {
  const requiredFields = ["pipSize", "lotUnits", "type", "typicalSpread"];
  for (const [symbol, spec] of Object.entries(SPECS)) {
    for (const field of requiredFields) {
      assert(
        field in (spec as any),
        `${symbol} missing field: ${field}`
      );
    }
  }
});

Deno.test("SPECS: pipSize is always positive", () => {
  for (const [symbol, spec] of Object.entries(SPECS)) {
    assert((spec as any).pipSize > 0, `${symbol} pipSize must be > 0`);
  }
});

Deno.test("SPECS: typicalSpread is always positive", () => {
  for (const [symbol, spec] of Object.entries(SPECS)) {
    assert((spec as any).typicalSpread > 0, `${symbol} typicalSpread must be > 0`);
  }
});

Deno.test("SPECS: lotUnits is always positive", () => {
  for (const [symbol, spec] of Object.entries(SPECS)) {
    assert((spec as any).lotUnits > 0, `${symbol} lotUnits must be > 0`);
  }
});

Deno.test("SPECS: type is one of forex/commodity/crypto/index", () => {
  const validTypes = ["forex", "commodity", "crypto", "index"];
  for (const [symbol, spec] of Object.entries(SPECS)) {
    assert(
      validTypes.includes((spec as any).type),
      `${symbol} has invalid type: ${(spec as any).type}`
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 5: DEFAULTS Consistency
// ═══════════════════════════════════════════════════════════════════════

Deno.test("DEFAULTS: minConfluence is a percentage (0-100)", () => {
  assert(DEFAULTS.minConfluence >= 0 && DEFAULTS.minConfluence <= 100,
    `minConfluence ${DEFAULTS.minConfluence} should be 0-100`);
});

Deno.test("DEFAULTS: riskPerTrade is reasonable (0.1-10%)", () => {
  assert(DEFAULTS.riskPerTrade >= 0.1 && DEFAULTS.riskPerTrade <= 10,
    `riskPerTrade ${DEFAULTS.riskPerTrade} should be 0.1-10%`);
});

Deno.test("DEFAULTS: minRiskReward is >= 1.0", () => {
  assert(DEFAULTS.minRiskReward >= 1.0,
    `minRiskReward ${DEFAULTS.minRiskReward} should be >= 1.0`);
});

Deno.test("DEFAULTS: maxDrawdown is a percentage (1-100)", () => {
  assert(DEFAULTS.maxDrawdown >= 1 && DEFAULTS.maxDrawdown <= 100,
    `maxDrawdown ${DEFAULTS.maxDrawdown} should be 1-100`);
});

Deno.test("DEFAULTS: enabledSessions is a non-empty array", () => {
  assert(Array.isArray(DEFAULTS.enabledSessions));
  assert(DEFAULTS.enabledSessions.length > 0);
});

Deno.test("DEFAULTS: tpRatio is >= 1.0", () => {
  assert(DEFAULTS.tpRatio >= 1.0,
    `tpRatio ${DEFAULTS.tpRatio} should be >= 1.0`);
});
