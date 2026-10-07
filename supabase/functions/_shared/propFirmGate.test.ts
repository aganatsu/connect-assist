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

// ─── runPropFirmGate (step 13) ───────────────────────────────────────────────
// The gate's decisions are covered in supabase/tests/_shared/step13EquityRiskLimits.test.ts.
// These replace the pre-step-13 tests that asserted the old FAIL-OPEN behaviour
// (broker equity unavailable → allowed; equity sanity failure → allowed).

const PROFILE = {
  id: "test-config", user_id: "test-user", bot_id: "smc", is_active: true,
  initial_balance: 100_000, max_daily_loss_pct: 0.05, max_overall_loss_pct: 0.10,
  daily_entry_stop_pct: 0.03, daily_flatten_pct: 0.04,
  overall_entry_stop_equity: 92_000, overall_flatten_equity: 91_000,
  day_boundary_tz: "Europe/Prague", equity_source: "paper", close_on_breach: true,
};

function profileOnly(profile: any, error: any = null) {
  return {
    from: (table: string) => {
      if (table !== "prop_firm_config") throw new Error(`unexpected read of ${table}`);
      const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: profile, error }) };
      return b;
    },
  };
}
const ACCOUNT = { id: "acct", ledger_epoch_id: "ep", balance: 10_000 };

Deno.test("propFirmGate: broker equity source is not trusted yet → entries blocked, no liquidation", async () => {
  const result = await runPropFirmGate(profileOnly({ ...PROFILE, equity_source: "broker" }), "test-user", "smc", ACCOUNT, [], "scan-001", { rateMap: {} });
  assertEquals([result.enabled, result.allowed, result.shouldCloseAll], [true, false, false]);
  assert(result.reason.includes("equity_source 'broker'"));
});

Deno.test("propFirmGate: profile read error → entries blocked, no liquidation (was: allowed)", async () => {
  const result = await runPropFirmGate(profileOnly(null, { message: "boom" }), "test-user", "smc", ACCOUNT, [], "scan-002", { rateMap: {} });
  assertEquals([result.enabled, result.allowed, result.shouldCloseAll], [true, false, false]);
});

Deno.test("propFirmGate: an invalid profile (missing buffers) → entries blocked, no liquidation", async () => {
  const result = await runPropFirmGate(profileOnly({ ...PROFILE, daily_flatten_pct: null }), "test-user", "smc", ACCOUNT, [], "scan-003", { rateMap: {} });
  assertEquals([result.enabled, result.allowed, result.shouldCloseAll], [true, false, false]);
  assert(result.reason.includes("invalid risk profile"));
});

Deno.test("propFirmGate: no active profile → gate disabled", async () => {
  const result = await runPropFirmGate(profileOnly(null), "test-user", "smc", ACCOUNT, [], "scan-004", { rateMap: {} });
  assertEquals([result.enabled, result.allowed], [false, true]);
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
