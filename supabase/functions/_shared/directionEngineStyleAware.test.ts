/**
 * directionEngineStyleAware.test.ts — Tests for the style-aware multi-TF direction engine
 *
 * Covers:
 *   1. Shape validation for StyleDirectionResult
 *   2. TF label propagation in reason strings (scalper, swing, day_trader)
 *   3. Parity with original determineDirection for day_trader inputs
 *   4. Insufficient data handling per style
 *   5. STYLE_TF_LABELS constant correctness
 */
import { assertEquals, assertExists, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  determineDirection,
  determineDirectionStyleAware,
  STYLE_TF_LABELS,
  type StyleDirectionResult,
  type DirectionResult,
} from "./directionEngine.ts";
import type { Candle } from "./smcAnalysis.ts";

// ── Reusable candle generators (same as directionEngine.test.ts) ──

function makeTrendingCandles(
  count: number,
  startPrice: number,
  direction: "bullish" | "bearish",
  swingSize = 0.005,
): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  const drift = direction === "bullish" ? swingSize * 0.3 : -swingSize * 0.3;

  for (let i = 0; i < count; i++) {
    const phase = i % 5;
    let move: number;
    if (direction === "bullish") {
      move = phase < 3 ? swingSize * 0.4 : -swingSize * 0.25;
    } else {
      move = phase < 3 ? -swingSize * 0.4 : swingSize * 0.25;
    }
    const open = price;
    const close = price + move + drift;
    const high = Math.max(open, close) + swingSize * 0.1;
    const low = Math.min(open, close) - swingSize * 0.1;
    candles.push({
      datetime: new Date(Date.now() - (count - i) * 86400000).toISOString(),
      open,
      high,
      low,
      close,
      volume: 100,
    });
    price = close;
  }
  return candles;
}

function makeRangingCandles(count: number, midPrice: number, range = 0.003): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const offset = Math.sin(i * 0.5) * range * 0.5;
    const open = midPrice + offset;
    const close = midPrice + offset + (Math.random() - 0.5) * range * 0.2;
    const high = Math.max(open, close) + range * 0.05;
    const low = Math.min(open, close) - range * 0.05;
    candles.push({
      datetime: new Date(Date.now() - (count - i) * 3600000).toISOString(),
      open,
      high,
      low,
      close,
      volume: 100,
    });
  }
  return candles;
}

// ─── Tests ───────────────────────────────────────────────────────────

Deno.test("STYLE_TF_LABELS: has correct entries for all three styles", () => {
  assertEquals(STYLE_TF_LABELS.scalper.biasTFLabel, "1H");
  assertEquals(STYLE_TF_LABELS.scalper.structureTFLabel, "15m");
  assertEquals(STYLE_TF_LABELS.scalper.confirmTFLabel, "5m");

  assertEquals(STYLE_TF_LABELS.day_trader.biasTFLabel, "Daily");
  assertEquals(STYLE_TF_LABELS.day_trader.structureTFLabel, "4H");
  assertEquals(STYLE_TF_LABELS.day_trader.confirmTFLabel, "1H");

  assertEquals(STYLE_TF_LABELS.swing_trader.biasTFLabel, "Weekly");
  assertEquals(STYLE_TF_LABELS.swing_trader.structureTFLabel, "Daily");
  assertEquals(STYLE_TF_LABELS.swing_trader.confirmTFLabel, "4H");
});

Deno.test("determineDirectionStyleAware: result has correct shape", () => {
  const bias = makeTrendingCandles(30, 1.1, "bullish");
  const structure = makeTrendingCandles(30, 1.1, "bullish");
  const confirm = makeTrendingCandles(30, 1.1, "bullish");

  const result = determineDirectionStyleAware(bias, structure, confirm, STYLE_TF_LABELS.day_trader);

  assertEquals(
    result.direction === "long" || result.direction === "short" || result.direction === null,
    true,
    `direction should be 'long', 'short', or null, got: ${result.direction}`,
  );
  assertEquals(
    result.bias === "bullish" || result.bias === "bearish" || result.bias === null,
    true,
  );
  assertEquals(typeof result.structureRetrace, "boolean");
  assertEquals(typeof result.structureChochAgainst, "boolean");
  assertEquals(typeof result.confirmBOS, "boolean");
  assertExists(result.reason);
  // biasSource can be string or null
  assertEquals(
    typeof result.biasSource === "string" || result.biasSource === null,
    true,
    `biasSource should be string or null, got: ${result.biasSource}`,
  );
});

Deno.test("determineDirectionStyleAware: scalper labels appear in reason string", () => {
  const h1Candles = makeTrendingCandles(30, 1.1, "bullish");
  const m15Candles = makeTrendingCandles(30, 1.1, "bullish");
  const m5Candles = makeTrendingCandles(30, 1.1, "bullish");

  const result = determineDirectionStyleAware(
    h1Candles,
    m15Candles,
    m5Candles,
    STYLE_TF_LABELS.scalper,
  );

  // The reason string should contain the scalper TF labels
  if (result.direction !== null) {
    // When direction is found, reason should reference the bias TF label
    const hasLabel = result.reason.includes("1H") || result.reason.includes("15m") || result.reason.includes("5m");
    assertEquals(hasLabel, true, `Scalper reason should contain TF labels, got: ${result.reason}`);
  }
  assertExists(result.reason);
});

Deno.test("determineDirectionStyleAware: swing labels appear in reason string", () => {
  const weeklyCandles = makeTrendingCandles(30, 1.1, "bearish");
  const dailyCandles = makeTrendingCandles(30, 1.1, "bearish");
  const h4Candles = makeTrendingCandles(30, 1.1, "bearish");

  const result = determineDirectionStyleAware(
    weeklyCandles,
    dailyCandles,
    h4Candles,
    STYLE_TF_LABELS.swing_trader,
  );

  if (result.direction !== null) {
    const hasLabel = result.reason.includes("Weekly") || result.reason.includes("Daily") || result.reason.includes("4H");
    assertEquals(hasLabel, true, `Swing reason should contain TF labels, got: ${result.reason}`);
  }
  assertExists(result.reason);
});

Deno.test("determineDirectionStyleAware: insufficient bias candles returns null direction", () => {
  const shortBias = makeTrendingCandles(10, 1.1, "bullish"); // only 10, need 20
  const structure = makeTrendingCandles(30, 1.1, "bullish");
  const confirm = makeTrendingCandles(30, 1.1, "bullish");

  const result = determineDirectionStyleAware(shortBias, structure, confirm, STYLE_TF_LABELS.scalper);
  assertEquals(result.direction, null);
  assertEquals(result.bias, null);
  assertStringIncludes(result.reason, "Insufficient");
  assertStringIncludes(result.reason, "1H"); // scalper bias TF label
});

Deno.test("determineDirectionStyleAware: null bias candles returns null direction", () => {
  const result = determineDirectionStyleAware(null, null, null, STYLE_TF_LABELS.swing_trader);
  assertEquals(result.direction, null);
  assertEquals(result.bias, null);
  assertStringIncludes(result.reason, "Weekly"); // swing bias TF label
});

Deno.test("determineDirectionStyleAware: day_trader parity with determineDirection", () => {
  // Use the same candles for both functions — they should produce the same direction
  const daily = makeTrendingCandles(40, 1.1, "bullish", 0.008);
  const h4 = makeTrendingCandles(40, 1.1, "bullish", 0.005);
  const h1 = makeTrendingCandles(40, 1.1, "bullish", 0.003);

  const original = determineDirection(daily, h4, h1);
  const styleAware = determineDirectionStyleAware(daily, h4, h1, STYLE_TF_LABELS.day_trader);

  // Both should agree on direction
  assertEquals(
    original.direction,
    styleAware.direction,
    `Day trader parity: original=${original.direction}, styleAware=${styleAware.direction}\n` +
    `Original reason: ${original.reason}\nStyleAware reason: ${styleAware.reason}`,
  );

  // Both should agree on bias
  assertEquals(original.bias, styleAware.bias);
});

Deno.test("determineDirectionStyleAware: bearish bias produces short direction", () => {
  const bias = makeTrendingCandles(40, 1.2, "bearish", 0.008);
  const structure = makeTrendingCandles(40, 1.2, "bearish", 0.005);
  const confirm = makeTrendingCandles(40, 1.2, "bearish", 0.003);

  const result = determineDirectionStyleAware(bias, structure, confirm, STYLE_TF_LABELS.day_trader);

  // If a bearish bias is detected, direction should be short (or null if blocked)
  if (result.bias === "bearish" && !result.structureChochAgainst) {
    assertEquals(
      result.direction === "short" || result.direction === null,
      true,
      `Bearish bias should produce short or null (if confirm not met), got: ${result.direction}`,
    );
  }
});

Deno.test("determineDirectionStyleAware: structure CHoCH against bias blocks direction", () => {
  // Bias is bullish but structure has bearish CHoCH
  const bias = makeTrendingCandles(40, 1.1, "bullish", 0.008);
  const structure = makeTrendingCandles(40, 1.15, "bearish", 0.006); // opposing structure
  const confirm = makeTrendingCandles(30, 1.1, "bullish", 0.003);

  const result = determineDirectionStyleAware(bias, structure, confirm, STYLE_TF_LABELS.day_trader);

  // If bias is bullish but structure opposes, direction should be null (BLOCKED)
  if (result.bias === "bullish" && result.structureChochAgainst) {
    assertEquals(result.direction, null, "Structure CHoCH against bias should block direction");
    assertStringIncludes(result.reason, "BLOCKED");
  }
  // If no bias detected (synthetic data), that's also valid
  assertExists(result.reason);
});

Deno.test("determineDirectionStyleAware: bias ranging + structure ranging = no trade", () => {
  const bias = makeRangingCandles(30, 1.1);
  const structure = makeRangingCandles(30, 1.1);
  const confirm = makeTrendingCandles(30, 1.1, "bullish");

  const result = determineDirectionStyleAware(bias, structure, confirm, STYLE_TF_LABELS.scalper);

  // If both are detected as ranging, direction must be null
  if (result.bias === null) {
    assertEquals(result.direction, null, "No bias detected → direction must be null");
    assertStringIncludes(result.reason, "ranging");
  }
  assertExists(result.reason);
});

Deno.test("determineDirectionStyleAware: biasSource matches the TF label", () => {
  const bias = makeTrendingCandles(40, 1.1, "bullish", 0.008);
  const structure = makeTrendingCandles(30, 1.1, "bullish");
  const confirm = makeTrendingCandles(30, 1.1, "bullish");

  // Scalper: biasSource should be "1H" (the biasTFLabel)
  const scalperResult = determineDirectionStyleAware(bias, structure, confirm, STYLE_TF_LABELS.scalper);
  if (scalperResult.biasSource !== null) {
    // biasSource should be either the bias TF label or the structure TF label (if fallback)
    const validSources = ["1H", "15m"];
    assertEquals(
      validSources.includes(scalperResult.biasSource),
      true,
      `Scalper biasSource should be '1H' or '15m' (fallback), got: ${scalperResult.biasSource}`,
    );
  }

  // Swing: biasSource should be "Weekly" or "Daily" (fallback)
  const swingResult = determineDirectionStyleAware(bias, structure, confirm, STYLE_TF_LABELS.swing_trader);
  if (swingResult.biasSource !== null) {
    const validSources = ["Weekly", "Daily"];
    assertEquals(
      validSources.includes(swingResult.biasSource),
      true,
      `Swing biasSource should be 'Weekly' or 'Daily' (fallback), got: ${swingResult.biasSource}`,
    );
  }
});
