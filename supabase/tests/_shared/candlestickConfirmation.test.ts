import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateCandlestickConfirmation } from "../../functions/_shared/candlestickConfirmation.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const c = (open: number, high: number, low: number, close: number): Candle => ({
  open, high, low, close, volume: 100, datetime: "2026-08-03T12:00:00Z",
});

Deno.test("unified strong engulfing authorizes with displacement", () => {
  const result = evaluateCandlestickConfirmation({
    candles: [c(1.11, 1.112, 1.099, 1.10), c(1.099, 1.114, 1.098, 1.113)],
    candleIndex: 1, direction: "long", profile: "unified",
    minimumDisplacement: 0.4, hasSweep: false,
  });
  assertEquals(result.pattern, "Bullish Engulfing");
  assertEquals(result.strength, "strong");
  assertEquals(result.authorized, true);
});

Deno.test("standalone engulfing requires sweep", () => {
  const candles = [c(1.11, 1.112, 1.099, 1.10), c(1.099, 1.114, 1.098, 1.113)];
  assertEquals(evaluateCandlestickConfirmation({
    candles, candleIndex: 1, direction: "long", profile: "standalone",
    minimumDisplacement: 0.4, hasSweep: false,
  }).authorized, false);
  assertEquals(evaluateCandlestickConfirmation({
    candles, candleIndex: 1, direction: "long", profile: "standalone",
    minimumDisplacement: 0.4, hasSweep: true,
  }).authorized, true);
});

Deno.test("doji follow-through never confirms without sweep", () => {
  const result = evaluateCandlestickConfirmation({
    candles: [c(1.10, 1.11, 1.09, 1.1001), c(1.1002, 1.12, 1.10, 1.118)],
    candleIndex: 1, direction: "long", profile: "unified",
    minimumDisplacement: 0.4, hasSweep: false,
  });
  assertEquals(result.pattern, "Doji + Bullish Follow-Through");
  assertEquals(result.strength, "weak");
  assertEquals(result.authorized, false);
});

Deno.test("hammer is moderate evidence and requires a sweep", () => {
  const candles = [
    c(1.105, 1.106, 1.103, 1.104),
    c(1.104, 1.1045, 1.095, 1.1043),
  ];
  const waiting = evaluateCandlestickConfirmation({
    candles, candleIndex: 1, direction: "long", profile: "unified",
    minimumDisplacement: 0.4, hasSweep: false,
  });
  assertEquals(waiting.pattern, "Bullish Pin Bar (Hammer)");
  assertEquals(waiting.strength, "moderate");
  assertEquals(waiting.authorized, false);
  assertEquals(evaluateCandlestickConfirmation({
    candles, candleIndex: 1, direction: "long", profile: "unified",
    minimumDisplacement: 0.4, hasSweep: true,
  }).authorized, true);
});

Deno.test("opposing pattern cannot confirm entry", () => {
  const result = evaluateCandlestickConfirmation({
    candles: [c(1.10, 1.112, 1.099, 1.11), c(1.111, 1.112, 1.095, 1.096)],
    candleIndex: 1, direction: "long", profile: "unified",
    minimumDisplacement: 0.4, hasSweep: true,
  });
  assertEquals(result.direction, "short");
  assertEquals(result.authorized, false);
});
