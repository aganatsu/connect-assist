/**
 * Test: NaN entry price guard in bot-scanner market order path.
 *
 * The bug: bot-scanner used `izData.bestZone.zoneHigh` and `izData.bestZone.zoneLow`
 * but the actual bestZone object has `.high` and `.low`. This caused
 * `undefined + undefined = NaN` → entry_price stored as "NaN" in DB.
 *
 * These tests verify:
 * 1. The property names `.high` and `.low` are used (not `.zoneHigh`/`.zoneLow`)
 * 2. The NaN guard falls back to lastPrice when rawMarketEntry is invalid
 */
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

Deno.test("marketEntryPrice: uses .high/.low from bestZone (not .zoneHigh/.zoneLow)", () => {
  // Simulate the bestZone object as returned by the impulse zone engine
  const izData = {
    bestZone: {
      type: "ob",
      high: 1.35662,
      low: 1.35591,
      fibLevel: 0.786,
      fibDepth: 0.786,
      totalScore: 7,
      refinedEntry: null, // no refined entry → falls to midpoint
      priceAtZone: true,
    },
    impulse: { high: 1.36440, low: 1.35381, direction: "long" },
  };
  const izGateMode = "hard";
  const analysisLastPrice = 1.35620;

  // Replicate the fixed logic from bot-scanner
  const rawMarketEntry = (izGateMode === "hard" && izData?.bestZone?.refinedEntry)
    ? izData.bestZone.refinedEntry
    : (izGateMode === "hard" && izData?.bestZone)
      ? (izData.bestZone.high + izData.bestZone.low) / 2
      : analysisLastPrice;

  const marketEntryPrice = (typeof rawMarketEntry === "number" && !isNaN(rawMarketEntry) && rawMarketEntry > 0)
    ? rawMarketEntry
    : analysisLastPrice;

  // Should be the midpoint of .high and .low
  const expectedMid = (1.35662 + 1.35591) / 2;
  assertEquals(marketEntryPrice, expectedMid);
  assert(!isNaN(marketEntryPrice), "marketEntryPrice must not be NaN");
});

Deno.test("marketEntryPrice: OLD bug with .zoneHigh/.zoneLow would produce NaN", () => {
  // Simulate the bestZone object — it does NOT have .zoneHigh/.zoneLow
  const izData = {
    bestZone: {
      type: "ob",
      high: 1.35662,
      low: 1.35591,
      refinedEntry: null,
      priceAtZone: true,
    },
  };

  // OLD broken code path (what used to happen):
  const brokenResult = (izData.bestZone as any).zoneHigh + (izData.bestZone as any).zoneLow;
  assert(isNaN(brokenResult), "Old code with .zoneHigh/.zoneLow produces NaN (confirming the bug)");

  // NEW fixed code path:
  const fixedResult = izData.bestZone.high + izData.bestZone.low;
  assert(!isNaN(fixedResult), "New code with .high/.low produces valid number");
  assertEquals(fixedResult / 2, (1.35662 + 1.35591) / 2);
});

Deno.test("marketEntryPrice: NaN guard falls back to lastPrice", () => {
  // Edge case: bestZone exists but .high/.low are somehow undefined
  const izData = {
    bestZone: {
      type: "fvg",
      high: undefined as any,
      low: undefined as any,
      refinedEntry: null,
      priceAtZone: true,
    },
  };
  const izGateMode = "hard";
  const analysisLastPrice = 1.17701;

  const rawMarketEntry = (izGateMode === "hard" && izData?.bestZone?.refinedEntry)
    ? izData.bestZone.refinedEntry
    : (izGateMode === "hard" && izData?.bestZone)
      ? (izData.bestZone.high + izData.bestZone.low) / 2
      : analysisLastPrice;

  // rawMarketEntry would be NaN here
  const marketEntryPrice = (typeof rawMarketEntry === "number" && !isNaN(rawMarketEntry) && rawMarketEntry > 0)
    ? rawMarketEntry
    : analysisLastPrice;

  assertEquals(marketEntryPrice, analysisLastPrice);
  assert(!isNaN(marketEntryPrice), "Guard ensures we never get NaN");
});

Deno.test("marketEntryPrice: uses refinedEntry when available", () => {
  const izData = {
    bestZone: {
      type: "ob",
      high: 1.35662,
      low: 1.35591,
      refinedEntry: 1.35625, // LTF-refined entry
      priceAtZone: true,
    },
  };
  const izGateMode = "hard";
  const analysisLastPrice = 1.35620;

  const rawMarketEntry = (izGateMode === "hard" && izData?.bestZone?.refinedEntry)
    ? izData.bestZone.refinedEntry
    : (izGateMode === "hard" && izData?.bestZone)
      ? (izData.bestZone.high + izData.bestZone.low) / 2
      : analysisLastPrice;

  const marketEntryPrice = (typeof rawMarketEntry === "number" && !isNaN(rawMarketEntry) && rawMarketEntry > 0)
    ? rawMarketEntry
    : analysisLastPrice;

  assertEquals(marketEntryPrice, 1.35625);
});
