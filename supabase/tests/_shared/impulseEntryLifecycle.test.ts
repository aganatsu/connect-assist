import { assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildImpulseEntryLifecycle,
  candidateFailedByClose,
  impulseInvalidatedByClose,
  transitionImpulseEntryLifecycle,
} from "../../functions/_shared/impulseEntryLifecycle.ts";
import { advanceTradeLifecycle } from "../../functions/_shared/tradeLifecycleAuthority.ts";

const input = {
  now: "2026-08-05T20:00:00.000Z",
  impulse: {
    id: "impulse-1",
    direction: "long" as const,
    timeframe: "4H",
    rangeLow: 1.1,
    rangeHigh: 1.2,
    protectedLevel: 1.095,
    expiresAt: "2026-08-06T20:00:00.000Z",
  },
  candidates: [
    {
      id: "deep-ob",
      type: "ob" as const,
      low: 1.11,
      high: 1.12,
      timeframe: "1H",
      impulseId: "impulse-1",
    },
    {
      id: "shallow-fvg",
      type: "fvg" as const,
      low: 1.16,
      high: 1.17,
      timeframe: "1H",
      impulseId: "impulse-1",
    },
    {
      id: "other-impulse",
      type: "ob" as const,
      low: 1.13,
      high: 1.14,
      timeframe: "1H",
      impulseId: "impulse-2",
    },
  ],
  confirmation: {
    method: "choch" as const,
    timeframe: "5m",
    refinementTimeframe: "1m",
    expiresAt: "2026-08-05T21:00:00.000Z",
  },
  initialCandidateId: "shallow-fvg",
};

Deno.test("orders candidates shallow to deep and rejects unrelated impulses", () => {
  const lifecycle = buildImpulseEntryLifecycle(input);
  if (lifecycle.candidates.length !== 2) {
    throw new Error("expected two candidates");
  }
  if (lifecycle.activeCandidateId !== "shallow-fvg") {
    throw new Error("shallow zone must activate first");
  }
  if (lifecycle.candidates[1].id !== "deep-ob") {
    throw new Error("deeper zone must queue second");
  }
});

Deno.test("rejects an explicit initial candidate that is not eligible", () => {
  assertThrows(
    () =>
      buildImpulseEntryLifecycle({
        ...input,
        initialCandidateId: "missing-zone",
      }),
    Error,
    "Initial impulse entry candidate missing-zone is not eligible",
  );
});

Deno.test("failed candidate advances deeper and starts a fresh confirmation", () => {
  const initial = buildImpulseEntryLifecycle(input);
  const touched = transitionImpulseEntryLifecycle(initial, {
    type: "zone_touched",
    at: "2026-08-05T20:05:00.000Z",
  });
  const advanced = transitionImpulseEntryLifecycle(touched, {
    type: "candidate_failed",
    at: "2026-08-05T20:10:00.000Z",
    reason: "5m close through FVG far boundary",
  });
  if (advanced.activeCandidateId !== "deep-ob") {
    throw new Error("expected deeper candidate");
  }
  if (
    advanced.confirmation?.candidateId !== "deep-ob" ||
    advanced.confirmation.generation !== 2
  ) {
    throw new Error("replacement requires a fresh confirmation contract");
  }
});

Deno.test("candidate failure and impulse invalidation use separate levels", () => {
  const lifecycle = buildImpulseEntryLifecycle(input);
  if (!candidateFailedByClose(lifecycle, 1.15)) {
    throw new Error("shallow FVG should fail");
  }
  if (impulseInvalidatedByClose(lifecycle, 1.15)) {
    throw new Error("impulse must remain valid");
  }
  if (!impulseInvalidatedByClose(lifecycle, 1.09)) {
    throw new Error("protected low should invalidate impulse");
  }
});

Deno.test("nested POI market entry becomes ready on the frozen trigger touch", () => {
  const lifecycle = buildImpulseEntryLifecycle({
    ...input,
    entryMode: "nested_poi_market",
    candidates: [{
      id: "fib-618",
      type: "fib",
      low: 1.1382,
      high: 1.1382,
      triggerKind: "level",
      timeframe: "1H",
      impulseId: "impulse-1",
    }],
    initialCandidateId: "fib-618",
  });
  const before = advanceTradeLifecycle({
    lifecycle,
    candle: {
      datetime: "2026-08-05T20:05:00.000Z",
      open: 1.14, high: 1.14, low: 1.139, close: 1.1395,
    },
    completedCandles: [],
  });
  if (before.disposition !== "watch") {
    throw new Error("outer-zone presence must not authorize before trigger touch");
  }
  const touched = advanceTradeLifecycle({
    lifecycle: before.after,
    candle: {
      datetime: "2026-08-05T20:10:00.000Z",
      open: 1.1395, high: 1.1398, low: 1.1380, close: 1.1388,
    },
    completedCandles: [],
  });
  if (touched.disposition !== "entry_ready") {
    throw new Error("frozen nested point touch must authorize lifecycle entry");
  }
  if (touched.events[0]?.type !== "entry_trigger_touched") {
    throw new Error("nested touch must have its own lifecycle event");
  }
});

Deno.test("nested POI lifecycle never retargets beyond its frozen selected trigger", () => {
  const lifecycle = buildImpulseEntryLifecycle({
    ...input,
    entryMode: "nested_poi_market",
    initialCandidateId: "shallow-fvg",
  });
  if (
    lifecycle.candidates.length !== 1 ||
    lifecycle.activeCandidateId !== "shallow-fvg"
  ) {
    throw new Error("nested mode must retain only the frozen selected trigger");
  }

  const failed = transitionImpulseEntryLifecycle(lifecycle, {
    type: "candidate_failed",
    at: "2026-08-05T20:10:00.000Z",
    reason: "frozen nested trigger failed",
  });
  if (failed.status !== "exhausted" || failed.activeCandidateId !== null) {
    throw new Error("nested mode must terminate instead of retargeting");
  }
});

Deno.test("confirmation must lock before it can authorize entry", () => {
  const initial = buildImpulseEntryLifecycle(input);
  const premature = transitionImpulseEntryLifecycle(initial, {
    type: "confirmation_passed",
    at: "2026-08-05T20:05:00.000Z",
  });
  if (premature.status !== "active") {
    throw new Error("unlocked confirmation must not enter");
  }
  const locked = transitionImpulseEntryLifecycle(initial, {
    type: "trigger_locked",
    at: "2026-08-05T20:05:00.000Z",
    protectedLevel: 1.155,
    breakLevel: 1.172,
  });
  const entered = transitionImpulseEntryLifecycle(locked, {
    type: "confirmation_passed",
    at: "2026-08-05T20:10:00.000Z",
  });
  if (entered.status !== "entered") {
    throw new Error("locked confirmation should enter");
  }
});
