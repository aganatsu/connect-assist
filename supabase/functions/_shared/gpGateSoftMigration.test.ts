/**
 * GP Gate Soft Migration — Phase 7 Tests
 *
 * Tests that the legacy game plan filter gate no longer blocks trades.
 * The filterTradeByGamePlan function still runs for logging, but its
 * `allowed: false` result no longer produces a `passed: false` gate.
 *
 * Verifies:
 * 1. filterTradeByGamePlan still correctly identifies opposing bias
 * 2. filterTradeByGamePlan still correctly identifies aligned bias
 * 3. filterTradeByGamePlan handles missing game plan gracefully
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { filterTradeByGamePlan } from "./gamePlan.ts";
import type { SessionGamePlan, InstrumentGamePlan } from "./gamePlan.ts";

function makeGamePlan(plans: Partial<InstrumentGamePlan>[]): SessionGamePlan {
  return {
    session: "london",
    generatedAt: new Date().toISOString(),
    focusPairs: plans.map(p => p.symbol || ""),
    plans: plans.map(p => ({
      symbol: p.symbol || "EUR/USD",
      session: "london",
      bias: p.bias || "bullish",
      biasConfidence: p.biasConfidence ?? 75,
      biasReasoning: ["test"],
      dol: null,
      keyLevels: [],
      scenarios: [],
      regime: "trending",
      amdPhase: "distribution",
      zone: "discount",
      zonePercent: 30,
      htfTrend: "bullish",
      h4Trend: "bullish",
      atr: 0.0050,
      tradeable: true,
      lastPrice: 1.0800,
      generatedAt: new Date().toISOString(),
      ...p,
    })) as InstrumentGamePlan[],
    newsEvents: [],
    summary: "Test game plan",
  };
}

Deno.test("GP Gate Soft: filterTradeByGamePlan still detects opposing bias", () => {
  const gp = makeGamePlan([{ symbol: "EUR/USD", bias: "bearish", biasConfidence: 80 }]);
  const result = filterTradeByGamePlan(gp, "EUR/USD", "long");

  // The function should still correctly identify the opposition
  assertEquals(result.allowed, false, "Should detect opposing bias");
  assert(result.reason.length > 0, "Should provide a reason");
});

Deno.test("GP Gate Soft: filterTradeByGamePlan still detects aligned bias", () => {
  const gp = makeGamePlan([{ symbol: "EUR/USD", bias: "bullish", biasConfidence: 80 }]);
  const result = filterTradeByGamePlan(gp, "EUR/USD", "long");

  assertEquals(result.allowed, true, "Should allow aligned bias");
});

Deno.test("GP Gate Soft: filterTradeByGamePlan handles missing game plan", () => {
  const result = filterTradeByGamePlan(null as any, "EUR/USD", "long");

  assertEquals(result.allowed, true, "Should allow when no game plan");
});

Deno.test("GP Gate Soft: filterTradeByGamePlan handles neutral bias", () => {
  const gp = makeGamePlan([{ symbol: "EUR/USD", bias: "neutral", biasConfidence: 60 }]);
  const result = filterTradeByGamePlan(gp, "EUR/USD", "long");

  assertEquals(result.allowed, true, "Should allow when bias is neutral");
});

Deno.test("GP Gate Soft: filterTradeByGamePlan handles pair not in game plan", () => {
  const gp = makeGamePlan([{ symbol: "GBP/USD", bias: "bearish", biasConfidence: 80 }]);
  const result = filterTradeByGamePlan(gp, "EUR/USD", "long");

  assertEquals(result.allowed, true, "Should allow when pair not in game plan");
});
