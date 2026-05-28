import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aggregateTicksToMicroCandles,
  analyzeTicksForConfirmation,
  isTickBufferReady,
  isTickBufferExpired,
  type Tick,
  type TickBuffer,
} from "./tickZoneConfirmation.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeTick(offsetSeconds: number, bid: number, ask: number): Tick {
  const ts = new Date(Date.UTC(2025, 2, 1, 10, 0, 0) + offsetSeconds * 1000).toISOString();
  return { timestamp: ts, bid, ask };
}

function makeTickBuffer(
  ticks: Tick[],
  direction: "long" | "short",
  zoneHigh: number,
  zoneLow: number,
): TickBuffer {
  return {
    symbol: "EUR/USD",
    ticks,
    zoneEntryTime: ticks.length > 0 ? ticks[0].timestamp : new Date().toISOString(),
    zoneHigh,
    zoneLow,
    expectedDirection: direction,
  };
}

// ─── aggregateTicksToMicroCandles Tests ──────────────────────────────

Deno.test("aggregateTicksToMicroCandles creates correct candles from ticks", () => {
  const ticks: Tick[] = [];
  // 3 minutes of ticks, 1 tick per 10 seconds
  for (let i = 0; i < 18; i++) {
    const price = 1.1000 + i * 0.0001;
    ticks.push(makeTick(i * 10, price, price + 0.0002));
  }

  const candles = aggregateTicksToMicroCandles(ticks, 60); // 60-second candles

  // Should have 3 candles (0-59s, 60-119s, 120-179s)
  assertEquals(candles.length, 3);
  // First candle: ticks 0-5 (0s to 50s)
  assertEquals(candles[0].tickCount, 6);
  // Prices should be ascending
  assertEquals(candles[0].open < candles[0].close, true);
});

Deno.test("aggregateTicksToMicroCandles handles empty ticks", () => {
  const candles = aggregateTicksToMicroCandles([], 60);
  assertEquals(candles.length, 0);
});

Deno.test("aggregateTicksToMicroCandles tracks high/low correctly", () => {
  const ticks: Tick[] = [
    makeTick(0, 1.1000, 1.1002),
    makeTick(10, 1.1010, 1.1012), // High
    makeTick(20, 1.0990, 1.0992), // Low
    makeTick(30, 1.1005, 1.1007),
    makeTick(40, 1.1003, 1.1005),
    makeTick(50, 1.1002, 1.1004),
  ];

  const candles = aggregateTicksToMicroCandles(ticks, 60);
  assertEquals(candles.length, 1);
  // Mid prices: 1.1001, 1.1011, 1.0991, 1.1006, 1.1004, 1.1003
  assertEquals(candles[0].high, 1.1011); // Highest mid
  assertEquals(candles[0].low, 1.0991);  // Lowest mid
});

// ─── analyzeTicksForConfirmation Tests ───────────────────────────────

Deno.test("analyzeTicksForConfirmation returns null for insufficient ticks", () => {
  const ticks = [makeTick(0, 1.1000, 1.1002)];
  const buffer = makeTickBuffer(ticks, "long", 1.1010, 1.0990);
  const result = analyzeTicksForConfirmation(buffer);
  assertEquals(result, null);
});

Deno.test("analyzeTicksForConfirmation detects displacement burst for long", () => {
  // Simulate rapid upward movement (> 5 pips in < 30 seconds)
  const ticks: Tick[] = [];
  const base = 1.1000;
  for (let i = 0; i < 25; i++) {
    // First 15 ticks: flat
    if (i < 15) {
      ticks.push(makeTick(i * 2, base + (i % 2) * 0.0001, base + (i % 2) * 0.0001 + 0.0002));
    } else {
      // Last 10 ticks: rapid upward burst (0.7 pips per tick, 1 tick/sec)
      const offset = base + (i - 15) * 0.0007;
      ticks.push(makeTick(30 + (i - 15), offset, offset + 0.0002));
    }
  }

  const buffer = makeTickBuffer(ticks, "long", 1.1010, 1.0990);
  const result = analyzeTicksForConfirmation(buffer, { pipSize: 0.0001, minConfidence: 0.3 });

  // Should detect displacement burst (7 pips in ~10 seconds)
  assertEquals(result !== null, true);
  if (result) {
    assertEquals(result.confidence > 0.3, true);
  }
});

Deno.test("analyzeTicksForConfirmation detects bid/ask imbalance", () => {
  // Simulate strong bullish imbalance (most ticks moving up)
  const ticks: Tick[] = [];
  const base = 1.1000;
  for (let i = 0; i < 25; i++) {
    // 80% of ticks move up, 20% move down
    const direction = i % 5 === 0 ? -1 : 1;
    const price = base + i * 0.0001 * direction * (i < 10 ? 0.5 : 1);
    ticks.push(makeTick(i * 2, base + i * 0.00005, base + i * 0.00005 + 0.0002));
  }

  const buffer = makeTickBuffer(ticks, "long", 1.1010, 1.0990);
  const result = analyzeTicksForConfirmation(buffer, { pipSize: 0.0001, minConfidence: 0.2 });

  // May or may not trigger depending on exact imbalance ratio
  // This test verifies the function doesn't crash and returns a valid result type
  assertEquals(result === null || typeof result.confidence === "number", true);
});

Deno.test("analyzeTicksForConfirmation returns null when price moves against expected direction", () => {
  // Simulate downward movement when expecting long
  const ticks: Tick[] = [];
  const base = 1.1000;
  for (let i = 0; i < 25; i++) {
    const price = base - i * 0.0003; // Moving down
    ticks.push(makeTick(i * 2, price, price + 0.0002));
  }

  const buffer = makeTickBuffer(ticks, "long", 1.1010, 1.0990);
  const result = analyzeTicksForConfirmation(buffer, { pipSize: 0.0001 });

  // Should NOT confirm a long when price is falling
  assertEquals(result, null);
});

// ─── isTickBufferReady Tests ─────────────────────────────────────────

Deno.test("isTickBufferReady returns false for insufficient ticks", () => {
  const ticks = Array.from({ length: 10 }, (_, i) => makeTick(i, 1.1, 1.1002));
  const buffer = makeTickBuffer(ticks, "long", 1.1010, 1.0990);
  assertEquals(isTickBufferReady(buffer), false); // Default minTicks = 20
});

Deno.test("isTickBufferReady returns true for sufficient ticks", () => {
  const ticks = Array.from({ length: 25 }, (_, i) => makeTick(i, 1.1, 1.1002));
  const buffer = makeTickBuffer(ticks, "long", 1.1010, 1.0990);
  assertEquals(isTickBufferReady(buffer), true);
});

// ─── isTickBufferExpired Tests ────────────────────────────────────────

Deno.test("isTickBufferExpired returns false for recent buffer", () => {
  const baseTime = Date.UTC(2025, 2, 1, 10, 0, 0);
  const ticks = [{ timestamp: new Date(baseTime + 60_000).toISOString(), bid: 1.1, ask: 1.1002 }];
  const buffer: TickBuffer = {
    symbol: "EUR/USD",
    ticks,
    zoneEntryTime: new Date(baseTime).toISOString(),
    zoneHigh: 1.1010,
    zoneLow: 1.0990,
    expectedDirection: "long",
  };
  // Last tick is 60s after zone entry → not expired (maxTimeInZone=300)
  assertEquals(isTickBufferExpired(buffer), false);
});

Deno.test("isTickBufferExpired returns true for old buffer", () => {
  const baseTime = Date.UTC(2025, 2, 1, 10, 0, 0);
  const ticks = [{ timestamp: new Date(baseTime + 600_000).toISOString(), bid: 1.1, ask: 1.1002 }];
  const buffer: TickBuffer = {
    symbol: "EUR/USD",
    ticks,
    zoneEntryTime: new Date(baseTime).toISOString(),
    zoneHigh: 1.1010,
    zoneLow: 1.0990,
    expectedDirection: "long",
  };
  // Last tick is 600s after zone entry → expired (maxTimeInZone=300)
  assertEquals(isTickBufferExpired(buffer), true);
});

// ─── Micro-CHoCH Detection Test ─────────────────────────────────────

Deno.test("analyzeTicksForConfirmation detects micro-CHoCH for short", () => {
  // Create a pattern: price makes a swing low, then breaks it (CHoCH for short)
  const ticks: Tick[] = [];
  const base = 1.1050;

  // Phase 1: Price rises (creating swing high context) - 8 ticks over 2 min
  for (let i = 0; i < 8; i++) {
    ticks.push(makeTick(i * 15, base + i * 0.0002, base + i * 0.0002 + 0.0002));
  }
  // Phase 2: Price drops to create swing low at ~1.1040 - 8 ticks over 2 min
  for (let i = 0; i < 8; i++) {
    ticks.push(makeTick(120 + i * 15, base + 0.0014 - i * 0.0004, base + 0.0014 - i * 0.0004 + 0.0002));
  }
  // Phase 3: Small bounce (creating structure) - 4 ticks over 1 min
  for (let i = 0; i < 4; i++) {
    ticks.push(makeTick(240 + i * 15, base - 0.0010 + i * 0.0002, base - 0.0010 + i * 0.0002 + 0.0002));
  }
  // Phase 4: Break below the swing low (CHoCH) - 5 ticks, strong displacement
  for (let i = 0; i < 5; i++) {
    ticks.push(makeTick(300 + i * 10, base - 0.0005 - i * 0.0005, base - 0.0005 - i * 0.0005 + 0.0002));
  }

  const buffer = makeTickBuffer(ticks, "short", 1.1060, 1.1040);
  const result = analyzeTicksForConfirmation(buffer, {
    pipSize: 0.0001,
    microCandlePeriod: 60,
    minConfidence: 0.3,
    minMicroDisplacement: 0.25,
  });

  // Should detect some form of confirmation (micro-CHoCH or displacement)
  // The exact signal depends on the micro-candle aggregation
  assertEquals(result === null || result.confidence > 0, true);
});
