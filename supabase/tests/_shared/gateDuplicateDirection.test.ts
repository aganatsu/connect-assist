/**
 * gateDuplicateDirection.test.ts — Cross-engine agreement tests
 *
 * Verifies that checkDuplicateDirection produces identical pass/fail results
 * for both bot-scanner and backtest-engine call paths.
 *
 * Key behavioral divergence (intentional, documented):
 *   - Bot-scanner passes config.allowSameDirectionStacking (user-configurable)
 *   - Backtest-engine passes false (always blocks same-direction duplicates)
 *
 * The cross-engine agreement test verifies that when both engines pass the
 * SAME inputs, they get the SAME outputs — proving the shared function is
 * a correct replacement for both engines' inline logic.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { checkDuplicateDirection } from "./gateDuplicateDirection.ts";

// ─── Helper: simulate the OLD inline logic from each engine ──────────

/** bot-scanner Gate 5 duplicate-direction check (original inline) */
function botScannerInline(
  sameDirectionExists: boolean,
  allowSameDirectionStacking: boolean,
  direction: "long" | "short",
  symbol: string,
): { passed: boolean; reason: string } | null {
  // Returns gate result if duplicate blocks, null if it passes (and count check runs)
  if (sameDirectionExists && !allowSameDirectionStacking) {
    return { passed: false, reason: `Already ${direction} on ${symbol} — no duplicate (enable stacking to allow)` };
  }
  // In the original, if this passes, the count check runs and produces the gate result.
  // For the duplicate-direction test, we only care about the pass/fail of the duplicate check itself.
  return null; // means "passed, proceed to count check"
}

/** backtest-engine Gate 3 original inline logic */
function backtestInline(
  hasSameDir: boolean,
  direction: "long" | "short",
  symbol: string,
): { passed: boolean; reason: string } {
  return {
    passed: !hasSameDir,
    reason: hasSameDir ? `Already ${direction} on ${symbol}` : "No duplicate direction",
  };
}

// ─── Unit tests ──────────────────────────────────────────────────────

Deno.test("gateDuplicateDirection: no duplicate, stacking disabled → pass", () => {
  const result = checkDuplicateDirection({
    sameDirectionExists: false,
    allowSameDirectionStacking: false,
    direction: "long",
    symbol: "EUR/USD",
  });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "No duplicate direction");
});

Deno.test("gateDuplicateDirection: no duplicate, stacking enabled → pass", () => {
  const result = checkDuplicateDirection({
    sameDirectionExists: false,
    allowSameDirectionStacking: true,
    direction: "short",
    symbol: "GBP/USD",
  });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "No duplicate direction");
});

Deno.test("gateDuplicateDirection: duplicate exists, stacking disabled → fail", () => {
  const result = checkDuplicateDirection({
    sameDirectionExists: true,
    allowSameDirectionStacking: false,
    direction: "long",
    symbol: "XAU/USD",
  });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Already long on XAU/USD");
});

Deno.test("gateDuplicateDirection: duplicate exists, stacking enabled → pass", () => {
  const result = checkDuplicateDirection({
    sameDirectionExists: true,
    allowSameDirectionStacking: true,
    direction: "short",
    symbol: "BTC/USD",
  });
  assertEquals(result.passed, true);
  assertEquals(result.reason, "short on BTC/USD (stacking allowed)");
});

Deno.test("gateDuplicateDirection: duplicate long, stacking disabled → fail with correct direction", () => {
  const result = checkDuplicateDirection({
    sameDirectionExists: true,
    allowSameDirectionStacking: false,
    direction: "long",
    symbol: "USD/JPY",
  });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Already long on USD/JPY");
});

Deno.test("gateDuplicateDirection: duplicate short, stacking disabled → fail with correct direction", () => {
  const result = checkDuplicateDirection({
    sameDirectionExists: true,
    allowSameDirectionStacking: false,
    direction: "short",
    symbol: "NZD/USD",
  });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Already short on NZD/USD");
});

// ─── Cross-engine agreement: shared pass/fail matches bot-scanner ────

Deno.test("cross-engine: shared pass/fail matches bot-scanner inline for all test cases", () => {
  const cases: Array<{
    sameDir: boolean;
    stacking: boolean;
    direction: "long" | "short";
    symbol: string;
  }> = [
    { sameDir: false, stacking: false, direction: "long", symbol: "EUR/USD" },
    { sameDir: false, stacking: true, direction: "short", symbol: "GBP/USD" },
    { sameDir: true, stacking: false, direction: "long", symbol: "XAU/USD" },
    { sameDir: true, stacking: true, direction: "short", symbol: "BTC/USD" },
    { sameDir: true, stacking: false, direction: "short", symbol: "USD/JPY" },
    { sameDir: false, stacking: false, direction: "short", symbol: "AUD/USD" },
    { sameDir: true, stacking: true, direction: "long", symbol: "EUR/GBP" },
    { sameDir: false, stacking: true, direction: "long", symbol: "GBP/JPY" },
    { sameDir: true, stacking: false, direction: "long", symbol: "USD/CAD" },
    { sameDir: true, stacking: true, direction: "short", symbol: "NZD/USD" },
  ];

  for (const { sameDir, stacking, direction, symbol } of cases) {
    const shared = checkDuplicateDirection({
      sameDirectionExists: sameDir,
      allowSameDirectionStacking: stacking,
      direction,
      symbol,
    });
    const inline = botScannerInline(sameDir, stacking, direction, symbol);

    if (inline === null) {
      // Bot-scanner inline passed (returned null) → shared should also pass
      assertEquals(
        shared.passed,
        true,
        `Bot-scanner passed but shared failed: sameDir=${sameDir}, stacking=${stacking}, ${direction} ${symbol}`,
      );
    } else {
      // Bot-scanner inline blocked → shared should also block
      assertEquals(
        shared.passed,
        inline.passed,
        `Pass/fail mismatch: sameDir=${sameDir}, stacking=${stacking}, ${direction} ${symbol}`,
      );
    }
  }
});

// ─── Cross-engine agreement: shared pass/fail matches backtest-engine ─

Deno.test("cross-engine: shared pass/fail matches backtest-engine inline (stacking=false) for all test cases", () => {
  const cases: Array<{
    hasSameDir: boolean;
    direction: "long" | "short";
    symbol: string;
  }> = [
    { hasSameDir: false, direction: "long", symbol: "EUR/USD" },
    { hasSameDir: true, direction: "long", symbol: "GBP/USD" },
    { hasSameDir: false, direction: "short", symbol: "XAU/USD" },
    { hasSameDir: true, direction: "short", symbol: "BTC/USD" },
    { hasSameDir: false, direction: "long", symbol: "USD/JPY" },
    { hasSameDir: true, direction: "short", symbol: "AUD/USD" },
    { hasSameDir: false, direction: "short", symbol: "EUR/GBP" },
    { hasSameDir: true, direction: "long", symbol: "GBP/JPY" },
    { hasSameDir: false, direction: "long", symbol: "USD/CAD" },
    { hasSameDir: true, direction: "long", symbol: "NZD/USD" },
  ];

  for (const { hasSameDir, direction, symbol } of cases) {
    // Backtest always passes false for allowSameDirectionStacking
    const shared = checkDuplicateDirection({
      sameDirectionExists: hasSameDir,
      allowSameDirectionStacking: false,
      direction,
      symbol,
    });
    const inline = backtestInline(hasSameDir, direction, symbol);

    assertEquals(
      shared.passed,
      inline.passed,
      `Pass/fail mismatch: hasSameDir=${hasSameDir}, ${direction} ${symbol}: shared=${shared.passed}, backtest=${inline.passed}`,
    );
    // Reason strings should also match for backtest path (both use same format)
    assertEquals(
      shared.reason,
      inline.reason,
      `Reason mismatch: hasSameDir=${hasSameDir}, ${direction} ${symbol}`,
    );
  }
});

// ─── Divergence documentation test ──────────────────────────────────

Deno.test("divergence: bot-scanner allows stacking while backtest blocks (documented intentional)", () => {
  // Same input scenario: duplicate exists on EUR/USD long
  const botScannerCall = checkDuplicateDirection({
    sameDirectionExists: true,
    allowSameDirectionStacking: true, // bot-scanner: user enabled stacking
    direction: "long",
    symbol: "EUR/USD",
  });
  const backtestCall = checkDuplicateDirection({
    sameDirectionExists: true,
    allowSameDirectionStacking: false, // backtest: always false
    direction: "long",
    symbol: "EUR/USD",
  });

  // This test documents the intentional divergence
  assertEquals(botScannerCall.passed, true, "Bot-scanner should pass with stacking enabled");
  assertEquals(backtestCall.passed, false, "Backtest should block (stacking always disabled)");
  // Both use the same function — the divergence is in the INPUT, not the logic
});
