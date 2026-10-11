import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clause } from "./helpers/clause.ts";
import { nyLocalToUtc } from "../../functions/_shared/v2/calendar.ts";
import {
  bootstrapCI, dayBlocks, mulberry32, resample, ceilingGate, expectancy, initialGate, maxDrawdown, nearestRank, perPair, phase3Frequency, resolvedBy, type ResolvedTrade, safety,
} from "../../functions/_shared/v2/v2Evaluation.ts";

const day = (d: number, h = 9) => nyLocalToUtc(2026, 10, d, h, 0);
const tr = (d: number, netR: number, pair: ResolvedTrade["pair"] = "EUR/USD", exitOffset = 3_600_000): ResolvedTrade =>
  ({ pair, entryT: day(d), exitT: day(d) + exitOffset, netR });

clause(["12.2"], "expectancy counts only trades resolved at or before the evaluation time", () => {
  const ts = [tr(5, 1), tr(6, -1), tr(7, 2)];
  assertEquals(resolvedBy(ts, day(6) + 3_600_000).length, 2);
  assertAlmostEquals(expectancy(ts), 2 / 3);
});

clause(["12.2"], "max DD by exit time with ties (entry time, then pair order), measured from 0", () => {
  assertEquals(maxDrawdown([tr(5, -2), tr(6, 1), tr(7, -3)]), 4);
  assertEquals(maxDrawdown([tr(5, 2), tr(6, -1), tr(7, 3)]), 1);
  // same exit time: entry time decides the order
  const a: ResolvedTrade = { pair: "GBP/USD", entryT: day(5, 3), exitT: day(5, 10), netR: 3 };
  const b: ResolvedTrade = { pair: "EUR/USD", entryT: day(5, 4), exitT: day(5, 10), netR: -5 };
  assertEquals(maxDrawdown([b, a]), 5);
});

clause(["12.2"], "nearest-rank percentiles; bootstrap is deterministic (seed 20261010) and brackets the mean", () => {
  assertEquals(nearestRank([1, 2, 3, 4], 0.025), 1);
  assertEquals(nearestRank([1, 2, 3, 4], 0.975), 4);
  const ts = Array.from({ length: 40 }, (_, i) => tr(1 + (i % 20), i % 3 === 0 ? -1 : 1.2));
  const a = bootstrapCI(ts), b = bootstrapCI(ts);
  assertEquals(a, b);
  assert(a.lo < expectancy(ts) && expectancy(ts) < a.hi);
});

clause(["12.3", "12.4", "12.5"], "safety PARK at DD > 10R; initial gate PASS/EXTEND/PARK only once 28 days AND 60 trades; ceiling", () => {
  assertEquals(safety([tr(5, -10)]), "NONE");
  assertEquals(safety([tr(5, -10.01)]), "PARK");
  const first = day(1);
  const win = Array.from({ length: 60 }, (_, i) => tr(1 + (i % 28), i % 2 ? 1.0 : -0.4));          // mean 0.3
  assertEquals(initialGate(win, first, first + 27 * 86_400_000), "NONE");                          // < 28 days
  assertEquals(initialGate(win.slice(0, 59), first, first + 40 * 86_400_000), "NONE");             // < 60 trades
  assertEquals(initialGate(win, first, first + 40 * 86_400_000), "PASS");
  const flat = Array.from({ length: 60 }, (_, i) => tr(1 + (i % 28), i % 2 ? 0.9 : -0.85));        // mean 0.025 → EXTEND
  assertEquals(initialGate(flat, first, first + 40 * 86_400_000), "EXTEND");
  const lose = Array.from({ length: 60 }, (_, i) => tr(1 + (i % 28), i % 2 ? 0.5 : -0.6));
  assertEquals(initialGate(lose, first, first + 40 * 86_400_000), "PARK");
  assertEquals(ceilingGate(win, first, first + 40 * 86_400_000), "NONE");
  assertEquals(ceilingGate(win, first, first + 12 * 7 * 86_400_000), "PASS");
  assertEquals(ceilingGate(flat, first, first + 12 * 7 * 86_400_000), "PARK");
});

clause(["12.7"], "per-pair classification needs ≥ 15 resolved trades", () => {
  const ts = Array.from({ length: 15 }, (_, i) => tr(1 + i, 0.5, "USD/JPY"));
  const r = perPair([...ts, tr(3, 1, "EUR/USD")]);
  assertEquals([r["USD/JPY"], r["EUR/USD"]], ["POSITIVE", "INSUFFICIENT"]);
});

clause(["12.1"], "Phase 3 frequency: trades / complete eligible days × 5; < 5/week fails; < 10 days → no verdict", () => {
  assertEquals(phase3Frequency(9, 10), { perWeek: 4.5, verdict: "LOW_FREQUENCY_FAIL" });
  assertEquals(phase3Frequency(10, 10), { perWeek: 5, verdict: "OK" });
  assertEquals(phase3Frequency(30, 9).verdict, "INSUFFICIENT_DAYS");
});

// Reference written from the §12.2 (B1) text, independent of v2Evaluation's helpers.
function refMulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

clause(["12.2", "B1"], "B1: mulberry32 stream, N day-block draws per resample, blocks concatenated, mean over all trades, nearest rank", () => {
  const a = mulberry32(20261010), b = refMulberry(20261010);
  for (let i = 0; i < 1000; i++) assertEquals(a(), b());
  const ts = [tr(5, 1.5), tr(5, -1), tr(6, -1), tr(7, 2), tr(7, -1), tr(7, 0.5), tr(8, -1)];
  // reference CI
  const days = new Map<string, number[]>();
  for (const t of [...ts].sort((x, y) => x.exitT - y.exitT)) {
    const d = new Date(t.entryT - 7 * 3_600_000).toISOString().slice(0, 10);   // all entries 09:00 NY → same calendar day
    (days.get(d) ?? days.set(d, []).get(d)!).push(t.netR);
  }
  const blocks = [...days.keys()].sort().map((d) => days.get(d)!);
  const rnd = refMulberry(20261010), stats: number[] = [];
  for (let r = 0; r < 10_000; r++) {
    const xs: number[] = [];
    for (let i = 0; i < blocks.length; i++) xs.push(...blocks[Math.floor(rnd() * blocks.length)]);
    stats.push(xs.reduce((p, q) => p + q, 0) / xs.length);
  }
  stats.sort((p, q) => p - q);
  assertEquals(bootstrapCI(ts), { lo: stats[Math.ceil(0.025 * 10_000) - 1], hi: stats[Math.ceil(0.975 * 10_000) - 1] });
});

clause(["12.2", "B1"], "B1: a day drawn twice contributes its whole block twice, in draw order, within-day order preserved", () => {
  const ts = [tr(5, 1), tr(5, 2, "GBP/USD", 7_200_000), tr(6, -1)];
  const blocks = dayBlocks(ts);
  assertEquals(blocks.map((b) => b.map((t) => t.netR)), [[1, 2], [-1]]);
  const draws = [0.9, 0.1];             // → day 1, then day 0
  let i = 0;
  assertEquals(resample(blocks, () => draws[i++]).map((t) => t.netR), [-1, 1, 2]);
  i = 0; const twice = [0.2, 0.3];
  assertEquals(resample(blocks, () => twice[i++]).map((t) => t.netR), [1, 2, 1, 2]);
});
