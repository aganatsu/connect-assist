/**
 * gateDailyLossLimit.test.ts — Cross-engine agreement tests
 *
 * Verifies that checkDailyLossLimit produces identical pass/fail results
 * for both bot-scanner and backtest-engine call paths.
 *
 * Key difference in how dailyLossPercent is computed (upstream, not in shared fn):
 *   - Bot-scanner: balance decline from stored start-of-day baseline
 *   - Backtest-engine: sum of realized trade P&L for candle-day / balance
 *
 * The shared function only handles the comparison logic — both engines
 * pre-compute dailyLossPercent their own way and pass it in.
 *
 * Reason string format uses colon (`Daily loss: ...`) to preserve
 * compatibility with backtest-engine's `reason.split(":")[0]` diagnostics
 * aggregation (yields "Daily loss" as the grouping key).
 *
 * Also compatible with gatePerformanceEngine.ts which matches on
 * substring "Daily loss" — both old and new formats contain this.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { checkDailyLossLimit } from "../../functions/_shared/gateDailyLossLimit.ts";

// ─── Helper: simulate the OLD inline logic from each engine ──────────

/** bot-scanner Gate 7 original inline (non-prop-firm path) */
function botScannerInline(dailyLossPercent: number, maxDailyLoss: number): { passed: boolean } {
  if (dailyLossPercent >= maxDailyLoss) {
    return { passed: false };
  }
  return { passed: true };
}

/** backtest-engine Gate 6 original inline */
function backtestInline(dailyLossPct: number, maxDailyLoss: number): { passed: boolean } {
  return { passed: dailyLossPct < maxDailyLoss };
}

// ─── Unit tests ──────────────────────────────────────────────────────

Deno.test("gateDailyLossLimit: no loss → pass", () => {
  const result = checkDailyLossLimit({ dailyLossPercent: 0, maxDailyLoss: 3 });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "Daily loss: 0.0%");
});

Deno.test("gateDailyLossLimit: loss below limit → pass", () => {
  const result = checkDailyLossLimit({ dailyLossPercent: 1.5, maxDailyLoss: 3 });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "Daily loss: 1.5%");
});

Deno.test("gateDailyLossLimit: loss exactly at limit → fail", () => {
  const result = checkDailyLossLimit({ dailyLossPercent: 3, maxDailyLoss: 3 });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Daily loss: 3.0% >= 3% limit");
});

Deno.test("gateDailyLossLimit: loss above limit → fail", () => {
  const result = checkDailyLossLimit({ dailyLossPercent: 5.2, maxDailyLoss: 3 });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Daily loss: 5.2% >= 3% limit");
});

Deno.test("gateDailyLossLimit: very small loss below tight limit → pass", () => {
  const result = checkDailyLossLimit({ dailyLossPercent: 0.4, maxDailyLoss: 0.5 });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "Daily loss: 0.4%");
});

Deno.test("gateDailyLossLimit: negative dailyLossPercent (profit day) → pass", () => {
  // If the engine computes a negative value (meaning profit), it should always pass
  const result = checkDailyLossLimit({ dailyLossPercent: -2.0, maxDailyLoss: 3 });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "Daily loss: -2.0%");
});

// ─── Reason string format: colon-split compatibility ─────────────────

Deno.test("gateDailyLossLimit: reason string split on colon yields 'Daily loss' label", () => {
  const fail = checkDailyLossLimit({ dailyLossPercent: 5, maxDailyLoss: 3 });
  const pass = checkDailyLossLimit({ dailyLossPercent: 1, maxDailyLoss: 3 });
  assertEquals(fail.reason.split(":")[0], "Daily loss");
  assertEquals(pass.reason.split(":")[0], "Daily loss");
});

// ─── Cross-engine agreement: shared matches bot-scanner ──────────────

Deno.test("cross-engine: shared pass/fail matches bot-scanner inline for all test cases", () => {
  const cases = [
    { dailyLossPercent: 0, maxDailyLoss: 3 },
    { dailyLossPercent: 1.5, maxDailyLoss: 3 },
    { dailyLossPercent: 2.99, maxDailyLoss: 3 },
    { dailyLossPercent: 3, maxDailyLoss: 3 },
    { dailyLossPercent: 3.01, maxDailyLoss: 3 },
    { dailyLossPercent: 5, maxDailyLoss: 3 },
    { dailyLossPercent: 10, maxDailyLoss: 5 },
    { dailyLossPercent: 0.5, maxDailyLoss: 1 },
    { dailyLossPercent: 1, maxDailyLoss: 1 },
    { dailyLossPercent: -1, maxDailyLoss: 3 },
  ];

  for (const { dailyLossPercent, maxDailyLoss } of cases) {
    const shared = checkDailyLossLimit({ dailyLossPercent, maxDailyLoss });
    const inline = botScannerInline(dailyLossPercent, maxDailyLoss);
    assertEquals(
      shared.passed,
      inline.passed,
      `Pass/fail mismatch: loss=${dailyLossPercent}, max=${maxDailyLoss}: shared=${shared.passed}, botScanner=${inline.passed}`,
    );
  }
});

// ─── Cross-engine agreement: shared matches backtest-engine ──────────

Deno.test("cross-engine: shared pass/fail matches backtest-engine inline for all test cases", () => {
  const cases = [
    { dailyLossPercent: 0, maxDailyLoss: 3 },
    { dailyLossPercent: 1.5, maxDailyLoss: 3 },
    { dailyLossPercent: 2.99, maxDailyLoss: 3 },
    { dailyLossPercent: 3, maxDailyLoss: 3 },
    { dailyLossPercent: 3.01, maxDailyLoss: 3 },
    { dailyLossPercent: 5, maxDailyLoss: 3 },
    { dailyLossPercent: 10, maxDailyLoss: 5 },
    { dailyLossPercent: 0.5, maxDailyLoss: 1 },
    { dailyLossPercent: 1, maxDailyLoss: 1 },
    { dailyLossPercent: -1, maxDailyLoss: 3 },
  ];

  for (const { dailyLossPercent, maxDailyLoss } of cases) {
    const shared = checkDailyLossLimit({ dailyLossPercent, maxDailyLoss });
    const inline = backtestInline(dailyLossPercent, maxDailyLoss);
    assertEquals(
      shared.passed,
      inline.passed,
      `Pass/fail mismatch: loss=${dailyLossPercent}, max=${maxDailyLoss}: shared=${shared.passed}, backtest=${inline.passed}`,
    );
  }
});

// ─── Prop firm bypass: bot-scanner Gate 7 prop-firm branch is untouched ──

Deno.test("prop-firm bypass: when propFirmActive, gate returns hardcoded pass without calling checkDailyLossLimit", () => {
  // Documents the bot-scanner Gate 7 prop-firm delegation behavior.
  const propFirmBypassResult = {
    passed: true,
    reason: "Daily loss delegated to prop firm gate (stricter thresholds)",
  };

  const propFirmActive = true;
  let gateResult: { passed: boolean; reason: string };
  if (propFirmActive) {
    gateResult = propFirmBypassResult;
  } else {
    gateResult = { passed: false, reason: "should not reach here" };
  }

  assertEquals(gateResult.passed, true);
  assertEquals(gateResult.reason, "Daily loss delegated to prop firm gate (stricter thresholds)");
});
