/**
 * _shared/configMapper.ts — SINGLE SOURCE OF TRUTH for bot config mapping
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module defines the canonical mapping from the nested config_json
 * shape (as stored in bot_configs table and written by the UI) to the flat
 * runtime config object consumed by both bot-scanner and backtest-engine.
 *
 * CONSUMERS:
 *   - bot-scanner/index.ts  (loadConfig → DB fetch + mapNestedToFlat)
 *   - backtest-engine/index.ts  (mapConfig → mapNestedToFlat)
 *   - paper-trading/index.ts  (if applicable)
 *
 * ADDING A NEW CONFIG FIELD:
 *   1. Add default value to RUNTIME_DEFAULTS below
 *   2. Add mapping line in mapNestedToFlat()
 *   3. Run: deno test supabase/functions/_shared/configMapper.test.ts
 *   4. Done — both engines pick it up automatically
 *
 * DO NOT duplicate this mapping logic elsewhere. If you find yourself
 * writing `strategy.someField ?? raw.someField ?? DEFAULT` in another
 * file, you're doing it wrong — add it here instead.
 */

import { normalizeSessionFilter } from "./sessions.ts";

// ─── Runtime Defaults ─────────────────────────────────────────────────
// These are the FLAT runtime defaults used by the scanning/backtesting engine.
// They represent the values used when no config is saved or a field is missing.

export const RUNTIME_DEFAULTS = {
  // ── Core Strategy ──
  minConfluence: 55,  // Percentage (0-100) — must match normalizedScoring: true
  htfBiasRequired: true,
  htfBiasHardVeto: false,
  onlyBuyInDiscount: false,
  onlySellInPremium: false,
  normalizedScoring: true,

  // ── Factor Toggles ──
  enableOB: true,
  enableFVG: true,
  enableLiquiditySweep: true,
  enableStructureBreak: true,
  useDisplacement: true,
  useBreakerBlocks: true,
  useUnicornModel: true,
  useSilverBullet: true,
  useMacroWindows: true,
  useSMT: true,
  smtOppositeVeto: true,
  useVWAP: true,
  vwapProximityPips: 15,
  useAMD: true,
  useFOTSI: true,
  useVolumeProfile: true,
  useTrendDirection: true,
  useDailyBias: true,

  // ── Regime Scoring ──
  regimeScoringEnabled: true,
  regimeScoringStrength: 1.0,

  // ── Risk Management ──
  maxDrawdown: 20,
  maxDailyLoss: 5,
  riskPerTrade: 1,
  positionSizingMethod: "percent_risk" as "percent_risk" | "fixed_lot" | "atr_volatility",
  fixedLotSize: 0.1,
  maxOpenPositions: 3,
  maxPerSymbol: 2,
  allowSameDirectionStacking: false,
  portfolioHeat: 10,
  minRiskReward: 1.5,
  conflictThresholdRaise: 4,
  conflictBlockAt: 6,

  // ── SL/TP Method ──
  slMethod: "structure" as "fixed_pips" | "atr_based" | "structure" | "below_ob",
  fixedSLPips: 25,
  slATRMultiple: 1.5,
  slATRPeriod: 14,
  slBufferPips: 2,
  instrumentBuffers: {} as Record<string, { slBufferPips?: number }>,
  tpMethod: "rr_ratio" as "fixed_pips" | "rr_ratio" | "next_level" | "atr_multiple",
  fixedTPPips: 50,
  tpRatio: 2.0,
  tpATRMultiple: 2.0,

  // ── Exit Management ──
  breakEvenEnabled: true,
  breakEvenPips: 20,
  trailingStopEnabled: false,
  trailingStopPips: 15,
  trailingStopActivation: "after_1r",
  partialTPEnabled: false,
  partialTPPercent: 50,
  partialTPLevel: 1.0,
  maxHoldEnabled: false,
  maxHoldHours: 0,
  structureInvalidationEnabled: false,

  // ── Sessions & Days ──
  enabledSessions: ["london", "newyork"] as string[],
  enabledDays: [1, 2, 3, 4, 5] as number[],
  killZoneOnly: false,

  // ── Instruments ──
  instruments: [
    "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD",
    "GBP/JPY", "EUR/JPY", "NZD/USD", "USD/CHF", "EUR/GBP",
    "XAU/USD", "BTC/USD",
  ] as string[],

  // ── Spread Filter ──
  spreadFilterEnabled: true,
  maxSpreadPips: 0, // 0 = use per-instrument defaults from SPECS.maxSpread

  // ── ATR Volatility Filter ──
  atrFilterEnabled: false,
  atrFilterMin: 0,
  atrFilterMax: 0,

  // ── News Event Filter ──
  newsFilterEnabled: true,
  newsFilterPauseMinutes: 30,

  // ── Entry Behaviour ──
  scanIntervalMinutes: 15,
  cooldownMinutes: 0,
  closeOnReverse: false,

  // ── Protection ──
  maxConsecutiveLosses: 0,
  protectionMaxDailyLossDollar: 0,

  // ── Tier 1 Gate ──
  minTier1Factors: 3,
  // ── Impulse Zone Scoring ──
  impulseZoneEnabled: true,
  impulseZonePenalty: 2.0,
  impulseZoneBonus: 1.0,
  impulseZoneGateMode: "hard" as "hard" | "soft" | "off",
  minZoneScore: 4,
  impulseSlCapMultiplier: 4,
  cascadeZoneMode: "prefer" as "prefer" | "only" | "off",
  cascadeZoneDailyATRMult: 2.0,
  requireUnifiedZone: false,  // When true, only take trades when Unified Zone Engine confirms (no standalone impulse zone fallback)

  // ── Simple Direction Engine ──
  useSimpleDirection: true,
  simpleDirectionH4ChochLookback: 10,
  simpleDirectionH1BosLookback: 8,
  useConfirmedTrend: true,
  confirmedTrendFibFactor: 0.25,
  confirmedTrendSwingLookback: 5,

  // ── Structural Conviction Gate (Gate 3) ──
  structuralConvictionEnabled: true,
  structuralConvictionS2FLong: 0.35,
  structuralConvictionS2FShort: 0.20,
  structuralConvictionOppositeLong: 0.30,
  structuralConvictionOppositeShort: 0.45,

  // ── Regime-Adaptive Exit Engine ──
  regimeAdaptiveTPEnabled: false,
  trendingRRMultiplier: 1.5,
  rangingRRMultiplier: 0.75,
  adaptiveTrailingEnabled: false,
  baseTrailATRMultiple: 1.5,
  momentumFadeThreshold: 0.4,
  trailTightenFactor: 0.6,
  trailWidenFactor: 1.3,

  // ── Setup Staging / Watchlist ──
  stagingEnabled: true,
  watchThreshold: 25,
  stagingTTLMinutes: 240,
  minStagingCycles: 1,

  // ── Limit Orders ──
  limitOrderEnabled: false,
  limitOrderExpiryMinutes: 60,
  limitOrderMaxDistancePips: 30,
  limitOrderMinDistancePips: 3,
  limitOrderPreferZone: "ob" as "ob" | "fvg" | "nearest",
  marketFillAtZone: true,
  marketFillStrictATRMult: 0.3,

  // ── Opening Range ──
  openingRange: {
    enabled: false,
    candleCount: 24,
    useBias: true,
    useJudasSwing: true,
    useKeyLevels: true,
    usePremiumDiscount: false,
    waitForCompletion: true,
  },

  // ── Trading Style ──
  tradingStyle: {
    mode: "day_trader" as "scalper" | "day_trader" | "swing_trader",
  },

  // ── Factor Weights (config-driven, AI-tunable) ──
  factorWeights: {} as Record<string, number>,

  // ── P1 Tuning Fields ──
  obLookbackCandles: 50,
  fvgMinSizePips: 0,
  fvgOnlyUnfilled: true,
  structureLookback: 50,
  liquidityPoolMinTouches: 2,
  equalHighsLowsSensitivity: 3,

  // ── ICT HTF Framework ──
  ictHTFEnabled: true,
  ictHTFGateMode: "off" as "hard" | "soft" | "off",
  ictHTFAlignedBonus: 2.0,
  ictHTFMisalignedPenalty: 3.0,
  ictHTFMinContainment: 50,
  ictWeeklyBiasRequired: true,
  ictDailyContainmentRequired: true,

  // ── ICT Displacement MSS Validation ──
  ictDisplacementMSSEnabled: true,
  ictDisplacementMSSGateMode: "off" as "hard" | "soft" | "off",
  ictDisplacementMSSMinBodyRatio: 0.6,
  ictDisplacementMSSMinRangeATR: 1.2,
  ictDisplacementMSSLookback: 3,
  ictDisplacementMSSPenalty: 2.0,

  // ── ICT Judas Swing ──
  ictJudasSwingEnabled: true,
  ictJudasSwingGateMode: "off" as "hard" | "soft" | "off",
  ictJudasSwingLookback: 10,
  ictJudasSwingMinDepthATR: 0.1,
  ictJudasSwingRequireCloseBack: true,
  ictJudasSwingPenalty: 1.5,

  // ── ICT FVG Invalidation ──
  ictFVGInvalidationEnabled: true,
  ictFVGInvalidationGateMode: "off" as "hard" | "soft" | "off",
  ictFVGBodyCloseOnly: true,
  ictFVGRuleOfTwo: true,
  ictFVGExhaustedPenalty: 1.5,
  ictFVGInvalidatedPenalty: 3.0,

  // ── ICT Kill Zone Time Filter ──
  ictKillZoneEnabled: true,
  ictKillZoneGateMode: "off" as "hard" | "soft" | "off",
  ictKillZoneSilverBullet: true,
  ictKillZonePMSession: true,
  ictKillZoneOutsidePenalty: 1.0,
  ictKillZonePrimeBonus: 1.5,

  // ── ICT Risk Management ──
  ictRiskEnabled: true,
  ictRiskBasePercent: 0.01,
  ictRiskDrawdownHalving: true,
  ictRiskMaxConsecLosses: 3,
  ictRiskDailyLimit: 0.01,
  ictRiskWeeklyLimit: 0.025,
  ictRiskMaxTradesPerDay: 3,
  ictRiskFVGRuleOfTwoExit: true,

  // ── Correlation Filter ──
  correlationFilterEnabled: true,
  maxCorrelatedPositions: 2,

  // ── Entry/HTF Timeframes (set by style) ──
  entryTimeframe: "15min",
  htfTimeframe: "1day",

  // ── Per-Pair Gate Overrides ──
  // Allows per-symbol overrides for key gate thresholds.
  // When a symbol has an entry here, those fields override the global config
  // for that symbol only. Non-overridden fields fall through to global values.
  pairGateOverrides: {} as Record<string, PairGateOverride>,

  // ── Per-pair scratch (set during scan) ──
  _currentSymbol: "" as string,
  _smtResult: null as any,
};

/**
 * Fields that can be overridden per-pair.
 * Each field corresponds to a gate threshold in the scanner.
 * Only specified fields are overridden; omitted fields use global config.
 */
export interface PairGateOverride {
  /** Min effective R:R after spread+commission (Gate 10). Default: global minRiskReward */
  minRiskReward?: number;
  /** Min Tier 1 core factors required (Gate 19). Default: global minTier1Factors */
  minTier1Factors?: number;
  /** Allow same-direction stacking (Gate 5). Default: global allowSameDirectionStacking */
  allowSameDirectionStacking?: boolean;
  /** Max positions per symbol (Gate 5). Default: global maxPerSymbol */
  maxPerSymbol?: number;
  /** Min confluence score threshold. Default: global minConfluence */
  minConfluence?: number;
  /** Dollar-based daily loss limit (Gate 15). Default: global protectionMaxDailyLossDollar */
  protectionMaxDailyLossDollar?: number;
  /** Max consecutive losses before cooldown (Gate 14). Default: global maxConsecutiveLosses */
  maxConsecutiveLosses?: number;
}

// Export the type for consumers
export type RuntimeConfig = typeof RUNTIME_DEFAULTS;

// ─── Map Nested Config JSON → Flat Runtime Config ─────────────────────
/**
 * Maps the nested config_json shape (as stored in bot_configs and written
 * by the UI) to the flat runtime config object used by both engines.
 *
 * This function handles:
 *   - Current UI field names (e.g. strategy.confluenceThreshold)
 *   - Legacy DB field names (e.g. minConfluenceScore)
 *   - Top-level flat fields (e.g. raw.minConfluence)
 *   - Auto-scaling legacy 0-10 values to percentage
 *   - Session filter normalization (sydney → offhours, etc.)
 *   - Active days conversion ({mon:true,...} → [1,2,...])
 *
 * @param raw - The raw config_json from bot_configs table or request body.
 *              Can be null/undefined (returns RUNTIME_DEFAULTS).
 */
export function mapNestedToFlat(raw: any): RuntimeConfig {
  if (!raw) {
    return { ...RUNTIME_DEFAULTS };
  }

  const strategy = raw.strategy || {};
  const risk = raw.risk || {};
  const entry = raw.entry || {};
  const exit = raw.exit || {};
  const instruments = raw.instruments || {};
  const sessions = raw.sessions || {};
  const protection = raw.protection || {};

  // ── Instrument list resolution ──
  const enabledInstrumentMap = instruments.allowedInstruments && typeof instruments.allowedInstruments === "object"
    ? instruments.allowedInstruments
    : null;
  const enabledInstrumentList = enabledInstrumentMap
    ? Object.entries(enabledInstrumentMap)
        .filter(([, enabled]) => Boolean(enabled))
        .map(([symbol]) => symbol)
    : null;

  return {
    ...RUNTIME_DEFAULTS,

    // ── Strategy mappings ──
    minConfluence: (() => {
      const raw_mc = strategy.confluenceThreshold ?? strategy.minConfluenceScore ?? raw.minConfluence ?? RUNTIME_DEFAULTS.minConfluence;
      // Auto-scale legacy 0-10 values to percentage when normalizedScoring is on
      if (raw_mc > 0 && raw_mc <= 10 && (strategy.normalizedScoring ?? raw.normalizedScoring ?? true)) {
        return raw_mc * 10;
      }
      return raw_mc;
    })(),
    htfBiasRequired: strategy.requireHTFBias ?? strategy.htfBiasRequired ?? raw.htfBiasRequired ?? RUNTIME_DEFAULTS.htfBiasRequired,
    htfBiasHardVeto: strategy.htfBiasHardVeto ?? raw.htfBiasHardVeto ?? RUNTIME_DEFAULTS.htfBiasHardVeto,
    normalizedScoring: strategy.normalizedScoring ?? raw.normalizedScoring ?? RUNTIME_DEFAULTS.normalizedScoring,

    // ── Factor Toggles ──
    enableOB: strategy.useOrderBlocks ?? strategy.enableOB ?? true,
    enableFVG: strategy.useFVG ?? strategy.enableFVG ?? true,
    enableLiquiditySweep: strategy.useLiquiditySweep ?? strategy.enableLiquiditySweep ?? true,
    enableStructureBreak: strategy.useStructureBreak ?? (strategy.enableBOS !== undefined ? strategy.enableBOS : true),
    useDisplacement: strategy.useDisplacement ?? true,
    useBreakerBlocks: strategy.useBreakerBlocks ?? true,
    useUnicornModel: strategy.useUnicornModel ?? true,
    useSilverBullet: strategy.useSilverBullet ?? true,
    useMacroWindows: strategy.useMacroWindows ?? true,
    useSMT: strategy.useSMT ?? true,
    smtOppositeVeto: strategy.smtOppositeVeto ?? raw.smtOppositeVeto ?? true,
    useVWAP: strategy.useVWAP ?? true,
    vwapProximityPips: strategy.vwapProximityPips ?? 15,
    useAMD: strategy.useAMD ?? true,
    useFOTSI: strategy.useFOTSI ?? true,
    useVolumeProfile: strategy.useVolumeProfile ?? true,
    useTrendDirection: strategy.useTrendDirection ?? true,
    useDailyBias: strategy.useDailyBias ?? true,

    // ── Regime Scoring ──
    regimeScoringEnabled: strategy.regimeScoringEnabled ?? raw.regimeScoringEnabled ?? RUNTIME_DEFAULTS.regimeScoringEnabled,
    regimeScoringStrength: strategy.regimeScoringStrength ?? raw.regimeScoringStrength ?? RUNTIME_DEFAULTS.regimeScoringStrength,

    // ── Premium/Discount Filters ──
    onlyBuyInDiscount: strategy.onlyBuyInDiscount ?? RUNTIME_DEFAULTS.onlyBuyInDiscount,
    onlySellInPremium: strategy.onlySellInPremium ?? RUNTIME_DEFAULTS.onlySellInPremium,

    // ── P1 Tuning Fields ──
    obLookbackCandles: strategy.obLookbackCandles ?? raw.obLookbackCandles ?? RUNTIME_DEFAULTS.obLookbackCandles,
    fvgMinSizePips: strategy.fvgMinSizePips ?? raw.fvgMinSizePips ?? RUNTIME_DEFAULTS.fvgMinSizePips,
    fvgOnlyUnfilled: strategy.fvgOnlyUnfilled ?? raw.fvgOnlyUnfilled ?? RUNTIME_DEFAULTS.fvgOnlyUnfilled,
    structureLookback: strategy.structureLookback ?? raw.structureLookback ?? RUNTIME_DEFAULTS.structureLookback,
    liquidityPoolMinTouches: strategy.liquidityPoolMinTouches ?? raw.liquidityPoolMinTouches ?? RUNTIME_DEFAULTS.liquidityPoolMinTouches,
    equalHighsLowsSensitivity: strategy.equalHighsLowsSensitivity ?? raw.equalHighsLowsSensitivity ?? RUNTIME_DEFAULTS.equalHighsLowsSensitivity,

    // ── Tier 1 Gate ──
    minTier1Factors: strategy.minTier1Factors ?? raw.minTier1Factors ?? RUNTIME_DEFAULTS.minTier1Factors,
    // ── Impulse Zone ──
    impulseZoneEnabled: strategy.impulseZoneEnabled ?? raw.impulseZoneEnabled ?? RUNTIME_DEFAULTS.impulseZoneEnabled,
    impulseZonePenalty: strategy.impulseZonePenalty ?? raw.impulseZonePenalty ?? RUNTIME_DEFAULTS.impulseZonePenalty,
    impulseZoneBonus: strategy.impulseZoneBonus ?? raw.impulseZoneBonus ?? RUNTIME_DEFAULTS.impulseZoneBonus,
    impulseZoneGateMode: (strategy.impulseZoneGateMode ?? raw.impulseZoneGateMode ?? RUNTIME_DEFAULTS.impulseZoneGateMode) as "hard" | "soft" | "off",
    minZoneScore: strategy.minZoneScore ?? raw.minZoneScore ?? RUNTIME_DEFAULTS.minZoneScore,
    impulseSlCapMultiplier: strategy.impulseSlCapMultiplier ?? raw.impulseSlCapMultiplier ?? RUNTIME_DEFAULTS.impulseSlCapMultiplier,
    cascadeZoneMode: (strategy.cascadeZoneMode ?? raw.cascadeZoneMode ?? RUNTIME_DEFAULTS.cascadeZoneMode) as "prefer" | "only" | "off",
    cascadeZoneDailyATRMult: strategy.cascadeZoneDailyATRMult ?? raw.cascadeZoneDailyATRMult ?? RUNTIME_DEFAULTS.cascadeZoneDailyATRMult,
    requireUnifiedZone: strategy.requireUnifiedZone ?? raw.requireUnifiedZone ?? RUNTIME_DEFAULTS.requireUnifiedZone,

    // ── Simple Direction Engine ──
    useSimpleDirection: strategy.useSimpleDirection ?? raw.useSimpleDirection ?? RUNTIME_DEFAULTS.useSimpleDirection,
    simpleDirectionH4ChochLookback: strategy.simpleDirectionH4ChochLookback ?? raw.simpleDirectionH4ChochLookback ?? RUNTIME_DEFAULTS.simpleDirectionH4ChochLookback,
    simpleDirectionH1BosLookback: strategy.simpleDirectionH1BosLookback ?? raw.simpleDirectionH1BosLookback ?? RUNTIME_DEFAULTS.simpleDirectionH1BosLookback,
    useConfirmedTrend: strategy.useConfirmedTrend ?? raw.useConfirmedTrend ?? RUNTIME_DEFAULTS.useConfirmedTrend,
    confirmedTrendFibFactor: strategy.confirmedTrendFibFactor ?? raw.confirmedTrendFibFactor ?? RUNTIME_DEFAULTS.confirmedTrendFibFactor,
    confirmedTrendSwingLookback: strategy.confirmedTrendSwingLookback ?? raw.confirmedTrendSwingLookback ?? RUNTIME_DEFAULTS.confirmedTrendSwingLookback,

    // ── Structural Conviction Gate ──
    structuralConvictionEnabled: strategy.structuralConvictionEnabled !== false,
    structuralConvictionS2FLong: strategy.structuralConvictionS2FLong ?? raw.structuralConvictionS2FLong ?? RUNTIME_DEFAULTS.structuralConvictionS2FLong,
    structuralConvictionS2FShort: strategy.structuralConvictionS2FShort ?? raw.structuralConvictionS2FShort ?? RUNTIME_DEFAULTS.structuralConvictionS2FShort,
    structuralConvictionOppositeLong: strategy.structuralConvictionOppositeLong ?? raw.structuralConvictionOppositeLong ?? RUNTIME_DEFAULTS.structuralConvictionOppositeLong,
    structuralConvictionOppositeShort: strategy.structuralConvictionOppositeShort ?? raw.structuralConvictionOppositeShort ?? RUNTIME_DEFAULTS.structuralConvictionOppositeShort,

    // ── Regime-Adaptive Exit Engine ──
    regimeAdaptiveTPEnabled: strategy.regimeAdaptiveTPEnabled ?? raw.regimeAdaptiveTPEnabled ?? RUNTIME_DEFAULTS.regimeAdaptiveTPEnabled,
    trendingRRMultiplier: strategy.trendingRRMultiplier ?? raw.trendingRRMultiplier ?? RUNTIME_DEFAULTS.trendingRRMultiplier,
    rangingRRMultiplier: strategy.rangingRRMultiplier ?? raw.rangingRRMultiplier ?? RUNTIME_DEFAULTS.rangingRRMultiplier,
    adaptiveTrailingEnabled: strategy.adaptiveTrailingEnabled ?? raw.adaptiveTrailingEnabled ?? RUNTIME_DEFAULTS.adaptiveTrailingEnabled,
    baseTrailATRMultiple: strategy.baseTrailATRMultiple ?? raw.baseTrailATRMultiple ?? RUNTIME_DEFAULTS.baseTrailATRMultiple,
    momentumFadeThreshold: strategy.momentumFadeThreshold ?? raw.momentumFadeThreshold ?? RUNTIME_DEFAULTS.momentumFadeThreshold,
    trailTightenFactor: strategy.trailTightenFactor ?? raw.trailTightenFactor ?? RUNTIME_DEFAULTS.trailTightenFactor,
    trailWidenFactor: strategy.trailWidenFactor ?? raw.trailWidenFactor ?? RUNTIME_DEFAULTS.trailWidenFactor,

    // ── Setup Staging / Watchlist ──
    stagingEnabled: strategy.stagingEnabled ?? raw.stagingEnabled ?? RUNTIME_DEFAULTS.stagingEnabled,
    watchThreshold: strategy.watchThreshold ?? raw.watchThreshold ?? RUNTIME_DEFAULTS.watchThreshold,
    stagingTTLMinutes: strategy.stagingTTLMinutes ?? raw.stagingTTLMinutes ?? RUNTIME_DEFAULTS.stagingTTLMinutes,
    minStagingCycles: strategy.minStagingCycles ?? raw.minStagingCycles ?? RUNTIME_DEFAULTS.minStagingCycles,

    // ── Risk Mappings ──
    riskPerTrade: risk.riskPerTrade ?? raw.riskPerTrade ?? RUNTIME_DEFAULTS.riskPerTrade,
    positionSizingMethod: risk.positionSizingMethod ?? raw.positionSizingMethod ?? RUNTIME_DEFAULTS.positionSizingMethod,
    fixedLotSize: risk.fixedLotSize ?? raw.fixedLotSize ?? RUNTIME_DEFAULTS.fixedLotSize,
    maxDailyLoss: risk.maxDailyDrawdown ?? risk.maxDailyLoss ?? raw.maxDailyLoss ?? RUNTIME_DEFAULTS.maxDailyLoss,
    maxOpenPositions: risk.maxConcurrentTrades ?? risk.maxOpenPositions ?? raw.maxOpenPositions ?? RUNTIME_DEFAULTS.maxOpenPositions,
    minRiskReward: risk.minRR ?? risk.minRiskReward ?? raw.minRiskReward ?? RUNTIME_DEFAULTS.minRiskReward,
    maxPerSymbol: risk.maxPositionsPerSymbol ?? RUNTIME_DEFAULTS.maxPerSymbol,
    allowSameDirectionStacking: risk.allowSameDirectionStacking ?? RUNTIME_DEFAULTS.allowSameDirectionStacking,
    portfolioHeat: risk.maxPortfolioHeat ?? RUNTIME_DEFAULTS.portfolioHeat,
    conflictThresholdRaise: risk.conflictThresholdRaise ?? raw.conflictThresholdRaise ?? RUNTIME_DEFAULTS.conflictThresholdRaise,
    conflictBlockAt: risk.conflictBlockAt ?? raw.conflictBlockAt ?? RUNTIME_DEFAULTS.conflictBlockAt,

    // ── Entry Mappings ──
    scanIntervalMinutes: entry.scanIntervalMinutes ?? raw.scanIntervalMinutes ?? RUNTIME_DEFAULTS.scanIntervalMinutes,
    cooldownMinutes: entry.cooldownMinutes ?? 0,
    closeOnReverse: entry.closeOnReverse ?? false,
    slBufferPips: entry.slBufferPips ?? raw.slBufferPips ?? RUNTIME_DEFAULTS.slBufferPips,

    // ── SL/TP Method Mappings ──
    slMethod: exit.stopLossMethod ?? exit.slMethod ?? raw.slMethod ?? RUNTIME_DEFAULTS.slMethod,
    fixedSLPips: exit.fixedSLPips ?? raw.fixedSLPips ?? RUNTIME_DEFAULTS.fixedSLPips,
    slATRMultiple: exit.slATRMultiple ?? raw.slATRMultiple ?? RUNTIME_DEFAULTS.slATRMultiple,
    slATRPeriod: exit.slATRPeriod ?? raw.slATRPeriod ?? RUNTIME_DEFAULTS.slATRPeriod,
    tpMethod: exit.takeProfitMethod ?? exit.tpMethod ?? raw.tpMethod ?? RUNTIME_DEFAULTS.tpMethod,
    fixedTPPips: exit.fixedTPPips ?? raw.fixedTPPips ?? RUNTIME_DEFAULTS.fixedTPPips,
    tpRatio: exit.tpRRRatio ?? risk.defaultRR ?? risk.minRiskReward ?? raw.tpRatio ?? RUNTIME_DEFAULTS.tpRatio,
    tpATRMultiple: exit.tpATRMultiple ?? raw.tpATRMultiple ?? RUNTIME_DEFAULTS.tpATRMultiple,

    // ── Exit Mappings ──
    trailingStopEnabled: exit.trailingStop ?? exit.trailingStopEnabled ?? raw.trailingStopEnabled ?? false,
    trailingStopPips: exit.trailingStopPips ?? raw.trailingStopPips ?? 15,
    trailingStopActivation: exit.trailingStopActivation ?? raw.trailingStopActivation ?? "after_1r",
    breakEvenEnabled: exit.breakEven ?? exit.breakEvenEnabled ?? raw.breakEvenEnabled ?? RUNTIME_DEFAULTS.breakEvenEnabled,
    breakEvenPips: exit.breakEvenTriggerPips ?? exit.breakEvenPips ?? raw.breakEvenPips ?? RUNTIME_DEFAULTS.breakEvenPips,
    partialTPEnabled: exit.partialTP ?? exit.partialTPEnabled ?? false,
    partialTPPercent: exit.partialTPPercent ?? raw.partialTPPercent ?? 50,
    partialTPLevel: exit.partialTPLevel ?? raw.partialTPLevel ?? 1.0,
    maxHoldEnabled: exit.maxHoldEnabled ?? raw.maxHoldEnabled ?? RUNTIME_DEFAULTS.maxHoldEnabled,
    maxHoldHours: exit.timeExitHours ?? exit.maxHoldHours ?? 0,

    // ── Instruments ──
    instruments: Array.isArray(instruments.enabled)
      ? instruments.enabled
      : enabledInstrumentList
        ? enabledInstrumentList
        : (Array.isArray(raw.instruments) ? raw.instruments : RUNTIME_DEFAULTS.instruments),

    // ── Sessions ──
    enabledSessions: (
      Array.isArray(sessions.filter)
        ? normalizeSessionFilter(sessions.filter)
        : sessions.asianEnabled !== undefined
          ? normalizeSessionFilter([
              ...(sessions.asianEnabled ? ["asian"] : []),
              ...(sessions.londonEnabled ? ["london"] : []),
              ...(sessions.newYorkEnabled || sessions.newyorkEnabled ? ["newyork"] : []),
              ...(sessions.sydneyEnabled ? ["sydney"] : []),
            ])
          : (Array.isArray(raw.enabledSessions) ? normalizeSessionFilter(raw.enabledSessions) : RUNTIME_DEFAULTS.enabledSessions)
    ),
    killZoneOnly: sessions.killZoneOnly ?? false,

    // ── Active Days ──
    enabledDays: sessions.activeDays
      ? [
          ...(sessions.activeDays.sun ? [0] : []),
          ...(sessions.activeDays.mon ? [1] : []),
          ...(sessions.activeDays.tue ? [2] : []),
          ...(sessions.activeDays.wed ? [3] : []),
          ...(sessions.activeDays.thu ? [4] : []),
          ...(sessions.activeDays.fri ? [5] : []),
          ...(sessions.activeDays.sat ? [6] : []),
        ]
      : (Array.isArray(raw.enabledDays) ? raw.enabledDays : RUNTIME_DEFAULTS.enabledDays),

    // ── Protection ──
    maxConsecutiveLosses: protection.maxConsecutiveLosses ?? 0,
    protectionMaxDailyLossDollar: protection.maxDailyLoss ?? protection.dailyLossLimit ?? 0,
    maxDrawdown: Math.min(
      risk.maxDrawdown ?? raw.maxDrawdown ?? RUNTIME_DEFAULTS.maxDrawdown,
      protection.circuitBreakerPct ?? 100,
    ),

    // ── Opening Range & Trading Style ──
    openingRange: { ...RUNTIME_DEFAULTS.openingRange, ...(raw.openingRange || {}) },
    tradingStyle: { ...RUNTIME_DEFAULTS.tradingStyle, ...(raw.tradingStyle || {}) },

    // ── Factor Weights ──
    factorWeights: raw.factorWeights || {},

    // ── Per-Instrument SL Buffer Overrides ──
    instrumentBuffers: raw.instrumentBuffers || entry.instrumentBuffers || {},

    // ── Spread Filter ──
    spreadFilterEnabled: instruments.spreadFilterEnabled ?? raw.spreadFilterEnabled ?? RUNTIME_DEFAULTS.spreadFilterEnabled,
    maxSpreadPips: instruments.maxSpreadPips ?? raw.maxSpreadPips ?? RUNTIME_DEFAULTS.maxSpreadPips,

    // ── News Event Filter ──
    newsFilterEnabled: sessions.newsFilterEnabled ?? raw.newsFilterEnabled ?? RUNTIME_DEFAULTS.newsFilterEnabled,
    newsFilterPauseMinutes: sessions.newsFilterPauseMinutes ?? raw.newsFilterPauseMinutes ?? RUNTIME_DEFAULTS.newsFilterPauseMinutes,

    // ── ATR Volatility Filter ──
    atrFilterEnabled: instruments.volatilityFilterEnabled ?? raw.atrFilterEnabled ?? RUNTIME_DEFAULTS.atrFilterEnabled,
    atrFilterMin: instruments.minATR ?? raw.atrFilterMin ?? RUNTIME_DEFAULTS.atrFilterMin,
    atrFilterMax: instruments.maxATR ?? raw.atrFilterMax ?? RUNTIME_DEFAULTS.atrFilterMax,

    // ── ICT HTF Framework ──
    ictHTFEnabled: strategy.ictHTFEnabled ?? raw.ictHTFEnabled ?? RUNTIME_DEFAULTS.ictHTFEnabled,
    ictHTFGateMode: (strategy.ictHTFGateMode ?? raw.ictHTFGateMode ?? RUNTIME_DEFAULTS.ictHTFGateMode) as "hard" | "soft" | "off",
    ictHTFAlignedBonus: strategy.ictHTFAlignedBonus ?? raw.ictHTFAlignedBonus ?? RUNTIME_DEFAULTS.ictHTFAlignedBonus,
    ictHTFMisalignedPenalty: strategy.ictHTFMisalignedPenalty ?? raw.ictHTFMisalignedPenalty ?? RUNTIME_DEFAULTS.ictHTFMisalignedPenalty,
    ictHTFMinContainment: strategy.ictHTFMinContainment ?? raw.ictHTFMinContainment ?? RUNTIME_DEFAULTS.ictHTFMinContainment,
    ictWeeklyBiasRequired: strategy.ictWeeklyBiasRequired ?? raw.ictWeeklyBiasRequired ?? RUNTIME_DEFAULTS.ictWeeklyBiasRequired,
    ictDailyContainmentRequired: strategy.ictDailyContainmentRequired ?? raw.ictDailyContainmentRequired ?? RUNTIME_DEFAULTS.ictDailyContainmentRequired,

    // ── ICT Displacement MSS Validation ──
    ictDisplacementMSSEnabled: strategy.ictDisplacementMSSEnabled ?? raw.ictDisplacementMSSEnabled ?? RUNTIME_DEFAULTS.ictDisplacementMSSEnabled,
    ictDisplacementMSSGateMode: (strategy.ictDisplacementMSSGateMode ?? raw.ictDisplacementMSSGateMode ?? RUNTIME_DEFAULTS.ictDisplacementMSSGateMode) as "hard" | "soft" | "off",
    ictDisplacementMSSMinBodyRatio: strategy.ictDisplacementMSSMinBodyRatio ?? raw.ictDisplacementMSSMinBodyRatio ?? RUNTIME_DEFAULTS.ictDisplacementMSSMinBodyRatio,
    ictDisplacementMSSMinRangeATR: strategy.ictDisplacementMSSMinRangeATR ?? raw.ictDisplacementMSSMinRangeATR ?? RUNTIME_DEFAULTS.ictDisplacementMSSMinRangeATR,
    ictDisplacementMSSLookback: strategy.ictDisplacementMSSLookback ?? raw.ictDisplacementMSSLookback ?? RUNTIME_DEFAULTS.ictDisplacementMSSLookback,
    ictDisplacementMSSPenalty: strategy.ictDisplacementMSSPenalty ?? raw.ictDisplacementMSSPenalty ?? RUNTIME_DEFAULTS.ictDisplacementMSSPenalty,

    // ── ICT Judas Swing ──
    ictJudasSwingEnabled: strategy.ictJudasSwingEnabled ?? raw.ictJudasSwingEnabled ?? RUNTIME_DEFAULTS.ictJudasSwingEnabled,
    ictJudasSwingGateMode: (strategy.ictJudasSwingGateMode ?? raw.ictJudasSwingGateMode ?? RUNTIME_DEFAULTS.ictJudasSwingGateMode) as "hard" | "soft" | "off",
    ictJudasSwingLookback: strategy.ictJudasSwingLookback ?? raw.ictJudasSwingLookback ?? RUNTIME_DEFAULTS.ictJudasSwingLookback,
    ictJudasSwingMinDepthATR: strategy.ictJudasSwingMinDepthATR ?? raw.ictJudasSwingMinDepthATR ?? RUNTIME_DEFAULTS.ictJudasSwingMinDepthATR,
    ictJudasSwingRequireCloseBack: strategy.ictJudasSwingRequireCloseBack ?? raw.ictJudasSwingRequireCloseBack ?? RUNTIME_DEFAULTS.ictJudasSwingRequireCloseBack,
    ictJudasSwingPenalty: strategy.ictJudasSwingPenalty ?? raw.ictJudasSwingPenalty ?? RUNTIME_DEFAULTS.ictJudasSwingPenalty,

    // ── ICT FVG Invalidation ──
    ictFVGInvalidationEnabled: strategy.ictFVGInvalidationEnabled ?? raw.ictFVGInvalidationEnabled ?? RUNTIME_DEFAULTS.ictFVGInvalidationEnabled,
    ictFVGInvalidationGateMode: (strategy.ictFVGInvalidationGateMode ?? raw.ictFVGInvalidationGateMode ?? RUNTIME_DEFAULTS.ictFVGInvalidationGateMode) as "hard" | "soft" | "off",
    ictFVGBodyCloseOnly: strategy.ictFVGBodyCloseOnly ?? raw.ictFVGBodyCloseOnly ?? RUNTIME_DEFAULTS.ictFVGBodyCloseOnly,
    ictFVGRuleOfTwo: strategy.ictFVGRuleOfTwo ?? raw.ictFVGRuleOfTwo ?? RUNTIME_DEFAULTS.ictFVGRuleOfTwo,
    ictFVGExhaustedPenalty: strategy.ictFVGExhaustedPenalty ?? raw.ictFVGExhaustedPenalty ?? RUNTIME_DEFAULTS.ictFVGExhaustedPenalty,
    ictFVGInvalidatedPenalty: strategy.ictFVGInvalidatedPenalty ?? raw.ictFVGInvalidatedPenalty ?? RUNTIME_DEFAULTS.ictFVGInvalidatedPenalty,

    // ── ICT Kill Zone ──
    ictKillZoneEnabled: strategy.ictKillZoneEnabled ?? raw.ictKillZoneEnabled ?? RUNTIME_DEFAULTS.ictKillZoneEnabled,
    ictKillZoneGateMode: (strategy.ictKillZoneGateMode ?? raw.ictKillZoneGateMode ?? RUNTIME_DEFAULTS.ictKillZoneGateMode) as "hard" | "soft" | "off",
    ictKillZoneSilverBullet: strategy.ictKillZoneSilverBullet ?? raw.ictKillZoneSilverBullet ?? RUNTIME_DEFAULTS.ictKillZoneSilverBullet,
    ictKillZonePMSession: strategy.ictKillZonePMSession ?? raw.ictKillZonePMSession ?? RUNTIME_DEFAULTS.ictKillZonePMSession,
    ictKillZoneOutsidePenalty: strategy.ictKillZoneOutsidePenalty ?? raw.ictKillZoneOutsidePenalty ?? RUNTIME_DEFAULTS.ictKillZoneOutsidePenalty,
    ictKillZonePrimeBonus: strategy.ictKillZonePrimeBonus ?? raw.ictKillZonePrimeBonus ?? RUNTIME_DEFAULTS.ictKillZonePrimeBonus,

    // ── ICT Risk Management ──
    ictRiskEnabled: strategy.ictRiskEnabled ?? raw.ictRiskEnabled ?? RUNTIME_DEFAULTS.ictRiskEnabled,
    ictRiskBasePercent: strategy.ictRiskBasePercent ?? raw.ictRiskBasePercent ?? RUNTIME_DEFAULTS.ictRiskBasePercent,
    ictRiskDrawdownHalving: strategy.ictRiskDrawdownHalving ?? raw.ictRiskDrawdownHalving ?? RUNTIME_DEFAULTS.ictRiskDrawdownHalving,
    ictRiskMaxConsecLosses: strategy.ictRiskMaxConsecLosses ?? raw.ictRiskMaxConsecLosses ?? RUNTIME_DEFAULTS.ictRiskMaxConsecLosses,
    ictRiskDailyLimit: strategy.ictRiskDailyLimit ?? raw.ictRiskDailyLimit ?? RUNTIME_DEFAULTS.ictRiskDailyLimit,
    ictRiskWeeklyLimit: strategy.ictRiskWeeklyLimit ?? raw.ictRiskWeeklyLimit ?? RUNTIME_DEFAULTS.ictRiskWeeklyLimit,
    ictRiskMaxTradesPerDay: strategy.ictRiskMaxTradesPerDay ?? raw.ictRiskMaxTradesPerDay ?? RUNTIME_DEFAULTS.ictRiskMaxTradesPerDay,
    ictRiskFVGRuleOfTwoExit: strategy.ictRiskFVGRuleOfTwoExit ?? raw.ictRiskFVGRuleOfTwoExit ?? RUNTIME_DEFAULTS.ictRiskFVGRuleOfTwoExit,

    // ── Correlation Filter ──
    correlationFilterEnabled: strategy.correlationFilterEnabled ?? raw.correlationFilterEnabled ?? RUNTIME_DEFAULTS.correlationFilterEnabled,
    maxCorrelatedPositions: strategy.maxCorrelatedPositions ?? raw.maxCorrelatedPositions ?? RUNTIME_DEFAULTS.maxCorrelatedPositions,

    // ── Limit Orders ──
    limitOrderEnabled: entry.limitOrderEnabled ?? raw.limitOrderEnabled ?? RUNTIME_DEFAULTS.limitOrderEnabled,
    limitOrderExpiryMinutes: entry.limitOrderExpiryMinutes ?? raw.limitOrderExpiryMinutes ?? RUNTIME_DEFAULTS.limitOrderExpiryMinutes,
    limitOrderMaxDistancePips: entry.limitOrderMaxDistancePips ?? raw.limitOrderMaxDistancePips ?? RUNTIME_DEFAULTS.limitOrderMaxDistancePips,
    limitOrderMinDistancePips: entry.limitOrderMinDistancePips ?? raw.limitOrderMinDistancePips ?? RUNTIME_DEFAULTS.limitOrderMinDistancePips,
    limitOrderPreferZone: entry.limitOrderPreferZone ?? raw.limitOrderPreferZone ?? RUNTIME_DEFAULTS.limitOrderPreferZone,
    marketFillAtZone: entry.marketFillAtZone ?? raw.marketFillAtZone ?? RUNTIME_DEFAULTS.marketFillAtZone,
    marketFillStrictATRMult: entry.marketFillStrictATRMult ?? raw.marketFillStrictATRMult ?? RUNTIME_DEFAULTS.marketFillStrictATRMult,

    // ── Per-Pair Gate Overrides ──
    pairGateOverrides: raw.pairGateOverrides ?? RUNTIME_DEFAULTS.pairGateOverrides,

    // ── Per-pair scratch ──
    _currentSymbol: "",
    _smtResult: null,
  };
}

// ─── Apply Per-Pair Gate Overrides ─────────────────────────────────────────────────────────
/**
 * Merges per-pair gate overrides into a cloned config object.
 * Call this AFTER cloning the global config for a specific symbol.
 *
 * Only fields present in the override are applied; all others retain
 * their global values. Returns the mutated config (same reference).
 *
 * @param config - A CLONED config object (do not pass the shared global config)
 * @param symbol - The trading pair symbol (e.g. "EUR/JPY")
 * @returns The same config object with overrides applied (for chaining)
 */
export function applyPairOverrides<T extends RuntimeConfig>(config: T, symbol: string): T {
  const overrides = config.pairGateOverrides?.[symbol];
  if (!overrides) return config;

  if (overrides.minRiskReward !== undefined) config.minRiskReward = overrides.minRiskReward;
  if (overrides.minTier1Factors !== undefined) (config as any).minTier1Factors = overrides.minTier1Factors;
  if (overrides.allowSameDirectionStacking !== undefined) config.allowSameDirectionStacking = overrides.allowSameDirectionStacking;
  if (overrides.maxPerSymbol !== undefined) config.maxPerSymbol = overrides.maxPerSymbol;
  if (overrides.minConfluence !== undefined) config.minConfluence = overrides.minConfluence;
  if (overrides.protectionMaxDailyLossDollar !== undefined) (config as any).protectionMaxDailyLossDollar = overrides.protectionMaxDailyLossDollar;
  if (overrides.maxConsecutiveLosses !== undefined) (config as any).maxConsecutiveLosses = overrides.maxConsecutiveLosses;

  return config;
}
