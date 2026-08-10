/**
 * smcAnalysisBreakerInversion.test.ts — Regression tests for detectBreakerBlocks
 * in smcAnalysis.ts (the implementation wired into confluenceScoring).
 *
 * Guards the invariant: an Order Block that has been *mitigated* (>=50% penetration)
 * but never *broken* (no candle closes through the far side) must NOT be inverted
 * into a breaker block of the opposite polarity.
 *
 * Regression context: `mitigatedAt` was initialised to `ob.index` with no guard for
 * "break never found", so an unbroken-but-mitigated bullish OB was emitted as a
 * bearish_breaker spanning the same price range — i.e. the bot's own long entry zone
 * was simultaneously published as short-side resistance. The unguarded fallback also
 * collapsed the subtype-promotion window to [ob.index, ob.index + 10], letting an
 * unrelated nearby structure break promote the phantom zone to a scoring "breaker".
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { detectBreakerBlocks } from "../../functions/_shared/smcAnalysis.ts";
import type { Candle, OrderBlock } from "../../functions/_shared/smcAnalysis.ts";

function makeCandle(o: number, h: number, l: number, c: number, i: number): Candle {
  return {
    open: o, high: h, low: l, close: c, volume: 100,
    datetime: new Date((1700000000 + i * 3600) * 1000).toISOString(),
  };
}

function makeOB(
  overrides: Partial<OrderBlock> & { high: number; low: number; type: "bullish" | "bearish"; index: number },
): OrderBlock {
  return {
    datetime: new Date((1700000000 + overrides.index * 3600) * 1000).toISOString(),
    mitigated: true,
    mitigatedPercent: 60,
    state: "mitigated",
    testedCount: 1,
    ...overrides,
  } as OrderBlock;
}

/** Flat filler candle well clear of any zone under test. */
function filler(i: number, price: number): Candle {
  return makeCandle(price, price + 0.0005, price - 0.0005, price, i);
}

const OB_HIGH = 1.1000;
const OB_LOW = 1.0900;
const OB_MID = (OB_HIGH + OB_LOW) / 2; // 1.0950

/**
 * Bullish OB at index 5. Price retraces into the zone past the midpoint
 * (a normal, healthy pullback entry) but every candle closes above OB_LOW,
 * so the OB is mitigated but never broken.
 */
function mitigatedButUnbrokenScenario(): { candles: Candle[]; ob: OrderBlock } {
  const candles: Candle[] = [];
  for (let i = 0; i < 5; i++) candles.push(filler(i, 1.1050));
  // index 5 — the OB candle itself
  candles.push(makeCandle(1.0990, 1.1000, 1.0900, 1.0910, 5));
  for (let i = 6; i < 10; i++) candles.push(filler(i, 1.1060));
  // Retrace deep into the zone (below mid) but close back above the OB low
  candles.push(makeCandle(1.1010, 1.1015, 1.0930, 1.0985, 10));
  candles.push(makeCandle(1.0985, 1.1000, 1.0925, 1.0995, 11));
  for (let i = 12; i < 30; i++) candles.push(filler(i, 1.1070));

  const ob = makeOB({ high: OB_HIGH, low: OB_LOW, type: "bullish", index: 5 });
  return { candles, ob };
}

/** Same OB, but price genuinely closes through the low at index 12 — a real break. */
function brokenScenario(): { candles: Candle[]; ob: OrderBlock } {
  const { candles, ob } = mitigatedButUnbrokenScenario();
  candles[12] = makeCandle(1.0960, 1.0965, 1.0840, 1.0850, 12); // closes below OB_LOW
  for (let i = 13; i < 30; i++) candles[i] = filler(i, 1.0860);
  return { candles, ob };
}

Deno.test("detectBreakerBlocks — mitigated but unbroken bullish OB produces NO breaker", () => {
  const { candles, ob } = mitigatedButUnbrokenScenario();
  const breakers = detectBreakerBlocks([ob], candles);
  assertEquals(breakers.length, 0, "unbroken OB must not be inverted into a breaker");
});

Deno.test("detectBreakerBlocks — unbroken OB is not promoted by a nearby structure break", () => {
  const { candles, ob } = mitigatedButUnbrokenScenario();
  // A bearish structure break inside the old [ob.index, ob.index + 10] fallback window.
  // Previously this promoted the phantom zone to subtype "breaker", which is the
  // subtype confluenceScoring awards points for.
  const structureBreaks = [{ index: 8, type: "bearish" }];
  const breakers = detectBreakerBlocks([ob], candles, structureBreaks);
  assertEquals(breakers.length, 0, "no breaker should exist to promote");
});

Deno.test("detectBreakerBlocks — genuinely broken bullish OB still produces a bearish breaker", () => {
  const { candles, ob } = brokenScenario();
  const breakers = detectBreakerBlocks([ob], candles);
  assertEquals(breakers.length, 1, "a real break must still produce a breaker");
  assertEquals(breakers[0].type, "bearish_breaker");
  assertEquals(breakers[0].mitigatedAt, 12, "mitigatedAt must be the actual break index");
});

Deno.test("detectBreakerBlocks — broken OB with confirming structure break gets subtype 'breaker'", () => {
  const { candles, ob } = brokenScenario();
  const structureBreaks = [{ index: 13, type: "bearish" }];
  const breakers = detectBreakerBlocks([ob], candles, structureBreaks);
  assertEquals(breakers.length, 1);
  assertEquals(breakers[0].subtype, "breaker");
});

Deno.test("detectBreakerBlocks — mitigated but unbroken bearish OB produces NO breaker", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 5; i++) candles.push(filler(i, 1.0850));
  candles.push(makeCandle(1.0910, 1.1000, 1.0900, 1.0990, 5)); // bearish OB candle
  for (let i = 6; i < 10; i++) candles.push(filler(i, 1.0840));
  // Rally into the zone past mid, but close back below OB_HIGH every time
  candles.push(makeCandle(1.0890, 1.0970, 1.0885, 1.0910, 10));
  candles.push(makeCandle(1.0910, 1.0975, 1.0900, 1.0905, 11));
  for (let i = 12; i < 30; i++) candles.push(filler(i, 1.0830));

  const ob = makeOB({ high: OB_HIGH, low: OB_LOW, type: "bearish", index: 5 });
  const breakers = detectBreakerBlocks([ob], candles);
  assertEquals(breakers.length, 0, "unbroken bearish OB must not become a bullish breaker");
});

Deno.test("detectBreakerBlocks — unmitigated OB is skipped entirely", () => {
  const { candles } = mitigatedButUnbrokenScenario();
  const ob = makeOB({
    high: OB_HIGH, low: OB_LOW, type: "bullish", index: 5,
    mitigated: false, mitigatedPercent: 0, state: "fresh", testedCount: 0,
  });
  const breakers = detectBreakerBlocks([ob], candles);
  assertEquals(breakers.length, 0);
  assert(OB_MID > OB_LOW, "sanity");
});
