import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { addZones, advanceBars, FLIP_VALID_MS, FORGET_AFTER_MS, initBreakerState, zoneId, type Bar, type BreakerEvent } from "../../../functions/_shared/breaker/breakerEngine.ts";

/** The breaker engine on hand-made 5m paths. The full rule was checked against the research replay (strategy-v2/flip-zones/parity_engine.ts: identical trades on all six pairs). */

const M5 = 300_000, T0 = Date.parse("2026-11-09T08:00:00Z"), pip = 0.0001;
const P = { pair: "EUR/USD", pip, costPips: 1.5, minSlPips: 20 };
/** Bars from (o,h,l,c) tuples, 5 minutes apart from T0, after 300 flat warm-up bars. */
function bars(path: [number, number, number, number][]): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < 300; i++) out.push({ t: T0 - (300 - i) * M5, o: 1.1030, h: 1.1032, l: 1.1028, c: 1.1030 });
  path.forEach(([o, h, l, c], i) => out.push({ t: T0 + i * M5, o, h, l, c }));
  return out;
}
const Z = { id: zoneId("EUR/USD", "long", 1.1000, 1.1010, pip), dir: "long" as const, zoneType: "FVG", zl: 1.1000, zh: 1.1010, seenT: T0, intact: true };
function run(path: [number, number, number, number][], zones = [Z]) {
  const m5 = bars(path);
  let st = initBreakerState(T0);
  const a = addZones(st, zones, T0); st = a.state;
  const r = advanceBars(st, m5, P, m5.at(-1)!.t + M5);
  return { events: [...a.events, ...r.events], state: r.state };
}
const types = (ev: BreakerEvent[]) => ev.map((e) => `${e.type}${"arm" in e && e.arm ? ":" + e.arm : ""}`);

Deno.test("a 5m close below a buy zone flips it to a sell: entry at the low, stop = pair minimum, target 1.5R", () => {
  const { events } = run([[1.1012, 1.1013, 1.1005, 1.1006], [1.1006, 1.1007, 1.0995, 1.0996]]);
  const f = events.find((e) => e.type === "flipped") as Extract<BreakerEvent, { type: "flipped" }>;
  assertEquals([f.flipDir, f.E, +f.S.toFixed(5), +f.T.toFixed(5), f.t], ["short", 1.1000, 1.1020, 1.0970, T0 + 2 * M5]);
});

Deno.test("a wick through is not a break: only a close beyond the far side counts", () => {
  const { events } = run([[1.1012, 1.1013, 1.0990, 1.1003]]);
  assertEquals(types(events), ["seen"]);
});

Deno.test("limit arm: fills at the zone edge on the return and takes the 1.5R target; the break bar is never an entry bar", () => {
  const { events } = run([
    [1.1006, 1.1007, 1.0990, 1.0992],              // break (its high is beyond nothing; no entry on this bar)
    [1.0992, 1.0998, 1.0990, 1.0997],
    [1.0997, 1.1001, 1.0996, 1.0999],              // returns to E = 1.1000: limit fills at 1.1000
    [1.0999, 1.0999, 1.0985, 1.0986],
    [1.0986, 1.0987, 1.0968, 1.0969],              // target 1.0970
  ]);
  const fill = events.find((e) => e.type === "filled" && e.arm === "L") as Extract<BreakerEvent, { type: "filled" }>;
  const close = events.find((e) => e.type === "closed" && e.arm === "L") as Extract<BreakerEvent, { type: "closed" }>;
  assertEquals([fill.position.fill, fill.t], [1.1000, T0 + 3 * M5]);
  assertEquals([close.result, close.gross, close.t], ["TP", 1.5, T0 + 5 * M5]);
  assertEquals(close.net, +(1.5 - 1.5 * pip / 0.0020).toFixed(4));
});

Deno.test("limit arm: a bar that fills and reaches the stop is a stop-out on that bar", () => {
  const { events } = run([[1.1006, 1.1007, 1.0990, 1.0992], [1.0992, 1.1025, 1.0991, 1.1015]]);
  const close = events.find((e) => e.type === "closed" && e.arm === "L") as Extract<BreakerEvent, { type: "closed" }>;
  assertEquals([close.result, close.gross, close.t], ["SL", -1, T0 + 2 * M5]);
});

Deno.test("confirmation arm: touched, then price reaches the stop before any confirmation → cancelled (stop before entry)", () => {
  const { events } = run([[1.1006, 1.1007, 1.0990, 1.0992], [1.0992, 1.1001, 1.0991, 1.0999], [1.0999, 1.1021, 1.0998, 1.1004]]);
  assert(types(events).includes("touched:C"));
  const c = events.find((e) => e.type === "cancelled" && e.arm === "C") as Extract<BreakerEvent, { type: "cancelled" }>;
  assertEquals(c.reason, "stop_before_entry");
});

Deno.test("confirmation arm: a close back above the old zone after the touch → cancelled (flip failed)", () => {
  const { events } = run([[1.1006, 1.1007, 1.0990, 1.0992], [1.0992, 1.1001, 1.0991, 1.0999], [1.0999, 1.1015, 1.0998, 1.1012]]);
  const c = events.find((e) => e.type === "cancelled" && e.arm === "C") as Extract<BreakerEvent, { type: "cancelled" }>;
  assertEquals(c.reason, "flip_failed");
});

Deno.test("a flip with no return expires after 48 hours, for both arms", () => {
  const path: [number, number, number, number][] = [[1.1006, 1.1007, 1.0990, 1.0992]];
  for (let i = 0; i < 48 * 12 + 2; i++) path.push([1.0980, 1.0982, 1.0978, 1.0980]);
  const { events, state } = run(path);
  const c = events.filter((e) => e.type === "cancelled") as Extract<BreakerEvent, { type: "cancelled" }>[];
  assertEquals(c.map((e) => [e.arm, e.reason]), [["C", "expired"], ["L", "expired"]]);
  assert(c[0].t > T0 + M5 + FLIP_VALID_MS - M5 && c[0].t <= T0 + M5 + FLIP_VALID_MS + M5);
  assertEquals(state.zones.length, 0);
});

Deno.test("one position per arm per pair: a second flip filling while the first is open is skipped", () => {
  const Z2 = { ...Z, id: zoneId("EUR/USD", "long", 1.0995, 1.1005, pip), zl: 1.0995, zh: 1.1005 };
  const { events } = run([[1.1006, 1.1007, 1.0990, 1.0992], [1.0992, 1.1001, 1.0991, 1.0999]], [Z, Z2]);
  const L = events.filter((e) => "arm" in e && e.arm === "L" && (e.type === "filled" || e.type === "skipped")).map((e) => `${e.type}:${e.zoneId === Z.id ? 1 : 2}`);
  assertEquals(L, ["filled:1", "skipped:2"]);
});

Deno.test("a zone the scanner keeps showing is tracked once; it is forgotten only after a week unseen", () => {
  let st = initBreakerState(T0);
  st = addZones(st, [Z], T0).state;
  const again = addZones(st, [{ ...Z, seenT: T0 + 3600_000 }], T0 + 3600_000);
  assertEquals(again.events.length, 0);
  st = advanceBars(again.state, bars([[1.1006, 1.1007, 1.0990, 1.0992]]), P, T0 + M5).state;   // flipped
  st.zones = [];                                                                            // pretend it finished
  assertEquals(addZones(st, [{ ...Z, seenT: T0 + 2 * 3600_000 }], T0 + 2 * 3600_000).events.length, 0, "finished, still remembered");
  const later = addZones(st, [], T0 + 3600_000 + FORGET_AFTER_MS + 3600_000).state;
  assert(!(Z.id in later.known), "a week unseen and not tracked: forgotten");
});

Deno.test("a zone first seen ALREADY broken does not flip on its first bar; it flips only after price is back and closes through again", () => {
  const stale = { ...Z, intact: false };
  const below: [number, number, number, number][] = [[1.0990, 1.0992, 1.0985, 1.0988], [1.0988, 1.0990, 1.0984, 1.0987]];
  assertEquals(types(run(below, [stale]).events), ["seen"], "price already beyond the zone: no flip (2026-11-03 USD/JPY false flip)");
  const back: [number, number, number, number][] = [...below, [1.0987, 1.1004, 1.0986, 1.1003], [1.1003, 1.1004, 1.0990, 1.0993]];
  const f = run(back, [stale]).events.find((e) => e.type === "flipped") as Extract<BreakerEvent, { type: "flipped" }>;
  assertEquals(f.t, T0 + 4 * M5, "back inside, then a close through: a real break");
});
