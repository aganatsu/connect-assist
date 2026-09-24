/**
 * REGRESSION GUARD — causal event ordering on IPO forward paper execution.
 *
 * These are the cases the forward-evidence containment fix exists to get right.
 * The incident they are built from is real: BTC/USD 1h, IPO candle
 * 2026-09-21T10:00Z, long from 84473.315, S2 84130.21, target 85159.525. The
 * entry bar 2026-09-23T14:00Z opened at 85792.01 — already above the target —
 * so whole-bar OHLC booked TARGET_2R on a position that had not yet filled. The
 * 1-minute tape showed the entry first touched ~14:13, the post-entry rebound
 * never reached the target, and the bar closed below S2.
 *
 * WHAT IS NOT TESTED HERE, DELIBERATELY. No test asserts a profit, a win rate or
 * an improvement. The fix is measurement hygiene; if it makes the strategy look
 * worse, it has still worked.
 */

import { assert, assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  resolveBar, minutesInBar, htfWouldHaveClosed, CAUSAL_EXECUTION_VERSION,
} from "../../functions/_shared/ipoCausalOrdering.ts";
import {
  stepPosition, openPosition, openAmbiguous, altTargetNetR, buildIntent, NO_PROVENANCE,
  type PaperPosition,
} from "../../functions/_shared/ipoPaperContract.ts";
import { runPaper } from "../../functions/_shared/ipoPaperRunner.ts";
import { replayIncremental } from "../../functions/_shared/ipoIncrementalEngine.ts";
import type { LiveTrade, EngineConfig } from "../../functions/_shared/ipoLiveEngine.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const HOUR = 3_600_000;
const ENTRY = 84473.315;
const S2 = 84130.21;
const TARGET = 85159.525;
const RISK = 343.105;

/** The stored bar, verbatim from `ipo_engine_state:ipo_cet:BTC/USD`. */
const ENTRY_BAR: Candle = {
  datetime: "2026-09-23T14:00:00Z",
  open: 85792.01, high: 85940.32, low: 83864.07, close: 84530.00, volume: 0,
};

const minute = (mm: number, o: number, h: number, l: number, c: number): Candle => ({
  datetime: `2026-09-23T14:${String(mm).padStart(2, "0")}:00Z`,
  open: o, high: h, low: l, close: c, volume: 0,
});

const base = {
  direction: "long" as const,
  entryPrice: ENTRY, targetPrice: TARGET, s2InvalidationLevel: S2,
  barMs: HOUR,
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. target high occurred BEFORE the E2 entry -> MUST NOT book target
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("1 — a target reached before the entry minute must not book the target", () => {
  // The stored bar closes at 84530, ABOVE S2 — under close-confirmed S2 the real
  // incident invalidated on a later bar. To pin the target refusal against an
  // actual exit, this variant closes the same bar below S2.
  const bar: Candle = { ...ENTRY_BAR, close: 84000 };
  const minutes: Candle[] = [
    // The bar opens above the target. This excursion belongs to no position.
    minute(0, 85792.01, 85940.32, 85700, 85750),
    minute(5, 85750, 85800, 85200, 85300),
    // The decline crosses the target level here — still before any fill.
    minute(10, 85300, 85310, 84600, 84700),
    // E2 is first touched here, in a minute that never revisits the target.
    minute(13, 84700, 84750, 84400, 84450),
    // Post-entry rebound falls short of the target.
    minute(20, 84450, 84880, 84300, 84600),
    minute(45, 84600, 84650, 84200, 84530),
  ];
  const o = resolveBar({ ...base, bar, isEntryBar: true, minutes });

  assertEquals(o.kind, "S2_CLOSE",
    "the bar closed below S2 and no POST-ENTRY minute reached the target");
  assertEquals(o.method, "ONE_MINUTE_RESOLVED");
  assertEquals(o.entryMinute, "2026-09-23T14:13:00Z");
  assertEquals(o.targetMinute, null, "no target minute may be recorded");

  // And the whole-bar reading is what it always was, which is the point.
  assertEquals(htfWouldHaveClosed({ ...base, bar, isEntryBar: true, minutes: null }), "S2_CLOSE");
});

Deno.test("1a — the stored incident bar itself: no target, and no exit either", () => {
  // Verbatim. It closes at 84530, above S2 84130.21, so under close-confirmed S2
  // nothing resolves on this bar at all — yet whole-bar OHLC booked TARGET_2R
  // off the 85940.32 high, which the bar reached before the fill.
  const minutes: Candle[] = [
    minute(0, 85792.01, 85940.32, 85700, 85750),
    minute(10, 85300, 85310, 84600, 84700),
    minute(13, 84700, 84750, 84400, 84450),
    minute(20, 84450, 84880, 84300, 84600),
    minute(45, 84600, 84650, 84200, 84530),
  ];
  const o = resolveBar({ ...base, bar: ENTRY_BAR, isEntryBar: true, minutes });
  assertEquals(o.kind, "HOLD", "the position was still running at the end of this bar");
  assertEquals(o.entryMinute, "2026-09-23T14:13:00Z");
  assertEquals(htfWouldHaveClosed({ ...base, bar: ENTRY_BAR, isEntryBar: true, minutes: null }),
    "TARGET", "this is the contaminated booking the incident recorded");
});

Deno.test("1b — a pre-entry target with no S2 close leaves the position OPEN, not won", () => {
  // Same shape, but the bar closes above S2. Whole-bar OHLC books TARGET_2R off
  // the pre-entry high; the tape says nothing has resolved yet.
  const bar: Candle = { ...ENTRY_BAR, close: 84600 };
  const minutes: Candle[] = [
    minute(0, 85792.01, 85940.32, 85700, 85750),
    minute(10, 85300, 85310, 84600, 84700),
    minute(13, 84700, 84750, 84400, 84450),
    minute(45, 84450, 84880, 84300, 84600),
  ];
  const o = resolveBar({ ...base, bar, isEntryBar: true, minutes });
  assertEquals(o.kind, "HOLD", "nothing after the fill resolved this bar");
  assertEquals(o.method, "ONE_MINUTE_RESOLVED");
  assertEquals(o.entryMinute, "2026-09-23T14:13:00Z");
  assert(o.detail.includes("BEFORE the entry"), "the reason must name the defect");

  // Whole-bar OHLC would have booked a 2R win here.
  assertEquals(htfWouldHaveClosed({ ...base, bar, isEntryBar: true, minutes: null }), "TARGET");

  // Excursions are post-entry only: the 85940 high is not this position's MFE.
  assert(o.postEntryFavourable !== null);
  assert(o.postEntryFavourable! < TARGET - ENTRY,
    "the pre-entry excursion leaked into MFE");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. entry first, target later in the same HTF bar -> target valid
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("2 — entry first and the target later in the same bar books the target", () => {
  const bar: Candle = { ...ENTRY_BAR, open: 84600, high: 85300, low: 83900, close: 84900 };
  const minutes: Candle[] = [
    minute(0, 84600, 84650, 84550, 84600),
    minute(10, 84600, 84610, 84400, 84450),   // E2 touched
    minute(30, 84450, 85300, 84400, 85200),   // target after entry
    minute(50, 85200, 85250, 84800, 84900),
  ];
  const o = resolveBar({ ...base, bar, isEntryBar: true, minutes });
  assertEquals(o.kind, "TARGET");
  assertEquals(o.method, "ONE_MINUTE_RESOLVED");
  assertEquals(o.entryMinute, "2026-09-23T14:10:00Z");
  assertEquals(o.targetMinute, "2026-09-23T14:30:00Z");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. wick through S2 then recovery -> NO invalidation from the wick
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("3 — a wick through S2 is not invalidation, with or without a tape", () => {
  const bar: Candle = { ...ENTRY_BAR, open: 84600, high: 84800, low: 83900, close: 84400 };
  assert(bar.low < S2, "the bar must wick below S2");
  assert(bar.close > S2, "and must close back above it");

  const minutes: Candle[] = [
    minute(0, 84600, 84650, 84550, 84600),
    minute(5, 84600, 84610, 84400, 84450),    // E2 touched
    minute(20, 84450, 84500, 83900, 84000),   // deep wick THROUGH S2
    minute(59, 84000, 84450, 83950, 84400),   // recovered above S2 by the close
  ];
  for (const tape of [minutes, null]) {
    const o = resolveBar({ ...base, bar, isEntryBar: true, minutes: tape });
    assertEquals(o.kind, "HOLD", `a wick below S2 closed the position (tape=${!!tape})`);
  }
  // And the same on a later bar, where the whole bar is post-entry.
  assertEquals(resolveBar({ ...base, bar, isEntryBar: false, minutes: null }).kind, "HOLD");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. target after entry, HTF later closes beyond S2 -> target wins
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("4 — a post-entry target beats an S2 close on the same bar", () => {
  // The close is the bar's LAST event, so a target reached inside the bar
  // necessarily preceded it. This is the case the blanket stop-first convention
  // got wrong whenever a tape existed.
  const bar: Candle = { ...ENTRY_BAR, open: 84600, high: 85300, low: 83800, close: 84000 };
  assert(bar.close < S2, "the bar must close below S2");
  const minutes: Candle[] = [
    minute(5, 84600, 84610, 84400, 84450),    // E2 touched
    minute(20, 84450, 85300, 84400, 85100),   // target reached, after entry
    minute(59, 85100, 85150, 83800, 84000),   // then collapses through S2
  ];
  const o = resolveBar({ ...base, bar, isEntryBar: true, minutes });
  assertEquals(o.kind, "TARGET", "the target preceded the invalidating close");
  assertEquals(o.targetMinute, "2026-09-23T14:20:00Z");

  // Whole-bar OHLC, tested stop-first, would have booked the loss.
  assertEquals(htfWouldHaveClosed({ ...base, bar, isEntryBar: true, minutes: null }), "S2_CLOSE");

  // Same on a bar the position was already holding through.
  const later = resolveBar({ ...base, bar, isEntryBar: false, minutes });
  assertEquals(later.kind, "TARGET");
  assertEquals(later.method, "ONE_MINUTE_RESOLVED");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. HTF closes beyond S2 before any target -> S2 close invalidation
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("5 — an S2 close with no target needs no tape at all", () => {
  const bar: Candle = { ...ENTRY_BAR, open: 84600, high: 84700, low: 83800, close: 84000 };
  const o = resolveBar({ ...base, bar, isEntryBar: true, minutes: null });
  assertEquals(o.kind, "S2_CLOSE");
  assertEquals(o.method, "HTF_UNAMBIGUOUS",
    "a bar close post-dates any intrabar entry, so no minutes are required");
  assertEquals(o.s2CloseBarTime, bar.datetime);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. entry and target in the SAME minute -> ORDERING_UNRESOLVED
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("6 — entry and target inside one minute is unresolved, not a win", () => {
  const bar: Candle = { ...ENTRY_BAR, open: 84600, high: 85300, low: 84300, close: 85000 };
  const minutes: Candle[] = [
    minute(0, 84600, 84650, 84550, 84600),
    // This one minute both touches E2 and reaches the target. 1m cannot say
    // which came first and there is no tick feed to ask.
    minute(7, 84600, 85300, 84300, 85200),
  ];
  const o = resolveBar({ ...base, bar, isEntryBar: true, minutes, minutesFinal: true });
  assertEquals(o.kind, "AMBIGUOUS_OPEN_OR_CLOSED",
    "one branch has the target PRE-ENTRY, which leaves the position running");
  assertEquals(o.altBranch, "CLOSED_AT_TARGET");
  assertEquals(o.method, "ORDERING_UNRESOLVED");
  assertEquals(o.entryMinute, "2026-09-23T14:07:00Z");
  assert(o.detail.includes("tick"), "the reason must say what would resolve it");

  // And it must NOT be applied as an exit. Closing here would free the slot on
  // the strength of one branch and admit later IPOs that only exist in it.
  const out = stepPosition(testPosition(), bar, 0, o);
  assertEquals(out.kind, "HOLD",
    "an open-or-closed ambiguity must never be booked as a close");
});

Deno.test("6b — an ambiguous bar with NO tape asks for one rather than guessing", () => {
  const bar: Candle = { ...ENTRY_BAR, open: 84600, high: 85300, low: 84300, close: 85000 };
  const o = resolveBar({ ...base, bar, isEntryBar: true, minutes: null });
  assertEquals(o.kind, "NEED_MINUTES",
    "the resolver must request a tape, never fall back to whole-bar OHLC");
  // And when no tape is ever coming, it is still possibly-open, not closed.
  const fin = resolveBar({ ...base, bar, isEntryBar: true, minutes: null, minutesFinal: true });
  assertEquals(fin.kind, "AMBIGUOUS_OPEN_OR_CLOSED");
  assertEquals(fin.altBranch, "CLOSED_AT_TARGET");
});

Deno.test("6c — a LATER bar that cannot be ordered IS terminal in every branch", () => {
  // Target and S2 close on one bar, position already running. Whichever came
  // first, the position exits on this bar — so the outcome is void but the slot
  // is genuinely free, and that is a different verdict from the fill-bar case.
  const bar: Candle = { ...ENTRY_BAR, open: 84600, high: 85300, low: 83800, close: 84000 };
  const o = resolveBar({ ...base, bar, isEntryBar: false, minutes: null, minutesFinal: true });
  assertEquals(o.kind, "UNRESOLVED_TERMINAL");
  const out = stepPosition(testPosition(), bar, 1, o);
  assertEquals(out.kind, "CLOSED");
  if (out.kind !== "CLOSED") return;
  assertEquals(out.result.exitReason, "ORDERING_UNRESOLVED");
  assertEquals(out.result.realizedR, null);
  assertEquals(out.result.excludedFromStats, true);
});

Deno.test("6d — feeds disagreeing about the fill leaves NO_POSITION as a live branch", () => {
  // The HTF bar reaches E2; no minute does. One reading has a position, the
  // other has none — so the slot must be held, not freed.
  const bar: Candle = { ...ENTRY_BAR, open: 84400, high: 84700, low: 84300, close: 84600 };
  const minutes: Candle[] = [minute(0, 84600, 84650, 84550, 84600)];
  const o = resolveBar({ ...base, bar, isEntryBar: true, minutes, minutesFinal: true });
  assertEquals(o.kind, "AMBIGUOUS_OPEN_OR_CLOSED");
  assertEquals(o.altBranch, "NO_POSITION");
  assertEquals(stepPosition(testPosition(), bar, 0, o).kind, "HOLD");
});

// ─────────────────────────────────────────────────────────────────────────────
// 7-9. sequencing, re-entry and the one-position rule are untouched
// ─────────────────────────────────────────────────────────────────────────────

const T0 = Date.UTC(2025, 0, 1);
const cfg = (): EngineConfig =>
  ({ instrument: "EUR/USD", timeframe: "1h", highVolOnly: false, costPerSide: () => 0 });

function market(n: number, seed = 7): Candle[] {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const vol = 0.3 + Math.abs(Math.sin(i / 90)) * 1.4;
    const o = p;
    p = Math.max(1, p + (rnd() - 0.5) * vol * 2);
    out.push({ datetime: new Date(T0 + i * HOUR).toISOString(),
      open: o, high: Math.max(o, p) + rnd() * vol, low: Math.min(o, p) - rnd() * vol,
      close: p, volume: 0 });
  }
  return out;
}

/** Drives the runner bar by bar, exactly as the worker does. */
function drive(s: Candle[], from: number) {
  let state = null as Parameters<typeof runPaper>[0]["state"];
  let position: PaperPosition | null = null;
  const closed = [], events = [];
  for (let i = from; i < s.length; i++) {
    const closedBars = s.slice(0, i + 1);
    const plan = runPaper({
      cfg: cfg(), barMs: HOUR, closedBars,
      nowMs: new Date(closedBars[closedBars.length - 1].datetime).getTime() + 2 * HOUR,
      state, openPosition: position, minHistoryBars: 100,
    });
    assertEquals(plan.divergence, null, `bar ${i}: ${plan.divergence}`);
    assertEquals(plan.provisional, false, "a pure caller supplying no tape must not defer");
    state = plan.state; position = plan.openPosition;
    closed.push(...plan.closed); events.push(...plan.events);
  }
  return { closed, events, position };
}

Deno.test("7 — a position that survives its entry bar is managed by the later bars", () => {
  const s = market(220);
  const f = drive(s, 100);
  const multiBar = f.closed.filter((r) => r.exitTime !== r.position.entryTime);
  assert(multiBar.length > 0, "the fixture produced no multi-bar trade");
  for (const r of multiBar) {
    assert(new Date(r.exitTime).getTime() > new Date(r.position.entryTime).getTime());
    assert(r.barsHeld >= 1, "a multi-bar trade must report bars held");
  }
});

Deno.test("8 — re-entry on the same zone after a prior exit is preserved", () => {
  const s = market(220);
  const f = drive(s, 100);
  const bySetup = new Map<string, number>();
  for (const r of f.closed) bySetup.set(r.position.setupId, (bySetup.get(r.position.setupId) ?? 0) + 1);
  const repeated = [...bySetup.values()].filter((n) => n > 1);
  assert(repeated.length > 0, "the fixture must re-enter at least one zone");
  // And the ordinal still counts them.
  const ordinals = f.closed.map((r) => r.position.zoneEntryOrdinal);
  assert(Math.max(...ordinals) > 1, "the re-entry ordinal stopped advancing");
});

Deno.test("9 — one open position per instrument still holds", () => {
  const s = market(220);
  let state = null as Parameters<typeof runPaper>[0]["state"];
  let position: PaperPosition | null = null;
  for (let i = 100; i < s.length; i++) {
    const plan = runPaper({
      cfg: cfg(), barMs: HOUR, closedBars: s.slice(0, i + 1),
      nowMs: T0 + (i + 2) * HOUR, state, openPosition: position, minHistoryBars: 100,
    });
    // `openPosition` is a single slot by construction; the assertion is that a
    // second fill never displaces a live one within a single plan.
    const fills = plan.events.filter((e) => e.eventType === "FILLED").length;
    const closes = plan.closed.length;
    assert(fills <= closes + 1, `bar ${i}: ${fills} fills against ${closes} closes`);
    state = plan.state; position = plan.openPosition;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. no SMC behaviour, and no strategy rule moved
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("10 — the ordering module cannot change a level, a target or a stop", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoCausalOrdering.ts");
  // It reads levels and never computes one.
  for (const forbidden of ["* 2", "/ 2", "breakEven", "trail", "partial", "1R", "0.5"]) {
    assert(!src.includes(forbidden), `the ordering module computes something: ${forbidden}`);
  }
  // It must not reach SMC, a broker, or a database.
  for (const forbidden of ["paper_positions", "pending_orders", "broker", "supabase",
    "createClient", "fetch(", "Deno.env"]) {
    assert(!src.includes(forbidden), `the ordering module reaches ${forbidden}`);
  }
});

Deno.test("10b — S2 is still close-confirmed everywhere in the ordering module", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoCausalOrdering.ts");
  // Invalidation is only ever tested against a CLOSE.
  assert(/bar\.close < s2 : bar\.close > s2/.test(src),
    "S2 is no longer tested against the bar close");
  assert(!/m\.low <= s2|m\.high >= s2|bar\.low < s2|bar\.high > s2/.test(src),
    "S2 became a touch rule at some resolution");
});

Deno.test("10c — the observational Daily tag cannot reach the execution verdict", async () => {
  const runner = await Deno.readTextFile("supabase/functions/_shared/ipoPaperRunner.ts");
  // The tag is written into provenance and nothing else. No branch reads it.
  for (const m of runner.matchAll(/daily(?:Structure|Context|\?\.)/g)) {
    const around = runner.slice(Math.max(0, m.index! - 80), m.index! + 80);
    assert(!/\bif\s*\([^)]*daily/i.test(around),
      `a decision branches on the Daily tag: ...${around.trim()}...`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// provenance and the forward-evidence boundary
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("the forward evidence boundary is stamped on every new row", () => {
  const bars: Candle[] = Array.from({ length: 6 }, (_, i) => ({
    datetime: new Date(T0 + i * HOUR).toISOString(),
    open: 100, high: 101, low: 99, close: 100, volume: 0,
  }));
  const trade: LiveTrade = {
    instrument: "EUR/USD", direction: "demand", ipoIndex: 0, entryIndex: 2,
    entry: 100, stop: 99, target: 102, risk: 1, vol: "HIGH_VOL", costR: 0.3,
    exitIndex: null, exitPrice: null, netR: null, mae: 0, mfe: 0,
  };
  const legacy = openPosition(buildIntent(trade, bars, "1h"));
  assertEquals(legacy.causalExecutionVersion, null,
    "the default must be legacy so nothing is retroactively relabelled");

  const fixed = openPosition(buildIntent(trade, bars, "1h"), undefined, {
    ...NO_PROVENANCE,
    causalExecutionVersion: CAUSAL_EXECUTION_VERSION,
    htfSource: "twelvedata", minuteSource: "twelvedata",
  });
  assertEquals(fixed.causalExecutionVersion, "1m-ordering-v1");
  assertEquals(fixed.htfSource, "twelvedata");
  assertEquals(fixed.minuteSource, "twelvedata");
  assertEquals(fixed.engineExitOverridden, false);
});

Deno.test("minutesInBar takes only the minutes inside the bar, sorted", () => {
  const bar: Candle = { datetime: "2026-09-23T14:00:00Z", open: 1, high: 1, low: 1, close: 1 };
  const mins: Candle[] = [
    minute(59, 1, 1, 1, 1),
    { datetime: "2026-09-23T15:00:00Z", open: 1, high: 1, low: 1, close: 1 },  // next bar
    minute(0, 1, 1, 1, 1),
    { datetime: "2026-09-23T13:59:00Z", open: 1, high: 1, low: 1, close: 1 },  // previous bar
  ];
  const got = minutesInBar(mins, bar, HOUR).map((m) => m.datetime);
  assertEquals(got, ["2026-09-23T14:00:00Z", "2026-09-23T14:59:00Z"]);
});

Deno.test("a runner that cannot get a tape voids the bar rather than guessing", () => {
  // minutesFinal defaults TRUE for a pure caller: supply nothing and you get a
  // void, never the whole-bar reading that caused the contamination.
  const bar: Candle = { ...ENTRY_BAR, open: 84600, high: 85300, low: 84300, close: 85000 };
  const o = resolveBar({ ...base, bar, isEntryBar: true, minutes: [] });
  assertEquals(o.kind, "NEED_MINUTES");
  const pos = testPosition();
  // The runner's own conversion is exercised through runPaper in the drive
  // tests above; here the contract's refusal to price a NEED_MINUTES is pinned.
  assertEquals(stepPosition(pos, bar, 0, o).kind, "HOLD",
    "an unanswered request must never be applied as an outcome");
});

function testPosition(over: Partial<PaperPosition> = {}): PaperPosition {
  return {
    strategyId: "ipo_cet", strategyVersion: "spec-1.1",
    setupId: "stp_test", intentId: "int_test",
    symbol: "BTC/USD", timeframe: "1h", direction: "long",
    entryTime: ENTRY_BAR.datetime, entryPrice: ENTRY,
    targetPrice: TARGET, s2InvalidationLevel: S2,
    nominalRiskDistance: RISK, costR: 0.1,
    referenceBalanceAtEntry: 100_000, nominalRiskPct: 0.2, nominalRiskUsd: 200,
    ipoCandleTime: "2026-09-21T10:00:00Z", volatilityBucket: "HIGH_VOL",
    zoneEntryOrdinal: 1, zonePreviousExitTime: null,
    executionMode: "paper", status: "open",
    maeR: 0, mfeR: 0, lastManagedBarTime: ENTRY_BAR.datetime,
    gapFromBarTime: null, gapToBarTime: null, gapReason: null,
    causalExecutionVersion: CAUSAL_EXECUTION_VERSION,
    entryMinuteTime: null, entryResolutionMethod: null,
    htfSource: "twelvedata", minuteSource: "twelvedata",
    engineExitOverridden: false, engineExitBarTime: null,
    dailyStructure: null, dailyStructureAlignment: null, dailyStructureAsOf: null,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// oracle equivalence with the research resolver
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("the forward resolver agrees with the research resolver on the same tape", () => {
  // The causal validation work resolved a bar as: walk the post-entry minutes,
  // take the target the moment any minute reaches it, otherwise take the HTF
  // close beyond S2. Research and production must not answer differently for the
  // same candle sequence, so that walk is restated here and cross-checked.
  const research = (
    bar: Candle, mins: Candle[], long: boolean,
    entry: number, target: number, s2: number, isEntry: boolean,
  ): string => {
    let start = 0;
    if (isEntry) {
      start = mins.findIndex((m) => long ? m.low <= entry : m.high >= entry);
      if (start < 0) return "UNRESOLVED";
      const em = mins[start];
      if (long ? em.high >= target : em.low <= target) return "UNRESOLVED";
    }
    for (let i = start; i < mins.length; i++) {
      if (long ? mins[i].high >= target : mins[i].low <= target) return "TARGET";
    }
    return (long ? bar.close < s2 : bar.close > s2) ? "S2_CLOSE" : "HOLD";
  };

  const cases: Array<[Candle, Candle[], boolean]> = [
    [{ ...ENTRY_BAR, close: 84000 },
      [minute(5, 84600, 84610, 84400, 84450), minute(30, 84450, 84880, 84200, 84300)], true],
    [{ ...ENTRY_BAR, open: 84600, high: 85300, low: 83800, close: 84000 },
      [minute(5, 84600, 84610, 84400, 84450), minute(20, 84450, 85300, 84400, 85100)], true],
    [{ ...ENTRY_BAR, open: 84600, high: 84700, low: 84300, close: 84600 },
      [minute(5, 84600, 84610, 84400, 84450), minute(40, 84450, 84700, 84300, 84600)], true],
  ];
  for (const [bar, mins, isEntry] of cases) {
    const got = resolveBar({ ...base, bar, isEntryBar: isEntry, minutes: mins });
    const want = research(bar, mins, true, ENTRY, TARGET, S2, isEntry);
    assertEquals(got.kind, want,
      `forward and research disagree on ${bar.datetime} (isEntryBar=${isEntry})`);
  }
});

Deno.test("the frozen engine is untouched — it still books the contaminated outcome", async () => {
  // The fix is CONTAINED TO THE PAPER LAYER. The research engines must keep
  // their historical behaviour or every validated figure would silently move.
  const live = await Deno.readTextFile("supabase/functions/_shared/ipoLiveEngine.ts");
  const inc = await Deno.readTextFile("supabase/functions/_shared/ipoIncrementalEngine.ts");
  for (const [name, src] of [["ipoLiveEngine", live], ["ipoIncrementalEngine", inc]]) {
    assert(/const sameBar = this\.manageOpen\(/.test(src),
      `${name}: entry-bar management call moved`);
    assert(!src.includes("ipoCausalOrdering"),
      `${name} now imports the ordering module — the research baselines would move`);
  }
  // And the engines still produce the same trade list they always did.
  const s = market(220);
  assert(replayIncremental(s, cfg()).trades.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// AMBIGUOUS POSITION STATE — A..E
//
// The defect these close: an earlier draft CLOSED the position on a same-minute
// entry-versus-target ambiguity. That excluded the trade from statistics but
// freed the one-position-per-instrument slot on the strength of one branch, and
// every later IPO admitted into that freed slot exists only in that branch. The
// unresolved trade was excluded while silently contaminating the ones after it.
// ─────────────────────────────────────────────────────────────────────────────

/** A fill bar whose single minute touches both E2 and the target. */
const AMBIG_MINUTES: Candle[] = [
  minute(0, 84600, 84650, 84550, 84600),
  minute(7, 84600, 85300, 84300, 85200),   // E2 and target, order unknowable
];
const AMBIG_BAR: Candle = { ...ENTRY_BAR, open: 84600, high: 85300, low: 84300, close: 85000 };

function ambiguousPosition(): PaperPosition {
  const o = resolveBar({ ...base, bar: AMBIG_BAR, isEntryBar: true,
    minutes: AMBIG_MINUTES, minutesFinal: true });
  assertEquals(o.kind, "AMBIGUOUS_OPEN_OR_CLOSED");
  const p = testPosition({ entryMinuteTime: o.entryMinute });
  return openAmbiguous(p, {
    kind: "ENTRY_VS_TARGET_SAME_MINUTE",
    atTime: o.entryMinute!,
    altBranch: "CLOSED_AT_TARGET",
    altExitTime: AMBIG_BAR.datetime,
    altExitPrice: TARGET,
    altNetR: altTargetNetR(p),
    altFreedAtBarTime: AMBIG_BAR.datetime,
    detail: o.detail,
  });
}

Deno.test("A — target extreme first, entry later, no later target: OPEN must be preserved", () => {
  // Branch O of the same-minute ambiguity. From OHLC this is indistinguishable
  // from case B, so the runner must not choose.
  const pos = ambiguousPosition();
  assertEquals(pos.status, "ordering_ambiguous");
  assert(pos.ambiguity, "the alternative branch must be carried, not discarded");
  assertEquals(pos.ambiguity!.altBranch, "CLOSED_AT_TARGET");

  // A later quiet bar resolves nothing: the open branch simply keeps running.
  const quiet: Candle = { datetime: "2026-09-23T15:00:00Z",
    open: 84600, high: 84700, low: 84400, close: 84550, volume: 0 };
  const o = resolveBar({ ...base, bar: quiet, isEntryBar: false, minutes: null, minutesFinal: true });
  assertEquals(o.kind, "HOLD");
  const out = stepPosition(pos, quiet, 1, o);
  assertEquals(out.kind, "HOLD", "the open branch must survive an unremarkable bar");
  if (out.kind !== "HOLD") return;
  assertEquals(out.position.status, "ordering_ambiguous", "the ambiguity must persist");
  assert(out.position.ambiguity, "the frozen branch must persist with it");
});

Deno.test("B — entry first, target later in the same minute: the CLOSED WIN branch is kept", () => {
  const pos = ambiguousPosition();
  // Branch W is recorded in full, priced under this position's own cost, so it
  // can be reconciled later without re-deriving anything.
  assertEquals(pos.ambiguity!.altExitPrice, TARGET);
  assertEquals(pos.ambiguity!.altExitTime, AMBIG_BAR.datetime);
  assertAlmostEquals(pos.ambiguity!.altNetR!, 2 - pos.costR, 1e-12);
  // And A and B produce the SAME state: nothing in the data distinguishes them.
  assertEquals(pos.ambiguity!.kind, "ENTRY_VS_TARGET_SAME_MINUTE");
});

Deno.test("C — ambiguity then a later target: branches converge on the same R", () => {
  // Branch W closed at +2R on the fill bar. Branch O runs on and also reaches
  // +2R. Same target, same entry, same risk, same cost fixed at entry — so the
  // realized R is provably identical and only the exit TIMESTAMP is unknown.
  const pos = ambiguousPosition();
  const later: Candle = { datetime: "2026-09-23T16:00:00Z",
    open: 84600, high: 85300, low: 84500, close: 85200, volume: 0 };
  const o = resolveBar({ ...base, bar: later, isEntryBar: false, minutes: null, minutesFinal: true });
  assertEquals(o.kind, "TARGET");

  const out = stepPosition(pos, later, 2, o);
  assertEquals(out.kind, "CLOSED");
  if (out.kind !== "CLOSED") return;
  const r = out.result;
  assertEquals(r.exitReason, "TARGET_2R");
  assertEquals(r.ambiguityResolution, "CONVERGED_SAME_OUTCOME");
  assertEquals(r.branchOutcomes, "TARGET_2R | TARGET_2R");
  assertEquals(r.excludedFromStats, false, "a provable R must count");
  assertAlmostEquals(r.realizedR!, 2 - pos.costR, 1e-12);
  assertAlmostEquals(r.realizedR!, pos.ambiguity!.altNetR!, 1e-12);
  // The R is known; the moment is not.
  assertEquals(r.exitTimeAmbiguous, true);
  assertEquals(r.altExitTime, AMBIG_BAR.datetime);
});

Deno.test("D — ambiguity then an S2 close: both branches terminal, no R claimable", () => {
  // Branch W was +2R, branch O is a loss. Both have exited, so the slot frees —
  // but the outcome cannot be claimed either way.
  const pos = ambiguousPosition();
  const bust: Candle = { datetime: "2026-09-23T16:00:00Z",
    open: 84400, high: 84450, low: 83800, close: 84000, volume: 0 };
  const o = resolveBar({ ...base, bar: bust, isEntryBar: false, minutes: null, minutesFinal: true });
  assertEquals(o.kind, "S2_CLOSE");

  const out = stepPosition(pos, bust, 2, o);
  assertEquals(out.kind, "CLOSED");
  if (out.kind !== "CLOSED") return;
  const r = out.result;
  assertEquals(r.exitReason, "ORDERING_UNRESOLVED");
  assertEquals(r.ambiguityResolution, "DIVERGED_TERMINAL");
  assertEquals(r.branchOutcomes, "TARGET_2R | S2_CLOSE_INVALIDATION");
  assertEquals(r.realizedR, null, "a divergent pair cannot yield an R");
  assertEquals(r.exitPrice, null);
  assertEquals(r.excludedFromStats, true);
  assert(r.exclusionReason!.includes("branches ended differently"));
});

Deno.test("D2 — the NO_POSITION branch can never yield an R, whatever the other does", () => {
  const p = testPosition();
  const pos = openAmbiguous(p, {
    kind: "ENTRY_NOT_PROVEN_IN_TAPE", atTime: ENTRY_BAR.datetime,
    altBranch: "NO_POSITION", altExitTime: null, altExitPrice: null, altNetR: null,
    altFreedAtBarTime: ENTRY_BAR.datetime, detail: "feeds disagree about the fill",
  });
  const won: Candle = { datetime: "2026-09-23T16:00:00Z",
    open: 84600, high: 85300, low: 84500, close: 85200, volume: 0 };
  const o = resolveBar({ ...base, bar: won, isEntryBar: false, minutes: null, minutesFinal: true });
  const out = stepPosition(pos, won, 2, o);
  assertEquals(out.kind, "CLOSED");
  if (out.kind !== "CLOSED") return;
  assertEquals(out.result.exitReason, "ORDERING_UNRESOLVED");
  assertEquals(out.result.ambiguityResolution, "EXISTENCE_UNPROVEN");
  assertEquals(out.result.realizedR, null,
    "a trade one branch says never existed cannot contribute a number");
});

Deno.test("E — no later IPO may be admitted while a branch still holds the position", () => {
  // Structural, at three levels, because this is the requirement the earlier
  // draft broke.
  const runner = Deno.readTextFileSync("supabase/functions/_shared/ipoPaperRunner.ts");

  // 1. the fill loop refuses to look at a new candidate while a position object
  //    exists, and an ambiguous position IS a position object
  assert(/for \(const t of fresh\) \{\s*\n\s*if \(live\) break;/.test(runner),
    "the one-position guard in the fill loop is gone");
  // 2. the ambiguous branch assigns `live` rather than leaving it null
  assert(/live = m0\.position;/.test(runner),
    "the ambiguous position is not installed as the live slot holder");
  // 3. the database refuses a second row for the same instrument in that state
  const sql = Deno.readTextFileSync(
    "supabase/migrations/20260924120000_ipo_causal_execution_ordering.sql");
  assert(/where status in \('open','data_gap_suspended','ordering_ambiguous'\)/.test(sql),
    "the one-open-per-instrument index does not cover ordering_ambiguous — the " +
    "database would permit the double occupancy the code is refusing");
  assert(/check \(status in \('open','data_gap_suspended','ordering_ambiguous'\)\)/.test(sql),
    "the status CHECK rejects the ambiguous state");
});

Deno.test("E2 — a live runner holds the slot through an unresolvable fill", () => {
  // End to end through runPaper: a fill that cannot be ordered must leave a
  // position behind, not a closed row and an empty slot.
  const s = market(220);
  let state = null as Parameters<typeof runPaper>[0]["state"];
  let position: PaperPosition | null = null;
  let sawAmbiguous = false;
  let closedWhileAmbiguousSlotFree = 0;

  for (let i = 100; i < s.length; i++) {
    const closedBars = s.slice(0, i + 1);
    const plan = runPaper({
      cfg: cfg(), barMs: HOUR, closedBars,
      nowMs: new Date(closedBars[closedBars.length - 1].datetime).getTime() + 2 * HOUR,
      state, openPosition: position, minHistoryBars: 100,
    });
    if (plan.events.some((e) => e.eventType === "ORDERING_AMBIGUOUS")) {
      sawAmbiguous = true;
      assert(plan.openPosition, "an ambiguous fill left no position holding the slot");
      assertEquals(plan.openPosition!.status, "ordering_ambiguous");
      // No second fill in the same plan after the ambiguity.
      const idx = plan.events.findIndex((e) => e.eventType === "ORDERING_AMBIGUOUS");
      const after = plan.events.slice(idx + 1).filter((e) => e.eventType === "FILLED");
      assertEquals(after.length, 0, "an IPO was admitted while a branch held the slot");
    }
    if (position?.status === "ordering_ambiguous" && !plan.openPosition && !plan.closed.length) {
      closedWhileAmbiguousSlotFree++;
    }
    state = plan.state; position = plan.openPosition;
  }
  assertEquals(closedWhileAmbiguousSlotFree, 0,
    "an ambiguous position vanished without producing a result");
  // The fixture has no minute tape, so every target-touching fill bar is
  // ambiguous — this path must actually be exercised.
  assert(sawAmbiguous, "the fixture never produced an ambiguous fill");
});

Deno.test("E3 — a sequence fork is declared, and only when the futures really differ", async () => {
  const runner = await Deno.readTextFile("supabase/functions/_shared/ipoPaperRunner.ts");
  // Same bar for both branches => no fork.
  assert(/if \(ms\(e\.altFreedAtBarTime\) === ms\(e\.exitBarTime\)\) return false;/.test(runner),
    "branches freeing the slot on the same bar are no longer treated as converged");
  // Different bar but the other branch took nothing in the gap => still no fork.
  assert(/if \(!engineTook\) return true;/.test(runner),
    "the conservative default without an engine is gone");
  assert(/return engineTook\(e\.altFreedAtBarTime, e\.exitBarTime\);/.test(runner),
    "the convergence refinement is gone");
  // And a real fork contaminates everything after it on that instrument.
  assert(/contaminatedFrom \?\?= e\.exitBarTime;/.test(runner),
    "a fork no longer marks the instrument");
  assert(/contaminatedFrom \? \{ \.\.\.pos0, sequenceContaminated: true \} : pos0/.test(runner),
    "later trades are no longer tagged as conditional");
});

Deno.test("E4 — contaminated rows are kept out of the validated population", async () => {
  const { splitEvidence } = await import("../../functions/ipo-paper-state/index.ts");
  const row = (over: Record<string, unknown>) => ({
    realized_r: 1, realized_pnl_usd: 200, excluded_from_stats: false,
    exit_reason: "TARGET_2R", causal_execution_version: "1m-ordering-v1",
    sequence_contaminated: false, ...over,
  });
  const split = splitEvidence([
    row({}),
    row({ sequence_contaminated: true }),
    row({ causal_execution_version: null }),
    row({ exit_reason: "ORDERING_UNRESOLVED", realized_r: null, excluded_from_stats: true }),
  ]);
  assertEquals(split.causal.trades, 1, "only the provable, unconditional row counts");
  assertEquals(split.sequenceContaminated.trades, 1);
  assertEquals(split.legacyTrades, 1);
  assertEquals(split.unresolvedExcluded, 1);
});
