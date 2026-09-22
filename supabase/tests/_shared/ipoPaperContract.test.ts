import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildIntent, openPosition, stepPosition, suspendForGap, resumeFromGap, abortForGap,
  nominalRiskUsd, setupId, intentId, eventId,
  DEFAULT_SIZING, COST_R_HARD_LIMIT, STRATEGY_ID, STRATEGY_VERSION,
  type PaperPosition,
} from "../../functions/_shared/ipoPaperContract.ts";
import type { LiveTrade } from "../../functions/_shared/ipoLiveEngine.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime: `2026-01-0${i + 1}T00:00:00Z`, open: o, high: h, low: l, close: c, volume: 0 } as Candle);
const bars = Array.from({ length: 9 }, (_, i) => bar(i, 100, 101, 99, 100));

const trade = (o: Partial<LiveTrade> = {}): LiveTrade => ({
  instrument: "EUR/USD", direction: "demand", ipoIndex: 0, entryIndex: 2,
  entry: 100, stop: 99, target: 102, risk: 1, vol: "HIGH_VOL", costR: 0.3,
  exitIndex: null, exitPrice: null, netR: null, mae: 0, mfe: 0, ...o,
});
const pos = (o: Partial<PaperPosition> = {}): PaperPosition =>
  ({ ...openPosition(buildIntent(trade(), bars, "1h")), ...o });

// ── sizing ───────────────────────────────────────────────────────────────────

Deno.test("default sizing is $100,000 at 0.20% = $200 per 1R", () => {
  assertEquals(DEFAULT_SIZING.referenceBalance, 100_000);
  assertEquals(DEFAULT_SIZING.nominalRiskPct, 0.20);
  assertEquals(nominalRiskUsd(DEFAULT_SIZING), 200);
});

Deno.test("the risk percentage is configurable and never reaches the strategy engine", async () => {
  assertEquals(nominalRiskUsd({ referenceBalance: 50_000, nominalRiskPct: 0.5 }), 250);
  // The engine must not know about sizing at all.
  for (const f of ["ipoIncrementalEngine.ts", "ipoLiveEngine.ts", "ipoObservation.ts"]) {
    const src = await Deno.readTextFile(`supabase/functions/_shared/${f}`);
    for (const leak of ["nominalRisk", "referenceBalance", "0.20", "100_000", "riskUsd"]) {
      assert(!src.includes(leak), `${f} references sizing ("${leak}")`);
    }
  }
});

Deno.test("$200 per 1R is a unit of account, not a loss cap", () => {
  // S2 routinely loses more than 1R. A -3R outcome must be about -$600.
  const p = pos();
  const out = stepPosition(p, bar(3, 100, 100.5, 96, 96.7), 1); // closes well beyond S2
  assert(out.kind === "CLOSED");
  assert(out.result.realizedR! < -3, `expected worse than -3R, got ${out.result.realizedR}`);
  assertEquals(Math.round(out.result.realizedPnlUsd!), Math.round(out.result.realizedR! * 200));
  assert(out.result.realizedPnlUsd! < -600);
});

Deno.test("realized R is canonical — dollars are derived from it, not the reverse", () => {
  const a = openPosition(buildIntent(trade(), bars, "1h"), { referenceBalance: 100_000, nominalRiskPct: 0.20 });
  const b = openPosition(buildIntent(trade(), bars, "1h"), { referenceBalance: 250_000, nominalRiskPct: 1.0 });
  const win = bar(4, 100, 102.5, 99.5, 102);
  const ra = stepPosition(a, win, 1), rb = stepPosition(b, win, 1);
  assert(ra.kind === "CLOSED" && rb.kind === "CLOSED");
  // Same strategy result under different sizing; only the dollar view changes.
  assertEquals(ra.result.realizedR, rb.result.realizedR);
  assert(ra.result.realizedPnlUsd !== rb.result.realizedPnlUsd);
});

// ── the one deductive execution rule ─────────────────────────────────────────

Deno.test("costR > 2 blocks EXECUTION but never the strategy signal", () => {
  const i = buildIntent(trade({ costR: 2.4 }), bars, "1h");
  assertEquals(i.strategyDecision, "WOULD_ENTER", "the IPO signal stays valid");
  assertEquals(i.execution, "BLOCKED");
  assertEquals(i.blockReason, "ECONOMICALLY_UNTRADEABLE_COST");
  assert(i.reasonCodes.includes("ECONOMICALLY_UNTRADEABLE_COST"));
});

Deno.test("the cost limit is exactly 2 — no statistical threshold exists", async () => {
  assertEquals(COST_R_HARD_LIMIT, 2);
  assertEquals(buildIntent(trade({ costR: 2.0 }), bars, "1h").execution, "EXECUTED");
  assertEquals(buildIntent(trade({ costR: 2.0001 }), bars, "1h").execution, "BLOCKED");
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoPaperContract.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  for (const rejected of ["0.5", "0.75", "0.25", "1.0"]) {
    assert(!code.includes(`COST_R`) || !code.includes(rejected),
      `a statistical cost threshold (${rejected}) leaked in`);
  }
});

Deno.test("an account block does not overwrite the strategy decision", () => {
  const i = buildIntent(trade(), bars, "1h", "BLOCK_CORRELATION");
  assertEquals(i.strategyDecision, "WOULD_ENTER");
  assertEquals(i.accountDecision, "BLOCK_CORRELATION");
  assertEquals(i.execution, "BLOCKED");
});

Deno.test("UNAVAILABLE account safety does not block", () => {
  const i = buildIntent(trade(), bars, "1h", "UNAVAILABLE");
  assertEquals(i.accountDecision, "UNAVAILABLE");
  assertEquals(i.execution, "EXECUTED");
});

// ── management ───────────────────────────────────────────────────────────────

Deno.test("a wick through S2 does NOT close the position", () => {
  const out = stepPosition(pos(), bar(3, 100, 100.4, 95, 100.2), 1);
  assertEquals(out.kind, "HOLD", "only a CLOSE beyond S2 may exit");
  assert((out as { position: PaperPosition }).position.maeR > 4);
});

Deno.test("same-bar target and S2 resolves stop-first and is flagged", () => {
  const out = stepPosition(pos(), bar(3, 100, 103, 97, 98.5), 1);
  assert(out.kind === "CLOSED");
  assertEquals(out.result.exitReason, "S2_CLOSE_INVALIDATION");
  assertEquals(out.result.sameBarAmbiguous, true);
  assert(out.result.realizedR! < 0);
});

Deno.test("target exits at the exact target price", () => {
  const out = stepPosition(pos(), bar(3, 100, 102.8, 99.5, 102.5), 1);
  assert(out.kind === "CLOSED");
  assertEquals(out.result.exitReason, "TARGET_2R");
  assertEquals(out.result.exitPrice, 102);
  assertEquals(out.result.grossR, 2);
  assertEquals(Math.round(out.result.realizedR! * 1e9), Math.round((2 - 0.3) * 1e9));
});

Deno.test("no SMC management behaviour exists in the contract", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoPaperContract.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  for (const banned of ["breakEven", "break_even", "trailing", "partial", "moveStop",
                        "scannerManagement", "propFirmGate", "calculateSLTP",
                        "unifiedPositionSizing", "broker-execute"]) {
    assert(!code.includes(banned), `contract references SMC behaviour "${banned}"`);
  }
});

// ── data gaps ────────────────────────────────────────────────────────────────

Deno.test("a gap suspends rather than closing, and can resume", () => {
  const s = suspendForGap(pos(), "2026-01-05T00:00:00Z", "2026-01-07T00:00:00Z", "provider gap");
  assertEquals(s.status, "data_gap_suspended");
  assertEquals(s.gapFromBarTime, "2026-01-05T00:00:00Z");
  const r = resumeFromGap(s);
  assertEquals(r.status, "open");
  assertEquals(r.gapReason, null);
});

Deno.test("an abort fabricates NO exit price and NO realized R", () => {
  const a = abortForGap(pos(), "2026-01-08T00:00:00Z", "bars permanently unavailable");
  assertEquals(a.exitReason, "DATA_GAP_ABORTED");
  assertEquals(a.exitPrice, null, "a fabricated exit would contaminate the R distribution");
  assertEquals(a.realizedR, null);
  assertEquals(a.realizedPnlUsd, null);
  assertEquals(a.excludedFromStats, true);
  assert(a.exclusionReason);
});

Deno.test("FORCED_FLAT does not exist anywhere in the contract", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoPaperContract.ts");
  assert(!src.includes("FORCED_FLAT"), "Phase D rejected a forced paper close");
});

// ── identity / idempotency ───────────────────────────────────────────────────

Deno.test("keys are content-addressed and stable", () => {
  const a = setupId("EUR/USD", "1h", "2026-01-01T00:00:00Z", "long");
  assertEquals(a, setupId("EUR/USD", "1h", "2026-01-01T00:00:00Z", "long"));
  assert(a !== setupId("EUR/USD", "1h", "2026-01-01T00:00:00Z", "short"));
  assert(a !== setupId("USD/JPY", "1h", "2026-01-01T00:00:00Z", "long"));
  const i = intentId(a, "2026-01-02T00:00:00Z");
  assertEquals(i, intentId(a, "2026-01-02T00:00:00Z"));
  assert(i !== intentId(a, "2026-01-03T00:00:00Z"));
  assert(eventId("FILLED", i, "x") !== eventId("CLOSED", i, "x"));
});

Deno.test("rebuilding the same intent twice produces an identical row", () => {
  const a = JSON.stringify(openPosition(buildIntent(trade(), bars, "1h")));
  const b = JSON.stringify(openPosition(buildIntent(trade(), bars, "1h")));
  assertEquals(a, b, "a retried bar must not produce a different position");
});

Deno.test("strategy ownership is stamped on every position", () => {
  const p = pos();
  assertEquals(p.strategyId, STRATEGY_ID);
  assertEquals(p.strategyVersion, STRATEGY_VERSION);
  assertEquals(p.executionMode, "paper");
});
