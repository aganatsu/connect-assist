import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { enumerateImpulseLegs, findImpulseLeg } from "../../functions/_shared/impulseZoneEngine.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/**
 * The V2 engine has to see the whole window, not just the latest setup.
 *
 * findImpulseLeg() returns the most recent valid leg per direction and stops.
 * With the runner calling it twice per timeframe, the entire order-block engine
 * was capped at symbols x directions x timeframes = 8 x 2 x 2 = 32 blocks — and
 * it measured 28. That number looked like a result and was actually a ceiling.
 *
 * A reference 4H chart with six stacked zones from six different historical
 * impulses could not be reproduced at any candle depth, which is why this had
 * to be fixed before judging the detector visually.
 */

let t = 0;
function candle(o: number, h: number, l: number, c: number): Candle {
  const dt = new Date(Date.UTC(2026, 0, 1 + t++)).toISOString().slice(0, 19);
  return { datetime: dt, open: o, high: h, low: l, close: c } as Candle;
}

/**
 * A rising zigzag with EXPLICIT pivot bars.
 *
 * detectSwingPoints requires a strict high/low against `lookback` bars on both
 * sides, so a smooth monotonic ramp produces no pivots at all — the junction
 * bars share equal extremes and the strict comparison rejects them. The spike
 * bars below are what make this fixture have structure to break.
 */
function zigzag(steps: number): Candle[] {
  t = 0;
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < 4; i++) out.push(candle(p, p + 1, p - 1, p));
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < 4; i++) { const o = p - i * 3, c = o - 3; out.push(candle(o, o + 0.5, c - 0.5, c)); }
    const low = p - 12;
    out.push(candle(low, low + 0.5, low - 4, low + 1));          // trough pivot
    for (let i = 0; i < 5; i++) { const o = low + 1 + i * 4, c = o + 4; out.push(candle(o, c + 0.5, o - 0.5, c)); }
    const hi = low + 21;
    out.push(candle(hi, hi + 4, hi - 0.5, hi - 1));              // peak pivot
    p = hi + 4;
  }
  return out;
}

Deno.test("it finds more than one leg where findImpulseLeg finds one", () => {
  const candles = zigzag(5);
  const single = findImpulseLeg(candles, "bullish");
  const many = enumerateImpulseLegs(candles);
  assert(single, "the single-leg finder still works");
  const bullish = many.filter(l => l.direction === "bullish");
  assert(bullish.length > 1,
    `expected several bullish legs, got ${bullish.length} — still capped at the latest`);
});

Deno.test("legs sharing an origin collapse to one", () => {
  // Several breaks commonly belong to one impulse. They trace back to the same
  // swing origin, so they describe ONE base and must not become several blocks.
  const candles = zigzag(4);
  const legs = enumerateImpulseLegs(candles);
  for (const dir of ["bullish", "bearish"] as const) {
    const origins = legs.filter(l => l.direction === dir).map(l => l.startIndex);
    assertEquals(origins.length, new Set(origins).size,
      `${dir} legs share an origin — they would produce duplicate blocks`);
  }
});

Deno.test("output is chronological, oldest first", () => {
  const legs = enumerateImpulseLegs(zigzag(5));
  const ends = legs.map(l => l.endIndex);
  assertEquals(ends, [...ends].sort((a, b) => a - b));
});

Deno.test("every leg carries the inputs scoring needs", () => {
  // displacement comes from validateImpulseFromBOS; the rest is the same
  // enrichment findImpulseLeg applies. A leg missing these would score as if
  // the factors were measured and absent.
  const legs = enumerateImpulseLegs(zigzag(4), "4H");
  assert(legs.length > 0);
  for (const l of legs) {
    assertEquals(l.timeframe, "4H");
    assert(l.startTime && l.endTime, "full datetimes, not just dates");
    assert(typeof l.spanBars === "number");
    assert(l.fibLevels && l.fibLevels.length > 0);
  }
});

Deno.test("the per-direction cap is enforced and logged, never silent", () => {
  const candles = zigzag(12);
  const capped = enumerateImpulseLegs(candles, "D", { maxPerDirection: 2 });
  for (const dir of ["bullish", "bearish"] as const) {
    assert(capped.filter(l => l.direction === dir).length <= 2);
  }
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/impulseZoneEngine.ts", import.meta.url));
  assert(/capped \$\{legs\.length\} legs to/.test(src),
    "a truncated list must say so — silence reads as 'this is all there was'");
});

Deno.test("the cap keeps the newest legs", () => {
  const candles = zigzag(8);
  const all = enumerateImpulseLegs(candles);
  const capped = enumerateImpulseLegs(candles, undefined, { maxPerDirection: 1 });
  for (const dir of ["bullish", "bearish"] as const) {
    const a = all.filter(l => l.direction === dir);
    const c = capped.filter(l => l.direction === dir);
    if (a.length > 1 && c.length === 1) {
      assertEquals(c[0].endIndex, Math.max(...a.map(l => l.endIndex)));
    }
  }
});

Deno.test("a short or empty series returns nothing rather than throwing", () => {
  assertEquals(enumerateImpulseLegs([]), []);
  assertEquals(enumerateImpulseLegs(zigzag(1).slice(0, 5)), []);
});

Deno.test("the runner enumerates instead of taking the latest leg", () => {
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/structuralOrderBlockRunner.ts", import.meta.url));
  // Comments stripped: the docstring explains what it replaced and names the
  // old function, which would satisfy the assertion on its own.
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert(code.includes("enumerateImpulseLegs"), "runner uses the enumerator");
  assert(!/findImpulseLeg\(/.test(code), "and no longer calls the latest-leg finder");
});
