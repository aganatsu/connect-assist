/**
 * IPO_BASELINE_1H_4H_CAUSAL_V2 — causality of the corrected decision layer.
 *
 * The defect being repaired: the production lifecycle decides on CLOSED bars
 * and checks invalidation before the touch, so a bar that fills the entry and
 * later closes beyond S2 erases a trade that already existed. These tests pin
 * the corrected order — the trade exists at its fill minute, and nothing that
 * happens later in the bar (or later in time) can remove it.
 */

import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  LifecycleFeed, levels, potentialEntry, resolveTrade, scanSeries, simulateSlot,
  type BarState, type CandidateView, type PotentialEntry, type Stream,
} from "../../../local-runner/ipoCausalV2.ts";
import type { Candle } from "../../../supabase/functions/_shared/smcAnalysis.ts";

const M = 60_000, H = 3_600_000;
const T0 = Date.parse("2025-03-03T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** One strategy bar from a list of per-minute closes; the bar is the minutes' aggregate. */
function barFromPath(start: number, path: number[], spread = 0.00002): { bar: Candle; minutes: Candle[] } {
  const minutes: Candle[] = path.map((c, i) => {
    const o = i ? path[i - 1] : c;
    return { datetime: iso(start + i * M), open: o, close: c, high: Math.max(o, c) + spread, low: Math.min(o, c) - spread };
  });
  return {
    bar: { datetime: iso(start), open: minutes[0].open, close: minutes.at(-1)!.close,
      high: Math.max(...minutes.map((m) => m.high)), low: Math.min(...minutes.map((m) => m.low)) },
    minutes,
  };
}
const flat = (n: number, p: number) => Array.from({ length: n }, () => p);
const ramp = (n: number, a: number, b: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 1)) / n);

// Demand zone: proximal 1.1000, entry (50%) 1.0990, S2 = IPO low 1.0980, target 1.1010.
const LONG: CandidateView = { k: 1, direction: "demand", zoneLow: 1.099, zoneHigh: 1.1, invalidationLevel: 1.098,
  validAt: 2, suppressed: false, invalidatedAt: null, hasFvg: true, lastTouch: null };
// Supply zone mirrored: proximal 1.1000, entry 1.1010, S2 = IPO high 1.1020, target 1.0990.
const SHORT: CandidateView = { k: 1, direction: "supply", zoneLow: 1.1, zoneHigh: 1.101, invalidationLevel: 1.102,
  validAt: 2, suppressed: false, invalidatedAt: null, hasFvg: true, lastTouch: null };
const state = (c: CandidateView, vol: BarState["vol"] = "HIGH_VOL"): BarState => ({ tracked: [c], vol });
const COST = (_p: number) => 0.00002;

/** A 1h series of `n` bars; bar K follows `pathK`, the rest sit flat at `rest`. */
function series(n: number, K: number, pathK: number[], rest = 1.1005, after?: (j: number) => number[]) {
  const bars: Candle[] = [], mins: Candle[][] = [];
  for (let j = 0; j < n; j++) {
    const p = j === K ? pathK : j > K && after ? after(j) : flat(60, rest);
    const { bar, minutes } = barFromPath(T0 + j * H, p);
    bars.push(bar); mins.push(minutes);
  }
  return { bars, mins, minutesFor: (j: number) => mins[j] ?? [] };
}
const stream = (tf: string, s: ReturnType<typeof series>, pes: PotentialEntry[], barMs = H): Stream =>
  ({ tf, bars: s.bars, barMs, pes, minutesFor: s.minutesFor });

// ── 1. a future close cannot prevent an earlier valid fill ─────────────────
Deno.test("the bar's later close never decides whether the earlier fill existed", () => {
  // dip to the entry at minute 10, then collapse through S2 into the close
  const path = [...ramp(10, 1.1004, 1.0989), ...ramp(50, 1.0989, 1.0972)];
  const { bar, minutes } = barFromPath(T0 + 5 * H, path);
  const pe = potentialEntry("1h", 5, bar, H, state(LONG), false, minutes)!;
  assert(pe, "the fill happened");
  assertEquals(pe.fillMinute, iso(T0 + 5 * H + 9 * M));
  for (const close of [1.0972, 1.2, 0.9, 1.0995]) {
    const again = potentialEntry("1h", 5, { ...bar, close }, H, state(LONG), false, minutes)!;
    assertEquals(again.fillMinute, pe.fillMinute, `close ${close} must not matter`);
    assertEquals(again.cand.k, pe.cand.k);
  }
});

// ── 2. changing the candle after entry does not change the entry ───────────
Deno.test("rewriting everything after the fill minute leaves the entry untouched", () => {
  const head = ramp(10, 1.1004, 1.0989);
  const a = barFromPath(T0 + 5 * H, [...head, ...ramp(50, 1.0989, 1.0972)]);   // crash
  const b = barFromPath(T0 + 5 * H, [...head, ...ramp(50, 1.0989, 1.1013)]);   // rally through target
  const pa = potentialEntry("1h", 5, a.bar, H, state(LONG), false, a.minutes)!;
  const pb = potentialEntry("1h", 5, b.bar, H, state(LONG), false, b.minutes)!;
  assertEquals(pa.fillMinute, pb.fillMinute);
  assertEquals(pa.fillMs, pb.fillMs);
  assertEquals(pa.lv, pb.lv);
});

// ── 3. same-bar S2 close: entered, then S2 ─────────────────────────────────
Deno.test("LONG: entry touched, same bar closes below S2 -> trade exists and exits at S2", () => {
  const s = series(10, 5, [...ramp(10, 1.1004, 1.0989), ...ramp(50, 1.0989, 1.0972)]);
  const pe = potentialEntry("1h", 5, s.bars[5], H, state(LONG), false, s.mins[5])!;
  const { trades } = simulateSlot([stream("1h", s, [pe])], COST);
  assertEquals(trades.length, 1);
  const t = trades[0];
  assertEquals(t.res.outcome, "S2_CLOSE");
  assertEquals(t.res.sameBarS2, true);
  assertEquals(t.res.exitIdx, 5);
  assertEquals(t.res.exitPrice, s.bars[5].close);
  assert(t.netR! < -1, `loss beyond 1R: ${t.netR}`);
  assert(Math.abs(t.costR - (2 * 0.00002) / 0.001) < 1e-9, "costs are included");
});

Deno.test("SHORT: entry touched, same bar closes above S2 -> trade exists and exits at S2", () => {
  const s = series(10, 5, [...ramp(10, 1.1005, 1.1011), ...ramp(50, 1.1011, 1.1027)], 1.1005);
  const pe = potentialEntry("1h", 5, s.bars[5], H, state(SHORT), false, s.mins[5])!;
  const t = simulateSlot([stream("1h", s, [pe])], COST).trades[0];
  assertEquals(t.res.outcome, "S2_CLOSE");
  assertEquals(t.res.sameBarS2, true);
  assert(t.res.grossR! < -1);
});

// ── 4. same-minute entry/target is not assumed favourable ──────────────────
Deno.test("entry and target inside one minute -> AMBIGUOUS, no R, and the open branch keeps the slot", () => {
  // minute 10 spans 1.0985..1.1015: reaches entry AND target; then drifts and later closes below S2
  const pathK = [...ramp(9, 1.1004, 1.1001), 1.0985, ...flat(50, 1.0995)];
  const s = series(12, 5, pathK, 1.1005, (j) => (j === 8 ? ramp(60, 1.0995, 1.0975) : flat(60, 1.0995)));
  s.mins[5][9] = { ...s.mins[5][9], high: 1.1015, low: 1.0985 };
  s.bars[5] = { ...s.bars[5], high: 1.1015, low: 1.0985 };
  const pe = potentialEntry("1h", 5, s.bars[5], H, state(LONG), false, s.mins[5])!;
  const res = resolveTrade(s.bars, H, 5, pe.lv, s.minutesFor);
  assertEquals(res.outcome, "AMBIGUOUS");
  assertEquals(res.altBranch, "CLOSED_AT_TARGET");
  assertEquals(res.openBranch, "S2_CLOSE");
  assertEquals(res.exitIdx, 8);
  // a later fill while the open branch is still running is refused
  const late: PotentialEntry = { ...pe, tf: "4h", K: 6, fillMs: T0 + 6 * H + 5 * M };
  const out = simulateSlot([stream("1h", s, [pe]), stream("4h", s, [late])], COST);
  assertEquals(out.trades.length, 1);
  assertEquals(out.trades[0].netR, null);
  assertEquals(out.blocked[0].reason, "SLOT_HELD");
});

// ── 5. a recovered trade occupies the slot ─────────────────────────────────
Deno.test("a recovered same-bar-S2 trade blocks fills until its close, then frees the slot", () => {
  const s = series(10, 5, [...ramp(10, 1.1004, 1.0989), ...ramp(50, 1.0989, 1.0972)]);
  const pe = potentialEntry("1h", 5, s.bars[5], H, state(LONG), false, s.mins[5])!;
  const during: PotentialEntry = { ...pe, tf: "4h", K: 1, fillMs: T0 + 5 * H + 30 * M };     // inside the 1h bar
  const after: PotentialEntry = { ...pe, tf: "4h", K: 2, fillMs: T0 + 6 * H + 5 * M };       // after its close
  const out = simulateSlot([stream("1h", s, [pe]), stream("4h", s, [during, after])], COST);
  assertEquals(out.trades.map((t) => t.pe.fillMs), [pe.fillMs, after.fillMs]);
  assertEquals(out.blocked.map((b) => [b.pe.fillMs, b.reason]), [[during.fillMs, "SLOT_HELD"]]);
});

Deno.test("same timeframe: no re-entry on the bar the previous trade exited (frozen rule)", () => {
  // enter bar 5, target in bar 6 at minute 20; a fill later in bar 6 is refused, bar 7 is allowed
  const s = series(10, 5, [...ramp(10, 1.1004, 1.0989), ...flat(50, 1.0995)], 1.1005,
    (j) => (j === 6 ? [...ramp(20, 1.0995, 1.1012), ...flat(40, 1.1005)] : flat(60, 1.1005)));
  const pe = potentialEntry("1h", 5, s.bars[5], H, state(LONG), false, s.mins[5])!;
  const sameBar: PotentialEntry = { ...pe, K: 6, fillMs: T0 + 6 * H + 40 * M };
  const next: PotentialEntry = { ...pe, K: 7, fillMs: T0 + 7 * H + 1 * M };
  const out = simulateSlot([stream("1h", s, [pe, sameBar, next])], COST);
  assertEquals(out.trades[0].res.outcome, "TARGET");
  assertEquals(out.trades[0].res.exitIdx, 6);
  assert(out.trades[0].res.targetMinute! < iso(T0 + 6 * H + 20 * M), "exit timed by the tape, not the bar close");
  assertEquals(out.blocked.map((b) => b.reason), ["SAME_TF_EXIT_BAR"]);
  assertEquals(out.trades.map((t) => t.pe.K), [5, 7]);
});

// ── 6. candles beyond the exit cannot alter prior decisions ────────────────
Deno.test("rewriting everything after a trade's exit leaves that trade identical", () => {
  const mk = (tail: number) => series(14, 5, [...ramp(10, 1.1004, 1.0989), ...ramp(50, 1.0989, 1.0972)], 1.1005,
    (j) => (j >= 7 ? flat(60, tail) : flat(60, 1.1005)));
  const a = mk(1.1005), b = mk(1.25);
  const pa = potentialEntry("1h", 5, a.bars[5], H, state(LONG), false, a.mins[5])!;
  const pb = potentialEntry("1h", 5, b.bars[5], H, state(LONG), false, b.mins[5])!;
  const ta = simulateSlot([stream("1h", a, [pa])], COST).trades[0];
  const tb = simulateSlot([stream("1h", b, [pb])], COST).trades[0];
  assertEquals(ta.res, tb.res);
  assertEquals(ta.netR, tb.netR);
});

// ── the production lifecycle is read one bar ahead ─────────────────────────
Deno.test("with the real production engine, the state V2 reads at K does not depend on bar K or later", () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const walk = (n: number, mutateFrom = Infinity): Candle[] => {
    seed = 7; let px = 1.1;
    return Array.from({ length: n }, (_, i) => {
      const o = px, c = px + (rnd() - 0.5) * 0.004 + (i >= mutateFrom ? 0.01 : 0);
      px = c;
      return { datetime: iso(T0 + i * H), open: o, close: c, high: Math.max(o, c) + rnd() * 0.001, low: Math.min(o, c) - rnd() * 0.001 };
    });
  };
  const cfg = { instrument: "EUR/USD", timeframe: "1h", highVolOnly: false, costPerSide: COST };
  const A = walk(300), B = walk(300, 220);
  assertNotEquals(A[250], B[250]);
  const fa = new LifecycleFeed(cfg), fb = new LifecycleFeed(cfg);
  for (let K = 0; K <= 220; K++) {
    const sa = fa.state(), sb = fb.state();
    assertEquals(sa, sb, `state before bar ${K}`);
    fa.feed(A[K]); fb.feed(B[K]);
  }
  const none = (_j: number) => [];
  const pa = scanSeries("1h", A, H, cfg, none).pes.TOUCH_ORDER.filter((p) => p.K < 220);
  const pb = scanSeries("1h", B, H, cfg, none).pes.TOUCH_ORDER.filter((p) => p.K < 220);
  assertEquals(pa.map((p) => [p.K, p.cand.k, p.fillMs]), pb.map((p) => [p.K, p.cand.k, p.fillMs]));
});

// ── levels are the frozen geometry ─────────────────────────────────────────
Deno.test("entry, stop and 2R target come straight from the candidate's frozen levels", () => {
  const l = levels(LONG), sh = levels(SHORT);
  assertEquals([l.long, l.entry, l.stop], [true, 1.099, 1.098]);
  assert(Math.abs(l.target - 1.101) < 1e-12 && Math.abs(l.risk - 0.001) < 1e-12);
  assertEquals([sh.long, sh.entry, sh.stop], [false, 1.101, 1.102]);
  assert(Math.abs(sh.target - 1.099) < 1e-12);
});

// ── zone selection when several eligible zones share a bar ─────────────────
// OLD (k=1): demand zone 1.0990-1.1000, entry 1.0990. NEW (k=3): demand zone 1.1010-1.1020, entry 1.1010.
const OLD: CandidateView = { ...LONG, k: 1 };
const NEW: CandidateView = { ...LONG, k: 3, zoneLow: 1.101, zoneHigh: 1.102, invalidationLevel: 1.1 };
const both = (): BarState => ({ tracked: [OLD, NEW], vol: "HIGH_VOL" });

Deno.test("TOUCH_ORDER: a newer zone that fills before the older zone is touched is a real entry", () => {
  // falls into NEW's 50% at minute 5, touches OLD only at minute 40 and never reaches its 50%
  const { bar, minutes } = barFromPath(T0 + 5 * H, [...ramp(5, 1.1025, 1.1009), ...ramp(35, 1.1009, 1.1003), ...ramp(20, 1.1003, 1.0995)]);
  const pe = potentialEntry("1h", 5, bar, H, both(), false, minutes, "TOUCH_ORDER")!;
  assertEquals(pe.cand.k, 3);
  assertEquals(pe.fillMinute, iso(T0 + 5 * H + 4 * M));
  // the frozen bar-level rule picks the OLDER zone (touched later) and refuses the bar
  assertEquals(potentialEntry("1h", 5, bar, H, both(), false, minutes, "PRODUCTION_BAR"), null);
});

Deno.test("TOUCH_ORDER: once the older zone is touched it is in charge, so a later newer-zone fill is refused", () => {
  // touches OLD at minute 1 without reaching its 50% (1.0990), then rallies into NEW's zone and its 50% (1.1010)
  const { bar, minutes } = barFromPath(T0 + 5 * H, [...ramp(5, 1.0996, 1.0999), ...ramp(55, 1.0999, 1.1012)]);
  assertEquals(potentialEntry("1h", 5, bar, H, both(), false, minutes, "TOUCH_ORDER"), null, "OLD is the hit from minute 1 and never fills");
  assertEquals(potentialEntry("1h", 5, bar, H, both(), false, minutes, "PRODUCTION_BAR"), null);
  assertEquals(potentialEntry("1h", 5, bar, H, both(), false, minutes, "EARLIEST_FILL")!.cand.k, 3, "the non-frozen comparison rule would take NEW");
});

// ── the real engine: a bar's own close (and everything after) cannot change its entry ─
Deno.test("real production lifecycle: rewriting an entry bar's close and all later bars leaves that entry identical", () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let px = 1.1, vol = 0.002;
  const bars: Candle[] = [];
  for (let i = 0; i < 300; i++) {
    vol = Math.max(0.0005, Math.min(0.006, vol * (0.9 + rnd() * 0.22)));
    const o = px, c = px + (rnd() - 0.5) * vol * 2; px = c;
    bars.push({ datetime: iso(T0 + i * H), open: o, close: c, high: Math.max(o, c) + rnd() * vol * 0.6, low: Math.min(o, c) - rnd() * vol * 0.6 });
  }
  const cfg = { instrument: "EUR/USD", timeframe: "1h", highVolOnly: false, costPerSide: COST };
  const none = (_j: number) => [];
  const base = scanSeries("1h", bars, H, cfg, none).pes;
  const targets = base.PRODUCTION_BAR.slice(0, 8);
  assert(targets.length >= 5, `need entries to test (${targets.length})`);
  let changedSomething = 0;
  for (const pe of targets) {
    const X = pe.K;
    // close to the far end of the bar's own range — through the stop when the range allows — and wreck the future
    const rewritten = bars.map((b, j) => j === X ? { ...b, close: pe.lv.long ? b.low : b.high }
      : j > X ? { ...b, open: b.open + 0.02, high: b.high + 0.03, low: b.low + 0.01, close: b.close + 0.02 } : b);
    const again = scanSeries("1h", rewritten, H, cfg, none).pes;
    for (const sel of ["PRODUCTION_BAR", "TOUCH_ORDER"] as const) {
      const a = base[sel].find((p) => p.K === X), b = again[sel].find((p) => p.K === X);
      assertEquals(b && [b.cand.k, b.cand.direction, b.fillMs, b.lv.entry], a && [a.cand.k, a.cand.direction, a.fillMs, a.lv.entry], `${sel} entry at bar ${X}`);
    }
    if (pe.lv.long ? bars[X].low < pe.lv.stop : bars[X].high > pe.lv.stop) changedSomething++;
  }
  assert(changedSomething >= 1, "at least one rewritten close lands beyond the stop (the defect's own trigger)");
});

Deno.test("a zone is enterable only if everything about it was settled before the bar opened", () => {
  const { bar, minutes } = barFromPath(T0 + 5 * H, [...ramp(10, 1.1004, 1.0989), ...flat(50, 1.0995)]);
  const at = (c: CandidateView, vol: BarState["vol"] = "HIGH_VOL", highVolOnly = false) =>
    potentialEntry("1h", 5, bar, H, { tracked: [c], vol }, highVolOnly, minutes);
  assert(at(LONG), "control: the clean zone fills");
  assertEquals(at({ ...LONG, invalidatedAt: 3 }), null, "invalidated before the bar");
  assertEquals(at({ ...LONG, validAt: null }), null, "not yet validated");
  assertEquals(at({ ...LONG, validAt: 5 }), null, "validated by this very bar's close");
  assertEquals(at({ ...LONG, suppressed: true }), null, "inside a contraction");
  assertEquals(at({ ...LONG, hasFvg: false }), null, "no FVG yet");
  assertEquals(at({ ...LONG, lastTouch: 4 }), null, "the previous bar was a touch: not a new visit");
  assert(at({ ...LONG, lastTouch: 3 }), "two bars back is a new visit");
  assertEquals(at(LONG, "MID_VOL", true), null, "volatility-gated instrument, bucket known before the bar is not HIGH");
  assert(at(LONG, "HIGH_VOL", true));
});
