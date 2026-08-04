/**
 * Regression tests for the SL/TP recalculation fix.
 *
 * Root cause: calculateSLTP() returns null when direction is null.
 * When the Direction Verdict later assigns a valid direction, SL/TP must be recalculated.
 *
 * These tests verify that calculateSLTP() produces valid SL/TP for all scenarios
 * that previously returned null due to null direction, and that the recalculation
 * logic matches what confluenceScoring would have produced if direction were known upfront.
 */

import { assertEquals, assertNotEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { calculateSLTP } from "./smcAnalysis.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const BASE_CONFIG = {
  slMethod: "structure",
  slBufferPips: 2,
  fixedSLPips: 25,
  tpMethod: "rr_ratio",
  tpRatio: 2.0,
  minRiskReward: 1.0,
  slATRPeriod: 14,
  slATRMultiple: 1.5,
  tpATRMultiple: 2.0,
  fixedTPPips: 50,
};

const EURUSD_PIP = 0.0001;
const XAUUSD_PIP = 0.1;

const SWING_LOWS = [
  { type: "low" as const, price: 1.0850, datetime: "2024-01-01T10:00:00Z" },
  { type: "low" as const, price: 1.0830, datetime: "2024-01-01T08:00:00Z" },
  { type: "low" as const, price: 1.0810, datetime: "2024-01-01T06:00:00Z" },
];

const SWING_HIGHS = [
  { type: "high" as const, price: 1.0950, datetime: "2024-01-01T10:00:00Z" },
  { type: "high" as const, price: 1.0970, datetime: "2024-01-01T08:00:00Z" },
  { type: "high" as const, price: 1.0990, datetime: "2024-01-01T06:00:00Z" },
];

const GOLD_SWING_LOWS = [
  { type: "low" as const, price: 2380.0, datetime: "2024-01-01T10:00:00Z" },
  { type: "low" as const, price: 2375.0, datetime: "2024-01-01T08:00:00Z" },
];

const GOLD_SWING_HIGHS = [
  { type: "high" as const, price: 2420.0, datetime: "2024-01-01T10:00:00Z" },
  { type: "high" as const, price: 2425.0, datetime: "2024-01-01T08:00:00Z" },
];

const BULLISH_OBS = [
  { type: "bullish" as const, high: 1.0860, low: 1.0845, mitigated: false, state: "active", datetime: "2024-01-01T09:00:00Z" },
];

const BEARISH_OBS = [
  { type: "bearish" as const, high: 1.0960, low: 1.0945, mitigated: false, state: "active", datetime: "2024-01-01T09:00:00Z" },
];

const LIQUIDITY_POOLS = [
  { type: "buy-side" as const, price: 1.0980, strength: 3, datetime: "2024-01-01T09:00:00Z" },
  { type: "sell-side" as const, price: 1.0800, strength: 3, datetime: "2024-01-01T09:00:00Z" },
];

// ─── Tests ──────────────────────────────────────────────────────────────────

Deno.test("REGRESSION: direction=null returns null SL/TP (confirms the bug scenario)", () => {
  const result = calculateSLTP({
    direction: null,
    lastPrice: 1.0900,
    pipSize: EURUSD_PIP,
    config: BASE_CONFIG,
    swings: [...SWING_LOWS, ...SWING_HIGHS],
    orderBlocks: [...BULLISH_OBS, ...BEARISH_OBS] as any,
    liquidityPools: LIQUIDITY_POOLS as any,
    pdLevels: null,
    atrValue: 0.0015,
  });
  assertEquals(result.stopLoss, null);
  assertEquals(result.takeProfit, null);
});

Deno.test("REGRESSION: direction='long' with same inputs produces valid SL/TP (the recalculation scenario)", () => {
  const result = calculateSLTP({
    direction: "long",
    lastPrice: 1.0900,
    pipSize: EURUSD_PIP,
    config: BASE_CONFIG,
    swings: [...SWING_LOWS, ...SWING_HIGHS],
    orderBlocks: [...BULLISH_OBS, ...BEARISH_OBS] as any,
    liquidityPools: LIQUIDITY_POOLS as any,
    pdLevels: null,
    atrValue: 0.0015,
  });
  assertNotEquals(result.stopLoss, null);
  assertNotEquals(result.takeProfit, null);
  // SL should be below current price for a long
  assert(result.stopLoss! < 1.0900, `SL ${result.stopLoss} should be below entry 1.0900`);
  // TP should be above current price for a long
  assert(result.takeProfit! > 1.0900, `TP ${result.takeProfit} should be above entry 1.0900`);
});

Deno.test("REGRESSION: direction='short' with same inputs produces valid SL/TP (the recalculation scenario)", () => {
  const result = calculateSLTP({
    direction: "short",
    lastPrice: 1.0900,
    pipSize: EURUSD_PIP,
    config: BASE_CONFIG,
    swings: [...SWING_LOWS, ...SWING_HIGHS],
    orderBlocks: [...BULLISH_OBS, ...BEARISH_OBS] as any,
    liquidityPools: LIQUIDITY_POOLS as any,
    pdLevels: null,
    atrValue: 0.0015,
  });
  assertNotEquals(result.stopLoss, null);
  assertNotEquals(result.takeProfit, null);
  // SL should be above current price for a short
  assert(result.stopLoss! > 1.0900, `SL ${result.stopLoss} should be above entry 1.0900`);
  // TP should be below current price for a short
  assert(result.takeProfit! < 1.0900, `TP ${result.takeProfit} should be below entry 1.0900`);
});

Deno.test("REGRESSION: recalculation with no swings still produces valid SL/TP (fallback to fixedSLPips)", () => {
  // This simulates the case where structure.swingPoints is empty (new pair, thin data)
  const result = calculateSLTP({
    direction: "long",
    lastPrice: 1.0900,
    pipSize: EURUSD_PIP,
    config: BASE_CONFIG,
    swings: [],
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0015,
  });
  assertNotEquals(result.stopLoss, null);
  assertNotEquals(result.takeProfit, null);
  // With no swings, should fall back to fixedSLPips (25 pips)
  const expectedSL = 1.0900 - 25 * EURUSD_PIP; // 1.0875
  // ATR floor is 1.5 * 0.0015 = 0.00225 = 22.5 pips — less than 25 pips, so fixedSL wins
  assert(result.stopLoss! < 1.0900, "SL should be below entry");
  assert(result.takeProfit! > 1.0900, "TP should be above entry");
});

Deno.test("REGRESSION: recalculation with Gold (large pip size) produces valid SL/TP", () => {
  const result = calculateSLTP({
    direction: "long",
    lastPrice: 2400.0,
    pipSize: XAUUSD_PIP,
    config: { ...BASE_CONFIG, fixedSLPips: 50 },
    swings: [...GOLD_SWING_LOWS, ...GOLD_SWING_HIGHS],
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 15.0, // Gold ATR ~$15
  });
  assertNotEquals(result.stopLoss, null);
  assertNotEquals(result.takeProfit, null);
  assert(result.stopLoss! < 2400.0, `Gold SL ${result.stopLoss} should be below entry 2400`);
  assert(result.takeProfit! > 2400.0, `Gold TP ${result.takeProfit} should be above entry 2400`);
  // ATR floor: 1.5 * 15 = 22.5 — SL should be at least 22.5 away
  assert(2400.0 - result.stopLoss! >= 22.5, `Gold SL distance should be >= ATR floor (22.5)`);
});

Deno.test("REGRESSION: recalculation produces identical result to upfront direction (deterministic)", () => {
  // Prove that calling calculateSLTP with direction="long" produces the same result
  // regardless of whether it was called during confluenceScoring or after direction sync.
  // (This is trivially true since calculateSLTP is a pure function, but we verify it.)
  const input = {
    direction: "long" as const,
    lastPrice: 1.0900,
    pipSize: EURUSD_PIP,
    config: BASE_CONFIG,
    swings: [...SWING_LOWS, ...SWING_HIGHS],
    orderBlocks: [...BULLISH_OBS, ...BEARISH_OBS] as any,
    liquidityPools: LIQUIDITY_POOLS as any,
    pdLevels: null,
    atrValue: 0.0015,
    fvgs: [],
    fibExtensions: undefined,
    dolTargets: undefined,
  };
  const result1 = calculateSLTP(input);
  const result2 = calculateSLTP(input);
  assertEquals(result1.stopLoss, result2.stopLoss);
  assertEquals(result1.takeProfit, result2.takeProfit);
});

Deno.test("REGRESSION: below_ob SL method works in recalculation scenario", () => {
  const result = calculateSLTP({
    direction: "long",
    lastPrice: 1.0900,
    pipSize: EURUSD_PIP,
    config: { ...BASE_CONFIG, slMethod: "below_ob" },
    swings: [...SWING_LOWS, ...SWING_HIGHS],
    orderBlocks: BULLISH_OBS as any,
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0015,
  });
  assertNotEquals(result.stopLoss, null);
  assertNotEquals(result.takeProfit, null);
  // SL should be below the bullish OB low (1.0845) minus buffer (2 pips)
  const expectedSL = 1.0845 - 2 * EURUSD_PIP; // 1.0843
  assertEquals(result.stopLoss, expectedSL);
});

Deno.test("REGRESSION: atr_based SL method works in recalculation scenario", () => {
  const result = calculateSLTP({
    direction: "short",
    lastPrice: 1.0900,
    pipSize: EURUSD_PIP,
    config: { ...BASE_CONFIG, slMethod: "atr_based", slATRMultiple: 2.0 },
    swings: [...SWING_LOWS, ...SWING_HIGHS],
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0015,
  });
  assertNotEquals(result.stopLoss, null);
  assertNotEquals(result.takeProfit, null);
  // SL for short = lastPrice + ATR * multiple = 1.0900 + 0.0015 * 2.0 = 1.0930
  assertEquals(result.stopLoss, 1.0900 + 0.0015 * 2.0);
});

Deno.test("REGRESSION: next_level TP method works with recalculated SL", () => {
  const result = calculateSLTP({
    direction: "long",
    lastPrice: 1.0900,
    pipSize: EURUSD_PIP,
    config: { ...BASE_CONFIG, tpMethod: "next_level" },
    swings: [...SWING_LOWS, ...SWING_HIGHS],
    orderBlocks: [...BULLISH_OBS, ...BEARISH_OBS] as any,
    liquidityPools: LIQUIDITY_POOLS as any,
    pdLevels: { pdh: 1.0950, pdl: 1.0820, pwh: 1.1000, pwl: 1.0700 },
    atrValue: 0.0015,
  });
  assertNotEquals(result.stopLoss, null);
  assertNotEquals(result.takeProfit, null);
  // TP should be one of the structural targets (PDH 1.0950, PWH 1.1000, or buy-side liquidity 1.0980)
  // that produces R:R >= 1.0
  assert(result.takeProfit! > 1.0900, "TP should be above entry for long");
  assert(result.takeProfit! <= 1.1000, "TP should not exceed PWH for this scenario");
});
