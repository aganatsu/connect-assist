/**
 * rejectedSetupLogger.test.ts — Unit tests for Rejected Setup Logging
 * ────────────────────────────────────────────────────────────────────
 * Tests the logging function and shouldLogBelowThreshold helper.
 * Uses a mock Supabase client to verify correct DB row construction.
 *
 * Run: deno test --allow-all supabase/functions/_shared/rejectedSetupLogger.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  logRejectedSetup,
  shouldLogBelowThreshold,
  type RejectedSetupParams,
} from "./rejectedSetupLogger.ts";

// ── Mock Supabase client ──

function createMockSupabase(shouldFail: boolean = false) {
  const insertedRows: any[] = [];
  return {
    client: {
      from: (table: string) => ({
        insert: (row: any) => {
          insertedRows.push({ table, row });
          if (shouldFail) {
            return { error: { message: "Mock DB error" } };
          }
          return { error: null };
        },
      }),
    },
    insertedRows,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1: shouldLogBelowThreshold
// ═══════════════════════════════════════════════════════════════════════

Deno.test("shouldLogBelowThreshold: 0 T1 factors → false", () => {
  assertEquals(shouldLogBelowThreshold(0), false);
});

Deno.test("shouldLogBelowThreshold: 1 T1 factor → false", () => {
  assertEquals(shouldLogBelowThreshold(1), false);
});

Deno.test("shouldLogBelowThreshold: 2 T1 factors → true", () => {
  assertEquals(shouldLogBelowThreshold(2), true);
});

Deno.test("shouldLogBelowThreshold: 5 T1 factors → true", () => {
  assertEquals(shouldLogBelowThreshold(5), true);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: logRejectedSetup — successful insert
// ═══════════════════════════════════════════════════════════════════════

Deno.test("logRejectedSetup: gate_blocked inserts correct row", async () => {
  const { client, insertedRows } = createMockSupabase(false);
  const result = await logRejectedSetup({
    supabase: client,
    userId: "user-123",
    symbol: "EUR/USD",
    direction: "long",
    rejectionType: "gate_blocked",
    failedGates: ["Max positions reached", "Correlation limit"],
    confluenceScore: 72.5,
    tier1Count: 3,
    tier1Factors: ["HTF Bias", "Order Block", "Displacement"],
    entryPrice: 1.0850,
    stopLoss: 1.0820,
    takeProfit: 1.0910,
    rrRatio: 2.0,
    sessionName: "london",
    regime: "trending",
    gpBias: "bullish",
    gpBiasConfidence: 75,
    fotsiBaseTsi: 45,
    fotsiQuoteTsi: -20,
    priceAtRejection: 1.0855,
  });

  assertEquals(result, true);
  assertEquals(insertedRows.length, 1);
  assertEquals(insertedRows[0].table, "rejected_setups");

  const row = insertedRows[0].row;
  assertEquals(row.user_id, "user-123");
  assertEquals(row.bot_id, "smc");
  assertEquals(row.symbol, "EUR/USD");
  assertEquals(row.direction, "long");
  assertEquals(row.rejection_type, "gate_blocked");
  assertEquals(row.failed_gates, ["Max positions reached", "Correlation limit"]);
  assertEquals(row.confluence_score, 72.5);
  assertEquals(row.tier1_count, 3);
  assertEquals(row.tier1_factors, ["HTF Bias", "Order Block", "Displacement"]);
  assertEquals(row.entry_price, 1.0850);
  assertEquals(row.stop_loss, 1.0820);
  assertEquals(row.take_profit, 1.0910);
  assertEquals(row.rr_ratio, 2.0);
  assertEquals(row.session_name, "london");
  assertEquals(row.regime, "trending");
  assertEquals(row.gp_bias, "bullish");
  assertEquals(row.gp_bias_confidence, 75);
  assertEquals(row.fotsi_base_tsi, 45);
  assertEquals(row.fotsi_quote_tsi, -20);
  assertEquals(row.price_at_rejection, 1.0855);
  assertEquals(row.outcome_status, "pending");
});

Deno.test("logRejectedSetup: below_threshold_strong_t1 with minimal fields", async () => {
  const { client, insertedRows } = createMockSupabase(false);
  const result = await logRejectedSetup({
    supabase: client,
    userId: "user-456",
    symbol: "GBP/USD",
    direction: "short",
    rejectionType: "below_threshold_strong_t1",
    confluenceScore: 42.0,
    tier1Count: 2,
    entryPrice: 1.2650,
  });

  assertEquals(result, true);
  assertEquals(insertedRows.length, 1);

  const row = insertedRows[0].row;
  assertEquals(row.user_id, "user-456");
  assertEquals(row.symbol, "GBP/USD");
  assertEquals(row.direction, "short");
  assertEquals(row.rejection_type, "below_threshold_strong_t1");
  assertEquals(row.failed_gates, []);
  assertEquals(row.confluence_score, 42.0);
  assertEquals(row.tier1_count, 2);
  assertEquals(row.tier1_factors, []);
  assertEquals(row.entry_price, 1.2650);
  assertEquals(row.price_at_rejection, 1.2650); // Falls back to entryPrice
  assertEquals(row.outcome_status, "pending");
  // Optional fields should NOT be present
  assertEquals(row.stop_loss, undefined);
  assertEquals(row.take_profit, undefined);
  assertEquals(row.rr_ratio, undefined);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3: logRejectedSetup — failure handling (non-fatal)
// ═══════════════════════════════════════════════════════════════════════

Deno.test("logRejectedSetup: DB error returns false (non-fatal)", async () => {
  const { client } = createMockSupabase(true); // Will fail
  const result = await logRejectedSetup({
    supabase: client,
    userId: "user-789",
    symbol: "USD/JPY",
    direction: "long",
    rejectionType: "gate_blocked",
    confluenceScore: 65.0,
    tier1Count: 2,
    entryPrice: 155.50,
  });

  assertEquals(result, false); // Should return false, not throw
});

Deno.test("logRejectedSetup: exception in supabase client returns false", async () => {
  const throwingClient = {
    from: () => {
      throw new Error("Connection refused");
    },
  };
  const result = await logRejectedSetup({
    supabase: throwingClient,
    userId: "user-999",
    symbol: "XAU/USD",
    direction: "short",
    rejectionType: "gate_blocked",
    confluenceScore: 80.0,
    tier1Count: 4,
    entryPrice: 2350.00,
  });

  assertEquals(result, false); // Should catch and return false
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 4: logRejectedSetup — default bot_id
// ═══════════════════════════════════════════════════════════════════════

Deno.test("logRejectedSetup: default bot_id is 'smc'", async () => {
  const { client, insertedRows } = createMockSupabase(false);
  await logRejectedSetup({
    supabase: client,
    userId: "user-abc",
    symbol: "EUR/GBP",
    direction: "long",
    rejectionType: "gate_blocked",
    confluenceScore: 55.0,
    tier1Count: 1,
    entryPrice: 0.8500,
  });

  assertEquals(insertedRows[0].row.bot_id, "smc");
});

Deno.test("logRejectedSetup: custom bot_id is preserved", async () => {
  const { client, insertedRows } = createMockSupabase(false);
  await logRejectedSetup({
    supabase: client,
    userId: "user-abc",
    botId: "custom-bot",
    symbol: "EUR/GBP",
    direction: "long",
    rejectionType: "gate_blocked",
    confluenceScore: 55.0,
    tier1Count: 1,
    entryPrice: 0.8500,
  });

  assertEquals(insertedRows[0].row.bot_id, "custom-bot");
});
