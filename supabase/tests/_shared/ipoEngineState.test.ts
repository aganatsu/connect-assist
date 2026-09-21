import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { IncrementalEngine, FROZEN_RULES } from "../../functions/_shared/ipoIncrementalEngine.ts";
import {
  exportState, serializeState, parseState, restoreState, continuityCheck,
  packBars, unpackBars, fingerprint, engineRulesFingerprint,
  RUNTIME_STATE_SCHEMA_VERSION, MAX_STATE_BARS,
  type EngineRuntimeState, type ExportMeta,
} from "../../functions/_shared/ipoEngineState.ts";
import type { EngineConfig, LiveEvent, LiveTrade } from "../../functions/_shared/ipoLiveEngine.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const BAR_MS = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);

const cfg = (over: Partial<EngineConfig> = {}): EngineConfig =>
  ({ instrument: "EUR/USD", timeframe: "1h", highVolOnly: false, costPerSide: () => 0, ...over });

const META: ExportMeta = { strategyVersion: "spec-1.1", costModelId: "fx_fixed_0.00008" };

function market(n: number, seed = 7): Candle[] {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const vol = 0.3 + Math.abs(Math.sin(i / 90)) * 1.4;
    const o = p;
    p = Math.max(1, p + (rnd() - 0.5) * vol * 2);
    out.push({
      datetime: new Date(T0 + i * BAR_MS).toISOString(),
      open: o, high: Math.max(o, p) + rnd() * vol, low: Math.min(o, p) - rnd() * vol,
      close: p, volume: 0,
    });
  }
  return out;
}

/**
 * Rehydrates from BYTES ONLY.
 *
 * The parameter is a string, so this function cannot close over the engine that
 * produced it — the same guarantee a separate process would give, minus the
 * process. The one thing a real process boundary would also drop is
 * `costPerSide`, and that is supplied here exactly as the worker supplies it.
 */
function rehydrate(json: string, c: EngineConfig = cfg()): IncrementalEngine {
  const r = restoreState(json, c, META);
  assert(r.ok, `restore rejected: ${r.ok ? "" : `${r.reason} — ${r.detail}`}`);
  return (r as { ok: true; engine: IncrementalEngine }).engine;
}

/**
 * Feeds bars and records each event AS EMITTED.
 *
 * The copy is load-bearing. `LiveEvent.trade` is the engine's own `LiveTrade`
 * object, not a copy, so an ENTERED event held across later bars silently
 * acquires the exit fields — see the aliasing test below. Comparing the
 * retained references would compare final states, not emissions, and would hide
 * exactly the kind of mid-flight difference this suite exists to catch.
 */
const feed = (e: IncrementalEngine, bars: Candle[]): LiveEvent[] =>
  bars.flatMap((b) => e.feed(b).map((ev) => JSON.parse(JSON.stringify(ev)) as LiveEvent));

/** Total comparison: every field of every emitted event, in order. */
const sameEvents = (a: LiveEvent[], b: LiveEvent[], label: string) =>
  assertEquals(JSON.stringify(b), JSON.stringify(a), label);

// ─── the required end-to-end proof ───────────────────────────────────────────

Deno.test("1,200-bar bootstrap: split-and-restore emits exactly what uninterrupted emits", () => {
  const N_AFTER = 40, SPLIT = 20;
  const s = market(1200 + N_AFTER, 7);
  const boot = s.slice(0, 1200);
  const after = s.slice(1200);

  // Uninterrupted: one engine, never serialised, feeds everything.
  const live = new IncrementalEngine(cfg());
  feed(live, boot);
  // Snapshot taken mid-stream must not disturb the engine that produced it;
  // `live` keeps running below and is the baseline.
  const s0 = serializeState(exportState(live, cfg(), META));
  const baseline = feed(live, after);

  // Restarted: bytes only, twice, with the engine thrown away in between.
  let b: IncrementalEngine | null = rehydrate(s0);
  const partA = feed(b, after.slice(0, SPLIT));
  const s1 = serializeState(exportState(b, cfg(), META));
  b = null;                                    // destroyed
  const c = rehydrate(s1);
  const partB = feed(c, after.slice(SPLIT));

  sameEvents(baseline, [...partA, ...partB], "emitted events after a restart");
  assertEquals(JSON.stringify(c.trades), JSON.stringify(live.trades), "trade ledger");
  assertEquals(JSON.stringify(c.openTrade), JSON.stringify(live.openTrade), "open trade");
  assertEquals(c.currentVol, live.currentVol, "volatility bucket");
  assertEquals(c.barCount, live.barCount, "bar count");
  assertEquals(c.sequencingBlocked, live.sequencingBlocked, "sequencing");
  assertEquals(JSON.stringify(c.inspect()), JSON.stringify(live.inspect()), "tracked candidates");
});

// ─── restart at every state the engine can be in ─────────────────────────────

interface Probe {
  events: LiveEvent[][];
  states: string[];
  hit: Record<string, number[]>;
}

/**
 * One uninterrupted pass that records, per bar, what was emitted, what the
 * engine looked like, and a serialised state to restart from.
 */
function probe(s: Candle[], c: EngineConfig): Probe {
  const e = new IncrementalEngine(c);
  const events: LiveEvent[][] = [];
  const states: string[] = [];
  const hit: Record<string, number[]> = {
    duringContraction: [], pendingIpo: [], ipoValid: [], beforeTouch: [],
    openTrade: [], afterS2: [], afterTarget: [], volChange: [],
  };
  const touched: number[] = [];
  let prevVol = "UNCLASSIFIED";

  for (let i = 0; i < s.length; i++) {
    // Copied at emission, for the aliasing reason described on `feed`.
    const evs = e.feed(s[i]).map((ev) => JSON.parse(JSON.stringify(ev)) as LiveEvent);
    events.push(evs);
    states.push(serializeState(exportState(e, c, META)));

    const tr = e.inspect();
    if (tr.some((t) => t.suppressed)) hit.duringContraction.push(i);
    if (tr.some((t) => t.validAt === null && !t.promotionDead && t.invalidatedAt === null)) {
      hit.pendingIpo.push(i);
    }
    if (tr.some((t) => t.validAt !== null && t.lastTouch === null && t.invalidatedAt === null)) {
      hit.ipoValid.push(i);
    }
    if (tr.some((t) => t.touchedThisBar)) touched.push(i);
    if (e.openTrade) hit.openTrade.push(i);
    if (tr.some((t) => t.invalidatedAt === i)) hit.afterS2.push(i);
    for (const ev of evs) {
      if (ev.kind !== "EXITED") continue;
      (ev.trade.exitPrice === ev.trade.target ? hit.afterTarget : hit.afterS2).push(i);
    }
    if (i > 0 && e.currentVol !== prevVol) hit.volChange.push(i);
    prevVol = e.currentVol;
  }
  hit.beforeTouch = touched.map((i) => i - 1).filter((i) => i >= 0);
  return { events, states, hit };
}

Deno.test("restart is exact from every lifecycle state the engine can be in", () => {
  const N = 400, FROM = 150;
  const s = market(N, 123);
  const c = cfg();
  const p = probe(s, c);

  // Each of these is a state the trader would recognise, and each must be
  // located in the fixture rather than assumed — a condition that never occurs
  // would otherwise pass as "tested".
  const CONDITIONS = [
    "duringContraction", "pendingIpo", "ipoValid", "beforeTouch",
    "openTrade", "afterS2", "afterTarget", "volChange",
  ];

  const points = new Map<number, string[]>();
  for (const k of CONDITIONS) {
    const at = p.hit[k].find((i) => i >= FROM && i < N - 20);
    assert(at !== undefined,
      `the fixture never reaches "${k}" between bar ${FROM} and ${N - 20}; ` +
      `occurrences: ${p.hit[k].length}`);
    points.set(at, [...(points.get(at) ?? []), k]);
  }

  for (const [r, labels] of [...points].sort((a, b) => a[0] - b[0])) {
    const e = rehydrate(p.states[r], c);
    const got = feed(e, s.slice(r + 1));
    const want = p.events.slice(r + 1).flat();
    sameEvents(want, got, `restart at bar ${r} (${labels.join(", ")})`);
  }
});

Deno.test("restart is exact for a volatility-gated instrument too", () => {
  const s = market(400, 42);
  const c = cfg({ instrument: "BTC/USD", highVolOnly: true, costPerSide: (x) => x * 0.0015 });
  const meta: ExportMeta = { ...META, costModelId: "btc_prop_0.0015" };
  const live = new IncrementalEngine(c);
  feed(live, s.slice(0, 260));
  const snap = serializeState(exportState(live, c, meta));
  const baseline = feed(live, s.slice(260));

  const r = restoreState(snap, c, meta);
  assert(r.ok);
  const got = feed((r as { ok: true; engine: IncrementalEngine }).engine, s.slice(260));
  sameEvents(baseline, got, "gated instrument restart");
});

Deno.test("restarting on every single bar of a window stays exact", () => {
  // Not one restart but eighty: a bug that only bites at a particular phase of
  // the FVG settlement or episode-freeze cycle would hide from a single point.
  const N = 300;
  const s = market(N, 3);
  const c = cfg();
  const p = probe(s, c);
  for (let r = 200; r < N - 1; r++) {
    const e = rehydrate(p.states[r], c);
    const got = feed(e, s.slice(r + 1));
    sameEvents(p.events.slice(r + 1).flat(), got, `restart at bar ${r}`);
  }
});

// ─── the snapshot contract ───────────────────────────────────────────────────

Deno.test("a snapshot is a copy — continuing the engine cannot change it", () => {
  const s = market(300);
  const e = new IncrementalEngine(cfg());
  feed(e, s.slice(0, 250));
  const before = serializeState(exportState(e, cfg(), META));
  feed(e, s.slice(250));
  const after = serializeState(exportState(e, cfg(), META));
  assert(before !== after, "the engine did move on");
  // And the first payload still describes bar 249.
  assertEquals(parseState(before)!.barCount, 250);
  assertEquals(parseState(before)!.lastProcessedBarTime, s[249].datetime);
});

Deno.test("export -> restore -> export is byte-identical", () => {
  const s = market(300);
  const e = new IncrementalEngine(cfg());
  feed(e, s);
  const a = serializeState(exportState(e, cfg(), META));
  const b = serializeState(exportState(rehydrate(a), cfg(), META));
  assertEquals(b, a, "a round trip must not perturb the state");
});

Deno.test("the snapshot omits refusals, and refusals are never read", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoIncrementalEngine.ts");
  // Every mention must be a write. A read would make the omission a bug.
  const mentions = [...src.matchAll(/this\.refusals[^;\n]*/g)].map((m) => m[0]);
  assert(mentions.length > 0, "the accumulator should still exist");
  for (const m of mentions) {
    assert(m.startsWith("this.refusals.push("), `refusals is read, not just written: ${m}`);
  }
  const s = market(260);
  const e = new IncrementalEngine(cfg());
  feed(e, s);
  assert(!serializeState(exportState(e, cfg(), META)).includes("refusals"));
});

// ─── bar packing ─────────────────────────────────────────────────────────────

Deno.test("packed bars round-trip exactly, including an absent volume", () => {
  const bars: Candle[] = [
    { datetime: "2025-01-01T00:00:00.000Z", open: 1.1, high: 1.2, low: 1.0, close: 1.15, volume: 7 },
    { datetime: "2025-01-01T01:00:00.000Z", open: 1.15, high: 1.25, low: 1.1, close: 1.2 },
    { datetime: "2025-01-03T09:30:00.000Z", open: 1.2, high: 1.3, low: 1.19, close: 1.28, volume: 0 },
  ];
  const back = unpackBars(packBars(bars));
  assertEquals(back, bars, "an uneven gap and a missing volume must both survive");
  // volume: 0 is a value, not an absence.
  assert("volume" in back[2] && back[2].volume === 0);
  assert(!("volume" in back[1]));
});

Deno.test("packing is what makes the payload affordable", () => {
  const bars = market(1200);
  const packed = JSON.stringify(packBars(bars)).length;
  const naive = JSON.stringify(bars).length;
  assert(packed < naive * 0.6,
    `packed ${packed} vs naive ${naive} — packing should cut the bar payload substantially`);
});

// ─── identity and integrity: every rejection must fire ───────────────────────

function warm(): { state: EngineRuntimeState; json: string } {
  const e = new IncrementalEngine(cfg());
  feed(e, market(260));
  const state = exportState(e, cfg(), META);
  return { state, json: serializeState(state) };
}

const expectReject = (r: ReturnType<typeof restoreState>, reason: string) => {
  assert(!r.ok, `expected ${reason}, but the restore succeeded`);
  assertEquals((r as { reason: string }).reason, reason);
};

Deno.test("no state at all is a named rebuild reason, not a crash", () => {
  expectReject(restoreState(null, cfg(), META), "NO_STATE");
  expectReject(restoreState("", cfg(), META), "NO_STATE");
});

Deno.test("unparseable or truncated state is refused", () => {
  expectReject(restoreState("{not json", cfg(), META), "MALFORMED_STATE");
  expectReject(restoreState('{"identity":{}}', cfg(), META), "MALFORMED_STATE");
  const { json } = warm();
  expectReject(restoreState(json.slice(0, json.length - 50), cfg(), META), "MALFORMED_STATE");
});

Deno.test("state from another schema version is refused", () => {
  const { state } = warm();
  const s = { ...state, identity: { ...state.identity, schemaVersion: RUNTIME_STATE_SCHEMA_VERSION + 1 } };
  expectReject(restoreState(s, cfg(), META), "SCHEMA_VERSION_CHANGED");
});

Deno.test("state from another strategy version is refused", () => {
  const { state } = warm();
  expectReject(restoreState(state, cfg(), { ...META, strategyVersion: "spec-2.0" }),
    "STRATEGY_VERSION_CHANGED");
});

Deno.test("state written under different frozen rules is refused", () => {
  const { state } = warm();
  const s = { ...state, identity: { ...state.identity, engineRulesFingerprint: "deadbeefdeadbeef" } };
  expectReject(restoreState(s, cfg(), META), "ENGINE_RULES_CHANGED");
});

Deno.test("the rules fingerprint is derived from the rules, not hand-written", () => {
  const a = engineRulesFingerprint();
  assertEquals(a, fingerprint(JSON.stringify(FROZEN_RULES)));
  // Changing any frozen parameter must change it.
  const altered = { ...FROZEN_RULES, fvgWindow: 11 };
  assert(fingerprint(JSON.stringify(altered)) !== a);
});

Deno.test("state from another instrument, timeframe or gate is refused", () => {
  const { state } = warm();
  for (const over of [{ instrument: "USD/JPY" }, { timeframe: "30min" }, { highVolOnly: true }]) {
    expectReject(restoreState(state, cfg(over), META), "INSTRUMENT_CONFIG_CHANGED");
  }
});

Deno.test("state priced under a different cost model is refused", () => {
  // costPerSide is a function and cannot be compared, so the declared id is.
  const { state } = warm();
  expectReject(restoreState(state, cfg(), { ...META, costModelId: "fx_fixed_0.0002" }),
    "COST_MODEL_CHANGED");
});

Deno.test("a tampered payload fails its checksum", () => {
  const { state } = warm();
  const tampered = {
    ...state,
    engine: { ...state.engine, lastExitIndex: state.engine.lastExitIndex + 5 },
  };
  expectReject(restoreState(tampered, cfg(), META), "CHECKSUM_MISMATCH");
});

Deno.test("a payload whose bars and count disagree is refused", () => {
  const { state } = warm();
  const body = { ...state, barCount: state.barCount + 1 };
  const bad = { ...body, checksum: fingerprint(JSON.stringify(
    [body.identity, body.lastProcessedBarTime, body.barCount, body.bars, body.engine])) };
  expectReject(restoreState(bad, cfg(), META), "MALFORMED_STATE");
});

Deno.test("state past the bar ceiling is refused rather than grown forever", () => {
  const { state } = warm();
  const body = { ...state, barCount: MAX_STATE_BARS + 1 };
  const bad = { ...body, checksum: fingerprint(JSON.stringify(
    [body.identity, body.lastProcessedBarTime, body.barCount, body.bars, body.engine])) };
  const r = restoreState(bad, cfg(), META);
  expectReject(r, "STATE_BAR_LIMIT");
  // Rejected on the declared size, without expanding the payload first.
  assert((r as { detail: string }).detail.includes(String(MAX_STATE_BARS)));
});

Deno.test("an event's trade object is the ENGINE's, and keeps moving after emission", () => {
  // Not a defect in the state layer, but a hazard for anything that stores an
  // event: the ENTERED event handed to a consumer acquires exitIndex, exitPrice
  // and netR when the trade later closes. Pinned here so a consumer that starts
  // keeping events has to confront it. See docs/IPO_EXIT_AUTHORITY_AUDIT.md.
  const s = market(400, 123);
  const e = new IncrementalEngine(cfg());
  let held: LiveTrade | null = null;
  let atEmission = "";
  for (const b of s) {
    for (const ev of e.feed(b)) {
      if (ev.kind === "ENTERED" && !held) { held = ev.trade; atEmission = JSON.stringify(ev.trade); }
    }
    if (held && e.trades.length) break;
  }
  assert(held, "the fixture must enter a trade");
  assert(held === e.trades[0], "the event holds the engine's object, not a copy");
  assert(JSON.stringify(held) !== atEmission,
    "and that object has changed since it was emitted");
});

// ─── continuity ──────────────────────────────────────────────────────────────

Deno.test("only genuinely new bars are appended", () => {
  const s = market(300);
  const e = new IncrementalEngine(cfg());
  feed(e, s.slice(0, 260));
  const state = exportState(e, cfg(), META);

  // A provider page overlapping the state by 20 bars and carrying 10 new ones.
  const page = s.slice(240, 270);
  const r = continuityCheck(state, page);
  assert(r.ok);
  assertEquals((r as { append: Candle[] }).append.map((b) => b.datetime),
    s.slice(260, 270).map((b) => b.datetime));
});

Deno.test("a page with no overlap cannot be spliced on", () => {
  const s = market(300);
  const e = new IncrementalEngine(cfg());
  feed(e, s.slice(0, 260));
  const state = exportState(e, cfg(), META);
  const r = continuityCheck(state, s.slice(265, 300));
  assert(!r.ok);
  assertEquals((r as { reason: string }).reason, "BAR_CONTINUITY_BROKEN");
});

Deno.test("an empty page is a no-op, not a gap", () => {
  const s = market(260);
  const e = new IncrementalEngine(cfg());
  feed(e, s);
  const r = continuityCheck(exportState(e, cfg(), META), []);
  assert(r.ok);
  assertEquals((r as { append: Candle[] }).append, []);
});

Deno.test("a page containing only already-processed bars appends nothing", () => {
  const s = market(300);
  const e = new IncrementalEngine(cfg());
  feed(e, s.slice(0, 260));
  const r = continuityCheck(exportState(e, cfg(), META), s.slice(230, 260));
  assert(r.ok);
  assertEquals((r as { append: Candle[] }).append, [],
    "a bar already decided on must never be re-fed");
});

Deno.test("appending only the new bars equals feeding the whole page", () => {
  // The continuity contract is only useful if it is equivalent to the naive thing.
  const s = market(320);
  const c = cfg();
  const live = new IncrementalEngine(c);
  feed(live, s.slice(0, 260));
  const state = exportState(live, c, META);
  const baseline = feed(live, s.slice(260, 300));

  const r = continuityCheck(state, s.slice(240, 300));
  assert(r.ok);
  const e = rehydrate(serializeState(state), c);
  sameEvents(baseline, feed(e, (r as { append: Candle[] }).append), "incremental append");
});
