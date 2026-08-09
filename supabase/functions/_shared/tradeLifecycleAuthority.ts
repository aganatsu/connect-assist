import type { Candle } from "./smcAnalysis.ts";
import { deriveConfirmationTriggerPlan, type ConfirmationTriggerPlan } from "./impulseConfirmationLock.ts";
import {
  candidateFailedByClose,
  impulseInvalidatedByClose,
  transitionImpulseEntryLifecycle,
  type ImpulseEntryLifecycle,
  type ImpulseEntryLifecycleEvent,
} from "./impulseEntryLifecycle.ts";

export const TRADE_LIFECYCLE_AUTHORITY_VERSION = "trade-lifecycle-authority.v1";

export interface TradeLifecycleStepResult {
  contractVersion: typeof TRADE_LIFECYCLE_AUTHORITY_VERSION;
  before: ImpulseEntryLifecycle;
  after: ImpulseEntryLifecycle;
  events: ImpulseEntryLifecycleEvent[];
  confirmationPlan: ConfirmationTriggerPlan | null;
  disposition: "watch" | "entry_ready" | "terminal";
}

function apply(current: ImpulseEntryLifecycle, event: ImpulseEntryLifecycleEvent) {
  const next = transitionImpulseEntryLifecycle(current, event);
  return { next, changed: next.revision !== current.revision };
}

/** Advance one frozen setup using one completed candle and bounded history. */
export function advanceTradeLifecycle(input: {
  lifecycle: ImpulseEntryLifecycle;
  candle: Candle;
  completedCandles: Candle[];
}): TradeLifecycleStepResult {
  const before = structuredClone(input.lifecycle);
  let after = structuredClone(input.lifecycle);
  const events: ImpulseEntryLifecycleEvent[] = [];
  let confirmationPlan: ConfirmationTriggerPlan | null = null;
  const emit = (event: ImpulseEntryLifecycleEvent) => {
    const result = apply(after, event);
    if (result.changed) { after = result.next; events.push(event); }
  };
  const at = input.candle.datetime;
  if (after.status !== "active") return { contractVersion: TRADE_LIFECYCLE_AUTHORITY_VERSION, before, after, events, confirmationPlan, disposition: after.status === "entered" ? "entry_ready" : "terminal" };
  if (Date.parse(at) > Date.parse(after.impulse.expiresAt)) emit({ type: "expired", at });
  else if (impulseInvalidatedByClose(after, input.candle.close)) emit({ type: "impulse_invalidated", at, reason: `Close ${input.candle.close} failed protected impulse ${after.impulse.protectedLevel}` });
  else if (candidateFailedByClose(after, input.candle.close)) emit({ type: "candidate_failed", at, reason: `Close ${input.candle.close} failed active entry zone` });
  else {
    const active = after.candidates.find((candidate) => candidate.id === after.activeCandidateId);
    if (active && active.state === "active" && input.candle.high >= active.low && input.candle.low <= active.high) emit({ type: "zone_touched", at });
    confirmationPlan = deriveConfirmationTriggerPlan({ lifecycle: after, candles: input.completedCandles });
    if (confirmationPlan && after.confirmation?.status === "building") {
      emit({ type: "trigger_revised", at: confirmationPlan.evaluatedAt, protectedLevel: confirmationPlan.protectedLevel, breakLevel: confirmationPlan.breakLevel, reason: confirmationPlan.explanation });
      if (confirmationPlan.shouldLock && after.confirmation?.status === "building") emit({ type: "trigger_locked", at: confirmationPlan.evaluatedAt, protectedLevel: confirmationPlan.protectedLevel, breakLevel: confirmationPlan.breakLevel });
    } else if (confirmationPlan?.confirmationPassed && after.confirmation?.status === "trigger_locked") {
      emit({ type: "confirmation_passed", at: confirmationPlan.evaluatedAt });
    }
  }
  const disposition = after.status === "entered" ? "entry_ready" : after.status === "active" ? "watch" : "terminal";
  return { contractVersion: TRADE_LIFECYCLE_AUTHORITY_VERSION, before, after, events, confirmationPlan, disposition };
}
