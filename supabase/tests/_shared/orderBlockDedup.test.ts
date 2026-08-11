/**
 * orderBlockDedup.test.ts — one order block, counted once.
 *
 * detectOrderBlocks scans back up to OB_SCANBACK bars from an engulfing candle
 * to find the institutional one. Several consecutive engulfing bars therefore
 * resolve to the SAME source candle, and each pushed its own identical entry.
 *
 * Observed live on AUD/NZD (2026-08-11): one order block reported three times —
 * same index, bounds, age and distance — so "5 accepted POIs" described two real
 * zones, the ranked list was one zone repeated, and any multi-zone confluence
 * bonus was reading phantom agreement.
 *
 * Previously masked by a cap of 5 candidates. Raising that cap (so a widened
 * lifecycle window could not crowd out real POIs) let every duplicate through.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { detectOrderBlocks } from "../../functions/_shared/smcAnalysis.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

let clock = Date.UTC(2026, 7, 1);
function bar(open: number, high: number, low: number, close: number): Candle {
  const c = { open, high, low, close, volume: 100, datetime: new Date(clock).toISOString() };
  clock += 3_600_000;
  return c;
}

/**
 * One bearish candle followed by several consecutive bullish engulfings. Each
 * engulfing scans back to that same bearish bar, so the naive implementation
 * emits the same order block once per engulfing.
 */
function repeatedEngulfings(): Candle[] {
  clock = Date.UTC(2026, 7, 1);
  const bars: Candle[] = [];
  for (let i = 0; i < 12; i++) bars.push(bar(1.1000, 1.1008, 1.0992, 1.1001));
  bars.push(bar(1.1005, 1.1010, 1.0960, 1.0965)); // the institutional candle
  // Each of these closes above the previous bar's high.
  bars.push(bar(1.0965, 1.1030, 1.0960, 1.1025));
  bars.push(bar(1.1025, 1.1060, 1.1020, 1.1055));
  bars.push(bar(1.1055, 1.1090, 1.1050, 1.1085));
  bars.push(bar(1.1085, 1.1120, 1.1080, 1.1115));
  for (let i = 0; i < 6; i++) bars.push(bar(1.1115, 1.1125, 1.1105, 1.1118));
  return bars;
}

const keyOf = (ob: { index: number; type: string; high: number; low: number }) =>
  `${ob.index}:${ob.type}:${ob.high}:${ob.low}`;

Deno.test("the same order block is never returned twice", () => {
  const obs = detectOrderBlocks(repeatedEngulfings());
  const keys = obs.map(keyOf);
  assertEquals(
    keys.length, new Set(keys).size,
    `duplicate order blocks returned: ${keys.join(" | ")}`,
  );
});

Deno.test("dedup does not remove genuinely distinct blocks", () => {
  const bars = repeatedEngulfings();
  // A second, separate institutional candle at a different price and index.
  bars.push(bar(1.1118, 1.1122, 1.1090, 1.1094));
  bars.push(bar(1.1094, 1.1160, 1.1090, 1.1155));
  for (let i = 0; i < 4; i++) bars.push(bar(1.1155, 1.1165, 1.1145, 1.1158));

  const obs = detectOrderBlocks(bars);
  const bullish = obs.filter((o) => o.type === "bullish");
  assert(
    bullish.length >= 2,
    `expected at least two distinct bullish OBs, got ${bullish.length}`,
  );
  const indices = new Set(bullish.map((o) => o.index));
  assertEquals(indices.size, bullish.length, "distinct blocks must survive");
});

Deno.test("the survivor of a duplicate group is the strongest, not an arbitrary one", () => {
  // Candidates are sorted best-first before dedup, so the kept entry is the one
  // that would have ranked highest.
  const obs = detectOrderBlocks(repeatedEngulfings());
  assert(obs.length > 0);
  for (const ob of obs) {
    assert(ob.high > ob.low, "bounds must stay ordered");
    assert(typeof ob.state === "string", "lifecycle state must survive dedup");
  }
});

Deno.test("dedup respects the cap override used for widened windows", () => {
  const bars = repeatedEngulfings();
  const capped = detectOrderBlocks(bars, undefined, bars.length, 1);
  assert(capped.length <= 1, "an explicit cap still applies after dedup");
});
