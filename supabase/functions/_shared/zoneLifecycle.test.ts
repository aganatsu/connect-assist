/**
 * zoneLifecycle.test.ts — Tests for Zone Reusability & Invalidation Engine
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  evaluateZoneLifecycle,
  compareLifecycleMethods,
  DEFAULT_ZONE_LIFECYCLE_CONFIG,
  type ZoneState,
} from "./zoneLifecycle.ts";
import type { Candle } from "./smcAnalysis.ts";

function makeCandle(o: number, h: number, l: number, c: number, t: number): Candle {
  return { open: o, high: h, low: l, close: c, volume: 100, datetime: new Date(t * 1000).toISOString() };
}

// ─── Bullish Zone Tests ───────────────────────────────────────────────────────

Deno.test("zoneLifecycle — fresh bullish zone: no candles touch it", () => {
  const zone = { high: 1.1010, low: 1.1000, direction: "bullish" as const };
  // All candles stay above the zone
  const candles = [
    makeCandle(1.1020, 1.1030, 1.1015, 1.1025, 1000),
    makeCandle(1.1025, 1.1035, 1.1020, 1.1030, 2000),
  ];
  const result = evaluateZoneLifecycle(zone, candles);

  assertEquals(result.state, "fresh");
  assertEquals(result.retestCount, 0);
  assertEquals(result.closedThrough, false);
  assertEquals(result.confidenceMultiplier, 1.0);
  assertEquals(result.canStillTrade, true);
});

Deno.test("zoneLifecycle — bullish zone tested once: wick into zone but close above", () => {
  const zone = { high: 1.1010, low: 1.1000, direction: "bullish" as const };
  const candles = [
    makeCandle(1.1020, 1.1025, 1.1015, 1.1020, 1000), // above zone
    makeCandle(1.1015, 1.1018, 1.1005, 1.1012, 2000), // wick into zone (low=1.1005) but close above zone.low
    makeCandle(1.1012, 1.1020, 1.1010, 1.1018, 3000), // back above
  ];
  const result = evaluateZoneLifecycle(zone, candles);

  assertEquals(result.state, "tested_1");
  assertEquals(result.retestCount, 1);
  assertEquals(result.closedThrough, false);
  assertEquals(result.confidenceMultiplier, 0.75);
  assertEquals(result.canStillTrade, true);
});

Deno.test("zoneLifecycle — bullish zone: deep wick (80%) but no close through = still valid", () => {
  const zone = { high: 1.1010, low: 1.1000, direction: "bullish" as const };
  // Wick goes to 1.1002 (80% penetration) but closes at 1.1008 (inside zone but above low)
  const candles = [
    makeCandle(1.1015, 1.1018, 1.1002, 1.1008, 1000),
  ];
  const result = evaluateZoneLifecycle(zone, candles);

  assertEquals(result.state, "tested_1");
  assert(result.maxPenetrationPercent >= 70, `Penetration ${result.maxPenetrationPercent} should be >= 70%`);
  assertEquals(result.closedThrough, false);
  assertEquals(result.canStillTrade, true);
});

Deno.test("zoneLifecycle — bullish zone invalidated: candle closes below zone.low", () => {
  const zone = { high: 1.1010, low: 1.1000, direction: "bullish" as const };
  const candles = [
    makeCandle(1.1015, 1.1018, 1.1012, 1.1014, 1000), // above zone
    makeCandle(1.1010, 1.1012, 1.0995, 1.0997, 2000), // closes below zone.low (1.0997 < 1.1000)
  ];
  const result = evaluateZoneLifecycle(zone, candles);

  assertEquals(result.state, "invalidated");
  assertEquals(result.closedThrough, true);
  assertEquals(result.closedThroughIndex, 1);
  assertEquals(result.confidenceMultiplier, 0);
  assertEquals(result.canStillTrade, false);
});

Deno.test("zoneLifecycle — bullish zone: wick below zone.low but close above = sweep, not invalidation", () => {
  const zone = { high: 1.1010, low: 1.1000, direction: "bullish" as const };
  // Wick goes below zone.low but closes back above it
  const candles = [
    makeCandle(1.1008, 1.1012, 1.0995, 1.1005, 1000), // low=0.9995 < zone.low, but close=1.1005 > zone.low
  ];
  const result = evaluateZoneLifecycle(zone, candles);

  assertEquals(result.closedThrough, false);
  assertEquals(result.canStillTrade, true);
  // This is a test (price entered zone)
  assertEquals(result.retestCount, 1);
});

Deno.test("zoneLifecycle — bullish zone tested 3 times: exhausted", () => {
  const zone = { high: 1.1010, low: 1.1000, direction: "bullish" as const };
  // Three distinct tests with gaps between them
  const candles = [
    makeCandle(1.1015, 1.1018, 1.1005, 1.1012, 1000), // test 1
    makeCandle(1.1012, 1.1020, 1.1011, 1.1018, 2000), // gap (above zone)
    makeCandle(1.1018, 1.1020, 1.1007, 1.1015, 3000), // test 2
    makeCandle(1.1015, 1.1022, 1.1013, 1.1020, 4000), // gap
    makeCandle(1.1020, 1.1022, 1.1006, 1.1014, 5000), // test 3
  ];
  const result = evaluateZoneLifecycle(zone, candles);

  assertEquals(result.state, "tested_3_plus");
  assert(result.retestCount >= 3, `Retest count ${result.retestCount} should be >= 3`);
  assertEquals(result.confidenceMultiplier, 0.25);
  assertEquals(result.canStillTrade, false); // maxRetests default is 3
});

// ─── Bearish Zone Tests ───────────────────────────────────────────────────────

Deno.test("zoneLifecycle — fresh bearish zone: no candles touch it", () => {
  const zone = { high: 1.1020, low: 1.1010, direction: "bearish" as const };
  // All candles stay below the zone
  const candles = [
    makeCandle(1.1005, 1.1008, 1.1000, 1.1003, 1000),
    makeCandle(1.1003, 1.1006, 1.0998, 1.1002, 2000),
  ];
  const result = evaluateZoneLifecycle(zone, candles);

  assertEquals(result.state, "fresh");
  assertEquals(result.retestCount, 0);
  assertEquals(result.canStillTrade, true);
});

Deno.test("zoneLifecycle — bearish zone invalidated: candle closes above zone.high", () => {
  const zone = { high: 1.1020, low: 1.1010, direction: "bearish" as const };
  const candles = [
    makeCandle(1.1005, 1.1008, 1.1000, 1.1006, 1000),
    makeCandle(1.1015, 1.1025, 1.1012, 1.1022, 2000), // closes above zone.high
  ];
  const result = evaluateZoneLifecycle(zone, candles);

  assertEquals(result.state, "invalidated");
  assertEquals(result.closedThrough, true);
  assertEquals(result.canStillTrade, false);
});

Deno.test("zoneLifecycle — bearish zone: wick above zone.high but close below = sweep, not invalidation", () => {
  const zone = { high: 1.1020, low: 1.1010, direction: "bearish" as const };
  const candles = [
    makeCandle(1.1015, 1.1025, 1.1012, 1.1018, 1000), // wick above zone.high, close below
  ];
  const result = evaluateZoneLifecycle(zone, candles);

  assertEquals(result.closedThrough, false);
  assertEquals(result.canStillTrade, true);
});

// ─── Breaker Candidate Tests ─────────────────────────────────────────────────

Deno.test("zoneLifecycle — breaker candidate: sweep then close through", () => {
  const zone = { high: 1.1010, low: 1.1000, direction: "bullish" as const };
  const candles = [
    // First: wick below zone.low but close above (sweep)
    makeCandle(1.1005, 1.1008, 1.0995, 1.1003, 1000),
    // Then: close below zone.low (invalidation after sweep)
    makeCandle(1.1003, 1.1005, 1.0990, 1.0992, 2000),
  ];
  const result = evaluateZoneLifecycle(zone, candles);

  assertEquals(result.state, "breaker_candidate");
  assertEquals(result.breakerCandidate, true);
  assertEquals(result.canStillTrade, false);
});

Deno.test("zoneLifecycle — NOT breaker candidate when no prior sweep", () => {
  const zone = { high: 1.1010, low: 1.1000, direction: "bullish" as const };
  const candles = [
    // Direct close through without prior sweep
    makeCandle(1.1005, 1.1008, 1.0990, 1.0992, 1000),
  ];
  const result = evaluateZoneLifecycle(zone, candles);

  assertEquals(result.state, "invalidated");
  assertEquals(result.breakerCandidate, false);
});

// ─── Comparison Tests ────────────────────────────────────────────────────────

Deno.test("compareLifecycleMethods — divergence: old kills zone at 50%, new keeps it", () => {
  const zone = { high: 1.1010, low: 1.1000, direction: "bullish" as const };
  // Wick penetrates 60% into zone (below midpoint) but closes above zone.low
  const candles = [
    makeCandle(1.1012, 1.1015, 1.1004, 1.1008, 1000), // low=1.1004, mid=1.1005, so low < mid
  ];
  const comparison = compareLifecycleMethods(zone, candles);

  // Old method: 50% penetration → mitigated → won't trade
  assertEquals(comparison.oldWouldTrade, false);
  // New method: no close through → still valid
  assertEquals(comparison.newWouldTrade, true);
  assertEquals(comparison.diverges, true);
  assert(comparison.reason.includes("New logic allows"), `Reason should explain divergence: ${comparison.reason}`);
});

Deno.test("compareLifecycleMethods — agreement: both allow fresh zone", () => {
  const zone = { high: 1.1010, low: 1.1000, direction: "bullish" as const };
  const candles = [
    makeCandle(1.1020, 1.1025, 1.1015, 1.1022, 1000), // stays above zone
  ];
  const comparison = compareLifecycleMethods(zone, candles);

  assertEquals(comparison.oldWouldTrade, true);
  assertEquals(comparison.newWouldTrade, true);
  assertEquals(comparison.diverges, false);
});

Deno.test("compareLifecycleMethods — agreement: both reject broken zone", () => {
  const zone = { high: 1.1010, low: 1.1000, direction: "bullish" as const };
  const candles = [
    makeCandle(1.1005, 1.1008, 1.0990, 1.0992, 1000), // closes below zone.low
  ];
  const comparison = compareLifecycleMethods(zone, candles);

  assertEquals(comparison.oldWouldTrade, false);
  assertEquals(comparison.newWouldTrade, false);
  assertEquals(comparison.diverges, false);
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

Deno.test("zoneLifecycle — zero-height zone returns fresh safely", () => {
  const zone = { high: 1.1000, low: 1.1000, direction: "bullish" as const };
  const candles = [makeCandle(1.1000, 1.1005, 1.0995, 1.1002, 1000)];
  const result = evaluateZoneLifecycle(zone, candles);

  assertEquals(result.state, "fresh");
  assert(result.detail.includes("zero height"));
});

Deno.test("zoneLifecycle — empty candles array returns fresh", () => {
  const zone = { high: 1.1010, low: 1.1000, direction: "bullish" as const };
  const result = evaluateZoneLifecycle(zone, []);

  assertEquals(result.state, "fresh");
  assertEquals(result.retestCount, 0);
  assertEquals(result.canStillTrade, true);
});

Deno.test("zoneLifecycle — custom config: maxRetests=1 makes tested_1 untradeable", () => {
  const zone = { high: 1.1010, low: 1.1000, direction: "bullish" as const };
  const candles = [
    makeCandle(1.1015, 1.1018, 1.1005, 1.1012, 1000), // one test
  ];
  const result = evaluateZoneLifecycle(zone, candles, { maxRetests: 1 });

  assertEquals(result.state, "tested_1");
  assertEquals(result.canStillTrade, false); // maxRetests=1 means even 1 test exhausts it
});
