/**
 * Regression tests for next_level TP method — R:R minimum skip logic.
 *
 * Before this fix: next_level always used targets[0] (nearest target),
 * even if it was 1 pip away with SL 14 pips away (R:R = 0.07).
 *
 * After this fix: targets producing R:R below minRiskReward are skipped.
 * Falls through to the next viable target, or rr_ratio fallback if none qualify.
 */
import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { calculateSLTP } from "./smcAnalysis.ts";

// Minimal fixtures — include all required SwingPoint fields
const baseSwings = [
  { type: "low" as const, price: 0.59300, index: 10, time: "2024-01-01T00:00:00Z", datetime: "2024-01-01T00:00:00Z", state: "active" as const, testedCount: 0 },
  { type: "high" as const, price: 0.59700, index: 20, time: "2024-01-01T04:00:00Z", datetime: "2024-01-01T04:00:00Z", state: "active" as const, testedCount: 0 },
];

// Include all required LiquidityPool fields
const baseLiquidityPools = [
  { type: "sell-side" as const, price: 0.59540, strength: 3, datetime: "2024-01-01T01:00:00Z", swept: false, state: "active" as const },
  { type: "sell-side" as const, price: 0.59400, strength: 4, datetime: "2024-01-01T02:00:00Z", swept: false, state: "active" as const },
  { type: "sell-side" as const, price: 0.59200, strength: 5, datetime: "2024-01-01T03:00:00Z", swept: false, state: "active" as const },
];

const basePdLevels = {
  pdh: 0.59700,
  pdl: 0.59543,  // Very close to entry — this is the "too close" target
  pwh: 0.59800,
  pwl: 0.59100,
};

Deno.test("next_level TP: skips nearest target when R:R < minRiskReward", () => {
  // Scenario: Short entry at 0.59550, SL at 0.59700 (15 pips risk)
  // PDL at 0.59543 = only 0.7 pips reward → R:R = 0.047 (way below 1.0)
  // Next target: sell-side pool at 0.59400 = 15 pips reward → R:R = 1.0 ✓
  const result = calculateSLTP({
    direction: "short",
    lastPrice: 0.59550,
    pipSize: 0.0001,
    config: {
      slMethod: "fixed_pips",
      fixedSLPips: 15,
      slBufferPips: 0,
      tpMethod: "next_level",
      minRiskReward: 1.0,
      tpRatio: 2.0,
    },
    swings: baseSwings,
    orderBlocks: [],
    liquidityPools: baseLiquidityPools,
    pdLevels: basePdLevels,
    atrValue: 0.00100, // 10 pips ATR
  });

  // Should skip PDL (0.59543) and use the sell-side pool at 0.59400
  assertEquals(result.takeProfit !== null, true);
  // TP should be at 0.59400 (the first viable target with R:R >= 1.0)
  assertAlmostEquals(result.takeProfit!, 0.59400, 0.00005);
});

Deno.test("next_level TP: uses nearest target when R:R is adequate", () => {
  // Scenario: Short entry at 0.59700, SL at 0.59750 (5 pips risk)
  // PDL at 0.59543 = 15.7 pips reward → R:R = 3.14 ✓ (well above 1.0)
  const result = calculateSLTP({
    direction: "short",
    lastPrice: 0.59700,
    pipSize: 0.0001,
    config: {
      slMethod: "fixed_pips",
      fixedSLPips: 5,
      slBufferPips: 0,
      tpMethod: "next_level",
      minRiskReward: 1.0,
      tpRatio: 2.0,
    },
    swings: baseSwings,
    orderBlocks: [],
    liquidityPools: baseLiquidityPools,
    pdLevels: basePdLevels,
    atrValue: 0.00100,
  });

  // Should use PDL (0.59543) since R:R is fine
  assertEquals(result.takeProfit !== null, true);
  assertAlmostEquals(result.takeProfit!, 0.59543, 0.00005);
});

Deno.test("next_level TP: falls back to rr_ratio when ALL targets produce sub-minimum R:R", () => {
  // Scenario: Short entry at 0.59550, SL at 0.59700 (15 pips risk)
  // All targets are within 2 pips of entry — none produce R:R >= 1.5
  const closeTargets = {
    pdh: 0.59700,
    pdl: 0.59543,  // 0.7 pips → R:R = 0.047
    pwh: 0.59800,
    pwl: 0.59530,  // 2 pips → R:R = 0.13
  };
  const closePools = [
    { type: "sell-side" as const, price: 0.59545, strength: 3, datetime: "2024-01-01T01:00:00Z", swept: false, state: "active" as const },
    { type: "sell-side" as const, price: 0.59535, strength: 4, datetime: "2024-01-01T02:00:00Z", swept: false, state: "active" as const },
  ];

  const result = calculateSLTP({
    direction: "short",
    lastPrice: 0.59550,
    pipSize: 0.0001,
    config: {
      slMethod: "fixed_pips",
      fixedSLPips: 15,
      slBufferPips: 0,
      tpMethod: "next_level",
      minRiskReward: 1.5,
      tpRatio: 2.0,
    },
    swings: baseSwings,
    orderBlocks: [],
    liquidityPools: closePools,
    pdLevels: closeTargets,
    atrValue: 0.00100,
  });

  // Should fall back to rr_ratio: TP = entry - (SL distance × tpRatio)
  // SL distance = 15 pips = 0.00150, tpRatio = 2.0
  // TP = 0.59550 - 0.00300 = 0.59250
  assertEquals(result.takeProfit !== null, true);
  assertAlmostEquals(result.takeProfit!, 0.59250, 0.00010);
});

Deno.test("next_level TP: long direction skips close targets correctly", () => {
  // Scenario: Long entry at 0.59680, SL fixed at 10 pips but ATR floor = 1.5 × 10 pips = 15 pips
  // Effective SL distance = 15 pips (ATR floor wins)
  // PDH at 0.59700: reward = 2 pips → R:R = 2/15 = 0.13 → skip
  // Pool at 0.59710: reward = 3 pips → R:R = 3/15 = 0.20 → skip
  // PWH at 0.59800: reward = 12 pips → R:R = 12/15 = 0.80 → skip
  // Pool at 0.59900: reward = 22 pips → R:R = 22/15 = 1.47 → ✓ use this
  const result = calculateSLTP({
    direction: "long",
    lastPrice: 0.59680,
    pipSize: 0.0001,
    config: {
      slMethod: "fixed_pips",
      fixedSLPips: 10,
      slBufferPips: 0,
      tpMethod: "next_level",
      minRiskReward: 1.0,
      tpRatio: 2.0,
    },
    swings: baseSwings,
    orderBlocks: [],
    liquidityPools: [
      { type: "buy-side" as const, price: 0.59710, strength: 3, datetime: "2024-01-01T01:00:00Z", swept: false, state: "active" as const },
      { type: "buy-side" as const, price: 0.59900, strength: 5, datetime: "2024-01-01T02:00:00Z", swept: false, state: "active" as const },
    ],
    pdLevels: { pdh: 0.59700, pdl: 0.59400, pwh: 0.59800, pwl: 0.59100 },
    atrValue: 0.00100, // ATR floor = 1.5 × 0.00100 = 0.00150 (15 pips)
  });

  // ATR floor pushes SL to 15 pips, so PWH (R:R=0.8) is also skipped
  // First viable target is buy-side pool at 0.59900 (R:R=1.47)
  assertEquals(result.takeProfit !== null, true);
  assertAlmostEquals(result.takeProfit!, 0.59900, 0.00005);
});

Deno.test("next_level TP: respects higher minRiskReward config", () => {
  // With minRiskReward = 2.0, even targets with R:R 1.0-1.9 are skipped
  const result = calculateSLTP({
    direction: "short",
    lastPrice: 0.59550,
    pipSize: 0.0001,
    config: {
      slMethod: "fixed_pips",
      fixedSLPips: 15,
      slBufferPips: 0,
      tpMethod: "next_level",
      minRiskReward: 2.0,
      tpRatio: 2.0,
    },
    swings: baseSwings,
    orderBlocks: [],
    liquidityPools: baseLiquidityPools,
    pdLevels: basePdLevels,
    atrValue: 0.00100,
  });

  // PDL at 0.59543: reward = 0.7 pips, R:R = 0.047 → skip
  // Pool at 0.59400: reward = 15 pips, R:R = 1.0 → skip (below 2.0)
  // Pool at 0.59200: reward = 35 pips, R:R = 2.33 → ✓ use this
  assertEquals(result.takeProfit !== null, true);
  assertAlmostEquals(result.takeProfit!, 0.59200, 0.00005);
});
