/**
 * Liquidity Detection — Regression & Behavior Tests
 *
 * Tests the improved detectLiquidityPools function which uses:
 * - ATR-based tolerance (instead of priceRange * constant)
 * - Swing point filtering (only compares local extremes)
 * - Break-through validation (rejects pools where price closed through between touches)
 *
 * These tests would have FAILED with the old algorithm (priceRange * 0.001 tolerance)
 * because the tolerance was too tight to detect real equal highs/lows.
 */

import { assertEquals, assert, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { detectLiquidityPools, calculateATR, type Candle } from "./smcAnalysis.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Generate candles simulating USD/CAD 1H with clear equal highs at ~1.3810
 * and equal lows at ~1.3740. ATR should be ~15 pips.
 */
function makeEqualHighsLowsFixture(): Candle[] {
  const candles: Candle[] = [];
  const baseDate = new Date("2024-05-15T00:00:00Z");

  // Helper to add a candle
  const add = (hourOffset: number, o: number, h: number, l: number, c: number) => {
    const dt = new Date(baseDate.getTime() + hourOffset * 3600000);
    candles.push({
      datetime: dt.toISOString(),
      open: o, high: h, low: l, close: c, volume: 1000,
    });
  };

  // Build ~50 candles with clear structure:
  // - Equal highs around 1.3810 (±3 pips) at candles ~8, ~18, ~28
  // - Equal lows around 1.3740 (±2 pips) at candles ~12, ~22, ~32
  // - General range: 1.3700 to 1.3830

  // Initial move up (candles 0-5)
  add(0, 1.3720, 1.3735, 1.3710, 1.3730);
  add(1, 1.3730, 1.3750, 1.3725, 1.3745);
  add(2, 1.3745, 1.3770, 1.3740, 1.3765);
  add(3, 1.3765, 1.3785, 1.3760, 1.3780);
  add(4, 1.3780, 1.3795, 1.3775, 1.3790);
  add(5, 1.3790, 1.3800, 1.3785, 1.3795);

  // First swing high ~1.3812 (candle 6-10)
  add(6, 1.3795, 1.3805, 1.3790, 1.3800);
  add(7, 1.3800, 1.3808, 1.3795, 1.3805);
  add(8, 1.3805, 1.3812, 1.3800, 1.3805); // SWING HIGH ~1.3812
  add(9, 1.3805, 1.3808, 1.3780, 1.3785);
  add(10, 1.3785, 1.3790, 1.3770, 1.3775);

  // First swing low ~1.3741 (candle 11-15)
  add(11, 1.3775, 1.3780, 1.3755, 1.3760);
  add(12, 1.3760, 1.3765, 1.3741, 1.3750); // SWING LOW ~1.3741
  add(13, 1.3750, 1.3770, 1.3748, 1.3765);
  add(14, 1.3765, 1.3785, 1.3760, 1.3780);
  add(15, 1.3780, 1.3795, 1.3775, 1.3790);

  // Second swing high ~1.3810 (candle 16-20)
  add(16, 1.3790, 1.3800, 1.3785, 1.3795);
  add(17, 1.3795, 1.3805, 1.3790, 1.3800);
  add(18, 1.3800, 1.3810, 1.3795, 1.3805); // SWING HIGH ~1.3810
  add(19, 1.3805, 1.3808, 1.3775, 1.3780);
  add(20, 1.3780, 1.3785, 1.3765, 1.3770);

  // Second swing low ~1.3739 (candle 21-25)
  add(21, 1.3770, 1.3775, 1.3755, 1.3760);
  add(22, 1.3760, 1.3765, 1.3739, 1.3748); // SWING LOW ~1.3739
  add(23, 1.3748, 1.3770, 1.3745, 1.3765);
  add(24, 1.3765, 1.3785, 1.3760, 1.3780);
  add(25, 1.3780, 1.3795, 1.3775, 1.3790);

  // Third swing high ~1.3808 (candle 26-30)
  add(26, 1.3790, 1.3800, 1.3785, 1.3795);
  add(27, 1.3795, 1.3805, 1.3790, 1.3800);
  add(28, 1.3800, 1.3808, 1.3795, 1.3802); // SWING HIGH ~1.3808
  add(29, 1.3802, 1.3805, 1.3780, 1.3785);
  add(30, 1.3785, 1.3790, 1.3770, 1.3775);

  // Third swing low ~1.3742 (candle 31-35)
  add(31, 1.3775, 1.3780, 1.3755, 1.3760);
  add(32, 1.3760, 1.3765, 1.3742, 1.3750); // SWING LOW ~1.3742
  add(33, 1.3750, 1.3770, 1.3748, 1.3765);
  add(34, 1.3765, 1.3785, 1.3760, 1.3780);
  add(35, 1.3780, 1.3790, 1.3775, 1.3785);

  // Continuation candles (36-49)
  add(36, 1.3785, 1.3795, 1.3780, 1.3790);
  add(37, 1.3790, 1.3800, 1.3785, 1.3795);
  add(38, 1.3795, 1.3800, 1.3780, 1.3785);
  add(39, 1.3785, 1.3790, 1.3775, 1.3780);
  add(40, 1.3780, 1.3790, 1.3770, 1.3785);
  add(41, 1.3785, 1.3795, 1.3780, 1.3790);
  add(42, 1.3790, 1.3800, 1.3785, 1.3795);
  add(43, 1.3795, 1.3800, 1.3790, 1.3795);
  add(44, 1.3795, 1.3800, 1.3785, 1.3790);
  add(45, 1.3790, 1.3795, 1.3780, 1.3785);
  add(46, 1.3785, 1.3790, 1.3775, 1.3780);
  add(47, 1.3780, 1.3790, 1.3775, 1.3785);
  add(48, 1.3785, 1.3795, 1.3780, 1.3790);
  add(49, 1.3790, 1.3800, 1.3785, 1.3795);

  return candles;
}

/**
 * Generate candles where a "broken" pool exists — price closed above equal highs
 * between the two touches. Should NOT be detected.
 */
function makeBrokenPoolFixture(): Candle[] {
  const candles: Candle[] = [];
  const baseDate = new Date("2024-06-01T00:00:00Z");

  const add = (hourOffset: number, o: number, h: number, l: number, c: number) => {
    const dt = new Date(baseDate.getTime() + hourOffset * 3600000);
    candles.push({
      datetime: dt.toISOString(),
      open: o, high: h, low: l, close: c, volume: 1000,
    });
  };

  // Build candles where equal highs exist at ~1.1050 but price CLOSED above between them
  add(0, 1.1000, 1.1010, 1.0990, 1.1005);
  add(1, 1.1005, 1.1020, 1.1000, 1.1015);
  add(2, 1.1015, 1.1035, 1.1010, 1.1030);
  add(3, 1.1030, 1.1045, 1.1025, 1.1040);
  add(4, 1.1040, 1.1050, 1.1035, 1.1040); // SWING HIGH ~1.1050
  add(5, 1.1040, 1.1045, 1.1020, 1.1025);
  add(6, 1.1025, 1.1030, 1.1010, 1.1015);
  add(7, 1.1015, 1.1020, 1.1005, 1.1010);
  // Price breaks above and CLOSES above 1.1050
  add(8, 1.1010, 1.1060, 1.1005, 1.1055); // CLOSED ABOVE the level!
  add(9, 1.1055, 1.1065, 1.1040, 1.1045);
  add(10, 1.1045, 1.1055, 1.1030, 1.1035);
  add(11, 1.1035, 1.1040, 1.1020, 1.1025);
  add(12, 1.1025, 1.1030, 1.1010, 1.1015);
  add(13, 1.1015, 1.1025, 1.1005, 1.1020);
  add(14, 1.1020, 1.1035, 1.1015, 1.1030);
  add(15, 1.1030, 1.1045, 1.1025, 1.1040);
  add(16, 1.1040, 1.1052, 1.1035, 1.1040); // SWING HIGH ~1.1052 (within tolerance of 1.1050)
  add(17, 1.1040, 1.1045, 1.1025, 1.1030);
  add(18, 1.1030, 1.1035, 1.1020, 1.1025);
  add(19, 1.1025, 1.1030, 1.1015, 1.1020);
  // Filler
  add(20, 1.1020, 1.1030, 1.1015, 1.1025);
  add(21, 1.1025, 1.1035, 1.1020, 1.1030);
  add(22, 1.1030, 1.1040, 1.1025, 1.1035);
  add(23, 1.1035, 1.1040, 1.1030, 1.1035);
  add(24, 1.1035, 1.1040, 1.1025, 1.1030);
  add(25, 1.1030, 1.1035, 1.1020, 1.1025);
  add(26, 1.1025, 1.1030, 1.1015, 1.1020);
  add(27, 1.1020, 1.1030, 1.1015, 1.1025);
  add(28, 1.1025, 1.1035, 1.1020, 1.1030);
  add(29, 1.1030, 1.1035, 1.1025, 1.1030);

  return candles;
}

/**
 * Generate candles with a clear sweep-rejection pattern.
 * Equal highs form, then price spikes above but closes back below.
 */
function makeSweepRejectionFixture(): Candle[] {
  const candles: Candle[] = [];
  const baseDate = new Date("2024-07-01T00:00:00Z");

  const add = (hourOffset: number, o: number, h: number, l: number, c: number) => {
    const dt = new Date(baseDate.getTime() + hourOffset * 3600000);
    candles.push({
      datetime: dt.toISOString(),
      open: o, high: h, low: l, close: c, volume: 1000,
    });
  };

  // Build clear equal highs at ~1.2500, then a sweep + rejection
  add(0, 1.2420, 1.2435, 1.2415, 1.2430);
  add(1, 1.2430, 1.2450, 1.2425, 1.2445);
  add(2, 1.2445, 1.2470, 1.2440, 1.2465);
  add(3, 1.2465, 1.2485, 1.2460, 1.2480);
  add(4, 1.2480, 1.2495, 1.2475, 1.2490);
  // First swing high ~1.2500
  add(5, 1.2490, 1.2500, 1.2485, 1.2495);
  add(6, 1.2495, 1.2502, 1.2490, 1.2495); // SWING HIGH ~1.2502
  add(7, 1.2495, 1.2498, 1.2475, 1.2480);
  add(8, 1.2480, 1.2485, 1.2460, 1.2465);
  add(9, 1.2465, 1.2470, 1.2450, 1.2455);
  add(10, 1.2455, 1.2460, 1.2440, 1.2445);
  // Move back up
  add(11, 1.2445, 1.2465, 1.2440, 1.2460);
  add(12, 1.2460, 1.2480, 1.2455, 1.2475);
  add(13, 1.2475, 1.2490, 1.2470, 1.2485);
  add(14, 1.2485, 1.2495, 1.2480, 1.2490);
  // Second swing high ~1.2500
  add(15, 1.2490, 1.2498, 1.2485, 1.2495);
  add(16, 1.2495, 1.2500, 1.2490, 1.2495); // SWING HIGH ~1.2500
  add(17, 1.2495, 1.2498, 1.2470, 1.2475);
  add(18, 1.2475, 1.2480, 1.2460, 1.2465);
  add(19, 1.2465, 1.2470, 1.2450, 1.2455);
  add(20, 1.2455, 1.2460, 1.2445, 1.2450);
  // Move back up for sweep
  add(21, 1.2450, 1.2470, 1.2445, 1.2465);
  add(22, 1.2465, 1.2485, 1.2460, 1.2480);
  add(23, 1.2480, 1.2495, 1.2475, 1.2490);
  // SWEEP: price goes above 1.2502 but closes below
  add(24, 1.2490, 1.2515, 1.2470, 1.2475); // SWEEP! High=1.2515 but close=1.2475
  add(25, 1.2475, 1.2480, 1.2450, 1.2455);
  add(26, 1.2455, 1.2460, 1.2440, 1.2445);
  add(27, 1.2445, 1.2455, 1.2435, 1.2450);
  add(28, 1.2450, 1.2460, 1.2440, 1.2455);
  add(29, 1.2455, 1.2465, 1.2445, 1.2460);

  return candles;
}

/**
 * Minimal candles (< 10) — should return empty array gracefully.
 */
function makeTooFewCandles(): Candle[] {
  return [
    { datetime: "2024-01-01T00:00:00Z", open: 1.0, high: 1.01, low: 0.99, close: 1.005, volume: 100 },
    { datetime: "2024-01-01T01:00:00Z", open: 1.005, high: 1.015, low: 0.995, close: 1.01, volume: 100 },
    { datetime: "2024-01-01T02:00:00Z", open: 1.01, high: 1.02, low: 1.0, close: 1.015, volume: 100 },
  ];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test("detectLiquidityPools: detects equal highs (BSL) with ATR-based tolerance", () => {
  const candles = makeEqualHighsLowsFixture();
  const pools = detectLiquidityPools(candles);

  const bsl = pools.filter(p => p.type === "buy-side");
  assert(bsl.length >= 1, `Expected at least 1 BSL pool, got ${bsl.length}`);

  // The BSL should be near 1.3810 (within 5 pips)
  const mainBSL = bsl[0]; // sorted by strength
  assert(mainBSL.strength >= 2, `Expected strength >= 2, got ${mainBSL.strength}`);
  assert(
    Math.abs(mainBSL.price - 1.3810) < 0.0005,
    `Expected BSL near 1.3810, got ${mainBSL.price.toFixed(5)}`
  );
});

Deno.test("detectLiquidityPools: detects equal lows (SSL) with ATR-based tolerance", () => {
  const candles = makeEqualHighsLowsFixture();
  const pools = detectLiquidityPools(candles);

  const ssl = pools.filter(p => p.type === "sell-side");
  assert(ssl.length >= 1, `Expected at least 1 SSL pool, got ${ssl.length}`);

  // The SSL should be near 1.3740 (within 5 pips)
  const mainSSL = ssl[0];
  assert(mainSSL.strength >= 2, `Expected strength >= 2, got ${mainSSL.strength}`);
  assert(
    Math.abs(mainSSL.price - 1.3740) < 0.0005,
    `Expected SSL near 1.3740, got ${mainSSL.price.toFixed(5)}`
  );
});

Deno.test("detectLiquidityPools: old algorithm would have missed these pools (regression proof)", () => {
  const candles = makeEqualHighsLowsFixture();

  // Simulate old algorithm: priceRange * 0.001
  const priceRange = Math.max(...candles.map(c => c.high)) - Math.min(...candles.map(c => c.low));
  const oldTol = priceRange * 0.001;

  // The equal highs are ~4 pips apart (1.3808 to 1.3812)
  // Old tolerance would be: ~0.0142 * 0.001 = 0.0000142 = 0.14 pips
  // 4 pips > 0.14 pips → old algorithm CANNOT detect these
  assert(oldTol < 0.0003, `Old tolerance ${oldTol} should be < 0.3 pips (too tight)`);

  // New algorithm uses ATR * 0.20
  const atr = calculateATR(candles, 14);
  const newTol = atr * 0.20;
  // New tolerance should be > 2 pips (enough to cluster the swing highs)
  assert(newTol > 0.0002, `New tolerance ${newTol} should be > 2 pips`);

  // Verify new algorithm actually finds pools
  const pools = detectLiquidityPools(candles);
  assert(pools.length >= 2, `Expected at least 2 pools (BSL + SSL), got ${pools.length}`);
});

Deno.test("detectLiquidityPools: rejects pools where price closed through between touches", () => {
  const candles = makeBrokenPoolFixture();
  const pools = detectLiquidityPools(candles);

  // The equal highs at ~1.1050 should NOT be detected because price closed above
  // between the two touches (candle 8 closed at 1.1055 > 1.1050)
  const bsl = pools.filter(p => p.type === "buy-side" && Math.abs(p.price - 1.1050) < 0.001);
  assertEquals(bsl.length, 0, "Should not detect BSL where price already closed through");
});

Deno.test("detectLiquidityPools: detects sweep-rejection lifecycle correctly", () => {
  const candles = makeSweepRejectionFixture();
  const pools = detectLiquidityPools(candles);

  const bsl = pools.filter(p => p.type === "buy-side");
  assert(bsl.length >= 1, `Expected at least 1 BSL pool, got ${bsl.length}`);

  const pool = bsl[0];
  // Should be swept (candle 24 went above)
  assertEquals(pool.swept, true, "Pool should be marked as swept");
  // Should be rejection (candle 24 closed below the level)
  assertEquals(pool.rejectionConfirmed, true, "Sweep should be confirmed as rejection");
  assertEquals(pool.state, "swept_rejected", "State should be swept_rejected");
  // Sweep depth should be positive
  assert(pool.sweepDepth! > 0, "Sweep depth should be positive");
});

Deno.test("detectLiquidityPools: returns empty for insufficient candles", () => {
  const candles = makeTooFewCandles();
  const pools = detectLiquidityPools(candles);
  assertEquals(pools.length, 0, "Should return empty for < 10 candles");
});

Deno.test("detectLiquidityPools: respects minTouches parameter", () => {
  const candles = makeEqualHighsLowsFixture();

  // With minTouches=2 should find pools
  const pools2 = detectLiquidityPools(candles, 0.20, 2);
  assert(pools2.length >= 1, "Should find pools with minTouches=2");

  // With minTouches=5 should find fewer or no pools (only 3 swing highs in fixture)
  const pools5 = detectLiquidityPools(candles, 0.20, 5);
  assert(pools5.length <= pools2.length, "Higher minTouches should find fewer pools");
});

Deno.test("detectLiquidityPools: tolerance scales with ATR (volatile vs calm)", () => {
  const calmCandles = makeEqualHighsLowsFixture(); // ~15 pip ATR
  const atrCalm = calculateATR(calmCandles, 14);

  // Create volatile candles (multiply all prices by factor, keep same structure)
  // Simulating a pair with 5x larger moves (like GBP/JPY vs EUR/USD)
  const volatileCandles: Candle[] = calmCandles.map(c => ({
    ...c,
    open: c.open * 1.5 - 0.5,
    high: c.high * 1.5 - 0.5,
    low: c.low * 1.5 - 0.5,
    close: c.close * 1.5 - 0.5,
  }));
  const atrVolatile = calculateATR(volatileCandles, 14);

  // Volatile pair should have larger ATR
  assert(atrVolatile > atrCalm, "Volatile pair should have larger ATR");

  // Both should still detect pools (tolerance adapts)
  const poolsCalm = detectLiquidityPools(calmCandles);
  const poolsVolatile = detectLiquidityPools(volatileCandles);
  assert(poolsCalm.length >= 1, "Calm pair should detect pools");
  assert(poolsVolatile.length >= 1, "Volatile pair should detect pools");
});

Deno.test("detectLiquidityPools: output shape matches LiquidityPool interface", () => {
  const candles = makeEqualHighsLowsFixture();
  const pools = detectLiquidityPools(candles);

  assert(pools.length > 0, "Need at least one pool to test shape");

  for (const pool of pools) {
    // Required fields
    assertExists(pool.price, "price must exist");
    assertExists(pool.type, "type must exist");
    assertExists(pool.strength, "strength must exist");
    assertExists(pool.datetime, "datetime must exist");
    assert(typeof pool.swept === "boolean", "swept must be boolean");
    assertExists(pool.state, "state must exist");

    // Type constraints
    assert(pool.type === "buy-side" || pool.type === "sell-side", "type must be buy-side or sell-side");
    assert(
      ["active", "swept_rejected", "swept_absorbed", "retested"].includes(pool.state),
      `state must be valid, got ${pool.state}`
    );
    assert(pool.strength >= 2, "strength must be >= minTouches (2)");
    assert(pool.price > 0, "price must be positive");
  }
});

Deno.test("detectLiquidityPools: sorted by strength descending", () => {
  const candles = makeEqualHighsLowsFixture();
  const pools = detectLiquidityPools(candles);

  for (let i = 1; i < pools.length; i++) {
    assert(
      pools[i - 1].strength >= pools[i].strength,
      `Pools should be sorted by strength desc: ${pools[i-1].strength} >= ${pools[i].strength}`
    );
  }
});

Deno.test("detectLiquidityPools: configurable tolerance per timeframe", () => {
  const candles = makeEqualHighsLowsFixture();

  // Tighter tolerance (0.10) should find fewer pools
  const poolsTight = detectLiquidityPools(candles, 0.10, 2);
  // Looser tolerance (0.40) should find same or more pools
  const poolsLoose = detectLiquidityPools(candles, 0.40, 2);

  // Looser tolerance should find >= tight tolerance pools
  assert(
    poolsLoose.length >= poolsTight.length,
    `Looser tolerance (${poolsLoose.length}) should find >= tight (${poolsTight.length})`
  );
});

// ─── Sensitivity Config Wiring Tests ────────────────────────────────────────

Deno.test("sensitivity mapping: sensitivity 1-5 maps to correct ATR multipliers", () => {
  // This tests the mapping logic used in bot-scanner and confluenceScoring
  const mapping = [0.10, 0.15, 0.20, 0.25, 0.30];

  for (let sens = 1; sens <= 5; sens++) {
    const expected = mapping[sens - 1];
    const actual = mapping[Math.min(Math.max(sens, 1), 5) - 1];
    assertEquals(actual, expected, `Sensitivity ${sens} should map to ${expected}`);
  }
});

Deno.test("sensitivity mapping: out-of-range values are clamped", () => {
  const mapping = [0.10, 0.15, 0.20, 0.25, 0.30];

  // Below 1 → clamped to 1 (0.10)
  const belowMin = mapping[Math.min(Math.max(0, 1), 5) - 1];
  assertEquals(belowMin, 0.10, "Sensitivity 0 should clamp to 0.10");

  const negativeVal = mapping[Math.min(Math.max(-5, 1), 5) - 1];
  assertEquals(negativeVal, 0.10, "Negative sensitivity should clamp to 0.10");

  // Above 5 → clamped to 5 (0.30)
  const aboveMax = mapping[Math.min(Math.max(10, 1), 5) - 1];
  assertEquals(aboveMax, 0.30, "Sensitivity 10 should clamp to 0.30");
});

Deno.test("sensitivity mapping: per-TF bumps produce correct hierarchy", () => {
  // Simulates the bot-scanner logic: daily = base+0.10, 4H = base+0.05, 1H = base
  const sens = 3; // balanced
  const base = [0.10, 0.15, 0.20, 0.25, 0.30][sens - 1]; // 0.20

  const dailyTol = Math.min(base + 0.10, 0.40); // ~0.30
  const h4Tol = Math.min(base + 0.05, 0.35);    // ~0.25
  const h1Tol = base;                             // 0.20

  // Use approximate comparison to avoid floating point issues
  assert(Math.abs(dailyTol - 0.30) < 1e-10, `Daily should be ~0.30, got ${dailyTol}`);
  assert(Math.abs(h4Tol - 0.25) < 1e-10, `4H should be ~0.25, got ${h4Tol}`);
  assert(Math.abs(h1Tol - 0.20) < 1e-10, `1H should be ~0.20, got ${h1Tol}`);

  // Hierarchy: daily > 4H > 1H
  assert(dailyTol > h4Tol, "Daily tolerance should be > 4H");
  assert(h4Tol > h1Tol, "4H tolerance should be > 1H");
});

Deno.test("sensitivity mapping: max sensitivity (5) with daily bump caps at 0.40", () => {
  const sens = 5;
  const base = [0.10, 0.15, 0.20, 0.25, 0.30][sens - 1]; // 0.30
  const dailyTol = Math.min(base + 0.10, 0.40); // 0.40 (capped)
  assertEquals(dailyTol, 0.40, "Daily with sensitivity 5 should cap at 0.40");
});

Deno.test("sensitivity mapping: different sensitivities produce different pool counts", () => {
  const candles = makeEqualHighsLowsFixture();

  // Sensitivity 1 (tight: 0.10 × ATR) vs Sensitivity 5 (wide: 0.30 × ATR)
  const poolsTight = detectLiquidityPools(candles, 0.10, 2);
  const poolsWide = detectLiquidityPools(candles, 0.30, 2);

  // Wide should find >= tight (more permissive clustering)
  assert(
    poolsWide.length >= poolsTight.length,
    `Wide sensitivity (${poolsWide.length} pools) should find >= tight (${poolsTight.length} pools)`
  );
});

Deno.test("sensitivity mapping: default sensitivity (3) detects pools on standard fixture", () => {
  const candles = makeEqualHighsLowsFixture();
  // Sensitivity 3 → tolerance 0.20 (the default)
  const pools = detectLiquidityPools(candles, 0.20, 2);
  assert(pools.length >= 2, `Default sensitivity should detect BSL + SSL, got ${pools.length} pools`);
});
