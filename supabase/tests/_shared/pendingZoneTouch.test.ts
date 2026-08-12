import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { cursorAfterLatestTouchCandle, findEarliestPendingZoneTouch } from "../../functions/_shared/pendingZoneTouch.ts";

const candle = (datetime: string, low: number, high: number) => ({
  datetime,
  open: 1.1,
  high,
  low,
  close: 1.1,
});

Deno.test("finds the earliest touch across every unseen candle", () => {
  const result = findEarliestPendingZoneTouch({
    candles: [
      candle("2026-08-12T10:00:00.000Z", 1.101, 1.105),
      candle("2026-08-12T10:05:00.000Z", 1.099, 1.104),
      candle("2026-08-12T10:10:00.000Z", 1.098, 1.103),
    ],
    direction: "long",
    entryPrice: 1.1,
    observedAfter: "2026-08-12T09:59:00.000Z",
    interval: "5m",
  }, "2026-08-12T10:15:30.000Z");

  assertEquals(result.touchTime, "2026-08-12T10:05:00.000Z");
  assertEquals(result.candlesChecked, 3);
});

Deno.test("rechecks a candle that overlaps the previous observation", () => {
  const result = findEarliestPendingZoneTouch({
    candles: [candle("2026-08-12T10:10:00.000Z", 1.099, 1.104)],
    direction: "long",
    entryPrice: 1.1,
    observedAfter: "2026-08-12T10:12:00.000Z",
    interval: "5m",
  }, "2026-08-12T10:13:00.000Z");

  assertEquals(result.touchTime, "2026-08-12T10:12:00.000Z");
});

Deno.test("excludes candles fully covered before the cursor", () => {
  const result = findEarliestPendingZoneTouch({
    candles: [
      candle("2026-08-12T10:00:00.000Z", 1.09, 1.11),
      candle("2026-08-12T10:05:00.000Z", 1.101, 1.104),
    ],
    direction: "long",
    entryPrice: 1.1,
    observedAfter: "2026-08-12T10:05:00.000Z",
    interval: "5m",
  }, "2026-08-12T10:09:00.000Z");

  assertEquals(result.touchTime, null);
  assertEquals(result.candlesChecked, 1);
});

Deno.test("reset cursor advances past the completed touch candle", () => {
  assertEquals(
    cursorAfterLatestTouchCandle(
      [candle("2026-08-12T10:10:00.000Z", 1.099, 1.104)],
      "5m",
    ),
    "2026-08-12T10:15:00.000Z",
  );
});

Deno.test("short touch uses candle high", () => {
  const result = findEarliestPendingZoneTouch({
    candles: [candle("2026-08-12T10:00:00.000Z", 1.09, 1.106)],
    direction: "short",
    entryPrice: 1.105,
    observedAfter: "2026-08-12T09:59:00.000Z",
    interval: "5m",
  });

  assertEquals(result.touchTime, "2026-08-12T10:00:00.000Z");
});

