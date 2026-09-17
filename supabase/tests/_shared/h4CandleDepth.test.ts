import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Deepening 4H must not change what the existing engines see.
 *
 * The `range` argument threaded through cachedFetch ("1mo", "5d", "1y") is
 * DECORATIVE — fetchCandles takes it as `_range` and ignores it. Every
 * timeframe got 300 bars, so "4h"/"1mo" was never a month; it was ~70 calendar
 * days. Reading the range string as the real window is how the H4 depth was
 * misdiagnosed in the first place.
 *
 * 4H is now fetched ~6 months deep for the V2 order-block engine, which has to
 * preserve zones for weeks or months. But more candles changes swing and
 * structure detection, which changes which trades fire — and V2 is supposed to
 * change nothing. So every pre-existing consumer slices back to the window it
 * always had, and only V2 reads the full series.
 */

const src = Deno.readTextFileSync(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

Deno.test("4H is fetched deeper than the default", () => {
  const m = code.match(/const CANDLE_LIMITS: Record<string, number> = \{([^}]*)\}/);
  assert(m, "the limit map exists");
  const h4 = m![1].match(/"4h":\s*(\d+)/);
  assert(h4, "4h has an explicit limit");
  // ~6 bars per trading day, ~30 per week. 800 bars is roughly six months,
  // enough to cover the 86-day-old H4 zone on the reference chart.
  assert(Number(h4![1]) >= 600, `4h limit ${h4![1]} is too shallow for the reference charts`);
});

Deno.test("the default depth for every other timeframe is unchanged", () => {
  // Deepening 5m or 15m would multiply payloads on the timeframes that scan
  // most often, against a credit budget already refusing fetches.
  assert(/const DEFAULT_CANDLE_LIMIT = 300;/.test(code));
  const m = code.match(/const CANDLE_LIMITS: Record<string, number> = \{([^}]*)\}/);
  const keys = [...m![1].matchAll(/"([a-z0-9]+)":/g)].map((x) => x[1]);
  assertEquals(keys, ["4h"], "only 4h is deepened");
});

Deno.test("every legacy 4H consumer is sliced back to its original window", () => {
  assert(/export const LEGACY_H4_WINDOW = 300;/.test(code));
  // Exactly ONE 4h fetch may be unsliced at the call site: the pair-loop one,
  // whose result becomes h4Full and is sliced into h4Candles a few lines later.
  // Every other site must slice inline, or it silently hands extra history to
  // structure detection and changes which trades fire.
  const sites = [...code.matchAll(/cachedFetch\([^)]*"4h"[^)]*\)([^\n]*)/g)];
  assert(sites.length >= 3, `expected the known 4h call sites, found ${sites.length}`);
  const unsliced = sites.filter((s) => !/slice\(-LEGACY_H4_WINDOW\)/.test(s[1]));
  assertEquals(unsliced.length, 1,
    `only the pair-loop fetch may be unsliced; found ${unsliced.length}`);
  assert(/fetchPromises\.push\(cachedFetch\(pair, "4h"/.test(unsliced[0][0] + unsliced[0][1]) ||
         /fetchPromises/.test(code.slice(code.indexOf(unsliced[0][0]) - 60, code.indexOf(unsliced[0][0]))),
    "the unsliced one is the pair-loop fetch that feeds h4Full");
});

Deno.test("the pair loop keeps the deep series separate from the legacy one", () => {
  assert(/const h4Full: Candle\[\]/.test(code), "deep series exists");
  assert(/const h4Candles: Candle\[\] = h4Full\.slice\(-LEGACY_H4_WINDOW\);/.test(code),
    "legacy series is the sliced one");
});

Deno.test("only V2 reads the deep series", () => {
  // If anything else starts reading h4Full, the no-behaviour-change guarantee
  // is gone and this test is how you find out.
  const v2Block = code.slice(code.indexOf("runStructuralOrderBlocks(pair"));
  assert(/candles: h4Full/.test(v2Block.slice(0, 400)), "V2 receives the full series");
  // Enumerate every line mentioning h4Full. Only three shapes are legitimate:
  // the declaration, the slice that produces the legacy window, and the V2
  // call. Anything else is a second reader of the deep series, which would end
  // the no-behaviour-change guarantee.
  const allowed = [
    /const h4Full: Candle\[\]/,
    /const h4Candles: Candle\[\] = h4Full\.slice\(-LEGACY_H4_WINDOW\);/,
    /h4Full && h4Full\.length >= 20/,
    /candles: h4Full/,
  ];
  const offenders = code.split("\n")
    .filter((l) => l.includes("h4Full"))
    .filter((l) => !allowed.some((re) => re.test(l)));
  assertEquals(offenders, [], "the deep 4H series has exactly one consumer");
});
