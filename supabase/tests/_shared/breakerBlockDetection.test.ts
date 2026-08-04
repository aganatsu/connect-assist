/**
 * breakerBlockDetection.test.ts — Tests for Break and Retest Entry Model
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  detectBreakerBlocks,
  isAtBreakerRetest,
  DEFAULT_BREAKER_CONFIG,
} from "./breakerBlockDetection.ts";
import type { Candle, OrderBlock } from "./smcAnalysis.ts";

function makeCandle(o: number, h: number, l: number, c: number, t: number): Candle {
  return { open: o, high: h, low: l, close: c, volume: 100, datetime: new Date(t * 1000).toISOString() };
}

function makeOB(overrides: Partial<OrderBlock> & { high: number; low: number; type: "bullish" | "bearish"; index: number }): OrderBlock {
  return {
    datetime: new Date(overrides.index * 3600 * 1000).toISOString(),
    mitigated: false,
    mitigatedPercent: 0,
    state: "fresh",
    testedCount: 0,
    ...overrides,
  };
}

/**
 * Generate a full candle array that creates a valid breaker scenario:
 * 1. Bullish OB forms at index 5
 * 2. Liquidity sweep below OB at index 10
 * 3. Strong displacement break below OB at index 15
 * 4. Retest of broken zone at index 20
 */
function makeBreakerScenario(): { candles: Candle[]; ob: OrderBlock } {
  const candles: Candle[] = [];
  const baseTime = 1700000000;
  const basePrice = 1.1000;

  // Build 30 candles with a trending-then-breaking pattern
  for (let i = 0; i < 30; i++) {
    let o: number, h: number, l: number, c: number;

    if (i < 5) {
      // Pre-OB: mild uptrend
      o = basePrice + i * 0.0005;
      c = o + 0.0004;
      h = c + 0.0002;
      l = o - 0.0002;
    } else if (i === 5) {
      // OB candle (bullish)
      o = basePrice + 0.0025;
      c = o + 0.0008;
      h = c + 0.0002;
      l = o - 0.0001;
    } else if (i < 10) {
      // Continuation above OB
      o = basePrice + 0.0035 + (i - 6) * 0.0003;
      c = o + 0.0003;
      h = c + 0.0002;
      l = o - 0.0002;
    } else if (i === 10) {
      // Liquidity sweep: wick below OB low but close above
      o = basePrice + 0.0040;
      l = basePrice + 0.0020; // Below OB low (0.0024)
      c = basePrice + 0.0035; // Close above OB low
      h = o + 0.0002;
    } else if (i < 15) {
      // Consolidation
      o = basePrice + 0.0035 - (i - 11) * 0.0003;
      c = o - 0.0002;
      h = o + 0.0002;
      l = c - 0.0002;
    } else if (i === 15) {
      // DISPLACEMENT BREAK: large bearish candle closing below OB low
      o = basePrice + 0.0030;
      c = basePrice + 0.0010; // Well below OB low
      h = o + 0.0002;
      l = c - 0.0003;
    } else if (i < 20) {
      // Continuation down
      o = basePrice + 0.0010 - (i - 16) * 0.0003;
      c = o - 0.0003;
      h = o + 0.0002;
      l = c - 0.0002;
    } else if (i === 20) {
      // RETEST: price comes back up to the broken OB zone
      o = basePrice + 0.0005;
      c = basePrice + 0.0028; // Close inside the old OB zone
      h = basePrice + 0.0030;
      l = o - 0.0002;
    } else {
      // After retest: continuation
      o = basePrice + 0.0025 - (i - 21) * 0.0003;
      c = o - 0.0003;
      h = o + 0.0002;
      l = c - 0.0002;
    }

    candles.push(makeCandle(o, h, l, c, baseTime + i * 3600));
  }

  // The bullish OB at index 5
  const ob = makeOB({
    index: 5,
    high: basePrice + 0.0035, // OB high
    low: basePrice + 0.0024,  // OB low
    type: "bullish",
    state: "broken",
    brokenAt: 15,
    testedCount: 1,
  });

  return { candles, ob };
}

// ─── Detection Tests ──────────────────────────────────────────────────────────

Deno.test("detectBreakerBlocks — detects valid breaker with sweep + displacement + retest", () => {
  const { candles, ob } = makeBreakerScenario();
  const breakers = detectBreakerBlocks([ob], candles, { requireSweep: false, minDisplacementATR: 0.5 });

  assert(breakers.length >= 1, `Should detect at least 1 breaker, got ${breakers.length}`);
  const b = breakers[0];
  assertEquals(b.direction, "bearish"); // Bullish OB broken → bearish breaker
  assertEquals(b.breakIndex, 15);
  assert(b.displacementStrength > 0, "Should have positive displacement");
});

Deno.test("detectBreakerBlocks — rejects when no displacement", () => {
  const { candles, ob } = makeBreakerScenario();
  // Require very high displacement
  const breakers = detectBreakerBlocks([ob], candles, { minDisplacementATR: 10.0, requireSweep: false });

  assertEquals(breakers.length, 0);
});

Deno.test("detectBreakerBlocks — rejects fresh/untouched OBs", () => {
  const { candles } = makeBreakerScenario();
  const freshOB = makeOB({
    index: 5,
    high: 1.1035,
    low: 1.1024,
    type: "bullish",
    state: "fresh",
    testedCount: 0,
  });
  const breakers = detectBreakerBlocks([freshOB], candles);

  assertEquals(breakers.length, 0);
});

Deno.test("detectBreakerBlocks — rejects when break too close to OB formation", () => {
  const { candles } = makeBreakerScenario();
  const ob = makeOB({
    index: 13, // Only 2 candles before break at 15
    high: 1.1035,
    low: 1.1024,
    type: "bullish",
    state: "broken",
    brokenAt: 15,
    testedCount: 0,
  });
  const breakers = detectBreakerBlocks([ob], candles, { requireSweep: false, minDisplacementATR: 0.5, minCandlesBetween: 3 });

  assertEquals(breakers.length, 0);
});

Deno.test("detectBreakerBlocks — empty OB array returns empty", () => {
  const { candles } = makeBreakerScenario();
  const breakers = detectBreakerBlocks([], candles);
  assertEquals(breakers.length, 0);
});

Deno.test("detectBreakerBlocks — insufficient candles returns empty", () => {
  const candles = [makeCandle(1.1, 1.11, 1.09, 1.105, 1000)];
  const ob = makeOB({ index: 0, high: 1.11, low: 1.10, type: "bullish", state: "broken", brokenAt: 0 });
  const breakers = detectBreakerBlocks([ob], candles);
  assertEquals(breakers.length, 0);
});

// ─── isAtBreakerRetest Tests ─────────────────────────────────────────────────

Deno.test("isAtBreakerRetest — detects candle at bearish breaker zone", () => {
  const breaker = {
    originalOB: { high: 1.1035, low: 1.1024, type: "bullish" as const, index: 5 },
    direction: "bearish" as const,
    entryZone: { high: 1.1035, low: 1.1024 },
    breakIndex: 15,
    retestIndex: null,
    hadLiquiditySweep: true,
    displacementStrength: 2.0,
    retestComplete: false,
    confidence: 0.7,
    detail: "test",
  };

  // Candle that reaches up into the zone
  const atZone = makeCandle(1.1020, 1.1030, 1.1018, 1.1025, 1000);
  assertEquals(isAtBreakerRetest(atZone, breaker), true);

  // Candle that stays below the zone
  const belowZone = makeCandle(1.1010, 1.1015, 1.1005, 1.1012, 2000);
  assertEquals(isAtBreakerRetest(belowZone, breaker), false);
});

Deno.test("isAtBreakerRetest — returns false if retest already complete", () => {
  const breaker = {
    originalOB: { high: 1.1035, low: 1.1024, type: "bullish" as const, index: 5 },
    direction: "bearish" as const,
    entryZone: { high: 1.1035, low: 1.1024 },
    breakIndex: 15,
    retestIndex: 20,
    hadLiquiditySweep: true,
    displacementStrength: 2.0,
    retestComplete: true, // Already retested
    confidence: 0.8,
    detail: "test",
  };

  const atZone = makeCandle(1.1020, 1.1030, 1.1018, 1.1025, 1000);
  assertEquals(isAtBreakerRetest(atZone, breaker), false);
});

Deno.test("isAtBreakerRetest — detects candle at bullish breaker zone", () => {
  const breaker = {
    originalOB: { high: 1.1035, low: 1.1024, type: "bearish" as const, index: 5 },
    direction: "bullish" as const,
    entryZone: { high: 1.1035, low: 1.1024 },
    breakIndex: 15,
    retestIndex: null,
    hadLiquiditySweep: true,
    displacementStrength: 2.0,
    retestComplete: false,
    confidence: 0.7,
    detail: "test",
  };

  // Candle that dips down into the zone from above
  const atZone = makeCandle(1.1040, 1.1042, 1.1028, 1.1032, 1000);
  assertEquals(isAtBreakerRetest(atZone, breaker), true);

  // Candle that stays above the zone
  const aboveZone = makeCandle(1.1040, 1.1050, 1.1038, 1.1045, 2000);
  assertEquals(isAtBreakerRetest(aboveZone, breaker), false);
});
