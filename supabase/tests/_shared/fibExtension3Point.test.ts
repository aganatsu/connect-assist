/**
 * fibExtension3Point.test.ts — Tests for 3-Point Fibonacci Extension TP Calculator
 */

import { assertEquals, assert, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  calculateFibExtension3Point,
  compareFibTPMethods,
  DEFAULT_FIB_EXTENSION_CONFIG,
} from "./fibExtension3Point.ts";

// ─── Basic Calculation Tests ──────────────────────────────────────────────────

Deno.test("fibExtension3Point — bullish: extensions measured from entry point C", () => {
  const result = calculateFibExtension3Point({
    swingOrigin: 1.1000,   // A
    swingEnd: 1.1100,      // B (impulse = 100 pips up)
    entryPrice: 1.1050,    // C (50% retracement)
    direction: "bullish",
  });

  // Impulse range = |B - A| = 0.0100
  assertAlmostEquals(result.impulseRange, 0.0100, 0.00001);

  // Retracement depth = |C - B| / |B - A| = 0.0050 / 0.0100 = 0.5
  assertAlmostEquals(result.retracementDepth, 0.5, 0.001);

  // -27.2% extension from C: 1.1050 + 0.0100 * 0.272 = 1.1050 + 0.00272 = 1.10772
  const ext272 = result.levels.find(l => l.ratio === 0.272);
  assert(ext272 !== undefined, "Should have 0.272 level");
  assertAlmostEquals(ext272!.price, 1.10772, 0.00001);

  // -100% extension from C: 1.1050 + 0.0100 * 1.0 = 1.1150
  const ext100 = result.levels.find(l => l.ratio === 1.0);
  assert(ext100 !== undefined, "Should have 1.0 level");
  assertAlmostEquals(ext100!.price, 1.1150, 0.00001);

  // -127.2% extension from C: 1.1050 + 0.0100 * 1.272 = 1.1177.2
  const ext127 = result.levels.find(l => l.ratio === 1.272);
  assert(ext127 !== undefined, "Should have 1.272 level");
  assertAlmostEquals(ext127!.price, 1.11772, 0.00001);
});

Deno.test("fibExtension3Point — bearish: extensions measured downward from entry", () => {
  const result = calculateFibExtension3Point({
    swingOrigin: 1.1100,   // A (high)
    swingEnd: 1.1000,      // B (impulse = 100 pips down)
    entryPrice: 1.1050,    // C (50% retracement up)
    direction: "bearish",
  });

  assertAlmostEquals(result.impulseRange, 0.0100, 0.00001);

  // -27.2% extension from C (downward): 1.1050 - 0.0100 * 0.272 = 1.10228
  const ext272 = result.levels.find(l => l.ratio === 0.272);
  assert(ext272 !== undefined);
  assertAlmostEquals(ext272!.price, 1.10228, 0.00001);

  // -100% extension from C: 1.1050 - 0.0100 = 1.0950
  const ext100 = result.levels.find(l => l.ratio === 1.0);
  assert(ext100 !== undefined);
  assertAlmostEquals(ext100!.price, 1.0950, 0.00001);
});

Deno.test("fibExtension3Point — recommended TP respects minimum R:R", () => {
  const result = calculateFibExtension3Point({
    swingOrigin: 1.1000,
    swingEnd: 1.1100,
    entryPrice: 1.1050,
    direction: "bullish",
  }, {
    minRR: 2.0,
    slDistance: 0.0020, // 20 pips SL
  });

  // Need TP distance >= 2.0 * 0.0020 = 0.0040
  // -27.2% = 0.00272 (R:R = 1.36) — too low
  // -61.8% = 0.00618 (R:R = 3.09) — meets requirement
  assert(result.recommendedTP !== null, "Should find a recommended TP");
  const ext618 = result.levels.find(l => l.ratio === 0.618);
  assertAlmostEquals(result.recommendedTP!, ext618!.price, 0.00001);
});

Deno.test("fibExtension3Point — no recommended TP when SL is too large", () => {
  const result = calculateFibExtension3Point({
    swingOrigin: 1.1000,
    swingEnd: 1.1100,
    entryPrice: 1.1050,
    direction: "bullish",
  }, {
    minRR: 5.0,
    slDistance: 0.0100, // 100 pips SL — no extension will give 5:1 R:R
  });

  // Max extension (1.618) gives 0.01618 / 0.01 = 1.618 R:R — below 5.0
  assertEquals(result.recommendedTP, null);
});

Deno.test("fibExtension3Point — zero impulse range returns empty", () => {
  const result = calculateFibExtension3Point({
    swingOrigin: 1.1000,
    swingEnd: 1.1000, // Same as origin
    entryPrice: 1.1000,
    direction: "bullish",
  });

  assertEquals(result.levels.length, 0);
  assertEquals(result.recommendedTP, null);
  assert(result.detail.includes("Zero impulse"));
});

Deno.test("fibExtension3Point — custom extension ratios work", () => {
  const result = calculateFibExtension3Point({
    swingOrigin: 1.1000,
    swingEnd: 1.1100,
    entryPrice: 1.1050,
    direction: "bullish",
  }, {
    extensionRatios: [0.5, 2.0],
  });

  assertEquals(result.levels.length, 2);
  assertEquals(result.levels[0].ratio, 0.5);
  assertEquals(result.levels[1].ratio, 2.0);
  assertAlmostEquals(result.levels[0].price, 1.1100, 0.00001); // 1.1050 + 0.01 * 0.5
  assertAlmostEquals(result.levels[1].price, 1.1250, 0.00001); // 1.1050 + 0.01 * 2.0
});

// ─── Comparison Tests ────────────────────────────────────────────────────────

Deno.test("compareFibTPMethods — new TP is closer to entry than old TP (bullish)", () => {
  const comparison = compareFibTPMethods({
    swingOrigin: 1.1000,
    swingEnd: 1.1100,
    entryPrice: 1.1050, // 50% retracement
    direction: "bullish",
  }, 1.272);

  // Old: 1.1000 + 0.01 * 2.272 = 1.12272
  // New: 1.1050 + 0.01 * 1.272 = 1.11772
  assertAlmostEquals(comparison.oldTP, 1.12272, 0.00001);
  assertAlmostEquals(comparison.newTP, 1.11772, 0.00001);

  // New TP should be closer to entry (lower for bullish)
  assert(comparison.newTP < comparison.oldTP, "New TP should be closer to entry for bullish");
  assert(comparison.difference > 0, "Should have a non-zero difference");
});

Deno.test("compareFibTPMethods — new TP is closer to entry than old TP (bearish)", () => {
  const comparison = compareFibTPMethods({
    swingOrigin: 1.1100,
    swingEnd: 1.1000,
    entryPrice: 1.1050,
    direction: "bearish",
  }, 1.272);

  // Old: 1.1100 - 0.01 * 2.272 = 1.0872.8
  // New: 1.1050 - 0.01 * 1.272 = 1.0922.8
  // New TP should be closer to entry (higher for bearish)
  assert(comparison.newTP > comparison.oldTP, "New TP should be closer to entry for bearish");
});

Deno.test("compareFibTPMethods — difference is proportional to retracement depth", () => {
  // Shallow retracement (38.2%)
  const shallow = compareFibTPMethods({
    swingOrigin: 1.1000,
    swingEnd: 1.1100,
    entryPrice: 1.10618, // 38.2% retracement
    direction: "bullish",
  }, 1.0);

  // Deep retracement (78.6%)
  const deep = compareFibTPMethods({
    swingOrigin: 1.1000,
    swingEnd: 1.1100,
    entryPrice: 1.10214, // 78.6% retracement
    direction: "bullish",
  }, 1.0);

  // Deeper retracement = larger difference between old and new methods
  assert(deep.difference > shallow.difference,
    `Deep retracement difference (${deep.difference}) should be > shallow (${shallow.difference})`);
});

Deno.test("compareFibTPMethods — zero impulse returns zero difference", () => {
  const comparison = compareFibTPMethods({
    swingOrigin: 1.1000,
    swingEnd: 1.1000,
    entryPrice: 1.1000,
    direction: "bullish",
  });

  assertEquals(comparison.difference, 0);
  assertEquals(comparison.differencePercent, 0);
});

// ─── Retracement Depth Tests ─────────────────────────────────────────────────

Deno.test("fibExtension3Point — retracement depth calculated correctly", () => {
  // 61.8% retracement
  const result = calculateFibExtension3Point({
    swingOrigin: 1.1000,
    swingEnd: 1.1100,
    entryPrice: 1.10382, // B - 61.8% of impulse = 1.1100 - 0.00618 = 1.10382
    direction: "bullish",
  });

  assertAlmostEquals(result.retracementDepth, 0.618, 0.001);
});
