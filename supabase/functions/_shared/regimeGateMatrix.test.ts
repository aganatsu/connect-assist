/**
 * regimeGateMatrix.test.ts — 4-cell adversarial test for the regime gate
 * ═══════════════════════════════════════════════════════════════════════
 * Tests the regime gate in structure-invalidation with all four combinations:
 *
 *   | Regime       | trendBasis | Expected behavior              |
 *   |--------------|------------|--------------------------------|
 *   | trending     | internal   | FIRES (trending overrides)     |
 *   | trending     | external   | FIRES (strongest signal)       |
 *   | ranging      | external   | FIRES (major structural shift) |
 *   | ranging      | internal   | SUPPRESSED (noise in chop)     |
 *
 * A gate bug that accidentally suppresses trending-regime invalidations
 * or external-break invalidations would be caught by cells 1-3.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { manageOpenPositions } from "./scannerManagement.ts";
import { SPECS } from "./smcAnalysis.ts";

const SYMBOL = "EUR/USD";
const ENTRY_PRICE = 1.08500;
const ORIGINAL_SL = 1.08300; // 20 pips below entry (long)
const CURRENT_PRICE = 1.08400; // -10 pips (rMultiple ~ -0.5)

function makePosition(regimeOverride: string) {
  return {
    id: "test-regime-gate",
    position_id: "P-REGIME",
    symbol: SYMBOL,
    direction: "long",
    entry_price: ENTRY_PRICE.toString(),
    stop_loss: ORIGINAL_SL.toString(),
    take_profit: "1.08900",
    current_price: CURRENT_PRICE.toString(),
    signal_reason: JSON.stringify({
      originalSL: ORIGINAL_SL,
      entryTimeframe: "15m",
      exitFlags: {},
      exitAttribution: [],
      invalidationHistory: [],
      regimeInfo: { regime: regimeOverride, confidence: 0.8, atrTrend: "neutral", bias: "neutral" },
    }),
    opened_at: new Date(Date.now() - 3600000).toISOString(),
  };
}

/**
 * Candles producing trendBasis="external" + bearish CHoCH with external significance.
 * Clear uptrend with wide swings (lookback=7 detectable), then major reversal.
 */
function makeExternalBearishCandles(): any[] {
  const candles: any[] = [];
  const swingSize = 0.0040;
  const trendBias = 0.0015;

  for (let swing = 0; swing < 4; swing++) {
    const swingBase = 1.08000 + swing * trendBias;
    for (let i = 0; i < 8; i++) {
      const price = swingBase + (i / 8) * swingSize;
      candles.push({
        time: Date.now() - (120 - (swing * 16 + i)) * 900000,
        open: price, high: price + 0.0003, low: price - 0.0001, close: price + 0.0002, volume: 100,
      });
    }
    const peak = swingBase + swingSize;
    const pullbackDepth = swingSize * 0.5;
    for (let i = 0; i < 8; i++) {
      const price = peak - (i / 8) * pullbackDepth;
      candles.push({
        time: Date.now() - (120 - (swing * 16 + 8 + i)) * 900000,
        open: price, high: price + 0.0001, low: price - 0.0003, close: price - 0.0002, volume: 100,
      });
    }
  }

  const reversalStart = 1.08000 + 3 * 0.0015 + swingSize;
  for (let i = 0; i < 20; i++) {
    const price = reversalStart - i * 0.0008;
    candles.push({
      time: Date.now() - (56 - i) * 900000,
      open: price + 0.0001, high: price + 0.0002, low: price - 0.0006, close: price - 0.0005, volume: 200,
    });
  }
  const bottom = reversalStart - 20 * 0.0008;
  for (let i = 0; i < 10; i++) {
    const price = bottom + i * 0.0003;
    candles.push({
      time: Date.now() - (36 - i) * 900000,
      open: price, high: price + 0.0002, low: price - 0.0001, close: price + 0.0001, volume: 100,
    });
  }
  return candles;
}

/**
 * Candles producing trendBasis="internal" + bearish CHoCH with internal significance.
 * Small narrow swings (only lookback=3 detectable), then internal reversal.
 */
function makeInternalBearishCandles(): any[] {
  const candles: any[] = [];
  let price = 1.08200;

  // Phase 1: Internal uptrend — narrow swings (4 candles per half-cycle)
  for (let swing = 0; swing < 5; swing++) {
    for (let i = 0; i < 4; i++) {
      const p = price + i * 0.0003;
      candles.push({
        time: Date.now() - (100 - (swing * 8 + i)) * 900000,
        open: p, high: p + 0.0002, low: p - 0.0001, close: p + 0.0001, volume: 100,
      });
    }
    price += 0.0012;
    for (let i = 0; i < 4; i++) {
      const p = price - i * 0.00015;
      candles.push({
        time: Date.now() - (100 - (swing * 8 + 4 + i)) * 900000,
        open: p, high: p + 0.0001, low: p - 0.0002, close: p - 0.0001, volume: 100,
      });
    }
    price -= 0.0006;
  }

  // Phase 2: Bearish reversal — breaks internal swing low
  const reversalStart = price + 0.0012;
  for (let i = 0; i < 4; i++) {
    const p = reversalStart - i * 0.0001;
    candles.push({
      time: Date.now() - (60 - i) * 900000,
      open: p, high: p + 0.0002, low: p - 0.0001, close: p + 0.0001, volume: 100,
    });
  }
  for (let i = 0; i < 8; i++) {
    const p = reversalStart - i * 0.0004;
    candles.push({
      time: Date.now() - (56 - i) * 900000,
      open: p + 0.0001, high: p + 0.0002, low: p - 0.0003, close: p - 0.0002, volume: 150,
    });
  }
  const bottom = reversalStart - 8 * 0.0004;
  for (let i = 0; i < 6; i++) {
    const p = bottom + i * 0.0002;
    candles.push({
      time: Date.now() - (48 - i) * 900000,
      open: p, high: p + 0.0002, low: p - 0.0001, close: p + 0.0001, volume: 100,
    });
  }
  return candles;
}

function mockSupabase() {
  return {
    from: (_table: string) => ({
      update: (_data: any) => ({ eq: () => ({ data: null, error: null }) }),
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

// ═══════════════════════════════════════════════════════════════════════
// CELL 1: Trending regime + Internal trendBasis → FIRES
// ═══════════════════════════════════════════════════════════════════════
Deno.test("regime gate [trending + internal]: structure invalidation FIRES", async () => {
  const pos = makePosition("trending");
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "cell-1",
    () => Promise.resolve(makeInternalBearishCandles()),
    mockDetectSession,
  );
  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 1,
    "Trending regime + internal break should FIRE (trend is real, not noise)");
});

// ═══════════════════════════════════════════════════════════════════════
// CELL 2: Trending regime + External trendBasis → FIRES
// ═══════════════════════════════════════════════════════════════════════
Deno.test("regime gate [trending + external]: structure invalidation FIRES", async () => {
  const pos = makePosition("trending");
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "cell-2",
    () => Promise.resolve(makeExternalBearishCandles()),
    mockDetectSession,
  );
  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 1,
    "Trending regime + external break should FIRE (strongest signal)");
});

// ═══════════════════════════════════════════════════════════════════════
// CELL 3: Ranging regime + External trendBasis → FIRES
// ═══════════════════════════════════════════════════════════════════════
Deno.test("regime gate [ranging + external]: structure invalidation FIRES", async () => {
  const pos = makePosition("ranging");
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "cell-3",
    () => Promise.resolve(makeExternalBearishCandles()),
    mockDetectSession,
  );
  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 1,
    "Ranging regime + external break should FIRE (major structural shift even in chop)");
});

// ═══════════════════════════════════════════════════════════════════════
// CELL 4: Ranging regime + Internal trendBasis → SUPPRESSED
// ═══════════════════════════════════════════════════════════════════════
Deno.test("regime gate [ranging + internal]: structure invalidation SUPPRESSED", async () => {
  const pos = makePosition("ranging");
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "cell-4",
    () => Promise.resolve(makeInternalBearishCandles()),
    mockDetectSession,
  );
  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 0,
    "Ranging regime + internal break should be SUPPRESSED (noise in choppy market)");
});

// ═══════════════════════════════════════════════════════════════════════
// ADVERSARIAL: Additional regime variants
// ═══════════════════════════════════════════════════════════════════════
Deno.test("regime gate: 'quiet' + internal → SUPPRESSED", async () => {
  const pos = makePosition("quiet");
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "adv-quiet",
    () => Promise.resolve(makeInternalBearishCandles()),
    mockDetectSession,
  );
  assertEquals(actions.filter(a => a.action === "sl_tightened").length, 0,
    "Quiet regime + internal break should be SUPPRESSED");
});

Deno.test("regime gate: 'choppy' + internal → SUPPRESSED", async () => {
  const pos = makePosition("choppy");
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "adv-choppy",
    () => Promise.resolve(makeInternalBearishCandles()),
    mockDetectSession,
  );
  assertEquals(actions.filter(a => a.action === "sl_tightened").length, 0,
    "Choppy regime + internal break should be SUPPRESSED");
});

Deno.test("regime gate: 'strong_trend' + internal → FIRES", async () => {
  const pos = makePosition("strong_trend");
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "adv-strong",
    () => Promise.resolve(makeInternalBearishCandles()),
    mockDetectSession,
  );
  assertEquals(actions.filter(a => a.action === "sl_tightened").length, 1,
    "strong_trend regime + internal break should FIRE (not in ranging family)");
});

Deno.test("regime gate: unknown/missing regime + internal → FIRES (fail-open)", async () => {
  // Legacy position with no regimeInfo stored
  const pos = {
    ...makePosition("ranging"),
    signal_reason: JSON.stringify({
      originalSL: ORIGINAL_SL,
      entryTimeframe: "15m",
      exitFlags: {},
      exitAttribution: [],
      invalidationHistory: [],
      // NO regimeInfo — simulates legacy position
    }),
  };
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "adv-unknown",
    () => Promise.resolve(makeInternalBearishCandles()),
    mockDetectSession,
  );
  assertEquals(actions.filter(a => a.action === "sl_tightened").length, 1,
    "Unknown/missing regime defaults to FIRE (fail-open, not fail-closed)");
});

Deno.test("regime gate: ranging + external → FIRES (not suppressed by ranging)", async () => {
  // Explicit re-test of cell 3 with 'quiet' variant to ensure external always fires
  const pos = makePosition("quiet");
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "adv-quiet-ext",
    () => Promise.resolve(makeExternalBearishCandles()),
    mockDetectSession,
  );
  assertEquals(actions.filter(a => a.action === "sl_tightened").length, 1,
    "Quiet regime + external break should FIRE (external overrides ranging suppression)");
});
