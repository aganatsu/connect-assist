import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_ZONE_CONFIRMATION_CONFIG,
  detectZoneConfirmation,
} from "../../functions/_shared/zoneConfirmation.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const c = (open: number, high: number, low: number, close: number, i: number): Candle => ({
  open, high, low, close, volume: 100,
  datetime: new Date(Date.UTC(2026, 7, 3, 12, i * 5)).toISOString(),
});

function prefix(): Candle[] {
  return Array.from({ length: 9 }, (_, i) =>
    c(1.10 + i * 0.0001, 1.101 + i * 0.0001, 1.099 + i * 0.0001, 1.1002 + i * 0.0001, i));
}

const patternOnly = {
  ...DEFAULT_ZONE_CONFIRMATION_CONFIG,
  tier1Enabled: false,
  tier2Enabled: false,
  tier3Enabled: true,
  maxLookbackCandles: 5,
};

Deno.test("Confirmation Authority accepts a displaced Morning Star for unified route", () => {
  const candles = [
    ...prefix(),
    c(1.104, 1.1045, 1.1005, 1.101, 9),
    c(1.1008, 1.1013, 1.1000, 1.1010, 10),
    c(1.1011, 1.1042, 1.1009, 1.1035, 11),
  ];
  const signal = detectZoneConfirmation(
    candles, "long", patternOnly, 9, "EUR/USD",
    undefined, undefined, null, "unified",
  );
  assert(signal);
  assert(signal.supportingSignals.includes("pattern:Morning Star"));
  assertEquals(signal.authority?.level, "reversal_pattern");
});

Deno.test("standalone Morning Star waits for sweep evidence", () => {
  const candles = [
    ...prefix(),
    c(1.104, 1.1045, 1.1005, 1.101, 9),
    c(1.1008, 1.1013, 1.1000, 1.1010, 10),
    c(1.1011, 1.1042, 1.1009, 1.1035, 11),
  ];
  assertEquals(detectZoneConfirmation(
    candles, "long", patternOnly, 9, "EUR/USD",
    undefined, undefined, null, "standalone",
  ), null);
  const signal = detectZoneConfirmation(
    candles, "long", patternOnly, 9, "EUR/USD",
    undefined, undefined, { level: 1.1000, type: "sell-side" }, "standalone",
  );
  assert(signal);
  assert(signal.supportingSignals.includes("pattern:Morning Star"));
});

Deno.test("Confirmation Authority accepts a displaced Evening Star", () => {
  const candles = [
    ...prefix(),
    c(1.101, 1.1045, 1.1005, 1.104, 9),
    c(1.1041, 1.1050, 1.1038, 1.1042, 10),
    c(1.1040, 1.1042, 1.1004, 1.1010, 11),
  ];
  const signal = detectZoneConfirmation(
    candles, "short", patternOnly, 9, "EUR/USD",
    undefined, undefined, null, "cascade",
  );
  assert(signal);
  assert(signal.supportingSignals.includes("pattern:Evening Star"));
});
