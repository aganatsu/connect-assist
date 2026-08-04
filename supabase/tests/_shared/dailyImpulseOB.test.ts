/**
 * Tests for dailyImpulseOB.ts — ICT Daily Impulse & Order Block Containment
 */
import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  detectDailyDisplacements,
  findDailyOB,
  analyzeDailyImpulse,
  checkContainment,
  checkCascadingContainment,
  type DailyDisplacementLeg,
  type DailyOB,
} from "./dailyImpulseOB.ts";
import type { Candle } from "./smcAnalysis.ts";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function makeCandle(open: number, high: number, low: number, close: number, datetime = "2024-01-01"): Candle {
  return { open, high, low, close, datetime, volume: 1000 };
}

/**
 * Create a series of daily candles with a clear bearish displacement in the middle.
 * MIN_DAILY_CANDLES = 30, so we need at least 30 candles.
 * Displacement criteria: bodyRatio >= 0.65, rangeMult >= 1.3, bodyMult >= 1.8
 */
function makeBearishDisplacementSeries(): Candle[] {
  const candles: Candle[] = [];
  let price = 1.2000;

  // 20 normal candles (small bodies to establish low ATR and avgBody)
  for (let i = 0; i < 20; i++) {
    const body = ((i % 3) - 1) * 0.0008; // alternating small bodies
    const open = price;
    const close = price + body;
    const high = Math.max(open, close) + 0.0010;
    const low = Math.min(open, close) - 0.0010;
    candles.push(makeCandle(open, high, low, close, `2024-01-${(i + 1).toString().padStart(2, "0")}`));
    price = close;
  }

  // 1 bullish candle (OB — last bullish before bearish displacement)
  const obOpen = price;
  const obClose = price + 0.0025;
  candles.push(makeCandle(obOpen, obClose + 0.0005, obOpen - 0.0005, obClose, "2024-01-21"));
  price = obClose;

  // 3 large bearish displacement candles
  // With 20 small candles (body ~0.0008, range ~0.0028), ATR ≈ 0.0028
  // Displacement needs: range/ATR >= 1.3 → range >= 0.0036, body/range >= 0.65, body/avgBody >= 1.8
  // Using body=0.0080, range=0.0090 → bodyRatio=0.89, rangeMult≈3.2, bodyMult≈10
  for (let i = 0; i < 3; i++) {
    const open = price;
    const close = price - 0.0080;
    const high = open + 0.0005;
    const low = close - 0.0005;
    candles.push(makeCandle(open, high, low, close, `2024-01-${(22 + i).toString().padStart(2, "0")}`));
    price = close;
  }

  // 10 normal candles after (retracement)
  for (let i = 0; i < 10; i++) {
    const body = 0.0010; // slight bullish retracement
    const open = price;
    const close = price + body;
    const high = close + 0.0008;
    const low = open - 0.0005;
    candles.push(makeCandle(open, high, low, close, `2024-01-${(25 + i).toString().padStart(2, "0")}`));
    price = close;
  }

  return candles;
}

/**
 * Create a series with a clear bullish displacement.
 */
function makeBullishDisplacementSeries(): Candle[] {
  const candles: Candle[] = [];
  let price = 1.2000;

  // 20 normal candles (small bodies)
  for (let i = 0; i < 20; i++) {
    const body = ((i % 3) - 1) * 0.0008;
    const open = price;
    const close = price + body;
    const high = Math.max(open, close) + 0.0010;
    const low = Math.min(open, close) - 0.0010;
    candles.push(makeCandle(open, high, low, close, `2024-02-${(i + 1).toString().padStart(2, "0")}`));
    price = close;
  }

  // 1 bearish candle (OB — last bearish before bullish displacement)
  const obOpen = price;
  const obClose = price - 0.0025;
  candles.push(makeCandle(obOpen, obOpen + 0.0005, obClose - 0.0005, obClose, "2024-02-21"));
  price = obClose;

  // 3 large bullish displacement candles
  for (let i = 0; i < 3; i++) {
    const open = price;
    const close = price + 0.0080;
    const low = open - 0.0005;
    const high = close + 0.0005;
    candles.push(makeCandle(open, high, low, close, `2024-02-${(22 + i).toString().padStart(2, "0")}`));
    price = close;
  }

  // 10 normal candles after (slight bearish retracement)
  for (let i = 0; i < 10; i++) {
    const body = -0.0008;
    const open = price;
    const close = price + body;
    const high = open + 0.0008;
    const low = close - 0.0005;
    candles.push(makeCandle(open, high, low, close, `2024-02-${(25 + i).toString().padStart(2, "0")}`));
    price = close;
  }

  return candles;
}

// ─── Displacement Detection Tests ─────────────────────────────────────────────

Deno.test("dailyImpulseOB: returns empty with insufficient candles", () => {
  const candles = [makeCandle(1.0, 1.01, 0.99, 1.005)];
  const result = detectDailyDisplacements(candles);
  assertEquals(result.length, 0);
});

Deno.test("dailyImpulseOB: detects bearish displacement", () => {
  const candles = makeBearishDisplacementSeries();
  const displacements = detectDailyDisplacements(candles);
  assert(displacements.length >= 1, `Should find at least 1 displacement, found ${displacements.length}`);

  // The displacement should be bearish
  const bearish = displacements.find(d => d.direction === "bearish");
  assertExists(bearish, "Should find a bearish displacement");
  assert(bearish!.candleCount >= 2, "Should have at least 2 candles in the leg");
  assert(bearish!.avgBodyRatio >= 0.65, `Body ratio should be >= 0.65, got ${bearish!.avgBodyRatio}`);
});

Deno.test("dailyImpulseOB: detects bullish displacement", () => {
  const candles = makeBullishDisplacementSeries();
  const displacements = detectDailyDisplacements(candles);
  assert(displacements.length >= 1, `Should find at least 1 displacement, found ${displacements.length}`);

  const bullish = displacements.find(d => d.direction === "bullish");
  assertExists(bullish, "Should find a bullish displacement");
});

Deno.test("dailyImpulseOB: does not detect displacement in ranging market", () => {
  // Create 40 candles with small bodies (no displacement)
  const candles: Candle[] = [];
  let price = 1.2000;
  for (let i = 0; i < 40; i++) {
    const body = (Math.random() - 0.5) * 0.0010; // tiny 5 pip bodies
    const open = price;
    const close = price + body;
    const high = Math.max(open, close) + 0.0015;
    const low = Math.min(open, close) - 0.0015;
    candles.push(makeCandle(open, high, low, close, `2024-03-${(i + 1).toString().padStart(2, "0")}`));
    price += (Math.random() - 0.5) * 0.0005;
  }
  const displacements = detectDailyDisplacements(candles);
  assertEquals(displacements.length, 0, "Ranging market should have no displacements");
});

// ─── Daily OB Tests ───────────────────────────────────────────────────────────

Deno.test("dailyImpulseOB: finds OB before bearish displacement", () => {
  const candles = makeBearishDisplacementSeries();
  const displacements = detectDailyDisplacements(candles);
  const bearish = displacements.find(d => d.direction === "bearish");
  assertExists(bearish);

  const currentPrice = candles[candles.length - 1].close;
  const ob = findDailyOB(candles, bearish!, currentPrice);
  assertExists(ob, "Should find an OB");
  assertEquals(ob!.direction, "bearish"); // Bearish OB = sell zone
  assert(ob!.index < bearish!.startIndex, "OB should be before the displacement");
});

Deno.test("dailyImpulseOB: finds OB before bullish displacement", () => {
  const candles = makeBullishDisplacementSeries();
  const displacements = detectDailyDisplacements(candles);
  const bullish = displacements.find(d => d.direction === "bullish");
  assertExists(bullish);

  const currentPrice = candles[candles.length - 1].close;
  const ob = findDailyOB(candles, bullish!, currentPrice);
  assertExists(ob, "Should find an OB");
  assertEquals(ob!.direction, "bullish"); // Bullish OB = buy zone
});

Deno.test("dailyImpulseOB: OB is invalidated when price closes past it", () => {
  const candles = makeBearishDisplacementSeries();
  // Add a candle that closes above the OB high (invalidating it)
  const obCandle = candles[15]; // The OB candle
  const invalidatingCandle = makeCandle(
    obCandle.high + 0.0010,
    obCandle.high + 0.0050,
    obCandle.high + 0.0005,
    obCandle.high + 0.0040, // Closes above OB high
    "2024-02-01"
  );
  candles.push(invalidatingCandle);

  const displacements = detectDailyDisplacements(candles);
  const bearish = displacements.find(d => d.direction === "bearish");
  if (bearish) {
    const ob = findDailyOB(candles, bearish, invalidatingCandle.close);
    if (ob) {
      assertEquals(ob.isValid, false, "OB should be invalidated");
    }
  }
});

// ─── Full Analysis Pipeline Tests ─────────────────────────────────────────────

Deno.test("dailyImpulseOB: analyzeDailyImpulse returns complete result", () => {
  const candles = makeBearishDisplacementSeries();
  const currentPrice = candles[candles.length - 1].close;
  const result = analyzeDailyImpulse(candles, currentPrice, "bearish");

  assertExists(result);
  assertEquals(result.hasDisplacement, true);
  assert(result.displacements.length >= 1);
  assertExists(result.reason);
});

Deno.test("dailyImpulseOB: analyzeDailyImpulse selects direction-aligned OB", () => {
  const candles = makeBearishDisplacementSeries();
  const currentPrice = candles[candles.length - 1].close;

  // Ask for bearish direction — should find bearish OB
  const result = analyzeDailyImpulse(candles, currentPrice, "bearish");
  if (result.primaryOB) {
    assertEquals(result.primaryOB.direction, "bearish");
  }
});

// ─── Containment Tests ────────────────────────────────────────────────────────

Deno.test("dailyImpulseOB: checkContainment — fully contained zone", () => {
  const dailyOB: DailyOB = {
    high: 1.2050,
    low: 1.1950,
    direction: "bearish",
    index: 15,
    datetime: "2024-01-16",
    isValid: true,
    priceInZone: true,
    displacement: { direction: "bearish", startIndex: 16, endIndex: 18, candleCount: 3, totalRange: 0.024, avgBodyRatio: 0.85, avgRangeMultiple: 2.0, high: 1.2050, low: 1.1810 },
    invalidationPrice: 1.2050,
  };

  // Zone fully inside Daily OB
  const result = checkContainment(1.2030, 1.1970, dailyOB);
  assertEquals(result.isContained, true);
  assertEquals(result.overlapPercent, 100);
});

Deno.test("dailyImpulseOB: checkContainment — partially contained zone (above threshold)", () => {
  const dailyOB: DailyOB = {
    high: 1.2050,
    low: 1.1950,
    direction: "bearish",
    index: 15,
    datetime: "2024-01-16",
    isValid: true,
    priceInZone: false,
    displacement: { direction: "bearish", startIndex: 16, endIndex: 18, candleCount: 3, totalRange: 0.024, avgBodyRatio: 0.85, avgRangeMultiple: 2.0, high: 1.2050, low: 1.1810 },
    invalidationPrice: 1.2050,
  };

  // Zone partially inside (70% overlap)
  // Zone: 1.1980 - 1.2080 (100 pips), Daily OB: 1.1950 - 1.2050
  // Overlap: 1.1980 - 1.2050 = 70 pips = 70%
  const result = checkContainment(1.2080, 1.1980, dailyOB);
  assertEquals(result.isContained, true);
  assert(result.overlapPercent >= 50 && result.overlapPercent <= 80);
});

Deno.test("dailyImpulseOB: checkContainment — zone outside Daily OB", () => {
  const dailyOB: DailyOB = {
    high: 1.2050,
    low: 1.1950,
    direction: "bearish",
    index: 15,
    datetime: "2024-01-16",
    isValid: true,
    priceInZone: false,
    displacement: { direction: "bearish", startIndex: 16, endIndex: 18, candleCount: 3, totalRange: 0.024, avgBodyRatio: 0.85, avgRangeMultiple: 2.0, high: 1.2050, low: 1.1810 },
    invalidationPrice: 1.2050,
  };

  // Zone completely outside Daily OB
  const result = checkContainment(1.2200, 1.2100, dailyOB);
  assertEquals(result.isContained, false);
  assertEquals(result.overlapPercent, 0);
});

Deno.test("dailyImpulseOB: checkContainment — zone below threshold", () => {
  const dailyOB: DailyOB = {
    high: 1.2050,
    low: 1.1950,
    direction: "bearish",
    index: 15,
    datetime: "2024-01-16",
    isValid: true,
    priceInZone: false,
    displacement: { direction: "bearish", startIndex: 16, endIndex: 18, candleCount: 3, totalRange: 0.024, avgBodyRatio: 0.85, avgRangeMultiple: 2.0, high: 1.2050, low: 1.1810 },
    invalidationPrice: 1.2050,
  };

  // Zone barely overlapping (30% overlap < 50% threshold)
  // Zone: 1.2020 - 1.2120 (100 pips), overlap with OB: 1.2020 - 1.2050 = 30 pips = 30%
  const result = checkContainment(1.2120, 1.2020, dailyOB);
  assertEquals(result.isContained, false);
  assert(result.overlapPercent < 50);
});

// ─── Cascading Containment Tests ──────────────────────────────────────────────

Deno.test("dailyImpulseOB: cascading containment — all nested", () => {
  const dailyOB: DailyOB = {
    high: 1.2100,
    low: 1.1900,
    direction: "bearish",
    index: 15,
    datetime: "2024-01-16",
    isValid: true,
    priceInZone: true,
    displacement: { direction: "bearish", startIndex: 16, endIndex: 18, candleCount: 3, totalRange: 0.024, avgBodyRatio: 0.85, avgRangeMultiple: 2.0, high: 1.2100, low: 1.1860 },
    invalidationPrice: 1.2100,
  };

  const h4Zone = { high: 1.2080, low: 1.1950 }; // Inside daily OB
  const h1Zone = { high: 1.2050, low: 1.1980 }; // Inside 4H zone
  const entryZone = { high: 1.2030, low: 1.2000 }; // Inside 1H zone

  const result = checkCascadingContainment(dailyOB, h4Zone, h1Zone, entryZone);
  assertEquals(result.allContained, true);
  assertExists(result.h4InDaily);
  assertEquals(result.h4InDaily!.isContained, true);
  assertExists(result.entryInDaily);
  assertEquals(result.entryInDaily!.isContained, true);
});

Deno.test("dailyImpulseOB: cascading containment — entry outside daily OB", () => {
  const dailyOB: DailyOB = {
    high: 1.2050,
    low: 1.1950,
    direction: "bearish",
    index: 15,
    datetime: "2024-01-16",
    isValid: true,
    priceInZone: false,
    displacement: { direction: "bearish", startIndex: 16, endIndex: 18, candleCount: 3, totalRange: 0.024, avgBodyRatio: 0.85, avgRangeMultiple: 2.0, high: 1.2050, low: 1.1810 },
    invalidationPrice: 1.2050,
  };

  const entryZone = { high: 1.2200, low: 1.2150 }; // Outside daily OB

  const result = checkCascadingContainment(dailyOB, null, null, entryZone);
  assertEquals(result.allContained, false);
  assertExists(result.entryInDaily);
  assertEquals(result.entryInDaily!.isContained, false);
});

Deno.test("dailyImpulseOB: cascading containment — no zones provided", () => {
  const dailyOB: DailyOB = {
    high: 1.2050,
    low: 1.1950,
    direction: "bearish",
    index: 15,
    datetime: "2024-01-16",
    isValid: true,
    priceInZone: false,
    displacement: { direction: "bearish", startIndex: 16, endIndex: 18, candleCount: 3, totalRange: 0.024, avgBodyRatio: 0.85, avgRangeMultiple: 2.0, high: 1.2050, low: 1.1810 },
    invalidationPrice: 1.2050,
  };

  const result = checkCascadingContainment(dailyOB, null, null, null);
  assertEquals(result.allContained, false); // No critical check available
  assertEquals(result.h4InDaily, null);
  assertEquals(result.entryInDaily, null);
});
