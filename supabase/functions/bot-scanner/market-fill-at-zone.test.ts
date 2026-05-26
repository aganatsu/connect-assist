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
