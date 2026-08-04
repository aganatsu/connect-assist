/**
 * gateCooldown.test.ts — Cross-engine agreement tests
 *
 * Verifies that checkCooldown produces identical pass/fail results
 * for both bot-scanner and backtest-engine call paths.
 *
 * Both engines compute elapsedMinutes from their own time source
 * (wall-clock vs candle time) and pass the pre-computed value.
 * The shared function only handles the comparison.
 *
 * Reason string constraints:
 *   1. Must contain "Cooldown" for gatePerformanceEngine.ts pattern matching
 *   2. Must contain colon for backtest-engine's reason.split(":")[0] diagnostics
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { checkCooldown } from "./gateCooldown.ts";

// ─── Helper: simulate the OLD inline logic from each engine ──────────

/** bot-scanner Gate 13 original inline (decision logic only) */
function botScannerInline(
  elapsed: number | null,
  cooldownMinutes: number,
): { passed: boolean } {
  if (elapsed === null) return { passed: true };
  if (elapsed < cooldownMinutes) return { passed: false };
  return { passed: true };
}

/** backtest-engine Gate 8 original inline */
function backtestInline(
  elapsed: number | null,
  cooldownMinutes: number,
): { passed: boolean } {
  if (elapsed === null) return { passed: true };
  return { passed: elapsed >= cooldownMinutes };
}

// ─── Unit tests ──────────────────────────────────────────────────────

Deno.test("gateCooldown: no previous trade → pass", () => {
  const result = checkCooldown({ elapsedMinutes: null, cooldownMinutes: 30 });
  assertEquals(result.passed, true);
});

Deno.test("gateCooldown: elapsed exceeds cooldown → pass", () => {
  const result = checkCooldown({ elapsedMinutes: 45, cooldownMinutes: 30 });
  assertEquals(result.passed, true);
});

Deno.test("gateCooldown: elapsed equals cooldown → pass", () => {
  const result = checkCooldown({ elapsedMinutes: 30, cooldownMinutes: 30 });
  assertEquals(result.passed, true);
});

Deno.test("gateCooldown: elapsed below cooldown → fail", () => {
  const result = checkCooldown({ elapsedMinutes: 15, cooldownMinutes: 30 });
  assertEquals(result.passed, false);
});

Deno.test("gateCooldown: zero elapsed → fail", () => {
  const result = checkCooldown({ elapsedMinutes: 0, cooldownMinutes: 30 });
  assertEquals(result.passed, false);
});

Deno.test("gateCooldown: symbol included in fail reason", () => {
  const result = checkCooldown({ elapsedMinutes: 10, cooldownMinutes: 30, symbol: "EURUSD" });
  assertEquals(result.passed, false);
  assertEquals(result.reason.includes("EURUSD"), true);
});

// ─── Reason string format: gatePerformanceEngine.ts compatibility ────

Deno.test("gateCooldown: all reason strings contain 'Cooldown' for pattern matching", () => {
  const cases = [
    checkCooldown({ elapsedMinutes: null, cooldownMinutes: 30 }),
    checkCooldown({ elapsedMinutes: 45, cooldownMinutes: 30 }),
    checkCooldown({ elapsedMinutes: 10, cooldownMinutes: 30, symbol: "EURUSD" }),
  ];
  for (const result of cases) {
    assertEquals(
      result.reason.includes("Cooldown"),
      true,
      `Reason "${result.reason}" must contain "Cooldown" for gatePerformanceEngine pattern matching`,
    );
  }
});

// ─── Reason string format: colon-split compatibility ─────────────────

Deno.test("gateCooldown: all reason strings contain colon for split aggregation", () => {
  const cases = [
    checkCooldown({ elapsedMinutes: null, cooldownMinutes: 30 }),
    checkCooldown({ elapsedMinutes: 45, cooldownMinutes: 30 }),
    checkCooldown({ elapsedMinutes: 10, cooldownMinutes: 30, symbol: "EURUSD" }),
  ];
  for (const result of cases) {
    assertEquals(
      result.reason.includes(":"),
      true,
      `Reason "${result.reason}" must contain colon for backtest diagnostics split(":")[0] aggregation`,
    );
    assertEquals(
      result.reason.split(":")[0],
      "Cooldown",
      `split(":")[0] must yield "Cooldown" for stable aggregation key`,
    );
  }
});

// ─── Cross-engine agreement: shared matches bot-scanner inline ───────

Deno.test("cross-engine: shared pass/fail matches bot-scanner inline for all test cases", () => {
  const cases = [
    { elapsed: null, cooldown: 30 },
    { elapsed: 0, cooldown: 30 },
    { elapsed: 10, cooldown: 30 },
    { elapsed: 29.9, cooldown: 30 },
    { elapsed: 30, cooldown: 30 },
    { elapsed: 31, cooldown: 30 },
    { elapsed: 60, cooldown: 30 },
    { elapsed: 5, cooldown: 5 },
    { elapsed: 4.9, cooldown: 5 },
    { elapsed: null, cooldown: 60 },
  ];

  for (const { elapsed, cooldown } of cases) {
    const shared = checkCooldown({ elapsedMinutes: elapsed, cooldownMinutes: cooldown });
    const inline = botScannerInline(elapsed, cooldown);
    assertEquals(
      shared.passed,
      inline.passed,
      `Pass/fail mismatch (bot-scanner): elapsed=${elapsed}, cooldown=${cooldown}: shared=${shared.passed}, inline=${inline.passed}`,
    );
  }
});

// ─── Cross-engine agreement: shared matches backtest-engine inline ───

Deno.test("cross-engine: shared pass/fail matches backtest-engine inline for all test cases", () => {
  const cases = [
    { elapsed: null, cooldown: 30 },
    { elapsed: 0, cooldown: 30 },
    { elapsed: 15, cooldown: 30 },
    { elapsed: 29.9, cooldown: 30 },
    { elapsed: 30, cooldown: 30 },
    { elapsed: 45, cooldown: 30 },
    { elapsed: 100, cooldown: 60 },
    { elapsed: 59.9, cooldown: 60 },
    { elapsed: 60, cooldown: 60 },
    { elapsed: null, cooldown: 15 },
  ];

  for (const { elapsed, cooldown } of cases) {
    const shared = checkCooldown({ elapsedMinutes: elapsed, cooldownMinutes: cooldown });
    const inline = backtestInline(elapsed, cooldown);
    assertEquals(
      shared.passed,
      inline.passed,
      `Pass/fail mismatch (backtest): elapsed=${elapsed}, cooldown=${cooldown}: shared=${shared.passed}, inline=${inline.passed}`,
    );
  }
});
