/**
 * calcPnl.test.ts — Cross-pair PnL math regression tests
 * ────────────────────────────────────────────────────────
 * Tests every quote-currency category with hand-computed expected values.
 * Formula: pnl = diff × lotUnits × size × quoteToUSD
 *   where diff = (current - entry) for long, (entry - current) for short
 *   quoteToUSD depends on quote currency and rateMap
 *
 * Run: deno test --allow-all supabase/functions/_shared/calcPnl.test.ts
 */

import {
  calcPnl,
  getQuoteToUSDRate,
  SPECS,
} from "./smcAnalysis.ts";
import {
  assertEquals,
  assertAlmostEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Helper ─────────────────────────────────────────────────────────
function roundTo(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1: XXX/USD pairs (no conversion — quote is USD, quoteToUSD = 1)
// ═══════════════════════════════════════════════════════════════════════

Deno.test("XXX/USD: Long EUR/USD 0.1 lot, entry 1.0800, exit 1.0850 → $50.00", () => {
  // Calculation: diff = 1.0850 - 1.0800 = 0.0050
  // pnl = 0.0050 × 100000 × 0.1 × 1.0 = $50.00
  // pnlPips = 0.0050 / 0.0001 = 50
  const result = calcPnl("long", 1.0800, 1.0850, 0.1, "EUR/USD");
  assertAlmostEquals(result.pnl, 50.00, 0.001);
  assertAlmostEquals(result.pnlPips, 50, 0.001);
});

Deno.test("XXX/USD: Short EUR/USD 0.1 lot, entry 1.0800, exit 1.0850 → -$50.00", () => {
  // Calculation: diff = 1.0800 - 1.0850 = -0.0050
  // pnl = -0.0050 × 100000 × 0.1 × 1.0 = -$50.00
  // pnlPips = -0.0050 / 0.0001 = -50
  const result = calcPnl("short", 1.0800, 1.0850, 0.1, "EUR/USD");
  assertAlmostEquals(result.pnl, -50.00, 0.001);
  assertAlmostEquals(result.pnlPips, -50, 0.001);
});

Deno.test("XXX/USD: Long XAU/USD 0.1 lot, entry 2000.00, exit 2010.00 → $100.00", () => {
  // XAU/USD: lotUnits=100, pipSize=0.01
  // Calculation: diff = 2010.00 - 2000.00 = 10.00
  // pnl = 10.00 × 100 × 0.1 × 1.0 = $100.00
  // pnlPips = 10.00 / 0.01 = 1000
  const result = calcPnl("long", 2000.00, 2010.00, 0.1, "XAU/USD");
  assertAlmostEquals(result.pnl, 100.00, 0.001);
  assertAlmostEquals(result.pnlPips, 1000, 0.001);
});

Deno.test("XXX/USD: Long BTC/USD 0.01 lot, entry 60000, exit 61000 → $10.00", () => {
  // BTC/USD: lotUnits=1, pipSize=1
  // Calculation: diff = 61000 - 60000 = 1000
  // pnl = 1000 × 1 × 0.01 × 1.0 = $10.00
  // pnlPips = 1000 / 1 = 1000
  const result = calcPnl("long", 60000, 61000, 0.01, "BTC/USD");
  assertAlmostEquals(result.pnl, 10.00, 0.001);
  assertAlmostEquals(result.pnlPips, 1000, 0.001);
});

Deno.test("XXX/USD: Short GBP/USD 0.5 lot, entry 1.2700, exit 1.2650 → $250.00", () => {
  // Calculation: diff = 1.2700 - 1.2650 = 0.0050
  // pnl = 0.0050 × 100000 × 0.5 × 1.0 = $250.00
  // pnlPips = 0.0050 / 0.0001 = 50
  const result = calcPnl("short", 1.2700, 1.2650, 0.5, "GBP/USD");
  assertAlmostEquals(result.pnl, 250.00, 0.001);
  assertAlmostEquals(result.pnlPips, 50, 0.001);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: USD/XXX pairs (need to divide by current pair price)
// quoteToUSD = 1 / USD_XXX_price (invert: true)
// ═══════════════════════════════════════════════════════════════════════

Deno.test("USD/XXX: Long USD/JPY 0.1 lot, entry 150.00, exit 150.50 at price 150 → $33.33", () => {
  // USD/JPY: lotUnits=100000, pipSize=0.01
  // quoteToUSD for JPY = 1/USDJPY = 1/150 = 0.006667
  // diff = 150.50 - 150.00 = 0.50
  // pnl = 0.50 × 100000 × 0.1 × (1/150) = 5000 / 150 = $33.333...
  // pnlPips = 0.50 / 0.01 = 50
  const rateMap = { "USD/JPY": 150.00 };
  const result = calcPnl("long", 150.00, 150.50, 0.1, "USD/JPY", rateMap);
  assertAlmostEquals(result.pnl, 33.333, 0.01);
  assertAlmostEquals(result.pnlPips, 50, 0.001);
});

Deno.test("USD/XXX: Long USD/JPY 0.1 lot, entry 100.00, exit 100.50 at price 100 → $50.00 (price-sensitivity)", () => {
  // quoteToUSD for JPY = 1/100 = 0.01
  // diff = 100.50 - 100.00 = 0.50
  // pnl = 0.50 × 100000 × 0.1 × (1/100) = 5000 / 100 = $50.00
  const rateMap = { "USD/JPY": 100.00 };
  const result = calcPnl("long", 100.00, 100.50, 0.1, "USD/JPY", rateMap);
  assertAlmostEquals(result.pnl, 50.00, 0.01);
  assertAlmostEquals(result.pnlPips, 50, 0.001);
});

Deno.test("USD/XXX: Long USD/CAD 0.1 lot at 1.3500, 25 pip win → $18.52", () => {
  // USD/CAD: lotUnits=100000, pipSize=0.0001
  // quoteToUSD for CAD = 1/USDCAD = 1/1.35 = 0.7407
  // 25 pips = 25 × 0.0001 = 0.0025 price move
  // diff = 0.0025
  // pnl = 0.0025 × 100000 × 0.1 × (1/1.35) = 25 / 1.35 = $18.5185...
  // pnlPips = 0.0025 / 0.0001 = 25
  const rateMap = { "USD/CAD": 1.3500 };
  const result = calcPnl("long", 1.3500, 1.3525, 0.1, "USD/CAD", rateMap);
  assertAlmostEquals(result.pnl, 18.5185, 0.01);
  assertAlmostEquals(result.pnlPips, 25, 0.001);
});

Deno.test("USD/XXX: Short USD/CHF 0.1 lot at 0.9000, 25 pip loss → -$27.78", () => {
  // USD/CHF: lotUnits=100000, pipSize=0.0001
  // quoteToUSD for CHF = 1/USDCHF = 1/0.90 = 1.1111
  // Short: diff = entry - current = 0.9000 - 0.9025 = -0.0025 (25 pip loss)
  // pnl = -0.0025 × 100000 × 0.1 × (1/0.90) = -25 / 0.90 = -$27.778
  // pnlPips = -0.0025 / 0.0001 = -25
  const rateMap = { "USD/CHF": 0.9000 };
  const result = calcPnl("short", 0.9000, 0.9025, 0.1, "USD/CHF", rateMap);
  assertAlmostEquals(result.pnl, -27.778, 0.01);
  assertAlmostEquals(result.pnlPips, -25, 0.001);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3: JPY crosses (need USD/JPY rate)
// quoteToUSD for JPY = 1/USDJPY (invert: true)
// ═══════════════════════════════════════════════════════════════════════

Deno.test("JPY cross: Long EUR/JPY 0.1 lot, entry 162.00, exit 162.50, USD/JPY at 150 → $33.33", () => {
  // EUR/JPY: lotUnits=100000, pipSize=0.01
  // quoteToUSD for JPY = 1/150 = 0.006667
  // diff = 162.50 - 162.00 = 0.50
  // pnl = 0.50 × 100000 × 0.1 × (1/150) = 5000 / 150 = $33.333
  // pnlPips = 0.50 / 0.01 = 50
  const rateMap = { "USD/JPY": 150.00 };
  const result = calcPnl("long", 162.00, 162.50, 0.1, "EUR/JPY", rateMap);
  assertAlmostEquals(result.pnl, 33.333, 0.01);
  assertAlmostEquals(result.pnlPips, 50, 0.001);
});

Deno.test("JPY cross: Long GBP/JPY 0.1 lot, entry 190.00, exit 189.50, USD/JPY at 150 → -$33.33", () => {
  // GBP/JPY: lotUnits=100000, pipSize=0.01
  // quoteToUSD for JPY = 1/150 = 0.006667
  // diff = 189.50 - 190.00 = -0.50 (50 pip loss)
  // pnl = -0.50 × 100000 × 0.1 × (1/150) = -5000 / 150 = -$33.333
  // pnlPips = -0.50 / 0.01 = -50
  const rateMap = { "USD/JPY": 150.00 };
  const result = calcPnl("long", 190.00, 189.50, 0.1, "GBP/JPY", rateMap);
  assertAlmostEquals(result.pnl, -33.333, 0.01);
  assertAlmostEquals(result.pnlPips, -50, 0.001);
});

Deno.test("JPY cross: Same EUR/JPY trade with USD/JPY at 100 → $50.00 (rate-map sensitivity)", () => {
  // quoteToUSD for JPY = 1/100 = 0.01
  // diff = 162.50 - 162.00 = 0.50
  // pnl = 0.50 × 100000 × 0.1 × (1/100) = 5000 / 100 = $50.00
  const rateMap = { "USD/JPY": 100.00 };
  const result = calcPnl("long", 162.00, 162.50, 0.1, "EUR/JPY", rateMap);
  assertAlmostEquals(result.pnl, 50.00, 0.01);
  assertAlmostEquals(result.pnlPips, 50, 0.001);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 4: Other crosses (GBP, AUD, NZD, CAD, CHF quotes)
// ═══════════════════════════════════════════════════════════════════════

Deno.test("GBP cross: Long EUR/GBP 0.1 lot, 25 pip win, GBP/USD at 1.2700 → $31.75", () => {
  // EUR/GBP: lotUnits=100000, pipSize=0.0001
  // quoteToUSD for GBP = GBPUSD = 1.27 (invert: false)
  // 25 pips = 25 × 0.0001 = 0.0025
  // diff = 0.0025
  // pnl = 0.0025 × 100000 × 0.1 × 1.27 = 25 × 1.27 = $31.75
  // pnlPips = 0.0025 / 0.0001 = 25
  const rateMap = { "GBP/USD": 1.2700 };
  const result = calcPnl("long", 0.8500, 0.8525, 0.1, "EUR/GBP", rateMap);
  assertAlmostEquals(result.pnl, 31.75, 0.01);
  assertAlmostEquals(result.pnlPips, 25, 0.001);
});

Deno.test("GBP cross: Same EUR/GBP trade with GBP/USD at 1.0000 → $25.00", () => {
  // quoteToUSD for GBP = 1.00
  // pnl = 0.0025 × 100000 × 0.1 × 1.00 = $25.00
  const rateMap = { "GBP/USD": 1.0000 };
  const result = calcPnl("long", 0.8500, 0.8525, 0.1, "EUR/GBP", rateMap);
  assertAlmostEquals(result.pnl, 25.00, 0.01);
  assertAlmostEquals(result.pnlPips, 25, 0.001);
});

Deno.test("AUD cross: Long EUR/AUD 0.1 lot, 30 pip win, AUD/USD at 0.6500 → $19.50", () => {
  // EUR/AUD: lotUnits=100000, pipSize=0.0001
  // quoteToUSD for AUD = AUDUSD = 0.65 (invert: false)
  // 30 pips = 30 × 0.0001 = 0.0030
  // pnl = 0.0030 × 100000 × 0.1 × 0.65 = 30 × 0.65 = $19.50
  const rateMap = { "AUD/USD": 0.6500 };
  const result = calcPnl("long", 1.6500, 1.6530, 0.1, "EUR/AUD", rateMap);
  assertAlmostEquals(result.pnl, 19.50, 0.01);
  assertAlmostEquals(result.pnlPips, 30, 0.001);
});

Deno.test("CAD cross: Short EUR/CAD 0.1 lot, 40 pip win, USD/CAD at 1.3600 → $29.41", () => {
  // EUR/CAD: lotUnits=100000, pipSize=0.0001
  // quoteToUSD for CAD = 1/USDCAD = 1/1.36 = 0.73529
  // Short: diff = entry - current = 40 pips = 0.0040
  // pnl = 0.0040 × 100000 × 0.1 × (1/1.36) = 40 / 1.36 = $29.412
  const rateMap = { "USD/CAD": 1.3600 };
  const result = calcPnl("short", 1.4800, 1.4760, 0.1, "EUR/CAD", rateMap);
  assertAlmostEquals(result.pnl, 29.412, 0.01);
  assertAlmostEquals(result.pnlPips, 40, 0.001);
});

Deno.test("CHF cross: Long EUR/CHF 0.1 lot, 20 pip win, USD/CHF at 0.8800 → $22.73", () => {
  // EUR/CHF: lotUnits=100000, pipSize=0.0001
  // quoteToUSD for CHF = 1/USDCHF = 1/0.88 = 1.13636
  // 20 pips = 0.0020
  // pnl = 0.0020 × 100000 × 0.1 × (1/0.88) = 20 / 0.88 = $22.727
  const rateMap = { "USD/CHF": 0.8800 };
  const result = calcPnl("long", 0.9700, 0.9720, 0.1, "EUR/CHF", rateMap);
  assertAlmostEquals(result.pnl, 22.727, 0.01);
  assertAlmostEquals(result.pnlPips, 20, 0.001);
});

Deno.test("NZD cross: Long EUR/NZD 0.1 lot, 35 pip win, NZD/USD at 0.6000 → $21.00", () => {
  // EUR/NZD: lotUnits=100000, pipSize=0.0001 (assumed from SPECS)
  // quoteToUSD for NZD = NZDUSD = 0.60 (invert: false)
  // 35 pips = 0.0035
  // pnl = 0.0035 × 100000 × 0.1 × 0.60 = 35 × 0.60 = $21.00
  const rateMap = { "NZD/USD": 0.6000 };
  const result = calcPnl("long", 1.7800, 1.7835, 0.1, "EUR/NZD", rateMap);
  assertAlmostEquals(result.pnl, 21.00, 0.01);
  assertAlmostEquals(result.pnlPips, 35, 0.001);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 5: Edge cases
// ═══════════════════════════════════════════════════════════════════════

Deno.test("Edge: btRateMap missing required rate → falls back to quoteToUSD=1.0", () => {
  // When rateMap doesn't have the needed pair, getQuoteToUSDRate returns 1.0
  // This is documented "safe fallback" behavior
  const rateMap = {}; // empty — no USD/JPY
  const result = calcPnl("long", 150.00, 150.50, 0.1, "USD/JPY", rateMap);
  // With fallback quoteToUSD=1.0: pnl = 0.50 × 100000 × 0.1 × 1.0 = $5000 (WRONG but safe)
  // This proves the fallback behavior — it doesn't crash
  assertAlmostEquals(result.pnl, 5000.00, 0.001);
  assertAlmostEquals(result.pnlPips, 50, 0.001);
});

Deno.test("Edge: btRateMap is undefined → falls back to quoteToUSD=1.0", () => {
  // No rateMap at all — legacy behavior
  const result = calcPnl("long", 162.00, 162.50, 0.1, "EUR/JPY");
  // Without rateMap: quoteToUSD=1.0 (legacy)
  // pnl = 0.50 × 100000 × 0.1 × 1.0 = $5000 (uncorrected)
  assertAlmostEquals(result.pnl, 5000.00, 0.001);
});

Deno.test("Edge: Zero pip movement → exactly $0.00", () => {
  const rateMap = { "USD/JPY": 150.00 };
  const result = calcPnl("long", 150.00, 150.00, 0.1, "USD/JPY", rateMap);
  assertEquals(result.pnl, 0);
  assertEquals(result.pnlPips, 0);
});

Deno.test("Edge: Zero pip movement EUR/USD → exactly $0.00", () => {
  const result = calcPnl("long", 1.0800, 1.0800, 1.0, "EUR/USD");
  assertEquals(result.pnl, 0);
  assertEquals(result.pnlPips, 0);
});

Deno.test("Edge: 1-pip USD/JPY at price 150 → $0.6667 per lot", () => {
  // 1 pip = 0.01 for JPY pairs
  // diff = 0.01
  // pnl per lot (size=1) = 0.01 × 100000 × 1.0 × (1/150) = 1000/150 = $6.6667
  // pnl per 0.1 lot = $0.6667
  const rateMap = { "USD/JPY": 150.00 };
  const result = calcPnl("long", 150.00, 150.01, 0.1, "USD/JPY", rateMap);
  assertAlmostEquals(result.pnl, 0.6667, 0.001);
  assertAlmostEquals(result.pnlPips, 1, 0.001);
});

Deno.test("Edge: Rate map with zero rate → falls back to 1.0", () => {
  const rateMap = { "USD/JPY": 0 }; // invalid zero rate
  const result = calcPnl("long", 150.00, 150.50, 0.1, "USD/JPY", rateMap);
  // Fallback: quoteToUSD=1.0
  assertAlmostEquals(result.pnl, 5000.00, 0.001);
});

Deno.test("Edge: Rate map with negative rate → falls back to 1.0", () => {
  const rateMap = { "USD/JPY": -150.00 }; // invalid negative rate
  const result = calcPnl("long", 150.00, 150.50, 0.1, "USD/JPY", rateMap);
  // Fallback: quoteToUSD=1.0
  assertAlmostEquals(result.pnl, 5000.00, 0.001);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 6: getQuoteToUSDRate unit tests
// ═══════════════════════════════════════════════════════════════════════

Deno.test("getQuoteToUSDRate: EUR/USD → 1.0 (quote is USD)", () => {
  const rate = getQuoteToUSDRate("EUR/USD", { "GBP/USD": 1.27 });
  assertEquals(rate, 1.0);
});

Deno.test("getQuoteToUSDRate: USD/JPY with rate 150 → 1/150", () => {
  const rate = getQuoteToUSDRate("USD/JPY", { "USD/JPY": 150.00 });
  assertAlmostEquals(rate, 1 / 150, 0.00001);
});

Deno.test("getQuoteToUSDRate: EUR/GBP with GBP/USD 1.27 → 1.27", () => {
  const rate = getQuoteToUSDRate("EUR/GBP", { "GBP/USD": 1.2700 });
  assertAlmostEquals(rate, 1.27, 0.00001);
});

Deno.test("getQuoteToUSDRate: EUR/AUD with AUD/USD 0.65 → 0.65", () => {
  const rate = getQuoteToUSDRate("EUR/AUD", { "AUD/USD": 0.6500 });
  assertAlmostEquals(rate, 0.65, 0.00001);
});

Deno.test("getQuoteToUSDRate: EUR/NZD with NZD/USD 0.60 → 0.60", () => {
  const rate = getQuoteToUSDRate("EUR/NZD", { "NZD/USD": 0.6000 });
  assertAlmostEquals(rate, 0.60, 0.00001);
});

Deno.test("getQuoteToUSDRate: EUR/CAD with USD/CAD 1.36 → 1/1.36", () => {
  const rate = getQuoteToUSDRate("EUR/CAD", { "USD/CAD": 1.3600 });
  assertAlmostEquals(rate, 1 / 1.36, 0.00001);
});

Deno.test("getQuoteToUSDRate: EUR/CHF with USD/CHF 0.88 → 1/0.88", () => {
  const rate = getQuoteToUSDRate("EUR/CHF", { "USD/CHF": 0.8800 });
  assertAlmostEquals(rate, 1 / 0.88, 0.00001);
});

Deno.test("getQuoteToUSDRate: Non-forex (US30) → 1.0", () => {
  const rate = getQuoteToUSDRate("US30", { "USD/JPY": 150 });
  assertEquals(rate, 1.0);
});

Deno.test("getQuoteToUSDRate: No rateMap → 1.0", () => {
  const rate = getQuoteToUSDRate("EUR/JPY");
  assertEquals(rate, 1.0);
});

Deno.test("getQuoteToUSDRate: Unknown quote currency → 1.0", () => {
  // Hypothetical pair with unknown quote
  const rate = getQuoteToUSDRate("EUR/XYZ", { "USD/JPY": 150 });
  assertEquals(rate, 1.0);
});
