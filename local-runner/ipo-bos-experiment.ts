/**
 * IPO_BOS_REQUIRED_V1 — hypothesis test, research only.
 *
 * ONE CHANGE. A direction-matching, CLOSE-CONFIRMED BOS must exist between the
 * IPO origin and the return, knowable from bars strictly before the touch bar.
 * Everything else is frozen: geometry, 50% rule, move-away, contraction, touch,
 * invalidation, entry, S2, target, ordering, costs, one-position-per-instrument,
 * windows and bars are all identical between arms.
 *
 * BOS DEFINITION — the repository's existing detector, not a new one.
 * `analyzeMarketStructure` (smcAnalysis.ts) walks swing-to-swing events and
 * pushes a break only when `breakCandle.close` is beyond the prior structural
 * level; a wick that fails to close through falls into `sweeps` instead. It
 * separates continuation (`bos`) from reversal (`choch`), and this experiment
 * accepts ONLY `bos`, per the pre-registration. Entries carry `closeBased:
 * true`.
 *
 * KNOWN LIMITATION, stated up front: that detector is swing-to-swing and is
 * documented to miss some close-throughs (13-28 per pair in an earlier audit).
 * The instruction was to use the existing causal detector rather than invent a
 * second definition, so the experiment inherits its recall. A stricter detector
 * would be a different hypothesis.
 *
 * CAUSALITY. The gate recomputes structure on the prefix strictly before the
 * touch bar. Swing confirmation needs bars after a pivot, so a pivot only
 * becomes visible once the prefix contains them — recomputing on the prefix
 * makes that automatic rather than assumed. No future BOS can qualify an IPO,
 * and a missed entry is never resurrected.
 *
 * Usage:
 *   deno run --allow-read --allow-env local-runner/ipo-bos-experiment.ts
 */

import type { EngineConfig, LiveTrade } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import { replayIncremental as replay } from "../supabase/functions/_shared/ipoIncrementalEngine.ts";
import { analyzeMarketStructure, type Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";
import { WINDOWS } from "./ipo-bos-fetch.ts";
import { bosAfterOrigin, bosEntryGate, type BosFind } from "./ipo-bos-gate.ts";

const CACHE = "/tmp/ipo-bos-data";
const MAX_BARS = 1800;

// ─────────────────────────────────────────────────────────────────────────────
// the single experimental change
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// stats
// ─────────────────────────────────────────────────────────────────────────────

interface Stats {
  n: number; wins: number; winRate: number; avgWin: number; avgLoss: number;
  expectancy: number; pf: number; totalR: number; maxDD: number;
  medLoss: number; p90Loss: number; p95Loss: number; p99Loss: number; maxLoss: number;
}

const q = (a: number[], p: number) =>
  a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))] : 0;

function stats(rs: number[]): Stats {
  const n = rs.length;
  if (!n) {
    return { n: 0, wins: 0, winRate: 0, avgWin: 0, avgLoss: 0, expectancy: 0, pf: 0,
      totalR: 0, maxDD: 0, medLoss: 0, p90Loss: 0, p95Loss: 0, p99Loss: 0, maxLoss: 0 };
  }
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
  const gross = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  // Peak-to-trough on the cumulative R curve, in trade order.
  let eq = 0, peak = 0, dd = 0;
  for (const r of rs) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const absL = losses.map((r) => Math.abs(r));
  return {
    n, wins: wins.length, winRate: (wins.length / n) * 100,
    avgWin: wins.length ? gross / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    expectancy: rs.reduce((a, b) => a + b, 0) / n,
    pf: grossLoss > 0 ? gross / grossLoss : (gross > 0 ? Infinity : 0),
    totalR: rs.reduce((a, b) => a + b, 0), maxDD: dd,
    medLoss: -q(absL, 0.5), p90Loss: -q(absL, 0.9), p95Loss: -q(absL, 0.95),
    p99Loss: -q(absL, 0.99), maxLoss: absL.length ? -Math.max(...absL) : 0,
  };
}

const row = (label: string, s: Stats) =>
  `  ${label.padEnd(26)} ${String(s.n).padStart(5)} ${s.winRate.toFixed(1).padStart(6)} ` +
  `${s.avgWin.toFixed(2).padStart(7)} ${s.avgLoss.toFixed(2).padStart(7)} ` +
  `${s.expectancy >= 0 ? "+" : ""}${s.expectancy.toFixed(3).padStart(6)} ` +
  `${(s.pf === Infinity ? "inf" : s.pf.toFixed(2)).padStart(6)} ` +
  `${(s.totalR >= 0 ? "+" : "") + s.totalR.toFixed(1)}`.padStart(9) +
  ` ${s.maxDD.toFixed(1).padStart(7)}`;

const HEAD = `  ${"population".padEnd(26)} ${"n".padStart(5)} ${"win%".padStart(6)} ` +
  `${"avgW".padStart(7)} ${"avgL".padStart(7)} ${"expR".padStart(7)} ${"PF".padStart(6)} ${"totR".padStart(9)} ${"maxDD".padStart(7)}`;

// ─────────────────────────────────────────────────────────────────────────────
// run
// ─────────────────────────────────────────────────────────────────────────────

interface Rec {
  instrument: string; window: string; direction: "demand" | "supply";
  ipoIndex: number; entryIndex: number; netR: number; exitIndex: number | null;
  bosIndex: number | null;          // knowable-before-entry BOS, control arm
  targetHit: boolean; stopHit: boolean;
  barsOriginToBos: number | null; barsBosToEntry: number | null;
  barMs: number;
}

const controlTrades: Rec[] = [];
const experimentTrades: Rec[] = [];
const funnel: Record<string, Record<string, number>> = {};

for (const w of WINDOWS) {
  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === w.instrument)!;
  let bars: Candle[];
  try {
    const all = JSON.parse(await Deno.readTextFile(`${CACHE}/${w.id}_${w.tf}.json`)) as Candle[];
    // Capped at the most recent MAX_BARS of each window. Both engines are
    // superlinear (~O(n^2.7) measured: 600 bars 1.6s, 1200 11.9s, 1800 36.5s),
    // so a 5000-bar window costs ~18 min per arm and the full corpus would take
    // 7+ hours. 1800 leaves ~600 bars of warm-up — well above the 250-bar
    // volatility floor — and ~1200 decision bars per window, ~14,400 across the
    // corpus, the same order as the 16,169 rows the frozen spec cites.
    // CONTROL and EXPERIMENT see byte-identical bars, which is what the
    // hypothesis test requires; the cap shrinks the corpus, not the comparison.
    bars = all.slice(-MAX_BARS);
  } catch {
    console.error(`  MISSING ${w.id} — run ipo-bos-fetch.ts first`);
    continue;
  }

  const base: EngineConfig = {
    instrument: inst.instrument, timeframe: inst.timeframe,
    highVolOnly: inst.highVolOnly, costPerSide: inst.costPerSide,
  };

  const f = funnel[w.instrument] ??= {
    controlEntries: 0, experimentEntries: 0, gateRefusals: 0,
    bosBeforeTouch: 0, noBosBeforeTouch: 0,
    ctlTargets: 0, ctlStops: 0, expTargets: 0, expStops: 0, ctlOpen: 0, expOpen: 0,
  };

  // ── CONTROL: frozen engine, no gate ──────────────────────────────────────
  const ctl = replay(bars, base);
  for (const t of ctl.trades) {
    if (t.netR === null) { f.ctlOpen++; continue; }
    // Post-hoc: was a qualifying BOS knowable before this entry? Used for the
    // matched-trade split (§10) — it does NOT affect the control arm.
    const found = bosAfterOrigin(bars.slice(0, t.entryIndex), t.ipoIndex, t.direction);
    const rec = mkRec(w, inst.barMs, t, found);
    controlTrades.push(rec);
    f.controlEntries++;
    if (found) f.bosBeforeTouch++; else f.noBosBeforeTouch++;
    if (rec.targetHit) f.ctlTargets++; if (rec.stopHit) f.ctlStops++;
  }

  // ── EXPERIMENT: same engine, BOS gate supplied ───────────────────────────
  // Run as a real re-replay, not a filter of control: refusing an entry frees
  // the one-position slot earlier, so a later touch that control had blocked
  // can now enter. A post-hoc filter would miss those and understate the arm.
  const exp = replay(bars, {
    ...base,
    entryGate: bosEntryGate,
  });
  for (const t of exp.trades) {
    if (t.netR === null) { f.expOpen++; continue; }
    const found = bosAfterOrigin(bars.slice(0, t.entryIndex), t.ipoIndex, t.direction);
    const rec = mkRec(w, inst.barMs, t, found);
    experimentTrades.push(rec);
    f.experimentEntries++;
    if (rec.targetHit) f.expTargets++; if (rec.stopHit) f.expStops++;
  }
  f.gateRefusals += exp.refusals.filter((r) => r.reason === "ENTRY_GATE_REFUSED").length;

  console.error(`  ${w.id.padEnd(20)} control ${String(ctl.trades.length).padStart(4)}  experiment ${String(exp.trades.length).padStart(4)}`);
}

function mkRec(w: typeof WINDOWS[number], barMs: number, t: LiveTrade, bos: BosFind | null): Rec {
  const tgt = t.netR !== null && t.netR > 0.5;
  return {
    instrument: t.instrument, window: w.id, direction: t.direction,
    ipoIndex: t.ipoIndex, entryIndex: t.entryIndex, netR: t.netR ?? 0,
    exitIndex: t.exitIndex, bosIndex: bos?.index ?? null,
    targetHit: tgt, stopHit: t.netR !== null && t.netR < 0,
    barsOriginToBos: bos ? bos.index - t.ipoIndex : null,
    barsBosToEntry: bos ? t.entryIndex - bos.index : null,
    barMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// report
// ─────────────────────────────────────────────────────────────────────────────

const R = (xs: Rec[]) => xs.map((x) => x.netR);
const byInst = (xs: Rec[], i: string) => xs.filter((x) => x.instrument === i);
const INSTS = ["EUR/USD", "USD/JPY", "BTC/USD"];

console.log(`\n${"=".repeat(96)}\nIPO_BOS_REQUIRED_V1 — CONTROL vs BOS REQUIRED\n${"=".repeat(96)}`);

console.log(`\n── §6 FUNNEL ──`);
console.log(`  ${"instrument".padEnd(10)} ${"ctlEntries".padStart(10)} ${"BOS before".padStart(11)} ${"no BOS".padStart(8)} ${"%BOS".padStart(6)} ${"expEntries".padStart(10)} ${"gateRefus".padStart(10)}`);
for (const i of INSTS) {
  const f = funnel[i]; if (!f) continue;
  const pct = f.controlEntries ? (100 * f.bosBeforeTouch / f.controlEntries) : 0;
  console.log(`  ${i.padEnd(10)} ${String(f.controlEntries).padStart(10)} ${String(f.bosBeforeTouch).padStart(11)} ${String(f.noBosBeforeTouch).padStart(8)} ${pct.toFixed(1).padStart(6)} ${String(f.experimentEntries).padStart(10)} ${String(f.gateRefusals).padStart(10)}`);
}

console.log(`\n── §7 PERFORMANCE, portfolio ──\n${HEAD}`);
console.log(row("CONTROL", stats(R(controlTrades))));
console.log(row("BOS REQUIRED", stats(R(experimentTrades))));

console.log(`\n── §7 loss distribution ──`);
console.log(`  ${"arm".padEnd(16)} ${"median".padStart(8)} ${"p90".padStart(8)} ${"p95".padStart(8)} ${"p99".padStart(8)} ${"max".padStart(8)}`);
for (const [lab, xs] of [["CONTROL", controlTrades], ["BOS REQUIRED", experimentTrades]] as const) {
  const s = stats(R(xs));
  console.log(`  ${lab.padEnd(16)} ${s.medLoss.toFixed(2).padStart(8)} ${s.p90Loss.toFixed(2).padStart(8)} ${s.p95Loss.toFixed(2).padStart(8)} ${s.p99Loss.toFixed(2).padStart(8)} ${s.maxLoss.toFixed(2).padStart(8)}`);
}

console.log(`\n── §8 PER INSTRUMENT ──\n${HEAD}`);
for (const i of INSTS) {
  console.log(row(`${i} CONTROL`, stats(R(byInst(controlTrades, i)))));
  console.log(row(`${i} BOS REQ`, stats(R(byInst(experimentTrades, i)))));
}

console.log(`\n── §9 LONG vs SHORT ──\n${HEAD}`);
for (const d of ["demand", "supply"] as const) {
  const lab = d === "demand" ? "bullish IPO" : "bearish IPO";
  console.log(row(`${lab} CONTROL`, stats(R(controlTrades.filter((x) => x.direction === d)))));
  console.log(row(`${lab} BOS REQ`, stats(R(experimentTrades.filter((x) => x.direction === d)))));
}

console.log(`\n── §10 MATCHED-TRADE: control trades split by BOS presence ──\n${HEAD}`);
const withBos = controlTrades.filter((x) => x.bosIndex !== null);
const noBos = controlTrades.filter((x) => x.bosIndex === null);
console.log(row("A BOS_CONFIRMED", stats(R(withBos))));
console.log(row("B NO_BOS", stats(R(noBos))));
for (const i of INSTS) {
  console.log(row(`  ${i} A BOS`, stats(R(byInst(withBos, i)))));
  console.log(row(`  ${i} B noBOS`, stats(R(byInst(noBos, i)))));
}

console.log(`\n── §11 REMOVED-TRADE ANALYSIS ──`);
console.log(`  Control trades the gate would refuse (population B above).\n${HEAD}`);
console.log(row("REMOVED", stats(R(noBos))));
console.log(row("RETAINED", stats(R(withBos))));

console.log(`\n── §12 BOS TIMING, retained trades ──`);
const o2b = withBos.map((x) => x.barsOriginToBos!).filter((x) => x >= 0);
const b2e = withBos.map((x) => x.barsBosToEntry!).filter((x) => x >= 0);
const hrs = (bars: number[], ms: number) => bars.length ? (q(bars, 0.5) * ms) / 3_600_000 : 0;
console.log(`  origin -> BOS   bars: median ${q(o2b,0.5)}  p90 ${q(o2b,0.9)}  max ${o2b.length?Math.max(...o2b):0}`);
console.log(`  BOS -> entry    bars: median ${q(b2e,0.5)}  p90 ${q(b2e,0.9)}  max ${b2e.length?Math.max(...b2e):0}`);
for (const i of INSTS) {
  const xs = byInst(withBos, i); if (!xs.length) continue;
  const a = xs.map((x) => x.barsOriginToBos!), b = xs.map((x) => x.barsBosToEntry!);
  console.log(`    ${i.padEnd(9)} origin->BOS med ${String(q(a,0.5)).padStart(4)} bars (${hrs(a, xs[0].barMs).toFixed(1)}h)   BOS->entry med ${String(q(b,0.5)).padStart(4)} bars (${hrs(b, xs[0].barMs).toFixed(1)}h)`);
}

console.log(`\n── §12 outcome by BOS->entry bucket (descriptive, NOT a threshold) ──\n${HEAD}`);
for (const [lab, lo, hi] of [["0-2 bars",0,2],["3-10 bars",3,10],["11-30 bars",11,30],["31+ bars",31,1e9]] as const) {
  const xs = withBos.filter((x) => x.barsBosToEntry! >= lo && x.barsBosToEntry! <= hi);
  if (xs.length) console.log(row(lab, stats(R(xs))));
}

await Deno.writeTextFile("/tmp/ipo-bos-result.json",
  JSON.stringify({ control: controlTrades, experiment: experimentTrades, funnel }, null, 2));
console.log(`\n  raw -> /tmp/ipo-bos-result.json`);
