import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkATRVolatility } from "./gateATRVolatility.ts";

// ─── Unit Tests ─────────────────────────────────────────────────────────────

Deno.test("checkATRVolatility: passes when ATR within range", () => {
  const result = checkATRVolatility({ atrPips: 10, minPips: 5, maxPips: 15 });
  assertEquals(result.passed, true);
});

Deno.test("checkATRVolatility: fails when ATR below minimum", () => {
  const result = checkATRVolatility({ atrPips: 3, minPips: 5, maxPips: 15 });
  assertEquals(result.passed, false);
  assertEquals(result.reason.includes("below minimum"), true);
});

Deno.test("checkATRVolatility: fails when ATR above maximum", () => {
  const result = checkATRVolatility({ atrPips: 20, minPips: 5, maxPips: 15 });
  assertEquals(result.passed, false);
  assertEquals(result.reason.includes("above maximum"), true);
});

Deno.test("checkATRVolatility: min disabled when 0", () => {
  const result = checkATRVolatility({ atrPips: 1, minPips: 0, maxPips: 15 });
  assertEquals(result.passed, true);
});

Deno.test("checkATRVolatility: max disabled when 0", () => {
  const result = checkATRVolatility({ atrPips: 100, minPips: 5, maxPips: 0 });
  assertEquals(result.passed, true);
});

Deno.test("checkATRVolatility: both bounds disabled", () => {
  const result = checkATRVolatility({ atrPips: 50, minPips: 0, maxPips: 0 });
  assertEquals(result.passed, true);
});

Deno.test("checkATRVolatility: at exact minimum boundary passes", () => {
  // atrPips >= minPips → pass (not strictly less than)
  const result = checkATRVolatility({ atrPips: 5, minPips: 5, maxPips: 15 });
  assertEquals(result.passed, true);
});

Deno.test("checkATRVolatility: at exact maximum boundary passes", () => {
  // atrPips <= maxPips → pass (not strictly greater than)
  const result = checkATRVolatility({ atrPips: 15, minPips: 5, maxPips: 15 });
  assertEquals(result.passed, true);
});

// ─── Reason String Safety Tests ─────────────────────────────────────────────

Deno.test("reason string: contains 'ATR ' for gatePerformanceEngine pattern", () => {
  const cases = [
    checkATRVolatility({ atrPips: 3, minPips: 5, maxPips: 15 }),
    checkATRVolatility({ atrPips: 20, minPips: 5, maxPips: 15 }),
    checkATRVolatility({ atrPips: 10, minPips: 5, maxPips: 15 }),
  ];
  for (const result of cases) {
    assertEquals(result.reason.includes("ATR "), true,
      `Reason "${result.reason}" must contain "ATR " for gatePerformanceEngine categorization`);
  }
});

Deno.test("reason string: split(':')[0] yields 'ATR filter' for backtest diagnostics", () => {
  const cases = [
    checkATRVolatility({ atrPips: 3, minPips: 5, maxPips: 15 }),
    checkATRVolatility({ atrPips: 20, minPips: 5, maxPips: 15 }),
    checkATRVolatility({ atrPips: 10, minPips: 5, maxPips: 15 }),
  ];
  for (const result of cases) {
    assertEquals(result.reason.split(":")[0], "ATR filter",
      `Reason "${result.reason}" must aggregate under "ATR filter" key`);
  }
});

// ─── Cross-Engine Agreement Tests ───────────────────────────────────────────

Deno.test("cross-engine: shared matches bot-scanner inline for all test cases", () => {
  // Replicate bot-scanner's old inline logic exactly
  function botScannerInline(atrPips: number, minPips: number, maxPips: number) {
    if (minPips > 0 && atrPips < minPips) {
      return { passed: false, reason: `ATR ${atrPips.toFixed(1)} pips below minimum ${minPips}` };
    } else if (maxPips > 0 && atrPips > maxPips) {
      return { passed: false, reason: `ATR ${atrPips.toFixed(1)} pips above maximum ${maxPips}` };
    } else {
      return { passed: true, reason: `ATR ${atrPips.toFixed(1)} pips within range` };
    }
  }

  const testCases = [
    { atrPips: 3, minPips: 5, maxPips: 15 },
    { atrPips: 5, minPips: 5, maxPips: 15 },
    { atrPips: 10, minPips: 5, maxPips: 15 },
    { atrPips: 15, minPips: 5, maxPips: 15 },
    { atrPips: 20, minPips: 5, maxPips: 15 },
    { atrPips: 1, minPips: 0, maxPips: 15 },
    { atrPips: 100, minPips: 5, maxPips: 0 },
    { atrPips: 50, minPips: 0, maxPips: 0 },
    { atrPips: 0.5, minPips: 1, maxPips: 50 },
    { atrPips: 7.77, minPips: 3, maxPips: 8 },
  ];

  for (const tc of testCases) {
    const shared = checkATRVolatility(tc);
    const inline = botScannerInline(tc.atrPips, tc.minPips, tc.maxPips);
    assertEquals(shared.passed, inline.passed,
      `Mismatch at atrPips=${tc.atrPips}, min=${tc.minPips}, max=${tc.maxPips}: shared=${shared.passed}, inline=${inline.passed}`);
  }
});

Deno.test("cross-engine: shared matches backtest-engine inline for all test cases", () => {
  // Replicate backtest-engine's old inline logic exactly
  function backtestInline(atrPips: number, atrFilterMin: number, atrFilterMax: number) {
    const minOk = atrFilterMin <= 0 || atrPips >= atrFilterMin;
    const maxOk = atrFilterMax <= 0 || atrPips <= atrFilterMax;
    return { passed: minOk && maxOk };
  }

  const testCases = [
    { atrPips: 3, minPips: 5, maxPips: 15 },
    { atrPips: 5, minPips: 5, maxPips: 15 },
    { atrPips: 10, minPips: 5, maxPips: 15 },
    { atrPips: 15, minPips: 5, maxPips: 15 },
    { atrPips: 20, minPips: 5, maxPips: 15 },
    { atrPips: 1, minPips: 0, maxPips: 15 },
    { atrPips: 100, minPips: 5, maxPips: 0 },
    { atrPips: 50, minPips: 0, maxPips: 0 },
    { atrPips: 0.5, minPips: 1, maxPips: 50 },
    { atrPips: 7.77, minPips: 3, maxPips: 8 },
  ];

  for (const tc of testCases) {
    const shared = checkATRVolatility(tc);
    const inline = backtestInline(tc.atrPips, tc.minPips, tc.maxPips);
    assertEquals(shared.passed, inline.passed,
      `Mismatch at atrPips=${tc.atrPips}, min=${tc.minPips}, max=${tc.maxPips}: shared=${shared.passed}, inline=${inline.passed}`);
  }
});

// ─── Boundary Behavior Verification ─────────────────────────────────────────

Deno.test("boundary: bot-scanner uses strict < for min (not <=)", () => {
  // Bot-scanner: atrPips < minPips → fail. At boundary (equal) → pass.
  const atBoundary = checkATRVolatility({ atrPips: 5, minPips: 5, maxPips: 0 });
  const belowBoundary = checkATRVolatility({ atrPips: 4.99, minPips: 5, maxPips: 0 });
  assertEquals(atBoundary.passed, true, "At min boundary should pass");
  assertEquals(belowBoundary.passed, false, "Below min boundary should fail");
});

Deno.test("boundary: bot-scanner uses strict > for max (not >=)", () => {
  // Bot-scanner: atrPips > maxPips → fail. At boundary (equal) → pass.
  const atBoundary = checkATRVolatility({ atrPips: 15, minPips: 0, maxPips: 15 });
  const aboveBoundary = checkATRVolatility({ atrPips: 15.01, minPips: 0, maxPips: 15 });
  assertEquals(atBoundary.passed, true, "At max boundary should pass");
  assertEquals(aboveBoundary.passed, false, "Above max boundary should fail");
});
