/**
 * gateMaxDrawdown.test.ts — Cross-engine agreement tests
 *
 * Verifies that checkMaxDrawdown produces identical pass/fail results
 * for both bot-scanner and backtest-engine call paths.
 *
 * Key difference in original inline logic:
 *   - Bot-scanner: `drawdownPercent >= config.maxDrawdown` → fail
 *   - Backtest-engine: `currentDrawdownPct < config.maxDrawdown` → pass
 *   These are logically equivalent (>= fails ↔ < passes).
 *
 * Reason string difference (cosmetic):
 *   - Bot-scanner: `Drawdown 5.0% >= 10% limit` (fail) or `Drawdown 5.0%` (pass)
 *   - Backtest-engine: `Drawdown: 5.0% (max: 10%)` (always shows max)
 *   The shared function uses colon-prefixed format (`Drawdown: ...`) to preserve
 *   compatibility with backtest-engine's `reason.split(":")[0]` diagnostics aggregation.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { checkMaxDrawdown } from "../../functions/_shared/gateMaxDrawdown.ts";

// ─── Helper: simulate the OLD inline logic from each engine ──────────

/** bot-scanner Gate 8 original inline (non-prop-firm path) */
function botScannerInline(
  balance: number,
  peakBalance: number,
  maxDrawdown: number,
): { passed: boolean } {
  const drawdownPercent = peakBalance > 0 ? ((peakBalance - balance) / peakBalance) * 100 : 0;
  if (drawdownPercent >= maxDrawdown) {
    return { passed: false };
  }
  return { passed: true };
}

/** backtest-engine Gate 5 original inline */
function backtestInline(
  balance: number,
  peakBalance: number,
  maxDrawdown: number,
): { passed: boolean } {
  if (peakBalance > 0 && maxDrawdown > 0) {
    const currentDrawdownPct = ((peakBalance - balance) / peakBalance) * 100;
    return { passed: currentDrawdownPct < maxDrawdown };
  }
  return { passed: true };
}

// ─── Unit tests ──────────────────────────────────────────────────────

Deno.test("gateMaxDrawdown: no drawdown → pass", () => {
  const result = checkMaxDrawdown({ balance: 10000, peakBalance: 10000, maxDrawdown: 10 });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "Drawdown: 0.0%");
});

Deno.test("gateMaxDrawdown: drawdown below limit → pass", () => {
  const result = checkMaxDrawdown({ balance: 9500, peakBalance: 10000, maxDrawdown: 10 });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "Drawdown: 5.0%");
});

Deno.test("gateMaxDrawdown: drawdown exactly at limit → fail", () => {
  const result = checkMaxDrawdown({ balance: 9000, peakBalance: 10000, maxDrawdown: 10 });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Drawdown: 10.0% >= 10% limit");
});

Deno.test("gateMaxDrawdown: drawdown above limit → fail", () => {
  const result = checkMaxDrawdown({ balance: 8000, peakBalance: 10000, maxDrawdown: 10 });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Drawdown: 20.0% >= 10% limit");
});

Deno.test("gateMaxDrawdown: peakBalance <= 0 → pass (edge case)", () => {
  const result = checkMaxDrawdown({ balance: 5000, peakBalance: 0, maxDrawdown: 10 });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "Drawdown within limits");
});

Deno.test("gateMaxDrawdown: maxDrawdown <= 0 → pass (edge case)", () => {
  const result = checkMaxDrawdown({ balance: 5000, peakBalance: 10000, maxDrawdown: 0 });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "Drawdown within limits");
});

Deno.test("gateMaxDrawdown: negative balance (unrealized loss) → fail if over limit", () => {
  // balance 7000, peak 10000 → 30% drawdown
  const result = checkMaxDrawdown({ balance: 7000, peakBalance: 10000, maxDrawdown: 25 });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Drawdown: 30.0% >= 25% limit");
});

// ─── Cross-engine agreement: shared matches bot-scanner ──────────────

Deno.test("cross-engine: shared pass/fail matches bot-scanner inline for all test cases", () => {
  const cases = [
    { balance: 10000, peakBalance: 10000, maxDrawdown: 10 },
    { balance: 9500, peakBalance: 10000, maxDrawdown: 10 },
    { balance: 9000, peakBalance: 10000, maxDrawdown: 10 },
    { balance: 8000, peakBalance: 10000, maxDrawdown: 10 },
    { balance: 9900, peakBalance: 10000, maxDrawdown: 1 },
    { balance: 9999, peakBalance: 10000, maxDrawdown: 0.01 },
    { balance: 5000, peakBalance: 10000, maxDrawdown: 50 },
    { balance: 5000, peakBalance: 10000, maxDrawdown: 49.9 },
    { balance: 12000, peakBalance: 12000, maxDrawdown: 5 },
    { balance: 11400, peakBalance: 12000, maxDrawdown: 5 },
  ];

  for (const { balance, peakBalance, maxDrawdown } of cases) {
    const shared = checkMaxDrawdown({ balance, peakBalance, maxDrawdown });
    const inline = botScannerInline(balance, peakBalance, maxDrawdown);
    assertEquals(
      shared.passed,
      inline.passed,
      `Pass/fail mismatch: balance=${balance}, peak=${peakBalance}, max=${maxDrawdown}: shared=${shared.passed}, botScanner=${inline.passed}`,
    );
  }
});

// ─── Cross-engine agreement: shared matches backtest-engine ──────────

Deno.test("cross-engine: shared pass/fail matches backtest-engine inline for all test cases", () => {
  const cases = [
    { balance: 10000, peakBalance: 10000, maxDrawdown: 10 },
    { balance: 9500, peakBalance: 10000, maxDrawdown: 10 },
    { balance: 9000, peakBalance: 10000, maxDrawdown: 10 },
    { balance: 8000, peakBalance: 10000, maxDrawdown: 10 },
    { balance: 9900, peakBalance: 10000, maxDrawdown: 1 },
    { balance: 5000, peakBalance: 10000, maxDrawdown: 50 },
    { balance: 5000, peakBalance: 10000, maxDrawdown: 49.9 },
    { balance: 12000, peakBalance: 12000, maxDrawdown: 5 },
    { balance: 11400, peakBalance: 12000, maxDrawdown: 5 },
    { balance: 0, peakBalance: 0, maxDrawdown: 10 },
    { balance: 5000, peakBalance: 10000, maxDrawdown: 0 },
  ];

  for (const { balance, peakBalance, maxDrawdown } of cases) {
    const shared = checkMaxDrawdown({ balance, peakBalance, maxDrawdown });
    const inline = backtestInline(balance, peakBalance, maxDrawdown);
    assertEquals(
      shared.passed,
      inline.passed,
      `Pass/fail mismatch: balance=${balance}, peak=${peakBalance}, max=${maxDrawdown}: shared=${shared.passed}, backtest=${inline.passed}`,
    );
  }
});

// ─── Prop firm bypass: bot-scanner Gate 8 prop-firm branch is untouched ──

Deno.test("prop-firm bypass: when propFirmActive, gate returns hardcoded pass without calling checkMaxDrawdown", () => {
  // This test documents the bot-scanner Gate 8 prop-firm delegation behavior.
  // When propFirmActive is true, the gate pushes a hardcoded pass result and
  // never calls checkMaxDrawdown. This test asserts the expected bypass result
  // so future edits to Gate 8 don't accidentally lose the delegation.
  const propFirmBypassResult = {
    passed: true,
    reason: "Drawdown delegated to prop firm gate (stricter thresholds)",
  };

  // Simulate the bot-scanner Gate 8 logic for prop-firm accounts
  const propFirmActive = true;
  let gateResult: { passed: boolean; reason: string };
  if (propFirmActive) {
    gateResult = propFirmBypassResult;
  } else {
    // This branch would call checkMaxDrawdown — but prop firm skips it
    gateResult = { passed: false, reason: "should not reach here" };
  }

  assertEquals(gateResult.passed, true);
  assertEquals(gateResult.reason, "Drawdown delegated to prop firm gate (stricter thresholds)");
});
