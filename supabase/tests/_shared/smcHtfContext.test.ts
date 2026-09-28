/**
 * Extracted HTF context assembly.
 *
 * Behavioural equality is proved by local-runner/stage2h-parity.ts against 152
 * real captured scans, comparing to the bundle production actually passed to
 * the engine. These pin the asymmetries that a future tidy-up would "fix" and
 * silently change which POIs exist.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildHtfContext, resolveStructureSeries, liquidityToleranceBase,
  calculatePremiumDiscountAsProduction,
} from "../../functions/_shared/smcHtfContext.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bars = (n: number, f = (i: number) => i): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    datetime: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
    open: 1 + f(i) / 1e4, high: 1.001 + f(i) / 1e4,
    low: 0.999 + f(i) / 1e4, close: 1.0005 + f(i) / 1e4,
  })) as Candle[];

Deno.test("the module is pure — no database, network, logging or clock", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/smcHtfContext.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  for (const b of ["createClient","supabase-js","fetch(","Deno.env",".from(","Date.now(","console."]) {
    assert(!code.includes(b), `HTF context module reaches ${b}`);
  }
});

Deno.test("the liquidity tolerance ladder and its per-timeframe bumps", () => {
  // Guessing these is what broke the first Stage 2G replay.
  assertEquals(liquidityToleranceBase(1), 0.10);
  assertEquals(liquidityToleranceBase(3), 0.20);
  assertEquals(liquidityToleranceBase(5), 0.30);
  assertEquals(liquidityToleranceBase(undefined), 0.20, "default sensitivity is 3");
  assertEquals(liquidityToleranceBase(99), 0.30, "clamped, not indexed out of range");
  const src = Deno.readTextFileSync("supabase/functions/_shared/smcHtfContext.ts");
  assert(src.includes("Math.min(liqTolBase + 0.10, 0.40)"), "Daily bump +0.10 cap 0.40");
  assert(src.includes("Math.min(liqTolBase + 0.05, 0.35)"), "4H bump +0.05 cap 0.35");
  assert(/detectLiquidityPools\(hourlyCandles, liqTolBase,/.test(src), "1H takes the base, no bump");
});

Deno.test("Daily uses a lower bar minimum and a lower quality threshold", () => {
  // Daily has fewer structure breaks, so 10 bars and quality >= 2 vs 20 and >= 3.
  const src = Deno.readTextFileSync("supabase/functions/_shared/smcHtfContext.ts");
  assert(/collectPOIs\("D", dFVGs, dOBs, dBreakers, 2\)/.test(src), "Daily qualifies at >= 2");
  assert(/collectPOIs\("4H", h4FVGs, h4OBs, h4Breakers, 3\)/.test(src), "4H at >= 3");
  assert(/collectPOIs\("1H", fvgs, obs, brk, 3\)/.test(src), "1H at >= 3");
  assert(/dailyCandles\.length >= 10/.test(src) && /h4Candles\.length >= 20/.test(src));
});

Deno.test("structure series follows STYLE_TF_LABELS, per style", () => {
  const s = { m15Candles: bars(300), h4Candles: bars(300), dailyCandles: bars(300) };
  assertEquals(resolveStructureSeries("scalper", s), s.m15Candles);
  assertEquals(resolveStructureSeries("day_trader", s), s.h4Candles);
  assertEquals(resolveStructureSeries("swing_trader", s), s.dailyCandles);
  // Too short means null, not a short array.
  assertEquals(resolveStructureSeries("scalper", { ...s, m15Candles: bars(19) }), null);
});

Deno.test("empty POIs become null, because the scorer distinguishes them", () => {
  const r = buildHtfContext({
    style: "scalper", m15Candles: [], hourlyCandles: [], h4Candles: [], dailyCandles: [],
    equalHighsLowsSensitivity: 3, liquidityPoolMinTouches: 2,
  });
  assertEquals(r.htfPOIs, null, "production injects null, not []");
  assertEquals(r.combinedLiquidityPools, []);
});

Deno.test("premium/discount reproduces the UNFIXED production behaviour", () => {
  // bot-scanner carries a local calculatePremiumDiscount that shadows the
  // shared one, so the 2026-09-03 clamping fix has never been live. Measured:
  // zero of 152 captured bundles contain rawPercent, and one records
  // zonePercent = 166.67 — impossible under the fixed version.
  // If this test ever fails, production behaviour changed; that is a decision,
  // not a bug fix.
  const rising = bars(60, (i) => i * 3);
  const pd = calculatePremiumDiscountAsProduction(rising);
  assert(!("rawPercent" in pd), "the production variant must not expose rawPercent");
  assert(!("outOfRange" in pd), "nor outOfRange");
  assertEquals(Object.keys(pd).sort(), ["currentZone", "oteZone", "zonePercent"]);
  assertEquals(calculatePremiumDiscountAsProduction(bars(9)).zonePercent, 50, "under 10 bars is neutral");
});
