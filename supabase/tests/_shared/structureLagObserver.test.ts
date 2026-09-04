import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { observeStructureLag } from "../../functions/_shared/structureLagObserver.ts";
import type { Candle, StructureBreak, LiquiditySweep } from "../../functions/_shared/smcAnalysis.ts";

/**
 * The observer must be right about the thing it is measuring, because its whole
 * purpose is to decide whether structure detection is worth changing — and
 * structure sits under every gate in the system.
 *
 * What it measures: analyzeMarketStructure records a break at the NEXT SWING's
 * candle and tests that candle's close against the previous swing level. The
 * real break is the first candle that closed through. The gap between those two
 * bars is the lag, and a sweep whose level was already closed through earlier is
 * a break filed under the wrong name.
 */

function bar(i: number, close: number, high?: number, low?: number): Candle {
  return {
    datetime: new Date(Date.UTC(2026, 0, 1, 0, i * 5)).toISOString(),
    open: close, high: high ?? close + 0.1, low: low ?? close - 0.1,
    close, volume: 100,
  } as Candle;
}

/** Flat at 100, closes above 105 from bar 12 onward, swing recorded at 20. */
function brokeAt12RecordedAt20(): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 12; i++) out.push(bar(i, 100));
  for (let i = 12; i <= 25; i++) out.push(bar(i, 108));
  return out;
}

const brk = (index: number, level: number, type: "bullish" | "bearish"): StructureBreak => ({
  index, type, price: level + 3, datetime: "", closeBased: true, level,
});

Deno.test("lag is the distance from the real close-through to the recorded bar", () => {
  const candles = brokeAt12RecordedAt20();
  const r = observeStructureLag(candles, [brk(20, 105, "bullish")], [], []);
  assertEquals(r.breaksAnalysed, 1);
  assertEquals(r.medianBarLag, 8);   // closed through at 12, recorded at 20
  assertEquals(r.maxBarLag, 8);
  assertEquals(r.zeroLagBreaks, 0);
});

Deno.test("a break recorded on the bar that broke it shows zero lag", () => {
  const candles = brokeAt12RecordedAt20();
  const r = observeStructureLag(candles, [brk(12, 105, "bullish")], [], []);
  assertEquals(r.medianBarLag, 0);
  assertEquals(r.zeroLagBreaks, 1);
});

Deno.test("contiguity is respected — an earlier separate run is not credited", () => {
  // Closes through at 5, falls back inside at 8, closes through again at 15.
  // The run that produced a break recorded at 18 starts at 15, not 5.
  const candles: Candle[] = [];
  for (let i = 0; i < 5; i++) candles.push(bar(i, 100));
  for (let i = 5; i < 8; i++) candles.push(bar(i, 108));
  for (let i = 8; i < 15; i++) candles.push(bar(i, 101));
  for (let i = 15; i <= 20; i++) candles.push(bar(i, 109));
  const r = observeStructureLag(candles, [brk(18, 105, "bullish")], [], []);
  assertEquals(r.medianBarLag, 3);  // 18 - 15
});

Deno.test("bearish breaks are measured on the correct side", () => {
  const candles: Candle[] = [];
  for (let i = 0; i < 10; i++) candles.push(bar(i, 100));
  for (let i = 10; i <= 20; i++) candles.push(bar(i, 92));
  const r = observeStructureLag(candles, [brk(17, 95, "bearish")], [], []);
  assertEquals(r.medianBarLag, 7);  // 17 - 10
});

Deno.test("a break whose recorded candle is not closed through is skipped", () => {
  // This is the sweep shape; it must not be counted as a zero-lag break.
  const candles: Candle[] = [];
  for (let i = 0; i <= 20; i++) candles.push(bar(i, 100, 107));  // wick above, close inside
  const r = observeStructureLag(candles, [brk(15, 105, "bullish")], [], []);
  assertEquals(r.breaksAnalysed, 0);
  assertEquals(r.barsSinceNewestBreak, null);
});

Deno.test("a sweep whose level was already closed through is flagged", () => {
  // Closes above 105 at bars 10-13, then the swing candle at 18 wicks above but
  // closes back inside. Current code files this as a sweep; it was a break.
  const candles: Candle[] = [];
  for (let i = 0; i < 10; i++) candles.push(bar(i, 100));
  for (let i = 10; i < 14; i++) candles.push(bar(i, 108));
  for (let i = 14; i <= 20; i++) candles.push(bar(i, 101, 107));
  const sweep: LiquiditySweep = {
    index: 18, type: "bearish", price: 107, datetime: "", sweptLevel: 105, wickDepth: 2,
  };
  const r = observeStructureLag(candles, [], [], [sweep]);
  assertEquals(r.sweepsAnalysed, 1);
  assertEquals(r.sweepsWithEarlierCloseThrough, 1);
});

Deno.test("a genuine wick sweep is not flagged", () => {
  // Never closes through — a real sweep.
  const candles: Candle[] = [];
  for (let i = 0; i <= 20; i++) candles.push(bar(i, 100, i === 18 ? 107 : 101));
  const sweep: LiquiditySweep = {
    index: 18, type: "bearish", price: 107, datetime: "", sweptLevel: 105, wickDepth: 2,
  };
  const r = observeStructureLag(candles, [], [], [sweep]);
  assertEquals(r.sweepsAnalysed, 1);
  assertEquals(r.sweepsWithEarlierCloseThrough, 0);
});

Deno.test("staleness is measured from the corrected bar, not the recorded one", () => {
  // Break really happened at 12; series ends at 25. Recorded at 20, so measuring
  // from the recorded bar would understate staleness by the lag.
  const candles = brokeAt12RecordedAt20();
  const r = observeStructureLag(candles, [brk(20, 105, "bullish")], [], []);
  assertEquals(r.barsSinceNewestBreak, 13);  // 25 - 12, not 25 - 20
});

Deno.test("empty and short inputs are safe", () => {
  const r = observeStructureLag([], [], [], []);
  assertEquals(r.breaksAnalysed, 0);
  assertEquals(r.barsSinceNewestBreak, null);
  const short = observeStructureLag([bar(0, 100)], [brk(0, 99, "bullish")], [], []);
  assertEquals(short.breaksAnalysed, 0);
});

Deno.test("the observer exposes no way to influence a decision", () => {
  // It must stay measurement-only: a pure function returning numbers.
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/structureLagObserver.ts", import.meta.url),
  );
  assert(!/supabase|insert|update|gates\.push/.test(src), "observer must not touch data or gates");
  const exported = [...src.matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1]);
  assertEquals(exported, ["observeStructureLag"], "only the observer should be exported");
});
