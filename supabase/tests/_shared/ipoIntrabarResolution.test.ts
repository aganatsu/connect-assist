import { assert, assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  resolveEntryBar, compareToHtf, type TradeSpec, type FeedIdentity,
} from "../../functions/_shared/ipoIntrabarResolution.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/** The BTC incident, as the audit recorded it. */
const BTC: TradeSpec = {
  direction: "long", entry: 84473.315, target: 85159.525, s2: 84130.21, risk: 343.105,
};

const FEED: FeedIdentity = {
  provider: "bitstamp", venue: "Bitstamp", symbol: "btcusd",
  provenance: "VENUE_SPECIFIC",
  basis: "Bitstamp public OHLC API; the HTF bar's own provider was not recorded.",
};

const m = (hhmm: string, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime: `2026-09-23T${hhmm}:00Z`, open: o, high: h, low: l, close: c, volume: 0 });

// ── the rule that must not bend ──────────────────────────────────────────────

Deno.test("S2 stays close-confirmed: a 1m low through S2 is a touch, not an exit", () => {
  const minutes = [
    m("14:10", 84600, 84650, 84400, 84500),
    m("14:13", 84500, 84520, 84400, 84450),        // entry touch
    m("14:23", 84300, 84350, 84100, 84200),        // LOW through S2, close above
    m("14:40", 84200, 84250, 84150, 84200),
  ];
  const r = resolveEntryBar(BTC, minutes, FEED);
  assertEquals(r.outcome, "STILL_OPEN_AT_BAR_END", "a wick below S2 must not close it");
  assertEquals(r.s2TouchMinuteTime, "2026-09-23T14:23:00Z", "the touch is recorded");
  assertEquals(r.s2CloseMinuteTime, null, "but no close-invalidation occurred");
});

Deno.test("a completed 1m close beyond S2 IS an invalidation", () => {
  const minutes = [
    m("14:13", 84500, 84520, 84400, 84450),
    m("14:23", 84300, 84350, 84100, 84200),        // touch only
    m("14:30", 84050, 84097, 83943, 83990),        // wholly below S2 — closes beyond
  ];
  const r = resolveEntryBar(BTC, minutes, FEED);
  assertEquals(r.outcome, "S2_CLOSE_AFTER_ENTRY");
  assertEquals(r.s2CloseMinuteTime, "2026-09-23T14:30:00Z");
  assertEquals(r.s2TouchMinuteTime, "2026-09-23T14:23:00Z", "the earlier touch is still reported");
});

// ── the incident, reconstructed ──────────────────────────────────────────────

Deno.test("the BTC hour resolves to an S2 invalidation, not a 2R win", () => {
  // Abridged from the real Bitstamp minutes: pre-entry high, entry at 14:13,
  // rebound short of target, then the 14:30 close below S2.
  const minutes = [
    m("14:00", 85779.37, 85838.51, 85754.37, 85838.51),   // pre-entry, near the HTF high
    m("14:01", 85838.51, 85910.63, 85838.51, 85900.18),
    m("14:13", 84600.00, 84610.00, 84470.00, 84500.00),   // first touch of 84473.315
    m("14:14", 84728.00, 84880.00, 84728.00, 84800.00),   // rebound tops at 84880
    m("14:23", 84300.00, 84350.00, 84100.00, 84200.00),   // S2 touched, not closed beyond
    m("14:30", 84050.00, 84097.00, 83943.00, 83990.00),   // closes below S2
  ];
  const r = resolveEntryBar(BTC, minutes, FEED);

  assertEquals(r.outcome, "S2_CLOSE_AFTER_ENTRY");
  assertEquals(r.entryMinuteTime, "2026-09-23T14:13:00Z");
  assertEquals(r.targetMinuteTime, null, "the target was never reached after entry");
  assertEquals(r.s2CloseMinuteTime, "2026-09-23T14:30:00Z");

  // Post-entry MFE ≈ 1.19R, against the 4.28R the HTF engine recorded.
  assertAlmostEquals(r.postEntryMfeR, (84880 - BTC.entry) / BTC.risk, 1e-9);
  assert(r.postEntryMfeR < 1.2, `post-entry MFE ${r.postEntryMfeR}`);

  assertEquals(compareToHtf("TARGET_2R", r), "CONTRADICTED");
});

Deno.test("the pre-entry high is excluded from the post-entry excursion", () => {
  // 85910.63 occurs before the entry minute and must not count.
  const minutes = [
    m("14:01", 85838.51, 85910.63, 85838.51, 85900.18),
    m("14:13", 84600, 84610, 84470, 84500),
    m("14:14", 84728, 84880, 84728, 84800),
  ];
  const r = resolveEntryBar(BTC, minutes, FEED);
  const preEntryR = (85910.63 - BTC.entry) / BTC.risk;
  assert(preEntryR > 4, "the pre-entry high would have been >4R");
  assert(r.postEntryMfeR < 1.2, "but post-entry MFE stays near 1.19R");
});

// ── legitimate same-bar wins must survive ────────────────────────────────────

Deno.test("a genuine post-entry target is still a win", () => {
  // This is why "ignore the entry bar's target" is the wrong fix: here the
  // target really is reached after the entry, and the trade should stand.
  const minutes = [
    m("14:05", 84600, 84620, 84400, 84450),        // entry at 14:05
    m("14:20", 84500, 84700, 84480, 84690),
    m("14:35", 84700, 85200, 84690, 85180),        // target 85159.525 reached AFTER entry
  ];
  const r = resolveEntryBar(BTC, minutes, FEED);
  assertEquals(r.outcome, "TARGET_AFTER_ENTRY");
  assertEquals(r.targetMinuteTime, "2026-09-23T14:35:00Z");
  assertEquals(compareToHtf("TARGET_2R", r), "AGREES");
});

Deno.test("a trade still open when the HTF bar ends is handed back, not closed", () => {
  const minutes = [
    m("14:05", 84600, 84620, 84400, 84450),
    m("14:30", 84450, 84600, 84300, 84550),
  ];
  const r = resolveEntryBar(BTC, minutes, FEED);
  assertEquals(r.outcome, "STILL_OPEN_AT_BAR_END");
  // The HTF engine closing it on the entry bar is contradicted; HTF taking it
  // forward is agreement.
  assertEquals(compareToHtf("TARGET_2R", r), "CONTRADICTED");
  assertEquals(compareToHtf("NONE", r), "AGREES");
});

// ── residual ambiguity is reported, never guessed ────────────────────────────

Deno.test("one minute containing both entry and target stays UNRESOLVED", () => {
  // 1m is no finer than 1h for this trade. This is the tick-fallback case, and
  // the honest answer is to say so.
  const minutes = [
    m("14:10", 85300, 85400, 85250, 85350),
    m("14:13", 85200, 85300, 84400, 84500),        // spans entry AND target
  ];
  const r = resolveEntryBar(BTC, minutes, FEED);
  assertEquals(r.outcome, "UNRESOLVED_AT_1M");
  assertEquals(r.ambiguousMinuteTime, "2026-09-23T14:13:00Z");
  assertEquals(compareToHtf("TARGET_2R", r), "STILL_UNRESOLVED");
});

Deno.test("target beats S2 close within the same minute, because a close is last", () => {
  const minutes = [
    m("14:05", 84600, 84620, 84400, 84450),
    m("14:20", 84400, 85200, 83900, 84000),        // reaches target AND closes below S2
  ];
  const r = resolveEntryBar(BTC, minutes, FEED);
  assertEquals(r.outcome, "TARGET_AFTER_ENTRY",
    "the close is the minute's last event, so it cannot precede the high");
});

Deno.test("no entry at 1m contradicts the HTF fill", () => {
  const minutes = [m("14:10", 85300, 85400, 85250, 85350)];
  const r = resolveEntryBar(BTC, minutes, FEED);
  assertEquals(r.outcome, "NO_ENTRY_AT_1M");
  assertEquals(compareToHtf("TARGET_2R", r), "CONTRADICTED");
});

Deno.test("absent coverage is reported as absent, not as agreement", () => {
  const r = resolveEntryBar(BTC, [], FEED);
  assertEquals(r.minutesSeen, 0);
  assertEquals(compareToHtf("TARGET_2R", r), "NO_1M_COVERAGE");
});

// ── shorts ───────────────────────────────────────────────────────────────────

Deno.test("a short mirrors every rule", () => {
  const spec: TradeSpec = { direction: "short", entry: 100, target: 90, s2: 105, risk: 5 };
  const minutes = [
    m("14:05", 99, 100.5, 98, 99),                 // entry: high >= 100
    m("14:10", 99, 104, 98, 99),                   // touches toward S2, closes below it
    m("14:20", 99, 106, 99, 105.5),                // closes BEYOND S2 (above 105)
  ];
  const r = resolveEntryBar(spec, minutes, FEED);
  assertEquals(r.entryMinuteTime, "2026-09-23T14:05:00Z");
  assertEquals(r.outcome, "S2_CLOSE_AFTER_ENTRY");
  assertEquals(r.s2CloseMinuteTime, "2026-09-23T14:20:00Z");
});

// ── provenance travels with the answer ───────────────────────────────────────

Deno.test("every resolution carries the feed it came from", () => {
  const r = resolveEntryBar(BTC, [m("14:13", 84600, 84610, 84470, 84500)], FEED);
  assertEquals(r.feed.provider, "bitstamp");
  assertEquals(r.feed.venue, "Bitstamp");
  assertEquals(r.feed.provenance, "VENUE_SPECIFIC");
  assert(r.feed.basis.length > 20, "the basis must explain how provenance was established");
});

Deno.test("VENUE_SPECIFIC is not SOURCE_MATCHED, and the type keeps them apart", () => {
  // The whole point of the taxonomy: a Bitstamp answer about a Twelve Data bar
  // is a second opinion, not a reconstruction of the original path.
  const matched: FeedIdentity = { ...FEED, provenance: "SOURCE_MATCHED" };
  const unknown: FeedIdentity = { ...FEED, provenance: "HTF_SOURCE_UNKNOWN" };
  assert(matched.provenance !== FEED.provenance);
  assert(unknown.provenance !== FEED.provenance);
});
