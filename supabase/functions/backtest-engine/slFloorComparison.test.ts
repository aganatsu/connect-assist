/**
 * slFloorComparison.test.ts — SL Floor Impact Quantification
 * ────────────────────────────────────────────────────────────
 * Compares trade outcomes WITH vs WITHOUT the MIN_SL_PIPS + ATR floor.
 * This is a regression/delta test that documents the expected behavioral
 * difference introduced by the SL floor enforcement.
 *
 * Run: deno test --allow-all supabase/functions/backtest-engine/slFloorComparison.test.ts
 */
import {
  type Candle,
  SPECS,
  MIN_SL_PIPS,
  ATR_SL_FLOOR_MULTIPLIER,
  calculateATR,
  calculatePositionSize,
} from "../_shared/smcAnalysis.ts";
import { assertEquals, assert, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Helpers ────────────────────────────────────────────────────────

function makeCandle(datetime: string, open: number, high: number, low: number, close: number): Candle {
  return { datetime, open, high, low, close };
}

/** Simulate a trade exit: check if SL or TP is hit within the given candles */
function simulateTradeExit(
  direction: "long" | "short",
  entry: number,
  sl: number,
  tp: number,
  candles: Candle[],
): { outcome: "sl" | "tp" | "open"; exitPrice: number; exitIndex: number; pnlPips: number } {
  const spec = SPECS["EUR/USD"];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (direction === "long") {
      if (c.low <= sl) return { outcome: "sl", exitPrice: sl, exitIndex: i, pnlPips: (sl - entry) / spec.pipSize };
      if (c.high >= tp) return { outcome: "tp", exitPrice: tp, exitIndex: i, pnlPips: (tp - entry) / spec.pipSize };
    } else {
      if (c.high >= sl) return { outcome: "sl", exitPrice: sl, exitIndex: i, pnlPips: (entry - sl) / spec.pipSize };
      if (c.low <= tp) return { outcome: "tp", exitPrice: tp, exitIndex: i, pnlPips: (entry - tp) / spec.pipSize };
    }
  }
  const lastClose = candles[candles.length - 1].close;
  const pnl = direction === "long" ? (lastClose - entry) / spec.pipSize : (entry - lastClose) / spec.pipSize;
  return { outcome: "open", exitPrice: lastClose, exitIndex: candles.length - 1, pnlPips: pnl };
}

/** Apply the SL floor logic (same as backtest-engine) */
function applySlFloor(
  direction: "long" | "short",
  entry: number,
  originalSl: number,
  originalTp: number,
  symbol: string,
  atrVal: number,
): { sl: number; tp: number; wasWidened: boolean; originalSlPips: number; newSlPips: number } {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  const slDistPips = Math.abs(entry - originalSl) / spec.pipSize;
  const staticMin = MIN_SL_PIPS[symbol] ?? MIN_SL_PIPS["EUR/USD"] ?? 10;
  const atrFloorPips = atrVal > 0 ? (atrVal * ATR_SL_FLOOR_MULTIPLIER) / spec.pipSize : 0;
  const effectiveMinSl = Math.max(staticMin, atrFloorPips);

  if (slDistPips >= effectiveMinSl) {
    return { sl: originalSl, tp: originalTp, wasWidened: false, originalSlPips: slDistPips, newSlPips: slDistPips };
  }

  // Widen SL and adjust TP to preserve R:R
  const originalRR = Math.abs(originalTp - entry) / Math.abs(originalSl - entry);
  const newSlDist = effectiveMinSl * spec.pipSize;
  let newSl: number, newTp: number;
  if (direction === "long") {
    newSl = entry - newSlDist;
    newTp = entry + newSlDist * originalRR;
  } else {
    newSl = entry + newSlDist;
    newTp = entry - newSlDist * originalRR;
  }
  return { sl: newSl, tp: newTp, wasWidened: true, originalSlPips: slDistPips, newSlPips: effectiveMinSl };
}

// ─── Test Scenarios ─────────────────────────────────────────────────

/**
 * Scenario 1: EUR/USD trades with tight SLs (5-8 pips) in normal volatility.
 * These are the trades most affected by the floor (MIN_SL_PIPS["EUR/USD"] = 10).
 */
Deno.test("SL Floor Comparison: tight-SL EUR/USD trades", () => {
  const spec = SPECS["EUR/USD"];
  const entry = 1.0850;
  const atrVal = 0.0012; // ~12 pips ATR → ATR floor = 12 * 1.5 / 0.0001 = 180 pips? No, ATR_SL_FLOOR_MULTIPLIER is 0.5
  // ATR floor = 0.0012 * 0.5 / 0.0001 = 6 pips. So static floor (10) wins.

  // Generate realistic price action: choppy then trending up
  const baseMs = new Date("2025-01-15T10:00:00Z").getTime();
  const candles: Candle[] = [];
  let price = entry;
  // First 20 candles: choppy (whipsaw zone)
  for (let i = 0; i < 20; i++) {
    const dt = new Date(baseMs + i * 15 * 60000).toISOString();
    const noise = (Math.sin(i * 2.1) * 0.0008); // oscillate ±8 pips
    candles.push(makeCandle(dt, price, price + 0.0005, price - 0.0006, price + noise));
    price = price + noise;
  }
  // Next 30 candles: trending up
  for (let i = 20; i < 50; i++) {
    const dt = new Date(baseMs + i * 15 * 60000).toISOString();
    const drift = 0.0003; // 3 pips per candle upward drift
    candles.push(makeCandle(dt, price, price + 0.0006, price - 0.0002, price + drift));
    price = price + drift;
  }

  // Test 5 trades with progressively tighter SLs
  const tightSlPips = [5, 6, 7, 8, 9];
  const results: { slPips: number; withoutFloor: string; withFloor: string; delta: string }[] = [];

  for (const slPips of tightSlPips) {
    const sl = entry - slPips * spec.pipSize;
    const tp = entry + slPips * 2 * spec.pipSize; // 2:1 R:R

    // Without floor
    const noFloor = simulateTradeExit("long", entry, sl, tp, candles);

    // With floor
    const floored = applySlFloor("long", entry, sl, tp, "EUR/USD", atrVal);
    const withFloor = simulateTradeExit("long", entry, floored.sl, floored.tp, candles);

    results.push({
      slPips,
      withoutFloor: `${noFloor.outcome} @ ${noFloor.pnlPips.toFixed(1)} pips (bar ${noFloor.exitIndex})`,
      withFloor: `${withFloor.outcome} @ ${withFloor.pnlPips.toFixed(1)} pips (bar ${withFloor.exitIndex})`,
      delta: floored.wasWidened ? `SL widened ${slPips}→${floored.newSlPips.toFixed(0)}p` : "no change",
    });
  }

  console.log("\n═══ SL Floor Impact: EUR/USD Tight-SL Trades ═══");
  console.log("SL(pips) | Without Floor        | With Floor           | Delta");
  console.log("─────────┼──────────────────────┼──────────────────────┼──────────────────");
  for (const r of results) {
    console.log(`${r.slPips.toString().padStart(8)} | ${r.withoutFloor.padEnd(20)} | ${r.withFloor.padEnd(20)} | ${r.delta}`);
  }

  // Verify that all tight SLs (< 20 pips) were widened
  // EUR/USD MIN_SL_PIPS = 20, ATR floor = 0.0012 * 1.5 / 0.0001 = 18 pips → static wins at 20
  for (const slPips of tightSlPips) {
    if (slPips < 20) {
      const floored = applySlFloor("long", entry, entry - slPips * spec.pipSize, entry + slPips * 2 * spec.pipSize, "EUR/USD", atrVal);
      assert(floored.wasWidened, `SL of ${slPips} pips should be widened to minimum 20 pips`);
      assertAlmostEquals(floored.newSlPips, 20, 0.1, `New SL should be 20 pips (static floor for EUR/USD)`);
    }
  }
});

/**
 * Scenario 2: GBP/JPY trades with tight SLs in high volatility.
 * GBP/JPY has MIN_SL_PIPS = 25 and typically higher ATR.
 */
Deno.test("SL Floor Comparison: GBP/JPY high-volatility trades", () => {
  const spec = SPECS["GBP/JPY"];
  const entry = 192.500;
  // GBP/JPY: MIN_SL_PIPS = 35, ATR_SL_FLOOR_MULTIPLIER = 1.5
  // ATR = 0.30 → ATR floor = 0.30 * 1.5 / 0.01 = 45 pips. ATR floor > static (35).
  const atrVal = 0.30;

  // Test trades with SLs below and above the effective floor (45 pips from ATR)
  const testCases = [
    { slPips: 15, direction: "long" as const },
    { slPips: 30, direction: "long" as const },
    { slPips: 46, direction: "long" as const }, // just above ATR floor
    { slPips: 50, direction: "short" as const }, // well above both floors
  ];

  console.log("\n═══ SL Floor Impact: GBP/JPY High-Volatility ═══");
  for (const tc of testCases) {
    const sl = tc.direction === "long"
      ? entry - tc.slPips * spec.pipSize
      : entry + tc.slPips * spec.pipSize;
    const tp = tc.direction === "long"
      ? entry + tc.slPips * 2 * spec.pipSize
      : entry - tc.slPips * 2 * spec.pipSize;

    const floored = applySlFloor(tc.direction, entry, sl, tp, "GBP/JPY", atrVal);
    console.log(`  ${tc.direction.toUpperCase()} SL=${tc.slPips}p → ${floored.wasWidened ? `widened to ${floored.newSlPips.toFixed(0)}p` : "no change"}`);

    if (tc.slPips < 45) {
      assert(floored.wasWidened, `GBP/JPY SL of ${tc.slPips} should be widened (effective floor=45p from ATR)`);
      assertAlmostEquals(floored.newSlPips, 45, 0.5);
    } else {
      assert(!floored.wasWidened, `GBP/JPY SL of ${tc.slPips} should NOT be widened (above floor)`);
    }
  }
});

/**
 * Scenario 3: ATR-driven floor dominates when volatility is high.
 * EUR/USD with ATR = 0.0030 (30 pips) → ATR floor = 30 * 0.5 = 15 pips > static 10 pips.
 */
Deno.test("SL Floor Comparison: ATR floor dominates in high volatility", () => {
  const spec = SPECS["EUR/USD"];
  const entry = 1.0850;
  const highAtr = 0.0030; // 30 pips → ATR floor = 30 * 1.5 = 45 pips

  // 12-pip SL: above static (10) but below ATR floor (15)
  const sl12 = entry - 12 * spec.pipSize;
  const tp12 = entry + 24 * spec.pipSize;
  const result12 = applySlFloor("long", entry, sl12, tp12, "EUR/USD", highAtr);

  console.log("\n═══ SL Floor: ATR Floor Dominates ═══");
  console.log(`  EUR/USD ATR=30p, SL=12p → ${result12.wasWidened ? `widened to ${result12.newSlPips.toFixed(0)}p (ATR floor)` : "no change"}`);

  assert(result12.wasWidened, "12-pip SL should be widened when ATR floor is 45 pips");
  assertAlmostEquals(result12.newSlPips, 45, 0.5, "Should widen to ATR floor (45 pips)");

  // Verify R:R is preserved
  const originalRR = 24 / 12; // 2:1
  const newRR = Math.abs(result12.tp - entry) / Math.abs(result12.sl - entry);
  assertAlmostEquals(newRR, originalRR, 0.01, "R:R should be preserved after widening");
});

/**
 * Scenario 4: Batch comparison — simulate 100 trades with random SLs
 * to quantify the overall impact percentage.
 */
Deno.test("SL Floor Comparison: batch impact quantification (100 trades)", () => {
  const symbols = ["EUR/USD", "GBP/USD", "GBP/JPY", "USD/JPY", "XAU/USD"];
  let totalTrades = 0;
  let widenedTrades = 0;
  let avgWideningPips = 0;
  const symbolStats: Record<string, { total: number; widened: number; avgWidening: number }> = {};

  // Deterministic pseudo-random using simple LCG
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed / 0x7fffffff; };

  for (const symbol of symbols) {
    const spec = SPECS[symbol];
    const minSl = MIN_SL_PIPS[symbol] ?? 10;
    let symWidened = 0;
    let symWidening = 0;

    for (let i = 0; i < 20; i++) {
      totalTrades++;
      // Random SL between 3 pips and 2x the minimum
      const slPips = 3 + rand() * (minSl * 2 - 3);
      // Random ATR between 0.5x and 2x the static minimum
      const atrPips = minSl * (0.5 + rand() * 1.5);
      const atrVal = atrPips * spec.pipSize;
      const entry = symbol.includes("JPY") ? 150.000 : (symbol === "XAU/USD" ? 2400.00 : 1.0850);
      const direction: "long" | "short" = rand() > 0.5 ? "long" : "short";
      const sl = direction === "long" ? entry - slPips * spec.pipSize : entry + slPips * spec.pipSize;
      const tp = direction === "long" ? entry + slPips * 2 * spec.pipSize : entry - slPips * 2 * spec.pipSize;

      const result = applySlFloor(direction, entry, sl, tp, symbol, atrVal);
      if (result.wasWidened) {
        widenedTrades++;
        symWidened++;
        const widening = result.newSlPips - result.originalSlPips;
        avgWideningPips += widening;
        symWidening += widening;
      }
    }
    symbolStats[symbol] = {
      total: 20,
      widened: symWidened,
      avgWidening: symWidened > 0 ? symWidening / symWidened : 0,
    };
  }

  avgWideningPips = widenedTrades > 0 ? avgWideningPips / widenedTrades : 0;

  console.log("\n═══ SL Floor Batch Impact (100 trades, random SLs) ═══");
  console.log(`  Total trades: ${totalTrades}`);
  console.log(`  Widened: ${widenedTrades} (${(widenedTrades / totalTrades * 100).toFixed(1)}%)`);
  console.log(`  Avg widening: ${avgWideningPips.toFixed(1)} pips`);
  console.log("\n  Per-symbol breakdown:");
  for (const [sym, stats] of Object.entries(symbolStats)) {
    console.log(`    ${sym}: ${stats.widened}/${stats.total} widened (${(stats.widened / stats.total * 100).toFixed(0)}%), avg +${stats.avgWidening.toFixed(1)} pips`);
  }

  // Assertions: verify the floor is working
  assert(widenedTrades > 0, "Some trades should be widened");
  assert(widenedTrades < totalTrades, "Not all trades should be widened (some are already above minimum)");
  assert(avgWideningPips > 0, "Average widening should be positive");
});

/**
 * Scenario 5: R:R preservation verification.
 * Ensures that widening SL always preserves the original R:R ratio.
 */
Deno.test("SL Floor Comparison: R:R always preserved after widening", () => {
  const testCases = [
    { symbol: "EUR/USD", entry: 1.0850, slPips: 5, rrRatio: 2.0, direction: "long" as const },
    { symbol: "EUR/USD", entry: 1.0850, slPips: 7, rrRatio: 3.0, direction: "short" as const },
    { symbol: "GBP/JPY", entry: 192.500, slPips: 15, rrRatio: 1.5, direction: "long" as const },
    { symbol: "XAU/USD", entry: 2400.00, slPips: 20, rrRatio: 2.5, direction: "short" as const },
  ];

  console.log("\n═══ R:R Preservation Check ═══");
  for (const tc of testCases) {
    const spec = SPECS[tc.symbol];
    const sl = tc.direction === "long"
      ? tc.entry - tc.slPips * spec.pipSize
      : tc.entry + tc.slPips * spec.pipSize;
    const tp = tc.direction === "long"
      ? tc.entry + tc.slPips * tc.rrRatio * spec.pipSize
      : tc.entry - tc.slPips * tc.rrRatio * spec.pipSize;

    const result = applySlFloor(tc.direction, tc.entry, sl, tp, tc.symbol, 0); // static floor only

    if (result.wasWidened) {
      const newRR = Math.abs(result.tp - tc.entry) / Math.abs(result.sl - tc.entry);
      console.log(`  ${tc.symbol} ${tc.direction} SL=${tc.slPips}p R:R=${tc.rrRatio} → widened, new R:R=${newRR.toFixed(2)}`);
      assertAlmostEquals(newRR, tc.rrRatio, 0.01, `R:R must be preserved: expected ${tc.rrRatio}, got ${newRR}`);
    } else {
      console.log(`  ${tc.symbol} ${tc.direction} SL=${tc.slPips}p — not widened (already above minimum)`);
    }
  }
});
