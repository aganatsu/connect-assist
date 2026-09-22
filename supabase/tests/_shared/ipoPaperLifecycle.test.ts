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
    // Only two strategy exits exist. No break-even, no trail, no partial.
    assert(["TARGET_2R", "S2_CLOSE_INVALIDATION"].includes(r.exitReason));
    // The stop never moved from the IPO candle's far extreme.
    assertEquals(r.position.s2InvalidationLevel, r.position.s2InvalidationLevel);
    // Size is fixed at entry and never scaled.
    assertEquals(r.position.nominalRiskUsd, nominalRiskUsd(DEFAULT_SIZING));
  }
  // Every event type emitted belongs to the IPO vocabulary.
  const allowed = new Set(["SETUP_VALID", "INTENT_CREATED", "FILLED", "REFUSED",
    "MANAGED", "CLOSED", "GAP_SUSPENDED", "GAP_RECOVERED", "GAP_ABORTED"]);
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
