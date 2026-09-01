/**
 * Unit tests for propFirmGate.ts safety fixes:
 * 1. Live account without broker equity → skip (don't fall back to paper balance)
 * 2. Equity sanity check (< 50% of initial_balance → skip)
 * 3. Weekend FX guard in emergency close (only close crypto on weekends)
 *
 * Run with: deno test supabase/functions/_shared/propFirmGate.test.ts
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  runPropFirmGate,
  propFirmEmergencyClose,
} from "./propFirmGate.ts";

// ─── Mock Supabase Client ────────────────────────────────────────────────────

function makeMockSupabase(opts: {
  config?: any;
  dailyState?: any;
  prevStates?: any[];
  insertedEvents?: any[];
  deletedPositions?: string[];
  insertedHistory?: any[];
  accountBalance?: string;
}) {
  const insertedEvents: any[] = opts.insertedEvents || [];
  const deletedPositions: string[] = opts.deletedPositions || [];
  const insertedHistory: any[] = opts.insertedHistory || [];

  return {
    from: (table: string) => {
      if (table === "prop_firm_config") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: opts.config || null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "prop_firm_daily_state") {
        return {
          select: () => ({
            eq: (_: string, __: any) => ({
              eq: (_: string, __: any) => ({
                maybeSingle: async () => ({ data: opts.dailyState || null, error: null }),
              }),
              order: () => ({
                limit: () => opts.prevStates || [],
              }),
            }),
          }),
          insert: (data: any) => ({
            select: () => ({
              single: async () => ({ data: { ...data, id: "new-state-id" }, error: null }),
            }),
          }),
          update: (_: any) => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        };
      }
      if (table === "prop_firm_events") {
        return {
          insert: async (data: any) => { insertedEvents.push(data); return { error: null }; },
        };
      }
      if (table === "paper_positions") {
        return {
          delete: () => ({
            eq: async () => { return { error: null }; },
          }),
        };
      }
      if (table === "paper_trade_history") {
        return {
          insert: async (data: any) => { insertedHistory.push(data); return { error: null }; },
        };
      }
      if (table === "paper_accounts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { balance: opts.accountBalance || "100000" }, error: null }),
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ error: null }),
            }),
          }),
        };
      }
      return {};
    },
  };
}

function makeConfig(overrides: any = {}) {
  return {
    id: "test-config",
    user_id: "test-user",
    bot_id: "smc",
    is_active: true,
    initial_balance: 100_000,
    max_daily_loss_pct: 5,
    max_drawdown_pct: 10,
    profit_target_pct: 10,
    daily_loss_type: "balance_based",
    drawdown_type: "static",
    best_day_rule_enabled: false,
    best_day_rule_pct: 0,
    ...overrides,
  };
}

function makeDailyState(overrides: any = {}) {
  return {
    id: "test-state",
    config_id: "test-config",
    trading_day: "2026-05-10",
    day_start_balance: 100_000,
    day_start_equity: 100_000,
    highest_equity_today: 100_500,
    lowest_equity_today: 99_500,
    current_equity: 100_000,
    highest_eod_balance_ever: 100_000,
    end_of_day_balance: 100_000,
    is_locked: false,
    locked_at: null,
    lock_reason: null,
    trades_today: 0,
    ...overrides,
  };
}

// ─── Test: Live account without broker equity → skip ─────────────────────────

Deno.test("propFirmGate: live account without broker equity skips check (safety)", async () => {
  const config = makeConfig();
  const dailyState = makeDailyState();
  const supabase = makeMockSupabase({ config, dailyState });

  // Simulate: live account, broker equity fetch FAILED (undefined)
  // Paper balance is $10,000 (wrong — real account is $100K)
  const result = await runPropFirmGate(
    supabase, "test-user", "smc", 10_000, [], "scan-001",
    { brokerEquity: undefined, isLiveAccount: true },
  );

  assertEquals(result.enabled, true);
  assertEquals(result.allowed, true);
  assertEquals(result.shouldCloseAll, false);
  assert(result.reason.includes("Broker equity unavailable"));
  assertEquals(result.configId, "test-config");
});

Deno.test("propFirmGate: live account WITH broker equity proceeds normally", async () => {
  const config = makeConfig();
  const dailyState = makeDailyState();
  const supabase = makeMockSupabase({ config, dailyState });

  // Simulate: live account, broker equity = $99,500 (healthy)
  const result = await runPropFirmGate(
    supabase, "test-user", "smc", 10_000, [], "scan-002",
    { brokerEquity: 99_500, isLiveAccount: true },
  );

  assertEquals(result.enabled, true);
  // Should proceed to compliance check (not skip)
  // With $99,500 equity and $90K floor, it should be allowed
  assertEquals(result.allowed, true);
  assertEquals(result.shouldCloseAll, false);
});

// ─── Test: Sanity check (equity < 50% of initial_balance) ────────────────────

Deno.test("propFirmGate: equity sanity check blocks false emergency (paper mode)", async () => {
  const config = makeConfig({ initial_balance: 100_000 });
  const dailyState = makeDailyState();
  const supabase = makeMockSupabase({ config, dailyState });

  // Simulate: paper balance is $10,000 (should be $100K — data error)
  // No open positions, so equity = paperBalance = $10,000
  // $10,000 < 50% of $100,000 → sanity check triggers
  const result = await runPropFirmGate(
    supabase, "test-user", "smc", 10_000, [], "scan-003",
    { isLiveAccount: false },
  );

  assertEquals(result.enabled, true);
  assertEquals(result.allowed, true);
  assertEquals(result.shouldCloseAll, false);
  assert(result.reason.includes("sanity check failed"));
});

Deno.test("propFirmGate: equity at 60% of initial_balance passes sanity check", async () => {
  const config = makeConfig({ initial_balance: 100_000 });
  const dailyState = makeDailyState({ day_start_balance: 60_000 });
  const supabase = makeMockSupabase({ config, dailyState });

  // $60,000 is 60% of $100K — above the 50% sanity threshold
  // Should proceed to normal compliance check
  const result = await runPropFirmGate(
    supabase, "test-user", "smc", 60_000, [], "scan-004",
    { isLiveAccount: false },
  );

  assertEquals(result.enabled, true);
  // This will trigger a real drawdown breach (60K vs 90K floor)
  // but the point is it DOES run the check (doesn't skip from sanity)
  assert(!result.reason.includes("sanity check"));
});

// ─── Test: Weekend FX guard in emergency close ───────────────────────────────

Deno.test("propFirmEmergencyClose: weekend skips FX positions, only closes crypto", async () => {
  const deletedPositions: string[] = [];
  const insertedHistory: any[] = [];
  const supabase = makeMockSupabase({ deletedPositions, insertedHistory, accountBalance: "100000" });

  // Override the delete mock to track which positions get closed
  let closedSymbols: string[] = [];
  (supabase as any).from = (table: string) => {
    if (table === "paper_positions") {
      return {
        delete: () => ({
          eq: async (_: string, id: string) => {
            deletedPositions.push(id);
            return { error: null };
          },
        }),
      };
    }
    if (table === "paper_trade_history") {
      return {
        insert: async (data: any) => {
          insertedHistory.push(data);
          closedSymbols.push(data.symbol);
          return { error: null };
        },
      };
    }
    if (table === "paper_accounts") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { balance: "100000" }, error: null }),
            }),
          }),
        }),
        update: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        }),
      };
    }
    return {};
  };

  const positions = [
    { id: "1", symbol: "EURUSD", direction: "long", entry_price: "1.1000", current_price: "1.0950", size: "0.01", position_id: "p1" },
    { id: "2", symbol: "GBPUSD", direction: "short", entry_price: "1.2500", current_price: "1.2550", size: "0.01", position_id: "p2" },
    { id: "3", symbol: "BTCUSD", direction: "long", entry_price: "80000", current_price: "79000", size: "0.01", position_id: "p3" },
    { id: "4", symbol: "USDCAD", direction: "short", entry_price: "1.3700", current_price: "1.3750", size: "0.01", position_id: "p4" },
  ];

  // Weekend: FX market closed
  const closedCount = await propFirmEmergencyClose(
    supabase, "test-user", "smc", positions, "test emergency", "scan-005",
    { fxMarketClosed: true },
  );

  // Only BTCUSD should be closed (crypto)
  assertEquals(closedCount, 1);
  assertEquals(closedSymbols.length, 1);
  assertEquals(closedSymbols[0], "BTCUSD");
});

Deno.test("propFirmEmergencyClose: weekday closes all positions", async () => {
  const insertedHistory: any[] = [];
  let closedSymbols: string[] = [];

  const supabase = {
    from: (table: string) => {
      if (table === "paper_positions") {
        return {
          delete: () => ({
            eq: async () => ({ error: null }),
          }),
        };
      }
      if (table === "paper_trade_history") {
        return {
          insert: async (data: any) => {
            insertedHistory.push(data);
            closedSymbols.push(data.symbol);
            return { error: null };
          },
        };
      }
      if (table === "paper_accounts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { balance: "100000" }, error: null }),
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ error: null }),
            }),
          }),
        };
      }
      return {};
    },
  };

  const positions = [
    { id: "1", symbol: "EURUSD", direction: "long", entry_price: "1.1000", current_price: "1.0950", size: "0.01", position_id: "p1" },
    { id: "2", symbol: "BTCUSD", direction: "long", entry_price: "80000", current_price: "79000", size: "0.01", position_id: "p3" },
    { id: "3", symbol: "USDCAD", direction: "short", entry_price: "1.3700", current_price: "1.3750", size: "0.01", position_id: "p4" },
  ];

  // Weekday: FX market open — close everything
  const closedCount = await propFirmEmergencyClose(
    supabase as any, "test-user", "smc", positions, "test emergency", "scan-006",
    { fxMarketClosed: false },
  );

  assertEquals(closedCount, 3);
  assertEquals(closedSymbols.length, 3);
  assert(closedSymbols.includes("EURUSD"));
  assert(closedSymbols.includes("BTCUSD"));
  assert(closedSymbols.includes("USDCAD"));
});

Deno.test("propFirmEmergencyClose: no opts (backward compat) closes all", async () => {
  const insertedHistory: any[] = [];
  let closedSymbols: string[] = [];

  const supabase = {
    from: (table: string) => {
      if (table === "paper_positions") {
        return {
          delete: () => ({
            eq: async () => ({ error: null }),
          }),
        };
      }
      if (table === "paper_trade_history") {
        return {
          insert: async (data: any) => {
            insertedHistory.push(data);
            closedSymbols.push(data.symbol);
            return { error: null };
          },
        };
      }
      if (table === "paper_accounts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { balance: "100000" }, error: null }),
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ error: null }),
            }),
          }),
        };
      }
      return {};
    },
  };

  const positions = [
    { id: "1", symbol: "EURUSD", direction: "long", entry_price: "1.1000", current_price: "1.0950", size: "0.01", position_id: "p1" },
    { id: "2", symbol: "BTCUSD", direction: "long", entry_price: "80000", current_price: "79000", size: "0.01", position_id: "p3" },
  ];

  // No opts passed at all — backward compatible, closes everything
  const closedCount = await propFirmEmergencyClose(
    supabase as any, "test-user", "smc", positions, "test emergency", "scan-007",
  );

  assertEquals(closedCount, 2);
  assertEquals(closedSymbols.length, 2);
});
