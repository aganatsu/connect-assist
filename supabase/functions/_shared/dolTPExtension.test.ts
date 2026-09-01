/**
 * DOL Target → TP Extension — Phase 4 Tests
 *
 * Verifies that:
 * 1. When no DOL targets provided, TP is unchanged (no regression)
 * 2. When DOL target is in correct direction and beyond TP, TP extends to DOL
 * 3. When DOL target is in wrong direction, TP is unchanged
 * 4. When DOL target is closer than current TP, TP is unchanged (never shortens)
 * 5. When DOL target exceeds 4× SL cap, TP is unchanged
 * 6. When DOL strength < 2, TP is unchanged
 * 7. When DOL is only 5% further (< 10% threshold), TP is unchanged
 * 8. Short direction DOL works correctly
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { calculateSLTP, Candle, SwingPoint, OrderBlock, LiquidityPool } from "./smcAnalysis.ts";

// ─── Minimal fixtures for SL/TP calculation ─────────────────────────────

function makeSwings(): SwingPoint[] {
  return [
    { index: 10, price: 1.0750, type: "low", datetime: "2024-01-01T10:00:00Z", state: "active", testedCount: 0 },
    { index: 20, price: 1.0850, type: "high", datetime: "2024-01-01T20:00:00Z", state: "active", testedCount: 0 },
    { index: 30, price: 1.0780, type: "low", datetime: "2024-01-02T06:00:00Z", state: "active", testedCount: 0 },
    { index: 40, price: 1.0900, type: "high", datetime: "2024-01-02T16:00:00Z", state: "active", testedCount: 0 },
  ];
}

const baseConfig = {
  slMethod: "structure",
  tpMethod: "rr_ratio",
  tpRatio: 2.0,
  slBufferPips: 2,
  fixedSLPips: 25,
  fixedTPPips: 50,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test("DOL TP: no dolTargets → TP unchanged (no regression)", () => {
  const result = calculateSLTP({
    direction: "long",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
    // No dolTargets
  });

  const resultWithNull = calculateSLTP({
    direction: "long",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
    dolTargets: [],
  });

  assert(result.takeProfit !== null, "TP should not be null");
  assertEquals(result.takeProfit, resultWithNull.takeProfit, "Empty dolTargets should produce same TP as absent");
  assertEquals(result.stopLoss, resultWithNull.stopLoss, "SL should be identical");
});

Deno.test("DOL TP: buy-side DOL beyond TP → extends TP for long trade", () => {
  const baseResult = calculateSLTP({
    direction: "long",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
  });

  const baseTP = baseResult.takeProfit!;
  const baseSL = baseResult.stopLoss!;
  const slDistance = Math.abs(1.0820 - baseSL);

  // Place DOL target beyond TP but within 4× SL cap
  const dolPrice = baseTP + slDistance * 0.5; // 50% further than current TP
  const dolResult = calculateSLTP({
    direction: "long",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
    dolTargets: [{ price: dolPrice, type: "buy-side", strength: 3, description: "PWH buy-side liquidity" }],
  });

  assert(dolResult.takeProfit !== null, "TP should not be null");
  assert(dolResult.takeProfit! > baseTP, `DOL TP (${dolResult.takeProfit}) should be > base TP (${baseTP})`);
  // TP should be exactly at the DOL price
  assertEquals(dolResult.takeProfit, dolPrice);
  // SL should be unchanged
  assertEquals(dolResult.stopLoss, baseSL);
});

Deno.test("DOL TP: sell-side DOL beyond TP → extends TP for short trade", () => {
  const baseResult = calculateSLTP({
    direction: "short",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
  });

  const baseTP = baseResult.takeProfit!;
  const baseSL = baseResult.stopLoss!;
  const slDistance = Math.abs(1.0820 - baseSL);

  // Place DOL target beyond TP (lower for shorts) but within 4× SL cap
  const dolPrice = baseTP - slDistance * 0.5;
  const dolResult = calculateSLTP({
    direction: "short",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
    dolTargets: [{ price: dolPrice, type: "sell-side", strength: 3, description: "PWL sell-side liquidity" }],
  });

  assert(dolResult.takeProfit !== null, "TP should not be null");
  assert(dolResult.takeProfit! < baseTP, `DOL TP (${dolResult.takeProfit}) should be < base TP (${baseTP}) for shorts`);
  assertEquals(dolResult.takeProfit, dolPrice);
});

Deno.test("DOL TP: wrong direction DOL → TP unchanged", () => {
  const baseResult = calculateSLTP({
    direction: "long",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
  });

  // sell-side DOL for a long trade — should be ignored
  const dolResult = calculateSLTP({
    direction: "long",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
    dolTargets: [{ price: 1.0700, type: "sell-side", strength: 5, description: "Wrong direction" }],
  });

  assertEquals(dolResult.takeProfit, baseResult.takeProfit, "Wrong direction DOL should not change TP");
});

Deno.test("DOL TP: DOL closer than current TP → TP unchanged (never shortens)", () => {
  const baseResult = calculateSLTP({
    direction: "long",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
  });

  const baseTP = baseResult.takeProfit!;
  // Place DOL between entry and TP — should not shorten
  const dolPrice = 1.0820 + (baseTP - 1.0820) * 0.5; // halfway between entry and TP
  const dolResult = calculateSLTP({
    direction: "long",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
    dolTargets: [{ price: dolPrice, type: "buy-side", strength: 5, description: "Close DOL" }],
  });

  assertEquals(dolResult.takeProfit, baseTP, "DOL closer than TP should not shorten TP");
});

Deno.test("DOL TP: DOL beyond 4× SL cap → TP unchanged", () => {
  const baseResult = calculateSLTP({
    direction: "long",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
  });

  const baseSL = baseResult.stopLoss!;
  const slDistance = Math.abs(1.0820 - baseSL);
  // Place DOL way beyond the 4× SL cap
  const dolPrice = 1.0820 + slDistance * 5.0;
  const dolResult = calculateSLTP({
    direction: "long",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
    dolTargets: [{ price: dolPrice, type: "buy-side", strength: 5, description: "Far DOL" }],
  });

  assertEquals(dolResult.takeProfit, baseResult.takeProfit, "DOL beyond 4× SL cap should not change TP");
});

Deno.test("DOL TP: DOL strength < 2 → TP unchanged", () => {
  const baseResult = calculateSLTP({
    direction: "long",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
  });

  const baseTP = baseResult.takeProfit!;
  const baseSL = baseResult.stopLoss!;
  const slDistance = Math.abs(1.0820 - baseSL);
  const dolPrice = baseTP + slDistance * 0.5;

  const dolResult = calculateSLTP({
    direction: "long",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
    dolTargets: [{ price: dolPrice, type: "buy-side", strength: 1, description: "Weak DOL" }],
  });

  assertEquals(dolResult.takeProfit, baseTP, "Weak DOL (strength < 2) should not change TP");
});

Deno.test("DOL TP: DOL only 5% further (below 10% threshold) → TP unchanged", () => {
  const baseResult = calculateSLTP({
    direction: "long",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
  });

  const baseTP = baseResult.takeProfit!;
  const tpDistance = baseTP - 1.0820;
  // Place DOL just 5% further than TP (below 10% threshold)
  const dolPrice = 1.0820 + tpDistance * 1.05;

  const dolResult = calculateSLTP({
    direction: "long",
    lastPrice: 1.0820,
    pipSize: 0.0001,
    config: baseConfig,
    swings: makeSwings(),
    orderBlocks: [],
    liquidityPools: [],
    pdLevels: null,
    atrValue: 0.0050,
    dolTargets: [{ price: dolPrice, type: "buy-side", strength: 3, description: "Barely further DOL" }],
  });

  assertEquals(dolResult.takeProfit, baseTP, "DOL only 5% further should not trigger extension");
});
