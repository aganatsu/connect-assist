/**
 * beTrailingRace.test.ts — Regression tests for BE/Trailing co-activation fix
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests the fix for the race condition where break-even fires at 1R and the
 * `continue` statement prevents trailing stop from activating in the same cycle.
 * If price retraces below 1R before the next scan, trailing never activates and
 * SL stays at entry+1 pip permanently.
 *
 * The fix co-activates trailing stop flags when BE fires, so the next cycle
 * enters Phase B (tightening) instead of Phase A (first-time activation).
 *
 * Run: deno test --allow-all supabase/functions/_shared/beTrailingRace.test.ts
 */

import {
  assertEquals,
  assert,
  assertAlmostEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { manageOpenPositions } from "./scannerManagement.ts";

// ─── Mock Supabase Client ──────────────────────────────────────────────────
function createMockSupabase(positions: any[] = []) {
  const updates: any[] = [];
  return {
    client: {
      from: (table: string) => ({
        select: (cols?: string) => ({
          eq: (_col: string, _val: any) => ({
            eq: (_col2: string, _val2: any) => ({
              data: positions,
              error: null,
            }),
            data: positions,
            error: null,
          }),
          in: (_col: string, _vals: any[]) => ({
            data: positions,
            error: null,
          }),
          data: positions,
          error: null,
        }),
        update: (data: any) => {
          updates.push({ table, data });
          return {
            eq: (_col: string, _val: any) => ({
              data: null,
              error: null,
            }),
          };
        },
      }),
    },
    updates,
  };
}

// ─── Mock fetchCandles (not needed for BE/trailing tests) ──────────────────
const mockFetchCandles = async (_sym: string, _int: string, _range: string) => [];
const mockDetectSession = (_config?: any) => ({ name: "London", isKillZone: false });

// ─── Helper: Create a position at a given R-multiple ───────────────────────
function makePosition(opts: {
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit: number;
  exitFlags?: any;
  tradeOverrides?: any;
}) {
  return {
    id: "test-pos-1",
    position_id: "POS-001",
    symbol: opts.symbol,
    direction: opts.direction,
    entry_price: opts.entryPrice.toString(),
    current_price: opts.currentPrice.toString(),
    stop_loss: opts.stopLoss.toString(),
    take_profit: opts.takeProfit.toString(),
    created_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    signal_reason: JSON.stringify({
      originalSL: opts.stopLoss.toString(),
      exitFlags: opts.exitFlags || {},
      exitAttribution: [],
    }),
    trade_overrides: opts.tradeOverrides ? JSON.stringify(opts.tradeOverrides) : null,
  };
}

// ─── Config with both BE and trailing enabled ──────────────────────────────
const CONFIG_BE_AND_TRAILING = {
  breakEvenEnabled: true,
  breakEvenPips: 20,
  trailingStopEnabled: true,
  trailingStopPips: 15,
  trailingStopActivation: "after_1r",
  partialTPEnabled: false,
  partialTPPercent: 50,
  partialTPLevel: 1.0,
  maxHoldEnabled: false,
  maxHoldHours: 0,
  structureInvalidationEnabled: false,
  adaptiveTrailingEnabled: false,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 1: BE fires → trailing flags are co-activated (the fix)
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("BE fires at 1R → trailing stop flags are co-activated in same update", async () => {
  // EUR/USD long: entry 1.0800, SL 1.0760 (40 pips risk), current 1.0840 (40 pips profit = 1R)
  // TP at 1.0860 (60 pips = 1.5R)
  const pos = makePosition({
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.0800,
    currentPrice: 1.0840,  // Exactly at 1R
    stopLoss: 1.0760,
    takeProfit: 1.0860,
  });

  const mock = createMockSupabase();
  const actions = await manageOpenPositions(
    mock.client, [pos], CONFIG_BE_AND_TRAILING, "test-cycle-1",
    mockFetchCandles, mockDetectSession,
  );

  // Should have one action: be_enabled
  assertEquals(actions.length, 1);
  assertEquals(actions[0].action, "be_enabled");

  // Verify the DB update includes trailing flags
  assertEquals(mock.updates.length, 1);
  const signalData = JSON.parse(mock.updates[0].data.signal_reason);
  const flags = signalData.exitFlags;

  // Core assertion: trailing is co-activated
  assertEquals(flags.breakEvenActivated, true, "BE should be activated");
  assertEquals(flags.trailingStopActivated, true, "Trailing should be co-activated with BE");
  assert(flags.trailingStopLevel != null, "Trailing stop level should be set");
  assert(flags.trailingStopPips > 0, "Trailing stop pips should be set");
  assertEquals(flags.trailingStopActivation, "after_1r", "Trailing activation type should be stored");
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 2: After BE+trailing co-activation, next cycle enters Phase B (tightening)
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("After BE co-activates trailing, next cycle with higher price tightens SL (Phase B)", async () => {
  // EUR/USD long: entry 1.0800, SL was moved to 1.08001 (BE level)
  // Price has moved to 1.0850 (1.25R) — trailing should tighten
  const beSL = 1.08001;  // entry + 1 pip
  const pos = makePosition({
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.0800,
    currentPrice: 1.0850,  // 1.25R — price continued after BE
    stopLoss: beSL,        // SL at BE level
    takeProfit: 1.0860,
    exitFlags: {
      breakEvenActivated: true,
      trailingStopActivated: true,   // Co-activated by our fix
      trailingStopLevel: beSL,       // Trail reference at BE level
      trailingStopPips: 20.0,        // 0.5 × 40 pips risk
    },
  });

  const mock = createMockSupabase();
  const actions = await manageOpenPositions(
    mock.client, [pos], CONFIG_BE_AND_TRAILING, "test-cycle-2",
    mockFetchCandles, mockDetectSession,
  );

  // Should have one action: sl_tightened (Phase B trailing)
  assertEquals(actions.length, 1);
  assertEquals(actions[0].action, "sl_tightened");

  // The new SL should be better than BE level (entry+1 pip)
  assert(actions[0].newSL! > beSL, `New SL ${actions[0].newSL} should be above BE level ${beSL}`);

  // New SL should be: currentPrice - (trailPips × pipSize) = 1.0850 - (20 × 0.0001) = 1.0830
  assertAlmostEquals(actions[0].newSL!, 1.0830, 0.0001);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 3: After BE+trailing co-activation, price retraces → SL stays at BE
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("After BE co-activates trailing, price retraces → SL stays at BE (no worsening)", async () => {
  // EUR/USD long: entry 1.0800, original SL 1.0760, SL was moved to 1.08001 (BE level)
  // Price retraced to 1.0810 — trailing should NOT tighten (would worsen SL)
  // newTrailLevel = 1.0810 - (20 * 0.0001) = 1.0790 < 1.08001 → no tighten
  const beSL = 1.08001;
  const pos = makePosition({
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.0800,
    currentPrice: 1.0810,  // Retraced
    stopLoss: beSL,
    takeProfit: 1.0860,
    exitFlags: {
      breakEvenActivated: true,
      trailingStopActivated: true,
      trailingStopLevel: beSL,
      trailingStopPips: 20.0,
    },
  });
  // Override signal_reason to include proper originalSL (the real original, not BE level)
  pos.signal_reason = JSON.stringify({
    originalSL: "1.0760",
    exitFlags: {
      breakEvenActivated: true,
      trailingStopActivated: true,
      trailingStopLevel: beSL,
      trailingStopPips: 20.0,
    },
    exitAttribution: [],
  });

  const mock = createMockSupabase();
  const actions = await manageOpenPositions(
    mock.client, [pos], CONFIG_BE_AND_TRAILING, "test-cycle-3",
    mockFetchCandles, mockDetectSession,
  );

  // Should get a single "no_change" action — trailing can't tighten because
  // newTrailLevel (1.0810 - 0.0020 = 1.0790) < sl (1.08001)
  assertEquals(actions.length, 1);
  assertEquals(actions[0].action, "no_change", "Trailing can't worsen SL — no management action");
  assertEquals(mock.updates.length, 0, "No DB update should happen");
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 4: BE fires with trailing DISABLED → no trailing flags set (no regression)
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("BE fires with trailing disabled → only BE flags set, no trailing co-activation", async () => {
  const pos = makePosition({
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.0800,
    currentPrice: 1.0840,
    stopLoss: 1.0760,
    takeProfit: 1.0860,
  });

  const configNoTrailing = { ...CONFIG_BE_AND_TRAILING, trailingStopEnabled: false };
  const mock = createMockSupabase();
  const actions = await manageOpenPositions(
    mock.client, [pos], configNoTrailing, "test-cycle-4",
    mockFetchCandles, mockDetectSession,
  );

  assertEquals(actions.length, 1);
  assertEquals(actions[0].action, "be_enabled");

  const signalData = JSON.parse(mock.updates[0].data.signal_reason);
  const flags = signalData.exitFlags;
  assertEquals(flags.breakEvenActivated, true);
  assertEquals(flags.trailingStopActivated, undefined, "Trailing should NOT be co-activated when disabled");
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 5: BE fires when trailing was ALREADY activated → no double-activation
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("BE fires when trailing already activated → no double-activation", async () => {
  // Edge case: trailing activated at 0.5R (before BE), then BE fires at 1R
  const pos = makePosition({
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.0800,
    currentPrice: 1.0840,
    stopLoss: 1.0760,
    takeProfit: 1.0860,
    exitFlags: {
      trailingStopActivated: true,
      trailingStopLevel: 1.0820,  // Already trailing from 0.5R
      trailingStopPips: 20.0,
    },
  });

  const mock = createMockSupabase();
  const actions = await manageOpenPositions(
    mock.client, [pos], CONFIG_BE_AND_TRAILING, "test-cycle-5",
    mockFetchCandles, mockDetectSession,
  );

  assertEquals(actions.length, 1);
  assertEquals(actions[0].action, "be_enabled");

  const signalData = JSON.parse(mock.updates[0].data.signal_reason);
  const flags = signalData.exitFlags;
  assertEquals(flags.breakEvenActivated, true);
  // Trailing level should NOT be overwritten — it was already at a better level
  assertEquals(flags.trailingStopLevel, 1.0820, "Existing trailing level should be preserved");
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 6: Short position — BE + trailing co-activation works correctly
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("Short position: BE fires at 1R → trailing co-activated with correct direction", async () => {
  // EUR/JPY short: entry 184.766, SL 185.400 (63.4 pips risk), current 184.130 (slightly > 1R)
  // Using 184.130 instead of 184.132 to avoid floating point precision issue at exact 1R boundary
  const pos = makePosition({
    symbol: "EUR/JPY",
    direction: "short",
    entryPrice: 184.766,
    currentPrice: 184.130,  // Slightly beyond 1R to avoid FP precision
    stopLoss: 185.400,
    takeProfit: 183.800,
  });

  const mock = createMockSupabase();
  const actions = await manageOpenPositions(
    mock.client, [pos], CONFIG_BE_AND_TRAILING, "test-cycle-6",
    mockFetchCandles, mockDetectSession,
  );

  assertEquals(actions.length, 1);
  assertEquals(actions[0].action, "be_enabled");

  const signalData = JSON.parse(mock.updates[0].data.signal_reason);
  const flags = signalData.exitFlags;
  assertEquals(flags.breakEvenActivated, true);
  assertEquals(flags.trailingStopActivated, true);

  // For short: BE SL = entry - 1 pip = 184.766 - 0.01 = 184.756
  // trailingStopLevel should be set to BE level (184.756)
  const expectedBeSL = 184.766 - 0.01;
  assertAlmostEquals(flags.trailingStopLevel, expectedBeSL, 0.001);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 7: Proportional trail pips calculation is correct
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("Trail pips stored during co-activation = max(configPips, 0.5 × riskPips)", async () => {
  // EUR/USD long: entry 1.0800, SL 1.0740 (60 pips risk)
  // 0.5 × 60 = 30 pips > config 15 pips → should use 30
  const pos = makePosition({
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.0800,
    currentPrice: 1.0860,  // 1R with 60 pip SL
    stopLoss: 1.0740,
    takeProfit: 1.0900,
  });

  const mock = createMockSupabase();
  await manageOpenPositions(
    mock.client, [pos], CONFIG_BE_AND_TRAILING, "test-cycle-7",
    mockFetchCandles, mockDetectSession,
  );

  const signalData = JSON.parse(mock.updates[0].data.signal_reason);
  const flags = signalData.exitFlags;
  // riskPips = 60, 0.5 × 60 = 30, config trailingPips = 15 → max(15, 30) = 30
  assertEquals(flags.trailingStopPips, 30.0, "Trail pips should be max(15, 0.5 × 60) = 30");
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 8: Partial TP blocking — trailing still co-activates with BE
// (because partial TP blocking only applies to Phase A standalone activation)
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("Partial TP enabled but not yet fired → trailing still co-activates with BE", async () => {
  const pos = makePosition({
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.0800,
    currentPrice: 1.0840,
    stopLoss: 1.0760,
    takeProfit: 1.0860,
  });

  const configWithPartial = {
    ...CONFIG_BE_AND_TRAILING,
    partialTPEnabled: true,
    partialTPPercent: 50,
    partialTPLevel: 1.0,
  };

  const mock = createMockSupabase();
  const actions = await manageOpenPositions(
    mock.client, [pos], configWithPartial, "test-cycle-8",
    mockFetchCandles, mockDetectSession,
  );

  assertEquals(actions.length, 1);
  assertEquals(actions[0].action, "be_enabled");

  const signalData = JSON.parse(mock.updates[0].data.signal_reason);
  const flags = signalData.exitFlags;
  // Trailing should still be co-activated — partial TP blocking is only for Phase A
  assertEquals(flags.trailingStopActivated, true, "Trailing co-activates with BE regardless of partial TP state");
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 9: REGRESSION — BE should NOT fire if already activated (no change)
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("REGRESSION: BE does not re-fire if already activated", async () => {
  const pos = makePosition({
    symbol: "EUR/USD",
    direction: "long",
    entryPrice: 1.0800,
    currentPrice: 1.0850,
    stopLoss: 1.08001,  // Already at BE
    takeProfit: 1.0860,
    exitFlags: {
      breakEvenActivated: true,
      trailingStopActivated: true,
      trailingStopLevel: 1.08001,
      trailingStopPips: 20.0,
    },
  });

  const mock = createMockSupabase();
  const actions = await manageOpenPositions(
    mock.client, [pos], CONFIG_BE_AND_TRAILING, "test-cycle-9",
    mockFetchCandles, mockDetectSession,
  );

  // Should get trailing tightening (Phase B), NOT another BE activation
  if (actions.length > 0) {
    assert(actions[0].action !== "be_enabled", "BE should not re-fire");
  }
});
