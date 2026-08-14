import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveConfirmationTriggerPlan } from "../../functions/_shared/impulseConfirmationLock.ts";
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

Deno.test("trigger revisions stop after lock and confirmation is immutable", () => {
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
  const ignored = transitionImpulseEntryLifecycle(locked, {
    type: "trigger_revised",
    at: "2026-08-06T11:15:00.000Z",
    protectedLevel: 98.7,
    breakLevel: 102.8,
    reason: "late structure",
  });
  assertEquals(ignored.revision, locked.revision);
  const confirmed = transitionImpulseEntryLifecycle(locked, {
    type: "confirmation_passed",
    at: "2026-08-06T11:20:00.000Z",
  });
  assertEquals(confirmed.confirmation?.confirmedAt, "2026-08-06T11:20:00.000Z");
  assertEquals(confirmed.status, "entered");
});
