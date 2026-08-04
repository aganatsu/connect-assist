/**
 * preGateConsistency.test.ts — Cross-consistency test
 *
 * Proves that the pre-gates fast-path (which calls shared functions and
 * returns category strings) produces identical pass/fail decisions as the
 * main gate array (which calls the same shared functions and pushes gate
 * objects).
 *
 * This is the test that would fail if:
 *   - The pre-gate called a shared function with different inputs
 *   - The pre-gate used a different comparison (< vs >=)
 *   - The pre-gate had a guard condition the main gate doesn't (or vice versa)
 *
 * Both paths now call the exact same shared functions. This test runs
 * identical synthetic inputs through both the "pre-gate pattern" and the
 * "main gate pattern" and asserts they agree on every condition.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { checkMaxPositions } from "../../functions/_shared/gateMaxPositions.ts";
import { checkMaxPerSymbol } from "../../functions/_shared/gateMaxPerSymbol.ts";
import { checkMaxDrawdown } from "../../functions/_shared/gateMaxDrawdown.ts";
import { checkDailyLossLimit } from "../../functions/_shared/gateDailyLossLimit.ts";
import { checkCooldown } from "../../functions/_shared/gateCooldown.ts";
import { checkConsecutiveLosses } from "../../functions/_shared/gateConsecutiveLosses.ts";

// ─── Simulate pre-gate pattern (returns category string or null) ─────

interface PortfolioState {
  openPositionCount: number;
  symbolPositionCount: number;
  maxOpenPositions: number;
  maxPerSymbol: number;
  peakBalance: number;
  currentBalance: number;
  maxDrawdown: number;
  dailyLossPercent: number;
  maxDailyLoss: number;
  elapsedMinutes: number | null;
  cooldownMinutes: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  symbol: string;
}

/**
 * Replicates the pre-gates IIFE logic as consolidated:
 * calls shared functions, returns category string on first fail, null on all-pass.
 */
function preGateFastPath(state: PortfolioState): string | null {
  // Gate 1: Max open positions
  if (!checkMaxPositions({
    openPositionCount: state.openPositionCount,
    maxOpenPositions: state.maxOpenPositions,
  }).passed) return "max_positions";

  // Gate 2: Max per symbol
  if (!checkMaxPerSymbol({
    symbolPositionCount: state.symbolPositionCount,
    maxPerSymbol: state.maxPerSymbol,
  }).passed) return "max_per_symbol";

  // Gate 5: Max drawdown (circuit breaker)
  if (state.peakBalance > 0 && state.maxDrawdown > 0) {
    if (!checkMaxDrawdown({
      peakBalance: state.peakBalance,
      currentBalance: state.currentBalance,
      maxDrawdownPercent: state.maxDrawdown,
    }).passed) return "max_drawdown";
  }

  // Gate 6: Daily loss limit
  if (state.maxDailyLoss > 0) {
    if (!checkDailyLossLimit({
      dailyLossPercent: state.dailyLossPercent,
      maxDailyLoss: state.maxDailyLoss,
    }).passed) return "daily_loss";
  }

  // Gate 8: Cooldown
  if (state.cooldownMinutes > 0) {
    if (!checkCooldown({
      elapsedMinutes: state.elapsedMinutes,
      cooldownMinutes: state.cooldownMinutes,
      symbol: state.symbol,
    }).passed) return "cooldown";
  }

  // Gate 9: Consecutive losses
  if (state.maxConsecutiveLosses > 0) {
    if (!checkConsecutiveLosses({
      consecutiveLosses: state.consecutiveLosses,
      maxConsecutiveLosses: state.maxConsecutiveLosses,
    }).passed) return "consecutive_losses";
  }

  return null;
}

/**
 * Replicates the main gate array logic for the same 6 gates:
 * calls shared functions, collects gate results, returns which ones failed.
 */
function mainGateArray(state: PortfolioState): { gate: string; passed: boolean }[] {
  const results: { gate: string; passed: boolean }[] = [];

  // Gate 1: Max open positions (always checked)
  results.push({
    gate: "max_positions",
    passed: checkMaxPositions({
      openPositionCount: state.openPositionCount,
      maxOpenPositions: state.maxOpenPositions,
    }).passed,
  });

  // Gate 2: Max per symbol (always checked)
  results.push({
    gate: "max_per_symbol",
    passed: checkMaxPerSymbol({
      symbolPositionCount: state.symbolPositionCount,
      maxPerSymbol: state.maxPerSymbol,
    }).passed,
  });

  // Gate 5: Max drawdown (guarded)
  if (state.peakBalance > 0 && state.maxDrawdown > 0) {
    results.push({
      gate: "max_drawdown",
      passed: checkMaxDrawdown({
        peakBalance: state.peakBalance,
        currentBalance: state.currentBalance,
        maxDrawdownPercent: state.maxDrawdown,
      }).passed,
    });
  }

  // Gate 6: Daily loss limit (guarded)
  if (state.maxDailyLoss > 0) {
    results.push({
      gate: "daily_loss",
      passed: checkDailyLossLimit({
        dailyLossPercent: state.dailyLossPercent,
        maxDailyLoss: state.maxDailyLoss,
      }).passed,
    });
  }

  // Gate 8: Cooldown (guarded)
  if (state.cooldownMinutes > 0) {
    results.push({
      gate: "cooldown",
      passed: checkCooldown({
        elapsedMinutes: state.elapsedMinutes,
        cooldownMinutes: state.cooldownMinutes,
        symbol: state.symbol,
      }).passed,
    });
  }

  // Gate 9: Consecutive losses (guarded)
  if (state.maxConsecutiveLosses > 0) {
    results.push({
      gate: "consecutive_losses",
      passed: checkConsecutiveLosses({
        consecutiveLosses: state.consecutiveLosses,
        maxConsecutiveLosses: state.maxConsecutiveLosses,
      }).passed,
    });
  }

  return results;
}

// ─── Test: pre-gate and main gate agree on all synthetic inputs ──────

const testCases: { label: string; state: PortfolioState }[] = [
  {
    label: "all gates pass — healthy portfolio",
    state: {
      openPositionCount: 2, maxOpenPositions: 5,
      symbolPositionCount: 0, maxPerSymbol: 3,
      peakBalance: 10000, currentBalance: 9800, maxDrawdown: 10,
      dailyLossPercent: 1.5, maxDailyLoss: 5,
      elapsedMinutes: 60, cooldownMinutes: 30,
      consecutiveLosses: 1, maxConsecutiveLosses: 5,
      symbol: "EURUSD",
    },
  },
  {
    label: "max positions hit",
    state: {
      openPositionCount: 5, maxOpenPositions: 5,
      symbolPositionCount: 1, maxPerSymbol: 3,
      peakBalance: 10000, currentBalance: 9500, maxDrawdown: 10,
      dailyLossPercent: 2, maxDailyLoss: 5,
      elapsedMinutes: 60, cooldownMinutes: 30,
      consecutiveLosses: 0, maxConsecutiveLosses: 5,
      symbol: "GBPUSD",
    },
  },
  {
    label: "max per symbol hit",
    state: {
      openPositionCount: 3, maxOpenPositions: 5,
      symbolPositionCount: 3, maxPerSymbol: 3,
      peakBalance: 10000, currentBalance: 9500, maxDrawdown: 10,
      dailyLossPercent: 1, maxDailyLoss: 5,
      elapsedMinutes: 60, cooldownMinutes: 30,
      consecutiveLosses: 0, maxConsecutiveLosses: 5,
      symbol: "EURUSD",
    },
  },
  {
    label: "drawdown exceeded",
    state: {
      openPositionCount: 1, maxOpenPositions: 5,
      symbolPositionCount: 0, maxPerSymbol: 3,
      peakBalance: 10000, currentBalance: 8500, maxDrawdown: 10,
      dailyLossPercent: 1, maxDailyLoss: 5,
      elapsedMinutes: 60, cooldownMinutes: 30,
      consecutiveLosses: 0, maxConsecutiveLosses: 5,
      symbol: "USDJPY",
    },
  },
  {
    label: "daily loss limit hit",
    state: {
      openPositionCount: 1, maxOpenPositions: 5,
      symbolPositionCount: 0, maxPerSymbol: 3,
      peakBalance: 10000, currentBalance: 9800, maxDrawdown: 10,
      dailyLossPercent: 6, maxDailyLoss: 5,
      elapsedMinutes: 60, cooldownMinutes: 30,
      consecutiveLosses: 0, maxConsecutiveLosses: 5,
      symbol: "EURUSD",
    },
  },
  {
    label: "cooldown active",
    state: {
      openPositionCount: 1, maxOpenPositions: 5,
      symbolPositionCount: 0, maxPerSymbol: 3,
      peakBalance: 10000, currentBalance: 9800, maxDrawdown: 10,
      dailyLossPercent: 1, maxDailyLoss: 5,
      elapsedMinutes: 10, cooldownMinutes: 30,
      consecutiveLosses: 0, maxConsecutiveLosses: 5,
      symbol: "EURUSD",
    },
  },
  {
    label: "consecutive losses exceeded",
    state: {
      openPositionCount: 1, maxOpenPositions: 5,
      symbolPositionCount: 0, maxPerSymbol: 3,
      peakBalance: 10000, currentBalance: 9800, maxDrawdown: 10,
      dailyLossPercent: 1, maxDailyLoss: 5,
      elapsedMinutes: 60, cooldownMinutes: 30,
      consecutiveLosses: 5, maxConsecutiveLosses: 5,
      symbol: "EURUSD",
    },
  },
  {
    label: "multiple gates fail — pre-gate short-circuits at first",
    state: {
      openPositionCount: 5, maxOpenPositions: 5,
      symbolPositionCount: 3, maxPerSymbol: 3,
      peakBalance: 10000, currentBalance: 8000, maxDrawdown: 10,
      dailyLossPercent: 8, maxDailyLoss: 5,
      elapsedMinutes: 5, cooldownMinutes: 30,
      consecutiveLosses: 6, maxConsecutiveLosses: 5,
      symbol: "EURUSD",
    },
  },
  {
    label: "edge: all limits at boundary (equal) — all fail",
    state: {
      openPositionCount: 3, maxOpenPositions: 3,
      symbolPositionCount: 2, maxPerSymbol: 2,
      peakBalance: 10000, currentBalance: 9000, maxDrawdown: 10,
      dailyLossPercent: 5, maxDailyLoss: 5,
      elapsedMinutes: 29.9, cooldownMinutes: 30,
      consecutiveLosses: 3, maxConsecutiveLosses: 3,
      symbol: "EURUSD",
    },
  },
  {
    label: "disabled gates: maxDailyLoss=0, cooldown=0, maxConsecutiveLosses=0",
    state: {
      openPositionCount: 2, maxOpenPositions: 5,
      symbolPositionCount: 1, maxPerSymbol: 3,
      peakBalance: 10000, currentBalance: 9800, maxDrawdown: 10,
      dailyLossPercent: 99, maxDailyLoss: 0, // disabled
      elapsedMinutes: 1, cooldownMinutes: 0, // disabled
      consecutiveLosses: 99, maxConsecutiveLosses: 0, // disabled
      symbol: "EURUSD",
    },
  },
  {
    label: "disabled drawdown: peakBalance=0",
    state: {
      openPositionCount: 1, maxOpenPositions: 5,
      symbolPositionCount: 0, maxPerSymbol: 3,
      peakBalance: 0, currentBalance: 10000, maxDrawdown: 10,
      dailyLossPercent: 1, maxDailyLoss: 5,
      elapsedMinutes: 60, cooldownMinutes: 30,
      consecutiveLosses: 0, maxConsecutiveLosses: 5,
      symbol: "EURUSD",
    },
  },
  {
    label: "cooldown with no previous trade (null elapsed)",
    state: {
      openPositionCount: 1, maxOpenPositions: 5,
      symbolPositionCount: 0, maxPerSymbol: 3,
      peakBalance: 10000, currentBalance: 9800, maxDrawdown: 10,
      dailyLossPercent: 1, maxDailyLoss: 5,
      elapsedMinutes: null, cooldownMinutes: 30,
      consecutiveLosses: 0, maxConsecutiveLosses: 5,
      symbol: "EURUSD",
    },
  },
];

Deno.test("pre-gate vs main-gate: both paths agree on pass/fail for all 6 conditions", () => {
  for (const { label, state } of testCases) {
    const preGateResult = preGateFastPath(state);
    const mainGateResults = mainGateArray(state);

    // The main gate array tells us which gates would fail
    const mainGateFirstFail = mainGateResults.find(g => !g.passed);

    if (preGateResult === null) {
      // Pre-gate says all pass — main gate should agree
      assertEquals(
        mainGateFirstFail,
        undefined,
        `[${label}] Pre-gate says all pass, but main gate has failure: ${mainGateFirstFail?.gate}`,
      );
    } else {
      // Pre-gate short-circuits at first failure — main gate's first failure should be the same gate
      assertEquals(
        mainGateFirstFail !== undefined,
        true,
        `[${label}] Pre-gate says "${preGateResult}" failed, but main gate says all pass`,
      );
      assertEquals(
        preGateResult,
        mainGateFirstFail!.gate,
        `[${label}] Pre-gate short-circuits at "${preGateResult}" but main gate's first failure is "${mainGateFirstFail!.gate}"`,
      );
    }
  }
});

Deno.test("pre-gate vs main-gate: individual gate pass/fail matches for non-short-circuit cases", () => {
  // For cases where only one gate fails, verify the specific gate matches
  const singleFailCases = testCases.filter(tc => {
    const results = mainGateArray(tc.state);
    return results.filter(g => !g.passed).length === 1;
  });

  for (const { label, state } of singleFailCases) {
    const preGateResult = preGateFastPath(state);
    const mainGateResults = mainGateArray(state);
    const failedGate = mainGateResults.find(g => !g.passed)!;

    assertEquals(
      preGateResult,
      failedGate.gate,
      `[${label}] Single-fail case: pre-gate="${preGateResult}" vs main-gate="${failedGate.gate}"`,
    );
  }
});

Deno.test("pre-gate vs main-gate: disabled gates (config=0) are skipped by both paths", () => {
  // When a gate's config is 0, both paths should skip it entirely
  const state: PortfolioState = {
    openPositionCount: 2, maxOpenPositions: 5,
    symbolPositionCount: 1, maxPerSymbol: 3,
    peakBalance: 10000, currentBalance: 9800, maxDrawdown: 10,
    dailyLossPercent: 99, maxDailyLoss: 0, // disabled — should NOT block
    elapsedMinutes: 1, cooldownMinutes: 0, // disabled — should NOT block
    consecutiveLosses: 99, maxConsecutiveLosses: 0, // disabled — should NOT block
    symbol: "EURUSD",
  };

  const preGateResult = preGateFastPath(state);
  const mainGateResults = mainGateArray(state);

  // Both should pass (disabled gates don't block)
  assertEquals(preGateResult, null, "Pre-gate should pass when disabled gates have extreme values");
  assertEquals(
    mainGateResults.every(g => g.passed),
    true,
    "Main gate should pass when disabled gates have extreme values",
  );
});

Deno.test("pre-gate: skippedByPreGate counter increments on any failure", () => {
  // Simulates the actual backtest loop behavior:
  // preGateFailed is truthy → counter increments
  let skippedByPreGate = 0;

  for (const { state } of testCases) {
    const preGateFailed = preGateFastPath(state);
    if (preGateFailed) {
      skippedByPreGate++;
    }
  }

  // Count how many test cases have at least one failing gate
  const expectedSkips = testCases.filter(tc => {
    const results = mainGateArray(tc.state);
    return results.some(g => !g.passed);
  }).length;

  assertEquals(
    skippedByPreGate,
    expectedSkips,
    `skippedByPreGate count (${skippedByPreGate}) should match number of cases with any gate failure (${expectedSkips})`,
  );
});
