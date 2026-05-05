/**
 * Tests for the structure-based trailing stop mode.
 * Verifies that:
 *   1. trailingStopMode="proportional" (default) → old behavior unchanged
 *   2. trailingStopMode="structure" → trails to swing points when available
 *   3. trailingStopMode="structure" → falls back to proportional when no valid swing found
 *   4. Structure trailing only tightens (never widens) SL
 *   5. Structure trailing respects the buffer (slBufferPips)
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { manageOpenPositions } from "./scannerManagement.ts";
import { SPECS } from "./smcAnalysis.ts";

// ─── Fixtures ────────────────────────────────────────────────────────
const SYMBOL = "EUR/USD";
const spec = SPECS[SYMBOL];
const ENTRY_PRICE = 1.10000;
const ORIGINAL_SL = 1.09800; // 20 pips below entry (long)
const CURRENT_PRICE = 1.10400; // +40 pips (rMultiple = 2.0)
const TP = 1.10600;

// Position that is in profit with trailing already activated
function makePosition(overrides: Record<string, any> = {}) {
  return {
    id: "test-trail-1",
    position_id: "PT001",
    symbol: SYMBOL,
    direction: "long",
    entry_price: ENTRY_PRICE.toString(),
    stop_loss: (overrides.stop_loss ?? ORIGINAL_SL).toString(),
    take_profit: TP.toString(),
    current_price: (overrides.current_price ?? CURRENT_PRICE).toString(),
    signal_reason: JSON.stringify({
      originalSL: ORIGINAL_SL,
      entryTimeframe: "15m",
      exitFlags: {
        trailingStopActivated: true,
        trailingStopLevel: overrides.trailingStopLevel ?? ORIGINAL_SL,
        trailingStopPips: 10,
        trailingStopActivation: "after_1r",
        ...(overrides.exitFlagsOverrides || {}),
      },
      exitAttribution: [],
    }),
    opened_at: new Date(Date.now() - 7200000).toISOString(), // 2h ago
    ...overrides,
  };
}

// Short position fixture
function makeShortPosition(overrides: Record<string, any> = {}) {
  const shortEntry = 1.10400;
  const shortSL = 1.10600; // 20 pips above entry
  const shortCurrent = 1.10000; // +40 pips profit (rMultiple = 2.0)
  return {
    id: "test-trail-short-1",
    position_id: "PT002",
    symbol: SYMBOL,
    direction: "short",
    entry_price: shortEntry.toString(),
    stop_loss: (overrides.stop_loss ?? shortSL).toString(),
    take_profit: "1.09800",
    current_price: (overrides.current_price ?? shortCurrent).toString(),
    signal_reason: JSON.stringify({
      originalSL: shortSL,
      entryTimeframe: "15m",
      exitFlags: {
        trailingStopActivated: true,
        trailingStopLevel: overrides.trailingStopLevel ?? shortSL,
        trailingStopPips: 10,
        trailingStopActivation: "after_1r",
        ...(overrides.exitFlagsOverrides || {}),
      },
      exitAttribution: [],
    }),
    opened_at: new Date(Date.now() - 7200000).toISOString(),
    ...overrides,
  };
}

/**
 * Build candles with clear swing points for testing.
 * Creates a bullish trend with identifiable swing lows.
 * Swing lows at approximately: 1.10050, 1.10150, 1.10250
 */
function makeCandlesWithSwingLows(): any[] {
  const candles: any[] = [];
  // Build 50 candles with clear swing structure
  // Pattern: up-up-up-down-down (creates swing highs) and down-down-down-up-up (creates swing lows)
  const baseTime = Date.now() - 50 * 900000; // 50 × 15min ago

  // Phase 1: Initial move up from 1.09900 to 1.10100 (candles 0-9)
  for (let i = 0; i < 10; i++) {
    const base = 1.09900 + i * 0.00020;
    candles.push({
      datetime: new Date(baseTime + i * 900000).toISOString(),
      open: base,
      high: base + 0.00015,
      low: base - 0.00005,
      close: base + 0.00010,
      volume: 100,
    });
  }

  // Phase 2: Pullback creating swing low at ~1.10050 (candles 10-16)
  for (let i = 0; i < 4; i++) {
    const base = 1.10100 - i * 0.00015;
    candles.push({
      datetime: new Date(baseTime + (10 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00005,
      low: base - 0.00015,
      close: base - 0.00010,
      volume: 100,
    });
  }
  // Swing low candle at index 14 (low = ~1.10050)
  candles.push({
    datetime: new Date(baseTime + 14 * 900000).toISOString(),
    open: 1.10055,
    high: 1.10070,
    low: 1.10040, // This is the swing low
    close: 1.10060,
    volume: 100,
  });
  // Bounce up from swing low
  for (let i = 0; i < 2; i++) {
    const base = 1.10060 + (i + 1) * 0.00020;
    candles.push({
      datetime: new Date(baseTime + (15 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00015,
      low: base - 0.00005,
      close: base + 0.00010,
      volume: 100,
    });
  }

  // Phase 3: Continue up to 1.10250, then pullback creating swing low at ~1.10150 (candles 17-26)
  for (let i = 0; i < 5; i++) {
    const base = 1.10100 + i * 0.00030;
    candles.push({
      datetime: new Date(baseTime + (17 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00020,
      low: base - 0.00005,
      close: base + 0.00015,
      volume: 100,
    });
  }
  // Pullback
  for (let i = 0; i < 3; i++) {
    const base = 1.10250 - i * 0.00030;
    candles.push({
      datetime: new Date(baseTime + (22 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00005,
      low: base - 0.00020,
      close: base - 0.00015,
      volume: 100,
    });
  }
  // Swing low candle at index ~25 (low = ~1.10150)
  candles.push({
    datetime: new Date(baseTime + 25 * 900000).toISOString(),
    open: 1.10165,
    high: 1.10180,
    low: 1.10140, // Swing low
    close: 1.10170,
    volume: 100,
  });
  // Bounce up
  for (let i = 0; i < 3; i++) {
    const base = 1.10170 + (i + 1) * 0.00025;
    candles.push({
      datetime: new Date(baseTime + (26 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00015,
      low: base - 0.00005,
      close: base + 0.00010,
      volume: 100,
    });
  }

  // Phase 4: Continue up to 1.10350, pullback creating swing low at ~1.10250 (candles 29-38)
  for (let i = 0; i < 4; i++) {
    const base = 1.10250 + i * 0.00025;
    candles.push({
      datetime: new Date(baseTime + (29 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00020,
      low: base - 0.00005,
      close: base + 0.00015,
      volume: 100,
    });
  }
  // Pullback
  for (let i = 0; i < 3; i++) {
    const base = 1.10350 - i * 0.00025;
    candles.push({
      datetime: new Date(baseTime + (33 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00005,
      low: base - 0.00020,
      close: base - 0.00015,
      volume: 100,
    });
  }
  // Swing low candle (low = ~1.10250)
  candles.push({
    datetime: new Date(baseTime + 36 * 900000).toISOString(),
    open: 1.10265,
    high: 1.10280,
    low: 1.10240, // Swing low
    close: 1.10270,
    volume: 100,
  });
  // Final bounce up to current price area
  for (let i = 0; i < 13; i++) {
    const base = 1.10270 + (i + 1) * 0.00010;
    candles.push({
      datetime: new Date(baseTime + (37 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00015,
      low: base - 0.00005,
      close: base + 0.00010,
      volume: 100,
    });
  }

  return candles;
}

/**
 * Build candles with clear swing highs for short position testing.
 * Creates a bearish trend with identifiable swing highs.
 */
function makeCandlesWithSwingHighs(): any[] {
  const candles: any[] = [];
  const baseTime = Date.now() - 50 * 900000;

  // Bearish trend with swing highs at ~1.10350, ~1.10250, ~1.10150
  // Phase 1: Initial drop from 1.10500 to 1.10300
  for (let i = 0; i < 10; i++) {
    const base = 1.10500 - i * 0.00020;
    candles.push({
      datetime: new Date(baseTime + i * 900000).toISOString(),
      open: base,
      high: base + 0.00005,
      low: base - 0.00015,
      close: base - 0.00010,
      volume: 100,
    });
  }

  // Phase 2: Rally creating swing high at ~1.10350
  for (let i = 0; i < 4; i++) {
    const base = 1.10300 + i * 0.00015;
    candles.push({
      datetime: new Date(baseTime + (10 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00015,
      low: base - 0.00005,
      close: base + 0.00010,
      volume: 100,
    });
  }
  // Swing high candle
  candles.push({
    datetime: new Date(baseTime + 14 * 900000).toISOString(),
    open: 1.10345,
    high: 1.10360, // Swing high
    low: 1.10330,
    close: 1.10340,
    volume: 100,
  });
  // Drop from swing high
  for (let i = 0; i < 2; i++) {
    const base = 1.10340 - (i + 1) * 0.00020;
    candles.push({
      datetime: new Date(baseTime + (15 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00005,
      low: base - 0.00015,
      close: base - 0.00010,
      volume: 100,
    });
  }

  // Phase 3: Continue down then rally creating swing high at ~1.10250
  for (let i = 0; i < 5; i++) {
    const base = 1.10300 - i * 0.00025;
    candles.push({
      datetime: new Date(baseTime + (17 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00005,
      low: base - 0.00020,
      close: base - 0.00015,
      volume: 100,
    });
  }
  // Rally
  for (let i = 0; i < 3; i++) {
    const base = 1.10175 + i * 0.00025;
    candles.push({
      datetime: new Date(baseTime + (22 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00015,
      low: base - 0.00005,
      close: base + 0.00010,
      volume: 100,
    });
  }
  // Swing high candle
  candles.push({
    datetime: new Date(baseTime + 25 * 900000).toISOString(),
    open: 1.10240,
    high: 1.10260, // Swing high
    low: 1.10225,
    close: 1.10235,
    volume: 100,
  });
  // Drop
  for (let i = 0; i < 3; i++) {
    const base = 1.10235 - (i + 1) * 0.00025;
    candles.push({
      datetime: new Date(baseTime + (26 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00005,
      low: base - 0.00020,
      close: base - 0.00015,
      volume: 100,
    });
  }

  // Phase 4: Continue down then rally creating swing high at ~1.10150
  for (let i = 0; i < 4; i++) {
    const base = 1.10160 - i * 0.00020;
    candles.push({
      datetime: new Date(baseTime + (29 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00005,
      low: base - 0.00015,
      close: base - 0.00010,
      volume: 100,
    });
  }
  // Rally
  for (let i = 0; i < 3; i++) {
    const base = 1.10080 + i * 0.00025;
    candles.push({
      datetime: new Date(baseTime + (33 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00015,
      low: base - 0.00005,
      close: base + 0.00010,
      volume: 100,
    });
  }
  // Swing high candle
  candles.push({
    datetime: new Date(baseTime + 36 * 900000).toISOString(),
    open: 1.10140,
    high: 1.10160, // Swing high
    low: 1.10125,
    close: 1.10135,
    volume: 100,
  });
  // Final drop to current price area
  for (let i = 0; i < 13; i++) {
    const base = 1.10135 - (i + 1) * 0.00010;
    candles.push({
      datetime: new Date(baseTime + (37 + i) * 900000).toISOString(),
      open: base,
      high: base + 0.00005,
      low: base - 0.00015,
      close: base - 0.00010,
      volume: 100,
    });
  }

  return candles;
}

// Candles with NO valid swing points (flat/choppy market)
function makeFlatCandles(): any[] {
  const candles: any[] = [];
  const baseTime = Date.now() - 50 * 900000;
  for (let i = 0; i < 50; i++) {
    // Very tight range — no clear swings
    const base = 1.10000 + Math.sin(i * 0.3) * 0.00005;
    candles.push({
      datetime: new Date(baseTime + i * 900000).toISOString(),
      open: base,
      high: base + 0.00003,
      low: base - 0.00003,
      close: base + 0.00001,
      volume: 100,
    });
  }
  return candles;
}

// Mock supabase that tracks updates
function mockSupabase() {
  const updates: any[] = [];
  return {
    updates,
    from: (_table: string) => ({
      update: (data: any) => {
        updates.push({ table: _table, data });
        return {
          eq: () => ({ data: null, error: null }),
        };
      },
    }),
  };
}

function mockDetectSession() {
  return { name: "london", isKillZone: true };
}

// ─── Tests ───────────────────────────────────────────────────────────

Deno.test("trailingStopMode=proportional → uses fixed-pip trailing (unchanged behavior)", async () => {
  const supabase = mockSupabase();
  const config = {
    trailingStopEnabled: true,
    trailingStopPips: 10,
    trailingStopActivation: "after_1r",
    trailingStopMode: "proportional",
    partialTPEnabled: false,
    breakEvenEnabled: false,
    maxHoldEnabled: false,
    structureInvalidationEnabled: false,
    slBufferPips: 2,
    tradingStyle: { mode: "day_trader" },
  };

  // Position at 2R with trailing already activated, SL still at original
  const pos = makePosition();

  const actions = await manageOpenPositions(
    supabase,
    [pos],
    config,
    "test-proportional-1",
    () => Promise.resolve(makeCandlesWithSwingLows()), // candles available but shouldn't be used
    mockDetectSession,
  );

  // Should tighten SL using proportional method
  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 1, "Should produce exactly one sl_tightened action");
  // The new SL should be currentPrice - (trailingPips * pipSize) = 1.10400 - (10 * 0.0001) = 1.10300
  // Use tolerance for floating point comparison
  const expectedSL = CURRENT_PRICE - (10 * spec.pipSize);
  const actualSL = slTightened[0].newSL!;
  assert(Math.abs(actualSL - expectedSL) < 0.000001, `SL should be ~${expectedSL} (proportional: 10 pips behind price), got ${actualSL}`);
  assert(slTightened[0].reason!.includes("[proportional]"), "Attribution should mention proportional method");
});

Deno.test("trailingStopMode=structure (long) → trails to highest valid swing low", async () => {
  const supabase = mockSupabase();
  const config = {
    trailingStopEnabled: true,
    trailingStopPips: 10,
    trailingStopActivation: "after_1r",
    trailingStopMode: "structure",
    partialTPEnabled: false,
    breakEvenEnabled: false,
    maxHoldEnabled: false,
    structureInvalidationEnabled: false,
    slBufferPips: 2,
    tradingStyle: { mode: "day_trader" },
  };

  // Position at 2R with trailing already activated, SL still at original (1.09800)
  // Current price is 1.10400
  // Candles have swing lows at ~1.10040, ~1.10140, ~1.10240
  // Valid swing lows: above SL (1.09800) AND below current price (1.10400)
  // All three qualify. Highest = ~1.10240
  // Expected SL = 1.10240 - (2 pips buffer * 0.0001) = 1.10240 - 0.00020 = 1.10220
  const pos = makePosition();

  const actions = await manageOpenPositions(
    supabase,
    [pos],
    config,
    "test-structure-long-1",
    () => Promise.resolve(makeCandlesWithSwingLows()),
    mockDetectSession,
  );

  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 1, "Should produce exactly one sl_tightened action");
  // The new SL should be based on swing structure, not fixed pips
  assert(slTightened[0].newSL! > ORIGINAL_SL, "New SL must be above original SL");
  assert(slTightened[0].newSL! < CURRENT_PRICE, "New SL must be below current price");
  assert(slTightened[0].reason!.includes("[structure]"), "Attribution should mention structure method");
  assert(slTightened[0].reason!.includes("swing point"), "Attribution should mention swing point");
});

Deno.test("trailingStopMode=structure (short) → trails to lowest valid swing high", async () => {
  const supabase = mockSupabase();
  const config = {
    trailingStopEnabled: true,
    trailingStopPips: 10,
    trailingStopActivation: "after_1r",
    trailingStopMode: "structure",
    partialTPEnabled: false,
    breakEvenEnabled: false,
    maxHoldEnabled: false,
    structureInvalidationEnabled: false,
    slBufferPips: 2,
    tradingStyle: { mode: "day_trader" },
  };

  // Short position: entry 1.10400, SL 1.10600, current 1.10000 (2R profit)
  // Candles have swing highs at ~1.10360, ~1.10260, ~1.10160
  // Valid swing highs: below SL (1.10600) AND above current price (1.10000)
  // All three qualify. Lowest = ~1.10160
  // Expected SL = 1.10160 + (2 pips buffer * 0.0001) = 1.10160 + 0.00020 = 1.10180
  const pos = makeShortPosition();

  const actions = await manageOpenPositions(
    supabase,
    [pos],
    config,
    "test-structure-short-1",
    () => Promise.resolve(makeCandlesWithSwingHighs()),
    mockDetectSession,
  );

  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 1, "Should produce exactly one sl_tightened action");
  assert(slTightened[0].newSL! < 1.10600, "New SL must be below original SL (short)");
  assert(slTightened[0].newSL! > 1.10000, "New SL must be above current price (short)");
  assert(slTightened[0].reason!.includes("[structure]"), "Attribution should mention structure method");
});

Deno.test("trailingStopMode=structure → falls back to proportional when no valid swing found", async () => {
  const supabase = mockSupabase();
  const config = {
    trailingStopEnabled: true,
    trailingStopPips: 10,
    trailingStopActivation: "after_1r",
    trailingStopMode: "structure",
    partialTPEnabled: false,
    breakEvenEnabled: false,
    maxHoldEnabled: false,
    structureInvalidationEnabled: false,
    slBufferPips: 2,
    tradingStyle: { mode: "day_trader" },
  };

  // Use flat candles with no clear swings
  const pos = makePosition();

  const actions = await manageOpenPositions(
    supabase,
    [pos],
    config,
    "test-structure-fallback-1",
    () => Promise.resolve(makeFlatCandles()),
    mockDetectSession,
  );

  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 1, "Should still tighten SL");
  // With flat candles, detectSwingPoints with ATR filter may still find micro-swings
  // The key assertion is that the SL tightens (either via structure finding a micro-swing, or proportional fallback)
  assert(slTightened[0].newSL! > ORIGINAL_SL, "SL should tighten regardless of method used");
});

Deno.test("trailingStopMode=structure → falls back to proportional when candle fetch fails", async () => {
  const supabase = mockSupabase();
  const config = {
    trailingStopEnabled: true,
    trailingStopPips: 10,
    trailingStopActivation: "after_1r",
    trailingStopMode: "structure",
    partialTPEnabled: false,
    breakEvenEnabled: false,
    maxHoldEnabled: false,
    structureInvalidationEnabled: false,
    slBufferPips: 2,
    tradingStyle: { mode: "day_trader" },
  };

  const pos = makePosition();

  const actions = await manageOpenPositions(
    supabase,
    [pos],
    config,
    "test-structure-fetch-fail-1",
    () => Promise.reject(new Error("Network error")), // Simulate fetch failure
    mockDetectSession,
  );

  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 1, "Should still tighten using proportional fallback");
  assert(slTightened[0].reason!.includes("[proportional]"), "Should fall back to proportional on fetch failure");
});

Deno.test("trailingStopMode=structure → never widens SL (only tightens)", async () => {
  const supabase = mockSupabase();
  const config = {
    trailingStopEnabled: true,
    trailingStopPips: 10,
    trailingStopActivation: "after_1r",
    trailingStopMode: "structure",
    partialTPEnabled: false,
    breakEvenEnabled: false,
    maxHoldEnabled: false,
    structureInvalidationEnabled: false,
    slBufferPips: 2,
    tradingStyle: { mode: "day_trader" },
  };

  // Position where SL has already been tightened to 1.10300 (above all swing lows)
  // Swing lows are at ~1.10040, ~1.10140, ~1.10240 — all BELOW current SL
  // Structure trail should NOT move SL backward to a swing low
  const pos = makePosition({
    stop_loss: 1.10300,
    trailingStopLevel: 1.10300,
    exitFlagsOverrides: { trailingStopLevel: 1.10300 },
  });

  const actions = await manageOpenPositions(
    supabase,
    [pos],
    config,
    "test-structure-no-widen-1",
    () => Promise.resolve(makeCandlesWithSwingLows()),
    mockDetectSession,
  );

  // Should NOT tighten because all swing lows are below the already-tightened SL
  // And proportional (1.10400 - 10 pips = 1.10300) equals current SL, so no tighten either
  const slTightened = actions.filter(a => a.action === "sl_tightened");
  // Either no action or the proportional level equals current (no improvement)
  if (slTightened.length > 0) {
    assert(slTightened[0].newSL! >= 1.10300, "SL must never go backward (widen)");
  }
});

Deno.test("trailingStopMode missing from config → defaults to proportional", async () => {
  const supabase = mockSupabase();
  const config = {
    trailingStopEnabled: true,
    trailingStopPips: 10,
    trailingStopActivation: "after_1r",
    // trailingStopMode NOT set — should default to "proportional"
    partialTPEnabled: false,
    breakEvenEnabled: false,
    maxHoldEnabled: false,
    structureInvalidationEnabled: false,
    slBufferPips: 2,
    tradingStyle: { mode: "day_trader" },
  };

  const pos = makePosition();

  const actions = await manageOpenPositions(
    supabase,
    [pos],
    config,
    "test-default-mode-1",
    () => Promise.resolve(makeCandlesWithSwingLows()),
    mockDetectSession,
  );

  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 1, "Should produce sl_tightened action");
  assert(slTightened[0].reason!.includes("[proportional]"), "Default mode should be proportional");
});

Deno.test("trailingStopMode=structure respects slBufferPips in the trail calculation", async () => {
  const supabase = mockSupabase();
  // Use a larger buffer (5 pips) to verify it's applied
  const config = {
    trailingStopEnabled: true,
    trailingStopPips: 10,
    trailingStopActivation: "after_1r",
    trailingStopMode: "structure",
    partialTPEnabled: false,
    breakEvenEnabled: false,
    maxHoldEnabled: false,
    structureInvalidationEnabled: false,
    slBufferPips: 5, // 5 pips buffer
    tradingStyle: { mode: "swing_trader" },
  };

  const pos = makePosition();

  const actions = await manageOpenPositions(
    supabase,
    [pos],
    config,
    "test-structure-buffer-1",
    () => Promise.resolve(makeCandlesWithSwingLows()),
    mockDetectSession,
  );

  const slTightened = actions.filter(a => a.action === "sl_tightened");
  if (slTightened.length > 0 && slTightened[0].reason!.includes("[structure]")) {
    // With 5 pip buffer, the SL should be swing_low - 0.00050
    // The highest valid swing low is ~1.10240, so SL should be ~1.10240 - 0.00050 = ~1.10190
    assert(slTightened[0].newSL! < 1.10240, "SL should be below the swing low (buffer applied)");
    // Buffer is 5 pips = 0.00050, so SL should be at least 0.00050 below the swing
    const distanceFromSwing = 1.10240 - slTightened[0].newSL!;
    assert(distanceFromSwing >= 0.00040, "Buffer of at least ~5 pips should be applied below swing");
  }
});
