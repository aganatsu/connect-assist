/**
 * computeManagementDecision.test.ts — Cross-Engine SL Sequence Regression
 * ─────────────────────────────────────────────────────────────────────────
 * Proves that the pure function produces the correct SL progression for
 * deterministic price paths. Since both live (manageOpenPositions) and
 * backtest (processExits) now call computeManagementDecision(), this test
 * guarantees identical behavior across engines.
 *
 * Structure:
 *   1. Deterministic fixture builder
 *   2. BE activation tests (configured pips, offset pips)
 *   3. Trailing stop tests (proportional, ratchet-only-forward)
 *   4. Independent BE and trailing activation sequence
 *   5. Structure invalidation (one-shot, floor enforcement)
 *   6. Max hold → BE
 *   7. Session-close BE (scalper)
 *   8. Multi-bar SL progression (the "golden path" regression)
 */

import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeManagementDecision,
  type ManagementInput,
  type ManagementDecisionConfig,
  type StructureCheckResult,
} from "../../functions/_shared/computeManagementDecision.ts";

// ─── Fixture Builders ────────────────────────────────────────────────

const BASE_CONFIG: ManagementDecisionConfig = {
  breakEvenEnabled: true,
  breakEvenPips: 20,
  breakEvenOffsetPips: 3,
  trailingStopEnabled: true,
  trailingStopPips: 15,
  trailingStopActivation: "after_1r",
  partialTPEnabled: false,
  maxHoldEnabled: false,
  maxHoldHours: 0,
  structureInvalidationEnabled: false,
  adaptiveTrailingEnabled: false,
  tradingStyle: "day_trader",
};

function makeInput(overrides: Partial<ManagementInput> = {}): ManagementInput {
  return {
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.08500,
    currentPrice: 1.08500,
    bestPrice: 1.08500,
    currentSL: 1.08300,       // 20 pips below entry
    originalSL: 1.08300,
    takeProfit: 1.08900,      // 40 pips above entry (2R)
    holdHours: 1.0,
    exitFlags: {},
    structureCheck: null,
    adaptiveTrailCandles: null,
    atrValue: 0.0015,
    regimeInfo: null,
    currentSession: "london",
    ...overrides,
  };
}

// ─── 1. No Change (price hasn't moved enough) ──────────────────────

Deno.test("no_change when price below BE activation threshold", () => {
  // Entry at 1.08500, SL at 1.08300 (20 pips risk). BE activation = min(2.0, max(1.0, 20/20)) = 1.0R
  // Need bestPrice >= entry + 20 pips = 1.08700 for 1R
  const result = computeManagementDecision(
    makeInput({ currentPrice: 1.08600, bestPrice: 1.08600 }), // 0.5R
    BASE_CONFIG,
  );
  assertEquals(result.action, "no_change");
  assertEquals(result.newSL, null);
});

// ─── 2. Break-Even Activation ──────────────────────────────────────

Deno.test("BE activates at 1R with 3-pip offset (long)", () => {
  // 20 pips risk → beActivationR = min(2.0, max(1.0, 20/20)) = 1.0R
  // bestPrice needs to be entry + 20 pips = 1.08700
  const result = computeManagementDecision(
    makeInput({ currentPrice: 1.08700, bestPrice: 1.08700 }),
    BASE_CONFIG,
  );
  assertEquals(result.action, "be_activated");
  // BE SL = entry + 3 pips offset = 1.08500 + 0.00030 = 1.08530
  assertAlmostEquals(result.newSL!, 1.08530, 0.000001);
  assertEquals(result.updatedExitFlags.breakEvenActivated, true);
  // Break-even does not silently activate the independent trailing policy.
  assertEquals(result.updatedExitFlags.trailingStopActivated, undefined);
});

Deno.test("BE activates at 1R with 3-pip offset (short)", () => {
  const result = computeManagementDecision(
    makeInput({
      direction: "short",
      entryPrice: 1.08500,
      currentPrice: 1.08300,
      bestPrice: 1.08300,   // 20 pips below entry = 1R
      currentSL: 1.08700,   // 20 pips above entry
      originalSL: 1.08700,
      takeProfit: 1.08100,
    }),
    BASE_CONFIG,
  );
  assertEquals(result.action, "be_activated");
  // BE SL = entry - 3 pips offset = 1.08500 - 0.00030 = 1.08470
  assertAlmostEquals(result.newSL!, 1.08470, 0.000001);
});

Deno.test("wide-risk short honors a 20-pip BE trigger below 1R", () => {
  const result = computeManagementDecision(
    makeInput({
      direction: "short",
      entryPrice: 1.15194,
      currentPrice: 1.14994,
      bestPrice: 1.14994,
      currentSL: 1.159705,
      originalSL: 1.159705,
      takeProfit: 1.13641,
    }),
    { ...BASE_CONFIG, trailingStopActivation: "after_1.5r" },
  );
  assertEquals(result.action, "be_activated");
  assertAlmostEquals(result.rMultiple, 20 / 77.65, 0.0001);
  assertAlmostEquals(result.newSL!, 1.15164, 0.000001);
  assertEquals(result.updatedExitFlags.trailingStopActivated, undefined);
});

Deno.test("BE does not activate before its configured 50-pip threshold", () => {
  // breakEvenPips = 50, riskPips = 20 → 50-pip threshold = 2.5R for this 20-pip risk
  // bestPrice = 1.08850 = 1.75R — below 2R threshold
  // Disable trailing to isolate BE logic
  const result = computeManagementDecision(
    makeInput({ currentPrice: 1.08850, bestPrice: 1.08850 }), // 1.75R
    { ...BASE_CONFIG, breakEvenPips: 50, trailingStopEnabled: false },
  );
  assertEquals(result.action, "no_change");
});

Deno.test("BE activates at its configured 50-pip threshold", () => {
  // breakEvenPips = 50, riskPips = 20 → 50-pip threshold = 2.5R for this 20-pip risk
  const result = computeManagementDecision(
    makeInput({ currentPrice: 1.09000, bestPrice: 1.09000 }), // 50 pips = 2.5R
    { ...BASE_CONFIG, breakEvenPips: 50 },
  );
  assertEquals(result.action, "be_activated");
  assertAlmostEquals(result.newSL!, 1.08530, 0.000001);
});

// ─── 3. Trailing Stop (Phase A: activation) ────────────────────────

Deno.test("trailing activates independently when BE is disabled", () => {
  const result = computeManagementDecision(
    makeInput({ currentPrice: 1.08700, bestPrice: 1.08700 }), // 1.0R
    { ...BASE_CONFIG, breakEvenEnabled: false, trailingStopActivation: "after_1r" },
  );
  assertEquals(result.action, "trailing_activated");
  // Proportional trail = max(15, 20 * 0.5) = 15 pips
  // newSL = currentPrice - 15 pips = 1.08700 - 0.00150 = 1.08550
  assertAlmostEquals(result.newSL!, 1.08550, 0.000001);
});

Deno.test("trailing uses proportional distance (0.5x risk) when larger than config pips", () => {
  // riskPips = 40 (SL at 1.08100), trailingStopPips = 15
  // proportional = max(15, 40 * 0.5) = 20 pips
  const result = computeManagementDecision(
    makeInput({
      currentPrice: 1.08900,
      bestPrice: 1.08900,
      currentSL: 1.08100,
      originalSL: 1.08100,
    }),
    { ...BASE_CONFIG, breakEvenEnabled: false, trailingStopActivation: "after_1r" },
  );
  assertEquals(result.action, "trailing_activated");
  // newSL = 1.08900 - 20 pips = 1.08900 - 0.00200 = 1.08700
  assertAlmostEquals(result.newSL!, 1.08700, 0.000001);
});

// ─── 4. Trailing Stop (Phase B: ratchet tightening) ─────────────────

Deno.test("trailing tightens SL forward but never widens", () => {
  // Simulate: trailing already activated, price moved further up
  const result = computeManagementDecision(
    makeInput({
      currentPrice: 1.08800,
      bestPrice: 1.08800,
      currentSL: 1.08550,  // Previous trailing SL
      exitFlags: {
        breakEvenActivated: true,
        trailingStopActivated: true,
        trailingStopLevel: 1.08550,
        trailingStopPips: 15,
      },
    }),
    BASE_CONFIG,
  );
  assertEquals(result.action, "trailing_tightened");
  // newSL = 1.08800 - 15 pips = 1.08800 - 0.00150 = 1.08650
  assertAlmostEquals(result.newSL!, 1.08650, 0.000001);
});

Deno.test("trailing does NOT widen SL when price retraces", () => {
  // Price was at 1.08800, trailing moved SL to 1.08650
  // Now price retraces to 1.08700 — trailing SL should stay at 1.08650
  const result = computeManagementDecision(
    makeInput({
      currentPrice: 1.08700,
      bestPrice: 1.08700,
      currentSL: 1.08650,  // Current trailing SL (from previous tightening)
      exitFlags: {
        breakEvenActivated: true,
        trailingStopActivated: true,
        trailingStopLevel: 1.08650,
        trailingStopPips: 15,
      },
    }),
    BASE_CONFIG,
  );
  // newTrailLevel = 1.08700 - 0.00150 = 1.08550 < current SL of 1.08650 → no tighten
  assertEquals(result.action, "no_change");
  assertEquals(result.newSL, null);
});

// ─── 5. Structure Invalidation ──────────────────────────────────────

Deno.test("structure invalidation tightens SL by 50% with floor enforcement", () => {
  // Position is slightly underwater (R between -0.8 and 0)
  // Entry 1.08500, SL 1.08300, current price 1.08450 → R = -0.25
  const result = computeManagementDecision(
    makeInput({
      currentPrice: 1.08450,
      bestPrice: 1.08450,
      structureCheck: { trend: "bearish", chochAgainstCount: 2 },
    }),
    { ...BASE_CONFIG, structureInvalidationEnabled: true },
  );
  assertEquals(result.action, "structure_invalidated");
  // currentSLDistance = |1.08450 - 1.08300| = 0.00150
  // tightenedDistance = 0.00150 * 0.5 = 0.00075
  // newSL = 1.08450 - 0.00075 = 1.08375
  // Floor for EUR/USD = 12 pips = 0.00120
  // newSLDistFromEntry = |1.08500 - 1.08375| = 0.00125 > 0.00120 → floor not hit
  assertAlmostEquals(result.newSL!, 1.08375, 0.000001);
  assertEquals(result.updatedExitFlags.structureInvalidationFired, true);
});

Deno.test("structure invalidation respects SL floor (EUR/USD = 12 pips)", () => {
  // Entry 1.08500, SL 1.08300, current price 1.08480 → R = -0.1
  // currentSLDistance = |1.08480 - 1.08300| = 0.00180
  // tightenedDistance = 0.00180 * 0.5 = 0.00090
  // newSL = 1.08480 - 0.00090 = 1.08390
  // newSLDistFromEntry = |1.08500 - 1.08390| = 0.00110 < floor 0.00120
  // → clamp to entry - 0.00120 = 1.08380
  const result = computeManagementDecision(
    makeInput({
      currentPrice: 1.08480,
      bestPrice: 1.08480,
      structureCheck: { trend: "bearish", chochAgainstCount: 1 },
    }),
    { ...BASE_CONFIG, structureInvalidationEnabled: true },
  );
  assertEquals(result.action, "structure_invalidated");
  assertAlmostEquals(result.newSL!, 1.08380, 0.000001);
});

Deno.test("structure invalidation skipped when R > 0 or R < -0.8", () => {
  // R > 0: price above entry
  const result1 = computeManagementDecision(
    makeInput({
      currentPrice: 1.08600,
      bestPrice: 1.08600,
      structureCheck: { trend: "bearish", chochAgainstCount: 2 },
    }),
    { ...BASE_CONFIG, structureInvalidationEnabled: true },
  );
  assertEquals(result1.action, "no_change");

  // R < -0.8: too deep underwater
  const result2 = computeManagementDecision(
    makeInput({
      currentPrice: 1.08320,
      bestPrice: 1.08320,
      structureCheck: { trend: "bearish", chochAgainstCount: 2 },
    }),
    { ...BASE_CONFIG, structureInvalidationEnabled: true },
  );
  assertEquals(result2.action, "no_change");
});

// ─── 6. Max Hold → BE ───────────────────────────────────────────────

Deno.test("max hold moves to BE when in profit", () => {
  const result = computeManagementDecision(
    makeInput({
      currentPrice: 1.08600,
      bestPrice: 1.08600,
      holdHours: 25,
    }),
    { ...BASE_CONFIG, maxHoldEnabled: true, maxHoldHours: 24 },
  );
  assertEquals(result.action, "max_hold_be");
  assertAlmostEquals(result.newSL!, 1.08530, 0.000001);
});

Deno.test("max hold does nothing when NOT in profit", () => {
  const result = computeManagementDecision(
    makeInput({
      currentPrice: 1.08400,
      bestPrice: 1.08400,
      holdHours: 25,
    }),
    { ...BASE_CONFIG, maxHoldEnabled: true, maxHoldHours: 24 },
  );
  // R < 0, so max hold doesn't move to BE
  assertEquals(result.action, "no_change");
});

// ─── 7. Session-Close BE (scalper) ──────────────────────────────────

Deno.test("session-close BE triggers for scalpers in off-hours", () => {
  const result = computeManagementDecision(
    makeInput({
      currentPrice: 1.08600,
      bestPrice: 1.08600,
      currentSession: "offhours",
    }),
    { ...BASE_CONFIG, tradingStyle: "scalper" },
  );
  assertEquals(result.action, "session_close_be");
  assertAlmostEquals(result.newSL!, 1.08530, 0.000001);
});

Deno.test("session-close BE does NOT trigger for day_trader", () => {
  const result = computeManagementDecision(
    makeInput({
      currentPrice: 1.08600,
      bestPrice: 1.08600,
      currentSession: "offhours",
    }),
    { ...BASE_CONFIG, tradingStyle: "day_trader" },
  );
  // day_trader doesn't get session-close BE
  assertEquals(result.action, "no_change");
});

// ─── 8. Multi-Bar SL Progression ("Golden Path" Regression) ─────────

Deno.test("golden path: BE → trailing activate → trailing tighten → no widen", () => {
  // Simulates a EUR/USD long that goes from entry to +2R then retraces
  // Entry: 1.08500, SL: 1.08300 (20 pips), TP: 1.08900 (40 pips)
  const config = { ...BASE_CONFIG };
  let exitFlags: Record<string, any> = {};
  let currentSL = 1.08300;

  // Bar 1: Price reaches the 20-pip BE threshold; trailing remains independent
  const bar1 = computeManagementDecision(
    makeInput({ currentPrice: 1.08700, bestPrice: 1.08700, currentSL, exitFlags }),
    config,
  );
  assertEquals(bar1.action, "be_activated");
  assertAlmostEquals(bar1.newSL!, 1.08530, 0.000001);
  currentSL = bar1.newSL!;
  exitFlags = bar1.updatedExitFlags;
  assertEquals(exitFlags.breakEvenActivated, true);
  assertEquals(exitFlags.trailingStopActivated, undefined);

  // Bar 2: Price continues to 1.5R (1.08800) → trailing activates
  const bar2 = computeManagementDecision(
    makeInput({ currentPrice: 1.08800, bestPrice: 1.08800, currentSL, exitFlags }),
    config,
  );
  assertEquals(bar2.action, "trailing_activated");
  // newSL = 1.08800 - 15 pips = 1.08650
  assertAlmostEquals(bar2.newSL!, 1.08650, 0.000001);
  currentSL = bar2.newSL!;
  exitFlags = bar2.updatedExitFlags;

  // Bar 3: Price reaches 2R (1.08900) → trailing tightens further
  const bar3 = computeManagementDecision(
    makeInput({ currentPrice: 1.08900, bestPrice: 1.08900, currentSL, exitFlags }),
    config,
  );
  assertEquals(bar3.action, "trailing_tightened");
  // newSL = 1.08900 - 15 pips = 1.08750
  assertAlmostEquals(bar3.newSL!, 1.08750, 0.000001);
  currentSL = bar3.newSL!;
  exitFlags = bar3.updatedExitFlags;

  // Bar 4: Price retraces to 1.08800 → trailing must NOT widen
  const bar4 = computeManagementDecision(
    makeInput({ currentPrice: 1.08800, bestPrice: 1.08800, currentSL, exitFlags }),
    config,
  );
  assertEquals(bar4.action, "no_change");
  assertEquals(bar4.newSL, null);
  // SL stays at 1.08750

  // Bar 5: Price recovers to 1.08950 → trailing tightens again
  const bar5 = computeManagementDecision(
    makeInput({ currentPrice: 1.08950, bestPrice: 1.08950, currentSL, exitFlags }),
    config,
  );
  assertEquals(bar5.action, "trailing_tightened");
  // newSL = 1.08950 - 15 pips = 1.08800
  assertAlmostEquals(bar5.newSL!, 1.08800, 0.000001);
});

Deno.test("golden path: XAU/USD short with proportional trailing", () => {
  // XAU/USD: pipSize = 0.01, entry = 2350.00, SL = 2355.00 (500 pips risk)
  // proportionalTrailPips = max(15, 500 * 0.5) = 250 pips
  // Break-even threshold is 20 favorable pips; trailing remains R-based
  const config = { ...BASE_CONFIG };
  let exitFlags: Record<string, any> = {};
  let currentSL = 2355.00;

  // Bar 1: Price drops to 1R below entry (2345.00) → BE activates
  // riskPips = |2350 - 2355| / 0.01 = 500 pips
  // 1R = 500 pips below entry = 2345.00
  const bar1 = computeManagementDecision(
    makeInput({
      symbol: "XAU/USD",
      direction: "short",
      entryPrice: 2350.00,
      currentPrice: 2345.00,
      bestPrice: 2345.00,
      currentSL,
      originalSL: 2355.00,
      takeProfit: 2340.00,
      exitFlags,
    }),
    config,
  );
  assertEquals(bar1.action, "be_activated");
  // BE SL = 2350.00 - (0.01 * 3) = 2349.97
  assertAlmostEquals(bar1.newSL!, 2349.97, 0.001);
  currentSL = bar1.newSL!;
  exitFlags = bar1.updatedExitFlags;

  // Bar 2: Price drops to 2340.00 (2R) → trailing tightens
  const bar2 = computeManagementDecision(
    makeInput({
      symbol: "XAU/USD",
      direction: "short",
      entryPrice: 2350.00,
      currentPrice: 2340.00,
      bestPrice: 2340.00,
      currentSL,
      originalSL: 2355.00,
      takeProfit: 2340.00,
      exitFlags,
    }),
    config,
  );
  assertEquals(bar2.action, "trailing_activated");
  // proportionalTrailPips = max(15, 500 * 0.5) = 250 pips
  // newSL = 2340.00 + (250 * 0.01) = 2340.00 + 2.50 = 2342.50
  assertAlmostEquals(bar2.newSL!, 2342.50, 0.01);
});
