import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  boundedCandlesBefore,
  outcomeCandlesAfter,
  utcDayStart,
} from "../../functions/_shared/backtestCandleWindow.ts";

const candles = Array.from({ length: 12 }, (_, index) => ({
  datetime: new Date(
    Date.UTC(2026, 6, 1, 0, index * 5),
  ).toISOString(),
  close: index,
}));

Deno.test("bounded candle history preserves strict no-lookahead semantics", () => {
  const cutoff = Date.parse("2026-07-01T00:30:00Z");
  const result = boundedCandlesBefore(candles, cutoff, 3);
  assertEquals(result.map((candle) => candle.close), [3, 4, 5]);

  const inclusive = boundedCandlesBefore(candles, cutoff, 3, true);
  assertEquals(inclusive.map((candle) => candle.close), [4, 5, 6]);
});

Deno.test("outcome candle window excludes history and caps the future", () => {
  const result = outcomeCandlesAfter(
    candles,
    Date.parse("2026-07-01T00:20:00Z"),
    0.25,
  );
  assertEquals(result.map((candle) => candle.close), [5, 6, 7]);
});

Deno.test("UTC day cutoff excludes the in-progress daily candle", () => {
  assertEquals(
    utcDayStart(Date.parse("2026-07-01T18:25:00Z")),
    Date.parse("2026-07-01T00:00:00Z"),
  );
});
