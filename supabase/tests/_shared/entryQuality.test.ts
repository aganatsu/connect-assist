/**
 * Entry-quality features — leakage firewall, causality and frozen definitions.
 *
 * IPO_ENTRY_QUALITY_TELEMETRY_V1 asks whether the touch/approach/reaction
 * sequence BEFORE the 1m fill separates IPO trades. That question is void if
 * a post-entry outcome leaks into a pre-entry cohort, or if a feature reads a
 * bar that had not closed at the fill minute. Both are pinned here, along
 * with the frozen touch, visit, sweep and excursion definitions.
 */

import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertPreEntryOnly, depthBucket, depthPct, pickPre, POST_ENTRY_OUTCOMES, postEntryOutcomes, PRE_COHORTS,
  PRE_ENTRY_FEATURES, preEntryFeatures, TREND_FEATURES, ttfBucket, type Bar, type Geom, type PreInput,
} from "../../../local-runner/entryQuality.ts";

const M = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const bar = (ms: number, o: number, h: number, l: number, c: number): Bar => ({ datetime: iso(ms), open: o, high: h, low: l, close: c });

// Demand zone: proximal 1.1000 (IPO high), distal/entry 1.0990, extent/stop 1.0980.
const G: Geom = { long: true, proximal: 1.1, distal: 1.099, extent: 1.098, entry: 1.099, stop: 1.098, target: 1.101, risk: 0.001, pip: 0.0001 };
const TOUCH = Date.parse("2025-07-01T13:00:00Z");
const D = TOUCH + 25 * M;                                     // fill minute
const H = 3_600_000;

/** 1m bars above the zone, drifting down, ending `n` minutes before D. */
function approachBars(n: number, endMs = D): Bar[] {
  const out: Bar[] = [];
  for (let i = n; i >= 1; i--) {
    const t = endMs - i * M, px = 1.1012 + i * 0.000004 + Math.sin(i / 2) * 0.00003;
    out.push(bar(t, px + 0.00002, px + 0.00006, px - 0.00006, px - 0.00002));
  }
  return out;
}
/** Own-TF hourly bars, all above the zone (no visits). */
function ownBars(n: number, endMs = TOUCH): Bar[] {
  return Array.from({ length: n }, (_, k) => {
    const t = endMs - (n - k) * H, px = 1.103 + Math.sin(k) * 0.0005;
    return bar(t, px, px + 0.0008, px - 0.0008, px + 0.0001);
  });
}
const IPO = bar(TOUCH - 30 * H, 1.0985, 1.1, 1.098, 1.0995);
const base = (over: Partial<PreInput> = {}): PreInput => {
  const own = ownBars(60);
  return { g: G, decisionMs: D, touchBarOpenMs: TOUCH, tfMs: H, fillBarOpen: 1.0995,
    m1Before: approachBars(200), ownBetween: own.slice(-29), ownPrefix: own, ipo: IPO, costR: 0.1, ...over };
};

// ─── firewall ───────────────────────────────────────────────────────────────

Deno.test("using a post-entry outcome in a pre-entry analysis throws", () => {
  for (const k of ["mae_r", "mfe_r", "net_r", "reached_1r", "mae_first_15m", "exit_reason", "win"]) {
    assertThrows(() => assertPreEntryOnly([k]), Error, "LEAKAGE");
  }
  assertThrows(() => assertPreEntryOnly(["not_a_feature"]), Error, "LEAKAGE");
});

Deno.test("every declared cohort and trend feature is pre-entry, and the two lists are disjoint", () => {
  assertPreEntryOnly(PRE_COHORTS.map((c) => c.feature));
  assertPreEntryOnly(TREND_FEATURES);
  const post = new Set<string>(POST_ENTRY_OUTCOMES);
  assertEquals(PRE_ENTRY_FEATURES.filter((k) => post.has(k)), []);
});

Deno.test("the cohort view carries no outcome, so outcomes cannot move a cohort", () => {
  const pre = preEntryFeatures(base());
  const a = { ...pre, mae_r: 0.1, net_r: 2, win: true }, b = { ...pre, mae_r: 3, net_r: -1.2, win: false };
  const va = pickPre(a), vb = pickPre(b);
  assert(!("mae_r" in va) && !("net_r" in va) && !("win" in va));
  for (const c of PRE_COHORTS) assertEquals(c.test(va[c.feature]), c.test(vb[c.feature]), c.name);
});

Deno.test("the feature functions return exactly the declared key sets", () => {
  const pre = preEntryFeatures(base());
  assertEquals(Object.keys(pre).sort(), [...PRE_ENTRY_FEATURES].sort());
  const post = postEntryOutcomes({ g: G, decisionMs: D, exitMs: D + 10 * M, exitReason: "TARGET",
    m1From: [bar(D, 1.0995, 1.0995, 1.0989, 1.0992), bar(D + 10 * M, 1.1, 1.1012, 1.0999, 1.101)], netR: 1.9, grossR: 2, minutesTouchToFill: 3 });
  assertEquals(Object.keys(post).sort(), [...POST_ENTRY_OUTCOMES].sort());
});

// ─── causality ──────────────────────────────────────────────────────────────

Deno.test("a 1m bar at or after the fill minute is refused", () => {
  const m1 = approachBars(200);
  assertThrows(() => preEntryFeatures(base({ m1Before: [...m1, bar(D, 1.1, 1.1, 1.098, 1.099)] })), Error, "fill minute");
  assertThrows(() => preEntryFeatures(base({ m1Before: [...m1, bar(D + 5 * M, 1.1, 1.1, 1.098, 1.099)] })), Error, "fill minute");
});

Deno.test("an own-timeframe bar that had not closed before the touch bar is refused", () => {
  const own = ownBars(60);
  assertThrows(() => preEntryFeatures(base({ ownBetween: [...own.slice(-29), bar(TOUCH, 1.1, 1.1, 1.099, 1.0995)] })), Error, "own-TF");
});

Deno.test("the study hands in the closed prefix, gates on 1m equivalence, and stops on failure", () => {
  const src = Deno.readTextFileSync(new URL("../../../local-runner/ipo-entry-quality-telemetry.ts", import.meta.url));
  assert(/m1Before: m1\.slice\(lo, ei\)/.test(src), "1m bars strictly before the fill minute");
  assert(/fillBarOpen: m1\[ei\]\.open/.test(src), "only the fill minute's open");
  assert(/ownBetween: bars\.slice\(ipoIdx \+ 1, entryIdx\)/.test(src) && /ownPrefix: bars\.slice\(0, entryIdx\)/.test(src));
  assert(/if \(!GATE_PASS\) Deno\.exit\(2\);/.test(src), "must stop if the control does not reproduce");
  assert(/M1_FILL_MINUTE_DIFF/.test(src) && /M1_TARGET_MINUTE_DIFF/.test(src) && /S2_BAR_DIFF/.test(src), "1m equivalence gate");
  assert(/M1_TRADE_COVERAGE/.test(src) && /M1_GLITCH_BAR/.test(src) && /ZONE_GEOMETRY_DIFF/.test(src), "coverage, OHLC sanity and geometry gates");
  assert(/const exitMs = exitInstant\(r\);/.test(src), "S2 trades are read to the S2 bar's close");
  assert(/c\.test\(p\[c\.feature\]\)/.test(src) && /pickPre\(/.test(src), "cohorts evaluate the pre-only view");
  const fw = src.indexOf("assertPreEntryOnly(TREND_FEATURES)"), an = src.indexOf("for (const c of PRE_COHORTS)");
  assert(fw > 0 && an > fw, "the firewall check runs before any analysis");
});

Deno.test("production definitions are reused, and no production code imports this module", async () => {
  const src = Deno.readTextFileSync(new URL("../../../local-runner/entryQuality.ts", import.meta.url));
  assert(/analyzeMarketStructure, detectDisplacement, detectSwingPoints/.test(src) && /_shared\/smcAnalysis\.ts/.test(src));
  for await (const e of Deno.readDir(new URL("../../functions/", import.meta.url))) {
    if (!e.isDirectory) continue;
    try {
      const s = Deno.readTextFileSync(new URL(`../../functions/${e.name}/index.ts`, import.meta.url));
      assert(!/entryQuality/.test(s), `${e.name} must not import entry quality`);
    } catch { /* no index.ts */ }
  }
});

// ─── frozen definitions ─────────────────────────────────────────────────────

Deno.test("penetration is measured from the near edge; the frozen fill sits at exactly 100%", () => {
  assertEquals(depthPct(G, 1.1), 0);
  assert(Math.abs(depthPct(G, 1.0995) - 50) < 1e-9);
  assert(Math.abs(depthPct(G, G.entry) - 100) < 1e-9);
  assertEquals(depthBucket(19.99), "0-20%"); assertEquals(depthBucket(20), "20-40%");
  assertEquals(depthBucket(100), "80-100%"); assertEquals(depthBucket(100.01), ">100%");
  assertEquals(ttfBucket(0), "0 min"); assertEquals(ttfBucket(15), "15-60 min"); assertEquals(ttfBucket(null), ">240 min");
  assertEquals(preEntryFeatures(base()).fill_depth_pct_of_zone, 100);
});

Deno.test("touches: continuous occupancy is one touch; a genuine exit and return is a new one", () => {
  const above = (t: number) => bar(t, 1.102, 1.1025, 1.1005, 1.1015);  // low above the near edge
  const inside = (t: number) => bar(t, 1.1008, 1.101, 1.0996, 1.1004); // low crosses it
  const seq = (pattern: string) => [...pattern].map((ch, k) => (ch === "i" ? inside : above)(TOUCH - (pattern.length - k) * H));
  const tc = (p: string) => preEntryFeatures(base({ ownBetween: seq(p) })).touch_count_before_fill;
  assertEquals(tc("oooo"), 1);           // first touch is the touch bar itself
  assertEquals(tc("oiiio"), 2);          // one prior visit (3 bars of occupancy), then the touch bar
  assertEquals(tc("oioi"), 2);           // prior visit + a visit still running into the touch bar
  assertEquals(tc("oioio"), 3);
  const f = preEntryFeatures(base({ ownBetween: seq("oiiooo") }));
  assertEquals(f.first_touch_trade, false); assertEquals(f.prior_bars_in_zone, 2); assertEquals(f.bars_since_previous_touch, 4);
});

Deno.test("1m re-entries inside the touch bar count exits, not minutes in the zone", () => {
  const pre = approachBars(200, TOUCH);
  const out = (t: number) => bar(t, 1.1006, 1.1008, 1.1003, 1.1005), inn = (t: number) => bar(t, 1.1002, 1.1004, 1.0995, 1.1001);
  const mk = (p: string) => [...pre, ...[...p].map((ch, k) => (ch === "i" ? inn : out)(TOUCH + k * M))];
  const decision = (p: string) => TOUCH + p.length * M;
  const re = (p: string) => preEntryFeatures(base({ m1Before: mk(p), decisionMs: decision(p) })).zone_reentry_count_before_fill;
  assertEquals(re("ooo"), 0);
  assertEquals(re("iii"), 0);             // occupancy into the fill
  assertEquals(re("iio"), 1);             // left, then the fill minute re-entered
  assertEquals(re("ioioi"), 2);
  const ttf = (p: string) => preEntryFeatures(base({ m1Before: mk(p), decisionMs: decision(p) })).minutes_from_first_touch_to_fill;
  assertEquals(ttf("ooo"), 0);
  assertEquals(ttf("oiii"), 3);
});

Deno.test("sweep: a confirmed swing low in the last 20 bars, then a wick through it that closes back", () => {
  const m1 = approachBars(200);
  const L = m1.length;
  // flat lows, a swing low at L-10 (confirmed at L-7), swept at L-4. The sweep
  // bar is itself a local low; it must not shadow the swing it swept.
  for (let k = L - 24; k < L; k++) { const b = m1[k]; m1[k] = { ...b, low: 1.1009, high: 1.1015, open: 1.1012, close: 1.1012 }; }
  m1[L - 10] = { ...m1[L - 10], low: 1.1005 };
  m1[L - 4] = { ...m1[L - 4], low: 1.1003, close: 1.1007 };
  const f = preEntryFeatures(base({ m1Before: m1 }));
  assertEquals(f.sweep_present, true);
  assertEquals(f.sweep_level, 1.1005);
  assertEquals(f.minutes_sweep_to_fill, 4);
  // close below the swing is a break, not a sweep
  m1[L - 4] = { ...m1[L - 4], close: 1.1004 };
  assertEquals(preEntryFeatures(base({ m1Before: m1 })).sweep_present, false);
});

Deno.test("sweep: a swing not yet confirmed at the sweep bar cannot be the swept level", () => {
  const m1 = approachBars(200);
  const L = m1.length;
  for (let k = L - 24; k < L; k++) { const b = m1[k]; m1[k] = { ...b, low: 1.1009, high: 1.1015, open: 1.1012, close: 1.1012 }; }
  m1[L - 10] = { ...m1[L - 10], low: 1.1005 };                    // swing A, confirmed at L-7
  m1[L - 6] = { ...m1[L - 6], low: 1.1001, close: 1.1003 };       // breaks A; its own swing confirms only at L-3
  m1[L - 4] = { ...m1[L - 4], low: 1.1003, close: 1.1007 };       // sweeps A — the latest swing KNOWN at L-4
  const f = preEntryFeatures(base({ m1Before: m1 }));
  assertEquals(f.sweep_present, true);
  assertEquals(f.sweep_level, 1.1005);
  assertEquals(f.minutes_sweep_to_fill, 4);
});

Deno.test("post-entry: the fill minute's favorable extreme is excluded, its adverse extreme kept", () => {
  // Fill minute opened at 1.1004, spiked to 1.1010 BEFORE coming down to fill, then traded to 1.0985.
  const fill = bar(D, 1.1004, 1.101, 1.0981, 1.0992);
  const rest = [bar(D + M, 1.0992, 1.0994, 1.0988, 1.099), bar(D + 2 * M, 1.099, 1.0991, 1.0984, 1.0986)];
  const o = postEntryOutcomes({ g: G, decisionMs: D, exitMs: D + 60 * M, exitReason: "S2_CLOSE_INVALIDATION",
    m1From: [fill, ...rest], netR: -1.1, grossR: -1, minutesTouchToFill: 0 });
  assert(Math.abs((o.mae_r as number) - 0.9) < 1e-9, "fill-minute low counts (it can only follow the fill)");
  assert(Math.abs((o.mfe_r as number) - 0.4) < 1e-9, "only later bars count for MFE: 1.0994 = +0.4R; the 1.1010 spike is excluded");
  assertEquals(o["reached_0.25r"], true);
  assertEquals(o.reached_1r, false);
  assertEquals(o.minutes_to_mae, 0);
});

Deno.test("post-entry: a TARGET trade's MFE is the 2R target and early windows are truncated by time", () => {
  const m1From = [bar(D, 1.0995, 1.0995, 1.0986, 1.0992), ...Array.from({ length: 40 }, (_, k) => {
    const px = 1.0992 + k * 0.00005; return bar(D + (k + 1) * M, px, px + 0.00003, px - 0.00003, px + 0.00002);
  })];
  const tMin = m1From.findIndex((b) => b.high >= G.target);
  const o = postEntryOutcomes({ g: G, decisionMs: D, exitMs: Date.parse(m1From[tMin].datetime), exitReason: "TARGET",
    m1From, netR: 1.9, grossR: 2, minutesTouchToFill: 5 });
  assertEquals(o.mfe_r, 2); assertEquals(o.reached_2r, true); assertEquals(o.minutes_to_mfe, tMin);
  assert(Math.abs((o.mae_first_5m as number) - 0.4) < 1e-9);
  assert((o.mfe_first_5m as number) < (o.mfe_first_30m as number));
  assertEquals(o.minutes_from_first_touch_to_first_favorable_move, 5 + (o["minutes_to_0.25r"] as number));
});

// ─── 1m coverage (gate-critical) ───────────────────────────────────────────

import { exitInstant, firstProblem, gapOk } from "../../../local-runner/ipo-entry-m1-fetch.ts";

Deno.test("an S2 trade ends at the S2 bar's CLOSE, not the open the export stores", () => {
  assertEquals(exitInstant({ exit_reason: "S2_CLOSE_INVALIDATION", s2_invalidation_time: "2025-10-31T12:00:00Z", ipo_timeframe: "4h", m1_target_time: "" }),
    Date.parse("2025-10-31T16:00:00Z"));
  assertEquals(exitInstant({ exit_reason: "S2_CLOSE_INVALIDATION", s2_invalidation_time: "2025-10-31T12:00:00Z", ipo_timeframe: "1h", m1_target_time: "" }),
    Date.parse("2025-10-31T13:00:00Z"));
  assertEquals(exitInstant({ exit_reason: "TARGET", s2_invalidation_time: "", ipo_timeframe: "4h", m1_target_time: "2025-10-31T12:07:00Z" }),
    Date.parse("2025-10-31T12:07:00Z"));
});

Deno.test("a gap is market closure only when short, an FX weekend, or proven by a fetched page", () => {
  const W = (s: string) => Date.parse(s);
  assert(gapOk(W("2025-07-01T10:00:00Z"), W("2025-07-01T10:45:00Z"), true, []));
  assert(!gapOk(W("2025-07-01T10:00:00Z"), W("2025-07-01T13:00:00Z"), true, []), "a weekday hole");
  assert(gapOk(W("2025-07-04T20:59:00Z"), W("2025-07-06T22:00:00Z"), true, []), "FX weekend");
  assert(!gapOk(W("2025-07-04T20:59:00Z"), W("2025-07-06T22:00:00Z"), false, []), "BTC has no weekend");
  assert(!gapOk(W("2024-12-24T12:59:00Z"), W("2024-12-25T22:31:00Z"), true, []), "a holiday needs proof");
  assert(gapOk(W("2024-12-24T12:59:00Z"), W("2024-12-25T22:31:00Z"), true, [[W("2024-12-20T00:00:00Z"), W("2024-12-26T00:00:00Z")]]));
});

Deno.test("firstProblem finds the missing tail, the unproven hole and the missing head, newest first", () => {
  const t0 = Date.parse("2025-07-01T00:00:00Z");
  const run = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i * M);
  const t = [...run(t0, 300), ...run(t0 + 600 * M, 300)];          // a 5h hole at 05:00-10:00
  assertEquals(firstProblem(t, t0 + 10 * M, t0 + 200 * M, true, []), null);
  assertEquals(firstProblem(t, t0 + 10 * M, t0 + 700 * M, true, []), t0 + 600 * M, "the hole: ask up to the bar after it");
  assertEquals(firstProblem(t, t0 + 10 * M, t0 + 700 * M, true, [[t0 + 100 * M, t0 + 600 * M]]), null, "a page that reached that bar proves the hole");
  assertEquals(firstProblem(t, t0 + 10 * M, t0 + 700 * M, true, [[t0, t0 + 650 * M]]), null, "hole proven empty");
  assertEquals(firstProblem(t, t0 - 60 * M, t0 + 200 * M, true, []), t0, "the head");
  assertEquals(firstProblem(t, t0 + 650 * M, t0 + 1200 * M, true, []), t0 + 1200 * M, "the tail");
  // the tail is satisfied by a page that reached b, even if the next cached bar is years later
  const far = [...t, t0 + 900 * 24 * 60 * M];
  assertEquals(firstProblem(far, t0 + 650 * M, t0 + 1200 * M, true, []), t0 + 1200 * M);
  assertEquals(firstProblem(far, t0 + 650 * M, t0 + 1200 * M, true, [[t0 + 400 * M, t0 + 1200 * M]]), null);
});

// ─── 1m OHLC repair and glitch rule ────────────────────────────────────────

import { sanitizeM1 } from "../../../local-runner/ipo-entry-m1-fetch.ts";

const calm = (n: number, px: number, r: number): Bar[] => Array.from({ length: n }, (_, i) =>
  bar(D + i * M, px, px + r / 2 + (i % 3) * r * 0.05, px - r / 2 - (i % 3) * r * 0.05, px + r * 0.1));

Deno.test("an open/close outside its own bar is clamped into [low, high]; high/low are kept", () => {
  const raw = calm(10, 1.0549, 0.0002);
  raw[4] = { ...raw[4], close: 1.05, open: 1.1 };            // the Dec 2024 precision-loss pattern
  const { bars, clamped, glitch } = sanitizeM1(raw);
  assertEquals(bars[4].close, raw[4].low); assertEquals(bars[4].open, raw[4].high);
  assertEquals(bars[4].high, raw[4].high); assertEquals(bars[4].low, raw[4].low);
  assertEquals(clamped[4], 1); assertEquals(clamped.reduce((a, b) => a + b, 0), 1);
  assertEquals(glitch.reduce((a, b) => a + b, 0), 0);
});

Deno.test("an isolated decimal glitch is flagged; a real crash wick is not", () => {
  const raw = calm(200, 26000, 20);
  raw[100] = { ...raw[100], low: 2.58 };                     // the 2023 BTC feed
  assertEquals(sanitizeM1(raw).glitch[100], 1);
  // A crash: ranges blow out for an hour, with one 1,500-wide liquidation wick.
  const crash = calm(200, 110000, 40);
  for (let i = 80; i < 140; i++) { const px = 110000 - (i - 80) * 80; crash[i] = bar(D + i * M, px, px + 600, px - 600, px - 50); }
  crash[110] = { ...crash[110], low: crash[110].low - 1500 };
  assertEquals(sanitizeM1(crash).glitch.reduce((a, b) => a + b, 0), 0);
});
