// Engine vs the independent checker on randomized inputs: markets with gaps, late / non-TRADABLE decision times
// (§11.6) and forward news feeds with outages (§8). 100% agreement on every event is required.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clause } from "./helpers/clause.ts";
import { generate, rng } from "./helpers/gen.ts";
import { runEngine } from "../../functions/_shared/v2/engine.ts";
import { runChecker } from "../../functions/_shared/v2check/checker.ts";
import { compare } from "../../functions/_shared/v2check/compare.ts";
import { isExpected } from "../../functions/_shared/v2/calendar.ts";
import { PAIRS, type Pair } from "../../functions/_shared/v2/spec.ts";

const START = Date.UTC(2026, 8, 14);

/** Random §11.6 schedule: some bars arrive late (the pair's next decision times wait for the same run). */
function randomSchedule(seed: number, start: number, end: number) {
  const r = rng(seed);
  const run = new Map<string, number>(), trad = new Map<string, boolean>();
  for (const p of PAIRS) {
    let carry = -Infinity;
    for (let o = start; o < end; o += 300_000) {
      if (!isExpected(o)) continue;
      const t = o + 300_000;
      if (carry < t && r() < 0.01) carry = t + 300_000 * (1 + Math.floor(r() * 4));    // this bar is late by 1–4 runs
      const runT = Math.max(t, carry > t ? carry : t);
      run.set(`${p}|${t}`, runT);
      trad.set(`${p}|${t}`, runT === t && r() >= 0.01);                                // 1% pending HTF at its own run
    }
  }
  return {
    tradable: (p: Pair | string, t: number) => trad.get(`${p}|${t}`) ?? true,
    runTime: (p: Pair | string, t: number) => run.get(`${p}|${t}`) ?? t,
  };
}

function randomNews(seed: number, start: number, end: number) {
  const r = rng(seed);
  const fetches = [];
  const ccy = ["USD", "EUR", "GBP", "JPY", "CHF", "NZD", "CAD"];
  for (let f = start; f < end; f += 30 * 60_000) {
    if (r() < 0.04) continue;                                                       // missed fetch → feed may go stale
    const failed = r() < 0.03;
    const events = [];
    for (let i = 0; i < 3; i++) {
      const d = f + Math.floor(r() * 6 * 3_600_000);
      const iso = new Date(d - 4 * 3_600_000).toISOString().slice(0, 19) + "-04:00";
      events.push({ title: "evt", country: ccy[Math.floor(r() * ccy.length)], date: iso, impact: r() < 0.5 ? "High" : "Medium" });
    }
    fetches.push({ fetchTime: f, httpStatus: failed ? 503 : 200, body: failed ? null : events });
  }
  return fetches;
}

function check(seed: number, opts: { days: number; m5?: number; h?: number; schedule?: boolean; news?: boolean; warmupDays?: number }) {
  const ds = generate({ seed, start: START, days: opts.days, missing5m: opts.m5 ?? 0, missing1h: opts.h ?? 0, missing15m: opts.h ?? 0 });
  const schedule = opts.schedule ? randomSchedule(seed * 7 + 1, ds.start, ds.end) : undefined;
  const fetches = opts.news ? randomNews(seed * 13 + 5, ds.start - 3_600_000, ds.end) : null;
  const news = fetches ? { fetches, runClock: (_p: string, t: number) => (schedule ? schedule.runTime(_p, t) : t) + 120_000 } : "REPLAY" as const;
  const measuredStart = opts.warmupDays ? ds.start + opts.warmupDays * 86_400_000 : undefined;
  const e = runEngine({ dataset: ds, news, schedule, measuredStart }).events;
  const c = runChecker({ dataset: ds, news, schedule, measuredStart });
  const d = compare(e, c);
  assertEquals([d.onlyEngine.slice(0, 3), d.onlyChecker.slice(0, 3)], [[], []], `seed ${seed}`);
  return d.agree;
}

clause(["12.1", "15", "16"], "fidelity: replay on clean random markets (3 seeds × 14 days)", () => {
  for (const s of [101, 102, 103]) check(s, { days: 14 });
});

clause(["1.3a", "1.5", "1.6", "1.7", "1.9", "AM2"], "fidelity: random markets with MISSING 5m/15m/1H bars", () => {
  for (const s of [201, 202, 203]) check(s, { days: 14, m5: 0.003, h: 0.006 });
});

clause(["11.6", "10.3"], "fidelity: random late and non-TRADABLE decision times", () => {
  for (const s of [301, 302]) check(s, { days: 14, schedule: true });
});

clause(["8.1", "8.2"], "fidelity: forward news feed with high-impact events, failed and missed fetches", () => {
  for (const s of [401, 402]) check(s, { days: 14, news: true, schedule: true, m5: 0.002 });
});

clause(["0.12", "W1", "GT", "PS"], "fidelity: warm-up before a measured start, with gaps", () => {
  for (const s of [501, 502, 503]) check(s, { days: 14, warmupDays: 6, m5: 0.002, h: 0.004 });
});
