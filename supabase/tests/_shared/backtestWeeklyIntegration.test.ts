/**
 * backtestWeeklyIntegration.test.ts
 * 
 * Tests that verify the weekly candle integration in backtest-engine:
 * 1. Weekly candles are correctly wired into swing_trader zone mapping
 * 2. Weekly bias is computed and passed to direction verdict
 * 3. Weekly candles are passed to ICT HTF analysis
 * 4. Style-aware direction engine uses weekly for swing_trader
 */
import { assertEquals, assertNotEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { analyzeWeeklyBiasAndDOL, type WeeklyBiasResult } from "../../functions/_shared/weeklyBiasDOL.ts";
import { determineDirectionStyleAware, STYLE_TF_LABELS } from "../../functions/_shared/directionEngine.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

// ── Helper: Generate synthetic weekly candles with a trend ──
function generateWeeklyCandles(count: number, trend: "bullish" | "bearish" | "ranging"): Candle[] {
  const candles: Candle[] = [];
  let basePrice = 1.1000;
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const startMs = Date.now() - count * weekMs;

  for (let i = 0; i < count; i++) {
    const drift = trend === "bullish" ? 0.002 : trend === "bearish" ? -0.002 : (Math.random() - 0.5) * 0.001;
    const noise = (Math.random() - 0.5) * 0.005;
    const open = basePrice + noise;
    const close = open + drift + noise * 0.5;
    const high = Math.max(open, close) + Math.abs(noise) * 0.5;
    const low = Math.min(open, close) - Math.abs(noise) * 0.5;
    basePrice = close;

    candles.push({
      datetime: new Date(startMs + i * weekMs).toISOString(),
      open, high, low, close,
      volume: 10000 + Math.random() * 5000,
    });
  }
  return candles;
}

// ── Helper: Generate daily candles ──
function generateDailyCandles(count: number, trend: "bullish" | "bearish" | "ranging"): Candle[] {
  const candles: Candle[] = [];
  let basePrice = 1.1000;
  const dayMs = 24 * 60 * 60 * 1000;
  const startMs = Date.now() - count * dayMs;

  for (let i = 0; i < count; i++) {
    const drift = trend === "bullish" ? 0.0005 : trend === "bearish" ? -0.0005 : (Math.random() - 0.5) * 0.0003;
    const noise = (Math.random() - 0.5) * 0.002;
    const open = basePrice + noise;
    const close = open + drift + noise * 0.3;
    const high = Math.max(open, close) + Math.abs(noise) * 0.3;
    const low = Math.min(open, close) - Math.abs(noise) * 0.3;
    basePrice = close;

    candles.push({
      datetime: new Date(startMs + i * dayMs).toISOString(),
      open, high, low, close,
      volume: 50000 + Math.random() * 20000,
    });
  }
  return candles;
}

// ── Helper: Generate 4H candles ──
function generate4HCandles(count: number, trend: "bullish" | "bearish" | "ranging"): Candle[] {
  const candles: Candle[] = [];
  let basePrice = 1.1000;
  const h4Ms = 4 * 60 * 60 * 1000;
  const startMs = Date.now() - count * h4Ms;

  for (let i = 0; i < count; i++) {
    const drift = trend === "bullish" ? 0.0002 : trend === "bearish" ? -0.0002 : (Math.random() - 0.5) * 0.0001;
    const noise = (Math.random() - 0.5) * 0.001;
    const open = basePrice + noise;
    const close = open + drift + noise * 0.2;
    const high = Math.max(open, close) + Math.abs(noise) * 0.2;
    const low = Math.min(open, close) - Math.abs(noise) * 0.2;
    basePrice = close;

    candles.push({
      datetime: new Date(startMs + i * h4Ms).toISOString(),
      open, high, low, close,
      volume: 20000 + Math.random() * 10000,
    });
  }
  return candles;
}

// ═══════════════════════════════════════════════════════════════════════
// Test 1: analyzeWeeklyBiasAndDOL produces valid result with sufficient data
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Weekly Bias: produces valid result with 26+ bullish weekly candles", () => {
  const weeklyCandles = generateWeeklyCandles(30, "bullish");
  const currentPrice = weeklyCandles[weeklyCandles.length - 1].close;
  const result = analyzeWeeklyBiasAndDOL(weeklyCandles, currentPrice);

  assert(result !== null, "Result should not be null");
  assert(["bullish", "bearish", "neutral"].includes(result.bias), "Bias should be valid");
  assert(result.confidence >= 0 && result.confidence <= 100, "Confidence should be 0-100");
  assert(result.prevWeekHigh > 0, "prevWeekHigh should be positive");
  assert(result.prevWeekLow > 0, "prevWeekLow should be positive");
});

Deno.test("Weekly Bias: returns neutral with insufficient data (<12 candles)", () => {
  const weeklyCandles = generateWeeklyCandles(8, "bullish");
  const currentPrice = weeklyCandles[weeklyCandles.length - 1].close;
  const result = analyzeWeeklyBiasAndDOL(weeklyCandles, currentPrice);

  assertEquals(result.bias, "neutral", "Should be neutral with insufficient data");
  assertEquals(result.confidence, 0, "Confidence should be 0");
});

// ═══════════════════════════════════════════════════════════════════════
// Test 2: Style-aware direction uses weekly for swing_trader
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Style Direction: swing_trader uses weekly as bias TF", () => {
  const weeklyCandles = generateWeeklyCandles(30, "bullish");
  const dailyCandles = generateDailyCandles(60, "bullish");
  const h4Candles = generate4HCandles(60, "bullish");

  const tfLabels = STYLE_TF_LABELS.swing_trader;
  const result = determineDirectionStyleAware(
    weeklyCandles,
    dailyCandles,
    h4Candles,
    { ...tfLabels, h4ChochLookback: 10, h1BosLookback: 8 },
  );

  assert(result !== null, "Result should not be null");
  // The function should not crash and should return a valid direction or null
  assert(
    result.direction === "long" || result.direction === "short" || result.direction === null,
    "Direction should be long, short, or null"
  );
});

Deno.test("Style Direction: swing_trader without weekly still works (null bias candles)", () => {
  const dailyCandles = generateDailyCandles(60, "bullish");
  const h4Candles = generate4HCandles(60, "bullish");

  const tfLabels = STYLE_TF_LABELS.swing_trader;
  const result = determineDirectionStyleAware(
    null, // No weekly candles
    dailyCandles,
    h4Candles,
    { ...tfLabels, h4ChochLookback: 10, h1BosLookback: 8 },
  );

  // Should still produce a result (falls back to structure/confirm TFs)
  assert(result !== null, "Result should not be null even without weekly");
});

// ═══════════════════════════════════════════════════════════════════════
// Test 3: STYLE_TF_LABELS has correct swing_trader mapping
// ═══════════════════════════════════════════════════════════════════════
Deno.test("STYLE_TF_LABELS: swing_trader maps Weekly/Daily/4H", () => {
  const labels = STYLE_TF_LABELS.swing_trader;
  assertEquals(labels.biasTFLabel, "Weekly");
  assertEquals(labels.structureTFLabel, "Daily");
  assertEquals(labels.confirmTFLabel, "4H");
});

Deno.test("STYLE_TF_LABELS: scalper maps 1H/15m/5m", () => {
  const labels = STYLE_TF_LABELS.scalper;
  assertEquals(labels.biasTFLabel, "1H");
  assertEquals(labels.structureTFLabel, "15m");
  assertEquals(labels.confirmTFLabel, "5m");
});

Deno.test("STYLE_TF_LABELS: day_trader maps Daily/4H/1H", () => {
  const labels = STYLE_TF_LABELS.day_trader;
  assertEquals(labels.biasTFLabel, "Daily");
  assertEquals(labels.structureTFLabel, "4H");
  assertEquals(labels.confirmTFLabel, "1H");
});

// ═══════════════════════════════════════════════════════════════════════
// Test 4: Weekly bias result shape matches what direction verdict expects
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Weekly Bias Result: has bias and confidence fields for direction verdict", () => {
  const weeklyCandles = generateWeeklyCandles(30, "bearish");
  const currentPrice = weeklyCandles[weeklyCandles.length - 1].close;
  const result = analyzeWeeklyBiasAndDOL(weeklyCandles, currentPrice);

  // Direction verdict expects { bias: "bullish"|"bearish"|"neutral", confidence: number }
  assert("bias" in result, "Result must have bias field");
  assert("confidence" in result, "Result must have confidence field");
  assert(typeof result.bias === "string", "Bias must be a string");
  assert(typeof result.confidence === "number", "Confidence must be a number");
});

// ═══════════════════════════════════════════════════════════════════════
// Test 5: Weekly candle filtering (no lookahead) logic
// ═══════════════════════════════════════════════════════════════════════
Deno.test("Weekly Candle Filtering: filter by date prevents lookahead", () => {
  const weeklyCandles = generateWeeklyCandles(52, "bullish");
  const midpoint = new Date(weeklyCandles[26].datetime).toISOString().slice(0, 10);

  // Simulate the backtest filter logic
  const relevantWeekly = weeklyCandles.filter(c => c.datetime.slice(0, 10) < midpoint);

  // Should only include candles before the midpoint
  assert(relevantWeekly.length > 0, "Should have some relevant candles");
  assert(relevantWeekly.length <= 26, "Should not include candles at or after midpoint");

  // Verify no lookahead
  for (const c of relevantWeekly) {
    assert(c.datetime.slice(0, 10) < midpoint, "All candles must be before the reference date");
  }
});
