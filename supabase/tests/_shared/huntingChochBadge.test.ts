import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The "⏳ Hunting CHoCH" badge rendered on price position alone:
 *
 *   isLiveContext && bestZone && (priceInsideZone || priceAtZoneStrict)
 *
 * with no reference to whether a CHoCH had been found or whether the setup had
 * already triggered.
 *
 * Observed 2026-09-08 on a BTC/USD short, TRADE_PLACED_AT_ZONE, showing
 * simultaneously:
 *
 *   ⏳ Hunting CHoCH
 *   ⚡ TRIGGERED
 *   Confirmation: LTF CHoCH (bearish) @ index 237 (+2.0)
 *
 * It was hunting for something it had already found, on a trade already placed.
 */

const panel = await Deno.readTextFile(
  new URL("../../../src/components/ZoneStoryPanel.tsx", import.meta.url),
);

/** Mirrors the render condition. */
function showsHunting(o: {
  live: boolean; hasZone: boolean; inside: boolean; atZoneStrict: boolean;
  state: string; entryReady: boolean;
}) {
  return o.live && o.hasZone && (o.inside || o.atZoneStrict)
    && o.state !== "triggered" && !o.entryReady;
}

const base = { live: true, hasZone: true, inside: true, atZoneStrict: false, state: "confirmed", entryReady: false };

Deno.test("the observed BTC/USD panel no longer shows it", () => {
  assertEquals(showsHunting({ ...base, state: "triggered", entryReady: true }), false);
});

Deno.test("triggered alone is enough to hide it", () => {
  assertEquals(showsHunting({ ...base, state: "triggered" }), false);
});

Deno.test("a found confirmation alone is enough to hide it", () => {
  // A CHoCH found but not yet acted on is still not 'hunting'.
  assertEquals(showsHunting({ ...base, entryReady: true }), false);
});

Deno.test("it still shows when genuinely hunting", () => {
  // The state the badge exists for: price at the zone, nothing found yet.
  assertEquals(showsHunting(base), true);
  assertEquals(showsHunting({ ...base, inside: false, atZoneStrict: true }), true);
});

Deno.test("it stays hidden away from the zone", () => {
  assertEquals(showsHunting({ ...base, inside: false, atZoneStrict: false }), false);
  assertEquals(showsHunting({ ...base, hasZone: false }), false);
  assertEquals(showsHunting({ ...base, live: false }), false);
});

Deno.test("both new conditions are in the source, not just this model", () => {
  assert(/unifiedData\.state !== "triggered"/.test(panel));
  assert(/!unifiedData\.confirmation\?\.entryReady/.test(panel));
});

Deno.test("the contradiction it produced is recorded", () => {
  // So nobody removes the conditions as redundant.
  assert(/hunting for something it had found/.test(panel));
});
