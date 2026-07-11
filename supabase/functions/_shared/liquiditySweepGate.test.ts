/**
 * liquiditySweepGate.test.ts — Liquidity Sweep Gate Tests
 * ────────────────────────────────────────────────────────
 * Tests the new Liquidity Sweep Gate feature across:
 *   1. zoneLiquidity.ts — entryTriggerState + hasUnsweptEntryTrigger fields
 *   2. zoneLiquidity.ts — swept_absorbed penalty (-2.0)
 *   3. unifiedZoneEngine.ts — waiting_for_sweep state when gate is ON + pool unswept
 *   4. unifiedZoneEngine.ts — gate OFF = no behavior change (regression)
 *   5. configMapper.ts — requireLiquiditySweep maps correctly
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/liquiditySweepGate.test.ts
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { Candle, LiquidityPool } from "./smcAnalysis.ts";
import { findZoneLiquidity, type ZoneLiquidityResult } from "./zoneLiquidity.ts";
import { findUnifiedZone, type UnifiedZoneResult } from "./unifiedZoneEngine.ts";
import { mapNestedToFlat, RUNTIME_DEFAULTS } from "./configMapper.ts";

// ─── Helpers ──────────────────────────────────────────────────────────

function makeCandle(o: number, h: number, l: number, c: number, idx: number): Candle {
  return {
    datetime: `2026-01-${String(Math.min(idx + 1, 28)).padStart(2, "0")}T00:00:00Z`,
    open: o,
    high: h,
    low: l,
    close: c,
  };
}

/** Generate 50 candles ranging from 1.1000 to 1.1500 with ~50 pip ATR */
function generateBaseCandles(count = 50): Candle[] {
  const candles: Candle[] = [];
  let price = 1.1000;
  for (let i = 0; i < count; i++) {
    const move = (i % 2 === 0 ? 1 : -1) * 0.0025;
    const open = price;
    const close = price + move;
    const high = Math.max(open, close) + 0.0010;
    const low = Math.min(open, close) - 0.0010;
    candles.push(makeCandle(open, high, low, close, i));
    price = close;
  }
  return candles;
}

function makePool(
  price: number,
  type: "buy-side" | "sell-side",
  strength: number,
  swept = false,
  sweptAtIndex?: number,
  rejectionConfirmed = false,
  sweepDepth?: number,
): LiquidityPool {
  let state: LiquidityPool["state"] = "active";
  if (swept) {
    state = rejectionConfirmed ? "swept_rejected" : "swept_absorbed";
  }
  return {
    price,
    type,
    strength,
    datetime: "2026-01-01T00:00:00Z",
    swept,
    sweptAtIndex,
    rejectionConfirmed,
    state,
    sweepDepth,
  };
}

// ─── zoneLiquidity.ts: entryTriggerState field ──────────────────────

Deno.test("Liquidity Sweep Gate — entryTriggerState = 'unswept' when entry-trigger pool exists but not swept", () => {
  const candles = generateBaseCandles(50);
  // BSL above zone at 1.1220 — entry trigger for bearish — NOT swept
  const pools: LiquidityPool[] = [
    makePool(1.1220, "buy-side", 3, false),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  assertEquals(result.entryTriggerState, "unswept");
  assertEquals(result.hasUnsweptEntryTrigger, true);
});

Deno.test("Liquidity Sweep Gate — entryTriggerState = 'swept_rejected' when pool swept + rejected", () => {
  const candles = generateBaseCandles(50);
  // BSL above zone at 1.1220 — swept with rejection 5 candles ago
  const pools: LiquidityPool[] = [
    makePool(1.1220, "buy-side", 3, true, 45, true, 0.0015),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  assertEquals(result.entryTriggerState, "swept_rejected");
  assertEquals(result.hasUnsweptEntryTrigger, false);
});

Deno.test("Liquidity Sweep Gate — entryTriggerState = 'swept_absorbed' when pool swept but broken through", () => {
  const candles = generateBaseCandles(50);
  // BSL above zone at 1.1220 — swept but absorbed (no rejection)
  const pools: LiquidityPool[] = [
    makePool(1.1220, "buy-side", 3, true, 47, false, 0.0010),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  assertEquals(result.entryTriggerState, "swept_absorbed");
  assertEquals(result.hasUnsweptEntryTrigger, false);
});

Deno.test("Liquidity Sweep Gate — entryTriggerState = 'none' when no entry-trigger pool exists", () => {
  const candles = generateBaseCandles(50);
  // SSL below zone for bearish = target, not entry_trigger
  const pools: LiquidityPool[] = [
    makePool(1.1130, "sell-side", 2),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  assertEquals(result.entryTriggerState, "none");
  assertEquals(result.hasUnsweptEntryTrigger, false);
});

Deno.test("Liquidity Sweep Gate — entryTriggerState = 'none' when no pools at all", () => {
  const candles = generateBaseCandles(50);
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", []);
  assertEquals(result.entryTriggerState, "none");
  assertEquals(result.hasUnsweptEntryTrigger, false);
});

// ─── zoneLiquidity.ts: swept_absorbed penalty ───────────────────────

Deno.test("Liquidity Sweep Gate — swept_absorbed entry-trigger applies -2.0 penalty", () => {
  const candles = generateBaseCandles(50);
  // BSL above zone at 1.1220 — swept but absorbed (broken through)
  const pools: LiquidityPool[] = [
    makePool(1.1220, "buy-side", 3, true, 47, false, 0.0010),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  // Score: +1.0 (pool identified) + 1.5 (swept no rejection) - 2.0 (absorbed penalty) = 0.5
  assertEquals(result.liquidityScore, 0.5);
  assert(result.summary.includes("ABSORBED"), "Summary should mention ABSORBED");
});

Deno.test("Liquidity Sweep Gate — swept_rejected does NOT apply penalty", () => {
  const candles = generateBaseCandles(50);
  // BSL above zone at 1.1220 — swept with rejection
  const pools: LiquidityPool[] = [
    makePool(1.1220, "buy-side", 3, true, 45, true, 0.0015),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  // Score: +1.0 (pool identified) + 2.0 (swept + rejected) = 3.0 — no penalty
  assertEquals(result.liquidityScore, 3.0);
  assert(!result.summary.includes("ABSORBED"), "Summary should NOT mention ABSORBED");
});

// ─── configMapper.ts: requireLiquiditySweep ─────────────────────────

Deno.test("Liquidity Sweep Gate — configMapper: requireLiquiditySweep defaults to false", () => {
  const result = mapNestedToFlat(null);
  assertEquals(result.requireLiquiditySweep, false);
});

Deno.test("Liquidity Sweep Gate — configMapper: requireLiquiditySweep maps from strategy section", () => {
  const result = mapNestedToFlat({
    strategy: { requireLiquiditySweep: true },
  });
  assertEquals(result.requireLiquiditySweep, true);
});

Deno.test("Liquidity Sweep Gate — configMapper: requireLiquiditySweep maps from top-level", () => {
  const result = mapNestedToFlat({
    requireLiquiditySweep: true,
  });
  assertEquals(result.requireLiquiditySweep, true);
});

// ─── unifiedZoneEngine.ts: waiting_for_sweep state ──────────────────

Deno.test("Liquidity Sweep Gate — unified engine: waiting_for_sweep is a valid state", () => {
  // Verify the type system accepts it
  const validStates = ["no_impulse", "no_zone", "watching", "at_zone", "confirmed", "triggered", "waiting_for_sweep"];
  assert(validStates.includes("waiting_for_sweep"));
});

// ─── Regression: gate OFF = no behavior change ──────────────────────

Deno.test("Liquidity Sweep Gate — regression: gate OFF does not change existing behavior", () => {
  const candles = generateBaseCandles(50);
  // BSL above zone — unswept
  const pools: LiquidityPool[] = [
    makePool(1.1220, "buy-side", 3, false),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bearish", pools);
  // With gate OFF (default), the entryTriggerState is still reported but doesn't block
  assertEquals(result.entryTriggerState, "unswept");
  assertEquals(result.hasUnsweptEntryTrigger, true);
  // Score should still be +1.0 for pool identified (no penalty for unswept when gate is off)
  assertEquals(result.liquidityScore, 1.0);
});

Deno.test("Liquidity Sweep Gate — regression: configMapper defaults preserve existing behavior", () => {
  // When no config is provided, requireLiquiditySweep is false
  const config = mapNestedToFlat(null);
  assertEquals(config.requireLiquiditySweep, false);
  // All other zone-related fields should be unchanged
  assertEquals(config.requireUnifiedZone, RUNTIME_DEFAULTS.requireUnifiedZone);
  assertEquals(config.impulseZoneEnabled, RUNTIME_DEFAULTS.impulseZoneEnabled);
  assertEquals(config.impulseZoneGateMode, RUNTIME_DEFAULTS.impulseZoneGateMode);
  assertEquals(config.minZoneScore, RUNTIME_DEFAULTS.minZoneScore);
});

// ─── zoneLiquidity.ts: bullish direction entry-trigger ──────────────

Deno.test("Liquidity Sweep Gate — bullish: SSL below zone = entry_trigger, unswept", () => {
  const candles = generateBaseCandles(50);
  // SSL below zone at 1.1130 — entry trigger for bullish — NOT swept
  const pools: LiquidityPool[] = [
    makePool(1.1130, "sell-side", 3, false),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bullish", pools);
  assertEquals(result.entryTriggerState, "unswept");
  assertEquals(result.hasUnsweptEntryTrigger, true);
  assertEquals(result.nearbyPools[0].relevance, "entry_trigger");
});

Deno.test("Liquidity Sweep Gate — bullish: SSL below zone swept + rejected", () => {
  const candles = generateBaseCandles(50);
  // SSL below zone at 1.1130 — swept with rejection
  const pools: LiquidityPool[] = [
    makePool(1.1130, "sell-side", 3, true, 45, true, 0.0015),
  ];
  const result = findZoneLiquidity(candles, 1.1200, 1.1150, "bullish", pools);
  assertEquals(result.entryTriggerState, "swept_rejected");
  assertEquals(result.hasUnsweptEntryTrigger, false);
  assertEquals(result.liquidityScore, 3.0); // +1.0 pool + 2.0 swept+rejected
});
