import type { Candle } from "./smcAnalysis.ts";
import { deriveConfirmationTriggerPlan } from "./impulseConfirmationLock.ts";
import {
  candidateFailedByClose,
  impulseInvalidatedByClose,
  transitionImpulseEntryLifecycle,
  type ImpulseEntryLifecycle,
  type ImpulseEntryLifecycleEvent,
} from "./impulseEntryLifecycle.ts";

export const IMPULSE_LIFECYCLE_REPLAY_VERSION = "impulse-lifecycle-replay.v1";

export interface ImpulseLifecycleReplayResult {
  contractVersion: typeof IMPULSE_LIFECYCLE_REPLAY_VERSION;
  initialCandidateId: string | null;
  finalCandidateId: string | null;
  finalStatus: ImpulseEntryLifecycle["status"];
  transitions: Array<{
    event: ImpulseEntryLifecycleEvent["type"];
    at: string;
    fromCandidateId: string | null;
    toCandidateId: string | null;
    reason: string;
  }>;
  entered: boolean;
  rescuedDeeperEntry: boolean;
  retainedWinner: boolean;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  outcome: "won" | "lost" | "inconclusive" | "no_entry";
  mfe: number | null;
  mae: number | null;
}

function apply(
  lifecycle: ImpulseEntryLifecycle,
  event: ImpulseEntryLifecycleEvent,
  transitions: ImpulseLifecycleReplayResult["transitions"],
): ImpulseEntryLifecycle {
  const beforeCandidate = lifecycle.activeCandidateId;
  const next = transitionImpulseEntryLifecycle(lifecycle, event);
  if (next.revision !== lifecycle.revision) {
    transitions.push({
      event: event.type,
      at: event.at,
      fromCandidateId: beforeCandidate,
      toCandidateId: next.activeCandidateId,
      reason: next.lastTransitionReason,
    });
  }
  return next;
}

export function replayImpulseEntryLifecycle(input: {
  lifecycle: ImpulseEntryLifecycle;
  candles: Candle[];
  rewardRisk?: number;
}): ImpulseLifecycleReplayResult {
  let lifecycle = structuredClone(input.lifecycle);
  lifecycle.mode = "observe";
  const transitions: ImpulseLifecycleReplayResult["transitions"] = [];
  const initialCandidateId = lifecycle.activeCandidateId;
  let entryIndex: number | null = null;
  let entryPrice: number | null = null;

  for (let index = 0; index < input.candles.length; index++) {
    if (lifecycle.status !== "active") break;
    const candle = input.candles[index];
    const at = candle.datetime;
    if (Date.parse(at) > Date.parse(lifecycle.impulse.expiresAt)) {
      lifecycle = apply(lifecycle, { type: "expired", at }, transitions);
      break;
    }
    if (impulseInvalidatedByClose(lifecycle, candle.close)) {
      lifecycle = apply(lifecycle, {
        type: "impulse_invalidated", at,
        reason: `Replay close ${candle.close} failed protected impulse ${lifecycle.impulse.protectedLevel}`,
      }, transitions);
      break;
    }
    if (candidateFailedByClose(lifecycle, candle.close)) {
      lifecycle = apply(lifecycle, {
        type: "candidate_failed", at,
        reason: `Replay close ${candle.close} failed active entry zone`,
      }, transitions);
      continue;
    }
    const active = lifecycle.candidates.find((candidate) =>
      candidate.id === lifecycle.activeCandidateId
    );
    const overlaps = active && candle.high >= active.low && candle.low <= active.high;
    if (overlaps && active?.state === "active") {
      lifecycle = apply(lifecycle, { type: "zone_touched", at }, transitions);
    }
    const plan = deriveConfirmationTriggerPlan({
      lifecycle,
      candles: input.candles.slice(0, index + 1),
    });
    if (!plan) continue;
    if (lifecycle.confirmation?.status === "building") {
      lifecycle = apply(lifecycle, {
        type: "trigger_revised", at: plan.evaluatedAt,
        protectedLevel: plan.protectedLevel,
        breakLevel: plan.breakLevel,
        reason: plan.explanation,
      }, transitions);
      if (plan.shouldLock && lifecycle.confirmation?.status === "building") {
        lifecycle = apply(lifecycle, {
          type: "trigger_locked", at: plan.evaluatedAt,
          protectedLevel: plan.protectedLevel,
          breakLevel: plan.breakLevel,
        }, transitions);
      }
    } else if (plan.confirmationPassed) {
      lifecycle = apply(lifecycle, {
        type: "confirmation_passed", at: plan.evaluatedAt,
      }, transitions);
      if (lifecycle.status === "entered") {
        entryIndex = index;
        entryPrice = candle.close;
      }
    }
  }

  const stopPrice = entryPrice === null ? null
    : lifecycle.confirmation?.protectedLevel ?? lifecycle.impulse.protectedLevel;
  const risk = entryPrice !== null && stopPrice !== null
    ? Math.abs(entryPrice - stopPrice)
    : null;
  const rewardRisk = input.rewardRisk ?? 2;
  const targetPrice = entryPrice === null || risk === null ? null
    : lifecycle.impulse.direction === "long"
    ? entryPrice + risk * rewardRisk
    : entryPrice - risk * rewardRisk;
  let outcome: ImpulseLifecycleReplayResult["outcome"] = entryIndex === null
    ? "no_entry"
    : "inconclusive";
  let mfe: number | null = null;
  let mae: number | null = null;
  if (entryIndex !== null && entryPrice !== null && stopPrice !== null && targetPrice !== null) {
    mfe = 0;
    mae = 0;
    for (const candle of input.candles.slice(entryIndex + 1)) {
      const favorable = lifecycle.impulse.direction === "long"
        ? candle.high - entryPrice
        : entryPrice - candle.low;
      const adverse = lifecycle.impulse.direction === "long"
        ? entryPrice - candle.low
        : candle.high - entryPrice;
      mfe = Math.max(mfe, favorable);
      mae = Math.max(mae, adverse);
      const hitStop = lifecycle.impulse.direction === "long"
        ? candle.low <= stopPrice
        : candle.high >= stopPrice;
      const hitTarget = lifecycle.impulse.direction === "long"
        ? candle.high >= targetPrice
        : candle.low <= targetPrice;
      if (hitStop && hitTarget) break;
      if (hitStop) { outcome = "lost"; break; }
      if (hitTarget) { outcome = "won"; break; }
    }
  }
  return {
    contractVersion: IMPULSE_LIFECYCLE_REPLAY_VERSION,
    initialCandidateId,
    finalCandidateId: lifecycle.confirmation?.candidateId || lifecycle.activeCandidateId,
    finalStatus: lifecycle.status,
    transitions,
    entered: entryIndex !== null,
    rescuedDeeperEntry: entryIndex !== null &&
      lifecycle.confirmation?.generation !== undefined &&
      lifecycle.confirmation.generation > 1,
    retainedWinner: outcome === "won" &&
      (lifecycle.confirmation?.generation || 1) === 1,
    entryPrice,
    stopPrice,
    targetPrice,
    outcome,
    mfe,
    mae,
  };
}
