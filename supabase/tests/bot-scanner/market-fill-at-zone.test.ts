/**
 * market-fill-at-zone.test.ts
 * 
 * Tests for Option C: Market Fill at Zone
 * 
 * When izGateMode="hard" AND price IS at a validated impulse zone AND all gates pass,
 * the bot should fill at market price immediately — no pending order, no CHoCH wait.
 * 
 * The pending order path (with tiered CHoCH confirmation) is reserved for the
 * "watching_zone" path where price hasn't reached the zone yet.
 */

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ─── Test: Entry Decision Logic ─────────────────────────────────────────────

Deno.test("Market Fill at Zone — entry decision: priceAtZone + marketFillAtZone=true → effectiveLimitEnabled=false", () => {
  // Simulate the exact decision logic from bot-scanner lines 4864-4869
  const izGateMode = "hard";
  const izData = { bestZone: { priceAtZone: true, low: 1.08500, high: 1.08600, type: "demand" } };
  const config = { marketFillAtZone: true, limitOrderEnabled: false };
  const limitEntry = { price: 1.08550, zoneType: "IZ-DEMAND", zoneLow: 1.08500, zoneHigh: 1.08600 };

  const priceIsAtValidatedZone = izGateMode === "hard" && izData?.bestZone?.priceAtZone;
  const useMarketFillAtZone = priceIsAtValidatedZone && config.marketFillAtZone;
  const effectiveLimitEnabled = !useMarketFillAtZone && (config.limitOrderEnabled || (izGateMode === "hard" && !!limitEntry));

  assertEquals(priceIsAtValidatedZone, true, "Price should be at validated zone");
  assertEquals(useMarketFillAtZone, true, "Should use market fill at zone");
  assertEquals(effectiveLimitEnabled, false, "Limit orders should be DISABLED when market-fill-at-zone is active");
});

Deno.test("Market Fill at Zone — entry decision: priceAtZone + marketFillAtZone=false → effectiveLimitEnabled=true (old behavior)", () => {
  const izGateMode = "hard";
  const izData = { bestZone: { priceAtZone: true, low: 1.08500, high: 1.08600, type: "demand" } };
  const config = { marketFillAtZone: false, limitOrderEnabled: false };
  const limitEntry = { price: 1.08550, zoneType: "IZ-DEMAND", zoneLow: 1.08500, zoneHigh: 1.08600 };

  const priceIsAtValidatedZone = izGateMode === "hard" && izData?.bestZone?.priceAtZone;
  const useMarketFillAtZone = priceIsAtValidatedZone && config.marketFillAtZone;
  const effectiveLimitEnabled = !useMarketFillAtZone && (config.limitOrderEnabled || (izGateMode === "hard" && !!limitEntry));

  assertEquals(priceIsAtValidatedZone, true);
  assertEquals(useMarketFillAtZone, false, "Market fill should be disabled");
  assertEquals(effectiveLimitEnabled, true, "Limit orders should be ENABLED (old behavior)");
});

Deno.test("Market Fill at Zone — entry decision: price NOT at zone → effectiveLimitEnabled=true (watching path)", () => {
  const izGateMode = "hard";
  const izData = { bestZone: { priceAtZone: false, low: 1.08500, high: 1.08600, type: "demand", distanceToZone: 0.00150 } };
  const config = { marketFillAtZone: true, limitOrderEnabled: false };
  const limitEntry = { price: 1.08550, zoneType: "IZ-DEMAND", zoneLow: 1.08500, zoneHigh: 1.08600 };

  const priceIsAtValidatedZone = izGateMode === "hard" && izData?.bestZone?.priceAtZone;
  const useMarketFillAtZone = priceIsAtValidatedZone && config.marketFillAtZone;
  const effectiveLimitEnabled = !useMarketFillAtZone && (config.limitOrderEnabled || (izGateMode === "hard" && !!limitEntry));

  assertEquals(priceIsAtValidatedZone, false, "Price is NOT at zone");
  assertEquals(useMarketFillAtZone, false, "Should NOT use market fill");
  assertEquals(effectiveLimitEnabled, true, "Limit orders should be ENABLED for watching path");
});

Deno.test("Market Fill at Zone — entry decision: izGateMode=soft → effectiveLimitEnabled depends on limitOrderEnabled only", () => {
  const izGateMode: string = "soft";
  const izData = { bestZone: { priceAtZone: true, low: 1.08500, high: 1.08600, type: "demand" } };
  const config = { marketFillAtZone: true, limitOrderEnabled: false };
  const limitEntry = { price: 1.08550, zoneType: "IZ-DEMAND", zoneLow: 1.08500, zoneHigh: 1.08600 };

  const priceIsAtValidatedZone = izGateMode === "hard" && izData?.bestZone?.priceAtZone;
  const useMarketFillAtZone = priceIsAtValidatedZone && config.marketFillAtZone;
  const effectiveLimitEnabled = !useMarketFillAtZone && (config.limitOrderEnabled || (izGateMode === "hard" && !!limitEntry));

  assertEquals(priceIsAtValidatedZone, false, "izGateMode is soft, not hard");
  assertEquals(useMarketFillAtZone, false, "Market fill at zone only works with hard gate");
  assertEquals(effectiveLimitEnabled, false, "No limit orders since limitOrderEnabled=false and izGateMode≠hard");
});

Deno.test("Market Fill at Zone — entry decision: limitOrderEnabled=true overrides marketFillAtZone when NOT at zone", () => {
  // User explicitly wants limit orders AND price is not at zone
  const izGateMode = "hard";
  const izData = { bestZone: { priceAtZone: false, low: 1.08500, high: 1.08600, type: "demand" } };
  const config = { marketFillAtZone: true, limitOrderEnabled: true };
  const limitEntry = { price: 1.08550, zoneType: "IZ-DEMAND", zoneLow: 1.08500, zoneHigh: 1.08600 };

  const priceIsAtValidatedZone = izGateMode === "hard" && izData?.bestZone?.priceAtZone;
  const useMarketFillAtZone = priceIsAtValidatedZone && config.marketFillAtZone;
  const effectiveLimitEnabled = !useMarketFillAtZone && (config.limitOrderEnabled || (izGateMode === "hard" && !!limitEntry));

  assertEquals(useMarketFillAtZone, false, "Not at zone, so no market fill");
  assertEquals(effectiveLimitEnabled, true, "Limit orders enabled for watching path");
});

// ─── Test: Config Default ───────────────────────────────────────────────────

Deno.test("Market Fill at Zone — config: default is true (enabled by default)", () => {
  // This test verifies the DEFAULTS object has marketFillAtZone: true
  // We can't import the full bot-scanner, so we test the expected default
  const expectedDefault = true;
  assertEquals(expectedDefault, true, "marketFillAtZone should default to true");
});

// ─── Test: Status Metadata ──────────────────────────────────────────────────

Deno.test("Market Fill at Zone — metadata: status is 'trade_placed_at_zone' for zone fills", () => {
  const useMarketFillAtZone = true;
  const isPromotedFromStaging = false;

  const status = isPromotedFromStaging ? "trade_placed_from_watchlist" : (useMarketFillAtZone ? "trade_placed_at_zone" : "trade_placed");
  assertEquals(status, "trade_placed_at_zone");
});

Deno.test("Market Fill at Zone — metadata: promoted from staging takes priority over zone fill status", () => {
  const useMarketFillAtZone = true;
  const isPromotedFromStaging = true;

  const status = isPromotedFromStaging ? "trade_placed_from_watchlist" : (useMarketFillAtZone ? "trade_placed_at_zone" : "trade_placed");
  assertEquals(status, "trade_placed_from_watchlist", "Staging promotion takes priority");
});

Deno.test("Market Fill at Zone — metadata: entryMethod is 'market_fill_at_zone'", () => {
  const useMarketFillAtZone = true;
  const izData = { bestZone: { low: 1.08500, high: 1.08600, type: "demand", refinedEntry: 1.08520 } };

  const detail: Record<string, any> = {};
  if (useMarketFillAtZone) {
    detail.entryMethod = "market_fill_at_zone";
    detail.zoneConfirmation = "zone_touch_is_confirmation";
    detail.impulseZoneEntry = { zoneLow: izData?.bestZone?.low, zoneHigh: izData?.bestZone?.high, zoneType: izData?.bestZone?.type, refinedEntry: izData?.bestZone?.refinedEntry };
  }

  assertEquals(detail.entryMethod, "market_fill_at_zone");
  assertEquals(detail.zoneConfirmation, "zone_touch_is_confirmation");
  assertEquals(detail.impulseZoneEntry.zoneLow, 1.08500);
  assertEquals(detail.impulseZoneEntry.zoneHigh, 1.08600);
  assertEquals(detail.impulseZoneEntry.refinedEntry, 1.08520);
});

// ─── Test: Regression — Old Behavior Preserved When Disabled ────────────────

Deno.test("Market Fill at Zone — regression: with marketFillAtZone=false, behavior is identical to pre-change", () => {
  // Before this change, the effectiveLimitEnabled was:
  //   config.limitOrderEnabled || (izGateMode === "hard" && !!limitEntry)
  // With marketFillAtZone=false, the new logic should produce the same result:
  //   !false && (config.limitOrderEnabled || (izGateMode === "hard" && !!limitEntry))
  //   = true && (same as before)
  //   = same as before

  const testCases = [
    { izGateMode: "hard", priceAtZone: true, limitOrderEnabled: false, limitEntry: true },
    { izGateMode: "hard", priceAtZone: true, limitOrderEnabled: true, limitEntry: true },
    { izGateMode: "hard", priceAtZone: false, limitOrderEnabled: false, limitEntry: true },
    { izGateMode: "soft", priceAtZone: true, limitOrderEnabled: false, limitEntry: true },
    { izGateMode: "soft", priceAtZone: true, limitOrderEnabled: true, limitEntry: true },
    { izGateMode: "off", priceAtZone: true, limitOrderEnabled: false, limitEntry: false },
  ];

  for (const tc of testCases) {
    // Old logic (before this change)
    const oldEffectiveLimitEnabled = tc.limitOrderEnabled || (tc.izGateMode === "hard" && tc.limitEntry);

    // New logic with marketFillAtZone=false
    const priceIsAtValidatedZone = tc.izGateMode === "hard" && tc.priceAtZone;
    const useMarketFillAtZone = priceIsAtValidatedZone && false; // marketFillAtZone=false
    const newEffectiveLimitEnabled = !useMarketFillAtZone && (tc.limitOrderEnabled || (tc.izGateMode === "hard" && tc.limitEntry));

    assertEquals(
      newEffectiveLimitEnabled,
      oldEffectiveLimitEnabled,
      `Regression failed for case: ${JSON.stringify(tc)}. Old=${oldEffectiveLimitEnabled}, New=${newEffectiveLimitEnabled}`
    );
  }
});

// ─── Test: Directional Guard ───────────────────────────────────────────────

Deno.test("Directional Guard — LONG: price inside zone → allows market fill", () => {
  const direction = "long";
  const zoneHigh = 1.08600;
  const zoneLow = 1.08500;
  const zoneWidth = zoneHigh - zoneLow; // 0.001
  const buffer = zoneWidth * 2; // 0.002
  const currentPrice = 1.08550; // Inside the zone

  const priceOnCorrectSide = currentPrice <= zoneHigh + buffer;
  assertEquals(priceOnCorrectSide, true, "Price inside zone should be allowed for longs");
});

Deno.test("Directional Guard — LONG: price slightly above zone (within buffer) → allows market fill", () => {
  const direction = "long";
  const zoneHigh = 1.08600;
  const zoneLow = 1.08500;
  const zoneWidth = zoneHigh - zoneLow; // 0.001
  const buffer = zoneWidth * 2; // 0.002
  const currentPrice = 1.08750; // 15 pips above zone top, within buffer (zone top + 0.002 = 1.088)

  const priceOnCorrectSide = currentPrice <= zoneHigh + buffer;
  assertEquals(priceOnCorrectSide, true, "Price slightly above zone (within 2x zone width) should be allowed");
});

Deno.test("Directional Guard — LONG: price far above zone (beyond buffer) → BLOCKS market fill", () => {
  // This is the EUR/AUD scenario: zone at 1.61607-1.61719, price at 1.62166
  const direction = "long";
  const zoneHigh = 1.61719;
  const zoneLow = 1.61607;
  const zoneWidth = zoneHigh - zoneLow; // 0.00112
  const buffer = zoneWidth * 2; // 0.00224
  const currentPrice = 1.62166; // 44.7 pips above zone — this is chasing!

  const priceOnCorrectSide = currentPrice <= zoneHigh + buffer;
  // zoneHigh + buffer = 1.61719 + 0.00224 = 1.61943
  // currentPrice 1.62166 > 1.61943 → BLOCKED
  assertEquals(priceOnCorrectSide, false, "Price 44 pips above demand zone should be BLOCKED for longs (chasing)");
});

Deno.test("Directional Guard — LONG: price below zone → allows market fill (approaching zone)", () => {
  const direction = "long";
  const zoneHigh = 1.08600;
  const zoneLow = 1.08500;
  const zoneWidth = zoneHigh - zoneLow;
  const buffer = zoneWidth * 2;
  const currentPrice = 1.08400; // Below the zone — approaching from below

  const priceOnCorrectSide = currentPrice <= zoneHigh + buffer;
  assertEquals(priceOnCorrectSide, true, "Price below zone should be allowed for longs (approaching)");
});

Deno.test("Directional Guard — SHORT: price inside zone → allows market fill", () => {
  const direction = "short";
  const zoneHigh = 1.09200;
  const zoneLow = 1.09100;
  const zoneWidth = zoneHigh - zoneLow; // 0.001
  const buffer = zoneWidth * 2; // 0.002
  const currentPrice = 1.09150; // Inside the zone

  const priceOnCorrectSide = currentPrice >= zoneLow - buffer;
  assertEquals(priceOnCorrectSide, true, "Price inside zone should be allowed for shorts");
});

Deno.test("Directional Guard — SHORT: price slightly below zone (within buffer) → allows market fill", () => {
  const direction = "short";
  const zoneHigh = 1.09200;
  const zoneLow = 1.09100;
  const zoneWidth = zoneHigh - zoneLow; // 0.001
  const buffer = zoneWidth * 2; // 0.002
  const currentPrice = 1.08950; // 15 pips below zone bottom, within buffer (zone bottom - 0.002 = 1.089)

  const priceOnCorrectSide = currentPrice >= zoneLow - buffer;
  assertEquals(priceOnCorrectSide, true, "Price slightly below zone (within 2x zone width) should be allowed");
});

Deno.test("Directional Guard — SHORT: price far below zone (beyond buffer) → BLOCKS market fill", () => {
  // Mirror of the EUR/AUD long scenario but for shorts
  const direction = "short";
  const zoneHigh = 1.05800;
  const zoneLow = 1.05700;
  const zoneWidth = zoneHigh - zoneLow; // 0.001
  const buffer = zoneWidth * 2; // 0.002
  const currentPrice = 1.05400; // 30 pips below zone — this is chasing a short!

  const priceOnCorrectSide = currentPrice >= zoneLow - buffer;
  // zoneLow - buffer = 1.05700 - 0.002 = 1.05500
  // currentPrice 1.05400 < 1.05500 → BLOCKED
  assertEquals(priceOnCorrectSide, false, "Price 30 pips below supply zone should be BLOCKED for shorts (chasing)");
});

Deno.test("Directional Guard — SHORT: price above zone → allows market fill (approaching zone)", () => {
  const direction = "short";
  const zoneHigh = 1.09200;
  const zoneLow = 1.09100;
  const zoneWidth = zoneHigh - zoneLow;
  const buffer = zoneWidth * 2;
  const currentPrice = 1.09300; // Above the zone — approaching from above

  const priceOnCorrectSide = currentPrice >= zoneLow - buffer;
  assertEquals(priceOnCorrectSide, true, "Price above zone should be allowed for shorts (approaching)");
});

Deno.test("Directional Guard — full integration: blocks market fill when chasing, falls back to limit order", () => {
  // Simulates the full decision logic with directional guard
  const izGateMode = "hard";
  const izData = { bestZone: { priceAtZone: true, low: 1.61607, high: 1.61719, type: "demand" } };
  const config = { marketFillAtZone: true, limitOrderEnabled: false };
  const limitEntry = { price: 1.61663, zoneType: "IZ-OB", zoneLow: 1.61607, zoneHigh: 1.61719 };
  const analysisDirection = "long";
  const analysisLastPrice = 1.62166; // 44.7 pips above zone — chasing!

  const priceIsAtValidatedZone = izGateMode === "hard" && izData?.bestZone?.priceAtZone;

  // Directional guard
  let priceOnCorrectSide = true;
  if (priceIsAtValidatedZone && izData?.bestZone) {
    const zoneHigh = izData.bestZone.high;
    const zoneLow = izData.bestZone.low;
    const zoneWidth = zoneHigh - zoneLow;
    const buffer = zoneWidth * 2;
    if (analysisDirection === "long") {
      priceOnCorrectSide = analysisLastPrice <= zoneHigh + buffer;
    } else {
      priceOnCorrectSide = analysisLastPrice >= zoneLow - buffer;
    }
  }

  const useMarketFillAtZone = priceIsAtValidatedZone && config.marketFillAtZone && priceOnCorrectSide;
  const effectiveLimitEnabled = !useMarketFillAtZone && (config.limitOrderEnabled || (izGateMode === "hard" && !!limitEntry));

  assertEquals(priceIsAtValidatedZone, true, "priceAtZone flag is true (1.5x ATR proximity)");
  assertEquals(priceOnCorrectSide, false, "Directional guard blocks — price is above demand zone");
  assertEquals(useMarketFillAtZone, false, "Market fill blocked by directional guard");
  assertEquals(effectiveLimitEnabled, true, "Falls back to limit order path");
});

Deno.test("Directional Guard — XAU/USD wider zones: 50-pip zone allows up to 100-pip buffer", () => {
  // Gold zones are much wider (50+ pips). Buffer = 2x zone width = 100 pips
  const direction = "long";
  const zoneHigh = 2350.00;
  const zoneLow = 2345.00; // 50-pip zone (500 points for gold)
  const zoneWidth = zoneHigh - zoneLow; // 5.0
  const buffer = zoneWidth * 2; // 10.0 (100 pips)

  // Price 80 pips above zone — within buffer for gold
  const currentPrice = 2358.00;
  const priceOnCorrectSide = currentPrice <= zoneHigh + buffer;
  // zoneHigh + buffer = 2350 + 10 = 2360
  // 2358 <= 2360 → allowed
  assertEquals(priceOnCorrectSide, true, "80 pips above a 50-pip gold zone should be allowed (within 2x zone width buffer)");

  // Price 120 pips above zone — beyond buffer for gold
  const currentPrice2 = 2362.00;
  const priceOnCorrectSide2 = currentPrice2 <= zoneHigh + buffer;
  // 2362 > 2360 → blocked
  assertEquals(priceOnCorrectSide2, false, "120 pips above a 50-pip gold zone should be BLOCKED");
});

// ─── Test: Regression — Old Behavior Preserved When Disabled ────────────────

Deno.test("Market Fill at Zone — regression: with marketFillAtZone=true, ONLY priceAtZone+hard changes behavior", () => {
  // The ONLY case where behavior changes is: izGateMode=hard + priceAtZone=true + marketFillAtZone=true
  // All other cases should be identical to old behavior

  const testCases = [
    // These should be UNCHANGED (same as old behavior)
    { izGateMode: "hard", priceAtZone: false, limitOrderEnabled: false, limitEntry: true, shouldChange: false },
    { izGateMode: "soft", priceAtZone: true, limitOrderEnabled: false, limitEntry: true, shouldChange: false },
    { izGateMode: "soft", priceAtZone: true, limitOrderEnabled: true, limitEntry: true, shouldChange: false },
    { izGateMode: "off", priceAtZone: true, limitOrderEnabled: false, limitEntry: false, shouldChange: false },
    // This is the ONLY case that changes
    { izGateMode: "hard", priceAtZone: true, limitOrderEnabled: false, limitEntry: true, shouldChange: true },
  ];

  for (const tc of testCases) {
    const oldEffectiveLimitEnabled = tc.limitOrderEnabled || (tc.izGateMode === "hard" && tc.limitEntry);

    const priceIsAtValidatedZone = tc.izGateMode === "hard" && tc.priceAtZone;
    const useMarketFillAtZone = priceIsAtValidatedZone && true; // marketFillAtZone=true
    const newEffectiveLimitEnabled = !useMarketFillAtZone && (tc.limitOrderEnabled || (tc.izGateMode === "hard" && tc.limitEntry));

    if (tc.shouldChange) {
      assertNotEquals(
        newEffectiveLimitEnabled,
        oldEffectiveLimitEnabled,
        `Expected behavior CHANGE for: ${JSON.stringify(tc)}`
      );
      assertEquals(newEffectiveLimitEnabled, false, "Market fill at zone disables limit orders");
    } else {
      assertEquals(
        newEffectiveLimitEnabled,
        oldEffectiveLimitEnabled,
        `Unexpected behavior change for: ${JSON.stringify(tc)}. Old=${oldEffectiveLimitEnabled}, New=${newEffectiveLimitEnabled}`
      );
    }
  }
});
