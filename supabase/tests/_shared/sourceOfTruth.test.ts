/**
 * sourceOfTruth.test.ts — Tests for Workstream B: source-of-truth consolidation
 * ────────────────────────────────────────────────────────────────────────────────
 * Tests:
 * 1. normalizeSymKey is exported and works correctly
 * 2. MIN_SL_PIPS is exported and has expected values
 * 3. ATR_SL_FLOOR_MULTIPLIER is exported
 * 4. calculatePositionSize is exported from shared
 * 5. getQuoteToUSDRate is exported from shared
 * 6. FALLBACK_RATES is exported from shared
 *
 * Run: deno test --allow-all supabase/functions/_shared/sourceOfTruth.test.ts
 */

import {
  normalizeSymKey,
  MIN_SL_PIPS,
  ATR_SL_FLOOR_MULTIPLIER,
  FALLBACK_RATES,
  calculatePositionSize,
  getQuoteToUSDRate,
  SPECS,
} from "./smcAnalysis.ts";
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1: normalizeSymKey
// ═══════════════════════════════════════════════════════════════════════

Deno.test("normalizeSymKey: EUR/USD → EURUSD", () => {
  assertEquals(normalizeSymKey("EUR/USD"), "EURUSD");
});

Deno.test("normalizeSymKey: eur_usd → EURUSD", () => {
  assertEquals(normalizeSymKey("eur_usd"), "EURUSD");
});

Deno.test("normalizeSymKey: Eur.Usd → EURUSD", () => {
  assertEquals(normalizeSymKey("Eur.Usd"), "EURUSD");
});

Deno.test("normalizeSymKey: EUR-USD → EURUSD", () => {
  assertEquals(normalizeSymKey("EUR-USD"), "EURUSD");
});

Deno.test("normalizeSymKey: ' EUR / USD ' → EURUSD (trims whitespace)", () => {
  assertEquals(normalizeSymKey(" EUR / USD "), "EURUSD");
});

Deno.test("normalizeSymKey: empty string → empty string", () => {
  assertEquals(normalizeSymKey(""), "");
});

Deno.test("normalizeSymKey: US30 → US30 (no separators)", () => {
  assertEquals(normalizeSymKey("US30"), "US30");
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: MIN_SL_PIPS exported correctly
// ═══════════════════════════════════════════════════════════════════════

Deno.test("MIN_SL_PIPS: EUR/USD has expected floor", () => {
  assert(MIN_SL_PIPS["EUR/USD"] != null, "EUR/USD should be in MIN_SL_PIPS");
  assert(MIN_SL_PIPS["EUR/USD"] >= 5, "EUR/USD min SL should be at least 5 pips");
  assert(MIN_SL_PIPS["EUR/USD"] <= 30, "EUR/USD min SL should be at most 30 pips");
});

Deno.test("MIN_SL_PIPS: XAU/USD has expected floor", () => {
  assert(MIN_SL_PIPS["XAU/USD"] != null, "XAU/USD should be in MIN_SL_PIPS");
  assert(MIN_SL_PIPS["XAU/USD"] >= 30, "XAU/USD min SL should be at least 30 pips");
});

Deno.test("MIN_SL_PIPS: JPY pairs have expected floor", () => {
  assert(MIN_SL_PIPS["USD/JPY"] != null, "USD/JPY should be in MIN_SL_PIPS");
  assert(MIN_SL_PIPS["USD/JPY"] >= 5, "USD/JPY min SL should be at least 5 pips");
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3: ATR_SL_FLOOR_MULTIPLIER exported correctly
// ═══════════════════════════════════════════════════════════════════════

Deno.test("ATR_SL_FLOOR_MULTIPLIER: is a positive number", () => {
  assert(typeof ATR_SL_FLOOR_MULTIPLIER === "number", "Should be a number");
  assert(ATR_SL_FLOOR_MULTIPLIER > 0, "Should be positive");
  assert(ATR_SL_FLOOR_MULTIPLIER <= 5, "Should be reasonable (<=5)");
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 4: FALLBACK_RATES exported correctly
// ═══════════════════════════════════════════════════════════════════════

Deno.test("FALLBACK_RATES: contains USD/JPY", () => {
  assert(FALLBACK_RATES["USD/JPY"] != null, "Should have USD/JPY");
  assert(FALLBACK_RATES["USD/JPY"] > 100, "USD/JPY should be > 100");
});

Deno.test("FALLBACK_RATES: contains GBP/USD", () => {
  assert(FALLBACK_RATES["GBP/USD"] != null, "Should have GBP/USD");
  assert(FALLBACK_RATES["GBP/USD"] > 1.0, "GBP/USD should be > 1.0");
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 5: calculatePositionSize exported correctly
// ═══════════════════════════════════════════════════════════════════════

Deno.test("calculatePositionSize: returns valid lot size for EUR/USD", () => {
  // Signature: balance, riskPercent, entryPrice, stopLoss, symbol
  const result = calculatePositionSize(
    10000,      // balance
    0.01,       // riskPct (1%)
    1.1000,     // entryPrice
    1.0980,     // stopLoss (20 pips away)
    "EUR/USD",  // symbol
  );
  assert(typeof result === "number", "Should return a number");
  assert(result > 0, "Should be positive");
  assert(result <= 1.0, "Should be reasonable for $10k account with 20 pip SL");
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 6: getQuoteToUSDRate exported correctly
// ═══════════════════════════════════════════════════════════════════════

Deno.test("getQuoteToUSDRate: EUR/USD → 1.0 (quote is USD)", () => {
  const rate = getQuoteToUSDRate("EUR/USD", { "GBP/USD": 1.27 });
  assertEquals(rate, 1.0);
});

Deno.test("getQuoteToUSDRate: USD/JPY with rate → 1/rate", () => {
  const rate = getQuoteToUSDRate("USD/JPY", { "USD/JPY": 150.0 });
  const expected = 1 / 150.0;
  assert(Math.abs(rate - expected) < 0.0001, `Expected ~${expected}, got ${rate}`);
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 7: SPECS has the 7 new pairs
// ═══════════════════════════════════════════════════════════════════════

const NEW_PAIRS = ["AUD/CHF", "AUD/NZD", "CAD/CHF", "CHF/JPY", "NZD/CAD", "NZD/CHF", "NZD/JPY"];

Deno.test("SPECS: contains all 7 new cross pairs", () => {
  for (const pair of NEW_PAIRS) {
    assert(SPECS[pair] != null, `SPECS should contain ${pair}`);
    assert(SPECS[pair].pipSize > 0, `${pair} pipSize should be positive`);
    assert(SPECS[pair].lotUnits > 0, `${pair} lotUnits should be positive`);
  }
});
