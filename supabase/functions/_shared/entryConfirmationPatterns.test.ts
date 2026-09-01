/**
 * entryConfirmationPatterns.test.ts — Entry Confirmation Pattern Detection
 * ──────────────────────────────────────────────────────────────────────────
 * Verifies that detectReversalCandle now returns specific pattern names
 * (Engulfing, Pin Bar, Inside Bar, Doji, Morning/Evening Star) instead of
 * just "bullish"/"bearish".
 *
 * This test would have FAILED before this change because the old return
 * type was { detected, type } with no `pattern` field.
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/entryConfirmationPatterns.test.ts
 */
import { detectReversalCandle, type Candle } from "./smcAnalysis.ts";
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─── Helper: create a minimal candle ────────────────────────────────────────
function candle(o: number, h: number, l: number, c: number, dt = "2024-03-15 10:00:00"): Candle {
  return { open: o, high: h, low: l, close: c, datetime: dt, volume: 100 };
}

// ─── Bullish Pin Bar (Hammer) ───────────────────────────────────────────────
Deno.test("detectReversalCandle: Bullish Pin Bar (Hammer) — long lower wick, small body", () => {
  // Body < 30% of range, lower wick > 60% of range, close > open
  const candles: Candle[] = [
    candle(1.0800, 1.0810, 1.0790, 1.0805, "2024-03-15 09:45:00"),
    candle(1.0800, 1.0805, 1.0770, 1.0803, "2024-03-15 10:00:00"),
    // range = 0.0035, body = 0.0003 (8.5%), lowerWick = 0.0030 (85.7%)
  ];
  const result = detectReversalCandle(candles);
  assertEquals(result.detected, true);
  assertEquals(result.type, "bullish");
  assertEquals(result.pattern, "Bullish Pin Bar (Hammer)");
});

// ─── Bearish Pin Bar (Shooting Star) ────────────────────────────────────────
Deno.test("detectReversalCandle: Bearish Pin Bar (Shooting Star) — long upper wick, small body", () => {
  // Body < 30% of range, upper wick > 60% of range, close < open
  const candles: Candle[] = [
    candle(1.0800, 1.0810, 1.0790, 1.0805, "2024-03-15 09:45:00"),
    candle(1.0803, 1.0835, 1.0800, 1.0801, "2024-03-15 10:00:00"),
    // range = 0.0035, body = 0.0002 (5.7%), upperWick = 0.0032 (91.4%)
  ];
  const result = detectReversalCandle(candles);
  assertEquals(result.detected, true);
  assertEquals(result.type, "bearish");
  assertEquals(result.pattern, "Bearish Pin Bar (Shooting Star)");
});

// ─── Bullish Engulfing ──────────────────────────────────────────────────────
Deno.test("detectReversalCandle: Bullish Engulfing — prev bearish, last bullish engulfs", () => {
  const candles: Candle[] = [
    candle(1.0810, 1.0815, 1.0795, 1.0800, "2024-03-15 09:45:00"), // bearish: close < open
    candle(1.0798, 1.0820, 1.0795, 1.0815, "2024-03-15 10:00:00"), // bullish: open <= prev.close, close >= prev.open
  ];
  const result = detectReversalCandle(candles);
  assertEquals(result.detected, true);
  assertEquals(result.type, "bullish");
  assertEquals(result.pattern, "Bullish Engulfing");
});

// ─── Bearish Engulfing ──────────────────────────────────────────────────────
Deno.test("detectReversalCandle: Bearish Engulfing — prev bullish, last bearish engulfs", () => {
  const candles: Candle[] = [
    candle(1.0800, 1.0815, 1.0795, 1.0810, "2024-03-15 09:45:00"), // bullish: close > open
    candle(1.0812, 1.0820, 1.0790, 1.0798, "2024-03-15 10:00:00"), // bearish: open >= prev.close, close <= prev.open
  ];
  const result = detectReversalCandle(candles);
  assertEquals(result.detected, true);
  assertEquals(result.type, "bearish");
  assertEquals(result.pattern, "Bearish Engulfing");
});

// ─── Inside Bar Breakout (Bullish) ──────────────────────────────────────────
Deno.test("detectReversalCandle: Inside Bar Breakout (Bullish) — prev inside prev2, last breaks high", () => {
  const candles: Candle[] = [
    candle(1.0800, 1.0820, 1.0780, 1.0810, "2024-03-15 09:30:00"), // prev2: range [0.0780, 0.0820]
    candle(1.0800, 1.0815, 1.0785, 1.0805, "2024-03-15 09:45:00"), // prev: inside prev2 (high <= 0.0820, low >= 0.0780)
    candle(1.0810, 1.0830, 1.0808, 1.0825, "2024-03-15 10:00:00"), // last: close > prev.high, close > open
  ];
  const result = detectReversalCandle(candles);
  assertEquals(result.detected, true);
  assertEquals(result.type, "bullish");
  assertEquals(result.pattern, "Inside Bar Breakout (Bullish)");
});

// ─── Inside Bar Breakout (Bearish) ──────────────────────────────────────────
Deno.test("detectReversalCandle: Inside Bar Breakout (Bearish) — prev inside prev2, last breaks low", () => {
  const candles: Candle[] = [
    candle(1.0800, 1.0820, 1.0780, 1.0810, "2024-03-15 09:30:00"), // prev2: range [0.0780, 0.0820]
    candle(1.0800, 1.0815, 1.0785, 1.0805, "2024-03-15 09:45:00"), // prev: inside prev2
    candle(1.0790, 1.0795, 1.0770, 1.0775, "2024-03-15 10:00:00"), // last: close < prev.low, close < open
  ];
  const result = detectReversalCandle(candles);
  assertEquals(result.detected, true);
  assertEquals(result.type, "bearish");
  assertEquals(result.pattern, "Inside Bar Breakout (Bearish)");
});

// ─── Doji + Bullish Follow-Through ─────────────────────────────────────────
Deno.test("detectReversalCandle: Doji + Bullish Follow-Through — prev is doji, last is decisive bullish", () => {
  const candles: Candle[] = [
    candle(1.0800, 1.0810, 1.0790, 1.0801, "2024-03-15 09:45:00"), // doji: body/range = 0.0001/0.0020 = 5%
    candle(1.0802, 1.0825, 1.0800, 1.0820, "2024-03-15 10:00:00"), // decisive bullish: body = 0.0018 > prevRange*0.5 = 0.0010
  ];
  const result = detectReversalCandle(candles);
  assertEquals(result.detected, true);
  assertEquals(result.type, "bullish");
  assertEquals(result.pattern, "Doji + Bullish Follow-Through");
});

// ─── Doji + Bearish Follow-Through ─────────────────────────────────────────
Deno.test("detectReversalCandle: Doji + Bearish Follow-Through — prev is doji, last is decisive bearish", () => {
  // Prev is a doji (body < 10% of range). Last is bearish but does NOT engulf prev
  // (open < prev.close so it's not a bearish engulfing).
  const candles: Candle[] = [
    candle(1.0800, 1.0810, 1.0790, 1.0801, "2024-03-15 09:45:00"), // doji: body/range = 0.0001/0.0020 = 5%
    candle(1.0799, 1.0802, 1.0780, 1.0782, "2024-03-15 10:00:00"), // bearish: open(0799) < prev.close(0801) so NOT engulfing
  ];
  const result = detectReversalCandle(candles);
  assertEquals(result.detected, true);
  assertEquals(result.type, "bearish");
  assertEquals(result.pattern, "Doji + Bearish Follow-Through");
});

// ─── Morning Star ───────────────────────────────────────────────────────────
Deno.test("detectReversalCandle: Morning Star — large bearish, small body, large bullish closing above midpoint", () => {
  // prev2 = large bearish, prev = small body (NOT inside prev2 — prev.low < prev2.low to avoid inside bar),
  // last = large bullish closing above midpoint
  const candles: Candle[] = [
    candle(1.0820, 1.0825, 1.0790, 1.0795, "2024-03-15 09:30:00"), // large bearish: body = 0.0025, range = 0.0035
    candle(1.0793, 1.0798, 1.0785, 1.0795, "2024-03-15 09:45:00"), // small body: 0.0002, low(0785) < prev2.low(0790) so NOT inside bar
    candle(1.0796, 1.0820, 1.0794, 1.0815, "2024-03-15 10:00:00"), // large bullish: body = 0.0019 > 0.0025*0.5, close(0815) > midpoint(0.08075)
  ];
  const result = detectReversalCandle(candles);
  assertEquals(result.detected, true);
  assertEquals(result.type, "bullish");
  assertEquals(result.pattern, "Morning Star");
});

// ─── Evening Star ───────────────────────────────────────────────────────────
Deno.test("detectReversalCandle: Evening Star — large bullish, small body, large bearish closing below midpoint", () => {
  // prev2 = large bullish, prev = small body (NOT inside prev2 — prev.high > prev2.high to avoid inside bar),
  // last = large bearish closing below midpoint
  const candles: Candle[] = [
    candle(1.0795, 1.0825, 1.0790, 1.0820, "2024-03-15 09:30:00"), // large bullish: body = 0.0025, range = 0.0035
    candle(1.0822, 1.0830, 1.0818, 1.0824, "2024-03-15 09:45:00"), // small body: 0.0002, high(0830) > prev2.high(0825) so NOT inside bar
    candle(1.0822, 1.0825, 1.0790, 1.0798, "2024-03-15 10:00:00"), // large bearish: body = 0.0024 > 0.0025*0.5, close(0798) < midpoint(0.08075)
  ];
  const result = detectReversalCandle(candles);
  assertEquals(result.detected, true);
  assertEquals(result.type, "bearish");
  assertEquals(result.pattern, "Evening Star");
});

// ─── No pattern detected ────────────────────────────────────────────────────
Deno.test("detectReversalCandle: returns null pattern when no pattern matches", () => {
  // Two neutral candles with no clear pattern
  const candles: Candle[] = [
    candle(1.0800, 1.0810, 1.0795, 1.0805, "2024-03-15 09:45:00"),
    candle(1.0805, 1.0812, 1.0798, 1.0808, "2024-03-15 10:00:00"),
  ];
  const result = detectReversalCandle(candles);
  assertEquals(result.detected, false);
  assertEquals(result.type, null);
  assertEquals(result.pattern, null);
});

// ─── Backward compatibility: pattern field always present ───────────────────
Deno.test("detectReversalCandle: return always includes pattern field (backward compat)", () => {
  const candles: Candle[] = [
    candle(1.0800, 1.0810, 1.0790, 1.0805, "2024-03-15 09:45:00"),
  ];
  const result = detectReversalCandle(candles);
  assert("pattern" in result, "pattern field must always be present");
  assert("detected" in result, "detected field must always be present");
  assert("type" in result, "type field must always be present");
});

// ─── Regression: Pin Bar still detected as before ───────────────────────────
Deno.test("REGRESSION: Pin Bar detection logic unchanged — same inputs produce same detected+type", () => {
  const candles: Candle[] = [
    candle(1.0800, 1.0810, 1.0790, 1.0805, "2024-03-15 09:45:00"),
    candle(1.0800, 1.0805, 1.0770, 1.0803, "2024-03-15 10:00:00"),
  ];
  const result = detectReversalCandle(candles);
  // Before this change, this would return { detected: true, type: "bullish" }
  // After this change, it should still return detected: true, type: "bullish" (plus pattern)
  assertEquals(result.detected, true);
  assertEquals(result.type, "bullish");
});

// ─── Regression: Engulfing still detected as before ─────────────────────────
Deno.test("REGRESSION: Engulfing detection logic unchanged — same inputs produce same detected+type", () => {
  const candles: Candle[] = [
    candle(1.0810, 1.0815, 1.0795, 1.0800, "2024-03-15 09:45:00"),
    candle(1.0798, 1.0820, 1.0795, 1.0815, "2024-03-15 10:00:00"),
  ];
  const result = detectReversalCandle(candles);
  // Before: { detected: true, type: "bullish" }
  // After: same + pattern
  assertEquals(result.detected, true);
  assertEquals(result.type, "bullish");
});

// ─── CHoCH appended to detail in confluenceScoring ──────────────────────────
Deno.test("confluenceScoring: Reversal Candle factor detail includes pattern name", async () => {
  // Import confluenceScoring and run with a fixture that produces a pin bar
  const { runConfluenceAnalysis } = await import("./confluenceScoring.ts");
  
  // Build candles that produce a bullish pin bar
  const candles: Candle[] = [];
  const baseTime = new Date("2024-03-15T10:00:00Z").getTime(); // Friday, London KZ
  let price = 1.0800;
  // 48 neutral candles
  for (let i = 0; i < 48; i++) {
    const time = new Date(baseTime + i * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    candles.push(candle(price, price + 0.0005, price - 0.0005, price + 0.0002, time));
    price += 0.0001;
  }
  // Last candle: bullish pin bar (hammer)
  const lastTime = new Date(baseTime + 48 * 15 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  candles.push(candle(price, price + 0.0003, price - 0.0030, price + 0.0002, lastTime));

  const config = { entryTimeframe: "15m" };
  const result = runConfluenceAnalysis(candles, null, config);
  
  // Find the Reversal Candle factor
  const rcFactor = result.factors.find((f: any) => f.name === "Reversal Candle");
  assert(rcFactor, "Reversal Candle factor must exist");
  assert(rcFactor.present, "Reversal Candle should be present (pin bar detected)");
  // The detail should now contain "Pin Bar" instead of just "bullish reversal"
  assert(
    rcFactor.detail.includes("Pin Bar") || rcFactor.detail.includes("Hammer"),
    `Detail should mention Pin Bar pattern, got: "${rcFactor.detail}"`
  );
});
