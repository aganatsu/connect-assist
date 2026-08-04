import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  detectJudasSwing,
  DEFAULT_JUDAS_SWING_CONFIG,
  type JudasSwingConfig,
} from "./ictJudasSwing.ts";
import type { Candle } from "./smcAnalysis.ts";

// ─── Test Helpers ─────────────────────────────────────────────────────

function makeCandle(open: number, high: number, low: number, close: number, index = 0): Candle {
  return { open, high, low, close, volume: 1000, datetime: `2024-01-${String(index + 1).padStart(2, "0")}T00:00:00Z` };
}

/**
 * Generate candles with a clear swing low sweep followed by bullish MSS.
 * Pattern: consolidation → swing low → sweep below → close back → MSS up
 */
function makeBullishJudasSwingCandles(): Candle[] {
  const candles: Candle[] = [];
  const base = 1.1000;

  // Candles 0-9: consolidation with a clear swing low at index 5
  for (let i = 0; i < 5; i++) {
    candles.push(makeCandle(base + i * 0.0002, base + i * 0.0002 + 0.0015, base + i * 0.0002 - 0.0010, base + i * 0.0002 + 0.0005, i));
  }
  // Swing low at index 5 (clear local minimum)
  candles.push(makeCandle(base, base + 0.0005, base - 0.0030, base - 0.0010, 5));
  // Recovery candles 6-9
  for (let i = 6; i < 10; i++) {
    const p = base - 0.0010 + (i - 6) * 0.0008;
    candles.push(makeCandle(p, p + 0.0012, p - 0.0008, p + 0.0005, i));
  }

  // Candles 10-14: another swing low forming
  for (let i = 10; i < 14; i++) {
    const p = base + 0.0010 - (i - 10) * 0.0005;
    candles.push(makeCandle(p, p + 0.0010, p - 0.0010, p - 0.0003, i));
  }

  // Candle 14: THE SWEEP — wick below the swing low at index 5, but close back above
  const swingLowLevel = base - 0.0030; // from candle 5
  candles.push(makeCandle(
    base - 0.0015,                    // open
    base - 0.0010,                    // high
    swingLowLevel - 0.0015,           // low (sweeps below swing low by 15 pips)
    base - 0.0005,                    // close (back above swing low)
    14
  ));

  // Candles 15-17: normal
  for (let i = 15; i < 18; i++) {
    const p = base - 0.0005 + (i - 15) * 0.0005;
    candles.push(makeCandle(p, p + 0.0010, p - 0.0008, p + 0.0004, i));
  }

  // Candle 18: MSS (bullish break with displacement)
  candles.push(makeCandle(base + 0.0005, base + 0.0060, base + 0.0003, base + 0.0055, 18));

  // Candles 19-22: continuation
  for (let i = 19; i < 23; i++) {
    const p = base + 0.0055 + (i - 19) * 0.0010;
    candles.push(makeCandle(p, p + 0.0012, p - 0.0005, p + 0.0008, i));
  }

  return candles;
}

/**
 * Generate candles with a swing high sweep followed by bearish MSS.
 */
function makeBearishJudasSwingCandles(): Candle[] {
  const candles: Candle[] = [];
  const base = 1.1000;

  // Candles 0-9: consolidation with a clear swing high at index 5
  for (let i = 0; i < 5; i++) {
    candles.push(makeCandle(base - i * 0.0002, base - i * 0.0002 + 0.0010, base - i * 0.0002 - 0.0015, base - i * 0.0002 - 0.0005, i));
  }
  // Swing high at index 5
  candles.push(makeCandle(base, base + 0.0030, base - 0.0005, base + 0.0010, 5));
  // Pullback candles 6-9
  for (let i = 6; i < 10; i++) {
    const p = base + 0.0010 - (i - 6) * 0.0008;
    candles.push(makeCandle(p, p + 0.0008, p - 0.0012, p - 0.0005, i));
  }

  // Candles 10-14: building up toward the sweep
  for (let i = 10; i < 14; i++) {
    const p = base - 0.0010 + (i - 10) * 0.0005;
    candles.push(makeCandle(p, p + 0.0010, p - 0.0010, p + 0.0003, i));
  }

  // Candle 14: THE SWEEP — wick above the swing high at index 5, close back below
  const swingHighLevel = base + 0.0030; // from candle 5
  candles.push(makeCandle(
    base + 0.0015,                    // open
    swingHighLevel + 0.0015,          // high (sweeps above swing high by 15 pips)
    base + 0.0010,                    // low
    base + 0.0005,                    // close (back below swing high)
    14
  ));

  // Candles 15-17: normal
  for (let i = 15; i < 18; i++) {
    const p = base + 0.0005 - (i - 15) * 0.0005;
    candles.push(makeCandle(p, p + 0.0008, p - 0.0010, p - 0.0004, i));
  }

  // Candle 18: MSS (bearish break with displacement)
  candles.push(makeCandle(base - 0.0005, base - 0.0003, base - 0.0060, base - 0.0055, 18));

  // Candles 19-22: continuation
  for (let i = 19; i < 23; i++) {
    const p = base - 0.0055 - (i - 19) * 0.0010;
    candles.push(makeCandle(p, p + 0.0005, p - 0.0012, p - 0.0008, i));
  }

  return candles;
}

/**
 * Generate candles with NO sweep before the MSS.
 */
function makeNoSweepCandles(): Candle[] {
  const candles: Candle[] = [];
  const base = 1.1000;

  // 20 normal candles with no clear sweep
  for (let i = 0; i < 20; i++) {
    const p = base + i * 0.0003;
    candles.push(makeCandle(p, p + 0.0010, p - 0.0010, p + 0.0005, i));
  }

  // MSS at index 20
  candles.push(makeCandle(base + 0.0060, base + 0.0120, base + 0.0058, base + 0.0115, 20));

  return candles;
}

// ─── Tests ────────────────────────────────────────────────────────────

Deno.test("detectJudasSwing: detects bullish Judas swing (sell-side sweep before bullish MSS)", () => {
  const candles = makeBullishJudasSwingCandles();
  const result = detectJudasSwing(candles, 18, "bullish");

  assertEquals(result.found, true);
  if (result.sweep) {
    assertEquals(result.sweep.direction, "bullish");
    assertEquals(result.sweep.closedBack, true);
    assertEquals(result.sweep.wickDepthATR > 0, true);
  }
});

Deno.test("detectJudasSwing: detects bearish Judas swing (buy-side sweep before bearish MSS)", () => {
  const candles = makeBearishJudasSwingCandles();
  const result = detectJudasSwing(candles, 18, "bearish");

  assertEquals(result.found, true);
  if (result.sweep) {
    assertEquals(result.sweep.direction, "bearish");
    assertEquals(result.sweep.closedBack, true);
  }
});

Deno.test("detectJudasSwing: no sweep detected when none exists", () => {
  const candles = makeNoSweepCandles();
  const result = detectJudasSwing(candles, 20, "bullish");

  assertEquals(result.found, false);
  assertEquals(result.sweep, null);
});

Deno.test("detectJudasSwing: hard mode blocks when no sweep found", () => {
  const candles = makeNoSweepCandles();
  const config: JudasSwingConfig = { ...DEFAULT_JUDAS_SWING_CONFIG, gateMode: "hard" };
  const result = detectJudasSwing(candles, 20, "bullish", config);

  assertEquals(result.found, false);
  assertEquals(result.passed, false);
  assertEquals(result.reason.includes("BLOCKED"), true);
});

Deno.test("detectJudasSwing: soft mode penalizes when no sweep found", () => {
  const candles = makeNoSweepCandles();
  const config: JudasSwingConfig = { ...DEFAULT_JUDAS_SWING_CONFIG, gateMode: "soft" };
  const result = detectJudasSwing(candles, 20, "bullish", config);

  assertEquals(result.found, false);
  assertEquals(result.passed, true);
  assertEquals(result.scoreAdjustment, config.noSweepPenalty);
});

Deno.test("detectJudasSwing: off mode always passes with no score adjustment", () => {
  const candles = makeNoSweepCandles();
  const config: JudasSwingConfig = { ...DEFAULT_JUDAS_SWING_CONFIG, gateMode: "off" };
  const result = detectJudasSwing(candles, 20, "bullish", config);

  assertEquals(result.passed, true);
  assertEquals(result.scoreAdjustment, 0);
  assertEquals(result.reason.includes("[OFF]"), true);
});

Deno.test("detectJudasSwing: sweep confirmed gives bonus", () => {
  const candles = makeBullishJudasSwingCandles();
  const config: JudasSwingConfig = { ...DEFAULT_JUDAS_SWING_CONFIG, gateMode: "soft" };
  const result = detectJudasSwing(candles, 18, "bullish", config);

  if (result.found) {
    assertEquals(result.scoreAdjustment, config.sweepConfirmedBonus);
  }
});

Deno.test("detectJudasSwing: disabled config always passes", () => {
  const candles = makeNoSweepCandles();
  const config: JudasSwingConfig = { ...DEFAULT_JUDAS_SWING_CONFIG, enabled: false, gateMode: "hard" };
  const result = detectJudasSwing(candles, 20, "bullish", config);

  assertEquals(result.passed, true);
  assertEquals(result.reason.includes("disabled"), true);
});

Deno.test("detectJudasSwing: insufficient data returns gracefully", () => {
  const candles = [makeCandle(1.1, 1.11, 1.09, 1.105, 0)];
  const result = detectJudasSwing(candles, 0, "bullish");

  assertEquals(result.passed, true);
  assertEquals(result.found, false);
});
