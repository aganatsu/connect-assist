// Scenario tests for v2Lifecycle (§1.5–1.9, §2.2–2.3, §3.8–3.12, §4, §5, §6, §9, §10, §11.6, §15, AM1).
// Every scenario is also run through the independent checker and must agree 100%.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clause } from "./helpers/clause.ts";
import { baseScenario, build, ny, type OHLC, type Scenario } from "./helpers/scenario.ts";
import { P } from "./helpers/series.ts";
import { isExpected, nyLocalToUtc } from "../../functions/_shared/v2/calendar.ts";
import { type EngineInput, runEngine } from "../../functions/_shared/v2/engine.ts";
import { runChecker } from "../../functions/_shared/v2check/checker.ts";
import { compare } from "../../functions/_shared/v2check/compare.ts";
import type { Pair } from "../../functions/_shared/v2/spec.ts";

type Opts = Partial<Omit<EngineInput, "dataset">>;
function runScn(mod: (s: Scenario) => void = () => {}, opts: Opts = {}) {
  const sc = baseScenario(); mod(sc);
  const dataset = build(sc);
  const res = runEngine({ dataset, news: opts.news ?? "REPLAY", schedule: opts.schedule, measuredStart: opts.measuredStart });
  const chk = runChecker({ dataset, news: (opts.news ?? "REPLAY") as never, schedule: opts.schedule as never, measuredStart: opts.measuredStart });
  const d = compare(res.events, chk);
  assertEquals([d.onlyEngine.slice(0, 5), d.onlyChecker.slice(0, 5)], [[], []], "engine and checker disagree");
  const ev = (pair: Pair = sc.pair) => res.events.filter((e) => e.pair === pair && e.entity !== "DIR");
  const seq = (pair: Pair = sc.pair) => ev(pair).map((e) => `${e.entity}:${e.event}${e.entity === "POI" ? ":" + e.id.split("|")[4] : ""}`);
  return { res, ev, seq, sc };
}
const at = (r: ReturnType<typeof runScn>, entity: string, event: string) => r.ev().find((e) => e.entity === entity && e.event === event);
const BASE_SEQ = ["POI:QUALIFIED:FVG", "POI:QUALIFIED:OB", "POI:ARMED:FVG", "SETUP:ARMED", "SETUP:CONFIRMED", "SETUP:ENTERED", "TRADE:EXIT_TP"];

clause(["0.2", "0.4", "3.10", "4.1", "5.2", "5.3", "6.1", "6.2", "6.3", "6.4", "7.5", "9", "16", "SA1"], "full LONG lifecycle: arm on touch, CHoCH, enter at close[k] with the CHoCH-origin stop, TP exit; SHORT mirror identical", () => {
  for (const mirror of [false, true]) {
    const r = runScn((s) => { s.mirror = mirror; });
    assertEquals(r.seq(), BASE_SEQ);
    const m = mirror ? -1 : 1;
    // CHoCH origin = lowest low of (02:30, 03:00] = −0.5 → SL −1.5; lots = 500 / ((6 + 1.5) pips × $10) = 6.66
    assertEquals(at(r, "SETUP", "ENTERED")!.data, { entry: P(4.5 * m), sl: P(-1.5 * m), reaction: P(-0.5 * m), tp: P(20 * m), lots: 6.66, limitedBy: null });
    assertEquals(at(r, "SETUP", "ARMED")!.t, ny(15, 2, 55));
    assertEquals(at(r, "TRADE", "EXIT_TP")!.data, { exitPrice: P(20 * m), gapDuring: false });
    assertEquals(r.res.trades[0].netR, (P(20) - P(4.5) - 1500) / (P(4.5) - P(-1.5)));
  }
});

clause(["6.3", "7.3"], "RR_BELOW_MIN: without the spike j (10) is the nearest valid target → R:R 0.47", () => {
  const r = runScn((s) => { s.m5.delete(ny(14, 16, 30)); });
  assertEquals(r.seq().slice(-1), ["SETUP:RR_BELOW_MIN"]);
  assertEquals(at(r, "SETUP", "RR_BELOW_MIN")!.data!.tp, P(10));
});

clause(["6.3", "7.1"], "NO_TARGET: every candidate swept before k", () => {
  const r = runScn((s) => { s.m5.set(ny(15, 2, 55), [1, 31, -0.5, 1.5]); });
  assertEquals(r.seq().slice(-1), ["SETUP:NO_TARGET"]);
});

clause(["6.3", "5.3"], "STOP_TOO_WIDE: reaction low beyond the distal edge (−20) → SL −21 → 25.5 pips > 1.5 × ATR", () => {
  const r = runScn((s) => { s.m5.set(ny(15, 2, 55), [1, 2, -20, 1.5]); });
  assertEquals(r.seq().slice(-1), ["SETUP:STOP_TOO_WIDE"]);
  assertEquals(at(r, "SETUP", "STOP_TOO_WIDE")!.data!.sl, P(-21));
});

clause(["6.3", "5.1"], "STOP_TOO_TIGHT: a newer protected swing (−1.5) inside the zone → entry −1.2, SL −4 → 2.8 < 3 pips", () => {
  const r = runScn((s) => {
    s.m5.delete(ny(15, 3, 0)); s.m5.delete(ny(15, 3, 5)); s.m5.delete(ny(15, 2, 55));
    const bars: [number, OHLC][] = [[55, [1, 1, -2.5, -2]], [60, [-2, -1.8, -2.7, -2.3]], [65, [-2.3, -1.8, -2.8, -2.5]],
      [70, [-2.5, -1.5, -2.9, -1.9]], [75, [-1.9, -1.7, -2.9, -2.6]], [80, [-2.6, -1.7, -2.9, -2.8]], [85, [-2.8, -1, -2.9, -1.2]]];
    for (const [min, b] of bars) s.m5.set(ny(15, 2, 0) + min * 60_000, b);
  });
  assertEquals(r.seq().slice(-2), ["SETUP:CONFIRMED", "SETUP:STOP_TOO_TIGHT"]);
  assertEquals(at(r, "SETUP", "STOP_TOO_TIGHT")!.data!.entry, P(-1.2));
});

clause(["4.2", "3.12", "15", "LO1", "SA1"], "LO1: a touch bar closing beyond the far edge does not end the setup; the OB on the same bar → SPENT_SAME_BAR; stop from the CHoCH origin (−4 → −5)", () => {
  const r = runScn((s) => { s.m5.set(ny(15, 2, 50), [2, 2, -4, -3.5]); });
  assertEquals(r.seq(), ["POI:QUALIFIED:FVG", "POI:QUALIFIED:OB", "POI:SPENT_SAME_BAR:OB", "POI:ARMED:FVG", "SETUP:ARMED", "SETUP:CONFIRMED", "SETUP:RR_BELOW_MIN"]);
  assertEquals(at(r, "SETUP", "RR_BELOW_MIN")!.data!.sl, P(-5));          // R:R (15.5 − 1.5) / 9.5 = 1.47
});

clause(["5.4", "15", "LO1", "10.2"], "LO1: a later 5m close beyond the far edge does not end the setup; the OB touched meanwhile → SPENT_PAIR_BUSY; entry with SL −4.6", () => {
  const r = runScn((s) => { s.m5.set(ny(15, 2, 55), [1, 2, -3.6, -3.5]); });
  assertEquals(r.ev().filter((e) => e.entity === "SETUP").map((e) => e.event), ["ARMED", "CONFIRMED", "ENTERED"]);
  assert(r.seq().includes("POI:SPENT_PAIR_BUSY:OB"));
  assertEquals(at(r, "SETUP", "ENTERED")!.data!.sl, P(-4.6));            // CHoCH origin −3.6 − 1 pip
});

clause(["5.4", "0.8"], "EXPIRED at the last window bar (decision 11:55 NY) without a CHoCH", () => {
  const r = runScn((s) => { s.m5.delete(ny(15, 3, 0)); s.m5.delete(ny(15, 3, 5)); });
  const e = at(r, "SETUP", "EXPIRED")!;
  assertEquals(e.t, ny(15, 11, 55));
});

clause(["3.11", "4.1", "0.8"], "touch outside the window → SPENT_OUTSIDE_WINDOW", () => {
  const r = runScn((s) => { s.m5.delete(ny(15, 2, 50)); s.m5.set(ny(15, 1, 30), [2, 2, 0.5, 1]); });
  assertEquals(r.seq().slice(2, 3), ["POI:SPENT_OUTSIDE_WINDOW:FVG"]);
  assert(!r.seq().includes("SETUP:ARMED"));
});

clause(["2.2", "2.1", "3.11", "TP1"], "TP1: a 15m opposite break in the last 10 bars no longer blocks arming (D1′ telemetry only)", () => {
  const r = runScn((s) => {
    s.m15.set(ny(15, 1, 45), [2, 2.5, 1.0, 2]);         // 15m swing low 1.0 (neighbours' lows 1.5)
    s.m15.set(ny(15, 2, 30), [2, 2.5, 0.5, 0.8]);       // close 0.8 < 1.0 on slot i+3 → bearish 15m break
  });
  assertEquals(r.seq(), BASE_SEQ);
  assert(r.res.events.some((e) => e.entity === "DIR" && e.pair === "EUR/USD" && e.data?.status === "VETOED"));   // still logged as telemetry
});

const FLIP_H1: [number, OHLC][] = [[33, [9, 10, 7, 8]], [34, [8, 10, 8, 9]], [35, [9, 10, 8, 9]], [36, [9, 9.5, 6, 6.5]]];
function flip(s: Scenario) {
  for (const [i, b] of FLIP_H1) s.h1[i] = b;                // 1H swing low 7 at 33, bearish break at 36 (closes 06:00 NY)
  for (let i = 37; i < 60; i++) s.h1[i] = [6.5, 7, 6.2, 6.5];
  s.m5.delete(ny(15, 3, 0)); s.m5.delete(ny(15, 3, 5));
}

clause(["2.3", "2.4", "TP1"], "TP1: the 1H bias turning SHORT while armed does not end the setup (it lives to EXPIRED at 11:55)", () => {
  const r = runScn(flip);
  assertEquals(r.ev().filter((e) => e.entity === "SETUP").map((e) => e.event), ["ARMED", "EXPIRED"]);
  assert(r.res.events.some((e) => e.entity === "DIR" && e.pair === "EUR/USD" && e.event === "SHORT" && e.t === ny(15, 6, 0)));
});

clause(["15", "3.9", "5.4", "LO1"], "same decision time: leg invalidation (step 2) precedes a 5m CHoCH (step 4)", () => {
  // CHoCH on the 02:55 bar (decision 03:00 = the close of 1H bar 33), and that 1H bar closes below the leg origin (−10)
  const r = runScn((s) => { s.m5.set(ny(15, 2, 55), [1, 5, -0.5, 4.5]); s.m5.delete(ny(15, 3, 0)); s.m5.delete(ny(15, 3, 5)); s.h1[33] = [9, 10, -11, -10.5]; });
  assertEquals(r.ev().filter((e) => e.entity === "SETUP").map((e) => e.event), ["ARMED", "LEG_INVALIDATED"]);
  assertEquals(at(r, "SETUP", "LEG_INVALIDATED")!.t, ny(15, 3, 0));
  // control: without that 1H close the same bar confirms
  const c = runScn((s) => { s.m5.set(ny(15, 2, 55), [1, 5, -0.5, 4.5]); s.m5.delete(ny(15, 3, 0)); s.m5.delete(ny(15, 3, 5)); });
  assertEquals(at(c, "SETUP", "CONFIRMED")!.t, ny(15, 3, 0));
});

clause(["3.9", "15", "LO1"], "leg invalidation (1H close below the origin) ends the armed setup and the untouched OB in step 2", () => {
  const r = runScn((s) => { s.h1[33] = [9, 10, -11, -10.5]; });
  assertEquals(r.seq().slice(-2).sort(), ["POI:LEG_INVALIDATED:OB", "SETUP:LEG_INVALIDATED"].sort());
  assertEquals(at(r, "SETUP", "LEG_INVALIDATED")!.t, ny(15, 3, 0));
});

clause(["1.5", "1.6"], "MISSING 5m after arming → DATA_GAP_ARMED; untouched OB → DATA_GAP_FRESHNESS_UNKNOWN (not provider-wide)", () => {
  const r = runScn((s) => { s.missing.push({ tf: "5m", t: ny(15, 2, 55) }); });
  assertEquals(r.seq().slice(-2).sort(), ["POI:DATA_GAP_FRESHNESS_UNKNOWN:OB", "SETUP:DATA_GAP_ARMED"].sort());
});

clause(["1.4", "1.5"], "the same interval MISSING on all six pairs → DATA_GAP_PROVIDER_WIDE", () => {
  const r = runScn((s) => { s.missing.push({ tf: "5m", t: ny(15, 2, 0), pairs: ["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF"] }); });
  assertEquals(r.seq().slice(2, 4).sort(), ["POI:DATA_GAP_PROVIDER_WIDE:FVG", "POI:DATA_GAP_PROVIDER_WIDE:OB"]);
});

clause(["1.9"], "a 1H interval MISSING after the leg's b → setup DATA_GAP_ARMED and OB DATA_GAP_FRESHNESS_UNKNOWN", () => {
  const r = runScn((s) => { s.missing.push({ tf: "1h", t: Date.parse("2026-09-15T06:00:00Z") }); });
  assertEquals(r.seq().slice(-2).sort(), ["POI:DATA_GAP_FRESHNESS_UNKNOWN:OB", "SETUP:DATA_GAP_ARMED"].sort());
  assertEquals(at(r, "SETUP", "DATA_GAP_ARMED")!.t, ny(15, 3, 0));
});

clause(["10.2", "4.3", "3.11", "5.3"], "OB touched while the FVG setup is live → SPENT_PAIR_BUSY; reaction low beyond the distal edge sets SL", () => {
  const r = runScn((s) => { s.m5.set(ny(15, 2, 55), [1, 2, -3.2, -2.9]); });
  assert(r.seq().includes("POI:SPENT_PAIR_BUSY:OB"));
  assertEquals(at(r, "SETUP", "ENTERED")!.data!.sl, P(-4.2));
});

clause(["11.6", "3.11", "5.5"], "non-TRADABLE decision time: touch spends (SPENT_DATA_PENDING); a CHoCH ends DATA_PENDING_CONFIRMATION", () => {
  const armT = ny(15, 2, 55), chochT = ny(15, 3, 5);
  const r1 = runScn(() => {}, { schedule: { tradable: (p, t) => !(p === "EUR/USD" && t === armT), runTime: (_p, t) => t } });
  assertEquals(r1.seq().slice(2, 3), ["POI:SPENT_DATA_PENDING:FVG"]);
  const r2 = runScn(() => {}, { schedule: { tradable: (p, t) => !(p === "EUR/USD" && t === chochT), runTime: (_p, t) => t } });
  assertEquals(r2.seq().slice(-1), ["SETUP:DATA_PENDING_CONFIRMATION"]);
  // late evaluation (processed at a later run) behaves the same and is never re-evaluated
  // the 02:55 bar arrives late: 02:55 and 03:00 are evaluated at the 03:05 run, non-TRADABLE, in order
  const lateSet = new Set([armT, armT + 300_000]);
  const r3 = runScn(() => {}, { schedule: {
    tradable: (p, t) => !(p === "EUR/USD" && lateSet.has(t)),
    runTime: (p, t) => (p === "EUR/USD" && lateSet.has(t) ? armT + 600_000 : t),
  } });
  assertEquals(r3.seq().slice(2, 3), ["POI:SPENT_DATA_PENDING:FVG"]);
});

const news = (events: { date: string; country?: string }[], fetchAt = ny(15, 2, 30), status = 200) => ({
  fetches: [{ fetchTime: fetchAt, httpStatus: status, body: events.map((e) => ({ title: "x", country: e.country ?? "USD", date: e.date, impact: "High" })) }],
  runClock: (_p: string, t: number) => t + 120_000,
});

clause(["8.1", "4.1", "3.11"], "forward news: event 5 min after the touch → SPENT_NEWS_BLOCK", () => {
  const r = runScn(() => {}, { news: news([{ date: "2026-09-15T03:00:00-04:00" }]) });
  assertEquals(r.seq().slice(2, 3), ["POI:SPENT_NEWS_BLOCK:FVG"]);
});

clause(["8.1", "5.4"], "forward news: event 25 min after the CHoCH → NEWS_BLOCKED_CONFIRMATION", () => {
  const r = runScn(() => {}, { news: news([{ date: "2026-09-15T03:30:00-04:00" }]) });
  assertEquals(r.seq().slice(-1), ["SETUP:NEWS_BLOCKED_CONFIRMATION"]);
});

clause(["8.2", "4.1", "5.4"], "feed UNAVAILABLE at the touch → SPENT_FEED_UNAVAILABLE; feed going stale while armed → NEWS_FEED_UNAVAILABLE", () => {
  const stale = runScn(() => {}, { news: news([], ny(15, 1, 0)) });       // fetched 01:00, touch decision 02:55 + 2 min → > 60 min
  assertEquals(stale.seq().slice(2, 3), ["POI:SPENT_FEED_UNAVAILABLE:FVG"]);
  const lapse = runScn(() => {}, { news: news([], ny(15, 2, 0)) });       // fresh at 02:57, stale by 03:07
  assertEquals(lapse.seq().slice(-1), ["SETUP:NEWS_FEED_UNAVAILABLE"]);
});

clause(["9", "1.7"], "exits: SL and TP in one bar → EXIT_SL; first bar after a MISSING gap opening beyond TP → EXIT_TP at TP, flagged", () => {
  const both = runScn((s) => { s.m5.set(ny(15, 3, 5), [4.5, 21, -5, 20]); });
  assertEquals(at(both, "TRADE", "EXIT_SL")!.data, { exitPrice: P(-1.5), gapDuring: false });
  const gapTp = runScn((s) => { s.missing.push({ tf: "5m", t: ny(15, 3, 5) }); s.m5.set(ny(15, 3, 10), [25, 26, 24, 25]); });
  assertEquals(at(gapTp, "TRADE", "EXIT_TP")!.data, { exitPrice: P(20), gapDuring: true });
  const gapSl = runScn((s) => { s.missing.push({ tf: "5m", t: ny(15, 3, 5) }); s.m5.set(ny(15, 3, 10), [-5, 30, -6, 25]); });
  assertEquals(at(gapSl, "TRADE", "EXIT_SL")!.data, { exitPrice: P(-1.5), gapDuring: true });
});

clause(["3.8"], "LOOKBACK_EXPIRED at the 1H close where b leaves the 120 most recent closed 1H bars (expected intervals)", () => {
  const r = runScn((s) => {
    for (const k of [...s.m5.keys()]) if (k > ny(15, 0, 0)) s.m5.delete(k);    // never touched
    s.end = nyLocalToUtc(2026, 9, 22, 12, 0);
  });
  const ex = r.ev().filter((e) => e.event === "LOOKBACK_EXPIRED");
  assertEquals(ex.length, 2);
  // b = expected 1H index 29 → expires at index 149 (b < L − 119) → close of interval 149
  const g: number[] = [];
  for (let t = r.sc.start; g.length < 150; t += 3_600_000) if (isExpected(t)) g.push(t);
  assertEquals(ex[0].t, g[149] + 3_600_000);
  assertEquals(new Date(ex[0].t).toISOString(), "2026-09-22T03:00:00.000Z");
});

clause(["10.1", "10.3", "15"], "four simultaneous candidates, three slots: rank by spread/ATR (equal ATR in pips), ties by fixed order → NZD/CAD SPENT_CAP", () => {
  const r = runScn((s) => { s.copies = [{ pair: "GBP/USD", shiftMs: 0 }, { pair: "USD/JPY", shiftMs: 0 }, { pair: "NZD/CAD", shiftMs: 0 }]; });
  for (const p of ["EUR/USD", "USD/JPY", "GBP/USD"] as Pair[]) assert(r.seq(p).includes("SETUP:ARMED"), p);
  assert(r.seq("NZD/CAD").includes("POI:SPENT_CAP:FVG"));
});

clause(["15", "10.1"], "step 3 before step 5: exits at k free slots for arming at k", () => {
  // three pairs exit TP on the 03:05 bar; NZD/CAD's touch is shifted to the same 03:05 bar
  const r = runScn((s) => { s.copies = [{ pair: "GBP/USD", shiftMs: 0 }, { pair: "USD/JPY", shiftMs: 0 }, { pair: "NZD/CAD", shiftMs: 15 * 60_000 }]; });
  assert(r.seq("NZD/CAD").includes("SETUP:ARMED"));
  assertEquals(r.ev("NZD/CAD").find((e) => e.event === "ARMED" && e.entity === "SETUP")!.t, ny(15, 3, 10));
});

// AM1 — an opposing SHORT POI that the confirmation bar itself touches. A SHORT leg is built on the preceding Thu/Fri:
// j' swing low −2, o' swing high 25 (bullish OB [4.2, 25]), b' closes −19; nothing touches the OB until bar k (high 5).
function withShortLeg(s: Scenario) {
  const pre: OHLC[] = [];
  for (let i = 0; i < 38; i++) pre.push([5, 7, 3, 6]);
  pre.push([5, 6, -2, 0], [0, 4, -1, 3], [3, 8, 2, 7], [7, 25, 4.2, 24], [24, 24.5, 5, 6], [6, 8, 1, 2], [2, 3, -20, -19], [-19, -18, -20, -19], [-19, -18, -20, -19]);
  s.start = nyLocalToUtc(2026, 9, 9, 17, 0);
  s.h1 = [...pre, ...s.h1];
  s.m5.delete(ny(14, 16, 30));                          // no spike (it would touch the SHORT OB)
  s.m5.set(ny(15, 2, 30), [2, 2.9, 1.5, 2]);            // protected swing 2.9: stays below the SHORT FVG [3, 5] so it is untouched before k
}

clause(["6.3", "7.4", "AM1"], "AM1: opposing POIs first touched by bar k still count for the entry at k → OPPOSING_POI_CONTAINS_ENTRY; their touch applies afterwards", () => {
  const r = runScn(withShortLeg);
  const longSetup = r.ev().filter((e) => e.entity === "SETUP" && e.id.includes("|LONG|")).map((e) => e.event);
  assertEquals(longSetup, ["ARMED", "CONFIRMED", "OPPOSING_POI_CONTAINS_ENTRY"]);
  // bar k also touched the SHORT FVG [3,5] and OB [4.2,25]; after the LONG setup ended in step 4, step 5 processes that touch:
  // the FVG (lowest POI.low) arms, the OB loses the same-bar selection
  const shortEv = r.ev().filter((e) => e.entity === "POI" && e.id.includes("|SHORT|") && e.event !== "QUALIFIED").map((e) => `${e.event}:${e.id.split("|")[4]}@${e.t === ny(15, 3, 5)}`);
  assertEquals(shortEv.sort(), ["ARMED:FVG@true", "SPENT_SAME_BAR:OB@true"]);
});

const conflictBar = (s: Scenario, at = ny(15, 2, 50)) => {
  withShortLeg(s); s.m5.set(at, [2, 5, 0.5, 4.5]); s.m5.delete(ny(15, 2, 55));
  if (at !== ny(15, 2, 50)) s.m5.delete(ny(15, 2, 50));
};

clause(["3.13", "CF1", "3.12", "15", "13"], "CF1: eligible LONG and SHORT POIs of one pair first touched on the same bar → neither arms, both SPENT_CONFLICT; mirror identical", () => {
  for (const mirror of [false, true]) {
    const r = runScn((s) => { conflictBar(s); s.mirror = mirror; });
    const atBar = r.ev().filter((e) => e.t === ny(15, 2, 55) && e.entity !== "DIR").map((e) => `${e.entity}:${e.event}:${e.id.split("|")[1]}/${e.id.split("|")[4]}`).sort();
    const L = mirror ? "SHORT" : "LONG", S = mirror ? "LONG" : "SHORT";
    // the selected POIs of each direction conflict; the losing same-direction POI is SPENT_SAME_BAR (3.12 runs first)
    assertEquals(atBar, [`POI:SPENT_CONFLICT:${L}/FVG`, `POI:SPENT_CONFLICT:${S}/FVG`, `POI:SPENT_SAME_BAR:${S}/OB`].sort());
    assert(!r.ev().some((e) => e.entity === "SETUP" && e.t === ny(15, 2, 55)));
  }
});

clause(["3.13", "CF1", "3.11", "0.8", "11.6"], "CF1: no conflict when both directions are ineligible — outside the window both end SPENT_OUTSIDE_WINDOW; non-TRADABLE both SPENT_DATA_PENDING", () => {
  const out = runScn((s) => conflictBar(s, ny(15, 1, 30)));
  const atOut = out.ev().filter((e) => e.t === ny(15, 1, 35) && e.entity === "POI").map((e) => e.event).sort();
  assertEquals(atOut, ["SPENT_OUTSIDE_WINDOW", "SPENT_OUTSIDE_WINDOW", "SPENT_SAME_BAR"]);
  const t = ny(15, 2, 55);
  const pend = runScn(conflictBar, { schedule: { tradable: (p, x) => !(p === "EUR/USD" && x === t), runTime: (_p, x) => x } });
  assertEquals(pend.ev().filter((e) => e.t === t && e.entity === "POI").map((e) => e.event).sort(), ["SPENT_DATA_PENDING", "SPENT_DATA_PENDING", "SPENT_SAME_BAR"]);
});

clause(["6.3", "7.4", "AM1"], "an opposing POI already spent before k is no obstacle at k", () => {
  const r = runScn((s) => { withShortLeg(s); s.m5.set(ny(15, 2, 55), [1, 4.3, -0.5, 1.5]); });   // touches [4.2, 25] at k−1
  assertEquals(r.seq().slice(-1), ["SETUP:RR_BELOW_MIN"]);
});

clause(["3.10", "0.4"], "touch checking starts with the first 5m bar closing strictly after b's close; low = POI.high is a touch", () => {
  // the 5m bar closing exactly at b's close (23:00 NY) reaches into the FVG → ignored; equality at 02:50 still arms
  const r = runScn((s) => { s.m5.set(ny(14, 22, 55), [2, 2, 0.5, 1]); s.m5.set(ny(15, 2, 50), [2, 2, 1, 1.5]); });
  assertEquals(r.seq().slice(0, 4), ["POI:QUALIFIED:FVG", "POI:QUALIFIED:OB", "POI:ARMED:FVG", "SETUP:ARMED"]);
  // one tick above the edge → no touch at 02:50 (the 02:55 bar touches instead)
  const r2 = runScn((s) => { s.m5.set(ny(15, 2, 50), [2, 2, 1.1, 1.5]); });
  assertEquals(r2.ev().find((e) => e.event === "ARMED")!.t, ny(15, 3, 0));
});

clause(["6.3", "7.1a", "7.6", "13", "GT"], "GT at entry: j valid at a 5m gap → UNKNOWN between entry and target → DATA_GAP_ENTRY; j swept before the gap → stays SWEPT → ENTERED", () => {
  // no spike: j (10) is valid and unswept when the gap starts → UNKNOWN after it
  const r = runScn((s) => { s.m5.delete(ny(14, 16, 30)); s.missing.push({ tf: "5m", t: ny(14, 18, 0) }); });
  assertEquals(r.ev().filter((e) => e.entity === "SETUP").map((e) => e.event), ["ARMED", "CONFIRMED", "DATA_GAP_ENTRY"]);
  // spike at 16:30 sweeps j before the 18:00 gap → SWEPT stays SWEPT; prev-day 30 is UNKNOWN but beyond TP 20 → trade
  const r2 = runScn((s) => { s.missing.push({ tf: "5m", t: ny(14, 18, 0) }); });
  assertEquals(r2.ev().filter((e) => e.entity === "SETUP").map((e) => e.event), ["ARMED", "CONFIRMED", "ENTERED"]);
});

clause(["8.4", "12.1"], "replay treats the feed as AVAILABLE with no events; forward with no snapshot spends the POI", () => {
  assertEquals(runScn().seq(), BASE_SEQ);
  const fwd = runScn(() => {}, { news: { fetches: [], runClock: (_p, t) => t + 120_000 } });
  assertEquals(fwd.seq().slice(2, 3), ["POI:SPENT_FEED_UNAVAILABLE:FVG"]);
});

clause(["0.12", "W1", "3.11", "13"], "W1: a touch during warm-up spends the POI (SPENT_WARMUP); nothing arms; the measured window starts with zero live items", () => {
  const r = runScn(() => {}, { measuredStart: ny(15, 3, 0) });
  assertEquals(r.seq(), ["POI:QUALIFIED:FVG", "POI:QUALIFIED:OB", "POI:SPENT_WARMUP:FVG"]);
  assert(!r.ev().some((e) => e.entity === "SETUP" || e.entity === "TRADE"));
});

clause(["0.12", "W1"], "W1: market state built in warm-up carries into the window (POIs qualified in warm-up arm normally after M)", () => {
  const r = runScn(() => {}, { measuredStart: ny(15, 2, 0) });
  assertEquals(r.seq(), BASE_SEQ);
});

clause(["0.12", "W1", "3.12"], "W1: in warm-up every touched fresh POI ends SPENT_WARMUP (no same-bar selection)", () => {
  const r = runScn((s) => { s.m5.set(ny(15, 2, 50), [2, 2, -4, -2]); }, { measuredStart: ny(15, 3, 0) });
  assertEquals(r.seq().slice(2).sort(), ["POI:SPENT_WARMUP:FVG", "POI:SPENT_WARMUP:OB"]);
});
