/**
 * Scalper15 — the shared strategy module (bot-scanner and the backtest both call it).
 * The bot-scanner wiring is pinned in scalper15Wiring.test.ts.
 */
import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";
import {
  biasNow, buildBiasStates, closedBars, isScalper15Order, planScalper15, plannedR, resolveScalper15, S15_DEPTH,
  SCALPER15_DEFAULTS, scalper15Stop,
} from "../../functions/_shared/scalper15.ts";
import { shadowRoute2Geometry } from "../../functions/_shared/shadowZoneMid.ts";

const H = 3_600_000;
const T0 = Date.UTC(2026, 3, 1);
const bars = (rows: Array<[number, number, number, number]>, stepMs = H): Candle[] =>
  rows.map(([open, high, low, close], i) => ({ datetime: new Date(T0 + i * stepMs).toISOString(), open, high, low, close }));

/** Swing high 12 at bar 2, confirmed at bar 4; bar 5 closes above it. */
const BREAK_UP: Array<[number, number, number, number]> = [
  [10, 10.5, 9.5, 10], [10, 11, 9.8, 10.5], [10.5, 12, 10.2, 11],
  [11, 11.5, 10.5, 11], [11, 11.4, 10.6, 11],
  [11, 12.5, 10.9, 12.2],
  [12.2, 13, 12, 12.8],
];

Deno.test("settings: off unless explicitly true; numbers clamped; absent → owner-spec defaults", () => {
  assertEquals(resolveScalper15(null), SCALPER15_DEFAULTS);
  assertEquals(resolveScalper15({ strategy: { scalper15Enabled: "true" } }).enabled, false);
  assertEquals(resolveScalper15({ strategy: { scalper15Enabled: true } }).enabled, true);
  const s = resolveScalper15({ strategy: { scalper15MinPlannedR: 99, scalper15StopBufferPips: -3, scalper15MinStopPips: "x" } });
  assertEquals(s.minPlannedR, 10);
  assertEquals(s.stopBufferPips, 0);
  assertEquals(s.minStopPips, 0);
});

Deno.test("order tag: S15- prefix only", () => {
  assert(isScalper15Order({ entry_zone_type: "S15-OB" }));
  assert(!isScalper15Order({ entry_zone_type: "VA-OB" }));
  assert(!isScalper15Order({ entry_zone_type: "S15OB" }));
  assert(!isScalper15Order({ entry_zone_type: null }));
});

Deno.test("closedBars drops the forming bar only", () => {
  const b = bars([[1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]]);
  assertEquals(closedBars(b, "1h", T0 + 3 * H).length, 3);
  assertEquals(closedBars(b, "1h", T0 + 3 * H - 1).length, 2);
  assertEquals(closedBars(b, "1h", T0 + 59 * 60_000).length, 0);
});

Deno.test("1H bias: swing confirmed two bars later; a close above it turns long; leg high tracks", () => {
  const s = buildBiasStates(bars(BREAK_UP));
  assertEquals(s[4].bias, 0);
  assertEquals(s[5].bias, 1);
  assertEquals(s[5].legHigh, 12.5);
  assertEquals(s[6].legHigh, 13);
});

Deno.test("1H bias: a wick above the swing without a close above it does not flip", () => {
  const rows = BREAK_UP.slice(0, 5).concat([[11, 12.6, 10.9, 11.9]]);
  assertEquals(buildBiasStates(bars(rows)).at(-1)!.bias, 0);
});

Deno.test("1H bias: shorts mirror", () => {
  const s = buildBiasStates(bars([
    [10, 10.5, 9.5, 10], [10, 10.2, 9, 9.5], [9.5, 9.8, 8, 9],
    [9, 9.5, 8.5, 9], [9, 9.4, 8.6, 9],
    [9, 9.1, 7.5, 7.8],
  ]));
  assertEquals(s.at(-1)!.bias, -1);
  assertEquals(s.at(-1)!.legLow, 7.5);
});

Deno.test("biasNow reads only the live window (the last S15_DEPTH.h1 bars)", () => {
  // The break happens early; S15_DEPTH.h1 quiet bars later, it has scrolled out of the window.
  const quiet: Array<[number, number, number, number]> = Array.from({ length: S15_DEPTH.h1 }, () => [12.5, 12.6, 12.4, 12.5]);
  assertEquals(biasNow(bars(BREAK_UP.concat(quiet.slice(0, 10)))).bias, 1);
  assertEquals(biasNow(bars(BREAK_UP.concat(quiet))).bias, 0);
});

Deno.test("planned R: from the entry, −Infinity when the stop is on the wrong side", () => {
  assertAlmostEquals(plannedR(1, 1.1, 1.099, 1.102), 2);
  assertAlmostEquals(plannedR(-1, 1.1, 1.101, 1.097), 3);
  assertEquals(plannedR(1, 1.0985, 1.099, 1.102), -Infinity);
});

Deno.test("stop: buffer beyond the far edge; the optional floor widens from the entry", () => {
  const zone = { low: 1.1000, high: 1.1004 };
  const pip = 0.0001;
  assertAlmostEquals(scalper15Stop(1, zone, 1.1002, pip, SCALPER15_DEFAULTS), 1.0999);
  assertAlmostEquals(scalper15Stop(-1, zone, 1.1002, pip, SCALPER15_DEFAULTS), 1.1005);
  assertAlmostEquals(scalper15Stop(1, zone, 1.1002, pip, { ...SCALPER15_DEFAULTS, minStopPips: 10 }), 1.0992);
  // a floor already satisfied changes nothing
  assertAlmostEquals(scalper15Stop(1, zone, 1.1002, pip, { ...SCALPER15_DEFAULTS, minStopPips: 2 }), 1.0999);
});

Deno.test("plan: no 1H direction → no order, and the reason says so", () => {
  const flat = bars(Array.from({ length: 30 }, () => [1, 1.0001, 0.9999, 1] as [number, number, number, number]));
  const p = planScalper15({ h1: flat, m15: flat, m5: flat, lastPrice: 1, pipSize: 0.0001, settings: { ...SCALPER15_DEFAULTS, enabled: true } });
  assert(!p.ok);
  assert(p.reason.startsWith("no 1H direction"));
});

// The placement feeds Route 2's own geometry (shadowRoute2Geometry: distance guard, R:R gate, sizing) the Scalper15 stop as
// the only candidate and tpRatio = planned R. bot-scanner refuses the order if the result is off the plan; pin that it is not.
Deno.test("placement geometry: Route 2 reproduces the Scalper15 stop and 1H target exactly (long and short, with and without a floor)", () => {
  const pip = 0.0001;
  const cases: Array<{ dir: 1 | -1; zone: { low: number; high: number }; target: number; minStop: number }> = [
    { dir: 1, zone: { low: 1.1000, high: 1.1006 }, target: 1.1040, minStop: 0 },
    { dir: -1, zone: { low: 1.1000, high: 1.1006 }, target: 1.0960, minStop: 0 },
    { dir: 1, zone: { low: 1.1000, high: 1.1006 }, target: 1.1060, minStop: 10 },
  ];
  for (const c of cases) {
    const settings = { ...SCALPER15_DEFAULTS, enabled: true, minStopPips: c.minStop };
    const limit = (c.zone.low + c.zone.high) / 2;
    const stop = scalper15Stop(c.dir, c.zone, limit, pip, settings);
    const pr = plannedR(c.dir, limit, stop, c.target);
    const g = shadowRoute2Geometry({
      direction: c.dir === 1 ? "long" : "short", limit, lastPrice: limit + c.dir * 0.0008, h1Atr: 0.0015,
      marketSL: stop, tpRatio: pr, stopAnchor: "limit", swingSL: stop, impulseSL: null, impulseCapPips: null, minSlPips: 1e-6,
      pipSize: pip, symbol: "EUR/USD", rateMap: {}, commissionPerLot: 0, orderRRMin: 1, rrGateMode: "legacy", sizingMode: "fill_time",
      balance: 100000, riskPercent: 0.5, maxLotsPerTrade: 20, legacyLots: () => 1, halveLegacy: false,
    });
    assert(g.ok, JSON.stringify(g));
    if (!g.ok) continue;
    assertAlmostEquals(g.stop, stop, pip * 0.01);
    assertAlmostEquals(g.target, c.target, pip * 0.01);
    assert(g.size > 0);
  }
});

Deno.test("placement: S15 orders carry the 15m zone as their refined zone, so the hunt accepts every confirmation tier", async () => {
  // Without a refined zone bot-scanner's hunt keeps only Tier 1 (`!hasRefZone && tier !== 1` → rejected): the rejection-wick,
  // engulfing and wick-CHoCH confirmations Scalper15 is specified and backtested with would be thrown away.
  const src = await Deno.readTextFile(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
  const at = src.indexOf("const s15Row: Record<string, unknown> = {");
  assert(at > 0);
  const row = src.slice(at, src.indexOf("config_hash: s15Cfg,", at));
  assert(row.includes("refined_zone_low: s15Plan.zone.low, refined_zone_high: s15Plan.zone.high"));
  assert(src.includes("const hasRefZone = rawRefLow > 0 && rawRefHigh > 0;"), "the hunt still keys the tier rule on the refined zone");
});
