/**
 * dropFormingBar.test.ts — closed-bar guarantee.
 *
 * Detectors must never read the in-progress bar: its high, low and close keep
 * moving until the period closes, so signals flicker within a bar and backtest
 * (which only ever sees closed bars) cannot reproduce live behaviour.
 *
 * This makes "does provider X return the forming bar?" irrelevant — if it does,
 * it is removed; if it does not, the trim is a no-op.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dropFormingBar } from "../../functions/_shared/candleSource.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/** Build 15m bars starting at `startMs`, one every 15 minutes. */
function bars(startMs: number, count: number, stepMs = 15 * 60_000): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    datetime: new Date(startMs + i * stepMs).toISOString(),
    open: 1.1, high: 1.1005, low: 1.0995, close: 1.1, volume: 100,
  }));
}

const T0 = Date.UTC(2026, 7, 10, 12, 0, 0); // 12:00 UTC

Deno.test("dropFormingBar — removes the in-progress bar", () => {
  // Bars at 12:00, 12:15, 12:30. Now is 12:40, so the 12:30 bar is still forming.
  const candles = bars(T0, 3);
  const now = Date.UTC(2026, 7, 10, 12, 40, 0);
  const out = dropFormingBar(candles, "15m", now);
  assertEquals(out.length, 2);
  assertEquals(out[out.length - 1].datetime, new Date(Date.UTC(2026, 7, 10, 12, 15)).toISOString());
});

Deno.test("dropFormingBar — keeps a bar that closed exactly on the boundary", () => {
  const candles = bars(T0, 3);
  // 12:30 bar closes at 12:45; now is exactly 12:45 so it is closed.
  const now = Date.UTC(2026, 7, 10, 12, 45, 0);
  assertEquals(dropFormingBar(candles, "15m", now).length, 3);
});

Deno.test("dropFormingBar — no-op when the provider already returns closed bars only", () => {
  const candles = bars(T0, 3);
  const now = Date.UTC(2026, 7, 10, 14, 0, 0);
  const out = dropFormingBar(candles, "15m", now);
  assertEquals(out.length, 3);
  assertEquals(out, candles); // same reference semantics — nothing copied
});

Deno.test("dropFormingBar — removes multiple trailing future bars", () => {
  const candles = bars(T0, 5);
  // Now is 12:20 — bars at 12:15, 12:30, 12:45, 13:00 are all unclosed.
  const now = Date.UTC(2026, 7, 10, 12, 20, 0);
  assertEquals(dropFormingBar(candles, "15m", now).length, 1);
});

Deno.test("dropFormingBar — accepts interval aliases", () => {
  const candles = bars(T0, 3);
  const now = Date.UTC(2026, 7, 10, 12, 40, 0);
  assertEquals(dropFormingBar(candles, "15min", now).length, 2);
  assertEquals(dropFormingBar(candles, "15m", now).length, 2);
});

Deno.test("dropFormingBar — daily bars", () => {
  const dayMs = 24 * 60 * 60_000;
  const d0 = Date.UTC(2026, 7, 8, 0, 0, 0);
  const candles = bars(d0, 3, dayMs); // Aug 8, 9, 10
  const now = Date.UTC(2026, 7, 10, 12, 0, 0); // midday Aug 10 — today's bar is forming
  const out = dropFormingBar(candles, "1d", now);
  assertEquals(out.length, 2);
  assertEquals(out[out.length - 1].datetime, new Date(Date.UTC(2026, 7, 9)).toISOString());
});

Deno.test("dropFormingBar — unknown interval leaves candles untouched", () => {
  const candles = bars(T0, 3);
  assertEquals(dropFormingBar(candles, "7s", Date.UTC(2026, 7, 10, 12, 40)).length, 3);
});

Deno.test("dropFormingBar — empty input is safe", () => {
  assertEquals(dropFormingBar([], "15m", Date.now()).length, 0);
});

Deno.test("dropFormingBar — unparseable timestamp stops the scan rather than dropping everything", () => {
  const candles = bars(T0, 3);
  candles[2] = { ...candles[2], datetime: "not-a-date" };
  const now = Date.UTC(2026, 7, 10, 12, 40, 0);
  // Bails at the bad bar instead of walking the whole array off.
  assertEquals(dropFormingBar(candles, "15m", now).length, 3);
});
