import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { analyzeMarketStructure } from "../../functions/_shared/smcAnalysis.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/**
 * A decisive close through an external swing can go unreported.
 *
 * Found 2026-09-18 on GBP/CAD daily while investigating order blocks:
 *
 *   external swing low   1.84018   (04 May)
 *   close                1.83867   (14 May)
 *   price continued to   1.83041   — roughly 1.8x ATR beyond the level
 *   bearish BOS/CHoCH emitted:  NONE, in fifteen bars
 *
 * DIAGNOSIS. analyzeMarketStructure builds break events pairwise between
 * CONSECUTIVE SWINGS:
 *
 *   for (let i = 1; i < lows.length; i++)
 *     events.push({ prevLevel: lows[i-1].price, index: lows[i].index, ... })
 *
 * The "break candle" is therefore the NEXT DETECTED SWING, never the bar that
 * actually closed through. A level is only reported broken once a new swing
 * forms on the other side of it — and detectSwingPoints needs `lookback` bars
 * of clearance either side, so a close through that is not followed by a
 * confirmed pivot produces no event at all.
 *
 * This matters well beyond order blocks: the direction engine reads the same
 * structure output, so a trend change can be invisible for as long as it takes
 * a new pivot to confirm.
 *
 * The first test is IGNORED because it currently FAILS. Flipping it to run is
 * the definition of done for the fix. It is written asserting CORRECT
 * behaviour rather than pinning the bug, because a test that encodes a defect
 * is worse than no test — this repo has already shipped one of those.
 */

let t = 0;
function candle(o: number, h: number, l: number, c: number): Candle {
  const dt = new Date(Date.UTC(2026, 0, 1 + t++)).toISOString().slice(0, 19);
  return { datetime: dt, open: o, high: h, low: l, close: c } as Candle;
}

/** Drift, a pronounced swing low, a rally away, then a decisive close back below it. */
function closeThroughExternalLow(): Candle[] {
  t = 0;
  const out: Candle[] = [];
  const p = 1.86;
  for (let i = 0; i < 10; i++) out.push(candle(p, p + 0.0015, p - 0.0015, p));
  for (let i = 0; i < 4; i++) { const o = p - i * 0.0035, c = o - 0.0035; out.push(candle(o, o + 0.0005, c - 0.0005, c)); }
  const low = 1.84018;
  out.push(candle(low + 0.001, low + 0.0015, low, low + 0.0012));            // the swing low
  for (let i = 0; i < 6; i++) { const o = low + 0.0012 + i * 0.0045, c = o + 0.0045; out.push(candle(o, c + 0.0005, o - 0.0005, c)); }
  const top = low + 0.0012 + 0.027;
  out.push(candle(top, top + 0.002, top - 0.0005, top - 0.001));             // swing high
  for (let i = 0; i < 5; i++) { const o = top - i * 0.006, c = o - 0.006; out.push(candle(o, o + 0.0005, c - 0.0005, c)); }
  out.push(candle(low + 0.002, low + 0.0025, 1.83801, 1.83867));             // CLOSES BELOW
  out.push(candle(1.83854, 1.84135, 1.83043, 1.83198));                      // and keeps going
  return out;
}

Deno.test({
  name: "a close through an external swing low is reported as a break",
  // KNOWN FAILURE. Enabling this is the definition of done for the fix.
  ignore: true,
  fn: () => {
    const candles = closeThroughExternalLow();
    const st = analyzeMarketStructure(candles);
    const low = st.swingPoints.find(s => s.type === "low" && Math.abs(s.price - 1.84018) < 1e-9);
    assert(low, "the swing low is detected");
    assertEquals(low!.significance, "external");

    const breaks = [...st.bos, ...st.choch].filter(b =>
      b.type === "bearish" && Math.abs((b.level ?? NaN) - 1.84018) < 1e-9);
    assert(breaks.length > 0,
      "a close 15 pips below an external swing low, continuing 1.8x ATR further, must produce a bearish break");
    assert(breaks.some(b => b.closeBased), "and it closed through, so closeBased must be true");
  },
});

Deno.test("the swing itself IS detected — the gap is in break reporting", () => {
  // Rules out the simpler explanation. Swing detection works; it is the
  // pairwise event construction that never looks at the closing bar.
  const candles = closeThroughExternalLow();
  const st = analyzeMarketStructure(candles);
  const low = st.swingPoints.find(s => s.type === "low" && Math.abs(s.price - 1.84018) < 1e-9);
  assert(low, "the level exists as a swing");
  assertEquals(low!.significance, "external", "and as an external one");

  const closeBar = candles[candles.length - 2];
  assert(closeBar.close < 1.84018, "and price genuinely closed below it");
});

Deno.test("break events are built swing-to-swing, which is the cause", () => {
  // Pins the mechanism so the diagnosis is not lost. prevLevel comes from the
  // PREVIOUS swing and index from the NEXT one, so the bar that actually
  // closed through is never examined. If this shape changes, the fix has
  // landed and the ignored test above should be enabled.
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/smcAnalysis.ts", import.meta.url));
  const block = src.slice(src.indexOf("const events: SwingEvent[] = []"),
                          src.indexOf("events.sort"));
  assert(/for \(let i = 1; i < lows\.length; i\+\+\)/.test(block),
    "lows are paired consecutively");
  assert(/index: lows\[i\]\.index/.test(block),
    "and the break candle is the NEXT SWING, not the bar that closed through");
});
