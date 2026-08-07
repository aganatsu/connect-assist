import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildCanonicalStructureAuthority } from "../functions/_shared/canonicalStructureAuthority.ts";

const candle = (i: number, open: number, high: number, low: number, close: number) => ({ datetime: `2026-01-01T${String(i).padStart(2, "0")}:00:00Z`, open, high, low, close, volume: 1 });

Deno.test("confirmed swing is frozen before later close-through BOS", () => {
  const candles = [
    candle(0, 8, 9, 7, 8), candle(1, 9, 10, 8, 9), candle(2, 10, 12, 9, 11),
    candle(3, 10, 11, 8, 9), candle(4, 9, 10, 7, 8), candle(5, 10, 13, 9, 12.5),
  ];
  const result = buildCanonicalStructureAuthority(candles, { internalLookback: 2, externalLookback: 3, internalAtrFilter: 0, externalAtrFilter: 0 });
  const level = result.levels.find((item) => item.side === "high" && item.pivotIndex === 2 && item.significance === "internal");
  assertEquals(level?.confirmedIndex, 4);
  assertEquals(result.events.some((event) => event.levelId === level?.id && event.candleIndex === 5 && event.type === "bos"), true);
});

Deno.test("wick through and close back is a sweep, not BOS", () => {
  const candles = [
    candle(0, 8, 9, 7, 8), candle(1, 9, 10, 8, 9), candle(2, 10, 12, 9, 11),
    candle(3, 10, 11, 8, 9), candle(4, 9, 10, 7, 8), candle(5, 11, 13, 9, 11.5),
  ];
  const result = buildCanonicalStructureAuthority(candles, { internalLookback: 2, externalLookback: 3, internalAtrFilter: 0, externalAtrFilter: 0 });
  assertEquals(result.events.some((event) => event.candleIndex === 5 && event.type === "sweep" && event.direction === "bullish"), true);
  assertEquals(result.events.some((event) => event.candleIndex === 5 && event.type === "bos"), false);
});

Deno.test("opposing displaced close is MSS", () => {
  const candles = [
    candle(0, 10, 11, 9, 10), candle(1, 9, 10, 7, 8), candle(2, 8, 9, 6, 7),
    candle(3, 7, 9, 6.5, 8), candle(4, 8, 10, 7, 9), candle(5, 9, 10, 8, 9),
    candle(6, 9, 9.5, 7.5, 8), candle(7, 8, 11, 7.8, 10.8),
  ];
  const result = buildCanonicalStructureAuthority(candles, { internalLookback: 1, externalLookback: 2, internalAtrFilter: 0, externalAtrFilter: 0, mssDisplacement: 0.6 });
  assertEquals(result.events.some((event) => event.direction === "bullish" && event.type === "mss"), true);
});
