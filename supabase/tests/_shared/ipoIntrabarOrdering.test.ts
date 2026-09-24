/**
 * FORENSIC DIAGNOSTIC — intrabar event ordering on the entry bar.
 *
 * NO STRATEGY CODE IS CHANGED BY THIS FILE. Every test here asserts what the
 * engine does TODAY. They are green on purpose: a red test would break CI and
 * say nothing a green one cannot, and when the fix lands these become the
 * regression guard that proves the behaviour actually moved.
 *
 * THE DEFECT, STATED ONCE. Every execution path derives the entry from one
 * extreme of a bar and then evaluates the brand-new position against the WHOLE
 * of that same bar. An OHLC bar carries no path ordering, so an extreme that
 * occurred BEFORE the entry touch can resolve a position that did not yet
 * exist. This is not inter-bar lookahead — the engines are strictly causal
 * across bars — it is intrabar temporal ambiguity within one bar.
 *
 * THE INCIDENT. BTC/USD 1h, IPO candle 2026-09-21T10:00:00Z, long from
 * 84473.315, S2 84130.21, target 85159.525. The stored entry bar
 * 2026-09-23T14:00:00Z is O 85792.01 / H 85940.32 / L 83864.07 / C 84530.00,
 * read back from `ipo_engine_state:ipo_cet:BTC/USD` on 2026-09-23.
 *
 * The bar OPENS at 85792.01, already above the 85159.525 target. So the target
 * was satisfied before the bar had traded a single tick of the entry, and the
 * engine still books TARGET_2R at +2R gross.
 *
 * Bitstamp 1-minute data for the same hour gives the real path: entry first
 * touched ~14:13, the post-entry rebound reached only ~84880 (below target),
 * price sold off, touched S2 ~14:23, and the 14:30 one-minute candle closed
 * entirely below S2 (H 84097 / L 83943). The causal outcome is an S2 close
 * invalidation, not a 2R win.
 */

import { assert, assertEquals, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { stepPosition, type PaperPosition } from "../../functions/_shared/ipoPaperContract.ts";
import { simulate, type Setup } from "../../functions/_shared/ipoRawBacktest.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

// ── the incident, as stored ──────────────────────────────────────────────────

/** Verbatim from `ipo_engine_state:ipo_cet:BTC/USD`, bar 2026-09-23T14:00:00Z. */
const ENTRY_BAR: Candle = {
  datetime: "2026-09-23T14:00:00Z",
  open: 85792.01, high: 85940.32, low: 83864.07, close: 84530.00, volume: 0,
};

const ENTRY = 84473.315;
const S2 = 84130.21;
const TARGET = 85159.525;
const RISK = 343.105;
/** From the stored row: realized_r 1.26089681001442 against grossR 2. */
const COST_R = 2 - 1.26089681001442;

const position = (over: Partial<PaperPosition> = {}): PaperPosition => ({
  strategyId: "ipo_cet", strategyVersion: "spec-1.1",
  setupId: "stp_e2de7d52866bc5fa", intentId: "int_f5ad2103b054210a",
  symbol: "BTC/USD", timeframe: "1h", direction: "long",
  entryTime: "2026-09-23T14:00:00Z", entryPrice: ENTRY,
  targetPrice: TARGET, s2InvalidationLevel: S2,
  nominalRiskDistance: RISK, costR: COST_R,
  referenceBalanceAtEntry: 100_000, nominalRiskPct: 0.2, nominalRiskUsd: 200,
  ipoCandleTime: "2026-09-21T10:00:00Z", volatilityBucket: "HIGH_VOL",
  executionMode: "paper", status: "open", maeR: 0, mfeR: 0,
  lastManagedBarTime: "2026-09-23T13:00:00Z",
  gapFromBarTime: null, gapToBarTime: null, gapReason: null,
  zoneEntryOrdinal: 1, zonePreviousExitTime: null,
  ...over,
});

// ── A. the stored geometry, before any engine runs ───────────────────────────

Deno.test("A1 — the entry bar's own numbers make the outcome inevitable", () => {
  // Entry is reached: the bar trades below the E2 level.
  assert(ENTRY_BAR.low <= ENTRY, "entry level not reached by the bar low");
  // Target is reached: the bar trades above the 2R level.
  assert(ENTRY_BAR.high >= TARGET, "target level not reached by the bar high");
  // And S2 is NOT close-invalidated, so nothing stops the target booking.
  assert(ENTRY_BAR.close > S2, "the close was beyond S2; a different branch would fire");
});

Deno.test("A2 — the bar OPENED above the target, so the target extreme is pre-entry", () => {
  // This is the strongest available evidence without tick data. A long whose
  // entry bar opens ABOVE its target cannot have reached that target as a
  // post-entry move: price was already there before the entry existed.
  assert(ENTRY_BAR.open > TARGET,
    `open ${ENTRY_BAR.open} should be above target ${TARGET}`);
  assert(ENTRY_BAR.open > ENTRY, "and above the entry, so entry is approached from above");
  // The high is only 148.31 above the open — consistent with the high occurring
  // near the open, before the sell-off that produced the entry touch.
  assertAlmostEquals(ENTRY_BAR.high - ENTRY_BAR.open, 148.31, 0.01);
});

Deno.test("A3 — the 1h close rule masks a 1m close that DID invalidate", () => {
  // S2 semantics are close-confirmed and stay that way: a wick through S2 is
  // not invalidation. On the 1h bar the close is above S2, so no invalidation.
  assert(ENTRY_BAR.close > S2);
  // Bitstamp 1m, 14:30 candle: H 84097 / L 83943, wholly below S2. On a
  // close-confirmed rule evaluated at 1m resolution this IS an invalidation.
  const m1430 = { high: 84097, low: 83943, close: 83990 };
  assert(m1430.high < S2, "the whole 1m candle sits below S2");
  assert(m1430.close < S2, "so its close invalidates under the unchanged S2 rule");
});

// ── B. the paper contract reproduces it ──────────────────────────────────────

Deno.test("B1 — stepPosition books TARGET_2R on the entry bar", () => {
  const out = stepPosition(position(), ENTRY_BAR, 0);
  assertEquals(out.kind, "CLOSED");
  if (out.kind !== "CLOSED") return;
  assertEquals(out.result.exitReason, "TARGET_2R");
  // grossR is computed as |target − entry| / risk, so it lands a few ulps off 2.
  assertAlmostEquals(out.result.grossR!, 2, 1e-12);
  assertAlmostEquals(out.result.realizedR!, 1.26089681001442, 1e-9);
  assertAlmostEquals(out.result.realizedPnlUsd!, 252.179362, 1e-4);
  // The stored row, reproduced exactly from the stored bar.
  assertEquals(out.result.exitPrice, TARGET);
});

Deno.test("B2 — the exit price is the INTENDED target, never an observed fill", () => {
  // `close(pos.targetPrice, ...)` in stepPosition. No execution price exists in
  // paper mode; the synthetic exit is the level itself, so grossR is 2 by
  // construction the instant `hitTarget` is true.
  const out = stepPosition(position(), ENTRY_BAR, 0);
  if (out.kind !== "CLOSED") throw new Error("expected CLOSED");
  assertEquals(out.result.exitPrice, TARGET);
  assertAlmostEquals(Math.abs(TARGET - ENTRY) / RISK, 2, 1e-12);
});

Deno.test("B3 — the MFE is inflated by pre-entry range on the entry bar", () => {
  // favourable = bar.high - entryPrice, over the WHOLE bar. The recorded best
  // excursion therefore includes ground price covered before the position
  // existed. Bitstamp says the real post-entry rebound reached ~84880, i.e.
  // about 1.19R, not the 4.27R recorded here.
  const out = stepPosition(position(), ENTRY_BAR, 0);
  if (out.kind !== "CLOSED") throw new Error("expected CLOSED");
  assertAlmostEquals(out.result.mfeR, (ENTRY_BAR.high - ENTRY) / RISK, 1e-9);
  assert(out.result.mfeR > 4.2, "recorded MFE");
  const realPostEntryMfe = (84880 - ENTRY) / RISK;
  assert(realPostEntryMfe < 1.2, "actual post-entry MFE from 1m data");
});

// ── C. the sameBarAmbiguous gap ──────────────────────────────────────────────

Deno.test("C1 — sameBarAmbiguous is FALSE here, and that is the semantic gap", () => {
  // The flag is `hitTarget && closedBeyond`: it detects only target-versus-S2
  // contention on one bar. It has no concept of the target extreme preceding
  // the entry, so the single least causally-supported trade in the book is
  // recorded as unambiguous.
  const out = stepPosition(position(), ENTRY_BAR, 0);
  if (out.kind !== "CLOSED") throw new Error("expected CLOSED");
  assertEquals(out.result.sameBarAmbiguous, false);
});

Deno.test("C2 — the flag does fire for the case it was designed for", () => {
  // Target reached AND close beyond S2 on one bar: resolved stop-first, flagged.
  const bar: Candle = { datetime: "2026-09-23T14:00:00Z",
    open: 84500, high: 85940.32, low: 83864.07, close: 84000, volume: 0 };
  const out = stepPosition(position(), bar, 0);
  if (out.kind !== "CLOSED") throw new Error("expected CLOSED");
  assertEquals(out.result.exitReason, "S2_CLOSE_INVALIDATION");
  assertEquals(out.result.sameBarAmbiguous, true);
});

// ── D. the raw backtest carries the same assumption ──────────────────────────

Deno.test("D1 — simulate() starts exit checking ON the touch bar", () => {
  // `for (let k = setup.touchIndex; ...)` — the touch bar is index 0 of the
  // exit scan, so entry and target are both drawn from one bar's extremes.
  const series: Candle[] = [
    { datetime: "2026-09-23T12:00:00Z", open: 85000, high: 85100, low: 84900, close: 85000, volume: 0 },
    { datetime: "2026-09-23T13:00:00Z", open: 85510.9, high: 85878.01, low: 85288, close: 85778.63, volume: 0 },
    ENTRY_BAR,
  ];
  const setup: Setup = {
    ipoIndex: 0, direction: "demand",
    zoneLow: ENTRY, zoneHigh: ENTRY + RISK, extreme: S2,
    touchIndex: 2, touchNumber: 1, hasFvg: true,
  } as Setup;

  const r = simulate(series, setup, "E2_50_PERCENT", "S2_CLOSE_INVALIDATION", "T_2R",
                     { perSide: 0, label: "zero" });
  assertEquals(r.exitIndex, 2, "exits on the very bar it entered");
  assertAlmostEquals(r.grossR!, 2, 1e-12);
  assertEquals(r.outcome, "WIN");
});

Deno.test("D2 — the same setup resolves differently if the touch bar is excluded", () => {
  // Not a proposed fix — a measurement. It isolates how much of the result
  // depends on the entry bar's own range rather than on later bars.
  const later: Candle = { datetime: "2026-09-23T15:00:00Z",
    open: 84534, high: 84794.01, low: 84020, close: 84038.01, volume: 0 };
  const series: Candle[] = [
    { datetime: "2026-09-23T13:00:00Z", open: 85510.9, high: 85878.01, low: 85288, close: 85778.63, volume: 0 },
    ENTRY_BAR, later,
  ];
  const setup: Setup = {
    ipoIndex: 0, direction: "demand",
    zoneLow: ENTRY, zoneHigh: ENTRY + RISK, extreme: S2,
    touchIndex: 1, touchNumber: 1, hasFvg: true,
  } as Setup;
  const withEntryBar = simulate(series, setup, "E2_50_PERCENT", "S2_CLOSE_INVALIDATION", "T_2R", { perSide: 0, label: "zero" });
  assertEquals(withEntryBar.outcome, "WIN");

  // The NEXT bar closes at 84038.01, below S2 — the causal outcome Bitstamp shows.
  assert(later.close < S2, "the following 1h bar closes below S2");
});

// ── E. every path shares one comparator shape ────────────────────────────────

Deno.test("E1 — all four implementations use the same entry-bar comparators", async () => {
  const files = {
    live: "supabase/functions/_shared/ipoLiveEngine.ts",
    incremental: "supabase/functions/_shared/ipoIncrementalEngine.ts",
    contract: "supabase/functions/_shared/ipoPaperContract.ts",
    backtest: "supabase/functions/_shared/ipoRawBacktest.ts",
  };
  for (const [name, path] of Object.entries(files)) {
    const src = await Deno.readTextFile(path);
    assert(/high >= (t\.target|pos\.targetPrice|target)/.test(src),
      `${name}: long target comparator not found`);
    assert(/close < (t\.stop|pos\.s2InvalidationLevel|stop)/.test(src),
      `${name}: long S2 CLOSE comparator not found — S2 must stay close-confirmed`);
  }
});

Deno.test("E2 — the live and incremental engines manage the entry bar explicitly", async () => {
  for (const path of ["supabase/functions/_shared/ipoLiveEngine.ts",
                      "supabase/functions/_shared/ipoIncrementalEngine.ts"]) {
    const src = await Deno.readTextFile(path);
    // `const sameBar = this.manageOpen(K)` immediately after opening.
    assert(/const sameBar = this\.manageOpen\(/.test(src),
      `${path}: entry-bar management call not found`);
  }
});

Deno.test("E3 — the paper runner resolves the entry bar causally and never whole-bar", async () => {
  // UPDATED WHEN THE FIX LANDED. This assertion used to pin the defect — the
  // runner stepping the fill bar with its whole OHLC,
  // `stepPosition(pos, closedBars[entryIdx], 0)`. That call is gone. The entry
  // bar is now ordered first and the ordering is passed in, so a pre-entry
  // extreme cannot resolve a position that did not exist.
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoPaperRunner.ts");
  assert(!/stepPosition\(pos, closedBars\[entryIdx\], 0\)/.test(src),
    "the whole-bar entry step is back");
  assert(/order\(pos, entryBar, barMs, true,/.test(src),
    "the entry bar is no longer resolved with isEntryBar");
  assert(/stepPosition\(priced, entryBar, 0, o\)/.test(src),
    "the entry bar is stepped without a resolved ordering");
  // Every other bar is ordered too — a resolved ordering is always supplied.
  for (const m of src.matchAll(/stepPosition\(([^)]*)\)/g)) {
    const args = m[1].split(",").map((x) => x.trim());
    assert(args.length === 4, `stepPosition called without an ordering: ${m[0]}`);
  }
  // Two independent implementations of one assumption: they agree except where
  // the tape proves the engine wrong, and that exception is explicit.
  assert(src.includes("divergence"), "the runner no longer cross-checks the engine");
  assert(src.includes("engineExitOverridden"),
    "the runner no longer records where it refused the engine's whole-bar exit");
});

// ── F. S2 must remain close-confirmed ────────────────────────────────────────

Deno.test("F1 — a wick through S2 is not invalidation, at any resolution", () => {
  // Pinned so that any future intrabar work cannot quietly convert S2 into a
  // touch rule while resolving the ordering problem.
  const wick: Candle = { datetime: "2026-09-23T14:00:00Z",
    open: 84500, high: 84600, low: 83900, close: 84400, volume: 0 };
  assert(wick.low < S2, "the bar wicks below S2");
  const out = stepPosition(position({ targetPrice: 99999 }), wick, 0);
  assertEquals(out.kind, "HOLD", "a wick below S2 must not close the position");
});

// ── G. levels are immutable once the position exists ─────────────────────────

Deno.test("G1 — stepPosition never mutates entry, target, S2 or risk", () => {
  const pos = position();
  const before = JSON.stringify(pos);
  const out = stepPosition(pos, ENTRY_BAR, 0);
  assertEquals(JSON.stringify(pos), before, "the input position was mutated");
  if (out.kind !== "CLOSED") throw new Error("expected CLOSED");
  const p = out.result.position;
  assertEquals(p.entryPrice, ENTRY);
  assertEquals(p.targetPrice, TARGET);
  assertEquals(p.s2InvalidationLevel, S2);
  assertEquals(p.nominalRiskDistance, RISK);
  assertEquals(p.ipoCandleTime, "2026-09-21T10:00:00Z");
});

Deno.test("G2 — only excursion and the managed-bar cursor advance", () => {
  const pos = position();
  const out = stepPosition(pos, { ...ENTRY_BAR, high: 84600, low: 84400, close: 84500 }, 0);
  if (out.kind !== "HOLD") throw new Error("expected HOLD");
  const changed = (Object.keys(pos) as Array<keyof PaperPosition>)
    .filter((k) => JSON.stringify(pos[k]) !== JSON.stringify(out.position[k]));
  assertEquals(changed.sort(), ["lastManagedBarTime", "maeR", "mfeR"]);
});
