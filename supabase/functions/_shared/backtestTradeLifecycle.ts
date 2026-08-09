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

export const BACKTEST_TRADE_LIFECYCLE_VERSION =
  "backtest-trade-lifecycle.v1";

export interface BacktestTradeLifecycleState {
  contractVersion: typeof BACKTEST_TRADE_LIFECYCLE_VERSION;
  lifecycle: ImpulseEntryLifecycle | null;
  terminalImpulseIds: string[];
  lastStep: TradeLifecycleStepResult | null;
}

export function emptyBacktestTradeLifecycleState(): BacktestTradeLifecycleState {
  return {
    contractVersion: BACKTEST_TRADE_LIFECYCLE_VERSION,
    lifecycle: null,
    terminalImpulseIds: [],
    lastStep: null,
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
      candidate.eligible && candidate.impulseId === input.range.impulseId &&
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
  };
}

export function advanceBacktestTradeLifecycle(input: {
  state: BacktestTradeLifecycleState;
  candle: Candle;
  completedCandles: Candle[];
}): BacktestTradeLifecycleState {
  if (!input.state.lifecycle) return input.state;
  const step = advanceTradeLifecycle({
    lifecycle: input.state.lifecycle,
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
  };
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
  };
}
