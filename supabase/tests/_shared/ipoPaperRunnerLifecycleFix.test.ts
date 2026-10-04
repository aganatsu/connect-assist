/**
 * IPO_PAPER_RUNNER_LIFECYCLE_FIX_V1.
 *
 * Two defects, one safety switch:
 *
 *   1. The runner reloaded only `open` and `data_gap_suspended` positions, so an
 *      `ordering_ambiguous` position — one branch of an unorderable fill still
 *      running — was never managed again and its slot was silently freed
 *      (USD/JPY, filled 2026-10-01 15:38).
 *   2. Even when managed, an ambiguous position's open branch resumed at the bar
 *      AFTER its entry bar, so whatever it lived through in the rest of that
 *      bar (a target three minutes later; the bar's own close beyond S2) was lost.
 *   3. New entries can be paused by configuration; management continues.
 *
 * Everything here drives the real runner, contract and row mappers.
 */

import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runPaper, openBranchRemainder, RUNNER_LIFECYCLE_VERSION, type PaperEvent, type RuntimeState } from "../../functions/_shared/ipoPaperRunner.ts";
import {
  ACTIVE_POSITION_STATUSES, buildIntent, openPosition, openAmbiguous, altTargetNetR, STRATEGY_VERSION,
  type PaperPosition, type PaperResult,
} from "../../functions/_shared/ipoPaperContract.ts";
import { positionRow, rowToPosition, entriesPausedFromEnv } from "../../functions/ipo-paper-runner/index.ts";
import type { EngineConfig, LiveTrade } from "../../functions/_shared/ipoLiveEngine.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const T0 = Date.UTC(2025, 0, 1);
const H = 3_600_000, MIN = 60_000;
const USER = "57c79dee-db6b-4fae-b34a-4b64ce33ca34";
const iso = (ms: number) => new Date(ms).toISOString();
const cfg = (over: Partial<EngineConfig> = {}): EngineConfig =>
  ({ instrument: "EUR/USD", timeframe: "1h", highVolOnly: false, costPerSide: () => 0, ...over });
const evTypes = (es: PaperEvent[]) => es.map((e) => e.eventType);

// ── a quiet synthetic market, so only the engineered bars resolve anything ──
const N = 140, E = 120;                    // E = the ambiguous position's entry bar
function quiet(n = N): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const o = 100 + (i % 2 ? 0.05 : -0.05), c = 100 + (i % 2 ? -0.05 : 0.05);
    return { datetime: iso(T0 + i * H), open: o, high: 100.1, low: 99.9, close: c, volume: 0 } as Candle;
  });
}
// Long: entry 100.00 (the 50% level), S2 99.70, target 100.60.
const LV = { entry: 100.0, stop: 99.7, target: 100.6, risk: 0.3 };

function trade(bars: Candle[], entryIndex: number, over: Partial<typeof LV> = {}): LiveTrade {
  const l = { ...LV, ...over };
  return { instrument: "EUR/USD", direction: "demand", ipoIndex: entryIndex - 3, entryIndex,
    entry: l.entry, stop: l.stop, target: l.target, risk: l.risk, vol: "HIGH_VOL", costR: 0.1,
    exitIndex: null, exitPrice: null, netR: null, mae: 0, mfe: 0 } as LiveTrade;
}
/** An ambiguous position exactly as the runner creates one: entry and target in one minute. */
function ambiguous(bars: Candle[], entryIndex = E, atMinute = 5, over: Partial<typeof LV> = {}): PaperPosition {
  const intent = buildIntent(trade(bars, entryIndex, over), bars, "1h");
  const at = iso(Date.parse(bars[entryIndex].datetime) + atMinute * MIN);
  const priced = openPosition(intent, undefined, {
    causalExecutionVersion: "1m-ordering-v1", entryMinuteTime: at, entryResolutionMethod: "ORDERING_UNRESOLVED",
    htfSource: "fixture", minuteSource: "fixture", dailyStructure: null, dailyStructureAlignment: null, dailyStructureAsOf: null,
  });
  return openAmbiguous(priced, {
    kind: "ENTRY_VS_TARGET_SAME_MINUTE", atTime: at, altBranch: "CLOSED_AT_TARGET",
    altExitTime: bars[entryIndex].datetime, altExitPrice: priced.targetPrice, altNetR: altTargetNetR(priced),
    altFreedAtBarTime: bars[entryIndex].datetime, detail: "fixture: entry and target in one minute",
  });
}
/** Flat point-minutes over a bar, with chosen minutes overridden. */
function minutesOf(b: Candle, over: Record<number, Partial<Candle>> = {}): Candle[] {
  const t0 = Date.parse(b.datetime);
  return Array.from({ length: 60 }, (_, i) => ({
    datetime: iso(t0 + i * MIN), open: 100.02, high: 100.03, low: 100.01, close: 100.02, volume: 0, ...(over[i] ?? {}),
  } as Candle));
}
const run = (bars: Candle[], pos: PaperPosition | null, extra: Partial<Parameters<typeof runPaper>[0]> = {}) =>
  runPaper({ cfg: cfg(), barMs: H, closedBars: bars, nowMs: Date.parse(bars[bars.length - 1].datetime) + 2 * H,
    state: null, openPosition: pos, minHistoryBars: 100, ...extra });

// ═══ 1. reloaded on the next cycle ════════════════════════════════════════
Deno.test("1a — the reload set is exactly the slot-occupying set the database index covers", () => {
  const sql = Deno.readTextFileSync(new URL("../../migrations/20260924120000_ipo_causal_execution_ordering.sql", import.meta.url));
  const idx = sql.slice(sql.indexOf("create unique index if not exists ipo_paper_positions_one_open"));
  const inDb = [...idx.slice(0, idx.indexOf(";")).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assertEquals([...ACTIVE_POSITION_STATUSES].sort(), inDb);
  assert(ACTIVE_POSITION_STATUSES.includes("ordering_ambiguous"));
});

Deno.test("1b — the handler's reload query uses that set, and the two-status filter is gone", () => {
  const src = Deno.readTextFileSync(new URL("../../functions/ipo-paper-runner/index.ts", import.meta.url));
  assert(/\.in\("status", \[\.\.\.ACTIVE_POSITION_STATUSES\]\)/.test(src), "reload query must use ACTIVE_POSITION_STATUSES");
  assert(!/\.in\("status", \["open", "data_gap_suspended"\]\)/.test(src), "the old two-status filter must not survive");
});

Deno.test("1c — an ambiguous position survives the database round trip and is managed on the next run", () => {
  const bars = quiet();
  const pos = ambiguous(bars);
  const restored = rowToPosition({ ...positionRow(pos, USER), exclusion_reason: pos.ambiguity!.detail })!;
  assertEquals(restored.status, "ordering_ambiguous");
  assertEquals(restored.ambiguity?.kind, "ENTRY_VS_TARGET_SAME_MINUTE");
  assertEquals(restored.ambiguity?.altFreedAtBarTime, pos.ambiguity!.altFreedAtBarTime);
  const plan = run(bars, restored, { minuteBars: minutesOf(bars[E]) });
  assertEquals(plan.divergence, null);
  assert(evTypes(plan.events).includes("MANAGED"), "it was advanced over the later bars");
  assertEquals(plan.openPosition?.status, "ordering_ambiguous");
  assertEquals(plan.openPosition?.lastManagedBarTime, bars[N - 1].datetime);
});

// ═══ 2 + 5. it keeps the slot while unresolved ═══════════════════════════════
const BAR_MS = H;
function market(n: number, seed = 7): Candle[] {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const out: Candle[] = []; let p = 100;
  for (let i = 0; i < n; i++) {
    const vol = 0.3 + Math.abs(Math.sin(i / 90)) * 1.4, o = p;
    p = Math.max(1, p + (rnd() - 0.5) * vol * 2);
    out.push({ datetime: iso(T0 + i * BAR_MS), open: o, high: Math.max(o, p) + rnd() * vol, low: Math.min(o, p) - rnd() * vol, close: p, volume: 0 } as Candle);
  }
  return out;
}
function tape(bars: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const b of bars) {
    const t0 = Date.parse(b.datetime), up = b.close >= b.open;
    [b.open, up ? b.low : b.high, up ? b.high : b.low, b.close].forEach((px, i) =>
      out.push({ datetime: iso(t0 + i * 15 * MIN), open: px, high: px, low: px, close: px, volume: 0 } as Candle));
  }
  return out;
}
interface Driven { closed: PaperResult[]; events: PaperEvent[]; state: RuntimeState | null; position: PaperPosition | null }
function drive(s: Candle[], polls: number[], o: { paused?: boolean; state?: RuntimeState | null; position?: PaperPosition | null } = {}): Driven {
  let state = o.state ?? null, position = o.position ?? null;
  const closed: PaperResult[] = [], events: PaperEvent[] = [];
  for (const i of polls) {
    const closedBars = s.slice(0, i + 1);
    const plan = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars, nowMs: Date.parse(closedBars[i].datetime) + 2 * BAR_MS,
      state, openPosition: position, minHistoryBars: 100, minuteBars: tape(closedBars), entriesPaused: o.paused });
    assertEquals(plan.divergence, null, `bar ${i}: ${plan.divergence}`);
    state = plan.state; position = plan.openPosition; closed.push(...plan.closed); events.push(...plan.events);
  }
  return { closed, events, state, position };
}
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const S = market(220);
let _base: Driven | null = null;
const base = () => (_base ??= drive(S, range(100, 219)));
const firstFillBar = () => {
  const f = base().events.find((e) => e.eventType === "FILLED")!;
  return S.findIndex((b) => b.datetime === f.barTime);
};

Deno.test("2 + 5 — an unresolved ambiguous position blocks the next entry and stays ordering_ambiguous", () => {
  const F = firstFillBar();
  assert(F > 105, `fixture must trade (first fill bar ${F})`);
  const before = drive(S, range(100, F - 1));
  assertEquals(before.position, null);
  // an ambiguous position opened a few bars earlier whose levels nothing reaches
  const p0 = S[F - 4].close;
  const amb = ambiguous(S, F - 4, 1, { entry: p0, stop: p0 - 60, target: p0 + 120, risk: 60 });
  const held = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: S.slice(0, F + 1), nowMs: Date.parse(S[F].datetime) + 2 * BAR_MS,
    state: before.state, openPosition: amb, minHistoryBars: 100, minuteBars: tape(S.slice(0, F + 1)) });
  const free = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: S.slice(0, F + 1), nowMs: Date.parse(S[F].datetime) + 2 * BAR_MS,
    state: before.state, openPosition: null, minHistoryBars: 100, minuteBars: tape(S.slice(0, F + 1)) });
  assert(evTypes(free.events).includes("FILLED"), "control: with the slot free this bar fills");
  assert(!evTypes(held.events).includes("FILLED"), "the ambiguous position holds the slot");
  assertEquals(held.openPosition?.intentId, amb.intentId);
  assertEquals(held.openPosition?.status, "ordering_ambiguous");
  // and a second cycle still holds it
  const again = runPaper({ cfg: cfg(), barMs: BAR_MS, closedBars: S.slice(0, F + 2), nowMs: Date.parse(S[F + 1].datetime) + 2 * BAR_MS,
    state: held.state, openPosition: held.openPosition, minHistoryBars: 100, minuteBars: tape(S.slice(0, F + 2)) });
  assertEquals(again.openPosition?.status, "ordering_ambiguous");
  assert(!evTypes(again.events).includes("FILLED"));
});

// ═══ 3. later evidence proves the target ═════════════════════════════════════
Deno.test("3 — a later bar reaching the target settles it CONVERGED at +2R gross, counted", () => {
  const bars = quiet();
  bars[E + 5] = { ...bars[E + 5], high: 100.7, close: 100.2 };
  const plan = run(bars, ambiguous(bars), { minuteBars: minutesOf(bars[E]) });
  assertEquals(plan.openPosition, null, "slot freed");
  const r = plan.closed[0];
  assertEquals(r.exitReason, "TARGET_2R");
  assertEquals(r.ambiguityResolution, "CONVERGED_SAME_OUTCOME");
  assertEquals(r.excludedFromStats, false);
  assertEquals(r.exitTime, bars[E + 5].datetime);
  assert(Math.abs(r.realizedR! - (2 - 0.1)) < 1e-9);
});

Deno.test("3b — a target touched later in the ENTRY bar (after the ambiguous minute) settles on that bar", () => {
  const bars = quiet();
  bars[E] = { ...bars[E], high: 100.7 };
  const mins = minutesOf(bars[E], { 5: { high: 100.65, low: 99.98 }, 20: { high: 100.7 } });
  const plan = run(bars, ambiguous(bars), { minuteBars: mins });
  const r = plan.closed[0];
  assertEquals(r.exitReason, "TARGET_2R");
  assertEquals(r.exitTime, bars[E].datetime, "closed on its own entry bar");
  assertEquals(r.targetMinuteTime, iso(Date.parse(bars[E].datetime) + 20 * MIN));
  assertEquals(r.ambiguityResolution, "CONVERGED_SAME_OUTCOME");
});

// ═══ 4. later evidence proves the loss branch ════════════════════════════════
Deno.test("4 — a later close beyond S2 ends it DIVERGED: slot freed, branches recorded, no R claimed", () => {
  const bars = quiet();
  bars[E + 5] = { ...bars[E + 5], low: 99.5, close: 99.6 };
  const plan = run(bars, ambiguous(bars), { minuteBars: minutesOf(bars[E]) });
  assertEquals(plan.openPosition, null);
  const r = plan.closed[0];
  assertEquals(r.ambiguityResolution, "DIVERGED_TERMINAL");
  assertEquals(r.branchOutcomes, "TARGET_2R | S2_CLOSE_INVALIDATION");
  assertEquals(r.exitReason, "ORDERING_UNRESOLVED");
  assertEquals(r.realizedR, null);
  assertEquals(r.excludedFromStats, true);
});

Deno.test("4b — the entry bar's own close beyond S2 ends the open branch on that bar", () => {
  const bars = quiet();
  bars[E] = { ...bars[E], low: 99.5, close: 99.6 };
  const plan = run(bars, ambiguous(bars), { minuteBars: minutesOf(bars[E], { 59: { low: 99.55, close: 99.6 } }) });
  const r = plan.closed[0];
  assertEquals(r.exitTime, bars[E].datetime);
  assertEquals(r.branchOutcomes, "TARGET_2R | S2_CLOSE_INVALIDATION");
  assertEquals(r.realizedR, null);
});

// ═══ 5 (cont.). without a tape nothing is invented ═══════════════════════════
Deno.test("5b — no tape for the entry bar: defer while one can be fetched; then only the close decides", () => {
  const bars = quiet();
  const pos = ambiguous(bars);
  const provisional = run(bars, pos, { minutesFinal: false });
  assertEquals(provisional.provisional, true);
  assertEquals(provisional.minutesNeeded[0].barTime, bars[E].datetime);
  assertEquals(provisional.openPosition?.lastManagedBarTime, pos.lastManagedBarTime, "a provisional plan advances nothing");
  const final = run(bars, pos, { minutesFinal: true });
  assertEquals(final.openPosition?.status, "ordering_ambiguous", "close inside S2: the open branch holds");
  const r = openBranchRemainder(pos, { ...bars[E], close: 99.6 }, H, undefined, true, []);
  assertEquals(r?.ordering.kind, "UNRESOLVED_TERMINAL", "close beyond S2 ends every branch, with no R");
});

Deno.test("5c — re-running the same bars does not re-close or double count", () => {
  const bars = quiet();
  bars[E + 5] = { ...bars[E + 5], high: 100.7, close: 100.2 };
  const once = run(bars.slice(0, E + 3), ambiguous(bars), { minuteBars: minutesOf(bars[E]) });
  const twice = run(bars.slice(0, E + 3), once.openPosition, { minuteBars: minutesOf(bars[E]) });
  assertEquals(twice.openPosition?.status, "ordering_ambiguous");
  assertEquals(twice.closed.length, 0);
  const done = run(bars, twice.openPosition, { minuteBars: minutesOf(bars[E]) });
  assertEquals(done.closed.length, 1);
});

// ═══ 6 + 7. open and data_gap_suspended behave as before ═════════════════════
Deno.test("6 — an OPEN position never gets the entry-bar remainder: its fill bar was resolved at fill time", () => {
  const bars = quiet();
  bars[E] = { ...bars[E], high: 100.7 };
  const open = openPosition(buildIntent(trade(bars, E), bars, "1h"));
  assertEquals(open.status, "open");
  const plan = run(bars, open, { minuteBars: minutesOf(bars[E], { 20: { high: 100.7 } }) });
  assertEquals(plan.closed.length, 0, "no re-evaluation of the entry bar");
  assertEquals(plan.openPosition?.status, "open");
  assertEquals(plan.openPosition?.lastManagedBarTime, bars[N - 1].datetime);
});

Deno.test("7 — a stale feed suspends an ambiguous position and recovery restores ordering_ambiguous", () => {
  const bars = quiet();
  const amb = ambiguous(bars);
  const stale = run(bars, amb, { minuteBars: minutesOf(bars[E]), nowMs: Date.parse(bars[N - 1].datetime) + 10 * 24 * H });
  assertEquals(stale.openPosition?.status, "data_gap_suspended");
  assert(stale.openPosition?.ambiguity, "the branch is kept through the gap");
  assert(ACTIVE_POSITION_STATUSES.includes("data_gap_suspended"));
  const back = run(bars, stale.openPosition, { minuteBars: minutesOf(bars[E]) });
  assert(evTypes(back.events).includes("GAP_RECOVERED"));
  assertEquals(back.openPosition?.status, "ordering_ambiguous");
});

// ═══ 8–10. the pause ══════════════════════════════════════════════════════════
Deno.test("8 — paused, no new entry opens; each would-be entry is audited as REFUSED (ENTRIES_PAUSED)", () => {
  const paused = drive(S, range(100, 219), { paused: true });
  const fills = base().events.filter((e) => e.eventType === "FILLED");
  assert(fills.length > 0, "control: unpaused, the fixture trades");
  assertEquals(paused.events.filter((e) => e.eventType === "FILLED").length, 0);
  assertEquals(paused.closed.length, 0);
  assertEquals(paused.position, null);
  const refused = paused.events.filter((e) => e.eventType === "REFUSED" && e.reasonCodes.includes("ENTRIES_PAUSED"));
  for (const f of fills) assert(refused.some((r) => r.intentId === f.intentId), `fill ${f.intentId} must be refused when paused`);
});

Deno.test("9 — paused, an existing position is still managed to its terminal state", () => {
  const F = firstFillBar();
  const upTo = drive(S, range(100, F));
  assert(upTo.position, "a position is open after the first fill");
  const target = base().closed.find((r) => r.position.intentId === upTo.position!.intentId)!;
  assert(target, "the unpaused run closes it");
  const rest = drive(S, range(F + 1, 219), { paused: true, state: upTo.state, position: upTo.position });
  const got = rest.closed.find((r) => r.position.intentId === upTo.position!.intentId)!;
  assert(got, "still closed while paused");
  assertEquals([got.exitTime, got.exitReason, got.realizedR], [target.exitTime, target.exitReason, target.realizedR]);
});

Deno.test("10 — the pause deletes nothing and rewrites no history; it is configuration, fail-safe", () => {
  // held position carried unchanged in identity while paused
  const bars = quiet();
  const amb = ambiguous(bars);
  const plan = run(bars, amb, { minuteBars: minutesOf(bars[E]), entriesPaused: true });
  assertEquals(plan.openPosition?.intentId, amb.intentId);
  assertEquals(plan.closed.length, 0);
  // the flag only reaches runPaper and the response — no write path keys on it
  const src = Deno.readTextFileSync(new URL("../../functions/ipo-paper-runner/index.ts", import.meta.url));
  const uses = src.split("\n").filter((l) => /\bentriesPaused\b/.test(l) && !l.trim().startsWith("*") && !l.trim().startsWith("//"));
  assertEquals(uses.length, 3, uses.join("\n"));
  assert(uses.every((l) => !/delete|update\(|upsert|insert/.test(l)));
  // fail-safe parsing: only an explicit "enabled" resumes entries
  for (const v of [undefined, "", "true", "1", "yes", "paused", "disabled"]) assertEquals(entriesPausedFromEnv(() => v), true, String(v));
  for (const v of ["enabled", "ENABLED", " enabled "]) assertEquals(entriesPausedFromEnv(() => v), false, v);
});

Deno.test("versioning: a lifecycle fix label, the strategy version untouched", () => {
  assertEquals(RUNNER_LIFECYCLE_VERSION, "IPO_PAPER_RUNNER_LIFECYCLE_FIX_V1");
  assertEquals(STRATEGY_VERSION, "spec-1.1");
  assertNotEquals(RUNNER_LIFECYCLE_VERSION, STRATEGY_VERSION);
});
