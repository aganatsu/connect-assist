import type { Candle } from "./smcAnalysis.ts";
import type {
  CanonicalDealingRange,
  DealingRangeEvaluation,
} from "./canonicalDealingRange.ts";
import type { CrossTimeframeEntryAuthorityDecision } from "./crossTimeframeEntryAuthority.ts";
import type { ICTEntryZoneSelection } from "./ictEntryZoneAuthority.ts";
import {
  buildImpulseEntryLifecycle,
  type BuildImpulseEntryLifecycleInput,
  type CandidateConfirmationContract,
  type ImpulseEntryLifecycle,
  type ImpulseEntryLifecycleMode,
  type ImpulseEntryMode,
} from "./impulseEntryLifecycle.ts";
import {
  advanceTradeLifecycle,
  TRADE_LIFECYCLE_AUTHORITY_VERSION,
  type TradeLifecycleStepResult,
} from "./tradeLifecycleAuthority.ts";
import {
  type ImpulseEntryLifecycleEvent,
  transitionImpulseEntryLifecycle,
} from "./impulseEntryLifecycle.ts";
import type { NestedPoiEntryPlan } from "./impulseZoneEngine.ts";
import { frozenTargetAlreadyReached } from "./pendingOrderPlan.ts";
import { closedCandleTouchesNestedPoiOuterZone } from "./pendingZoneTouch.ts";
import { normalizeAnalysisTimeframeOrNull } from "./timeframeAuthority.ts";
import {
  type AfterChochMode,
  derivePostChochEntryPlan,
  evaluatePostChochRetracement,
  type PostChochEntryPlan,
} from "./postChochRetracement.ts";

export const BACKTEST_TRADE_LIFECYCLE_VERSION = "backtest-trade-lifecycle.v1";

export type BacktestFrozenAnalysisSnapshot = Record<string, unknown>;
export type BacktestSignalSource = "cascade" | "unified" | "standalone";

function isBacktestSignalSource(value: unknown): value is BacktestSignalSource {
  return value === "cascade" || value === "unified" || value === "standalone";
}

export interface BacktestFrozenExecutionCandidate {
  signalSource: BacktestSignalSource;
  direction: "long" | "short";
  stopLoss: number;
  takeProfit: number;
  frozenAt: string;
}

export interface BacktestTradeLifecycleTerminalResolution {
  status: "cancelled" | "invalidated" | "expired";
  at: string;
  reason: string;
}

export interface BacktestTradeLifecycleState {
  contractVersion: typeof BACKTEST_TRADE_LIFECYCLE_VERSION;
  lifecycle: ImpulseEntryLifecycle | null;
  terminalImpulseIds: string[];
  lastStep: TradeLifecycleStepResult | null;
  postConfirmationEntry: PostChochEntryPlan | null;
  frozenExecution: BacktestFrozenExecutionCandidate | null;
  frozenNestedPoiEntry: NestedPoiEntryPlan | null;
  nestedOuterTouchedAt: string | null;
  nestedTriggerTimeframe: string | null;
  frozenAnalysis: BacktestFrozenAnalysisSnapshot | null;
  frozenCanonicalLocation: DealingRangeEvaluation | null;
  frozenCrossTimeframeDecision: CrossTimeframeEntryAuthorityDecision | null;
  terminalResolution?: BacktestTradeLifecycleTerminalResolution | null;
}

export function emptyBacktestTradeLifecycleState(): BacktestTradeLifecycleState {
  return {
    contractVersion: BACKTEST_TRADE_LIFECYCLE_VERSION,
    lifecycle: null,
    terminalImpulseIds: [],
    lastStep: null,
    postConfirmationEntry: null,
    frozenExecution: null,
    frozenNestedPoiEntry: null,
    nestedOuterTouchedAt: null,
    nestedTriggerTimeframe: null,
    frozenAnalysis: null,
    frozenCanonicalLocation: null,
    frozenCrossTimeframeDecision: null,
    terminalResolution: null,
  };
}

export function discoverBacktestTradeLifecycle(input: {
  state: BacktestTradeLifecycleState;
  range: CanonicalDealingRange;
  authority: ICTEntryZoneSelection;
  executableZone: BuildImpulseEntryLifecycleInput["candidates"][number];
  mode: ImpulseEntryLifecycleMode;
  now: string;
  expiresAt: string;
  confirmationMethod: CandidateConfirmationContract["method"];
  confirmationTimeframe: string;
  refinementTimeframe: string;
  entryMode?: ImpulseEntryMode;
  executionCandidate: BacktestFrozenExecutionCandidate;
  nestedPoiEntryPlan?: NestedPoiEntryPlan | null;
  nestedPoiMonitoringTimeframe?: string | null;
  analysisSnapshot?: BacktestFrozenAnalysisSnapshot | null;
  canonicalLocation?: DealingRangeEvaluation | null;
  crossTimeframeDecision?: CrossTimeframeEntryAuthorityDecision | null;
}): BacktestTradeLifecycleState {
  const currentLifecycleResolved = input.state.lifecycle &&
    (input.state.terminalResolution != null ||
      input.state.terminalImpulseIds.includes(
        input.state.lifecycle.impulse.id,
      ));
  if (
    !currentLifecycleResolved &&
    (input.state.lifecycle?.status === "active" ||
      input.state.lifecycle?.status === "entered")
  ) return input.state;
  if (input.state.terminalImpulseIds.includes(input.range.impulseId)) {
    return input.state;
  }
  const executionCandidate = input.executionCandidate;
  const expectedDirection = input.range.direction === "bullish"
    ? "long"
    : "short";
  if (
    !isBacktestSignalSource(executionCandidate.signalSource) ||
    executionCandidate.direction !== expectedDirection ||
    !Number.isFinite(executionCandidate.stopLoss) ||
    !Number.isFinite(executionCandidate.takeProfit) ||
    executionCandidate.frozenAt.trim().length === 0
  ) return input.state;

  const authorityCandidates = input.authority.ranked
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
      impulseId: input.range.impulseId,
    }));
  const executableCandidate = input.executableZone.id.length > 0 &&
      (input.executableZone.high > input.executableZone.low ||
        (input.executableZone.triggerKind === "level" &&
          input.executableZone.high === input.executableZone.low)) &&
      input.executableZone.low >= input.range.low &&
      input.executableZone.high <= input.range.high
    ? { ...input.executableZone, impulseId: input.range.impulseId }
    : null;
  if (!executableCandidate) return input.state;
  const nestedPoiEntryPlan = input.entryMode === "nested_poi_market"
    ? input.nestedPoiEntryPlan ?? null
    : null;
  const nestedPoiMonitoringTimeframe = normalizeAnalysisTimeframeOrNull(
    input.nestedPoiMonitoringTimeframe,
  );
  const frozenAnalysis = input.analysisSnapshot &&
      typeof input.analysisSnapshot === "object"
    ? input.analysisSnapshot
    : null;
  if (input.entryMode === "nested_poi_market") {
    const selected = nestedPoiEntryPlan?.selected;
    if (
      !nestedPoiMonitoringTimeframe || !frozenAnalysis ||
      !input.canonicalLocation || !input.crossTimeframeDecision || !selected ||
      selected.id !== executableCandidate.id ||
      selected.type !== executableCandidate.type ||
      selected.low !== executableCandidate.low ||
      selected.high !== executableCandidate.high ||
      selected.geometry !== executableCandidate.triggerKind
    ) return input.state;
  }
  const candidates = [
    executableCandidate,
    ...authorityCandidates.filter((candidate) =>
      candidate.id !== executableCandidate.id &&
      (candidate.low !== executableCandidate.low ||
        candidate.high !== executableCandidate.high)
    ),
  ];

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
      initialCandidateId: input.executableZone.id,
      confirmation: {
        method: input.confirmationMethod,
        timeframe: input.confirmationTimeframe,
        refinementTimeframe: input.refinementTimeframe,
        expiresAt: input.expiresAt,
      },
      entryMode: input.entryMode,
    }),
    lastStep: null,
    postConfirmationEntry: null,
    frozenExecution: { ...executionCandidate },
    frozenNestedPoiEntry: nestedPoiEntryPlan
      ? structuredClone(nestedPoiEntryPlan)
      : null,
    nestedOuterTouchedAt: null,
    nestedTriggerTimeframe: nestedPoiMonitoringTimeframe,
    frozenAnalysis: frozenAnalysis ? structuredClone(frozenAnalysis) : null,
    frozenCanonicalLocation: input.canonicalLocation
      ? structuredClone(input.canonicalLocation)
      : null,
    frozenCrossTimeframeDecision: input.crossTimeframeDecision
      ? structuredClone(input.crossTimeframeDecision)
      : null,
    terminalResolution: null,
  };
}

export function activeBacktestFrozenExecutionCandidate(
  state: BacktestTradeLifecycleState,
): BacktestFrozenExecutionCandidate | null {
  if (
    state.lifecycle?.mode !== "enforce" ||
    state.lifecycle.entryMode !== "nested_poi_market" ||
    state.terminalResolution != null ||
    state.terminalImpulseIds.includes(state.lifecycle.impulse.id) ||
    (state.lifecycle.status !== "active" &&
      state.lifecycle.status !== "entered")
  ) return null;
  return state.frozenExecution ? { ...state.frozenExecution } : null;
}

export function activeBacktestFrozenSignalSource(
  state: BacktestTradeLifecycleState,
): BacktestSignalSource | null {
  const frozen = activeBacktestFrozenExecutionCandidate(state);
  return frozen && isBacktestSignalSource(frozen.signalSource)
    ? frozen.signalSource
    : null;
}

export function activeBacktestFrozenNestedPoiEntryPlan(
  state: BacktestTradeLifecycleState,
): NestedPoiEntryPlan | null {
  if (
    state.lifecycle?.mode !== "enforce" ||
    state.lifecycle.entryMode !== "nested_poi_market" ||
    state.terminalResolution != null ||
    state.terminalImpulseIds.includes(state.lifecycle.impulse.id) ||
    (state.lifecycle.status !== "active" &&
      state.lifecycle.status !== "entered")
  ) return null;
  return state.frozenNestedPoiEntry
    ? structuredClone(state.frozenNestedPoiEntry)
    : null;
}

export function restoreBacktestFrozenTarget<
  T extends {
    direction: "long" | "short";
    takeProfit: number;
  },
>(state: BacktestTradeLifecycleState, candidate: T): T {
  const frozen = activeBacktestFrozenExecutionCandidate(state);
  return frozen
    ? {
      ...candidate,
      direction: frozen.direction,
      takeProfit: frozen.takeProfit,
    }
    : candidate;
}

export function activeBacktestFrozenAnalysisSnapshot(
  state: BacktestTradeLifecycleState,
): BacktestFrozenAnalysisSnapshot | null {
  if (
    state.lifecycle?.mode !== "enforce" ||
    state.lifecycle.entryMode !== "nested_poi_market" ||
    state.terminalResolution != null ||
    state.terminalImpulseIds.includes(state.lifecycle.impulse.id) ||
    (state.lifecycle.status !== "active" &&
      state.lifecycle.status !== "entered")
  ) return null;
  return state.frozenAnalysis ? structuredClone(state.frozenAnalysis) : null;
}

function terminalBacktestLifecycleStep(input: {
  lifecycle: ImpulseEntryLifecycle;
  event: ImpulseEntryLifecycleEvent;
}): TradeLifecycleStepResult {
  const before = structuredClone(input.lifecycle);
  const after = transitionImpulseEntryLifecycle(before, input.event);
  return {
    contractVersion: TRADE_LIFECYCLE_AUTHORITY_VERSION,
    before,
    after,
    events: after.revision === before.revision ? [] : [input.event],
    confirmationPlan: null,
    confirmationBuildDiagnostic: null,
    disposition: "terminal",
  };
}

function resolveBacktestTradeLifecycle(input: {
  state: BacktestTradeLifecycleState;
  at: string;
  reason: string;
  status: BacktestTradeLifecycleTerminalResolution["status"];
  event: ImpulseEntryLifecycleEvent;
}): BacktestTradeLifecycleState {
  const lifecycle = input.state.lifecycle;
  if (!lifecycle) return input.state;
  const step = terminalBacktestLifecycleStep({ lifecycle, event: input.event });
  const lifecycleChanged = step.after.revision !== lifecycle.revision;
  const terminalImpulseIds = input.state.terminalImpulseIds.includes(
      lifecycle.impulse.id,
    )
    ? input.state.terminalImpulseIds
    : [...input.state.terminalImpulseIds, lifecycle.impulse.id].slice(-100);
  return {
    ...input.state,
    lifecycle: step.after,
    terminalImpulseIds,
    lastStep: lifecycleChanged ? step : input.state.lastStep,
    terminalResolution: {
      status: input.status,
      at: input.at,
      reason: input.reason,
    },
  };
}

export function cancelBacktestTradeLifecycle(input: {
  state: BacktestTradeLifecycleState;
  at: string;
  reason: string;
}): BacktestTradeLifecycleState {
  const lifecycle = input.state.lifecycle;
  if (
    !lifecycle || lifecycle.mode !== "enforce" ||
    lifecycle.entryMode !== "nested_poi_market" ||
    (lifecycle.status !== "active" && lifecycle.status !== "entered") ||
    input.state.terminalResolution != null
  ) return input.state;
  return resolveBacktestTradeLifecycle({
    ...input,
    status: "cancelled",
    event: {
      type: "impulse_invalidated",
      at: input.at,
      reason: input.reason,
    },
  });
}

export function advanceBacktestTradeLifecycle(input: {
  state: BacktestTradeLifecycleState;
  candle: Candle;
  completedCandles: Candle[];
}): BacktestTradeLifecycleState {
  if (!input.state.lifecycle || input.state.terminalResolution != null) {
    return input.state;
  }
  const nestedLifecycle = input.state.lifecycle.entryMode ===
      "nested_poi_market"
    ? input.state.lifecycle
    : null;
  const nestedPlan = input.state.frozenNestedPoiEntry ?? null;
  let nestedOuterTouchedAt = input.state.nestedOuterTouchedAt ?? null;
  if (
    nestedLifecycle?.status === "active" ||
    nestedLifecycle?.status === "entered"
  ) {
    const candleTime = Date.parse(input.candle.datetime);
    if (
      Number.isFinite(candleTime) &&
      candleTime >= Date.parse(nestedLifecycle.impulse.expiresAt)
    ) {
      const event: ImpulseEntryLifecycleEvent = {
        type: "expired",
        at: input.candle.datetime,
      };
      return {
        ...resolveBacktestTradeLifecycle({
          state: input.state,
          at: input.candle.datetime,
          reason: "Impulse entry lifecycle expired",
          status: "expired",
          event,
        }),
        nestedOuterTouchedAt,
      };
    }
    if (
      !nestedPlan?.selected || !input.state.nestedTriggerTimeframe ||
      !isBacktestSignalSource(input.state.frozenExecution?.signalSource) ||
      !input.state.frozenAnalysis ||
      !input.state.frozenCanonicalLocation ||
      !input.state.frozenCrossTimeframeDecision
    ) {
      const event: ImpulseEntryLifecycleEvent = {
        type: "impulse_invalidated",
        at: input.candle.datetime,
        reason: "nested_poi_frozen_plan_unavailable",
      };
      return {
        ...resolveBacktestTradeLifecycle({
          state: input.state,
          at: input.candle.datetime,
          reason: event.reason,
          status: "invalidated",
          event,
        }),
        nestedOuterTouchedAt,
      };
    }
    if (
      !nestedOuterTouchedAt &&
      closedCandleTouchesNestedPoiOuterZone(
        input.candle,
        nestedPlan.outerZone,
      )
    ) {
      nestedOuterTouchedAt = input.candle.datetime;
    }
    const touchTime = Date.parse(nestedOuterTouchedAt || "");
    const frozenExecution = input.state.frozenExecution;
    const targetSidePrice = nestedLifecycle.impulse.direction === "long"
      ? input.candle.high
      : input.candle.low;
    if (
      Number.isFinite(touchTime) && Number.isFinite(candleTime) &&
      candleTime > touchTime && frozenExecution &&
      frozenTargetAlreadyReached(
        frozenExecution.direction,
        targetSidePrice,
        frozenExecution.takeProfit,
      )
    ) {
      const reason = "frozen_target_already_reached: price=" + targetSidePrice +
        " target=" + frozenExecution.takeProfit +
        " candle=" + input.candle.datetime;
      return {
        ...cancelBacktestTradeLifecycle({
          state: input.state,
          at: input.candle.datetime,
          reason,
        }),
        nestedOuterTouchedAt,
      };
    }
  }
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
    nestedOuterTouchedAt,
  };
}

export function prepareBacktestPostConfirmationEntry(input: {
  state: BacktestTradeLifecycleState;
  completedCandles: Candle[];
  mode: AfterChochMode;
  expiryMinutes: number;
}): BacktestTradeLifecycleState {
  if (
    input.mode === "confirmation_close" ||
    input.state.terminalResolution != null ||
    input.state.postConfirmationEntry ||
    input.state.lifecycle?.status !== "entered"
  ) return input.state;
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
      // ConfirmationSignal.price is the confirming candle close. The locked
      // structure level remains available on authority as trigger.breakLevel.
      price: input.completedCandles[candleIndex].close,
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
  if (
    state.terminalResolution != null ||
    state.lifecycle?.status !== "entered"
  ) return false;
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
    terminalImpulseIds:
      impulseId && !state.terminalImpulseIds.includes(impulseId)
        ? [...state.terminalImpulseIds, impulseId].slice(-100)
        : state.terminalImpulseIds,
    postConfirmationEntry: null,
    frozenExecution: null,
    frozenNestedPoiEntry: null,
    nestedOuterTouchedAt: null,
    nestedTriggerTimeframe: null,
    frozenAnalysis: null,
    frozenCanonicalLocation: null,
    frozenCrossTimeframeDecision: null,
    terminalResolution: null,
  };
}
