/**
 * gateMaxPerSymbol.test.ts — Cross-engine agreement tests
 *
 * Verifies that checkMaxPerSymbol produces identical pass/fail results
 * for both bot-scanner (part of Gate 5) and backtest-engine (Gate 2) call paths.
 *
 * The shared function uses a strict `>=` comparison:
 *   symbolPositionCount >= maxPerSymbol → FAIL (at or above limit)
 *   symbolPositionCount <  maxPerSymbol → PASS (room for one more)
 *
 * NOTE: Bot-scanner's Gate 5 also includes a same-direction duplicate check
 * that short-circuits before the count check. That logic is NOT part of this
 * shared function — it remains inline in bot-scanner. This test verifies only
 * the count-check path produces identical results across engines.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { checkMaxPerSymbol } from "./gateMaxPerSymbol.ts";

// ─── Helper: simulate the OLD inline logic from each engine ──────────

/** bot-scanner Gate 5 count-check path (when duplicate check passes) */
function botScannerCountPath(symbolPositions: number, maxPerSymbol: number, symbol: string, sameDirectionExists: boolean) {
  // This is the else-if and else branches from the original Gate 5
  if (symbolPositions >= maxPerSymbol) {
    return { passed: false, reason: `Max ${maxPerSymbol} positions for ${symbol} reached` };
  }
  return { passed: true, reason: `${symbolPositions}/${maxPerSymbol} for ${symbol}${sameDirectionExists ? " (stacking allowed)" : ""}` };
}

/** backtest-engine Gate 2 original inline logic */
function backtestInline(symbolCount: number, maxPerSymbol: number, symbol: string) {
  return {
    passed: symbolCount < maxPerSymbol,
    reason: `${symbol} positions: ${symbolCount}/${maxPerSymbol}`,
  };
}

// ─── Unit tests ──────────────────────────────────────────────────────

Deno.test("gateMaxPerSymbol: 0 positions on EUR/USD, limit 2 → pass", () => {
  const result = checkMaxPerSymbol({ symbolPositionCount: 0, maxPerSymbol: 2, symbol: "EUR/USD" });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "0/2 for EUR/USD");
});

Deno.test("gateMaxPerSymbol: 1 position on GBP/USD, limit 2 → pass", () => {
  const result = checkMaxPerSymbol({ symbolPositionCount: 1, maxPerSymbol: 2, symbol: "GBP/USD" });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "1/2 for GBP/USD");
});

Deno.test("gateMaxPerSymbol: 2 positions on XAU/USD, limit 2 → fail (at limit)", () => {
  const result = checkMaxPerSymbol({ symbolPositionCount: 2, maxPerSymbol: 2, symbol: "XAU/USD" });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Max 2 positions for XAU/USD reached");
});

Deno.test("gateMaxPerSymbol: 3 positions on BTC/USD, limit 2 → fail (over limit)", () => {
  const result = checkMaxPerSymbol({ symbolPositionCount: 3, maxPerSymbol: 2, symbol: "BTC/USD" });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Max 2 positions for BTC/USD reached");
});

Deno.test("gateMaxPerSymbol: 1 position, limit 1 → fail (exactly at limit)", () => {
  const result = checkMaxPerSymbol({ symbolPositionCount: 1, maxPerSymbol: 1, symbol: "USD/JPY" });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Max 1 positions for USD/JPY reached");
});

Deno.test("gateMaxPerSymbol: 0 positions, limit 1 → pass (room for one)", () => {
  const result = checkMaxPerSymbol({ symbolPositionCount: 0, maxPerSymbol: 1, symbol: "NZD/USD" });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "0/1 for NZD/USD");
});

// ─── Cross-engine agreement: shared matches bot-scanner count path ───

Deno.test("cross-engine: shared matches bot-scanner count path (no stacking note) for all test cases", () => {
  const cases = [
    { count: 0, max: 2, symbol: "EUR/USD" },
    { count: 1, max: 2, symbol: "GBP/USD" },
    { count: 2, max: 2, symbol: "XAU/USD" },
    { count: 3, max: 2, symbol: "BTC/USD" },
    { count: 0, max: 1, symbol: "USD/JPY" },
    { count: 1, max: 1, symbol: "AUD/USD" },
    { count: 0, max: 3, symbol: "EUR/GBP" },
    { count: 2, max: 3, symbol: "GBP/JPY" },
    { count: 3, max: 3, symbol: "USD/CAD" },
    { count: 5, max: 3, symbol: "NZD/USD" },
  ];

  for (const { count, max, symbol } of cases) {
    const shared = checkMaxPerSymbol({ symbolPositionCount: count, maxPerSymbol: max, symbol });
    // sameDirectionExists=false means no stacking note appended
    const inline = botScannerCountPath(count, max, symbol, false);
    assertEquals(
      shared.passed,
      inline.passed,
      `Pass/fail mismatch at count=${count}, max=${max}, symbol=${symbol}`,
    );
    assertEquals(
      shared.reason,
      inline.reason,
      `Reason mismatch at count=${count}, max=${max}, symbol=${symbol}`,
    );
  }
});

// ─── Cross-engine agreement: shared pass/fail matches backtest-engine ─

Deno.test("cross-engine: shared pass/fail matches backtest-engine inline for all test cases", () => {
  const cases = [
    { count: 0, max: 2, symbol: "EUR/USD" },
    { count: 1, max: 2, symbol: "GBP/USD" },
    { count: 2, max: 2, symbol: "XAU/USD" },
    { count: 3, max: 2, symbol: "BTC/USD" },
    { count: 0, max: 1, symbol: "USD/JPY" },
    { count: 1, max: 1, symbol: "AUD/USD" },
    { count: 0, max: 3, symbol: "EUR/GBP" },
    { count: 2, max: 3, symbol: "GBP/JPY" },
    { count: 3, max: 3, symbol: "USD/CAD" },
    { count: 5, max: 3, symbol: "NZD/USD" },
  ];

  for (const { count, max, symbol } of cases) {
    const shared = checkMaxPerSymbol({ symbolPositionCount: count, maxPerSymbol: max, symbol });
    const inline = backtestInline(count, max, symbol);
    assertEquals(
      shared.passed,
      inline.passed,
      `Pass/fail mismatch at count=${count}, max=${max}, symbol=${symbol}: shared=${shared.passed}, backtest=${inline.passed}`,
    );
    // Note: reason strings differ cosmetically between engines — only pass/fail must agree
  }
});

// ─── Bot-scanner stacking note integration test ──────────────────────

Deno.test("bot-scanner integration: stacking note appended when sameDirectionExists and pass", () => {
  // This tests the bot-scanner's wrapper logic (not the shared function itself)
  // Simulates: stacking allowed, count below limit, same direction exists
  const perSymResult = checkMaxPerSymbol({ symbolPositionCount: 1, maxPerSymbol: 3, symbol: "EUR/USD" });
  // Bot-scanner appends " (stacking allowed)" when perSymResult.passed && sameDirectionExists
  const sameDirectionExists = true;
  const finalReason = perSymResult.passed && sameDirectionExists
    ? `${perSymResult.reason} (stacking allowed)`
    : perSymResult.reason;
  assertEquals(perSymResult.passed, true);
  assertEquals(finalReason, "1/3 for EUR/USD (stacking allowed)");
});

Deno.test("bot-scanner integration: no stacking note when count fails (stacking irrelevant)", () => {
  const perSymResult = checkMaxPerSymbol({ symbolPositionCount: 3, maxPerSymbol: 3, symbol: "EUR/USD" });
  // Even with sameDirectionExists=true, if count fails, no stacking note
  const sameDirectionExists = true;
  const finalReason = perSymResult.passed && sameDirectionExists
    ? `${perSymResult.reason} (stacking allowed)`
    : perSymResult.reason;
  assertEquals(perSymResult.passed, false);
  assertEquals(finalReason, "Max 3 positions for EUR/USD reached");
});
