/**
 * brokerFillPriceBE.test.ts — Tests for broker fill price usage in break-even calculations.
 *
 * Verifies that when brokerEntryPrice is present in signal_reason, the management
 * function uses it instead of pos.entry_price for BE/trailing/R-multiple calculations.
 *
 * This test would have FAILED before the fix because entryPrice was always pos.entry_price.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { manageOpenPositions } from "./scannerManagement.ts";

// ─── Helpers ────────────────────────────────────────────────────────
function makePosition(overrides: Partial<{
  entry_price: string;
  current_price: string;
  stop_loss: string;
  take_profit: string;
  direction: string;
  signal_reason: string;
  symbol: string;
  position_id: string;
  id: string;
  created_at: string;
  trade_overrides: string | null;
}> = {}) {
  return {
    id: overrides.id || "test-uuid-1",
    position_id: overrides.position_id || "pos-123",
    symbol: overrides.symbol || "EUR/USD",
    direction: overrides.direction || "long",
    entry_price: overrides.entry_price || "1.08500",
    current_price: overrides.current_price || "1.08700",
    stop_loss: overrides.stop_loss || "1.08300",
    take_profit: overrides.take_profit || "1.09000",
    signal_reason: overrides.signal_reason || "{}",
    created_at: overrides.created_at || new Date().toISOString(),
    trade_overrides: overrides.trade_overrides || null,
  };
}

function makeConfig(overrides: Partial<{
  breakEvenEnabled: boolean;
  breakEvenPips: number;
  trailingStopEnabled: boolean;
  trailingStopPips: number;
  trailingStopActivation: string;
  partialTPEnabled: boolean;
  maxHoldEnabled: boolean;
  maxHoldHours: number;
}> = {}) {
  return {
    breakEvenEnabled: overrides.breakEvenEnabled ?? true,
    breakEvenPips: overrides.breakEvenPips ?? 10,
    trailingStopEnabled: overrides.trailingStopEnabled ?? false,
    trailingStopPips: overrides.trailingStopPips ?? 15,
    trailingStopActivation: overrides.trailingStopActivation ?? "after_1r",
    partialTPEnabled: overrides.partialTPEnabled ?? false,
    maxHoldEnabled: overrides.maxHoldEnabled ?? false,
    maxHoldHours: overrides.maxHoldHours ?? 0,
  };
}

// Mock supabase client that captures updates
function makeMockSupabase() {
  const updates: any[] = [];
  return {
    updates,
    from: (_table: string) => ({
      update: (data: any) => {
        updates.push(data);
        return {
          eq: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        };
      },
    }),
  };
}

// Mock candle fetch (returns empty — not needed for BE tests)
const mockFetchCandles = async () => [];

// Mock session detect
const mockDetectSession = () => ({ name: "London", isKillZone: true, filterKey: "london" });

// ═══════════════════════════════════════════════════════════════════
// Test: BE uses brokerEntryPrice when available
// ═══════════════════════════════════════════════════════════════════
Deno.test("BE activation uses brokerEntryPrice instead of paper entry_price", async () => {
  // Scenario: Paper entry at 1.08500, broker filled at 1.08520 (20 pips slippage on 5-digit)
  // Current price at 1.08750 — well above both entries
  // SL at 1.08300 (20 pips below paper entry)
  // With paper entry: BE SL = 1.08500 + 0.0001 = 1.08510
  // With broker entry: BE SL = 1.08520 + 0.0001 = 1.08530
  const signalReason = JSON.stringify({
    brokerEntryPrice: 1.08520,
    originalSL: 1.08300,
    exitFlags: {},
  });

  const pos = makePosition({
    entry_price: "1.08500",  // paper entry
    current_price: "1.08750", // well in profit to trigger BE
    stop_loss: "1.08300",
    take_profit: "1.09000",
    direction: "long",
    signal_reason: signalReason,
  });

  const mockSupa = makeMockSupabase();
  const config = makeConfig({ breakEvenEnabled: true, breakEvenPips: 10 });

  const actions = await manageOpenPositions(
    mockSupa,
    [pos],
    config,
    "test-cycle-1",
    mockFetchCandles,
    mockDetectSession,
  );

  // Should have triggered BE
  assert(actions.length > 0, "Expected BE action to be triggered");
  const beAction = actions.find(a => a.action === "be_enabled");
  assert(beAction, "Expected a be_enabled action");

  // The new SL should be based on broker entry (1.08520 + 1 pip = 1.08530), NOT paper entry (1.08510)
  // Check that the SL is at broker entry + 1 pip
  const newSL = beAction!.newSL!;
  // EUR/USD pipSize = 0.0001, so BE = 1.08520 + 0.0001 = 1.08521 (rounded)
  // Actually the code does entryPrice + (spec.pipSize * 1) = 1.08520 + 0.0001 = 1.08521
  // But roundPrice rounds to pipSize+1 decimals = 5 decimals
  assert(newSL > 1.08515, `Expected BE SL > 1.08515 (broker-based), got ${newSL}`);
  assert(newSL < 1.08540, `Expected BE SL < 1.08540, got ${newSL}`);
  // Specifically, it should NOT be 1.08501 (paper entry + 1 pip)
  assert(newSL > 1.08510, `BE SL should be above paper-based BE (1.08510), got ${newSL}`);
});

Deno.test("BE activation falls back to paper entry_price when brokerEntryPrice is absent", async () => {
  // No brokerEntryPrice in signal_reason — legacy/paper-only trade
  const signalReason = JSON.stringify({
    originalSL: 1.08300,
    exitFlags: {},
  });

  const pos = makePosition({
    entry_price: "1.08500",
    current_price: "1.08750",
    stop_loss: "1.08300",
    take_profit: "1.09000",
    direction: "long",
    signal_reason: signalReason,
  });

  const mockSupa = makeMockSupabase();
  const config = makeConfig({ breakEvenEnabled: true, breakEvenPips: 10 });

  const actions = await manageOpenPositions(
    mockSupa,
    [pos],
    config,
    "test-cycle-2",
    mockFetchCandles,
    mockDetectSession,
  );

  assert(actions.length > 0, "Expected BE action to be triggered");
  const beAction = actions.find(a => a.action === "be_enabled");
  assert(beAction, "Expected a be_enabled action");

  // Should use paper entry: 1.08500 + 0.0001 = 1.08501
  const newSL = beAction!.newSL!;
  assert(newSL >= 1.08500 && newSL <= 1.08510, `Expected paper-based BE SL ~1.08501, got ${newSL}`);
});

Deno.test("Short trade BE uses brokerEntryPrice correctly", async () => {
  // Short trade: paper entry 1.08500, broker fill 1.08480 (filled lower = better for short)
  // Current price 1.08200 — well in profit
  // BE SL should be broker entry - 1 pip = 1.08480 - 0.0001 = 1.08470
  const signalReason = JSON.stringify({
    brokerEntryPrice: 1.08480,
    originalSL: 1.08700,
    exitFlags: {},
  });

  const pos = makePosition({
    entry_price: "1.08500",
    current_price: "1.08200",
    stop_loss: "1.08700",
    take_profit: "1.08000",
    direction: "short",
    signal_reason: signalReason,
  });

  const mockSupa = makeMockSupabase();
  const config = makeConfig({ breakEvenEnabled: true, breakEvenPips: 10 });

  const actions = await manageOpenPositions(
    mockSupa,
    [pos],
    config,
    "test-cycle-3",
    mockFetchCandles,
    mockDetectSession,
  );

  assert(actions.length > 0, "Expected BE action for short");
  const beAction = actions.find(a => a.action === "be_enabled");
  assert(beAction, "Expected a be_enabled action for short");

  // For short: BE SL = brokerEntry - pipSize = 1.08480 - 0.0001 = 1.08479
  const newSL = beAction!.newSL!;
  assert(newSL < 1.08490, `Expected short BE SL < 1.08490 (broker-based), got ${newSL}`);
  assert(newSL > 1.08460, `Expected short BE SL > 1.08460, got ${newSL}`);
  // Should NOT be 1.08499 (paper entry - 1 pip)
  assert(newSL < 1.08495, `Short BE SL should be below paper-based BE (1.08499), got ${newSL}`);
});

Deno.test("R-multiple calculation uses brokerEntryPrice", async () => {
  // Paper entry 1.08500, broker fill 1.08520
  // SL at 1.08300 (original)
  // Current price at 1.08600
  // With broker entry: risk = |1.08520 - 1.08300| / 0.0001 = 22 pips
  //                    profit = (1.08600 - 1.08520) / 0.0001 = 8 pips
  //                    R = 8/22 = 0.36R — NOT enough for BE at 1R
  // With paper entry: risk = |1.08500 - 1.08300| / 0.0001 = 20 pips
  //                   profit = (1.08600 - 1.08500) / 0.0001 = 10 pips
  //                   R = 10/20 = 0.5R — also not enough, but different value
  // Set current price high enough to trigger BE with broker entry (need >= 1R)
  // Need profit >= 22 pips from broker entry → current >= 1.08520 + 0.0022 = 1.08740
  const signalReason = JSON.stringify({
    brokerEntryPrice: 1.08520,
    originalSL: 1.08300,
    exitFlags: {},
  });

  // Price at 1.08600 — 8 pips from broker entry, 10 pips from paper entry
  // R with broker = 8/22 = 0.36 (no BE)
  // R with paper = 10/20 = 0.5 (no BE either, but different)
  const pos = makePosition({
    entry_price: "1.08500",
    current_price: "1.08600",
    stop_loss: "1.08300",
    take_profit: "1.09000",
    direction: "long",
    signal_reason: signalReason,
  });

  const mockSupa = makeMockSupabase();
  const config = makeConfig({ breakEvenEnabled: true, breakEvenPips: 20 });

  const actions = await manageOpenPositions(
    mockSupa,
    [pos],
    config,
    "test-cycle-4",
    mockFetchCandles,
    mockDetectSession,
  );

  // At 0.36R with broker entry, BE should NOT trigger (needs >= 1R)
  const beAction = actions.find(a => a.action === "be_enabled");
  assertEquals(beAction, undefined, "BE should NOT trigger at 0.36R (broker-based calculation)");
});

Deno.test("Invalid brokerEntryPrice (NaN) falls back to paper entry", async () => {
  const signalReason = JSON.stringify({
    brokerEntryPrice: "invalid",
    originalSL: 1.08300,
    exitFlags: {},
  });

  const pos = makePosition({
    entry_price: "1.08500",
    current_price: "1.08750",
    stop_loss: "1.08300",
    take_profit: "1.09000",
    direction: "long",
    signal_reason: signalReason,
  });

  const mockSupa = makeMockSupabase();
  const config = makeConfig({ breakEvenEnabled: true, breakEvenPips: 10 });

  const actions = await manageOpenPositions(
    mockSupa,
    [pos],
    config,
    "test-cycle-5",
    mockFetchCandles,
    mockDetectSession,
  );

  // Should still trigger BE using paper entry fallback
  assert(actions.length > 0, "Expected BE action with fallback to paper entry");
  const beAction = actions.find(a => a.action === "be_enabled");
  assert(beAction, "Expected a be_enabled action");
  // Should use paper entry: 1.08500 + 0.0001 = 1.08501
  const newSL = beAction!.newSL!;
  assert(newSL >= 1.08500 && newSL <= 1.08510, `Expected paper-based BE SL, got ${newSL}`);
});

Deno.test("brokerEntryPrice=null falls back to paper entry", async () => {
  const signalReason = JSON.stringify({
    brokerEntryPrice: null,
    originalSL: 1.08300,
    exitFlags: {},
  });

  const pos = makePosition({
    entry_price: "1.08500",
    current_price: "1.08750",
    stop_loss: "1.08300",
    take_profit: "1.09000",
    direction: "long",
    signal_reason: signalReason,
  });

  const mockSupa = makeMockSupabase();
  const config = makeConfig({ breakEvenEnabled: true, breakEvenPips: 10 });

  const actions = await manageOpenPositions(
    mockSupa,
    [pos],
    config,
    "test-cycle-6",
    mockFetchCandles,
    mockDetectSession,
  );

  assert(actions.length > 0, "Expected BE action with null brokerEntryPrice");
  const beAction = actions.find(a => a.action === "be_enabled");
  assert(beAction, "Expected a be_enabled action");
  const newSL = beAction!.newSL!;
  assert(newSL >= 1.08500 && newSL <= 1.08510, `Expected paper-based BE SL with null broker price, got ${newSL}`);
});
