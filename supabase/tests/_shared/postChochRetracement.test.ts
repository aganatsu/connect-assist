import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  derivePostChochEntryPlan,
  evaluatePostChochRetracement,
} from "../../functions/_shared/postChochRetracement.ts";

const candle = (
  datetime: string,
  open: number,
  high: number,
  low: number,
  close: number,
) => ({ datetime, open, high, low, close, volume: 100 });

Deno.test("freezes the CHoCH displacement FVG before the micro OB", () => {
  const candles = [
    candle("2026-08-06T10:00:00Z", 1.1000, 1.1010, 1.0990, 1.0995),
    candle("2026-08-06T10:05:00Z", 1.0995, 1.1000, 1.0985, 1.0990),
    candle("2026-08-06T10:10:00Z", 1.1015, 1.1040, 1.1015, 1.1035),
  ];
  const plan = derivePostChochEntryPlan({
    candles, direction: "long", protectedLevel: 1.0985,
    candidateId: "zone-1", confirmationGeneration: 2,
    mode: "wait_retracement", createdAt: candles[2].datetime,
    expiryMinutes: 30,
    signal: {
      type: "bullish_choch", tier: 1, price: 1.1035, candleIndex: 2,
      displacement: 0.8, closeBased: true, supportingSignals: [],
    },
  });
  assert(plan);
  assertEquals(plan.zone.type, "fvg");
  assertEquals(plan.zone.low, 1.101);
  assertEquals(plan.zone.high, 1.1015);
  assertEquals(plan.confirmationGeneration, 2);
});

Deno.test("bullish micro OB ignores an opposing candle above the confirmation close", () => {
  const candles = [
    candle("2026-08-20T04:40:00Z", 68.02, 68.04, 67.95, 67.98),
    candle("2026-08-20T04:45:00Z", 67.98, 68.12, 67.97, 68.10),
    candle("2026-08-20T04:50:00Z", 68.34, 68.3422, 68.2967, 68.30),
    candle("2026-08-20T04:55:00Z", 68.00, 68.11, 67.99, 68.0953),
  ];
  const plan = derivePostChochEntryPlan({
    candles, direction: "long", protectedLevel: 67.8952,
    mode: "wait_retracement", createdAt: candles[3].datetime,
    expiryMinutes: 30,
    signal: {
      type: "bullish_choch", tier: 1, price: 68.0953, candleIndex: 3,
      displacement: 0.8, closeBased: true, supportingSignals: [],
    },
  });
  assert(plan);
  assertEquals(plan.zone.type, "micro_ob");
  assertEquals(plan.zone.low, 67.95);
  assertEquals(plan.zone.high, 68.04);
});

Deno.test("bearish micro OB ignores an opposing candle below the confirmation close", () => {
  const candles = [
    candle("2026-08-20T04:40:00Z", 31.98, 32.05, 31.96, 32.02),
    candle("2026-08-20T04:45:00Z", 32.02, 32.03, 31.88, 31.90),
    candle("2026-08-20T04:50:00Z", 31.71, 31.75, 31.70, 31.74),
    candle("2026-08-20T04:55:00Z", 31.98, 32.00, 31.88, 31.9047),
  ];
  const plan = derivePostChochEntryPlan({
    candles, direction: "short", protectedLevel: 32.10,
    mode: "wait_retracement", createdAt: candles[3].datetime,
    expiryMinutes: 30,
    signal: {
      type: "bearish_choch", tier: 1, price: 31.9047, candleIndex: 3,
      displacement: 0.8, closeBased: true, supportingSignals: [],
    },
  });
  assert(plan);
  assertEquals(plan.zone.type, "micro_ob");
  assertEquals(plan.zone.low, 31.96);
  assertEquals(plan.zone.high, 32.05);
});

Deno.test("an already-frozen wrong-side retracement plan is invalidated", () => {
  const plan: any = {
    contractVersion: "post-choch-retracement.v1",
    state: "awaiting_retracement", mode: "wait_retracement", direction: "long",
    candidateId: "xag-zone", confirmationGeneration: 1,
    confirmation: { price: 68.0953, candleTime: "2026-08-20T04:55:00Z" },
    zone: { type: "micro_ob", low: 68.2967, high: 68.3422, midpoint: 68.31945 },
    protectedLevel: 67.8952, createdAt: "2026-08-20T04:55:00Z",
    expiresAt: "2026-08-20T05:55:00Z", touchedAt: null, resolvedAt: null,
    reason: "waiting",
  };
  const result = evaluatePostChochRetracement(
    plan,
    candle("2026-08-20T05:00:00Z", 68.10, 68.15, 68.08, 68.12),
  );
  assertEquals(result.state, "invalidated");
  assert(result.reason.includes("wrong side"));
});

Deno.test("retracement touch readies the same frozen plan", () => {
  const plan = derivePostChochEntryPlan({
    candles: [
      candle("2026-08-06T10:00:00Z", 1.1, 1.101, 1.099, 1.0995),
      candle("2026-08-06T10:05:00Z", 1.0995, 1.1, 1.0985, 1.099),
      candle("2026-08-06T10:10:00Z", 1.1015, 1.104, 1.1015, 1.1035),
    ],
    direction: "long", protectedLevel: 1.0985, mode: "wait_retracement",
    createdAt: "2026-08-06T10:10:00Z", expiryMinutes: 30,
    signal: {
      type: "bullish_choch", tier: 1, price: 1.1035, candleIndex: 2,
      displacement: 0.8, closeBased: true, supportingSignals: [],
    },
  })!;
  const result = evaluatePostChochRetracement(
    plan,
    candle("2026-08-06T10:15:00Z", 1.102, 1.1022, 1.1012, 1.1014),
  );
  assertEquals(result.state, "ready");
  assertEquals(result.zone, plan.zone);
});

Deno.test("the CHoCH candle cannot satisfy its own retracement", () => {
  const plan: any = {
    contractVersion: "post-choch-retracement.v1",
    state: "awaiting_retracement", mode: "wait_retracement", direction: "long",
    candidateId: "zone-1", confirmationGeneration: 1,
    confirmation: { candleTime: "2026-08-06T10:10:00Z" },
    zone: { type: "fvg", low: 1.101, high: 1.102, midpoint: 1.1015 },
    protectedLevel: 1.0985, createdAt: "2026-08-06T10:10:00Z",
    expiresAt: "2026-08-06T11:00:00Z", touchedAt: null, resolvedAt: null,
    reason: "waiting",
  };
  const result = evaluatePostChochRetracement(
    plan,
    candle("2026-08-06T10:10:00Z", 1.099, 1.104, 1.1015, 1.1018),
  );
  assertEquals(result.state, "awaiting_retracement");
});

Deno.test("protected pivot failure invalidates before entry", () => {
  const base: any = {
    contractVersion: "post-choch-retracement.v1",
    state: "awaiting_retracement", mode: "wait_retracement", direction: "long",
    candidateId: "zone-1", confirmationGeneration: 1, confirmation: {},
    zone: { type: "fvg", low: 1.101, high: 1.102, midpoint: 1.1015 },
    protectedLevel: 1.0985, createdAt: "2026-08-06T10:00:00Z",
    expiresAt: "2026-08-06T11:00:00Z", touchedAt: null, resolvedAt: null,
    reason: "waiting",
  };
  const result = evaluatePostChochRetracement(
    base,
    candle("2026-08-06T10:20:00Z", 1.099, 1.0992, 1.0978, 1.098),
  );
  assertEquals(result.state, "invalidated");
});
