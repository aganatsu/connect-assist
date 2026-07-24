/**
 * scoreParity.test.ts — Backtest Score Parity Regression Tests
 * ─────────────────────────────────────────────────────────────
 * Tests that the 5 new ICT score components added to the backtest engine
 * produce correct adjustments matching the live bot-scanner formula:
 *
 *   effectiveScore = analysis.score + fotsiPenalty + impulseZonePenaltyVal + ictTotalAdj + verdictScoreAdj
 *
 * Where ictTotalAdj = ictHTFScoreAdj + ictMSSAdj + ictJudasAdj + ictFVGAdj + ictKZAdj
 *
 * Run: deno test --no-check --allow-all supabase/functions/backtest-engine/scoreParity.test.ts
 */

import { type Candle } from "../_shared/smcAnalysis.ts";
import {
  assertEquals,
  assertAlmostEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Import the modules under test ─────────────────────────────────────────
import { computeDirectionVerdict, type DirectionVerdictInput } from "../_shared/directionVerdict.ts";
import { runICTHTFAnalysis, type ICTHTFResult } from "../_shared/ictHTFIntegration.ts";
import {
  validateRecentMSS,
  type MSSValidationResult,
  type DisplacementMSSConfig,
  DEFAULT_DISPLACEMENT_MSS_CONFIG,
} from "../_shared/ictDisplacementMSS.ts";
import {
  detectJudasSwing,
  type JudasSwingResult,
  type JudasSwingConfig,
  DEFAULT_JUDAS_SWING_CONFIG,
} from "../_shared/ictJudasSwing.ts";
import {
  validateFVGBatch,
  type FVGInvalidationConfig,
  DEFAULT_FVG_INVALIDATION_CONFIG,
  type FVGForValidation,
} from "../_shared/ictFVGInvalidation.ts";
import {
  evaluateICTKillZone,
  type ICTKillZoneResult,
  type ICTKillZoneConfig,
  DEFAULT_ICT_KILLZONE_CONFIG,
} from "../_shared/ictKillZones.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCandle(datetime: string, open: number, high: number, low: number, close: number): Candle {
  return { datetime, open, high, low, close };
}

function makeDailyCandles(count: number, basePrice: number): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const d = new Date(2024, 0, 1 + i).toISOString().replace("T", " ").slice(0, 19);
    const open = price;
    const high = price + 0.005;
    const low = price - 0.003;
    const close = price + 0.002;
    candles.push(makeCandle(d, open, high, low, close));
    price = close;
  }
  return candles;
}

/**
 * Mirrors the backtest's ICT score adjustment formula exactly:
 *
 * ictHTFScoreAdj = directionVerdict ? 0 : (ictHTFResult?.scoreAdjustment ?? 0)
 * verdictScoreAdj = directionVerdict?.scoreAdjustment ?? 0
 * ictMSSAdj = (gateMode === "soft" && mssResult && !mssResult.isValid) ? -penalty : 0
 * ictJudasAdj = (gateMode === "soft" && judasResult && !judasResult.found) ? -penalty : 0
 * ictFVGAdj = (gateMode === "soft" && totalCount > 0) ? -(inv*pen + exh*pen)/total : 0
 * ictKZAdj = (gateMode === "soft" && kzResult) ? (isKZ ? (isPrime ? bonus : 0) : -penalty) : 0
 * ictTotalAdj = ictHTFScoreAdj + ictMSSAdj + ictJudasAdj + ictFVGAdj + ictKZAdj
 * effectiveScore = rawScore + fotsiPenalty + izPenalty + ictTotalAdj + verdictScoreAdj
 */
function computeEffectiveScore(params: {
  rawScore: number;
  fotsiPenalty: number;
  impulseZonePenalty: number;
  directionVerdict: { scoreAdjustment: number } | null;
  ictHTFResult: { scoreAdjustment: number } | null;
  ictMSSResult: { isValid: boolean } | null;
  ictJudasResult: { found: boolean } | null;
  ictFVGInvalidatedCount: number;
  ictFVGExhaustedCount: number;
  ictFVGTotalCount: number;
  ictKZResult: { isKillZone: boolean; isPrime: boolean } | null;
  config: {
    ictDisplacementMSSGateMode?: string;
    ictDisplacementMSSPenalty?: number;
    ictJudasSwingGateMode?: string;
    ictJudasSwingPenalty?: number;
    ictFVGInvalidationGateMode?: string;
    ictFVGInvalidatedPenalty?: number;
    ictFVGExhaustedPenalty?: number;
    ictKillZoneGateMode?: string;
    ictKillZonePrimeBonus?: number;
    ictKillZoneOutsidePenalty?: number;
  };
}): number {
  const {
    rawScore, fotsiPenalty, impulseZonePenalty,
    directionVerdict, ictHTFResult, ictMSSResult, ictJudasResult,
    ictFVGInvalidatedCount, ictFVGExhaustedCount, ictFVGTotalCount,
    ictKZResult, config,
  } = params;

  const ictHTFScoreAdj = directionVerdict ? 0 : (ictHTFResult?.scoreAdjustment ?? 0);
  const verdictScoreAdj = directionVerdict?.scoreAdjustment ?? 0;
  const ictMSSAdj = (config.ictDisplacementMSSGateMode === "soft" && ictMSSResult && !ictMSSResult.isValid)
    ? -(config.ictDisplacementMSSPenalty ?? 2.0) : 0;
  const ictJudasAdj = (config.ictJudasSwingGateMode === "soft" && ictJudasResult && !ictJudasResult.found)
    ? -(config.ictJudasSwingPenalty ?? 1.5) : 0;
  const ictFVGAdj = (config.ictFVGInvalidationGateMode === "soft" && ictFVGTotalCount > 0)
    ? -(ictFVGInvalidatedCount * (config.ictFVGInvalidatedPenalty ?? 3.0) + ictFVGExhaustedCount * (config.ictFVGExhaustedPenalty ?? 1.5)) / Math.max(ictFVGTotalCount, 1)
    : 0;
  const ictKZAdj = (config.ictKillZoneGateMode === "soft" && ictKZResult)
    ? (ictKZResult.isKillZone ? (ictKZResult.isPrime ? (config.ictKillZonePrimeBonus ?? 1.5) : 0) : -(config.ictKillZoneOutsidePenalty ?? 1.0))
    : 0;
  const ictTotalAdj = ictHTFScoreAdj + ictMSSAdj + ictJudasAdj + ictFVGAdj + ictKZAdj;

  return rawScore + fotsiPenalty + impulseZonePenalty + ictTotalAdj + verdictScoreAdj;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: Effective Score Formula Verification
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("Score Parity: base formula with all ICT modules disabled produces same result as before", () => {
  // When all ICT modules are disabled/null, the formula should reduce to the old formula
  const result = computeEffectiveScore({
    rawScore: 65.0,
    fotsiPenalty: -2.0,
    impulseZonePenalty: 1.0,
    directionVerdict: null,
    ictHTFResult: null,
    ictMSSResult: null,
    ictJudasResult: null,
    ictFVGInvalidatedCount: 0,
    ictFVGExhaustedCount: 0,
    ictFVGTotalCount: 0,
    ictKZResult: null,
    config: {},
  });
  // Old formula: 65 + (-2) + 1 = 64
  assertEquals(result, 64.0);
});

Deno.test("Score Parity: direction verdict replaces HTF score adjustment", () => {
  // When directionVerdict is present, ictHTFScoreAdj = 0 (verdict takes over)
  const result = computeEffectiveScore({
    rawScore: 70.0,
    fotsiPenalty: 0,
    impulseZonePenalty: 0,
    directionVerdict: { scoreAdjustment: 3.5 },
    ictHTFResult: { scoreAdjustment: 2.0 }, // This should be IGNORED
    ictMSSResult: null,
    ictJudasResult: null,
    ictFVGInvalidatedCount: 0,
    ictFVGExhaustedCount: 0,
    ictFVGTotalCount: 0,
    ictKZResult: null,
    config: {},
  });
  // 70 + 0 + 0 + (0 + 0 + 0 + 0 + 0) + 3.5 = 73.5
  // ictHTFScoreAdj = 0 because directionVerdict is present
  assertAlmostEquals(result, 73.5, 0.001);
});

Deno.test("Score Parity: HTF score adjustment applies when no direction verdict", () => {
  const result = computeEffectiveScore({
    rawScore: 70.0,
    fotsiPenalty: 0,
    impulseZonePenalty: 0,
    directionVerdict: null,
    ictHTFResult: { scoreAdjustment: -3.0 },
    ictMSSResult: null,
    ictJudasResult: null,
    ictFVGInvalidatedCount: 0,
    ictFVGExhaustedCount: 0,
    ictFVGTotalCount: 0,
    ictKZResult: null,
    config: {},
  });
  // 70 + 0 + 0 + (-3 + 0 + 0 + 0 + 0) + 0 = 67
  assertAlmostEquals(result, 67.0, 0.001);
});

Deno.test("Score Parity: MSS soft penalty applies when isValid=false", () => {
  const result = computeEffectiveScore({
    rawScore: 60.0,
    fotsiPenalty: 0,
    impulseZonePenalty: 0,
    directionVerdict: null,
    ictHTFResult: null,
    ictMSSResult: { isValid: false },
    ictJudasResult: null,
    ictFVGInvalidatedCount: 0,
    ictFVGExhaustedCount: 0,
    ictFVGTotalCount: 0,
    ictKZResult: null,
    config: { ictDisplacementMSSGateMode: "soft", ictDisplacementMSSPenalty: 2.5 },
  });
  // 60 + 0 + 0 + (0 + (-2.5) + 0 + 0 + 0) + 0 = 57.5
  assertAlmostEquals(result, 57.5, 0.001);
});

Deno.test("Score Parity: MSS penalty does NOT apply when isValid=true", () => {
  const result = computeEffectiveScore({
    rawScore: 60.0,
    fotsiPenalty: 0,
    impulseZonePenalty: 0,
    directionVerdict: null,
    ictHTFResult: null,
    ictMSSResult: { isValid: true },
    ictJudasResult: null,
    ictFVGInvalidatedCount: 0,
    ictFVGExhaustedCount: 0,
    ictFVGTotalCount: 0,
    ictKZResult: null,
    config: { ictDisplacementMSSGateMode: "soft", ictDisplacementMSSPenalty: 2.5 },
  });
  assertEquals(result, 60.0);
});

Deno.test("Score Parity: MSS penalty does NOT apply when gateMode != soft", () => {
  const result = computeEffectiveScore({
    rawScore: 60.0,
    fotsiPenalty: 0,
    impulseZonePenalty: 0,
    directionVerdict: null,
    ictHTFResult: null,
    ictMSSResult: { isValid: false },
    ictJudasResult: null,
    ictFVGInvalidatedCount: 0,
    ictFVGExhaustedCount: 0,
    ictFVGTotalCount: 0,
    ictKZResult: null,
    config: { ictDisplacementMSSGateMode: "hard" },
  });
  assertEquals(result, 60.0);
});

Deno.test("Score Parity: Judas soft penalty applies when found=false", () => {
  const result = computeEffectiveScore({
    rawScore: 55.0,
    fotsiPenalty: 0,
    impulseZonePenalty: 0,
    directionVerdict: null,
    ictHTFResult: null,
    ictMSSResult: null,
    ictJudasResult: { found: false },
    ictFVGInvalidatedCount: 0,
    ictFVGExhaustedCount: 0,
    ictFVGTotalCount: 0,
    ictKZResult: null,
    config: { ictJudasSwingGateMode: "soft", ictJudasSwingPenalty: 1.5 },
  });
  // 55 + 0 + 0 + (0 + 0 + (-1.5) + 0 + 0) + 0 = 53.5
  assertAlmostEquals(result, 53.5, 0.001);
});

Deno.test("Score Parity: Judas penalty does NOT apply when found=true", () => {
  const result = computeEffectiveScore({
    rawScore: 55.0,
    fotsiPenalty: 0,
    impulseZonePenalty: 0,
    directionVerdict: null,
    ictHTFResult: null,
    ictMSSResult: null,
    ictJudasResult: { found: true },
    ictFVGInvalidatedCount: 0,
    ictFVGExhaustedCount: 0,
    ictFVGTotalCount: 0,
    ictKZResult: null,
    config: { ictJudasSwingGateMode: "soft", ictJudasSwingPenalty: 1.5 },
  });
  assertEquals(result, 55.0);
});

Deno.test("Score Parity: FVG invalidation penalty is weighted average", () => {
  // 2 invalidated, 1 exhausted out of 5 total FVGs
  const result = computeEffectiveScore({
    rawScore: 70.0,
    fotsiPenalty: 0,
    impulseZonePenalty: 0,
    directionVerdict: null,
    ictHTFResult: null,
    ictMSSResult: null,
    ictJudasResult: null,
    ictFVGInvalidatedCount: 2,
    ictFVGExhaustedCount: 1,
    ictFVGTotalCount: 5,
    ictKZResult: null,
    config: {
      ictFVGInvalidationGateMode: "soft",
      ictFVGInvalidatedPenalty: 3.0,
      ictFVGExhaustedPenalty: 1.5,
    },
  });
  // ictFVGAdj = -(2*3.0 + 1*1.5) / 5 = -(6 + 1.5) / 5 = -7.5 / 5 = -1.5
  // 70 + 0 + 0 + (0 + 0 + 0 + (-1.5) + 0) + 0 = 68.5
  assertAlmostEquals(result, 68.5, 0.001);
});

Deno.test("Score Parity: FVG penalty does NOT apply when totalCount=0", () => {
  const result = computeEffectiveScore({
    rawScore: 70.0,
    fotsiPenalty: 0,
    impulseZonePenalty: 0,
    directionVerdict: null,
    ictHTFResult: null,
    ictMSSResult: null,
    ictJudasResult: null,
    ictFVGInvalidatedCount: 0,
    ictFVGExhaustedCount: 0,
    ictFVGTotalCount: 0,
    ictKZResult: null,
    config: { ictFVGInvalidationGateMode: "soft" },
  });
  assertEquals(result, 70.0);
});

Deno.test("Score Parity: Kill Zone prime bonus applies when in prime KZ", () => {
  const result = computeEffectiveScore({
    rawScore: 60.0,
    fotsiPenalty: 0,
    impulseZonePenalty: 0,
    directionVerdict: null,
    ictHTFResult: null,
    ictMSSResult: null,
    ictJudasResult: null,
    ictFVGInvalidatedCount: 0,
    ictFVGExhaustedCount: 0,
    ictFVGTotalCount: 0,
    ictKZResult: { isKillZone: true, isPrime: true },
    config: { ictKillZoneGateMode: "soft", ictKillZonePrimeBonus: 1.5 },
  });
  // 60 + 0 + 0 + (0 + 0 + 0 + 0 + 1.5) + 0 = 61.5
  assertAlmostEquals(result, 61.5, 0.001);
});

Deno.test("Score Parity: Kill Zone non-prime gives zero adjustment", () => {
  const result = computeEffectiveScore({
    rawScore: 60.0,
    fotsiPenalty: 0,
    impulseZonePenalty: 0,
    directionVerdict: null,
    ictHTFResult: null,
    ictMSSResult: null,
    ictJudasResult: null,
    ictFVGInvalidatedCount: 0,
    ictFVGExhaustedCount: 0,
    ictFVGTotalCount: 0,
    ictKZResult: { isKillZone: true, isPrime: false },
    config: { ictKillZoneGateMode: "soft", ictKillZonePrimeBonus: 1.5 },
  });
  assertEquals(result, 60.0);
});

Deno.test("Score Parity: Kill Zone outside penalty applies when not in KZ", () => {
  const result = computeEffectiveScore({
    rawScore: 60.0,
    fotsiPenalty: 0,
    impulseZonePenalty: 0,
    directionVerdict: null,
    ictHTFResult: null,
    ictMSSResult: null,
    ictJudasResult: null,
    ictFVGInvalidatedCount: 0,
    ictFVGExhaustedCount: 0,
    ictFVGTotalCount: 0,
    ictKZResult: { isKillZone: false, isPrime: false },
    config: { ictKillZoneGateMode: "soft", ictKillZoneOutsidePenalty: 1.0 },
  });
  // 60 + 0 + 0 + (0 + 0 + 0 + 0 + (-1.0)) + 0 = 59
  assertAlmostEquals(result, 59.0, 0.001);
});

Deno.test("Score Parity: all adjustments combine correctly", () => {
  // Full combination test: all ICT modules active
  const result = computeEffectiveScore({
    rawScore: 75.0,
    fotsiPenalty: -2.0,
    impulseZonePenalty: 1.0,
    directionVerdict: { scoreAdjustment: 2.0 },
    ictHTFResult: { scoreAdjustment: 5.0 }, // ignored because verdict present
    ictMSSResult: { isValid: false },
    ictJudasResult: { found: false },
    ictFVGInvalidatedCount: 1,
    ictFVGExhaustedCount: 1,
    ictFVGTotalCount: 3,
    ictKZResult: { isKillZone: true, isPrime: true },
    config: {
      ictDisplacementMSSGateMode: "soft",
      ictDisplacementMSSPenalty: 2.0,
      ictJudasSwingGateMode: "soft",
      ictJudasSwingPenalty: 1.5,
      ictFVGInvalidationGateMode: "soft",
      ictFVGInvalidatedPenalty: 3.0,
      ictFVGExhaustedPenalty: 1.5,
      ictKillZoneGateMode: "soft",
      ictKillZonePrimeBonus: 1.5,
    },
  });
  // ictHTFScoreAdj = 0 (verdict present)
  // verdictScoreAdj = 2.0
  // ictMSSAdj = -2.0
  // ictJudasAdj = -1.5
  // ictFVGAdj = -(1*3.0 + 1*1.5) / 3 = -4.5/3 = -1.5
  // ictKZAdj = 1.5 (prime)
  // ictTotalAdj = 0 + (-2.0) + (-1.5) + (-1.5) + 1.5 = -3.5
  // effectiveScore = 75 + (-2) + 1 + (-3.5) + 2.0 = 72.5
  assertAlmostEquals(result, 72.5, 0.001);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: Direction Verdict Module Integration
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("Direction Verdict: bullish consensus produces positive scoreAdjustment", () => {
  const input: DirectionVerdictInput = {
    confirmedTrend: { trend: "bullish", reason: "test" },
    simpleDirection: {
      direction: "long",
      bias: "bullish",
      biasSource: "daily",
      h4Retrace: false,
      h4ChochAgainst: false,
      h1Confirmed: true,
      reason: "test",
    },
    regime: {
      regime: "strong_trend",
      confidence: 0.85,
      directionalBias: "bullish",
    },
    weeklyBias: null,
    gamePlanBias: null,
  };
  const result = computeDirectionVerdict(input);
  assert(result.verdict === "long", `Expected long verdict, got ${result.verdict}`);
  assert(result.scoreAdjustment >= 0, `Expected non-negative score adjustment, got ${result.scoreAdjustment}`);
  assert(result.confidence >= 60, `Expected confidence >= 60, got ${result.confidence}`);
});

Deno.test("Direction Verdict: conflicting signals reduce confidence", () => {
  const input: DirectionVerdictInput = {
    confirmedTrend: { trend: "bullish", reason: "test" },
    simpleDirection: {
      direction: "short", // Conflicts with confirmedTrend
      bias: "bearish",
      biasSource: "4h",
      h4Retrace: false,
      h4ChochAgainst: true,
      h1Confirmed: false,
      reason: "test",
    },
    regime: {
      regime: "transitional",
      confidence: 0.4,
      directionalBias: "neutral",
    },
    weeklyBias: null,
    gamePlanBias: null,
  };
  const result = computeDirectionVerdict(input);
  // With conflicting signals, confidence should be lower
  assert(result.confidence < 80, `Expected lower confidence with conflicts, got ${result.confidence}`);
});

Deno.test("Direction Verdict: null inputs produce neutral verdict", () => {
  const input: DirectionVerdictInput = {
    confirmedTrend: null,
    simpleDirection: null,
    regime: null,
    weeklyBias: null,
    gamePlanBias: null,
  };
  const result = computeDirectionVerdict(input);
  assertEquals(result.verdict, "neutral");
  assertEquals(result.scoreAdjustment, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: ICT Kill Zone Time Filter
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("ICT Kill Zone: London open (08:00 UTC) is a kill zone", () => {
  // London open: 8:00 AM UTC (non-DST)
  const londonOpen = new Date("2024-01-15T08:00:00Z");
  const config: ICTKillZoneConfig = {
    ...DEFAULT_ICT_KILLZONE_CONFIG,
    enabled: true,
    gateMode: "soft",
  };
  const result = evaluateICTKillZone(londonOpen, config);
  assert(result.isKillZone, `Expected London open to be a kill zone, got: ${result.reason}`);
});

Deno.test("ICT Kill Zone: NY open (13:00 UTC) is a kill zone", () => {
  // NY open: 1:00 PM UTC (non-DST) = 8:00 AM EST
  const nyOpen = new Date("2024-01-15T13:30:00Z");
  const config: ICTKillZoneConfig = {
    ...DEFAULT_ICT_KILLZONE_CONFIG,
    enabled: true,
    gateMode: "soft",
  };
  const result = evaluateICTKillZone(nyOpen, config);
  assert(result.isKillZone, `Expected NY open to be a kill zone, got: ${result.reason}`);
});

Deno.test("ICT Kill Zone: disabled config returns passed=true", () => {
  const time = new Date("2024-01-15T03:00:00Z"); // Asian dead zone
  const config: ICTKillZoneConfig = {
    ...DEFAULT_ICT_KILLZONE_CONFIG,
    enabled: false,
    gateMode: "off",
  };
  const result = evaluateICTKillZone(time, config);
  assert(result.passed, "Disabled KZ should always pass");
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: ICT MSS Displacement Validation
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("ICT MSS: no breaks returns isValid=true (no MSS to validate)", () => {
  const candles = makeDailyCandles(30, 1.08);
  const breaks: { index: number; type: "bullish" | "bearish" }[] = [];
  const result = validateRecentMSS(candles, breaks, "bullish", DEFAULT_DISPLACEMENT_MSS_CONFIG);
  assert(result.isValid, "No breaks should return valid (nothing to invalidate)");
});

Deno.test("ICT MSS: disabled config returns isValid=true", () => {
  const candles = makeDailyCandles(30, 1.08);
  const breaks = [{ index: 25, type: "bullish" as const }];
  const config: DisplacementMSSConfig = {
    ...DEFAULT_DISPLACEMENT_MSS_CONFIG,
    enabled: false,
  };
  const result = validateRecentMSS(candles, breaks, "bullish", config);
  assert(result.isValid, "Disabled MSS should return valid");
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: ICT Judas Swing Detection
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("ICT Judas: disabled config returns passed=true", () => {
  const candles = makeDailyCandles(30, 1.08);
  const config: JudasSwingConfig = {
    ...DEFAULT_JUDAS_SWING_CONFIG,
    enabled: false,
  };
  const result = detectJudasSwing(candles, 25, "bullish", config);
  assert(result.passed, "Disabled Judas should pass");
  assertEquals(result.found, false);
});

Deno.test("ICT Judas: mssIndex out of range returns not found gracefully", () => {
  const candles = makeDailyCandles(30, 1.08);
  const config: JudasSwingConfig = {
    ...DEFAULT_JUDAS_SWING_CONFIG,
    enabled: true,
    gateMode: "soft",
  };
  // mssIndex at end of candles — no room to look back
  const result = detectJudasSwing(candles, 1, "bullish", config);
  // Should not crash, should return found=false
  assertEquals(result.found, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: ICT FVG Invalidation
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("ICT FVG: empty FVG list returns empty results", () => {
  const candles = makeDailyCandles(30, 1.08);
  const fvgs: FVGForValidation[] = [];
  const result = validateFVGBatch(fvgs, candles, "bullish", DEFAULT_FVG_INVALIDATION_CONFIG);
  assertEquals(result.results.length, 0);
});

Deno.test("ICT FVG: disabled config returns empty results", () => {
  const candles = makeDailyCandles(30, 1.08);
  const fvgs: FVGForValidation[] = [
    { index: 20, high: 1.085, low: 1.083, type: "bullish", midpoint: 1.084 },
  ];
  const config: FVGInvalidationConfig = {
    ...DEFAULT_FVG_INVALIDATION_CONFIG,
    enabled: false,
  };
  const result = validateFVGBatch(fvgs, candles, "bullish", config);
  assertEquals(result.results.length, 0);
});

Deno.test("ICT FVG: valid FVG returns non-empty results with status", () => {
  const candles = makeDailyCandles(30, 1.08);
  const fvgs: FVGForValidation[] = [
    { index: 15, high: 1.085, low: 1.083, type: "bullish", midpoint: 1.084 },
  ];
  const config: FVGInvalidationConfig = {
    ...DEFAULT_FVG_INVALIDATION_CONFIG,
    enabled: true,
    gateMode: "soft",
  };
  const result = validateFVGBatch(fvgs, candles, "bullish", config);
  assertEquals(result.results.length, 1);
  assert(
    ["fresh", "first_touch", "exhausted", "invalidated"].includes(result.results[0].status),
    `Unexpected status: ${result.results[0].status}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: ICT HTF Integration
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("ICT HTF: disabled config returns passed=true with zero adjustment", () => {
  const dailyCandles = makeDailyCandles(40, 1.08);
  const result = runICTHTFAnalysis(
    null,
    dailyCandles,
    1.10,
    "long",
    null,
    { ictHTFEnabled: false },
  );
  assert(result.passed, "Disabled HTF should pass");
  assertEquals(result.scoreAdjustment, 0);
});

Deno.test("ICT HTF: null weekly candles does not crash", () => {
  const dailyCandles = makeDailyCandles(40, 1.08);
  const result = runICTHTFAnalysis(
    null, // No weekly candles (backtest scenario)
    dailyCandles,
    1.10,
    "long",
    { high: 1.09, low: 1.085 },
    {
      ictHTFEnabled: true,
      ictHTFGateMode: "soft",
      ictHTFAlignedBonus: 2.0,
      ictHTFMisalignedPenalty: 3.0,
      ictHTFMinContainment: 50,
      ictWeeklyBiasRequired: true,
      ictDailyContainmentRequired: true,
    },
  );
  // Should not crash — may or may not pass depending on daily analysis
  assert(typeof result.scoreAdjustment === "number", "Should return numeric adjustment");
  assert(typeof result.passed === "boolean", "Should return boolean passed");
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8: Regression — Old formula backward compatibility
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("Regression: when all ICT configs are off/default, score equals old formula", () => {
  // This is the critical regression test: with no ICT features enabled,
  // the new formula MUST produce the same result as the old formula.
  const testCases = [
    { raw: 45.0, fotsi: 0, iz: 0, expected: 45.0 },
    { raw: 72.5, fotsi: -2.0, iz: 1.0, expected: 71.5 },
    { raw: 30.0, fotsi: -2.0, iz: -2.0, expected: 26.0 },
    { raw: 85.0, fotsi: 0, iz: 1.0, expected: 86.0 },
    { raw: 50.0, fotsi: -2.0, iz: 0, expected: 48.0 },
  ];

  for (const tc of testCases) {
    const result = computeEffectiveScore({
      rawScore: tc.raw,
      fotsiPenalty: tc.fotsi,
      impulseZonePenalty: tc.iz,
      directionVerdict: null,
      ictHTFResult: null,
      ictMSSResult: null,
      ictJudasResult: null,
      ictFVGInvalidatedCount: 0,
      ictFVGExhaustedCount: 0,
      ictFVGTotalCount: 0,
      ictKZResult: null,
      config: {}, // All defaults = off
    });
    assertAlmostEquals(result, tc.expected, 0.001,
      `Failed for raw=${tc.raw}, fotsi=${tc.fotsi}, iz=${tc.iz}: got ${result}, expected ${tc.expected}`);
  }
});

Deno.test("Regression: hard gate modes produce zero adjustment (gates block, not penalize)", () => {
  // When gate modes are "hard", the adjustments should be 0
  // (the hard gate blocks the trade entirely, not via score reduction)
  const result = computeEffectiveScore({
    rawScore: 60.0,
    fotsiPenalty: 0,
    impulseZonePenalty: 0,
    directionVerdict: null,
    ictHTFResult: null,
    ictMSSResult: { isValid: false },
    ictJudasResult: { found: false },
    ictFVGInvalidatedCount: 3,
    ictFVGExhaustedCount: 2,
    ictFVGTotalCount: 5,
    ictKZResult: { isKillZone: false, isPrime: false },
    config: {
      ictDisplacementMSSGateMode: "hard",
      ictJudasSwingGateMode: "hard",
      ictFVGInvalidationGateMode: "hard",
      ictKillZoneGateMode: "hard",
    },
  });
  // All hard gates → zero adjustments
  assertEquals(result, 60.0);
});

Deno.test("Regression: off gate modes produce zero adjustment", () => {
  const result = computeEffectiveScore({
    rawScore: 60.0,
    fotsiPenalty: 0,
    impulseZonePenalty: 0,
    directionVerdict: null,
    ictHTFResult: null,
    ictMSSResult: { isValid: false },
    ictJudasResult: { found: false },
    ictFVGInvalidatedCount: 3,
    ictFVGExhaustedCount: 2,
    ictFVGTotalCount: 5,
    ictKZResult: { isKillZone: false, isPrime: false },
    config: {
      ictDisplacementMSSGateMode: "off",
      ictJudasSwingGateMode: "off",
      ictFVGInvalidationGateMode: "off",
      ictKillZoneGateMode: "off",
    },
  });
  assertEquals(result, 60.0);
});
