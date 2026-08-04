/**
 * scannerManagement.partialTP.test.ts — Partial-TP Accounting Tests
 * ──────────────────────────────────────────────────────────────────
 * Verifies that manageOpenPositions:
 *   1. Executes full partial-TP accounting (size reduction, history insert, balance update)
 *   2. Skips partial-TP when already activated (partialTPActivated or partial_tp_fired)
 *   3. Produces "partial_tp_executed" action (not old "partial_enabled")
 *   4. Calculates PnL correctly for the closed portion
 *
 * Run: deno test --allow-all supabase/functions/_shared/scannerManagement.partialTP.test.ts
 */
import { manageOpenPositions } from "../../functions/_shared/scannerManagement.ts";
import {
  assertEquals,
  assertAlmostEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Mock Supabase Client ────────────────────────────────────────────
interface MockCall {
  table: string;
  method: string;
  data?: any;
  filters?: Record<string, any>;
}

function createMockSupabase(accountBalance = "10000") {
  const calls: MockCall[] = [];

  const chainable = (table: string, method: string) => {
    const proxy: any = {
      eq: (col: string, val: any) => { calls[calls.length - 1].filters![col] = val; return proxy; },
      in: (col: string, val: any) => { calls[calls.length - 1].filters![`${col}_in`] = val; return proxy; },
      maybeSingle: () => {
        if (table === "paper_accounts" && method === "select") {
          return Promise.resolve({ data: { balance: accountBalance, peak_balance: accountBalance }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve: any) => resolve({ data: null, error: null }),
    };
    // Make it thenable for await
    proxy[Symbol.toStringTag] = "Promise";
    proxy.then = (resolve: any) => Promise.resolve({ data: null, error: null }).then(resolve);
    proxy.catch = (fn: any) => Promise.resolve({ data: null, error: null }).catch(fn);
    return proxy;
  };

  const supabase = {
    from: (table: string) => ({
      insert: (data: any) => {
        calls.push({ table, method: "insert", data, filters: {} });
        return chainable(table, "insert");
      },
      update: (data: any) => {
        calls.push({ table, method: "update", data, filters: {} });
        return chainable(table, "update");
      },
      select: (cols: string) => {
        calls.push({ table, method: "select", data: cols, filters: {} });
        return chainable(table, "select");
      },
    }),
  };

  return { supabase, calls };
}

// ─── Test Position Factory ───────────────────────────────────────────
function makePosition(overrides: Partial<any> = {}) {
  const exitFlags = {
    partialTPEnabled: true,
    partialTPPercent: 50,
    partialTPLevel: 1.0,
    partialTPActivated: false,
    trailingEnabled: false,
    breakEvenEnabled: false,
    breakEvenActivated: false,
    ...(overrides.exitFlags || {}),
  };
  const signalData = { exitFlags, ...(overrides.signalData || {}) };
  delete overrides.exitFlags;
  delete overrides.signalData;

  return {
    id: "row-1",
    position_id: "pos-001",
    user_id: "user-123",
    bot_id: "smc",
    symbol: "EUR/USD",
    direction: "long",
    size: "0.10",
    entry_price: "1.08000",
    current_price: "1.08200", // +20 pips = 2R if SL is 10 pips away
    stop_loss: "1.07900",     // 10 pips below entry
    take_profit: "1.08500",   // 50 pips above entry
    signal_reason: JSON.stringify(signalData),
    signal_score: 72,
    order_id: "order-abc",
    open_time: new Date(Date.now() - 3600_000).toISOString(),
    created_at: new Date(Date.now() - 3600_000).toISOString(),
    partial_tp_fired: false,
    ...overrides,
  };
}

// ─── Mock Dependencies ───────────────────────────────────────────────
const mockFetchCandles = async (_s: string, _i: string, _r: string) => [] as any[];
const mockDetectSession = (_c?: any) => ({ name: "london", isKillZone: true });

// ─── Minimal Config ──────────────────────────────────────────────────
const config = {
  partialTPEnabled: true,
  partialTPPercent: 50,
  partialTPLevel: 1.0,
  trailingStopEnabled: false,
  breakEvenEnabled: false,
  maxHoldEnabled: false,
  maxHoldHours: 0,
  structureInvalidationEnabled: false,
};

// ═══════════════════════════════════════════════════════════════════════
// TEST 1: Full partial-TP accounting executes correctly
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Partial TP: executes full accounting (history + size + balance) when rMultiple >= level", async () => {
  const { supabase, calls } = createMockSupabase("10000");
  const pos = makePosition();
  // rMultiple = (current - entry) / (entry - sl) = (1.082 - 1.08) / (1.08 - 1.079) = 0.002 / 0.001 = 2.0
  // 2.0 >= 1.0 (partialTPLevel) → should fire

  const actions = await manageOpenPositions(supabase as any, [pos], config, "test-001", mockFetchCandles, mockDetectSession);

  // Should produce "partial_tp_executed" action
  const partialAction = actions.find(a => a.action === "partial_tp_executed");
  assert(partialAction, "Expected partial_tp_executed action");
  assertEquals(partialAction!.symbol, "EUR/USD");
  assert(partialAction!.reason.includes("50%"), "Reason should mention 50%");

  // Should have inserted into paper_trade_history
  const historyInsert = calls.find(c => c.table === "paper_trade_history" && c.method === "insert");
  assert(historyInsert, "Expected paper_trade_history insert");
  assertEquals(historyInsert!.data.symbol, "EUR/USD");
  assertEquals(historyInsert!.data.direction, "long");
  assertEquals(historyInsert!.data.close_reason, "partial_tp");
  // Close size = 0.10 * 50% = 0.05
  assertEquals(historyInsert!.data.size, "0.05");
  assertEquals(historyInsert!.data.position_id, "pos-001_partial");

  // Should have updated paper_positions (size + partial_tp_fired)
  const posUpdate = calls.find(c => c.table === "paper_positions" && c.method === "update" && c.data.partial_tp_fired === true);
  assert(posUpdate, "Expected paper_positions update with partial_tp_fired");
  assertEquals(posUpdate!.data.size, "0.05"); // remaining 50%
  assertEquals(posUpdate!.data.partial_tp_fired, true);

  // Should have updated paper_accounts balance
  const acctUpdate = calls.find(c => c.table === "paper_accounts" && c.method === "update");
  assert(acctUpdate, "Expected paper_accounts balance update");
  // PnL: diff = 1.082 - 1.08 = 0.002, lotUnits = 100000, size = 0.05, quoteToUSD = 1.0
  // pnl = 0.002 * 100000 * 0.05 * 1.0 = $10.00
  // New balance = 10000 + 10 = 10010
  assertAlmostEquals(parseFloat(acctUpdate!.data.balance), 10010.00, 0.01);
});

// ═══════════════════════════════════════════════════════════════════════
// TEST 2: Skips when partialTPActivated is already true
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Partial TP: skips when partialTPActivated already true", async () => {
  const { supabase, calls } = createMockSupabase();
  const pos = makePosition({
    exitFlags: { partialTPActivated: true },
  });

  const actions = await manageOpenPositions(supabase as any, [pos], config, "test-002", mockFetchCandles, mockDetectSession);

  const partialAction = actions.find(a => a.action === "partial_tp_executed");
  assertEquals(partialAction, undefined, "Should NOT fire partial_tp_executed when already activated");

  const historyInsert = calls.find(c => c.table === "paper_trade_history" && c.method === "insert");
  assertEquals(historyInsert, undefined, "Should NOT insert history when already activated");
});

// ═══════════════════════════════════════════════════════════════════════
// TEST 3: Skips when partial_tp_fired column is true (DB-level guard)
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Partial TP: skips when partial_tp_fired column is true", async () => {
  const { supabase, calls } = createMockSupabase();
  const pos = makePosition({ partial_tp_fired: true });

  const actions = await manageOpenPositions(supabase as any, [pos], config, "test-003", mockFetchCandles, mockDetectSession);

  const partialAction = actions.find(a => a.action === "partial_tp_executed");
  assertEquals(partialAction, undefined, "Should NOT fire when partial_tp_fired is true");
});

// ═══════════════════════════════════════════════════════════════════════
// TEST 4: Does NOT fire when rMultiple is below partialTPLevel
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Partial TP: does not fire when rMultiple < partialTPLevel", async () => {
  const { supabase, calls } = createMockSupabase();
  // Entry 1.08000, SL 1.07900 (10 pips), current 1.08050 (5 pips profit = 0.5R)
  const pos = makePosition({ current_price: "1.08050" });

  const actions = await manageOpenPositions(supabase as any, [pos], config, "test-004", mockFetchCandles, mockDetectSession);

  const partialAction = actions.find(a => a.action === "partial_tp_executed");
  assertEquals(partialAction, undefined, "Should NOT fire at 0.5R when level is 1.0R");
});

// ═══════════════════════════════════════════════════════════════════════
// TEST 5: PnL calculation for short position (XAU/USD)
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Partial TP: correct PnL for short XAU/USD", async () => {
  const { supabase, calls } = createMockSupabase("50000");
  // XAU/USD short: entry 2400, SL 2410 (10 points), current 2380 (20 points profit = 2R)
  // lotUnits for XAU/USD = 100, pipSize = 0.01
  const pos = makePosition({
    symbol: "XAU/USD",
    direction: "short",
    size: "0.50",
    entry_price: "2400.00",
    current_price: "2380.00",
    stop_loss: "2410.00",
    take_profit: "2350.00",
  });

  const actions = await manageOpenPositions(supabase as any, [pos], config, "test-005", mockFetchCandles, mockDetectSession);

  const partialAction = actions.find(a => a.action === "partial_tp_executed");
  assert(partialAction, "Expected partial_tp_executed for XAU/USD short");

  // Close size = 0.50 * 50% = 0.25
  const historyInsert = calls.find(c => c.table === "paper_trade_history" && c.method === "insert");
  assert(historyInsert, "Expected history insert");
  assertEquals(historyInsert!.data.size, "0.25");

  // PnL: diff = 2400 - 2380 = 20, lotUnits = 100, size = 0.25, quoteToUSD = 1.0 (USD quote)
  // pnl = 20 * 100 * 0.25 * 1.0 = $500.00
  const acctUpdate = calls.find(c => c.table === "paper_accounts" && c.method === "update");
  assert(acctUpdate, "Expected balance update");
  assertAlmostEquals(parseFloat(acctUpdate!.data.balance), 50500.00, 0.01);
});

// ═══════════════════════════════════════════════════════════════════════
// TEST 6: No double signal_reason write after partial-TP (partialTPWritten guard)
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Partial TP: no duplicate signal_reason write after execution", async () => {
  const { supabase, calls } = createMockSupabase();
  const pos = makePosition();

  await manageOpenPositions(supabase as any, [pos], config, "test-006", mockFetchCandles, mockDetectSession);

  // Count signal_reason writes to paper_positions
  const posUpdates = calls.filter(c => c.table === "paper_positions" && c.method === "update");
  // Should be exactly 1 (the partial-TP write), not 2 (partial-TP + final exitFlags write)
  assertEquals(posUpdates.length, 1, "Should have exactly 1 paper_positions update (partial-TP), not a duplicate");
  assertEquals(posUpdates[0].data.partial_tp_fired, true, "The single update should be the partial-TP one");
});
