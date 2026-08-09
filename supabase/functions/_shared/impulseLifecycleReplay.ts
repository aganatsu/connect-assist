import type { Candle } from "./smcAnalysis.ts";
import { advanceTradeLifecycle } from "./tradeLifecycleAuthority.ts";
import {
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
    const step = advanceTradeLifecycle({
      lifecycle,
      candle,
      completedCandles: input.candles.slice(0, index + 1),
    });
    for (const event of step.events) {
      transitions.push({
        event: event.type,
        at: event.at,
        fromCandidateId: lifecycle.activeCandidateId,
        toCandidateId: step.after.activeCandidateId,
        reason: step.after.lastTransitionReason,
      });
    }
    lifecycle = step.after;
    if (step.disposition === "entry_ready") {
      entryIndex = index;
      entryPrice = candle.close;
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
