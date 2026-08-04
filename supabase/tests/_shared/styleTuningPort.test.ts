/**
 * Tests for style-tuning-port changes:
 * 1. Canonical style-profile parameter validation
 * 2. Cascade zone engine integration for swing_trader
 * 3. Regression: day_trader parameters unchanged
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { TRADING_STYLE_PROFILES } from "../../functions/_shared/tradingStyleConfig.ts";

// ── Test 1: Read style profile from bot-scanner to verify tuned parameters ──
const scannerSource = await Deno.readTextFile("./supabase/functions/bot-scanner/index.ts");

Deno.test("scalper profile: tpRatio is 2.0 (validated 2:1 R:R)", () => {
  assertEquals(TRADING_STYLE_PROFILES.scalper.tpRatio, 2);
});

Deno.test("scalper style profile: breakEvenEnabled is false (validated)", () => {
  assertEquals(TRADING_STYLE_PROFILES.scalper.breakEvenEnabled, false);
});

Deno.test("scalper style profile: trailingStopEnabled is false (validated)", () => {
  assertEquals(TRADING_STYLE_PROFILES.scalper.trailingStopEnabled, false);
});

Deno.test("scalper style profile: riskPerTrade is 0.5 (lower for high frequency)", () => {
  assertEquals(TRADING_STYLE_PROFILES.scalper.riskPerTrade, 0.5);
});

Deno.test("scalper style profile: impulseSlCapMultiplier is 1.5 (tight for scalper)", () => {
  assertEquals(TRADING_STYLE_PROFILES.scalper.impulseSlCapMultiplier, 1.5);
});

Deno.test("swing_trader style profile: tpRatio is 3.0 (validated 3:1 R:R)", () => {
  assertEquals(TRADING_STYLE_PROFILES.swing_trader.tpRatio, 3);
});

Deno.test("swing_trader style profile: breakEvenEnabled is false (validated)", () => {
  assertEquals(TRADING_STYLE_PROFILES.swing_trader.breakEvenEnabled, false);
});

Deno.test("swing_trader style profile: trailingStopEnabled is false (validated)", () => {
  assertEquals(TRADING_STYLE_PROFILES.swing_trader.trailingStopEnabled, false);
});

Deno.test("swing_trader style profile: partialTPEnabled is false (validated)", () => {
  assertEquals(TRADING_STYLE_PROFILES.swing_trader.partialTPEnabled, false);
});

Deno.test("swing_trader style profile: minConfluence is 40 (validated)", () => {
  assertEquals(TRADING_STYLE_PROFILES.swing_trader.minConfluence, 40);
});

Deno.test("swing_trader style profile: riskPerTrade is 1.5 (higher conviction)", () => {
  assertEquals(TRADING_STYLE_PROFILES.swing_trader.riskPerTrade, 1.5);
});

Deno.test("swing_trader style profile: impulseSlCapMultiplier is 6 (wider for swing)", () => {
  assertEquals(TRADING_STYLE_PROFILES.swing_trader.impulseSlCapMultiplier, 6);
});

// ── Test 2: Cascade zone engine import exists ──
Deno.test("bot-scanner imports findCascadeZone from cascadeZoneEngine", () => {
  assertEquals(
    scannerSource.includes("findCascadeZone") &&
      scannerSource.includes('from "../../functions/_shared/cascadeZoneEngine.ts"'),
    true,
    "Cascade zone engine import should exist"
  );
});

// ── Test 3: Cascade zone engine is called for swing_trader ──
Deno.test("bot-scanner calls findCascadeZone for swing_trader", () => {
  assertEquals(
    /resolvedStyle === "swing_trader" && effectiveDirection &&\s+dailyCandles\.length >= 30/.test(scannerSource) &&
      scannerSource.includes("cascadeResult = findCascadeZone("),
    true,
    "Cascade zone engine should be called conditionally for swing_trader (uses effectiveDirection from verdict)"
  );
});

Deno.test("cascade gate pass logic exists for swing_trader", () => {
  assertEquals(
    scannerSource.includes('CASCADE GATE PASSED'),
    true,
    "Cascade gate pass log message should exist"
  );
});

Deno.test("cascade SL override exists for swing_trader", () => {
  assertEquals(
    scannerSource.includes('Cascade Zone SL override'),
    true,
    "Cascade SL override logic should exist"
  );
});

// ── Test 4: Regression — day_trader parameters are unchanged ──
Deno.test("day_trader style profile: tpRatio still 2.0 (unchanged)", () => {
  assertEquals(TRADING_STYLE_PROFILES.day_trader.tpRatio, 2);
});

Deno.test("day_trader style profile: breakEvenEnabled still true (unchanged)", () => {
  assertEquals(TRADING_STYLE_PROFILES.day_trader.breakEvenEnabled, true);
});

Deno.test("day_trader style profile: minConfluence still 55 (unchanged)", () => {
  assertEquals(TRADING_STYLE_PROFILES.day_trader.minConfluence, 55);
});

// ── Test 5: Cascade engine module exports correctly ──
Deno.test("cascadeZoneEngine exports findCascadeZone function", async () => {
  const mod = await import("./cascadeZoneEngine.ts");
  assertEquals(typeof mod.findCascadeZone, "function", "findCascadeZone should be exported as a function");
});

Deno.test("cascadeZoneEngine returns correct state for empty candles", async () => {
  const { findCascadeZone } = await import("./cascadeZoneEngine.ts");
  const result = findCascadeZone([], [], [], [], "bullish", 1.1000);
  assertEquals(result.state, "no_daily_impulse", "Empty candles should return no_daily_impulse state");
  assertEquals(result.sl, null, "Empty candles should return null SL");
  assertEquals(result.entry, null, "Empty candles should return null entry");
});
