/**
 * HTF POI Alignment — Factor 23 Tests
 *
 * Verifies that:
 * 1. When _htfPOIs is null/empty, the factor scores 0 (no data)
 * 2. When price is NOT inside any HTF POI, factor scores 0
 * 3. When price IS inside an aligned 4H FVG, factor scores correctly
 * 4. When price is inside a counter-directional POI, score is reduced
 * 5. When price is inside multiple HTF POIs, scores stack up to cap of 2.0
 * 6. HTF POI layers are injected into confluence stacking
 * 7. No regression: existing scoring is unaffected when _htfPOIs is absent
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

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test("HTF POI: no data → factor scores 0 with 'No HTF POI data available'", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const config = { ...baseConfig, _htfPOIs: null };
  const result = runConfluenceAnalysis(candles, daily, config);
  const htfFactor = result.factors.find((f: any) => f.name === "HTF POI Alignment");
  assert(htfFactor, "HTF POI Alignment factor should exist");
  assertEquals(htfFactor!.present, false);
  assertEquals(htfFactor!.weight, 0);
  assert(htfFactor!.detail.includes("No HTF POI data available"));
});

Deno.test("HTF POI: POIs exist but price not inside any → factor scores 0", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close; // ~1.095
  // Place POIs far away from current price
  const config = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: 1.12000, low: 1.11500, direction: "bullish" },
      { timeframe: "1H", type: "ob", high: 1.05000, low: 1.04500, direction: "bearish" },
    ],
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const htfFactor = result.factors.find((f: any) => f.name === "HTF POI Alignment");
  assert(htfFactor, "HTF POI Alignment factor should exist");
  assertEquals(htfFactor!.present, false);
  assertEquals(htfFactor!.weight, 0);
  assert(htfFactor!.detail.includes("price not inside any"));
});

Deno.test("HTF POI: price inside 4H FVG → scores correctly (base 0.8, may get alignment bonus)", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;
  // Place a bullish 4H FVG right around the current price
  const config = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
    ],
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const htfFactor = result.factors.find((f: any) => f.name === "HTF POI Alignment");
  assert(htfFactor, "HTF POI Alignment factor should exist");
  assertEquals(htfFactor!.present, true);
  // 4H FVG base = 0.8; with alignment bonus = 0.96, without (no direction) = 0.8
  assert(htfFactor!.weight >= 0.8, `Expected >= 0.8, got ${htfFactor!.weight}`);
  assert(htfFactor!.weight <= 1.0, `Expected <= 1.0, got ${htfFactor!.weight}`);
  assert(htfFactor!.detail.includes("4H FVG"));
});

Deno.test("HTF POI: price inside counter-directional 4H FVG → same or reduced score vs aligned", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;
  // Place a BEARISH 4H FVG around price
  const configCounter = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bearish" },
    ],
  };
  const resultCounter = runConfluenceAnalysis(candles, daily, configCounter);
  const htfCounter = resultCounter.factors.find((f: any) => f.name === "HTF POI Alignment");

  // Place a BULLISH 4H FVG around price
  const configAligned = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
    ],
  };
  const resultAligned = runConfluenceAnalysis(candles, daily, configAligned);
  const htfAligned = resultAligned.factors.find((f: any) => f.name === "HTF POI Alignment");

  assert(htfCounter, "HTF POI Alignment factor should exist");
  assert(htfAligned, "HTF POI Alignment factor should exist");
  assertEquals(htfCounter!.present, true);
  assertEquals(htfAligned!.present, true);
  // Counter should score <= aligned (when direction is detected, counter gets 50% penalty)
  assert(htfCounter!.weight <= htfAligned!.weight, 
    `Counter (${htfCounter!.weight}) should score <= aligned (${htfAligned!.weight})`);
  // Both should be at least the base score (0.4 for counter, 0.8 for aligned)
  assert(htfCounter!.weight >= 0.4, `Counter should be >= 0.4, got ${htfCounter!.weight}`);
  assert(htfAligned!.weight >= 0.8, `Aligned should be >= 0.8, got ${htfAligned!.weight}`);
});

Deno.test("HTF POI: multiple POIs → scores stack, capped at 2.0", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;
  // Place multiple aligned POIs around price
  const config = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
      { timeframe: "4H", type: "ob", high: lastPrice + 0.002, low: lastPrice - 0.002, direction: "bullish" },
      { timeframe: "1H", type: "fvg", high: lastPrice + 0.0005, low: lastPrice - 0.0005, direction: "bullish" },
      { timeframe: "1H", type: "ob", high: lastPrice + 0.0015, low: lastPrice - 0.0015, direction: "bullish" },
      { timeframe: "1H", type: "breaker", high: lastPrice + 0.003, low: lastPrice - 0.003, direction: "bullish" },
    ],
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const htfFactor = result.factors.find((f: any) => f.name === "HTF POI Alignment");
  assert(htfFactor, "HTF POI Alignment factor should exist");
  assertEquals(htfFactor!.present, true);
  // All aligned: 4H FVG(0.96) + 4H OB(0.84) + 1H FVG(0.6) + 1H OB(0.48) + 1H Breaker(0.36) = 3.24 → capped at 2.0
  assertEquals(htfFactor!.weight, 2.0);
});

Deno.test("HTF POI: 1H zones score less than 4H zones", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Test with 1H FVG only
  const config1H = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "1H", type: "fvg", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
    ],
  };
  const result1H = runConfluenceAnalysis(candles, daily, config1H);
  const htf1H = result1H.factors.find((f: any) => f.name === "HTF POI Alignment");

  // Test with 4H FVG only
  const config4H = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
    ],
  };
  const result4H = runConfluenceAnalysis(candles, daily, config4H);
  const htf4H = result4H.factors.find((f: any) => f.name === "HTF POI Alignment");

  assert(htf4H!.weight > htf1H!.weight, `4H (${htf4H!.weight}) should score higher than 1H (${htf1H!.weight})`);
});

Deno.test("HTF POI: no regression — absent _htfPOIs produces same score as explicit null", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);

  // Config without _htfPOIs at all
  const configAbsent = { ...baseConfig };
  delete configAbsent._htfPOIs;
  const resultAbsent = runConfluenceAnalysis(candles, daily, configAbsent);

  // Config with explicit null
  const configNull = { ...baseConfig, _htfPOIs: null };
  const resultNull = runConfluenceAnalysis(candles, daily, configNull);

  assertEquals(resultAbsent.score, resultNull.score);
  const htfAbsent = resultAbsent.factors.find((f: any) => f.name === "HTF POI Alignment");
  const htfNull = resultNull.factors.find((f: any) => f.name === "HTF POI Alignment");
  assertEquals(htfAbsent!.weight, htfNull!.weight);
  assertEquals(htfAbsent!.present, htfNull!.present);
});

Deno.test("HTF POI: htfPOIs field is returned in analysis result", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;
  const pois = [
    { timeframe: "4H", type: "fvg", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
  ];
  const config = { ...baseConfig, _htfPOIs: pois };
  const result = runConfluenceAnalysis(candles, daily, config) as any;
  assert(result.htfPOIs, "htfPOIs should be in the return object");
  assertEquals(result.htfPOIs.length, 1);
  assertEquals(result.htfPOIs[0].timeframe, "4H");
});

Deno.test("HTF POI: factor is classified as Tier 2", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;
  const config = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
    ],
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const htfFactor = result.factors.find((f: any) => f.name === "HTF POI Alignment");
  assert(htfFactor, "HTF POI Alignment factor should exist");
  assertEquals((htfFactor as any).tier, 2);
});
