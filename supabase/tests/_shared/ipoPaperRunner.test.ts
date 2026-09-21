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
  opts: { clock?: (b: Candle[]) => number; account?: Parameters<typeof runPaper>[0]["accountDecision"] } = {},
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

Deno.test("bar-by-bar paper trading reproduces the engine's forward trades exactly", () => {
  const s = market(N);
  const f = perBar();

  // Everything the engine entered after the activation bar, and nothing else.
  const expected = replayIncremental(s, cfg()).trades
    .filter((t) => t.entryIndex > WARMUP - 1 && t.exitIndex !== null);

  assert(expected.length >= 5, `fixture produced only ${expected.length} forward trades`);
  assertEquals(f.closed.length, expected.length, "trade count");

  for (let i = 0; i < expected.length; i++) {
    const e = expected[i], p = f.closed[i];
    assertEquals(p.position.entryTime, s[e.entryIndex].datetime, `trade ${i} entry bar`);
    assertEquals(p.exitTime, s[e.exitIndex!].datetime, `trade ${i} exit bar`);
    assertEquals(p.exitPrice, e.exitPrice, `trade ${i} exit price`);
    assertEquals(p.position.entryPrice, e.entry, `trade ${i} entry price`);
    assert(Math.abs(p.realizedR! - e.netR!) < 1e-9,
      `trade ${i} realized R: paper ${p.realizedR} vs engine ${e.netR}`);
    assert(Math.abs(p.maeR - e.mae) < 1e-9, `trade ${i} MAE`);
    assert(Math.abs(p.mfeR - e.mfe) < 1e-9, `trade ${i} MFE`);
  }
});

Deno.test("a trade that opens and closes on the same bar is recorded, not left open", () => {
  // The frozen engine manages the entry bar it fills on; a runner that resumed
  // from the bar AFTER entry would turn those into phantom open positions.
  const s = market(N);
  const sameBar = replayIncremental(s, cfg()).trades
    .filter((t) => t.entryIndex === t.exitIndex && t.entryIndex >= WARMUP);
  assert(sameBar.length > 0, "the fixture must contain a same-bar trade");
  for (const t of sameBar) {
    const rec = perBar().closed.find((c) => c.position.entryTime === s[t.entryIndex].datetime);
    assert(rec, `same-bar trade at ${t.entryIndex} was dropped`);
    assertEquals(rec!.exitTime, s[t.exitIndex!].datetime);
  }
  assertEquals(perBar().position, null);
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
  assertEquals(closed.length, expected.length);
  for (const t of expected) {
    assert(closed.some((p) => p.position.entryTime === s[t.entryIndex].datetime),
      `gated trade at ${t.entryIndex} missing`);
  }
});

Deno.test("equivalence holds across many independent windows, not one lucky fixture", () => {
  // One seed proving equivalence proves very little. Each of these is a
  // different market with a different set of contractions, entries and exits.
  let total = 0;
  for (const seed of [7, 42, 11, 3, 5, 99, 123]) {
    const s = market(N, seed);
    const c = cfg();
    const f = drive(s, c, [WARMUP, 150, 185, N - 1]);
    const expected = replayIncremental(s, c).trades
      .filter((t) => t.entryIndex > WARMUP - 1 && t.exitIndex !== null);
    assertEquals(f.closed.length, expected.length, `seed ${seed}: trade count`);
    for (const t of expected) {
      const p = f.closed.find((x) => x.position.entryTime === s[t.entryIndex].datetime);
      assert(p, `seed ${seed}: trade at ${t.entryIndex} missing`);
      assertEquals(p!.exitTime, s[t.exitIndex!].datetime, `seed ${seed}: exit bar`);
      assert(Math.abs(p!.realizedR! - t.netR!) < 1e-9, `seed ${seed}: realized R`);
    }
    total += expected.length;
  }
  assert(total >= 30, `only ${total} trades across all windows`);
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
      state, openPosition: position, minHistoryBars: WARMUP, warmEngine: engine,
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
    state: null, openPosition: null, minHistoryBars: WARMUP });
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
    state: f.state, openPosition: f.position, minHistoryBars: WARMUP });
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
    state: f.state, openPosition: f.position, minHistoryBars: WARMUP });

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
    state: f.state, openPosition: f.position, minHistoryBars: WARMUP });
  assertEquals(suspended.openPosition?.status, "data_gap_suspended");

  const resumed = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: s, nowMs: liveClock(s),
    state: suspended.state, openPosition: suspended.openPosition, minHistoryBars: WARMUP });
  assertEquals(resumed.events[0].eventType, "GAP_RECOVERED");
  assertEquals(resumed.divergence, null);

  const done = resumed.closed[0];
  assert(done, "the resumed position should have resolved over the remaining bars");
  assert(done.exitPrice !== null, "a recovered trade exits on a real bar");
  assertEquals(done.excludedFromStats, false);
  // And it matches what the engine says that trade did.
  const engineTrade = replayIncremental(s, cfg()).trades
    .find((t) => s[t.entryIndex].datetime === done.position.entryTime);
  assertEquals(done.exitTime, s[engineTrade!.exitIndex!].datetime);
  assertEquals(done.exitPrice, engineTrade!.exitPrice);
});

Deno.test("a permanent gap aborts with no fabricated exit and no R", () => {
  const { s, f } = held();
  const bars = s.slice(0, HELD_AT + 1);
  const suspended = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: bars,
    nowMs: liveClock(bars) + DEFAULT_GAP_POLICY.staleAfterMs,
    state: f.state, openPosition: f.position, minHistoryBars: WARMUP });

  const muchLater = liveClock(bars) + DEFAULT_GAP_POLICY.abortAfterMs + BAR_MS;
  const plan = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: bars, nowMs: muchLater,
    state: suspended.state, openPosition: suspended.openPosition, minHistoryBars: WARMUP });

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
    nowMs: liveClock(s.slice(0, WARMUP)), state: null, openPosition: null, minHistoryBars: WARMUP });
  const bars = s.slice(0, N);
  const plan = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: bars,
    nowMs: liveClock(bars) + DEFAULT_GAP_POLICY.staleAfterMs,
    state: activated.state, openPosition: null, minHistoryBars: WARMUP });
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
    state: f.state, openPosition: tampered, minHistoryBars: WARMUP });
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
  const stalePos = { ...f.position!, lastManagedBarTime: f.position!.entryTime };
  const bars = s.slice(0, engineTrade!.exitIndex! + 4);
  const plan = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: bars, nowMs: liveClock(bars),
    state: f.state, openPosition: stalePos, minHistoryBars: WARMUP });

  // Agreement is the good outcome; a reported mismatch is the acceptable one.
  // A silent disagreement is the only failure.
  if (plan.divergence === null) {
    assertEquals(plan.closed[0].exitTime, s[engineTrade!.exitIndex!].datetime);
    assertEquals(plan.closed[0].exitPrice, engineTrade!.exitPrice);
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
    nowMs: liveClock(bars), state, openPosition: null, minHistoryBars: WARMUP });
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
