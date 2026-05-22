/**
 * Tests for the market order look-ahead bias fix.
 *
 * Verifies:
 * 1. Market orders use analysis.lastPrice (current price), NOT zone refinedEntry
 * 2. SL sanity guard rejects trades where entry is already past the SL
 *
 * These tests simulate the logic extracted from bot-scanner/index.ts lines 4694-4712.
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ─── Extracted logic under test ───────────────────────────────────────────────

/**
 * Determines the market entry price for a paper trade.
 * After the fix: ALWAYS uses lastPrice (current market price).
 * Before the fix: used zone refinedEntry or zone midpoint (look-ahead bias).
 */
function getMarketEntryPrice(analysis: { lastPrice: number }): number {
  // FIX: Market orders ALWAYS fill at current price
  return analysis.lastPrice;
}

/**
 * SL sanity guard: rejects trades where the entry price is already past the SL.
 * Returns true if the trade should be REJECTED.
 */
function slSanityCheck(
  direction: "long" | "short",
  entryPrice: number,
  sl: number,
): boolean {
  if (direction === "long") {
    return entryPrice <= sl; // For longs, entry below SL makes no sense
  } else {
    return entryPrice >= sl; // For shorts, entry above SL makes no sense
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test("Market entry uses lastPrice, not zone refinedEntry", () => {
  const analysis = { lastPrice: 4545.0 };
  const zoneRefinedEntry = 4542.507; // The old buggy value

  const entryPrice = getMarketEntryPrice(analysis);

  assertEquals(entryPrice, 4545.0, "Market entry must be current price");
  assert(entryPrice !== zoneRefinedEntry, "Must NOT use zone refined entry for market orders");
});

Deno.test("Market entry uses lastPrice even when zone data is available", () => {
  const analysis = { lastPrice: 1.16114 };
  const izData = {
    bestZone: {
      refinedEntry: 1.16554,
      high: 1.16586,
      low: 1.16409,
    },
  };

  const entryPrice = getMarketEntryPrice(analysis);

  assertEquals(entryPrice, 1.16114, "Must use lastPrice regardless of zone data");
  assert(entryPrice !== izData.bestZone.refinedEntry, "Must NOT use refinedEntry");
  assert(entryPrice !== (izData.bestZone.high + izData.bestZone.low) / 2, "Must NOT use zone midpoint");
});

Deno.test("SL sanity guard: short with entry above SL is rejected", () => {
  // Scenario from the user's bug report:
  // Short trade, entry at current price 4545, SL at 4544.367
  // Entry is ABOVE SL → trade is already a loser
  const failed = slSanityCheck("short", 4545.0, 4544.367);
  assertEquals(failed, true, "Short with entry >= SL must be rejected");
});

Deno.test("SL sanity guard: short with entry below SL is accepted", () => {
  // Normal short: entry at 4542, SL at 4544 (SL is above entry)
  const failed = slSanityCheck("short", 4542.0, 4544.0);
  assertEquals(failed, false, "Short with entry < SL is valid");
});

Deno.test("SL sanity guard: long with entry below SL is rejected", () => {
  // Long trade, entry at 1.0500, SL at 1.0510
  // Entry is BELOW SL → trade is already a loser
  const failed = slSanityCheck("long", 1.0500, 1.0510);
  assertEquals(failed, true, "Long with entry <= SL must be rejected");
});

Deno.test("SL sanity guard: long with entry above SL is accepted", () => {
  // Normal long: entry at 1.0520, SL at 1.0500 (SL is below entry)
  const failed = slSanityCheck("long", 1.0520, 1.0500);
  assertEquals(failed, false, "Long with entry > SL is valid");
});

Deno.test("SL sanity guard: entry exactly at SL is rejected for both directions", () => {
  // Edge case: entry equals SL (zero risk distance = invalid)
  const longFailed = slSanityCheck("long", 1.0500, 1.0500);
  const shortFailed = slSanityCheck("short", 1.0500, 1.0500);
  assertEquals(longFailed, true, "Long with entry == SL must be rejected");
  assertEquals(shortFailed, true, "Short with entry == SL must be rejected");
});

Deno.test("Regression: old code would have used zone price, new code uses lastPrice", () => {
  // This test documents the exact scenario from the user's XAU/USD trade:
  // Zone: 4537.294 – 4551.136
  // Refined entry: 4542.507
  // Last price: ~4545 (above the refined entry)
  // Old behavior: entry = 4542.507 (look-ahead, free profit)
  // New behavior: entry = 4545.0 (actual market price)

  const analysis = { lastPrice: 4545.0 };
  const sl = 4544.367; // SL from the original trade

  const entryPrice = getMarketEntryPrice(analysis);

  // With the real price (4545), this short has entry ABOVE SL (4544.367)
  // → SL sanity guard catches it
  const sanityFailed = slSanityCheck("short", entryPrice, sl);
  assertEquals(sanityFailed, true,
    "The original XAU/USD trade would be correctly rejected: entry 4545 > SL 4544.367 for a short");
});
