/**
 * gateMaxPositions.test.ts — Cross-engine agreement tests
 *
 * Verifies that checkMaxPositions produces identical pass/fail results
 * for both bot-scanner (Gate 4) and backtest-engine (Gate 1) call paths.
 *
 * The shared function uses a strict `>=` comparison:
 *   openPositionCount >= maxOpenPositions → FAIL (at or above limit)
 *   openPositionCount <  maxOpenPositions → PASS (room for one more)
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { checkMaxPositions } from "../../functions/_shared/gateMaxPositions.ts";

// ─── Helper: simulate the OLD inline logic from each engine ──────────

/** bot-scanner Gate 4 original inline logic */
function botScannerInline(openCount: number, max: number) {
  if (openCount >= max) {
    return { passed: false, reason: `Max positions (${max}) reached` };
  }
  return { passed: true, reason: `${openCount}/${max} positions` };
}

/** backtest-engine Gate 1 original inline logic */
function backtestInline(openCount: number, max: number) {
  return {
    passed: openCount < max,
    reason: `Open positions: ${openCount}/${max}`,
  };
}

// ─── Cross-engine agreement tests ────────────────────────────────────

Deno.test("gateMaxPositions: 0 positions, limit 3 → pass", () => {
  const result = checkMaxPositions({ openPositionCount: 0, maxOpenPositions: 3 });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "0/3 positions");
});

Deno.test("gateMaxPositions: 2 positions, limit 3 → pass", () => {
  const result = checkMaxPositions({ openPositionCount: 2, maxOpenPositions: 3 });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "2/3 positions");
});

Deno.test("gateMaxPositions: 3 positions, limit 3 → fail (at limit)", () => {
  const result = checkMaxPositions({ openPositionCount: 3, maxOpenPositions: 3 });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Max positions (3) reached");
});

Deno.test("gateMaxPositions: 5 positions, limit 3 → fail (over limit)", () => {
  const result = checkMaxPositions({ openPositionCount: 5, maxOpenPositions: 3 });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Max positions (3) reached");
});

Deno.test("gateMaxPositions: 1 position, limit 1 → fail (exactly at limit)", () => {
  const result = checkMaxPositions({ openPositionCount: 1, maxOpenPositions: 1 });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Max positions (1) reached");
});

Deno.test("gateMaxPositions: 0 positions, limit 1 → pass (room for one)", () => {
  const result = checkMaxPositions({ openPositionCount: 0, maxOpenPositions: 1 });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "0/1 positions");
});

// ─── Cross-engine agreement: shared matches bot-scanner inline ───────

Deno.test("cross-engine: shared matches bot-scanner inline for all test cases", () => {
  const cases = [
    { open: 0, max: 3 },
    { open: 1, max: 3 },
    { open: 2, max: 3 },
    { open: 3, max: 3 },
    { open: 5, max: 3 },
    { open: 0, max: 1 },
    { open: 1, max: 1 },
    { open: 4, max: 5 },
    { open: 5, max: 5 },
    { open: 10, max: 10 },
  ];

  for (const { open, max } of cases) {
    const shared = checkMaxPositions({ openPositionCount: open, maxOpenPositions: max });
    const inline = botScannerInline(open, max);
    assertEquals(
      shared.passed,
      inline.passed,
      `Mismatch at open=${open}, max=${max}: shared.passed=${shared.passed}, inline.passed=${inline.passed}`,
    );
    assertEquals(
      shared.reason,
      inline.reason,
      `Reason mismatch at open=${open}, max=${max}`,
    );
  }
});

// ─── Cross-engine agreement: shared matches backtest-engine inline ───

Deno.test("cross-engine: shared pass/fail matches backtest-engine inline for all test cases", () => {
  const cases = [
    { open: 0, max: 3 },
    { open: 1, max: 3 },
    { open: 2, max: 3 },
    { open: 3, max: 3 },
    { open: 5, max: 3 },
    { open: 0, max: 1 },
    { open: 1, max: 1 },
    { open: 4, max: 5 },
    { open: 5, max: 5 },
    { open: 10, max: 10 },
  ];

  for (const { open, max } of cases) {
    const shared = checkMaxPositions({ openPositionCount: open, maxOpenPositions: max });
    const inline = backtestInline(open, max);
    assertEquals(
      shared.passed,
      inline.passed,
      `Pass/fail mismatch at open=${open}, max=${max}: shared.passed=${shared.passed}, backtest.passed=${inline.passed}`,
    );
    // Note: reason strings differ between engines (cosmetic), but pass/fail must agree
  }
});
