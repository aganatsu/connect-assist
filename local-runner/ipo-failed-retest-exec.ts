/**
 * IPO_FAILED_RETEST_V1 — 1-minute causal execution and reporting.
 *
 * Takes the detected retest candidates and resolves each trade against 1m bars.
 * The strategy timeframe cannot order events inside a bar; §7 forbids using
 * code precedence as execution evidence, so anything 1m cannot separate is
 * marked EXECUTION_AMBIGUOUS and excluded from clean statistics.
 *
 * ORDERING RULES, in the order they are attempted:
 *   1M_RESOLVED         1m bars separate the events: the first 1m bar to touch
 *                       entry starts the trade, and the first 1m bar after it
 *                       to touch stop or target ends it. If only one of the two
 *                       is ever touched, there is nothing to order.
 *   HTF_UNAMBIGUOUS     the strategy bar itself could only produce one outcome
 *                       — the trade never came within reach of the other level.
 *   EXECUTION_AMBIGUOUS one 1m bar touches BOTH stop and target, so even at 1m
 *                       the order is unknown; or 1m coverage is missing for the
 *                       period. Excluded. No favourable assumption is made.
 *
 * Tick resolution is not attempted: no tick source is configured in this
 * project, so TICK_RESOLVED is never emitted rather than being faked.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env local-runner/ipo-failed-retest-exec.ts
 */

import type { FailedRetest } from "./ipo-failed-retest.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";

/** The frozen target, reused from the normal IPO contract. One value, no sweep. */
const TARGET_R = 2;

const DET = "/tmp/ipo-failed-retest/detection.json";
const M1 = "/tmp/ipo-m1-data";
const OUT = "/tmp/ipo-failed-retest";

interface M1 { datetime: string; open: number; high: number; low: number; close: number }

type Ordering = "HTF_UNAMBIGUOUS" | "1M_RESOLVED" | "TICK_RESOLVED" | "EXECUTION_AMBIGUOUS";

interface Exec extends FailedRetest {
  m1_entry_time: string | null;
  m1_stop_time: string | null;
  m1_target_time: string | null;
  exit_time: string | null;
  exit_price: number | null;
  exit_reason: string;
  realized_r: number | null;
  cost_r: number | null;
  ordering_resolution: Ordering;
  ambiguity_detail: string;
  excluded_from_stats: boolean;
  holding_minutes: number | null;
}

const m1cache = new Map<string, M1[]>();
async function m1For(window: string): Promise<M1[] | null> {
  if (m1cache.has(window)) return m1cache.get(window)!;
  try {
    const b = JSON.parse(await Deno.readTextFile(`${M1}/${window}_1min.json`)) as M1[];
    m1cache.set(window, b); return b;
  } catch { m1cache.set(window, []); return null; }
}

const { all } = JSON.parse(await Deno.readTextFile(DET)) as { all: FailedRetest[] };
const cands = all.filter((c) => c.retested);
const out: Exec[] = [];

for (const c of cands) {
  const bars = await m1For(c.window);
  const base: Exec = {
    ...c, m1_entry_time: null, m1_stop_time: null, m1_target_time: null,
    exit_time: null, exit_price: null, exit_reason: "", realized_r: null, cost_r: null,
    ordering_resolution: "EXECUTION_AMBIGUOUS", ambiguity_detail: "",
    excluded_from_stats: true, holding_minutes: null,
  };

  if (!bars || !bars.length) {
    out.push({ ...base, ambiguity_detail: "NO_1M_COVERAGE_FOR_WINDOW", exit_reason: "UNRESOLVED" });
    continue;
  }

  // The retest bar's span on the strategy timeframe.
  const tStart = Date.parse(c.retest_time!);
  const tEnd = tStart + c.barMs;
  const short = c.flipped_direction === "short";

  // 1m coverage must actually include the retest bar, or nothing can be said.
  const first = Date.parse(bars[0].datetime), last = Date.parse(bars[bars.length - 1].datetime);
  if (tStart < first || tStart > last) {
    out.push({ ...base, ambiguity_detail: "1M_GAP_AT_RETEST_BAR", exit_reason: "UNRESOLVED" });
    continue;
  }

  // Entry: first 1m bar within the retest bar that reaches the entry level.
  let ei = -1;
  for (let i = 0; i < bars.length; i++) {
    const t = Date.parse(bars[i].datetime);
    if (t < tStart) continue;
    if (t >= tEnd) break;
    const b = bars[i];
    const reached = short ? b.high >= c.entry_price : b.low <= c.entry_price;
    if (reached) { ei = i; break; }
  }
  if (ei < 0) {
    // The strategy bar said the zone was re-entered but no 1m bar confirms the
    // entry level was reached. A 1m gap inside the bar, not a fill.
    out.push({ ...base, ambiguity_detail: "ENTRY_NOT_CONFIRMED_IN_1M", exit_reason: "UNRESOLVED" });
    continue;
  }

  // Walk forward. The entry bar itself can resolve the trade.
  let stopT: string | null = null, targetT: string | null = null, ambiguous = "";
  for (let i = ei; i < bars.length; i++) {
    const b = bars[i];
    const hitStop = short ? b.high >= c.stop_price : b.low <= c.stop_price;
    const hitTgt = short ? b.low <= c.target_price : b.high >= c.target_price;
    if (hitStop && hitTgt) {
      // Both inside ONE 1m bar. Even at this resolution the order is unknown,
      // and choosing one would be exactly the favourable-ordering assumption
      // this experiment exists to avoid.
      ambiguous = "STOP_AND_TARGET_IN_SAME_1M_BAR";
      break;
    }
    if (hitStop) { stopT = b.datetime; break; }
    if (hitTgt) { targetT = b.datetime; break; }
  }

  if (ambiguous) {
    out.push({ ...base, m1_entry_time: bars[ei].datetime, ambiguity_detail: ambiguous, exit_reason: "UNRESOLVED" });
    continue;
  }
  if (!stopT && !targetT) {
    out.push({ ...base, m1_entry_time: bars[ei].datetime,
      ambiguity_detail: "NO_EXIT_WITHIN_1M_COVERAGE", exit_reason: "OPEN_AT_DATA_END" });
    continue;
  }

  const exitTime = stopT ?? targetT!;
  const exitPrice = stopT ? c.stop_price : c.target_price;
  // Same frozen cost model the normal IPO engine applies: round-trip cost in R,
  // fixed at entry. Without it these numbers would not be comparable with the
  // normal-IPO causal baseline in §17, and would read optimistic.
  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === c.instrument)!;
  const costR = (2 * inst.costPerSide(c.entry_price)) / c.risk_price;
  const r = (stopT ? -1 : TARGET_R) - costR;
  out.push({
    ...base,
    m1_entry_time: bars[ei].datetime,
    m1_stop_time: stopT, m1_target_time: targetT,
    exit_time: exitTime, exit_price: exitPrice,
    exit_reason: stopT ? "STOP" : "TARGET",
    realized_r: r, cost_r: costR,
    // Only one of the two levels was ever reached in a single 1m bar, so the
    // ordering is established by 1m rather than assumed.
    ordering_resolution: "1M_RESOLVED",
    ambiguity_detail: "", excluded_from_stats: false,
    holding_minutes: (Date.parse(exitTime) - Date.parse(bars[ei].datetime)) / 60_000,
  });
}

// ── report ─────────────────────────────────────────────────────────────────

const clean = out.filter((t) => !t.excluded_from_stats);
const amb = out.filter((t) => t.excluded_from_stats);
const INSTS = ["EUR/USD", "USD/JPY", "BTC/USD"];
const q = (a: number[], p: number) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length-1, Math.floor(p*(a.length-1)))] : 0;

function stats(rs: number[]) {
  const n = rs.length;
  if (!n) return { n:0, wr:0, lr:0, aw:0, al:0, exp:0, pf:0, tot:0, dd:0 };
  const w = rs.filter(r=>r>0), l = rs.filter(r=>r<=0);
  const g = w.reduce((a,b)=>a+b,0), gl = Math.abs(l.reduce((a,b)=>a+b,0));
  let eq=0, pk=0, dd=0; for (const r of rs){eq+=r;pk=Math.max(pk,eq);dd=Math.max(dd,pk-eq);}
  return { n, wr:(w.length/n)*100, lr:(l.length/n)*100,
    aw: w.length? g/w.length:0, al: l.length? -gl/l.length:0,
    exp: rs.reduce((a,b)=>a+b,0)/n, pf: gl? g/gl : (g>0?Infinity:0),
    tot: rs.reduce((a,b)=>a+b,0), dd };
}
const HEAD = `  ${"population".padEnd(28)} ${"n".padStart(5)} ${"win%".padStart(6)} ${"avgW".padStart(6)} ${"avgL".padStart(6)} ${"expR".padStart(8)} ${"PF".padStart(6)} ${"totR".padStart(9)} ${"maxDD".padStart(7)}`;
const row = (lab: string, rs: number[]) => { const s = stats(rs);
  console.log(`  ${lab.padEnd(28)} ${String(s.n).padStart(5)} ${s.wr.toFixed(1).padStart(6)} ${s.aw.toFixed(2).padStart(6)} ${s.al.toFixed(2).padStart(6)} ${((s.exp>=0?"+":"")+s.exp.toFixed(3)).padStart(8)} ${(s.pf===Infinity?"inf":s.pf.toFixed(2)).padStart(6)} ${((s.tot>=0?"+":"")+s.tot.toFixed(1)).padStart(9)} ${s.dd.toFixed(1).padStart(7)}`); };
const R = (xs: Exec[]) => xs.map(t=>t.realized_r!).filter(r=>r!==null);

console.log(`\n${"=".repeat(94)}\nIPO_FAILED_RETEST_V1 — 1m causal execution\n${"=".repeat(94)}`);

console.log(`\n── §8 ORDERING RESOLUTION ──`);
const byOrd: Record<string, number> = {};
for (const t of out) byOrd[t.ordering_resolution] = (byOrd[t.ordering_resolution] ?? 0) + 1;
for (const [k, v] of Object.entries(byOrd).sort((a,b)=>b[1]-a[1]))
  console.log(`  ${k.padEnd(22)} ${String(v).padStart(5)}  ${(100*v/out.length).toFixed(1)}%`);
console.log(`\n  ambiguity / exclusion reasons:`);
const byAmb: Record<string, number> = {};
for (const t of amb) byAmb[t.ambiguity_detail || t.exit_reason] = (byAmb[t.ambiguity_detail || t.exit_reason] ?? 0) + 1;
for (const [k, v] of Object.entries(byAmb).sort((a,b)=>b[1]-a[1]))
  console.log(`    ${k.padEnd(32)} ${String(v).padStart(5)}`);

console.log(`\n── §10 PRIMARY PERFORMANCE, clean causal only ──\n${HEAD}`);
row("FAILED_RETEST clean", R(clean));
const rs = R(clean);
if (rs.length) {
  console.log(`\n  R distribution: p10 ${q(rs,0.10).toFixed(2)}  p25 ${q(rs,0.25).toFixed(2)}  median ${q(rs,0.5).toFixed(2)}  p75 ${q(rs,0.75).toFixed(2)}  p90 ${q(rs,0.90).toFixed(2)}`);
  console.log(`  best ${Math.max(...rs).toFixed(2)}   worst ${Math.min(...rs).toFixed(2)}`);
}

console.log(`\n── §11 PER INSTRUMENT ──\n${HEAD}`);
for (const i of INSTS) row(i, R(clean.filter(t=>t.instrument===i)));

console.log(`\n── §12 BY ORIGINAL IPO DIRECTION ──\n${HEAD}`);
row("failed bullish -> SHORT", R(clean.filter(t=>t.original_direction==="demand")));
row("failed bearish -> LONG", R(clean.filter(t=>t.original_direction==="supply")));

console.log(`\n── §13 FAILURE -> RETEST TIMING (clean) ──`);
const b2r = clean.map(t=>t.bars_failure_to_retest!).filter(x=>x!=null);
console.log(`  bars: median ${q(b2r,0.5)}  p75 ${q(b2r,0.75)}  p90 ${q(b2r,0.9)}  max ${b2r.length?Math.max(...b2r):0}`);
console.log(HEAD);
for (const [lab, lo, hi] of [["1 bar",1,1],["2-5 bars",2,5],["6-15 bars",6,15],["16-50 bars",16,50],["50+ bars",51,1e9]] as const) {
  const xs = clean.filter(t=>t.bars_failure_to_retest!>=lo && t.bars_failure_to_retest!<=hi);
  if (xs.length) row(lab, R(xs));
}

console.log(`\n── §14 RETEST DEPTH (penetration of the old zone) ──\n${HEAD}`);
for (const [lab, lo, hi] of [["near edge <25%",-9,0.25],["mid 25-60%",0.25,0.60],["deep 60-100%",0.60,1.0],["full reclaim >100%",1.0,9] ] as const) {
  const xs = clean.filter(t=>t.retest_penetration_pct!=null && t.retest_penetration_pct!>lo && t.retest_penetration_pct!<=hi);
  if (xs.length) row(lab, R(xs));
}

console.log(`\n── §15 RECLAIM vs CONTINUATION ──\n${HEAD}`);
row("later RECLAIMED zone", R(clean.filter(t=>t.reclaimed_after_retest===true)));
row("CONTINUATION (no reclaim)", R(clean.filter(t=>t.reclaimed_after_retest===false)));

// ── exports ────────────────────────────────────────────────────────────────
const csv = (rows: Exec[]) => {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  return [cols.join(","), ...rows.map(r=>cols.map(c=>esc((r as never)[c])).join(","))].join("\n")+"\n";
};
await Deno.mkdir(OUT, { recursive: true });
for (const [name, rows] of [
  ["ipo_failed_retest_all.csv", out],
  ["ipo_failed_retest_clean.csv", clean],
  ["ipo_failed_retest_ambiguous.csv", amb],
] as const) await Deno.writeTextFile(`${OUT}/${name}`, csv(rows));

console.log(`\n── §19 EXPORTS ──`);
console.log(`  ${OUT}/ipo_failed_retest_all.csv        ${out.length} rows`);
console.log(`  ${OUT}/ipo_failed_retest_clean.csv      ${clean.length} rows`);
console.log(`  ${OUT}/ipo_failed_retest_ambiguous.csv  ${amb.length} rows`);
