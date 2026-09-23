/**
 * STAGE 2 diagnostics — forward continuation, attribution discipline, coverage.
 *
 * RESEARCH ONLY. The module under test has no caller in production code; a test
 * below asserts that. Stage 1's diagnostics are untouched and keep their meaning.
 */

import { assert, assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  resolveEntryBar, continueAfterEntryBar, compareToHtf,
  type TradeSpec, type FeedIdentity,
} from "../../functions/_shared/ipoIntrabarResolution.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const SPEC: TradeSpec = { direction: "long", entry: 100, target: 110, s2: 95, risk: 5 };
const SHORT: TradeSpec = { direction: "short", entry: 100, target: 90, s2: 105, risk: 5 };

const SRC: FeedIdentity = {
  provider: "twelvedata", venue: "TwelveData composite", symbol: "BTC/USD",
  provenance: "SOURCE_MATCHED",
  basis: "Stored HTF bar reproduced EXACTLY by Twelve Data on all four OHLC fields.",
};
const XFD: FeedIdentity = { ...SRC, provenance: "CROSS_FEED_REFERENCE",
  basis: "Attribution was TWELVE_CLOSE_MATCH_BUT_NOT_PROVEN; source identity is unproven." };

const bar = (t: string, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime: t, open: o, high: h, low: l, close: c, volume: 0 });
const hour = (n: number, o: number, h: number, l: number, c: number) =>
  bar(`2026-09-23T${String(n).padStart(2, "0")}:00:00Z`, o, h, l, c);

// ── carry-forward ────────────────────────────────────────────────────────────

Deno.test("carry-forward reaches a later target", () => {
  const f = continueAfterEntryBar(SPEC, [hour(15, 101, 105, 99, 104), hour(16, 104, 112, 103, 111)]);
  assertEquals(f.outcome, "TARGET");
  assertEquals(f.exitBarTime, "2026-09-23T16:00:00Z");
  assertEquals(f.barsHeld, 2);
  assertAlmostEquals(f.grossR!, 2, 1e-12);
});

Deno.test("carry-forward reaches a later S2 close", () => {
  const f = continueAfterEntryBar(SPEC, [hour(15, 101, 103, 99, 100), hour(16, 100, 101, 92, 93)]);
  assertEquals(f.outcome, "S2_CLOSE");
  assertEquals(f.exitBarTime, "2026-09-23T16:00:00Z");
  // Gross is measured to the CLOSE, so an S2 loss can exceed 1R.
  assertAlmostEquals(f.grossR!, (93 - 100) / 5, 1e-12);
  assert(f.grossR! < -1, "S2 losses are not capped at -1R");
});

Deno.test("carry-forward keeps S2 close-confirmed across later bars", () => {
  // Bar wicks to 90 (below S2 95) but closes at 99. Not an exit.
  const f = continueAfterEntryBar(SPEC, [hour(15, 100, 101, 90, 99)]);
  assertEquals(f.outcome, "STILL_OPEN_AT_END_OF_DATA");
});

Deno.test("a later bar holding BOTH decisive events is flagged, not resolved by convention", () => {
  const f = continueAfterEntryBar(SPEC, [hour(15, 100, 112, 90, 93)]);
  assertEquals(f.outcome, "AMBIGUOUS_LATER_BAR");
  assertEquals(f.ambiguousBarTime, "2026-09-23T15:00:00Z");
  assertEquals(f.grossR, null, "no R is claimed for an unordered bar");
});

Deno.test("seeded excursion carries the 1m post-entry figures, not the entry bar's full range", () => {
  // The entry bar's PRE-entry range must never re-enter MFE. The seed is the
  // 1m-measured post-entry excursion and continuation may only raise it.
  // The later bar only reaches 0.8R, below the 1.19R already measured at 1m, so
  // the seed must survive. Continuation may only RAISE the excursion.
  const f = continueAfterEntryBar(SPEC, [hour(15, 100, 104, 99, 103)], 1.19, 0.4);
  assertAlmostEquals(f.mfeR, 1.19, 1e-12);
  assertAlmostEquals(f.maeR, 0.4, 1e-12);
  // A bigger later excursion does replace it.
  const g = continueAfterEntryBar(SPEC, [hour(15, 100, 108, 99, 103)], 1.19, 0.4);
  assertAlmostEquals(g.mfeR, (108 - 100) / 5, 1e-12);
});

Deno.test("continuation over no later bars leaves the position open", () => {
  const f = continueAfterEntryBar(SPEC, []);
  assertEquals(f.outcome, "STILL_OPEN_AT_END_OF_DATA");
  assertEquals(f.grossR, null);
  assertEquals(f.barsHeld, 0);
});

Deno.test("shorts mirror the continuation rules", () => {
  const up = continueAfterEntryBar(SHORT, [hour(15, 100, 106, 99, 106)]);
  assertEquals(up.outcome, "S2_CLOSE");
  const win = continueAfterEntryBar(SHORT, [hour(15, 100, 101, 88, 89)]);
  assertEquals(win.outcome, "TARGET");
});

// ── the entry bar into the continuation, end to end ──────────────────────────

Deno.test("still-open at bar end hands over to continuation, and the two compose", () => {
  const minutes = [
    bar("2026-09-23T14:05:00Z", 101, 102, 99, 100),     // entry
    bar("2026-09-23T14:30:00Z", 100, 103, 99, 101),
  ];
  const r = resolveEntryBar(SPEC, minutes, SRC);
  assertEquals(r.outcome, "STILL_OPEN_AT_BAR_END");
  assertEquals(compareToHtf("TARGET_2R", r), "CONTRADICTED");

  const f = continueAfterEntryBar(SPEC, [hour(15, 101, 112, 100, 111)],
                                  r.postEntryMfeR, r.postEntryMaeR);
  assertEquals(f.outcome, "TARGET");
  // The trade is a win — but one bar later than the HTF engine claimed.
  assertEquals(f.barsHeld, 1);
});

// ── attribution discipline ───────────────────────────────────────────────────

Deno.test("SOURCE_MATCHED and CROSS_FEED_REFERENCE are distinct and both carried", () => {
  const a = resolveEntryBar(SPEC, [bar("2026-09-23T14:05:00Z", 101, 102, 99, 100)], SRC);
  const b = resolveEntryBar(SPEC, [bar("2026-09-23T14:05:00Z", 101, 102, 99, 100)], XFD);
  assertEquals(a.feed.provenance, "SOURCE_MATCHED");
  assertEquals(b.feed.provenance, "CROSS_FEED_REFERENCE");
  // Same numbers, different claim about what they prove.
  assertEquals(a.outcome, b.outcome);
  assert(a.feed.basis !== b.feed.basis);
});

Deno.test("a non-exact attribution must not produce a SOURCE_MATCHED label", async () => {
  // The rule lives in the runner: only TWELVE_EXACT_MATCH earns SOURCE_MATCHED.
  const src = await Deno.readTextFile("local-runner/td-resolve.ts");
  assert(src.includes('const sourceMatched = attribution === "TWELVE_EXACT_MATCH"'),
    "source-matching is no longer gated on an exact attribution");
  assert(src.includes('sourceMatched ? "SOURCE_MATCHED" : "CROSS_FEED_REFERENCE"'),
    "the provenance no longer follows the attribution");
});

Deno.test("attribution classes are defined tightest-first and exactness has no tolerance", async () => {
  const src = await Deno.readTextFile("local-runner/td-attribution.ts");
  assert(src.includes("f.stored === f.twelve"), "exactness gained a tolerance");
  assert(src.includes("TWELVE_CLOSE_MATCH_BUT_NOT_PROVEN"), "the close-but-unproven class is gone");
  // Absence of a Twelve match must not name another provider. Checked on CODE
  // only — the header states the prohibition in prose and would match itself.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert(!/polygon/i.test(code), "the attribution code names Polygon");
  assert(/not_twelve_attributed|rules down twelve data/i.test(src),
    "the ruling-down-only caveat is missing");
});

// ── coverage refusal ─────────────────────────────────────────────────────────

Deno.test("no minutes means no resolution, not a silent pass", () => {
  const r = resolveEntryBar(SPEC, [], SRC);
  assertEquals(r.minutesSeen, 0);
  assertEquals(compareToHtf("TARGET_2R", r), "NO_1M_COVERAGE");
});

Deno.test("the resolver refuses to resolve when the entry is never touched", () => {
  const r = resolveEntryBar(SPEC, [bar("2026-09-23T14:05:00Z", 105, 106, 101, 104)], SRC);
  assertEquals(r.outcome, "NO_ENTRY_AT_1M");
  assertEquals(r.entryMinuteTime, null);
});

Deno.test("the runner checks minute aggregation against BOTH the stored and Twelve bars", async () => {
  const src = await Deno.readTextFile("local-runner/td-resolve.ts");
  assert(src.includes("aggregateVsStoredPct") && src.includes("aggregateVsTwelvePct"),
    "one of the three evidence layers is missing");
  assert(src.includes("AGGREGATE_DIVERGENT"), "divergent aggregation no longer refuses");
  assert(src.includes("NO_1M_DATA"), "absent minutes no longer refuse");
});

// ── UTC and bar boundaries ───────────────────────────────────────────────────

Deno.test("minutes outside the HTF bar are excluded by the caller", async () => {
  const src = await Deno.readTextFile("local-runner/td-resolve.ts");
  assert(src.includes("t >= start && t < end"),
    "the half-open bar window is gone; a minute past the boundary would be lookahead");
  assert(src.includes('u.searchParams.set("timezone", "UTC")'), "UTC is no longer pinned");
});

Deno.test("the attribution fetch pins UTC and ascending order", async () => {
  const src = await Deno.readTextFile("local-runner/td-attribution.ts");
  assert(src.includes('"timezone", "UTC"'));
  assert(src.includes('"order", "ASC"'));
});

// ── the research module stays out of production ──────────────────────────────

Deno.test("no production code imports the research resolver", async () => {
  const roots = ["supabase/functions", "src"];
  const offenders: string[] = [];
  for (const root of roots) {
    for await (const e of Deno.readDir(root)) {
      if (!e.isDirectory) continue;
      for await (const f of Deno.readDir(`${root}/${e.name}`)) {
        if (!f.isFile || !/\.tsx?$/.test(f.name)) continue;
        const p = `${root}/${e.name}/${f.name}`;
        const src = await Deno.readTextFile(p);
        if (src.includes("ipoIntrabarResolution")) offenders.push(p);
      }
    }
  }
  assertEquals(offenders, [], "the research resolver is being imported by application code");
});

Deno.test("no research script hardcodes a credential", async () => {
  for (const p of ["local-runner/td-attribution.ts", "local-runner/td-resolve.ts",
                   "local-runner/intrabar-carry-forward-btc.ts",
                   "supabase/functions/_shared/ipoIntrabarResolution.ts"]) {
    const src = await Deno.readTextFile(p);
    // A 32-hex literal is what a Twelve Data key looks like.
    assert(!/["'][0-9a-f]{32}["']/.test(src), `${p} contains a 32-hex literal`);
    assert(!/apikey=[A-Za-z0-9]/.test(src), `${p} embeds an apikey value in a URL`);
  }
});
