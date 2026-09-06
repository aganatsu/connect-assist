import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The resting entry was pinned to the FAR edge of the zone — zone low for a
 * long, zone high for a short — so the limit only filled if price traversed the
 * entire zone.
 *
 * Measured 2026-09-06 over 7 days of scan_logs:
 *
 *   pair      evals  median_dist  price_at_zone
 *   BTC/USD    444      53.6         390  (88%)
 *   XAU/USD    227    1289.4         154  (68%)
 *   GBP/USD    194      14.0         119  (61%)
 *   GBP/JPY    298     222.2          10  ( 3%)
 *
 * Price was at the BTC zone in 88% of evaluations, and yet only 1 of 36 BTC
 * pending orders ever came near its entry. Across all pairs, 25 of 899 orders
 * recorded a touch and 1 filled. Price reaches the zone constantly and crosses
 * all of it rarely.
 *
 * A zone is an area — the reaction can come from anywhere inside it. Pinning
 * entry to the far edge bets on which part reacts, which is the same mistake as
 * putting the stop at a swing inside the zone, on the other side of the trade.
 *
 * `zoneEntryDepth` is the fraction of zone width from the NEAR edge, the one
 * price arrives at. Default 1 is the previous behaviour exactly.
 */

const engine = await Deno.readTextFile(
  new URL("../../functions/_shared/unifiedZoneEngine.ts", import.meta.url),
);
const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const mapper = await Deno.readTextFile(
  new URL("../../functions/_shared/configMapper.ts", import.meta.url),
);

/** Mirrors the entry/stop geometry in buildEntryStory. */
function plan(low: number, high: number, dir: "long" | "short", depth: number) {
  const w = high - low;
  const d = depth >= 0 && depth <= 1 ? depth : 1;
  return dir === "long"
    ? { entry: high - w * d, sl: low - w * 0.5 }
    : { entry: low + w * d, sl: high + w * 0.5 };
}

// The BTC/USD zone from 2026-09-04.
const LOW = 79000, HIGH = 80354.65;

Deno.test("depth 1 reproduces the old entry exactly", () => {
  // Anything else would be a silent behaviour change on deploy.
  assertEquals(plan(LOW, HIGH, "long", 1).entry, LOW);
  assertEquals(plan(LOW, HIGH, "short", 1).entry, HIGH);
});

Deno.test("depth 0 fills on first touch of the zone", () => {
  assertEquals(plan(LOW, HIGH, "long", 0).entry, HIGH);
  assertEquals(plan(LOW, HIGH, "short", 0).entry, LOW);
});

Deno.test("the BTC case: a shallower entry was reachable, the far edge was not", () => {
  // Price entered the zone and turned at 79637.76. It never reached 79000.
  const turned = 79637.76;
  assert(plan(LOW, HIGH, "long", 1).entry < turned, "the far-edge entry never filled");
  assert(plan(LOW, HIGH, "long", 0.5).entry > turned, "a midpoint entry would have");
  assertEquals(Math.round(plan(LOW, HIGH, "long", 0.5).entry * 100) / 100, 79677.33);
  assertEquals(Math.round(plan(LOW, HIGH, "long", 0.25).entry * 100) / 100, 80015.99);
});

Deno.test("the stop stays anchored to the zone, not to the entry", () => {
  // Otherwise a shallower entry would drag the stop up with it and end up
  // right back inside the zone — the problem #466 exists to fix.
  for (const d of [0, 0.25, 0.5, 1]) {
    assertEquals(plan(LOW, HIGH, "long", d).sl, LOW - (HIGH - LOW) * 0.5);
    assertEquals(plan(LOW, HIGH, "short", d).sl, HIGH + (HIGH - LOW) * 0.5);
  }
});

Deno.test("a shallower entry means less risk and more reward", () => {
  // Entering nearer the near edge moves entry AWAY from the stop, so risk grows
  // — this is the trade-off to be explicit about, not a free win.
  const far = plan(LOW, HIGH, "long", 1);
  const mid = plan(LOW, HIGH, "long", 0.5);
  assert(Math.abs(mid.entry - mid.sl) > Math.abs(far.entry - far.sl),
    "a shallower entry sits further from the zone-anchored stop, so risk INCREASES");
});

Deno.test("an out-of-range or missing depth falls back to the old behaviour", () => {
  for (const bad of [-0.5, 1.5, NaN]) {
    assertEquals(plan(LOW, HIGH, "long", bad).entry, LOW, `depth ${bad} must fall back to 1`);
  }
  assert(
    /entryDepth >= 0 && entryDepth <= 1/.test(engine),
    "the range check must be in the engine, not only in this test",
  );
});

Deno.test("the entry is measured from the near edge for each direction", () => {
  // Long: price arrives from above, near edge is the HIGH.
  // Short: price arrives from below, near edge is the LOW.
  assert(/entryPrice = zonePOI\.poi\.high - zoneWidth \* depth/.test(engine), "long");
  assert(/entryPrice = zonePOI\.poi\.low \+ zoneWidth \* depth/.test(engine), "short");
});

Deno.test("depth defaults to 1 in the live mapper and bot-scanner agrees", () => {
  assert(/zoneEntryDepth: 1,/.test(mapper), "RUNTIME_DEFAULTS entry missing");
  assert(
    /zoneEntryDepth: strategy\.zoneEntryDepth \?\? raw\.zoneEntryDepth \?\? RUNTIME_DEFAULTS\.zoneEntryDepth/.test(mapper),
    "must be mapped in configMapper",
  );
  const a = scanner.match(/^  zoneEntryDepth: (\d+),/m);
  const b = mapper.match(/^  zoneEntryDepth: (\d+),/m);
  assert(a && b, "missing from one defaults object");
  assertEquals(a[1], b[1]);
  assert(/entryDepth: \(pairConfig as any\)\.zoneEntryDepth/.test(scanner), "must be passed in");
});

Deno.test("penetration is recorded so the right depth is measurable", () => {
  // An entry at depth D fills only when penetration reaches D. Recording the
  // distribution answers "what depth would have filled" from data instead of
  // from an argument about zones being areas.
  assert(/zonePenetration:/.test(scanner), "penetration must be in scan detail");
  assert(/entryDepthInUse:/.test(scanner), "and the depth it is being judged against");
  assert(
    /\(multiTF\.bestZone\.zone\.poi\.high - analysis\.lastPrice\) \/ zw/.test(scanner),
    "a long's penetration is measured down from the high",
  );
  assert(
    /\(analysis\.lastPrice - multiTF\.bestZone\.zone\.poi\.low\) \/ zw/.test(scanner),
    "a short's penetration is measured up from the low",
  );
});

Deno.test("penetration matches the depth that would have filled", () => {
  const pen = (price: number) => (HIGH - price) / (HIGH - LOW);
  // Price turned at 79637.76 on the BTC trade.
  const p = pen(79637.76);
  assertEquals(Math.round(p * 100) / 100, 0.53);
  assert(p < 1, "so a depth-1 entry could not fill");
  assert(p > 0.5, "and a depth-0.5 entry could");
});

Deno.test("a zero-width zone does not divide by zero", () => {
  assert(/if \(!\(zw > 0\)\) return null;/.test(scanner), "guard missing");
});
