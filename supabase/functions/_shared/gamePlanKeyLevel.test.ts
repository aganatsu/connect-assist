/**
 * Game Plan Key Level Alignment — Factor 25 Tests
 *
 * Verifies that:
 * 1. When _gamePlanContext is null/absent, the factor scores 0
 * 2. When key levels exist but price is far away, factor scores 0
 * 3. When price is near a high-significance support level (long direction), scores correctly
 * 4. Counter-directional levels score less than aligned ones
 * 5. Multiple nearby levels produce a multi-match bonus
 * 6. Score is capped at 1.0
 * 7. Factor is classified as Tier 2
 * 8. No regression: absent _gamePlanContext produces same score as explicit null
 * 9. gamePlanContext field is returned in analysis result
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

Deno.test("GP Key Level: no context → factor scores 0 with 'No game plan context available'", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const config = { ...baseConfig, _gamePlanContext: null };
  const result = runConfluenceAnalysis(candles, daily, config);
  const gpFactor = result.factors.find((f: any) => f.name === "GP Key Level Alignment");
  assert(gpFactor, "GP Key Level Alignment factor should exist");
  assertEquals(gpFactor!.present, false);
  assertEquals(gpFactor!.weight, 0);
  assert(gpFactor!.detail.includes("No game plan context available"));
});

Deno.test("GP Key Level: context exists but no key levels → scores 0", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const config = {
    ...baseConfig,
    _gamePlanContext: {
      bias: "bullish",
      biasConfidence: 70,
      dol: null,
      keyLevels: [],
      regime: "mild_trend",
      htfTrend: "bullish",
      h4Trend: "bullish",
      tradeable: true,
      atr: 0.008,
      isFocusPair: false,
    },
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const gpFactor = result.factors.find((f: any) => f.name === "GP Key Level Alignment");
  assert(gpFactor, "GP Key Level Alignment factor should exist");
  assertEquals(gpFactor!.present, false);
  assertEquals(gpFactor!.weight, 0);
  assert(gpFactor!.detail.includes("no key levels"));
});

Deno.test("GP Key Level: key levels exist but price far away → scores 0", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;
  const config = {
    ...baseConfig,
    _gamePlanContext: {
      bias: "bullish",
      biasConfidence: 70,
      dol: null,
      keyLevels: [
        { price: lastPrice + 0.05, label: "Daily OB", type: "ob", significance: "high" },
        { price: lastPrice - 0.05, label: "PDL", type: "pd_level", significance: "medium" },
      ],
      regime: "mild_trend",
      htfTrend: "bullish",
      h4Trend: "bullish",
      tradeable: true,
      atr: 0.008,
      isFocusPair: false,
    },
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const gpFactor = result.factors.find((f: any) => f.name === "GP Key Level Alignment");
  assert(gpFactor, "GP Key Level Alignment factor should exist");
  assertEquals(gpFactor!.present, false);
  assertEquals(gpFactor!.weight, 0);
  assert(gpFactor!.detail.includes("none within"));
});

Deno.test("GP Key Level: price near high-significance support → scores > 0", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;
  const config = {
    ...baseConfig,
    _gamePlanContext: {
      bias: "bullish",
      biasConfidence: 70,
      dol: null,
      keyLevels: [
        // Place a high-significance support level right at current price
        { price: lastPrice + 0.0001, label: "Daily Support", type: "support", significance: "high" },
      ],
      regime: "mild_trend",
      htfTrend: "bullish",
      h4Trend: "bullish",
      tradeable: true,
      atr: 0.008,
      isFocusPair: false,
    },
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const gpFactor = result.factors.find((f: any) => f.name === "GP Key Level Alignment");
  assert(gpFactor, "GP Key Level Alignment factor should exist");
  assertEquals(gpFactor!.present, true);
  // High significance support (0.5) with alignment bonus (×1.2) = 0.6
  assert(gpFactor!.weight > 0, `Expected > 0, got ${gpFactor!.weight}`);
  assert(gpFactor!.weight <= 1.0, `Expected <= 1.0, got ${gpFactor!.weight}`);
  assert(gpFactor!.detail.includes("Near GP key level"));
  assert(gpFactor!.detail.includes("Daily Support"));
});

Deno.test("GP Key Level: counter-directional resistance scores less than aligned support (when direction detected)", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Force a "long" direction via override so directional scoring is exercised
  const configAligned = {
    ...baseConfig,
    _overrideDirection: "long",
    _gamePlanContext: {
      bias: "bullish", biasConfidence: 70, dol: null,
      keyLevels: [
        { price: lastPrice + 0.0001, label: "Support", type: "support", significance: "high" },
      ],
      regime: "mild_trend", htfTrend: "bullish", h4Trend: "bullish",
      tradeable: true, atr: 0.008, isFocusPair: false,
    },
  };
  const resultAligned = runConfluenceAnalysis(candles, daily, configAligned);
  const gpAligned = resultAligned.factors.find((f: any) => f.name === "GP Key Level Alignment");

  const configCounter = {
    ...baseConfig,
    _overrideDirection: "long",
    _gamePlanContext: {
      bias: "bullish", biasConfidence: 70, dol: null,
      keyLevels: [
        { price: lastPrice + 0.0001, label: "Resistance", type: "resistance", significance: "high" },
      ],
      regime: "mild_trend", htfTrend: "bullish", h4Trend: "bullish",
      tradeable: true, atr: 0.008, isFocusPair: false,
    },
  };
  const resultCounter = runConfluenceAnalysis(candles, daily, configCounter);
  const gpCounter = resultCounter.factors.find((f: any) => f.name === "GP Key Level Alignment");

  assert(gpAligned, "Aligned factor should exist");
  assert(gpCounter, "Counter factor should exist");
  // With forced long direction: support gets 1.2× bonus, resistance gets 0.5× penalty
  // High sig base = 0.5 → aligned = 0.6, counter = 0.25
  assert(gpAligned!.weight > gpCounter!.weight,
    `Aligned (${gpAligned!.weight}) should score > counter (${gpCounter!.weight})`);
});

Deno.test("GP Key Level: multiple nearby levels → multi-match bonus, capped at 1.0", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;
  const config = {
    ...baseConfig,
    _gamePlanContext: {
      bias: "bullish", biasConfidence: 70, dol: null,
      keyLevels: [
        { price: lastPrice + 0.0001, label: "Support 1", type: "support", significance: "high" },
        { price: lastPrice + 0.0002, label: "OB Zone", type: "ob", significance: "high" },
        { price: lastPrice - 0.0001, label: "FVG", type: "fvg", significance: "medium" },
        { price: lastPrice + 0.0003, label: "PDL", type: "pd_level", significance: "high" },
      ],
      regime: "mild_trend", htfTrend: "bullish", h4Trend: "bullish",
      tradeable: true, atr: 0.008, isFocusPair: false,
    },
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const gpFactor = result.factors.find((f: any) => f.name === "GP Key Level Alignment");
  assert(gpFactor, "GP Key Level Alignment factor should exist");
  assertEquals(gpFactor!.present, true);
  // Should be capped at 1.0
  assert(gpFactor!.weight <= 1.0, `Expected <= 1.0, got ${gpFactor!.weight}`);
  // Should have multi-match bonus
  assert(gpFactor!.detail.includes("more within tolerance"), `Expected multi-match detail, got: ${gpFactor!.detail}`);
});

Deno.test("GP Key Level: factor is classified as Tier 2", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;
  const config = {
    ...baseConfig,
    _gamePlanContext: {
      bias: "bullish", biasConfidence: 70, dol: null,
      keyLevels: [
        { price: lastPrice + 0.0001, label: "Support", type: "support", significance: "high" },
      ],
      regime: "mild_trend", htfTrend: "bullish", h4Trend: "bullish",
      tradeable: true, atr: 0.008, isFocusPair: false,
    },
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const gpFactor = result.factors.find((f: any) => f.name === "GP Key Level Alignment");
  assert(gpFactor, "GP Key Level Alignment factor should exist");
  assertEquals((gpFactor as any).tier, 2);
});

Deno.test("GP Key Level: no regression — absent _gamePlanContext produces same score as explicit null", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);

  const configAbsent = { ...baseConfig };
  delete configAbsent._gamePlanContext;
  const resultAbsent = runConfluenceAnalysis(candles, daily, configAbsent);

  const configNull = { ...baseConfig, _gamePlanContext: null };
  const resultNull = runConfluenceAnalysis(candles, daily, configNull);

  assertEquals(resultAbsent.score, resultNull.score);
  const gpAbsent = resultAbsent.factors.find((f: any) => f.name === "GP Key Level Alignment");
  const gpNull = resultNull.factors.find((f: any) => f.name === "GP Key Level Alignment");
  assertEquals(gpAbsent!.weight, gpNull!.weight);
  assertEquals(gpAbsent!.present, gpNull!.present);
});

Deno.test("GP Key Level: gamePlanContext field is returned in analysis result", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const gpContext = {
    bias: "bullish", biasConfidence: 70, dol: null,
    keyLevels: [
      { price: 1.09, label: "Support", type: "support", significance: "high" },
    ],
    regime: "mild_trend", htfTrend: "bullish", h4Trend: "bullish",
    tradeable: true, atr: 0.008, isFocusPair: true,
  };
  const config = { ...baseConfig, _gamePlanContext: gpContext };
  const result = runConfluenceAnalysis(candles, daily, config) as any;
  assert(result.gamePlanContext, "gamePlanContext should be in the return object");
  assertEquals(result.gamePlanContext.bias, "bullish");
  assertEquals(result.gamePlanContext.isFocusPair, true);
  assertEquals(result.gamePlanContext.keyLevels.length, 1);
});

Deno.test("GP Key Level: neutral type (ob/fvg) scores without directional penalty", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // OB type — should not get directional penalty even in a long trade
  const config = {
    ...baseConfig,
    _gamePlanContext: {
      bias: "bullish", biasConfidence: 70, dol: null,
      keyLevels: [
        { price: lastPrice + 0.0001, label: "Daily OB", type: "ob", significance: "high" },
      ],
      regime: "mild_trend", htfTrend: "bullish", h4Trend: "bullish",
      tradeable: true, atr: 0.008, isFocusPair: false,
    },
  };
  const result = runConfluenceAnalysis(candles, daily, config);
  const gpFactor = result.factors.find((f: any) => f.name === "GP Key Level Alignment");
  assert(gpFactor, "GP Key Level Alignment factor should exist");
  assertEquals(gpFactor!.present, true);
  // High significance OB = 0.5 (no directional modifier for neutral types)
  assert(gpFactor!.weight >= 0.5, `Expected >= 0.5 for neutral high-sig, got ${gpFactor!.weight}`);
});
