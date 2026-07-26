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
 * The regime is derived from CURRENT daily candles via classifyInstrumentRegime(),
 * NOT from the entry-time snapshot in signalData.regimeInfo.
 * fetchCandlesFn is interval-aware: returns structure candles for entry-TF,
 * daily candles for regime classification.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { manageOpenPositions } from "./scannerManagement.ts";
import { SPECS } from "./smcAnalysis.ts";

const SYMBOL = "EUR/USD";
const ENTRY_PRICE = 1.08500;
const ORIGINAL_SL = 1.08300; // 20 pips below entry (long)
const CURRENT_PRICE = 1.08400; // -10 pips (rMultiple ~ -0.5)

function makePosition() {
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
      // No regimeInfo — regime is now derived from current daily candles
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

/**
 * Daily candles that produce "strong_trend" regime classification.
 * Clear uptrend: each candle higher than the last, 20 pips/day.
 */
function makeTrendingDailyCandles(): any[] {
  const candles: any[] = [];
  for (let i = 0; i < 30; i++) {
    const base = 1.08000 + i * 0.0020;
    candles.push({
      time: Date.now() - (30 - i) * 86400000,
      open: base, high: base + 0.0015, low: base - 0.0005, close: base + 0.0012, volume: 1000,
    });
  }
  return candles;
}

/**
 * Daily candles that produce "mild_range" regime classification.
 * Gentle oscillation around a mean with small bodies.
 */
function makeRangingDailyCandles(): any[] {
  const candles: any[] = [];
  const mean = 1.08500;
  for (let i = 0; i < 30; i++) {
    const offset = Math.sin(i * 1.2) * 0.0025;
    const base = mean + offset;
    candles.push({
      time: Date.now() - (30 - i) * 86400000,
      open: base, high: base + 0.0015, low: base - 0.0015,
      close: base + (i % 2 === 0 ? 0.0003 : -0.0003), volume: 1000,
    });
  }
  return candles;
}

/**
 * Creates an interval-aware fetchCandlesFn mock.
 * Returns structure candles for entry-TF ("15m"/"15min") and daily candles for "1day".
 */
function makeFetchCandlesFn(structureCandles: any[], dailyCandles: any[]) {
  return (_symbol: string, interval: string, _range: string) => {
    if (interval === "1day" || interval === "1d" || interval === "daily") {
      return Promise.resolve(dailyCandles);
    }
    // Entry-TF candles (15m, 15min, 5m, 1h, etc.)
    return Promise.resolve(structureCandles);
  };
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
// CELL 1: Trending regime (from current daily) + Internal trendBasis → FIRES
// ═══════════════════════════════════════════════════════════════════════
Deno.test("regime gate [trending + internal]: structure invalidation FIRES", async () => {
  const pos = makePosition();
  const fetchFn = makeFetchCandlesFn(makeInternalBearishCandles(), makeTrendingDailyCandles());
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "cell-1",
    fetchFn,
    mockDetectSession,
  );
  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 1,
    "Trending regime + internal break should FIRE (trend is real, not noise)");
});

// ═══════════════════════════════════════════════════════════════════════
// CELL 2: Trending regime (from current daily) + External trendBasis → FIRES
// ═══════════════════════════════════════════════════════════════════════
Deno.test("regime gate [trending + external]: structure invalidation FIRES", async () => {
  const pos = makePosition();
  const fetchFn = makeFetchCandlesFn(makeExternalBearishCandles(), makeTrendingDailyCandles());
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "cell-2",
    fetchFn,
    mockDetectSession,
  );
  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 1,
    "Trending regime + external break should FIRE (strongest signal)");
});

// ═══════════════════════════════════════════════════════════════════════
// CELL 3: Ranging regime (from current daily) + External trendBasis → FIRES
// ═══════════════════════════════════════════════════════════════════════
Deno.test("regime gate [ranging + external]: structure invalidation FIRES", async () => {
  const pos = makePosition();
  const fetchFn = makeFetchCandlesFn(makeExternalBearishCandles(), makeRangingDailyCandles());
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "cell-3",
    fetchFn,
    mockDetectSession,
  );
  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 1,
    "Ranging regime + external break should FIRE (major structural shift even in chop)");
});

// ═══════════════════════════════════════════════════════════════════════
// CELL 4: Ranging regime (from current daily) + Internal trendBasis → SUPPRESSED
// ═══════════════════════════════════════════════════════════════════════
Deno.test("regime gate [ranging + internal]: structure invalidation SUPPRESSED", async () => {
  const pos = makePosition();
  const fetchFn = makeFetchCandlesFn(makeInternalBearishCandles(), makeRangingDailyCandles());
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "cell-4",
    fetchFn,
    mockDetectSession,
  );
  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 0,
    "Ranging regime + internal break should be SUPPRESSED (noise in choppy market)");
});

// ═══════════════════════════════════════════════════════════════════════
// ADVERSARIAL: Daily fetch fails → FIRES (fail-open)
// ═══════════════════════════════════════════════════════════════════════
Deno.test("regime gate: daily fetch fails → FIRES (fail-open)", async () => {
  const pos = makePosition();
  // fetchCandlesFn returns structure candles for entry-TF but FAILS for daily
  const fetchFn = (_symbol: string, interval: string, _range: string) => {
    if (interval === "1day" || interval === "1d" || interval === "daily") {
      return Promise.reject(new Error("API timeout"));
    }
    return Promise.resolve(makeInternalBearishCandles());
  };
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "adv-fail-open",
    fetchFn,
    mockDetectSession,
  );
  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 1,
    "When daily candle fetch fails, regime is unknown → gate fires (fail-open)");
});

// ═══════════════════════════════════════════════════════════════════════
// ADVERSARIAL: Insufficient daily candles (<20) → FIRES (fail-open)
// ═══════════════════════════════════════════════════════════════════════
Deno.test("regime gate: insufficient daily candles → FIRES (fail-open)", async () => {
  const pos = makePosition();
  // Only 5 daily candles — not enough for regime classification
  const fewDailyCandles = makeTrendingDailyCandles().slice(0, 5);
  const fetchFn = makeFetchCandlesFn(makeInternalBearishCandles(), fewDailyCandles);
  const actions = await manageOpenPositions(
    mockSupabase(), [pos], enabledConfig, "adv-insufficient",
    fetchFn,
    mockDetectSession,
  );
  const slTightened = actions.filter(a => a.action === "sl_tightened");
  assertEquals(slTightened.length, 1,
    "With insufficient daily candles, regime is unknown → gate fires (fail-open)");
});
