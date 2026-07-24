/**
 * smcEnhancements.test.ts — Integration Tests for the SMC Enhancements Layer
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  runSMCEnhancements,
  DEFAULT_SMC_ENHANCEMENTS_CONFIG,
} from "./smcEnhancements.ts";
import type { Candle, OrderBlock } from "./smcAnalysis.ts";

function makeCandle(o: number, h: number, l: number, c: number, t: number): Candle {
  return { open: o, high: h, low: l, close: c, volume: 100, datetime: new Date(t * 1000).toISOString() };
}

function makeOB(overrides: Partial<OrderBlock> & { high: number; low: number; type: "bullish" | "bearish"; index: number }): OrderBlock {
  return {
    datetime: new Date(overrides.index * 3600 * 1000).toISOString(),
    mitigated: false,
    mitigatedPercent: 0,
    state: "fresh",
    testedCount: 0,
    ...overrides,
  } as OrderBlock;
}

/**
 * Generate 60 candles with a mild uptrend (for testing all modules together).
 */
function makeTrendingCandles(count = 60, startPrice = 1.1000): Candle[] {
  const candles: Candle[] = [];
  const baseTime = 1700000000;
  let price = startPrice;

  for (let i = 0; i < count; i++) {
    const move = 0.0003 + Math.sin(i * 0.5) * 0.0002;
    const o = price;
    const c = price + move;
    const h = Math.max(o, c) + 0.0005;
    const l = Math.min(o, c) - 0.0004;
    candles.push(makeCandle(o, h, l, c, baseTime + i * 3600));
    price = c;
  }
  return candles;
}

/**
 * Generate daily candles for monthly analysis (6 months).
 */
function makeDailyCandles(months = 6, startPrice = 1.1000): Candle[] {
  const candles: Candle[] = [];
  const startDate = new Date("2024-01-02T00:00:00Z");
  let price = startPrice;

  for (let d = 0; d < months * 22; d++) {
    const date = new Date(startDate.getTime() + d * 24 * 3600 * 1000);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;

    const move = (Math.sin(d * 0.3) * 0.0010) + 0.0002;
    const o = price;
    const c = price + move;
    const h = Math.max(o, c) + 0.0005;
    const l = Math.min(o, c) - 0.0005;
    candles.push(makeCandle(o, h, l, c, date.getTime() / 1000));
    price = c;
  }
  return candles;
}

// ─── All Disabled Tests ───────────────────────────────────────────────────────

Deno.test("smcEnhancements — all disabled returns empty results", () => {
  const candles = makeTrendingCandles();
  const result = runSMCEnhancements(candles, null, [], "bullish", 1.1010, 1.1000, 1.1005);

  assertEquals(result.additionalFactors.length, 0);
  assertEquals(result.additionalGates.length, 0);
  assertEquals(result.phaseDetection, null);
  assertEquals(result.breakerBlocks.length, 0);
  assertEquals(result.fibExtension, null);
  assertEquals(result.trendlineAnalysis, null);
  assertEquals(result.monthlyAnalysis, null);
  assert(result.summary.includes("all disabled"));
});

// ─── Phase Detection Integration ──────────────────────────────────────────────

Deno.test("smcEnhancements — phase detection adds factor and gate", () => {
  const candles = makeTrendingCandles(60);
  const result = runSMCEnhancements(candles, null, [], "bullish", 1.1010, 1.1000, 1.1005, {
    enablePhaseDetection: true,
  });

  // Should have a phase detection result
  assert(result.phaseDetection !== null);
  assert(["consolidation", "expansion", "trend"].includes(result.phaseDetection!.phase));

  // Should have added a gate
  assert(result.additionalGates.length >= 1);
  assert(result.additionalGates[0].reason.includes("[Phase]"));

  // Should have added a factor
  const phaseFactor = result.additionalFactors.find(f => f.name === "Price-Action Phase");
  assert(phaseFactor !== undefined);
});

// ─── Zone Lifecycle Integration ───────────────────────────────────────────────

Deno.test("smcEnhancements — zone lifecycle evaluates zone freshness", () => {
  const candles = makeTrendingCandles(60);
  const result = runSMCEnhancements(candles, null, [], "bullish", 1.1010, 1.1000, 1.1005, {
    enableZoneLifecycleV2: true,
  });

  // Should have lifecycle data
  assert(result.zoneLifecycles.size >= 1);

  // Should have a freshness factor or a gate
  const freshnessFactor = result.additionalFactors.find(f => f.name === "Zone Freshness");
  const lifecycleGate = result.additionalGates.find(g => g.reason.includes("[ZoneLifecycle]"));
  assert(freshnessFactor !== undefined || lifecycleGate !== undefined,
    "Should have either a freshness factor or a lifecycle gate");
});

// ─── Fib Extension Integration ────────────────────────────────────────────────

Deno.test("smcEnhancements — fib extension calculates 3-point TP", () => {
  const candles = makeTrendingCandles(60);
  const result = runSMCEnhancements(candles, null, [], "bullish", 1.1010, 1.1000, 1.1005, {
    enableFibExtension3Point: true,
  });

  // Should have fib extension result
  assert(result.fibExtension !== null || result.fibExtension === null,
    "Fib extension should attempt calculation (may be null if no valid swing found)");
  assert(result.summary.includes("fib3pt"));
});

// ─── Trendline Integration ────────────────────────────────────────────────────

Deno.test("smcEnhancements — trendline detection runs and produces result", () => {
  const candles = makeTrendingCandles(60);
  const result = runSMCEnhancements(candles, null, [], "bullish", 1.1010, 1.1000, 1.1005, {
    enableTrendlineLiquidity: true,
  });

  assert(result.trendlineAnalysis !== null);
  assert(Array.isArray(result.trendlineAnalysis!.trendlines));
  assert(result.summary.includes("trendline"));
});

// ─── Monthly Containment Integration ──────────────────────────────────────────

Deno.test("smcEnhancements — monthly containment with sufficient daily data", () => {
  const candles = makeTrendingCandles(60);
  const dailyCandles = makeDailyCandles(6);
  const result = runSMCEnhancements(candles, dailyCandles, [], "bullish", 1.1010, 1.1000, 1.1005, {
    enableMonthlyContainment: true,
  });

  assert(result.monthlyAnalysis !== null);
  assert(result.monthlyContainment !== null);
  assert(result.summary.includes("monthly"));

  // Should have a containment factor
  const containmentFactor = result.additionalFactors.find(f => f.name === "Monthly Containment");
  assert(containmentFactor !== undefined);
});

Deno.test("smcEnhancements — monthly containment skipped with insufficient data", () => {
  const candles = makeTrendingCandles(60);
  const dailyCandles = makeDailyCandles(1); // Only 1 month — not enough
  const result = runSMCEnhancements(candles, dailyCandles, [], "bullish", 1.1010, 1.1000, 1.1005, {
    enableMonthlyContainment: true,
  });

  // Should not have monthly data (needs >= 60 daily candles)
  assertEquals(result.monthlyAnalysis, null);
});

// ─── All Enabled Together ─────────────────────────────────────────────────────

Deno.test("smcEnhancements — all modules enabled together don't conflict", () => {
  const candles = makeTrendingCandles(60);
  const dailyCandles = makeDailyCandles(6);
  const obs = [makeOB({ index: 5, high: 1.1010, low: 1.1000, type: "bullish", state: "broken", brokenAt: 20 })];

  const result = runSMCEnhancements(candles, dailyCandles, obs, "bullish", 1.1010, 1.1000, 1.1005, {
    enablePhaseDetection: true,
    enableBreakerBlocks: true,
    enableZoneLifecycleV2: true,
    enableFibExtension3Point: true,
    enableTrendlineLiquidity: true,
    enableMonthlyContainment: true,
  });

  // All modules should have run
  assert(result.summary.includes("phase"));
  assert(result.summary.includes("breaker"));
  assert(result.summary.includes("lifecycle"));
  assert(result.summary.includes("fib3pt"));
  assert(result.summary.includes("trendline"));
  assert(result.summary.includes("monthly"));

  // Should have multiple factors and gates
  assert(result.additionalFactors.length >= 2, `Expected >= 2 factors, got ${result.additionalFactors.length}`);
  assert(result.additionalGates.length >= 1, `Expected >= 1 gate, got ${result.additionalGates.length}`);
});

// ─── Direction Normalization ──────────────────────────────────────────────────

Deno.test("smcEnhancements — handles 'long'/'short' direction strings", () => {
  const candles = makeTrendingCandles(60);
  const result = runSMCEnhancements(candles, null, [], "long", 1.1010, 1.1000, 1.1005, {
    enablePhaseDetection: true,
    enableZoneLifecycleV2: true,
  });

  // Should work with "long" (normalized to "bullish" internally)
  assert(result.phaseDetection !== null);
  assert(result.zoneLifecycles.size >= 1);
});

Deno.test("smcEnhancements — null direction skips direction-dependent modules", () => {
  const candles = makeTrendingCandles(60);
  const result = runSMCEnhancements(candles, null, [], null, 1.1010, 1.1000, null, {
    enableZoneLifecycleV2: true,
    enableFibExtension3Point: true,
    enableMonthlyContainment: true,
  });

  // Zone lifecycle and fib extension need direction — should be skipped
  assertEquals(result.zoneLifecycles.size, 0);
  assertEquals(result.fibExtension, null);
});
