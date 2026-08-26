import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  activeBacktestFrozenAnalysisSnapshot,
  activeBacktestFrozenExecutionCandidate,
  activeBacktestFrozenNestedPoiEntryPlan,
  activeBacktestFrozenSignalSource,
  advanceBacktestTradeLifecycle,
  cancelBacktestTradeLifecycle,
  discoverBacktestTradeLifecycle,
  emptyBacktestTradeLifecycleState,
  isBacktestTradeLifecycleEntryReady,
  prepareBacktestPostConfirmationEntry,
  restoreBacktestFrozenTarget,
} from "../functions/_shared/backtestTradeLifecycle.ts";

const range = {
  contractVersion: "canonical-dealing-range.v1" as const,
  authority: "canonical_impulse" as const,
  source: "higher_timeframe_parent" as const,
  impulseId: "impulse-1",
  timeframe: "1h",
  high: 110,
  low: 100,
  midpoint: 105,
  direction: "bullish" as const,
  frozenAt: "2026-08-08T10:00:00.000Z",
};
const authority = {
  contractVersion: "ict-entry-zone-authority.v1" as const,
  enforcement: "observe_only" as const,
  selected: null,
  explanation: "fixture",
  ranked: [{
    contractVersion: "ict-entry-zone-authority.v1" as const,
    enforcement: "observe_only" as const,
    id: "ob-1",
    type: "ob" as const,
    direction: "bullish" as const,
    low: 102,
    high: 104,
    timeframe: "1h",
    impulseId: "impulse-1",
    componentIds: ["ob-1"],
    components: ["ob" as const],
    eligible: true,
    score: 8,
    reasons: [],
    validationTrade: null,
  }],
};

const executableZone = {
  id: "ob-1",
  type: "ob" as const,
  low: 102,
  high: 104,
  timeframe: "1h",
  impulseId: "impulse-1",
};
const executionCandidate = {
  signalSource: "unified" as const,
  direction: "long" as const,
  stopLoss: 99,
  takeProfit: 112,
  frozenAt: range.frozenAt,
  directionVerdict: {
    verdict: "long" as const,
    confidence: 80,
    shouldBlock: false,
  },
};

const nestedTrigger = {
  id: "fib-618",
  type: "fib" as const,
  geometry: "level" as const,
  source: "impulse_fib" as const,
  direction: "bullish" as const,
  low: 102.5,
  high: 102.5,
  entryPrice: 102.5,
  timeframe: "1h",
  lifecycle: null,
  evidenceId: "fib-618:evidence",
  entityId: "fib-618",
  supportingEvidenceIds: ["fib-618:evidence"],
  supportingFamilies: ["fib" as const],
  independentEvidenceCount: 1,
  localScore: 1,
  lifecycleRank: 0,
  depth: 0.75,
  widthRatio: 0,
  rank: 1,
};
const nestedPoiEntryPlan = {
  contractVersion: "nested-poi-entry.v1" as const,
  enforcement: "observe_only" as const,
  outerCandidateId: "outer-ob",
  outerZone: { low: 100, high: 110, direction: "bullish" as const },
  selected: nestedTrigger,
  candidates: [nestedTrigger],
  reason: "selected" as const,
};
const nestedAnalysisSnapshot = {
  direction: "long",
  stopLoss: 99,
  takeProfit: 112,
  lastPrice: 105,
  score: 40,
  factors: [],
};
const nestedCanonicalLocation = {
  contractVersion: "canonical-dealing-range.v1",
  mode: "off",
  available: true,
  allowed: true,
  direction: "long",
  price: 102.5,
  percent: 25,
  zone: "discount",
  code: "mode_off",
  explanation: "fixture",
  range,
} as any;
const nestedCrossTimeframeDecision = {
  contractVersion: "cross-tf-entry-authority.v1",
  allowed: true,
} as any;

Deno.test("backtest nested POI lifecycle waits for the exact frozen point trigger", () => {
  let state = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: emptyBacktestTradeLifecycleState(),
    range,
    authority,
    executableZone: {
      id: "fib-618",
      type: "fib",
      low: 102.5,
      high: 102.5,
      triggerKind: "level",
      timeframe: "5m",
      impulseId: "impulse-1",
    },
    mode: "enforce",
    entryMode: "nested_poi_market",
    now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    nestedPoiEntryPlan,
    nestedPoiMonitoringTimeframe: "5m",
    analysisSnapshot: nestedAnalysisSnapshot,
    canonicalLocation: nestedCanonicalLocation,
    crossTimeframeDecision: nestedCrossTimeframeDecision,
    refinementTimeframe: "1m",
  });
  state = advanceBacktestTradeLifecycle({
    state,
    candle: {
      datetime: "2026-08-08T10:05:00.000Z",
      open: 102.9,
      high: 103,
      low: 102.6,
      close: 102.8,
    },
    completedCandles: [],
  });
  assertEquals(isBacktestTradeLifecycleEntryReady(state), false);
  assertEquals(state.nestedOuterTouchedAt, "2026-08-08T10:05:00.000Z");
  state = advanceBacktestTradeLifecycle({
    state,
    candle: {
      datetime: "2026-08-08T10:10:00.000Z",
      open: 102.6,
      high: 102.7,
      low: 102.4,
      close: 102.6,
    },
    completedCandles: [],
  });
  assertEquals(isBacktestTradeLifecycleEntryReady(state), true);
  assertEquals(state.lastStep?.events[0]?.type, "entry_trigger_touched");
});

Deno.test("backtest freezes the complete nested plan and runtime monitoring timeframe", () => {
  const mutablePlan = structuredClone(nestedPoiEntryPlan);
  const armed = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: emptyBacktestTradeLifecycleState(),
    range,
    authority,
    executableZone: {
      id: "fib-618",
      type: "fib",
      low: 102.5,
      high: 102.5,
      triggerKind: "level",
      timeframe: "1h",
      impulseId: "impulse-1",
    },
    mode: "enforce",
    entryMode: "nested_poi_market",
    nestedPoiEntryPlan: mutablePlan,
    nestedPoiMonitoringTimeframe: "5m",
    analysisSnapshot: nestedAnalysisSnapshot,
    canonicalLocation: nestedCanonicalLocation,
    crossTimeframeDecision: nestedCrossTimeframeDecision,
    now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });

  mutablePlan.selected!.entryPrice = 109;
  assertEquals(
    activeBacktestFrozenNestedPoiEntryPlan(armed),
    nestedPoiEntryPlan,
  );
  assertEquals(armed.nestedTriggerTimeframe, "5m");
  assertEquals(
    activeBacktestFrozenAnalysisSnapshot(armed),
    nestedAnalysisSnapshot,
  );
  assertEquals(activeBacktestFrozenSignalSource(armed), "unified");
  assertEquals(
    activeBacktestFrozenExecutionCandidate(armed)?.directionVerdict,
    executionCandidate.directionVerdict,
  );
  assertEquals(armed.frozenCanonicalLocation, nestedCanonicalLocation);
  assertEquals(
    armed.frozenCrossTimeframeDecision,
    nestedCrossTimeframeDecision,
  );
});

Deno.test("backtest cancels a nested setup when its frozen target is reached after outer touch", () => {
  let state = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: emptyBacktestTradeLifecycleState(),
    range,
    authority,
    executableZone: {
      id: "fib-618",
      type: "fib",
      low: 102.5,
      high: 102.5,
      triggerKind: "level",
      timeframe: "1h",
      impulseId: "impulse-1",
    },
    mode: "enforce",
    entryMode: "nested_poi_market",
    nestedPoiEntryPlan,
    nestedPoiMonitoringTimeframe: "5m",
    analysisSnapshot: nestedAnalysisSnapshot,
    canonicalLocation: nestedCanonicalLocation,
    crossTimeframeDecision: nestedCrossTimeframeDecision,
    now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  state = advanceBacktestTradeLifecycle({
    state,
    candle: {
      datetime: "2026-08-08T10:05:00.000Z",
      open: 108,
      high: 109,
      low: 108,
      close: 108.5,
    },
    completedCandles: [],
  });
  state = advanceBacktestTradeLifecycle({
    state,
    candle: {
      datetime: "2026-08-08T10:10:00.000Z",
      open: 111,
      high: 112.25,
      low: 108,
      close: 111.5,
    },
    completedCandles: [],
  });

  assertEquals(state.lifecycle?.status, "invalidated");
  assertEquals(isBacktestTradeLifecycleEntryReady(state), false);
  assertStringIncludes(
    state.lifecycle?.lastTransitionReason || "",
    "frozen_target_already_reached",
  );
  assertEquals(state.terminalImpulseIds, ["impulse-1"]);
});

Deno.test("backtest cancels an entered nested setup when final authorization retries and target is later reached", () => {
  let state = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: emptyBacktestTradeLifecycleState(),
    range,
    authority,
    executableZone: {
      id: "fib-618",
      type: "fib",
      low: 102.5,
      high: 102.5,
      triggerKind: "level",
      timeframe: "1h",
      impulseId: "impulse-1",
    },
    mode: "enforce",
    entryMode: "nested_poi_market",
    nestedPoiEntryPlan,
    nestedPoiMonitoringTimeframe: "5m",
    analysisSnapshot: nestedAnalysisSnapshot,
    canonicalLocation: nestedCanonicalLocation,
    crossTimeframeDecision: nestedCrossTimeframeDecision,
    now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  state = advanceBacktestTradeLifecycle({
    state,
    candle: {
      datetime: "2026-08-08T10:05:00.000Z",
      open: 103,
      high: 103.1,
      low: 102.4,
      close: 102.7,
    },
    completedCandles: [],
  });
  assertEquals(state.lifecycle?.status, "entered");
  assertEquals(isBacktestTradeLifecycleEntryReady(state), true);

  state = advanceBacktestTradeLifecycle({
    state,
    candle: {
      datetime: "2026-08-08T10:10:00.000Z",
      open: 111,
      high: 112.25,
      low: 110.5,
      close: 111.5,
    },
    completedCandles: [],
  });

  assertEquals(state.lifecycle?.status, "entered");
  assertEquals(isBacktestTradeLifecycleEntryReady(state), false);
  assertEquals(state.lastStep?.events[0]?.type, "entry_trigger_touched");
  assertEquals(state.terminalResolution?.status, "cancelled");
  assertStringIncludes(
    state.terminalResolution?.reason || "",
    "frozen_target_already_reached",
  );
});

Deno.test("terminal final authorization cancels an entered nested setup without rewriting lifecycle authority", () => {
  let state = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: emptyBacktestTradeLifecycleState(),
    range,
    authority,
    executableZone: {
      id: "fib-618",
      type: "fib",
      low: 102.5,
      high: 102.5,
      triggerKind: "level",
      timeframe: "5m",
      impulseId: "impulse-1",
    },
    mode: "enforce",
    entryMode: "nested_poi_market",
    nestedPoiEntryPlan,
    nestedPoiMonitoringTimeframe: "5m",
    analysisSnapshot: nestedAnalysisSnapshot,
    canonicalLocation: nestedCanonicalLocation,
    crossTimeframeDecision: nestedCrossTimeframeDecision,
    now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  state = advanceBacktestTradeLifecycle({
    state,
    candle: {
      datetime: "2026-08-08T10:05:00.000Z",
      open: 103,
      high: 103.1,
      low: 102.4,
      close: 102.7,
    },
    completedCandles: [],
  });
  const revision = state.lifecycle?.revision;

  state = cancelBacktestTradeLifecycle({
    state,
    at: "2026-08-08T10:05:00.000Z",
    reason: "[final-auth:RR_TOO_LOW] effective RR is below minimum",
  });

  assertEquals(state.lifecycle?.status, "entered");
  assertEquals(state.lifecycle?.revision, revision);
  assertEquals(state.lastStep?.events[0]?.type, "entry_trigger_touched");
  assertEquals(state.terminalResolution, {
    status: "cancelled",
    at: "2026-08-08T10:05:00.000Z",
    reason: "[final-auth:RR_TOO_LOW] effective RR is below minimum",
  });
  assertEquals(state.terminalImpulseIds, ["impulse-1"]);
  assertEquals(isBacktestTradeLifecycleEntryReady(state), false);
  assertEquals(activeBacktestFrozenExecutionCandidate(state), null);

  const nextRange = {
    ...range,
    impulseId: "impulse-2",
    frozenAt: "2026-08-08T10:10:00.000Z",
  };
  const next = discoverBacktestTradeLifecycle({
    executionCandidate: {
      ...executionCandidate,
      frozenAt: nextRange.frozenAt,
    },
    state,
    range: nextRange,
    authority,
    executableZone: {
      id: "fib-618",
      type: "fib",
      low: 102.5,
      high: 102.5,
      triggerKind: "level",
      timeframe: "5m",
      impulseId: "impulse-2",
    },
    mode: "enforce",
    entryMode: "nested_poi_market",
    nestedPoiEntryPlan,
    nestedPoiMonitoringTimeframe: "5m",
    analysisSnapshot: nestedAnalysisSnapshot,
    canonicalLocation: nestedCanonicalLocation,
    crossTimeframeDecision: nestedCrossTimeframeDecision,
    now: nextRange.frozenAt,
    expiresAt: "2026-08-08T13:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  assertEquals(next.lifecycle?.impulse.id, "impulse-2");
  assertEquals(next.terminalResolution, null);
});

Deno.test("backtest nested expiry wins over target cancellation on the same candle", () => {
  let state = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: emptyBacktestTradeLifecycleState(),
    range,
    authority,
    executableZone: {
      id: "fib-618",
      type: "fib",
      low: 102.5,
      high: 102.5,
      triggerKind: "level",
      timeframe: "1h",
      impulseId: "impulse-1",
    },
    mode: "enforce",
    entryMode: "nested_poi_market",
    nestedPoiEntryPlan,
    nestedPoiMonitoringTimeframe: "5m",
    analysisSnapshot: nestedAnalysisSnapshot,
    canonicalLocation: nestedCanonicalLocation,
    crossTimeframeDecision: nestedCrossTimeframeDecision,
    now: range.frozenAt,
    expiresAt: "2026-08-08T10:10:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  state = advanceBacktestTradeLifecycle({
    state,
    candle: {
      datetime: "2026-08-08T10:05:00.000Z",
      open: 108,
      high: 109,
      low: 108,
      close: 108.5,
    },
    completedCandles: [],
  });
  state = advanceBacktestTradeLifecycle({
    state,
    candle: {
      datetime: "2026-08-08T10:10:00.000Z",
      open: 111,
      high: 112.25,
      low: 108,
      close: 111.5,
    },
    completedCandles: [],
  });

  assertEquals(state.lifecycle?.status, "expired");
  assertEquals(state.lastStep?.events[0]?.type, "expired");
  assertEquals(
    state.lifecycle?.lastTransitionReason,
    "Impulse entry lifecycle expired",
  );
});

Deno.test("a later closed candle may touch the outer zone and nested trigger together", () => {
  let state = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: emptyBacktestTradeLifecycleState(),
    range,
    authority,
    executableZone: {
      id: "fib-618",
      type: "fib",
      low: 102.5,
      high: 102.5,
      triggerKind: "level",
      timeframe: "1h",
      impulseId: "impulse-1",
    },
    mode: "enforce",
    entryMode: "nested_poi_market",
    nestedPoiEntryPlan,
    nestedPoiMonitoringTimeframe: "5m",
    analysisSnapshot: nestedAnalysisSnapshot,
    canonicalLocation: nestedCanonicalLocation,
    crossTimeframeDecision: nestedCrossTimeframeDecision,
    now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  state = advanceBacktestTradeLifecycle({
    state,
    candle: {
      datetime: "2026-08-08T10:05:00.000Z",
      open: 108,
      high: 112.25,
      low: 102.4,
      close: 103,
    },
    completedCandles: [],
  });

  assertEquals(state.nestedOuterTouchedAt, "2026-08-08T10:05:00.000Z");
  assertEquals(isBacktestTradeLifecycleEntryReady(state), true);
  assertEquals(state.lastStep?.events[0]?.type, "entry_trigger_touched");
});

Deno.test("nested child impulse zone can enter the frozen parent range lifecycle", () => {
  const nestedAuthority = structuredClone(authority);
  nestedAuthority.ranked[0].impulseId = "child-impulse-15m";
  nestedAuthority.ranked[0].timeframe = "15m";
  const state = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: emptyBacktestTradeLifecycleState(),
    range,
    authority: nestedAuthority,
    executableZone: {
      ...executableZone,
      timeframe: "15m",
      impulseId: "child-impulse-15m",
    },
    mode: "enforce",
    now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  assertEquals(state.lifecycle?.impulse.id, range.impulseId);
  assertEquals(state.lifecycle?.activeCandidateId, "ob-1");
  assertEquals(state.lifecycle?.candidates[0].timeframe, "15m");
});

Deno.test("backtest lifecycle persists and does not resurrect a terminal impulse", () => {
  let state = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: emptyBacktestTradeLifecycleState(),
    range,
    authority,
    executableZone,
    mode: "enforce",
    now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  assertEquals(state.lifecycle?.activeCandidateId, "ob-1");
  state = advanceBacktestTradeLifecycle({
    state,
    candle: {
      datetime: "2026-08-08T10:15:00.000Z",
      open: 103,
      high: 104,
      low: 101,
      close: 101,
    },
    completedCandles: [],
  });
  assertEquals(state.lifecycle?.status, "exhausted");
  state = discoverBacktestTradeLifecycle({
    executionCandidate,
    state,
    range,
    authority,
    executableZone,
    mode: "enforce",
    now: "2026-08-08T10:30:00.000Z",
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  assertEquals(state.lifecycle?.status, "exhausted");
  assertEquals(state.terminalImpulseIds, ["impulse-1"]);
});

Deno.test("backtest post-confirmation plan uses the confirming close, not the break level", () => {
  const confirming = {
    datetime: "2026-08-08T10:10:00.000Z",
    open: 1.1000,
    high: 1.1040,
    low: 1.0995,
    close: 1.1035,
    volume: 100,
  };
  const state: any = {
    contractVersion: "backtest-trade-lifecycle.v1",
    terminalImpulseIds: [],
    postConfirmationEntry: null,
    lifecycle: {
      status: "entered",
      impulse: { direction: "long" },
      confirmation: { confirmedAt: confirming.datetime },
    },
    lastStep: {
      confirmationPlan: {
        evaluatedAt: confirming.datetime,
        breakLevel: 1.1010,
        protectedLevel: 1.0985,
        candidateId: "zone-1",
        generation: 1,
        displacementQualified: true,
      },
    },
  };
  const result = prepareBacktestPostConfirmationEntry({
    state,
    completedCandles: [
      {
        datetime: "2026-08-08T10:00:00.000Z",
        open: 1.1000,
        high: 1.1005,
        low: 1.0990,
        close: 1.0995,
        volume: 100,
      },
      {
        datetime: "2026-08-08T10:05:00.000Z",
        open: 1.0995,
        high: 1.1000,
        low: 1.0985,
        close: 1.0990,
        volume: 100,
      },
      confirming,
    ],
    mode: "wait_retracement",
    expiryMinutes: 30,
  });
  assertEquals(
    result.postConfirmationEntry?.confirmation.price,
    confirming.close,
  );
  assertEquals(
    (result.postConfirmationEntry?.confirmation.authority as any)?.breakLevel,
    1.1010,
  );
});

Deno.test("wait retracement remains blocked until its frozen plan is ready", () => {
  const state = emptyBacktestTradeLifecycleState();
  state.lifecycle = {
    contractVersion: "impulse-entry-lifecycle.v1",
    mode: "enforce",
    impulse: {
      id: "i",
      direction: "long",
      timeframe: "1h",
      rangeLow: 1,
      rangeHigh: 2,
      protectedLevel: 1,
      expiresAt: "2026-08-08T12:00:00.000Z",
    },
    status: "entered",
    activeCandidateId: null,
    candidates: [],
    confirmation: null,
    revision: 2,
    lastTransitionReason: "confirmed",
  };
  state.postConfirmationEntry = {
    contractVersion: "post-choch-retracement.v1",
    state: "awaiting_retracement",
    mode: "wait_retracement",
    direction: "long",
    candidateId: null,
    confirmationGeneration: null,
    confirmation: {
      type: "close_choch",
      tier: 1,
      price: 1.5,
      candleIndex: 1,
      candleTime: "2026-08-08T10:00:00.000Z",
      displacement: 1,
      significance: "internal",
      closeBased: true,
      supportingSignals: [],
      authority: null,
    },
    zone: { type: "displacement_50", low: 1.2, high: 1.3, midpoint: 1.25 },
    protectedLevel: 1,
    createdAt: "2026-08-08T10:00:00.000Z",
    expiresAt: "2026-08-08T11:00:00.000Z",
    touchedAt: null,
    resolvedAt: null,
    reason: "waiting",
  };
  assertEquals(isBacktestTradeLifecycleEntryReady(state), false);
  state.postConfirmationEntry.state = "ready";
  assertEquals(isBacktestTradeLifecycleEntryReady(state), true);
});

Deno.test("backtest lifecycle starts from executable geometry before deeper authority candidates", () => {
  const deeperAuthority: any = structuredClone(authority);
  deeperAuthority.selected = deeperAuthority.ranked[0];
  const state = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: emptyBacktestTradeLifecycleState(),
    range,
    authority: deeperAuthority,
    executableZone: {
      id: "executable-fvg",
      type: "fvg",
      low: 106,
      high: 108,
      timeframe: "1h",
      impulseId: "impulse-1",
    },
    mode: "enforce",
    now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });

  assertEquals(state.lifecycle?.activeCandidateId, "executable-fvg");
  assertEquals(
    state.lifecycle?.candidates.map((candidate) => candidate.id),
    ["executable-fvg", "ob-1"],
  );
});

Deno.test("backtest ignores an executable zone outside the canonical range", () => {
  const initial = emptyBacktestTradeLifecycleState();
  const state = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: initial,
    range,
    authority,
    executableZone: { ...executableZone, low: 99, high: 101 },
    mode: "enforce",
    now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  assertEquals(state, initial);
});

Deno.test("observe-only backtest lifecycle never binds frozen execution geometry", () => {
  const observed = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: emptyBacktestTradeLifecycleState(),
    range,
    authority,
    executableZone,
    mode: "observe",
    now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });

  assertEquals(activeBacktestFrozenExecutionCandidate(observed), null);
});

Deno.test("backtest lifecycle keeps frozen execution geometry when current analysis changes", () => {
  const armed = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: emptyBacktestTradeLifecycleState(),
    range,
    authority,
    executableZone: {
      id: "fib-618",
      type: "fib",
      low: 102.5,
      high: 102.5,
      triggerKind: "level",
      timeframe: "5m",
      impulseId: "impulse-1",
    },
    mode: "enforce",
    entryMode: "nested_poi_market",
    nestedPoiEntryPlan,
    nestedPoiMonitoringTimeframe: "5m",
    analysisSnapshot: nestedAnalysisSnapshot,
    canonicalLocation: nestedCanonicalLocation,
    crossTimeframeDecision: nestedCrossTimeframeDecision,
    now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  const rescanned = discoverBacktestTradeLifecycle({
    executionCandidate: {
      signalSource: "standalone",
      direction: "short",
      stopLoss: 115,
      takeProfit: 95,
      frozenAt: "2026-08-08T10:05:00.000Z",
    },
    state: armed,
    range,
    authority,
    executableZone,
    mode: "enforce",
    now: "2026-08-08T10:05:00.000Z",
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });

  assertEquals(rescanned.frozenExecution, executionCandidate);
  assertEquals(
    activeBacktestFrozenExecutionCandidate(rescanned),
    executionCandidate,
  );
});

Deno.test("fresh stop recalculation cannot replace the frozen lifecycle target", () => {
  const armed = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: emptyBacktestTradeLifecycleState(),
    range,
    authority,
    executableZone: {
      id: "fib-618",
      type: "fib",
      low: 102.5,
      high: 102.5,
      triggerKind: "level",
      timeframe: "5m",
      impulseId: "impulse-1",
    },
    mode: "enforce",
    entryMode: "nested_poi_market",
    nestedPoiEntryPlan,
    nestedPoiMonitoringTimeframe: "5m",
    analysisSnapshot: nestedAnalysisSnapshot,
    canonicalLocation: nestedCanonicalLocation,
    crossTimeframeDecision: nestedCrossTimeframeDecision,
    now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  const restored = restoreBacktestFrozenTarget(armed, {
    direction: "short" as const,
    stopLoss: 98,
    takeProfit: 106,
  });
  assertEquals(restored, { direction: "long", stopLoss: 98, takeProfit: 112 });
});

Deno.test("legacy confirmation lifecycle does not restore nested frozen execution", () => {
  const legacy = discoverBacktestTradeLifecycle({
    executionCandidate,
    state: emptyBacktestTradeLifecycleState(),
    range,
    authority,
    executableZone,
    mode: "enforce",
    entryMode: "confirmation",
    now: range.frozenAt,
    expiresAt: "2026-08-08T12:00:00.000Z",
    confirmationMethod: "choch",
    confirmationTimeframe: "5m",
    refinementTimeframe: "1m",
  });
  const current = {
    direction: "short" as const,
    stopLoss: 114,
    takeProfit: 96,
  };

  assertEquals(activeBacktestFrozenExecutionCandidate(legacy), null);
  assertEquals(activeBacktestFrozenSignalSource(legacy), null);
  assertEquals(restoreBacktestFrozenTarget(legacy, current), current);
});
