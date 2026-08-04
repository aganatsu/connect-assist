/**
 * gate6Heat.test.ts — Gate 6 portfolio heat quoteToUSD regression tests
 * ──────────────────────────────────────────────────────────────────────
 * Verifies that Gate 6 converts per-position risk to USD before dividing
 * by the USD-denominated balance.
 *
 * The Gate 6 formula (after fix):
 *   riskPerUnit = |entry - SL| × lotUnits × size × quoteToUSD
 *   totalRiskPercent = (Σ riskPerUnit / balance) × 100
 *
 * quoteToUSD for each quote currency (using FALLBACK_RATES):
 *   USD → 1.0
 *   JPY → 1 / 142.0 ≈ 0.0070423
 *   CHF → 1 / 0.88 ≈ 1.13636
 *   CAD → 1 / 1.36 ≈ 0.73529
 *   GBP → 1.27
 *   AUD → 0.66
 *   NZD → 0.61
 *
 * All lotUnits = 100000 for forex pairs.
 *
 * Run: deno test --allow-all --no-check supabase/functions/bot-scanner/gate6Heat.test.ts
 */
import {
  getQuoteToUSDRate,
  SPECS,
} from "../_shared/smcAnalysis.ts";
import {
  assertEquals,
  assertAlmostEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readFileSync } from "node:fs";

// ─── Read the Gate 6 source to verify the fix is present ─────────────
const scannerSource = readFileSync(
  new URL("../bot-scanner/index.ts", import.meta.url).pathname,
  "utf-8",
);

// ─── FALLBACK_RATES (must match bot-scanner/index.ts lines 546-553) ──
const FALLBACK_RATES: Record<string, number> = {
  "USD/JPY": 142.0,
  "GBP/USD": 1.27,
  "AUD/USD": 0.66,
  "NZD/USD": 0.61,
  "USD/CAD": 1.36,
  "USD/CHF": 0.88,
};

// ─── Local getQuoteToUSDRate using fallback rates (mirrors bot-scanner) ──
function localQuoteToUSD(symbol: string): number {
  const spec = SPECS[symbol] || SPECS["EUR/USD"];
  if (spec.type !== "forex") return 1.0;
  const parts = symbol.split("/");
  if (parts.length !== 2) return 1.0;
  const quote = parts[1];
  if (quote === "USD") return 1.0;
  const QUOTE_CONVERSION: Record<string, { pair: string; invert: boolean }> = {
    "JPY": { pair: "USD/JPY", invert: true },
    "GBP": { pair: "GBP/USD", invert: false },
    "AUD": { pair: "AUD/USD", invert: false },
    "NZD": { pair: "NZD/USD", invert: false },
    "CAD": { pair: "USD/CAD", invert: true },
    "CHF": { pair: "USD/CHF", invert: true },
  };
  const conv = QUOTE_CONVERSION[quote];
  if (!conv) return 1.0;
  const rate = FALLBACK_RATES[conv.pair];
  if (!rate || rate <= 0) return 1.0;
  return conv.invert ? (1 / rate) : rate;
}

/**
 * Compute Gate 6 heat using the FIXED formula.
 * This mirrors the fixed code at lines 964-968 of bot-scanner/index.ts.
 */
function computeHeatFixed(
  balance: number,
  positions: Array<{ symbol: string; entry: number; sl: number; size: number }>,
  riskPerTrade: number,
): number {
  let totalRiskDollars = 0;
  for (const p of positions) {
    const spec = SPECS[p.symbol] || SPECS["EUR/USD"];
    if (p.sl > 0 && p.entry > 0) {
      const quoteToUSD = localQuoteToUSD(p.symbol);
      const riskPerUnit = Math.abs(p.entry - p.sl) * spec.lotUnits * p.size * quoteToUSD;
      totalRiskDollars += riskPerUnit;
    } else {
      totalRiskDollars += balance * (riskPerTrade / 100);
    }
  }
  return balance > 0 ? (totalRiskDollars / balance) * 100 : 0;
}

/**
 * Compute Gate 6 heat using the OLD BUGGY formula (no quoteToUSD).
 * This is what the code did before the fix.
 */
function computeHeatOld(
  balance: number,
  positions: Array<{ symbol: string; entry: number; sl: number; size: number }>,
  riskPerTrade: number,
): number {
  let totalRiskDollars = 0;
  for (const p of positions) {
    const spec = SPECS[p.symbol] || SPECS["EUR/USD"];
    if (p.sl > 0 && p.entry > 0) {
      const riskPerUnit = Math.abs(p.entry - p.sl) * spec.lotUnits * p.size;
      totalRiskDollars += riskPerUnit;
    } else {
      totalRiskDollars += balance * (riskPerTrade / 100);
    }
  }
  return balance > 0 ? (totalRiskDollars / balance) * 100 : 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STRUCTURAL: Verify the fix exists in the source code
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Gate 6 source contains quoteToUSD conversion", () => {
  // The fixed code should have getQuoteToUSDRate inside the Gate 6 loop
  const gate6Block = scannerSource.match(
    /Gate 6: Portfolio heat[\s\S]*?Gate 7/,
  );
  assert(gate6Block, "Gate 6 block not found in scanner source");
  const block = gate6Block![0];
  assert(
    block.includes("getQuoteToUSDRate(p.symbol, rateMap)"),
    "Gate 6 must call getQuoteToUSDRate(p.symbol, rateMap) for each position",
  );
  assert(
    block.includes("* quoteToUSD"),
    "riskPerUnit must multiply by quoteToUSD",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// TEST 1: USD-quoted pair (EUR/USD) — heat unchanged from old behavior
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Test 1: EUR/USD (USD-quoted) — heat identical to old code", () => {
  /**
   * Hand computation:
   *   Balance: $10,000
   *   EUR/USD: entry 1.0850, SL 1.0820, size 0.5 lots
   *   SL distance: |1.0850 - 1.0820| = 0.0030
   *   lotUnits: 100,000
   *   quoteToUSD: 1.0 (quote is USD)
   *
   *   riskPerUnit = 0.0030 × 100,000 × 0.5 × 1.0 = 150.00 USD
   *   heat = (150 / 10,000) × 100 = 1.5%
   *
   *   Old code (no conversion): same result because quoteToUSD = 1.0
   */
  const balance = 10_000;
  const positions = [
    { symbol: "EUR/USD", entry: 1.0850, sl: 1.0820, size: 0.5 },
  ];

  const heatFixed = computeHeatFixed(balance, positions, 1);
  const heatOld = computeHeatOld(balance, positions, 1);

  assertAlmostEquals(heatFixed, 1.5, 0.01, "Fixed heat should be 1.5%");
  assertAlmostEquals(heatOld, 1.5, 0.01, "Old heat should also be 1.5%");
  assertAlmostEquals(heatFixed, heatOld, 0.001, "USD-quoted: old and new must match");
});

// ═══════════════════════════════════════════════════════════════════════
// TEST 2: JPY-quoted pair (CAD/JPY) — the critical fix
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Test 2: CAD/JPY (JPY-quoted) — old inflated ~143x, new correct", () => {
  /**
   * Hand computation:
   *   Balance: $10,000
   *   CAD/JPY: entry 110.00, SL 110.30, size 0.5 lots
   *   SL distance: |110.00 - 110.30| = 0.30
   *   lotUnits: 100,000
   *   quoteToUSD (JPY): 1 / 142.0 = 0.00704225...
   *
   *   FIXED riskPerUnit = 0.30 × 100,000 × 0.5 × 0.00704225 = 105.63 USD
   *   FIXED heat = (105.63 / 10,000) × 100 = 1.056%
   *
   *   OLD (buggy) riskPerUnit = 0.30 × 100,000 × 0.5 = 15,000 (JPY, not USD!)
   *   OLD heat = (15,000 / 10,000) × 100 = 150.0% (WRONG)
   */
  const balance = 10_000;
  const positions = [
    { symbol: "CAD/JPY", entry: 110.00, sl: 110.30, size: 0.5 },
  ];

  const heatFixed = computeHeatFixed(balance, positions, 1);
  const heatOld = computeHeatOld(balance, positions, 1);

  // Fixed: ~1.056%
  assertAlmostEquals(heatFixed, 1.056, 0.01, "Fixed CAD/JPY heat should be ~1.056%");
  // Old: 150% (wildly inflated)
  assertAlmostEquals(heatOld, 150.0, 0.1, "Old CAD/JPY heat was 150% (buggy)");
  // The old code inflated by ~142x (the USD/JPY rate)
  assert(heatOld / heatFixed > 140, "Old code inflated JPY heat by ~142x");
});

// ═══════════════════════════════════════════════════════════════════════
// TEST 3: CHF-quoted pair (USD/CHF) — small but nonzero correction
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Test 3: USD/CHF (CHF-quoted) — modest correction", () => {
  /**
   * Hand computation:
   *   Balance: $10,000
   *   USD/CHF: entry 0.8850, SL 0.8820, size 0.5 lots
   *   SL distance: |0.8850 - 0.8820| = 0.0030
   *   lotUnits: 100,000
   *   quoteToUSD (CHF): 1 / 0.88 = 1.13636...
   *
   *   FIXED riskPerUnit = 0.0030 × 100,000 × 0.5 × 1.13636 = 170.45 USD
   *   FIXED heat = (170.45 / 10,000) × 100 = 1.705%
   *
   *   OLD riskPerUnit = 0.0030 × 100,000 × 0.5 = 150.00 (CHF, not USD)
   *   OLD heat = (150 / 10,000) × 100 = 1.5%
   *
   *   CHF is worth more than USD, so old code UNDER-counted risk by ~0.88x.
   *   The correction is modest: 1.5% → 1.705% (13.6% increase).
   */
  const balance = 10_000;
  const positions = [
    { symbol: "USD/CHF", entry: 0.8850, sl: 0.8820, size: 0.5 },
  ];

  const heatFixed = computeHeatFixed(balance, positions, 1);
  const heatOld = computeHeatOld(balance, positions, 1);

  assertAlmostEquals(heatFixed, 1.7045, 0.01, "Fixed USD/CHF heat should be ~1.705%");
  assertAlmostEquals(heatOld, 1.5, 0.01, "Old USD/CHF heat was 1.5% (CHF, not USD)");
  // CHF > USD, so old code under-counted. Ratio should be ~0.88
  const ratio = heatOld / heatFixed;
  assertAlmostEquals(ratio, 0.88, 0.01, "Old/new ratio should be ~0.88 (the USD/CHF rate)");
});

// ═══════════════════════════════════════════════════════════════════════
// TEST 4: Mixed positions (EUR/USD + CAD/JPY) — totals are sane
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Test 4: Mixed EUR/USD + CAD/JPY — total = sum of individual heats", () => {
  /**
   * Hand computation:
   *   Balance: $10,000
   *
   *   Position 1: EUR/USD entry 1.0850, SL 1.0820, size 0.5
   *     risk = 0.0030 × 100,000 × 0.5 × 1.0 = $150.00
   *
   *   Position 2: CAD/JPY entry 110.00, SL 110.30, size 0.5
   *     risk = 0.30 × 100,000 × 0.5 × (1/142) = $105.63
   *
   *   Total risk = $150.00 + $105.63 = $255.63
   *   Total heat = (255.63 / 10,000) × 100 = 2.556%
   *
   *   OLD total risk = $150.00 + ¥15,000 = $15,150 (mixed units!)
   *   OLD heat = 151.5% (nonsensical)
   */
  const balance = 10_000;
  const positions = [
    { symbol: "EUR/USD", entry: 1.0850, sl: 1.0820, size: 0.5 },
    { symbol: "CAD/JPY", entry: 110.00, sl: 110.30, size: 0.5 },
  ];

  const heatFixed = computeHeatFixed(balance, positions, 1);

  // Individual heats from Tests 1 and 2
  const eurusdHeat = computeHeatFixed(balance, [positions[0]], 1);
  const cadjpyHeat = computeHeatFixed(balance, [positions[1]], 1);

  assertAlmostEquals(heatFixed, eurusdHeat + cadjpyHeat, 0.01,
    "Total heat must equal sum of individual position heats");
  assertAlmostEquals(heatFixed, 2.556, 0.02, "Combined heat should be ~2.556%");

  // Old code would produce ~151.5%
  const heatOld = computeHeatOld(balance, positions, 1);
  assert(heatOld > 150, "Old code produced >150% for this mix (nonsensical)");
});

// ═══════════════════════════════════════════════════════════════════════
// TEST 5: Position with missing SL (fallback branch)
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Test 5: Missing SL — fallback uses balance × riskPerTrade (already USD)", () => {
  /**
   * Hand computation:
   *   Balance: $10,000
   *   riskPerTrade: 1%
   *   Position: CAD/JPY entry 110.00, SL 0 (missing), size 0.5
   *
   *   Fallback: totalRiskDollars += balance × (riskPerTrade / 100)
   *           = 10,000 × 0.01 = $100.00
   *   heat = (100 / 10,000) × 100 = 1.0%
   *
   *   The fallback branch computes: balance × (riskPerTrade / 100).
   *   Since balance is in USD and riskPerTrade is a percentage,
   *   the result is already in USD — no quoteToUSD needed.
   *
   *   Both old and new code produce the same result for this branch.
   */
  const balance = 10_000;
  const riskPerTrade = 1;
  const positions = [
    { symbol: "CAD/JPY", entry: 110.00, sl: 0, size: 0.5 },
  ];

  const heatFixed = computeHeatFixed(balance, positions, riskPerTrade);
  const heatOld = computeHeatOld(balance, positions, riskPerTrade);

  assertAlmostEquals(heatFixed, 1.0, 0.001, "Fallback heat should be 1.0%");
  assertAlmostEquals(heatOld, 1.0, 0.001, "Old fallback heat should also be 1.0%");
  assertAlmostEquals(heatFixed, heatOld, 0.001,
    "Fallback branch: old and new must match (already in USD)");
});
