import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculatePremiumDiscount } from "../../functions/_shared/smcAnalysis.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/**
 * calculatePremiumDiscount locates price inside the range of the last 5 swing
 * highs and lows. detectSwingPoints needs a strict local extreme over +/-3
 * bars, so in a sustained trend every detectable swing lies behind price, price
 * leaves the range, and the percentage runs past 100 or below 0.
 *
 * Measured on live HTF data 2026-09-03, from rejected_setups.raw_detail:
 *
 *   AUD/USD long   1H +158.1    4H +101.6
 *   EUR/USD long   1H +139.7    4H  +84.7
 *   USD/JPY short  1H -134.7    4H -108.7
 *   GBP/JPY short  4H -533.2
 *
 * The direction of the breakdown is what makes it dangerous. Above the range
 * classifies as "premium" and below it as "discount", so an uptrend reads
 * premium and a downtrend reads discount — a gate acting on it vetoes trades
 * taken WITH the trend. The entry-timeframe reading stays inside 0-100 only
 * because a fast range keeps up with price, which is why the noisy timeframe is
 * the well-defined one.
 *
 * Clamping is presentational and decision-neutral; these tests pin both halves.
 */

function bar(i: number, p: number, w = 0.1): Candle {
  return {
    datetime: new Date(Date.UTC(2026, 0, 1, 0, i * 5)).toISOString(),
    open: p, high: p + w, low: p - w, close: p, volume: 100,
  } as Candle;
}

/**
 * Oscillating consolidation (which produces confirmable swings inside a ~2
 * point range) followed by a monotone run. A strictly monotone series contains
 * no local extrema, so the run contributes no swings of its own and price ends
 * far outside the range the consolidation established — the live situation.
 */
function breakout(dir: 1 | -1, consolN = 40, runN = 20): Candle[] {
  const out: Candle[] = [];
  let i = 0;
  for (let k = 0; k < consolN; k++) out.push(bar(i++, 101 + Math.sin(k * 2 * Math.PI / 8)));
  let p = 101;
  for (let k = 0; k < runN; k++) { p += dir * 1.4; out.push(bar(i++, p)); }
  return out;
}

function rangebound(n = 60): Candle[] {
  const out: Candle[] = [];
  for (let k = 0; k < n; k++) out.push(bar(k, 101 + Math.sin(k * 2 * Math.PI / 8)));
  return out;
}

Deno.test("the fixture really does drive price out of range", () => {
  // Guard against a vacuous suite: if this stops being out of range, the tests
  // below are asserting nothing and need a new fixture.
  const up = calculatePremiumDiscount(breakout(1));
  const down = calculatePremiumDiscount(breakout(-1));
  assert(up.rawPercent > 100, `expected a breakout above the range, got ${up.rawPercent}`);
  assert(down.rawPercent < 0, `expected a breakout below the range, got ${down.rawPercent}`);
  // And it must not be hitting the neutral early-return, which also reads 50.
  assert(up.rawPercent !== 50 && down.rawPercent !== 50, "fixture produced no swings at all");
});

Deno.test("zonePercent never leaves 0-100", () => {
  for (const c of [breakout(1), breakout(-1), rangebound()]) {
    const pd = calculatePremiumDiscount(c);
    assert(
      pd.zonePercent >= 0 && pd.zonePercent <= 100,
      `zonePercent ${pd.zonePercent} outside 0-100`,
    );
  }
});

Deno.test("rawPercent preserves the unclamped reading", () => {
  const up = calculatePremiumDiscount(breakout(1));
  assertEquals(up.zonePercent, 100);
  assert(up.rawPercent > 1000, `raw reading was flattened: ${up.rawPercent}`);
  assertEquals(up.outOfRange, true);

  const down = calculatePremiumDiscount(breakout(-1));
  assertEquals(down.zonePercent, 0);
  assert(down.rawPercent < -1000, `raw reading was flattened: ${down.rawPercent}`);
  assertEquals(down.outOfRange, true);
});

Deno.test("outOfRange always agrees with rawPercent", () => {
  for (const c of [breakout(1), breakout(-1), rangebound()]) {
    const pd = calculatePremiumDiscount(c);
    assertEquals(pd.outOfRange, pd.rawPercent < 0 || pd.rawPercent > 100);
  }
});

Deno.test("a range-bound reading is untouched by clamping", () => {
  const pd = calculatePremiumDiscount(rangebound());
  assertEquals(pd.outOfRange, false);
  assertEquals(pd.zonePercent, pd.rawPercent);
});

Deno.test("the metric is anti-trend once price escapes the range", () => {
  // This is the reason the HTF reading must not drive a gate: it opposes the
  // trend it is measuring. Documented as behaviour, not endorsed.
  assertEquals(calculatePremiumDiscount(breakout(1)).currentZone, "premium");
  assertEquals(calculatePremiumDiscount(breakout(-1)).currentZone, "discount");
});

Deno.test("clamping cannot change the zone classification", () => {
  // Thresholds are 55 and 45; anything above the range clamps to 100 and
  // anything below to 0, landing on the side it was already on. If this fails,
  // clamping has become a behaviour change and a live gate has moved.
  const zoneOf = (v: number) => v > 55 ? "premium" : v < 45 ? "discount" : "equilibrium";
  const ote = (v: number) => v >= 62 && v <= 79;
  for (const raw of [-1222.7, -533.2, -134.7, -0.1, 100.1, 101.6, 158.1, 1322.7]) {
    const clamped = Math.min(100, Math.max(0, raw));
    assertEquals(zoneOf(clamped), zoneOf(raw), `clamping ${raw} changed the zone`);
    assertEquals(ote(clamped), ote(raw), `clamping ${raw} changed oteZone`);
  }
});

Deno.test("too few candles returns a defined neutral reading", () => {
  const pd = calculatePremiumDiscount(rangebound(5));
  assertEquals(pd.zonePercent, 50);
  assertEquals(pd.rawPercent, 50);
  assertEquals(pd.outOfRange, false);
  assertEquals(pd.currentZone, "equilibrium");
});
