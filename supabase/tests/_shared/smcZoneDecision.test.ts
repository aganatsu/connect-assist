/**
 * Extracted SMC zone decision.
 *
 * WHAT THESE GUARD. The module exists because bot-scanner and backtest-engine
 * were two implementations of one strategy and drifted apart. The ways this
 * extraction could fail are: the module acquires a side effect, the slot
 * mapping stops matching production, or "not evaluated" gets conflated with
 * "evaluated, found nothing". Each is pinned here.
 *
 * Behavioural equality with production is NOT asserted here — it is proved by
 * local-runner/stage2h-parity.ts against 120 real captured scans, comparing the
 * module's output to what production actually recorded.
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  resolveZoneSlots, hasMinZoneCandles, buildHtfConfluence, decideZone,
  ZONE_DECISION_CONTRACT, type ZoneSeries,
} from "../../functions/_shared/smcZoneDecision.ts";
import { barMsOf } from "../../functions/_shared/smcScanSnapshot.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bars = (n: number, tag = 0): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    datetime: new Date(Date.UTC(2026, 0, 1) + i * 300_000).toISOString(),
    open: 1 + tag, high: 1.001 + tag, low: 0.999 + tag, close: 1.0005 + tag,
  })) as Candle[];

const series = (o: Partial<ZoneSeries> = {}): ZoneSeries => ({
  candles: bars(300, 0), m15Candles: bars(300, 1), hourlyCandles: bars(300, 2),
  h4Candles: bars(300, 3), dailyCandles: bars(300, 4), weeklyCandles: bars(300, 5),
  ...o,
});

// ─────────────────────────────────────────────────────────────────────────────
// the module must never acquire a side effect
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("the decision module is pure — no database, network, logging or clock", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/smcZoneDecision.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  for (const banned of [
    "createClient", "supabase-js", "fetch(", "Deno.env", ".from(",
    "Date.now(", "console.log", "console.warn", "console.error",
  ]) {
    assert(!code.includes(banned), `the decision module reaches ${banned}`);
  }
});

Deno.test("bot-scanner calls the module rather than keeping its own copy", async () => {
  const src = await Deno.readTextFile("supabase/functions/bot-scanner/index.ts");
  assert(src.includes("decideZone({"), "bot-scanner no longer calls the shared decision");
  // The lifted logic must not survive inline, or the two can drift again —
  // which is exactly how backtest-engine ended up on a superseded engine.
  assertEquals((src.match(/findUnifiedZone\(/g) ?? []).length, 0,
    "findUnifiedZone is called inline in bot-scanner; it belongs to the shared module");
  assert(!/zoneTFLabels = \{ top: "1H"/.test(src),
    "the slot mapping is still duplicated in bot-scanner");
});

// ─────────────────────────────────────────────────────────────────────────────
// slot mapping — positional, not timeframe-named
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("scalper maps 5m into the slot called h1 and 1H into the one called daily", () => {
  // The slot names are POSITIONAL. Reading them as timeframes inverts the
  // waterfall, which is the mistake the Stage 2G replay had to be corrected for.
  const s = series();
  const z = resolveZoneSlots("scalper", s);
  assertEquals(z.h1, s.candles, "arg1 must be the LOWEST structural series (5m)");
  assertEquals(z.h4, s.m15Candles);
  assertEquals(z.entry, s.candles);
  assertEquals(z.daily, s.hourlyCandles, "arg9 must be the HIGHEST structural series (1H)");
  assertEquals(z.labels, { top: "1H", mid: "15m", low: "5m" });
});

Deno.test("day_trader and swing_trader keep their own mappings", () => {
  const s = series();
  const d = resolveZoneSlots("day_trader", s);
  assertEquals(d.h1, s.hourlyCandles);
  assertEquals(d.h4, s.h4Candles);
  assertEquals(d.daily, s.dailyCandles);
  assertEquals(d.labels, { top: "D", mid: "4H", low: "1H" });

  const w = resolveZoneSlots("swing_trader", s);
  assertEquals(w.h1, s.h4Candles);
  assertEquals(w.h4, s.dailyCandles);
  assertEquals(w.daily, s.weeklyCandles);
  assertEquals(w.labels, { top: "W", mid: "D", low: "4H" });
});

Deno.test("a too-short highest slot is withheld, not passed as an empty array", () => {
  // Production passes `undefined` when the series is short. An empty array is a
  // different input to the engine.
  const z = resolveZoneSlots("scalper", series({ hourlyCandles: bars(19, 2) }));
  assertEquals(z.daily, undefined);
  const d = resolveZoneSlots("day_trader", series({ dailyCandles: bars(29, 4) }));
  assertEquals(d.daily, undefined);
});

Deno.test("confirm falls back when the mid series is short, and the interval follows", () => {
  const s = series({ m15Candles: bars(14, 1) });
  const z = resolveZoneSlots("scalper", s);
  assertEquals(z.confirm, s.candles, "scalper confirm falls back to 5m below 15 bars");
  assertEquals(z.intervals.confirm, "5m", "the recorded interval must follow the fallback");
  const ok = resolveZoneSlots("scalper", series({ m15Candles: bars(15, 1) }));
  assertEquals(ok.intervals.confirm, "15m");
});

Deno.test("every slot interval is a real interval, never a slot name", () => {
  for (const style of ["scalper", "day_trader", "swing_trader"] as const) {
    const z = resolveZoneSlots(style, series());
    for (const [slot, tf] of Object.entries(z.intervals)) {
      assert(barMsOf(tf) !== null, `${style}.${slot} = "${tf}" is not an interval`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// not-evaluated is not the same as found-nothing
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("the candle minimum is per style, against that style's own series", () => {
  assertEquals(hasMinZoneCandles("scalper", series({ candles: bars(19) })), false);
  assertEquals(hasMinZoneCandles("scalper", series({ candles: bars(20) })), true);
  // A scalper with plenty of 5m does not care that 1H is short, and vice versa.
  assertEquals(hasMinZoneCandles("day_trader", series({ candles: bars(19), hourlyCandles: bars(20) })), true);
  assertEquals(hasMinZoneCandles("swing_trader", series({ h4Candles: bars(19) })), false);
});

Deno.test("no direction means not evaluated, not an empty zone", () => {
  const r = decideZone({
    symbol: "EUR/USD", style: "scalper", series: series(), direction: null,
    lastPrice: 1.1, htfConfluence: null, liquidityPools: [],
    minSlPips: 10, maxSlPips: 80, tpRatio: 2, entryDepth: 1, pipSize: 0.0001,
    strictATRMult: undefined, fibMaxRetracement: undefined, originOBRetest: undefined,
    impulseZoneEnabled: true,
  });
  assertEquals(r.evaluated, false);
  assertEquals(r.unifiedZone, null, "a non-evaluation must not look like a scored result");
  assertEquals(r.impulseZone, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// HTF confluence assembly
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("absent direction yields a null bundle, not an empty one", () => {
  // Stage 2E: omitting the bundle moved AUD/USD agreement 84.9% → 37.3%. The
  // engine distinguishes absent from present-but-empty.
  assertEquals(buildHtfConfluence({
    direction: null, h4OBs: [], h4FVGs: [], h4Breakers: [],
    htfFibLevels4H: null, htfFibLevelsD: null, htfPD4H: null,
  }), null);
  const b = buildHtfConfluence({
    direction: "short", h4OBs: null, h4FVGs: null, h4Breakers: null,
    htfFibLevels4H: null, htfFibLevelsD: null, htfPD4H: null,
  });
  assert(b !== null);
  assertEquals(b!.direction, "bearish");
  assertEquals(b!.h4OBs, [], "null sub-arrays become empty, matching production");
});

Deno.test("the contract label is declared once and matches the snapshot's", () => {
  assertEquals(ZONE_DECISION_CONTRACT, "smc-zone-impulse-control-v1");
});
