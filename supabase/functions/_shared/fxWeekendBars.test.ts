import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fxRealBars, weekendAllowance } from "./fxWeekendBars.ts";
import { isFxClosedAt } from "./sessions.ts";

const bar = (ms: number) => ({ datetime: new Date(ms).toISOString(), open: 1, high: 1, low: 1, close: 1, volume: 0 });
/** Every 5m bar from `fromMs`, `n` bars, weekends included (as TwelveData sends them). */
const series5m = (fromMs: number, n: number) => Array.from({ length: n }, (_, i) => bar(fromMs + i * 300_000));

// Monday 2026-11-16 02:00 UTC = Sunday 21:00 NY: the market reopened 4 h ago.
const MON_0200 = Date.parse("2026-11-16T02:00:00Z");

Deno.test("weekendAllowance covers one weekend for 300 5m bars, more for deeper series, none for daily", () => {
  assertEquals(weekendAllowance("5m", 300), 576);
  assertEquals(weekendAllowance("15m", 300), 192);
  assertEquals(weekendAllowance("1h", 300), 144);
  assertEquals(weekendAllowance("1d", 300), 0);
  assertEquals(weekendAllowance("1w", 52), 0);
});

Deno.test("Monday morning: 300 raw 5m bars are mostly weekend; the deep fetch still yields 300 real bars", () => {
  const extra = weekendAllowance("5m", 300);
  const deep = series5m(MON_0200 - (300 + extra - 1) * 300_000, 300 + extra);
  const raw = deep.slice(-300);
  const closedInRaw = raw.filter((b) => isFxClosedAt(Date.parse(b.datetime))).length;
  assertEquals(closedInRaw > 200, true);                     // the problem
  const real = fxRealBars("EUR/USD", raw, true, deep);
  assertEquals(real.length, 300);
  assertEquals(real.some((b) => isFxClosedAt(Date.parse(b.datetime))), false);
  assertEquals(real.at(-1)!.datetime, raw.at(-1)!.datetime);  // same latest bar
});

Deno.test("no deep fetch (or it ends on a different bar): drop from the bars given, shorter", () => {
  const raw = series5m(MON_0200 - 299 * 300_000, 300);
  const real = fxRealBars("EUR/USD", raw, true, null);
  assertEquals(real.length < 300, true);
  assertEquals(real.some((b) => isFxClosedAt(Date.parse(b.datetime))), false);
  const stale = series5m(MON_0200 - 1000 * 300_000, 900);    // ends earlier — ignored
  assertEquals(fxRealBars("EUR/USD", raw, true, stale).length, real.length);
});

Deno.test("disabled, crypto, or gold: bars unchanged", () => {
  const raw = series5m(MON_0200 - 299 * 300_000, 300);
  assertEquals(fxRealBars("EUR/USD", raw, false, null), raw);
  assertEquals(fxRealBars("BTC/USD", raw, true, null), raw);
  assertEquals(fxRealBars("XAU/USD", raw, true, null), raw);
});
