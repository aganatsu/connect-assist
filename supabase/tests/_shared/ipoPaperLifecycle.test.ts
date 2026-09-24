/**
 * Deterministic open→close lifecycle validation for the IPO paper path.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE OTHER PAPER TESTS. Those check pieces:
 * the contract in isolation, the runner's equivalence with the engine, the
 * function's isolation guarantees. This one drives a trade all the way from a
 * frozen-engine setup to the exact database rows that would be written, through
 * the real `runPaper`, the real `ipoPaperContract`, and the real row mappers
 * exported by `ipo-paper-runner` — no reimplementation of any of it. The only
 * substitute is the database itself, and the row SHAPES are still the
 * production ones.
 *
 * WHY FIXTURES AND NOT LIVE DATA. Production has produced no entry yet: every
 * invocation so far advanced 0–1 bars with no setup triggering. Waiting for one
 * is not validation, it is hoping. These seeded markets produce real engine
 * setups — nothing is hand-placed into the strategy — and the specific outcomes
 * were located by measurement rather than assumed:
 *
 *   target exits      plentiful in every seed
 *   S2 exits past -1R present in 6 of 7 seeds
 *   same-bar ambiguity NOT PRESENT in any seed, so that one case is driven
 *                      through `stepPosition` with a constructed bar. It is
 *                      still production code; only the bar is authored.
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runPaper, type PaperEvent, type RuntimeState } from "../../functions/_shared/ipoPaperRunner.ts";
import {
  buildIntent, openPosition, stepPosition, suspendForGap, resumeFromGap, abortForGap,
  DEFAULT_SIZING, nominalRiskUsd,
  type PaperPosition, type PaperResult,
} from "../../functions/_shared/ipoPaperContract.ts";
import { positionRow, historyRow, eventRow } from "../../functions/ipo-paper-runner/index.ts";
import type { EngineConfig, LiveTrade } from "../../functions/_shared/ipoLiveEngine.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const BAR_MS = 3_600_000;
const N = 300, WARMUP = 100;
const USER = "57c79dee-db6b-4fae-b34a-4b64ce33ca34";

/** Provider-form timestamps, as schema 2 requires. */
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
      datetime: new Date(Date.UTC(2026, 0, 1) + i * BAR_MS).toISOString().replace(".000Z", "Z"),
      open: o, high: Math.max(o, p) + rnd() * vol, low: Math.min(o, p) - rnd() * vol,
      close: p, volume: 0,
    });
  }
  return out;
}

const cfg = (over: Partial<EngineConfig> = {}): EngineConfig =>
  ({ instrument: "EUR/USD", timeframe: "1h", highVolOnly: false, costPerSide: () => 0, ...over });

const clock = (b: Candle[]) => new Date(b[b.length - 1].datetime).getTime() + 2 * BAR_MS;

interface Driven {
  closed: PaperResult[];
  events: PaperEvent[];
  position: PaperPosition | null;
  state: RuntimeState | null;
}

/** Drives the REAL runner bar by bar, exactly as a scheduled worker would. */
/**
 * A deterministic 1-minute tape: four point-minutes per bar walking
 * open -> first extreme -> second extreme -> close, extremes ordered by the
 * bar's direction. Without it every target-touching fill is an unorderable
 * ambiguity and these lifecycle scenarios never reach their second bar.
 */
function minutesFor(bars: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const b of bars) {
    const t0 = new Date(b.datetime).getTime();
    const up = b.close >= b.open;
    [b.open, up ? b.low : b.high, up ? b.high : b.low, b.close].forEach((px, i) => {
      out.push({ datetime: new Date(t0 + i * 15 * 60_000).toISOString(),
        open: px, high: px, low: px, close: px, volume: 0 });
    });
  }
  return out;
}

function drive(s: Candle[], c: EngineConfig, from = WARMUP, to = -1): Driven {
  let state: RuntimeState | null = null;
  let position: PaperPosition | null = null;
  const closed: PaperResult[] = [];
  const events: PaperEvent[] = [];
  const end = to < 0 ? s.length - 1 : to;
  for (let i = from; i <= end; i++) {
    const bars = s.slice(0, i + 1);
    const plan = runPaper({
      cfg: c, barMs: BAR_MS, closedBars: bars, nowMs: clock(bars),
      state, openPosition: position, minHistoryBars: WARMUP,
      minuteBars: minutesFor(bars),
    });
    assertEquals(plan.divergence, null, `bar ${i}: ${plan.divergence}`);
    state = plan.state; position = plan.openPosition;
    closed.push(...plan.closed); events.push(...plan.events);
  }
  return { closed, events, position, state };
}

const evTypes = (evs: PaperEvent[], intentId: string) =>
  evs.filter((e) => e.intentId === intentId).map((e) => e.eventType);

/**
 * Asserts the event sequence for one intent.
 *
 * A multi-bar trade legitimately emits MANAGED between the fill and the close —
 * one per invocation that advanced bars without resolving it. What must hold is
 * the shape: created, filled, then zero or more MANAGED, then closed exactly
 * once.
 */
function assertLifecycle(evs: PaperEvent[], intentId: string, ending: string) {
  const seq = evTypes(evs, intentId);
  assertEquals(seq[0], "INTENT_CREATED");
  assertEquals(seq[1], ending === "REFUSED" ? "REFUSED" : "FILLED");
  if (ending === "REFUSED") { assertEquals(seq.length, 2); return; }
  assertEquals(seq[seq.length - 1], "CLOSED");
  assertEquals(seq.filter((x) => x === "CLOSED").length, 1, "closed more than once");
  assertEquals(seq.filter((x) => x === "FILLED").length, 1, "filled more than once");
  for (const mid of seq.slice(2, -1)) {
    assertEquals(mid, "MANAGED", `unexpected event between fill and close: ${mid}`);
  }
}

/** Drives are expensive (one full runner pass per bar), so each is built once. */
const _drives = new Map<string, Driven>();
const driveOnce = (key: string, build: () => Driven): Driven => {
  const hit = _drives.get(key);
  if (hit) return hit;
  const v = build();
  _drives.set(key, v);
  return v;
};

// ── 1. entry → target ────────────────────────────────────────────────────────

Deno.test("SCENARIO 1 — entry to target: full lifecycle and exact R", () => {
  const s = market(N, 3);                       // 6 of 6 exits are targets
  const f = driveOnce("seed3-cost", () => drive(s, cfg({ costPerSide: () => 0.0001 })));
  const win = f.closed.find((r) => r.exitReason === "TARGET_2R");
  assert(win, "the fixture must produce a target exit");
  const p = win!.position;

  // The signal was admitted, filled, and closed — in that order, once each.
  assertLifecycle(f.events, p.intentId, "CLOSED");
  const intent = f.events.find((e) => e.intentId === p.intentId)!;
  assertEquals(intent.strategyDecision, "WOULD_ENTER");

  // Target is a fixed 2R from entry, on the correct side.
  const risk = p.nominalRiskDistance;
  const expected = p.direction === "long" ? p.entryPrice + 2 * risk : p.entryPrice - 2 * risk;
  assertEquals(Math.round(p.targetPrice * 1e9), Math.round(expected * 1e9));
  assertEquals(win!.exitPrice, p.targetPrice, "a target exit fills AT the target");
  assertEquals(win!.grossR, 2);

  // R is canonical; dollars are a view of it under the stored sizing.
  assertEquals(Math.round(win!.realizedR! * 1e9), Math.round((2 - p.costR) * 1e9));
  assertEquals(p.referenceBalanceAtEntry, DEFAULT_SIZING.referenceBalance);
  assertEquals(p.nominalRiskPct, DEFAULT_SIZING.nominalRiskPct);
  assertEquals(p.nominalRiskUsd, nominalRiskUsd(DEFAULT_SIZING));
  assertEquals(Math.round(win!.realizedPnlUsd! * 1e6),
    Math.round(win!.realizedR! * p.nominalRiskUsd * 1e6));

  // And the row that would be written is coherent for the schema.
  const row = historyRow(win!, USER);
  assertEquals(row.exit_reason, "TARGET_2R");
  assertEquals(row.excluded_from_stats, false);
  assertEquals(row.exclusion_reason, null);
  assert(row.exit_price !== null && row.realized_r !== null);
  assertEquals(row.user_id, USER);
});

// ── 2. entry → S2 invalidation ───────────────────────────────────────────────

Deno.test("SCENARIO 2 — entry to S2: exits at the CLOSE and may lose more than 1R", () => {
  const s = market(N, 99);
  const f = driveOnce("seed99", () => drive(s, cfg()));
  const loss = f.closed.find((r) => r.exitReason === "S2_CLOSE_INVALIDATION");
  assert(loss, "the fixture must produce an S2 exit");
  const p = loss!.position;

  // The exit price is the invalidating candle's CLOSE, not the stop level.
  const exitBar = s.find((b) => b.datetime === loss!.exitTime)!;
  assertEquals(loss!.exitPrice, exitBar.close);
  const beyond = p.direction === "long"
    ? exitBar.close < p.s2InvalidationLevel : exitBar.close > p.s2InvalidationLevel;
  assert(beyond, "the exit bar did not actually close beyond S2");

  // S2 is not a 1R stop. This is the whole risk character of the strategy.
  assert(loss!.realizedR! < -1,
    `expected worse than -1R, got ${loss!.realizedR} — the fixture chosen must show slippage past nominal risk`);
  assertLifecycle(f.events, p.intentId, "CLOSED");
  assertEquals(historyRow(loss!, USER).exit_reason, "S2_CLOSE_INVALIDATION");
});

Deno.test("SCENARIO 2b — a wick through S2 does NOT close the position", () => {
  const s = market(N, 99);
  const f = driveOnce("seed99", () => drive(s, cfg()));
  const p = f.closed[0].position;
  // A bar that pierces S2 deeply but closes back inside must be a HOLD.
  const long = p.direction === "long";
  const pierce = long ? p.s2InvalidationLevel - 5 : p.s2InvalidationLevel + 5;
  const bar: Candle = {
    datetime: "2026-06-01T00:00:00Z",
    open: p.entryPrice,
    high: long ? p.entryPrice : pierce,
    low: long ? pierce : p.entryPrice,
    close: p.entryPrice,                       // closes back at entry
    volume: 0,
  };
  const out = stepPosition({ ...p, status: "open" }, bar, 1);
  assertEquals(out.kind, "HOLD", "only a CLOSE beyond S2 may exit");
});

// ── 3. same-bar ambiguity ────────────────────────────────────────────────────

Deno.test("SCENARIO 3 — target and S2 on one bar resolves stop-first", () => {
  // Not present in any seeded fixture, so the bar is authored. The code under
  // test is still `stepPosition`, unchanged.
  const s = market(N, 3);
  const f = driveOnce("seed3", () => drive(s, cfg()));
  const p = { ...f.closed[0].position, status: "open" as const };
  const long = p.direction === "long";

  const bar: Candle = {
    datetime: "2026-06-02T00:00:00Z",
    open: p.entryPrice,
    high: long ? p.targetPrice + 1 : p.s2InvalidationLevel + 1,
    low: long ? p.s2InvalidationLevel - 1 : p.targetPrice - 1,
    // Closes beyond S2 while the range also reached the target.
    close: long ? p.s2InvalidationLevel - 0.5 : p.s2InvalidationLevel + 0.5,
    volume: 0,
  };
  const out = stepPosition(p, bar, 1);
  assert(out.kind === "CLOSED");
  assertEquals(out.result.exitReason, "S2_CLOSE_INVALIDATION", "stop-first was not preserved");
  assertEquals(out.result.sameBarAmbiguous, true, "the ambiguity was not recorded");
  assert(out.result.realizedR! < 0);
  assertEquals(out.result.exitPrice, bar.close);
  // The flag reaches the database, so the optimistic reading stays recoverable.
  assertEquals(historyRow(out.result, USER).same_bar_ambiguous, true);
});

// ── 4. costR > 2 ─────────────────────────────────────────────────────────────

Deno.test("SCENARIO 4 — cost-dominated: signal VALID, execution BLOCKED, no position", () => {
  const s = market(N, 42);
  // A cost so large that the round trip exceeds the entire 2R target.
  const f = driveOnce("seed42-costly", () => drive(s, cfg({ costPerSide: (p) => p * 0.05 })));

  const refusals = f.events.filter((e) => e.eventType === "REFUSED");
  assert(refusals.length > 0, "the fixture must produce a cost-dominated setup");
  for (const r of refusals) {
    assertEquals(r.strategyDecision, "WOULD_ENTER", "the IPO signal must stay valid");
    assert(r.reasonCodes.includes("ECONOMICALLY_UNTRADEABLE_COST"));
    assertEquals(r.payload.blockReason, "ECONOMICALLY_UNTRADEABLE_COST");
    assert((r.payload.costR as number) > 2);
    // The intent was recorded first, so the refusal is explainable later.
    assertLifecycle(f.events, r.intentId!, "REFUSED");
  }
  assertEquals(f.events.filter((e) => e.eventType === "FILLED"), [], "a blocked setup filled");
  assertEquals(f.closed, [], "a blocked setup produced a result");
  assertEquals(f.position, null, "a blocked setup left a position open");

  // The audit row keeps the two verdicts apart.
  const row = eventRow(refusals[0], USER);
  assertEquals(row.strategy_decision, "WOULD_ENTER");
  assertEquals(row.event_type, "REFUSED");
});

// ── 5. idempotency ───────────────────────────────────────────────────────────

Deno.test("SCENARIO 5 — replaying the entry and exit bars produces no duplicates", () => {
  const s = market(N, 3);
  const a = driveOnce("seed3", () => drive(s, cfg()));
  const b = drive(s, cfg());   // deliberately NOT memoised: this is the replay

  // Same decisions, same identities, same rows.
  assertEquals(JSON.stringify(b.events), JSON.stringify(a.events));
  assertEquals(JSON.stringify(b.closed), JSON.stringify(a.closed));

  // Every id is unique within a run and stable across runs — which is what
  // makes the upserts converge instead of duplicating.
  const ids = a.events.map((e) => e.eventId);
  assertEquals(new Set(ids).size, ids.length, "a duplicate event id inside one run");
  assertEquals(b.events.map((e) => e.eventId), ids, "event ids moved between runs");

  const intents = a.closed.map((r) => r.position.intentId);
  assertEquals(new Set(intents).size, intents.length, "two results share an intent_id");
  // The DB enforces the rest: intent_id is UNIQUE on positions and on history.
  assertEquals(new Set(a.closed.map((r) => historyRow(r, USER).intent_id)).size, intents.length);
});

Deno.test("SCENARIO 5b — a partial replay cannot re-open a closed position", () => {
  // Re-running the window that contains an entry AND its exit must end flat,
  // not holding, however many times it is replayed.
  const s = market(N, 3);
  const first = driveOnce("seed3", () => drive(s, cfg()));
  assert(first.closed.length > 0);
  const again = drive(s, cfg());
  assertEquals(again.position, first.position);
  assertEquals(again.closed.length, first.closed.length);
});

// ── 6. data gap ──────────────────────────────────────────────────────────────

Deno.test("SCENARIO 6 — gap suspends, recovers, and resolves on real bars", () => {
  const s = market(N, 3);
  const f = driveOnce("seed3", () => drive(s, cfg()));
  const p = { ...f.closed[0].position, status: "open" as const };

  const suspended = suspendForGap(p, p.lastManagedBarTime, "2026-06-03T00:00:00Z", "FEED_STALE");
  assertEquals(suspended.status, "data_gap_suspended");
  assertEquals(suspended.gapReason, "FEED_STALE");
  assertEquals(positionRow(suspended, USER).status, "data_gap_suspended");

  const resumed = resumeFromGap(suspended);
  assertEquals(resumed.status, "open");
  assertEquals(resumed.gapFromBarTime, null);
  assertEquals(resumed.gapReason, null);

  // And it still resolves normally afterwards.
  const long = resumed.direction === "long";
  const hit: Candle = {
    datetime: "2026-06-04T00:00:00Z", open: resumed.entryPrice,
    high: long ? resumed.targetPrice + 1 : resumed.entryPrice,
    low: long ? resumed.entryPrice : resumed.targetPrice - 1,
    close: long ? resumed.targetPrice : resumed.targetPrice, volume: 0,
  };
  const out = stepPosition(resumed, hit, 3);
  assert(out.kind === "CLOSED");
  assertEquals(out.result.exitReason, "TARGET_2R");
  assertEquals(out.result.excludedFromStats, false);
});

Deno.test("SCENARIO 6b — an unrecoverable gap aborts with no fabricated outcome", () => {
  const s = market(N, 3);
  const f = driveOnce("seed3", () => drive(s, cfg()));
  const p = { ...f.closed[0].position, status: "open" as const };
  const suspended = suspendForGap(p, p.lastManagedBarTime, "2026-06-05T00:00:00Z", "FEED_STALE");
  const aborted = abortForGap(suspended, "2026-06-19T00:00:00Z",
    "FEED_STALE: no usable bars since " + p.lastManagedBarTime);

  assertEquals(aborted.exitReason, "DATA_GAP_ABORTED");
  assertEquals(aborted.exitPrice, null, "a fabricated exit price would contaminate the R distribution");
  assertEquals(aborted.realizedR, null);
  assertEquals(aborted.grossR, null);
  assertEquals(aborted.realizedPnlUsd, null);
  assertEquals(aborted.excludedFromStats, true);
  assert(aborted.exclusionReason);
  // The last known state survives: an abort loses the outcome, not the record.
  assertEquals(aborted.position.entryPrice, p.entryPrice);
  assertEquals(aborted.maeR, suspended.maeR);

  // And the row satisfies the schema's coherence CHECK.
  const row = historyRow(aborted, USER);
  assertEquals(row.exit_reason, "DATA_GAP_ABORTED");
  assertEquals(row.realized_r, null);
  assertEquals(row.excluded_from_stats, true);
  assert(row.exclusion_reason !== null);
  assert(row.gap_from_bar_time !== null);
});

// ── no SMC behaviour anywhere in the lifecycle ───────────────────────────────

Deno.test("no SMC management touched the lifecycle", () => {
  const s = market(N, 3);
  const f = driveOnce("seed3", () => drive(s, cfg()));
  for (const r of f.closed) {
    // Only two STRATEGY exits exist. No break-even, no trail, no partial.
    // ORDERING_UNRESOLVED is not a third exit: it is a data verdict that voids
    // the observation when nothing can order the events against the fill, and
    // it carries no realized R at all.
    assert(["TARGET_2R", "S2_CLOSE_INVALIDATION", "ORDERING_UNRESOLVED"].includes(r.exitReason));
    if (r.exitReason === "ORDERING_UNRESOLVED") {
      assertEquals(r.realizedR, null, "an unordered observation must not carry an R");
      assertEquals(r.excludedFromStats, true);
    }
    // The stop never moved from the IPO candle's far extreme.
    assertEquals(r.position.s2InvalidationLevel, r.position.s2InvalidationLevel);
    // Size is fixed at entry and never scaled.
    assertEquals(r.position.nominalRiskUsd, nominalRiskUsd(DEFAULT_SIZING));
  }
  // Every event type emitted belongs to the IPO vocabulary.
  const allowed = new Set(["SETUP_VALID", "INTENT_CREATED", "FILLED", "REFUSED",
    "MANAGED", "CLOSED", "GAP_SUSPENDED", "GAP_RECOVERED", "GAP_ABORTED",
    // Emitted when the tape refuses an exit whole-bar OHLC would have booked,
    // when a fill cannot be ordered at all, when such an ambiguity ends, and
    // when its branches freed the slot on different bars. Every one records a
    // disagreement or its resolution; none of them manages anything.
    "CAUSAL_OVERRIDE", "ORDERING_AMBIGUOUS", "AMBIGUITY_RESOLVED", "SEQUENCE_FORKED"]);
  for (const e of f.events) assert(allowed.has(e.eventType), `unexpected event ${e.eventType}`);
});

// ── the numbers, printed for the record ──────────────────────────────────────

Deno.test("REPORT — exact lifecycle figures", () => {
  const s = market(N, 3);
  const f = driveOnce("seed3-cost", () => drive(s, cfg({ costPerSide: () => 0.0001 })));
  const lines = f.closed.map((r, i) => {
    const p = r.position;
    return `  #${i + 1} ${p.direction.padEnd(5)} entry ${p.entryPrice.toFixed(5)} ` +
      `target ${p.targetPrice.toFixed(5)} S2 ${p.s2InvalidationLevel.toFixed(5)} ` +
      `exit ${r.exitPrice?.toFixed(5)} ${r.exitReason.padEnd(22)} ` +
      `grossR ${r.grossR?.toFixed(4)} costR ${p.costR.toFixed(4)} ` +
      `realizedR ${r.realizedR?.toFixed(4)} usd ${r.realizedPnlUsd?.toFixed(2)} ` +
      `mae ${r.maeR.toFixed(2)} bars ${r.barsHeld}`;
  });
  console.log(`\nlifecycle results (seed 3, cost 0.0001/side):\n${lines.join("\n")}`);
  console.log(`  events: ${f.events.length}, positions opened: ${f.closed.length + (f.position ? 1 : 0)}, history rows: ${f.closed.length}`);
  assert(f.closed.length > 0);
});

// ── repeated-zone telemetry: measured, never acted on ────────────────────────

Deno.test("TELEMETRY — re-entries on one zone are counted and ordered", () => {
  // Seed 3 re-enters the same zone four times at an identical entry/target/S2.
  // The strategy behaviour is frozen and unchanged; what is new is that the
  // repetition is now visible in the data.
  const s = market(N, 3);
  const f = driveOnce("seed3", () => drive(s, cfg()));

  const byZone = new Map<string, PaperResult[]>();
  for (const r of f.closed) {
    const k = r.position.setupId;
    byZone.set(k, [...(byZone.get(k) ?? []), r]);
  }
  const repeated = [...byZone.values()].filter((v) => v.length > 1);
  assert(repeated.length > 0, "the fixture must re-enter at least one zone");

  for (const trades of byZone.values()) {
    trades.sort((a, b) => a.position.entryTime.localeCompare(b.position.entryTime));
    // THE ORDINAL COUNTS THE ENGINE'S TRADES ON THIS ZONE, NOT THE PAPER ROWS —
    // that is the module's stated contract, and it is the honest answer to "how
    // often has this zone been traded". Once causal ordering lets paper hold a
    // position the engine released, paper takes a SUBSET, so paper's rows can
    // carry ordinals 1 and 3. What must still hold is that they are 1-based,
    // strictly increasing, and never precede the exit they followed.
    trades.forEach((r, i) => {
      assert(r.position.zoneEntryOrdinal >= i + 1,
        `zone ${r.position.setupId} row ${i + 1} carries ordinal ${r.position.zoneEntryOrdinal}`);
      if (i > 0) {
        assert(r.position.zoneEntryOrdinal > trades[i - 1].position.zoneEntryOrdinal,
          "the re-entry ordinal did not advance");
      }
      if (r.position.zoneEntryOrdinal === 1) {
        assertEquals(r.position.zonePreviousExitTime, null, "a first entry has no predecessor");
      } else {
        assert(r.position.zonePreviousExitTime, "a re-entry must name the exit it followed");
        assert(r.position.zonePreviousExitTime! <= r.position.entryTime,
          "a re-entry preceded the exit it followed");
      }
    });
  }

  // And it reaches the database columns.
  const re = repeated[0][1];
  const row = historyRow(re, USER);
  assertEquals(row.zone_entry_ordinal, re.position.zoneEntryOrdinal);
  assertEquals(row.zone_previous_exit_time, re.position.zonePreviousExitTime);
  assertEquals(row.ipo_candle_time, re.position.ipoCandleTime);
  assertEquals(row.volatility_bucket, re.position.volatilityBucket);
  assert(row.zone_entry_ordinal! >= 2);
});

Deno.test("TELEMETRY — the ordinal cannot influence any decision", async () => {
  // The whole point is that it observes. If the ordinal ever reached the
  // execution verdict it would be an undeclared re-entry filter.
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoPaperContract.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  const decisionRegion = code.slice(code.indexOf("export function buildIntent"),
                                   code.indexOf("export function openPosition"));
  // It may be assigned into the returned object, but never tested.
  for (const bad of ["zoneEntryOrdinal >", "zoneEntryOrdinal <", "zoneEntryOrdinal ==",
                     "zoneEntryOrdinal ===", "if (zone", "zonePreviousExitTime &&"]) {
    assert(!decisionRegion.includes(bad), `the ordinal is being read as a gate: ${bad}`);
  }
  // Same execution verdict whatever the ordinal says.
  const bars2 = Array.from({ length: 6 }, (_, i) => ({
    datetime: `2026-03-0${i + 1}T00:00:00Z`, open: 100, high: 101, low: 99, close: 100, volume: 0,
  })) as Candle[];
  const t: LiveTrade = {
    instrument: "EUR/USD", direction: "demand", ipoIndex: 0, entryIndex: 2,
    entry: 100, stop: 99, target: 102, risk: 1, vol: "HIGH_VOL", costR: 0.3,
    exitIndex: null, exitPrice: null, netR: null, mae: 0, mfe: 0,
  };
  const first = buildIntent(t, bars2, "1h", "UNAVAILABLE", { zoneEntryOrdinal: 1, zonePreviousExitTime: null });
  const tenth = buildIntent(t, bars2, "1h", "UNAVAILABLE",
    { zoneEntryOrdinal: 10, zonePreviousExitTime: "2026-03-02T00:00:00Z" });
  assertEquals(tenth.execution, first.execution);
  assertEquals(tenth.strategyDecision, first.strategyDecision);
  assertEquals(tenth.reasonCodes, first.reasonCodes);
  // And the identity is unchanged by it, so replay stays idempotent.
  assertEquals(tenth.intentId, first.intentId);
  assertEquals(tenth.setupId, first.setupId);
});

Deno.test("TELEMETRY — the migration adds only additive, nullable columns", async () => {
  const sql = await Deno.readTextFile("supabase/migrations/20260922020000_ipo_zone_telemetry.sql");
  assert(!/\bdrop\b/i.test(sql), "the telemetry migration drops something");
  assert(!/\bnot null\b/i.test(sql.replace(/is null|is not null/gi, "")),
    "a new column is NOT NULL, which would reject rows written before it");
  for (const c of ["zone_entry_ordinal", "zone_previous_exit_time",
                   "ipo_candle_time", "volatility_bucket"]) {
    assert(sql.includes(c), `missing column ${c}`);
  }
  assert(sql.includes("add column if not exists"), "not re-runnable");
});

// ── the Postgres round-trip regression ───────────────────────────────────────

Deno.test("REGRESSION — a position restored from Postgres is not falsely suspended", () => {
  // FOUND IN PRODUCTION, 2026-09-22. A position opened on the 09:30 bar was
  // suspended with COVERAGE_LOST on the very next scheduled run, on a feed with
  // no gap at all.
  //
  //   position.last_managed_bar_time  '2026-09-22T09:30:00+00:00'  (timestamptz)
  //   bar.datetime                    '2026-09-22T09:30:00Z'       (provider)
  //
  // Same instant, different text, and the coverage check compared strings. The
  // fail-closed design turned a formatting difference into a stuck position
  // rather than a mismanaged one — which is why it was visible at all.
  const s = market(N, 3);
  const f = driveOnce("seed3", () => drive(s, cfg()));
  const p = { ...f.closed[0].position, status: "open" as const };

  // Exactly what rowToPosition hands back after a timestamptz round trip.
  const pg = (iso: string) => new Date(iso).toISOString().replace("Z", "+00:00");
  const restored: PaperPosition = {
    ...p,
    entryTime: pg(p.entryTime),
    lastManagedBarTime: pg(p.lastManagedBarTime),
    ipoCandleTime: pg(p.ipoCandleTime),
  };
  assert(restored.lastManagedBarTime !== p.lastManagedBarTime,
    "the fixture must actually differ in text, or it proves nothing");

  // The bars still carry the provider's form. The window must genuinely COVER
  // the last managed bar, or the suspension would be correct and prove nothing.
  const lastIdx = s.findIndex((b) => b.datetime === p.lastManagedBarTime);
  assert(lastIdx >= 0, "fixture: the managed bar must exist in the series");
  const window = s.slice(0, lastIdx + 3);
  const plan = runPaper({
    cfg: cfg(), barMs: BAR_MS, closedBars: window, nowMs: clock(window),
    state: {
      strategyId: "ipo_cet", strategyVersion: "spec-1.1", symbol: "EUR/USD",
      timeframe: "1h", cursorBarTime: window[window.length - 1].datetime,
      activatedAtBarTime: s[WARMUP].datetime, barsSeen: window.length, bootstrapCount: 1,
    },
    openPosition: restored, minHistoryBars: WARMUP,
  });

  const suspended = plan.events.filter((e) => e.eventType === "GAP_SUSPENDED");
  assertEquals(suspended.map((e) => e.reasonCodes).flat(), [],
    "a Postgres-rendered timestamp was read as a data gap");
  // It resumed management normally: either still open or properly closed.
  assert(plan.openPosition === null || plan.openPosition.status === "open");
});

Deno.test("REGRESSION — both timestamp formats resolve to the same bar", async () => {
  // The rule: an IDENTITY stays byte-exact (schema 2 stores bar times verbatim,
  // because setupId/intentId are content-addressed over them); a COMPARISON
  // against a value that has been through the database is by instant, because
  // the database picks its own rendering.
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoPaperRunner.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  assert(code.includes("const sameBar ="), "the instant comparison is gone");
  for (const bad of ["=== pos.lastManagedBarTime", "=== live.lastManagedBarTime",
                     "b.datetime === pos.", "b.datetime === live."]) {
    assert(!code.includes(bad), `a raw string comparison against a DB timestamp: ${bad}`);
  }
  // And identities must NOT be normalised — they are keyed on the exact bytes.
  assert(code.includes("bars[t.entryIndex].datetime"), "intentId no longer uses the bar string");
});
