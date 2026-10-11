// §12 — evaluation metrics and gates over resolved V2 trades (net R). Pure; no I/O.
import { tradingDayOf } from "./calendar.ts";
import { PAIRS, type Pair } from "./spec.ts";

export interface ResolvedTrade { pair: Pair; entryT: number; exitT: number; netR: number }

/** §12.2 expectancy = mean net R of trades resolved at or before `at`. */
export function resolvedBy(trades: ResolvedTrade[], at: number): ResolvedTrade[] {
  return trades.filter((t) => t.exitT <= at);
}
export function expectancy(trades: ResolvedTrade[]): number {
  return trades.length ? trades.reduce((a, t) => a + t.netR, 0) / trades.length : NaN;
}

/** Deterministic PRNG for the bootstrap (mulberry32). The spec fixes the seed; the generator is recorded here. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank percentile of an ascending array. */
export function nearestRank(sorted: number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

const ddOrder = (a: ResolvedTrade, b: ResolvedTrade) => a.exitT - b.exitT || a.entryT - b.entryT || PAIRS.indexOf(a.pair) - PAIRS.indexOf(b.pair);

/** §12.2 (B1) day blocks: observed NY trading days of entry, chronological, each block in max-DD order. */
export function dayBlocks(trades: ResolvedTrade[]): ResolvedTrade[][] {
  const byDay = new Map<string, ResolvedTrade[]>();
  for (const t of trades) { const d = tradingDayOf(t.entryT); (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(t); }
  return [...byDay.keys()].sort().map((d) => byDay.get(d)!.sort(ddOrder));
}

/** §12.2 (B1) one resample: N draws floor(next()·N) from the shared stream; blocks concatenated in draw order. */
export function resample(blocks: ResolvedTrade[][], next: () => number): ResolvedTrade[] {
  const out: ResolvedTrade[] = [];
  for (let i = 0; i < blocks.length; i++) out.push(...blocks[Math.floor(next() * blocks.length)]);
  return out;
}

/** §12.2 (B1) 95% CI: 10,000 day-block resamples (mulberry32, seed 20261010), statistic = mean net R, nearest-rank 2.5 / 97.5. */
export function bootstrapCI(trades: ResolvedTrade[], resamples = 10_000, seed = 20261010): { lo: number; hi: number } {
  const blocks = dayBlocks(trades);
  if (blocks.length === 0) return { lo: NaN, hi: NaN };
  const next = mulberry32(seed);
  const stats: number[] = [];
  for (let r = 0; r < resamples; r++) stats.push(expectancy(resample(blocks, next)));
  stats.sort((a, b) => a - b);
  return { lo: nearestRank(stats, 0.025), hi: nearestRank(stats, 0.975) };
}

/** §12.2 max drawdown of cumulative net R ordered by exit time (ties: entry time, then pair order), from 0. */
export function maxDrawdown(trades: ResolvedTrade[]): number {
  const xs = [...trades].sort(ddOrder);
  let cum = 0, peak = 0, dd = 0;
  for (const t of xs) { cum += t.netR; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return dd;
}

export type Verdict = "PASS" | "EXTEND" | "PARK" | "NONE";

/** §12.3 safety: max DD > 10R → PARK (checked after every resolved trade). */
export function safety(trades: ResolvedTrade[]): Verdict {
  return maxDrawdown(trades) > 10 ? "PARK" : "NONE";
}

/** §12.4 initial gate — applies at the first decision time with ≥ 28 calendar days since the first run AND ≥ 60 resolved trades. */
export function initialGate(trades: ResolvedTrade[], firstRun: number, at: number): Verdict {
  const done = resolvedBy(trades, at);
  if (at - firstRun < 28 * 86_400_000 || done.length < 60) return "NONE";
  const e = expectancy(done);
  if (e <= 0) return "PARK";
  return e >= 0.10 && bootstrapCI(done).lo > 0 ? "PASS" : "EXTEND";
}

/** §12.5 ceiling — first of 250 resolved trades or 12 weeks since the first run. */
export function ceilingGate(trades: ResolvedTrade[], firstRun: number, at: number): Verdict {
  const done = resolvedBy(trades, at);
  if (done.length < 250 && at - firstRun < 12 * 7 * 86_400_000) return "NONE";
  const e = expectancy(done);
  return e >= 0.10 && bootstrapCI(done).lo > 0 && maxDrawdown(done) <= 10 ? "PASS" : "PARK";
}

/** §12.7 per pair: ≥ 15 resolved trades before classifying positive/negative. */
export function perPair(trades: ResolvedTrade[]): Record<Pair, "POSITIVE" | "NEGATIVE" | "INSUFFICIENT"> {
  return Object.fromEntries(PAIRS.map((p) => {
    const xs = trades.filter((t) => t.pair === p);
    if (xs.length < 15) return [p, "INSUFFICIENT"];
    return [p, expectancy(xs) > 0 ? "POSITIVE" : "NEGATIVE"];
  })) as Record<Pair, "POSITIVE" | "NEGATIVE" | "INSUFFICIENT">;
}

/** §12.1c Phase 3 frequency over the complete eligible days of 12.1e: < 5 trades/week → LOW_FREQUENCY_FAIL. */
export function phase3Frequency(resolvedCount: number, completeEligibleDays: number): { perWeek: number; verdict: "OK" | "LOW_FREQUENCY_FAIL" | "INSUFFICIENT_DAYS" } {
  if (completeEligibleDays < 10) return { perWeek: NaN, verdict: "INSUFFICIENT_DAYS" };
  const perWeek = (resolvedCount / completeEligibleDays) * 5;
  return { perWeek, verdict: perWeek < 5 ? "LOW_FREQUENCY_FAIL" : "OK" };
}
