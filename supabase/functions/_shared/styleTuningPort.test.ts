/**
 * Tests for style-tuning-port changes:
 * 1. STYLE_OVERRIDES parameter validation (scalper/swing tuned values)
 * 2. Cascade zone engine integration for swing_trader
 * 3. Regression: day_trader parameters unchanged
 */
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ── Test 1: Read STYLE_OVERRIDES from bot-scanner to verify tuned parameters ──
const scannerSource = await Deno.readTextFile("./supabase/functions/bot-scanner/index.ts");

Deno.test("scalper STYLE_OVERRIDES: tpRatio is 2.0 (validated 2:1 R:R)", () => {
  // Find the scalper block and check tpRatio
  const scalperBlock = scannerSource.match(/scalper:\s*\{[\s\S]*?(?=\n\s*\},\s*\n\s*day_trader)/);
  if (!scalperBlock) throw new Error("Could not find scalper STYLE_OVERRIDES block");
  const tpMatch = scalperBlock[0].match(/tpRatio:\s*([\d.]+)/);
  assertEquals(tpMatch?.[1], "2.0", "Scalper tpRatio should be 2.0 (validated)");
});

Deno.test("scalper STYLE_OVERRIDES: breakEvenEnabled is false (validated)", () => {
  const scalperBlock = scannerSource.match(/scalper:\s*\{[\s\S]*?(?=\n\s*\},\s*\n\s*day_trader)/);
  if (!scalperBlock) throw new Error("Could not find scalper STYLE_OVERRIDES block");
  assertEquals(scalperBlock[0].includes("breakEvenEnabled: false"), true, "Scalper BE should be disabled");
});

Deno.test("scalper STYLE_OVERRIDES: trailingStopEnabled is false (validated)", () => {
  const scalperBlock = scannerSource.match(/scalper:\s*\{[\s\S]*?(?=\n\s*\},\s*\n\s*day_trader)/);
  if (!scalperBlock) throw new Error("Could not find scalper STYLE_OVERRIDES block");
  assertEquals(scalperBlock[0].includes("trailingStopEnabled: false"), true, "Scalper trailing should be disabled");
});

Deno.test("scalper STYLE_OVERRIDES: riskPerTrade is 0.5 (lower for high frequency)", () => {
  const scalperBlock = scannerSource.match(/scalper:\s*\{[\s\S]*?(?=\n\s*\},\s*\n\s*day_trader)/);
  if (!scalperBlock) throw new Error("Could not find scalper STYLE_OVERRIDES block");
  const riskMatch = scalperBlock[0].match(/riskPerTrade:\s*([\d.]+)/);
  assertEquals(riskMatch?.[1], "0.5", "Scalper riskPerTrade should be 0.5%");
});

Deno.test("scalper STYLE_OVERRIDES: impulseSlCapMultiplier is 1.5 (tight for scalper)", () => {
  const scalperBlock = scannerSource.match(/scalper:\s*\{[\s\S]*?(?=\n\s*\},\s*\n\s*day_trader)/);
  if (!scalperBlock) throw new Error("Could not find scalper STYLE_OVERRIDES block");
  const capMatch = scalperBlock[0].match(/impulseSlCapMultiplier:\s*([\d.]+)/);
  assertEquals(capMatch?.[1], "1.5", "Scalper impulseSlCapMultiplier should be 1.5");
});

Deno.test("swing_trader STYLE_OVERRIDES: tpRatio is 3.0 (validated 3:1 R:R)", () => {
  const swingBlock = scannerSource.match(/swing_trader:\s*\{[\s\S]*?(?=\n\s*\};)/);
  if (!swingBlock) throw new Error("Could not find swing_trader STYLE_OVERRIDES block");
  const tpMatch = swingBlock[0].match(/tpRatio:\s*([\d.]+)/);
  assertEquals(tpMatch?.[1], "3.0", "Swing tpRatio should be 3.0 (validated)");
});

Deno.test("swing_trader STYLE_OVERRIDES: breakEvenEnabled is false (validated)", () => {
  const swingBlock = scannerSource.match(/swing_trader:\s*\{[\s\S]*?(?=\n\s*\};)/);
  if (!swingBlock) throw new Error("Could not find swing_trader STYLE_OVERRIDES block");
  assertEquals(swingBlock[0].includes("breakEvenEnabled: false"), true, "Swing BE should be disabled");
});

Deno.test("swing_trader STYLE_OVERRIDES: trailingStopEnabled is false (validated)", () => {
  const swingBlock = scannerSource.match(/swing_trader:\s*\{[\s\S]*?(?=\n\s*\};)/);
  if (!swingBlock) throw new Error("Could not find swing_trader STYLE_OVERRIDES block");
  assertEquals(swingBlock[0].includes("trailingStopEnabled: false"), true, "Swing trailing should be disabled");
});

Deno.test("swing_trader STYLE_OVERRIDES: partialTPEnabled is false (validated)", () => {
  const swingBlock = scannerSource.match(/swing_trader:\s*\{[\s\S]*?(?=\n\s*\};)/);
  if (!swingBlock) throw new Error("Could not find swing_trader STYLE_OVERRIDES block");
  assertEquals(swingBlock[0].includes("partialTPEnabled: false"), true, "Swing partial TP should be disabled");
});

Deno.test("swing_trader STYLE_OVERRIDES: minConfluence is 40 (validated)", () => {
  const swingBlock = scannerSource.match(/swing_trader:\s*\{[\s\S]*?(?=\n\s*\};)/);
  if (!swingBlock) throw new Error("Could not find swing_trader STYLE_OVERRIDES block");
  const confMatch = swingBlock[0].match(/minConfluence:\s*(\d+)/);
  assertEquals(confMatch?.[1], "40", "Swing minConfluence should be 40 (validated)");
});

Deno.test("swing_trader STYLE_OVERRIDES: riskPerTrade is 1.5 (higher conviction)", () => {
  const swingBlock = scannerSource.match(/swing_trader:\s*\{[\s\S]*?(?=\n\s*\};)/);
  if (!swingBlock) throw new Error("Could not find swing_trader STYLE_OVERRIDES block");
  const riskMatch = swingBlock[0].match(/riskPerTrade:\s*([\d.]+)/);
  assertEquals(riskMatch?.[1], "1.5", "Swing riskPerTrade should be 1.5%");
});

Deno.test("swing_trader STYLE_OVERRIDES: impulseSlCapMultiplier is 6 (wider for swing)", () => {
  const swingBlock = scannerSource.match(/swing_trader:\s*\{[\s\S]*?(?=\n\s*\};)/);
  if (!swingBlock) throw new Error("Could not find swing_trader STYLE_OVERRIDES block");
  const capMatch = swingBlock[0].match(/impulseSlCapMultiplier:\s*(\d+)/);
  assertEquals(capMatch?.[1], "6", "Swing impulseSlCapMultiplier should be 6");
});

// ── Test 2: Cascade zone engine import exists ──
Deno.test("bot-scanner imports findCascadeZone from cascadeZoneEngine", () => {
  assertEquals(
    scannerSource.includes('import { findCascadeZone, type CascadeResult } from "../_shared/cascadeZoneEngine.ts"'),
    true,
    "Cascade zone engine import should exist"
  );
});

// ── Test 3: Cascade zone engine is called for swing_trader ──
Deno.test("bot-scanner calls findCascadeZone for swing_trader", () => {
  assertEquals(
    scannerSource.includes('resolvedStyle === "swing_trader" && analysis.direction && dailyCandles.length >= 30'),
    true,
    "Cascade zone engine should be called conditionally for swing_trader"
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
Deno.test("day_trader STYLE_OVERRIDES: tpRatio still 2.0 (unchanged)", () => {
  const dayBlock = scannerSource.match(/day_trader:\s*\{[\s\S]*?(?=\n\s*\},\s*\n\s*swing_trader)/);
  if (!dayBlock) throw new Error("Could not find day_trader STYLE_OVERRIDES block");
  const tpMatch = dayBlock[0].match(/tpRatio:\s*([\d.]+)/);
  assertEquals(tpMatch?.[1], "2.0", "Day trader tpRatio should remain 2.0");
});

Deno.test("day_trader STYLE_OVERRIDES: breakEvenEnabled still true (unchanged)", () => {
  const dayBlock = scannerSource.match(/day_trader:\s*\{[\s\S]*?(?=\n\s*\},\s*\n\s*swing_trader)/);
  if (!dayBlock) throw new Error("Could not find day_trader STYLE_OVERRIDES block");
  assertEquals(dayBlock[0].includes("breakEvenEnabled: true"), true, "Day trader BE should remain enabled");
});

Deno.test("day_trader STYLE_OVERRIDES: minConfluence still 55 (unchanged)", () => {
  const dayBlock = scannerSource.match(/day_trader:\s*\{[\s\S]*?(?=\n\s*\},\s*\n\s*swing_trader)/);
  if (!dayBlock) throw new Error("Could not find day_trader STYLE_OVERRIDES block");
  const confMatch = dayBlock[0].match(/minConfluence:\s*(\d+)/);
  assertEquals(confMatch?.[1], "55", "Day trader minConfluence should remain 55");
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
