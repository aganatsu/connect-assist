/**
 * instrumentBuffers.test.ts — Tests for per-instrument SL buffer override logic.
 *
 * Verifies:
 *   1. When instrumentBuffers has an override for a symbol, that value is used directly
 *      (no asset-class multiplier applied).
 *   2. When no override exists, the global slBufferPips × asset-class multiplier is used.
 *   3. Regression: forex pairs without overrides still use the original calculation.
 *
 * Run: deno test --allow-all supabase/functions/_shared/instrumentBuffers.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SPECS, ASSET_PROFILES, getAssetProfile } from "./smcAnalysis.ts";

// ─── Replicate the buffer resolution logic from bot-scanner/index.ts ──
// This is the exact logic we added — extracted here for unit testing.
function resolveAdjustedSlBuffer(
  symbol: string,
  globalSlBufferPips: number,
  instrumentBuffers: Record<string, { slBufferPips?: number }>,
): number {
  const symbolBufferOverride = instrumentBuffers?.[symbol]?.slBufferPips;
  const assetProfile = getAssetProfile(symbol);
  return symbolBufferOverride != null
    ? symbolBufferOverride
    : globalSlBufferPips * assetProfile.slBufferMultiplier;
}

// ─── Test 1: Override is used directly for XAU/USD ──
Deno.test("instrumentBuffers: XAU/USD override bypasses multiplier", () => {
  const result = resolveAdjustedSlBuffer("XAU/USD", 2, {
    "XAU/USD": { slBufferPips: 150 },
  });
  // Override = 150, should be used directly (NOT 150 * 2.0 commodity multiplier)
  assertEquals(result, 150);
});

// ─── Test 2: Override is used directly for BTC/USD ──
Deno.test("instrumentBuffers: BTC/USD override bypasses multiplier", () => {
  const result = resolveAdjustedSlBuffer("BTC/USD", 2, {
    "BTC/USD": { slBufferPips: 100 },
  });
  assertEquals(result, 100);
});

// ─── Test 3: No override → falls back to global × multiplier (commodity) ──
Deno.test("instrumentBuffers: no override for XAU/USD uses global × commodity multiplier", () => {
  const result = resolveAdjustedSlBuffer("XAU/USD", 2, {});
  const expected = 2 * getAssetProfile("XAU/USD").slBufferMultiplier;
  assertEquals(result, expected);
  // Commodity multiplier is 2.0, so result should be 4
  assertEquals(result, 4);
});

// ─── Test 4: No override → falls back to global × multiplier (forex) ──
Deno.test("instrumentBuffers: EUR/USD (forex) uses global × 1.0 multiplier", () => {
  const result = resolveAdjustedSlBuffer("EUR/USD", 2, {});
  const expected = 2 * getAssetProfile("EUR/USD").slBufferMultiplier;
  assertEquals(result, expected);
  // Forex multiplier is 1.0, so result should be 2
  assertEquals(result, 2);
});

// ─── Test 5: No override → index uses global × index multiplier ──
Deno.test("instrumentBuffers: US30 (index) uses global × 3.0 multiplier", () => {
  const result = resolveAdjustedSlBuffer("US30", 2, {});
  const expected = 2 * getAssetProfile("US30").slBufferMultiplier;
  assertEquals(result, expected);
  // Index multiplier is 3.0, so result should be 6
  assertEquals(result, 6);
});

// ─── Test 6: Override for one symbol doesn't affect another ──
Deno.test("instrumentBuffers: override for XAU doesn't affect XAG", () => {
  const buffers = { "XAU/USD": { slBufferPips: 150 } };
  const xauResult = resolveAdjustedSlBuffer("XAU/USD", 2, buffers);
  const xagResult = resolveAdjustedSlBuffer("XAG/USD", 2, buffers);
  assertEquals(xauResult, 150); // override
  assertEquals(xagResult, 4);   // global × commodity multiplier (2 × 2.0)
});

// ─── Test 7: Price distance calculation with override ──
Deno.test("instrumentBuffers: XAU/USD override produces correct price distance", () => {
  const adjustedBuffer = resolveAdjustedSlBuffer("XAU/USD", 2, {
    "XAU/USD": { slBufferPips: 150 },
  });
  const spec = SPECS["XAU/USD"];
  const priceDistance = adjustedBuffer * spec.pipSize;
  // 150 × 0.01 = $1.50
  assertEquals(priceDistance, 1.5);
});

// ─── Test 8: Regression — without override, XAU/USD buffer is dangerously small ──
Deno.test("instrumentBuffers: regression — without override XAU buffer is only $0.04", () => {
  const adjustedBuffer = resolveAdjustedSlBuffer("XAU/USD", 2, {});
  const spec = SPECS["XAU/USD"];
  const priceDistance = adjustedBuffer * spec.pipSize;
  // 2 × 2.0 × 0.01 = $0.04 — this is the bug we're fixing
  assertEquals(priceDistance, 0.04);
  // Confirm this is indeed too small for gold
  assert(priceDistance < 0.10, "Without override, gold buffer is dangerously small");
});

// ─── Test 9: All recommended defaults produce reasonable price distances ──
Deno.test("instrumentBuffers: recommended defaults produce reasonable price distances", () => {
  const recommendedBuffers: Record<string, { slBufferPips: number }> = {
    "XAU/USD": { slBufferPips: 150 },
    "XAG/USD": { slBufferPips: 200 },
    "BTC/USD": { slBufferPips: 100 },
    "ETH/USD": { slBufferPips: 200 },
    "US Oil":  { slBufferPips: 100 },
  };

  const expected: Record<string, { min: number; max: number }> = {
    "XAU/USD": { min: 1.0, max: 3.0 },   // $1.50
    "XAG/USD": { min: 0.10, max: 0.50 },  // $0.20
    "BTC/USD": { min: 50, max: 200 },      // $100
    "ETH/USD": { min: 1.0, max: 5.0 },    // $2.00
    "US Oil":  { min: 0.50, max: 2.0 },    // $1.00
  };

  for (const [symbol, buffer] of Object.entries(recommendedBuffers)) {
    const adjustedBuffer = resolveAdjustedSlBuffer(symbol, 2, recommendedBuffers);
    const spec = SPECS[symbol];
    const priceDistance = adjustedBuffer * spec.pipSize;
    const range = expected[symbol];
    assert(
      priceDistance >= range.min && priceDistance <= range.max,
      `${symbol}: price distance ${priceDistance} not in expected range [${range.min}, ${range.max}]`
    );
  }
});
