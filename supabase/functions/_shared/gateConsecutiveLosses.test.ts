/**
 * gateConsecutiveLosses.test.ts — Cross-engine agreement tests
 *
 * Verifies that checkConsecutiveLosses produces identical pass/fail results
 * for both bot-scanner and backtest-engine call paths.
 *
 * Key divergence (intentional, typed in interface):
 *   - Bot-scanner: 4-hour auto-reset cooldown after hitting max losses
 *   - Backtest-engine: simple threshold, no auto-reset
 *
 * Reason string constraints:
 *   1. Must contain lowercase "consecutive losses" for gatePerformanceEngine.ts
 *      pattern matching (case-sensitive `includes()`)
 *   2. Must contain colon for backtest-engine's `reason.split(":")[0]` diagnostics
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { checkConsecutiveLosses } from "./gateConsecutiveLosses.ts";

// ─── Helper: simulate the OLD inline logic from each engine ──────────

/** bot-scanner Gate 14 original inline (simplified — decision logic only) */
function botScannerInline(
  consecutiveLosses: number,
  maxConsecutiveLosses: number,
  hoursSinceLastLoss: number,
  resetHours: number,
): { passed: boolean } {
  if (consecutiveLosses >= maxConsecutiveLosses) {
    if (hoursSinceLastLoss >= resetHours) {
      return { passed: true };
    } else {
      return { passed: false };
    }
  }
  return { passed: true };
}

/** backtest-engine Gate 9 original inline */
function backtestInline(consLosses: number, maxConsecutiveLosses: number): { passed: boolean } {
  return { passed: consLosses < maxConsecutiveLosses };
}

// ─── Unit tests ──────────────────────────────────────────────────────

Deno.test("gateConsecutiveLosses: zero losses → pass", () => {
  const result = checkConsecutiveLosses({ consecutiveLosses: 0, maxConsecutiveLosses: 3 });
  assertEquals(result.passed, true);
});

Deno.test("gateConsecutiveLosses: below limit → pass", () => {
  const result = checkConsecutiveLosses({ consecutiveLosses: 2, maxConsecutiveLosses: 3 });
  assertEquals(result.passed, true);
});

Deno.test("gateConsecutiveLosses: at limit, no auto-reset → fail", () => {
  const result = checkConsecutiveLosses({ consecutiveLosses: 3, maxConsecutiveLosses: 3 });
  assertEquals(result.passed, false);
});

Deno.test("gateConsecutiveLosses: above limit, no auto-reset → fail", () => {
  const result = checkConsecutiveLosses({ consecutiveLosses: 5, maxConsecutiveLosses: 3 });
  assertEquals(result.passed, false);
});

Deno.test("gateConsecutiveLosses: at limit, auto-reset elapsed → pass", () => {
  const result = checkConsecutiveLosses({
    consecutiveLosses: 3,
    maxConsecutiveLosses: 3,
    hoursSinceLastLoss: 5,
    autoResetHours: 4,
  });
  assertEquals(result.passed, true);
});

Deno.test("gateConsecutiveLosses: at limit, auto-reset NOT elapsed → fail", () => {
  const result = checkConsecutiveLosses({
    consecutiveLosses: 3,
    maxConsecutiveLosses: 3,
    hoursSinceLastLoss: 2,
    autoResetHours: 4,
  });
  assertEquals(result.passed, false);
});

Deno.test("gateConsecutiveLosses: at limit, auto-reset exactly at boundary → pass", () => {
  const result = checkConsecutiveLosses({
    consecutiveLosses: 3,
    maxConsecutiveLosses: 3,
    hoursSinceLastLoss: 4,
    autoResetHours: 4,
  });
  assertEquals(result.passed, true);
});

// ─── Reason string format: gatePerformanceEngine.ts compatibility ────

Deno.test("gateConsecutiveLosses: all reason strings contain lowercase 'consecutive losses'", () => {
  const cases = [
    checkConsecutiveLosses({ consecutiveLosses: 2, maxConsecutiveLosses: 3 }),
    checkConsecutiveLosses({ consecutiveLosses: 3, maxConsecutiveLosses: 3 }),
    checkConsecutiveLosses({ consecutiveLosses: 3, maxConsecutiveLosses: 3, hoursSinceLastLoss: 5, autoResetHours: 4 }),
    checkConsecutiveLosses({ consecutiveLosses: 3, maxConsecutiveLosses: 3, hoursSinceLastLoss: 2, autoResetHours: 4 }),
  ];
  for (const result of cases) {
    assertEquals(
      result.reason.includes("consecutive losses"),
      true,
      `Reason "${result.reason}" must contain "consecutive losses" for gatePerformanceEngine pattern matching`,
    );
  }
});

// ─── Reason string format: colon-split compatibility ─────────────────

Deno.test("gateConsecutiveLosses: all reason strings contain colon for split aggregation", () => {
  const cases = [
    checkConsecutiveLosses({ consecutiveLosses: 2, maxConsecutiveLosses: 3 }),
    checkConsecutiveLosses({ consecutiveLosses: 3, maxConsecutiveLosses: 3 }),
    checkConsecutiveLosses({ consecutiveLosses: 3, maxConsecutiveLosses: 3, hoursSinceLastLoss: 5, autoResetHours: 4 }),
    checkConsecutiveLosses({ consecutiveLosses: 3, maxConsecutiveLosses: 3, hoursSinceLastLoss: 2, autoResetHours: 4 }),
  ];
  for (const result of cases) {
    assertEquals(
      result.reason.includes(":"),
      true,
      `Reason "${result.reason}" must contain colon for backtest diagnostics split(":")[0] aggregation`,
    );
  }
});

// ─── Cross-engine agreement: shared matches bot-scanner (with auto-reset) ──

Deno.test("cross-engine: shared pass/fail matches bot-scanner inline for all test cases", () => {
  const cases = [
    { consecutiveLosses: 0, maxConsecutiveLosses: 3, hoursSinceLastLoss: 0, resetHours: 4 },
    { consecutiveLosses: 1, maxConsecutiveLosses: 3, hoursSinceLastLoss: 1, resetHours: 4 },
    { consecutiveLosses: 2, maxConsecutiveLosses: 3, hoursSinceLastLoss: 2, resetHours: 4 },
    { consecutiveLosses: 3, maxConsecutiveLosses: 3, hoursSinceLastLoss: 1, resetHours: 4 },
    { consecutiveLosses: 3, maxConsecutiveLosses: 3, hoursSinceLastLoss: 3.9, resetHours: 4 },
    { consecutiveLosses: 3, maxConsecutiveLosses: 3, hoursSinceLastLoss: 4, resetHours: 4 },
    { consecutiveLosses: 3, maxConsecutiveLosses: 3, hoursSinceLastLoss: 5, resetHours: 4 },
    { consecutiveLosses: 5, maxConsecutiveLosses: 3, hoursSinceLastLoss: 2, resetHours: 4 },
    { consecutiveLosses: 5, maxConsecutiveLosses: 3, hoursSinceLastLoss: 10, resetHours: 4 },
    { consecutiveLosses: 1, maxConsecutiveLosses: 5, hoursSinceLastLoss: 0.5, resetHours: 4 },
  ];

  for (const { consecutiveLosses, maxConsecutiveLosses, hoursSinceLastLoss, resetHours } of cases) {
    const shared = checkConsecutiveLosses({
      consecutiveLosses,
      maxConsecutiveLosses,
      hoursSinceLastLoss,
      autoResetHours: resetHours,
    });
    const inline = botScannerInline(consecutiveLosses, maxConsecutiveLosses, hoursSinceLastLoss, resetHours);
    assertEquals(
      shared.passed,
      inline.passed,
      `Pass/fail mismatch (bot-scanner): losses=${consecutiveLosses}, max=${maxConsecutiveLosses}, hours=${hoursSinceLastLoss}: shared=${shared.passed}, inline=${inline.passed}`,
    );
  }
});

// ─── Cross-engine agreement: shared matches backtest-engine (no auto-reset) ──

Deno.test("cross-engine: shared pass/fail matches backtest-engine inline for all test cases", () => {
  const cases = [
    { consecutiveLosses: 0, maxConsecutiveLosses: 3 },
    { consecutiveLosses: 1, maxConsecutiveLosses: 3 },
    { consecutiveLosses: 2, maxConsecutiveLosses: 3 },
    { consecutiveLosses: 3, maxConsecutiveLosses: 3 },
    { consecutiveLosses: 4, maxConsecutiveLosses: 3 },
    { consecutiveLosses: 5, maxConsecutiveLosses: 5 },
    { consecutiveLosses: 6, maxConsecutiveLosses: 5 },
    { consecutiveLosses: 0, maxConsecutiveLosses: 1 },
    { consecutiveLosses: 1, maxConsecutiveLosses: 1 },
    { consecutiveLosses: 10, maxConsecutiveLosses: 8 },
  ];

  for (const { consecutiveLosses, maxConsecutiveLosses } of cases) {
    const shared = checkConsecutiveLosses({ consecutiveLosses, maxConsecutiveLosses });
    const inline = backtestInline(consecutiveLosses, maxConsecutiveLosses);
    assertEquals(
      shared.passed,
      inline.passed,
      `Pass/fail mismatch (backtest): losses=${consecutiveLosses}, max=${maxConsecutiveLosses}: shared=${shared.passed}, inline=${inline.passed}`,
    );
  }
});

// ─── Divergence documentation test ──────────────────────────────────

Deno.test("divergence: backtest blocks at limit while bot-scanner can auto-reset", () => {
  // Same consecutive losses and limit, but different outcomes based on engine path
  const backtestResult = checkConsecutiveLosses({
    consecutiveLosses: 3,
    maxConsecutiveLosses: 3,
    // No autoResetHours — backtest path
  });
  const botScannerResult = checkConsecutiveLosses({
    consecutiveLosses: 3,
    maxConsecutiveLosses: 3,
    hoursSinceLastLoss: 5,
    autoResetHours: 4,
  });

  // Backtest blocks (no reset mechanism)
  assertEquals(backtestResult.passed, false);
  // Bot-scanner passes (auto-reset elapsed)
  assertEquals(botScannerResult.passed, true);
});
