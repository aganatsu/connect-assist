/**
 * Tests for the 2-part pending order cycling fix.
 *
 * Part 1: Post-expiry cooldown — prevents re-placement of same setup within TTL
 * Part 2: Block pending orders when confirmation.type = "none" — standalone signals
 *         with zero confirmation go to watchlist instead of placing pending orders
 *
 * These tests replicate the exact logic patterns from bot-scanner/index.ts to
 * verify correctness in isolation.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ═══════════════════════════════════════════════════════════════════════
// Part 2: Block pending orders when confirmation = "none"
// Replicates logic from bot-scanner/index.ts lines 6065-6076
// ═══════════════════════════════════════════════════════════════════════

interface UnifiedZoneConfirmation {
  type: "sweep_choch" | "ltf_choch" | "displacement" | "inducement" | "none";
  entryReady: boolean;
  detail: string;
  score: number;
}

interface UnifiedZoneData {
  hasZone: boolean;
  state: string;
  confirmation?: UnifiedZoneConfirmation;
}

/**
 * Determines if a pending order should be blocked based on confirmation type.
 * Returns { blocked: true, reason: string } if the order should NOT be placed.
 */
function shouldBlockPendingOrder(
  isStandaloneSignal: boolean,
  unifiedZoneData: UnifiedZoneData | null | undefined,
): { blocked: boolean; reason: string } {
  const uzConfirmationType = unifiedZoneData?.confirmation?.type;
  if (isStandaloneSignal && uzConfirmationType === "none") {
    return {
      blocked: true,
      reason: `Standalone signal with no confirmation (type=none) — watchlist only, pending order blocked`,
    };
  }
  return { blocked: false, reason: "" };
}

// ── Part 2 Tests ──

Deno.test("Part 2: Standalone signal with confirmation.type='none' → BLOCKED", () => {
  const result = shouldBlockPendingOrder(true, {
    hasZone: true,
    state: "watching",
    confirmation: { type: "none", entryReady: false, detail: "No confirmation — watchlist only", score: 0 },
  });
  assertEquals(result.blocked, true);
  assertStringIncludes(result.reason, "watchlist only");
});

Deno.test("Part 2: Standalone signal with confirmation.type='inducement' → NOT blocked", () => {
  const result = shouldBlockPendingOrder(true, {
    hasZone: true,
    state: "watching",
    confirmation: { type: "inducement", entryReady: false, detail: "Inducement: minor_swing (quality 7/10)", score: 1.0 },
  });
  assertEquals(result.blocked, false);
});

Deno.test("Part 2: Standalone signal with confirmation.type='displacement' → NOT blocked", () => {
  const result = shouldBlockPendingOrder(true, {
    hasZone: true,
    state: "watching",
    confirmation: { type: "displacement", entryReady: true, detail: "Displacement from zone", score: 1.5 },
  });
  assertEquals(result.blocked, false);
});

Deno.test("Part 2: Unified signal (not standalone) with confirmation.type='none' → NOT blocked", () => {
  // Unified signals have already passed the gate — they should not be blocked
  const result = shouldBlockPendingOrder(false, {
    hasZone: true,
    state: "confirmed",
    confirmation: { type: "none", entryReady: false, detail: "No confirmation", score: 0 },
  });
  assertEquals(result.blocked, false);
});

Deno.test("Part 2: Standalone signal with no unifiedZoneData → NOT blocked", () => {
  // No unified zone data at all — this is a legacy path, don't block
  const result = shouldBlockPendingOrder(true, null);
  assertEquals(result.blocked, false);
});

Deno.test("Part 2: Standalone signal with unifiedZoneData but no confirmation → NOT blocked", () => {
  // Zone exists but confirmation field is missing — don't block (defensive)
  const result = shouldBlockPendingOrder(true, {
    hasZone: true,
    state: "watching",
  });
  assertEquals(result.blocked, false);
});

// ═══════════════════════════════════════════════════════════════════════
// Part 1: Post-expiry cooldown
// Replicates logic from bot-scanner/index.ts lines 6078-6096
// ═══════════════════════════════════════════════════════════════════════

interface ExpiredOrder {
  order_id: string;
  resolved_at: string;
  entry_price: string;
  symbol: string;
  direction: string;
  status: string;
}

/**
 * Determines if a new pending order should be blocked due to post-expiry cooldown.
 * Simulates the DB query by checking in-memory expired orders.
 */
function shouldBlockDueToCooldown(
  expiredOrders: ExpiredOrder[],
  symbol: string,
  direction: string,
  cooldownMinutes: number,
  nowMs: number,
): { blocked: boolean; reason: string } {
  const cooldownCutoff = new Date(nowMs - cooldownMinutes * 60 * 1000).toISOString();
  const recentExpired = expiredOrders.filter(
    (o) =>
      o.symbol === symbol &&
      o.direction === direction &&
      o.status === "expired" &&
      o.resolved_at >= cooldownCutoff,
  );
  if (recentExpired.length > 0) {
    return {
      blocked: true,
      reason: `Post-expiry cooldown: same setup expired at ${recentExpired[0].resolved_at} (within ${cooldownMinutes}min cooldown)`,
    };
  }
  return { blocked: false, reason: "" };
}

// ── Part 1 Tests ──

Deno.test("Part 1: Same symbol+direction expired 30min ago (within 60min cooldown) → BLOCKED", () => {
  const now = Date.now();
  const expiredOrders: ExpiredOrder[] = [{
    order_id: "abc123",
    resolved_at: new Date(now - 30 * 60 * 1000).toISOString(), // 30 min ago
    entry_price: "1.38500",
    symbol: "GBP/CAD",
    direction: "long",
    status: "expired",
  }];
  const result = shouldBlockDueToCooldown(expiredOrders, "GBP/CAD", "long", 60, now);
  assertEquals(result.blocked, true);
  assertStringIncludes(result.reason, "Post-expiry cooldown");
});

Deno.test("Part 1: Same symbol+direction expired 90min ago (outside 60min cooldown) → NOT blocked", () => {
  const now = Date.now();
  const expiredOrders: ExpiredOrder[] = [{
    order_id: "abc123",
    resolved_at: new Date(now - 90 * 60 * 1000).toISOString(), // 90 min ago
    entry_price: "1.38500",
    symbol: "GBP/CAD",
    direction: "long",
    status: "expired",
  }];
  const result = shouldBlockDueToCooldown(expiredOrders, "GBP/CAD", "long", 60, now);
  assertEquals(result.blocked, false);
});

Deno.test("Part 1: Different direction expired recently → NOT blocked", () => {
  const now = Date.now();
  const expiredOrders: ExpiredOrder[] = [{
    order_id: "abc123",
    resolved_at: new Date(now - 10 * 60 * 1000).toISOString(), // 10 min ago
    entry_price: "1.38500",
    symbol: "GBP/CAD",
    direction: "short", // Different direction
    status: "expired",
  }];
  const result = shouldBlockDueToCooldown(expiredOrders, "GBP/CAD", "long", 60, now);
  assertEquals(result.blocked, false);
});

Deno.test("Part 1: Different symbol expired recently → NOT blocked", () => {
  const now = Date.now();
  const expiredOrders: ExpiredOrder[] = [{
    order_id: "abc123",
    resolved_at: new Date(now - 10 * 60 * 1000).toISOString(),
    entry_price: "0.67500",
    symbol: "USD/CAD", // Different symbol
    direction: "long",
    status: "expired",
  }];
  const result = shouldBlockDueToCooldown(expiredOrders, "GBP/CAD", "long", 60, now);
  assertEquals(result.blocked, false);
});

Deno.test("Part 1: No expired orders at all → NOT blocked", () => {
  const now = Date.now();
  const result = shouldBlockDueToCooldown([], "GBP/CAD", "long", 60, now);
  assertEquals(result.blocked, false);
});

Deno.test("Part 1: Swing trader with 480min TTL — expired 200min ago → BLOCKED", () => {
  const now = Date.now();
  const expiredOrders: ExpiredOrder[] = [{
    order_id: "swing1",
    resolved_at: new Date(now - 200 * 60 * 1000).toISOString(), // 200 min ago
    entry_price: "1.10000",
    symbol: "EUR/USD",
    direction: "short",
    status: "expired",
  }];
  // Swing trader uses 480min TTL as cooldown
  const result = shouldBlockDueToCooldown(expiredOrders, "EUR/USD", "short", 480, now);
  assertEquals(result.blocked, true);
});

// ═══════════════════════════════════════════════════════════════════════
// Integration / Regression Tests
// Verify the two parts work together correctly
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Regression: Unified signal with confirmation.type='none' is NOT blocked (only standalone is)", () => {
  // This is the key regression test — unified signals that passed the gate
  // should NEVER be blocked by Part 2, even if their confirmation type is "none"
  const result = shouldBlockPendingOrder(false, {
    hasZone: true,
    state: "triggered",
    confirmation: { type: "none", entryReady: false, detail: "No confirmation", score: 0 },
  });
  assertEquals(result.blocked, false);
});

Deno.test("Regression: Standalone with inducement confirmation can still place pending orders", () => {
  // Inducement is a valid confirmation signal (score=1.0) — it should NOT be blocked
  // Only type="none" (score=0) gets blocked
  const result = shouldBlockPendingOrder(true, {
    hasZone: true,
    state: "watching",
    confirmation: { type: "inducement", entryReady: false, detail: "Inducement: minor_swing (quality 7/10)", score: 1.0 },
  });
  assertEquals(result.blocked, false);
});

Deno.test("Regression: Cooldown uses same TTL as expiry (not hardcoded)", () => {
  const now = Date.now();
  // Scalper: 60min TTL → 60min cooldown
  const expiredOrders: ExpiredOrder[] = [{
    order_id: "scalp1",
    resolved_at: new Date(now - 50 * 60 * 1000).toISOString(), // 50 min ago
    entry_price: "1.10000",
    symbol: "EUR/USD",
    direction: "long",
    status: "expired",
  }];
  // With 60min cooldown: 50min ago is within → blocked
  assertEquals(shouldBlockDueToCooldown(expiredOrders, "EUR/USD", "long", 60, now).blocked, true);
  // With 30min cooldown (hypothetical): 50min ago is outside → not blocked
  assertEquals(shouldBlockDueToCooldown(expiredOrders, "EUR/USD", "long", 30, now).blocked, false);
});

Deno.test("Config: pendingOrderCooldownMinutes > 0 overrides limitOrderExpiryMinutes", () => {
  const now = Date.now();
  const expiredOrders: ExpiredOrder[] = [{
    order_id: "cfg1",
    resolved_at: new Date(now - 40 * 60 * 1000).toISOString(), // 40 min ago
    entry_price: "1.10000",
    symbol: "EUR/USD",
    direction: "long",
    status: "expired",
  }];
  // limitOrderExpiryMinutes=60 would block (40 < 60), but pendingOrderCooldownMinutes=30 does NOT block (40 > 30)
  // Simulate the config resolution: if pendingOrderCooldownMinutes > 0, use it; else use limitOrderExpiryMinutes
  const pendingOrderCooldownMinutes = 30;
  const limitOrderExpiryMinutes = 60;
  const effectiveCooldown = pendingOrderCooldownMinutes > 0 ? pendingOrderCooldownMinutes : limitOrderExpiryMinutes;
  const result = shouldBlockDueToCooldown(expiredOrders, "EUR/USD", "long", effectiveCooldown, now);
  assertEquals(result.blocked, false); // 40 > 30, so NOT blocked
});

Deno.test("Config: pendingOrderCooldownMinutes = 0 falls back to limitOrderExpiryMinutes", () => {
  const now = Date.now();
  const expiredOrders: ExpiredOrder[] = [{
    order_id: "cfg2",
    resolved_at: new Date(now - 40 * 60 * 1000).toISOString(), // 40 min ago
    entry_price: "1.10000",
    symbol: "EUR/USD",
    direction: "long",
    status: "expired",
  }];
  // pendingOrderCooldownMinutes=0 → use limitOrderExpiryMinutes=60 → 40 < 60 → BLOCKED
  const pendingOrderCooldownMinutes = 0;
  const limitOrderExpiryMinutes = 60;
  const effectiveCooldown = pendingOrderCooldownMinutes > 0 ? pendingOrderCooldownMinutes : limitOrderExpiryMinutes;
  const result = shouldBlockDueToCooldown(expiredOrders, "EUR/USD", "long", effectiveCooldown, now);
  assertEquals(result.blocked, true); // 40 < 60, so BLOCKED
});
