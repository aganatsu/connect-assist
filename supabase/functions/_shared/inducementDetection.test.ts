import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectInducements,
  findSupportingInducement,
  type Inducement,
} from "./inducementDetection.ts";
import { type Candle } from "./smcAnalysis.ts";

// ─── Helper: Generate candle data ───────────────────────────────────

function makeCandle(index: number, open: number, high: number, low: number, close: number): Candle {
  return {
    datetime: `2025-03-01T${String(index).padStart(2, "0")}:00:00Z`,
    open, high, low, close,
  };
}

function generateTrendingCandles(count: number, startPrice: number, direction: "up" | "down", volatility = 0.001): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const move = direction === "up" ? volatility : -volatility;
    const noise = (Math.random() - 0.5) * volatility * 0.5;
    const open = price;
    const close = price + move + noise;
    const high = Math.max(open, close) + Math.random() * volatility * 0.3;
    const low = Math.min(open, close) - Math.random() * volatility * 0.3;
    candles.push(makeCandle(i, open, high, low, close));
    price = close;
  }
  return candles;
}

// ─── Test: Bull Trap (Minor Swing Inducement) ────────────────────────

Deno.test("detectInducements finds bull trap on minor swing high sweep", () => {
  // Build a scenario: uptrend creates swing high, then price sweeps it briefly and reverses down
  const candles: Candle[] = [];
  const base = 1.1000;

  // 15 candles trending up to establish ATR
  for (let i = 0; i < 15; i++) {
    const o = base + i * 0.0010;
    candles.push(makeCandle(i, o, o + 0.0015, o - 0.0005, o + 0.0010));
  }

  // Swing high at index 15 (high = 1.1165)
  candles.push(makeCandle(15, 1.1150, 1.1165, 1.1140, 1.1145));

  // Pullback (3 candles going down)
  candles.push(makeCandle(16, 1.1145, 1.1150, 1.1120, 1.1125));
  candles.push(makeCandle(17, 1.1125, 1.1130, 1.1100, 1.1105));
  candles.push(makeCandle(18, 1.1105, 1.1115, 1.1090, 1.1095));

  // Another swing high at index 19 (lower high)
  candles.push(makeCandle(19, 1.1095, 1.1110, 1.1085, 1.1100));

  // Pullback again
  candles.push(makeCandle(20, 1.1100, 1.1105, 1.1080, 1.1085));
  candles.push(makeCandle(21, 1.1085, 1.1090, 1.1070, 1.1075));

  // Now sweep the swing high at 1.1165 — wick above but close below
  candles.push(makeCandle(22, 1.1075, 1.1180, 1.1070, 1.1050)); // Bull trap! High > 1.1165, close < 1.1165

  // Displacement candle (strong bearish)
  candles.push(makeCandle(23, 1.1050, 1.1055, 1.0980, 1.0990)); // Big bearish candle

  // Continuation down (confirms)
  candles.push(makeCandle(24, 1.0990, 1.1000, 1.0960, 1.0970));

  const inducements = detectInducements(candles);

  // Should find at least one bull trap
  const bullTraps = inducements.filter((i) => i.trapDirection === "bull_trap");
  assertEquals(bullTraps.length > 0, true, "Should detect at least one bull trap");

  const best = bullTraps[0];
  assertEquals(best.type, "minor_swing");
  assertEquals(best.impliedDirection, "short");
  assertEquals(best.hasDisplacement, true);
  assertEquals(best.confirmed, true);
  assertEquals(best.quality >= 5, true, `Quality should be >= 5, got ${best.quality}`);
});

// ─── Test: Bear Trap (Minor Swing Inducement) ────────────────────────

Deno.test("detectInducements finds bear trap on minor swing low sweep", () => {
  const candles: Candle[] = [];
  const base = 1.2000;

  // 15 candles trending down to establish ATR
  for (let i = 0; i < 15; i++) {
    const o = base - i * 0.0010;
    candles.push(makeCandle(i, o, o + 0.0005, o - 0.0015, o - 0.0010));
  }

  // Swing low at index 15 (low = 1.1835)
  candles.push(makeCandle(15, 1.1850, 1.1860, 1.1835, 1.1855));

  // Bounce up (3 candles)
  candles.push(makeCandle(16, 1.1855, 1.1880, 1.1850, 1.1875));
  candles.push(makeCandle(17, 1.1875, 1.1900, 1.1870, 1.1895));
  candles.push(makeCandle(18, 1.1895, 1.1910, 1.1890, 1.1905));

  // Lower swing
  candles.push(makeCandle(19, 1.1905, 1.1910, 1.1890, 1.1895));

  // Pull back down
  candles.push(makeCandle(20, 1.1895, 1.1900, 1.1870, 1.1875));
  candles.push(makeCandle(21, 1.1875, 1.1880, 1.1860, 1.1865));

  // Sweep the swing low at 1.1835 — wick below but close above
  candles.push(makeCandle(22, 1.1865, 1.1870, 1.1820, 1.1860)); // Bear trap! Low < 1.1835, close > 1.1835

  // Displacement candle (strong bullish)
  candles.push(makeCandle(23, 1.1860, 1.1940, 1.1855, 1.1930)); // Big bullish candle

  // Continuation up
  candles.push(makeCandle(24, 1.1930, 1.1960, 1.1925, 1.1950));

  const inducements = detectInducements(candles);
  const bearTraps = inducements.filter((i) => i.trapDirection === "bear_trap");
  assertEquals(bearTraps.length > 0, true, "Should detect at least one bear trap");

  const best = bearTraps[0];
  assertEquals(best.impliedDirection, "long");
  assertEquals(best.hasDisplacement, true);
});

// ─── Test: Equal Level Trap ──────────────────────────────────────────

Deno.test("detectInducements finds equal highs trap", () => {
  const candles: Candle[] = [];
  const base = 1.1000;

  // 15 candles for ATR (deterministic, ranging around 1.1000)
  for (let i = 0; i < 15; i++) {
    const o = base + (i % 2 === 0 ? 0.0005 : -0.0005);
    candles.push(makeCandle(i, o, o + 0.0012, o - 0.0012, o + (i % 2 === 0 ? 0.0003 : -0.0003)));
  }

  // First swing high at 1.1050 (index 15)
  // Needs lookback=3: indices 12,13,14 all have highs < 1.1050 ✓
  // And indices 16,17,18 all have highs < 1.1050 ✓
  candles.push(makeCandle(15, 1.1030, 1.1050, 1.1025, 1.1035));
  candles.push(makeCandle(16, 1.1035, 1.1040, 1.1010, 1.1015));
  candles.push(makeCandle(17, 1.1015, 1.1020, 1.1000, 1.1005));
  candles.push(makeCandle(18, 1.1005, 1.1010, 1.0995, 1.1008));

  // Second swing high at 1.1051 (index 19) — equal to first within ATR tolerance
  // Needs lookback=3: indices 16,17,18 all have highs < 1.1051 ✓
  // And indices 20,21,22 all have highs < 1.1051 ✓
  candles.push(makeCandle(19, 1.1030, 1.1051, 1.1025, 1.1035));
  candles.push(makeCandle(20, 1.1035, 1.1040, 1.1020, 1.1025));
  candles.push(makeCandle(21, 1.1025, 1.1030, 1.1010, 1.1015));
  candles.push(makeCandle(22, 1.1015, 1.1020, 1.1005, 1.1010));

  // Pullback before sweep
  candles.push(makeCandle(23, 1.1010, 1.1015, 1.0995, 1.1000));
  candles.push(makeCandle(24, 1.1000, 1.1005, 1.0990, 1.0995));

  // Sweep both equal highs (index 25) — wick above 1.1051, close below
  candles.push(makeCandle(25, 1.0995, 1.1075, 1.0990, 1.1010)); // Bull trap!

  // Displacement down (index 26)
  candles.push(makeCandle(26, 1.1010, 1.1015, 1.0940, 1.0950)); // Strong bearish

  // Confirmation (index 27)
  candles.push(makeCandle(27, 1.0950, 1.0960, 1.0930, 1.0935));

  const inducements = detectInducements(candles);
  const equalTraps = inducements.filter((i) => i.type === "equal_level");

  // Should find at least one equal level trap
  assertEquals(equalTraps.length > 0, true, "Should detect equal level trap");
  if (equalTraps.length > 0) {
    assertEquals(equalTraps[0].trapDirection, "bull_trap");
    assertEquals(equalTraps[0].impliedDirection, "short");
  }
});

// ─── Test: No false positives on clean trend ─────────────────────────

Deno.test("detectInducements returns empty on clean uptrend without sweeps", () => {
  // Clean uptrend — no sweeps, no traps
  const candles: Candle[] = [];
  for (let i = 0; i < 30; i++) {
    const base = 1.1000 + i * 0.0008;
    candles.push(makeCandle(i, base, base + 0.0010, base - 0.0003, base + 0.0008));
  }

  const inducements = detectInducements(candles);
  // In a clean trend, there should be few or no confirmed inducements
  const confirmed = inducements.filter((i) => i.confirmed);
  assertEquals(confirmed.length, 0, "Clean trend should have no confirmed inducements");
});

// ─── Test: findSupportingInducement filters correctly ────────────────

Deno.test("findSupportingInducement returns matching inducement for direction", () => {
  const inducements: Inducement[] = [
    {
      type: "minor_swing", trapDirection: "bull_trap", level: 1.1050,
      sweepDepth: 0.0015, sweepIndex: 20, sweepTime: "2025-03-01T20:00:00Z",
      dwellCandles: 1, quality: 7, hasDisplacement: true, confirmed: true,
      impliedDirection: "short", detail: "test",
    },
    {
      type: "equal_level", trapDirection: "bear_trap", level: 1.0950,
      sweepDepth: 0.0020, sweepIndex: 18, sweepTime: "2025-03-01T18:00:00Z",
      dwellCandles: 1, quality: 8, hasDisplacement: true, confirmed: true,
      impliedDirection: "long", detail: "test",
    },
    {
      type: "minor_swing", trapDirection: "bear_trap", level: 1.0900,
      sweepDepth: 0.0010, sweepIndex: 5, sweepTime: "2025-03-01T05:00:00Z",
      dwellCandles: 2, quality: 5, hasDisplacement: false, confirmed: true,
      impliedDirection: "long", detail: "test old",
    },
  ];

  // Looking for long support at current index 25
  const longSupport = findSupportingInducement(inducements, "long", 25, 10);
  assertEquals(longSupport !== null, true);
  assertEquals(longSupport!.quality, 8); // Should pick the higher quality one

  // Looking for short support
  const shortSupport = findSupportingInducement(inducements, "short", 25, 10);
  assertEquals(shortSupport !== null, true);
  assertEquals(shortSupport!.trapDirection, "bull_trap");

  // Old inducement should be filtered by maxAge
  const oldLong = findSupportingInducement(inducements, "long", 25, 8);
  // The one at index 18 is within 8 candles of 25 (distance=7), but index 5 is not (distance=20)
  assertEquals(oldLong !== null, true);
  assertEquals(oldLong!.sweepIndex, 18);
});

Deno.test("findSupportingInducement returns null when no match", () => {
  const inducements: Inducement[] = [
    {
      type: "minor_swing", trapDirection: "bull_trap", level: 1.1050,
      sweepDepth: 0.0015, sweepIndex: 20, sweepTime: "2025-03-01T20:00:00Z",
      dwellCandles: 1, quality: 3, hasDisplacement: false, confirmed: true,
      impliedDirection: "short", detail: "low quality",
    },
  ];

  // Quality too low (< 4)
  const result = findSupportingInducement(inducements, "short", 22, 10);
  assertEquals(result, null);
});

Deno.test("detectInducements handles insufficient data gracefully", () => {
  const candles: Candle[] = [
    makeCandle(0, 1.1000, 1.1010, 1.0990, 1.1005),
    makeCandle(1, 1.1005, 1.1015, 1.0995, 1.1010),
  ];
  const result = detectInducements(candles);
  assertEquals(result.length, 0);
});
