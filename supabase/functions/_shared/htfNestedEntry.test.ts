/**
 * HTF Nested Entry Tests — verifies the nested containment logic:
 *
 * Core principle: The A+ entry is a lower-timeframe OB/FVG that forms INSIDE
 * a higher-timeframe institutional zone. HTF zones alone (without LTF confirmation)
 * do NOT satisfy Tier 1 — this is the key behavioral change from the old substitution model.
 *
 * Tests:
 * 1. Entry-TF Fib present + HTF Fib at same price → quality boost + "HTF-nested" tag
 * 2. Entry-TF Fib present + HTF Fib far away → no boost
 * 3. HTF FVG alone (no LTF FVG) → no Tier 1 promotion (regression)
 * 4. HTF OB alone (no LTF OB) → no Tier 1 promotion (regression)
 * 5. HTF Fib alone (no LTF Fib) → no Tier 1 promotion (regression)
 * 6. LTF FVG present + HTF FVG far away → no boost (zones don't overlap)
 * 7. LTF OB present + HTF OB far away → no boost (zones don't overlap)
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runConfluenceAnalysis } from "./confluenceScoring.ts";
import { Candle } from "./smcAnalysis.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Creates a ranging/oscillating fixture that produces:
 * - Premium/Discount & Fib factor as present (price at ~73% retracement)
 * - Direction: long
 * - Structure: ranging
 */
function makeRangingWithFibCandles(): Candle[] {
  const candles: Candle[] = [];
  let price = 1.08500;
  for (let i = 0; i < 60; i++) {
    const hour = i % 24;
    const day = Math.floor(i / 24) + 1;
    const direction = Math.sin(i * 0.3) * 0.0005;
    const open = price;
    const close = price + direction;
    candles.push({
      datetime: `2024-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`,
      open,
      high: Math.max(open, close) + 0.0003,
      low: Math.min(open, close) - 0.0003,
      close,
      volume: 1000 + i * 10, // Deterministic volume
    });
    price = close;
  }
  return candles;
}

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
  obLookbackCandles: 60,
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

// ─── Positive Test: Fib Nesting ──────────────────────────────────────────────

Deno.test("HTF Nested: Entry-TF Fib + HTF Fib at same price → quality boost", () => {
  const candles = makeRangingWithFibCandles();
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // First verify the fixture produces a Fib factor
  const configNoHTF = { ...baseConfig, _htfPOIs: null, _htfFibLevels: null, _htfPD: null, _htfLiquidityPools: null };
  const resultNoHTF = runConfluenceAnalysis(candles, daily, configNoHTF);
  const fibNoHTF = resultNoHTF.factors.find((f: any) => f.name === "Premium/Discount & Fib");

  assert(fibNoHTF && fibNoHTF.present,
    `Fixture must produce a present Fib factor for this test to be valid. Got: present=${fibNoHTF?.present}, weight=${fibNoHTF?.weight}`);

  // Now add HTF Fib at the same price → should trigger nested confirmation
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

  const config = { ...baseConfig, _htfPOIs: null, _htfFibLevels: htfFibLevels, _htfPD: null, _htfLiquidityPools: null };
  const result = runConfluenceAnalysis(candles, daily, config);
  const fibFactor = result.factors.find((f: any) => f.name === "Premium/Discount & Fib");
  const htfFibFactor = result.factors.find((f: any) => f.name === "HTF Fib + PD + Liquidity");

  assert(fibFactor && fibFactor.present, "Fib factor should still be present");

  // Check for HTF-nested tag on the Fib factor
  assert(fibFactor!.detail.includes("HTF-nested"),
    `Fib detail should include 'HTF-nested' when HTF Fib confirms, got: ${fibFactor!.detail}`);

  // Check the HTF Fib factor has the confirmation tag
  if (htfFibFactor) {
    assert((htfFibFactor as any)._htfTier1Fib === true,
      "_htfTier1Fib flag should be set when entry-TF Fib is confirmed by HTF Fib");
    assert(htfFibFactor.detail.includes("HTF Fib confirmed"),
      `HTF Fib factor detail should mention confirmation, got: ${htfFibFactor.detail}`);
  }

  // Score should be >= baseline (quality boost adds to tieredScore)
  assert(result.score >= resultNoHTF.score,
    `Score with HTF Fib nesting (${result.score}) should be >= baseline (${resultNoHTF.score})`);
});

Deno.test("HTF Nested: Entry-TF Fib + HTF Fib far away → no boost", () => {
  const candles = makeRangingWithFibCandles();
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // First verify the fixture produces a Fib factor
  const configNoHTF = { ...baseConfig, _htfPOIs: null, _htfFibLevels: null, _htfPD: null, _htfLiquidityPools: null };
  const resultNoHTF = runConfluenceAnalysis(candles, daily, configNoHTF);
  const fibNoHTF = resultNoHTF.factors.find((f: any) => f.name === "Premium/Discount & Fib");

  assert(fibNoHTF && fibNoHTF.present,
    "Fixture must produce a present Fib factor for this test to be valid");

  // Add HTF Fib FAR from current price (no overlap within tolerance)
  const htfFibLevels = {
    h4: {
      swingHigh: lastPrice + 0.10,
      swingLow: lastPrice + 0.05,
      direction: "up" as const,
      retracements: [
        { ratio: 0.618, price: lastPrice + 0.07, label: "61.8%", type: "retracement" as const },
      ],
      extensions: [],
      pivotHigh: { index: 40, price: lastPrice + 0.10, type: "high" as const, datetime: "2024-01-02T00:00:00Z" },
      pivotLow: { index: 30, price: lastPrice + 0.05, type: "low" as const, datetime: "2024-01-01T00:00:00Z" },
    },
    h1: null,
  };

  const config = { ...baseConfig, _htfPOIs: null, _htfFibLevels: htfFibLevels, _htfPD: null, _htfLiquidityPools: null };
  const result = runConfluenceAnalysis(candles, daily, config);
  const fibFactor = result.factors.find((f: any) => f.name === "Premium/Discount & Fib");
  const htfFibFactor = result.factors.find((f: any) => f.name === "HTF Fib + PD + Liquidity");

  assert(fibFactor && fibFactor.present, "Fib factor should still be present");

  // Should NOT have HTF-nested tag (Fib is too far away)
  assert(!fibFactor!.detail.includes("HTF-nested"),
    `Fib should NOT be tagged as HTF-nested when HTF Fib is far away, got: ${fibFactor!.detail}`);

  if (htfFibFactor) {
    assert(!(htfFibFactor as any)._htfTier1Fib,
      "_htfTier1Fib should NOT be set when HTF Fib is far from price");
  }
});

// ─── Negative Tests: HTF Alone → No Promotion ────────────────────────────────

Deno.test("HTF Nested: HTF FVG alone (no LTF FVG) → no Tier 1 promotion", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Disable entry-TF FVG, provide HTF FVG at price
  const config = {
    ...baseConfig,
    enableFVG: false,
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: lastPrice + 0.002, low: lastPrice - 0.002, direction: "bullish" },
    ],
    _htfFibLevels: null,
    _htfPD: null,
    _htfLiquidityPools: null,
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const htfPoiFactor = result.factors.find((f: any) => f.name === "HTF POI Alignment");

  // HTF alone should NOT produce a Tier 1 FVG promotion
  if (htfPoiFactor) {
    assert(!(htfPoiFactor as any)._htfTier1FVG,
      "HTF FVG alone (without LTF FVG) should NOT produce _htfTier1FVG flag");
    assert(!htfPoiFactor.detail.includes("HTF-confirmed FVG"),
      "HTF FVG alone should NOT produce HTF-confirmed FVG detail");
  }
});

Deno.test("HTF Nested: HTF OB alone (no LTF OB) → no Tier 1 promotion", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Disable entry-TF OB, provide HTF OB at price
  const config = {
    ...baseConfig,
    enableOB: false,
    _htfPOIs: [
      { timeframe: "4H", type: "ob", high: lastPrice + 0.002, low: lastPrice - 0.002, direction: "bullish" },
    ],
    _htfFibLevels: null,
    _htfPD: null,
    _htfLiquidityPools: null,
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const htfPoiFactor = result.factors.find((f: any) => f.name === "HTF POI Alignment");

  // HTF alone should NOT produce a Tier 1 OB promotion
  if (htfPoiFactor) {
    assert(!(htfPoiFactor as any)._htfTier1OB,
      "HTF OB alone (without LTF OB) should NOT produce _htfTier1OB flag");
    assert(!htfPoiFactor.detail.includes("HTF-confirmed OB"),
      "HTF OB alone should NOT produce HTF-confirmed OB detail");
  }
});

Deno.test("HTF Nested: HTF Fib alone (no LTF Fib) → no Tier 1 promotion", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // The bullish fixture does NOT produce a Fib factor (>100% retrace is invalidated)
  // So HTF Fib should NOT be confirmed
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
    _htfPOIs: null,
    _htfFibLevels: htfFibLevels,
    _htfPD: null,
    _htfLiquidityPools: null,
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const fibFactor = result.factors.find((f: any) => f.name === "Premium/Discount & Fib");
  const htfFibFactor = result.factors.find((f: any) => f.name === "HTF Fib + PD + Liquidity");

  // If entry-TF Fib is not present, HTF Fib should NOT be confirmed
  if (!fibFactor || !fibFactor.present || fibFactor.weight <= 0) {
    if (htfFibFactor) {
      assert(!(htfFibFactor as any)._htfTier1Fib,
        "HTF Fib should NOT be confirmed when entry-TF Fib is absent");
      assert(!htfFibFactor.detail.includes("HTF Fib confirmed"),
        `HTF Fib detail should NOT mention confirmation when entry-TF Fib is absent, got: ${htfFibFactor.detail}`);
    }
  }
});

// ─── Non-overlap Tests ───────────────────────────────────────────────────────

Deno.test("HTF Nested: LTF FVG present but HTF FVG far away → no nested tag", () => {
  const candles = makeRangingWithFibCandles();
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Place HTF FVG far from any possible LTF FVG
  const config = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: lastPrice + 0.05, low: lastPrice + 0.04, direction: "bullish" },
    ],
    _htfFibLevels: null,
    _htfPD: null,
    _htfLiquidityPools: null,
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const fvgFactor = result.factors.find((f: any) => f.name === "Fair Value Gap");
  const htfPoiFactor = result.factors.find((f: any) => f.name === "HTF POI Alignment");

  // Whether or not FVG is present, it should NOT have HTF-nested tag
  if (fvgFactor) {
    assert(!fvgFactor.detail.includes("HTF-nested"),
      `FVG should NOT be tagged as HTF-nested when HTF zone is far away, got: ${fvgFactor.detail}`);
  }
  if (htfPoiFactor) {
    assert(!(htfPoiFactor as any)._htfTier1FVG,
      "_htfTier1FVG should NOT be set when HTF FVG doesn't overlap with LTF FVG");
  }
});

Deno.test("HTF Nested: LTF OB present but HTF OB far away → no nested tag", () => {
  const candles = makeRangingWithFibCandles();
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Place HTF OB far from any possible LTF OB
  const config = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "4H", type: "ob", high: lastPrice - 0.04, low: lastPrice - 0.05, direction: "bullish" },
    ],
    _htfFibLevels: null,
    _htfPD: null,
    _htfLiquidityPools: null,
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const obFactor = result.factors.find((f: any) => f.name === "Order Block");
  const htfPoiFactor = result.factors.find((f: any) => f.name === "HTF POI Alignment");

  // Whether or not OB is present, it should NOT have HTF-nested tag
  if (obFactor) {
    assert(!obFactor.detail.includes("HTF-nested"),
      `OB should NOT be tagged as HTF-nested when HTF zone is far away, got: ${obFactor.detail}`);
  }
  if (htfPoiFactor) {
    assert(!(htfPoiFactor as any)._htfTier1OB,
      "_htfTier1OB should NOT be set when HTF OB doesn't overlap with LTF OB");
  }
});
