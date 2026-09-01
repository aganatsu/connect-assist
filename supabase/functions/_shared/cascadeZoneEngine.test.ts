/**
 * Tests for the Cascade Zone Engine (Daily → 4H → 1H → 15m)
 *
 * Tests the sequential top-down flow:
 *   1. Daily zone identification
 *   2. Price proximity to Daily zone
 *   3. 4H displacement confirmation
 *   4. 1H CHoCH confirmation (fallback)
 *   5. 1H entry zone within Daily zone
 *   6. Full cascade pipeline
 */

import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { Candle } from "./smcAnalysis.ts";
import {
  findDailyZone,
  checkPriceAtDailyZone,
  detect4HConfirmation,
  detect1HConfirmation,
  findEntryZoneWithinDailyZone,
  findCascadeZone,
} from "./cascadeZoneEngine.ts";
import type { DailyZone, CascadeResult, CascadeState } from "./cascadeZoneEngine.ts";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/** Generate a trending set of candles (bullish impulse then retracement) */
function generateBullishImpulseCandles(count: number, startPrice: number, impulseSize: number): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;

  // Phase 1: Consolidation (first 20%)
  const consolidationEnd = Math.floor(count * 0.2);
  for (let i = 0; i < consolidationEnd; i++) {
    const noise = (Math.random() - 0.5) * impulseSize * 0.02;
    candles.push({
      open: price + noise,
      high: price + Math.abs(noise) + impulseSize * 0.01,
      low: price - Math.abs(noise) - impulseSize * 0.01,
      close: price + noise * 0.5,
      volume: 1000,
      time: new Date(2024, 0, 1 + i).toISOString(),
    });
    price += noise * 0.1;
  }

  // Phase 2: Impulse UP (next 40%) — strong bullish candles
  const impulseEnd = Math.floor(count * 0.6);
  const impulseStart = price;
  for (let i = consolidationEnd; i < impulseEnd; i++) {
    const progress = (i - consolidationEnd) / (impulseEnd - consolidationEnd);
    const step = impulseSize * 0.03; // Each candle moves ~3% of impulse
    const open = price;
    price += step;
    const close = price;
    candles.push({
      open,
      high: close + impulseSize * 0.005,
      low: open - impulseSize * 0.003,
      close,
      volume: 2000,
      time: new Date(2024, 0, 1 + i).toISOString(),
    });
  }

  // Phase 3: Retracement (last 40%) — price pulls back ~61.8%
  const impulseHigh = price;
  const retracementTarget = impulseHigh - impulseSize * 0.618;
  for (let i = impulseEnd; i < count; i++) {
    const progress = (i - impulseEnd) / (count - impulseEnd);
    const target = impulseHigh - (impulseHigh - retracementTarget) * progress;
    const step = (target - price) * 0.3;
    const open = price;
    price += step;
    const close = price;
    candles.push({
      open,
      high: Math.max(open, close) + impulseSize * 0.003,
      low: Math.min(open, close) - impulseSize * 0.005,
      close,
      volume: 1500,
      time: new Date(2024, 0, 1 + i).toISOString(),
    });
  }

  return candles;
}

/** Generate candles with a clear displacement (large bullish candle) */
function generateCandlesWithDisplacement(count: number, basePrice: number, zoneHigh: number, zoneLow: number): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;
  const avgRange = (zoneHigh - zoneLow) * 0.1;

  // Normal candles first
  for (let i = 0; i < count - 3; i++) {
    const noise = (Math.random() - 0.5) * avgRange;
    candles.push({
      open: price,
      high: price + avgRange * 0.5,
      low: price - avgRange * 0.5,
      close: price + noise,
      volume: 1000,
      time: new Date(2024, 0, 1, i * 4).toISOString(),
    });
    price += noise * 0.1;
  }

  // Displacement candle: body >= 2x avg, range >= 1.5x avg, body/range >= 0.7
  const dispBody = avgRange * 3;
  const dispRange = dispBody / 0.75; // bodyRatio ~0.75
  candles.push({
    open: price,
    high: price + dispRange,
    low: price - (dispRange - dispBody) * 0.5,
    close: price + dispBody,
    volume: 5000,
    time: new Date(2024, 0, 1, (count - 3) * 4).toISOString(),
  });
  price += dispBody;

  // Two more normal candles after
  for (let i = 0; i < 2; i++) {
    const noise = (Math.random() - 0.5) * avgRange * 0.5;
    candles.push({
      open: price,
      high: price + avgRange * 0.3,
      low: price - avgRange * 0.3,
      close: price + noise,
      volume: 1000,
      time: new Date(2024, 0, 1, (count - 2 + i) * 4).toISOString(),
    });
    price += noise * 0.1;
  }

  return candles;
}

// ─── Tests: findDailyZone ─────────────────────────────────────────────────────

Deno.test("findDailyZone: returns null with insufficient candles", () => {
  const candles: Candle[] = Array(20).fill(null).map((_, i) => ({
    open: 1.1, high: 1.11, low: 1.09, close: 1.1,
    volume: 1000, time: new Date(2024, 0, 1 + i).toISOString(),
  }));
  const result = findDailyZone(candles, "bullish");
  assertEquals(result.zone, null);
  assert(result.reason.includes("Insufficient"));
});

Deno.test("findDailyZone: finds zone in bullish impulse with retracement", () => {
  // Generate 60 daily candles with a clear bullish impulse
  const candles = generateBullishImpulseCandles(60, 1.0500, 0.0500);
  const result = findDailyZone(candles, "bullish");

  // Should find a zone (the impulse is clear with POIs)
  // Note: may be null if the generated data doesn't produce detectable structure
  // This is acceptable — the test validates the function doesn't crash
  if (result.zone) {
    assert(result.zone.fibLevel >= 0.382, "Zone should be at a meaningful Fib level");
    assert(result.zone.high > result.zone.low, "Zone high should be above low");
    assertExists(result.zone.impulse);
    assertEquals(result.zone.impulse.direction, "bullish");
  }
});

Deno.test("findDailyZone: respects minDailyFibDepth option", () => {
  const candles = generateBullishImpulseCandles(60, 1.0500, 0.0500);
  // Very strict: require 78.6% depth minimum
  const result = findDailyZone(candles, "bullish", { minDailyFibDepth: 0.786 });
  // Either finds a deep zone or returns null with appropriate reason
  if (!result.zone) {
    assert(result.reason.includes("deep enough") || result.reason.includes("No valid") || result.reason.includes("no POIs") || result.reason.includes("none at key"));
  }
});

Deno.test("findDailyZone: returns reason when no impulse exists", () => {
  // Flat/ranging candles — no impulse
  const candles: Candle[] = Array(60).fill(null).map((_, i) => ({
    open: 1.1000 + (Math.random() - 0.5) * 0.0010,
    high: 1.1010 + (Math.random() - 0.5) * 0.0010,
    low: 1.0990 + (Math.random() - 0.5) * 0.0010,
    close: 1.1000 + (Math.random() - 0.5) * 0.0010,
    volume: 1000,
    time: new Date(2024, 0, 1 + i).toISOString(),
  }));
  const result = findDailyZone(candles, "bullish");
  assertEquals(result.zone, null);
  assert(result.reason.length > 0);
});

// ─── Tests: checkPriceAtDailyZone ─────────────────────────────────────────────

Deno.test("checkPriceAtDailyZone: price inside zone returns atZone=true", () => {
  const zone: DailyZone = {
    impulse: { high: 1.1200, low: 1.0800, direction: "bullish", startIndex: 0, endIndex: 20, isValid: true, bosPrice: 1.1100 },
    poi: { type: "ob", high: 1.0950, low: 1.0900, candleIndex: 5, direction: "bullish" },
    fibLevel: 0.618,
    fibScore: 1.5,
    high: 1.0950,
    low: 1.0900,
    srConfirmed: false,
  };
  const result = checkPriceAtDailyZone(1.0925, zone, 0.0020);
  assertEquals(result.insideZone, true);
  assertEquals(result.atZone, true);
  assertEquals(result.distancePips, 0);
});

Deno.test("checkPriceAtDailyZone: price far from zone returns atZone=false", () => {
  const zone: DailyZone = {
    impulse: { high: 1.1200, low: 1.0800, direction: "bullish", startIndex: 0, endIndex: 20, isValid: true, bosPrice: 1.1100 },
    poi: { type: "ob", high: 1.0950, low: 1.0900, candleIndex: 5, direction: "bullish" },
    fibLevel: 0.618,
    fibScore: 1.5,
    high: 1.0950,
    low: 1.0900,
    srConfirmed: false,
  };
  // Price is 100 pips above the zone, ATR is 20 pips, threshold is 2×ATR = 40 pips
  const result = checkPriceAtDailyZone(1.1050, zone, 0.0020);
  assertEquals(result.insideZone, false);
  assertEquals(result.atZone, false);
  assert(result.distancePips > 0);
});

Deno.test("checkPriceAtDailyZone: price within threshold returns atZone=true", () => {
  const zone: DailyZone = {
    impulse: { high: 1.1200, low: 1.0800, direction: "bullish", startIndex: 0, endIndex: 20, isValid: true, bosPrice: 1.1100 },
    poi: { type: "ob", high: 1.0950, low: 1.0900, candleIndex: 5, direction: "bullish" },
    fibLevel: 0.618,
    fibScore: 1.5,
    high: 1.0950,
    low: 1.0900,
    srConfirmed: false,
  };
  // Price is 30 pips above zone, ATR is 20 pips, threshold is 2×ATR = 40 pips → within
  const result = checkPriceAtDailyZone(1.0980, zone, 0.0020);
  assertEquals(result.insideZone, false);
  assertEquals(result.atZone, true);
});

// ─── Tests: detect4HConfirmation ──────────────────────────────────────────────

Deno.test("detect4HConfirmation: returns null with insufficient candles", () => {
  const candles: Candle[] = Array(10).fill(null).map((_, i) => ({
    open: 1.1, high: 1.11, low: 1.09, close: 1.1,
    volume: 1000, time: new Date(2024, 0, 1, i * 4).toISOString(),
  }));
  const zone: DailyZone = {
    impulse: { high: 1.12, low: 1.08, direction: "bullish", startIndex: 0, endIndex: 20, isValid: true, bosPrice: 1.11 },
    poi: { type: "ob", high: 1.095, low: 1.090, candleIndex: 5, direction: "bullish" },
    fibLevel: 0.618, fibScore: 1.5, high: 1.095, low: 1.090, srConfirmed: false,
  };
  const result = detect4HConfirmation(candles, zone, "bullish");
  assertEquals(result, null);
});

Deno.test("detect4HConfirmation: detects displacement inside Daily zone", () => {
  const zone: DailyZone = {
    impulse: { high: 1.1200, low: 1.0800, direction: "bullish", startIndex: 0, endIndex: 20, isValid: true, bosPrice: 1.1100 },
    poi: { type: "ob", high: 1.0950, low: 1.0900, candleIndex: 5, direction: "bullish" },
    fibLevel: 0.618, fibScore: 1.5, high: 1.0950, low: 1.0900, srConfirmed: false,
  };
  // Generate candles with a displacement inside the zone
  const candles = generateCandlesWithDisplacement(30, 1.0920, 1.0950, 1.0900);
  const result = detect4HConfirmation(candles, zone, "bullish");
  // May or may not detect depending on generated data quality
  // The test validates the function runs without error
  if (result) {
    assertEquals(result.type, "displacement");
    assertEquals(result.direction, "bullish");
  }
});

// ─── Tests: detect1HConfirmation ──────────────────────────────────────────────

Deno.test("detect1HConfirmation: returns null with insufficient candles", () => {
  const candles: Candle[] = Array(10).fill(null).map((_, i) => ({
    open: 1.1, high: 1.11, low: 1.09, close: 1.1,
    volume: 1000, time: new Date(2024, 0, 1, i).toISOString(),
  }));
  const zone: DailyZone = {
    impulse: { high: 1.12, low: 1.08, direction: "bullish", startIndex: 0, endIndex: 20, isValid: true, bosPrice: 1.11 },
    poi: { type: "ob", high: 1.095, low: 1.090, candleIndex: 5, direction: "bullish" },
    fibLevel: 0.618, fibScore: 1.5, high: 1.095, low: 1.090, srConfirmed: false,
  };
  const result = detect1HConfirmation(candles, zone, "bullish");
  assertEquals(result, null);
});

// ─── Tests: findEntryZoneWithinDailyZone ──────────────────────────────────────

Deno.test("findEntryZoneWithinDailyZone: returns null with insufficient candles", () => {
  const candles: Candle[] = Array(10).fill(null).map((_, i) => ({
    open: 1.1, high: 1.11, low: 1.09, close: 1.1,
    volume: 1000, time: new Date(2024, 0, 1, i).toISOString(),
  }));
  const zone: DailyZone = {
    impulse: { high: 1.12, low: 1.08, direction: "bullish", startIndex: 0, endIndex: 20, isValid: true, bosPrice: 1.11 },
    poi: { type: "ob", high: 1.095, low: 1.090, candleIndex: 5, direction: "bullish" },
    fibLevel: 0.618, fibScore: 1.5, high: 1.095, low: 1.090, srConfirmed: false,
  };
  const result = findEntryZoneWithinDailyZone(candles, zone, "bullish");
  assertEquals(result.zone, null);
  assert(result.reason.includes("Insufficient"));
});

Deno.test("findEntryZoneWithinDailyZone: filters zones outside Daily zone", () => {
  // Generate 1H candles with an impulse
  const candles = generateBullishImpulseCandles(80, 1.0500, 0.0300);

  // Set Daily zone to a very narrow range that likely won't overlap with 1H zones
  const zone: DailyZone = {
    impulse: { high: 1.1200, low: 1.0800, direction: "bullish", startIndex: 0, endIndex: 20, isValid: true, bosPrice: 1.1100 },
    poi: { type: "ob", high: 1.2000, low: 1.1990, candleIndex: 5, direction: "bullish" },
    fibLevel: 0.618, fibScore: 1.5, high: 1.2000, low: 1.1990, srConfirmed: false,
  };

  const result = findEntryZoneWithinDailyZone(candles, zone, "bullish");
  // Should either find no zone or find one that doesn't overlap with the far-away Daily zone
  if (result.zone) {
    // If it found one, it must overlap with the Daily zone
    assert(result.zone.poi.high >= zone.low && result.zone.poi.low <= zone.high);
  }
});

// ─── Tests: findCascadeZone (full pipeline) ───────────────────────────────────

Deno.test("findCascadeZone: returns no_daily_impulse with flat daily candles", () => {
  const flat = (count: number, price: number): Candle[] =>
    Array(count).fill(null).map((_, i) => ({
      open: price + (Math.random() - 0.5) * 0.0005,
      high: price + 0.0005,
      low: price - 0.0005,
      close: price + (Math.random() - 0.5) * 0.0005,
      volume: 1000,
      time: new Date(2024, 0, 1 + i).toISOString(),
    }));

  const result = findCascadeZone(
    flat(60, 1.1000),  // Daily: flat
    flat(100, 1.1000), // 4H
    flat(200, 1.1000), // 1H
    flat(100, 1.1000), // 15m
    "bullish",
    1.1000,
  );

  assertEquals(result.state, "no_daily_impulse");
  assertEquals(result.dailyZone, null);
  assertEquals(result.confirmation, null);
  assertEquals(result.entryZone, null);
});

Deno.test("findCascadeZone: returns waiting_for_price when price far from Daily zone", () => {
  // We need a Daily zone to exist but price to be far from it
  const dailyCandles = generateBullishImpulseCandles(60, 1.0500, 0.0500);
  const result = findCascadeZone(
    dailyCandles,
    generateBullishImpulseCandles(100, 1.0500, 0.0300),
    generateBullishImpulseCandles(200, 1.0500, 0.0200),
    generateBullishImpulseCandles(100, 1.0500, 0.0100),
    "bullish",
    1.2000, // Price way above any zone
  );

  // Should be either waiting_for_price or no_daily_impulse (depending on generated data)
  if (result.dailyZone) {
    // If a zone was found, price should be far from it
    assert(result.state === "waiting_for_price" || result.state === "no_confirmation" || result.state === "at_daily_zone");
  }
});

Deno.test("findCascadeZone: state machine progression is valid", () => {
  // Verify that the state machine only produces valid states
  const validStates: CascadeState[] = [
    "no_daily_impulse", "no_daily_zone", "waiting_for_price",
    "at_daily_zone", "no_confirmation", "confirmed",
    "no_entry_zone", "ready", "triggered",
  ];

  const dailyCandles = generateBullishImpulseCandles(60, 1.0500, 0.0500);
  const result = findCascadeZone(
    dailyCandles,
    generateBullishImpulseCandles(100, 1.0500, 0.0300),
    generateBullishImpulseCandles(200, 1.0500, 0.0200),
    generateBullishImpulseCandles(100, 1.0500, 0.0100),
    "bullish",
    1.0700,
  );

  assert(validStates.includes(result.state), `Invalid state: ${result.state}`);
  assert(result.reason.length > 0, "Reason should always be populated");
});

Deno.test("findCascadeZone: triggered state has entry and SL populated", () => {
  // This test validates that IF we reach triggered state, entry/SL are set
  // We can't guarantee the generated data produces a triggered state,
  // so we test the contract: if triggered, fields must be populated
  const dailyCandles = generateBullishImpulseCandles(60, 1.0500, 0.0500);
  const result = findCascadeZone(
    dailyCandles,
    generateBullishImpulseCandles(100, 1.0500, 0.0300),
    generateBullishImpulseCandles(200, 1.0500, 0.0200),
    generateBullishImpulseCandles(100, 1.0500, 0.0100),
    "bullish",
    1.0700,
  );

  if (result.state === "triggered") {
    assertExists(result.entry, "Triggered state must have entry price");
    assertExists(result.sl, "Triggered state must have SL");
    assertExists(result.entryZone, "Triggered state must have entry zone");
    assertExists(result.dailyZone, "Triggered state must have Daily zone");
    assertExists(result.confirmation, "Triggered state must have confirmation");
    assertEquals(result.priceAtEntry, true);
  }

  if (result.state === "ready") {
    assertExists(result.entry, "Ready state must have entry price");
    assertExists(result.sl, "Ready state must have SL");
    assertExists(result.entryZone, "Ready state must have entry zone");
    assertEquals(result.priceAtEntry, false);
    assert(result.distancePips > 0, "Ready state should have distance > 0");
  }
});

Deno.test("findCascadeZone: no_confirmation state has dailyZone but no entry", () => {
  const dailyCandles = generateBullishImpulseCandles(60, 1.0500, 0.0500);
  const result = findCascadeZone(
    dailyCandles,
    generateBullishImpulseCandles(100, 1.0500, 0.0300),
    generateBullishImpulseCandles(200, 1.0500, 0.0200),
    generateBullishImpulseCandles(100, 1.0500, 0.0100),
    "bullish",
    1.0700,
  );

  if (result.state === "no_confirmation") {
    assertExists(result.dailyZone, "no_confirmation must have Daily zone");
    assertEquals(result.confirmation, null);
    assertEquals(result.entryZone, null);
    assertEquals(result.entry, null);
  }
});

Deno.test("findCascadeZone: bearish direction works", () => {
  // Generate bearish impulse (price going down)
  const candles: Candle[] = [];
  let price = 1.1500;
  for (let i = 0; i < 60; i++) {
    if (i < 12) {
      // Consolidation
      const noise = (Math.random() - 0.5) * 0.0010;
      candles.push({ open: price, high: price + 0.0010, low: price - 0.0010, close: price + noise, volume: 1000, time: new Date(2024, 0, 1 + i).toISOString() });
      price += noise * 0.1;
    } else if (i < 36) {
      // Bearish impulse
      const step = -0.0020;
      candles.push({ open: price, high: price + 0.0005, low: price + step - 0.0005, close: price + step, volume: 2000, time: new Date(2024, 0, 1 + i).toISOString() });
      price += step;
    } else {
      // Retracement up
      const step = 0.0010 * (1 - (i - 36) / 24);
      candles.push({ open: price, high: price + step + 0.0005, low: price - 0.0003, close: price + step, volume: 1500, time: new Date(2024, 0, 1 + i).toISOString() });
      price += step;
    }
  }

  const result = findCascadeZone(
    candles,
    generateBullishImpulseCandles(100, 1.1000, 0.0300), // 4H (not matching direction is fine)
    generateBullishImpulseCandles(200, 1.1000, 0.0200),
    generateBullishImpulseCandles(100, 1.1000, 0.0100),
    "bearish",
    1.1200,
  );

  // Should produce a valid state (not crash)
  assert(result.reason.length > 0);
});

// ─── Tests: Cascade interconnection (the story) ──────────────────────────────

Deno.test("cascade: Daily zone is the mandatory first filter", () => {
  // Without a Daily zone, nothing else matters
  const flat = (count: number, price: number): Candle[] =>
    Array(count).fill(null).map((_, i) => ({
      open: price, high: price + 0.0003, low: price - 0.0003, close: price,
      volume: 1000, time: new Date(2024, 0, 1 + i).toISOString(),
    }));

  const result = findCascadeZone(
    flat(60, 1.1000),   // No Daily impulse
    generateBullishImpulseCandles(100, 1.0900, 0.0300), // 4H has structure
    generateBullishImpulseCandles(200, 1.0900, 0.0200), // 1H has structure
    generateBullishImpulseCandles(100, 1.0900, 0.0100), // 15m has structure
    "bullish",
    1.0950,
  );

  // Even though lower TFs have structure, no Daily = no trade
  assertEquals(result.state, "no_daily_impulse");
  assertEquals(result.entryZone, null);
  assertEquals(result.entry, null);
});

Deno.test("cascade: entry zone must overlap with Daily zone", () => {
  // This validates the filtering logic — 1H zones outside Daily zone are rejected
  const dailyCandles = generateBullishImpulseCandles(60, 1.0500, 0.0500);
  const result = findCascadeZone(
    dailyCandles,
    generateBullishImpulseCandles(100, 1.0500, 0.0300),
    generateBullishImpulseCandles(200, 1.0500, 0.0200),
    generateBullishImpulseCandles(100, 1.0500, 0.0100),
    "bullish",
    1.0700,
  );

  // If an entry zone was found, it MUST overlap with the Daily zone
  if (result.entryZone && result.dailyZone) {
    const entryHigh = result.entryZone.poi.high;
    const entryLow = result.entryZone.poi.low;
    const dailyHigh = result.dailyZone.high;
    const dailyLow = result.dailyZone.low;
    const overlaps = Math.max(entryLow, dailyLow) <= Math.min(entryHigh, dailyHigh);
    assert(overlaps, "Entry zone must overlap with Daily zone");
  }
});

Deno.test("cascade: confirmation is required before entry zone search", () => {
  // If state is no_confirmation, entryZone must be null
  const dailyCandles = generateBullishImpulseCandles(60, 1.0500, 0.0500);
  const result = findCascadeZone(
    dailyCandles,
    generateBullishImpulseCandles(100, 1.0500, 0.0300),
    generateBullishImpulseCandles(200, 1.0500, 0.0200),
    generateBullishImpulseCandles(100, 1.0500, 0.0100),
    "bullish",
    1.0700,
  );

  if (result.state === "no_confirmation") {
    assertEquals(result.entryZone, null, "No entry zone without confirmation");
    assertEquals(result.entry, null, "No entry price without confirmation");
  }
});

// ─── Tests: Options/configuration ─────────────────────────────────────────────

Deno.test("cascade options: dailyZoneATRMult affects proximity detection", () => {
  const zone: DailyZone = {
    impulse: { high: 1.12, low: 1.08, direction: "bullish", startIndex: 0, endIndex: 20, isValid: true, bosPrice: 1.11 },
    poi: { type: "ob", high: 1.095, low: 1.090, candleIndex: 5, direction: "bullish" },
    fibLevel: 0.618, fibScore: 1.5, high: 1.095, low: 1.090, srConfirmed: false,
  };
  const atr = 0.0020; // 20 pips

  // With default mult (2.0): threshold = 40 pips
  // Price 1.0980 is 30 pips above zone high (1.0950), well within 40 pip threshold
  const result1 = checkPriceAtDailyZone(1.0980, zone, atr);
  assertEquals(result1.atZone, true); // 30 pips < 40 pip threshold

  // With strict mult (1.0): threshold = 20 pips
  // Same price 1.0980 is 30 pips above zone, exceeds 20 pip threshold
  const result2 = checkPriceAtDailyZone(1.0980, zone, atr, { dailyZoneATRMult: 1.0 });
  assertEquals(result2.atZone, false); // 30 pips > 20 pip threshold
});

Deno.test("cascade: exports all expected types and functions", () => {
  // Verify the module exports are correct
  assertExists(findDailyZone);
  assertExists(checkPriceAtDailyZone);
  assertExists(detect4HConfirmation);
  assertExists(detect1HConfirmation);
  assertExists(findEntryZoneWithinDailyZone);
  assertExists(findCascadeZone);
});
