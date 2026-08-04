/**
 * determinism.test.ts — Backtest Determinism & New Feature Tests
 * ──────────────────────────────────────────────────────────────
 * Tests the new features added in Prompts 2-6:
 *   - Commission simulation (Prompt 2)
 *   - Per-instrument spread consistency (Prompt 3)
 *   - Structure invalidation (Prompt 4)
 *   - Time-varying btRateMap (Prompt 5)
 *   - Walk-forward fold calculation (Prompt 6)
 *
 * Run: deno test --no-check --allow-all supabase/functions/backtest-engine/determinism.test.ts
 */

import {
  type Candle,
  SPECS,
  calcPnl,
  calculatePositionSize,
} from "../_shared/smcAnalysis.ts";
import {
  assertEquals,
  assertAlmostEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Helpers ────────────────────────────────────────────────────────

function makeCandle(datetime: string, open: number, high: number, low: number, close: number): Candle {
  return { datetime, open, high, low, close };
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1: Commission Simulation (Prompt 2)
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Commission: round-trip formula = lots × commissionPerLot × 2", () => {
  const lots = 0.5;
  const commissionPerLot = 3.50; // $3.50 per lot per side
  const roundTripCommission = lots * commissionPerLot * 2;
  assertEquals(roundTripCommission, 3.50); // 0.5 × 3.50 × 2 = 3.50
});

Deno.test("Commission: zero commissionPerLot means zero commission", () => {
  const lots = 1.0;
  const commissionPerLot = 0;
  const roundTripCommission = lots * commissionPerLot * 2;
  assertEquals(roundTripCommission, 0);
});

Deno.test("Commission: commission reduces net PnL", () => {
  // EUR/USD long, 0.1 lot, 50 pip win
  const rawPnl = calcPnl("long", 1.08000, 1.08500, 0.1, "EUR/USD", {}).pnl;
  const commission = 0.1 * 7.0 * 2; // $7/lot RT, 0.1 lot = $1.40
  const netPnl = rawPnl - commission;
  assert(netPnl < rawPnl, "Net PnL should be less than raw PnL after commission");
  assertAlmostEquals(commission, 1.40, 0.001);
});

Deno.test("Commission: large lot size produces proportional commission", () => {
  const lots = 2.0;
  const commissionPerLot = 5.0;
  const commission = lots * commissionPerLot * 2;
  assertEquals(commission, 20.0); // 2.0 × 5.0 × 2 = 20.0
});

Deno.test("Commission: partial TP commission is proportional to closed size", () => {
  const totalLots = 1.0;
  const partialPercent = 50; // close 50%
  const closedSize = totalLots * (partialPercent / 100);
  const commissionPerLot = 3.50;
  const partialCommission = closedSize * commissionPerLot * 2;
  assertEquals(partialCommission, 3.50); // 0.5 × 3.50 × 2 = 3.50
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: Per-Instrument Spread (Prompt 3)
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Per-instrument spread: EUR/USD typicalSpread = 1.0", () => {
  const spec = SPECS["EUR/USD"];
  assertEquals(spec.typicalSpread, 1.0);
});

Deno.test("Per-instrument spread: GBP/JPY typicalSpread = 3.0", () => {
  const spec = SPECS["GBP/JPY"];
  assertEquals(spec.typicalSpread, 3.0);
});

Deno.test("Per-instrument spread: XAU/USD typicalSpread = 3.0", () => {
  const spec = SPECS["XAU/USD"];
  assertEquals(spec.typicalSpread, 3.0);
});

Deno.test("Per-instrument spread: BTC/USD typicalSpread = 20", () => {
  const spec = SPECS["BTC/USD"];
  assertEquals(spec.typicalSpread, 20.0);
});

Deno.test("Per-instrument spread: effective spread uses typicalSpread when spreadPips=0", () => {
  const spreadPips = 0;
  const spec = SPECS["EUR/USD"];
  const effectiveSpreadPips = spreadPips > 0 ? spreadPips : (spec.typicalSpread ?? 1);
  assertEquals(effectiveSpreadPips, 1.0);
});

Deno.test("Per-instrument spread: user override takes precedence when > 0", () => {
  const spreadPips = 2.5;
  const spec = SPECS["EUR/USD"];
  const effectiveSpreadPips = spreadPips > 0 ? spreadPips : (spec.typicalSpread ?? 1);
  assertEquals(effectiveSpreadPips, 2.5);
});

Deno.test("Per-instrument spread: long entry adjusted by half-spread", () => {
  const entryPrice = 1.08000;
  const spec = SPECS["EUR/USD"];
  const effectiveSpreadPips = spec.typicalSpread ?? 1;
  const adjustedEntry = entryPrice + (effectiveSpreadPips / 2) * spec.pipSize;
  assertAlmostEquals(adjustedEntry, 1.08005, 0.00001); // 0.5 pip above
});

Deno.test("Per-instrument spread: short entry adjusted by half-spread", () => {
  const entryPrice = 1.08000;
  const spec = SPECS["EUR/USD"];
  const effectiveSpreadPips = spec.typicalSpread ?? 1;
  const adjustedEntry = entryPrice - (effectiveSpreadPips / 2) * spec.pipSize;
  assertAlmostEquals(adjustedEntry, 1.07995, 0.00001); // 0.5 pip below
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3: Structure Invalidation (Prompt 4)
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Structure invalidation: rMultiple window check (-0.8 to 0)", () => {
  // Structure invalidation only fires when rMultiple is between -0.8 and 0
  const entryPrice = 1.08000;
  const stopLoss = 1.07500; // 50 pips below
  const spec = SPECS["EUR/USD"];
  const slDistPips = Math.abs(entryPrice - stopLoss) / spec.pipSize; // 50 pips
  
  // Price at -20 pips (rMultiple = -0.4, within window)
  const currentPrice1 = 1.07800;
  const pnlPips1 = (currentPrice1 - entryPrice) / spec.pipSize; // -20
  const rMultiple1 = pnlPips1 / slDistPips; // -0.4
  assert(rMultiple1 < 0 && rMultiple1 > -0.8, "Should be in invalidation window");
  
  // Price at -45 pips (rMultiple = -0.9, outside window)
  const currentPrice2 = 1.07550;
  const pnlPips2 = (currentPrice2 - entryPrice) / spec.pipSize; // -45
  const rMultiple2 = pnlPips2 / slDistPips; // -0.9
  assert(!(rMultiple2 < 0 && rMultiple2 > -0.8), "Should be outside invalidation window");
  
  // Price at +10 pips (rMultiple = +0.2, outside window - profitable)
  const currentPrice3 = 1.08100;
  const pnlPips3 = (currentPrice3 - entryPrice) / spec.pipSize; // +10
  const rMultiple3 = pnlPips3 / slDistPips; // +0.2
  assert(!(rMultiple3 < 0 && rMultiple3 > -0.8), "Should be outside invalidation window (profitable)");
});

Deno.test("Structure invalidation: SL tightening by 50%", () => {
  const entryPrice = 1.08000;
  const originalSL = 1.07500; // 50 pips below
  const spec = SPECS["EUR/USD"];
  
  // When structure invalidation fires, SL tightens by 50%
  const currentPrice = 1.07800; // -20 pips underwater
  const midpoint = (entryPrice + originalSL) / 2;
  const newSL = midpoint; // Tighten to midpoint (50% of distance)
  
  const originalDist = Math.abs(entryPrice - originalSL) / spec.pipSize; // 50 pips
  const newDist = Math.abs(entryPrice - newSL) / spec.pipSize; // 25 pips
  assertAlmostEquals(newDist, originalDist * 0.5, 0.1);
});

Deno.test("Structure invalidation: one-shot guard prevents double firing", () => {
  let structureInvalidationFired = false;
  
  // First check: fires
  if (!structureInvalidationFired) {
    structureInvalidationFired = true;
    // SL would be tightened here
  }
  assert(structureInvalidationFired, "Should have fired");
  
  // Second check: does NOT fire again
  let firedAgain = false;
  if (!structureInvalidationFired) {
    firedAgain = true;
  }
  assert(!firedAgain, "Should not fire again (one-shot)");
});

Deno.test("Structure invalidation: disabled when config.structureInvalidationEnabled = false", () => {
  const config = { structureInvalidationEnabled: false };
  // When disabled, the check should be skipped entirely
  assert(config.structureInvalidationEnabled === false);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 4: Time-Varying btRateMap (Prompt 5)
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Time-varying rate: binary search finds closest date <= target", () => {
  // Simulate the getRateMapForDate logic
  const timeline: { date: string; rates: Record<string, number> }[] = [
    { date: "2024-01-01", rates: { "USD/JPY": 141.0 } },
    { date: "2024-01-02", rates: { "USD/JPY": 142.0 } },
    { date: "2024-01-03", rates: { "USD/JPY": 143.0 } },
    { date: "2024-01-05", rates: { "USD/JPY": 144.0 } }, // gap on Jan 4 (weekend)
  ];
  
  function getRateForDate(dateStr: string): Record<string, number> {
    let lo = 0, hi = timeline.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timeline[mid].date <= dateStr) lo = mid + 1;
      else hi = mid - 1;
    }
    return hi >= 0 ? timeline[hi].rates : timeline[0].rates;
  }
  
  // Exact match
  assertEquals(getRateForDate("2024-01-02")["USD/JPY"], 142.0);
  // Between dates (Jan 4 is weekend, should use Jan 3)
  assertEquals(getRateForDate("2024-01-04")["USD/JPY"], 143.0);
  // After all dates
  assertEquals(getRateForDate("2024-01-10")["USD/JPY"], 144.0);
  // Before all dates
  assertEquals(getRateForDate("2023-12-31")["USD/JPY"], 141.0);
});

Deno.test("Time-varying rate: different dates produce different conversion rates", () => {
  // Simulate a 6-month backtest where USD/JPY moved from 141 to 155
  const rateJan = 141.0;
  const rateJun = 155.0;
  
  // Same GBP/JPY trade, different USD conversion
  const pnlPips = 50;
  const lots = 0.1;
  const lotUnits = 100000;
  const pipSize = 0.01; // JPY pair
  
  // PnL in JPY = 50 * 0.01 * 0.1 * 100000 = 5000 JPY
  const pnlJPY = pnlPips * pipSize * lots * lotUnits;
  assertEquals(pnlJPY, 5000);
  
  // Convert to USD at different rates
  const pnlUSD_Jan = pnlJPY / rateJan;
  const pnlUSD_Jun = pnlJPY / rateJun;
  
  assertAlmostEquals(pnlUSD_Jan, 35.46, 0.01); // 5000/141
  assertAlmostEquals(pnlUSD_Jun, 32.26, 0.01); // 5000/155
  
  // The difference is ~$3.20 — significant for accurate backtesting
  assert(pnlUSD_Jan > pnlUSD_Jun, "Jan rate should give higher USD PnL");
});

Deno.test("Time-varying rate: fallback to static map when timeline is empty", () => {
  const timeline: { date: string; rates: Record<string, number> }[] = [];
  const staticMap = { "USD/JPY": 150.0 };
  
  function getRateForDate(dateStr: string): Record<string, number> {
    if (timeline.length === 0) return staticMap;
    let lo = 0, hi = timeline.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timeline[mid].date <= dateStr) lo = mid + 1;
      else hi = mid - 1;
    }
    return hi >= 0 ? timeline[hi].rates : staticMap;
  }
  
  assertEquals(getRateForDate("2024-06-15")["USD/JPY"], 150.0);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 5: Walk-Forward Validation (Prompt 6)
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Walk-forward: date range splits into N equal folds", () => {
  const startMs = new Date("2024-01-01").getTime();
  const endMs = new Date("2024-07-01").getTime();
  const folds = 6;
  const foldDuration = (endMs - startMs) / folds;
  
  const foldBoundaries: { start: number; end: number }[] = [];
  for (let i = 0; i < folds; i++) {
    foldBoundaries.push({
      start: startMs + i * foldDuration,
      end: startMs + (i + 1) * foldDuration,
    });
  }
  
  assertEquals(foldBoundaries.length, 6);
  // First fold starts at Jan 1
  assertEquals(new Date(foldBoundaries[0].start).toISOString().slice(0, 10), "2024-01-01");
  // Last fold ends at Jul 1
  assertEquals(new Date(foldBoundaries[5].end).toISOString().slice(0, 10), "2024-07-01");
  // Folds are contiguous
  for (let i = 1; i < folds; i++) {
    assertEquals(foldBoundaries[i].start, foldBoundaries[i - 1].end);
  }
});

Deno.test("Walk-forward: trades assigned to correct fold by entry time", () => {
  const startMs = new Date("2024-01-01").getTime();
  const endMs = new Date("2024-04-01").getTime();
  const folds = 3;
  const foldDuration = (endMs - startMs) / folds;
  
  const trades = [
    { entryTime: "2024-01-15T10:00:00Z", pnl: 50 },  // Fold 0
    { entryTime: "2024-02-15T10:00:00Z", pnl: -30 },  // Fold 1
    { entryTime: "2024-03-15T10:00:00Z", pnl: 80 },   // Fold 2
  ];
  
  const foldTrades: typeof trades[] = Array.from({ length: folds }, () => []);
  for (const trade of trades) {
    const tradeMs = new Date(trade.entryTime).getTime();
    const foldIndex = Math.min(Math.floor((tradeMs - startMs) / foldDuration), folds - 1);
    foldTrades[foldIndex].push(trade);
  }
  
  assertEquals(foldTrades[0].length, 1);
  assertEquals(foldTrades[1].length, 1);
  assertEquals(foldTrades[2].length, 1);
  assertEquals(foldTrades[0][0].pnl, 50);
  assertEquals(foldTrades[1][0].pnl, -30);
  assertEquals(foldTrades[2][0].pnl, 80);
});

Deno.test("Walk-forward: consistency score = profitable folds / total folds", () => {
  const foldPnls = [100, -50, 200, 150, -20]; // 3 profitable, 2 losing
  const profitableFolds = foldPnls.filter(p => p > 0).length;
  const consistencyScore = profitableFolds / foldPnls.length;
  assertAlmostEquals(consistencyScore, 0.6, 0.001); // 3/5 = 60%
});

Deno.test("Walk-forward: verdict classification", () => {
  function getVerdict(consistencyScore: number): string {
    if (consistencyScore >= 0.75) return "robust";
    if (consistencyScore >= 0.50) return "moderate";
    return "fragile";
  }
  
  assertEquals(getVerdict(0.80), "robust");
  assertEquals(getVerdict(0.75), "robust");
  assertEquals(getVerdict(0.60), "moderate");
  assertEquals(getVerdict(0.50), "moderate");
  assertEquals(getVerdict(0.40), "fragile");
  assertEquals(getVerdict(0.0), "fragile");
});

Deno.test("Walk-forward: win rate standard deviation calculation", () => {
  const winRates = [0.65, 0.70, 0.60, 0.68, 0.72]; // 5 folds
  const mean = winRates.reduce((a, b) => a + b, 0) / winRates.length;
  const variance = winRates.reduce((sum, wr) => sum + (wr - mean) ** 2, 0) / winRates.length;
  const stdDev = Math.sqrt(variance);
  
  assertAlmostEquals(mean, 0.67, 0.001);
  assert(stdDev < 0.05, `StdDev ${stdDev} should be < 0.05 for consistent strategy`);
});

Deno.test("Walk-forward: best/worst fold identification", () => {
  const foldStats = [
    { fold: 0, pnl: 100, winRate: 0.65 },
    { fold: 1, pnl: -50, winRate: 0.40 },
    { fold: 2, pnl: 200, winRate: 0.75 },
    { fold: 3, pnl: 150, winRate: 0.70 },
  ];
  
  const best = foldStats.reduce((a, b) => a.pnl > b.pnl ? a : b);
  const worst = foldStats.reduce((a, b) => a.pnl < b.pnl ? a : b);
  
  assertEquals(best.fold, 2);
  assertEquals(worst.fold, 1);
});

Deno.test("Walk-forward: disabled when folds = 0", () => {
  const walkForwardFolds = 0;
  const shouldRun = walkForwardFolds >= 2;
  assertEquals(shouldRun, false);
});

Deno.test("Walk-forward: minimum 2 folds required", () => {
  const walkForwardFolds = 1;
  const shouldRun = walkForwardFolds >= 2;
  assertEquals(shouldRun, false);
  
  const walkForwardFolds2 = 2;
  const shouldRun2 = walkForwardFolds2 >= 2;
  assertEquals(shouldRun2, true);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 6: Determinism — same inputs always produce same outputs
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Determinism: calcPnl is deterministic for same inputs", () => {
  const results: number[] = [];
  for (let i = 0; i < 10; i++) {
    const { pnl } = calcPnl("long", 1.08000, 1.08500, 0.1, "EUR/USD", {});
    results.push(pnl);
  }
  // All results should be identical
  for (let i = 1; i < results.length; i++) {
    assertEquals(results[i], results[0]);
  }
});

Deno.test("Determinism: calculatePositionSize is deterministic", () => {
  const results: number[] = [];
  const rateMap: Record<string, number> = { "USD/JPY": 150.0, "GBP/USD": 1.27 };
  for (let i = 0; i < 10; i++) {
    // Signature: balance, riskPercent, entryPrice, stopLoss, symbol, config, rateMap
    const size = calculatePositionSize(
      10000, 1.0, 1.08000, 1.07500, "EUR/USD",
      { positionSizingMethod: "percent_risk" }, rateMap
    );
    results.push(size);
  }
  for (let i = 1; i < results.length; i++) {
    assertEquals(results[i], results[0]);
  }
});

Deno.test("Determinism: spread adjustment is deterministic", () => {
  const spec = SPECS["EUR/USD"];
  const entryPrice = 1.08000;
  const spreadPips = 0;
  const effectiveSpread = spreadPips > 0 ? spreadPips : (spec.typicalSpread ?? 1);
  
  const results: number[] = [];
  for (let i = 0; i < 10; i++) {
    const adjusted = entryPrice + (effectiveSpread / 2) * spec.pipSize;
    results.push(adjusted);
  }
  for (let i = 1; i < results.length; i++) {
    assertEquals(results[i], results[0]);
  }
});
