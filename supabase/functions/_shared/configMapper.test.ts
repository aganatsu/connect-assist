/**
 * configMapper.test.ts — Shared Config Mapper Regression Tests
 * ─────────────────────────────────────────────────────────────
 * Proves that mapNestedToFlat() correctly resolves nested config_json
 * (as stored by the UI) into the flat runtime config used by both
 * bot-scanner and backtest-engine.
 *
 * Key invariants:
 *   1. null/undefined input → RUNTIME_DEFAULTS
 *   2. Current UI field names map correctly (e.g. confluenceThreshold → minConfluence)
 *   3. Legacy DB field names still work (e.g. minConfluenceScore → minConfluence)
 *   4. Legacy 0-10 values auto-scale to percentage when normalizedScoring=true
 *   5. Session normalization (sydney → offhours, etc.)
 *   6. Active days conversion ({mon:true,...} → [1,2,...])
 *   7. All ICT 2022 fields map through
 *   8. All limit order fields map through
 *   9. All regime-adaptive fields map through
 *  10. All structural conviction fields map through
 *  11. Protection circuit breaker caps maxDrawdown
 *  12. Instrument list priority: enabled[] > allowedInstruments{} > raw.instruments > defaults
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/configMapper.test.ts
 */

import { mapNestedToFlat, RUNTIME_DEFAULTS } from "./configMapper.ts";
import {
  assertEquals,
  assertAlmostEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Test 1: Null/undefined → RUNTIME_DEFAULTS ──────────────────────

Deno.test("mapNestedToFlat: null input returns RUNTIME_DEFAULTS", () => {
  const result = mapNestedToFlat(null);
  assertEquals(result.minConfluence, RUNTIME_DEFAULTS.minConfluence);
  assertEquals(result.htfBiasRequired, RUNTIME_DEFAULTS.htfBiasRequired);
  assertEquals(result.instruments, RUNTIME_DEFAULTS.instruments);
  assertEquals(result.enabledSessions, RUNTIME_DEFAULTS.enabledSessions);
  assertEquals(result.ictHTFEnabled, RUNTIME_DEFAULTS.ictHTFEnabled);
  assertEquals(result.limitOrderEnabled, RUNTIME_DEFAULTS.limitOrderEnabled);
  assertEquals(result.stagingEnabled, RUNTIME_DEFAULTS.stagingEnabled);
  assertEquals(result.regimeAdaptiveTPEnabled, RUNTIME_DEFAULTS.regimeAdaptiveTPEnabled);
});

Deno.test("mapNestedToFlat: undefined input returns RUNTIME_DEFAULTS", () => {
  const result = mapNestedToFlat(undefined);
  assertEquals(result.minConfluence, 55);
  assertEquals(result.impulseZoneGateMode, "hard");
});

Deno.test("mapNestedToFlat: empty object returns RUNTIME_DEFAULTS", () => {
  const result = mapNestedToFlat({});
  assertEquals(result.minConfluence, RUNTIME_DEFAULTS.minConfluence);
  assertEquals(result.enableOB, true);
  assertEquals(result.enableFVG, true);
  assertEquals(result.ictHTFEnabled, true);
});

// ─── Test 2: Current UI field names ─────────────────────────────────

Deno.test("mapNestedToFlat: current UI strategy.confluenceThreshold maps to minConfluence", () => {
  const result = mapNestedToFlat({
    strategy: { confluenceThreshold: 65 },
  });
  assertEquals(result.minConfluence, 65);
});

Deno.test("mapNestedToFlat: current UI risk.maxDailyDrawdown maps to maxDailyLoss", () => {
  const result = mapNestedToFlat({
    risk: { maxDailyDrawdown: 3 },
  });
  assertEquals(result.maxDailyLoss, 3);
});

Deno.test("mapNestedToFlat: current UI risk.maxConcurrentTrades maps to maxOpenPositions", () => {
  const result = mapNestedToFlat({
    risk: { maxConcurrentTrades: 5 },
  });
  assertEquals(result.maxOpenPositions, 5);
});

Deno.test("mapNestedToFlat: current UI exit.stopLossMethod maps to slMethod", () => {
  const result = mapNestedToFlat({
    exit: { stopLossMethod: "atr_based" },
  });
  assertEquals(result.slMethod, "atr_based");
});

Deno.test("mapNestedToFlat: current UI exit.takeProfitMethod maps to tpMethod", () => {
  const result = mapNestedToFlat({
    exit: { takeProfitMethod: "atr_multiple" },
  });
  assertEquals(result.tpMethod, "atr_multiple");
});

Deno.test("mapNestedToFlat: current UI strategy.requireHTFBias maps to htfBiasRequired", () => {
  const result = mapNestedToFlat({
    strategy: { requireHTFBias: false },
  });
  assertEquals(result.htfBiasRequired, false);
});

// ─── Test 3: Legacy DB field names ──────────────────────────────────

Deno.test("mapNestedToFlat: legacy minConfluenceScore maps to minConfluence (with auto-scale)", () => {
  const result = mapNestedToFlat({
    strategy: { minConfluenceScore: 6.5 },
  });
  // 6.5 is in 0-10 range → auto-scaled to 65
  assertEquals(result.minConfluence, 65);
});

Deno.test("mapNestedToFlat: legacy htfBiasRequired at strategy level", () => {
  const result = mapNestedToFlat({
    strategy: { htfBiasRequired: false },
  });
  assertEquals(result.htfBiasRequired, false);
});

Deno.test("mapNestedToFlat: legacy top-level raw.minConfluence (already percentage)", () => {
  const result = mapNestedToFlat({
    minConfluence: 70,
  });
  assertEquals(result.minConfluence, 70);
});

// ─── Test 4: Auto-scaling legacy 0-10 → percentage ─────────────────

Deno.test("mapNestedToFlat: value 5.5 auto-scales to 55 when normalizedScoring=true", () => {
  const result = mapNestedToFlat({
    strategy: { confluenceThreshold: 5.5, normalizedScoring: true },
  });
  assertEquals(result.minConfluence, 55);
});

Deno.test("mapNestedToFlat: value 10 auto-scales to 100 when normalizedScoring=true", () => {
  const result = mapNestedToFlat({
    strategy: { confluenceThreshold: 10 },
  });
  assertEquals(result.minConfluence, 100);
});

Deno.test("mapNestedToFlat: value 55 stays 55 (already percentage, > 10)", () => {
  const result = mapNestedToFlat({
    strategy: { confluenceThreshold: 55 },
  });
  assertEquals(result.minConfluence, 55);
});

Deno.test("mapNestedToFlat: value 0 stays 0 (edge case, no scaling)", () => {
  const result = mapNestedToFlat({
    strategy: { confluenceThreshold: 0 },
  });
  assertEquals(result.minConfluence, 0);
});

// ─── Test 5: Session normalization ──────────────────────────────────

Deno.test("mapNestedToFlat: sessions.filter normalizes sydney to offhours", () => {
  const result = mapNestedToFlat({
    sessions: { filter: ["london", "sydney", "newyork"] },
  });
  assert(result.enabledSessions.includes("offhours"));
  assert(result.enabledSessions.includes("london"));
  assert(result.enabledSessions.includes("newyork"));
  assert(!result.enabledSessions.includes("sydney"));
});

Deno.test("mapNestedToFlat: legacy boolean session config", () => {
  const result = mapNestedToFlat({
    sessions: {
      asianEnabled: true,
      londonEnabled: true,
      newYorkEnabled: false,
      sydneyEnabled: true,
    },
  });
  assert(result.enabledSessions.includes("asian"));
  assert(result.enabledSessions.includes("london"));
  assert(!result.enabledSessions.includes("newyork"));
  assert(result.enabledSessions.includes("offhours")); // sydney → offhours
});

Deno.test("mapNestedToFlat: raw.enabledSessions array (legacy flat config)", () => {
  const result = mapNestedToFlat({
    enabledSessions: ["asian", "london"],
  });
  assertEquals(result.enabledSessions, ["asian", "london"]);
});

// ─── Test 6: Active days conversion ────────────────────────────────

Deno.test("mapNestedToFlat: sessions.activeDays object converts to number array", () => {
  const result = mapNestedToFlat({
    sessions: {
      activeDays: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false },
    },
  });
  assertEquals(result.enabledDays, [1, 2, 3, 4, 5]);
});

Deno.test("mapNestedToFlat: sessions.activeDays with weekend trading", () => {
  const result = mapNestedToFlat({
    sessions: {
      activeDays: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: true, sun: true },
    },
  });
  assertEquals(result.enabledDays, [0, 1, 2, 3, 4, 5, 6]);
});

// ─── Test 7: ICT 2022 fields map through ───────────────────────────

Deno.test("mapNestedToFlat: ICT HTF fields from strategy section", () => {
  const result = mapNestedToFlat({
    strategy: {
      ictHTFEnabled: false,
      ictHTFGateMode: "hard",
      ictHTFAlignedBonus: 3.0,
      ictHTFMisalignedPenalty: 5.0,
      ictHTFMinContainment: 70,
    },
  });
  assertEquals(result.ictHTFEnabled, false);
  assertEquals(result.ictHTFGateMode, "hard");
  assertEquals(result.ictHTFAlignedBonus, 3.0);
  assertEquals(result.ictHTFMisalignedPenalty, 5.0);
  assertEquals(result.ictHTFMinContainment, 70);
});

Deno.test("mapNestedToFlat: ICT Displacement MSS fields", () => {
  const result = mapNestedToFlat({
    strategy: {
      ictDisplacementMSSEnabled: false,
      ictDisplacementMSSGateMode: "soft",
      ictDisplacementMSSMinBodyRatio: 0.7,
      ictDisplacementMSSMinRangeATR: 1.5,
      ictDisplacementMSSLookback: 5,
      ictDisplacementMSSPenalty: 3.0,
    },
  });
  assertEquals(result.ictDisplacementMSSEnabled, false);
  assertEquals(result.ictDisplacementMSSGateMode, "soft");
  assertAlmostEquals(result.ictDisplacementMSSMinBodyRatio, 0.7);
  assertAlmostEquals(result.ictDisplacementMSSMinRangeATR, 1.5);
  assertEquals(result.ictDisplacementMSSLookback, 5);
  assertEquals(result.ictDisplacementMSSPenalty, 3.0);
});

Deno.test("mapNestedToFlat: ICT Judas Swing fields", () => {
  const result = mapNestedToFlat({
    strategy: {
      ictJudasSwingEnabled: false,
      ictJudasSwingGateMode: "hard",
      ictJudasSwingLookback: 15,
      ictJudasSwingMinDepthATR: 0.2,
      ictJudasSwingRequireCloseBack: false,
      ictJudasSwingPenalty: 2.5,
    },
  });
  assertEquals(result.ictJudasSwingEnabled, false);
  assertEquals(result.ictJudasSwingGateMode, "hard");
  assertEquals(result.ictJudasSwingLookback, 15);
  assertAlmostEquals(result.ictJudasSwingMinDepthATR, 0.2);
  assertEquals(result.ictJudasSwingRequireCloseBack, false);
  assertEquals(result.ictJudasSwingPenalty, 2.5);
});

Deno.test("mapNestedToFlat: ICT FVG Invalidation fields", () => {
  const result = mapNestedToFlat({
    strategy: {
      ictFVGInvalidationEnabled: false,
      ictFVGInvalidationGateMode: "soft",
      ictFVGBodyCloseOnly: false,
      ictFVGRuleOfTwo: false,
      ictFVGExhaustedPenalty: 2.0,
      ictFVGInvalidatedPenalty: 4.0,
    },
  });
  assertEquals(result.ictFVGInvalidationEnabled, false);
  assertEquals(result.ictFVGInvalidationGateMode, "soft");
  assertEquals(result.ictFVGBodyCloseOnly, false);
  assertEquals(result.ictFVGRuleOfTwo, false);
  assertEquals(result.ictFVGExhaustedPenalty, 2.0);
  assertEquals(result.ictFVGInvalidatedPenalty, 4.0);
});

Deno.test("mapNestedToFlat: ICT Kill Zone fields", () => {
  const result = mapNestedToFlat({
    strategy: {
      ictKillZoneEnabled: false,
      ictKillZoneGateMode: "hard",
      ictKillZoneSilverBullet: false,
      ictKillZonePMSession: false,
      ictKillZoneOutsidePenalty: 2.0,
      ictKillZonePrimeBonus: 3.0,
    },
  });
  assertEquals(result.ictKillZoneEnabled, false);
  assertEquals(result.ictKillZoneGateMode, "hard");
  assertEquals(result.ictKillZoneSilverBullet, false);
  assertEquals(result.ictKillZonePMSession, false);
  assertEquals(result.ictKillZoneOutsidePenalty, 2.0);
  assertEquals(result.ictKillZonePrimeBonus, 3.0);
});

Deno.test("mapNestedToFlat: ICT Risk Management fields", () => {
  const result = mapNestedToFlat({
    strategy: {
      ictRiskEnabled: false,
      ictRiskBasePercent: 0.02,
      ictRiskDrawdownHalving: false,
      ictRiskMaxConsecLosses: 5,
      ictRiskDailyLimit: 0.02,
      ictRiskWeeklyLimit: 0.05,
      ictRiskMaxTradesPerDay: 5,
      ictRiskFVGRuleOfTwoExit: false,
    },
  });
  assertEquals(result.ictRiskEnabled, false);
  assertAlmostEquals(result.ictRiskBasePercent, 0.02);
  assertEquals(result.ictRiskDrawdownHalving, false);
  assertEquals(result.ictRiskMaxConsecLosses, 5);
  assertAlmostEquals(result.ictRiskDailyLimit, 0.02);
  assertAlmostEquals(result.ictRiskWeeklyLimit, 0.05);
  assertEquals(result.ictRiskMaxTradesPerDay, 5);
  assertEquals(result.ictRiskFVGRuleOfTwoExit, false);
});

// ─── Test 8: Limit order fields ─────────────────────────────────────

Deno.test("mapNestedToFlat: limit order fields from entry section", () => {
  const result = mapNestedToFlat({
    entry: {
      limitOrderEnabled: true,
      limitOrderExpiryMinutes: 120,
      limitOrderMaxDistancePips: 50,
      limitOrderMinDistancePips: 5,
      limitOrderPreferZone: "fvg",
      marketFillAtZone: false,
      marketFillStrictATRMult: 0.5,
    },
  });
  assertEquals(result.limitOrderEnabled, true);
  assertEquals(result.limitOrderExpiryMinutes, 120);
  assertEquals(result.limitOrderMaxDistancePips, 50);
  assertEquals(result.limitOrderMinDistancePips, 5);
  assertEquals(result.limitOrderPreferZone, "fvg");
  assertEquals(result.marketFillAtZone, false);
  assertAlmostEquals(result.marketFillStrictATRMult, 0.5);
});

// ─── Test 9: Regime-adaptive fields ─────────────────────────────────

Deno.test("mapNestedToFlat: regime-adaptive exit fields from strategy section", () => {
  const result = mapNestedToFlat({
    strategy: {
      regimeAdaptiveTPEnabled: true,
      trendingRRMultiplier: 2.0,
      rangingRRMultiplier: 0.5,
      adaptiveTrailingEnabled: true,
      baseTrailATRMultiple: 2.0,
      momentumFadeThreshold: 0.3,
      trailTightenFactor: 0.5,
      trailWidenFactor: 1.5,
    },
  });
  assertEquals(result.regimeAdaptiveTPEnabled, true);
  assertEquals(result.trendingRRMultiplier, 2.0);
  assertAlmostEquals(result.rangingRRMultiplier, 0.5);
  assertEquals(result.adaptiveTrailingEnabled, true);
  assertEquals(result.baseTrailATRMultiple, 2.0);
  assertAlmostEquals(result.momentumFadeThreshold, 0.3);
  assertAlmostEquals(result.trailTightenFactor, 0.5);
  assertEquals(result.trailWidenFactor, 1.5);
});

// ─── Test 10: Structural conviction fields ──────────────────────────

Deno.test("mapNestedToFlat: structural conviction fields from strategy section", () => {
  const result = mapNestedToFlat({
    strategy: {
      structuralConvictionEnabled: true,
      structuralConvictionS2FLong: 0.40,
      structuralConvictionS2FShort: 0.25,
      structuralConvictionOppositeLong: 0.35,
      structuralConvictionOppositeShort: 0.50,
    },
  });
  assertEquals(result.structuralConvictionEnabled, true);
  assertAlmostEquals(result.structuralConvictionS2FLong, 0.40);
  assertAlmostEquals(result.structuralConvictionS2FShort, 0.25);
  assertAlmostEquals(result.structuralConvictionOppositeLong, 0.35);
  assertAlmostEquals(result.structuralConvictionOppositeShort, 0.50);
});

Deno.test("mapNestedToFlat: structuralConvictionEnabled=false disables gate", () => {
  const result = mapNestedToFlat({
    strategy: { structuralConvictionEnabled: false },
  });
  assertEquals(result.structuralConvictionEnabled, false);
});

// ─── Test 11: Protection circuit breaker caps maxDrawdown ───────────

Deno.test("mapNestedToFlat: circuitBreakerPct caps maxDrawdown", () => {
  const result = mapNestedToFlat({
    risk: { maxDrawdown: 20 },
    protection: { circuitBreakerPct: 10 },
  });
  assertEquals(result.maxDrawdown, 10); // min(20, 10) = 10
});

Deno.test("mapNestedToFlat: no circuitBreakerPct uses risk.maxDrawdown", () => {
  const result = mapNestedToFlat({
    risk: { maxDrawdown: 15 },
  });
  assertEquals(result.maxDrawdown, 15);
});

// ─── Test 12: Instrument list priority ──────────────────────────────

Deno.test("mapNestedToFlat: instruments.enabled array takes priority", () => {
  const result = mapNestedToFlat({
    instruments: { enabled: ["EUR/USD", "GBP/USD"] },
  });
  assertEquals(result.instruments, ["EUR/USD", "GBP/USD"]);
});

Deno.test("mapNestedToFlat: allowedInstruments map (legacy) works", () => {
  const result = mapNestedToFlat({
    instruments: {
      allowedInstruments: { "EUR/USD": true, "GBP/USD": false, "USD/JPY": true },
    },
  });
  assertEquals(result.instruments, ["EUR/USD", "USD/JPY"]);
});

Deno.test("mapNestedToFlat: raw.instruments array (flat legacy) works", () => {
  const result = mapNestedToFlat({
    instruments: ["XAU/USD", "BTC/USD"],
  });
  assertEquals(result.instruments, ["XAU/USD", "BTC/USD"]);
});

// ─── Test 13: Full realistic config (UI-shaped) ─────────────────────

Deno.test("mapNestedToFlat: full realistic config from BotConfigModal", () => {
  const fullConfig = {
    strategy: {
      confluenceThreshold: 55,
      requireHTFBias: true,
      htfBiasHardVeto: false,
      useOrderBlocks: true,
      useFVG: true,
      useLiquiditySweep: true,
      useStructureBreak: true,
      useDisplacement: true,
      useBreakerBlocks: true,
      useUnicornModel: true,
      useSilverBullet: true,
      useMacroWindows: true,
      useSMT: true,
      smtOppositeVeto: true,
      useVWAP: true,
      useAMD: true,
      useFOTSI: true,
      impulseZoneEnabled: true,
      impulseZoneGateMode: "hard",
      impulseZonePenalty: 2.0,
      impulseZoneBonus: 1.0,
      impulseSlCapMultiplier: 4,
      useSimpleDirection: true,
      useConfirmedTrend: true,
      structuralConvictionEnabled: true,
      regimeAdaptiveTPEnabled: false,
      stagingEnabled: true,
      watchThreshold: 25,
      ictHTFEnabled: true,
      ictHTFGateMode: "off",
      ictDisplacementMSSEnabled: true,
      ictDisplacementMSSGateMode: "off",
      ictJudasSwingEnabled: true,
      ictJudasSwingGateMode: "off",
      ictFVGInvalidationEnabled: true,
      ictFVGInvalidationGateMode: "off",
      ictKillZoneEnabled: true,
      ictKillZoneGateMode: "off",
      ictRiskEnabled: true,
      normalizedScoring: true,
    },
    risk: {
      riskPerTrade: 1,
      maxDailyDrawdown: 5,
      maxConcurrentTrades: 3,
      minRR: 1.5,
      maxPositionsPerSymbol: 2,
      maxPortfolioHeat: 10,
      maxDrawdown: 20,
    },
    entry: {
      scanIntervalMinutes: 15,
      cooldownMinutes: 0,
      slBufferPips: 2,
      limitOrderEnabled: false,
    },
    exit: {
      stopLossMethod: "structure",
      takeProfitMethod: "rr_ratio",
      trailingStop: false,
      breakEven: true,
      breakEvenTriggerPips: 20,
      partialTP: false,
      maxHoldEnabled: false,
      timeExitHours: 0,
    },
    instruments: {
      enabled: ["EUR/USD", "GBP/USD", "XAU/USD"],
      spreadFilterEnabled: true,
      maxSpreadPips: 0,
    },
    sessions: {
      filter: ["london", "newyork"],
      killZoneOnly: false,
      activeDays: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false },
    },
    protection: {
      maxConsecutiveLosses: 3,
      maxDailyLoss: 500,
      circuitBreakerPct: 15,
    },
    factorWeights: { orderBlock: 1.2, fvg: 1.0 },
  };

  const result = mapNestedToFlat(fullConfig);

  // Strategy
  assertEquals(result.minConfluence, 55);
  assertEquals(result.htfBiasRequired, true);
  assertEquals(result.enableOB, true);
  assertEquals(result.impulseZoneGateMode, "hard");
  assertEquals(result.ictHTFGateMode, "off");
  assertEquals(result.normalizedScoring, true);

  // Risk
  assertEquals(result.riskPerTrade, 1);
  assertEquals(result.maxDailyLoss, 5);
  assertEquals(result.maxOpenPositions, 3);
  assertEquals(result.maxDrawdown, 15); // min(20, circuitBreakerPct=15)

  // Entry/Exit
  assertEquals(result.slMethod, "structure");
  assertEquals(result.tpMethod, "rr_ratio");
  assertEquals(result.breakEvenEnabled, true);
  assertEquals(result.breakEvenPips, 20);
  assertEquals(result.limitOrderEnabled, false);

  // Instruments
  assertEquals(result.instruments, ["EUR/USD", "GBP/USD", "XAU/USD"]);
  assertEquals(result.spreadFilterEnabled, true);

  // Sessions
  assertEquals(result.enabledSessions, ["london", "newyork"]);
  assertEquals(result.enabledDays, [1, 2, 3, 4, 5]);

  // Protection
  assertEquals(result.maxConsecutiveLosses, 3);
  assertEquals(result.protectionMaxDailyLossDollar, 500);

  // Factor weights
  assertEquals(result.factorWeights, { orderBlock: 1.2, fvg: 1.0 });
});

// ─── Test 14: Staging / Watchlist fields ────────────────────────────

Deno.test("mapNestedToFlat: staging fields from strategy section", () => {
  const result = mapNestedToFlat({
    strategy: {
      stagingEnabled: false,
      watchThreshold: 30,
      stagingTTLMinutes: 120,
      minStagingCycles: 2,
    },
  });
  assertEquals(result.stagingEnabled, false);
  assertEquals(result.watchThreshold, 30);
  assertEquals(result.stagingTTLMinutes, 120);
  assertEquals(result.minStagingCycles, 2);
});

// ─── Test 15: Confirmed Trend fields ───────────────────────────────

Deno.test("mapNestedToFlat: confirmed trend fields from strategy section", () => {
  const result = mapNestedToFlat({
    strategy: {
      useConfirmedTrend: false,
      confirmedTrendFibFactor: 0.30,
      confirmedTrendSwingLookback: 7,
    },
  });
  assertEquals(result.useConfirmedTrend, false);
  assertAlmostEquals(result.confirmedTrendFibFactor, 0.30);
  assertEquals(result.confirmedTrendSwingLookback, 7);
});

// ─── Test 16: tpRatio priority chain ────────────────────────────────

Deno.test("mapNestedToFlat: tpRatio from exit.tpRRRatio takes priority", () => {
  const result = mapNestedToFlat({
    exit: { tpRRRatio: 3.0 },
    risk: { defaultRR: 2.5, minRiskReward: 2.0 },
  });
  assertEquals(result.tpRatio, 3.0);
});

Deno.test("mapNestedToFlat: tpRatio falls back to risk.defaultRR", () => {
  const result = mapNestedToFlat({
    risk: { defaultRR: 2.5 },
  });
  assertEquals(result.tpRatio, 2.5);
});

// ─── Test 17: Opening Range nested merge ────────────────────────────

Deno.test("mapNestedToFlat: openingRange merges with defaults", () => {
  const result = mapNestedToFlat({
    openingRange: { enabled: true, candleCount: 12 },
  });
  assertEquals(result.openingRange.enabled, true);
  assertEquals(result.openingRange.candleCount, 12);
  assertEquals(result.openingRange.useBias, true); // default preserved
});

// ─── Test 18: News filter from sessions section ─────────────────────

Deno.test("mapNestedToFlat: news filter from sessions section", () => {
  const result = mapNestedToFlat({
    sessions: {
      newsFilterEnabled: false,
      newsFilterPauseMinutes: 60,
    },
  });
  assertEquals(result.newsFilterEnabled, false);
  assertEquals(result.newsFilterPauseMinutes, 60);
});

// ─── Test 19: ATR filter from instruments section ───────────────────

Deno.test("mapNestedToFlat: ATR volatility filter from instruments section", () => {
  const result = mapNestedToFlat({
    instruments: {
      volatilityFilterEnabled: true,
      minATR: 5,
      maxATR: 50,
    },
  });
  assertEquals(result.atrFilterEnabled, true);
  assertEquals(result.atrFilterMin, 5);
  assertEquals(result.atrFilterMax, 50);
});

// ─── Test 20: Per-instrument SL buffer overrides ────────────────────

Deno.test("mapNestedToFlat: instrumentBuffers from entry section", () => {
  const result = mapNestedToFlat({
    entry: {
      instrumentBuffers: { "XAU/USD": { slBufferPips: 10 } },
    },
  });
  assertEquals(result.instrumentBuffers, { "XAU/USD": { slBufferPips: 10 } });
});

Deno.test("mapNestedToFlat: instrumentBuffers from top-level raw", () => {
  const result = mapNestedToFlat({
    instrumentBuffers: { "BTC/USD": { slBufferPips: 50 } },
  });
  assertEquals(result.instrumentBuffers, { "BTC/USD": { slBufferPips: 50 } });
});
