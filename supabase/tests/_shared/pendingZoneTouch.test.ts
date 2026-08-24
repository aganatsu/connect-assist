import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  closedCandleTouchesNestedPoiOuterZone,
  closedCandleTouchesNestedPoiTrigger,
  completedCandlesSinceCursor,
  cursorAfterLatestTouchCandle,
  findEarliestNestedPoiTriggerTouch,
  findEarliestPendingZoneTouch,
} from "../../functions/_shared/pendingZoneTouch.ts";

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

Deno.test("confirmation cursor includes the first candle that closes after touch", () => {
  const unseen = completedCandlesSinceCursor({
    candles: [
      candle("2026-08-12T10:00:00.000Z", 1.099, 1.104),
      candle("2026-08-12T10:05:00.000Z", 1.098, 1.103),
    ],
    observedAfter: "2026-08-12T10:02:00.000Z",
    interval: "5m",
  });

  assertEquals(
    unseen.map((item) => item.datetime),
    ["2026-08-12T10:00:00.000Z", "2026-08-12T10:05:00.000Z"],
  );
});

Deno.test("confirmation cursor excludes candles fully processed before it", () => {
  const unseen = completedCandlesSinceCursor({
    candles: [
      candle("2026-08-12T10:00:00.000Z", 1.099, 1.104),
      candle("2026-08-12T10:05:00.000Z", 1.098, 1.103),
    ],
    observedAfter: "2026-08-12T10:06:00.000Z",
    interval: "5m",
  });

  assertEquals(
    unseen.map((item) => item.datetime),
    ["2026-08-12T10:05:00.000Z"],
  );
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

Deno.test("outer-zone touch uses exact closed-candle overlap", () => {
  const outside = candle("2026-08-12T10:00:00.000Z", 1.1051, 1.106);
  const boundary = candle("2026-08-12T10:05:00.000Z", 1.105, 1.106);
  const outerZone = { low: 1.1, high: 1.105, direction: "bullish" as const };

  assertEquals(
    closedCandleTouchesNestedPoiOuterZone(outside, outerZone),
    false,
  );
  assertEquals(
    closedCandleTouchesNestedPoiOuterZone(boundary, outerZone),
    true,
  );
});

Deno.test("nested trigger touch has no midpoint or proximity fallback", () => {
  const trigger = { low: 1.102, high: 1.103 };
  assertEquals(
    closedCandleTouchesNestedPoiTrigger(
      candle("2026-08-12T10:00:00.000Z", 1.1031, 1.104),
      trigger,
    ),
    false,
  );
  assertEquals(
    closedCandleTouchesNestedPoiTrigger(
      candle("2026-08-12T10:05:00.000Z", 1.1025, 1.104),
      trigger,
    ),
    true,
  );
});

Deno.test("finds earliest exact nested trigger touch after the frozen cursor", () => {
  const result = findEarliestNestedPoiTriggerTouch({
    candles: [
      candle("2026-08-12T10:00:00.000Z", 1.1031, 1.104),
      candle("2026-08-12T10:05:00.000Z", 1.1027, 1.104),
    ],
    trigger: { low: 1.102, high: 1.103 },
    observedAfter: "2026-08-12T09:59:00.000Z",
    interval: "5m",
  }, "2026-08-12T10:10:30.000Z");

  assertEquals(result.touchTime, "2026-08-12T10:05:00.000Z");
  assertEquals(result.candlesChecked, 2);
});

Deno.test("range touch support preserves legacy directional entry behavior", () => {
  const rangeResult = findEarliestPendingZoneTouch({
    candles: [candle("2026-08-12T10:00:00.000Z", 1.101, 1.103)],
    direction: "short",
    zoneLow: 1.102,
    zoneHigh: 1.104,
    observedAfter: "2026-08-12T09:59:00.000Z",
    interval: "5m",
  });
  const legacyResult = findEarliestPendingZoneTouch({
    candles: [candle("2026-08-12T10:00:00.000Z", 1.101, 1.103)],
    direction: "short",
    entryPrice: 1.104,
    observedAfter: "2026-08-12T09:59:00.000Z",
    interval: "5m",
  });

  assertEquals(rangeResult.touchTime, "2026-08-12T10:00:00.000Z");
  assertEquals(legacyResult.touchTime, null);
});
Deno.test("a setup frozen after the discovery bar cannot replay that bar as its nested trigger", () => {
  const discovery = candle("2026-08-12T10:00:00.000Z", 1.102, 1.104);
  const next = candle("2026-08-12T10:05:00.000Z", 1.1025, 1.104);
  const placedAt = "2026-08-12T10:05:01.000Z";
  const unseen = completedCandlesSinceCursor({
    candles: [discovery, next],
    observedAfter: placedAt,
    interval: "5m",
  });

  assertEquals(
    unseen.map((item) => item.datetime),
    ["2026-08-12T10:05:00.000Z"],
  );
  assertEquals(
    closedCandleTouchesNestedPoiTrigger(unseen[0], {
      low: 1.102,
      high: 1.103,
    }),
    true,
  );
});
