import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type ConfirmationBuildDiagnosticSink,
  deriveConfirmationTriggerPlan,
} from "../../functions/_shared/impulseConfirmationLock.ts";
import { advanceTradeLifecycle } from "../../functions/_shared/tradeLifecycleAuthority.ts";
import {
  buildImpulseEntryLifecycle,
  transitionImpulseEntryLifecycle,
} from "../../functions/_shared/impulseEntryLifecycle.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

function lifecycle() {
  const built = buildImpulseEntryLifecycle({
    now: "2026-08-06T10:00:00.000Z",
    impulse: {
      id: "imp-1",
      direction: "long",
      timeframe: "4H",
      rangeLow: 90,
      rangeHigh: 110,
      protectedLevel: 89,
      expiresAt: "2026-08-06T14:00:00.000Z",
    },
    candidates: [{
      id: "zone-1",
      type: "ob",
      low: 99,
      high: 101,
      timeframe: "1H",
      impulseId: "imp-1",
    }],
    confirmation: {
      method: "choch",
      timeframe: "5m",
      refinementTimeframe: "1m",
      expiresAt: "2026-08-06T14:00:00.000Z",
    },
  });
  const touched = transitionImpulseEntryLifecycle(built, {
    type: "zone_touched",
    at: "2026-08-06T10:40:00.000Z",
  });
  assertEquals(touched.confirmation?.startedAt, "2026-08-06T10:40:00.000Z");
  return touched;
}

const prices = [
  [100, 100.4, 99.8, 100.2],
  [100.2, 100.5, 100, 100.3],
  [100.3, 100.6, 100.1, 100.4],
  [100.4, 100.7, 100.2, 100.5],
  [100.5, 100.8, 100.3, 100.6],
  [100.6, 100.9, 100.4, 100.7],
  [100.7, 101, 100.5, 100.8],
  [100.8, 101.1, 100.6, 100.9],
  [100.9, 101, 99.4, 99.8],
  [99.8, 100.2, 98.8, 99.6],
  [99.6, 100, 99.2, 99.8],
  [99.8, 100.5, 99.5, 100.3],
  [100.3, 101.5, 100.1, 101.1],
  [101.1, 102.4, 100.9, 102],
  [102, 102.2, 100.5, 101.5],
  [101.5, 104, 101.4, 103.8],
  [103.8, 103.2, 102.8, 103],
  [103, 103.1, 102.6, 102.9],
  [102.9, 103.4, 102.7, 103.2],
];
const candles: Candle[] = prices.map((p, index) => ({
  datetime: new Date(Date.parse("2026-08-06T10:00:00.000Z") + index * 300_000)
    .toISOString(),
  open: p[0],
  high: p[1],
  low: p[2],
  close: p[3],
  volume: 100,
}));

Deno.test("derives a candidate-specific protected pivot and break level", () => {
  const plan = deriveConfirmationTriggerPlan({
    lifecycle: lifecycle(),
    candles,
  });
  assert(plan);
  assertEquals(plan.candidateId, "zone-1");
  assert(plan.protectedLevel < plan.breakLevel);
  assertEquals(plan.displacementQualified, false);
  assert(plan.shouldLock);
});

Deno.test("freezes the meaningful swing before the post-touch sweep low", () => {
  const plan = deriveConfirmationTriggerPlan({
    lifecycle: lifecycle(),
    candles,
  });
  assert(plan);
  assert(plan.breakPivotIndex < plan.protectedPivotIndex);
  assertEquals(plan.shouldLock, true);
  assert(plan.explanation.includes("Structure frozen"));
});

Deno.test("requires a later displaced close through the frozen break", () => {
  const initial = deriveConfirmationTriggerPlan({
    lifecycle: lifecycle(),
    candles,
  });
  assert(initial);
  const locked = transitionImpulseEntryLifecycle(lifecycle(), {
    type: "trigger_locked",
    at: initial.evaluatedAt,
    protectedLevel: initial.protectedLevel,
    breakLevel: initial.breakLevel,
  });
  const lastTime = Date.parse(candles.at(-1)!.datetime);
  const confirming: Candle = {
    datetime: new Date(lastTime + 300_000).toISOString(),
    open: initial.breakLevel - 0.2,
    high: initial.breakLevel + 1,
    low: initial.breakLevel - 0.3,
    close: initial.breakLevel + 0.8,
    volume: 100,
  };
  const forming: Candle = {
    ...confirming,
    datetime: new Date(lastTime + 600_000).toISOString(),
  };
  const confirmed = deriveConfirmationTriggerPlan({
    lifecycle: locked,
    candles: [...candles, confirming, forming],
    config: {
      pivotLookback: 2,
      minDisplacementBodyRatio: 0.55,
      minDisplacementATR: 0,
    },
  });
  assert(confirmed);
  assertEquals(confirmed.breakLevel, initial.breakLevel);
  assertEquals(confirmed.confirmationPassed, true);
});

Deno.test("locked trigger rebuilds before confirmation and is immutable after entry", () => {
  const building = lifecycle();
  const revised = transitionImpulseEntryLifecycle(building, {
    type: "trigger_revised",
    at: "2026-08-06T11:00:00.000Z",
    protectedLevel: 98.8,
    breakLevel: 102.4,
    reason: "qualified pivots",
  });
  assertEquals(revised.confirmation?.revisions.length, 1);
  const duplicate = transitionImpulseEntryLifecycle(revised, {
    type: "trigger_revised",
    at: "2026-08-06T11:05:00.000Z",
    protectedLevel: 98.8,
    breakLevel: 102.4,
    reason: "same pivots",
  });
  assertEquals(duplicate.revision, revised.revision);
  const locked = transitionImpulseEntryLifecycle(revised, {
    type: "trigger_locked",
    at: "2026-08-06T11:10:00.000Z",
    protectedLevel: 98.8,
    breakLevel: 102.4,
  });
  const rebuilt = transitionImpulseEntryLifecycle(locked, {
    type: "trigger_revised",
    at: "2026-08-06T11:15:00.000Z",
    protectedLevel: 98.7,
    breakLevel: 102.8,
    reason: "deeper post-touch structure",
  });
  assertEquals(rebuilt.confirmation?.status, "trigger_locked");
  assertEquals(rebuilt.confirmation?.protectedLevel, 98.7);
  assertEquals(rebuilt.confirmation?.breakLevel, 102.8);
  assertEquals(rebuilt.confirmation?.lockedAt, "2026-08-06T11:15:00.000Z");
  assertEquals(rebuilt.confirmation?.revisions.length, 2);
  const confirmed = transitionImpulseEntryLifecycle(rebuilt, {
    type: "confirmation_passed",
    at: "2026-08-06T11:20:00.000Z",
  });
  const immutable = transitionImpulseEntryLifecycle(confirmed, {
    type: "trigger_revised",
    at: "2026-08-06T11:25:00.000Z",
    protectedLevel: 98.6,
    breakLevel: 102.9,
    reason: "too late",
  });
  assertEquals(immutable.revision, confirmed.revision);
  assertEquals(confirmed.confirmation?.confirmedAt, "2026-08-06T11:20:00.000Z");
  assertEquals(confirmed.status, "entered");
});

Deno.test("a deeper post-touch retracement rebuilds the locked internal trigger", () => {
  const building = lifecycle();
  const initialCandles: Candle[] = [
    ...candles.slice(0, 12),
    {
      datetime: "2026-08-06T11:00:00.000Z",
      open: 99.8,
      high: 100.1,
      low: 99.7,
      close: 99.9,
      volume: 100,
    },
  ];
  const firstPass = deriveConfirmationTriggerPlan({
    lifecycle: building,
    candles: initialCandles,
    config: {
      pivotLookback: 2,
      minDisplacementBodyRatio: 0.55,
      minDisplacementATR: 0,
    },
  });
  assert(firstPass);
  const locked = transitionImpulseEntryLifecycle(building, {
    type: "trigger_locked",
    at: firstPass.evaluatedAt,
    protectedLevel: firstPass.protectedLevel,
    breakLevel: firstPass.breakLevel,
  });

  const deeperRetracement: Candle[] = [
    {
      datetime: "2026-08-06T11:35:00.000Z",
      open: 99.8,
      high: 100.7,
      low: 99.5,
      close: 100.4,
      volume: 100,
    },
    {
      datetime: "2026-08-06T11:40:00.000Z",
      open: 100.4,
      high: 100.9,
      low: 100.2,
      close: 100.6,
      volume: 100,
    },
    {
      datetime: "2026-08-06T11:45:00.000Z",
      open: 100.6,
      high: 100.7,
      low: 99.4,
      close: 99.7,
      volume: 100,
    },
    {
      datetime: "2026-08-06T11:50:00.000Z",
      open: 99.7,
      high: 99.9,
      low: 98.4,
      close: 98.8,
      volume: 100,
    },
    {
      datetime: "2026-08-06T11:55:00.000Z",
      open: 98.8,
      high: 99.5,
      low: 98.7,
      close: 99.2,
      volume: 100,
    },
    {
      datetime: "2026-08-06T12:00:00.000Z",
      open: 99.2,
      high: 100.1,
      low: 99,
      close: 99.8,
      volume: 100,
    },
  ];
  const revised = deriveConfirmationTriggerPlan({
    lifecycle: locked,
    candles: [...initialCandles, ...deeperRetracement],
    config: {
      pivotLookback: 2,
      minDisplacementBodyRatio: 0.55,
      minDisplacementATR: 0,
    },
  });
  assert(revised);
  assertEquals(revised.requiresRevision, true);
  assert(revised.protectedLevel < firstPass.protectedLevel);
  assert(revised.breakLevel < firstPass.breakLevel);
  assertEquals(revised.confirmationPassed, false);

  const rebuilt = advanceTradeLifecycle({
    lifecycle: locked,
    candle: deeperRetracement.at(-1)!,
    completedCandles: [...initialCandles, ...deeperRetracement],
  });
  assertEquals(rebuilt.events.map((event) => event.type), ["trigger_revised"]);
  assertEquals(
    rebuilt.after.confirmation?.protectedLevel,
    revised.protectedLevel,
  );
  assertEquals(rebuilt.after.confirmation?.breakLevel, revised.breakLevel);
  assertEquals(rebuilt.after.confirmation?.lockedAt, revised.evaluatedAt);
  assertEquals(rebuilt.disposition, "watch");

  const confirming: Candle = {
    datetime: "2026-08-06T12:05:00.000Z",
    open: revised.breakLevel - 0.5,
    high: revised.breakLevel + 1,
    low: revised.breakLevel - 1,
    close: revised.breakLevel + 0.9,
    volume: 100,
  };
  const entered = advanceTradeLifecycle({
    lifecycle: rebuilt.after,
    candle: confirming,
    completedCandles: [
      ...initialCandles,
      ...deeperRetracement,
      confirming,
    ],
  });
  assertEquals(entered.events.map((event) => event.type), [
    "confirmation_passed",
  ]);
  assertEquals(entered.disposition, "entry_ready");
});

Deno.test("reports why the post-touch trigger is still building", () => {
  const insufficientSink: ConfirmationBuildDiagnosticSink = { current: null };
  const insufficient = deriveConfirmationTriggerPlan({
    lifecycle: lifecycle(),
    candles: candles.slice(0, 11),
    diagnosticSink: insufficientSink,
  });
  assertEquals(insufficient, null);
  assertEquals(
    insufficientSink.current?.reasonCode,
    "insufficient_post_touch_bars",
  );
  assertEquals(insufficientSink.current?.barsAfterTouch, 3);
  assertEquals(insufficientSink.current?.requiredBars, 5);

  const monotonic = Array.from({ length: 14 }, (_, index): Candle => ({
    datetime: new Date(Date.parse("2026-08-06T10:00:00.000Z") + index * 300_000)
      .toISOString(),
    open: 100 + index,
    high: 100.4 + index,
    low: 99.8 + index,
    close: 100.2 + index,
    volume: 100,
  }));
  const protectedSink: ConfirmationBuildDiagnosticSink = { current: null };
  const withoutProtectedPivot = deriveConfirmationTriggerPlan({
    lifecycle: lifecycle(),
    candles: monotonic,
    config: {
      pivotLookback: 1,
      minDisplacementBodyRatio: 0.55,
      minDisplacementATR: 0,
    },
    diagnosticSink: protectedSink,
  });
  assertEquals(withoutProtectedPivot, null);
  assertEquals(protectedSink.current?.reasonCode, "protected_pivot_missing");

  const valley = Array.from({ length: 14 }, (_, index): Candle => {
    const price = index <= 10 ? 110 - index : 100 + (index - 10);
    return {
      datetime: new Date(
        Date.parse("2026-08-06T10:00:00.000Z") + index * 300_000,
      ).toISOString(),
      open: price + 0.1,
      high: price + 0.4,
      low: price - 0.4,
      close: price,
      volume: 100,
    };
  });
  const breakSink: ConfirmationBuildDiagnosticSink = { current: null };
  const withoutBreakPivot = deriveConfirmationTriggerPlan({
    lifecycle: lifecycle(),
    candles: valley,
    config: {
      pivotLookback: 1,
      minDisplacementBodyRatio: 0.55,
      minDisplacementATR: 0,
    },
    diagnosticSink: breakSink,
  });
  assertEquals(withoutBreakPivot, null);
  assertEquals(breakSink.current?.reasonCode, "break_pivot_missing");
  assertEquals(breakSink.current?.protectedPivotCount, 1);
  assertEquals(breakSink.current?.breakPivotCount, 0);
});
