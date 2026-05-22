/**
 * Tests for the effectiveLimitEnabled logic.
 *
 * Verifies:
 * 1. When izGateMode === "hard" and a limit entry is available, limit orders are
 *    auto-enabled even if config.limitOrderEnabled is false.
 * 2. When izGateMode !== "hard", the config.limitOrderEnabled value is respected.
 * 3. When izGateMode === "hard" but no limit entry is available, no limit order is placed.
 * 4. When config.limitOrderEnabled is true, it works regardless of izGateMode.
 *
 * These tests simulate the logic at bot-scanner/index.ts line 4574.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ─── Extracted logic under test ───────────────────────────────────────────────

interface LimitEntry {
  price: number;
  zoneType: string;
  zoneLow: number;
  zoneHigh: number;
}

/**
 * Determines whether limit orders are effectively enabled for this scan cycle.
 * Auto-enables when izGateMode is "hard" and a zone entry price is available,
 * preventing look-ahead bias from market orders filling at zone prices.
 */
function computeEffectiveLimitEnabled(
  configLimitOrderEnabled: boolean,
  izGateMode: "hard" | "soft" | "off",
  limitEntry: LimitEntry | null,
): boolean {
  return configLimitOrderEnabled || (izGateMode === "hard" && !!limitEntry);
}

/**
 * Determines whether the pendingOrders summary should report as enabled.
 * This is the outer-scope check (doesn't depend on per-pair limitEntry).
 */
function computePendingOrdersSummaryEnabled(
  configLimitOrderEnabled: boolean,
  configIzGateMode: "hard" | "soft" | "off",
): boolean {
  return configLimitOrderEnabled || configIzGateMode === "hard";
}

// ─── Tests: effectiveLimitEnabled per-pair logic ─────────────────────────────

Deno.test("effectiveLimitEnabled: auto-enables when izGateMode=hard and limitEntry exists", () => {
  const result = computeEffectiveLimitEnabled(false, "hard", {
    price: 4542.507,
    zoneType: "IZ-BULLISH",
    zoneLow: 4537.294,
    zoneHigh: 4551.136,
  });
  assertEquals(result, true, "Should auto-enable limit orders for hard gate with zone entry");
});

Deno.test("effectiveLimitEnabled: does NOT auto-enable when izGateMode=hard but no limitEntry", () => {
  const result = computeEffectiveLimitEnabled(false, "hard", null);
  assertEquals(result, false, "Should not enable limit orders without a zone entry, even in hard mode");
});

Deno.test("effectiveLimitEnabled: does NOT auto-enable when izGateMode=soft", () => {
  const result = computeEffectiveLimitEnabled(false, "soft", {
    price: 1.16554,
    zoneType: "IZ-BEARISH",
    zoneLow: 1.16409,
    zoneHigh: 1.16586,
  });
  assertEquals(result, false, "Should not auto-enable for soft gate mode");
});

Deno.test("effectiveLimitEnabled: does NOT auto-enable when izGateMode=off", () => {
  const result = computeEffectiveLimitEnabled(false, "off", {
    price: 1.16554,
    zoneType: "IZ-BEARISH",
    zoneLow: 1.16409,
    zoneHigh: 1.16586,
  });
  assertEquals(result, false, "Should not auto-enable for off gate mode");
});

Deno.test("effectiveLimitEnabled: respects config.limitOrderEnabled=true regardless of izGateMode", () => {
  // Even with soft/off mode, if user explicitly enabled limit orders, they stay on
  assertEquals(computeEffectiveLimitEnabled(true, "soft", null), true);
  assertEquals(computeEffectiveLimitEnabled(true, "off", null), true);
  assertEquals(computeEffectiveLimitEnabled(true, "hard", null), true);
  assertEquals(
    computeEffectiveLimitEnabled(true, "hard", {
      price: 4542.0,
      zoneType: "IZ-BULLISH",
      zoneLow: 4537.0,
      zoneHigh: 4551.0,
    }),
    true,
  );
});

Deno.test("effectiveLimitEnabled: false when config disabled and no hard gate", () => {
  assertEquals(computeEffectiveLimitEnabled(false, "soft", null), false);
  assertEquals(computeEffectiveLimitEnabled(false, "off", null), false);
});

// ─── Tests: pendingOrders summary logic ──────────────────────────────────────

Deno.test("pendingOrders summary: enabled when config.limitOrderEnabled=true", () => {
  assertEquals(computePendingOrdersSummaryEnabled(true, "soft"), true);
  assertEquals(computePendingOrdersSummaryEnabled(true, "off"), true);
  assertEquals(computePendingOrdersSummaryEnabled(true, "hard"), true);
});

Deno.test("pendingOrders summary: enabled when izGateMode=hard (auto-enable)", () => {
  assertEquals(computePendingOrdersSummaryEnabled(false, "hard"), true);
});

Deno.test("pendingOrders summary: disabled when config off and not hard gate", () => {
  assertEquals(computePendingOrdersSummaryEnabled(false, "soft"), false);
  assertEquals(computePendingOrdersSummaryEnabled(false, "off"), false);
});

// ─── Regression test: documents the behavior change ──────────────────────────

Deno.test("Regression: hard gate + zone entry now places limit order instead of market order", () => {
  // Before the fix:
  //   izGateMode=hard, zone refinedEntry=4542.507, lastPrice=4545
  //   → Market order at 4542.507 (WRONG: look-ahead bias)
  //
  // After the fix:
  //   effectiveLimitEnabled = true (because izGateMode=hard && limitEntry exists)
  //   → Limit order placed at 4542.507 (CORRECT: waits for price to reach level)
  //   → If limit orders were disabled, market order at 4545 (CORRECT: actual price)

  const configLimitOrderEnabled = false; // User didn't manually enable
  const izGateMode = "hard" as const;
  const limitEntry: LimitEntry = {
    price: 4542.507,
    zoneType: "IZ-BEARISH",
    zoneLow: 4537.294,
    zoneHigh: 4551.136,
  };

  const effective = computeEffectiveLimitEnabled(configLimitOrderEnabled, izGateMode, limitEntry);
  assertEquals(effective, true, "Hard gate with zone entry auto-enables limit orders");

  // This means the trade goes through the limit order path (pending_orders table)
  // instead of the market order path (paper_positions with immediate fill).
  // The limit order correctly waits for price to touch 4542.507 before filling.
});
