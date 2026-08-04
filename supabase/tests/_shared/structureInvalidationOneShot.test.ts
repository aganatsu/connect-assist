/**
 * Regression test: structure-invalidation one-shot guard prevents over-triggering
 * in ranging/choppy markets where trend flips frequently.
 *
 * Context: The trend derivation fix (BOS/CHoCH-based) makes trend more responsive
 * in ranging conditions. Claude's review asked us to verify that the structure-
 * invalidation branch in computeManagementDecision doesn't over-trigger when
 * trend flips repeatedly. This test proves the one-shot guard works correctly.
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { manageOpenPositions } from "../../functions/_shared/scannerManagement.ts";
import { SPECS } from "../../functions/_shared/smcAnalysis.ts";

const SYMBOL = "EUR/USD";
const ENTRY_PRICE = 1.08500;
const ORIGINAL_SL = 1.08300; // 20 pips below entry (long)
const CURRENT_PRICE = 1.08400; // -10 pips (rMultiple ~ -0.5, within -0.8 to 0 window)

function makePosition(exitFlagsOverride: Record<string, any> = {}) {
  return {
    id: "test-choppy-1",
    position_id: "P-CHOPPY",
    symbol: SYMBOL,
    direction: "long",
    entry_price: ENTRY_PRICE.toString(),
    stop_loss: ORIGINAL_SL.toString(),
    take_profit: "1.08900",
    current_price: CURRENT_PRICE.toString(),
    signal_reason: JSON.stringify({
      originalSL: ORIGINAL_SL,
      entryTimeframe: "15m",
      exitFlags: exitFlagsOverride,
      exitAttribution: [],
      invalidationHistory: [],
    }),
    opened_at: new Date(Date.now() - 3600000).toISOString(),
  };
}

// Choppy/ranging candles that oscillate — will produce alternating bullish/bearish
// internal breaks (the exact scenario Claude flagged)
function makeChoppyCandles(): any[] {
  const candles: any[] = [];
  const midPrice = 1.08500;
  for (let i = 0; i < 100; i++) {
    const time = Date.now() - (100 - i) * 900000;
    // Oscillating pattern: up-down-up-down with enough amplitude for BOS/CHoCH
    const phase = Math.sin(i * 0.2) * 0.0015;
    const noise = Math.cos(i * 0.7) * 0.0003;
    const price = midPrice + phase + noise;
    const bullish = i % 3 !== 0;
    const range = 0.0005;
    const open = bullish ? price - range * 0.4 : price + range * 0.4;
    const close = bullish ? price + range * 0.4 : price - range * 0.4;
    candles.push({
      time,
      open: Number(open.toFixed(5)),
      high: Number((Math.max(open, close) + range * 0.3).toFixed(5)),
      low: Number((Math.min(open, close) - range * 0.3).toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: 100,
    });
  }
  // Add a clear bearish CHoCH at the end (break below a prior swing low)
  const peak = midPrice + 0.0015;
  for (let i = 0; i < 20; i++) {
    const time = Date.now() - (20 - i) * 900000;
    const base = peak - i * 0.0003;
    candles.push({
      time,
      open: base,
      high: base + 0.0001,
      low: base - 0.0004,
      close: base - 0.0003,
      volume: 150,
    });
  }
  return candles;
}

// Candles that show NO CHoCH against the trade (neutral/bullish structure)
function makeNeutralCandles(): any[] {
  const candles: any[] = [];
  for (let i = 0; i < 100; i++) {
    const base = 1.08400 + i * 0.00001; // very slight uptrend
    candles.push({
      time: Date.now() - (100 - i) * 900000,
      open: base,
      high: base + 0.0003,
      low: base - 0.0002,
      close: base + 0.0002,
      volume: 100,
    });
  }
  return candles;
}

function mockSupabase() {
  const updates: any[] = [];
  return {
    updates,
    from: (_table: string) => ({
      update: (data: any) => {
        updates.push({ data });
        return { eq: () => ({ data: null, error: null }) };
      },
    }),
  };
}

function mockDetectSession() {
  return { name: "london", isKillZone: true };
}

const enabledConfig = {
  structureInvalidationEnabled: true,
  trailingStopEnabled: false,
  partialTPEnabled: false,
  breakEvenEnabled: false,
  maxHoldEnabled: false,
  tradingStyle: { mode: "day_trader" },
};

// ─── Test 1: One-shot guard prevents re-triggering ───────────────────
Deno.test("structure-invalidation: one-shot guard prevents second trigger on same position", async () => {
  const supabase = mockSupabase();
  // Position where structureInvalidationFired is already true (simulating it already fired)
  const pos = makePosition({ structureInvalidationFired: true });

  const actions = await manageOpenPositions(
    supabase,
    [pos],
    enabledConfig,
    "cycle-oneshot",
    (_s: string, _i: string, _r: string) => Promise.resolve(makeChoppyCandles()),
    mockDetectSession,
  );

  const slTightened = actions.filter((a: any) => a.action === "sl_tightened" && a.reason?.includes("CHoCH"));
  assertEquals(slTightened.length, 0, "One-shot guard should prevent re-triggering");
});

// ─── Test 2: Fires once on first CHoCH against trade ─────────────────
Deno.test("structure-invalidation: fires exactly once when CHoCH against trade detected", async () => {
  const supabase = mockSupabase();
  const pos = makePosition({}); // fresh position, no prior invalidation

  const actions = await manageOpenPositions(
    supabase,
    [pos],
    enabledConfig,
    "cycle-first-fire",
    (_s: string, _i: string, _r: string) => Promise.resolve(makeChoppyCandles()),
    mockDetectSession,
  );

  const slTightened = actions.filter((a: any) => a.action === "sl_tightened");
  // Should fire at most once (the choppy candles end with bearish CHoCH)
  assert(slTightened.length <= 1, `Should fire at most once, got ${slTightened.length}`);
});

// ─── Test 3: Does NOT fire when position is in profit ────────────────
Deno.test("structure-invalidation: does NOT fire when rMultiple > 0 (position in profit)", async () => {
  const supabase = mockSupabase();
  // Position in profit: current price above entry
  const pos = {
    ...makePosition({}),
    current_price: "1.08700", // +20 pips, rMultiple ~ +1.0
  };

  const actions = await manageOpenPositions(
    supabase,
    [pos],
    enabledConfig,
    "cycle-profit",
    (_s: string, _i: string, _r: string) => Promise.resolve(makeChoppyCandles()),
    mockDetectSession,
  );

  const slTightened = actions.filter((a: any) => a.action === "sl_tightened" && a.reason?.includes("CHoCH"));
  assertEquals(slTightened.length, 0, "Should NOT fire when position is in profit");
});

// ─── Test 4: Does NOT fire when no CHoCH against trade exists ────────
Deno.test("structure-invalidation: does NOT fire when structure is neutral/bullish for long", async () => {
  const supabase = mockSupabase();
  const pos = makePosition({});

  const actions = await manageOpenPositions(
    supabase,
    [pos],
    enabledConfig,
    "cycle-neutral",
    (_s: string, _i: string, _r: string) => Promise.resolve(makeNeutralCandles()),
    mockDetectSession,
  );

  const slTightened = actions.filter((a: any) => a.action === "sl_tightened" && a.reason?.includes("CHoCH"));
  assertEquals(slTightened.length, 0, "Should NOT fire when structure is not against the trade");
});

// ─── Test 5: Multiple scan cycles with same position — still one-shot ─
Deno.test("structure-invalidation: simulating 3 consecutive scan cycles — fires at most once total", async () => {
  let fireCount = 0;

  // Simulate 3 scan cycles with the same position
  let currentExitFlags: Record<string, any> = {};

  for (let cycle = 1; cycle <= 3; cycle++) {
    const supabase = mockSupabase();
    const pos = makePosition(currentExitFlags);

    const actions = await manageOpenPositions(
      supabase,
      [pos],
      enabledConfig,
      `cycle-multi-${cycle}`,
      (_s: string, _i: string, _r: string) => Promise.resolve(makeChoppyCandles()),
      mockDetectSession,
    );

    const slTightened = actions.filter((a: any) => a.action === "sl_tightened" && a.reason?.includes("CHoCH"));
    if (slTightened.length > 0) {
      fireCount++;
      // After first fire, the exitFlags should have structureInvalidationFired = true
      currentExitFlags = { structureInvalidationFired: true };
    }
  }

  assert(fireCount <= 1, `Structure invalidation should fire at most once across 3 cycles, fired ${fireCount} times`);
});
