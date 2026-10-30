import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { loadThesisCandles, thesisValidationOpts } from "./thesisInputs.ts";
import type { Candle } from "./smcAnalysis.ts";

const bars = (n: number, tag: string): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ datetime: `${tag}-${i}`, open: 1, high: 1, low: 1, close: 1 }) as unknown as Candle);

function stub() {
  const calls: string[] = [];
  const fetch = (sym: string, interval: string, range: string, reason: string) => {
    calls.push(`${sym}|${interval}|${range}|${reason}`);
    return Promise.resolve(bars(interval === "4h" ? 400 : 60, interval));
  };
  return { calls, fetch };
}

Deno.test("loadThesisCandles: the exact fetches the cancel check has always made", async () => {
  const s = stub();
  const c = await loadThesisCandles(s.fetch, "EUR/USD", { style: "scalper", wantStyleCandles: false, confirmCandles: null, h4Window: 300 });
  assertEquals(s.calls, ["EUR/USD|1d|1y|pending_thesis_htf", "EUR/USD|4h|1mo|pending_thesis_htf", "EUR/USD|1h|5d|pending_thesis_htf"]);
  assertEquals(c.h4.length, 300);                         // sliced to the legacy window
  assertEquals(c.styleCandles, null);
});

Deno.test("loadThesisCandles: style candles per style", async () => {
  const confirm = bars(60, "5m");
  let s = stub();
  let c = await loadThesisCandles(s.fetch, "EUR/USD", { style: "scalper", wantStyleCandles: true, confirmCandles: confirm, h4Window: 300 });
  assertEquals(s.calls[3], "EUR/USD|15m|5d|pending_thesis_m15");
  assertEquals(c.styleCandles!.bias, c.h1); assertEquals(c.styleCandles!.confirm, confirm);
  s = stub();
  c = await loadThesisCandles(s.fetch, "EUR/USD", { style: "swing_trader", wantStyleCandles: true, confirmCandles: null, h4Window: 300 });
  assertEquals(s.calls[3], "EUR/USD|1w|2y|pending_thesis_weekly");
  assertEquals(c.styleCandles!.structure, c.daily); assertEquals(c.styleCandles!.confirm, c.h4);
  s = stub();
  c = await loadThesisCandles(s.fetch, "EUR/USD", { style: "day_trader", wantStyleCandles: true, confirmCandles: null, h4Window: 300 });
  assertEquals(s.calls.length, 3);
  assertEquals(c.styleCandles!.bias, c.daily); assertEquals(c.styleCandles!.confirm, c.h1);
});

Deno.test("thesisValidationOpts: defaults and switches mirror the config", () => {
  const c = { daily: bars(60, "d"), h4: bars(10, "h4"), h1: bars(60, "h1"), styleCandles: null };
  const o = thesisValidationOpts({}, c, { fotsiResult: null, lastGamePlan: null, style: "scalper" });
  assertEquals(o.dailyCandles?.length, 60);
  assertEquals(o.h4Candles, null);                        // fewer than 20 bars → withheld (fail-open)
  assertEquals(o.enabledChecks, { direction_flip: true, fotsi_veto: true, gp_bias_reversal: true });
  assertEquals(o.gamePlanGateMode, "soft");
  assertEquals(o.styleAwareDirection, false);
  assertEquals(o.dirConfig, { structureLookback: undefined, priceAwareStructureBlocks: false });
  const o2 = thesisValidationOpts({ thesisCheckDirectionFlip: false, gamePlanGateMode: "hard", thesisDirectionStyleAware: true, structureLookback: 5, priceAwareStructureBlocks: true }, c, { fotsiResult: null, lastGamePlan: null, style: "scalper" });
  assertEquals(o2.enabledChecks!.direction_flip, false);
  assertEquals(o2.gamePlanGateMode, "hard");
  assertEquals(o2.styleAwareDirection, true);
  assertEquals(o2.dirConfig, { structureLookback: 5, priceAwareStructureBlocks: true });
});
