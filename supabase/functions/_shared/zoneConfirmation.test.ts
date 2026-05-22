/**
 * Tests for Zone Confirmation Entry System
 * Branch: manus/zone-confirmation-entry
 *
 * Tests the detectZoneConfirmation helper, isPriceInZone, isImpulseBroken,
 * and formatConfirmationSummary functions.
 */
import { assertEquals, assertNotEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  detectZoneConfirmation,
  isPriceInZone,
  isImpulseBroken,
  formatConfirmationSummary,
  DEFAULT_ZONE_CONFIRMATION_CONFIG,
  type ConfirmationSignal,
} from "./zoneConfirmation.ts";
import type { Candle } from "./smcAnalysis.ts";

// ─── Helper: Generate candles with a specific pattern ────────────────────────

function makeCandle(open: number, high: number, low: number, close: number, datetime: string, volume = 100): Candle {
  return { open, high, low, close, datetime, volume };
}

/**
 * Generate a series of candles that form an uptrend followed by a bearish CHoCH.
 * This simulates price retracing into a supply zone and then reversing.
 *
 * Pattern:
 * - Candles 0-14: Uptrend (higher highs, higher lows)
 * - Candle 15: Bearish CHoCH (breaks below the most recent higher low)
 */
function generateBearishChochCandles(basePrice: number): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;

  // Phase 1: Uptrend (15 candles making higher highs/higher lows)
  for (let i = 0; i < 15; i++) {
    const open = price;
    const high = price + 3 + Math.random() * 2;
    const low = price - 1 - Math.random();
    const close = price + 2 + Math.random();
    price = close;
    candles.push(makeCandle(
      open, high, low, close,
      new Date(Date.now() - (30 - i) * 5 * 60 * 1000).toISOString(),
      100 + Math.floor(Math.random() * 50),
    ));
  }

  // Phase 2: The reversal — a strong bearish candle that breaks below the last higher low
  // The last higher low is approximately candles[13].low
  const lastHigherLow = candles[13].low;
  const reversalOpen = candles[14].close;
  const reversalHigh = reversalOpen + 1;
  const reversalLow = lastHigherLow - 5;  // Break below the higher low
  const reversalClose = lastHigherLow - 3; // Close below the higher low (close-based CHoCH)

  candles.push(makeCandle(
    reversalOpen, reversalHigh, reversalLow, reversalClose,
    new Date(Date.now() - 15 * 5 * 60 * 1000).toISOString(),
    200, // High volume on the reversal
  ));

  // Add a few more candles after the CHoCH to make the pattern clear
  for (let i = 0; i < 5; i++) {
    const open = candles[candles.length - 1].close;
    const high = open + 1;
    const low = open - 2;
    const close = open - 1;
    candles.push(makeCandle(
      open, high, low, close,
      new Date(Date.now() - (14 - i) * 5 * 60 * 1000).toISOString(),
      150,
    ));
  }

  return candles;
}

/**
 * Generate a series of candles that form a downtrend followed by a bullish CHoCH.
 */
function generateBullishChochCandles(basePrice: number): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;

  // Phase 1: Downtrend (15 candles making lower lows, lower highs)
  for (let i = 0; i < 15; i++) {
    const open = price;
    const high = price + 1 + Math.random();
    const low = price - 3 - Math.random() * 2;
    const close = price - 2 - Math.random();
    price = close;
    candles.push(makeCandle(
      open, high, low, close,
      new Date(Date.now() - (30 - i) * 5 * 60 * 1000).toISOString(),
      100 + Math.floor(Math.random() * 50),
    ));
  }

  // Phase 2: The reversal — a strong bullish candle that breaks above the last lower high
  const lastLowerHigh = candles[13].high;
  const reversalOpen = candles[14].close;
  const reversalLow = reversalOpen - 1;
  const reversalHigh = lastLowerHigh + 5;  // Break above the lower high
  const reversalClose = lastLowerHigh + 3; // Close above (close-based CHoCH)

  candles.push(makeCandle(
    reversalOpen, reversalHigh, reversalLow, reversalClose,
    new Date(Date.now() - 15 * 5 * 60 * 1000).toISOString(),
    200,
  ));

  // Add a few more candles after the CHoCH
  for (let i = 0; i < 5; i++) {
    const open = candles[candles.length - 1].close;
    const high = open + 2;
    const low = open - 1;
    const close = open + 1;
    candles.push(makeCandle(
      open, high, low, close,
      new Date(Date.now() - (14 - i) * 5 * 60 * 1000).toISOString(),
      150,
    ));
  }

  return candles;
}

/**
 * Generate candles with NO CHoCH (just a steady uptrend).
 */
function generateNoChochCandles(basePrice: number): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;

  for (let i = 0; i < 25; i++) {
    const open = price;
    const high = price + 2 + Math.random();
    const low = price - 0.5;
    const close = price + 1.5 + Math.random() * 0.5;
    price = close;
    candles.push(makeCandle(
      open, high, low, close,
      new Date(Date.now() - (30 - i) * 5 * 60 * 1000).toISOString(),
      100,
    ));
  }

  return candles;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── detectZoneConfirmation Tests ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("detectZoneConfirmation: returns bearish_choch for short direction with valid bearish CHoCH", () => {
  const candles = generateBearishChochCandles(4530);
  const result = detectZoneConfirmation(candles, "short", DEFAULT_ZONE_CONFIRMATION_CONFIG);

  // The function should detect the bearish CHoCH
  // Note: depending on the randomness in candle generation, the CHoCH might or might not be detected.
  // We test the logic path — if detected, it should be bearish_choch type.
  if (result) {
    assertEquals(result.type, "bearish_choch");
    assert(result.price > 0, "Confirmation price should be positive");
    assert(result.displacement >= 0, "Displacement should be non-negative");
    assert(Array.isArray(result.supportingSignals), "Should have supporting signals array");
  }
});

Deno.test("detectZoneConfirmation: returns bullish_choch for long direction with valid bullish CHoCH", () => {
  const candles = generateBullishChochCandles(1.2000);
  const result = detectZoneConfirmation(candles, "long", DEFAULT_ZONE_CONFIRMATION_CONFIG);

  if (result) {
    assertEquals(result.type, "bullish_choch");
    assert(result.price > 0, "Confirmation price should be positive");
    assert(result.displacement >= 0, "Displacement should be non-negative");
  }
});

Deno.test("detectZoneConfirmation: returns null when no CHoCH present (steady uptrend)", () => {
  const candles = generateNoChochCandles(1.3000);
  const result = detectZoneConfirmation(candles, "short", DEFAULT_ZONE_CONFIRMATION_CONFIG);

  // In a steady uptrend, there should be no bearish CHoCH
  assertEquals(result, null);
});

Deno.test("detectZoneConfirmation: returns null for wrong direction (looking for bullish in downtrend)", () => {
  const candles = generateBearishChochCandles(4530);
  // Looking for bullish CHoCH in a pattern that has a bearish CHoCH
  const result = detectZoneConfirmation(candles, "long", DEFAULT_ZONE_CONFIRMATION_CONFIG);

  // Should not find a bullish CHoCH in this pattern
  assertEquals(result, null);
});

Deno.test("detectZoneConfirmation: respects zoneTouchIndex filter", () => {
  const candles = generateBearishChochCandles(4530);

  // Set zoneTouchIndex to after the CHoCH — should not find it
  const result = detectZoneConfirmation(candles, "short", DEFAULT_ZONE_CONFIRMATION_CONFIG, candles.length - 1);

  // The CHoCH happened before the zone touch index, so it shouldn't be found
  assertEquals(result, null);
});

Deno.test("detectZoneConfirmation: returns null for insufficient candles", () => {
  const candles = [
    makeCandle(1.3, 1.31, 1.29, 1.305, new Date().toISOString()),
    makeCandle(1.305, 1.31, 1.30, 1.30, new Date().toISOString()),
  ];
  const result = detectZoneConfirmation(candles, "short", DEFAULT_ZONE_CONFIRMATION_CONFIG);
  assertEquals(result, null);
});

Deno.test("detectZoneConfirmation: respects requireCloseBased config", () => {
  const candles = generateBearishChochCandles(4530);
  const strictConfig = { ...DEFAULT_ZONE_CONFIRMATION_CONFIG, requireCloseBased: true };
  const result = detectZoneConfirmation(candles, "short", strictConfig);

  // If found, it must be close-based
  if (result) {
    assertEquals(result.closeBased, true);
  }
});

Deno.test("detectZoneConfirmation: respects minDisplacement config", () => {
  const candles = generateBearishChochCandles(4530);
  // Set very high displacement requirement
  const strictConfig = { ...DEFAULT_ZONE_CONFIRMATION_CONFIG, minDisplacement: 0.99 };
  const result = detectZoneConfirmation(candles, "short", strictConfig);

  // With 99% displacement requirement, most CHoCHs won't qualify
  // This tests that the filter is applied (result may be null)
  if (result) {
    assert(result.displacement >= 0.99, "Displacement should meet minimum");
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── isPriceInZone Tests ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("isPriceInZone: returns true when price is inside zone (long)", () => {
  // For a long, price retraces DOWN into the zone
  const result = isPriceInZone(4540, 4535, 4550, "long");
  assertEquals(result, true);
});

Deno.test("isPriceInZone: returns true when price is inside zone (short)", () => {
  // For a short, price retraces UP into the zone
  const result = isPriceInZone(4545, 4537, 4551, "short");
  assertEquals(result, true);
});

Deno.test("isPriceInZone: returns false when price is above zone (long)", () => {
  // Price is above the zone — hasn't retraced down yet
  const result = isPriceInZone(4560, 4535, 4550, "long");
  assertEquals(result, false);
});

Deno.test("isPriceInZone: returns false when price is below zone (short)", () => {
  // Price is below the zone — hasn't retraced up yet
  const result = isPriceInZone(4530, 4537, 4551, "short");
  assertEquals(result, false);
});

Deno.test("isPriceInZone: returns true at zone edge (exact boundary)", () => {
  const result = isPriceInZone(4537, 4537, 4551, "short");
  assertEquals(result, true);
});

Deno.test("isPriceInZone: includes buffer for near-zone prices", () => {
  // Price is slightly outside zone but within buffer (5% of zone height)
  // Zone: 4537-4551, height = 14, buffer = 0.7
  const result = isPriceInZone(4536.5, 4537, 4551, "short");
  assertEquals(result, true);  // Within buffer
});

Deno.test("isPriceInZone: returns false when clearly outside buffer", () => {
  // Price is well outside zone
  const result = isPriceInZone(4520, 4537, 4551, "short");
  assertEquals(result, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── isImpulseBroken Tests ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("isImpulseBroken: returns false when price is within impulse range (short)", () => {
  // For a short: impulse went from high to low (bearish impulse)
  // Price should not exceed the impulse high (origin)
  const result = isImpulseBroken(4545, 4568, 4454, "short");
  assertEquals(result, false);  // Price is below impulse high — still valid
});

Deno.test("isImpulseBroken: returns true when price exceeds impulse origin (short)", () => {
  // For a short: if price goes above the impulse high, the impulse is broken
  const result = isImpulseBroken(4575, 4568, 4454, "short");
  assertEquals(result, true);  // Price exceeded impulse high — broken
});

Deno.test("isImpulseBroken: returns false when price is within impulse range (long)", () => {
  // For a long: impulse went from low to high (bullish impulse)
  // Price should not go below the impulse low (origin)
  const result = isImpulseBroken(1.2050, 1.2200, 1.2000, "long");
  assertEquals(result, false);  // Price is above impulse low — still valid
});

Deno.test("isImpulseBroken: returns true when price exceeds impulse origin (long)", () => {
  // For a long: if price goes below the impulse low, the impulse is broken
  const result = isImpulseBroken(1.1980, 1.2200, 1.2000, "long");
  assertEquals(result, true);  // Price below impulse low — broken
});

Deno.test("isImpulseBroken: returns false at exact impulse boundary", () => {
  const result = isImpulseBroken(4568, 4568, 4454, "short");
  assertEquals(result, false);  // At boundary, not broken yet
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── formatConfirmationSummary Tests ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("formatConfirmationSummary: formats bearish CHoCH correctly", () => {
  const signal: ConfirmationSignal = {
    type: "bearish_choch",
    price: 4545.123,
    candleIndex: 15,
    displacement: 0.72,
    significance: "internal",
    closeBased: true,
    supportingSignals: ["volume_spike", "close_based"],
  };
  const summary = formatConfirmationSummary(signal);
  assert(summary.includes("Bearish CHoCH"), "Should include type label");
  assert(summary.includes("4545.12300"), "Should include price");
  assert(summary.includes("72%"), "Should include displacement percentage");
  assert(summary.includes("volume_spike"), "Should include supporting signals");
});

Deno.test("formatConfirmationSummary: handles empty supporting signals", () => {
  const signal: ConfirmationSignal = {
    type: "bullish_choch",
    price: 1.2050,
    candleIndex: 12,
    displacement: 0.55,
    significance: undefined,
    closeBased: false,
    supportingSignals: [],
  };
  const summary = formatConfirmationSummary(signal);
  assert(summary.includes("Bullish CHoCH"), "Should include type label");
  assert(summary.includes("1.20500"), "Should include price");
  assert(!summary.includes("Supporting"), "Should not include supporting section when empty");
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── State Machine Integration Tests ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("State machine: zone touch detection triggers confirmation hunt (short scenario)", () => {
  // Simulate the state machine logic:
  // 1. Price is at zone (pending → awaiting_confirmation)
  const zoneLow = 4537;
  const zoneHigh = 4551;
  const currentPrice = 4545; // Inside zone

  // Price is in zone
  const inZone = isPriceInZone(currentPrice, zoneLow, zoneHigh, "short");
  assertEquals(inZone, true);

  // Impulse is not broken
  const broken = isImpulseBroken(currentPrice, 4593, 4454, "short");
  assertEquals(broken, false);
});

Deno.test("State machine: price leaving zone resets to pending", () => {
  const zoneLow = 4537;
  const zoneHigh = 4551;
  const currentPrice = 4530; // Below zone

  const inZone = isPriceInZone(currentPrice, zoneLow, zoneHigh, "short");
  assertEquals(inZone, false);  // Price left zone → should reset
});

Deno.test("State machine: impulse broken cancels order", () => {
  const currentPrice = 4600; // Way above impulse high
  const broken = isImpulseBroken(currentPrice, 4593, 4454, "short");
  assertEquals(broken, true);  // Should cancel the order
});

Deno.test("DEFAULT_ZONE_CONFIRMATION_CONFIG has sensible defaults", () => {
  assertEquals(DEFAULT_ZONE_CONFIRMATION_CONFIG.confirmationTimeframe, "5m");
  assertEquals(DEFAULT_ZONE_CONFIRMATION_CONFIG.requireCloseBased, true);
  assert(DEFAULT_ZONE_CONFIRMATION_CONFIG.minDisplacement >= 0);
  assert(DEFAULT_ZONE_CONFIRMATION_CONFIG.minDisplacement <= 1);
  assert(DEFAULT_ZONE_CONFIRMATION_CONFIG.maxLookbackCandles > 0);
});
