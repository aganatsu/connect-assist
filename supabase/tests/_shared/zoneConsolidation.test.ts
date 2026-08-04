/**
 * zoneConsolidation.test.ts — Regression test for the zone engine consolidation.
 *
 * Verifies that deriving detail.impulseZone from the unified engine's multiTFResult
 * produces the same fields as the old separate findBestEntryZoneMultiTF call would have.
 *
 * This ensures the consolidation (removing the separate impulseZoneEngine call in bot-scanner
 * and using the unified engine's multiTFResult instead) is a pure refactor with no data loss.
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { findBestEntryZoneMultiTF, type MultiTFZoneResult } from "./impulseZoneEngine.ts";
import { findUnifiedZone, type UnifiedZoneResult } from "./unifiedZoneEngine.ts";

// ─── Shared test data ────────────────────────────────────────────────

function makeCandle(o: number, h: number, l: number, c: number, t: number) {
  return { open: o, high: h, low: l, close: c, time: t, volume: 100 };
}

// Generate a simple bearish impulse on 1H (50 candles trending down)
function makeBearishH1Candles() {
  const candles = [];
  let price = 1.1500;
  for (let i = 0; i < 50; i++) {
    const o = price;
    const h = price + 0.0010;
    const l = price - 0.0025;
    const c = price - 0.0020;
    candles.push(makeCandle(o, h, l, c, 1700000000 + i * 3600));
    price = c;
  }
  return candles;
}

// Generate matching 4H candles (12 candles)
function makeBearish4HCandles() {
  const candles = [];
  let price = 1.1500;
  for (let i = 0; i < 12; i++) {
    const o = price;
    const h = price + 0.0015;
    const l = price - 0.0060;
    const c = price - 0.0050;
    candles.push(makeCandle(o, h, l, c, 1700000000 + i * 14400));
    price = c;
  }
  return candles;
}

// Generate entry candles (15m, 100 candles)
function makeEntryCandles() {
  const candles = [];
  let price = 1.0500;
  for (let i = 0; i < 100; i++) {
    const o = price;
    const h = price + 0.0005;
    const l = price - 0.0008;
    const c = price - 0.0003;
    candles.push(makeCandle(o, h, l, c, 1700000000 + i * 900));
    price = c;
  }
  return candles;
}

const h1Candles = makeBearishH1Candles();
const h4Candles = makeBearish4HCandles();
const entryCandles = makeEntryCandles();
const direction = "bearish" as const;
const currentPrice = h1Candles[h1Candles.length - 1].close;

// ─── Tests ───────────────────────────────────────────────────────────

Deno.test("Zone Consolidation: unified engine's multiTFResult matches standalone call", () => {
  // Call the old way (standalone findBestEntryZoneMultiTF)
  const standaloneResult: MultiTFZoneResult = findBestEntryZoneMultiTF(
    h1Candles, h4Candles, entryCandles, direction, currentPrice, null, undefined, undefined,
  );

  // Call the new way (via unified engine, which internally calls findBestEntryZoneMultiTF)
  const unifiedResult: UnifiedZoneResult = findUnifiedZone(
    h1Candles, h4Candles, entryCandles, direction, currentPrice, [], null, undefined, undefined,
  );

  // The unified engine's multiTFResult should be identical to the standalone call
  const derivedResult = unifiedResult.multiTFResult;

  // Same zone selection
  assertEquals(derivedResult.selectedTF, standaloneResult.selectedTF,
    "selectedTF should match between standalone and unified-derived");

  // Same hasZone
  assertEquals(!!derivedResult.bestZone, !!standaloneResult.bestZone,
    "bestZone presence should match");

  // If both found a zone, verify key fields match
  if (standaloneResult.bestZone && derivedResult.bestZone) {
    assertEquals(derivedResult.bestZone.zone.type, standaloneResult.bestZone.zone.type,
      "zone type should match");
    assertEquals(derivedResult.bestZone.zone.high, standaloneResult.bestZone.zone.high,
      "zone high should match");
    assertEquals(derivedResult.bestZone.zone.low, standaloneResult.bestZone.zone.low,
      "zone low should match");
    assertEquals(derivedResult.bestZone.fibLevel, standaloneResult.bestZone.fibLevel,
      "fibLevel should match");
    assertEquals(derivedResult.bestZone.fibDepth, standaloneResult.bestZone.fibDepth,
      "fibDepth should match");
    assertEquals(derivedResult.bestZone.totalScore, standaloneResult.bestZone.totalScore,
      "totalScore should match");
    assertEquals(derivedResult.bestZone.srConfirmed, standaloneResult.bestZone.srConfirmed,
      "srConfirmed should match");
    assertEquals(derivedResult.bestZone.priceAtZone, standaloneResult.bestZone.priceAtZone,
      "priceAtZone should match");
  }

  // Same h1/h4 results
  assertEquals(!!derivedResult.h1Result?.hasZone, !!standaloneResult.h1Result?.hasZone,
    "h1Result.hasZone should match");
  assertEquals(!!derivedResult.h4Result?.hasZone, !!standaloneResult.h4Result?.hasZone,
    "h4Result.hasZone should match");
});

Deno.test("Zone Consolidation: izData derivation from multiTFResult has all required fields", () => {
  const unifiedResult: UnifiedZoneResult = findUnifiedZone(
    h1Candles, h4Candles, entryCandles, direction, currentPrice, [], null, undefined, undefined,
  );

  const multiTFResult = unifiedResult.multiTFResult;

  // Simulate the derivation logic from bot-scanner (what we replaced)
  const izData = {
    hasZone: !!multiTFResult.bestZone,
    selectedTF: multiTFResult.selectedTF,
    reason: multiTFResult.reason,
    impulse: multiTFResult.bestZone?.impulse
      ? {
          high: multiTFResult.bestZone.impulse.high,
          low: multiTFResult.bestZone.impulse.low,
          direction: multiTFResult.bestZone.impulse.direction,
        }
      : null,
    bestZone: multiTFResult.bestZone
      ? {
          type: multiTFResult.bestZone.zone.type,
          high: multiTFResult.bestZone.zone.high,
          low: multiTFResult.bestZone.zone.low,
          fibLevel: multiTFResult.bestZone.fibLevel,
          fibDepth: multiTFResult.bestZone.fibDepth,
          totalScore: multiTFResult.bestZone.totalScore,
          srConfirmed: multiTFResult.bestZone.srConfirmed,
          ltfRefined: multiTFResult.bestZone.ltfRefined,
          ltfType: multiTFResult.bestZone.ltfType,
          refinedEntry: multiTFResult.bestZone.refinedEntry,
          refinedSL: multiTFResult.bestZone.refinedSL,
          priceAtZone: multiTFResult.bestZone.priceAtZone,
          priceInsideZone: multiTFResult.bestZone.priceInsideZone,
          priceAtZoneStrict: multiTFResult.bestZone.priceAtZoneStrict,
          sideOk: multiTFResult.bestZone.sideOk,
          distanceToZone: multiTFResult.bestZone.distanceToZone,
          distancePips: multiTFResult.bestZone.distancePips,
          htfConfluenceScore: multiTFResult.bestZone.htfConfluenceScore,
        }
      : null,
    allZonesCount: multiTFResult.allZones?.length ?? 0,
    h1HasZone: !!multiTFResult.h1Result?.hasZone,
    h4HasZone: !!multiTFResult.h4Result?.hasZone,
  };

  // Verify all fields exist (the frontend and gate logic depend on these)
  assertExists(izData, "izData should be defined");
  assertEquals(typeof izData.hasZone, "boolean", "hasZone should be boolean");
  assertEquals(typeof izData.h1HasZone, "boolean", "h1HasZone should be boolean");
  assertEquals(typeof izData.h4HasZone, "boolean", "h4HasZone should be boolean");
  assertEquals(typeof izData.allZonesCount, "number", "allZonesCount should be number");
  assertEquals(typeof izData.reason, "string", "reason should be string");

  // If a zone was found, verify bestZone has all required fields
  if (izData.hasZone && izData.bestZone) {
    assertEquals(typeof izData.bestZone.type, "string", "bestZone.type should be string");
    assertEquals(typeof izData.bestZone.high, "number", "bestZone.high should be number");
    assertEquals(typeof izData.bestZone.low, "number", "bestZone.low should be number");
    assertEquals(typeof izData.bestZone.fibLevel, "number", "bestZone.fibLevel should be number");
    assertEquals(typeof izData.bestZone.fibDepth, "number", "bestZone.fibDepth should be number");
    assertEquals(typeof izData.bestZone.totalScore, "number", "bestZone.totalScore should be number");
    assertEquals(typeof izData.bestZone.srConfirmed, "boolean", "bestZone.srConfirmed should be boolean");
    assertEquals(typeof izData.bestZone.ltfRefined, "boolean", "bestZone.ltfRefined should be boolean");
    assertEquals(typeof izData.bestZone.priceAtZone, "boolean", "bestZone.priceAtZone should be boolean");
    assertEquals(typeof izData.bestZone.distanceToZone, "number", "bestZone.distanceToZone should be number");
  }
});

Deno.test("Zone Consolidation: no zone case — izData.hasZone is false, bestZone is null", () => {
  // Use minimal candles that won't produce a valid impulse
  const tinyCandles = [
    makeCandle(1.10, 1.101, 1.099, 1.100, 1700000000),
    makeCandle(1.10, 1.101, 1.099, 1.100, 1700003600),
    makeCandle(1.10, 1.101, 1.099, 1.100, 1700007200),
  ];

  const unifiedResult: UnifiedZoneResult = findUnifiedZone(
    tinyCandles, tinyCandles, tinyCandles, "bearish", 1.100, [], null, undefined, undefined,
  );

  const multiTFResult = unifiedResult.multiTFResult;

  // Derive izData the same way bot-scanner does
  const izData = {
    hasZone: !!multiTFResult.bestZone,
    bestZone: multiTFResult.bestZone ?? null,
    selectedTF: multiTFResult.selectedTF,
    reason: multiTFResult.reason,
  };

  assertEquals(izData.hasZone, false, "Should have no zone with tiny candle set");
  assertEquals(izData.bestZone, null, "bestZone should be null");
  assertEquals(typeof izData.reason, "string", "reason should explain why no zone");
});
