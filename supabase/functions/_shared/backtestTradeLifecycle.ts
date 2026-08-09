import type { Candle } from "./smcAnalysis.ts";
import type { CanonicalDealingRange } from "./canonicalDealingRange.ts";
import type { ICTEntryZoneSelection } from "./ictEntryZoneAuthority.ts";
import {
  buildImpulseEntryLifecycle,
  type CandidateConfirmationContract,
  type ImpulseEntryLifecycle,
  type ImpulseEntryLifecycleMode,
} from "./impulseEntryLifecycle.ts";
import {
  advanceTradeLifecycle,
  type TradeLifecycleStepResult,
} from "./tradeLifecycleAuthority.ts";
import {
  derivePostChochEntryPlan,
  evaluatePostChochRetracement,
  type AfterChochMode,
  type PostChochEntryPlan,
} from "./postChochRetracement.ts";

export const BACKTEST_TRADE_LIFECYCLE_VERSION =
  "backtest-trade-lifecycle.v1";

export interface BacktestTradeLifecycleState {
  contractVersion: typeof BACKTEST_TRADE_LIFECYCLE_VERSION;
  lifecycle: ImpulseEntryLifecycle | null;
  terminalImpulseIds: string[];
  lastStep: TradeLifecycleStepResult | null;
  postConfirmationEntry: PostChochEntryPlan | null;
}

export function emptyBacktestTradeLifecycleState(): BacktestTradeLifecycleState {
  return {
    contractVersion: BACKTEST_TRADE_LIFECYCLE_VERSION,
    lifecycle: null,
    terminalImpulseIds: [],
    lastStep: null,
    postConfirmationEntry: null,
  };
}

export function discoverBacktestTradeLifecycle(input: {
  state: BacktestTradeLifecycleState;
  range: CanonicalDealingRange;
  authority: ICTEntryZoneSelection;
  mode: ImpulseEntryLifecycleMode;
  now: string;
  expiresAt: string;
  confirmationMethod: CandidateConfirmationContract["method"];
  confirmationTimeframe: string;
  refinementTimeframe: string;
}): BacktestTradeLifecycleState {
  if (input.state.lifecycle?.status === "active" ||
    input.state.lifecycle?.status === "entered") return input.state;
  if (input.state.terminalImpulseIds.includes(input.range.impulseId)) {
    return input.state;
  }

  const candidates = input.authority.ranked
    .filter((candidate) =>
      candidate.eligible && candidate.impulseId.length > 0 &&
      candidate.direction === input.range.direction &&
      candidate.low >= input.range.low && candidate.high <= input.range.high
    )
    .map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      low: candidate.low,
      high: candidate.high,
      timeframe: candidate.timeframe,
      impulseId: candidate.impulseId,
    }));
  if (candidates.length === 0) return input.state;

  return {
    ...input.state,
    lifecycle: buildImpulseEntryLifecycle({
      mode: input.mode,
      now: input.now,
      impulse: {
        id: input.range.impulseId,
        direction: input.range.direction === "bullish" ? "long" : "short",
        timeframe: input.range.timeframe,
        rangeLow: input.range.low,
        rangeHigh: input.range.high,
        protectedLevel: input.range.direction === "bullish"
          ? input.range.low
          : input.range.high,
        expiresAt: input.expiresAt,
      },
      candidates,
      initialCandidateId: input.authority.selected?.id || null,
      confirmation: {
        method: input.confirmationMethod,
        timeframe: input.confirmationTimeframe,
        refinementTimeframe: input.refinementTimeframe,
        expiresAt: input.expiresAt,
      },
    }),
    lastStep: null,
    postConfirmationEntry: null,
  };
}

export function advanceBacktestTradeLifecycle(input: {
  state: BacktestTradeLifecycleState;
  candle: Candle;
  completedCandles: Candle[];
}): BacktestTradeLifecycleState {
  if (!input.state.lifecycle) return input.state;
  const postConfirmationEntry = input.state.postConfirmationEntry?.state ===
      "awaiting_retracement"
    ? evaluatePostChochRetracement(
      input.state.postConfirmationEntry,
      input.candle,
    )
    : input.state.postConfirmationEntry;
  const retracementTerminal = postConfirmationEntry?.state === "expired" ||
    postConfirmationEntry?.state === "invalidated";
  const lifecycle = retracementTerminal
    ? {
      ...input.state.lifecycle,
      status: postConfirmationEntry.state as "expired" | "invalidated",
      lastTransitionReason: postConfirmationEntry.reason,
    }
    : input.state.lifecycle;
  const step = advanceTradeLifecycle({
    lifecycle,
    candle: input.candle,
    completedCandles: input.completedCandles,
  });
  const terminal = step.disposition === "terminal";
  const terminalImpulseIds = terminal &&
      !input.state.terminalImpulseIds.includes(step.after.impulse.id)
    ? [...input.state.terminalImpulseIds, step.after.impulse.id].slice(-100)
    : input.state.terminalImpulseIds;
  return {
    ...input.state,
    lifecycle: step.after,
    terminalImpulseIds,
    lastStep: step,
    postConfirmationEntry,
  };
}

export function prepareBacktestPostConfirmationEntry(input: {
  state: BacktestTradeLifecycleState;
  completedCandles: Candle[];
  mode: AfterChochMode;
  expiryMinutes: number;
}): BacktestTradeLifecycleState {
  if (input.mode === "confirmation_close" ||
    input.state.postConfirmationEntry ||
    input.state.lifecycle?.status !== "entered") return input.state;
  const trigger = input.state.lastStep?.confirmationPlan;
  const confirmation = input.state.lifecycle.confirmation;
  if (!trigger || !confirmation?.confirmedAt) return input.state;
  const candleIndex = input.completedCandles.findIndex((candle) =>
    candle.datetime === trigger.evaluatedAt
  );
  if (candleIndex < 0) return input.state;
  const plan = derivePostChochEntryPlan({
    candles: input.completedCandles,
    direction: input.state.lifecycle.impulse.direction,
    signal: {
      type: "close_choch",
      tier: 1,
      price: trigger.breakLevel,
      candleIndex,
      displacement: trigger.displacementQualified ? 1 : 0,
      significance: "internal",
      closeBased: true,
      supportingSignals: ["frozen_trigger", "qualified_displacement"],
      authority: trigger,
    },
    protectedLevel: trigger.protectedLevel,
    candidateId: trigger.candidateId,
    confirmationGeneration: trigger.generation,
    mode: input.mode,
    createdAt: confirmation.confirmedAt,
    expiryMinutes: input.expiryMinutes,
  });
  return plan ? { ...input.state, postConfirmationEntry: plan } : input.state;
}

export function isBacktestTradeLifecycleEntryReady(
  state: BacktestTradeLifecycleState,
): boolean {
  if (state.lifecycle?.status !== "entered") return false;
  const plan = state.postConfirmationEntry;
  return !plan || plan.mode !== "wait_retracement" || plan.state === "ready";
}

export function consumeBacktestTradeLifecycleEntry(
  state: BacktestTradeLifecycleState,
): BacktestTradeLifecycleState {
  const impulseId = state.lifecycle?.impulse.id;
  return {
    ...state,
    lifecycle: null,
    terminalImpulseIds: impulseId && !state.terminalImpulseIds.includes(impulseId)
      ? [...state.terminalImpulseIds, impulseId].slice(-100)
      : state.terminalImpulseIds,
    postConfirmationEntry: null,
  };
}
