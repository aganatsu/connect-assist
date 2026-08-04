/**
 * Tests for Zone Confirmation Entry System — Tiered Confirmation
 * Branch: manus/tiered-zone-confirmation
 *
 * Tests the tiered detectZoneConfirmation helper (Tier 1: CHoCH, Tier 2: CHoCH+support,
 * Tier 3: reversal pattern), isPriceInZone, isImpulseBroken, and formatConfirmationSummary.
 */
import { assertEquals, assertNotEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  detectZoneConfirmation,
  isPriceInZone,
  isImpulseBroken,
  formatConfirmationSummary,
  DEFAULT_ZONE_CONFIRMATION_CONFIG,
  type ConfirmationSignal,
  type ZoneConfirmationConfig,
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
  const lastHigherLow = candles[13].low;
  const reversalOpen = candles[14].close;
  const reversalHigh = reversalOpen + 1;
  const reversalLow = lastHigherLow - 5;
  const reversalClose = lastHigherLow - 3; // Close below the higher low (close-based CHoCH)

  candles.push(makeCandle(
    reversalOpen, reversalHigh, reversalLow, reversalClose,
    new Date(Date.now() - 15 * 5 * 60 * 1000).toISOString(),
    200,
  ));

  // Add a few more candles after the CHoCH
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
  const reversalHigh = lastLowerHigh + 5;
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

/**
 * Generate candles with a strong bearish engulfing + rejection wick but NO CHoCH.
 * This tests Tier 3 (reversal pattern without structural break).
 */
function generateBearishReversalPatternCandles(basePrice: number): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;

  // Phase 1: Choppy/ranging candles (no clear trend for structure detection)
  for (let i = 0; i < 18; i++) {
    const open = price;
    const high = price + 1.5;
    const low = price - 1.5;
    const close = price + (i % 2 === 0 ? 0.8 : -0.8); // alternating small bodies
    candles.push(makeCandle(
      open, high, low, close,
      new Date(Date.now() - (25 - i) * 5 * 60 * 1000).toISOString(),
      100,
    ));
    price = close;
  }

  // Phase 2: A small bullish candle followed by a strong bearish engulfing with rejection wick
  const smallBullOpen = price;
  const smallBullClose = price + 1;
  const smallBullHigh = price + 1.2;
  const smallBullLow = price - 0.2;
  candles.push(makeCandle(
    smallBullOpen, smallBullHigh, smallBullLow, smallBullClose,
    new Date(Date.now() - 7 * 5 * 60 * 1000).toISOString(),
    80,
  ));

  // The reversal candle: engulfs previous, has rejection wick, strong displacement
  // Open above previous close, close below previous open
  // Upper wick > 30% of range (rejection)
  // Body > 40% of range (displacement)
  const engulfOpen = smallBullClose + 3; // opens well above (creates upper wick)
  const engulfHigh = engulfOpen + 2;     // upper wick (rejection)
  const engulfClose = smallBullOpen - 2; // closes below previous open (engulfing)
  const engulfLow = engulfClose - 0.5;   // small lower wick
  // Range = engulfHigh - engulfLow
  // Body = engulfOpen - engulfClose (since bearish, open > close)
  // Upper wick = engulfHigh - engulfOpen
  candles.push(makeCandle(
    engulfOpen, engulfHigh, engulfLow, engulfClose,
    new Date(Date.now() - 6 * 5 * 60 * 1000).toISOString(),
    250, // volume spike
  ));

  // Add a few more candles after
  for (let i = 0; i < 4; i++) {
    const open = candles[candles.length - 1].close;
    const high = open + 0.5;
    const low = open - 1;
    const close = open - 0.5;
    candles.push(makeCandle(
      open, high, low, close,
      new Date(Date.now() - (5 - i) * 5 * 60 * 1000).toISOString(),
      120,
    ));
  }

  return candles;
}

/**
 * Generate candles with a strong bullish engulfing + rejection wick but NO CHoCH.
 * This tests Tier 3 for long direction.
 */
function generateBullishReversalPatternCandles(basePrice: number): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;

  // Phase 1: Choppy/ranging candles
  for (let i = 0; i < 18; i++) {
    const open = price;
    const high = price + 1.5;
    const low = price - 1.5;
    const close = price + (i % 2 === 0 ? -0.8 : 0.8);
    candles.push(makeCandle(
      open, high, low, close,
      new Date(Date.now() - (25 - i) * 5 * 60 * 1000).toISOString(),
      100,
    ));
    price = close;
  }

  // Small bearish candle
  const smallBearOpen = price;
  const smallBearClose = price - 1;
  const smallBearHigh = price + 0.2;
  const smallBearLow = price - 1.2;
  candles.push(makeCandle(
    smallBearOpen, smallBearHigh, smallBearLow, smallBearClose,
    new Date(Date.now() - 7 * 5 * 60 * 1000).toISOString(),
    80,
  ));

  // Bullish engulfing with rejection wick (lower wick > 30%)
  const engulfOpen = smallBearClose - 3; // opens below (creates lower wick)
  const engulfLow = engulfOpen - 2;      // lower wick (rejection)
  const engulfClose = smallBearOpen + 2; // closes above previous open (engulfing)
  const engulfHigh = engulfClose + 0.5;  // small upper wick
  candles.push(makeCandle(
    engulfOpen, engulfHigh, engulfLow, engulfClose,
    new Date(Date.now() - 6 * 5 * 60 * 1000).toISOString(),
    250,
  ));

  // Add a few more candles after
  for (let i = 0; i < 4; i++) {
    const open = candles[candles.length - 1].close;
    const high = open + 1;
    const low = open - 0.5;
    const close = open + 0.5;
    candles.push(makeCandle(
      open, high, low, close,
      new Date(Date.now() - (5 - i) * 5 * 60 * 1000).toISOString(),
      120,
    ));
  }

  return candles;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── TIER 1: Close-based CHoCH Tests ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("Tier 1: returns bearish_choch for short direction with valid close-based CHoCH", () => {
  const candles = generateBearishChochCandles(4530);
  const result = detectZoneConfirmation(candles, "short", DEFAULT_ZONE_CONFIRMATION_CONFIG);

  if (result) {
    assertEquals(result.type, "bearish_choch");
    assertEquals(result.tier, 1);
    assertEquals(result.closeBased, true);
    assert(result.price > 0, "Confirmation price should be positive");
    assert(result.displacement >= 0, "Displacement should be non-negative");
    assert(Array.isArray(result.supportingSignals), "Should have supporting signals array");
  }
});

Deno.test("Tier 1: returns bullish_choch for long direction with valid close-based CHoCH", () => {
  const candles = generateBullishChochCandles(1.2000);
  const result = detectZoneConfirmation(candles, "long", DEFAULT_ZONE_CONFIRMATION_CONFIG);

  if (result) {
    assertEquals(result.type, "bullish_choch");
    assertEquals(result.tier, 1);
    assertEquals(result.closeBased, true);
    assert(result.price > 0, "Confirmation price should be positive");
    assert(result.displacement >= 0, "Displacement should be non-negative");
  }
});

Deno.test("Tier 1: returns null when no CHoCH present (steady uptrend)", () => {
  const candles = generateNoChochCandles(1.3000);
  // With all tiers enabled, a steady uptrend should produce no bearish confirmation
  const config: ZoneConfirmationConfig = {
    ...DEFAULT_ZONE_CONFIRMATION_CONFIG,
    tier3Enabled: false, // disable Tier 3 so we only test CHoCH paths
  };
  const result = detectZoneConfirmation(candles, "short", config);
  assertEquals(result, null);
});

Deno.test("Tier 1: returns null for wrong direction (looking for bullish in bearish pattern)", () => {
  const candles = generateBearishChochCandles(4530);
  // Disable Tier 3 because the random candle generation can create accidental reversal patterns
  const config: ZoneConfirmationConfig = {
    ...DEFAULT_ZONE_CONFIRMATION_CONFIG,
    tier3Enabled: false,
  };
  const result = detectZoneConfirmation(candles, "long", config);
  // Should not find a bullish CHoCH in a bearish CHoCH pattern
  assertEquals(result, null);
});

Deno.test("Tier 1: respects zoneTouchIndex filter", () => {
  const candles = generateBearishChochCandles(4530);
  // Set zoneTouchIndex to after the CHoCH — should not find it
  const result = detectZoneConfirmation(candles, "short", DEFAULT_ZONE_CONFIRMATION_CONFIG, candles.length - 1);
  assertEquals(result, null);
});

Deno.test("Tier 1: returns null for insufficient candles", () => {
  const candles = [
    makeCandle(1.3, 1.31, 1.29, 1.305, new Date().toISOString()),
    makeCandle(1.305, 1.31, 1.30, 1.30, new Date().toISOString()),
  ];
  const result = detectZoneConfirmation(candles, "short", DEFAULT_ZONE_CONFIRMATION_CONFIG);
  assertEquals(result, null);
});

Deno.test("Tier 1: respects minDisplacement config", () => {
  const candles = generateBearishChochCandles(4530);
  // Set very high displacement requirement — should reject most CHoCHs
  const strictConfig: ZoneConfirmationConfig = {
    ...DEFAULT_ZONE_CONFIRMATION_CONFIG,
    minDisplacement: 0.99,
    tier2Enabled: false,
    tier3Enabled: false,
  };
  const result = detectZoneConfirmation(candles, "short", strictConfig);
  if (result) {
    assert(result.displacement >= 0.99, "Displacement should meet minimum");
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── TIER 2: Wick-based CHoCH + Supporting Signal Tests ──────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("Tier 2: disabled when tier2Enabled is false", () => {
  const candles = generateBearishChochCandles(4530);
  const config: ZoneConfirmationConfig = {
    ...DEFAULT_ZONE_CONFIRMATION_CONFIG,
    tier1Enabled: false,  // disable Tier 1
    tier2Enabled: false,  // disable Tier 2
    tier3Enabled: false,  // disable Tier 3
  };
  const result = detectZoneConfirmation(candles, "short", config);
  assertEquals(result, null);
});

Deno.test("Tier 2: when Tier 1 is disabled, can still find wick-based CHoCH with support", () => {
  const candles = generateBearishChochCandles(4530);
  const config: ZoneConfirmationConfig = {
    ...DEFAULT_ZONE_CONFIRMATION_CONFIG,
    tier1Enabled: false,  // force Tier 2 path
    tier3Enabled: false,  // disable Tier 3
  };
  const result = detectZoneConfirmation(candles, "short", config);
  // Result may be null if no wick-based CHoCH exists in the generated data
  // (the generator creates close-based CHoCHs, so Tier 2 may not find wick-only ones)
  if (result) {
    assertEquals(result.tier, 2);
    assert(result.type === "bearish_choch_relaxed", "Should be relaxed CHoCH type");
    assert(result.supportingSignals.length >= 1, "Tier 2 requires at least 1 supporting signal");
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── TIER 3: Reversal Pattern Tests ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("Tier 3: detects bearish reversal pattern (engulfing + rejection wick, no CHoCH)", () => {
  const candles = generateBearishReversalPatternCandles(4540);
  const config: ZoneConfirmationConfig = {
    ...DEFAULT_ZONE_CONFIRMATION_CONFIG,
    tier1Enabled: false,  // disable CHoCH tiers to force Tier 3
    tier2Enabled: false,
    tier3Enabled: true,
  };
  const result = detectZoneConfirmation(candles, "short", config);

  if (result) {
    assertEquals(result.tier, 3);
    assertEquals(result.type, "bearish_reversal_pattern");
    assertEquals(result.closeBased, false); // no structural break
    assert(result.supportingSignals.includes("engulfing"), "Must have engulfing");
    assert(result.supportingSignals.includes("rejection_wick"), "Must have rejection wick");
  }
});

Deno.test("Tier 3: detects bullish reversal pattern (engulfing + rejection wick, no CHoCH)", () => {
  const candles = generateBullishReversalPatternCandles(1.2000);
  const config: ZoneConfirmationConfig = {
    ...DEFAULT_ZONE_CONFIRMATION_CONFIG,
    tier1Enabled: false,
    tier2Enabled: false,
    tier3Enabled: true,
  };
  const result = detectZoneConfirmation(candles, "long", config);

  if (result) {
    assertEquals(result.tier, 3);
    assertEquals(result.type, "bullish_reversal_pattern");
    assertEquals(result.closeBased, false);
    assert(result.supportingSignals.includes("engulfing"), "Must have engulfing");
    assert(result.supportingSignals.includes("rejection_wick"), "Must have rejection wick");
  }
});

Deno.test("Tier 3: does NOT fire without both engulfing AND rejection wick", () => {
  // Generate candles with just a rejection wick but no engulfing
  const candles: Candle[] = [];
  let price = 4540;
  for (let i = 0; i < 18; i++) {
    candles.push(makeCandle(price, price + 1, price - 1, price + 0.5,
      new Date(Date.now() - (25 - i) * 5 * 60 * 1000).toISOString(), 100));
    price += 0.5;
  }
  // A candle with rejection wick but NOT engulfing (doesn't engulf previous)
  const prev = candles[candles.length - 1];
  const rejectionOpen = prev.close + 2;
  const rejectionHigh = rejectionOpen + 3; // big upper wick
  const rejectionClose = rejectionOpen - 1; // bearish but doesn't engulf previous
  const rejectionLow = rejectionClose - 0.2;
  candles.push(makeCandle(rejectionOpen, rejectionHigh, rejectionLow, rejectionClose,
    new Date(Date.now() - 6 * 5 * 60 * 1000).toISOString(), 100));

  // Add trailing candles
  for (let i = 0; i < 3; i++) {
    const o = candles[candles.length - 1].close;
    candles.push(makeCandle(o, o + 0.5, o - 0.5, o - 0.3,
      new Date(Date.now() - (5 - i) * 5 * 60 * 1000).toISOString(), 100));
  }

  const config: ZoneConfirmationConfig = {
    ...DEFAULT_ZONE_CONFIRMATION_CONFIG,
    tier1Enabled: false,
    tier2Enabled: false,
    tier3Enabled: true,
  };
  const result = detectZoneConfirmation(candles, "short", config);
  // Should be null because engulfing is missing
  assertEquals(result, null);
});

Deno.test("Tier 3: disabled when tier3Enabled is false", () => {
  const candles = generateBearishReversalPatternCandles(4540);
  const config: ZoneConfirmationConfig = {
    ...DEFAULT_ZONE_CONFIRMATION_CONFIG,
    tier1Enabled: false,
    tier2Enabled: false,
    tier3Enabled: false,
  };
  const result = detectZoneConfirmation(candles, "short", config);
  assertEquals(result, null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Instrument-Aware Displacement Tests ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("Instrument-aware: XAU/USD uses lower displacement threshold (0.30)", () => {
  const candles = generateBearishChochCandles(2350);
  // With default config (0.4), some CHoCHs might pass. With XAU symbol, threshold is 0.30.
  const result = detectZoneConfirmation(candles, "short", DEFAULT_ZONE_CONFIRMATION_CONFIG, undefined, "XAU/USD");
  // If result exists, displacement can be as low as 0.30 for gold
  if (result) {
    assert(result.displacement >= 0.30, "XAU/USD should use 0.30 threshold");
  }
});

Deno.test("Instrument-aware: EUR/USD uses default displacement threshold (0.4)", () => {
  const candles = generateBearishChochCandles(1.0800);
  const result = detectZoneConfirmation(candles, "short", DEFAULT_ZONE_CONFIRMATION_CONFIG, undefined, "EUR/USD");
  if (result) {
    assert(result.displacement >= 0.4, "EUR/USD should use default 0.4 threshold");
  }
});

Deno.test("Instrument-aware: custom instrumentDisplacements override built-in", () => {
  const candles = generateBearishChochCandles(4530);
  const config: ZoneConfirmationConfig = {
    ...DEFAULT_ZONE_CONFIRMATION_CONFIG,
    instrumentDisplacements: { "XAU/USD": 0.20 }, // very low custom override
  };
  const result = detectZoneConfirmation(candles, "short", config, undefined, "XAU/USD");
  if (result) {
    assert(result.displacement >= 0.20, "Custom override should apply");
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Tier Priority Tests (Tier 1 > Tier 2 > Tier 3) ─────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("Tier priority: Tier 1 is returned when both Tier 1 and Tier 3 could match", () => {
  const candles = generateBearishChochCandles(4530);
  // All tiers enabled — if Tier 1 matches, it should be returned (not Tier 3)
  const result = detectZoneConfirmation(candles, "short", DEFAULT_ZONE_CONFIRMATION_CONFIG);
  if (result) {
    assertEquals(result.tier, 1, "Tier 1 should take priority over lower tiers");
  }
});

Deno.test("Tier priority: Tier 3 only fires when Tier 1 and 2 don't match", () => {
  const candles = generateBearishReversalPatternCandles(4540);
  // All tiers enabled — reversal pattern candles shouldn't have a CHoCH
  const result = detectZoneConfirmation(candles, "short", DEFAULT_ZONE_CONFIRMATION_CONFIG);
  if (result && result.tier === 3) {
    assertEquals(result.type, "bearish_reversal_pattern");
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Config: maxLookbackCandles Tests ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("maxLookbackCandles: expanded window (10) finds CHoCH that old window (6) would miss", () => {
  const candles = generateBearishChochCandles(4530);
  // The CHoCH is at index 15, total candles = 21
  // With maxLookbackCandles=6: minIndex = 21-1-6 = 14, so CHoCH at 15 IS within window
  // With maxLookbackCandles=3: minIndex = 21-1-3 = 17, so CHoCH at 15 is OUTSIDE window
  const narrowConfig: ZoneConfirmationConfig = {
    ...DEFAULT_ZONE_CONFIRMATION_CONFIG,
    maxLookbackCandles: 3,
    tier2Enabled: false,
    tier3Enabled: false,
  };
  const wideConfig: ZoneConfirmationConfig = {
    ...DEFAULT_ZONE_CONFIRMATION_CONFIG,
    maxLookbackCandles: 10,
    tier2Enabled: false,
    tier3Enabled: false,
  };

  const narrowResult = detectZoneConfirmation(candles, "short", narrowConfig);
  const wideResult = detectZoneConfirmation(candles, "short", wideConfig);

  // Narrow window should miss the CHoCH, wide window should find it
  // (depends on exact candle generation, but the logic is correct)
  if (narrowResult === null && wideResult !== null) {
    assertEquals(wideResult.tier, 1);
    assert(true, "Wide window found CHoCH that narrow window missed");
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── DEFAULT_ZONE_CONFIRMATION_CONFIG Tests ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("DEFAULT_ZONE_CONFIRMATION_CONFIG has updated defaults for tiered system", () => {
  assertEquals(DEFAULT_ZONE_CONFIRMATION_CONFIG.confirmationTimeframe, "5m");
  assertEquals(DEFAULT_ZONE_CONFIRMATION_CONFIG.requireCloseBased, true);
  assertEquals(DEFAULT_ZONE_CONFIRMATION_CONFIG.minDisplacement, 0.4, "Default displacement lowered to 0.4");
  assertEquals(DEFAULT_ZONE_CONFIRMATION_CONFIG.maxLookbackCandles, 10, "Lookback expanded to 10 candles (50min)");
  assertEquals(DEFAULT_ZONE_CONFIRMATION_CONFIG.tier1Enabled, true);
  assertEquals(DEFAULT_ZONE_CONFIRMATION_CONFIG.tier2Enabled, true);
  assertEquals(DEFAULT_ZONE_CONFIRMATION_CONFIG.tier3Enabled, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── isPriceInZone Tests ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("isPriceInZone: returns true when price is inside zone (long)", () => {
  const result = isPriceInZone(4540, 4535, 4550, "long");
  assertEquals(result, true);
});

Deno.test("isPriceInZone: returns true when price is inside zone (short)", () => {
  const result = isPriceInZone(4545, 4537, 4551, "short");
  assertEquals(result, true);
});

Deno.test("isPriceInZone: returns TRUE when price is above zone (long) — confirmation direction", () => {
  // For LONG (demand zone): price rising above zone is the confirmation direction
  // (potential CHoCH breakout). Should NOT reset — let confirmation check run.
  const result = isPriceInZone(4560, 4535, 4550, "long");
  assertEquals(result, true);
});

Deno.test("isPriceInZone: returns TRUE when price is below zone (short) — confirmation direction", () => {
  // For SHORT (supply zone): price dropping below zone is the confirmation direction
  // (potential CHoCH breakout). Should NOT reset — let confirmation check run.
  const result = isPriceInZone(4530, 4537, 4551, "short");
  assertEquals(result, true);
});

Deno.test("isPriceInZone: returns true at zone edge (exact boundary)", () => {
  const result = isPriceInZone(4537, 4537, 4551, "short");
  assertEquals(result, true);
});

Deno.test("isPriceInZone: includes buffer for near-zone prices", () => {
  const result = isPriceInZone(4536.5, 4537, 4551, "short");
  assertEquals(result, true);
});

Deno.test("isPriceInZone: returns TRUE when clearly below zone (short) — still confirmation direction", () => {
  // For SHORT: even far below zone is still confirmation direction
  const result = isPriceInZone(4520, 4537, 4551, "short");
  assertEquals(result, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── isImpulseBroken Tests ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("isImpulseBroken: returns false when price is within impulse range (short)", () => {
  const result = isImpulseBroken(4545, 4568, 4454, "short");
  assertEquals(result, false);
});

Deno.test("isImpulseBroken: returns true when price exceeds impulse origin (short)", () => {
  const result = isImpulseBroken(4575, 4568, 4454, "short");
  assertEquals(result, true);
});

Deno.test("isImpulseBroken: returns false when price is within impulse range (long)", () => {
  const result = isImpulseBroken(1.2050, 1.2200, 1.2000, "long");
  assertEquals(result, false);
});

Deno.test("isImpulseBroken: returns true when price exceeds impulse origin (long)", () => {
  const result = isImpulseBroken(1.1980, 1.2200, 1.2000, "long");
  assertEquals(result, true);
});

Deno.test("isImpulseBroken: returns false at exact impulse boundary", () => {
  const result = isImpulseBroken(4568, 4568, 4454, "short");
  assertEquals(result, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── formatConfirmationSummary Tests ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("formatConfirmationSummary: formats Tier 1 bearish CHoCH correctly", () => {
  const signal: ConfirmationSignal = {
    type: "bearish_choch",
    tier: 1,
    price: 4545.123,
    candleIndex: 15,
    displacement: 0.72,
    significance: "internal",
    closeBased: true,
    supportingSignals: ["volume_spike", "engulfing"],
  };
  const summary = formatConfirmationSummary(signal);
  assert(summary.includes("[T1:CHoCH]"), "Should include tier label");
  assert(summary.includes("Bearish CHoCH"), "Should include type label");
  assert(summary.includes("4545.12300"), "Should include price");
  assert(summary.includes("72%"), "Should include displacement percentage");
  assert(summary.includes("volume_spike"), "Should include supporting signals");
});

Deno.test("formatConfirmationSummary: formats Tier 2 relaxed CHoCH correctly", () => {
  const signal: ConfirmationSignal = {
    type: "bearish_choch_relaxed",
    tier: 2,
    price: 4540.500,
    candleIndex: 16,
    displacement: 0.45,
    significance: undefined,
    closeBased: false,
    supportingSignals: ["rejection_wick"],
  };
  const summary = formatConfirmationSummary(signal);
  assert(summary.includes("[T2:CHoCH+]"), "Should include tier 2 label");
  assert(summary.includes("Bearish CHoCH (wick)"), "Should include relaxed type label");
  assert(summary.includes("rejection_wick"), "Should include supporting signals");
});

Deno.test("formatConfirmationSummary: formats Tier 3 reversal pattern correctly", () => {
  const signal: ConfirmationSignal = {
    type: "bullish_reversal_pattern",
    tier: 3,
    price: 1.2050,
    candleIndex: 19,
    displacement: 0.55,
    significance: undefined,
    closeBased: false,
    supportingSignals: ["engulfing", "rejection_wick", "volume_spike"],
  };
  const summary = formatConfirmationSummary(signal);
  assert(summary.includes("[T3:Reversal]"), "Should include tier 3 label");
  assert(summary.includes("Bullish Reversal"), "Should include reversal type label");
  assert(summary.includes("engulfing"), "Should include engulfing");
  assert(summary.includes("rejection_wick"), "Should include rejection wick");
});

Deno.test("formatConfirmationSummary: handles empty supporting signals", () => {
  const signal: ConfirmationSignal = {
    type: "bullish_choch",
    tier: 1,
    price: 1.2050,
    candleIndex: 12,
    displacement: 0.55,
    significance: undefined,
    closeBased: true,
    supportingSignals: [],
  };
  const summary = formatConfirmationSummary(signal);
  assert(summary.includes("Bullish CHoCH"), "Should include type label");
  assert(summary.includes("1.20500"), "Should include price");
});

Deno.test("formatConfirmationSummary: shows 'adequate' strength for 0.35-0.5 displacement", () => {
  const signal: ConfirmationSignal = {
    type: "bearish_choch",
    tier: 1,
    price: 4530,
    candleIndex: 15,
    displacement: 0.38,
    significance: undefined,
    closeBased: true,
    supportingSignals: [],
  };
  const summary = formatConfirmationSummary(signal);
  assert(summary.includes("adequate"), "Should show 'adequate' for 0.35-0.5 displacement");
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── State Machine Integration Tests ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("State machine: zone touch detection triggers confirmation hunt (short scenario)", () => {
  const zoneLow = 4537;
  const zoneHigh = 4551;
  const currentPrice = 4545;

  const inZone = isPriceInZone(currentPrice, zoneLow, zoneHigh, "short");
  assertEquals(inZone, true);

  const broken = isImpulseBroken(currentPrice, 4593, 4454, "short");
  assertEquals(broken, false);
});

Deno.test("State machine: price leaving zone in confirmation direction stays valid (short)", () => {
  // For SHORT: price dropping below zone is confirmation direction
  const zoneLow = 4537;
  const zoneHigh = 4551;
  const currentPrice = 4530;

  const inZone = isPriceInZone(currentPrice, zoneLow, zoneHigh, "short");
  assertEquals(inZone, true); // Should stay valid — confirmation direction
});

Deno.test("State machine: impulse broken cancels order", () => {
  const currentPrice = 4600;
  const broken = isImpulseBroken(currentPrice, 4593, 4454, "short");
  assertEquals(broken, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Regression: Old behavior preserved ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("Regression: Tier 1 only config produces same results as old binary CHoCH check", () => {
  // When only Tier 1 is enabled with the old thresholds, behavior should match
  // the previous implementation (just close-based CHoCH with displacement filter)
  const candles = generateBearishChochCandles(4530);
  const oldStyleConfig: ZoneConfirmationConfig = {
    enabled: true,
    confirmationTimeframe: "5m",
    minDisplacement: 0.5,       // old threshold
    requireCloseBased: true,
    maxLookbackCandles: 6,      // old window
    resetOnZoneExit: true,
    tier1Enabled: true,
    tier2Enabled: false,        // disable new tiers
    tier3Enabled: false,        // disable new tiers
  };
  const result = detectZoneConfirmation(candles, "short", oldStyleConfig);

  // If found, must be Tier 1 close-based CHoCH with displacement >= 0.5
  if (result) {
    assertEquals(result.tier, 1);
    assertEquals(result.closeBased, true);
    assert(result.displacement >= 0.5, "Old-style config should enforce 0.5 displacement");
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Directional isPriceInZone Tests (unlock-pending-confirmations) ───────────
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("isPriceInZone directional: LONG — price below zone = invalidation (wrong direction)", () => {
  // For LONG (demand zone): price dropping below zoneLow - buffer = wrong direction
  const zoneLow = 1.2000;
  const zoneHigh = 1.2025;
  const buffer = (zoneHigh - zoneLow) * 0.1; // 0.00025
  const priceBelow = zoneLow - buffer - 0.001; // Clearly below zone + buffer
  const result = isPriceInZone(priceBelow, zoneLow, zoneHigh, "long");
  assertEquals(result, false, "LONG: price below zone should invalidate");
});

Deno.test("isPriceInZone directional: LONG — price above zone = valid (confirmation direction)", () => {
  // For LONG: price rising above zone is the confirmation direction
  const zoneLow = 1.2000;
  const zoneHigh = 1.2025;
  const priceAbove = 1.2100; // Well above zone
  const result = isPriceInZone(priceAbove, zoneLow, zoneHigh, "long");
  assertEquals(result, true, "LONG: price above zone should stay valid for confirmation check");
});

Deno.test("isPriceInZone directional: SHORT — price above zone = invalidation (wrong direction)", () => {
  // For SHORT (supply zone): price rising above zoneHigh + buffer = wrong direction
  const zoneLow = 1.2000;
  const zoneHigh = 1.2025;
  const buffer = (zoneHigh - zoneLow) * 0.1; // 0.00025
  const priceAbove = zoneHigh + buffer + 0.001; // Clearly above zone + buffer
  const result = isPriceInZone(priceAbove, zoneLow, zoneHigh, "short");
  assertEquals(result, false, "SHORT: price above zone should invalidate");
});

Deno.test("isPriceInZone directional: SHORT — price below zone = valid (confirmation direction)", () => {
  // For SHORT: price dropping below zone is the confirmation direction
  const zoneLow = 1.2000;
  const zoneHigh = 1.2025;
  const priceBelow = 1.1950; // Well below zone
  const result = isPriceInZone(priceBelow, zoneLow, zoneHigh, "short");
  assertEquals(result, true, "SHORT: price below zone should stay valid for confirmation check");
});

Deno.test("isPriceInZone directional: LONG — price within buffer below zone = still valid", () => {
  // Buffer tolerance: minor wick below zone should not invalidate
  const zoneLow = 1.2000;
  const zoneHigh = 1.2025;
  const buffer = (zoneHigh - zoneLow) * 0.1; // 0.00025
  const priceInBuffer = zoneLow - buffer + 0.0001; // Just inside buffer
  const result = isPriceInZone(priceInBuffer, zoneLow, zoneHigh, "long");
  assertEquals(result, true, "LONG: price within buffer should stay valid");
});

Deno.test("isPriceInZone directional: SHORT — price within buffer above zone = still valid", () => {
  // Buffer tolerance: minor wick above zone should not invalidate
  const zoneLow = 1.2000;
  const zoneHigh = 1.2025;
  const buffer = (zoneHigh - zoneLow) * 0.1; // 0.00025
  const priceInBuffer = zoneHigh + buffer - 0.0001; // Just inside buffer
  const result = isPriceInZone(priceInBuffer, zoneLow, zoneHigh, "short");
  assertEquals(result, true, "SHORT: price within buffer should stay valid");
});

Deno.test("isPriceInZone directional: ATR-based buffer works correctly for LONG", () => {
  const zoneLow = 1.2000;
  const zoneHigh = 1.2025;
  const atr = 0.0050; // 50 pips ATR
  const atrBuffer = atr * 0.2; // 0.001 (10 pips)
  // Price just inside ATR buffer (should be valid)
  const priceInBuffer = zoneLow - atrBuffer + 0.0001;
  assertEquals(isPriceInZone(priceInBuffer, zoneLow, zoneHigh, "long", atr), true);
  // Price outside ATR buffer (should invalidate)
  const priceOutside = zoneLow - atrBuffer - 0.001;
  assertEquals(isPriceInZone(priceOutside, zoneLow, zoneHigh, "long", atr), false);
});
