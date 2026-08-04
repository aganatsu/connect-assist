/**
 * Tests for pending order "replace stale" logic.
 *
 * Verifies that when a new setup arrives for the same (user_id, bot_id, symbol, direction),
 * the old pending order is cancelled with reason "Superseded" before the new one is inserted.
 *
 * This prevents the unique constraint violation on idx_pending_orders_unique_active.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ═══════════════════════════════════════════════════════════════════════
// Simulated pending_orders table for testing the replace-stale logic
// ═══════════════════════════════════════════════════════════════════════

interface PendingOrder {
  order_id: string;
  user_id: string;
  bot_id: string;
  symbol: string;
  direction: string;
  status: string;
  entry_price: number;
  signal_score: number;
  cancel_reason?: string;
}

/**
 * Simulates the "replace stale" logic extracted from bot-scanner/index.ts (lines 5933-5948).
 * Returns { cancelled: PendingOrder[], shouldInsert: boolean }
 */
function replaceStaleLogic(
  existingOrders: PendingOrder[],
  newSetup: { userId: string; botId: string; symbol: string; direction: string; score: number; entryPrice: number },
): { cancelled: PendingOrder[]; cancelReason: string } {
  const stalePending = existingOrders.filter(
    (o) =>
      o.user_id === newSetup.userId &&
      o.bot_id === newSetup.botId &&
      o.symbol === newSetup.symbol &&
      o.direction === newSetup.direction &&
      o.status === "pending",
  );

  const cancelled: PendingOrder[] = [];
  let cancelReason = "";

  if (stalePending.length > 0) {
    cancelReason = `Superseded by new setup (score ${newSetup.score.toFixed(1)} vs old ${stalePending[0].signal_score?.toFixed?.(1) ?? "?"}, entry ${newSetup.entryPrice} vs old ${stalePending[0].entry_price})`;
    for (const order of stalePending) {
      order.status = "cancelled";
      order.cancel_reason = cancelReason;
      cancelled.push(order);
    }
  }

  return { cancelled, cancelReason };
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

Deno.test("replace stale: cancels existing pending order for same symbol+direction", () => {
  const existing: PendingOrder[] = [
    { order_id: "abc123", user_id: "u1", bot_id: "b1", symbol: "EUR/USD", direction: "long", status: "pending", entry_price: 1.085, signal_score: 7.2 },
  ];

  const result = replaceStaleLogic(existing, {
    userId: "u1", botId: "b1", symbol: "EUR/USD", direction: "long", score: 8.5, entryPrice: 1.082,
  });

  assertEquals(result.cancelled.length, 1);
  assertEquals(result.cancelled[0].order_id, "abc123");
  assertEquals(result.cancelled[0].status, "cancelled");
  assertStringIncludes(result.cancelReason, "Superseded");
  assertStringIncludes(result.cancelReason, "8.5");
  assertStringIncludes(result.cancelReason, "7.2");
});

Deno.test("replace stale: does NOT cancel pending order for different direction", () => {
  const existing: PendingOrder[] = [
    { order_id: "abc123", user_id: "u1", bot_id: "b1", symbol: "EUR/USD", direction: "short", status: "pending", entry_price: 1.09, signal_score: 6.0 },
  ];

  const result = replaceStaleLogic(existing, {
    userId: "u1", botId: "b1", symbol: "EUR/USD", direction: "long", score: 8.5, entryPrice: 1.082,
  });

  assertEquals(result.cancelled.length, 0);
});

Deno.test("replace stale: does NOT cancel pending order for different symbol", () => {
  const existing: PendingOrder[] = [
    { order_id: "abc123", user_id: "u1", bot_id: "b1", symbol: "GBP/USD", direction: "long", status: "pending", entry_price: 1.27, signal_score: 7.0 },
  ];

  const result = replaceStaleLogic(existing, {
    userId: "u1", botId: "b1", symbol: "EUR/USD", direction: "long", score: 8.5, entryPrice: 1.082,
  });

  assertEquals(result.cancelled.length, 0);
});

Deno.test("replace stale: does NOT cancel already-cancelled or filled orders", () => {
  const existing: PendingOrder[] = [
    { order_id: "abc123", user_id: "u1", bot_id: "b1", symbol: "EUR/USD", direction: "long", status: "cancelled", entry_price: 1.085, signal_score: 7.2 },
    { order_id: "def456", user_id: "u1", bot_id: "b1", symbol: "EUR/USD", direction: "long", status: "filled", entry_price: 1.083, signal_score: 7.8 },
  ];

  const result = replaceStaleLogic(existing, {
    userId: "u1", botId: "b1", symbol: "EUR/USD", direction: "long", score: 8.5, entryPrice: 1.082,
  });

  assertEquals(result.cancelled.length, 0);
});

Deno.test("replace stale: cancels multiple pending orders if somehow more than one exists", () => {
  // Edge case: if the unique constraint was temporarily relaxed or there's a race condition
  const existing: PendingOrder[] = [
    { order_id: "abc123", user_id: "u1", bot_id: "b1", symbol: "EUR/USD", direction: "long", status: "pending", entry_price: 1.085, signal_score: 7.2 },
    { order_id: "def456", user_id: "u1", bot_id: "b1", symbol: "EUR/USD", direction: "long", status: "pending", entry_price: 1.084, signal_score: 6.5 },
  ];

  const result = replaceStaleLogic(existing, {
    userId: "u1", botId: "b1", symbol: "EUR/USD", direction: "long", score: 8.5, entryPrice: 1.082,
  });

  assertEquals(result.cancelled.length, 2);
  assertEquals(result.cancelled[0].status, "cancelled");
  assertEquals(result.cancelled[1].status, "cancelled");
});

Deno.test("replace stale: no existing pending → nothing cancelled, insert proceeds", () => {
  const existing: PendingOrder[] = [];

  const result = replaceStaleLogic(existing, {
    userId: "u1", botId: "b1", symbol: "EUR/USD", direction: "long", score: 8.5, entryPrice: 1.082,
  });

  assertEquals(result.cancelled.length, 0);
  assertEquals(result.cancelReason, "");
});

Deno.test("replace stale: does NOT cancel orders from different bot_id", () => {
  const existing: PendingOrder[] = [
    { order_id: "abc123", user_id: "u1", bot_id: "other-bot", symbol: "EUR/USD", direction: "long", status: "pending", entry_price: 1.085, signal_score: 7.2 },
  ];

  const result = replaceStaleLogic(existing, {
    userId: "u1", botId: "b1", symbol: "EUR/USD", direction: "long", score: 8.5, entryPrice: 1.082,
  });

  assertEquals(result.cancelled.length, 0);
});

Deno.test("replace stale: cancel reason includes old and new score + entry for audit trail", () => {
  const existing: PendingOrder[] = [
    { order_id: "abc123", user_id: "u1", bot_id: "b1", symbol: "XAU/USD", direction: "short", status: "pending", entry_price: 2380.5, signal_score: 6.8 },
  ];

  const result = replaceStaleLogic(existing, {
    userId: "u1", botId: "b1", symbol: "XAU/USD", direction: "short", score: 7.9, entryPrice: 2375.0,
  });

  assertEquals(result.cancelled.length, 1);
  assertStringIncludes(result.cancelReason, "7.9"); // new score
  assertStringIncludes(result.cancelReason, "6.8"); // old score
  assertStringIncludes(result.cancelReason, "2375"); // new entry
  assertStringIncludes(result.cancelReason, "2380.5"); // old entry
});
