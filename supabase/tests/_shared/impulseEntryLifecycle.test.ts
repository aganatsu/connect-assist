import {
  buildImpulseEntryLifecycle,
  candidateFailedByClose,
  impulseInvalidatedByClose,
  transitionImpulseEntryLifecycle,
} from "../../functions/_shared/impulseEntryLifecycle.ts";

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
    { id: "deep-ob", type: "ob" as const, low: 1.11, high: 1.12, timeframe: "1H", impulseId: "impulse-1" },
    { id: "shallow-fvg", type: "fvg" as const, low: 1.16, high: 1.17, timeframe: "1H", impulseId: "impulse-1" },
    { id: "other-impulse", type: "ob" as const, low: 1.13, high: 1.14, timeframe: "1H", impulseId: "impulse-2" },
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
  if (lifecycle.candidates.length !== 2) throw new Error("expected two candidates");
  if (lifecycle.activeCandidateId !== "shallow-fvg") throw new Error("shallow zone must activate first");
  if (lifecycle.candidates[1].id !== "deep-ob") throw new Error("deeper zone must queue second");
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
  if (advanced.activeCandidateId !== "deep-ob") throw new Error("expected deeper candidate");
  if (advanced.confirmation?.candidateId !== "deep-ob" || advanced.confirmation.generation !== 2) {
    throw new Error("replacement requires a fresh confirmation contract");
  }
});

Deno.test("candidate failure and impulse invalidation use separate levels", () => {
  const lifecycle = buildImpulseEntryLifecycle(input);
  if (!candidateFailedByClose(lifecycle, 1.15)) throw new Error("shallow FVG should fail");
  if (impulseInvalidatedByClose(lifecycle, 1.15)) throw new Error("impulse must remain valid");
  if (!impulseInvalidatedByClose(lifecycle, 1.09)) throw new Error("protected low should invalidate impulse");
});

Deno.test("confirmation must lock before it can authorize entry", () => {
  const initial = buildImpulseEntryLifecycle(input);
  const premature = transitionImpulseEntryLifecycle(initial, {
    type: "confirmation_passed",
    at: "2026-08-05T20:05:00.000Z",
  });
  if (premature.status !== "active") throw new Error("unlocked confirmation must not enter");
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
  if (entered.status !== "entered") throw new Error("locked confirmation should enter");
});
