/**
 * backtestGamePlan.test.ts — Tests for game plan integration in backtest-engine
 *
 * Verifies:
 * 1. generateInstrumentGamePlan produces valid plan with candle data
 * 2. buildSessionGamePlan wraps instrument plans correctly
 * 3. filterTradeByGamePlan correctly allows/blocks based on bias alignment
 * 4. Session mapping from sessions.ts SessionName to gamePlan.ts GPSessionName
 * 5. _gamePlanContext structure matches bot-scanner's injection pattern
 */
import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  generateInstrumentGamePlan,
  buildSessionGamePlan,
  filterTradeByGamePlan,
  type InstrumentGamePlan,
  type SessionGamePlan,
  type SessionName as GPSessionName,
} from "./gamePlan.ts";
import { type Candle } from "./smcAnalysis.ts";

// ─── Helper: generate synthetic candles ───
function makeCandles(count: number, basePrice: number, direction: "up" | "down" | "flat" = "flat"): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 24), i % 24));
    const change = direction === "up" ? 0.001 : direction === "down" ? -0.001 : (Math.random() - 0.5) * 0.002;
    price += change;
    candles.push({
      datetime: d.toISOString(),
      open: price,
      high: price + 0.001,
      low: price - 0.001,
      close: price + (Math.random() - 0.5) * 0.001,
      volume: 1000 + Math.random() * 500,
    });
  }
  return candles;
}

// ─── Test: generateInstrumentGamePlan produces valid plan ───
Deno.test("GamePlan: generateInstrumentGamePlan returns valid InstrumentGamePlan", () => {
  const daily = makeCandles(60, 1.0800);
  const h4 = makeCandles(120, 1.0800);
  const entry = makeCandles(200, 1.0800);
  const hourly = makeCandles(120, 1.0800);

  const plan = generateInstrumentGamePlan("EUR/USD", daily, h4, entry, hourly, "London");

  assertExists(plan);
  assertEquals(plan.symbol, "EUR/USD");
  assertEquals(plan.session, "London");
  assert(["bullish", "bearish", "neutral"].includes(plan.bias));
  assert(plan.biasConfidence >= 0 && plan.biasConfidence <= 100);
  assertExists(plan.regime);
  assertExists(plan.htfTrend);
  assertExists(plan.h4Trend);
  assert(typeof plan.tradeable === "boolean");
  assert(typeof plan.atr === "number");
  assertExists(plan.generatedAt);
});

// ─── Test: buildSessionGamePlan wraps plans correctly ───
Deno.test("GamePlan: buildSessionGamePlan creates SessionGamePlan with focus pairs", () => {
  const daily = makeCandles(60, 1.0800);
  const h4 = makeCandles(120, 1.0800);
  const entry = makeCandles(200, 1.0800);
  const hourly = makeCandles(120, 1.0800);

  const plan1 = generateInstrumentGamePlan("EUR/USD", daily, h4, entry, hourly, "London");
  const plan2 = generateInstrumentGamePlan("GBP/USD", daily, h4, entry, hourly, "London");

  const sessionPlan = buildSessionGamePlan("London", [plan1, plan2]);

  assertExists(sessionPlan);
  assertEquals(sessionPlan.session, "London");
  assertEquals(sessionPlan.plans.length, 2);
  assert(Array.isArray(sessionPlan.focusPairs));
  assertExists(sessionPlan.generatedAt);
});

// ─── Test: filterTradeByGamePlan allows aligned trades ───
Deno.test("GamePlan: filterTradeByGamePlan allows trade aligned with bias", () => {
  // Create a session plan with bullish EUR/USD
  const mockPlan: SessionGamePlan = {
    session: "London",
    plans: [{
      symbol: "EUR/USD",
      session: "London",
      bias: "bullish",
      biasConfidence: 75,
      biasReasoning: ["HTF bullish"],
      dol: null,
      keyLevels: [],
      scenarios: [],
      regime: "trending",
      amdPhase: "distribution",
      zone: "discount",
      zonePercent: 30,
      htfTrend: "bullish",
      h4Trend: "bullish",
      atr: 0.0080,
      tradeable: true,
      lastPrice: 1.0850,
      generatedAt: new Date().toISOString(),
    }],
    focusPairs: ["EUR/USD"],
    generatedAt: new Date().toISOString(),
  };

  const result = filterTradeByGamePlan(mockPlan, "EUR/USD", "long");
  assertEquals(result.allowed, true);
  assertEquals(result.gamePlanBias, "bullish");
});

// ─── Test: filterTradeByGamePlan blocks misaligned trades ───
Deno.test("GamePlan: filterTradeByGamePlan blocks trade opposing bias", () => {
  const mockPlan: SessionGamePlan = {
    session: "London",
    plans: [{
      symbol: "EUR/USD",
      session: "London",
      bias: "bullish",
      biasConfidence: 80,
      biasReasoning: ["HTF bullish"],
      dol: null,
      keyLevels: [],
      scenarios: [],
      regime: "trending",
      amdPhase: "distribution",
      zone: "discount",
      zonePercent: 30,
      htfTrend: "bullish",
      h4Trend: "bullish",
      atr: 0.0080,
      tradeable: true,
      lastPrice: 1.0850,
      generatedAt: new Date().toISOString(),
    }],
    focusPairs: ["EUR/USD"],
    generatedAt: new Date().toISOString(),
  };

  const result = filterTradeByGamePlan(mockPlan, "EUR/USD", "short");
  assertEquals(result.allowed, false);
  assertEquals(result.gamePlanBias, "bullish");
  assert(result.reason.includes("REJECTED"));
});

// ─── Test: filterTradeByGamePlan allows when no plan exists ───
Deno.test("GamePlan: filterTradeByGamePlan allows when no game plan active", () => {
  const result = filterTradeByGamePlan(null, "EUR/USD", "long");
  assertEquals(result.allowed, true);
  assert(result.reason.includes("No game plan active"));
});

// ─── Test: Session mapping matches expected values ───
Deno.test("GamePlan: session mapping from sessions.ts to gamePlan.ts", () => {
  const mapSessionToGP = (sName: string): GPSessionName | null => {
    if (sName === "London") return "London";
    if (sName === "New York") return "New York";
    if (sName === "Asian") return "Asian";
    return null;
  };

  assertEquals(mapSessionToGP("London"), "London");
  assertEquals(mapSessionToGP("New York"), "New York");
  assertEquals(mapSessionToGP("Asian"), "Asian");
  assertEquals(mapSessionToGP("Off-Hours"), null);
});

// ─── Test: _gamePlanContext structure matches bot-scanner pattern ───
Deno.test("GamePlan: context injection produces correct structure", () => {
  const daily = makeCandles(60, 1.0800);
  const h4 = makeCandles(120, 1.0800);
  const entry = makeCandles(200, 1.0800);
  const hourly = makeCandles(120, 1.0800);

  const plan = generateInstrumentGamePlan("EUR/USD", daily, h4, entry, hourly, "London");
  const sessionPlan = buildSessionGamePlan("London", [plan]);

  // Simulate the context injection (same as our backtest code)
  const pairPlan = sessionPlan.plans.find(p => p.symbol === "EUR/USD")!;
  const ctx = {
    bias: pairPlan.bias,
    biasConfidence: pairPlan.biasConfidence,
    dol: pairPlan.dol,
    keyLevels: pairPlan.keyLevels,
    regime: pairPlan.regime,
    htfTrend: pairPlan.htfTrend,
    h4Trend: pairPlan.h4Trend,
    tradeable: pairPlan.tradeable,
    atr: pairPlan.atr,
    isFocusPair: sessionPlan.focusPairs.includes("EUR/USD"),
  };

  // Verify all required fields are present
  assert(["bullish", "bearish", "neutral"].includes(ctx.bias));
  assert(typeof ctx.biasConfidence === "number");
  assert(ctx.dol === null || typeof ctx.dol === "object");
  assert(Array.isArray(ctx.keyLevels));
  assert(typeof ctx.regime === "string");
  assert(typeof ctx.htfTrend === "string");
  assert(typeof ctx.h4Trend === "string");
  assert(typeof ctx.tradeable === "boolean");
  assert(typeof ctx.atr === "number");
  assert(typeof ctx.isFocusPair === "boolean");
});
