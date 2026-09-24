import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  runPaper, MIN_HISTORY_BARS, DEFAULT_GAP_POLICY,
  type PaperEvent, type RuntimeState,
} from "../../functions/_shared/ipoPaperRunner.ts";
import { replayIncremental, IncrementalEngine } from "../../functions/_shared/ipoIncrementalEngine.ts";
import {
  exportState, serializeState, restoreState, continuityCheck, type ExportMeta,
} from "../../functions/_shared/ipoEngineState.ts";
import type { PaperPosition, PaperResult } from "../../functions/_shared/ipoPaperContract.ts";
import type { EngineConfig } from "../../functions/_shared/ipoLiveEngine.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const T0 = Date.UTC(2025, 0, 1);
const BAR_MS = 3_600_000;

/**
 * Fixture scale. A rebuild is superlinear (~0.4s at 300 bars, ~4s at 700), and a
 * bar-by-bar forward run is one rebuild PER BAR — the same quadratic cost the
 * oracle has. 220 bars keeps the honest per-bar drive affordable; the volatility
 * warmup is lowered to match, which leaves the bucket UNCLASSIFIED and is why
 * the gated instrument is tested separately at full scale.
 */
const N = 220;
const WARMUP = 100;

const bar = (i: number, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime: new Date(T0 + i * BAR_MS).toISOString(),
     open: o, high: h, low: l, close: c, volume: 0 } as Candle);

const cfg = (over: Partial<EngineConfig> = {}): EngineConfig =>
  ({ instrument: "EUR/USD", timeframe: "1h", highVolOnly: false, costPerSide: () => 0, ...over });

/** Same seeded walk the engine tests use, so the fixture is known to trade. */
function market(n: number, seed = 7): Candle[] {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const vol = 0.3 + Math.abs(Math.sin(i / 90)) * 1.4;
    const o = p;
    p = Math.max(1, p + (rnd() - 0.5) * vol * 2);
    out.push(bar(i, o, Math.max(o, p) + rnd() * vol, Math.min(o, p) - rnd() * vol, p));
  }
  return out;
}

/**
 * A deterministic 1-minute tape for a bar series.
 *
 * Four point-minutes per bar walking open -> first extreme -> second extreme ->
 * close, with the extremes ordered by the bar's direction: an up bar dips to its
 * low first, a down bar spikes to its high first. That is the ordinary
 * convention, it preserves both extremes exactly, and — crucially — it gives the
 * causal resolver something to order with, so these fixtures exercise the
 * RESOLVED path instead of collapsing every fill into an ambiguity.
 *
 * Point minutes (o=h=l=c) are deliberate: two prices can never fall inside one
 * minute, so the same-minute ambiguity is tested on its own fixtures rather than
 * contaminating every equivalence assertion here.
 */
function minutesFor(bars: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const b of bars) {
    const t0 = new Date(b.datetime).getTime();
    const up = b.close >= b.open;
    const path = [b.open, up ? b.low : b.high, up ? b.high : b.low, b.close];
    path.forEach((px, i) => {
      out.push({
        datetime: new Date(t0 + i * 15 * 60_000).toISOString(),
        open: px, high: px, low: px, close: px, volume: 0,
      });
    });
  }
  return out;
}

/** Wall clock two bars after the newest closed bar — a healthy, current feed. */
const liveClock = (bars: Candle[]) =>
  new Date(bars[bars.length - 1].datetime).getTime() + 2 * BAR_MS;

interface Driven {
  closed: PaperResult[];
  events: PaperEvent[];
  state: RuntimeState | null;
  position: PaperPosition | null;
}

/** Drives the runner over a list of poll points, carrying persisted state. */
function drive(
  s: Candle[], c: EngineConfig, polls: number[],
  opts: {
    clock?: (b: Candle[]) => number;
    account?: Parameters<typeof runPaper>[0]["accountDecision"];
    /** Pass false to drive with NO tape, which makes every touched fill ambiguous. */
    minutes?: false;
  } = {},
): Driven {
  const clock = opts.clock ?? liveClock;
  let state: RuntimeState | null = null;
  let position: PaperPosition | null = null;
  const closed: PaperResult[] = [];
  const events: PaperEvent[] = [];

  for (const i of polls) {
    const closedBars = s.slice(0, i + 1);
    const plan = runPaper({
      cfg: c, barMs: BAR_MS, closedBars, nowMs: clock(closedBars),
      state, openPosition: position, minHistoryBars: WARMUP,
      accountDecision: opts.account,
      minuteBars: opts.minutes === false ? undefined : minutesFor(closedBars),
    });
    assertEquals(plan.divergence, null, `bar ${i}: ${plan.divergence}`);
    state = plan.state;
    position = plan.openPosition;
    closed.push(...plan.closed);
    events.push(...plan.events);
  }
  return { closed, events, state, position };
}

const everyBar = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** One honest bar-by-bar run, shared by the tests that need it. */
let _perBar: Driven | null = null;
const perBar = () => (_perBar ??= drive(market(N), cfg(), everyBar(WARMUP, N - 1)));

// ── the central equivalence claim ────────────────────────────────────────────

Deno.test("paper takes a subset of the engine's trades and matches it wherever ordering is provable", () => {
  // THE CLAIM CHANGED WITH THE CAUSAL-ORDERING FIX, AND IT CHANGED IN TWO WAYS.
  //
  // 1. Paper never invents a trade. Every paper entry is an engine entry.
  // 2. Paper may take FEWER. The engine reads whole-bar OHLC, so on a fill bar
  //    it can book a target whose excursion preceded the entry; the tape refuses
  //    that exit, the position stays open, and the slot stays held — so the
  //    later trade the engine took does not exist for paper. That is the
  //    correction, and it makes the old "identical trade list" claim false.
  //
  // What remains assertable, and is asserted: on every trade whose bars ordered
  // themselves without help, paper and engine agree exactly.
  const s = market(N);
  const f = perBar();

  const engineTrades = replayIncremental(s, cfg()).trades
    .filter((t) => t.entryIndex > WARMUP - 1 && t.exitIndex !== null);
  const byEntry = new Map(engineTrades.map((t) => [s[t.entryIndex].datetime, t]));

  assert(f.closed.length > 0, "the fixture produced no closed paper trades");
  assert(f.closed.length <= engineTrades.length + 1,
    "paper took MORE trades than the engine — it can only ever take a subset");

  let strict = 0, explained = 0;
  for (const p of f.closed) {
    const e = byEntry.get(p.position.entryTime);
    assert(e, `paper invented a trade at ${p.position.entryTime} the engine never took`);

    // The durable markers live on the POSITION: an override or an ambiguity on
    // the FILL bar is what moves a trade off the engine's path, and the result
    // of a later bar cannot see it. Reading only the result silently classified
    // overridden trades as untouched.
    // An override or an ambiguity is what moves a trade off the engine's path.
    // Merely CONSULTING the tape does not: if it confirms the whole-bar reading,
    // the outcome is identical. (Excursions are the exception — see below.)
    const untouched = p.position.engineExitOverridden === false &&
      p.position.ambiguity === null &&
      p.ambiguityKind === null && p.htfWouldHaveBooked === null;
    if (!untouched) {
      // Anything that differs must SAY why — an ordering method, an ambiguity,
      // or an explicit override. Silent divergence is the failure mode.
      assert(p.exitResolutionMethod !== null || p.ambiguityKind !== null ||
        p.position.engineExitOverridden,
        `trade at ${p.position.entryTime} differs from the engine with no recorded reason`);
      explained++;
      continue;
    }
    strict++;
    assertEquals(p.exitTime, s[e!.exitIndex!].datetime, "exit bar");
    assertEquals(p.exitPrice, e!.exitPrice, "exit price");
    assertEquals(p.position.entryPrice, e!.entry, "entry price");
    assert(Math.abs(p.realizedR! - e!.netR!) < 1e-9,
      `realized R: paper ${p.realizedR} vs engine ${e!.netR}`);
    // Excursions match only when the fill bar was NOT read from the tape: once
    // it is, MAE and MFE are post-entry only and a pre-entry extreme that the
    // engine counted is correctly no longer this position's.
    if (p.position.entryResolutionMethod === "HTF_UNAMBIGUOUS") {
      assert(Math.abs(p.maeR - e!.mae) < 1e-9, "MAE");
      assert(Math.abs(p.mfeR - e!.mfe) < 1e-9, "MFE");
    }
  }
  assert(strict > 0,
    `no trade was provable without help (${explained} explained) — the equivalence claim is untested`);
});

Deno.test("a same-bar engine trade is never silently dropped", () => {
  // The frozen engine manages the entry bar it fills on. A runner that resumed
  // from the bar AFTER entry would turn those into phantom open positions.
  //
  // Under causal ordering there is a second correct answer: the tape may show
  // the engine's same-bar exit came from a PRE-ENTRY extreme, in which case the
  // position is still running. So the requirement is not "closed on that bar",
  // it is "accounted for" — closed, or held with the reason recorded.
  const s = market(N);
  const sameBar = replayIncremental(s, cfg()).trades
    .filter((t) => t.entryIndex === t.exitIndex && t.entryIndex >= WARMUP);
  assert(sameBar.length > 0, "the fixture must contain a same-bar trade");

  const f = perBar();
  for (const t of sameBar) {
    const at = s[t.entryIndex].datetime;
    const rec = f.closed.find((c) => c.position.entryTime === at);
    const carried = f.events.some((e) =>
      (e.eventType === "CAUSAL_OVERRIDE" || e.eventType === "ORDERING_AMBIGUOUS") &&
      e.barTime === at);
    if (rec && !carried) {
      assertEquals(rec.exitTime, s[t.exitIndex!].datetime,
        "an unexplained same-bar close must be recorded on its own bar");
      continue;
    }
    // Either it was carried past its bar, or it is missing — and only the first
    // is acceptable. The carry must be visible in the audit trail, not inferred.
    assert(carried,
      `same-bar trade at ${t.entryIndex} was neither closed on its bar nor explained`);
  }
});

Deno.test("a volatility-gated instrument reproduces exactly at full warmup", () => {
  // Full scale, few polls: highVolOnly needs the real 200-bar warmup to classify.
  const s = market(700, 42);
  const c = cfg({ instrument: "BTC/USD", highVolOnly: true, costPerSide: (p) => p * 0.0015 });
  let state: RuntimeState | null = null;
  let position: PaperPosition | null = null;
  const closed: PaperResult[] = [];
  for (const i of [400, 550, 699]) {
    const bars = s.slice(0, i + 1);
    const plan = runPaper({ cfg: c, barMs: BAR_MS, closedBars: bars, nowMs: liveClock(bars),
      state, openPosition: position });
    assertEquals(plan.divergence, null);
    state = plan.state; position = plan.openPosition;
    closed.push(...plan.closed);
  }
  const expected = replayIncremental(s, c).trades
    .filter((t) => t.entryIndex > 400 && t.exitIndex !== null && t.costR <= 2);
  // Paper takes a SUBSET once causal ordering can hold a position the engine
  // released. What must still hold is that the VOLATILITY GATE is unchanged:
  // every paper trade is an engine trade, and none was taken outside HIGH_VOL.
  assert(closed.length > 0, "the gated fixture produced no trades");
  assert(closed.length <= expected.length, "paper took MORE gated trades than the engine");
  const engineEntries = new Set(expected.map((t) => s[t.entryIndex].datetime));
  for (const p of closed) {
    assert(engineEntries.has(p.position.entryTime),
      `paper invented a gated trade at ${p.position.entryTime}`);
    assertEquals(p.position.volatilityBucket, "HIGH_VOL",
      "the volatility gate admitted a non-HIGH_VOL bucket");
  }
});

Deno.test("equivalence holds across many independent windows, not one lucky fixture", () => {
  // One seed proving equivalence proves very little. Each of these is a
  // different market with a different set of contractions, entries and exits.
  let total = 0, resolvedTotal = 0, voidedTotal = 0;
  for (const seed of [7, 42, 11, 3, 5, 99, 123]) {
    const s = market(N, seed);
    const c = cfg();
    const f = drive(s, c, [WARMUP, 150, 185, N - 1]);
    const expected = replayIncremental(s, c).trades
      .filter((t) => t.entryIndex > WARMUP - 1 && t.exitIndex !== null);
    assert(f.closed.length <= expected.length + 1, `seed ${seed}: paper took MORE than the engine`);
    for (const t of expected) {
      const p = f.closed.find((x) => x.position.entryTime === s[t.entryIndex].datetime);
      // Paper takes a SUBSET: a trade the engine took may not exist for paper,
      // because an earlier override was still holding the slot.
      if (!p) { voidedTotal++; continue; }
      // Population and exit bar always agree. The R agrees wherever the bars
      // could order the events; where they could not, the observation is void
      // rather than borrowed from the engine's whole-bar reading.
      if (p!.exitReason === "ORDERING_UNRESOLVED") {
        assertEquals(p!.realizedR, null, `seed ${seed}: void trade must carry no R`);
        voidedTotal++;
        continue;
      }
      if (p!.position.engineExitOverridden || p!.position.ambiguity) {
        voidedTotal++;   // explained divergence, not an equivalence failure
        continue;
      }
      assertEquals(p!.exitTime, s[t.exitIndex!].datetime, `seed ${seed}: exit bar`);
      assert(Math.abs(p!.realizedR! - t.netR!) < 1e-9, `seed ${seed}: realized R`);
      resolvedTotal++;
    }
    total += expected.length;
  }
  assert(total >= 30, `only ${total} trades across all windows`);
  assert(resolvedTotal >= voidedTotal,
    `${voidedTotal} voided against ${resolvedTotal} resolved across all windows — ` +
    `too little remains checkable for this to be an equivalence test`);
});

Deno.test("the warm path decides exactly what the rebuild path decides", () => {
  // The worker loop, simulated: restore from bytes, prove the overlap, append
  // only the new bars, plan, persist. Its output must be indistinguishable from
  // rebuilding the engine every invocation.
  const s = market(N);
  const c = cfg();
  const meta: ExportMeta = { strategyVersion: "spec-1.1", costModelId: "fx_fixed_0.00008" };

  let state: RuntimeState | null = null;
  let position: PaperPosition | null = null;
  let engineJson: string | null = null;
  let rebuilds = 0;
  const closed: PaperResult[] = [];
  const events: PaperEvent[] = [];

  for (let i = WARMUP; i < N; i++) {
    const page = s.slice(0, i + 1);
    let engine: IncrementalEngine | null = null;

    const restored = restoreState(engineJson, c, meta);
    if (restored.ok) {
      const cont = continuityCheck(restored.state, page);
      if (cont.ok) {
        engine = restored.engine;
        for (const b of cont.append) engine.feed(b);
      }
    }
    if (!engine) {
      rebuilds++;
      engine = new IncrementalEngine(c);
      for (const b of page) engine.feed(b);
    }

    const plan = runPaper({
      cfg: c, barMs: BAR_MS, closedBars: page, nowMs: liveClock(page),
      state, openPosition: position, minHistoryBars: WARMUP,
    minuteBars: minutesFor(page), warmEngine: engine,
    });
    assertEquals(plan.divergence, null, `bar ${i}: ${plan.divergence}`);
    state = plan.state;
    position = plan.openPosition;
    closed.push(...plan.closed);
    events.push(...plan.events);
    engineJson = serializeState(exportState(engine, c, meta));
  }

  assertEquals(rebuilds, 1, "only the very first invocation may rebuild");
  const cold = perBar();
  assertEquals(closed.map((x) => x.position.entryTime), cold.closed.map((x) => x.position.entryTime));
  assertEquals(closed.map((x) => x.realizedR), cold.closed.map((x) => x.realizedR));
  assertEquals(closed.map((x) => x.exitTime), cold.closed.map((x) => x.exitTime));
  assertEquals(JSON.stringify(events), JSON.stringify(cold.events), "audit trail");
  assertEquals(JSON.stringify(position), JSON.stringify(cold.position), "final position");
});

Deno.test("polling less often does not change which trades were taken", () => {
  // A worker that missed several cycles must still record the trades that both
  // opened and closed inside the gap between its runs.
  const s = market(N);
  const sparse = drive(s, cfg(), [WARMUP, 140, 175, N - 1]);
  assertEquals(
    sparse.closed.map((c) => c.position.entryTime),
    perBar().closed.map((c) => c.position.entryTime),
  );
  assertEquals(
    sparse.closed.map((c) => c.realizedR),
    perBar().closed.map((c) => c.realizedR),
  );
});

// ── activation ───────────────────────────────────────────────────────────────

Deno.test("activation records nothing historical", () => {
  const s = market(N);
  const plan = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: s, nowMs: liveClock(s),
    state: null, openPosition: null, minHistoryBars: WARMUP,
    minuteBars: minutesFor(s) });
  assertEquals(plan.bootstrapped, true);
  assertEquals(plan.closed, [], "history must not become forward paper results");
  assertEquals(plan.openPosition, null, "a trade we never saw fill must not be adopted");
  assertEquals(plan.state.cursorBarTime, s[s.length - 1].datetime);
  assertEquals(plan.state.activatedAtBarTime, s[s.length - 1].datetime);
  assertEquals(plan.events, []);
});

Deno.test("below the volatility warmup the runner does nothing at all", () => {
  const s = market(MIN_HISTORY_BARS - 1);
  const plan = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: s, nowMs: liveClock(s),
    state: null, openPosition: null });
  assertEquals(plan.skipped, "INSUFFICIENT_HISTORY");
  assertEquals(plan.state.cursorBarTime, null, "an unusable run must not advance the cursor");
  assertEquals(plan.events, []);
});

// ── the economic execution rule ──────────────────────────────────────────────

Deno.test("a cost-dominated setup is refused for EXECUTION while the signal stays valid", () => {
  const s = market(N, 42);
  const c = cfg({ instrument: "BTC/USD", costPerSide: (p) => p * 0.05 });
  const f = drive(s, c, [125, N - 1]);

  const refused = f.events.filter((e) => e.eventType === "REFUSED");
  assert(refused.length > 0, "the fixture must produce cost-dominated setups");
  for (const r of refused) {
    assertEquals(r.strategyDecision, "WOULD_ENTER", "the IPO signal is still valid");
    assert(r.reasonCodes.includes("ECONOMICALLY_UNTRADEABLE_COST"));
    // The intent was recorded BEFORE the refusal, so it can be explained later.
    assert(f.events.some((e) => e.eventType === "INTENT_CREATED" && e.intentId === r.intentId));
  }
  assertEquals(f.events.filter((e) => e.eventType === "FILLED"), []);
  assertEquals(f.closed.length, 0, "nothing untradeable may be filled");
});

// ── data gaps ────────────────────────────────────────────────────────────────

/** Seed 3 holds a position from bar 119 to 137 — long enough to interrupt. */
const GAP_SEED = 3;
const HELD_AT = 126;

function held(): { s: Candle[]; f: Driven } {
  const s = market(N, GAP_SEED);
  const f = drive(s, cfg(), everyBar(WARMUP, HELD_AT));
  assert(f.position, "fixture must be holding a position at the interruption bar");
  return { s, f };
}

Deno.test("a stale feed suspends an open position instead of closing it", () => {
  const { s, f } = held();
  const bars = s.slice(0, HELD_AT + 1);
  const plan = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: bars,
    nowMs: liveClock(bars) + DEFAULT_GAP_POLICY.staleAfterMs,
    state: f.state, openPosition: f.position, minHistoryBars: WARMUP,
    minuteBars: minutesFor(bars) });
  assertEquals(plan.openPosition?.status, "data_gap_suspended");
  assertEquals(plan.closed, [], "a suspension is not an exit");
  assertEquals(plan.events.at(-1)?.eventType, "GAP_SUSPENDED");
  assertEquals(plan.events.at(-1)?.reasonCodes, ["FEED_STALE"]);
});

Deno.test("losing window coverage of the last managed bar suspends", () => {
  const { s, f } = held();
  // The provider window has slid past the bar we last managed.
  const bars = s.slice(HELD_AT + 5, N);
  const plan = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: bars, nowMs: liveClock(bars),
    state: f.state, openPosition: f.position, minHistoryBars: 50 });
  assertEquals(plan.openPosition?.status, "data_gap_suspended");
  assertEquals(plan.events[0].reasonCodes, ["COVERAGE_LOST"]);
  assertEquals(plan.closed, []);
});

Deno.test("a suspended instrument takes no new entries", () => {
  const { s, f } = held();
  const bars = s.slice(0, HELD_AT + 1);
  const late = liveClock(bars) + DEFAULT_GAP_POLICY.staleAfterMs;
  const suspended = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: bars, nowMs: late,
    state: f.state, openPosition: f.position, minHistoryBars: WARMUP,
    minuteBars: minutesFor(bars) });

  const nextBars = s.slice(HELD_AT + 40, N);
  const next = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: nextBars,
    nowMs: liveClock(nextBars) + DEFAULT_GAP_POLICY.staleAfterMs,
    state: suspended.state, openPosition: suspended.openPosition, minHistoryBars: 50 });
  assertEquals(next.events.filter((e) => e.eventType === "FILLED"), []);
  assertEquals(next.closed, []);
  assertEquals(next.bootstrapped, false, "a suspended instrument must not even rebuild");
});

Deno.test("a recovered feed resumes and manages the bars it missed", () => {
  const { s, f } = held();
  const bars = s.slice(0, HELD_AT + 1);
  const suspended = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: bars,
    nowMs: liveClock(bars) + DEFAULT_GAP_POLICY.staleAfterMs,
    state: f.state, openPosition: f.position, minHistoryBars: WARMUP,
    minuteBars: minutesFor(bars) });
  assertEquals(suspended.openPosition?.status, "data_gap_suspended");

  const resumed = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: s, nowMs: liveClock(s),
    state: suspended.state, openPosition: suspended.openPosition, minHistoryBars: WARMUP,
    minuteBars: minutesFor(s) });
  assertEquals(resumed.events[0].eventType, "GAP_RECOVERED");
  assertEquals(resumed.divergence, null);

  const done = resumed.closed[0];
  assert(done, "the resumed position should have resolved over the remaining bars");
  assert(done.exitPrice !== null, "a recovered trade exits on a real bar");
  assertEquals(done.excludedFromStats, false);
  // And it matches what the engine says that trade did — unless causal ordering
  // moved it, which it must then SAY.
  const engineTrade = replayIncremental(s, cfg()).trades
    .find((t) => s[t.entryIndex].datetime === done.position.entryTime);
  const explained = done.position.engineExitOverridden || done.position.ambiguity !== null ||
    done.htfWouldHaveBooked !== null;
  if (!explained) {
    assertEquals(done.exitTime, s[engineTrade!.exitIndex!].datetime);
    assertEquals(done.exitPrice, engineTrade!.exitPrice);
  }
});

Deno.test("a permanent gap aborts with no fabricated exit and no R", () => {
  const { s, f } = held();
  const bars = s.slice(0, HELD_AT + 1);
  const suspended = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: bars,
    nowMs: liveClock(bars) + DEFAULT_GAP_POLICY.staleAfterMs,
    state: f.state, openPosition: f.position, minHistoryBars: WARMUP,
    minuteBars: minutesFor(bars) });

  const muchLater = liveClock(bars) + DEFAULT_GAP_POLICY.abortAfterMs + BAR_MS;
  const plan = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: bars, nowMs: muchLater,
    state: suspended.state, openPosition: suspended.openPosition, minHistoryBars: WARMUP,
    minuteBars: minutesFor(bars) });

  assertEquals(plan.openPosition, null);
  const r = plan.closed[0];
  assertEquals(r.exitReason, "DATA_GAP_ABORTED");
  assertEquals(r.exitPrice, null);
  assertEquals(r.realizedR, null);
  assertEquals(r.realizedPnlUsd, null);
  assertEquals(r.excludedFromStats, true);
  assert(r.exclusionReason?.includes("FEED_STALE"));
  // The last known state survives — an abort loses the outcome, not the record.
  assertEquals(r.position.entryPrice, f.position!.entryPrice);
  assertEquals(r.maeR, suspended.openPosition!.maeR);
  assertEquals(plan.events.at(-1)?.eventType, "GAP_ABORTED");
});

Deno.test("a stale feed opens nothing while flat", () => {
  const s = market(N);
  const activated = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: s.slice(0, WARMUP),
    nowMs: liveClock(s.slice(0, WARMUP)), state: null, openPosition: null, minHistoryBars: WARMUP,
    minuteBars: minutesFor(s.slice(0, WARMUP)) });
  const bars = s.slice(0, N);
  const plan = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: bars,
    nowMs: liveClock(bars) + DEFAULT_GAP_POLICY.staleAfterMs,
    state: activated.state, openPosition: null, minHistoryBars: WARMUP,
    minuteBars: minutesFor(bars) });
  assertEquals(plan.events, [], "a price days old is not a fill");
  assertEquals(plan.openPosition, null);
});

Deno.test("no FORCED_FLAT path exists in the runner", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoPaperRunner.ts");
  assert(!src.includes("FORCED_FLAT"));
});

// ── divergence detector ──────────────────────────────────────────────────────

Deno.test("a paper position whose levels differ from the engine's is reported, not written", () => {
  const { s, f } = held();
  const tampered = { ...f.position!, entryPrice: f.position!.entryPrice * 1.05 };
  const bars = s.slice(0, HELD_AT + 1);
  const plan = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: bars, nowMs: liveClock(bars),
    state: f.state, openPosition: tampered, minHistoryBars: WARMUP,
    minuteBars: minutesFor(bars) });
  assert(plan.divergence, "a levels mismatch must be caught");
  assert(plan.divergence!.includes("levels"));
});

Deno.test("holding a position the engine has already closed is reported", () => {
  const { s, f } = held();
  const engineTrade = replayIncremental(s, cfg()).trades
    .find((t) => s[t.entryIndex].datetime === f.position!.entryTime);
  assert(engineTrade?.exitIndex, "fixture trade should close");

  // Present the position as never having been managed past its entry bar, then
  // jump well beyond the bar the engine exited on.
  //
  // The causal markers are left ON. Stripping them produced a state the runner
  // cannot reach — a position that skipped the fill path — and the test would
  // then have been asserting against a fiction. The contract being guarded is
  // unchanged: agree, report, or hold with a recorded licence. Never silently.
  const stalePos = { ...f.position!, lastManagedBarTime: f.position!.entryTime };
  const bars = s.slice(0, engineTrade!.exitIndex! + 4);
  const plan = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: bars, nowMs: liveClock(bars),
    state: f.state, openPosition: stalePos, minHistoryBars: WARMUP,
    minuteBars: minutesFor(bars) });

  // Agreement is the good outcome; a reported mismatch is the acceptable one.
  // A silent disagreement is the only failure.
  if (plan.divergence === null) {
    const r = plan.closed[0];
    if (!r) {
      // Still held: only a causal override licenses outliving the engine, and
      // the position must be carrying that licence.
      assert(plan.openPosition, "the position vanished without a result");
      assert(plan.openPosition!.engineExitOverridden || plan.openPosition!.ambiguity !== null,
        "the paper position outlived the engine's trade with no recorded reason");
      return;
    }
    const explained = r.position.engineExitOverridden || r.position.ambiguity !== null ||
      r.htfWouldHaveBooked !== null || r.ambiguityKind !== null;
    if (!explained) {
      assertEquals(r.exitTime, s[engineTrade!.exitIndex!].datetime);
      assertEquals(r.exitPrice, engineTrade!.exitPrice);
    }
  } else {
    assert(plan.divergence.includes("disagree"));
  }
});

// ── audit and idempotency ────────────────────────────────────────────────────

Deno.test("re-running the same bars produces byte-identical output", () => {
  const s = market(N);
  const bars = s.slice(0, 150);
  const state: RuntimeState = {
    strategyId: "ipo_cet", strategyVersion: "spec-1.1", symbol: "EUR/USD", timeframe: "1h",
    cursorBarTime: s[WARMUP].datetime, activatedAtBarTime: s[WARMUP].datetime,
    barsSeen: WARMUP + 1, bootstrapCount: 1,
  };
  const run = () => runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: bars,
    nowMs: liveClock(bars), state, openPosition: null, minHistoryBars: WARMUP,
    minuteBars: minutesFor(bars) });
  const a = run(), b = run();
  assert(a.events.length > 0, "the window must contain decisions to compare");
  assertEquals(JSON.stringify(a.events), JSON.stringify(b.events));
  assertEquals(JSON.stringify(a.closed), JSON.stringify(b.closed));
  assertEquals(JSON.stringify(a.openPosition), JSON.stringify(b.openPosition));
});

Deno.test("every event id is unique within a run", () => {
  const ids = perBar().events.map((e) => e.eventId);
  assertEquals(new Set(ids).size, ids.length, "a duplicate event id would collide on insert");
});

Deno.test("refusals are audited, so a forward test can explain why nothing traded", () => {
  const f = perBar();
  assert(f.events.some((e) => e.eventType === "INTENT_CREATED"));
  assert(f.events.some((e) => e.eventType === "FILLED"));
  assert(f.events.some((e) => e.eventType === "CLOSED"));
});

Deno.test("account decision is recorded separately and never rewrites the strategy call", () => {
  const f = drive(market(N), cfg(), [WARMUP, 140, N - 1], { account: "BLOCK_CORRELATION" });
  const intents = f.events.filter((e) => e.eventType === "INTENT_CREATED");
  assert(intents.length > 0, "the fixture must produce intents");
  for (const e of intents) {
    assertEquals(e.strategyDecision, "WOULD_ENTER");
    assertEquals(e.accountDecision, "BLOCK_CORRELATION");
  }
  assertEquals(f.events.filter((e) => e.eventType === "FILLED"), [],
    "account safety blocks the fill");
  assertEquals(f.closed, []);
});

Deno.test("the runner reaches no SMC table and no broker path", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoPaperRunner.ts");
  for (const banned of ["paper_positions", "pending_orders", "paper_trade_history",
                        "paper_accounts", "broker-execute", "supabase-js", "createClient",
                        "Deno.env", "fetch("]) {
    assert(!src.includes(banned), `the runner references "${banned}"`);
  }
});
