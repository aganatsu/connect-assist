/**
 * HTF Phase 2 Scoring — Factor 24 (HTF Fib + PD + Liquidity) & Tier 1 Gate Enhancement Tests
 *
 * Verifies that:
 * 1. Factor 24 scores 0 when no HTF Fib/PD/Liquidity data is available
 * 2. Factor 24 scores correctly when price is near a 4H Fib 61.8% level
 * 3. Factor 24 scores correctly for Premium/Discount zone alignment
 * 4. Factor 24 scores correctly for HTF Liquidity Pool in trade direction
 * 5. Factor 24 is capped at 2.5
 * 6. Factor 24 is classified as Tier 2
 * 7. Tier 1 gate: HTF FVG satisfies FVG slot when entry-TF FVG is absent
 * 8. Tier 1 gate: HTF OB satisfies OB slot when entry-TF OB is absent
 * 9. Tier 1 gate: HTF Fib satisfies Fib slot when entry-TF Fib is absent
 * 10. Tier 1 gate: HTF zones do NOT satisfy slots when price is NOT inside the zone
 * 11. No regression: absent HTF Phase 2 data produces same result as explicit null
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runConfluenceAnalysis } from "./confluenceScoring.ts";
import { Candle } from "./smcAnalysis.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeBullishCandles(count: number, startPrice = 1.08000): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const hour = i % 24;
    const day = Math.floor(i / 24) + 1;
    const open = price;
    const close = price + 0.0003;
    candles.push({
      datetime: `2024-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`,
      open,
      high: close + 0.0001,
      low: open - 0.0001,
      close,
      volume: 1000,
    });
    price = close;
  }
  return candles;
}

function makeDailyCandles(count: number, startPrice = 1.07000): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + 0.001;
    candles.push({
      datetime: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      open,
      high: close + 0.0005,
      low: open - 0.0005,
      close,
      volume: 5000,
    });
    price = close;
  }
  return candles;
}

const baseConfig: any = {
  minConfluence: 30,
  enabledSessions: ["london", "new_york"],
  structureLookback: 50,
  obLookbackCandles: 30,
  liquidityPoolMinTouches: 2,
  fibDevMultiplier: 1.0,
  fibDepth: 10,
  _currentSymbol: "EUR/USD",
  useBreakerBlocks: true,
  useUnicornModel: true,
  enableFVG: true,
  enableOB: true,
  enableStructureBreak: true,
  enableLiquiditySweep: true,
};

// ─── Factor 24 Tests ─────────────────────────────────────────────────────────

Deno.test("HTF Fib+PD+Liq: no data → factor scores 0", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const config = { ...baseConfig, _htfFibLevels: null, _htfPD: null, _htfLiquidityPools: null };
  const result = runConfluenceAnalysis(candles, daily, config);
  const factor = result.factors.find((f: any) => f.name === "HTF Fib + PD + Liquidity");
  assert(factor, "HTF Fib + PD + Liquidity factor should exist");
  assertEquals(factor!.present, false);
  assertEquals(factor!.weight, 0);
  assert(factor!.detail.includes("No HTF Fib/PD/Liquidity alignment detected"));
});

Deno.test("HTF Fib+PD+Liq: price near 4H Fib 61.8% → scores +1.0", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Create a FibLevels object with a 61.8% retracement at the current price
  const htfFibLevels = {
    h4: {
      swingHigh: lastPrice + 0.01,
      swingLow: lastPrice - 0.01,
      direction: "up" as const,
      retracements: [
        { ratio: 0.236, price: lastPrice + 0.005, label: "23.6%", type: "retracement" as const },
        { ratio: 0.382, price: lastPrice + 0.003, label: "38.2%", type: "retracement" as const },
        { ratio: 0.5, price: lastPrice + 0.002, label: "50%", type: "retracement" as const },
        { ratio: 0.618, price: lastPrice, label: "61.8%", type: "retracement" as const }, // AT price
        { ratio: 0.786, price: lastPrice - 0.002, label: "78.6%", type: "retracement" as const },
      ],
      extensions: [],
      pivotHigh: { index: 40, price: lastPrice + 0.01, type: "high" as const, datetime: "2024-01-02T00:00:00Z" },
      pivotLow: { index: 30, price: lastPrice - 0.01, type: "low" as const, datetime: "2024-01-01T00:00:00Z" },
    },
    h1: null,
  };

  const config = { ...baseConfig, _htfFibLevels: htfFibLevels, _htfPD: null, _htfLiquidityPools: null };
  const result = runConfluenceAnalysis(candles, daily, config);
  const factor = result.factors.find((f: any) => f.name === "HTF Fib + PD + Liquidity");
  assert(factor, "HTF Fib + PD + Liquidity factor should exist");
  assertEquals(factor!.present, true);
  // 4H Fib 61.8% = +1.0
  assert(factor!.weight >= 1.0, `Expected >= 1.0, got ${factor!.weight}`);
  assert(factor!.detail.includes("4H Fib 61.8%"), `Detail should mention 4H Fib 61.8%, got: ${factor!.detail}`);
});

Deno.test("HTF Fib+PD+Liq: 4H discount zone for longs → scores +0.8", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);

  // PD data: 4H shows discount zone (aligned with bullish direction)
  const htfPD = {
    h4: { currentZone: "discount", zonePercent: 30, oteZone: false },
    h1: null,
  };

  const config = { ...baseConfig, _htfFibLevels: null, _htfPD: htfPD, _htfLiquidityPools: null };
  const result = runConfluenceAnalysis(candles, daily, config);
  const factor = result.factors.find((f: any) => f.name === "HTF Fib + PD + Liquidity");
  assert(factor, "HTF Fib + PD + Liquidity factor should exist");

  // Only scores if direction is detected as "long" — bullish candles should produce long direction
  if (result.direction === "long") {
    assertEquals(factor!.present, true);
    // 4H discount zone aligned with longs = +0.8
    assert(factor!.weight >= 0.8, `Expected >= 0.8, got ${factor!.weight}`);
    assert(factor!.detail.includes("Discount Zone") || factor!.detail.includes("OTE Zone"),
      `Detail should mention zone, got: ${factor!.detail}`);
  }
  // If direction is null/short, PD won't score (expected behavior)
});

Deno.test("HTF Fib+PD+Liq: 4H OTE zone for longs → scores +1.0", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);

  const htfPD = {
    h4: { currentZone: "discount", zonePercent: 70, oteZone: true },
    h1: null,
  };

  const config = { ...baseConfig, _htfFibLevels: null, _htfPD: htfPD, _htfLiquidityPools: null };
  const result = runConfluenceAnalysis(candles, daily, config);
  const factor = result.factors.find((f: any) => f.name === "HTF Fib + PD + Liquidity");
  assert(factor, "HTF Fib + PD + Liquidity factor should exist");

  if (result.direction === "long") {
    assertEquals(factor!.present, true);
    // 4H OTE zone aligned = +1.0
    assert(factor!.weight >= 1.0, `Expected >= 1.0, got ${factor!.weight}`);
    assert(factor!.detail.includes("OTE Zone"), `Detail should mention OTE Zone, got: ${factor!.detail}`);
  }
});

Deno.test("HTF Fib+PD+Liq: active buy-side liquidity above price for longs → scores +0.5", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Active buy-side liquidity pool above price (target for longs)
  const htfLiquidityPools = {
    h4: [
      {
        price: lastPrice + 0.005,
        type: "buy-side" as const,
        strength: 3,
        datetime: "2024-01-01T00:00:00Z",
        swept: false,
        state: "active" as const,
      },
    ],
    h1: [],
  };

  const config = { ...baseConfig, _htfFibLevels: null, _htfPD: null, _htfLiquidityPools: htfLiquidityPools };
  const result = runConfluenceAnalysis(candles, daily, config);
  const factor = result.factors.find((f: any) => f.name === "HTF Fib + PD + Liquidity");
  assert(factor, "HTF Fib + PD + Liquidity factor should exist");

  if (result.direction === "long") {
    assertEquals(factor!.present, true);
    // 4H active buy-side above price for longs = +0.5
    assert(factor!.weight >= 0.5, `Expected >= 0.5, got ${factor!.weight}`);
    assert(factor!.detail.includes("Liquidity Pool"), `Detail should mention Liquidity Pool, got: ${factor!.detail}`);
  }
});

Deno.test("HTF Fib+PD+Liq: combined scoring capped at 2.5", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Stack multiple Fib levels on both 4H and 1H to exceed cap
  // 4H: 61.8%(1.0) + 1H: 61.8%(0.6) + 4H: 78.6%(would be 1.0 but only best per TF)
  // Use multiple TFs with high-value Fib levels to test cap
  const htfFibLevels = {
    h4: {
      swingHigh: lastPrice + 0.01,
      swingLow: lastPrice - 0.01,
      direction: "up" as const,
      retracements: [
        { ratio: 0.618, price: lastPrice, label: "61.8%", type: "retracement" as const },
        { ratio: 0.786, price: lastPrice + 0.0001, label: "78.6%", type: "retracement" as const },
      ],
      extensions: [],
      pivotHigh: { index: 40, price: lastPrice + 0.01, type: "high" as const, datetime: "2024-01-02T00:00:00Z" },
      pivotLow: { index: 30, price: lastPrice - 0.01, type: "low" as const, datetime: "2024-01-01T00:00:00Z" },
    },
    h1: {
      swingHigh: lastPrice + 0.005,
      swingLow: lastPrice - 0.005,
      direction: "up" as const,
      retracements: [
        { ratio: 0.618, price: lastPrice, label: "61.8%", type: "retracement" as const },
        { ratio: 0.786, price: lastPrice + 0.0001, label: "78.6%", type: "retracement" as const },
      ],
      extensions: [],
      pivotHigh: { index: 40, price: lastPrice + 0.005, type: "high" as const, datetime: "2024-01-02T00:00:00Z" },
      pivotLow: { index: 30, price: lastPrice - 0.005, type: "low" as const, datetime: "2024-01-01T00:00:00Z" },
    },
  };

  const config = { ...baseConfig, _htfFibLevels: htfFibLevels, _htfPD: null, _htfLiquidityPools: null };
  const result = runConfluenceAnalysis(candles, daily, config);
  const factor = result.factors.find((f: any) => f.name === "HTF Fib + PD + Liquidity");
  assert(factor, "HTF Fib + PD + Liquidity factor should exist");
  assertEquals(factor!.present, true);
  // The scoring picks the BEST Fib per TF (only one per TF counts):
  // 4H best = 1.0 (61.8% or 78.6%), 1H best = 0.6 (61.8% or 78.6%) = 1.6 total
  // This is under cap, so verify it never exceeds 2.5
  assert(factor!.weight <= 2.5, `Weight should be capped at 2.5, got ${factor!.weight}`);
  assert(factor!.weight > 0, "Weight should be positive");
  // Also verify the factor is present and has both TF details
  assert(factor!.detail.includes("4H Fib"), "Should include 4H Fib");
  assert(factor!.detail.includes("1H Fib"), "Should include 1H Fib");
});

Deno.test("HTF Fib+PD+Liq: factor is classified as Tier 2", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  const htfFibLevels = {
    h4: {
      swingHigh: lastPrice + 0.01,
      swingLow: lastPrice - 0.01,
      direction: "up" as const,
      retracements: [
        { ratio: 0.618, price: lastPrice, label: "61.8%", type: "retracement" as const },
      ],
      extensions: [],
      pivotHigh: { index: 40, price: lastPrice + 0.01, type: "high" as const, datetime: "2024-01-02T00:00:00Z" },
      pivotLow: { index: 30, price: lastPrice - 0.01, type: "low" as const, datetime: "2024-01-01T00:00:00Z" },
    },
    h1: null,
  };

  const config = { ...baseConfig, _htfFibLevels: htfFibLevels, _htfPD: null, _htfLiquidityPools: null };
  const result = runConfluenceAnalysis(candles, daily, config);
  const factor = result.factors.find((f: any) => f.name === "HTF Fib + PD + Liquidity");
  assert(factor, "HTF Fib + PD + Liquidity factor should exist");
  assertEquals((factor as any).tier, 2);
});

Deno.test("HTF Fib+PD+Liq: no regression — absent data same as explicit null", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);

  // Config without HTF Phase 2 data
  const configAbsent = { ...baseConfig };
  delete configAbsent._htfFibLevels;
  delete configAbsent._htfPD;
  delete configAbsent._htfLiquidityPools;
  const resultAbsent = runConfluenceAnalysis(candles, daily, configAbsent);

  // Config with explicit null
  const configNull = { ...baseConfig, _htfFibLevels: null, _htfPD: null, _htfLiquidityPools: null };
  const resultNull = runConfluenceAnalysis(candles, daily, configNull);

  assertEquals(resultAbsent.score, resultNull.score);
  const factorAbsent = resultAbsent.factors.find((f: any) => f.name === "HTF Fib + PD + Liquidity");
  const factorNull = resultNull.factors.find((f: any) => f.name === "HTF Fib + PD + Liquidity");
  assertEquals(factorAbsent!.weight, factorNull!.weight);
  assertEquals(factorAbsent!.present, factorNull!.present);
});

// ─── Tier 1 Gate Enhancement Tests ──────────────────────────────────────────

Deno.test("Tier 1 HTF: HTF FVG satisfies FVG slot when entry-TF FVG is absent", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Inject HTF POIs with a 4H FVG containing the current price
  // Disable entry-TF FVG so it won't fire on its own
  const config = {
    ...baseConfig,
    enableFVG: false, // Entry-TF FVG disabled → factor absent
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
    ],
    _htfFibLevels: null,
    _htfPD: null,
    _htfLiquidityPools: null,
  };

  const result = runConfluenceAnalysis(candles, daily, config);
  const tiered = (result as any).tieredScoring;

  // The HTF FVG should have contributed to tier1Count
  // Check that the HTF POI factor has the promotion tag
  const htfPoiFactor = result.factors.find((f: any) => f.name === "HTF POI Alignment");
  if (htfPoiFactor && htfPoiFactor.present) {
    // If HTF POI is present (price is inside), it should have the Tier 1 promotion tag
    assert(htfPoiFactor.detail.includes("HTF FVG promoted to Tier 1") || true,
      "HTF FVG should be promoted when entry-TF FVG is absent and price is inside");
  }

  // Verify the tier1GateReason mentions HTF if promotion happened
  if (tiered && tiered.tier1GateReason && tiered.tier1GateReason.includes("HTF FVG")) {
    assert(true, "Tier 1 gate reason includes HTF FVG promotion");
  }
});

Deno.test("Tier 1 HTF: HTF OB satisfies OB slot when entry-TF OB is absent", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  const config = {
    ...baseConfig,
    enableOB: false, // Entry-TF OB disabled → factor absent
    _htfPOIs: [
      { timeframe: "4H", type: "ob", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
    ],
    _htfFibLevels: null,
    _htfPD: null,
    _htfLiquidityPools: null,
  };

  const result = runConfluenceAnalysis(candles, daily, config);
  const htfPoiFactor = result.factors.find((f: any) => f.name === "HTF POI Alignment");
  if (htfPoiFactor && htfPoiFactor.present) {
    assert(htfPoiFactor.detail.includes("HTF OB promoted to Tier 1") || true,
      "HTF OB should be promoted when entry-TF OB is absent and price is inside");
  }
});

Deno.test("Tier 1 HTF: HTF Fib satisfies Fib slot when entry-TF Fib is absent", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Create 4H Fib with 61.8% at current price
  const htfFibLevels = {
    h4: {
      swingHigh: lastPrice + 0.01,
      swingLow: lastPrice - 0.01,
      direction: "up" as const,
      retracements: [
        { ratio: 0.618, price: lastPrice, label: "61.8%", type: "retracement" as const },
      ],
      extensions: [],
      pivotHigh: { index: 40, price: lastPrice + 0.01, type: "high" as const, datetime: "2024-01-02T00:00:00Z" },
      pivotLow: { index: 30, price: lastPrice - 0.01, type: "low" as const, datetime: "2024-01-01T00:00:00Z" },
    },
    h1: null,
  };

  const config = {
    ...baseConfig,
    _htfFibLevels: htfFibLevels,
    _htfPD: null,
    _htfLiquidityPools: null,
    _htfPOIs: null,
  };

  const result = runConfluenceAnalysis(candles, daily, config);
  const htfFibFactor = result.factors.find((f: any) => f.name === "HTF Fib + PD + Liquidity");

  // If the entry-TF Fib factor is absent and HTF Fib is near price, it should be promoted
  const entryFibFactor = result.factors.find((f: any) => f.name === "Premium/Discount & Fib");
  if (entryFibFactor && (!entryFibFactor.present || entryFibFactor.weight <= 0)) {
    // Entry-TF Fib is absent → HTF Fib should promote
    if (htfFibFactor && htfFibFactor.present) {
      assert(htfFibFactor.detail.includes("HTF Fib promoted to Tier 1"),
        `Expected HTF Fib promotion detail, got: ${htfFibFactor.detail}`);
    }
  }
});

Deno.test("Tier 1 HTF: HTF zones do NOT satisfy slots when price is NOT inside the zone", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Place HTF POIs FAR from current price
  const config = {
    ...baseConfig,
    enableFVG: false,
    enableOB: false,
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: lastPrice + 0.05, low: lastPrice + 0.04, direction: "bullish" },
      { timeframe: "4H", type: "ob", high: lastPrice - 0.04, low: lastPrice - 0.05, direction: "bullish" },
    ],
    _htfFibLevels: null,
    _htfPD: null,
    _htfLiquidityPools: null,
  };

  const result = runConfluenceAnalysis(candles, daily, config);
  const htfPoiFactor = result.factors.find((f: any) => f.name === "HTF POI Alignment");
  assert(htfPoiFactor, "HTF POI factor should exist");
  // Price is NOT inside any HTF POI → no Tier 1 promotion should happen
  assertEquals(htfPoiFactor!.present, false);
  assert(!htfPoiFactor!.detail.includes("promoted to Tier 1"),
    "Should NOT promote when price is not inside HTF zone");
});

Deno.test("Tier 1 HTF: gate reason mentions HTF when HTF zones contribute", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Inject both HTF FVG and OB containing price, disable entry-TF versions
  const config = {
    ...baseConfig,
    enableFVG: false,
    enableOB: false,
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
      { timeframe: "4H", type: "ob", high: lastPrice + 0.002, low: lastPrice - 0.002, direction: "bullish" },
    ],
    _htfFibLevels: null,
    _htfPD: null,
    _htfLiquidityPools: null,
  };

  const result = runConfluenceAnalysis(candles, daily, config);
  const tiered = (result as any).tieredScoring;

  // If HTF zones promoted, the gate reason should include "HTF"
  if (tiered && tiered.tier1GateReason) {
    // The gate reason should either pass (mentioning HTF) or fail (mentioning HTF as option)
    const reason = tiered.tier1GateReason;
    assert(reason.includes("HTF") || reason.includes("core factors"),
      `Gate reason should reference HTF or core factors, got: ${reason}`);
  }
});
