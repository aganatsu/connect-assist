import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyPairOverrides, RUNTIME_DEFAULTS } from "../../functions/_shared/configMapper.ts";

/**
 * zoneEntryDepth has to be settable per pair, because no single value is right.
 *
 * The resting entry sits at depth D into the zone from the near edge, and the
 * order only fills when penetration reaches D. Default 1 = the far edge, so
 * price must traverse the ENTIRE zone. Measured 2026-09-06:
 *
 *   GBP/USD  entered 13, reached half depth 6, reached far edge 0
 *   AUD/USD  penetration median 1.16 — routinely goes clean THROUGH
 *
 * So GBP/USD loses six fills to entry placement while a shallower entry on
 * AUD/USD would fill worse with more risk. A global value cannot serve both,
 * and 403 of 634 historical pending orders expired never having touched their
 * entry level.
 */

const cfg = (over: any) => ({
  ...RUNTIME_DEFAULTS,
  zoneEntryDepth: 1,
  pairGateOverrides: over,
}) as any;

Deno.test("a per-pair depth overrides the global", () => {
  const c = cfg({ "GBP/USD": { zoneEntryDepth: 0.5 } });
  applyPairOverrides(c, "GBP/USD");
  assertEquals(c.zoneEntryDepth, 0.5);
});

Deno.test("pairs without an override keep the global", () => {
  // The whole point: AUD/USD must be able to stay at the far edge while
  // GBP/USD moves in.
  const c = cfg({ "GBP/USD": { zoneEntryDepth: 0.5 } });
  applyPairOverrides(c, "AUD/USD");
  assertEquals(c.zoneEntryDepth, 1);
});

Deno.test("out-of-range depths are ignored, not applied", () => {
  // Above 1 sits outside the zone; 0 fills on first contact. A typo must fall
  // back to the global rather than silently change entry behaviour.
  for (const bad of [0, 1.5, -0.5, NaN, Infinity, "half" as any, null as any]) {
    const c = cfg({ "EUR/USD": { zoneEntryDepth: bad } });
    applyPairOverrides(c, "EUR/USD");
    assertEquals(c.zoneEntryDepth, 1, `depth ${String(bad)} must not apply`);
  }
});

Deno.test("depth 1 is still settable explicitly", () => {
  // Pinning a pair at the far edge on purpose must be distinguishable from
  // not configuring it.
  const c = cfg({ "AUD/USD": { zoneEntryDepth: 1 } });
  applyPairOverrides(c, "AUD/USD");
  assertEquals(c.zoneEntryDepth, 1);
});

Deno.test("no override object leaves everything alone", () => {
  const c = cfg(undefined);
  applyPairOverrides(c, "GBP/USD");
  assertEquals(c.zoneEntryDepth, 1);
});

Deno.test("the other overrides still work alongside it", () => {
  const c = cfg({ "GBP/USD": { zoneEntryDepth: 0.6, minConfluence: 55, maxPerSymbol: 3 } });
  applyPairOverrides(c, "GBP/USD");
  assertEquals(c.zoneEntryDepth, 0.6);
  assertEquals(c.minConfluence, 55);
  assertEquals(c.maxPerSymbol, 3);
});
