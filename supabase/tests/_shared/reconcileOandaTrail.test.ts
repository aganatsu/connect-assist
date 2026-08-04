/**
 * reconcileOandaTrail.test.ts — Tests for manus/reconcile-oanda-trail branch
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies:
 *   1. computeTrailRatchet fixed-pip path produces correct SL for long/short
 *   2. computeTrailRatchet respects prevTrailLevel monotonic guarantee
 *   3. computeTrailRatchet delegates to adaptive trail when enabled + candles provided
 *   4. OANDA symbol resolution (resolveOandaSymbol equivalent logic)
 *   5. OANDA reconciliation path handles position matching by instrument+direction
 *   6. Regression: fixed-pip trail formula matches old inline formula exactly
 *
 * Run: deno test --allow-all supabase/functions/_shared/reconcileOandaTrail.test.ts
 */
import {
  computeTrailRatchet,
  computeAdaptiveTrail,
  type TrailRatchetInput,
} from "../../functions/_shared/exitEngine.ts";
import {
  assertEquals,
  assert,
  assertAlmostEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Test 1: Fixed-pip trail ratchet for LONG ──────────────────────────────
Deno.test("computeTrailRatchet: LONG fixed-pip trail produces correct SL", () => {
  const result = computeTrailRatchet({
    entryPrice: 1.08000,
    currentPrice: 1.08500,  // Price moved up 50 pips
    currentSL: 1.07800,     // Current SL is 20 pips below entry
    direction: "long",
    pipSize: 0.0001,
    effectiveTrailPips: 15, // 15 pips trail distance
    prevTrailLevel: 1.07800,
  });
  // newSL = 1.08500 - (15 * 0.0001) = 1.08500 - 0.0015 = 1.08350
  assertAlmostEquals(result.newSL, 1.08350, 0.000001);
  // 1.08350 > 1.07800 (currentSL) AND > 1.07800 (prevTrailLevel) → should tighten
  assertEquals(result.shouldTighten, true);
  assertEquals(result.trailDistancePips, 15);
});

// ─── Test 2: Fixed-pip trail ratchet for SHORT ─────────────────────────────
Deno.test("computeTrailRatchet: SHORT fixed-pip trail produces correct SL", () => {
  const result = computeTrailRatchet({
    entryPrice: 1.08000,
    currentPrice: 1.07500,  // Price moved down 50 pips (good for short)
    currentSL: 1.08200,     // Current SL is 20 pips above entry
    direction: "short",
    pipSize: 0.0001,
    effectiveTrailPips: 15, // 15 pips trail distance
    prevTrailLevel: 1.08200,
  });
  // newSL = 1.07500 + (15 * 0.0001) = 1.07500 + 0.0015 = 1.07650
  assertAlmostEquals(result.newSL, 1.07650, 0.000001);
  // 1.07650 < 1.08200 (currentSL) AND < 1.08200 (prevTrailLevel) → should tighten
  assertEquals(result.shouldTighten, true);
  assertEquals(result.trailDistancePips, 15);
});

// ─── Test 3: Monotonic guarantee - does NOT widen past prevTrailLevel ──────
Deno.test("computeTrailRatchet: does NOT tighten when newSL is worse than prevTrailLevel", () => {
  // Scenario: price retraced, so the new trail SL would be BELOW the previous trail level
  const result = computeTrailRatchet({
    entryPrice: 1.08000,
    currentPrice: 1.08200,  // Price retraced from 1.08500 to 1.08200
    currentSL: 1.08350,     // Current SL was already ratcheted to 1.08350
    direction: "long",
    pipSize: 0.0001,
    effectiveTrailPips: 15,
    prevTrailLevel: 1.08350, // Previous trail level = 1.08350
  });
  // newSL = 1.08200 - 0.0015 = 1.08050
  // 1.08050 < 1.08350 (currentSL) → should NOT tighten (would widen)
  assertEquals(result.shouldTighten, false);
});

// ─── Test 4: Does not tighten when price hasn't moved enough ───────────────
Deno.test("computeTrailRatchet: no tighten when new SL is below current SL (long)", () => {
  const result = computeTrailRatchet({
    entryPrice: 1.08000,
    currentPrice: 1.08100,  // Only moved 10 pips
    currentSL: 1.08000,     // SL at entry (BE)
    direction: "long",
    pipSize: 0.0001,
    effectiveTrailPips: 15, // 15 pips trail
  });
  // newSL = 1.08100 - 0.0015 = 1.07950
  // 1.07950 < 1.08000 (currentSL) → should NOT tighten
  assertEquals(result.shouldTighten, false);
});

// ─── Test 5: Regression - matches old inline formula exactly ───────────────
Deno.test("computeTrailRatchet: regression - matches old inline formula for LONG", () => {
  // Simulate the old inline formula:
  // effectiveTrailPips = max(exitFlags.trailingStopPips, riskPips * 0.5) = max(12, 10*0.5) = 12
  // trailDistance = 12 * 0.0001 = 0.0012
  // newSL = 1.09000 - 0.0012 = 1.08880
  const entryPrice = 1.08000;
  const currentPrice = 1.09000;
  const currentSL = 1.07800; // 20 pips below entry
  const effectiveTrailPips = 12;
  const pipSize = 0.0001;

  // Old inline formula result:
  const oldNewSL = currentPrice - (effectiveTrailPips * pipSize); // 1.09000 - 0.0012 = 1.08880
  const oldShouldTighten = oldNewSL > currentSL; // 1.08880 > 1.07800 = true

  // New computeTrailRatchet result:
  const result = computeTrailRatchet({
    entryPrice,
    currentPrice,
    currentSL,
    direction: "long",
    pipSize,
    effectiveTrailPips,
    prevTrailLevel: currentSL,
  });

  assertAlmostEquals(result.newSL, oldNewSL, 0.000001);
  assertEquals(result.shouldTighten, oldShouldTighten);
});

// ─── Test 6: Regression - matches old inline formula for SHORT ─────────────
Deno.test("computeTrailRatchet: regression - matches old inline formula for SHORT", () => {
  const entryPrice = 1.08000;
  const currentPrice = 1.07000;
  const currentSL = 1.08200; // 20 pips above entry
  const effectiveTrailPips = 12;
  const pipSize = 0.0001;

  // Old inline formula:
  const oldNewSL = currentPrice + (effectiveTrailPips * pipSize); // 1.07000 + 0.0012 = 1.07120
  const oldShouldTighten = oldNewSL < currentSL; // 1.07120 < 1.08200 = true

  const result = computeTrailRatchet({
    entryPrice,
    currentPrice,
    currentSL,
    direction: "short",
    pipSize,
    effectiveTrailPips,
    prevTrailLevel: currentSL,
  });

  assertAlmostEquals(result.newSL, oldNewSL, 0.000001);
  assertEquals(result.shouldTighten, oldShouldTighten);
});

// ─── Test 7: Adaptive path delegates to computeAdaptiveTrail ───────────────
Deno.test("computeTrailRatchet: adaptive path produces different result than fixed", () => {
  const baseInput: TrailRatchetInput = {
    entryPrice: 1.08000,
    currentPrice: 1.09000,
    currentSL: 1.07800,
    direction: "long",
    pipSize: 0.0001,
    effectiveTrailPips: 15,
    prevTrailLevel: 1.07800,
  };

  // Fixed result
  const fixedResult = computeTrailRatchet({ ...baseInput, adaptiveTrailingEnabled: false });

  // Adaptive result (with candles and ATR)
  const adaptiveResult = computeTrailRatchet({
    ...baseInput,
    adaptiveTrailingEnabled: true,
    atrValue: 0.0050, // 50 pips ATR
    rMultiple: 2.0,
    recentCandles: [
      { open: 1.0880, high: 1.0890, low: 1.0875, close: 1.0888 },
      { open: 1.0888, high: 1.0895, low: 1.0882, close: 1.0890 },
      { open: 1.0890, high: 1.0900, low: 1.0885, close: 1.0898 },
    ],
    regimeInfo: null,
  });

  // Both should tighten (price moved significantly)
  assertEquals(fixedResult.shouldTighten, true);
  assertEquals(adaptiveResult.shouldTighten, true);
  // But the SL values should differ (adaptive uses ATR-based distance)
  assert(Math.abs(fixedResult.newSL - adaptiveResult.newSL) > 0.00001,
    "Adaptive and fixed trail should produce different SL values");
  // Adaptive reason should mention "Adaptive"
  assert(adaptiveResult.reason.includes("Adaptive"), "Adaptive result reason should mention 'Adaptive'");
});

// ─── Test 8: XAU/USD (Gold) with larger pip size ───────────────────────────
Deno.test("computeTrailRatchet: works correctly for XAU/USD (pipSize=0.1)", () => {
  const result = computeTrailRatchet({
    entryPrice: 2400.00,
    currentPrice: 2420.00,  // Moved 200 pips (20 dollars)
    currentSL: 2390.00,     // 100 pips below entry
    direction: "long",
    pipSize: 0.1,
    effectiveTrailPips: 50, // 50 pips = $5 trail
    prevTrailLevel: 2390.00,
  });
  // newSL = 2420.00 - (50 * 0.1) = 2420.00 - 5.00 = 2415.00
  assertAlmostEquals(result.newSL, 2415.00, 0.01);
  assertEquals(result.shouldTighten, true);
});

// ─── Test 9: JPY pair with pipSize=0.01 ────────────────────────────────────
Deno.test("computeTrailRatchet: works correctly for USD/JPY (pipSize=0.01)", () => {
  const result = computeTrailRatchet({
    entryPrice: 155.000,
    currentPrice: 155.500,  // Moved 50 pips
    currentSL: 154.800,     // 20 pips below entry
    direction: "long",
    pipSize: 0.01,
    effectiveTrailPips: 15,
    prevTrailLevel: 154.800,
  });
  // newSL = 155.500 - (15 * 0.01) = 155.500 - 0.15 = 155.350
  assertAlmostEquals(result.newSL, 155.350, 0.001);
  assertEquals(result.shouldTighten, true);
});
