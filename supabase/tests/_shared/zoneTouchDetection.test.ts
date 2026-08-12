// Touch detection must see every bar since the order was placed, and record
// the EARLIEST touch.
//
// Step 2 of the corrected sequence in docs/PREARM_GATE_AUDIT.md.
//
// bot-scanner sampled only pendingCandles[length - 1]. Correct in shape —
// candle high/low rather than close, off cached bars — but a single sample
// misses a wick that happened during a delayed or skipped scan. Pre-arming
// makes orders live long enough for that to be routine.
//
// Earliest, not latest: zone_touch_time anchors the CHoCH search window in
// zone-confirmation-scanner (zoneTouchIdx). A late timestamp silently truncates
// it and confirmations that DID occur are never found.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { findEarliestZoneTouch } from "../../functions/_shared/zoneTouch.ts";

const bar = (datetime: string, low: number, high: number) => ({ datetime, low, high });

// A long waiting at 1.0850. Bars ascending, as candleSource returns them.
const placedAt = "2026-08-12T00:00:00.000Z";
const entry = 1.0850;

Deno.test("finds a touch on an EARLIER bar that a last-bar check would miss", () => {
  const candles = [
    bar("2026-08-12T00:05:00.000Z", 1.0860, 1.0875), // no
    bar("2026-08-12T00:10:00.000Z", 1.0845, 1.0870), // TOUCH — wick through
    bar("2026-08-12T00:15:00.000Z", 1.0862, 1.0880), // no — price moved away
  ];
  const r = findEarliestZoneTouch(candles, { direction: "long", entryPrice: entry, since: placedAt });
  assertEquals(r.touched, true);
  assertEquals(r.at, "2026-08-12T00:10:00.000Z");
  // The old check read only the final bar, which does not touch.
  const lastOnly = candles[candles.length - 1].low <= entry;
  assertEquals(lastOnly, false, "the single-bar check misses this entirely");
});

Deno.test("records the EARLIEST touch, not the most recent", () => {
  const candles = [
    bar("2026-08-12T00:05:00.000Z", 1.0840, 1.0870), // TOUCH — earliest
    bar("2026-08-12T00:10:00.000Z", 1.0835, 1.0865), // also touches
    bar("2026-08-12T00:15:00.000Z", 1.0830, 1.0860), // also touches
  ];
  const r = findEarliestZoneTouch(candles, { direction: "long", entryPrice: entry, since: placedAt });
  assertEquals(
    r.at,
    "2026-08-12T00:05:00.000Z",
    "anchoring on a later bar truncates the CHoCH search window, so confirmations " +
      "that occurred between the real touch and the recorded one are never found",
  );
  assertEquals(r.matchCount, 3);
});

Deno.test("matchCount surfaces how much a single-bar check was losing", () => {
  const candles = [
    bar("2026-08-12T00:05:00.000Z", 1.0845, 1.0870),
    bar("2026-08-12T00:10:00.000Z", 1.0844, 1.0869),
    bar("2026-08-12T00:15:00.000Z", 1.0862, 1.0880),
  ];
  const r = findEarliestZoneTouch(candles, { direction: "long", entryPrice: entry, since: placedAt });
  assertEquals(r.matchCount, 2, "two missed touches, and the last bar shows none at all");
});

Deno.test("bars before placement are ignored", () => {
  // A bar that touched this level yesterday is not a touch of today's order.
  const candles = [
    bar("2026-08-11T23:00:00.000Z", 1.0800, 1.0820), // before placed_at
    bar("2026-08-12T00:05:00.000Z", 1.0860, 1.0875), // after, no touch
  ];
  const r = findEarliestZoneTouch(candles, { direction: "long", entryPrice: entry, since: placedAt });
  assertEquals(r.touched, false, "history before the order existed cannot have touched it");
  assertEquals(r.examined, 1);
});

Deno.test("shorts touch from above", () => {
  const candles = [
    bar("2026-08-12T00:05:00.000Z", 1.0830, 1.0845),
    bar("2026-08-12T00:10:00.000Z", 1.0840, 1.0855), // high reaches 1.0850
  ];
  const r = findEarliestZoneTouch(candles, { direction: "short", entryPrice: entry, since: placedAt });
  assertEquals(r.touched, true);
  assertEquals(r.at, "2026-08-12T00:10:00.000Z");
});

Deno.test("uses high/low, never close", () => {
  // Opens and closes entirely above the level; only the wick reaches it. This
  // is the fast rejection these zones exist to catch.
  const candles = [bar("2026-08-12T00:05:00.000Z", 1.0849, 1.0880)];
  const r = findEarliestZoneTouch(candles, { direction: "long", entryPrice: entry, since: placedAt });
  assertEquals(r.touched, true, "a wick through the level is a touch");
});

Deno.test("an exact hit counts as a touch", () => {
  const candles = [bar("2026-08-12T00:05:00.000Z", entry, 1.0880)];
  const r = findEarliestZoneTouch(candles, { direction: "long", entryPrice: entry, since: placedAt });
  assertEquals(r.touched, true, "price reached the limit — boundary is inclusive");
});

Deno.test("no since filter examines the whole window", () => {
  const candles = [
    bar("2026-08-11T23:00:00.000Z", 1.0840, 1.0870),
    bar("2026-08-12T00:05:00.000Z", 1.0860, 1.0875),
  ];
  const r = findEarliestZoneTouch(candles, { direction: "long", entryPrice: entry, since: null });
  assertEquals(r.examined, 2);
  assertEquals(r.at, "2026-08-11T23:00:00.000Z");
});

Deno.test("unparseable timestamps are excluded, not admitted", () => {
  const candles = [
    { datetime: "not-a-date", low: 1.0800, high: 1.0900 },
    bar("2026-08-12T00:05:00.000Z", 1.0860, 1.0875),
  ];
  const r = findEarliestZoneTouch(candles, { direction: "long", entryPrice: entry, since: placedAt });
  assertEquals(
    r.touched,
    false,
    "a NaN timestamp must not slip past the window bound and stamp an unusable " +
      "zone_touch_time that the CHoCH search cannot anchor on",
  );
});

Deno.test("a non-finite entry price never reports a touch", () => {
  const candles = [bar("2026-08-12T00:05:00.000Z", 1.0000, 2.0000)];
  const r = findEarliestZoneTouch(candles, { direction: "long", entryPrice: NaN, since: placedAt });
  assertEquals(r.touched, false);
});

Deno.test("an empty window reports examined 0, distinct from 'no touch'", () => {
  const r = findEarliestZoneTouch([], { direction: "long", entryPrice: entry, since: placedAt });
  assertEquals(r.touched, false);
  assertEquals(
    r.examined,
    0,
    "examined=0 means the candle window never reached the order — a data problem, " +
      "not evidence that price stayed away",
  );
});

// ─── Wiring ──────────────────────────────────────────────────────────

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("the scanner no longer samples a single bar", () => {
  assert(
    !/lastCandle\.low <= entryPrice/.test(scanner),
    "the single-bar touch check must be gone",
  );
  assert(scanner.includes("findEarliestZoneTouch("));
});

Deno.test("the window is bounded by placement", () => {
  const start = scanner.indexOf("findEarliestZoneTouch(");
  assert(start > 0, "call site not found");
  const call = scanner.slice(start, scanner.indexOf("});", start));
  assert(
    call.includes("since: pending.placed_at"),
    "without a bound, bars from before the order existed could register as touches",
  );
});

Deno.test("zone_touch_time is stamped from the BAR, not from now()", () => {
  const branch = scanner.slice(scanner.indexOf("if (touch.touched) {"));
  const head = branch.slice(0, 600);
  assert(
    head.includes("touch.at ??"),
    "stamping now() would reintroduce the truncation this change exists to fix — " +
      "the gap between the real touch and detection is exactly what was being lost",
  );
});
