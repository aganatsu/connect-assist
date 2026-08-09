import {
  candidateFailedByClose,
  impulseInvalidatedByClose,
  transitionImpulseEntryLifecycle,
  type ImpulseEntryLifecycle,
  type ImpulseEntryLifecycleEvent,
} from "./impulseEntryLifecycle.ts";

export interface ImpulseEntryLifecycleTransitionResult {
  before: ImpulseEntryLifecycle;
  after: ImpulseEntryLifecycle;
  event: ImpulseEntryLifecycleEvent | null;
  persisted: boolean;
}

function sameRevision(
  left: ImpulseEntryLifecycle,
  right: ImpulseEntryLifecycle,
): boolean {
  return left.revision === right.revision;
}

export async function loadImpulseEntryLifecycle(
  client: any,
  lifecycleId: string | null | undefined,
): Promise<ImpulseEntryLifecycle | null> {
  if (!lifecycleId) return null;
  const { data, error } = await client
    .from("impulse_entry_lifecycles")
    .select("lifecycle")
    .eq("id", lifecycleId)
    .maybeSingle();
  if (error) throw new Error(`Could not load impulse entry lifecycle: ${error.message}`);
  return data?.lifecycle || null;
}

export async function persistImpulseEntryLifecycleTransition(
  client: any,
  lifecycleId: string,
  before: ImpulseEntryLifecycle,
  event: ImpulseEntryLifecycleEvent,
): Promise<ImpulseEntryLifecycleTransitionResult> {
  const after = transitionImpulseEntryLifecycle(before, event);
  if (sameRevision(before, after)) {
    return { before, after, event: null, persisted: false };
  }
  const { error } = await client.rpc("advance_impulse_entry_lifecycle", {
    p_lifecycle_id: lifecycleId,
    p_expected_revision: before.revision,
    p_event_type: event.type,
    p_reason: after.lastTransitionReason,
    p_event_payload: event,
    p_next_lifecycle: after,
  });
  if (error) throw new Error(`Could not advance impulse entry lifecycle: ${error.message}`);
  return { before, after, event, persisted: true };
}

export async function observeImpulseEntryPrice(
  client: any,
  lifecycleId: string | null | undefined,
  close: number,
  at: string,
): Promise<ImpulseEntryLifecycleTransitionResult | null> {
  const lifecycle = await loadImpulseEntryLifecycle(client, lifecycleId);
  if (!lifecycle || lifecycle.mode === "off" || lifecycle.status !== "active") {
    return null;
  }
  let event: ImpulseEntryLifecycleEvent | null = null;
  if (impulseInvalidatedByClose(lifecycle, close)) {
    event = {
      type: "impulse_invalidated",
      at,
      reason: `${lifecycle.impulse.timeframe} impulse protected level ${lifecycle.impulse.protectedLevel} failed on close ${close}`,
    };
  } else if (candidateFailedByClose(lifecycle, close)) {
    const active = lifecycle.candidates.find((candidate) =>
      candidate.id === lifecycle.activeCandidateId
    );
    event = {
      type: "candidate_failed",
      at,
      reason: `${active?.timeframe || "Entry"} ${active?.type || "zone"} candidate ${active?.id || "unknown"} failed on close ${close}; impulse remains valid`,
    };
  } else {
    const active = lifecycle.candidates.find((candidate) =>
      candidate.id === lifecycle.activeCandidateId
    );
    if (active && close >= active.low && close <= active.high &&
      active.state === "active") {
      event = { type: "zone_touched", at };
    }
  }
  return event
    ? persistImpulseEntryLifecycleTransition(client, lifecycleId!, lifecycle, event)
    : { before: lifecycle, after: lifecycle, event: null, persisted: false };
}

import { deriveConfirmationTriggerPlan, type ConfirmationTriggerPlan } from "./impulseConfirmationLock.ts";
import type { Candle } from "./smcAnalysis.ts";

export interface ConfirmationLockObservation {
  plan: ConfirmationTriggerPlan | null;
  transitions: ImpulseEntryLifecycleTransitionResult[];
  lifecycle: ImpulseEntryLifecycle | null;
}

export async function observeImpulseConfirmationLock(
  client: any,
  lifecycleId: string | null | undefined,
  candles: Candle[],
): Promise<ConfirmationLockObservation> {
  let lifecycle = await loadImpulseEntryLifecycle(client, lifecycleId);
  const transitions: ImpulseEntryLifecycleTransitionResult[] = [];
  if (!lifecycle || lifecycle.mode === "off" || lifecycle.status !== "active") {
    return { plan: null, transitions, lifecycle };
  }
  let plan = deriveConfirmationTriggerPlan({ lifecycle, candles });
  if (!plan || !lifecycleId) return { plan, transitions, lifecycle };

  if (lifecycle.confirmation?.status === "building") {
    const revised = await persistImpulseEntryLifecycleTransition(
      client,
      lifecycleId,
      lifecycle,
      {
        type: "trigger_revised",
        at: plan.evaluatedAt,
        protectedLevel: plan.protectedLevel,
        breakLevel: plan.breakLevel,
        reason: plan.explanation,
      },
    );
    if (revised.persisted) {
      transitions.push(revised);
      lifecycle = revised.after;
      plan = deriveConfirmationTriggerPlan({ lifecycle, candles }) || plan;
    }
    if (plan.shouldLock && lifecycle.confirmation?.status === "building") {
      const locked = await persistImpulseEntryLifecycleTransition(
        client,
        lifecycleId,
        lifecycle,
        {
          type: "trigger_locked",
          at: plan.evaluatedAt,
          protectedLevel: plan.protectedLevel,
          breakLevel: plan.breakLevel,
        },
      );
      if (locked.persisted) {
        transitions.push(locked);
        lifecycle = locked.after;
      }
    }
  } else if (lifecycle.confirmation?.status === "trigger_locked" &&
    plan.confirmationPassed) {
    const confirmed = await persistImpulseEntryLifecycleTransition(
      client,
      lifecycleId,
      lifecycle,
      { type: "confirmation_passed", at: plan.evaluatedAt },
    );
    if (confirmed.persisted) {
      transitions.push(confirmed);
      lifecycle = confirmed.after;
    }
  }
  return { plan, transitions, lifecycle };
}

import { advanceTradeLifecycle, type TradeLifecycleStepResult } from "./tradeLifecycleAuthority.ts";

export interface StoredTradeLifecycleStep extends TradeLifecycleStepResult {
  transitions: ImpulseEntryLifecycleTransitionResult[];
}

/** Persist exactly the events produced by the shared candle-driven authority. */
export async function advanceStoredTradeLifecycle(
  client: any,
  lifecycleId: string | null | undefined,
  candle: Candle,
  completedCandles: Candle[],
): Promise<StoredTradeLifecycleStep | null> {
  let lifecycle = await loadImpulseEntryLifecycle(client, lifecycleId);
  if (!lifecycle || !lifecycleId || lifecycle.mode === "off") return null;
  const projected = advanceTradeLifecycle({ lifecycle, candle, completedCandles });
  const transitions: ImpulseEntryLifecycleTransitionResult[] = [];
  for (const event of projected.events) {
    const transition = await persistImpulseEntryLifecycleTransition(
      client, lifecycleId, lifecycle, event,
    );
    if (transition.persisted) {
      transitions.push(transition);
      lifecycle = transition.after;
    }
  }
  return { ...projected, after: lifecycle, transitions };
}
