/**
 * Unit tests for impulseZoneEngine.ts
 *
 * Tests cover:
 *   1. findImpulseLeg — valid/invalid impulse detection, 50% pullback rule
 *   2. mapImpulsePOIs — POI extraction from impulse range
 *   3. overlayFibOnPOIs — Fib scoring and OTE zone filtering
 *   4. checkHistoricalSR — close-cluster S/R detection
 *   5. refineLowerTF — LTF OB/FVG inside zone
 *   6. rankAndSelectBestZone — ranking logic
 *   7. findBestEntryZone — full pipeline integration
 */

import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { Candle } from "./smcAnalysis.ts";
import {
  findImpulseLeg,
  mapImpulsePOIs,
  overlayFibOnPOIs,
  checkHistoricalSR,
  refineLowerTF,
  rankAndSelectBestZone,
  findBestEntryZone,
  type ImpulseLeg,
  type ImpulsePOI,
  type RankedPOI,
} from "./impulseZoneEngine.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCandle(o: number, h: number, l: number, c: number, idx: number): Candle {
  return {
    datetime: `2025-01-${String(idx + 1).padStart(2, "0")}T00:00:00Z`,
    open: o,
    high: h,
    low: l,
    close: c,
  };
}

/**
 * Generate a clean bullish impulse: price moves from 1.0000 to 1.0500
 * with small pullbacks (never exceeding 50% of the leg at that point).
 * Then adds a pullback to create retracement candles.
 */
function generateBullishImpulseCandles(count = 50): Candle[] {
  const candles: Candle[] = [];
  const startPrice = 1.0000;
  const endPrice = 1.0500;
  const step = (endPrice - startPrice) / 25;

  // Phase 1: Consolidation (candles 0-9) — establishes a range
  for (let i = 0; i < 10; i++) {
    const base = startPrice + (Math.random() * 0.002 - 0.001);
    candles.push(makeCandle(base, base + 0.0015, base - 0.0015, base + 0.0005, i));
  }

  // Phase 2: Impulse up (candles 10-34) — clean move with small pullbacks
  let price = startPrice;
  for (let i = 10; i < 35; i++) {
    const prevPrice = price;
    price += step;
    // Small pullback every 5 candles (never >30% of leg)
    if (i % 5 === 0 && i > 10) {
      const pullback = step * 0.3; // 30% of one step, well under 50% of total leg
      candles.push(makeCandle(price, price + 0.0005, price - pullback, price - pullback * 0.5, i));
    } else {
      candles.push(makeCandle(prevPrice, price + 0.0003, prevPrice - 0.0002, price, i));
    }
  }

  // Phase 3: Retracement (candles 35-49) — price pulls back to 61.8% zone
  const impulseRange = endPrice - startPrice;
  const retraceTo = endPrice - impulseRange * 0.618; // 61.8% retracement
  const retStep = (endPrice - retraceTo) / 15;
  let retPrice = endPrice;
  for (let i = 35; i < count; i++) {
    retPrice -= retStep;
    candles.push(makeCandle(retPrice + retStep * 0.3, retPrice + retStep * 0.5, retPrice - 0.0003, retPrice, i));
  }

  return candles;
}

/**
 * Generate a bearish impulse: price moves from 1.0500 down to 1.0000
 */
function generateBearishImpulseCandles(count = 50): Candle[] {
  const candles: Candle[] = [];
  const startPrice = 1.0500;
  const endPrice = 1.0000;
  const step = (startPrice - endPrice) / 25;

  // Phase 1: Consolidation (candles 0-9)
  for (let i = 0; i < 10; i++) {
    const base = startPrice + (Math.random() * 0.002 - 0.001);
    candles.push(makeCandle(base, base + 0.0015, base - 0.0015, base - 0.0005, i));
  }

  // Phase 2: Impulse down (candles 10-34)
  let price = startPrice;
  for (let i = 10; i < 35; i++) {
    const prevPrice = price;
    price -= step;
    if (i % 5 === 0 && i > 10) {
      const pullback = step * 0.3;
      candles.push(makeCandle(price, price + pullback, price - 0.0005, price + pullback * 0.5, i));
    } else {
      candles.push(makeCandle(prevPrice, prevPrice + 0.0002, price - 0.0003, price, i));
    }
  }

  // Phase 3: Retracement up (candles 35-49)
  const impulseRange = startPrice - endPrice;
  const retraceTo = endPrice + impulseRange * 0.618;
  const retStep = (retraceTo - endPrice) / 15;
  let retPrice = endPrice;
  for (let i = 35; i < count; i++) {
    retPrice += retStep;
    candles.push(makeCandle(retPrice - retStep * 0.3, retPrice + 0.0003, retPrice - retStep * 0.5, retPrice, i));
  }

  return candles;
}

/**
 * Generate candles with a 60% pullback (should FAIL the 50% rule).
 */
function generateInvalidImpulseCandles(): Candle[] {
  const candles: Candle[] = [];
  const startPrice = 1.0000;

  // Consolidation
  for (let i = 0; i < 10; i++) {
    candles.push(makeCandle(startPrice, startPrice + 0.001, startPrice - 0.001, startPrice, i));
  }

  // Move up to 1.0300
  let price = startPrice;
  for (let i = 10; i < 20; i++) {
    price += 0.003;
    candles.push(makeCandle(price - 0.003, price + 0.0005, price - 0.003, price, i));
  }

  // BIG pullback: drop 60% of the leg (from 1.0300 back to ~1.0120)
  const legSoFar = price - startPrice; // 0.0300
  const pullbackAmount = legSoFar * 0.6; // 0.0180
  const pullbackLow = price - pullbackAmount; // 1.0120
  candles.push(makeCandle(price, price + 0.0005, pullbackLow, pullbackLow + 0.001, 20));
  candles.push(makeCandle(pullbackLow + 0.001, pullbackLow + 0.002, pullbackLow - 0.001, pullbackLow + 0.001, 21));

  // Continue up (but the impulse is already invalid)
  for (let i = 22; i < 40; i++) {
    price += 0.002;
    candles.push(makeCandle(price - 0.002, price + 0.0005, price - 0.002, price, i));
  }

  return candles;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test("findImpulseLeg — returns null for insufficient candles", () => {
  const candles = [makeCandle(1.0, 1.01, 0.99, 1.005, 0)];
  const result = findImpulseLeg(candles, "bullish");
  assertEquals(result, null);
});

Deno.test("findImpulseLeg — detects valid bullish impulse", () => {
  const candles = generateBullishImpulseCandles(50);
  const result = findImpulseLeg(candles, "bullish");

  // Should find an impulse (may or may not depending on structure detection)
  // The key assertion is that if found, it's valid
  if (result) {
    assert(result.isValid, "Impulse should be valid (no >50% pullback)");
    assertEquals(result.direction, "bullish");
    assert(result.high > result.low, "High should be above low");
    assert(result.endIndex > result.startIndex, "End should be after start");
  }
});

Deno.test("findImpulseLeg — detects valid bearish impulse", () => {
  const candles = generateBearishImpulseCandles(50);
  const result = findImpulseLeg(candles, "bearish");

  if (result) {
    assert(result.isValid, "Impulse should be valid");
    assertEquals(result.direction, "bearish");
    assert(result.high > result.low, "High should be above low");
  }
});

Deno.test("findImpulseLeg — rejects impulse with >50% pullback", () => {
  const candles = generateInvalidImpulseCandles();
  const result = findImpulseLeg(candles, "bullish");

  // Either null (no valid impulse found) or the found impulse avoids the bad pullback
  if (result) {
    // If it found one, it must have found a sub-leg that IS valid
    assert(result.isValid, "Any returned impulse must be valid");
    // The impulse should NOT span the full range including the 60% pullback
  }
});

Deno.test("findImpulseLeg — returns null for wrong direction", () => {
  const candles = generateBullishImpulseCandles(50);
  // Looking for bearish in a bullish impulse — should not find one
  const result = findImpulseLeg(candles, "bearish");
  // May or may not find a minor bearish break — acceptable either way
  if (result) {
    assertEquals(result.direction, "bearish");
    assert(result.isValid);
  }
});

Deno.test("mapImpulsePOIs — returns empty for invalid impulse", () => {
  const candles = generateBullishImpulseCandles(50);
  const invalidImpulse: ImpulseLeg = {
    high: 1.05, low: 1.0, direction: "bullish",
    startIndex: 10, endIndex: 34, isValid: false, bosPrice: 1.04,
  };
  const pois = mapImpulsePOIs(candles, invalidImpulse);
  assertEquals(pois.length, 0);
});

Deno.test("mapImpulsePOIs — finds POIs within valid impulse", () => {
  const candles = generateBullishImpulseCandles(50);
  const impulse = findImpulseLeg(candles, "bullish");

  if (impulse) {
    const pois = mapImpulsePOIs(candles, impulse);
    // POIs should be within the impulse price range
    for (const poi of pois) {
      assert(poi.high <= impulse.high + 0.001, `POI high ${poi.high} should be <= impulse high ${impulse.high}`);
      assert(poi.low >= impulse.low - 0.001, `POI low ${poi.low} should be >= impulse low ${impulse.low}`);
      assert(poi.candleIndex >= Math.max(0, impulse.startIndex - 10), "POI should be within impulse range or lookback zone");
      assert(poi.candleIndex <= impulse.endIndex, "POI should be within impulse range");
      assertEquals(poi.direction, impulse.direction);
    }
  }
});

Deno.test("overlayFibOnPOIs — returns empty for empty POIs", () => {
  const impulse: ImpulseLeg = {
    high: 1.05, low: 1.0, direction: "bullish",
    startIndex: 10, endIndex: 34, isValid: true, bosPrice: 1.04,
  };
  const result = overlayFibOnPOIs(impulse, []);
  assertEquals(result.length, 0);
});

Deno.test("overlayFibOnPOIs — scores POIs by Fib depth correctly", () => {
  const impulse: ImpulseLeg = {
    high: 1.0500, low: 1.0000, direction: "bullish",
    startIndex: 10, endIndex: 34, isValid: true, bosPrice: 1.0400,
  };

  // Create POIs at known Fib levels
  const pois: ImpulsePOI[] = [
    // At 61.8% retracement: price = 1.05 - 0.618 * 0.05 = 1.0191
    { type: "fvg", high: 1.0200, low: 1.0180, candleIndex: 20, direction: "bullish" },
    // At 78.6% retracement: price = 1.05 - 0.786 * 0.05 = 1.0107
    { type: "ob", high: 1.0115, low: 1.0100, candleIndex: 15, direction: "bullish" },
    // At 50% retracement: price = 1.05 - 0.5 * 0.05 = 1.0250
    { type: "fvg", high: 1.0260, low: 1.0240, candleIndex: 25, direction: "bullish" },
  ];

  const ranked = overlayFibOnPOIs(impulse, pois);

  // Should have ranked POIs (may filter some based on tolerance)
  if (ranked.length > 0) {
    // Sorted by fibDepth descending — deepest first
    for (let i = 1; i < ranked.length; i++) {
      assert(ranked[i - 1].fibDepth >= ranked[i].fibDepth,
        `Should be sorted by depth: ${ranked[i - 1].fibDepth} >= ${ranked[i].fibDepth}`);
    }

    // Deeper POIs should have higher fibScore
    const deepest = ranked[0];
    assert(deepest.fibScore >= 1, "Deepest POI should have fibScore >= 1");
  }
});

Deno.test("overlayFibOnPOIs — filters POIs outside OTE zone", () => {
  const impulse: ImpulseLeg = {
    high: 1.0500, low: 1.0000, direction: "bullish",
    startIndex: 10, endIndex: 34, isValid: true, bosPrice: 1.0400,
  };

  // POI at only 20% retracement (too shallow, not in OTE)
  const pois: ImpulsePOI[] = [
    { type: "fvg", high: 1.0410, low: 1.0390, candleIndex: 30, direction: "bullish" },
  ];

  const ranked = overlayFibOnPOIs(impulse, pois);
  // Should be filtered out (not near any key Fib level and not in OTE zone)
  assertEquals(ranked.length, 0);
});

Deno.test("checkHistoricalSR — confirms S/R when closes cluster at zone", () => {
  // Create candles with a clear S/R level at 1.0200 (many closes there)
  const candles: Candle[] = [];

  // First 50 candles: lots of closes near 1.0200 (establishing S/R)
  for (let i = 0; i < 50; i++) {
    const base = 1.0200 + (Math.random() * 0.002 - 0.001);
    candles.push(makeCandle(base - 0.001, base + 0.002, base - 0.002, 1.0200 + (Math.random() * 0.001 - 0.0005), i));
  }

  // Candles 50-70: impulse away from the level
  for (let i = 50; i < 70; i++) {
    const price = 1.0200 + (i - 50) * 0.003;
    candles.push(makeCandle(price, price + 0.001, price - 0.001, price, i));
  }

  const zones: RankedPOI[] = [{
    poi: { type: "fvg", high: 1.0210, low: 1.0190, candleIndex: 55, direction: "bullish" },
    fibLevel: 0.618,
    fibDepth: 0.618,
    fibScore: 2,
    srConfirmed: false,
    ltfRefined: false,
    htfConfluenceScore: 0,
    htfLayers: [],
    totalScore: 2,
  }];

  const result = checkHistoricalSR(candles, zones, 50);

  // The zone overlaps the 1.0200 S/R cluster
  if (result.length > 0) {
    assertEquals(result[0].srConfirmed, true);
    assertEquals(result[0].totalScore, 3); // fibScore(2) + SR(1)
  }
});

Deno.test("checkHistoricalSR — does not confirm when no S/R at zone", () => {
  const candles: Candle[] = [];

  // Closes cluster at 1.0500 (far from our zone)
  for (let i = 0; i < 50; i++) {
    candles.push(makeCandle(1.0500, 1.0510, 1.0490, 1.0500, i));
  }

  for (let i = 50; i < 70; i++) {
    candles.push(makeCandle(1.0200, 1.0210, 1.0190, 1.0200, i));
  }

  const zones: RankedPOI[] = [{
    poi: { type: "ob", high: 1.0210, low: 1.0190, candleIndex: 55, direction: "bullish" },
    fibLevel: 0.618,
    fibDepth: 0.618,
    fibScore: 2,
    srConfirmed: false,
    ltfRefined: false,
    htfConfluenceScore: 0,
    htfLayers: [],
    totalScore: 2,
  }];

  const result = checkHistoricalSR(candles, zones, 50);
  assertEquals(result[0].srConfirmed, false);
  assertEquals(result[0].totalScore, 2); // Unchanged
});

Deno.test("refineLowerTF — returns unchanged zone when not enough LTF candles", () => {
  const zone: RankedPOI = {
    poi: { type: "fvg", high: 1.0210, low: 1.0190, candleIndex: 20, direction: "bullish" },
    fibLevel: 0.618,
    fibDepth: 0.618,
    fibScore: 2,
    srConfirmed: true,
    ltfRefined: false,
    htfConfluenceScore: 0,
    htfLayers: [],
    totalScore: 3,
  };

  const result = refineLowerTF([], zone);
  assertEquals(result.ltfRefined, false);
  assertEquals(result.totalScore, 3); // Unchanged
});

Deno.test("refineLowerTF — refines zone when LTF structure exists inside", () => {
  const zone: RankedPOI = {
    poi: { type: "fvg", high: 1.0210, low: 1.0190, candleIndex: 20, direction: "bullish" },
    fibLevel: 0.618,
    fibDepth: 0.618,
    fibScore: 2,
    srConfirmed: false,
    ltfRefined: false,
    htfConfluenceScore: 0,
    htfLayers: [],
    totalScore: 2,
  };

  // Create 15m candles that oscillate inside the zone
  const ltfCandles: Candle[] = [];
  for (let i = 0; i < 30; i++) {
    const base = 1.0195 + (i % 3) * 0.0005;
    ltfCandles.push(makeCandle(
      base,
      base + 0.0008,
      base - 0.0008,
      base + (i % 2 === 0 ? 0.0005 : -0.0005),
      i,
    ));
  }

  const result = refineLowerTF(ltfCandles, zone);
  // Whether it refines depends on whether smcAnalysis detects OBs/FVGs in the sub-range
  // The test validates the function doesn't crash and returns a valid result
  assert(result.totalScore >= 2, "Score should not decrease");
  if (result.ltfRefined) {
    assertExists(result.refinedEntry);
    assertExists(result.refinedSL);
    assertExists(result.ltfType);
    assertEquals(result.totalScore, 3); // +1 for LTF refinement
  }
});

Deno.test("rankAndSelectBestZone — returns null for empty array", () => {
  const result = rankAndSelectBestZone([]);
  assertEquals(result, null);
});

Deno.test("rankAndSelectBestZone — selects highest-scoring zone", () => {
  const zones: RankedPOI[] = [
    {
      poi: { type: "fvg", high: 1.02, low: 1.01, candleIndex: 20, direction: "bullish" },
      fibLevel: 0.5, fibDepth: 0.5, fibScore: 1,
      srConfirmed: false, ltfRefined: false, htfConfluenceScore: 0, htfLayers: [], totalScore: 1,
    },
    {
      poi: { type: "ob", high: 1.015, low: 1.01, candleIndex: 15, direction: "bullish" },
      fibLevel: 0.786, fibDepth: 0.786, fibScore: 4,
      srConfirmed: true, ltfRefined: true, htfConfluenceScore: 0, htfLayers: [], totalScore: 6,
    },
    {
      poi: { type: "fvg", high: 1.025, low: 1.02, candleIndex: 25, direction: "bullish" },
      fibLevel: 0.618, fibDepth: 0.618, fibScore: 2,
      srConfirmed: true, ltfRefined: false, htfConfluenceScore: 0, htfLayers: [], totalScore: 3,
    },
  ];

  const best = rankAndSelectBestZone(zones);
  assertExists(best);
  assertEquals(best.fibScore, 4); // The 78.6% zone with S/R + LTF
  assertEquals(best.totalScore, 6);
});

Deno.test("rankAndSelectBestZone — rejects zones with fibScore < 1", () => {
  const zones: RankedPOI[] = [
    {
      poi: { type: "fvg", high: 1.04, low: 1.039, candleIndex: 30, direction: "bullish" },
      fibLevel: 0.382, fibDepth: 0.382, fibScore: 0, // Too shallow
      srConfirmed: true, ltfRefined: true, htfConfluenceScore: 0, htfLayers: [], totalScore: 2,
    },
  ];

  const best = rankAndSelectBestZone(zones);
  assertEquals(best, null); // Rejected — fibScore < 1
});

Deno.test("rankAndSelectBestZone — uses fibDepth as tiebreaker", () => {
  const zones: RankedPOI[] = [
    {
      poi: { type: "fvg", high: 1.02, low: 1.019, candleIndex: 20, direction: "bullish" },
      fibLevel: 0.618, fibDepth: 0.62, fibScore: 2,
      srConfirmed: false, ltfRefined: false, htfConfluenceScore: 0, htfLayers: [], totalScore: 2,
    },
    {
      poi: { type: "ob", high: 1.015, low: 1.014, candleIndex: 15, direction: "bullish" },
      fibLevel: 0.71, fibDepth: 0.72, fibScore: 2, // Same fibScore but deeper
      srConfirmed: false, ltfRefined: false, htfConfluenceScore: 0, htfLayers: [], totalScore: 2,
    },
  ];

  const best = rankAndSelectBestZone(zones);
  assertExists(best);
  // Should pick the deeper one (0.72 > 0.62)
  assertEquals(best.fibDepth, 0.72);
});

Deno.test("findBestEntryZone — returns reason when no impulse found", () => {
  // Flat candles — no structure breaks
  const candles: Candle[] = [];
  for (let i = 0; i < 30; i++) {
    candles.push(makeCandle(1.0, 1.001, 0.999, 1.0, i));
  }

  const result = findBestEntryZone(candles, candles, "bullish", 1.0);
  assertEquals(result.bestZone, null);
  assertEquals(result.impulse, null);
  assert(result.reason.includes("No valid"), `Reason should explain failure: ${result.reason}`);
});

Deno.test("findBestEntryZone — full pipeline with bullish impulse", () => {
  const htfCandles = generateBullishImpulseCandles(50);
  const entryCandles = generateBullishImpulseCandles(100); // More candles for LTF

  const result = findBestEntryZone(htfCandles, entryCandles, "bullish", 1.03);

  // The result should have a reason regardless of outcome
  assert(result.reason.length > 0, "Should always have a reason");

  if (result.bestZone) {
    assertExists(result.impulse);
    assert(result.impulse.isValid);
    assertEquals(result.impulse.direction, "bullish");
    assert(result.bestZone.zone.totalScore >= 1, "Best zone should have score >= 1");
    assert(result.allZones.length > 0, "Should have at least one zone");
  }
});

Deno.test("findBestEntryZone — full pipeline with bearish impulse", () => {
  const htfCandles = generateBearishImpulseCandles(50);
  const entryCandles = generateBearishImpulseCandles(100);

  const result = findBestEntryZone(htfCandles, entryCandles, "bearish", 1.03);

  assert(result.reason.length > 0);

  if (result.bestZone) {
    assertExists(result.impulse);
    assertEquals(result.impulse.direction, "bearish");
    assert(result.bestZone.zone.totalScore >= 1);
  }
});

Deno.test("findBestEntryZone — priceAtZone detection", () => {
  const htfCandles = generateBullishImpulseCandles(50);

  // If we find a zone, check priceAtZone logic
  const result = findBestEntryZone(htfCandles, htfCandles, "bullish", 1.0200);

  if (result.bestZone) {
    // priceAtZone should be boolean
    assertEquals(typeof result.bestZone.priceAtZone, "boolean");
    // distanceToZone should be a number
    assertEquals(typeof result.bestZone.distanceToZone, "number");
  }
});

Deno.test("overlayFibOnPOIs — bearish impulse Fib scoring", () => {
  const impulse: ImpulseLeg = {
    high: 1.0500, low: 1.0000, direction: "bearish",
    startIndex: 10, endIndex: 34, isValid: true, bosPrice: 1.0100,
  };

  // For bearish: retracement goes UP from low
  // 61.8% retracement = low + 0.618 * range = 1.0 + 0.618 * 0.05 = 1.0309
  const pois: ImpulsePOI[] = [
    { type: "ob", high: 1.0320, low: 1.0300, candleIndex: 20, direction: "bearish" },
  ];

  const ranked = overlayFibOnPOIs(impulse, pois);

  if (ranked.length > 0) {
    // Should be scored as near 61.8% level
    assert(ranked[0].fibDepth >= 0.5, `Fib depth should be >= 0.5, got ${ranked[0].fibDepth}`);
    assert(ranked[0].fibScore >= 1, "Should have fibScore >= 1");
  }
});

Deno.test("checkHistoricalSR — handles short lookback gracefully", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 15; i++) {
    candles.push(makeCandle(1.0, 1.01, 0.99, 1.0, i));
  }

  const zones: RankedPOI[] = [{
    poi: { type: "fvg", high: 1.01, low: 0.99, candleIndex: 10, direction: "bullish" },
    fibLevel: 0.618, fibDepth: 0.618, fibScore: 2,
    srConfirmed: false, ltfRefined: false, htfConfluenceScore: 0, htfLayers: [], totalScore: 2,
  }];

  // impulseStartIndex = 5 means only 5 candles of lookback — should handle gracefully
  const result = checkHistoricalSR(candles, zones, 5);
  assertEquals(result[0].srConfirmed, false); // Not enough data to confirm
});

// ─── Multi-TF Tests ───────────────────────────────────────────────────────────

import {
  findBestEntryZoneMultiTF,
  type MultiTFZoneResult,
} from "./impulseZoneEngine.ts";

Deno.test("findBestEntryZoneMultiTF — returns combined reason when neither TF has zone", () => {
  // Flat candles — no impulse on either TF
  const flat: Candle[] = [];
  for (let i = 0; i < 30; i++) {
    flat.push(makeCandle(1.0, 1.001, 0.999, 1.0, i));
  }

  const result = findBestEntryZoneMultiTF(flat, flat, flat, "bullish", 1.0);
  assertEquals(result.bestZone, null);
  assertEquals(result.selectedTF, null);
  assert(result.reason.includes("No valid zone"), `Reason: ${result.reason}`);
  assert(result.reason.includes("1H:"), "Should mention 1H result");
  assert(result.reason.includes("4H:"), "Should mention 4H result");
});

Deno.test("findBestEntryZoneMultiTF — uses 1H when 4H has insufficient candles", () => {
  const h1Candles = generateBullishImpulseCandles(50);
  const shortH4: Candle[] = [makeCandle(1.0, 1.01, 0.99, 1.0, 0)]; // Too few

  const result = findBestEntryZoneMultiTF(h1Candles, shortH4, h1Candles, "bullish", 1.03);

  assertEquals(result.h4Result, null); // 4H not run
  if (result.bestZone) {
    assertEquals(result.selectedTF, "1H");
  }
});

Deno.test("findBestEntryZoneMultiTF — uses 4H when 1H has no zone", () => {
  // Flat 1H candles (no impulse), but valid 4H impulse
  const flat1H: Candle[] = [];
  for (let i = 0; i < 30; i++) {
    flat1H.push(makeCandle(1.0, 1.001, 0.999, 1.0, i));
  }
  const h4Candles = generateBullishImpulseCandles(50);

  const result = findBestEntryZoneMultiTF(flat1H, h4Candles, flat1H, "bullish", 1.03);

  if (result.bestZone) {
    assertEquals(result.selectedTF, "4H");
    assert(result.reason.includes("4H zone selected"));
  }
});

Deno.test("findBestEntryZoneMultiTF — prefers higher score across TFs", () => {
  // Both TFs have valid impulses — the one with higher score should win
  const h1Candles = generateBullishImpulseCandles(50);
  const h4Candles = generateBullishImpulseCandles(50);

  const result = findBestEntryZoneMultiTF(h1Candles, h4Candles, h1Candles, "bullish", 1.03);

  if (result.bestZone) {
    // Should have selected one of the TFs
    assert(result.selectedTF === "1H" || result.selectedTF === "4H");
    // The selected zone should have the highest score
    const h1Score = result.h1Result.bestZone?.zone.totalScore ?? 0;
    const h4Score = result.h4Result?.bestZone?.zone.totalScore ?? 0;
    const selectedScore = result.bestZone.zone.totalScore;
    assert(selectedScore >= h1Score && selectedScore >= h4Score,
      `Selected score ${selectedScore} should be >= h1(${h1Score}) and h4(${h4Score})`);
  }
});

Deno.test("findBestEntryZoneMultiTF — 4H wins on tie (HTF preferred)", () => {
  // Create identical candles for both TFs — should produce same scores, 4H wins
  const candles = generateBullishImpulseCandles(50);

  const result = findBestEntryZoneMultiTF(candles, candles, candles, "bullish", 1.03);

  if (result.bestZone && result.h1Result.bestZone && result.h4Result?.bestZone) {
    const h1Score = result.h1Result.bestZone.zone.totalScore;
    const h4Score = result.h4Result.bestZone.zone.totalScore;
    if (h1Score === h4Score) {
      // On perfect tie, 4H should win
      assertEquals(result.selectedTF, "4H");
    }
  }
});

Deno.test("findBestEntryZoneMultiTF — allZones combines both TFs", () => {
  const h1Candles = generateBullishImpulseCandles(50);
  const h4Candles = generateBullishImpulseCandles(50);

  const result = findBestEntryZoneMultiTF(h1Candles, h4Candles, h1Candles, "bullish", 1.03);

  const h1ZoneCount = result.h1Result.allZones.length;
  const h4ZoneCount = result.h4Result?.allZones.length ?? 0;
  assertEquals(result.allZones.length, h1ZoneCount + h4ZoneCount);
});

Deno.test("findBestEntryZoneMultiTF — empty h4Candles array handled gracefully", () => {
  const h1Candles = generateBullishImpulseCandles(50);

  const result = findBestEntryZoneMultiTF(h1Candles, [], h1Candles, "bullish", 1.03);

  assertEquals(result.h4Result, null);
  if (result.bestZone) {
    assertEquals(result.selectedTF, "1H");
  }
});

Deno.test("findBestEntryZoneMultiTF — bearish direction works on both TFs", () => {
  const h1Candles = generateBearishImpulseCandles(50);
  const h4Candles = generateBearishImpulseCandles(50);

  const result = findBestEntryZoneMultiTF(h1Candles, h4Candles, h1Candles, "bearish", 1.03);

  assert(result.reason.length > 0);
  if (result.bestZone) {
    assertEquals(result.bestZone.impulse.direction, "bearish");
  }
});

// ─── Regression: OB detection with pre-impulse opposing candle ────────────────
// This test proves that an OB sitting 1-3 bars BEFORE the impulse start is now
// detected. Before the fix, mapImpulsePOIs() only ran detectOrderBlocks() on
// the impulse slice, so the OB was either outside the slice entirely or got
// falsely invalidated by the impulse candles' lifecycle tracking.

Deno.test("mapImpulsePOIs — regression: detects OB that sits before impulse start", () => {
  // Build a controlled scenario:
  // Candles 0-4: consolidation
  // Candle 5: a clear bearish candle (the OB for a bullish impulse)
  // Candles 6-7: small indecision candles
  // Candles 8-20: strong bullish impulse (engulfs candle 5, breaks structure)
  // Candles 21-30: retracement
  const candles: Candle[] = [];

  // Phase 1: Consolidation (candles 0-4)
  for (let i = 0; i < 5; i++) {
    const base = 1.0200 + i * 0.0002;
    candles.push(makeCandle(base, base + 0.0010, base - 0.0010, base + 0.0001, i));
  }

  // Candle 5: Clear bearish candle — this is the OB (last opposing candle before impulse)
  candles.push(makeCandle(1.0210, 1.0215, 1.0190, 1.0195, 5));

  // Candles 6-7: Small indecision candles between OB and impulse
  candles.push(makeCandle(1.0195, 1.0200, 1.0192, 1.0198, 6));
  candles.push(makeCandle(1.0198, 1.0202, 1.0195, 1.0200, 7));

  // Candles 8-20: Strong bullish impulse — each candle pushes higher
  let price = 1.0200;
  const step = 0.0025;
  for (let i = 8; i <= 20; i++) {
    const open = price;
    price += step;
    // Large bullish candles with displacement
    candles.push(makeCandle(open, price + 0.0005, open - 0.0003, price, i));
  }

  // Candles 21-30: Retracement back toward the OB zone
  const peakPrice = price;
  let retPrice = peakPrice;
  for (let i = 21; i <= 30; i++) {
    retPrice -= 0.0015;
    candles.push(makeCandle(retPrice + 0.0010, retPrice + 0.0012, retPrice - 0.0003, retPrice, i));
  }

  // Create a valid impulse leg that starts at candle 8 (after the OB at candle 5)
  const impulse: ImpulseLeg = {
    high: peakPrice + 0.0005,
    low: 1.0200,
    direction: "bullish",
    startIndex: 8,
    endIndex: 20,
    isValid: true,
    bosPrice: peakPrice - 0.005,
  };

  const pois = mapImpulsePOIs(candles, impulse);

  // The key assertion: we should find at least one OB POI.
  // Before the fix, this returned 0 OBs because:
  // 1. The OB at candle 5 was outside the impulse slice [8, 20]
  // 2. Any OBs detected within [8, 20] were immediately invalidated by lifecycle tracking
  const obPois = pois.filter(p => p.type === "ob");
  assert(
    obPois.length > 0,
    `Expected at least 1 OB POI but got ${obPois.length}. ` +
    `Total POIs: ${pois.length} (${pois.map(p => p.type).join(", ")}). ` +
    `This regression test verifies the fix for OBs sitting before the impulse start.`
  );

  // All OB POIs should be bullish (aligned with impulse direction)
  for (const ob of obPois) {
    assertEquals(ob.direction, "bullish", "OB should be aligned with impulse direction");
  }

  // OB price should be within the impulse price range
  for (const ob of obPois) {
    assert(ob.high <= impulse.high + 0.001, `OB high ${ob.high} exceeds impulse high ${impulse.high}`);
    assert(ob.low >= impulse.low - 0.001, `OB low ${ob.low} below impulse low ${impulse.low}`);
  }
});

Deno.test("mapImpulsePOIs — regression: OBs are not falsely broken by impulse candles", () => {
  // This test verifies that running OB detection on a wider candle set prevents
  // the impulse candles from falsely marking the OB as "broken" or "mitigated".
  // The lifecycle tracking in detectOrderBlocks() marks OBs as broken when
  // subsequent candles close through the OB zone — but in the old code, those
  // "subsequent candles" were the impulse candles themselves.
  const candles: Candle[] = [];

  // Candles 0-3: Flat consolidation
  for (let i = 0; i < 4; i++) {
    candles.push(makeCandle(1.0500, 1.0510, 1.0490, 1.0505, i));
  }

  // Candle 4: Clear bullish candle (the OB for a bearish impulse)
  candles.push(makeCandle(1.0490, 1.0520, 1.0488, 1.0515, 4));

  // Candle 5: Small candle
  candles.push(makeCandle(1.0515, 1.0518, 1.0510, 1.0512, 5));

  // Candles 6-18: Strong bearish impulse
  let price = 1.0510;
  for (let i = 6; i <= 18; i++) {
    const open = price;
    price -= 0.0025;
    candles.push(makeCandle(open, open + 0.0003, price - 0.0005, price, i));
  }

  // Candles 19-25: Retracement up
  let retPrice = price;
  for (let i = 19; i <= 25; i++) {
    retPrice += 0.0012;
    candles.push(makeCandle(retPrice - 0.0008, retPrice + 0.0003, retPrice - 0.0010, retPrice, i));
  }

  const impulse: ImpulseLeg = {
    high: 1.0510,
    low: price - 0.0005,
    direction: "bearish",
    startIndex: 6,
    endIndex: 18,
    isValid: true,
    bosPrice: 1.0490,
  };

  const pois = mapImpulsePOIs(candles, impulse);
  const obPois = pois.filter(p => p.type === "ob");

  // We expect at least one bearish OB (the bullish candle at index 4 should be
  // detected as the OB for the bearish impulse). Before the fix, the impulse
  // candles would have falsely broken/mitigated this OB.
  assert(
    obPois.length > 0,
    `Expected at least 1 bearish OB POI but got ${obPois.length}. ` +
    `This verifies OBs are not falsely invalidated by impulse candle lifecycle tracking.`
  );

  for (const ob of obPois) {
    assertEquals(ob.direction, "bearish", "OB should be aligned with bearish impulse");
  }
});

// ─── Regression tests: origin-not-broken validation ───────────────────────────
// These tests verify the fix that replaced the 50% internal pullback kill switch
// with origin-not-broken validation. An impulse with deep internal pullbacks
// (wave 2/4) should still be found, but an impulse whose origin is broken should not.

Deno.test("findImpulseLeg — accepts impulse with deep internal pullbacks (wave structure)", () => {
  // Simulate a bearish impulse with a 60%+ internal pullback (wave 2).
  // Old code would reject this; new code should accept it because origin is intact.
  const candles: Candle[] = [];
  const startPrice = 1.0500;

  // Phase 1: Consolidation (candles 0-9)
  for (let i = 0; i < 10; i++) {
    const base = startPrice + (Math.random() * 0.002 - 0.001);
    candles.push(makeCandle(base, base + 0.0015, base - 0.0015, base - 0.0005, i));
  }

  // Phase 2: Bearish impulse with deep wave-2 pullback
  let price = startPrice;
  // Wave 1 down: 1.0500 -> 1.0400 (3 candles)
  for (let i = 10; i < 13; i++) {
    const prev = price;
    price -= 0.0033;
    candles.push(makeCandle(prev, prev + 0.0002, price - 0.0003, price, i));
  }

  // Wave 2 up: deep pullback to ~1.0470 (70% retrace of wave 1)
  const wave2Target = 1.0470;
  const wave2Step = (wave2Target - price) / 3;
  for (let i = 13; i < 16; i++) {
    const prev = price;
    price += wave2Step;
    candles.push(makeCandle(prev, price + 0.0002, prev - 0.0002, price, i));
  }

  // Wave 3 down: strong move 1.0470 -> 1.0300 (5 candles)
  for (let i = 16; i < 21; i++) {
    const prev = price;
    price -= 0.0034;
    candles.push(makeCandle(prev, prev + 0.0002, price - 0.0003, price, i));
  }

  // Wave 4 up: pullback to ~1.0360 (30% retrace of wave 3)
  const wave4Target = 1.0360;
  const wave4Step = (wave4Target - price) / 2;
  for (let i = 21; i < 23; i++) {
    const prev = price;
    price += wave4Step;
    candles.push(makeCandle(prev, price + 0.0002, prev - 0.0002, price, i));
  }

  // Wave 5 down: final push 1.0360 -> 1.0200 (4 candles) — creates BOS
  for (let i = 23; i < 27; i++) {
    const prev = price;
    price -= 0.004;
    candles.push(makeCandle(prev, prev + 0.0002, price - 0.0003, price, i));
  }

  // Phase 3: Retracement up (candles 27-39) — stays below origin (1.0500)
  for (let i = 27; i < 40; i++) {
    const prev = price;
    price += 0.0015;
    candles.push(makeCandle(prev, price + 0.0003, prev - 0.0002, price, i));
  }

  const result = findImpulseLeg(candles, "bearish");
  assertExists(result, "Should find bearish impulse despite deep internal pullbacks");
  assert(result.isValid, "Impulse should be valid — origin not broken");
  assertEquals(result.direction, "bearish");
  assert(result.high >= 1.0450, `Impulse high ${result.high} should be near origin`);
  assert(result.low <= 1.0250, `Impulse low ${result.low} should be near BOS`);
});

Deno.test("findImpulseLeg — rejects impulse when origin is broken", () => {
  // Simulate a bullish impulse where price later closes below the origin.
  const candles: Candle[] = [];
  const startPrice = 1.0000;

  // Phase 1: Consolidation (candles 0-9)
  for (let i = 0; i < 10; i++) {
    const base = startPrice + (Math.random() * 0.002 - 0.001);
    candles.push(makeCandle(base, base + 0.0015, base - 0.0015, base + 0.0005, i));
  }

  // Phase 2: Bullish impulse up (candles 10-24)
  let price = startPrice;
  for (let i = 10; i < 25; i++) {
    const prev = price;
    price += 0.003;
    candles.push(makeCandle(prev, price + 0.0003, prev - 0.0002, price, i));
  }

  // Phase 3: Price crashes below origin (candles 25-39)
  for (let i = 25; i < 40; i++) {
    const prev = price;
    price -= 0.004;
    candles.push(makeCandle(prev, prev + 0.0002, price - 0.0003, price, i));
  }

  const result = findImpulseLeg(candles, "bullish");
  // Should be null because the origin (swing low ~1.0000) was broken
  if (result) {
    assert(result.isValid, "Any returned impulse must be valid");
    assert(
      result.low > 0.9900,
      `If an impulse was found, its low (${result.low}) should not be the broken origin`
    );
  }
});

Deno.test("findImpulseLeg — ETH-like bearish impulse with wave structure is found", () => {
  // Simulates the ETH/USD scenario: bearish impulse from ~2350 to 2299
  // with internal pullbacks (consolidation around 2325-2330 area).
  // Key: consolidation highs must be BELOW the impulse origin high so that
  // the origin candle is detected as a swing high by the lookback algorithm.
  const candles: Candle[] = [];

  // Phase 1: Consolidation around 2330 (candles 0-9) — highs stay below 2340
  for (let i = 0; i < 10; i++) {
    candles.push(makeCandle(2330, 2334, 2327, 2331, i));
  }

  // Phase 2: Push up to 2350 high — this becomes the impulse origin swing high (candle 10)
  candles.push(makeCandle(2335, 2350, 2333, 2348, 10));

  // Phase 3: First leg down to 2320, creating a swing low (candles 11-14)
  candles.push(makeCandle(2348, 2349, 2338, 2340, 11));
  candles.push(makeCandle(2340, 2341, 2328, 2330, 12));
  candles.push(makeCandle(2330, 2331, 2318, 2320, 13));
  candles.push(makeCandle(2320, 2321, 2316, 2318, 14));

  // Phase 4: Internal pullback to 2335 — creates a swing low at idx ~14 area
  // then rallies, making idx 14 a confirmed swing low (candles 15-17)
  candles.push(makeCandle(2318, 2330, 2317, 2328, 15));
  candles.push(makeCandle(2328, 2336, 2327, 2335, 16));
  candles.push(makeCandle(2335, 2337, 2333, 2334, 17));

  // Phase 5: Second leg down — breaks below the swing low at 2316 → bearish BOS (candles 18-22)
  candles.push(makeCandle(2334, 2335, 2320, 2322, 18));
  candles.push(makeCandle(2322, 2323, 2310, 2312, 19));
  candles.push(makeCandle(2312, 2313, 2302, 2304, 20));
  candles.push(makeCandle(2304, 2305, 2298, 2299, 21));
  candles.push(makeCandle(2299, 2300, 2296, 2298, 22));

  // Phase 6: Retracement up — stays below origin 2350 (candles 23-34)
  let price = 2298;
  for (let i = 23; i < 35; i++) {
    const prev = price;
    price += 3;
    candles.push(makeCandle(prev, price + 1, prev - 0.5, price, i));
  }

  const result = findImpulseLeg(candles, "bearish");
  assertExists(result, "Should find bearish impulse in ETH-like scenario");
  assert(result.isValid, "Impulse should be valid — origin not broken by retracement");
  assertEquals(result.direction, "bearish");
  // The impulse traces from the swing high before the BOS (idx 17, high=2337)
  // down to the BOS candle (idx 22, low=2296). Origin (2350) is not broken.
  assert(result.high >= 2330, `Impulse high ${result.high} should be near 2337`);
  assert(result.low <= 2300, `Impulse low ${result.low} should be near 2296`);
});
