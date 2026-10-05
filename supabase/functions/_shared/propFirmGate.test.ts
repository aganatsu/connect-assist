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

/**
 * Emergency closes settle through the settle_paper_position RPC. This mock
 * records each settlement and fails the test on any direct table write — the
 * old path updated paper_accounts.balance itself.
 */
function makeSettlementMock(opts: { refuse?: Set<string> } = {}) {
  const settled: { rowId: string; symbol: string; pnl: number; source: string }[] = [];
  const supabase = {
    rpc: async (fn: string, args: any) => {
      assertEquals(fn, "settle_paper_position");
      if (opts.refuse?.has(args.p_position_row_id)) {
        return { data: { settled: false, code: "already_settled" }, error: null };
      }
      const pnl = parseFloat(args.p_history.pnl);
      settled.push({ rowId: args.p_position_row_id, symbol: args.p_history.symbol, pnl, source: args.p_source });
      return { data: { settled: true, code: "settled", amount: pnl, balance: 100000 + pnl, history_id: "h", ledger_id: "l" }, error: null };
    },
    from: (table: string) => {
      throw new Error(`emergency close must not write ${table} directly`);
    },
  };
  return { supabase, settled };
}

Deno.test("propFirmEmergencyClose: weekend skips FX positions, only closes crypto", async () => {
  const { supabase, settled } = makeSettlementMock();

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
  assertEquals(settled.map((s) => s.symbol), ["BTCUSD"]);
  assertEquals(settled[0].source, "prop_firm_emergency");
  // The skipped FX positions' P&L is NOT booked. The old code re-summed P&L
  // over every open position and credited it in one write.
  assertEquals(settled.reduce((a, s) => a + s.pnl, 0), settled[0].pnl);
});

Deno.test("propFirmEmergencyClose: weekday closes all positions", async () => {
  const { supabase, settled } = makeSettlementMock();

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
  const closedSymbols = settled.map((s) => s.symbol);
  assert(closedSymbols.includes("EURUSD"));
  assert(closedSymbols.includes("BTCUSD"));
  assert(closedSymbols.includes("USDCAD"));
});

Deno.test("propFirmEmergencyClose: no opts (backward compat) closes all", async () => {
  const { supabase, settled } = makeSettlementMock();

  const positions = [
    { id: "1", symbol: "EURUSD", direction: "long", entry_price: "1.1000", current_price: "1.0950", size: "0.01", position_id: "p1" },
    { id: "2", symbol: "BTCUSD", direction: "long", entry_price: "80000", current_price: "79000", size: "0.01", position_id: "p3" },
  ];

  // No opts passed at all — backward compatible, closes everything
  const closedCount = await propFirmEmergencyClose(
    supabase as any, "test-user", "smc", positions, "test emergency", "scan-007",
  );

  assertEquals(closedCount, 2);
  assertEquals(settled.length, 2);
});

Deno.test("propFirmEmergencyClose: a position settled elsewhere first is not counted or credited", async () => {
  const { supabase, settled } = makeSettlementMock({ refuse: new Set(["1"]) });
  const positions = [
    { id: "1", symbol: "EURUSD", direction: "long", entry_price: "1.1000", current_price: "1.0950", size: "0.01", position_id: "p1" },
    { id: "2", symbol: "USDCAD", direction: "short", entry_price: "1.3700", current_price: "1.3750", size: "0.01", position_id: "p4" },
  ];
  const closedCount = await propFirmEmergencyClose(supabase as any, "test-user", "smc", positions, "x", "scan-008");
  assertEquals(closedCount, 1);
  assertEquals(settled.map((s) => s.symbol), ["USDCAD"]);
});

Deno.test("propFirmEmergencyClose: pnlFor replaces the flat 100,000 approximation", async () => {
  const { supabase, settled } = makeSettlementMock();
  // USD/JPY long 1 lot, +0.5 yen. Flat formula: 0.5 * 1 * 100000 = 50,000.
  // Real: 0.5 * 100,000 units / 155.5 JPY per USD = ~321.54 USD.
  const positions = [{ id: "1", symbol: "USD/JPY", direction: "long", entry_price: "155.0", current_price: "155.5", size: "1", position_id: "p1" }];
  await propFirmEmergencyClose(supabase as any, "test-user", "smc", positions, "x", "scan-009", {
    pnlFor: (p, exit) => (exit - parseFloat(p.entry_price)) * 100_000 * parseFloat(p.size) / exit,
  });
  assertEquals(settled[0].pnl, 321.54);
});
