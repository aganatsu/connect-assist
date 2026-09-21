import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  simulate, metrics, ENTRY_MODELS, STOP_MODELS, TARGET_MODELS,
  type Setup, type Costs,
} from "../../functions/_shared/ipoRawBacktest.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime: `2021-01-01T${String(i).padStart(2, "0")}:00`, open: o, high: h, low: l, close: c, volume: 0 } as Candle);

const FREE: Costs = { perSide: 0, label: "none" };

/** Demand zone 100..110, extreme 90. Entry 110 (E1) or 100 (E2). */
const demandSetup = (touchIndex: number): Setup => ({
  ipoIndex: 0, direction: "demand", zoneLow: 100, zoneHigh: 110, extreme: 90,
  touchIndex, touchNumber: 1, hasFvg: false, afterContraction: false, structuralTarget: null,
});

Deno.test("E1 risk is the full candle range, E2 risk is half — R units are not comparable", () => {
  const s = [bar(0, 0, 0, 0, 0), bar(1, 111, 112, 95, 111)];
  const a = simulate(s, demandSetup(1), "E1_ZONE_TOUCH", "S1_HARD_EXTREME", "T_1R", FREE);
  const b = simulate(s, demandSetup(1), "E2_50_PERCENT", "S1_HARD_EXTREME", "T_1R", FREE);
  assertEquals(a.entry, 110);
  assertEquals(b.entry, 100);
  assertEquals(a.risk, 20);
  assertEquals(b.risk, 10);
});

Deno.test("E2 declines a setup whose bar never reaches the 50% level", () => {
  const s = [bar(0, 0, 0, 0, 0), bar(1, 112, 113, 105, 112)];   // dips to 105, not 100
  const r = simulate(s, demandSetup(1), "E2_50_PERCENT", "S1_HARD_EXTREME", "T_2R", FREE);
  assertEquals(r.outcome, "NO_ENTRY");
  const e1 = simulate(s, demandSetup(1), "E1_ZONE_TOUCH", "S1_HARD_EXTREME", "T_2R", FREE);
  assertEquals(e1.outcome, "OPEN", "E1 entered at 110; neither level was reached, so it is open — not declined");
});

Deno.test("AMBIGUOUS_INTRABAR resolves as a LOSS and never silently as a win", () => {
  // One bar reaching both the 1R target (130) and the stop (90).
  const s = [bar(0, 0, 0, 0, 0), bar(1, 110, 135, 89, 110)];
  const r = simulate(s, demandSetup(1), "E1_ZONE_TOUCH", "S1_HARD_EXTREME", "T_1R", FREE);
  assert(r.ambiguous, "the bar spans both levels, so it must be flagged");
  assertEquals(r.outcome, "LOSS");
  assertEquals(r.grossR, -1, "conservative treatment is stop-first");
  assertEquals(r.optimisticR, 1, "the optimistic figure is reported beside it, not instead of it");
});

Deno.test("S2 survives a wick beyond the extreme; only a CLOSE beyond ends it", () => {
  const s = [
    bar(0, 0, 0, 0, 0),
    bar(1, 110, 111, 85, 108),   // wicks to 85, well under the 90 extreme, closes above
    bar(2, 108, 155, 108, 150),  // reaches the 2R target at 150
  ];
  const hard = simulate(s, demandSetup(1), "E1_ZONE_TOUCH", "S1_HARD_EXTREME", "T_2R", FREE);
  assertEquals(hard.outcome, "LOSS", "S1 is stopped by the wick");
  assertEquals(hard.exitIndex, 1);

  const soft = simulate(s, demandSetup(1), "E1_ZONE_TOUCH", "S2_CLOSE_INVALIDATION", "T_2R", FREE);
  assertEquals(soft.outcome, "WIN", "S2 ignores the wick and reaches the target");
  assertEquals(soft.exitIndex, 2);
});

Deno.test("S2 reports realized R from the close, so a gap loses more than 1R", () => {
  const s = [bar(0, 0, 0, 0, 0), bar(1, 110, 111, 70, 70)];   // closes at 70, extreme is 90
  const r = simulate(s, demandSetup(1), "E1_ZONE_TOUCH", "S2_CLOSE_INVALIDATION", "T_2R", FREE);
  assertEquals(r.exitPrice, 70);
  assertEquals(r.grossR, -2, "entry 110, exit 70, risk 20 → −2R, not a capped −1R");
});

Deno.test("cost is charged in price terms, so a tighter stop is penalised harder", () => {
  const s = [bar(0, 0, 0, 0, 0), bar(1, 100, 135, 99, 130)];
  const c: Costs = { perSide: 1, label: "1 price unit" };
  const wide = simulate(s, demandSetup(1), "E1_ZONE_TOUCH", "S1_HARD_EXTREME", "T_1R", c);   // risk 20
  const tight = simulate(s, demandSetup(1), "E2_50_PERCENT", "S1_HARD_EXTREME", "T_1R", c);  // risk 10
  const drag = (x: typeof wide) => Math.round((x.grossR! - x.netR!) * 1e9) / 1e9;
  assertEquals(drag(wide), 0.1);
  assertEquals(drag(tight), 0.2);
  assert(tight.grossR! - tight.netR! > wide.grossR! - wide.netR!);
});

Deno.test("a structural target behind the entry is refused rather than booked as a win", () => {
  const s = [bar(0, 0, 0, 0, 0), bar(1, 110, 120, 95, 115)];
  const su = { ...demandSetup(1), structuralTarget: 105 };     // below the 110 entry
  const r = simulate(s, su, "E1_ZONE_TOUCH", "S1_HARD_EXTREME", "T_STRUCTURAL", FREE);
  assertEquals(r.outcome, "NO_ENTRY");
});

Deno.test("an unresolved trade stays OPEN and is excluded from expectancy", () => {
  const s = [bar(0, 0, 0, 0, 0), bar(1, 110, 111, 105, 108)];  // neither level reached
  const r = simulate(s, demandSetup(1), "E1_ZONE_TOUCH", "S1_HARD_EXTREME", "T_3R", FREE);
  assertEquals(r.outcome, "OPEN");
  assertEquals(metrics([r]).trades, 0, "OPEN trades must not dilute the expectancy denominator");
});

Deno.test("supply setups mirror demand exactly", () => {
  const su: Setup = {
    ipoIndex: 0, direction: "supply", zoneLow: 90, zoneHigh: 100, extreme: 110,
    touchIndex: 1, touchNumber: 1, hasFvg: false, afterContraction: false, structuralTarget: null,
  };
  const s = [bar(0, 0, 0, 0, 0), bar(1, 88, 95, 65, 70)];
  const r = simulate(s, su, "E1_ZONE_TOUCH", "S1_HARD_EXTREME", "T_1R", FREE);
  assertEquals(r.entry, 90, "a supply zone is met at its LOW when approached from below");
  assertEquals(r.risk, 20);
  assertEquals(r.outcome, "WIN", "the 1R target at 70 was reached");
});

Deno.test("the pre-registered model lists are exactly the specified ones", () => {
  assertEquals(ENTRY_MODELS, ["E1_ZONE_TOUCH", "E2_50_PERCENT"]);
  assertEquals(STOP_MODELS, ["S1_HARD_EXTREME", "S2_CLOSE_INVALIDATION"]);
  assertEquals(TARGET_MODELS, ["T_1R", "T_1_5R", "T_2R", "T_3R", "T_STRUCTURAL"]);
});

Deno.test("metrics track drawdown and losing streak over the realized sequence", () => {
  const mk = (v: number) => ({
    outcome: v > 0 ? "WIN" : "LOSS", grossR: v, netR: v, optimisticR: v, ambiguous: false,
  } as any);
  const m = metrics([mk(2), mk(-1), mk(-1), mk(-1), mk(1)]);
  assertEquals(m.trades, 5);
  assertEquals(m.longestLosingStreak, 3);
  assertEquals(m.maxDrawdownR, 3);
  assertEquals(m.totalR, 0);
  assertEquals(m.profitFactor, 1);
});
