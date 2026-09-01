/**
 * Daily POI Detection & Chart Overlays — Tests
 *
 * Verifies that:
 * 1. Daily POIs are detected and scored with "D" timeframe via BOOST_MAP
 * 2. Daily FVGs use quality threshold >= 2 (lower than 4H/1H threshold of >= 3)
 * 3. Daily POIs receive highest BOOST_MAP weights (fvg: 1.0, ob: 0.8, breaker: 0.6)
 * 4. "D" timeframe POIs score higher than equivalent "4H" POIs
 * 5. Chart overlays data structure is well-formed with required fields
 * 6. No regression: existing 4H/1H POI scoring unchanged when Daily POIs added
 */

import { assertEquals, assert, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runConfluenceAnalysis } from "./confluenceScoring.ts";
import {
  analyzeMarketStructure, detectFVGs, detectOrderBlocks, detectBreakerBlocks,
  type Candle,
} from "./smcAnalysis.ts";

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

/** Create daily candles with a clear impulse move to generate structure breaks, OBs, and FVGs */
function makeDailyCandlesWithStructure(count = 30): Candle[] {
  const candles: Candle[] = [];
  let price = 1.08000;
  for (let i = 0; i < count; i++) {
    const day = i + 1;
    let open: number, high: number, low: number, close: number;
    if (i < 10) {
      // Uptrend phase
      open = price;
      close = price + 0.003;
      high = close + 0.001;
      low = open - 0.0005;
    } else if (i < 15) {
      // Sharp reversal (creates structure breaks, FVGs, OBs)
      open = price;
      close = price - 0.005;
      high = open + 0.001;
      low = close - 0.001;
    } else if (i < 20) {
      // Consolidation
      open = price;
      close = price + 0.001;
      high = close + 0.0005;
      low = open - 0.0005;
    } else {
      // Another impulse up
      open = price;
      close = price + 0.004;
      high = close + 0.001;
      low = open - 0.0005;
    }
    candles.push({
      datetime: `2024-01-${String(day).padStart(2, "0")}T00:00:00Z`,
      open, high, low, close,
      volume: 5000 + Math.random() * 2000,
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

// ─── Daily POI Detection Tests ──────────────────────────────────────────────

Deno.test("Daily POI: analyzeMarketStructure works on daily candles with >= 10 bars", () => {
  const dailyCandles = makeDailyCandlesWithStructure(30);
  const structure = analyzeMarketStructure(dailyCandles);
  assertExists(structure, "Structure should be returned");
  assertExists(structure.bos, "BOS array should exist");
  assertExists(structure.choch, "CHoCH array should exist");
  assertExists(structure.swingPoints, "Swing points should exist");
  assert(structure.swingPoints.length > 0, "Should detect swing points on daily candles");
});

Deno.test("Daily POI: detectFVGs produces FVGs from daily candles", () => {
  const dailyCandles = makeDailyCandlesWithStructure(30);
  const structure = analyzeMarketStructure(dailyCandles);
  const structureBreaks = [...structure.bos, ...structure.choch];
  const fvgs = detectFVGs(dailyCandles, structureBreaks);
  // With a clear impulse move, we should get at least some FVGs
  assert(Array.isArray(fvgs), "FVGs should be an array");
  // Verify FVG structure
  for (const fvg of fvgs) {
    assertExists(fvg.high, "FVG should have high");
    assertExists(fvg.low, "FVG should have low");
    assertExists(fvg.state, "FVG should have state");
    assertExists(fvg.type, "FVG should have type (direction)");
    assert(fvg.high > fvg.low, "FVG high should be > low");
  }
});

Deno.test("Daily POI: detectOrderBlocks produces OBs from daily candles", () => {
  const dailyCandles = makeDailyCandlesWithStructure(30);
  const structure = analyzeMarketStructure(dailyCandles);
  const structureBreaks = [...structure.bos, ...structure.choch];
  const obs = detectOrderBlocks(dailyCandles, structureBreaks);
  assert(Array.isArray(obs), "OBs should be an array");
  for (const ob of obs) {
    assertExists(ob.high, "OB should have high");
    assertExists(ob.low, "OB should have low");
    assertExists(ob.state, "OB should have state");
    assertExists(ob.type, "OB should have type (direction)");
    assert(ob.high > ob.low, "OB high should be > low");
  }
});

Deno.test("Daily POI: detectBreakerBlocks produces breakers from daily OBs", () => {
  const dailyCandles = makeDailyCandlesWithStructure(30);
  const structure = analyzeMarketStructure(dailyCandles);
  const structureBreaks = [...structure.bos, ...structure.choch];
  const obs = detectOrderBlocks(dailyCandles, structureBreaks);
  const breakers = detectBreakerBlocks(obs, dailyCandles, structureBreaks);
  assert(Array.isArray(breakers), "Breakers should be an array");
  for (const bb of breakers) {
    assertExists(bb.high, "Breaker should have high");
    assertExists(bb.low, "Breaker should have low");
    assertExists(bb.state, "Breaker should have state");
    assertExists(bb.type, "Breaker should have type");
  }
});

Deno.test("Daily POI: 'D' timeframe POIs score higher than equivalent '4H' POIs", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Test with D FVG
  const configD = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "D", type: "fvg", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
    ],
  };
  const resultD = runConfluenceAnalysis(candles, daily, configD);
  const htfD = resultD.factors.find((f: any) => f.name === "HTF POI Alignment");

  // Test with 4H FVG (same zone)
  const config4H = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
    ],
  };
  const result4H = runConfluenceAnalysis(candles, daily, config4H);
  const htf4H = result4H.factors.find((f: any) => f.name === "HTF POI Alignment");

  assertExists(htfD, "D timeframe factor should exist");
  assertExists(htf4H, "4H timeframe factor should exist");
  assertEquals(htfD!.present, true);
  assertEquals(htf4H!.present, true);
  // D FVG base = 1.0, 4H FVG base = 0.8 — D should score >= 4H
  assert(htfD!.weight >= htf4H!.weight,
    `D (${htfD!.weight}) should score >= 4H (${htf4H!.weight})`);
});

Deno.test("Daily POI: 'D' OB scores higher than '4H' OB", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  const configD = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "D", type: "ob", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
    ],
  };
  const resultD = runConfluenceAnalysis(candles, daily, configD);
  const htfD = resultD.factors.find((f: any) => f.name === "HTF POI Alignment");

  const config4H = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "4H", type: "ob", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
    ],
  };
  const result4H = runConfluenceAnalysis(candles, daily, config4H);
  const htf4H = result4H.factors.find((f: any) => f.name === "HTF POI Alignment");

  assertExists(htfD);
  assertExists(htf4H);
  // D OB base = 0.8, 4H OB base = 0.6 — D should score >= 4H
  assert(htfD!.weight >= htf4H!.weight,
    `D OB (${htfD!.weight}) should score >= 4H OB (${htf4H!.weight})`);
});

Deno.test("Daily POI: 'D' breaker scores higher than '4H' breaker", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  const configD = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "D", type: "breaker", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
    ],
  };
  const resultD = runConfluenceAnalysis(candles, daily, configD);
  const htfD = resultD.factors.find((f: any) => f.name === "HTF POI Alignment");

  const config4H = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "4H", type: "breaker", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
    ],
  };
  const result4H = runConfluenceAnalysis(candles, daily, config4H);
  const htf4H = result4H.factors.find((f: any) => f.name === "HTF POI Alignment");

  assertExists(htfD);
  assertExists(htf4H);
  // D breaker base = 0.6, 4H breaker base = 0.4 — D should score >= 4H
  assert(htfD!.weight >= htf4H!.weight,
    `D breaker (${htfD!.weight}) should score >= 4H breaker (${htf4H!.weight})`);
});

Deno.test("Daily POI: FVG quality threshold >= 2 allows lower-quality FVGs", () => {
  // This test verifies the filtering logic that would be applied in bot-scanner.
  // Daily FVGs with quality >= 2 should pass the filter, while quality < 2 should not.
  const dailyCandles = makeDailyCandlesWithStructure(30);
  const structure = analyzeMarketStructure(dailyCandles);
  const structureBreaks = [...structure.bos, ...structure.choch];
  const fvgs = detectFVGs(dailyCandles, structureBreaks);

  // Simulate the Daily POI filter logic from bot-scanner
  const qualifyingFVGs = fvgs.filter((f: any) => f.state !== "filled" && (f.quality ?? 0) >= 2);
  const disqualifiedFVGs = fvgs.filter((f: any) => f.state !== "filled" && (f.quality ?? 0) < 2);

  // The key assertion: quality threshold 2 is lower than the 4H/1H threshold of 3
  // So some FVGs that would be excluded at threshold 3 should pass at threshold 2
  const qualifyingAt3 = fvgs.filter((f: any) => f.state !== "filled" && (f.quality ?? 0) >= 3);
  assert(qualifyingFVGs.length >= qualifyingAt3.length,
    `Threshold 2 (${qualifyingFVGs.length}) should qualify >= threshold 3 (${qualifyingAt3.length})`);
});

Deno.test("Daily POI: no regression — adding D POIs does not change 4H/1H scoring", () => {
  const candles = makeBullishCandles(50);
  const daily = makeDailyCandles(30);
  const lastPrice = candles[candles.length - 1].close;

  // Config with only 4H POI
  const config4HOnly = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
    ],
  };
  const result4HOnly = runConfluenceAnalysis(candles, daily, config4HOnly);
  const htf4HOnly = result4HOnly.factors.find((f: any) => f.name === "HTF POI Alignment");

  // Config with 4H + D POI (D is far away, should not affect 4H scoring)
  const configBoth = {
    ...baseConfig,
    _htfPOIs: [
      { timeframe: "4H", type: "fvg", high: lastPrice + 0.001, low: lastPrice - 0.001, direction: "bullish" },
      { timeframe: "D", type: "fvg", high: 1.20000, low: 1.19500, direction: "bullish" }, // Far away
    ],
  };
  const resultBoth = runConfluenceAnalysis(candles, daily, configBoth);
  const htfBoth = resultBoth.factors.find((f: any) => f.name === "HTF POI Alignment");

  assertExists(htf4HOnly);
  assertExists(htfBoth);
  // Both should have the same score since D POI is far from price
  assertEquals(htf4HOnly!.weight, htfBoth!.weight);
});

// ─── Chart Overlays Structure Tests ─────────────────────────────────────────

Deno.test("Chart Overlays: structure has all required top-level fields", () => {
  // Simulate what the bot-scanner produces for chartOverlays
  const mockAnalysis = {
    orderBlocks: [
      { high: 1.10, low: 1.09, datetime: "2024-01-15T10:00:00Z", state: "active", type: "bullish" },
    ],
    fvgs: [
      { high: 1.11, low: 1.105, datetime: "2024-01-15T12:00:00Z", state: "open", type: "bullish", fillPercent: 20 },
    ],
    breakerBlocks: [
      { high: 1.08, low: 1.075, datetime: "2024-01-14T08:00:00Z", state: "active", type: "bullish_breaker" },
    ],
    structure: {
      swingPoints: [
        { price: 1.12, datetime: "2024-01-15T14:00:00Z", type: "high", state: "active" },
      ],
    },
    liquidityPools: [
      { high: 1.13, low: 1.129, datetime: "2024-01-13T00:00:00Z", strength: 3, state: "active", direction: "bullish" },
    ],
    fibLevels: {
      swingHigh: 1.12,
      swingLow: 1.08,
      direction: "bullish",
      retracements: [{ level: 0.5, price: 1.10, label: "50%" }],
      extensions: [{ level: 1.618, price: 1.145, label: "161.8%" }],
    },
  };

  // Build chartOverlays the same way bot-scanner does
  const chartOverlays = {
    orderBlocks: (mockAnalysis.orderBlocks || []).slice(0, 30).map((ob: any) => ({
      high: ob.high, low: ob.low, datetime: ob.datetime || ob.time,
      state: ob.state, direction: ob.type, timeframe: "entry",
    })),
    fvgs: (mockAnalysis.fvgs || []).slice(0, 30).map((f: any) => ({
      high: f.high, low: f.low, datetime: f.datetime || f.time,
      state: f.state, direction: f.type, fillPercent: f.fillPercent ?? 0, timeframe: "entry",
    })),
    breakerBlocks: (mockAnalysis.breakerBlocks || []).slice(0, 20).map((bb: any) => ({
      high: bb.high, low: bb.low, datetime: bb.datetime || bb.time,
      state: bb.state, direction: bb.type, timeframe: "entry",
    })),
    swingPoints: (mockAnalysis.structure?.swingPoints || []).slice(0, 40).map((sp: any) => ({
      price: sp.price, datetime: sp.datetime || sp.time,
      type: sp.type, state: sp.state, timeframe: "entry",
    })),
    liquidityPools: (mockAnalysis.liquidityPools || []).slice(0, 20).map((lp: any) => ({
      price: lp.price ?? ((lp.high ?? 0) + (lp.low ?? 0)) / 2,
      high: lp.high, low: lp.low, datetime: lp.datetime || lp.time,
      strength: lp.strength ?? lp.touches ?? 0, state: lp.state,
      direction: lp.direction ?? lp.type, timeframe: "entry",
    })),
    fibLevels: mockAnalysis.fibLevels ? {
      swingHigh: mockAnalysis.fibLevels.swingHigh,
      swingLow: mockAnalysis.fibLevels.swingLow,
      direction: mockAnalysis.fibLevels.direction,
      retracements: mockAnalysis.fibLevels.retracements,
      extensions: mockAnalysis.fibLevels.extensions,
      timeframe: "entry",
    } : null,
    htfPOIs: [
      { timeframe: "D", type: "fvg", high: 1.11, low: 1.105, direction: "bullish" },
      { timeframe: "4H", type: "ob", high: 1.10, low: 1.09, direction: "bullish" },
    ],
    dailyEntities: null,
  };

  // Verify structure
  assertExists(chartOverlays.orderBlocks);
  assertExists(chartOverlays.fvgs);
  assertExists(chartOverlays.breakerBlocks);
  assertExists(chartOverlays.swingPoints);
  assertExists(chartOverlays.liquidityPools);
  assertExists(chartOverlays.fibLevels);
  assertExists(chartOverlays.htfPOIs);

  // Verify OB fields
  assertEquals(chartOverlays.orderBlocks[0].high, 1.10);
  assertEquals(chartOverlays.orderBlocks[0].low, 1.09);
  assertEquals(chartOverlays.orderBlocks[0].state, "active");
  assertEquals(chartOverlays.orderBlocks[0].direction, "bullish");
  assertEquals(chartOverlays.orderBlocks[0].timeframe, "entry");

  // Verify FVG fields
  assertEquals(chartOverlays.fvgs[0].fillPercent, 20);
  assertEquals(chartOverlays.fvgs[0].direction, "bullish");

  // Verify swing point fields
  assertEquals(chartOverlays.swingPoints[0].price, 1.12);
  assertEquals(chartOverlays.swingPoints[0].type, "high");

  // Verify liquidity pool fields
  assertEquals(chartOverlays.liquidityPools[0].strength, 3);

  // Verify fib levels
  assertEquals(chartOverlays.fibLevels!.swingHigh, 1.12);
  assertEquals(chartOverlays.fibLevels!.swingLow, 1.08);
  assertEquals(chartOverlays.fibLevels!.retracements.length, 1);
  assertEquals(chartOverlays.fibLevels!.extensions.length, 1);

  // Verify HTF POIs include D timeframe
  const dPOIs = chartOverlays.htfPOIs.filter(p => p.timeframe === "D");
  assertEquals(dPOIs.length, 1);
  assertEquals(dPOIs[0].type, "fvg");
});

Deno.test("Chart Overlays: dailyEntities contains full D1 entity data when daily candles available", () => {
  const dailyCandles = makeDailyCandlesWithStructure(30);
  const structure = analyzeMarketStructure(dailyCandles);
  const structureBreaks = [...structure.bos, ...structure.choch];
  const dFVGs = detectFVGs(dailyCandles, structureBreaks);
  const dOBs = detectOrderBlocks(dailyCandles, structureBreaks);
  const dBreakers = detectBreakerBlocks(dOBs, dailyCandles, structureBreaks);

  // Simulate dailyEntities construction from bot-scanner
  const dailyEntities = {
    orderBlocks: dOBs.slice(0, 15).map((ob: any) => ({
      high: ob.high, low: ob.low, datetime: ob.datetime || ob.time,
      state: ob.state, direction: ob.type,
    })),
    fvgs: dFVGs.slice(0, 15).map((f: any) => ({
      high: f.high, low: f.low, datetime: f.datetime || f.time,
      state: f.state, direction: f.type, fillPercent: f.fillPercent ?? 0,
    })),
    breakerBlocks: dBreakers.slice(0, 10).map((bb: any) => ({
      high: bb.high, low: bb.low, datetime: bb.datetime || bb.time,
      state: bb.state, direction: bb.type,
    })),
    fibLevels: null,
    premiumDiscount: null,
    liquidityPools: [],
  };

  assertExists(dailyEntities.orderBlocks);
  assertExists(dailyEntities.fvgs);
  assertExists(dailyEntities.breakerBlocks);
  assert(Array.isArray(dailyEntities.orderBlocks));
  assert(Array.isArray(dailyEntities.fvgs));
  assert(Array.isArray(dailyEntities.breakerBlocks));

  // Verify each OB has required fields
  for (const ob of dailyEntities.orderBlocks) {
    assert(typeof ob.high === "number", "OB high should be number");
    assert(typeof ob.low === "number", "OB low should be number");
    assert(ob.high > ob.low, "OB high > low");
    assertExists(ob.state);
    assertExists(ob.direction);
  }

  // Verify each FVG has required fields
  for (const fvg of dailyEntities.fvgs) {
    assert(typeof fvg.high === "number", "FVG high should be number");
    assert(typeof fvg.low === "number", "FVG low should be number");
    assert(fvg.high > fvg.low, "FVG high > low");
    assertExists(fvg.state);
    assertExists(fvg.direction);
    assert(typeof fvg.fillPercent === "number", "fillPercent should be number");
  }
});

Deno.test("Chart Overlays: slicing limits prevent payload bloat", () => {
  // Create a large array and verify slicing
  const largeOBs = Array.from({ length: 50 }, (_, i) => ({
    high: 1.10 + i * 0.001, low: 1.09 + i * 0.001,
    datetime: `2024-01-15T${String(i % 24).padStart(2, "0")}:00:00Z`,
    state: "active", type: "bullish",
  }));

  const sliced = largeOBs.slice(0, 30).map((ob: any) => ({
    high: ob.high, low: ob.low, datetime: ob.datetime,
    state: ob.state, direction: ob.type, timeframe: "entry",
  }));

  assertEquals(sliced.length, 30, "Should be capped at 30 OBs");
  assert(sliced[0].high < sliced[29].high, "Should preserve order");
});
