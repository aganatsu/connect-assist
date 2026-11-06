/**
 * rejectedSetupLogger.test.ts — Unit tests for Rejected Setup Logging
 * ────────────────────────────────────────────────────────────────────
 * Tests the logging function. No score or tier fields are written: the
 * confluence score and its tiers were removed.
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
// SECTION 1: logRejectedSetup — successful insert
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

Deno.test("logRejectedSetup: minimal fields; no score or tier columns are written", async () => {
  const { client, insertedRows } = createMockSupabase(false);
  const result = await logRejectedSetup({
    supabase: client,
    userId: "user-456",
    symbol: "GBP/USD",
    direction: "short",
    rejectionType: "gate_blocked",
    entryPrice: 1.2650,
  });

  assertEquals(result, true);
  const row = insertedRows[0].row;
  assertEquals(row.rejection_type, "gate_blocked");
  assertEquals(row.failed_gates, []);
  assertEquals(row.entry_price, 1.2650);
  assertEquals(row.price_at_rejection, 1.2650); // Falls back to entryPrice
  // confluence_score is a NOT NULL legacy column: a fixed 0 placeholder, never a score.
  assertEquals(row.confluence_score, 0);
  for (const k of ["tier1_count", "tier1_factors", "stop_loss", "take_profit", "rr_ratio"]) {
    assert(!(k in row), `${k} must not be written`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: logRejectedSetup — failure handling (non-fatal)
// ═══════════════════════════════════════════════════════════════════════

Deno.test("logRejectedSetup: DB error returns false (non-fatal)", async () => {
  const { client } = createMockSupabase(true); // Will fail
  const result = await logRejectedSetup({
    supabase: client,
    userId: "user-789",
    symbol: "USD/JPY",
    direction: "long",
    rejectionType: "gate_blocked",
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
    entryPrice: 2350.00,
  });

  assertEquals(result, false); // Should catch and return false
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3: logRejectedSetup — default bot_id
// ═══════════════════════════════════════════════════════════════════════

Deno.test("logRejectedSetup: default bot_id is 'smc'", async () => {
  const { client, insertedRows } = createMockSupabase(false);
  await logRejectedSetup({
    supabase: client,
    userId: "user-abc",
    symbol: "EUR/GBP",
    direction: "long",
    rejectionType: "gate_blocked",
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
    entryPrice: 0.8500,
  });

  assertEquals(insertedRows[0].row.bot_id, "custom-bot");
});
